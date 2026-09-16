/** Retrieval-query shaping for the dynamic memory injection.
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
/** Terms that carry no retrieval signal. Kept deliberately short: matching is
 *  substring-based, so an over-broad list would eat real keywords. */
const STOP_WORDS = new Set([
    "the", "a", "an", "and", "or", "but", "if", "then", "than", "that", "this", "these",
    "those", "is", "are", "was", "were", "be", "been", "being", "do", "does", "did", "done",
    "have", "has", "had", "having", "will", "would", "should", "could", "can", "may", "might",
    "must", "i", "you", "he", "she", "it", "we", "they", "me", "him", "her", "us", "them",
    "my", "your", "his", "its", "our", "their", "of", "in", "on", "at", "to", "for", "with",
    "by", "from", "as", "about", "into", "over", "after", "before", "between", "up", "down",
    "out", "off", "again", "just", "also", "not", "no", "yes", "please", "thanks", "thank",
    "ok", "okay", "let", "get", "got", "make", "made", "use", "using", "used", "see", "need",
    "want", "know", "think", "like", "well", "now", "here", "there", "when", "where", "which",
    "who", "how", "why", "what", "any", "all", "some", "more", "most", "other", "only", "very",
    "帮我", "我的", "这个", "那个", "然后", "但是", "因为", "所以", "如果", "可以", "应该",
    "需要", "现在", "已经", "还是", "就是", "以及", "并且", "什么", "怎么", "为什么", "一下",
    "一个", "我们", "你们", "他们", "请问", "麻烦", "谢谢",
]);
/** Strip machine noise from one text block: fenced and inline code, URLs,
 *  filesystem paths, and markup punctuation. */
function stripNoise(text) {
    return text
        .replace(/\x60\x60\x60[\s\S]*?\x60\x60\x60/g, " ")
        .replace(/\x60[^\x60]*\x60/g, " ")
        .replace(/https?:\/\/\S+/gi, " ")
        .replace(/(?:[A-Za-z]:)?(?:\/[\w.-]+){2,}/g, " ")
        .replace(/[#>*_|~[\](){}]+/g, " ")
        .replace(/\s+/g, " ");
}
/** Build the retrieval query from candidate text blocks, newest first (pass the
 *  most recent message at index 0). Returns "" when nothing searchable is left,
 *  in which case the caller must not run a search at all. */
export function retrievalQuery(texts, maxTerms = 32) {
    const terms = [];
    const seen = new Set();
    for (const raw of texts.slice(0, 2)) {
        for (const token of stripNoise(raw).split(" ")) {
            const word = token.trim().toLowerCase();
            if (word.length < 2 || STOP_WORDS.has(word) || seen.has(word)) {
                continue;
            }
            seen.add(word);
            terms.push(word);
            if (terms.length >= maxTerms) {
                return terms.join(" ");
            }
        }
    }
    return terms.join(" ");
}
