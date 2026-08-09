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

interface BunDatabase {
  run(sql: string, ...params: unknown[]): unknown;
  query(sql: string): { get(...params: unknown[]): unknown; all(...params: unknown[]): unknown[] };
  exec(sql: string): unknown;
  close(): void;
}

interface NodeDatabase {
  prepare(sql: string): {
    run(...params: unknown[]): unknown;
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  exec(sql: string): unknown;
  close(): void;
}

class BunDriver implements DbDriver {
  readonly name = "bun:sqlite";
  private db: BunDatabase;

  constructor(db: BunDatabase) {
    this.db = db;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 20000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA journal_size_limit = 67108864");
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, ...params);
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.query(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.query(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

class NodeDriver implements DbDriver {
  readonly name = "node:sqlite";
  private db: NodeDatabase;

  constructor(db: NodeDatabase) {
    this.db = db;
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA busy_timeout = 20000");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA journal_size_limit = 67108864");
  }

  run(sql: string, params: unknown[] = []): void {
    this.db.prepare(sql).run(...params);
  }

  get<T>(sql: string, params: unknown[] = []): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, params: unknown[] = []): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}

export async function openDb(path: string): Promise<DbDriver> {
  let bunModule: { Database: new (path: string) => BunDatabase } | undefined;
  try {
    bunModule = (await import("bun:sqlite")) as { Database: new (path: string) => BunDatabase };
  } catch {
    bunModule = undefined;
  }
  if (bunModule) {
    return new BunDriver(new bunModule.Database(path));
  }
  let nodeModule: { DatabaseSync: new (path: string) => NodeDatabase } | undefined;
  try {
    nodeModule = (await import("node:sqlite")) as { DatabaseSync: new (path: string) => NodeDatabase };
  } catch {
    nodeModule = undefined;
  }
  if (nodeModule) {
    return new NodeDriver(new nodeModule.DatabaseSync(path));
  }
  throw new Error(
    "no sqlite driver available: need bun:sqlite (bun) or node:sqlite (node >= 23.4)",
  );
}
