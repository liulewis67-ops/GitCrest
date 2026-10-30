// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExternalToolsSettings } from "../../src/features/settings/ui/ExternalToolsSettings";

const setExternalEditor = vi.fn();
const getExternalTools = vi.fn();

beforeEach(() => {
  setExternalEditor.mockReset().mockResolvedValue({ ok: true });
  getExternalTools.mockReset().mockResolvedValue({ editor: { kind: "auto" }, detected: [{ id: "vscode", name: "Visual Studio Code" }, { id: "cursor", name: "Cursor" }] });
  Object.defineProperty(window, "gitcrest", { configurable: true, value: { getExternalTools, setExternalEditor } });
});
afterEach(() => {
  cleanup();
  Reflect.deleteProperty(window, "gitcrest");
});

describe("editor settings", () => {
  it("names the editor that automatic would use and lists the detected ones", async () => {
    render(<ExternalToolsSettings />);
    const select = await screen.findByRole("combobox", { name: "Editor" });
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    expect(screen.getByRole("option", { name: "Automatic (Visual Studio Code)" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Cursor" })).toBeTruthy();
  });

  it("saves a detected editor", async () => {
    render(<ExternalToolsSettings />);
    const select = await screen.findByRole("combobox", { name: "Editor" });
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(select, { target: { value: "cursor" } });
    fireEvent.click(screen.getByRole("button", { name: "Save editor" }));
    await waitFor(() => expect(setExternalEditor).toHaveBeenCalledWith({ kind: "known", id: "cursor" }));
    expect(await screen.findByText("Editor saved.")).toBeTruthy();
  });

  it("saves a custom program, and shows why one was refused", async () => {
    setExternalEditor.mockResolvedValueOnce({ ok: false, message: "That program was not found on the PATH." });
    render(<ExternalToolsSettings />);
    const select = await screen.findByRole("combobox", { name: "Editor" });
    await waitFor(() => expect((select as HTMLSelectElement).disabled).toBe(false));
    fireEvent.change(select, { target: { value: "custom" } });
    const save = screen.getByRole("button", { name: "Save editor" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Program"), { target: { value: "nothere" } });
    fireEvent.click(save);
    expect((await screen.findByRole("alert")).textContent).toContain("not found on the PATH");
    expect(setExternalEditor).toHaveBeenCalledWith({ kind: "custom", program: "nothere" });
  });

  it("shows the saved custom program", async () => {
    getExternalTools.mockResolvedValue({ editor: { kind: "custom", program: "micro" }, detected: [] });
    render(<ExternalToolsSettings />);
    expect(await screen.findByDisplayValue("micro")).toBeTruthy();
    expect(screen.getByRole("option", { name: "Automatic (none found)" })).toBeTruthy();
  });

  it("explains itself outside the desktop app", () => {
    Reflect.deleteProperty(window, "gitcrest");
    render(<ExternalToolsSettings />);
    expect(screen.getByText("Opening other programs works in the GitCrest desktop app.")).toBeTruthy();
  });
});
