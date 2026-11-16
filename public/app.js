/* ==========================================================================
   cfworker-status — frontend
   Vanilla ES module, no build step. Renders into #app from a single state
   object; every screen is a pure function of that state.
   ========================================================================== */

const THEME_KEY = "cfstatus-theme";

/** Gauge geometry — 270° arc, gap at the bottom. */
const GAUGE_R = 80;
const GAUGE_CIRC = 2 * Math.PI * GAUGE_R;
const GAUGE_ARC = GAUGE_CIRC * 0.75;

const state = {
  view: "loading", // loading | auth | dashboard | config
  needsSetup: false,
  authError: "",
  accounts: [],
  thresholds: { workersQuotaPercent: 80, cpuP99Ms: 8, domainExpiryDays: 30 },
  selectedAccountId: null,
  config: null,
  configTab: "accounts",
  /** Which account cards are unfolded on the config tab, by index. */
  expandedAccounts: new Set(),
  /** Dashboard detail tab: 项目明细 / 平台额度 / 域名明细. */
  detailTab: "scripts",
  /** Dashboard search box contents; non-empty switches the body to results. */
  query: "",
  refreshing: false,
  lastUpdated: null,
};

const app = document.getElementById("app");

/* ---------------------------------------------------------------- helpers */

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c],
  );

const fmtNum = (n) => Number(n ?? 0).toLocaleString("en-US");

/** Microseconds → a compact millisecond string, or an em dash when unknown. */
const fmtMs = (us) => (us === null || us === undefined ? "—" : `${(us / 1000).toFixed(2)}ms`);

function fmtRelative(iso) {
  if (!iso) return "—";
  const seconds = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (seconds < 45) return "刚刚";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  return `${Math.floor(seconds / 86400)} 天前`;
}

/** ISO timestamp → `YYYY-MM-DD` in local time. */
function fmtDay(iso) {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * Whole days from today to a `YYYY-MM-DD` date, or null when unset. Measured in
 * UTC so the badge agrees with the server, which decides the reminder window the
 * same way. Negative means already expired.
 */
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const [year, month, day] = dateStr.split("-").map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  const target = Date.UTC(year, month - 1, day);
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((target - today) / 86400000);
}

function secondsUntilUtcMidnight() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(0, Math.floor((next - now.getTime()) / 1000));
}

/** Seconds until the quota resets — a UTC day boundary, or the 1st for monthly. */
function secondsUntilReset(period) {
  if (period !== "month") return secondsUntilUtcMidnight();
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  return Math.max(0, Math.floor((next - now.getTime()) / 1000));
}

function fmtCountdown(totalSeconds) {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分`;
}

const icons = {
  refresh: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 3v6h-6"/></svg>`,
  settings: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.5-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.6a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z"/></svg>`,
  back: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>`,
  logout: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="M16 17l5-5-5-5"/><path d="M21 12H9"/></svg>`,
  plus: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>`,
  trash: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>`,
  alert: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/><path d="M12 9v4M12 17h.01"/></svg>`,
  shield: `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10Z"/></svg>`,
  moon: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z"/></svg>`,
  sun: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>`,
  chevron: `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`,
  search: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="7"/><path d="M20 20l-3.6-3.6"/></svg>`,
  close: `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>`,
  globe: `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18Z"/></svg>`,
};

/* -------------------------------------------------------------------- api */

