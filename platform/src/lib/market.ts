// 代码 / 市场 / 报告期相关的小工具（前端和 Worker 共用）

export function parseCodes(text: string): string[] {
  return [...new Set(text.match(/\d{6}/g) ?? [])];
}

export function marketOf(code: string): "sh" | "sz" | "bj" {
  if (/^(4|8|92)/.test(code)) return "bj";
  if (/^[569]/.test(code)) return "sh";
  return "sz";
}

/** 沪市 5 开头、深市 1 开头为场内基金（ETF / LOF） */
export function isFund(code: string): boolean {
  return code[0] === "1" || code[0] === "5";
}

/** 只穿透 A 股成份股（跨境 ETF 里的港股 / 美股查不了十大股东） */
export function isAShare(code: string): boolean {
  return /^\d{6}$/.test(code) && "034689".includes(code[0]);
}

/** 最近 n 个已结束的季度末（从新到旧），格式 YYYY-MM-DD */
export function quarterEnds(today: Date, n = 6): string[] {
  const out: string[] = [];
  let y = today.getFullYear();
  let q = Math.floor(today.getMonth() / 3);     // 已结束的季度数
  while (out.length < n) {
    if (q === 0) { y -= 1; q = 4; }
    out.push(`${y}-${["03-31", "06-30", "09-30", "12-31"][q - 1]}`);
    q -= 1;
  }
  return out;
}

export function ymd(d: Date): string {
  const p = (v: number) => String(v).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 北京时间的"今天"（Worker 运行在 UTC） */
export function todayInChina(now = new Date()): Date {
  const t = new Date(now.getTime() + 8 * 3600_000);
  return new Date(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate());
}
