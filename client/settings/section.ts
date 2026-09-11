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

import type { SaveOutcome, SettingsFace, SettingsField } from "./controller.js";
import type { SettingsKey } from "./locales.js";

/** Translator seat bound to the `memcurio.settings` namespace. */
export type SectionT = (key: SettingsKey, params?: Record<string, unknown>) => string;

/** Selector-hook shape of one observable store (the renderer hook seat). */
export type FaceHook = <T>(selector: (snapshot: SettingsFace) => T) => T;

export interface MemcurioSectionProps {
  t: SectionT;
  /** Framework-bound observable seat (never a frozen value). */
  useFace: FaceHook;
  save(field: SettingsField, value: unknown): Promise<SaveOutcome>;
  reset(field: SettingsField): Promise<SaveOutcome>;
  resetAll(): Promise<SaveOutcome>;
}

const h = createElement;

function checkboxRow(
  id: string,
  checked: boolean,
  disabled: boolean,
  onToggle: (next: boolean) => void,
): ReactElement {
  return h("input", {
    id,
    type: "checkbox",
    checked,
    disabled,
    onChange: (event: { target: { checked: boolean } }) => onToggle(event.target.checked),
  });
}

/** The panel: status line, the seven configurable fields, notes and resets. */
export function MemcurioSettingsSection(props: MemcurioSectionProps): ReactElement {
  const { t, useFace, save, reset, resetAll } = props;
  const face = useFace((snapshot) => snapshot);
  const [draftBudget, setDraftBudget] = useState<string>(face.value.injectBudgetTokens === undefined ? "" : String(face.value.injectBudgetTokens));
  const [draftProvider, setDraftProvider] = useState<string>(face.value.provider ?? "");
  const [draftModel, setDraftModel] = useState<string>(face.value.model ?? "");
  const [notice, setNotice] = useState<string | null>(null);

  // Drafts resync whenever the authoritative value changes (including after a
  // rejected save, so an unlanded value never sticks in the field).
  useEffect(() => {
    setDraftBudget(face.value.injectBudgetTokens === undefined ? "" : String(face.value.injectBudgetTokens));
    setDraftProvider(face.value.provider ?? "");
    setDraftModel(face.value.model ?? "");
  }, [face.value.injectBudgetTokens, face.value.provider, face.value.model]);

  const busy = face.busy !== undefined;
  const announce = useCallback(
    (outcome: SaveOutcome) => {
      setNotice(outcome.ok ? t("saved") : t(outcome.code as SettingsKey));
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
  // Latest authoritative view for async callbacks (announce runs after await).
  const faceRef = useRef(face);
  useEffect(() => {
    faceRef.current = face;
  }, [face]);

  const commitText = useCallback(
    (field: SettingsField, raw: string) => {
      const trimmed = raw.trim();
      if (trimmed === "") {
        void reset(field).then(announce);
        return;
      }
      void save(field, trimmed).then(announce);
    },
    [announce, reset, save],
  );

  const commitBudget = useCallback(() => {
    if (draftBudget.trim() === "") {
      void reset("injectBudgetTokens").then(announce);
      return;
    }
    void save("injectBudgetTokens", Number(draftBudget)).then(announce);
  }, [announce, draftBudget, reset, save]);

  const status = useMemo(() => {
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
      h("p", { className: "memcurio-note", role: "status" }, status),
    );
  }

  /** One labelled field with its override badge + reset affordance. */
  const field = (key: SettingsField, control: ReactElement): ReactElement =>
    h(
      "div",
      { className: "memcurio-field", key },
      h(
        "div",
        { className: "memcurio-field-head" },
        h("label", { className: "memcurio-label", htmlFor: `memcurio-${key}` }, t(key)),
        face.overridden.includes(key)
          ? h(
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
                    void reset(key).then(announce);
                  },
                },
                t("reset"),
              ),
            )
          : null,
      ),
      control,
    );

  const keySubmit = (commit: () => void) => (event: { key: string; preventDefault: () => void }) => {
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
    h("p", { className: "memcurio-status", role: "status" }, status, notice ? ` · ${notice}` : ""),
    !face.writable ? h("p", { className: "memcurio-warn" }, t("readOnly")) : null,
    face.errorCode ? h("p", { className: "memcurio-warn", role: "alert" }, t(face.errorCode as SettingsKey)) : null,
    field(
      "scope",
      h(
        "select",
        {
          id: "memcurio-scope",
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
    field(
      "injectContext",
      checkboxRow("memcurio-injectContext", face.value.injectContext, busy || !face.writable, (next) => {
        void save("injectContext", next).then(announce);
      }),
    ),
    field(
      "registerTools",
      checkboxRow("memcurio-registerTools", face.value.registerTools, busy || !face.writable, (next) => {
        void save("registerTools", next).then(announce);
      }),
    ),
    field(
      "injectBudgetTokens",
      h("input", {
        id: "memcurio-injectBudgetTokens",
        type: "number",
        min: 128,
        step: 1,
        value: draftBudget,
        disabled: busy || !face.writable,
        onChange: (event: { target: { value: string } }) => setDraftBudget(event.target.value),
        onBlur: commitBudget,
        onKeyDown: keySubmit(commitBudget),
      }),
    ),
    field(
      "hostBridge",
      checkboxRow("memcurio-hostBridge", face.value.hostBridge, busy || !face.writable, (next) => {
        void save("hostBridge", next).then(announce);
      }),
    ),
    field(
      "provider",
      h("input", {
        id: "memcurio-provider",
        type: "text",
        value: draftProvider,
        placeholder: "deepseek",
        disabled: busy || !face.writable,
        onChange: (event: { target: { value: string } }) => setDraftProvider(event.target.value),
        onBlur: () => commitText("provider", draftProvider),
        onKeyDown: keySubmit(() => commitText("provider", draftProvider)),
      }),
    ),
    field(
      "model",
      h("input", {
        id: "memcurio-model",
        type: "text",
        value: draftModel,
        placeholder: "deepseek-v4",
        disabled: busy || !face.writable,
        onChange: (event: { target: { value: string } }) => setDraftModel(event.target.value),
        onBlur: () => commitText("model", draftModel),
        onKeyDown: keySubmit(() => commitText("model", draftModel)),
      }),
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
          },
        },
        t("resetAll"),
      ),
    ),
  );
}
