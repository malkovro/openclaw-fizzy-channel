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
import { buildOutboundCommentBody } from "./outbound-media.js";
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

function trimString(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number") return String(value).trim();
  return "";
}

function parseCardNumberFromSessionKey(sessionKey: unknown): string | undefined {
  const raw = trimString(sessionKey);
  if (!raw) return undefined;
  const match = raw.match(/^agent:[^:]+:fizzy:([^:]+):(\d+)(?::|$)/);
  return match?.[2];
}

function parseCardNumberFromConversationId(conversationId: unknown): string | undefined {
  const raw = trimString(conversationId);
  if (!raw) return undefined;
  const match = raw.match(/^(?:card:)?(\d+)$/);
  return match?.[1];
}

function findBoundConversationId(...sessionKeys: Array<string | undefined>): string | undefined {
  for (const sessionKey of sessionKeys) {
    const normalized = trimString(sessionKey);
    if (!normalized) continue;
    const conversationId = getSessionBindingService()
      .listBySession(normalized)
      .find((record) => record?.conversation?.channel === "fizzy")?.conversation?.conversationId;
    if (conversationId?.trim()) return conversationId.trim();
  }
  return undefined;
}

function resolveFizzyCardTarget(params: any): string {
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
    params?.origin?.to,
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
    `fizzy outbound could not resolve target card number (missing direct target, binding, and sessionKey fallback; sessionKey=${sessionKey || baseSessionKey || "<empty>"})`,
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
    // Lift remote Markdown images (`![](https://…png)`) in the agent's reply text
    // into media payloads so they route through sendMedia on this core-driven path.
    base: { extractMarkdownImages: true },
    attachedResults: {
      channel: "fizzy",
      sendText: async (params: any) => {
        const account = resolveAccount(params?.cfg ?? getApi().config, params?.accountId);
        const client = new FizzyClient(account);
        const to = resolveFizzyCardTarget(params);
        const id = await client.postComment(to, textToHtml(String(params.text ?? "")));
        return { messageId: id ?? `fizzy:${to}:${Date.now()}` };
      },
      // Core dispatches one sendMedia call per media item, with `text` as the
      // caption. Load the media, embed it as a real Fizzy attachment (or degrade
      // to a link on failure), and post one comment.
      sendMedia: async (params: any) => {
        const api = getApi();
        const account = resolveAccount(params?.cfg ?? api.config, params?.accountId);
        const client = new FizzyClient(account);
        const to = resolveFizzyCardTarget(params);
        const mediaUrl = String(params?.mediaUrl ?? "");
        const html = await buildOutboundCommentBody(api, account, client, {
          caption: String(params?.text ?? ""),
          mediaUrls: mediaUrl ? [mediaUrl] : [],
          policy: {
            mediaAccess: params?.mediaAccess,
            mediaLocalRoots: params?.mediaLocalRoots,
            mediaReadFile: params?.mediaReadFile,
            workspaceDir: resolveWorkspaceDir(api, params?.cfg ?? api.config),
          },
        });
        const id = await client.postComment(to, html);
        return { messageId: id ?? `fizzy:${to}:${Date.now()}` };
      },
    },
  },
});

// Best-effort agent workspace dir, used only to resolve relative local media paths.
function resolveWorkspaceDir(api: any, cfg: any): string | undefined {
  try {
    return api?.runtime?.agent?.resolveAgentWorkspaceDir?.(cfg);
  } catch {
    return undefined;
  }
}
