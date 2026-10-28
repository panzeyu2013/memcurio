/**
 * React section component for the memcurio settings panel.
 *
 * Rendered by the DSH settings slot (settings.section). Live data arrives
 * through the renderer's observable-hook seats, never through a value snapshot:
 * the renderer memoizes a registration's inject factory once per entry.
 *
 * The page has two deliberate submission zones:
 * - the injection switch applies immediately (optimistic, per-field pending,
 *   undo on success, rollback on failure);
 * - the configuration form stages everything and writes one atomic plan with
 *   a revision fence, so provider/model can never land as a lone half and a
 *   refusal keeps every draft.
 */
import { useEffect, useId, useRef, useState } from "react";
import type { ReactElement } from "react";

import type { SettingsFormModel } from "./draft.js";
import type { InjectionSwitchModel } from "./instant.js";
import { Header, Skeleton, statusOf } from "./chrome.js";
import { BudgetField, ChangedBadge, RouteField, ScopeField, ToolsField, focusByIdSoon } from "./fields.js";
import type { FaceHook, FormSeatHook, InstantSeatHook, SectionT } from "./ui-types.js";
import { remarkSettingsNavRow } from "./nav-mark.js";

export interface MemcurioSectionProps {
  t: SectionT;
  useFace: FaceHook;
  useForm: FormSeatHook;
  useInstant: InstantSeatHook;
  formModel: SettingsFormModel;
  switchModel: InjectionSwitchModel;
}

