/**
 * Host-contract tests for the settings fakes.
 *
 * The client settings suites assert through `FakeSettingsPort`, so a fake that
 * drifts from the shipped Host silently rewrites what those suites mean. The
 * two rules pinned here are the ones the shipped `@deepseek-ai/dsh-settings`
 * `SettingsForms.mutate` implements (`node_modules/@deepseek-ai/dsh-settings/lib/index.js`):
 * an unset of a value supplied by a lower layer becomes a `set` of the
 * inherited value, and the revision only advances when the raw user layer
 * actually changed.
 */
import { describe, expect, test } from "bun:test";

import type { ConfigFormSnapshotLike } from "../client/settings/controller.js";
import { applyHostOps, foldSnapshot } from "./support/settings-fake.js";

interface View {
  scope: string;
  registerTools: boolean;
  injectContext?: boolean;
  injectBudgetTokens?: number;
}

const BASE: View = { scope: "workspace", registerTools: true };

function snapshot(user: Record<string, unknown>, revision = 3): ConfigFormSnapshotLike<View> {
  return {
    status: "ready",
    value: { ...BASE, ...user } as View,
    base: { ...BASE },
    user,
    revision,
    writable: true,
  };
}

describe("settings fake reducer", () => {
  test("a write that changes nothing leaves the revision untouched", () => {
    // SF1 in the merge review: an unconditional bump stayed invisible because
    // no case ever wrote an unchanged value.
    const before = snapshot({ scope: "global" });
    const after = foldSnapshot(before, [{ op: "set", path: ["scope"], value: "global" }]);
    expect(after.revision).toBe(before.revision);
    expect(after.user).toEqual(before.user);
  });

  test("a real change advances the revision by exactly one", () => {
    const before = snapshot({ scope: "global" });
    const after = foldSnapshot(before, [{ op: "set", path: ["scope"], value: "workspace" }]);
    expect(after.revision).toBe(4);
    expect(after.user).toEqual({ scope: "workspace" });
  });

  test("unsetting an inherited field rewrites it to the inherited value", () => {
    // The Host cannot delete a value supplied by a lower configuration layer;
    // a fake that deletes the key makes reset/undo assertions disagree with it
    // (SF2 in the merge review).
    const next = applyHostOps(
      { scope: "global", registerTools: false },
      { ...BASE },
      [{ op: "unset", path: ["registerTools"] }],
    );
    expect(next).toEqual({ scope: "global", registerTools: true });
  });

  test("unsetting a field only the user layer supplies deletes it", () => {
    const next = applyHostOps({ injectBudgetTokens: 900 }, { ...BASE }, [
      { op: "unset", path: ["injectBudgetTokens"] },
    ]);
    expect(next).toEqual({});
    expect(Object.hasOwn(next, "injectBudgetTokens")).toBe(false);
  });

  test("the folded view resolves user over base", () => {
    const after = foldSnapshot(snapshot({}), [{ op: "set", path: ["injectContext"], value: false }]);
    expect(after.value).toEqual({ ...BASE, injectContext: false });
    expect(after.base).toEqual({ ...BASE });
  });
});
