import type { Index } from "./db.js";
import type { Entry, Kind } from "./mdStore.js";

export interface StaticSelectParams {
  ns?: string;
  kinds?: Kind[];
  topN: number;
  offset?: number;
  includeArchived?: boolean;
}

export function selectStatic(index: Index, params: StaticSelectParams): Entry[] {
  return index.top({
    ns: params.ns,
    kinds: params.kinds,
    limit: params.topN,
    offset: params.offset,
    includeArchived: params.includeArchived,
  });
}
