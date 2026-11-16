import { createPrivateKey, createPublicKey } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

export default async function injectLinuxUpdatePublicKey(context) {
  if (context.electronPlatformName !== "linux") return;

  const privateKeyValue = process.env.LINUX_UPDATE_SIGNING_KEY;
  if (!privateKeyValue) throw new Error("LINUX_UPDATE_SIGNING_KEY is required to package a Linux release.");

  const privateKey = createPrivateKey(privateKeyValue);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("LINUX_UPDATE_SIGNING_KEY must contain an Ed25519 private key.");
  }
  const publicKeyBase64 = createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .toString("base64");
  // The AppImage target rewrites app-update.yml after this hook runs.
  await writeFile(join(context.appOutDir, "resources", "gitcrest-update-public-key"), `${publicKeyBase64}\n`, { flag: "wx" });
}
