// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useFolderDrop } from "../../src/features/repositories";

const onFolder = vi.fn();
const onProblem = vi.fn();
let dragging = false;

function Probe() {
  dragging = useFolderDrop({ onFolder, onProblem });
  return null;
}

type FakeItem = { kind: "file"; webkitGetAsEntry: () => { isDirectory: boolean } | null; getAsFile: () => File | null };

function dragEvent(type: string, items: FakeItem[] | null, types: string[] = ["Files"]) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: unknown };
  event.dataTransfer = { types, items: items ?? [], dropEffect: "none" };
  return event;
}

function folderItem(): FakeItem {
  return { kind: "file", webkitGetAsEntry: () => ({ isDirectory: true }), getAsFile: () => new File([], "project") };
}
function fileItem(): FakeItem {
  return { kind: "file", webkitGetAsEntry: () => ({ isDirectory: false }), getAsFile: () => new File(["x"], "a.txt") };
}

beforeEach(() => {
  onFolder.mockClear();
  onProblem.mockClear();
  dragging = false;
  Object.defineProperty(window, "gitcrest", { configurable: true, value: { getPathForFile: (file: File) => `C:/work/${file.name}` } });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gitcrest");
});

describe("folder drop", () => {
  it("opens a single dropped folder by its path", () => {
    render(<Probe />);
    act(() => { window.dispatchEvent(dragEvent("drop", [folderItem()])); });
    expect(onFolder).toHaveBeenCalledWith("C:/work/project");
    expect(onProblem).not.toHaveBeenCalled();
  });

  it("refuses a plain file with a message", () => {
    render(<Probe />);
    act(() => { window.dispatchEvent(dragEvent("drop", [fileItem()])); });
    expect(onFolder).not.toHaveBeenCalled();
    expect(onProblem).toHaveBeenCalledWith("That is a file, not a folder. Drop the repository's folder instead.");
  });

  it("refuses several items with a message", () => {
    render(<Probe />);
    act(() => { window.dispatchEvent(dragEvent("drop", [folderItem(), folderItem()])); });
    expect(onFolder).not.toHaveBeenCalled();
    expect(onProblem).toHaveBeenCalledWith("Drop one folder at a time to open it as a repository.");
  });

  it("says so when the desktop bridge cannot give a path", () => {
    Reflect.deleteProperty(window, "gitcrest");
    render(<Probe />);
    act(() => { window.dispatchEvent(dragEvent("drop", [folderItem()])); });
    expect(onFolder).not.toHaveBeenCalled();
    expect(onProblem).toHaveBeenCalledWith("Opening a dropped folder works in the GitCrest desktop app.");
  });

  it("shows a drop target while files are dragged over, and clears it on leave and drop", () => {
    render(<Probe />);
    act(() => { window.dispatchEvent(dragEvent("dragenter", null)); });
    expect(dragging).toBe(true);
    act(() => { window.dispatchEvent(dragEvent("dragenter", null)); });
    act(() => { window.dispatchEvent(dragEvent("dragleave", null)); });
    expect(dragging).toBe(true);
    act(() => { window.dispatchEvent(dragEvent("dragleave", null)); });
    expect(dragging).toBe(false);
    act(() => { window.dispatchEvent(dragEvent("dragenter", null)); });
    act(() => { window.dispatchEvent(dragEvent("drop", [folderItem()])); });
    expect(dragging).toBe(false);
  });

  it("ignores drags that carry no files, such as selected text", () => {
    render(<Probe />);
    const over = dragEvent("dragover", null, ["text/plain"]);
    act(() => { window.dispatchEvent(over); });
    act(() => { window.dispatchEvent(dragEvent("dragenter", null, ["text/plain"])); });
    act(() => { window.dispatchEvent(dragEvent("drop", [folderItem()], ["text/plain"])); });
    expect(over.defaultPrevented).toBe(false);
    expect(dragging).toBe(false);
    expect(onFolder).not.toHaveBeenCalled();
    expect(onProblem).not.toHaveBeenCalled();
  });

  it("allows the drop so the browser does not navigate to the item", () => {
    render(<Probe />);
    const over = dragEvent("dragover", null);
    act(() => { window.dispatchEvent(over); });
    expect(over.defaultPrevented).toBe(true);
  });
});
