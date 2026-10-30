import { useEffect, useState } from "react";
import { GitCrestApiError, type GitCrestApiClient, type SigningConfigResponse } from "../../../api/client";
import { useI18n } from "../../../shared/i18n";

type TestState = { kind: "idle" } | { kind: "running" } | { kind: "ok" } | { kind: "failed"; output: string } | { kind: "error"; message: string };

const FORMAT_LABEL = { openpgp: "sg.formatGpg", ssh: "sg.formatSsh", x509: "sg.formatX509" } as const;

/**
 * How commits in the open repository are signed: format, key and whether signing is on by default,
 * with a button that makes a real test signature. The setup itself stays in Git's own configuration.
 */
export function SigningSettings({ api, repoId }: { api: GitCrestApiClient; repoId?: string }) {
  const { t } = useI18n();
  const [config, setConfig] = useState<SigningConfigResponse>();
  const [loadError, setLoadError] = useState("");
  const [test, setTest] = useState<TestState>({ kind: "idle" });

  useEffect(() => {
    setConfig(undefined);
    setLoadError("");
    setTest({ kind: "idle" });
    if (!repoId) return;
    const controller = new AbortController();
    api.withSignal(controller.signal).getRepositorySigning(repoId)
      .then((value) => { if (!controller.signal.aborted) setConfig(value); })
      .catch((reason) => { if (!controller.signal.aborted) setLoadError(reason instanceof GitCrestApiError ? reason.body.error.message : t("sg.loadFailed")); });
    return () => controller.abort();
  }, [api, repoId]);

  if (!repoId) return <p className="cloneHelp">{t("sg.openRepository")}</p>;

  async function runTest() {
    if (!repoId) return;
    setTest({ kind: "running" });
    try {
      const result = await api.testRepositorySigning(repoId);
      setTest(result.signed ? { kind: "ok" } : { kind: "failed", output: result.output });
    } catch (reason) {
      setTest({ kind: "error", message: reason instanceof GitCrestApiError ? reason.body.error.message : t("sg.testFailed") });
    }
  }

  return <div className="identityEditor">
    {loadError && <p className="dialogError" role="alert">{loadError}</p>}
    {config && <dl className="signingFacts">
      <div><dt>{t("sg.format")}</dt><dd>{t(FORMAT_LABEL[config.format])}</dd></div>
      <div><dt>{t("sg.key")}</dt><dd className="monoText" title={config.signingKey ?? undefined}>{config.signingKey ?? t("sg.noKey")}</dd></div>
      <div><dt>{t("sg.byDefault")}</dt><dd>{config.signByDefault ? t("sg.on") : t("sg.off")}</dd></div>
      {config.program && <div><dt>{t("sg.program")}</dt><dd className="monoText">{config.program}</dd></div>}
    </dl>}
    <p className="cloneHelp">{t("sg.help")}</p>
    <div className="identityActions">
      <button className="secondaryButton" type="button" disabled={!config || test.kind === "running"} onClick={() => void runTest()}>{test.kind === "running" ? t("sg.testing") : t("sg.test")}</button>
    </div>
    {test.kind === "ok" && <p className="commitCopyStatus" role="status">{t("sg.testOk")}</p>}
    {test.kind === "failed" && <div className="dialogError" role="alert"><strong>{t("sg.testFailedTitle")}</strong><pre className="signingOutput">{test.output || t("sg.noOutput")}</pre></div>}
    {test.kind === "error" && <p className="dialogError" role="alert">{test.message}</p>}
  </div>;
}
