import { createPublicKey, verify } from "node:crypto";

const SIGNATURE_VERSION = 1;

export interface SignedLinuxUpdateInfo extends Record<string, unknown> {
  gitcrestSignatureVersion: number;
  gitcrestSignature: string;
}

export interface LinuxUpdateTrustPolicy<TUpdateInfo = unknown> {
  isUpdateSupported: (updateInfo: TUpdateInfo) => boolean | Promise<boolean>;
}

export function canonicalizeLinuxUpdateInfo(updateInfo: unknown): string | undefined {
  if (!isPlainRecord(updateInfo) || updateInfo.gitcrestSignatureVersion !== SIGNATURE_VERSION) return undefined;
  const { gitcrestSignature: _signature, ...signedFields } = updateInfo;
  const canonicalPayload = canonicalizeJsonValue(signedFields);
  return canonicalPayload === undefined ? undefined : `gitcrest-linux-update-manifest-v${SIGNATURE_VERSION}\n${canonicalPayload}`;
}

export function verifyLinuxUpdateInfoSignature(updateInfo: unknown, publicKeyBase64: string): boolean {
  if (!isPlainRecord(updateInfo) || typeof updateInfo.gitcrestSignature !== "string") return false;
  const payload = canonicalizeLinuxUpdateInfo(updateInfo);
  if (payload === undefined) return false;
  const signature = decodeCanonicalBase64(updateInfo.gitcrestSignature);
  const publicKeyDer = decodeCanonicalBase64(publicKeyBase64);
  if (!signature || signature.length !== 64 || !publicKeyDer || publicKeyDer.length < 32) return false;
  try {
    const key = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    return verify(null, Buffer.from(payload, "utf8"), key, signature);
  } catch {
    return false;
  }
}

export function requireLinuxUpdateInfoSignature<TUpdateInfo>(updater: LinuxUpdateTrustPolicy<TUpdateInfo>, publicKeyBase64: string): void {
  const defaultSupportCheck = updater.isUpdateSupported.bind(updater);
  updater.isUpdateSupported = async (updateInfo) => {
    if (!verifyLinuxUpdateInfoSignature(updateInfo, publicKeyBase64)) {
      throw new Error("Linux update manifest signature verification failed.");
    }
    return defaultSupportCheck(updateInfo);
  };
}

function canonicalizeJsonValue(value: unknown): string | undefined {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : undefined;
  if (Array.isArray(value)) {
    const items = value.map(canonicalizeJsonValue);
    return items.some((item) => item === undefined) ? undefined : `[${items.join(",")}]`;
  }
  if (!isPlainRecord(value)) return undefined;
  const entries = Object.keys(value).sort().map((key) => {
    const canonicalValue = canonicalizeJsonValue(value[key]);
    return canonicalValue === undefined ? undefined : `${JSON.stringify(key)}:${canonicalValue}`;
  });
  return entries.some((entry) => entry === undefined) ? undefined : `{${entries.join(",")}}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function decodeCanonicalBase64(value: string): Buffer | undefined {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}
