// Public demo wrapper for the ISP Customer Analytics app.
//
// The app itself (happynet-analytics.jsx) was written to run inside Claude,
// which provides window.storage and an authenticated Claude API. To run it as a
// plain web page this wrapper:
//   1. provides window.storage backed by the browser's localStorage,
//   2. adds the visitor's own API key to assistant requests (kept in memory only),
//   3. loads synthetic M-Pesa statements, shifted so the newest month is always
//      the current month to date.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import App, { parseCSVFile, mergeBuckets, saveMonth, saveIndex } from './happynet-analytics.jsx';
import jul from '../sample-data/demo_utility_statement_2026-07.csv';
import aug from '../sample-data/demo_utility_statement_2026-08.csv';
import sep from '../sample-data/demo_utility_statement_2026-09.csv';
import oct from '../sample-data/demo_utility_statement_2026-10.csv';

// ---- 1. storage --------------------------------------------------------------
const NS = 'isp-analytics-demo:';
window.storage = {
  async get(key) {
    const v = localStorage.getItem(NS + key);
    return v === null ? null : { key, value: v };
  },
  async set(key, value) { localStorage.setItem(NS + key, value); return { key, value }; },
  async delete(key) { localStorage.removeItem(NS + key); return { key, deleted: true }; },
  async list(prefix = '') {
    const keys = Object.keys(localStorage).filter((k) => k.startsWith(NS + prefix)).map((k) => k.slice(NS.length));
    return { keys };
  },
};
function clearDemoStorage() {
  Object.keys(localStorage).filter((k) => k.startsWith(NS)).forEach((k) => localStorage.removeItem(k));
}

// ---- 2. assistant requests --------------------------------------------------------
let apiKey = '';
const realFetch = window.fetch.bind(window);
window.fetch = (url, opts = {}) => {
  if (String(url).startsWith('https://api.anthropic.com/')) {
    if (!apiKey) {
      return Promise.reject(new Error('this public demo needs your own Anthropic API key. Click "AI assistant key" in the bar at the top.'));
    }
    opts = { ...opts, headers: { ...(opts.headers || {}), 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } };
  }
  return realFetch(url, opts);
};

// ---- 3. sample data, shifted to the current month ----------------------------------
const SAMPLE_LAST = { y: 2026, m: 10, day: 14 };
function shiftStatement(text, monthOffset, cutoffDay, isLast) {
  const shiftDate = (d, m, y) => {
    let mi = (y * 12 + (m - 1)) + monthOffset;
    const ny = Math.floor(mi / 12), nm = mi % 12 + 1;
    const dim = new Date(ny, nm, 0).getDate();
    return { d: Math.min(d, dim), m: nm, y: ny, dim };
  };
  const pad = (n) => String(n).padStart(2, '0');
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    let dropped = false;
    const shifted = line.replace(/(\d{2})-(\d{2})-(\d{4})/g, (_, d, m, y) => {
      const s = shiftDate(+d, +m, +y);
      // the newest month is month-to-date: keep only days up to today
      if (isLast && !line.startsWith('Time Period') && s.d > cutoffDay) dropped = true;
      const day = line.startsWith('Time Period') && +d > 1 ? (isLast ? cutoffDay : s.dim) : s.d;
      return `${pad(day)}-${pad(s.m)}-${s.y}`;
    });
    if (!dropped) out.push(shifted);
  }
  return out.join('\n');
}

