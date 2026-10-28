import type { ReactElement } from "react";

import type { BudgetFace, RouteFace, ScopeFace, ToolsFace } from "./draft.js";
import type { SectionT } from "./ui-types.js";

export function focusByIdSoon(id: string): void {
  setTimeout(() => {
    document.getElementById(id)?.focus();
  }, 0);
}

export function ChangedBadge(props: {
  t: SectionT;
  onReset: () => void;
  resetLabel: string;
  disabled: boolean;
}): ReactElement {
  const { t, onReset, resetLabel, disabled } = props;
  return (
    <span className="memcurio-settings-badges">
      <span className="memcurio-settings-tag">{t("overridden")}</span>
      <button
        type="button"
        className="memcurio-settings-reset"
        aria-label={resetLabel}
        disabled={disabled}
        onClick={onReset}
      >
        {t("reset")}
      </button>
    </span>
  );
}

function RadioOption(props: {
  id: string;
  name: string;
  value: string;
  checked: boolean;
  label: string;
  baseTag?: string;
  disabled: boolean;
  onChange: () => void;
}): ReactElement {
  const { id, name, value, checked, label, baseTag, disabled, onChange } = props;
  return (
    <label
      className="memcurio-settings-choice"
      data-selected={checked ? "true" : undefined}
      data-disabled={disabled ? "true" : undefined}
      htmlFor={id}
    >
      <input
        id={id}
        type="radio"
        name={name}
        value={value}
        checked={checked}
        disabled={disabled}
        onChange={onChange}
      />
      <span className="memcurio-settings-choice-label">{label}</span>
      {baseTag === undefined ? null : <span className="memcurio-settings-tag">{baseTag}</span>}
    </label>
  );
}

