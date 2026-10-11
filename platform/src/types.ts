// Worker 接口返回的数据结构（前后端共用）

export interface KlineRow {
  date: string;      // YYYY-MM-DD
  open: number;
  close: number;
  volume: number;    // 手
  amount: number;    // 元
}
export interface KlineResp {
  source: string;
  amountEstimated: boolean;   // 成交额是否为 量×均价 估算
  rows: KlineRow[];
}

export interface FlowRow { date: string; inflow: number; outflow: number; net: number }   // 元
export interface MainFlowRow { date: string; mainNet: number }                             // 元

/** 逐笔：[时间 HH:MM:SS, 成交量(手), B 买盘 / S 卖盘 / M 中性] */
export type Tick = [string, number, string];
export interface TicksResp { ticks: Tick[]; nextPage: number | null }

export interface HolderRow {
  rank: number;
  name: string;
  kind: string;            // 股东性质 / 股份类型
  shares: number | null;   // 股
  ratio: number | null;    // %
  change: string;          // 较上期增减
}
export interface HoldersResp { period: string; source: string; rows: HolderRow[] }

export interface FundHolding { code: string; name: string; weight: number; shares: number; value: number }
export interface FundHoldingsResp {
  period: string;      // 如 "2026年2季度"
  isFull: boolean;     // 是否为完整持仓（半年报 / 年报）
  rows: FundHolding[]; // 按占净值比例从高到低
}

export interface HealthItem { name: string; ok: boolean; ms: number; detail: string }
