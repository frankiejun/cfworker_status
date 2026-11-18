/** Cloudflare bindings available to the Worker. */
export interface Env {
  /** KV namespace holding the config and the latest snapshots. */
  STATUS_KV: KVNamespace;
  /** Static assets (the frontend). */
  ASSETS: Fetcher;
  /**
   * Required only for the very first setup call. Set it as a secret:
   *   npx wrangler secret put INIT_TOKEN
   * Without it, anyone who finds the URL before you do could claim the panel.
   */
  INIT_TOKEN?: string;
  /**
   * This panel's own Worker name, set in wrangler.jsonc. Kept out of CPU alerts:
   * the panel's login does PBKDF2, so its own p99 sits well above the default
   * threshold and it would otherwise alert on itself. Update it if you rename
   * the Worker.
   */
  SELF_SCRIPT_NAME?: string;
}

export type QuotaPeriod = "day" | "month";

export interface AccountConfig {
  /** Cloudflare account ID (32 hex chars). */
  id: string;
  /** Display name. */
  name: string;
  /** API token with the "Account Analytics: Read" permission. */
  apiToken: string;
  /** Request quota: 100000 for Workers Free, 10000000 for Workers Paid. */
  quotaRequests: number;
  quotaPeriod: QuotaPeriod;
}

export interface TelegramConfig {
  enabled: boolean;
  botToken: string;
  chatId: string;
}

export interface WxpushConfig {
  enabled: boolean;
  /** Base URL of the wxpush service, e.g. https://wxpush.example.workers.dev */
  url: string;
  token: string;
}

export interface NotifyConfig {
  telegram: TelegramConfig;
  wxpush: WxpushConfig;
}

/** How often an alert may repeat for the same account and condition. */
export type AlertMode = "daily" | "cooldown";

/** `Thresholds` 里六个平台额度百分比字段的键。 */
export type PlatformQuotaKey =
  | "d1RowsReadPercent"
  | "d1RowsWrittenPercent"
  | "d1StoragePercent"
  | "kvReadPercent"
  | "kvWritePercent"
  | "aiNeuronsPercent";

/**
 * Workers 免费版的每日额度,平台额度告警的分母。Paid 计划的额度高出一个量级
 * (D1 读 250 亿行/月、KV 读 1,000 万/月),所以这些数字只对免费版有意义 ——
 * 付费账号看到的是"免费版口径下的占比",和仪表盘「平台额度」页一致。
 */
export const FREE_PLAN_DAILY = {
  d1RowsRead: 5_000_000,
  d1RowsWritten: 100_000,
  d1StorageBytes: 5 * 1024 ** 3,
  kvReads: 100_000,
  kvWrites: 1_000,
  aiNeurons: 10_000,
} as const;

export interface Thresholds {
  /** Workers + Pages 请求数达到配额百分比时告警。 */
  workersQuotaPercent: number;
  /** Whether CPU p99 threshold crossings send notifications. */
  cpuAlertsEnabled: boolean;
  /** Alert when any script's CPU p99 reaches this many milliseconds. */
  cpuP99Ms: number;
  /** How many days before a domain's expiry date the reminder fires. */
  domainExpiryDays: number;
  /**
   * Frequency of the CPU alert only. The quota alert has no setting: usage is
   * monotonic within a UTC day, so once it crosses the line it stays across and
   * there is nothing to re-notify about — it is always at most one per day.
   */
  cpuAlertMode: AlertMode;
  /** Quiet period in minutes. Only used when `cpuAlertMode` is `cooldown`. */
  cpuCooldownMinutes: number;
  /**
   * 平台额度告警,每项都是"占免费额度百分比"且每天只推一次。
   *
   * 六项里 D1 读行数、D1 写行数、KV 写、Neurons 在一个 UTC 天内只增不减,和上面的
   * workersQuotaPercent 一样不需要频率设置;D1 存储 / KV 存储是 gauge,会升也会降,
   * 所以下面单独一个开关决定它要不要参与告警 —— 详见 src/notify.ts。
   */
  d1RowsReadPercent: number;
  d1RowsWrittenPercent: number;
  d1StoragePercent: number;
  kvReadPercent: number;
  kvWritePercent: number;
  aiNeuronsPercent: number;
  /**
   * 存储类(gauge)指标是否参与告警。默认关:存储降回阈值以下当天不会再推,开着的话
   * 每次采集都会判断一次,可能变成每次越线都推一条。计数类不受此开关影响。
   */
  storageAlertsEnabled: boolean;
}

