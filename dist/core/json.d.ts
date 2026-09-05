/** Slice the outermost JSON object out of an LLM reply and parse it. Throws
 *  when no JSON object is present. Prose containing extra "{" / "}" after the
 *  object is tolerated by trying each candidate end brace in turn; if the
 *  earliest "{" start fails every candidate end (e.g. prose before the object
 *  contains its own braces), later "{" starts are tried. Error messages are
 *  redacted: LLM output can echo secrets from the prompt. */
export declare function extractJsonObject(text: string): unknown;
