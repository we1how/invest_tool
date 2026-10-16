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

// ---------------- 标的索引（快照文件 /data/universe.json） ----------------
export interface EtfInfo {
  cat?: string;                  // 类别（数据源原文）
  idx?: string;                  // 跟踪指数
  prov?: string;                 // 发行商
  aum?: string;                  // 规模，如 "22.39B"
  exp?: string;                  // 费率，如 "0.75%"
  home?: string;                 // 发行商产品页
  sec?: [string, number][];      // 行业分布 [行业, 权重%]
  top?: [string, string, number][];   // 前十大持仓 [代码, 名称, 权重%]
}

export interface UniverseItem {
  s: string;                     // 代码
  n: string;                     // 英文名
  cn?: string;                   // 中文名
  t: "S" | "E" | "C";            // 美股 / ETF / 仅合约（港股、韩股、大宗商品等）
  ind?: string;                  // 行业（中文大类）
  sub?: string;                  // 细分行业（中文）
  mc?: number;                   // 市值（美元）
  to?: number;                   // 快照时 24 小时成交额（美元）
  perp?: 1;                      // 有币安传统金融永续合约
  bs?: 1;                        // 有代币化现货（bStocks）
  opt?: 1;                       // 有币安股票期权
  lev?: number;                  // 杠杆 ETF 倍数，负数为反向（-1 = 1 倍做空）
  u?: string;                    // 杠杆 / 单股 ETF 跟踪的单只股票
  web?: string;                  // 公司官网
  ct?: string;                   // 仅合约标的的类别
  etf?: EtfInfo;
}

export interface UniverseFile {
  generatedAt: string;           // 快照时间（ISO）
  counts: Record<string, number>;
  items: UniverseItem[];
}
