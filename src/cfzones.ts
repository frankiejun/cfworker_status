/**
 * Cloudflare zone (domain) listing.
 *
 * `created_on` is the moment the zone was added to Cloudflare, which is the only
 * date the API knows: for a domain registered at another registrar Cloudflare has
 * no registration or expiry date at all. That is why the expiry date is typed in
 * by hand and this field is labelled "接入时间" in the UI.
 *
 * Requires the `Zone → Zone → Read` permission. Without it the list comes back
 * empty and the reason is carried in the snapshot so the UI can say why.
 */

import type { ZoneInfo } from "./types";

const API_BASE = "https://api.cloudflare.com/client/v4";
/** 50 is the maximum the zones endpoint accepts. */
const PER_PAGE = 50;
/** Cap the paging so one account can never eat the subrequest budget. */
const MAX_PAGES = 4;

interface ZonesResponse {
  result?: Array<{ name?: string | null; created_on?: string | null }>;
  result_info?: { total_pages?: number | null };
  errors?: Array<{ message?: string | null }>;
}

export interface ZonesResult {
  zones: ZoneInfo[];
  /** Non-null when the listing failed; `zones` is then empty. */
  error: string | null;
}

/** Lists the account's zones. Never throws — usage collection must not depend on it. */
export async function fetchZones(apiToken: string, accountId: string): Promise<ZonesResult> {
  const zones: ZoneInfo[] = [];

  for (let page = 1; page <= MAX_PAGES; page++) {
    const url = `${API_BASE}/zones?account.id=${accountId}&per_page=${PER_PAGE}&page=${page}&order=name`;
    let body: ZonesResponse;

    try {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${apiToken}` } });
      if (!response.ok) {
        const detail = (await response.json().catch(() => null)) as ZonesResponse | null;
        const message = detail?.errors?.[0]?.message ?? response.statusText;
        return {
          zones: [],
          error: `域名列表读取失败(HTTP ${response.status} ${message})—— Token 可能缺少 Zone → Zone → Read 权限`,
        };
      }
      body = (await response.json()) as ZonesResponse;
    } catch (err) {
      return { zones: [], error: `域名列表读取失败:${err instanceof Error ? err.message : String(err)}` };
    }

    for (const zone of body.result ?? []) {
      if (zone.name) zones.push({ name: zone.name, createdOn: zone.created_on ?? null });
    }

    if (page >= (body.result_info?.total_pages ?? 1)) break;
  }

  return { zones, error: null };
}
