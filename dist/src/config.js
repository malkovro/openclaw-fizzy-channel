function resolveAccount(cfg, accountId) {
  const section = cfg?.channels?.["fizzy"];
  if (!section) throw new Error("fizzy: channels.fizzy config is missing");
  const required = ["baseUrl", "accountSlug", "apiToken", "activeColumnId"];
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
    agentId: section.agentId ? String(section.agentId) : void 0,
    botEmail: section.botEmail ? String(section.botEmail).toLowerCase() : void 0,
    greetOnEnter: section.greetOnEnter !== false,
    mode: section.mode === "poll" ? "poll" : "webhook",
    pollIntervalMs: Number(section.pollIntervalMs) > 0 ? Number(section.pollIntervalMs) : 5e3,
    boardIds: Array.isArray(section.boardIds) ? section.boardIds.map(String) : [],
    // Vision: pass card/comment images to the agent. Turn off for non-vision models
    // (the agent then only gets a text note that an image exists).
    sendImages: section.sendImages !== false,
    maxImages: Number(section.maxImages) > 0 ? Number(section.maxImages) : 6,
    maxImageBytes: Number(section.maxImageBytes) > 0 ? Number(section.maxImageBytes) : 5e6
  };
}
function inspectAccount(cfg) {
  const section = cfg?.channels?.["fizzy"];
  const configured = Boolean(section?.baseUrl && section?.apiToken && section?.activeColumnId);
  return {
    enabled: configured,
    configured,
    tokenStatus: section?.apiToken ? "available" : "missing"
  };
}
export {
  inspectAccount,
  resolveAccount
};
