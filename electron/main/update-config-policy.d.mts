export function getLinuxUpdateManifestPublicKey(updateConfig: string | undefined): string | undefined;
export function hasWindowsUpdatePublisherName(updateConfig: string): boolean;
export function isUpdateFeedConfigured(isPackaged: boolean, platform: string, updateConfig: string | undefined, linuxPublicKey?: string): boolean;
