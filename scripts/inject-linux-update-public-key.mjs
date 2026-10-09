import { createPrivateKey, createPublicKey } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
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
  const configPath = join(context.appOutDir, "resources", "app-update.yml");
  const config = await readFile(configPath, "utf8");
  if (/^gitcrestUpdatePublicKey\s*:/m.test(config)) {
    throw new Error("Linux update public key was already injected into app-update.yml.");
  }
  const newline = config.endsWith("\n") ? "" : "\n";
  await writeFile(configPath, `${config}${newline}gitcrestUpdatePublicKey: ${publicKeyBase64}\n`, "utf8");
}
