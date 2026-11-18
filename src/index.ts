import {
  clearSessionCookie,
  constantTimeEqual,
  createSession,
  hashPassword,
  isSecureRequest,
  readCookie,
  SESSION_COOKIE,
  sessionCookie,
  verifyPassword,
  verifySession,
} from "./auth";
import { collectAccount, collectAll } from "./collect";
import { sendTest } from "./notify";
import { domainKey, getConfig, getSnapshots, saveConfig, saveSnapshots, splitDomainKey } from "./store";
import type {
  AccountConfig,
  AccountOverview,
  Config,
  DomainSetting,
  Env,
  NotifyConfig,
  PlatformQuotaKey,
  Snapshot,
  Thresholds,
} from "./types";

const MIN_PASSWORD_LENGTH = 8;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }
    // Non-API paths are normally served by the asset worker directly; this is a fallback.
    return env.ASSETS.fetch(request);
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(collectAll(env));
  },
} satisfies ExportedHandler<Env>;

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const path = url.pathname;
  const method = request.method;
  const secure = isSecureRequest(request);
  const config = await getConfig(env);

  // Public routes -----------------------------------------------------------
  if (path === "/api/session" && method === "GET") {
    return json({
      authed: await isAuthed(request, config),
      needsSetup: config.passwordHash === "",
    });
  }
  if (path === "/api/setup" && method === "POST") {
    return handleSetup(request, env, config, secure);
  }
  if (path === "/api/login" && method === "POST") {
    return handleLogin(request, config, secure);
  }
  if (path === "/api/logout" && method === "POST") {
    return jsonWithCookie({ ok: true }, clearSessionCookie(secure));
  }

  // Everything below requires a session --------------------------------------
  if (!(await isAuthed(request, config))) {
    return json({ error: "未登录" }, 401);
  }

  switch (`${method} ${path}`) {
    case "GET /api/overview":
      return handleOverview(env, config);
    case "POST /api/refresh":
      return handleRefresh(env);
    case "GET /api/config":
      return json(publicConfig(config));
    case "PUT /api/config":
      return handleConfigUpdate(request, env, config);
    case "POST /api/config/password":
      return handlePasswordChange(request, env, config, secure);
    case "POST /api/notify/test":
      return handleNotifyTest(request, config);
    default:
      return json({ error: "接口不存在" }, 404);
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleSetup(
  request: Request,
  env: Env,
  config: Config,
  secure: boolean,
): Promise<Response> {
  if (config.passwordHash) return json({ error: "已经初始化过了" }, 400);

  const expected = env.INIT_TOKEN;
  if (!expected) {
    return json(
      { error: "服务端未配置 INIT_TOKEN,请先执行: npx wrangler secret put INIT_TOKEN" },
      500,
    );
  }

  const body = await readJson<{ initToken?: string; password?: string }>(request);
  if (!body) return json({ error: "请求格式错误" }, 400);
  if (!constantTimeEqual(body.initToken ?? "", expected)) {
    return json({ error: "初始化令牌不正确" }, 403);
  }

  const password = body.password ?? "";
  if (password.length < MIN_PASSWORD_LENGTH) {
    return json({ error: `密码至少 ${MIN_PASSWORD_LENGTH} 位` }, 400);
  }

  const updated: Config = { ...config, passwordHash: await hashPassword(password) };
  await saveConfig(env, updated);

  const token = await createSession(updated.passwordHash);
  return jsonWithCookie({ ok: true }, sessionCookie(token, secure));
}

async function handleLogin(request: Request, config: Config, secure: boolean): Promise<Response> {
  if (!config.passwordHash) return json({ error: "尚未初始化" }, 400);

  const body = await readJson<{ password?: string }>(request);
  if (!body || typeof body.password !== "string") {
    return json({ error: "请求格式错误" }, 400);
  }
  if (!(await verifyPassword(body.password, config.passwordHash))) {
    return json({ error: "密码错误" }, 401);
  }

  const token = await createSession(config.passwordHash);
  return jsonWithCookie({ ok: true }, sessionCookie(token, secure));
}

async function handleOverview(env: Env, config: Config): Promise<Response> {
  const stored = await getSnapshots(env);

  // A freshly added account has no snapshot yet — collect just those, once.
  const missing = config.accounts.filter((account) => !stored[account.id]);
  if (missing.length > 0) {
    const fresh = await Promise.all(missing.map((account) => collectAccount(env, account)));
    for (const snapshot of fresh) stored[snapshot.accountId] = snapshot;
    try {
      await saveSnapshots(env, Object.values(stored));
    } catch (err) {
      console.error("保存快照失败", err);
    }
  }

  const accounts = config.accounts.map((account) =>
    toOverview(account, stored[account.id] ?? emptySnapshot(account.id), config.domains),
  );

  return json({ accounts, thresholds: config.thresholds, serverTime: new Date().toISOString() });
}

async function handleRefresh(env: Env): Promise<Response> {
  const snapshots = await collectAll(env);
  const config = await getConfig(env);
  const byId = new Map(snapshots.map((snapshot) => [snapshot.accountId, snapshot]));

  return json({
    accounts: config.accounts.map((account) =>
      toOverview(account, byId.get(account.id) ?? emptySnapshot(account.id), config.domains),
    ),
    thresholds: config.thresholds,
    serverTime: new Date().toISOString(),
  });
}

async function handleConfigUpdate(
  request: Request,
  env: Env,
  current: Config,
): Promise<Response> {
  const body = await readJson<Record<string, unknown>>(request);
  if (!body) return json({ error: "请求格式错误" }, 400);

  // Omitted keys mean "keep what's stored"; the UI always sends the full object,
  // but partial updates keep the API usable from scripts.
  const accounts =
    body.accounts === undefined ? current.accounts : mergeAccounts(current.accounts, body.accounts);
  if (typeof accounts === "string") return json({ error: accounts }, 400);

  const updated: Config = {
    ...current,
    accounts,
    domains: mergeDomains(current.domains, body.domains, accounts),
    notify: mergeNotify(current.notify, body.notify),
    thresholds: mergeThresholds(current.thresholds, body.thresholds),
  };

  await saveConfig(env, updated);
  return json({ ok: true });
}

async function handlePasswordChange(
  request: Request,
  env: Env,
  config: Config,
  secure: boolean,
): Promise<Response> {
  const body = await readJson<{ currentPassword?: string; newPassword?: string }>(request);
  if (!body) return json({ error: "请求格式错误" }, 400);

  if (!(await verifyPassword(body.currentPassword ?? "", config.passwordHash))) {
    return json({ error: "当前密码错误" }, 400);
  }
  const newPassword = body.newPassword ?? "";
  if (newPassword.length < MIN_PASSWORD_LENGTH) {
    return json({ error: `新密码至少 ${MIN_PASSWORD_LENGTH} 位` }, 400);
  }

  const updated: Config = { ...config, passwordHash: await hashPassword(newPassword) };
  await saveConfig(env, updated);

  // The session signing key is derived from the password hash, so every old
  // session is now invalid — hand this client a fresh one.
  const token = await createSession(updated.passwordHash);
  return jsonWithCookie({ ok: true }, sessionCookie(token, secure));
}

async function handleNotifyTest(request: Request, config: Config): Promise<Response> {
  const body = await readJson<{ channel?: string }>(request);
  const channel = body?.channel;
  if (channel !== "telegram" && channel !== "wxpush") {
    return json({ error: "channel 必须是 telegram 或 wxpush" }, 400);
  }

  const failures = await sendTest(config, channel);
  if (failures.length > 0) return json({ error: failures.join("; ") }, 400);
  return json({ ok: true });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

function jsonWithCookie(data: unknown, cookie: string, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Set-Cookie": cookie,
    },
  });
}

