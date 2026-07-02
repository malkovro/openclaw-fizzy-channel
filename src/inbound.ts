import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { resolveAccount, type FizzyAccount } from "./config.js";
import { FizzyClient } from "./client.js";
import { textToHtml } from "./text.js";

// ---- Fizzy webhook payload shapes (subset we use) ----
type FizzyEvent = {
  action: string;
  eventable: any;
  board?: { id?: string; name?: string };
  creator?: { id?: string; role?: string; name?: string };
};

function readRawBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function verifySignature(raw: Buffer, header: string | undefined, secret: string): boolean {
  if (!header) return false;
  const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(header);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function cardNumberFromUrl(url: string | undefined): string | null {
  if (!url) return null;
  const m = url.match(/\/cards\/(\d+)/);
  return m ? m[1] : null;
}

// Main entry: verify + route a Fizzy webhook delivery. `api` is the plugin api.
export async function handleFizzyWebhook(
  api: any,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  const account = resolveAccount(api.config);
  const raw = await readRawBody(req);

  if (!verifySignature(raw, req.headers["x-webhook-signature"] as string | undefined, account.webhookSecret)) {
    res.statusCode = 401;
    res.end("invalid signature");
    return true;
  }

  let event: FizzyEvent;
  try {
    event = JSON.parse(raw.toString("utf8"));
  } catch {
    res.statusCode = 400;
    res.end("bad json");
    return true;
  }

  // Acknowledge immediately; process asynchronously so the agent turn does not
  // block Fizzy's delivery request (7s timeout).
  res.statusCode = 200;
  res.end("ok");

  process.nextTick(() => {
    routeEvent(api, account, event).catch((err) => {
      api.logger?.error?.(`[fizzy] webhook processing failed: ${err?.message ?? err}`);
    });
  });
  return true;
}

async function routeEvent(api: any, account: FizzyAccount, event: FizzyEvent): Promise<void> {
  if (event.action === "comment_created") {
    await onCommentCreated(api, account, event);
  } else if (event.action === "card_triaged" && account.greetOnEnter) {
    await onCardTriaged(api, account, event);
  }
}

async function onCommentCreated(api: any, account: FizzyAccount, event: FizzyEvent): Promise<void> {
  const comment = event.eventable ?? {};
  const creator = comment?.creator ?? {};
  // Echo guard: never reply to our own bot's comments (match by email, or by
  // system role as a fallback) — otherwise the bot's reply would loop.
  const creatorEmail = String(creator.email_address ?? "").toLowerCase();
  if (creator.role === "system") return;
  if (account.botEmail && creatorEmail === account.botEmail) return;

  const cardNumber = cardNumberFromUrl(comment?.card?.url);
  if (!cardNumber) return;

  const client = new FizzyClient(account);

  // Column gate: only respond while the card is in the configured column.
  const card = await client.getCard(cardNumber);
  if (!card || card.column?.id !== account.activeColumnId) return;

  const text = String(comment?.body?.plain_text ?? "").trim();
  if (!text) return;

  const reply = await runAgent(api, account, {
    cardNumber,
    cardTitle: card.title ?? `Card #${cardNumber}`,
    senderName: comment?.creator?.name ?? "User",
    text,
  });

  if (reply) await client.postComment(cardNumber, textToHtml(reply));
}

async function onCardTriaged(api: any, account: FizzyAccount, event: FizzyEvent): Promise<void> {
  const card = event.eventable ?? {};
  if (card?.column?.id !== account.activeColumnId) return;
  const cardNumber = card?.number ?? cardNumberFromUrl(card?.url);
  if (!cardNumber) return;
  const client = new FizzyClient(account);
  await client.postComment(
    String(cardNumber),
    textToHtml("👋 I'm connected to this card. Reply here and I'll help while it stays in this column."),
  );
}

// Run one agent turn for this card's session and return the reply text.
// The session is registered in the standard store (one session per card), keyed
// like other channels (agent:<agentId>:fizzy:<account>:direct:<card>), so the
// conversation shows up in the OpenClaw dashboard and `openclaw sessions`.
async function runAgent(
  api: any,
  account: FizzyAccount,
  ctx: { cardNumber: string; cardTitle: string; senderName: string; text: string },
): Promise<string> {
  const cfg = api.config;
  const agent = api.runtime.agent;
  const workspaceDir: string = agent.resolveAgentWorkspaceDir(cfg);
  const timeoutMs: number = agent.resolveAgentTimeoutMs(cfg);
  const agentId: string = account.agentId ?? cfg?.agents?.list?.[0]?.id ?? "main";

  // One session per card. No custom sessionFile -> the run registers in the
  // standard session store, so it appears in the dashboard / `openclaw sessions`
  // as agent:<agentId>:fizzy:<account>:<card>.
  // sessionId is used as the transcript filename: must match /^[a-z0-9][a-z0-9._-]{0,127}$/ (no colons).
  const sessionId = `fizzy-${account.accountSlug}-${ctx.cardNumber}`;
  // sessionKey follows the dashboard convention agent:<agentId>:<channel>:... so it
  // shows up scoped to the agent and is openable at /chat?session=<sessionKey>.
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
    disableMessageTool: true, // deterministic: take the returned text, we deliver it ourselves
    messageChannel: "fizzy",
    senderName: ctx.senderName,
    prompt: ctx.text,
  });
  const parts: string[] = (result?.payloads ?? [])
    .filter((p: any) => p?.text && !p.isError && !p.isReasoning)
    .map((p: any) => String(p.text));
  return parts.join("\n\n").trim();
}
