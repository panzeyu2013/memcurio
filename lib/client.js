window.__ModuleLoader__.load({
	id: "@memcurio/dsh-plugin",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// client/entry.ts
var entry_exports = {};
__export(entry_exports, {
  apply: () => apply,
  inject: () => inject
});
module.exports = __toCommonJS(entry_exports);

// client/settings/controller.ts
var NAMESPACE = "memcurio";
var SETTINGS_FIELDS = [
  "scope",
  "injectContext",
  "registerTools",
  "injectBudgetTokens",
  "provider",
  "model"
];
var HIDDEN_SETTINGS_FIELDS = ["storeRetentionDays", "storeTrashDays"];
var ERROR_KEYS = {
  routePair: "errRoutePair",
  budgetRange: "errBudgetRange",
  notLanded: "errNotLanded",
  notReady: "errNotReady",
  hostRejected: "errHostRejected",
  timeout: "errTimeout"
};
var WRITE_DEADLINE_MS = 15e3;
async function settleWithin(work, ms) {
  let timer;
  const guarded = work.then(
    (value) => ({ kind: "value", value }),
    (error) => ({ kind: "error", error })
  );
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve({ kind: "timeout" }), ms);
  });
  try {
    return await Promise.race([guarded, deadline]);
  } finally {
    if (timer !== void 0) clearTimeout(timer);
  }
}
var DEFAULT_VIEW = {
  scope: "workspace",
  injectContext: true,
  registerTools: true
};
function decodeSettings(raw) {
  if (raw === null || typeof raw !== "object") return DEFAULT_VIEW;
  const section = raw;
  const scope = section.scope === "global" ? "global" : "workspace";
  return {
    scope,
    injectContext: section.injectContext !== false,
    registerTools: section.registerTools !== false,
    ...typeof section.injectBudgetTokens === "number" && Number.isSafeInteger(section.injectBudgetTokens) ? { injectBudgetTokens: section.injectBudgetTokens } : {},
    ...typeof section.provider === "string" && section.provider ? { provider: section.provider } : {},
    ...typeof section.model === "string" && section.model ? { model: section.model } : {}
  };
}
function overriddenFields(user, base) {
  if (user === null || typeof user !== "object") return [];
  const layer = user;
  const baseLayer = base !== null && typeof base === "object" ? base : void 0;
  return SETTINGS_FIELDS.filter((field) => {
    if (!Object.hasOwn(layer, field)) return false;
    if (baseLayer === void 0) return true;
    return !(Object.hasOwn(baseLayer, field) && Object.is(layer[field], baseLayer[field]));
  });
}
function hiddenOverriddenFields(user, base) {
  if (user === null || typeof user !== "object") return [];
  const layer = user;
  const baseLayer = base !== null && typeof base === "object" ? base : void 0;
  return HIDDEN_SETTINGS_FIELDS.filter((field) => {
    if (!Object.hasOwn(layer, field)) return false;
    if (baseLayer === void 0) return true;
    return !(Object.hasOwn(baseLayer, field) && Object.is(layer[field], baseLayer[field]));
  });
}
function routePairProblem(provider, model) {
  const hasProvider = typeof provider === "string" && provider.trim().length > 0;
  const hasModel = typeof model === "string" && model.trim().length > 0;
  return hasProvider === hasModel ? void 0 : ERROR_KEYS.routePair;
}
function routeProblem(field, value, view) {
  if (field !== "provider" && field !== "model") return void 0;
  return routePairProblem(
    field === "provider" ? value : view.provider,
    field === "model" ? value : view.model
  );
}
function budgetProblem(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 128) return ERROR_KEYS.budgetRange;
  return void 0;
}
var MemcurioSettingsController = class {
  scope;
  /** Deadline for one transport write; tests shrink it to exercise the hung
   *  path without waiting the production bound. */
  writeDeadlineMs;
  faceCache = null;
  listeners = /* @__PURE__ */ new Set();
  /** ONE underlying scope subscription, fanned out to panel listeners. */
  unsubscribeScope;
  /** Refcount so a redundant start()/dispose pair cannot kill the seat. */
  starters = 0;
  constructor(scope, options = {}) {
    this.scope = scope;
    this.writeDeadlineMs = options.writeDeadlineMs ?? WRITE_DEADLINE_MS;
  }
  /** Attach the transport subscription; returns the disposer (fiber-owned).
   *  Refcounted: a second caller's disposer releases only its own hold. */
  start() {
    this.starters += 1;
    if (this.starters === 1) {
      this.unsubscribeScope = this.scope.subscribe(() => this.notify());
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.starters -= 1;
      if (this.starters === 0) {
        this.unsubscribeScope?.();
        this.unsubscribeScope = void 0;
      }
    };
  }
  /** Observable seat for the `hooks` compartment (renderer-memo safe). */
  faceHook() {
    return {
      getSnapshot: () => this.face(),
      subscribe: (listener) => this.subscribe(listener)
    };
  }
  /** Stable face reference until the next notification. */
  face() {
    if (this.faceCache) return this.faceCache;
    const snapshot = this.scope.getSnapshot();
    const base = decodeSettings(snapshot.base);
    this.faceCache = {
      status: snapshot.status,
      writable: snapshot.writable,
      // Copied only when the Host supplies it: the `0.2.1` line has no such field.
      ...snapshot.mode === void 0 ? {} : { mode: snapshot.mode },
      // The Host is authoritative, but a malformed/partial value must not
      // reach routePair(...).trim() or the panel. Decode it to the same safe
      // shape as base (unknown fields are ignored, bad scalars fall back).
      value: decodeSettings(snapshot.value ?? snapshot.base),
      base,
      overridden: overriddenFields(snapshot.user, base),
      hiddenOverridden: hiddenOverriddenFields(snapshot.user, snapshot.base)
    };
    return this.faceCache;
  }
  /** Observe changes (the panel's hook subscribes through this). */
  subscribe(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  /** Current host revision. The staged form captures it on the first edit and
   *  passes it back as the write fence, so a concurrent editor is refused
   *  instead of silently overwritten. */
  revision() {
    return this.scope.getSnapshot().revision;
  }
  /** Low-level single-field write for the instant zone. The switch owns its
   *  own pending/error/undo state; this method only writes and verifies. */
  async writeField(field, value) {
    const face = this.face();
    const problem = routeProblem(field, value, face.value) ?? (field === "injectBudgetTokens" ? budgetProblem(value) : void 0);
    if (problem) return { ok: false, code: problem };
    const reverts = Object.is(value, face.base[field]);
    const settled = await this.settle(() => reverts ? this.scope.unset(field) : this.scope.set(field, value));
    if (settled.kind === "timeout") return { ok: false, code: ERROR_KEYS.timeout };
    if (settled.kind === "error") return { ok: false, code: ERROR_KEYS.hostRejected };
    if (!settled.value || !this.verifyField(field, value, reverts)) {
      return { ok: false, code: this.refusalKey() };
    }
    this.notify();
    return { ok: true };
  }
  /** Low-level clear for the instant zone's "reset to default" action. */
  async unsetField(field) {
    const settled = await this.settle(() => this.scope.unset(field));
    if (settled.kind === "timeout") return { ok: false, code: ERROR_KEYS.timeout };
    if (settled.kind === "error") return { ok: false, code: ERROR_KEYS.hostRejected };
    if (!settled.value || !this.verifyField(field, void 0, true)) {
      return { ok: false, code: this.refusalKey() };
    }
    this.notify();
    return { ok: true };
  }
  /** Low-level atomic plan write for the staged form. Verification is against
   *  the landed user layer, not the host's boolean alone. */
  async writeOps(ops, expectedRevision) {
    if (ops.length === 0) return { ok: true };
    const settled = await this.settle(() => this.scope.mutate(ops, expectedRevision));
    if (settled.kind === "timeout") return { ok: false, code: ERROR_KEYS.timeout };
    if (settled.kind === "error") return { ok: false, code: ERROR_KEYS.hostRejected };
    if (!settled.value || !this.verifyOps(ops)) {
      return { ok: false, code: this.refusalKey() };
    }
    this.notify();
    return { ok: true };
  }
  /** Run one transport call under the write deadline; a synchronous throw from
   *  the port is the same refusal as a rejected promise. */
  settle(work) {
    try {
      return settleWithin(work(), this.writeDeadlineMs);
    } catch (error) {
      return Promise.resolve({ kind: "error", error });
    }
  }
  /** A failed read-back means "host refused" only while the transport is
   *  ready; a lost ready state is "could not verify", not a refusal. */
  refusalKey() {
    return this.scope.getSnapshot().status === "ready" ? ERROR_KEYS.notLanded : ERROR_KEYS.notReady;
  }
  /** Post-write verification for one atomic plan: every set landed with that
   *  exact scalar; an unset either removed the entry or was rewritten by the
   *  Host into a set of the inherited/base value (the documented lower-layer
   *  reset limitation). The ui-settings mirror folds an accepted write before
   *  its promise resolves, with one exception: a write superseded by a later
   *  one on the same form skips the fold and only records a pending revision.
   *  The panel serializes its own writes (Save, switch and undo are mutually
   *  disabled), so that shape is not reachable here; a concurrent editor uses
   *  a different form instance. If that changes, this read-back must re-read
   *  instead of trusting the snapshot. */
  verifyOps(ops) {
    const snapshot = this.scope.getSnapshot();
    if (snapshot.status !== "ready") return false;
    const base = this.face().base;
    const user = snapshot.user;
    const layer = user !== null && typeof user === "object" ? user : {};
    for (const op of ops) {
      const field = op.path[0];
      if (typeof field !== "string") return false;
      if (op.op === "set") {
        if (!Object.hasOwn(layer, field) || !Object.is(layer[field], op.value)) return false;
      } else if (Object.hasOwn(layer, field)) {
        if (!Object.hasOwn(base, field) || !Object.is(layer[field], base[field])) return false;
      }
    }
    return true;
  }
  /** Post-write verification against the landed user layer. All fields are
   *  scalars, so strict identity is exact. A REVERT may land as an absent
   *  entry OR, when a lower layer supplies the field, as an equal set of the
   *  inherited value; the Host documents the latter and rewrites the unset
   *  itself, so rejecting it would make every reset of a deployment-pinned
   *  field report failure. */
  verifyField(field, value, reverts) {
    const snapshot = this.scope.getSnapshot();
    if (snapshot.status !== "ready") return false;
    const base = this.face().base;
    const user = snapshot.user;
    const layer = user !== null && typeof user === "object" ? user : {};
    if (reverts) {
      if (!Object.hasOwn(layer, field)) return true;
      return Object.hasOwn(base, field) && Object.is(layer[field], base[field]);
    }
    return Object.hasOwn(layer, field) && Object.is(layer[field], value);
  }
  notify() {
    this.faceCache = null;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("memcurio: settings listener failed", error);
      }
    }
  }
};

// client/settings/nav-mark.ts
var import_react = require("react");

