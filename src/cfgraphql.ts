/**
 * Cloudflare GraphQL Analytics client.
 *
 * Two datasets matter for the account's request quota, and they are separate:
 *
 *   workersInvocationsAdaptive            - Workers requests. Reports cumulative
 *                                           CPU in `sum.cpuTimeUs`.
 *   pagesFunctionsInvocationsAdaptiveGroups - Pages Functions requests. Only
 *                                           Pages Functions count; static asset
 *                                           requests are free and never appear here.
 *                                           Note: `sum` has NO cpuTimeUs, so CPU
 *                                           comes from the quantiles alone.
 *
 * Field names below were verified against the live schema via introspection.
 */

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

const USAGE_QUERY = `
  query Usage($accountTag: String!, $start: Time!, $end: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        workersInvocationsAdaptive(
          limit: 200
          filter: { datetime_geq: $start, datetime_leq: $end }
          orderBy: [sum_requests_DESC]
        ) {
          dimensions { scriptName }
          sum { requests errors subrequests cpuTimeUs }
          quantiles { cpuTimeP50 cpuTimeP99 cpuTimeP999 }
        }
        pagesFunctionsInvocationsAdaptiveGroups(
          limit: 200
          filter: { datetime_geq: $start, datetime_leq: $end }
          orderBy: [sum_requests_DESC]
        ) {
          dimensions { scriptName }
          sum { requests errors subrequests }
          quantiles { cpuTimeP50 cpuTimeP99 cpuTimeP999 }
        }
      }
    }
  }
`;

/** Raw per-script row, independent of which dataset it came from. */
export interface RawScriptUsage {
  scriptName: string;
  requests: number;
  errors: number;
  subrequests: number;
  cpuUs: number | null;
  p50Us: number | null;
  p99Us: number | null;
  p999Us: number | null;
}

export interface AccountUsage {
  workers: RawScriptUsage[];
  pages: RawScriptUsage[];
}

interface GraphQLResponse {
  data?: {
    viewer?: {
      accounts?: Array<{
        workersInvocationsAdaptive?: RawRow[];
        pagesFunctionsInvocationsAdaptiveGroups?: RawRow[];
      }>;
    };
  };
  errors?: Array<{ message: string }>;
}

interface RawRow {
  dimensions?: { scriptName?: string | null };
  sum?: {
    requests?: number | null;
    errors?: number | null;
    subrequests?: number | null;
    cpuTimeUs?: number | null;
  } | null;
  quantiles?: {
    cpuTimeP50?: number | null;
    cpuTimeP99?: number | null;
    cpuTimeP999?: number | null;
  } | null;
}

function toRawScriptUsage(row: RawRow): RawScriptUsage {
  return {
    scriptName: row.dimensions?.scriptName ?? "(unknown)",
    requests: row.sum?.requests ?? 0,
    errors: row.sum?.errors ?? 0,
    subrequests: row.sum?.subrequests ?? 0,
    cpuUs: row.sum?.cpuTimeUs ?? null,
    p50Us: row.quantiles?.cpuTimeP50 ?? null,
    p99Us: row.quantiles?.cpuTimeP99 ?? null,
    p999Us: row.quantiles?.cpuTimeP999 ?? null,
  };
}

/**
 * Fetches Workers and Pages Functions usage for one account in a single request.
 * Throws with a readable message on auth errors so the snapshot can record it.
 */
export async function queryAccountUsage(
  apiToken: string,
  accountId: string,
  start: string,
  end: string,
): Promise<AccountUsage> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: USAGE_QUERY,
      variables: { accountTag: accountId, start, end },
    }),
  });

  if (!response.ok) {
    throw new Error(`GraphQL HTTP ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as GraphQLResponse;
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }

  const account = body.data?.viewer?.accounts?.[0];
  if (!account) {
    throw new Error("账号无数据:检查 Account ID 是否正确、Token 是否有 Account Analytics: Read 权限");
  }

  return {
    workers: (account.workersInvocationsAdaptive ?? []).map(toRawScriptUsage),
    pages: (account.pagesFunctionsInvocationsAdaptiveGroups ?? []).map(toRawScriptUsage),
  };
}
