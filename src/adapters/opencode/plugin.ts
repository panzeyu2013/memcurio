import type { Plugin } from "@opencode-ai/plugin";
import { Index } from "../../core/db.js";
import { indexDb, rootDir } from "../../core/paths.js";
import { MemcurioAdapter } from "../shared/engine.js";

const REPLACE_COMPACTION = process.env.MEMCURIO_REPLACE_COMPACTION === "1";

function properties(event: { properties?: unknown }): Record<string, unknown> {
  return (event.properties ?? {}) as Record<string, unknown>;
}

export function sessionIdFor(event: { type?: string; properties?: unknown }): string {
  const p = properties(event);
  switch (event.type) {
    case "session.created":
    case "session.updated":
    case "session.deleted": {
      const info = p.info as { id?: unknown } | undefined;
      return typeof info?.id === "string" ? info.id : "";
    }
    case "session.idle":
    case "session.compacted": {
      return typeof p.sessionID === "string" ? p.sessionID : "";
    }
    case "message.updated": {
      const info = p.info as { sessionID?: unknown } | undefined;
      return typeof info?.sessionID === "string" ? info.sessionID : "";
    }
    case "message.removed":
      return typeof p.sessionID === "string" ? p.sessionID : "";
    case "message.part.updated": {
      const part = p.part as { sessionID?: unknown } | undefined;
      return typeof part?.sessionID === "string" ? part.sessionID : "";
    }
    case "message.part.removed": {
      // The SDK EventMessagePartRemoved carries sessionID at the top level of
      // properties (no `part.sessionID`), unlike message.part.updated.
      return typeof p.sessionID === "string" ? p.sessionID : "";
    }
    default:
      return "";
  }
}

export function partIdFor(event: { type?: string; properties?: unknown }): string {
  const p = properties(event);
  const part = p.part as { id?: unknown } | undefined;
  if (typeof part?.id === "string") {
    return part.id;
  }
  return typeof p.partID === "string" ? p.partID : "";
}

interface SessionMessage {
  info: { id?: string; sessionID?: string; role?: string; summary?: boolean };
  parts: Array<{ id?: string; messageID?: string; type?: string; text?: string; synthetic?: boolean }>;
}

function textOf(m: SessionMessage): string | undefined {
  // Skip opencode's synthetic auto-continue boilerplate ("Continue if you
  // have next steps…") when assembling summaries.
  const text = m.parts
    .filter((p) => p.type === "text" && !p.synthetic && typeof p.text === "string" && p.text)
    .map((p) => String(p.text))
    .join("\n")
    .trim();
  return text ? text.slice(0, 2000) : undefined;
}

/** Extract the compaction summary. The *last* text part is opencode's
 *  auto-continue boilerplate ("Continue if you have next steps…"); the real
 *  summary is the assistant message flagged with info.summary. */
function summaryFromMessages(messages: SessionMessage[]): string | undefined {
  for (const m of [...messages].reverse()) {
    if (m.info?.summary) {
      const text = textOf(m);
      if (text) {
        return text;
      }
    }
  }
  const last = messages.at(-1);
  return last ? textOf(last) : undefined;
}

interface SessionClient {
  messages(options: { path: { id: string }; query?: { directory?: string; limit?: number } }): Promise<{ data?: SessionMessage[] }>;
}

// Only the tail of the transcript matters for summaries.
const MESSAGES_LIMIT = 50;

function messageKind(role: unknown): "user" | "assistant" | "event" {
  return role === "user" ? "user" : role === "assistant" ? "assistant" : "event";
}

function evidenceFromMessages(messages: SessionMessage[]): Array<{
  partId: string;
  messageId?: string;
  kind: "user" | "assistant" | "event";
  text?: string;
}> {
  const out: Array<{ partId: string; messageId?: string; kind: "user" | "assistant" | "event"; text?: string }> = [];
  messages.forEach((message, messageIndex) => {
    const messageId = message.info?.id;
    const kind = messageKind(message.info?.role);
    message.parts.forEach((part, partIndex) => {
      if (typeof part.text !== "string" || !part.text.trim()) {
        return;
      }
      const partId = part.id || `${messageId ?? `message-${messageIndex}`}:part-${partIndex}`;
      out.push({
        partId,
        messageId: part.messageID || messageId,
        kind,
        text: part.text,
      });
    });
  });
  return out;
}

