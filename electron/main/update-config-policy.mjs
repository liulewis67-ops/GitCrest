import { load } from "js-yaml";

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

export function isUpdateFeedConfigured(isPackaged, platform, updateConfig, linuxPublicKey) {
  if (!isPackaged || updateConfig === undefined) return false;
  if (platform === "win32") return hasWindowsUpdatePublisherName(updateConfig) || isOfficialGitHubFeed(updateConfig);
  if (platform === "linux") {
    if (linuxPublicKey !== undefined) return isUpdatePublicKey(linuxPublicKey.trim());
    return getLinuxUpdateManifestPublicKey(updateConfig) !== undefined || isOfficialGitHubFeed(updateConfig);
  }
  return platform === "darwin";
}

function isOfficialGitHubFeed(config) {
  try {
    const feed = load(config);
    return feed?.provider === "github" && feed.owner === "liulewis67-ops" && feed.repo === "GitCrest" &&
      feed.host === undefined && feed.protocol === undefined && feed.private !== true;
  } catch {
    return false;
  }
}

export function getLinuxUpdateManifestPublicKey(updateConfig) {
  if (updateConfig === undefined) return undefined;
  const line = updateConfig.split(/\r?\n/).find((value) => /^gitcrestUpdatePublicKey\s*:/.test(value));
  if (!line) return undefined;
  const value = line.slice(line.indexOf(":") + 1).trim();
  return isUpdatePublicKey(value) ? value : undefined;
}

function isUpdatePublicKey(value) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const decoded = Buffer.from(value, "base64");
  return decoded.length >= 32 && decoded.toString("base64") === value;
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
