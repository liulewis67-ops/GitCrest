import { type DisplayError } from "../../../shared/i18n/api-errors";
import { useEffect, useState } from "react";
import type { DiffDocumentResponse } from "../../../api/client";
import { languageForPath, useLanguageRegistry, type LanguageDefinition } from "../../languages";
import { analyzeCodeReview, type CodeReviewAnalysis } from "./code-review-analysis";
import { fullFileSides } from "./full-file-diff";
import { parseSourceStructure, type SourceStructureResult } from "./tree-sitter";

export type CodeReviewState =
  /** The file has no structure support, so nothing about structure is shown. */
  | { status: "off" }
  | { status: "analyzing" }
  | { status: "ready"; analysis: CodeReviewAnalysis }
  | { status: "unavailable"; reason: "tooLarge" | "parserUnavailable" | "fullFile" }
  /** The full file and the hunks were read from different content; a refresh is needed. */
  | { status: "stale" };

interface Options {
  path: string;
  /** The complete file (`context=full`), read for the same scope as `hunksDocument`. */
  fullDocument?: DiffDocumentResponse;
  fullLoading?: boolean;
  fullError?: DisplayError;
  /** The hunk document whose rows a structure selection stages; omitted for read-only navigation. */
  hunksDocument?: DiffDocumentResponse;
}

const CACHE_LIMIT = 3;
// Declarations of recently read files, so switching views or scopes back does not parse again.
const parseCache = new Map<string, Promise<SourceStructureResult>>();

function parseCached(language: LanguageDefinition, document: DiffDocumentResponse): Promise<SourceStructureResult> {
  const key = `${language.id}\u0000${language.version}\u0000${document.revision}`;
  let entry = parseCache.get(key);
  if (entry) {
    parseCache.delete(key);
  } else {
    const sides = fullFileSides(document);
    entry = parseSourceStructure(language, sides.original, sides.modified);
  }
  parseCache.set(key, entry);
  while (parseCache.size > CACHE_LIMIT) parseCache.delete(parseCache.keys().next().value as string);
  return entry;
}

/** Structure of one file diff, analysed after the text is already on screen. */
export function useCodeReviewAnalysis({ path, fullDocument, fullLoading = false, fullError, hunksDocument }: Options): CodeReviewState {
  // Plugins load after the first render; reading the registry here re-renders once they arrive.
  useLanguageRegistry();
  const language = languageForPath(path);
  const textDiff = (hunksDocument ?? fullDocument)?.status === "text";
  const [state, setState] = useState<{ key: string; value: CodeReviewState }>({ key: "", value: { status: "analyzing" } });
  const key = language && textDiff && fullDocument?.status === "text"
    ? `${language.id}\u0000${language.version}\u0000${fullDocument.revision}\u0000${hunksDocument?.revision ?? ""}`
    : "";

  useEffect(() => {
    if (!language || !key || !fullDocument) return;
    let active = true;
    void parseCached(language, fullDocument).then((parsed) => {
      if (!active) return;
      if (parsed.status === "unsupported") {
        setState({ key, value: parsed.reason === "language" ? { status: "off" } : { status: "unavailable", reason: parsed.reason } });
        return;
      }
      const result = analyzeCodeReview({
        fullDocument,
        hunksDocument,
        oldDeclarations: parsed.original,
        newDeclarations: parsed.modified,
        recovered: parsed.recovered,
        syntax: language.syntax,
      });
      setState({ key, value: result.status === "ready" ? { status: "ready", analysis: result.analysis } : { status: "stale" } });
    });
    return () => { active = false; };
    // The key names the language version and both documents' revisions, so it stands in for them.
  }, [key]);

  if (!language || !textDiff) return { status: "off" };
  if (fullError && !fullLoading) return { status: "unavailable", reason: "fullFile" };
  if (!key || fullLoading || state.key !== key) return { status: "analyzing" };
  return state.value;
}
