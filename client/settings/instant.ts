/**
 * Instant-zone model: the memory-injection switch.
 *
 * The switch is the one control that must apply immediately (see the design
 * proposal). It owns its own optimistic value, per-field pending state, error
 * and a short undo window, so a failed switch never paints the staged form red
 * and a slow host never freezes the other fields.
 *
 * The model is framework-free: the panel consumes it through the renderer's
 * observable-hook seat, and tests drive it directly.
 */
import type { MemcurioSettingsController, SaveOutcome, SettingsErrorCode } from "./controller.js";

/** One observable switch state. */
export interface InstantFace {
  /** Optimistic value shown while a write is in flight. */
  value: boolean;
  pending: boolean;
  /** Locale key of the last failure, if any. */
  errorCode?: SettingsErrorCode;
  /** Previous value available for the inline undo affordance. */
  undo?: { value: boolean };
  /** Timestamp of the last accepted write (the panel shows a brief saved state). */
  savedAt?: number;
}

export interface InstantHook {
  getSnapshot(): InstantFace;
  subscribe(listener: () => void): () => void;
}

const UNDO_MS = 5_000;
const SAVED_MS = 2_000;

/** The memory-injection switch over one controller. */
export class InjectionSwitchModel {
  private readonly controller: MemcurioSettingsController;
  private readonly onAccepted: ((beforeRevision: number | undefined) => void) | undefined;
  private value: boolean;
  private pending = false;
  private errorCode: SettingsErrorCode | undefined;
  private undo: { value: boolean } | undefined;
  private savedAt: number | undefined;
  private cache: InstantFace | null = null;
  private readonly listeners = new Set<() => void>();
  private startCount = 0;
  private unsubscribe: (() => void) | undefined;
  private undoTimer: ReturnType<typeof setTimeout> | undefined;
  private savedTimer: ReturnType<typeof setTimeout> | undefined;
  /** Last intent wins: a slow earlier write must not overwrite a later click. */
  private generation = 0;
  private disposed = false;

  constructor(controller: MemcurioSettingsController, onAccepted?: (beforeRevision: number | undefined) => void) {
    this.controller = controller;
    this.onAccepted = onAccepted;
    this.value = controller.face().value.injectContext;
  }

  /** Attach to controller notifications; refcounted for safe effect teardown. */
  start(): () => void {
    this.startCount += 1;
    if (this.startCount === 1) {
      this.unsubscribe = this.controller.subscribe(() => this.sync());
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.startCount -= 1;
      if (this.startCount === 0) {
        this.unsubscribe?.();
        this.unsubscribe = undefined;
      }
    };
  }

  faceHook(): InstantHook {
    return {
      getSnapshot: () => this.face(),
      subscribe: (listener) => this.subscribe(listener),
    };
  }

  face(): InstantFace {
    if (this.cache !== null) return this.cache;
    this.cache = {
      value: this.value,
      pending: this.pending,
      ...(this.errorCode === undefined ? {} : { errorCode: this.errorCode }),
      ...(this.undo === undefined ? {} : { undo: this.undo }),
      ...(this.savedAt === undefined ? {} : { savedAt: this.savedAt }),
    };
    return this.cache;
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Apply the switch with an optimistic paint and a verified rollback. */
  async toggle(next: boolean): Promise<SaveOutcome> {
    if (this.disposed || this.pending || next === this.value) return { ok: true };
    const previous = this.value;
    const beforeRevision = this.controller.revision();
    const generation = ++this.generation;
    this.value = next;
    this.pending = true;
    this.errorCode = undefined;
    this.undo = undefined;
    this.clearSaved();
    this.notify();
    const outcome = await this.controller.writeField("injectContext", next);
    if (this.disposed || generation !== this.generation) return outcome;
    this.pending = false;
    if (outcome.ok) {
      this.value = next;
      this.savedAt = Date.now();
      this.undo = { value: previous };
      this.armTimers();
      try {
        this.onAccepted?.(beforeRevision);
      } catch (error) {
        console.error("memcurio: instant accepted callback failed", error);
      }
    } else {
      this.errorCode = outcome.code;
      this.value = this.current();
    }
    this.notify();
    return outcome;
  }

  /** Clear the override and return to the composition base. */
  async reset(): Promise<SaveOutcome> {
    if (this.disposed || this.pending) return { ok: true };
    const previous = this.value;
    const beforeRevision = this.controller.revision();
    const generation = ++this.generation;
    this.pending = true;
    this.errorCode = undefined;
    this.undo = undefined;
    this.clearSaved();
    this.notify();
    const outcome = await this.controller.unsetField("injectContext");
    if (this.disposed || generation !== this.generation) return outcome;
    this.pending = false;
    if (outcome.ok) {
      this.value = this.controller.face().base.injectContext;
      this.savedAt = Date.now();
      this.undo = { value: previous };
      this.armTimers();
      try {
        this.onAccepted?.(beforeRevision);
      } catch (error) {
        console.error("memcurio: instant accepted callback failed", error);
      }
    } else {
      this.errorCode = outcome.code;
      this.value = this.current();
    }
    this.notify();
    return outcome;
  }

  /** Re-apply the value captured before the last accepted change. */
  async undoLast(): Promise<SaveOutcome> {
    const previous = this.undo?.value;
    if (previous === undefined) return { ok: true };
    this.undo = undefined;
    this.notify();
    return this.toggle(previous);
  }

  /** Drop timers/listeners with the panel fiber. */
  dispose(): void {
    this.disposed = true;
    this.generation += 1;
    this.clearTimers();
    this.listeners.clear();
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  private sync(): void {
    if (this.disposed || this.pending) return;
    const next = this.current();
    if (next === this.value) return;
    // An external writer changed the switch: the previous undo target and
    // failure copy no longer describe the current state.
    this.value = next;
    this.errorCode = undefined;
    this.undo = undefined;
    this.savedAt = undefined;
    this.clearTimers();
    this.notify();
  }

  private current(): boolean {
    return this.controller.face().value.injectContext;
  }

  private armTimers(): void {
    this.clearTimers();
    this.undoTimer = setTimeout(() => {
      this.undo = undefined;
      this.notify();
    }, UNDO_MS);
    this.savedTimer = setTimeout(() => {
      this.savedAt = undefined;
      this.notify();
    }, SAVED_MS);
  }

  private clearSaved(): void {
    this.savedAt = undefined;
  }

  private clearTimers(): void {
    if (this.undoTimer !== undefined) clearTimeout(this.undoTimer);
    if (this.savedTimer !== undefined) clearTimeout(this.savedTimer);
    this.undoTimer = undefined;
    this.savedTimer = undefined;
  }

  private notify(): void {
    this.cache = null;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("memcurio: instant switch listener failed", error);
      }
    }
  }
}
