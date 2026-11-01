import { Editor, useMonaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { ensureMonacoTheme, loadMonacoLanguage, monacoHighlightLanguageForPath, splitInlineDiff } from "../../diff";
import { codeFontStack, useAppearance } from "../../settings";
import type { ConflictBlock } from "../model/conflict-blocks";
import { diffLines, splitLines } from "../model/line-diff";
import { useI18n } from "../../../shared/i18n";
import { applyEditorChanges, lineEndingSignature, rawLineStarts, restoreLineEndings } from "../model/editor-line-endings";
import { Button } from "../../../shared/ui/Button";
import { Icon } from "../../../shared/ui/Icon";

export interface ConflictEditorHandle {
  focus: (offset?: number) => void;
  reveal: (offset: number) => void;
  undo: () => void;
  redo: () => void;
  value: () => string | undefined;
  replace: (content: string, force?: boolean) => string | undefined;
  version: () => number | undefined;
}

interface Props {
  identity: string;
  path: string;
  value: string;
  label: string;
  readOnly?: boolean;
  reference?: string | null;
  busy?: boolean;
  blocks?: ConflictBlock[];
  selected?: number;
  onChange?: (value: string, version?: number, restoring?: boolean) => void;
  mergeActions?: Array<{ id: string; offset: number; label: string; direction: "left" | "right"; disabled: boolean; apply: () => void }>;
  onHistory?: (undo: boolean, redo: boolean) => void;
  onPosition?: (offset: number) => void;
  onReady?: (version?: number) => void;
  onHighlightLimit?: (limited: boolean) => void;
}

/** One model and undo stack per pane lifetime; programmatic changes use the same edit transactions. */
export const ConflictEditor = forwardRef<ConflictEditorHandle, Props>(function ConflictEditor(props, ref) {
  const appearance = useAppearance();
  const { t, locale } = useI18n();
  const monaco = useMonaco();
  const loadedApi = useRef<NonNullable<typeof monaco>>();
  const instance = useRef<editor.IStandaloneCodeEditor>();
  const decorations = useRef<editor.IEditorDecorationsCollection>();
  const sourceDecorations = useRef<editor.IEditorDecorationsCollection>();
  const latest = useRef(props);
  latest.current = props;
  const [ready, setReady] = useState(false);
  const [arrowPositions, setArrowPositions] = useState<number[]>([]);
  const [language, setLanguage] = useState("plaintext");
  const listeners = useRef<Array<{ dispose: () => void }>>([]);
  const [initialText] = useState(() => ({ value: props.value, starts: rawLineStarts(props.value), endings: lineEndingSignature(props.value) }));
  const rawValue = useRef(initialText.value);
  const lineStarts = useRef(initialText.starts);
  const versionEndings = useRef(new Map<number, string>());
  const lastEndings = useRef(initialText.endings);
  const applying = useRef<string>();
  const positionAt = (model: editor.ITextModel, offset: number) => model.getPositionAt(rawValue.current.slice(0, offset).replace(/\r?\n/g, model.getEOL()).length);

  useEffect(() => {
    let current = true;
    const next = monacoHighlightLanguageForPath(props.path);
    void loadMonacoLanguage(next).then(() => { if (current) setLanguage(next); }).catch(() => {});
    return () => { current = false; };
  }, [props.path]);
  useEffect(() => () => { listeners.current.forEach((listener) => listener.dispose()); }, []);

  useImperativeHandle(ref, () => ({
    focus: (offset) => {
      const target = instance.current;
      const model = target?.getModel();
      if (!target || !model) return;
      if (offset !== undefined) { const position = positionAt(model, offset); target.setPosition(position); target.revealPositionInCenter(position); }
      target.focus();
    },
    reveal: (offset) => { const target = instance.current; const model = target?.getModel(); if (target && model) target.revealPositionInCenter(positionAt(model, offset)); },
    undo: () => { instance.current?.trigger("resolver", "undo", null); instance.current?.focus(); },
    redo: () => { instance.current?.trigger("resolver", "redo", null); instance.current?.focus(); },
    value: () => instance.current?.getModel() ? rawValue.current : undefined,
    version: () => instance.current?.getModel()?.getAlternativeVersionId(),
    replace: (content, force = false) => {
      const target = instance.current;
      const model = target?.getModel();
      if (!target || !model) return undefined;
      if (rawValue.current === content && !force) return content;
      target.pushUndoStop();
      applying.current = content;
      const api = loadedApi.current;
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      if (api && model.getEOL() !== eol) model.pushEOL(eol === "\r\n" ? api.editor.EndOfLineSequence.CRLF : api.editor.EndOfLineSequence.LF);
      const previous = model.getValue();
      const normalized = content.replace(/\r?\n/g, model.getEOL());
      // An EOL-only replacement still needs an undoable model version for its raw-ending metadata.
      if (api && previous === normalized && rawValue.current !== content) {
        model.pushEOL(model.getEOL() === "\r\n" ? api.editor.EndOfLineSequence.LF : api.editor.EndOfLineSequence.CRLF);
        model.pushEOL(eol === "\r\n" ? api.editor.EndOfLineSequence.CRLF : api.editor.EndOfLineSequence.LF);
      }
      let start = 0;
      while (start < previous.length && start < normalized.length && previous[start] === normalized[start]) start++;
      let end = previous.length;
      let nextEnd = normalized.length;
      while (end > start && nextEnd > start && previous[end - 1] === normalized[nextEnd - 1]) { end--; nextEnd--; }
      const from = model.getPositionAt(start);
      const to = model.getPositionAt(end);
      if (previous !== normalized || force) target.executeEdits("resolver", [{ range: force && previous === normalized ? model.getFullModelRange() : { startLineNumber: from.lineNumber, startColumn: from.column, endLineNumber: to.lineNumber, endColumn: to.column }, text: force && previous === normalized ? normalized : normalized.slice(start, nextEnd) }]);
      target.pushUndoStop();
      applying.current = undefined;
      return rawValue.current;
    },
  }), []);

  useEffect(() => {
    const target = instance.current;
    const model = target?.getModel();
    if (!target || !model || !ready) return;
    const update = () => setArrowPositions((props.mergeActions ?? []).map((action) => target.getTopForLineNumber(positionAt(model, action.offset).lineNumber) - target.getScrollTop()));
    update();
    const scroll = target.onDidScrollChange(update);
    const layout = target.onDidLayoutChange(update);
    return () => { scroll.dispose(); layout.dispose(); };
  }, [props.mergeActions, ready]);

  useEffect(() => {
    const target = instance.current;
    const model = target?.getModel();
    if (!target || !model || !ready) return;
    const items = (props.blocks ?? []).map((block, index) => {
      const lastLine = block.line + (props.value.slice(block.start, block.end).replace(/\r?\n$/, "").match(/\n/g)?.length ?? 0);
      return { range: { startLineNumber: block.line, startColumn: 1, endLineNumber: lastLine, endColumn: model.getLineMaxColumn(Math.min(lastLine, model.getLineCount())) }, options: { isWholeLine: true, className: index === props.selected ? "resolverSelectedRange" : "resolverUnresolvedRange", linesDecorationsClassName: "resolverConflictGutter" } };
    });
    if (decorations.current) decorations.current.set(items);
    else decorations.current = target.createDecorationsCollection(items);
  }, [props.blocks, props.selected, ready]);

  useEffect(() => {
    const target = instance.current;
    if (!target || !ready || props.reference == null) return;
    const lines = splitLines(props.value);
    const reference = splitLines(props.reference);
    const hunks = lines.length <= 2000 && reference.length <= 2000 ? diffLines(reference, lines) : null;
    latest.current.onHighlightLimit?.(hunks === null);
    const items: editor.IModelDeltaDecoration[] = [];
    for (const hunk of hunks ?? []) {
      for (let index = hunk.bStart; index < hunk.bEnd; index++) {
        const paired = reference[hunk.aStart + index - hunk.bStart];
        const previous = hunk.aStart + index - hunk.bStart < hunk.aEnd ? paired?.replace(/\r?\n$/, "") ?? null : null;
        const text = lines[index].replace(/\r?\n$/, "");
        const range = { startLineNumber: index + 1, endLineNumber: index + 1, startColumn: 1, endColumn: Math.max(1, text.length + 1) };
        items.push({ range, options: { isWholeLine: true, className: "resolverSourceChanged", linesDecorationsClassName: previous === null ? "resolverAddedGutter" : "resolverChangedGutter", hoverMessage: { value: t(previous === null ? "sl.addedLine" : "sl.changedLine") } } });
        let column = 1;
        for (const segment of splitInlineDiff(text, previous)) {
          if (segment.changed) items.push({ range: { ...range, startColumn: column, endColumn: column + segment.text.length }, options: { inlineClassName: "resolverChangedWord" } });
          column += segment.text.length;
        }
      }
      if (hunk.aEnd - hunk.aStart > hunk.bEnd - hunk.bStart) {
        const line = Math.min(lines.length || 1, hunk.bEnd + 1);
        items.push({ range: { startLineNumber: line, endLineNumber: line, startColumn: 1, endColumn: 1 }, options: { linesDecorationsClassName: "resolverRemovedGutter", hoverMessage: { value: t("sl.removedLines") } } });
      }
    }
    if (sourceDecorations.current) sourceDecorations.current.set(items);
    else sourceDecorations.current = target.createDecorationsCollection(items);
  }, [props.value, props.reference, ready, locale]);

  const theme = ensureMonacoTheme(monaco, appearance);
  return <div className="resolverEditorHost"><Editor height="100%" path={`gitcrest-conflict://${encodeURIComponent(props.identity)}/${encodeURIComponent(props.path)}`} defaultValue={props.value} language={language} theme={theme}
    beforeMount={(api) => ensureMonacoTheme(api, appearance)}
    onMount={(target, api) => {
      loadedApi.current = api;
      instance.current = target;
      const model = target.getModel();
      rawValue.current = latest.current.value;
      lineStarts.current = rawLineStarts(rawValue.current);
      lastEndings.current = lineEndingSignature(rawValue.current);
      if (model) model.setEOL(rawValue.current.includes("\r\n") ? api.editor.EndOfLineSequence.CRLF : api.editor.EndOfLineSequence.LF);
      if (model) versionEndings.current.set(model.getAlternativeVersionId(), lastEndings.current);
      const reportHistory = () => { const current = target.getModel(); latest.current.onHistory?.(current?.canUndo() ?? false, current?.canRedo() ?? false); };
      // Atomic multi-character text input must not take Monaco's character-oriented typing path.
      // Paste already has its own fast path; ordinary typing and composition remain native.
      const dom = target.getDomNode();
      const insertBulkText = (event: InputEvent) => {
        if (!event.cancelable || event.isComposing || event.inputType !== "insertText" || !event.data || event.data.length < 2
          || target.getOption(api.editor.EditorOption.readOnly) || target.getSelections()?.length !== 1) return;
        const selection = target.getSelection();
        const current = target.getModel();
        if (!selection || !current) return;
        event.preventDefault(); event.stopImmediatePropagation();
        const start = (lineStarts.current[selection.startLineNumber - 1] ?? 0) + selection.startColumn - 1;
        const end = (lineStarts.current[selection.endLineNumber - 1] ?? rawValue.current.length) + selection.endColumn - 1;
        applying.current = rawValue.current.slice(0, start) + event.data + rawValue.current.slice(end);
        const cursorOffset = current.getOffsetAt(selection.getStartPosition()) + event.data.replace(/\r?\n/g, current.getEOL()).length;
        target.pushUndoStop();
        try { target.executeEdits("resolver-input", [{ range: selection, text: event.data, forceMoveMarkers: true }], () => {
          const position = current.getPositionAt(cursorOffset);
          return [new api.Selection(position.lineNumber, position.column, position.lineNumber, position.column)];
        }); }
        finally { target.pushUndoStop(); applying.current = undefined; }
      };
      dom?.addEventListener("beforeinput", insertBulkText, true);
      listeners.current.push({ dispose: () => dom?.removeEventListener("beforeinput", insertBulkText, true) });
      listeners.current.push(target.onDidChangeModelContent((event) => {
        const reportChange = () => {
          const current = target.getModel();
          if (!current) return;
          const version = event.isUndoing || event.isRedoing ? current.getAlternativeVersionId() : event.versionId;
          const endings = versionEndings.current.get(version);
          const content = applying.current ?? ((event.isUndoing || event.isRedoing) && endings !== undefined
            ? restoreLineEndings(current.getValue(), endings) : applyEditorChanges(rawValue.current, event.changes));
          rawValue.current = content;
          lineStarts.current = rawLineStarts(content);
          const signature = lineEndingSignature(content);
          if (signature !== lastEndings.current) lastEndings.current = signature;
          versionEndings.current.set(version, lastEndings.current);
          latest.current.onChange?.(content, version, event.isUndoing || event.isRedoing); reportHistory();
        };
        // The editor event can precede restoration of the model's alternative version.
        // Read the final undo identity after the transaction has finished.
        if (event.isUndoing || event.isRedoing) queueMicrotask(reportChange); else reportChange();
      }));
      listeners.current.push(target.onDidChangeCursorPosition(() => { const position = target.getPosition(); if (position) latest.current.onPosition?.((lineStarts.current[position.lineNumber - 1] ?? rawValue.current.length) + position.column - 1); }));
      reportHistory();
      setReady(true);
      latest.current.onReady?.(model?.getAlternativeVersionId());
    }}
    options={{ ariaLabel: props.label, readOnly: props.readOnly || props.busy, domReadOnly: props.readOnly || props.busy, fontFamily: codeFontStack(appearance.typography), fontSize: appearance.typography.codeFontSize,
      lineHeight: Math.round(appearance.typography.codeFontSize * 1.54), automaticLayout: true, minimap: { enabled: false }, lineNumbersMinChars: 3, folding: false, glyphMargin: Boolean(props.readOnly), lineDecorationsWidth: 10,
      scrollBeyondLastLine: false, stickyScroll: { enabled: false }, wordWrap: "off", renderLineHighlight: "line", padding: { top: 10, bottom: 10 }, tabIndex: 0,
      quickSuggestions: false, suggestOnTriggerCharacters: false, wordBasedSuggestions: "off", accessibilitySupport: "auto", editContext: false, tabFocusMode: true,
      autoIndent: "none", autoClosingBrackets: "never", autoClosingQuotes: "never", autoSurround: "never", formatOnPaste: false, formatOnType: false }} />
    <div className="resolverArrowRail">{(props.mergeActions ?? []).map((action, index) => <Button key={action.id} size="compact" className={`resolverMergeArrow direction-${action.direction}`} style={{ top: arrowPositions[index] ?? -100 }} aria-label={action.label} title={action.label} disabled={action.disabled} onFocus={() => { const target = instance.current; const model = target?.getModel(); if (target && model) target.revealPositionInCenterIfOutsideViewport(positionAt(model, action.offset)); }} onClick={action.apply}><Icon name="arrowRight" /></Button>)}</div>
  </div>;
});
