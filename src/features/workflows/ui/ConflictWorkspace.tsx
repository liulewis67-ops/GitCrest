import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { useI18n } from "../../../shared/i18n";
import { ResizeSeparator } from "../../../shared/ui/ResizeSeparator";
import { Button } from "../../../shared/ui/Button";
import type { ConflictBlock } from "../model/conflict-blocks";
import { ConflictEditor, type ConflictEditorHandle } from "./ConflictEditor";
import { ConflictResultEditor } from "./ConflictResultEditor";
import { merge3 } from "../model/merge3";
import { splitLines } from "../model/line-diff";
import { conflictSourceLocations } from "../model/conflict-presentation";

const PREFERENCE_KEY = "gitcrest-conflict-panes-v1";
function readRatios(): [number, number] {
  try { const value = JSON.parse(localStorage.getItem(PREFERENCE_KEY) || "null"); if (Array.isArray(value) && value.length === 2 && value.every((part) => typeof part === "number" && part >= .15 && part <= .4)) return [value[0], value[1]]; } catch { /* Use readable default pane widths. */ }
  return [.3, .3];
}

export function ConflictWorkspace({ identity, path, ours, theirs, base, draft, dirty, busy, blocks, active, focusRequest, resultRef, onChange, onHistory, onActive, onReady, onAccept }: {
  identity: string; path: string; ours: string; theirs: string; base: string | null; draft: string; dirty: boolean; busy: boolean; blocks: ConflictBlock[]; active: number; focusRequest: number;
  resultRef: RefObject<ConflictEditorHandle>; onChange: (value: string) => void; onHistory: (undo: boolean, redo: boolean) => void; onActive: (index: number) => void;
  onReady: () => void;
  onAccept: (block: ConflictBlock, side: "ours" | "theirs") => void;
}) {
  const { t } = useI18n();
  const container = useRef<HTMLDivElement>(null);
  const oursRef = useRef<ConflictEditorHandle>(null);
  const theirsRef = useRef<ConflictEditorHandle>(null);
  const [width, setWidth] = useState(900);
  const [ratios, setRatios] = useState(readRatios);
  const [source, setSource] = useState("ours");
  const [oursLimited, setOursLimited] = useState(false);
  const [theirsLimited, setTheirsLimited] = useState(false);
  const block = blocks[Math.min(active, blocks.length - 1)];
  const regions = useMemo(() => base === null ? null : merge3(splitLines(base), splitLines(ours), splitLines(theirs)), [base, ours, theirs]);
  const locations = useMemo(() => conflictSourceLocations(blocks, regions, ours, theirs), [blocks, regions, ours, theirs]);
  const actions = (side: "ours" | "theirs") => blocks.flatMap((item, index) => {
    const offset = locations[index]?.[side];
    return offset === undefined ? [] : [{ id: item.id, offset, label: `${t(side === "ours" ? "resolver.useCurrent" : "resolver.useIncoming")} · ${index + 1}`, direction: side === "ours" ? "right" as const : "left" as const, disabled: busy, apply: () => onAccept(item, side) }];
  });
  const sourceBlocks = (side: "ours" | "theirs") => blocks.flatMap((item, index) => {
    const start = locations[index]?.[side];
    const content = side === "ours" ? ours : theirs;
    return start === undefined ? [] : [{ ...item, start, end: start + item[side].length, line: 1 + (content.slice(0, start).match(/\n/g)?.length ?? 0) }];
  });
  const oursOffset = locations[Math.min(active, blocks.length - 1)]?.ours;
  const theirsOffset = locations[Math.min(active, blocks.length - 1)]?.theirs;
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { try { localStorage.setItem(PREFERENCE_KEY, JSON.stringify(ratios)); } catch { /* Layout remains usable without persistence. */ } }, [ratios]);
  useEffect(() => {
    if (oursOffset !== undefined) oursRef.current?.reveal(oursOffset);
    if (theirsOffset !== undefined) theirsRef.current?.reveal(theirsOffset);
  }, [oursOffset, theirsOffset]);
  useEffect(() => {
    if (focusRequest > 0) resultRef.current?.focus(block?.start);
  }, [focusRequest, resultRef]);
  const resize = (side: 0 | 1, value: number) => setRatios((previous) => { const next: [number, number] = [...previous]; next[side] = Math.max(.15, Math.min(.4, value / width)); return next; });
  return <div className={`resolverWorkspace source-${source}`} ref={container} style={{ gridTemplateColumns: `minmax(0, ${ratios[0]}fr) 6px minmax(0, ${1 - ratios[0] - ratios[1]}fr) 6px minmax(0, ${ratios[1]}fr)` }}>
    <div className="resolverSourceSwitch" role="group" aria-label={t("resolver.sourceChoice")}>
      <Button size="compact" aria-pressed={source === "ours"} onClick={() => setSource("ours")}>{t("resolver.current")}</Button>
      <Button size="compact" aria-pressed={source === "theirs"} onClick={() => setSource("theirs")}>{t("resolver.incoming")}</Button>
    </div>
    <section className="resolverPane resolverCurrent" aria-label={t("resolver.current")}>
      <header><strong>{t("resolver.current")}</strong><span title={t(base !== null ? "cb.againstBase" : "cb.baseUnavailable")}>{t("resolver.readOnly")}</span></header>
      <div className="resolverEditor"><ConflictEditor ref={oursRef} identity={`${identity}:ours`} path={path} value={ours} reference={base ?? theirs} label={t("resolver.current")} readOnly blocks={sourceBlocks("ours")} mergeActions={actions("ours")} onHighlightLimit={setOursLimited} /></div>
      {(oursLimited || block && oursOffset === undefined) && <small>{t(oursLimited ? "resolver.highlightLimit" : "resolver.mappingUnavailable")}</small>}
    </section>
    <ResizeSeparator orientation="vertical" edge="left" value={width * ratios[0]} min={width * .15} max={width * .4} label={t("resolver.resizeCurrent")} onResize={(value) => resize(0, value)} />
    <section className="resolverPane resolverResult" aria-label={t("cf.editorAria")}>
      <header><strong>{t("resolver.result")}</strong><span>{t(dirty ? "resolver.unsaved" : "resolver.saved")}</span></header>
      <div className="resolverEditor"><ConflictResultEditor ref={resultRef} identity={`${identity}:result`} path={path} value={draft} label={t("cf.resultTextarea")} busy={busy} blocks={blocks} selected={active} regions={regions} ours={ours} theirs={theirs}
        onChange={onChange} onHistory={onHistory} onReady={() => { onReady(); resultRef.current?.focus(block?.start ?? 0); }} onPosition={(offset) => { const index = blocks.findIndex((item) => offset >= item.start && offset < item.end); if (index >= 0 && index !== active) onActive(index); }} /></div>
    </section>
    <ResizeSeparator orientation="vertical" edge="right" value={width * ratios[1]} min={width * .15} max={width * .4} label={t("resolver.resizeIncoming")} onResize={(value) => resize(1, value)} />
    <section className="resolverPane resolverIncoming" aria-label={t("resolver.incoming")}>
      <header><strong>{t("resolver.incoming")}</strong><span title={t(base !== null ? "cb.againstBase" : "cb.baseUnavailable")}>{t("resolver.readOnly")}</span></header>
      <div className="resolverEditor"><ConflictEditor ref={theirsRef} identity={`${identity}:theirs`} path={path} value={theirs} reference={base ?? ours} label={t("resolver.incoming")} readOnly blocks={sourceBlocks("theirs")} mergeActions={actions("theirs")} onHighlightLimit={setTheirsLimited} /></div>
      {(theirsLimited || block && theirsOffset === undefined) && <small>{t(theirsLimited ? "resolver.highlightLimit" : "resolver.mappingUnavailable")}</small>}
    </section>
  </div>;
}
