# cfworker-status

一个自建的 Cloudflare Workers / Pages 用量监控面板。定时采集账号下所有 Worker 和 Pages Functions 的请求数与 CPU 耗时,用油量计直观展示今日额度消耗,超过阈值时通过 Telegram / wxpush 推送告警。

## 它解决什么问题

- Workers 免费额度是**账号级 100,000 请求/天**,UTC 零点重置,超了直接返回错误 1027 —— 但 Dashboard 没有"今天还剩多少"的直观视图
- **Pages Functions 的用量不在 Workers 数据集里**,是独立数据集,只看一边会漏算
- 想要超标时主动收到通知,而不是等用户报错

## 关键事实(已实测确认)

| 事实 | 说明 |
|---|---|
| Workers 用量 | 数据集 `workersInvocationsAdaptive` |
| Pages Functions 用量 | 数据集 `pagesFunctionsInvocationsAdaptiveGroups`(**独立**) |
| Pages 静态资源 | **不计入额度**,免费且无限。只有触发 Functions 的请求才计数 |
| 额度归属 | **账号级共享**,Workers 和 Pages Functions 加在一起算 |
| 免费额度 | 100,000 请求/天,UTC 零点重置 |
| CPU 上限 | Free 每次调用 10ms;Paid 默认 30s(可调到 5min)。这是**单次上限,不是可消耗配额** |
| 数据采样 | `workersInvocationsAdaptive` 是自适应采样数据集,高流量下数字可能有微小浮动 |

## 部署

### 1. 生成配置文件 + 创建 KV namespace

`wrangler.jsonc` 被 `.gitignore` 忽略了(它含有你自己的资源 ID),仓库里只留了一份模板。
先把模板复制过来:

```bash
npm install
cp wrangler.sample wrangler.jsonc
```

再创建 KV namespace:

```bash
npx wrangler kv namespace create STATUS_KV
```

把输出的 `id` 填进 `wrangler.jsonc` 的 `kv_namespaces[0].id`,替换掉 `REPLACE_WITH_YOUR_KV_NAMESPACE_ID`。

> 如果你把 Worker 改名了(模板里叫 `cfworker-status`),记得同步改 `vars.SELF_SCRIPT_NAME` ——
> 它决定哪个脚本被排除在 CPU 告警之外。

### 2. 设置初始化令牌

这一步**不能跳过**。否则部署后任何先访问到该 URL 的人都能抢先设置密码、接管面板。

```bash
npx wrangler secret put INIT_TOKEN
# 输入一个自己生成的随机字符串
```

### 3. 准备 Cloudflare API Token

面板需要用它去读账号的用量数据。注意这是**给面板用的** token,不是登录面板的密码。

到 Cloudflare Dashboard → My Profile → API Tokens → Create Custom Token:

| 项 | 值 |
|---|---|
| Permissions | `Account` → `Account Analytics` → `Read` |
| Permissions | `Account` → `Workers Scripts` → `Read` |
| Permissions | `Account` → `Cloudflare Pages` → `Read` |
| Permissions | `Zone` → `Zone` → `Read` |
| Account Resources | Include → 你要监控的账号 |

这四个都是**只读**权限,可以放心。

> **第二个权限用来列出账号里全部 Worker。** 用量数据集(`workersInvocationsAdaptive`)
> 只含有调用记录的脚本 —— 一次都没被调用的 Worker(还没触发 cron 的、刚部署的、闲置的)
> 在数据集里**没有行**。有了这个权限,面板会把它们按 0 请求补进「项目明细」;不加的话
> 面板不报错,只是没用量的 Worker 不出现。
>
> **第三个权限用来还原 Pages 项目名,顺带列出全部 Pages 项目。** 用量数据集里 Pages
> Functions 只以内部脚本名出现(`pages-worker--2744418-production`),项目名只存在于
> Pages API 的 `production_script_name` 字段里 —— GraphQL schema 里根本没有项目名,
> 这是唯一途径。没有 Functions 调用的 Pages 项目同样只在这个列表里,补 0 请求行也要靠它。
> **不加这个权限面板不会报错**,只是 Pages 一行会显示成内部脚本名、没用量的项目不出现,
> 日志里会有一条 warning。
>
> **第四个权限用来列出域名。** 首页「域名明细」的域名列表来自 `GET /zones`,没有这个权限
> 该区块会空着并显示一条写明缺哪个权限的提示,其余功能不受影响。
> 注意 zone 的 `created_on` 是**域名接入 Cloudflare 的时间**,不是注册商那边的注册日期;
> 而真实到期日 Cloudflare 根本不知道(域名可能在别处注册),所以那一列要在面板里手填。

