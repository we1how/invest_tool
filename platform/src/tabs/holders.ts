// 前十大股东：股票 -> 十大股东 + 十大流通股东；ETF -> 成份股 + 逐只穿透汇总（对应 top10_holders.py）
import { api, errorText, pool } from "../api";
import { barChart } from "../charts";
import { commonHolders, summarizeLookThrough, type LookThroughRow, type StockHolders } from "../lib/holders";
import { isAShare, isFund, parseCodes } from "../lib/market";
import type { FundHolding, FundHoldingsResp, HolderRow, HoldersResp } from "../types";
import { card, checkbox, downloadCsv, el, field, fmt2, fmtInt, input, runGuard, setQuery, table, type Column } from "../ui";

const KIND = (floating: boolean) => (floating ? "十大流通股东" : "十大股东");
const ETF_SHOW_HOLDINGS = 20;     // ETF 成份股表最多显示多少行
const ETF_SHOW_TABLES = 10;       // ETF 只展开权重前 N 只成份股的股东明细

const holderCols: Column<HolderRow>[] = [
  { label: "名次", get: (r) => r.rank, num: true, format: String },
  { label: "股东名称", get: (r) => r.name, wrap: true },
  { label: "性质", get: (r) => r.kind },
  { label: "持股数(股)", get: (r) => r.shares, num: true, format: fmtInt },
  { label: "持股比例(%)", get: (r) => r.ratio, num: true },
  { label: "较上期增减", get: (r) => r.change, num: true },
];

const CSV_HEADER = ["代码", "简称", "类别", "成份股代码", "成份股名称", "成份股权重(%)", "报告期", "数据源",
                    "名次", "股东名称", "性质", "持股数(股)", "持股比例(%)", "较上期增减"];
type CsvRow = (string | number | null)[];

interface Options { showFloat: boolean; etfFloat: boolean; etfMax: number | null }
interface Collected { stocks: Map<boolean, StockHolders[]>; csv: CsvRow[] }

