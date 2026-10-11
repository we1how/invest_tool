# ============================================================
# 事件窗口对比：某事件日（如春节）前 / 后各 N 个交易日的走势，多只股票 × 多个年份
#   图 1：每个年份一张子图，多只股票叠在一起（比较同一年里个股的差异）
#   图 2：每只股票一张子图，多个年份叠在一起 + 平均线（寻找跨年规律）
#   表  ：每年 / 每只股票的节前、节后涨跌幅，以及平均值和上涨概率
# 所有结果汇总到一个 HTML 页面。数据源：akshare（东方财富 -> 新浪 -> 腾讯）
# ============================================================
import datetime as dt
import html
import re
import webbrowser
from pathlib import Path

import pandas as pd
import plotly.graph_objects as go
import requests
from plotly.subplots import make_subplots

from chart_style import PAGE_CSS, apply_style
from stock_volume import fetch_daily, market_of      # 复用日线抓取（多数据源自动降级）

# ------------------ 参数：只需要改这里 ------------------
CODES = "001330 000802 600977"      # 博纳影业 北京文化 中国电影；一个或多个 6 位代码
YEARS = range(2020, 2026)           # 2020-2025；也可写 [2021, 2023, 2025]
EVENT = "春节"                      # 见下方 EVENTS 里的名称（春节 / 国庆节 / 半年报截止 ...）
                                    # | "MM-DD"（每年固定日期，如 "06-18"）
                                    # | {2020: "2020-01-25", ...}（逐年自己指定日期）
CUSTOM = {                          # 自己填：事件名 -> 每年固定的 "MM-DD"（填完就能在 EVENT 里用名字）
    "暑假": "07-10",
    "寒假": "01-15",
}
N = 20                              # 事件日前 / 后各取多少个交易日
OUT_HTML = "event_window.html"
OPEN_REPORT = True
# --------------------------------------------------------

# 春节（农历正月初一）公历日期
SPRING_FESTIVAL = {
    2015: "02-19", 2016: "02-08", 2017: "01-28", 2018: "02-16", 2019: "02-05", 2020: "01-25",
    2021: "02-12", 2022: "02-01", 2023: "01-22", 2024: "02-10", 2025: "01-29", 2026: "02-17",
    2027: "02-06", 2028: "01-26", 2029: "02-13", 2030: "02-03",
}

# ---- 事件库：想加新事件，往这里加一行即可（名称 -> 接收年份、返回事件日的函数）----
# 事件日 = 窗口的分界点：前 N 个交易日是"事件前"，从事件日起的 N 个交易日是"事件后"
EVENTS = {
    "春节": lambda y: f"{y}-{SPRING_FESTIVAL[y]}",      # 农历初一
    "元旦": lambda y: f"{y}-01-01",
    "国庆节": lambda y: f"{y}-10-01",
    "年报/一季报截止": lambda y: f"{y}-04-30",          # 年报、一季报法定披露截止日，披露高峰在其前
    "半年报截止": lambda y: f"{y}-08-31",
    "三季报截止": lambda y: f"{y}-10-31",
}
EVENTS.update({name: (lambda y, md=md: f"{y}-{md}") for name, md in CUSTOM.items()})
PALETTE = ["#3b6fd4", "#e04b4b", "#2ca470", "#f0a020", "#8a5cc2", "#17a2b8", "#d6609b", "#7f8c8d"]
UA = {"User-Agent": "Mozilla/5.0"}


def get_name(code: str) -> str:
    try:
        r = requests.get(f"https://qt.gtimg.cn/q={market_of(code)}{code}", headers=UA, timeout=8)
        r.encoding = "gbk"
        return r.text.split("~")[1]
    except Exception:                                            # noqa: BLE001
        return ""


def event_date(year: int) -> pd.Timestamp:
    if isinstance(EVENT, dict):
        return pd.Timestamp(EVENT[year])
    if EVENT in EVENTS:
        return pd.Timestamp(EVENTS[EVENT](year))
    if re.fullmatch(r"\d{2}-\d{2}", EVENT):
        return pd.Timestamp(f"{year}-{EVENT}")
    raise ValueError(f"无法识别的 EVENT：{EVENT!r}，可选：{'、'.join(EVENTS)}，或 'MM-DD'")