// client/settings/locales.ts
var NS = "memcurio.settings";
var en = {
  nav: "Memory",
  title: "Memory",
  intro: "Remember important details across sessions and bring relevant memories into the conversation.",
  injectionSection: "Takes effect immediately",
  injectionLabel: "Memory injection",
  injectionHint: "When off, memories are no longer added automatically. Stored memories and memory tools are unaffected.",
  injectionOn: "Injection on",
  injectionOff: "Injection off",
  stateOn: "On",
  stateOff: "Off",
  injectionUndo: "Undo",
  configSection: "Configuration \xB7 saved on save",
  configHint: "Changes here apply after Save. Leaving this page discards unsaved changes.",
  budgetLabel: "Injection budget",
  budgetUnit: "tokens",
  budgetHint: "Empty uses the relevant memory store's configuration (built-in default 2,500); minimum 128.",
  budgetMinHint: "Minimum 128.",
  budgetPlaceholder: "Workspace default",
  budgetBasePlaceholder: "Deployment default",
  budgetBaseHint: "Deployment default: {value}",
  budgetResetTarget: "Reset to default ({value})",
  budgetResetStore: "Reset to default (workspace configuration)",
  scopeLabel: "Storage scope",
  scopeWorkspace: "Keep per workspace",
  scopeGlobal: "Share across workspaces",
  scopeWorkspaceHint: "Each workspace keeps its own memories. Applies to new sessions; existing memories are not moved.",
  scopeGlobalHint: "All workspaces share one memory store. Applies to new sessions; existing memories are not moved.",
  scopeBaseTag: "Default",
  advanced: "Advanced",
  advancedChanged: "{count} changed",
  advancedUnsaved: "{count} unsaved",
  advancedInvalid: "{count} to fix",
  routeLabel: "Memory processing model",
  routeFollow: "Follow the session",
  routeDefault: "Use the deployment default",
  routePin: "Pin a model",
  routeProvider: "Provider",
  routeModel: "Model",
  routeHintFollow: "Used for memory extraction and consolidation. Defaults to the current session's model.",
  routeHintDefault: "The deployment pins {provider} / {model}. This page can only choose another fixed model.",
  routeHintPin: "Both fields are required. Saving the default option restores inheritance.",
  toolsLabel: "Register memory tools",
  toolsHint: "Let the model read and write memory. When off, the model has no memory tools; stored memories and injection are unaffected.",
  toolsRestart: "Takes effect after restart",
  overridden: "Changed",
  defaultIs: "Default: {value}",
  reset: "Reset to default",
  resetTarget: "Reset to default ({value})",
  resetAll: "Reset configuration defaults",
  resetAllHint: "Resets the configuration form fields; data-retention settings remain deployment-managed.",
  hiddenOverrides: "{count} data-retention setting(s) are managed by the deployment and are not changed here.",
  deploymentNote: "Storage location and data-retention settings are managed by the deployment.",
  save: "Save",
  saving: "Saving\u2026",
  saved: "Saved",
  discard: "Discard changes",
  unsavedCount: "{count} unsaved",
  invalidSummary: "{count} setting(s) need attention",
  reload: "Discard draft",
  statusLoading: "Loading",
  statusSaving: "Saving\u2026",
  statusError: "Save failed",
  statusReadyOn: "Injection on",
  statusReadyOff: "Injection off",
  statusReadOnly: "Read-only",
  statusUnavailable: "Unavailable",
  loading: "Loading settings\u2026",
  unavailable: "Memory settings aren't available. Check that the memcurio plugin is enabled.",
  readOnly: "This deployment's settings are read-only.",
  errRoutePair: "Enter both provider and model, or use the default route.",
  errBudgetRange: "Enter a whole number of 128 or more, or leave blank.",
  errNotLanded: "Couldn't save: the server didn't accept the change. Try again.",
  errNotReady: "Connection lost; we couldn't confirm the save. Refresh and try again.",
  errHostRejected: "Couldn't reach the settings service. Try again.",
  errTimeout: "The settings service didn't answer in time; the change is unconfirmed. Try again.",
  errConflict: "Saving failed; the settings may have changed elsewhere. Your draft is still here. Discard it or Save again."
};
var zh = {
  nav: "\u8BB0\u5FC6",
  title: "\u8BB0\u5FC6",
  intro: "\u8DE8\u4F1A\u8BDD\u8BB0\u4F4F\u91CD\u8981\u4FE1\u606F\uFF0C\u5E76\u5728\u5BF9\u8BDD\u4E2D\u5E26\u4E0A\u76F8\u5173\u8BB0\u5FC6\u3002",
  injectionSection: "\u7ACB\u5373\u751F\u6548",
  injectionLabel: "\u8BB0\u5FC6\u6CE8\u5165",
  injectionHint: "\u5173\u95ED\u540E\u4E0D\u518D\u81EA\u52A8\u628A\u8BB0\u5FC6\u5E26\u8FDB\u5BF9\u8BDD\uFF1B\u5DF2\u5B58\u8BB0\u5FC6\u548C\u8BB0\u5FC6\u5DE5\u5177\u4E0D\u53D7\u5F71\u54CD\u3002",
  injectionOn: "\u6CE8\u5165\u5F00\u542F",
  injectionOff: "\u6CE8\u5165\u5173\u95ED",
  stateOn: "\u5F00\u542F",
  stateOff: "\u5173\u95ED",
  injectionUndo: "\u64A4\u9500",
  configSection: "\u914D\u7F6E \xB7 \u4FDD\u5B58\u540E\u751F\u6548",
  configHint: "\u8FD9\u91CC\u7684\u4FEE\u6539\u5728\u4FDD\u5B58\u540E\u751F\u6548\uFF1B\u79BB\u5F00\u6B64\u9875\u4F1A\u653E\u5F03\u672A\u4FDD\u5B58\u7684\u66F4\u6539\u3002",
  budgetLabel: "\u6CE8\u5165\u9884\u7B97",
  budgetUnit: "tokens",
  budgetHint: "\u7559\u7A7A\u65F6\u4F7F\u7528\u5BF9\u5E94\u8BB0\u5FC6\u5B58\u50A8\u7684\u914D\u7F6E\uFF08\u5185\u7F6E\u9ED8\u8BA4 2,500\uFF09\uFF1B\u6700\u5C11 128\u3002",
  budgetMinHint: "\u6700\u5C11 128\u3002",
  budgetPlaceholder: "\u5DE5\u4F5C\u533A\u9ED8\u8BA4",
  budgetBasePlaceholder: "\u90E8\u7F72\u9ED8\u8BA4",
  budgetBaseHint: "\u90E8\u7F72\u914D\u7F6E\uFF1A{value}",
  budgetResetTarget: "\u6062\u590D\u9ED8\u8BA4\uFF08{value}\uFF09",
  budgetResetStore: "\u6062\u590D\u9ED8\u8BA4\uFF08\u5DE5\u4F5C\u533A\u914D\u7F6E\uFF09",
  scopeLabel: "\u5B58\u50A8\u8303\u56F4",
  scopeWorkspace: "\u6309\u5DE5\u4F5C\u533A\u9694\u79BB",
  scopeGlobal: "\u6240\u6709\u5DE5\u4F5C\u533A\u5171\u7528",
  scopeWorkspaceHint: "\u6BCF\u4E2A\u5DE5\u4F5C\u533A\u4F7F\u7528\u81EA\u5DF1\u7684\u8BB0\u5FC6\uFF1B\u53EA\u5F71\u54CD\u65B0\u4F1A\u8BDD\uFF1B\u5DF2\u6709\u8BB0\u5FC6\u4E0D\u4F1A\u8FC1\u79FB\u3002",
  scopeGlobalHint: "\u6240\u6709\u5DE5\u4F5C\u533A\u5171\u7528\u540C\u4E00\u4EFD\u8BB0\u5FC6\uFF1B\u53EA\u5F71\u54CD\u65B0\u4F1A\u8BDD\uFF1B\u5DF2\u6709\u8BB0\u5FC6\u4E0D\u4F1A\u8FC1\u79FB\u3002",
  scopeBaseTag: "\u9ED8\u8BA4",
  advanced: "\u9AD8\u7EA7",
  advancedChanged: "{count} \u9879\u5DF2\u4FEE\u6539",
  advancedUnsaved: "{count} \u9879\u672A\u4FDD\u5B58",
  advancedInvalid: "{count} \u9879\u9700\u4FEE\u6B63",
  routeLabel: "\u8BB0\u5FC6\u5904\u7406\u6A21\u578B",
  routeFollow: "\u8DDF\u968F\u5F53\u524D\u4F1A\u8BDD",
  routeDefault: "\u4F7F\u7528\u90E8\u7F72\u9ED8\u8BA4",
  routePin: "\u56FA\u5B9A\u6A21\u578B",
  routeProvider: "\u670D\u52A1\u5546",
  routeModel: "\u6A21\u578B",
  routeHintFollow: "\u8BB0\u5FC6\u62BD\u53D6\u548C\u6574\u7406\u4F7F\u7528\u8FD9\u4E2A\u6A21\u578B\uFF1B\u9ED8\u8BA4\u8DDF\u968F\u5F53\u524D\u4F1A\u8BDD\u3002",
  routeHintDefault: "\u90E8\u7F72\u5DF2\u56FA\u5B9A {provider} / {model}\uFF1B\u6B64\u9875\u53EA\u80FD\u6539\u4E3A\u5176\u4ED6\u56FA\u5B9A\u6A21\u578B\u3002",
  routeHintPin: "\u670D\u52A1\u5546\u548C\u6A21\u578B\u5FC5\u987B\u540C\u65F6\u586B\u5199\uFF1B\u4FDD\u5B58\u9ED8\u8BA4\u9009\u9879\u5373\u6062\u590D\u7EE7\u627F\u3002",
  toolsLabel: "\u6CE8\u518C\u8BB0\u5FC6\u5DE5\u5177",
  toolsHint: "\u5141\u8BB8\u6A21\u578B\u8BFB\u5199\u8BB0\u5FC6\u3002\u5173\u95ED\u540E\u6A21\u578B\u6CA1\u6709\u8BB0\u5FC6\u5DE5\u5177\uFF1B\u5DF2\u5B58\u8BB0\u5FC6\u548C\u6CE8\u5165\u4E0D\u53D7\u5F71\u54CD\u3002",
  toolsRestart: "\u91CD\u542F\u540E\u751F\u6548",
  overridden: "\u5DF2\u4FEE\u6539",
  defaultIs: "\u9ED8\u8BA4\uFF1A{value}",
  reset: "\u6062\u590D\u9ED8\u8BA4",
  resetTarget: "\u6062\u590D\u9ED8\u8BA4\uFF08{value}\uFF09",
  resetAll: "\u6062\u590D\u914D\u7F6E\u9ED8\u8BA4",
  resetAllHint: "\u91CD\u7F6E\u914D\u7F6E\u8868\u5355\u5B57\u6BB5\uFF1B\u6570\u636E\u56DE\u6536\u8BBE\u7F6E\u4ECD\u7531\u90E8\u7F72\u914D\u7F6E\u7BA1\u7406\u3002",
  hiddenOverrides: "\u53E6\u6709 {count} \u9879\u6570\u636E\u56DE\u6536\u8BBE\u7F6E\u7531\u90E8\u7F72\u914D\u7F6E\u7BA1\u7406\uFF0C\u672C\u9875\u4E0D\u4F1A\u6539\u52A8\u3002",
  deploymentNote: "\u5B58\u50A8\u4F4D\u7F6E\u4E0E\u6570\u636E\u56DE\u6536\u8BBE\u7F6E\u7531\u90E8\u7F72\u914D\u7F6E\u7BA1\u7406\u3002",
  save: "\u4FDD\u5B58",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  saved: "\u5DF2\u4FDD\u5B58",
  discard: "\u653E\u5F03\u66F4\u6539",
  unsavedCount: "{count} \u9879\u672A\u4FDD\u5B58",
  invalidSummary: "{count} \u9879\u8BBE\u7F6E\u9700\u8981\u4FEE\u6B63",
  reload: "\u4E22\u5F03\u8349\u7A3F",
  statusLoading: "\u52A0\u8F7D\u4E2D",
  statusSaving: "\u4FDD\u5B58\u4E2D\u2026",
  statusError: "\u4FDD\u5B58\u5931\u8D25",
  statusReadyOn: "\u6CE8\u5165\u5F00\u542F",
  statusReadyOff: "\u6CE8\u5165\u5173\u95ED",
  statusReadOnly: "\u53EA\u8BFB",
  statusUnavailable: "\u4E0D\u53EF\u7528",
  loading: "\u6B63\u5728\u52A0\u8F7D\u8BBE\u7F6E\u2026",
  unavailable: "\u8BB0\u5FC6\u8BBE\u7F6E\u6682\u4E0D\u53EF\u7528\u3002\u8BF7\u786E\u8BA4 memcurio \u63D2\u4EF6\u5DF2\u542F\u7528\u3002",
  readOnly: "\u5F53\u524D\u90E8\u7F72\u7684\u8BBE\u7F6E\u4E3A\u53EA\u8BFB\uFF0C\u65E0\u6CD5\u5728\u8FD9\u91CC\u4FEE\u6539\u3002",
  errRoutePair: "\u8BF7\u540C\u65F6\u586B\u5199\u670D\u52A1\u5546\u548C\u6A21\u578B\uFF0C\u6216\u4F7F\u7528\u9ED8\u8BA4\u8DEF\u7531\u3002",
  errBudgetRange: "\u8BF7\u8F93\u5165 128 \u6216\u66F4\u5927\u7684\u6574\u6570\uFF0C\u6216\u7559\u7A7A\u3002",
  errNotLanded: "\u4FDD\u5B58\u5931\u8D25\uFF1A\u670D\u52A1\u5668\u6CA1\u6709\u63A5\u53D7\u8FD9\u6B21\u4FEE\u6539\u3002\u8BF7\u91CD\u8BD5\u3002",
  errNotReady: "\u8FDE\u63A5\u4E2D\u65AD\uFF0C\u65E0\u6CD5\u786E\u8BA4\u662F\u5426\u4FDD\u5B58\u6210\u529F\u3002\u8BF7\u5237\u65B0\u540E\u91CD\u8BD5\u3002",
  errHostRejected: "\u65E0\u6CD5\u8FDE\u63A5\u8BBE\u7F6E\u670D\u52A1\uFF0C\u8BF7\u7A0D\u540E\u91CD\u8BD5\u3002",
  errTimeout: "\u8BBE\u7F6E\u670D\u52A1\u8D85\u65F6\u672A\u54CD\u5E94\uFF0C\u65E0\u6CD5\u786E\u8BA4\u662F\u5426\u4FDD\u5B58\u3002\u8BF7\u91CD\u8BD5\u3002",
  errConflict: "\u4FDD\u5B58\u5931\u8D25\uFF1A\u8BBE\u7F6E\u53EF\u80FD\u5DF2\u5728\u522B\u5904\u66F4\u65B0\uFF1B\u4F60\u7684\u8349\u7A3F\u4ECD\u7136\u4FDD\u7559\u3002\u53EF\u4E22\u5F03\u8349\u7A3F\u6216\u518D\u6B21\u4FDD\u5B58\u3002"
};

// client/settings/nav-mark.ts
var NAV_MARK_ATTRIBUTE = "data-memcurio-nav";
var MEMORY_MARK_LABELS = [zh.nav, en.nav];
var ROW_SELECTOR = '[role="dialog"][aria-modal="true"] nav button';
var NAV_SELECTOR = '[role="dialog"][aria-modal="true"] nav';
var warned = false;
function navRows() {
  if (typeof document === "undefined") return [];
  return [...document.querySelectorAll(ROW_SELECTOR)];
}
function markSettingsNavRow() {
  if (typeof document === "undefined") return () => void 0;
  const candidates = [];
  for (const button of navRows()) {
    if (button.querySelector(":scope > svg") === null) continue;
    const text = (button.textContent ?? "").trim();
    if (!MEMORY_MARK_LABELS.includes(text)) continue;
    candidates.push(button);
  }
  if (candidates.length !== 1) return () => void 0;
  const row = candidates[0];
  if (row === void 0 || row.getAttribute(NAV_MARK_ATTRIBUTE) === "true") return () => void 0;
  row.setAttribute(NAV_MARK_ATTRIBUTE, "true");
  return () => {
    if (row.getAttribute(NAV_MARK_ATTRIBUTE) === "true") row.removeAttribute(NAV_MARK_ATTRIBUTE);
  };
}
function remarkSettingsNavRow() {
  if (typeof document === "undefined") return;
  if (document.querySelector(`[${NAV_MARK_ATTRIBUTE}]`) !== null) return;
  markSettingsNavRow();
  if (document.querySelector(`[${NAV_MARK_ATTRIBUTE}]`) !== null) return;
  const rows = navRows();
  if (rows.length === 0 || warned) return;
  warned = true;
  const labels = rows.map((button) => (button.textContent ?? "").trim());
  console.warn("memcurio: settings nav row not recognised", { labels, expected: MEMORY_MARK_LABELS });
}
function SettingsNavProbe() {
  (0, import_react.useEffect)(() => {
    let owner = markSettingsNavRow();
    if (typeof document === "undefined" || typeof MutationObserver === "undefined") {
      return () => owner();
    }
    const nav = document.querySelector(NAV_SELECTOR);
    if (nav === null) return () => owner();
    const scope = nav.closest('[role="dialog"][aria-modal="true"]') ?? nav.parentElement ?? nav;
    let queued = false;
    let disposed = false;
    const queue = () => {
      if (queued || disposed) return;
      queued = true;
      const run = () => {
        queued = false;
        if (disposed) return;
        if (document.querySelector(`[${NAV_MARK_ATTRIBUTE}]`) !== null) return;
        owner();
        owner = markSettingsNavRow();
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else setTimeout(run, 0);
    };
    const observer = new MutationObserver(queue);
    observer.observe(scope, { childList: true, subtree: true });
    return () => {
      disposed = true;
      observer.disconnect();
      owner();
    };
  }, []);
  return null;
}

// client/settings/section.tsx
var import_react2 = require("react");

// client/settings/chrome.tsx
var import_jsx_runtime = require("react/jsx-runtime");
function statusOf(face, instant, shell, t) {
  if (face.status === "loading") return { tone: "neutral", label: t("statusLoading") };
  if (face.status === "unavailable") {
    return face.mode === "memory" ? { tone: "neutral", label: t("statusReadOnly") } : { tone: "neutral", label: t("statusUnavailable") };
  }
  if (!face.writable) return { tone: "neutral", label: t("statusReadOnly") };
  if (instant.errorCode !== void 0) {
    return { tone: "error", label: t("statusError"), title: t(instant.errorCode) };
  }
  if (shell.failed !== void 0) {
    return { tone: "error", label: t("statusError"), title: t(shell.conflict ? "errConflict" : shell.failed) };
  }
  if (instant.pending || shell.saving) return { tone: "neutral", label: t("statusSaving") };
  return instant.value ? { tone: "success", label: t("statusReadyOn") } : { tone: "neutral", label: t("statusReadyOff") };
}
function StatusChip(props) {
  const { status } = props;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("span", { className: "memcurio-settings-status", "data-tone": status.tone, role: "status", title: status.title, children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "memcurio-settings-status-dot", "aria-hidden": "true" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { children: status.label })
  ] });
}
function Header(props) {
  const { t, titleId, status } = props;
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("header", { className: "memcurio-settings-header", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memcurio-settings-header-text", children: [
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("h2", { id: titleId, children: t("title") }),
      /* @__PURE__ */ (0, import_jsx_runtime.jsx)("p", { children: t("intro") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)(StatusChip, { status })
  ] });
}
function Skeleton() {
  return /* @__PURE__ */ (0, import_jsx_runtime.jsxs)("div", { className: "memcurio-settings-skeleton", "aria-hidden": "true", children: [
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "memcurio-settings-skeleton-bar" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "memcurio-settings-skeleton-bar" }),
    /* @__PURE__ */ (0, import_jsx_runtime.jsx)("span", { className: "memcurio-settings-skeleton-bar" })
  ] });
}