export function mountHolders(root: HTMLElement, q: URLSearchParams | null): void {
  const codes = input("text", q?.get("codes") ?? "601799 002050 688017 000559 600580 688836",
    { placeholder: "股票或 ETF 的 6 位代码，空格或逗号分隔" });
  const showFloat = checkbox("同时显示十大流通股东", q ? q.get("float") !== "0" : true);
  const etfFloat = checkbox("ETF 成份股查流通股东", q?.get("etffloat") === "1");
  const etfMax = input("number", q?.get("max") ?? "50", { min: "1", placeholder: "全部" });
  const button = el("button", { class: "primary", type: "submit" }, "查询");
  const form = el("form", { class: "card" },
    field("股票 / ETF 代码（可多只）", codes, "grow"), showFloat.wrap, etfFloat.wrap,
    field("ETF 最多穿透几只（留空 = 全部）", etfMax), button);
  const status = el("div", { class: "status" });
  const output = el("div");
  root.append(form, status, output);

  const guard = runGuard();

  async function run(): Promise<void> {
    const alive = guard();
    const list = parseCodes(codes.value);
    output.replaceChildren();
    try {
      if (!list.length) throw new Error("没有识别到 6 位证券代码");
      if (list.length > 20) throw new Error("一次最多查询 20 个代码");
      const max = etfMax.value.trim() ? Number(etfMax.value) : null;
      if (max !== null && !(Number.isInteger(max) && max >= 1)) throw new Error("ETF 穿透数量需为正整数，或留空表示全部");
      const opts: Options = { showFloat: showFloat.box.checked, etfFloat: etfFloat.box.checked, etfMax: max };
      setQuery("holders", { codes: list.join(" "), float: opts.showFloat ? "1" : "0",
                            etffloat: opts.etfFloat ? "1" : "0", max: max === null ? "" : String(max) });

      button.disabled = true;
      status.textContent = "正在查询…";
      const names = await api<Record<string, string>>("quote", { codes: list.join(",") }).catch(() => ({} as Record<string, string>));
      if (!alive()) return;

      const common = el("div", { class: "card common" }, el("h3", {}, "相同股东"), el("p", { class: "sub" }, "全部查完后显示…"));
      const nav = el("div", { class: "anchors" });
      output.append(common, nav);
      const collected: Collected = { stocks: new Map([[false, []], [true, []]]), csv: [] };
      const sections = list.map((code) => {
        const name = names[code] ?? "";
        const section = el("section", { id: `c${code}` }, el("h2", {}, `${code} ${name}`.trim()));
        output.append(section);
        nav.append(el("a", { href: `#c${code}` }, `${code} ${name}`.trim()));
        return { code, name, section };
      });

      let done = 0;
      // 逐个代码按顺序收集结果，保证"相同股东"和 CSV 的顺序与输入一致
      const perCode = await pool(sections, 3, async (s) => {
        const local: Collected = { stocks: new Map([[false, []], [true, []]]), csv: [] };
        if (isFund(s.code)) await renderFund(s.section, s.code, s.name, opts, local, alive);
        else await renderStock(s.section, s.code, s.name, opts, local);
        if (alive()) status.textContent = `已完成 ${++done}/${list.length}…`;
        return local;
      });
      if (!alive()) return;
      for (const r of perCode) {
        if (r.status !== "fulfilled") continue;
        for (const f of [false, true]) collected.stocks.get(f)!.push(...r.value.stocks.get(f)!);
        collected.csv.push(...r.value.csv);
      }
      renderCommon(common, collected, opts);
      status.textContent = "";
      if (collected.csv.length) {
        const dl = el("button", { class: "link", type: "button" }, `下载全部结果 CSV（${collected.csv.length} 行）`);
        dl.addEventListener("click", () => downloadCsv("top10_holders.csv", CSV_HEADER, collected.csv));
        status.append(dl);
      }
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

const sumRatio = (rows: HolderRow[]) => rows.reduce((s, r) => s + (r.ratio ?? 0), 0);

async function renderStock(section: HTMLElement, code: string, name: string, opts: Options, out: Collected): Promise<void> {
  const kinds = opts.showFloat ? [false, true] : [false];
  const results = await Promise.allSettled(kinds.map((f) => api<HoldersResp>("holders", { code, float: f ? 1 : 0 })));
  for (const [i, floating] of kinds.entries()) {
    const kind = KIND(floating), res = results[i];
    if (res.status === "rejected") {
      section.append(el("p", { class: "note" }, `${kind} 查询失败：${errorText(res.reason)}`));
      continue;
    }
    const { rows, period, source } = res.value;
    const chart = el("div", { class: "chart" });
    section.append(card(`${kind}｜报告期 ${period}｜数据源：${source}｜前十合计 ${sumRatio(rows).toFixed(2)}%`,
      table(holderCols, rows), chart));
    await barChart(chart, rows.map((r) => r.name), rows.map((r) => r.ratio ?? 0));
    out.stocks.get(floating)!.push({ code, name, rows });
    for (const r of rows) {
      out.csv.push([code, name, kind, "", "", null, period, source, r.rank, r.name, r.kind, r.shares, r.ratio, r.change]);
    }
  }
}

async function renderFund(
  section: HTMLElement, code: string, name: string, opts: Options, out: Collected, alive: () => boolean,
): Promise<void> {
  const kind = KIND(opts.etfFloat);
  let hold: FundHoldingsResp;
  try {
    hold = await api<FundHoldingsResp>("fund-holdings", { code });
  } catch (ex) {
    section.append(el("p", { class: "note" }, `成份股查询失败：${errorText(ex)}`));
    return;
  }
  const totalWeight = hold.rows.reduce((s, r) => s + r.weight, 0);
  const holdCols: Column<FundHolding>[] = [
    { label: "股票代码", get: (r) => r.code }, { label: "股票名称", get: (r) => r.name },
    { label: "占净值比例(%)", get: (r) => r.weight, num: true },
    { label: "持股数(万股)", get: (r) => r.shares, num: true },
    { label: "持仓市值(万元)", get: (r) => r.value, num: true, format: fmtInt },
  ];
  section.append(card(
    `成份股｜${hold.period}｜共 ${hold.rows.length} 只｜合计占净值 ${totalWeight.toFixed(2)}%`,
    hold.isFull ? null : el("p", { class: "note" }, "只取到前十大重仓股：数据源（天天基金）近两年每一期都只给出前十大，所以穿透只覆盖这 10 只，不是完整成份股。"),
    table(holdCols, hold.rows.slice(0, ETF_SHOW_HOLDINGS)),
    hold.rows.length > ETF_SHOW_HOLDINGS ? el("p", { class: "sub" }, `仅显示权重前 ${ETF_SHOW_HOLDINGS} 只，共 ${hold.rows.length} 只。`) : null,
  ));

  const aShares = hold.rows.filter((r) => isAShare(r.code));
  const todo = opts.etfMax ? aShares.slice(0, opts.etfMax) : aShares;
  const progress = el("p", { class: "sub" }, `正在查询成份股${kind} 0/${todo.length}…`);
  section.append(progress);
  const results = await pool(todo, 4,
    (s) => api<HoldersResp>("holders", { code: s.code, float: opts.etfFloat ? 1 : 0 }),
    (done) => { if (alive()) progress.textContent = `正在查询成份股${kind} ${done}/${todo.length}…`; });

  const detail: LookThroughRow[] = [];
  const failed: string[] = [];
  results.forEach((res, i) => {
    const s = todo[i];
    if (res.status === "rejected") { failed.push(s.code); return; }
    for (const r of res.value.rows) {
      detail.push({ ...r, stockCode: s.code, stockName: s.name, weight: s.weight, period: res.value.period, source: res.value.source });
    }
  });
  const hints: string[] = [];
  const skipped = hold.rows.length - aShares.length;
  if (skipped) hints.push(`${skipped} 只非 A 股成份股已跳过`);
  if (todo.length < aShares.length) hints.push(`按设置只穿透权重前 ${todo.length} 只（共 ${aShares.length} 只 A 股成份股）`);
  if (failed.length) hints.push(`${failed.length} 只成份股查询失败：${failed.slice(0, 20).join("、")}`);
  progress.textContent = hints.join("；");
  progress.className = hints.length ? "note" : "sub";
  if (!detail.length) return;

  const summary = summarizeLookThrough(detail);
  const chart = el("div", { class: "chart" });
  const sumCols: Column<(typeof summary)[number]>[] = [
    { label: "股东名称", get: (r) => r.name, wrap: true },
    { label: "出现次数", get: (r) => r.count, num: true, format: String },
    { label: "覆盖权重(%)", get: (r) => r.coverWeight, num: true },
    { label: "穿透持有(%)", get: (r) => r.through, num: true },
    { label: "平均持股比例(%)", get: (r) => r.avgRatio, num: true },
    { label: "涉及成份股", get: (r) => r.stocks, wrap: true },
  ];
  const checked = new Set(detail.map((r) => r.stockCode)).size;
  section.append(card(`穿透汇总：出现次数最多的${kind}（已查 ${checked} 只成份股）`,
    el("p", { class: "sub" }, "穿透持有 = 成份股权重 × 该股东在成份股里的持股比例，再按股东加总。"),
    table(sumCols, summary)));
  const top = summary.slice(0, 15);
  section.append(card("穿透持有比例前 15", chart));
  await barChart(chart, top.map((r) => r.name), top.map((r) => r.through));

  const tables = el("div");
  for (const s of todo.slice(0, ETF_SHOW_TABLES)) {
    const rows = detail.filter((r) => r.stockCode === s.code);
    if (!rows.length) continue;
    tables.append(el("details", {},
      el("summary", {}, `${s.code} ${s.name}｜权重 ${fmt2(s.weight)}%｜报告期 ${rows[0].period}`),
      table(holderCols, rows)));
  }
  section.append(card(`权重前 ${ETF_SHOW_TABLES} 只成份股的${kind}明细（点击展开）`, tables));

  for (const r of detail) {
    out.csv.push([code, name, `ETF成份股${kind}`, r.stockCode, r.stockName, r.weight, r.period, r.source,
                  r.rank, r.name, r.kind, r.shares, r.ratio, r.change]);
  }
}

function renderCommon(box: HTMLElement, collected: Collected, opts: Options): void {
  box.replaceChildren(el("h3", {}, "相同股东（出现在 2 只及以上股票里）"));
  const kinds = opts.showFloat ? [false, true] : [false];
  const total = collected.stocks.get(false)!.length;
  if (total < 2) {
    box.append(el("p", { class: "sub" }, "需要至少 2 只普通股票才能比较（ETF 成份股不参与）。"));
    return;
  }
  box.append(el("p", { class: "sub" }, "“香港中央结算有限公司”是沪深港通名义持有人，汇总了众多港资投资者，并非单一股东。"));
  const cols: Column<ReturnType<typeof commonHolders>[number]>[] = [
    { label: "股东名称", get: (r) => r.name, wrap: true },
    { label: "出现股票数", get: (r) => r.count, num: true, format: String },
    { label: "各股持股情况（名次 / 比例）", get: (r) => r.detail, wrap: true },
  ];
  for (const floating of kinds) {
    const rows = commonHolders(collected.stocks.get(floating)!);
    box.append(el("p", {}, el("b", {}, KIND(floating))), rows.length ? table(cols, rows) : el("p", { class: "sub" }, "没有相同股东。"));
  }
}
