# Electron Performance Optimization Plan

Status: P1.1–P1.6 and P4.1 implemented on 2026-10-25 (stages 542–549 in `13`). The 20-run packaged re-measure after P1 (stage 547) and a same-day A/B against `e22c37c` (stages 550–551) are recorded under §1. The P1 pass rules are judged, with two known costs to the first History frame. The targets still wait on D1–D3. Date: 2026-10-25.
Scope: the Electron shell (`electron/main/`, `electron/preload/`), the renderer build (`electron.vite.config.ts`, `src/`), and the desktop benchmarks (`scripts/performance/`). The Rust sidecar API targets are already met and are out of scope, except where startup waits on the sidecar.
Related: [10-electron-rust-architecture.md §7](10-electron-rust-architecture.md) (targets), [13-implementation-plan.md §11–12 and the S7.2 entries](13-implementation-plan.md) (ledger, measurement rules, evidence), [08-development-readiness.md](08-development-readiness.md), [release-notes-alpha-draft.md](release-notes-alpha-draft.md).

This plan draws on S7.2's research: about 60 measurement and diagnostic stages from 2026-10-08 to 2026-10-14, with their evidence in `doc/evidence/S7.2/`. It does three things:

1. It sorts what the research proved, what it ruled out, and what it left open.
2. It names the decisions only product or architecture can make. Without them, some targets can never be judged.
3. It turns the remaining app-side work into small, measured S7.2 stages, each with a pass rule.

All numbers below come from one host: Windows 11 10.0.26300 x64, Ryzen 7 5800H, 16 GiB, NVMe, RTX 3050 Laptop on a 60 Hz internal panel, Electron 37, Release sidecar, and the 100k-commit / 1,000-line fixture. Each run used 20 independent, isolated-profile runs of the packaged build, unless marked otherwise.

---

## 1. Where the Electron targets stand

| Target (`10` §7, `08` §4) | Latest result | Source | State |
|---|---|---|---|
| Cold start < 1.5 s | P50 1.11 s, **P95 1.77 s** | stage 536 | Not met. P95 is set by two adjacent outliers (stage 538) |
| 100k-commit first history frame < 1 s | P95 478.6 ms | stage 536 | Met |
| Idle memory < 250 MB | Working Set **P95 384 MiB**; Private WS 108.8 MiB; private bytes 281 MiB | stage 537 | Not met under the current counter (Working Set) |
| Working memory < 500 MB | Loaded repo WS 452.8 MiB; scrolling WS P95 541 MB (with trace) | stages 536, 537 | Loaded repo met. The scrolling peak was taken with trace on, which §12 does not allow for memory acceptance |
| Commit-graph scroll ≥ 60 fps | compositor presented-frame **P5 ≈ 55.3 fps**; idle RAF P5 ≈ 55.2 fps | stages 370, 536 | Not met. Idle shows the same rate, so the list is not the cause (§2.2) |
| Installer < 150 MB | 103.8 MiB (NSIS) | stage 529 | Met |

**Re-measure after P1 (stage 547, 2026-10-25, same host, 20 runs, crash dumps on, none captured).** Cold start P50 1,268 ms / P95 1,439 ms, with every run under 1.5 s. First History frame P95 769 ms; this now includes clicking the History tab, because a repository opens on its Changes view. Scroll presented-frame P5 59.77 fps (59.77–59.80 in every run) and idle RAF P5 59.52 fps. Memory mode P95: idle Working Set 393.8 MiB / Private WS 115.1 MiB; loaded Working Set 492.7 MiB / Private WS 183.1 MiB (loaded now also renders a 1,000-line Monaco diff). Installer 108.19 MiB. These numbers cannot judge the P1 "not worse" rules against stages 536/537, because the app changed a lot between 10-14 and 10-25. A same-day packaged baseline of `e22c37c` is needed for that.

**Same-day A/B (stages 550–551, 2026-10-25, 20 runs each, crash dumps on, none captured).** Baseline `e22c37c` / A = stage 547 build (P1.1–P1.4) / B = stage 549 build (adds P1.5 sandbox and P1.6 package trim):

