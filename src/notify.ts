import {
  getAlertState,
  saveAlertState,
  secondsUntilUtcMidnight,
  splitDomainKey,
  startOfUtcDaySeconds,
  type AlertState,
} from "./store";
import { FREE_PLAN_DAILY } from "./types";
import type {
  AccountConfig,
  AlertMode,
  Config,
  Env,
  Snapshot,
  TelegramConfig,
  Thresholds,
  WxpushConfig,
} from "./types";

const formatNumber = (n: number) => n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function formatDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours > 0 ? `${hours} 小时 ${minutes} 分` : `${minutes} 分`;
}

async function sendTelegram(cfg: TelegramConfig, title: string, content: string): Promise<void> {
  // Validate up front: an empty token would otherwise build a malformed URL and
  // surface as an opaque "Network connection lost".
  if (!cfg.botToken) throw new Error("未填写 Bot Token");
  if (!cfg.chatId) throw new Error("未填写 Chat ID");

  const response = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: cfg.chatId,
      text: `<b>${escapeHtml(title)}</b>\n${escapeHtml(content)}`,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${detail.slice(0, 180)}`);
  }
}

async function sendWxpush(cfg: WxpushConfig, title: string, content: string): Promise<void> {
  if (!cfg.url) throw new Error("未填写服务地址");
  if (!/^https?:\/\//i.test(cfg.url)) throw new Error("服务地址需以 http:// 或 https:// 开头");
  if (!cfg.token) throw new Error("未填写 Token");

  // Accept either the bare host or the full endpoint: pasting
  // "https://host/wxsend" into the config is the natural thing to do, and
  // appending blindly turned it into ".../wxsend/wxsend" → 404.
  const base = cfg.url.trim().replace(/\/+$/, "").replace(/\/wxsend$/i, "");
  const endpoint = `${base}/wxsend`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: cfg.token, "Content-Type": "application/json" },
    body: JSON.stringify({ title, content }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${detail.slice(0, 180)}`);
  }
}

/**
 * Sends to every enabled channel. Returns one message per failed channel;
 * an empty array means everything went out.
 */
export async function dispatch(
  config: Config,
  title: string,
  content: string,
): Promise<string[]> {
  const tasks: Array<Promise<string | null>> = [];

  if (config.notify.telegram.enabled) {
    tasks.push(
      sendTelegram(config.notify.telegram, title, content)
        .then(() => null)
        .catch((err) => `Telegram: ${errorText(err)}`),
    );
  }
  if (config.notify.wxpush.enabled) {
    tasks.push(
      sendWxpush(config.notify.wxpush, title, content)
        .then(() => null)
        .catch((err) => `wxpush: ${errorText(err)}`),
    );
  }

  if (tasks.length === 0) return ["没有启用任何通知渠道"];

  const results = await Promise.all(tasks);
  return results.filter((entry): entry is string => entry !== null);
}

/** Sends one message through a single channel, for the "send test" button. */
export async function sendTest(
  config: Config,
  channel: "telegram" | "wxpush",
): Promise<string[]> {
  const title = "cfworker-status 测试通知";
  const content = "如果你看到这条消息,说明通知渠道配置成功。";
  const scoped: Config = {
    ...config,
    notify: {
      telegram: { ...config.notify.telegram, enabled: channel === "telegram" },
      wxpush: { ...config.notify.wxpush, enabled: channel === "wxpush" },
    },
  };
  return dispatch(scoped, title, content);
}

/**
 * Timestamps at or after this are still inside the quiet window, so an alert that
 * already fired is suppressed. `daily` resets at UTC midnight; `cooldown` is a
 * rolling window measured back from now.
 */
function alertWindowStart(mode: AlertMode, cooldownMinutes: number, now: Date): number {
  if (mode === "cooldown") {
    return Math.floor(now.getTime() / 1000) - cooldownMinutes * 60;
  }
  return startOfUtcDaySeconds(now);
}

