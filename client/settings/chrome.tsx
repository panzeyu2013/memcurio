import type { ReactElement } from "react";

import type { SettingsFace } from "./controller.js";
import type { FormShell } from "./draft.js";
import type { InstantFace } from "./instant.js";
import type { SectionT } from "./ui-types.js";

type Tone = "success" | "neutral" | "error";

interface StatusView {
  tone: Tone;
  label: string;
  title?: string;
}

export function statusOf(face: SettingsFace, instant: InstantFace, shell: FormShell, t: SectionT): StatusView {
  if (face.status === "loading") return { tone: "neutral", label: t("statusLoading") };
  if (face.status === "unavailable") {
    return face.mode === "memory"
      ? { tone: "neutral", label: t("statusReadOnly") }
      : { tone: "neutral", label: t("statusUnavailable") };
  }
  if (!face.writable) return { tone: "neutral", label: t("statusReadOnly") };
  if (instant.errorCode !== undefined) {
    return { tone: "error", label: t("statusError"), title: t(instant.errorCode) };
  }
  if (shell.failed !== undefined) {
    return { tone: "error", label: t("statusError"), title: t(shell.conflict ? "errConflict" : shell.failed) };
  }
  if (instant.pending || shell.saving) return { tone: "neutral", label: t("statusSaving") };
  return instant.value
    ? { tone: "success", label: t("statusReadyOn") }
    : { tone: "neutral", label: t("statusReadyOff") };
}

function StatusChip(props: { status: StatusView }): ReactElement {
  const { status } = props;
  return (
    <span className="memcurio-settings-status" data-tone={status.tone} role="status" title={status.title}>
      <span className="memcurio-settings-status-dot" aria-hidden="true" />
      <span>{status.label}</span>
    </span>
  );
}

export function Header(props: { t: SectionT; titleId: string; status: StatusView }): ReactElement {
  const { t, titleId, status } = props;
  return (
    <header className="memcurio-settings-header">
      <div className="memcurio-settings-header-text">
        <h2 id={titleId}>{t("title")}</h2>
        <p>{t("intro")}</p>
      </div>
      <StatusChip status={status} />
    </header>
  );
}

export function Skeleton(): ReactElement {
  return (
    <div className="memcurio-settings-skeleton" aria-hidden="true">
      <span className="memcurio-settings-skeleton-bar" />
      <span className="memcurio-settings-skeleton-bar" />
      <span className="memcurio-settings-skeleton-bar" />
    </div>
  );
}
