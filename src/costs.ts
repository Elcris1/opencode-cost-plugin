/**
 * Data layer for opencode-model-costs.
 *
 * Collects the model/provider cost information that OpenCode resolves from
 * opencode.json(c) and formats it for display. Two server endpoints are used,
 * both best-effort so the plugin degrades gracefully across SDK versions:
 *
 * - `client.config.providers()` ("List config providers") — the configured
 *   providers with their model catalogs: merged cost (config overrides on top
 *   of catalog defaults), display names, and the default-model map.
 * - `client.config.get()` ("Get configuration") — the user-authored
 *   configuration documents, i.e. what is literally written in
 *   opencode.json(c) across config locations. Used to decide which models are
 *   *declared* in config, which costs were explicitly *set* in config, and the
 *   configured default model.
 *
 * Scope: when at least one provider is authored in opencode.json(c), only the
 * models declared there are listed (costs still merged with catalog defaults).
 * When nothing is authored, the configured providers are listed instead so the
 * dialog is never pointlessly empty for /connect-only setups.
 */

export interface CostTier {
  /** When set, this price applies to prompts over `size` context tokens. */
  tier?: { type: "context"; size: number }
  /** USD per million input tokens. */
  input: number
  /** USD per million output tokens. */
  output: number
  cache?: { read?: number; write?: number }
}

export interface ModelRow {
  providerID: string
  providerName: string
  /** Provider provenance as reported by the server: "config" | "env" | "custom" | "api". */
  providerSource?: string
  modelID: string
  modelName?: string
  /** Normalized cost tiers, ascending by context threshold. Empty = no cost info at all. */
  tiers: CostTier[]
  /** The model is declared under `providers.*.models.*` in opencode.json(c). */
  declaredInConfig: boolean
  /** The `cost` field itself was authored in opencode.json(c). */
  costFromConfig: boolean
  contextLimit?: number
  isDefault: boolean
}

export interface CostData {
  rows: ModelRow[]
  /** True when at least one provider/model is authored in opencode.json(c). */
  hasAuthoredConfig: boolean
}

// ---------------------------------------------------------------------------
// Server access
// ---------------------------------------------------------------------------

/** Unwraps hey-api `RequestResult` ({ data, error }) or passes plain values through. */
function unwrapResult(result: any): any {
  if (result && typeof result === "object" && ("data" in result || "error" in result)) {
    if (result.error) throw new Error(errorText(result.error))
    return result.data
  }
  return result
}

function errorText(error: unknown): string {
  if (typeof error === "string") return error
  const anyError = error as any
  const message = anyError?.message ?? anyError?.detail ?? anyError
  return typeof message === "string" ? message : String(error)
}

/** Generated SDK methods differ in whether they require an input object. */
async function callFlexible(fn: (...args: any[]) => any): Promise<any> {
  try {
    return await fn({})
  } catch {
    return await fn()
  }
}

async function tryProvidersPayload(client: any): Promise<{ providers: any[]; default: Record<string, string> } | undefined> {
  try {
    const providers = client?.config?.providers
    if (typeof providers !== "function") return undefined
    const data = unwrapResult(await callFlexible(providers.bind(client.config)))
    if (data && Array.isArray(data.providers)) return data
  } catch {
    // best-effort
  }
  return undefined
}

/** Returns config documents, lowest → highest priority. Older servers return a single merged config object. */
async function tryConfigDocuments(client: any): Promise<any[]> {
  try {
    const get = client?.config?.get
    if (typeof get !== "function") return []
    const data = unwrapResult(await callFlexible(get.bind(client.config)))
    if (Array.isArray(data)) {
      return data.filter((entry: any) => entry && entry.type === "document" && entry.info && typeof entry.info === "object")
    }
    if (data && typeof data === "object") return [{ type: "document", info: data }]
  } catch {
    // best-effort
  }
  return []
}

/**
 * Switches the current session to the given model via the server
 * (`POST /api/session/{sessionID}/model`, operation id `session.switchModel`,
 * body `{ model: { providerID, id } }`). Uses the typed client method when
 * available and falls back to the underlying request client otherwise.
 */
export async function switchSessionModel(client: unknown, sessionID: string, row: ModelRow): Promise<void> {
  const anyClient = client as any
  const model = { providerID: row.providerID, id: row.modelID }

  const typed = anyClient?.session?.switchModel
  if (typeof typed === "function") {
    unwrapResult(await typed.call(anyClient.session, { sessionID, model }))
    return
  }

  const raw = anyClient?.client // hey-api request client inside OpencodeClient
  if (raw && typeof raw.post === "function") {
    const body = { model }
    try {
      unwrapResult(await raw.post({ url: `/api/session/${encodeURIComponent(sessionID)}/model`, body }))
      return
    } catch {
      unwrapResult(await raw.post({ url: `/session/${encodeURIComponent(sessionID)}/model`, body }))
      return
    }
  }

  throw new Error("This OpenCode version does not expose the session model-switch API. Update OpenCode and try again.")
}

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