/**
 * Threshold evaluation. The two alert types de-duplicate on different clocks:
 * quota usage only ever grows within a UTC day, so it is capped at one message
 * per day; CPU p99 is a moving statistic, so the user picks between the same
 * daily cap and a rolling cooldown.
 */
export async function evaluateAlerts(env: Env, config: Config, snapshots: Snapshot[]): Promise<void> {
  const state = await getAlertState(env);
  const now = new Date();
  const nowSec = Math.floor(now.getTime() / 1000);
  const quotaWindow = startOfUtcDaySeconds(now);
  const cpuWindow = alertWindowStart(
    config.thresholds.cpuAlertMode,
    config.thresholds.cpuCooldownMinutes,
    now,
  );
  let changed = false;

  const alreadySent = (accountId: string, type: string, windowStart: number) => {
    const last = state[`${accountId}:${type}`];
    return last !== undefined && last >= windowStart;
  };
  const remember = (accountId: string, type: string) => {
    state[`${accountId}:${type}`] = nowSec;
    changed = true;
  };

  for (const snapshot of snapshots) {
    if (snapshot.error) continue;
    const account = config.accounts.find((candidate) => candidate.id === snapshot.accountId);
    if (!account) continue;

    // 1) Workers + Pages 请求数占账号配额
    const quotaPercent =
      account.quotaRequests > 0 ? (snapshot.totals.requests / account.quotaRequests) * 100 : 0;

    if (quotaPercent >= config.thresholds.workersQuotaPercent && !alreadySent(account.id, "quota", quotaWindow)) {
      const periodLabel = account.quotaPeriod === "month" ? "本月" : "今日";
      const content = [
        `账号:${account.name}`,
        `${periodLabel}已用:${formatNumber(snapshot.totals.requests)} / ${formatNumber(account.quotaRequests)} (${quotaPercent.toFixed(1)}%)`,
        `剩余:${formatNumber(Math.max(0, account.quotaRequests - snapshot.totals.requests))}`,
        `重置倒计时:${formatDuration(secondsUntilUtcMidnight())}`,
      ].join("\n");

      const failures = await dispatch(config, `⚠️ ${account.name} Workers 额度预警`, content);
      if (failures.length === 0) remember(account.id, "quota");
    }

    // 2) CPU p99 approaching the runtime limit
    const self = env.SELF_SCRIPT_NAME?.trim();
    const hot = snapshot.scripts.filter((script) => {
      // `__unknown__` is Cloudflare's sentinel for a script name it could not
      // resolve yet: a freshly deployed Worker carries it for an hour or two,
      // then the name is backfilled retroactively. Alerting on that is noise.
      if (script.scriptName === "__unknown__") return false;
      // The panel itself is not what we are monitoring — its own login does
      // PBKDF2, so its p99 sits far above the default threshold.
      if (self && script.scriptName === self) return false;
      return script.p99Us !== null && script.p99Us / 1000 >= config.thresholds.cpuP99Ms;
    });

    if (hot.length > 0 && !alreadySent(account.id, "cpu", cpuWindow)) {
      const lines = hot.slice(0, 5).map((script) => {
        const p99 = (script.p99Us! / 1000).toFixed(2);
        const p999 = script.p999Us !== null ? `,p999 ${(script.p999Us / 1000).toFixed(2)}ms` : "";
        return `• ${script.scriptName} [${script.kind}]: p99 ${p99}ms${p999},请求 ${formatNumber(script.requests)}`;
      });
      if (hot.length > 5) lines.push(`…另有 ${hot.length - 5} 个脚本`);

      const content = [
        `账号:${account.name}`,
        `以下脚本 CPU p99 已达到 ${config.thresholds.cpuP99Ms}ms(Free 计划单次上限 10ms):`,
        ...lines,
      ].join("\n");

      const failures = await dispatch(config, `🔥 ${account.name} CPU 预警`, content);
      if (failures.length === 0) remember(account.id, "cpu");
    }

    // 3) D1 / KV / Workers AI 的免费额度,每项一个独立阈值。
    // 传入同一份 state 就地修改,由本函数末尾统一写回 —— 不能让它自己
    // 再 get/saveAlertState,否则会用一份旧快照整体覆盖,把别的键冲掉。
    await checkPlatformQuotas(config, account, snapshot, state, () => {
      changed = true;
    });
  }

  // At most one write per cycle however many alerts fired — see the note on
  // AlertState in store.ts for why this matters on the free KV plan.
  if (changed) await saveAlertState(env, state);
}

