/** Intent drafts: user-facing (Chinese) prefill messages expressing memory
 *  write intent ("对话即写面", design §6.2). Pure text assembly over the
 *  given reference — never touches a store and never executes: the drafted
 *  message is edited/submitted by the user and runs through the normal
 *  conversation -> tool flow like any other user message. */
const MAX_QUOTE_CHARS = 2000;
/** Collapse whitespace (including newlines) and drop control characters so an
 *  arbitrary memory line cannot forge message structure or embed terminal
 *  control sequences in a user-facing draft; then cap the quote length. */
function clean(text) {
    const oneLine = text.replace(/\s+/g, " ");
    const scrubbed = oneLine
        .replace(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: C0/C1 controls are stripped on purpose
    /[\u0000-\u001f\u007f-\u009f]+/g, "")
        .replace(/\s+/g, " ")
        .trim();
    return scrubbed.length > MAX_QUOTE_CHARS ? scrubbed.slice(0, MAX_QUOTE_CHARS) : scrubbed;
}
function provenance(ref) {
    const parts = [];
    if (ref.rolloutKey) {
        parts.push(`rollout ${clean(ref.rolloutKey)}`);
    }
    if (ref.sessionId) {
        parts.push(`会话 ${clean(ref.sessionId)}`);
    }
    return parts.length > 0 ? `（来源：${parts.join("，")}）` : "";
}
export function draft(input) {
    const ref = input.ref ?? {};
    const quote = clean(ref.text ?? ref.title ?? "");
    const quotePart = quote ? `：${quote}` : "";
    if (input.kind === "remember") {
        return `请记住${quotePart}${provenance(ref)}`;
    }
    if (input.kind === "update") {
        const supplement = clean(input.supplement ?? "");
        const action = supplement
            ? `请基于${supplement}更新/移除相关内容。`
            : "请据此更新/移除相关内容。";
        return `这条记忆已过时${quotePart}。${action}`;
    }
    return `这条不再需要${quotePart}。请移除仅依赖它的内容。`;
}
