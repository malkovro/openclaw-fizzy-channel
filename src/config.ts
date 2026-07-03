// Resolve the `channels.fizzy` config section into a typed account.

export type FizzyAccount = {
  accountId: string | null;
  baseUrl: string;
  accountSlug: string;
  apiToken: string;
  webhookSecret: string;
  activeColumnId: string;
  agentId?: string;
  botEmail?: string;
  greetOnEnter: boolean;
  mode: "webhook" | "poll";
  pollIntervalMs: number;
  pollConcurrency: number;
  boardIds: string[];
  sendImages: boolean;
  maxImages: number;
  maxImageBytes: number;
};

export function resolveAccount(cfg: any, accountId?: string | null): FizzyAccount {
  const section = (cfg?.channels as Record<string, any>)?.["fizzy"];
  if (!section) throw new Error("fizzy: channels.fizzy config is missing");
  const required = ["baseUrl", "accountSlug", "apiToken", "activeColumnId"];
  // webhookSecret is only needed in webhook mode.
  if (section.mode !== "poll") required.push("webhookSecret");
  for (const key of required) {
    if (!section[key]) throw new Error(`fizzy: channels.fizzy.${key} is required`);
  }
  return {
    accountId: accountId ?? null,
    baseUrl: String(section.baseUrl).replace(/\/+$/, ""),
    accountSlug: String(section.accountSlug),
    apiToken: String(section.apiToken),
    webhookSecret: section.webhookSecret ? String(section.webhookSecret) : "",
    activeColumnId: String(section.activeColumnId),
    agentId: section.agentId ? String(section.agentId) : undefined,
    botEmail: section.botEmail ? String(section.botEmail).toLowerCase() : undefined,
    greetOnEnter: section.greetOnEnter !== false,
    mode: section.mode === "poll" ? "poll" : "webhook",
    pollIntervalMs: Number(section.pollIntervalMs) > 0 ? Number(section.pollIntervalMs) : 5000,
    pollConcurrency: Number(section.pollConcurrency) > 0 ? Number(section.pollConcurrency) : 4,
    boardIds: Array.isArray(section.boardIds) ? section.boardIds.map(String) : [],
    // Vision: pass card/comment images to the agent. Turn off for non-vision models
    // (the agent then only gets a text note that an image exists).
    sendImages: section.sendImages !== false,
    maxImages: Number(section.maxImages) > 0 ? Number(section.maxImages) : 6,
    maxImageBytes: Number(section.maxImageBytes) > 0 ? Number(section.maxImageBytes) : 5_000_000,
  };
}

export function inspectAccount(cfg: any) {
  const section = (cfg?.channels as Record<string, any>)?.["fizzy"];
  const configured = Boolean(section?.baseUrl && section?.apiToken && section?.activeColumnId);
  return {
    enabled: configured,
    configured,
    tokenStatus: section?.apiToken ? "available" : "missing",
  };
}
