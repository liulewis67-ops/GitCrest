interface GitCrestSidecarConnection {
  baseUrl: string;
  token: string;
}

interface Window {
  gitcrest: {
    getSidecarConnection: () => Promise<GitCrestSidecarConnection>;
  };
}
