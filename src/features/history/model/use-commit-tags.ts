import { useEffect, useRef, useState } from "react";
import type { GitCrestApiClient, TagEntryResponse } from "../../../api/client";

export type CommitTagLabel = Pick<TagEntryResponse, "name" | "annotated">;

const TARGETS_PER_REQUEST = 100;

/**
 * Tag labels for the commits the graph has loaded. Tags stay out of the first ref snapshot, so each
 * newly loaded page of commits asks for just its own tags; a failed lookup only leaves labels off.
 */
export function useCommitTags(api: GitCrestApiClient | undefined, repoId: string, oids: readonly string[], refreshKey: number) {
  const [tagsByOid, setTagsByOid] = useState<ReadonlyMap<string, CommitTagLabel[]>>(new Map());
  const askedRef = useRef(new Set<string>());
  const controllerRef = useRef<AbortController>();

  // A new repository or a refreshed history starts over; nothing from before is shown or awaited.
  useEffect(() => {
    askedRef.current = new Set();
    setTagsByOid(new Map());
    const controller = new AbortController();
    controllerRef.current = controller;
    return () => controller.abort();
  }, [api, repoId, refreshKey]);

  useEffect(() => {
    const controller = controllerRef.current;
    if (!api || !controller || controller.signal.aborted) return;
    const fresh = oids.filter((oid) => !askedRef.current.has(oid));
    if (fresh.length === 0) return;
    for (const oid of fresh) askedRef.current.add(oid);
    void (async () => {
      for (let start = 0; start < fresh.length; start += TARGETS_PER_REQUEST) {
        const targets = fresh.slice(start, start + TARGETS_PER_REQUEST);
        try {
          const found = new Map<string, CommitTagLabel[]>();
          for (let offset: number | null = 0; offset !== null;) {
            const page = await api.withSignal(controller.signal).getRepositoryTags(repoId, { targets, offset, limit: 500 });
            for (const tag of page.tags) {
              const labels = found.get(tag.targetOid) ?? [];
              labels.push({ name: tag.name, annotated: tag.annotated });
              found.set(tag.targetOid, labels);
            }
            offset = page.nextOffset;
          }
          if (controller.signal.aborted) return;
          if (found.size > 0) setTagsByOid((current) => new Map([...current, ...found]));
        } catch {
          if (controller.signal.aborted) return;
          // A later render asks again for the commits this request could not label.
          for (const oid of targets) askedRef.current.delete(oid);
        }
      }
    })();
  }, [api, repoId, oids]);

  return tagsByOid;
}
