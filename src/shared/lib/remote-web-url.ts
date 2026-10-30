/**
 * The web page of a remote repository, derived from its Git URL: `git@host:org/repo.git`,
 * `ssh://git@host/org/repo.git` and `https://host/org/repo.git` all become `https://host/org/repo`.
 * Credentials and the `.git` ending are dropped; anything that is not a hosted repository
 * (a local path, a file URL, an unknown scheme) has no web page.
 */
export function remoteWebUrl(remote: string): string | undefined {
  const text = remote.trim();
  if (!text || text.length > 2048 || /[\s\0]/.test(text)) return undefined;

  let host: string | undefined;
  let path: string | undefined;

  // scp-like: `user@host:org/repo`. Without a user the host must look like a domain, so `javascript:...` is not one.
  const scp = /^(?:([A-Za-z0-9._-]+)@)?([A-Za-z0-9.-]+):(?!\/)([A-Za-z0-9._~/-]+)$/.exec(text);
  if (scp && (scp[1] !== undefined || scp[2].includes(".")) && !text.includes("://")) {
    [, , host, path] = scp;
  } else {
    try {
      const url = new URL(text);
      if (!["https:", "http:", "ssh:", "git:"].includes(url.protocol) || !url.hostname) return undefined;
      host = url.hostname;
      path = url.pathname.replace(/^\/+/, "");
    } catch {
      return undefined;
    }
  }

  const cleaned = (path ?? "").replace(/\/+$/, "").replace(/\.git$/i, "");
  if (!host || !cleaned || cleaned.split("/").some((part) => part === ".." || part === ".")) return undefined;
  return `https://${host}/${cleaned}`;
}
