/**
 * React section component for the memcurio settings panel.
 *
 * Rendered by the DSH settings slot (`settings.section`); React comes from the
 * frozen platform seed table, so only `react` is external here. Live data
 * arrives through the reserved `hooks` compartment (`useFace`), never through
 * a value snapshot: the renderer memoizes a registration's inject factory
 * once per entry, so a snapshot would freeze at first paint.
 *
 * All copy is localized through the framework's `t` seat; failures carry
 * locale keys from the controller.
 */
import { createElement, useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactElement } from "react";

import { MemorySwitch } from "../ui/switch.js";
import { ERROR_KEYS } from "./controller.js";
import { remarkSettingsNavRow } from "./nav-mark.js";
import type { SaveOutcome, SettingsFace, SettingsField } from "./controller.js";
import type { SettingsKey } from "./locales.js";

/** Translator seat bound to the `memcurio.settings` namespace. */
export type SectionT = (key: SettingsKey, params?: Record<string, unknown>) => string;

/** Selector-hook shape of one observable store (the renderer hook seat);
 *  mirrors the framework binder, including its optional equality override. */
export interface FaceHook {
  <T>(selector: (snapshot: SettingsFace) => T): T;
  <T>(selector: (snapshot: SettingsFace) => T, equal: (left: T, right: T) => boolean): T;
}

export interface MemcurioSectionProps {
  t: SectionT;
  /** Framework-bound observable seat (never a frozen value). */
  useFace: FaceHook;
  save(field: SettingsField, value: unknown): Promise<SaveOutcome>;
  reset(field: SettingsField): Promise<SaveOutcome>;
  resetAll(): Promise<SaveOutcome>;
  /** Atomic pair write for the worker route (both halves or neither). */
  saveRoute(provider: string, model: string): Promise<SaveOutcome>;
  /** Revert both route halves to the composition base in one mutation. */
  resetRoute(): Promise<SaveOutcome>;
}

const h = createElement;

