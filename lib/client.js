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

// client/ui/injection-indicator.ts
var import_react3 = require("react");

// client/ui/icons.ts
var import_react2 = require("react");
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
function MemoryMarkIcon({ size = 14 }) {
  return (0, import_react2.createElement)(
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
    ...MEMORY_MARK_PATHS.map((d) => (0, import_react2.createElement)("path", { key: d, d }))
  );
}
function ContextInjectionIcon({ size = 14 }) {
  return (0, import_react2.createElement)(
    "svg",
    { width: size, height: size, viewBox: "0 0 16 16", fill: "none", "aria-hidden": true, focusable: "false" },
    ...CONTEXT_INJECTION_PATHS.map((d) => (0, import_react2.createElement)("path", { key: d, d, fill: "currentColor" }))
  );
}
function ChevronDownIcon({ size = 14 }) {
  return (0, import_react2.createElement)(
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
    (0, import_react2.createElement)("path", { d: "M6 9l6 6 6-6" })
  );
}
function MemoryStateDot({ state }) {
  return (0, import_react2.createElement)("span", { className: "memcurio-dot", "data-state": state, "aria-hidden": true });
}

// client/ui/injection-indicator.ts
var h2 = import_react3.createElement;
function formatTime(at) {
  try {
    return new Date(at).toLocaleTimeString(void 0, { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}
function preview(label, text) {
  return h2(
    "div",
    { className: "memcurio-section", key: label },
    h2("span", { className: "memcurio-section-label" }, label),
    h2("pre", { className: "memcurio-preview" }, text)
  );
}
function budgetBar(injection, t) {
  if (injection.budgetTokens === void 0 || injection.budgetTokens <= 0) return null;
  const ratio = Math.min(1, injection.tokens / injection.budgetTokens);
  return h2(
    "div",
    { className: "memcurio-section memcurio-budget", key: "budget" },
    h2(
      "span",
      { className: "memcurio-section-label" },
      `${t("panelBudget")} \xB7 ${String(injection.tokens)}/${String(injection.budgetTokens)}`
    ),
    h2("div", { className: "memcurio-budget-bar" }, h2("div", { className: "memcurio-budget-fill", style: { width: `${String(Math.round(ratio * 100))}%` } }))
  );
}
function receiptRow(receipt, t) {
  return h2(
    "div",
    { className: "memcurio-receipt", key: receipt.key },
    h2("span", { className: "memcurio-receipt-time" }, formatTime(receipt.at)),
    h2("span", { className: "memcurio-receipt-action" }, actionLabel(receipt.action, t)),
    h2("span", { className: "memcurio-receipt-detail", title: receipt.detail }, receipt.detail || (receipt.object ?? ""))
  );
}
function actionLabel(action, t) {
  if (action.startsWith("extract.")) return t("actionExtract");
  if (action.startsWith("adhoc.")) return t("actionAdhoc");
  if (action.startsWith("consolidate.")) return t("actionConsolidate");
  if (action.startsWith("prune.")) return t("actionPrune");
  if (action.startsWith("purge.")) return t("actionPurge");
  return t("actionOther");
}
function panel(props) {
  const { t, injection, receipts, realtime } = props;
  const sections = [];
  if (injection !== null) {
    if (injection.staticText !== void 0) sections.push(preview(t("panelStatic"), injection.staticText));
    if (injection.readGuide !== void 0) sections.push(preview(t("panelReadGuide"), injection.readGuide));
    if (injection.dynamicText !== void 0) {
      sections.push(preview(`${t("panelDynamic")} \xB7 ${String(injection.hits)}`, injection.dynamicText));
    }
    const budget = budgetBar(injection, t);
    if (budget !== null) sections.push(budget);
  } else {
    sections.push(h2("p", { className: "memcurio-empty", key: "empty" }, t("panelNoInjection")));
  }
  sections.push(
    h2(
      "div",
      { className: "memcurio-section", key: "receipts" },
      h2("span", { className: "memcurio-section-label" }, t("panelReceipts")),
      receipts.length === 0 ? h2("p", { className: "memcurio-empty" }, t("panelNoReceipts")) : h2("div", { className: "memcurio-section" }, ...receipts.slice(0, 8).map((receipt) => receiptRow(receipt, t)))
    )
  );
  return h2(
    "div",
    { className: "memcurio-popover", role: "dialog", "aria-label": t("nav") },
    h2(
      "div",
      { className: "memcurio-popover-head" },
      h2(ContextInjectionIcon, {}),
      h2("span", {}, t("panelInjection")),
      realtime !== "push" ? h2("span", { className: "memcurio-empty" }, realtime === "polling" ? t("statusDegraded") : t("statusOffline")) : null
    ),
    ...sections
  );
}
function MemoryInjectionIndicator(props) {
  const { t, useMemory, markSeen } = props;
  const state = useMemory((snapshot) => snapshot);
  const [open, setOpen] = (0, import_react3.useState)(false);
  const wrapRef = (0, import_react3.useRef)(null);
  (0, import_react3.useEffect)(() => {
    if (!open) return () => void 0;
    const onPointerDown = (event) => {
      const target = event.target;
      if (target instanceof Node && wrapRef.current?.contains(target) === true) return;
      setOpen(false);
    };
    const onKeyDown = (event) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  const injection = state.injection;
  const count = injection?.hits ?? 0;
  const active = injection !== null;
  const dataState = state.realtime === "off" ? "offline" : state.realtime === "polling" && active ? "degraded" : active ? "active" : "idle";
  const label = active ? count > 0 ? t("statusActive", { count, tokens: injection.tokens }) : t("statusStatic", { tokens: injection.tokens }) : t("statusIdle");
  const modeNote = state.realtime === "polling" ? t("statusDegraded") : state.realtime === "off" ? t("statusOffline") : "";
  const toggle = (0, import_react3.useCallback)(() => {
    setOpen((value) => {
      const next = !value;
      if (next && state.unread > 0) markSeen();
      return next;
    });
  }, [markSeen, state.unread]);
  return h2(
    "div",
    { style: { position: "relative" }, ref: wrapRef },
    h2(
      "button",
      {
        type: "button",
        className: "memcurio-indicator",
        "data-state": dataState,
        title: `${label} \xB7 ${t("statusTokens", { tokens: injection?.tokens ?? 0 })}${modeNote === "" ? "" : ` \xB7 ${modeNote}`}`,
        "aria-label": label,
        "aria-expanded": open,
        onClick: toggle
      },
      h2(ContextInjectionIcon, {}),
      active ? h2("span", { className: "memcurio-indicator-count" }, count > 0 ? String(count) : "\u2022") : null,
      state.unread > 0 ? h2("span", { className: "memcurio-indicator-unread" }) : null
    ),
    open ? panel({ t, injection, receipts: state.receipts, realtime: state.realtime }) : null
  );
}

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
  statusError: "Memory UI unavailable",
  panelInjection: "Injection",
  panelNoInjection: "No memory was injected into this session yet.",
  panelStatic: "Static context",
  panelReadGuide: "Read guide",
  panelDynamic: "Latest dynamic hits",
  panelBudget: "Budget",
  panelReceipts: "Recent memory writes",
  panelNoReceipts: "No memory writes recorded.",
  panelUnread: "{count} unread",
  panelHint: "Open the memcurio workbench\u2026",
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
  toolResult: "Result",
  toolExpand: "Show details",
  toolCollapse: "Hide details"
};
var zh2 = {
  nav: "\u8BB0\u5FC6",
  statusIdle: "\u672C\u4F1A\u8BDD\u5C1A\u672A\u6CE8\u5165\u8BB0\u5FC6",
  statusActive: "\u5DF2\u6CE8\u5165 {count} \u6761\u8BB0\u5FC6",
  statusStatic: "\u5DF2\u6CE8\u5165\u8BB0\u5FC6\u6458\u8981",
  statusTokens: "\u7EA6 {tokens} tokens",
  statusDegraded: "\u5B9E\u65F6\u6027\u964D\u7EA7\uFF08\u8F6E\u8BE2\u4E2D\uFF09",
  statusOffline: "\u8BB0\u5FC6\u754C\u9762\u79BB\u7EBF",
  statusError: "\u8BB0\u5FC6\u754C\u9762\u4E0D\u53EF\u7528",
  panelInjection: "\u6CE8\u5165\u9762",
  panelNoInjection: "\u672C\u4F1A\u8BDD\u5C1A\u672A\u6CE8\u5165\u4EFB\u4F55\u8BB0\u5FC6\u3002",
  panelStatic: "\u9759\u6001\u4E0A\u4E0B\u6587",
  panelReadGuide: "\u8BFB\u53D6\u6307\u5F15",
  panelDynamic: "\u6700\u8FD1\u52A8\u6001\u547D\u4E2D",
  panelBudget: "\u9884\u7B97",
  panelReceipts: "\u6700\u8FD1\u5199\u5165",
  panelNoReceipts: "\u6682\u65E0\u8BB0\u5FC6\u5199\u5165\u8BB0\u5F55\u3002",
  panelUnread: "{count} \u6761\u672A\u8BFB",
  panelHint: "\u6253\u5F00 memcurio \u5DE5\u4F5C\u53F0\u2026",
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
  toolResult: "\u7ED3\u679C",
  toolExpand: "\u5C55\u5F00\u8BE6\u60C5",
  toolCollapse: "\u6536\u8D77\u8BE6\u60C5"
};

// client/ui/model.ts
function estimateTokens(text) {
  if (text === void 0 || text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}
function countDynamicHits(text) {
  if (text === void 0 || text.length === 0) return 0;
  let hits = 0;
  for (const line of text.split("\n")) {
    if (line.trimStart().startsWith("[memcurio] ")) hits += 1;
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
  return left.staticText === right.staticText && left.readGuide === right.readGuide && left.dynamicText === right.dynamicText && left.budgetTokens === right.budgetTokens && left.hits === right.hits && left.tokens === right.tokens;
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
      const hasContent = Boolean(source.staticSummary?.trim() || source.readGuide?.trim() || source.dynamicText?.trim());
      const previous = state.injection;
      const injection = hasContent ? injectionView({
        staticText: source.staticSummary,
        readGuide: source.readGuide,
        dynamicText: source.dynamicText,
        budgetTokens: snapshot.settings?.injectBudgetTokens,
        duplicate: previous?.staticText === source.staticSummary && previous?.dynamicText === source.dynamicText
      }) : null;
      const receipts = snapshot.receipts.filter((row) => row.writePath).slice(0, RECEIPT_LIMIT).map(snapshotReceipt);
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
.memcurio-indicator { position: relative; display: inline-flex; align-items: center; gap: 4px; height: 24px; padding: 0 8px; border: none; border-radius: 6px; background: transparent; color: var(--dsw-alias-label-tertiary, #8a8f98); font-size: 12px; line-height: 18px; cursor: pointer; }
.memcurio-indicator:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); color: var(--dsw-alias-label-primary, #1f2329); }
.memcurio-indicator:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.memcurio-indicator[data-state="active"] { color: var(--dsw-alias-label-secondary, #4b5563); }
.memcurio-indicator[data-state="idle"] { color: var(--dsw-alias-label-dimmed, #9ca3af); }
.memcurio-indicator[data-state="degraded"] { color: var(--dsw-alias-state-warn-primary, #d9822b); }
.memcurio-indicator[data-state="offline"] { color: var(--dsw-alias-label-dimmed, #9ca3af); opacity: 0.72; }
.memcurio-indicator-count { font-variant-numeric: tabular-nums; font-weight: 600; }
.memcurio-indicator-unread { position: absolute; top: 1px; right: 2px; width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-brand-primary, #3b82f6); }
.memcurio-popover { position: absolute; top: calc(100% + 8px); right: 0; z-index: 40; width: 320px; max-height: 60vh; overflow: auto; display: flex; flex-direction: column; gap: 12px; padding: 12px 14px; border: 0.5px solid var(--dsw-alias-border-l4, rgba(127,127,127,0.24)); border-radius: 12px; background: var(--dsw-alias-bg-layer-3, var(--dsw-alias-bg-base, #fff)); box-shadow: 0 10px 30px rgba(0,0,0,0.18); color: var(--dsw-alias-label-primary, #1f2329); cursor: default; }
.memcurio-popover-head { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: 600; }
.memcurio-section { display: flex; flex-direction: column; gap: 4px; }
.memcurio-section-label { font-size: 11px; font-weight: 600; color: var(--dsw-alias-label-tertiary, #8a8f98); text-transform: uppercase; letter-spacing: 0.04em; }
.memcurio-preview { margin: 0; max-height: 96px; overflow: auto; padding: 8px 10px; border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08)); font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-word; }
.memcurio-empty { margin: 0; font-size: 12px; line-height: 18px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.memcurio-budget { display: flex; flex-direction: column; gap: 4px; }
.memcurio-budget-bar { height: 4px; border-radius: 2px; background: var(--dsw-alias-border-l3, rgba(127,127,127,0.24)); overflow: hidden; }
.memcurio-budget-fill { height: 100%; border-radius: 2px; background: var(--dsw-alias-brand-primary, #3b82f6); }
.memcurio-receipt { display: flex; align-items: baseline; gap: 6px; font-size: 12px; line-height: 18px; }
.memcurio-receipt-time { flex: none; font-variant-numeric: tabular-nums; color: var(--dsw-alias-label-dimmed, #9ca3af); }
.memcurio-receipt-action { flex: none; color: var(--dsw-alias-label-secondary, #4b5563); }
.memcurio-receipt-detail { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.memcurio-toasts { position: fixed; top: 16px; left: 50%; transform: translateX(-50%); z-index: 90; display: flex; flex-direction: column; align-items: center; gap: 8px; pointer-events: none; }
.memcurio-toast { display: inline-flex; align-items: center; gap: 8px; max-width: min(520px, 80vw); padding: 8px 14px; border-radius: 10px; background: var(--dsw-alias-bg-inverse, #111827); color: var(--dsw-alias-label-inverse, #f9fafb); font-size: 12px; line-height: 18px; box-shadow: 0 8px 24px rgba(0,0,0,0.24); animation: memcurio-toast-in 160ms ease-out; }
.memcurio-toast-error { background: var(--dsw-alias-state-error-primary, #dc2626); color: #fff; }
.memcurio-toast-out { opacity: 0; transition: opacity 360ms ease-in; }
.memcurio-toast-icon { display: inline-flex; flex: none; align-items: center; }
.memcurio-toast-text { min-width: 0; }
@keyframes memcurio-toast-in { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: none; } }
.memcurio-dot { position: relative; display: inline-block; flex: none; width: 10px; height: 10px; }
.memcurio-dot::before { content: ''; position: absolute; inset: 0; border-radius: 50%; background: currentColor; opacity: 0.1; }
.memcurio-dot::after { content: ''; position: absolute; inset: 20%; border-radius: 50%; background: currentColor; }
.memcurio-dot[data-state="warning"] { color: var(--dsw-alias-state-warn-primary, #d9822b); }
.memcurio-dot[data-state="error"] { color: var(--dsw-alias-state-error-primary, #dc2626); }
.memcurio-tool { display: flex; flex-direction: column; margin: 2px 0; }
.memcurio-tool-head { display: flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px 0 0; border-radius: 8px; cursor: default; }
.memcurio-tool-head[role="button"] { cursor: pointer; }
.memcurio-tool-head[role="button"]:hover { background: var(--dsw-alias-interactive-bg-hover, rgba(127,127,127,0.12)); }
.memcurio-tool-head:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary, #3b82f6); outline-offset: 1px; }
.memcurio-tool-leading { display: inline-flex; align-items: center; justify-content: center; flex: none; width: 16px; height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.memcurio-tool-head[data-state="running"] .memcurio-tool-leading { color: var(--dsw-alias-label-secondary, #4b5563); }
.memcurio-tool-title { flex: none; font-size: 13px; line-height: 24px; color: var(--dsw-alias-label-secondary, #4b5563); white-space: nowrap; }
.memcurio-tool-head[data-state="running"] .memcurio-tool-title { color: var(--dsw-alias-label-primary, #1f2329); }
.memcurio-tool-sep { flex: none; width: 2px; height: 2px; margin: 0 8px; border-radius: 1px; background: var(--dsw-alias-label-caption, #c4c7cc); }
.memcurio-tool-summary { flex: auto; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 13px; line-height: 24px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.memcurio-tool-summary-error { color: var(--dsw-alias-state-error-primary, #dc2626); }
.memcurio-tool-body { display: flex; flex-direction: column; gap: 4px; margin: 2px 0 4px 8px; padding-left: 12px; border-left: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.16)); }
.memcurio-tool-label { font-size: 11px; line-height: 16px; color: var(--dsw-alias-label-tertiary, #8a8f98); }
.memcurio-tool-code { margin: 0; max-height: 200px; overflow: auto; padding: 8px 10px; border: 0.5px solid var(--dsw-alias-border-l2, rgba(127,127,127,0.16)); border-radius: 8px; background: var(--dsw-alias-bg-layer-2, rgba(127,127,127,0.08)); font-family: var(--ds-font-family-code, ui-monospace, monospace); font-size: 11px; line-height: 16px; white-space: pre-wrap; word-break: break-word; color: var(--dsw-alias-label-secondary, #4b5563); }
.memcurio-tool-code[data-error] { color: var(--dsw-alias-state-error-primary, #dc2626); }
.memcurio-sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
`;
function mountUiStyles() {
  if (typeof document === "undefined") return () => void 0;
  const existing = document.getElementById(STYLE_ID2);
  if (existing) return () => void 0;
  const tag = document.createElement("style");
  tag.id = STYLE_ID2;
  tag.setAttribute("data-plugin-css", "memcurio");
  tag.textContent = CSS2;
  document.head.appendChild(tag);
  return () => {
    tag.remove();
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
var import_react4 = require("react");
var MEMORY_TOOL_NAMES = [
  "memory_search",
  "memory_list",
  "memory_read",
  "memory_remember",
  "memory_status",
  "memory_context"
];
var h3 = import_react4.createElement;
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
function leading(state, open) {
  if (state === "error") return h3(MemoryStateDot, { state: "error" });
  if (state === "stopped") return h3(MemoryStateDot, { state: "warning" });
  if (open) return h3(ChevronDownIcon, {});
  return h3(MemoryMarkIcon, {});
}
function MemoryToolRow(props) {
  const { t, block } = props;
  const [open, setOpen] = (0, import_react4.useState)(false);
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
  return h3(
    "div",
    { className: "memcurio-tool" },
    h3(
      "div",
      {
        className: "memcurio-tool-head",
        "data-state": state,
        ...expandable ? { role: "button", tabIndex: 0, "aria-expanded": open } : {},
        ...expandable ? { onClick: toggle, onKeyDown } : {}
      },
      h3("span", { className: "memcurio-tool-leading" }, leading(state, open)),
      h3("span", { className: "memcurio-tool-title" }, props.toolName ?? "memory"),
      summary !== "" ? [
        h3("span", { className: "memcurio-tool-sep", key: "sep" }),
        h3(
          "span",
          {
            className: state === "error" ? "memcurio-tool-summary memcurio-tool-summary-error" : "memcurio-tool-summary",
            key: "summary"
          },
          summary
        )
      ] : null,
      h3("span", { className: "memcurio-sr" }, stateLabel(state, t))
    ),
    open ? h3(
      "div",
      { className: "memcurio-tool-body" },
      args !== "" ? h3("span", { className: "memcurio-tool-label" }, t("toolArguments")) : null,
      args !== "" ? h3("pre", { className: "memcurio-tool-code" }, args) : null,
      body !== "" ? h3("span", { className: "memcurio-tool-label" }, t("toolResult")) : null,
      body !== "" ? h3("pre", { className: "memcurio-tool-code", ...state === "error" ? { "data-error": true } : {} }, body) : null,
      args === "" && body === "" ? h3("span", { className: "memcurio-tool-label" }, t("toolEmpty")) : null
    ) : null
  );
}
function memoryToolView(name) {
  return function MemoryToolView(props) {
    return h3(MemoryToolRow, { ...props, toolName: name });
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
  let pollTimer;
  let retryTimer;
  let lastDeltaSeq = 0;
  let currentRoot;
  let snapshotRequest = 0;
  let appliedSnapshotRequest = 0;
  const signal = () => abort?.signal;
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
      if (parsed.seq > lastDeltaSeq) lastDeltaSeq = parsed.seq;
      const deltas = parsed.deltas.filter(isUiDelta);
      if (deltas.length > 0) options.onDeltas(deltas);
    } catch {
    }
  };
  const readStream = async (body) => {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (; ; ) {
      const { done, value } = await reader.read();
      if (done === true) return;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n\n");
      while (index >= 0) {
        const chunk = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (data !== "") handleFrame(data);
        index = buffer.indexOf("\n\n");
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
    try {
      await readSnapshot();
    } catch (error) {
      handleFailure(error);
      return;
    }
    if (stopped) return;
    try {
      const eventsBase = url("/events");
      const eventsUrl = `${eventsBase}${eventsBase.includes("?") ? "&" : "?"}after=${String(lastDeltaSeq)}`;
      const response = await fetch(eventsUrl, {
        signal: signal(),
        cache: "no-store",
        credentials: "same-origin",
        headers: headers("text/event-stream")
      });
      if (!response.ok || response.body === null) throw statusError(response.status);
      options.onMode?.("push");
      stopPolling();
      await readStream(response.body);
      throw new Error("memcurio event stream ended");
    } catch (error) {
      handleFailure(error);
    }
  };
  return {
    start() {
      if (!stopped) return;
      stopped = false;
      abort = new AbortController();
      lastDeltaSeq = 0;
      void connect();
    },
    stop() {
      if (stopped) return;
      stopped = true;
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
    }
  };
}

// client/entry.ts
var inject = ["slots", "locale", "settingsScope", "sessions"];
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
      transport?.refresh();
    });
  }, "memcurio: session switches");
  ctx.effect(() => () => toasts.dispose(), "memcurio: toasts");
  ctx.slots.inject(
    "conversation.session.header.utilities",
    () => ctx.slots.register(
      {
        name: "conversation.session.header.utilities",
        id: "memcurio",
        order: 40,
        locale: NS2,
        inject: () => ({
          hooks: { memory: store },
          markSeen: () => {
            store.markSeen();
          }
        })
      },
      MemoryInjectionIndicator
    )
  );
  ctx.effect(() => {
    const disposers = MEMORY_TOOL_NAMES.map(
      (name) => ctx.slots.inject(
        "tool.call.toolview",
        () => ctx.slots.register(
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