| P50 / P95 | `e22c37c` | A | B |
|---|---|---|---|
| Cold start (ms) | 1,275 / 1,394 | 1,242 / 1,381 | 1,249 / 1,469 |
| First History frame (ms) | 511 / 587 | 628 / 814 | 723 / 904 |
| Idle Working Set / Private WS, P95 (MiB) | 391.9 / 116.3 | 392.2 / 114.6 | 375.9 / 100.6 |
| Loaded Working Set / Private WS, P95 (MiB) | 493.3 / 188.1 | 495.9 / 186.5 | 461.7 / 166.9 |
| 3 Diffs opened, Working Set / Private WS, P50 of 5 (MiB) | 1,148 / 590 (4 windows) | 749 / 366 (2 windows) | 721 / 337 (2 windows) |
| Installer (MiB) | — | 108.19 | 88.99 |

Cold start is unchanged across the three builds. Memory improves at every step. The first History frame got slower but stays under 1 s, for two reasons. First, since P1.4 the bundled 3 MB `monaco-setup` chunk compiles on the renderer main thread when a repository opens; the baseline's CDN copy loaded asynchronously, after the graph. Second, the sandbox adds about 60–95 ms during that first Monaco load. P4.4 and P4.5 are the candidates to win this back.

The full-result search time after a refs change is about 0.7 s, against a target of < 200 ms. That cost is sidecar and Git work, not Electron, and is tracked in S7.2 apart from this plan.

## 2. What the research established

### 2.1 Memory: most of the idle Working Set is Electron itself

- A blank Electron 37 window, with no GitCrest code and no sidecar, already measures **291.8 MiB** of process-tree Working Set across 4 processes (stage 528, a single sample). GitCrest idle P95 is 382.9–384 MiB (stages 527 and 537), so the app adds about **90 MiB**.
- Process-tree Working Set counts shared Chromium DLL and runtime pages once per process. Under that counter, < 250 MB cannot be reached by app-side work alone. Private Working Set (109/166 MiB idle/loaded) and private bytes (281/354 MiB) are both well under 250/500 for Private WS, but §12 keeps Working Set as the deciding counter until product decides otherwise.
- Per-process split, from one isolated-profile sample (S7.2 entry "Desktop 基准隔离与 GPU 进程对照"), Working Set / private bytes: GPU 133.1/107.6 MB, main 130.4/80.9 MB, renderer 115.3/79.0 MB, utility (network service) 86.2/14.5 MB, sidecar 16.9/3.8 MB.
- App-side reductions that shipped:
  - The updater is lazy-loaded when no feed is configured: about −5.4/−3.5 MB idle/loaded, and main private bytes went from 80.9 to 77.5 MB.
  - Low-frequency dialogs and workspace panels are split out with `React.lazy` (stage 97 and the S7.2 entry "Renderer 对话框按需加载").
  - Closing a repository tab releases its renderer caches. With 32 tabs, closing 31 freed about 3.9 MB of tree WS.
  Each gain is real but small next to the Electron floor.
- Windows counter cost: PerfProc WMI takes about 0.7–0.9 s per query and `Get-Counter` about 2.3 s. Private WS can therefore only be sampled sparsely, in the `memory` mode with no trace, and never in the frame-rate runs.

### 2.2 Frame rate: the ~55 fps cadence comes from Chromium's VSync timing on Windows, not from the app's rendering

- Idle RAF, idle presented frames and scroll presented frames all sit at about 55.2–55.3 fps. An empty-repository screen measures the same as a loaded 100k history (stage 361). The virtual list and SVG lanes are not the cause.
- A detailed trace (stage 374) shows neither the main thread nor paint filling the frame budget. `DisplayScheduler::BeginFrame` advances at about 56 Hz, roughly 1.1 ms late every period. It is not throttled or queued (stage 380). It runs in step with the Chromium GPU VSync worker's wait (stage 381).
- On the OS side, DWM reports 60 Hz refresh and compose, even during scrolling (stages 375 and 382). The window sits on the 60 Hz internal panel (stage 378). The GPU VSync source maps to that panel's active NVIDIA path (stage 383). Hardware compositing on the RTX is active (stage 376).
- Still open: is Chromium's DXGI `WaitForVBlank` failing and falling back to a `Sleep` (`WaitForVSync Sleep` / `WaitForVSyncImpl` markers), or is it returning early? Stage 400 added the `windowsVSyncWait` report fields to tell these apart, but no run has used them yet. `D3DKMTWaitForVerticalBlankEvent` returns *occluded* in a normal desktop session, so it gives no samples (stage 384).

