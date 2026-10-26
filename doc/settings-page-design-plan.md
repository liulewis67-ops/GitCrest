# Settings page and theming design plan

Status: implemented in the first iteration described below. Date: 2026-10-20.

## 1. Goals

- Turn Settings from a 760px modal into a full settings page with a stable home for every preference: language, appearance, shortcuts, AI assistant, updates.
- Keep the two built-in themes and add more, plus user-made custom themes covering colors, the accent color and text sizes.
- Every window (main, Diff, Conflict review) shows the same theme and follows changes live.
- No visual change for people who never open the new options: the built-in GitCrest Dark and GitCrest Light produce exactly today's token values.

Non-goals for this iteration: syncing preferences through the Rust core, per-repository settings, a density setting (tracked in `visual-optimization-plan.md` §6), a theme marketplace.

## 2. Where Settings lives

### 2.1 Page, not dialog

Settings becomes a full-height view that covers the content area under the titlebar. The page underneath (Welcome or Workspace) stays mounted, so closing Settings returns to the exact graph scroll position, selection and draft commit message.

```
┌ titlebar: brand · repo tabs · ⌕ search · ◐ theme · Tasks · Settings · ● core ┐
├──────────────┬────────────────────────────────────────────────────────────────┤
│ PREFERENCES  │ General                                                        │
│ Settings   × │   Language            [ English | 中文 ]                       │
│              │                                                                │
│ ▸ General    │ Appearance                                                     │
│   Appearance │   Color mode          [ System | Light | Dark ]                │
│   Shortcuts  │   Themes   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌ + New ┐       │
│   AI         │            │ Dark │ │Light │ │Midnt.│ │Paper │ │       │       │
│   Updates    │            └──────┘ └──────┘ └──────┘ └──────┘ └───────┘       │
│              │   Text     Interface size [13 px ▾]  Code size [13 px ▾]       │
│              │            Interface font […]        Code font […]             │
│              │            ┌ live preview ───────────────────────────┐         │
│              │ Shortcuts  …                                                   │
│              │ AI         …                                                   │
│              │ Updates    …                                                   │
└──────────────┴────────────────────────────────────────────────────────────────┘
```

- **One scrolling column with a sticky section nav.** All sections are rendered; the nav scrolls to a section and highlights the one in view. People can scan everything, Ctrl+F works, and the existing AI/shortcut controls keep their labels.
- Content column max width 760px, left nav 200px. Below 900px window width the nav collapses into a horizontal strip above the content.
- It stays a modal view for assistive technology (`role="dialog"`, `aria-modal`, labelled "Settings"): focus moves in on open, Tab stays inside, Escape and the × button close it and return focus to whatever opened it. The global shortcut handler already ignores keys typed inside a dialog, which keeps shortcut recording safe.
- Clicking the brand mark or a repository tab while Settings is open closes Settings and goes there.
- Entry points: titlebar **Settings**, `Mod+,`, and a new command palette entry **Customize appearance** that opens the page scrolled to Appearance.

### 2.2 Sections

| Section | Contents | Source |
| --- | --- | --- |
| General | Language (segmented English / 中文) | existing `shared/i18n` store |
| Appearance | Color mode, theme gallery, theme editor, text sizes and fonts, live preview | new appearance store |
| Shortcuts | Shortcut recorder, Restore defaults | unchanged |
| AI assistant | Active provider, provider list (name, API format, base URL, model, API key, max output tokens, connection test), privacy scope preview | rebuilt for multiple providers (2026-10-26) |
| Updates | Status, Check for updates, Restart to install | unchanged, shown only when the updater reports a status |

## 3. Appearance model

### 3.1 Color mode and theme slots

GitHub-style "day and night" slots, which keeps today's System / Light / Dark cycle meaningful:

```ts
interface AppearancePreferences {
  version: 1;
  mode: "system" | "light" | "dark";    // what the titlebar ◐ button cycles
  lightThemeId: string;                 // theme used whenever the resolved mode is light
  darkThemeId: string;                  // theme used whenever the resolved mode is dark
  customThemes: CustomTheme[];
  typography: Typography;
}
```