async function readJson<T>(request: Request): Promise<T | null> {
  try {
    return (await request.json()) as T;
  } catch {
    return null;
  }
}

async function isAuthed(request: Request, config: Config): Promise<boolean> {
  if (!config.passwordHash) return false;
  const token = readCookie(request, SESSION_COOKIE);
  if (!token) return false;
  return verifySession(token, config.passwordHash);
}

function toOverview(
  account: AccountConfig,
  snapshot: Snapshot,
  settings: Record<string, DomainSetting>,
): AccountOverview {
  const { zones, ...rest } = snapshot;
  return {
    ...rest,
    name: account.name,
    quotaRequests: account.quotaRequests,
    quotaPeriod: account.quotaPeriod,
    domains: zones.map((zone) => {
      const setting = settings[domainKey(account.id, zone.name)];
      return {
        ...zone,
        expiresAt: setting?.expiresAt ?? "",
        remind: setting?.remind ?? false,
      };
    }),
  };
}

function emptySnapshot(accountId: string): Snapshot {
  return {
    accountId,
    collectedAt: new Date().toISOString(),
    error: "尚未采集",
    totals: { requests: 0, errors: 0, workersRequests: 0, pagesRequests: 0 },
    scripts: [],
    zones: [],
    zonesError: null,
    quotas: null,
    quotasError: null,
  };
}

