import { useEffect, useRef, useState } from "react";
import { loadWorkspaceSession, saveWorkspaceSession, type WorkspaceSession } from "./workspace-session";

export function useWorkspaceSessionState() {
  const [session, setSession] = useState<WorkspaceSession>(loadWorkspaceSession);
  const sessionRef = useRef(session);
  sessionRef.current = session;

  useEffect(() => {
    saveWorkspaceSession(session);
  }, [session]);

  return { session, setSession, sessionRef };
}
