/** Stage B0.1 Route B: two read-only requests (one rank page + one good-id page). */
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";

const root = path.resolve(import.meta.dirname, "..");
const token = readToken();
const database = new Database(path.join(root, "data", "scanner.db"), { readonly: true });
const rank = await request("/api/v1/info/get_rank_list", { page_index: 1, page_size: 20, show_recently_price: false, filter: { "排序": ["成交量"] } });
await delay(1_100);
const goods = await request("/api/v1/info/get_good_id", { page_index: 1, page_size: 20 });

const rankRows = extractRows(rank.body).slice(0, 20).map(rankRow);
const goodRows = extractRows(goods.body).slice(0, 20).map(goodRow);
const goodById = new Map(goodRows.filter((row) => row.id != null).map((row) => [row.id, row]));
const mappings = rankRows.map((row) => {
  const good = row.id == null ? null : goodById.get(row.id) ?? null;
  const scanner = good?.marketHashName ? scannerRow(good.marketHashName) : null;
  return { ...row, good, idJoin: Boolean(good), nameConsistent: Boolean(good && row.name && good.name === row.name), scanner };
});
const confirmed = mappings.filter((row) => row.idJoin && row.nameConsistent && row.good?.marketHashName);
const turnoverPairs = confirmed.filter((row) => row.scanner?.stageATurnover != null && row.statistic != null).map((row) => [row.statistic, row.scanner.stageATurnover]);
const inventoryPairs = confirmed.filter((row) => row.scanner).map((row) => ({ marketHashName: row.good.marketHashName, rankBuffSell: row.buffSellNum, scannerBuffSell: row.scanner.buffSell, rankYyypSell: row.yyypSellNum, scannerYyypSell: row.scanner.youpinSell, rankBuffBuy: row.buffBuyNum, scannerBuffBuy: row.scanner.buffBuy, rankYyypBuy: row.yyypBuyNum, scannerYyypBuy: row.scanner.youpinBuy }));

print({
  probe: "csqaq-rank-mapping-stage-b01", token: "CONFIGURED", safeguards: { sqliteWrites: 0, csfloatCalls: 0, steamdtCalls: 0, retries: 0, requests: 2, rankPages: 1, maxRankRows: 20 },
  rank: summary(rank, rankRows), goodId: summary(goods, goodRows),
  mapping: { rankRows: rankRows.length, goodRows: goodRows.length, idJoins: mappings.filter((row) => row.idJoin).length, nameConsistentJoins: confirmed.length, marketHashNameComplete: confirmed.filter((row) => row.good.marketHashName).length, samples: confirmed.slice(0, 10).map((row) => ({ rankId: row.id, rankName: row.name, goodId: row.good.id, marketHashName: row.good.marketHashName })) },
  rankAnalysis: { rankNum: numericStats(rankRows.map((row) => row.rankNum)), rankNumStartsAtOne: rankRows.map((row) => row.rankNum).filter((value) => value != null).includes(1), rankNumUnique: unique(rankRows.map((row) => row.rankNum)), statistic: numericStats(rankRows.map((row) => row.statistic)), turnoverVsRankSpearman: spearman(rankRows.map((row) => row.statistic), rankRows.map((row) => row.rankNum)), statisticVsStageATurnover: correlationPair(turnoverPairs), },
  inventoryComparison: inventorySummary(inventoryPairs), mappings,
}, null, 2);
database.close();