- Every theme has a `base` (`light` or `dark`). Picking a theme card puts it in the slot matching its base. If the mode is fixed to the other base, the mode switches too, so the click always shows the chosen theme. In System mode the mode is left alone.
- Each card shows a badge "Used in light mode" / "Used in dark mode" and a check on the theme that is on screen right now.
- `data-theme` on `<html>` still carries the resolved base (`light`/`dark`) for CSS and Tailwind's `dark:` variant; `data-theme-id` carries the theme id.

### 3.2 Built-in themes

| Id | Base | Notes |
| --- | --- | --- |
| `gitcrest-dark` | dark | today's dark tokens, verbatim |
| `gitcrest-light` | light | today's light tokens, verbatim |
| `midnight` | dark | near-black blue canvas, violet accent |
| `paper` | light | warm off-white canvas, green accent |

Built-ins are read-only. **Duplicate** copies one into an editable custom theme.

### 3.3 Custom themes

```ts
interface CustomTheme {
  id: string;                       // "custom-<random>"
  name: string;                     // 1–40 chars
  base: "light" | "dark";
  seeds: {                          // what the basic editor shows
    canvas: Hex; surface: Hex; text: Hex; accent: Hex;
    success: Hex; warning: Hex; danger: Hex;
  };
  overrides: Partial<Record<ThemeToken, Hex>>;   // advanced, per token
  typography?: { uiFontSize?: number; codeFontSize?: number };  // optional, overrides the global sizes
}
```

**Seeds → full palette.** A theme needs ~22 tokens; asking for all of them up front is hostile. The editor asks for 7 seeds and derives the rest in TypeScript (so contrast can be checked and exported themes are complete):

| Token | Derivation (dark base / light base) |
| --- | --- |
| `surface-raised` | surface mixed toward text 5% / toward white 70% |
| `surface-soft` | midpoint of canvas and surface |
| `line`, `line-strong` | surface mixed toward text 13% / 21% |
| `text-secondary`, `text-muted` | text mixed toward canvas 30% / 48% |
| `accent-strong` | accent toward white 16% / toward black 16% |
| `accent-soft`, `green-soft`, `danger-soft` | seed at 13% (dark) or 9% (light) alpha |
| `on-accent` | whichever of near-black or white contrasts more with the accent |
| `git-modified` / `added` / `deleted` / `renamed` | accent-strong / success / danger / warning |
| `git-untracked` / `git-ignored` | text-secondary / text-muted |
| `git-conflicted` | warning mixed with danger 35% |
| `shadow` | fixed per base |

Any derived token can be pinned in **Advanced colors**; a pinned token shows a reset button.

**Accent presets.** The accent field has eight swatches (blue, cyan, teal, green, amber, orange, rose, violet) plus a free color picker and hex field.

**Contrast check.** The editor shows live WCAG ratios and flags failures:

| Pair | Minimum |
| --- | --- |
| text on canvas, text on surface | 4.5 : 1 |
| text-muted on surface | 3 : 1 |
| on-accent on accent (primary buttons) | 4.5 : 1 |
| accent on surface (links, focus ring) | 3 : 1 |

Failures warn but don't block saving: some people deliberately want low contrast.

**Lifecycle.** New (starts from the theme on screen), Duplicate, Edit, Rename, Delete (with confirmation; slots pointing at it fall back to the built-in of the same base), Export (`<name>.gitcrest-theme.json`), Import (validated; an id clash gets a new id, a name clash gets a numeric suffix).

**Live preview while editing.** Edits apply to the whole app immediately (a draft layered on top of the saved preferences). Save commits the draft; Cancel or closing Settings throws it away and restores the saved theme. While editing, the draft is shown regardless of mode so changing a dark theme while the system is light still shows what is being edited.

### 3.4 Text

```ts
interface Typography {
  uiFontSize: number;     // 12–16, default 13 (the body size); drives every --type-* token
  codeFontSize: number;   // 11–20, default 13; diff, Monaco, logs, SHAs
  uiFontFamily: string;   // empty = default stack
  codeFontFamily: string; // empty = default stack
}
```

- The type scale in `tokens.css` becomes `calc(<base px> * var(--font-scale))` where `--font-scale = uiFontSize / 13`. `--type-2xs` keeps the 11px floor from `visual-optimization-plan.md` §4 via `max()`. The Tailwind `text-*` line heights scale the same way. Remaining literal `font-size: Npx` declarations in `globals.css` (glyphs, dialog headings) are multiplied by the same factor.
- `--code-size` = codeFontSize, `--code-leading` = round(codeFontSize × 1.54).
- A custom family is put in front of the default stack, so a missing font falls back gracefully.
- A custom theme may override the two sizes ("Use global size" by default), e.g. a presentation theme with larger text.

