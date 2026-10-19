# GitCrest

GitCrest is a cross-platform Git desktop client built with Electron, React 18, TypeScript, shadcn/ui, Tailwind CSS, and a local Rust sidecar service powered by axum HTTP APIs.

## Development

- Install dependencies with `pnpm install`.
- Build the Rust core with `pnpm core:build`.
- Start the Electron app with `pnpm dev`.

## Local debugging

- `pnpm debug` builds the Rust core in debug mode, then starts the app with the renderer dev server, main/preload rebuild on change, source maps, the Node inspector on port 9229 (Electron main) and Chromium remote debugging on port 9222 (renderer). Core output appears in the same terminal, prefixed with `[gitcrest-core]`, with `RUST_BACKTRACE=1`. Add `--break` to pause the main process on its first line.
- `pnpm debug:core` builds and runs only the Rust core at `http://127.0.0.1:47800` with the token `debug-token` and a throwaway database in the system temp folder. Use `--core-port <n>` to change the port.
- Both accept `--skip-core-build`. Rust changes need a restart; renderer changes hot-reload.
- In VS Code, `.vscode/launch.json` has attach configurations for the Electron main process, the renderer, and the `gitcrest-core` process (Windows debugger, or CodeLLDB on macOS/Linux).

## Development guidelines

- [前端开发规范](doc/15-frontend-development-guidelines.md)：pnpm、React、Tailwind CSS、目录分层与现代化设计规范。
- [产品与技术文档索引](doc/00-README.md)