async function request(endpoint, payload) {
  const startedAt = Date.now();
  try {
    const response = await fetch(`https://api.csqaq.com${endpoint}`, { method: "POST", headers: { ApiToken: token, Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20_000) });
    const body = await response.json().catch(() => ({}));
    return { endpoint, httpStatus: response.status, apiCode: number(record(body).code), message: safe(String(record(body).msg ?? "")), durationMs: Date.now() - startedAt, body };
  } catch (error) { return { endpoint, httpStatus: null, apiCode: null, message: safe(error instanceof Error ? error.message : "request failed"), durationMs: Date.now() - startedAt, body: {} }; }
}
function summary(response, rows) { return { endpoint: response.endpoint, httpStatus: response.httpStatus, apiCode: response.apiCode, message: response.message, durationMs: response.durationMs, rows: rows.length, itemKeys: [...new Set(rows.flatMap((row) => Object.keys(row)))].sort() }; }
function extractRows(body) { const data = record(record(body).data); const nested = data.data ?? data.rows ?? data.list ?? []; return Array.isArray(nested) ? nested : Object.values(record(nested)); }
function rankRow(value) { const row = record(value); return { id: number(row.id), name: text(row.name), rankNum: number(row.rank_num ?? row.rankNum), rankNumChange: number(row.rank_num_change ?? row.rankNumChange), statistic: number(row.statistic), buffSellNum: number(row.buff_sell_num ?? row.buffSellNum), yyypSellNum: number(row.yyyp_sell_num ?? row.yyypSellNum), buffBuyNum: number(row.buff_buy_num ?? row.buffBuyNum), yyypBuyNum: number(row.yyyp_buy_num ?? row.yyypBuyNum), createdAt: text(row.created_at ?? row.createdAt) }; }
function goodRow(value) { const row = record(value); return { id: number(row.id), name: text(row.name), marketHashName: text(row.market_hash_name ?? row.marketHashName) }; }
function scannerRow(name) { const row = database.prepare(`SELECT r.result_json AS resultJson, m.turnover_number AS turnover FROM scan_results r LEFT JOIN csqaq_item_metadata m ON m.market_hash_name=r.market_hash_name WHERE r.market_hash_name=? AND r.is_deleted=0`).get(name); if (!row) return null; const result = record(JSON.parse(row.resultJson)); return { stageATurnover: number(row.turnover), buffSell: number(record(result.buff).sellCount), youpinSell: number(record(result.youpin).sellCount), buffBuy: number(record(result.buff).bidCount), youpinBuy: number(record(result.youpin).bidCount) }; }
function numericStats(values) { const valid = values.filter((value) => value != null).sort((a,b) => a-b); if (!valid.length) return { count: 0, zeroCount: 0, nullCount: values.length, min: null, median: null, p90: null, max: null }; const percentile = (q) => valid[Math.min(valid.length - 1, Math.floor((valid.length - 1) * q))]; return { count: valid.length, zeroCount: valid.filter((value) => value === 0).length, nullCount: values.length - valid.length, min: valid[0], median: percentile(.5), p90: percentile(.9), max: valid.at(-1) }; }
function unique(values) { const valid=values.filter((value) => value != null); return { count: valid.length, unique: new Set(valid).size }; }
function spearman(left, right) { const pairs=left.map((value,index)=>[value,right[index]]).filter(([a,b])=>a!=null&&b!=null); if(pairs.length<3)return null; return pearson(rankValues(pairs.map(([a])=>a)),rankValues(pairs.map(([,b])=>b))); }
function correlationPair(pairs) { if (pairs.length < 3) return { count: pairs.length, pearson: null, spearman: null }; const [left,right]=[pairs.map(([a])=>a),pairs.map(([,b])=>b)]; return { count:pairs.length, pearson:pearson(left,right), spearman:spearman(left,right) }; }
function pearson(a,b) { const ma=a.reduce((x,y)=>x+y,0)/a.length, mb=b.reduce((x,y)=>x+y,0)/b.length; const numerator=a.reduce((sum,x,i)=>sum+(x-ma)*(b[i]-mb),0); const denominator=Math.sqrt(a.reduce((sum,x)=>sum+(x-ma)**2,0)*b.reduce((sum,x)=>sum+(x-mb)**2,0)); return denominator ? Number((numerator/denominator).toFixed(6)) : null; }
function rankValues(values) { return values.map((value) => 1 + values.filter((other) => other < value).length + (values.filter((other) => other === value).length - 1) / 2); }
function inventorySummary(rows) { const pairs = [["buffSell","rankBuffSell","scannerBuffSell"],["youpinSell","rankYyypSell","scannerYyypSell"],["buffBuy","rankBuffBuy","scannerBuffBuy"],["youpinBuy","rankYyypBuy","scannerYyypBuy"]]; return { samples: rows.slice(0,10), metrics: Object.fromEntries(pairs.map(([label,a,b]) => { const values=rows.filter((row)=>row[a]!=null&&row[b]!=null); const deltas=values.map((row)=>Math.abs(row[a]-row[b])).sort((x,y)=>x-y); return [label,{count:values.length,exactMatchRate:values.length?values.filter((row)=>row[a]===row[b]).length/values.length:null,medianAbsoluteDifference:deltas.length?deltas[Math.floor((deltas.length-1)/2)]:null}]; })) }; }
function readToken() { const content=fs.readFileSync(path.join(root,".env.local"),"utf8"); const match=content.match(/(?:^|[^A-Za-z0-9_])CSQAQ_API_TOKEN\s*=\s*([^\s`#]+)/m); if(!match?.[1]?.trim())throw new Error("CSQAQ_API_TOKEN is not configured"); return match[1].trim(); }
function record(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function number(value) { const result=Number(value); return Number.isFinite(result)?result:null; }
function text(value) { const result=String(value??"").trim(); return result||null; }
function safe(value) { return value.replaceAll(token,"[REDACTED]").slice(0,300); }
function delay(ms) { return new Promise((resolve)=>setTimeout(resolve,ms)); }
function print(value) { process.stdout.write(`${JSON.stringify(value)}\n`); }
