import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";

const SIGNATURE_VERSION = 1;

export function canonicalizeLinuxUpdateInfo(updateInfo) {
  if (!isPlainRecord(updateInfo) || updateInfo.gitcrestSignatureVersion !== SIGNATURE_VERSION) return undefined;
  const { gitcrestSignature: _signature, ...signedFields } = updateInfo;
  const canonicalPayload = canonicalizeJsonValue(signedFields);
  return canonicalPayload === undefined ? undefined : `gitcrest-linux-update-manifest-v${SIGNATURE_VERSION}\n${canonicalPayload}`;
}

export function signLinuxUpdateInfo(updateInfo, privateKeyInput) {
  if (!isPlainRecord(updateInfo)) throw new TypeError("Linux update metadata must be a plain object.");
  const privateKey = privateKeyInput?.type === "private" ? privateKeyInput : createPrivateKey(privateKeyInput);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new TypeError("Linux update manifest keys must use Ed25519.");
  const unsigned = { ...updateInfo, gitcrestSignatureVersion: SIGNATURE_VERSION };
  delete unsigned.gitcrestSignature;
  const payload = canonicalizeLinuxUpdateInfo(unsigned);
  if (payload === undefined) throw new TypeError("Linux update metadata cannot be canonicalized.");
  return { ...unsigned, gitcrestSignature: sign(null, Buffer.from(payload, "utf8"), privateKey).toString("base64") };
}

export function verifyLinuxUpdateInfoSignature(updateInfo, publicKeyBase64) {
  if (!isPlainRecord(updateInfo) || typeof updateInfo.gitcrestSignature !== "string") return false;
  const payload = canonicalizeLinuxUpdateInfo(updateInfo);
  if (payload === undefined) return false;
  const signature = decodeCanonicalBase64(updateInfo.gitcrestSignature);
  const publicKeyDer = decodeCanonicalBase64(publicKeyBase64);
  if (!signature || signature.length !== 64 || !publicKeyDer || publicKeyDer.length < 32) return false;
  try {
    const key = createPublicKey({ key: publicKeyDer, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519" && verify(null, Buffer.from(payload, "utf8"), key, signature);
  } catch {
    return false;
  }
}

export function requireLinuxUpdateInfoSignature(updater, publicKeyBase64) {
  const defaultSupportCheck = updater.isUpdateSupported.bind(updater);
  updater.isUpdateSupported = async (updateInfo) => {
    if (!verifyLinuxUpdateInfoSignature(updateInfo, publicKeyBase64)) {
      throw new Error("Linux update manifest signature verification failed.");
    }
    return defaultSupportCheck(updateInfo);
  };
}

function canonicalizeJsonValue(value) {
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

function isPlainRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function decodeCanonicalBase64(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64");
  return decoded.toString("base64") === value ? decoded : undefined;
}
