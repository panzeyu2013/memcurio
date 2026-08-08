import type { Plugin } from "@opencode-ai/plugin";

import { MemcoreAdapter } from "../shared/engine.js";
const REPLACE_COMPACTION = process.env.MEMCORE_REPLACE_COMPACTION === "1";

function properties(event: { properties?: unknown }): Record<string, unknown> {
  return (event.properties ?? {}) as Record<string, unknown>;
}

function sessionIdOf(event: { properties?: unknown }): string {
  const p = properties(event);
  return String(p.sessionID ?? p.id ?? "");
}

export const MemcorePlugin: Plugin = async ({ directory, client }) => {
  const adapter = new MemcoreAdapter({
    log: (level, message, extra) => {
      void client.app
        .log({ body: { service: "memcore", level, message, extra } })
        .catch(() => {});
    },
  });
  return {
    event: async ({ event }) => {
      const type = event.type;
      const id = sessionIdOf(event);
      if (!id) {
        return;
      }
      if (type === "session.created") {
        await adapter.sessionCreated(id, directory);
      } else if (type === "session.idle") {
        await adapter.sessionIdle(id).catch((e) => client.app.log({
          body: { service: "memcore", level: "error", message: String(e) },
        }).catch(() => {}));
      } else if (type === "session.compacted") {
        await adapter.sessionCompacted(id);
      } else if (type === "session.deleted") {
        await adapter.sessionEnded(id).catch((e) => client.app.log({
          body: { service: "memcore", level: "error", message: String(e) },
        }).catch(() => {}));
      } else if (type.startsWith("message.part")) {
        const p = properties(event);
        const partId = String(p.partID ?? p.id ?? "");
        if (partId) {
          await adapter.messageSeen(id, partId);
        }
      }
    },
    "tool.execute.after": async (input) => {
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
    },
    "experimental.session.compacting": async (input, output) => {
      const id = String((input as { sessionID?: string }).sessionID ?? "");
      const context = await adapter.buildCompactionContext(id, directory);
      if (context) {
        if (REPLACE_COMPACTION) {
          output.prompt = adapter.buildReplacePrompt(id, context);
        } else {
          output.context.push(context);
        }
      }
    },
  };
};
