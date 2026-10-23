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

function toHsl(hex: Hex): readonly [number, number, number] {
  const [red, green, blue] = toRgb(hex).map((channel) => channel / 255);
  const max = Math.max(red, green, blue);
  const min = Math.min(red, green, blue);
  const lightness = (max + min) / 2;
  if (max === min) return [0, 0, lightness];
  const delta = max - min;
  const saturation = lightness > 0.5 ? delta / (2 - max - min) : delta / (max + min);
  const hue = max === red ? (green - blue) / delta + (green < blue ? 6 : 0)
    : max === green ? (blue - red) / delta + 2
      : (red - green) / delta + 4;
  return [hue * 60, saturation, lightness];
}

function fromHsl(hue: number, saturation: number, lightness: number): Hex {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = (((hue % 360) + 360) % 360) / 60;
  const second = chroma * (1 - Math.abs((sector % 2) - 1));
  const [red, green, blue] = sector < 1 ? [chroma, second, 0]
    : sector < 2 ? [second, chroma, 0]
      : sector < 3 ? [0, chroma, second]
        : sector < 4 ? [0, second, chroma]
          : sector < 5 ? [second, 0, chroma]
            : [chroma, 0, second];
  const offset = lightness - chroma / 2;
  return fromRgb([red, green, blue].map((channel) => (channel + offset) * 255) as unknown as Rgb);
}

/**
 * Turns the hue by `degrees`, keeping lightness, so a derived color has the same weight as `hex`.
 * `minSaturation` (0–1) keeps a gray or muted source from producing hues that all look alike.
 */
export function rotateHue(hex: Hex, degrees: number, minSaturation = 0): Hex {
  const [hue, saturation, lightness] = toHsl(hex);
  return fromHsl(hue + degrees, Math.max(saturation, minSaturation), lightness);
}

/** `hex` with its hue set to `hue` degrees, keeping lightness; see `rotateHue` for `minSaturation`. */
export function withHue(hex: Hex, hue: number, minSaturation = 0): Hex {
  const [, saturation, lightness] = toHsl(hex);
  return fromHsl(hue, Math.max(saturation, minSaturation), lightness);
}

/** Returns `foreground`, moved just far enough toward white or black (whichever `background` is further from) to reach `minimum`:1. */
export function ensureContrast(foreground: Hex, background: Hex, minimum: number): Hex {
  if (contrastRatio(foreground, background) >= minimum) return foreground;
  const target: Hex = relativeLuminance(background) < 0.5 ? "#ffffff" : "#000000";
  for (let step = 1; step <= 20; step += 1) {
    const candidate = mix(foreground, target, step / 20);
    if (contrastRatio(candidate, background) >= minimum) return candidate;
  }
  return target;
}
