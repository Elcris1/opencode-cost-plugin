# Contributing

Run these commands from the repository root with OpenCode 2.3.2 and Node.js 26.4.0 or later:

```sh
npm ci
npx tsc --noEmit
opencode --standalone
```

OpenCode loads the TypeScript directly. The root [opencode.json](opencode.json) registers the local plugin and provides synthetic prices for two demo providers. Launch with empty XDG config and data directories if you want to exclude globally configured providers.

## Verify a change

1. Open `/models-cost`. Check the explicit zero and missing cache rate on `demo-small`, the 200k context tier on `demo-large`, and the unavailable rates on `demo-unpriced`.
2. Filter the list, inspect a row, and close it. In an active session, choose a named effort for `demo-large` and verify the session uses it. Cancel the effort picker and check that the current model and effort stay selected. Switch to `demo-small` to verify the direct switch for a model without variants.
3. Reopen the command in a narrow terminal to check the native picker. Check that the footer rates update after a switch and that the [footer off setting](README.md#configure-the-footer) hides it.
4. Run `/reload` after editing plugin code. Check the OpenCode log for load errors. The default log is `~/.local/share/opencode/log/opencode.log`.
5. For packaging changes, use `npm pack --dry-run` to inspect the file list. Install a real tarball in a disposable project and open the command before releasing.

When reporting an issue, include the OpenCode version, terminal width, reproduction steps, and any relevant log excerpt with credentials removed.

## Repository layout

| Path | Purpose |
| --- | --- |
| [src/index.ts](src/index.ts) | Server registration entry point |
| [src/tui.tsx](src/tui.tsx) | Command, price browser, and optional footer |
| [src/costs.ts](src/costs.ts) | OpenCode client lookups, price normalization, and formatting |
| [opencode.json](opencode.json) | Checkout-only integration fixture |
| [docs/design.md](docs/design.md) | Design history and implementation notes |
| [docs/release-plan.md](docs/release-plan.md) | Publication setup, release workflow, and maintenance plan |
| [docs/images](docs/images) | README images captured from the demo fixture |
