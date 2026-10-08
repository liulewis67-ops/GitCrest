export function hasWindowsUpdatePublisherName(updateConfig) {
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

export function isUpdateFeedConfigured(isPackaged, platform, updateConfig) {
  if (!isPackaged || updateConfig === undefined) return false;
  if (platform === "win32") return hasWindowsUpdatePublisherName(updateConfig);
  // electron-updater 6.8.10's AppImage path validates the downloaded SHA-512,
  // but does not authenticate the update metadata with a signed manifest.
  if (platform === "linux") return false;
  return platform === "darwin";
}

function isNonEmptyYamlValue(value) {
  const trimmed = value.replace(/\s+#.*$/, "").trim();
  if (!trimmed || trimmed.startsWith("#") || /^(?:null|~|true|false|[-+]?\d+(?:\.\d+)?|\[\]|\{\})$/i.test(trimmed)) return false;
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) return false;
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.length > 2;
  }
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    return trimmed.slice(1, -1).split(",").some((item) => isNonEmptyYamlValue(item));
  }
  return true;
}
