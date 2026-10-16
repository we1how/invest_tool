// 标的索引用到的纯函数：行业翻译、杠杆 ETF 识别、简介裁剪、研究链接。构建脚本和页面共用。

/** 币安行业分类 -> 中文 */
export const INDUSTRY_CN: Record<string, string> = {
  "Pharma & Biotech": "医药生物", "Industrials": "工业", "Consumer": "消费", "Software & Cloud": "软件与云",
  "Banking": "银行", "Materials": "原材料", "Real Estate": "房地产", "Healthcare": "医疗健康",
  "Retail & E-commerce": "零售电商", "Diversified Finance": "综合金融", "Energy": "能源",
  "Transportation": "交通运输", "Internet & Media": "互联网传媒", "Utilities": "公用事业",
  "Tech Hardware": "科技硬件", "Insurance": "保险", "Semiconductors": "半导体", "Telecom Services": "电信服务",
  "Fintech": "金融科技", "Aerospace & Defense": "航空航天与国防", "Auto & Mobility": "汽车出行",
  // ETF 分类
  "Fixed Income": "债券 ETF", "Broad Market": "宽基 ETF", "Country & Region": "国家 / 地区 ETF",
  "Factor & Style": "因子 / 风格 ETF", "Sector ETF": "行业 ETF", "Dividend & Income": "股息 / 收益 ETF",
  "Leveraged ETF": "杠杆 ETF", "Thematic ETF": "主题 ETF", "Commodity": "商品 ETF", "Single-Stock ETF": "单股 ETF",
  "Crypto Asset": "加密资产 ETF", "Alternatives": "另类 ETF", "Inverse ETF": "反向 ETF", "Multi-Asset": "多资产 ETF",
};

/** 常见公司名（出现在杠杆 ETF 名称里）-> 代码 */
const NAME_TO_SYMBOL: Record<string, string> = {
  APPLE: "AAPL", TESLA: "TSLA", NVIDIA: "NVDA", MICROSOFT: "MSFT", AMAZON: "AMZN", META: "META",
  ALPHABET: "GOOGL", GOOGLE: "GOOGL", NETFLIX: "NFLX", COINBASE: "COIN", MICROSTRATEGY: "MSTR",
  PALANTIR: "PLTR", BROADCOM: "AVGO", ORACLE: "ORCL", MICRON: "MU", INTEL: "INTC", ROBINHOOD: "HOOD",
  UBER: "UBER", SHOPIFY: "SHOP", SNOWFLAKE: "SNOW", ALIBABA: "BABA", SUPERMICRO: "SMCI", BOEING: "BA",
  ELI: "LLY", LILLY: "LLY", NOVO: "NVO", TSMC: "TSM", TAIWAN: "TSM", RIVIAN: "RIVN", AIRBNB: "ABNB",
  SALESFORCE: "CRM", ADOBE: "ADBE", QUALCOMM: "QCOM", MARVELL: "MRVL", ARISTA: "ANET", CROWDSTRIKE: "CRWD",
};

// 名称里常见、但不是股票代码的大写词
const NOT_TICKER = new Set([
  "ETF", "ETN", "USD", "US", "AI", "DAILY", "LONG", "SHORT", "BULL", "BEAR", "TARGET", "TRUST", "FUND",
  "SHARES", "THE", "OF", "AND", "INC", "CORP", "LLC", "II", "III", "SPDR", "MSCI", "NYSE", "NASDAQ",
  "S", "P", "X", "QQQ", "SP", "REX", "ETFS", "INDEX", "PLUS", "ULTRA", "ULTRAPRO", "TRADR", "DEFIANCE",
]);

export interface Leverage { lev: number; u?: string }

