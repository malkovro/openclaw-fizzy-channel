import { FizzyClient } from "./client.js";
import { processFizzyEventGroup } from "./inbound.js";
const MAX_PAGES = 10;
let handle = null;
let cursor = null;
let initialized = false;
let fetchRunning = false;
let refetchRequested = false;
let dispatcherPumping = false;
let activeWorkers = 0;
const pendingByCard = /* @__PURE__ */ new Map();
const activeCards = /* @__PURE__ */ new Set();
function startPolling(api, account) {
  stopPolling();
  resetDispatcherState();
  const client = new FizzyClient(account);
  handle = setInterval(() => {
    void tick(api, account, client);
  }, account.pollIntervalMs);
  api.logger?.info?.(
    `[fizzy] poll mode: every ${account.pollIntervalMs}ms, concurrency ${account.pollConcurrency} (boards: ${account.boardIds.join(",") || "all"})`
  );
}
function stopPolling() {
  if (handle) {
    clearInterval(handle);
    handle = null;
  }
}
function resetDispatcherState() {
  cursor = null;
  initialized = false;
  fetchRunning = false;
  refetchRequested = false;
  dispatcherPumping = false;
  activeWorkers = 0;
  pendingByCard.clear();
  activeCards.clear();
}
async function tick(api, account, client) {
  if (fetchRunning) {
    refetchRequested = true;
    return;
  }
  fetchRunning = true;
  try {
    if (!initialized) {
      const items = await client.listActivities(1, account.boardIds);
      cursor = items.length ? String(items[0].id) : "";
      initialized = true;
      api.logger?.info?.(`[fizzy] poll baseline set (cursor=${cursor || "<empty>"})`);
      return;
    }
    const fresh = await fetchNewSince(api, client, cursor ?? "", account.boardIds);
    if (fresh.length === 0) return;
    for (const it of fresh) {
      const id = String(it.id);
      if (id > (cursor ?? "")) cursor = id;
    }
    fresh.sort((a, b) => String(a.id) < String(b.id) ? -1 : 1);
    enqueueFreshActivities(api, account, fresh);
  } catch (err) {
    api.logger?.error?.(`[fizzy] poll tick failed: ${err?.message ?? err}`);
  } finally {
    fetchRunning = false;
    if (refetchRequested && handle) {
      refetchRequested = false;
      void tick(api, account, client);
    }
  }
}
function enqueueFreshActivities(api, account, items) {
  const groups = /* @__PURE__ */ new Map();
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
async function pumpDispatcher(api, account) {
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
function nextPendingCardKey() {
  for (const [cardKey, pending] of pendingByCard) {
    if (pending.length === 0) {
      pendingByCard.delete(cardKey);
      continue;
    }
    if (!activeCards.has(cardKey)) return cardKey;
  }
  return null;
}
async function runCardQueue(api, account, cardKey) {
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
    } catch (err) {
      const ids = group.map((item) => String(item?.id ?? "?")).join(",");
      api.logger?.error?.(`[fizzy] poll group ${ids} failed: ${err?.message ?? err}`);
    }
  }
}
function activityKey(item) {
  const cardUrl = item?.eventable?.card?.url;
  const cardMatch = typeof cardUrl === "string" ? cardUrl.match(/\/cards\/(\d+)/) : null;
  if (cardMatch?.[1]) return `card:${cardMatch[1]}`;
  const directNumber = item?.eventable?.number;
  if (directNumber !== void 0 && directNumber !== null) return `card:${String(directNumber)}`;
  const directUrl = item?.eventable?.url;
  const directMatch = typeof directUrl === "string" ? directUrl.match(/\/cards\/(\d+)/) : null;
  if (directMatch?.[1]) return `card:${directMatch[1]}`;
  return `activity:${String(item?.id ?? "")}:${String(item?.action ?? "")}:${String(item?.eventable?.url ?? "")}`;
}
async function fetchNewSince(api, client, cursor2, boardIds) {
  const collected = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const items = await client.listActivities(page, boardIds);
    if (items.length === 0) break;
    for (const it of items) {
      if (String(it.id) > cursor2) collected.push(it);
    }
    if (String(items[items.length - 1].id) <= cursor2) break;
    if (page === MAX_PAGES) {
      api.logger?.warn?.(`[fizzy] poll hit ${MAX_PAGES}-page cap catching up; some older activity may be skipped`);
    }
  }
  return collected;
}
export {
  startPolling,
  stopPolling
};
