/** Metadata only: the editor owns undo; these signatures retain mixed line endings across its versions. */
export function lineEndingSignature(text: string) {
  return (text.match(/\r?\n/g) ?? []).map((ending) => ending.length === 2 ? "r" : "n").join("");
}

export function restoreLineEndings(text: string, signature: string) {
  let index = 0;
  return text.replace(/\r?\n/g, (ending) => signature[index++] === "r" ? "\r\n" : index <= signature.length ? "\n" : ending);
}

export function rawLineStarts(text: string) {
  const starts = [0];
  for (const match of text.matchAll(/\r?\n/g)) starts.push((match.index ?? 0) + match[0].length);
  return starts;
}

export function applyEditorChanges(text: string, changes: readonly { range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number }; text: string }[]) {
  const starts = rawLineStarts(text);
  const edits = changes.map((change) => ({
    start: (starts[change.range.startLineNumber - 1] ?? text.length) + change.range.startColumn - 1,
    end: (starts[change.range.endLineNumber - 1] ?? text.length) + change.range.endColumn - 1,
    text: change.text,
  })).sort((left, right) => right.start - left.start);
  for (const edit of edits) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}
