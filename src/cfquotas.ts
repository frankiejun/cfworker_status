/**
 * 平台额度(GraphQL)客户端 —— D1、KV、Workers AI。
 *
 * 这三个产品的免费额度都是"账号级、每日 UTC 零点重置",所以可以和 Workers 请求数
 * 用同一个口径展示。Durable Objects / Queues / Vectorize 不在这里:
 *   - DO 的真实瓶颈是 13,000 GB-s/天 时长,GraphQL 取不到(实测
 *     `durableObjectsPeriodicGroups.sum.duration` 恒为空),只能量到请求和
 *     SQLite 存储,而请求不是它的收紧项,会造成"看着很安全"的错觉
 *   - Queues / Vectorize 的免费额度是**按月**计的,和这三个的按天口径不同
 *
 * 刻意与 `cfgraphql.ts` 分开,不并进 workersInvocationsAdaptive 那次查询:
 * Cloudflare 的 GraphQL 校验是**全有全无**的 —— selection 里任何字段不存在,整个
 * `data` 直接变 null。并进去的话,这些数据集将来改个名就会把 Workers 请求数
 * (面板的主功能)一起变成空。分开后最坏只是这一块显示读取失败。
 */

const GRAPHQL_ENDPOINT = "https://api.cloudflare.com/client/v4/graphql";

/**
 * D1 的维度名是 `databaseId`,没有库名字段,D1 当前没有单独的 REST 查询调用;
 * 调用方只按汇总数字展示,不显示 per-database 明细。
 */
const QUOTA_QUERY = `
  query Quotas($accountTag: String!, $start: Time!, $end: Time!) {
    viewer {
      accounts(filter: { accountTag: $accountTag }) {
        d1AnalyticsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: $start, datetime_leq: $end }
        ) {
          sum { readQueries writeQueries rowsRead rowsWritten }
        }
        d1StorageAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: $start, datetime_leq: $end }
        ) {
          max { databaseSizeBytes }
          dimensions { databaseId }
        }
        kvOperationsAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: $start, datetime_leq: $end }
        ) {
          sum { requests }
          dimensions { actionType }
        }
        kvStorageAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: $start, datetime_leq: $end }
        ) {
          max { byteCount keyCount }
          dimensions { namespaceId }
        }
        aiInferenceAdaptiveGroups(
          limit: 100
          filter: { datetime_geq: $start, datetime_leq: $end }
        ) {
          count
          sum { totalNeurons totalInputTokens totalOutputTokens }
          dimensions { modelId }
        }
      }
    }
  }
`;

/**
 * 一次查询的原始聚合结果,字段名直接对应 GraphQL 的语义。
 * 命名规则:`d1*` 是 D1,`kv*` 是 KV,`ai*` 是 Workers AI。
 */
export interface QuotaUsage {
  /** D1 当日已读行数(`rowsRead`)。 */
  d1RowsRead: number;
  /** D1 当日已写行数(`rowsWritten`)。 */
  d1RowsWritten: number;
  /** KV 当日读次数。 */
  kvReads: number;
  /** KV 当日写次数(actionType=write)—— 1,000/天这个上限量的就是它。 */
  kvWrites: number;
  /** KV 当日删除次数。 */
  kvDeletes: number;
  /** KV 当日列表次数。 */
  kvLists: number;
  /** D1 账号总存储字节(按 databaseId 求和)。 */
  d1StorageBytes: number;
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

interface GraphQLResponse {
  data?: {
    viewer?: {
      accounts?: Array<Record<string, unknown> | null>;
    };
  };
  errors?: Array<{ message?: string | null }>;
}

interface RawRow {
  sum?: {
    readQueries?: number | null;
    writeQueries?: number | null;
    rowsRead?: number | null;
    rowsWritten?: number | null;
    requests?: number | null;
    totalNeurons?: number | null;
    totalInputTokens?: number | null;
    totalOutputTokens?: number | null;
  } | null;
  max?: {
    databaseSizeBytes?: number | null;
    byteCount?: number | null;
    keyCount?: number | null;
  } | null;
  count?: number | null;
  dimensions?: { actionType?: string | null; databaseId?: string | null; namespaceId?: string | null } | null;
}

/**
 * 拉取一个账号的平台额度。抛错交给调用方降级处理(与 zones 一样,
 * 缺权限或数据集改名都不该让整个采集失败)。
 */
export async function queryPlatformQuotas(
  apiToken: string,
  accountId: string,
  start: string,
  end: string,
): Promise<QuotaUsage> {
  const response = await fetch(GRAPHQL_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query: QUOTA_QUERY,
      variables: { accountTag: accountId, start, end },
    }),
  });

  if (!response.ok) {
    throw new Error(`平台额度查询 HTTP ${response.status} ${response.statusText}`);
  }

  const body = (await response.json()) as GraphQLResponse;
  if (body.errors?.length) {
    throw new Error(body.errors.map((e) => e.message).join("; "));
  }

  const account = body.data?.viewer?.accounts?.[0];
  if (!account) {
    throw new Error("账号无数据:检查 Account ID 是否正确、Token 权限是否包含 Account Analytics: Read");
  }

  const rows = (name: string): RawRow[] =>
    Array.isArray((account as Record<string, unknown>)[name])
      ? ((account as Record<string, unknown>)[name] as RawRow[])
      : [];

  const d1 = rows("d1AnalyticsAdaptiveGroups");
  const d1Storage = rows("d1StorageAdaptiveGroups");
  const kvOps = rows("kvOperationsAdaptiveGroups");
  const kvStorage = rows("kvStorageAdaptiveGroups");
  const ai = rows("aiInferenceAdaptiveGroups");

  const sum = (list: RawRow[], pick: (sum: NonNullable<RawRow["sum"]>) => number | null | undefined): number =>
    list.reduce((total, row) => total + (pick(row.sum ?? {}) ?? 0), 0);

  return {
    d1RowsRead: sum(d1, (s) => s.rowsRead),
    d1RowsWritten: sum(d1, (s) => s.rowsWritten),
    kvReads: kvActionCount(kvOps, "read"),
    kvWrites: kvActionCount(kvOps, "write"),
    kvDeletes: kvActionCount(kvOps, "delete"),
    kvLists: kvActionCount(kvOps, "list"),
    // 存储是 gauge:同一 namespace/库在窗口内只有一行,按分组求和即账号合计
    d1StorageBytes: sumMax(d1Storage, "databaseSizeBytes"),
    kvStorageBytes: sumMax(kvStorage, "byteCount"),
    kvKeys: sumMax(kvStorage, "keyCount"),
    aiNeurons: sum(ai, (s) => s.totalNeurons),
    aiRequests: sumRaw(ai, "count"),
    aiInputTokens: sum(ai, (s) => s.totalInputTokens),
    aiOutputTokens: sum(ai, (s) => s.totalOutputTokens),
  };
}

/** `count` 挂在行上而不是 `sum` 里,单独累加。 */
function sumRaw(rows: RawRow[], key: "count"): number {
  return rows.reduce((total, row) => total + (row[key] ?? 0), 0);
}

/** KV 操作数按 actionType 拆(read/write/delete/list)。 */
function kvActionCount(rows: RawRow[], action: string): number {
  return rows.reduce((total, row) => {
    if ((row.dimensions?.actionType ?? "") === action) return total + (row.sum?.requests ?? 0);
    return total;
  }, 0);
}

function sumMax(rows: RawRow[], field: keyof NonNullable<RawRow["max"]>): number {
  return rows.reduce((total, row) => total + (row.max?.[field] ?? 0), 0);
}
