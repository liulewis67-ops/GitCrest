# GitCrest marketing website

A standalone Chinese and English landing page based on `output/imagegen/gitcrest-landing-bilingual-long-v2.png`. The desktop client and its renderer are separate from this website.

## Develop

From the repository root:

```sh
pnpm website:dev
```

Open `http://127.0.0.1:4173/`. Use `?lang=zh` or `?lang=en` for a specific language. The choice is also saved locally. Fonts and Lenis are bundled locally, so visitors do not need third party font or animation CDNs.

## Validate and build

```sh
pnpm website:check
pnpm website:build
pnpm website:preview
```

Deploy the generated `website/dist` directory to static hosting. `404.html` is emitted automatically. Configure the static host to return that page for missing paths. For subpath hosting, set `WEBSITE_BASE_PATH` to the site's path with a trailing slash. Set `WEBSITE_PUBLIC_URL` to the site's absolute URL with a trailing slash for the social preview image.

The GitHub Pages workflow builds and publishes the site on pushes to `main`. It reads both values from the Pages configuration.

`verify.mjs` exercises DOM interactions using jsdom. It does not verify browser rendering, responsive geometry, visual quality, real keyboard focus trapping, or animation smoothness. Check desktop and 390px mobile layouts in a browser before publishing.

## Downloads

Production builds never invent release links. Set absolute HTTPS installer URLs before building:

```powershell
$env:WEBSITE_WINDOWS_URL = 'https://your-release-host/GitCrest-Setup.exe'
$env:WEBSITE_MACOS_URL = 'https://your-release-host/GitCrest.dmg'
$env:WEBSITE_LINUX_URL = 'https://your-release-host/GitCrest.AppImage'
pnpm website:build
```

Unset platforms show an explicit unpublished state. You can also update `dist/releases.json` after building. The page handles loading failure and offers retry.

In development only, if `dist/GitCrest Setup 0.1.0.exe` exists in the repository root, the dev server serves that exact file as the Windows preview download. It never exposes arbitrary local paths or includes that installer in the static build. Installer signing and runtime validation remain part of the existing desktop release workflow.

## Design and motion

- One primary conversion: download GitCrest.
- Hero and interactive workspace, word reveal, code structure, history, conflict comparison, three step workflow, command and theme previews, six question FAQ, download, footer.
- Language switch replaces navigation, marketing copy, demo controls, FAQ, legal notices, and metadata. English filenames and code remain unchanged.
- Lenis 1.3.27 provides wheel damping; touch remains native. Its reduced motion preference is enabled. Section entrances use IntersectionObserver. The tagline and reading progress use a requestAnimationFrame throttled scroll callback. Only transforms and opacity animate.
- `prefers-reduced-motion` removes spatial animation, shows all tagline text, and disables smoothing through Lenis.
- No analytics, remote forms, accounts, cookies, invented testimonials, prices, or performance claims. The privacy and site terms notices describe the actual page implementation.
- The main workbench embeds `demo.html`, which imports the actual `src/app/App.tsx` and `src/styles/globals.css`. Its titlebar, repository toolbar, Commit panel, diff, history, menus, settings, and translations are the client's own components, not a second HTML recreation. The outer landing page scales a 1280 × 816 desktop viewport without overriding app styles.
- `demo-environment.ts` replaces storage with a per-frame in-memory store and installs a browser-only bridge and API transport. Status, diff, branches, history, staging, and commits use fixture data. External API requests, Rust connections, native file dialogs, and filesystem operations are not exposed. Unsupported operations return an explicit demo error. Language switching reloads the embedded client with the selected locale. Other small feature illustrations remain simplified marketing examples.
- To check the real component integration and transport isolation, run `pnpm exec vitest run tests/unit/website-demo.test.tsx --config vitest.config.ts`.

Lenis documentation: https://github.com/darkroomengineering/lenis

Third party licenses are in `public/vendor/lenis-LICENSE.txt` and `public/assets/geist-LICENSE.txt`. The GitCrest brand comes from the project's existing icon.
