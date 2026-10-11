// 腾讯：证券简称、日线（含成交额）、逐笔成交
import { marketOf } from "../../src/lib/market";
import type { KlineRow, Tick, TicksResp } from "../../src/types";
import { getText, num, qs } from "../http";

/** v_sh600977="1~中国电影~600977~..." -> { "600977": "中国电影" } */
export function parseQuote(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text.matchAll(/v_(?:sh|sz|bj)(\d{6})="([^"]*)"/g)) {
    const name = m[2].split("~")[1];
    if (name) out[m[1]] = name;
  }
  return out;
}

export async function fetchQuote(codes: string[]): Promise<Record<string, string>> {
  const list = codes.map((c) => marketOf(c) + c).join(",");
  return parseQuote(await getText(`https://qt.gtimg.cn/utf8/q=${list}`));
}

/** 行：[日期, 开, 收, 高, 低, 成交量(手), {}, 换手率, 成交额(万元), ...] */
export function parseTxKline(text: string, symbol: string): { rows: KlineRow[]; estimated: boolean } {
  const body = JSON.parse(text.slice(text.indexOf("{"))) as {
    data?: Record<string, { day?: unknown[][]; qfqday?: unknown[][] }>;
  };
  const raw = body.data?.[symbol]?.day ?? body.data?.[symbol]?.qfqday ?? [];
  let estimated = false;
  const rows = raw.map((r) => {
    const open = num(r[1]), close = num(r[2]), volume = num(r[5]);
    let amount = num(r[8]) * 1e4;
    if (!Number.isFinite(amount) || amount <= 0) {       // 个别行没有成交额：用均价估算
      amount = volume * 100 * (open + close) / 2;
      estimated = true;
    }
    return { date: String(r[0]), open, close, volume, amount };
  });
  return { rows, estimated };
}

/** 接口每次返回"截止日之前最近 640 根"，所以按两年一段（约 486 根）分块取再拼接 */
export async function fetchTxKline(code: string, start: string, end: string) {
  const symbol = marketOf(code) + code;
  const y0 = Number(start.slice(0, 4)), y1 = Number(end.slice(0, 4));
  const chunks: Promise<{ rows: KlineRow[]; estimated: boolean }>[] = [];
  for (let y = y1; y >= y0; y -= 2) {
    const param = `${symbol},day,${y - 1}-01-01,${y}-12-31,640,`;
    chunks.push(
      getText(`https://proxy.finance.qq.com/ifzqgtimg/appstock/app/newfqkline/get?${qs({ param })}`)
        .then((t) => parseTxKline(t, symbol)),
    );
  }
  const parts = await Promise.all(chunks);
  const byDate = new Map<string, KlineRow>();
  for (const p of parts) for (const r of p.rows) byDate.set(r.date, r);
  const rows = [...byDate.values()]
    .filter((r) => r.date >= start && r.date <= end)
    .sort((a, b) => a.date.localeCompare(b.date));
  return { rows, estimated: parts.some((p) => p.estimated) };
}

/** v_detail_data_sh600977=[0,"0/09:25:02/13.39/0.02/1218/1630902/B|1/..."] */
export function parseTicks(text: string): Tick[] {
  const m = text.match(/"([^"]*)"/);
  if (!m || !m[1]) return [];
  return m[1].split("|").map((item): Tick => {
    const f = item.split("/");
    return [f[1], num(f[4]), f[6]];
  });
}

/** 最近一个交易日的逐笔成交，每页约 70 笔；一次取 count 页，由浏览器循环取完 */
export async function fetchTicks(code: string, page: number, count: number): Promise<TicksResp> {
  const symbol = marketOf(code) + code;
  const pages = await Promise.all(
    Array.from({ length: count }, (_, i) =>
      getText(`https://stock.gtimg.cn/data/index.php?${qs({ appn: "detail", action: "data", c: symbol, p: page + i })}`)
        .then(parseTicks)),
  );
  const ticks: Tick[] = [];
  let done = false;
  for (const p of pages) {
    if (!p.length) { done = true; break; }
    ticks.push(...p);
  }
  return { ticks, nextPage: done ? null : page + count };
}
