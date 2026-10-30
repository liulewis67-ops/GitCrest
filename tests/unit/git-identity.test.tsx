// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { GitCrestApiClient, GitIdentityResponse } from "../../src/api/client";
import { GitIdentityEditor, useGitIdentity } from "../../src/features/identity";

afterEach(cleanup);

const unset: GitIdentityResponse = { name: null, email: null, nameScope: null, emailScope: null, resolved: false };
const local: GitIdentityResponse = { name: "Ada", email: "ada@example.test", nameScope: "local", emailScope: "local", resolved: true };

function fakeApi(methods: Record<string, unknown>) {
  return methods as unknown as GitCrestApiClient;
}

describe("git identity", () => {
  it("reports an unresolved identity for a repository and refreshes after a save", async () => {
    const api = fakeApi({
      getRepositoryIdentity: vi.fn().mockResolvedValueOnce(unset).mockResolvedValue(local),
      setRepositoryIdentity: vi.fn().mockResolvedValue(local),
      setGlobalIdentity: vi.fn().mockResolvedValue({ ...local, nameScope: "global", emailScope: "global" }),
    });
    const { result } = renderHook(() => useGitIdentity(api, "repo_a"));
    await waitFor(() => expect(result.current.identity?.resolved).toBe(false));

    await result.current.save("Ada", "ada@example.test", "global");
    // A global save re-reads the effective identity, which a repository value could shadow.
    await waitFor(() => expect(result.current.identity?.resolved).toBe(true));
    expect(api.setGlobalIdentity).toHaveBeenCalledWith("Ada", "ada@example.test");
    expect((api as unknown as { getRepositoryIdentity: ReturnType<typeof vi.fn> }).getRepositoryIdentity).toHaveBeenCalledTimes(2);
  });

  it("stays unknown, not missing, when the identity cannot be read", async () => {
    const api = fakeApi({ getRepositoryIdentity: vi.fn().mockRejectedValue(new Error("down")) });
    const { result } = renderHook(() => useGitIdentity(api, "repo_a"));
    await waitFor(() => expect(result.current.error).not.toBe(""));
    expect(result.current.identity).toBeUndefined();
  });

  it("saves a repository-only identity from the editor", async () => {
    const setRepositoryIdentity = vi.fn().mockResolvedValue(local);
    const onSaved = vi.fn();
    const api = fakeApi({ getRepositoryIdentity: vi.fn().mockResolvedValue(unset), setRepositoryIdentity });
    render(<GitIdentityEditor api={api} repoId="repo_a" onSaved={onSaved} />);

    fireEvent.change(screen.getByLabelText("Author name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Author email"), { target: { value: "ada@example.test" } });
    fireEvent.click(screen.getByLabelText("This repository only"));
    fireEvent.click(screen.getByRole("button", { name: "Save identity" }));

    await waitFor(() => expect(setRepositoryIdentity).toHaveBeenCalledWith("repo_a", "Ada", "ada@example.test"));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(await screen.findByText("Identity saved.")).toBeTruthy();
  });
});
