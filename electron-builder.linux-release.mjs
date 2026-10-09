import { readFile } from "node:fs/promises";
import injectLinuxUpdatePublicKey from "./scripts/inject-linux-update-public-key.mjs";

const packageJson = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
  throw new Error("GITHUB_REPOSITORY must be set to owner/repository for a Linux release build.");
}
const [owner, repo] = repository.split("/");

export default {
  ...packageJson.build,
  linux: {
    ...packageJson.build.linux,
    publish: [{ provider: "github", owner, repo }],
  },
  afterPack: injectLinuxUpdatePublicKey,
};
