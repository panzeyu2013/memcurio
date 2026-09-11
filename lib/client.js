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
  "hostBridge",
  "provider",
  "model"
];
var ERROR_KEYS = {
  routePair: "errRoutePair",
  budgetRange: "errBudgetRange",
  notLanded: "errNotLanded",
  resetNotLanded: "errResetNotLanded",
  partialReset: "errPartialReset",
  hostRejected: "errHostRejected"
};
var DEFAULT_VIEW = {
  scope: "workspace",
  injectContext: true,
  registerTools: true,
  hostBridge: false
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
    hostBridge: section.hostBridge === true,
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
    const view = this.face().value;
    const problem = routeProblem(field, value, view) ?? (field === "injectBudgetTokens" ? budgetProblem(value) : void 0);
    if (problem) return this.fail(problem);
    this.busy = field;
    this.notify();
    try {
      await this.scope.set(field, value);
    } catch {
      return this.fail(ERROR_KEYS.hostRejected);
    }
    if (!this.verifyValue(field, value)) {
      return this.fail(ERROR_KEYS.notLanded);
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
    this.busy = "all";
    this.notify();
    const ops = nextProvider === "" ? [
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
    if (!this.verifyRoute(nextProvider, nextModel)) return this.fail(ERROR_KEYS.notLanded);
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
   *  scalars, so strict identity is exact (no JSON-ordering caveat). */
  verifyValue(field, value) {
    const snapshot = this.scope.getSnapshot();
    if (snapshot.status !== "ready") return false;
    const user = snapshot.user;
    if (user === null || typeof user !== "object" || !Object.hasOwn(user, field)) return false;
    return Object.is(user[field], value);
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

// client/settings/section.ts
var import_react = require("react");
var h = import_react.createElement;
function checkboxRow(id, checked, disabled, onToggle) {
  return h("input", {
    id,
    type: "checkbox",
    checked,
    disabled,
    onChange: (event) => onToggle(event.target.checked)
  });
}
function MemcurioSettingsSection(props) {
  const { t, useFace, save, reset, resetAll, saveRoute, resetRoute } = props;
  const face = useFace((snapshot) => snapshot);
  const [draftBudget, setDraftBudget] = (0, import_react.useState)(face.value.injectBudgetTokens === void 0 ? "" : String(face.value.injectBudgetTokens));
  const [draftProvider, setDraftProvider] = (0, import_react.useState)(face.value.provider ?? "");
  const [draftModel, setDraftModel] = (0, import_react.useState)(face.value.model ?? "");
  const [notice, setNotice] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => {
    setDraftBudget(face.value.injectBudgetTokens === void 0 ? "" : String(face.value.injectBudgetTokens));
    setDraftProvider(face.value.provider ?? "");
    setDraftModel(face.value.model ?? "");
  }, [face.value.injectBudgetTokens, face.value.provider, face.value.model]);
  const busy = face.busy !== void 0;
  const faceRef = (0, import_react.useRef)(face);
  (0, import_react.useEffect)(() => {
    faceRef.current = face;
  }, [face]);
  const announce = (0, import_react.useCallback)(
    (outcome) => {
      setNotice(outcome.ok ? t("saved") : t(outcome.code));
      if (!outcome.ok) {
        const current = faceRef.current.value;
        setDraftBudget(current.injectBudgetTokens === void 0 ? "" : String(current.injectBudgetTokens));
        setDraftProvider(current.provider ?? "");
        setDraftModel(current.model ?? "");
      }
    },
    [t]
  );
  const commitRoute = (0, import_react.useCallback)(() => {
    const provider = draftProvider.trim();
    const model = draftModel.trim();
    const current = faceRef.current.value;
    if (provider === (current.provider ?? "") && model === (current.model ?? "")) return;
    void saveRoute(provider, model).then(announce);
  }, [announce, draftModel, draftProvider, saveRoute]);
  const commitBudget = (0, import_react.useCallback)(() => {
    const current = faceRef.current.value;
    const draft = draftBudget.trim();
    if (draft === (current.injectBudgetTokens === void 0 ? "" : String(current.injectBudgetTokens))) return;
    if (draft === "") {
      void reset("injectBudgetTokens").then(announce);
      return;
    }
    void save("injectBudgetTokens", Number(draft)).then(announce);
  }, [announce, draftBudget, reset, save]);
  const status = (0, import_react.useMemo)(() => {
    if (face.status === "loading") return t("loading");
    if (face.status === "unavailable") return face.mode === "memory" ? t("readOnly") : t("unavailable");
    if (!face.writable) return t("readOnly");
    if (busy) return t("saving");
    return t("ready");
  }, [busy, face.mode, face.status, face.writable, t]);
  if (face.status === "loading" || face.status === "unavailable") {
    return h(
      "section",
      { className: "memcurio-panel" },
      h("h2", null, t("title")),
      h("p", { className: "memcurio-note", role: "status" }, status)
    );
  }
  const field = (key, control, onReset) => h(
    "div",
    { className: "memcurio-field", key },
    h(
      "div",
      { className: "memcurio-field-head" },
      h("label", { className: "memcurio-label", htmlFor: `memcurio-${key}` }, t(key)),
      face.overridden.includes(key) ? h(
        "span",
        { className: "memcurio-badge" },
        t("overridden"),
        h(
          "button",
          {
            type: "button",
            className: "memcurio-reset",
            disabled: busy || !face.writable,
            onClick: () => {
              const action = onReset ? onReset() : reset(key);
              void action.then(announce);
            }
          },
          t("reset")
        )
      ) : null
    ),
    control
  );
  const keySubmit = (commit) => (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  };
  return h(
    "section",
    { className: "memcurio-panel" },
    h("h2", null, t("title")),
    h("p", { className: "memcurio-note" }, t("intro")),
    h("p", { className: "memcurio-status", role: "status" }, status, notice ? ` \xB7 ${notice}` : ""),
    !face.writable ? h("p", { className: "memcurio-warn" }, t("readOnly")) : null,
    face.errorCode ? h("p", { className: "memcurio-warn", role: "alert" }, t(face.errorCode)) : null,
    field(
      "scope",
      h(
        "select",
        {
          id: "memcurio-scope",
          value: face.value.scope,
          disabled: busy || !face.writable,
          onChange: (event) => {
            void save("scope", event.target.value).then(announce);
          }
        },
        h("option", { value: "workspace" }, t("scopeWorkspace")),
        h("option", { value: "global" }, t("scopeGlobal"))
      )
    ),
    field(
      "injectContext",
      checkboxRow("memcurio-injectContext", face.value.injectContext, busy || !face.writable, (next) => {
        void save("injectContext", next).then(announce);
      })
    ),
    field(
      "registerTools",
      checkboxRow("memcurio-registerTools", face.value.registerTools, busy || !face.writable, (next) => {
        void save("registerTools", next).then(announce);
      })
    ),
    field(
      "injectBudgetTokens",
      h("input", {
        id: "memcurio-injectBudgetTokens",
        type: "number",
        min: 128,
        step: 1,
        value: draftBudget,
        readOnly: busy || !face.writable,
        onChange: (event) => setDraftBudget(event.target.value),
        onBlur: commitBudget,
        onKeyDown: keySubmit(commitBudget)
      })
    ),
    field(
      "hostBridge",
      checkboxRow("memcurio-hostBridge", face.value.hostBridge, busy || !face.writable, (next) => {
        void save("hostBridge", next).then(announce);
      })
    ),
    field(
      "provider",
      h("input", {
        id: "memcurio-provider",
        type: "text",
        value: draftProvider,
        placeholder: "deepseek",
        readOnly: busy || !face.writable,
        onChange: (event) => setDraftProvider(event.target.value),
        onBlur: commitRoute,
        onKeyDown: keySubmit(commitRoute)
      }),
      () => resetRoute()
    ),
    field(
      "model",
      h("input", {
        id: "memcurio-model",
        type: "text",
        value: draftModel,
        placeholder: "deepseek-v4",
        readOnly: busy || !face.writable,
        onChange: (event) => setDraftModel(event.target.value),
        onBlur: commitRoute,
        onKeyDown: keySubmit(commitRoute)
      }),
      () => resetRoute()
    ),
    h("p", { className: "memcurio-note" }, t("routeNote")),
    h("p", { className: "memcurio-note" }, t("routeApplyNote")),
    h("p", { className: "memcurio-note" }, t("scopeNote")),
    h("p", { className: "memcurio-note" }, t("restartTools")),
    h("p", { className: "memcurio-note" }, t("rootNote")),
    h(
      "div",
      { className: "memcurio-actions" },
      h(
        "button",
        {
          type: "button",
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

// client/settings/locales.ts
var NS = "memcurio.settings";
var en = {
  nav: "Memory",
  title: "Memory (memcurio)",
  intro: "Durable cross-session memory for this harness instance. The profile bundle supplies the defaults; values saved here override them.",
  scope: "Storage scope",
  scopeWorkspace: "Per workspace (isolated store)",
  scopeGlobal: "Shared store (global)",
  injectContext: "Inject memory into the agent loop",
  registerTools: "Register the memory tools",
  injectBudgetTokens: "Injection budget (tokens)",
  hostBridge: "Memory workbench host bridge",
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
  errResetNotLanded: "The host refused the reset (the override is still active)",
  errPartialReset: "Some overrides could not be cleared; retry per field",
  errHostRejected: "The settings transport rejected the write",
  readOnly: "This client is read-only for settings (process-local settings mode).",
  unavailable: "The memcurio settings namespace is not exposed by this host.",
  loading: "Loading settings\u2026",
  restartTools: "Tool registration changes take effect after a restart.",
  scopeNote: "Scope changes apply to new sessions; existing stores keep their root.",
  rootNote: "The data root stays deployment-level (profile config / MEMCURIO_ROOT) and is read-only here.",
  routeNote: "Provider and model are written together as one route; leave both empty to follow the session route.",
  routeApplyNote: "Edit either half and press Enter (or leave the field) to apply the pair."
};
var zh = {
  nav: "\u8BB0\u5FC6",
  title: "\u8BB0\u5FC6\uFF08memcurio\uFF09",
  intro: "\u4E3A\u8BE5 harness \u5B9E\u4F8B\u63D0\u4F9B\u8DE8\u4F1A\u8BDD\u6301\u4E45\u8BB0\u5FC6\u3002profile \u914D\u7F6E\u63D0\u4F9B\u9ED8\u8BA4\u503C\uFF0C\u6B64\u5904\u4FDD\u5B58\u7684\u503C\u5C06\u8986\u76D6\u9ED8\u8BA4\u3002",
  scope: "\u5B58\u50A8\u4F5C\u7528\u57DF",
  scopeWorkspace: "\u6309\u5DE5\u4F5C\u533A\u9694\u79BB",
  scopeGlobal: "\u5171\u4EAB store\uFF08\u5168\u5C40\uFF09",
  injectContext: "\u5411 agent loop \u6CE8\u5165\u8BB0\u5FC6",
  registerTools: "\u6CE8\u518C\u8BB0\u5FC6\u5DE5\u5177",
  injectBudgetTokens: "\u6CE8\u5165\u9884\u7B97\uFF08token\uFF09",
  hostBridge: "\u8BB0\u5FC6\u5DE5\u4F5C\u53F0 host \u6865",
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
  errResetNotLanded: "\u5BBF\u4E3B\u62D2\u7EDD\u4E86\u6062\u590D\u9ED8\u8BA4\uFF08\u8986\u76D6\u4ECD\u7136\u751F\u6548\uFF09",
  errPartialReset: "\u90E8\u5206\u8986\u76D6\u672A\u80FD\u6E05\u9664\uFF0C\u8BF7\u9010\u5B57\u6BB5\u91CD\u8BD5",
  errHostRejected: "\u8BBE\u7F6E\u4F20\u8F93\u62D2\u7EDD\u4E86\u672C\u6B21\u5199\u5165",
  readOnly: "\u5F53\u524D\u5BA2\u6237\u7AEF\u4E3A\u53EA\u8BFB\u8BBE\u7F6E\u6A21\u5F0F\uFF08\u8FDB\u7A0B\u5185\u8BBE\u7F6E\uFF09\u3002",
  unavailable: "\u8BE5\u5BBF\u4E3B\u672A\u66B4\u9732 memcurio \u8BBE\u7F6E\u547D\u540D\u7A7A\u95F4\u3002",
  loading: "\u6B63\u5728\u52A0\u8F7D\u8BBE\u7F6E\u2026",
  restartTools: "\u8BB0\u5FC6\u5DE5\u5177\u6CE8\u518C\u53D8\u66F4\u5C06\u5728\u91CD\u542F\u540E\u751F\u6548\u3002",
  scopeNote: "\u4F5C\u7528\u57DF\u53D8\u66F4\u5BF9\u65B0\u4F1A\u8BDD\u751F\u6548\uFF1B\u65E2\u6709 store \u4FDD\u6301\u539F\u6570\u636E\u6839\u3002",
  rootNote: "\u6570\u636E\u6839\u5C5E\u90E8\u7F72\u7EA7\uFF08profile \u914D\u7F6E / MEMCURIO_ROOT\uFF09\uFF0C\u6B64\u5904\u53EA\u8BFB\u3002",
  routeNote: "provider \u4E0E model \u4F5C\u4E3A\u4E00\u4E2A\u8DEF\u7531\u6210\u5BF9\u5199\u5165\uFF1B\u4E24\u8005\u7559\u7A7A\u5219\u8DDF\u968F\u4F1A\u8BDD\u8DEF\u7531\u3002",
  routeApplyNote: "\u4FEE\u6539\u4EFB\u4E00\u534A\u540E\u6309 Enter\uFF08\u6216\u79BB\u5F00\u8F93\u5165\u6846\uFF09\u5373\u63D0\u4EA4\u6574\u5BF9\u3002"
};

// client/settings/styles.ts
var STYLE_ID = "memcurio-settings-css";
var CSS = `
.memcurio-panel { display: flex; flex-direction: column; gap: 10px; max-width: 640px; }
.memcurio-panel h2 { margin: 0; font-size: 16px; }
.memcurio-note { margin: 0; opacity: 0.72; font-size: 12px; line-height: 1.5; }
.memcurio-status { margin: 0; font-size: 12px; opacity: 0.85; }
.memcurio-warn { margin: 0; font-size: 12px; color: #d9822b; }
.memcurio-field { display: flex; flex-direction: column; gap: 4px; padding: 8px 0; border-top: 1px solid rgba(127,127,127,0.18); }
.memcurio-field-head { display: flex; align-items: center; gap: 8px; }
.memcurio-label { font-size: 13px; font-weight: 600; }
.memcurio-badge { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; opacity: 0.8; }
.memcurio-reset { font-size: 11px; cursor: pointer; }
.memcurio-field input[type="text"], .memcurio-field input[type="number"], .memcurio-field select {
  padding: 4px 6px; font-size: 13px; max-width: 320px;
}
.memcurio-actions { display: flex; gap: 8px; padding-top: 6px; }
.memcurio-actions button { font-size: 12px; cursor: pointer; }
`;
function mountStyles() {
  if (typeof document === "undefined") return () => void 0;
  const existing = document.getElementById(STYLE_ID);
  if (existing) return () => void 0;
  const tag = document.createElement("style");
  tag.id = STYLE_ID;
  tag.setAttribute("data-plugin-css", "memcurio");
  tag.textContent = CSS;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
  };
}

// client/entry.ts
var inject = ["slots", "locale", "settingsScope"];
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
}

		return module.exports;
	}
});
