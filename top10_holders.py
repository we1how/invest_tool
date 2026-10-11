# ============================================================
# 前十大股东查询：支持一只或多只股票 / ETF
#   股票 -> 十大股东 + 十大流通股东（东方财富，失败自动降级新浪）
#   ETF  -> 先取全部成份股，再逐只查询每只成份股的十大股东，并做穿透汇总
# ============================================================
import datetime as dt
import html
import webbrowser
from pathlib import Path
import re
import time
from io import StringIO

import akshare as ak
import pandas as pd
import plotly.graph_objects as go
import requests

from chart_style import PAGE_CSS, apply_style
try:
    from IPython.display import Markdown, display
    HAVE_IPY = True
except ImportError:                      # 命令行运行：没有 IPython 时只生成 HTML 报告
    HAVE_IPY = False

    class Markdown(str):
        pass

    def display(obj):
        pass

# ------------------ 参数：只需要改这里 ------------------
CODES = "000977 688825 600667 688256"   # 一个或多个 6 位代码，逗号 / 空格分隔均可
SHOW_FLOAT = True                  # 股票是否同时显示十大流通股东
ETF_MAX_STOCKS = None              # ETF 最多穿透多少只成份股（按权重从高到低）；None = 全部
ETF_SHOW_TABLES = 10               # ETF 只展开权重前 N 只成份股的明细表，其余只进汇总和 CSV
ETF_FLOAT = False                  # ETF 成份股查十大流通股东(True) 还是十大股东(False)
PAUSE = 0.3                        # 每只成份股之间的停顿秒数，防止被限流
REPORT_HTML = "top10_holders.html"   # 所有结果汇总到这一个网页；None = 不生成
OPEN_REPORT = True                 # 生成后自动用浏览器打开
SAVE_CSV = True                    # 是否把全部结果合并保存为 top10_holders.csv
# --------------------------------------------------------

BAR = "#3b6fd4"
UA = {"User-Agent": "Mozilla/5.0"}


def is_fund(code: str) -> bool:
    """沪市 5 开头、深市 1 开头为场内基金（ETF / LOF）"""
    return code[0] in "15"


def market_of(code: str) -> str:
    if code.startswith(("4", "8", "92")):
        return "bj"
    if code.startswith(("5", "6", "9")):
        return "sh"
    return "sz"


def get_name(code: str) -> str:
    """证券简称（腾讯行情），取不到就返回空串"""
    try:
        r = requests.get(f"https://qt.gtimg.cn/q={market_of(code)}{code}", headers=UA, timeout=8)
        r.encoding = "gbk"
        return r.text.split("~")[1]
    except Exception:                                            # noqa: BLE001
        return ""


def quarter_ends(n: int = 6):
    """最近 n 个季度末（从新到旧），格式 YYYYMMDD"""
    out, d = [], dt.date.today()
    y, q = d.year, (d.month - 1) // 3          # q = 已结束的季度数
    while len(out) < n:
        if q == 0:
            y, q = y - 1, 4
        out.append(f"{y}{['0331', '0630', '0930', '1231'][q - 1]}")
        q -= 1
    return out


# ------------------------- 股票 -------------------------
def _em_holders(code: str, floating: bool):
    """东方财富：从最近的报告期往前找，第一个有数据的就是最新一期"""
    fn = ak.stock_gdfx_free_top_10_em if floating else ak.stock_gdfx_top_10_em
    ratio_col = "占总流通股本持股比例" if floating else "占总股本持股比例"
    for date in quarter_ends():
        try:
            df = fn(symbol=market_of(code) + code, date=date)
        except Exception:                                        # noqa: BLE001
            continue                    # 该报告期尚未披露时接口会抛错
        if df is None or df.empty:
            continue
        out = pd.DataFrame({
            "名次": df["名次"],
            "股东名称": df["股东名称"],
            "性质": df["股东性质"] if "股东性质" in df else df["股份类型"],
            "持股数(股)": pd.to_numeric(df["持股数"], errors="coerce"),
            "持股比例(%)": pd.to_numeric(df[ratio_col], errors="coerce"),
            "较上期增减": df["增减"],
        })
        return out.head(10), f"{date[:4]}-{date[4:6]}-{date[6:]}", "东方财富"
    return None


