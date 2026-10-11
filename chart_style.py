# 三个脚本共用的图表 / 网页样式，统一改这里即可
FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif'
INK, MUTED, GRID = "#1f2937", "#6b7280", "#eef0f4"

PAGE_CSS = f"""
:root{{--ink:{INK};--muted:{MUTED};--line:#e5e7eb;--accent:#3b6fd4}}
*{{box-sizing:border-box}}
body{{font-family:{FONT};margin:0;background:#f6f7fb;color:var(--ink);line-height:1.55}}
.page{{max-width:1180px;margin:0 auto;padding:28px 20px 60px}}
h1{{font-size:26px;margin:0 0 4px}}
h2{{font-size:20px;margin:40px 0 12px;padding-left:10px;border-left:4px solid var(--accent)}}
h3{{font-size:16px;margin:18px 0 6px}}
p{{margin:6px 0;font-size:14px}}
nav{{margin:12px 0 4px;display:flex;flex-wrap:wrap;gap:8px}}
nav a{{font-size:13px;padding:3px 12px;border-radius:999px;background:#fff;border:1px solid var(--line);
  color:var(--accent);text-decoration:none}}
nav a:hover{{background:var(--accent);color:#fff}}
.card,.chart,.tbl,.common{{background:#fff;border:1px solid var(--line);border-radius:10px;
  padding:12px 14px;margin:10px 0;box-shadow:0 1px 2px rgba(16,24,40,.04)}}
.tbl{{overflow-x:auto;padding:6px 10px}}
.common{{background:#fffaf0;border-color:#f3d79b}}
.note{{color:#b35c00;font-size:13px}}
table{{border-collapse:collapse;font-size:13px;width:100%}}
th{{background:#f3f6fc;color:var(--muted);font-weight:600;font-size:12px;white-space:nowrap}}
td,th{{padding:6px 10px;border-bottom:1px solid #f0f1f4;text-align:left}}
tbody tr:hover{{background:#f8faff}}
td:not(:first-child):not(:nth-child(2)){{font-variant-numeric:tabular-nums}}
"""


def apply_style(fig, title: str, height: int, **layout):
    """统一的 plotly 外观：左对齐标题、淡网格、无多余边框、悬浮提示卡片"""
    opts = dict(margin=dict(l=56, r=24, t=84, b=44))
    opts.update(layout)
    fig.update_layout(
        template="plotly_white", height=height, paper_bgcolor="white", plot_bgcolor="white",
        font=dict(family=FONT, size=12, color=INK),
        title=dict(text=title, x=0.01, xanchor="left", font=dict(size=16, color=INK)),
        legend=dict(orientation="h", x=0.01, y=1.0, yanchor="bottom", bgcolor="rgba(0,0,0,0)"),
        hoverlabel=dict(bgcolor="white", bordercolor="#d1d5db", font=dict(family=FONT, size=12)),
        **opts)
    fig.update_xaxes(showgrid=False, linecolor="#d1d5db", ticks="outside", tickcolor="#d1d5db",
                     showspikes=True, spikemode="across", spikethickness=1, spikecolor="#c4c8d0",
                     spikedash="dot")
    fig.update_yaxes(gridcolor=GRID, zeroline=False, ticks="", automargin=True)
    for a in fig.layout.annotations:                  # 子图标题：左对齐、灰色小字
        a.update(font=dict(size=13, color=MUTED), x=a.x - 0.0, xanchor="center")
    return fig
