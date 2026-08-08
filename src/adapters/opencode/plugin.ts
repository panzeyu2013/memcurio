import type { Plugin } from "@opencode-ai/plugin";

import { MemcoreAdapter } from "../shared/engine.js";
const REPLACE_COMPACTION = process.env.MEMCORE_REPLACE_COMPACTION === "1";

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
    case "message.part.updated":
    case "message.part.removed": {
      const part = p.part as { sessionID?: unknown } | undefined;
      return typeof part?.sessionID === "string" ? part.sessionID : "";
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
  parts: Array<{ type?: string; text?: string }>;
}

function summaryFromMessages(messages: SessionMessage[]): string | undefined {
  const last = messages.at(-1);
  if (!last) {
    return undefined;
  }
  const text = last.parts
    .filter((p) => p.type === "text" && typeof p.text === "string" && p.text)
    .map((p) => String(p.text))
    .join("\n")
    .trim();
  return text ? text.slice(0, 2000) : undefined;
}

export const MemcorePlugin: Plugin = async ({ directory, client }) => {
  const adapter = new MemcoreAdapter({
    log: (level, message, extra) => {
      void client.app
        .log({ body: { service: "memcore", level, message, extra } })
        .catch(() => {});
    },
  });
  const report = (err: unknown): void => {
    void client.app
      .log({ body: { service: "memcore", level: "error", message: String(err) } })
      .catch(() => {});
  };
  return {
    event: async ({ event }) => {
      const type = event.type;
      const id = sessionIdFor(event);
      if (!id) {
        return;
      }
      try {
        if (type === "session.created") {
          await adapter.sessionCreated(id, directory);
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
          await adapter.sessionCompacted(id, summary);
        } else if (type === "session.deleted") {
          await adapter.sessionEnded(id);
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
