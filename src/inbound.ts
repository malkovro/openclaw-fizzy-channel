import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import { resolveAccount, type FizzyAccount } from "./config.js";
import { FizzyClient } from "./client.js";
import { textToHtml } from "./text.js";
import { contextPrefixForTurn } from "./cardcontext.js";
import { collectTurnImages, type ImageContent } from "./images.js";

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
    processFizzyEvent(api, account, event).catch((err) => {
      api.logger?.error?.(`[fizzy] webhook processing failed: ${err?.message ?? err}`);
    });
  });
  return true;
}

// Route one Fizzy event/activity (same shape for webhook payloads and activity-feed
// items: { action, eventable, ... }). Reused by both webhook and poll modes.
export async function processFizzyEvent(api: any, account: FizzyAccount, event: FizzyEvent): Promise<void> {
  await processFizzyEventGroup(api, account, [event]);
}

// Poll mode can deliver several same-card comments in one batch. Coalesce those
// into one agent turn so the card gets a single response to the burst, while
// still preserving chronological order within the batch.
export async function processFizzyEventGroup(api: any, account: FizzyAccount, events: FizzyEvent[]): Promise<void> {
  const pendingComments: FizzyEvent[] = [];

  const flushComments = async () => {
    if (pendingComments.length === 0) return;
    const batch = [...pendingComments];
    pendingComments.length = 0;
    if (batch.length === 1) await onCommentCreated(api, account, batch[0]);
    else await onCommentCreatedBatch(api, account, batch);
  };

  for (const event of events) {
    if (event.action === "comment_created") {
      pendingComments.push(event);
      continue;
    }
    await flushComments();
    if (event.action === "card_triaged" && account.greetOnEnter) {
      await onCardTriaged(api, account, event);
    }
  }

  await flushComments();
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

  // Prepend card content on thread init, or a delta if the card changed since
  // the last message (reuses the card we just fetched; no extra API call).
  const contextPrefix = contextPrefixForTurn(cardNumber, card);

  // Pass along images attached to the comment (and the card, on first sight) so
  // the agent can actually see them. Skipped/oversized images become text notes.
  const { images, notes } = await collectTurnImages(api, account, client, {
    commentHtml: comment?.body?.html,
    card,
    cardNumber,
  });

  // Nothing to act on: an empty comment with no images (e.g. a reaction).
  if (!text && images.length === 0 && notes.length === 0) return;

  const body = text || (images.length ? "(image attached — see above)" : "(image attachment)");
  const notesLine = notes.length ? `\n\n[Note: ${notes.join("; ")}.]` : "";

  const reply = await runAgent(api, account, {
    cardNumber,
    senderName: comment?.creator?.name ?? "User",
    prompt: `${contextPrefix}${body}${notesLine}`,
    images,
  });

  if (reply) await client.postComment(cardNumber, textToHtml(reply));
}

async function onCommentCreatedBatch(api: any, account: FizzyAccount, events: FizzyEvent[]): Promise<void> {
  const comments = events
    .map((event) => event.eventable ?? {})
    .filter((comment) => {
      const creator = comment?.creator ?? {};
      const creatorEmail = String(creator.email_address ?? "").toLowerCase();
      if (creator.role === "system") return false;
      if (account.botEmail && creatorEmail === account.botEmail) return false;
      return true;
    });
  if (comments.length === 0) return;

  const cardNumbers = [...new Set(comments.map((comment) => cardNumberFromUrl(comment?.card?.url)).filter(Boolean))];
  if (cardNumbers.length !== 1) {
    for (const event of events) await onCommentCreated(api, account, event);
    return;
  }

  const cardNumber = String(cardNumbers[0]);
  const client = new FizzyClient(account);
  const card = await client.getCard(cardNumber);
  if (!card || card.column?.id !== account.activeColumnId) return;

  const contextPrefix = contextPrefixForTurn(cardNumber, card);
  const promptParts: string[] = [];
  const images: ImageContent[] = [];

  for (const comment of comments) {
    const text = String(comment?.body?.plain_text ?? "").trim();
    const { images: commentImages, notes } = await collectTurnImages(api, account, client, {
      commentHtml: comment?.body?.html,
      card,
      cardNumber,
    });

    const remainingSlots = Math.max(0, account.maxImages - images.length);
    const acceptedImages = remainingSlots > 0 ? commentImages.slice(0, remainingSlots) : [];
    images.push(...acceptedImages);

    const commentNotes = [...notes];
    if (commentImages.length > acceptedImages.length) {
      commentNotes.push(`some images from this comment were not shown because the poll batch hit the ${account.maxImages}-image limit`);
    }

    if (!text && commentImages.length === 0 && commentNotes.length === 0) continue;

    const body = text || (commentImages.length ? "(image attached in this comment)" : "(image attachment)");
    const speaker = comment?.creator?.name ?? "User";
    const notesLine = commentNotes.length ? `\n[Note: ${commentNotes.join("; ")}.]` : "";
    promptParts.push(`[${speaker}] ${body}${notesLine}`);
  }

  if (promptParts.length === 0) return;

  const reply = await runAgent(api, account, {
    cardNumber,
    senderName: "Users",
    prompt:
      `${contextPrefix}` +
      "The following new comments were picked up together in one poll batch for this card. Treat them as a single conversation burst, ordered oldest to newest.\n\n" +
      promptParts.join("\n\n"),
    images,
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
  ctx: { cardNumber: string; senderName: string; prompt: string; images?: ImageContent[] },
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
    prompt: ctx.prompt,
    images: ctx.images && ctx.images.length ? ctx.images : undefined,
  });
  const parts: string[] = (result?.payloads ?? [])
    .filter((p: any) => p?.text && !p.isError && !p.isReasoning)
    .map((p: any) => String(p.text));
  return parts.join("\n\n").trim();
}