async function loadDemoData() {
  const now = new Date();
  const offset = (now.getFullYear() * 12 + now.getMonth()) - (SAMPLE_LAST.y * 12 + (SAMPLE_LAST.m - 1));
  const today = now.getDate();
  const texts = [jul, aug, sep, oct];
  let merged = {};
  for (let i = 0; i < texts.length; i++) {
    const isLast = i === texts.length - 1;
    // the sample's month-to-date file covers 14 days; stretch it to today if needed
    const body = isLast && today > SAMPLE_LAST.day ? stretch(texts[i], today) : texts[i];
    const csv = shiftStatement(body, offset, today, isLast);
    const file = new File([csv], `demo_statement_${i + 1}.csv`, { type: 'text/csv' });
    const res = await parseCSVFile(file);
    merged = mergeBuckets(merged, res.buckets);
  }
  const keys = Object.keys(merged);
  for (const mk of keys) await saveMonth(mk, merged[mk]);
  await saveIndex(keys);
}
// Repeat the first 14 days' hotspot top-ups so a month-to-date file can reach later
// days. Monthly PPOE payments are not copied, so nobody is billed twice.
function stretch(text, uptoDay) {
  const lines = text.split(/\r?\n/);
  const extra = [];
  for (const line of lines) {
    const m = line.match(/^(T\w+),(\d{2})-(10)-(2026)/);
    if (!m) continue;
    const paidIn = parseFloat(line.split(',')[5]);
    if (!(paidIn > 0 && paidIn < 70)) continue;
    for (const add of [14, 28]) {
      const d = +m[2] + add;
      if (d <= Math.min(uptoDay, 31)) extra.push(line.replace(/(\d{2})-10-2026/g, `${String(d).padStart(2, '0')}-10-2026`));
    }
  }
  return text + '\n' + extra.join('\n');
}

// ---- demo bar -------------------------------------------------------------------
const bar = {
  wrap: { background: '#1E2A38', color: '#F6F3EC', font: '13px system-ui,-apple-system,"Segoe UI",sans-serif', padding: '8px 16px', display: 'flex', flexWrap: 'wrap', gap: '8px 14px', alignItems: 'center', borderBottom: '3px solid #2F6E63' },
  tag: { background: '#2F6E63', color: '#fff', borderRadius: 4, padding: '2px 8px', fontWeight: 600, fontSize: 12 },
  btn: { background: 'transparent', color: '#F6F3EC', border: '1px solid rgba(246,243,236,.45)', borderRadius: 5, padding: '4px 10px', cursor: 'pointer', font: 'inherit' },
  link: { color: '#9FD3C4' },
  input: { font: 'inherit', padding: '4px 8px', borderRadius: 5, border: '1px solid #4B5A6A', width: 240, maxWidth: '100%' },
};

function DemoShell() {
  const [appKey, setAppKey] = useState(0);
  const [status, setStatus] = useState('');
  const [showKey, setShowKey] = useState(false);
  const [keyDraft, setKeyDraft] = useState('');
  const [hasKey, setHasKey] = useState(false);

  async function reload(msg) {
    setStatus('Loading demo data…');
    clearDemoStorage();
    await loadDemoData();
    setAppKey((k) => k + 1);
    setStatus(msg);
  }

  useEffect(() => {
    // first visit: fill the dashboard straight away
    if (!localStorage.getItem(NS + 'happynet_months_index')) reload('Demo data loaded.');
  }, []);

  return (
    <>
      <div style={bar.wrap} role="region" aria-label="Demo controls">
        <span style={bar.tag}>Live demo</span>
        <span>All customers and payments here are <strong>synthetic</strong>. Nothing leaves your browser.</span>
        <button style={bar.btn} onClick={() => reload('Demo data reset.')}>Reset demo data</button>
        <button style={bar.btn} onClick={() => setShowKey((s) => !s)}>{hasKey ? 'AI key added ✓' : 'AI assistant key'}</button>
        <a style={bar.link} href="https://github.com/kaliumg432-hub/isp-customer-analytics">Source on GitHub</a>
        <span aria-live="polite" style={{ opacity: 0.75 }}>{status}</span>
        {showKey && (
          <span style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', width: '100%' }}>
            <span style={{ opacity: 0.85 }}>The assistant calls the Claude API. Paste your own Anthropic API key to try it; it stays in this tab's memory and is never saved.</span>
            <input style={bar.input} type="password" placeholder="sk-ant-…" value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)} aria-label="Anthropic API key" />
            <button style={bar.btn} onClick={() => { apiKey = keyDraft.trim(); setHasKey(!!apiKey); setShowKey(false); setKeyDraft(''); }}>Use key</button>
          </span>
        )}
      </div>
      <App key={appKey} />
    </>
  );
}

createRoot(document.getElementById('root')).render(<DemoShell />);
