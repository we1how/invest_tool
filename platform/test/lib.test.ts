import { describe, expect, it } from "vitest";
import { meanCurve, resolveEvent, summarizeStats, windowAround, windowStats } from "../src/lib/event";
import { commonHolders, summarizeLookThrough, type LookThroughRow } from "../src/lib/holders";
import { isAShare, isFund, marketOf, parseCodes, quarterEnds, todayInChina, ymd } from "../src/lib/market";
import { cumulativeTicks, enrichDaily } from "../src/lib/volume";

describe("market", () => {
  it("代码解析去重", () => {
    expect(parseCodes("601799, 002050 601799 abc 12345")).toEqual(["601799", "002050"]);
  });
  it("市场 / 类型判断", () => {
    expect([marketOf("600977"), marketOf("000802"), marketOf("510300"), marketOf("159559"), marketOf("920001"), marketOf("830001")])
      .toEqual(["sh", "sz", "sh", "sz", "bj", "bj"]);
    expect([isFund("159559"), isFund("510300"), isFund("600977")]).toEqual([true, true, false]);
    expect([isAShare("002600"), isAShare("00700"), isAShare("159559")]).toEqual([true, false, false]);
  });
  it("最近的季度末", () => {
    expect(quarterEnds(new Date(2026, 9, 11), 6))
      .toEqual(["2026-09-30", "2026-06-30", "2026-03-31", "2025-12-31", "2025-09-30", "2025-06-30"]);
    expect(quarterEnds(new Date(2026, 1, 1), 2)).toEqual(["2025-12-31", "2025-09-30"]);
  });
  it("北京时间的今天", () => {
    expect(ymd(todayInChina(new Date("2026-10-10T17:30:00Z")))).toBe("2026-10-11");
  });
});

describe("event", () => {
  it("解析事件", () => {
    expect(resolveEvent("春节")(2020)).toBe("2020-01-25");
    expect(resolveEvent("春节")(2099)).toBeNull();
    expect(resolveEvent("国庆节")(2023)).toBe("2023-10-01");
    expect(resolveEvent("6-18")(2024)).toBe("2024-06-18");
    const custom = resolveEvent("2020-07-15, 2021-07-10");
    expect([custom(2020), custom(2021), custom(2022)]).toEqual(["2020-07-15", "2021-07-10", null]);
    expect(() => resolveEvent("13-40")).toThrow();
    expect(() => resolveEvent("中秋")).toThrow();
  });

  // 10 个连续日历日当作交易日：01-01 .. 01-10，收盘价 10..19
  const rows = Array.from({ length: 10 }, (_, i) => ({ date: `2024-01-${String(i + 1).padStart(2, "0")}`, close: 10 + i }));

  it("窗口切分与指数化", () => {
    const win = windowAround(rows, "2024-01-06", 3)!;
    expect(win.map((p) => p.rel)).toEqual([-3, -2, -1, 1, 2, 3]);
    expect(win.map((p) => p.date)).toEqual(["2024-01-03", "2024-01-04", "2024-01-05", "2024-01-06", "2024-01-07", "2024-01-08"]);
    expect(win[2].idx).toBe(100);
    expect(win[5].idx).toBeCloseTo((17 / 14) * 100);
  });

  it("数据不足或离事件日太远时跳过", () => {
    expect(windowAround(rows, "2024-01-02", 3)).toBeNull();      // 事件前不足
    expect(windowAround(rows, "2024-01-09", 3)).toBeNull();      // 事件后不足
    expect(windowAround(rows, "2024-03-01", 3)).toBeNull();      // 事件日之后没有数据
    const gap = [...rows.slice(0, 5), { date: "2024-03-01", close: 20 }, { date: "2024-03-02", close: 21 }];
    expect(windowAround(gap, "2024-01-06", 2)).toBeNull();       // 停牌：事件后第一根离得太远
  });

  it("统计与平均曲线", () => {
    const win = windowAround(rows, "2024-01-06", 3)!;
    const s = windowStats(win);
    expect(s.pre).toBeCloseTo((14 / 12 - 1) * 100);
    expect(s.post).toBeCloseTo((17 / 14 - 1) * 100);
    expect(s.high).toBeCloseTo(s.post);
    expect(s.low).toBeCloseTo((15 / 14 - 1) * 100);
    const sum = summarizeStats([s, { pre: -2, post: -4, high: 1, low: -5 }]);
    expect(sum.years).toBe(2);
    expect(sum.preUp).toBe(50);
    expect(sum.postMean).toBeCloseTo((s.post - 4) / 2);
    const mean = meanCurve([win, win.map((p) => ({ ...p, idx: p.idx + 10 }))]);
    expect(mean[2]).toEqual({ rel: -1, idx: 105 });
  });
});

describe("holders", () => {
  const row = (rank: number, name: string, ratio: number | null) => ({ rank, name, kind: "", shares: 1, ratio, change: "不变" });

  it("相同股东", () => {
    const out = commonHolders([
      { code: "000001", name: "甲", rows: [row(1, "香港中央结算有限公司", 9.38), row(2, "张三", 5)] },
      { code: "000002", name: "乙", rows: [row(3, " 香港中央结算有限公司 ", 2.3), row(1, "李四", 30)] },
      { code: "000003", name: "丙", rows: [row(4, "香港中央结算有限公司", null), row(2, "李四", 1)] },
    ]);
    expect(out.map((o) => [o.name, o.count])).toEqual([["香港中央结算有限公司", 3], ["李四", 2]]);
    expect(out[0].detail).toBe("000001 甲 第1名 9.38%；000002 乙 第3名 2.30%；000003 丙 第4名 -");
  });

  it("ETF 穿透汇总", () => {
    const lt = (stockCode: string, weight: number, name: string, ratio: number): LookThroughRow =>
      ({ ...row(1, name, ratio), stockCode, stockName: "股" + stockCode, weight, period: "", source: "" });
    const out = summarizeLookThrough([
      lt("1", 10, "A", 20), lt("2", 5, "A", 40), lt("1", 10, "B", 50), lt("3", 2, "C", 10),
    ]);
    expect(out.map((o) => o.name)).toEqual(["A", "B", "C"]);
    expect(out[0]).toEqual({ name: "A", count: 2, coverWeight: 15, through: 4, avgRatio: 30, stocks: "股1、股2" });
    expect(out[1].through).toBe(5);
  });
});

describe("volume", () => {
  const rows = Array.from({ length: 7 }, (_, i) => ({
    date: `2024-01-0${i + 1}`, open: 1, close: 1, volume: (i + 1) * 10, amount: (i + 1) * 100,
  }));

  it("均线和环比在截取之前计算", () => {
    const out = enrichDaily(rows, "2024-01-05");
    expect(out.map((r) => r.date)).toEqual(["2024-01-05", "2024-01-06", "2024-01-07"]);
    expect(out[0].amountMa5).toBe(300);
    expect(out[0].amountPct).toBeCloseTo(25);
    expect(out[2].volumeMa5).toBe(50);
    const all = enrichDaily(rows, "2024-01-01");
    expect([all[0].amountPct, all[3].amountMa5]).toEqual([null, null]);
  });

  it("累计主动买卖", () => {
    const c = cumulativeTicks([["09:30:05", 5, "S"], ["09:30:02", 10, "B"], ["09:30:08", 7, "M"], ["09:30:11", 3, "B"]]);
    expect(c.time).toEqual(["09:30:02", "09:30:05", "09:30:08", "09:30:11"]);
    expect(c.buy).toEqual([10, 10, 10, 13]);
    expect(c.sell).toEqual([0, 5, 5, 5]);
  });
});
