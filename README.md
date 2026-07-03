# openclaw-fizzy-channel

An [OpenClaw](https://openclaw.ai) channel plugin that turns every [Fizzy](https://github.com/basecamp/fizzy) card into a chat channel with the OpenClaw agent — **while the card sits in a chosen kanban column**.

![Chatting with the OpenClaw agent from a Fizzy card — the agent answers from the card's own content](https://raw.githubusercontent.com/malkovro/openclaw-fizzy-channel/main/assets/demo.gif)

- A person writes a comment on the card → the OpenClaw agent replies as a comment.
- The conversation is scoped per card (its own agent session), so context persists across messages.
- Chat is only active while the card is in the configured column.

## How it works

```
Fizzy card comment ──(webhook: comment_created)──▶  /fizzy/webhook
        ▲                                                    │ verify HMAC, gate on column
        │                                                    ▼
        └────────────── POST comment (bot) ◀── runEmbeddedAgent(session = card)
```

- **Inbound** (two modes):
  - `poll` (default here, no tunnel): the gateway pulls Fizzy's activity feed (`GET /:account/activities`) every `pollIntervalMs`, outbound-only. No public URL / SSRF issues.
  - `webhook`: Fizzy's board webhook (`comment_created`) POSTs to the plugin's HTTP route; the plugin verifies the `X-Webhook-Signature` HMAC. Real-time, but needs a gateway URL reachable from Fizzy.
  Either way it then fetches the card to confirm it is in `activeColumnId` and runs an OpenClaw agent turn (`runEmbeddedAgent`) keyed to a per-card session.
- **Outbound**: the agent's reply is posted back as a Fizzy comment via the REST API using a bot access token.
- **No echo loop**: the plugin skips comments authored by the bot itself (matched by `botEmail`, with a `system`-role check as a fallback), so the bot's own replies don't re-trigger it.

## Fizzy setup (once)

1. Create a bot user in the account (a normal **member** so its replies render with a name/avatar) and a **write** access token for it, and grant it board access. Put its email in `botEmail` so the plugin skips its own comments.
2. Create a board **webhook** subscribed to `comment_created` (and optionally `card_triaged`) pointing at `<gateway>/fizzy/webhook`. Note its signing secret.
3. Pick the column id that should be "chat-active".

## Configure the channel

In `openclaw.json`:

```jsonc
{
  "channels": {
    "fizzy": {
      "enabled": true,
      "mode": "poll",                 // "poll" (no tunnel) or "webhook"
      "pollIntervalMs": 5000,          // poll mode
      "boardIds": ["<board id>"],      // poll mode: scope the activity feed (optional)
      "baseUrl": "http://localhost:3006",
      "accountSlug": "1234567",
      "apiToken": "<bot write token>",
      "activeColumnId": "<column id>",
      "botEmail": "openclaw-bot@example.com",
      "greetOnEnter": true
      // "webhookSecret": "<signing secret>"   // required for mode:"webhook" only
    }
  }
}
```

## Install

```bash
# from ClawHub
openclaw plugins install clawhub:@malkovro/openclaw-fizzy-channel
# or from npm
openclaw plugins install @malkovro/openclaw-fizzy-channel
# or from git
openclaw plugins install git:github.com/malkovro/openclaw-fizzy-channel
# or link a local checkout for development
openclaw plugins install -l /path/to/openclaw-fizzy-channel

openclaw plugins enable fizzy
openclaw gateway restart
openclaw channels status --probe fizzy
```

## Reachability (Fizzy → gateway)

**Use `mode: "poll"` and there is nothing to do** — the gateway only makes outbound calls to Fizzy, so no tunnel, public URL, or SSRF exception is needed. This is the recommended mode for local/dev and locked-down networks.

`mode: "webhook"` is real-time but requires Fizzy to reach the gateway. Fizzy's `SsrfProtection` resolves the webhook host via public DNS and refuses private/loopback IPs, so a loopback gateway URL is rejected. For local webhook testing, expose the gateway with a tunnel whose public hostname passes SSRF:

```bash
cloudflared tunnel --url http://127.0.0.1:18789
# -> https://<random>.trycloudflare.com
```

Then set the Fizzy board webhook URL to `https://<random>.trycloudflare.com/fizzy/webhook`.
In production the gateway already has a public URL, so no tunnel is needed.

## Card content in the session

The agent is given the card's content so it can reason about the work item, not just the chat:

- **On thread init** (first message on a card), the prompt is prefixed with a card-context block: title, status, tags, and description.
- **When the card changes**, the next message is prefixed with a short "card was edited: …" delta plus the current content. Editing a card never triggers a reply on its own — the agent just becomes aware of the change the next time it answers.

This reuses the card fetch already done for the column gate (no extra API calls) and is diff-based, so it works even for **description edits, which Fizzy emits no event for** (only title changes are evented). Snapshots are per-card and in-memory, so after a gateway restart the next turn re-grounds with the full card. See `src/cardcontext.ts`.

_Optional (not implemented): to inform a session the instant a card is edited even with no new comment, add a periodic re-fetch of active-session cards and append a transcript note via `openclaw/plugin-sdk/session-transcript-runtime` — at the cost of one card fetch per active session per interval._

## Images (vision)

Images attached to a comment or the card are passed to the agent as real image
input (base64), so a vision-capable model can actually see them — not just read
the (empty) plain-text projection.

- **What's sent**: images in the triggering comment (`body.html`), plus the card
  cover image and images in the card description — the latter deduped per card so
  the same description image isn't re-sent every turn (only on first sight / when
  a new one appears).
- **Fetch**: image `src`s are pulled from the rich-text HTML and fetched
  authenticated as the bot (they're signed ActiveStorage URLs), reusing the card
  fetch already done for the column gate.
- **Fallback (skip + note)**: an image that can't be fetched, isn't an image, or
  is still over `maxImageBytes` after a JPEG downscale is dropped and replaced by
  a short text note (`[Note: comment image 1 (not shown: too large …)]`) so the
  agent knows one exists. Extras beyond `maxImages` are noted the same way.
- **Non-vision models**: set `"sendImages": false`. Images are then never fetched;
  the agent just gets the text note. (There's no reliable way to auto-detect a
  model's vision capability from a plugin, so this is an explicit switch.)

Config knobs (all optional): `sendImages` (default `true`), `maxImages` (default
`6`), `maxImageBytes` (default `5000000`). See `src/images.ts`.

## Sessions / dashboard

Each card is a distinct agent session, registered in the standard session store as
`agent:<agentId>:fizzy:<accountSlug>:<cardNumber>` (transcript id `fizzy-<accountSlug>-<cardNumber>`).
So the conversation is also visible in `openclaw sessions` and openable in the dashboard chat at
`/chat?session=agent:<agentId>:fizzy:<accountSlug>:<cardNumber>`. (Do **not** pass a custom
`sessionFile` to `runEmbeddedAgent` — that bypasses the store and hides the session from the dashboard.)

## Notes / limitations

- The route is served at `<gateway>/fizzy/webhook` (plugin-auth; the plugin verifies the Fizzy HMAC itself).
- The message loop is driven directly via `runEmbeddedAgent` (deterministic: the agent's text reply is posted as a comment). The channel's `outbound.sendText` adapter also posts a comment, so any core-routed message to this channel works too.
