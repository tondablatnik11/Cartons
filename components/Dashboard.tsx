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

  if (loading) return (
    <div className="min-h-screen bg-bg flex items-center justify-center font-sans">
      <div className="text-center text-accent">
        <div className="text-4xl mb-4 animate-pulse">◎</div>
        <div className="text-sm font-semibold tracking-wide">Načítám data ze Supabase...</div>
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-bg text-gray-200 font-sans selection:bg-accent/30 pb-20">
      
      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-6 right-6 px-5 py-3 rounded-xl text-sm font-bold shadow-2xl z-50 transition-all duration-300 transform translate-y-0 opacity-100 ${
          toast.type === "ok" ? "bg-success text-black" : toast.type === "warn" ? "bg-warning text-black" : "bg-accent text-black"
        }`}>
          {toast.msg}
        </div>
      )}

      {/* Progress Bar for Saving */}
      {saving && (
        <div className="fixed top-0 left-0 right-0 h-1 bg-gradient-to-r from-accent to-purple z-50 animate-pulse" />
      )}

      {/* HEADER */}
      <header className="bg-gradient-to-b from-surfaceHi to-surface border-b border-border px-8 py-6 sticky top-0 z-40 shadow-sm">
        <div className="max-w-7xl mx-auto flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-accent to-purple flex items-center justify-center text-xl font-black text-white shadow-lg shadow-accent/20">
              K
            </div>
            <div>
              <h1 className="text-2xl font-black text-white tracking-tight leading-none mb-1">Kartony Bor</h1>
              <p className="text-xs text-dim font-medium tracking-wide uppercase">WH 8496 · Supabase live</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {alerts.length > 0 && (
              <span className="px-4 py-1.5 rounded-full text-xs font-bold bg-danger/10 text-danger border border-danger/20 flex items-center gap-2 shadow-inner">
                <span className="w-2 h-2 rounded-full bg-danger animate-pulse"></span>
                {alerts.length} Kritických
              </span>
            )}
            <span className="px-4 py-1.5 rounded-full text-xs font-bold bg-accent/10 text-accent border border-accent/20">
              Σ {totalStock} palet
            </span>
            <button onClick={loadAll} className="px-4 py-1.5 rounded-full text-xs font-bold bg-surfaceHi text-gray-300 hover:text-white border border-border hover:border-dim transition-all">
              ↻ Refresh
            </button>
          </div>
        </div>
      </header>

      {/* TABS */}
      <nav className="bg-surface border-b border-border sticky top-[97px] z-30 bg-opacity-95 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto flex gap-1 px-6 py-2 overflow-x-auto no-scrollbar">
          {tabDefs.map((t) => (
            <button key={t.k} onClick={() => setTab(t.k)} className={`
              px-5 py-2.5 rounded-lg text-sm transition-all duration-200 whitespace-nowrap flex items-center gap-2
              ${tab === t.k ? "bg-accent/15 text-accent font-bold" : "text-dim hover:text-gray-200 hover:bg-white/5 font-medium"}
            `}>
              <span className="opacity-70">{t.i}</span> {t.l}
            </button>
          ))}
        </div>
      </nav>

      {/* MAIN CONTENT */}
      <main className="max-w-7xl mx-auto px-6 py-8">

        {/* ═══ OVERVIEW ═══ */}
        {tab === "overview" && <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-8">
            {[
              { l: "Celkem palet", v: totalStock, c: "#6391ff" },
              { l: "Typů kartonů", v: cartons.length, c: "#b18cff" },
              { l: "Kritických", v: enriched.filter((i) => i.ml <= CRIT && i.ml !== Infinity).length, c: "#ff4d6a" },
              { l: "SAP měsíců", v: coreMonths.length, c: "#00e5a0" },
            ].map((x, i) => (
              <div key={i} className="bg-surface border border-border rounded-2xl p-6 text-center hover:border-white/10 transition-colors shadow-sm">
                <div className="text-3xl font-black mb-2 tabular-nums" style={{ color: x.c }}>{x.v}</div>
                <div className="text-[10px] text-dim uppercase tracking-[0.1em] font-bold">{x.l}</div>
              </div>
            ))}
          </div>

          <div className="bg-surface border border-border rounded-2xl p-6 mb-8 shadow-sm">
            <h2 className="text-xs font-bold text-accent mb-6 tracking-widest uppercase">Zásoby podle kartonu</h2>
            <ResponsiveContainer width="100%" height={280}>
              <BarChart data={enriched.map((d) => ({ name: d.id.replace("CARTON-", ""), stock: d.stock }))} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(99,145,255,0.08)" vertical={false} />
                <XAxis dataKey="name" tick={{ fill: "#4b5580", fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                <YAxis tick={{ fill: "#4b5580", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.02)' }} contentStyle={{ backgroundColor: "#0e1225", borderColor: "rgba(99,145,255,0.1)", borderRadius: "12px", color: "#d4daf0", fontSize: "12px", boxShadow: "0 10px 25px rgba(0,0,0,0.5)" }} />
                <Bar dataKey="stock" name="Palety" radius={[4, 4, 0, 0]}>
                  {enriched.map((d, i) => <Cell key={i} fill={sColor(d.ml)} fillOpacity={0.9} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-surface border border-border rounded-2xl overflow-hidden shadow-sm">
            <div className="p-6 border-b border-border bg-surfaceHi/30">
              <h2 className="text-xs font-bold text-accent tracking-widest uppercase m-0">Detailní přehled</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-surfaceHi/50 text-dim text-xs uppercase tracking-wider">
                  <tr>
                    {["Karton", "Rozměr", "ks/pal", "Sklad", "Ø ks/m", "Ø pal/m", "Zásoby", "Stav"].map((h) => (
                      <th key={h} className="px-6 py-4 font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {enriched.map((it) => (
                    <tr key={it.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-6 py-4 font-bold text-accent">{it.id}</td>
                      <td className="px-6 py-4 text-dim text-xs">{it.dim}</td>
                      <td className="px-6 py-4 text-gray-400">{it.pcs_per_pallet ?? "—"}</td>
                      <td className="px-6 py-4 font-black text-base">{it.stock}</td>
                      <td className="px-6 py-4 text-gray-400">{it.avgPcs || "—"}</td>
                      <td className="px-6 py-4 text-gray-400">{it.avgPal ? it.avgPal.toFixed(2) : "—"}</td>
                      <td className="px-6 py-4 font-bold" style={{ color: sColor(it.ml) }}>{it.ml === Infinity ? "∞" : `${it.ml.toFixed(1)}m`}</td>
                      <td className="px-6 py-4">
                        <span className="px-3 py-1 rounded-full text-[10px] font-bold border" style={{ backgroundColor: `${sColor(it.ml)}15`, color: sColor(it.ml), borderColor: `${sColor(it.ml)}30` }}>
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
              px-5 py-2.5 rounded-xl text-sm font-bold transition-all shadow-md
              ${bulkMode ? "bg-gradient-to-br from-danger to-red-800 text-white" : "bg-gradient-to-br from-accent to-purple text-white hover:shadow-accent/25"}
            `}>
              {bulkMode ? "✕ Zrušit hromadnou editaci" : "✏ Hromadná inventura"}
            </button>
            
            {bulkMode && (
              <button onClick={doBulk} className="px-6 py-2.5 rounded-xl text-sm font-bold bg-gradient-to-br from-success to-emerald-600 text-black shadow-md hover:shadow-success/25 transition-all">
                ✓ Uložit stavy
              </button>
            )}
          </div>

          {bulkMode ? (
            <div className="bg-surface border border-border rounded-2xl overflow-hidden shadow-sm animate-in fade-in slide-in-from-bottom-4 duration-300">
               <div className="p-6 border-b border-border bg-surfaceHi/30">
                <h2 className="text-xs font-bold text-accent tracking-widest uppercase m-0">Hromadné zadání (Fyzické sčítání)</h2>
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead className="bg-surfaceHi/50 text-dim text-xs uppercase tracking-wider">
                    <tr><th className="px-6 py-4 font-semibold">Karton</th><th className="px-6 py-4 font-semibold">Aktuálně v systému</th><th className="px-6 py-4 font-semibold">Nový fyzický stav (palety)</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {cartons.map((c) => (
                      <tr key={c.id} className="hover:bg-white/[0.02]">
                        <td className="px-6 py-4 font-bold text-accent">{c.id}</td>
                        <td className="px-6 py-4 text-dim font-medium">{stockMap[c.id] ?? 0}</td>
                        <td className="px-6 py-3">
                          <input type="number" min="0" placeholder={String(stockMap[c.id] ?? 0)} value={bulkVals[c.id] ?? ""} onChange={(e) => setBulkVals((p) => ({ ...p, [c.id]: e.target.value }))} 
                            className="w-24 px-3 py-2 bg-bg border border-border rounded-lg text-white focus:outline-none focus:border-accent focus:ring-1 focus:ring-accent transition-all" 
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            <div className="bg-surface border border-border rounded-2xl p-6 shadow-sm">
              <h2 className="text-xs font-bold text-accent mb-6 tracking-widest uppercase">Rychlá úprava stavu</h2>
              
              <div className="flex flex-wrap items-center gap-3 mb-8 bg-bg p-2 rounded-xl border border-border inline-flex">
                <select value={selId || ""} onChange={(e) => setSelId(e.target.value || null)} className="bg-transparent text-white px-4 py-2 outline-none cursor-pointer font-medium appearance-none min-w-[150px]">
                  <option value="" className="bg-surface">— Vyber Karton —</option>
                  {cartons.map((d) => <option key={d.id} value={d.id} className="bg-surface">{d.id}</option>)}
                </select>
                <div className="w-[1px] h-6 bg-border mx-1"></div>
                <input type="number" min="1" value={adjQ} onChange={(e) => setAdjQ(Math.max(1, Number(e.target.value)))} className="w-16 bg-transparent text-white px-2 py-2 outline-none text-center font-bold" />
                <div className="w-[1px] h-6 bg-border mx-1"></div>
                <button disabled={!selId} onClick={() => selId && doAdjust(selId, -adjQ)} className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${selId ? 'bg-danger/10 text-danger hover:bg-danger/20' : 'opacity-30 cursor-not-allowed text-dim'}`}>− Odebrat</button>
                <button disabled={!selId} onClick={() => selId && doAdjust(selId, adjQ)} className={`px-4 py-2 rounded-lg text-sm font-bold transition-all ${selId ? 'bg-success/10 text-success hover:bg-success/20' : 'opacity-30 cursor-not-allowed text-dim'}`}>+ Přidat</button>
              </div>

              {selId && (() => { 
                const it = enriched.find((d) => d.id === selId); 
                if (!it) return null; 
                return (
                  <div className="mb-8 p-5 bg-accent/5 border border-accent/20 rounded-xl flex flex-wrap gap-x-8 gap-y-4 text-sm animate-in fade-in zoom-in-95 duration-200">
                    <div><span className="text-dim block text-xs mb-1 uppercase tracking-wider">Vybraný karton</span> <strong className="text-accent text-base">{it.id}</strong></div>
                    <div><span className="text-dim block text-xs mb-1 uppercase tracking-wider">Aktuální sklad</span> <strong className="text-white text-base">{it.stock} palet</strong></div>
                    <div><span className="text-dim block text-xs mb-1 uppercase tracking-wider">Průměrný výdej</span> <strong className="text-white text-base">{it.avgPal.toFixed(2)} pal/m</strong></div>
                    <div><span className="text-dim block text-xs mb-1 uppercase tracking-wider">Zásoba vydrží na</span> <strong className="text-base" style={{ color: sColor(it.ml) }}>{it.ml === Infinity ? "∞" : `${it.ml.toFixed(1)} měsíců`}</strong></div>
                  </div>
              ); })()}

              <div className="overflow-x-auto border border-border rounded-xl">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead className="bg-surfaceHi/50 text-dim text-xs uppercase tracking-wider">
                    <tr><th className="px-6 py-4 font-semibold">Karton</th><th className="px-6 py-4 font-semibold">Sklad</th><th className="px-6 py-4 font-semibold">Rychlá akce</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {enriched.map((it) => (
                      <tr key={it.id} className="hover:bg-white/[0.02]">
                        <td className="px-6 py-4 font-bold text-accent">{it.id}</td>
                        <td className="px-6 py-4 font-black text-base">{it.stock}</td>
                        <td className="px-6 py-3">
                          <div className="flex gap-2">
                            {[-5, -1, 1, 5].map((d) => (
                              <button key={d} onClick={() => doAdjust(it.id, d)} className={`
                                w-10 h-8 flex items-center justify-center rounded-md text-xs font-bold transition-colors
                                ${d < 0 ? "bg-danger/10 text-danger hover:bg-danger/20" : "bg-success/10 text-success hover:bg-success/20"}
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
          <div className="bg-surface border border-border rounded-2xl overflow-hidden shadow-sm mb-8">
            <div className="p-6 border-b border-border bg-surfaceHi/30">
              <h2 className="text-xs font-bold text-accent tracking-widest uppercase m-0">Kdy dojdou zásoby?</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-surfaceHi/50 text-dim text-xs uppercase tracking-wider">
                  <tr>
                    {["Karton", "Sklad", "Ø pal/m", "Zásoby", "Datum vyčerpání", "Doporučení k objednání (pro 3m)"].map((h) => (
                      <th key={h} className="px-6 py-4 font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {enriched.filter((i) => i.avgPal > 0).sort((a, b) => a.ml - b.ml).map((it) => (
                    <tr key={it.id} className="hover:bg-white/[0.02] transition-colors">
                      <td className="px-6 py-4 font-bold text-accent">{it.id}</td>
                      <td className="px-6 py-4 font-black">{it.stock}</td>
                      <td className="px-6 py-4 text-gray-400">{it.avgPal.toFixed(2)}</td>
                      <td className="px-6 py-4 font-bold" style={{ color: sColor(it.ml) }}>{it.ml === Infinity ? "∞" : `${it.ml.toFixed(1)}m`}</td>
                      <td className={`px-6 py-4 font-medium ${it.ml <= LOW ? 'text-danger' : 'text-gray-300'}`}>{it.ml < 24 ? fDate(it.dep) : "24+ měsíců"}</td>
                      <td className="px-6 py-4 font-bold">
                        {it.reorder > 0 ? <span className="text-warning bg-warning/10 px-3 py-1 rounded-full border border-warning/20">Objednat {it.reorder} palet</span> : <span className="text-success">—</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div className="bg-surface border border-border rounded-2xl p-6 shadow-sm">
            <h2 className="text-xs font-bold text-accent mb-6 tracking-widest uppercase">Trend poklesu zásob (Příštích 6 měsíců)</h2>
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
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(99,145,255,0.08)" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#4b5580", fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                <YAxis tick={{ fill: "#4b5580", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ backgroundColor: "#0e1225", borderColor: "rgba(99,145,255,0.1)", borderRadius: "12px", color: "#d4daf0", fontSize: "12px" }} />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: "20px" }} />
                {enriched.filter((i) => i.avgPal > 0).map((it, idx) => (
                  <Area key={it.id} type="monotone" dataKey={it.id} stroke={chartColors[idx % chartColors.length]} fill={chartColors[idx % chartColors.length]} fillOpacity={0.05} strokeWidth={2} name={it.id} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>}

        {/* ═══ SAP ═══ */}
        {tab === "sap" && <>
          <div className="bg-surface border border-border rounded-2xl p-6 mb-8 shadow-sm">
             <h2 className="text-xs font-bold text-accent mb-6 tracking-widest uppercase">Nahrát měsíční report ze SAPu</h2>
            <div className="flex flex-wrap items-center gap-4">
              <label className="px-6 py-3 rounded-xl text-sm font-bold bg-gradient-to-br from-accent to-purple text-white shadow-md hover:shadow-accent/25 cursor-pointer transition-all inline-flex items-center gap-2">
                <svg className="w-5 h-5 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"></path></svg>
                Vybrat LIPS.xlsx
                <input ref={fRef} type="file" accept=".xlsx,.xls" onChange={handleUpload} className="hidden" />
              </label>
              {uploadMsg && (
                <span className={`text-sm font-semibold px-4 py-2 rounded-lg bg-bg border border-border ${uploadMsg.startsWith("✓") ? "text-success" : uploadMsg.startsWith("⚠") || uploadMsg.startsWith("✕") ? "text-danger" : "text-accent"}`}>
                  {uploadMsg}
                </span>
              )}
            </div>
            <p className="mt-4 text-xs text-dim leading-relaxed max-w-2xl">
              Nahraj LIPS export z libovolného měsíce. Aplikace automaticky sečte hodnoty ze sloupce <strong className="text-gray-300">Delivery quantity</strong> pro příslušný <strong className="text-gray-300">Material</strong> a přiřadí je ke správnému měsíci podle <strong className="text-gray-300">Material Avail. Date</strong>. Data se bezpečně synchronizují do centrální Supabase databáze.
            </p>
          </div>

          <div className="bg-surface border border-border rounded-2xl p-6 mb-8 shadow-sm">
             <h2 className="text-xs font-bold text-accent mb-6 tracking-widest uppercase">Historie spotřeby (Kusy)</h2>
            <ResponsiveContainer width="100%" height={320}>
              <BarChart data={coreMonths.map((m) => { const e: any = { month: m }; Object.keys(sapHistory).sort().forEach((mat) => { e[mat] = sapHistory[mat][m] || 0; }); return e; })} margin={{ top: 10, right: 10, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(99,145,255,0.08)" vertical={false} />
                <XAxis dataKey="month" tick={{ fill: "#4b5580", fontSize: 11 }} axisLine={false} tickLine={false} dy={10} />
                <YAxis tick={{ fill: "#4b5580", fontSize: 11 }} axisLine={false} tickLine={false} />
                <Tooltip cursor={{ fill: 'rgba(255,255,255,0.02)' }} contentStyle={{ backgroundColor: "#0e1225", borderColor: "rgba(99,145,255,0.1)", borderRadius: "12px", color: "#d4daf0", fontSize: "12px" }} />
                <Legend wrapperStyle={{ fontSize: 12, paddingTop: "20px" }} />
                {Object.keys(sapHistory).sort().map((mat, idx) => (
                  <Bar key={mat} dataKey={mat} fill={chartColors[idx % chartColors.length]} radius={[4, 4, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div className="bg-surface border border-border rounded-2xl overflow-hidden shadow-sm">
             <div className="p-6 border-b border-border bg-surfaceHi/30">
              <h2 className="text-xs font-bold text-accent tracking-widest uppercase m-0">Detailní matice dat ze SAPu</h2>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-sm whitespace-nowrap">
                <thead className="bg-surfaceHi/50 text-dim text-[10px] uppercase tracking-wider">
                  <tr>
                    {["Karton", "Ø ks/m", "ks/pal", "Ø pal/m", ...coreMonths].map((h) => (
                      <th key={h} className="px-6 py-4 font-semibold">{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {enriched.filter((i) => sapHistory[i.id]).map((it) => {
                    const h = sapHistory[it.id] || {};
                    return (
                      <tr key={it.id} className="hover:bg-white/[0.02]">
                        <td className="px-6 py-3 font-bold text-accent">{it.id}</td>
                        <td className="px-6 py-3 text-gray-300 font-medium">{it.avgPcs}</td>
                        <td className="px-6 py-3 text-dim">{it.pcs_per_pallet ?? "—"}</td>
                        <td className="px-6 py-3 text-gray-300 font-medium">{it.avgPal ? it.avgPal.toFixed(2) : "—"}</td>
                        {coreMonths.map((m) => (
                          <td key={m} className={`px-6 py-3 tabular-nums ${h[m] ? 'text-gray-300' : 'text-dim'}`}>{h[m] || "—"}</td>
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
          <div className="flex items-center gap-4 mb-8 bg-surface p-6 rounded-2xl border border-border">
            <span className="text-dim text-sm font-semibold uppercase tracking-wider">Nastavení prahu kritičnosti:</span>
            <input type="range" min="0.5" max="4" step="0.25" value={thresh} onChange={(e) => setThresh(Number(e.target.value))} className="flex-1 max-w-[250px] accent-accent" />
            <span className="text-accent font-black text-lg w-20">{thresh} měs.</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            {alerts.length === 0 ? (
              <div className="col-span-full bg-surface border border-border rounded-2xl p-16 text-center">
                <div className="text-6xl mb-4 text-success opacity-80">✓</div>
                <div className="text-xl font-black text-success mb-2">Vše v naprostém pořádku</div>
                <div className="text-dim text-sm">Žádný materiál neklesl pod nastavený práh {thresh} měsíců.</div>
              </div>
            ) : alerts.map((it) => (
              <div key={it.id} className="bg-surface rounded-2xl p-6 shadow-sm relative overflow-hidden" style={{ borderLeft: `6px solid ${sColor(it.ml)}` }}>
                <div className="absolute top-0 right-0 p-6 opacity-10">
                  <svg className="w-20 h-20" style={{ color: sColor(it.ml) }} fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z" clipRule="evenodd" /></svg>
                </div>
                
                <div className="flex justify-between items-start mb-6 relative z-10">
                  <div>
                    <h3 className="text-lg font-black text-white">{it.id}</h3>
                    <p className="text-xs text-dim mt-1">{it.dim}</p>
                  </div>
                  <span className="px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border" style={{ backgroundColor: `${sColor(it.ml)}15`, color: sColor(it.ml), borderColor: `${sColor(it.ml)}30` }}>
                    {sLabel(it.ml)}
                  </span>
                </div>
                
                <div className="grid grid-cols-2 gap-y-4 gap-x-2 text-sm relative z-10">
                  <div><span className="text-dim text-xs block mb-1">Aktuálně na skladu</span> <strong className="text-white text-base">{it.stock} palet</strong></div>
                  <div><span className="text-dim text-xs block mb-1">Zásoba vydrží na</span> <strong className="text-base" style={{ color: sColor(it.ml) }}>{it.ml.toFixed(1)} měsíců</strong></div>
                  <div className="col-span-2 pt-2 mt-2 border-t border-border">
                    <span className="text-dim text-xs block mb-1">Doporučeno ihned objednat</span> 
                    <strong className="text-warning text-lg">{it.reorder} palet</strong>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </>}

        {/* ═══ LOG ═══ */}
        {tab === "log" && <>
          <div className="bg-surface border border-border rounded-2xl overflow-hidden shadow-sm">
            <div className="p-6 border-b border-border bg-surfaceHi/30 flex justify-between items-center">
              <h2 className="text-xs font-bold text-accent tracking-widest uppercase m-0">Historie pohybů (Posledních {logEntries.length})</h2>
              <button onClick={loadAll} className="px-4 py-1.5 rounded-lg text-xs font-bold bg-bg text-dim hover:text-white border border-border transition-all">↻ Aktualizovat</button>
            </div>
            
            {logEntries.length === 0 ? (
              <div className="text-center p-16 text-dim text-sm">Zatím nebyly zaznamenány žádné změny stavů.</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm whitespace-nowrap">
                  <thead className="bg-surfaceHi/50 text-dim text-xs uppercase tracking-wider">
                    <tr><th className="px-6 py-4 font-semibold">Datum a čas</th><th className="px-6 py-4 font-semibold">Karton</th><th className="px-6 py-4 font-semibold">Pohyb</th><th className="px-6 py-4 font-semibold">Poznámka</th></tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {logEntries.map((e) => (
                      <tr key={e.id} className="hover:bg-white/[0.02] transition-colors">
                        <td className="px-6 py-4 text-dim text-xs">{new Date(e.created_at).toLocaleString("cs-CZ")}</td>
                        <td className="px-6 py-4 font-bold text-accent">{e.carton_id}</td>
                        <td className={`px-6 py-4 font-bold ${e.delta > 0 ? 'text-success' : 'text-danger'}`}>
                          {e.delta > 0 ? "+" : ""}{e.delta} palet
                        </td>
                        <td className="px-6 py-4 text-gray-400 italic text-xs">{e.note || "—"}</td>
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
