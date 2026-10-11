// 东方财富 / 天天基金：十大股东、十大流通股东、主力资金流、基金持仓、日线（降级用）
import { marketOf, quarterEnds } from "../../src/lib/market";
import type { FundHolding, FundHoldingsResp, HolderRow, HoldersResp, KlineRow, MainFlowRow } from "../../src/types";
import { getText, num, qs } from "../http";

const secid = (code: string) => `${marketOf(code) === "sh" ? 1 : 0}.${code}`;
const nullable = (v: unknown) => { const n = num(v); return Number.isFinite(n) ? n : null; };

// ---------------- 十大股东 ----------------
export function parseHolders(text: string, floating: boolean): HolderRow[] {
  const body = JSON.parse(text) as Record<string, Record<string, unknown>[] | undefined>;
  const list = (floating ? body.sdltgd : body.sdgd) ?? [];
  return list.slice(0, 10).map((r) => ({
    rank: num(r.HOLDER_RANK),
    name: String(r.HOLDER_NAME ?? ""),
    kind: String((floating ? r.HOLDER_TYPE : r.SHARES_TYPE) ?? ""),
    shares: nullable(r.HOLD_NUM),
    ratio: nullable(floating ? r.FREE_HOLDNUM_RATIO : r.HOLD_NUM_RATIO),
    change: String(r.HOLD_NUM_CHANGE ?? "-"),
  }));
}

/** 响应里第一行的截止日期（YYYY-MM-DD） */
export function holdersPeriod(text: string, floating: boolean): string | null {
  const body = JSON.parse(text) as Record<string, { END_DATE?: string }[] | undefined>;
  const first = (floating ? body.sdltgd : body.sdgd)?.[0];
  return first?.END_DATE ? first.END_DATE.slice(0, 10) : null;
}

const HOLDERS_API = "https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch";

/** 从最近的报告期往前找，第一个有数据的就是最新一期。
 *  新上市的股票还没有定期报告（只有上市公告里的股东名单），这时退回接口给出的最新一期。 */
export async function fetchHolders(code: string, floating: boolean, today: Date): Promise<HoldersResp> {
  const page = floating ? "PageSDLTGD" : "PageSDGD";
  const symbol = marketOf(code).toUpperCase() + code;
  const referer = "https://emweb.securities.eastmoney.com/";
  let lastError: unknown = null;
  for (const date of quarterEnds(today)) {
    try {
      const rows = parseHolders(await getText(`${HOLDERS_API}/${page}?${qs({ code: symbol, date })}`, referer), floating);
      if (rows.length) return { period: date, source: "东方财富", rows };
    } catch (ex) {
      lastError = ex;                 // 该报告期尚未披露或请求失败，继续往前找
    }
  }
  try {
    const text = await getText(`${HOLDERS_API}/PageAjax?${qs({ code: symbol })}`, referer);
    const rows = parseHolders(text, floating);
    if (rows.length) return { period: holdersPeriod(text, floating) ?? "最新", source: "东方财富", rows };
  } catch (ex) {
    lastError = ex;
  }
  if (lastError) throw lastError;
  throw new Error(floating ? "没有披露十大流通股东（新上市的股票要等第一份定期报告）" : "没有披露十大股东数据（代码可能不存在）");
}

// ---------------- 主力资金流 ----------------
/** klines 每行："日期,主力净流入,小单,中单,大单,超大单,..." */
export function parseMainFlow(text: string): MainFlowRow[] {
  const body = JSON.parse(text) as { data?: { klines?: string[] } | null };
  return (body.data?.klines ?? []).map((line) => {
    const f = line.split(",");
    return { date: f[0], mainNet: num(f[1]) };
  });
}

export async function fetchMainFlow(code: string): Promise<MainFlowRow[]> {
  const url = `https://push2his.eastmoney.com/api/qt/stock/fflow/daykline/get?${qs({
    secid: secid(code), lmt: 0, klt: 101, fields1: "f1,f2,f3,f7",
    fields2: "f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61,f62,f63,f64,f65",
  })}`;
  return parseMainFlow(await getText(url, "https://data.eastmoney.com/"));
}

