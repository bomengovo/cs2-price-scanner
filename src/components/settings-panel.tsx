"use client";

import Link from "next/link";
import { ArrowLeft, CheckCircle2, Save, Shield, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import type { AppSettings } from "@/lib/types";

export default function SettingsPanel() {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [buffAliases, setBuffAliases] = useState("");
  const [youpinAliases, setYoupinAliases] = useState("");
  const [message, setMessage] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/settings", { cache: "no-store" }).then((response) => response.json()).then((value) => {
      setSettings(value);
      setBuffAliases(value.platformAliases.buff.join(", "));
      setYoupinAliases(value.platformAliases.youpin.join(", "));
    }).catch(() => setMessage("设置读取失败，请确认服务已正常启动。"));
  }, []);

  function update<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setSettings((current) => current ? { ...current, [key]: value } : current);
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setMessage("");
    const platformAliases = { buff: splitAliases(buffAliases), youpin: splitAliases(youpinAliases) };
    try {
      const response = await fetch("/api/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ usdCnyRate: settings.usdCnyRate, priceCacheMinutes: settings.priceCacheMinutes, volumeCacheSeconds: settings.volumeCacheSeconds, maxScanCount: settings.maxScanCount, maxSafePages: settings.maxSafePages, minDiff: settings.minDiff, minDiffPercent: settings.minDiffPercent, platformAliases, domesticProvider: settings.domesticProvider }) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || "保存失败");
      setSettings(value);
      setMessage("设置已保存到本地 SQLite。下一次扫描将使用新配置。");
    } catch (error) { setMessage(error instanceof Error ? error.message : "保存失败"); }
    finally { setSaving(false); }
  }

  return <main className="settings-shell">
    <header className="settings-header"><Link href="/"><ArrowLeft size={17} /> 返回扫描器</Link><div><h1>扫描器设置</h1><p>本地运行参数与平台适配规则</p></div></header>
    {!settings ? <div className="settings-loading">正在读取本地设置…</div> : <>
      <section className="key-status-grid">
        <KeyStatus label="CSQAQ API Token" configured={settings.csqaqApiConfigured} />
        <KeyStatus label="SteamDT API Key" configured={settings.steamdtApiConfigured} />
        <KeyStatus label="CSFloat API Key" configured={settings.csfloatApiConfigured} />
        <div className="key-card"><Shield size={20} /><div><b>密钥安全</b><span>本页仅显示配置状态，完整 Key 永不返回浏览器</span></div></div>
      </section>
      {settings.mockMode && <div className="notice warning">当前为 Mock 模式。填写 `.env.local` 后将 `MOCK_MODE=false`，重启即可使用真实 API。</div>}
      <section className="settings-section"><div className="section-heading"><span>01</span><div><h2>扫描与价格</h2><p>控制汇率、缓存时效和扫描安全边界。</p></div></div><div className="settings-grid">
        <label><b>国内数据源</b><select value={settings.domesticProvider} onChange={(event) => update("domesticProvider", event.target.value as AppSettings["domesticProvider"])}><option value="csqaq">CSQAQ（默认，整体失败时备用）</option><option value="auto">自动</option><option value="steamdt">SteamDT</option></select><small>不会因单件未匹配而逐条请求备用接口</small></label>
        <SettingsNumber label="美元人民币汇率" value={settings.usdCnyRate} step="0.0001" onChange={(value) => update("usdCnyRate", value)} help="用于把 CSFloat 美元价格换算成人民币" />
        <SettingsNumber label="SteamDT 缓存时间（分钟）" value={settings.priceCacheMinutes} onChange={(value) => update("priceCacheMinutes", value)} help="有效期内不会重复消耗价格接口额度" />
        <SettingsNumber label="成交量缓存时间（秒）" value={settings.volumeCacheSeconds} onChange={(value) => update("volumeCacheSeconds", value)} help="默认 300 秒；排序和筛选不会重复请求" />
        <SettingsNumber label="最大扫描数量" value={settings.maxScanCount} onChange={(value) => update("maxScanCount", value)} help="限制单次扫描可请求的最大 Listing 数" />
        <SettingsNumber label="最大安全页数" value={settings.maxSafePages} onChange={(value) => update("maxSafePages", value)} help="选择“全部”时仍会在该页数停止" />
        <SettingsNumber label="默认最低价差（¥）" value={settings.minDiff} step="0.01" onChange={(value) => update("minDiff", value)} />
        <SettingsNumber label="默认最低价差率（%）" value={settings.minDiffPercent} step="0.01" onChange={(value) => update("minDiffPercent", value)} />
      </div></section>
      <section className="settings-section"><div className="section-heading"><span>02</span><div><h2>平台 Alias</h2><p>忽略大小写并支持包含匹配；使用逗号或换行分隔。</p></div></div><div className="settings-grid two">
        <label><b>BUFF 平台别名</b><textarea value={buffAliases} onChange={(event) => setBuffAliases(event.target.value)} rows={4} /><small>例如：BUFF, buff163, 网易BUFF</small></label>
        <label><b>UU / 悠悠有品平台别名</b><textarea value={youpinAliases} onChange={(event) => setYoupinAliases(event.target.value)} rows={4} /><small>例如：UU, YOUPIN, 悠悠, 有品</small></label>
      </div></section>
      <section className="settings-section"><div className="section-heading"><span>03</span><div><h2>商品页跳转规则</h2><p>链接现已按平台固定安全格式生成，避免错误参数和平台 ID 串用。</p></div></div><div className="settings-grid two">
        <label><b>BUFF</b><input readOnly value="https://buff.163.com/goods/{goodsId}" /><small>goodsId 只取 SteamDT 的 BUFF 平台 itemId</small></label>
        <label><b>悠悠有品</b><input readOnly value="https://youpin898.com/market/goods-list?gameId=730&listType=10&templateId={templateId}" /><small>templateId 只取 SteamDT 的 YOUPIN 平台 itemId</small></label>
      </div></section>
      <div className="settings-savebar"><div>{message || "配置仅保存在当前电脑。API Key 请在 .env.local 中修改。"}</div><button onClick={save} disabled={saving}><Save size={17} /> {saving ? "正在保存" : "保存设置"}</button></div>
    </>}
  </main>;
}

function KeyStatus({ label, configured }: { label: string; configured: boolean }) { return <div className={`key-card ${configured ? "configured" : "missing"}`}>{configured ? <CheckCircle2 size={20} /> : <XCircle size={20} />}<div><b>{label}</b><span>{configured ? "已配置" : "未配置"}</span></div></div>; }
function SettingsNumber({ label, value, onChange, help, step = "1" }: { label: string; value: number; onChange: (value: number) => void; help?: string; step?: string }) { return <label><b>{label}</b><input type="number" min="0" step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} />{help && <small>{help}</small>}</label>; }
function splitAliases(value: string): string[] { return [...new Set(value.split(/[,，\n]/).map((item) => item.trim()).filter(Boolean))]; }