### 4. 本地开发 / 部署

```bash
npm install
npx wrangler dev          # 本地:http://localhost:8787
npx wrangler deploy       # 部署
```

### 5. 首次初始化

打开面板地址,输入第 2 步设置的 `INIT_TOKEN` 和你想设置的登录密码。之后就可以在「配置」页添加账号了。

## 使用

1. **配置 → 账号管理**:添加账号,填上 Account ID 和上一步创建的 API Token。额度按账号设置(Free 填 `100000` 且周期选「每日」;Paid 填 `10000000` 且选「每月」)。账号多了会平铺一屏,每张卡片默认**折叠**成一行摘要(名称 + Account ID 前 8 位 + 额度),点标题展开
2. **配置 → 通知设置**:填 Telegram 或 wxpush 参数,点「发送测试」确认能收到
3. **配置 → 告警阈值**:四张卡片 —— 「Workers 用量告警」设配额百分比(默认 80%);
   「D1 / KV / Workers AI 额度告警」给六项分别设百分比(默认都是 80%,存储项默认关);
   「CPU p99 告警」设 p99 阈值(默认 8ms)和告警频率(每天一次 / 按冷却时间,冷却默认 5 分钟);
   「域名到期提醒」设提前天数(默认 30 天)
4. 回到仪表盘,点刷新即可看到数据

