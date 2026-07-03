import { marked } from "marked";
function escapeHtml(text) {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function textToHtml(text) {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return "<p></p>";
  return String(marked.parse(escapeHtml(normalized), { gfm: true })).trim();
}
export {
  textToHtml
};
