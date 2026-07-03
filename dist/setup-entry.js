import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { fizzyPlugin } from "./src/channel.js";
var setup_entry_default = defineSetupPluginEntry(fizzyPlugin);
export {
  setup_entry_default as default
};
