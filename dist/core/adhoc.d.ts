export type AdHocKind = "remember" | "forget" | "update";
export interface AdHocNote {
    id: string;
    filename: string;
    kind: AdHocKind;
    content: string;
    createdAt: string;
    applied: boolean;
}
/** Seed the ad-hoc instructions file once (codex's create_new(true) →
 *  AlreadyExists → Ok): an existing file — user edits included — is
 *  authoritative and must never be overwritten. The path is workspace-bounded
 *  (resolveWorkspacePath) and the create is exclusive (O_EXCL), so a file
 *  appearing between check and write can never be clobbered. Idempotent and
 *  cheap; safe on every plan/consolidation/list path. */
export declare function ensureAdHocInstructions(root: string): void;
/** Write an append-only ad-hoc memory note (mirrors codex's
 *  extensions/ad_hoc/notes). The note is consolidated on the next Phase 2 run;
 *  the model never edits memory files directly during sessions. The content
 *  cap lives in core so every entry point (plugin tools, future host services) shares it. */
export declare const MAX_ADHOC_NOTE_CHARS = 20000;
export declare function addAdHocNote(root: string, content: string, kind?: AdHocKind): Promise<AdHocNote>;
export declare function listAdHocNotes(root: string): Promise<AdHocNote[]>;
export interface PendingAdHocNotesOptions {
    /** Adopt orphan note files as pending remember notes. The execute path
     *  opts in explicitly; the dry-run plan path passes false so `memcurio
     *  plan` never mutates the store. Defaults to true (direct callers and
     *  tests rely on adoption). */
    adopt?: boolean;
    /** Settle missing/unresolvable never-applied rows as applied so the
     *  auto-consolidation work gate can clear. Defaults to true. */
    settle?: boolean;
}
/** Notes that still need consolidation: never-applied rows plus rows whose
 *  note file was edited after they were applied (codex-style: a note edit is
 *  new diff input and must be re-merged). The file is the source of truth for
 *  content. Rows whose file is missing or unresolvable (deleted, symlink
 *  escape) have nothing to merge and are skipped — never-applied rows are
 *  marked applied with an adhoc.skip audit so the auto-consolidation work
 *  gate can clear instead of looping forever (settle=false keeps plan mode
 *  read-only). Orphan note files without a DB row (e.g. hand-written) are
 *  adopted as pending remember notes instead of being silently dropped
 *  (adopt=false keeps plan mode read-only). */
export declare function pendingAdHocNotes(root: string, opts?: PendingAdHocNotesOptions): Promise<AdHocNote[]>;
export declare function markAdHocNotesApplied(root: string, ids: string[]): Promise<void>;
