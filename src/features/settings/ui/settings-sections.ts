export const SETTINGS_SECTIONS = ["general", "accounts", "appearance", "languages", "shortcuts", "ai", "automations", "updates"] as const;
export type SettingsSectionId = typeof SETTINGS_SECTIONS[number];
