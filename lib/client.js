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
    ...typeof section.injectBudgetTokens === "number" ? { injectBudgetTokens: section.injectBudgetTokens } : {},
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
  const hasProvider = typeof nextProvider === "string" && nextProvider.length > 0;
  const hasModel = typeof nextModel === "string" && nextModel.length > 0;
  if (hasProvider !== hasModel) return "provider and model must be set together";
  return void 0;
}
var MemcurioSettingsController = class {
  scope;
  faceCache = null;
  listeners = /* @__PURE__ */ new Set();
  error;
  busy;
  revisionCounter = 0;
  constructor(scope) {
    this.scope = scope;
  }
  /** Stable face reference until the next snapshot/notice (React-friendly). */
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
      ...this.error ? { error: this.error } : {},
      ...this.busy ? { busy: this.busy } : {},
      revision: this.revisionCounter
    };
    return this.faceCache;
  }
  /** Observe transport changes (the panel subscribes for re-render). */
  subscribe(listener) {
    const dispose = this.scope.subscribe(() => this.notify());
    this.listeners.add(listener);
    return () => {
      dispose();
      this.listeners.delete(listener);
    };
  }
  /** Notice after an externally observed document update (remote event). */
  notice() {
    this.notify();
  }
  async save(field, value) {
    const view = this.face().value;
    const problem = routeProblem(field, value, view);
    if (problem) return this.fail(problem);
    this.busy = field;
    this.notify();
    try {
      await this.scope.set(field, value);
    } catch (error) {
      return this.fail(errorText(error));
    }
    if (!this.verify(field, value)) {
      return this.fail("save not landed");
    }
    this.error = void 0;
    this.busy = void 0;
    this.notify();
    return { ok: true };
  }
  async reset(field) {
    this.busy = field;
    this.notify();
    try {
      await this.scope.unset(field);
    } catch (error) {
      return this.fail(errorText(error));
    }
    if (overriddenFields(this.scope.getSnapshot().user).includes(field)) {
      return this.fail("reset not landed");
    }
    this.error = void 0;
    this.busy = void 0;
    this.notify();
    return { ok: true };
  }
  async resetAll() {
    this.busy = "all";
    this.notify();
    for (const field of overriddenFields(this.scope.getSnapshot().user)) {
      try {
        await this.scope.unset(field);
      } catch (error) {
        return this.fail(errorText(error));
      }
    }
    this.busy = void 0;
    return { ok: true };
  }
  /** Post-write verification against the landed user layer/value. */
  verify(field, value) {
    const snapshot = this.scope.getSnapshot();
    if (snapshot.status !== "ready") return false;
    const user = snapshot.user;
    const present = user !== null && typeof user === "object" && Object.hasOwn(user, field);
    if (!present) return false;
    const landed = user[field];
    return JSON.stringify(landed ?? null) === JSON.stringify(value ?? null);
  }
  fail(error) {
    this.error = error;
    this.busy = void 0;
    this.notify();
    return { ok: false, error };
  }
  notify() {
    this.faceCache = null;
    this.revisionCounter += 1;
    for (const listener of this.listeners) listener();
  }
};
function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

