// 生成"标的索引"的数据快照：public/data/universe.json、intro.json（中文简介）、profile.json（业务画像）
//
//   node scripts/build-universe.ts               # 增量：简介 / ETF 持仓用本地缓存，只补新的
//   node scripts/build-universe.ts --etf-top=500 # ETF 持仓抓成交额前 N 只（默认 500）
//   node scripts/build-universe.ts --refresh     # 忽略缓存全部重抓
//
// 必须在能访问币安的网络下运行（币安对美国等地区的 IP 返回 restricted location）。
// 数据源：币安（标的清单、合约、bStocks）、东方财富（中文名、中文简介、主营构成、利润表）、stockanalysis.com（ETF 持仓）。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { INDUSTRY_CN, isCostItem, parseBreakdown, parseIncome, parseLeverage, trimIntro } from "../src/lib/universe.ts";
import type { EtfInfo, Profile, UniverseFile, UniverseItem } from "../src/types.ts";

setGlobalDispatcher(new EnvHttpProxyAgent());     // 走 HTTPS_PROXY / HTTP_PROXY

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const OUT_DIR = path.join(ROOT, "public", "data");
const CACHE_DIR = path.join(ROOT, ".cache", "universe");
const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "1"]; }));
const REFRESH = args.has("refresh");
const ETF_TOP = Number(args.get("etf-top") ?? 500);
const ETF_TTL_DAYS = 30;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function get(url: string, opts: { referer?: string; tries?: number; timeout?: number } = {}): Promise<string> {
  let last: unknown;
  for (let i = 0; i < (opts.tries ?? 3); i++) {
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": UA, Accept: "*/*", ...(opts.referer ? { Referer: opts.referer } : {}) },
        signal: AbortSignal.timeout(opts.timeout ?? 30_000),
      });
      const text = await res.text();
      if (res.status === 429 || res.status >= 500) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { fatal: true });
      return text;
    } catch (ex) {
      last = ex;
      if ((ex as { fatal?: boolean }).fatal) break;
      await sleep(1500 * (i + 1));
    }
  }
  throw last;
}
const getJson = async <T>(url: string, referer?: string): Promise<T> => JSON.parse(await get(url, { referer })) as T;

async function pool<T>(items: T[], limit: number, fn: (item: T, i: number) => Promise<void>, label: string): Promise<void> {
  let next = 0, done = 0;
  const t0 = Date.now();
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
      if (++done % 100 === 0 || done === items.length) {
        console.log(`  ${label} ${done}/${items.length}（${Math.round((Date.now() - t0) / 1000)}s）`);
      }
    }
  }));
}

function loadCache<T>(name: string): Record<string, T> {
  const file = path.join(CACHE_DIR, name);
  return !REFRESH && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
}
function saveCache(name: string, data: unknown): void {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.writeFileSync(path.join(CACHE_DIR, name), JSON.stringify(data));
}

// ---------------- 1. 币安 ----------------
type EqStatic = { ac: string; s: string; n: string; t: string; ssi: string | null; mc: string | null; opt?: boolean; d?: boolean };
type EqDynamic = { ac: string; ta: string | null };
type FutSymbol = { baseAsset: string; contractType: string; status: string; underlyingType: string };
type Product = { b: string; q: string; st: string; tags: string[] };

async function binance() {
  const bapi = "https://www.binance.com/bapi";
  const check = <T>(body: { success?: boolean; msg?: string; data: T }) => {
    if (!body.data) throw new Error(`币安返回异常：${JSON.stringify(body).slice(0, 200)}（如果提示 restricted location，请切换到非美国节点）`);
    return body.data;
  };
  const [st, dy, fut, prod] = await Promise.all([
    getJson<{ data: EqStatic[] }>(`${bapi}/equity/v1/public/equity/symbol/get-symbols-static`).then(check),
    getJson<{ data: EqDynamic[] }>(`${bapi}/equity/v1/public/equity/symbol/get-symbols-dynamic`).then(check),
    getJson<{ symbols?: FutSymbol[]; msg?: string }>("https://fapi.binance.com/fapi/v1/exchangeInfo"),
    getJson<{ data: Product[] }>(`${bapi}/asset/v2/friendly/asset-service/product/get-product-static?includeEtf=true`).then(check),
  ]);
  if (!fut.symbols) throw new Error(`币安合约接口返回异常：${fut.msg ?? ""}`);
  return { st, dy, fut: fut.symbols.filter((s) => s.contractType === "TRADIFI_PERPETUAL" && s.status === "TRADING"), prod };
}

// ---------------- 2. 东方财富：美股中文名 + 市场代码 ----------------
type EmRow = { f12: string; f13: number; f14: string };

async function emList(): Promise<Map<string, EmRow>> {
  const url = (pn: number) => `https://push2.eastmoney.com/api/qt/clist/get?${new URLSearchParams({
    pn: String(pn), pz: "100", po: "1", np: "1", fltt: "2", invt: "2", fid: "f20",
    fs: "m:105,m:106,m:107", fields: "f12,f13,f14" })}`;
  type Resp = { data: { total: number; diff: EmRow[] } | null };
  const first = await getJson<Resp>(url(1));
  const total = first.data?.total ?? 0;
  const pages = Array.from({ length: Math.ceil(total / 100) - 1 }, (_, i) => i + 2);
  const rows = [...(first.data?.diff ?? [])];
  await pool(pages, 4, async (pn) => { rows.push(...((await getJson<Resp>(url(pn))).data?.diff ?? [])); }, "东方财富美股列表（页）");
  // 东方财富用下划线：BRK_B
  return new Map(rows.map((r) => [r.f12.replace("_", "."), r]));
}

// ---------------- 3. 东方财富 F10：中文简介 + 主营构成 + 利润表 ----------------
const F10_VERSION = 2;           // 缓存结构变了就加 1，旧缓存会自动重抓
type F10 = {
  v: number; cn?: string; intro?: string; sub?: string; web?: string; at: string;
  seg?: [string, number][]; reg?: [string, number][]; segAt?: string; inc?: Omit<Profile, "seg" | "reg" | "segAt"> | null;
};
const EM_SUFFIX: Record<number, string> = { 105: "O", 106: "N", 107: "A" };

async function f10(code: string, market?: number): Promise<F10> {
  type Row = Record<string, string | number | null>;
  type Resp = { data?: { gszl?: Record<string, string>[]; zygc_cp?: Row[]; zygc_dq?: Row[] } };
  // 不知道交易所时依次试纳斯达克 / 纽交所 / 美交所
  const suffixes = market && EM_SUFFIX[market] ? [EM_SUFFIX[market]] : ["O", "N", "A"];
  let body: Resp = {}, full = "";
  for (const sfx of suffixes) {
    full = `${code.replace(".", "_")}.${sfx}`;
    body = await getJson<Resp>(`https://emweb.eastmoney.com/pc_usf10/CompanyInfo/PageAjax?fullCode=${full}`,
      "https://emweb.eastmoney.com/");
    if (body.data?.gszl?.length) break;
  }
  if (!body.data?.gszl?.length) return { v: F10_VERSION, at: new Date().toISOString() };
  const g = body.data?.gszl?.[0] ?? {};
  const val = (k: string) => (g[k] && g[k] !== "--" ? g[k].trim() : undefined);
  const seg = parseBreakdown(body.data?.zygc_cp, "PRODUCTNAME");
  const reg = parseBreakdown(body.data?.zygc_dq, "REGIONNAME");
  const segAt = [...(body.data?.zygc_cp ?? []), ...(body.data?.zygc_dq ?? [])].map((r) => String(r.REPORTDATE)).sort().at(-1);

  // 最近一个财年的利润表（年报）
  type IncResp = { result?: { data?: Row[] } | null };
  const inc = await getJson<IncResp>(`https://datacenter.eastmoney.com/securities/api/data/v1/get?${new URLSearchParams({
    reportName: "RPT_USF10_FN_INCOME", columns: "REPORT_DATE,ITEM_NAME,AMOUNT,YOY_RATIO,CURRENCY_ABBR",
    filter: `(SECUCODE="${full}")(DATE_TYPE_CODE="001")`, pageNumber: "1", pageSize: "80",
    sortTypes: "-1", sortColumns: "REPORT_DATE" })}`, "https://emweb.eastmoney.com/");
  return {
    v: F10_VERSION, ...(/[\u4e00-\u9fff]/.test(val("SECURITYSHORTNAME") ?? "") ? { cn: val("SECURITYSHORTNAME") } : {}),
    intro: trimIntro(val("COMPPROFILE")), sub: val("INDUSTRY"), web: val("WEBSITE"), at: new Date().toISOString(),
    ...(seg.length ? { seg } : {}), ...(reg.length ? { reg } : {}), ...(segAt ? { segAt: segAt.slice(0, 10) } : {}),
    inc: parseIncome(inc.result?.data ?? []),
  };
}

// ---------------- 4. stockanalysis：ETF 持仓与行业分布 ----------------
type EtfCache = EtfInfo & { at: string };
const strip = (html: string) => html.replace(/<!--.*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();
const esc = (label: string) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** 概览页：<span class="block font-semibold">标签</span> <span>值</span> */
const spanField = (html: string, label: string) =>
  html.match(new RegExp(`>${esc(label)}</span>\\s*(?:<a[^>]*>|<span[^>]*>)([^<]+)<`))?.[1]?.replace(/&amp;/g, "&").trim();
/** 持仓页：<div>标签 <div ...>值</div> */
const divField = (html: string, label: string) =>
  html.match(new RegExp(`<div>${esc(label)} <div[^>]*>([^<]+)</div>`))?.[1]?.trim();

export function parseEtfPages(overview: string, holdings: string): EtfInfo {
  const info: EtfInfo = {};
  info.cat = divField(holdings, "ETF Category") ?? spanField(overview, "Category");
  info.idx = spanField(overview, "Index Tracked");
  info.exp = overview.match(/>Expense Ratio<\/td><td[^>]*>([^<]+)</)?.[1];
  info.aum = divField(holdings, "Assets");
  info.prov = overview.match(/provider:"([^"]+)"/)?.[1] ?? spanField(overview, "ETF Provider");
  info.home = overview.match(/href="([^"]+)"[^>]*title="Official ETF Website"/)?.[1];
  const sectors = holdings.match(/sectors:\[(.*?)\]/)?.[1];
  if (sectors) {
    info.sec = [...sectors.matchAll(/n:"([^"]+)",w:([\d.]+)/g)].map((m): [string, number] => [m[1], Number(m[2])]);
  }
  const body = holdings.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/)?.[1] ?? "";
  info.top = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].slice(0, 10).map((tr) => {
    const td = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => strip(x[1]));
    return [td[1] && td[1] !== "n/a" ? td[1] : "", td[2] ?? "", Number((td[3] ?? "").replace("%", "")) || 0] as [string, string, number];
  }).filter((r) => r[1]);
  for (const k of Object.keys(info) as (keyof EtfInfo)[]) {
    const v = info[k];
    if (v === undefined || v === "" || (Array.isArray(v) && !v.length)) delete info[k];
  }
  return info;
}

