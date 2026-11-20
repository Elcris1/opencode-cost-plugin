# opencode-model-costs

An [OpenCode](https://opencode.ai) plugin that shows what your models cost, right in the TUI — the per-model prices you set (or inherit from the catalog) in `opencode.json`, surfaced in two places:

1. **`/models-cost` dialog** — a palette + slash command that opens a dialog listing every configured model with its four per-million-token prices on one line: `in $6 · out $22 · cache read $0.55 · cache write $5.5`. Grouped by provider, with the context limit and any extra context tiers on unclipped detail lines. **Enter switches the current session to the selected model** (same session-scoped semantics as the built-in `/models`); Escape closes without switching. The dialog resizes itself to the smallest host size that fits its content.
2. **Prompt-footer badge** — the current model's four prices on one line on the row directly under the prompt's status row, aligned with the prompt box's left edge. Shown from startup (falling back to the configured default model when no session has started) and updating live when the model changes.

Read-only with respect to configuration: the plugin never edits `opencode.json`, and switching a model is session-scoped.

## Requirements

- **OpenCode 2.x** (the V2 plugin contract, `@opencode/plugin`). It will not load on the V1 1.x line.
- Peer dependencies (`@opentui/core`, `@opentui/solid`, `solid-js`) must be resolvable from the plugin folder — run `npm install` inside it once. OpenCode resolves `@opencode/plugin` itself.

## Enable it

Add the plugin's path to a `plugins` entry, either project-local:

```jsonc
// opencode.json
{
  "plugins": ["C:/projectsia/opencode-model-costs"]
}
```

or global (`~/.config/opencode/opencode.json`) to get it in every project. After editing the plugin's own code, `/reload` picks it up without restarting OpenCode.

## Where the prices come from

Costs are resolved by the OpenCode server from `opencode.json(c)` — merged over the provider catalog's defaults — with `{env:}`/`{file:}` substitutions and config precedence applied. The plugin never reads config files itself.

Scope: when at least one provider is authored in `opencode.json(c)`, only the models declared there are listed; when nothing is authored, all configured providers are listed, so `/connect`-only setups still get cost visibility. Models with no explicit cost show `cost not set (catalog default)`.

The `cost` shape it understands (both the V2 `providers` key and the deprecated V1 `provider` key):

```jsonc
{
  "providers": {
    "anthropic": {
      "models": {
        "claude-sonnet-4": {
          "cost": {
            "input": 3,
            "output": 15,
            "cache": { "read": 0.3, "write": 3.75 }
            // tiered pricing: an array of these, each with
            // "tier": { "type": "context", "size": 200000 }
          }
        }
      }
    }
  }
}
```

## License

MIT
