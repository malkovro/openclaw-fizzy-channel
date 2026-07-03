import crypto from "node:crypto";
import { resolveAccount } from "./config.js";
import { FizzyClient } from "./client.js";
import { textToHtml } from "./text.js";
import { contextPrefixForTurn } from "./cardcontext.js";
import { collectTurnImages } from "./images.js";
function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function verifySignature(raw, header, secret) {
  if (!header) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function cardNumberFromUrl(url) {
  if (!url) return null;
  const m = url.match(/\/cards\/(\d+)/);
  return m ? m[1] : null;
}
async function handleFizzyWebhook(api, req, res) {
  const account = resolveAccount(api.config);
  const raw = await readRawBody(req);
  if (!verifySignature(raw, req.headers["x-webhook-signature"], account.webhookSecret)) {
    res.statusCode = 401;
    res.end("invalid signature");
    return true;
  }
  let event;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    res.statusCode = 400;
    res.end("bad json");
    return true;
  }
  res.statusCode = 200;
  res.end("ok");
  process.nextTick(() => {
    processFizzyEvent(api, account, event).catch((err) => {
      api.logger?.error?.(`[fizzy] webhook processing failed: ${err?.message ?? err}`);
    });
  });
  return true;
}
async function processFizzyEvent(api, account, event) {
  if (event.action === "comment_created") {
    await onCommentCreated(api, account, event);
  } else if (event.action === "card_triaged" && account.greetOnEnter) {
    await onCardTriaged(api, account, event);
  }
}
async function onCommentCreated(api, account, event) {
  const comment = event.eventable ?? {};
  const creator = comment?.creator ?? {};
  const creatorEmail = String(creator.email_address ?? "").toLowerCase();
  if (creator.role === "system") return;
  if (account.botEmail && creatorEmail === account.botEmail) return;
  const cardNumber = cardNumberFromUrl(comment?.card?.url);
  if (!cardNumber) return;
  const client = new FizzyClient(account);
  const card = await client.getCard(cardNumber);
  if (!card || card.column?.id !== account.activeColumnId) return;
  const text = String(comment?.body?.plain_text ?? "").trim();
  const contextPrefix = contextPrefixForTurn(cardNumber, card);
  const { images, notes } = await collectTurnImages(api, account, client, {
    commentHtml: comment?.body?.html,
    card,
    cardNumber
  });
  if (!text && images.length === 0 && notes.length === 0) return;
  const body = text || (images.length ? "(image attached \u2014 see above)" : "(image attachment)");
  const notesLine = notes.length ? `

[Note: ${notes.join("; ")}.]` : "";
  const reply = await runAgent(api, account, {
    cardNumber,
    senderName: comment?.creator?.name ?? "User",
    prompt: `${contextPrefix}${body}${notesLine}`,
    images
  });
  if (reply) await client.postComment(cardNumber, textToHtml(reply));
}
async function onCardTriaged(api, account, event) {
  const card = event.eventable ?? {};
  if (card?.column?.id !== account.activeColumnId) return;
  const cardNumber = card?.number ?? cardNumberFromUrl(card?.url);
  if (!cardNumber) return;
  const client = new FizzyClient(account);
  await client.postComment(
    String(cardNumber),
    textToHtml("\u{1F44B} I'm connected to this card. Reply here and I'll help while it stays in this column.")
  );
}
async function runAgent(api, account, ctx) {
  const cfg = api.config;
  const agent = api.runtime.agent;
  const workspaceDir = agent.resolveAgentWorkspaceDir(cfg);
  const timeoutMs = agent.resolveAgentTimeoutMs(cfg);
  const agentId = account.agentId ?? cfg?.agents?.list?.[0]?.id ?? "main";
  const sessionId = `fizzy-${account.accountSlug}-${ctx.cardNumber}`;
  const sessionKey = `agent:${agentId}:fizzy:${account.accountSlug}:${ctx.cardNumber}`;
  const result = await agent.runEmbeddedAgent({
    sessionId,
    sessionKey,
    agentId,
    workspaceDir,
    config: cfg,
    timeoutMs,
    trigger: "user",
    chatType: "dm",
    disableMessageTool: true,
    // deterministic: take the returned text, we deliver it ourselves
    messageChannel: "fizzy",
    senderName: ctx.senderName,
    prompt: ctx.prompt,
    images: ctx.images && ctx.images.length ? ctx.images : void 0
  });
  const parts = (result?.payloads ?? []).filter((p) => p?.text && !p.isError && !p.isReasoning).map((p) => String(p.text));
  return parts.join("\n\n").trim();
}
export {
  handleFizzyWebhook,
  processFizzyEvent
};
