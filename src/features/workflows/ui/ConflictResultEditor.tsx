import { forwardRef, useImperativeHandle, useRef } from "react";
import type { ConflictBlock } from "../model/conflict-blocks";
import { applyPresentedEdit, presentConflicts, presentedOffset } from "../model/conflict-presentation";
import type { Merge3Region } from "../model/merge3";
import { ConflictEditor, type ConflictEditorHandle } from "./ConflictEditor";

/** Projects pending decisions into a clean draft while using the editor's single undo history. */
export const ConflictResultEditor = forwardRef<ConflictEditorHandle, {
  identity: string; path: string; value: string; label: string; busy: boolean; blocks: ConflictBlock[]; selected: number;
  regions: readonly Merge3Region[] | null; ours: string; theirs: string;
  onChange: (value: string) => void; onHistory: (undo: boolean, redo: boolean) => void; onReady: () => void; onPosition: (offset: number) => void;
  onVerticalScroll: (scrollTop: number) => void;
}>(function ConflictResultEditor(props, ref) {
  const inner = useRef<ConflictEditorHandle>(null);
  const latest = useRef(props); latest.current = props;
  const makeView = (raw: string) => presentConflicts(raw, latest.current.regions, latest.current.ours, latest.current.theirs);
  const view = useRef(makeView(props.value));
  const versions = useRef(new Map<number, string>());
  const applying = useRef<string>();
  const rendered = makeView(props.value);
  useImperativeHandle(ref, () => ({
    focus: (offset) => inner.current?.focus(offset === undefined ? undefined : presentedOffset(view.current, offset)),
    reveal: (offset) => inner.current?.reveal(presentedOffset(view.current, offset)),
    setScrollTop: (scrollTop) => inner.current?.setScrollTop(scrollTop),
    value: () => inner.current?.value() === undefined ? undefined : view.current.raw,
    version: () => inner.current?.version(),
    undo: () => inner.current?.undo(), redo: () => inner.current?.redo(),
    replace: (raw) => {
      if (!inner.current) return undefined;
      const before = inner.current.version();
      if (before !== undefined) versions.current.set(before, view.current.raw);
      const next = makeView(raw);
      applying.current = raw;
      inner.current.replace(next.text, raw !== view.current.raw && next.text === view.current.text);
      applying.current = undefined;
      view.current = next;
      const version = inner.current.version();
      if (version !== undefined) versions.current.set(version, raw);
      return raw;
    },
  }), []);
  const blocks = rendered.conflicts.map(({ block, start, end }) => ({ ...block, start, end, line: 1 + (rendered.text.slice(0, start).match(/\n/g)?.length ?? 0) }));
  return <ConflictEditor ref={inner} identity={props.identity} path={props.path} value={rendered.text} label={props.label} busy={props.busy} blocks={blocks} selected={props.selected}
    onHistory={props.onHistory} onVerticalScroll={props.onVerticalScroll} onReady={(version) => {
      if (version !== undefined) versions.current.set(version, view.current.raw);
      props.onReady();
    }} onPosition={(offset) => {
      const item = view.current.conflicts.find((conflict) => offset >= conflict.start && offset <= conflict.end);
      if (item) props.onPosition(item.block.start);
    }} onChange={(text, version, restoring) => {
      const snapshot = restoring && version !== undefined ? versions.current.get(version) : undefined;
      const raw = applying.current ?? snapshot ?? applyPresentedEdit(view.current, text);
      view.current = makeView(raw);
      if (version !== undefined) versions.current.set(version, raw);
      latest.current.onChange(raw);
    }} />;
});
