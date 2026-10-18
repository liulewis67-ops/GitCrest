import { getLocale } from "../../../shared/i18n";

const formatters = new Map<string, Intl.DateTimeFormat>();

export function formatCommitDate(timestamp: number): string {
  const language = getLocale() === "zh" ? "zh-CN" : undefined;
  const cacheKey = language ?? "default";
  let formatter = formatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" });
    formatters.set(cacheKey, formatter);
  }
  return formatter.format(new Date(timestamp));
}
