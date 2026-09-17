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
var ERROR_KEYS = {
  routePair: "errRoutePair",
  budgetRange: "errBudgetRange",
  notLanded: "errNotLanded",
  notReady: "errNotReady",
  resetNotLanded: "errResetNotLanded",
  hostRejected: "errHostRejected"
};
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
function overriddenFields(user) {
  if (user === null || typeof user !== "object") return [];
  const layer = user;
  return SETTINGS_FIELDS.filter((field) => Object.hasOwn(layer, field));
}
function routeProblem(field, value, view) {
  if (field !== "provider" && field !== "model") return void 0;
  const nextProvider = field === "provider" ? value : view.provider;
  const nextModel = field === "model" ? value : view.model;
  const hasProvider = typeof nextProvider === "string" && nextProvider.trim().length > 0;
  const hasModel = typeof nextModel === "string" && nextModel.trim().length > 0;
  if (hasProvider !== hasModel) return ERROR_KEYS.routePair;
  return void 0;
}
function budgetProblem(value) {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 128) return ERROR_KEYS.budgetRange;
  return void 0;
}
var MemcurioSettingsController = class {
  scope;
  faceCache = null;
  listeners = /* @__PURE__ */ new Set();
  errorCode;
  busy;
  /** ONE underlying scope subscription, fanned out to panel listeners. */
  unsubscribeScope;
  /** Refcount so a redundant start()/dispose pair cannot kill the seat. */
  starters = 0;
  constructor(scope) {
    this.scope = scope;
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
    this.faceCache = {
      status: snapshot.status,
      writable: snapshot.writable,
      mode: snapshot.mode,
      value: snapshot.value ?? decodeSettings(snapshot.base),
      base: decodeSettings(snapshot.base),
      overridden: overriddenFields(snapshot.user),
      ...this.errorCode ? { errorCode: this.errorCode } : {},
      ...this.busy ? { busy: this.busy } : {}
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
  async save(field, value) {
    const face = this.face();
    const view = face.value;
    const problem = routeProblem(field, value, view) ?? (field === "injectBudgetTokens" ? budgetProblem(value) : void 0);
    if (problem) return this.fail(problem);
    const reverts = Object.is(value, face.base[field]);
    this.busy = field;
    this.notify();
    try {
      if (reverts) await this.scope.unset(field);
      else await this.scope.set(field, value);
    } catch {
      return this.fail(ERROR_KEYS.hostRejected);
    }
    if (!this.verifyField(field, value, reverts)) {
      return this.fail(this.refusalKey());
    }
    this.errorCode = void 0;
    this.busy = void 0;
    this.notify();
    return { ok: true };
  }
  async reset(field) {
    const face = this.face();
    const problem = routeProblem(field, face.base[field], face.value);
    if (problem) return this.fail(problem);
    this.busy = field;
    this.notify();
    try {
      await this.scope.unset(field);
    } catch {
      return this.fail(ERROR_KEYS.hostRejected);
    }
    if (overriddenFields(this.scope.getSnapshot().user).includes(field)) {
      return this.fail(ERROR_KEYS.resetNotLanded);
    }
    this.errorCode = void 0;
    this.busy = void 0;
    this.notify();
    return { ok: true };
  }
  /** Clear every override in ONE atomic mutation. Per-field clearing cannot
   *  express this: the host validates the resolved section on every write, so
   *  a lone route half would be refused mid-way (and would leave the earlier
   *  fields cleared). `mutate` reduces all ops and validates once. */
  async resetAll() {
    const pending = overriddenFields(this.scope.getSnapshot().user);
    if (pending.length === 0) return this.settleCleared();
    this.busy = "all";
    this.notify();
    try {
      await this.scope.mutate(pending.map((field) => ({ op: "unset", path: [field] })));
    } catch {
      return this.fail(ERROR_KEYS.hostRejected);
    }
    if (overriddenFields(this.scope.getSnapshot().user).length > 0) {
      return this.fail(ERROR_KEYS.resetNotLanded);
    }
    return this.settleCleared();
  }
  /** Write the worker route as ONE atomic pair (both halves or neither):
   *  a lone half is illegal in the resolved section, so single-field edits
   *  could never land on a deployment that pins no route. */
  async saveRoute(provider, model) {
    const nextProvider = provider.trim();
    const nextModel = model.trim();
    if (nextProvider === "" !== (nextModel === "")) return this.fail(ERROR_KEYS.routePair);
    const base = this.face().base;
    const reverts = nextProvider === "" || nextProvider === (base.provider ?? "") && nextModel === (base.model ?? "");
    this.busy = "all";
    this.notify();
    const ops = reverts ? [
      { op: "unset", path: ["provider"] },
      { op: "unset", path: ["model"] }
    ] : [
      { op: "set", path: ["provider"], value: nextProvider },
      { op: "set", path: ["model"], value: nextModel }
    ];
    try {
      await this.scope.mutate(ops);
    } catch {
      return this.fail(ERROR_KEYS.hostRejected);
    }
    if (!this.verifyRoute(reverts ? "" : nextProvider, reverts ? "" : nextModel)) {
      return this.fail(this.refusalKey());
    }
    return this.settleCleared();
  }
  /** Revert both route halves to the composition base in one mutation. */
  async resetRoute() {
    return this.saveRoute("", "");
  }
  /** Clear both route halves… alias kept explicit for panel symmetry. */
  settleCleared() {
    this.errorCode = void 0;
    this.busy = void 0;
    this.notify();
    return { ok: true };
  }
  /** A failed read-back means "host refused" only while the transport is
   *  ready; a lost ready state is "could not verify", not a refusal. */
  refusalKey() {
    return this.scope.getSnapshot().status === "ready" ? ERROR_KEYS.notLanded : ERROR_KEYS.notReady;
  }
  verifyRoute(provider, model) {
    const snapshot = this.scope.getSnapshot();
    if (snapshot.status !== "ready") return false;
    const user = snapshot.user ?? {};
    if (provider === "") {
      return !Object.hasOwn(user, "provider") && !Object.hasOwn(user, "model");
    }
    return user.provider === provider && user.model === model;
  }
  /** Post-write verification against the landed user layer. All fields are
   *  scalars, so strict identity is exact (no JSON-ordering caveat). A REVERT
   *  must land as an ABSENT user entry — a pinned equal value is the exact
   *  state this method exists to reject (the resolved mirror follows the
   *  layer, and reset() verifies against the same fact). */
  verifyField(field, value, reverts) {
    const snapshot = this.scope.getSnapshot();
    if (snapshot.status !== "ready") return false;
    const user = snapshot.user;
    const layer = user !== null && typeof user === "object" ? user : {};
    if (reverts) return !Object.hasOwn(layer, field);
    return Object.hasOwn(layer, field) && Object.is(layer[field], value);
  }
  fail(code) {
    this.errorCode = code;
    this.busy = void 0;
    this.notify();
    return { ok: false, code };
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
  title: "Memory (memcurio)",
  intro: "Durable cross-session memory for this harness instance.",
  scope: "Storage scope",
  scopeWorkspace: "Per workspace (isolated store)",
  scopeGlobal: "Shared store (global)",
  injectContext: "Memory",
  registerTools: "Register the memory tools",
  registerToolsNote: "On: the six memory_* tools are registered for the agent (write / read / curate memory). Off: the model has no such tools; stored memory and automatic injection are unaffected. Changes apply after a restart.",
  injectBudgetTokens: "Injection budget (tokens)",
  routeLabel: "Worker route",
  provider: "Worker provider",
  model: "Worker model",
  overridden: "overridden",
  reset: "Reset to default",
  resetAll: "Reset all overrides",
  ready: "Ready",
  saving: "Saving\u2026",
  saved: "Saved",
  errRoutePair: "provider and model must be set together",
  errBudgetRange: "The injection budget must be an integer of at least 128 tokens",
  errNotLanded: "The host refused the change (nothing was saved)",
  errNotReady: "The settings transport left its ready state, so the write could not be verified",
  errResetNotLanded: "The host refused the reset (the override is still active)",
  errHostRejected: "The settings transport rejected the write",
  readOnly: "This client is read-only for settings (process-local settings mode).",
  unavailable: "The memcurio settings namespace is not exposed by this host.",
  loading: "Loading settings\u2026",
  scopeNote: "Scope applies to new sessions; the data root is deployment-level (read-only here).",
  save: "Save",
  routeNote: "provider / model are saved as one pair; leave both empty to follow the session route."
};
var zh = {
  nav: "\u8BB0\u5FC6",
  title: "\u8BB0\u5FC6\uFF08memcurio\uFF09",
  intro: "\u4E3A\u8BE5 harness \u5B9E\u4F8B\u63D0\u4F9B\u8DE8\u4F1A\u8BDD\u6301\u4E45\u8BB0\u5FC6\u3002",
  scope: "\u5B58\u50A8\u4F5C\u7528\u57DF",
  scopeWorkspace: "\u6309\u5DE5\u4F5C\u533A\u9694\u79BB",
  scopeGlobal: "\u5171\u4EAB store\uFF08\u5168\u5C40\uFF09",
  injectContext: "\u8BB0\u5FC6",
  registerTools: "\u6CE8\u518C\u8BB0\u5FC6\u5DE5\u5177",
  registerToolsNote: "\u5F00\u542F\uFF1A\u628A 6 \u4E2A memory_* \u5DE5\u5177\u6CE8\u518C\u7ED9 agent\uFF08\u8BB0\u5FC6\u5199\u5165 / \u68C0\u7D22 / \u6574\u7406\uFF09\u3002\u5173\u95ED\uFF1A\u6A21\u578B\u6CA1\u6709\u8FD9\u4E9B\u5DE5\u5177\uFF0C\u5DF2\u5B58\u8BB0\u5FC6\u4E0E\u81EA\u52A8\u6CE8\u5165\u4E0D\u53D7\u5F71\u54CD\u3002\u53D8\u66F4\u9700\u91CD\u542F\u751F\u6548\u3002",
  injectBudgetTokens: "\u6CE8\u5165\u9884\u7B97\uFF08token\uFF09",
  routeLabel: "Worker \u8DEF\u7531",
  provider: "Worker provider",
  model: "Worker model",
  overridden: "\u5DF2\u8986\u76D6",
  reset: "\u6062\u590D\u9ED8\u8BA4",
  resetAll: "\u6E05\u9664\u5168\u90E8\u8986\u76D6",
  ready: "\u5C31\u7EEA",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  saved: "\u5DF2\u4FDD\u5B58",
  errRoutePair: "provider \u4E0E model \u5FC5\u987B\u540C\u65F6\u8BBE\u7F6E",
  errBudgetRange: "\u6CE8\u5165\u9884\u7B97\u5FC5\u987B\u662F >= 128 \u7684\u6574\u6570",
  errNotLanded: "\u5BBF\u4E3B\u62D2\u7EDD\u4E86\u8BE5\u4FEE\u6539\uFF08\u672A\u4FDD\u5B58\uFF09",
  errNotReady: "\u8BBE\u7F6E\u4F20\u8F93\u5DF2\u79BB\u5F00\u5C31\u7EEA\u6001\uFF0C\u65E0\u6CD5\u6838\u9A8C\u672C\u6B21\u5199\u5165",
  errResetNotLanded: "\u5BBF\u4E3B\u62D2\u7EDD\u4E86\u6062\u590D\u9ED8\u8BA4\uFF08\u8986\u76D6\u4ECD\u7136\u751F\u6548\uFF09",
  errHostRejected: "\u8BBE\u7F6E\u4F20\u8F93\u62D2\u7EDD\u4E86\u672C\u6B21\u5199\u5165",
  readOnly: "\u5F53\u524D\u5BA2\u6237\u7AEF\u4E3A\u53EA\u8BFB\u8BBE\u7F6E\u6A21\u5F0F\uFF08\u8FDB\u7A0B\u5185\u8BBE\u7F6E\uFF09\u3002",
  unavailable: "\u8BE5\u5BBF\u4E3B\u672A\u66B4\u9732 memcurio \u8BBE\u7F6E\u547D\u540D\u7A7A\u95F4\u3002",
  loading: "\u6B63\u5728\u52A0\u8F7D\u8BBE\u7F6E\u2026",
  scopeNote: "\u4F5C\u7528\u57DF\u53D8\u66F4\u5BF9\u65B0\u4F1A\u8BDD\u751F\u6548\uFF1B\u6570\u636E\u6839\u5C5E\u90E8\u7F72\u7EA7\u914D\u7F6E\uFF08\u6B64\u5904\u53EA\u8BFB\uFF09\u3002",
  save: "\u4FDD\u5B58",
  routeNote: "provider / model \u6210\u5BF9\u4FDD\u5B58\uFF1B\u90FD\u7559\u7A7A\u5219\u8DDF\u968F\u4F1A\u8BDD\u8DEF\u7531\u3002"
};

// client/settings/nav-mark.ts
var NAV_MARK_ATTRIBUTE = "data-memcurio-nav";
var MEMORY_MARK_LABELS = [zh.nav, en.nav];
var ROW_SELECTOR = '[role="dialog"][aria-modal="true"] nav button';
var warned = false;
var owned = null;
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
  owned?.();
  owned = markSettingsNavRow();
  if (document.querySelector(`[${NAV_MARK_ATTRIBUTE}]`) !== null) return;
  const rows = navRows();
  if (rows.length === 0 || warned) return;
  warned = true;
  const labels = rows.map((button) => (button.textContent ?? "").trim());
  console.warn("memcurio: settings nav row not recognised", { labels, expected: MEMORY_MARK_LABELS });
}
function startSettingsNavWatcher() {
  if (typeof document === "undefined") return () => void 0;
  let queued = false;
  const schedule = () => {
    if (queued) return;
    queued = true;
    const run = () => {
      queued = false;
      remarkSettingsNavRow();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
    else setTimeout(run, 0);
  };
  document.addEventListener("click", schedule, true);
  document.addEventListener("keydown", schedule, true);
  schedule();
  return () => {
    document.removeEventListener("click", schedule, true);
    document.removeEventListener("keydown", schedule, true);
    owned?.();
    owned = null;
  };
}
function SettingsNavProbe() {
  (0, import_react.useEffect)(() => {
    let owner = markSettingsNavRow();
    if (typeof MutationObserver === "undefined" || typeof document === "undefined") {
      return () => owner();
    }
    let queued = false;
    const queue = () => {
      if (queued) return;
      queued = true;
      const run = () => {
        queued = false;
        if (document.querySelector(`[${NAV_MARK_ATTRIBUTE}]`) !== null) return;
        owner();
        owner = markSettingsNavRow();
      };
      if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
      else setTimeout(run, 0);
    };
    const observer = new MutationObserver(queue);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      owner();
    };
  }, []);
  return null;
}

// client/settings/section.ts
var import_react3 = require("react");

// client/ui/switch.ts
var import_react2 = require("react");
var h = import_react2.createElement;
function MemorySwitch(props) {
  const { checked, label, title, disabled = false, id, onChange } = props;
  return h(
    "button",
    {
      ...id === void 0 ? {} : { id },
      type: "button",
      className: "memcurio-switch",
      role: "switch",
      "aria-checked": checked,
      "aria-label": label,
      ...title === void 0 ? {} : { title },
      disabled,
      onClick: () => {
        onChange(!checked);
      }
    },
    h("span", { className: "memcurio-switch-thumb", "aria-hidden": true })
  );
}

// client/settings/section.ts
var h2 = import_react3.createElement;
function MemcurioSettingsSection(props) {
  const { t, useFace, save, reset, resetAll, saveRoute, resetRoute } = props;
  const face = useFace((snapshot) => snapshot);
  const [draftBudget, setDraftBudget] = (0, import_react3.useState)(face.value.injectBudgetTokens === void 0 ? "" : String(face.value.injectBudgetTokens));
  const [draftProvider, setDraftProvider] = (0, import_react3.useState)(face.value.provider ?? "");
  const [draftModel, setDraftModel] = (0, import_react3.useState)(face.value.model ?? "");
  const [notice, setNotice] = (0, import_react3.useState)(null);
  (0, import_react3.useEffect)(() => {
    setDraftBudget(face.value.injectBudgetTokens === void 0 ? "" : String(face.value.injectBudgetTokens));
    setDraftProvider(face.value.provider ?? "");
    setDraftModel(face.value.model ?? "");
  }, [face.value.injectBudgetTokens, face.value.provider, face.value.model]);
  (0, import_react3.useEffect)(() => {
    remarkSettingsNavRow();
  }, []);
  const busy = face.busy !== void 0;
  const faceRef = (0, import_react3.useRef)(face);
  (0, import_react3.useEffect)(() => {
    faceRef.current = face;
  }, [face]);
  const announce = (0, import_react3.useCallback)(
    (outcome) => {
      setNotice({ text: outcome.ok ? t("saved") : t(outcome.code), ok: outcome.ok });
      if (!outcome.ok) {
        const current = faceRef.current.value;
        setDraftBudget(current.injectBudgetTokens === void 0 ? "" : String(current.injectBudgetTokens));
        setDraftProvider(current.provider ?? "");
        setDraftModel(current.model ?? "");
      }
    },
    [t]
  );
  const commitRoute = (0, import_react3.useCallback)(() => {
    const provider = draftProvider.trim();
    const model = draftModel.trim();
    const current = faceRef.current.value;
    if (provider === (current.provider ?? "") && model === (current.model ?? "")) return;
    void saveRoute(provider, model).then(announce);
  }, [announce, draftModel, draftProvider, saveRoute]);
  const commitBudget = (0, import_react3.useCallback)(() => {
    const current = faceRef.current.value;
    const draft = draftBudget.trim();
    if (draft === (current.injectBudgetTokens === void 0 ? "" : String(current.injectBudgetTokens))) return;
    if (draft === "") {
      void reset("injectBudgetTokens").then(announce);
      return;
    }
    void save("injectBudgetTokens", Number(draft)).then(announce);
  }, [announce, draftBudget, reset, save]);
  const status = (0, import_react3.useMemo)(() => {
    if (face.status === "loading") return t("loading");
    if (face.status === "unavailable") return face.mode === "memory" ? t("readOnly") : t("unavailable");
    if (!face.writable) return t("readOnly");
    if (busy) return t("saving");
    return t("ready");
  }, [busy, face.mode, face.status, face.writable, t]);
  const stateKey = face.status === "loading" ? "loading" : !face.writable ? "readOnly" : busy ? "saving" : "ready";
  const stateName = face.errorCode !== void 0 || notice !== null && !notice.ok ? "error" : face.status === "loading" ? "loading" : !face.writable ? "readonly" : busy ? "saving" : "ready";
  const stateIcon = (name, label) => h2(
    "span",
    { className: "memcurio-state", "data-state": name, role: "status", title: label, "aria-label": label },
    h2("span", { className: "memcurio-state-dot", "aria-hidden": "true" })
  );
  if (face.status === "loading" || face.status === "unavailable") {
    return h2(
      "section",
      { className: "memcurio-panel" },
      h2("div", { className: "memcurio-head" }, h2("h2", null, t("title")), stateIcon(stateName, status)),
      h2("p", { className: "memcurio-warn" }, status)
    );
  }
  const resetBadge = (action) => h2(
    "span",
    { className: "memcurio-badge" },
    h2("span", { className: "memcurio-badge-text" }, t("overridden")),
    h2(
      "button",
      {
        type: "button",
        className: "memcurio-reset",
        disabled: busy || !face.writable,
        onClick: () => {
          void action().then(announce);
        }
      },
      t("reset")
    )
  );
  const row = (key, label, control, options) => h2(
    "div",
    { className: options?.stack === true ? "memcurio-field memcurio-field-stack" : "memcurio-field", key },
    h2(
      "div",
      { className: "memcurio-field-text" },
      label,
      options?.description === void 0 ? null : h2("span", { className: "memcurio-desc" }, options.description)
    ),
    h2("div", { className: "memcurio-control" }, options?.badge ?? null, control)
  );
  const switchControl = (field, label, checked, onChange) => h2(MemorySwitch, {
    id: `memcurio-${field}`,
    checked,
    label,
    disabled: busy || !face.writable,
    onChange
  });
  const routeDirty = draftProvider.trim() !== (face.value.provider ?? "") || draftModel.trim() !== (face.value.model ?? "");
  const keySubmit = (commit) => (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  };
  return h2(
    "section",
    { className: "memcurio-panel" },
    h2("div", { className: "memcurio-head" }, h2("h2", null, t("title")), stateIcon(stateName, t(stateKey))),
    h2("p", { className: "memcurio-intro" }, t("intro")),
    // Success is the icon turning green; only failures spend a text line.
    notice !== null && !notice.ok ? h2("p", { className: "memcurio-status memcurio-status-error" }, notice.text) : null,
    !face.writable ? h2("p", { className: "memcurio-warn" }, t("readOnly")) : null,
    face.errorCode ? h2("p", { className: "memcurio-alert", role: "alert" }, t(face.errorCode)) : null,
    // The memory ON/OFF control: the same injectContext field the pre-step
    // hook reads, and the only place it is switched.
    row(
      "injectContext",
      h2("span", { className: "memcurio-label" }, t("injectContext")),
      switchControl("injectContext", t("injectContext"), face.value.injectContext, (next) => {
        void save("injectContext", next).then(announce);
      }),
      {
        // No description line (product instruction, 2026-09-16): the switch
        // needs no explainer, and the row keeps the panel compact.
        badge: face.overridden.includes("injectContext") ? resetBadge(() => reset("injectContext")) : null
      }
    ),
    row(
      "injectBudgetTokens",
      h2("label", { className: "memcurio-label", htmlFor: "memcurio-injectBudgetTokens" }, t("injectBudgetTokens")),
      h2("input", {
        id: "memcurio-injectBudgetTokens",
        className: "memcurio-input memcurio-input-num",
        type: "text",
        inputMode: "numeric",
        autoComplete: "off",
        spellCheck: false,
        placeholder: "1500",
        value: draftBudget,
        readOnly: busy,
        disabled: !face.writable,
        "aria-invalid": face.errorCode === ERROR_KEYS.budgetRange ? "true" : void 0,
        onChange: (event) => setDraftBudget(event.target.value),
        onBlur: commitBudget,
        onKeyDown: keySubmit(commitBudget)
      }),
      { badge: face.overridden.includes("injectBudgetTokens") ? resetBadge(() => reset("injectBudgetTokens")) : null }
    ),
    row(
      "scope",
      h2("label", { className: "memcurio-label", htmlFor: "memcurio-scope" }, t("scope")),
      h2(
        "span",
        { className: "memcurio-select-wrap" },
        h2(
          "select",
          {
            id: "memcurio-scope",
            className: "memcurio-select",
            value: face.value.scope,
            disabled: busy || !face.writable,
            onChange: (event) => {
              void save("scope", event.target.value).then(announce);
            }
          },
          h2("option", { value: "workspace" }, t("scopeWorkspace")),
          h2("option", { value: "global" }, t("scopeGlobal"))
        )
      ),
      { description: t("scopeNote"), badge: face.overridden.includes("scope") ? resetBadge(() => reset("scope")) : null }
    ),
    row(
      "registerTools",
      h2("span", { className: "memcurio-label" }, t("registerTools")),
      switchControl("registerTools", t("registerTools"), face.value.registerTools, (next) => {
        void save("registerTools", next).then(announce);
      }),
      {
        description: t("registerToolsNote"),
        badge: face.overridden.includes("registerTools") ? resetBadge(() => reset("registerTools")) : null
      }
    ),
    // The memory UI data plane (the host bridge) is not a setting at all
    // (product decision 2026-09-16: always on, no user case needs it off), so
    // neither the panel nor the config surface carries a row for it.
    row(
      "provider",
      h2("span", { className: "memcurio-label" }, t("routeLabel")),
      h2(
        "span",
        { className: "memcurio-route" },
        h2("input", {
          id: "memcurio-provider",
          className: "memcurio-input",
          type: "text",
          autoComplete: "off",
          spellCheck: false,
          "aria-label": t("provider"),
          value: draftProvider,
          placeholder: "deepseek",
          readOnly: busy,
          disabled: !face.writable,
          "aria-invalid": face.errorCode === ERROR_KEYS.routePair ? "true" : void 0,
          onChange: (event) => setDraftProvider(event.target.value),
          onKeyDown: keySubmit(commitRoute)
        }),
        h2("input", {
          id: "memcurio-model",
          className: "memcurio-input",
          type: "text",
          autoComplete: "off",
          spellCheck: false,
          "aria-label": t("model"),
          value: draftModel,
          placeholder: "deepseek-v4",
          readOnly: busy,
          disabled: !face.writable,
          "aria-invalid": face.errorCode === ERROR_KEYS.routePair ? "true" : void 0,
          onChange: (event) => setDraftModel(event.target.value),
          onKeyDown: keySubmit(commitRoute)
        }),
        h2(
          "button",
          {
            type: "button",
            className: "memcurio-button memcurio-button-primary",
            disabled: busy || !face.writable || !routeDirty,
            onClick: () => {
              commitRoute();
            }
          },
          t("save")
        )
      ),
      {
        description: t("routeNote"),
        stack: true,
        badge: face.overridden.includes("provider") || face.overridden.includes("model") ? resetBadge(() => resetRoute()) : null
      }
    ),
    h2(
      "div",
      { className: "memcurio-actions" },
      h2(
        "button",
        {
          type: "button",
          className: "memcurio-button",
          disabled: busy || !face.writable || face.overridden.length === 0,
          onClick: () => {
            void resetAll().then(announce);
          }
        },
        t("resetAll")
      )
    )
  );
}

// client/ui/icons.ts
var import_react4 = require("react");
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
function chevronMaskDataUrl() {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#000" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
}
function MemoryMarkIcon({ size = 14 }) {
  return (0, import_react4.createElement)(
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
    ...MEMORY_MARK_PATHS.map((d) => (0, import_react4.createElement)("path", { key: d, d }))
  );
}
function ContextInjectionIcon({ size = 14 }) {
  return (0, import_react4.createElement)(
    "svg",
    { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, focusable: "false" },
    ...CONTEXT_INJECTION_PATHS.map((d) => (0, import_react4.createElement)("path", { key: d, d, fill: "currentColor" }))
  );
}
function ChevronDownIcon({ size = 14 }) {
  return (0, import_react4.createElement)(
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
    (0, import_react4.createElement)("path", { d: "M6 9l6 6 6-6" })
  );
}

// client/settings/styles.ts
var STYLE_ID = "memcurio-settings-css";
var NAV_MARK = memoryMarkMaskDataUrl();
var CHEVRON = chevronMaskDataUrl();
var CSS = `
.memcurio-panel { display: flex; flex-direction: column; gap: 12px; max-width: 720px; color: var(--dsw-alias-label-primary); }
.memcurio-panel h2 { margin: 0; font-size: 16px; line-height: 24px; font-weight: 500; color: var(--dsw-alias-label-primary); }
.memcurio-intro { margin: 0; font-size: 14px; line-height: 22px; color: var(--dsw-alias-label-tertiary); }
.memcurio-status { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-secondary); }
.memcurio-status-error { color: var(--dsw-alias-state-error-primary); }
/* Icon-only status, the chamber / dsh-chamber-mcp convention: an 8px dot at
   the panel's right \u2014 green ready, grey idle/read-only, red error, pulsing
   while a write is in flight. The phase text lives in title/aria-label. */
.memcurio-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.memcurio-state { display: inline-flex; flex: none; align-items: center; justify-content: center; width: 16px; height: 16px; }
.memcurio-state-dot { width: 8px; height: 8px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-border-l3); }
.memcurio-state[data-state="ready"] .memcurio-state-dot { background: var(--dsw-alias-state-success-primary); }
.memcurio-state[data-state="saving"] .memcurio-state-dot { background: var(--dsw-alias-label-caption); animation: memcurio-state-pulse 1.2s ease-in-out infinite; }
.memcurio-state[data-state="error"] .memcurio-state-dot { background: var(--dsw-alias-state-error-primary); }
@keyframes memcurio-state-pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }
.memcurio-alert { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-error-primary); }
.memcurio-warn { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-state-warn-label); }
.memcurio-field { display: flex; flex-wrap: wrap; align-items: center; gap: 8px 16px; padding: 12px 0; }
.memcurio-field + .memcurio-field { border-top: 0.5px solid var(--dsw-alias-border-l2); }
.memcurio-field-text { display: flex; flex: 1 1 220px; flex-direction: column; gap: 2px; min-width: 0; }
.memcurio-label { font-size: 14px; font-weight: 400; line-height: 22px; color: var(--dsw-alias-label-primary); }
.memcurio-desc { font-size: 12px; font-weight: 400; line-height: 18px; color: var(--dsw-alias-label-tertiary); }
.memcurio-control { display: flex; flex: none; align-items: center; gap: 8px; margin-left: auto; }
/* Stacked rows (the worker route): the control group owns a full-width line,
   so two 34px inputs and the Save button never squeeze the note column. */
.memcurio-field-stack { align-items: flex-start; }
.memcurio-field-stack .memcurio-control { flex: 1 1 100%; margin-left: 0; }
.memcurio-route { display: flex; flex: 1 1 auto; align-items: center; flex-wrap: wrap; gap: 8px; min-width: 0; }
.memcurio-route .memcurio-input { flex: 1 1 160px; width: auto; min-width: 0; }
.memcurio-badge { display: inline-flex; align-items: center; gap: 8px; }
.memcurio-badge-text { border-radius: 999px; padding: 1px 8px; font-size: 11px; line-height: 17px; font-weight: 500; white-space: nowrap; background: var(--dsw-alias-bg-module-platform); color: var(--dsw-alias-label-secondary); }
.memcurio-reset { border: none; background: none; padding: 0; font: inherit; font-size: 12px; line-height: 1.5; color: var(--dsw-alias-label-secondary); cursor: pointer; }
.memcurio-reset:hover:not(:disabled) { color: var(--dsw-alias-label-primary); }
.memcurio-reset:disabled { cursor: default; }
.memcurio-reset:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.memcurio-input, .memcurio-select { box-sizing: border-box; height: 34px; padding: 0 12px; border: 0.5px solid var(--dsw-alias-border-l4); border-radius: 8px; background: var(--dsw-alias-bg-layer-3); font: inherit; font-size: 13px; line-height: 1.5; color: var(--dsw-alias-label-primary); }
.memcurio-input { width: 200px; }
.memcurio-input-num { width: 120px; }
.memcurio-input:focus-visible, .memcurio-select:focus-visible { outline: none; border-color: var(--dsw-alias-brand-primary); }
.memcurio-input:disabled, .memcurio-select:disabled { color: var(--dsw-alias-label-tertiary); cursor: default; }
.memcurio-input[aria-invalid="true"] { border-color: var(--dsw-alias-state-error-primary); }
.memcurio-input::placeholder { color: var(--dsw-alias-label-dimmed); }
.memcurio-select-wrap { position: relative; display: inline-flex; width: 200px; }
.memcurio-select { appearance: none; width: 100%; max-width: none; padding-right: 32px; cursor: pointer; }
.memcurio-select-wrap::after { content: ""; position: absolute; right: 12px; top: 50%; width: 12px; height: 12px; margin-top: -6px; background-color: var(--dsw-alias-label-tertiary); -webkit-mask-image: ${CHEVRON}; -webkit-mask-position: center; -webkit-mask-size: 12px 12px; -webkit-mask-repeat: no-repeat; mask-image: ${CHEVRON}; mask-position: center; mask-size: 12px 12px; mask-repeat: no-repeat; pointer-events: none; }
.memcurio-actions { display: flex; gap: 8px; padding-top: 6px; }
.memcurio-button { appearance: none; display: inline-flex; align-items: center; height: 28px; padding: 0 14px; border: 0.5px solid var(--dsw-alias-border-l2); border-radius: 14px; background: none; font: inherit; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-primary); cursor: pointer; }
.memcurio-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.memcurio-button-primary { border-color: transparent; background: var(--dsw-alias-button-primary-fill); color: var(--dsw-alias-label-primary-foreground); }
.memcurio-button-primary:hover:not(:disabled) { background: var(--dsw-alias-button-primary-hover); }
.memcurio-button:disabled { opacity: 0.4; cursor: default; }
.memcurio-button:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 1px; }
@media (prefers-reduced-motion: reduce) { .memcurio-state[data-state="saving"] .memcurio-state-dot { animation: none; } }
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
var import_react5 = require("react");
var MEMCURIO_PLUGIN_ID = "@memcurio/dsh-plugin";
var CONTEXT_ROW_PRIORITY = -1;
var CONTEXT_ROW_SEAT = "conversation.chat.node";
var CONTEXT_ROW_KEY = "context";
var h3 = import_react5.createElement;
function isRenderable(value) {
  return typeof value === "function" || typeof value === "object" && value !== null;
}
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
  return record.kind === "plugin" && record.plugin === MEMCURIO_PLUGIN_ID;
}
function nextContextRow(host) {
  const slots = host.slots;
  if (slots === void 0) return void 0;
  try {
    for (const entry of slots.entries(CONTEXT_ROW_SEAT)) {
      const options = entry.options;
      if (options?.key !== CONTEXT_ROW_KEY) continue;
      const priority = typeof options.priority === "number" ? options.priority : 0;
      if (priority <= CONTEXT_ROW_PRIORITY) continue;
      if (isRenderable(entry.component)) return entry.component;
    }
  } catch {
  }
  return void 0;
}
function DisclosureLine(props) {
  const { title, label, text, icon } = props;
  const [open, setOpen] = (0, import_react5.useState)(false);
  const toggle = () => {
    setOpen((value) => !value);
  };
  return h3(
    "div",
    { className: "memcurio-context", "data-open": open ? "true" : void 0 },
    h3(
      "button",
      {
        type: "button",
        className: "memcurio-context-head",
        "aria-expanded": open,
        onClick: toggle
      },
      h3("span", { className: "memcurio-context-icon" }, icon),
      h3("span", { className: "memcurio-context-title" }, title),
      h3("span", { className: "memcurio-context-sep", "aria-hidden": true }),
      h3("span", { className: "memcurio-context-source", "data-context-source": true }, label),
      h3("span", { className: "memcurio-context-chevron" }, h3(ChevronDownIcon, {}))
    ),
    open && text !== "" ? h3("div", { className: "memcurio-context-body", "data-context-injection-body": true }, text) : null
  );
}
function MemcurioInjectionRow(props) {
  return h3(DisclosureLine, {
    title: props.t("contextRowTitle"),
    label: contextLabelOf(props.data?.source),
    text: contextTextOf(props.data?.content),
    // memcurio's own mark (book and ribbon) leads its own row.
    icon: h3(MemoryMarkIcon, {})
  });
}
function FallbackContextRow(props) {
  return h3(DisclosureLine, {
    title: props.t("message.contextInjection"),
    label: contextLabelOf(props.data?.source),
    text: contextTextOf(props.data?.content),
    // The generic fallback is not memcurio's row: it keeps the platform glyph.
    icon: h3(ContextInjectionIcon, {})
  });
}
function createContextRow(host) {
  const component = function MemcurioContextRow(props) {
    const t = props.t ?? ((key) => key);
    const data = props.node?.data;
    if (isMemcurioInjection(data)) return h3(MemcurioInjectionRow, { t, data });
    const shipped = nextContextRow(host);
    if (shipped !== void 0) {
      return h3(shipped, { ...props, t: host.chatT });
    }
    return h3(FallbackContextRow, { t: host.chatT, data });
  };
  return component;
}

// client/ui/guide-row.ts
var import_react6 = require("react");

// client/ui/locales.ts
var NS2 = "memcurio.ui";
var en2 = {
  nav: "Memory",
  statusIdle: "No memory injected in this session",
  statusActive: "{count} memories injected",
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
  panelDynamic: "Latest dynamic hits",
  panelBudget: "Budget",
  panelReceipts: "Recent memory writes",
  panelNoReceipts: "No memory writes recorded.",
  toastInjected: "Memory injected: {count} hits \xB7 ~{tokens} tokens",
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
  statusActive: "\u5DF2\u6CE8\u5165 {count} \u6761\u8BB0\u5FC6",
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
  panelDynamic: "\u6700\u8FD1\u52A8\u6001\u547D\u4E2D",
  panelBudget: "\u9884\u7B97",
  panelReceipts: "\u6700\u8FD1\u5199\u5165",
  panelNoReceipts: "\u6682\u65E0\u8BB0\u5FC6\u5199\u5165\u8BB0\u5F55\u3002",
  toastInjected: "\u5DF2\u6CE8\u5165\u8BB0\u5FC6\uFF1A\u547D\u4E2D {count} \u6761 \xB7 \u7EA6 {tokens} tokens",
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

// client/ui/guide-row.ts
var GUIDE_NODE_KIND = "memcurio-guide-injected";
var GUIDE_HEADING = "## memcurio memory";
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
function seqOf(event) {
  return typeof event.seq === "number" && Number.isFinite(event.seq) ? event.seq : 0;
}
function locationSeq(value) {
  return typeof value === "number" && Number.isFinite(value) ? value : void 0;
}
function anchorSeqOf(match) {
  const seq = seqOf(match.event);
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
      return { id: String(seqOf(event)), role: "start" };
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
  const [open, setOpen] = (0, import_react6.useState)(false);
  const data = props.node?.data;
  if (data === void 0) return null;
  const text = typeof data.text === "string" ? data.text : "";
  const chars = typeof data.chars === "number" ? data.chars : text.length;
  const tools = typeof data.tools === "number" ? data.tools : 0;
  const t = props.t ?? ((key) => key);
  const toggle = () => {
    setOpen((value) => !value);
  };
  return (0, import_react6.createElement)(
    "div",
    {
      className: "memcurio-context",
      "data-open": open ? "true" : void 0,
      "data-memcurio-guide": ""
    },
    (0, import_react6.createElement)(
      "button",
      {
        type: "button",
        className: "memcurio-context-head",
        "aria-expanded": open,
        onClick: toggle
      },
      (0, import_react6.createElement)("span", { className: "memcurio-context-icon" }, (0, import_react6.createElement)(MemoryMarkIcon, {})),
      // Collapsed line: the mark and the short title only. The measured facts
      // (characters, named tools) open the expanded body — the MCP-row
      // convention, where the collapsed row stays a quiet one-liner.
      (0, import_react6.createElement)("span", { className: "memcurio-context-title" }, t("guideRowTitle")),
      (0, import_react6.createElement)("span", { className: "memcurio-context-chevron" }, (0, import_react6.createElement)(ChevronDownIcon, {}))
    ),
    open && text !== "" ? (0, import_react6.createElement)(
      "div",
      { className: "memcurio-context-body", "data-memcurio-guide-body": true },
      t("guideRowDetail", { chars, tools }),
      "\n\n",
      text
    ) : null
  );
}
function registerGuideRow(ctx) {
  if (typeof ctx.inject !== "function") return;
  try {
    ctx.inject(["uiConversation"], (scope) => {
      try {
        scope.effect(() => {
          const disposeDefinition = scope.uiConversation.events.register(createGuideNodeDefinition());
          scope.slots.inject("conversation.chat.node", () => {
            scope.slots.register(
              { name: "conversation.chat.node", key: GUIDE_NODE_KIND, locale: NS2 },
              MemcurioGuideRow
            );
            return void 0;
          });
          return () => {
            if (typeof disposeDefinition === "function") disposeDefinition();
          };
        }, "memcurio: system-prompt guide row");
      } catch {
      }
    });
  } catch {
  }
}

// client/ui/model.ts
function estimateTokens(text) {
  if (text === void 0 || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
function countDynamicHits(text) {
  if (text === void 0 || text.length === 0) return 0;
  let hits = 0;
  for (const line of text.split("\n")) {
    if (/^\S+:\d+\s/.test(line.trimStart())) hits += 1;
  }
  return hits;
}
function injectionView(input) {
  const staticText = input.staticText?.trim() ?? "";
  const readGuide = input.readGuide?.trim() ?? "";
  const dynamicText = input.dynamicText?.trim() ?? "";
  return {
    ...staticText ? { staticText } : {},
    ...readGuide ? { readGuide } : {},
    ...dynamicText ? { dynamicText } : {},
    ...input.budgetTokens !== void 0 ? { budgetTokens: input.budgetTokens } : {},
    hits: countDynamicHits(dynamicText),
    tokens: estimateTokens(`${staticText}
${dynamicText}`),
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
  "extract.queue_unblocked"
]);
function isWritePathAction(action) {
  if (NON_WRITE_EXTRACT_ACTIONS.has(action)) {
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
  return left.staticText === right.staticText && left.readGuide === right.readGuide && left.dynamicText === right.dynamicText && left.budgetTokens === right.budgetTokens && left.hits === right.hits && left.tokens === right.tokens && // `duplicate` is state too: without it a repeat fold of the same content
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
      const dynamicText = source.dynamicText?.trim() ?? "";
      const hasContent = Boolean(staticText || source.readGuide?.trim() || dynamicText);
      const previous = state.injection;
      const injection = hasContent ? injectionView({
        staticText: source.staticSummary,
        readGuide: source.readGuide,
        dynamicText: source.dynamicText,
        budgetTokens: snapshot.settings?.injectBudgetTokens,
        // Compare the TRIMMED text the view stores (injectionView trims):
        // a static summary with trailing whitespace is still the same
        // static part.
        duplicate: (previous?.staticText ?? "") === staticText && (previous?.dynamicText ?? "") === dynamicText
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
            // Static is sticky (injected once per session, re-sent after
            // compaction); dynamic is per-step: an omitted piece means this
            // step had no dynamic hits, not "keep the previous ones".
            staticText: delta.staticText ?? previous?.staticText,
            readGuide: previous?.readGuide,
            dynamicText: delta.dynamicText,
            budgetTokens: delta.budgetTokens ?? previous?.budgetTokens,
            duplicate: delta.duplicate
          });
          changed = true;
          events.push({ type: "injection", hits: injection.hits, tokens: injection.tokens, duplicate: delta.duplicate });
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
.memcurio-switch { box-sizing: border-box; position: relative; flex: 0 0 auto; width: 36px; height: 20px; padding: 2px; border: 0; border-radius: 10px; corner-shape: round; background: var(--dsw-alias-border-l3); cursor: pointer; }
.memcurio-switch[aria-checked="true"] { background: var(--dsw-alias-brand-primary); }
.memcurio-switch:disabled { cursor: default; opacity: 0.5; }
.memcurio-switch:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.memcurio-switch-thumb { display: block; width: 16px; height: 16px; border-radius: 50%; corner-shape: round; background: var(--dsw-alias-label-primary-foreground); transition: transform 120ms ease; }
.memcurio-switch[aria-checked="true"] .memcurio-switch-thumb { transform: translate(16px); }
.memcurio-switch-row { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 36px; }
.memcurio-switch-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.memcurio-switch-label { font-size: 12px; font-weight: 600; color: var(--dsw-alias-label-primary); }
.memcurio-switch-hint { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary); }
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
  .memcurio-switch-thumb { transition: none; }
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
var import_react7 = require("react");
var MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_list",
  "memory_read",
  "memory_remember",
  "memory_status",
  "memory_context",
  "memory_cite"
];
var h4 = import_react7.createElement;
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
  return h4(
    "span",
    { className: "memcurio-tool-leading" },
    h4("span", { className: "memcurio-tool-leading-state" }, h4(MemoryMarkIcon, {})),
    h4("span", { className: "memcurio-tool-leading-chevron", "data-open": open ? "true" : "false" }, h4(ChevronDownIcon, {}))
  );
}
function MemoryToolRow(props) {
  const { t, block } = props;
  const [open, setOpen] = (0, import_react7.useState)(false);
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
  return h4(
    "div",
    { className: "memcurio-tool" },
    h4(
      "div",
      {
        className: "memcurio-tool-head",
        "data-state": state,
        ...state === "running" ? { "aria-busy": true } : {},
        ...expandable ? { role: "button", tabIndex: 0, "aria-expanded": open } : {},
        ...expandable ? { onClick: toggle, onKeyDown } : {}
      },
      h4("span", { className: "memcurio-tool-leading" }, leading(open)),
      h4("span", { className: "memcurio-tool-title" }, props.toolName ?? "memory"),
      summary !== "" ? [
        h4("span", { className: "memcurio-tool-sep", key: "sep" }),
        h4(
          "span",
          {
            className: state === "error" ? "memcurio-tool-summary memcurio-tool-summary-error" : "memcurio-tool-summary",
            key: "summary"
          },
          summary
        )
      ] : null,
      h4("span", { className: "memcurio-sr" }, stateLabel(state, t))
    ),
    open ? h4(
      "div",
      { className: "memcurio-tool-body" },
      args !== "" ? h4("span", { className: "memcurio-tool-label" }, t("toolArguments")) : null,
      args !== "" ? h4("pre", { className: "memcurio-tool-code" }, args) : null,
      body !== "" ? h4("span", { className: "memcurio-tool-label" }, t("toolResult")) : null,
      body !== "" ? h4("pre", { className: "memcurio-tool-code", ...state === "error" ? { "data-error": true } : {} }, body) : null,
      args === "" && body === "" ? h4("span", { className: "memcurio-tool-label" }, t("toolEmpty")) : null
    ) : null
  );
}
function memoryToolView(name) {
  return function MemoryToolView(props) {
    return h4(MemoryToolRow, { ...props, toolName: name });
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
      return typeof delta.sessionId === "string" && typeof delta.partId === "string";
    case "compaction-prune":
      return typeof delta.sessionId === "string" && Array.isArray(delta.seqs);
    case "queue-updated":
      return typeof delta.jobId === "string" && typeof delta.status === "string";
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
function statusOf(error) {
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
    const status = statusOf(error);
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
var inject = ["slots", "locale", "settingsScope", "sessions"];
function chatTranslate(ctx) {
  try {
    const locale = ctx.locale;
    return locale === void 0 ? (key) => key : locale.bind("chat");
  } catch {
    return (key) => key;
  }
}
function currentSessionId(ctx) {
  try {
    const sessions = ctx.sessions;
    const current = sessions?.list.getSnapshot().current;
    return typeof current === "string" && current !== "" ? current : void 0;
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
    if (event.duplicate && event.hits === 0) return;
    if (event.hits > 0) {
      toasts.push({
        key: `inject:${String(event.hits)}:${String(event.tokens)}`,
        icon: "injection",
        text: t("toastInjected", { count: event.hits, tokens: event.tokens })
      });
      return;
    }
    if (event.tokens > 0) {
      toasts.push({
        key: `inject-static:${String(event.tokens)}`,
        icon: "injection",
        text: t("toastInjectedStatic", { tokens: event.tokens })
      });
    }
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
  const scope = ctx.settingsScope.bind({
    namespace: NAMESPACE,
    decode: decodeSettings
  });
  const controller = new MemcurioSettingsController(scope);
  ctx.effect(() => controller.start(), "memcurio: settings scope subscription");
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
          hooks: { face: controller.faceHook() },
          save: (field, value) => controller.save(field, value),
          reset: (field) => controller.reset(field),
          resetAll: () => controller.resetAll(),
          saveRoute: (provider, model) => controller.saveRoute(provider, model),
          resetRoute: () => controller.resetRoute()
        })
      },
      MemcurioSettingsSection
    )
  );
  ctx.effect(() => startSettingsNavWatcher(), "memcurio: settings nav mark watcher");
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
    const sessions = ctx.sessions;
    if (sessions === void 0) return () => void 0;
    let current = currentSessionId(ctx);
    return sessions.list.subscribe(() => {
      const next = currentSessionId(ctx);
      if (next === current) return;
      current = next;
      store.resetStoreView();
      transport?.rebind();
    });
  }, "memcurio: session switches");
  ctx.effect(() => () => toasts.dispose(), "memcurio: toasts");
  ctx.slots.inject(
    "conversation.chat.node",
    () => ctx.slots.register(
      { name: "conversation.chat.node", key: "context", priority: CONTEXT_ROW_PRIORITY, locale: NS2 },
      createContextRow({ slots: ctx.slots, chatT: chatTranslate(ctx) })
    )
  );
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
