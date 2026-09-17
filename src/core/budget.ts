// Han (CJK Ext A + unified ideographs + Ext B/D/E/F/G + supplementary-plane
// CJK), hiragana, katakana (incl. halfwidth), hangul syllables/Jamo and the
// CJK compatibility block all cost ~1 token/char in mainstream tokenizers;
// plain ASCII-only estimation under-counts them. (Explicit ranges: Bun's
// regex engine does not support \p{Han} style script properties, only general
// categories; \u{20000}-\u{2fa1f} covers CJK Ext B..F in ES2018+ escapes.)
const CJK = /[\u1100-\u11ff\u3040-\u309f\u30a0-\u30ff\u3130-\u318f\u3400-\u4dbf\u4e00-\u9fff\uff66-\uff9f\uac00-\ud7af\u{20000}-\u{2fa1f}\u{30000}-\u{323af}]/u;

export function estimateTokens(text: string): number {
  let cost = 0;
  for (const ch of text) {
    cost += CJK.test(ch) ? 1 : 0.25;
  }
  return Math.ceil(cost);
}

export interface FitResult {
  lines: string[];
  truncated: number;
  usedTokens: number;
}

export function fitLines(lines: string[], budgetTokens: number): FitResult {
  const fitted: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line);
    if (used + cost > budgetTokens) {
      break;
    }
    fitted.push(line);
    used += cost;
  }
  return { lines: fitted, truncated: lines.length - fitted.length, usedTokens: used };
}

export function renderBudgetNotice(truncated: number): string {
  return truncated > 0 ? `(${truncated} more not injected: over token budget)` : "";
}

/** Inject a truncated prefix of an over-budget single line instead of dropping
 *  it entirely (whole-line granularity would otherwise waste the budget). The
 *  returned string never exceeds budgetTokens (the marker cost is reserved).
 *  Characters are accumulated one at a time with the per-character cost: an
 *  average over the whole line (tokens/char) over-approximates how many CJK
 *  chars fit when the line mixes dense CJK prefixes with ASCII suffixes, which
 *  would silently blow the budget. */
function fitPartialLine(line: string, budgetTokens: number): string {
  if (budgetTokens <= 0 || !line) {
    return "";
  }
  const total = estimateTokens(line);
  if (total <= budgetTokens) {
    return line;
  }
  const marker = " …[truncated]";
  const maxBodyTokens = budgetTokens - estimateTokens(marker);
  if (maxBodyTokens < 1) {
    // The budget cannot hold even one character plus the marker.
    return "";
  }
  let body = "";
  let used = 0;
  for (const ch of line) {
    const cost = CJK.test(ch) ? 1 : 0.25;
    if (used + cost > maxBodyTokens) {
      break;
    }
    body += ch;
    used += cost;
  }
  return body ? `${body}${marker}` : marker;
}

export function fitContext(lines: string[], budgetTokens: number): string {
  const clean = lines.filter((line) => line !== "");
  const fitted = fitLines(clean, budgetTokens);
  if (fitted.truncated === 0) {
    return fitted.lines.join("\n");
  }
  // Reserve room for the "N more not injected" notice so it is never silently
  // dropped at the edge of the budget. The final count is the sum of BOTH
  // fits' drops: the first fit only sees the full line list, the second only
  // the already-fitted subset, so counting one alone under-reports.
  let notice = renderBudgetNotice(fitted.truncated);
  let body = fitLines(fitted.lines, Math.max(0, budgetTokens - estimateTokens(notice)));
  const dropped = fitted.truncated + body.truncated;
  if (dropped !== fitted.truncated) {
    notice = renderBudgetNotice(dropped);
    // Refit so the (possibly longer) final notice still stays inside the
    // global budget.
    body = fitLines(fitted.lines, Math.max(0, budgetTokens - estimateTokens(notice)));
  }
  if (body.lines.length === 0 && clean.length > 0 && budgetTokens > 10) {
    // Every line was too big for the budget: keep a partial first line rather
    // than silently dropping all context. Reserve the notice and the join
    // newline so the combined result stays inside the global budget; when the
    // notice alone already fills the budget, content cannot fit at all.
    const noticeBudget = estimateTokens(notice);
    const partialBudget = budgetTokens - noticeBudget - 1;
    if (partialBudget < 1) {
      return notice;
    }
    const first = clean[0];
    if (first === undefined) {
      return notice;
    }
    const partial = fitPartialLine(first, partialBudget);
    return [partial, notice].filter((l) => l !== "").join("\n");
  }
  // With a very small budget the notice itself may not fit; drop it rather
  // than exceed the budget (the notice is diagnostic, the content is not).
  const safeNotice = estimateTokens(notice) <= budgetTokens ? notice : "";
  return [...body.lines, safeNotice].filter((l) => l !== "").join("\n");
}

/** Codex-style middle truncation: keep the head and the tail of one over-budget
 *  block and drop the middle behind an explicit marker. Memory summaries put
 *  the stable profile first and the newest task groups last, so the middle is
 *  the least lossy thing to drop; a head-only cut would silently discard every
 *  later update while still spending the full budget. Returns the original text
 *  when it already fits. */
export function truncateMiddle(text: string, budgetTokens: number): string {
  if (budgetTokens <= 0) {
    return "";
  }
  if (estimateTokens(text) <= budgetTokens) {
    return text;
  }
  // Codex parity (utils/string truncate.rs): reserve room for the marker
  // first, then split the remaining budget in half with the head taking the
  // floor — `split_budget`/`split_string` keep both halves on character
  // boundaries and the marker names the removed token count.
  const total = estimateTokens(text);
  const markerWorst = `…${total} tokens truncated…`;
  const available = budgetTokens - estimateTokens(markerWorst);
  if (available < 2) {
    return "";
  }
  const headBudget = Math.floor(available / 2);
  const tailBudget = available - headBudget;
  const head = takeTokens(text, headBudget, false).replace(/\s+$/, "");
  const tail = takeTokens(text, tailBudget, true).replace(/^\s+/, "");
  const removed = Math.max(0, total - estimateTokens(head) - estimateTokens(tail));
  return `${head}…${removed} tokens truncated…${tail}`;
}

/** Take at most budgetTokens worth of text from the start (or the end when
 *  fromEnd is set), iterating code points so a surrogate pair is never split
 *  and the per-character cost stays exact for mixed CJK/ASCII text. */
function takeTokens(text: string, budgetTokens: number, fromEnd: boolean): string {
  const chars = [...text];
  const order = fromEnd ? chars.reverse() : chars;
  const picked: string[] = [];
  let used = 0;
  for (const ch of order) {
    const cost = CJK.test(ch) ? 1 : 0.25;
    if (used + cost > budgetTokens) {
      break;
    }
    picked.push(ch);
    used += cost;
  }
  return (fromEnd ? picked.reverse() : picked).join("");
}