def _sina_holders(code: str, floating: bool):
    """新浪：一次返回全部历史报告期，取最新一期"""
    if floating:
        df = ak.stock_circulate_stock_holder(symbol=code)
        date_col, ratio_col = "截止日期", "占流通股比例"
    else:
        df = ak.stock_main_stock_holder(stock=code)
        date_col, ratio_col = "截至日期", "持股比例"
    latest = df[date_col].max()
    df = df[df[date_col] == latest]
    out = pd.DataFrame({
        "名次": pd.to_numeric(df["编号"], errors="coerce"),
        "股东名称": df["股东名称"],
        "性质": df["股本性质"],
        "持股数(股)": pd.to_numeric(df["持股数量"], errors="coerce"),
        "持股比例(%)": pd.to_numeric(df[ratio_col], errors="coerce"),
        "较上期增减": "-",              # 新浪不提供
    }).dropna(subset=["名次"]).sort_values("名次")
    out["名次"] = out["名次"].astype(int)
    return out.head(10).reset_index(drop=True), str(latest), "新浪"


def stock_holders(code: str, floating: bool):
    """返回 (表, 报告期, 数据源)；两个数据源都失败则抛错"""
    res = _em_holders(code, floating)
    if res is not None:
        return res
    return _sina_holders(code, floating)


# -------------------------- ETF --------------------------
def fund_hold_em(code: str, year: int) -> pd.DataFrame:
    """天天基金持仓。akshare 自带的请求不带 UA，会被东方财富拦截（返回 404），这里自己请求再解析"""
    r = requests.get("https://fundf10.eastmoney.com/FundArchivesDatas.aspx", timeout=15,
                     headers={**UA, "Referer": "https://fundf10.eastmoney.com/"},
                     params={"type": "jjcc", "code": code, "topline": "10000", "year": year, "month": "", "rt": "0.9"})
    r.encoding = "utf-8"
    m = re.search(r'content:"(.*?)",arryear', r.text, re.S)
    if not m:
        return pd.DataFrame()
    content = m.group(1).replace('\\"', '"')
    labels = re.findall(r"&nbsp;&nbsp;([^<>]*?股票投资明细)</label>", content)
    tables = pd.read_html(StringIO(content), converters={"股票代码": str})
    out = []
    for label, t in zip(labels, tables):
        t = t.rename(columns=lambda c: re.sub(r"\s+", "", str(c)))
        pct = [c for c in t.columns if c.startswith("占净值")][0]
        num = [c for c in t.columns if c.startswith("持股数")][0]
        val = [c for c in t.columns if c.startswith("持仓市值")][0]
        out.append(pd.DataFrame({
            "股票代码": t["股票代码"], "股票名称": t["股票名称"],
            "占净值比例": pd.to_numeric(t[pct].astype(str).str.rstrip("%"), errors="coerce"),
            "持股数": pd.to_numeric(t[num].astype(str).str.replace(",", ""), errors="coerce"),
            "持仓市值": pd.to_numeric(t[val].astype(str).str.replace(",", ""), errors="coerce"),
            "季度": label}))
    return pd.concat(out, ignore_index=True) if out else pd.DataFrame()


