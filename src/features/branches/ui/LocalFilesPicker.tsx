import { useEffect, useState } from "react";
import type { GitCrestApiClient } from "../../../api/client";

type Listing = { files: Array<{ path: string; sizeBytes: number }>; omittedCount: number };

function formatSize(bytes: number) {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
}

/**
 * Offers the small, Git-ignored files of the repository (typically .env or local settings) for copying into a
 * new worktree. Nothing is selected by default, because these files may hold secrets.
 */
export function LocalFilesPicker({ api, repoId, selected, onChange, disabled }: {
  api: GitCrestApiClient;
  repoId: string;
  selected: string[];
  onChange: (files: string[]) => void;
  disabled?: boolean;
}) {
  const [listing, setListing] = useState<Listing>();

  useEffect(() => {
    const controller = new AbortController();
    let request: Promise<Listing>;
    try {
      request = api.withSignal(controller.signal).listWorktreeLocalFiles(repoId);
    } catch {
      return;
    }
    void request.then((result) => {
      if (!controller.signal.aborted) setListing(result);
    }).catch(() => {
      if (!controller.signal.aborted) setListing(undefined);
    });
    return () => controller.abort();
  }, [api, repoId]);

  if (!listing || listing.files.length === 0) return null;
  const toggle = (path: string, checked: boolean) => onChange(checked ? [...selected, path] : selected.filter((item) => item !== path));
  return <fieldset className="localFilesPicker" disabled={disabled}>
    <legend>Copy local files (ignored by Git)</legend>
    {listing.files.map((file) => <label key={file.path}>
      <input type="checkbox" checked={selected.includes(file.path)} onChange={(event) => toggle(file.path, event.target.checked)} />
      <span className="monoText">{file.path}</span><small>{formatSize(file.sizeBytes)}</small>
    </label>)}
    <p className="cloneHelp">Only the files you tick are copied, and existing files are never overwritten. These files can contain secrets.{listing.omittedCount > 0 ? ` ${listing.omittedCount} larger or folder item(s) are not offered.` : ""}</p>
  </fieldset>;
}
