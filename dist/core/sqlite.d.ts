export interface SqlRow {
    [key: string]: unknown;
}
export interface DbDriver {
    readonly name: string;
    run(sql: string, params?: unknown[]): void;
    get<T = SqlRow>(sql: string, params?: unknown[]): T | undefined;
    all<T = SqlRow>(sql: string, params?: unknown[]): T[];
    exec(sql: string): void;
    close(): void;
}
/** SQLite driver selection is environment-driven, not preference-driven:
 *  - bun runtimes (the bun test suite and local tooling) MUST use
 *    `bun:sqlite` — bun cannot resolve `node:sqlite` (verified on bun
 *    1.3.14: import fails at resolution time).
 *  - node runtimes (node >= 22.13) use `node:sqlite` without a flag (the
 *    22.5–22.12 window required --experimental-sqlite). No native compile
 *    step either way.
 */
/** Synchronous counterpart for callers that cannot await (the store lifecycle
 *  integrity check runs inside a synchronous restore). Uses require() because
 *  the runtime-specific module is chosen dynamically. */
export declare function openDbSync(path: string, readonly?: boolean): DbDriver;
export declare function openDb(path: string): Promise<DbDriver>;
