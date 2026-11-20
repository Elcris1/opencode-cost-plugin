import { Plugin } from "@opencode/plugin"

/**
 * Server part of the opencode-model-costs plugin.
 *
 * It intentionally does no work: all behavior lives in the TUI part
 * (src/tui.tsx), which reads cost data from the OpenCode server through its
 * own client. This part exists so the package is a complete plugin — the
 * server part defines the plugin id and makes the TUI part load
 * automatically alongside it.
 */
export default Plugin.define({
  id: "opencode-model-costs",
  setup() {
    // No server-side behavior needed.
  },
})
