#!/usr/bin/env node
// Monte Carlo game simulator. Each run:
//  1) draws both team scores around the Vegas-implied points (sd 11.6, correlation 0.25 — measured on 1,193 games;
//     the market beat the model's own team totals, 9.25 vs 11.14 avg miss), or around the model total when there's no line;
//  2) draws each active player's minutes (blowouts cut starters' minutes) and per-minute production (gamma noise sized
//     from that player's own game-to-game spread), using the model's projections for who is playing;
//  3) splits the team's simulated points across its players in proportion to their draws, so player lines add up to the score.
// Usage: node nba/sim.mjs [YYYY-MM-DD] [runs=10000] [lines.txt]
import { readFileSync } from 'node:fs';
import { loadData, P, STAT_ALIAS, LABEL, normName } from './model.mjs';
import { projectDate, etDate } from './project.mjs';

export const SIM = { SD_TEAM: 11.6, CORR: .25, SD_MIN_FLOOR: 2.5, BLOW_START: 14, BLOW_CUT: .012, CV_K: 1.1, MSD_K: .8 };
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function normal(R) { let u = 0; while (!u) u = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * R()); }
function gamma(R, k) { if (k < 1) return gamma(R, k + 1) * Math.pow(R() || 1e-9, 1 / k); const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { x = normal(R); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = R(); if (u < 1 - .0331 * x ** 4 || Math.log(u) < .5 * x * x + d * (1 - v + Math.log(v))) return d * v; } }
function poisson(R, lam) { if (lam <= 0) return 0; if (lam > 30) return Math.max(0, Math.round(lam + Math.sqrt(lam) * normal(R))); let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= R(); } while (p > L); return k - 1; }
// a draw with mean `mu` and coefficient of variation `cv` (gamma: right-skewed like real box scores)
const draw = (R, mu, cv) => mu <= 0 ? 0 : cv <= .01 ? mu : mu * gamma(R, 1 / (cv * cv)) * cv * cv;