def window(daily: pd.DataFrame, e: pd.Timestamp, n: int):
    """事件日 e 之前最后 n 个交易日(-n..-1) + e 当天及之后前 n 个交易日(1..n)，
    以 -1（事件前最后一个交易日）收盘价为 100。数据不足 n 天返回 None。"""
    pre = daily[daily["date"] < e].tail(n)
    post = daily[daily["date"] >= e].head(n)
    if len(pre) < n or len(post) < n:
        return None
    # 窗口必须真的贴着事件日，避免股票停牌 / 未上市时拿到很远的数据
    if (e - pre["date"].iloc[-1]).days > 15 or (post["date"].iloc[0] - e).days > 15:
        return None
    px = pd.concat([pre, post], ignore_index=True)
    px["rel"] = list(range(-n, 0)) + list(range(1, n + 1))
    px["idx"] = px["close"] / pre["close"].iloc[-1] * 100
    return px[["rel", "date", "close", "idx"]]


def collect(codes, years, n):
    """返回 {code: (name, {year: window_df})}、说明信息列表"""
    out, notes = {}, []
    for code in codes:
        name = get_name(code)
        start = dt.date(min(years) - 1, 11, 1)
        end = min(dt.date(max(years) + 1, 6, 30), dt.date.today())
        try:
            daily, src, _ = fetch_daily(code, start, end)
        except Exception as ex:                                  # noqa: BLE001
            notes.append(f"{code} {name}：数据获取失败（{str(ex).splitlines()[0]}）")
            continue
        wins = {}
        for y in years:
            w = window(daily, event_date(y), n)
            if w is None:
                notes.append(f"{code} {name} {y} 年：事件日前后数据不足（未上市 / 停牌 / 尚未到来），已跳过")
            else:
                wins[y] = w
        out[code] = (name, wins, src)
    return out, notes