/**
 * D1 / KV / Workers AI 免费额度告警。每项独立阈值、独立去重,**每账号每项每天最多一条**。
 *
 * 六项里有四项(D1 读写行数、KV 写、Neurons)在一个 UTC 天内只增不减,和 Workers 用量
 * 一样"越线就一直在线上",所以按天去重不会漏也不会重复。存储两项是 gauge,会升也会降,
 * 默认不参与告警 —— 见 types.ts 里 storageAlertsEnabled 的说明。
 *
 * 去重状态复用同一个 `alerts` key,键名带 `pq:` 前缀以示区分,不会和现有的
 * `<accountId>:quota` / `<accountId>:cpu` 撞车。
 *
 * 注意:`state` 由调用方传入并就地修改,本函数**不再**自己读写 KV。早先的实现
 * 在这里独立 `getAlertState`/`saveAlertState`,结果它写入的 `pq:` 键会被外层
 * 结束时用一份更早读出的快照整体覆盖而丢失,导致平台额度告警每轮 cron 都重发
 * (等于"每天一次"的设置完全失效)。现在统一由 `evaluateAlerts` 末尾一次写回。
 */
async function checkPlatformQuotas(
  config: Config,
  account: AccountConfig,
  snapshot: Snapshot,
  state: AlertState,
  markChanged: () => void,
): Promise<void> {
  const quotas = snapshot.quotas;
  if (!quotas) return;

  const thresholds = config.thresholds;
  const storageOn = thresholds.storageAlertsEnabled;

  // 与 evaluateAlerts 一致:去重一律用「Unix 秒」。此前这里存的是毫秒级的
  // todayUtc,和别处的秒混用,虽然各自比较不出错,但容易在后续维护里踩坑。
  const nowSec = Math.floor(Date.now() / 1000);

  /**
   * 每项自带阈值和它对应的键。`threshold` 直接取值而不是用字符串索引 Thresholds,
   * 这样新增一项时漏改类型会被编译器抓到,而不是运行时才变成 undefined。
   */
  const items: Array<QuotaItem> = [
    { key: "d1RowsRead", label: "D1 读行数", threshold: thresholds.d1RowsReadPercent, used: quotas.d1RowsRead, limit: FREE_PLAN_DAILY.d1RowsRead, format: formatNumber },
    { key: "d1RowsWritten", label: "D1 写行数", threshold: thresholds.d1RowsWrittenPercent, used: quotas.d1RowsWritten, limit: FREE_PLAN_DAILY.d1RowsWritten, format: formatNumber },
    { key: "d1Storage", label: "D1 存储", threshold: thresholds.d1StoragePercent, used: quotas.d1StorageBytes, limit: FREE_PLAN_DAILY.d1StorageBytes, format: formatBytes, isStorage: true },
    { key: "kvRead", label: "KV 读取", threshold: thresholds.kvReadPercent, used: quotas.kvReads, limit: FREE_PLAN_DAILY.kvReads, format: formatNumber },
    { key: "kvWrite", label: "KV 写入", threshold: thresholds.kvWritePercent, used: quotas.kvWrites, limit: FREE_PLAN_DAILY.kvWrites, format: formatNumber },
    { key: "aiNeurons", label: "Workers AI", threshold: thresholds.aiNeuronsPercent, used: quotas.aiNeurons, limit: FREE_PLAN_DAILY.aiNeurons, format: formatNeurons },
  ];

  for (const item of items) {
    if (!Number.isFinite(item.threshold) || item.limit <= 0) continue;
    // 存储类是 gauge,默认不告警(见 storageAlertsEnabled 的说明)
    if (item.isStorage && !storageOn) continue;

    const percent = (item.used / item.limit) * 100;
    if (percent < item.threshold) continue;

    // 每账号每项每天最多一条:同一天 UTC 内已发过就跳过。
    const stateKey = `pq:${account.id}:${item.key}`;
    if (state[stateKey] !== undefined && state[stateKey] >= startOfUtcDaySeconds()) continue;

    const content = [
      `账号:${account.name}`,
      `${item.label}已达免费额度 ${percent.toFixed(1)}%(阈值 ${item.threshold}%)`,
      `已用:${item.format(item.used)} / ${item.format(item.limit)}`,
      `剩余:${item.format(Math.max(0, item.limit - item.used))}`,
      `重置倒计时:${formatDuration(secondsUntilUtcMidnight())}`,
    ].join("\n");

    const failures = await dispatch(config, `⚠️ ${account.name} ${item.label}额度预警`, content);
    if (failures.length === 0) {
      state[stateKey] = nowSec;
      markChanged();
    }
  }
}

