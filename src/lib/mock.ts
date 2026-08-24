import { normalizeCsfloatImageUrl } from "./items";
import type { CSFloatListing, PlatformPrice } from "./types";
import { getCsfloatMarketUrl } from "./platform-links";

export const mockImageByMarketHashName = new Map<string, string>([
  ["AK-47 | Redline (Field-Tested)", "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyLwlcK3wiFO0POlPPNSI_-RHGavzedxuPUnFniykEtzsWWBzoyuIiifaAchDZUjTOZe4RC_w4buM-6z7wzbgokUyzK-0H08hRGDMA"],
  ["AWP | Asiimov (Field-Tested)", "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyLwiYbf_jdk7uW-V6V-Kf2cGFidxOp_pewnF3nhxEt0sGnSzN76dH3GOg9xC8FyEORftRe-x9PuYurq71bW3d8UnjK-0H0YSTpMGQ"],
  ["M4A1-S | Printstream (Minimal Wear)", "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL8ypexwjFS4_ega6F_H_OGMWrEwL9lj_F7Rienhgk1tjyIpYPwJiPTcAAoCpsiEO5ZsUbpm9C2Zuni4VHW3o5EzSX62HxP7Sg96-hWVqYi_6TJz1aW0nxrkGs"],
  ["StatTrak™ AK-47 | Slate (Minimal Wear)", "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyLwlcK3wiVI0POlPPNSMOKcCGKD0ud5vuBlcCW6khUz_W3Sytb4cCqTOFUpWJtzTOUD5hPsw9a0Yrnrs1SK3ooXzy6shilM5311o7FVYrIufmI"],
  ["Souvenir M4A4 | Radiation Hazard (Field-Tested)", "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL8ypexwjFL0Py7Y6F-NOKaHmKvzvx3vuZscCW6khUz_WqGyI34dy6SbgcnWMN2QLNZu0GxkNznMbjn5lbbgtlGyCuviyJNu311o7FVcM-jMdQ"],
  ["Glock-18 | Water Elemental (Factory New)", "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL2kpnj9h1Y-s2pZKtuK72fB3aFxP11te99cCW6khUz_TjVyompc3-QOFR2DJQkFOMJtBbqk9LlY-7n5QLZjtkTxCWqhixPv311o7FVIf8eASQ"],
  ["USP-S | Kill Confirmed (Battle-Scarred)", "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyLkjYbf7itX6vytbbZSI-WsG3SA_uV_vO1WTCa9kxQ1vjiBpYPwJiPTcFB2Xpp5TO5cskG9lYCxZu_jsVCL3o4Xnij23ClO5ik9tegFA_It8qHJz1aWe-uc160"],
  ["MAC-10 | Neon Rider (Minimal Wear)", "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL8n5WxrR1Y-s2jaac8cM-dC2ie0-dytfNWQyC0nQlp5DzTntmgdC7COABxX5NxQrUOtUS5w4LgMu6zsVCK2IJCmyisjitM6DErvbicsEA0SQ"],
  ["Nova | Hyper Beast (Factory New)", "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL_kYDhwiFO0PyhfqVSKOmDC3WSxO9lpN5lRi67gVMhsGrTmd2seH6XbA4pDZR1EbMCtES8m4fiNenl4FDcid1Az32ri3tM8G81tMCTwFwB"],
  ["M249 | Downtown (Factory New)", "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL8zMK5wiFO0P_8PP1SJP-EAHGf1etJvOhuRz39wUh-5GuGz4mrJHuSbg4jWJp1FLINsRCxwdDuZezm7leK3d5GmSr_jTQJsHj3YwoNRA"],
  ["★ Karambit | Doppler (Factory New)", "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Dx60noTyL6kJ_m-B1Q7uCvZaZkNM-SA1iSze91u_FsTju_qhAmoT-Jn4bjJC_4Ml93UtZuRLQPsBawkNfiMbnl5AKMiopCnin7iCJBv31j4rkBBKEg-6zUjV3GY6p9v8dpLWT3Fg"],
  ["★ Sport Gloves | Vice (Field-Tested)", "https://community.akamai.steamstatic.com/economy/image/i0CoZ81Ui0m-9KwlBY1L_18myuGuq1wfhWSaZgMttyVfPaERSR0Wqmu7LAocGIGz3UqlXOLrxM-vMGmW8VNxu5Tk5UvzWCL2kpn2-DFk_OKherB0H_KfG2Kv0ed4u95lRi67gVNx4T-Bw434IHyVb1QlAsd1FOUDthG4xNznMu3m4QXXg90Wzn_33C1I8G81tLaDi_rK"],
]);

