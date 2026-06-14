import { useEffect, useState } from "react";
import "./App.css";

function App() {
  const [status, setStatus] = useState("Starting local GitCrest core...");
  const [coreUrl, setCoreUrl] = useState("");
  const [version, setVersion] = useState("");

  useEffect(() => {
    let cancelled = false;

    async function connect() {
      try {
        const connection = await window.gitcrest.getSidecarConnection();
        const response = await fetch(`${connection.baseUrl}/api/version`, {
          headers: {
            Authorization: `Bearer ${connection.token}`,
          },
        });

        if (!response.ok) {
          throw new Error(`Core responded with ${response.status}`);
        }

        const body = (await response.json()) as { name: string; version: string };
        if (!cancelled) {
          setCoreUrl(connection.baseUrl);
          setVersion(`${body.name} ${body.version}`);
          setStatus("Connected to local Rust core");
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
