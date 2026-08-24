export class ApiError extends Error {
  constructor(message: string, public readonly status = 500, public readonly retryAfterMs?: number) {
    super(message);
  }
}

export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  options: { retries?: number; timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Response> {
  const retries = options.retries ?? 3;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 12_000);
    const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
    try {
      const response = await fetch(url, { ...init, signal, cache: "no-store" });
      if (response.ok) return response;
      if (response.status === 401) throw new ApiError("API 密钥无效或未授权", 401);
      if (response.status === 429) {
        const raw = response.headers.get("retry-after");
        const seconds = Number(raw);
        const retryAfterMs = Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : raw ? Math.max(0, Date.parse(raw) - Date.now()) : undefined;
        throw new ApiError("API 请求过于频繁，请稍后重试", 429, retryAfterMs);
      }
      if (response.status >= 500 && attempt < retries) {
        await delay(600 * 2 ** attempt, options.signal);
        continue;
      }
      throw new ApiError(`远程服务请求失败（${response.status}）`, response.status);
    } catch (error) {
      if (error instanceof ApiError || options.signal?.aborted) throw error;
      if (attempt >= retries) {
        const isTimeout = error instanceof DOMException && error.name === "TimeoutError";
        throw new ApiError(isTimeout ? "网络请求超时" : "网络连接失败");
      }
      await delay(600 * 2 ** attempt, options.signal);
    }
  }
  throw new ApiError("请求失败");
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true });
  });
}
