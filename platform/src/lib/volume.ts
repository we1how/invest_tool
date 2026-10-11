// 资金量价：均线、环比变化率、累计主动买卖（对应 stock_volume.py）
import type { KlineRow, Tick } from "../types";

export interface DailyRow extends KlineRow {
  amountMa5: number | null;
  volumeMa5: number | null;
  amountPct: number | null;   // 日环比 %
  volumePct: number | null;
}

/** 先在全量数据上算 5 日均线和环比，再截取 start 之后的部分（保证窗口第一天也有值） */
export function enrichDaily(rows: KlineRow[], start: string): DailyRow[] {
  const ma = (i: number, key: "amount" | "volume") =>
    i < 4 ? null : rows.slice(i - 4, i + 1).reduce((s, r) => s + r[key], 0) / 5;
  const pct = (i: number, key: "amount" | "volume") =>
    i < 1 || !rows[i - 1][key] ? null : (rows[i][key] / rows[i - 1][key] - 1) * 100;
  return rows
    .map((r, i) => ({
      ...r,
      amountMa5: ma(i, "amount"), volumeMa5: ma(i, "volume"),
      amountPct: pct(i, "amount"), volumePct: pct(i, "volume"),
    }))
    .filter((r) => r.date >= start);
}

export interface TickCurve { time: string[]; buy: number[]; sell: number[] }

/** 逐笔成交 -> 累计主动买入 / 卖出（手） */
export function cumulativeTicks(ticks: Tick[]): TickCurve {
  const sorted = [...ticks].sort((a, b) => a[0].localeCompare(b[0]));
  const out: TickCurve = { time: [], buy: [], sell: [] };
  let buy = 0, sell = 0;
  for (const [time, volume, side] of sorted) {
    if (side === "B") buy += volume;
    else if (side === "S") sell += volume;
    out.time.push(time); out.buy.push(buy); out.sell.push(sell);
  }
  return out;
}
