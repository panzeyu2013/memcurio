export const WORKER_METADATA_KEY = "memcurio.internal";
/** Worker prompt timeout. Without it a hung host model would leave the job in
 *  `processing` forever (lease renews indefinitely, attempts never grow), so
 *  it would never retry or dead-letter and would squat one of the bounded
 *  extraction slots. The timeout must stay below the job lease so the job
 *  falls back to a normal retry path instead of being fenced. */
export const WORKER_CHAT_TIMEOUT_MS = 120_000;
/** Hard cap on worker replies, mirroring the HTTP channel's response cap:
 *  an unbounded reply would accumulate in the plugin process and explode
 *  JSON parsing/transcript costs. */
export const WORKER_CHAT_MAX_BYTES = 2 * 1024 * 1024;
function withTimeout(promise, ms, reason) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(reason()), ms);
        timer.unref?.();
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (err) => {
            clearTimeout(timer);
            reject(err);
        });
    });
}
export function createOpencodeChannel(client, log) {
    const workerSessions = new Set();
    return {
        name: "opencode",
        isWorkerSession(id) {
            return workerSessions.has(id);
        },
        registerWorker(id) {
            if (id) {
                workerSessions.add(id);
            }
        },
        // The signal is deliberately unused: opencode worker prompts already run
        // under WORKER_CHAT_TIMEOUT_MS, and mid-prompt cancellation is handled by
        // the host when the worker session is deleted.
        async chat(system, user, _signal) {
            const created = await client.session.create({
                body: {
                    title: "memcurio-worker",
                    metadata: { [WORKER_METADATA_KEY]: true },
                    permission: [{ permission: "*", pattern: "*", action: "deny" }],
                },
            });
            const id = created.data?.id;
            if (!id) {
                throw new Error("opencode channel: worker session create returned no id");
            }
            workerSessions.add(id);
            try {
                const result = await withTimeout(client.session.prompt({
                    path: { id },
                    body: { system, parts: [{ type: "text", text: user }] },
                }), WORKER_CHAT_TIMEOUT_MS, () => new Error(`opencode channel: worker prompt timed out after ${WORKER_CHAT_TIMEOUT_MS}ms`));
                const text = (result.data?.parts ?? [])
                    .filter((part) => part.type === "text")
                    .map((part) => part.text ?? "")
                    .join("");
                if (Buffer.byteLength(text, "utf-8") > WORKER_CHAT_MAX_BYTES) {
                    throw new Error(`opencode channel: worker reply exceeds ${WORKER_CHAT_MAX_BYTES} byte cap`);
                }
                return text;
            }
            finally {
                // Delete BEFORE unregistering: the host may dispatch the worker
                // session's `session.deleted` event while the delete is in flight,
                // and the plugin handler must still recognize it as a worker session
                // (via the Set) to skip pipeline processing. Unregistering first
                // would let that event fall through as a real session and enqueue a
                // spurious extraction job.
                try {
                    await client.session.delete({ path: { id } });
                }
                catch (err) {
                    log?.("warn", "opencode channel: worker session delete failed", {
                        sessionId: id,
                        error: String(err),
                    });
                }
                workerSessions.delete(id);
            }
        },
    };
}
export async function cleanupStaleWorkers(client, log) {
    let sessions = [];
    try {
        const result = await client.session.list();
        sessions = result.data ?? [];
    }
    catch (err) {
        log?.("warn", "opencode channel: session list failed during cleanup", { error: String(err) });
        return 0;
    }
    let deleted = 0;
    for (const session of sessions) {
        if (session.metadata?.[WORKER_METADATA_KEY] !== true) {
            continue;
        }
        try {
            await client.session.delete({ path: { id: session.id } });
            deleted += 1;
        }
        catch (err) {
            log?.("warn", "opencode channel: stale worker delete failed", {
                sessionId: session.id,
                error: String(err),
            });
        }
    }
    return deleted;
}