/** Collect assistant text containing <memcurio-citation> blocks so the
 *  adapter can count the cited memory files as used (codex-style telemetry). */
function citationTextsFromMessages(messages: SessionMessage[]): string {
  const out: string[] = [];
  messages.forEach((message) => {
    if (messageKind(message.info?.role) !== "assistant") {
      return;
    }
    for (const part of message.parts) {
      if (part.type !== "text" || typeof part.text !== "string") {
        continue;
      }
      if (part.text.includes("<memcurio-citation>")) {
        out.push(part.text);
      }
    }
  });
  return out.join("\n");
}

async function fetchMessages(client: unknown, sessionId: string): Promise<SessionMessage[] | undefined> {
  const session = (client as { session?: SessionClient }).session;
  if (!session?.messages) {
    return undefined;
  }
  try {
    const result = await session.messages({
      path: { id: sessionId },
      query: { limit: MESSAGES_LIMIT },
    });
    return result.data ?? [];
  } catch {
    return undefined;
  }
}

export const MemcurioPlugin: Plugin = async ({ directory, client }) => {
  const root = rootDir();
  const recentCompactions = new Map<string, { summary: string; ts: number }>();
  // opencode may dispatch events for the same session concurrently; serialize
  // per session so DB writes (session.created vs message.part.*) never
  // interleave and drop counts.
  const queues = new Map<string, Promise<void>>();
  const runSerial = (id: string, work: () => Promise<void>): Promise<void> => {
    const prev = queues.get(id) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(work);
    queues.set(id, next.catch(() => {}));
    return next;
  };
  const adapter = new MemcurioAdapter({
    durableQueue: true,
    root,
    log: (level, message, extra) => {
      void client.app
        .log({ body: { service: "memcurio", level, message, extra } })
        .catch(() => {});
    },
  });
  const report = (err: unknown): void => {
    void client.app
      .log({ body: { service: "memcurio", level: "error", message: String(err) } })
      .catch(() => {});
  };
  // Close this host's session rows left open by a crashed/restarted harness
  // process (the durable worker drains the same queue at startup).
  try {
    const idx = await Index.create(indexDb(root));
    try {
      idx.closeAllSessions(new Date().toISOString(), "opencode");
    } finally {
      idx.close();
    }
  } catch {
    // non-fatal: another process may hold the DB during startup
  }
  // Resume jobs left by a previous plugin process. The call is deliberately
  // detached so plugin initialization never waits for a model/provider.
  void adapter.processPendingExtractions().catch(report);
  return {
    event: async ({ event }) => {
      const type = event.type;
      const id = sessionIdFor(event);
      if (!id) {
        return;
      }
      return runSerial(id, async () => {
        try {
          // OpenCode does not replay session.created when a plugin is loaded
          // into an already-running conversation. Reconstruct the local
          // envelope from any event carrying a session id so authoritative
          // idle/deleted message snapshots cannot be silently discarded.
          const info = properties(event).info as { directory?: unknown } | undefined;
          const workdir = typeof info?.directory === "string" ? info.directory : directory;
          if (!adapter.state(id)) {
            await adapter.sessionCreated(id, workdir, "opencode");
          }
          if (type === "session.created" || type === "session.updated") {
            // sessionCreated is idempotent and refreshes the workdir for an
            // envelope reconstructed from an earlier partial event.
            await adapter.sessionCreated(id, workdir, "opencode");
          } else if (type === "session.idle") {
            const messages = await fetchMessages(client, id);
            if (messages) {
              adapter.messageSnapshot(id, evidenceFromMessages(messages));
              void adapter.memoryUsageFromCitations(citationTextsFromMessages(messages)).catch(report);
            }
            await adapter.sessionIdle(id);
            void adapter.processPendingExtractions().catch(report);
            // Automatic Phase 2 also fires on idle (the normal pause point of
            // a kept session), not only on session.deleted.
            void adapter.maybeConsolidate().catch(report);
          } else if (type === "session.compacted") {
            const messages = await fetchMessages(client, id);
            if (messages) {
              adapter.messageSnapshot(id, evidenceFromMessages(messages));
              void adapter.memoryUsageFromCitations(citationTextsFromMessages(messages)).catch(report);
            }
            const summary = messages ? summaryFromMessages(messages) : undefined;
            const fingerprint = summary ?? "<no-summary>";
            const prior = recentCompactions.get(id);
            // Dedupe a double-fired event by identical summary within the
            // window. The failed-extraction sentinel also dedupes within the
            // window: a second <no-summary> in 30s is the same early event
            // re-fired (its summary would still fail to extract). A later,
            // distinct compaction (different window) still reaches the engine
            // — it explicitly supports multi-compact.
            if (
              prior &&
              prior.summary === fingerprint &&
              Date.now() - prior.ts < 30_000
            ) {
              return;
            }
            await adapter.sessionCompacted(id, summary);
            recentCompactions.set(id, { summary: fingerprint, ts: Date.now() });
          } else if (type === "session.deleted") {
            const messages = await fetchMessages(client, id);
            if (messages) {
              adapter.messageSnapshot(id, evidenceFromMessages(messages));
              void adapter.memoryUsageFromCitations(citationTextsFromMessages(messages)).catch(report);
            }
            await adapter.sessionEnded(id);
            void adapter.processPendingExtractions().catch(report);
            // Codex-style automatic Phase 2: consolidate what the finished
            // session produced instead of waiting for a manual curate.
            void adapter.maybeConsolidate().catch(report);
            recentCompactions.delete(id);
            queues.delete(id);
          } else if (type === "message.updated") {
            const info = properties(event).info as { id?: unknown; role?: unknown } | undefined;
            if (typeof info?.id === "string") {
              adapter.messageRoleKnown(id, info.id, messageKind(info.role));
            }
          } else if (type === "message.removed") {
            const messageId = properties(event).messageID;
            if (typeof messageId === "string") {
              adapter.messageRemovedByMessage(id, messageId);
            }
          } else if (type === "message.part.removed") {
            const partId = partIdFor(event);
            if (partId) {
              adapter.messageRemoved(id, partId);
            }
          } else if (type === "message.part.updated") {
            const partId = partIdFor(event);
            if (partId) {
              const part = properties(event).part as { text?: unknown; role?: unknown; messageID?: unknown } | undefined;
              const kind = part?.role === "user" || part?.role === "assistant" ? part.role : undefined;
              await adapter.messageSeen(id, partId, {
                kind,
                text: typeof part?.text === "string" ? part.text : undefined,
                messageId: typeof part?.messageID === "string" ? part.messageID : undefined,
              });
            }
          }
        } catch (err) {
          report(err);
        }
      });
    },
    "tool.execute.after": async (input) => {
      try {
        const id = String((input as { sessionID?: string }).sessionID ?? "");
        if (!id) {
          return;
        }
        if (!adapter.state(id)) {
          await adapter.sessionCreated(id, directory, "opencode");
        }
        const tool = String((input as { tool?: string }).tool ?? "");
        if (!tool) {
          return;
        }
        const args = (input as { args?: Record<string, unknown> }).args ?? {};
        const filePath =
          typeof args.filePath === "string"
            ? args.filePath
            : typeof (input as { filePath?: string }).filePath === "string"
              ? (input as { filePath?: string }).filePath
              : undefined;
        await adapter.toolExecuted(id, tool, { filePath });
        void adapter.processPendingExtractions().catch(report);
      } catch (err) {
        report(err);
      }
    },
    "experimental.session.compacting": async (input, output) => {
      try {
        const id = String((input as { sessionID?: string }).sessionID ?? "");
        const context = await adapter.buildCompactionContext(id, directory);
        if (context) {
          if (REPLACE_COMPACTION) {
            output.prompt = adapter.buildReplacePrompt(id, context);
          } else {
            output.context.push(context);
          }
        }
      } catch (err) {
        report(err);
      }
    },
  };
};

// Default export keeps the plugin loadable through the modern loader; the
// named export exists for legacy loaders that scan function exports.
export default MemcurioPlugin;