async function etfInfo(sym: string): Promise<EtfInfo> {
  const base = `https://stockanalysis.com/etf/${sym.toLowerCase()}/`;
  const overview = await get(base);
  await sleep(300);
  const holdings = await get(`${base}holdings/`);
  return parseEtfPages(overview, holdings);
}

// ---------------- 仅合约标的（港股、韩股、大宗商品等）的中文名 ----------------
const CONTRACT_TYPE_CN: Record<string, string> = {
  EQUITY: "美股", HK_EQUITY: "港股", KR_EQUITY: "韩股", CN_EQUITY: "A 股 / 未上市", COMMODITY: "大宗商品",
  PREMARKET: "未上市公司", FX: "外汇", INDEX: "指数",
};
const CONTRACT_CN: Record<string, string> = {
  XAU: "黄金", XAG: "白银", XPT: "铂金", XPD: "钯金", COPPER: "铜", CL: "WTI 原油", BZ: "布伦特原油", NATGAS: "天然气",
  TENCENT: "腾讯控股", HK0700: "腾讯控股（00700）", HK1810: "小米集团（01810）", HK0992: "联想集团（00992）",
  MEITUAN: "美团", KUAISHOU: "快手", POPMART: "泡泡玛特", BYD: "比亚迪", ZHIPU: "智谱", MINIMAX: "MiniMax",
  GIGADEV: "兆易创新", ZHONGJI: "中际旭创", CSOPSKHYNIX2L: "南方东英 SK 海力士两倍做多", CSOPSAMSUNG2L: "南方东英三星电子两倍做多",
  SKHYNIX: "SK 海力士", SAMSUNG: "三星电子", SAMSUNGEM: "三星电机", HYUNDAI: "现代汽车", HANMI: "韩美半导体",
  LGELECTRONICS: "LG 电子", NAVER: "NAVER", KODEX200: "KODEX 200（韩国 KOSPI 200 ETF）",
  CXMT: "长鑫存储", UNITREE: "宇树科技", OPENAI: "OpenAI", ANTHROPIC: "Anthropic", MOONSHOT: "月之暗面", OURA: "Oura",
  USDBRL: "美元 / 巴西雷亚尔",
};
const FUT_ALIAS: Record<string, string> = { BRKB: "BRK.B" };   // 合约代码 -> 美股代码

