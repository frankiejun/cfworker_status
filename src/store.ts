import type { Config, Env, Snapshot, Thresholds } from "./types";

const CONFIG_KEY = "config";
const SNAPSHOTS_KEY = "snapshots";
const ALERTS_KEY = "alerts";

export function defaultConfig(): Config {
  return {
    passwordHash: "",
    accounts: [],
    domains: {},
    notify: {
      telegram: { enabled: false, botToken: "", chatId: "" },
      wxpush: { enabled: false, url: "", token: "" },
    },
    thresholds: {
      workersQuotaPercent: 80,
      cpuAlertsEnabled: true,
      cpuP99Ms: 8,
      domainExpiryDays: 30,
      cpuAlertMode: "daily",
      cpuCooldownMinutes: 5,
      d1RowsReadPercent: 80,
      d1RowsWrittenPercent: 80,
      d1StoragePercent: 80,
      kvReadPercent: 80,
      kvWritePercent: 80,
      aiNeuronsPercent: 80,
      storageAlertsEnabled: false,
    },
  };
}

/** Config key for one domain's expiry settings. */
export function domainKey(accountId: string, domain: string): string {
  return `${accountId}/${domain}`;
}

/** Inverse of `domainKey`. Domain names contain no slash, so the first one splits it. */
export function splitDomainKey(key: string): { accountId: string; domain: string } {
  const slash = key.indexOf("/");
  if (slash < 0) return { accountId: key, domain: "" };
  return { accountId: key.slice(0, slash), domain: key.slice(slash + 1) };
}

/**
 * Reads the config, filling in anything missing so older configs keep working.
 *
 * `quotaPercent` was renamed to `workersQuotaPercent` when the platform quota
 * alerts were added. A config written under the old name is migrated here rather
 * than dropped: without this, upgrading would silently reset a customised
 * threshold back to the default.
 */
