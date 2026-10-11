// 新浪：日线（降级用，无成交额）、5 分钟 K 线（估算每日流入 / 流出）
import { marketOf } from "../../src/lib/market";
import type { FlowRow, KlineRow } from "../../src/types";
import { getText, num, qs } from "../http";

const API = "https://quotes.sina.cn/cn/api/jsonp_v2.php/=/CN_MarketDataService.getKLineData";
const REFERER = "https://finance.sina.com.cn/";

type Bar = { day: string; open: string; close: string; volume: string; amount?: string };

// 响应是 JSONP：一行脚本注释，然后 =([{...},{...}]);
export function parseSinaBars(text: string): Bar[] {
  const a = text.indexOf("=("), b = text.lastIndexOf(")");
  if (a < 0 || b < a) return [];
  const data: unknown = JSON.parse(text.slice(a + 2, b));
  return Array.isArray(data) ? (data as Bar[]) : [];
}

export function sinaDaily(bars: Bar[]): KlineRow[] {
  return bars.map((b) => {
    const open = num(b.open), close = num(b.close), volume = num(b.volume) / 100;   // 股 -> 手
    return { date: b.day.slice(0, 10), open, close, volume, amount: volume * 100 * (open + close) / 2 };
  });
}

/** 收盘 > 开盘的 5 分钟，成交额记为流入；收盘 < 开盘记为流出；平盘不计 */
export function aggregateFlow(bars: Bar[]): FlowRow[] {
  const days = new Map<string, FlowRow>();
  for (const b of bars) {
    const date = b.day.slice(0, 10);
    const open = num(b.open), close = num(b.close);
    let amount = num(b.amount);
    if (!Number.isFinite(amount)) amount = num(b.volume) * close;    // 无成交额时用 量×价 近似
    const row = days.get(date) ?? { date, inflow: 0, outflow: 0, net: 0 };
    if (close > open) row.inflow += amount;
    else if (close < open) row.outflow += amount;
    row.net = row.inflow - row.outflow;
    days.set(date, row);
  }
  return [...days.values()].sort((a, b) => a.date.localeCompare(b.date));
}

async function bars(code: string, scale: number, datalen: number): Promise<Bar[]> {
  const symbol = marketOf(code) + code;
  return parseSinaBars(await getText(`${API}?${qs({ symbol, scale, ma: "no", datalen })}`, REFERER));
}

export async function fetchSinaKline(code: string, start: string, end: string): Promise<KlineRow[]> {
  return sinaDaily(await bars(code, 240, 1970)).filter((r) => r.date >= start && r.date <= end);
}

/** 新浪一次最多给约 40 个交易日的 5 分钟线 */
export async function fetchFlowEstimate(code: string): Promise<FlowRow[]> {
  return aggregateFlow(await bars(code, 5, 1970));
}
