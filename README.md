# opencode-model-costs

An [OpenCode](https://opencode.ai) V2 TUI plugin for comparing model rates in USD per million tokens.

- **`/models-cost`** opens a searchable price browser. A wide terminal shows a provider-grouped table. A narrow terminal uses OpenCode's native picker. Enter opens the selected model's details, including cache rates, context tiers, and price source. In an active session, **Switch to this model** applies the change to that session.
- **Optional prompt footer** shows the current model's base input and output rates in one muted line. The plugin leaves configuration files untouched.

## Install

This checkout targets OpenCode 2.3.2. Install the dependencies in the plugin directory with `npm ci`. OpenCode runs the TypeScript sources directly. Use a supported Node version for the OpenTUI peers (`>=26.4.0` for OpenTUI 0.8.4).

Add the plugin directory to a project's `opencode.json(c)`. Use an absolute path or a path relative to that config file:

```json
{
  "plugins": ["/absolute/path/to/opencode-model-costs"]
}
```

To enable the footer on OpenCode 2.3.2, use the options entry in the terminal client's `cli.json` (typically `~/.config/opencode/cli.json`). This host does not pass the server plugin entry's options through to the TUI. For a one-off run, supply the same JSON via `OPENCODE_CLI_CONFIG_CONTENT`. [OpenCode CLI plugin settings](https://opencode.ai/docs/cli/config/#plugins).

```json
{
  "plugins": [
    { "package": "/absolute/path/to/opencode-model-costs", "options": { "footer": true } }
  ]
}
```

## Verify the local integration

This repository's `opencode.json` loads the checkout. Use the CLI option above to exercise the footer. Its two demo providers supply synthetic prices and point to a loopback endpoint. The fixture is for browsing and session selection.

1. From the repository root, run `npm ci` and `npx tsc --noEmit`.
2. Start `opencode --standalone`, then open `/models-cost`. Global provider declarations may also appear. For a fixture-only run, launch with empty XDG config and data directories.
3. Check `demo-small` for an explicit `$0` cache-read rate and a dash for missing cache-write pricing. Check `demo-large` for the 200k context tier and `demo-unpriced` for unavailable rates.
4. Inspect a model on the home screen, then repeat in a session. Closing the details preserves the current model. Choosing **Switch to this model** updates the session and any enabled footer.
5. Reopen the command in a narrow terminal to check the picker. Run `/reload` after editing the plugin and check the OpenCode log for load errors.

## Where the prices come from

Costs are resolved by the OpenCode server from `opencode.json(c)` — merged over the provider catalog's defaults — with `{env:}`/`{file:}` substitutions and config precedence applied. The plugin never reads config files itself.

Scope: when at least one provider is authored in `opencode.json(c)`, only the models declared there are listed; when nothing is authored, all configured providers are listed, so `/connect`-only setups still get cost visibility. Models can inherit a catalog rate. A dash indicates an unavailable rate, and `$0` indicates a reported zero.

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
