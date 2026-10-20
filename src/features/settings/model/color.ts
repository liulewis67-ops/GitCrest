/** Colors are stored as lowercase `#rrggbb`; every helper here accepts and returns that form. */
export type Hex = `#${string}`;

type Rgb = readonly [number, number, number];

const HEX_PATTERN = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function isHexColor(value: unknown): value is Hex {
  return typeof value === "string" && HEX_PATTERN.test(value.trim());
}

/** Returns `#rrggbb`, or undefined when the value isn't a 3- or 6-digit hex color. */
export function normalizeHex(value: unknown): Hex | undefined {
  if (!isHexColor(value)) return undefined;
  const digits = value.trim().slice(1).toLowerCase();
  const full = digits.length === 3 ? [...digits].map((digit) => digit + digit).join("") : digits;
  return `#${full}`;
}

function toRgb(hex: Hex): Rgb {
  const value = normalizeHex(hex) ?? "#000000";
  return [1, 3, 5].map((start) => parseInt(value.slice(start, start + 2), 16)) as unknown as Rgb;
}

function fromRgb([red, green, blue]: Rgb): Hex {
  return `#${[red, green, blue].map((channel) => Math.round(Math.min(255, Math.max(0, channel))).toString(16).padStart(2, "0")).join("")}`;
}

/** Moves `from` toward `to` by `amount` (0 keeps `from`, 1 gives `to`), in sRGB like CSS color-mix. */
export function mix(from: Hex, to: Hex, amount: number): Hex {
  const a = toRgb(from);
  const b = toRgb(to);
  return fromRgb([0, 1, 2].map((index) => a[index] + (b[index] - a[index]) * amount) as unknown as Rgb);
}

/** CSS color with alpha, e.g. `rgb(109 182 216 / 13%)`. */
export function withAlpha(hex: Hex, alpha: number): string {
  const [red, green, blue] = toRgb(hex);
  return `rgb(${red} ${green} ${blue} / ${Math.round(alpha * 100)}%)`;
}

/** `#rrggbbaa`, the form Monaco theme colors accept. */
export function hexWithAlpha(hex: Hex, alpha: number): string {
  return `${normalizeHex(hex) ?? "#000000"}${Math.round(Math.min(1, Math.max(0, alpha)) * 255).toString(16).padStart(2, "0")}`;
}

export function relativeLuminance(hex: Hex): number {
  const [red, green, blue] = toRgb(hex).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

/** WCAG 2 contrast ratio, from 1 to 21. */
export function contrastRatio(a: Hex, b: Hex): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

const DARK_INK: Hex = "#0d1a22";
const LIGHT_INK: Hex = "#ffffff";

/** The text color to put on a filled `background`, whichever of near-black or white reads better. */
export function readableOn(background: Hex): Hex {
  return contrastRatio(DARK_INK, background) >= contrastRatio(LIGHT_INK, background) ? DARK_INK : LIGHT_INK;
}
