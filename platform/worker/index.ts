// 薄代理：取数 -> 规整成紧凑 JSON -> 加缓存。所有计算在浏览器里做。
import { parseCodes, todayInChina, ymd } from "../src/lib/market";
import type { HealthItem, KlineResp } from "../src/types";
import { BadRequest } from "./http";
import { fetchEmKline, fetchFundHoldings, fetchHolders, fetchMainFlow } from "./sources/eastmoney";
import { fetchFlowEstimate, fetchSinaKline } from "./sources/sina";
import { fetchQuote, fetchTicks, fetchTxKline } from "./sources/tencent";

function code(q: URLSearchParams): string {
  const c = q.get("code") ?? "";
  if (!/^\d{6}$/.test(c)) throw new BadRequest("code 必须是 6 位数字代码");
  return c;
}

function date(q: URLSearchParams, key: string): string {
  const d = q.get(key) ?? "";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new BadRequest(`${key} 必须是 YYYY-MM-DD`);
  return d;
}

/** 日线：腾讯 -> 新浪 -> 东方财富，自动降级 */
async function kline(c: string, start: string, end: string): Promise<KlineResp> {
  const errors: string[] = [];
  const sources: [string, () => Promise<KlineResp>][] = [
    ["腾讯", async () => {
      const r = await fetchTxKline(c, start, end);
      return { source: "腾讯", amountEstimated: r.estimated, rows: r.rows };
    }],
    ["新浪", async () => ({ source: "新浪", amountEstimated: true, rows: await fetchSinaKline(c, start, end) })],
    ["东方财富", async () => ({ source: "东方财富", amountEstimated: false, rows: await fetchEmKline(c, start, end) })],
  ];
  for (const [name, fn] of sources) {
    try {
      const out = await fn();
      if (out.rows.length) return out;
      errors.push(`${name}: 返回空数据`);
    } catch (ex) {
      errors.push(`${name}: ${message(ex)}`);
    }
  }
  throw new Error(`所有数据源均失败（${errors.join("；")}）`);
}

async function health(): Promise<HealthItem[]> {
  const today = todayInChina();
  const start = ymd(new Date(today.getTime() - 20 * 86400_000)), end = ymd(today);
  const probes: [string, () => Promise<number>][] = [
    ["腾讯 行情名称", async () => Object.keys(await fetchQuote(["600977"])).length],
    ["腾讯 日线", async () => (await fetchTxKline("600977", start, end)).rows.length],
    ["腾讯 逐笔", async () => (await fetchTicks("600977", 0, 1)).ticks.length],
    ["新浪 日线", async () => (await fetchSinaKline("600977", start, end)).length],
    ["新浪 5分钟线", async () => (await fetchFlowEstimate("600977")).length],
    ["东方财富 十大股东", async () => (await fetchHolders("601799", false, today)).rows.length],
    ["东方财富 主力资金流", async () => (await fetchMainFlow("600977")).length],
    ["东方财富 日线", async () => (await fetchEmKline("600977", start, end)).length],
    ["天天基金 持仓", async () => (await fetchFundHoldings("159559", today)).rows.length],
  ];
  return Promise.all(probes.map(async ([name, fn]): Promise<HealthItem> => {
    const t0 = Date.now();
    try {
      const n = await fn();
      return { name, ok: n > 0, ms: Date.now() - t0, detail: `${n} 条` };
    } catch (ex) {
      return { name, ok: false, ms: Date.now() - t0, detail: message(ex) };
    }
  }));
}

type Route = { ttl: number; run: (q: URLSearchParams) => Promise<unknown> };

const routes: Record<string, Route> = {
  "/api/quote": { ttl: 60, run: async (q) => {
    const codes = parseCodes(q.get("codes") ?? "");
    if (!codes.length || codes.length > 60) throw new BadRequest("codes 需要 1~60 个 6 位代码");
    return fetchQuote(codes);
  } },
  "/api/kline": { ttl: 300, run: (q) => kline(code(q), date(q, "start"), date(q, "end")) },
  "/api/min5": { ttl: 120, run: (q) => fetchFlowEstimate(code(q)) },
  "/api/fflow": { ttl: 300, run: (q) => fetchMainFlow(code(q)) },
  "/api/ticks": { ttl: 60, run: (q) => {
    const page = Number(q.get("page") ?? 0), count = Number(q.get("count") ?? 20);
    if (!Number.isInteger(page) || page < 0 || !Number.isInteger(count) || count < 1 || count > 20) {
      throw new BadRequest("page 需 >= 0，count 需在 1~20 之间");
    }
    return fetchTicks(code(q), page, count);
  } },
  "/api/holders": { ttl: 21600, run: (q) => fetchHolders(code(q), q.get("float") === "1", todayInChina()) },
  "/api/fund-holdings": { ttl: 21600, run: (q) => fetchFundHoldings(code(q), todayInChina()) },
  "/api/health": { ttl: 0, run: () => health() },
};

const message = (ex: unknown) => (ex instanceof Error ? ex.message : String(ex));

function json(body: unknown, status: number, ttl: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": status === 200 && ttl > 0 ? `public, max-age=${ttl}` : "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}

export default {
  async fetch(request, _env, ctx): Promise<Response> {
    const url = new URL(request.url);
    const route = routes[url.pathname];
    if (!route) return json({ error: "接口不存在" }, 404, 0);
    if (request.method !== "GET") return json({ error: "只支持 GET" }, 405, 0);

    // 边缘缓存（绑定自定义域名后生效；workers.dev 上只有浏览器缓存起作用）
    const cache = caches.default;
    if (route.ttl > 0) {
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    try {
      const res = json(await route.run(url.searchParams), 200, route.ttl);
      if (route.ttl > 0) ctx.waitUntil(cache.put(request, res.clone()));
      return res;
    } catch (ex) {
      const bad = ex instanceof BadRequest;
      if (!bad) console.error(JSON.stringify({ path: url.pathname, query: url.search, error: message(ex) }));
      return json({ error: message(ex) }, bad ? 400 : 502, 0);
    }
  },
} satisfies ExportedHandler<Env>;
