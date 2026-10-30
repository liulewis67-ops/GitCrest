// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DiffDocumentResponse } from "../../src/api/client";
import { formatLfsSize, lfsPointerChange, parseLfsPointer } from "../../src/features/diff/model/lfs-pointer";
import { LfsPointerNotice } from "../../src/features/diff/ui/LfsPointerNotice";

afterEach(cleanup);

const OLD = "a".repeat(64);
const NEW = "b".repeat(64);
const pointer = (oid: string, size: number) => `version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize ${size}\n`;

function documentOf(oldText: string | null, newText: string | null): DiffDocumentResponse {
  const oldLines = oldText === null ? [] : oldText.replace(/\n$/, "").split("\n");
  const newLines = newText === null ? [] : newText.replace(/\n$/, "").split("\n");
  const count = Math.max(oldLines.length, newLines.length);
  return {
    repoId: "repo_a", path: "assets/model.bin", revision: "r", originalPath: null, scope: "workingTree", changeKind: "modified", status: "text",
    hunks: [{
      oldStart: 1, oldLines: oldLines.length, newStart: 1, newLines: newLines.length,
      rows: Array.from({ length: count }, (_, index) => ({
        kind: oldLines[index] === newLines[index] ? "context" : "change",
        oldLine: index < oldLines.length ? index + 1 : null, newLine: index < newLines.length ? index + 1 : null,
        oldText: oldLines[index] ?? null, newText: newLines[index] ?? null,
      })),
    }],
  } as unknown as DiffDocumentResponse;
}

describe("parsing a pointer", () => {
  it("reads the object and size of a Git LFS pointer", () => {
    expect(parseLfsPointer(pointer(OLD, 12345))).toEqual({ oid: OLD, size: 12345 });
    expect(parseLfsPointer(pointer(OLD, 12345).replace(/\n/g, "\r\n"))).toEqual({ oid: OLD, size: 12345 });
    expect(parseLfsPointer(`${pointer(OLD, 7)}ext-0-foo sha256:${NEW}\n`)).toEqual({ oid: OLD, size: 7 });
  });

  it("refuses anything that is not exactly a pointer", () => {
    for (const text of ["", "hello\nworld\nagain", pointer(OLD, 1).replace("version", "versio"), pointer("xyz", 1), `version https://git-lfs.github.com/spec/v1\nsize 3\n`, `${pointer(OLD, 1)}some prose that is not a key value pair?!\n\nmore`, "version https://example.com/spec/v1\noid sha256:" + OLD + "\nsize 1\n", `${pointer(OLD, 1)}${"a b\n".repeat(20)}`]) {
      expect(parseLfsPointer(text), text.slice(0, 30)).toBeUndefined();
    }
  });
});

describe("recognising a pointer diff", () => {
  it("reports a changed object with both sides", () => {
    const change = lfsPointerChange(documentOf(pointer(OLD, 1024), pointer(NEW, 2048)));
    expect(change).toEqual({ kind: "changed", before: { oid: OLD, size: 1024 }, after: { oid: NEW, size: 2048 } });
  });

  it("reports an added and a removed pointer", () => {
    expect(lfsPointerChange(documentOf(null, pointer(NEW, 5)))).toMatchObject({ kind: "added", after: { oid: NEW } });
    expect(lfsPointerChange(documentOf(pointer(OLD, 5), null))).toMatchObject({ kind: "removed", before: { oid: OLD } });
  });

  it("leaves ordinary text, mixed content, and non-text diffs alone", () => {
    expect(lfsPointerChange(documentOf("one\ntwo\n", "one\nthree\n"))).toBeUndefined();
    expect(lfsPointerChange(documentOf("plain text\nmore\nlines", pointer(NEW, 5)))).toBeUndefined();
    expect(lfsPointerChange({ ...documentOf(pointer(OLD, 1), pointer(NEW, 2)), status: "binary" })).toBeUndefined();
    expect(lfsPointerChange({ ...documentOf(pointer(OLD, 1), pointer(NEW, 2)), hunks: [] })).toBeUndefined();
  });
});

describe("sizes", () => {
  it("are shown in the unit people read", () => {
    expect(formatLfsSize(12)).toBe("12 B");
    expect(formatLfsSize(2048)).toBe("2.0 KiB");
    expect(formatLfsSize(5 * 1024 * 1024)).toBe("5.0 MiB");
    expect(formatLfsSize(150 * 1024 * 1024 * 1024)).toBe("150 GiB");
  });
});

describe("the notice", () => {
  const change = lfsPointerChange(documentOf(pointer(OLD, 1024), pointer(NEW, 2048)))!;

  it("says which object and size changed instead of the pointer lines", () => {
    render(<LfsPointerNotice change={change} path="assets/model.bin" />);
    expect(screen.getByText(`LFS object changed: ${OLD.slice(0, 12)} · 1.0 KiB → ${NEW.slice(0, 12)} · 2.0 KiB`)).toBeTruthy();
    expect(screen.queryByText(/version https/)).toBeNull();
  });

  it("tells whether Git LFS is installed, asking only once", async () => {
    const load = vi.fn().mockResolvedValue({ installed: true, version: "git-lfs/3.5.1" });
    const { rerender } = render(<LfsPointerNotice change={change} path="a" loadAvailability={load} />);
    expect(await screen.findByText("Git LFS is installed (git-lfs/3.5.1).")).toBeTruthy();
    rerender(<LfsPointerNotice change={change} path="a" loadAvailability={() => load()} />);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("explains how to get Git LFS when it is missing", async () => {
    render(<LfsPointerNotice change={change} path="a" loadAvailability={() => Promise.resolve({ installed: false, version: null })} />);
    expect(await screen.findByText(/Git LFS is not installed on this computer/)).toBeTruthy();
  });
});
