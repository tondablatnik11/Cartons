"use client";

import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, Legend, Area, AreaChart, Cell,
} from "recharts";
import * as XLSX from "xlsx";
import {
  fetchCartons, fetchStock, fetchSapConsumption, fetchChangeLog,
  updateStock, addChangeLog, upsertSapData, bulkUpdateStock,
} from "@/lib/supabase";

// ── Constants ──
const LOW = 1.5;
const CRIT = 0.75;
const sColor = (m: number) => (m <= CRIT ? "#ff4d6a" : m <= LOW ? "#ffb020" : "#00e5a0");
const sLabel = (m: number) => (m <= CRIT ? "KRITICKÝ" : m <= LOW ? "NÍZKÝ" : "OK");
const fDate = (d: Date) => `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()}`;
const avgOf = (h: Record<string, number>) => {
  const v = Object.values(h);
  return v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0;
};

type Carton = { id: string; dim: string; pcs_per_pallet: number | null; article_num: string };
type LogEntry = { id: number; carton_id: string; delta: number; note: string; created_at: string };

const chartColors = ["#6391ff", "#b18cff", "#ffb020", "#00e5a0", "#ff4d6a", "#ec4899", "#22d3ee", "#f97316", "#6366f1", "#84cc16", "#e879f9", "#a3e635"];

