import crypto from "node:crypto";
function escapeAttr(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}
function renderAttachment(a) {
  const attrs = [];
  if (a.kind === "remote-image") {
    attrs.push(`url="${escapeAttr(a.url)}"`);
    attrs.push(`content-type="${escapeAttr(a.contentType)}"`);
    if (a.width != null) attrs.push(`width="${escapeAttr(String(a.width))}"`);
    if (a.height != null) attrs.push(`height="${escapeAttr(String(a.height))}"`);
  } else {
    attrs.push(`sgid="${escapeAttr(a.sgid)}"`);
  }
  if (a.caption) attrs.push(`caption="${escapeAttr(a.caption)}"`);
  return `<action-text-attachment ${attrs.join(" ")}></action-text-attachment>`;
}
function buildCommentBody(html, attachments = []) {
  const nodes = attachments.map(renderAttachment).join("");
  if (!nodes) return html;
  const caption = html && html !== "<p></p>" ? html : "";
  return `${caption}${nodes}`;
}
class FizzyClient {
  constructor(account) {
    this.account = account;
  }
  get base() {
    return `${this.account.baseUrl}/${this.account.accountSlug}`;
  }
  headers(extra) {
    return {
      Authorization: `Bearer ${this.account.apiToken}`,
      Accept: "application/json",
      ...extra
    };
  }
  // Fetch one page of the account activity feed (newest first), optionally
  // scoped to boards. Used by poll mode to detect new comments.
  async listActivities(page, boardIds = []) {
    const params = new URLSearchParams();
    if (page > 1) params.set("page", String(page));
    for (const id of boardIds) params.append("board_ids[]", id);
    const qs = params.toString();
    const res = await fetch(`${this.base}/activities${qs ? `?${qs}` : ""}`, { headers: this.headers() });
    if (!res.ok) throw new Error(`fizzy listActivities failed: HTTP ${res.status}`);
    const body = await res.json();
    return Array.isArray(body) ? body : [];
  }
  // Fetch a card by number. Returns the parsed card (incl. current column) or null on 404.
  async getCard(cardNumber) {
    const res = await fetch(`${this.base}/cards/${cardNumber}`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`fizzy getCard ${cardNumber} failed: HTTP ${res.status}`);
    return await res.json();
  }
  // Fetch a binary attachment (image) by URL, authenticated as the bot. Follows
  // ActiveStorage redirects. Returns the bytes + content-type, or null on failure.
  async fetchBinary(url) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.account.apiToken}` } });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: res.headers.get("content-type") ?? void 0 };
  }
  // Upload bytes to Fizzy via the standard Rails ActiveStorage two-step direct
  // upload and return the blob's `attachable_sgid`, which can then be embedded in
  // a comment body as `<action-text-attachment sgid="…">`. The blob is unattached
  // until a saved comment body references its sgid (ActionText attaches on save).
  // Reachable with the bot's write token (same auth as postComment).
  async uploadFile(bytes, filename, contentType) {
    const checksum = crypto.createHash("md5").update(bytes).digest("base64");
    const createRes = await fetch(`${this.base}/rails/active_storage/direct_uploads`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        blob: { filename, byte_size: bytes.length, checksum, content_type: contentType }
      })
    });
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => "");
      throw new Error(`fizzy direct upload create failed: HTTP ${createRes.status} ${text.slice(0, 200)}`);
    }
    const meta = await createRes.json();
    const sgid = meta?.attachable_sgid;
    const uploadUrl = meta?.direct_upload?.url;
    if (!sgid || !uploadUrl) {
      throw new Error("fizzy direct upload response missing attachable_sgid/direct_upload.url");
    }
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: meta.direct_upload?.headers ?? {},
      body: new Uint8Array(bytes)
    });
    if (!putRes.ok) {
      throw new Error(`fizzy direct upload PUT failed: HTTP ${putRes.status}`);
    }
    return sgid;
  }
  // Post a comment (rich-text HTML body) to a card. Returns the created comment id.
  async postComment(cardNumber, html) {
    const res = await fetch(`${this.base}/cards/${cardNumber}/comments`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ comment: { body: html } })
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`fizzy postComment ${cardNumber} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    try {
      const body = await res.json();
      return body?.id;
    } catch {
      return void 0;
    }
  }
}
export {
  FizzyClient,
  buildCommentBody
};
