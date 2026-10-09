export function httpsHostFromRemote(remote: string): string | undefined {
  try {
    const url = new URL(remote);
    return url.protocol === "https:" ? url.host.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}
