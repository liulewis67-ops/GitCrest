// @vitest-environment node
import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dump, load } from "js-yaml";
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

it("signs Linux release YAML with the same policy used by the runtime verifier", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const directory = await mkdtemp(join(tmpdir(), "gitcrest signed update "));
  const manifestPath = join(directory, "latest-linux.yml");
  const privateKeyPath = join(directory, "release key.pem");
  const scriptPath = join(process.cwd(), "scripts/sign-linux-update-manifest.mjs");
  try {
    const metadata = {
      version: "0.2.0",
      files: [{ url: "GitCrest-0.2.0.AppImage", sha512: "a".repeat(128), size: 1234 }],
      releaseDate: "2026-10-09T00:00:00.000Z",
    };
    await writeFile(manifestPath, dump(metadata), "utf8");
    await writeFile(privateKeyPath, privateKey.export({ type: "pkcs8", format: "pem" }));

    execFileSync(process.execPath, [scriptPath, manifestPath, privateKeyPath]);

    const signed = load(await readFile(manifestPath, "utf8")) as {
      version: string;
      files: Array<{ url: string; sha512: string; size: number }>;
      releaseDate: string;
      gitcrestSignatureVersion: number;
      gitcrestSignature: string;
    };
    const publicKeyBase64 = publicKey.export({ type: "spki", format: "der" }).toString("base64");
    expect(verifyLinuxUpdateInfoSignature(signed, publicKeyBase64)).toBe(true);
    expect(verifyLinuxUpdateInfoSignature({ ...signed, files: [{ ...signed.files[0], sha512: "b".repeat(128) }] }, publicKeyBase64)).toBe(false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
