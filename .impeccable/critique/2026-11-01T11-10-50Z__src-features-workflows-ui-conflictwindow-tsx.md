---
target: conflict resolution window
total_score: 25
max_score: 40
na_heuristics:
p0_count: 0
p1_count: 1
target_identity: "file:E:\\personal_projects\\GitCrest\\src\\features\\workflows\\ui\\ConflictWindow.tsx"
target_fingerprint: "sha256:6a8817c4a51a0d5c2a1a89eb2180a58890dd62daba2cd2cd838daab9a1f30d0e"
target_path: "E:\\personal_projects\\GitCrest\\src\\features\\workflows\\ui\\ConflictWindow.tsx"
timestamp: 2026-11-01T11-10-50Z
slug: src-features-workflows-ui-conflictwindow-tsx
---
Method: dual-agent (A: /root/design_review · B: /root/detector_review)

The conflict resolver has a coherent, attractive Git workbench identity, but needs a simpler workflow. Design health: 25/40. Preserve the neutral palette and source comparison; prioritize the real result and completion actions.

| Heuristic | Score /4 | Key issue |
|---|---:|---|
| System status | 3 | Completion feedback is distant |
| Real-world match | 3 | Multiple meanings of Result |
| User control | 3 | Whole-file replacement is too immediate |
| Consistency | 3 | Preview differs from editable result |
| Error prevention | 2 | Inconsistent overwrite protection |
| Recognition over recall | 2 | Actual draft is below the fold |
| Efficiency | 2 | Accepting a block loses keyboard focus |
| Minimalist design | 2 | Blank preview and competing action scopes |
| Error recovery | 3 | Undo and preserved drafts help |
| Help | 2 | Task Center handoff lacks a direct action |
| Total | 25/40 | Acceptable; significant workflow improvements needed |

Strengths: readable source comparisons and token highlights; local drafts, undo and close protection; coherent restrained light/dark styling.

Priority issues:
1. [P1] Core actions fall below the viewport. At 960x700, the closed Result Preview still occupies 190px and the save footer starts around y932. Remove the closed disclosure minimum height and keep completion actions outside scrolling content. Evidence: src/styles/globals.css:699; ConflictWindow.tsx:450. Commands: layout, distill.
2. [P2] Three result representations compete. The middle column explicitly says base or Smart Merge preview, yet its Result heading still competes with Result Preview and Edit Working Result. Label it Base or Suggested merge, and reserve Result for the editable output. Evidence: ConflictWindow.tsx:426,450,454. Command: clarify.
3. [P2] Action scopes compete. Local acceptance, ignore, non-conflicting reconstruction, entire-file replacement, Smart Merge and AI merge add decisions. Move whole-file actions to a secondary menu and protect draft replacement consistently. Evidence: ConflictWindow.tsx:274,311,393. Command: distill.
4. [P2] Keyboard continuity breaks. Accepting a focused block removes it and leaves activeElement=BODY. Focus the next block, or the result/save action after the last block. Evidence: ConflictWindow.tsx:261; ConflictBlockRow.tsx:41. Command: harden.
5. [P2] Completion lacks a direct handoff. Copy instructs returning to Task Center, but no button takes users there. Add a completion state with Return to Task Center targeting the existing task. Source-qualified, not exercised live. Evidence: ConflictWindow.tsx:378; conflicts.ts:13,32. Command: clarify.

Cognitive load: the current block has five local choices, six when Smart Merge applies, plus file-level actions. A single current-conflict decision and one visible real output would reduce recall and navigation. Emotional journey starts reassuringly, loses clarity around preview/edit/save, then adds a window handoff at completion.

Persona red flags: first-timers must distinguish several Result surfaces and action scopes; keyboard users lose focus after acceptance; compact-laptop users scroll past empty space to finish.

Minor observations: 26px gutter controls are small but exceed the basic 24px target dimension; metadata consumes heading space; Mark resolved is enabled while markers remain, with backend behavior not tested. Source detector returned zero findings across three TSX files. Live detector returned five findings: three low-contrast (line numbers 3.6:1 on both source backgrounds and Mark resolved 4.3:1), tiny metadata text at 11px, and Inter prevalence. The font warning is not a usability defect; 11px metadata is advisory. Live scan returned exit 1 despite usable JSON. Improve text tokens and use on-accent for action text.

Questions to consider: Can both sources and the real output stay visible with one clear conflict decision? Should whole-file replacement remain a secondary action?
