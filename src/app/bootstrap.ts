import { GitCrestApiClient, type VersionResponse } from "../api/client";
import { requireGitCrestBridge, type GitCrestBridge } from "../api/bridge";

export interface AppBootstrap {
  api: GitCrestApiClient;
  version: VersionResponse;
  subscribeToEvents: GitCrestBridge["subscribeToEvents"];
}

export async function bootstrapApp(bridge: GitCrestBridge = requireGitCrestBridge()): Promise<AppBootstrap> {
  const connection = await bridge.getSidecarConnection();
  const api = new GitCrestApiClient(connection.baseUrl, connection.token);
  const version = await api.getVersion();
  return {
    api,
    version,
    subscribeToEvents: (listener) => bridge.subscribeToEvents(listener),
  };
}
