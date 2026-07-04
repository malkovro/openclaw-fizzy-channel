// Thin Fizzy REST client: read a card (for the column gate) and post a comment.
import crypto from "node:crypto";

import type { FizzyAccount } from "./config.js";

// An outbound attachment to embed in a comment body, as one ActionText node.
// Either a remote-image node (public http(s) image URL, embedded verbatim — no
// bytes uploaded) or an sgid node (an ActiveStorage blob we direct-uploaded, so
// Fizzy self-hosts the bytes and renders an inline image / file attachment).
export type OutboundAttachment =
  | { kind: "remote-image"; url: string; contentType: string; caption?: string; width?: number; height?: number }
  | { kind: "sgid"; sgid: string; caption?: string };

// Escape a value for use inside a double-quoted HTML attribute. The attachment
// tag itself is emitted raw (Fizzy's ActionText sanitizer allow-lists it), but
// every attribute value is escaped so a hostile url/caption/sgid cannot break
// out of the attribute or inject a sibling tag.
function escapeAttr(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function renderAttachment(a: OutboundAttachment): string {
  const attrs: string[] = [];
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

// Compose a comment body: the already-escaped/markdown-rendered caption HTML
// (from textToHtml) followed by one ActionText attachment node per item. The
// caption must already be HTML-safe; the attachment tags are raw with
// attribute-escaped values. With no attachments this is just the caption, so
// text-only replies are byte-for-byte unchanged.
export function buildCommentBody(html: string, attachments: OutboundAttachment[] = []): string {
  const nodes = attachments.map(renderAttachment).join("");
  if (!nodes) return html;
  // Drop an empty caption paragraph so an attachment-only reply has no stray <p></p>.
  const caption = html && html !== "<p></p>" ? html : "";
  return `${caption}${nodes}`;
}

export type FizzyCard = {
  number: number;
  title?: string;
  description?: string;
  // Rich-text HTML rendering of the description (carries <img> attachments).
  description_html?: string;
  // Card cover image (absolute ActiveStorage URL), if any.
  image_url?: string | null;
  has_attachments?: boolean;
  tags?: string[];
  status?: string;
  closed?: boolean;
  column?: { id: string; name?: string } | null;
};

export class FizzyClient {
  constructor(private readonly account: FizzyAccount) {}

  private get base(): string {
    return `${this.account.baseUrl}/${this.account.accountSlug}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      Authorization: `Bearer ${this.account.apiToken}`,
      Accept: "application/json",
      ...extra,
    };
  }

  // Fetch one page of the account activity feed (newest first), optionally
  // scoped to boards. Used by poll mode to detect new comments.
  async listActivities(page: number, boardIds: string[] = []): Promise<any[]> {
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
  async getCard(cardNumber: string | number): Promise<FizzyCard | null> {
    const res = await fetch(`${this.base}/cards/${cardNumber}`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`fizzy getCard ${cardNumber} failed: HTTP ${res.status}`);
    return (await res.json()) as FizzyCard;
  }

  // Fetch a binary attachment (image) by URL, authenticated as the bot. Follows
  // ActiveStorage redirects. Returns the bytes + content-type, or null on failure.
  async fetchBinary(url: string): Promise<{ buffer: Buffer; contentType?: string } | null> {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.account.apiToken}` } });
    if (!res.ok) return null;
    const buffer = Buffer.from(await res.arrayBuffer());
    return { buffer, contentType: res.headers.get("content-type") ?? undefined };
  }

  // Upload bytes to Fizzy via the standard Rails ActiveStorage two-step direct
  // upload and return the blob's `attachable_sgid`, which can then be embedded in
  // a comment body as `<action-text-attachment sgid="…">`. The blob is unattached
  // until a saved comment body references its sgid (ActionText attaches on save).
  // Reachable with the bot's write token (same auth as postComment).
  async uploadFile(bytes: Buffer, filename: string, contentType: string): Promise<string> {
    const checksum = crypto.createHash("md5").update(bytes).digest("base64");
    const createRes = await fetch(`${this.base}/rails/active_storage/direct_uploads`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({
        blob: { filename, byte_size: bytes.length, checksum, content_type: contentType },
      }),
    });
    if (!createRes.ok) {
      const text = await createRes.text().catch(() => "");
      throw new Error(`fizzy direct upload create failed: HTTP ${createRes.status} ${text.slice(0, 200)}`);
    }
    const meta = (await createRes.json()) as {
      attachable_sgid?: string;
      direct_upload?: { url?: string; headers?: Record<string, string> };
    };
    const sgid = meta?.attachable_sgid;
    const uploadUrl = meta?.direct_upload?.url;
    if (!sgid || !uploadUrl) {
      throw new Error("fizzy direct upload response missing attachable_sgid/direct_upload.url");
    }
    // Step 2: PUT the raw bytes to the storage service using the headers Rails
    // handed back (content-type, checksum, etc.). Disk service returns 204.
    const putRes = await fetch(uploadUrl, {
      method: "PUT",
      headers: meta.direct_upload?.headers ?? {},
      body: new Uint8Array(bytes),
    });
    if (!putRes.ok) {
      throw new Error(`fizzy direct upload PUT failed: HTTP ${putRes.status}`);
    }
    return sgid;
  }

  // Post a comment (rich-text HTML body) to a card. Returns the created comment id.
  async postComment(cardNumber: string | number, html: string): Promise<string | undefined> {
    const res = await fetch(`${this.base}/cards/${cardNumber}/comments`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ comment: { body: html } }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`fizzy postComment ${cardNumber} failed: HTTP ${res.status} ${text.slice(0, 200)}`);
    }
    try {
      const body = (await res.json()) as { id?: string };
      return body?.id;
    } catch {
      return undefined;
    }
  }
}
