import { describeApiError, errorText } from "../shared/i18n/api-errors";
import { useEffect, useRef, useState } from "react";
import type { GitCrestApiClient } from "../api/client";
import { getGitCrestBridge, type GitCrestEventEnvelope } from "../api/bridge";
import { createEventSequenceTracker } from "../api/events";
import { bootstrapApp } from "./bootstrap";

export type CoreConnectionState = "connecting" | "connected" | "unresponsive" | "failed";

interface CoreConnectionOptions {
  /** `reconnected` is true when this window was connected before, to a core that has since been restarted. */
  onConnected: (api: GitCrestApiClient, reconnected: boolean) => Promise<void>;
  onEvent: (api: GitCrestApiClient, event: GitCrestEventEnvelope, sequenceGap: boolean, isActive: () => boolean) => void;
}

const CONNECTED_STATUS = "Connected to local Rust core";

export function useCoreConnection({ onConnected, onEvent }: CoreConnectionOptions) {
  const [status, setStatusText] = useState("Starting local GitCrest core...");
  const [connectionState, setConnectionState] = useState<CoreConnectionState>("connecting");
  const [version, setVersion] = useState("");
  const apiRef = useRef<GitCrestApiClient>();
  const reconnectRef = useRef<() => void>();
  const callbacksRef = useRef({ onConnected, onEvent });
  callbacksRef.current = { onConnected, onEvent };

  function showStatus(state: CoreConnectionState, message: string) {
    setConnectionState(state);
    setStatusText(message);
  }

  useEffect(() => {
    let cancelled = false;
    let connectGeneration = 0;
    let unsubscribeFromEvents: (() => void) | undefined;
    let subscribingToEvents = false;
    // The first core can report ready after this window loaded, so only a connection after a successful one is a reconnect.
    let connectedBefore = false;
    const isSequenceGap = createEventSequenceTracker();

    async function connect() {
      const generation = ++connectGeneration;
      const isStale = () => cancelled || generation !== connectGeneration;
      try {
        const bootstrap = await bootstrapApp();
        if (isStale()) return;
        const api = bootstrap.api;
        const reconnected = connectedBefore;
        connectedBefore = true;
        apiRef.current = api;
        setVersion(`${bootstrap.version.name} ${bootstrap.version.version} (API v${bootstrap.version.apiVersion})`);
        showStatus("connected", CONNECTED_STATUS);
        await callbacksRef.current.onConnected(api, reconnected);
        if (isStale() || unsubscribeFromEvents || subscribingToEvents) return;

        // One subscription serves every core: the main process moves the stream to a restarted core.
        subscribingToEvents = true;
        const unsubscribe = await bootstrap.subscribeToEvents((event) => {
          const currentApi = apiRef.current;
          if (cancelled || !currentApi) return;
          callbacksRef.current.onEvent(currentApi, event, isSequenceGap(event), () => !cancelled);
        }).finally(() => {
          subscribingToEvents = false;
        });
        if (cancelled) unsubscribe();
        else unsubscribeFromEvents = unsubscribe;
      } catch (error) {
        if (isStale()) return;
        // A core that is being restarted is not a failure yet; its ready report connects this window.
        const coreStatus = await getGitCrestBridge()?.getCoreStatus?.().catch(() => undefined);
        if (isStale()) return;
        if (coreStatus?.state === "restarting") showStatus("connecting", coreStatus.message);
        else if (coreStatus?.state === "unresponsive") showStatus("unresponsive", coreStatus.message);
        else showStatus("failed", errorText(describeApiError(error)));
      }
    }

    const unsubscribeFromCoreStatus = getGitCrestBridge()?.subscribeToCoreStatus?.((coreStatus) => {
      if (cancelled) return;
      if (coreStatus.state === "ready") {
        void connect();
        return;
      }
      // Requests to a stopped core cannot succeed; hold them until a restarted core is connected.
      connectGeneration += 1;
      apiRef.current = undefined;
      showStatus(coreStatus.state === "restarting" ? "connecting" : coreStatus.state, coreStatus.message);
    });

    reconnectRef.current = () => void connect();
    void connect();
    return () => {
      cancelled = true;
      reconnectRef.current = undefined;
      apiRef.current = undefined;
      unsubscribeFromCoreStatus?.();
      unsubscribeFromEvents?.();
    };
  }, []);

  /** Reports that the connected core could not be read, or clears that report once it can be again. */
  function setConnectionProblem(message: string | undefined) {
    if (!apiRef.current) return;
    if (message) showStatus("failed", message);
    else showStatus("connected", CONNECTED_STATUS);
  }

  async function restartCore() {
    const bridge = getGitCrestBridge();
    if (!bridge?.restartCore) return;
    try {
      const coreStatus = await bridge.restartCore();
      if (coreStatus.state === "failed") showStatus("failed", coreStatus.message);
      // The core was running all along, so only this window lost it: connect to it again.
      else if (coreStatus.state === "ready") reconnectRef.current?.();
    } catch (error) {
      showStatus("failed", errorText(describeApiError(error)));
    }
  }

  return { apiRef, status, connectionState, version, setConnectionProblem, restartCore };
}
