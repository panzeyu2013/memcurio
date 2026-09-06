/** Intent drafts: user-facing (Chinese) prefill messages expressing memory
 *  write intent ("对话即写面", design §6.2). Pure text assembly over the
 *  given reference — never touches a store and never executes: the drafted
 *  message is edited/submitted by the user and runs through the normal
 *  conversation -> tool flow like any other user message. */
export interface IntentRef {
    /** Display title of the referenced entry (rollout card title). */
    title?: string;
    rolloutKey?: string;
    sessionId?: string;
    /** Raw memory text quoted into the draft (takes precedence over title). */
    text?: string;
}
export interface IntentDraftInput {
    kind: "remember" | "update" | "remove";
    ref?: IntentRef;
    /** Free-form user correction/context for update drafts. */
    supplement?: string;
}
export declare function draft(input: IntentDraftInput): string;