/** 从 ETF 名称识别杠杆倍数和方向（负数为反向），以及跟踪的单只股票。识别不出返回 null。 */
export function parseLeverage(name: string, stocks: Set<string>): Leverage | null {
  const text = name.replace(/\s+/g, " ");
  // 短债 / 超短债等"Short"不是做空
  const bondShort = /(ultra[- ]?)?short[- ](term|duration|maturity|treasury|bond|income|municipal|government|high yield)/i.test(text);
  const bear = !bondShort && (/\b(short|bear|inverse)\b/i.test(text) || /UltraShort|UltraPro Short/i.test(text));
  let mult: number | null = null;
  const m = text.match(/(\d+(?:\.\d+)?)\s*[xX]\b/) ?? text.match(/\b[xX](\d+(?:\.\d+)?)\b/);
  if (m) mult = Number(m[1]);
  else if (/\bUltraPro\b/i.test(text)) mult = 3;
  else if (/\bProShares Ultra(Short)?\b/i.test(text)) mult = 2;
  else if (/\bDirexion Daily\b/i.test(text) && /\b(bull|bear)\b/i.test(text)) mult = 1;
  else if (bear && /\b(inverse|ProShares Short)\b/i.test(text)) mult = 1;
  if (mult === null || !(mult >= 1 && mult <= 5)) return null;
  if (mult === 1 && !bear) return null;            // 1 倍做多就是普通 ETF
  const lev = bear ? -mult : mult;

  let u: string | undefined;
  // 按空格切词；带连字符的词（如 T-REX）整体不当作代码
  for (const raw of text.split(" ")) {
    if (raw.includes("-")) continue;
    const tok = raw.replace(/^[^A-Za-z]+|[^A-Za-z.]+$/g, "").replace(/\.$/, "");
    if (/^[A-Z][A-Z.]{0,5}$/.test(tok) && !NOT_TICKER.has(tok) && stocks.has(tok)) { u = tok; break; }
    const named = NAME_TO_SYMBOL[tok.toUpperCase()];
    if (named && stocks.has(named) && tok.length > 3) { u = named; break; }
  }
  return u ? { lev, u } : { lev };
}

/** 中文简介裁剪到约 limit 个字，尽量在句号处断开 */
export function trimIntro(text: string | null | undefined, limit = 160): string | undefined {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  if (!t || t === "--") return undefined;
  if (t.length <= limit) return t;
  const cut = t.slice(0, limit);
  const end = Math.max(cut.lastIndexOf("。"), cut.lastIndexOf("；"));
  return end > limit * 0.5 ? cut.slice(0, end + 1) : cut + "…";
}

export interface ResearchLink { label: string; url: string }

/** 研究入口链接（按代码拼出固定网址） */
export function researchLinks(s: string, t: "S" | "E" | "C", extra: { web?: string; home?: string; perp?: boolean; bs?: boolean } = {}): ResearchLink[] {
  const dash = s.replace(".", "-"), lower = s.toLowerCase();
  const links: ResearchLink[] = [];
  if (t === "S") {
    links.push(
      { label: "SEC 年报 / 季报", url: `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(dash)}&type=10-K&dateb=&owner=include&count=40` },
      { label: "雪球", url: `https://xueqiu.com/S/${encodeURIComponent(s)}` },
      { label: "东方财富", url: `https://quote.eastmoney.com/us/${encodeURIComponent(s.replace(".", "_"))}.html` },
      { label: "Yahoo Finance", url: `https://finance.yahoo.com/quote/${encodeURIComponent(dash)}` },
      { label: "Finviz", url: `https://finviz.com/quote.ashx?t=${encodeURIComponent(dash)}` },
      { label: "StockAnalysis", url: `https://stockanalysis.com/stocks/${encodeURIComponent(lower)}/` },
    );
    if (extra.web) links.push({ label: "公司官网", url: /^https?:/.test(extra.web) ? extra.web : `https://${extra.web}` });
  } else if (t === "E") {
    links.push(
      { label: "StockAnalysis 持仓", url: `https://stockanalysis.com/etf/${encodeURIComponent(lower)}/holdings/` },
      { label: "ETF.com", url: `https://www.etf.com/${encodeURIComponent(s)}` },
      { label: "Yahoo Finance", url: `https://finance.yahoo.com/quote/${encodeURIComponent(dash)}` },
      { label: "雪球", url: `https://xueqiu.com/S/${encodeURIComponent(s)}` },
    );
    if (extra.home) links.push({ label: "发行商产品页", url: extra.home });
  }
  if (extra.perp || t === "C") links.push({ label: "币安合约", url: `https://www.binance.com/zh-CN/futures/${encodeURIComponent(s.replace(".", ""))}USDT` });
  if (extra.bs) links.push({ label: "币安现货（bStocks）", url: `https://www.binance.com/zh-CN/trade/${encodeURIComponent(s)}B_USDT` });
  return links;
}

