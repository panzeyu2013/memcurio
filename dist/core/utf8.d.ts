/** Byte-exact UTF-8 helpers behind every size cap in the store.
 *
 *  `Buffer.byteLength` cannot back a byte contract: bun (the test runtime)
 *  reports 2 bytes for a lone surrogate where the encoder — and node — write
 *  the 3-byte U+FFFD, so a cap measured with it can be exceeded by 50% on
 *  adversarial model output. These helpers reproduce the encoder rule
 *  (a surrogate pair is 4 bytes, any lone surrogate is 3) without allocating,
 *  so a cap measured here is the number of bytes actually written.
 */
/** Encoded length in bytes. Stops counting once `stopAfter` is exceeded, so a
 *  probe of an oversized prefix costs at most the cap, not the prefix. */
export declare function utf8ByteLength(text: string, stopAfter?: number): number;
/** Longest prefix of `text` within `maxBytes`, cut on a code-point boundary.
 *  A run of high surrogates left dangling by the cut is dropped rather than
 *  written as U+FFFD; everything before that run is kept byte-exactly, so one
 *  more code unit (or the dropped run) would exceed the cap. The predicate is
 *  monotone in the prefix length (appending a code unit adds 1-3 bytes, or
 *  turns a lone high surrogate into a pair for a net +1), which is what makes
 *  the bisection valid. */
export declare function clipUtf8(text: string, maxBytes: number): string;
