// 事件窗口：某事件日前 / 后各 N 个交易日的走势，多只股票 × 多个年份（对应 event_window.py）
import { api, errorText, pool } from "../api";
import { grid, PALETTE, plot } from "../charts";
import { EVENTS, meanCurve, resolveEvent, summarizeStats, windowAround, windowStats, type WindowPoint } from "../lib/event";
import { parseCodes, todayInChina, ymd } from "../lib/market";
import type { KlineResp } from "../types";
import { card, el, field, input, runGuard, setQuery, table, type Column } from "../ui";

const CUSTOM = "__custom__";

interface Series { code: string; name: string; source: string; wins: Map<number, WindowPoint[]> }

export function mountEvent(root: HTMLElement, q: URLSearchParams | null): void {
  const thisYear = todayInChina().getFullYear();
  const codes = input("text", q?.get("codes") ?? "001330 000802 600977", { placeholder: "6 位代码，空格或逗号分隔" });
  const from = input("number", q?.get("from") ?? "2020", { min: "2005", max: String(thisYear) });
  const to = input("number", q?.get("to") ?? "2025", { min: "2005", max: String(thisYear) });
  const n = input("number", q?.get("n") ?? "20", { min: "1", max: "120" });
  const event = el("select", {},
    ...Object.entries(EVENTS).map(([name, def]) =>
      el("option", { value: name }, `${name}（${typeof def === "string" ? def : "农历初一"}）`)),
    el("option", { value: CUSTOM }, "自定义日期…"));
  const custom = input("text", q?.get("custom") ?? "", { placeholder: "MM-DD，或逐年填 2020-07-15 2021-07-12" });
  const customField = field("自定义事件日", custom, "grow");
  const saved = q?.get("event");
  if (saved && (saved === CUSTOM || saved in EVENTS)) event.value = saved;
  const syncCustom = () => { customField.hidden = event.value !== CUSTOM; };
  event.addEventListener("change", syncCustom);
  syncCustom();

  const button = el("button", { class: "primary", type: "submit" }, "对比");
  const form = el("form", { class: "card" },
    field("股票代码（可多只）", codes, "grow"), field("起始年份", from), field("结束年份", to),
    field("事件", event), customField, field("前后各 N 个交易日", n), button);
  const status = el("div", { class: "status" });
  const output = el("div");
  root.append(form, status, output);

  const guard = runGuard();

  async function run(): Promise<void> {
    const alive = guard();
    const list = parseCodes(codes.value);
    const y0 = Number(from.value), y1 = Number(to.value), N = Number(n.value);
    const spec = event.value === CUSTOM ? custom.value : event.value;
    const label = event.value === CUSTOM ? `自定义（${custom.value.trim()}）` : event.value;
    output.replaceChildren();
    try {
      if (!list.length) throw new Error("没有识别到 6 位证券代码");
      if (list.length > 8) throw new Error("一次最多对比 8 只股票");
      if (!(y0 >= 2005 && y1 <= thisYear && y0 <= y1)) throw new Error(`年份需在 2005 ~ ${thisYear} 之间，且起始不晚于结束`);
      if (!(Number.isInteger(N) && N >= 1 && N <= 120)) throw new Error("N 需在 1 ~ 120 之间");
      const resolve = resolveEvent(spec);
      const years = Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i);
      setQuery("event", { codes: list.join(" "), from: String(y0), to: String(y1), event: event.value,
                          ...(event.value === CUSTOM ? { custom: custom.value.trim() } : {}), n: String(N) });

      button.disabled = true;
      status.textContent = "正在获取行情…";
      const names = await api<Record<string, string>>("quote", { codes: list.join(",") }).catch(() => ({} as Record<string, string>));
      const today = ymd(todayInChina());
      const end = `${y1 + 1}-12-31` < today ? `${y1 + 1}-12-31` : today;
      const results = await pool(list, 3,
        (code) => api<KlineResp>("kline", { code, start: `${y0 - 1}-01-01`, end }),
        (done) => { if (alive()) status.textContent = `正在获取行情 ${done}/${list.length}…`; });
      if (!alive()) return;

      const notes: string[] = [];
      const series: Series[] = [];
      results.forEach((res, i) => {
        const code = list[i], name = names[code] ?? "";
        if (res.status === "rejected") { notes.push(`${code} ${name}：数据获取失败（${errorText(res.reason)}）`); return; }
        const wins = new Map<number, WindowPoint[]>();
        const skipped: number[] = [];
        for (const y of years) {
          const e = resolve(y);
          const win = e ? windowAround(res.value.rows, e, N) : null;
          if (win) wins.set(y, win); else skipped.push(y);
        }
        if (skipped.length) {
          notes.push(`${code} ${name}：${skipped.join("、")} 年事件日前后数据不足（未上市 / 停牌 / 尚未到来 / 未指定日期），已跳过`);
        }
        if (wins.size) series.push({ code, name, source: res.value.source, wins });
      });
      if (!series.length) throw new Error(["没有任何可用数据", ...notes].join("；"));
      status.textContent = "";
      await render(output, series, years, N, label, notes);
    } catch (ex) {
      if (!alive()) return;
      status.textContent = "";
      output.replaceChildren(el("div", { class: "card error" }, errorText(ex)));
    } finally {
      if (alive()) button.disabled = false;
    }
  }

  form.addEventListener("submit", (ev) => { ev.preventDefault(); void run(); });
  if (q?.get("codes")) void run();
}

