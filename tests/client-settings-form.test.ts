/**
 * Staged-form model tests: drafts, validation, atomic plan, revision fence,
 * draft retention and the hidden lifecycle boundary. No React/jsdom here.
 */
import { describe, expect, test } from "bun:test";

import {
  MemcurioSettingsController,
  type ConfigFormPort,
  type ConfigFormSnapshotLike,
  type MemcurioSettingsView,
  type SettingsPathOp,
} from "../client/settings/controller.js";
import { SettingsFormModel } from "../client/settings/draft.js";
import { foldSnapshot } from "./support/settings-fake.js";

const BASE: MemcurioSettingsView = { scope: "workspace", injectContext: true, registerTools: true };

class DraftScope implements ConfigFormPort<MemcurioSettingsView> {
  snapshot: ConfigFormSnapshotLike<MemcurioSettingsView> = {
    status: "ready",
    value: BASE,
    base: BASE,
    user: undefined,
    revision: 1,
    writable: true,
  };
  readonly mutations: Array<{ ops: readonly SettingsPathOp[]; expectedRevision?: number }> = [];
  /** The next write never settles, like a hung settings RPC. */
  hangNext = false;
  /** The next write rejects, like a dead transport. */
  rejectNext = false;
  /** The next mutation lands but answers false (a late read-back refusal). */
  landButRefuse = false;
  private readonly listeners = new Set<() => void>();

