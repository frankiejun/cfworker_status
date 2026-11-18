# cfworker-status

自建的 Cloudflare 用量监控面板，集中查看 Workers / Pages Functions / D1 / KV 用量，并在接近额度上限时收到通知。

## 功能

- 多账号管理，查看请求数、CPU 耗时和额度使用情况
- D1 / KV / Workers AI 免费额度监控
- 域名列表与到期提醒，支持跨账号搜索
- Telegram / [wxpush](https://github.com/frankiejun/wxpush) 告警，支持阈值配置与去重
- 默认每 5 分钟自动采集，也可手动刷新

## 部署

需要 Node.js 22.15+ 和 Cloudflare 账号。

### 1. 准备配置

```bash
npm install
cp wrangler.sample wrangler.jsonc
npx wrangler kv namespace create STATUS_KV
```

将创建得到的 KV `id` 填入 `wrangler.jsonc` 的 `kv_namespaces[0].id`。
如修改 Worker 名称，请同步修改 `vars.SELF_SCRIPT_NAME`。

### 2. 设置初始化令牌并部署

```bash
npx wrangler secret put INIT_TOKEN
# 输入自己生成的随机字符串
npm run deploy
```

**不要跳过 `INIT_TOKEN`**：它用于保护首次初始化，防止他人抢先设置面板密码。

### 3. 初始化面板

访问部署后的地址，输入 `INIT_TOKEN` 并设置登录密码。

## 使用

在 Cloudflare Dashboard → My Profile → API Tokens 创建自定义 Token，账号资源限定为要监控的账号，并授予以下只读权限：

| 范围 | 权限 |
|---|---|
| Account | Account Analytics → Read |
| Account | Workers Scripts → Read |
| Account | Cloudflare Pages → Read |
| Zone | Zone → Read |

1. **配置 → 账号管理**：添加 Account ID 和 API Token，设置请求额度及统计周期（Free：`100000` / 每日；Paid：`10000000` / 每月）。
2. **配置 → 通知设置**：填写 Telegram 或 wxpush 参数，发送测试消息确认可用。
3. **配置 → 告警阈值**：设置用量、CPU 和域名到期提醒阈值，返回仪表盘查看数据。

wxpush 服务地址填写部署域名，无需带 `/wxsend`。

## 注意事项

- Workers 与 Pages Functions 共享账号请求额度，Pages 静态资源不计入；每日统计以 UTC 为准。
- 用量来自 Cloudflare 统计接口，可能存在延迟或采样误差；仅保留当前快照，不提供历史趋势。
- 域名到期日期需手动填写，并为需要提醒的域名开启到期提醒。
- 平台额度暂不覆盖 Durable Objects、Queues 和 Vectorize。
- KV 免费版有读写额度限制，建议保持默认采集间隔，避免频繁手动刷新。
- 账号 API Token 以明文保存于 KV，请使用最小权限并妥善保护 Cloudflare 账号。

## 本地开发

```bash
npm run dev        # http://localhost:8787
npm run typecheck
npm test           # 本地模拟，不会发送真实通知
```

## 许可证

本项目基于 MIT 许可证开源。
