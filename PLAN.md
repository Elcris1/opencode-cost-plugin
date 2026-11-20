# PLAN — `opencode-model-costs` (OpenCode V2 plugin)

Show the **cost information of the models declared in `opencode.json`** inside the OpenCode TUI:

1. A `/model-costs` palette + slash command that opens a dialog listing every declared model with its
   per-million-token prices — and **switches the current session to the chosen model on Enter**.
2. A persistent **prompt-footer slot** showing the *current* model's input/output rates, updating live
   when the model changes.

Read-only with respect to configuration: the plugin never edits `opencode.json`; switching a model is
session-scoped (identical semantics to the built-in `/models`).

---

## 1. Location & load strategy

```
C:\projectsia\opencode-model-costs\
├── PLAN.md          # this file
├── package.json
├── tsconfig.json    # editor support only; OpenCode runs the TS directly
└── src\
    ├── index.ts     # server part  (Plugin.define — makes the package a complete plugin)
    ├── costs.ts     # shared logic: fetch config, merge, normalize, format
    └── tui.tsx      # TUI part: command + footer slot (JSX)
```

- Lives **outside** any project, as requested (`C:\projectsia\`).
- Loaded via a `plugins` entry (absolute path) in either a project `opencode.json(c)` or the global
  `~/.config/opencode/opencode.json(c)` — see §8. A local plugin *directory* under `.opencode/plugins/`
  would auto-load but would tie the plugin to one project; the standalone package + config entry matches
  the "include globally" requirement.
- The package has a **server part** (even though it is minimal) so the single `plugins` entry loads both
  parts. (A TUI-only package would have to be registered in `cli.json` instead — avoided on purpose.)

## 2. Data source (verified against the published OpenAPI + config schema)

**`GET /api/config`** — "Return configuration documents and discovery sources for the requested location,
from lowest to highest priority."

Response: `Array<Config.Entry>` where each entry is

```jsonc
{ "type": "document", "path": "<absolute path>", "info": Config.InfoEncoded }  // user-authored config
{ "type": "directory", "path": "<absolute path>" }                             // skip (no config content)
```

`Config.InfoEncoded` is the full document content, including:

- `providers: Record<providerID, Config.ProviderEncoded>` with
  `models: Record<modelID, Config.ModelEncoded>`
- `model` — default selector, string `"provider/model"` or expanded `{ providerID, model, variant? }`

**`Config.ModelEncoded.cost`** (the field this plugin displays):

```jsonc
"cost": Config.Model.CostEncoded | Config.Model.CostEncoded[]
// CostEncoded = {
//   "tier"?: { "type": "context", "size": number },  // tiered pricing above a context threshold
//   "input":  number,        // USD per million tokens  (required)
//   "output": number,        // USD per million tokens  (required)
//   "cache"?: { "read"?: number, "write"?: number }   // USD per million tokens
// }
```

Everything is already JSONC-parsed with `{env:}`/`{file:}` substitutions resolved and config precedence
(global → project → `.opencode`, system last) applied by the server — the plugin must **not** read config
files itself.

**Switch endpoint:** `POST /api/session/{sessionID}/model` — body `{ "model": Model.Ref }`, where
`Model.Ref = { "providerID": string, "id": string, "variant"?: string }` (note: the model field is **`id`**,
not `modelID`). Response is a `model-switched` message carrying `model` and `previous`.

## 3. `package.json`

```jsonc
{
  "name": "opencode-model-costs",
  "version": "0.1.0",
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./tui": "./src/tui.tsx"
  },
  "files": ["src"],
  "dependencies": {
    "@opencode/plugin": "latest"
  },
  "peerDependencies": {
    "@opentui/core": ">=0.6.6",
    "@opentui/solid": ">=0.6.6",
    "solid-js": ">=1.9.0"
  }
}
```

Then run `npm install` (or `bun install`) **inside the plugin folder** so peers are resolvable locally;
OpenCode resolves `@opencode/plugin` and `@opencode/plugin/tui` itself at runtime, but JSX peers are the
plugin's own responsibility.

## 4. `src/costs.ts` — data layer (no UI imports)

```ts
// ---- types (mirror of the verified API shapes) ----
export interface CostTier { tier?: { type: "context"; size: number }; input: number; output: number;
  cache?: { read?: number; write?: number } }
