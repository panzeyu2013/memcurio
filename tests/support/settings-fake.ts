/**
 * Host-faithful write semantics shared by the settings tests.
 *
 * The real `@deepseek-ai/dsh-settings` cannot delete a value supplied by a
 * lower configuration layer: an `unset` of such a field is rewritten into an
 * equal `set` of the inherited value (README "Field-level resets restore
 * inherited values"; `lib/index.js` reduces the path op against the inherited
 * config before applying it), and the revision only advances when the raw user
 * layer really changed. A fake that deletes the key or bumps the revision per
 * call makes reset/undo assertions disagree with the shipped Host — two such
 * assertions shipped in the first default-settings cut.
 *
 * Test-only module; never imported by shipped code.
 */
import type { ConfigFormSnapshotLike, SettingsPathOp } from "../../client/settings/controller.js";

export type UserLayer = Record<string, unknown>;

function asLayer(value: unknown): UserLayer {
  return value !== null && typeof value === "object" ? (value as UserLayer) : {};
}

/** Reduce one plan against the user layer the way the Host does. */
export function applyHostOps(
  user: UserLayer | undefined,
  base: unknown,
  ops: readonly SettingsPathOp[],
): UserLayer {
  const inherited = asLayer(base);
  const next: UserLayer = { ...(user ?? {}) };
  for (const op of ops) {
    const field = op.path[0] ?? "";
    if (op.op === "set") {
      next[field] = op.value;
      continue;
    }
    if (Object.hasOwn(inherited, field)) next[field] = inherited[field];
    else delete next[field];
  }
  return next;
}

/** Same keys and same scalar values (every settings field is a scalar). */
export function sameLayer(left: UserLayer | undefined, right: UserLayer | undefined): boolean {
  const a = left ?? {};
  const b = right ?? {};
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((key) => Object.hasOwn(b, key) && Object.is(a[key], b[key]));
}

/** Publish one accepted write: the resolved value follows the user layer and
 *  the revision advances only when that layer changed. */
export function foldSnapshot<T>(
  snapshot: ConfigFormSnapshotLike<T>,
  ops: readonly SettingsPathOp[],
): ConfigFormSnapshotLike<T> {
  const user = applyHostOps(asLayer(snapshot.user), snapshot.base, ops);
  const base = asLayer(snapshot.base);
  const changed = !sameLayer(asLayer(snapshot.user), user);
  return {
    ...snapshot,
    user,
    value: { ...base, ...user } as T,
    revision: (snapshot.revision ?? 0) + (changed ? 1 : 0),
  };
}
