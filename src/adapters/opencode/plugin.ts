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
  messages(options: { path: { id: string }; query?: { directory?: string; limit?: number } }): Promise<{ data?: SessionMessage[] }>;
  delete(options: { path: { id: string } }): Promise<unknown>;
}

// A reflection turn can take minutes; wait up to this long for the reply.
const REFLECTION_TIMEOUT_MS = 120_000;
const REFLECTION_POLL_MS = 1_500;
// Only the tail of the transcript matters for summaries/reflections.
const MESSAGES_LIMIT = 50;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
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
        // session.prompt may resolve before the model finishes (the SDK also
        // exposes promptAsync for fire-and-forget, so the blocking semantics
        // are not guaranteed); poll the transcript until the reply is visible
        // and parses as our reflection JSON. Only then is it safe to delete
        // the temporary session. If the reply settles into a state that never
        // parses (e.g. the model refuses to emit JSON), bail out early so the
        // HTTP fallback below still gets its share of the reflection budget.
        const deadline = Date.now() + REFLECTION_TIMEOUT_MS;
        let unchangedRounds = 0;
        let lastSignature = "";
        while (Date.now() < deadline) {
          const res = await client.session.messages({ path: { id }, query: { limit: MESSAGES_LIMIT } });
          const data = res.data ?? [];
          const raw = summaryFromMessages(data);
          if (raw) {
            try {
              return parseReflectionResponse(raw);
            } catch {
              // Partial/intermediate reply; keep polling for the final one.
            }
          }
          const signature = `${data.length}|${raw ?? ""}`;
          unchangedRounds = signature === lastSignature ? unchangedRounds + 1 : 0;
          lastSignature = signature;
          if (unchangedRounds >= 3) {
            // Transcript stopped changing across poll rounds without a
            // parsable reply: the turn is done and the answer is unusable.
            return null;
          }
          await sleep(REFLECTION_POLL_MS);
        }
        return null;
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
      return runSerial(id, async () => {
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
              const res = (await client.session.messages({ path: { id }, query: { limit: MESSAGES_LIMIT } })) as unknown as {
                data?: SessionMessage[];
              };
              summary = summaryFromMessages(res.data ?? []);
            } catch {
              summary = undefined;
            }
            const fingerprint = summary ?? "<no-summary>";
            const prior = recentCompactions.get(id);
            // Dedupe a double-fired event by identical summary within the
            // window. The failed-extraction sentinel also dedupes within the
            // window: a second <no-summary> in 30s is the same early event
            // re-fired (its summary would still fail to extract), and
            // double-firing would run two 120s LLM reflections back-to-back.
            // A later, distinct compaction (different window) still reaches
            // the engine — it explicitly supports multi-compact.
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
            await adapter.sessionEnded(id);
            recentCompactions.delete(id);
            queues.delete(id);
          } else if (type.startsWith("message.part")) {
            const partId = partIdFor(event);
            if (partId) {
              await adapter.messageSeen(id, partId);
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
