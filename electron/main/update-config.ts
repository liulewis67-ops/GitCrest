export function hasWindowsUpdatePublisherName(updateConfig: string): boolean {
  const lines = updateConfig.split(/\r?\n/);
  const keyIndex = lines.findIndex((line) => /^publisherName\s*:/.test(line));
  if (keyIndex < 0) return false;

  const inlineValue = lines[keyIndex].slice(lines[keyIndex].indexOf(":") + 1).trim();
  if (inlineValue) return isNonEmptyYamlValue(inlineValue);

  for (const line of lines.slice(keyIndex + 1)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const listItem = line.match(/^\s+-\s*(.*?)\s*(?:#.*)?$/);
    if (!listItem) break;
    if (isNonEmptyYamlValue(listItem[1])) return true;
  }
  return false;
}

export function isUpdateFeedConfigured(isPackaged: boolean, platform: string, updateConfig: string | undefined): boolean {
  return isPackaged && updateConfig !== undefined && (platform !== "win32" || hasWindowsUpdatePublisherName(updateConfig));
}

function isNonEmptyYamlValue(value: string): boolean {
  const trimmed = value.replace(/\s+#.*$/, "").trim();
  if (!trimmed || trimmed.startsWith("#") || /^(?:null|~|true|false|[-+]?\d+(?:\.\d+)?|\[\]|\{\})$/i.test(trimmed)) return false;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return false;
  if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.length > 2;
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").some((item) => isNonEmptyYamlValue(item));
  }
  return true;
}