def fig_by_year(data, years, n):
    years = [y for y in years if any(y in w for _, w, _ in data.values())]
    cols = min(3, len(years)) or 1
    rows = -(-len(years) // cols)
    fig = make_subplots(rows=rows, cols=cols, subplot_titles=[f"{y} 年" for y in years],
                        horizontal_spacing=0.05, vertical_spacing=0.12 / max(rows, 1) * 2)
    for i, y in enumerate(years):
        r, c = i // cols + 1, i % cols + 1
        for k, (code, (name, wins, _)) in enumerate(data.items()):
            if y not in wins:
                continue
            w = wins[y]
            fig.add_trace(go.Scatter(
                x=w["rel"], y=w["idx"], mode="lines", name=f"{code} {name}",
                line=dict(color=PALETTE[k % len(PALETTE)], width=2), legendgroup=code,
                showlegend=(i == 0 or not any(y2 in data[code][1] for y2 in years[:i])),
                customdata=w["date"].dt.strftime("%Y-%m-%d"),
                hovertemplate="%{customdata}｜第%{x}日｜%{y:.2f}<extra>" + f"{code} {name}</extra>"), row=r, col=c)
        fig.add_vline(x=0, line_dash="dot", line_color="#999", row=r, col=c)
        fig.add_hline(y=100, line_color="#ccc", row=r, col=c)
    apply_style(fig, "按年份对比（事件日前最后一个交易日 = 100；横轴为相对事件日的交易日）",
                320 * rows + 100, hovermode="x unified")
    fig.add_vrect(x0=0, x1=n + 0.5, fillcolor="#3b6fd4", opacity=0.05, line_width=0, row="all", col="all")   # 事件后区域淡底色
    fig.update_xaxes(dtick=5)
    return fig


def fig_by_stock(data, n):
    items = [(c, v) for c, v in data.items() if v[1]]
    cols = min(3, len(items)) or 1
    rows = -(-len(items) // cols)
    fig = make_subplots(rows=rows, cols=cols, subplot_titles=[f"{c} {v[0]}" for c, v in items],
                        horizontal_spacing=0.05)
    for i, (code, (name, wins, _)) in enumerate(items):
        r, c = i // cols + 1, i % cols + 1
        for k, (y, w) in enumerate(sorted(wins.items())):
            fig.add_trace(go.Scatter(
                x=w["rel"], y=w["idx"], mode="lines", name=str(y), legendgroup=str(y),
                line=dict(color=PALETTE[k % len(PALETTE)], width=1.6), opacity=0.8,
                showlegend=(i == 0), hovertemplate=f"{y}｜第%{{x}}日｜%{{y:.2f}}<extra></extra>"), row=r, col=c)
        mean = pd.concat([w.set_index("rel")["idx"] for w in wins.values()], axis=1).mean(axis=1)
        fig.add_trace(go.Scatter(x=mean.index, y=mean.values, mode="lines", name="平均",
                                 legendgroup="avg", showlegend=(i == 0),
                                 line=dict(color="#111", width=3, dash="dash")), row=r, col=c)
        fig.add_vline(x=0, line_dash="dot", line_color="#999", row=r, col=c)
        fig.add_hline(y=100, line_color="#ccc", row=r, col=c)
    apply_style(fig, "按股票对比（多个年份叠加，黑色虚线 = 各年平均）", 360 * rows + 100, hovermode="x unified")
    fig.add_vrect(x0=0, x1=n + 0.5, fillcolor="#3b6fd4", opacity=0.05, line_width=0, row="all", col="all")
    fig.update_xaxes(dtick=5)
    return fig


def stats_table(data, n):
    """每只股票 × 每年：节前 N 日涨跌幅、节后 N 日涨跌幅、节后最大回撤 / 最大涨幅"""
    rows = []
    for code, (name, wins, _) in data.items():
        for y, w in sorted(wins.items()):
            pre, post = w[w["rel"] < 0], w[w["rel"] > 0]
            base = pre["close"].iloc[-1]
            rows.append({"代码": code, "简称": name, "年份": y,
                         f"事件前{n}日涨跌(%)": (pre["close"].iloc[-1] / pre["close"].iloc[0] - 1) * 100,
                         f"事件后{n}日涨跌(%)": (post["close"].iloc[-1] / base - 1) * 100,
                         "事件后最高(%)": (post["close"].max() / base - 1) * 100,
                         "事件后最低(%)": (post["close"].min() / base - 1) * 100})
    detail = pd.DataFrame(rows)
    if detail.empty:
        return detail, detail
    pre_c, post_c = f"事件前{n}日涨跌(%)", f"事件后{n}日涨跌(%)"
    summ = detail.groupby(["代码", "简称"]).agg(
        样本年数=("年份", "count"), **{f"{pre_c}均值": (pre_c, "mean"), f"{post_c}均值": (post_c, "mean"),
                                    "事件前上涨概率(%)": (pre_c, lambda s: (s > 0).mean() * 100),
                                    "事件后上涨概率(%)": (post_c, lambda s: (s > 0).mean() * 100)}).reset_index()
    return detail, summ


def to_html(df: pd.DataFrame) -> str:
    return ('<div class="tbl">' + df.style.format({c: "{:.2f}" for c in df.columns if "%" in c or "均值" in c})
            .hide(axis="index").to_html() + "</div>")


CSS = PAGE_CSS


def main():
    codes = list(dict.fromkeys(re.findall(r"\d{6}", CODES)))
    years = sorted(YEARS)
    data, notes = collect(codes, years, N)
    data = {c: v for c, v in data.items() if v[1]}
    if not data:
        raise SystemExit("没有任何可用数据：\n" + "\n".join(notes))
    detail, summ = stats_table(data, N)
    ev = EVENT if isinstance(EVENT, str) else "自定义日期"
    names = "、".join(f"{c} {v[0]}" for c, v in data.items())
    parts = [f"<h1>事件窗口对比：{html.escape(ev)} 前后各 {N} 个交易日</h1>",
             f"<p>{html.escape(names)}｜{years[0]}–{years[-1]}｜价格为未复权收盘价，"
             f"以事件日前最后一个交易日收盘 = 100</p>"]
    parts += [f'<p class="note">{html.escape(t)}</p>' for t in notes]
    first = True
    for fig in (fig_by_year(data, years, N), fig_by_stock(data, N)):
        parts.append('<div class="chart">' + fig.to_html(full_html=False, include_plotlyjs="cdn" if first else False) + "</div>")
        first = False
    parts += ["<h2>各年明细</h2>", to_html(detail), "<h2>汇总（均值与上涨概率）</h2>", to_html(summ),
              "<p>⚠️ 样本年数很少，上涨概率和均值只能作为观察线索，不能当作规律。</p>"]
    path = Path(OUT_HTML).resolve()
    path.write_text(f'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
                    f'<title>事件窗口对比</title><style>{CSS}</style><div class="page">'
                    + "".join(parts) + "</div>", encoding="utf-8")
    print("\n".join(notes))
    print(summ.to_string(index=False))
    print(f"\n已生成：{path}")
    if OPEN_REPORT:
        webbrowser.open(path.as_uri())


if __name__ == "__main__":
    main()