// ---------------- 日线（降级） ----------------
/** klines 每行："日期,开,收,高,低,成交量(手),成交额(元)" */
export function parseEmKline(text: string): KlineRow[] {
  const body = JSON.parse(text) as { data?: { klines?: string[] } | null };
  return (body.data?.klines ?? []).map((line) => {
    const f = line.split(",");
    return { date: f[0], open: num(f[1]), close: num(f[2]), volume: num(f[5]), amount: num(f[6]) };
  });
}

export async function fetchEmKline(code: string, start: string, end: string): Promise<KlineRow[]> {
  const url = `https://push2his.eastmoney.com/api/qt/stock/kline/get?${qs({
    secid: secid(code), fields1: "f1,f2,f3,f4,f5,f6", fields2: "f51,f52,f53,f54,f55,f56,f57",
    klt: 101, fqt: 0, beg: start.replaceAll("-", ""), end: end.replaceAll("-", ""),
  })}`;
  return parseEmKline(await getText(url, "https://quote.eastmoney.com/"));
}

// ---------------- 基金持仓 ----------------
const cellText = (html: string) =>
  html.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, "").trim();

/** 返回 { "2026年2季度": [...], ... }。响应是一段 JS：var apidata={ content:"<div ...>", arryear:[...] } */
export function parseFundHoldings(text: string): Record<string, FundHolding[]> {
  const m = text.match(/content:"([\s\S]*?)",\s*arryear/);
  if (!m) return {};
  const content = m[1].replace(/\\"/g, '"');
  const out: Record<string, FundHolding[]> = {};
  for (const block of content.split("<div class='box'>").slice(1)) {
    const label = block.match(/(\d{4}年\d季度)股票投资明细/)?.[1];
    const head = block.match(/<thead>([\s\S]*?)<\/thead>/)?.[1];
    const body = block.match(/<tbody>([\s\S]*?)<\/tbody>/)?.[1];
    if (!label || !head || !body) continue;
    const cols = [...head.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)].map((x) => cellText(x[1]));
    const at = (prefix: string) => cols.findIndex((c) => c.startsWith(prefix));
    const [iCode, iName, iWeight, iShares, iValue] =
      [at("股票代码"), at("股票名称"), at("占净值"), at("持股数"), at("持仓市值")];
    if ([iCode, iName, iWeight].some((i) => i < 0)) continue;
    const zero = (v: string | undefined) => { const n = num(v); return Number.isFinite(n) ? n : 0; };
    out[label] = [...body.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)].map((tr) => {
      const td = [...tr[1].matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((x) => cellText(x[1]));
      return { code: td[iCode], name: td[iName], weight: zero(td[iWeight]),
               shares: zero(td[iShares]), value: zero(td[iValue]) };
    }).filter((r) => r.code);
  }
  return out;
}

/** 季报只披露前十大，半年报 / 年报才披露全部持仓：取最近一个行数 > 10 的报告期，都没有就退回最新一期 */
export function pickPeriod(periods: Record<string, FundHolding[]>): FundHoldingsResp | null {
  const labels = Object.keys(periods).filter((k) => periods[k].length);
  if (!labels.length) return null;
  const full = labels.filter((k) => periods[k].length > 10);
  const period = (full.length ? full : labels).sort().at(-1)!;
  const rows = [...periods[period]].sort((a, b) => b.weight - a.weight);
  return { period, isFull: full.length > 0, rows };
}

export async function fetchFundHoldings(code: string, today: Date): Promise<FundHoldingsResp> {
  const year = today.getFullYear();
  const results = await Promise.allSettled([year, year - 1].map((y) =>
    getText(`https://fundf10.eastmoney.com/FundArchivesDatas.aspx?${qs({
      type: "jjcc", code, topline: 10000, year: y, month: "", rt: "0.9",
    })}`, "https://fundf10.eastmoney.com/", 20_000).then(parseFundHoldings)));   // 这个接口在海外偶尔很慢
  const merged: Record<string, FundHolding[]> = {};
  for (const r of results) if (r.status === "fulfilled") Object.assign(merged, r.value);
  const picked = pickPeriod(merged);
  if (picked) return picked;
  const failed = results.find((r) => r.status === "rejected");
  throw failed ? failed.reason : new Error("未取到持仓数据（该代码可能不是基金，或近两年没有披露持仓）");
}
