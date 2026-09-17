/**
 * Projector: host event tags → redacted browser deltas.
 *
 * Host half of the browser memory workbench (docs/ui.md
 * §8): the DSH plugin already subscribes the full session event surface
 * (src/plugin/index.ts) and will adapt those events into {@link InputRecord}
 * tags; this module turns each tag into the {@link ProjectedDelta} payloads
 * the client renders. PURE and DSH-runtime-free: no ctx, no adapter, no
 * store, no sockets — the delta stream is the only boundary.
 *
 * Field security policy (design §9, "出网即脱敏"):
 * - Content strings (the only fields that carry user/model/shell/audit
 *   prose) pass through `redactSecrets(...).text` (src/core/sanitize.js),
 *   are trimmed, and are capped: ordinary text ≤ MAX_CONTENT_CHARS, job
 *   lastError ≤ MAX_ERROR_CHARS. A content field that redacts to empty is
 *   still emitted (structure survives; see drop rule below).
 * - Identifiers are NEVER redacted or truncated: sessionId, jobId,
 *   rolloutKey, workdir, partId, tool and the enum labels (status/kinds).
 *   They are correlation keys the client joins against snapshots and
 *   queue/rollout rows; redacting or folding them would break the exact
 *   matching the deltas exist to drive. The memory file `path` of a
 *   tool-read-hit rides as the usage-tick key and is therefore an
 *   identifier too — the host only tags hits already scoped to the memory
 *   workspace (the plugin filters by DSH_TOOL_PRESET and engine semantics
 *   before projection), so it never carries free-form user content.
 * - Drop rule: structure-bearing deltas survive with empty content, but an
 *   audit tag whose action AND detail both come out empty after sanitize
 *   has nothing to show (design §6.3: an empty receipt is not a receipt)
 *   and is dropped.
 *
 * Statefulness: the only projector state is `lastStaticBySession` (the raw
 * staticText of the previous pre-step-inject per session), which drives the
 * `duplicate` flag. Consecutive identical injects are NOT deduped — the
 * caller decides — the flag only tells the client the static content is
 * unchanged so it can merge rendering. Thread-safety assumption: the host
 * event lane serializes delivery (see the plugin's SessionRuntime queue
 * lanes in src/plugin/index.ts), so project() is only ever called from one
 * lane; the synchronous map read-modify-write is safe under that
 * assumption and needs external serialization otherwise.
 */
import { redactSecrets } from "../core/sanitize.js";
/** Cap for browser-bound content text (static/dynamic inject text,
 *  evidence text, audit detail, audit action). */
export const MAX_CONTENT_CHARS = 2000;
/** Cap for job error text: denser and diagnostic, keep it terse. */
export const MAX_ERROR_CHARS = 300;
/** Redact secrets, trim, and cap a browser-bound content string. Returns
 *  undefined only when the input was undefined; empty and whitespace-only
 *  content survive as "". */
function contentText(text, max) {
    if (text === undefined) {
        return undefined;
    }
    const cleaned = redactSecrets(text).text.trim();
    return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}
/** Include an optional field in the delta only when it is defined, so the
 *  in-memory shape matches what a JSON transport would carry. */
function optional(key, value) {
    if (value === undefined)
        return {};
    return { [key]: value };
}
/** Create a projector. Stateful: `lastStaticBySession` persists across
 *  project() calls on the same instance (duplicate flag semantics, module
 *  doc). Callers that need a "window" for the duplicate comparison decide
 *  it by choosing when the per-session entry is reset (or by discarding
 *  the instance); the module never expires entries on its own. */
/** Cap for the duplicate-window state: per-session static text retained so
 *  long host runs (many sessions) cannot grow it without bound. */
