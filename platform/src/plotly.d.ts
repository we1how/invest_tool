declare module "plotly.js-basic-dist-min" {
  const Plotly: {
    newPlot(
      el: HTMLElement,
      data: Record<string, unknown>[],
      layout?: Record<string, unknown>,
      config?: Record<string, unknown>,
    ): Promise<unknown>;
    purge(el: HTMLElement): void;
  };
  export default Plotly;
}
