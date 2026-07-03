import { marked } from "marked";

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export function textToHtml(text: string): string {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "<p></p>";

  return String(marked.parse(escapeHtml(normalized), { gfm: true })).trim();
}
