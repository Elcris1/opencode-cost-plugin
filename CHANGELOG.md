# Changelog

All notable changes to `opencode-model-costs` per released version, newest first.
On every version bump, add an entry here at the top.

## 0.4.0 — 2026-11-18

- `/models-cost` now renders as a monospace table in a custom modal (`ui.dialog.show`, built from
  plain padded text rows): right-aligned column headers (in / out / cache read / cache write / ctx)
  over a rule line, provider section rows separated by blank lines, right-aligned money columns, a
  context-limit column (dropped when no model has one), and dim sub-rows for extra pricing tiers.
- Row markers: ▶ cursor, ★ configured default, ● current session model.
- Keyboard control via renderer-level key events while the dialog is open (host bindings are
  paused with an exclusive input mode): up/down (j/k) move, pageup/pagedown page, home/end jump,
  enter switches the session model, escape/q closes; lists longer than 18 rows scroll in a sliding
  window that follows the cursor.
- Hosts without `ui.dialog.show` (or errors while opening the custom dialog) fall back to the
  previous built-in select list. The content block is centered horizontally in the dialog with
  left/bottom padding insets. Data layer unchanged — costs still come from opencode.json(c).

## 0.3.4 — 2026-11-18

- Added a README explaining what the plugin does, how to enable it, and the `cost` config shape; added a `CHANGELOG.md` and agent-facing `AGENTS.md`.
- The npm package now ships `CHANGELOG.md` instead of `PLAN.md` (no code changes).

## 0.3.3 — 2026-11-18

- Prompt badge is now a single line ("in … · out … · cache read … · cache write") on the row directly under the prompt's status row, replacing the two-row badge beside the agent/model info.
- The badge aligns with the prompt box's left edge on every route — the offset is tracked against the footer row instead of terminal column 0, so it stays visible in sessions where the tab rail and route padding sit left of the prompt.

## 0.3.2 — 2026-11-18

- The dialog resizes itself to the smallest host size that fits the widest rendered line (medium/large/xlarge auto-fit) instead of always opening at xlarge.

## 0.3.1 — 2026-11-18

- All four prices on the dialog row line; the config-provenance label was dropped from the meta line.
- Prompt badge split into two rows (in/out over cache read/write).

## 0.3.0 — 2026-11-18

- Two-line prices (in/out + cache read/write) on unclipped detail lines.
- Provider sections grouped without the duplicate provider label on every row.
- xlarge modal applied after open; removed the hidden ctrl+d tier toast.

## 0.2.0 — 2026-11-18

- Command renamed to `/models-cost`; xlarge modal; full-width row details.
- Badge shows beside the provider from startup, falling back to the configured default model when no session has started.

## 0.1.1 — 2026-11-18

- Aliases `cost`/`models-cost`; dialog rows no longer truncate (prices in description, meta in right-aligned footer).

## 0.1.0 — 2026-11-18

- First release: `/model-cost` command (palette + slash, aliases) with model switching on Enter, and a four-price prompt-footer badge.
