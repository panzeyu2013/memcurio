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
export declare function extractJsonObject(text: string): unknown;