def etf_holdings(code: str):
    """ETF 最新一期【完整】持仓。
    季报只披露前十大，半年报 / 年报才披露全部持仓，所以取最近一个行数 > 10 的报告期；
    若都只有前十大，就退回最新一期。"""
    year = dt.date.today().year
    frames, err = [], None
    for y in (year, year - 1):
        try:
            df = fund_hold_em(code, y)
            if df is not None and len(df):
                frames.append(df)
        except Exception as ex:                                  # noqa: BLE001
            err = ex
    if not frames:
        raise RuntimeError("未取到持仓数据" + (f"（{type(err).__name__} {err}）" if err else ""))
    df = pd.concat(frames, ignore_index=True)
    sizes = df.groupby("季度").size()
    full = sizes[sizes > 10]
    period = (full if len(full) else sizes).index.max()   # 形如 "2026年2季度股票投资明细"
    df = df[df["季度"] == period].sort_values("占净值比例", ascending=False)
    out = pd.DataFrame({
        "序号": range(1, len(df) + 1),
        "股票代码": df["股票代码"].astype(str).values,
        "股票名称": df["股票名称"].values,
        "占净值比例(%)": df["占净值比例"].values,
        "持股数(万股)": df["持股数"].values,
        "持仓市值(万元)": df["持仓市值"].values,
    })
    return out, period.replace("股票投资明细", ""), bool(len(full))


def is_a_share(code: str) -> bool:
    """只穿透 A 股成份股（跨境 ETF 里的港股 / 美股查不了十大股东）"""
    return bool(re.fullmatch(r"\d{6}", code)) and code[0] in "034689"


def look_through(holdings: pd.DataFrame, floating: bool):
    """逐只查询成份股十大股东，返回 (明细长表, 失败代码列表)"""
    rows, failed = [], []
    todo = holdings[holdings["股票代码"].map(is_a_share)]
    if ETF_MAX_STOCKS:
        todo = todo.head(ETF_MAX_STOCKS)
    n = len(todo)
    for i, (scode, sname, weight) in enumerate(
            zip(todo["股票代码"], todo["股票名称"], todo["占净值比例(%)"]), 1):
        print(f"\r  查询成份股十大股东 {i}/{n}：{scode} {sname}        ", end="")
        try:
            df, period, src = stock_holders(scode, floating)
            rows.append(df.assign(成份股代码=scode, 成份股名称=sname,
                                  成份股权重=weight, 报告期=period, 数据源=src))
        except Exception:                                        # noqa: BLE001
            failed.append(scode)
        time.sleep(PAUSE)
    print()
    return (pd.concat(rows, ignore_index=True) if rows else pd.DataFrame()), failed


def summarize(detail: pd.DataFrame, top: int = 30):
    """穿透汇总：同一股东出现在多少只成份股里，以及按 ETF 权重折算的间接持有比例"""
    d = detail.assign(穿透=detail["成份股权重"] * detail["持股比例(%)"] / 100)
    g = d.groupby("股东名称").agg(
        出现次数=("成份股代码", "nunique"),
        覆盖权重=("成份股权重", "sum"),
        穿透持有=("穿透", "sum"),
        平均持股比例=("持股比例(%)", "mean"),
        涉及成份股=("成份股名称", lambda x: "、".join(list(x)[:6]) + ("…" if len(x) > 6 else "")),
    ).sort_values(["出现次数", "穿透持有"], ascending=False).head(top).reset_index()
    g.columns = ["股东名称", "出现次数", "覆盖权重(%)", "穿透持有(%)", "平均持股比例(%)", "涉及成份股"]
    return g


# ------------------------- 展示 -------------------------
REPORT = []                              # 网页正文片段（按顺序）


def emit(obj):
    """同时输出到 notebook（若有）和 HTML 报告"""
    display(obj)
    if isinstance(getattr(obj, "data", None), pd.DataFrame):          # Styler
        REPORT.append(f'<div class="tbl">{obj.to_html()}</div>')
        return
    text = html.escape(str(getattr(obj, "data", obj)))
    if text.startswith("---\n## "):
        title = text[len("---\n## "):]
        REPORT.append(f'<h2 id="c{title.split()[0]}">{title}</h2>')
    else:
        REPORT.append("<p>" + re.sub(r"\*\*(.+?)\*\*", r"<b>\1</b>", text) + "</p>")


