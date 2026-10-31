/**
 * Workspaces block of the memory settings panel.
 *
 * Every switch writes a leaf override immediately; the default row writes the
 * default-for-unlisted field. The model owns pending/undo/error; this component
 * only renders and forwards intent.
 *
 * @module
 */
import { useId } from "react";
import type { ReactElement } from "react";

import type { WorkspaceFace, WorkspacePolicyModel, WorkspaceRow } from "./workspaces.js";
import type { SectionT } from "./ui-types.js";

export interface WorkspaceSectionProps {
  t: SectionT;
  face: WorkspaceFace;
  model: WorkspacePolicyModel;
  writable: boolean;
}

function badge(text: string, tone?: "warning" | "muted"): ReactElement {
  return (
    <span className="memcurio-settings-tag" data-tone={tone}>
      {text}
    </span>
  );
}

function WorkspaceRowView(props: {
  t: SectionT;
  row: WorkspaceRow;
  id: string;
  disabled: boolean;
  pending: boolean;
  onChange: (next: boolean) => void;
}): ReactElement {
  const { t, row, id, disabled, pending, onChange } = props;
  const labelId = `${id}-label`;
  const hintId = `${id}-hint`;
  const switchId = `${id}-switch`;
  const accessibleName = `${row.current ? `${t("workspacesCurrent")} · ` : ""}${row.label}${row.path === undefined ? "" : `: ${row.path}`}`;
  return (
    <li className="memcurio-settings-workspace-row" aria-current={row.current ? "true" : undefined}>
      <div className="memcurio-settings-workspace-text">
        <label className="memcurio-settings-instant-label" id={labelId} htmlFor={switchId}>
          {row.current ? `${t("workspacesCurrent")} · ` : ""}
          {row.label}
        </label>
        {row.path !== undefined ? <span className="memcurio-settings-workspace-path">{row.path}</span> : null}
        <div className="memcurio-settings-badges">
          {row.explicit ? badge(t("workspacesSetHere")) : badge(t("workspacesDefaultTag"), "muted")}
          {row.hasStore ? badge(t("workspacesHasData"), "muted") : badge(t("workspacesNoData"), "muted")}
          {row.missing ? badge(t("workspacesMissing"), "warning") : null}
          {row.key === "no-cwd" ? badge(t("workspacesNoCwd"), "warning") : null}
        </div>
        {!row.effective ? (
          <p id={hintId} className="memcurio-settings-hint">
            {row.fenced
              ? t("workspacesFencedHint")
              : row.explicit
                ? t("workspacesProtected")
                : t("workspacesOffHint")}
          </p>
        ) : null}
      </div>
      <div className="memcurio-settings-instant-control">
        <span className="memcurio-settings-instant-state">
          {pending ? t("statusSaving") : row.effective ? t("stateOn") : t("stateOff")}
        </span>
        <input
          id={switchId}
          type="checkbox"
          className="memcurio-settings-switch"
          role="switch"
          checked={row.effective}
          aria-checked={row.effective}
          aria-label={accessibleName}
          aria-describedby={!row.effective ? hintId : undefined}
          aria-busy={pending}
          disabled={disabled}
          onChange={(event) => onChange(event.target.checked)}
        />
      </div>
    </li>
  );
}