/** 一条平台额度告警的定义。 */
interface QuotaItem {
  /** 去重键的一部分,如 "d1RowsRead"。 */
  key: string;
  label: string;
  threshold: number;
  used: number;
  limit: number;
  format: (n: number) => string;
  /** 存储类是 gauge 而非单调计数,默认不告警。 */
  isStorage?: boolean;
}

function formatNeurons(n: number): string {
  return n.toLocaleString("en-US", { maximumFractionDigits: 1 });
}

/** Bytes → 人类可读。 */
function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

/**
 * Domain expiry reminders. Independent of the usage snapshots — a domain's
 * expiry date comes from the config, not from Cloudflare.
 *
 * De-duplication is per *expiry date*, not per day: entering the reminder window
 * sends exactly one message, and nothing more until the user renews and edits the
 * date, which re-arms it. Without this a 30-day window would push 30 times per
 * domain.
 */
export async function evaluateDomainExpiry(env: Env, config: Config): Promise<void> {
  const settings = Object.entries(config.domains).filter(
    ([, setting]) => setting.remind && setting.expiresAt,
  );
  if (settings.length === 0) return;

  const now = new Date();
  // Measured in whole UTC days so the message does not depend on the cron's hour.
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  const state = await getAlertState(env);
  let changed = false;

  for (const [key, setting] of settings) {
    const expiry = Date.parse(`${setting.expiresAt}T00:00:00Z`);
    if (Number.isNaN(expiry)) continue;

    const daysLeft = Math.round((expiry - todayUtc) / 86_400_000);
    if (daysLeft > config.thresholds.domainExpiryDays) continue;

    const stateKey = `domain:${key}`;
    if (state[stateKey] === expiry) continue;

    const { accountId, domain } = splitDomainKey(key);
    const accountName = config.accounts.find((account) => account.id === accountId)?.name ?? accountId;
    const overdue = daysLeft < 0;
    const content = [
      `域名:${domain}`,
      `账号:${accountName}`,
      `到期日:${setting.expiresAt}`,
      overdue ? `已过期 ${-daysLeft} 天` : `剩余 ${daysLeft} 天`,
    ].join("\n");

    const failures = await dispatch(
      config,
      `${overdue ? "⛔" : "⏰"} ${domain} ${overdue ? "已过期" : "即将到期"}`,
      content,
    );
    if (failures.length === 0) {
      state[stateKey] = expiry;
      changed = true;
    }
  }

  if (changed) await saveAlertState(env, state);
}
