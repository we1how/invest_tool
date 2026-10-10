# ============================================================
# 个股近一个月 资金大小（成交额 / 成交量）与快慢（变化率）曲线
# 外加：每日流入 / 流出估算、主力净流入、最近交易日主动买卖累计曲线
# 数据源：akshare（东方财富 -> 新浪 -> 腾讯 自动降级）
# ============================================================
import datetime as dt
import time

import akshare as ak
import pandas as pd
import plotly.graph_objects as go
from plotly.subplots import make_subplots

# ------------------ 参数：只需要改这里 ------------------
SYMBOL = "601799"   # 6 位股票代码，如 600519 / 000001 / 300750
DAYS = 30           # 回看的自然日天数
# --------------------------------------------------------

RED, GREEN, BLUE, ORANGE, GREY = "#e04b4b", "#2ca470", "#3b6fd4", "#f0a020", "#8a8f98"


def market_of(code: str) -> str:
    """根据代码判断交易所前缀"""
    if code.startswith(("4", "8", "92")):
        return "bj"
    if code.startswith(("6", "9")):
        return "sh"
    return "sz"


def retry(fn, times: int = 3, wait: float = 2.0):
    """东方财富对海外 IP（Colab）经常直接断开连接，重试几次"""
    last = None
    for i in range(times):
        try:
            return fn()
        except Exception as ex:                                  # noqa: BLE001
            last = ex
            time.sleep(wait * (i + 1))
    raise last


def fetch_daily(code: str, start: dt.date, end: dt.date):
    """日线，返回 (DataFrame[date, open, close, volume(手), amount(元)], 数据源, 成交额是否为估算)"""
    mk = market_of(code)
    s, e = start.strftime("%Y%m%d"), end.strftime("%Y%m%d")
    errors = []

    def _em():
        df = retry(lambda: ak.stock_zh_a_hist(symbol=code, period="daily",
                                              start_date=s, end_date=e, adjust=""), times=2)
        return pd.DataFrame({"date": pd.to_datetime(df["日期"]), "open": df["开盘"],
                             "close": df["收盘"], "volume": df["成交量"],
                             "amount": df["成交额"]}), False

    def _sina():
        df = ak.stock_zh_a_daily(symbol=mk + code, start_date=s, end_date=e, adjust="")
        return pd.DataFrame({"date": pd.to_datetime(df["date"]), "open": df["open"],
                             "close": df["close"], "volume": df["volume"] / 100,   # 股 -> 手
                             "amount": df["amount"]}), False

    def _tx():
        df = ak.stock_zh_a_hist_tx(symbol=mk + code, start_date=s, end_date=e, adjust="")
        vol = df["amount"].astype(float)                         # 腾讯该列其实是成交量(手)
        mid = (df["open"].astype(float) + df["close"].astype(float)) / 2
        return pd.DataFrame({"date": pd.to_datetime(df["date"]), "open": df["open"],
                             "close": df["close"], "volume": vol,
                             "amount": vol * 100 * mid}), True    # 腾讯无成交额，用均价估算

    for name, fn in [("东方财富", _em), ("新浪", _sina), ("腾讯", _tx)]:
        try:
            out, est = fn()
            if len(out):
                out = out.astype({c: float for c in ["open", "close", "volume", "amount"]})
                return out.sort_values("date").reset_index(drop=True), name, est
            errors.append(f"{name}: 返回空数据")
        except Exception as ex:                                  # noqa: BLE001
            errors.append(f"{name}: {type(ex).__name__} {ex}")
    raise RuntimeError("所有数据源均失败：\n" + "\n".join(errors))


def fetch_main_flow(code: str, start: dt.date):
    """东方财富：每日主力净流入（元）。失败返回 None（不影响其余图）"""
    try:
        df = retry(lambda: ak.stock_individual_fund_flow(stock=code, market=market_of(code)))
        out = pd.DataFrame({"date": pd.to_datetime(df["日期"]),
                            "main_net": pd.to_numeric(df["主力净流入-净额"], errors="coerce")})
        out = out[out["date"].dt.date >= start].reset_index(drop=True)
        return out if len(out) else None
    except Exception as ex:                                      # noqa: BLE001
        print(f"[提示] 东方财富主力资金流向重试 3 次仍失败（{type(ex).__name__}），"
              f"净流入图只显示新浪 5 分钟 K 线估算值")
        return None


