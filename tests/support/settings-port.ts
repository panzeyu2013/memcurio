/**
 * One host-faithful settings port for every client settings test.
 *
 * The controller tests, the staged-form tests and the rendered-panel tests
 * each grew their own fake port; the copies had already drifted (one emitted
 * after a landed write, one did not; only one modelled an honest-but-unlanded
 * transport). This class carries the union of those behaviours, with the
 * host-faithful fold from `settings-fake.ts`.
 *
 * Test-only module; never imported by shipped code.
 */
import type {
  ConfigFormPort,
  ConfigFormSnapshotLike,
  MemcurioSettingsView,
  SettingsPathOp,
} from "../../client/settings/controller.js";

import { foldSnapshot } from "./settings-fake.js";

/** The shape every shipped settings view starts from in tests. */
export const SETTINGS_BASE: MemcurioSettingsView = {
  scope: "workspace",
  injectContext: true,
  registerTools: true,
};

export interface FakeSettingsWrite {
  readonly ops: readonly SettingsPathOp[];
  readonly expectedRevision?: number;
}

export interface FakeSettingsPortOptions {
  /** Start from this view instead of `SETTINGS_BASE`. */
  base?: MemcurioSettingsView;
  /**
   * Notify subscribers after a landed write (default false). The rendered
   * panel and the staged form model subscribe through the port, so they opt
   * in; the controller tests drive notification explicitly.
   */
  emitOnLand?: boolean;
}

export class FakeSettingsPort implements ConfigFormPort<MemcurioSettingsView> {
  snapshot: ConfigFormSnapshotLike<MemcurioSettingsView>;
  readonly sets: Array<{ field: string; value: unknown }> = [];
  readonly unsets: string[] = [];
  readonly mutations: FakeSettingsWrite[] = [];
  /** Kept as its own list: callers assert the fence without unwrapping. */
  readonly mutationRevisions: Array<number | undefined> = [];
  scopeListeners = 0;
  /** When false writes resolve without landing (host refusal). */
  landing = true;
  /** When false the port answers true even for an unlanded write: only the
   *  controller's own snapshot verification can catch that transport. */
  honest = true;
  /** The next write never settles, like a hung settings RPC. */
  hangNext = false;
  /** The next write rejects, like a dead transport. */
  rejectNext = false;
  /** The next mutation lands but answers false (a late read-back refusal). */
  landButRefuse = false;

  private readonly emitOnLand: boolean;
  private readonly listeners = new Set<() => void>();

  constructor(options: FakeSettingsPortOptions = {}) {
    const base = options.base ?? SETTINGS_BASE;
    this.emitOnLand = options.emitOnLand === true;
    this.snapshot = {
      status: "ready",
      value: base,
      base,
      user: undefined,
      revision: 1,
      writable: true,
    };
  }

  getSnapshot(): ConfigFormSnapshotLike<MemcurioSettingsView> {
    return this.snapshot;
  }

  subscribe(listener: () => void): () => void {
    this.scopeListeners += 1;
    this.listeners.add(listener);
    return () => {
      this.scopeListeners -= 1;
      this.listeners.delete(listener);
    };
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
    if (!this.landing) return !this.honest;
    const refused = this.landButRefuse;
    this.landButRefuse = false;
    this.snapshot = foldSnapshot(this.snapshot, ops);
    if (this.emitOnLand) this.emit();
    return !refused;
  }

  async set(field: string, value: unknown): Promise<boolean> {
    this.sets.push({ field, value });
    return this.write([{ op: "set", path: [field], value }]);
  }

  async unset(field: string): Promise<boolean> {
    this.unsets.push(field);
    return this.write([{ op: "unset", path: [field] }]);
  }

  async mutate(ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<boolean> {
    this.mutations.push({ ops, ...(expectedRevision === undefined ? {} : { expectedRevision }) });
    this.mutationRevisions.push(expectedRevision);
    if (expectedRevision !== undefined && expectedRevision !== this.snapshot.revision) {
      return false;
    }
    return this.write(ops);
  }
}
