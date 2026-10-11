// 事件窗口：事件日前 / 后各 N 个交易日的走势（对应 event_window.py）

/** 春节（农历正月初一）公历日期 */
export const SPRING_FESTIVAL: Record<number, string> = {
  2015: "02-19", 2016: "02-08", 2017: "01-28", 2018: "02-16", 2019: "02-05", 2020: "01-25",
  2021: "02-12", 2022: "02-01", 2023: "01-22", 2024: "02-10", 2025: "01-29", 2026: "02-17",
  2027: "02-06", 2028: "01-26", 2029: "02-13", 2030: "02-03",
};

/** 事件库：想加新事件，往这里加一行（名称 -> 每年的 "MM-DD"，或逐年不同的日期表）。
 *  事件日 = 窗口的分界点：前 N 个交易日是"事件前"，从事件日起的 N 个交易日是"事件后"。 */
export const EVENTS: Record<string, string | Record<number, string>> = {
  "春节": SPRING_FESTIVAL,                 // 农历初一
  "元旦": "01-01",
  "国庆节": "10-01",
  "年报/一季报截止": "04-30",              // 法定披露截止日，披露高峰在其前
  "半年报截止": "08-31",
  "三季报截止": "10-31",
  "暑假": "07-10",                         // 大致的放假开始日，可在页面上用自定义日期覆盖
  "寒假": "01-15",
};

export type EventResolver = (year: number) => string | null;

/** spec 可以是：事件库里的名称 | "MM-DD"（每年固定）| 若干个 "YYYY-MM-DD"（逐年指定） */
export function resolveEvent(spec: string): EventResolver {
  const text = spec.trim();
  const def = EVENTS[text];
  if (typeof def === "string") return (y) => `${y}-${def}`;
  if (def) return (y) => (def[y] ? `${y}-${def[y]}` : null);
  if (/^\d{1,2}-\d{1,2}$/.test(text)) {
    const [m, d] = text.split("-").map((v) => v.padStart(2, "0"));
    if (Number(m) < 1 || Number(m) > 12 || Number(d) < 1 || Number(d) > 31) throw new Error(`日期不合法：${text}`);
    return (y) => `${y}-${m}-${d}`;
  }
  const full = text.match(/\d{4}-\d{2}-\d{2}/g);
  if (full) {
    const byYear = new Map(full.map((d) => [Number(d.slice(0, 4)), d]));
    return (y) => byYear.get(y) ?? null;
  }
  throw new Error(`无法识别的事件：${text || "（空）"}。可填 MM-DD，或逐年填写 YYYY-MM-DD`);
}

export interface WindowPoint { rel: number; date: string; close: number; idx: number }

const dayDiff = (a: string, b: string) => (Date.parse(a) - Date.parse(b)) / 86400_000;

/** 事件日 e 之前最后 n 个交易日(-n..-1) + e 当天及之后前 n 个交易日(1..n)，
 *  以 -1（事件前最后一个交易日）收盘价为 100。数据不足 n 天返回 null。 */
export function windowAround(rows: { date: string; close: number }[], e: string, n: number): WindowPoint[] | null {
  const split = rows.findIndex((r) => r.date >= e);
  if (split < 0) return null;
  const pre = rows.slice(Math.max(0, split - n), split);
  const post = rows.slice(split, split + n);
  if (pre.length < n || post.length < n) return null;
  // 窗口必须真的贴着事件日，避免股票停牌 / 未上市时拿到很远的数据
  if (dayDiff(e, pre[n - 1].date) > 15 || dayDiff(post[0].date, e) > 15) return null;
  const base = pre[n - 1].close;
  return [...pre, ...post].map((r, i) => ({
    rel: i < n ? i - n : i - n + 1,
    date: r.date,
    close: r.close,
    idx: (r.close / base) * 100,
  }));
}

export interface WindowStats { pre: number; post: number; high: number; low: number }   // 都是 %

export function windowStats(win: WindowPoint[]): WindowStats {
  const pre = win.filter((p) => p.rel < 0), post = win.filter((p) => p.rel > 0);
  const base = pre[pre.length - 1].close;
  const closes = post.map((p) => p.close);
  return {
    pre: (base / pre[0].close - 1) * 100,
    post: (closes[closes.length - 1] / base - 1) * 100,
    high: (Math.max(...closes) / base - 1) * 100,
    low: (Math.min(...closes) / base - 1) * 100,
  };
}

export interface StatsSummary { years: number; preMean: number; postMean: number; preUp: number; postUp: number }

export function summarizeStats(list: WindowStats[]): StatsSummary {
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const up = (xs: number[]) => (xs.filter((x) => x > 0).length / xs.length) * 100;
  const pre = list.map((s) => s.pre), post = list.map((s) => s.post);
  return { years: list.length, preMean: mean(pre), postMean: mean(post), preUp: up(pre), postUp: up(post) };
}

/** 多个年份的窗口，按相对交易日求平均指数 */
export function meanCurve(wins: WindowPoint[][]): { rel: number; idx: number }[] {
  if (!wins.length) return [];
  return wins[0].map((p, i) => ({ rel: p.rel, idx: wins.reduce((s, w) => s + w[i].idx, 0) / wins.length }));
}
