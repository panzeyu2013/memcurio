import type { SettingsFace } from "./controller.js";
import type { FormShell } from "./draft.js";
import type { InstantFace } from "./instant.js";
import type { SettingsKey } from "./locales.js";

export type SectionT = (key: SettingsKey, params?: Record<string, unknown>) => string;

export interface FaceHook {
  <T>(selector: (snapshot: SettingsFace) => T): T;
  <T>(selector: (snapshot: SettingsFace) => T, equal: (left: T, right: T) => boolean): T;
}

export type FormSeatHook = <T>(selector: (snapshot: FormShell) => T) => T;

export type InstantSeatHook = <T>(selector: (snapshot: InstantFace) => T) => T;