export function BudgetField(props: {
  t: SectionT;
  view: BudgetFace;
  idBase: string;
  disabled: boolean;
  onChange: (text: string) => void;
  onReset: () => void;
}): ReactElement {
  const { t, view, idBase, disabled, onChange, onReset } = props;
  const inputId = `${idBase}-budget`;
  const hintId = `${idBase}-budget-hint`;
  const errorId = `${idBase}-budget-error`;
  const unitId = `${idBase}-budget-unit`;
  const handleReset = (): void => {
    onReset();
    focusByIdSoon(inputId);
  };
  const hint = view.base === undefined
    ? t("budgetHint")
    : `${t("budgetBaseHint", { value: view.base })} ${t("budgetMinHint")}`;
  const placeholder = view.base === undefined ? t("budgetPlaceholder") : t("budgetBasePlaceholder");
  const describedBy = view.invalid ? `${hintId} ${errorId} ${unitId}` : `${hintId} ${unitId}`;
  const resetLabel = view.base === undefined
    ? t("budgetResetStore")
    : t("budgetResetTarget", { value: view.base });
  return (
    <div className="memcurio-settings-field">
      <div className="memcurio-settings-field-head">
        <label className="memcurio-settings-field-label" htmlFor={inputId}>
          {t("budgetLabel")}
        </label>
        {view.overridden ? (
          <ChangedBadge t={t} onReset={handleReset} resetLabel={resetLabel} disabled={disabled} />
        ) : null}
      </div>
      <span className="memcurio-settings-input-wrap" data-invalid={view.invalid ? "true" : undefined}>
        <input
          id={inputId}
          className="memcurio-settings-input"
          type="text"
          inputMode="numeric"
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={view.text}
          disabled={disabled}
          aria-invalid={view.invalid ? true : undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
        <span id={unitId} className="memcurio-settings-sr-only">
          {t("budgetUnit")}
        </span>
        <span className="memcurio-settings-input-suffix" aria-hidden="true">
          {t("budgetUnit")}
        </span>
      </span>
      <p id={hintId} className="memcurio-settings-hint">
        {hint}
      </p>
      {view.invalid ? (
        <p id={errorId} className="memcurio-settings-error" role="alert">
          {t(view.errorCode ?? "errBudgetRange")}
        </p>
      ) : null}
    </div>
  );
}

export function ScopeField(props: {
  t: SectionT;
  view: ScopeFace;
  idBase: string;
  disabled: boolean;
  onChange: (value: "workspace" | "global") => void;
  onReset: () => void;
}): ReactElement {
  const { t, view, idBase, disabled, onChange, onReset } = props;
  const labelId = `${idBase}-scope-label`;
  const hintId = `${idBase}-scope-hint`;
  const name = `${idBase}-scope`;
  const handleReset = (): void => {
    onReset();
    focusByIdSoon(`${idBase}-scope-${view.baseValue ?? "workspace"}`);
  };
  const hint = view.value === "global" ? t("scopeGlobalHint") : t("scopeWorkspaceHint");
  const resetLabel = t("resetTarget", {
    value: view.baseValue === "global" ? t("scopeGlobal") : t("scopeWorkspace"),
  });
  return (
    <div className="memcurio-settings-field">
      <div className="memcurio-settings-field-head">
        <span className="memcurio-settings-field-label" id={labelId}>
          {t("scopeLabel")}
        </span>
        {view.overridden ? (
          <ChangedBadge t={t} onReset={handleReset} resetLabel={resetLabel} disabled={disabled} />
        ) : null}
      </div>
      <fieldset className="memcurio-settings-choice-group" aria-labelledby={labelId} aria-describedby={hintId} disabled={disabled}>
        <legend className="memcurio-settings-sr-only">{t("scopeLabel")}</legend>
        <RadioOption
          id={`${idBase}-scope-workspace`}
          name={name}
          value="workspace"
          checked={view.value === "workspace"}
          label={t("scopeWorkspace")}
          baseTag={view.baseValue === "workspace" ? t("scopeBaseTag") : undefined}
          disabled={disabled}
          onChange={() => onChange("workspace")}
        />
        <RadioOption
          id={`${idBase}-scope-global`}
          name={name}
          value="global"
          checked={view.value === "global"}
          label={t("scopeGlobal")}
          baseTag={view.baseValue === "global" ? t("scopeBaseTag") : undefined}
          disabled={disabled}
          onChange={() => onChange("global")}
        />
      </fieldset>
      <p id={hintId} className="memcurio-settings-hint">
        {hint}
      </p>
    </div>
  );
}

export function ToolsField(props: {
  t: SectionT;
  view: ToolsFace;
  idBase: string;
  disabled: boolean;
  onChange: (value: boolean) => void;
  onReset: () => void;
}): ReactElement {
  const { t, view, idBase, disabled, onChange, onReset } = props;
  const inputId = `${idBase}-tools`;
  const labelId = `${idBase}-tools-label`;
  const hintId = `${idBase}-tools-hint`;
  const resetLabel = t("resetTarget", { value: view.baseValue ? t("stateOn") : t("stateOff") });
  const handleReset = (): void => {
    onReset();
    focusByIdSoon(inputId);
  };
  return (
    <div className="memcurio-settings-field">
      <div className="memcurio-settings-field-head">
        <label className="memcurio-settings-field-label" htmlFor={inputId} id={labelId}>
          {t("toolsLabel")}
        </label>
        <span className="memcurio-settings-tag" data-tone="warning">
          {t("toolsRestart")}
        </span>
        {view.overridden ? (
          <ChangedBadge t={t} onReset={handleReset} resetLabel={resetLabel} disabled={disabled} />
        ) : null}
      </div>
      <div className="memcurio-settings-check-row">
        <input
          id={inputId}
          className="memcurio-settings-checkbox"
          type="checkbox"
          checked={view.value}
          disabled={disabled}
          aria-describedby={hintId}
          onChange={(event) => onChange(event.target.checked)}
        />
        <p id={hintId} className="memcurio-settings-hint">
          {t("toolsHint")}
        </p>
      </div>
      {view.overridden ? (
        <p className="memcurio-settings-meta">
          {t("defaultIs", { value: view.baseValue ? t("stateOn") : t("stateOff") })}
        </p>
      ) : null}
    </div>
  );
}

export function RouteField(props: {
  t: SectionT;
  view: RouteFace;
  idBase: string;
  disabled: boolean;
  onModeChange: (mode: "default" | "pin") => void;
  onProviderChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onReset: () => void;
}): ReactElement {
  const { t, view, idBase, disabled, onModeChange, onProviderChange, onModelChange, onReset } = props;
  const labelId = `${idBase}-route-label`;
  const hintId = `${idBase}-route-hint`;
  const errorId = `${idBase}-route-error`;
  const name = `${idBase}-route`;
  const providerId = `${idBase}-provider`;
  const modelId = `${idBase}-model`;
  const defaultLabel = view.basePinned ? t("routeDefault") : t("routeFollow");
  const resetLabel = t("resetTarget", { value: view.basePinned ? t("routeDefault") : t("routeFollow") });
  const handleReset = (): void => {
    onReset();
    focusByIdSoon(`${idBase}-route-default`);
  };
  const describedBy = view.invalid ? `${errorId} ${hintId}` : hintId;
  const fallbackHint = view.basePinned
    ? t("routeHintDefault", { provider: view.baseProvider, model: view.baseModel })
    : view.mode === "pin"
      ? t("routeHintPin")
      : t("routeHintFollow");
  const hint = view.invalid ? t(view.errorCode ?? "errRoutePair") : fallbackHint;
  return (
    <div className="memcurio-settings-field">
      <div className="memcurio-settings-field-head">
        <span className="memcurio-settings-field-label" id={labelId}>
          {t("routeLabel")}
        </span>
        {view.overridden ? (
          <ChangedBadge t={t} onReset={handleReset} resetLabel={resetLabel} disabled={disabled} />
        ) : null}
      </div>
      <fieldset className="memcurio-settings-choice-group" aria-labelledby={labelId} aria-describedby={hintId} disabled={disabled}>
        <legend className="memcurio-settings-sr-only">{t("routeLabel")}</legend>
        <RadioOption
          id={`${idBase}-route-default`}
          name={name}
          value="default"
          checked={view.mode === "default"}
          label={defaultLabel}
          baseTag={undefined}
          disabled={disabled}
          onChange={() => onModeChange("default")}
        />
        <RadioOption
          id={`${idBase}-route-pin`}
          name={name}
          value="pin"
          checked={view.mode === "pin"}
          label={t("routePin")}
          baseTag={undefined}
          disabled={disabled}
          onChange={() => onModeChange("pin")}
        />
      </fieldset>
      {view.mode === "pin" ? (
        <div className="memcurio-settings-pair">
          <div className="memcurio-settings-pair-field">
            <label className="memcurio-settings-field-label" htmlFor={providerId}>
              {t("routeProvider")}
            </label>
            <input
              id={providerId}
              className="memcurio-settings-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={view.provider}
              disabled={disabled}
              aria-invalid={view.invalid ? true : undefined}
              aria-describedby={describedBy}
              onChange={(event) => onProviderChange(event.target.value)}
            />
          </div>
          <div className="memcurio-settings-pair-field">
            <label className="memcurio-settings-field-label" htmlFor={modelId}>
              {t("routeModel")}
            </label>
            <input
              id={modelId}
              className="memcurio-settings-input"
              type="text"
              autoComplete="off"
              spellCheck={false}
              value={view.model}
              disabled={disabled}
              aria-invalid={view.invalid ? true : undefined}
              aria-describedby={describedBy}
              onChange={(event) => onModelChange(event.target.value)}
            />
          </div>
        </div>
      ) : null}
      {view.invalid ? (
        <p id={errorId} className="memcurio-settings-error" role="alert">
          {t(view.errorCode ?? "errRoutePair")}
        </p>
      ) : (
        <p id={hintId} className="memcurio-settings-hint">
          {hint}
        </p>
      )}
      {view.invalid ? (
        <p id={hintId} className="memcurio-settings-hint">
          {fallbackHint}
        </p>
      ) : null}
    </div>
  );
}