def bar_chart(df: pd.DataFrame, label_col: str, value_col: str, title: str):
    d = df.iloc[::-1]                    # 第 1 名画在最上面
    top = d[value_col].max()
    fig = go.Figure(go.Bar(
        x=d[value_col], y=d[label_col].astype(str).str.slice(0, 26), orientation="h",
        marker=dict(color=d[value_col], colorscale=[[0, "#c9d8f5"], [1, BAR]], cmin=0, cmax=top),
        text=d[value_col].map(lambda v: f"{v:.2f}%"), textposition="outside", cliponaxis=False,
        hovertemplate="%{y}<br>%{x:.2f}%<extra></extra>"))
    apply_style(fig, title, 90 + 32 * len(d), margin=dict(l=10, r=70, t=60, b=30), bargap=0.35)
    fig.update_xaxes(range=[0, top * 1.12], showgrid=True, gridcolor="#eef0f4", ticksuffix="%")
    fig.update_yaxes(showgrid=False, automargin=True)
    if HAVE_IPY:
        fig.show()
    REPORT.append(f'<div class="chart">{fig.to_html(full_html=False, include_plotlyjs="cdn" if not any("plotly" in r for r in REPORT) else False)}</div>')


def styled(df: pd.DataFrame):
    fmt = {c: "{:,.0f}" for c in df.columns if c.startswith(("持股数(股)", "持仓市值"))}
    fmt.update({c: "{:.2f}" for c in df.columns if "%" in c or c.startswith("持股数(万股)")})
    return df.style.format(fmt, na_rep="-").hide(axis="index")


def show_table(df: pd.DataFrame):
    emit(styled(df))


def common_holders(items):
    """items: [(代码, 简称, 表)]；返回出现在 >=2 只股票里的股东"""
    rows = []
    for code, name, df in items:
        for _, r in df.iterrows():
            rows.append((str(r["股东名称"]).strip(), f"{code} {name}", r["名次"], r["持股比例(%)"]))
    d = pd.DataFrame(rows, columns=["股东名称", "股票", "名次", "比例"])
    g = d.groupby("股东名称").filter(lambda x: x["股票"].nunique() >= 2)
    if g.empty:
        return g
    out = g.groupby("股东名称").apply(lambda x: pd.Series({
        "出现股票数": x["股票"].nunique(),
        "各股持股情况（名次 / 比例）": "；".join(
            f"{a} 第{int(b)}名 {c:.2f}%" for a, b, c in zip(x["股票"], x["名次"], x["比例"])),
    }), include_groups=False).reset_index()
    return out.sort_values(["出现股票数", "股东名称"], ascending=[False, True]).reset_index(drop=True)


CSS = PAGE_CSS


def write_report(codes, common: dict):
    nav = " ".join(f'<a href="#c{c}">{c}</a>' for c in codes)
    sec = ""
    for kind, tb in common.items():
        sec += f"<h3>{kind}：多只股票共同出现的股东</h3>"
        sec += (styled(tb).to_html() if len(tb) else "<p>没有相同股东。</p>")
    page = (f'<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
            f'<title>前十大股东</title><style>{CSS}</style><div class="page">'
            f'<h1>前十大股东汇总</h1><p>生成时间 {dt.datetime.now():%Y-%m-%d %H:%M}</p><nav>{nav}</nav>'
            f'<div class="common"><h2 style="border:0;margin-top:10px">相同股东</h2>'
            f'<p>注：“香港中央结算有限公司”是沪深港通名义持有人，汇总了众多港资投资者，并非单一股东。</p>{sec}</div>'
            + "".join(REPORT) + "</div>")
    path = Path(REPORT_HTML).resolve()
    path.write_text(page, encoding="utf-8")
    print(f"\n已生成网页报告：{path}")
    if OPEN_REPORT:
        webbrowser.open(path.as_uri())


