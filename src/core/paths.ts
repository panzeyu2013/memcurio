import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { chmodSync, lstatSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { createHash } from "node:crypto";

export function rootDir(): string {
  const env = process.env.MEMCORE_ROOT;
  return env && env.trim() ? env.trim() : join(homedir(), ".memcore");
}

export function ensureLayout(root: string): void {
  for (const sub of ["memory", "state"]) {
    const d = join(root, sub);
    mkdirSync(d, { recursive: true, mode: 0o700 });
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
  sweepStaleTmpFiles(root);
}

/** Remove `.tmp-*` files left behind by a process killed between write and
 *  rename (they are invisible to readAll and would accumulate forever). Files
 *  younger than SWEEP_GRACE_MS are left alone — a concurrent process may be
 *  mid-`atomicWrite` with its temp file still in place, and unlinking it would
 *  make the writer's rename fail and roll back its batch. */
const SWEEP_GRACE_MS = 30_000;
function sweepStaleTmpFiles(root: string): void {
  const TMP_RE = /^\.tmp-\d+-[0-9a-f]{16}\./;
  const visited = new Set<string>();
  const sweep = (dir: string, depth: number): void => {
    if (depth > 2 || visited.has(dir)) {
      return;
    }
    visited.add(dir);
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const p = join(dir, name);
      try {
        // lstat: never follow symlinks, so a hand-placed `.tmp-*` symlink
        // cannot redirect the sweep (or the recursion) outside the root.
        const st = lstatSync(p);
        if (st.isDirectory()) {
          sweep(p, depth + 1);
        } else if (st.isFile() && TMP_RE.test(name) && Date.now() - st.mtimeMs > SWEEP_GRACE_MS) {
          unlinkSync(p);
        }
      } catch {
        void 0;
      }
    }
  };
  sweep(join(root, "memory"), 0);
  sweep(join(root, "state"), 0);
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
  mkdirSync(d, { recursive: true, mode: 0o700 });
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

/** Basename of a namespace directory (cross-platform, unlike manual "/"). */
export function nsName(dir: string): string {
  return basename(dir);
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
  const name = basename(resolved);
  const slug = name.replace(/[^A-Za-z0-9_.-]/g, "-").replace(/^-+|-+$/g, "").slice(0, 24);
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 12);
  const ns = `${slug || "ns"}-${hash}`;
  if (ns === "." || ns === ".." || ns.startsWith(".") || ns.endsWith(".")) {
    return "default";
  }
  return ns;
}
