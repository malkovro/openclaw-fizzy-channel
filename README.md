# openclaw-fizzy-channel

An [OpenClaw](https://openclaw.ai) channel plugin that turns every [Fizzy](https://github.com/basecamp/fizzy) card into a chat channel with the OpenClaw agent — **while the card sits in a chosen kanban column**.

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

- **Inbound**: Fizzy's board webhook (`comment_created`) hits the plugin's HTTP route. The plugin verifies the `X-Webhook-Signature` HMAC, fetches the card to confirm it is in `activeColumnId`, then runs an OpenClaw agent turn (`runEmbeddedAgent`) keyed to a per-card session.
- **Outbound**: the agent's reply is posted back as a Fizzy comment via the REST API using a bot access token.
- **No echo loop**: the plugin skips comments authored by the bot itself (matched by `botEmail`, with a `system`-role check as a fallback), so the bot's own replies don't re-trigger it.

## Fizzy setup (once)

1. Create a bot user in the account (a normal **member** so its replies render with a name/avatar) and a **write** access token for it, and grant it board access. Put its email in `botEmail` so the plugin skips its own comments.
2. Create a board **webhook** subscribed to `comment_created` (and optionally `card_triaged`) pointing at `<gateway>/fizzy/webhook`. Note its signing secret.
3. Pick the column id that should be "chat-active".

## Configure the channel

In `openclaw.json`:

```json
{
  "channels": {
    "fizzy": {
      "baseUrl": "http://localhost:3006",
      "accountSlug": "686465299",
      "apiToken": "<bot write token>",
      "webhookSecret": "<board webhook signing secret>",
      "activeColumnId": "<column id>",
      "greetOnEnter": true
    }
  }
}
```

## Install

```bash
openclaw plugins install -l /path/to/openclaw-fizzy-channel
openclaw plugins enable fizzy
openclaw gateway restart
openclaw channels status --probe fizzy
```

## Reachability (Fizzy → gateway)

Fizzy's `SsrfProtection` resolves the webhook host via public DNS and refuses private/loopback IPs, so a loopback gateway URL is rejected. For local testing, expose the gateway with a tunnel whose public hostname passes SSRF:

```bash
cloudflared tunnel --url http://127.0.0.1:18789
# -> https://<random>.trycloudflare.com
```

Then set the Fizzy board webhook URL to `https://<random>.trycloudflare.com/fizzy/webhook`.
In production the gateway already has a public URL, so no tunnel is needed.

## Sessions / dashboard

Each card is a distinct agent session, registered in the standard session store as
`agent:<agentId>:fizzy:<accountSlug>:<cardNumber>` (transcript id `fizzy-<accountSlug>-<cardNumber>`).
So the conversation is also visible in `openclaw sessions` and openable in the dashboard chat at
`/chat?session=agent:<agentId>:fizzy:<accountSlug>:<cardNumber>`. (Do **not** pass a custom
`sessionFile` to `runEmbeddedAgent` — that bypasses the store and hides the session from the dashboard.)

## Notes / limitations

- The route is served at `<gateway>/fizzy/webhook` (plugin-auth; the plugin verifies the Fizzy HMAC itself).
- The message loop is driven directly via `runEmbeddedAgent` (deterministic: the agent's text reply is posted as a comment). The channel's `outbound.sendText` adapter also posts a comment, so any core-routed message to this channel works too.
