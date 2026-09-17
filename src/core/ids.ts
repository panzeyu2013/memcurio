import { createHash, randomUUID } from "node:crypto";

/** Existing stores use 8-hex IDs; new writes use 128-bit IDs. */
export const ENTRY_ID_RE = /^[0-9a-f]{8}(?:[0-9a-f]{24})?$/;

export function newEntryId(): string {
  return randomUUID().replaceAll("-", "");
}


export function derivedEntryId(seed: string, reserved: Set<string>): string {
  for (let salt = 0; ; salt += 1) {
    const id = createHash("sha256").update(`${seed}|${salt}`).digest("hex").slice(0, 32);
    if (!reserved.has(id)) {
      reserved.add(id);
      return id;
    }
  }
}
