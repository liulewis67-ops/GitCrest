# Renderer workspace lazy-load bundle check

- Date: 2026-10-09
- Command: `pnpm frontend:build`
- Baseline source: `6e53bb6` (before workspace feature lazy imports)
- Updated source: `ea0b449`
- Result: Vite main renderer entry changed from 318.32 KB (91.74 KB gzip) to 272.65 KB (79.56 KB gzip), a reduction of 45.67 KB (12.18 KB gzip).
- The updated build emits separate `CommitGraph`, `RemoteManager`, `ShelfCenter`, and `SplitDiff` chunks. TypeScript and the production Vite build completed successfully.
- Scope: This measures bundle output only. It does not measure Electron process-tree memory, scroll frame rate, cold-cache startup, or prove any S7.2 runtime threshold.
