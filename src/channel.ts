import {
  createChatChannelPlugin,
  createChannelPluginBase,
  type ChannelOutboundSessionRouteParams,
} from "openclaw/plugin-sdk/channel-core";
import { createTopLevelChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { getSessionBindingService } from "openclaw/plugin-sdk/session-binding-runtime";

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

function parseCardNumberFromSessionKey(sessionKey: unknown): string | undefined {
  const raw = typeof sessionKey === "string" ? sessionKey.trim() : "";
  if (!raw) return undefined;
  const match = raw.match(/^agent:[^:]+:fizzy:([^:]+):(\d+)(?::|$)/);
  return match?.[2];
}

function resolveFizzyCardTarget(params: any): string {
  const directTo = typeof params?.to === "string" || typeof params?.to === "number" ? String(params.to).trim() : "";
  if (directTo) return directTo;

  const sessionKey = typeof params?.sessionKey === "string" ? params.sessionKey.trim() : "";
  const boundConversationId = sessionKey
    ? getSessionBindingService()
        .listBySession(sessionKey)
        .find((record) => record?.conversation?.channel === "fizzy")?.conversation?.conversationId
    : undefined;
  if (boundConversationId?.trim()) return boundConversationId.trim();

  const cardFromSessionKey = parseCardNumberFromSessionKey(sessionKey);
  if (cardFromSessionKey) return cardFromSessionKey;

  throw new Error(
    `fizzy outbound could not resolve target card number (missing params.to and no binding/sessionKey fallback; sessionKey=${sessionKey || "<empty>"})`,
  );
}

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
    resolveOutboundSessionRoute: (params: ChannelOutboundSessionRouteParams) => {
      const to = resolveFizzyCardTarget(params);
      return {
        sessionKey: params.sessionKey,
        baseSessionKey: params.sessionKey,
        peer: { kind: "direct", id: to },
        chatType: "direct",
        from: params.agentId,
        to,
      };
    },
    attachedResults: {
      channel: "fizzy",
      sendText: async (params: any) => {
        const account = resolveAccount(params?.cfg ?? getApi().config, params?.accountId);
        const client = new FizzyClient(account);
        const to = resolveFizzyCardTarget(params);
        const id = await client.postComment(to, textToHtml(String(params.text ?? "")));
        return { messageId: id ?? `fizzy:${to}:${Date.now()}` };
      },
    },
  },
});
