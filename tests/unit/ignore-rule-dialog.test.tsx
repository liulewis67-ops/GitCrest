// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, IgnoreRuleResponse } from "../../src/api/client";
import { IgnoreRuleDialog } from "../../src/features/changes";

afterEach(cleanup);

function rule(overrides: Partial<IgnoreRuleResponse> = {}): IgnoreRuleResponse {
  return { repoId: "repo_a", line: "*.log", file: ".gitignore", alreadyPresent: false, ...overrides };
}
function fakeApi(methods: Record<string, unknown>) {
  let api: Record<string, unknown>;
  api = { ...methods, withSignal: vi.fn(() => api) };
  return api as unknown as GitCrestApiClient;
}

describe("ignore rule dialog", () => {
  it("shows the exact line and file before anything is written", async () => {
    const previewIgnoreRule = vi.fn().mockResolvedValue(rule());
    const addIgnoreRule = vi.fn();
    render(<IgnoreRuleDialog api={fakeApi({ previewIgnoreRule, addIgnoreRule })} repoId="repo_a" path="build/out.log" mode="extension" onClose={vi.fn()} onAdded={vi.fn()} />);

    expect(await screen.findByText("*.log")).toBeTruthy();
    expect(screen.getByText("This line will be added to .gitignore:")).toBeTruthy();
    expect(previewIgnoreRule).toHaveBeenCalledWith("repo_a", "build/out.log", "extension", "gitignore");
    expect(addIgnoreRule).not.toHaveBeenCalled();
  });

  it("writes the rule to the private exclude file when chosen", async () => {
    const previewIgnoreRule = vi.fn(async (_repo: string, _path: string, _mode: string, target: string) => rule(target === "exclude" ? { line: "/secret.txt", file: ".git/info/exclude" } : {}));
    const addIgnoreRule = vi.fn().mockResolvedValue(rule({ line: "/secret.txt", file: ".git/info/exclude" }));
    const onAdded = vi.fn();
    render(<IgnoreRuleDialog api={fakeApi({ previewIgnoreRule, addIgnoreRule })} repoId="repo_a" path="secret.txt" mode="file" onClose={vi.fn()} onAdded={onAdded} />);

    fireEvent.click(await screen.findByLabelText(/private to this computer/));
    expect(await screen.findByText("/secret.txt")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    await waitFor(() => expect(addIgnoreRule).toHaveBeenCalledWith("repo_a", "secret.txt", "file", "exclude"));
    expect(onAdded).toHaveBeenCalled();
  });

  it("says when the line is already present and reports failures", async () => {
    const previewIgnoreRule = vi.fn().mockResolvedValue(rule({ alreadyPresent: true }));
    const addIgnoreRule = vi.fn().mockRejectedValue(new Error("disk full"));
    render(<IgnoreRuleDialog api={fakeApi({ previewIgnoreRule, addIgnoreRule })} repoId="repo_a" path="a.log" mode="extension" onClose={vi.fn()} onAdded={vi.fn()} />);

    expect(await screen.findByText("This line is already in the file, so nothing changes.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    expect((await screen.findByRole("alert")).textContent).toContain("disk full");
  });
});
