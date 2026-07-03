const lastSnapshots = /* @__PURE__ */ new Map();
function snapshotOf(card) {
  return {
    title: card.title ?? "",
    description: (card.description ?? "").trim(),
    tags: [...card.tags ?? []].sort(),
    status: card.status ?? ""
  };
}
function serialize(s) {
  return JSON.stringify([s.title, s.description, s.tags, s.status]);
}
function block(card, snap) {
  const lines = [
    `# Fizzy card #${card.number}: ${snap.title || "(untitled)"}`,
    `Status: ${snap.status}${card.closed ? " (closed)" : ""}`
  ];
  if (snap.tags.length) lines.push(`Tags: ${snap.tags.join(", ")}`);
  lines.push("Description:", snap.description || "(none)");
  return lines.join("\n");
}
function contextPrefixForTurn(cardNumber, card) {
  const next = snapshotOf(card);
  const prev = lastSnapshots.get(cardNumber);
  lastSnapshots.set(cardNumber, next);
  if (!prev) {
    return [
      "You are chatting inside the comment thread of a Fizzy card. Card content for context:",
      block(card, next),
      "---",
      ""
    ].join("\n");
  }
  if (serialize(prev) === serialize(next)) return "";
  const changed = [];
  if (prev.title !== next.title) changed.push(`title \u2192 "${next.title}"`);
  if (prev.status !== next.status) changed.push(`status \u2192 ${next.status}`);
  if (prev.tags.join(",") !== next.tags.join(",")) changed.push(`tags \u2192 ${next.tags.join(", ") || "(none)"}`);
  if (prev.description !== next.description) changed.push("description updated");
  return [
    `[The Fizzy card was edited since the last message: ${changed.join("; ")}. Current card content:]`,
    block(card, next),
    "---",
    ""
  ].join("\n");
}
export {
  contextPrefixForTurn,
  snapshotOf
};
