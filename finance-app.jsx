import { useState, useCallback, useMemo, useRef } from "react";
import {
  BarChart, Bar, LineChart, Line, PieChart, Pie, Cell,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend
} from "recharts";

// ─── MERCHANT NORMALIZATION ────────────────────────────────────────────────
const MERCHANT_RULES = [
  { keywords: ["uber"], normalized: "UBER", category: "Transportation" },
  { keywords: ["lyft"], normalized: "LYFT", category: "Transportation" },
  { keywords: ["tim horton", "timhorton"], normalized: "TIM HORTONS", category: "Food & Dining" },
  { keywords: ["starbucks"], normalized: "STARBUCKS", category: "Food & Dining" },
  { keywords: ["mcdonald", "mcdo"], normalized: "McDONALD'S", category: "Food & Dining" },
  { keywords: ["subway"], normalized: "SUBWAY", category: "Food & Dining" },
  { keywords: ["domino"], normalized: "DOMINO'S", category: "Food & Dining" },
  { keywords: ["doordash"], normalized: "DOORDASH", category: "Food & Dining" },
  { keywords: ["skip the dishes", "skipthedishes"], normalized: "SKIP THE DISHES", category: "Food & Dining" },
  { keywords: ["instacart"], normalized: "INSTACART", category: "Food & Dining" },
  { keywords: ["netflix"], normalized: "NETFLIX", category: "Subscriptions" },
  { keywords: ["spotify"], normalized: "SPOTIFY", category: "Subscriptions" },
  { keywords: ["apple.com/bill", "apple subscription"], normalized: "APPLE SUBSCRIPTIONS", category: "Subscriptions" },
  { keywords: ["amazon prime"], normalized: "AMAZON PRIME", category: "Subscriptions" },
  { keywords: ["disney"], normalized: "DISNEY+", category: "Subscriptions" },
  { keywords: ["amazon"], normalized: "AMAZON", category: "Shopping" },
  { keywords: ["walmart"], normalized: "WALMART", category: "Shopping" },
  { keywords: ["costco"], normalized: "COSTCO", category: "Shopping" },
  { keywords: ["best buy"], normalized: "BEST BUY", category: "Shopping" },
  { keywords: ["shoppers"], normalized: "SHOPPERS DRUG MART", category: "Shopping" },
  { keywords: ["payroll", "direct deposit", "salary", "paycheque", "paycheck", "employer"], normalized: "PAYROLL / SALARY", category: "Income" },
  { keywords: ["e-transfer", "etransfer", "interac"], normalized: "INTERAC E-TRANSFER", category: "Other" },
  { keywords: ["rent", "lease"], normalized: "RENT", category: "Housing" },
  { keywords: ["hydro", "electricity", "enbridge", "gas utility"], normalized: "UTILITIES", category: "Utilities" },
  { keywords: ["rogers", "bell", "telus", "fido", "freedom mobile"], normalized: "PHONE / INTERNET", category: "Utilities" },
  { keywords: ["transit", "ttc", "translink", "presto", "go train", "via rail"], normalized: "PUBLIC TRANSIT", category: "Transportation" },
  { keywords: ["parking"], normalized: "PARKING", category: "Transportation" },
  { keywords: ["gas station", "petro", "shell", "esso", "sunoco", "husky"], normalized: "GAS STATION", category: "Transportation" },
  { keywords: ["gym", "goodlife", "anytime fitness", "planet fitness"], normalized: "GYM", category: "Health & Fitness" },
  { keywords: ["pharmacy", "drug mart", "rexall"], normalized: "PHARMACY", category: "Health & Fitness" },
  { keywords: ["doctor", "dental", "clinic", "hospital", "medical"], normalized: "MEDICAL", category: "Health & Fitness" },
  { keywords: ["atm", "cash withdrawal"], normalized: "CASH WITHDRAWAL", category: "Other" },
];

