#!/usr/bin/env node
// Reviews a finished NBA date: saved projections vs box scores, and every graded prop in nba/picks/<date>.json.
// Writes nba/reviews/<date>.json and prints a summary. Run nba/update.mjs first so the box scores are in.
// Usage: node nba/review.mjs [YYYY-MM-DD]      (default: yesterday, Eastern time)
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadData, LABEL, COMBOS } from './model.mjs';
import { etDate } from './project.mjs';

const X = loadData(), date = process.argv[2] || etDate(new Date(Date.now() - 864e5).toISOString());
const here = f => fileURLToPath(new URL(f, import.meta.url));
const read = f => { try { return JSON.parse(readFileSync(here(f), 'utf8')); } catch { return null; } };
const val = (r, s) => COMBOS[s] ? COMBOS[s].reduce((a, k) => a + r[k], 0) : r[s];
const box = new Map(X.rows.filter(r => !r.dnp && r.min > 0 && etDate(r.date) === date).map(r => [r.pid, r]));
if (!box.size) { console.log(`No finished box scores for ${date} yet (run node nba/update.mjs).`); process.exit(0); }
const rev = { date, stats: {}, misses: [], picks: null };
const proj = read(`./projections/${date}.json`);
if (proj) {
  const acc = {};
  for (const g of proj.games) for (const p of g.players) { if (p.out) continue; const a = box.get(p.pid); if (!a || a.min < 1) continue;
    for (const s of ['pts', 'reb', 'ast', 'tpm', 'pra', 'min']) { const e = p.proj[s] - val(a, s), o = acc[s] || (acc[s] = { n: 0, ae: 0, b: 0 }); o.n++; o.ae += Math.abs(e); o.b += e; }
    rev.misses.push({ name: p.name, team: p.team, proj_pra: p.proj.pra, actual_pra: val(a, 'pra'), proj_min: p.proj.min, actual_min: a.min, err: +(p.proj.pra - val(a, 'pra')).toFixed(1) }); }
  for (const [s, o] of Object.entries(acc)) rev.stats[s] = { n: o.n, mae: +(o.ae / o.n).toFixed(2), bias: +(o.b / o.n).toFixed(2) };
  rev.misses.sort((a, b) => Math.abs(b.err) - Math.abs(a.err)); rev.misses = rev.misses.slice(0, 8);
}
const picks = read(`./picks/${date}.json`);
if (picks) {
  const L = picks.lines.map(p => { const a = box.get(p.pid); if (!a) return { ...p, result: 'void (did not play)' };
    const v = val(a, p.stat), won = p.side === 'Over' ? v > p.line : v < p.line; return { ...p, actual: v, result: v === p.line ? 'push' : won ? 'win' : 'loss' }; });
  const sc = l => ({ w: l.filter(p => p.result === 'win').length, l: l.filter(p => p.result === 'loss').length });
  rev.picks = { all: sc(L), edge5: sc(L.filter(p => p.edge >= 5)), lines: L };
}
mkdirSync(here('./reviews/'), { recursive: true }); writeFileSync(here(`./reviews/${date}.json`), JSON.stringify(rev, null, 1));
console.log(`NBA review ${date}: ${box.size} players played.`);
for (const [s, o] of Object.entries(rev.stats)) console.log(`  ${(LABEL[s] || s).padEnd(16)} avg miss ${o.mae}  bias ${o.bias > 0 ? '+' : ''}${o.bias}  (n=${o.n})`);
if (!proj) console.log('  (no saved projections for this date — run node nba/project.mjs before tip-off next time)');
if (rev.misses.length) console.log('  biggest misses (PRA): ' + rev.misses.slice(0, 5).map(m => `${m.name} ${m.proj_pra}→${m.actual_pra} (${m.proj_min}→${m.actual_min} min)`).join('; '));
if (rev.picks) { console.log(`  graded props: ${rev.picks.all.w}-${rev.picks.all.l}; edge ≥5: ${rev.picks.edge5.w}-${rev.picks.edge5.l}`);
  for (const p of rev.picks.lines) console.log(`   ${p.result.padEnd(5)} ${p.side} ${p.name} ${LABEL[p.stat]} ${p.line} → ${p.actual ?? '–'} (edge ${p.edge})`); }
// running record across every reviewed date
const all = readdirSync(here('./reviews/')).filter(f => f.endsWith('.json')).map(f => read('./reviews/' + f)).filter(r => r && r.picks);
if (all.length) { const w = all.reduce((a, r) => a + r.picks.all.w, 0), l = all.reduce((a, r) => a + r.picks.all.l, 0); console.log(`  season record on graded props: ${w}-${l}${w + l ? ' (' + (w / (w + l) * 100).toFixed(0) + '%)' : ''}`); }
