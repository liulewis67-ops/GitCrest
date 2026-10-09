import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const platform = process.env.GITCREST_RELEASE_PLATFORM;
const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
  throw new Error("GITHUB_REPOSITORY must be set to owner/repository for a signed release build.");
}
const [owner, repo] = repository.split("/");
const publish = [{ provider: "github", owner, repo }];
let buildConfig;

if (platform === "win32") {
  const publisherName = process.env.WINDOWS_UPDATE_PUBLISHER_NAME?.trim();
  if (!publisherName) throw new Error("WINDOWS_UPDATE_PUBLISHER_NAME must match the Authenticode certificate subject.");
  buildConfig = {
    ...packageJson.build,
    forceCodeSigning: true,
    win: {
      ...packageJson.build.win,
      forceCodeSigning: true,
      signtoolOptions: { ...packageJson.build.win.signtoolOptions, publisherName },
      publish,
    },
  };
} else if (platform === "darwin") {
  buildConfig = {
    ...packageJson.build,
    forceCodeSigning: true,
    mac: {
      ...packageJson.build.mac,
      notarize: true,
      publish,
    },
  };
} else {
  throw new Error("GITCREST_RELEASE_PLATFORM must be win32 or darwin for this configuration.");
}

export default buildConfig;
