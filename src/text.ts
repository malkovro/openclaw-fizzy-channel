// Minimal text helpers. Fizzy comment bodies are rich-text HTML.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Convert the agent's plain/markdown-ish reply into simple, safe HTML for a Fizzy comment.
// Paragraphs on blank lines; single newlines become <br>. Good enough for chat.
export function textToHtml(text: string): string {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "<p></p>";
  return trimmed
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`)
    .join("");
}
