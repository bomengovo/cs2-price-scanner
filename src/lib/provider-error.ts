export type ProviderName = "csfloat" | "csqaq" | "steamdt";

export class ProviderApiError extends Error {
  readonly timestamp = Date.now();
  constructor(
    public readonly provider: ProviderName,
    public readonly endpoint: string,
    public readonly httpStatus: number | null,
    public readonly errorCode: string | number | null,
    public readonly safeMessage: string,
    public readonly retryAfterMs: number | null = null,
  ) { super(safeMessage); this.name = "ProviderApiError"; }
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : null;
}
