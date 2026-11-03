// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppTitlebar } from "../../src/app/layouts/AppTitlebar";
import { WelcomePage } from "../../src/pages/welcome/WelcomePage";
import { readShortcutPreferences } from "../../src/features/settings";
import { setLocale } from "../../src/shared/i18n";

const defaultShortcutPreferences = readShortcutPreferences(null);

const welcomeProps = {
  repositories: [],
  openingRepository: false,
  connected: true,
  shortcuts: defaultShortcutPreferences,
  isMacPlatform: false,
  openError: "",
  onOpenLocalRepository: () => undefined,
  onCloneRepository: () => undefined,
  onNavigateWorkspace: () => undefined,
  onInitializeRepository: () => undefined,
  onOpenRepository: () => undefined,
  onToggleFavorite: () => undefined,
  onForgetRepository: () => undefined,
  onLocateRepository: () => undefined,
};

describe("i18n rendering", () => {
  afterEach(() => {
    cleanup();
    act(() => setLocale("en"));
  });

  it("renders English by default and switches components live to Chinese", () => {
    render(<WelcomePage {...welcomeProps} />);
    expect(screen.getByRole("button", { name: /Open local repository/ })).toBeTruthy();
    expect(screen.getByText("No repositories yet")).toBeTruthy();

    act(() => setLocale("zh"));
    expect(screen.getByRole("button", { name: /打开本地仓库/ })).toBeTruthy();
    expect(screen.getByText("还没有仓库")).toBeTruthy();
    expect(screen.queryByText("No repositories yet")).toBeNull();
  });

  it("translates titlebar labels and interpolated accessible names", () => {
    act(() => setLocale("zh"));
    render(
      <AppTitlebar
        page="welcome"
        openRepoIds={[]}
        repositories={[]}
        shortcuts={defaultShortcutPreferences}
        status="Connected to local Rust core"
        connected
        activeTaskCount={3}
        isMacPlatform={false}
        openingRepository={false}
        onPageChange={() => undefined}
        onSelectRepository={() => undefined}
        onCloseRepository={() => undefined}
        onOpenLocalRepository={() => undefined}
        onCloneRepository={() => undefined}
        onInitializeRepository={() => undefined}
        onOpenCommandPalette={() => undefined}
        onOpenTasks={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "后台任务，3 个进行中" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "后台任务，3 个进行中" }).getAttribute("aria-busy")).toBe("true");
    expect(document.querySelector(".taskCenterButton .loadingSpinner")).not.toBeNull();
    expect(screen.getByText("内核已连接")).toBeTruthy();
  });

  it("opens, clones, or initializes a repository from the tab bar's plus menu", () => {
    const onOpenLocalRepository = vi.fn();
    const onCloneRepository = vi.fn();
    const onInitializeRepository = vi.fn();
    render(
      <AppTitlebar
        page="workspace"
        openRepoIds={[]}
        repositories={[]}
        shortcuts={defaultShortcutPreferences}
        status="Connected to local Rust core"
        connected
        activeTaskCount={0}
        isMacPlatform={false}
        openingRepository={false}
        onPageChange={() => undefined}
        onSelectRepository={() => undefined}
        onCloseRepository={() => undefined}
        onOpenLocalRepository={onOpenLocalRepository}
        onCloneRepository={onCloneRepository}
        onInitializeRepository={onInitializeRepository}
        onOpenCommandPalette={() => undefined}
        onOpenTasks={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    expect(screen.queryByRole("button", { name: "Workspace" })).toBeNull();
    const plus = screen.getByRole("button", { name: "Open, clone, or initialize a repository" });
    for (const [label, handler] of [[/Open local repository/, onOpenLocalRepository], [/Clone a repository/, onCloneRepository], [/Initialize a repository/, onInitializeRepository]] as const) {
      fireEvent.click(plus);
      fireEvent.click(screen.getByRole("menuitem", { name: label }));
      expect(handler).toHaveBeenCalledTimes(1);
      expect(screen.queryByRole("menu")).toBeNull();
    }
  });
});