/**
 * Per-domain expiry tracking, keyed by `<accountId>/<domain>` in the config.
 * The expiry date is not something Cloudflare knows for domains registered
 * elsewhere, so it is typed in by hand.
 */
export interface DomainSetting {
  /** `YYYY-MM-DD`, or an empty string for "not set". */
  expiresAt: string;
  /** Always false while `expiresAt` is empty — there is nothing to remind about. */
  remind: boolean;
}

export interface Config {
  /** Empty string means "not set up yet". */
  passwordHash: string;
  accounts: AccountConfig[];
  /** Keyed by `<accountId>/<domain>`. Domains with no settings are absent. */
  domains: Record<string, DomainSetting>;
  notify: NotifyConfig;
  thresholds: Thresholds;
}

export type ScriptKind = "worker" | "pages";

/** Per-script usage for the current quota period. */
export interface ScriptUsage {
  scriptName: string;
  kind: ScriptKind;
  requests: number;
  errors: number;
  subrequests: number;
  /** Cumulative CPU time in microseconds. Pages does not report this, so it can be null. */
  cpuUs: number | null;
  /** CPU percentiles in microseconds. */
  p50Us: number | null;
  p99Us: number | null;
  p999Us: number | null;
}

export interface AccountTotals {
  /** Workers + Pages Functions requests — this is what the quota counts. */
  requests: number;
  errors: number;
  workersRequests: number;
  pagesRequests: number;
}

/** One zone (domain) of the account, as listed by the Cloudflare API. */
export interface ZoneInfo {
  name: string;
  /**
   * When the zone was added to Cloudflare, ISO. This is *not* the registrar's
   * registration date — Cloudflare does not know that for domains registered
   * elsewhere — so the UI labels it "接入时间".
   */
  createdOn: string | null;
}

/** Durable Objects / Queues / Vectorize 不在其中的原因见 cfquotas.ts 顶部注释。 */
export interface PlatformQuotas {
  /** D1 当日已读行数。 */
  d1RowsRead: number;
  /** D1 当日已写行数。 */
  d1RowsWritten: number;
  /** D1 账号总存储字节(按 databaseId 求和)。 */
  d1StorageBytes: number;
  /** KV 当日读次数(actionType=read)。 */
  kvReads: number;
  /** KV 当日写次数(actionType=write)。 */
  kvWrites: number;
  /** KV 当日删除次数(actionType=delete)。 */
  kvDeletes: number;
  /** KV 当日列表次数(actionType=list)。 */
  kvLists: number;
  /** KV 账号总存储字节(按 namespaceId 求和)。 */
  kvStorageBytes: number;
  /** KV 账号总键数(按 namespaceId 求和)。 */
  kvKeys: number;
  /** Workers AI 当日消耗的神经元数。 */
  aiNeurons: number;
  /** Workers AI 当日调用次数。 */
  aiRequests: number;
  /** Workers AI 当日输入 tokens。 */
  aiInputTokens: number;
  /** Workers AI 当日输出 tokens。 */
  aiOutputTokens: number;
}

export interface Snapshot {
  accountId: string;
  collectedAt: string;
  /** Non-null when collection failed; the UI surfaces this. */
  error: string | null;
  totals: AccountTotals;
  scripts: ScriptUsage[];
  zones: ZoneInfo[];
  /** Non-null when only the zone listing failed — usually a missing token permission. */
  zonesError: string | null;
  /** Non-null when the platform quota query failed; the Workers data above is still valid. */
  quotasError: string | null;
  /** D1 / KV / Workers AI free-plan usage. Null when the query failed. */
  quotas: PlatformQuotas | null;
}

/** A zone plus the user's expiry settings for it. */
export interface DomainRow extends ZoneInfo, DomainSetting {}

export interface AccountOverview extends Omit<Snapshot, "zones"> {
  name: string;
  quotaRequests: number;
  quotaPeriod: QuotaPeriod;
  domains: DomainRow[];
}
