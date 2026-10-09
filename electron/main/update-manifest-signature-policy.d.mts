export interface SignedLinuxUpdateInfo extends Record<string, unknown> {
  gitcrestSignatureVersion: number;
  gitcrestSignature: string;
}

export interface LinuxUpdateTrustPolicy<TUpdateInfo = unknown> {
  isUpdateSupported: (updateInfo: TUpdateInfo) => boolean | Promise<boolean>;
}

export function canonicalizeLinuxUpdateInfo(updateInfo: unknown): string | undefined;
export function signLinuxUpdateInfo(updateInfo: Record<string, unknown>, privateKey: string | Buffer | import("node:crypto").KeyObject): SignedLinuxUpdateInfo;
export function verifyLinuxUpdateInfoSignature(updateInfo: unknown, publicKeyBase64: string): boolean;
export function requireLinuxUpdateInfoSignature<TUpdateInfo>(updater: LinuxUpdateTrustPolicy<TUpdateInfo>, publicKeyBase64: string): void;