export async function fetchCostData(client: unknown): Promise<CostData> {
  const anyClient = client as any
  const payload = await tryProvidersPayload(anyClient)
  const documents = await tryConfigDocuments(anyClient)

  const authored = collectAuthored(documents)
  const authoredDefault = collectAuthoredDefault(documents)
  const strict = authored.size > 0 // only models declared in opencode.json(c)

  const rows: ModelRow[] = []
  const seen = new Set<string>()

  for (const provider of payload?.providers ?? []) {
    const providerID = str(provider?.id)
    if (!providerID) continue
    const authoredProvider = authored.get(providerID)
    if (strict && !authoredProvider) continue

    const providerName = str(provider?.name) || authoredProvider?.name || providerID
    const providerSource = str(provider?.source)
    const models = provider?.models && typeof provider.models === "object" ? provider.models : {}
    const wanted = strict ? [...authoredProvider!.models.entries()] : Object.entries(models)

    for (const [modelID, authoredCost] of wanted) {
      const key = `${providerID}/${modelID}`
      if (seen.has(key)) continue
      seen.add(key)

      const model = models[modelID]
      const cost = model?.cost ?? (strict ? authoredCost : undefined)
      rows.push(
        makeRow({
          providerID,
          providerName,
          providerSource,
          modelID,
          modelName: str(model?.name),
          cost,
          declaredInConfig: strict,
          costFromConfig: strict && authoredCost != null,
          contextLimit: model?.limit?.context,
        }),
      )
    }
  }

  // Declared models the active-provider payload does not know about
  // (inactive provider, disabled model, ID typo) — show the authored cost.
  for (const [providerID, info] of authored) {
    const providerName = info.name || providerID
    for (const [modelID, authoredCost] of info.models) {
      const key = `${providerID}/${modelID}`
      if (seen.has(key)) continue
      seen.add(key)
      rows.push(
        makeRow({
          providerID,
          providerName,
          providerSource: "config",
          modelID,
          cost: authoredCost,
          declaredInConfig: true,
          costFromConfig: authoredCost != null,
        }),
      )
    }
  }

  const defaultSelector = authoredDefault ?? payloadDefaultSelector(payload)
  if (defaultSelector) {
    for (const row of rows) {
      row.isDefault = row.providerID === defaultSelector.providerID && row.modelID === defaultSelector.modelID
    }
  }

  rows.sort(compareRows)
  return { rows, hasAuthoredConfig: strict }
}

function makeRow(input: {
  providerID: string
  providerName: string
  providerSource?: string
  modelID: string
  modelName?: string
  cost: unknown
  declaredInConfig: boolean
  costFromConfig: boolean
  contextLimit?: number
}): ModelRow {
  return {
    providerID: input.providerID,
    providerName: input.providerName,
    providerSource: input.providerSource,
    modelID: input.modelID,
    modelName: input.modelName,
    tiers: normalizeTiers(input.cost),
    declaredInConfig: input.declaredInConfig,
    costFromConfig: input.costFromConfig,
    contextLimit: input.contextLimit,
    isDefault: false,
  }
}

/** Providers/models authored in opencode.json(c), merged across documents (later wins). */
function collectAuthored(documents: any[]): Map<string, { name?: string; models: Map<string, any> }> {
  const map = new Map<string, { name?: string; models: Map<string, any> }>()
  for (const document of documents) {
    const info = document?.info
    if (!info || typeof info !== "object") continue
    // Walk both the V2 `providers` key and the deprecated V1 `provider` key
    // (same entry shape for this plugin's purposes).
    for (const key of ["providers", "provider"] as const) {
      const providers = (info as any)[key]
      if (!providers || typeof providers !== "object") continue
      for (const [providerID, rawProvider] of Object.entries(providers as Record<string, any>)) {
        if (!rawProvider || typeof rawProvider !== "object") continue
        const entry = map.get(providerID) ?? { name: str(rawProvider.name), models: new Map<string, any>() }
        if (!entry.name && str(rawProvider.name)) entry.name = str(rawProvider.name)
        const models = rawProvider.models
        if (models && typeof models === "object") {
          for (const [modelID, rawModel] of Object.entries(models as Record<string, any>)) {
            if (!rawModel || typeof rawModel !== "object") continue
            entry.models.set(modelID, (rawModel as any).cost)
          }
        }
        map.set(providerID, entry)
      }
    }
  }
  return map
}

