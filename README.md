# invest_tool

个人用的 A 股投资小工具：三个 Python 脚本，以及把它们整合到一个页面、部署在 Cloudflare Workers 上的网页版。

数据来自腾讯、新浪、东方财富 / 天天基金的公开接口，仅供个人研究参考，不构成投资建议。

## 三个工具

| 工具 | 做什么 | 网页标签页 | Python 脚本 |
|---|---|---|---|
| 十大股东 | 一只或多只股票的十大股东 / 十大流通股东，并找出多只股票里的相同股东；ETF 则列出成份股并逐只穿透汇总 | 十大股东 | `top10_holders.py` |
| 资金量价 | 单只股票近 N 天的成交额、成交量、环比变化率、流入流出估算、最近交易日的主动买卖累计 | 资金量价 | `stock_volume.py` |
| 事件窗口 | 多只股票 × 多个年份，在某个事件日（春节、国庆、财报截止日、自定义日期…）前后各 N 个交易日的走势对比 | 事件窗口 | `event_window.py` |
| 标的索引 | 币安"传统金融"板块的全部标的（约 8000 只美股 / ETF，以及只有合约的港股、韩股、大宗商品等）：中文名、行业、市值、成交额、业务画像（收入构成、利润率、主要支出）、中文简介、ETF 杠杆与持仓、研究链接，可按关键词反查 | 标的索引 | 无（数据由 `platform/scripts/build-universe.ts` 生成） |

网页版把查询参数写在网址里，复制网址就能分享或收藏一次查询。

## 网页版（`platform/`）

```
浏览器（Vite + TypeScript 单页，Plotly 画图，所有计算在这里做）
   │  /api/*
Cloudflare Worker（只负责取数：请求数据源 → 规整成紧凑 JSON → 加缓存头）
   │
腾讯 / 新浪 / 东方财富
```

- `worker/`：接口路由和各数据源的请求、解析。`/api/health` 会把每个数据源探一遍，用来确认线上能不能连通。
- `src/lib/`：纯计算函数（事件窗口、相同股东、ETF 穿透、均线和变化率）。
- `src/tabs/`：三个标签页的表单和渲染。
- `test/`：解析器（用保存下来的真实响应做样本）和计算函数的单元测试。

```bash
cd platform
npm install
npm run dev        # 本地开发，http://localhost:5173
npm test           # 单元测试
npm run deploy     # 类型检查 + 构建 + 部署到 Cloudflare（需要先 npx wrangler login）
```

想加新的事件，在 `platform/src/lib/event.ts` 的 `EVENTS` 里加一行即可。

### 刷新"标的索引"的数据

标的索引读的是一份静态快照（`platform/public/data/`），不是实时抓取。刷新步骤：

```bash
cd platform
npm run data        # 需要能访问币安的网络（非美国节点），首次约 10 分钟，之后增量很快
npm run deploy
```

- 中文简介有本地缓存（`platform/.cache/`），只补新上市的；ETF 持仓超过 30 天才重抓。
- `npm run data -- --etf-top=1000` 改抓持仓的 ETF 数量；`-- --refresh` 忽略缓存全部重抓。

## Python 脚本

改文件顶部的参数区，然后直接运行，结果会生成 HTML 并自动在浏览器打开：

```bash
pip install akshare pandas plotly requests
python3 top10_holders.py
python3 stock_volume.py
python3 event_window.py
```

## 已知限制

- ETF 的持仓来自天天基金，实际每一期都只给出前十大重仓股，所以"穿透"只覆盖这 10 只。
- 新上市的股票在第一份定期报告之前没有十大流通股东数据。
- 流入 / 流出是用 5 分钟 K 线估算的，不是交易所口径的资金流向。
- 事件窗口的价格是未复权收盘价；窗口内有除权除息时曲线会出现跳变。
- 标的索引的标的清单来自币安 App 内部接口（没有公开文档，可能变动）；ETF 只抓了成交额前 500 只的持仓，杠杆倍数是按基金名称识别的。
