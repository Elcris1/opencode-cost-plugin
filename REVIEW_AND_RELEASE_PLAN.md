# OpenCode model costs review and release plan

I recommend a project-local pilot of opencode-model-costs after two fixes: make model switching deliberate and restore a reproducible clean install. The plugin gives teams a quick way to compare configured USD rates per million tokens inside the terminal. Actual session spend is outside its scope.

## How the plugin works

OpenCode V2 loads a minimal server entry and the `./tui` export from a single plugins entry in `opencode.json(c)`. The TUI registers `/models-cost` and contributes a prompt-footer badge. It uses OpenCode’s client to read effective provider prices and config declarations. Declared models define the list when a provider is authored. Otherwise the list uses configured providers. The plugin leaves configuration files untouched.

[OpenCode plugin structure](https://opencode.ai/docs/build/plugins/)  ·  [OpenCode TUI APIs](https://opencode.ai/docs/build/plugins/cli/)

## Product changes before the pilot

**Make browsing read-only by default.** Use Enter to inspect prices. Offer a labeled switch action only for an active session and revalidate that session before writing. The current fallback can reuse a previous session from the home screen, and a successful switch can open a second reasoning-effort dialog.

**Show price source and missing values.** Reserve $0 for explicitly reported zero rates. Use a dash for unavailable prices and label config overrides and catalog rates in model details. A failed config lookup should be visible in the dialog so it cannot silently expand a curated list.

**Keep the interface compact.** Keep the provider-grouped table at widths that fit. Use the native searchable picker at narrow widths, with cache rates and context tiers in model details. Make the footer opt-in and use one muted line in the native slot, without the extra row and per-frame overlay positioning.

## Current verification

Typechecking fails on `onMount` and `createEffect`. The installed Solid 2.0.3 and OpenTUI Solid 0.9.4 differ from the versions declared by the installed OpenCode SDK 2.3.2. Live TUI behavior still needs verification.

## Package publication and maintenance

Use a company-owned scope and an approved registry for the pilot. Share a version-pinned install example, the supported OpenCode versions, and a short removal and rollback procedure. Keep public distribution a separate release decision.

**Make installs reproducible.** Replace the floating SDK dependency and open-ended peer ranges with versions compatible with the tested host. Use npm as the canonical package manager, maintain one lockfile, pin the development toolchain in CI, and run `npm ci` followed by the TypeScript check. Review dependency updates against the supported OpenCode versions.

**Verify the package users will install.** Run `npm pack --dry-run` to check the allowlist, then install the actual tarball in a disposable project. The current dry run lists six files, including both entry points, the README and the changelog. Add the full MIT license text to the package and verify that it ships alongside the source. Keep local configuration and credentials out of the tarball.

**Test the plugin in OpenCode.** Verify both entry points load and check the server log after startup and `/reload`. Exercise configured and catalog pricing, missing rates, narrow terminals, home-screen browsing, and switching within the active session. Capture a screenshot from the verified build for the pilot README.

**Publish through a controlled workflow.** Use a reviewed CI release workflow with least-privilege credentials. Use npm trusted publishing with short-lived OIDC credentials where supported. Enable provenance where the registry and repository visibility support it. Verify package ownership, registry and access settings before the first release.

**Version changes and plan rollback.** Use semantic versioning with a documented compatibility policy and call out changes to keys or defaults in release notes. Keep each approved version bump and its newest-first changelog entry in the same commit and tag that commit. Release a prerelease under next before promoting a verified version to latest. If a release regresses, pin the previous working version and publish a fix under a new version.

## Pilot exit criteria

A teammate can install the pinned package, compare rates without changing the session, and disable it in one project. The team has a named maintainer, a repeatable release workflow, and a tested rollback path.

[npm clean installs](https://docs.npmjs.com/cli/commands/npm-ci/)  ·  [npm package inspection](https://docs.npmjs.com/cli/pack/)  ·  [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/)
