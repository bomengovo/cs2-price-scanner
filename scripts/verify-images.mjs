const base = process.argv[2] || "http://127.0.0.1:3000";
const limit = Math.max(1, Math.min(200, Number(process.argv[3] || 50)));
const payload = await fetch(`${base}/api/results`, { signal: AbortSignal.timeout(10_000) }).then((response) => response.json());
const items = (payload.results || []).slice(0, limit);
const stats = { tested: items.length, primarySuccess: 0, fallbackSuccess: 0, placeholder: 0, http200: 0, http403: 0, http404: 0, other: 0 };
let cursor = 0;
await Promise.all(Array.from({ length: 5 }, async () => {
  while (cursor < items.length) {
    const item = items[cursor++];
    const rawCandidates = [...new Set([...(item.imageUrls || []), item.iconUrl].filter(Boolean))];
    const candidates = [...new Set(rawCandidates.flatMap((url) => [url, String(url).includes("community.cloudflare.steamstatic.com") ? String(url).replace("community.cloudflare.steamstatic.com", "community.akamai.steamstatic.com") : null].filter(Boolean)))];
    let loaded = false;
    for (let index = 0; index < candidates.length; index += 1) {
      try {
        const response = await fetch(candidates[index], { headers: { Range: "bytes=0-1023" }, signal: AbortSignal.timeout(10_000) });
        if (response.status === 200 || response.status === 206) { stats.http200 += 1; if (index === 0) stats.primarySuccess += 1; else stats.fallbackSuccess += 1; loaded = true; break; }
        if (response.status === 403) stats.http403 += 1; else if (response.status === 404) stats.http404 += 1; else stats.other += 1;
      } catch { stats.other += 1; }
    }
    if (!loaded) stats.placeholder += 1;
  }
}));
console.log(JSON.stringify(stats));
if (!items.length) process.exitCode = 1;