def fetch_flow_estimate(code: str, start: dt.date):
    """新浪 5 分钟 K 线估算每日流入 / 流出（元）：
    收盘 > 开盘的 5 分钟，成交额记为流入；收盘 < 开盘记为流出；平盘不计。
    新浪一次最多给约 40 个交易日，正好覆盖一个月。失败返回 None"""
    try:
        df = ak.stock_zh_a_minute(symbol=market_of(code) + code, period="5", adjust="")
        if df is None or df.empty:
            return None
        for c in ["open", "close", "volume"]:
            df[c] = pd.to_numeric(df[c], errors="coerce")
        if "amount" in df:
            amt = pd.to_numeric(df["amount"], errors="coerce")
        else:
            amt = df["volume"] * df["close"]                     # 无成交额列时用 量×价 近似
        df["date"] = pd.to_datetime(df["day"]).dt.normalize()
        df["inflow"] = amt.where(df["close"] > df["open"], 0.0)
        df["outflow"] = amt.where(df["close"] < df["open"], 0.0)
        out = df.groupby("date")[["inflow", "outflow"]].sum().reset_index()
        out["net"] = out["inflow"] - out["outflow"]
        out = out[out["date"].dt.date >= start].reset_index(drop=True)
        return out if len(out) else None
    except Exception as ex:                                      # noqa: BLE001
        print(f"[提示] 5 分钟 K 线获取失败（{type(ex).__name__}），跳过流入 / 流出估算")
        return None


def fetch_today_ticks(code: str):
    """最近一个交易日逐笔成交，返回 DataFrame[time, volume(手), side]。失败返回 None"""
    mk = market_of(code)
    try:
        df = ak.stock_zh_a_tick_tx_js(symbol=mk + code)          # 腾讯
        out = pd.DataFrame({"time": df["成交时间"], "volume": df["成交量"], "side": df["性质"]})
    except Exception:                                            # noqa: BLE001
        try:
            df = retry(lambda: ak.stock_intraday_em(symbol=code), times=2)   # 东方财富
            out = pd.DataFrame({"time": df["时间"], "volume": df["手数"], "side": df["买卖盘性质"]})
        except Exception as ex:                                  # noqa: BLE001
            print(f"[提示] 逐笔成交获取失败（{type(ex).__name__}），跳过当日买卖盘图")
            return None
    if not len(out):
        return None
    out["volume"] = out["volume"].astype(float)
    out["time"] = pd.to_datetime("2000-01-01 " + out["time"].astype(str))
    out = out.sort_values("time").reset_index(drop=True)
    out["cum_buy"] = out["volume"].where(out["side"] == "买盘", 0).cumsum()
    out["cum_sell"] = out["volume"].where(out["side"] == "卖盘", 0).cumsum()
    return out


