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
};

export function resolveAccount(cfg: any, accountId?: string | null): FizzyAccount {
  const section = (cfg?.channels as Record<string, any>)?.["fizzy"];
  if (!section) throw new Error("fizzy: channels.fizzy config is missing");
  const required = ["baseUrl", "accountSlug", "apiToken", "webhookSecret", "activeColumnId"];
  for (const key of required) {
    if (!section[key]) throw new Error(`fizzy: channels.fizzy.${key} is required`);
  }
  return {
    accountId: accountId ?? null,
    baseUrl: String(section.baseUrl).replace(/\/+$/, ""),
    accountSlug: String(section.accountSlug),
    apiToken: String(section.apiToken),
    webhookSecret: String(section.webhookSecret),
    activeColumnId: String(section.activeColumnId),
    agentId: section.agentId ? String(section.agentId) : undefined,
    botEmail: section.botEmail ? String(section.botEmail).toLowerCase() : undefined,
    greetOnEnter: section.greetOnEnter !== false,
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
