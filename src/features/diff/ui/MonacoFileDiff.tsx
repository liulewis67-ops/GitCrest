import { DiffEditor, useMonaco } from "@monaco-editor/react";
import type { editor } from "monaco-editor";
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { codeFontStack, useAppearance } from "../../settings";
import { ensureMonacoTheme, loadMonacoLanguage } from "./monaco-setup";

export interface MonacoFileDiffHandle {
  goToDiff: (direction: "next" | "previous") => void;
}

export interface DiffPosition {
  /** 1-based index of the difference under the cursor, or 0 when the cursor is between differences. */
  current: number;
  total: number;
}

interface MonacoFileDiffProps {
  original: string;
  modified: string;
  language: string;
  label: string;
  sideBySide: boolean;
  ignoreWhitespace: boolean;
  collapseUnchanged: boolean;
  onPositionChange: (position: DiffPosition) => void;
}

function positionFor(changes: editor.ILineChange[], modifiedLine: number): DiffPosition {
  const index = changes.findIndex((change) => {
    const end = Math.max(change.modifiedStartLineNumber, change.modifiedEndLineNumber);
    // Pure deletions have an end line of 0 and sit just after their start line on the modified side.
    return modifiedLine >= change.modifiedStartLineNumber && modifiedLine <= (change.modifiedEndLineNumber === 0 ? end + 1 : end);
  });
  return { current: index + 1, total: changes.length };
}

export const MonacoFileDiff = forwardRef<MonacoFileDiffHandle, MonacoFileDiffProps>(function MonacoFileDiff(
  { original, modified, language, label, sideBySide, ignoreWhitespace, collapseUnchanged, onPositionChange },
  ref,
) {
  const appearance = useAppearance();
  const monaco = useMonaco();
  const [loadedLanguage, setLoadedLanguage] = useState<string | null>(language === "plaintext" ? language : null);
  const diffEditorRef = useRef<editor.IStandaloneDiffEditor | null>(null);
  const revealedFirstDiff = useRef(false);
  const onPositionChangeRef = useRef(onPositionChange);
  onPositionChangeRef.current = onPositionChange;

  useEffect(() => {
    let cancelled = false;
    if (language === "plaintext") {
      setLoadedLanguage(language);
      return;
    }
    setLoadedLanguage(null);
    void loadMonacoLanguage(language)
      .then(() => { if (!cancelled) setLoadedLanguage(language); })
      .catch(() => { if (!cancelled) setLoadedLanguage("plaintext"); });
    return () => { cancelled = true; };
  }, [language]);

  useEffect(() => {
    revealedFirstDiff.current = false;
  }, [original, modified]);

  useImperativeHandle(ref, () => ({
    goToDiff: (direction) => {
      const diffEditor = diffEditorRef.current;
      if (!diffEditor) return;
      diffEditor.goToDiff(direction);
      diffEditor.getModifiedEditor().focus();
    },
  }), []);

  if (loadedLanguage === null) return null;
  const monacoTheme = ensureMonacoTheme(monaco, appearance);
  const codeSize = appearance.typography.codeFontSize;
  return (
    <div className="monacoFileDiff" aria-label={label}>
      <DiffEditor
        height="100%"
        language={loadedLanguage}
        original={original}
        modified={modified}
        theme={monacoTheme}
        beforeMount={(instance) => { ensureMonacoTheme(instance, appearance); }}
        onMount={(diffEditor, instance) => {
          diffEditorRef.current = diffEditor;
          const modifiedEditor = diffEditor.getModifiedEditor();
          const report = () => onPositionChangeRef.current(positionFor(diffEditor.getLineChanges() ?? [], modifiedEditor.getPosition()?.lineNumber ?? 0));
          diffEditor.onDidUpdateDiff(() => {
            const changes = diffEditor.getLineChanges() ?? [];
            const first = changes[0];
            if (!revealedFirstDiff.current && first) {
              // Open on the first difference, the way a file comparison usually starts.
              revealedFirstDiff.current = true;
              const line = Math.max(1, first.modifiedStartLineNumber);
              modifiedEditor.setPosition({ lineNumber: line, column: 1 });
              modifiedEditor.revealLineInCenter(line);
            }
            report();
          });
          modifiedEditor.onDidChangeCursorPosition(report);
          for (const target of [modifiedEditor, diffEditor.getOriginalEditor()]) {
            target.addCommand(instance.KeyCode.F7, () => diffEditor.goToDiff("next"));
            target.addCommand(instance.KeyMod.Shift | instance.KeyCode.F7, () => diffEditor.goToDiff("previous"));
          }
        }}
        options={{
          fontFamily: codeFontStack(appearance.typography),
          fontSize: codeSize,
          lineHeight: Math.round(codeSize * 1.54),
          automaticLayout: true,
          diffAlgorithm: "advanced",
          ignoreTrimWhitespace: ignoreWhitespace,
          hideUnchangedRegions: { enabled: collapseUnchanged, contextLineCount: 3, minimumLineCount: 6, revealLineCount: 20 },
          lineNumbers: "on",
          minimap: { enabled: false },
          originalEditable: false,
          readOnly: true,
          renderMarginRevertIcon: false,
          renderOverviewRuler: true,
          renderSideBySide: sideBySide,
          // The layout follows the viewer choice only, so the side labels above always line up.
          useInlineViewWhenSpaceIsLimited: false,
          scrollBeyondLastLine: false,
          stickyScroll: { enabled: false },
          wordWrap: "off",
        }}
      />
    </div>
  );
});