/** The `model` default from the last config document that sets one. */
function collectAuthoredDefault(documents: any[]): { providerID: string; modelID: string } | undefined {
  let selector: { providerID: string; modelID: string } | undefined
  for (const document of documents) {
    const model = document?.info?.model
    if (typeof model === "string") {
      selector = parseSelector(model)
    } else if (model && typeof model === "object" && typeof (model as any).providerID === "string") {
      selector = { providerID: (model as any).providerID, modelID: str((model as any).model) ?? "" }
    }
    if (selector && !selector.modelID) selector = undefined
  }
  return selector
}

function payloadDefaultSelector(payload: { default?: Record<string, string> } | undefined) {
  const map = payload?.default
  if (!map || typeof map !== "object") return undefined
  const value =
    (typeof map.default === "string" && map.default) ||
    Object.values(map).find((entry) => typeof entry === "string" && entry.includes("/"))
  return typeof value === "string" ? parseSelector(value) : undefined
}

/** "provider/model(#variant)" or "provider/nested/model(#variant)" → { providerID, modelID }. */
function parseSelector(reference: string): { providerID: string; modelID: string } | undefined {
  const slash = reference.indexOf("/")
  if (slash <= 0) return undefined
  const providerID = reference.slice(0, slash)
  const rest = reference.slice(slash + 1)
  const hash = rest.indexOf("#")
  const modelID = hash >= 0 ? rest.slice(0, hash) : rest
  if (!modelID) return undefined
  return { providerID, modelID }
}

function compareRows(a: ModelRow, b: ModelRow): number {
  const provider = a.providerName.localeCompare(b.providerName) || a.providerID.localeCompare(b.providerID)
  if (provider !== 0) return provider
  return a.modelID.localeCompare(b.modelID)
}

// ---------------------------------------------------------------------------
// Cost normalization
// ---------------------------------------------------------------------------

/**
 * Accepts every known cost shape:
 * - config `cost` object: { tier?, input, output, cache? { read?, write? } }
 * - config `cost` tier array of the objects above
 * - SDK `Model.cost`: { input, output, cache, tiers?, experimentalOver200K? }
 */
export function normalizeTiers(cost: unknown): CostTier[] {
  if (Array.isArray(cost)) return cost.map(normalizeConfigTier).sort(byTierSize)
  if (!cost || typeof cost !== "object") return []
  const source = cost as any

  if (Array.isArray(source.tiers) && source.tiers.length > 0) {
    return source.tiers
      .map((entry: any) => ({
        tier: tierOf(entry?.tier),
        input: num(entry?.input),
        output: num(entry?.output),
        cache: cacheOf(entry?.cache),
      }))
      .sort(byTierSize)
  }

  const tiers: CostTier[] = [
    {
      input: num(source.input),
      output: num(source.output),
      cache: cacheOf(source.cache) ?? flatCacheOf(source),
    },
  ]
  // SDK shape and deprecated V1 config shape (`context_over_200k`).
  const over = source.experimentalOver200K ?? source.context_over_200k
  if (over && typeof over === "object") {
    tiers.push({
      tier: { type: "context", size: 200000 },
      input: num(over.input),
      output: num(over.output),
      cache: cacheOf(over.cache) ?? flatCacheOf(over),
    })
  }
  return tiers.sort(byTierSize)
}

function normalizeConfigTier(entry: any): CostTier {
  if (!entry || typeof entry !== "object") return { input: 0, output: 0 }
  return {
    tier: tierOf(entry.tier),
    input: num(entry.input),
    output: num(entry.output),
    cache: cacheOf(entry.cache) ?? flatCacheOf(entry),
  }
}

function byTierSize(a: CostTier, b: CostTier): number {
  return (a.tier?.size ?? 0) - (b.tier?.size ?? 0)
}

function tierOf(tier: any): { type: "context"; size: number } | undefined {
  if (tier?.type === "context" && typeof tier.size === "number" && Number.isFinite(tier.size)) {
    return { type: "context", size: tier.size }
  }
  return undefined
}

function cacheOf(cache: any): { read?: number; write?: number } | undefined {
  if (!cache || typeof cache !== "object") return undefined
  const read = cache.read == null ? undefined : num(cache.read)
  const write = cache.write == null ? undefined : num(cache.write)
  if (read == null && write == null) return undefined
  return { read, write }
}