// client/settings/section.ts
var import_react = require("react");
var h = import_react.createElement;
function fieldRow(t, key, label, control, overridden, onReset, busy) {
  return h(
    "div",
    { className: "memcurio-field", key },
    h(
      "div",
      { className: "memcurio-field-head" },
      h("label", { className: "memcurio-label", htmlFor: `memcurio-${key}` }, label),
      overridden ? h(
        "span",
        { className: "memcurio-badge" },
        t("overridden"),
        h(
          "button",
          { type: "button", className: "memcurio-reset", onClick: onReset, disabled: busy },
          t("reset")
        )
      ) : null
    ),
    control
  );
}
function MemcurioSettingsSection(props) {
  const { face, subscribe, save, reset, resetAll, t } = props;
  const [, setTick] = (0, import_react.useState)(0);
  const [draftBudget, setDraftBudget] = (0, import_react.useState)(String(face.value.injectBudgetTokens ?? ""));
  const [draftProvider, setDraftProvider] = (0, import_react.useState)(face.value.provider ?? "");
  const [draftModel, setDraftModel] = (0, import_react.useState)(face.value.model ?? "");
  const [notice, setNotice] = (0, import_react.useState)(null);
  (0, import_react.useEffect)(() => subscribe(() => setTick((tick) => tick + 1)), [subscribe]);
  (0, import_react.useEffect)(() => {
    setDraftBudget(face.value.injectBudgetTokens === void 0 ? "" : String(face.value.injectBudgetTokens));
    setDraftProvider(face.value.provider ?? "");
    setDraftModel(face.value.model ?? "");
  }, [face.value.injectBudgetTokens, face.value.provider, face.value.model]);
  const busy = face.busy !== void 0;
  const announce = (0, import_react.useCallback)((outcome) => {
    setNotice(outcome.ok ? t("saved") : t("failed", { error: outcome.error }));
  }, [t]);
  const textSave = (0, import_react.useCallback)(
    (field, raw, clearWhenEmpty) => {
      const trimmed = raw.trim();
      if (clearWhenEmpty && trimmed === "") {
        void reset(field).then(announce);
        return;
      }
      void save(field, trimmed).then(announce);
    },
    [announce, reset, save]
  );
  const status = (0, import_react.useMemo)(() => {
    if (face.status === "loading") return t("loading");
    if (face.status === "unavailable") return t("unavailable");
    return face.mode === "host" ? t("saved") : t("readOnly");
  }, [face.mode, face.status, t]);
  if (face.status === "loading" || face.status === "unavailable") {
    return h("section", { className: "memcurio-panel" }, h("h2", null, t("title")), h("p", { className: "memcurio-note" }, status));
  }
  const control = (key, node) => fieldRow(
    t,
    key,
    t(key),
    node,
    face.overridden.includes(key),
    () => {
      void reset(key).then(announce);
    },
    busy
  );
  return h(
    "section",
    { className: "memcurio-panel" },
    h("h2", null, t("title")),
    h("p", { className: "memcurio-note" }, t("intro")),
    h("p", { className: "memcurio-status" }, status, notice ? ` \xB7 ${notice}` : ""),
    !face.writable ? h("p", { className: "memcurio-warn" }, t("readOnly")) : null,
    face.error ? h("p", { className: "memcurio-warn" }, t("failed", { error: face.error })) : null,
    control(
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
    control(
      "injectContext",
      h("input", {
        id: "memcurio-injectContext",
        type: "checkbox",
        checked: face.value.injectContext,
        disabled: busy || !face.writable,
        onChange: (event) => {
          void save("injectContext", event.target.checked).then(announce);
        }
      })
    ),
    control(
      "registerTools",
      h("input", {
        id: "memcurio-registerTools",
        type: "checkbox",
        checked: face.value.registerTools,
        disabled: busy || !face.writable,
        onChange: (event) => {
          void save("registerTools", event.target.checked).then(announce);
        }
      })
    ),
    control(
      "injectBudgetTokens",
      h("input", {
        id: "memcurio-injectBudgetTokens",
        type: "number",
        min: 128,
        step: 1,
        value: draftBudget,
        disabled: busy || !face.writable,
        onChange: (event) => setDraftBudget(event.target.value),
        onBlur: () => {
          if (draftBudget.trim() === "") {
            void reset("injectBudgetTokens").then(announce);
            return;
          }
          const parsed = Number(draftBudget);
          if (!Number.isSafeInteger(parsed) || parsed < 128) {
            setNotice(t("failed", { error: "injectBudgetTokens must be an integer >= 128" }));
            return;
          }
          void save("injectBudgetTokens", parsed).then(announce);
        }
      })
    ),
    control(
      "hostBridge",
      h("input", {
        id: "memcurio-hostBridge",
        type: "checkbox",
        checked: face.value.hostBridge,
        disabled: busy || !face.writable,
        onChange: (event) => {
          void save("hostBridge", event.target.checked).then(announce);
        }
      })
    ),
    control(
      "provider",
      h("input", {
        id: "memcurio-provider",
        type: "text",
        value: draftProvider,
        placeholder: "deepseek",
        disabled: busy || !face.writable,
        onChange: (event) => setDraftProvider(event.target.value),
        onBlur: () => textSave("provider", draftProvider, true)
      })
    ),
    control(
      "model",
      h("input", {
        id: "memcurio-model",
        type: "text",
        value: draftModel,
        placeholder: "deepseek-v4",
        disabled: busy || !face.writable,
        onChange: (event) => setDraftModel(event.target.value),
        onBlur: () => textSave("model", draftModel, true)
      })
    ),
    h("p", { className: "memcurio-note" }, t("routeNote")),
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
  save: "Save",
  saving: "Saving\u2026",
  saved: "Saved",
  failed: "Save rejected: {error}",
  readOnly: "This client is read-only for settings (process-local settings mode).",
  unavailable: "The memcurio settings namespace is not exposed by this host.",
  loading: "Loading settings\u2026",
  restartTools: "Tool registration changes take effect after a restart.",
  scopeNote: "Scope changes apply to new sessions; existing stores keep their root.",
  rootNote: "The data root stays deployment-level (profile config / MEMCURIO_ROOT) and is read-only here.",
  routeNote: "Provider and model must be set together; leave both empty to follow the session route."
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
  save: "\u4FDD\u5B58",
  saving: "\u4FDD\u5B58\u4E2D\u2026",
  saved: "\u5DF2\u4FDD\u5B58",
  failed: "\u4FDD\u5B58\u88AB\u62D2\u7EDD\uFF1A{error}",
  readOnly: "\u5F53\u524D\u5BA2\u6237\u7AEF\u4E3A\u53EA\u8BFB\u8BBE\u7F6E\u6A21\u5F0F\uFF08\u8FDB\u7A0B\u5185\u8BBE\u7F6E\uFF09\u3002",
  unavailable: "\u8BE5\u5BBF\u4E3B\u672A\u66B4\u9732 memcurio \u8BBE\u7F6E\u547D\u540D\u7A7A\u95F4\u3002",
  loading: "\u6B63\u5728\u52A0\u8F7D\u8BBE\u7F6E\u2026",
  restartTools: "\u8BB0\u5FC6\u5DE5\u5177\u6CE8\u518C\u53D8\u66F4\u5C06\u5728\u91CD\u542F\u540E\u751F\u6548\u3002",
  scopeNote: "\u4F5C\u7528\u57DF\u53D8\u66F4\u5BF9\u65B0\u4F1A\u8BDD\u751F\u6548\uFF1B\u65E2\u6709 store \u4FDD\u6301\u539F\u6570\u636E\u6839\u3002",
  rootNote: "\u6570\u636E\u6839\u5C5E\u90E8\u7F72\u7EA7\uFF08profile \u914D\u7F6E / MEMCURIO_ROOT\uFF09\uFF0C\u6B64\u5904\u53EA\u8BFB\u3002",
  routeNote: "provider \u4E0E model \u5FC5\u987B\u540C\u65F6\u8BBE\u7F6E\uFF1B\u4E24\u8005\u7559\u7A7A\u5219\u8DDF\u968F\u4F1A\u8BDD\u8DEF\u7531\u3002"
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
var inject = ["slots", "locale", "settingsScope", "remote"];
function apply(ctx) {
  ctx.effect(() => mountStyles(), "memcurio: settings styles");
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), "memcurio: settings dictionaries");
  const t = ctx.locale.bind(NS);
  const scope = ctx.settingsScope.bind({
    namespace: NAMESPACE,
    decode: decodeSettings
  });
  const controller = new MemcurioSettingsController(scope);
  ctx.effect(() => {
    const disposers = [];
    const wire = ctx.remote;
    disposers.push(
      wire.$on("settings/document-updated", (ns) => {
        if (ns === NAMESPACE) controller.notice();
      })
    );
    return () => {
      for (const dispose of disposers) dispose();
    };
  }, "memcurio: settings wire");
  ctx.slots.inject(
    "settings.section",
    () => ctx.slots.register(
      {
        name: "settings.section",
        id: "memcurio",
        order: 30,
        label: () => t("nav"),
        locale: NS,
        inject: () => ({
          face: controller.face(),
          subscribe: (listener) => controller.subscribe(listener),
          save: (field, value) => controller.save(field, value),
          reset: (field) => controller.reset(field),
          resetAll: () => controller.resetAll(),
          t: (key, params) => t(key, params)
        })
      },
      MemcurioSettingsSection
    )
  );
}

		return module.exports;
	}
});