def build_figure(code, daily, source, amount_est, est, main, ticks):
    x = daily["date"].dt.strftime("%m-%d")
    panels = ["amount", "volume", "speed"]
    titles = [f"资金大小：日成交额（亿元）{'[均价估算]' if amount_est else ''}｜数据源：{source}",
              "日成交量（万手）",
              "资金快慢：日环比变化率（%）｜线越陡、离 0 越远，变化越快"]
    if est is not None:
        panels.append("inout")
        titles.append("每日流入 vs 流出（亿元，5 分钟 K 线估算）")
    if est is not None or main is not None:
        panels.append("net")
        titles.append("每日净流入（亿元）")
    if ticks is not None:
        panels.append("ticks")
        titles.append("最近交易日：主动买入 / 主动卖出 累计（手）｜斜率 = 买卖速度")

    n = len(panels)
    fig = make_subplots(rows=n, cols=1, vertical_spacing=0.055, subplot_titles=titles)

    def line(row, xs, ys, name, color, dash=None, markers=True, width=2):
        fig.add_scatter(x=xs, y=ys, name=name, mode="lines+markers" if markers else "lines",
                        line=dict(color=color, width=width, dash=dash),
                        marker=dict(size=5), row=row, col=1)

    def zero(row):
        fig.add_hline(y=0, line_color=GREY, line_width=1, row=row, col=1)

    # 1) 成交额
    r = panels.index("amount") + 1
    line(r, x, daily["amount"] / 1e8, "成交额", BLUE)
    line(r, x, daily["amount_ma5"] / 1e8, "成交额 5 日均", ORANGE, dash="dot", markers=False)

    # 2) 成交量
    r = panels.index("volume") + 1
    line(r, x, daily["volume"] / 1e4, "成交量", "#7a5cc9")
    line(r, x, daily["volume_ma5"] / 1e4, "成交量 5 日均", ORANGE, dash="dot", markers=False)

    # 3) 变化率
    r = panels.index("speed") + 1
    line(r, x, daily["amount_pct"], "成交额变化率 %", BLUE)
    line(r, x, daily["volume_pct"], "成交量变化率 %", "#7a5cc9", dash="dash")
    zero(r)

    # 4) 流入 / 流出
    if est is not None:
        ex = est["date"].dt.strftime("%m-%d")
        r = panels.index("inout") + 1
        line(r, ex, est["inflow"] / 1e8, "流入额(估算)", RED)
        line(r, ex, est["outflow"] / 1e8, "流出额(估算)", GREEN)

    # 5) 净流入
    if "net" in panels:
        r = panels.index("net") + 1
        if est is not None:
            line(r, est["date"].dt.strftime("%m-%d"), est["net"] / 1e8, "净流入(估算)", BLUE)
        if main is not None:
            line(r, main["date"].dt.strftime("%m-%d"), main["main_net"] / 1e8,
                 "主力净流入(东方财富)", RED, dash="dash")
        zero(r)

    # 6) 当日累计主动买卖
    if ticks is not None:
        r = panels.index("ticks") + 1
        tx = ticks["time"].dt.strftime("%H:%M:%S")
        line(r, tx, ticks["cum_buy"], "累计主动买入", RED, markers=False)
        line(r, tx, ticks["cum_sell"], "累计主动卖出", GREEN, markers=False)
        line(r, tx, ticks["cum_buy"] - ticks["cum_sell"], "买入 − 卖出", BLUE, dash="dot", markers=False)
        zero(r)
        fig.update_xaxes(nticks=10, row=r, col=1)

    fig.update_xaxes(type="category")
    fig.update_layout(title=f"{code} 近 {DAYS} 天资金大小与快慢", height=300 * n,
                      template="plotly_white", hovermode="x unified",
                      legend=dict(orientation="h", y=-0.03))
    return fig


def main(code: str = SYMBOL, days: int = DAYS):
    code = code.strip()[-6:]
    end = dt.date.today()
    start = end - dt.timedelta(days=days)

    # 多取 20 天，保证窗口第一天的均线 / 变化率有值
    daily, source, amount_est = fetch_daily(code, start - dt.timedelta(days=20), end)
    for c in ["amount", "volume"]:
        daily[f"{c}_ma5"] = daily[c].rolling(5).mean()
        daily[f"{c}_pct"] = daily[c].pct_change() * 100     # 日环比变化率
    daily = daily[daily["date"].dt.date >= start].reset_index(drop=True)

    est = fetch_flow_estimate(code, start)
    main_flow = fetch_main_flow(code, start)
    ticks = fetch_today_ticks(code)

    build_figure(code, daily, source, amount_est, est, main_flow, ticks).show()

    # 文字摘要
    last = daily.iloc[-1]
    fastest = daily.loc[daily["amount_pct"].abs().idxmax()]
    print(f"\n区间 {daily['date'].iloc[0]:%Y-%m-%d} ~ {last['date']:%Y-%m-%d}，共 {len(daily)} 个交易日")
    print(f"日均成交额 {daily['amount'].mean() / 1e8:,.2f} 亿元；最大 {daily['amount'].max() / 1e8:,.2f} 亿元"
          f"（{daily.loc[daily['amount'].idxmax(), 'date']:%m-%d}）")
    print(f"最新一日成交额 {last['amount'] / 1e8:,.2f} 亿元，较前一日 {last['amount_pct']:+.1f}%，"
          f"为 5 日均值的 {last['amount'] / last['amount_ma5']:.2f} 倍")
    print(f"变化最快的一天：{fastest['date']:%m-%d}，成交额环比 {fastest['amount_pct']:+.1f}%")
    if est is not None:
        print(f"区间估算净流入合计 {est['net'].sum() / 1e8:+,.2f} 亿元"
              f"（{(est['net'] > 0).sum()} 天净流入 / {(est['net'] < 0).sum()} 天净流出）")
    if ticks is not None:
        buy, sell = ticks["cum_buy"].iloc[-1], ticks["cum_sell"].iloc[-1]
        print(f"最近交易日 主动买入 {buy:,.0f} 手 / 主动卖出 {sell:,.0f} 手，差额 {buy - sell:+,.0f} 手")
    return daily, est, main_flow, ticks


daily, est, main_flow, ticks = main()