### 2.3 Startup: the median is fine, and the P95 is two neighbouring outliers

- In the 20 samples of stage 536, 18 fall between 0.93 and 1.49 s. Runs 14 and 15 took 1.77 s and 2.61 s, and with 20 samples P95 is the 19th value. The pattern fits host-side interference, such as an antivirus scanning a new profile, but no control run has confirmed it (stage 538).
- The sidecar is ready in about 39–55 ms at P95, so it is a small share of startup.
- The benchmark counts from process launch until the renderer shows "Core connected". The P4.1 phase marks (stage 547) split the ~1.25 s median: `appReady` ≈ 320 ms, window created ≈ 410 ms, DOMContentLoaded ≈ 860 ms, "Core connected" ≈ 1,245 ms.
- A packaged startup trace (stage 548) shows what holds the renderer between window creation and DOMContentLoaded. After the navigation commits, the renderer main thread blocks in `LayerTreeFrameSink` creation until the GPU process is ready: 149 ms with the unsandboxed renderer, 230 ms with the sandboxed one. On this host, cold start therefore waits on GPU process initialization, and saving renderer time before that point (P1.5) only lengthens the wait. After the GPU is ready, the path is app work: entry fetch ≈ 30 ms, compile 12–14 ms, evaluate 23–25 ms, first React render 21–27 ms, first layout 62–66 ms.
- Every renderer chunk is compiled on the main thread with no streaming and no V8 code cache. The trace reports `notStreamedReason: "not http/https protocol"` for `file://`. The largest case is the 3 MB `monaco-setup` chunk: opening a repository whose Changes view shows a Diff costs it 180–290 ms of main-thread compile and evaluate, every launch (stage 550).

## 3. Options already ruled out: do not retry without new evidence

| Option | Result | Stages |
|---|---|---|
| `--disable-gpu` | Falls back to SwiftShader. Presented frames got *slower* in a matched run; RAF got near 59.5 but never 60; WS changed by only ~11–13 MB | 362, 373, 376 |
| `--in-process-gpu` | Idle WS down to ~420 MB, but scrolling fell to ~30 fps | 369, S7.2 entry "Desktop 基准隔离与 GPU 进程对照" |
| `--disable-frame-rate-limit` | Idle stayed at ~55 fps and Working Set went over target | 369 |
| `--disable-gpu-vsync` | Rejected: it adds tearing risk and does not fix the cadence | 377 |
| Treating RAF rate as frame rate | Replaced by compositor `Display::FrameDisplayed` P5 (§12) | 370 |
| Taking memory from trace-enabled runs | Trace inflates memory. Memory acceptance uses `GITCREST_BENCH_MODE=memory` only | 370, 537 |
| Tuning the history list for fps | Disproved by the matching idle and empty-screen rates | 361 |

None of these switches goes into the product. They stay benchmark-only, behind `GITCREST_BENCH_*` variables.

## 4. Findings from the current code that S7.2 has not measured

A code read on 2026-10-25 found four app-side items that no S7.2 stage has covered:

