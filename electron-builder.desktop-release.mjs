import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("./package.json", import.meta.url), "utf8"));
const platform = process.env.GITCREST_RELEASE_PLATFORM;
const repository = process.env.GITHUB_REPOSITORY;
if (!repository || !/^[^/]+\/[^/]+$/.test(repository)) {
  throw new Error("GITHUB_REPOSITORY must be set to owner/repository for a release build.");
}
const [owner, repo] = repository.split("/");
const publish = [{ provider: "github", owner, repo }];
let buildConfig;

if (platform === "win32") {
  const publisherName = process.env.WINDOWS_UPDATE_PUBLISHER_NAME?.trim();
  const signed = Boolean(process.env.CSC_LINK && publisherName);
  buildConfig = {
    ...packageJson.build,
    win: {
      ...packageJson.build.win,
      artifactName: "GitCrest-Setup-${version}.${ext}",
      ...(signed ? { forceCodeSigning: true, signtoolOptions: { publisherName } } : { verifyUpdateCodeSignature: false }),
      publish,
    },
  };
} else if (platform === "darwin") {
  const signed = Boolean(process.env.CSC_LINK && process.env.APPLE_ID && process.env.APPLE_APP_SPECIFIC_PASSWORD && process.env.APPLE_TEAM_ID);
  buildConfig = {
    ...packageJson.build,
    forceCodeSigning: signed,
    mac: {
      ...packageJson.build.mac,
      ...(signed ? { notarize: true, publish } : { identity: "-", hardenedRuntime: false, notarize: false, publish: null }),
    },
  };
} else {
  throw new Error("GITCREST_RELEASE_PLATFORM must be win32 or darwin for this configuration.");
}

export default buildConfig;
