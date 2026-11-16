import { queryAccountUsage, type RawScriptUsage } from "./cfgraphql";
import { queryPlatformQuotas } from "./cfquotas";
import { fetchPagesScriptNames } from "./cfpages";
import { fetchWorkerScriptNames } from "./cfscripts";
import { fetchZones } from "./cfzones";
import { evaluateAlerts, evaluateDomainExpiry } from "./notify";
import { getConfig, saveSnapshots } from "./store";
import type { AccountConfig, Env, QuotaPeriod, ScriptKind, ScriptUsage, Snapshot } from "./types";

/**
 * Start of the quota period in UTC. Cloudflare's free daily limit resets at
 * midnight UTC, so "today" must be measured the same way.
 */
export function startOfQuotaPeriod(now: Date, period: QuotaPeriod): string {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === "month") start.setUTCDate(1);
  return start.toISOString();
}

function toScriptUsage(kind: ScriptKind, raw: RawScriptUsage): ScriptUsage {
  return {
    scriptName: raw.scriptName,
    kind,
    requests: raw.requests,
    errors: raw.errors,
    subrequests: raw.subrequests,
    cpuUs: raw.cpuUs,
    p50Us: raw.p50Us,
    p99Us: raw.p99Us,
    p999Us: raw.p999Us,
  };
}

/** A zero-usage row for a project the analytics dataset has no entry for. */
function emptyUsage(scriptName: string): RawScriptUsage {
  return {
    scriptName,
    requests: 0,
    errors: 0,
    subrequests: 0,
    cpuUs: null,
    p50Us: null,
    p99Us: null,
    p999Us: null,
  };
}

/**
 * Collects one account. Never throws — failures land in the snapshot's `error`.
 *
 * The platform-quota query is a separate GraphQL request from the Workers/Pages
 * one and is allowed to fail on its own: Cloudflare validates a GraphQL document
 * all-or-nothing, so folding the two together would make a rename in the quota
 * datasets blank out the Workers numbers, which are the panel's main feature.
 */
export async function collectAccount(env: Env, account: AccountConfig): Promise<Snapshot> {
  const now = new Date();
  const collectedAt = now.toISOString();
  const start = startOfQuotaPeriod(now, account.quotaPeriod);

  try {
    const [usage, zones, quotas, workerNames, pages] = await Promise.all([
      queryAccountUsage(account.apiToken, account.id, start, collectedAt),
      // Never throws: a token without Zone:Read must still yield usage data.
      fetchZones(account.apiToken, account.id),
      // Also never throws — a token missing Account Analytics: Read loses the
      // quota table but keeps Workers, Pages and domains.
      queryQuotasSafe(account.apiToken, account.id, start, collectedAt),
      // Backfill sources for zero-usage projects; both never throw. The Pages
      // fetch used to be conditional on there being Pages traffic, but it also
      // supplies the zero-usage project names, so it now always runs.
      fetchWorkerScriptNames(account.apiToken, account.id),
      fetchPagesScriptNames(account.apiToken, account.id),
    ]);

    // Workers with no calls this period never appear in the analytics dataset;
    // backfill them as zero rows so every Worker in the account gets a card.
    const seenWorkers = new Set(usage.workers.map((row) => row.scriptName));
    const workers = [
      ...usage.workers,
      ...workerNames
        .filter((name) => !seenWorkers.has(name))
        .map((name) => emptyUsage(name)),
    ];

    // Same for Pages projects: a project whose Functions were never triggered
    // has no analytics row, so backfill it by project name. The seen-set must
    // be built from *labelled* names — the project only matches its usage row
    // after the internal script name has been translated.
    const labeledPages = usage.pages.map((row) => ({
      ...row,
      scriptName: pages.labels[row.scriptName] ?? row.scriptName,
    }));
    const seenPages = new Set(labeledPages.map((row) => row.scriptName));
    const pagesRows = [
      ...labeledPages,
      ...pages.names
        .filter((name) => !seenPages.has(name) && !seenPages.has(`${name} · preview`))
        .map((name) => emptyUsage(name)),
    ];

    const scripts: ScriptUsage[] = [
      ...workers.map((row) => toScriptUsage("worker", row)),
      ...pagesRows.map((row) => toScriptUsage("pages", row)),
    ].sort((a, b) => b.requests - a.requests);

    let requests = 0;
    let errors = 0;
    let workersRequests = 0;
    let pagesRequests = 0;
    for (const script of scripts) {
      requests += script.requests;
      errors += script.errors;
      if (script.kind === "worker") workersRequests += script.requests;
      else pagesRequests += script.requests;
    }

    return {
      accountId: account.id,
      collectedAt,
      error: null,
      totals: { requests, errors, workersRequests, pagesRequests },
      scripts,
      zones: zones.zones,
      zonesError: zones.error,
      ...quotas,
    };
  } catch (err) {
    // The whole collection failed, so the quota table has nothing to show either.
    // Saying so explicitly keeps the panel from reading a bare null as "this
    // account uses none of D1/KV/Workers AI" — which is what an empty table says.
    return {
      accountId: account.id,
      collectedAt,
      error: err instanceof Error ? err.message : String(err),
      totals: { requests: 0, errors: 0, workersRequests: 0, pagesRequests: 0 },
      scripts: [],
      zones: [],
      zonesError: null,
      quotas: null,
      quotasError: "采集失败,详见上方错误",
    };
  }
}

/**
 * Runs the quota query, turning any failure into a message instead of an
 * exception, and returning exactly the two snapshot fields it fills. D1/KV/
 * Workers AI quotas only matter when those products are in use, so an
 * unavailable dataset must never cost the Workers numbers.
 */
async function queryQuotasSafe(
  apiToken: string,
  accountId: string,
  start: string,
  end: string,
): Promise<Pick<Snapshot, "quotas" | "quotasError">> {
  try {
    return { quotas: await queryPlatformQuotas(apiToken, accountId, start, end), quotasError: null };
  } catch (err) {
    return { quotas: null, quotasError: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Collects every configured account, persists them in a single KV write, then
 * evaluates alert thresholds.
 *
 * The write is deliberately not allowed to break the alert path: if KV hits its
 * daily write limit the snapshots go stale, but alerts must still fire.
 */
export async function collectAll(env: Env): Promise<Snapshot[]> {
  const config = await getConfig(env);

  const snapshots = await Promise.all(
    config.accounts.map((account) => collectAccount(env, account)),
  );

  try {
    await saveSnapshots(env, snapshots);
  } catch (err) {
    console.error("保存快照失败(KV 写入可能已达每日上限)", err);
  }

  await evaluateAlerts(env, config, snapshots);
  // Reads only the config, not the snapshots — a domain's expiry date is typed in
  // by hand, not measured.
  await evaluateDomainExpiry(env, config);
  return snapshots;
}