export interface ModelRow {
  providerID: string; providerName: string; modelID: string; modelName?: string;
  tiers: CostTier[];                 // empty => "not set (catalog default)"
  contextLimit?: number;             // limit.context, for display
  isDefault: boolean;                // matches the merged config `model`
  sourcePath?: string;               // config document path that last defined this model
}
```

- `fetchConfigRows(client)`:
  1. `GET /api/config` through the passed client (same generated client used by TUI/server parts).
  2. Iterate entries **in order** (lowest → highest priority). Skip `type !== "document"`.
  3. For each document: walk `info.providers` → for each `providerID`, record provider display `name`
     (falls back to the providerID) → walk `models` → upsert `rows[key = providerID + "/" + modelID]`
     (later documents override earlier ones, matching OpenCode's merge order) and remember `sourcePath`.
  4. Track the last-seen `info.model` → merged default selector; normalize the string form
     (`provider/model`, strip any `#variant`) or the expanded object form into `(providerID, modelID)`,
     then mark matching rows `isDefault`.
  5. `normalizeCost(cost)`: `!cost → []`; `Array.isArray(cost) ? cost : [cost]`; tolerate missing
     `cache` and missing `tier`.
- Formatting helpers:
  - `fmtMoney(n)`: `n >= 1 → "$" + n.toFixed(2)`; `n < 1 → "$" + String(n)` (trailing-zero trimmed, so
    `0.3 → "$0.3"`); `0 → "$0"`.
  - `fmtRates(tier)`: `"$3 in · $15 out /Mtok"`; append ` · cache $0.3 rd / $3.75 wr` when present;
    append ` · over 200k ctx` when `tier` is set.
  - `fmtCtx(limit)`: `"ctx 200k"` when `limit?.context` present.
- Export `describeRow(row)` producing the dialog title/description strings (§6), and `findRow(rows, providerID, modelID)` for the footer slot.

## 5. `src/index.ts` — server part

```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "opencode-model-costs",
  setup() {
    // No server-side behavior needed: the TUI part reads /api/config through its own client.
    // Kept so the package is a full plugin (server part defines the id; TUI part auto-loads with it).
  },
})
```

## 6. `src/tui.tsx` — TUI part

```tsx
import { Plugin, usePlugin } from "@opencode/plugin/tui"
```

### 6.1 Command — `/model-costs`

Registered in `setup` via a keymap layer:

```ts
context.keymap.layer(() => ({
  mode: "global",
  commands: [{
    id: "opencode-model-costs.show",
    title: "Show model costs",
    group: "Model",
    palette: true,
    slash: { name: "model-costs" },
    // no default keybind — avoid conflicts; palette + slash are enough
    run: () => showCostsDialog(),
  }],
}))
```

`showCostsDialog()` flow:

1. `const rows = await fetchConfigRows(context.client)` — fresh on every invocation, so config edits and
   `/reload` are reflected without restarting.
2. `rows.length === 0` → `context.ui.toast.show({ message: "No providers/models declared in opencode.json", variant: "warning" })` and stop.
3. Build options (one per row):
   - `category`: provider display name (groups the list like `/models` does).
   - `title`: `"provider/model"` + (`"  ★ default"` when `isDefault`).
   - `description`: `fmtRates(firstTier)` or `"cost not set (catalog default)"`; if the row has more than
     one tier append `" +N tiers"`.
   - `value`: the `ModelRow`.
   - Pass a `search` function matching against providerID, providerName, modelID and modelName so the
     built-in filtering behaves like the model picker.
4. `const picked = await context.ui.dialog.select({ title: "Model costs — from opencode.json", options, actions })`
   - `actions`: `{ bind: "ctrl+d", title: "Tier detail", onTrigger: (row) => toast with every tier of
     row.tiers formatted line by line }` (only useful for tiered models).
   - Escape / `clear()` → resolves `undefined` → nothing happens.