export async function getConfig(env: Env): Promise<Config> {
  const stored = (await env.STATUS_KV.get(CONFIG_KEY, "json")) as Partial<Config> | null;
  const base = defaultConfig();
  if (!stored) return base;

  const rawThresholds = (stored.thresholds ?? {}) as Partial<Thresholds> & {
    quotaPercent?: number;
  };
  const workersQuotaPercent =
    rawThresholds.workersQuotaPercent ?? rawThresholds.quotaPercent ?? base.thresholds.workersQuotaPercent;

  return {
    passwordHash: typeof stored.passwordHash === "string" ? stored.passwordHash : "",
    accounts: Array.isArray(stored.accounts) ? stored.accounts : [],
    domains: stored.domains && typeof stored.domains === "object" ? stored.domains : {},
    notify: {
      telegram: { ...base.notify.telegram, ...(stored.notify?.telegram ?? {}) },
      wxpush: { ...base.notify.wxpush, ...(stored.notify?.wxpush ?? {}) },
    },
    // Built field by field rather than spread from `stored.thresholds`: a config
    // written under the old name still carries `quotaPercent`, and spreading it
    // back in would keep serving a key the rest of the code no longer reads.
    thresholds: {
      workersQuotaPercent: numberOr(workersQuotaPercent, base.thresholds.workersQuotaPercent),
      cpuAlertsEnabled: rawThresholds.cpuAlertsEnabled !== false,
      cpuP99Ms: numberOr(rawThresholds.cpuP99Ms, base.thresholds.cpuP99Ms),
      domainExpiryDays: numberOr(rawThresholds.domainExpiryDays, base.thresholds.domainExpiryDays),
      cpuAlertMode: rawThresholds.cpuAlertMode === "cooldown" ? "cooldown" : "daily",
      cpuCooldownMinutes: numberOr(rawThresholds.cpuCooldownMinutes, base.thresholds.cpuCooldownMinutes),
      d1RowsReadPercent: numberOr(rawThresholds.d1RowsReadPercent, base.thresholds.d1RowsReadPercent),
      d1RowsWrittenPercent: numberOr(
        rawThresholds.d1RowsWrittenPercent,
        base.thresholds.d1RowsWrittenPercent,
      ),
      d1StoragePercent: numberOr(rawThresholds.d1StoragePercent, base.thresholds.d1StoragePercent),
      kvReadPercent: numberOr(rawThresholds.kvReadPercent, base.thresholds.kvReadPercent),
      kvWritePercent: numberOr(rawThresholds.kvWritePercent, base.thresholds.kvWritePercent),
      aiNeuronsPercent: numberOr(rawThresholds.aiNeuronsPercent, base.thresholds.aiNeuronsPercent),
      storageAlertsEnabled: rawThresholds.storageAlertsEnabled === true,
    },
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function saveConfig(env: Env, config: Config): Promise<void> {
  await env.STATUS_KV.put(CONFIG_KEY, JSON.stringify(config));
}

/**
 * Every account's latest snapshot lives under a single key. The free plan allows
 * only 1,000 KV writes per day, so one write per collection cycle keeps the
 * budget flat regardless of how many accounts are configured. (One key per
 * account would blow the limit at four accounts on a 5-minute cron.)
 *
 * Missing fields are filled in the same way `getConfig` does it: a snapshot
 * written before `zones` existed would otherwise hand the UI an undefined array,
 * and one written before `quotas` did must read as "no quota data" rather than
 * crash on a missing property.
 */
export async function getSnapshots(env: Env): Promise<Record<string, Snapshot>> {
  const stored = (await env.STATUS_KV.get(SNAPSHOTS_KEY, "json")) as Record<
    string,
    Partial<Snapshot>
  > | null;
  if (!stored) return {};

  const snapshots: Record<string, Snapshot> = {};
  for (const [accountId, snapshot] of Object.entries(stored)) {
    snapshots[accountId] = {
      ...(snapshot as Snapshot),
      scripts: Array.isArray(snapshot.scripts) ? snapshot.scripts : [],
      zones: Array.isArray(snapshot.zones) ? snapshot.zones : [],
      zonesError: typeof snapshot.zonesError === "string" ? snapshot.zonesError : null,
      quotas: snapshot.quotas && typeof snapshot.quotas === "object" ? snapshot.quotas : null,
      quotasError: typeof snapshot.quotasError === "string" ? snapshot.quotasError : null,
    };
  }
  return snapshots;
}

/** Persists exactly the snapshots passed in — accounts no longer configured drop out. */
export async function saveSnapshots(env: Env, snapshots: Snapshot[]): Promise<void> {
  const map: Record<string, Snapshot> = {};
  for (const snapshot of snapshots) map[snapshot.accountId] = snapshot;
  await env.STATUS_KV.put(SNAPSHOTS_KEY, JSON.stringify(map));
}

/**
 * Alert de-duplication state. Two shapes share the key space:
 *
 *   `"<accountId>:<type>"` -> unix seconds of the last successful send (usage alerts)
 *   `"domain:<accountId>/<domain>"` -> the expiry date already announced, in ms
 *
 * Everything lives under one key on purpose. The free plan allows 1,000 KV
 * writes per day, and a cooldown of a few minutes can fire hundreds of times a
 * day per account — one key per alert would blow that budget, while a single key
 * costs at most one write per collection cycle however many alerts fire.
 */
export type AlertState = Record<string, number>;

export async function getAlertState(env: Env): Promise<AlertState> {
  return ((await env.STATUS_KV.get(ALERTS_KEY, "json")) as AlertState | null) ?? {};
}

export async function saveAlertState(env: Env, state: AlertState): Promise<void> {
  await env.STATUS_KV.put(ALERTS_KEY, JSON.stringify(state));
}

/** Unix seconds at the start of the current UTC day — the quota reset boundary. */
export function startOfUtcDaySeconds(now = new Date()): number {
  return Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) / 1000);
}

export function secondsUntilUtcMidnight(now = new Date()): number {
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.floor((next - now.getTime()) / 1000));
}