def query(codes=CODES):
    if isinstance(codes, str):
        codes = re.findall(r"\d{6}", codes)
    codes = list(dict.fromkeys(codes))   # 去重并保持顺序
    if not codes:
        raise ValueError("没有识别到 6 位证券代码")

    collected, stock_tables = [], []
    REPORT.clear()

    def keep(df, code, name, kind, period, source):
        collected.append(df.assign(代码=code, 简称=name, 类别=kind, 报告期=period, 数据源=source))

    for code in codes:
        name = get_name(code)
        emit(Markdown(f"---\n## {code} {name}"))

        if is_fund(code):
            kind = "十大流通股东" if ETF_FLOAT else "十大股东"
            try:
                hold, period, is_full = etf_holdings(code)
            except Exception as ex:                              # noqa: BLE001
                print(f"[失败] {code} 成份股：{type(ex).__name__} {ex}")
                continue
            note = "完整持仓" if is_full else "⚠️ 只取到前十大重仓股（该基金近两年没有披露完整持仓的报告期）"
            emit(Markdown(f"**成份股**｜{period}｜共 {len(hold)} 只｜{note}｜"
                             f"合计占净值 {hold['占净值比例(%)'].sum():.2f}%"))
            show_table(hold.head(20))
            if len(hold) > 20:
                print(f"（仅显示权重前 20 只，其余 {len(hold) - 20} 只见 CSV）")

            detail, failed = look_through(hold, ETF_FLOAT)
            skipped = int((~hold["股票代码"].map(is_a_share)).sum())
            if skipped:
                print(f"[提示] {skipped} 只非 A 股成份股已跳过")
            if failed:
                print(f"[提示] {len(failed)} 只成份股查询失败：{'、'.join(failed[:20])}")
            if detail.empty:
                continue

            summ = summarize(detail)
            emit(Markdown(f"**穿透汇总：出现次数最多的{kind}**（已查 {detail['成份股代码'].nunique()} 只成份股）"))
            show_table(summ)
            bar_chart(summ.head(15), "股东名称", "穿透持有(%)", f"{code} {name} 穿透持有比例前 15")

            for scode in hold["股票代码"].head(ETF_SHOW_TABLES):
                d = detail[detail["成份股代码"] == scode]
                if d.empty:
                    continue
                emit(Markdown(f"**{scode} {d['成份股名称'].iloc[0]}**｜权重 {d['成份股权重'].iloc[0]:.2f}%｜"
                                 f"{kind}｜报告期 {d['报告期'].iloc[0]}｜数据源：{d['数据源'].iloc[0]}"))
                show_table(d[["名次", "股东名称", "性质", "持股数(股)", "持股比例(%)", "较上期增减"]])
            collected.append(detail.assign(代码=code, 简称=name, 类别=f"ETF成份股{kind}"))
            continue

        for floating in ([False, True] if SHOW_FLOAT else [False]):
            kind = "十大流通股东" if floating else "十大股东"
            try:
                df, period, src = stock_holders(code, floating)
            except Exception as ex:                              # noqa: BLE001
                print(f"[失败] {code} {kind}：{type(ex).__name__} {ex}")
                continue
            emit(Markdown(f"**{kind}**｜报告期 {period}｜数据源：{src}｜"
                             f"前十合计 {df['持股比例(%)'].sum():.2f}%"))
            show_table(df)
            bar_chart(df, "股东名称", "持股比例(%)", f"{code} {name} {kind}")
            keep(df, code, name, kind, period, src)
            stock_tables.append((kind, code, name, df))

    result = pd.concat(collected, ignore_index=True) if collected else pd.DataFrame()
    if REPORT_HTML and REPORT:
        common = {}
        for kind in dict.fromkeys(k for k, *_ in stock_tables):
            common[kind] = common_holders([(c, n, d) for k, c, n, d in stock_tables if k == kind])
        for kind, tb in common.items():          # 终端 / notebook 也打印一份
            if len(tb):
                print(f"\n【{kind}】相同股东：")
                print(tb.to_string(index=False))
        write_report(codes, common)
    if SAVE_CSV and len(result):
        result.to_csv("top10_holders.csv", index=False, encoding="utf-8-sig")
        print("\n已保存 top10_holders.csv（Colab 左侧文件栏可下载）")
    return result


result = query()
