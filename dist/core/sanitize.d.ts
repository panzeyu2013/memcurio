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