## 4. Architecture

```
src/features/settings/
  model/
    color.ts                hex parsing, mixing, alpha, WCAG luminance/contrast, on-accent pick
    themes.ts               token list, built-in themes, seed → palette derivation, validation
    appearance-store.ts     external store (like shared/i18n): load/migrate/validate, persist,
                            resolve mode, apply to <html>, sync across windows, draft preview
    use-appearance.ts       React hooks over the store (useAppearance, useThemePreference)
    theme-file.ts           import/export of .gitcrest-theme.json
  ui/
    SettingsPage.tsx        page shell, section nav, General/Shortcuts/AI/Updates sections
    AppearanceSettings.tsx  color mode, theme gallery, text settings, preview
    ThemeEditor.tsx         custom theme editor with contrast report
```

- **Store, not component state.** Appearance is read by the App titlebar, the Settings page, Monaco in the Diff window and the Conflict window. A module-level store with `useSyncExternalStore` (same pattern as `shared/i18n`) gives one source of truth per window.
- **Applying.** `applyAppearance()` resolves the active theme, writes every palette token and the type variables as inline custom properties on `<html>`, and sets `data-theme` / `data-theme-id`. `tokens.css` keeps the GitCrest Dark/Light values as the pre-JS fallback.
- **Startup.** `main.tsx` starts the store before the first render in every window, so there is no dark→light flash and the Diff/Conflict windows finally follow the theme (today they are always dark CSS with a light Monaco).
- **Cross-window sync.** Preferences are written to `localStorage` (`gitcrest-appearance-v1`); other windows react to the `storage` event, as locale and shortcuts already do. The OS light/dark change is followed through `matchMedia`.
- **Migration.** If the new key is missing, the old `gitcrest-theme` value seeds `mode`. Unknown or malformed data falls back field by field to defaults (bad colors are dropped, sizes are clamped, slots pointing at missing themes fall back to the built-in for that base).
- **Monaco.** The diff editor defines a `gitcrest-<hash>` theme from the active palette (background, gutter, line numbers, selection, inserted/removed backgrounds) and uses the code font size.
- **Primary button text** uses the new `--on-accent` token instead of the hard-coded `#10232c`. Custom themes pick near-black or white automatically. GitCrest Dark and Light keep `#10232c` so they look exactly as before, although on GitCrest Light's accent that is only about 3.4 : 1; switching it to white is a one-token follow-up.
- **Stacking.** Every child of `.appShell` below the titlebar sits in the content grid row (`grid-area: 2 / 1`), so the Settings view stacks on top of the current page instead of pushing it into an implicit third row.
- **Persistence location.** Device-local, like language and shortcuts. Moving preferences into the core's SQLite settings table is a later option if we add sync or multiple renderer origins.

## 5. Accessibility

- Color mode and language use radio groups (arrow keys move, one tab stop).
- Theme cards are radio buttons whose accessible name includes the theme name and its slot badge; the card actions are separate buttons.
- Every color field has a visible label, a native color picker and a hex text field (pickers alone are not keyboard friendly everywhere).
- The contrast report is text, not just color, and lives in a polite live region.
- Focus ring uses `--accent-strong`; the editor warns when a custom accent would make it hard to see (accent on surface < 3 : 1).

## 6. Testing

- Unit: color math (mix, contrast, on-accent), seed derivation reproduces sane values, validation and migration of stored data, slot selection rules, import/export round trip.
- Component: Settings page focus/escape/close behavior (existing dialog tests keep passing against the page), choosing a theme applies `data-theme-id`, editor live preview then Cancel restores, Save persists, delete falls back.
- E2E: existing settings E2E flows keep working through the "Settings" dialog role and "Close settings" button.

## 7. Later

- Density (Compact / Default / Comfortable) in Appearance, per `visual-optimization-plan.md` §6.
- Graph lane palette per theme once the lane colors become tokens.
- Theme gallery import from a URL; theme sharing.
- Syncing preferences through the core.
