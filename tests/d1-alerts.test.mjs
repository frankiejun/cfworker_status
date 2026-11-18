import assert from "node:assert/strict";
import { test } from "node:test";
import { collectAccount, collectAll } from "../src/collect.ts";
import { evaluateAlerts } from "../src/notify.ts";
import { defaultConfig } from "../src/store.ts";

const NOW = Date.parse("2026-11-18T09:20:17Z");
const ACCOUNT_ID = "00000000000000000000000000000001";

function snapshot(written = 0, read = 0, offset = 0) {
  return {
    accountId: ACCOUNT_ID,
    collectedAt: new Date(NOW + offset).toISOString(),
    error: null,
    totals: { requests: 0, errors: 0, workersRequests: 0, pagesRequests: 0 },
    scripts: [],
    zones: [],
    zonesError: null,
    quotasError: null,
    quotas: {
      d1RowsWritten: written, d1RowsRead: read, d1StorageBytes: 0,
      kvReads: 0, kvWrites: 0, kvDeletes: 0, kvLists: 0,
      kvStorageBytes: 0, kvKeys: 0,
      aiNeurons: 0, aiRequests: 0, aiInputTokens: 0, aiOutputTokens: 0,
    },
  };
}

function setup(t) {
  t.mock.timers.enable({ apis: ["Date"], now: NOW });
  const config = defaultConfig();
  config.accounts = [{
    id: ACCOUNT_ID, name: "techloong", apiToken: "test-token",
    quotaRequests: 100_000, quotaPeriod: "day",
  }];
  config.notify.wxpush = { enabled: true, url: "https://notify.invalid", token: "test-token" };
  const values = new Map([["config", JSON.stringify(config)]]);
  const writes = [];
  const messages = [];
  const queries = [];
  const control = { written: 0, read: 0, requests: 0, failRead: false, failWrite: false, failNotify: false };
  const env = {
    STATUS_KV: {
      async get(key) {
        if (key === "snapshots" && control.failRead) throw new Error("KV read failed");
        return values.has(key) ? JSON.parse(values.get(key)) : null;
      },
      async put(key, value) {
        if (key === "snapshots" && control.failWrite) throw new Error("KV write failed");
        writes.push(key);
        values.set(key, value);
      },
    },
  };
  t.mock.method(globalThis, "fetch", async (url, init) => {
    if (url === "https://notify.invalid/wxsend") {
      messages.push(JSON.parse(init.body));
      return new Response("", { status: control.failNotify ? 503 : 200 });
    }
    if (url === "https://api.cloudflare.com/client/v4/graphql") {
      const body = JSON.parse(init.body);
      queries.push(body);
      const account = body.query.includes("query Quotas") ? {
        d1AnalyticsAdaptiveGroups: [{ sum: { rowsWritten: control.written, rowsRead: control.read } }],
      } : {
        workersInvocationsAdaptive: [{ dimensions: { scriptName: "test" }, sum: { requests: control.requests } }],
        pagesFunctionsInvocationsAdaptiveGroups: [],
      };
      return Response.json({ data: { viewer: { accounts: [account] } } });
    }
    if (/^https:\/\/api\.cloudflare\.com\/client\/v4\/(zones\?|accounts\/.*\/(workers\/scripts|pages\/projects)$)/.test(url)) {
      return Response.json({ result: [], result_info: { total_pages: 1 } });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
  return { config, env, values, writes, messages, queries, control };
}

async function evaluate(h, current, previous) {
  await evaluateAlerts(h.env, h.config, [current], previous ? { [ACCOUNT_ID]: previous } : {});
}

test("182,100 单次尖峰及恢复到 36,553 均不告警,后续持续越线正常告警并按日去重", async (t) => {
  const h = setup(t);
  await evaluate(h, snapshot(182_100), snapshot(36_271, 0, -300_000));
  await evaluate(h, snapshot(36_553), snapshot(182_100, 0, -300_000));
  assert.equal(h.messages.length, 0);
  assert.deepEqual(h.writes, []);

  await evaluate(h, snapshot(82_000), snapshot(80_000, 0, -300_000));
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].title, /D1 写行数/);
  assert.match(h.messages[0].content, /82,000 \/ 100,000/);
  assert.deepEqual(h.writes, ["alerts"]);
  assert.equal(JSON.parse(h.values.get("alerts"))[`pq:${ACCOUNT_ID}:d1RowsWritten`], NOW / 1000);
  await evaluate(h, snapshot(90_000), snapshot(82_000, 0, -300_000));
  assert.equal(h.messages.length, 1);
});

test("关闭 CPU p99 告警后不发送通知,其他采集数据不受影响", async (t) => {
  const h = setup(t);
  h.config.thresholds.cpuAlertsEnabled = false;
  const current = snapshot();
  current.scripts = [{
    scriptName: "hot-worker", kind: "worker", requests: 10, errors: 0, subrequests: 0,
    cpuUs: 100_000, p50Us: 1_000, p99Us: 9_000, p999Us: 12_000,
  }];

  await evaluate(h, current);

  assert.equal(h.messages.length, 0);
  assert.deepEqual(h.writes, []);
});

test("第一次越线和缺少前一轮快照不告警", async (t) => {
  const h = setup(t);
  await evaluate(h, snapshot(90_000));
  assert.equal(h.messages.length, 0);
});

const invalidPrevious = {
  "昨日快照": () => snapshot(90_000, 0, -86_400_000),
  "同一轮快照": () => snapshot(90_000),
  "未来快照": () => snapshot(90_000, 0, 300_000),
  "无效时间": () => ({ ...snapshot(90_000), collectedAt: "invalid" }),
  "不同账号": () => ({ ...snapshot(90_000, 0, -300_000), accountId: "other" }),
  "采集失败": () => ({ ...snapshot(90_000, 0, -300_000), error: "failed" }),
  "额度查询失败": () => ({ ...snapshot(90_000, 0, -300_000), quotasError: "failed" }),
  "缺少额度": () => ({ ...snapshot(90_000, 0, -300_000), quotas: null }),
  "非有限用量": () => snapshot(NaN, 0, -300_000),
};
for (const [name, make] of Object.entries(invalidPrevious)) {
  test(`${name}不能确认 D1 越线`, async (t) => {
    const h = setup(t);
    await evaluate(h, snapshot(90_000), make());
    assert.equal(h.messages.length, 0);
    assert.deepEqual(h.writes, []);
  });
}

test("当前快照的过期、未来、失败或非有限数据不触发 D1 告警", async (t) => {
  const h = setup(t);
  for (const current of [
    snapshot(90_000, 0, -86_400_000),
    snapshot(90_000, 0, 300_000),
    snapshot(NaN), snapshot(Infinity),
    { ...snapshot(90_000), error: "failed" },
    { ...snapshot(90_000), quotasError: "failed" },
  ]) {
    await evaluate(h, current, snapshot(90_000, 0, -300_000));
  }
  assert.equal(h.messages.length, 0);
});

test("D1 读写行数分别确认,不能用读越线确认写越线", async (t) => {
  const h = setup(t);
  await evaluate(h, snapshot(90_000, 4_500_000), snapshot(30_000, 4_000_000, -300_000));
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].title, /D1 读行数/);
});

