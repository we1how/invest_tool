// Plotly 统一样式（对应 chart_style.py）。Plotly 体积大，用到时才加载。
const FONT = '-apple-system, "PingFang SC", "Microsoft YaHei", "Helvetica Neue", sans-serif';
const INK = "#1f2937", MUTED = "#6b7280", GRID = "#eef0f4", AXIS = "#d1d5db";

export const COLOR = {
  red: "#e04b4b", green: "#2ca470", blue: "#3b6fd4", orange: "#f0a020", grey: "#8a8f98", purple: "#7a5cc9",
};
export const PALETTE = ["#3b6fd4", "#e04b4b", "#2ca470", "#f0a020", "#8a5cc2", "#17a2b8", "#d6609b", "#7f8c8d"];

type Dict = Record<string, unknown>;

const xStyle: Dict = {
  showgrid: false, linecolor: AXIS, ticks: "outside", tickcolor: AXIS, zeroline: false,
  showspikes: true, spikemode: "across", spikethickness: 1, spikecolor: "#c4c8d0", spikedash: "dot",
};
const yStyle: Dict = { gridcolor: GRID, zeroline: false, automargin: true };

export async function plot(target: HTMLElement, traces: Dict[], layout: Dict): Promise<void> {
  const Plotly = (await import("plotly.js-basic-dist-min")).default;
  await Plotly.newPlot(target, traces, {
    paper_bgcolor: "white", plot_bgcolor: "white",
    font: { family: FONT, size: 12, color: INK },
    margin: { l: 52, r: 16, t: 56, b: 40 },
    legend: { orientation: "h", x: 0, y: 1, yanchor: "bottom", bgcolor: "rgba(0,0,0,0)" },
    hoverlabel: { bgcolor: "white", bordercolor: AXIS, font: { family: FONT, size: 12 } },
    ...layout,
  }, { responsive: true, displaylogo: false, modeBarButtonsToRemove: ["lasso2d", "select2d", "autoScale2d"] });
}

export interface Grid {
  layout: Dict;
  shapes: Dict[];
  /** 第 i 个子图（从 0 起）的坐标轴引用 */
  axes(i: number): { xaxis: string; yaxis: string };
  /** 第 i 个子图的 x 轴配置（可直接改） */
  xaxis(i: number): Dict;
  vline(i: number, x: number): void;
  hline(i: number, y: number, color?: string): void;
  vrect(i: number, x0: number, x1: number): void;
}

/** 手工排子图（plotly.js 没有 make_subplots）：每个子图独立的 x / y 轴，标题放在子图左上角 */
export function grid(
  count: number, cols: number, titles: string[], rowPx: number, xExtra: Dict = {}, narrow = false,
): Grid {
  const rows = Math.ceil(count / cols);
  const top = 64, bottom = 40, gapPx = 62;
  const plotH = rows * rowPx + (rows - 1) * gapPx;
  const height = plotH + top + bottom;
  const vgap = gapPx / plotH, h = rowPx / plotH;
  const hgap = cols > 1 ? 0.055 : 0, w = (1 - hgap * (cols - 1)) / cols;

  const layout: Dict = { height, margin: { l: 52, r: 16, t: top, b: bottom }, hovermode: "x unified" };
  const annotations: Dict[] = [];
  const shapes: Dict[] = [];
  const suffix = (i: number) => (i === 0 ? "" : String(i + 1));

  for (let i = 0; i < count; i++) {
    const r = Math.floor(i / cols), c = i % cols, s = suffix(i);
    const x0 = c * (w + hgap), y1 = 1 - r * (h + vgap);
    layout[`xaxis${s}`] = { ...xStyle, ...xExtra, domain: [x0, x0 + w], anchor: `y${s}` };
    layout[`yaxis${s}`] = { ...yStyle, domain: [y1 - h, y1], anchor: `x${s}` };
    annotations.push({
      text: (narrow ? titles[i]?.split("｜")[0] : titles[i]) ?? "", xref: "paper", yref: "paper", x: x0, y: y1, xanchor: "left", yanchor: "bottom",
      yshift: 4, showarrow: false, font: { size: 13, color: MUTED },
    });
  }
  layout.annotations = annotations;
  layout.shapes = shapes;
  // 图例放在最上面，子图标题之上
  layout.legend = {
    orientation: "h", x: 0, y: 1 + 30 / plotH, yanchor: "bottom", bgcolor: "rgba(0,0,0,0)",
    ...(narrow ? { entrywidth: 128, font: { size: 11 } } : {}),     // 手机上固定条目宽度，排成两列
  };

  return {
    layout, shapes,
    axes: (i) => ({ xaxis: `x${suffix(i)}`, yaxis: `y${suffix(i)}` }),
    xaxis: (i) => layout[`xaxis${suffix(i)}`] as Dict,
    vline(i, x) {
      shapes.push({ type: "line", xref: `x${suffix(i)}`, yref: `y${suffix(i)} domain`, x0: x, x1: x, y0: 0, y1: 1,
                    line: { color: "#999", width: 1, dash: "dot" } });
    },
    hline(i, y, color = "#ccc") {
      shapes.push({ type: "line", xref: `x${suffix(i)} domain`, yref: `y${suffix(i)}`, x0: 0, x1: 1, y0: y, y1: y,
                    line: { color, width: 1 } });
    },
    vrect(i, x0, x1) {
      shapes.push({ type: "rect", xref: `x${suffix(i)}`, yref: `y${suffix(i)} domain`, x0, x1, y0: 0, y1: 1,
                    fillcolor: COLOR.blue, opacity: 0.05, line: { width: 0 }, layer: "below" });
    },
  };
}

/** 横向柱状图：第 1 名在最上面，颜色随数值深浅渐变 */
export async function barChart(target: HTMLElement, labels: string[], values: number[], unit = "%"): Promise<void> {
  const y = labels.map((s) => (s.length > 24 ? s.slice(0, 24) + "…" : s)).reverse();
  const x = [...values].reverse();
  const top = Math.max(...values, 0.01);
  await plot(target, [{
    type: "bar", orientation: "h", x, y,
    marker: { color: x, colorscale: [[0, "#c9d8f5"], [1, COLOR.blue]], cmin: 0, cmax: top },
    text: x.map((v) => v.toFixed(2) + unit), textposition: "outside", cliponaxis: false,
    hovertemplate: `%{y}<br>%{x:.2f}${unit}<extra></extra>`,
  }], {
    height: 50 + 30 * labels.length, bargap: 0.35, showlegend: false,
    margin: { l: 10, r: 64, t: 10, b: 30 },
    xaxis: { range: [0, top * 1.12], gridcolor: GRID, ticksuffix: unit, zeroline: false },
    yaxis: { automargin: true, type: "category" },
  });
}
