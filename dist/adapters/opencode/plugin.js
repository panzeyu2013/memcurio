import { Index } from "../../core/db.js";
import { indexDb, rootDir } from "../../core/paths.js";
import { MemcurioAdapter } from "../shared/engine.js";
import { WORKER_METADATA_KEY, cleanupStaleWorkers, createOpencodeChannel } from "./channel.js";
const REPLACE_COMPACTION = process.env.MEMCURIO_REPLACE_COMPACTION === "1";
export function shouldSkipInjection(id, isWorker) {
    if (!id || isWorker) {
        return true;
    }
    return process.env.MEMCURIO_DISABLE_INJECT === "1";
}
function properties(event) {
    return (event.properties ?? {});
}
export function sessionIdFor(event) {
    const p = properties(event);
    switch (event.type) {
        case "session.created":
        case "session.updated":
        case "session.deleted": {
            const info = p.info;
            return typeof info?.id === "string" ? info.id : "";
        }
        case "session.idle":
        case "session.compacted": {
            return typeof p.sessionID === "string" ? p.sessionID : "";
        }
        case "message.updated": {
            const info = p.info;
            return typeof info?.sessionID === "string" ? info.sessionID : "";
        }
        case "message.removed":
            return typeof p.sessionID === "string" ? p.sessionID : "";
        case "message.part.updated": {
            const part = p.part;
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
export function partIdFor(event) {
    const p = properties(event);
    const part = p.part;
    if (typeof part?.id === "string") {
        return part.id;
    }
    return typeof p.partID === "string" ? p.partID : "";
}
function textOf(m) {
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
function summaryFromMessages(messages) {
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
// Only the tail of the transcript matters for summaries.
const MESSAGES_LIMIT = 50;
function messageKind(role) {
    return role === "user" ? "user" : role === "assistant" ? "assistant" : "event";
}
function evidenceFromMessages(messages) {
    const out = [];
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
function citationTextsFromMessages(messages) {
    const out = [];
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
async function fetchMessages(client, sessionId) {
    const session = client.session;
    if (!session?.messages) {
        return undefined;
    }
    try {
        const result = await session.messages({
            path: { id: sessionId },
            query: { limit: MESSAGES_LIMIT },
        });
        return result.data ?? [];
    }
    catch {
        return undefined;
    }
}
export const MemcurioPlugin = async ({ directory, client }) => {
    const root = rootDir();
    const recentCompactions = new Map();
    // opencode may dispatch events for the same session concurrently; serialize
    // per session so DB writes (session.created vs message.part.*) never
    // interleave and drop counts.
    const queues = new Map();
    const runSerial = (id, work) => {
        const prev = queues.get(id) ?? Promise.resolve();
        const next = prev.catch(() => { }).then(work);
        queues.set(id, next.catch(() => { }));
        return next;
    };
    const log = (level, message, extra) => {
        void client.app
            .log({ body: { service: "memcurio", level, message, extra } })
            .catch(() => { });
    };
    const toolPreset = {
        readTools: ["read", "grep", "rg", "glob", "ls", "list", "search", "view"],
        shellTools: ["bash"],
    };
    const channel = createOpencodeChannel(client, log);
    const adapter = new MemcurioAdapter({
        durableQueue: true,
        root,
        host: "opencode",
        channel,
        toolPreset,
        log,
    });
    const report = (err) => {
        void client.app
            .log({ body: { service: "memcurio", level: "error", message: String(err) } })
            .catch(() => { });
    };
    // Close this host's session rows left open by a crashed/restarted harness
    // process (the durable worker drains the same queue at startup). Scoped to
    // THIS project's workdir: the data root is global (~/.memcurio), and other
    // opencode instances (one per project) own their own live sessions — closing
    // those would end live sessions and trigger spurious backfill extraction.
    try {
        const idx = await Index.create(indexDb(root));
        try {
            const orphaned = idx.rawAll("SELECT session_id FROM sessions WHERE ended_at IS NULL AND host = 'opencode' AND workdir = ?", [directory]);
            idx.closeAllSessions(new Date().toISOString(), "opencode", directory);
            if (orphaned.length > 0) {
                // A1 crash/lost-session backfill: sessions killed before
                // idle/deleted never enqueued a durable checkpoint. Re-fetch the
                // transcript from the host API (best effort; the host may have pruned
                // it) and enqueue through the normal idempotent queue. Duplicate-safe
                // by the queue's idempotency key; a second init after the job exists
                // is a no-op.
                const evidenceFor = async (sessionId) => {
                    const messages = await fetchMessages(client, sessionId);
                    return messages ? evidenceFromMessages(messages) : undefined;
                };
                void adapter
                    .backfillUnprocessedSessions(orphaned.map((r) => r.session_id), evidenceFor)
                    .catch(report);
            }
        }
        finally {
            idx.close();
        }
    }
    catch {
        // non-fatal: another process may hold the DB during startup
    }
    // Resume jobs left by a previous plugin process. The call is deliberately
    // detached so plugin initialization never waits for a model/provider.
    void adapter.processPendingExtractions().catch(report);
    // Detached: drop worker sessions left behind by a crashed harness process.
    void cleanupStaleWorkers(client, log).catch(report);
    return {
        event: async ({ event }) => {
            const type = event.type;
            const id = sessionIdFor(event);
            if (!id) {
                return;
            }
            if (type === "session.created" || type === "session.updated" || type === "session.deleted") {
                const info = properties(event).info;
                if (info?.metadata?.[WORKER_METADATA_KEY] === true) {
                    channel.registerWorker(id);
                    return;
                }
            }
            if (channel.isWorkerSession(id)) {
                return;
            }
            return runSerial(id, async () => {
                try {
                    // OpenCode does not replay session.created when a plugin is loaded
                    // into an already-running conversation. Reconstruct the local
                    // envelope from any event carrying a session id so authoritative
                    // idle/deleted message snapshots cannot be silently discarded.
                    const info = properties(event).info;
                    const workdir = typeof info?.directory === "string" ? info.directory : directory;
                    if (!adapter.state(id)) {
                        await adapter.sessionCreated(id, workdir, "opencode");
                    }
                    if (type === "session.created" || type === "session.updated") {
                        // sessionCreated is idempotent and refreshes the workdir for an
                        // envelope reconstructed from an earlier partial event.
                        await adapter.sessionCreated(id, workdir, "opencode");
                    }
                    else if (type === "session.idle") {
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
                    }
                    else if (type === "session.compacted") {
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
                        if (prior &&
                            prior.summary === fingerprint &&
                            Date.now() - prior.ts < 30_000) {
                            return;
                        }
                        await adapter.sessionCompacted(id, summary);
                        recentCompactions.set(id, { summary: fingerprint, ts: Date.now() });
                    }
                    else if (type === "session.deleted") {
                        const messages = await fetchMessages(client, id);
                        if (messages) {
                            adapter.messageSnapshot(id, evidenceFromMessages(messages));
                            void adapter.memoryUsageFromCitations(citationTextsFromMessages(messages)).catch(report);
                        }
                        else {
                            // The host API may no longer serve the transcript (session
                            // cleaned up before our fetch). Fall back to the bounded
                            // in-memory evidence so the final checkpoint is not an empty
                            // shell that supersedes the richer idle evidence.
                            const memory = adapter.memoryEvidenceSnapshot(id);
                            if (memory.length > 0) {
                                adapter.messageSnapshot(id, memory);
                            }
                        }
                        await adapter.sessionEnded(id);
                        void adapter.processPendingExtractions().catch(report);
                        // Codex-style automatic Phase 2: consolidate what the finished
                        // session produced instead of waiting for a manual curate.
                        void adapter.maybeConsolidate().catch(report);
                        recentCompactions.delete(id);
                        queues.delete(id);
                    }
                    else if (type === "message.updated") {
                        const info = properties(event).info;
                        if (typeof info?.id === "string") {
                            adapter.messageRoleKnown(id, info.id, messageKind(info.role));
                        }
                    }
                    else if (type === "message.removed") {
                        const messageId = properties(event).messageID;
                        if (typeof messageId === "string") {
                            adapter.messageRemovedByMessage(id, messageId);
                        }
                    }
                    else if (type === "message.part.removed") {
                        const partId = partIdFor(event);
                        if (partId) {
                            adapter.messageRemoved(id, partId);
                        }
                    }
                    else if (type === "message.part.updated") {
                        const partId = partIdFor(event);
                        if (partId) {
                            const part = properties(event).part;
                            const kind = part?.role === "user" || part?.role === "assistant" ? part.role : undefined;
                            await adapter.messageSeen(id, partId, {
                                kind,
                                text: typeof part?.text === "string" ? part.text : undefined,
                                messageId: typeof part?.messageID === "string" ? part.messageID : undefined,
                            });
                        }
                    }
                }
                catch (err) {
                    report(err);
                }
            });
        },
        "tool.execute.after": async (input) => {
            try {
                const id = String(input.sessionID ?? "");
                if (!id || channel.isWorkerSession(id)) {
                    return;
                }
                if (!adapter.state(id)) {
                    await adapter.sessionCreated(id, directory, "opencode");
                }
                const tool = String(input.tool ?? "");
                if (!tool) {
                    return;
                }
                const args = input.args ?? {};
                const filePath = typeof args.filePath === "string"
                    ? args.filePath
                    : typeof input.filePath === "string"
                        ? input.filePath
                        : undefined;
                // Pass the raw args fields so the engine can harvest C1 usage
                // telemetry: args.path for grep/rg/search/list directory reads and
                // args.command for shell tools (bash/exec) whose reads the model
                // performed without a filePath.
                await adapter.toolExecuted(id, tool, {
                    filePath,
                    path: typeof args.path === "string" ? args.path : undefined,
                    command: typeof args.command === "string" ? args.command : undefined,
                });
                void adapter.processPendingExtractions().catch(report);
            }
            catch (err) {
                report(err);
            }
        },
        "experimental.session.compacting": async (input, output) => {
            try {
                const id = String(input.sessionID ?? "");
                if (channel.isWorkerSession(id)) {
                    return;
                }
                const context = await adapter.buildCompactionContext(id, directory);
                if (context) {
                    if (REPLACE_COMPACTION) {
                        output.prompt = adapter.buildReplacePrompt(id, context);
                    }
                    else {
                        output.context.push(context);
                    }
                }
            }
            catch (err) {
                report(err);
            }
        },
        "experimental.chat.system.transform": async (input, output) => {
            const id = String(input.sessionID ?? "");
            if (shouldSkipInjection(id, channel.isWorkerSession(id))) {
                return;
            }
            try {
                const ctx = await adapter.buildStaticContext(directory);
                if (ctx) {
                    output.system.push(ctx);
                }
            }
            catch (err) {
                report(err);
            }
        },
        "chat.message": async (input, output) => {
            const id = String(input.sessionID ?? "");
            if (shouldSkipInjection(id, channel.isWorkerSession(id))) {
                return;
            }
            try {
                const parts = output.parts ?? [];
                const text = parts
                    .filter((p) => p.type === "text")
                    .map((p) => p.text ?? "")
                    .join("\n")
                    .trim();
                if (!text) {
                    return;
                }
                const ctx = await adapter.buildDynamicContext(directory, text);
                if (ctx) {
                    output.parts = [{ type: "text", text: ctx }, ...parts];
                }
            }
            catch (err) {
                report(err);
            }
        },
    };
};
// Default export keeps the plugin loadable through the modern loader; the
// named export exists for legacy loaders that scan function exports.
export default MemcurioPlugin;
