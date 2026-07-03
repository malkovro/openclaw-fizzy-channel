// Poll mode: pull the Fizzy activity feed on an interval instead of receiving
// webhooks. Outbound-only (gateway -> Fizzy), so it needs no public URL / tunnel.
import { FizzyClient } from "./client.js";
import { processFizzyEventGroup } from "./inbound.js";
import type { FizzyAccount } from "./config.js";

const MAX_PAGES = 10; // safety cap when catching up a large backlog

let handle: ReturnType<typeof setInterval> | null = null;
let cursor: string | null = null; // last-seen activity id (UUIDv7 -> lexicographically ordered)
let initialized = false;
let fetchRunning = false;
let refetchRequested = false;
let dispatcherPumping = false;
let activeWorkers = 0;
const pendingByCard = new Map<string, ActivityItem[][]>();
const activeCards = new Set<string>();

type ActivityItem = {
  id?: string;
  action?: string;
  eventable?: {
    card?: { url?: string };
    url?: string;
    number?: string | number;
  };
};

export function startPolling(api: any, account: FizzyAccount): void {
  stopPolling();
  resetDispatcherState();
  const client = new FizzyClient(account);
  handle = setInterval(() => {
    void tick(api, account, client);
  }, account.pollIntervalMs);
  api.logger?.info?.(
    `[fizzy] poll mode: every ${account.pollIntervalMs}ms, concurrency ${account.pollConcurrency} (boards: ${account.boardIds.join(",") || "all"})`,
  );
}

export function stopPolling(): void {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}

function resetDispatcherState(): void {
  cursor = null;
  initialized = false;
  fetchRunning = false;
  refetchRequested = false;
  dispatcherPumping = false;
  activeWorkers = 0;
  pendingByCard.clear();
  activeCards.clear();
}

async function tick(api: any, account: FizzyAccount, client: FizzyClient): Promise<void> {
  if (fetchRunning) {
    refetchRequested = true;
    return;
  }

  fetchRunning = true;
  try {
    if (!initialized) {
      // Baseline: remember the newest activity so we only answer messages from now on.
      const items = await client.listActivities(1, account.boardIds);
      cursor = items.length ? String(items[0].id) : "";
      initialized = true;
      api.logger?.info?.(`[fizzy] poll baseline set (cursor=${cursor || "<empty>"})`);
      return;
    }

    const fresh = await fetchNewSince(api, client, cursor ?? "", account.boardIds);
    if (fresh.length === 0) return;

    // Advance the cursor to the newest id we saw, then enqueue oldest -> newest.
    for (const it of fresh) {
      const id = String(it.id);
      if (id > (cursor ?? "")) cursor = id;
    }
    fresh.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));

    enqueueFreshActivities(api, account, fresh);
  } catch (err: any) {
    api.logger?.error?.(`[fizzy] poll tick failed: ${err?.message ?? err}`);
  } finally {
    fetchRunning = false;
    if (refetchRequested && handle) {
      refetchRequested = false;
      void tick(api, account, client);
    }
  }
}

function enqueueFreshActivities(api: any, account: FizzyAccount, items: ActivityItem[]): void {
  const groups = new Map<string, ActivityItem[]>();
  for (const item of items) {
    const key = activityKey(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  for (const [cardKey, group] of groups) {
    const pending = pendingByCard.get(cardKey) ?? [];
    pending.push(group);
    pendingByCard.set(cardKey, pending);
  }

  void pumpDispatcher(api, account);
}

async function pumpDispatcher(api: any, account: FizzyAccount): Promise<void> {
  if (dispatcherPumping) return;
  dispatcherPumping = true;
  try {
    while (activeWorkers < account.pollConcurrency) {
      const nextCardKey = nextPendingCardKey();
      if (!nextCardKey) return;

      activeCards.add(nextCardKey);
      activeWorkers += 1;
      void runCardQueue(api, account, nextCardKey).finally(() => {
        activeCards.delete(nextCardKey);
        activeWorkers -= 1;
        void pumpDispatcher(api, account);
      });
    }
  } finally {
    dispatcherPumping = false;
  }
}

function nextPendingCardKey(): string | null {
  for (const [cardKey, pending] of pendingByCard) {
    if (pending.length === 0) {
      pendingByCard.delete(cardKey);
      continue;
    }
    if (!activeCards.has(cardKey)) return cardKey;
  }
  return null;
}

async function runCardQueue(api: any, account: FizzyAccount, cardKey: string): Promise<void> {
  while (true) {
    const pending = pendingByCard.get(cardKey);
    if (!pending || pending.length === 0) {
      pendingByCard.delete(cardKey);
      return;
    }

    const group = pending.shift();
    if (!group || group.length === 0) continue;

    try {
      await processFizzyEventGroup(api, account, group);
    } catch (err: any) {
      const ids = group.map((item) => String(item?.id ?? "?")).join(",");
      api.logger?.error?.(`[fizzy] poll group ${ids} failed: ${err?.message ?? err}`);
    }
  }
}

function activityKey(item: ActivityItem): string {
  const cardUrl = item?.eventable?.card?.url;
  const cardMatch = typeof cardUrl === "string" ? cardUrl.match(/\/cards\/(\d+)/) : null;
  if (cardMatch?.[1]) return `card:${cardMatch[1]}`;

  const directNumber = item?.eventable?.number;
  if (directNumber !== undefined && directNumber !== null) return `card:${String(directNumber)}`;

  const directUrl = item?.eventable?.url;
  const directMatch = typeof directUrl === "string" ? directUrl.match(/\/cards\/(\d+)/) : null;
  if (directMatch?.[1]) return `card:${directMatch[1]}`;

  return `activity:${String(item?.id ?? "")}:${String(item?.action ?? "")}:${String(item?.eventable?.url ?? "")}`;
}

// Collect activities newer than `cursor` across pages (newest-first feed).
async function fetchNewSince(
  api: any,
  client: FizzyClient,
  cursor: string,
  boardIds: string[],
): Promise<any[]> {
  const collected: any[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await client.listActivities(page, boardIds);
    if (items.length === 0) break;
    for (const it of items) {
      if (String(it.id) > cursor) collected.push(it);
    }
    // Newest-first: if the last (oldest) item on this page is already seen, stop.
    if (String(items[items.length - 1].id) <= cursor) break;
    if (page === MAX_PAGES) {
      api.logger?.warn?.(`[fizzy] poll hit ${MAX_PAGES}-page cap catching up; some older activity may be skipped`);
    }
  }
  return collected;
}