5. On a picked row: resolve the active session (§6.3).
   - **Session found** → switch: `POST /api/session/{sessionID}/model` with
     `{ model: { providerID: row.providerID, id: row.modelID } }` through `context.client` (see §7 for the
     exact generated-client method). Success → `toast "Switched to <providerID>/<modelID>"` (variant
     `"success"`); failure → `toast` with the server error (variant `"error"`).
   - **No session** → `toast "No active session — cost browser only (open a session to switch models)"`.
6. The dialog closes itself on Enter (documented behavior); the footer slot updates on its own (§6.2).

### 6.2 Footer slot — current model rates

```tsx
context.ui.slot({
  append: "prompt.footer.status",
  render: (slot) => <CostBadge sessionID={slot.sessionID} />,
})

function CostBadge(props: { sessionID?: string }) {
  const context = usePlugin()
  const selected = context.ui.model.current()   // reactive when read in a Solid computation
  // remember the session for the command's switch fallback (§6.3)
  trackSession(props.sessionID)
  const row = selected && findRow(rows(), selected.providerID, selected.modelID)
  if (!row || row.tiers.length === 0) return null
  return <text fg={context.theme.text.muted}>{fmtRates(currentTier(row, selected.variant))}</text>
}
```

- `rows()` is a module-level reactive signal refreshed by `fetchConfigRows` on plugin setup and on
  `context.data.on("config.updated", ...)` (server event) — so edits to `opencode.json` refresh the badge.
- `currentTier`: single-tier rows → tier 0; multi-tier rows → the tier whose `tier.size` fits the session
  context if determinable, else tier 0; append `"+N"` marker when more tiers exist.
- Renders **nothing** when the current model is not declared in config or has no cost — the footer stays
  clean for catalog models.
- Exact theme token (`theme.text.muted`) to be confirmed against the runtime type; fall back to no `fg`.
- Optional second contribution to `sidebar.footer` behind a plugin option (`"slot": ["prompt", "sidebar"]`,
  default `"prompt"`).

### 6.3 Resolving the active `sessionID`

Command handlers don't receive `sessionID`, so resolve in this order:

1. `context.ui.router.current()` — when the route is a session route, take its `sessionID` (verify the
   payload shape against the runtime types; docs document `current()` but not its payload).
2. Fallback: the last `sessionID` seen by the footer slot render (module-level variable, `trackSession`).
3. Otherwise `undefined` → read-only mode (step 5 of §6.1).

Only order (1)/(2) matter in practice: the switch is exactly what a user in a session tab wants.

## 7. Generated-client call for the switch

`context.client` is the generated OpenCode client built from the same OpenAPI as
`POST /api/session/{sessionID}/model`. Implementation order:

1. Look up the typed method in the installed `@opencode/client` typings (likely under
   `client.session.model.*` — e.g. a `select`/`switch` style method taking `{ sessionID, model }`).
2. If no typed method is exposed, use the client's low-level request escape hatch with
   `POST /session/{sessionID}/model` and the JSON body above.
3. Do **not** hand-roll a `fetch` with a discovered port — discovery/auth belong to the client.

Contract reminder: `Model.Ref` field is `id` (`{ providerID, id, variant? }`), and the response message
carries `model` + `previous` (useful for the success toast).

## 8. Enabling it

Project-local (test first, e.g. in the Hiberdesk harness):

```jsonc title="harness/opencode.json"
{
  "plugins": ["C:/projectsia/opencode-model-costs"]
}
```

Global — every project on this machine (`%USERPROFILE%\.config\opencode\opencode.json`):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["C:/projectsia/opencode-model-costs"]
}
```

- Absolute-path and `file:///C:/projectsia/opencode-model-costs` entries are both documented forms; if the
  plain Windows path misbehaves, switch to the `file:///` URL.
- Config changes apply without a restart; `/reload` forces a full reload. After editing the plugin's own
  code, `/reload` re-runs both parts.
