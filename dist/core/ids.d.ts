/** Existing stores use 8-hex IDs; new writes use 128-bit IDs. */
export declare const ENTRY_ID_RE: RegExp;
export declare function newEntryId(): string;
/** Same format as newEntryId (UUIDv4 without dashes). */
export declare function newNoteId(): string;
export declare function derivedEntryId(seed: string, reserved: Set<string>): string;
