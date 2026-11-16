# GitCrest

GitCrest is a cross-platform Git desktop client built with Electron, React 18, TypeScript, shadcn/ui, Tailwind CSS, and a local Rust sidecar service powered by axum HTTP APIs.

## Development

- Install dependencies with `pnpm install`.
- Build the Rust core with `pnpm core:build`.
- Start the Electron app with `pnpm dev`. Renderer changes reload in place; main-process and preload changes rebuild and restart the app.

## Local debugging

- `pnpm debug` builds the Rust core in debug mode, then starts the app with the renderer dev server, main/preload rebuild on change, source maps, the Node inspector on port 9229 (Electron main) and Chromium remote debugging on port 9222 (renderer). Core output appears in the same terminal, prefixed with `[gitcrest-core]`, with `RUST_BACKTRACE=1`. Add `--break` to pause the main process on its first line.
- `pnpm debug:core` builds and runs only the Rust core at `http://127.0.0.1:47800` with the token `debug-token` and a throwaway database in the system temp folder. Use `--core-port <n>` to change the port.
- Both accept `--skip-core-build`. Rust changes need a restart; renderer changes hot-reload.
- In VS Code, `.vscode/launch.json` has attach configurations for the Electron main process, the renderer, and the `gitcrest-core` process (Windows debugger, or CodeLLDB on macOS/Linux).

## UI review captures

- Run `pnpm build`, then `node scripts/review-screenshots.mjs`. It opens its own disposable Electron profile/database and resizes the **native window** for each capture. It closes that app when finished, including on failure.
- For live automated inspection, use `withReviewApp` and `withReviewWindowSize` from `scripts/review-window.mjs`. Native sizing keeps the renderer and visible window the same size; preview bounds are restored when the callback returns or throws.
- `--cdp http://127.0.0.1:9222` remains an explicit attachment option for the screenshot runner. It uses viewport emulation and repairs it before restoring the session. Prefer the default isolated native-window mode for ordinary reviews.
- If an earlier review left a small render area with blank right/bottom margins in a debug window, run `node scripts/review-window.mjs --reset --cdp http://127.0.0.1:9222`. This restores native viewport sizing without reloading, changing zoom, or discarding the current route/draft. Resizing or restarting the app also clears the retained emulation.

## Development guidelines

- [前端开发规范](doc/15-frontend-development-guidelines.md)：pnpm、React、Tailwind CSS、目录分层与现代化设计规范。
- [产品与技术文档索引](doc/00-README.md)

## License

Copyright 2026 the GitCrest contributors.

GitCrest is licensed under the [Apache License 2.0](LICENSE). Third-party components and assets are subject to their respective licenses.
