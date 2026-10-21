export const SETTINGS_SECTIONS = ["general", "accounts", "appearance", "shortcuts", "ai", "updates"] as const;
export type SettingsSectionId = typeof SETTINGS_SECTIONS[number];
