import { useEffect, useState } from "react";
import { GitCrestApiClient } from "./api/client";
import "./App.css";

function App() {
  const [status, setStatus] = useState("Starting local GitCrest core...");
  const [coreUrl, setCoreUrl] = useState("");
  const [version, setVersion] = useState("");

  useEffect(() => {
    let cancelled = false;
    let unsubscribeFromEvents: (() => void) | undefined;

    async function connect() {
      try {
        const connection = await window.gitcrest.getSidecarConnection();
        const api = new GitCrestApiClient(connection.baseUrl, connection.token);
        const body = await api.getVersion();
        if (!cancelled) {
          setCoreUrl(connection.baseUrl);
          setVersion(`${body.name} ${body.version} (API v${body.apiVersion})`);
          setStatus("Connected to local Rust core");
        }

        const unsubscribe = await window.gitcrest.subscribeToEvents((event) => {
          if (event.type === "connection.resyncRequired") {
            void api.listRepositories().catch((syncError: unknown) => {
              if (!cancelled) {
                setStatus(syncError instanceof Error ? syncError.message : "Failed to refresh repository state");
              }
            });
          }
        });
        if (cancelled) {
          unsubscribe();
        } else {
          unsubscribeFromEvents = unsubscribe;
        }
      } catch (error) {
        if (!cancelled) {
          setStatus(error instanceof Error ? error.message : "Failed to connect to local Rust core");
        }
      }
    }

    void connect();

    return () => {
      cancelled = true;
      unsubscribeFromEvents?.();
    };
  }, []);

  return (
    <main className="shell">
      <section className="workspace">
        <div>
          <p className="eyebrow">GitCrest Desktop</p>
          <h1>Electron UI with a Rust Git core</h1>
          <p className="summary">
            The renderer is running in Chromium while GitCrest core runs as a local Rust sidecar on
            loopback with per-session authentication.
          </p>
        </div>

        <dl className="statusGrid">
          <div>
            <dt>Core status</dt>
            <dd>{status}</dd>
          </div>
          <div>
            <dt>Core URL</dt>
            <dd>{coreUrl || "Waiting for sidecar"}</dd>
          </div>
          <div>
            <dt>Core version</dt>
            <dd>{version || "Not available yet"}</dd>
          </div>
        </dl>
      </section>
    </main>
  );
}

export default App;