/** Masks secrets; hints let the UI show "already set (…528d5b)". */
function publicConfig(config: Config) {
  const hint = (value: string) => (value ? value.slice(-4) : null);
  return {
    accounts: config.accounts.map((account) => ({
      id: account.id,
      name: account.name,
      apiToken: null,
      apiTokenHint: hint(account.apiToken),
      quotaRequests: account.quotaRequests,
      quotaPeriod: account.quotaPeriod,
    })),
    // Expiry dates are not secrets and are keyed by <accountId>/<domain>, so the
    // UI can round-trip the whole map without knowing which domains exist yet.
    domains: config.domains,
    notify: {
      telegram: {
        enabled: config.notify.telegram.enabled,
        botToken: null,
        botTokenHint: hint(config.notify.telegram.botToken),
        chatId: config.notify.telegram.chatId,
      },
      wxpush: {
        enabled: config.notify.wxpush.enabled,
        url: config.notify.wxpush.url,
        token: null,
        tokenHint: hint(config.notify.wxpush.token),
      },
    },
    thresholds: config.thresholds,
  };
}

/**
 * Merges incoming accounts with the stored ones. A blank `apiToken` means
 * "leave it alone" so the UI never has to round-trip a secret.
 * Returns an error string when the payload is unusable.
 */
function mergeAccounts(
  existing: AccountConfig[],
  incoming: unknown,
): AccountConfig[] | string {
  if (!Array.isArray(incoming)) return "accounts 必须是数组";

  const merged: AccountConfig[] = [];
  const seen = new Set<string>();

  for (const raw of incoming as Array<Record<string, unknown>>) {
    const id = String(raw?.id ?? "").trim();
    if (!/^[0-9a-f]{32}$/i.test(id)) {
      return `Account ID 格式不正确:${id || "(空)"}(应为 32 位十六进制)`;
    }
    if (seen.has(id)) return `Account ID 重复:${id}`;
    seen.add(id);

    const previous = existing.find((candidate) => candidate.id === id);
    const submittedToken = typeof raw.apiToken === "string" ? raw.apiToken.trim() : "";
    const apiToken = submittedToken || previous?.apiToken || "";
    if (!apiToken) return `账号 ${id} 缺少 API Token`;

    const quotaRequests = Number(raw.quotaRequests);
    merged.push({
      id,
      name: String(raw.name ?? "").trim() || id.slice(0, 8),
      apiToken,
      quotaRequests: Number.isFinite(quotaRequests) && quotaRequests > 0 ? quotaRequests : 100_000,
      quotaPeriod: raw.quotaPeriod === "month" ? "month" : "day",
    });
  }

  return merged;
}

const DOMAIN_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Merges the per-domain expiry settings. Keys are `<accountId>/<domain>`, and an
 * entry only survives if it names a still-configured account and carries a real
 * date — a domain with no expiry date is simply absent, which is how the UI tells
 * "not set" from "set". `remind` is meaningless without a date, so it is forced
 * off there rather than stored as a stray `true`.
 */
function mergeDomains(
  existing: Record<string, DomainSetting>,
  incoming: unknown,
  accounts: AccountConfig[],
): Record<string, DomainSetting> {
  if (incoming === undefined) return existing;
  if (incoming === null || typeof incoming !== "object" || Array.isArray(incoming)) return existing;

  const known = new Set(accounts.map((account) => account.id));
  const merged: Record<string, DomainSetting> = {};

  for (const [key, raw] of Object.entries(incoming as Record<string, unknown>)) {
    const { accountId, domain } = splitDomainKey(key);
    if (!accountId || !domain || !known.has(accountId)) continue;

    const value = (raw ?? {}) as Record<string, unknown>;
    const expiresAt = typeof value.expiresAt === "string" ? value.expiresAt.trim() : "";
    if (!DOMAIN_DATE_RE.test(expiresAt) || Number.isNaN(Date.parse(expiresAt))) continue;

    merged[key] = { expiresAt, remind: value.remind === true };
  }

  return merged;
}

