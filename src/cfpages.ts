/**
 * Cloudflare Pages project lookup.
 *
 * Pages Functions appear in the analytics dataset under an internal script name
 * — `pages-worker--2744418-production` — never the project name. The dataset
 * has no project dimension at all (verified against the live schema), so the
 * only place the two are linked is the Pages API, via `production_script_name`
 * and `preview_script_name`.
 *
 * Requires the `Cloudflare Pages: Read` permission. Without it the request
 * fails and every Pages row keeps its raw internal name.
 */

const API_BASE = "https://api.cloudflare.com/client/v4";

interface PagesProject {
  name?: string | null;
  production_script_name?: string | null;
  preview_script_name?: string | null;
}

export interface PagesProjects {
  /** Internal script name → display label, for naming usage rows. */
  labels: Record<string, string>;
  /** Plain project names, used to backfill zero-usage Pages projects. */
  names: string[];
}

/**
 * Lists the account's Pages projects: a label map for naming the analytics
 * rows, plus the bare project names for backfilling projects with no
 * Functions traffic this period. Never throws.
 * An empty map means "could not resolve" — callers fall back to the raw name.
 */
export async function fetchPagesScriptNames(
  apiToken: string,
  accountId: string,
): Promise<PagesProjects> {
  const empty: PagesProjects = { labels: {}, names: [] };
  const response = await fetch(`${API_BASE}/accounts/${accountId}/pages/projects`, {
    headers: { Authorization: `Bearer ${apiToken}` },
  });

  if (!response.ok) {
    console.warn(
      `Pages 项目列表读取失败(HTTP ${response.status})—— Token 可能缺少 Cloudflare Pages: Read 权限,Pages 将显示内部脚本名`,
    );
    return empty;
  }

  let body: { result?: PagesProject[] };
  try {
    body = (await response.json()) as { result?: PagesProject[] };
  } catch {
    return empty;
  }

  const labels: Record<string, string> = {};
  const names: string[] = [];
  for (const project of body.result ?? []) {
    const name = project.name;
    if (!name) continue;
    names.push(name);
    if (project.production_script_name) labels[project.production_script_name] = name;
    // Preview and production are separate scripts; label them apart so the two
    // rows do not collapse into the same-looking entry.
    if (project.preview_script_name) labels[project.preview_script_name] = `${name} · preview`;
  }
  return { labels, names };
}
