# AGENTS.md

OpenCode V2 plugin that shows per-model cost info in the TUI (`/models-cost` dialog + prompt-footer badge). `PLAN.md` is the design spec and "as built" record — read it before changing behavior.

## No build, no tests — verify with typecheck + live reload

- OpenCode runs the TypeScript directly. There is no build step, no test suite, and no npm scripts.
- The only automated check: `npx tsc --noEmit` (tsconfig is editor support only; `noEmit`, `allowImportingTsExtensions`).
- Real verification is manual: enable the plugin via a `plugins` entry (absolute path) in a project `opencode.json` or global `~/.config/opencode/opencode.json`, run OpenCode 2.x, and check the server log (`~/.local/share/opencode/log/opencode.log`) for plugin load errors. `/reload` picks up changes to the plugin's own code.
- Peer deps (`@opentui/core`, `@opentui/solid`, `solid-js`) must be installed inside this folder (`npm install`); OpenCode resolves `@opencode/plugin` itself, but JSX peers are the plugin's responsibility.

## Structure

- `src/index.ts` — server part. Intentionally does nothing, but must exist: the single `plugins` entry loads both parts through it.
- `src/costs.ts` — data + formatting layer (no UI imports). Data comes from two best-effort server calls, never from reading config files: `client.config.providers()` (merged costs, catalog defaults) and `client.config.get()` (authoring facts — what's literally declared/`cost`-set in opencode.json(c)). The server resolves env/file substitutions and config precedence; don't reimplement that here.
- `src/tui.tsx` — TUI part (JSX, `jsxImportSource: @opentui/solid`): slash/palette command, dialog, footer badge.

## Conventions that differ from defaults

- Targets OpenCode V2 exclusively (`@opencode/plugin` 2.x). It won't load on the V1 1.x line (`@opencode-ai/plugin`).
- Every server/SDK call is written defensively for cross-version compatibility: optional method lookups, `unwrapResult` for hey-api `RequestResult`, `callFlexible` (try `{}` args then no args), raw-client fallbacks, try/catch with graceful degradation. Preserve this pattern — the plugin must not break across SDK versions.
- Config compatibility: accept both V2 `providers` and deprecated V1 `provider` keys, and both cost shapes (V1 flat `cache_read`/`cache_write`, `context_over_200k` as a 200k context tier).
- Model-switch API quirk: the body model ref field is `id`, not `modelID` (`{ providerID, id }` → `POST /api/session/{sessionID}/model`).
- Command name is `/models-cost` only — no aliases. Scope rule: when any provider is authored in opencode.json(c), only declared models are listed; when nothing is authored, all configured providers are listed.

## Releases

- **Never commit or bump versions on your own initiative.** Commits and version bumps wait until a human explicitly asks for them.
- Every version bump in `package.json` must add an entry at the top of `CHANGELOG.md` (newest first) and be committed together — see the existing `vX.Y.Z:` commit style, which matches the changelog entries.
