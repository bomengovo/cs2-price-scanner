export type VolumePlatform = "buff" | "youpin";

export interface DailyVolumeResult {
  marketHashName: string;
  platform: VolumePlatform;
  goodId?: number | null;
  volume: number | null;
  date: string;
  source: string;
  fetchedAt: number;
  status?: "live" | "cache" | "stale" | "unavailable";
}

export interface VolumeLookupItem {
  marketHashName: string;
  csqaqGoodId?: number | null;
  buffGoodsId: string | null;
  youpinTemplateId: string | null;
}

export interface ShanghaiDayRange {
  date: string;
  startMs: number;
  endMs: number;
  start: Date;
  end: Date;
}

export function getShanghaiDayRange(now = new Date()): ShanghaiDayRange {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((part) => part.type === type)?.value);
  const year = value("year");
  const month = value("month");
  const day = value("day");
  const startMs = Date.UTC(year, month - 1, day) - 8 * 60 * 60 * 1000;
  const endMs = Date.UTC(year, month - 1, day + 1) - 8 * 60 * 60 * 1000;
  return {
    date: `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`,
    startMs,
    endMs,
    start: new Date(startMs),
    end: new Date(endMs),
  };
}

export function unavailableVolume(marketHashName: string, platform: VolumePlatform, source: string, now = new Date()): DailyVolumeResult {
  return { marketHashName, platform, volume: null, date: getShanghaiDayRange(now).date, source, fetchedAt: Date.now() };
}
