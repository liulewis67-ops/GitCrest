// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ConflictWindow } from "../../src/features/workflows/ConflictWindow";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("edits, saves, and marks a conflict resolved using conflict-scoped window access", async () => {
  const repoId = `repo_${"a".repeat(64)}`;
  window.history.replaceState({}, "", `/?view=conflicts&repoId=${repoId}&taskId=task-123-1`);
  Object.defineProperty(window, "gitcrest", {
    configurable: true,
    value: { getSidecarConnection: vi.fn().mockResolvedValue({ baseUrl: "http://127.0.0.1:4100", token: "conflict-scoped", windowAccess: "conflictResolution" }) },
  });
  let preview = {
    repoId, taskId: "task-123-1", operation: "merge", headOid: "a".repeat(40), dirtyPaths: ["conflict.ts"],
    omittedDirtyPathCount: 0, conflictedPaths: ["conflict.ts"], omittedConflictedPathCount: 0, canContinue: false, canSkip: false, canAbort: true,
  };
  let conflict = {
    repoId, taskId: "task-123-1", path: "conflict.ts", operation: "merge", headOid: "a".repeat(40),
    baseContent: "base value", oursContent: "ours value", theirsContent: "theirs value", resultContent: "<<<<<<< ours", resultRevision: "b".repeat(64), isText: true,
  };
  vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockImplementation(async (input, init) => {
    const url = String(input);
    if (url.includes("conflicts/resolved")) {
      preview = { ...preview, conflictedPaths: [], canContinue: true };
      return new Response(JSON.stringify({ taskId: "resolve-task", status: "queued" }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } });
    }
    if (url.includes("conflicts/file") && init?.method === "PUT") {
      const request = JSON.parse(String(init.body)) as { content: string };
      conflict = { ...conflict, resultContent: request.content, resultRevision: "c".repeat(64) };
      return new Response(JSON.stringify({ taskId: "save-task", status: "queued" }), { status: 202, headers: { "X-GitCrest-API-Version": "1" } });
    }
    if (url.includes("conflicts/file")) {
      return new Response(JSON.stringify(conflict), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
    }
    const body = preview;
    return new Response(JSON.stringify(body), { status: 200, headers: { "X-GitCrest-API-Version": "1" } });
  }));
  const view = render(<ConflictWindow />);
  expect(await screen.findByText("base value")).toBeTruthy();
  expect(screen.getByText("ours value")).toBeTruthy();
  expect(screen.getByText("theirs value")).toBeTruthy();
  const editor = screen.getByRole("textbox", { name: "Working result" }) as HTMLTextAreaElement;
  expect(editor.value).toBe("<<<<<<< ours");
  fireEvent.click(screen.getByRole("button", { name: "Use theirs" }));
  expect(editor.value).toBe("theirs value");
  expect((screen.getByRole("button", { name: "Mark resolved" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Save result" }));
  expect(await screen.findByText(/Saved to the working tree/)).toBeTruthy();
  expect(editor.value).toBe("theirs value");
  view.unmount();
  render(<ConflictWindow />);
  const reopenedEditor = await screen.findByRole("textbox", { name: "Working result" }) as HTMLTextAreaElement;
  expect(reopenedEditor.value).toBe("theirs value");
  fireEvent.click(screen.getByRole("button", { name: "Mark resolved" }));
  await waitFor(() => expect(screen.getByText("0 unresolved")).toBeTruthy());
  expect(screen.getByText("No unresolved files remain. Return to Task Center to continue the Git operation.")).toBeTruthy();
});