/** stockanalysis 行业分布的英文名 -> 中文 */
export const SECTOR_CN: Record<string, string> = {
  "Technology": "科技", "Financial Services": "金融", "Financials": "金融", "Healthcare": "医疗",
  "Consumer Cyclical": "可选消费", "Consumer Discretionary": "可选消费", "Consumer Defensive": "必需消费",
  "Consumer Staples": "必需消费", "Industrials": "工业", "Energy": "能源", "Utilities": "公用事业",
  "Real Estate": "房地产", "Basic Materials": "原材料", "Materials": "原材料",
  "Communication Services": "通信服务", "Other": "其他（含现金、衍生品）",
};

/** 美元金额 -> 中文简写：$1.16 万亿 / $352 亿 / $3,200 万 */
export function fmtUsd(v: number | undefined): string {
  if (!v || !Number.isFinite(v)) return "-";
  if (v >= 1e12) return `$${(v / 1e12).toFixed(2)} 万亿`;
  if (v >= 1e8) return `$${(v / 1e8).toFixed(v >= 1e10 ? 0 : 1)} 亿`;
  if (v >= 1e4) return `$${Math.round(v / 1e4).toLocaleString("en-US")} 万`;
  return `$${Math.round(v)}`;
}

export function levLabel(lev: number): string {
  return lev > 0 ? `${lev}x 做多` : `${-lev}x 做空`;
}

export interface Query {
  q: string;
  type: "" | "S" | "E" | "C";
  ind: string;
  lev: "" | "only" | "none" | "long" | "short";
  perp: boolean;
  bs: boolean;
  sort: "mc" | "to" | "s";
}

/** 搜索匹配度：0 代码完全一致 / 1 代码前缀 / 2 名称 / 3 行业 / 4 简介；不匹配返回 -1 */
export function matchScore(
  it: { s: string; n: string; cn?: string; ind?: string; sub?: string; ct?: string }, q: string, intro?: string,
): number {
  if (!q) return 0;
  const s = it.s.toLowerCase();
  if (s === q) return 0;
  if (s.startsWith(q)) return 1;
  if (it.n.toLowerCase().includes(q) || (it.cn ?? "").toLowerCase().includes(q)) return 2;
  if ([it.ind, it.sub, it.ct].some((v) => v && v.toLowerCase().includes(q))) return 3;
  if (intro && intro.toLowerCase().includes(q)) return 4;
  return -1;
}

type Filterable = {
  s: string; n: string; cn?: string; t: "S" | "E" | "C"; ind?: string; sub?: string; ct?: string;
  mc?: number; to?: number; perp?: 1; bs?: 1; lev?: number;
};

/** 按条件筛选并排序。intro 为 代码 -> 中文简介 */
export function filterItems<T extends Filterable>(items: T[], query: Query, intro: Record<string, string> = {}): T[] {
  const q = query.q.trim().toLowerCase();
  const scored: [T, number][] = [];
  for (const it of items) {
    if (query.type && it.t !== query.type) continue;
    if (query.ind && it.ind !== query.ind) continue;
    if (query.perp && !it.perp) continue;
    if (query.bs && !it.bs) continue;
    if (query.lev === "only" && !it.lev) continue;
    if (query.lev === "none" && it.lev) continue;
    if (query.lev === "long" && !(it.lev && it.lev > 0)) continue;
    if (query.lev === "short" && !(it.lev && it.lev < 0)) continue;
    const score = matchScore(it, q, intro[it.s]);
    if (score >= 0) scored.push([it, score]);
  }
  const key = (it: T) => (query.sort === "mc" ? it.mc ?? 0 : query.sort === "to" ? it.to ?? 0 : 0);
  scored.sort((a, b) => a[1] - b[1] || (query.sort === "s" ? a[0].s.localeCompare(b[0].s) : key(b[0]) - key(a[0])));
  return scored.map(([it]) => it);
}
