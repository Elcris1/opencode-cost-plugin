import { Plugin } from "@opencode/plugin/tui"
import { BoxRenderable, CliRenderEvents, InputRenderable, type KeyEvent } from "@opentui/core"
import { Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { useKeyboard } from "@opentui/solid"
import {
  type CostData,
  type CostTier,
  type ModelRow,
  fetchCostData,
  findRow,
  fitDialogSize,
  fmtBadge,
  fmtK,
  fmtMoney,
  fmtRow,
  fmtRowDetails,
  switchSessionModel,
} from "./costs"

/**
 * TUI part of opencode-model-costs.
 *
 * - `/models-cost` (palette + slash, the only name): a custom modal
 *   (`ui.dialog.show`) rendering the model list as a monospace table built
 *   from plain text rows (the same primitives as the footer badge): provider
 *   section rows, one row per model with right-aligned money columns
 *   ("in / out / read / write", $/Mtok), the context limit, and a dim
 *   sub-row per extra pricing tier. Row markers: ▶ cursor, ★ configured
 *   default, ● current session model. Keys are read with `useKeyboard`
 *   (renderer-level events, no keymap-bind parsing): typing filters the list
 *   in place through a focused search input (the same `InputRenderable` the
 *   host's picker uses — native full-cell block cursor + "Search models"
 *   placeholder), up/down (home/end, pageup/pagedown) move, enter switches the
 *   session model, escape clears the filter then closes. An exclusive keymap
 *   mode is pushed while the dialog is open so host bindings don't act on keys
 *   meant for the dialog. Hosts without `ui.dialog.show` fall back to the
 *   built-in `dialog.select` list.
 * - On Enter the active session is switched to the picked model; the session's
 *   info is re-synced afterwards so the change applies even for a session that
 *   has not been prompted yet, then the model's reasoning-effort options (its
 *   variants) are offered in a follow-up select dialog.
 * - Prompt-footer badge: the four prices on one line on the row directly
 *   under the prompt's status row, aligned with the prompt box's left edge.
 *   Shown from startup (falling back to the configured default model when
 *   no session has started) and updating live when the model changes.
 */

// ---------------------------------------------------------------------------
// Table dialog — line model
// ---------------------------------------------------------------------------

/** Two-plus spaces between columns; money columns are right-aligned. */
const GAP = "   "
/** Rows visible in the dialog's list before it scrolls. */
const MAX_VIEWPORT_ROWS = 18

/** One display line of the dialog list. */
type LineData =
  | { kind: "header" }
  | { kind: "rule" }
  | { kind: "spacer" }
  | { kind: "provider"; name: string }
  | { kind: "model"; row: ModelRow }
  | { kind: "tier"; row: ModelRow; tier: CostTier; index: number }

interface ColumnWidths {
  model: number
  money: [number, number, number, number]
  /** 0 when no line has a context value — the column is dropped then. */
  ctx: number
  /** Full rendered line width, including gaps (the header rule's length). */
  total: number
}

/** The row supports more fields than the published type lists; optional access keeps older hosts happy. */
type CurrentModel = { providerID?: string; modelID?: string }

interface Palette {
  muted?: string
  accent?: string
  /** Search-input caret color (theme form-field focused text). */
  cursor?: string
  /** Focused search-input background (theme form-field focused background). */
  inputBg?: string
  /** Focused search-input text (theme form-field base text). */
  inputText?: string
}

const MONEY_HEADERS: [string, string, string, string] = ["in", "out", "read", "write"]
const MONEY_BLANKS: [string, string, string, string] = ["", "", "", ""]

/** The four money cells of a line: rates for models ("—" when not set), blanks for every other line. */
function moneyFor(line: LineData): [string, string, string, string] {
  if (line.kind === "model") return moneyValues(line.row.tiers[0])
  if (line.kind === "tier") return moneyValues(line.tier)
  return MONEY_BLANKS
}

/** "in $6 · out $22 · cache read $0.55 · cache write $5.5" as four column values ("—" when absent). */
function moneyValues(tier: CostTier | undefined): [string, string, string, string] {
  if (!tier) return ["—", "—", "—", "—"]
  return [fmtMoney(tier.input), fmtMoney(tier.output), fmtMoney(tier.cache?.read ?? 0), fmtMoney(tier.cache?.write ?? 0)]
}

/** The model-column text of a line. */
function modelCell(line: LineData): string {
  if (line.kind === "header") return "model"
  if (line.kind === "provider") return line.name
  if (line.kind === "tier") {
    const size = line.tier.tier?.size
    return size && size > 0 ? `↳ over ${fmtK(size)} ctx` : `↳ tier ${line.index + 1}`
  }
  if (line.kind === "model") return line.row.modelID
  return ""
}

/** The ctx-column text of a line (context limit of base model rows only). */
function ctxCell(line: LineData): string {
  if (line.kind !== "model") return ""
  return line.row.contextLimit && line.row.contextLimit > 0 ? fmtK(line.row.contextLimit) : ""
}

/** Provider section rows + model rows + extra-tier sub-rows, in dialog order. */
function buildLines(rows: readonly ModelRow[]): LineData[] {
  const lines: LineData[] = [{ kind: "header" }, { kind: "rule" }, { kind: "spacer" }]
  let lastProvider: string | undefined
  for (const row of rows) {
    if (row.providerName !== lastProvider) {
      if (lastProvider !== undefined) lines.push({ kind: "spacer" })
      lines.push({ kind: "provider", name: row.providerName })
      lastProvider = row.providerName
    }
    lines.push({ kind: "model", row })
    lines.push(...tierLines(row))
  }
  return lines
}

/** Column widths fitted to the longest cell of each column (headers included). */
function computeWidths(lines: readonly LineData[]): ColumnWidths {
  const money: [number, number, number, number] = MONEY_HEADERS.map((header) => header.length) as [
    number,
    number,
    number,
    number,
  ]
  let model = "model".length
  let ctx = "ctx".length
  let ctxUsed = false
  for (const line of lines) {
    model = Math.max(model, modelCell(line).length)
    for (const [index, value] of moneyFor(line).entries()) money[index] = Math.max(money[index], value.length)
    const cell = ctxCell(line)
    if (cell) {
      ctx = Math.max(ctx, cell.length)
      ctxUsed = true
    }
  }
  // No line carries a context value — the column is dropped to save width.
  if (!ctxUsed) ctx = 0
  const total =
    2 + model + money.reduce((sum, width) => sum + GAP.length + width, 0) + (ctx > 0 ? GAP.length + ctx : 0)
  return { model, money, ctx, total }
}

/** Extra pricing tiers of a model as sub-lines. */
function tierLines(row: ModelRow): LineData[] {
  return row.tiers
    .slice(1)
    .map((tier, index) => ({ kind: "tier" as const, row, tier, index: index + 1 }))
}

/**
 * The padded text of one line. `selected` highlights the model line and its
 * tier sub-lines; `current` marks the session's active model.
 */
function lineText(
  line: LineData,
  widths: ColumnWidths,
  state: { selected: boolean; current: CurrentModel | undefined },
): string {
  if (line.kind === "rule") return "─".repeat(widths.total)
  if (line.kind === "spacer") return ""

  const isHeader = line.kind === "header"
  const marker =
    line.kind === "model"
      ? state.selected
        ? "▶"
        : line.row.isDefault
          ? "★"
          : isCurrent(line.row, state.current)
            ? "●"
            : " "
      : line.kind === "tier"
        ? state.selected
          ? "▶"
          : " "
        : " "
  const cells = [`${marker} ${modelCell(line).padEnd(widths.model)}`]
  const money = isHeader ? MONEY_HEADERS : moneyFor(line)
  for (const [index, value] of money.entries()) cells.push(GAP + value.padStart(widths.money[index]))
  if (widths.ctx > 0) cells.push(GAP + (isHeader ? "ctx" : ctxCell(line)).padStart(widths.ctx))
  return cells.join("")
}

function isCurrent(row: ModelRow, current: CurrentModel | undefined): boolean {
  return !!current && row.providerID === current.providerID && row.modelID === current.modelID
}

/** Indexes into `lines` that the cursor can rest on (model rows only). */
function selectableIndexes(lines: readonly LineData[]): number[] {
  return lines.map((line, index) => (line.kind === "model" ? index : -1)).filter((index) => index >= 0)
}

/** The visible table after a type-to-filter query: base rows + their tier sub-rows, grouped by provider. */
type FilteredTable = {
  lines: LineData[]
  selectable: number[]
}

/** Case-insensitive substring match against every model identity the user could type. */
function matchesQuery(row: ModelRow, needle: string): boolean {
  return (
    row.modelID.toLowerCase().includes(needle) ||
    row.modelName?.toLowerCase().includes(needle) === true ||
    row.providerID.toLowerCase().includes(needle) ||
    row.providerName.toLowerCase().includes(needle)
  )
}

/**
 * Applies the search query to the static line list: an empty query returns all
 * lines; otherwise only matching model rows survive (with their tier sub-rows
 * and a single provider section row per provider, rebuilding the same
 * header/rule/spacer structure as `buildLines`).
 */
function filterLines(lines: readonly LineData[], query: string): FilteredTable {
  const needle = query.trim().toLowerCase()
  if (!needle) return { lines: [...lines], selectable: selectableIndexes(lines) }
  const out: LineData[] = [{ kind: "header" }, { kind: "rule" }, { kind: "spacer" }]
  const selectable: number[] = []
  let lastProvider: string | undefined
  for (const line of lines) {
    if (line.kind !== "model" || !matchesQuery(line.row, needle)) continue
    if (line.row.providerName !== lastProvider) {
      if (lastProvider !== undefined) out.push({ kind: "spacer" })
      out.push({ kind: "provider", name: line.row.providerName })
      lastProvider = line.row.providerName
    }
    selectable.push(out.length)
    out.push(line)
    out.push(...tierLines(line.row))
  }
  return { lines: out, selectable }
}

// The host row supports more fields than the published type lists (`details`,
// `searchText`); the select API passes options through untouched, so they are
// handed over with a cast.
type RowOption = {
  readonly title: string
  readonly value: ModelRow
  readonly description?: string
  readonly details?: string[]
  readonly searchText?: string
  readonly category?: string
}

export default Plugin.define({
  id: "opencode-model-costs.tui",
  setup(context) {
    const [data, setData] = createSignal<CostData>({ rows: [], hasAuthoredConfig: false })
    let lastSessionID: string | undefined

    const refresh = async () => {
      try {
        setData(await fetchCostData(context.client))
      } catch {
        setData({ rows: [], hasAuthoredConfig: false })
      }
    }
    void refresh()

    let stopConfigChanged: (() => void) | undefined
    try {
      stopConfigChanged = context.data.on("config.updated" as never, () => {
        void refresh()
      })
    } catch {
      // Event type unavailable on this server — the command always reads fresh data anyway.
    }

    // Prompt-footer badge; also remembers the active session for the command's
    // switch fallback when the router lookup is unavailable.
    const unregisterSlot = context.ui.slot?.({
      append: "prompt.footer.status",
      render: (slot: { sessionID?: string }) => {
        if (typeof slot?.sessionID === "string" && slot.sessionID) lastSessionID = slot.sessionID
        return <CostBadge context={context} data={data} />
      },
    })

    const resolveSessionID = (): string | undefined => {
      const route = context.ui.router?.current?.() as
        | { type?: string; sessionID?: string; name?: string; params?: { sessionID?: string } }
        | undefined
      if (route?.type === "session" && typeof route?.sessionID === "string" && route.sessionID) {
        return route.sessionID
      }
      // Transitional/alternative route shape.
      if (route?.name === "session" && typeof route?.params?.sessionID === "string" && route.params.sessionID) {
        return route.params.sessionID
      }
      return lastSessionID
    }

    /**
     * Refreshes the session's info after a switch. The TUI only applies
     * `session.model.selected` when the session row is already in its local
     * store — which, for a session that has not been prompted yet, may not be
     * loaded, so the switch event can be dropped client-side and the composer
     * keeps the old model. Re-reading the session makes the durable model (and
     * with it the badge and the effort options) visible immediately.
     */
    const refreshSessionInfo = async (sessionID: string) => {
      try {
        context.data.session?.invalidate?.(sessionID)
        await context.data.session?.sync?.(sessionID)
      } catch {
        // Best-effort: the switch itself already succeeded; the composer reflects the durable model on its next read.
      }
    }

    /**
     * The session's model is now the picked one — offer its reasoning effort
     * levels (the model's variants, same choices as the built-in picker's
     * variant dialog). Escape keeps the model default.
     */
    const showEffortDialog = async (row: ModelRow) => {
      try {
        const modelAPI = (context as any).ui?.model
        const variantAPI = modelAPI?.variant
        if (
          !modelAPI ||
          !variantAPI ||
          typeof variantAPI.list !== "function" ||
          typeof variantAPI.set !== "function" ||
          typeof context.ui.dialog?.select !== "function"
        )
          return
        const variants = (variantAPI.list() as readonly string[] | undefined)
          ?.filter((variant) => variant !== "default") ?? []
        if (variants.length === 0) return
        const current = modelAPI.current?.() as
          | { providerID?: string; modelID?: string; variant?: string }
          | undefined
        if (!current || current.providerID !== row.providerID || current.modelID !== row.modelID) return
        const DEFAULT = "default"
        const picked = await context.ui.dialog.select<string>({
          title: `Reasoning effort — ${row.providerID}/${row.modelID}`,
          options: [
            { title: "Default (model default)", value: DEFAULT },
            ...variants.map((variant) => ({ title: variant, value: variant })),
          ],
          current: current.variant ?? DEFAULT,
        })
        if (picked === undefined) return // escape — kept the current effort
        variantAPI.set(picked === DEFAULT ? undefined : picked)
      } catch {
        // Best-effort affordance: the switch already happened; effort stays untouched.
      }
    }

    /** Switches the current session to the picked model, with the usual toasts. */
    const switchToRow = async (row: ModelRow) => {
      const sessionID = resolveSessionID()
      if (!sessionID) {
        context.ui.toast.show({
          title: "Model costs",
          message: "No active session — showing costs only. Open a session to switch models.",
          variant: "info",
        })
        return
      }
      try {
        await switchSessionModel(context.client, sessionID, row)
        await refreshSessionInfo(sessionID)
        context.ui.toast.show({
          title: "Model switched",
          message: `Switched to ${row.providerID}/${row.modelID}`,
          variant: "success",
        })
        await showEffortDialog(row)
      } catch (error) {
        context.ui.toast.show({
          title: "Model switch failed",
          message: error instanceof Error ? error.message : String(error),
          variant: "error",
        })
      }
    }

    // Handlers of the open dialog; the component reads the same cursor state.
    let dialogControls:
      | {
          move(delta: number): void
          page(direction: number): void
          first(): void
          last(): void
          confirm(): void
          query(next: string): void
          close(): void
        }
      | undefined

    /** Fallback for hosts without `ui.dialog.show`: the built-in select list. */
    const showSelectDialog = async (rows: readonly ModelRow[]) => {
      const options = rows.map(
        (row): RowOption => ({
          title: `${row.providerID}/${row.modelID}${row.isDefault ? "  ★" : ""}`,
          description: fmtRow(row),
          details: fmtRowDetails(row),
          searchText: `${row.providerID} ${row.providerName} ${row.modelID} ${row.modelName ?? ""}`,
          category: row.providerName,
          value: row,
        }),
      )
      const widest = options.reduce((max, option) => {
        const lines = [`${option.title} ${option.description ?? ""}`, ...(option.details ?? []), option.category ?? ""]
        return Math.max(max, ...lines.map((line) => line.length))
      }, 0)
      const selection = context.ui.dialog.select({
        title: "Model costs — $/Mtok · Enter switches",
        options,
      })
      context.ui.dialog.set?.({ size: fitDialogSize([" ".repeat(widest)]) })
      const picked = await selection
      if (picked) await switchToRow(picked)
    }

    /** The custom table dialog: `ui.dialog.show` + padded text rows. */
    const showTableDialog = (rows: readonly ModelRow[]) => {
      const lines = buildLines(rows)
      const selectable = selectableIndexes(lines)
      if (selectable.length === 0) {
        context.ui.toast.show({
          title: "Model costs",
          message: "No models found in the configured providers.",
          variant: "warning",
        })
        return
      }

      const theme = context.theme as unknown as
        | {
            text?: {
              muted?: string
              base?: string
              formfield?: { selected?: string; focused?: string; base?: string }
            }
            background?: { formfield?: { focused?: string } }
            primary?: string
            current?: { textMuted?: string; primary?: string }
          }
        | undefined
      const palette: Palette = {
        muted: theme?.text?.muted ?? theme?.current?.textMuted,
        accent: theme?.primary ?? theme?.current?.primary ?? "#7aa2f7",
        cursor: theme?.text?.formfield?.focused ?? theme?.text?.formfield?.selected ?? theme?.text?.muted ?? theme?.current?.textMuted,
        inputBg: theme?.background?.formfield?.focused,
        inputText: theme?.text?.formfield?.base ?? theme?.text?.muted,
      }

      const widths = computeWidths(lines)
      const contentWidth = widths.total
      const totalLines = lines.length
      const viewportRows = Math.min(totalLines, MAX_VIEWPORT_ROWS)

      // The cursor and search-query state live here (outside the component) so
      // the key handlers and the rendered list share it. Plain signals need no
      // owner. Typing filters the table in place (`filterLines`); the cursor
      // restarts at the first match.
      const [selectedPos, setSelectedPos] = createSignal(0)
      const [query, setQuery] = createSignal("")
      const [filtered, setFiltered] = createSignal<FilteredTable>({ lines, selectable })
      // The component owns the scroll window and registers this setter, so a
      // filter change can jump the list back to its top.
      let setViewportTop: ((top: number) => void) | undefined
      const clampPos = (position: number) => {
        const count = filtered().selectable.length
        if (count === 0) return 0
        return Math.min(count - 1, Math.max(0, position))
      }
      const applyQuery = (next: string) => {
        setQuery(next)
        setFiltered(filterLines(lines, next))
        setSelectedPos(0)
        setViewportTop?.(0)
      }

      let popMode: (() => void) | undefined
      let open = true

      const close = () => {
        if (!open) return
        open = false
        dialogControls = undefined
        try {
          context.ui.dialog.clear()
        } catch {}
        try {
          popMode?.()
        } catch {}
        popMode = undefined
      }

      dialogControls = {
        move: (delta) => setSelectedPos(clampPos(selectedPos() + delta)),
        page: (direction) => setSelectedPos(clampPos(selectedPos() + direction * viewportRows)),
        first: () => setSelectedPos(0),
        last: () => setSelectedPos(Math.max(0, filtered().selectable.length - 1)),
        confirm: () => {
          const current = filtered()
          const line = current.lines[current.selectable[selectedPos()]]
          close()
          if (line?.kind === "model") void switchToRow(line.row)
        },
        query: applyQuery,
        close,
      }

      try {
        // Exclusive input mode while the dialog is open: host bindings stop
        // acting on keys meant for the dialog (renderer-level useKeyboard in
        // the component still receives them).
        const pushed = context.keymap?.mode?.push?.(DIALOG_MODE)
        if (typeof pushed === "function") popMode = pushed
      } catch {
        // Mode push unavailable — keys may then leak to the host input; the
        // dialog still works and closes.
      }

      // render() must produce the JSX when the host mounts it — inside the
      // host's reactive/render context — so the rows get a parent renderable.
      // Pre-creating the element here would mount nothing.
      context.ui.dialog.show(
        () => (
          <CostsTable
            table={filtered}
            query={query}
            total={selectable.length}
            widths={widths}
            palette={palette}
            contentWidth={contentWidth}
            viewportRows={viewportRows}
            registerViewportTop={(setter) => {
              setViewportTop = setter
            }}
            selected={selectedPos}
            current={() => (context.ui?.model?.current?.() as CurrentModel | undefined) ?? undefined}
            controls={dialogControls!}
            onClosed={close}
          />
        ),
        close,
      )
      context.ui.dialog.set?.({ size: fitDialogSize([" ".repeat(contentWidth)]) })
    }

    const showCostsDialog = async () => {
      if (dialogControls) return // already open
      if (data().rows.length === 0) await refresh()
      const { rows } = data()

      if (rows.length === 0) {
        context.ui.toast.show({
          title: "Model costs",
          message:
            "No configured providers or models found. Declare providers.*.models.* (with cost) in opencode.json, or connect a provider.",
          variant: "warning",
        })
        return
      }

      if (typeof context.ui.dialog.show !== "function") {
        await showSelectDialog(rows)
        return
      }
      try {
        showTableDialog(rows)
      } catch {
        // Anything thrown while opening the custom dialog (unsupported host
        // behavior) degrades to the select list.
        try {
          ;(dialogControls as { close(): void } | undefined)?.close()
        } catch {}
        await showSelectDialog(rows)
      }
    }

    context.keymap?.layer?.(() => ({
      mode: "global",
      commands: [
        {
          id: "opencode-model-costs.show",
          title: "Show model costs",
          group: "Model costs",
          palette: true,
          slash: { name: "models-cost" },
          run: () => showCostsDialog(),
        },
      ],
    }))

    return () => {
      try {
        dialogControls?.close()
      } catch {}
      try {
        stopConfigChanged?.()
      } catch {}
      try {
        ;(unregisterSlot as unknown as (() => void) | undefined)?.()
      } catch {}
    }
  },
})

/** Exclusive keymap mode name pushed while the table dialog is open. */
const DIALOG_MODE = "opencode-model-costs.table"

/**
 * The table dialog's content. Rendered by the host inside its dialog layer
 * (so the rows get a parent renderable), which is why the JSX is produced
 * lazily by the `render()` callback. The cursor and search-query state come in
 * as props; keys are read at the renderer level with `useKeyboard`. Unmounting
 * it (host close, escape through the host's own chrome) signals `onClosed`.
 */
function CostsTable(props: {
  table: () => FilteredTable
  query: () => string
  /** Number of models with no filter applied — the "of N" denominator. */
  total: number
  widths: ColumnWidths
  palette: Palette
  contentWidth: number
  viewportRows: number
  registerViewportTop(setter: (top: number) => void): void
  selected: () => number
  current: () => CurrentModel | undefined
  controls: {
    move(delta: number): void
    page(direction: number): void
    first(): void
    last(): void
    confirm(): void
    query(next: string): void
    close(): void
  }
  onClosed: () => void
}) {
  // Renderer-level keys: no keymap-bind parsing, works regardless of focus.
  // These run before the focused search input's native handler, so handled
  // keys preventDefault and navigation wins; every other key (typing,
  // backspace, caret movement) falls through to the input.
  let input: InputRenderable | undefined
  useKeyboard((event: KeyEvent) => {
    if (event.eventType === "release") return
    switch (event.name) {
      case "up":
        event.preventDefault()
        props.controls.move(-1)
        break
      case "down":
        event.preventDefault()
        props.controls.move(1)
        break
      case "pageup":
        event.preventDefault()
        props.controls.page(-1)
        break
      case "pagedown":
        event.preventDefault()
        props.controls.page(1)
        break
      case "home":
        event.preventDefault()
        props.controls.first()
        break
      case "end":
        event.preventDefault()
        props.controls.last()
        break
      case "enter":
      case "return":
        event.preventDefault()
        props.controls.confirm()
        break
      case "escape":
        event.preventDefault()
        if (props.query()) {
          if (input) input.value = ""
          props.controls.query("")
        } else {
          props.controls.close()
        }
        break
    }
  })

  // Sliding window over the lines; scrolls to keep the cursor visible.
  const [top, setTop] = createSignal(0)
  props.registerViewportTop(setTop)
  createEffect(() => {
    const table = props.table()
    const line = table.selectable[props.selected()]
    const maxTop = Math.max(0, table.lines.length - props.viewportRows)
    const currentTop = top()
    let next = currentTop
    if (line < currentTop) next = line
    else if (line >= currentTop + props.viewportRows) next = line - props.viewportRows + 1
    setTop(Math.min(Math.max(0, next), maxTop))
  })

  const selectedLine = () => props.table().selectable[props.selected()]
  const isSelected = (index: number): boolean => {
    const base = selectedLine()
    if (base === undefined) return false
    const line = props.table().lines[index]
    if (line === undefined) return false
    if (line.kind === "model") return index === base
    if (line.kind === "tier") {
      const baseLine = props.table().lines[base]
      return baseLine?.kind === "model" && baseLine.row === line.row
    }
    return false
  }

  const colorOf = (line: LineData, selected: boolean): string | undefined => {
    if (selected) return props.palette.accent
    if (line.kind === "header" || line.kind === "tier" || line.kind === "rule") return props.palette.muted
    if (line.kind === "provider") return props.palette.accent
    return undefined
  }

  const table = () => props.table()
  const from = () => Math.min(top(), Math.max(0, table().lines.length - props.viewportRows))
  const visible = () =>
    table()
      .lines.slice(from(), from() + props.viewportRows)
      .map((line, offset) => {
        const index = from() + offset
        const selected = isSelected(index)
        return (
          <text fg={colorOf(line, selected)} wrapMode="none">
            {lineText(line, props.widths, { selected, current: props.current() })}
          </text>
        )
      })

  onCleanup(props.onClosed)

  // Padded + centered: the inner block keeps its exact table width (so the
  // columns stay aligned) while the outer box centers it horizontally in the
  // dialog and adds the left/bottom insets.
  return (
    <box flexDirection="column" width="100%" alignItems="center" paddingLeft={2} paddingBottom={2}>
      <box flexDirection="column" width={props.contentWidth + 1}>
        <box flexDirection="row" justifyContent="space-between">
          <input
            flexGrow={1}
            onInput={(value) => props.controls.query(value)}
            placeholder="Search models"
            placeholderColor={props.palette.muted}
            cursorColor={props.palette.cursor ?? props.palette.accent}
            cursorStyle={{ style: "block", blinking: true }}
            focusedBackgroundColor={props.palette.inputBg}
            focusedTextColor={props.palette.inputText ?? props.palette.accent}
            ref={(renderable) => {
              input = renderable
              // Mount paints after the first frame; focus on the next tick so
              // the input is ready for typing the moment the dialog appears.
              setTimeout(() => {
                if (!input || input.isDestroyed) return
                input.focus()
              }, 1)
            }}
          />
          <text flexShrink={0} fg={props.palette.muted} wrapMode="none">
            {props.query()
              ? `${props.table().selectable.length} of ${props.total}`
              : `${props.total} model${props.total === 1 ? "" : "s"}`}
          </text>
        </box>
        <box flexDirection="column" height={props.viewportRows}>
          {table().selectable.length === 0 ? (
            <text fg={props.palette.muted} wrapMode="none">
              no matching models
            </text>
          ) : (
            visible()
          )}
        </box>
        <text fg={props.palette.muted} wrapMode="none">
          {"type to filter · ↑↓ move · enter switch · esc clear/close"}
        </text>
        <text fg={props.palette.muted} wrapMode="none">
          {"$/Mtok · ★ default · ● current"}
        </text>
      </box>
    </box>
  )
}

function CostBadge(props: { context: any; data: () => CostData }) {
  const context = props.context

  // Read inside JSX so both the selected model and the config rows are reactive.
  const badge = () => {
    const rows = props.data().rows
    const selected = context.ui?.model?.current?.() as
      | { providerID?: string; modelID?: string; id?: string; provider?: { id?: string }; model?: { modelID?: string; id?: string } }
      | undefined
    const providerID = selected?.providerID ?? selected?.provider?.id
    const modelID = selected?.modelID ?? selected?.id ?? selected?.model?.modelID ?? selected?.model?.id
    // Without a routed model (no session started yet) the configured default
    // is shown, so the prices are beside the provider from startup.
    const row = providerID && modelID ? findRow(rows, providerID, modelID) : rows.find((entry) => entry.isDefault)
    if (!row) return undefined
    return fmtBadge(row)
  }

  const color = () => context.theme?.text?.muted ?? context.theme?.current?.textMuted

  // The price line renders on the row below the footer, aligned with the
  // prompt box's left edge. The anchor box keeps the footer row's height plus
  // the reserved row under it, while the line overlays that reserved row —
  // absolute positioning takes it out of the flex flow, so the directory,
  // file and usage labels keep their exact layout. The overlay's left is
  // relative to the anchor, which the flex row places right of the growing
  // location label. `anchor.x` is the anchor's absolute screen x, so shifting
  // by it alone would land the line on the terminal's column 0 — right of
  // nothing on the home screen, but left of the prompt panel in a session,
  // where the tab rail and the route's padding sit, and there hidden. Shift
  // by the anchor's offset inside its parent (the footer row, which starts
  // exactly at the prompt box's left edge) so the line hugs the prompt box
  // on every route.
  const [offset, setOffset] = createSignal(0)
  let anchor: BoxRenderable | undefined

  onMount(() => {
    const renderer = props.context.renderer
    const track = () => {
      if (!anchor || anchor.isDestroyed) return
      const row = anchor.parent
      setOffset(row && !row.isDestroyed ? anchor.x - row.x : anchor.x)
    }
    renderer.on(CliRenderEvents.FRAME, track)
    onCleanup(() => {
      try {
        renderer.off(CliRenderEvents.FRAME, track)
      } catch {}
    })
  })

  return (
    <Show when={badge()}>
      {(text) => (
        <box
          ref={(node) => {
            anchor = node
          }}
          height={2}
          minHeight={0}
          flexShrink={0}
        >
          <box position="absolute" left={-offset()} top={1}>
            <text fg={color()} wrapMode="none">
              {text()}
            </text>
          </box>
        </box>
      )}
    </Show>
  )
}
