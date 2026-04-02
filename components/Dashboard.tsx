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

const P = {
  bg: "#06080f", sf: "#0e1225", sfHi: "#141938", bd: "rgba(99,145,255,0.08)",
  ac: "#6391ff", acG: "rgba(99,145,255,0.15)", acS: "rgba(99,145,255,0.06)",
  tx: "#d4daf0", dm: "#4b5580", gn: "#00e5a0", am: "#ffb020", rd: "#ff4d6a",
  pu: "#b18cff", cy: "#22d3ee",
};

const tipS = { background: P.sf, border: `1px solid ${P.bd}`, borderRadius: 10, color: P.tx, fontSize: 11 };
const thS: React.CSSProperties = { padding: "8px 10px", textAlign: "left", color: P.dm, fontWeight: 600, fontSize: 9, textTransform: "uppercase", letterSpacing: "0.06em", borderBottom: `2px solid ${P.bd}` };
const tdS: React.CSSProperties = { padding: "10px", borderBottom: `1px solid ${P.bd}` };
const cardS: React.CSSProperties = { background: P.sf, borderRadius: 14, border: `1px solid ${P.bd}`, padding: 22, marginBottom: 14 };
const titleS: React.CSSProperties = { fontSize: 11, fontWeight: 800, color: P.ac, marginBottom: 16, letterSpacing: "0.08em", textTransform: "uppercase" };
const btnS = (bg: string, fg = "#fff"): React.CSSProperties => ({ padding: "9px 18px", borderRadius: 8, fontSize: 12, fontWeight: 700, border: "none", cursor: "pointer", background: bg, color: fg });
const inputS: React.CSSProperties = { padding: "7px 10px", borderRadius: 8, border: `1px solid ${P.bd}`, background: P.bg, color: P.tx, fontSize: 12, outline: "none", fontFamily: "inherit" };
const chartColors = [P.ac, P.pu, P.am, P.gn, P.rd, "#ec4899", P.cy, "#f97316", "#6366f1", "#84cc16", "#e879f9", "#a3e635"];

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
    { k: "adjust", l: "Stav", i: "±" },
    { k: "prediction", l: "Predikce", i: "◇" },
    { k: "sap", l: "SAP Data", i: "↑" },
    { k: "alerts", l: `Alarmy${alerts.length ? ` (${alerts.length})` : ""}`, i: "△" },
    { k: "log", l: "Log", i: "≡" },
  ];

  if (loading) return (
    <div style={{ background: P.bg, minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <div style={{ textAlign: "center", color: P.ac }}>
        <div style={{ fontSize: 36, marginBottom: 12, animation: "pulse 1.5s infinite" }}>◎</div>
        <div style={{ fontSize: 13, fontWeight: 600 }}>Načítám data ze Supabase...</div>
      </div>
    </div>
  );

  return (
    <div style={{ minHeight: "100vh", background: P.bg }}>
      {toast && (
        <div style={{
          position: "fixed", top: 16, right: 16, padding: "12px 24px", borderRadius: 12, fontSize: 13,
          fontWeight: 700, zIndex: 999, animation: "fadeIn .3s ease",
          background: toast.type === "ok" ? P.gn : toast.type === "warn" ? P.am : P.ac, color: "#000",
          boxShadow: `0 12px 48px rgba(0,0,0,.3)`,
        }}>{toast.msg}</div>
      )}

      {saving && (
        <div style={{ position: "fixed", top: 0, left: 0, right: 0, height: 3, background: `linear-gradient(90deg, ${P.ac}, ${P.pu})`, zIndex: 1000, animation: "pulse 1s infinite" }} />
      )}

      {/* HEADER */}
      <div style={{ background: `linear-gradient(180deg,${P.sfHi},${P.sf})`, borderBottom: `1px solid ${P.bd}`, padding: "20px 28px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
            <div style={{ width: 42, height: 42, borderRadius: 12, background: `linear-gradient(135deg,${P.ac},${P.pu})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18, fontWeight: 900, color: "#fff", boxShadow: `0 4px 20px rgba(99,145,255,.3)` }}>K</div>
            <div>
              <div style={{ fontSize: 18, fontWeight: 900, color: "#fff", letterSpacing: "-0.03em" }}>Kartony Bor</div>
              <div style={{ fontSize: 10, color: P.dm, marginTop: 2, fontWeight: 500 }}>WH 8496 · Supabase live</div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            {alerts.length > 0 && <span style={{ padding: "5px 14px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: "rgba(255,77,106,.1)", color: P.rd }}>△ {alerts.length}</span>}
            <span style={{ padding: "5px 14px", borderRadius: 20, fontSize: 11, fontWeight: 700, background: P.acG, color: P.ac }}>Σ {totalStock} pal</span>
            <button onClick={loadAll} style={{ ...btnS(P.acG, P.ac), padding: "5px 12px", fontSize: 11 }}>↻ Refresh</button>
          </div>
        </div>
      </div>

      {/* TABS */}
      <div style={{ display: "flex", gap: 2, padding: "6px 28px", background: P.sf, borderBottom: `1px solid ${P.bd}`, overflowX: "auto" }}>
        {tabDefs.map((t) => (
          <button key={t.k} onClick={() => setTab(t.k)} style={{
            padding: "10px 16px", borderRadius: 8, fontSize: 12, fontWeight: tab === t.k ? 700 : 500,
            background: tab === t.k ? P.acG : "transparent", color: tab === t.k ? P.ac : P.dm,
            border: "none", cursor: "pointer", whiteSpace: "nowrap",
          }}>{t.i} {t.l}</button>
        ))}
      </div>

      <div style={{ padding: "24px 28px", maxWidth: 1360 }}>

        {/* ═══ OVERVIEW ═══ */}
        {tab === "overview" && <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(145px,1fr))", gap: 12, marginBottom: 16 }}>
            {[
              { l: "Celkem palet", v: totalStock, c: P.ac },
              { l: "Typů kartonů", v: cartons.length, c: P.pu },
              { l: "Kritických", v: enriched.filter((i) => i.ml <= CRIT && i.ml !== Infinity).length, c: P.rd },
              { l: "SAP měsíců", v: coreMonths.length, c: P.gn },
            ].map((x, i) => (
              <div key={i} style={{ ...cardS, textAlign: "center", padding: "20px 16px" }}>
                <div style={{ fontSize: 30, fontWeight: 900, color: x.c, fontVariantNumeric: "tabular-nums" }}>{x.v}</div>
                <div style={{ fontSize: 9, color: P.dm, marginTop: 4, textTransform: "uppercase", letterSpacing: "0.07em", fontWeight: 700 }}>{x.l}</div>
              </div>
            ))}
          </div>

          <div style={cardS}>
            <div style={titleS}>Zásoby podle kartonu</div>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={enriched.map((d) => ({ name: d.id.replace("CARTON-", ""), stock: d.stock }))}>
                <CartesianGrid strokeDasharray="3 3" stroke={P.bd} /><XAxis dataKey="name" tick={{ fill: P.dm, fontSize: 10 }} /><YAxis tick={{ fill: P.dm, fontSize: 10 }} />
                <Tooltip contentStyle={tipS} />
                <Bar dataKey="stock" name="Palety" radius={[6, 6, 0, 0]}>
                  {enriched.map((d, i) => <Cell key={i} fill={sColor(d.ml)} fillOpacity={0.9} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div style={cardS}>
            <div style={titleS}>Detail</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>{["Karton", "Rozměr", "ks/pal", "Sklad", "Ø ks/m", "Ø pal/m", "Zásoby", "Stav"].map((h) => <th key={h} style={thS}>{h}</th>)}</tr></thead>
                <tbody>{enriched.map((it) => (
                  <tr key={it.id}>
                    <td style={{ ...tdS, fontWeight: 700, color: P.ac }}>{it.id}</td>
                    <td style={{ ...tdS, color: P.dm, fontSize: 11 }}>{it.dim}</td>
                    <td style={tdS}>{it.pcs_per_pallet ?? "—"}</td>
                    <td style={{ ...tdS, fontWeight: 800, fontSize: 15 }}>{it.stock}</td>
                    <td style={tdS}>{it.avgPcs || "—"}</td>
                    <td style={tdS}>{it.avgPal ? it.avgPal.toFixed(2) : "—"}</td>
                    <td style={{ ...tdS, fontWeight: 700, color: sColor(it.ml) }}>{it.ml === Infinity ? "∞" : `${it.ml.toFixed(1)}m`}</td>
                    <td style={tdS}><span style={{ padding: "3px 10px", borderRadius: 20, fontSize: 10, fontWeight: 700, background: `${sColor(it.ml)}15`, color: sColor(it.ml) }}>{sLabel(it.ml)}</span></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>
        </>}

        {/* ═══ ADJUST ═══ */}
        {tab === "adjust" && <>
          <div style={{ display: "flex", gap: 10, marginBottom: 16 }}>
            <button onClick={() => { setBulkMode(!bulkMode); setBulkVals({}); }}
              style={btnS(bulkMode ? `linear-gradient(135deg,${P.rd},#cc0033)` : `linear-gradient(135deg,${P.ac},${P.pu})`)}>
              {bulkMode ? "✕ Zrušit" : "✏ Hromadná editace"}</button>
            {bulkMode && <button onClick={doBulk} style={btnS(`linear-gradient(135deg,${P.gn},#00b880)`, "#000")}>✓ Uložit</button>}
          </div>

          {bulkMode ? (
            <div style={cardS}>
              <div style={titleS}>Hromadné zadání</div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>{["Karton", "Aktuální", "Nový stav"].map((h) => <th key={h} style={thS}>{h}</th>)}</tr></thead>
                <tbody>{cartons.map((c) => (
                  <tr key={c.id}>
                    <td style={{ ...tdS, fontWeight: 700, color: P.ac }}>{c.id}</td>
                    <td style={{ ...tdS, color: P.dm }}>{stockMap[c.id] ?? 0}</td>
                    <td style={tdS}><input type="number" min="0" placeholder={String(stockMap[c.id] ?? 0)} value={bulkVals[c.id] ?? ""} onChange={(e) => setBulkVals((p) => ({ ...p, [c.id]: e.target.value }))} style={{ ...inputS, width: 80 }} /></td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          ) : (
            <div style={cardS}>
              <div style={titleS}>Rychlá úprava</div>
              <div style={{ display: "flex", gap: 10, marginBottom: 18, alignItems: "center", flexWrap: "wrap" }}>
                <select value={selId || ""} onChange={(e) => setSelId(e.target.value || null)} style={{ ...inputS, padding: "9px 12px" }}>
                  <option value="">— Karton —</option>
                  {cartons.map((d) => <option key={d.id} value={d.id}>{d.id}</option>)}
                </select>
                <input type="number" min="1" value={adjQ} onChange={(e) => setAdjQ(Math.max(1, Number(e.target.value)))} style={{ ...inputS, width: 56, padding: "9px 10px" }} />
                <button disabled={!selId} onClick={() => selId && doAdjust(selId, -adjQ)} style={{ ...btnS(`linear-gradient(135deg,${P.rd},#cc0033)`), opacity: selId ? 1 : .4 }}>− Odebrat</button>
                <button disabled={!selId} onClick={() => selId && doAdjust(selId, adjQ)} style={{ ...btnS(`linear-gradient(135deg,${P.gn},#00b880)`, "#000"), opacity: selId ? 1 : .4 }}>+ Přidat</button>
              </div>

              {selId && (() => { const it = enriched.find((d) => d.id === selId); if (!it) return null; return (
                <div style={{ padding: 14, background: P.acS, borderRadius: 10, border: `1px solid ${P.bd}`, marginBottom: 18, display: "flex", gap: 20, flexWrap: "wrap", fontSize: 12 }}>
                  <div><span style={{ color: P.dm }}>Karton:</span> <strong style={{ color: P.ac }}>{it.id}</strong></div>
                  <div><span style={{ color: P.dm }}>Sklad:</span> <strong>{it.stock} pal</strong></div>
                  <div><span style={{ color: P.dm }}>Ø:</span> <strong>{it.avgPal.toFixed(2)} pal/m</strong></div>
                  <div><span style={{ color: P.dm }}>Na:</span> <strong style={{ color: sColor(it.ml) }}>{it.ml === Infinity ? "∞" : `${it.ml.toFixed(1)}m`}</strong></div>
                </div>
              ); })()}

              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>{["Karton", "Sklad", "Akce"].map((h) => <th key={h} style={thS}>{h}</th>)}</tr></thead>
                <tbody>{enriched.map((it) => (
                  <tr key={it.id}>
                    <td style={{ ...tdS, fontWeight: 700, color: P.ac }}>{it.id}</td>
                    <td style={{ ...tdS, fontWeight: 800, fontSize: 15 }}>{it.stock}</td>
                    <td style={tdS}>
                      <div style={{ display: "flex", gap: 4 }}>
                        {[-5, -1, 1, 5].map((d) => (
                          <button key={d} onClick={() => doAdjust(it.id, d)} style={{
                            padding: "5px 10px", borderRadius: 6, fontSize: 11, fontWeight: 700, border: "none", cursor: "pointer",
                            background: d < 0 ? "rgba(255,77,106,.08)" : "rgba(0,229,160,.08)", color: d < 0 ? P.rd : P.gn,
                          }}>{d > 0 ? "+" : ""}{d}</button>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </>}

        {/* ═══ PREDICTION ═══ */}
        {tab === "prediction" && <>
          <div style={cardS}>
            <div style={titleS}>Predikce vyčerpání</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>{["Karton", "Sklad", "Ø pal/m", "Zásoby", "Vyčerpání", "Objednat (3m)"].map((h) => <th key={h} style={thS}>{h}</th>)}</tr></thead>
                <tbody>{enriched.filter((i) => i.avgPal > 0).sort((a, b) => a.ml - b.ml).map((it) => (
                  <tr key={it.id}>
                    <td style={{ ...tdS, fontWeight: 700, color: P.ac }}>{it.id}</td>
                    <td style={{ ...tdS, fontWeight: 700 }}>{it.stock}</td>
                    <td style={tdS}>{it.avgPal.toFixed(2)}</td>
                    <td style={{ ...tdS, fontWeight: 700, color: sColor(it.ml) }}>{it.ml === Infinity ? "∞" : `${it.ml.toFixed(1)}m`}</td>
                    <td style={{ ...tdS, color: it.ml <= LOW ? P.rd : P.dm }}>{it.ml < 24 ? fDate(it.dep) : "24+m"}</td>
                    <td style={{ ...tdS, fontWeight: 700, color: it.reorder > 0 ? P.am : P.gn }}>{it.reorder > 0 ? `${it.reorder} pal` : "—"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          </div>

          <div style={cardS}>
            <div style={titleS}>Prognóza 6 měsíců</div>
            <ResponsiveContainer width="100%" height={300}>
              <AreaChart data={(() => {
                const pts: any[] = [];
                for (let m = 0; m <= 6; m++) {
                  const d = new Date(); d.setMonth(d.getMonth() + m);
                  const e: any = { month: `${d.getMonth() + 1}/${d.getFullYear()}` };
                  enriched.filter((i) => i.avgPal > 0).forEach((i) => { e[i.id] = i.fc[m]?.stock ?? 0; });
                  pts.push(e);
                }
                return pts;
              })()}>
                <CartesianGrid strokeDasharray="3 3" stroke={P.bd} /><XAxis dataKey="month" tick={{ fill: P.dm, fontSize: 10 }} /><YAxis tick={{ fill: P.dm, fontSize: 10 }} />
                <Tooltip contentStyle={tipS} /><Legend wrapperStyle={{ fontSize: 10 }} />
                {enriched.filter((i) => i.avgPal > 0).map((it, idx) => (
                  <Area key={it.id} type="monotone" dataKey={it.id} stroke={chartColors[idx % chartColors.length]} fill={chartColors[idx % chartColors.length]} fillOpacity={0.05} strokeWidth={2} name={it.id} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </>}

        {/* ═══ SAP ═══ */}
        {tab === "sap" && <>
          <div style={cardS}>
            <div style={titleS}>Nahrát SAP export</div>
            <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
              <label style={{ ...btnS(`linear-gradient(135deg,${P.ac},${P.pu})`), display: "inline-block", cursor: "pointer" }}>
                📁 Vybrat LIPS.xlsx
                <input ref={fRef} type="file" accept=".xlsx,.xls" onChange={handleUpload} style={{ display: "none" }} />
              </label>
              {uploadMsg && <span style={{ fontSize: 12, fontWeight: 600, color: uploadMsg.startsWith("✓") ? P.gn : uploadMsg.startsWith("⚠") || uploadMsg.startsWith("✕") ? P.rd : P.ac }}>{uploadMsg}</span>}
            </div>
            <div style={{ marginTop: 12, fontSize: 11, color: P.dm, lineHeight: 1.8 }}>
              Nahraj měsíční LIPS export. Zpracují se sloupce <strong style={{ color: P.tx }}>Material</strong>, <strong style={{ color: P.tx }}>Delivery quantity</strong>, <strong style={{ color: P.tx }}>Material Avail. Date</strong>. Data se uloží do Supabase.
            </div>
          </div>

          <div style={cardS}>
            <div style={titleS}>Měsíční spotřeba (ks)</div>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={coreMonths.map((m) => { const e: any = { month: m }; Object.keys(sapHistory).sort().forEach((mat) => { e[mat] = sapHistory[mat][m] || 0; }); return e; })}>
                <CartesianGrid strokeDasharray="3 3" stroke={P.bd} /><XAxis dataKey="month" tick={{ fill: P.dm, fontSize: 10 }} /><YAxis tick={{ fill: P.dm, fontSize: 10 }} />
                <Tooltip contentStyle={tipS} /><Legend wrapperStyle={{ fontSize: 9 }} />
                {Object.keys(sapHistory).sort().map((mat, idx) => (
                  <Bar key={mat} dataKey={mat} fill={chartColors[idx % chartColors.length]} radius={[3, 3, 0, 0]} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>

          <div style={cardS}>
            <div style={titleS}>Detailní průměry</div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead><tr>
                  {["Karton", "Ø ks/m", "ks/pal", "Ø pal/m", ...coreMonths].map((h) => <th key={h} style={{ ...thS, fontSize: 8, whiteSpace: "nowrap" }}>{h}</th>)}
                </tr></thead>
                <tbody>{enriched.filter((i) => sapHistory[i.id]).map((it) => { const h = sapHistory[it.id] || {}; return (
                  <tr key={it.id}>
                    <td style={{ ...tdS, fontWeight: 700, color: P.ac, fontSize: 11 }}>{it.id}</td>
                    <td style={{ ...tdS, fontWeight: 600 }}>{it.avgPcs}</td>
                    <td style={tdS}>{it.pcs_per_pallet ?? "—"}</td>
                    <td style={{ ...tdS, fontWeight: 600 }}>{it.avgPal ? it.avgPal.toFixed(2) : "—"}</td>
                    {coreMonths.map((m) => <td key={m} style={{ ...tdS, color: h[m] ? P.tx : P.dm, fontVariantNumeric: "tabular-nums" }}>{h[m] || "—"}</td>)}
                  </tr>
                ); })}</tbody>
              </table>
            </div>
          </div>
        </>}

        {/* ═══ ALERTS ═══ */}
        {tab === "alerts" && <>
          <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16, flexWrap: "wrap" }}>
            <span style={{ color: P.dm, fontSize: 12, fontWeight: 600 }}>Práh:</span>
            <input type="range" min="0.5" max="4" step="0.25" value={thresh} onChange={(e) => setThresh(Number(e.target.value))} style={{ flex: 1, maxWidth: 200, accentColor: P.ac }} />
            <span style={{ color: P.ac, fontWeight: 800, fontSize: 14 }}>{thresh} měs.</span>
          </div>
          {alerts.length === 0 ? (
            <div style={{ ...cardS, textAlign: "center", padding: 50 }}>
              <div style={{ fontSize: 36, marginBottom: 8, color: P.gn }}>✓</div>
              <div style={{ fontSize: 16, fontWeight: 800, color: P.gn }}>Vše v pořádku</div>
              <div style={{ color: P.dm, marginTop: 6, fontSize: 12 }}>Žádné pod prahem {thresh} měs.</div>
            </div>
          ) : alerts.map((it) => (
            <div key={it.id} style={{ ...cardS, borderLeft: `4px solid ${sColor(it.ml)}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
                <div><div style={{ fontWeight: 800, fontSize: 15 }}>{it.id}</div><div style={{ color: P.dm, fontSize: 11 }}>{it.dim}</div></div>
                <span style={{ padding: "4px 12px", borderRadius: 20, fontSize: 10, fontWeight: 700, background: `${sColor(it.ml)}15`, color: sColor(it.ml) }}>{sLabel(it.ml)}</span>
              </div>
              <div style={{ display: "flex", gap: 20, marginTop: 12, flexWrap: "wrap", fontSize: 12 }}>
                <div><span style={{ color: P.dm }}>Sklad:</span> <strong>{it.stock}</strong> pal</div>
                <div><span style={{ color: P.dm }}>Na:</span> <strong style={{ color: sColor(it.ml) }}>{it.ml.toFixed(1)}m</strong></div>
                <div><span style={{ color: P.dm }}>Objednat:</span> <strong style={{ color: P.am }}>{it.reorder} pal</strong></div>
              </div>
            </div>
          ))}
        </>}

        {/* ═══ LOG ═══ */}
        {tab === "log" && <>
          <div style={cardS}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
              <div style={titleS}>Log změn ({logEntries.length})</div>
              <button onClick={loadAll} style={{ ...btnS(P.acG, P.ac), padding: "6px 14px", fontSize: 11 }}>↻ Refresh</button>
            </div>
            {logEntries.length === 0 ? (
              <div style={{ textAlign: "center", padding: 40, color: P.dm, fontSize: 12 }}>Zatím žádné změny</div>
            ) : (
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                <thead><tr>{["Datum", "Karton", "Změna", "Poznámka"].map((h) => <th key={h} style={thS}>{h}</th>)}</tr></thead>
                <tbody>{logEntries.map((e) => (
                  <tr key={e.id}>
                    <td style={{ ...tdS, color: P.dm, fontSize: 11 }}>{new Date(e.created_at).toLocaleString("cs-CZ")}</td>
                    <td style={{ ...tdS, fontWeight: 700, color: P.ac }}>{e.carton_id}</td>
                    <td style={{ ...tdS, fontWeight: 700, color: e.delta > 0 ? P.gn : P.rd }}>{e.delta > 0 ? "+" : ""}{e.delta} pal</td>
                    <td style={{ ...tdS, color: P.dm }}>{e.note}</td>
                  </tr>
                ))}</tbody>
              </table>
            )}
          </div>
        </>}

      </div>
    </div>
  );
}
