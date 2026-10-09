#!/usr/bin/env node
import { randomUUID, createPrivateKey } from "node:crypto";
import { readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { dump, load } from "js-yaml";
import { signLinuxUpdateInfo } from "../electron/main/update-manifest-signature-policy.mjs";

async function main() {
  const [, , manifestPath, privateKeyPath] = process.argv;
  if (!manifestPath || !privateKeyPath || process.argv.length !== 4) {
    throw new Error("Usage: node scripts/sign-linux-update-manifest.mjs <latest-linux.yml> <ed25519-private-key.pem>");
  }

  const [manifestContent, manifestStat] = await Promise.all([readFile(manifestPath, "utf8"), stat(manifestPath)]);
  const metadata = load(manifestContent);
  validateUpdateInfo(metadata);
  const privateKey = createPrivateKey(await readFile(privateKeyPath));
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("The signing key must be an Ed25519 private key.");
  }
  const signedMetadata = signLinuxUpdateInfo(metadata, privateKey);
  const output = dump(signedMetadata, { lineWidth: -1, noRefs: true, sortKeys: false });
  const temporaryPath = join(dirname(manifestPath), `.${basename(manifestPath)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporaryPath, output, { encoding: "utf8", mode: manifestStat.mode, flag: "wx" });
    await rename(temporaryPath, manifestPath);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

function validateUpdateInfo(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    throw new Error("Linux update manifest must contain a YAML mapping.");
  }
  if (typeof metadata.version !== "string" || metadata.version.trim() === "") {
    throw new Error("Linux update manifest must contain a version.");
  }
  if (!Array.isArray(metadata.files) || metadata.files.length === 0) {
    throw new Error("Linux update manifest must contain at least one file.");
  }
  for (const [index, file] of metadata.files.entries()) {
    if (!file || typeof file.url !== "string" || file.url.trim() === "" || typeof file.sha512 !== "string" || file.sha512.trim() === "") {
      throw new Error(`Linux update manifest file ${index} must contain a URL and SHA-512 digest.`);
    }
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Could not sign Linux update manifest."}\n`);
  process.exitCode = 1;
});