/** The Workspaces block. Rendered only when the settings entry wires a model. */
export function WorkspaceSection(props: WorkspaceSectionProps): ReactElement {
  const { t, face, model, writable } = props;
  const baseId = useId().replace(/:/g, "");
  const hintId = `${baseId}-workspaces-hint`;
  const pending = face.pending !== undefined;
  const disabled = !writable || pending || face.busy;
  const current = face.rows.find((row) => row.current);
  const others = face.rows.filter((row) => !row.current);
  const defaultPending = face.pending?.kind === "default";
  const hasOverrides = face.defaultOverridden || face.rows.some((row) => row.explicit);
  const showGlobal = face.scope === "global";
  const showNoCwd = face.rows.some((row) => row.key === "no-cwd");

  return (
    <div className="memcurio-settings-zone">
      <div className="memcurio-settings-zone-label">
        {t("workspacesSection")}
      </div>
      <div className="memcurio-settings-card">
        <p className="memcurio-settings-hint" id={hintId}>
          {t("workspacesHint")}
        </p>
        {showGlobal ? (
          <p className="memcurio-settings-warn" role="status">
            {t("workspacesSharedWarning")}
          </p>
        ) : null}
        {showNoCwd ? (
          <p className="memcurio-settings-warn" role="status">
            {t("workspacesNoCwdWarning")}
          </p>
        ) : null}

        <div className="memcurio-settings-instant-row">
          <div className="memcurio-settings-instant-text">
            <label className="memcurio-settings-instant-label" htmlFor={`${baseId}-workspace-default`}>
              {t("workspacesDefaultLabel")}
            </label>
            <p className="memcurio-settings-hint">{t("workspacesDefaultHint")}</p>
            {face.defaultOverridden ? (
              <p className="memcurio-settings-meta">
                {t("defaultIs", { value: face.defaultBaseEnabled ? t("stateOn") : t("stateOff") })}
              </p>
            ) : null}
          </div>
          <div className="memcurio-settings-instant-control">
            <span className="memcurio-settings-instant-state">
              {defaultPending ? t("statusSaving") : face.defaultEnabled ? t("stateOn") : t("stateOff")}
            </span>
            <input
              id={`${baseId}-workspace-default`}
              type="checkbox"
              className="memcurio-settings-switch"
              role="switch"
              checked={face.defaultEnabled}
              aria-checked={face.defaultEnabled}
              aria-describedby={hintId}
              aria-busy={defaultPending}
              disabled={disabled}
              onChange={(event) => {
                void model.toggleDefault(event.target.checked);
              }}
            />
          </div>
        </div>

        {current !== undefined ? (
          <ul className="memcurio-settings-workspaces" aria-label={t("workspacesCurrent")}>
            <WorkspaceRowView
              t={t}
              row={current}
              id={`${baseId}-current`}
              disabled={disabled}
              pending={face.pending?.key === current.configKey}
              onChange={(next) => {
                void model.toggle(current, next);
              }}
            />
          </ul>
        ) : null}

        {others.length > 0 ? (
          <ul className="memcurio-settings-workspaces" aria-label={t("workspacesSection")}>
            {others.map((row, index) => (
              <WorkspaceRowView
                key={row.key}
                t={t}
                row={row}
                id={`${baseId}-row-${String(index)}`}
                disabled={disabled}
                pending={face.pending?.key === row.configKey}
                onChange={(next) => {
                  void model.toggle(row, next);
                }}
              />
            ))}
          </ul>
        ) : null}

        {face.status === "loading" ? <p className="memcurio-settings-note">{t("loading")}</p> : null}
        {face.status === "error" ? (
          <p className="memcurio-settings-error" role="alert">
            {t("workspacesLoadError")}{" "}
            <button
              type="button"
              className="memcurio-settings-link"
              disabled={pending || face.busy}
              onClick={() => void model.refresh()}
            >
              {t("workspacesRefresh")}
            </button>
          </p>
        ) : null}
        {face.status === "unavailable" ? <p className="memcurio-settings-note">{t("workspacesUnavailable")}</p> : null}
        {face.status === "ready" && face.rows.length === 0 ? (
          <p className="memcurio-settings-note">{t("workspacesEmpty")}</p>
        ) : null}

        <div className="memcurio-settings-workspace-actions">
          <button
            type="button"
            className="memcurio-settings-link"
            disabled={pending || face.busy || face.status === "loading" || face.status === "unavailable"}
            onClick={() => void model.refresh()}
          >
            {t("workspacesRefresh")}
          </button>
          <button
            type="button"
            className="memcurio-settings-link"
            disabled={disabled || !hasOverrides}
            title={t("workspacesResetHint")}
            onClick={() => void model.resetAll()}
          >
            {t("workspacesResetAll")}
          </button>
        </div>

        {face.error !== undefined ? (
          <p className="memcurio-settings-error" role="alert">
            {t(face.error.code)}
          </p>
        ) : null}
        {face.undo !== undefined ? (
          <p className="memcurio-settings-status-line" role="status">
            <button
              type="button"
              className="memcurio-settings-link"
              disabled={disabled}
              onClick={() => void model.undoLast()}
            >
              {t("workspacesUndo")}
            </button>
          </p>
        ) : face.savedAt !== undefined ? (
          <p className="memcurio-settings-status-line" role="status">
            {t("saved")}
          </p>
        ) : null}
      </div>
    </div>
  );
}