1. **The packaged renderer is not minified.** In `electron.vite.config.ts`, the renderer has no `build.minify`, and electron-vite leaves the output unminified. The current `out/renderer/assets/index-*.js` entry is about 900 KB (210 KB gzip, 18.7k lines) with readable identifiers, and `editor.api-*.js` (Monaco) is about 5.4 MB. The 272.65 KB figure in stage 97 came from `pnpm frontend:build` (plain Vite, minified), so it does not describe what ships.
2. **The main window waits for the sidecar.** On first launch, `createWindow()` in `electron/main/index.ts` awaits `startSidecar()` before it constructs the `BrowserWindow`. As a result, renderer process start, HTML and JS load, and sidecar startup run one after another instead of side by side.
3. **Every "Open in Diff window" creates a new `BrowserWindow`.** `gitcrest:open-diff-window` always calls `createWindow("readOnly", …)`, even though `DiffWindow` can hold up to 100 tabs. Each extra window adds a renderer process, about 80–115 MB of Working Set by the per-process split.
4. **There is no explicit Chromium or V8 tuning.** The code sets no `v8CacheOptions` and calls no `app.commandLine.appendSwitch`. That is a sound default; it just means no tuning has been tried and measured.

The P1.4 request check (stage 545) found a fifth item: **the Diff editors ran a second Monaco fetched from a CDN.** `@monaco-editor/react` was never pointed at the bundled `monaco-editor`, so its loader fetched Monaco 0.55.1 from `cdn.jsdelivr.net` (15 requests, including the TypeScript language service and its worker) the first time a Diff showed. The bundled copy was loaded too, but only to register languages. Diffs therefore needed network access, and the renderer held two Monaco copies. Stage 545 configures the loader with the bundled core.

## 5. Decisions needed before memory and fps can be judged

These are product and architecture calls. This plan does not change any target or counter by itself.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| D1 | Counter for the memory targets on Windows | (a) keep process-tree Working Set and accept that idle < 250 MB cannot be met on Electron; (b) judge by Private Working Set; (c) keep Working Set but set the idle target as "blank Electron baseline + app delta ≤ 100 MiB" | **(b)**, with Working Set still reported. Private WS does not count shared pages more than once, and it is the counter that responds to app changes. Today's result is idle 108.8 / loaded 166 MiB |
| D2 | What "≥ 60 fps" means | (a) a fixed 60 fps; (b) presented-frame P5 ≥ 95% of the refresh rate DWM reports for that display, plus a dropped-frame limit | **(b)**. A fixed number cannot be met on hosts where Chromium's VSync source runs below the panel rate, and it would wrongly fail 50/55 Hz panels. The rule must still fail real app jank |
| D3 | Cold-start P95 outliers | (a) as now: P95 of 20; (b) P95 of 20 on a host with the benchmark folders excluded from antivirus, recording the exclusion | **(b)**, plus a phase breakdown (P4.1), so a real slow path can still be seen |
| D4 | Second test machine | Needed to tell a host or driver limit from a Chromium limit | One more Windows machine with a different GPU vendor, or an external 60/144 Hz display |

When D1–D3 are decided, record them in `13` §12 and in `10` §7, in the same commit. Then re-judge the existing evidence. Stages 536 and 537 already hold the data each option needs.

## 6. Workstreams

Each item below becomes one small stage in the `13-implementation-plan.md` ledger under S7.2. Each follows the §2 commit rules and the §12 measurement rules: 20 runs, the packaged build, isolated profiles, and memory with trace off.

### P1 — Low-risk app-side changes (no dependency on decisions)

