import { useEffect, useRef, useState } from "react";
import type { GitCrestApiClient } from "../api/client";
import type { GitCrestEventEnvelope } from "../api/bridge";
import { createEventSequenceTracker } from "../api/events";
import { bootstrapApp } from "./bootstrap";

interface CoreConnectionOptions {
  onConnected: (api: GitCrestApiClient) => Promise<void>;
  onEvent: (api: GitCrestApiClient, event: GitCrestEventEnvelope, sequenceGap: boolean, isActive: () => boolean) => void;
}

export function useCoreConnection({ onConnected, onEvent }: CoreConnectionOptions) {
  const [status, setStatus] = useState("Starting local GitCrest core...");
  const [version, setVersion] = useState("");
  const apiRef = useRef<GitCrestApiClient>();
  const callbacksRef = useRef({ onConnected, onEvent });
  callbacksRef.current = { onConnected, onEvent };

  useEffect(() => {
    let cancelled = false;
    let unsubscribeFromEvents: (() => void) | undefined;
    const isSequenceGap = createEventSequenceTracker();

    async function connect() {
      try {
        const bootstrap = await bootstrapApp();
        if (cancelled) return;
        const api = bootstrap.api;
        apiRef.current = api;
        setVersion(`${bootstrap.version.name} ${bootstrap.version.version} (API v${bootstrap.version.apiVersion})`);
        setStatus("Connected to local Rust core");
        await callbacksRef.current.onConnected(api);
        if (cancelled) return;

        const unsubscribe = await bootstrap.subscribeToEvents((event) => {
          if (cancelled) return;
          callbacksRef.current.onEvent(api, event, isSequenceGap(event), () => !cancelled);
        });
        if (cancelled) unsubscribe();
        else unsubscribeFromEvents = unsubscribe;
      } catch (error) {
        if (!cancelled) setStatus(error instanceof Error ? error.message : "Failed to connect to local Rust core");
      }
    }

    void connect();
    return () => {
      cancelled = true;
      apiRef.current = undefined;
      unsubscribeFromEvents?.();
    };
  }, []);

  return { apiRef, status, version, setStatus };
}
