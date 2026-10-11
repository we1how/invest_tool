/** 调 Worker 接口；失败时抛出带服务端错误信息的 Error */
export async function api<T>(path: string, params: Record<string, string | number>): Promise<T> {
  const query = new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)]));
  const res = await fetch(`/api/${path}?${query}`);
  const body: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = body && typeof body === "object" && "error" in body ? String(body.error) : `HTTP ${res.status}`;
    throw new Error(msg);
  }
  return body as T;
}

/** 限制并发地跑一批任务，结果顺序与输入一致；单个失败不影响其他 */
export async function pool<T, R>(
  items: T[], limit: number, fn: (item: T) => Promise<R>, onProgress?: (done: number) => void,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try {
        results[i] = { status: "fulfilled", value: await fn(items[i]) };
      } catch (reason) {
        results[i] = { status: "rejected", reason };
      }
      onProgress?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

export const errorText = (ex: unknown) => (ex instanceof Error ? ex.message : String(ex));
