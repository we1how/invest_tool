// 小型 DOM 工具：一律用 textContent 写入数据，避免把接口返回的内容当成 HTML

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, attrs: Record<string, string> = {}, ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v; else node.setAttribute(k, v);
  }
  for (const c of children) if (c) node.append(c);
  return node;
}

export const fmt2 = (v: number | null | undefined) => (v == null || !Number.isFinite(v) ? "-" : v.toFixed(2));
export const fmtInt = (v: number | null | undefined) =>
  v == null || !Number.isFinite(v) ? "-" : Math.round(v).toLocaleString("en-US");
export const yi = (v: number) => (v / 1e8).toFixed(2);     // 元 -> 亿元

export interface Column<T> {
  label: string;
  get: (row: T) => string | number | null | undefined;
  num?: boolean;        // 右对齐
  signed?: boolean;     // 按正负上色（红涨绿跌）
  wrap?: boolean;       // 长文本列：允许换行
  format?: (v: number) => string;
}

export function table<T>(columns: Column<T>[], rows: T[]): HTMLElement {
  const head = el("tr", {}, ...columns.map((c) => el("th", c.num ? { class: "num" } : {}, c.label)));
  const body = rows.map((r) => el("tr", {}, ...columns.map((c) => {
    const v = c.get(r);
    let text: string, cls = c.num ? "num" : c.wrap ? "wrap" : "";
    if (typeof v === "number") {
      text = Number.isFinite(v) ? (c.format ?? fmt2)(v) : "-";
      if (c.signed && Number.isFinite(v) && v !== 0) cls += v > 0 ? " up" : " down";
    } else {
      text = v == null || v === "" ? "-" : v;
    }
    return el("td", cls ? { class: cls.trim() } : {}, text);
  })));
  return el("div", { class: "tbl" }, el("table", {}, el("thead", {}, head), el("tbody", {}, ...body)));
}

export function card(title: string | null, ...children: Child[]): HTMLElement {
  return el("div", { class: "card" }, title ? el("h3", {}, title) : null, ...children);
}

export function field(label: string, control: HTMLElement, cls = ""): HTMLElement {
  return el("label", { class: `field ${cls}`.trim() }, label, control);
}

export function input(type: "text" | "number", value: string, attrs: Record<string, string> = {}): HTMLInputElement {
  const node = el("input", { type, ...attrs });
  node.value = value;
  return node;
}

export function checkbox(label: string, checked: boolean): { wrap: HTMLElement; box: HTMLInputElement } {
  const box = el("input", { type: "checkbox" });
  box.checked = checked;
  return { wrap: el("label", { class: "field check" }, box, label), box };
}

/** 把当前标签页的参数写进网址，刷新 / 分享链接时能还原 */
export function setQuery(tab: string, values: Record<string, string>): void {
  const q = new URLSearchParams({ tab, ...values });
  history.replaceState(null, "", `${location.pathname}?${q}`);
}

export function downloadCsv(filename: string, header: string[], rows: (string | number | null)[][]): void {
  const cell = (v: string | number | null) => {
    const s = v == null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const text = "﻿" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\n");
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = el("a", { href: url, download: filename });
  a.click();
  URL.revokeObjectURL(url);
}

/** 每个标签页一次只认最新一次查询：旧查询返回后不再渲染 */
export function runGuard() {
  let current = 0;
  return () => {
    const mine = ++current;
    return () => mine === current;
  };
}
