// @vitest-environment node
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { expect, it } from "vitest";
import {
  canonicalizeLinuxUpdateInfo,
  requireLinuxUpdateInfoSignature,
  verifyLinuxUpdateInfoSignature,
} from "../../electron/main/update-manifest-signature";

function createSignedUpdateInfo(privateKey: KeyObject) {
  const unsigned = {
    version: "0.2.0",
    files: [{ url: "GitCrest-0.2.0.AppImage", sha512: "a".repeat(128), size: 1234 }],
    releaseDate: "2026-10-09T00:00:00.000Z",
    gitcrestSignatureVersion: 1,
  };
  const payload = canonicalizeLinuxUpdateInfo(unsigned);
  if (!payload) throw new Error("Could not canonicalize update metadata.");
  return { ...unsigned, gitcrestSignature: sign(null, Buffer.from(payload), privateKey).toString("base64") };
}

it("verifies an Ed25519 signature over canonical update metadata", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = createSignedUpdateInfo(privateKey);
  const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  expect(verifyLinuxUpdateInfoSignature(signed, publicKeyBase64)).toBe(true);
  expect(verifyLinuxUpdateInfoSignature({
    gitcrestSignature: signed.gitcrestSignature,
    gitcrestSignatureVersion: signed.gitcrestSignatureVersion,
    releaseDate: signed.releaseDate,
    files: signed.files,
    version: signed.version,
  }, publicKeyBase64)).toBe(true);
});

it("rejects missing, malformed, or modified update signatures", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = createSignedUpdateInfo(privateKey);
  const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  expect(verifyLinuxUpdateInfoSignature({ version: "0.2.0" }, publicKeyBase64)).toBe(false);
  expect(verifyLinuxUpdateInfoSignature({ ...signed, gitcrestSignature: "bad" }, publicKeyBase64)).toBe(false);
  expect(verifyLinuxUpdateInfoSignature({ ...signed, files: [{ ...signed.files[0], sha512: "b".repeat(128) }] }, publicKeyBase64)).toBe(false);
  expect(verifyLinuxUpdateInfoSignature(signed, "bad-key")).toBe(false);
});

it("rejects an unsigned manifest before the updater's default support check", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signed = createSignedUpdateInfo(privateKey);
  const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
  let defaultChecks = 0;
  const updater = { isUpdateSupported: (_updateInfo: unknown) => { defaultChecks += 1; return true; } };
  requireLinuxUpdateInfoSignature(updater, publicKeyBase64);

  await expect(updater.isUpdateSupported(signed)).resolves.toBe(true);
  await expect(updater.isUpdateSupported({ version: "0.3.0" })).rejects.toThrow("signature verification failed");
  expect(defaultChecks).toBe(1);
});