| ID | Change | Where | Expected effect (to be measured) | Pass rule |
|---|---|---|---|---|
| P1.1 | Minify the renderer (`renderer.build.minify: "esbuild"`); check that source maps stay out of the package | `electron.vite.config.ts` | Smaller JS to parse and compile at startup and on first Diff; a slightly smaller installer | Entry chunk and `editor.api` sizes recorded before and after; `pnpm check` green; startup P50 and idle WS not worse |
| P1.2 | Create the main `BrowserWindow` and start loading the renderer while the sidecar starts, and send the connection when it is ready. The renderer already copes with a core that is not ready (the restart path) | `electron/main/index.ts` `createWindow`, `app.whenReady` | Takes up to the sidecar ready time (~40–55 ms P95) off cold start | Startup P50/P95 recorded; the sidecar-fails-before-ready error path still shows its stderr tail (S0.1 evidence); E2E green |
| P1.3 | Reuse an open Diff window for the same `repoId`: focus it and send it the new request as a tab, instead of creating a new window | `gitcrest:open-diff-window`, `DiffWindow` | No extra renderer process (~80–115 MB WS) for each further Diff open | WS after opening 3 Diffs, before and after; Diff window E2E green; read-only token scope unchanged |
| P1.4 | Make sure nothing on the first screen loads Monaco, tree-sitter or grammar WASM until a Diff needs it. The language registry lives in the entry chunk; confirm with a startup network/trace check that no `.wasm` or `editor.api` request happens before the first Diff | `src/features/languages/model/*`, `src/features/diff/*` | Keeps the idle renderer heap flat | A trace or request list of a cold start shows no Monaco or tree-sitter requests; idle renderer JS heap recorded |
| P1.5 | Run every renderer sandboxed (`sandbox: true`), with the preload built as one CommonJS script | `electron/main/index.ts`, `electron.vite.config.ts` | No Node.js environment per renderer: less renderer memory and startup CPU, and Electron's recommended security default | Idle and loaded memory-mode P95 not worse; startup P50 not worse; E2E green. Done in stage 548, measured in stage 550 |
| P1.6 | Keep renderer-only packages (React, Monaco, tree-sitter) in `devDependencies`, so electron-builder stops packing their sources into `app.asar` | `package.json` | Smaller installer and install folder; no native rebuild of tree-sitter addons at package time | `app.asar`, installer and install-folder sizes before and after; packaged smoke green. Done in stage 549 |

### P2 — Frame-rate root cause (feeds D2)

| ID | Work | Tool | Output |
|---|---|---|---|
| P2.1 | One detailed-trace run that reads the `windowsVSyncWait` fields from stage 400: the count of `WaitForVSyncImpl` failure markers versus `Sleep` fallback durations | `desktop-frame-diagnostic.mjs` with `GITCREST_BENCH_DETAILED_TRACE=1` | Settles "DXGI wait fails" versus "returns early" |
| P2.2 | Run the same packaged build on the D4 machine or display | `desktop-benchmark.mjs` scroll mode | Shows whether ~55–56 Hz follows this host or Chromium on Windows |
| P2.3 | Rebuild on the current stable Electron (an experiment branch, not merged) and repeat the 20-run scroll and memory runs | `desktop-benchmark-batches.mjs` | Whether a newer Chromium VSync path or memory baseline changes the result. Adopt it only through the normal upgrade review |
| P2.4 | Leave app rendering alone unless P2.1–P2.3 show app frame time or main-thread work in the critical path | — | Avoids optimizing the list blind (§3, last row) |

### P3 — Memory structure (only if D1 keeps Working Set, or if P1 leaves Private WS near the target)

| ID | Candidate | Note |
|---|---|---|
| P3.1 | Measure one Chromium memory feature or switch at a time, each behind a `GITCREST_BENCH_*` variable, and keep only switches with a measured gain and no fps or feature cost | Same procedure as the GPU flags in §3 |
| P3.2 | Main-process audit: list the modules loaded at idle (`ws`, `electron-updater` when configured, language plugin scan) and lazy-load anything not needed before the first window | Main is about 130/81 MB WS/private |
| P3.3 | The P2.3 Electron upgrade data, compared with the 291.8 MiB blank-window baseline | Repeat stage 528 as a 20-run measurement with the new version |

### P4 — Startup measurement and robustness (feeds D3)