// client/settings/fields.tsx
var import_jsx_runtime2 = require("react/jsx-runtime");
function focusByIdSoon(id) {
  setTimeout(() => {
    document.getElementById(id)?.focus();
  }, 0);
}
function ChangedBadge(props) {
  const { t, onReset, resetLabel, disabled } = props;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "memcurio-settings-badges", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "memcurio-settings-tag", children: t("overridden") }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
      "button",
      {
        type: "button",
        className: "memcurio-settings-reset",
        "aria-label": resetLabel,
        disabled,
        onClick: onReset,
        children: t("reset")
      }
    )
  ] });
}
function RadioOption(props) {
  const { id, name, value, checked, label, baseTag, disabled, onChange } = props;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)(
    "label",
    {
      className: "memcurio-settings-choice",
      "data-selected": checked ? "true" : void 0,
      "data-disabled": disabled ? "true" : void 0,
      htmlFor: id,
      children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "input",
          {
            id,
            type: "radio",
            name,
            value,
            checked,
            disabled,
            onChange
          }
        ),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "memcurio-settings-choice-label", children: label }),
        baseTag === void 0 ? null : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "memcurio-settings-tag", children: baseTag })
      ]
    }
  );
}
function BudgetField(props) {
  const { t, view, idBase, disabled, onChange, onReset } = props;
  const inputId = `${idBase}-budget`;
  const hintId = `${idBase}-budget-hint`;
  const errorId = `${idBase}-budget-error`;
  const unitId = `${idBase}-budget-unit`;
  const handleReset = () => {
    onReset();
    focusByIdSoon(inputId);
  };
  const hint = view.base === void 0 ? t("budgetHint") : `${t("budgetBaseHint", { value: view.base })} ${t("budgetMinHint")}`;
  const placeholder = view.base === void 0 ? t("budgetPlaceholder") : t("budgetBasePlaceholder");
  const describedBy = view.invalid ? `${hintId} ${errorId} ${unitId}` : `${hintId} ${unitId}`;
  const resetLabel = view.base === void 0 ? t("budgetResetStore") : t("budgetResetTarget", { value: view.base });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "memcurio-settings-field", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "memcurio-settings-field-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "memcurio-settings-field-label", htmlFor: inputId, children: t("budgetLabel") }),
      view.overridden ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ChangedBadge, { t, onReset: handleReset, resetLabel, disabled }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("span", { className: "memcurio-settings-input-wrap", "data-invalid": view.invalid ? "true" : void 0, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "input",
        {
          id: inputId,
          className: "memcurio-settings-input",
          type: "text",
          inputMode: "numeric",
          autoComplete: "off",
          spellCheck: false,
          placeholder,
          value: view.text,
          disabled,
          "aria-invalid": view.invalid ? true : void 0,
          "aria-describedby": describedBy,
          onChange: (event) => onChange(event.target.value)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { id: unitId, className: "memcurio-settings-sr-only", children: t("budgetUnit") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "memcurio-settings-input-suffix", "aria-hidden": "true", children: t("budgetUnit") })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { id: hintId, className: "memcurio-settings-hint", children: hint }),
    view.invalid ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { id: errorId, className: "memcurio-settings-error", role: "alert", children: t(view.errorCode ?? "errBudgetRange") }) : null
  ] });
}
function ScopeField(props) {
  const { t, view, idBase, disabled, onChange, onReset } = props;
  const labelId = `${idBase}-scope-label`;
  const hintId = `${idBase}-scope-hint`;
  const name = `${idBase}-scope`;
  const handleReset = () => {
    onReset();
    focusByIdSoon(`${idBase}-scope-${view.baseValue ?? "workspace"}`);
  };
  const hint = view.value === "global" ? t("scopeGlobalHint") : t("scopeWorkspaceHint");
  const resetLabel = t("resetTarget", {
    value: view.baseValue === "global" ? t("scopeGlobal") : t("scopeWorkspace")
  });
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "memcurio-settings-field", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "memcurio-settings-field-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "memcurio-settings-field-label", id: labelId, children: t("scopeLabel") }),
      view.overridden ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ChangedBadge, { t, onReset: handleReset, resetLabel, disabled }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("fieldset", { className: "memcurio-settings-choice-group", "aria-labelledby": labelId, "aria-describedby": hintId, disabled, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("legend", { className: "memcurio-settings-sr-only", children: t("scopeLabel") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        RadioOption,
        {
          id: `${idBase}-scope-workspace`,
          name,
          value: "workspace",
          checked: view.value === "workspace",
          label: t("scopeWorkspace"),
          baseTag: view.baseValue === "workspace" ? t("scopeBaseTag") : void 0,
          disabled,
          onChange: () => onChange("workspace")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        RadioOption,
        {
          id: `${idBase}-scope-global`,
          name,
          value: "global",
          checked: view.value === "global",
          label: t("scopeGlobal"),
          baseTag: view.baseValue === "global" ? t("scopeBaseTag") : void 0,
          disabled,
          onChange: () => onChange("global")
        }
      )
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { id: hintId, className: "memcurio-settings-hint", children: hint })
  ] });
}
function ToolsField(props) {
  const { t, view, idBase, disabled, onChange, onReset } = props;
  const inputId = `${idBase}-tools`;
  const labelId = `${idBase}-tools-label`;
  const hintId = `${idBase}-tools-hint`;
  const resetLabel = t("resetTarget", { value: view.baseValue ? t("stateOn") : t("stateOff") });
  const handleReset = () => {
    onReset();
    focusByIdSoon(inputId);
  };
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "memcurio-settings-field", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "memcurio-settings-field-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "memcurio-settings-field-label", htmlFor: inputId, id: labelId, children: t("toolsLabel") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "memcurio-settings-tag", "data-tone": "warning", children: t("toolsRestart") }),
      view.overridden ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ChangedBadge, { t, onReset: handleReset, resetLabel, disabled }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "memcurio-settings-check-row", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        "input",
        {
          id: inputId,
          className: "memcurio-settings-checkbox",
          type: "checkbox",
          checked: view.value,
          disabled,
          "aria-describedby": hintId,
          onChange: (event) => onChange(event.target.checked)
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { id: hintId, className: "memcurio-settings-hint", children: t("toolsHint") })
    ] }),
    view.overridden ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { className: "memcurio-settings-meta", children: t("defaultIs", { value: view.baseValue ? t("stateOn") : t("stateOff") }) }) : null
  ] });
}
function RouteField(props) {
  const { t, view, idBase, disabled, onModeChange, onProviderChange, onModelChange, onReset } = props;
  const labelId = `${idBase}-route-label`;
  const hintId = `${idBase}-route-hint`;
  const errorId = `${idBase}-route-error`;
  const name = `${idBase}-route`;
  const providerId = `${idBase}-provider`;
  const modelId = `${idBase}-model`;
  const defaultLabel = view.basePinned ? t("routeDefault") : t("routeFollow");
  const resetLabel = t("resetTarget", { value: view.basePinned ? t("routeDefault") : t("routeFollow") });
  const handleReset = () => {
    onReset();
    focusByIdSoon(`${idBase}-route-default`);
  };
  const describedBy = view.invalid ? `${errorId} ${hintId}` : hintId;
  const fallbackHint = view.basePinned ? t("routeHintDefault", { provider: view.baseProvider, model: view.baseModel }) : view.mode === "pin" ? t("routeHintPin") : t("routeHintFollow");
  const hint = view.invalid ? t(view.errorCode ?? "errRoutePair") : fallbackHint;
  return /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "memcurio-settings-field", children: [
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "memcurio-settings-field-head", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("span", { className: "memcurio-settings-field-label", id: labelId, children: t("routeLabel") }),
      view.overridden ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(ChangedBadge, { t, onReset: handleReset, resetLabel, disabled }) : null
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("fieldset", { className: "memcurio-settings-choice-group", "aria-labelledby": labelId, "aria-describedby": hintId, disabled, children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("legend", { className: "memcurio-settings-sr-only", children: t("routeLabel") }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        RadioOption,
        {
          id: `${idBase}-route-default`,
          name,
          value: "default",
          checked: view.mode === "default",
          label: defaultLabel,
          baseTag: void 0,
          disabled,
          onChange: () => onModeChange("default")
        }
      ),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
        RadioOption,
        {
          id: `${idBase}-route-pin`,
          name,
          value: "pin",
          checked: view.mode === "pin",
          label: t("routePin"),
          baseTag: void 0,
          disabled,
          onChange: () => onModeChange("pin")
        }
      )
    ] }),
    view.mode === "pin" ? /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "memcurio-settings-pair", children: [
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "memcurio-settings-pair-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "memcurio-settings-field-label", htmlFor: providerId, children: t("routeProvider") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "input",
          {
            id: providerId,
            className: "memcurio-settings-input",
            type: "text",
            autoComplete: "off",
            spellCheck: false,
            value: view.provider,
            disabled,
            "aria-invalid": view.invalid ? true : void 0,
            "aria-describedby": describedBy,
            onChange: (event) => onProviderChange(event.target.value)
          }
        )
      ] }),
      /* @__PURE__ */ (0, import_jsx_runtime2.jsxs)("div", { className: "memcurio-settings-pair-field", children: [
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("label", { className: "memcurio-settings-field-label", htmlFor: modelId, children: t("routeModel") }),
        /* @__PURE__ */ (0, import_jsx_runtime2.jsx)(
          "input",
          {
            id: modelId,
            className: "memcurio-settings-input",
            type: "text",
            autoComplete: "off",
            spellCheck: false,
            value: view.model,
            disabled,
            "aria-invalid": view.invalid ? true : void 0,
            "aria-describedby": describedBy,
            onChange: (event) => onModelChange(event.target.value)
          }
        )
      ] })
    ] }) : null,
    view.invalid ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { id: errorId, className: "memcurio-settings-error", role: "alert", children: t(view.errorCode ?? "errRoutePair") }) : /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { id: hintId, className: "memcurio-settings-hint", children: hint }),
    view.invalid ? /* @__PURE__ */ (0, import_jsx_runtime2.jsx)("p", { id: hintId, className: "memcurio-settings-hint", children: fallbackHint }) : null
  ] });
}

// client/settings/section.tsx
var import_jsx_runtime3 = require("react/jsx-runtime");
function MemcurioSettingsSection(props) {
  const { t, useFace, useForm, useInstant, formModel, switchModel } = props;
  const face = useFace((snapshot) => snapshot);
  const shell = useForm((snapshot) => snapshot);
  const instant = useInstant((snapshot) => snapshot);
  const [advancedOpen, setAdvancedOpen] = (0, import_react2.useState)(false);
  const baseId = (0, import_react2.useId)().replace(/:/g, "");
  const titleId = `${baseId}-title`;
  const configSectionId = `${baseId}-config-label`;
  const injectionLabelId = `${baseId}-injection-label`;
  const injectionSwitchId = `${baseId}-injection-switch`;
  const injectionHintId = `${baseId}-injection-hint`;
  const injectionErrorId = `${baseId}-injection-error`;
  const budgetId = `${baseId}-budget`;
  const providerId = `${baseId}-provider`;
  const advancedPanelId = `${baseId}-advanced-panel`;
  const [focusKey, setFocusKey] = (0, import_react2.useState)(void 0);
  const statusRef = (0, import_react2.useRef)(null);
  const switchRef = (0, import_react2.useRef)(null);
  (0, import_react2.useEffect)(() => {
    remarkSettingsNavRow();
  }, []);
  (0, import_react2.useEffect)(() => {
    return () => {
      if (!formModel.shell().saving) formModel.discard();
    };
  }, [formModel]);
  const status = statusOf(face, instant, shell, t);
  (0, import_react2.useEffect)(() => {
    if (focusKey === void 0) return;
    if (focusKey === "route" && !advancedOpen) return;
    const id = focusKey === "route" ? providerId : focusKey === "injectBudgetTokens" ? budgetId : void 0;
    if (id === void 0) {
      setFocusKey(void 0);
      return;
    }
    const timer = setTimeout(() => {
      const element = document.getElementById(id);
      element?.focus();
      if (element !== null && typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ block: "nearest" });
      }
      setFocusKey(void 0);
    }, 0);
    return () => clearTimeout(timer);
  }, [advancedOpen, budgetId, focusKey, providerId]);
  if (face.status === "loading") {
    return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("section", { className: "memcurio-settings", "aria-labelledby": titleId, "aria-busy": "true", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Header, { t, titleId, status }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Skeleton, {}),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "memcurio-settings-note", children: t("loading") })
    ] });
  }
  if (face.status === "unavailable") {
    const legacyReadOnly = face.mode === "memory";
    return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("section", { className: "memcurio-settings", "aria-labelledby": titleId, children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Header, { t, titleId, status }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "memcurio-settings-empty", children: legacyReadOnly ? t("readOnly") : t("unavailable") })
    ] });
  }
  const budget = formModel.budget();
  const scope = formModel.scope();
  const route = formModel.route();
  const tools = formModel.tools();
  const disabled = !face.writable || shell.saving;
  const switchDisabled = !face.writable || instant.pending || shell.saving;
  const invalidKeys = formModel.invalidKeys();
  const advancedChanged = (route.overridden ? 1 : 0) + (tools.overridden ? 1 : 0);
  const advancedDirty = (route.dirty ? 1 : 0) + (tools.dirty ? 1 : 0);
  const advancedInvalid = route.invalid ? 1 : 0;
  const injectionBaseLabel = face.base.injectContext ? t("injectionOn") : t("injectionOff");
  const focusFirstInvalid = (key) => {
    if (key === void 0) return;
    if (key === "route" && !advancedOpen) setAdvancedOpen(true);
    setFocusKey(key);
  };
  const focusStatusSoon = () => {
    const focus = () => {
      statusRef.current?.focus();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
    else setTimeout(focus, 0);
  };
  const handleSubmit = (event) => {
    event.preventDefault();
    if (shell.invalid) {
      focusFirstInvalid(invalidKeys[0]);
      return;
    }
    if (!shell.dirty || shell.saving || instant.pending || !face.writable) return;
    void (async () => {
      const outcome = await formModel.save();
      if (outcome.ok) switchModel.clearError();
      focusStatusSoon();
    })();
  };
  let footerStatus = null;
  if (shell.failed !== void 0) {
    const conflict = shell.conflict;
    footerStatus = /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("p", { className: "memcurio-settings-footer-status memcurio-settings-error", role: "alert", children: [
      t(conflict ? "errConflict" : shell.failed),
      conflict ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
        "button",
        {
          type: "button",
          className: "memcurio-settings-link",
          onClick: () => {
            formModel.discard();
            focusByIdSoon(budgetId);
          },
          children: t("reload")
        }
      ) : null
    ] });
  } else if (shell.savedAt !== void 0) {
    footerStatus = /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "memcurio-settings-footer-status", role: "status", children: t("saved") });
  } else if (shell.invalid) {
    footerStatus = /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "memcurio-settings-footer-status memcurio-settings-warn", role: "status", children: t("invalidSummary", { count: shell.invalidCount }) });
  } else if (shell.dirty) {
    footerStatus = /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "memcurio-settings-footer-status", role: "status", children: t("unsavedCount", { count: shell.dirtyCount }) });
  }
  return /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("section", { className: "memcurio-settings", "aria-labelledby": titleId, children: [
    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(Header, { t, titleId, status }),
    !face.writable ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "memcurio-settings-warn", role: "status", children: t("readOnly") }) : null,
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "memcurio-settings-zone", children: [
      /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "memcurio-settings-zone-label", children: t("injectionSection") }),
      /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "memcurio-settings-card", children: [
        /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "memcurio-settings-instant-row", children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "memcurio-settings-instant-text", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("label", { className: "memcurio-settings-instant-label", id: injectionLabelId, htmlFor: injectionSwitchId, children: t("injectionLabel") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { id: injectionHintId, className: "memcurio-settings-hint", children: t("injectionHint") }),
            face.overridden.includes("injectContext") ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "memcurio-settings-meta", children: t("defaultIs", { value: injectionBaseLabel }) }) : null
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "memcurio-settings-instant-control", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "memcurio-settings-instant-state", children: instant.pending ? t("statusSaving") : instant.value ? t("injectionOn") : t("injectionOff") }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "input",
              {
                id: injectionSwitchId,
                ref: switchRef,
                type: "checkbox",
                className: "memcurio-settings-switch",
                role: "switch",
                checked: instant.value,
                "aria-checked": instant.value,
                "aria-labelledby": injectionLabelId,
                "aria-describedby": instant.errorCode === void 0 ? injectionHintId : `${injectionHintId} ${injectionErrorId}`,
                "aria-busy": instant.pending,
                disabled: switchDisabled,
                onChange: (event) => {
                  void switchModel.toggle(event.target.checked).then(() => {
                    if (typeof requestAnimationFrame === "function") {
                      requestAnimationFrame(() => switchRef.current?.focus());
                    }
                  });
                }
              }
            )
          ] })
        ] }),
        face.overridden.includes("injectContext") ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "memcurio-settings-instant-actions", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
          ChangedBadge,
          {
            t,
            disabled: switchDisabled,
            resetLabel: t("resetTarget", { value: injectionBaseLabel }),
            onReset: () => {
              void switchModel.reset().then(() => {
                if (typeof requestAnimationFrame === "function") {
                  requestAnimationFrame(() => switchRef.current?.focus());
                } else {
                  setTimeout(() => switchRef.current?.focus(), 0);
                }
              });
            }
          }
        ) }) : null,
        instant.errorCode !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { id: injectionErrorId, className: "memcurio-settings-error", role: "alert", children: t(instant.errorCode) }) : null,
        instant.undo !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("p", { className: "memcurio-settings-status-line", role: "status", children: [
          instant.value ? t("injectionOn") : t("injectionOff"),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { "aria-hidden": "true", children: " \xB7 " }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
            "button",
            {
              type: "button",
              className: "memcurio-settings-link",
              disabled: switchDisabled,
              onClick: () => {
                void switchModel.undoLast().then(() => {
                  switchRef.current?.focus();
                });
              },
              children: t("injectionUndo")
            }
          )
        ] }) : instant.savedAt !== void 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "memcurio-settings-status-line", role: "status", children: t("saved") }) : null
      ] })
    ] }),
    /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
      "form",
      {
        className: "memcurio-settings-form",
        noValidate: true,
        "aria-busy": shell.saving,
        "aria-labelledby": configSectionId,
        onSubmit: handleSubmit,
        children: [
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "memcurio-settings-zone-label", id: configSectionId, children: t("configSection") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "memcurio-settings-hint", children: t("configHint") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "memcurio-settings-form-body", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              BudgetField,
              {
                t,
                view: budget,
                idBase: baseId,
                disabled,
                onChange: (text) => formModel.editBudget(text),
                onReset: () => formModel.resetField("injectBudgetTokens")
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              ScopeField,
              {
                t,
                view: scope,
                idBase: baseId,
                disabled,
                onChange: (value) => formModel.editScope(value),
                onReset: () => formModel.resetField("scope")
              }
            ),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "memcurio-settings-advanced", children: [
              /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)(
                "button",
                {
                  type: "button",
                  className: "memcurio-settings-advanced-toggle",
                  "aria-expanded": advancedOpen,
                  "aria-controls": advancedPanelId,
                  onClick: () => setAdvancedOpen((open) => !open),
                  children: [
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "memcurio-settings-advanced-title", children: t("advanced") }),
                    advancedInvalid > 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "memcurio-settings-tag", "data-tone": "error", children: t("advancedInvalid", { count: advancedInvalid }) }) : advancedDirty > 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "memcurio-settings-tag", children: t("advancedUnsaved", { count: advancedDirty }) }) : advancedChanged > 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "memcurio-settings-tag", children: t("advancedChanged", { count: advancedChanged }) }) : null,
                    /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("span", { className: "memcurio-settings-chevron", "aria-hidden": "true" })
                  ]
                }
              ),
              /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { id: advancedPanelId, className: "memcurio-settings-advanced-panel", hidden: !advancedOpen, children: [
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                  RouteField,
                  {
                    t,
                    view: route,
                    idBase: baseId,
                    disabled,
                    onModeChange: (mode) => formModel.editRouteMode(mode),
                    onProviderChange: (value) => formModel.editProvider(value),
                    onModelChange: (value) => formModel.editModel(value),
                    onReset: () => formModel.resetField("route")
                  }
                ),
                /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                  ToolsField,
                  {
                    t,
                    view: tools,
                    idBase: baseId,
                    disabled,
                    onChange: (value) => formModel.editTools(value),
                    onReset: () => formModel.resetField("registerTools")
                  }
                )
              ] })
            ] })
          ] }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "memcurio-settings-footer-status-wrap", ref: statusRef, tabIndex: -1, children: footerStatus }),
          face.hiddenOverridden.length > 0 ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "memcurio-settings-note", children: t("hiddenOverrides", { count: face.hiddenOverridden.length }) }) : null,
          /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("p", { className: "memcurio-settings-note", children: t("deploymentNote") }),
          /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "memcurio-settings-footer", children: [
            /* @__PURE__ */ (0, import_jsx_runtime3.jsx)("div", { className: "memcurio-settings-footer-left", children: /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
              "button",
              {
                type: "button",
                className: "memcurio-settings-button",
                disabled: !face.writable || shell.saving || shell.overriddenCount === 0 && !shell.dirty,
                title: t("resetAllHint"),
                onClick: () => {
                  formModel.resetVisible();
                  focusByIdSoon(budgetId);
                },
                children: t("resetAll")
              }
            ) }),
            /* @__PURE__ */ (0, import_jsx_runtime3.jsxs)("div", { className: "memcurio-settings-footer-right", children: [
              shell.dirty ? /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "button",
                {
                  type: "button",
                  className: "memcurio-settings-button",
                  disabled: shell.saving,
                  onClick: () => {
                    formModel.discard();
                    focusByIdSoon(budgetId);
                  },
                  children: t("discard")
                }
              ) : null,
              /* @__PURE__ */ (0, import_jsx_runtime3.jsx)(
                "button",
                {
                  type: "submit",
                  className: "memcurio-settings-button memcurio-settings-button-primary",
                  disabled: !face.writable || shell.saving || instant.pending || !shell.dirty,
                  children: shell.saving ? t("saving") : t("save")
                }
              )
            ] })
          ] })
        ]
      }
    )
  ] });
}

