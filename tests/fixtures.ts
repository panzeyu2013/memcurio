/** Snapshot the given env vars so a test can mutate them safely. */
export function saveEnv(vars: readonly string[]): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of vars) {
    saved[k] = process.env[k];
  }
  return saved;
}

/** Restore env vars to a snapshot from saveEnv (undefined deletes the key). */
export function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = v;
    }
  }
}
