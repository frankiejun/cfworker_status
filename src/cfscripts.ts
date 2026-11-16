/**
 * Cloudflare Workers script listing.
 *
 * The usage dataset (`workersInvocationsAdaptive`) only has rows for scripts
 * that were actually invoked — a Worker with no calls this period (a cron that
 * has not fired yet, a freshly deployed one, an idle one) never appears in it.
 * The only way to know "which Workers does this account have" is the REST
 * scripts endpoint, so its names can be backfilled as zero-request rows.
 *
 * Requires the `Workers Scripts: Read` permission. Without it the list comes
 * back empty and zero-usage Workers simply don't get a row — same degradation
 * as the Pages list.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";

interface WorkersScriptsResponse {
  result?: Array<{ id?: string | null }>;
}

/**
 * Returns the account's Worker script names. Never throws — usage collection
 * must not depend on it. An empty array means "could not resolve": callers
 * skip the zero-usage backfill.
 */
export async function fetchWorkerScriptNames(
  apiToken: string,
  accountId: string,
): Promise<string[]> {
  try {
    const response = await fetch(`${API_BASE}/accounts/${accountId}/workers/scripts`, {
      headers: { Authorization: `Bearer ${apiToken}` },
    });

    if (!response.ok) {
      console.warn(
        `Workers 脚本列表读取失败(HTTP ${response.status})—— Token 可能缺少 Workers Scripts: Read 权限,没用量的 Worker 不会出现在明细里`,
      );
      return [];
    }

    const body = (await response.json()) as WorkersScriptsResponse;
    return (body.result ?? [])
      .map((script) => script.id)
      .filter((id): id is string => Boolean(id));
  } catch (err) {
    console.warn(`Workers 脚本列表读取失败:${err instanceof Error ? err.message : String(err)}`);
    return [];
  }
}
