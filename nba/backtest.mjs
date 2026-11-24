#!/usr/bin/env node
// Backtest: project every finished game using only data from before tip-off, compare to the box score.
// Players who didn't play are treated as known-out (the inactive list is public before tip-off).
// Usage: node nba/backtest.mjs [fromDate] [toDate] [PARAM=value ...]   e.g. node nba/backtest.mjs 2025-12-01 2026-04-15 OPP_W=.4
import { loadData, projectGame, P } from './model.mjs';

const args = process.argv.slice(2), dates = args.filter(a => /^\d{4}-\d\d-\d\d$/.test(a));
for (const a of args.filter(a => a.includes('='))) { const [k, v] = a.split('='); P[k] = +v; }
const from = dates[0] || '2025-12-01', to = dates[1] || '2099-01-01';
const X = loadData();
const ST = ['pts', 'reb', 'ast', 'tpm', 'pra', 'min'];
const acc = {}; const add = (k, e) => { const a = acc[k] || (acc[k] = { n: 0, ae: 0, b: 0 }); a.n++; a.ae += Math.abs(e); a.b += e; };
for (const g of X.games) {
  if (!g.done || g.date < from || g.date > to || g.stype !== 2) continue;
  const box = new Map((X.byGame.get(g.id) || []).filter(r => !r.dnp && r.min > 0).map(r => [r.pid, r]));
  const R = projectGame(X, g, pid => !box.has(pid));
  for (const p of R) { const a = box.get(p.pid); if (!a || a.min < 1 || p.base.n < 5) continue;
    const act = { ...a, pra: a.pts + a.reb + a.ast };
    // baselines: last-10 average and weighted season average with no adjustments
    const l10 = p.base.games.slice(-10), avg = s => l10.reduce((x, r) => x + (s === 'pra' ? r.pts + r.reb + r.ast : r[s]), 0) / l10.length;
    for (const s of ST) { add(s + '|model', p.proj[s] - act[s]); add(s + '|last10', avg(s) - act[s]); }
  }
}
const out = {}; for (const s of ST) out[s] = { n: acc[s + '|model'].n, model: +(acc[s + '|model'].ae / acc[s + '|model'].n).toFixed(3), last10: +(acc[s + '|last10'].ae / acc[s + '|last10'].n).toFixed(3), bias: +(acc[s + '|model'].b / acc[s + '|model'].n).toFixed(2) };
console.log(JSON.stringify({ from, to, params: P }));
for (const [s, o] of Object.entries(out)) console.log(`${s.padEnd(4)} n=${o.n}  model MAE ${o.model}  last-10 avg ${o.last10}  bias ${o.bias > 0 ? '+' : ''}${o.bias}`);

// calibration: does "62% to go over" actually go over 62% of the time? Lines = last-10 average rounded to x.5
import { pOver } from './model.mjs';
const cal = {}, brier = { n: 0, s: 0 };
for (const g of X.games) {
  if (!g.done || g.date < from || g.date > to || g.stype !== 2) continue;
  const box = new Map((X.byGame.get(g.id) || []).filter(r => !r.dnp && r.min > 0).map(r => [r.pid, r]));
  for (const p of projectGame(X, g, pid => !box.has(pid))) { const a = box.get(p.pid); if (!a || p.base.n < 5 || p.proj.min < 12) continue;
    for (const s of ['pts', 'reb', 'ast', 'tpm', 'pra']) {
      const l10 = p.base.games.slice(-10), v = r => s === 'pra' ? r.pts + r.reb + r.ast : r[s];
      const line = Math.floor(l10.reduce((x, r) => x + v(r), 0) / l10.length) + .5, q = pOver(p, s, line), k = s + '|' + Math.min(9, Math.floor(q * 10));
      const c = cal[k] || (cal[k] = { n: 0, p: 0, y: 0 }); c.n++; c.p += q; c.y += v(a) > line ? 1 : 0; brier.n++; brier.s += (q - (v(a) > line ? 1 : 0)) ** 2; } }
}
console.log(`calibration (model chance vs how often it actually went over) — Brier ${(brier.s / brier.n).toFixed(4)}:`);
for (const s of ['pts', 'reb', 'ast', 'tpm', 'pra']) console.log(' ', s.padEnd(4), Object.keys(cal).filter(k => k.startsWith(s + '|')).sort().map(k => { const c = cal[k]; return `${(c.p / c.n * 100).toFixed(0)}→${(c.y / c.n * 100).toFixed(0)}%(${c.n})`; }).join('  '));
