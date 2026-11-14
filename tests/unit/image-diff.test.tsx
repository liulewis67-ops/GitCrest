// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCrestApiError } from "../../src/api/client";
import { ImageDiff, isComparableImagePath, type ImageSource } from "../../src/features/diff/ui/ImageDiff";

const created: string[] = [];
const revoked: string[] = [];

class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(value: string) {
    const dimensions = value.endsWith("-new") ? [140, 80] : [120, 80];
    this.naturalWidth = dimensions[0];
    this.naturalHeight = dimensions[1];
    queueMicrotask(() => this.onload?.());
  }
}

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  let counter = 0;
  vi.stubGlobal("Image", FakeImage);
  URL.createObjectURL = vi.fn((blob: Blob) => {
    const url = `blob:image-${counter++}-${blob.size === 2048 ? "new" : "old"}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => { revoked.push(url); });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const old = { blob: new Blob([new Uint8Array(1024)]), type: "image/png", size: 1024 };
const added = { blob: new Blob([new Uint8Array(2048)]), type: "image/png", size: 2048 };
function apiError(status: number) {
  return new GitCrestApiError(status, { error: { code: "X", message: "x" } } as never);
}
function source(sides: { old: unknown; new: unknown }): ImageSource {
  return { load: vi.fn((side: "old" | "new") => {
    const value = sides[side];
    return value instanceof Error ? Promise.reject(value) : Promise.resolve(value as typeof old);
  }) };
}

describe("image paths", () => {
  it("recognises the formats that can be compared", () => {
    for (const path of ["a.png", "b/C.JPG", "d.jpeg", "e.gif", "f.webp", "g.svg"]) expect(isComparableImagePath(path), path).toBe(true);
    for (const path of ["a.txt", "b.png.bak", "svg", "c.bmp"]) expect(isComparableImagePath(path), path).toBe(false);
  });
});

describe("image comparison", () => {
  it("shows both versions with dimensions and the change in size", async () => {
    render(<ImageDiff path="assets/logo.png" source={source({ old, new: added })} />);
    expect(await screen.findByRole("img", { name: "assets/logo.png, before the change" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "assets/logo.png, after the change" })).toBeTruthy();
    const facts = screen.getByText(/Before:/).closest("p")!;
    expect(facts.textContent).toContain("120×80, 1.0 KiB");
    expect(facts.textContent).toContain("140×80, 2.0 KiB");
    expect(facts.textContent).toContain("Size change: +1.0 KiB");
  });

  it("switches to swipe and onion-skin views with a slider for each", async () => {
    render(<ImageDiff path="a.png" source={source({ old, new: added })} />);
    await screen.findByRole("img", { name: "a.png, after the change" });
    fireEvent.click(screen.getByRole("button", { name: "Swipe" }));
    const swipe = screen.getByLabelText("Swipe position") as HTMLInputElement;
    fireEvent.change(swipe, { target: { value: "30" } });
    expect(swipe.value).toBe("30");
    expect(document.querySelector(".imageDiffStack")?.getAttribute("style")).toContain("30%");
    fireEvent.click(screen.getByRole("button", { name: "Onion skin" }));
    const onion = screen.getByLabelText("After opacity") as HTMLInputElement;
    fireEvent.change(onion, { target: { value: "25" } });
    expect((document.querySelector(".imageDiffOnion") as HTMLElement).style.opacity).toBe("0.25");
    expect(screen.getByRole("button", { name: "Onion skin" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows an added picture alone and explains why the other views are unavailable", async () => {
    render(<ImageDiff path="new.png" source={source({ old: apiError(404), new: added })} />);
    expect(await screen.findByRole("img", { name: "new.png, after the change" })).toBeTruthy();
    expect(screen.getByText("Not in this version")).toBeTruthy();
    const swipe = screen.getByRole("button", { name: "Swipe" }) as HTMLButtonElement;
    expect(swipe.disabled).toBe(true);
    expect(swipe.title).toBe("Both versions are needed for this view.");
  });

  it("says when a version is too large or cannot be loaded", async () => {
    render(<ImageDiff path="big.png" source={source({ old: apiError(413), new: new Error("network") })} />);
    expect(await screen.findByText("Too large to show (over 8 MiB)")).toBeTruthy();
    expect((await screen.findAllByText("Could not load this version")).length).toBeGreaterThan(0);
  });

  it("gives the picture back to the browser when it goes away", async () => {
    const { unmount } = render(<ImageDiff path="a.png" source={source({ old, new: added })} />);
    await waitFor(() => expect(created).toHaveLength(2));
    await screen.findByRole("img", { name: "a.png, after the change" });
    unmount();
    expect(revoked.sort()).toEqual([...created].sort());
  });

  it("renders an SVG through an image element, never as markup", async () => {
    const svg = { blob: new Blob(['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'], { type: "image/svg+xml" }), type: "image/svg+xml", size: 80 };
    const { container } = render(<ImageDiff path="logo.svg" source={source({ old: svg, new: svg })} />);
    await screen.findAllByRole("img", { name: /logo.svg/ });
    expect(container.querySelector(".imageDiffSides svg, .imageDiffStack svg, script, object, iframe")).toBeNull();
    for (const image of container.querySelectorAll("img")) expect(image.getAttribute("src")).toMatch(/^blob:/);
  });
});
