export interface AuditEntry {
    time: string;
    action: string;
    /** Object/namespace the write targeted (e.g. session/rollout key). */
    object?: string;
    detail: string;
}
export interface AuditListOptions {
    limit?: number;
    /** Substring filter over the structured action/namespace columns. */
    filter?: string;
}
/** Audit receipts (write-path record), newest first; detail is re-redacted on
 *  the way out (defense in depth — the table is already sanitized on write). */
export declare function list(root: string, options?: AuditListOptions): Promise<AuditEntry[]>;
export declare function count(root: string): Promise<number>;
