// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
};

describe("i18n rendering", () => {
  afterEach(() => {
    cleanup();
    act(() => setLocale("en"));
  });

  it("renders English by default and switches components live to Chinese", () => {
    render(<WelcomePage {...welcomeProps} />);
    expect(screen.getByRole("button", { name: /Open a repository/ })).toBeTruthy();
    expect(screen.getByText("No repositories yet")).toBeTruthy();

    act(() => setLocale("zh"));
    expect(screen.getByRole("button", { name: /打开仓库/ })).toBeTruthy();
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
        theme="dark"
        status="Connected to local Rust core"
        connected
        activeTaskCount={3}
        isMacPlatform={false}
        onPageChange={() => undefined}
        onSelectRepository={() => undefined}
        onCloseRepository={() => undefined}
        onOpenCommandPalette={() => undefined}
        onCycleTheme={() => undefined}
        onOpenTasks={() => undefined}
        onOpenSettings={() => undefined}
      />,
    );
    expect(screen.getByRole("button", { name: "后台任务，3 个进行中" })).toBeTruthy();
    expect(screen.getByText("内核已连接")).toBeTruthy();
  });
});
