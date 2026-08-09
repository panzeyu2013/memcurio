import type { Kind } from "./mdStore.js";
import type { Hit } from "./retriever.js";
import { getRetriever } from "./retriever.js";
import type { Index } from "./db.js";
import { sanitizeForInjection } from "./sanitize.js";

export interface SafeSearchResult {
  hits: Hit[];
  blocked: number;
}

export function safeSearch(
  index: Index,
  params: { query: string; topK: number; ns?: string; kinds?: Kind[] },
  opts: { onError?: (err: unknown) => void; onBlocked?: (hit: Hit, flag: string) => void } = {},
): SafeSearchResult {
  const retriever = getRetriever(index, opts.onError);
  const hits: Hit[] = [];
  let blocked = 0;
  // Fetch a generous window per round-trip: a full re-sort happens per page,
  // so fewer, bigger pages beat many small ones when promptware hits are
  // common.
  const pageSize = Math.max(params.topK * 4, 64);
  for (let offset = 0; hits.length < params.topK; offset += pageSize) {
    const page = retriever.search({ ...params, topK: pageSize, offset });
    for (const hit of page) {
      const verdict = sanitizeForInjection(hit.content);
      if (verdict.safe) {
        hits.push(hit);
        if (hits.length === params.topK) {
          break;
        }
      } else {
        blocked += 1;
        opts.onBlocked?.(hit, verdict.flags[0] ?? "blocked");
      }
    }
    if (page.length < pageSize) {
      break;
    }
  }
  return { hits, blocked };
}
