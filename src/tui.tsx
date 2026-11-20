/** @jsxImportSource @opentui/solid */
import { Plugin } from "@opencode/plugin/tui"
import { CliRenderEvents, InputRenderable, type KeyEvent } from "@opentui/core"
import { Show, createEffect, createMemo, createSignal, getOwner, onCleanup } from "solid-js"
import type { Context as TuiContext } from "@opencode/plugin/tui/context"
import { useKeyboard, useTerminalDimensions } from "@opentui/solid"
import {
  type CostData,
  type CostTier,
  type ModelRow,
  fetchCostData,
  findRow,
  fitDialogSize,
  fitsDialogWidth,
  fmtBadge,
  fmtK,
  fmtMoney,
  fmtRates,
  switchSessionModel,
} from "./costs"

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

type SetComposerModel = (row: ModelRow) => void
const HOME = Symbol("home")
type SwitchTarget = string | typeof HOME

/** OpenCode 2.3.2 keeps the native model setter in its Solid local context. */
function findComposerModelSetter(): SetComposerModel | undefined {
  const contexts = getOwner()?.context
  if (!contexts) return undefined

  for (const key of Object.getOwnPropertySymbols(contexts)) {
    const model = contexts[key]?.model
    if (
      typeof model?.set === "function" &&
      typeof model?.selection === "function" &&
      typeof model?.trackSessionCommit === "function"
    ) {
      return (row) => model.set({ providerID: row.providerID, modelID: row.modelID })
    }
  }
  return undefined
}

interface Palette {
  muted?: string
  accent?: string
  /** Search-input caret color (theme form-field focused text). */
  cursor?: string
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
  return [fmtMoney(tier.input), fmtMoney(tier.output), fmtMoney(tier.cache?.read), fmtMoney(tier.cache?.write)]
}

/** The model-column text of a line. */
function modelCell(line: LineData): string {
  if (line.kind === "header") return "model"
  if (line.kind === "provider") return line.name
  if (line.kind === "tier") {
    const size = line.tier.tier?.size
    return size && size > 0 ? `↳ over ${fmtK(size)} ctx` : `↳ tier ${line.index + 1}`
  }
  if (line.kind === "model") {
    const threshold = line.row.tiers[0]?.tier?.size
    return threshold ? `${line.row.modelID} · over ${fmtK(threshold)} ctx` : line.row.modelID
  }
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
    if (row.providerID !== lastProvider) {
      if (lastProvider !== undefined) lines.push({ kind: "spacer" })
      lines.push({ kind: "provider", name: row.providerName })
      lastProvider = row.providerID
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
    if (line.row.providerID !== lastProvider) {
      if (lastProvider !== undefined) out.push({ kind: "spacer" })
      out.push({ kind: "provider", name: line.row.providerName })
      lastProvider = line.row.providerID
    }
    selectable.push(out.length)
    out.push(line)
    out.push(...tierLines(line.row))
  }
  return { lines: out, selectable }
}