async function api(path, { method = "GET", body } = {}) {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });

  let data = null;
  try {
    data = await response.json();
  } catch {
    /* empty or non-JSON body */
  }

  if (!response.ok) {
    const error = new Error(data?.error || `请求失败 (HTTP ${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

function toast(message, kind = "ok") {
  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;
  el.textContent = message;
  document.getElementById("toasts").appendChild(el);
  setTimeout(() => el.remove(), 4200);
}

/* ------------------------------------------------------------------ theme */

function applyTheme() {
  let stored = null;
  try {
    stored = localStorage.getItem(THEME_KEY);
  } catch {
    /* storage unavailable */
  }
  if (stored === "light" || stored === "dark") {
    document.documentElement.setAttribute("data-theme", stored);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
}

function currentTheme() {
  const explicit = document.documentElement.getAttribute("data-theme");
  if (explicit) return explicit;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function toggleTheme() {
  const next = currentTheme() === "dark" ? "light" : "dark";
  try {
    localStorage.setItem(THEME_KEY, next);
  } catch {
    /* storage unavailable */
  }
  applyTheme();
  render();
}

/* --------------------------------------------------------------- rendering */

function render() {
  if (state.view === "loading") {
    app.innerHTML = `<div class="loading-screen"><div class="spinner"></div></div>`;
    return;
  }
  if (state.view === "auth") {
    app.innerHTML = viewAuth();
    return;
  }
  app.innerHTML = state.view === "config" ? viewConfig() : viewDashboard();
}

/* --- auth ----------------------------------------------------------------- */

function viewAuth() {
  const setup = state.needsSetup;
  return `
    <div class="auth-wrap">
      <div class="card auth-card">
        <div class="auth-head">
          <div class="mark">${icons.shield}</div>
          <h1>${setup ? "初始化面板" : "cfworker-status"}</h1>
          <p>${setup ? "设置一个登录密码以完成初始化" : "请输入密码以查看用量数据"}</p>
        </div>
        <form id="auth-form">
          ${
            setup
              ? `<div class="field">
                   <label for="initToken">初始化令牌<span class="hint">部署时设置的 INIT_TOKEN</span></label>
                   <input class="input" id="initToken" name="initToken" type="password" autocomplete="off" required />
                 </div>`
              : ""
          }
          <div class="field">
            <label for="password">${setup ? "设置密码" : "密码"}</label>
            <input class="input" id="password" name="password" type="password"
                   autocomplete="${setup ? "new-password" : "current-password"}" required autofocus />
          </div>
          ${
            setup
              ? `<div class="field">
                   <label for="confirm">确认密码</label>
                   <input class="input" id="confirm" name="confirm" type="password" autocomplete="new-password" required />
                 </div>`
              : ""
          }
          ${
            state.authError
              ? `<div class="banner banner-error">${icons.alert}<span>${esc(state.authError)}</span></div>`
              : ""
          }
          <button class="btn btn-primary" type="submit" style="width:100%;height:38px;margin-top:4px">
            ${setup ? "完成初始化" : "登录"}
          </button>
        </form>
      </div>
    </div>
  `;
}

/* --- dashboard ------------------------------------------------------------ */

function selectedAccount() {
  return state.accounts.find((a) => a.accountId === state.selectedAccountId) ?? state.accounts[0] ?? null;
}

function viewDashboard() {
  return `
    <div class="shell">
      ${topbar()}
      <div id="dash-body">${dashBody()}</div>
    </div>
  `;
}

function topbar() {
  const options = state.accounts
    .map(
      (a) =>
        `<option value="${esc(a.accountId)}"${a.accountId === state.selectedAccountId ? " selected" : ""}>${esc(a.name)}</option>`,
    )
    .join("");

  return `
    <div class="topbar">
      <div class="brand"><span class="brand-dot"></span>cfworker-status</div>
      ${
        state.view === "dashboard" && state.accounts.length > 0
          ? `<select class="select" data-account-select aria-label="选择账号">${options}</select>`
          : ""
      }
      <div class="topbar-actions">
        ${
          state.view === "config"
            ? `<button class="btn" data-action="back">${icons.back}返回</button>`
            : `<button class="btn" data-action="refresh" ${state.refreshing ? "disabled" : ""}>
                 <span class="${state.refreshing ? "spin" : ""}">${icons.refresh}</span>
                 ${state.refreshing ? "刷新中" : "刷新"}
               </button>
               <button class="btn" data-action="config">${icons.settings}配置</button>`
        }
        <button class="btn btn-icon" data-action="theme" title="切换深色/浅色">
          ${currentTheme() === "dark" ? icons.sun : icons.moon}
        </button>
        <button class="btn btn-icon" data-action="logout" title="登出">${icons.logout}</button>
      </div>
    </div>
  `;
}

function dashBody() {
  if (state.accounts.length === 0) {
    return `
      <div class="card center-note">
        <h3>还没有添加账号</h3>
        <p>去配置页添加一个 Cloudflare 账号,填上 Account ID 和 API Token 就能看到用量了。</p>
        <button class="btn btn-primary" data-action="config">前往配置</button>
      </div>
    `;
  }

  const account = selectedAccount();
  if (!account) return "";

  const quota = account.quotaRequests || 0;
  const used = account.totals?.requests ?? 0;
  const percent = quota > 0 ? (used / quota) * 100 : 0;

  return `
    ${account.error ? `<div class="banner banner-error">${icons.alert}<span><strong>采集失败:</strong> ${esc(account.error)}</span></div>` : ""}
    <div class="hero">
      ${gaugeCard(account, percent, used, quota)}
      <div class="hero-side">
        <div class="summary">
          ${tile("Workers 请求", fmtNum(account.totals?.workersRequests ?? 0), "workersInvocationsAdaptive")}
          ${tile("Pages Functions", fmtNum(account.totals?.pagesRequests ?? 0), "pagesFunctionsInvocationsAdaptiveGroups")}
          ${tile("错误数", fmtNum(account.totals?.errors ?? 0), "", (account.totals?.errors ?? 0) > 0)}
          ${tile("最后采集", fmtRelative(account.collectedAt), account.scripts?.length ? `${account.scripts.length} 个脚本` : "")}
        </div>
        ${searchBox()}
      </div>
    </div>
    <div id="dash-lower">${lowerBody()}</div>
  `;
}

/* --- search --------------------------------------------------------------- */

function searchBox() {
  return `
    <div class="search${state.query ? " is-filled" : ""}">
      <span class="search-icon">${icons.search}</span>
      <input class="input search-input" data-search value="${esc(state.query)}"
             placeholder="搜索 Worker 或域名" aria-label="搜索 Worker 或域名" />
      <button class="search-clear" data-action="search-clear" type="button" title="清空搜索" aria-label="清空搜索">${icons.close}</button>
    </div>
  `;
}

/** Everything under the hero. Swapped on its own so the search box keeps focus. */
function lowerBody() {
  if (state.query.trim()) return searchResults();
  const account = selectedAccount();
  return account ? detailTabs(account) : "";
}

/* --- detail tabs ---------------------------------------------------------- */

/** 项目明细 / 平台额度 / 域名明细 share one row of tabs rather than stacking. */
function detailTabs(account) {
  const tab = state.detailTab;
  const known = ["scripts", "quotas", "domains"];
  const active = known.includes(tab) ? tab : "scripts";
  return `
    <div class="tabs detail-tabs">
      <button class="tab${active === "scripts" ? " is-active" : ""}" type="button" data-detail-tab="scripts">项目明细</button>
      <button class="tab${active === "quotas" ? " is-active" : ""}" type="button" data-detail-tab="quotas">平台额度</button>
      <button class="tab${active === "domains" ? " is-active" : ""}" type="button" data-detail-tab="domains">域名明细</button>
    </div>
    ${active === "domains" ? domainsSection(account) : active === "quotas" ? quotasSection(account) : scriptsSection(account)}
  `;
}

function scriptsSection(account) {
  const quota = account.quotaRequests || 0;
  const used = account.totals?.requests ?? 0;
  return `
    <div class="scripts">
      ${
        account.scripts?.length
          ? account.scripts.map((s) => scriptCard(s, quota, used)).join("")
          : `<div class="card center-note" style="padding:34px 20px"><p style="margin:0">这段时间还没有调用记录。</p></div>`
      }
    </div>
  `;
}

/* --- search --------------------------------------------------------------- */

/** Matches Worker/Pages names and domain names across every account. */
function searchResults() {
  const query = state.query.trim().toLowerCase();
  const hits = [];

  for (const account of state.accounts) {
    for (const script of account.scripts ?? []) {
      if (script.scriptName.toLowerCase().includes(query)) hits.push({ type: "script", account, script });
    }
    for (const domain of account.domains ?? []) {
      if (domain.name.toLowerCase().includes(query)) hits.push({ type: "domain", account, domain });
    }
  }

  if (hits.length === 0) {
    return `
      <div class="card center-note">
        <h3>没有匹配的结果</h3>
        <p>没有找到名称包含「${esc(state.query.trim())}」的 Worker、Pages 项目或域名。</p>
      </div>
    `;
  }

  return `
    <div class="section-title">搜索结果 · ${hits.length} 条</div>
    <div class="scripts">
      ${hits.map(searchHit).join("")}
    </div>
  `;
}

function searchHit(hit) {
  const account = hit.account;
  const accountTag = `<span class="hit-account">${icons.shield}<span>${esc(account.name)}</span></span>`;

  if (hit.type === "domain") {
    const days = daysUntil(hit.domain.expiresAt);
    return `
      <button class="script hit" data-goto-account="${esc(account.accountId)}">
        <div class="script-head">
          <span class="script-name mono">${esc(hit.domain.name)}</span>
          <span class="tag tag-worker">域名</span>
          ${accountTag}
          <span class="script-req num">${days === null ? "" : `${days} 天后到期`}</span>
        </div>
      </button>
    `;
  }

  const script = hit.script;
  return `
    <button class="script hit" data-goto-account="${esc(account.accountId)}">
      <div class="script-head">
        <span class="script-name mono">${esc(script.scriptName)}</span>
        <span class="tag tag-${script.kind}">${script.kind === "worker" ? "Worker" : "Pages"}</span>
        ${accountTag}
        <span class="script-req num">${fmtNum(script.requests)}<span class="unit">请求</span></span>
      </div>
    </button>
  `;
}

/* --- domains -------------------------------------------------------------- */

function domainsSection(account) {
  const rows = account.domains ?? [];

  const body = rows.length
    ? `<div class="card domains">${rows.map((domain) => domainRow(account, domain)).join("")}</div>`
    : `<div class="card center-note" style="padding:34px 20px"><p style="margin:0">该账号下没有域名,或还没有采集到。</p></div>`;

  return `
    ${account.zonesError ? `<div class="banner banner-error">${icons.alert}<span>${esc(account.zonesError)}</span></div>` : ""}
    ${body}
  `;
}

function domainRow(account, domain) {
  const key = `${account.accountId}/${domain.name}`;
  const set = Boolean(domain.expiresAt);

  return `
    <div class="domain-row">
      <div class="domain-name mono">${esc(domain.name)}</div>
      <div class="domain-cell">
        <div class="k" title="Cloudflare 只知道域名接入的时间,拿不到注册商那边的真实注册日期">注册时间</div>
        <div class="v num">${fmtDay(domain.createdOn)}</div>
      </div>
      <div class="domain-cell">
        <div class="k">到期时间</div>
        <div class="domain-expiry">
          <input class="input domain-date" type="date" data-domain-expiry="${esc(key)}"
                 value="${esc(domain.expiresAt)}" aria-label="${esc(domain.name)} 到期时间" />
          <span data-domain-badge>${domainBadge(domain)}</span>
        </div>
      </div>
      <div class="domain-cell">
        <div class="k">到期提醒</div>
        <label class="switch${set ? "" : " is-disabled"}">
          <input type="checkbox" data-domain-remind="${esc(key)}"${domain.remind ? " checked" : ""}${set ? "" : " disabled"} />
          <span>${set ? "提醒" : "—"}</span>
        </label>
      </div>
    </div>
  `;
}

/** Days-left hint, coloured once the date is inside the reminder window. */
function domainBadge(domain) {
  const days = daysUntil(domain.expiresAt);
  if (days === null) return `<span class="unset">未设置</span>`;
  if (days < 0) return `<span class="badge-err">已过期 ${-days} 天</span>`;
  if (days <= (state.thresholds.domainExpiryDays || 30)) {
    return `<span class="badge-warn">还有 ${days} 天</span>`;
  }
  return `<span class="muted">还有 ${days} 天</span>`;
}

function gaugeCard(account, percent, used, quota) {
  const isMonth = account.quotaPeriod === "month";
  const threshold = state.thresholds.workersQuotaPercent || 80;
  const color =
    percent >= threshold ? "var(--danger)" : percent >= threshold * 0.75 ? "var(--warn)" : "var(--ok)";
  const filled = (GAUGE_ARC * Math.min(percent, 100)) / 100;
  const remaining = Math.max(0, quota - used);

  return `
    <div class="card gauge-card">
      <div class="gauge">
        <svg viewBox="0 0 200 200" role="img" aria-label="额度使用 ${percent.toFixed(2)}%">
          <circle class="gauge-track" cx="100" cy="100" r="${GAUGE_R}" fill="none"
                  stroke-width="13" stroke-linecap="round"
                  stroke-dasharray="${GAUGE_ARC} ${GAUGE_CIRC}" transform="rotate(135 100 100)" />
          <circle class="gauge-fill" cx="100" cy="100" r="${GAUGE_R}" fill="none"
                  stroke-width="13" stroke-linecap="round" stroke="${color}"
                  stroke-dasharray="${filled} ${GAUGE_CIRC}" transform="rotate(135 100 100)" />
        </svg>
        <div class="gauge-center">
          <div class="gauge-pct num" style="color:${color}">
            ${percent < 1 && percent > 0 ? percent.toFixed(2) : percent.toFixed(1)}<span class="unit">%</span>
          </div>
          <div class="gauge-label">${isMonth ? "本月" : "今日"}额度已用</div>
        </div>
      </div>
      <div class="gauge-stats">
        <div class="gauge-stat">
          <div class="k">已用</div>
          <div class="v num">${fmtNum(used)}</div>
        </div>
        <div class="gauge-stat">
          <div class="k">剩余</div>
          <div class="v num">${fmtNum(remaining)}</div>
        </div>
      </div>
      <div class="reset-line">
        额度 ${fmtNum(quota)} · ${isMonth ? "月初" : "UTC 零点"}重置,还有 ${fmtCountdown(secondsUntilReset(account.quotaPeriod))}
      </div>
    </div>
  `;
}

function tile(label, value, sub, isError = false) {
  return `
    <div class="tile${isError ? " is-error" : ""}">
      <div class="k">${esc(label)}</div>
      <div class="v num">${esc(value)}</div>
      ${sub ? `<div class="sub">${esc(sub)}</div>` : ""}
    </div>
  `;
}

/**
 * 免费额度,全部为"每日 UTC 零点重置"口径。
 * 前端是独立的静态资源、拿不到后端常量,所以这里自己持有一份。
 */
const FREE_DAILY = {
  d1RowsRead: 5e6,
  d1RowsWritten: 1e5,
  d1StorageBytes: 5 * 1024 ** 3,
  kvReads: 1e5,
  kvWrites: 1e3,
  aiNeurons: 1e4,
};

/**
 * 计量表里的每一项。`unit` 只用于显示,占比一律按 limit 现算。
 * `format` 决定数字怎么读:行数和请求数是整数,存储走字节,neurons 是小数。
 */
function quotaRows(quotas) {
  return [
    { key: "d1RowsRead", name: "D1 读行数", used: quotas.d1RowsRead, limit: FREE_DAILY.d1RowsRead, format: "int" },
    { key: "d1RowsWritten", name: "D1 写行数", used: quotas.d1RowsWritten, limit: FREE_DAILY.d1RowsWritten, format: "int" },
    { key: "d1StorageBytes", name: "D1 存储", used: quotas.d1StorageBytes, limit: FREE_DAILY.d1StorageBytes, format: "bytes" },
    { key: "kvReads", name: "KV 读取", used: quotas.kvReads, limit: FREE_DAILY.kvReads, format: "int" },
    { key: "kvWrites", name: "KV 写入", used: quotas.kvWrites, limit: FREE_DAILY.kvWrites, format: "int" },
    { key: "aiNeurons", name: "Workers AI", used: quotas.aiNeurons, limit: FREE_DAILY.aiNeurons, format: "neurons" },
  ];
}

function fmtBytes(bytes) {
  const n = Number(bytes ?? 0);
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n.toFixed(0)} B`;
}

function fmtQuotaValue(value, format) {
  if (format === "bytes") return fmtBytes(value);
  if (format === "neurons") return Number(value ?? 0).toLocaleString("en-US", { maximumFractionDigits: 1 });
  return fmtNum(value);
}

function quotasSection(account) {
  if (account.quotasError) {
    return `<div class="banner banner-error">${icons.alert}<span><strong>平台额度读取失败:</strong> ${esc(account.quotasError)}</span></div>`;
  }
  if (!account.quotas) {
    return `
      <div class="card center-note" style="padding:34px 20px">
        <p style="margin:0">还没有采集到 D1 / KV / Workers AI 的用量。</p>
      </div>
    `;
  }

  const rows = quotaRows(account.quotas);
  return `
    <div class="banner">${icons.alert}<span>均为 <strong>Workers 免费版</strong>额度,<strong>每日 UTC 零点</strong>重置,与上方请求数同一口径。存储类指标取账号内所有数据库/命名空间的合计。</span></div>
    <div class="quotas">
      ${rows.map(quotaCard).join("")}
    </div>
  `;
}

/** Percentage bar in the same 5px idiom as the script cards. */
function quotaCard(row) {
  const percent = row.limit > 0 ? (row.used / row.limit) * 100 : 0;
  const color = percent >= 90 ? "var(--danger)" : percent >= 60 ? "var(--warn)" : "var(--ok)";
  const used = fmtQuotaValue(row.used, row.format);
  const limit = fmtQuotaValue(row.limit, row.format);
  // Same floor as the script cards: 0.3% of a 5 GB D1 quota is ~0 px, so any
  // real usage still shows a sliver rather than reading as "empty".
  const width = Math.min(100, Math.max(percent, row.used > 0 ? 1.5 : 0));

  return `
    <div class="quota">
      <div class="quota-head">
        <span class="quota-name">${esc(row.name)}</span>
        <span class="quota-used num">${esc(used)}<span class="unit">/ ${esc(limit)}</span></span>
      </div>
      <div class="bar"><i style="width:${width}%;background:${color}"></i></div>
      <div class="quota-metrics">
        <div class="quota-metric"><div class="k">已用</div><div class="v num">${percent < 0.01 && percent > 0 ? "<0.01" : percent.toFixed(2)}%</div></div>
        <div class="quota-metric"><div class="k">剩余</div><div class="v num">${esc(fmtQuotaValue(Math.max(0, row.limit - row.used), row.format))}</div></div>
      </div>
    </div>
  `;
}

function scriptCard(script, quota, accountUsed) {
  const share = quota > 0 ? (script.requests / quota) * 100 : 0;
  const hot = script.p99Us !== null && script.p99Us / 1000 >= state.thresholds.cpuP99Ms;

  return `
    <div class="script${hot ? " is-hot" : ""}">
      <div class="script-head">
        <span class="script-name mono">${esc(script.scriptName)}</span>
        <span class="tag tag-${script.kind}">${script.kind === "worker" ? "Worker" : "Pages"}</span>
        ${script.errors > 0 ? `<span class="badge-err">${fmtNum(script.errors)} 错误</span>` : ""}
        ${hot ? `<span class="badge-err">${icons.alert}</span>` : ""}
        <span class="script-req num">${fmtNum(script.requests)}<span class="unit">请求</span></span>
      </div>
      <div class="bar"><i style="width:${Math.max(share, script.requests > 0 ? 1.5 : 0)}%"></i></div>
      <div class="metrics">
        <div class="metric"><div class="k">CPU p50</div><div class="v num">${fmtMs(script.p50Us)}</div></div>
        <div class="metric${hot ? " is-hot" : ""}"><div class="k">CPU p99</div><div class="v num">${fmtMs(script.p99Us)}</div></div>
        <div class="metric"><div class="k">CPU p999</div><div class="v num">${fmtMs(script.p999Us)}</div></div>
        <div class="metric"><div class="k">累计 CPU</div><div class="v num">${script.cpuUs === null ? "—" : `${(script.cpuUs / 1000).toFixed(0)}ms`}</div></div>
        <div class="metric"><div class="k">子请求</div><div class="v num">${fmtNum(script.subrequests)}</div></div>
        <div class="metric"><div class="k">占额度</div><div class="v num">${share < 0.01 && share > 0 ? "<0.01" : share.toFixed(2)}%</div></div>
      </div>
    </div>
  `;
}

/* --- config --------------------------------------------------------------- */

function viewConfig() {
  return `
    <div class="shell">
      ${topbar()}
      <div class="tabs">
        ${configTab("accounts", "账号管理")}
        ${configTab("notify", "通知设置")}
        ${configTab("thresholds", "告警阈值")}
        ${configTab("password", "修改密码")}
      </div>
      <div class="card card-pad">
        ${state.config ? configPanel() : `<div class="center-note"><div class="spinner" style="margin:0 auto"></div></div>`}
      </div>
    </div>
  `;
}

function configTab(key, label) {
  return `<button class="tab${state.configTab === key ? " is-active" : ""}" data-tab="${key}">${label}</button>`;
}

function configPanel() {
  switch (state.configTab) {
    case "notify":
      return panelNotify();
    case "thresholds":
      return panelThresholds();
    case "password":
      return panelPassword();
    default:
      return panelAccounts();
  }
}

function panelAccounts() {
  const rows = state.config.accounts
    .map((account, index) => {
      const expanded = state.expandedAccounts.has(index);
      const summary = [
        account.id ? `${account.id.slice(0, 8)}…` : "未填写 Account ID",
        `${fmtNum(account.quotaRequests)}/${account.quotaPeriod === "month" ? "月" : "天"}`,
      ].join(" · ");

      return `
      <div class="account-item">
        <div class="account-item-head">
          <button class="account-toggle" type="button" data-toggle-account="${index}" aria-expanded="${expanded}">
            <span class="chev${expanded ? " is-open" : ""}">${icons.chevron}</span>
            <strong>${esc(account.name || `账号 ${index + 1}`)}</strong>
            <span class="account-summary">${esc(summary)}</span>
          </button>
          <button class="btn btn-danger" data-remove-account="${index}">${icons.trash}删除</button>
        </div>
        <div class="account-body"${expanded ? "" : " hidden"}>
          <div class="field-row">
            <div class="field">
              <label>名称</label>
              <input class="input" data-path="accounts.${index}.name" value="${esc(account.name)}" placeholder="例如:主账号" />
            </div>
            <div class="field">
              <label>Account ID<span class="hint">32 位十六进制</span></label>
              <input class="input mono" data-path="accounts.${index}.id" value="${esc(account.id)}" placeholder="a1b2c3…" />
            </div>
          </div>
          <div class="field">
            <label>API Token<span class="hint">需要 Account Analytics: Read 和 Zone: Read 权限</span></label>
            <input class="input" type="password" data-path="accounts.${index}.apiToken" value="${esc(account.apiToken ?? "")}"
                   placeholder="${account.apiTokenHint ? `已设置(尾号 ${esc(account.apiTokenHint)}),留空不改动` : "粘贴 API Token"}" />
          </div>
          <div class="field-row">
            <div class="field">
              <label>额度</label>
              <input class="input" type="number" min="1" data-path="accounts.${index}.quotaRequests" data-type="number" value="${account.quotaRequests}" />
            </div>
            <div class="field">
              <label>额度周期</label>
              <select class="input" data-path="accounts.${index}.quotaPeriod">
                <option value="day"${account.quotaPeriod === "day" ? " selected" : ""}>每日 (Free 100,000/天)</option>
                <option value="month"${account.quotaPeriod === "month" ? " selected" : ""}>每月 (Paid 10,000,000/月)</option>
              </select>
            </div>
          </div>
        </div>
      </div>`;
    })
    .join("");

  return `
    ${rows || `<div class="center-note" style="padding:30px 0"><p style="margin:0">还没有账号,点击下方按钮添加。</p></div>`}
    <button class="btn" data-add-account>${icons.plus}添加账号</button>
    ${saveBar()}
  `;
}

function panelNotify() {
  const { telegram, wxpush } = state.config.notify;
  return `
    <div class="notify-head">
      <h3>Telegram</h3>
      <label class="switch"><input type="checkbox" data-path="notify.telegram.enabled"${telegram.enabled ? " checked" : ""} /><span>启用</span></label>
    </div>
    <div class="field">
      <label>Bot Token</label>
      <input class="input" type="password" data-path="notify.telegram.botToken" value="${esc(telegram.botToken ?? "")}"
             placeholder="${telegram.botTokenHint ? `已设置(尾号 ${esc(telegram.botTokenHint)}),留空不改动` : "123456:ABC-DEF…"}" />
    </div>
    <div class="field">
      <label>Chat ID</label>
      <input class="input mono" data-path="notify.telegram.chatId" value="${esc(telegram.chatId)}" placeholder="例如 123456789" />
    </div>
    <button class="btn" data-test-notify="telegram">发送测试</button>

    <div class="notify-head" style="margin-top:28px;padding-top:22px;border-top:1px solid var(--border)">
      <h3>wxpush</h3>
      <label class="switch"><input type="checkbox" data-path="notify.wxpush.enabled"${wxpush.enabled ? " checked" : ""} /><span>启用</span></label>
    </div>
    <div class="field">
      <label>服务地址<span class="hint">wxpush 部署后的域名,不用带 /wxsend</span></label>
      <input class="input mono" data-path="notify.wxpush.url" value="${esc(wxpush.url)}" placeholder="https://wxpush.example.workers.dev" />
    </div>
    <div class="field">
      <label>Token<span class="hint">即 wxpush 的 API_TOKEN</span></label>
      <input class="input" type="password" data-path="notify.wxpush.token" value="${esc(wxpush.token ?? "")}"
             placeholder="${wxpush.tokenHint ? `已设置(尾号 ${esc(wxpush.tokenHint)}),留空不改动` : "your_api_token"}" />
    </div>
    <button class="btn" data-test-notify="wxpush">发送测试</button>
    ${saveBar()}
  `;
}

function panelThresholds() {
  const { workersQuotaPercent, cpuP99Ms, cpuAlertMode, cpuCooldownMinutes, domainExpiryDays } =
    state.config.thresholds;
  const isCooldown = cpuAlertMode === "cooldown";
  return `
    <div class="settings-card">
      <div class="settings-head">
        <h3>Workers 用量告警</h3>
        <span class="hint">账号当日 Workers + Pages 请求数达到配额百分比时推送</span>
      </div>
      <div class="field">
        <label>Workers 用量百分比阈值<span class="hint">%</span></label>
        <input class="input" type="number" min="1" max="100" step="1" data-path="thresholds.workersQuotaPercent" data-type="number" value="${workersQuotaPercent}" />
      </div>
      <div class="banner">${icons.alert}<span>用量在 UTC 零点清零前<strong>只增不减</strong> —— 一旦越线,当天就一直处于超标状态,再提醒也没有新信息。所以每个账号每天只推一次,不需要频率设置。</span></div>
    </div>

    <div class="settings-card">
      <div class="settings-head">
        <h3>D1 / KV / Workers AI 额度告警</h3>
        <span class="hint">各自占免费额度的百分比,每天每项只推一次</span>
      </div>
      <div class="field-row">
        <div class="field">
          <label>D1 读行数<span class="hint">%</span></label>
          <input class="input" type="number" min="1" max="100" step="1" data-path="thresholds.d1RowsReadPercent" data-type="number" value="${state.config.thresholds.d1RowsReadPercent}" />
        </div>
        <div class="field">
          <label>D1 写行数<span class="hint">%</span></label>
          <input class="input" type="number" min="1" max="100" step="1" data-path="thresholds.d1RowsWrittenPercent" data-type="number" value="${state.config.thresholds.d1RowsWrittenPercent}" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>KV 读取<span class="hint">%</span></label>
          <input class="input" type="number" min="1" max="100" step="1" data-path="thresholds.kvReadPercent" data-type="number" value="${state.config.thresholds.kvReadPercent}" />
        </div>
        <div class="field">
          <label>KV 写入<span class="hint">%</span></label>
          <input class="input" type="number" min="1" max="100" step="1" data-path="thresholds.kvWritePercent" data-type="number" value="${state.config.thresholds.kvWritePercent}" />
        </div>
      </div>
      <div class="field-row">
        <div class="field">
          <label>Workers AI Neurons<span class="hint">%</span></label>
          <input class="input" type="number" min="1" max="100" step="1" data-path="thresholds.aiNeuronsPercent" data-type="number" value="${state.config.thresholds.aiNeuronsPercent}" />
        </div>
        <div class="field">
          <label>D1 存储<span class="hint">%, gauge</span></label>
          <input class="input" type="number" min="1" max="100" step="1" data-path="thresholds.d1StoragePercent" data-type="number" value="${state.config.thresholds.d1StoragePercent}" />
        </div>
      </div>
      <label class="switch"><input type="checkbox" data-path="thresholds.storageAlertsEnabled"${state.config.thresholds.storageAlertsEnabled ? " checked" : ""} /><span>启用存储类告警(D1 存储)</span></label>
      <div class="banner">${icons.alert}<span>计数类(读数写行数、KV 读、KV 写、Neurons)在 UTC 零点前<strong>只增不减</strong>,和 Workers 用量一样每天每项只推一次。<br /><strong>存储是 gauge,会升也会降</strong> —— 删了数据就降回来,所以默认关闭,避免删删建建反复触发。要监控的话勾上上面的开关。</span></div>
    </div>

    <div class="settings-card">
      <div class="settings-head">
        <h3>CPU p99 告警</h3>
        <span class="hint">任一脚本的 CPU p99 达到阈值时推送</span>
      </div>
      <div class="field-row">
        <div class="field">
          <label>CPU p99 阈值<span class="hint">毫秒</span></label>
          <input class="input" type="number" min="0.1" step="0.5" data-path="thresholds.cpuP99Ms" data-type="number" value="${cpuP99Ms}" />
        </div>
        <div class="field">
          <label>告警频率<span class="hint">同一账号多久可以再推一次</span></label>
          <select class="input" data-path="thresholds.cpuAlertMode">
            <option value="daily"${isCooldown ? "" : " selected"}>每天只推一次(UTC 零点重置)</option>
            <option value="cooldown"${isCooldown ? " selected" : ""}>按冷却时间</option>
          </select>
        </div>
      </div>
      <div class="field" id="cooldown-row"${isCooldown ? "" : " hidden"}>
        <label>冷却时间<span class="hint">分钟</span></label>
        <input class="input" type="number" min="1" max="1440" step="1" data-path="thresholds.cpuCooldownMinutes" data-type="number" value="${cpuCooldownMinutes}" />
      </div>
      <div class="banner">${icons.alert}<span>p99 是<strong>当天累计</strong>的统计量,会随新请求变化,不像用量那样只增不减 —— 所以这里可以按冷却时间反复提醒。<br />Free 计划单次 CPU 上限 10ms;新部署待解析出名字的脚本与面板自身不计入。</span></div>
    </div>

    <div class="settings-card">
      <div class="settings-head">
        <h3>域名到期提醒</h3>
        <span class="hint">所有域名统一使用这个提前量</span>
      </div>
      <div class="field">
        <label>提前提醒天数<span class="hint">天</span></label>
        <input class="input" type="number" min="1" max="365" step="1" data-path="thresholds.domainExpiryDays" data-type="number" value="${domainExpiryDays}" />
      </div>
      <div class="banner">${icons.alert}<span>进入这个窗口后每个域名<strong>只推一条</strong>通知,不会天天重复。<br />到期时间在首页「域名明细」里逐个设置,只有设了时间并打开提醒的域名才会推送;续期后改成新日期会重新提醒一次。</span></div>
    </div>
    ${saveBar()}
  `;
}

/** Toggles the cooldown field in place — a full re-render would drop unsaved edits. */
function syncCooldownRow() {
  const row = document.getElementById("cooldown-row");
  if (!row) return;
  row.hidden = state.config.thresholds.cpuAlertMode !== "cooldown";
}

function panelPassword() {
  return `
    <div class="field">
      <label>当前密码</label>
      <input class="input" type="password" id="pw-current" autocomplete="current-password" />
    </div>
    <div class="field">
      <label>新密码<span class="hint">至少 8 位</span></label>
      <input class="input" type="password" id="pw-new" autocomplete="new-password" />
    </div>
    <div class="field">
      <label>确认新密码</label>
      <input class="input" type="password" id="pw-confirm" autocomplete="new-password" />
    </div>
    <div class="banner">${icons.alert}<span>修改密码会让所有已登录的会话立即失效(包括其他设备)。</span></div>
    <div class="form-actions">
      <button class="btn btn-primary" data-change-password>修改密码</button>
    </div>
  `;
}

function saveBar() {
  return `
    <div class="form-actions">
      <button class="btn btn-primary" data-save-config>保存配置</button>
    </div>
  `;
}

/* --------------------------------------------------------------- behaviour */

function setPath(object, path, value) {
  const keys = path.split(".");
  let cursor = object;
  for (let i = 0; i < keys.length - 1; i++) cursor = cursor[keys[i]];
  cursor[keys[keys.length - 1]] = value;
}

async function loadSession() {
  try {
    const session = await api("/api/session");
    state.needsSetup = Boolean(session.needsSetup);
    if (session.authed) {
      await enterApp();
    } else {
      state.view = "auth";
    }
  } catch {
    state.view = "auth";
  }
  render();
}

async function enterApp() {
  await loadOverview();
  state.view = "dashboard";
  render();
}

async function loadOverview() {
  const data = await api("/api/overview");
  state.accounts = data.accounts ?? [];
  state.thresholds = data.thresholds ?? state.thresholds;
  if (!state.accounts.some((a) => a.accountId === state.selectedAccountId)) {
    state.selectedAccountId = state.accounts[0]?.accountId ?? null;
  }
  state.lastUpdated = Date.now();
}

async function openConfig() {
  state.config = await api("/api/config");
  state.view = "config";
  render();
}

/* --- domain expiry -------------------------------------------------------- */

/** Locates a domain row in the loaded overview by its `<accountId>/<name>` key. */
function findDomain(key) {
  const slash = key.indexOf("/");
  const account = state.accounts.find((a) => a.accountId === key.slice(0, slash));
  return (account?.domains ?? []).find((d) => d.name === key.slice(slash + 1)) ?? null;
}

/** Mirrors a domain edit into the DOM without re-rendering, so focus survives. */
function syncDomainRow(row, domain) {
  if (!row) return;
  const set = Boolean(domain.expiresAt);

  const toggle = row.querySelector("[data-domain-remind]");
  if (toggle) {
    toggle.checked = domain.remind;
    toggle.disabled = !set;
    const label = toggle.closest(".switch");
    if (label) {
      label.classList.toggle("is-disabled", !set);
      const text = label.querySelector("span");
      if (text) text.textContent = set ? "提醒" : "—";
    }
  }

  const badge = row.querySelector("[data-domain-badge]");
  if (badge) badge.innerHTML = domainBadge(domain);
}

/**
 * Persists every domain's expiry settings. Only dates that are actually set get
 * sent: the server reads an absent entry as "not set" and drops `remind` when
 * there is no date to fire on.
 */
async function saveDomains() {
  const domains = {};
  for (const account of state.accounts) {
    for (const domain of account.domains ?? []) {
      if (!domain.expiresAt) continue;
      domains[`${account.accountId}/${domain.name}`] = {
        expiresAt: domain.expiresAt,
        remind: domain.remind,
      };
    }
  }

  try {
    await api("/api/config", { method: "PUT", body: { domains } });
    // Keep the config tab's copy in step, or saving that tab later would send its
    // stale map and undo this edit.
    if (state.config) state.config.domains = domains;
  } catch (error) {
    toast(error.message, "error");
  }
}

app.addEventListener("change", async (event) => {
  const target = event.target;
  const expiryKey = target.dataset?.domainExpiry;
  const remindKey = target.dataset?.domainRemind;
  if (!expiryKey && !remindKey) return;

  const domain = findDomain(expiryKey ?? remindKey);
  if (!domain) return;

  if (expiryKey) {
    domain.expiresAt = target.value || "";
    // A reminder with no expiry date has nothing to fire on.
    if (!domain.expiresAt) domain.remind = false;
  } else {
    domain.remind = target.checked;
  }

  syncDomainRow(target.closest(".domain-row"), domain);
  await saveDomains();
});

/* The search box filters data already in memory — no request per keystroke. It
   sits in the hero, and only the region *below* the hero is re-rendered, so the
   input keeps focus while typing. */
app.addEventListener("input", (event) => {
  const input = event.target.closest("[data-search]");
  if (!input) return;

  state.query = input.value;
  input.closest(".search")?.classList.toggle("is-filled", input.value !== "");

  const lower = document.getElementById("dash-lower");
  if (lower) lower.innerHTML = lowerBody();
});

app.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  if (form.id !== "auth-form") return;

  const data = new FormData(form);
  const password = String(data.get("password") ?? "");
  state.authError = "";

  try {
    if (state.needsSetup) {
      if (password !== String(data.get("confirm") ?? "")) {
        throw new Error("两次输入的密码不一致");
      }
      await api("/api/setup", {
        method: "POST",
        body: { initToken: String(data.get("initToken") ?? ""), password },
      });
      state.needsSetup = false;
    } else {
      await api("/api/login", { method: "POST", body: { password } });
    }
    await enterApp();
  } catch (error) {
    state.authError = error.message;
    render();
  }
});

