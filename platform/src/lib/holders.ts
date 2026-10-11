// 十大股东：相同股东、ETF 穿透汇总（对应 top10_holders.py）
import type { HolderRow } from "../types";

export interface StockHolders { code: string; name: string; rows: HolderRow[] }

export interface CommonHolder { name: string; count: number; detail: string }

/** 出现在 >= 2 只股票里的股东 */
export function commonHolders(items: StockHolders[]): CommonHolder[] {
  const byHolder = new Map<string, { stocks: Set<string>; parts: string[] }>();
  for (const it of items) {
    const label = `${it.code} ${it.name}`.trim();
    for (const r of it.rows) {
      const key = r.name.trim();
      const g = byHolder.get(key) ?? { stocks: new Set(), parts: [] };
      g.stocks.add(label);
      g.parts.push(`${label} 第${r.rank}名 ${r.ratio == null ? "-" : r.ratio.toFixed(2) + "%"}`);
      byHolder.set(key, g);
    }
  }
  return [...byHolder.entries()]
    .filter(([, g]) => g.stocks.size >= 2)
    .map(([name, g]) => ({ name, count: g.stocks.size, detail: g.parts.join("；") }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, "zh"));
}

/** ETF 成份股的一行股东明细 */
export interface LookThroughRow extends HolderRow {
  stockCode: string;
  stockName: string;
  weight: number;      // 成份股占 ETF 净值比例 %
  period: string;
  source: string;
}

export interface LookThroughSummary {
  name: string;
  count: number;        // 出现在多少只成份股里
  coverWeight: number;  // 这些成份股的权重合计 %
  through: number;      // 按 ETF 权重折算的间接持有比例 %
  avgRatio: number;     // 平均持股比例 %
  stocks: string;       // 涉及成份股（最多列 6 只）
}

/** 穿透汇总：同一股东出现在多少只成份股里，以及按 ETF 权重折算的间接持有比例 */
export function summarizeLookThrough(detail: LookThroughRow[], top = 30): LookThroughSummary[] {
  const groups = new Map<string, LookThroughRow[]>();
  for (const r of detail) {
    const g = groups.get(r.name);
    if (g) g.push(r); else groups.set(r.name, [r]);
  }
  return [...groups.entries()].map(([name, rows]) => {
    const ratios = rows.map((r) => r.ratio).filter((v): v is number => v != null);
    const names = rows.map((r) => r.stockName);
    return {
      name,
      count: new Set(rows.map((r) => r.stockCode)).size,
      coverWeight: rows.reduce((s, r) => s + r.weight, 0),
      through: rows.reduce((s, r) => s + (r.weight * (r.ratio ?? 0)) / 100, 0),
      avgRatio: ratios.length ? ratios.reduce((a, b) => a + b, 0) / ratios.length : 0,
      stocks: names.slice(0, 6).join("、") + (names.length > 6 ? "…" : ""),
    };
  }).sort((a, b) => b.count - a.count || b.through - a.through).slice(0, top);
}
