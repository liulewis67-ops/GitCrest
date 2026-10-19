// Renders the app icon master (build/icon.svg) to the PNGs electron-builder packages.
//
//   pnpm icons:export
//
// Writes build/icon.png (1024px, which electron-builder turns into .ico and .icns) and build/icons/<n>x<n>.png
// for Linux desktop entries. Uses Playwright's bundled Chromium, falling back to an installed Edge or Chrome.
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const buildDir = join(root, "build");
const LINUX_SIZES = [16, 24, 32, 48, 64, 128, 256, 512, 1024];

const svg = await readFile(join(buildDir, "icon.svg"), "utf8");
const browser = await launchBrowser();
try {
  const page = await browser.newPage();
  await mkdir(join(buildDir, "icons"), { recursive: true });
  await render(page, 1024, join(buildDir, "icon.png"));
  for (const size of LINUX_SIZES) await render(page, size, join(buildDir, "icons", `${size}x${size}.png`));
} finally {
  await browser.close();
}
console.log(`Exported build/icon.png and ${LINUX_SIZES.length} sizes in build/icons.`);

async function render(page, size, path) {
  await page.setViewportSize({ width: size, height: size });
  const sized = svg.replace(/width="\d+" height="\d+"/, `width="${size}" height="${size}"`);
  await page.setContent(`<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block}</style>${sized}`);
  await page.locator("svg").screenshot({ path, omitBackground: true });
}

async function launchBrowser() {
  for (const channel of [undefined, "msedge", "chrome"]) {
    try {
      return await chromium.launch(channel ? { channel } : {});
    } catch {
      // Try the next browser.
    }
  }
  throw new Error("No Chromium browser found. Run `pnpm exec playwright install chromium` and try again.");
}