test("跨 UTC 日重新确认,昨日告警去重记录不阻止当天正常告警", async (t) => {
  const h = setup(t);
  const yesterday = NOW / 1000 - 86_400;
  h.values.set("alerts", JSON.stringify({ [`pq:${ACCOUNT_ID}:d1RowsWritten`]: yesterday }));
  await evaluate(h, snapshot(90_000), snapshot(90_000, 0, -86_400_000));
  assert.equal(h.messages.length, 0);
  await evaluate(h, snapshot(90_000), snapshot(80_000, 0, -300_000));
  assert.equal(h.messages.length, 1);
});

test("KV 和 Workers 告警不需要第二轮确认,去重状态不会被 D1 覆盖", async (t) => {
  const h = setup(t);
  const current = snapshot(90_000);
  current.quotas.kvWrites = 900;
  current.totals.requests = 90_000;
  await evaluate(h, current);
  assert.equal(h.messages.length, 2);
  await evaluate(h, current, snapshot(80_000, 0, -300_000));
  assert.equal(h.messages.length, 3);
  const state = JSON.parse(h.values.get("alerts"));
  for (const key of [`${ACCOUNT_ID}:quota`, `pq:${ACCOUNT_ID}:kvWrite`, `pq:${ACCOUNT_ID}:d1RowsWritten`]) {
    assert.equal(state[key], NOW / 1000);
  }
});

test("通知失败不写去重状态,后续持续越线可以重试", async (t) => {
  const h = setup(t);
  h.control.failNotify = true;
  await evaluate(h, snapshot(90_000), snapshot(80_000, 0, -300_000));
  assert.deepEqual(h.writes, []);
  h.control.failNotify = false;
  await evaluate(h, snapshot(90_000), snapshot(80_000, 0, -300_000));
  assert.equal(h.messages.length, 2);
  assert.deepEqual(h.writes, ["alerts"]);
});

test("collectAll 在覆盖前读取快照,每轮仍只写一次快照且只查两次 GraphQL", async (t) => {
  const h = setup(t);
  for (const written of [36_271, 182_100, 36_553, 80_000, 82_000]) {
    h.control.written = written;
    await collectAll(h.env);
    t.mock.timers.tick(300_000);
  }
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].content, /82,000/);
  assert.equal(h.writes.filter(key => key === "snapshots").length, 5);
  assert.equal(h.writes.filter(key => key === "alerts").length, 1);
  assert.equal(h.queries.length, 10);
});

test("读取前一快照失败仅暂停 D1 确认,Workers 告警和快照保存仍正常", async (t) => {
  const h = setup(t);
  t.mock.method(console, "error", () => {});
  h.control.failRead = true;
  h.control.written = 182_100;
  h.control.requests = 90_000;
  await collectAll(h.env);
  assert.equal(h.messages.length, 1);
  assert.match(h.messages[0].title, /Workers/);
  assert.deepEqual(h.writes, ["snapshots", "alerts"]);
});

test("快照保存失败不阻止用已有快照确认真实越线", async (t) => {
  const h = setup(t);
  t.mock.method(console, "error", () => {});
  h.values.set("snapshots", JSON.stringify({ [ACCOUNT_ID]: snapshot(80_000, 0, -300_000) }));
  h.control.failWrite = true;
  h.control.written = 90_000;
  await collectAll(h.env);
  assert.equal(h.messages.length, 1);
  assert.deepEqual(h.writes, ["alerts"]);
});

test("Workers 月度统计不改变 D1/KV/AI 的每日统计窗口", async (t) => {
  const h = setup(t);
  const account = { ...h.config.accounts[0], quotaPeriod: "month" };
  const result = await collectAccount(h.env, account);
  assert.equal(result.error, null);
  assert.equal(h.queries.length, 2);
  const usage = h.queries.find(q => q.query.includes("query Usage"));
  const quotas = h.queries.find(q => q.query.includes("query Quotas"));
  assert.equal(usage.variables.start, "2026-11-01T00:00:00.000Z");
  assert.equal(quotas.variables.start, "2026-11-18T00:00:00.000Z");
  assert.equal(usage.variables.end, quotas.variables.end);
});