// client/settings/draft.ts
var DRAFT_KEYS = ["injectBudgetTokens", "scope", "route", "registerTools"];
var SAVED_MS = 2e3;
function integerText(value) {
  return typeof value === "number" && Number.isSafeInteger(value) ? String(value) : "";
}
function routePair(provider, model) {
  const p = provider?.trim();
  const m = model?.trim();
  return p && m ? { provider: p, model: m } : void 0;
}
var SettingsFormModel = class {
  controller;
  drafts = /* @__PURE__ */ new Map();
  baselineRevision;
  /** Bumped by discard/dispose so an in-flight save cannot publish after the
   *  page has been left. */
  generation = 0;
  saving = false;
  failed;
  conflict = false;
  savedAt;
  cache = null;
  planCache = null;
  listeners = /* @__PURE__ */ new Set();
  startCount = 0;
  unsubscribe;
  savedTimer;
  disposed = false;
  constructor(controller) {
    this.controller = controller;
  }
  /** Attach to controller notifications; refcounted for effect teardown. */
  start() {
    this.startCount += 1;
    if (this.startCount === 1) {
      this.unsubscribe = this.controller.subscribe(() => this.notify());
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.startCount -= 1;
      if (this.startCount === 0) {
        this.unsubscribe?.();
        this.unsubscribe = void 0;
      }
    };
  }
  faceHook() {
    return {
      getSnapshot: () => this.shell(),
      subscribe: (listener) => this.subscribe(listener)
    };
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  shell() {
    if (this.cache !== null) return this.cache;
    const face = this.controller.face();
    const plan = this.plan();
    this.cache = {
      writable: face.writable,
      dirty: plan.dirty.size > 0,
      invalid: plan.errors.size > 0,
      saving: this.saving,
      ...this.failed === void 0 ? {} : { failed: this.failed },
      conflict: this.conflict,
      ...this.savedAt === void 0 ? {} : { savedAt: this.savedAt },
      dirtyCount: plan.dirty.size,
      invalidCount: plan.errors.size,
      overriddenCount: plan.overridden.size,
      hiddenOverridden: face.hiddenOverridden
    };
    return this.cache;
  }
  budget() {
    const face = this.controller.face();
    const draft = this.drafts.get("injectBudgetTokens");
    const text = draft?.kind === "budget" ? draft.text : integerText(face.value.injectBudgetTokens);
    const plan = this.plan();
    return {
      text,
      ...face.base.injectBudgetTokens === void 0 ? {} : { base: face.base.injectBudgetTokens },
      overridden: plan.overridden.has("injectBudgetTokens"),
      dirty: plan.dirty.has("injectBudgetTokens"),
      invalid: plan.errors.has("injectBudgetTokens"),
      ...plan.errors.has("injectBudgetTokens") ? { errorCode: plan.errors.get("injectBudgetTokens") } : {}
    };
  }
  scope() {
    const face = this.controller.face();
    const draft = this.drafts.get("scope");
    const value = draft?.kind === "scope" ? draft.value : face.value.scope;
    const plan = this.plan();
    return {
      value,
      baseValue: face.base.scope,
      overridden: plan.overridden.has("scope"),
      dirty: plan.dirty.has("scope")
    };
  }
  tools() {
    const face = this.controller.face();
    const draft = this.drafts.get("registerTools");
    const value = draft?.kind === "tools" ? draft.value : face.value.registerTools;
    const plan = this.plan();
    return {
      value,
      baseValue: face.base.registerTools,
      overridden: plan.overridden.has("registerTools"),
      dirty: plan.dirty.has("registerTools")
    };
  }
  route() {
    const face = this.controller.face();
    const draft = this.drafts.get("route");
    const initial = this.initialRoute(face);
    const view = draft?.kind === "route" ? draft : initial;
    const basePinned = routePair(face.base.provider, face.base.model) !== void 0;
    const plan = this.plan();
    return {
      mode: view.mode,
      provider: view.provider,
      model: view.model,
      ...face.base.provider === void 0 ? {} : { baseProvider: face.base.provider },
      ...face.base.model === void 0 ? {} : { baseModel: face.base.model },
      basePinned,
      overridden: plan.overridden.has("route"),
      dirty: plan.dirty.has("route"),
      invalid: plan.errors.has("route"),
      ...plan.errors.has("route") ? { errorCode: plan.errors.get("route") } : {}
    };
  }
  /** Fields with a validation problem, in panel order, for focus management. */
  invalidKeys() {
    const plan = this.plan();
    return DRAFT_KEYS.filter((key) => plan.errors.has(key));
  }
  editBudget(text) {
    const face = this.controller.face();
    const trimmed = text.trim();
    const stored = face.overridden.includes("injectBudgetTokens");
    if (trimmed === "" && !stored) {
      this.dropBudgetDraft();
      return;
    }
    if (trimmed !== "" && /^\d+$/.test(trimmed)) {
      const value = Number(trimmed);
      if (Number.isSafeInteger(value) && value === face.value.injectBudgetTokens) {
        this.dropBudgetDraft();
        return;
      }
    }
    this.stage({ kind: "budget", text });
  }
  dropBudgetDraft() {
    if (!this.drafts.delete("injectBudgetTokens")) return;
    if (this.drafts.size === 0) this.baselineRevision = void 0;
    this.failed = void 0;
    this.conflict = false;
    this.clearSaved();
    this.notify();
  }
  editScope(value) {
    this.stage({ kind: "scope", value });
  }
  editTools(value) {
    this.stage({ kind: "tools", value });
  }
  editRouteMode(mode) {
    const current = this.route();
    this.stage({ kind: "route", mode, provider: current.provider, model: current.model });
  }
  editProvider(provider) {
    const current = this.route();
    this.stage({ kind: "route", mode: "pin", provider, model: current.model });
  }
  editModel(model) {
    const current = this.route();
    this.stage({ kind: "route", mode: "pin", provider: current.provider, model });
  }
  /** Stage the field's default (one field, visible page only). */
  resetField(key) {
    const face = this.controller.face();
    if (key === "injectBudgetTokens") {
      if (!face.overridden.includes("injectBudgetTokens")) {
        this.dropBudgetDraft();
        return;
      }
      this.stage({ kind: "budget", text: "" });
      return;
    }
    if (key === "scope") {
      this.stage({ kind: "scope", value: face.base.scope });
      return;
    }
    if (key === "registerTools") {
      this.stage({ kind: "tools", value: face.base.registerTools });
      return;
    }
    const base = routePair(face.base.provider, face.base.model);
    this.stage({ kind: "route", mode: "default", provider: base?.provider ?? "", model: base?.model ?? "" });
  }
  /** Stage defaults for every visible field. Hidden lifecycle overrides are
   *  intentionally untouched; the panel reports them separately. */
  resetVisible() {
    for (const key of DRAFT_KEYS) this.resetField(key);
  }
  /** A local instant-zone write advanced the namespace revision. Keep the
   *  staged drafts but move the fence forward, so the switch and the form can
   *  be used in either order without a self-inflicted conflict. */
  rebase(fromRevision) {
    if (this.disposed || this.saving || this.drafts.size === 0 || fromRevision === void 0) return;
    if (this.baselineRevision !== void 0 && this.baselineRevision !== fromRevision) return;
    const current = this.controller.revision();
    if (current === void 0 || current !== fromRevision + 1) return;
    this.baselineRevision = current;
    this.notify();
  }
  /** Drop every draft and pending failure; the page keeps the host values. */
  discard() {
    this.generation += 1;
    this.drafts.clear();
    this.baselineRevision = void 0;
    this.saving = false;
    this.failed = void 0;
    this.conflict = false;
    this.clearSaved();
    this.notify();
  }
  /** Write every staged change in ONE atomic mutation. */
  async save() {
    if (this.disposed || this.saving) return { ok: false, code: ERROR_KEYS.notReady };
    const face = this.controller.face();
    if (!face.writable) return { ok: false, code: ERROR_KEYS.notReady };
    const plan = this.plan();
    if (plan.errors.size > 0) {
      const first = DRAFT_KEYS.find((key) => plan.errors.has(key));
      return { ok: false, code: first === void 0 ? ERROR_KEYS.notReady : plan.errors.get(first) ?? ERROR_KEYS.notReady };
    }
    if (plan.ops.length === 0) {
      this.drafts.clear();
      this.baselineRevision = void 0;
      this.failed = void 0;
      this.conflict = false;
      this.notify();
      return { ok: true };
    }
    const generation = this.generation;
    this.saving = true;
    this.failed = void 0;
    this.conflict = false;
    this.clearSaved();
    this.notify();
    const revision = this.baselineRevision ?? this.controller.revision();
    const outcome = await this.controller.writeOps(plan.ops, revision);
    if (this.disposed || generation !== this.generation) return outcome;
    this.saving = false;
    if (outcome.ok) {
      this.drafts.clear();
      this.baselineRevision = void 0;
      this.savedAt = Date.now();
      this.armSavedTimer();
    } else {
      const latest = this.controller.revision();
      this.conflict = latest !== revision;
      if (this.conflict) this.baselineRevision = latest;
      this.planCache = null;
      const remaining = this.plan();
      if (remaining.ops.length === 0 && remaining.errors.size === 0) {
        this.drafts.clear();
        this.baselineRevision = void 0;
        this.conflict = false;
        this.savedAt = Date.now();
        this.armSavedTimer();
        this.notify();
        return { ok: true };
      }
      this.failed = outcome.code;
    }
    this.notify();
    return outcome;
  }
  /** Stop timers/listeners with the panel fiber. */
  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.clearSaved();
    this.listeners.clear();
    this.unsubscribe?.();
    this.unsubscribe = void 0;
  }
  initialRoute(face) {
    const stored = face.overridden.includes("provider") || face.overridden.includes("model");
    const base = routePair(face.base.provider, face.base.model);
    return {
      kind: "route",
      mode: stored ? "pin" : "default",
      provider: face.value.provider ?? base?.provider ?? "",
      model: face.value.model ?? base?.model ?? ""
    };
  }
  stage(draft) {
    const key = draft.kind === "budget" ? "injectBudgetTokens" : draft.kind === "tools" ? "registerTools" : draft.kind;
    this.drafts.set(key, draft);
    this.failed = void 0;
    this.conflict = false;
    this.clearSaved();
    this.planCache = null;
    const plan = this.plan();
    if (plan.ops.length === 0 && plan.errors.size === 0) {
      this.baselineRevision = void 0;
    } else if (this.baselineRevision === void 0) {
      this.baselineRevision = this.controller.revision();
    }
    this.notify();
  }
  plan() {
    if (this.planCache !== null) return this.planCache;
    const face = this.controller.face();
    const plan = { ops: [], errors: /* @__PURE__ */ new Map(), dirty: /* @__PURE__ */ new Set(), overridden: /* @__PURE__ */ new Set() };
    const budgetDraft = this.drafts.get("injectBudgetTokens");
    const budgetText = budgetDraft?.kind === "budget" ? budgetDraft.text : void 0;
    if (budgetText !== void 0) {
      const text = budgetText.trim();
      const stored = face.overridden.includes("injectBudgetTokens");
      if (text === "") {
        if (stored) {
          plan.ops.push({ op: "unset", path: ["injectBudgetTokens"] });
          plan.dirty.add("injectBudgetTokens");
        }
      } else if (!/^\d+$/.test(text)) {
        plan.errors.set("injectBudgetTokens", ERROR_KEYS.budgetRange);
        plan.dirty.add("injectBudgetTokens");
        plan.overridden.add("injectBudgetTokens");
      } else {
        const value = Number(text);
        if (!Number.isSafeInteger(value) || value < 128) {
          plan.errors.set("injectBudgetTokens", ERROR_KEYS.budgetRange);
          plan.dirty.add("injectBudgetTokens");
          plan.overridden.add("injectBudgetTokens");
        } else if (face.base.injectBudgetTokens !== void 0 && value === face.base.injectBudgetTokens) {
          if (stored) {
            plan.ops.push({ op: "unset", path: ["injectBudgetTokens"] });
            plan.dirty.add("injectBudgetTokens");
          }
        } else if (value !== face.value.injectBudgetTokens) {
          plan.ops.push({ op: "set", path: ["injectBudgetTokens"], value });
          plan.dirty.add("injectBudgetTokens");
          plan.overridden.add("injectBudgetTokens");
        } else if (stored) {
          plan.overridden.add("injectBudgetTokens");
        }
      }
    } else if (face.overridden.includes("injectBudgetTokens")) {
      plan.overridden.add("injectBudgetTokens");
    }
    const scopeDraft = this.drafts.get("scope");
    if (scopeDraft?.kind === "scope") {
      const stored = face.overridden.includes("scope");
      if (scopeDraft.value === face.base.scope) {
        if (stored) {
          plan.ops.push({ op: "unset", path: ["scope"] });
          plan.dirty.add("scope");
        }
      } else if (scopeDraft.value !== face.value.scope) {
        plan.ops.push({ op: "set", path: ["scope"], value: scopeDraft.value });
        plan.dirty.add("scope");
        plan.overridden.add("scope");
      } else if (stored) {
        plan.overridden.add("scope");
      }
    } else if (face.overridden.includes("scope")) {
      plan.overridden.add("scope");
    }
    const toolsDraft = this.drafts.get("registerTools");
    if (toolsDraft?.kind === "tools") {
      const stored = face.overridden.includes("registerTools");
      if (toolsDraft.value === face.base.registerTools) {
        if (stored) {
          plan.ops.push({ op: "unset", path: ["registerTools"] });
          plan.dirty.add("registerTools");
        }
      } else if (toolsDraft.value !== face.value.registerTools) {
        plan.ops.push({ op: "set", path: ["registerTools"], value: toolsDraft.value });
        plan.dirty.add("registerTools");
        plan.overridden.add("registerTools");
      } else if (stored) {
        plan.overridden.add("registerTools");
      }
    } else if (face.overridden.includes("registerTools")) {
      plan.overridden.add("registerTools");
    }
    const routeDraft = this.drafts.get("route");
    const route = routeDraft?.kind === "route" ? routeDraft : this.initialRoute(face);
    const routeStored = face.overridden.includes("provider") || face.overridden.includes("model");
    const base = routePair(face.base.provider, face.base.model);
    const effective = routePair(face.value.provider, face.value.model);
    if (route.mode === "default") {
      if (routeStored) {
        plan.ops.push({ op: "unset", path: ["provider"] }, { op: "unset", path: ["model"] });
        plan.dirty.add("route");
      }
    } else {
      const provider = route.provider.trim();
      const model = route.model.trim();
      if (provider === "" || model === "") {
        plan.errors.set("route", ERROR_KEYS.routePair);
        plan.dirty.add("route");
        plan.overridden.add("route");
      } else if (base !== void 0 && provider === base.provider && model === base.model) {
        if (routeStored) {
          plan.ops.push({ op: "unset", path: ["provider"] }, { op: "unset", path: ["model"] });
          plan.dirty.add("route");
        }
      } else if (provider !== effective?.provider || model !== effective?.model) {
        plan.ops.push(
          { op: "set", path: ["provider"], value: provider },
          { op: "set", path: ["model"], value: model }
        );
        plan.dirty.add("route");
        plan.overridden.add("route");
      } else if (routeStored) {
        plan.overridden.add("route");
      }
    }
    this.planCache = plan;
    return plan;
  }
  armSavedTimer() {
    this.clearSavedTimer();
    this.savedTimer = setTimeout(() => {
      this.savedAt = void 0;
      this.notify();
    }, SAVED_MS);
  }
  clearSaved() {
    this.clearSavedTimer();
    this.savedAt = void 0;
  }
  clearSavedTimer() {
    if (this.savedTimer !== void 0) clearTimeout(this.savedTimer);
    this.savedTimer = void 0;
  }
  notify() {
    this.cache = null;
    this.planCache = null;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("memcurio: settings form listener failed", error);
      }
    }
  }
};

