// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, SigningConfigResponse, TaskSnapshotResponse } from "../../src/api/client";
import { SigningSettings } from "../../src/features/identity";
import { isSigningFailure, signingFailureOutput } from "../../src/features/tasks/model/task-operations";

afterEach(cleanup);

function task(overrides: Partial<TaskSnapshotResponse>): TaskSnapshotResponse {
  return { taskId: "t1", repoId: "repo_a", operation: "commit", status: "failed", phase: "", progress: null, message: "Git command failed with exit code 128", errorCategory: null, logs: [], createdAtMs: 1, updatedAtMs: 1, cancelRequested: false, ...overrides } as TaskSnapshotResponse;
}

// The lines Git printed for a real signed commit whose GPG program was missing.
const REAL_LOGS = [
  "git read-tree <base> (temporary commit index)",
  "git commit --file=-",
  "error: cannot spawn gitcrest-intentionally-missing-gpg: No such file or directory",
  "error: gpg failed to sign the data",
  "fatal: failed to write commit object",
];

describe("signing failures in the task list", () => {
  it("recognises what Git printed for a commit that could not be signed", () => {
    const failed = task({ logs: REAL_LOGS });
    expect(isSigningFailure(failed)).toBe(true);
    const output = signingFailureOutput(failed);
    expect(output).toContain("error: cannot spawn gitcrest-intentionally-missing-gpg");
    expect(output).toContain("error: gpg failed to sign the data");
    expect(output).not.toContain("git read-tree");
  });

  it("recognises SSH and GPG agent wording", () => {
    for (const line of ["Couldn't load public key /home/ada/.ssh/id.pub: No such file or directory", 'Load key "/home/ada/key": invalid format', "gpg: skipped \"ABCDEF\": No secret key", "error: Couldn't get agent socket?", "gpg: signing failed: Inappropriate ioctl for device"]) {
      expect(isSigningFailure(task({ logs: [line] })), line).toBe(true);
    }
  });

  it("does not blame signing for other failures or other tasks", () => {
    expect(isSigningFailure(task({ logs: ["hint: pre-commit hook failed", "error: hook declined"] }))).toBe(false);
    expect(isSigningFailure(task({ operation: "push", logs: REAL_LOGS }))).toBe(false);
    expect(isSigningFailure(task({ status: "succeeded", logs: REAL_LOGS }))).toBe(false);
  });
});

describe("signing settings", () => {
  const config: SigningConfigResponse = { repoId: "repo_a", format: "ssh", signingKey: "C:/keys/id.pub", signByDefault: true, program: null };
  function fakeApi(methods: Record<string, unknown>) {
    let api: Record<string, unknown>;
    api = { ...methods, withSignal: vi.fn(() => api) };
    return api as unknown as GitCrestApiClient;
  }

  it("shows the format, key and default without any key material", async () => {
    render(<SigningSettings api={fakeApi({ getRepositorySigning: vi.fn().mockResolvedValue(config) })} repoId="repo_a" />);
    expect(await screen.findByText("SSH key")).toBeTruthy();
    expect(screen.getByText("C:/keys/id.pub")).toBeTruthy();
    expect(screen.getByText("On")).toBeTruthy();
  });

  it("says when no key is set", async () => {
    render(<SigningSettings api={fakeApi({ getRepositorySigning: vi.fn().mockResolvedValue({ ...config, format: "openpgp", signingKey: null, signByDefault: false }) })} repoId="repo_a" />);
    expect(await screen.findByText("GPG (OpenPGP)")).toBeTruthy();
    expect(screen.getByText("Not set (Git picks a default)")).toBeTruthy();
  });

  it("tests signing and reports success", async () => {
    const testRepositorySigning = vi.fn().mockResolvedValue({ repoId: "repo_a", signed: true, output: "" });
    render(<SigningSettings api={fakeApi({ getRepositorySigning: vi.fn().mockResolvedValue(config), testRepositorySigning })} repoId="repo_a" />);
    const button = await screen.findByRole("button", { name: "Test signing" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect(await screen.findByText("Signing works: a test signature was made with your key.")).toBeTruthy();
  });

  it("shows the tool's own words when signing fails", async () => {
    const testRepositorySigning = vi.fn().mockResolvedValue({ repoId: "repo_a", signed: false, output: "Couldn't load public key: No such file" });
    render(<SigningSettings api={fakeApi({ getRepositorySigning: vi.fn().mockResolvedValue(config), testRepositorySigning })} repoId="repo_a" />);
    const button = await screen.findByRole("button", { name: "Test signing" });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(button);
    expect((await screen.findByRole("alert")).textContent).toContain("Couldn't load public key: No such file");
  });

  it("asks for a repository first", () => {
    render(<SigningSettings api={fakeApi({})} />);
    expect(screen.getByText("Open a repository to see how its commits are signed.")).toBeTruthy();
  });
});
