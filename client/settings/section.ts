/**
 * React section component for the memcurio settings panel.
 *
 * Rendered by the DSH settings slot (`settings.section`); React comes from the
 * frozen platform seed table, so only `react` is external here. All data flows
 * through the injected face/save/reset functions — the component holds no
 * domain state beyond the transient draft of text fields.
 */
import { createElement, useCallback, useEffect, useMemo, useState } from "react";
import type { ReactElement } from "react";

import type { SaveOutcome, SettingsFace, SettingsField } from "./controller.js";

/** Translator bound to the `memcurio.settings` locale namespace. */
export type SectionT = (key: string, params?: Record<string, unknown>) => string;

export interface MemcurioSectionProps {
  face: SettingsFace;
  subscribe(listener: () => void): () => void;
  save(field: SettingsField, value: unknown): Promise<SaveOutcome>;
  reset(field: SettingsField): Promise<SaveOutcome>;
  resetAll(): Promise<SaveOutcome>;
  t: SectionT;
}

const h = createElement;

function fieldRow(
  t: SectionT,
  key: SettingsField,
  label: string,
  control: ReactElement,
  overridden: boolean,
  onReset: () => void,
  busy: boolean,
): ReactElement {
  return h(
    "div",
    { className: "memcurio-field", key },
    h(
      "div",
      { className: "memcurio-field-head" },
      h("label", { className: "memcurio-label", htmlFor: `memcurio-${key}` }, label),
      overridden
        ? h(
            "span",
            { className: "memcurio-badge" },
            t("overridden"),
            h(
              "button",
              { type: "button", className: "memcurio-reset", onClick: onReset, disabled: busy },
              t("reset"),
            ),
          )
        : null,
    ),
    control,
  );
}

/** The panel: status line, the seven configurable fields, notes and resets. */
export function MemcurioSettingsSection(props: MemcurioSectionProps): ReactElement {
  const { face, subscribe, save, reset, resetAll, t } = props;
  const [, setTick] = useState(0);
  const [draftBudget, setDraftBudget] = useState<string>(String(face.value.injectBudgetTokens ?? ""));
  const [draftProvider, setDraftProvider] = useState<string>(face.value.provider ?? "");
  const [draftModel, setDraftModel] = useState<string>(face.value.model ?? "");
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => subscribe(() => setTick((tick) => tick + 1)), [subscribe]);
  useEffect(() => {
    setDraftBudget(face.value.injectBudgetTokens === undefined ? "" : String(face.value.injectBudgetTokens));
    setDraftProvider(face.value.provider ?? "");
    setDraftModel(face.value.model ?? "");
  }, [face.value.injectBudgetTokens, face.value.provider, face.value.model]);

  const busy = face.busy !== undefined;
  const announce = useCallback((outcome: SaveOutcome) => {
    setNotice(outcome.ok ? t("saved") : t("failed", { error: outcome.error }));
  }, [t]);

  const textSave = useCallback(
    (field: SettingsField, raw: string, clearWhenEmpty: boolean) => {
      const trimmed = raw.trim();
      if (clearWhenEmpty && trimmed === "") {
        void reset(field).then(announce);
        return;
      }
      void save(field, trimmed).then(announce);
    },
    [announce, reset, save],
  );

  const status = useMemo(() => {
    if (face.status === "loading") return t("loading");
    if (face.status === "unavailable") return t("unavailable");
    return face.mode === "host" ? t("saved") : t("readOnly");
  }, [face.mode, face.status, t]);

  if (face.status === "loading" || face.status === "unavailable") {
    return h("section", { className: "memcurio-panel" }, h("h2", null, t("title")), h("p", { className: "memcurio-note" }, status));
  }

  const control = (key: SettingsField, node: ReactElement): ReactElement =>
    fieldRow(
      t,
      key,
      t(key),
      node,
      face.overridden.includes(key),
      () => {
        void reset(key).then(announce);
      },
      busy,
    );

  return h(
    "section",
    { className: "memcurio-panel" },
    h("h2", null, t("title")),
    h("p", { className: "memcurio-note" }, t("intro")),
    h("p", { className: "memcurio-status" }, status, notice ? ` · ${notice}` : ""),
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
          onChange: (event: { target: { value: string } }) => {
            void save("scope", event.target.value).then(announce);
          },
        },
        h("option", { value: "workspace" }, t("scopeWorkspace")),
        h("option", { value: "global" }, t("scopeGlobal")),
      ),
    ),
    control(
      "injectContext",
      h("input", {
        id: "memcurio-injectContext",
        type: "checkbox",
        checked: face.value.injectContext,
        disabled: busy || !face.writable,
        onChange: (event: { target: { checked: boolean } }) => {
          void save("injectContext", event.target.checked).then(announce);
        },
      }),
    ),
    control(
      "registerTools",
      h("input", {
        id: "memcurio-registerTools",
        type: "checkbox",
        checked: face.value.registerTools,
        disabled: busy || !face.writable,
        onChange: (event: { target: { checked: boolean } }) => {
          void save("registerTools", event.target.checked).then(announce);
        },
      }),
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
        onChange: (event: { target: { value: string } }) => setDraftBudget(event.target.value),
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
        },
      }),
    ),
    control(
      "hostBridge",
      h("input", {
        id: "memcurio-hostBridge",
        type: "checkbox",
        checked: face.value.hostBridge,
        disabled: busy || !face.writable,
        onChange: (event: { target: { checked: boolean } }) => {
          void save("hostBridge", event.target.checked).then(announce);
        },
      }),
    ),
    control(
      "provider",
      h("input", {
        id: "memcurio-provider",
        type: "text",
        value: draftProvider,
        placeholder: "deepseek",
        disabled: busy || !face.writable,
        onChange: (event: { target: { value: string } }) => setDraftProvider(event.target.value),
        onBlur: () => textSave("provider", draftProvider, true),
      }),
    ),
    control(
      "model",
      h("input", {
        id: "memcurio-model",
        type: "text",
        value: draftModel,
        placeholder: "deepseek-v4",
        disabled: busy || !face.writable,
        onChange: (event: { target: { value: string } }) => setDraftModel(event.target.value),
        onBlur: () => textSave("model", draftModel, true),
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
