// Thin Fizzy REST client: read a card (for the column gate) and post a comment.
import type { FizzyAccount } from "./config.js";

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

  // Post a comment (rich-text HTML body) to a card. Returns the created comment id.
  async postComment(cardNumber: string | number, html: string): Promise<string | undefined> {
    const res = await fetch(`${this.base}/cards/${cardNumber}/comments`, {
      method: "POST",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ body: { html } }),
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
