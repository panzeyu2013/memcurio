import { homedir } from "node:os";
import { join } from "node:path";
import { chmodSync, mkdirSync, readdirSync } from "node:fs";

export function rootDir(): string {
  return process.env.MEMCORE_ROOT ?? join(homedir(), ".memcore");
}

export function ensureLayout(root: string): void {
  for (const sub of ["memory", "state"]) {
    const d = join(root, sub);
    mkdirSync(d, { recursive: true });
    try {
      chmodSync(d, 0o700);
    } catch {
      void 0;
    }
  }
  try {
    chmodSync(root, 0o700);
  } catch {
    void 0;
  }
}

const NS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/;

export function assertValidNs(ns: string): string {
  if (!NS_PATTERN.test(ns) || ns === "." || ns === ".." || ns.endsWith(".")) {
    throw new Error(`invalid namespace: ${JSON.stringify(ns)} (must match [A-Za-z0-9][A-Za-z0-9_.-]{0,39})`);
  }
  return ns;
}

export function nsDir(root: string, ns: string): string {
  assertValidNs(ns);
  const d = join(root, "memory", ns);
  mkdirSync(d, { recursive: true });
  try {
    chmodSync(d, 0o700);
  } catch {
    void 0;
  }
  return d;
}

export function memoryRoot(root: string): string {
  return join(root, "memory");
}

export function indexDb(root: string): string {
  return join(root, "index.sqlite");
}

export function configPath(root: string): string {
  return join(root, "config.json");
}

export function txnLog(root: string): string {
  return join(root, "state", "transactions.jsonl");
}

export function namespaces(root: string): string[] {
  const mem = join(root, "memory");
  try {
    return readdirSync(mem, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

export function namespaceFor(workdir: string): string {
  if (!workdir) {
    return "default";
  }
  const name = workdir.split("/").filter(Boolean).at(-1) ?? workdir;
  const slug = name.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "");
  const ns = slug.slice(0, 40) || "default";
  if (ns === "." || ns === ".." || ns.startsWith(".") || ns.endsWith(".")) {
    return "default";
  }
  return ns;
}