function normalizeMerchant(raw) {
  const lower = raw.toLowerCase().replace(/[*_\-\.]/g, " ").replace(/\s+/g, " ").trim();
  for (const rule of MERCHANT_RULES) {
    if (rule.keywords.some(k => lower.includes(k))) {
      return { normalized: rule.normalized, category: rule.category };
    }
  }
  // Generic cleanup: strip store numbers, location suffixes
  let cleaned = raw
    .replace(/#\d+/g, "")
    .replace(/\b\d{4,}\b/g, "")
    .replace(/\b(store|branch|location|inc|ltd|corp|co)\b/gi, "")
    .replace(/[*]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return { normalized: cleaned || raw.toUpperCase(), category: "Other" };
}

// ─── CSV / EXCEL PARSER ────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.replace(/"/g, "").trim().toLowerCase());
  const dateIdx = headers.findIndex(h => h.includes("date"));
  const descIdx = headers.findIndex(h => h.includes("desc") || h.includes("merchant") || h.includes("payee") || h.includes("narration"));
  const amtIdx = headers.findIndex(h => h.includes("amount") || h.includes("debit") || h.includes("credit"));
  if (dateIdx === -1 || descIdx === -1 || amtIdx === -1) return null;

  return lines.slice(1).map(line => {
    const cols = line.match(/(".*?"|[^,]+)(?=,|$)/g)?.map(c => c.replace(/"/g, "").trim()) || [];
    const rawAmt = cols[amtIdx] || "0";
    const amt = parseFloat(rawAmt.replace(/[$,\s]/g, "")) || 0;
    return {
      date: cols[dateIdx] || "",
      raw_description: cols[descIdx] || "",
      amount: amt,
    };
  }).filter(t => t.raw_description && t.amount !== 0);
}

// ─── PROCESS TRANSACTIONS ─────────────────────────────────────────────────
function processTransactions(raw) {
  // Normalize
  const normalized = raw.map(t => {
    const { normalized, category } = normalizeMerchant(t.raw_description);
    return { ...t, normalized_merchant: normalized, category };
  });

  // Group by month
  const byMonth = {};
  for (const t of normalized) {
    const d = new Date(t.date);
    if (isNaN(d)) continue;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
    if (!byMonth[key]) byMonth[key] = [];
    byMonth[key].push(t);
  }

  // For each month aggregate
  const months = {};
  for (const [monthKey, txns] of Object.entries(byMonth)) {
    const aggregated = {};
    for (const t of txns) {
      const k = t.normalized_merchant;
      if (!aggregated[k]) {
        aggregated[k] = {
          merchant: k,
          total_amount: 0,
          transaction_count: 0,
          category: t.category,
          type: t.amount >= 0 ? "deposit" : "withdrawal",
          raw: [],
        };
      }
      aggregated[k].total_amount += t.amount;
      aggregated[k].transaction_count++;
      aggregated[k].raw.push(t);
      // Recalculate type after all transactions are summed
    }
    // Fix type after sum
    for (const v of Object.values(aggregated)) {
      v.type = v.total_amount >= 0 ? "deposit" : "withdrawal";
    }

    const agg = Object.values(aggregated);
    const deposits = agg.filter(a => a.type === "deposit");
    const withdrawals = agg.filter(a => a.type === "withdrawal");
    const totalDeposits = deposits.reduce((s, a) => s + a.total_amount, 0);
    const totalWithdrawals = withdrawals.reduce((s, a) => s + Math.abs(a.total_amount), 0);

    months[monthKey] = {
      key: monthKey,
      label: new Date(monthKey + "-01").toLocaleDateString("en-CA", { month: "long", year: "numeric" }),
      transactions: txns,
      aggregated: agg,
      deposits,
      withdrawals,
      largeDeposits: deposits.filter(a => a.total_amount > 200),
      largeWithdrawals: withdrawals.filter(a => Math.abs(a.total_amount) > 200),
      totalDeposits,
      totalWithdrawals,
      netCashFlow: totalDeposits - totalWithdrawals,
      categoryBreakdown: buildCategoryBreakdown(withdrawals),
    };
  }
  return months;
}

function buildCategoryBreakdown(withdrawals) {
  const cats = {};
  for (const w of withdrawals) {
    const cat = w.category || "Other";
    cats[cat] = (cats[cat] || 0) + Math.abs(w.total_amount);
  }
  return Object.entries(cats)
    .map(([name, value]) => ({ name, value }))
    .sort((a, b) => b.value - a.value);
}

// ─── SAMPLE DATA ──────────────────────────────────────────────────────────
const SAMPLE_DATA = `Date,Description,Amount
2026-01-02,PAYROLL DIRECT DEPOSIT,3200.00
2026-01-03,STARBUCKS STORE 1234,-5.75
2026-01-04,UBER*TRIP,-14.20
2026-01-05,NETFLIX.COM,-18.99
2026-01-06,AMAZON MKTPLACE,-67.45
2026-01-07,STARBUCKS TORONTO,-6.50
2026-01-08,TIM HORTONS #4532,-4.25
2026-01-09,UBER BV,-22.10
2026-01-10,WALMART SUPERCENTRE,-134.22
2026-01-12,RENT PAYMENT,-1500.00
2026-01-14,ROGERS COMMUNICATIONS,-85.00
2026-01-15,SPOTIFY PREMIUM,-11.99
2026-01-16,INSTACART,-89.34
2026-01-18,MCDONALD'S #2213,-12.40
2026-01-20,INTERAC E-TRANSFER RECEIVED,250.00
2026-01-22,UBER CANADA,-18.75
2026-01-24,GOODLIFE FITNESS,-49.99
2026-01-25,STARBUCKS COFFEE,-5.25
2026-01-26,BEST BUY STORE 812,-299.00
2026-01-28,DOMINO'S PIZZA,-34.50
2026-01-30,ENBRIDGE GAS,-78.33
2026-02-01,PAYROLL DIRECT DEPOSIT,3200.00
2026-02-02,STARBUCKS TORONTO,-7.00
2026-02-03,TIM HORTONS #4532,-4.50
2026-02-04,NETFLIX.COM,-18.99
2026-02-05,AMAZON MKTPLACE,-43.20
2026-02-06,UBER*TRIP,-11.50
2026-02-08,COSTCO WHOLESALE,-212.88
2026-02-10,RENT PAYMENT,-1500.00
2026-02-11,ROGERS COMMUNICATIONS,-85.00
2026-02-12,SPOTIFY PREMIUM,-11.99
2026-02-14,DOORDASH,-41.22
2026-02-15,WALMART SUPERCENTRE,-98.77
2026-02-16,INTERAC E-TRANSFER RECEIVED,180.00
2026-02-18,MCDONALD'S #2213,-9.80
2026-02-20,UBER CANADA,-16.40
2026-02-22,GOODLIFE FITNESS,-49.99
2026-02-24,SHOPPERS DRUG MART,-28.44
2026-02-25,DISNEY PLUS,-13.99
2026-02-26,STARBUCKS STORE 5512,-6.25
2026-02-28,HYDRO ONE,-94.10
2026-03-01,PAYROLL DIRECT DEPOSIT,3200.00
2026-03-03,STARBUCKS TORONTO,-6.75
2026-03-04,UBER*TRIP,-19.00
2026-03-05,NETFLIX.COM,-18.99
2026-03-06,AMAZON PRIME,-9.99
2026-03-07,TIM HORTONS #4532,-3.75
2026-03-09,WALMART SUPERCENTRE,-156.34
2026-03-10,RENT PAYMENT,-1500.00
2026-03-12,ROGERS COMMUNICATIONS,-85.00
2026-03-13,SPOTIFY PREMIUM,-11.99
2026-03-14,INSTACART,-72.55
2026-03-15,INTERAC E-TRANSFER RECEIVED,300.00
2026-03-16,MCDONALD'S #2213,-14.20
2026-03-18,UBER CANADA,-13.80
2026-03-20,GOODLIFE FITNESS,-49.99
2026-03-21,APPLE.COM/BILL,-4.99
2026-03-22,DOMINO'S PIZZA,-28.00
2026-03-25,BEST BUY STORE 812,-149.99
2026-03-26,STARBUCKS COFFEE,-5.50
2026-03-28,ENBRIDGE GAS,-65.20
2026-03-30,SHOPPERS DRUG MART,-19.88`;

// ─── COLORS ───────────────────────────────────────────────────────────────
const PALETTE = {
  bg: "#0a0f1a",
  surface: "#111827",
  card: "#161f2e",
  border: "#1e2d42",
  accent: "#00d4aa",
  accentDim: "#00d4aa22",
  green: "#22c55e",
  red: "#ef4444",
  amber: "#f59e0b",
  blue: "#3b82f6",
  text: "#e2e8f0",
  muted: "#64748b",
  gold: "#fbbf24",
};

const CAT_COLORS = [
  "#00d4aa","#3b82f6","#f59e0b","#ef4444","#a855f7",
  "#22c55e","#ec4899","#14b8a6","#f97316","#6366f1"
];

// ─── FMT ──────────────────────────────────────────────────────────────────
const fmt = (n) => new Intl.NumberFormat("en-CA", { style: "currency", currency: "CAD", maximumFractionDigits: 2 }).format(n);

// ─── COMPONENTS ──────────────────────────────────────────────────────────

function StatCard({ label, value, sub, color = PALETTE.accent, icon }) {
  return (
    <div style={{
      background: PALETTE.card,
      border: `1px solid ${PALETTE.border}`,
      borderRadius: 12,
      padding: "20px 24px",
      display: "flex",
      flexDirection: "column",
      gap: 6,
      position: "relative",
      overflow: "hidden",
    }}>
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0, height: 2,
        background: `linear-gradient(90deg, ${color}, transparent)`
      }} />
      <div style={{ color: PALETTE.muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 2, fontWeight: 600 }}>{label}</div>
      <div style={{ color, fontSize: 26, fontWeight: 700, fontFamily: "monospace" }}>{value}</div>
      {sub && <div style={{ color: PALETTE.muted, fontSize: 12 }}>{sub}</div>}
    </div>
  );
}

function TransactionTable({ data, type }) {
  const [editingCat, setEditingCat] = useState(null);
  const [categories, setCategories] = useState({});
  const CATS = ["Food & Dining","Transportation","Shopping","Subscriptions","Housing","Income","Utilities","Health & Fitness","Entertainment","Other"];
  const color = type === "deposit" ? PALETTE.green : PALETTE.red;

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ borderBottom: `1px solid ${PALETTE.border}` }}>
            {["Merchant","Category","Count","Amount"].map(h => (
              <th key={h} style={{ padding: "8px 12px", textAlign: h === "Amount" || h === "Count" ? "right" : "left", color: PALETTE.muted, fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.sort((a,b) => Math.abs(b.total_amount) - Math.abs(a.total_amount)).map((row, i) => (
            <tr key={i} style={{ borderBottom: `1px solid ${PALETTE.border}22` }}>
              <td style={{ padding: "10px 12px", color: PALETTE.text, fontWeight: 500 }}>{row.merchant}</td>
              <td style={{ padding: "10px 12px" }}>
                {editingCat === i ? (
                  <select
                    autoFocus
                    defaultValue={categories[i] || row.category}
                    onChange={e => { setCategories({...categories, [i]: e.target.value}); setEditingCat(null); }}
                    onBlur={() => setEditingCat(null)}
                    style={{ background: PALETTE.surface, color: PALETTE.text, border: `1px solid ${PALETTE.accent}`, borderRadius: 6, padding: "3px 8px", fontSize: 12 }}
                  >
                    {CATS.map(c => <option key={c}>{c}</option>)}
                  </select>
                ) : (
                  <span
                    onClick={() => setEditingCat(i)}
                    style={{
                      background: PALETTE.accentDim, color: PALETTE.accent,
                      borderRadius: 20, padding: "2px 10px", fontSize: 11, cursor: "pointer",
                      whiteSpace: "nowrap"
                    }}
                    title="Click to edit category"
                  >
                    {categories[i] || row.category}
                  </span>
                )}
              </td>
              <td style={{ padding: "10px 12px", textAlign: "right", color: PALETTE.muted }}>{row.transaction_count}×</td>
              <td style={{ padding: "10px 12px", textAlign: "right", color, fontFamily: "monospace", fontWeight: 600 }}>
                {type === "withdrawal" ? "-" : "+"}{fmt(Math.abs(row.total_amount))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function LargeTransactionBadge({ items, type }) {
  if (!items.length) return <div style={{ color: PALETTE.muted, fontSize: 13 }}>None this month.</div>;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {items.sort((a,b) => Math.abs(b.total_amount) - Math.abs(a.total_amount)).map((item, i) => (
        <div key={i} style={{
          display: "flex", justifyContent: "space-between", alignItems: "center",
          background: type === "deposit" ? "#22c55e11" : "#ef444411",
          border: `1px solid ${type === "deposit" ? PALETTE.green : PALETTE.red}44`,
          borderRadius: 8, padding: "10px 16px"
        }}>
          <div>
            <div style={{ color: PALETTE.text, fontWeight: 600, fontSize: 14 }}>{item.merchant}</div>
            <div style={{ color: PALETTE.muted, fontSize: 11 }}>{item.category} · {item.transaction_count} txn{item.transaction_count > 1 ? "s" : ""}</div>
          </div>
          <div style={{ color: type === "deposit" ? PALETTE.green : PALETTE.red, fontFamily: "monospace", fontWeight: 700, fontSize: 16 }}>
            {type === "deposit" ? "+" : "-"}{fmt(Math.abs(item.total_amount))}
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────
export default function App() {
  const [months, setMonths] = useState({});
  const [selectedMonth, setSelectedMonth] = useState(null);
  const [tab, setTab] = useState("dashboard");
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef();

  const monthKeys = useMemo(() => Object.keys(months).sort().reverse(), [months]);

  const loadData = useCallback((text) => {
    setError(null);
    const rows = parseCSV(text);
    if (!rows) { setError("Could not parse CSV. Ensure columns: Date, Description, Amount"); return; }
    if (!rows.length) { setError("No valid transactions found."); return; }
    const processed = processTransactions(rows);
    setMonths(processed);
    const keys = Object.keys(processed).sort().reverse();
    setSelectedMonth(keys[0] || null);
    setTab("dashboard");
  }, []);

  const handleFile = useCallback((file) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = e => loadData(e.target.result);
    reader.readAsText(file);
  }, [loadData]);

  const month = selectedMonth ? months[selectedMonth] : null;

  // Cash flow trend data
  const cashFlowTrend = useMemo(() => {
    return Object.keys(months).sort().map(k => ({
      month: months[k].label.split(" ")[0].slice(0, 3),
      income: +months[k].totalDeposits.toFixed(2),
      spending: +months[k].totalWithdrawals.toFixed(2),
      net: +months[k].netCashFlow.toFixed(2),
    }));
  }, [months]);

  // Insights
  const insights = useMemo(() => {
    if (!month) return [];
    const topCat = month.categoryBreakdown[0];
    const topMerchant = [...month.withdrawals].sort((a,b) => Math.abs(b.total_amount) - Math.abs(a.total_amount))[0];
    const bigDeposit = [...month.deposits].sort((a,b) => b.total_amount - a.total_amount)[0];
    return [
      topCat && { icon: "🏆", label: "Top spending category", value: `${topCat.name} — ${fmt(topCat.value)}` },
      topMerchant && { icon: "💸", label: "Largest withdrawal", value: `${topMerchant.merchant} — ${fmt(Math.abs(topMerchant.total_amount))}` },
      bigDeposit && { icon: "💰", label: "Largest deposit", value: `${bigDeposit.merchant} — ${fmt(bigDeposit.total_amount)}` },
      { icon: month.netCashFlow >= 0 ? "📈" : "📉", label: "Net cash flow", value: fmt(month.netCashFlow), positive: month.netCashFlow >= 0 },
    ].filter(Boolean);
  }, [month]);

  return (
    <div style={{
      minHeight: "100vh", background: PALETTE.bg, color: PALETTE.text,
      fontFamily: "'DM Sans', 'Segoe UI', sans-serif",
    }}>
      {/* Google Font */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@300;400;500;600;700&family=DM+Mono&display=swap');
        * { box-sizing: border-box; }
        ::-webkit-scrollbar { width: 6px; height: 6px; }
        ::-webkit-scrollbar-track { background: ${PALETTE.bg}; }
        ::-webkit-scrollbar-thumb { background: ${PALETTE.border}; border-radius: 3px; }
        select option { background: #1e293b; }
      `}</style>

      {/* HEADER */}
      <div style={{
        background: PALETTE.surface, borderBottom: `1px solid ${PALETTE.border}`,
        padding: "0 32px", display: "flex", alignItems: "center", justifyContent: "space-between",
        height: 64, position: "sticky", top: 0, zIndex: 100
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 8,
            background: `linear-gradient(135deg, ${PALETTE.accent}, #0088cc)`,
            display: "flex", alignItems: "center", justifyContent: "center",
            fontSize: 16, fontWeight: 800, color: "#000"
          }}>₿</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16, letterSpacing: -0.5 }}>FinLens</div>
            <div style={{ color: PALETTE.muted, fontSize: 11 }}>Personal Finance Analyzer</div>
          </div>
        </div>
        {monthKeys.length > 0 && (
          <div style={{ display: "flex", gap: 6 }}>
            {["dashboard","transactions","insights"].map(t => (
              <button key={t} onClick={() => setTab(t)} style={{
                background: tab === t ? PALETTE.accent : "transparent",
                color: tab === t ? "#000" : PALETTE.muted,
                border: `1px solid ${tab === t ? PALETTE.accent : PALETTE.border}`,
                borderRadius: 8, padding: "6px 14px", cursor: "pointer",
                fontSize: 13, fontWeight: 600, textTransform: "capitalize",
                transition: "all 0.15s"
              }}>{t}</button>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: "flex", maxWidth: 1400, margin: "0 auto", padding: 24, gap: 24 }}>
        {/* SIDEBAR */}
        {monthKeys.length > 0 && (
          <div style={{ width: 200, flexShrink: 0 }}>
            <div style={{ position: "sticky", top: 88 }}>
              <div style={{ color: PALETTE.muted, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 2, marginBottom: 10 }}>Months</div>
              {monthKeys.map(k => (
                <button key={k} onClick={() => setSelectedMonth(k)} style={{
                  width: "100%", textAlign: "left", background: selectedMonth === k ? PALETTE.accentDim : "transparent",
                  border: `1px solid ${selectedMonth === k ? PALETTE.accent : "transparent"}`,
                  borderRadius: 8, padding: "10px 12px", cursor: "pointer", marginBottom: 4,
                  color: selectedMonth === k ? PALETTE.accent : PALETTE.text, fontSize: 13, fontWeight: 500
                }}>{months[k].label}</button>
              ))}
              <div style={{ marginTop: 16, borderTop: `1px solid ${PALETTE.border}`, paddingTop: 16 }}>
                <button onClick={() => fileRef.current?.click()} style={{
                  width: "100%", background: "transparent", border: `1px dashed ${PALETTE.border}`,
                  borderRadius: 8, padding: "8px 12px", cursor: "pointer", color: PALETTE.muted,
                  fontSize: 12, fontWeight: 500
                }}>+ Import CSV</button>
                <input ref={fileRef} type="file" accept=".csv,.txt" style={{ display: "none" }}
                  onChange={e => handleFile(e.target.files[0])} />
              </div>
            </div>
          </div>
        )}

        {/* MAIN CONTENT */}
        <div style={{ flex: 1, minWidth: 0 }}>
          {/* UPLOAD SCREEN */}
          {monthKeys.length === 0 && (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "60vh", gap: 32 }}>
              <div style={{ textAlign: "center" }}>
                <div style={{ fontSize: 48, marginBottom: 12 }}>📊</div>
                <div style={{ fontSize: 28, fontWeight: 700, letterSpacing: -1, marginBottom: 8 }}>Welcome to FinLens</div>
                <div style={{ color: PALETTE.muted, fontSize: 15, maxWidth: 420 }}>Upload your bank CSV to automatically analyze, categorize, and visualize your spending.</div>
              </div>
              <div
                onDragOver={e => { e.preventDefault(); setDragOver(true); }}
                onDragLeave={() => setDragOver(false)}
                onDrop={e => { e.preventDefault(); setDragOver(false); handleFile(e.dataTransfer.files[0]); }}
                style={{
                  border: `2px dashed ${dragOver ? PALETTE.accent : PALETTE.border}`,
                  borderRadius: 16, padding: "40px 60px", textAlign: "center", cursor: "pointer",
                  background: dragOver ? PALETTE.accentDim : PALETTE.card,
                  transition: "all 0.2s", minWidth: 340
                }}
                onClick={() => fileRef.current?.click()}
              >
                <div style={{ fontSize: 32, marginBottom: 10 }}>📁</div>
                <div style={{ fontWeight: 600, marginBottom: 4 }}>Drop your CSV here</div>
                <div style={{ color: PALETTE.muted, fontSize: 13 }}>or click to browse</div>
                <div style={{ color: PALETTE.muted, fontSize: 11, marginTop: 8 }}>Supports: CSV with Date, Description, Amount columns</div>
                <input ref={fileRef} type="file" accept=".csv,.txt" style={{ display: "none" }}
                  onChange={e => handleFile(e.target.files[0])} />
              </div>
              {error && <div style={{ color: PALETTE.red, fontSize: 13, background: "#ef444411", border: `1px solid ${PALETTE.red}44`, borderRadius: 8, padding: "10px 16px" }}>{error}</div>}
              <button onClick={() => loadData(SAMPLE_DATA)} style={{
                background: "transparent", border: `1px solid ${PALETTE.border}`,
                color: PALETTE.muted, borderRadius: 8, padding: "10px 20px",
                cursor: "pointer", fontSize: 13, fontWeight: 500
              }}>Load sample data (Jan–Mar 2026)</button>
            </div>
          )}

          {/* DASHBOARD TAB */}
          {month && tab === "dashboard" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 24 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>{month.label}</div>
                <div style={{ color: PALETTE.muted, fontSize: 13 }}>{month.transactions.length} transactions · {month.aggregated.length} unique merchants</div>
              </div>

              {/* STAT CARDS */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
                <StatCard label="Total Deposits" value={fmt(month.totalDeposits)} color={PALETTE.green} />
                <StatCard label="Total Withdrawals" value={fmt(month.totalWithdrawals)} color={PALETTE.red} />
                <StatCard label="Net Cash Flow" value={fmt(month.netCashFlow)} color={month.netCashFlow >= 0 ? PALETTE.green : PALETTE.red} />
                <StatCard label="Largest Expense" value={month.largeWithdrawals[0] ? fmt(Math.abs(month.largeWithdrawals[0].total_amount)) : "—"} color={PALETTE.amber} sub={month.largeWithdrawals[0]?.merchant} />
              </div>

              {/* CHARTS */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                {/* Category Pie */}
                <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
                  <div style={{ fontWeight: 600, marginBottom: 16, fontSize: 14 }}>Spending by Category</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <PieChart>
                      <Pie data={month.categoryBreakdown} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} label={({ name, percent }) => `${name} ${(percent*100).toFixed(0)}%`} labelLine={{ stroke: PALETTE.muted }}>
                        {month.categoryBreakdown.map((_, i) => <Cell key={i} fill={CAT_COLORS[i % CAT_COLORS.length]} />)}
                      </Pie>
                      <Tooltip formatter={(v) => fmt(v)} contentStyle={{ background: PALETTE.surface, border: `1px solid ${PALETTE.border}`, borderRadius: 8, fontSize: 12 }} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>

                {/* Income vs Spending Bar */}
                <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
                  <div style={{ fontWeight: 600, marginBottom: 16, fontSize: 14 }}>Monthly Cash Flow Trend</div>
                  <ResponsiveContainer width="100%" height={220}>
                    <BarChart data={cashFlowTrend} barGap={4}>
                      <CartesianGrid strokeDasharray="3 3" stroke={PALETTE.border} />
                      <XAxis dataKey="month" tick={{ fill: PALETTE.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                      <YAxis tick={{ fill: PALETTE.muted, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => `$${(v/1000).toFixed(1)}k`} />
                      <Tooltip formatter={(v) => fmt(v)} contentStyle={{ background: PALETTE.surface, border: `1px solid ${PALETTE.border}`, borderRadius: 8, fontSize: 12 }} />
                      <Legend wrapperStyle={{ fontSize: 12, color: PALETTE.muted }} />
                      <Bar dataKey="income" name="Income" fill={PALETTE.green} radius={[4,4,0,0]} />
                      <Bar dataKey="spending" name="Spending" fill={PALETTE.red} radius={[4,4,0,0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Net cash flow line */}
              <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 16, fontSize: 14 }}>Net Cash Flow by Month</div>
                <ResponsiveContainer width="100%" height={160}>
                  <LineChart data={cashFlowTrend}>
                    <CartesianGrid strokeDasharray="3 3" stroke={PALETTE.border} />
                    <XAxis dataKey="month" tick={{ fill: PALETTE.muted, fontSize: 11 }} axisLine={false} tickLine={false} />
                    <YAxis tick={{ fill: PALETTE.muted, fontSize: 11 }} axisLine={false} tickLine={false} tickFormatter={v => fmt(v)} />
                    <Tooltip formatter={(v) => fmt(v)} contentStyle={{ background: PALETTE.surface, border: `1px solid ${PALETTE.border}`, borderRadius: 8, fontSize: 12 }} />
                    <Line type="monotone" dataKey="net" stroke={PALETTE.accent} strokeWidth={2} dot={{ fill: PALETTE.accent, r: 4 }} name="Net" />
                  </LineChart>
                </ResponsiveContainer>
              </div>

              {/* Large Transactions */}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
                <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                    <span style={{ fontSize: 16 }}>⬆️</span>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>Large Deposits (&gt;$200)</span>
                    <span style={{ marginLeft: "auto", background: "#22c55e22", color: PALETTE.green, borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 600 }}>{month.largeDeposits.length}</span>
                  </div>
                  <LargeTransactionBadge items={month.largeDeposits} type="deposit" />
                </div>
                <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                    <span style={{ fontSize: 16 }}>⬇️</span>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>Large Withdrawals (&gt;$200)</span>
                    <span style={{ marginLeft: "auto", background: "#ef444422", color: PALETTE.red, borderRadius: 20, padding: "2px 10px", fontSize: 11, fontWeight: 600 }}>{month.largeWithdrawals.length}</span>
                  </div>
                  <LargeTransactionBadge items={month.largeWithdrawals} type="withdrawal" />
                </div>
              </div>
            </div>
          )}

          {/* TRANSACTIONS TAB */}
          {month && tab === "transactions" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>{month.label} — Transactions</div>
                <div style={{ color: PALETTE.muted, fontSize: 13 }}>Aggregated by normalized merchant name · Click category to edit</div>
              </div>
              <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: PALETTE.green }} />
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Deposits</div>
                  <div style={{ marginLeft: "auto", color: PALETTE.green, fontFamily: "monospace", fontWeight: 700 }}>{fmt(month.totalDeposits)}</div>
                </div>
                <TransactionTable data={month.deposits} type="deposit" />
              </div>
              <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 14 }}>
                  <div style={{ width: 8, height: 8, borderRadius: "50%", background: PALETTE.red }} />
                  <div style={{ fontWeight: 600, fontSize: 14 }}>Withdrawals</div>
                  <div style={{ marginLeft: "auto", color: PALETTE.red, fontFamily: "monospace", fontWeight: 700 }}>-{fmt(month.totalWithdrawals)}</div>
                </div>
                <TransactionTable data={month.withdrawals} type="withdrawal" />
              </div>
              {/* Summary row */}
              <div style={{
                background: PALETTE.card, border: `1px solid ${PALETTE.border}`,
                borderRadius: 12, padding: "16px 20px",
                display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 12
              }}>
                {[
                  { label: "Total Deposits", value: fmt(month.totalDeposits), color: PALETTE.green },
                  { label: "Total Withdrawals", value: "-" + fmt(month.totalWithdrawals), color: PALETTE.red },
                  { label: "Net Cash Flow", value: fmt(month.netCashFlow), color: month.netCashFlow >= 0 ? PALETTE.green : PALETTE.red },
                ].map(s => (
                  <div key={s.label} style={{ textAlign: "center" }}>
                    <div style={{ color: PALETTE.muted, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, marginBottom: 4 }}>{s.label}</div>
                    <div style={{ color: s.color, fontFamily: "monospace", fontWeight: 700, fontSize: 18 }}>{s.value}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* INSIGHTS TAB */}
          {month && tab === "insights" && (
            <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
              <div>
                <div style={{ fontSize: 22, fontWeight: 700, letterSpacing: -0.5 }}>{month.label} — Insights</div>
                <div style={{ color: PALETTE.muted, fontSize: 13 }}>Automated financial analysis</div>
              </div>

              {/* Key Insights */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
                {insights.map((ins, i) => (
                  <div key={i} style={{
                    background: PALETTE.card, border: `1px solid ${PALETTE.border}`,
                    borderRadius: 12, padding: "18px 20px"
                  }}>
                    <div style={{ fontSize: 24, marginBottom: 8 }}>{ins.icon}</div>
                    <div style={{ color: PALETTE.muted, fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: 1, marginBottom: 6 }}>{ins.label}</div>
                    <div style={{ color: ins.positive === false ? PALETTE.red : ins.positive === true ? PALETTE.green : PALETTE.text, fontWeight: 700, fontSize: 15 }}>{ins.value}</div>
                  </div>
                ))}
              </div>

              {/* Category breakdown table */}
              <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 16, fontSize: 14 }}>Spending by Category</div>
                {month.categoryBreakdown.map((cat, i) => {
                  const pct = (cat.value / month.totalWithdrawals) * 100;
                  return (
                    <div key={i} style={{ marginBottom: 12 }}>
                      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4, fontSize: 13 }}>
                        <span style={{ color: PALETTE.text }}>{cat.name}</span>
                        <span style={{ color: PALETTE.muted, fontFamily: "monospace" }}>{fmt(cat.value)} · {pct.toFixed(1)}%</span>
                      </div>
                      <div style={{ height: 6, background: PALETTE.border, borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ height: "100%", width: `${pct}%`, background: CAT_COLORS[i % CAT_COLORS.length], borderRadius: 3, transition: "width 0.6s ease" }} />
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Top merchants */}
              <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 16, fontSize: 14 }}>Top 10 Merchants by Spend</div>
                <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                  {[...month.withdrawals]
                    .sort((a,b) => Math.abs(b.total_amount) - Math.abs(a.total_amount))
                    .slice(0, 10)
                    .map((m, i) => (
                      <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ width: 22, height: 22, borderRadius: "50%", background: CAT_COLORS[i % CAT_COLORS.length] + "33", color: CAT_COLORS[i % CAT_COLORS.length], fontSize: 11, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>{i+1}</div>
                          <div>
                            <div style={{ fontSize: 13, fontWeight: 500 }}>{m.merchant}</div>
                            <div style={{ fontSize: 11, color: PALETTE.muted }}>{m.category} · {m.transaction_count} txn{m.transaction_count > 1 ? "s" : ""}</div>
                          </div>
                        </div>
                        <div style={{ color: PALETTE.red, fontFamily: "monospace", fontWeight: 700, fontSize: 14 }}>-{fmt(Math.abs(m.total_amount))}</div>
                      </div>
                    ))}
                </div>
              </div>

              {/* All months comparison */}
              {monthKeys.length > 1 && (
                <div style={{ background: PALETTE.card, border: `1px solid ${PALETTE.border}`, borderRadius: 12, padding: 20 }}>
                  <div style={{ fontWeight: 600, marginBottom: 16, fontSize: 14 }}>Monthly Summary Comparison</div>
                  <div style={{ overflowX: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                      <thead>
                        <tr style={{ borderBottom: `1px solid ${PALETTE.border}` }}>
                          {["Month","Deposits","Withdrawals","Net Flow","# Txns"].map(h => (
                            <th key={h} style={{ padding: "8px 12px", textAlign: h === "Month" ? "left" : "right", color: PALETTE.muted, fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: 1 }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {monthKeys.map(k => {
                          const m = months[k];
                          return (
                            <tr key={k} style={{ borderBottom: `1px solid ${PALETTE.border}22`, background: k === selectedMonth ? PALETTE.accentDim : "transparent" }}>
                              <td style={{ padding: "10px 12px", fontWeight: k === selectedMonth ? 600 : 400 }}>{m.label}</td>
                              <td style={{ padding: "10px 12px", textAlign: "right", color: PALETTE.green, fontFamily: "monospace" }}>{fmt(m.totalDeposits)}</td>
                              <td style={{ padding: "10px 12px", textAlign: "right", color: PALETTE.red, fontFamily: "monospace" }}>-{fmt(m.totalWithdrawals)}</td>
                              <td style={{ padding: "10px 12px", textAlign: "right", color: m.netCashFlow >= 0 ? PALETTE.green : PALETTE.red, fontFamily: "monospace", fontWeight: 600 }}>{fmt(m.netCashFlow)}</td>
                              <td style={{ padding: "10px 12px", textAlign: "right", color: PALETTE.muted }}>{m.transactions.length}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