const MAX_TRACKED_SESSIONS = 256;
export function createProjector() {
    const lastStaticBySession = new Map();
    return {
        lastStaticBySession,
        project(record) {
            switch (record.kind) {
                case "pre-step-inject": {
                    // The previous raw staticText (undefined counts as "") decides
                    // duplicate-ness; the raw value is stored so the flag compares
                    // what the host actually injected, not its redacted rendering.
                    const previous = lastStaticBySession.get(record.sessionId);
                    const current = record.staticText ?? "";
                    const duplicate = previous !== undefined && current === previous;
                    // Refresh on hit: delete + set moves the session to the tail, so the
                    // eviction below really drops the least-recently-seen session (a
                    // plain Map.set on an existing key keeps its original position and
                    // would evict active sessions instead).
                    lastStaticBySession.delete(record.sessionId);
                    lastStaticBySession.set(record.sessionId, current);
                    // Bounded duplicate window: evict the least-recently-seen session
                    // once the cap is exceeded.
                    if (lastStaticBySession.size > MAX_TRACKED_SESSIONS) {
                        const oldest = lastStaticBySession.keys().next().value;
                        if (oldest !== undefined)
                            lastStaticBySession.delete(oldest);
                    }
                    return [{
                            kind: "inject-updated",
                            sessionId: record.sessionId,
                            workdir: record.workdir,
                            duplicate,
                            ...optional("staticText", contentText(record.staticText, MAX_CONTENT_CHARS)),
                            ...optional("dynamicText", contentText(record.dynamicText, MAX_CONTENT_CHARS)),
                            ...optional("budgetTokens", record.budgetTokens),
                        }];
                }
                case "tool-read-hit": {
                    // A hit with no path has no key to attribute usage to — dropping
                    // it is safer than an empty-key tick the client cannot merge.
                    const path = record.path.trim();
                    if (path === "") {
                        return [];
                    }
                    return [{
                            kind: "usage-tick",
                            sessionId: record.sessionId,
                            rolloutKey: path,
                            count: 1,
                        }];
                }
                case "citation": {
                    // Keys are model-authored text: shape-sanity filter here (trim,
                    // drop blanks/duplicates); the host adapter must additionally
                    // validate them against stage rows before tagging real usage.
                    const rolloutKeys = [...new Set(record.rolloutKeys.map((k) => k.trim()).filter(Boolean))];
                    const node = {
                        kind: "citation",
                        sessionId: record.sessionId,
                        rolloutKeys,
                    };
                    // One tick per cited key; the node itself always survives so the
                    // timeline can show that an answer cited memories even when the
                    // harvested block named no known rollout.
                    const ticks = rolloutKeys.map((rolloutKey) => ({
                        kind: "usage-tick",
                        sessionId: record.sessionId,
                        rolloutKey,
                        count: 1,
                    }));
                    return [node, ...ticks];
                }
                case "evidence": {
                    return [{
                            kind: "evidence",
                            sessionId: record.sessionId,
                            partId: record.partId,
                            itemKind: record.itemKind,
                            ...optional("text", contentText(record.text, MAX_CONTENT_CHARS)),
                        }];
                }
                case "compaction-prune": {
                    return [{
                            kind: "compaction-prune",
                            sessionId: record.sessionId,
                            seqs: [...record.seqs],
                        }];
                }
                case "job-update": {
                    return [{
                            kind: "queue-updated",
                            ...optional("sessionId", record.sessionId),
                            jobId: record.jobId,
                            status: record.status,
                            attempts: record.attempts,
                            ...optional("lastError", contentText(record.lastError, MAX_ERROR_CHARS)),
                        }];
                }
                case "memory-updated": {
                    return [{
                            kind: "memory-list-updated",
                            ...optional("sessionId", record.sessionId),
                            ...optional("rolloutKey", record.rolloutKey),
                            updateKind: record.updateKind,
                        }];
                }
                case "audit": {
                    const action = contentText(record.action, MAX_CONTENT_CHARS) ?? "";
                    const detail = contentText(record.detail, MAX_CONTENT_CHARS) ?? "";
                    // An audit tag whose action and detail both sanitize to empty is
                    // a text-only record with nothing left to show: drop it.
                    if (action === "" && detail === "") {
                        return [];
                    }
                    return [{
                            kind: "receipt",
                            time: record.time,
                            action,
                            ...(record.ns ? { object: record.ns.slice(0, MAX_ERROR_CHARS) } : {}),
                            detail,
                        }];
                }
            }
        },
    };
}
/** Connection-restore marker delta (design §8.3): after the channel comes
 *  up, the client receives `snapshot-ready` and requests the full snapshot
 *  over the read services. Pure: no store access, no state. */
export function snapshotSeed(sessionId) {
    return [{ kind: "snapshot-ready", sessionId }];
}
