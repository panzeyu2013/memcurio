import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { createHash } from "node:crypto";

export function rootDir(): string {
  const env = process.env.MEMCORE_ROOT;
  return env && env.trim() ? env.trim() : join(homedir(), ".memcore");
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
  // Basename-only slugs collide across parents (/work/a/proj vs /work/b/proj).
  // Use a readable basename slug + a short hash of the full resolved path so
  // different projects never silently share a namespace.
  const resolved = resolve(workdir);
  const name = resolved.split("/").filter(Boolean).at(-1) ?? resolved;
  const slug = name.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 12);
  const ns = `${slug || "ns"}-${hash}`;
  if (ns === "." || ns === ".." || ns.startsWith(".") || ns.endsWith(".")) {
    return "default";
  }
  return ns;
}