async function render(
  output: HTMLElement, series: Series[], allYears: number[], N: number, label: string, notes: string[],
): Promise<void> {
  const years = allYears.filter((y) => series.some((s) => s.wins.has(y)));
  const title = (s: Series) => `${s.code} ${s.name}`.trim();
  const sources = [...new Set(series.map((s) => s.source))].join(" / ");

  const byYear = el("div", { class: "chart" }), byStock = el("div", { class: "chart" });
  output.append(
    el("p", {}, `${series.map(title).join("、")}｜${years[0]}–${years[years.length - 1]}｜${label} 前后各 ${N} 个交易日`),
    el("p", { class: "sub" }, `未复权收盘价，以事件日前最后一个交易日收盘 = 100；横轴为相对事件日的交易日，浅蓝区域是事件日之后。数据源：${sources}`),
    ...notes.map((t) => el("p", { class: "note" }, t)),
    card("按年份对比（同一年里几只股票的差异）", byYear),
    card("按股票对比（多个年份叠加，黑色虚线 = 各年平均）", byStock),
  );
  const narrow = output.clientWidth < 760;
  const xExtra = { dtick: N <= 30 ? 5 : 10 };
  const hover = "%{y:.2f}（%{customdata}）";

  // 图 1：每个年份一张子图
  const g1 = grid(years.length, narrow ? 1 : Math.min(3, years.length), years.map((y) => `${y} 年`), 250, xExtra, narrow);
  const t1: Record<string, unknown>[] = [];
  const shown = new Set<string>();
  years.forEach((y, i) => {
    series.forEach((s, k) => {
      const win = s.wins.get(y);
      if (!win) return;
      t1.push({
        type: "scatter", mode: "lines", name: title(s), legendgroup: s.code, legendrank: k + 1, showlegend: !shown.has(s.code),
        x: win.map((p) => p.rel), y: win.map((p) => p.idx), customdata: win.map((p) => p.date),
        line: { color: PALETTE[k % PALETTE.length], width: 2 }, hovertemplate: hover, ...g1.axes(i),
      });
      shown.add(s.code);
    });
    g1.vrect(i, 0, N + 0.5); g1.hline(i, 100); g1.vline(i, 0);
  });
  await plot(byYear, t1, g1.layout);

  // 图 2：每只股票一张子图
  const g2 = grid(series.length, narrow ? 1 : Math.min(3, series.length), series.map(title), 290, xExtra, narrow);
  const t2: Record<string, unknown>[] = [];
  series.forEach((s, i) => {
    const entries = [...s.wins.entries()].sort((a, b) => a[0] - b[0]);
    for (const [y, win] of entries) {
      t2.push({
        type: "scatter", mode: "lines", name: String(y), legendgroup: String(y), legendrank: y, showlegend: i === 0 || !series.slice(0, i).some((p) => p.wins.has(y)),
        x: win.map((p) => p.rel), y: win.map((p) => p.idx), customdata: win.map((p) => p.date), opacity: 0.85,
        line: { color: PALETTE[allYears.indexOf(y) % PALETTE.length], width: 1.6 }, hovertemplate: hover, ...g2.axes(i),
      });
    }
    const mean = meanCurve(entries.map(([, w]) => w));
    t2.push({
      type: "scatter", mode: "lines", name: "平均", legendgroup: "avg", legendrank: 9999, showlegend: i === 0,
      x: mean.map((p) => p.rel), y: mean.map((p) => p.idx),
      line: { color: "#111", width: 3, dash: "dash" }, hovertemplate: "%{y:.2f}", ...g2.axes(i),
    });
    g2.vrect(i, 0, N + 0.5); g2.hline(i, 100); g2.vline(i, 0);
  });
  await plot(byStock, t2, g2.layout);

  // 表：汇总 + 各年明细
  type Detail = { code: string; name: string; year: number; date: string; pre: number; post: number; high: number; low: number };
  const detail: Detail[] = [];
  const summary = series.map((s) => {
    const stats = [...s.wins.entries()].sort((a, b) => a[0] - b[0]).map(([year, win]) => {
      const st = windowStats(win);
      detail.push({ code: s.code, name: s.name, year, date: win[N].date, ...st });
      return st;
    });
    return { code: s.code, name: s.name, ...summarizeStats(stats) };
  });
  const pct = { num: true, signed: true } as const;
  const sumCols: Column<(typeof summary)[number]>[] = [
    { label: "代码", get: (r) => r.code }, { label: "简称", get: (r) => r.name },
    { label: "样本年数", get: (r) => r.years, num: true, format: String },
    { label: `事件前${N}日涨跌均值(%)`, get: (r) => r.preMean, ...pct },
    { label: `事件后${N}日涨跌均值(%)`, get: (r) => r.postMean, ...pct },
    { label: "事件前上涨概率(%)", get: (r) => r.preUp, num: true, format: (v) => v.toFixed(0) },
    { label: "事件后上涨概率(%)", get: (r) => r.postUp, num: true, format: (v) => v.toFixed(0) },
  ];
  const detCols: Column<Detail>[] = [
    { label: "代码", get: (r) => r.code }, { label: "简称", get: (r) => r.name },
    { label: "年份", get: (r) => r.year, num: true, format: String },
    { label: "事件后首个交易日", get: (r) => r.date },
    { label: `事件前${N}日涨跌(%)`, get: (r) => r.pre, ...pct },
    { label: `事件后${N}日涨跌(%)`, get: (r) => r.post, ...pct },
    { label: "事件后最高(%)", get: (r) => r.high, ...pct },
    { label: "事件后最低(%)", get: (r) => r.low, ...pct },
  ];
  output.append(
    card("汇总（均值与上涨概率）", table(sumCols, summary),
      el("p", { class: "note" }, "样本年数很少，均值和上涨概率只能作为观察线索，不能当作规律。")),
    card("各年明细", table(detCols, detail)),
  );
}
