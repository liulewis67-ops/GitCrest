import { useEffect, useRef, useState } from "react";
import { getGitCrestBridge } from "../../../api/bridge";
import { t } from "../../../shared/i18n";

interface FolderDropOptions {
  /** One folder was dropped; open it through the usual flow, which reports its own errors. */
  onFolder: (path: string) => void;
  /** The drop was not a single folder, so nothing was opened. */
  onProblem: (message: string) => void;
}

/** Drags that carry files, not text selections or links inside the page. */
function carriesFiles(event: DragEvent): boolean {
  return Array.from(event.dataTransfer?.types ?? []).includes("Files");
}

/**
 * Lets a folder dragged from the file manager open as a repository. Several items and plain files
 * are refused with a message. Returns whether a file drag is over the window, for a drop hint.
 */
export function useFolderDrop(options: FolderDropOptions): boolean {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    // Enter and leave also fire for every child element, so count them instead of trusting one event.
    let depth = 0;
    const end = () => {
      depth = 0;
      setDragging(false);
    };
    const onDragEnter = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth += 1;
      setDragging(true);
    };
    const onDragOver = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      // Without this the browser would navigate to the dropped item.
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) setDragging(false);
    };
    const onDrop = (event: DragEvent) => {
      if (!carriesFiles(event)) return;
      event.preventDefault();
      end();
      const items = Array.from(event.dataTransfer?.items ?? []).filter((item) => item.kind === "file");
      if (items.length !== 1) {
        latest.current.onProblem(t("drop.oneFolder"));
        return;
      }
      const entry = items[0].webkitGetAsEntry?.();
      const file = items[0].getAsFile();
      if (!entry?.isDirectory || !file) {
        latest.current.onProblem(t("drop.notFolder"));
        return;
      }
      const path = getGitCrestBridge()?.getPathForFile?.(file);
      if (!path) {
        latest.current.onProblem(t("drop.desktopOnly"));
        return;
      }
      latest.current.onFolder(path);
    };
    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    window.addEventListener("dragend", end);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
      window.removeEventListener("dragend", end);
    };
  }, []);

  return dragging;
}