app.addEventListener("click", async (event) => {
  // Dashboard detail tabs. Only the region below the hero is re-rendered, so the
  // gauge, the search box and the selected account all stay untouched.
  const detailTab = event.target.closest("[data-detail-tab]");
  if (detailTab) {
    state.detailTab = detailTab.dataset.detailTab;
    const lower = document.getElementById("dash-lower");
    if (lower) lower.innerHTML = lowerBody();
    return;
  }

  const tab = event.target.closest("[data-tab]");
  if (tab) {
    state.configTab = tab.dataset.tab;
    render();
    return;
  }

  // Clicking a search hit jumps to the account that owns it.
  const hit = event.target.closest("[data-goto-account]");
  if (hit) {
    state.selectedAccountId = hit.dataset.gotoAccount;
    state.query = "";
    render();
    return;
  }

  const testButton = event.target.closest("[data-test-notify]");
  if (testButton) {
    const channel = testButton.dataset.testNotify;
    testButton.disabled = true;
    try {
      await api("/api/notify/test", { method: "POST", body: { channel } });
      toast("测试通知已发送");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      testButton.disabled = false;
    }
    return;
  }

  // Unfolding is done in the DOM rather than by re-rendering: a re-render would
  // throw away whatever the user has typed in the card but not saved yet.
  const toggle = event.target.closest("[data-toggle-account]");
  if (toggle) {
    const index = Number(toggle.dataset.toggleAccount);
    const body = toggle.closest(".account-item")?.querySelector(".account-body");
    if (body) {
      const open = body.hidden;
      body.hidden = !open;
      toggle.setAttribute("aria-expanded", String(open));
      toggle.querySelector(".chev")?.classList.toggle("is-open", open);
      if (open) state.expandedAccounts.add(index);
      else state.expandedAccounts.delete(index);
    }
    return;
  }

  if (event.target.closest("[data-add-account]")) {
    state.config.accounts.push({
      id: "",
      name: "",
      apiToken: "",
      apiTokenHint: null,
      quotaRequests: 100000,
      quotaPeriod: "day",
    });
    // Open the new card so it can be filled in right away.
    state.expandedAccounts.add(state.config.accounts.length - 1);
    render();
    return;
  }

  const remove = event.target.closest("[data-remove-account]");
  if (remove) {
    const removed = Number(remove.dataset.removeAccount);
    state.config.accounts.splice(removed, 1);
    // The set is keyed by index, so everything after the hole shifts down one.
    const shifted = new Set();
    for (const index of state.expandedAccounts) {
      if (index < removed) shifted.add(index);
      else if (index > removed) shifted.add(index - 1);
    }
    state.expandedAccounts = shifted;
    render();
    return;
  }

  if (event.target.closest("[data-save-config]")) {
    try {
      await api("/api/config", { method: "PUT", body: state.config });
      state.config = await api("/api/config");
      await loadOverview();
      toast("配置已保存");
      render();
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }

  if (event.target.closest("[data-change-password]")) {
    const current = document.getElementById("pw-current").value;
    const next = document.getElementById("pw-new").value;
    const confirm = document.getElementById("pw-confirm").value;
    if (next !== confirm) {
      toast("两次输入的新密码不一致", "error");
      return;
    }
    try {
      await api("/api/config/password", {
        method: "POST",
        body: { currentPassword: current, newPassword: next },
      });
      toast("密码已修改");
      render();
    } catch (error) {
      toast(error.message, "error");
    }
    return;
  }

  const action = event.target.closest("[data-action]")?.dataset.action;
  if (!action) return;

  if (action === "theme") {
    toggleTheme();
  } else if (action === "search-clear") {
    state.query = "";
    render();
  } else if (action === "logout") {
    await api("/api/logout", { method: "POST" });
    state.accounts = [];
    state.config = null;
    state.query = "";
    state.view = "auth";
    render();
  } else if (action === "config") {
    try {
      await openConfig();
    } catch (error) {
      toast(error.message, "error");
    }
  } else if (action === "back") {
    state.view = "dashboard";
    render();
  } else if (action === "refresh") {
    state.refreshing = true;
    render();
    try {
      const data = await api("/api/refresh", { method: "POST" });
      state.accounts = data.accounts ?? [];
      state.thresholds = data.thresholds ?? state.thresholds;
      state.lastUpdated = Date.now();
      toast("数据已刷新");
    } catch (error) {
      toast(error.message, "error");
    } finally {
      state.refreshing = false;
      render();
    }
  }
});

app.addEventListener("change", (event) => {
  const target = event.target;

  const path = target.dataset?.path;
  if (!path || !state.config) return;

  if (target.type === "checkbox") {
    setPath(state.config, path, target.checked);
  } else if (target.dataset.type === "number") {
    setPath(state.config, path, Number(target.value));
  } else {
    setPath(state.config, path, target.value);
  }

  if (path === "thresholds.cpuAlertMode") syncCooldownRow();
});

app.addEventListener("input", (event) => {
  const target = event.target;
  const path = target.dataset?.path;
  if (!path || !state.config || target.type === "checkbox") return;

  if (target.dataset.type === "number") {
    setPath(state.config, path, Number(target.value));
  } else {
    setPath(state.config, path, target.value);
  }
});

/** The account selector lives in the dashboard body, which re-renders alone. */
app.addEventListener("change", (event) => {
  const select = event.target.closest("[data-account-select]");
  if (!select) return;
  state.selectedAccountId = select.value;
  const body = document.getElementById("dash-body");
  if (body) body.innerHTML = dashBody();
});

/* -------------------------------------------------------------------- boot */

applyTheme();

// Keep the "重置倒计时" honest without a full re-render.
setInterval(() => {
  const line = document.querySelector(".reset-line");
  const account = selectedAccount();
  if (!line || state.view !== "dashboard" || !account) return;
  const period = account.quotaPeriod;
  line.textContent =
    `额度 ${fmtNum(account.quotaRequests || 0)} · ${period === "month" ? "月初" : "UTC 零点"}` +
    `重置,还有 ${fmtCountdown(secondsUntilReset(period))}`;
}, 30000);

loadSession();
