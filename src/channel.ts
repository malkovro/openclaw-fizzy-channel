import {
  createChatChannelPlugin,
  createChannelPluginBase,
} from "openclaw/plugin-sdk/channel-core";
import { createTopLevelChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";

import { resolveAccount, inspectAccount } from "./config.js";
import { FizzyClient } from "./client.js";
import { textToHtml } from "./text.js";
import { getApi } from "./state.js";

// Config adapter: single top-level `channels.fizzy` section (one default account).
// Provides the listAccountIds/resolveAccount helpers the channel registry requires.
const fizzyConfigAdapter = createTopLevelChannelConfigAdapter<ReturnType<typeof resolveAccount>>({
  sectionKey: "fizzy",
  resolveAccount: (cfg) => resolveAccount(cfg),
  inspectAccount: (cfg) => inspectAccount(cfg),
  listAccountIds: () => [DEFAULT_ACCOUNT_ID],
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  resolveAllowFrom: () => [],
  formatAllowFrom: (allowFrom) => allowFrom.map(String),
});

// The channel plugin object. Inbound (card comment -> agent) is driven from
// index.ts's HTTP webhook route; the outbound adapter here lets core deliver
// any agent "message" targeted at this channel by posting a Fizzy comment.
// `to` is the Fizzy card number.
export const fizzyPlugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: "fizzy",
    meta: {
      label: "Fizzy",
      selectionLabel: "Fizzy",
      blurb: "Chat with OpenClaw from a Fizzy card in a chosen kanban column.",
      docsPath: "channels/fizzy",
    },
    config: fizzyConfigAdapter,
    setup: {
      resolveAccount,
      inspectAccount,
    },
  }),

  threading: { topLevelReplyToMode: "reply" },

  outbound: {
    attachedResults: {
      sendText: async (params: any) => {
        const account = resolveAccount(params?.cfg ?? getApi().config, params?.accountId);
        const client = new FizzyClient(account);
        const id = await client.postComment(String(params.to), textToHtml(String(params.text ?? "")));
        return { messageId: id ?? `fizzy:${params.to}:${Date.now()}` };
      },
    },
  },
});
