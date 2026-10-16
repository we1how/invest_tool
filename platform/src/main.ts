import "./style.css";
import { mountEvent } from "./tabs/event";
import { mountHolders } from "./tabs/holders";
import { mountUniverse } from "./tabs/universe";
import { mountVolume } from "./tabs/volume";
import { el } from "./ui";

type Mount = (root: HTMLElement, q: URLSearchParams | null) => void;

const TABS: { id: string; label: string; mount: Mount }[] = [
  { id: "holders", label: "十大股东", mount: mountHolders },
  { id: "volume", label: "资金量价", mount: mountVolume },
  { id: "event", label: "事件窗口", mount: mountEvent },
  { id: "universe", label: "标的索引", mount: mountUniverse },
];

const query = new URLSearchParams(location.search);
const initial = TABS.some((t) => t.id === query.get("tab")) ? query.get("tab")! : TABS[0].id;

const nav = el("div", { class: "tabs", role: "tablist" });
const panels = new Map<string, HTMLElement>();
const buttons = new Map<string, HTMLButtonElement>();

function show(id: string): void {
  for (const tab of TABS) {
    buttons.get(tab.id)!.setAttribute("aria-selected", String(tab.id === id));
    let panel = panels.get(tab.id);
    if (tab.id === id && !panel) {             // 第一次打开时才创建
      panel = el("section", { role: "tabpanel" });
      panels.set(tab.id, panel);
      page.insertBefore(panel, footer);
      tab.mount(panel, tab.id === initial ? query : null);
    }
    if (panel) panel.hidden = tab.id !== id;
  }
}

for (const tab of TABS) {
  const b = el("button", { type: "button", role: "tab" }, tab.label);
  b.addEventListener("click", () => {
    show(tab.id);
    history.replaceState(null, "", `${location.pathname}?tab=${tab.id}`);
  });
  buttons.set(tab.id, b);
  nav.append(b);
}

const footer = el("footer", {}, "数据来自腾讯、新浪、东方财富的公开接口，仅供个人研究参考，不构成投资建议。");
const page = el("div", { class: "page" },
  el("h1", {}, "投资工具"),
  el("p", { class: "sub" }, "填好参数点按钮，实时取数出图。"),
  nav, footer);
document.querySelector("#app")!.replaceChildren(page);
show(initial);
