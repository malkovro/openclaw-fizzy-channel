import {
  createChatChannelPlugin,
  createChannelPluginBase
} from "openclaw/plugin-sdk/channel-core";
import { createTopLevelChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import { DEFAULT_ACCOUNT_ID } from "openclaw/plugin-sdk/account-id";
import { getSessionBindingService } from "openclaw/plugin-sdk/session-binding-runtime";
import { resolveAccount, inspectAccount } from "./config.js";
import { FizzyClient } from "./client.js";
import { textToHtml } from "./text.js";
import { getApi } from "./state.js";
const fizzyConfigAdapter = createTopLevelChannelConfigAdapter({
  sectionKey: "fizzy",
  resolveAccount: (cfg) => resolveAccount(cfg),
  inspectAccount: (cfg) => inspectAccount(cfg),
  listAccountIds: () => [DEFAULT_ACCOUNT_ID],
  defaultAccountId: () => DEFAULT_ACCOUNT_ID,
  resolveAllowFrom: () => [],
  formatAllowFrom: (allowFrom) => allowFrom.map(String)
});
function trimString(value) {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value).trim();
  return "";
}
function parseCardNumberFromSessionKey(sessionKey) {
  const raw = trimString(sessionKey);
  if (!raw) return void 0;
  const match = raw.match(/^agent:[^:]+:fizzy:([^:]+):(\d+)(?::|$)/);
  return match?.[2];
}
function parseCardNumberFromConversationId(conversationId) {
  const raw = trimString(conversationId);
  if (!raw) return void 0;
  const match = raw.match(/^(?:card:)?(\d+)$/);
  return match?.[1];
}
function findBoundConversationId(...sessionKeys) {
  for (const sessionKey of sessionKeys) {
    const normalized = trimString(sessionKey);
    if (!normalized) continue;
    const conversationId = getSessionBindingService().listBySession(normalized).find((record) => record?.conversation?.channel === "fizzy")?.conversation?.conversationId;
    if (conversationId?.trim()) return conversationId.trim();
  }
  return void 0;
}
function resolveFizzyCardTarget(params) {
  const directCandidates = [
    params?.to,
    params?.replyTo,
    params?.replyToId,
    params?.target,
    params?.threadId,
    params?.peer?.id,
    params?.route?.to,
    params?.route?.peer?.id,
    params?.conversationId,
    params?.conversation?.conversationId,
    params?.deliveryContext?.to,
    params?.origin?.to
  ];
  for (const candidate of directCandidates) {
    const directTo = trimString(candidate);
    const parsedDirectCard = parseCardNumberFromConversationId(directTo) ?? directTo;
    if (parsedDirectCard) return parsedDirectCard;
  }
  const sessionKey = trimString(params?.sessionKey);
  const baseSessionKey = trimString(params?.baseSessionKey);
  const boundConversationId = findBoundConversationId(sessionKey, baseSessionKey);
  const parsedBoundCard = parseCardNumberFromConversationId(boundConversationId);
  if (parsedBoundCard) return parsedBoundCard;
  if (boundConversationId) return boundConversationId;
  const cardFromSessionKey = parseCardNumberFromSessionKey(sessionKey) ?? parseCardNumberFromSessionKey(baseSessionKey);
  if (cardFromSessionKey) return cardFromSessionKey;
  throw new Error(
    `fizzy outbound could not resolve target card number (missing direct target, binding, and sessionKey fallback; sessionKey=${sessionKey || baseSessionKey || "<empty>"})`
  );
}
const fizzyPlugin = createChatChannelPlugin({
  base: createChannelPluginBase({
    id: "fizzy",
    meta: {
      label: "Fizzy",
      selectionLabel: "Fizzy",
      blurb: "Chat with OpenClaw from a Fizzy card in a chosen kanban column.",
      docsPath: "channels/fizzy"
    },
    config: fizzyConfigAdapter,
    setup: {
      resolveAccount,
      inspectAccount
    }
  }),
  threading: { topLevelReplyToMode: "reply" },
  outbound: {
    resolveOutboundSessionRoute: (params) => {
      const to = resolveFizzyCardTarget(params);
      return {
        sessionKey: params.sessionKey,
        baseSessionKey: params.sessionKey,
        peer: { kind: "direct", id: to },
        chatType: "direct",
        from: params.agentId,
        to
      };
    },
    attachedResults: {
      channel: "fizzy",
      sendText: async (params) => {
        const account = resolveAccount(params?.cfg ?? getApi().config, params?.accountId);
        const client = new FizzyClient(account);
        const to = resolveFizzyCardTarget(params);
        const id = await client.postComment(to, textToHtml(String(params.text ?? "")));
        return { messageId: id ?? `fizzy:${to}:${Date.now()}` };
      }
    }
  }
});
export {
  fizzyPlugin
};
