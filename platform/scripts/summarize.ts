// 用 Claude（Haiku）根据业务画像 + 公司自述，为每只美股写一句中文业务概括，并翻译业务分部名。
//
//   node scripts/summarize.ts                 # 按市值从大到小，跑完所有还没做的（可随时中断，重跑会接着做）
//   node scripts/summarize.ts --limit=100     # 只做前 100 家
//   node scripts/summarize.ts --batch=25 --pause=20
//   node scripts/summarize.ts --start=2000 --limit=10   # 抽查市值排在 2000 名左右的 10 家
//
// 通过本机的 `claude -p` 调用，消耗的是当前登录的 Claude 订阅额度。
// 先运行 npm run data 生成 universe.json / profile.json / intro.json；结果写到 public/data/summary.json。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fmtAmount, regionCn } from "../src/lib/universe.ts";
import type { Profile, Summary, UniverseFile, UniverseItem } from "../src/types.ts";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA = path.join(ROOT, "public", "data");
const CACHE = path.join(ROOT, ".cache", "universe", "summary.json");
const args = new Map(process.argv.slice(2).map((a) => { const [k, v] = a.replace(/^--/, "").split("="); return [k, v ?? "1"]; }));
const BATCH = Number(args.get("batch") ?? 25);
const PAUSE_S = Number(args.get("pause") ?? 20);
const LIMIT = args.has("limit") ? Number(args.get("limit")) : Infinity;
const START = Number(args.get("start") ?? 0);         // 从第几家开始（按市值排序），用于抽查
const MODEL = args.get("model") ?? "haiku";
const VERSION = 1;                       // 提示词改了就加 1，旧结果会重做

const SYSTEM = [
  "你是给中文个人投资者写公司速览的助手。",
  "只能使用用户给出的资料，不要用你自己的记忆补充任何事实：客户名、产品名、市场地位、数字都不行。",
  "资料里没有的就不写，不要猜。只输出 JSON，不要任何解释。",
].join("");

const read = <T>(f: string): T => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8")) as T;
const sleep = (s: number) => new Promise((r) => setTimeout(r, s * 1000));
const pct = (v: number) => `${Math.round(v)}%`;
/** 东方财富的"营销费用"：没有单独列管理费用时是销售及管理费用合计，否则只是销售费用 */
const costLabel = (name: string, all: [string, number][]) =>
  name !== "营销费用" ? name : all.some(([n]) => n === "一般及行政费用") ? "销售费用" : "销售及管理费用";

type Cached = Summary & { v: number; at: string };

/** 一家公司的资料卡（喂给模型的输入） */
export function companyCard(it: UniverseItem, p: Profile | undefined, intro: string | undefined): string {
  const lines = [`[${it.s}] ${it.cn ? `${it.cn} / ` : ""}${it.n}｜行业：${[it.ind, it.sub].filter(Boolean).join(" / ") || "未知"}`];
  if (p?.rev !== undefined) {
    const parts = [`营收 ${fmtAmount(p.rev, p.cur)}${p.yoy !== undefined ? `（同比 ${p.yoy >= 0 ? "+" : ""}${Math.round(p.yoy)}%）` : ""}`];
    if (p.gm !== undefined) parts.push(`毛利率 ${pct(p.gm)}`);
    if (p.op !== undefined) parts.push(`${p.opLabel ?? "营业利润"}率 ${pct(p.op)}`);
    if (p.net !== undefined) parts.push(`净利率 ${pct(p.net)}`);
    lines.push(`${parts.join("，")}（财年截至 ${p.fy}）`);
  }
  if (p?.seg?.length) lines.push(`收入构成（业务）：${p.seg.map(([n, w]) => `${n} ${pct(w)}`).join("; ")}`);
  if (p?.reg?.length) lines.push(`收入构成（地区）：${p.reg.map(([n, w]) => `${regionCn(n)} ${pct(w)}`).join("; ")}`);
  if (p?.cost?.length) {
    const rel = p.rev !== undefined && p.rev > 0 && p.cost.reduce((a, [, v]) => a + v, 0) / p.rev <= 3;
    lines.push(`主要支出${rel ? "（占营收）" : "（金额）"}：${p.cost.map(([n, v]) =>
      `${costLabel(n, p.cost!)} ${rel ? pct((v / p.rev!) * 100) : fmtAmount(v, p.cur)}`).join("; ")}`);
  }
  if (intro) lines.push(`公司自述：${intro}`);
  return lines.join("\n");
}

function prompt(cards: string[]): string {
  return [
    "为下面每家公司写两样东西：",
    '1. "s"：一句中文大白话（40～90 字），让完全不了解这家公司的人一眼看懂：它卖什么产品或服务；收入主要来自哪块（带占比）；目前赚钱还是亏钱、钱主要花在哪。资料里没有的部分直接省略。',
    '2. "seg"：把"收入构成（业务）"里每个英文业务名翻译成简短中文（不超过 10 个字），专有名词可保留英文；没有业务构成就省略这一项。',
    '只输出一个 JSON 对象，键是方括号里的代码，例如：{"NVDA": {"s": "……", "seg": {"Data Center": "数据中心"}}}',
    "",
    ...cards.flatMap((c) => [c, ""]),
  ].join("\n");
}

