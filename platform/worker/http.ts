const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

/** 参数不合法（返回 400） */
export class BadRequest extends Error {}

/** 取上游文本，失败自动重试一次。数据源都是有界的小响应（最大几百 KB），直接整体读取 */
export async function getText(url: string, referer?: string, timeoutMs = 12_000): Promise<string> {
  const headers: Record<string, string> = { "User-Agent": UA };
  if (referer) headers.Referer = referer;
  let last: unknown;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) throw new Error(`${new URL(url).hostname} 返回 HTTP ${res.status}`);
      return await res.text();
    } catch (ex) {
      last = ex;
    }
  }
  throw last;
}

export function qs(params: Record<string, string | number>): string {
  return new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString();
}

/** 转数字；空值 / 非数字一律返回 NaN（注意 Number("") 是 0，所以要单独判空） */
export function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
  const text = String(v ?? "").replace(/[,%\s]/g, "");
  if (!text) return NaN;
  const n = Number(text);
  return Number.isFinite(n) ? n : NaN;
}
