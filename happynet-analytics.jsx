import React, { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import Papa from 'papaparse';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Legend,
  ResponsiveContainer, LineChart, Line
} from 'recharts';
import {
  LayoutDashboard, Users, PieChart as PieIcon, GitBranch, RefreshCw,
  DollarSign, Upload, AlertTriangle, CheckCircle2, Search, Trash2,
  Info, ChevronLeft, ChevronRight, ArrowUpDown, FileWarning, Loader2,
  Sparkles, Send, StickyNote, X, TrendingUp, Bot, User as UserIcon, Plus, History, FileDown
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Constants / thresholds (documented — see "About the numbers" panel in-app)
// ---------------------------------------------------------------------------
const HOTSPOT_MAX = 69;
const GROWTH_THRESHOLD = 0.15;
const DECLINE_THRESHOLD = -0.15;
const TIER_CASUAL_MAX = 69;
const TIER_DEVELOPING_MAX = 249;
const TIER_ACTIVE_MAX = 719;
const TIER_HIGHVALUE_MAX = 1999;
const PAGE_SIZE = 50;

const STATUS_LIST = ['New', 'Retained', 'Growing', 'Stable', 'Declining', 'Not yet due', 'Inactive/Churn-risk'];
const SEGMENT_LIST = ['Casual', 'Developing', 'Active', 'High Value', 'VIP', 'Inactive (no spend this period)'];
const BEHAVIOUR_LIST = ['Hotspot Only', 'PPOE Only', 'Mixed', 'No activity'];
const OPPORTUNITY_COLORS = {
  'Win-back outreach': '#B0432E',
  'Retention call': '#C2792E',
  'Upsell to PPOE plan': '#2F6E63',
  'Upgrade to higher PPOE bundle': '#2F6E63',
  'Onboarding / welcome offer': '#4B5A6A',
  'Payment reminder': '#3E7CB1',
  'Monitor': '#9AA5AE',
};
const STATUS_COLORS = {
  'New': '#4B5A6A', 'Retained': '#8A6D1E', 'Growing': '#2F6E63',
  'Stable': '#6C7A89', 'Declining': '#C2792E', 'Not yet due': '#3E7CB1', 'Inactive/Churn-risk': '#B0432E',
};

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------
function parseDMY(s) {
  if (!s) return null;
  const parts = String(s).trim().split(' ');
  const datePart = parts[0];
  const timePart = parts[1];
  const dm = datePart.split('-').map(Number);
  if (dm.length !== 3 || dm.some((n) => Number.isNaN(n))) return null;
  const [d, m, y] = dm;
  let hh = 0, mm = 0, ss = 0;
  if (timePart) {
    const t = timePart.split(':').map(Number);
    hh = t[0] || 0; mm = t[1] || 0; ss = t[2] || 0;
  }
  const dt = new Date(y, m - 1, d, hh, mm, ss);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function normalizeAccNo(acc) {
  if (!acc) return null;
  let s = String(acc).trim().replace(/^STK-/i, '');
  const token = s.split(/\s+/)[0];
  const digits = token.replace(/\D/g, '');
  if (digits.length >= 9) return '0' + digits.slice(-9);
  return token ? token.toUpperCase() : null;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function monthKeyOf(dt) { return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}`; }
function dateKeyOf(dt) { return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`; }
function monthLabel(mk) {
  const [y, m] = mk.split('-').map(Number);
  return new Date(y, m - 1, 1).toLocaleString('en-GB', { month: 'short', year: 'numeric' });
}
function fmt(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return Math.round(n).toLocaleString('en-KE');
}
function fmtPct(n) {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  return (n * 100).toFixed(1) + '%';
}

async function parseCSVFile(file) {
  const text = await file.text();
  const lines = text.split(/\r?\n/);
  const periodLine = lines.find((l) => l.replace(/^\uFEFF/, '').startsWith('Time Period')) || '';
  const headerIdx = lines.findIndex((l) => l.replace(/^\uFEFF/, '').startsWith('Receipt No.'));
  if (headerIdx === -1) {
    throw new Error(`"${file.name}" doesn't look like a Utility Account statement export (no "Receipt No." header row found).`);
  }
  const csvBody = lines.slice(headerIdx).join('\n');
  const parsed = Papa.parse(csvBody, { header: true, skipEmptyLines: true });
  const rows = parsed.data;

  const buckets = {};
  let rowsIncluded = 0, rowsSkipped = 0;

  for (const row of rows) {
    const reasonType = row['Reason Type'];
    if (reasonType === 'Utility Account to Organization Settlement Account') { rowsSkipped++; continue; }
    const status = row['Transaction Status'];
    if (status && status !== 'Completed') { rowsSkipped++; continue; }
    const paidIn = parseFloat(row['Paid In']);
    if (!paidIn || paidIn <= 0) { rowsSkipped++; continue; }
    const dt = parseDMY(row['Completion Time']);
    if (!dt) { rowsSkipped++; continue; }

    const mk = monthKeyOf(dt);
    const dk = dateKeyOf(dt);
    const custId = normalizeAccNo(row['A/C No.']);
    const type = paidIn < 70 ? 'hotspot' : 'ppoe';

    if (!buckets[mk]) {
      buckets[mk] = { customers: {}, daily: {}, tx: [], totalRevenue: 0, totalTxns: 0, unidentifiedRevenue: 0, unidentifiedTxns: 0, maxDay: 0 };
    }
    const b = buckets[mk];
    b.totalRevenue += paidIn;
    b.totalTxns += 1;
    b.maxDay = Math.max(b.maxDay, dt.getDate());
    b.tx.push([dt.getDate(), dt.getHours() * 60 + dt.getMinutes(), custId || '', paidIn]);
    if (!b.daily[dk]) b.daily[dk] = { hotspot: 0, ppoe: 0 };
    b.daily[dk][type] += paidIn;

    if (custId) {
      if (!b.customers[custId]) {
        b.customers[custId] = { spend: 0, txns: 0, activeDaysSet: new Set(), hotspotTxns: 0, ppoeTxns: 0, hotspotSpend: 0, ppoeSpend: 0, lastPurchase: null, maxTxn: 0 };
      }
      const c = b.customers[custId];
      c.spend += paidIn;
      c.txns += 1;
      c.activeDaysSet.add(dk);
      c.maxTxn = Math.max(c.maxTxn, paidIn);
      if (!c.lastPurchase || dk > c.lastPurchase) c.lastPurchase = dk;
      if (type === 'hotspot') { c.hotspotTxns++; c.hotspotSpend += paidIn; }
      else { c.ppoeTxns++; c.ppoeSpend += paidIn; }
    } else {
      b.unidentifiedRevenue += paidIn;
      b.unidentifiedTxns += 1;
    }
    rowsIncluded++;
  }

  Object.keys(buckets).forEach((mk) => {
    const b = buckets[mk];
    const out = {};
    Object.entries(b.customers).forEach(([cid, c]) => {
      out[cid] = {
        spend: c.spend, txns: c.txns, activeDays: c.activeDaysSet.size,
        hotspotTxns: c.hotspotTxns, ppoeTxns: c.ppoeTxns, hotspotSpend: c.hotspotSpend, ppoeSpend: c.ppoeSpend,
        lastPurchase: c.lastPurchase, maxTxn: c.maxTxn,
      };
    });
    b.customers = out;
  });

  return { fileName: file.name, periodLine: periodLine.trim(), buckets, rowsParsed: rows.length, rowsIncluded, rowsSkipped };
}

function mergeBuckets(target, source) {
  Object.entries(source).forEach(([mk, sb]) => {
    if (!target[mk]) {
      target[mk] = { customers: {}, daily: {}, tx: [], totalRevenue: 0, totalTxns: 0, unidentifiedRevenue: 0, unidentifiedTxns: 0, maxDay: 0 };
    }
    const tb = target[mk];
    tb.totalRevenue += sb.totalRevenue;
    tb.totalTxns += sb.totalTxns;
    tb.unidentifiedRevenue += sb.unidentifiedRevenue;
    tb.unidentifiedTxns += sb.unidentifiedTxns;
    tb.maxDay = Math.max(tb.maxDay, sb.maxDay);
    (sb.tx || []).forEach((t) => tb.tx.push(t));
    Object.entries(sb.daily).forEach(([dk, v]) => {
      if (!tb.daily[dk]) tb.daily[dk] = { hotspot: 0, ppoe: 0 };
      tb.daily[dk].hotspot += v.hotspot;
      tb.daily[dk].ppoe += v.ppoe;
    });
    Object.entries(sb.customers).forEach(([cid, c]) => {
      if (!tb.customers[cid]) tb.customers[cid] = { spend: 0, txns: 0, activeDays: 0, hotspotTxns: 0, ppoeTxns: 0, hotspotSpend: 0, ppoeSpend: 0, lastPurchase: null, maxTxn: 0 };
      const t = tb.customers[cid];
      t.spend += c.spend; t.txns += c.txns; t.activeDays += c.activeDays;
      t.hotspotTxns += c.hotspotTxns; t.ppoeTxns += c.ppoeTxns;
      t.hotspotSpend += c.hotspotSpend; t.ppoeSpend += c.ppoeSpend;
      t.maxTxn = Math.max(t.maxTxn, c.maxTxn || 0);
      if (c.lastPurchase && (!t.lastPurchase || c.lastPurchase > t.lastPurchase)) t.lastPurchase = c.lastPurchase;
    });
  });
  return target;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------
async function loadIndex() {
  try {
    const r = await window.storage.get('happynet_months_index');
    return r ? JSON.parse(r.value) : [];
  } catch (e) { return []; }
}
async function saveIndex(idx) {
  await window.storage.set('happynet_months_index', JSON.stringify([...new Set(idx)].sort()));
}
async function loadMonth(mk) {
  try {
    const r = await window.storage.get(`happynet_month_${mk}`);
    return r ? JSON.parse(r.value) : null;
  } catch (e) { return null; }
}
async function saveMonth(mk, bucket) {
  const [y, m] = mk.split('-').map(Number);
  const daysInPeriod = new Date(y, m, 0).getDate();
  const today = new Date();
  const isMTD = mk === monthKeyOf(today);
  const daysElapsed = isMTD ? Math.max(1, bucket.maxDay || 1) : daysInPeriod;
  const payload = {
    monthKey: mk, daysInPeriod, daysElapsed, isMTD,
    totalRevenue: bucket.totalRevenue, totalTxns: bucket.totalTxns,
    unidentifiedRevenue: bucket.unidentifiedRevenue, unidentifiedTxns: bucket.unidentifiedTxns,
    customers: bucket.customers, daily: bucket.daily, tx: bucket.tx || [],
    importedAt: new Date().toISOString(),
  };
  await window.storage.set(`happynet_month_${mk}`, JSON.stringify(payload));
  return payload;
}
async function deleteMonth(mk) {
  await window.storage.delete(`happynet_month_${mk}`);
  const idx = await loadIndex();
  await saveIndex(idx.filter((x) => x !== mk));
}

async function loadCrmNotes() {
  try {
    const r = await window.storage.get('happynet_crm_notes');
    return r ? JSON.parse(r.value) : {};
  } catch (e) { return {}; }
}
async function saveCrmNotes(all) {
  await window.storage.set('happynet_crm_notes', JSON.stringify(all));
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------
// ---- PPOE billing cycles: weekly vs monthly packages, next-due logic ----
const PPOE_GRACE_DAYS = { daily: 1, weekly: 2, 'half-monthly': 3, monthly: 5 };
const CYCLE_DAYS = { daily: 1, weekly: 7, 'half-monthly': 15, monthly: 30 };
const CYCLE_NAMES = { daily: 'Daily', weekly: 'Weekly', 'half-monthly': 'Half a month', monthly: 'Monthly' };
const dayNum = (s) => Math.round(Date.parse(s + 'T00:00:00Z') / 864e5);
const addDaysStr = (s, n) => new Date((dayNum(s) + n) * 864e5).toISOString().slice(0, 10);

async function loadPkgOverrides() {
  try { const r = await window.storage.get('happynet_pkg_cycles'); return r ? JSON.parse(r.value) : {}; } catch (e) { return {}; }
}

function inferPackageCycles(monthsData, overrides) {
  const sorted = Object.keys(monthsData).sort();
  const byCust = {};
  sorted.forEach((mk) => (monthsData[mk].tx || []).forEach(([d, min, cid, amt]) => {
    if (!cid || amt <= HOTSPOT_MAX) return;
    (byCust[cid] = byCust[cid] || []).push({ t: dayNum(`${mk}-${String(d).padStart(2, '0')}`), min, amt });
  }));
  const gaps = {}, counts = {};
  Object.values(byCust).forEach((arr) => {
    arr.sort((a, b) => a.t - b.t || a.min - b.min);
    arr.forEach((x, i) => {
      counts[x.amt] = (counts[x.amt] || 0) + 1;
      if (i < arr.length - 1) { const g = arr[i + 1].t - x.t; if (g >= 1) (gaps[x.amt] = gaps[x.amt] || []).push(g); }
    });
  });
  const list = Object.keys(counts).map(Number).map((amount) => {
    const g = (gaps[amount] || []).slice().sort((a, b) => a - b);
    const median = g.length ? g[Math.floor(g.length / 2)] : null;
    let autoLabel = 'monthly', source = 'assumed';
    if (g.length >= 5) { autoLabel = median <= 3 ? 'daily' : median <= 10 ? 'weekly' : median <= 21 ? 'half-monthly' : 'monthly'; source = 'detected'; }
    let label = autoLabel;
    if (overrides && CYCLE_DAYS[overrides[amount]]) { label = overrides[amount]; source = 'set by you'; }
    return { amount, payments: counts[amount], pairs: g.length, medianGap: median, label, autoLabel, cycleDays: CYCLE_DAYS[label], source };
  }).sort((a, b) => b.payments - a.payments);
  const map = {}; list.forEach((x) => { map[x.amount] = x; });
  return { list, map };
}

function computePpoeDue(monthsData, cycles) {
  const sorted = Object.keys(monthsData).sort();
  let asOf = '0000-00-00';
  sorted.forEach((mk) => Object.keys(monthsData[mk].daily || {}).forEach((dk) => { if (dk > asOf) asOf = dk; }));
  const last = {};
  sorted.forEach((mk) => {
    const m = monthsData[mk];
    if (m.tx && m.tx.length) {
      m.tx.forEach(([d, min, cid, amt]) => {
        if (!cid || amt <= HOTSPOT_MAX) return;
        const date = `${mk}-${String(d).padStart(2, '0')}`, key = date + String(min).padStart(4, '0');
        if (!last[cid] || key > last[cid].key) last[cid] = { key, date, amt };
      });
    } else {
      Object.entries(m.customers).forEach(([cid, c]) => {
        if (!(c.ppoeSpend > 0) || !c.lastPurchase) return;
        const key = c.lastPurchase + '0000';
        if (!last[cid] || key > last[cid].key) last[cid] = { key, date: c.lastPurchase, amt: Math.round(c.maxTxn > HOTSPOT_MAX ? c.maxTxn : c.ppoeSpend / Math.max(1, c.ppoeTxns)), approx: true };
      });
    }
  });
  const byId = {};
  Object.entries(last).forEach(([id, l]) => {
    const cyc = cycles.map[l.amt];
    const cycleDays = cyc ? cyc.cycleDays : 30, cycleLabel = cyc ? cyc.label : 'monthly';
    const dueDate = addDaysStr(l.date, cycleDays);
    const pastDue = dayNum(asOf) - dayNum(dueDate);
    const grace = PPOE_GRACE_DAYS[cycleLabel];
    const state = pastDue <= 0 ? 'not due' : pastDue <= grace ? 'in grace' : pastDue <= Math.max(cycleDays, 7) ? 'overdue' : 'lapsed';
    byId[id] = { date: l.date, amt: l.amt, cycleDays, cycleLabel, dueDate, state, daysToDue: -pastDue, approx: !!l.approx };
  });
  return { asOf, byId };
}

function computeAnalysis(monthsData, pkgOverrides) {
  const sorted = Object.keys(monthsData).sort();
  if (sorted.length === 0) return { sorted, empty: true };

  const current = sorted[sorted.length - 1];
  const previous = sorted.length >= 2 ? sorted[sorted.length - 2] : null;
  const curM = monthsData[current];
  const prevM = previous ? monthsData[previous] : null;

  const allIds = new Set();
  sorted.forEach((mk) => Object.keys(monthsData[mk].customers).forEach((id) => allIds.add(id)));

  const cycles = inferPackageCycles(monthsData, pkgOverrides || {});
  const due = computePpoeDue(monthsData, cycles);

  const customerMaster = [];
  allIds.forEach((id) => {
    const curC = curM.customers[id] || null;
    const prevC = prevM ? (prevM.customers[id] || null) : null;
    const activeInCurrent = !!curC;
    const activeInPrev = !!prevC;

    let hasHistoryBeforeCurrent = false;
    for (const mk of sorted) {
      if (mk === current) break;
      if (monthsData[mk].customers[id]) { hasHistoryBeforeCurrent = true; break; }
    }

    const curSpend = curC ? curC.spend : 0;
    const prevSpend = prevC ? prevC.spend : 0;
    const curRate = curM.daysElapsed > 0 ? curSpend / curM.daysElapsed : 0;
    const prevRate = prevM && prevM.daysElapsed > 0 && prevSpend > 0 ? prevSpend / prevM.daysElapsed : null;
    const rateChange0 = (prevRate && prevRate > 0) ? (curRate - prevRate) / prevRate : null;
    const pd = due.byId[id] || null;
    const monthlyPayer = !!(pd && pd.cycleDays >= 21 && curC && prevC && curC.hotspotTxns === 0 && prevC.hotspotTxns === 0 && prevSpend > 0);
    const rateChange = monthlyPayer ? (curSpend - prevSpend) / prevSpend : rateChange0;

    let statusVal;
    if (activeInCurrent && !hasHistoryBeforeCurrent) statusVal = 'New';
    else if (activeInCurrent && activeInPrev) {
      if (rateChange !== null && rateChange >= GROWTH_THRESHOLD) statusVal = 'Growing';
      else if (rateChange !== null && rateChange <= DECLINE_THRESHOLD) statusVal = 'Declining';
      else statusVal = 'Stable';
    } else if (activeInCurrent && !activeInPrev && hasHistoryBeforeCurrent) statusVal = 'Retained';
    else if (!activeInCurrent && hasHistoryBeforeCurrent) statusVal = (pd && (pd.state === 'not due' || pd.state === 'in grace')) ? 'Not yet due' : 'Inactive/Churn-risk';
    else statusVal = 'Unclassified';

    let behSource = curC;
    if (!behSource) {
      for (let i = sorted.length - 1; i >= 0; i--) {
        const mk = sorted[i];
        if (mk === current) continue;
        if (monthsData[mk].customers[id]) { behSource = monthsData[mk].customers[id]; break; }
      }
    }
    let behaviour = 'No activity';
    if (behSource) {
      const h = behSource.hotspotTxns > 0, p = behSource.ppoeTxns > 0;
      behaviour = h && p ? 'Mixed' : p ? 'PPOE Only' : h ? 'Hotspot Only' : 'No activity';
    }

    let segment;
    if (curSpend === 0) segment = 'Inactive (no spend this period)';
    else {
      const projected = curM.daysElapsed > 0 ? (curSpend / curM.daysElapsed) * curM.daysInPeriod : curSpend;
      if (projected <= TIER_CASUAL_MAX) segment = 'Casual';
      else if (projected <= TIER_DEVELOPING_MAX) segment = 'Developing';
      else if (projected <= TIER_ACTIVE_MAX) segment = 'Active';
      else if (projected <= TIER_HIGHVALUE_MAX) segment = 'High Value';
      else segment = 'VIP';
    }

    let opportunity;
    if (statusVal === 'Not yet due') opportunity = (pd.state === 'in grace' || pd.daysToDue <= 3) ? 'Payment reminder' : 'Monitor';
    else if (statusVal === 'Inactive/Churn-risk') opportunity = 'Win-back outreach';
    else if (statusVal === 'Declining') opportunity = 'Retention call';
    else if (behaviour === 'Hotspot Only' && ['Active', 'High Value', 'VIP'].includes(segment)) opportunity = 'Upsell to PPOE plan';
    else if (statusVal === 'Growing' && behaviour === 'Mixed') opportunity = 'Upgrade to higher PPOE bundle';
    else if (statusVal === 'New') opportunity = 'Onboarding / welcome offer';
    else opportunity = 'Monitor';

    const churnRisk = (statusVal === 'Inactive/Churn-risk' || statusVal === 'Declining') ? 'High' : 'Low';

    let lastPurchase = null;
    let maxTxn = 0;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const c2 = monthsData[sorted[i]].customers[id];
      if (c2 && c2.lastPurchase && (!lastPurchase || c2.lastPurchase > lastPurchase)) lastPurchase = c2.lastPurchase;
      if (c2 && c2.maxTxn) maxTxn = Math.max(maxTxn, c2.maxTxn);
    }

    let lifetimeSpend = 0, monthsActive = 0, firstMonth = null, lastActiveMonth = null;
    for (const mk of sorted) {
      const c3 = monthsData[mk].customers[id];
      if (c3) { lifetimeSpend += c3.spend; monthsActive++; if (!firstMonth) firstMonth = mk; lastActiveMonth = mk; }
    }

    customerMaster.push({
      lifetimeSpend, monthsActive, firstMonth, lastActiveMonth, avgMonthlySpend: monthsActive ? lifetimeSpend / monthsActive : 0,
      id, behaviour, currentSpend: curSpend, txns: curC ? curC.txns : 0, activeDays: curC ? curC.activeDays : 0,
      segment, previousSpend: prevSpend, spendChangePct: rateChange, status: statusVal, opportunity,
      churnRisk, lastPurchase, maxTxn,
      ppoeCycle: pd ? pd.cycleLabel : null, ppoeLastPaid: pd ? pd.date : null, ppoeLastAmount: pd ? pd.amt : null,
      ppoeDueDate: pd ? pd.dueDate : null, ppoeDueState: pd ? pd.state : null, daysToDue: pd ? pd.daysToDue : null,
      hotspotSpend: curC ? curC.hotspotSpend : 0, ppoeSpend: curC ? curC.ppoeSpend : 0,
      hotspotTxns: curC ? curC.hotspotTxns : 0, ppoeTxns: curC ? curC.ppoeTxns : 0,
    });
  });

  const revenueByMonth = sorted.map((mk) => {
    const m = monthsData[mk];
    let hot = 0, ppoe = 0;
    Object.values(m.customers).forEach((c) => { hot += c.hotspotSpend; ppoe += c.ppoeSpend; });
    return { month: monthLabel(mk), monthKey: mk, Hotspot: hot, PPOE: ppoe, Total: hot + ppoe, isMTD: m.isMTD };
  });

  const dailyRevenue = [];
  sorted.forEach((mk) => {
    const m = monthsData[mk];
    Object.keys(m.daily).sort().forEach((dk) => {
      dailyRevenue.push({ date: dk.slice(5), Hotspot: m.daily[dk].hotspot, PPOE: m.daily[dk].ppoe, Total: m.daily[dk].hotspot + m.daily[dk].ppoe });
    });
  });

  dailyRevenue.forEach((d, i) => { const w = dailyRevenue.slice(Math.max(0, i - 6), i + 1); d.MA7 = Math.round(w.reduce((a, x) => a + x.Total, 0) / w.length); });

  const nydSet = new Set(customerMaster.filter((c) => c.status === 'Not yet due').map((c) => c.id));
  const retentionSeries = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = monthsData[sorted[i - 1]], b = monthsData[sorted[i]];
    const aIds = Object.keys(a.customers);
    const base = aIds.length;
    let retained = 0, pending = 0;
    aIds.forEach((id) => { if (b.customers[id]) retained++; else if (i === sorted.length - 1 && nydSet.has(id)) pending++; });
    retentionSeries.push({
      month: monthLabel(sorted[i]), monthKey: sorted[i], base,
      retained, pending, lost: base - retained - pending,
      retentionRate: base ? retained / base : 0,
      goodStandingRate: base ? (retained + pending) / base : 0,
      inactivityRate: base ? (base - retained - pending) / base : 0,
      isMTD: b.isMTD,
    });
  }

  const revenueLostInactive = customerMaster.filter((c) => c.status === 'Inactive/Churn-risk').reduce((s, c) => s + c.previousSpend, 0);
  const revenueAtRiskDeclining = customerMaster.filter((c) => c.status === 'Declining').reduce((s, c) => s + c.previousSpend, 0);

  return {
    sorted, current, previous, customerMaster, revenueByMonth, dailyRevenue, retentionSeries,
    revenueLostInactive, revenueAtRiskDeclining, packageCycles: cycles.list, ppoeAsOf: due.asOf, empty: false,
  };
}

// ---------------------------------------------------------------------------
// AI assistant — gives Claude a precise query tool over the real dataset
// instead of asking it to eyeball numbers from a text dump (which is how
// averages, medians, and thresholds went wrong before).
// ---------------------------------------------------------------------------

// Fields the analyze_customers tool can filter/aggregate/list on.
// Includes real Customer Master fields and derived per-customer averages.
const QUERYABLE_FIELDS = [
  'id', 'behaviour', 'segment', 'status', 'churnRisk', 'opportunity',
  'currentSpend', 'previousSpend', 'spendChangePct', 'txns', 'activeDays',
  'lastPurchase', 'daysSinceLastPurchase', 'maxTxn',
  'hotspotSpend', 'ppoeSpend', 'hotspotTxns', 'ppoeTxns',
  'avgPerActiveDay', 'avgPerTxn',
  'lifetimeSpend', 'monthsActive', 'firstMonth', 'lastActiveMonth', 'avgMonthlySpend',
  'ppoeCycle', 'ppoeLastPaid', 'ppoeLastAmount', 'ppoeDueDate', 'ppoeDueState', 'daysToDue',
];

function getFieldValue(c, field, todayStr) {
  if (field === 'avgPerActiveDay') return c.activeDays > 0 ? c.currentSpend / c.activeDays : null;
  if (field === 'avgPerTxn') return c.txns > 0 ? c.currentSpend / c.txns : null;
  if (field === 'daysSinceLastPurchase') {
    if (!c.lastPurchase) return null;
    const d1 = new Date(c.lastPurchase), d2 = new Date(todayStr);
    return Math.round((d2 - d1) / 86400000);
  }
  return c[field];
}

function matchFilter(c, f, todayStr) {
  const v = getFieldValue(c, f.field, todayStr);
  if (v === null || v === undefined) return false;
  const fv = f.value;
  switch (f.op) {
    case 'eq': return typeof v === 'number' ? v === Number(fv) : String(v).toLowerCase() === String(fv).toLowerCase();
    case 'neq': return typeof v === 'number' ? v !== Number(fv) : String(v).toLowerCase() !== String(fv).toLowerCase();
    case 'gt': return v > Number(fv);
    case 'gte': return v >= Number(fv);
    case 'lt': return v < Number(fv);
    case 'lte': return v <= Number(fv);
    case 'contains': return String(v).toLowerCase().includes(String(fv).toLowerCase());
    default: return true;
  }
}

function round2(n) { return n === null || n === undefined ? n : Math.round(n * 100) / 100; }

// ---- chat history storage + PDF report ----
async function loadChatIndex() {
  try { const r = await window.storage.get('happynet_chats_index'); return r ? JSON.parse(r.value) : []; } catch (e) { return []; }
}
async function saveChatIndex(idx) { await window.storage.set('happynet_chats_index', JSON.stringify(idx)); }
async function loadChat(id) {
  try { const r = await window.storage.get(`happynet_chat_${id}`); return r ? JSON.parse(r.value) : null; } catch (e) { return null; }
}
async function saveChat(id, messages) { await window.storage.set(`happynet_chat_${id}`, JSON.stringify(messages)); }
async function deleteChatStore(id) { try { await window.storage.delete(`happynet_chat_${id}`); } catch (e) { /* ignore */ } }

const HELV_W = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];
function pdfClean(t) {
  return String(t).replace(/\r/g, '').replace(/[\u2018\u2019]/g, "'").replace(/[\u201C\u201D]/g, '"').replace(/[\u2013\u2014\u2212]/g, '-')
    .replace(/\u2026/g, '...').replace(/[\u00B7\u2022]/g, '-').replace(/\u00A0/g, ' ').replace(/\t/g, '  ').replace(/[^\x0A\x20-\x7E]/g, '?');
}
function pdfWidth(text, size) {
  let w = 0;
  for (let i = 0; i < text.length; i++) { const c = text.charCodeAt(i); w += (c >= 32 && c <= 126 ? HELV_W[c - 32] : 556); }
  return (w * size) / 1000;
}
function pdfWrap(text, size, maxW) {
  const out = [];
  pdfClean(text).split('\n').forEach((par) => {
    if (!par.trim()) { out.push(''); return; }
    let line = '';
    par.split(' ').forEach((word) => {
      let w = word;
      while (pdfWidth(w, size) > maxW) {
        let cut = w.length - 1;
        while (cut > 1 && pdfWidth(w.slice(0, cut), size) > maxW) cut--;
        if (line) { out.push(line); line = ''; }
        out.push(w.slice(0, cut)); w = w.slice(cut);
      }
      const test = line ? line + ' ' + w : w;
      if (pdfWidth(test, size) <= maxW) line = test; else { out.push(line); line = w; }
    });
    out.push(line);
  });
  return out;
}
function pdfEsc(t) { return t.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)'); }

function buildChatPdf(title, messages) {
  const W = 595, H = 842, M = 54, maxW = W - 2 * M, body = 10, lh = 14;
  const pages = [[]];
  let y = H - M;
  const put = (text, o = {}) => pages[pages.length - 1].push({ text, size: o.size || body, bold: !!o.bold, gray: o.gray || 0, x: o.x || M, y });
  const ensure = (need) => { if (y - need < M + 10) { pages.push([]); y = H - M; } };

  put('Happynet Customer Analytics', { size: 18, bold: true }); y -= 22;
  put('AI chat report', { size: 12, gray: 0.35 }); y -= 16;
  pdfWrap('Chat: ' + title, 9, maxW).forEach((l) => { put(l, { size: 9, gray: 0.35 }); y -= 12; });
  put(`Generated ${pdfClean(new Date().toLocaleString())}  -  ${messages.length} message${messages.length === 1 ? '' : 's'}`, { size: 9, gray: 0.35 }); y -= 10;
  pages[0].push({ rule: true, y });
  y -= 18;

  messages.forEach((m) => {
    ensure(lh * 3);
    put(m.role === 'user' ? 'You' : 'Assistant', { size: 9, bold: true, gray: m.role === 'user' ? 0.15 : 0.4 }); y -= 13;
    pdfWrap(m.content, body, maxW).forEach((l) => { ensure(lh); put(l); y -= lh; });
    y -= 10;
  });

  const n = pages.length;
  const streams = pages.map((ops, pi) => {
    let s = '';
    ops.forEach((o) => {
      if (o.rule) { s += `0.75 G 0.6 w ${M} ${o.y} m ${W - M} ${o.y} l S\n`; return; }
      if (!o.text) return;
      s += `${o.gray} g BT /F${o.bold ? 2 : 1} ${o.size} Tf ${o.x} ${o.y} Td (${pdfEsc(o.text)}) Tj ET\n`;
    });
    s += `0.5 g BT /F1 8 Tf ${M} 30 Td (Happynet Customer Analytics - page ${pi + 1} of ${n}) Tj ET\n`;
    return s;
  });

  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>';
  objs[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>';
  const kids = [];
  streams.forEach((s, i) => {
    const pid = 5 + 2 * i, cid = 6 + 2 * i;
    kids.push(`${pid} 0 R`);
    objs[pid] = `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${cid} 0 R >>`;
    objs[cid] = `<< /Length ${s.length} >>\nstream\n${s}endstream`;
  });
  objs[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${n} >>`;

  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let i = 1; i < objs.length; i++) { offsets[i] = out.length; out += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = out.length;
  out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for (let i = 1; i < objs.length; i++) out += String(offsets[i]).padStart(10, '0') + ' 00000 n \n';
  out += `trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return out;
}

function downloadPdf(filename, pdfString) {
  const blob = new Blob([pdfString], { type: 'application/pdf' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---- dashboard / reporting helpers ----
function fmtK(v) { const a = Math.abs(v); return a >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(v / 1e3)}K` : String(v); }
function fmtSigned(v) { return `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`; }
function downloadFile(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}
function exportCsv(filename, columns, rows) {
  const esc = (v) => { const s = v === null || v === undefined ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const text = [columns.map((c) => esc(c[0])).join(','), ...rows.map((r) => columns.map((c) => esc(c[1](r))).join(','))].join('\n');
  downloadFile(filename, '\ufeff' + text, 'text/csv;charset=utf-8');
}
const CHART_COLORS = ['#C2792E', '#2F6E63', '#1E2A38', '#8A6BB0', '#B0432E', '#6B8F3E', '#9AA5B1'];

const TREND_LINES = [
  { key: 'Total', label: 'Total', color: '#1E2A38', width: 2 },
  { key: 'Hotspot', label: 'Hotspot', color: '#C2792E', width: 1.4 },
  { key: 'PPOE', label: 'PPOE', color: '#2F6E63', width: 1.4 },
  { key: 'MA7', label: '7-day average of total', color: '#8A6BB0', width: 2.2, dashed: true },
];

function DailyTrendChart({ data, height = 260 }) {
  const [shown, setShown] = useState({ Total: true, Hotspot: true, PPOE: true, MA7: false });
  const toggle = (k) => setShown((v) => ({ ...v, [k]: !v[k] }));
  return (
    <>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px 16px', marginBottom: 8 }}>
        {TREND_LINES.map((l) => (
          <label key={l.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12.5, cursor: 'pointer', color: shown[l.key] ? 'var(--ink)' : 'var(--ink-soft)' }}>
            <input type="checkbox" checked={shown[l.key]} onChange={() => toggle(l.key)} style={{ accentColor: l.color }} />
            <span style={{ width: 14, height: 0, borderTop: `3px ${l.dashed ? 'dashed' : 'solid'} ${l.color}` }} />
            {l.label}
          </label>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={height}>
        <LineChart data={data}>
          <CartesianGrid strokeDasharray="3 3" stroke="#DAD4C4" />
          <XAxis dataKey="date" fontSize={10} interval="preserveStartEnd" minTickGap={24} />
          <YAxis fontSize={11} tickFormatter={fmtK} />
          <Tooltip formatter={(v) => `KSh ${fmt(v)}`} />
          {TREND_LINES.filter((l) => shown[l.key]).map((l) => (
            <Line key={l.key} type={l.key === 'MA7' ? 'monotone' : 'linear'} dataKey={l.key} name={l.label} stroke={l.color} strokeWidth={l.width} strokeDasharray={l.dashed ? '5 3' : undefined} dot={false} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
      {!Object.values(shown).some(Boolean) && <p className="hn-note" style={{ textAlign: 'center' }}>Tick at least one line to show it.</p>}
    </>
  );
}

function computePace(monthsData, analysis) {
  if (!analysis || analysis.empty) return null;
  const cur = monthsData[analysis.current];
  const rev = analysis.revenueByMonth[analysis.revenueByMonth.length - 1].Total;
  const prev = analysis.previous ? monthsData[analysis.previous] : null;
  const days = cur.daysElapsed, dim = cur.daysInPeriod;
  const sumTo = (m, d) => Object.entries(m.daily).filter(([dk]) => Number(dk.slice(8)) <= d).reduce((a, [, v]) => a + v.hotspot + v.ppoe, 0);
  const samePrev = prev ? sumTo(prev, days) : 0;
  const prevFull = prev ? prev.totalRevenue : 0;
  const runRate = rev / Math.max(1, days);
  const byShape = cur.isMTD && samePrev > 0 && prevFull > 0;
  const projected = cur.isMTD ? (byShape ? rev * (prevFull / samePrev) : runRate * dim) : rev;
  return {
    isMTD: cur.isMTD, days, dim, rev, samePrev, prevFull, runRate, projected, byShape,
    vsSamePeriod: samePrev > 0 ? rev / samePrev - 1 : null, vsPrevFull: prevFull > 0 ? projected / prevFull - 1 : null,
    remaining: Math.max(0, dim - days), prevLabel: analysis.previous ? monthLabel(analysis.previous) : null,
  };
}

function computePatterns(monthsData, analysis) {
  const empty = { renewals: { dueNow: [], dueLater: [], nowRevenue: 0, laterRevenue: 0, monthEnd: '' }, dayOfMonth: [], weekday: [], packages: [], packageRows: [], newDaily: [], newByMonth: [], winback: [], winbackTotal: { count: 0, revenue: 0 }, concentration: null, segmentRevenue: [] };
  if (!analysis || analysis.empty) return empty;
  const sorted = analysis.sorted;
  const WD = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const dom = {}, wd = {};
  sorted.forEach((mk) => Object.entries(monthsData[mk].daily).forEach(([dk, v]) => {
    const d = Number(dk.slice(8)), w = WD[new Date(dk + 'T00:00:00').getDay()];
    const a = (dom[d] = dom[d] || { day: d, Hotspot: 0, PPOE: 0, n: 0 }); a.Hotspot += v.hotspot; a.PPOE += v.ppoe; a.n++;
    const b = (wd[w] = wd[w] || { day: w, Hotspot: 0, PPOE: 0, n: 0 }); b.Hotspot += v.hotspot; b.PPOE += v.ppoe; b.n++;
  }));
  const avg = (o) => ({ ...o, Hotspot: Math.round(o.Hotspot / o.n), PPOE: Math.round(o.PPOE / o.n) });
  const dayOfMonth = Object.values(dom).sort((a, b) => a.day - b.day).map(avg);
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].filter((w) => wd[w]).map((w) => avg(wd[w]));

  const pkgTotals = {}, perMonth = {};
  sorted.forEach((mk) => (monthsData[mk].tx || []).forEach((t) => {
    const amt = t[3]; if (amt > HOTSPOT_MAX) return;
    const k = 'KSh ' + amt; pkgTotals[k] = (pkgTotals[k] || 0) + amt;
    const pm = (perMonth[mk] = perMonth[mk] || {}); pm[k] = (pm[k] || 0) + amt;
  }));
  const packages = Object.keys(pkgTotals).sort((a, b) => pkgTotals[b] - pkgTotals[a]).slice(0, 6);
  const packageRows = sorted.filter((mk) => perMonth[mk]).map((mk) => {
    const pm = perMonth[mk], total = Object.values(pm).reduce((a, b) => a + b, 0) || 1;
    const row = { month: monthLabel(mk) };
    let shown = 0;
    packages.forEach((k) => { row[k] = Math.round(((pm[k] || 0) / total) * 1000) / 10; shown += pm[k] || 0; });
    row.Other = Math.round(((total - shown) / total) * 1000) / 10;
    return row;
  });

  const first = {};
  sorted.forEach((mk) => (monthsData[mk].tx || []).forEach(([d, min, cid, amt]) => {
    if (!cid) return;
    const date = `${mk}-${String(d).padStart(2, '0')}`, key = date + String(min).padStart(4, '0');
    if (!first[cid] || key < first[cid].key) first[cid] = { key, date, mk, hot: amt <= HOTSPOT_MAX };
  }));
  const nd = {}, nbm = {};
  Object.entries(first).forEach(([id, f]) => {
    if (f.mk === sorted[0]) return;
    if (sorted.some((mk) => mk < f.mk && monthsData[mk].customers[id])) return;
    const o = (nd[f.date] = nd[f.date] || { date: f.date.slice(5), Hotspot: 0, PPOE: 0 });
    const m = (nbm[f.mk] = nbm[f.mk] || { Hotspot: 0, PPOE: 0 });
    const col = f.hot ? 'Hotspot' : 'PPOE'; o[col]++; m[col]++;
  });
  const newDaily = Object.keys(nd).sort().map((k) => nd[k]);
  const newByMonth = Object.keys(nbm).sort().map((mk) => ({ month: monthLabel(mk), monthKey: mk, ...nbm[mk], Total: nbm[mk].Hotspot + nbm[mk].PPOE }));

  const cm = analysis.customerMaster, meta = monthsData[analysis.current];
  const usePrev = meta.isMTD && analysis.previous;
  const field = usePrev ? 'previousSpend' : 'currentSpend';
  const spends = cm.map((c) => c[field]).filter((v) => v > 0).sort((a, b) => b - a);
  const total = spends.reduce((a, b) => a + b, 0);
  const share = (n) => (total ? spends.slice(0, n).reduce((a, b) => a + b, 0) / total : 0);
  const concentration = {
    label: usePrev ? monthLabel(analysis.previous) : monthLabel(analysis.current), customers: spends.length,
    top10: share(10), top50: share(50), top100: share(100), top10pct: share(Math.max(1, Math.round(spends.length * 0.1))),
  };
  const wbVal = (c) => c.previousSpend || c.ppoeLastAmount || 0;
  const winbackAll = cm.filter((c) => c.status === 'Inactive/Churn-risk' && (c.previousSpend > 0 || c.ppoeDueState === 'overdue' || c.ppoeDueState === 'lapsed')).sort((a, b) => wbVal(b) - wbVal(a));
  const segmentRevenue = SEGMENT_LIST.map((s) => ({ segment: s, revenue: Math.round(cm.filter((c) => c.segment === s).reduce((a, c) => a + c.currentSpend, 0)) }));
  const monthEnd = `${analysis.current}-${String(meta.daysInPeriod).padStart(2, '0')}`;
  const dueNow = cm.filter((c) => c.ppoeDueState === 'in grace' || c.ppoeDueState === 'overdue').sort((a, b) => (a.ppoeDueDate || '').localeCompare(b.ppoeDueDate || ''));
  const dueLater = cm.filter((c) => c.ppoeDueState === 'not due' && c.ppoeDueDate <= monthEnd).sort((a, b) => a.ppoeDueDate.localeCompare(b.ppoeDueDate));
  const sumAmt = (arr) => arr.reduce((a, c) => a + (c.ppoeLastAmount || 0), 0);
  const renewals = { dueNow, dueLater, nowRevenue: sumAmt(dueNow), laterRevenue: sumAmt(dueLater), monthEnd };
  return {
    renewals, dayOfMonth, weekday, packages, packageRows, newDaily, newByMonth, concentration, segmentRevenue,
    winback: winbackAll, winbackTotal: { count: winbackAll.length, revenue: winbackAll.reduce((a, c) => a + wbVal(c), 0) },
  };
}

function runDailyQuery(input, monthsData) {
  const mk = input.month || Object.keys(monthsData).sort().pop();
  const m = monthsData[mk];
  if (!m) return { error: `No data imported for ${mk}. Months on file: ${Object.keys(monthsData).sort().join(', ')}` };
  const product = input.product === 'hotspot' || input.product === 'ppoe' ? input.product : 'all';
  const days = Object.entries(m.daily || {}).sort(([x], [y]) => x.localeCompare(y)).map(([dk, v]) => {
    const value = product === 'all' ? v.hotspot + v.ppoe : v[product];
    return { date: dk, hotspot: round2(v.hotspot), ppoe: round2(v.ppoe), selected: round2(value) };
  });
  if (days.length === 0) return { month: mk, note: 'No daily breakdown stored for this month - re-import the statement to capture it.' };
  const total = days.reduce((x, d) => x + d.selected, 0);
  const avg = total / days.length;
  const ranked = [...days].sort((x, y) => y.selected - x.selected).map((d, i) => ({ ...d, rank: i + 1, sharePctOfMonth: round2((d.selected / (total || 1)) * 100), timesAvgDay: round2(d.selected / (avg || 1)) }));
  const only = input.day ? ranked.filter((d) => Number(d.date.slice(8)) === Number(input.day)) : ranked.slice(0, input.limit || 8);
  return { month: mk, product, daysWithPayments: days.length, monthTotal: round2(total), avgPerPaymentDay: round2(avg), days: only, note: 'Daily totals only (no per-customer breakdown by day).' };
}

// ---- transaction-level, trend, customer-profile and CRM queries ----
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function collectTx(monthsData) {
  const out = [], missing = [];
  Object.keys(monthsData).sort().forEach((mk) => {
    const m = monthsData[mk];
    if (!m.tx || m.tx.length === 0) { missing.push(mk); return; }
    m.tx.forEach(([d, min, cid, amt]) => out.push({ mk, date: `${mk}-${pad2(d)}`, day: d, min, cid, amt }));
  });
  return { out, missing };
}

function mondayOf(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return dateKeyOf(d);
}

function runTxnQuery(input, monthsData, customerMaster) {
  const { out, missing } = collectTx(monthsData);
  if (out.length === 0) return { error: 'No per-transaction log is stored yet. The statements were imported before transaction logging existed - ask the person to re-import the statement CSV(s) once.', monthsWithoutLog: missing };
  let rows = out;
  const product = input.product === 'hotspot' || input.product === 'ppoe' ? input.product : 'all';
  if (input.month) rows = rows.filter((r) => r.mk === input.month);
  if (input.dateFrom) rows = rows.filter((r) => r.date >= input.dateFrom);
  if (input.dateTo) rows = rows.filter((r) => r.date <= input.dateTo);
  if (input.day) rows = rows.filter((r) => r.day === Number(input.day));
  if (input.dayFrom) rows = rows.filter((r) => r.day >= Number(input.dayFrom));
  if (input.dayTo) rows = rows.filter((r) => r.day <= Number(input.dayTo));
  if (product !== 'all') rows = rows.filter((r) => (r.amt <= HOTSPOT_MAX) === (product === 'hotspot'));
  if (input.customer) { const q = String(input.customer).toLowerCase(); rows = rows.filter((r) => r.cid.toLowerCase().includes(q)); }
  if (input.identified === false) rows = rows.filter((r) => !r.cid);
  if (input.minAmount !== undefined) rows = rows.filter((r) => r.amt >= Number(input.minAmount));
  if (input.maxAmount !== undefined) rows = rows.filter((r) => r.amt <= Number(input.maxAmount));
  if (input.hourFrom !== undefined) rows = rows.filter((r) => Math.floor(r.min / 60) >= Number(input.hourFrom));
  if (input.hourTo !== undefined) rows = rows.filter((r) => Math.floor(r.min / 60) <= Number(input.hourTo));

  const master = {};
  customerMaster.forEach((c) => { master[c.id] = c; });
  const groupBy = input.groupBy || 'none';
  const keyOf = {
    none: () => 'all', day: (r) => r.date, month: (r) => r.mk, week: (r) => 'week of ' + mondayOf(r.date),
    weekday: (r) => WEEKDAYS[new Date(r.date + 'T00:00:00').getDay()],
    dayOfMonth: (r) => pad2(r.day), hour: (r) => pad2(Math.floor(r.min / 60)) + ':00',
    amount: (r) => 'KSh ' + r.amt, customer: (r) => r.cid || '(unidentified)',
  }[groupBy];
  if (!keyOf) return { error: 'Unknown groupBy. Use none, day, week, weekday, dayOfMonth, hour, month, amount, customer.' };

  const groups = {};
  rows.forEach((r) => {
    const k = keyOf(r);
    if (!groups[k]) groups[k] = { key: k, revenue: 0, txns: 0, ids: new Set(), hot: 0, ppoe: 0 };
    const g = groups[k];
    g.revenue += r.amt; g.txns += 1; if (r.cid) g.ids.add(r.cid);
    if (r.amt <= HOTSPOT_MAX) g.hot += r.amt; else g.ppoe += r.amt;
  });
  const list = Object.values(groups).map((g) => {
    const o = { key: g.key, revenue: round2(g.revenue), txns: g.txns, uniqueCustomers: g.ids.size, hotspotRevenue: round2(g.hot), ppoeRevenue: round2(g.ppoe), avgTxn: round2(g.revenue / g.txns) };
    if (groupBy === 'customer' && master[g.key]) {
      const c = master[g.key];
      o.status = c.status; o.segment = c.segment; o.behaviour = c.behaviour; o.lastPurchase = c.lastPurchase;
    }
    return o;
  });
  const sortBy = input.sortBy || (['customer', 'amount'].includes(groupBy) ? 'revenue' : 'key');
  if (sortBy === 'key') list.sort((a, b) => a.key.localeCompare(b.key));
  else list.sort((a, b) => (b[sortBy] || 0) - (a[sortBy] || 0));
  if (input.sortDir === 'asc' && sortBy !== 'key') list.reverse();
  const limit = Math.min(input.limit || (sortBy === 'key' ? 45 : 15), 100);

  const total = rows.reduce((x, r) => x + r.amt, 0);
  const ids = new Set(rows.filter((r) => r.cid).map((r) => r.cid));
  const result = { matchedTxns: rows.length, matchedRevenue: round2(total), matchedCustomers: ids.size, groupBy, groupsTotal: list.length, groups: list.slice(0, limit) };
  if (list.length > limit) result.note = `Showing ${limit} of ${list.length} groups.`;
  if (ids.size > 0 && ['customer', 'none', 'day'].includes(groupBy)) {
    const status = {}, behaviour = {};
    ids.forEach((id) => {
      const c = master[id]; if (!c) return;
      status[c.status] = (status[c.status] || 0) + 1;
      behaviour[c.behaviour] = (behaviour[c.behaviour] || 0) + 1;
    });
    result.customerStatusMix = status; result.customerBehaviourMix = behaviour;
  }
  if (missing.length) result.monthsWithoutTxnLog = missing;
  return result;
}

function runNewClientsQuery(input, monthsData, customerMaster) {
  const { out, missing } = collectTx(monthsData);
  if (out.length === 0) return { error: 'No per-transaction log stored yet - re-import the statement CSV(s).' };
  const sortedMonths = Object.keys(monthsData).sort();
  const first = {};
  out.forEach((r) => {
    if (!r.cid) return;
    const cur = first[r.cid];
    const key = r.date + String(r.min).padStart(4, '0');
    if (!cur || key < cur.key) first[r.cid] = { key, date: r.date, mk: r.mk, amt: r.amt };
  });
  const product = input.product === 'hotspot' || input.product === 'ppoe' ? input.product : 'all';
  let list = Object.entries(first).filter(([id, f]) => {
    const earlier = sortedMonths.some((mk) => mk < f.mk && monthsData[mk].customers[id]);
    return !earlier;
  }).map(([id, f]) => ({ id, date: f.date, firstAmount: f.amt, firstProduct: f.amt <= HOTSPOT_MAX ? 'hotspot' : 'ppoe' }));
  if (product !== 'all') list = list.filter((x) => x.firstProduct === product);
  if (input.dateFrom) list = list.filter((x) => x.date >= input.dateFrom);
  if (input.dateTo) list = list.filter((x) => x.date <= input.dateTo);
  if (input.month) list = list.filter((x) => x.date.startsWith(input.month));
  const groupBy = input.groupBy || 'day';
  const keyFn = groupBy === 'weekday' ? (x) => WEEKDAYS[new Date(x.date + 'T00:00:00').getDay()] : groupBy === 'none' ? () => 'all' : (x) => x.date;
  const newMap = {};
  list.forEach((x) => { newMap[x.id] = x; });
  const lo = input.dateFrom || (input.month ? input.month + '-01' : '0000-00-00');
  const hi = input.dateTo || (input.month ? input.month + '-31' : '9999-99-99');
  const pay = out.filter((r) => newMap[r.cid] && r.date >= lo && r.date <= hi && (product === 'all' || (r.amt <= HOTSPOT_MAX) === (product === 'hotspot')));
  const groups = {};
  const grp = (k) => (groups[k] = groups[k] || { key: k, newClients: 0, revenueFromNewClientsOnTheirJoinDay: 0, txnsOnJoinDay: 0 });
  list.forEach((x) => { grp(keyFn(x)).newClients++; });
  pay.forEach((r) => { const f = newMap[r.cid]; if (r.date === f.date) { const g = grp(keyFn(f)); g.revenueFromNewClientsOnTheirJoinDay += r.amt; g.txnsOnJoinDay++; } });
  const rows = Object.values(groups).sort((a, b) => a.key.localeCompare(b.key)).map((g) => ({
    ...g, revenueFromNewClientsOnTheirJoinDay: round2(g.revenueFromNewClientsOnTheirJoinDay),
    ...(groupBy === 'day' ? { weekday: WEEKDAYS[new Date(g.key + 'T00:00:00').getDay()] } : {}),
  }));
  const per = {};
  pay.forEach((r) => {
    const c = per[r.cid] || (per[r.cid] = { id: r.cid, joinedOn: newMap[r.cid].date, spend: 0, txns: 0, dates: new Set() });
    c.spend += r.amt; c.txns++; c.dates.add(r.date);
  });
  const clients = Object.values(per);
  const multi = clients.filter((c) => c.dates.size > 1).sort((a, b) => b.spend - a.spend);
  const pk = {};
  pay.forEach((r) => { const k = 'KSh ' + r.amt; const e = pk[k] || (pk[k] = { package: k, txns: 0, clients: new Set() }); e.txns++; e.clients.add(r.cid); });
  const fmtClient = (c) => ({ id: c.id, joinedOn: c.joinedOn, joinedWeekday: WEEKDAYS[new Date(c.joinedOn + 'T00:00:00').getDay()], datesActive: [...c.dates].sort(), spend: round2(c.spend), txns: c.txns });
  const res = {
    product, totalNewClients: list.length, groups: rows.slice(0, 60), earliestLoggedDate: out[0].date,
    periodSpendByNewClients: round2(clients.reduce((a, c) => a + c.spend, 0)),
    clientsWhoBoughtOnMoreThanOneDate: multi.length, multiDateClients: multi.slice(0, 10).map(fmtClient),
    topSpenders: [...clients].sort((a, b) => b.spend - a.spend).slice(0, 5).map(fmtClient),
    topPackagesAmongNewClients: Object.values(pk).sort((a, b) => b.txns - a.txns).slice(0, 5).map((e) => ({ package: e.package, txns: e.txns, clients: e.clients.size })),
    note: 'revenueFromNewClientsOnTheirJoinDay = everything those clients paid on the day they joined (not just the first payment). periodSpend/topSpenders cover the whole requested date range. Dates carry the true weekday; never relabel them.',
    definition: 'New = account whose first-ever payment in the system falls in the period (no activity in any earlier imported month, and earliest payment on file).',
  };
  if (missing.length) res.caution = 'Months without a transaction log (' + missing.join(', ') + ') only rule out customers by monthly totals; re-import them for exact first-payment dates.';
  if (input.list) res.clients = list.slice(0, Math.min(input.list, 100));
  return res;
}

function runTrendQuery(monthsData, analysis) {
  const sorted = Object.keys(monthsData).sort();
  const seen = new Set();
  const months = sorted.map((mk) => {
    const m = monthsData[mk];
    let hot = 0, ppoe = 0, hotTx = 0, ppoeTx = 0, newCust = 0;
    Object.entries(m.customers).forEach(([id, c]) => {
      hot += c.hotspotSpend; ppoe += c.ppoeSpend; hotTx += c.hotspotTxns; ppoeTx += c.ppoeTxns;
      if (!seen.has(id)) newCust++;
    });
    Object.keys(m.customers).forEach((id) => seen.add(id));
    const ret = (analysis.retentionSeries || []).find((r) => r.monthKey === mk);
    return {
      month: mk, isMTD: m.isMTD, daysCovered: m.daysElapsed,
      revenue: round2(m.totalRevenue), hotspotRevenue: round2(hot), ppoeRevenue: round2(ppoe),
      txns: m.totalTxns, hotspotTxns: hotTx, ppoeTxns: ppoeTx,
      avgRevenuePerDay: round2(m.totalRevenue / Math.max(1, m.daysElapsed)),
      avgPpoeTicket: ppoeTx ? round2(ppoe / ppoeTx) : null,
      activeCustomers: Object.keys(m.customers).length, newCustomers: newCust,
      unidentifiedRevenue: round2(m.unidentifiedRevenue), unidentifiedTxns: m.unidentifiedTxns,
      retentionVsPrevMonth: ret ? round2(ret.retentionRate * 100) + '%' : null, lostVsPrevMonth: ret ? ret.lost : null,
      hasTxnLog: !!(m.tx && m.tx.length),
    };
  });
  return { months, revenueFromNowInactiveCustomers: round2(analysis.revenueLostInactive), revenueAtRiskFromDeclining: round2(analysis.revenueAtRiskDeclining) };
}

function runCustomerLookup(input, customerMaster, monthsData, crmNotes) {
  const q = String(input.id || '').toLowerCase().replace(/\s+/g, '');
  if (!q) return { error: 'Provide "id" (full or partial account number / phone).' };
  const matches = customerMaster.filter((c) => c.id.toLowerCase().includes(q));
  if (matches.length === 0) return { matchCount: 0, note: 'No customer with that id fragment.' };
  const sorted = Object.keys(monthsData).sort();
  const { out } = collectTx(monthsData);
  return {
    matchCount: matches.length,
    customers: matches.slice(0, 5).map((c) => {
      const history = sorted.map((mk) => {
        const h = monthsData[mk].customers[c.id];
        return h ? { month: mk, spend: round2(h.spend), txns: h.txns, activeDays: h.activeDays, hotspotSpend: round2(h.hotspotSpend), ppoeSpend: round2(h.ppoeSpend), lastPurchase: h.lastPurchase } : { month: mk, spend: 0, note: 'no activity' };
      });
      const tx = out.filter((r) => r.cid === c.id);
      const ppoeDays = tx.filter((r) => r.amt > HOTSPOT_MAX).map((r) => r.day);
      return {
        profile: { ...c, spendChangePct: c.spendChangePct === null ? null : round2(c.spendChangePct * 100) + '%', currentSpend: round2(c.currentSpend), previousSpend: round2(c.previousSpend), lifetimeSpend: round2(c.lifetimeSpend), avgMonthlySpend: round2(c.avgMonthlySpend) },
        monthlyHistory: history,
        crmNote: crmNotes[c.id] || null,
        recentTransactions: tx.slice(-15).reverse().map((r) => ({ date: r.date, time: pad2(Math.floor(r.min / 60)) + ':' + pad2(r.min % 60), amount: r.amt })),
        usualPpoePayDaysOfMonth: ppoeDays.length ? [...new Set(ppoeDays)].sort((a, b) => a - b) : null,
      };
    }),
  };
}

function runCrmQuery(input, customerMaster, crmNotes) {
  const todayStr = dateKeyOf(new Date());
  const byId = {}; customerMaster.forEach((c) => { byId[c.id] = c; });
  let rows = Object.entries(crmNotes || {}).map(([id, n]) => ({ id, ...n, customer: byId[id] || null }));
  const has = (v, q) => (v || '').toLowerCase().includes(String(q).toLowerCase());
  if (input.owner) rows = rows.filter((r) => has(r.owner, input.owner));
  if (input.outcomeContains) rows = rows.filter((r) => has(r.outcome, input.outcomeContains));
  if (input.textContains) rows = rows.filter((r) => has(`${r.notes || ''} ${r.outcome || ''}`, input.textContains));
  if (input.followUpBefore) rows = rows.filter((r) => r.followUp && r.followUp <= input.followUpBefore);
  if (input.followUpAfter) rows = rows.filter((r) => r.followUp && r.followUp >= input.followUpAfter);
  if (input.overdue) rows = rows.filter((r) => r.followUp && r.followUp < todayStr);
  if (input.status) rows = rows.filter((r) => r.customer && r.customer.status.toLowerCase() === String(input.status).toLowerCase());
  rows.sort((a, b) => (a.followUp || '9999').localeCompare(b.followUp || '9999'));
  return {
    today: todayStr, totalNotesOnFile: Object.keys(crmNotes || {}).length, matchCount: rows.length,
    notes: rows.slice(0, Math.min(input.limit || 25, 100)).map((r) => ({
      id: r.id, owner: r.owner || null, followUp: r.followUp || null, overdue: !!(r.followUp && r.followUp < todayStr),
      outcome: r.outcome || null, notes: r.notes || null, updatedAt: r.updatedAt || null,
      status: r.customer ? r.customer.status : null, segment: r.customer ? r.customer.segment : null,
      currentSpend: r.customer ? round2(r.customer.currentSpend) : null, previousSpend: r.customer ? round2(r.customer.previousSpend) : null,
    })),
  };
}

function aggValues(values, metric) {
  const v = values.filter((x) => x !== null && x !== undefined && !Number.isNaN(x));
  if (!v.length) return null;
  if (metric === 'sum') return round2(v.reduce((a, b) => a + b, 0));
  if (metric === 'avg') return round2(v.reduce((a, b) => a + b, 0) / v.length);
  if (metric === 'min') return round2(Math.min(...v));
  if (metric === 'max') return round2(Math.max(...v));
  if (metric === 'median') { const t = [...v].sort((a, b) => a - b); const m = Math.floor(t.length / 2); return round2(t.length % 2 ? t[m] : (t[m - 1] + t[m]) / 2); }
  return null;
}

function runAnalysisTool(input, customerMaster, monthsData, extra) {
  extra = extra || {};
  if (input.metric === 'daily') return runDailyQuery(input, monthsData || {});
  if (input.metric === 'txns') return runTxnQuery(input, monthsData || {}, customerMaster);
  if (input.metric === 'newClients') return runNewClientsQuery(input, monthsData || {}, customerMaster);
  if (input.metric === 'trend') return runTrendQuery(monthsData || {}, extra.analysis);
  if (input.metric === 'customer') return runCustomerLookup(input, customerMaster, monthsData || {}, extra.crmNotes || {});
  if (input.metric === 'crm') return runCrmQuery(input, customerMaster, extra.crmNotes || {});
  const todayStr = dateKeyOf(new Date());
  const filters = Array.isArray(input.filters) ? input.filters : [];
  let rows = customerMaster.filter((c) => filters.every((f) => matchFilter(c, f, todayStr)));
  const metric = input.metric;

  if (input.groupBy && metric !== 'list') {
    const groups = {};
    rows.forEach((c) => { const k = String(getFieldValue(c, input.groupBy, todayStr)); (groups[k] = groups[k] || []).push(c); });
    const res = Object.entries(groups).map(([k, cs]) => ({
      group: k, count: cs.length,
      ...(metric !== 'count' && input.field ? { [`${metric}_${input.field}`]: aggValues(cs.map((c) => getFieldValue(c, input.field, todayStr)), metric) } : {}),
    })).sort((a, b) => b.count - a.count);
    return { matchCount: rows.length, groupBy: input.groupBy, groups: res.slice(0, 50) };
  }
  if (metric === 'count') return { matchCount: rows.length };

  if (metric === 'list') {
    let sorted = rows;
    if (input.sortBy) {
      const dir = input.sortDir === 'asc' ? 1 : -1;
      sorted = [...rows].sort((a, b) => {
        const av = getFieldValue(a, input.sortBy, todayStr), bv = getFieldValue(b, input.sortBy, todayStr);
        if (av === bv) return 0;
        if (av === null || av === undefined) return 1;
        if (bv === null || bv === undefined) return -1;
        return typeof av === 'string' ? av.localeCompare(bv) * dir : (av - bv) * dir;
      });
    }
    const limit = Math.min(input.limit || 20, 300);
    return {
      matchCount: rows.length,
      returnedCount: Math.min(limit, sorted.length),
      customers: sorted.slice(0, limit).map((c) => ({
        id: c.id, behaviour: c.behaviour, segment: c.segment, status: c.status, churnRisk: c.churnRisk,
        opportunity: c.opportunity, currentSpend: round2(c.currentSpend), previousSpend: round2(c.previousSpend),
        spendChangePct: c.spendChangePct === null ? null : round2(c.spendChangePct * 100) + '%',
        txns: c.txns, activeDays: c.activeDays, maxTxn: round2(c.maxTxn),
        avgPerActiveDay: c.activeDays ? round2(c.currentSpend / c.activeDays) : null,
        avgPerTxn: c.txns ? round2(c.currentSpend / c.txns) : null,
        hotspotSpend: round2(c.hotspotSpend), ppoeSpend: round2(c.ppoeSpend),
        lastPurchase: c.lastPurchase, daysSinceLastPurchase: getFieldValue(c, 'daysSinceLastPurchase', todayStr),
      })),
    };
  }

  // numeric aggregation: sum / avg / min / max / median
  const field = input.field;
  const values = rows.map((c) => getFieldValue(c, field, todayStr)).filter((v) => v !== null && v !== undefined && !Number.isNaN(v));
  if (values.length === 0) return { matchCount: rows.length, result: null, note: 'No customers matched, or the chosen field has no numeric values for the matched customers.' };
  let result;
  if (metric === 'sum') result = values.reduce((a, b) => a + b, 0);
  else if (metric === 'avg') result = values.reduce((a, b) => a + b, 0) / values.length;
  else if (metric === 'min') result = Math.min(...values);
  else if (metric === 'max') result = Math.max(...values);
  else if (metric === 'median') {
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    result = s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  } else return { error: `Unknown metric "${metric}". Use count, sum, avg, min, max, median, or list.` };
  return { matchCount: rows.length, valuesCounted: values.length, result: round2(result) };
}

function buildAiSystemPrompt(analysis, monthsData, crmNotes) {
  if (analysis.empty) {
    return 'No customer data has been imported into this system yet. Tell the person to import a statement first — nothing else can be answered until then.';
  }
  const cm = analysis.customerMaster;
  const currentMeta = monthsData[analysis.current];
  const retLatest = analysis.retentionSeries[analysis.retentionSeries.length - 1];
  const notesCount = Object.keys(crmNotes || {}).length;
  const rev = analysis.revenueByMonth[analysis.revenueByMonth.length - 1];
  const txMonths = analysis.sorted.filter((mk) => monthsData[mk].tx && monthsData[mk].tx.length);
  const cycleText = (analysis.packageCycles || []).slice(0, 12).map((x) => `KSh ${x.amount} ${x.label}`).join(', ');
  const calendar = Array.from({ length: 21 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() - i); return `${dateKeyOf(d)}=${WEEKDAYS[d.getDay()]}`; }).join(', ');
  const noTxMonths = analysis.sorted.filter((mk) => !(monthsData[mk].tx && monthsData[mk].tx.length));

  return `# ROLE
You are the Customer Intelligence Assistant for the Business Administrator of Happynet Technologies LLP, a small Kenyan ISP selling internet access over M-Pesa. You are a business-administration tool for one person, not an enterprise CRM. Your only source of truth is the customer dataset in this system (imported from Happynet's M-Pesa Utility Account statements) — never assume facts from any other system.

# YOUR JOB
Retrieve → separate → analyse → explain → warn → recommend. Turn the data into a useful, commercial answer. The Administrator asks in plain language and should never need to know field names or formulas.

# HOW TO GET EXACT NUMBERS — READ CAREFULLY, THIS IS THE FIX FOR A PROBLEM YOU HAD BEFORE
You do NOT have function-calling / tool-use in this chat, and you do not have the full customer list in front of you — only the headline numbers below. **Never estimate a count, sum, average, median, min/max, or list from memory or from the headline numbers alone, and never say data is unavailable without querying first.** Instead, to get an exact number, output one or more query blocks and NOTHING else in that turn (no commentary, no partial answer, just the query block(s)) — the system will run them against the real data and send you back exact results in your next turn. Do this silently; never show the person the query syntax or mention "querying" — just do it and then answer.

Query block format — output exactly this, one per lookup needed:
<query>{"metric":"avg","field":"avgPerActiveDay","filters":[{"field":"segment","op":"eq","value":"VIP"}]}</query>

Rules for the JSON inside <query>:
- "metric": one of "count", "sum", "avg", "min", "max", "median", "list". Use "list" to get actual customer rows (id, spend, status, etc.), sorted.
- "field": the field to aggregate/sort by. Required for sum/avg/min/max/median/list-with-sort; omit for plain count.
- "filters": array of {"field","op","value"}, combined with AND. Omit or use [] for the whole customer base. op is one of eq, neq, gt, gte, lt, lte, contains.
- "sortBy" / "sortDir" ("asc"/"desc") and "limit" (max 300, default 20) — only used with metric "list".
- Valid field names: ${QUERYABLE_FIELDS.join(', ')}.
- For "around KSh X per day/transaction" questions, filter with a range (gte/lte around X) rather than eq, since computed averages rarely land on a round number.
- You may send several <query> blocks in one turn if a question needs several angles (e.g. Hotspot and PPOE separately, or several status groups for a report) — send them all at once rather than one at a time when you already know you'll need them.
- Once you have enough results, write the final plain-text answer with no <query> tags at all.

# ALL QUERY TYPES (each goes in its own <query>{...}</query> block; send several in one turn when needed)
1. CUSTOMER QUERIES (default): metric count/sum/avg/min/max/median/list over the customer base, with filters, as described above. NEW: add "groupBy":"<field>" (e.g. status, segment, behaviour, opportunity, firstMonth) with metric count, or sum/avg/median plus "field", to get a breakdown per group in one query. Extra customer fields: lifetimeSpend, monthsActive, firstMonth, lastActiveMonth, avgMonthlySpend.
2. TRANSACTIONS: {"metric":"txns", filters..., "groupBy":"day|week|weekday|dayOfMonth|hour|month|amount|customer|none"}. Optional filters: month ("YYYY-MM"), dateFrom/dateTo ("YYYY-MM-DD", inclusive - use these for rolling 7/14/30/60/90-day windows ending today), day or dayFrom/dayTo (day of month), product ("ppoe"/"hotspot"/"all"), customer (account fragment), identified:false (unidentified payers only), minAmount/maxAmount, hourFrom/hourTo (0-23, Nairobi time as exported). Optional sortBy ("key"/"revenue"/"txns"/"uniqueCustomers"), sortDir, limit. Each group returns revenue, txns, uniqueCustomers, Hotspot/PPOE revenue, avgTxn; customer groups also carry status/segment/behaviour/lastPurchase, and the result includes customerStatusMix (Growing/Retained/Declining... among the people matched). Use it for: busiest days/weeks/hours, spikes, who paid on a day, popular price points, typical pay day, weekday patterns, rolling windows, unidentified payments.
3. DAILY TOTALS: {"metric":"daily","month":"YYYY-MM","product":"ppoe","day":28} - fast daily revenue totals with rank and share of month (works even for months without a transaction log).
3b. NEW CLIENTS: {"metric":"newClients","product":"hotspot","dateFrom":"2026-10-03","dateTo":"2026-10-04","groupBy":"day"} - counts accounts whose FIRST-EVER payment fell on each day (product = product of that first payment; groupBy day/weekday/none; optional month, list:N to name accounts). Use this for ANY question about new clients on a day, weekend or week - it is exact, unlike the monthly status tag New (never answer these from the status tag). The result already contains new-client revenue per join day, spend over the range, clients who bought on more than one date, top spenders and top packages, so use those fields instead of estimating; label every day with its date AND its true weekday from the calendar, and never say someone joined on a later day than they came back.
4. TREND: {"metric":"trend"} - month-by-month revenue (Hotspot/PPOE), txns, active customers, new customers, avg PPOE ticket, unidentified revenue, retention vs previous month. Use for growth, seasonality, month-over-month and "how are we doing" questions.
5. CUSTOMER LOOKUP: {"metric":"customer","id":"0712345678"} (full or partial) - profile, month-by-month history, CRM note, last 15 transactions, usual PPOE pay days.
6. CRM / FOLLOW-UPS: {"metric":"crm", optional owner, status, followUpBefore, followUpAfter, overdue:true, outcomeContains, textContains, limit}. Use for follow-ups due, overdue calls, who owns whom, notes about a customer group.

# INVESTIGATING "WHY" QUESTIONS
For why/what-happened questions (a spike, a drop, a bad week), do not stop at one number. In your first turn send several queries together: the period in question grouped by day, the same day/period in other months, the customers behind it (txns grouped by customer, with the status mix), and the amount or hour distribution. Then answer: what happened (numbers), who drove it (customers or segments, naming the biggest), and what likely explains it. State facts as facts and causes as clearly-labelled hypotheses (e.g. month-end billing clustering, salary days, plan expiry, a single large payer, a promo) with the evidence for or against each. If the evidence cannot separate the explanations, say so and name the extra data that would.

# PRODUCT CLASSIFICATION (fixed rule, always applied)
KSh 1-${HOTSPOT_MAX} per transaction = Hotspot. KSh ${HOTSPOT_MAX + 1}+ = PPOE. Every customer is Hotspot Only, PPOE Only, or Mixed. Never blend Hotspot and PPOE figures unless asked for a combined/comparison view — when comparing, always show both the absolute values and the split.

# DATA COVERAGE AND REAL LIMITATIONS (be upfront about these, never fabricate around them)
Months on file: ${analysis.sorted.map(monthLabel).join(', ')}. Current period = ${monthLabel(analysis.current)}${currentMeta.isMTD ? ` (MONTH-TO-DATE — day ${currentMeta.daysElapsed} of ${currentMeta.daysInPeriod}, not a finished month)` : ' (complete month)'}. Previous period = ${analysis.previous ? monthLabel(analysis.previous) : 'none imported yet'}.
- Today's date is ${dateKeyOf(new Date())} (${WEEKDAYS[new Date().getDay()]}). Recent calendar - always quote weekday names exactly as listed here, never work them out yourself: ${calendar}. Per-transaction log (exact date, time of day, customer, amount) is on file for: ${txMonths.length ? txMonths.map(monthLabel).join(', ') : 'NO months yet'}. ${noTxMonths.length ? 'Months imported before transaction logging existed (' + noTxMonths.map(monthLabel).join(', ') + ') only have customer monthly totals and daily revenue totals — for questions needing transaction-level detail on those months, say so and ask the person to re-import that month statement CSV once.' : 'Every month on file has the full transaction log.'}
- Daily, weekly, hourly, rolling-window and per-customer-per-day questions ARE answerable with the txns query below whenever the log exists. Never say the data does not support a daily/weekly/time question without first running a query.
- PPOE BILLING RULE: PPOE customers pay on a cycle - daily, weekly, half-monthly (15 days) or monthly depending on the package amount (detected: ${cycleText || 'none yet'}). A PPOE customer is churned only when overdue by more than one full cycle past their due date. Status "Not yet due" means: paid before, nothing yet this month, but the next payment is not due (or is inside a short grace period) - NEVER call these customers churned, lost or inactive, and never include them in win-back lists. Use the fields ppoeCycle, ppoeLastPaid, ppoeLastAmount, ppoeDueDate, ppoeDueState (not due / in grace / overdue / lapsed) and daysToDue for renewal, collections and expected-revenue questions (e.g. sum ppoeLastAmount over customers with ppoeDueDate between today and month end). PPOE payment data runs to ${analysis.ppoeAsOf}.
- A month imported earlier still supports the cheap daily-totals query (metric daily). Prefer txns when the log exists.
- avgPerActiveDay and avgPerTxn are period averages per customer, not literal daily transaction logs.
- ${currentMeta.isMTD ? 'Because the current period is still in progress, always call it "observed MTD" (inactivity/retention/etc.) rather than a final figure, and say so explicitly in any answer that touches retention, churn, or period comparisons.' : 'The current period is complete, so retention/churn figures for it are final.'}
- ${notesCount} customer(s) have a manual CRM note (owner / follow-up date / outcome / notes) on file. These ARE queryable with metric crm and metric customer.

# HEADLINE NUMBERS (already computed, for quick reference — query for anything more specific)
Total customers on file: ${cm.length}. Revenue this period: KSh ${Math.round(rev?.Total || 0)} (Hotspot KSh ${Math.round(rev?.Hotspot || 0)}, PPOE KSh ${Math.round(rev?.PPOE || 0)}). Retention vs previous period: ${retLatest ? fmtPct(retLatest.retentionRate) : 'n/a (need 2+ months)'}. Inactivity/churn vs previous period: ${retLatest ? fmtPct(retLatest.inactivityRate) : 'n/a'}. Revenue previously earned from now-inactive customers: KSh ${Math.round(analysis.revenueLostInactive)}.

# ANSWER STYLE
The chat window shows PLAIN TEXT only: do not use markdown (no **bold**, no # headings, no | tables). Use short lines, simple dashes for lists, and aligned plain-text rows like "Name - KSh 1,200 - Declining". Format money as KSh 12,345. Start with the answer and the important number(s) first. Use a short table for customer lists. Separate Hotspot and PPOE when relevant. Highlight warnings and revenue opportunities plainly. Don't dump raw customer lists unless asked — summarize first, then name specific customers who matter most (highest revenue, highest risk, most recent). Never invent customers, amounts, or dates; if a query returns nothing or the question needs data this system doesn't have, say so directly: "The available data doesn't support this reliably" — then offer the closest thing you can answer. Keep answers commercial and concise; expand into a fuller structured report (with headings) only when asked for "a report", "everything", or a named report type (warning report, opportunity report, top customers, declining customers, inactive customers).

# WHEN ASKED FOR A BROAD REPORT ("analyse my customers" / "give me everything" / "warning report" / "opportunity report")
Send all the query blocks you'll need up front in one turn (overview counts, revenue split, top risks, top opportunities), then once results come back, structure the answer: overview (customers, revenue, Hotspot vs PPOE), customer health (status breakdown), top risks (highest-revenue customers who are Declining or Inactive/Churn-risk — name them with amounts), top opportunities (by opportunity type, highest value first), and a short management conclusion (3-5 bullet takeaways). For a "warning report" specifically, rank by revenue at risk first, then explain why each customer is flagged and what to do.`;
}

function extractQueries(text) {
  const re = /<query>([\s\S]*?)<\/query>/g;
  const out = [];
  let m;
  while ((m = re.exec(text)) !== null) {
    try { out.push(JSON.parse(m[1])); } catch (e) { out.push({ __parseError: e.message, raw: m[1] }); }
  }
  return out;
}
function stripQueryTags(text) {
  return text.replace(/<query>[\s\S]*?<\/query>/g, '').trim();
}

async function callClaudeOnce(systemPrompt, messages) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 2500,
      system: systemPrompt,
      messages,
    }),
  });
  if (!res.ok) throw new Error(`Request failed (${res.status})`);
  const data = await res.json();
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

async function runAiConversation(systemPrompt, history, question, customerMaster, monthsData, extra) {
  let messages = [...history.map((m) => ({ role: m.role, content: m.content })), { role: 'user', content: question }];
  for (let iter = 0; iter < 8; iter++) {
    const text = await callClaudeOnce(systemPrompt, messages);
    const queries = extractQueries(text);
    if (queries.length === 0) {
      const clean = stripQueryTags(text);
      return clean || "I couldn't generate a response — try rephrasing the question.";
    }
    const resultsText = queries.map((q, i) => {
      if (q.__parseError) return `Query ${i + 1}: could not be read (${q.__parseError}) — re-send it as valid JSON.`;
      let result;
      try { result = runAnalysisTool(q, customerMaster, monthsData, extra); } catch (e) { result = { error: e.message || String(e) }; }
      return `Query ${i + 1} (${JSON.stringify(q)}) result: ${JSON.stringify(result)}`;
    }).join('\n');
    messages = [
      ...messages,
      { role: 'assistant', content: text },
      { role: 'user', content: `[QUERY RESULTS]\n${resultsText}\n\nUse these exact numbers — do not recompute or guess. Send more <query> blocks only if you genuinely still need another lookup, otherwise write the final plain-text answer now (no <query> tags).` },
    ];
  }
  return "This question needed more lookups than I could finish in one go — try narrowing it (e.g. one product type or one status at a time).";
}

// ---------------------------------------------------------------------------
// UI bits
// ---------------------------------------------------------------------------
function KpiCard({ label, value, sub, tone }) {
  return (
    <div className={`kpi-card ${tone || ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  );
}

function Badge({ text, colorMap }) {
  const color = (colorMap && colorMap[text]) || '#4B5A6A';
  return <span className="badge" style={{ background: color + '20', color }}>{text}</span>;
}

function InfoPanel() {
  const [open, setOpen] = useState(false);
  return (
    <div className="info-panel">
      <button className="info-toggle" onClick={() => setOpen(!open)}>
        <Info size={14} /> About these numbers
      </button>
      {open && (
        <div className="info-body">
          <p><strong>Customer ID</strong> — the phone number used to pay (last 9 digits), or the Happynet account code when a customer pays with one instead of a phone number.</p>
          <p><strong>Hotspot vs PPOE</strong> — Hotspot = payments of KSh 1–{HOTSPOT_MAX}. PPOE = KSh {HOTSPOT_MAX + 1}+.</p>
          <p><strong>Current period</strong> is always the most recently imported month. If that month isn't finished yet, it's treated as month-to-date (MTD) — spend, retention and status all compare it to the prior month on a daily-rate basis, not raw totals, so a partial month doesn't look like a collapse.</p>
          <p><strong>Value segment</strong> tiers (on a projected full-month basis): Casual ≤ {TIER_CASUAL_MAX} · Developing ≤ {TIER_DEVELOPING_MAX} · Active ≤ {TIER_ACTIVE_MAX} · High Value ≤ {TIER_HIGHVALUE_MAX} · VIP above that.</p>
          <p><strong>Status</strong> — New: first-ever transaction this period. Growing/Stable/Declining: active this period and last period, compared by daily run-rate (±15% band). Retained: back after skipping the prior period. Inactive/Churn-risk: had activity before, none this period. <strong>PPOE exception:</strong> PPOE customers pay on a cycle (weekly or monthly, detected from the package amount), so one who has not paid yet this month but whose next payment is not due - or is still inside a short grace period - is shown as <em>Not yet due</em>, not churned. A PPOE customer is only counted as churn once overdue by more than a full cycle.</p>
        </div>
      )}
    </div>
  );
}

function NoteModal({ customerId, note, onClose, onSave }) {
  const [owner, setOwner] = useState(note?.owner || '');
  const [followUp, setFollowUp] = useState(note?.followUp || '');
  const [outcome, setOutcome] = useState(note?.outcome || '');
  const [notes, setNotes] = useState(note?.notes || '');
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    await onSave(customerId, { owner, followUp, outcome, notes });
    setSaving(false);
    onClose();
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>Follow-up — {customerId}</h3>
          <button className="modal-x" onClick={onClose}><X size={16} /></button>
        </div>
        <label>Owner<input value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Who's handling this customer" /></label>
        <label>Next follow-up<input type="date" value={followUp} onChange={(e) => setFollowUp(e.target.value)} /></label>
        <label>Outcome<input value={outcome} onChange={(e) => setOutcome(e.target.value)} placeholder="e.g. Called, will renew next week" /></label>
        <label>Notes<textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} /></label>
        <div style={{ display: 'flex', gap: 10, marginTop: 6 }}>
          <button className="btn" disabled={saving} onClick={save}>{saving ? 'Saving…' : 'Save'}</button>
          <button className="btn secondary" style={{ border: '1px solid var(--line)', color: 'var(--ink-soft)' }} onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

const NAV_ITEMS = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'ask', label: 'Ask AI', icon: Sparkles },
  { id: 'customers', label: 'Customer Master', icon: Users },
  { id: 'segments', label: 'Segments', icon: PieIcon },
  { id: 'movement', label: 'Movement', icon: GitBranch },
  { id: 'retention', label: 'Retention & Churn', icon: RefreshCw },
  { id: 'revenue', label: 'Revenue Analysis', icon: DollarSign },
  { id: 'projection', label: 'Projection', icon: TrendingUp },
  { id: 'import', label: 'Import Data', icon: Upload },
];

export default function HappynetAnalytics() {
  const [monthsData, setMonthsData] = useState({});
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState('dashboard');

  // import state
  const [parsing, setParsing] = useState(false);
  const [importPreview, setImportPreview] = useState(null); // { buckets, files: [...] }
  const [importError, setImportError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const fileInputRef = useRef(null);

  // customer table state
  const [search, setSearch] = useState('');
  const [fStatus, setFStatus] = useState('All');
  const [fSegment, setFSegment] = useState('All');
  const [fBehaviour, setFBehaviour] = useState('All');
  const [fOpportunity, setFOpportunity] = useState('All');
  const [fRisk, setFRisk] = useState('All risk');
  const [sortKey, setSortKey] = useState('currentSpend');
  const [sortDir, setSortDir] = useState('desc');
  const [page, setPage] = useState(1);

  // CRM notes (owner / follow-up / outcome / notes) — persisted separately from monthly imports
  const [crmNotes, setCrmNotes] = useState({});
  const [noteModalId, setNoteModalId] = useState(null);

  // AI assistant
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [chatError, setChatError] = useState(null);
  const [chatId, setChatId] = useState(null);
  const [chatList, setChatList] = useState([]);
  const [showPast, setShowPast] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [chatNotice, setChatNotice] = useState(null);
  useEffect(() => { loadChatIndex().then(setChatList); }, []);

  const refreshAll = useCallback(async () => {
    const idx = await loadIndex();
    const data = {};
    for (const mk of idx) {
      const m = await loadMonth(mk);
      if (m) data[mk] = m;
    }
    setMonthsData(data);
    setLoaded(true);
  }, []);

  useEffect(() => { refreshAll(); }, [refreshAll]);
  useEffect(() => { loadCrmNotes().then(setCrmNotes); }, []);

  async function handleSaveCrmNote(id, fields) {
    const updated = { ...crmNotes, [id]: { ...crmNotes[id], ...fields, updatedAt: new Date().toISOString() } };
    setCrmNotes(updated);
    await saveCrmNotes(updated);
  }

  const [pkgOverrides, setPkgOverrides] = useState({});
  const [openPkg, setOpenPkg] = useState(null);
  useEffect(() => { loadPkgOverrides().then(setPkgOverrides); }, []);
  const analysis = useMemo(() => computeAnalysis(monthsData, pkgOverrides), [monthsData, pkgOverrides]);
  const pace = useMemo(() => computePace(monthsData, analysis), [monthsData, analysis]);
  const patterns = useMemo(() => computePatterns(monthsData, analysis), [monthsData, analysis]);

  // ---- import handlers ----
  async function handleFiles(fileList) {
    setImportError(null);
    setSaveMsg(null);
    setParsing(true);
    try {
      const files = Array.from(fileList).filter((f) => f.name.toLowerCase().endsWith('.csv'));
      if (files.length === 0) throw new Error('Please select one or more .csv statement exports.');
      let merged = {};
      const fileSummaries = [];
      for (const f of files) {
        const res = await parseCSVFile(f);
        merged = mergeBuckets(merged, res.buckets);
        fileSummaries.push({ name: res.fileName, period: res.periodLine, rowsParsed: res.rowsParsed, rowsIncluded: res.rowsIncluded, rowsSkipped: res.rowsSkipped });
      }
      setImportPreview({ buckets: merged, files: fileSummaries });
    } catch (e) {
      setImportError(e.message || String(e));
      setImportPreview(null);
    } finally {
      setParsing(false);
    }
  }

  async function confirmSave() {
    if (!importPreview) return;
    setSaving(true);
    try {
      const keys = Object.keys(importPreview.buckets);
      for (const mk of keys) {
        await saveMonth(mk, importPreview.buckets[mk]);
      }
      await saveIndex([...(await loadIndex()), ...keys]);
      await refreshAll();
      setSaveMsg(`Saved ${keys.map(monthLabel).join(', ')} to the system.`);
      setImportPreview(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (e) {
      setImportError('Could not save: ' + (e.message || String(e)));
    } finally {
      setSaving(false);
    }
  }

  async function handleAskAI(preset) {
    const question = (preset !== undefined ? preset : chatInput).trim();
    if (!question || chatLoading) return;
    setChatError(null);
    setChatInput('');
    const nextHistory = [...chatMessages, { role: 'user', content: question }];
    setChatMessages(nextHistory);
    setChatLoading(true);
    try {
      const systemPrompt = buildAiSystemPrompt(analysis, monthsData, crmNotes);
      const answer = await runAiConversation(systemPrompt, chatMessages, question, analysis.customerMaster, monthsData, { analysis, crmNotes });
      const finalMsgs = [...nextHistory, { role: 'assistant', content: answer }];
      setChatMessages(finalMsgs);
      const savedId = await persistChat(finalMsgs, chatId);
      setChatId(savedId);
    } catch (e) {
      setChatError('Could not reach the assistant: ' + (e.message || String(e)));
    } finally {
      setChatLoading(false);
    }
  }

  function flashNotice(t) { setChatNotice(t); setTimeout(() => setChatNotice(null), 3500); }

  async function persistChat(messages, idIn) {
    const id = idIn || `c${Date.now()}`;
    const firstQ = ((messages.find((m) => m.role === 'user') || {}).content) || 'Chat';
    const entry = { id, title: firstQ.length > 70 ? firstQ.slice(0, 70) + '…' : firstQ, updatedAt: new Date().toISOString(), count: messages.length };
    try {
      await saveChat(id, messages);
      const idx = (await loadChatIndex()).filter((c) => c.id !== id);
      idx.unshift(entry);
      await saveChatIndex(idx);
      setChatList(idx);
    } catch (e) { /* history is best-effort */ }
    return id;
  }

  function handleNewChat() {
    setChatMessages([]); setChatId(null); setChatError(null); setConfirmDelete(null);
  }

  async function handleOpenChat(id) {
    const msgs = await loadChat(id);
    if (!msgs) { setChatError('That chat could not be loaded.'); return; }
    setChatMessages(msgs); setChatId(id); setChatError(null); setShowPast(false); setConfirmDelete(null);
  }

  async function handleDeleteChat(which) {
    const id = which === 'current' ? chatId : which;
    if (id) {
      await deleteChatStore(id);
      const idx = (await loadChatIndex()).filter((c) => c.id !== id);
      await saveChatIndex(idx);
      setChatList(idx);
    }
    if (which === 'current' || id === chatId) { setChatMessages([]); setChatId(null); setChatError(null); }
    setConfirmDelete(null);
    flashNotice('Chat deleted.');
  }

  async function handlePrintChat(which) {
    try {
      let msgs = chatMessages, title = null;
      if (which !== 'current') {
        msgs = await loadChat(which);
        if (!msgs) { setChatError('That chat could not be loaded.'); return; }
      }
      const id = which === 'current' ? chatId : which;
      const entry = chatList.find((c) => c.id === id);
      title = entry ? entry.title : (((msgs.find((m) => m.role === 'user') || {}).content) || 'Chat').slice(0, 70);
      downloadPdf(`happynet-ai-chat-${dateKeyOf(new Date())}.pdf`, buildChatPdf(title, msgs));
      flashNotice('PDF report downloaded.');
    } catch (e) {
      setChatError('Could not create the PDF: ' + (e.message || String(e)));
    }
  }

  async function handleDeleteMonth(mk) {
    await deleteMonth(mk);
    await refreshAll();
  }

  // ---- customer table derived ----
  const filteredCustomers = useMemo(() => {
    if (analysis.empty) return [];
    let rows = analysis.customerMaster;
    if (search.trim()) rows = rows.filter((r) => r.id.toLowerCase().includes(search.trim().toLowerCase()));
    if (fStatus !== 'All') rows = rows.filter((r) => r.status === fStatus);
    if (fSegment !== 'All') rows = rows.filter((r) => r.segment === fSegment);
    if (fBehaviour !== 'All') rows = rows.filter((r) => r.behaviour === fBehaviour);
    if (fOpportunity !== 'All') rows = rows.filter((r) => r.opportunity === fOpportunity);
    if (fRisk !== 'All risk') rows = rows.filter((r) => r.churnRisk === fRisk);
    const dir = sortDir === 'asc' ? 1 : -1;
    rows = [...rows].sort((a, b) => {
      const av = a[sortKey], bv = b[sortKey];
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'string') return av.localeCompare(bv) * dir;
      return (av - bv) * dir;
    });
    return rows;
  }, [analysis, search, fStatus, fSegment, fBehaviour, fOpportunity, fRisk, sortKey, sortDir]);

  const totalPages = Math.max(1, Math.ceil(filteredCustomers.length / PAGE_SIZE));
  const pageRows = filteredCustomers.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);

  function toggleSort(key) {
    if (sortKey === key) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(key); setSortDir('desc'); }
    setPage(1);
  }

  const opportunityCounts = useMemo(() => {
    if (analysis.empty) return [];
    const counts = {};
    analysis.customerMaster.forEach((c) => { counts[c.opportunity] = (counts[c.opportunity] || 0) + 1; });
    return Object.entries(counts).map(([k, v]) => ({ opportunity: k, count: v })).sort((a, b) => b.count - a.count);
  }, [analysis]);

  const statusCounts = useMemo(() => {
    if (analysis.empty) return [];
    const counts = {};
    STATUS_LIST.forEach((s) => (counts[s] = 0));
    analysis.customerMaster.forEach((c) => { counts[c.status] = (counts[c.status] || 0) + 1; });
    return STATUS_LIST.map((s) => ({ status: s, count: counts[s] || 0 }));
  }, [analysis]);

  const segmentCounts = useMemo(() => {
    if (analysis.empty) return [];
    const counts = {};
    SEGMENT_LIST.forEach((s) => (counts[s] = 0));
    analysis.customerMaster.forEach((c) => { counts[c.segment] = (counts[c.segment] || 0) + 1; });
    return SEGMENT_LIST.map((s) => ({ segment: s, count: counts[s] || 0 }));
  }, [analysis]);

  const behaviourCounts = useMemo(() => {
    if (analysis.empty) return [];
    const counts = {};
    BEHAVIOUR_LIST.forEach((s) => (counts[s] = 0));
    let totalSpend = 0;
    const spendBy = {};
    analysis.customerMaster.forEach((c) => {
      counts[c.behaviour] = (counts[c.behaviour] || 0) + 1;
      spendBy[c.behaviour] = (spendBy[c.behaviour] || 0) + c.currentSpend;
      totalSpend += c.currentSpend;
    });
    return BEHAVIOUR_LIST.map((s) => ({ behaviour: s, count: counts[s] || 0, spend: spendBy[s] || 0, share: totalSpend ? (spendBy[s] || 0) / totalSpend : 0 }));
  }, [analysis]);

  const currentMonthMeta = !analysis.empty ? monthsData[analysis.current] : null;
  const isMtdNow = !!(currentMonthMeta && currentMonthMeta.isMTD);
  const chartStatus = isMtdNow ? statusCounts.filter((x) => x.status !== 'Inactive/Churn-risk') : statusCounts;
  const chartSegments = isMtdNow ? segmentCounts.filter((x) => !x.segment.startsWith('Inactive')) : segmentCounts;
  const chartOpps = isMtdNow ? opportunityCounts.filter((x) => x.opportunity !== 'Win-back outreach') : opportunityCounts;
  const notYetActive = (statusCounts.find((x) => x.status === 'Inactive/Churn-risk') || {}).count || 0;
  const newThisMonth = !analysis.empty ? patterns.newByMonth.find((x) => x.monthKey === analysis.current) : null;
  const todayKey = dateKeyOf(new Date());
  const daysSince = (d) => (d ? Math.max(0, Math.floor((new Date(todayKey + 'T00:00:00') - new Date(d + 'T00:00:00')) / 864e5)) : null);
  const crmCols = (r) => ({ owner: (crmNotes[r.id] || {}).owner || '', note: (crmNotes[r.id] || {}).notes || '', follow: (crmNotes[r.id] || {}).followUp || '' });
  const dueFollowUps = Object.entries(crmNotes || {}).filter(([, n]) => n && n.followUp && n.followUp <= dateKeyOf(new Date(Date.now() + 7 * 864e5))).sort(([, a], [, b]) => a.followUp.localeCompare(b.followUp));
  function exportCustomers() {
    exportCsv(`happynet-customers-${todayKey}.csv`, [
      ['Customer ID', (r) => r.id], ['Behaviour', (r) => r.behaviour], ['Current spend', (r) => Math.round(r.currentSpend)], ['Txns', (r) => r.txns],
      ['Last purchase', (r) => r.lastPurchase || ''], ['Value segment', (r) => r.segment], ['Previous spend', (r) => Math.round(r.previousSpend)],
      ['Spend change %', (r) => (r.spendChangePct === null ? '' : (r.spendChangePct * 100).toFixed(1))], ['Status', (r) => r.status], ['Risk', (r) => r.churnRisk],
      ['Opportunity', (r) => r.opportunity], ['PPOE cycle', (r) => r.ppoeCycle || ''], ['PPOE next due', (r) => r.ppoeDueDate || ''], ['PPOE last amount', (r) => r.ppoeLastAmount || ''], ['CRM owner', (r) => crmCols(r).owner], ['CRM follow-up', (r) => crmCols(r).follow], ['CRM notes', (r) => crmCols(r).note],
    ], filteredCustomers);
  }
  function pkgPayments(amount) {
    const out = [];
    Object.keys(monthsData).sort().forEach((mk) => (monthsData[mk].tx || []).forEach(([d, min, cid, amt]) => {
      if (amt === amount) out.push({ date: `${mk}-${String(d).padStart(2, '0')}`, time: `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`, id: cid || '(unidentified)' });
    }));
    return out.sort((a, b) => (b.date + b.time).localeCompare(a.date + a.time));
  }
  async function setPkgCycle(amount, value) {
    const next = { ...pkgOverrides };
    if (value === 'auto') delete next[amount]; else next[amount] = value;
    setPkgOverrides(next);
    try { await window.storage.set('happynet_pkg_cycles', JSON.stringify(next)); } catch (e) { /* best effort */ }
  }
  function exportWinback() {
    exportCsv(`happynet-winback-${todayKey}.csv`, [
      ['Customer ID', (r) => r.id], ['Behaviour', (r) => r.behaviour], ['Last known spend', (r) => Math.round(r.previousSpend || r.ppoeLastAmount || 0)], ['Last purchase', (r) => r.lastPurchase || ''],
      ['Days since last purchase', (r) => daysSince(r.lastPurchase) ?? ''], ['Value segment', (r) => r.segment], ['CRM owner', (r) => crmCols(r).owner],
      ['CRM follow-up', (r) => crmCols(r).follow], ['CRM notes', (r) => crmCols(r).note],
    ], patterns.winback);
  }
  const retentionLatest = analysis.retentionSeries && analysis.retentionSeries.length
    ? analysis.retentionSeries[analysis.retentionSeries.length - 1] : null;

  const monthsInSystem = Object.keys(monthsData).sort().reverse();

  return (
    <div className="hn-root">
      <style>{`
        .hn-root { --paper:#F6F3EC; --ink:#1E2A38; --ink-soft:#4B5A6A; --line:#DAD4C4;
          --card:#FFFFFF; --amber:#C2792E; --amber-bg:#F7E9D8; --teal:#2F6E63; --teal-bg:#E1EEE9;
          --red:#B0432E; --red-bg:#F6E3DE; --gray-bg:#EDEAE0;
          display:flex; min-height:100vh; background:var(--paper); color:var(--ink);
          font-family:system-ui,-apple-system,"Segoe UI",sans-serif; font-size:14px; }
        .hn-root * { box-sizing:border-box; }
        .hn-nav { width:210px; flex-shrink:0; background:var(--ink); color:#fff; padding:20px 0; display:flex; flex-direction:column; }
        .hn-brand { padding:0 18px 18px; font-family:Georgia,serif; font-size:18px; font-weight:600; border-bottom:1px solid rgba(255,255,255,.15); margin-bottom:10px; }
        .hn-brand small { display:block; font-family:system-ui; font-size:11px; font-weight:400; opacity:.6; margin-top:4px; }
        .hn-navitem { display:flex; align-items:center; gap:10px; padding:10px 18px; cursor:pointer; opacity:.75; border-left:3px solid transparent; font-size:13px; }
        .hn-navitem:hover { opacity:1; background:rgba(255,255,255,.06); }
        .hn-navitem.active { opacity:1; border-left-color:var(--amber); background:rgba(255,255,255,.08); font-weight:600; }
        .hn-main { flex:1; padding:26px 32px 60px; overflow-x:hidden; max-width:1200px; }
        h1.hn-title { font-family:Georgia,serif; font-size:22px; margin:0 0 4px; }
        .hn-sub { color:var(--ink-soft); font-size:13px; margin-bottom:20px; }
        .kpi-row { display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:12px; margin-bottom:22px; }
        .kpi-card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
        .kpi-card.warn { border-color:var(--amber); background:var(--amber-bg); }
        .kpi-label { font-size:11px; color:var(--ink-soft); margin-bottom:6px; }
        .kpi-value { font-size:24px; font-weight:700; }
        .kpi-sub { font-size:11px; color:var(--ink-soft); margin-top:4px; }
        .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:16px 18px; margin-bottom:18px; }
        .card h2 { font-size:14px; font-weight:600; margin:0 0 12px; }
        .chart-grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
        @media (max-width:900px){ .chart-grid{grid-template-columns:1fr;} .hn-root{flex-direction:column;} .hn-nav{width:100%; flex-direction:row; overflow-x:auto;} }
        .info-panel { margin-bottom:18px; }
        .info-toggle { display:flex; align-items:center; gap:6px; background:none; border:1px solid var(--line); color:var(--ink-soft); font-size:12px; padding:6px 10px; border-radius:6px; cursor:pointer; }
        .info-body { background:var(--gray-bg); border-radius:8px; padding:12px 14px; margin-top:8px; font-size:12px; color:var(--ink-soft); line-height:1.6; }
        .info-body p { margin:0 0 8px; }
        .info-body p:last-child { margin-bottom:0; }
        table.hn-table { width:100%; border-collapse:collapse; font-size:12.5px; }
        table.hn-table th { text-align:left; padding:8px 10px; background:var(--ink); color:#fff; font-weight:600; cursor:pointer; white-space:nowrap; position:sticky; top:0; }
        table.hn-table th.nosort { cursor:default; }
        table.hn-table td { padding:7px 10px; border-bottom:1px solid var(--line); white-space:nowrap; }
        table.hn-table tr:hover td { background:var(--gray-bg); }
        .num { font-variant-numeric:tabular-nums; text-align:right; }
        table.hn-table th.num { text-align:right; }
        .hn-note { font-size:12px; color:var(--ink-soft); margin:-4px 0 12px; }
        .badge { display:inline-block; padding:2px 9px; border-radius:20px; font-size:11px; font-weight:600; }
        .filters { display:flex; gap:8px; flex-wrap:wrap; margin-bottom:14px; align-items:center; }
        .filters select, .filters input { padding:6px 9px; border:1px solid var(--line); border-radius:6px; font-size:12.5px; background:#fff; }
        .search-box { display:flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:6px; padding:5px 9px; background:#fff; }
        .search-box input { border:none; outline:none; font-size:12.5px; width:150px; }
        .pager { display:flex; align-items:center; gap:10px; justify-content:flex-end; margin-top:12px; font-size:12.5px; color:var(--ink-soft); }
        .pager button { display:flex; align-items:center; border:1px solid var(--line); background:#fff; border-radius:6px; padding:5px 8px; cursor:pointer; }
        .pager button:disabled { opacity:.4; cursor:default; }
        .dropzone { border:2px dashed var(--line); border-radius:12px; padding:36px 20px; text-align:center; background:#fff; cursor:pointer; }
        .dropzone:hover { border-color:var(--amber); }
        .dropzone input { display:none; }
        .btn { background:var(--ink); color:var(--paper); border:none; padding:9px 18px; border-radius:6px; font-size:13px; cursor:pointer; font-weight:600; }
        .btn:disabled { opacity:.5; cursor:default; }
        .btn.secondary { background:none; color:var(--red); border:1px solid var(--red); padding:5px 10px; font-size:11.5px; font-weight:500; }
        .msg-error { background:var(--red-bg); color:var(--red); border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:14px; display:flex; gap:8px; align-items:flex-start; }
        .msg-success { background:var(--teal-bg); color:var(--teal); border-radius:8px; padding:10px 14px; font-size:13px; margin-bottom:14px; display:flex; gap:8px; align-items:center; }
        .file-summary-row { display:flex; justify-content:space-between; font-size:12.5px; padding:7px 0; border-bottom:1px solid var(--line); }
        .bucket-table th, .bucket-table td { padding:6px 10px; font-size:12.5px; }
        .empty-state { text-align:center; padding:60px 20px; color:var(--ink-soft); }
        .warn-note { background:var(--amber-bg); border-left:3px solid var(--amber); border-radius:6px; padding:12px 14px; font-size:12.5px; color:#7A4413; margin-bottom:16px; display:flex; gap:8px; }
        .month-chip { display:flex; align-items:center; justify-content:space-between; padding:9px 12px; border:1px solid var(--line); border-radius:8px; margin-bottom:8px; background:#fff; }
        .spin { animation: hn-spin 1s linear infinite; }
        @keyframes hn-spin { from{transform:rotate(0)} to{transform:rotate(360deg)} }
        .crm-btn { display:flex; align-items:center; gap:3px; background:none; border:1px solid var(--line); border-radius:6px; padding:4px 7px; cursor:pointer; color:var(--ink-soft); font-size:12px; }
        .crm-btn:hover { border-color:var(--amber); color:var(--amber); }
        .chat-card { padding:0; display:flex; flex-direction:column; height:560px; }
        .chat-scroll { flex:1; overflow-y:auto; padding:18px 16px; display:flex; flex-direction:column; gap:12px; }
        .chat-empty { text-align:center; color:var(--ink-soft); font-size:13px; padding:40px 20px; margin:auto; }
        .chat-msg { display:flex; gap:8px; max-width:85%; }
        .chat-msg.user { align-self:flex-end; flex-direction:row-reverse; }
        .chat-avatar { width:26px; height:26px; border-radius:50%; background:var(--ink); color:#fff; display:flex; align-items:center; justify-content:center; flex-shrink:0; }
        .chat-msg.user .chat-avatar { background:var(--amber); }
        .chat-tools { display:flex; gap:8px; flex-wrap:wrap; align-items:center; margin:0 0 10px; }
        .chat-tool { display:inline-flex; align-items:center; gap:6px; background:#fff; border:1px solid var(--line); border-radius:8px; padding:6px 11px; font-size:12.5px; cursor:pointer; color:var(--ink); font-family:inherit; }
        .chat-tool:disabled { opacity:.45; cursor:default; }
        .chat-tool.danger { color:#9B2C2C; border-color:#E8BDBD; }
        .chat-tool.solid { background:#9B2C2C; color:#fff; border-color:#9B2C2C; }
        .past-panel { background:#fff; border:1px solid var(--line); border-radius:10px; margin-bottom:12px; max-height:260px; overflow:auto; }
        .past-row { display:flex; gap:10px; align-items:center; justify-content:space-between; padding:9px 12px; border-bottom:1px solid var(--line); font-size:12.5px; }
        .past-row:last-child { border-bottom:none; }
        .chat-bubble { background:var(--gray-bg); border-radius:10px; padding:10px 13px; font-size:13px; line-height:1.55; white-space:pre-wrap; }
        .chat-msg.user .chat-bubble { background:var(--teal-bg); }
        .chat-input-row { display:flex; gap:8px; border-top:1px solid var(--line); padding:12px 16px; }
        .chat-input-row input { flex:1; padding:9px 12px; border:1px solid var(--line); border-radius:8px; font-size:13px; }
        .report-cmds { display:flex; flex-wrap:wrap; gap:8px; margin-bottom:14px; }
        .cmd-chip { background:#fff; border:1px solid var(--line); color:var(--ink); font-size:12px; padding:6px 12px; border-radius:20px; cursor:pointer; }
        .cmd-chip:hover { border-color:var(--amber); color:var(--amber); }
        .cmd-chip:disabled { opacity:.5; cursor:default; }
        .modal-backdrop { position:fixed; inset:0; background:rgba(30,42,56,.45); display:flex; align-items:center; justify-content:center; z-index:50; }
        .modal-card { background:#fff; border-radius:12px; padding:20px 22px; width:360px; max-width:90vw; display:flex; flex-direction:column; gap:10px; }
        .modal-head { display:flex; justify-content:space-between; align-items:center; margin-bottom:4px; }
        .modal-head h3 { margin:0; font-size:15px; }
        .modal-x { background:none; border:none; cursor:pointer; color:var(--ink-soft); }
        .modal-card label { display:flex; flex-direction:column; gap:4px; font-size:12px; color:var(--ink-soft); font-weight:600; }
        .modal-card input, .modal-card textarea { font-family:inherit; font-size:13px; padding:7px 9px; border:1px solid var(--line); border-radius:6px; color:var(--ink); font-weight:400; resize:vertical; }
      `}</style>

      <nav className="hn-nav">
        <div className="hn-brand">Happynet<small>Customer Analysis System</small></div>
        {NAV_ITEMS.map((item) => {
          const Icon = item.icon;
          return (
            <div key={item.id} className={`hn-navitem ${view === item.id ? 'active' : ''}`} onClick={() => setView(item.id)}>
              <Icon size={16} /> {item.label}
            </div>
          );
        })}
      </nav>

      <main className="hn-main">
        {!loaded ? (
          <div className="empty-state"><Loader2 className="spin" size={22} /> Loading…</div>
        ) : analysis.empty && view !== 'import' ? (
          <div className="empty-state">
            <h1 className="hn-title" style={{ marginBottom: 8 }}>No data yet</h1>
            <p>Import your first M-Pesa Utility Account statement to get started.</p>
            <button className="btn" style={{ marginTop: 14 }} onClick={() => setView('import')}>Go to Import Data</button>
          </div>
        ) : (
          <>
            {view === 'dashboard' && (
              <>
                <h1 className="hn-title">Dashboard</h1>
                <p className="hn-sub">
                  Current period: <strong>{monthLabel(analysis.current)}</strong>
                  {currentMonthMeta?.isMTD && <> — month-to-date, day {currentMonthMeta.daysElapsed} of {currentMonthMeta.daysInPeriod}</>}
                  {analysis.previous && <> · compared to {monthLabel(analysis.previous)}</>}
                </p>
                <InfoPanel />
                {currentMonthMeta?.isMTD && (
                  <div className="warn-note"><AlertTriangle size={16} style={{ flexShrink: 0 }} />
                    <span>{monthLabel(analysis.current)} is still in progress — treat inactivity/churn and spend-change figures below as early signals, not final-month numbers.</span>
                  </div>
                )}
                <div className="kpi-row">
                  <KpiCard label={`Revenue, ${monthLabel(analysis.current)}${isMtdNow ? ' (so far)' : ''}`} value={`KSh ${fmt(analysis.revenueByMonth[analysis.revenueByMonth.length - 1]?.Total)}`} sub={pace && pace.isMTD && pace.vsSamePeriod !== null ? `${fmtSigned(pace.vsSamePeriod)} vs first ${pace.days} days of ${pace.prevLabel}` : undefined} />
                  {pace && pace.isMTD && <KpiCard label="Projected month-end" value={`KSh ${fmt(pace.projected)}`} sub={pace.vsPrevFull !== null ? `${fmtSigned(pace.vsPrevFull)} vs ${pace.prevLabel} · ${pace.byShape ? "at last month's pattern" : 'at daily run-rate'}` : undefined} />}
                  {patterns.renewals && (patterns.renewals.dueNow.length + patterns.renewals.dueLater.length) > 0 && <KpiCard label="PPOE renewals still to come" value={fmt(patterns.renewals.dueNow.length + patterns.renewals.dueLater.length)} sub={`~KSh ${fmt(patterns.renewals.nowRevenue + patterns.renewals.laterRevenue)} at their last package, due by month end`} />}
                  {newThisMonth && <KpiCard label={`New clients, ${monthLabel(analysis.current)}`} value={fmt(newThisMonth.Total)} sub={`Hotspot ${fmt(newThisMonth.Hotspot)} · PPOE ${fmt(newThisMonth.PPOE)} (first payment)`} />}
                  <KpiCard label="Active customers" value={fmt(analysis.customerMaster.filter((c) => c.currentSpend > 0).length)} />
                  <KpiCard label="Retention rate" value={retentionLatest ? fmtPct(retentionLatest.retentionRate) : '—'} sub={analysis.previous ? `vs ${monthLabel(analysis.previous)}` : 'Need 2+ months'} />
                  <KpiCard tone={currentMonthMeta?.isMTD ? 'warn' : ''} label={currentMonthMeta?.isMTD ? 'Observed MTD inactivity' : 'Inactivity/churn rate'} value={retentionLatest ? fmtPct(retentionLatest.inactivityRate) : '—'} />
                  <KpiCard label="PPOE revenue share" value={fmtPct((analysis.revenueByMonth[analysis.revenueByMonth.length - 1]?.PPOE || 0) / (analysis.revenueByMonth[analysis.revenueByMonth.length - 1]?.Total || 1))} />
                </div>

                <div className="chart-grid">
                  <div className="card">
                    <h2>Revenue mix by month</h2>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={analysis.revenueByMonth}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#DAD4C4" />
                        <XAxis dataKey="month" fontSize={11} />
                        <YAxis fontSize={11} tickFormatter={fmtK} />
                        <Tooltip formatter={(v) => `KSh ${fmt(v)}`} />
                        <Legend />
                        <Bar dataKey="Hotspot" stackId="a" fill="#C2792E" />
                        <Bar dataKey="PPOE" stackId="a" fill="#2F6E63" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="card">
                    <h2>Customer status, {monthLabel(analysis.current)}</h2>
                    {isMtdNow && <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginBottom: 4 }}>Inactive/churn-risk ({fmt(notYetActive)} customers not yet active this month) is hidden until the month closes.</div>}
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={chartStatus} layout="vertical" margin={{ left: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#DAD4C4" />
                        <XAxis type="number" fontSize={11} />
                        <YAxis type="category" dataKey="status" fontSize={11} width={110} />
                        <Tooltip />
                        <Bar dataKey="count" fill="#1E2A38" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>

                <div className="card">
                  <h2>Daily revenue trend</h2>
                  <DailyTrendChart data={analysis.dailyRevenue} height={240} />
                </div>

                <div className="chart-grid">
                  <div className="card">
                    <h2>Value segments, {monthLabel(analysis.current)}</h2>
                    {isMtdNow && <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginBottom: 4 }}>Not-yet-active customers hidden while the month is in progress.</div>}
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={chartSegments} layout="vertical" margin={{ left: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#DAD4C4" />
                        <XAxis type="number" fontSize={11} />
                        <YAxis type="category" dataKey="segment" fontSize={10.5} width={140} />
                        <Tooltip />
                        <Bar dataKey="count" fill="#2F6E63" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="card">
                    <h2>Customer opportunity indicators</h2>
                    {isMtdNow && <div style={{ fontSize: 11.5, color: 'var(--ink-soft)', marginBottom: 4 }}>Win-back outreach ({fmt(notYetActive)}) shown on Retention & Churn instead - it is inflated until the month closes.</div>}
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={chartOpps} layout="vertical" margin={{ left: 10 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#DAD4C4" />
                        <XAxis type="number" fontSize={11} />
                        <YAxis type="category" dataKey="opportunity" fontSize={10} width={150} />
                        <Tooltip />
                        <Bar dataKey="count" fill="#C2792E" radius={[0, 4, 4, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              </>
            )}

            {view === 'ask' && (
              <>
                <h1 className="hn-title">Ask AI</h1>
                <p className="hn-sub">Ask anything in plain language, or run a ready-made report command below.</p>
                <div className="report-cmds">
                  {[
                    'Give me everything',
                    'Warning report',
                    'Revenue opportunity report',
                    'Top customers',
                    'Declining customers',
                    'Inactive customers',
                    'Compare Hotspot and PPOE',
                    'Payment-day patterns',
                    'Follow-ups due',
                  ].map((cmd) => (
                    <button key={cmd} className="cmd-chip" disabled={chatLoading} onClick={() => handleAskAI(cmd)}>{cmd}</button>
                  ))}
                </div>
                {Object.keys(monthsData).some((mk) => !(monthsData[mk].tx && monthsData[mk].tx.length)) && (
                  <div style={{ background: '#FBF3E4', border: '1px solid #E5C98F', color: '#7A5A14', borderRadius: 8, padding: '9px 12px', fontSize: 12.5, marginBottom: 12 }}>
                    Re-import {Object.keys(monthsData).filter((mk) => !(monthsData[mk].tx && monthsData[mk].tx.length)).sort().map(monthLabel).join(', ')} (Import tab) to unlock per-customer, per-day and per-hour answers for {Object.keys(monthsData).filter((mk) => !(monthsData[mk].tx && monthsData[mk].tx.length)).length > 1 ? 'those months' : 'that month'}. Daily totals and monthly figures already work.
                  </div>
                )}
                <div className="chat-tools">
                  <button className="chat-tool" onClick={handleNewChat}><Plus size={13} /> New chat</button>
                  <button className="chat-tool" onClick={() => setShowPast((v) => !v)}><History size={13} /> Past chats ({chatList.length})</button>
                  <button className="chat-tool" disabled={chatMessages.length === 0} onClick={() => handlePrintChat('current')}><FileDown size={13} /> Print report (PDF)</button>
                  {confirmDelete === 'current' ? (
                    <>
                      <span style={{ fontSize: 12.5 }}>Delete this chat permanently?</span>
                      <button className="chat-tool solid" onClick={() => handleDeleteChat('current')}>Yes, delete</button>
                      <button className="chat-tool" onClick={() => setConfirmDelete(null)}>Cancel</button>
                    </>
                  ) : (
                    <button className="chat-tool danger" disabled={chatMessages.length === 0} onClick={() => setConfirmDelete('current')}><Trash2 size={13} /> Delete chat</button>
                  )}
                  {chatNotice && <span style={{ fontSize: 12.5, color: '#2F6B4F' }}>{chatNotice}</span>}
                </div>
                {showPast && (
                  <div className="past-panel">
                    {chatList.length === 0 && <div className="past-row" style={{ color: '#777' }}>No saved chats yet. Chats are saved automatically after each answer.</div>}
                    {chatList.map((c) => (
                      <div key={c.id} className="past-row" style={c.id === chatId ? { background: '#F4F1EA' } : undefined}>
                        <div style={{ minWidth: 0, flex: 1 }}>
                          <div style={{ fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{c.title}</div>
                          <div style={{ color: '#777', fontSize: 11.5 }}>{new Date(c.updatedAt).toLocaleString()} · {c.count} messages</div>
                        </div>
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          <button className="chat-tool" onClick={() => handleOpenChat(c.id)}>Open</button>
                          <button className="chat-tool" onClick={() => handlePrintChat(c.id)}><FileDown size={13} /> PDF</button>
                          {confirmDelete === c.id ? (
                            <>
                              <button className="chat-tool solid" onClick={() => handleDeleteChat(c.id)}>Delete</button>
                              <button className="chat-tool" onClick={() => setConfirmDelete(null)}>No</button>
                            </>
                          ) : (
                            <button className="chat-tool danger" onClick={() => setConfirmDelete(c.id)}><Trash2 size={13} /></button>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className="card chat-card">
                  <div className="chat-scroll">
                    {chatMessages.length === 0 && (
                      <div className="chat-empty">
                        <Bot size={22} style={{ marginBottom: 8, opacity: .5 }} />
                        <div>Ask a question about your customers below. Answers are based only on the data currently in this system.</div>
                      </div>
                    )}
                    {chatMessages.map((m, i) => (
                      <div key={i} className={`chat-msg ${m.role}`}>
                        <div className="chat-avatar">{m.role === 'user' ? <UserIcon size={14} /> : <Bot size={14} />}</div>
                        <div className="chat-bubble">{m.content}</div>
                      </div>
                    ))}
                    {chatLoading && (
                      <div className="chat-msg assistant">
                        <div className="chat-avatar"><Bot size={14} /></div>
                        <div className="chat-bubble"><Loader2 size={14} className="spin" /> Thinking…</div>
                      </div>
                    )}
                  </div>
                  {chatError && <div className="msg-error" style={{ margin: '10px 16px 0' }}>{chatError}</div>}
                  <div className="chat-input-row">
                    <input
                      placeholder="Ask about your customers…"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAskAI(); }}
                      disabled={chatLoading}
                    />
                    <button className="btn" disabled={chatLoading || !chatInput.trim()} onClick={() => handleAskAI()}><Send size={14} /></button>
                  </div>
                </div>
              </>
            )}

            {view === 'customers' && (
              <>
                <h1 className="hn-title">Customer Master</h1>
                <p className="hn-sub">{fmt(analysis.customerMaster.length)} customers on file · filter to build a call list, click a column to sort.</p>
                <div className="filters">
                  <div className="search-box"><Search size={13} />
                    <input placeholder="Search customer ID…" value={search} onChange={(e) => { setSearch(e.target.value); setPage(1); }} />
                  </div>
                  <select value={fStatus} onChange={(e) => { setFStatus(e.target.value); setPage(1); }}>
                    <option>All</option>{STATUS_LIST.map((s) => <option key={s}>{s}</option>)}
                  </select>
                  <select value={fOpportunity} onChange={(e) => { setFOpportunity(e.target.value); setPage(1); }}>
                    <option>All</option>{Object.keys(OPPORTUNITY_COLORS).map((s) => <option key={s}>{s}</option>)}
                  </select>
                  <select value={fSegment} onChange={(e) => { setFSegment(e.target.value); setPage(1); }}>
                    <option>All</option>{SEGMENT_LIST.map((s) => <option key={s}>{s}</option>)}
                  </select>
                  <select value={fBehaviour} onChange={(e) => { setFBehaviour(e.target.value); setPage(1); }}>
                    <option>All</option>{BEHAVIOUR_LIST.map((s) => <option key={s}>{s}</option>)}
                  </select>
                  <select value={fRisk} onChange={(e) => { setFRisk(e.target.value); setPage(1); }}>
                    <option>All risk</option><option>High</option><option>Low</option>
                  </select>
                  <button className="chat-tool" onClick={exportCustomers}><FileDown size={13} /> Export {fmt(filteredCustomers.length)} as CSV</button>
                </div>
                <div className="card" style={{ padding: 0, overflow: 'auto' }}>
                  <table className="hn-table">
                    <thead>
                      <tr>
                        <th onClick={() => toggleSort('id')}>Customer ID <ArrowUpDown size={10} /></th>
                        <th onClick={() => toggleSort('behaviour')}>Behaviour</th>
                        <th className="num" onClick={() => toggleSort('currentSpend')}>Current spend</th>
                        <th className="num" onClick={() => toggleSort('txns')}>Txns</th>
                        <th onClick={() => toggleSort('lastPurchase')}>Last purchase</th>
                        <th onClick={() => toggleSort('segment')}>Value segment</th>
                        <th className="num" onClick={() => toggleSort('previousSpend')}>Prev spend</th>
                        <th className="num" onClick={() => toggleSort('spendChangePct')}>Spend Δ%</th>
                        <th onClick={() => toggleSort('status')}>Status</th>
                        <th onClick={() => toggleSort('churnRisk')}>Risk</th>
                        <th onClick={() => toggleSort('opportunity')}>Opportunity</th>
                        <th onClick={() => toggleSort('ppoeDueDate')}>PPOE next due</th>
                        <th className="nosort">CRM</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pageRows.map((r) => (
                        <tr key={r.id}>
                          <td>{r.id}</td>
                          <td>{r.behaviour}</td>
                          <td className="num">{fmt(r.currentSpend)}</td>
                          <td className="num">{r.txns}</td>
                          <td>{r.lastPurchase || '—'}</td>
                          <td>{r.segment}</td>
                          <td className="num">{fmt(r.previousSpend)}</td>
                          <td className="num">{r.spendChangePct === null ? '—' : fmtPct(r.spendChangePct)}</td>
                          <td><Badge text={r.status} colorMap={STATUS_COLORS} /></td>
                          <td><Badge text={r.churnRisk} colorMap={{ High: '#B0432E', Low: '#2F6E63' }} /></td>
                          <td><Badge text={r.opportunity} colorMap={OPPORTUNITY_COLORS} /></td>
                          <td style={r.ppoeDueState === 'overdue' || r.ppoeDueState === 'lapsed' ? { color: '#B0432E' } : undefined}>{r.ppoeDueDate ? `${r.ppoeDueDate} (${r.ppoeCycle})` : '—'}</td>
                          <td>
                            <button className="crm-btn" onClick={() => setNoteModalId(r.id)}>
                              <StickyNote size={13} />{crmNotes[r.id]?.owner || crmNotes[r.id]?.notes ? '•' : ''}
                            </button>
                          </td>
                        </tr>
                      ))}
                      {pageRows.length === 0 && <tr><td colSpan={13} style={{ textAlign: 'center', padding: 24, color: 'var(--ink-soft)' }}>No customers match these filters.</td></tr>}
                    </tbody>
                  </table>
                </div>
                <div className="pager">
                  <span>Showing {pageRows.length ? (page - 1) * PAGE_SIZE + 1 : 0}–{(page - 1) * PAGE_SIZE + pageRows.length} of {filteredCustomers.length}</span>
                  <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)}><ChevronLeft size={14} /></button>
                  <span>Page {page} / {totalPages}</span>
                  <button disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}><ChevronRight size={14} /></button>
                </div>
              </>
            )}

            {view === 'segments' && (
              <>
                <h1 className="hn-title">Customer Segments</h1>
                <p className="hn-sub">Snapshot: {monthLabel(analysis.current)}</p>
                {patterns.concentration && (
                  <>
                    <div className="kpi-row">
                      <KpiCard label="Top 10 customers" value={fmtPct(patterns.concentration.top10)} sub={`share of ${patterns.concentration.label} revenue`} />
                      <KpiCard label="Top 50 customers" value={fmtPct(patterns.concentration.top50)} sub={`of ${fmt(patterns.concentration.customers)} paying customers`} />
                      <KpiCard label="Top 100 customers" value={fmtPct(patterns.concentration.top100)} />
                      <KpiCard label="Top 10% of customers" value={fmtPct(patterns.concentration.top10pct)} sub="how concentrated the revenue is" />
                    </div>
                    <div className="card">
                      <h2>Revenue by value segment, {monthLabel(analysis.current)}</h2>
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={patterns.segmentRevenue.filter((x) => !x.segment.startsWith('Inactive'))} layout="vertical" margin={{ left: 10 }}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#DAD4C4" />
                          <XAxis type="number" fontSize={11} tickFormatter={fmtK} />
                          <YAxis type="category" dataKey="segment" fontSize={11} width={110} />
                          <Tooltip formatter={(v) => `KSh ${fmt(v)}`} />
                          <Bar dataKey="revenue" fill="#2F6E63" radius={[0, 4, 4, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </>
                )}
                <div className="card">
                  <h2>By payment behaviour</h2>
                  <table className="hn-table">
                    <thead><tr><th>Segment</th><th className="num">Customers</th><th className="num">% of customers</th><th className="num">Spend (KSh)</th><th className="num">% of revenue</th></tr></thead>
                    <tbody>
                      {behaviourCounts.map((r) => (
                        <tr key={r.behaviour}>
                          <td>{r.behaviour}</td><td className="num">{fmt(r.count)}</td>
                          <td className="num">{fmtPct(r.count / analysis.customerMaster.length)}</td>
                          <td className="num">{fmt(r.spend)}</td><td className="num">{fmtPct(r.share)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="card">
                  <h2>By value segment</h2>
                  <table className="hn-table">
                    <thead><tr><th>Segment</th><th className="num">Customers</th><th className="num">% of customers</th></tr></thead>
                    <tbody>
                      {segmentCounts.map((r) => (
                        <tr key={r.segment}><td>{r.segment}</td><td className="num">{fmt(r.count)}</td><td className="num">{fmtPct(r.count / analysis.customerMaster.length)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </>
            )}

            {view === 'movement' && (
              <>
                <h1 className="hn-title">Customer Movement</h1>
                <p className="hn-sub">{analysis.previous ? `${monthLabel(analysis.previous)} → ${monthLabel(analysis.current)}` : 'Import a second month to see movement'}</p>
                <div className="card">
                  <table className="hn-table">
                    <thead><tr><th>Status</th><th className="num">Customers</th><th className="num">% of customers</th></tr></thead>
                    <tbody>
                      {statusCounts.map((r) => (
                        <tr key={r.status}><td><Badge text={r.status} colorMap={STATUS_COLORS} /></td><td className="num">{fmt(r.count)}</td><td className="num">{fmtPct(r.count / analysis.customerMaster.length)}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="card">
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={statusCounts}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#DAD4C4" />
                      <XAxis dataKey="status" fontSize={10} />
                      <YAxis fontSize={11} />
                      <Tooltip />
                      <Bar dataKey="count" fill="#1E2A38" radius={[4, 4, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              </>
            )}

            {view === 'retention' && (
              <>
                <h1 className="hn-title">Retention & Churn</h1>
                {retentionLatest ? (
                  <>
                    {retentionLatest.isMTD && (
                      <div className="warn-note"><AlertTriangle size={16} style={{ flexShrink: 0 }} />
                        <span><strong>{monthLabel(retentionLatest.monthKey)} is month-to-date.</strong> The inactivity figure below counts customers who haven't topped up <em>yet this month</em> — many will still transact before month end. Treat it as an early-warning signal, not final churn. It will read accurately once this month is complete. PPOE customers pay monthly (or weekly), so those whose next payment is not due yet are counted as "Not yet due" and are not treated as churn.</span>
                      </div>
                    )}
                    <div className="kpi-row">
                      <KpiCard label={`${monthLabel(analysis.previous)} active base`} value={fmt(retentionLatest.base)} />
                      <KpiCard label="Retained" value={fmt(retentionLatest.retained)} />
                      {retentionLatest.pending > 0 && <KpiCard tone="" label="PPOE not yet due" value={fmt(retentionLatest.pending)} sub="paid last month, renewal not due - not churn" />}
                      <KpiCard label="Lost / inactive" value={fmt(retentionLatest.lost)} />
                      <KpiCard label="Retention rate" value={fmtPct(retentionLatest.retentionRate)} />
                      <KpiCard tone={retentionLatest.isMTD ? 'warn' : ''} label={retentionLatest.isMTD ? 'Observed MTD inactivity' : 'Churn rate'} value={fmtPct(retentionLatest.inactivityRate)} />
                      <KpiCard label="Revenue lost to churn" value={`KSh ${fmt(analysis.revenueLostInactive)}`} sub="What inactive customers used to spend" />
                    </div>
                    <div className="card">
                      <h2>Retention rate over time</h2>
                      <ResponsiveContainer width="100%" height={240}>
                        <LineChart data={analysis.retentionSeries}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#DAD4C4" />
                          <XAxis dataKey="month" fontSize={11} />
                          <YAxis fontSize={11} tickFormatter={(v) => `${Math.round(v * 100)}%`} />
                          <Tooltip formatter={(v) => fmtPct(v)} />
                          <Legend />
                          <Line type="monotone" dataKey="retentionRate" name="Retention rate" stroke="#2F6E63" strokeWidth={2} />
                          <Line type="monotone" dataKey="inactivityRate" name="Inactivity rate" stroke="#B0432E" strokeWidth={2} />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                    <div className="card">
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                        <h2 style={{ margin: 0 }}>Win-back priority list</h2>
                        <button className="chat-tool" disabled={patterns.winback.length === 0} onClick={exportWinback}><FileDown size={13} /> Export all {fmt(patterns.winbackTotal.count)} as CSV</button>
                      </div>
                      <p className="hn-note">Customers who paid before but not in {monthLabel(analysis.current)} and are past their billing cycle (PPOE customers whose renewal is not yet due are excluded). {fmt(patterns.winbackTotal.count)} customers, ~KSh {fmt(patterns.winbackTotal.revenue)} of their usual spend. Biggest first. {isMtdNow && 'Many will still pay before month end, so call the longest-silent ones first.'}</p>
                      <div style={{ overflow: 'auto' }}>
                        <table className="hn-table">
                          <thead><tr><th>Customer ID</th><th>Behaviour</th><th className="num">Prev spend</th><th>Last purchase</th><th className="num">Days silent</th><th>Segment</th><th className="nosort">CRM</th></tr></thead>
                          <tbody>
                            {patterns.winback.slice(0, 15).map((r) => (
                              <tr key={r.id}>
                                <td>{r.id}</td><td>{r.behaviour}</td><td className="num">{fmt(r.previousSpend || r.ppoeLastAmount)}</td><td>{r.lastPurchase || '-'}</td>
                                <td className="num">{daysSince(r.lastPurchase) ?? '-'}</td><td>{r.segment}</td>
                                <td><button className="crm-btn" onClick={() => setNoteModalId(r.id)}><StickyNote size={13} />{crmNotes[r.id]?.owner || crmNotes[r.id]?.notes ? '•' : ''}</button></td>
                              </tr>
                            ))}
                            {patterns.winback.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 20, color: 'var(--ink-soft)' }}>No customers to win back.</td></tr>}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <div className="card">
                      <h2>PPOE renewals - who should pay next</h2>
                      <p className="hn-note">Next payment = last PPOE payment + package cycle (as of {analysis.ppoeAsOf}). Overdue now: {fmt(patterns.renewals.dueNow.length)} customers (~KSh {fmt(patterns.renewals.nowRevenue)}). Still due by {patterns.renewals.monthEnd}: {fmt(patterns.renewals.dueLater.length)} customers (~KSh {fmt(patterns.renewals.laterRevenue)}).</p>
                      <div style={{ overflow: 'auto', maxHeight: 340 }}>
                        <table className="hn-table">
                          <thead><tr><th>Customer ID</th><th className="num">Last package</th><th>Cycle</th><th>Last paid</th><th>Due</th><th>State</th><th className="nosort">CRM</th></tr></thead>
                          <tbody>
                            {[...patterns.renewals.dueNow, ...patterns.renewals.dueLater].slice(0, 25).map((r) => (
                              <tr key={r.id}>
                                <td>{r.id}</td><td className="num">{fmt(r.ppoeLastAmount)}</td><td>{r.ppoeCycle}</td><td>{r.ppoeLastPaid}</td><td>{r.ppoeDueDate}</td>
                                <td style={r.ppoeDueState === 'overdue' ? { color: '#B0432E', fontWeight: 600 } : undefined}>{r.ppoeDueState === 'not due' ? `in ${r.daysToDue} day${r.daysToDue === 1 ? '' : 's'}` : r.ppoeDueState}</td>
                                <td><button className="crm-btn" onClick={() => setNoteModalId(r.id)}><StickyNote size={13} />{crmNotes[r.id]?.owner || crmNotes[r.id]?.notes ? '•' : ''}</button></td>
                              </tr>
                            ))}
                            {patterns.renewals.dueNow.length + patterns.renewals.dueLater.length === 0 && <tr><td colSpan={7} style={{ textAlign: 'center', padding: 20, color: 'var(--ink-soft)' }}>No PPOE renewals outstanding.</td></tr>}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    <div className="card">
                      <h2>PPOE package cycles</h2>
                      <p className="hn-note">Worked out from how long customers actually wait between payments of the same amount. Correct any that look wrong - churn and renewal dates update immediately.</p>
                      <div style={{ overflow: 'auto', maxHeight: 300 }}>
                        <table className="hn-table">
                          <thead><tr><th className="num">Package (KSh)</th><th className="num">Payments</th><th className="num">Typical days between</th><th>Cycle</th><th>Basis</th><th>Who paid</th></tr></thead>
                          <tbody>
                            {analysis.packageCycles.slice(0, 80).map((x) => (
                              <React.Fragment key={x.amount}>
                              <tr>
                                <td className="num">{fmt(x.amount)}</td><td className="num">{fmt(x.payments)}</td><td className="num">{x.medianGap === null ? '-' : x.medianGap}</td>
                                <td>
                                  <select value={pkgOverrides[x.amount] || 'auto'} onChange={(e) => setPkgCycle(x.amount, e.target.value)}>
                                    <option value="auto">Auto ({CYCLE_NAMES[x.autoLabel]})</option>
                                    {Object.keys(CYCLE_NAMES).map((k) => <option key={k} value={k}>{CYCLE_NAMES[k]}</option>)}
                                  </select>
                                </td>
                                <td style={{ color: 'var(--ink-soft)' }}>{x.source}</td>
                                <td><button className="chat-tool" onClick={() => setOpenPkg(openPkg === x.amount ? null : x.amount)}>{openPkg === x.amount ? 'Hide' : 'Who paid?'}</button></td>
                              </tr>
                              {openPkg === x.amount && (() => {
                                const pays = pkgPayments(x.amount);
                                return (
                                  <tr><td colSpan={6} style={{ background: '#FAF8F3', whiteSpace: 'normal' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                                      <span style={{ fontSize: 12.5 }}>KSh {fmt(x.amount)}: {fmt(pays.length)} payments by {fmt(new Set(pays.map((q) => q.id)).size)} customers{pays.length > 40 ? ' (latest 40 shown)' : ''}</span>
                                      <button className="chat-tool" onClick={() => exportCsv(`happynet-ksh-${x.amount}-payments.csv`, [['Date', (q) => q.date], ['Time', (q) => q.time], ['Customer ID', (q) => q.id], ['Amount', () => x.amount]], pays)}><FileDown size={13} /> Export CSV</button>
                                    </div>
                                    <div style={{ maxHeight: 200, overflow: 'auto' }}>
                                      <table className="hn-table"><thead><tr><th>Date</th><th>Time</th><th>Customer ID</th></tr></thead>
                                        <tbody>{pays.slice(0, 40).map((q, qi) => <tr key={qi}><td>{q.date}</td><td>{q.time}</td><td>{q.id}</td></tr>)}</tbody>
                                      </table>
                                    </div>
                                  </td></tr>
                                );
                              })()}
                              </React.Fragment>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                    {dueFollowUps.length > 0 && (
                      <div className="card">
                        <h2>CRM follow-ups due (next 7 days)</h2>
                        <table className="hn-table">
                          <thead><tr><th>Customer ID</th><th>Follow-up</th><th>Owner</th><th>Notes</th></tr></thead>
                          <tbody>
                            {dueFollowUps.slice(0, 15).map(([id, n]) => (
                              <tr key={id}>
                                <td>{id}</td>
                                <td style={n.followUp < todayKey ? { color: '#B0432E', fontWeight: 600 } : undefined}>{n.followUp}{n.followUp < todayKey ? ' (overdue)' : ''}</td>
                                <td>{n.owner || '-'}</td><td style={{ whiteSpace: 'normal', maxWidth: 360 }}>{(n.notes || '').slice(0, 90)}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="hn-sub">Import a second month of data to see retention and churn — you need at least two months to compare.</p>
                )}
              </>
            )}

            {view === 'revenue' && (
              <>
                <h1 className="hn-title">Revenue Analysis</h1>
                <p className="hn-sub">Where the money comes from, and when it arrives.</p>
                <div className="card">
                  <h2>Monthly revenue split</h2>
                  <table className="hn-table">
                    <thead><tr><th>Month</th><th className="num">Hotspot (KSh)</th><th className="num">PPOE (KSh)</th><th className="num">Total (KSh)</th><th className="num">Hotspot %</th><th className="num">PPOE %</th><th className="num">Per day (KSh)</th><th className="num">Per day vs prev</th></tr></thead>
                    <tbody>
                      {analysis.revenueByMonth.map((r, i, arr) => {
                        const perDay = r.Total / Math.max(1, monthsData[r.monthKey].daysElapsed);
                        const prevPer = i > 0 ? arr[i - 1].Total / Math.max(1, monthsData[arr[i - 1].monthKey].daysElapsed) : null;
                        return (
                          <tr key={r.monthKey}>
                            <td>{r.month}{r.isMTD && ' (MTD)'}</td>
                            <td className="num">{fmt(r.Hotspot)}</td><td className="num">{fmt(r.PPOE)}</td><td className="num">{fmt(r.Total)}</td>
                            <td className="num">{fmtPct(r.Hotspot / r.Total)}</td><td className="num">{fmtPct(r.PPOE / r.Total)}</td>
                            <td className="num">{fmt(perDay)}</td>
                            <td className="num" style={prevPer ? { color: perDay >= prevPer ? '#2F6E63' : '#B0432E' } : undefined}>{prevPer ? fmtSigned(perDay / prevPer - 1) : '-'}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="hn-note" style={{ marginTop: 10 }}>"Per day" makes the month-to-date row comparable with full months.</p>
                </div>
                <div className="card">
                  <h2>Daily revenue trend</h2>
                  <DailyTrendChart data={analysis.dailyRevenue} height={260} />
                </div>
                <div className="card">
                  <h2>Revenue by day of month (average day)</h2>
                  <p className="hn-note">Shows when customers pay - spikes mark billing days and month-end clustering.</p>
                  <ResponsiveContainer width="100%" height={240}>
                    <BarChart data={patterns.dayOfMonth}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#DAD4C4" />
                      <XAxis dataKey="day" fontSize={10} interval={0} />
                      <YAxis fontSize={11} tickFormatter={fmtK} />
                      <Tooltip formatter={(v) => `KSh ${fmt(v)}`} />
                      <Legend />
                      <Bar dataKey="Hotspot" stackId="a" fill="#C2792E" />
                      <Bar dataKey="PPOE" stackId="a" fill="#2F6E63" />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <div className="chart-grid">
                  <div className="card">
                    <h2>Revenue by weekday (average day)</h2>
                    <ResponsiveContainer width="100%" height={220}>
                      <BarChart data={patterns.weekday}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#DAD4C4" />
                        <XAxis dataKey="day" fontSize={11} />
                        <YAxis fontSize={11} tickFormatter={fmtK} />
                        <Tooltip formatter={(v) => `KSh ${fmt(v)}`} />
                        <Legend />
                        <Bar dataKey="Hotspot" stackId="a" fill="#C2792E" />
                        <Bar dataKey="PPOE" stackId="a" fill="#2F6E63" />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="card">
                    <h2>Hotspot package mix (% of hotspot revenue)</h2>
                    {patterns.packageRows.length === 0 ? (
                      <p className="hn-note">Re-import the months (Import tab) to unlock package-level detail.</p>
                    ) : (
                      <ResponsiveContainer width="100%" height={220}>
                        <BarChart data={patterns.packageRows}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#DAD4C4" />
                          <XAxis dataKey="month" fontSize={11} />
                          <YAxis fontSize={11} tickFormatter={(v) => `${v}%`} />
                          <Tooltip formatter={(v) => `${v}%`} />
                          <Legend />
                          {[...patterns.packages, 'Other'].map((k, i) => <Bar key={k} dataKey={k} stackId="p" fill={CHART_COLORS[i % CHART_COLORS.length]} />)}
                        </BarChart>
                      </ResponsiveContainer>
                    )}
                  </div>
                </div>
                <div className="card">
                  <h2>New clients per day (first payment seen in the system)</h2>
                  {patterns.newDaily.length === 0 ? (
                    <p className="hn-note">Needs the per-transaction log - re-import the months on the Import tab.</p>
                  ) : (
                    <>
                      <p className="hn-note">{patterns.newByMonth.map((x) => `${x.month}: ${fmt(x.Total)} (Hotspot ${fmt(x.Hotspot)}, PPOE ${fmt(x.PPOE)})`).join('  ·  ')}. The first imported month is excluded because everyone looks new there.</p>
                      <ResponsiveContainer width="100%" height={240}>
                        <BarChart data={patterns.newDaily}>
                          <CartesianGrid strokeDasharray="3 3" stroke="#DAD4C4" />
                          <XAxis dataKey="date" fontSize={10} interval="preserveStartEnd" minTickGap={24} />
                          <YAxis fontSize={11} />
                          <Tooltip />
                          <Legend />
                          <Bar dataKey="Hotspot" stackId="n" fill="#C2792E" />
                          <Bar dataKey="PPOE" stackId="n" fill="#2F6E63" />
                        </BarChart>
                      </ResponsiveContainer>
                    </>
                  )}
                </div>
              </>
            )}

            {view === 'projection' && (
              <>
                <h1 className="hn-title">Revenue Projection</h1>
                {(() => {
                  const cur = analysis.revenueByMonth[analysis.revenueByMonth.length - 1];
                  const prev = analysis.revenueByMonth.length > 1 ? analysis.revenueByMonth[analysis.revenueByMonth.length - 2] : null;
                  const useBaseline = cur && !cur.isMTD ? cur : (prev || cur);
                  const baseline = useBaseline ? useBaseline.Total : 0;
                  const scenarios = [5, 10, 15, 20, 25, 30, 40, 50];
                  return (
                    <>
                      <p className="hn-sub">Baseline: {useBaseline ? `${useBaseline.month} revenue — KSh ${fmt(baseline)}` : 'no complete month yet'}
                        {cur?.isMTD && useBaseline !== cur && ' (using the last complete month, not the in-progress one, as the baseline)'}</p>
                      {pace && pace.isMTD && (
                        <div className="kpi-row">
                          <KpiCard label={`${monthLabel(analysis.current)} so far`} value={`KSh ${fmt(pace.rev)}`} sub={`day ${pace.days} of ${pace.dim}`} />
                          <KpiCard label="Projected month-end" value={`KSh ${fmt(pace.projected)}`} sub={pace.byShape ? `scaled by ${pace.prevLabel}'s payment pattern` : 'at current daily run-rate'} />
                          {pace.vsPrevFull !== null && <KpiCard label={`vs ${pace.prevLabel}`} value={fmtSigned(pace.vsPrevFull)} sub="projected close vs last full month" tone={pace.vsPrevFull < 0 ? 'warn' : ''} />}
                          <KpiCard label="Daily run-rate" value={`KSh ${fmt(pace.runRate)}`} sub={`${pace.remaining} days left`} />
                        </div>
                      )}
                      <div className="card">
                        <table className="hn-table">
                          <thead><tr><th>Growth scenario</th><th className="num">Target monthly revenue (KSh)</th><th className="num">Incremental revenue (KSh)</th>{pace && pace.isMTD && pace.remaining > 0 && <th className="num">Needed per day from now (KSh)</th>}</tr></thead>
                          <tbody>
                            {scenarios.map((g) => (
                              <tr key={g}>
                                <td>{g}%</td>
                                <td className="num">{fmt(baseline * (1 + g / 100))}</td>
                                <td className="num">{fmt(baseline * (g / 100))}</td>
                                {pace && pace.isMTD && pace.remaining > 0 && <td className="num">{fmt(Math.max(0, baseline * (1 + g / 100) - pace.rev) / pace.remaining)}</td>}
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                      <p style={{ fontSize: 12, color: 'var(--ink-soft)' }}>These are simple what-if targets off the baseline — they don't account for growth levers overlapping (e.g. an upsell push and a win-back push touching the same customers). Ask the AI assistant which segments have the most realistic headroom for a given target.</p>
                    </>
                  );
                })()}
              </>
            )}

            {view === 'import' && (
              <>
                <h1 className="hn-title">Import Data</h1>
                <p className="hn-sub">Add a new M-Pesa Utility Account statement export (.csv). Data is grouped automatically by calendar month, so you can select several files at once.</p>

                {importError && <div className="msg-error"><FileWarning size={16} style={{ flexShrink: 0 }} />{importError}</div>}
                {saveMsg && <div className="msg-success"><CheckCircle2 size={16} />{saveMsg}</div>}

                <div className="dropzone" onClick={() => fileInputRef.current?.click()}>
                  <Upload size={26} style={{ marginBottom: 8, color: 'var(--ink-soft)' }} />
                  <div style={{ fontWeight: 600, marginBottom: 4 }}>{parsing ? 'Reading file(s)…' : 'Click to choose statement CSV file(s)'}</div>
                  <div style={{ fontSize: 12, color: 'var(--ink-soft)' }}>Always export from the 1st of the month to today — re-importing a month replaces its stored data.</div>
                  <input ref={fileInputRef} type="file" accept=".csv" multiple
                    onChange={(e) => e.target.files && e.target.files.length && handleFiles(e.target.files)} />
                </div>

                {importPreview && (
                  <div className="card" style={{ marginTop: 18 }}>
                    <h2>Preview before saving</h2>
                    {importPreview.files.map((f) => (
                      <div key={f.name} className="file-summary-row">
                        <span>{f.name} — {f.period || 'period unknown'}</span>
                        <span>{f.rowsIncluded} rows used, {f.rowsSkipped} skipped</span>
                      </div>
                    ))}
                    <table className="hn-table bucket-table" style={{ marginTop: 14 }}>
                      <thead><tr><th>Month</th><th className="num">Customers</th><th className="num">Txns</th><th className="num">Revenue (KSh)</th><th className="num">Unidentified</th></tr></thead>
                      <tbody>
                        {Object.entries(importPreview.buckets).sort().map(([mk, b]) => (
                          <tr key={mk}>
                            <td>{monthLabel(mk)}{mk === monthKeyOf(new Date()) && ' — in progress'}</td>
                            <td className="num">{fmt(Object.keys(b.customers).length)}</td>
                            <td className="num">{fmt(b.totalTxns)}</td>
                            <td className="num">{fmt(b.totalRevenue)}</td>
                            <td className="num">{b.unidentifiedTxns ? `${fmt(b.unidentifiedTxns)} (KSh ${fmt(b.unidentifiedRevenue)})` : '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{ marginTop: 14, display: 'flex', gap: 10 }}>
                      <button className="btn" disabled={saving} onClick={confirmSave}>{saving ? 'Saving…' : 'Save to system'}</button>
                      <button className="btn secondary" style={{ border: '1px solid var(--line)', color: 'var(--ink-soft)' }} onClick={() => setImportPreview(null)}>Discard</button>
                    </div>
                  </div>
                )}

                <div className="card" style={{ marginTop: 18 }}>
                  <h2>Months currently in the system</h2>
                  {monthsInSystem.length === 0 && <p style={{ color: 'var(--ink-soft)', fontSize: 13 }}>Nothing imported yet.</p>}
                  {monthsInSystem.map((mk) => {
                    const m = monthsData[mk];
                    return (
                      <div key={mk} className="month-chip">
                        <div>
                          <strong>{monthLabel(mk)}</strong>{!(m.tx && m.tx.length) && <span style={{ color: '#B0432E', fontSize: 11, marginLeft: 6 }}>no payment log - re-import</span>}{m.isMTD && <span style={{ color: 'var(--amber)', fontSize: 11, marginLeft: 6 }}>MTD (day {m.daysElapsed}/{m.daysInPeriod})</span>}
                          <div style={{ fontSize: 11, color: 'var(--ink-soft)' }}>{fmt(Object.keys(m.customers).length)} customers · KSh {fmt(m.totalRevenue)} · imported {new Date(m.importedAt).toLocaleString()}</div>
                        </div>
                        <button className="btn secondary" onClick={() => handleDeleteMonth(mk)}><Trash2 size={12} /></button>
                      </div>
                    );
                  })}
                </div>
              </>
            )}
          </>
        )}
      </main>

      {noteModalId && (
        <NoteModal
          customerId={noteModalId}
          note={crmNotes[noteModalId]}
          onClose={() => setNoteModalId(null)}
          onSave={handleSaveCrmNote}
        />
      )}
    </div>
  );
}

// Exported for the public demo wrapper (src/main.jsx) so it can load sample data the same way the Import screen does.
export { parseCSVFile, mergeBuckets, saveMonth, saveIndex };