**wxpush 参数**:服务地址填 wxpush 部署后的域名(如 `https://wxpush.xxx.workers.dev`,**不用带 `/wxsend`**;带了也会被识别),Token 填 wxpush 的 `API_TOKEN` 环境变量值。参见 [frankiejun/wxpush](https://github.com/frankiejun/wxpush)。

### 搜索

仪表盘顶部有搜索框,输入即筛选(纯前端过滤已加载的数据,不发请求)。**跨全部账号**搜 Worker /
Pages 项目名和域名,每条结果都标出所属账号,点一下跳到该账号。

### 域名明细

仪表盘上「项目明细」和「域名明细」是**同一排 tabs**,点切换,不占两屏。域名页每行一个域名:域名、
注册时间(即接入 Cloudflare 的时间,来自 API)、到期时间、到期提醒。

- **到期时间**手填。清空即回到"未设置"。注意 Cloudflare 不知道你的域名在哪注册、什么时候到期,
  这个日期没法自动获取
- **到期提醒**只有设了到期时间才能打开;清空日期会自动关掉提醒
- 改动即时保存(改日期、拨开关都会立刻写回),不需要点保存按钮
- 右侧会显示「还有 N 天」;进入提前提醒窗口后变橙色,过期变红色

### 平台额度

同一排 tabs 里的「平台额度」,把 **D1 / KV / Workers AI** 的免费额度做成六张计量卡,每张显示
已用 / 限额、百分比和剩余量。三个产品的免费额度都是**账号级、每日 UTC 零点重置**,和上方的
请求数同一口径,所以共用「今日」这个时间基准。

| 卡片 | 免费额度 | 数据来源 |
|---|---|---|
| D1 读行数 | 500 万行/天 | `d1AnalyticsAdaptiveGroups.sum.rowsRead` |
| D1 写行数 | 10 万行/天 | `d1AnalyticsAdaptiveGroups.sum.rowsWritten` |
| D1 存储 | 5 GB(全账号) | `d1StorageAdaptiveGroups.max.databaseSizeBytes` 按 `databaseId` 求和 |
| KV 读取 | 10 万次/天 | `kvOperationsAdaptiveGroups` 按 `actionType=read` |
| KV 写入 | 1,000 次/天 | 同上,`actionType=write` |
| Workers AI | 1 万 Neurons/天 | `aiInferenceAdaptiveGroups.sum.totalNeurons` |

这六项都能单独设告警阈值,见下文「告警行为」。

两点值得注意:

- **存储是 gauge 不是计数**,所以按 `databaseId` / `namespaceId` 分组后求和得到账号合计
  (实测这些数据集在窗口内每个分组只返回一行,不会按小时分桶重复计数)
- **不并进 Workers 那次 GraphQL 查询**:Cloudflare 的 GraphQL 校验是**全有全无**的,selection
  里任何字段不存在,整个 `data` 直接变 `null`。并进去的话,这些数据集将来改个名就会把 Workers
  请求数(面板的主功能)一起变成空。分开后最坏只是这一块显示「平台额度读取失败」,其余功能不受影响

> **Durable Objects / Queues / Vectorize 暂不计量。** DO 的真实瓶颈是 13,000 GB-s/天**时长**,
> 但 GraphQL 取不到(`durableObjectsPeriodicGroups.sum.duration` 实测恒为空),只能量到请求和
> SQLite 存储,而请求不是它的收紧项 —— 显示一半会给人「很安全」的错觉。Queues / Vectorize 的
> 免费额度则是**按月**计的,和这三个的按天口径不同。

## 到期提醒的推送规则

进入窗口(默认到期前 30 天)后,**每个域名只推一条** —— 不会天天重复轰炸。

去重是按**到期日期**记的,不是按天:把到期时间改成新日期(续期后)会自动重新提醒一次。
已过期的域名也会推一条,标题是 `⛔ 域名 已过期`。

## 定时采集

`wrangler.jsonc` 里默认是每 5 分钟一次:

```jsonc
"triggers": { "crons": ["*/5 * * * *"] }
```

改完重新 `deploy` 生效。本地测试定时任务:

```bash
npx wrangler dev --test-scheduled
curl "http://localhost:8787/cdn-cgi/handler/scheduled?cron=*/5+*+*+*+*"
```

> 注意用 `/cdn-cgi/handler/scheduled`,不要用旧的 `/__scheduled`。因为前端配了
> `not_found_handling: single-page-application`,而 `run_worker_first` 只覆盖 `/api/*`,
> 所以 `/__scheduled` 会被 SPA fallback 当成前端路由、返回 index.html 而不触发定时任务。
> 线上真正的 cron 由 Cloudflare 原生触发,不走 HTTP,不受此影响。

### ⚠️ 别把间隔调太短(KV 免费版写入限制)

**KV 免费版每天只有 1,000 次写入**,超了 `put` 会直接失败。

本项目为此做了专门设计:**所有账号的快照合并存在一个 `snapshots` key 里**,所以每轮采集
**只写 1 次,与账号数量无关**。

| cron 间隔 | 每天写入 | 免费版 |
|---|---|---|
| 15 分钟 | 96 | ✓ 宽裕 |
| **5 分钟(默认)** | **288** | ✓ 安全 |
| 2 分钟 | 720 | ✓ 可行 |
| 1 分钟 | 1,440 | ❌ 超限 |

结论:间隔保持在 **2 分钟以上**。另外每个账号每次告警会额外写 1 次(每天最多几次),可以忽略。

> 如果哪天你既想要秒级刷新、又有很多账号,KV 就不再合适了 —— 那时应该换成 D1
> (免费版每天 10 万行写入)。当前的架构换存储只需要改 `src/store.ts`。

## 告警行为

三类告警,配置页「告警阈值」里是三张独立的卡片:

| 告警 | 触发条件 | 频率 |
|---|---|---|
| Workers 用量 | 账号当日 Workers + Pages 请求数达到配额百分比 | **每账号每天只推一次**,固定,没有开关 |
| 平台额度 | D1 / KV / Workers AI 各自占免费额度的百分比 | **每账号每项每天只推一次**,固定,没有开关 |
| CPU p99 | 任一脚本的 CPU p99 达到阈值 | 可选:每天一次(默认)/ 按冷却时间 |

**用量为什么不给频率设置**:用量在 UTC 零点清零前**只增不减**,一旦越线当天就一直处于
超标状态,再提醒也没有新信息 —— 每天一条就够了。

**平台额度同理,而且六项各有各的阈值**:D1 读行数、D1 写行数、KV 读取、KV 写入、
Workers AI Neurons 都是单调计数,所以和 Workers 用量一样每天只推一次。

**存储类是例外,默认关闭**:D1 存储、KV 存储是 **gauge 不是计数**,会升也会降 —— 删了数据
就降下来。打开「启用存储类告警」后,降回阈值以下当天也不会重复推(按 UTC 日期去重),
但下次越线会再推一条,所以默认关着,避免删删建建反复触发。

**CPU 为什么可以设冷却时间**:p99 是**当天累计**的统计量,并不单调。它是「当天最慢的
1% 请求落在什么水平」,会随新请求升**降** —— 偶发尖峰会被后续正常流量稀释,自己掉回阈值
以下;持续变慢则会整天压着阈值。所以要不要反复提醒,取决于你想多快知道。

- 冷却时间默认 5 分钟(与默认采集间隔一致),最长 1440 分钟
- 只有**所有启用的渠道都发送成功**才会标记为已推送;发送失败的会在下个周期重试
- **两类脚本被排除在 CPU 告警之外**(只影响告警,页面上照常显示):
  - **面板自己** —— 名字由 `wrangler.jsonc` 的 `SELF_SCRIPT_NAME` 指定。登录走 PBKDF2
    (10 万次迭代 ≈ 20ms),p99 天然高于默认的 8ms 阈值,否则面板会一直给自己报警。
    **改了 Worker 名字记得同步改这里。**
  - **`__unknown__`** —— Cloudflare 解析不出脚本名时的哨兵值,见下

> **冷却模式的代价**:KV 写入**不受影响** —— 所有告警的时间戳合存在一个 `alerts` key,
> 每轮采集最多写 1 次,与告警条数、账号数都无关;最坏情况 288(快照)+ 288(告警)
> = 576 次/天,免费额度 1,000 次/天仍有富余。
> **真正的代价是推送量**:CPU p99 若整天都压在阈值之上,5 分钟冷却 ≈ 288 条/账号/天。
> 遇到这种情况就把冷却调长,或者改回「每天一次」。
>
> **平台额度告警按项写一次**(不是每轮一次):只有真的发出去了才写一次 KV。按天去重意味着
> 每账号每天最多写 6 次(六项各一次),和冷却模式完全不可比 —— 288(快照)+ 6×N(平台额度)
> 对 1,000 次/天的免费额度来说可以忽略。
>
> **域名到期提醒也共用同一个 `alerts` key**,但它按到期日期去重,一个域名一个到期日只会写
> 一次,不构成持续性开销(不像冷却模式那样每轮都写)。

## 排查

| 现象 | 原因 |
|---|---|
| 面板显示 `authorization denied` | API Token 权限不对,或缺 `Account Analytics: Read` |
| 面板显示 `not authorized for that account` | Token 绑定的账号 ≠ 填的 Account ID。确认 token 是在目标账号下创建的 |
| 收不到 Telegram | 检查 Bot Token / Chat ID;要先给 bot 发过消息才能给它发消息 |
| 收不到 wxpush | 检查服务地址和 Token;需要先关注对应的微信公众号 |
| 「域名明细」提示缺权限 / 是空的 | Token 缺少 `Zone → Zone → Read`。补上后重新部署(权限改动要新 token) |
| 「域名明细」空的但没有提示 | 采集失败时会一并清空;先看顶部是否有采集失败的横幅 |
| 域名到期了但没收到提醒 | 检查该域名的「到期提醒」是否打开,以及「告警阈值 → 域名到期提醒」的提前天数 |
| 改完域名没收到提醒,过几天又收到了 | 去重是按到期日期记的。改日期后旧记录作废,新日期进入窗口时会重新推 |
| 定时任务没跑 | cron 改动需要重新部署;用 `--test-scheduled` 本地验证 |

## 安全说明

- 登录密码用 **PBKDF2-SHA256**(100k 迭代 + 随机盐)哈希后存储,不存明文
- 会话是 HMAC 签名的 Cookie(`HttpOnly` + `SameSite=Strict`),签名密钥从密码哈希派生 —— **改密码会自动让所有旧会话失效**
- **各账号的 API Token 在 KV 里是明文**。KV 值在 Cloudflare 侧静态加密,但任何能进入你 Dashboard 的人都能读到。这是"支持运行时在页面里添加账号"这个需求带来的取舍
- 前端静态资源(HTML/CSS/JS)本身不含敏感数据,但所有 `/api/*` 接口都需要登录

## 已知限制

- **不保存历史数据**,只能看当前快照,没有趋势图
- **KV 免费版每天 1,000 次写入**:本项目每轮采集只写 1 次(与账号数无关),所以 5 分钟间隔
  用掉 288 次/天。但**不要把 cron 调到 2 分钟以下**(详见上文)
- 查询存在**自适应采样**误差,额度判断是统计估计值而非精确值
- 单个账号的脚本列表最多取 200 条(超出部分不影响总数统计的准确性判断,但列表不会全显示)
- **账号数 × 子请求**:每轮 cron 对每个账号发 **2 次 GraphQL 查询**(Workers/Pages 一次,平台额度
  一次),外加 2 次 REST 列表查询(Workers 脚本、Pages 项目;后者原先只在有 Pages 流量时才发,
  现在总要发,以便补 0 请求行)。有域名且超过 50 个的账号再按每 50 个 +1。免费版子请求上限是
  **50/次调用**,所以典型情况下约 12 个账号、最坏(4 页 zones)约 6 个账号就到顶了;付费版是
  10,000,毫无压力。另外**同时出站连接上限是 6**,账号超过 6 个时并发请求会排队(不报错,只是变慢)
- **GraphQL 速率限制是 300 次/5 分钟(按 token 算)**:按 5 分钟 cron + 每账号 2 次查询,账号数
  到 100 以内都碰不到;但手动点「刷新」也会触发采集,所以别在 cron 触发的同一分钟内连点多次
- **平台额度只覆盖 D1 / KV / Workers AI**,原因见上文「平台额度」一节(DO 时长取不到,
  Queues / Vectorize 是按月口径)

### 关于 `__unknown__`

用量数据集里偶尔会出现一个叫 `__unknown__` 的"脚本" —— 这是 Cloudflare 解析不出脚本名时
用的哨兵值(`scriptName`/`scriptTag`/`environmentName` 会**一起**变成它),**不是**你账号里
真有个没名字的 Worker。两种成因:

| 成因 | 表现 | 会自愈吗 |
|---|---|---|
| 新部署的 Worker,名字解析延迟 | 约 1~2 小时 | ✅ 会 —— Cloudflare 事后**回溯**把名字补上 |
| 脚本已被删除 | 永久 | ❌ 不会 —— 版本 UUID 在任何现存脚本里都查不到 |

正因为会自愈,本项目**不做反查**,只是把这类行排除在 CPU 告警之外,避免延迟期内误报。
被删脚本留下的 `__unknown__` 行会计入额度统计(那些请求确实发生过),但无法归属到哪个脚本。

## 项目结构

```
src/
  index.ts        入口:API 路由 + 定时任务
  auth.ts         PBKDF2 口令哈希、会话签名、Cookie
  store.ts        KV 读写、告警去重
  cfgraphql.ts    Cloudflare GraphQL 客户端
  cfquotas.ts     D1 / KV / Workers AI 平台额度查询
  cfpages.ts      Pages 项目名还原(内部脚本名 → 项目名)
  cfscripts.ts    Workers 脚本列表(用于补 0 请求行)
  collect.ts      采集与聚合
  notify.ts       Telegram / wxpush 推送与阈值判定
  types.ts        类型定义
public/           前端(原生 HTML/CSS/JS,无构建步骤)
wrangler.sample   部署配置模板 → 复制成 wrangler.jsonc(已 gitignore)
```

## 开源 / 提交前注意

`.gitignore` 已经挡掉了这些,但换机器或改文件名时值得复查一遍:

| 文件 | 里面的敏感内容 |
|---|---|
| `wrangler.jsonc` | KV namespace id;仓库里只保留 `wrangler.sample` |
| `.dev.vars` | 本地开发用的 `INIT_TOKEN` |
| `.wrangler/` | **本地 KV 数据 —— 你添加的账号 API Token 明文存在这里** |

账号 API Token 和通知渠道密钥本身**不在代码或配置里**,它们只存在于部署后的 KV 中
(由面板的配置页写入),所以不会被提交。仓库里搜 `cfut_` 应该一无所获:

```bash
grep -rn "cfut_" . --exclude-dir=node_modules
```