/** The panel: status line, the seven configurable fields, notes and resets. */
export function MemcurioSettingsSection(props: MemcurioSectionProps): ReactElement {
  const { t, useFace, save, reset, resetAll, saveRoute, resetRoute } = props;
  const face = useFace((snapshot) => snapshot);
  const [draftBudget, setDraftBudget] = useState<string>(face.value.injectBudgetTokens === undefined ? "" : String(face.value.injectBudgetTokens));
  const [draftProvider, setDraftProvider] = useState<string>(face.value.provider ?? "");
  const [draftModel, setDraftModel] = useState<string>(face.value.model ?? "");
  const [notice, setNotice] = useState<{ text: string; ok: boolean } | null>(null);

  // Drafts resync whenever the authoritative value changes (including after a
  // rejected save, so an unlanded value never sticks in the field).
  useEffect(() => {
    setDraftBudget(face.value.injectBudgetTokens === undefined ? "" : String(face.value.injectBudgetTokens));
    setDraftProvider(face.value.provider ?? "");
    setDraftModel(face.value.model ?? "");
  }, [face.value.injectBudgetTokens, face.value.provider, face.value.model]);

  // The section renders inside an open settings dialog: a second, guaranteed
  // chance to tag the nav row (the settings.action seat may never mount).
  useEffect(() => {
    remarkSettingsNavRow();
  }, []);

  const busy = face.busy !== undefined;
  // Latest authoritative view for async callbacks (announce runs after await).
  const faceRef = useRef(face);
  useEffect(() => {
    faceRef.current = face;
  }, [face]);

  const announce = useCallback(
    (outcome: SaveOutcome) => {
      setNotice({ text: outcome.ok ? t("saved") : t(outcome.code), ok: outcome.ok });
      if (!outcome.ok) {
        // An unlanded write must not stick in the draft: resync from the
        // authoritative face (the value deps may be unchanged).
        const current = faceRef.current.value;
        setDraftBudget(current.injectBudgetTokens === undefined ? "" : String(current.injectBudgetTokens));
        setDraftProvider(current.provider ?? "");
        setDraftModel(current.model ?? "");
      }
    },
    [t],
  );

  /** Commit the worker route as ONE atomic pair. Single-field writes can never
   *  land (the host validates the resolved section), so both halves travel
   *  together; empty drafts revert the pair to the composition base. */
  const commitRoute = useCallback(() => {
    const provider = draftProvider.trim();
    const model = draftModel.trim();
    const current = faceRef.current.value;
    if (provider === (current.provider ?? "") && model === (current.model ?? "")) return;
    void saveRoute(provider, model).then(announce);
  }, [announce, draftModel, draftProvider, saveRoute]);

  const commitBudget = useCallback(() => {
    const current = faceRef.current.value;
    const draft = draftBudget.trim();
    if (draft === (current.injectBudgetTokens === undefined ? "" : String(current.injectBudgetTokens))) return;
    if (draft === "") {
      void reset("injectBudgetTokens").then(announce);
      return;
    }
    void save("injectBudgetTokens", Number(draft)).then(announce);
  }, [announce, draftBudget, reset, save]);

  const status = useMemo(() => {
    if (face.status === "loading") return t("loading");
    if (face.status === "unavailable") return face.mode === "memory" ? t("readOnly") : t("unavailable");
    if (!face.writable) return t("readOnly");
    if (busy) return t("saving");
    return t("ready");
  }, [busy, face.mode, face.status, face.writable, t]);

  /** Icon-only status (the chamber / dsh-chamber-mcp convention: green ready,
   *  grey idle/read-only, red error, pulsing while a write is in flight); the
   *  phase text lives in the tooltip and the accessible name, so the panel
   *  spends no vertical space on a status line. */
  const stateKey: SettingsKey =
    face.status === "loading" ? "loading" : !face.writable ? "readOnly" : busy ? "saving" : "ready";
  const stateName =
    face.errorCode !== undefined || (notice !== null && !notice.ok) ? "error" : face.status === "loading" ? "loading" : !face.writable ? "readonly" : busy ? "saving" : "ready";
  const stateIcon = (name: string, label: string): ReactElement =>
    h(
      "span",
      { className: "memcurio-state", "data-state": name, role: "status", title: label, "aria-label": label },
      h("span", { className: "memcurio-state-dot", "aria-hidden": "true" }),
    );

  if (face.status === "loading" || face.status === "unavailable") {
    return h(
      "section",
      { className: "memcurio-panel" },
      h("div", { className: "memcurio-head" }, h("h2", null, t("title")), stateIcon(stateName, status)),
      h("p", { className: "memcurio-warn" }, status),
    );
  }

  /** The override badge with its reset action, rendered in the row's control
   *  group so a compact row keeps the affordance beside its control. */
  const resetBadge = (action: () => Promise<SaveOutcome>): ReactElement =>
    h(
      "span",
      { className: "memcurio-badge" },
      h("span", { className: "memcurio-badge-text" }, t("overridden")),
      h(
        "button",
        {
          type: "button",
          className: "memcurio-reset",
          disabled: busy || !face.writable,
          onClick: () => {
            void action().then(announce);
          },
        },
        t("reset"),
      ),
    );

  /** One compact settings row in the shipped General preference-row shape
   *  (text column left, controls right): one line per setting instead of a
   *  label line plus a control line, which halves the panel's height.
   *  `stack` gives the control group its own full-width line — the worker
   *  route (two inputs + Save + badge) is too wide to share a row without
   *  squeezing the note into a narrow column. */
  const row = (
    key: string,
    label: ReactElement,
    control: ReactElement,
    options?: { description?: string; badge?: ReactElement | null; stack?: boolean },
  ): ReactElement =>
    h(
      "div",
      { className: options?.stack === true ? "memcurio-field memcurio-field-stack" : "memcurio-field", key },
      h(
        "div",
        { className: "memcurio-field-text" },
        label,
        options?.description === undefined ? null : h("span", { className: "memcurio-desc" }, options.description),
      ),
      h("div", { className: "memcurio-control" }, options?.badge ?? null, control),
    );

  /** The platform switch bound to one boolean field (the caller passes the
   *  localized name, so a field without a panel row cannot break the label). */
  const switchControl = (
    field: string,
    label: string,
    checked: boolean,
    onChange: (next: boolean) => void,
  ): ReactElement =>
    h(MemorySwitch, {
      id: `memcurio-${field}`,
      checked,
      label,
      disabled: busy || !face.writable,
      onChange,
    });

  /** The worker route commits only through its Save button (Enter is the
   *  keyboard shortcut): no implicit blur commit, so the row never claims a
   *  write the user did not ask for. */
  const routeDirty =
    draftProvider.trim() !== (face.value.provider ?? "") || draftModel.trim() !== (face.value.model ?? "");

  const keySubmit = (commit: () => void) => (event: { key: string; preventDefault: () => void }) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit();
    }
  };

  return h(
    "section",
    { className: "memcurio-panel" },
    h("div", { className: "memcurio-head" }, h("h2", null, t("title")), stateIcon(stateName, t(stateKey))),
    h("p", { className: "memcurio-intro" }, t("intro")),
    // Success is the icon turning green; only failures spend a text line.
    notice !== null && !notice.ok
      ? h("p", { className: "memcurio-status memcurio-status-error" }, notice.text)
      : null,
    !face.writable ? h("p", { className: "memcurio-warn" }, t("readOnly")) : null,
    face.errorCode ? h("p", { className: "memcurio-alert", role: "alert" }, t(face.errorCode)) : null,
    // The memory ON/OFF control: the same injectContext field the pre-step
    // hook reads, and the only place it is switched.
    row(
      "injectContext",
      h("span", { className: "memcurio-label" }, t("injectContext")),
      switchControl("injectContext", t("injectContext"), face.value.injectContext, (next) => {
        void save("injectContext", next).then(announce);
      }),
      {
        // No description line (product instruction, 2026-09-16): the switch
        // needs no explainer, and the row keeps the panel compact.
        badge: face.overridden.includes("injectContext") ? resetBadge(() => reset("injectContext")) : null,
      },
    ),
    row(
      "injectBudgetTokens",
      h("label", { className: "memcurio-label", htmlFor: "memcurio-injectBudgetTokens" }, t("injectBudgetTokens")),
      h("input", {
        id: "memcurio-injectBudgetTokens",
        className: "memcurio-input memcurio-input-num",
        type: "text",
        inputMode: "numeric",
        autoComplete: "off",
        spellCheck: false,
        placeholder: "2500",
        value: draftBudget,
        readOnly: busy,
        disabled: !face.writable,
        "aria-invalid": face.errorCode === ERROR_KEYS.budgetRange ? "true" : undefined,
        onChange: (event: { target: { value: string } }) => setDraftBudget(event.target.value),
        onBlur: commitBudget,
        onKeyDown: keySubmit(commitBudget),
      }),
      { badge: face.overridden.includes("injectBudgetTokens") ? resetBadge(() => reset("injectBudgetTokens")) : null },
    ),
    row(
      "scope",
      h("label", { className: "memcurio-label", htmlFor: "memcurio-scope" }, t("scope")),
      h(
        "span",
        { className: "memcurio-select-wrap" },
        h(
          "select",
          {
            id: "memcurio-scope",
            className: "memcurio-select",
            value: face.value.scope,
            disabled: busy || !face.writable,
            onChange: (event: { target: { value: string } }) => {
              void save("scope", event.target.value).then(announce);
            },
          },
          h("option", { value: "workspace" }, t("scopeWorkspace")),
          h("option", { value: "global" }, t("scopeGlobal")),
        ),
      ),
      { description: t("scopeNote"), badge: face.overridden.includes("scope") ? resetBadge(() => reset("scope")) : null },
    ),
    row(
      "registerTools",
      h("span", { className: "memcurio-label" }, t("registerTools")),
      switchControl("registerTools", t("registerTools"), face.value.registerTools, (next) => {
        void save("registerTools", next).then(announce);
      }),
      {
        description: t("registerToolsNote"),
        badge: face.overridden.includes("registerTools") ? resetBadge(() => reset("registerTools")) : null,
      },
    ),
    // The memory UI data plane (the host bridge) is not a setting at all
    // (product decision 2026-09-16: always on, no user case needs it off), so
    // neither the panel nor the config surface carries a row for it.
    row(
      "provider",
      h("span", { className: "memcurio-label" }, t("routeLabel")),
      h(
        "span",
        { className: "memcurio-route" },
        h("input", {
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
          "aria-invalid": face.errorCode === ERROR_KEYS.routePair ? "true" : undefined,
          onChange: (event: { target: { value: string } }) => setDraftProvider(event.target.value),
          onKeyDown: keySubmit(commitRoute),
        }),
        h("input", {
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
          "aria-invalid": face.errorCode === ERROR_KEYS.routePair ? "true" : undefined,
          onChange: (event: { target: { value: string } }) => setDraftModel(event.target.value),
          onKeyDown: keySubmit(commitRoute),
        }),
        h(
          "button",
          {
            type: "button",
            className: "memcurio-button memcurio-button-primary",
            disabled: busy || !face.writable || !routeDirty,
            onClick: () => {
              commitRoute();
            },
          },
          t("save"),
        ),
      ),
      {
        description: t("routeNote"),
        stack: true,
        badge:
          face.overridden.includes("provider") || face.overridden.includes("model")
            ? resetBadge(() => resetRoute())
            : null,
      },
    ),
    h(
      "div",
      { className: "memcurio-actions" },
      h(
        "button",
        {
          type: "button",
          className: "memcurio-button",
          disabled: busy || !face.writable || face.overridden.length === 0,
          onClick: () => {
            void resetAll().then(announce);
          },
        },
        t("resetAll"),
      ),
    ),
  );
}