/** The panel: instant injection switch + staged configuration form. */
export function MemcurioSettingsSection(props: MemcurioSectionProps): ReactElement {
  const { t, useFace, useForm, useInstant, formModel, switchModel } = props;
  const face = useFace((snapshot) => snapshot);
  const shell = useForm((snapshot) => snapshot);
  const instant = useInstant((snapshot) => snapshot);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const baseId = useId().replace(/:/g, "");
  const titleId = `${baseId}-title`;
  const configSectionId = `${baseId}-config-label`;
  const injectionLabelId = `${baseId}-injection-label`;
  const injectionSwitchId = `${baseId}-injection-switch`;
  const injectionHintId = `${baseId}-injection-hint`;
  const injectionErrorId = `${baseId}-injection-error`;
  const budgetId = `${baseId}-budget`;
  const providerId = `${baseId}-provider`;
  const advancedPanelId = `${baseId}-advanced-panel`;
  const [focusKey, setFocusKey] = useState<string | undefined>(undefined);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const switchRef = useRef<HTMLInputElement | null>(null);

  // The section only renders inside an open settings dialog: a guaranteed
  // chance to tag the nav row even if the settings.action seat never mounts.
  useEffect(() => {
    remarkSettingsNavRow();
  }, []);

  // Leaving the configuration page (switching sections or closing Settings)
  // drops staged edits, matching the copy under the zone label and the
  // official SettingsForm's unmount contract. A save already in flight is
  // allowed to settle: success clears the draft, failure keeps it and the
  // error visible for the next open. The instant switch is outside this
  // contract: it has already been written.
  useEffect(() => {
    return () => {
      // A submitted save is allowed to settle: discarding it on unmount would
      // hide a refusal and lose the draft the user thought was saved.
      if (!formModel.shell().saving) formModel.discard();
    };
  }, [formModel]);

  const status = statusOf(face, instant, shell, t);

  useEffect(() => {
    if (focusKey === undefined) return;
    if (focusKey === "route" && !advancedOpen) return;
    const id = focusKey === "route" ? providerId : focusKey === "injectBudgetTokens" ? budgetId : undefined;
    if (id === undefined) {
      setFocusKey(undefined);
      return;
    }
    const timer = setTimeout(() => {
      const element = document.getElementById(id);
      element?.focus();
      if (element !== null && typeof element.scrollIntoView === "function") {
        element.scrollIntoView({ block: "nearest" });
      }
      setFocusKey(undefined);
    }, 0);
    return () => clearTimeout(timer);
  }, [advancedOpen, budgetId, focusKey, providerId]);

  if (face.status === "loading") {
    return (
      <section className="memcurio-settings" aria-labelledby={titleId} aria-busy="true">
        <Header t={t} titleId={titleId} status={status} />
        <Skeleton />
        <p className="memcurio-settings-note">{t("loading")}</p>
      </section>
    );
  }

  if (face.status === "unavailable") {
    const legacyReadOnly = face.mode === "memory";
    return (
      <section className="memcurio-settings" aria-labelledby={titleId}>
        <Header t={t} titleId={titleId} status={status} />
        <p className="memcurio-settings-empty">{legacyReadOnly ? t("readOnly") : t("unavailable")}</p>
      </section>
    );
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

  const focusFirstInvalid = (key: string | undefined): void => {
    if (key === undefined) return;
    if (key === "route" && !advancedOpen) setAdvancedOpen(true);
    setFocusKey(key);
  };

  const focusStatusSoon = (): void => {
    const focus = (): void => {
      statusRef.current?.focus();
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(focus);
    else setTimeout(focus, 0);
  };

  const handleSubmit = (event: { preventDefault: () => void }): void => {
    event.preventDefault();
    if (shell.invalid) {
      focusFirstInvalid(invalidKeys[0]);
      return;
    }
    if (!shell.dirty || shell.saving || instant.pending || !face.writable) return;
    void (async () => {
      const outcome = await formModel.save();
      // The two zones keep independent error slots, but a save that settled
      // ("Saved") must not leave the switch's failure copy ("Save failed") on
      // screen at the same time.
      if (outcome.ok) switchModel.clearError();
      focusStatusSoon();
    })();
  };

  let footerStatus: ReactElement | null = null;
  if (shell.failed !== undefined) {
    const conflict = shell.conflict;
    footerStatus = (
      <p className="memcurio-settings-footer-status memcurio-settings-error" role="alert">
        {t(conflict ? "errConflict" : shell.failed)}
        {conflict ? (
          <button
            type="button"
            className="memcurio-settings-link"
            onClick={() => {
              formModel.discard();
              focusByIdSoon(budgetId);
            }}
          >
            {t("reload")}
          </button>
        ) : null}
      </p>
    );
  } else if (shell.savedAt !== undefined) {
    footerStatus = (
      <p className="memcurio-settings-footer-status" role="status">
        {t("saved")}
      </p>
    );
  } else if (shell.invalid) {
    footerStatus = (
      <p className="memcurio-settings-footer-status memcurio-settings-warn" role="status">
        {t("invalidSummary", { count: shell.invalidCount })}
      </p>
    );
  } else if (shell.dirty) {
    footerStatus = (
      <p className="memcurio-settings-footer-status" role="status">
        {t("unsavedCount", { count: shell.dirtyCount })}
      </p>
    );
  }

  return (
    <section className="memcurio-settings" aria-labelledby={titleId}>
      <Header t={t} titleId={titleId} status={status} />

      {!face.writable ? <p className="memcurio-settings-warn" role="status">{t("readOnly")}</p> : null}

      <div className="memcurio-settings-zone">
        <div className="memcurio-settings-zone-label">{t("injectionSection")}</div>
        <div className="memcurio-settings-card">
          <div className="memcurio-settings-instant-row">
            <div className="memcurio-settings-instant-text">
              <label className="memcurio-settings-instant-label" id={injectionLabelId} htmlFor={injectionSwitchId}>
                {t("injectionLabel")}
              </label>
              <p id={injectionHintId} className="memcurio-settings-hint">
                {t("injectionHint")}
              </p>
              {face.overridden.includes("injectContext") ? (
                <p className="memcurio-settings-meta">
                  {t("defaultIs", { value: injectionBaseLabel })}
                </p>
              ) : null}
            </div>
            <div className="memcurio-settings-instant-control">
              <span className="memcurio-settings-instant-state">
                {instant.pending ? t("statusSaving") : instant.value ? t("injectionOn") : t("injectionOff")}
              </span>
              <input
                id={injectionSwitchId}
                ref={switchRef}
                type="checkbox"
                className="memcurio-settings-switch"
                role="switch"
                checked={instant.value}
                aria-checked={instant.value}
                aria-labelledby={injectionLabelId}
                aria-describedby={instant.errorCode === undefined ? injectionHintId : `${injectionHintId} ${injectionErrorId}`}
                aria-busy={instant.pending}
                disabled={switchDisabled}
                onChange={(event) => {
                  void switchModel.toggle(event.target.checked).then(() => {
                    if (typeof requestAnimationFrame === "function") {
                      requestAnimationFrame(() => switchRef.current?.focus());
                    }
                  });
                }}
              />
            </div>
          </div>
          {face.overridden.includes("injectContext") ? (
            <div className="memcurio-settings-instant-actions">
              <ChangedBadge
                t={t}
                disabled={switchDisabled}
                resetLabel={t("resetTarget", { value: injectionBaseLabel })}
                onReset={() => {
                  void switchModel.reset().then(() => {
                    if (typeof requestAnimationFrame === "function") {
                      requestAnimationFrame(() => switchRef.current?.focus());
                    } else {
                      setTimeout(() => switchRef.current?.focus(), 0);
                    }
                  });
                }}
              />
            </div>
          ) : null}
          {instant.errorCode !== undefined ? (
            <p id={injectionErrorId} className="memcurio-settings-error" role="alert">
              {t(instant.errorCode)}
            </p>
          ) : null}
          {instant.undo !== undefined ? (
            <p className="memcurio-settings-status-line" role="status">
              {instant.value ? t("injectionOn") : t("injectionOff")}
              <span aria-hidden="true"> · </span>
              <button
                type="button"
                className="memcurio-settings-link"
                disabled={switchDisabled}
                onClick={() => {
                  void switchModel.undoLast().then(() => {
                    switchRef.current?.focus();
                  });
                }}
              >
                {t("injectionUndo")}
              </button>
            </p>
          ) : instant.savedAt !== undefined ? (
            <p className="memcurio-settings-status-line" role="status">
              {t("saved")}
            </p>
          ) : null}
        </div>
      </div>

      <form
        className="memcurio-settings-form"
        noValidate
        aria-busy={shell.saving}
        aria-labelledby={configSectionId}
        onSubmit={handleSubmit}
      >
        <div className="memcurio-settings-zone-label" id={configSectionId}>
          {t("configSection")}
        </div>
        <p className="memcurio-settings-hint">{t("configHint")}</p>
        <div className="memcurio-settings-form-body">
          <BudgetField
            t={t}
            view={budget}
            idBase={baseId}
            disabled={disabled}
            onChange={(text) => formModel.editBudget(text)}
            onReset={() => formModel.resetField("injectBudgetTokens")}
          />
          <ScopeField
            t={t}
            view={scope}
            idBase={baseId}
            disabled={disabled}
            onChange={(value) => formModel.editScope(value)}
            onReset={() => formModel.resetField("scope")}
          />

          <div className="memcurio-settings-advanced">
            <button
              type="button"
              className="memcurio-settings-advanced-toggle"
              aria-expanded={advancedOpen}
              aria-controls={advancedPanelId}
              onClick={() => setAdvancedOpen((open) => !open)}
            >
              <span className="memcurio-settings-advanced-title">{t("advanced")}</span>
              {advancedInvalid > 0 ? (
                <span className="memcurio-settings-tag" data-tone="error">
                  {t("advancedInvalid", { count: advancedInvalid })}
                </span>
              ) : advancedDirty > 0 ? (
                <span className="memcurio-settings-tag">{t("advancedUnsaved", { count: advancedDirty })}</span>
              ) : advancedChanged > 0 ? (
                <span className="memcurio-settings-tag">{t("advancedChanged", { count: advancedChanged })}</span>
              ) : null}
              <span className="memcurio-settings-chevron" aria-hidden="true" />
            </button>
            <div id={advancedPanelId} className="memcurio-settings-advanced-panel" hidden={!advancedOpen}>
              <RouteField
                t={t}
                view={route}
                idBase={baseId}
                disabled={disabled}
                onModeChange={(mode) => formModel.editRouteMode(mode)}
                onProviderChange={(value) => formModel.editProvider(value)}
                onModelChange={(value) => formModel.editModel(value)}
                onReset={() => formModel.resetField("route")}
              />
              <ToolsField
                t={t}
                view={tools}
                idBase={baseId}
                disabled={disabled}
                onChange={(value) => formModel.editTools(value)}
                onReset={() => formModel.resetField("registerTools")}
              />
            </div>
          </div>
        </div>

        <div className="memcurio-settings-footer-status-wrap" ref={statusRef} tabIndex={-1}>
          {footerStatus}
        </div>
        {face.hiddenOverridden.length > 0 ? (
          <p className="memcurio-settings-note">
            {t("hiddenOverrides", { count: face.hiddenOverridden.length })}
          </p>
        ) : null}
        <p className="memcurio-settings-note">{t("deploymentNote")}</p>

        <div className="memcurio-settings-footer">
          <div className="memcurio-settings-footer-left">
            <button
              type="button"
              className="memcurio-settings-button"
              disabled={!face.writable || shell.saving || (shell.overriddenCount === 0 && !shell.dirty)}
              title={t("resetAllHint")}
              onClick={() => {
                formModel.resetVisible();
                focusByIdSoon(budgetId);
              }}
            >
              {t("resetAll")}
            </button>
          </div>
          <div className="memcurio-settings-footer-right">
            {shell.dirty ? (
              <button
                type="button"
                className="memcurio-settings-button"
                disabled={shell.saving}
                onClick={() => {
                  formModel.discard();
                  focusByIdSoon(budgetId);
                }}
              >
                {t("discard")}
              </button>
            ) : null}
            <button
              type="submit"
              className="memcurio-settings-button memcurio-settings-button-primary"
              disabled={!face.writable || shell.saving || instant.pending || !shell.dirty}
            >
              {shell.saving ? t("saving") : t("save")}
            </button>
          </div>
        </div>
      </form>
    </section>
  );
}
