/** Retrieval-query shaping for a dynamic memory search.
 *
 * Reserved API (v2.1): the plugin no longer performs per-turn recall
 * injection, so only host integrations and tests call this shaper; the
 * workbench simulator searches with the raw user query. Kept because the
 * ranking it feeds (search.ts) is still the read path the model drives.
 *
 * The plugin used to hand the raw step text (user turns, tool output, injected
 * context, markdown) to the lexical search: every word in that dump became a
 * search term, so hits were dominated by noise. This module reduces a step to
 * the terms a human would actually search for — the newest user text, freed of
 * code, URLs, filesystem paths and markup, minus stop words, capped — so the
 * ranking in {@link ./search.ts | search.ts} works on signal.
 *
 * Pure and store-independent (unit-tested in tests/query.test.ts).
 */
/** Build the retrieval query from candidate text blocks, newest first (pass the
 *  most recent message at index 0). Returns "" when nothing searchable is left,
 *  in which case the caller must not run a search at all. */
export declare function retrievalQuery(texts: readonly string[], maxTerms?: number): string;
