// 个股资金大小（成交额 / 成交量）与快慢（变化率）、流入流出估算、当日主动买卖（对应 stock_volume.py）
import { api, errorText } from "../api";
import { COLOR, grid, plot } from "../charts";
import { todayInChina, ymd } from "../lib/market";
import { cumulativeTicks, enrichDaily, type DailyRow, type TickCurve } from "../lib/volume";
import type { FlowRow, KlineResp, MainFlowRow, Tick, TicksResp } from "../types";
import { card, el, field, input, runGuard, setQuery, yi } from "../ui";

async function allTicks(code: string): Promise<Tick[]> {
  const ticks: Tick[] = [];
  let page: number | null = 0;
  for (let i = 0; i < 12 && page !== null; i++) {            // 每次 20 页，最多 240 页
    const res: TicksResp = await api<TicksResp>("ticks", { code, page, count: 20 });
    ticks.push(...res.ticks);
    page = res.nextPage;
  }
  return ticks;
}

export function mountVolume(root: HTMLElement, q: URLSearchParams | null): void {
  const code = input("text", q?.get("code") ?? "601799", { placeholder: "6 位股票代码", maxlength: "6" });
  const days = input("number", q?.get("days") ?? "30", { min: "7", max: "120" });
  const button = el("button", { class: "primary", type: "submit" }, "查询");
  const form = el("form", { class: "card" }, field("股票代码", code), field("回看自然日天数", days), button);
  const status = el("div", { class: "status" });
  const output = el("div");
  root.append(form, status, output);

  const guard = runGuard();

  async function run(): Promise<void> {
    const alive = guard();
    const c = code.value.trim(), d = Number(days.value);
    output.replaceChildren();
    try {
      if (!/^\d{6}$/.test(c)) throw new Error("请输入 6 位股票代码");
      if (!(Number.isInteger(d) && d >= 7 && d <= 120)) throw new Error("天数需在 7 ~ 120 之间");
      setQuery("volume", { code: c, days: String(d) });
      button.disabled = true;
      status.textContent = "正在获取数据…";

      const today = todayInChina();
      const start = ymd(new Date(today.getTime() - d * 86400_000));
      const early = ymd(new Date(today.getTime() - (d + 20) * 86400_000));   // 多取 20 天，保证第一天的均线 / 变化率有值
      const notes: string[] = [];
      const optional = <T>(p: Promise<T>, what: string): Promise<T | null> =>
        p.catch((ex) => { notes.push(`${what}获取失败（${errorText(ex)}），已跳过对应图表`); return null; });

      const [names, kline, flow, mainFlow, ticks] = await Promise.all([
        api<Record<string, string>>("quote", { codes: c }).catch(() => ({} as Record<string, string>)),
        api<KlineResp>("kline", { code: c, start: early, end: ymd(today) }),
        optional(api<FlowRow[]>("min5", { code: c }), "5 分钟 K 线"),
        optional(api<MainFlowRow[]>("fflow", { code: c }), "东方财富主力资金流"),
        optional(allTicks(c), "逐笔成交"),
      ]);
      if (!alive()) return;
      const daily = enrichDaily(kline.rows, start);
      if (!daily.length) throw new Error("这段时间没有交易数据");
      const est = flow?.filter((r) => r.date >= start) ?? [];
      const main = mainFlow?.filter((r) => r.date >= start) ?? [];
      const curve = ticks?.length ? cumulativeTicks(ticks) : null;
      status.textContent = "";
      await render(output, { code: c, name: names[c] ?? "", days: d, kline, daily, est, main, curve, notes });
    } catch (ex) {
      if (!alive()) return;
      status.textContent = "";
      output.replaceChildren(el("div", { class: "card error" }, errorText(ex)));
    } finally {
      if (alive()) button.disabled = false;
    }
  }

  form.addEventListener("submit", (ev) => { ev.preventDefault(); void run(); });
  if (q?.get("code")) void run();
}

interface View {
  code: string; name: string; days: number; kline: KlineResp; daily: DailyRow[];
  est: FlowRow[]; main: MainFlowRow[]; curve: TickCurve | null; notes: string[];
}

function summaryLines(v: View): string[] {
  const { daily, est, curve } = v;
  const md = (d: string) => d.slice(5);
  const signed = (n: number, digits: number) => (n >= 0 ? "+" : "") + n.toFixed(digits);
  const last = daily[daily.length - 1];
  const maxDay = daily.reduce((a, b) => (b.amount > a.amount ? b : a));
  const mean = daily.reduce((s, r) => s + r.amount, 0) / daily.length;
  const lines = [
    `区间 ${daily[0].date} ~ ${last.date}，共 ${daily.length} 个交易日`,
    `日均成交额 ${yi(mean)} 亿元；最大 ${yi(maxDay.amount)} 亿元（${md(maxDay.date)}）`,
  ];
  if (last.amountPct != null && last.amountMa5) {
    lines.push(`最新一日成交额 ${yi(last.amount)} 亿元，较前一日 ${signed(last.amountPct, 1)}%，为 5 日均值的 ${(last.amount / last.amountMa5).toFixed(2)} 倍`);
  }
  const withPct = daily.filter((r) => r.amountPct != null);
  if (withPct.length) {
    const fastest = withPct.reduce((a, b) => (Math.abs(b.amountPct!) > Math.abs(a.amountPct!) ? b : a));
    lines.push(`变化最快的一天：${md(fastest.date)}，成交额环比 ${signed(fastest.amountPct!, 1)}%`);
  }
  if (est.length) {
    const net = est.reduce((s, r) => s + r.net, 0);
    lines.push(`区间估算净流入合计 ${signed(net / 1e8, 2)} 亿元（${est.filter((r) => r.net > 0).length} 天净流入 / ${est.filter((r) => r.net < 0).length} 天净流出）`);
  }
  if (curve) {
    const buy = curve.buy[curve.buy.length - 1], sell = curve.sell[curve.sell.length - 1];
    const f = (n: number) => Math.round(n).toLocaleString("en-US");
    lines.push(`最近交易日 主动买入 ${f(buy)} 手 / 主动卖出 ${f(sell)} 手，差额 ${buy - sell >= 0 ? "+" : ""}${f(buy - sell)} 手`);
  }
  return lines;
}