- Portable alternative for other machines: publish to npm and replace the path with the package name.

## 9. Edge cases (all handled in `costs.ts` / `tui.tsx`)

| Case | Behavior |
| --- | --- |
| `cost` missing on a declared model | Row shown with `"cost not set (catalog default)"`; switching still allowed |
| `cost` is a single object vs array | Normalized to a tier array (single → one tier, no `tier` marker) |
| `cache.read` / `cache.write` absent | Omitted from the rates string (no `"undefined"`) |
| Tiered pricing (`tier.size`) | Title shows the first tier; `ctrl+d` lists every tier; `over Nk ctx` marker |
| Provider entry without `name` | Category falls back to the providerID |
| Default model references a catalog model not declared in `providers` | No row is starred (nothing to highlight) |
| Zero providers declared | Command toasts an explanatory warning, no dialog |
| Model switch rejected (provider inactive, model unavailable) | Error toast with the server's message; dialog already closed |
| Plugin unloads/reloads | Keymap layer, slot and event subscription are cleaned up via the returned cleanup function |

## 10. Verification checklist

1. `opencode api get /api/config` — confirm the document list and `providers.*.models.*.cost` shapes on
   this machine before wiring the parser.
2. Enable the plugin in one project config → start `opencode` → check the server log
   (`~/.local/share/opencode/log/opencode.log`, `role=server`) for plugin load errors.
3. `/model-costs`: rows match the config (provider grouping, names, ★ on the default, "not set" rows).
4. Enter on a row → toast confirms, prompt model changes, footer badge switches to the new rates.
5. Escape → no switch. `ctrl+d` on a tiered model → per-tier toast.
6. Footer badge: absent for catalog-only models, present for configured ones, live-updates on switch.
7. Edit `opencode.json` (add/remove a model) → re-run `/model-costs` without restart → list updated.
8. Home screen invocation → read-only toast. Project with no providers → warning toast.
9. Global install (§8) → same behavior in an unrelated project.

## 11. Explicit non-goals / future work

- Never writes `opencode.json` (changing the *default* model is out of scope; switching is session-scoped).
- Does not merge effective prices from the models.dev catalog (per scope decision: config costs only,
  `"not set (catalog default)"` otherwise).
- Possible follow-ups: sidebar slot by default, an agent-callable `model_costs` server tool, sorting/
  filtering options, npm publish.

## 12. Implementation notes (as built)

Deltas discovered while implementing, verified against the live npm package `@opencode/plugin@2.3.2`
(V2 line) and its generated client:

- **Data source refined.** `GET /api/config` is still used (documents, lowest → highest priority) but the
  primary row source is now **`client.config.providers()`** ("List config providers"), which returns the
  configured providers with their model catalogs: merged costs (config overrides on top of catalog
  defaults, including `cost.tiers[]` and `experimentalOver200K`), provider display names, and a
  `default` model map. `/api/config` documents supply the *authoring* facts: which providers/models are
  declared in opencode.json(c), which `cost` values were explicitly set, and the configured default.
- **Scope refinement.** When at least one provider is authored in config, only declared models are
  listed (strict scope, per the original decision), each marked `· set in config` or `· catalog price`.
  When nothing is authored in config, the configured providers are listed instead so `/connect`-only
  setups still get cost visibility.
- **Switch call confirmed.** OpenAPI operation id `session.switchModel` → typed client call
  `client.session.switchModel({ sessionID, model: { providerID, id } })`, with a raw hey-api client
  fallback (`POST /api/session/{sessionID}/model`, then the prefix-less variant).
- **Session ID resolution.** `ui.router.current()` in V2 returns `{ type: "session", sessionID }` (the
  implementation reads both `type === "session"` and the transitional `name === "session"` shapes); the
  footer slot's `sessionID` input is the fallback; otherwise read-only mode.