  getSnapshot(): ConfigFormSnapshotLike<MemcurioSettingsView> {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(): void {
    for (const listener of this.listeners) listener();
  }

  /** One accepted write: the snapshot folds through the Host's reducer. */
  private write(ops: readonly SettingsPathOp[]): Promise<boolean> | boolean {
    if (this.hangNext) return new Promise<boolean>(() => undefined);
    if (this.rejectNext) {
      this.rejectNext = false;
      throw new Error("transport down");
    }
    const refused = this.landButRefuse;
    this.landButRefuse = false;
    this.snapshot = foldSnapshot(this.snapshot, ops);
    this.emit();
    return !refused;
  }

  async set(field: string, value: unknown): Promise<boolean> {
    return this.write([{ op: "set", path: [field], value }]);
  }

  async unset(field: string): Promise<boolean> {
    return this.write([{ op: "unset", path: [field] }]);
  }

  async mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean> {
    this.mutations.push({ ops, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
    if (expectedRevision !== undefined && expectedRevision !== this.snapshot.revision) return false;
    return this.write(ops);
  }
}

function model(scope: DraftScope, writeDeadlineMs = 50): { form: SettingsFormModel; controller: MemcurioSettingsController } {
  const controller = new MemcurioSettingsController(scope, { writeDeadlineMs });
  const form = new SettingsFormModel(controller);
  controller.start();
  form.start();
  return { form, controller };
}

describe("SettingsFormModel budget", () => {
  test("stages a value, writes once on Save, and clears back to the base", async () => {
    const scope = new DraftScope();
    const { form } = model(scope);
    form.editBudget("900");
    expect(form.shell().dirty).toBe(true);
    expect(scope.mutations).toHaveLength(0);
    expect(await form.save()).toEqual({ ok: true });
    expect(scope.mutations[0]?.ops).toEqual([{ op: "set", path: ["injectBudgetTokens"], value: 900 }]);
    expect(scope.mutations[0]?.expectedRevision).toBe(1);
    expect((scope.snapshot.user as Record<string, unknown>).injectBudgetTokens).toBe(900);

    form.editBudget("900");
    expect(form.shell().dirty).toBe(false); // staged back to the effective value
    form.editBudget("");
    expect(form.budget().text).toBe("");
    expect(form.shell().dirty).toBe(true);
    expect(await form.save()).toEqual({ ok: true });
    expect(scope.mutations[1]?.ops).toEqual([{ op: "unset", path: ["injectBudgetTokens"] }]);
    expect((scope.snapshot.user as Record<string, unknown>).injectBudgetTokens).toBeUndefined();
  });


  test("clearing or resetting a non-overridden budget restores the effective display", () => {
    const scope = new DraftScope();
    scope.snapshot = {
      ...scope.snapshot,
      base: { ...BASE, injectBudgetTokens: 4000 },
      value: { ...BASE, injectBudgetTokens: 4000 },
    };
    const { form } = model(scope);
    form.editBudget("900");
    expect(form.budget().text).toBe("900");
    form.editBudget("");
    expect(form.budget().text).toBe("4000");
    expect(form.shell().dirty).toBe(false);

    form.editBudget("900");
    form.resetField("injectBudgetTokens");
    expect(form.budget().text).toBe("4000");
    expect(form.shell().dirty).toBe(false);
  });

  test("a value equal to the composition base is a reset, not a pinned override", async () => {
    const scope = new DraftScope();
    scope.snapshot = {
      ...scope.snapshot,
      base: { ...BASE, injectBudgetTokens: 1500 },
      value: { ...BASE, injectBudgetTokens: 900 },
      user: { injectBudgetTokens: 900 },
    };
    const { form } = model(scope);
    form.editBudget("1500");
    expect(form.shell().dirty).toBe(true);
    expect(await form.save()).toEqual({ ok: true });
    expect(scope.mutations[0]?.ops).toEqual([{ op: "unset", path: ["injectBudgetTokens"] }]);
  });

  test("invalid text blocks Save and does not touch the wire", async () => {
    const scope = new DraftScope();
    const { form } = model(scope);
    form.editBudget("10");
    expect(form.shell().invalid).toBe(true);
    expect(form.budget().invalid).toBe(true);
    expect(await form.save()).toEqual({ ok: false, code: "errBudgetRange" });
    expect(scope.mutations).toHaveLength(0);
  });
});

describe("SettingsFormModel route and booleans", () => {
  test("pin writes the pair atomically; default clears it", async () => {
    const scope = new DraftScope();
    const { form } = model(scope);
    form.editRouteMode("pin");
    expect(form.route().mode).toBe("pin");
    form.editProvider("p");
    form.editModel("m");
    expect(await form.save()).toEqual({ ok: true });
    expect(scope.mutations[0]?.ops).toEqual([
      { op: "set", path: ["provider"], value: "p" },
      { op: "set", path: ["model"], value: "m" },
    ]);
    form.editRouteMode("default");
    expect(await form.save()).toEqual({ ok: true });
    expect(scope.mutations[1]?.ops).toEqual([
      { op: "unset", path: ["provider"] },
      { op: "unset", path: ["model"] },
    ]);
  });

  test("a lone route half is invalid and a deployment-pinned pair is the default", async () => {
    const scope = new DraftScope();
    scope.snapshot = {
      ...scope.snapshot,
      base: { ...BASE, provider: "base-p", model: "base-m" },
      value: { ...BASE, provider: "base-p", model: "base-m" },
    };
    const { form } = model(scope);
    expect(form.route().basePinned).toBe(true);
    expect(form.route().mode).toBe("default");
    form.editProvider("only-p");
    form.editModel("");
    expect(form.route().mode).toBe("pin");
    expect(form.route().invalid).toBe(true);
    expect(await form.save()).toEqual({ ok: false, code: "errRoutePair" });
    expect(scope.mutations).toHaveLength(0);
  });


  test("a stored pair equal to the pinned base is clean, not a phantom dirty route", () => {
    const scope = new DraftScope();
    scope.snapshot = {
      ...scope.snapshot,
      base: { ...BASE, provider: "base-p", model: "base-m" },
      value: { ...BASE, provider: "base-p", model: "base-m" },
      user: { provider: "base-p", model: "base-m" },
    };
    const { form } = model(scope);
    expect(form.route().overridden).toBe(false);
    expect(form.shell().dirty).toBe(false);
    expect(form.shell().dirtyCount).toBe(0);
    form.discard();
    expect(form.shell().dirty).toBe(false);
  });

  test("scope and tools follow the same base-value reset rule", async () => {
    const scope = new DraftScope();
    scope.snapshot = {
      ...scope.snapshot,
      user: { scope: "global", registerTools: false },
      value: { ...BASE, scope: "global", registerTools: false },
    };
    const { form } = model(scope);
    form.editScope("workspace");
    form.editTools(true);
    expect(form.shell().dirty).toBe(true);
    expect(await form.save()).toEqual({ ok: true });
    expect(scope.mutations[0]?.ops).toEqual([
      { op: "unset", path: ["scope"] },
      { op: "unset", path: ["registerTools"] },
    ]);
  });
});

describe("SettingsFormModel lifecycle and failure", () => {
  test("resetVisible clears visible overrides but leaves hidden retention keys", async () => {
    const scope = new DraftScope();
    scope.snapshot = {
      ...scope.snapshot,
      user: {
        injectBudgetTokens: 900,
        scope: "global",
        registerTools: false,
        provider: "p",
        model: "m",
        storeRetentionDays: 30,
      },
      value: {
        ...BASE,
        injectBudgetTokens: 900,
        scope: "global",
        registerTools: false,
        provider: "p",
        model: "m",
      },
    };
    const { form } = model(scope);
    expect(form.shell().hiddenOverridden).toEqual(["storeRetentionDays"]);
    form.resetVisible();
    // The badge follows the staged outcome: a staged clear means the field
    // will no longer be overridden after Save.
    expect(form.budget().overridden).toBe(false);
    expect(form.scope().overridden).toBe(false);
    expect(form.route().overridden).toBe(false);
    expect(form.tools().overridden).toBe(false);
    expect(await form.save()).toEqual({ ok: true });
    const ops = scope.mutations[0]?.ops ?? [];
    expect(ops).toContainEqual({ op: "unset", path: ["injectBudgetTokens"] });
    expect(ops).toContainEqual({ op: "unset", path: ["scope"] });
    expect(ops).toContainEqual({ op: "unset", path: ["provider"] });
    expect(ops).toContainEqual({ op: "unset", path: ["model"] });
    expect(ops).toContainEqual({ op: "unset", path: ["registerTools"] });
    expect(ops).not.toContainEqual({ op: "unset", path: ["storeRetentionDays"] });
    expect((scope.snapshot.user as Record<string, unknown>).storeRetentionDays).toBe(30);
  });


  test("a local instant write rebases the staged fence instead of causing a self-conflict", async () => {
    const scope = new DraftScope();
    const { form, controller } = model(scope);
    form.editBudget("900");
    const before = controller.revision();
    expect(await controller.writeField("injectContext", false)).toEqual({ ok: true });
    expect(scope.snapshot.revision).toBe(2);
    form.rebase(before);
    expect(await form.save()).toEqual({ ok: true });
    expect(scope.mutations[0]?.expectedRevision).toBe(2);
    expect((scope.snapshot.user as Record<string, unknown>).injectContext).toBe(false);
    expect((scope.snapshot.user as Record<string, unknown>).injectBudgetTokens).toBe(900);
  });



  test("an external write during the switch write is not folded into the form fence", async () => {
    const scope = new DraftScope();
    const { form, controller } = model(scope);
    form.editBudget("900"); // baseline revision 1
    const originalSet = scope.set.bind(scope);
    scope.set = async (field: string, value: unknown): Promise<boolean> => {
      // Another editor writes budget while the switch write is queued.
      scope.snapshot = {
        ...scope.snapshot,
        revision: 2,
        user: { injectBudgetTokens: 1200 },
        value: { ...BASE, injectBudgetTokens: 1200 },
      };
      scope.emit();
      return originalSet(field, value);
    };
    const before = controller.revision();
    expect(await controller.writeField("injectContext", false)).toEqual({ ok: true });
    expect(scope.snapshot.revision).toBe(3);
    form.rebase(before);
    expect(await form.save()).toEqual({ ok: false, code: "errNotLanded" });
    expect(form.shell().conflict).toBe(true);
    expect((scope.snapshot.user as Record<string, unknown>).injectBudgetTokens).toBe(1200);
    expect(form.budget().text).toBe("900");
  });

  test("an external revision change before the switch is not masked by rebase", async () => {
    const scope = new DraftScope();
    const { form } = model(scope);
    form.editBudget("900"); // baseline revision 1
    scope.snapshot = {
      ...scope.snapshot,
      revision: 2,
      user: { injectContext: false },
      value: { ...BASE, injectContext: false },
    };
    scope.emit();
    form.rebase(2); // form baseline 1 != switch's pre-revision 2 -> skip
    expect(await form.save()).toEqual({ ok: false, code: "errNotLanded" });
    expect(form.shell().conflict).toBe(true);
    expect(form.budget().text).toBe("900");
    expect(scope.mutations[0]?.expectedRevision).toBe(1);
    // Another editor writes and then a local instant write succeeds. Rebase
    // may advance the fence, but it must not hide the unresolved conflict.
    scope.snapshot = {
      ...scope.snapshot,
      revision: 3,
      user: { injectContext: false },
      value: { ...BASE, injectContext: false },
    };
    scope.emit();
    form.rebase(2);
    expect(form.shell().conflict).toBe(true);
    expect(await form.save()).toEqual({ ok: true });
    expect(scope.mutations[1]?.expectedRevision).toBe(3);
    expect(form.shell().conflict).toBe(false);
  });

  test("a refusal keeps drafts; a revision change is a conflict", async () => {
    const scope = new DraftScope();
    const { form } = model(scope);
    form.editBudget("900");
    scope.mutate = async () => false;
    expect(await form.save()).toEqual({ ok: false, code: "errNotLanded" });
    expect(form.budget().text).toBe("900");
    expect(form.shell().failed).toBe("errNotLanded");
    expect(form.shell().dirty).toBe(true);

    scope.mutate = async () => {
      scope.snapshot = { ...scope.snapshot, revision: (scope.snapshot.revision ?? 0) + 1 };
      return false;
    };
    expect(await form.save()).toEqual({ ok: false, code: "errNotLanded" });
    expect(form.shell().conflict).toBe(true);
  });


  test("discard during an in-flight save ignores the settlement", async () => {
    const scope = new DraftScope();
    const { form } = model(scope);
    form.editBudget("900");
    const original = scope.mutate.bind(scope);
    let release: (accepted: boolean) => void = () => undefined;
    scope.mutate = (ops, revision) =>
      new Promise<boolean>((resolve) => {
        release = (accepted) => {
          if (accepted) void original(ops, revision);
          resolve(accepted);
        };
      });
    const pending = form.save();
    form.discard();
    expect(form.shell().dirty).toBe(false);
    release(true);
    expect(await pending).toEqual({ ok: true });
    expect(form.shell().savedAt).toBeUndefined();
    expect(form.shell().failed).toBeUndefined();
    // The queued host write cannot be recalled; it lands, but the abandoned
    // form state does not publish a saved/failed banner afterwards.
    expect(form.budget().text).toBe("900");
  });

  test("discard drops drafts and the failure state", async () => {
    const scope = new DraftScope();
    const { form } = model(scope);
    form.editBudget("900");
    scope.mutate = async () => false;
    await form.save();
    form.discard();
    expect(form.shell().dirty).toBe(false);
    expect(form.shell().failed).toBeUndefined();
    expect(form.budget().text).toBe("");
    expect(scope.mutations).toHaveLength(0);
  });
});

describe("SettingsFormModel revision fence", () => {
  test("rebase does not advance the fence when an external write landed first", async () => {
    const scope = new DraftScope();
    const { form, controller } = model(scope);
    form.editBudget("900"); // fence at revision 1
    // Another editor writes the same namespace before the local switch.
    scope.snapshot = { ...scope.snapshot, revision: 2 };
    scope.emit();
    // The local switch write then advances the revision once more (2 → 3).
    expect(await controller.writeField("injectContext", false)).toEqual({ ok: true });
    expect(controller.revision()).toBe(3);
    // 2 is the revision the switch captured before its own write.
    form.rebase(2);
    expect(await form.save()).toEqual({ ok: false, code: "errNotLanded" });
    expect(form.shell().conflict).toBe(true);
    // The external value was not folded into the form's fence.
    expect(scope.snapshot.value?.injectContext).toBe(false);
    expect(scope.mutations.at(-1)?.expectedRevision).toBe(1);
  });

  test("a local switch write with no external interleaving advances the fence", async () => {
    const scope = new DraftScope();
    const { form, controller } = model(scope);
    form.editBudget("900");
    const before = controller.revision();
    expect(await controller.writeField("injectContext", false)).toEqual({ ok: true });
    form.rebase(before);
    expect(await form.save()).toEqual({ ok: true });
    expect(scope.mutations.at(-1)?.expectedRevision).toBe((before ?? 0) + 1);
  });
});

describe("SettingsFormModel fence release and settlement", () => {
  test("typing back to the effective value releases the fence", async () => {
    const scope = new DraftScope();
    const { form } = model(scope);
    form.editScope("global");
    form.editScope("workspace"); // no operation left
    expect(form.shell().dirty).toBe(false);
    // An external write lands while the form looks clean.
    scope.snapshot = { ...scope.snapshot, revision: 5 };
    scope.emit();
    form.editBudget("900");
    expect(await form.save()).toEqual({ ok: true });
    expect(scope.mutations.at(-1)?.expectedRevision).toBe(5);
  });

  test("an empty plan is a verified no-op: no wire call, drafts cleared", async () => {
    const scope = new DraftScope();
    const { form } = model(scope);
    form.editScope("workspace"); // equals the effective value and the base
    expect(form.shell().dirty).toBe(false);
    expect(await form.save()).toEqual({ ok: true });
    expect(scope.mutations).toHaveLength(0);
  });

  test("a refusal the host already landed settles instead of a dead end", async () => {
    const scope = new DraftScope();
    const { form } = model(scope);
    form.editScope("global");
    scope.landButRefuse = true;
    expect(await form.save()).toEqual({ ok: true });
    expect(form.shell().failed).toBeUndefined();
    expect(form.shell().dirty).toBe(false);
    expect(form.shell().savedAt).toBeDefined();
    expect(scope.snapshot.value?.scope).toBe("global");
  });

  test("a hung write fails on the deadline and leaves the draft retryable", async () => {
    const scope = new DraftScope();
    const { form } = model(scope, 10);
    form.editBudget("900");
    scope.hangNext = true;
    expect(await form.save()).toEqual({ ok: false, code: "errTimeout" });
    expect(form.shell().saving).toBe(false);
    expect(form.shell().failed).toBe("errTimeout");
    expect(form.shell().dirty).toBe(true);
    expect(form.budget().text).toBe("900");
  });
});

describe("SettingsFormModel route reset against a pinned base", () => {
  const PINNED: MemcurioSettingsView = { ...BASE, provider: "deepseek", model: "v4" };

  test("staging the pinned pair in pin mode is a reset, not a set", async () => {
    const scope = new DraftScope();
    scope.snapshot = {
      ...scope.snapshot,
      base: PINNED,
      value: { ...PINNED, provider: "other", model: "m1" },
      user: { provider: "other", model: "m1" },
    };
    const { form } = model(scope);
    expect(form.route().mode).toBe("pin");
    form.editProvider("deepseek");
    form.editModel("v4");
    expect(await form.save()).toEqual({ ok: true });
    expect(scope.mutations.at(-1)?.ops).toEqual([
      { op: "unset", path: ["provider"] },
      { op: "unset", path: ["model"] },
    ]);
    expect(scope.snapshot.user).toEqual({ provider: "deepseek", model: "v4" });
    expect(form.route().overridden).toBe(false);
  });
});