/** 调用 claude -p，返回模型输出的文本 */
function callClaude(input: string): Promise<{ ok: boolean; text: string }> {
  return new Promise((resolve) => {
    const child = spawn("claude", [
      "-p", "--model", MODEL, "--tools", "", "--system-prompt", SYSTEM, "--setting-sources", "",
      "--strict-mcp-config", "--no-session-persistence", "--disable-slash-commands", "--output-format", "json",
    ], { cwd: os.tmpdir(), stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill("SIGTERM"), 10 * 60_000);
    child.on("close", () => {
      clearTimeout(timer);
      try {
        const body = JSON.parse(out) as { is_error?: boolean; result?: string };
        resolve({ ok: !body.is_error, text: body.result ?? "" });
      } catch {
        resolve({ ok: false, text: (out || err).slice(0, 500) });
      }
    });
    child.stdin.end(input);
  });
}

/** 从模型输出里取出 JSON 对象，只保留这一批代码的合法结果 */
export function parseResult(text: string, codes: string[]): Record<string, Summary> {
  const a = text.indexOf("{"), b = text.lastIndexOf("}");
  if (a < 0 || b < a) return {};
  let obj: Record<string, unknown>;
  try { obj = JSON.parse(text.slice(a, b + 1)) as Record<string, unknown>; } catch { return {}; }
  const out: Record<string, Summary> = {};
  for (const c of codes) {
    const v = obj[c] as { s?: unknown; seg?: unknown } | undefined;
    if (!v || typeof v.s !== "string" || v.s.trim().length < 10) continue;
    const item: Summary = { s: v.s.trim().slice(0, 200) };
    if (v.seg && typeof v.seg === "object") {
      const seg = Object.fromEntries(Object.entries(v.seg as Record<string, unknown>)
        .filter(([k, t]) => typeof t === "string" && t.trim() && k.length < 120).map(([k, t]) => [k, (t as string).trim().slice(0, 30)]));
      if (Object.keys(seg).length) item.seg = seg;
    }
    out[c] = item;
  }
  return out;
}

async function main(): Promise<void> {
  const uni = read<UniverseFile>("universe.json");
  const profile = read<Record<string, Profile>>("profile.json");
  const intro = read<Record<string, string>>("intro.json");
  const cache: Record<string, Cached> = fs.existsSync(CACHE) ? JSON.parse(fs.readFileSync(CACHE, "utf8")) : {};
  const save = () => {
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(cache));
    const pub: Record<string, Summary> = {};
    for (const it of uni.items) {
      const c = cache[it.s];
      if (c) pub[it.s] = c.seg ? { s: c.s, seg: c.seg } : { s: c.s };
    }
    fs.writeFileSync(path.join(DATA, "summary.json"), JSON.stringify(pub));
  };

  const todo = uni.items
    .filter((it) => it.t === "S" && (profile[it.s] || intro[it.s]) && cache[it.s]?.v !== VERSION)
    .sort((a, b) => (b.mc ?? 0) - (a.mc ?? 0))
    .slice(START, START + LIMIT);
  console.log(`待处理 ${todo.length} 家（已完成 ${Object.keys(cache).length}），每批 ${BATCH} 家，模型 ${MODEL}`);

  let failures = 0;
  for (let i = 0; i < todo.length; i += BATCH) {
    const batch = todo.slice(i, i + BATCH);
    const codes = batch.map((it) => it.s);
    const t0 = Date.now();
    const res = await callClaude(prompt(batch.map((it) => companyCard(it, profile[it.s], intro[it.s]))));
    const got = res.ok ? parseResult(res.text, codes) : {};
    const n = Object.keys(got).length;
    for (const [c, v] of Object.entries(got)) cache[c] = { ...v, v: VERSION, at: new Date().toISOString() };
    save();
    const when = new Date().toLocaleTimeString("zh-CN", { hour12: false });
    console.log(`[${when}] ${Math.min(i + BATCH, todo.length)}/${todo.length}：本批 ${n}/${codes.length} 成功（${Math.round((Date.now() - t0) / 1000)}s）`);

    if (!res.ok || n === 0) {
      failures++;
      const limited = /limit|usage|quota|rate|overloaded|429|529/i.test(res.text);
      const wait = limited ? 30 * 60 : Math.min(30 * 60, 60 * 2 ** failures);
      console.log(`  失败：${res.text.slice(0, 200).replace(/\s+/g, " ")}；${Math.round(wait / 60)} 分钟后重试这一批`);
      if (failures >= 8) { console.log("连续失败太多，先停下。稍后重跑会从断点继续。"); break; }
      await sleep(wait);
      i -= BATCH;                          // 重试同一批
      continue;
    }
    failures = 0;
    await sleep(PAUSE_S);
  }
  save();
  console.log(`结束：已完成 ${Object.keys(cache).length} 家`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((ex) => { console.error("失败：", ex instanceof Error ? ex.message : ex); process.exit(1); });
}
