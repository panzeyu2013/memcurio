export interface SanitizeResult {
  text: string;
  redacted: boolean;
}

const SECRET_PATTERNS: RegExp[] = [
  /(?<![A-Za-z0-9])(?:sk|pk|api[_-]?key|apikey|secret|token|password|passwd|bearer)[-_. ]*[=:]\s*["']?[\p{L}\p{N}_\-./]{12,}["']?/giu,
  /sk-[\p{L}\p{N}_\-]{16,}/gu,
  /(?:sk|rk)_(?:live|test)_[\p{L}\p{N}]{16,}/gu,
  /AKIA[0-9A-Z]{16}\b/g,
  /gh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /github_pat_[A-Za-z0-9_]{20,}\b/g,
  /AIza[0-9A-Za-z_\-]{30,}\b/g,
  /(?<![A-Za-z0-9])(?:Bearer|bearer|BEARER)\s+[\p{L}\p{N}._\-]{20,}/gu,
  /(?<![A-Za-z0-9])-----BEGIN (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |OPENSSH |EC |DSA |PGP )?PRIVATE KEY-----/g,
  /(?<![A-Za-z0-9])(?:api[_-]?key|apikey|secret|token|password|passwd|bearer)\s+["']?[\p{L}\p{N}_\-./]{16,}["']?/giu,
];

const HOMOGLYPH_MAP: Record<string, string> = {
  а: "a", е: "e", і: "i", о: "o", ѕ: "s", р: "p", с: "c", у: "y", х: "x", ё: "e", һ: "h", ј: "j", ї: "i",
  А: "A", Е: "E", І: "I", О: "O", Ѕ: "S", Р: "P", С: "C", У: "Y", Х: "X", Ё: "E", Н: "H", Ј: "J", Ї: "I",
  "’": "'", "‘": "'", "“": '"', "”": '"', "‑": "-", "–": "-", "—": "-", "…": "...", "　": " ",
};

/** Zero-width stripping + transliteration of Cyrillic/fullwidth homoglyphs so that
 *  obfuscated injection text ("ignore prevіous instructions") is detected. */
export function normalizeText(text: string): string {
  return text
    .replace(/[\u200b-\u200f\u2060-\u206f\ufeff]/g, "")
    .replace(/[аеіоѕрсухёһјїАЕІОЅРСУХЁНЈЇ’‘“”‑–—…　]/g, (c) => HOMOGLYPH_MAP[c] ?? c);
}

export function redactSecrets(text: string): SanitizeResult {
  let redacted = false;
  let out = normalizeText(text);
  for (const pattern of SECRET_PATTERNS) {
    const next = out.replace(pattern, (m) => {
      redacted = true;
      return m.startsWith("-----BEGIN") ? "[REDACTED PRIVATE KEY]" : "[REDACTED]";
    });
    out = next;
  }
  return { text: out, redacted };
}

const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s*(?:all\s*)?(?:previous|prior|above|earlier)\s*(?:instructions|directions|prompts)/i,
  /disregard\s*(?:all\s*)?(?:previous|prior|above|earlier)\s*(?:instructions|directions|prompts)/i,
  /do\s*not\s*(?:follow|obey)\s*(?:the\s*)?(?:instructions|rules|system\s*prompt)/i,
  /forget\s*(?:all\s*)?(?:previous|prior)\s*(?:instructions|prompts|context)/i,
  /you\s*are\s*now\s*(?:an?\s*)?(?:different|free|unaligned|unfiltered|no\s*longer)/i,
  /you\s*are\s*(?:not\s*|no\s*longer\s*)?(?:bound|restricted|constrained|obligated)/i,
  /over(?:ride|write)\s*(?:your\s*|the\s*)?(?:system\s*prompt|instructions|safety)/i,
  /print\s*(?:all\s*|your\s*)?(?:previous|prior)\s*(?:instructions|prompts|system\s*message)/i,
  /<system>\s*(?:ignore|override)/i,
  /\[\s*(?:system|instruction)\s*\]\s*(?:ignore|override)/i,
  /忽略\s*(?:所有|全部)?\s*(?:之前|先前|以上|前面)\s*的?\s*(?:所有|全部)?\s*(?:指令|指示|提示)/,
  /无视\s*(?:所有|全部)?\s*(?:之前|先前|以上|前面)\s*的?\s*(?:所有|全部)?\s*(?:指令|指示|提示)/,
  /忘记\s*(?:所有|全部)?\s*(?:之前|先前)\s*的?\s*(?:所有|全部)?\s*(?:指令|提示|上下文)/,
  /不要\s*(?:遵守|遵循)\s*(?:系统)?\s*(?:指令|提示)/,
  /你\s*(?:现在|已经|已)?\s*(?:不受限制|不再受限制|解除限制|无限制|是自由的|不再受限)/,
  /不再\s*(?:受|被)?\s*(?:约束|限制|绑定)/,
  /忽略\s*(?:所有|全部)?\s*(?:之前的)?\s*系统提示/,
  /透露\s*(?:所有|全部)?\s*(?:秘密|密钥|敏感信息|凭据)/,
  /告诉我\s*(?:所有|全部)?\s*(?:秘密|密钥|密码)/,
  /(?:read|open|access|print|show|copy|读取|打开|访问|显示|复制)[\s\S]{0,80}(?:\.ssh|id_rsa|id_ed25519|credentials|private\s*key|私钥|凭据)/i,
  /(?:send|upload|post|transmit|exfiltrat|发送|上传|外传)[\s\S]{0,100}(?:secret|token|password|credential|private\s*key|\.ssh|密钥|密码|凭据|私钥)/i,
];

export function scanInjection(text: string): string[] {
  const normalized = normalizeText(text);
  const flags: string[] = [];
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(normalized)) {
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