/** Deprecated V1 config shape: flat `cache_read` / `cache_write` next to `input` / `output`. */
function flatCacheOf(source: any): { read?: number; write?: number } | undefined {
  if (!source || typeof source !== "object") return undefined
  const read = source.cache_read
  const write = source.cache_write
  if (read == null && write == null) return undefined
  return {
    read: read == null ? undefined : num(read),
    write: write == null ? undefined : num(write),
  }
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

/** "$15", "$3.25", "$0.3", "$1.2e-7" — compact but precise for sub-dollar rates. */
export function fmtMoney(value: number): string {
  if (!Number.isFinite(value)) return "?"
  if (value === 0) return "$0"
  if (Math.abs(value) >= 1) return `$${trimZeros(value.toFixed(2))}`
  if (Math.abs(value) >= 0.001) return `$${trimZeros(value.toFixed(4))}`
  return `$${value.toExponential(1)}`
}

function trimZeros(text: string): string {
  return text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "")
}

/** 200000 → "200k", 1000000 → "1M", 128000 → "128k". */
export function fmtK(tokens: number): string {
  if (!Number.isFinite(tokens) || tokens <= 0) return String(tokens)
  if (tokens % 1_000_000 === 0) return `${tokens / 1_000_000}M`
  if (tokens % 1_000 === 0) return `${tokens / 1_000}k`
  return String(tokens)
}

/**
 * "in $6 · out $22" — the input/output price line: the badge's first row and
 * the first half of the dialog row's price line. The unit lives in the dialog
 * title, not in every line.
 */
export function fmtRatesTop(tier: CostTier): string {
  return `in ${fmtMoney(tier.input)} · out ${fmtMoney(tier.output)}`
}

/** "cache read $0.55 · cache write $5.5" — the badge's second row and the dialog price line's second half. */
export function fmtRatesCache(tier: CostTier): string {
  return `cache read ${fmtMoney(tier.cache?.read ?? 0)} · cache write ${fmtMoney(tier.cache?.write ?? 0)}`
}

/** All four rates on one line — the dialog description and extra-tier lines. */
export function fmtRates(tier: CostTier): string {
  return `${fmtRatesTop(tier)} · ${fmtRatesCache(tier)}`
}

/** Dialog description: all four rates on one line beside the model title. */
export function fmtRow(row: ModelRow): string {
  if (row.tiers.length === 0) return "cost not set (catalog default)"
  return fmtRates(row.tiers[0])
}

/**
 * Full-width lines under a dialog row, never clipped by the title: the meta
 * line, then every extra tier in full — so the whole information is visible
 * without a separate detail view.
 */
export function fmtRowDetails(row: ModelRow): string[] {
  if (row.tiers.length === 0) return []
  const lines: string[] = []
  const meta = fmtRowMeta(row)
  if (meta) lines.push(meta)
  for (const extra of row.tiers.slice(1)) {
    lines.push((extra.tier && extra.tier.size > 0 ? `over ${fmtK(extra.tier.size)} ctx: ` : "") + fmtRates(extra))
  }
  return lines
}

/** Meta line under a dialog row: first-tier context marker and the model's context limit. */
export function fmtRowMeta(row: ModelRow): string {
  if (row.tiers.length === 0) return ""
  const parts: string[] = []
  const tier = row.tiers[0]
  if (tier.tier && tier.tier.size > 0) parts.push(`over ${fmtK(tier.tier.size)} ctx`)
  if (row.contextLimit && row.contextLimit > 0) parts.push(`ctx ${fmtK(row.contextLimit)}`)
  return parts.join(" · ")
}

/** Prompt badge text: all four rates plus an extra-tiers marker. Empty when there is no cost info. */
export function fmtBadge(row: ModelRow): string {
  if (row.tiers.length === 0) return ""
  let text = fmtRates(row.tiers[0])
  if (row.tiers.length > 1) text += ` · +${row.tiers.length - 1} tiers`
  return text
}

// ---------------------------------------------------------------------------
// Dialog sizing
// ---------------------------------------------------------------------------

/** Host dialog presets and their widths (packages/tui/src/ui/dialog.tsx, `dialogWidth`). */
const DIALOG_PRESETS = [
  { size: "medium", width: 60 },
  { size: "large", width: 88 },
  { size: "xlarge", width: 116 },
] as const

export type DialogSize = (typeof DIALOG_PRESETS)[number]["size"]

/**
 * The smallest host dialog preset whose list fits the widest rendered line.
 * The host reserves the list chrome (side insets, gutter, row padding — about
 * 12 cells) inside each preset's width, and two more cells of slack absorb
 * minor host-side drift. Lines wider than every preset still open, on xlarge,
 * where the host clips them.
 */
export function fitDialogSize(lines: readonly string[]): DialogSize {
  const widest = Math.max(0, ...lines.map((line) => line.length))
  return DIALOG_PRESETS.find((preset) => widest <= preset.width - 14)?.size ?? "xlarge"
}

export function findRow(rows: ModelRow[], providerID: string, modelID: string): ModelRow | undefined {
  return rows.find((row) => row.providerID === providerID && row.modelID === modelID)
}
