export interface SanitizeResult {
  text: string;
  redacted: boolean;
}

const SECRET_PATTERNS: RegExp[] = [
  // key=value / key: value with optional spaces inside the key name ("API Key")
  // and around the separator. Known tradeoff: a legit "pk=..." (public key)
  // entry is redacted too — over-redaction is preferred over leaking secrets.
  /(?<![A-Za-z0-9])(?:sk|pk|api[\s_-]*key|apikey|secret|token|password|passwd|bearer)[-_. ]*[=:]\s*["']?[\p{L}\p{N}_\-./]{12,}["']?/giu,
  /sk-[\p{L}\p{N}_-]{16,}/giu,
  /(?:sk|rk)_(?:live|test)_[\p{L}\p{N}]{16,}/gu,
  /AKIA[0-9A-Z]{16}\b/g,
  /gh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /github_pat_[A-Za-z0-9_]{20,}\b/g,
  /AIza[0-9A-Za-z_-]{30,}\b/g,
  /(?<![A-Za-z0-9])(?:Bearer|bearer|BEARER)\s+["']?[\p{L}\p{N}._-]{20,}["']?/gu,
  /(?<![A-Za-z0-9])-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/g,
  // name<whitespace>value
  /(?<![A-Za-z0-9])(?:api[\s_-]*key|apikey|secret|token|password|passwd|bearer)\s+["']?[\p{L}\p{N}_\-./]{16,}["']?/giu,
  // Short secrets (8-11 chars) under strong-signal key names; >=12 is covered
  // by the first pattern.
  /(?<![A-Za-z0-9])(?:password|passwd|secret)[-_. ]*[=:]\s*["']?[\p{L}\p{N}_\-./]{8,11}["']?(?![A-Za-z0-9])/giu,
  // Chinese key names (密码/密钥/令牌/凭据). normalizeText has already folded
  // fullwidth separators to ASCII before this runs. The lookbehind only
  // excludes ASCII word chars, so compound forms like "数据库密码:…" or
  // "用户令牌=…" (the most common real-world shapes) still match; false
  // positives on prose ("密码：请设置强密码") are kept out by the trailing
  // lookahead and the >=12-char requirement on the whitespace form.
  /(?<![A-Za-z0-9])(?:密码|密钥|令牌|凭据)[-_. ]*[=:]\s*["']?[\p{L}\p{N}_\-./]{8,}["']?(?![A-Za-z0-9\p{L}])/gu,
  /(?<![A-Za-z0-9])(?:密码|密钥|令牌|凭据)\s+["']?[\p{L}\p{N}_\-./]{12,}["']?(?![A-Za-z0-9\p{L}])/gu,
  // Bare JWT without a "Bearer" prefix ("eyJ" is base64 of the "{" header).
  /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
];

// Standalone high-entropy tokens: >=24 chars with at least one uppercase, one
// lowercase and one digit (base64/url-safe secrets with no key name). A token
// must additionally score >=4.5 bits/char of Shannon entropy, which excludes
// prose identifiers (branch/version names, mixed-case hex digests score 4.0).
// Known tradeoff: genuinely random long tokens that happen to score below the
// entropy bar (or long mixed-case product IDs above it) are misclassified —
// acceptable for a heuristic whose failure mode is over- or under-redaction
// of already-rare shapes.
const HIGH_ENTROPY = /(?<![A-Za-z0-9])([A-Za-z0-9+/_=-]{24,})(?![A-Za-z0-9])/g;

/** Shannon entropy in bits/char. Near-uniform base64/url-safe secrets score
 *  >=4.5; hex digests (16-symbol alphabet) score exactly 4.0; prose
 *  identifiers with repeated letters score well below that. */
function shannonEntropy(tok: string): number {
  const counts = new Map<string, number>();
  for (const ch of tok) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let h = 0;
  for (const n of counts.values()) {
    const p = n / tok.length;
    h -= p * Math.log2(p);
  }
  return h;
}

const HOMOGLYPH_MAP: Record<string, string> = {
  а: "a", е: "e", і: "i", о: "o", ѕ: "s", р: "p", с: "c", у: "y", х: "x", ё: "e", һ: "h", ј: "j", ї: "i",
  А: "A", Е: "E", І: "I", О: "O", Ѕ: "S", Р: "P", С: "C", У: "Y", Х: "X", Ё: "E", Н: "H", Ј: "J", Ї: "I",
  "’": "'", "‘": "'", "“": '"', "”": '"', "‑": "-", "–": "-", "—": "-", "…": "...", "　": " ",
};

/** Map the Mathematical Alphanumeric Symbols Latin block (U+1D400–U+1D6A3)
 *  and digit block (U+1D7CE–U+1D7FF) onto ASCII. The block is 13 variants
 *  (bold, italic, bold-italic, script, bold-script, fraktur, double-struck,
 *  bold-fraktur, sans-serif, sans-bold, sans-italic, sans-bold-italic,
 *  monospace), each holding A–Z then a–z — offsets are NOT linear, so the map
 *  is built per range. */
const MATH_VARIANT_PATTERN = /[\u{1D400}-\u{1D6A3}\u{1D7CE}-\u{1D7FF}]/gu;

function buildMathFoldMap(): ReadonlyMap<string, string> {
  const map = new Map<string, string>();
  const upper = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  const lower = "abcdefghijklmnopqrstuvwxyz";
  let base = 0x1d400;
  for (let style = 0; style < 13; style++) {
    for (let i = 0; i < 26; i++) {
      map.set(String.fromCodePoint(base + i), upper[i] ?? "?");
      map.set(String.fromCodePoint(base + 26 + i), lower[i] ?? "?");
    }
    base += 52;
  }
  const digits = "0123456789";
  for (let d = 0x1d7ce; d <= 0x1d7ff; d++) {
    map.set(String.fromCodePoint(d), digits[(d - 0x1d7ce) % 10] ?? "?");
  }
  return map;
}

const MATH_FOLD_MAP = buildMathFoldMap();

function foldMathVariants(ch: string): string {
  return MATH_FOLD_MAP.get(ch) ?? ch;
}

/** Greek letters that are near-identical to Latin ones. Theta is excluded:
 *  it transliterates as "th" and folding it would misclassify legitimate
 *  text. Applies to BOTH plain Greek (U+0370–U+03FF) and the Mathematical
 *  Greek segment (U+1D6A4–U+1D7CD, six styles × uppercase/lowercase) — the
 *  math-Greek variants were previously unmapped and let "𝛊𝛾𝜈𝜊𝜌𝜀" spell
 *  "ignore" past the scanner. */
const GREEK_LATIN: Record<string, string> = {
  α: "a", β: "b", γ: "g", δ: "d", ε: "e", ζ: "z", η: "h",
  ι: "i", κ: "k", λ: "l", μ: "m", ν: "n", ξ: "x", ο: "o",
  π: "p", ρ: "r", σ: "s", τ: "t", υ: "u", φ: "f", χ: "x",
  ψ: "y", ω: "w",
};

const GREEK_MATH_PATTERN = /[\u{1D6A4}-\u{1D7CD}]/gu;

// Greek math styles: bold, italic, bold-italic, sans-serif bold, sans-serif
// bold-italic. The blocks are 58 code points apart (52 letters plus six
// symbol slots), not 52: a stride of 52 mapped only the bold block correctly
// and let 𝜄𝛾𝜈𝜊𝜌𝜀 (italic) and the sans-serif blocks spell "ignore" past the
// scanner. Within one block offsets 0–24 are the uppercase letters, 25/51 are
// symbols (nabla/partial) and 26–50 the lowercase letters; the letter order
// is NOT the pure 24-letter alphabet — ϴ (theta symbol) sits between Ρ and Σ,
// and ς (final sigma) between ρ and σ — so indexing uses the 25-letter math
// layout and skips non-letter code points.
const GREEK_MATH_STYLES = [0x1d6a8, 0x1d6e2, 0x1d71c, 0x1d756, 0x1d790];
const GREEK_MATH_ALPHABET = "αβγδεζηθικλμνξοπρςστυφχψω";

function foldGreekMath(ch: string): string {
  const code = ch.codePointAt(0) ?? 0;
  for (const base of GREEK_MATH_STYLES) {
    const offset = code - base;
    if (offset >= 0 && offset < 52) {
      // Uppercase half: 0–25 (letters at 0–24); lowercase half: 26–51.
      const idx = offset < 26 ? offset : offset - 26;
      const greek = GREEK_MATH_ALPHABET[idx] ?? "";
      return GREEK_LATIN[greek.toLowerCase()] ?? ch;
    }
  }
  return ch;
}

const GREEK_PLAIN_PATTERN = /[\u{0370}-\u{03FF}]/gu;

function foldGreekPlain(ch: string): string {
  return GREEK_LATIN[ch.toLowerCase()] ?? ch;
}

interface NormalizeStep {
  pattern: RegExp;
  fold: (match: string) => string;
}

/** The folding pipeline in application order. It is defined once so the
 *  offset-preserving `normalizeWithMap` and the plain `normalizeText` can
 *  never drift apart. */
/** Zero-width joiners/marks, bidi controls (LRE/RLE/LRO/RLO/PDF/LRI/RLI/FSI/
 *  PDI), the Arabic letter mark, soft hyphen, Mongolian vowel separator,
 *  combining grapheme joiner and C0 controls. Stripped from the detection
 *  input AND from the persisted output: a bidi override or zero-width run
 *  surviving in a note/DB row/rollout summary spoofs how the memory renders. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: the C0 range and bidi controls are stripped on purpose
// biome-ignore lint/suspicious/noMisleadingCharacterClass: mixed ranges of zero-width/control chars are intentional
const CONTROL_STRIP_PATTERN = /[\u200b-\u200f\u2060-\u206f\ufeff\u202a-\u202e\u061c\u00ad\u180e\u034f\x00-\x08\x0b\x0c\x0e-\x1f]/g;

const NORMALIZE_STEPS: readonly NormalizeStep[] = [
  { pattern: CONTROL_STRIP_PATTERN, fold: () => "" },
  {
    pattern: /[аеіоѕрсухёһјїАЕІОЅРСУХЁНЈЇ’‘“”‑–—…　]/g,
    fold: (c) => HOMOGLYPH_MAP[c] ?? c,
  },
  // fullwidth latin letters/digits/punctuation -> ASCII
  { pattern: /[\uff01-\uff5e]/g, fold: (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0) },
  // mathematical alphanumeric variants ("𝑖𝑔𝑛𝑜𝑟𝑒", "𝐢𝐠𝐧𝐨𝐫𝐞") -> ASCII
  { pattern: MATH_VARIANT_PATTERN, fold: foldMathVariants },
  // Greek (plain and math variants): homoglyph letters fold to Latin so
  // "𝛊𝛾𝜈𝜊𝜌𝜀" cannot spell "ignore" past the scanner.
  { pattern: GREEK_MATH_PATTERN, fold: foldGreekMath },
  { pattern: GREEK_PLAIN_PATTERN, fold: foldGreekPlain },
];

/** Zero-width/bidi-marker/control-character stripping + transliteration of
 *  Cyrillic/fullwidth homoglyphs so that obfuscated injection text
 *  ("ignore prevіous instructions", "ｉｇｎｏｒｅ …") is detected. */
export function normalizeText(text: string): string {
  let out = text;
  for (const step of NORMALIZE_STEPS) {
    out = out.replace(step.pattern, step.fold);
  }
  return out;
}

/** Folded text plus the original-input range that produced each output code
 *  unit. Redaction uses this to replace only the matched span in the RAW text:
 *  normalization is a detection aid and must never rewrite unmatched text. */
interface MappedText {
  text: string;
  starts: number[];
  ends: number[];
}

function normalizeWithMap(input: string): MappedText {
  let text = input;
  let starts = Array.from({ length: input.length }, (_, i) => i);
  let ends = Array.from({ length: input.length }, (_, i) => i + 1);
  for (const step of NORMALIZE_STEPS) {
    const nextText: string[] = [];
    const nextStarts: number[] = [];
    const nextEnds: number[] = [];
    const pattern = step.pattern;
    pattern.lastIndex = 0;
    let cursor = 0;
    for (;;) {
      const match = pattern.exec(text);
      if (match === null) {
        break;
      }
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      // Unchanged run: every output unit keeps its own source range.
      for (let i = cursor; i < match.index; i++) {
        nextText.push(text[i] ?? "");
        nextStarts.push(starts[i] ?? i);
        nextEnds.push(ends[i] ?? i + 1);
      }
      // Folded run: every produced unit maps back to the whole matched span,
      // so a match spanning removed zero-width characters redacts all of it.
      const start = starts[match.index] ?? match.index;
      const end = ends[match.index + match[0].length - 1] ?? match.index + match[0].length;
      const folded = step.fold(match[0]);
      for (let i = 0; i < folded.length; i++) {
        nextText.push(folded[i] ?? "");
        nextStarts.push(start);
        nextEnds.push(end);
      }
      cursor = match.index + match[0].length;
    }
    for (let i = cursor; i < text.length; i++) {
      nextText.push(text[i] ?? "");
      nextStarts.push(starts[i] ?? i);
      nextEnds.push(ends[i] ?? i + 1);
    }
    text = nextText.join("");
    starts = nextStarts;
    ends = nextEnds;
  }
  return { text, starts, ends };
}

export function redactSecrets(text: string): SanitizeResult {
  // Detection runs on the normalized/folded form (homoglyphs, zero-width
  // characters and fullwidth variants must not hide a secret), but the OUTPUT
  // is the raw text with only the matched spans replaced. Returning the
  // normalized text would rewrite every unmatched character (Cyrillic 'е' →
  // Latin 'e', …) and corrupt the note/artifact being persisted.
  //
  // Patterns run independently over the folded text (not over each other's
  // "[REDACTED]" output): a secret named by a later pattern is redacted as one
  // keyword+value span even when an earlier pattern would have replaced only
  // its value. Over-redaction is the accepted failure mode; the raw text
  // outside the matched spans is never touched.
  const mapped = normalizeWithMap(text);
  const normalized = mapped.text;
  // Detection strips controls for look-through; the output must strip them too
  // (a zero-width/bidi run left in a note or DB row spoofs how it renders),
  // while every VISIBLE character stays byte-identical.
  const stripControls = (value: string): string => value.replace(CONTROL_STRIP_PATTERN, "");
  const hits: Array<{ start: number; end: number; replacement: string }> = [];
  const record = (start: number, end: number, privateKey: boolean): void => {
    if (end > start) {
      hits.push({ start, end, replacement: privateKey ? "[REDACTED PRIVATE KEY]" : "[REDACTED]" });
    }
  };
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    for (;;) {
      const match = pattern.exec(normalized);
      if (match === null) {
        break;
      }
      if (match[0].length === 0) {
        pattern.lastIndex += 1;
        continue;
      }
      record(match.index, match.index + match[0].length, match[0].startsWith("-----BEGIN"));
    }
  }
  HIGH_ENTROPY.lastIndex = 0;
  for (;;) {
    const match = HIGH_ENTROPY.exec(normalized);
    if (match === null) {
      break;
    }
    const tok = match[1] ?? "";
    const upper = /[A-Z]/.test(tok);
    const lower = /[a-z]/.test(tok);
    const digit = /\d/.test(tok);
    if ((upper ? 1 : 0) + (lower ? 1 : 0) + (digit ? 1 : 0) >= 3 && shannonEntropy(tok) >= 4.5) {
      record(match.index, match.index + match[0].length, false);
    }
  }
  if (!hits.length) {
    return { text: stripControls(text), redacted: false };
  }
  // Translate normalized offsets back to raw offsets, merge overlaps (a later
  // pattern may match inside an earlier one), then splice the raw text.
  const ranges = hits
    .map((hit) => ({
      start: mapped.starts[hit.start] ?? 0,
      end: mapped.ends[hit.end - 1] ?? text.length,
      replacement: hit.replacement,
    }))
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number; replacement: string }> = [];
  for (const range of ranges) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) {
      last.end = Math.max(last.end, range.end);
      if (range.replacement === "[REDACTED PRIVATE KEY]") {
        last.replacement = range.replacement;
      }
    } else {
      merged.push({ ...range });
    }
  }
  let out = "";
  let cursor = 0;
  for (const range of merged) {
    out += text.slice(cursor, range.start) + range.replacement;
    cursor = range.end;
  }
  out += text.slice(cursor);
  return { text: stripControls(out), redacted: true };
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s*(?:all\s*)?(?:previous|prior|above|earlier)\s*(?:instructions|directions|directives|prompts)/i,
  /disregard\s*(?:all\s*)?(?:previous|prior|above|earlier)\s*(?:instructions|directions|directives|prompts)/i,
  /dismiss\s*(?:all\s*)?(?:previous|prior|above|earlier)\s*(?:instructions|directions|directives|prompts)/i,
  /do\s*not\s*(?:follow|obey)\s*(?:the\s*)?(?:instructions|rules|system\s*prompt)/i,
  /forget\s*(?:all\s*)?(?:previous|prior)\s*(?:instructions|prompts|context)/i,
  /you\s*are\s*now\s*(?:an?\s*)?(?:different|free|unaligned|unfiltered|no\s*longer)/i,
  /you\s*are\s*(?:not\s*|no\s*longer\s*)?(?:bound|restricted|constrained|obligated)/i,
  /over(?:ride|write)\s*(?:your\s*|the\s*)?(?:system\s*prompt|instructions|safety)/i,
  /print\s*(?:all\s*|your\s*)?(?:previous|prior)\s*(?:instructions|prompts|system\s*message)/i,
  /<system>\s*(?:ignore|override)/i,
  /\[\s*(?:system|instruction)\s*\]\s*(?:ignore|override)/i,
  // "reveal/disclose/expose your secrets/system prompt": covers exfiltration
  // requests that do not name files (the read/print patterns below do).
  // The target list also covers common secret phrasing ("API keys", ".env")
  // that memory text uses to ask for credentials without naming a file.
  /(?:reveal|disclose|expose|leak|dump)\s*(?:(?:all|your|the)\s*){0,2}(?:secrets?|secret\s*keys?|api\s*keys?|tokens?|passwords?|credentials?|\.env|environment\s*(?:variables?|vars)|system\s*prompt|instructions?|prompts?)/i,
  /忽略\s*(?:所有|全部)?\s*(?:之前|先前|以上|前面)\s*的?\s*(?:所有|全部)?\s*(?:指令|指示|提示)/,
  /无视\s*(?:所有|全部)?\s*(?:之前|先前|以上|前面)\s*的?\s*(?:所有|全部)?\s*(?:指令|指示|提示)/,
  /(?:忽视|不理会|别管)\s*(?:所有|全部)?\s*(?:之前|先前|以上|前面)?\s*的?\s*(?:所有|全部)?\s*(?:指令|指示|提示|系统提示)/,
  /忘记\s*(?:所有|全部)?\s*(?:之前|先前)\s*的?\s*(?:所有|全部)?\s*(?:指令|提示|上下文)/,
  /不要\s*(?:遵守|遵循)\s*(?:系统)?\s*(?:指令|提示)/,
  /你\s*(?:现在|已经|已)?\s*(?:不受限制|不再受限制|解除限制|无限制|是自由的|不再受限)/,
  /不再\s*(?:受|被)?\s*(?:约束|限制|绑定)/,
  /忽略\s*(?:所有|全部)?\s*(?:之前的)?\s*系统提示/,
  /透露\s*(?:所有|全部)?\s*(?:秘密|密钥|敏感信息|凭据)/,
  /告诉我\s*(?:所有|全部)?\s*(?:秘密|密钥|密码)/,
  // Read/exfiltration verbs targeting credential files. The verb list includes
  // the shell tools memory entries suggest the model use ("grep MEMORY.md")
  // — a memory line saying "grep ~/.ssh/id_rsa" must be flagged too.
  /(?:read|open|access|print|show|copy|grep|cat|find|ls|tail|type|more|less|strings|读取|打开|访问|显示|复制|查找|查看|搜索)[\s\S]{0,80}(?:\.ssh|id\s*rsa|id\s*ed25519|credentials|private\s*key|\.env|私钥|凭据)/i,
  /(?:send|upload|post|transmit|exfiltrat|发送|上传|外传)[\s\S]{0,100}(?:secret|token|password|credential|private\s*key|\.ssh|密钥|密码|凭据|私钥)/i,
];

/** Encoded separator/whitespace forms folded to a space before pattern
 *  matching. `%25` decodes to a literal `%` so double encoding
 *  ("ignore%2520previous%2520instructions") resolves across passes. */
const ENCODE_FOLDS: Record<string, string> = {
  "%20": " ", "%09": " ", "%0a": " ", "%0d": " ", "%2d": " ", "%5f": " ",
  "%25": "%",
  "&#32;": " ", "&#x20;": " ", "&#9;": " ", "&#x9;": " ", "&#45;": " ", "&#x2d;": " ", "&#95;": " ", "&#x5f;": " ",
  "\\u0020": " ", "\\u002d": " ", "\\u005f": " ",
};
const ENCODE_FOLD_RE = new RegExp(Object.keys(ENCODE_FOLDS).join("|"), "gi");

export function scanInjection(text: string): string[] {
  const normalized = normalizeText(text);
  // Percent-encoded separators ("ignore%20previous%20instructions") decode
  // before compaction so the whitespace collapse below can fold them. The
  // hyphen and underscore encodings (%2d / %5f) are decoded too: the
  // hyphen/underscore folding that follows would otherwise miss them, making
  // "ignore%2Dprevious%2Dinstructions" a clean bypass. Decoding iterates to a
  // fixpoint so double encoding and HTML/unicode escapes fold as well.
  let decoded = normalized;
  for (let pass = 0; pass < 4; pass++) {
    const next = decoded.replace(ENCODE_FOLD_RE, (match) => ENCODE_FOLDS[match.toLowerCase()] ?? " ");
    if (next === decoded) {
      break;
    }
    decoded = next;
  }
  // Space-split obfuscation ("忽 略 之 前 的 指 令"): collapse whitespace
  // between letters for matching. Every injection pattern uses \s* between
  // words, so a letter-space-letter collapse never changes which patterns
  // match English text — it only defeats the space-padded variants.
  // Hyphen/underscore folding ("ignore-previous-instructions",
  // "ignore_previous_instructions") closes the remaining separator gap; the
  // keyword-anchored patterns make false positives rare enough to accept.
  // Folding to a space (not deleting) keeps underscore-bearing file targets
  // ("id_ed25519") separable, which their patterns express as \s*.
  const compacted = decoded
    .replace(/(?<=\p{L})\s+(?=\p{L})/gu, "")
    .replace(/(?<=\p{L})[-_](?=\p{L})/gu, " ")
    // CJK punctuation-split obfuscation ("忽视，之前的指令" / "别管。之前的
    // 所有指令"): collapse the common Chinese separators between letters.
    // normalizeText has already turned fullwidth commas into ASCII ones, so
    // both forms are folded. CJK periods are folded too: sentence-boundary
    // obfuscation ("别管。之前…") is a real pattern, and the keyword-anchored
    // patterns make cross-sentence false positives rare enough to accept.
    // ASCII periods are left alone (English matching semantics).
    .replace(/(?<=\p{L})[,;，。、；](?=\p{L})/gu, "");
  const flags: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(compacted)) {
      flags.push(pattern.source.slice(0, 60));
    }
  }
  return flags;
}

export interface InjectionVerdict {
  safe: boolean;
  flags: string[];
}

export function sanitizeForInjection(text: string): InjectionVerdict {
  const flags = scanInjection(text);
  return { safe: flags.length === 0, flags };
}

/** Line-level REPAIR for extraction replies (never for injection): drop the
 *  lines that trip the scanner and keep the rest, so one matched sentence —
 *  e.g. a summary line containing "send … token", ordinary prose in a session
 *  about an auth flow — cannot dead-letter a whole rollout. Callers must
 *  re-scan the repaired text and reject it when it is still unsafe or empty:
 *  whole-reply promptware must keep failing (and burning retries). */
export function repairInjectionLines(text: string): { text: string; removed: number } {
  const kept: string[] = [];
  let removed = 0;
  for (const line of text.split("\n")) {
    if (line.trim() !== "" && scanInjection(line).length > 0) {
      removed += 1;
      continue;
    }
    kept.push(line);
  }
  return { text: kept.join("\n"), removed };
}
