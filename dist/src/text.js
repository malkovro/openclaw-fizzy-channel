function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function textToHtml(text) {
  const trimmed = (text ?? "").trim();
  if (!trimmed) return "<p></p>";
  return trimmed.split(/\n{2,}/).map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>")}</p>`).join("");
}
export {
  textToHtml
};
