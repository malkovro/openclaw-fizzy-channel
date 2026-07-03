import { FizzyClient } from "./client.js";
import { processFizzyEvent } from "./inbound.js";
const MAX_PAGES = 10;
let handle = null;
let cursor = null;
let initialized = false;
let running = false;
function startPolling(api, account) {
  stopPolling();
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
async function tick(api, account, client) {
  if (running) return;
  running = true;
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
    await processFreshActivities(api, account, fresh);
  } catch (err) {
    api.logger?.error?.(`[fizzy] poll tick failed: ${err?.message ?? err}`);
  } finally {
    running = false;
  }
}
async function processFreshActivities(api, account, items) {
  const groups = /* @__PURE__ */ new Map();
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
      } catch (err) {
        api.logger?.error?.(`[fizzy] poll item ${item?.id} failed: ${err?.message ?? err}`);
      }
    }
  });
  await runWithConcurrencyLimit(tasks, account.pollConcurrency);
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
async function runWithConcurrencyLimit(tasks, limit) {
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
