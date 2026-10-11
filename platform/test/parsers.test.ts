import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { holdersPeriod, parseFundHoldings, parseHolders, parseMainFlow, parseEmKline, pickPeriod } from "../worker/sources/eastmoney";
import { aggregateFlow, parseSinaBars, sinaDaily } from "../worker/sources/sina";
import { parseQuote, parseTicks, parseTxKline } from "../worker/sources/tencent";

const fx = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");

describe("腾讯", () => {
  it("行情名称", () => {
    expect(parseQuote(fx("tx_quote.txt"))).toEqual({
      "600977": "中国电影", "000802": "北京文化", "159559": "机器人ETF景顺",
    });
    expect(parseQuote('v_pv_none_match="1";')).toEqual({});
  });

  it("日线：640 根，成交额由万元换算成元", () => {
    const { rows, estimated } = parseTxKline(fx("tx_kline.json"), "sh600977");
    expect(rows).toHaveLength(640);
    expect(estimated).toBe(false);
    expect(rows.at(-1)).toEqual({ date: "2021-12-31", open: 12.83, close: 12.81, volume: 153403.31, amount: 196578400 });
  });

  it("日线：带 jsonp 前缀、缺成交额时估算", () => {
    const text = 'kline_day={"data":{"sz000001":{"day":[["2020-01-02","10","12","12","10","100"]]}}}';
    const { rows, estimated } = parseTxKline(text, "sz000001");
    expect(estimated).toBe(true);
    expect(rows[0].amount).toBe(100 * 100 * 11);
  });

  it("逐笔", () => {
    const ticks = parseTicks(fx("tx_ticks_p0.txt"));
    expect(ticks[0]).toEqual(["09:25:02", 1218, "B"]);
    expect(ticks.length).toBeGreaterThan(50);
    expect(parseTicks(fx("tx_ticks_p999.txt"))).toEqual([]);
  });
});

describe("新浪", () => {
  it("日线", () => {
    const rows = sinaDaily(parseSinaBars(fx("sina_day.txt")));
    expect(rows).toHaveLength(30);
    expect(rows[0].date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(rows[0].amount).toBeCloseTo(rows[0].volume * 100 * (rows[0].open + rows[0].close) / 2);
  });

  it("5 分钟线按天聚合成流入 / 流出", () => {
    const flow = aggregateFlow([
      { day: "2026-01-05 09:35:00", open: "10", close: "11", volume: "100", amount: "1000" },
      { day: "2026-01-05 09:40:00", open: "11", close: "10", volume: "100", amount: "400" },
      { day: "2026-01-05 09:45:00", open: "10", close: "10", volume: "100", amount: "999" },
      { day: "2026-01-06 09:35:00", open: "10", close: "9", volume: "50" },
    ]);
    expect(flow).toEqual([
      { date: "2026-01-05", inflow: 1000, outflow: 400, net: 600 },
      { date: "2026-01-06", inflow: 0, outflow: 450, net: -450 },
    ]);
    expect(aggregateFlow(parseSinaBars(fx("sina_min5.txt"))).length).toBeGreaterThan(3);
    expect(parseSinaBars("=(null);")).toEqual([]);
  });
});

describe("东方财富", () => {
  it("十大股东", () => {
    const rows = parseHolders(fx("em_sdgd.json"), false);
    expect(rows).toHaveLength(10);
    expect(rows[0]).toEqual({ rank: 1, name: "周晓萍", kind: "流通A股", shares: 119977973, ratio: 42, change: "不变" });
    expect(rows.reduce((s, r) => s + (r.ratio ?? 0), 0)).toBeCloseTo(67.61, 2);
  });

  it("十大流通股东", () => {
    const rows = parseHolders(fx("em_sdltgd.json"), true);
    expect(rows[0].kind).toBe("个人");
    expect(rows[0].ratio).toBeCloseTo(41.9974, 3);
  });

  it("未披露的报告期返回空", () => {
    expect(parseHolders(fx("em_sdgd_empty.json"), false)).toEqual([]);
  });

  it("新上市股票：从 PageAjax 取最新一期", () => {
    const text = fx("em_pageajax_new.json");
    const rows = parseHolders(text, false);
    expect(rows).toHaveLength(10);
    expect(rows[0].name).toBe("王兴兴");
    expect(holdersPeriod(text, false)).toBe("2026-08-19");
    expect(parseHolders(text, true)).toEqual([]);
    expect(holdersPeriod(text, true)).toBeNull();
  });

  it("主力资金流 / 日线", () => {
    const flow = '{"data":{"klines":["2026-04-13,6069073.0,-17790259.0,11721185.0,-1004654.0,7073727.0,1.52"]}}';
    expect(parseMainFlow(flow)).toEqual([{ date: "2026-04-13", mainNet: 6069073 }]);
    expect(parseMainFlow('{"data":null}')).toEqual([]);
    const k = '{"data":{"klines":["2020-01-02,15.2,15.5,15.6,15.1,123456,190000000.0"]}}';
    expect(parseEmKline(k)).toEqual([{ date: "2020-01-02", open: 15.2, close: 15.5, volume: 123456, amount: 190000000 }]);
  });

  it("基金持仓", () => {
    const periods = parseFundHoldings(fx("em_fund.txt"));
    expect(Object.keys(periods).sort()).toEqual(["2026年1季度", "2026年2季度"]);
    expect(periods["2026年2季度"][0]).toEqual({ code: "002600", name: "领益智造", weight: 6.09, shares: 796.44, value: 13810.26 });
    const picked = pickPeriod(periods)!;
    expect(picked.period).toBe("2026年2季度");
    expect(picked.isFull).toBe(false);
    expect(picked.rows).toHaveLength(10);
  });

  it("优先选完整持仓的报告期", () => {
    const h = (n: number) => Array.from({ length: n }, (_, i) => ({ code: String(600000 + i), name: "x", weight: i, shares: 1, value: 1 }));
    const picked = pickPeriod({ "2026年1季度": h(10), "2025年4季度": h(30), "2025年2季度": h(28) })!;
    expect(picked.period).toBe("2025年4季度");
    expect(picked.isFull).toBe(true);
    expect(picked.rows[0].weight).toBe(29);
    expect(pickPeriod({})).toBeNull();
  });
});
