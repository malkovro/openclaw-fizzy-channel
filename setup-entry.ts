import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { fizzyPlugin } from "./src/channel.js";

// Lightweight entry loaded during setup/status when the channel is unconfigured.
export default defineSetupPluginEntry(fizzyPlugin);