const SIM_STATS = ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk', 'tov'];
export function simulateGame(g, rows, N = 10000, seed = 7) {
  const R = rng(seed + +g.id % 100000), teams = [g.home, g.away], out = { N, score: { [g.home]: [], [g.away]: [] }, players: new Map() };
  const act = Object.fromEntries(teams.map(t => [t, rows.filter(r => r.team === t && !r.out && r.proj.min > 0)]));
  // team means: Vegas implied points when there is a line, else the model's own sum (de-shaded to a mean)
  const mean = {}; for (const t of teams) { const r0 = act[t][0] || rows.find(r => r.team === t); mean[t] = r0 && r0.implied ? r0.implied : act[t].reduce((a, r) => a + r.proj.pts, 0) / P.TYPICAL; }
  // per-player inputs: mean per-minute rate (model projection de-shaded) and noise sizes
  const inp = new Map();
  for (const t of teams) for (const r of act[t]) {
    const m = r.proj.min, games = r.base.games.filter(x => x.min > 0), mins = games.map(x => x.min);
    const msd = Math.max(SIM.SD_MIN_FLOOR, mins.length > 2 ? Math.sqrt(mins.reduce((a, x) => a + (x - r.base.min) ** 2, 0) / mins.length) * SIM.MSD_K : 6);
    const rate = {}, cv = {};
    for (const s of SIM_STATS) { const mu = r.proj[s] / (['tpm', 'stl', 'blk', 'tov'].includes(s) ? P.TYP_CNT : P.TYPICAL); rate[s] = m ? mu / m : 0;
      cv[s] = rate[s] > 0 && r.base.sd[s] != null ? Math.min(1.2, Math.max(.15, r.base.sd[s] / Math.max(rate[s], .01) * SIM.CV_K)) : .5; }
    inp.set(r.pid, { r, m, msd, rate, cv, start: m >= 28 });
    out.players.set(r.pid, { name: r.name, team: t, pos: r.pos, status: r.status, v: Object.fromEntries([...SIM_STATS, 'min'].map(s => [s, new Float32Array(N)])) });
  }
  const c = SIM.CORR, a = Math.sqrt(c), b = Math.sqrt(1 - c);
  for (let i = 0; i < N; i++) {
    const z0 = normal(R), T = {}; for (const t of teams) T[t] = Math.max(70, mean[t] + SIM.SD_TEAM * (a * z0 + b * normal(R)));
    const margin = Math.abs(T[g.home] - T[g.away]), cut = margin > SIM.BLOW_START ? Math.min(.3, (margin - SIM.BLOW_START) * SIM.BLOW_CUT) : 0;
    for (const t of teams) {
      out.score[t].push(T[t]);
      const raw = []; let rawSum = 0;
      for (const r of act[t]) { const p = inp.get(r.pid); let m = Math.min(48, Math.max(0, p.m + p.msd * normal(R)));
        m *= p.start ? 1 - cut : 1 + cut * .8; const f = T[t] / mean[t];
        const d = { min: m, pts: draw(R, p.rate.pts * m, p.cv.pts) };
        d.ast = draw(R, p.rate.ast * m * Math.pow(f, .8), p.cv.ast); d.reb = draw(R, p.rate.reb * m, p.cv.reb);
        for (const s of ['tpm', 'stl', 'blk', 'tov']) d[s] = poisson(R, p.rate[s] * m * (s === 'tpm' ? f : 1));
        raw.push([r.pid, d]); rawSum += d.pts; }
      const k = rawSum > 0 ? T[t] / rawSum : 0;
      for (const [pid, d] of raw) { const v = out.players.get(pid).v; v.min[i] = d.min; v.pts[i] = Math.round(d.pts * k); for (const s of ['reb', 'ast']) v[s][i] = Math.round(d[s]); for (const s of ['tpm', 'stl', 'blk', 'tov']) v[s][i] = d[s]; }
    }
  }
  out.mean = mean; return out;
}
const COMBO = { pra: ['pts', 'reb', 'ast'], pr: ['pts', 'reb'], pa: ['pts', 'ast'], ra: ['reb', 'ast'], stocks: ['stl', 'blk'] };
export const series = (p, s) => { if (!COMBO[s]) return p.v[s]; const N = p.v.pts.length, o = new Float32Array(N); for (const k of COMBO[s]) for (let i = 0; i < N; i++) o[i] += p.v[k][i]; return o; };
export const qtile = (a, q) => { const s = Float32Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
export const pOverSim = (a, line) => { let n = 0; for (const x of a) if (x > line) n++; return n / a.length; };

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), date = args.find(a => /^\d{4}-\d\d-\d\d$/.test(a)) || etDate(new Date().toISOString());
  const N = +(args.find(a => /^\d+$/.test(a)) || 10000), linesFile = args.find(a => /\.txt$/.test(a));
  const X = loadData(), slate = projectDate(X, date); if (!slate.length) { console.log('No games on', date); process.exit(0); }
  const pct = x => (x * 100).toFixed(0) + '%', f0 = x => x.toFixed(0), sims = [];
  for (const { game: g, rows } of slate) {
    const S = simulateGame(g, rows, N); sims.push({ g, S, rows });
    const H = S.score[g.home], A = S.score[g.away]; let hw = 0, cov = 0, ov = 0; const tot = [], mar = [];
    for (let i = 0; i < N; i++) { const h = Math.round(H[i]), a = Math.round(A[i]); hw += h > a || (h === a && R2(i)) ? 1 : 0; mar.push(h - a); tot.push(h + a);
      if (g.odds && g.odds.hs != null && h - a + g.odds.hs > 0) cov++; if (g.odds && g.odds.ou && h + a > g.odds.ou) ov++; }
    function R2(i) { return i % 2 === 0; } // ties go to overtime: coin flip
    console.log(`\n=== ${g.away} @ ${g.home}  (${N.toLocaleString()} sims)  line: ${g.odds ? `${g.home} ${g.odds.hs > 0 ? '+' : ''}${g.odds.hs}, total ${g.odds.ou}` : 'none'}`);
    console.log(`  Avg score ${g.away} ${f0(S.mean[g.away])} - ${g.home} ${f0(S.mean[g.home])} | ${g.home} win ${pct(hw / N)}, ${g.away} win ${pct(1 - hw / N)}` +
      (g.odds && g.odds.hs != null ? ` | ${g.home} covers ${pct(cov / N)}` : '') + (g.odds && g.odds.ou ? ` | over ${g.odds.ou}: ${pct(ov / N)}` : '') +
      ` | margin 80% range ${f0(qtile(mar, .1))} to ${f0(qtile(mar, .9))}, total ${f0(qtile(tot, .1))}-${f0(qtile(tot, .9))}`);
    const ps = [...S.players.values()].sort((a, b) => qtile(series(b, 'pra'), .5) - qtile(series(a, 'pra'), .5));
    for (const p of ps) { const m = s => qtile(series(p, s), .5), r = s => `${f0(qtile(series(p, s), .25))}-${f0(qtile(series(p, s), .75))}`;
      if (qtile(p.v.min, .5) < 12) continue;
      console.log(`   ${p.name.padEnd(24)} ${p.team.padEnd(4)} ${f0(qtile(p.v.min, .5))} min | pts ${f0(m('pts'))} (${r('pts')}) reb ${f0(m('reb'))} (${r('reb')}) ast ${f0(m('ast'))} (${r('ast')}) 3pm ${f0(m('tpm'))} | PRA ${f0(m('pra'))} (${r('pra')})${p.status ? '  [' + p.status + ']' : ''}`); }
    const outs = rows.filter(r => r.out); if (outs.length) console.log('   out: ' + outs.map(r => `${r.name} (${r.team})`).join(', '));
  }
  if (linesFile) {
    const price = s => { if (s == null || s === '') return null; s = String(s).trim(); if (/x$/i.test(s)) return 100 / parseFloat(s); const v = parseFloat(s); return isFinite(v) ? (v > 1 ? v : v * 100) : null; };
    const res = [];
    for (const raw of readFileSync(linesFile, 'utf8').split(/\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))) {
      const [name, st, ln, po, pu] = raw.split(/\s*[,|\t]\s*/), stat = STAT_ALIAS[(st || '').toLowerCase().trim()], line = parseFloat(ln);
      let p = null; for (const { S } of sims) for (const q of S.players.values()) if (normName(q.name) === normName(name || '')) p = q;
      if (!p || !stat) { res.push({ raw, err: true }); continue; }
      const q = pOverSim(series(p, stat), line), o = price(po), u = price(pu), eo = o != null ? q * 100 - o : (q - .5) * 100, eu = u != null ? (1 - q) * 100 - u : (.5 - q) * 100;
      res.push(eo >= eu ? { name: p.name, stat, line, side: 'Over', ch: q, pr: o, edge: eo, med: qtile(series(p, stat), .5) } : { name: p.name, stat, line, side: 'Under', ch: 1 - q, pr: u, edge: eu, med: qtile(series(p, stat), .5) });
    }
    console.log('\n=== Lines (simulation odds) ===');
    for (const r of res.sort((a, b) => (b.edge ?? -99) - (a.edge ?? -99))) console.log(r.err ? `   ?? ${r.raw}` : `${(r.edge > 0 ? '+' : '') + r.edge.toFixed(0)}`.padStart(4) + `  ${r.side.padEnd(5)} ${r.name} ${LABEL[r.stat]} ${r.line} | sim median ${r.med} | ${pct(r.ch)}${r.pr != null ? ' vs price ' + r.pr.toFixed(0) + '%' : ''}`);
  }
}
