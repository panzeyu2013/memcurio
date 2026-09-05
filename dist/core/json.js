import { redactSecrets } from "./sanitize.js";
/** Slice the outermost JSON object out of an LLM reply and parse it. Throws
 *  when no JSON object is present. Prose containing extra "{" / "}" after the
 *  object is tolerated by trying each candidate end brace in turn; if the
 *  earliest "{" start fails every candidate end (e.g. prose before the object
 *  contains its own braces), later "{" starts are tried. Error messages are
 *  redacted: LLM output can echo secrets from the prompt. */
export function extractJsonObject(text) {
    const starts = [];
    for (let i = text.indexOf("{"); i >= 0 && starts.length < 5; i = text.indexOf("{", i + 1)) {
        starts.push(i);
    }
    const preview = () => redactSecrets(text.slice(0, 120)).text;
    if (starts.length === 0) {
        throw new Error(`no JSON object in LLM output: ${preview()}`);
    }
    for (const start of starts) {
        let end = text.lastIndexOf("}");
        let attempts = 0;
        while (end > start && attempts < 20) {
            attempts += 1;
            try {
                return JSON.parse(text.slice(start, end + 1));
            }
            catch {
                end = text.lastIndexOf("}", end - 1);
            }
        }
    }
    throw new Error(`no JSON object in LLM output: ${preview()}`);
}