export default function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [cartons, setCartons] = useState<Carton[]>([]);
  const [stockMap, setStockMap] = useState<Record<string, number>>({});
  const [sapHistory, setSapHistory] = useState<Record<string, Record<string, number>>>({});
  const [logEntries, setLogEntries] = useState<LogEntry[]>([]);
  const [tab, setTab] = useState("overview");
  const [bulkMode, setBulkMode] = useState(false);
  const [bulkVals, setBulkVals] = useState<Record<string, string>>({});
  const [selId, setSelId] = useState<string | null>(null);
  const [adjQ, setAdjQ] = useState(1);
  const [thresh, setThresh] = useState(LOW);
  const [toast, setToast] = useState<{ msg: string; type: string } | null>(null);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const fRef = useRef<HTMLInputElement>(null);

  // ── Load data from Supabase ──
  const loadAll = useCallback(async () => {
    try {
      const [c, s, sap, log] = await Promise.all([
        fetchCartons(), fetchStock(), fetchSapConsumption(), fetchChangeLog(),
      ]);
      setCartons(c || []);
      setStockMap(s || {});
      setSapHistory(sap || {});
      setLogEntries(log || []);
    } catch (e) {
      console.error("Load error:", e);
    }
    setLoading(false);
  }, []);

  useEffect(() => { loadAll(); }, [loadAll]);

  const notify = useCallback((msg: string, type = "info") => {
    setToast({ msg, type });
    setTimeout(() => setToast(null), 3000);
  }, []);

  // ── Enriched data ──
  const enriched = useMemo(() => cartons.map((c) => {
    const stock = stockMap[c.id] ?? 0;
    const avgPcs = Math.round(avgOf(sapHistory[c.id] || {}));
    const avgPal = c.pcs_per_pallet ? avgPcs / c.pcs_per_pallet : 0;
    const ml = avgPal > 0 ? stock / avgPal : Infinity;
    const dep = new Date(); dep.setDate(dep.getDate() + ml * 30.4);
    const reorder = Math.max(0, Math.ceil(avgPal * 3 - stock));
    const fc = [];
    for (let m = 0; m <= 6; m++) {
      const d = new Date(); d.setMonth(d.getMonth() + m);
      fc.push({ label: `${d.getMonth() + 1}/${d.getFullYear()}`, stock: Math.max(0, Math.round((stock - avgPal * m) * 10) / 10) });
    }
    return { ...c, stock, avgPcs, avgPal: Math.round(avgPal * 100) / 100, ml, dep, reorder, fc };
  }), [cartons, stockMap, sapHistory]);

  const alerts = useMemo(() => enriched.filter((i) => i.ml <= thresh && i.ml !== Infinity).sort((a, b) => a.ml - b.ml), [enriched, thresh]);
  const totalStock = useMemo(() => enriched.reduce((s, i) => s + i.stock, 0), [enriched]);
  const allMonths = useMemo(() => {
    const s = new Set<string>();
    Object.values(sapHistory).forEach((h) => Object.keys(h).forEach((k) => s.add(k)));
    return [...s].sort();
  }, [sapHistory]);
  const coreMonths = useMemo(() => allMonths.filter((m) => { const [y, mo] = m.split("-").map(Number); return y === 2025 && mo >= 7 && mo <= 11; }), [allMonths]);

  // ── Stock adjustment ──
  async function doAdjust(id: string, delta: number) {
    const prev = stockMap[id] ?? 0;
    const next = Math.max(0, prev + delta);
    setStockMap((p) => ({ ...p, [id]: next }));
    setSaving(true);
    try {
      await Promise.all([updateStock(id, next), addChangeLog(id, delta)]);
      const log = await fetchChangeLog();
      setLogEntries(log || []);
      notify(`${id}: ${delta > 0 ? "+" : ""}${delta} palet`, delta > 0 ? "ok" : "warn");
    } catch (e) {
      setStockMap((p) => ({ ...p, [id]: prev }));
      notify("Chyba při ukládání!", "warn");
    }
    setSaving(false);
  }

  async function doBulk() {
    const updates: { carton_id: string; current_stock: number }[] = [];
    const logItems: { carton_id: string; delta: number }[] = [];
    for (const c of cartons) {
      const v = bulkVals[c.id];
      if (v === undefined || v === "") continue;
      const nv = Math.max(0, Number(v));
      const prev = stockMap[c.id] ?? 0;
      if (nv !== prev) {
        updates.push({ carton_id: c.id, current_stock: nv });
        logItems.push({ carton_id: c.id, delta: nv - prev });
      }
    }
    if (!updates.length) return;
    setSaving(true);
    try {
      await bulkUpdateStock(updates);
      for (const l of logItems) await addChangeLog(l.carton_id, l.delta, "Hromadná aktualizace");
      await loadAll();
      notify(`Aktualizováno: ${updates.length} kartonů`, "ok");
    } catch (e) {
      notify("Chyba!", "warn");
    }
    setBulkMode(false); setBulkVals({}); setSaving(false);
  }

  // ── SAP upload ──
  async function handleUpload(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploadMsg("Zpracovávám...");
    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab, { cellDates: true });
      const rows = XLSX.utils.sheet_to_json<any>(wb.Sheets[wb.SheetNames[0]]);
      const cr = rows.filter((r: any) => String(r.Material || "").startsWith("CARTON-"));
      if (!cr.length) { setUploadMsg("⚠ Žádné CARTON záznamy"); setTimeout(() => setUploadMsg(null), 4000); return; }

      const agg: Record<string, Record<string, number>> = {};
      cr.forEach((r: any) => {
        const mat = r.Material;
        const dv = r["Material Avail. Date"] || r["Created On"];
        if (!dv) return;
        const d = new Date(dv);
        if (isNaN(d.getTime())) return;
        const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
        if (!agg[mat]) agg[mat] = {};
        agg[mat][k] = (agg[mat][k] || 0) + (Number(r["Delivery quantity"]) || 0);
      });

      const upsertRows: { carton_id: string; month: string; quantity: number }[] = [];
      for (const [mat, months] of Object.entries(agg)) {
        for (const [month, qty] of Object.entries(months)) {
          upsertRows.push({ carton_id: mat, month, quantity: qty });
        }
      }
      await upsertSapData(upsertRows);
      await loadAll();
      const mc = Object.keys(agg).length;
      setUploadMsg(`✓ ${cr.length} řádků · ${mc} kartonů`);
      notify("SAP data aktualizována", "ok");
      setTimeout(() => setUploadMsg(null), 5000);
    } catch (err: any) {
      setUploadMsg(`✕ ${err.message}`);
      setTimeout(() => setUploadMsg(null), 5000);
    }
    if (fRef.current) fRef.current.value = "";
  }

  // ── Tab definitions ──
  const tabDefs = [
    { k: "overview", l: "Přehled", i: "◫" },
    { k: "adjust", l: "Stav Skladu", i: "±" },
    { k: "prediction", l: "Predikce", i: "◇" },
    { k: "sap", l: "SAP Data", i: "↑" },
    { k: "alerts", l: `Alarmy${alerts.length ? ` (${alerts.length})` : ""}`, i: "△" },
    { k: "log", l: "Historie", i: "≡" },
  ];

  // ── Glassmorphism Styling Constants for Recharts ──
  const glassTooltipStyle = {
    backgroundColor: 'rgba(14, 18, 37, 0.7)',
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid rgba(255, 255, 255, 0.1)',
    borderRadius: '16px',
    color: '#d4daf0',
    fontSize: '12px',
    boxShadow: '0 10px 30px rgba(0,0,0,0.5)',
    padding: '12px'
  };

  if (loading) return (
    <div className="min-h-screen bg-[#040509] flex items-center justify-center font-sans">
      <div className="relative">
        <div className="absolute inset-0 bg-accent/20 blur-3xl rounded-full animate-pulse"></div>
        <div className="relative z-10 text-center text-accent">
          <div className="text-5xl mb-4 animate-bounce">◎</div>
          <div className="text-sm font-semibold tracking-widest uppercase">Inicializace Systému...</div>
        </div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen font-sans selection:bg-accent/30 pb-20 relative text-gray-200">
      
      {/* ── AMBIENT GLASSMORPHISM BACKGROUND ── */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none z-0">
        <div className="absolute top-[-10%] left-[-10%] w-[500px] h-[500px] rounded-full bg-accent/20 blur-[120px] animate-blob" />
        <div className="absolute top-[20%] right-[-10%] w-[400px] h-[400px] rounded-full bg-purple/20 blur-[120px] animate-blob animation-delay-2000" />
        <div className="absolute bottom-[-20%] left-[20%] w-[600px] h-[600px] rounded-full bg-success/10 blur-[150px] animate-blob animation-delay-4000" />
      </div>

      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-6 right-6 px-6 py-3 rounded-2xl text-sm font-bold shadow-2xl z-50 transition-all duration-300 transform translate-y-0 opacity-100 backdrop-blur-md border ${
          toast.type === "ok" ? "bg-success/20 text-success border-success/30" : toast.type === "warn" ? "bg-warning/20 text-warning border-warning/30" : "bg-accent/20 text-accent border-accent/30"
        }`}>
          {toast.msg}
        </div>
      )}

      {saving && (
        <div className="fixed top-0 left-0 right-0 h-1 bg-gradient-to-r from-accent via-purple to-accent z-50 animate-pulse bg-[length:200%_200%]" />
      )}

      {/* ── HEADER (Glass) ── */}
      <header className="relative z-40 bg-[#06080f]/50 backdrop-blur-2xl border-b border-white/[0.08] px-8 py-5 sticky top-0 shadow-[0_4px_30px_rgba(0,0,0,0.1)]">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4 group">
            <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-accent/80 to-purple/80 backdrop-blur-sm border border-white/20 flex items-center justify-center text-xl font-black text-white shadow-[0_0_20px_rgba(99,145,255,0.4)] group-hover:scale-105 transition-transform duration-300">
              K
            </div>
            <div>
              <h1 className="text-2xl font-black text-white tracking-tight leading-none mb-1 drop-shadow-md">Kartony Bor</h1>
              <p className="text-xs text-dim font-bold tracking-widest uppercase">WH 8496 · SAP WM Control Tower</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {alerts.length > 0 && (
              <span className="px-4 py-1.5 rounded-full text-xs font-bold bg-danger/10 text-danger border border-danger/20 flex items-center gap-2 shadow-inner backdrop-blur-sm">
                <span className="w-2 h-2 rounded-full bg-danger animate-ping absolute"></span>
                <span className="w-2 h-2 rounded-full bg-danger relative"></span>
                {alerts.length} Kritických
              </span>
            )}
            <span className="px-4 py-1.5 rounded-full text-xs font-bold bg-accent/10 text-accent border border-accent/20 backdrop-blur-sm shadow-inner">
              Σ {totalStock} palet
            </span>
            <button onClick={loadAll} className="px-4 py-1.5 rounded-full text-xs font-bold bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white border border-white/10 transition-all backdrop-blur-sm">
              ↻ Refresh
            </button>
          </div>
        </div>
      </header>

      {/* ── TABS (Glass) ── */}
      <nav className="relative z-30 bg-[#0a0d18]/40 backdrop-blur-xl border-b border-white/[0.05] sticky top-[89px]">
        <div className="max-w-7xl mx-auto flex gap-2 px-6 py-3 overflow-x-auto no-scrollbar">
          {tabDefs.map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)} className={`
              px-5 py-2 rounded-xl text-sm transition-all duration-300 whitespace-nowrap flex items-center gap-2 font-medium
              ${tab === t.k 
                ? "bg-white/10 text-white shadow-[0_4px_12px_rgba(0,0,0,0.1)] border border-white/10" 
                : "text-dim hover:text-gray-200 hover:bg-white/5 border border-transparent"}
            `}>
              <span className={`${tab === t.k ? 'text-accent' : 'opacity-70'}`}>{t.i}</span> {t.l}
            </button>
          ))}
        </div>
      </nav>

      {/* ── MAIN CONTENT ── */}
      <main className="relative z-10 max-w-7xl mx-auto px-6 py-8">

        {/* ═══ OVERVIEW ═══ */}
        {tab === "overview" && <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-5 mb-8">
            {[
              { l: "Celkem palet", v: totalStock, c: "#6391ff", bg: "bg-accent/5" },
              { l: "Typů kartonů", v: cartons.length, c: "#b18cff", bg: "bg-purple/5" },
              { l: "Kritických", v: enriched.filter((i) => i.ml <= CRIT && i.ml !== Infinity).length, c: "#ff4d6a", bg: "bg-danger/5" },
              { l: "SAP měsíců", v: coreMonths.length, c: "#00e5a0", bg: "bg-success/5" },
            ].map((x, i) => (
              <div key={i} className={`relative overflow-hidden rounded-3xl p-6 text-center border border-white/10 backdrop-blur-xl shadow-[0_8px_32px_0_rgba(0,0,0,0.2)] hover:-translate-y-1 transition-transform duration-300 ${x.bg}`}>
                <div className="absolute top-0 right-0 w-24 h-24 rounded-full blur-2xl opacity-20 -mr-10 -mt-10 pointer-events-none" style={{ backgroundColor: x.c }} />
                <div className="text-4xl font-black mb-2 tabular-nums drop-shadow-md relative z-10" style={{ color: x.c }}>{x.v}</div>
                <div className="text-[11px] text-gray-400 uppercase tracking-[0.15em] font-bold relative z-10">{x.l}</div>
              </div>
            ))}
          </div>

          <div className="bg-[#0e1225]/40 backdrop-blur-xl border border-white/10 rounded-3xl p-6 mb-8 shadow-[0_8px_32px_0_rgba(0,0,0,0.2)]">
            <h2 className="text-xs font-black text-white/70 mb-6 tracking-widest uppercase flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-accent"></span> Zásoby podle kartonu
            </h2>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={enriched.map((d) => ({ name: d.id.replace("CARTON-", ""), stock: d.stock }))} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.03)' }} contentStyle={glassTooltipStyle} />
                <Bar dataKey="stock" name="Palety" radius={[6, 6, 0, 0]}>
                  {enriched.map((d, i) => <Cell key={i} fill={sColor(d.ml)} fillOpacity={0.85} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-[#0e1225]/40 backdrop-blur-xl border border-white/10 rounded-3xl overflow-hidden shadow-[0_8px_32px_0_rgba(0,0,0,0.2)]">
            <div className="p-6 border-b border-white/5 bg-white/[0.02]">
              <h2 className="text-xs font-black text-white/70 tracking-widest uppercase m-0 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-purple"></span> Detailní přehled matice
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-white/[0.02] text-gray-400 text-xs uppercase tracking-widest font-semibold border-b border-white/5">
                  <tr>
                    {["Karton", "Rozměr", "ks/pal", "Sklad", "Ø ks/m", "Ø pal/m", "Zásoby", "Stav"].map((h) => (
                      <th key={h} className="px-6 py-5">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {enriched.map((it) => (
                    <tr key={it.id} className="hover:bg-white/[0.04] transition-colors group">
                      <td className="px-6 py-4 font-black text-white group-hover:text-accent transition-colors">{it.id}</td>
                      <td className="px-6 py-4 text-gray-400 text-xs">{it.dim}</td>
                      <td className="px-6 py-4 text-gray-500">{it.pcs_per_pallet ?? "—"}</td>
                      <td className="px-6 py-4 font-black text-lg text-white">{it.stock}</td>
                      <td className="px-6 py-4 text-gray-400">{it.avgPcs || "—"}</td>
                      <td className="px-6 py-4 text-gray-400">{it.avgPal ? it.avgPal.toFixed(2) : "—"}</td>
                      <td className="px-6 py-4 font-bold" style={{ color: sColor(it.ml) }}>{it.ml === Infinity ? "∞" : `${it.ml.toFixed(1)}m`}</td>
                      <td className="px-6 py-4">
                        <span className="px-3 py-1.5 rounded-xl text-[10px] font-black uppercase tracking-wider border backdrop-blur-md" style={{ backgroundColor: `${sColor(it.ml)}10`, color: sColor(it.ml), borderColor: `${sColor(it.ml)}25` }}>
                          {sLabel(it.ml)}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>}

        {/* ═══ ADJUST ═══ */}
        {tab === "adjust" && <>
          <div className="flex flex-wrap gap-4 mb-6">
            <button onClick={() => { setBulkMode(!bulkMode); setBulkVals({}); }} className={`
              px-6 py-3 rounded-2xl text-sm font-bold transition-all shadow-lg backdrop-blur-md border
              ${bulkMode ? "bg-danger/20 text-danger border-danger/30 hover:bg-danger/30" : "bg-white/5 text-white border-white/10 hover:bg-white/10"}
            `}>
              {bulkMode ? "✕ Zrušit hromadnou inventuru" : "✏ Spustit hromadnou inventuru"}
            </button>
            
            {bulkMode && (
              <button onClick={doBulk} className="px-8 py-3 rounded-2xl text-sm font-black bg-success/20 text-success border border-success/30 shadow-[0_0_20px_rgba(0,229,160,0.2)] hover:bg-success/30 transition-all animate-in zoom-in duration-200">
                ✓ Uložit stavy do DB
              </button>
            )}
          </div>

          {bulkMode ? (
            <div className="bg-[#0e1225]/40 backdrop-blur-xl border border-white/10 rounded-3xl overflow-hidden shadow-[0_8px_32px_0_rgba(0,0,0,0.2)] animate-in fade-in slide-in-from-bottom-4 duration-300">
               <div className="p-6 border-b border-white/5 bg-warning/10">
                <h2 className="text-xs font-black text-warning tracking-widest uppercase m-0 flex items-center gap-2">
                  <span className="w-2 h-2 rounded-full bg-warning animate-pulse"></span> Režim fyzického sčítání (Inventura)
                </h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead className="bg-white/[0.02] text-gray-400 text-xs uppercase tracking-widest font-semibold border-b border-white/5">
                    <tr><th className="px-6 py-5">Karton</th><th className="px-6 py-5">Systémový stav</th><th className="px-6 py-5">Nový fyzický stav (palety)</th></tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {cartons.map((c) => (
                      <tr key={c.id} className="hover:bg-white/[0.04] transition-colors">
                        <td className="px-6 py-4 font-black text-white">{c.id}</td>
                        <td className="px-6 py-4 text-dim font-medium">{stockMap[c.id] ?? 0}</td>
                        <td className="px-6 py-3">
                          <input type="number" min="0" placeholder={String(stockMap[c.id] ?? 0)} value={bulkVals[c.id] ?? ""} onChange={(e) => setBulkVals((p) => ({ ...p, [c.id]: e.target.value }))} 
                            className="w-32 px-4 py-2 bg-black/40 border border-white/10 rounded-xl text-white focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-all backdrop-blur-sm" 
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="bg-[#0e1225]/40 backdrop-blur-xl border border-white/10 rounded-3xl p-8 shadow-[0_8px_32px_0_rgba(0,0,0,0.2)]">
              <h2 className="text-xs font-black text-white/70 mb-8 tracking-widest uppercase flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-accent"></span> Rychlá korekce zásob
              </h2>
              
              <div className="flex flex-wrap items-center gap-2 mb-8 bg-black/20 p-2 rounded-2xl border border-white/5 inline-flex backdrop-blur-md">
                <select value={selId || ""} onChange={(e) => setSelId(e.target.value || null)} className="bg-transparent text-white px-5 py-3 outline-none cursor-pointer font-bold appearance-none min-w-[160px]">
                  <option value="" className="bg-[#0e1225] text-gray-400">— Vyber Karton —</option>
                  {cartons.map((d) => <option key={d.id} value={d.id} className="bg-[#0e1225] text-white">{d.id}</option>)}
                </select>
                <div className="w-[1px] h-8 bg-white/10 mx-2"></div>
                <input type="number" min="1" value={adjQ} onChange={(e) => setAdjQ(Math.max(1, Number(e.target.value)))} className="w-16 bg-transparent text-white px-2 py-3 outline-none text-center font-black text-lg" />
                <div className="w-[1px] h-8 bg-white/10 mx-2"></div>
                <button disabled={!selId} onClick={() => selId && doAdjust(selId, -adjQ)} className={`px-5 py-3 rounded-xl text-sm font-black transition-all ${selId ? 'bg-danger/20 text-danger hover:bg-danger/30 border border-danger/30' : 'opacity-30 cursor-not-allowed text-dim'}`}>− Odebrat</button>
                <button disabled={!selId} onClick={() => selId && doAdjust(selId, adjQ)} className={`px-5 py-3 rounded-xl text-sm font-black transition-all ${selId ? 'bg-success/20 text-success hover:bg-success/30 border border-success/30' : 'opacity-30 cursor-not-allowed text-dim'}`}>+ Přidat</button>
              </div>

              {selId && (() => { 
                const it = enriched.find((d) => d.id === selId); 
                if (!it) return null; 
                return (
                  <div className="mb-10 p-6 bg-accent/5 border border-accent/20 rounded-2xl flex flex-wrap gap-x-12 gap-y-6 text-sm animate-in fade-in zoom-in-95 duration-300 backdrop-blur-sm relative overflow-hidden">
                    <div className="absolute inset-0 bg-gradient-to-r from-accent/5 to-transparent pointer-events-none"></div>
                    <div className="relative z-10"><span className="text-gray-400 block text-xs mb-1 uppercase tracking-widest font-semibold">Karton</span> <strong className="text-accent text-xl font-black">{it.id}</strong></div>
                    <div className="relative z-10"><span className="text-gray-400 block text-xs mb-1 uppercase tracking-widest font-semibold">Aktuálně</span> <strong className="text-white text-xl font-black">{it.stock} pal</strong></div>
                    <div className="relative z-10"><span className="text-gray-400 block text-xs mb-1 uppercase tracking-widest font-semibold">Průměr / Měsíc</span> <strong className="text-white text-xl font-black">{it.avgPal.toFixed(2)} pal</strong></div>
                    <div className="relative z-10"><span className="text-gray-400 block text-xs mb-1 uppercase tracking-widest font-semibold">Vydrží na</span> <strong className="text-xl font-black" style={{ color: sColor(it.ml) }}>{it.ml === Infinity ? "∞" : `${it.ml.toFixed(1)} měsíců`}</strong></div>
                  </div>
              ); })()}

              <div className="overflow-x-auto border border-white/5 rounded-2xl bg-white/[0.01]">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead className="bg-white/[0.03] text-gray-400 text-xs uppercase tracking-widest font-semibold border-b border-white/5">
                    <tr><th className="px-6 py-5">Karton</th><th className="px-6 py-5">Sklad</th><th className="px-6 py-5">Rychlé akce</th></tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {enriched.map((it) => (
                      <tr key={it.id} className="hover:bg-white/[0.03] transition-colors">
                        <td className="px-6 py-4 font-black text-white">{it.id}</td>
                        <td className="px-6 py-4 font-black text-xl text-white">{it.stock}</td>
                        <td className="px-6 py-4">
                          <div className="flex gap-3">
                            {[-5, -1, 1, 5].map((d) => (
                              <button key={d} onClick={() => doAdjust(it.id, d)} className={`
                                w-12 h-10 flex items-center justify-center rounded-xl text-sm font-black transition-all border
                                ${d < 0 ? "bg-danger/10 text-danger border-danger/20 hover:bg-danger/20" : "bg-success/10 text-success border-success/20 hover:bg-success/20"}
                              `}>
                                {d > 0 ? "+" : ""}{d}
                              </button>
                            ))}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>}

        {/* ═══ PREDICTION ═══ */}
        {tab === "prediction" && <>
          <div className="bg-[#0e1225]/40 backdrop-blur-xl border border-white/10 rounded-3xl overflow-hidden shadow-[0_8px_32px_0_rgba(0,0,0,0.2)] mb-8">
            <div className="p-6 border-b border-white/5 bg-white/[0.02]">
              <h2 className="text-xs font-black text-white/70 tracking-widest uppercase m-0 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-danger"></span> Kdy dojdou zásoby?
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-white/[0.02] text-gray-400 text-xs uppercase tracking-widest font-semibold border-b border-white/5">
                  <tr>
                    {["Karton", "Sklad", "Ø pal/m", "Zásoby", "Datum vyčerpání", "Doporučeno (3m)"].map((h) => (
                      <th key={h} className="px-6 py-5">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {enriched.filter((i) => i.avgPal > 0).sort((a, b) => a.ml - b.ml).map((it) => (
                    <tr key={it.id} className="hover:bg-white/[0.04] transition-colors">
                      <td className="px-6 py-5 font-black text-white">{it.id}</td>
                      <td className="px-6 py-5 font-black text-lg">{it.stock}</td>
                      <td className="px-6 py-5 text-gray-400">{it.avgPal.toFixed(2)}</td>
                      <td className="px-6 py-5 font-black" style={{ color: sColor(it.ml) }}>{it.ml === Infinity ? "∞" : `${it.ml.toFixed(1)}m`}</td>
                      <td className={`px-6 py-5 font-medium ${it.ml <= LOW ? 'text-danger' : 'text-gray-400'}`}>{it.ml < 24 ? fDate(it.dep) : "24+ měsíců"}</td>
                      <td className="px-6 py-5 font-bold">
                        {it.reorder > 0 ? <span className="text-warning bg-warning/10 px-4 py-2 rounded-xl border border-warning/20 backdrop-blur-sm shadow-inner">Objednat {it.reorder} palet</span> : <span className="text-success">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-[#0e1225]/40 backdrop-blur-xl border border-white/10 rounded-3xl p-6 shadow-[0_8px_32px_0_rgba(0,0,0,0.2)]">
            <h2 className="text-xs font-black text-white/70 mb-8 tracking-widest uppercase flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-purple"></span> Křivka poklesu (6 měsíců)
            </h2>
            <ResponsiveContainer width="100%" height={350}>
              <AreaChart data={(() => {
                const pts: any[] = [];
                for (let m = 0; m <= 6; m++) {
                  const d = new Date(); d.setMonth(d.getMonth() + m);
                  const e: any = { month: `${d.getMonth() + 1}/${d.getFullYear()}` };
                  enriched.filter((i) => i.avgPal > 0).forEach((i) => { e[i.id] = i.fc[m]?.stock ?? 0; });
                  pts.push(e);
                }
                return pts;
              })()} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={glassTooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: "20px" }} />
                {enriched.filter((i) => i.avgPal > 0).map((it, idx) => (
                  <Area key={it.id} type="monotone" dataKey={it.id} stroke={chartColors[idx % chartColors.length]} fill={chartColors[idx % chartColors.length]} fillOpacity={0.05} strokeWidth={3} name={it.id} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>}

        {/* ═══ SAP ═══ */}
        {tab === "sap" && <>
          <div className="bg-[#0e1225]/40 backdrop-blur-xl border border-white/10 rounded-3xl p-8 mb-8 shadow-[0_8px_32px_0_rgba(0,0,0,0.2)] relative overflow-hidden">
            <div className="absolute top-0 right-0 w-64 h-64 bg-accent/10 blur-3xl rounded-full pointer-events-none"></div>
            <h2 className="text-xs font-black text-white/70 mb-6 tracking-widest uppercase flex items-center gap-2 relative z-10">
              <span className="w-2 h-2 rounded-full bg-accent"></span> Synchronizace se SAP WM
            </h2>
            <div className="flex flex-wrap items-center gap-5 relative z-10">
              <label className="px-8 py-4 rounded-2xl text-sm font-black bg-gradient-to-br from-accent to-purple text-white shadow-[0_0_20px_rgba(99,145,255,0.3)] hover:scale-105 cursor-pointer transition-all inline-flex items-center gap-3 border border-white/20">
                <svg className="w-6 h-6 opacity-90" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12"></path></svg>
                Vybrat LIPS.xlsx
                <input ref={fRef} type="file" accept=".xlsx,.xls" onChange={handleUpload} className="hidden" />
              </label>
              {uploadMsg && (
                <span className={`text-sm font-bold px-5 py-3 rounded-xl border backdrop-blur-md ${uploadMsg.startsWith("✓") ? "bg-success/20 text-success border-success/30" : uploadMsg.startsWith("⚠") || uploadMsg.startsWith("✕") ? "bg-danger/20 text-danger border-danger/30" : "bg-accent/20 text-accent border-accent/30"}`}>
                  {uploadMsg}
                </span>
              )}
            </div>
            <p className="mt-6 text-sm text-gray-400 leading-relaxed max-w-3xl relative z-10">
              Nahrajte měsíční LIPS export ze SAPu. Systém automaticky vyhledá položky začínající na <strong className="text-white">CARTON-</strong>, zpracuje sloupec <strong className="text-white">Delivery quantity</strong> a přiřadí hodnoty podle <strong className="text-white">Material Avail. Date</strong>. Data jsou šifrovaně uložena v Supabase.
            </p>
          </div>

          <div className="bg-[#0e1225]/40 backdrop-blur-xl border border-white/10 rounded-3xl p-6 mb-8 shadow-[0_8px_32px_0_rgba(0,0,0,0.2)]">
            <h2 className="text-xs font-black text-white/70 mb-8 tracking-widest uppercase flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-success"></span> Měsíční spotřeba (Kusy)
            </h2>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={coreMonths.map((m) => { const e: any = { month: m }; Object.keys(sapHistory).sort().forEach((mat) => { e[mat] = sapHistory[mat][m] || 0; }); return e; })} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                <YAxis tick={{ fill: "#6b7280", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.03)' }} contentStyle={glassTooltipStyle} />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: "20px" }} />
                {Object.keys(sapHistory).sort().map((mat, idx) => (
                  <Bar key={mat} dataKey={mat} fill={chartColors[idx % chartColors.length]} radius={[6, 6, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-[#0e1225]/40 backdrop-blur-xl border border-white/10 rounded-3xl overflow-hidden shadow-[0_8px_32px_0_rgba(0,0,0,0.2)]">
            <div className="p-6 border-b border-white/5 bg-white/[0.02]">
              <h2 className="text-xs font-black text-white/70 tracking-widest uppercase m-0 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-dim"></span> Surová data
              </h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-white/[0.02] text-gray-400 text-xs uppercase tracking-widest font-semibold border-b border-white/5">
                  <tr>
                    {["Karton", "Ø ks/m", "ks/pal", "Ø pal/m", ...coreMonths].map((h) => (
                      <th key={h} className="px-6 py-5">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/[0.04]">
                  {enriched.filter((i) => sapHistory[i.id]).map((it) => {
                    const h = sapHistory[it.id] || {};
                    return (
                      <tr key={it.id} className="hover:bg-white/[0.04] transition-colors">
                        <td className="px-6 py-4 font-black text-white">{it.id}</td>
                        <td className="px-6 py-4 text-white font-medium">{it.avgPcs}</td>
                        <td className="px-6 py-4 text-gray-500">{it.pcs_per_pallet ?? "—"}</td>
                        <td className="px-6 py-4 text-white font-medium">{it.avgPal ? it.avgPal.toFixed(2) : "—"}</td>
                        {coreMonths.map((m) => (
                          <td key={m} className={`px-6 py-4 tabular-nums ${h[m] ? 'text-white' : 'text-gray-600'}`}>{h[m] || "—"}</td>
                        ))}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>}

        {/* ═══ ALERTS ═══ */}
        {tab === "alerts" && <>
          <div className="flex items-center gap-6 mb-10 bg-[#0e1225]/40 backdrop-blur-xl p-6 rounded-3xl border border-white/10 shadow-lg">
            <span className="text-gray-400 text-sm font-bold uppercase tracking-widest">Nastavení prahu alarmu:</span>
            <input type="range" min="0.5" max="4" step="0.25" value={thresh} onChange={(e) => setThresh(Number(e.target.value))} className="flex-1 max-w-[300px] accent-accent" />
            <span className="text-accent font-black text-2xl w-24 drop-shadow-md">{thresh} měs.</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {alerts.length === 0 ? (
              <div className="col-span-full bg-[#0e1225]/40 backdrop-blur-xl border border-white/10 rounded-3xl p-20 text-center shadow-lg">
                <div className="text-7xl mb-6 text-success opacity-80 drop-shadow-lg">✓</div>
                <div className="text-2xl font-black text-white mb-3">Sklad je stabilní</div>
                <div className="text-gray-400 text-sm">Žádný materiál neklesl pod ochranný limit {thresh} měsíců.</div>
              </div>
            ) : alerts.map((it) => (
              <div key={it.id} className="bg-[#0e1225]/60 backdrop-blur-2xl rounded-3xl p-8 shadow-xl relative overflow-hidden border border-white/10 group hover:-translate-y-1 transition-all duration-300" style={{ borderTop: `4px solid ${sColor(it.ml)}` }}>
                <div className="absolute -top-10 -right-10 p-6 opacity-5 group-hover:opacity-10 transition-opacity">
                  <svg className="w-40 h-40" style={{ color: sColor(it.ml) }} fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                </div>
                
                <div className="flex justify-between items-start mb-8 relative z-10">
                  <div>
                    <h3 className="text-2xl font-black text-white mb-1">{it.id}</h3>
                    <p className="text-xs text-gray-400 font-medium">{it.dim}</p>
                  </div>
                  <span className="px-4 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest border backdrop-blur-md shadow-inner" style={{ backgroundColor: `${sColor(it.ml)}15`, color: sColor(it.ml), borderColor: `${sColor(it.ml)}30` }}>
                    {sLabel(it.ml)}
                  </span>
                </div>
                
                <div className="grid grid-cols-2 gap-y-6 gap-x-4 text-sm relative z-10">
                  <div className="bg-black/20 p-4 rounded-2xl border border-white/5">
                    <span className="text-gray-400 text-[10px] uppercase tracking-widest block mb-2 font-bold">Na skladě</span> 
                    <strong className="text-white text-xl font-black">{it.stock} <span className="text-xs text-gray-500 font-medium">pal</span></strong>
                  </div>
                  <div className="bg-black/20 p-4 rounded-2xl border border-white/5">
                    <span className="text-gray-400 text-[10px] uppercase tracking-widest block mb-2 font-bold">Vydrží na</span> 
                    <strong className="text-xl font-black" style={{ color: sColor(it.ml) }}>{it.ml.toFixed(1)} <span className="text-xs font-medium opacity-70">měs.</span></strong>
                  </div>
                  <div className="col-span-2 pt-4 mt-2 border-t border-white/10 flex justify-between items-center">
                    <span className="text-gray-400 text-xs font-bold uppercase tracking-widest">Doporučený nákup</span> 
                    <strong className="text-warning text-2xl font-black drop-shadow-md">{it.reorder} palet</strong>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>}

        {/* ═══ LOG ═══ */}
        {tab === "log" && <>
          <div className="bg-[#0e1225]/40 backdrop-blur-xl border border-white/10 rounded-3xl overflow-hidden shadow-[0_8px_32px_0_rgba(0,0,0,0.2)]">
            <div className="p-6 border-b border-white/5 bg-white/[0.02] flex justify-between items-center">
              <h2 className="text-xs font-black text-white/70 tracking-widest uppercase m-0 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-dim"></span> Historie transakcí
              </h2>
              <button onClick={loadAll} className="px-5 py-2 rounded-xl text-xs font-bold bg-white/5 text-gray-300 hover:text-white hover:bg-white/10 border border-white/10 transition-all backdrop-blur-md">↻ Aktualizovat</button>
            </div>
            
            {logEntries.length === 0 ? (
              <div className="text-center p-20 text-gray-500 text-sm font-medium">Zatím nebyly zaznamenány žádné pohyby v Supabase.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead className="bg-white/[0.02] text-gray-400 text-xs uppercase tracking-widest font-semibold border-b border-white/5">
                    <tr><th className="px-6 py-5">Datum a čas</th><th className="px-6 py-5">Karton</th><th className="px-6 py-5">Pohyb</th><th className="px-6 py-5">Poznámka</th></tr>
                  </thead>
                  <tbody className="divide-y divide-white/[0.04]">
                    {logEntries.map((e) => (
                      <tr key={e.id} className="hover:bg-white/[0.04] transition-colors">
                        <td className="px-6 py-4 text-gray-400 text-xs font-medium">{new Date(e.created_at).toLocaleString("cs-CZ")}</td>
                        <td className="px-6 py-4 font-black text-white">{e.carton_id}</td>
                        <td className="px-6 py-4">
                          <span className={`inline-flex items-center justify-center px-3 py-1 rounded-lg text-xs font-black border ${e.delta > 0 ? 'bg-success/10 text-success border-success/20' : 'bg-danger/10 text-danger border-danger/20'}`}>
                            {e.delta > 0 ? "+" : ""}{e.delta}
                          </span>
                        </td>
                        <td className="px-6 py-4 text-gray-500 italic text-xs">{e.note || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </>}

      </main>
    </div>
  );
}
