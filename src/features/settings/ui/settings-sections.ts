import { AI_FEATURES_ENABLED } from "../../../shared/lib/feature-flags";

export const SETTINGS_SECTIONS = ["general", "accounts", "appearance", "languages", "shortcuts", "ai", "updates"] as const;
export type SettingsSectionId = typeof SETTINGS_SECTIONS[number];

/** The sections Settings shows; the AI section stays out while AI assistance is deferred. */
export const visibleSettingsSections = SETTINGS_SECTIONS.filter((id) => AI_FEATURES_ENABLED || id !== "ai");