- **TUI API confirmed against 2.3.2 types**: `Plugin.define`, `keymap.layer` (command `id/title/group/
  palette/slash/run`), `ui.dialog.select<Value>` with `search` + footer `actions` (Enter resolves the
  value, actions do not close), `ui.slot(claim) → () => void` unregister, `ui.model.current()` reactive
  as `{ providerID, modelID, variant? }`, `data.on(type) → () => void`.
- **Peer versions** aligned to the published SDK: `@opentui/core` / `@opentui/solid` `>=0.8.4`,
  `solid-js` `>=1.9.0`.
- **Compatibility note.** This machine had OpenCode `1.15.12` (V1 line, `@opencode-ai/plugin`), which
  predates the V2 plugin contract (V1 object entrypoints supported from `1.18.29+`; V2 plugins need the
  2.x line, current SDK `@opencode/plugin@2.3.2`). The plugin targets V2 exclusively; run OpenCode 2.x
  to load it. The machine has since been upgraded to `2.3.2`.
- **V1-shaped config compatibility.** The machine's global `opencode.json` authors models under the
  deprecated V1 `provider` key with the V1 cost shape (flat `cache_read` / `cache_write`,
  `context_over_200k`). The authoring walker accepts both `providers` (V2) and `provider` (V1), and cost
  normalization accepts flat cache fields plus `context_over_200k` as a 200k context tier, so costs are
  marked `· set in config` correctly for V1-authored configs.
- **Command named `/models-cost`.** The only slash name is `/models-cost` — no aliases.
- **Model switching on Enter.** The dialog switches the current session to the picked model
  (`switchSessionModel` → `POST /api/session/{sessionID}/model`), with success/failure toasts; Escape
  closes without switching, and invocations without an active session fall back to read-only with an
  explanatory toast.
- **Four prices everywhere.** Both the dialog rows and the footer badge always show the four
  per-million-token rates with full labels (`in $6 · out $22 · cache read $0.55 · cache write $5.5`);
  absent cache prices render as `$0`.
- **Two-line rows, nothing clipped.** Dialog rows show "in … · out …" beside the model and "cache read
  … · cache write …" on the row's full-width `details` line (never clipped by the title), followed by
  the meta line and every extra tier in full. The ctrl+d toast was removed — it rendered behind the
  dialog and was unreadable; its information now lives in the rows.
- **Grouped by provider, no duplicate provider label.** The plugin passes no `search` callback, which
  keeps the dialog out of flattened mode: the provider renders once as a section header instead of
  right-aligned on every row, and the host's built-in fuzzy filter (title + category + searchText)
  handles search.
- **Widest modal.** `dialog.select` opens at the host default "medium" (its `replace()` resets size),
  so the plugin calls `dialog.set({ size: "xlarge" })` right after the dialog opens — xlarge (116
  columns) is the largest size the host offers. The unit note lives in the dialog title ("Model costs
  — $/Mtok · Enter switches").
- **Badge without a session.** The prompt-footer badge renders beside the agent/model info from
  startup: when no model is routed yet (no session started), it falls back to the configured default
  model's prices and switches with the session's model once one exists.
- **Table dialog (0.4.0).** `/models-cost` now opens a custom modal via `ui.dialog.show(render, onClose)`
  instead of `dialog.select`. The list is a monospace table built from plain padded `<text>` rows —
  the same primitives as the footer badge: provider section rows, right-aligned money columns
  (in / out / read / write), a context-limit column, a dim sub-row per extra pricing tier, and row
  markers (▶ cursor, ★ configured default, ● current session model). An earlier iteration used
  @opentui/core's `TextTableRenderable` registered as a `<table>` JSX element, but its layout inside
  the host's fixed-size dialog chrome rendered unreliably; manually padded rows give exact control
  over column widths and the modal's content size. Keys are read with `useKeyboard`
  (renderer-level events: up/down/j/k, home/end, pageup/pagedown, enter switches, escape/q closes) —
  an earlier keymap-layer approach (a layer bound to a pushed exclusive mode) did not deliver keys on
  this host; the exclusive mode push is kept so host bindings don't act on dialog keys. The dialog's
  JSX is produced lazily by the `render()` callback as a component (`CostsTable`) so it mounts inside
  the host's reactive/render context — pre-creating elements outside it (e.g. in `createRoot` at
  command time) mounts nothing, because the renderables never receive a parent/context. The cursor
  state lives in plain signals outside the component (shared with the key handlers); the current
  model comes in as a reactive accessor prop (no `usePlugin` — the host may not wrap dialogs in the
  plugin context). Hosts without `ui.dialog.show` (or any error while opening the custom dialog) fall
  back to the previous select-based dialog. The content block is centered horizontally in the dialog
  (the outer box is full-width with `alignItems="center"` wrapping the fixed-width table block, so
  columns stay aligned) with left/bottom padding insets. The data layer is unchanged: costs still come from the
  opencode.json(c) config documents.
