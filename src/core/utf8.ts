/** Byte-exact UTF-8 helpers behind every size cap in the store.
 *
 *  `Buffer.byteLength` cannot back a byte contract: bun (the test runtime)
 *  reports 2 bytes for a lone surrogate where the encoder — and node — write
 *  the 3-byte U+FFFD, so a cap measured with it can be exceeded by 50% on
 *  adversarial model output. These helpers reproduce the encoder rule
 *  (a surrogate pair is 4 bytes, any lone surrogate is 3) without allocating,
 *  so a cap measured here is the number of bytes actually written.
 */

const HIGH_SURROGATE_MIN = 0xd800;
const HIGH_SURROGATE_MAX = 0xdbff;
const LOW_SURROGATE_MIN = 0xdc00;
const LOW_SURROGATE_MAX = 0xdfff;

const isHighSurrogate = (code: number): boolean => code >= HIGH_SURROGATE_MIN && code <= HIGH_SURROGATE_MAX;
const isLowSurrogate = (code: number): boolean => code >= LOW_SURROGATE_MIN && code <= LOW_SURROGATE_MAX;

/** Encoded length in bytes. Stops counting once `stopAfter` is exceeded, so a
 *  probe of an oversized prefix costs at most the cap, not the prefix. */
export function utf8ByteLength(text: string, stopAfter = Number.POSITIVE_INFINITY): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (isHighSurrogate(code) && isLowSurrogate(text.charCodeAt(i + 1))) {
      bytes += 4;
      i += 1;
    } else bytes += 3;
    if (bytes > stopAfter) return bytes;
  }
  return bytes;
}

/** Longest prefix of `text` within `maxBytes`, cut on a code-point boundary.
 *  A run of high surrogates left dangling by the cut is dropped rather than
 *  written as U+FFFD; everything before that run is kept byte-exactly, so one
 *  more code unit (or the dropped run) would exceed the cap. The predicate is
 *  monotone in the prefix length (appending a code unit adds 1-3 bytes, or
 *  turns a lone high surrogate into a pair for a net +1), which is what makes
 *  the bisection valid. */
export function clipUtf8(text: string, maxBytes: number): string {
  if (utf8ByteLength(text, maxBytes) <= maxBytes) {
    return text;
  }
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (utf8ByteLength(text.slice(0, mid), maxBytes) <= maxBytes) lo = mid;
    else hi = mid - 1;
  }
  let end = lo;
  while (end > 0 && isHighSurrogate(text.charCodeAt(end - 1))) end -= 1;
  return text.slice(0, end);
}