function mergeNotify(existing: NotifyConfig, incoming: unknown): NotifyConfig {
  const source = (incoming ?? {}) as Record<string, Record<string, unknown>>;
  // An absent branch means "keep what's stored". The dashboard saves a
  // domains-only payload, and reading a missing `notify` as `{}` would evaluate
  // Boolean(undefined) and silently switch every channel off.
  const telegram = source.telegram;
  const wxpush = source.wxpush;
  const keep = (submitted: unknown, fallback: string) =>
    typeof submitted === "string" && submitted.trim() !== "" ? submitted.trim() : fallback;

  return {
    telegram: telegram
      ? {
          enabled: Boolean(telegram.enabled),
          botToken: keep(telegram.botToken, existing.telegram.botToken),
          chatId:
            typeof telegram.chatId === "string" ? telegram.chatId.trim() : existing.telegram.chatId,
        }
      : { ...existing.telegram },
    wxpush: wxpush
      ? {
          enabled: Boolean(wxpush.enabled),
          url: typeof wxpush.url === "string" ? wxpush.url.trim() : existing.wxpush.url,
          token: keep(wxpush.token, existing.wxpush.token),
        }
      : { ...existing.wxpush },
  };
}

function mergeThresholds(existing: Thresholds, incoming: unknown): Thresholds {
  const source = (incoming ?? {}) as Record<string, unknown>;
  const workersQuotaPercent = Number(source.workersQuotaPercent);
  const cpuP99Ms = Number(source.cpuP99Ms);
  const cooldownMinutes = Number(source.cpuCooldownMinutes);
  const expiryDays = Number(source.domainExpiryDays);
  // Same clamp for every platform-quota percentage: 1–100, absent means "keep".
  const pct = (key: PlatformQuotaKey) => {
    const value = Number(source[key]);
    return Number.isFinite(value) ? Math.min(100, Math.max(1, Math.round(value))) : existing[key];
  };
  return {
    workersQuotaPercent: Number.isFinite(workersQuotaPercent)
      ? Math.min(100, Math.max(1, workersQuotaPercent))
      : existing.workersQuotaPercent,
    cpuAlertsEnabled: source.cpuAlertsEnabled === undefined
      ? existing.cpuAlertsEnabled
      : source.cpuAlertsEnabled === true,
    cpuP99Ms: Number.isFinite(cpuP99Ms) ? Math.min(30000, Math.max(0.1, cpuP99Ms)) : existing.cpuP99Ms,
    // A year ahead is already far past any useful reminder; the lower bound keeps
    // "0 days before" from meaning "only on the day itself, after it may be too late".
    domainExpiryDays: Number.isFinite(expiryDays)
      ? Math.min(365, Math.max(1, Math.round(expiryDays)))
      : existing.domainExpiryDays,
    // Absent means "keep what's stored", same as the numeric fields; anything
    // unrecognised falls back to the safer daily cap.
    cpuAlertMode:
      source.cpuAlertMode === undefined
        ? existing.cpuAlertMode
        : source.cpuAlertMode === "cooldown"
          ? "cooldown"
          : "daily",
    // Capped at a day: beyond that the two modes are the same thing anyway.
    cpuCooldownMinutes: Number.isFinite(cooldownMinutes)
      ? Math.min(1440, Math.max(1, Math.round(cooldownMinutes)))
      : existing.cpuCooldownMinutes,
    d1RowsReadPercent: pct("d1RowsReadPercent"),
    d1RowsWrittenPercent: pct("d1RowsWrittenPercent"),
    d1StoragePercent: pct("d1StoragePercent"),
    kvReadPercent: pct("kvReadPercent"),
    kvWritePercent: pct("kvWritePercent"),
    aiNeuronsPercent: pct("aiNeuronsPercent"),
    // Off unless explicitly ticked: a blindly-sent `true` from a stale browser tab
    // would start pushing storage alerts the user never asked for.
    storageAlertsEnabled: source.storageAlertsEnabled === undefined
      ? existing.storageAlertsEnabled
      : source.storageAlertsEnabled === true,
  };
}
