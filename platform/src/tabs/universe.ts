// 标的索引：币安传统金融板块的全部标的（美股、ETF、仅合约），用来"事件反查"和建立大概印象
import { errorText } from "../api";
import {
  filterItems, fmtUsd, levLabel, researchLinks, SECTOR_CN, type Query,
} from "../lib/universe";
import type { UniverseFile, UniverseItem } from "../types";
import { checkbox, el, field, fmt2, input, setQuery } from "../ui";

const PAGE = 100;
const TYPE_CN = { S: "美股", E: "ETF", C: "仅合约" } as const;

export function mountUniverse(root: HTMLElement, q: URLSearchParams | null): void {
  const search = input("text", q?.get("q") ?? "", { placeholder: "代码 / 中英文名 / 简介关键词，如 铀、核电、量子、无人机", enterkeyhint: "search" });
  const type = el("select", {},
    el("option", { value: "" }, "全部"), el("option", { value: "S" }, "美股"),
    el("option", { value: "E" }, "ETF"), el("option", { value: "C" }, "仅合约（港股 / 韩股 / 商品等）"));
  const ind = el("select", {}, el("option", { value: "" }, "全部"));
  const lev = el("select", {},
    el("option", { value: "" }, "全部"), el("option", { value: "only" }, "只看杠杆 / 反向"),
    el("option", { value: "none" }, "排除杠杆 / 反向"), el("option", { value: "long" }, "只看杠杆做多"),
    el("option", { value: "short" }, "只看做空 / 反向"));
  const sort = el("select", {},
    el("option", { value: "mc" }, "市值"), el("option", { value: "to" }, "成交额（24h）"), el("option", { value: "s" }, "代码"));
  const perp = checkbox("有合约", q?.get("perp") === "1");
  const bs = checkbox("有代币化现货", q?.get("bs") === "1");
  for (const [sel, key] of [[type, "type"], [lev, "lev"], [sort, "sort"]] as const) {
    const v = q?.get(key);
    if (v && [...sel.options].some((o) => o.value === v)) sel.value = v;
  }

  const form = el("form", { class: "card" },
    field("搜索", search, "grow"), field("类型", type), field("行业 / 类别", ind), field("杠杆", lev),
    perp.wrap, bs.wrap, field("排序", sort));
  const status = el("div", { class: "status" }, "正在加载数据…");
  const list = el("div");
  root.append(form, status, list);

  let data: UniverseFile | null = null;
  let intro: Record<string, string> = {};
  let bySymbol = new Map<string, UniverseItem>();
  let related = new Map<string, { lev: UniverseItem[]; holders: [UniverseItem, number][] }>();
  let shown = PAGE;
  let introLoaded = false;

  const query = (): Query => ({
    q: search.value, type: type.value as Query["type"], ind: ind.value, lev: lev.value as Query["lev"],
    perp: perp.box.checked, bs: bs.box.checked, sort: sort.value as Query["sort"],
  });

  function render(): void {
    if (!data) return;
    const qv = query();
    setQuery("universe", Object.fromEntries(Object.entries({
      q: qv.q.trim(), type: qv.type, ind: qv.ind, lev: qv.lev, perp: qv.perp ? "1" : "", bs: qv.bs ? "1" : "",
      sort: qv.sort === "mc" ? "" : qv.sort,
    }).filter(([, v]) => v)));
    const results = filterItems(data.items, qv, intro);
    const when = new Date(data.generatedAt).toLocaleString("zh-CN", { hour12: false });
    status.textContent = `共 ${results.length.toLocaleString()} 个结果｜数据快照：${when}`
      + (qv.q.trim() && !introLoaded ? "｜简介还在加载，按关键词搜到的结果稍后会补全" : "");
    const head = el("tr", {}, el("th", {}, "代码"), el("th", {}, "名称"), el("th", {}, "类型 / 行业"),
      el("th", { class: "num hide-sm" }, "市值"), el("th", { class: "num hide-sm" }, "成交额(24h)"), el("th", { class: "hide-sm" }, "标记"));
    const body = el("tbody");
    for (const it of results.slice(0, shown)) body.append(...row(it));
    const table = el("div", { class: "tbl" }, el("table", { class: "uni" }, el("thead", {}, head), body));
    const more = results.length > shown
      ? el("button", { class: "link more", type: "button" }, `显示更多（还有 ${(results.length - shown).toLocaleString()} 个）`)
      : null;
    more?.addEventListener("click", () => { shown += PAGE; render(); });
    const empty = el("div", { class: "card" }, "没有符合条件的标的。",
      qv.q.trim() ? el("p", { class: "sub" }, "关键词是在中文简介里找的，简介用词比较书面，可以换个说法试试（比如“光模块”换成“光通信”，“减肥药”换成“肥胖”）。") : null);
    list.replaceChildren(results.length ? table : empty, more ?? "");
  }

  function tags(it: UniverseItem): HTMLElement {
    const box = el("span", { class: "tags" });
    if (it.lev) box.append(el("span", { class: it.lev > 0 ? "tag up" : "tag down" }, levLabel(it.lev)));
    if (it.u) box.append(el("span", { class: "tag" }, `跟踪 ${it.u}`));
    if (it.perp) box.append(el("span", { class: "tag" }, "合约"));
    if (it.bs) box.append(el("span", { class: "tag" }, "现货"));
    if (it.opt) box.append(el("span", { class: "tag" }, "期权"));
    return box;
  }

  function row(it: UniverseItem): HTMLElement[] {
    const name = el("td", { class: "wrap" }, el("div", {}, it.cn ?? it.n), it.cn ? el("div", { class: "sub" }, it.n) : null,
      el("div", { class: "show-sm" }, tags(it)));          // 手机上标记放在名称下面
    const kind = it.t === "C" ? it.ct ?? "合约" : [TYPE_CN[it.t], it.ind].filter(Boolean).join(" · ");
    const tr = el("tr", { class: "clickable" },
      el("td", {}, el("b", {}, it.s)), name, el("td", {}, kind),
      el("td", { class: "num hide-sm" }, it.t === "C" ? "-" : fmtUsd(it.mc)),
      el("td", { class: "num hide-sm" }, fmtUsd(it.to)), el("td", { class: "hide-sm" }, tags(it)));
    const detail = el("tr", { class: "detail", hidden: "" }, el("td", { colspan: "6" }));
    tr.addEventListener("click", () => {
      if (detail.hidden) detail.firstElementChild!.replaceChildren(details(it));
      detail.hidden = !detail.hidden;
      tr.classList.toggle("open", !detail.hidden);
    });
    return [tr, detail];
  }

  /** 点代码跳到该标的 */
  function jump(sym: string, label?: string): HTMLElement {
    const a = el("button", { class: "chip", type: "button" }, label ?? sym);
    a.addEventListener("click", (ev) => {
      ev.stopPropagation();
      search.value = sym; type.value = ""; ind.value = ""; lev.value = ""; perp.box.checked = false; bs.box.checked = false;
      shown = PAGE; render();
      window.scrollTo({ top: root.offsetTop - 10, behavior: "smooth" });
    });
    return a;
  }

  function details(it: UniverseItem): HTMLElement {
    const box = el("div", { class: "detail-box" });
    const facts: string[] = [];
    if (it.sub) facts.push(`细分行业：${it.sub}`);
    if (it.t === "S" && it.mc) facts.push(`市值 ${fmtUsd(it.mc)}`);
    if (it.to) facts.push(`快照时 24h 成交额 ${fmtUsd(it.to)}`);
    if (facts.length) box.append(el("p", { class: "sub" }, facts.join("｜")));

    if (it.t === "S") {
      box.append(el("p", {}, intro[it.s] ?? (introLoaded ? "暂无中文简介（数据源没有收录）。" : "简介加载中…")));
      const rel = related.get(it.s);
      if (rel?.lev.length) {
        box.append(el("p", { class: "label" }, "跟踪它的 ETF（杠杆 / 反向 / 单股）"),
          el("div", { class: "chips" }, ...rel.lev.map((e) => jump(e.s, `${e.s}${e.lev ? " " + levLabel(e.lev) : ""}`))));
      }
      if (rel?.holders.length) {
        box.append(el("p", { class: "label" }, "重仓它的 ETF（只统计成交额前 500 只 ETF 的前十大持仓）"),
          el("div", { class: "chips" }, ...rel.holders.slice(0, 15).map(([e, w]) => jump(e.s, `${e.s} ${fmt2(w)}%`)),
            rel.holders.length > 15 ? el("span", { class: "chip plain" }, `等共 ${rel.holders.length} 只`) : null));
      }
    } else if (it.t === "E") {
      const e = it.etf;
      const facts2 = [
        e?.cat && `类别：${e.cat}`, it.ind && `币安分类：${it.ind}`, e?.idx && `跟踪指数：${e.idx}`,
        e?.prov && `发行商：${e.prov}`, e?.aum && `规模：$${e.aum}`, e?.exp && `费率：${e.exp}`,
      ].filter(Boolean) as string[];
      if (facts2.length) box.append(el("p", {}, facts2.join("｜")));
      if (it.lev) {
        box.append(el("p", { class: "note" },
          `${levLabel(it.lev)}${it.u ? `（跟踪 ${it.u}）` : ""}：每日再平衡，持有超过一天收益会偏离"指数 × 倍数"，震荡行情里有损耗。`));
      }
      if (it.u) box.append(el("div", { class: "chips" }, jump(it.u, `查看 ${it.u}`)));
      // 杠杆 / 反向 ETF 的持仓基本是互换合约和现金，看了也没意义
      if (e?.sec?.length && !it.lev) {
        box.append(el("p", { class: "label" }, "行业分布"), el("div", { class: "bars" }, ...e.sec.map(([n, w]) =>
          el("div", { class: "bar" }, el("span", { class: "bar-name" }, SECTOR_CN[n] ?? n),
            el("span", { class: "bar-track" }, el("span", { class: "bar-fill", style: `width:${Math.min(100, w)}%` })),
            el("span", { class: "bar-val" }, `${fmt2(w)}%`)))));
      }
      if (e?.top?.length && !it.lev) {
        box.append(el("p", { class: "label" }, "前十大持仓"), el("div", { class: "chips" }, ...e.top.map(([s, n, w]) =>
          s && bySymbol.has(s) ? jump(s, `${s} ${fmt2(w)}%`) : el("span", { class: "chip plain" }, `${s || n} ${fmt2(w)}%`))));
      }
      if (!e) box.append(el("p", { class: "sub" }, "这只 ETF 不在成交额前 500 名，没有抓取持仓；可以点下面的 StockAnalysis 查看。"));
    } else {
      box.append(el("p", {}, `${it.ct ?? ""}合约，只在币安合约里交易，没有对应的美股或 ETF。`));
    }
    const links = researchLinks(it.s, it.t, { web: it.web, home: it.etf?.home, perp: !!it.perp, bs: !!it.bs });
    box.append(el("p", { class: "label" }, "深入了解"), el("div", { class: "chips" }, ...links.map((l) =>
      el("a", { class: "chip", href: l.url, target: "_blank", rel: "noopener noreferrer" }, l.label))));
    return box;
  }

  let timer = 0;
  const rerender = () => { shown = PAGE; render(); };
  search.addEventListener("input", () => { clearTimeout(timer); timer = window.setTimeout(rerender, 200); });
  for (const c of [type, ind, lev, sort, perp.box, bs.box]) c.addEventListener("change", rerender);
  form.addEventListener("submit", (ev) => { ev.preventDefault(); rerender(); });

  (async () => {
    try {
      const res = await fetch("/data/universe.json");
      if (!res.ok) throw new Error(`数据文件加载失败（HTTP ${res.status}）`);
      data = await res.json() as UniverseFile;
      bySymbol = new Map(data.items.map((it) => [it.s, it]));
      related = buildRelated(data.items, bySymbol);
      const counts = new Map<string, number>();
      for (const it of data.items) if (it.ind) counts.set(it.ind, (counts.get(it.ind) ?? 0) + 1);
      for (const [name, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) ind.append(el("option", { value: name }, `${name}（${n}）`));
      const saved = q?.get("ind");
      if (saved && counts.has(saved)) ind.value = saved;
      render();
      const r2 = await fetch("/data/intro.json");
      if (r2.ok) intro = await r2.json() as Record<string, string>;
      introLoaded = true;
      render();                                  // 简介到了之后，关键词搜索结果会更全
    } catch (ex) {
      status.textContent = "";
      list.replaceChildren(el("div", { class: "card error" }, errorText(ex)));
    }
  })();
}

/** 正股 -> 跟踪它的杠杆 / 单股 ETF，以及前十大持仓里有它的 ETF */
function buildRelated(items: UniverseItem[], bySymbol: Map<string, UniverseItem>) {
  const out = new Map<string, { lev: UniverseItem[]; holders: [UniverseItem, number][] }>();
  const get = (s: string) => {
    let r = out.get(s);
    if (!r) { r = { lev: [], holders: [] }; out.set(s, r); }
    return r;
  };
  for (const it of items) {
    if (it.t !== "E") continue;
    if (it.u && bySymbol.has(it.u)) get(it.u).lev.push(it);
    for (const [s, , w] of it.etf?.top ?? []) if (s && bySymbol.get(s)?.t === "S") get(s).holders.push([it, w]);
  }
  for (const r of out.values()) {
    r.lev.sort((a, b) => (b.to ?? 0) - (a.to ?? 0));
    r.holders.sort((a, b) => b[1] - a[1]);
  }
  return out;
}