- **Type-to-filter (post-0.4.0).** The table dialog now accepts typing: the search row is a real
  focused input — the host's `InputRenderable` via the `<input>` JSX element, same as the built-in
  model picker — so it gets the native full-cell blinking block cursor (`cursorStyle: { style:
  "block", blinking: true }`, the TUI default; the caret is the form-field focused color) and a true
  dim **"Search models"** placeholder. Typing/backspace/caret movement are handled by the input
  itself; `onInput` narrows the list in place (`filterLines` — substring, case-insensitive, over
  modelID/modelName/providerID/providerName, keeping provider sections and tier sub-rows of the
  matches). The renderer-level `useKeyboard` handles only navigation now and calls `preventDefault()`
  so the focused input ignores those keys: up/down + home/end + pageup/pagedown move, enter switches,
  escape clears the query (also resetting the input's value) then closes. The previous `j`/`k`-move,
  `q`-close and manual caret-handling shortcuts were dropped. The match count sits right-aligned on
  the search row ("`N of M`" while filtering, "`N model(s)`" otherwise), and a "no matching models"
  placeholder fills the list when nothing matches. Hosts without `ui.dialog.show` keep the built-in
  select fallback, which filters through its own `searchText` field.
- **Model switch applies pre-prompt (bug fix).** The TUI client only applies the server's
  `session.model.selected` event when the session's info row is already in its local store
  (packages/client/src/solid/data.ts guards `if (store.session.info[sessionID])`). For a session
  that has not been prompted yet that row can be missing on the client, so the switch event was
  dropped and the composer/badge kept the old model — the switch appeared to do nothing until the
  first prompt loaded the session. After `POST /session/{id}/model` succeeds, the plugin now
  invalidates and re-syncs that session through the SDK (`context.data.session.invalidate/sync`) so
  the durable model lands in the store and the picker, badge and effort dialog all follow it.
- **Effort dialog after switching (post-0.4.0).** After a successful switch the plugin offers the
  model's reasoning-effort levels — its variants, the same list the built-in picker's variant dialog
  shows — through `context.ui.model.variant.list()`, presented in a `dialog.select` with a Default
  entry (Escape keeps the current effort); picking one calls `ui.model.variant.set`, which the host
  persists like the built-in flow. The dialog is skipped when the host exposes no variant API, the
  model has no variants, or the model pick failed to apply.


## 13. Integration and pilot changes

The price browser now opens details on Enter. Switching is a separate action available only
when the session that opened the browser is still active. The router is the source of session
identity. The footer is opt-in via `options.footer` on the CLI plugin entry, uses the native
status slot, and shows base input and output rates only. The command chooses the native picker when the table does not fit.

Rates retain missing values and identify config overrides or catalog rates in details. The
loader checks config declarations before deciding whether to show the wider configured catalog.
OpenCode 2.3.2 supplies catalog data through `client.model.list()` and `client.provider.list()`;
the earlier `client.config.providers()` shape remains supported. Server-normalized model
metadata supplies display names and limits. Authored cost shapes preserve omitted cache fields
that the server may otherwise fill with zero.

The root `opencode.json` is a local integration fixture with synthetic prices and a loopback
endpoint. The package allowlist excludes the fixture. The release checklist and team pilot scope
are in `REVIEW_AND_RELEASE_PLAN.md`.
