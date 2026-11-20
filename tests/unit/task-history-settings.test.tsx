// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { GitCrestApiClient } from "../../src/api/client";
import { TaskHistorySettings } from "../../src/features/tasks/ui/TaskHistorySettings";

afterEach(cleanup);

it("loads persisted retention and saves only valid whole days", async () => {
  const api = { getTaskSettings: vi.fn().mockResolvedValue({ retentionDays: 15 }), setTaskSettings: vi.fn().mockResolvedValue({ retentionDays: 7 }), withSignal: () => api };
  render(<TaskHistorySettings api={api as unknown as GitCrestApiClient} />);
  const input = screen.getByRole("spinbutton", { name: "Days to retain logs" }) as HTMLInputElement;
  await waitFor(() => expect(input.disabled).toBe(false));
  expect(input.value).toBe("15");
  const save = screen.getByRole("button", { name: "Save retention" }) as HTMLButtonElement;
  for (const value of ["0", "1.5", "3651", ""]) {
    fireEvent.change(input, { target: { value } }); expect(save.disabled).toBe(true);
  }
  fireEvent.change(input, { target: { value: "7" } }); fireEvent.click(save);
  await waitFor(() => expect(api.setTaskSettings).toHaveBeenCalledWith(7));
  expect(await screen.findByRole("status")).toHaveProperty("textContent", "Saved. Expired task history has been cleared.");
});
