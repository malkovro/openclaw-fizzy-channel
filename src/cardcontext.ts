// Build the card content that is surfaced to the OpenClaw session, and detect
// changes between turns. Content is injected via the prompt (reusing the card
// fetch already done for the column gate), so there are no extra API calls.
import type { FizzyCard } from "./client.js";

export type CardSnapshot = {
  title: string;
  description: string;
  tags: string[];
  status: string;
};

// Per-card snapshot of what the agent was last told (keyed by card number).
// In-memory: on a gateway restart the next turn re-grounds with full context.
const lastSnapshots = new Map<string, CardSnapshot>();

export function snapshotOf(card: FizzyCard): CardSnapshot {
  return {
    title: card.title ?? "",
    description: (card.description ?? "").trim(),
    tags: [...(card.tags ?? [])].sort(),
    status: card.status ?? "",
  };
}

function serialize(s: CardSnapshot): string {
  return JSON.stringify([s.title, s.description, s.tags, s.status]);
}

function block(card: FizzyCard, snap: CardSnapshot): string {
  const lines = [
    `# Fizzy card #${card.number}: ${snap.title || "(untitled)"}`,
    `Status: ${snap.status}${card.closed ? " (closed)" : ""}`,
  ];
  if (snap.tags.length) lines.push(`Tags: ${snap.tags.join(", ")}`);
  lines.push("Description:", snap.description || "(none)");
  return lines.join("\n");
}

// Decide what card context (if any) to prepend to this turn's prompt, and record
// the new snapshot. Returns "" when nothing changed since the last turn.
export function contextPrefixForTurn(cardNumber: string, card: FizzyCard): string {
  const next = snapshotOf(card);
  const prev = lastSnapshots.get(cardNumber);
  lastSnapshots.set(cardNumber, next);

  if (!prev) {
    // Thread init: give the agent the full card.
    return [
      "You are chatting inside the comment thread of a Fizzy card. Card content for context:",
      block(card, next),
      "---",
      "",
    ].join("\n");
  }

  if (serialize(prev) === serialize(next)) return ""; // unchanged

  // Content changed since the last message — inform, don't make it a new topic.
  const changed: string[] = [];
  if (prev.title !== next.title) changed.push(`title → "${next.title}"`);
  if (prev.status !== next.status) changed.push(`status → ${next.status}`);
  if (prev.tags.join(",") !== next.tags.join(",")) changed.push(`tags → ${next.tags.join(", ") || "(none)"}`);
  if (prev.description !== next.description) changed.push("description updated");

  return [
    `[The Fizzy card was edited since the last message: ${changed.join("; ")}. Current card content:]`,
    block(card, next),
    "---",
    "",
  ].join("\n");
}
