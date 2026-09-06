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

const MAX_QUOTE_CHARS = 2000;

/** Collapse whitespace (including newlines) and drop control characters so an
 *  arbitrary memory line cannot forge message structure or embed terminal
 *  control sequences in a user-facing draft; then cap the quote length. */
function clean(text: string): string {
  const oneLine = text.replace(/\s+/g, " ");
  const scrubbed = oneLine
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: C0/C1 controls are stripped on purpose
      /[\u0000-\u001f\u007f-\u009f]+/g,
      "",
    )
    .replace(/\s+/g, " ")
    .trim();
  return scrubbed.length > MAX_QUOTE_CHARS ? scrubbed.slice(0, MAX_QUOTE_CHARS) : scrubbed;
}

function provenance(ref: IntentRef): string {
  const parts: string[] = [];
  const rolloutKey = clean(ref.rolloutKey ?? "");
  const sessionId = clean(ref.sessionId ?? "");
  if (rolloutKey) {
    parts.push(`rollout ${rolloutKey}`);
  }
  if (sessionId) {
    parts.push(`会话 ${sessionId}`);
  }
  return parts.length > 0 ? `（来源：${parts.join("，")}）` : "";
}

export function draft(input: IntentDraftInput): string {
  const ref: IntentRef = input.ref ?? {};
  const quote = clean(ref.text ?? ref.title ?? "");
  const quotePart = quote ? `：${quote}` : "";
  if (input.kind === "remember") {
    if (!quote && !provenance(ref)) {
      // Nothing concrete to remember: the draft still must be a usable
      // prompt, never a dangling "请记住" with an empty source.
      return "请记住这条内容。";
    }
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