const seed = [
  ["AK-47 | Redline (Field-Tested)", "AK-47 | Redline", "AK-47｜红线", "Field-Tested", 2380, 0.2245, false, false],
  ["AWP | Asiimov (Field-Tested)", "AWP | Asiimov", "AWP｜二西莫夫", "Field-Tested", 11250, 0.2841, false, false],
  ["M4A1-S | Printstream (Minimal Wear)", "M4A1-S | Printstream", "M4A1-S｜印花集", "Minimal Wear", 14500, 0.1021, false, false],
  ["StatTrak™ AK-47 | Slate (Minimal Wear)", "AK-47 | Slate", "StatTrak™ AK-47｜墨岩", "Minimal Wear", 3250, 0.0987, true, false],
  ["Souvenir M4A4 | Radiation Hazard (Field-Tested)", "M4A4 | Radiation Hazard", "纪念品 M4A4｜辐射危机", "Field-Tested", 6900, 0.1912, false, true],
  ["Glock-18 | Water Elemental (Factory New)", "Glock-18 | Water Elemental", "Glock-18｜水灵", "Factory New", 1850, 0.0412, false, false],
  ["USP-S | Kill Confirmed (Battle-Scarred)", "USP-S | Kill Confirmed", "USP-S｜枪响人亡", "Battle-Scarred", 4250, 0.5122, false, false],
  ["MAC-10 | Neon Rider (Minimal Wear)", "MAC-10 | Neon Rider", "MAC-10｜霓虹骑士", "Minimal Wear", 980, 0.1034, false, false],
  ["Nova | Hyper Beast (Factory New)", "Nova | Hyper Beast", "Nova｜暴怒野兽", "Factory New", 825, 0.0321, false, false],
  ["M249 | Downtown (Factory New)", "M249 | Downtown", "M249｜闹市区", "Factory New", 245, 0.051, false, false],
  ["★ Karambit | Doppler (Factory New)", "★ Karambit | Doppler", "★ 爪子刀｜多普勒", "Factory New", 168000, 0.0198, false, false],
  ["★ Sport Gloves | Vice (Field-Tested)", "★ Sport Gloves | Vice", "★ 运动手套｜潘多拉魔盒", "Field-Tested", 248000, 0.2721, false, false],
] as const;

export const mockChineseNames: Map<string, string> = new Map(seed.map((row) => [row[0], row[2]]));

// SteamDT /open/cs2/v1/base 于 2026-08-07 返回的真实平台映射，仅用于 Mock 模式的跳转验收。
export const mockPlatformIds = new Map<string, { buff: string; youpin: string }>([
  ["AK-47 | Redline (Field-Tested)", { buff: "33960", youpin: "1414" }],
  ["AWP | Asiimov (Field-Tested)", { buff: "34066", youpin: "407" }],
  ["M4A1-S | Printstream (Minimal Wear)", { buff: "835800", youpin: "10102" }],
  ["Glock-18 | Water Elemental (Factory New)", { buff: "35072", youpin: "44258" }],
  ["USP-S | Kill Confirmed (Battle-Scarred)", { buff: "42180", youpin: "44375" }],
]);

export function mockListings(limit: number | "all"): CSFloatListing[] {
  const count = limit === "all" ? 120 : Math.max(1, limit);
  return Array.from({ length: count }, (_, index) => {
    const row = seed[index % seed.length];
    const duplicate = Math.floor(index / seed.length);
    return {
      id: `mock-${index + 1}`,
      marketHashName: row[0],
      itemName: row[1],
      wearName: row[3],
      price: row[4] + duplicate * 35,
      floatValue: Math.min(0.999, row[5] + duplicate * 0.0003),
      isStatTrak: row[6],
      isSouvenir: row[7],
      defIndex: 7 + (index % 40),
      paintIndex: 100 + index,
      paintSeed: 200 + index,
      iconUrl: normalizeCsfloatImageUrl(mockImageByMarketHashName.get(row[0])),
      inspectLink: `steam://rungame/730/mock/${index + 1}`,
      listingUrl: getCsfloatMarketUrl(row[0])!,
      createdAt: new Date(Date.now() - index * 90_000).toISOString(),
    };
  });
}

export function mockPrices(names: string[]): Map<string, PlatformPrice[]> {
  const map = new Map<string, PlatformPrice[]>();
  names.forEach((name, index) => {
    const listing = seed.find((row) => row[0] === name);
    const baseCny = listing ? (listing[4] / 100) * 7.2 : 100;
    const now = Date.now() - index * 15_000;
    const platformIds = mockPlatformIds.get(name);
    map.set(name, [
      { marketHashName: name, platform: "buff", rawPlatform: index % 2 ? "BUFF163" : "BUFF", platformItemId: platformIds?.buff ?? null, sellPrice: Math.round(baseCny * (1.08 + (index % 4) * 0.025) * 100) / 100, sellCount: 12 + index * 2, bidPrice: Math.round(baseCny * 0.96 * 100) / 100, bidCount: 3 + index, updatedAt: now, fetchedAt: now, source: "mock", status: "live" },
      ...(index % 5 === 4 ? [] : [{ marketHashName: name, platform: "youpin" as const, rawPlatform: index % 2 ? "YOUPIN" : "悠悠有品", platformItemId: platformIds?.youpin ?? null, sellPrice: Math.round(baseCny * (1.04 + (index % 3) * 0.035) * 100) / 100, sellCount: 8 + index, bidPrice: Math.round(baseCny * 0.94 * 100) / 100, bidCount: 2 + index, updatedAt: now }]),
    ]);
  });
  return map;
}
