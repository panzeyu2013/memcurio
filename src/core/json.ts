import { redactSecrets } from "./sanitize.js";

/** Slice the outermost JSON object out of an LLM reply and parse it. Throws
 *  when no JSON object is parseable. Three bounded tolerances keep a merely
 *  malformed reply from dead-lettering a durable extraction job:
 *
 *  1. prose around the object is tolerated by trying each candidate start
 *     brace and each candidate end brace in turn;
 *  2. raw control characters inside string literals (long LLM strings
 *     frequently carry literal newlines) are escaped and the parse retried;
 *  3. a reply truncated at the output-token cap is closed at the cut point
 *     (terminate the open string, pop the open brackets) and retried.
 *
 *  Error messages are redacted: LLM output can echo secrets from the prompt. */
export function extractJsonObject(text: string): unknown {
  for (const candidate of jsonCandidates(text)) {
    const parsed = parseFromCandidates(candidate);
    if (parsed !== undefined) return parsed.value;
  }
  throw new Error(`no JSON object in LLM output: ${redactSecrets(text.slice(0, 120)).text}`);
}

/** Candidate texts, cheapest and most faithful first. */
function* jsonCandidates(text: string): Generator<string> {
  yield text;
  const escaped = escapeControlsInStrings(text);
  if (escaped !== text) {
    yield escaped;
    const closed = closeTruncatedJson(escaped);
    if (closed !== undefined) yield closed;
  }
  const closedRaw = closeTruncatedJson(text);
  if (closedRaw !== undefined && closedRaw !== text && closedRaw !== escaped) yield closedRaw;
}

/** Try each candidate start brace (bounded) against each candidate end brace
 *  (bounded). `undefined` means every pair failed to parse. */
function parseFromCandidates(text: string): { value: unknown } | undefined {
  const starts: number[] = [];
  for (let i = text.indexOf("{"); i >= 0 && starts.length < 5; i = text.indexOf("{", i + 1)) {
    starts.push(i);
  }
  for (const start of starts) {
    let end = text.lastIndexOf("}");
    let attempts = 0;
    while (end > start && attempts < 20) {
      attempts += 1;
      try {
        return { value: JSON.parse(text.slice(start, end + 1)) };
      } catch {
        end = text.lastIndexOf("}", end - 1);
      }
    }
  }
  return undefined;
}

/** Escape raw control characters that appear INSIDE JSON string literals. A
 *  literal newline in a long string is the most common way an otherwise
 *  well-formed reply becomes unparsable; structural whitespace between tokens
 *  is left untouched. */
function escapeControlsInStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (inString && ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      out += ch;
      continue;
    }
    if (inString) {
      const code = ch.codePointAt(0) ?? 0;
      if (code < 0x20) {
        out += code === 0x0a ? "\\n" : code === 0x0d ? "\\r" : code === 0x09 ? "\\t" : `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
    }
    out += ch;
  }
  return out;
}

/** Close an object cut off at the output-token cap: terminate the open string
 *  and pop the brackets still on the stack. `undefined` when nothing is open
 *  (a complete reply never needs this repair). */
function closeTruncatedJson(text: string): string | undefined {
  const start = text.indexOf("{");
  if (start < 0) return undefined;
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i] ?? "";
    if (escaped) {
      escaped = false;
      continue;
    }
    if (inString) {
      if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") stack.push(ch === "{" ? "}" : "]");
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let suffix = inString ? '"' : "";
  for (let i = stack.length - 1; i >= 0; i -= 1) suffix += stack[i] ?? "";
  if (suffix === "") return undefined;
  return `${text}${suffix}`;
}
