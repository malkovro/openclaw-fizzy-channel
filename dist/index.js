import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { fizzyPlugin } from "./src/channel.js";
import { setApi } from "./src/state.js";
import { handleFizzyWebhook } from "./src/inbound.js";
import { resolveAccount } from "./src/config.js";
import { startPolling } from "./src/poll.js";
var index_default = defineChannelPluginEntry({
  id: "fizzy",
  name: "Fizzy",
  description: "Chat with the OpenClaw agent from a Fizzy card in a chosen kanban column.",
  plugin: fizzyPlugin,
  registerFull(api) {
    setApi(api);
    let mode = "webhook";
    try {
      mode = resolveAccount(api.config).mode;
    } catch (err) {
      api.logger?.warn?.(`[fizzy] config not ready: ${err?.message ?? err}`);
    }
    if (mode === "poll") {
      startPolling(api, resolveAccount(api.config));
      api.logger?.info?.("[fizzy] channel plugin loaded in poll mode");
    } else {
      api.registerHttpRoute({
        path: "/fizzy/webhook",
        auth: "plugin",
        // we verify the Fizzy HMAC signature ourselves
        handler: (req, res) => handleFizzyWebhook(api, req, res)
      });
      api.logger?.info?.("[fizzy] channel plugin loaded; webhook at /fizzy/webhook");
    }
  }
});
export {
  index_default as default
};