// ---------------- 主流程 ----------------
async function main(): Promise<void> {
  console.log("1/4 币安：标的清单、合约、bStocks");
  const { st, dy, fut, prod } = await binance();
  const turnover = new Map(dy.map((d) => [d.ac, Number(d.ta) || 0]));

  console.log("2/4 东方财富：美股中文名");
  let em: Map<string, EmRow>;
  const emFile = path.join(CACHE_DIR, "em_list.json");
  try {
    em = await emList();
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(emFile, JSON.stringify([...em.values()]));
  } catch (ex) {
    const why = ex instanceof Error ? ex.message : String(ex);
    if (fs.existsSync(emFile)) {
      console.log(`  获取失败（${why}），改用上次缓存的列表`);
      em = new Map((JSON.parse(fs.readFileSync(emFile, "utf8")) as EmRow[]).map((r) => [r.f12.replace("_", "."), r]));
    } else {
      console.log(`  获取失败（${why}），中文名改从公司资料和上一份快照里取`);
      em = new Map();
    }
  }
  // 上一份快照里的中文名，列表接口失败时兜底
  const prevCn = new Map<string, string>();
  const prevFile = path.join(OUT_DIR, "universe.json");
  if (fs.existsSync(prevFile)) {
    for (const it of (JSON.parse(fs.readFileSync(prevFile, "utf8")) as UniverseFile).items) if (it.cn) prevCn.set(it.s, it.cn);
  }

  // 只收录正常的股票和 ETF（排除权利凭证、CVR 等带数字的代码）
  const listed = st.filter((r) => (r.t === "STOCK" || r.t === "ETF") && /^[A-Z][A-Z.]*$/.test(r.s));
  const stockSet = new Set(listed.filter((r) => r.t === "STOCK").map((r) => r.s));
  const symbols = new Set(listed.map((r) => r.s));

  const perpEquity = new Set(fut.filter((f) => f.underlyingType === "EQUITY").map((f) => FUT_ALIAS[f.baseAsset] ?? f.baseAsset));
  const bStocks = new Set(prod.filter((p) => p.tags?.includes("bStocks") && p.st === "TRADING").map((p) => p.b.replace(/B$/, "")));

  const items: UniverseItem[] = listed.map((r) => {
    const it: UniverseItem = { s: r.s, n: r.n, t: r.t === "STOCK" ? "S" : "E" };
    const cn = em.get(r.s)?.f14;
    if (cn && /[一-鿿]/.test(cn)) it.cn = cn;
    else if (prevCn.has(r.s)) it.cn = prevCn.get(r.s);
    if (r.ssi) it.ind = INDUSTRY_CN[r.ssi] ?? r.ssi;
    const mc = Number(r.mc);
    if (mc > 0) it.mc = mc;
    const to = turnover.get(r.ac);
    if (to) it.to = Math.round(to);
    if (perpEquity.has(r.s)) it.perp = 1;
    if (bStocks.has(r.s)) it.bs = 1;
    if (r.opt) it.opt = 1;
    if (it.t === "E") {
      const lev = parseLeverage(r.n, stockSet);
      if (lev) { it.lev = lev.lev; if (lev.u) it.u = lev.u; }
      else if (r.ssi === "Single-Stock ETF") {
        const u = parseLeverage(`${r.n} 1x`, stockSet)?.u;      // 单股非杠杆 ETF（如备兑），只取跟踪标的
        if (u) it.u = u;
      }
    }
    return it;
  });

  // 只有合约、不在股票清单里的标的
  for (const f of fut) {
    const s = FUT_ALIAS[f.baseAsset] ?? f.baseAsset;
    if (f.underlyingType === "EQUITY" && symbols.has(s)) continue;
    items.push({ s: f.baseAsset, n: CONTRACT_CN[f.baseAsset] ?? f.baseAsset, t: "C", ct: CONTRACT_TYPE_CN[f.underlyingType] ?? f.underlyingType, perp: 1 });
  }

  console.log("3/4 东方财富 F10：中文简介、主营构成、利润表（有缓存的跳过）");
  const f10Cache = loadCache<F10>("em_f10.json");
  const todo = items.filter((it) => it.t === "S" && f10Cache[it.s]?.v !== F10_VERSION);
  let failed = 0;
  await pool(todo, 4, async (it) => {
    try { f10Cache[it.s] = await f10(it.s, em.get(it.s)?.f13); } catch { failed++; }
    if (Object.keys(f10Cache).length % 200 === 0) saveCache("em_f10.json", f10Cache);
  }, "简介");
  saveCache("em_f10.json", f10Cache);
  if (failed) console.log(`  ${failed} 只简介获取失败，下次运行会重试`);
  const intro: Record<string, string> = {};
  const profile: Record<string, Profile> = {};
  for (const it of items) {
    const c = f10Cache[it.s];
    if (!c) continue;
    if (c.intro) intro[it.s] = c.intro;
    if (!it.cn && c.cn) it.cn = c.cn;
    if (c.inc || c.seg || c.reg) {
      // 支出科目的筛选规则改过时，旧缓存也按新规则过滤一遍
      const inc = c.inc ? { ...c.inc, ...(c.inc.cost ? { cost: c.inc.cost.filter(([n]) => isCostItem(n)) } : {}) } : null;
      profile[it.s] = { ...(inc ?? { fy: "", cur: "USD" }), ...(c.seg ? { seg: c.seg } : {}), ...(c.reg ? { reg: c.reg } : {}),
                        ...(c.segAt ? { segAt: c.segAt } : {}) };
    }
    if (c.sub) it.sub = c.sub;
    if (c.web) it.web = c.web;
  }

  console.log(`4/4 stockanalysis：成交额前 ${ETF_TOP} 只 ETF 的持仓（30 天内抓过的跳过）`);
  const etfCache = loadCache<EtfCache>("sa_etf.json");
  const stale = (c?: EtfCache) => !c || Date.now() - Date.parse(c.at) > ETF_TTL_DAYS * 86400_000;
  const topEtfs = items.filter((it) => it.t === "E").sort((a, b) => (b.to ?? 0) - (a.to ?? 0)).slice(0, ETF_TOP);
  let etfFailed = 0;
  await pool(topEtfs.filter((it) => stale(etfCache[it.s])), 2, async (it) => {
    try { etfCache[it.s] = { ...(await etfInfo(it.s)), at: new Date().toISOString() }; } catch { etfFailed++; }
    await sleep(300);
    if (Object.keys(etfCache).length % 50 === 0) saveCache("sa_etf.json", etfCache);
  }, "ETF");
  saveCache("sa_etf.json", etfCache);
  if (etfFailed) console.log(`  ${etfFailed} 只 ETF 获取失败，下次运行会重试`);
  for (const it of items) {
    const c = etfCache[it.s];
    if (it.t !== "E" || !c) continue;
    const { at: _at, ...info } = c;
    it.etf = info;
  }

  const counts = {
    stocks: items.filter((i) => i.t === "S").length, etfs: items.filter((i) => i.t === "E").length,
    contractOnly: items.filter((i) => i.t === "C").length, perp: items.filter((i) => i.perp).length,
    bStocks: items.filter((i) => i.bs).length, leveraged: items.filter((i) => i.lev).length,
    withIntro: Object.keys(intro).length, withProfile: Object.keys(profile).length, withCn: items.filter((i) => i.cn).length, etfDetail: items.filter((i) => i.etf).length,
  };
  const file: UniverseFile = { generatedAt: new Date().toISOString(), counts, items };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "universe.json"), JSON.stringify(file));
  fs.writeFileSync(path.join(OUT_DIR, "intro.json"), JSON.stringify(intro));
  fs.writeFileSync(path.join(OUT_DIR, "profile.json"), JSON.stringify(profile));
  const size = (f: string) => `${(fs.statSync(path.join(OUT_DIR, f)).size / 1e6).toFixed(2)} MB`;
  console.log("完成：", counts, `universe.json ${size("universe.json")}，intro.json ${size("intro.json")}，profile.json ${size("profile.json")}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((ex) => { console.error("失败：", ex instanceof Error ? ex.message : ex); process.exit(1); });
}