// client/settings/instant.ts
var UNDO_MS = 5e3;
var SAVED_MS2 = 2e3;
var InjectionSwitchModel = class {
  controller;
  onAccepted;
  value;
  pending = false;
  errorCode;
  undo;
  savedAt;
  cache = null;
  listeners = /* @__PURE__ */ new Set();
  startCount = 0;
  unsubscribe;
  undoTimer;
  savedTimer;
  /** Last intent wins: a slow earlier write must not overwrite a later click. */
  generation = 0;
  disposed = false;
  constructor(controller, onAccepted) {
    this.controller = controller;
    this.onAccepted = onAccepted;
    this.value = controller.face().value.injectContext;
  }
  /** Attach to controller notifications; refcounted for safe effect teardown. */
  start() {
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
        this.unsubscribe = void 0;
      }
    };
  }
  faceHook() {
    return {
      getSnapshot: () => this.face(),
      subscribe: (listener) => this.subscribe(listener)
    };
  }
  face() {
    if (this.cache !== null) return this.cache;
    this.cache = {
      value: this.value,
      pending: this.pending,
      ...this.errorCode === void 0 ? {} : { errorCode: this.errorCode },
      ...this.undo === void 0 ? {} : { undo: this.undo },
      ...this.savedAt === void 0 ? {} : { savedAt: this.savedAt }
    };
    return this.cache;
  }
  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  /** Apply the switch with an optimistic paint and a verified rollback. */
  async toggle(next) {
    if (this.disposed || this.pending) return { ok: false, code: ERROR_KEYS.notReady };
    if (next === this.value) return { ok: true };
    const previous = this.value;
    const beforeRevision = this.controller.revision();
    const generation = ++this.generation;
    this.value = next;
    this.pending = true;
    this.errorCode = void 0;
    this.undo = void 0;
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
  async reset() {
    if (this.disposed || this.pending) return { ok: false, code: ERROR_KEYS.notReady };
    const previous = this.value;
    const beforeRevision = this.controller.revision();
    const generation = ++this.generation;
    this.pending = true;
    this.errorCode = void 0;
    this.undo = void 0;
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
  /** Drop a stale failure copy. The staged zone calls this after its own
   *  successful save: two independent error slots are correct, but a resolved
   *  save must not leave "Save failed" next to "Saved" on the same screen. */
  clearError() {
    if (this.errorCode === void 0) return;
    this.errorCode = void 0;
    this.notify();
  }
  /** Re-apply the value captured before the last accepted change. */
  async undoLast() {
    const previous = this.undo?.value;
    if (previous === void 0) return { ok: false, code: ERROR_KEYS.notReady };
    this.undo = void 0;
    this.notify();
    const outcome = await this.toggle(previous);
    if (!outcome.ok && !this.disposed) {
      this.undo = { value: previous };
      this.notify();
    }
    return outcome;
  }
  /** Drop timers/listeners with the panel fiber. */
  dispose() {
    this.disposed = true;
    this.generation += 1;
    this.clearTimers();
    this.listeners.clear();
    this.unsubscribe?.();
    this.unsubscribe = void 0;
  }
  sync() {
    if (this.disposed || this.pending) return;
    const next = this.current();
    if (next === this.value) return;
    this.value = next;
    this.errorCode = void 0;
    this.undo = void 0;
    this.savedAt = void 0;
    this.clearTimers();
    this.notify();
  }
  current() {
    return this.controller.face().value.injectContext;
  }
  armTimers() {
    this.clearTimers();
    this.undoTimer = setTimeout(() => {
      this.undo = void 0;
      this.notify();
    }, UNDO_MS);
    this.savedTimer = setTimeout(() => {
      this.savedAt = void 0;
      this.notify();
    }, SAVED_MS2);
  }
  clearSaved() {
    this.savedAt = void 0;
  }
  clearTimers() {
    if (this.undoTimer !== void 0) clearTimeout(this.undoTimer);
    if (this.savedTimer !== void 0) clearTimeout(this.savedTimer);
    this.undoTimer = void 0;
    this.savedTimer = void 0;
  }
  notify() {
    this.cache = null;
    for (const listener of this.listeners) {
      try {
        listener();
      } catch (error) {
        console.error("memcurio: instant switch listener failed", error);
      }
    }
  }
};

// client/ui/icons.ts
var import_react3 = require("react");
var MEMORY_MARK_PATHS = [
  "M5 6a3 3 0 0 1 3-3h11v18H8a3 3 0 0 1-3-3V6Z",
  "M5 18a3 3 0 0 1 3-3h11",
  "M10 3v6l2-1.5L14 9V3"
];
var CONTEXT_INJECTION_PATHS = [
  "M11.9512 1.13281C12.401 1.20666 12.8093 1.34164 13.1738 1.60645C13.4282 1.79137 13.6521 2.01609 13.8369 2.27051C14.1574 2.71187 14.2892 3.21614 14.3506 3.78223C14.4105 4.33532 14.4102 5.02658 14.4102 5.87305V10.0273C14.4102 10.8738 14.4105 11.5651 14.3506 12.1182C14.2892 12.6843 14.1574 13.1885 13.8369 13.6299C13.652 13.8843 13.4282 14.109 13.1738 14.2939C12.7324 14.6146 12.2273 14.7462 11.6611 14.8076C11.1081 14.8675 10.4166 14.8672 9.57031 14.8672H6.43164C5.58533 14.8672 4.89387 14.8675 4.34082 14.8076C3.77474 14.7463 3.27046 14.6144 2.8291 14.2939C2.57453 14.109 2.35003 13.8844 2.16504 13.6299C1.84444 13.1885 1.71272 12.6844 1.65137 12.1182C1.59147 11.5651 1.5918 10.8738 1.5918 10.0273V5.87305C1.5918 5.02655 1.59146 4.33533 1.65137 3.78223C1.71272 3.21606 1.84443 2.71191 2.16504 2.27051C2.35003 2.01596 2.57453 1.79141 2.8291 1.60645C3.19332 1.34202 3.60062 1.20669 4.0498 1.13281V2.56445C3.87191 2.61154 3.74906 2.66836 3.65137 2.73926C3.51583 2.83777 3.3964 2.95726 3.29785 3.09277C3.1794 3.25581 3.09143 3.4856 3.04297 3.93262C2.9931 4.39287 2.99219 4.99529 2.99219 5.87305V10.0273C2.99219 10.905 2.99312 11.5075 3.04297 11.9678C3.09142 12.4147 3.17943 12.6446 3.29785 12.8076C3.3964 12.9431 3.51583 13.0626 3.65137 13.1611C3.81441 13.2795 4.04437 13.3676 4.49121 13.416C4.95142 13.4658 5.55411 13.4668 6.43164 13.4668H9.57031C10.4479 13.4668 11.0505 13.4659 11.5107 13.416C11.9576 13.3675 12.1876 13.2796 12.3506 13.1611C12.4861 13.0626 12.6056 12.9431 12.7041 12.8076C12.8224 12.6446 12.9106 12.4146 12.959 11.9678C13.0088 11.5075 13.0098 10.905 13.0098 10.0273V5.87305C13.0098 4.99532 13.0088 4.39286 12.959 3.93262C12.9105 3.48579 12.8225 3.2558 12.7041 3.09277C12.6056 2.95727 12.4861 2.83778 12.3506 2.73926C12.2527 2.66816 12.1296 2.61064 11.9512 2.56348V1.13281Z",
  "M9.32227 11.4141H4.95508V10.2148H9.32227V11.4141Z",
  "M11.0439 8.90039H4.95508V7.70117H11.0439V8.90039Z",
  "M8.59961 3.75781L9.70996 2.64746L10.5586 3.49609L8.49512 5.55957C8.22173 5.83266 7.77816 5.83285 7.50488 5.55957L5.44141 3.49512L6.28906 2.64746L7.40039 3.75781V1.09668H8.59961V3.75781Z"
];
function memoryMarkSvg(size = 14) {
  const paths = MEMORY_MARK_PATHS.map((d) => `<path d="${d}"/>`).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
}
function contextInjectionSvg(size = 14) {
  const paths = CONTEXT_INJECTION_PATHS.map((d) => `<path d="${d}" fill="currentColor"/>`).join("");
  return `<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" aria-hidden="true">${paths}</svg>`;
}
function memoryMarkMaskDataUrl() {
  const paths = MEMORY_MARK_PATHS.map((d) => `<path d="${d}"/>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${paths}</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
function MemoryMarkIcon({ size = 14 }) {
  return (0, import_react3.createElement)(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      focusable: "false"
    },
    ...MEMORY_MARK_PATHS.map((d) => (0, import_react3.createElement)("path", { key: d, d }))
  );
}
function ChevronDownIcon({ size = 14 }) {
  return (0, import_react3.createElement)(
    "svg",
    {
      width: size,
      height: size,
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: 2,
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": true,
      focusable: "false"
    },
    (0, import_react3.createElement)("path", { d: "M6 9l6 6 6-6" })
  );
}

// client/settings/styles.ts
var STYLE_ID = "memcurio-settings-css";
var NAV_MARK = memoryMarkMaskDataUrl();
var CSS = `
.memcurio-settings { display: flex; flex-direction: column; gap: 20px; max-width: 100%; color: var(--dsw-alias-label-primary); }
.memcurio-settings-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.memcurio-settings-header-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.memcurio-settings-header h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.memcurio-settings-header-text p { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }

.memcurio-settings-status { display: inline-flex; flex: none; align-items: center; gap: 6px; min-height: 24px; padding: 2px 8px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform); font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.memcurio-settings-status-dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--dsw-alias-border-l3); }
.memcurio-settings-status[data-tone="success"] .memcurio-settings-status-dot { background: var(--dsw-alias-state-success-primary); }
.memcurio-settings-status[data-tone="warning"] .memcurio-settings-status-dot { background: var(--dsw-alias-state-warn-primary); }
.memcurio-settings-status[data-tone="error"] .memcurio-settings-status-dot { background: var(--dsw-alias-state-error-primary); }
.memcurio-settings-status[data-tone="neutral"] .memcurio-settings-status-dot { background: var(--dsw-alias-label-tertiary); }

.memcurio-settings-zone { display: flex; flex-direction: column; gap: 8px; }
.memcurio-settings-zone-label { font-size: 12px; line-height: 18px; font-weight: 500; color: var(--dsw-alias-label-tertiary); }
.memcurio-settings-card { display: flex; flex-direction: column; gap: 10px; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); }
.memcurio-settings-instant-row { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; }
.memcurio-settings-instant-text { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.memcurio-settings-instant-label { font-size: 14px; line-height: 20px; font-weight: 500; cursor: pointer; }
.memcurio-settings-instant-label:hover { color: var(--dsw-alias-brand-primary); }
.memcurio-settings-instant-control { display: flex; flex: none; align-items: center; gap: 10px; }
.memcurio-settings-instant-state { font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.memcurio-settings-instant-actions { display: flex; justify-content: flex-end; }
.memcurio-settings-meta { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.memcurio-settings-status-line { display: flex; align-items: center; gap: 4px; margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }

.memcurio-settings-switch { box-sizing: border-box; appearance: none; -webkit-appearance: none; position: relative; flex: 0 0 auto; width: 36px; height: 20px; margin: 0; padding: 0; border: 0; border-radius: 10px; background: var(--dsw-alias-border-l3); cursor: pointer; }
.memcurio-settings-switch::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: var(--dsw-alias-label-primary-foreground); transition: transform 120ms ease; }
.memcurio-settings-switch:checked, .memcurio-settings-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.memcurio-settings-switch:checked::after, .memcurio-settings-switch[aria-checked="true"]::after { transform: translateX(16px); }
.memcurio-settings-switch:disabled { cursor: default; opacity: 0.5; }
.memcurio-settings-switch:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }

.memcurio-settings-form { display: flex; flex-direction: column; gap: 8px; }
.memcurio-settings-form-body { display: flex; flex-direction: column; }
.memcurio-settings-field { display: flex; flex-direction: column; gap: 6px; padding: 12px 0; }
.memcurio-settings-form-body > .memcurio-settings-field:first-child { padding-top: 4px; }
.memcurio-settings-field + .memcurio-settings-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.memcurio-settings-field-head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.memcurio-settings-field-label { flex: 1 1 auto; min-width: 0; font-size: 13px; line-height: 1.5; font-weight: 500; color: var(--dsw-alias-label-primary); }
.memcurio-settings-badges { display: inline-flex; flex: none; align-items: center; gap: 8px; }
.memcurio-settings-tag { display: inline-flex; align-items: center; min-height: 18px; padding: 0 6px; border-radius: 999px; background: var(--dsw-alias-bg-module-platform); font-size: 11px; line-height: 18px; font-weight: 500; white-space: nowrap; color: var(--dsw-alias-label-secondary); }
.memcurio-settings-tag[data-tone="warning"] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-warn-label); }
.memcurio-settings-tag[data-tone="warning"] { background: color-mix(in srgb, var(--dsw-alias-state-warn-primary) 12%, transparent); }
.memcurio-settings-tag[data-tone="error"] { background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-state-error-primary); }
.memcurio-settings-tag[data-tone="error"] { background: color-mix(in srgb, var(--dsw-alias-state-error-primary) 12%, transparent); }
.memcurio-settings-reset { min-height: 24px; padding: 0; border: 0; background: none; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.memcurio-settings-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); text-decoration: underline; }
.memcurio-settings-reset:disabled { cursor: default; opacity: 0.5; }
.memcurio-settings-reset:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }

.memcurio-settings-input-wrap { display: flex; align-items: center; box-sizing: border-box; width: 100%; height: 34px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); }
.memcurio-settings-input-wrap:focus-within { border-color: var(--dsw-alias-state-business-primary); }
.memcurio-settings-input-wrap[data-invalid="true"], .memcurio-settings-input-wrap:has(input[aria-invalid="true"]) { border-color: var(--dsw-alias-state-error-primary); }
.memcurio-settings-input { box-sizing: border-box; flex: 1 1 auto; min-width: 0; height: 32px; padding: 0 12px; border: 0; border-radius: var(--dsw-radius-md); background: transparent; font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.memcurio-settings-input:focus { outline: none; }
.memcurio-settings-input:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.memcurio-settings-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.memcurio-settings-pair .memcurio-settings-input { width: 100%; height: 34px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); }
.memcurio-settings-pair .memcurio-settings-input:focus-visible { border-color: var(--dsw-alias-state-business-primary); outline: none; }
.memcurio-settings-pair .memcurio-settings-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.memcurio-settings-input-suffix { flex: none; padding: 0 12px 0 4px; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.memcurio-settings-hint { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-tertiary); }
.memcurio-settings-error { margin: 0; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-state-error-primary); }
.memcurio-settings-warn { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-label); }
.memcurio-settings-note { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.memcurio-settings-empty { margin: 0; padding: 16px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-secondary); }

.memcurio-settings-choice-group { display: flex; flex-wrap: wrap; gap: 8px; margin: 0; padding: 0; border: 0; min-width: 0; }
.memcurio-settings-choice { position: relative; display: inline-flex; align-items: center; gap: 8px; box-sizing: border-box; min-height: 32px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); cursor: pointer; }
.memcurio-settings-choice:hover { background: var(--dsw-alias-interactive-bg-hover); }
.memcurio-settings-choice[data-selected="true"] { border-color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-bg-module-platform); }
.memcurio-settings-choice[data-selected="true"] { background: color-mix(in srgb, var(--dsw-alias-brand-primary) 8%, var(--dsw-alias-bg-layer-3)); }
.memcurio-settings-choice:focus-within { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.memcurio-settings-choice input { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
.memcurio-settings-choice-label { min-width: 0; }
.memcurio-settings-choice[data-disabled="true"], .memcurio-settings-choice:has(input:disabled) { cursor: default; opacity: 0.5; }
.memcurio-settings-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 12px; }
.memcurio-settings-pair-field { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
.memcurio-settings-check-row { display: flex; align-items: flex-start; gap: 10px; }
.memcurio-settings-checkbox { flex: none; width: 16px; height: 16px; margin: 2px 0 0; accent-color: var(--dsw-alias-brand-primary); }
.memcurio-settings-checkbox:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.memcurio-settings-checkbox:disabled { cursor: default; opacity: 0.5; }

.memcurio-settings-advanced { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.memcurio-settings-advanced-toggle { box-sizing: border-box; display: flex; align-items: center; gap: 8px; width: 100%; min-height: 40px; padding: 0; border: 0; background: none; font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); cursor: pointer; text-align: left; }
.memcurio-settings-advanced-toggle:hover .memcurio-settings-advanced-title { color: var(--dsw-alias-brand-primary); }
.memcurio-settings-advanced-toggle:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.memcurio-settings-advanced-title { flex: 1 1 auto; font-weight: 500; }
.memcurio-settings-chevron { flex: none; width: 7px; height: 7px; margin-right: 4px; border-right: 1.5px solid var(--dsw-alias-label-tertiary); border-bottom: 1.5px solid var(--dsw-alias-label-tertiary); transform: rotate(45deg); transition: transform 120ms ease; }
.memcurio-settings-advanced-toggle[aria-expanded="true"] .memcurio-settings-chevron { transform: rotate(-135deg); }
.memcurio-settings-advanced-panel { display: flex; flex-direction: column; }
.memcurio-settings-advanced-panel[hidden] { display: none; }

.memcurio-settings-footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding-top: 12px; border-top: 0.5px solid var(--dsw-alias-border-l2); flex-wrap: wrap; }
.memcurio-settings-footer-left, .memcurio-settings-footer-right { display: flex; align-items: center; gap: 8px; }
.memcurio-settings-footer-right { margin-left: auto; }
.memcurio-settings-footer-status-wrap { flex: 1 1 100%; min-width: 0; border-radius: var(--dsw-radius-sm); }
.memcurio-settings-footer-status-wrap:focus { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.memcurio-settings-footer-status { flex: 1 1 100%; min-width: 0; margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.memcurio-settings-footer-status.memcurio-settings-error { color: var(--dsw-alias-state-error-primary); }
.memcurio-settings-footer-status.memcurio-settings-warn { color: var(--dsw-alias-state-warn-label); }
.memcurio-settings-button { display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box; height: 32px; padding: 0 14px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: var(--dsw-radius-md); background: none; font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); cursor: pointer; }
.memcurio-settings-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.memcurio-settings-button:disabled { opacity: 0.4; cursor: default; }
.memcurio-settings-button:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }
.memcurio-settings-button-primary { border-color: transparent; background: var(--dsw-alias-label-primary); color: var(--dsw-alias-bg-layer-3); }
.memcurio-settings-button-primary:hover:not(:disabled) { background: var(--dsw-alias-label-secondary); }
.memcurio-settings-link { min-height: 24px; padding: 0 4px; border: 0; background: none; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-brand-primary); cursor: pointer; }
.memcurio-settings-link:hover:not(:disabled) { text-decoration: underline; }
.memcurio-settings-link:disabled { opacity: 0.4; cursor: default; }
.memcurio-settings-link:focus-visible { outline: var(--dsw-focus-ring-width, 2px) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 1px; }

.memcurio-settings-skeleton { display: flex; flex-direction: column; gap: 12px; padding-top: 8px; }
.memcurio-settings-skeleton-bar { display: block; height: 34px; border-radius: var(--dsw-radius-md); background: var(--dsw-alias-bg-layer-3); animation: memcurio-settings-pulse 1.4s ease-in-out infinite; }
.memcurio-settings-skeleton-bar:nth-child(2) { width: 72%; }
.memcurio-settings-skeleton-bar:nth-child(3) { width: 48%; }
@keyframes memcurio-settings-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.45; } }

.memcurio-settings-sr-only { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }

