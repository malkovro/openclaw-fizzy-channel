// Poll mode: pull the Fizzy activity feed on an interval instead of receiving
// webhooks. Outbound-only (gateway -> Fizzy), so it needs no public URL / tunnel.
import { FizzyClient } from "./client.js";
import { processFizzyEvent } from "./inbound.js";
import type { FizzyAccount } from "./config.js";

const MAX_PAGES = 10; // safety cap when catching up a large backlog

let handle: ReturnType<typeof setInterval> | null = null;
let cursor: string | null = null; // last-seen activity id (UUIDv7 -> lexicographically ordered)
let initialized = false;
let running = false;

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

async function tick(api: any, account: FizzyAccount, client: FizzyClient): Promise<void> {
  if (running) return; // don't overlap a slow batch with the next tick
  running = true;
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

    // Advance the cursor to the newest id we saw, then process oldest -> newest.
    for (const it of fresh) {
      const id = String(it.id);
      if (id > (cursor ?? "")) cursor = id;
    }
    fresh.sort((a, b) => (String(a.id) < String(b.id) ? -1 : 1));

    await processFreshActivities(api, account, fresh);
  } catch (err: any) {
    api.logger?.error?.(`[fizzy] poll tick failed: ${err?.message ?? err}`);
  } finally {
    running = false;
  }
}

async function processFreshActivities(api: any, account: FizzyAccount, items: ActivityItem[]): Promise<void> {
  const groups = new Map<string, ActivityItem[]>();
  for (const item of items) {
    const key = activityKey(item);
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }

  const tasks = [...groups.values()].map((group) => async () => {
    for (const item of group) {
      try {
        await processFizzyEvent(api, account, item);
      } catch (err: any) {
        api.logger?.error?.(`[fizzy] poll item ${item?.id} failed: ${err?.message ?? err}`);
      }
    }
  });

  await runWithConcurrencyLimit(tasks, account.pollConcurrency);
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

async function runWithConcurrencyLimit(tasks: Array<() => Promise<void>>, limit: number): Promise<void> {
  if (tasks.length === 0) return;
  const workerCount = Math.max(1, Math.min(limit, tasks.length));
  let nextIndex = 0;

  const workers = Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= tasks.length) return;
      await tasks[index]();
    }
  });

  await Promise.all(workers);
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