export default Plugin.define({
  id: "opencode-model-costs.tui",
  setup(context) {
    const [data, setData] = createSignal<CostData>({ rows: [], hasAuthoredConfig: false })
    let disposed = false
    let refreshID = 0
    let opening = false
    const footer = context.options?.footer !== false

    const refresh = async (): Promise<CostData> => {
      const id = ++refreshID
      const result = await fetchCostData(context.client, context.location).catch(() => ({
        rows: [], hasAuthoredConfig: false, configUnavailable: true,
      }))
      if (!disposed && id === refreshID) setData(result)
      return result
    }
    if (footer) void refresh()

    let stopConfigChanged: (() => void) | undefined
    try {
      stopConfigChanged = context.data.on("config.updated", () => {
        if (footer) void refresh()
      })
    } catch {
      // Event type unavailable on this server — the command always reads fresh data anyway.
    }

    const unregisterSlot = footer ? context.ui.slot?.({
      append: "prompt.footer.status",
      render: () => <CostBadge context={context} data={data} />,
    }) : undefined

    const resolveSwitchTarget = (): SwitchTarget | undefined => {
      const route = context.ui.router?.current?.() as
        | { type?: string; sessionID?: string; name?: string; params?: { sessionID?: string } }
        | undefined
      if (route?.type === "home" || route?.name === "home") return HOME
      if (route?.type === "session" && typeof route?.sessionID === "string" && route.sessionID) {
        return route.sessionID
      }
      // Transitional/alternative route shape.
      if (route?.name === "session" && typeof route?.params?.sessionID === "string" && route.params.sessionID) {
        return route.params.sessionID
      }
      return undefined
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

    const applyRow = async (
      row: ModelRow,
      target: SwitchTarget,
      setComposerModel: SetComposerModel | undefined,
      variant?: string,
    ) => {
      if (disposed || resolveSwitchTarget() !== target) return
      const model = `${row.providerID}/${row.modelID}`
      const selection = variant ? `${model}#${variant}` : model
      try {
        if (target !== HOME) {
          await switchSessionModel(context.client, target, row, variant)
          await refreshSessionInfo(target)
        }
        if (disposed || resolveSwitchTarget() !== target) return
        const modelUI = context.ui.model
        const hasVariant = (current: { variant?: string } | undefined) =>
          (current?.variant ?? "default") === (variant ?? "default")
        const matchesSelection = () => {
          const current = modelUI?.current?.()
          return isCurrent(row, current) && hasVariant(current)
        }
        if (typeof modelUI?.current === "function" && !matchesSelection()) {
          // A native picker draft can take precedence over the synced session model.
          try {
            if (!isCurrent(row, modelUI.current())) setComposerModel?.(row)
            const current = modelUI.current()
            if (isCurrent(row, current) && !hasVariant(current)) modelUI.variant?.set?.(variant)
          } catch {
            // The native picker is still available if the host's local context changed.
          }
        }
        if (!matchesSelection() && (target === HOME || typeof modelUI?.current === "function")) {
          const openPicker = await context.ui.dialog.confirm({
            title: "Composer model still needs updating",
            message: [
              target === HOME
                ? "OpenCode could not update the model for the next prompt."
                : `The session saved ${selection}, but the prompt still has a different selection.`,
              `Choose ${model} in /models${row.variantIDs.length ? ` and select ${variant ?? "Default"} effort` : ""}.`,
            ].join(" "),
            label: { confirm: "Open model picker", cancel: "Close" },
          })
          if (openPicker && !disposed && resolveSwitchTarget() === target) {
            context.keymap?.dispatch?.("model.list")
          }
          return
        }

        context.ui.toast.show({
          title: target === HOME ? "Model selected" : "Model switched",
          message: target === HOME ? `Selected ${selection} for the next prompt` : `Switched to ${selection}`,
          variant: "success",
        })
      } catch (error) {
        if (disposed) return
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

    const inspectRow = async (
      row: ModelRow,
      target: SwitchTarget | undefined,
      setComposerModel: SetComposerModel | undefined,
    ) => {
      const lines = row.tiers.map((tier) =>
        `${tier.tier ? `Over ${fmtK(tier.tier.size)} context` : "Base"}: ${fmtRates(tier)}`,
      )
      const source = row.tiers.length === 0 ? "Rates unavailable" : row.costFromConfig ? "Config override" : "Catalog rate"
      const message = [
        `${source} · USD per million tokens`,
        ...lines,
        row.contextLimit ? `Context limit: ${fmtK(row.contextLimit)} tokens` : undefined,
      ].filter(Boolean).join("\n")
      const title = `${row.providerID}/${row.modelID}`
      if (target !== undefined && resolveSwitchTarget() === target) {
        const confirmed = await context.ui.dialog.confirm({
          title,
          message,
          label: { confirm: row.variantIDs.length ? "Choose reasoning effort" : "Switch to this model", cancel: "Close" },
        })
        if (!confirmed || disposed || resolveSwitchTarget() !== target) return
        if (row.variantIDs.length === 0) {
          await applyRow(row, target, setComposerModel)
          return
        }
        const picked = await context.ui.dialog.select<{ variant?: string }>({
          title: "Reasoning effort · " + row.modelID,
          options: [
            { title: "Default", value: {} },
            ...row.variantIDs.map((variant) => ({ title: variant, value: { variant } })),
          ],
        })
        if (picked) await applyRow(row, target, setComposerModel, picked.variant)
      } else {
        await context.ui.dialog.alert({ title, message })
      }
    }

    const showSelectDialog = async (rows: readonly ModelRow[], target: SwitchTarget | undefined) => {
      let setComposerModel: SetComposerModel | undefined
      const picked = await context.ui.dialog.select({
        title: "Model costs · in/out $/1M",
        options: rows.map((row) => {
          const base = row.tiers.find((tier) => !tier.tier)
          return {
            title: row.modelID,
            description: base ? `${fmtMoney(base.input)}/${fmtMoney(base.output)}` : row.tiers.length ? "Tiered" : "—",
            category: row.providerName,
            value: row,
          }
        }),
        search: (query, options) => {
          setComposerModel ??= findComposerModelSetter()
          return options.filter(({ value }) => matchesQuery(value, query.trim().toLowerCase()))
        },
      })
      if (picked && !disposed) await inspectRow(picked, target, setComposerModel)
    }

    /** The custom table dialog: `ui.dialog.show` + padded text rows. */
    const showTableDialog = (rows: readonly ModelRow[], target: SwitchTarget | undefined) => {
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
            primary?: string
            current?: { textMuted?: string; primary?: string }
          }
        | undefined
      const palette: Palette = {
        muted: theme?.text?.muted ?? theme?.current?.textMuted,
        accent: theme?.primary ?? theme?.current?.primary ?? "#7aa2f7",
        cursor: theme?.text?.formfield?.focused ?? theme?.text?.formfield?.selected ?? theme?.text?.muted ?? theme?.current?.textMuted,
        inputText: theme?.text?.formfield?.base ?? theme?.text?.muted,
      }

      const widths = computeWidths(lines)
      const contentWidth = widths.total
      if (!fitsDialogWidth(contentWidth, context.renderer?.width ?? 0)) return false
      const totalLines = lines.length
      const viewportRows = Math.max(1, Math.min(totalLines, MAX_VIEWPORT_ROWS, (context.renderer?.height ?? 30) - 14))

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

      let setComposerModel: SetComposerModel | undefined
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
          if (line?.kind !== "model") return
          close()
          opening = true
          void inspectRow(line.row, target, setComposerModel).catch(() => {
            if (!disposed) context.ui.toast.show({ message: "Could not open model details.", variant: "error" })
          }).finally(() => { opening = false })
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
        () => {
          setComposerModel = findComposerModelSetter()
          return (
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
          )
        },
        close,
      )
      context.ui.dialog.set?.({ size: fitDialogSize([" ".repeat(contentWidth)]) })
      return true
    }

    const closeTable = () => dialogControls?.close()

    const showCostsDialog = async () => {
      if (opening || dialogControls) return
      opening = true
      const target = resolveSwitchTarget()
      try {
        const { rows, configUnavailable, providerPricesUnavailable } = await refresh()
        if (disposed) return
        if (configUnavailable || rows.length === 0) {
          await context.ui.dialog.alert({
            title: "Model costs",
            message: configUnavailable
              ? "Could not read OpenCode configuration. Reopen Model costs to retry."
              : providerPricesUnavailable ? "Could not load configured providers. Reopen Model costs to retry."
                : "No models found in the configured providers.",
          })
          return
        }
        if (typeof context.ui.dialog.show === "function") {
          try {
            if (showTableDialog(rows, target)) return
          } catch {
            closeTable()
          }
        }
        await showSelectDialog(rows, target)
      } finally {
        opening = false
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
      disposed = true
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

  const tableHeight = () => table().selectable.length ? Math.min(table().lines.length, props.viewportRows) : 1

  return (
    <box flexDirection="column" width="100%" alignItems="center" paddingTop={1} paddingBottom={2}>
      <box flexDirection="column" width={props.contentWidth}>
        <box flexDirection="row" columnGap={3} marginBottom={1}>
          <input
            flexGrow={1}
            minWidth={0}
            backgroundColor="transparent"
            onInput={(value) => props.controls.query(value)}
            placeholder="Search models"
            placeholderColor={props.palette.muted}
            cursorColor={props.palette.cursor ?? props.palette.accent}
            cursorStyle={{ style: "block", blinking: true }}
            focusedBackgroundColor="transparent"
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
        <box flexDirection="column" height={tableHeight()} marginBottom={1}>
          {table().selectable.length === 0 ? (
            <text fg={props.palette.muted} wrapMode="none">
              No matching models
            </text>
          ) : (
            visible()
          )}
        </box>
        <text fg={props.palette.muted} wrapMode="none">
          {"↑↓ Move · Enter details · Esc close"}
        </text>
        <text fg={props.palette.muted} wrapMode="none">
          {"USD / 1M tokens · ★ Default · ● Current"}
        </text>
      </box>
    </box>
  )
}

function CostBadge(props: { context: TuiContext; data: () => CostData }) {
  const context = props.context
  const dimensions = useTerminalDimensions()
  const [footerWidth, setFooterWidth] = createSignal<number>()

  // Read inside JSX so both the selected model and the config rows are reactive.
  const badge = () => {
    const rows = props.data().rows
    const selected = context.ui?.model?.current?.() as
      | { providerID?: string; modelID?: string; id?: string; provider?: { id?: string }; model?: { modelID?: string; id?: string } }
      | undefined
    const providerID = selected?.providerID ?? selected?.provider?.id
    const modelID = selected?.modelID ?? selected?.id ?? selected?.model?.modelID ?? selected?.model?.id
    // Without a routed model (no session started yet) the configured default
    // is shown so its prices are visible from startup.
    const row = providerID && modelID ? findRow(rows, providerID, modelID) : rows.find((entry) => entry.isDefault)
    if (!row) return undefined
    return fmtBadge(row, dimensions().width - 4) ? row : undefined
  }

  const color = () => context.theme?.text?.muted ?? context.theme?.current?.textMuted

  const [offset, setOffset] = createSignal(0)

  return (
    <Show when={badge()}>
      {(row) => (
        <box
          height={2}
          minHeight={0}
          flexShrink={0}
          ref={(anchor) => {
            // Reserve a second row without taking width from the host's status items.
            // Align the badge to the footer's left edge when the slot moves.
            const align = () => {
              const footer = anchor.parent
              if (!footer) return
              setOffset(anchor.x - footer.x)
              if (footer.width > 0) setFooterWidth(footer.width)
            }
            context.renderer.on(CliRenderEvents.FRAME, align)
            onCleanup(() => {
              context.renderer.off(CliRenderEvents.FRAME, align)
              setFooterWidth(undefined)
            })
          }}
        >
          <box position="absolute" left={-offset()} top={1}>
            <text fg={color()} wrapMode="none">
              {fmtBadge(row(), Math.min(footerWidth() ?? Infinity, dimensions().width - 4))}
            </text>
          </box>
        </box>
      )}
    </Show>
  )
}
