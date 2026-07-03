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
  FizzyClient
};
