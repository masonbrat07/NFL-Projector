#!/usr/bin/env node
// Grades prop lines against the model. Input: a text file, one line per prop:
//   Player name, stat, line, over price, under price      (prices as the app shows them: 54 or 54% or 1.85x; optional)
//   e.g.  Nikola Jokic, Points, 27.5, 53, 51
// Stats: points, rebounds, assists, 3pm/threes, steals, blocks, turnovers, pra, pts+reb, pts+ast, reb+ast, stl+blk
// Saves nba/picks/<date>.json so nba/review.mjs can score the picks after the games.
// Usage: node nba/grade.mjs lines.txt [YYYY-MM-DD]
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadData, pOver, hitRate, STAT_ALIAS, LABEL, normName } from './model.mjs';
import { projectDate, etDate } from './project.mjs';

const [file, dateArg] = process.argv.slice(2);
if (!file) { console.error('usage: node nba/grade.mjs lines.txt [YYYY-MM-DD]'); process.exit(1); }
const X = loadData(), date = dateArg || etDate(new Date().toISOString());
const all = projectDate(X, date).flatMap(x => x.rows);
// price -> implied chance: "54" / "54%" = 54%, "1.85x" = 1/1.85
const price = s => { if (s == null || s === '') return null; s = String(s).trim(); if (/x$/i.test(s)) return 100 / parseFloat(s); const v = parseFloat(s); return isFinite(v) ? (v > 1 ? v : v * 100) : null; };
const out = [];
for (const raw of readFileSync(file, 'utf8').split(/\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))) {
  const [name, st, ln, po, pu] = raw.split(/\s*[,|\t]\s*/), stat = STAT_ALIAS[(st || '').toLowerCase().trim()], line = parseFloat(ln);
  const R = all.find(r => normName(r.name) === normName(name || '')) || all.find(r => normName(r.name).endsWith(normName(name || '').split(' ').pop()) && normName(r.name)[0] === normName(name || '')[0]);
  if (!R || !stat || !isFinite(line)) { out.push({ raw, err: !R ? 'player not found on this date' : 'could not read stat/line' }); continue; }
  const q = R.out ? 0 : pOver(R, stat, line), h = hitRate(R, stat, line), o = price(po), u = price(pu);
  const eo = o != null ? q * 100 - o : null, eu = u != null ? (1 - q) * 100 - u : null;
  const side = (eo ?? (q - .5) * 100) >= (eu ?? (.5 - q) * 100) ? 'Over' : 'Under', edge = side === 'Over' ? eo ?? (q - .5) * 100 : eu ?? (.5 - q) * 100;
  out.push({ name: R.name, team: R.team, opp: R.opp, pid: R.pid, gid: R.gid, stat, line, proj: +R.proj[stat].toFixed(1), min: +R.proj.min.toFixed(1), pOver: +q.toFixed(3), over: o, under: u,
    side, edge: +edge.toFixed(1), l10: h, status: R.status || '', out: R.out });
}
out.sort((a, b) => (b.edge ?? -99) - (a.edge ?? -99));
const pct = x => (x * 100).toFixed(0) + '%';
for (const p of out) {
  if (p.err) { console.log(`  ??  ${p.raw}  -> ${p.err}`); continue; }
  const chance = p.side === 'Over' ? p.pOver : 1 - p.pOver, pr = p.side === 'Over' ? p.over : p.under;
  console.log(`${(p.edge > 0 ? '+' : '') + p.edge.toFixed(0)}`.padStart(4) + `  ${p.side.padEnd(5)} ${p.name} ${LABEL[p.stat]} ${p.line}  | proj ${p.proj} (${p.min} min)  model ${pct(chance)}${pr != null ? ' vs price ' + pr.toFixed(0) + '%' : ''}  | last 10 over: ${p.l10 ? p.l10.hit + '/' + p.l10.n : '–'}${p.status ? '  [' + p.status + ']' : ''}${p.out ? '  ** listed OUT **' : ''}`);
}
const dir = fileURLToPath(new URL('./picks/', import.meta.url)); mkdirSync(dir, { recursive: true });
let prev = []; try { prev = JSON.parse(readFileSync(dir + date + '.json', 'utf8')).lines; } catch {}
const key = p => p.pid + p.stat + p.line, keep = prev.filter(p => !out.some(q => key(q) === key(p)));
writeFileSync(dir + date + '.json', JSON.stringify({ date, graded_at: new Date().toISOString(), lines: [...keep, ...out.filter(p => !p.err)] }, null, 1));
console.log(`\nSaved ${out.filter(p => !p.err).length} graded lines to nba/picks/${date}.json`);
