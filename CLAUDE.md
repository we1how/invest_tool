# invest_tool 备忘

网页版在 `platform/`（Cloudflare Worker + Vite），Worker 名是 `invest-tool`。
`platform/` 下：`npm test` 跑单测，`npm run deploy` 部署。Python 脚本是原版，保留不删。

## 踩过的坑（改动前先看）

- **腾讯日线接口**（`newfqkline`）会忽略起始日期，固定返回"截止日之前最近 640 根"。所以 `fetchTxKline` 按两年一段分块取再去重拼接，不要改成一次取完。
- **`Number("")` 是 0**。`worker/http.ts` 的 `num()` 对空值返回 NaN，缺失字段才会走到估算 / 置空的分支；别换回 `Number()`。
- **东方财富十大股东**按季度末日期查。新上市的股票只有上市日的名单，季度末全是空，所以最后要退回 `PageAjax`（给出最新一期）。老股票不直接用 `PageAjax`，因为它的"最新一期"可能是临时公告日，和十大流通股东的报告期对不上。
- **天天基金持仓**每一期都只有前十大，ETF 穿透因此只有 10 只成份股，这是数据源限制，不是解析 bug。
- **Worker 免费套餐**每次请求只有 10ms CPU、50 个子请求：计算放浏览器，ETF 穿透和逐笔成交分页由浏览器分批调接口。
- **线上数据源连通性**只有部署后才能确认，用 `/api/health` 看。东方财富的 `push2his` 日线在海外时好时坏，所以日线顺序是 腾讯 → 新浪 → 东方财富。
- akshare 的基金持仓请求不带 UA 会被拦，Python 版里用的是自己写的 `fund_hold_em`。
- 本机没有 Chrome；要截图检查页面可以用 `~/Library/Caches/ms-playwright` 里的 Chromium 配 `playwright-core`。
