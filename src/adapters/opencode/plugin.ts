import type { Plugin } from "@opencode-ai/plugin";

import { MemcurioAdapter } from "../shared/engine.js";
import type { ReflectChat } from "../../core/reflect.js";
import { parseReflectionResponse, reflectionUserPrompt } from "../../core/reflect.js";
import { Index } from "../../core/db.js";
import { indexDb, rootDir } from "../../core/paths.js";
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
  const part = properties(event).part as { id?: unknown } | undefined;
  return typeof part?.id === "string" ? part.id : "";
}

interface SessionMessage {
  info: { summary?: boolean };
  parts: Array<{ type?: string; text?: string; synthetic?: boolean }>;
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
  create(options: { query: { directory: string }; body: { title?: string } }): Promise<{ data: { id: string } }>;
  prompt(options: { path: { id: string }; body: { parts: Array<{ type: "text"; text: string }> } }): Promise<unknown>;
  messages(options: { path: { id: string } }): Promise<{ data?: SessionMessage[] }>;
  delete(options: { path: { id: string } }): Promise<unknown>;
}

function harnessReflect(client: { session: SessionClient }, directory: string, internalSessions: Set<string>): ReflectChat {
  return async ({ summary, strategy }) => {
    try {
      if (!summary) {
        return null;
      }
      const created = await client.session.create({ query: { directory }, body: { title: "memcurio-reflection" } });
      const id = created.data.id;
      internalSessions.add(id);
      try {
        await client.session.prompt({
          path: { id },
          body: { parts: [{ type: "text", text: reflectionUserPrompt(summary, strategy) }] },
        });
        const res = await client.session.messages({ path: { id } });
        const raw = summaryFromMessages(res.data ?? []);
        if (!raw) {
          return null;
        }
        return parseReflectionResponse(raw);
      } finally {
        void client.session.delete({ path: { id } }).catch(() => {}).finally(() => internalSessions.delete(id));
      }
    } catch (err) {
      console.error(`memcurio harness reflection failed: ${String(err)}`);
      return null;
    }
  };
}

export const MemcurioPlugin: Plugin = async ({ directory, client }) => {
  const internalSessions = new Set<string>();
  const recentCompactions = new Map<string, { summary: string; ts: number }>();
  const adapter = new MemcurioAdapter({
    log: (level, message, extra) => {
      void client.app
        .log({ body: { service: "memcurio", level, message, extra } })
        .catch(() => {});
    },
    reflect: harnessReflect(client as unknown as { session: SessionClient }, directory, internalSessions),
  });
  const report = (err: unknown): void => {
    void client.app
      .log({ body: { service: "memcurio", level: "error", message: String(err) } })
      .catch(() => {});
  };
  // Close this host's session rows left open by a crashed/restarted harness
  // process (codex's daemon does the same at startup).
  try {
    const idx = await Index.create(indexDb(rootDir()));
    try {
      idx.closeAllSessions(new Date().toISOString(), "opencode");
    } finally {
      idx.close();
    }
  } catch {
    // non-fatal: another process may hold the DB during startup
  }
  return {
    event: async ({ event }) => {
      const type = event.type;
      const id = sessionIdFor(event);
      if (!id) {
        return;
      }
      try {
        const info = properties(event).info as { title?: unknown } | undefined;
        // Prefix match: opencode may rewrite/truncate the title, and an early
        // event must still be recognized as our internal reflection session.
        if (type === "session.created" && typeof info?.title === "string" && info.title.startsWith("memcurio-reflection")) {
          internalSessions.add(id);
          return;
        }
        if (internalSessions.has(id)) {
          if (type === "session.deleted") {
            internalSessions.delete(id);
          }
          return;
        }
        if (type === "session.created") {
          await adapter.sessionCreated(id, directory, "opencode");
        } else if (type === "session.idle") {
          await adapter.sessionIdle(id);
        } else if (type === "session.compacted") {
          let summary: string | undefined;
          try {
            const res = (await client.session.messages({ path: { id } })) as unknown as {
              data?: SessionMessage[];
            };
            summary = summaryFromMessages(res.data ?? []);
          } catch {
            summary = undefined;
          }
          const fingerprint = summary ?? "<no-summary>";
          const prior = recentCompactions.get(id);
          // Dedupe a double-fired event by identical summary within the
          // window, but never on the failed-extraction sentinel: a second,
          // legitimate compaction whose summary also failed to extract must
          // still reach the engine (it explicitly supports multi-compact).
          if (
            prior &&
            prior.summary !== "<no-summary>" &&
            fingerprint !== "<no-summary>" &&
            prior.summary === fingerprint &&
            Date.now() - prior.ts < 30_000
          ) {
            return;
          }
          await adapter.sessionCompacted(id, summary);
          recentCompactions.set(id, { summary: fingerprint, ts: Date.now() });
        } else if (type === "session.deleted") {
          await adapter.sessionEnded(id);
          recentCompactions.delete(id);
        } else if (type.startsWith("message.part")) {
          const partId = partIdFor(event);
          if (partId) {
            await adapter.messageSeen(id, partId);
          }
        }
      } catch (err) {
        report(err);
      }
    },
    "tool.execute.after": async (input) => {
      try {
        const id = String((input as { sessionID?: string }).sessionID ?? "");
        if (!adapter.state(id)) {
          return;
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
