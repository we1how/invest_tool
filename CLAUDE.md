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

## 标的索引（`npm run data`）

- 标的清单来自币安 App 内部接口 `bapi/equity/v1/public/equity/symbol/get-symbols-static`（及 `-dynamic` 的成交额），没有公开文档。币安对美国 IP 返回 restricted location，脚本必须在非美国节点下跑。
- **合约代码和美股代码会撞名**：合约 CL 是 WTI 原油、BZ 是布伦特原油，而美股 CL 是高露洁、BZ 是 Kanzhun。合约只按 `underlyingType === "EQUITY"` 去对应美股。
- 代币化现货用币安产品接口里的 `tags: ["bStocks"]` 识别，不要按"代码 + B"猜（BNB 会被误认成 BN）。
- 东方财富美股代码用下划线（BRK_B），币安用点（BRK.B）。
- 杠杆 ETF 是按名称识别的（`parseLeverage`）：注意 "Ultra-Short Income" 这类是超短债不是做空，"T-REX" 里的 T 不是 AT&T。
- 页面上的数据都是快照，`generatedAt` 显示在结果数旁边。
- 业务画像来自东方财富 `pc_usf10/CompanyInfo/PageAjax` 的 `zygc_cp` / `zygc_dq`（主营构成）和 datacenter `RPT_USF10_FN_INCOME`（年报利润表，`DATE_TYPE_CODE=001`）。东方财富的"营销费用"实际是销售及管理费用（SG&A）合计。银行的"收入总额"已扣掉利息支出，所以利息支出不算进支出项；名字以"收入"结尾的科目（如"存贷款相关费用收入"）不是支出。
- 东方财富的 push2 批量行情接口在部分代理节点下连不上（空响应），而公司资料和 datacenter 接口正常。脚本不依赖 push2：中文名从公司资料和上一份快照里兜底，交易所后缀按 O / N / A 逐个试。
- 缓存（`platform/.cache/universe/em_f10.json`）带版本号 `F10_VERSION`，改了抓取的字段就把版本号加 1，旧缓存会自动重抓。