async function render(output: HTMLElement, v: View): Promise<void> {
  const { daily, est, main, curve, kline } = v;
  const md = (d: string) => d.slice(5);
  const panels = ["amount", "volume", "speed"];
  const titles = [
    `资金大小：日成交额（亿元）${kline.amountEstimated ? "［均价估算］" : ""}`,
    "日成交量（万手）",
    "资金快慢：日环比变化率（%）｜线越陡、离 0 越远，变化越快",
  ];
  if (est.length) { panels.push("inout"); titles.push("每日流入 vs 流出（亿元，5 分钟 K 线估算）"); }
  if (est.length || main.length) { panels.push("net"); titles.push("每日净流入（亿元）"); }
  if (curve) { panels.push("ticks"); titles.push("最近交易日：主动买入 / 主动卖出 累计（手）｜斜率 = 买卖速度"); }

  const narrow = output.clientWidth < 760;
  const g = grid(panels.length, 1, titles, 210,
    { type: "category", tickangle: 0, nticks: narrow ? 6 : 16 }, narrow);
  const traces: Record<string, unknown>[] = [];
  const line = (panel: string, x: string[], y: (number | null)[], name: string, color: string,
                opt: { dash?: string; markers?: boolean } = {}) => {
    const markers = opt.markers ?? true;
    traces.push({
      type: "scatter", mode: markers ? "lines+markers" : "lines", name, x, y,
      line: { color, width: 2, dash: opt.dash }, marker: { size: 5, line: { width: 1, color: "white" } },
      hovertemplate: "%{y:,.2f}", ...g.axes(panels.indexOf(panel)),
    });
  };
  const x = daily.map((r) => md(r.date));
  const div = (k: number) => (n: number | null) => (n == null ? null : n / k);

  line("amount", x, daily.map((r) => r.amount / 1e8), "成交额", COLOR.blue);
  line("amount", x, daily.map((r) => r.amountMa5).map(div(1e8)), "成交额 5 日均", COLOR.orange, { dash: "dot", markers: false });
  line("volume", x, daily.map((r) => r.volume / 1e4), "成交量", COLOR.purple);
  line("volume", x, daily.map((r) => r.volumeMa5).map(div(1e4)), "成交量 5 日均", COLOR.orange, { dash: "dot", markers: false });
  line("speed", x, daily.map((r) => r.amountPct), "成交额变化率 %", COLOR.blue);
  line("speed", x, daily.map((r) => r.volumePct), "成交量变化率 %", COLOR.purple, { dash: "dash" });
  g.hline(panels.indexOf("speed"), 0, COLOR.grey);

  if (est.length) {
    const ex = est.map((r) => md(r.date));
    line("inout", ex, est.map((r) => r.inflow / 1e8), "流入额(估算)", COLOR.red);
    line("inout", ex, est.map((r) => r.outflow / 1e8), "流出额(估算)", COLOR.green);
    line("net", ex, est.map((r) => r.net / 1e8), "净流入(估算)", COLOR.blue);
  }
  if (main.length) {
    line("net", main.map((r) => md(r.date)), main.map((r) => r.mainNet / 1e8), "主力净流入(东方财富)", COLOR.red, { dash: "dash" });
  }
  if (panels.includes("net")) g.hline(panels.indexOf("net"), 0, COLOR.grey);
  if (curve) {
    const i = panels.indexOf("ticks");
    line("ticks", curve.time, curve.buy, "累计主动买入", COLOR.red, { markers: false });
    line("ticks", curve.time, curve.sell, "累计主动卖出", COLOR.green, { markers: false });
    line("ticks", curve.time, curve.buy.map((b, k) => b - curve.sell[k]), "买入 − 卖出", COLOR.blue, { dash: "dot", markers: false });
    g.hline(i, 0, COLOR.grey);
    g.xaxis(i).nticks = narrow ? 5 : 10;
  }

  const chart = el("div", { class: "chart" });
  output.append(
    el("p", {}, `${v.code} ${v.name}｜近 ${v.days} 天资金大小与快慢｜日线数据源：${kline.source}`),
    ...v.notes.map((t) => el("p", { class: "note" }, t)),
    card("摘要", ...summaryLines(v).map((t) => el("p", {}, t))),
    card(null, chart),
    el("p", { class: "sub" }, "流入 / 流出是用 5 分钟 K 线估算的：收盘高于开盘的 5 分钟成交额记为流入，低于记为流出，并非交易所口径的资金流向。"),
  );
  await plot(chart, traces, g.layout);
}
