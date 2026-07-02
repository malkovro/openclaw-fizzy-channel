// Thin Fizzy REST client: read a card (for the column gate) and post a comment.
import type { FizzyAccount } from "./config.js";

export type FizzyCard = {
  number: number;
  title?: string;
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

  // Fetch a card by number. Returns the parsed card (incl. current column) or null on 404.
  async getCard(cardNumber: string | number): Promise<FizzyCard | null> {
    const res = await fetch(`${this.base}/cards/${cardNumber}`, { headers: this.headers() });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`fizzy getCard ${cardNumber} failed: HTTP ${res.status}`);
    return (await res.json()) as FizzyCard;
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
