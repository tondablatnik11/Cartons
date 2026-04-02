import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

export const supabase = createClient(supabaseUrl, supabaseKey);

// ── Data fetching ──

export async function fetchCartons() {
  const { data, error } = await supabase
    .from("cartons")
    .select("id, dim, pcs_per_pallet, article_num")
    .order("id");
  if (error) throw error;
  return data;
}

export async function fetchStock() {
  const { data, error } = await supabase
    .from("stock")
    .select("carton_id, current_stock");
  if (error) throw error;
  return Object.fromEntries((data || []).map((r) => [r.carton_id, r.current_stock]));
}

export async function fetchSapConsumption() {
  const { data, error } = await supabase
    .from("sap_consumption")
    .select("carton_id, month, quantity")
    .order("month");
  if (error) throw error;
  const result: Record<string, Record<string, number>> = {};
  for (const row of data || []) {
    if (!result[row.carton_id]) result[row.carton_id] = {};
    result[row.carton_id][row.month] = row.quantity;
  }
  return result;
}

export async function fetchChangeLog(limit = 100) {
  const { data, error } = await supabase
    .from("change_log")
    .select("id, carton_id, delta, note, created_at")
    .order("created_at", { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data;
}

// ── Mutations ──

export async function updateStock(cartonId: string, newStock: number) {
  const { error } = await supabase
    .from("stock")
    .upsert({ carton_id: cartonId, current_stock: newStock, updated_at: new Date().toISOString() }, { onConflict: "carton_id" });
  if (error) throw error;
}

export async function addChangeLog(cartonId: string, delta: number, note = "") {
  const { error } = await supabase
    .from("change_log")
    .insert({ carton_id: cartonId, delta, note });
  if (error) throw error;
}

export async function upsertSapData(rows: { carton_id: string; month: string; quantity: number }[]) {
  const { error } = await supabase
    .from("sap_consumption")
    .upsert(rows, { onConflict: "carton_id,month" });
  if (error) throw error;
}

export async function bulkUpdateStock(updates: { carton_id: string; current_stock: number }[]) {
  const promises = updates.map((u) =>
    supabase.from("stock").upsert(
      { carton_id: u.carton_id, current_stock: u.current_stock, updated_at: new Date().toISOString() },
      { onConflict: "carton_id" }
    )
  );
  await Promise.all(promises);
}