@media (max-width: 640px) {
  .memcurio-settings-header { flex-direction: column; gap: 8px; }
  .memcurio-settings-instant-row { flex-direction: column; gap: 12px; }
  .memcurio-settings-instant-control { align-self: flex-start; }
  .memcurio-settings-pair { grid-template-columns: minmax(0, 1fr); }
  .memcurio-settings-footer { align-items: stretch; }
  .memcurio-settings-footer-left, .memcurio-settings-footer-right { width: 100%; }
  .memcurio-settings-footer-right { justify-content: flex-end; }
  .memcurio-settings-footer-left .memcurio-settings-button,
  .memcurio-settings-footer-right .memcurio-settings-button { flex: 1 1 auto; }
}
@media (prefers-reduced-motion: reduce) {
  .memcurio-settings-switch::after, .memcurio-settings-chevron { transition: none; }
  .memcurio-settings-skeleton-bar { animation: none; }
}
@supports ((mask-image: linear-gradient(#000, #000)) or (-webkit-mask-image: linear-gradient(#000, #000))) {
  [data-memcurio-nav] > svg { display: none; }
  [data-memcurio-nav]::before { content: ""; flex: none; width: 16px; height: 16px; background-color: currentColor; -webkit-mask-image: ${NAV_MARK}; -webkit-mask-position: center; -webkit-mask-size: 16px 16px; -webkit-mask-repeat: no-repeat; mask-image: ${NAV_MARK}; mask-position: center; mask-size: 16px 16px; mask-repeat: no-repeat; mask-mode: alpha; }
}
`;
var holders = 0;
function mountStyles() {
  if (typeof document === "undefined") return () => void 0;
  holders += 1;
  let tag = document.getElementById(STYLE_ID);
  if (tag === null) {
    tag = document.createElement("style");
    tag.id = STYLE_ID;
    tag.setAttribute("data-plugin-css", "memcurio");
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders = Math.max(0, holders - 1);
    if (holders === 0) tag?.remove();
  };
}

// client/ui/context-row.ts
var import_react4 = require("react");

// client/ui/chat-node-registration.ts
var CHAT_NODE_SEAT = "conversation.chat.node";
function registerChatNodeRow(ctx, spec) {
  if (typeof ctx.inject !== "function") return;
  try {
    ctx.inject(["uiConversation"], (scope) => {
      try {
        scope.effect(() => {
          const disposeDefinition = scope.uiConversation.events.register(spec.createDefinition());
          scope.slots.inject(CHAT_NODE_SEAT, () => {
            scope.slots.register({ name: CHAT_NODE_SEAT, key: spec.kind, locale: spec.locale }, spec.component);
            return void 0;
          });
          return () => {
            if (typeof disposeDefinition === "function") disposeDefinition();
          };
        }, spec.label);
      } catch {
      }
    });
  } catch {
  }
}

// client/ui/locales.ts
var NS2 = "memcurio.ui";
var en2 = {
  nav: "Memory",
  statusIdle: "No memory injected in this session",
  statusStatic: "Memory summary injected",
  statusTokens: "~{tokens} tokens",
  statusDegraded: "Realtime degraded (polling)",
  statusOffline: "Memory UI offline",
  statusDisabled: "Memory injection off",
  contextRowTitle: "Memory injection",
  guideRowTitle: "Memory guide",
  guideRowDetail: "{chars} chars \xB7 {tools} memory tools",
  panelInjection: "Injection",
  panelNoInjection: "No memory was injected into this session yet.",
  panelInjectionOff: "Memory injection is off for this instance.",
  panelInjectionPaused: "Injection is off; the values below are the last ones from before it was switched off.",
  panelStatic: "Static context",
  panelReadGuide: "Read guide",
  panelBudget: "Budget",
  panelReceipts: "Recent memory writes",
  panelNoReceipts: "No memory writes recorded.",
  toastInjectedStatic: "Memory summary injected \xB7 ~{tokens} tokens",
  toastNote: "Memory note saved",
  toastRollout: "Memory extracted from this session",
  toastConsolidate: "Memory consolidated",
  toastPrune: "Memory pruned",
  toastPurge: "Memory purged",
  toastWrite: "Memory updated",
  actionExtract: "Extraction",
  actionAdhoc: "Note",
  actionConsolidate: "Consolidation",
  actionPrune: "Prune",
  actionPurge: "Purge",
  actionOther: "Memory write",
  toolRunning: "Running\u2026",
  toolFailed: "Failed",
  toolStopped: "Interrupted",
  toolEmpty: "No details",
  toolArguments: "Arguments",
  toolResult: "Result"
};
var zh2 = {
  nav: "\u8BB0\u5FC6",
  statusIdle: "\u672C\u4F1A\u8BDD\u5C1A\u672A\u6CE8\u5165\u8BB0\u5FC6",
  statusStatic: "\u5DF2\u6CE8\u5165\u8BB0\u5FC6\u6458\u8981",
  statusTokens: "\u7EA6 {tokens} tokens",
  statusDegraded: "\u5B9E\u65F6\u6027\u964D\u7EA7\uFF08\u8F6E\u8BE2\u4E2D\uFF09",
  statusOffline: "\u8BB0\u5FC6\u754C\u9762\u79BB\u7EBF",
  statusDisabled: "\u8BB0\u5FC6\u6CE8\u5165\u5DF2\u5173\u95ED",
  contextRowTitle: "\u8BB0\u5FC6\u6CE8\u5165",
  guideRowTitle: "\u8BB0\u5FC6\u6307\u5357",
  guideRowDetail: "{chars} \u5B57\u7B26 \xB7 {tools} \u4E2A\u8BB0\u5FC6\u5DE5\u5177",
  panelInjection: "\u6CE8\u5165\u9762",
  panelNoInjection: "\u672C\u4F1A\u8BDD\u5C1A\u672A\u6CE8\u5165\u4EFB\u4F55\u8BB0\u5FC6\u3002",
  panelInjectionOff: "\u672C\u5B9E\u4F8B\u7684\u8BB0\u5FC6\u6CE8\u5165\u5DF2\u5173\u95ED\u3002",
  panelInjectionPaused: "\u6CE8\u5165\u5DF2\u5173\u95ED\uFF1B\u4EE5\u4E0B\u4E3A\u5173\u95ED\u524D\u6700\u8FD1\u4E00\u6B21\u7684\u503C\u3002",
  panelStatic: "\u9759\u6001\u4E0A\u4E0B\u6587",
  panelReadGuide: "\u8BFB\u53D6\u6307\u5F15",
  panelBudget: "\u9884\u7B97",
  panelReceipts: "\u6700\u8FD1\u5199\u5165",
  panelNoReceipts: "\u6682\u65E0\u8BB0\u5FC6\u5199\u5165\u8BB0\u5F55\u3002",
  toastInjectedStatic: "\u5DF2\u6CE8\u5165\u8BB0\u5FC6\u6458\u8981 \xB7 \u7EA6 {tokens} tokens",
  toastNote: "\u8BB0\u5FC6\u7B14\u8BB0\u5DF2\u4FDD\u5B58",
  toastRollout: "\u5DF2\u4ECE\u672C\u4F1A\u8BDD\u62BD\u53D6\u8BB0\u5FC6",
  toastConsolidate: "\u8BB0\u5FC6\u5DF2\u6574\u5408",
  toastPrune: "\u8BB0\u5FC6\u5DF2\u88C1\u526A",
  toastPurge: "\u8BB0\u5FC6\u5DF2\u6E05\u9664",
  toastWrite: "\u8BB0\u5FC6\u5DF2\u66F4\u65B0",
  actionExtract: "\u62BD\u53D6",
  actionAdhoc: "\u7B14\u8BB0",
  actionConsolidate: "\u6574\u5408",
  actionPrune: "\u88C1\u526A",
  actionPurge: "\u6E05\u9664",
  actionOther: "\u5199\u5165",
  toolRunning: "\u8FD0\u884C\u4E2D\u2026",
  toolFailed: "\u5931\u8D25",
  toolStopped: "\u5DF2\u4E2D\u65AD",
  toolEmpty: "\u65E0\u8BE6\u60C5",
  toolArguments: "\u53C2\u6570",
  toolResult: "\u7ED3\u679C"
};

// client/ui/context-row.ts
var MEMCURIO_PLUGIN_ID = "@memcurio/dsh-plugin";
var MEMCURIO_MESSAGE_KIND = "memcurio";
var INJECTION_NODE_KIND = "memcurio-injection";
var h = import_react4.createElement;
function contextTextOf(content) {
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) {
      parts.push(String(raw));
      continue;
    }
    const part = raw;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else parts.push(JSON.stringify(raw));
  }
  return parts.join("\n");
}
function contextLabelOf(source) {
  if (typeof source === "object" && source !== null) {
    const plugin = source.plugin;
    if (typeof plugin === "string" && plugin !== "") return plugin;
  }
  return MEMCURIO_PLUGIN_ID;
}
function isMemcurioInjection(data) {
  if (data === void 0) return false;
  const source = data.source;
  if (typeof source !== "object" || source === null) return false;
  const record = source;
  if (record.kind === MEMCURIO_MESSAGE_KIND) return true;
  return record.kind === "plugin" && record.plugin === MEMCURIO_PLUGIN_ID;
}
function seqOf(event) {
  return typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : 0;
}
function matchIdOf(event) {
  const id = event.data?.id;
  return typeof id === "string" && id !== "" ? id : String(seqOf(event));
}
function createInjectionNodeDefinition() {
  return {
    kind: INJECTION_NODE_KIND,
    target: "chat",
    match(event) {
      if (event === null || typeof event !== "object") return null;
      if (event.type !== "user/message") return null;
      if (event.surfaceOp !== "append") return null;
      if (!isMemcurioInjection(event.data)) return null;
      return { id: matchIdOf(event), role: "start" };
    },
    start(_context, match) {
      const data = match.event.data;
      return { seq: seqOf(match.event), content: data?.content, source: data?.source };
    },
    update(context) {
      return context.state;
    },
    buildViewNode(context) {
      const state = context.state;
      if (state === void 0) return null;
      return {
        key: context.key,
        kind: INJECTION_NODE_KIND,
        id: context.id,
        target: "chat",
        // The message's own position; `location` stays the engine-resolved one
        // so the row groups into its turn exactly like the shipped node.
        anchorSeq: state.seq,
        location: context.start?.location ?? context.matches?.[0]?.location ?? { kind: "unresolved" },
        visibility: "visible",
        data: state
      };
    }
  };
}
function DisclosureLine(props) {
  const { title, label, text, icon } = props;
  const [open, setOpen] = (0, import_react4.useState)(false);
  const toggle = () => {
    setOpen((value) => !value);
  };
  return h(
    "div",
    { className: "memcurio-context", "data-open": open ? "true" : void 0 },
    h(
      "button",
      {
        type: "button",
        className: "memcurio-context-head",
        "aria-expanded": open,
        onClick: toggle
      },
      h("span", { className: "memcurio-context-icon" }, icon),
      h("span", { className: "memcurio-context-title" }, title),
      h("span", { className: "memcurio-context-sep", "aria-hidden": true }),
      h("span", { className: "memcurio-context-source", "data-context-source": true }, label),
      h("span", { className: "memcurio-context-chevron" }, h(ChevronDownIcon, {}))
    ),
    open && text !== "" ? h("div", { className: "memcurio-context-body", "data-context-injection-body": true }, text) : null
  );
}
function MemcurioInjectionRow(props) {
  return h(DisclosureLine, {
    title: props.t("contextRowTitle"),
    label: contextLabelOf(props.data?.source),
    text: contextTextOf(props.data?.content),
    // memcurio's own mark (book and ribbon) leads its own row.
    icon: h(MemoryMarkIcon, {})
  });
}
function MemcurioInjectionNodeRow(props) {
  const t = props.t ?? ((key) => key);
  return h(MemcurioInjectionRow, { t, data: props.node?.data });
}
function registerInjectionRow(ctx) {
  registerChatNodeRow(ctx, {
    createDefinition: createInjectionNodeDefinition,
    kind: INJECTION_NODE_KIND,
    component: MemcurioInjectionNodeRow,
    locale: NS2,
    label: "memcurio: injected-memory row"
  });
}

// client/ui/guide-row.ts
var import_react5 = require("react");
var GUIDE_NODE_KIND = "memcurio-guide-injected";
var GUIDE_HEADING = "## memory";
var GUIDE_TOOL_NAMES = [
  "memory_search",
  "memory_list",
  "memory_read",
  "memory_status",
  "memory_context",
  "memory_remember",
  "memory_cite"
];
var GUIDE_CARD_OFFSET = -0.1;
var GUIDE_NODE_LOCATION = { kind: "session" };
function promptTextOf(data) {
  if (typeof data !== "object" || data === null) return "";
  const message = data.message;
  if (typeof message !== "object" || message === null) return "";
  const content = message.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) continue;
    const part = raw;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}
function extractGuideSection(prompt) {
  const start = prompt.indexOf(GUIDE_HEADING);
  if (start < 0) return void 0;
  const next = prompt.indexOf("\n## ", start + GUIDE_HEADING.length);
  const section = (next < 0 ? prompt.slice(start) : prompt.slice(start, next)).trim();
  return section === "" ? void 0 : section;
}
function guideSignature(section) {
  let hash = 2166136261;
  for (let index = 0; index < section.length; index += 1) {
    hash ^= section.charCodeAt(index);
    hash = Math.imul(hash, 16777619) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}
function guideDetailOf(section) {
  return { chars: section.length, tools: GUIDE_TOOL_NAMES.length };
}
function seqOf2(event) {
  return typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : 0;
}
function locationSeq(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function anchorSeqOf(match) {
  const seq = seqOf2(match.event);
  const location = match.location;
  if (location?.kind !== "step") return seq + GUIDE_CARD_OFFSET;
  const turnStart = locationSeq(location.turn?.start?.seq);
  const stepStart = locationSeq(location.step?.start?.seq);
  const firstStep = location.step?.step === 1;
  const cardAnchor = firstStep ? turnStart ?? stepStart ?? seq : stepStart ?? seq;
  return cardAnchor + GUIDE_CARD_OFFSET;
}
function previousStateOf(reader) {
  try {
    return reader?.previous(GUIDE_NODE_KIND)?.state;
  } catch {
    return void 0;
  }
}
function createGuideNodeDefinition() {
  return {
    kind: GUIDE_NODE_KIND,
    target: "chat",
    match(event) {
      if (event === null || typeof event !== "object") return null;
      if (event.type !== "system/message") return null;
      return { id: String(seqOf2(event)), role: "start" };
    },
    start(_context, match, reader) {
      const section = extractGuideSection(promptTextOf(match.event.data));
      const signature = section === void 0 ? "" : guideSignature(section);
      const detail = section === void 0 ? { chars: 0, tools: 0 } : guideDetailOf(section);
      const previous = previousStateOf(reader);
      return {
        signature,
        chars: detail.chars,
        tools: detail.tools,
        text: section ?? "",
        anchorSeq: anchorSeqOf(match),
        unchanged: previous !== void 0 && previous.signature === signature
      };
    },
    update(context) {
      return context.state;
    },
    buildViewNode(context) {
      const state = context.state;
      if (state === void 0) return null;
      const visible = state.signature !== "" && !state.unchanged;
      const current = context.current?.get("chat");
      const materialized = (current ?? null) !== null;
      if (!visible && !materialized) return null;
      const anchorSeq = typeof current?.anchorSeq === "number" ? current.anchorSeq : state.anchorSeq;
      return {
        key: context.key,
        kind: GUIDE_NODE_KIND,
        id: context.id,
        target: "chat",
        anchorSeq,
        location: GUIDE_NODE_LOCATION,
        visibility: visible ? "visible" : "hidden",
        data: { chars: state.chars, tools: state.tools, text: state.text }
      };
    }
  };
}
function MemcurioGuideRow(props) {
  const [open, setOpen] = (0, import_react5.useState)(false);
  const data = props.node?.data;
  if (data === void 0) return null;
  const text = typeof data.text === "string" ? data.text : "";
  const chars = typeof data.chars === "number" ? data.chars : text.length;
  const tools = typeof data.tools === "number" ? data.tools : 0;
  const t = props.t ?? ((key) => key);
  const toggle = () => {
    setOpen((value) => !value);
  };
  return (0, import_react5.createElement)(
    "div",
    {
      className: "memcurio-context",
      "data-open": open ? "true" : void 0,
      "data-memcurio-guide": ""
    },
    (0, import_react5.createElement)(
      "button",
      {
        type: "button",
        className: "memcurio-context-head",
        "aria-expanded": open,
        onClick: toggle
      },
      (0, import_react5.createElement)("span", { className: "memcurio-context-icon" }, (0, import_react5.createElement)(MemoryMarkIcon, {})),
      // Collapsed line: the mark and the short title only. The measured facts
      // (characters, named tools) open the expanded body — the MCP-row
      // convention, where the collapsed row stays a quiet one-liner.
      (0, import_react5.createElement)("span", { className: "memcurio-context-title" }, t("guideRowTitle")),
      (0, import_react5.createElement)("span", { className: "memcurio-context-chevron" }, (0, import_react5.createElement)(ChevronDownIcon, {}))
    ),
    open && text !== "" ? (0, import_react5.createElement)(
      "div",
      { className: "memcurio-context-body", "data-memcurio-guide-body": true },
      t("guideRowDetail", { chars, tools }),
      "\n\n",
      text
    ) : null
  );
}
function registerGuideRow(ctx) {
  registerChatNodeRow(ctx, {
    createDefinition: createGuideNodeDefinition,
    kind: GUIDE_NODE_KIND,
    component: MemcurioGuideRow,
    locale: NS2,
    label: "memcurio: system-prompt guide row"
  });
}

// client/ui/model.ts
function estimateTokens(text) {
  if (text === void 0 || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
function shouldAnnounceInjection(event) {
  return !event.duplicate && event.tokens > 0;
}
function injectionView(input) {
  const staticText = input.staticText?.trim() ?? "";
  const readGuide = input.readGuide?.trim() ?? "";
  return {
    ...staticText ? { staticText } : {},
    ...readGuide ? { readGuide } : {},
    ...input.budgetTokens !== void 0 ? { budgetTokens: input.budgetTokens } : {},
    tokens: estimateTokens(staticText),
    at: Date.now(),
    duplicate: input.duplicate === true
  };
}
var WRITE_PATH_ACTIONS = ["extract.", "adhoc.", "consolidate.", "prune.", "purge."];
var NON_WRITE_EXTRACT_ACTIONS = /* @__PURE__ */ new Set([
  "extract.noop",
  "extract.stale",
  "extract.repaired",
  "extract.requeued",
  "extract.queued",
  "extract.queue_complete",
  "extract.queue_retry",
  "extract.queue_dead",
  "extract.queue_blocked",
  "extract.queue_unblocked",
  "extract.queue_released"
]);
var NON_WRITE_OTHER_ACTIONS = /* @__PURE__ */ new Set([
  "consolidate.auto_aborted",
  "consolidate.auto_unavailable",
  "consolidate.auto_contended"
]);
function isWritePathAction(action) {
  if (NON_WRITE_EXTRACT_ACTIONS.has(action) || NON_WRITE_OTHER_ACTIONS.has(action)) {
    return false;
  }
  return WRITE_PATH_ACTIONS.some((prefix) => action.startsWith(prefix));
}
function actionCategory(action) {
  if (action.startsWith("extract.") || action.startsWith("backfill.")) return "extract";
  if (action.startsWith("adhoc.")) return "adhoc";
  if (action.startsWith("consolidate.")) return "consolidate";
  if (action.startsWith("prune.")) return "prune";
  if (action.startsWith("purge.")) return "purge";
  return "other";
}
var RECEIPT_LIMIT = 30;
function receiptKey(at, action, detail) {
  return `${String(at)}|${action}|${detail}`;
}
function receiptAt(time) {
  const parsed = typeof time === "number" ? time : Date.parse(time);
  return Number.isFinite(parsed) ? parsed : Date.now();
}
function snapshotReceipt(row) {
  const at = receiptAt(row.time);
  return {
    key: receiptKey(at, row.action, row.detail),
    action: row.action,
    ...row.object ? { object: row.object } : {},
    detail: row.detail,
    at
  };
}
function deltaReceipt(delta) {
  return {
    key: receiptKey(delta.time, delta.action, delta.detail),
    action: delta.action,
    ...delta.object ? { object: delta.object } : {},
    detail: delta.detail,
    at: delta.time
  };
}
function sameInjection(left, right) {
  if (left === null || right === null) return left === right;
  return left.staticText === right.staticText && left.readGuide === right.readGuide && left.budgetTokens === right.budgetTokens && left.tokens === right.tokens && // `duplicate` is state too: without it a repeat fold of the same content
  // would keep the previous flag and a repeated static part would never
  // read as a duplicate.
  left.duplicate === right.duplicate;
}
function sameReceipts(left, right) {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index]?.key !== right[index]?.key) return false;
  }
  return true;
}
function createMemoryUiStore() {
  let state = { injection: null, receipts: [], unread: 0, realtime: "off" };
  let receiptsSeeded = false;
  const listeners = /* @__PURE__ */ new Set();
  const emit = () => {
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch (error) {
        console.error("memcurio: memory UI listener failed", error);
      }
    }
  };
  const set = (next) => {
    state = { ...state, ...next };
    emit();
  };
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    applySnapshot(snapshot) {
      const events = [];
      const source = snapshot.injection;
      const staticText = source.staticSummary?.trim() ?? "";
      const hasContent = Boolean(staticText || source.readGuide?.trim());
      const previous = state.injection;
      const injection = hasContent ? injectionView({
        staticText: source.staticSummary,
        readGuide: source.readGuide,
        budgetTokens: snapshot.settings?.injectBudgetTokens,
        // Compare the TRIMMED text the view stores (injectionView trims):
        // a static summary with trailing whitespace is still the same
        // static part.
        duplicate: (previous?.staticText ?? "") === staticText
      }) : null;
      const receipts = snapshot.receipts.filter((row) => row.writePath && isWritePathAction(row.action)).slice(0, RECEIPT_LIMIT).map(snapshotReceipt);
      let unread = state.unread;
      if (receiptsSeeded) {
        const known = new Set(state.receipts.map((receipt) => receipt.key));
        for (const receipt of receipts) {
          if (known.has(receipt.key)) continue;
          unread += 1;
          events.push({ type: "write", action: receipt.action });
        }
      }
      receiptsSeeded = true;
      if (!sameInjection(state.injection, injection) || !sameReceipts(state.receipts, receipts) || state.unread !== unread) {
        set({ injection, receipts, unread });
      }
      return events;
    },
    applyDeltas(deltas, sessionId) {
      const events = [];
      let injection = state.injection;
      let receipts = state.receipts;
      let unread = state.unread;
      let changed = false;
      for (const delta of deltas) {
        const deltaSessionId = delta.sessionId;
        if (typeof deltaSessionId === "string" && deltaSessionId !== sessionId) continue;
        if (delta.kind === "inject-updated") {
          const previous = injection;
          injection = injectionView({
            staticText: delta.staticText ?? previous?.staticText,
            readGuide: previous?.readGuide,
            budgetTokens: delta.budgetTokens ?? previous?.budgetTokens,
            duplicate: delta.staticText === void 0 ? delta.duplicate : (previous?.staticText ?? "") === delta.staticText.trim()
          });
          changed = true;
          events.push({ type: "injection", tokens: injection.tokens, duplicate: injection.duplicate });
        } else if (delta.kind === "receipt") {
          if (!isWritePathAction(delta.action)) continue;
          const receipt = deltaReceipt(delta);
          receipts = [receipt, ...receipts.filter((row) => row.key !== receipt.key)].slice(0, RECEIPT_LIMIT);
          unread += 1;
          changed = true;
          events.push({ type: "write", action: delta.action });
        }
      }
      if (changed) set({ injection, receipts, unread });
      return events;
    },
    setRealtime(mode) {
      if (state.realtime !== mode) set({ realtime: mode });
    },
    markSeen() {
      if (state.unread !== 0) set({ unread: 0 });
    },
    resetInjection() {
      if (state.injection !== null) set({ injection: null });
    },
    resetStoreView() {
      receiptsSeeded = false;
      if (state.injection !== null || state.receipts.length > 0 || state.unread !== 0) {
        set({ injection: null, receipts: [], unread: 0 });
      }
    }
  };
}

// client/ui/styles.ts
var STYLE_ID2 = "memcurio-ui-css";
var CSS2 = `
.memcurio-indicator { position: relative; display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary); font-size: 12px; line-height: 18px; cursor: pointer; }
.memcurio-indicator:hover { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.memcurio-indicator:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.memcurio-indicator[data-state="active"] { color: var(--dsw-alias-label-secondary); }
.memcurio-indicator[data-state="idle"] { color: var(--dsw-alias-label-dimmed); }
.memcurio-indicator[data-state="degraded"] { color: var(--dsw-alias-state-warn-primary); }
.memcurio-indicator[data-state="offline"] { color: var(--dsw-alias-label-dimmed); opacity: 0.72; }
.memcurio-indicator[data-state="disabled"] { color: var(--dsw-alias-label-dimmed); opacity: 0.72; }
.memcurio-indicator-count { font-variant-numeric: tabular-nums; font-weight: 600; }
.memcurio-indicator-unread { position: absolute; top: 1px; right: 2px; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary); }
.memcurio-popover { position: absolute; top: calc(100% + 8px); right: 0; z-index: 40; width: 320px; max-height: 60vh; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 12px; background: var(--dsw-alias-bg-layer-3); box-shadow: var(--dsw-shadow-lv3); color: var(--dsw-alias-label-primary); cursor: default; }
.memcurio-popover-head { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.memcurio-section { display: flex; flex-direction: column; gap: 4px; }
.memcurio-section-label { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary); text-transform: uppercase; letter-spacing: 0.04em; }
.memcurio-preview { margin: 0; max-height: 96px; overflow: auto; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-word; }
.memcurio-empty { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.memcurio-budget { display: flex; flex-direction: column; gap: 4px; }
.memcurio-budget-bar { height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l3); overflow: hidden; }
.memcurio-budget-fill { height: 100%; border-radius: 2px; background: var(--dsw-alias-brand-primary); }
.memcurio-receipt { display: flex; align-items: baseline; gap: 6px; font-size: 12px; line-height: 18px; }
.memcurio-receipt-time { flex: none; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-dimmed); }
.memcurio-receipt-action { flex: none; color: var(--dsw-alias-label-secondary); }
.memcurio-receipt-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary); }
.memcurio-toasts { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 90; display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; }
.memcurio-toast { display: inline-flex; align-items: center; gap: 8px; max-width: min(520px, 80vw); padding: 8px 14px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 10px; background: var(--dsw-alias-bg-layer-3); color: var(--dsw-alias-label-primary); font-size: 12px; line-height: 18px; box-shadow: var(--dsw-shadow-lv3); animation: memcurio-toast-in 160ms ease-out; }
.memcurio-toast-error { border-color: var(--dsw-alias-state-error-primary); }
.memcurio-toast-error .memcurio-toast-icon { color: var(--dsw-alias-state-error-primary); }
.memcurio-toast-out { opacity: 0; transition: opacity 360ms ease-in; }
.memcurio-toast-icon { display: inline-flex; flex: none; align-items: center; }
.memcurio-toast-text { min-width: 0; }
@keyframes memcurio-toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
.memcurio-tool { display: flex; flex-direction: column; margin: 2px 0; }
.memcurio-tool-head { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px 0 0; border-radius: 8px; cursor: default; }
.memcurio-tool-head[role="button"] { cursor: pointer; }
.memcurio-tool-head[role="button"]:hover { background: var(--dsw-alias-interactive-bg-hover); }
.memcurio-tool-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
.memcurio-tool-leading { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 16px; height: 16px; color: var(--dsw-alias-label-tertiary); }
.memcurio-tool-leading-chevron { display: none; }
.memcurio-tool-leading-chevron svg { transition: transform 120ms ease; }
.memcurio-tool-leading-chevron[data-open="true"] svg { transform: rotate(180deg); }
.memcurio-tool-head[role="button"]:hover .memcurio-tool-leading-state, .memcurio-tool-head[aria-expanded="true"] .memcurio-tool-leading-state { display: none; }
.memcurio-tool-head[role="button"]:hover .memcurio-tool-leading-chevron, .memcurio-tool-head[aria-expanded="true"] .memcurio-tool-leading-chevron { display: inline-flex; }
.memcurio-tool-head[data-state="running"] .memcurio-tool-leading { color: var(--dsw-alias-label-secondary); }
.memcurio-tool-head[data-state="error"] .memcurio-tool-leading { color: var(--dsw-alias-state-error-primary); }
.memcurio-tool-head[data-state="stopped"] .memcurio-tool-leading { color: var(--dsw-alias-state-warn-primary); }
.memcurio-tool-title { flex: none; font-size: 13px; line-height: 24px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.memcurio-tool-head[data-state="running"] .memcurio-tool-title { color: var(--dsw-alias-label-primary); }
.memcurio-tool-sep { flex: none; width: 2px; height: 2px; margin: 0 8px; border-radius: 1px; background: var(--dsw-alias-label-caption); }
.memcurio-tool-summary { flex: auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; line-height: 24px; color: var(--dsw-alias-label-tertiary); }
.memcurio-tool-summary-error { color: var(--dsw-alias-state-error-primary); }
.memcurio-tool-body { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 4px 8px; padding-left: 12px; border-left: 0.5px solid var(--dsw-alias-border-l2); }
.memcurio-tool-label { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
.memcurio-tool-code { margin: 0; max-height: 200px; overflow: auto; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary); }
.memcurio-tool-code[data-error] { color: var(--dsw-alias-state-error-primary); }
.memcurio-context { display: flex; flex-direction: column; min-width: 0; }
.memcurio-context[data-open="true"] { padding-bottom: 4px; }
.memcurio-context-head { display: flex; align-items: center; gap: 6px; width: 100%; height: 24px; padding: 0; border: 0; background: transparent; color: inherit; text-align: left; cursor: pointer; }
.memcurio-context-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; border-radius: 6px; }
.memcurio-context-icon { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 16px; height: 16px; color: var(--dsw-alias-label-secondary); }
.memcurio-context-title { flex: none; font-size: 13px; line-height: 24px; color: var(--dsw-alias-label-secondary); white-space: nowrap; }
.memcurio-context-sep { flex: none; width: 2px; height: 2px; margin: 0 8px; border-radius: 1px; background: var(--dsw-alias-label-caption); }
.memcurio-context-source { min-width: 0; flex: none; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 24px; color: var(--dsw-alias-label-tertiary); }
.memcurio-context-chevron { display: inline-flex; flex: none; margin-left: 4px; color: var(--dsw-alias-label-tertiary); }
.memcurio-context-chevron svg { transition: transform 120ms ease; }
.memcurio-context-head[aria-expanded="true"] .memcurio-context-chevron svg { transform: rotate(180deg); }
.memcurio-context-body { box-sizing: border-box; width: calc(100% - 22px); max-height: 141px; margin: 4px 0 0 22px; padding: 10px 16px 12px 12px; overflow: auto; border-radius: 8px; background: var(--dsw-alias-markdown-code-block); color: var(--dsw-alias-label-tertiary); font-family: var(--ds-font-family-code); font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-word; }
.memcurio-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
@media (prefers-reduced-motion: reduce) {
  .memcurio-toast { animation: none; }
  .memcurio-toast-out { transition: none; }
  .memcurio-tool-leading-chevron svg { transition: none; }
  .memcurio-context-chevron svg { transition: none; }
}
`;
var holders2 = 0;
function mountUiStyles() {
  if (typeof document === "undefined") return () => void 0;
  holders2 += 1;
  let tag = document.getElementById(STYLE_ID2);
  if (tag === null) {
    tag = document.createElement("style");
    tag.id = STYLE_ID2;
    tag.setAttribute("data-plugin-css", "memcurio");
    tag.textContent = CSS2;
    document.head.appendChild(tag);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holders2 = Math.max(0, holders2 - 1);
    if (holders2 === 0) tag?.remove();
  };
}

// client/ui/toast.ts
var HOLD_MS = 4200;
var MAX_TOASTS = 3;
var WARNING_SVG = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3 2.5 20h19L12 3Z"/><path d="M12 10v4M12 17.5v.01"/></svg>';
function iconSvg(icon) {
  if (icon === "injection") return contextInjectionSvg(16);
  if (icon === "warning") return WARNING_SVG;
  return memoryMarkSvg(16);
}
function createToastHost() {
  if (typeof document === "undefined" || document.body === null) {
    return { push: () => void 0, dispose: () => void 0 };
  }
  const layer = document.createElement("div");
  layer.className = "memcurio-toasts";
  document.body.append(layer);
  const live = /* @__PURE__ */ new Map();
  const remove = (key) => {
    const entry = live.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    entry.node.remove();
    live.delete(key);
  };
  return {
    push(spec) {
      const key = spec.key ?? spec.text;
      if (live.has(key)) return;
      while (live.size >= MAX_TOASTS) {
        const oldest = live.keys().next().value;
        if (oldest === void 0) break;
        remove(oldest);
      }
      const node = document.createElement("div");
      node.className = spec.tone === "error" ? "memcurio-toast memcurio-toast-error" : "memcurio-toast";
      node.setAttribute("role", spec.tone === "error" ? "alert" : "status");
      const icon = document.createElement("span");
      icon.className = "memcurio-toast-icon";
      icon.innerHTML = iconSvg(spec.icon);
      const text = document.createElement("span");
      text.className = "memcurio-toast-text";
      text.textContent = spec.text.length > 240 ? `${spec.text.slice(0, 239)}\u2026` : spec.text;
      node.append(icon, text);
      layer.append(node);
      const timer = setTimeout(() => {
        node.classList.add("memcurio-toast-out");
        setTimeout(() => remove(key), 400);
      }, HOLD_MS);
      live.set(key, { node, timer });
    },
    dispose() {
      for (const key of [...live.keys()]) remove(key);
      layer.remove();
    }
  };
}

// client/ui/tool-rows.ts
var import_react6 = require("react");
var MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_list",
  "memory_read",
  "memory_remember",
  "memory_status",
  "memory_context",
  "memory_cite"
];
var h2 = import_react6.createElement;
function isSettledBlock(block) {
  return "kind" in block;
}
function argsRawOf(block) {
  const raw = isSettledBlock(block) ? block.call?.argsRaw : block.argsRaw;
  return typeof raw === "string" ? raw : "";
}
function rowStateOf(block) {
  if (!isSettledBlock(block)) return "running";
  if (block.error?.code === "interrupted") return "stopped";
  return block.isError === true ? "error" : "ok";
}
function resultTextOf(block) {
  const content = block.content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const raw of content) {
    if (typeof raw !== "object" || raw === null) {
      parts.push(String(raw));
      continue;
    }
    const part = raw;
    if (part.type === "text" && typeof part.text === "string") parts.push(part.text);
    else parts.push(JSON.stringify(raw));
  }
  return parts.join("\n");
}
function errorDetailOf(block) {
  const name = typeof block.error?.name === "string" ? block.error.name : "";
  const code = typeof block.error?.code === "string" ? block.error.code : "";
  return [name, code].filter((part) => part !== "").join(": ");
}
function firstLine(text) {
  const line = text.split("\n", 1)[0] ?? "";
  return line.length > 200 ? `${line.slice(0, 199)}\u2026` : line;
}
function summarizeArgs(argsRaw) {
  const trimmed = argsRaw.trim();
  if (trimmed === "") return "";
  try {
    const parsed = JSON.parse(trimmed);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      for (const value of Object.values(parsed)) {
        if (typeof value === "string" && value !== "") return firstLine(value);
      }
      return firstLine(JSON.stringify(parsed));
    }
    if (typeof parsed === "string") return firstLine(parsed);
  } catch {
  }
  return firstLine(trimmed);
}
function stateLabel(state, t) {
  if (state === "running") return t("toolRunning");
  if (state === "error") return t("toolFailed");
  if (state === "stopped") return t("toolStopped");
  return "";
}
function leading(open) {
  return h2(
    "span",
    { className: "memcurio-tool-leading" },
    h2("span", { className: "memcurio-tool-leading-state" }, h2(MemoryMarkIcon, {})),
    h2("span", { className: "memcurio-tool-leading-chevron", "data-open": open ? "true" : "false" }, h2(ChevronDownIcon, {}))
  );
}
function MemoryToolRow(props) {
  const { t, block } = props;
  const [open, setOpen] = (0, import_react6.useState)(false);
  const state = rowStateOf(block);
  const args = argsRawOf(block);
  const result = resultTextOf(block);
  const body = state === "error" && result === "" ? errorDetailOf(block) : result;
  const summary = state === "error" ? firstLine(body === "" ? t("toolFailed") : body) : summarizeArgs(args);
  const expandable = args !== "" || body !== "";
  const toggle = () => {
    if (expandable) setOpen((value) => !value);
  };
  const onKeyDown = (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    toggle();
  };
  return h2(
    "div",
    { className: "memcurio-tool" },
    h2(
      "div",
      {
        className: "memcurio-tool-head",
        "data-state": state,
        ...state === "running" ? { "aria-busy": true } : {},
        ...expandable ? { role: "button", tabIndex: 0, "aria-expanded": open } : {},
        ...expandable ? { onClick: toggle, onKeyDown } : {}
      },
      h2("span", { className: "memcurio-tool-leading" }, leading(open)),
      h2("span", { className: "memcurio-tool-title" }, props.toolName ?? "memory"),
      summary !== "" ? [
        h2("span", { className: "memcurio-tool-sep", key: "sep" }),
        h2(
          "span",
          {
            className: state === "error" ? "memcurio-tool-summary memcurio-tool-summary-error" : "memcurio-tool-summary",
            key: "summary"
          },
          summary
        )
      ] : null,
      h2("span", { className: "memcurio-sr" }, stateLabel(state, t))
    ),
    open ? h2(
      "div",
      { className: "memcurio-tool-body" },
      args !== "" ? h2("span", { className: "memcurio-tool-label" }, t("toolArguments")) : null,
      args !== "" ? h2("pre", { className: "memcurio-tool-code" }, args) : null,
      body !== "" ? h2("span", { className: "memcurio-tool-label" }, t("toolResult")) : null,
      body !== "" ? h2("pre", { className: "memcurio-tool-code", ...state === "error" ? { "data-error": true } : {} }, body) : null,
      args === "" && body === "" ? h2("span", { className: "memcurio-tool-label" }, t("toolEmpty")) : null
    ) : null
  );
}
function memoryToolView(name) {
  return function MemoryToolView(props) {
    return h2(MemoryToolRow, { ...props, toolName: name });
  };
}

// client/ui/wire.ts
var UI_BASE_PATH = "/memcurio";
var UI_BOOT_GLOBAL = "__MEMCURIO_UI__";
function readBootConfig() {
  const value = globalThis[UI_BOOT_GLOBAL];
  if (typeof value !== "object" || value === null) return void 0;
  const record = value;
  return {
    ...typeof record.basePath === "string" && record.basePath !== "" ? { basePath: record.basePath } : {},
    ...typeof record.token === "string" && record.token !== "" ? { token: record.token } : {}
  };
}
function isUiDelta(value) {
  if (typeof value !== "object" || value === null) return false;
  const delta = value;
  switch (delta.kind) {
    case "inject-updated":
      return typeof delta.sessionId === "string" && typeof delta.duplicate === "boolean";
    case "receipt":
      return typeof delta.time === "number" && Number.isFinite(delta.time) && typeof delta.action === "string" && typeof delta.detail === "string";
    case "usage-tick":
      return typeof delta.sessionId === "string" && typeof delta.rolloutKey === "string";
    case "citation":
      return typeof delta.sessionId === "string" && Array.isArray(delta.rolloutKeys);
    case "evidence":
      return typeof delta.sessionId === "string" && typeof delta.partId === "string" && typeof delta.itemKind === "string";
    case "compaction-prune":
      return typeof delta.sessionId === "string" && Array.isArray(delta.seqs);
    case "queue-updated":
      return typeof delta.jobId === "string" && typeof delta.status === "string" && typeof delta.attempts === "number" && Number.isFinite(delta.attempts);
    case "memory-list-updated":
      return delta.updateKind === "rollout" || delta.updateKind === "consolidation" || delta.updateKind === "note";
    case "snapshot-ready":
      return typeof delta.sessionId === "string";
    default:
      return false;
  }
}
function isUiSnapshotResponse(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  if (typeof record.seq !== "number" || !Number.isFinite(record.seq)) return false;
  const snapshot = record.snapshot;
  if (typeof snapshot !== "object" || snapshot === null) return false;
  const store = snapshot.store;
  if (typeof store !== "object" || store === null) return false;
  const storeRecord = store;
  if (typeof storeRecord.id !== "string" || typeof storeRecord.root !== "string") return false;
  const receipts = snapshot.receipts;
  const injection = snapshot.injection;
  return Array.isArray(receipts) && typeof injection === "object" && injection !== null;
}
function isUiEventFrame(value) {
  if (typeof value !== "object" || value === null) return false;
  const record = value;
  if (typeof record.seq !== "number" || !Number.isFinite(record.seq) || !Array.isArray(record.deltas)) return false;
  return record.root === void 0 || typeof record.root === "string";
}

// client/ui/transport.ts
function statusError(status) {
  const error = new Error(`memcurio transport ${String(status)}`);
  error.status = status;
  return error;
}
function statusOf2(error) {
  const status = error?.status;
  return typeof status === "number" ? status : void 0;
}
function createUiTransportClient(options) {
  const pollMs = options.pollMs ?? 2e3;
  const retryMs = options.retryMs ?? 5e3;
  const offlineRetryMs = options.offlineRetryMs ?? 3e4;
  let stopped = true;
  let abort;
  let streamAbort;
  let streamGeneration = 0;
  let pollTimer;
  let retryTimer;
  let lastDeltaSeq = 0;
  let currentRoot;
  let snapshotRequest = 0;
  let appliedSnapshotRequest = 0;
  const signal = () => abort?.signal;
  const closeStream = () => {
    streamGeneration += 1;
    if (streamAbort !== void 0) {
      streamAbort.abort("memcurio ui transport reconnecting");
      streamAbort = void 0;
    }
  };
  const url = (path, session = options.sessionId()) => {
    return session === void 0 || session === "" ? `${options.basePath}${path}` : `${options.basePath}${path}?session=${encodeURIComponent(session)}`;
  };
  const headers = (accept) => ({ accept, "x-memcurio-token": options.token });
  const readSnapshot = async () => {
    const requestedSession = options.sessionId();
    const request = ++snapshotRequest;
    const response = await fetch(url("/snapshot", requestedSession), {
      signal: signal(),
      cache: "no-store",
      credentials: "same-origin",
      headers: headers("application/json")
    });
    if (!response.ok) throw statusError(response.status);
    const body = await response.json();
    if (!isUiSnapshotResponse(body)) return;
    if (request <= appliedSnapshotRequest) return;
    if (options.sessionId() !== requestedSession) return;
    if (body.seq < lastDeltaSeq) return;
    appliedSnapshotRequest = request;
    currentRoot = body.snapshot.store.root;
    options.onSnapshot(body.snapshot);
  };
  const handleFrame = (data) => {
    try {
      const parsed = JSON.parse(data);
      if (!isUiEventFrame(parsed)) return;
      if (parsed.root !== void 0 && currentRoot !== void 0 && parsed.root !== currentRoot) return;
      if (parsed.seq <= lastDeltaSeq) return;
      lastDeltaSeq = parsed.seq;
      const deltas = parsed.deltas.filter(isUiDelta);
      if (deltas.length > 0) options.onDeltas(deltas);
    } catch {
    }
  };
  const readStream = async (body, generation) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (; ; ) {
        const { done, value } = await reader.read();
        if (done === true) return;
        if (generation !== streamGeneration) return;
        buffer += decoder.decode(value, { stream: true });
        let index = buffer.indexOf("\n\n");
        while (index >= 0) {
          const chunk = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
          if (data !== "" && generation === streamGeneration) handleFrame(data);
          index = buffer.indexOf("\n\n");
        }
      }
    } finally {
      if (generation !== streamGeneration) {
        void reader.cancel().catch(() => void 0);
      }
    }
  };
  const stopPolling = () => {
    if (pollTimer !== void 0) {
      clearTimeout(pollTimer);
      pollTimer = void 0;
    }
  };
  const pollOnce = async () => {
    if (stopped) return;
    try {
      await readSnapshot();
    } catch (error) {
      options.onError?.(error);
    }
    if (stopped || pollTimer === void 0) return;
    pollTimer = setTimeout(() => {
      void pollOnce();
    }, pollMs);
    pollTimer.unref?.();
  };
  const startPolling = () => {
    options.onMode?.("polling");
    if (pollTimer !== void 0 || stopped) return;
    pollTimer = setTimeout(() => {
      void pollOnce();
    }, pollMs);
    pollTimer.unref?.();
  };
  const scheduleRetry = (delay) => {
    if (stopped || retryTimer !== void 0) return;
    retryTimer = setTimeout(() => {
      retryTimer = void 0;
      void connect();
    }, delay);
    retryTimer.unref?.();
  };
  const handleFailure = (error) => {
    if (stopped) return;
    options.onError?.(error);
    const status = statusOf2(error);
    if (status === 403) {
      stopPolling();
      options.onMode?.("off");
      scheduleRetry(offlineRetryMs);
      return;
    }
    if (status === 404) {
      stopPolling();
      options.onMode?.("off");
      scheduleRetry(retryMs);
      return;
    }
    startPolling();
    void readSnapshot().catch((failure) => options.onError?.(failure));
    scheduleRetry(retryMs);
  };
  const connect = async () => {
    if (stopped) return;
    closeStream();
    const generation = streamGeneration;
    try {
      await readSnapshot();
    } catch (error) {
      if (stopped || generation !== streamGeneration) return;
      handleFailure(error);
      return;
    }
    if (stopped || generation !== streamGeneration) return;
    const controller = new AbortController();
    streamAbort = controller;
    try {
      const eventsBase = url("/events");
      const eventsUrl = `${eventsBase}${eventsBase.includes("?") ? "&" : "?"}after=${String(lastDeltaSeq)}`;
      const response = await fetch(eventsUrl, {
        signal: controller.signal,
        cache: "no-store",
        credentials: "same-origin",
        headers: headers("text/event-stream")
      });
      if (!response.ok || response.body === null) throw statusError(response.status);
      if (stopped || generation !== streamGeneration) return;
      options.onMode?.("push");
      stopPolling();
      await readStream(response.body, generation);
      if (stopped || generation !== streamGeneration) return;
      throw new Error("memcurio event stream ended");
    } catch (error) {
      if (stopped || generation !== streamGeneration) return;
      handleFailure(error);
    } finally {
      if (streamAbort === controller) streamAbort = void 0;
    }
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      abort = new AbortController();
      lastDeltaSeq = 0;
      currentRoot = void 0;
      void connect();
    },
    stop() {
      if (stopped) return;
      stopped = true;
      closeStream();
      abort?.abort("memcurio ui transport stopped");
      abort = void 0;
      stopPolling();
      if (retryTimer !== void 0) {
        clearTimeout(retryTimer);
        retryTimer = void 0;
      }
      options.onMode?.("off");
    },
    refresh() {
      void readSnapshot().catch((error) => handleFailure(error));
    },
    rebind() {
      lastDeltaSeq = 0;
      currentRoot = void 0;
      closeStream();
      if (retryTimer !== void 0) {
        clearTimeout(retryTimer);
        retryTimer = void 0;
      }
      if (stopped) {
        void readSnapshot().catch((error) => options.onError?.(error));
        return;
      }
      void connect();
    }
  };
}

// client/entry.ts
var inject = ["slots", "locale", "configForms", "uiSession"];
function sessionScopeAdapter(ctx) {
  try {
    return ctx.uiSession?.adapter;
  } catch {
    return void 0;
  }
}
function currentSessionId(ctx) {
  try {
    const key = sessionScopeAdapter(ctx)?.current.getSnapshot().key;
    return typeof key === "string" && key !== "" ? key : void 0;
  } catch {
    return void 0;
  }
}
var NOTIFICATION_KEY = {
  extract: "toastRollout",
  adhoc: "toastNote",
  consolidate: "toastConsolidate",
  prune: "toastPrune",
  purge: "toastPurge",
  other: "toastWrite"
};
function notify(toasts, t, event) {
  if (event.type === "injection") {
    if (!shouldAnnounceInjection(event)) return;
    toasts.push({
      key: `inject-static:${String(event.tokens)}`,
      icon: "injection",
      text: t("toastInjectedStatic", { tokens: event.tokens })
    });
    return;
  }
  if (event.type === "write") {
    toasts.push({
      key: `write:${event.action}`,
      icon: "memory",
      text: t(NOTIFICATION_KEY[actionCategory(event.action)])
    });
  }
}
function apply(ctx) {
  ctx.effect(() => mountStyles(), "memcurio: settings styles");
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "memcurio: settings dictionaries");
  const t = ctx.locale.bind(NS);
  const scope = ctx.configForms.get(NAMESPACE);
  const controller = new MemcurioSettingsController(scope);
  const formModel = new SettingsFormModel(controller);
  const switchModel = new InjectionSwitchModel(controller, (before) => formModel.rebase(before));
  ctx.effect(() => {
    const stopController = controller.start();
    const stopForm = formModel.start();
    const stopSwitch = switchModel.start();
    return () => {
      stopSwitch();
      stopForm();
      stopController();
      switchModel.dispose();
      formModel.dispose();
    };
  }, "memcurio: settings models");
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      {
        name: "settings.section",
        id: "memcurio",
        order: 30,
        label: () => t("nav"),
        locale: NS,
        // The reserved `hooks` compartment: the renderer memoizes this face
        // once per entry, so it must carry the observable seat, never a value
        // snapshot. `t` arrives from the framework locale seat.
        inject: () => ({
          hooks: {
            face: controller.faceHook(),
            form: formModel.faceHook(),
            instant: switchModel.faceHook()
          },
          formModel,
          switchModel
        })
      },
      MemcurioSettingsSection
    )
  );
  ctx.slots.inject(
    "settings.action",
    () => ctx.slots.register(
      {
        name: "settings.action",
        id: "memcurio-nav-mark",
        order: 90,
        locale: NS
      },
      SettingsNavProbe
    )
  );
  ctx.effect(() => mountUiStyles(), "memcurio: ui styles");
  ctx.effect(() => ctx.locale.register(NS2, { zh: zh2, en: en2 }), "memcurio: ui dictionaries");
  const tUi = ctx.locale.bind(NS2);
  const store = createMemoryUiStore();
  const toasts = createToastHost();
  const boot = readBootConfig();
  let lastTransportLogAt = 0;
  const transport = boot?.token === void 0 ? void 0 : createUiTransportClient({
    basePath: boot.basePath ?? UI_BASE_PATH,
    token: boot.token,
    sessionId: () => currentSessionId(ctx),
    onSnapshot: (snapshot) => {
      for (const event of store.applySnapshot(snapshot)) notify(toasts, tUi, event);
    },
    onDeltas: (deltas) => {
      for (const event of store.applyDeltas(deltas, currentSessionId(ctx))) notify(toasts, tUi, event);
      if (deltas.some((delta) => delta.kind === "snapshot-ready")) transport?.refresh();
    },
    onMode: (mode) => {
      store.setRealtime(mode);
    },
    onError: (error) => {
      const now = Date.now();
      if (now - lastTransportLogAt < 6e4) return;
      lastTransportLogAt = now;
      console.debug("memcurio: memory UI transport unavailable", error);
    }
  });
  ctx.effect(() => {
    transport?.start();
    return () => {
      transport?.stop();
    };
  }, "memcurio: ui transport");
  ctx.effect(() => {
    const adapter = sessionScopeAdapter(ctx);
    if (adapter === void 0) return () => void 0;
    let current = currentSessionId(ctx);
    return adapter.current.subscribe(() => {
      const next = currentSessionId(ctx);
      if (next === current) return;
      current = next;
      store.resetStoreView();
      transport?.rebind();
    });
  }, "memcurio: session switches");
  ctx.effect(() => () => toasts.dispose(), "memcurio: toasts");
  registerInjectionRow(ctx);
  registerGuideRow(ctx);
  ctx.effect(() => {
    const disposers = MEMORY_TOOL_NAMES.map(
      (name) => ctx.slots.inject(
        "tool.call.toolview",
        () => ctx.slots.register(
          // priority 1 is the coexistence fallback: a first-party row for the
          // same wire key at rank 0 wins this cell, and two rank-1 registrations
          // for one key would throw at load — ours is the only one.
          { name: "tool.call.toolview", key: name, locale: NS2, priority: 1 },
          memoryToolView(name)
        )
      )
    );
    return () => {
      for (const dispose of disposers.reverse()) {
        if (typeof dispose === "function") dispose();
      }
    };
  }, "memcurio: memory tool rows");
}

		return module.exports;
	}
});
