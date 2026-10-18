// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { isAbsoluteFolder, rememberWorktreeParent, suggestWorktreePath, worktreePathInParent } from "../../src/features/branches/model/worktree-path";

afterEach(() => window.localStorage.clear());

it("suggests a sibling folder named after the repository and branch", () => {
  expect(suggestWorktreePath("C:\\work\\app", "feature/login")).toBe("C:\\work\\app-feature-login");
  expect(suggestWorktreePath("/home/me/app/", "fix bug")).toBe("/home/me/app-fix-bug");
  expect(suggestWorktreePath(undefined, "x")).toBe("");
  expect(suggestWorktreePath("C:/work/app", "")).toBe("");
});

it("starts from the folder used for the previous worktree once one was created", () => {
  rememberWorktreeParent("D:\\trees\\app-first");
  expect(suggestWorktreePath("C:\\work\\app", "second")).toBe("D:\\trees\\app-second");
  rememberWorktreeParent("/mnt/trees/app-third/");
  expect(suggestWorktreePath("/home/me/app", "fourth")).toBe("/mnt/trees/app-fourth");
});

it("falls back to the repository's folder when storage is unavailable", () => {
  const original = Object.getOwnPropertyDescriptor(window, "localStorage")!;
  Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new Error("blocked"); } });
  try {
    expect(() => rememberWorktreeParent("D:/trees/app-x")).not.toThrow();
    expect(suggestWorktreePath("C:/work/app", "y")).toBe("C:/work/app-y");
  } finally {
    Object.defineProperty(window, "localStorage", original);
  }
});

it("joins a picked folder with the suggested leaf", () => {
  expect(worktreePathInParent("D:\\trees\\", "C:\\work\\app-feature")).toBe("D:\\trees\\app-feature");
  expect(worktreePathInParent("/mnt/trees", "/home/me/app-feature")).toBe("/mnt/trees/app-feature");
});

it("recognises absolute Windows, UNC and POSIX folders and rejects relative ones", () => {
  for (const path of ["C:\\trees\\app", "d:/trees/app", "\\\\server\\share\\app", "/home/me/app", "  /tmp/x "]) expect(isAbsoluteFolder(path)).toBe(true);
  for (const path of ["", "trees/app", "..\\app", "./app", "C:app"]) expect(isAbsoluteFolder(path)).toBe(false);
});
