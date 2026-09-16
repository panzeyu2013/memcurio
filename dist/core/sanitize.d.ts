export interface SanitizeResult {
    text: string;
    redacted: boolean;
}
/** Zero-width/bidi-marker/control-character stripping + transliteration of
 *  Cyrillic/fullwidth homoglyphs so that obfuscated injection text
 *  ("ignore prevіous instructions", "ｉｇｎｏｒｅ …") is detected. */
export declare function normalizeText(text: string): string;
export declare function redactSecrets(text: string): SanitizeResult;
export declare function scanInjection(text: string): string[];
export interface InjectionVerdict {
    safe: boolean;
    flags: string[];
}
export declare function sanitizeForInjection(text: string): InjectionVerdict;
/** Line-level REPAIR for extraction replies (never for injection): drop the
 *  lines that trip the scanner and keep the rest, so one matched sentence —
 *  e.g. a summary line containing "send … token", ordinary prose in a session
 *  about an auth flow — cannot dead-letter a whole rollout. Callers must
 *  re-scan the repaired text and reject it when it is still unsafe or empty:
 *  whole-reply promptware must keep failing (and burning retries). */
export declare function repairInjectionLines(text: string): {
    text: string;
    removed: number;
};