| ID | Work | Output |
|---|---|---|
| P4.1 | Add startup phase marks: process start → `app.whenReady` → sidecar ready → window created → `ready-to-show` → DOMContentLoaded → "Core connected". The main process passes the timestamps on to the benchmark only when a `GITCREST_BENCH_*` variable is set | The first breakdown of the ~1.1 s median |
| P4.2 | Repeat 20 cold starts with the benchmark profile and output folders excluded from antivirus scanning (D3 option b), and record the exclusion in the evidence | Confirms or rejects the antivirus explanation from stage 538 |
| P4.3 | Only if P4.1 shows JS compile time on the critical path: try `webPreferences.v8CacheOptions: "bypassHeatCheck"` | Measured or rejected like any other candidate |
| P4.4 | Serve the renderer from a privileged custom scheme (`protocol.registerSchemesAsPrivileged` with `standard`, `secure`, `codeCache: true`) instead of `file://`, so Chromium can stream-compile scripts off the main thread and keep a V8 code cache between launches. CSP, the asset paths and the IPC sender checks have to be reviewed with it | Main-thread compile of the entry and `monaco-setup` chunks with and without; a second-launch run, since isolated benchmark profiles never have a warm cache. Stage 548/550 found compile on the critical path (§2.3) |
| P4.5 | Take the `monaco-setup` compile off the repository-open path, for example by showing the Changes view's first Diff without Monaco until the chunk is ready, or by loading it in idle time only after a repository opens | First History frame and repository-open timings; idle renderer heap stays flat (P1.4) |

## 7. Order and dependencies

```text
P1.1 ─┐
P1.2 ─┼─► 20-run packaged re-measure (startup + memory mode + scroll) ─► re-judge with D1–D3
P1.3 ─┤
P1.4 ─┤
P1.5 ─┤   (stage 550 A/B against e22c37c and the stage 547 build)
P1.6 ─┘
P4.1 ─► P4.2 ─► (P4.3 if compile is on the critical path) ─► P4.4 ─► P4.5
P2.1 ─► P2.2 ─► P2.3 ─► D2
D1 ─► P3 (only when still needed)
```

P1 and P4.1 can start now. P2.2 needs the D4 hardware. P3 waits on D1.

## 8. Measurement protocol (reuse, do not fork the scripts)

- Packaged build: `electron-builder --win --x64 --dir`, then `GITCREST_BENCH_EXECUTABLE` pointing at its `GitCrest.exe`. Development-entry numbers are not evidence (stage 360). Since stage 549 the package has no native dependencies, so the default configuration works on a host without Python. Builds before stage 549 need `-c.npmRebuild=false` there (stage 547).
- The benchmark scripts launch with `--lang=en-US` and open the History view after opening the repository, because their waits match English text and the commit graph (stage 547). A UI change to either one has to update `openFirstRepositoryHistory` in `desktop-benchmark.mjs` and the matching step in `desktop-frame-diagnostic.mjs`.
- Startup and first frame: the default mode of `desktop-benchmark.mjs`, run as 4×5 batches through `desktop-benchmark-batches.mjs`.
- Memory: `GITCREST_BENCH_MODE=memory`, with no trace. Report Working Set, Private Working Set and private bytes as P50/P95/max for idle and loaded.
- Frame rate: scroll mode, compositor presented-frame P5 over 30 s, with idle RAF alongside. Once D2 is decided, add `GITCREST_BENCH_SAMPLE_WINDOWS_DWM=1` so each report carries the DWM refresh rate it is judged against.
- Crash capture: set `GITCREST_BENCH_CRASH_DUMPS_DIR` for every long run (stage 534). The run-19 renderer crash (stage 533) has not happened again.
- Evidence: `doc/evidence/S7.2/desktop-win32-<topic>-stage<N>-<yyyymmdd>.json`, and the ledger entry gives the stage number, environment, P50/P95/max and the pass rule.

## 9. Verification checklist for closing the Electron part of S7.2

- [ ] D1–D3 recorded in `13` §12 and `10` §7.
- [x] P1.1–P1.4 each have a ledger stage with before/after numbers (stages 542–545, judged in 550–551).
- [x] One 20-run packaged re-measure after P1, covering startup, memory mode and scroll, with crash dumps on (stage 547; stage 550 repeats startup and memory for P1.5–P1.6, without scroll).
- [ ] P2.1 result recorded, and P2.2 or P2.3 run.
- [ ] Every target in §1 re-judged under the decided counters; any target still unmet stays 待验收 with its re-test data, per S7.2's own rule.
- [ ] `release-notes-alpha-draft.md` S7.2 limits updated to the final numbers.
