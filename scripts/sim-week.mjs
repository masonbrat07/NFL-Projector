#!/usr/bin/env node
// Monte Carlo simulator for an NFL week, built on the site's saved projections (projections/<season>-wk<NN>.json,
// from scripts/week-projections.py) and the game logs in data.json. Each run:
//  1) draws both team scores around the Vegas-implied points (sd 9.1, correlation 0.08 — measured on 2024-26 games);
//  2) offensive TDs ~ Poisson(score / 9.43 pts per offensive TD), handed out in proportion to each player's TD projection
//     (with a share left for players not listed), receiving TDs also counting as the QB's passing TDs;
//  3) QB passing yards drawn around the projection (nudged by the simulated score), then split across that team's
//     receivers in proportion to their own draws, so receiving yards add up to the passing yards;
//  4) rushing yards drawn around the projection, up when the team leads and down when it trails.
// Usage: node scripts/sim-week.mjs [season week] [runs=10000] [GAME=GB@LAR] [OUT=Josh Jacobs;Other Name] [lines.txt]
//   lines.txt: Player, stat, line, over price, under price   (stats: pass yds, rush yds, rec yds, receptions, anytime td,
//   rush+rec yds, pass tds; prices like 54 / 54% / 1.85x)
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
export const SIM = { SD_TEAM: 9.1, CORR: .08, PTS_PER_TD: 9.43, OTHER_TD: .25, CV_FLOOR: .3, CV_CAP: 1.1, RUSH_TYP: .9, RUSH_CV: 1.3, LEAD_RUSH: .012, PASS_K: 1.05, QB_LINK: 1, REC_CV: 1 };
const TYP_YDS = .82, TYP_TD = .9; // projections are shaded to a typical game; the sim needs means
function rng(seed) { let a = seed >>> 0; return () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function normal(R) { let u = 0; while (!u) u = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * R()); }
function gamma(R, k) { if (k < 1) return gamma(R, k + 1) * Math.pow(R() || 1e-9, 1 / k); const d = k - 1 / 3, c = 1 / Math.sqrt(9 * d);
  for (;;) { let x, v; do { x = normal(R); v = 1 + c * x; } while (v <= 0); v = v * v * v; const u = R(); if (u < 1 - .0331 * x ** 4 || Math.log(u) < .5 * x * x + d * (1 - v + Math.log(v))) return d * v; } }
function poisson(R, lam) { if (lam <= 0) return 0; let L = Math.exp(-lam), k = 0, p = 1; do { k++; p *= R(); } while (p > L); return k - 1; }
const draw = (R, mu, cv) => mu <= 0 ? 0 : mu * gamma(R, 1 / (cv * cv)) * cv * cv;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

function loadLogs() {
  const d = JSON.parse(readFileSync(ROOT + 'data.json', 'utf8')), C = d.pg.cols, by = new Map();
  for (const r of d.pg.rows) { const o = Object.fromEntries(C.map((c, i) => [c, r[i]])); (by.get(o.pid) || by.set(o.pid, []).get(o.pid)).push(o); }
  for (const l of by.values()) l.sort((a, b) => a.date < b.date ? -1 : 1);
  return by;
}
// a player's game-to-game spread (coefficient of variation) for a stat, from their last 16 games
function cvOf(logs, pid, s, dflt) {
  const g = (logs.get(pid) || []).slice(-16).map(r => r[s] || 0); if (g.length < 4) return dflt;
  const m = g.reduce((a, x) => a + x, 0) / g.length; if (m <= 0) return dflt;
  return clamp(Math.sqrt(g.reduce((a, x) => a + (x - m) ** 2, 0) / g.length) / m, SIM.CV_FLOOR, SIM.CV_CAP);
}
const OUT = /^(out|ir|doubtful|susp|pup|nfi)/i;

export function simulateGame(g, players, logs, N = 10000, seed = 11, outNames = new Set()) {
  const R = rng(seed + +g.id % 100000), teams = [g.home, g.away], out = { N, score: { [g.home]: new Float32Array(N), [g.away]: new Float32Array(N) }, players: new Map() };
  const imp = { [g.home]: g.total / 2 - g.spread_home / 2, [g.away]: g.total / 2 + g.spread_home / 2 };
  const T = {};
  for (const t of teams) {
    const all = players.filter(p => p.team === t && !OUT.test(p.status || '') && p.news !== 'out');
    const ps = all.filter(p => !outNames.has(norm(p.name))), gone = all.filter(p => outNames.has(norm(p.name)));
    const qb = ps.filter(p => p.pos === 'QB').sort((a, b) => b.proj.pass_att - a.proj.pass_att)[0];
    const typ = p => p.pos === 'QB' ? 1 : TYP_YDS;
    const inp = ps.map(p => ({ p, rush: p.proj.rush_yds / (p.pos === 'QB' ? 1 : SIM.RUSH_TYP), rec: p.proj.rec_yds / typ(p), recN: p.proj.rec / typ(p), td: (p.proj.rush_td + p.proj.rec_td) / TYP_TD,
      rtd: p.proj.rush_td / TYP_TD, cvRush: Math.min(SIM.CV_CAP * 1.3, cvOf(logs, p.pid, 'rush_yds', .6) * SIM.RUSH_CV), cvRec: cvOf(logs, p.pid, 'rec_yds', .7) }));
    // players ruled out by hand (OUT=Name): their rushing/receiving/TD work goes to same-position teammates by size of role
    for (const o of gone) { const mates = inp.filter(x => x.p.pos === o.pos); const w = mates.reduce((a, x) => a + x.rush + x.rec + .1, 0); if (!w) continue;
      for (const x of mates) { const f = (x.rush + x.rec + .1) / w; x.rush += f * o.proj.rush_yds / SIM.RUSH_TYP; x.rec += f * o.proj.rec_yds / TYP_YDS; x.recN += f * o.proj.rec / TYP_YDS;
        x.td += f * (o.proj.rush_td + o.proj.rec_td) / TYP_TD; x.rtd += f * o.proj.rush_td / TYP_TD; } }
    const recvMean = inp.reduce((a, x) => a + x.rec, 0), qbPass = qb ? qb.proj.pass_yds * SIM.PASS_K : recvMean;
    const tdSum = inp.reduce((a, x) => a + x.td, 0), teamTD = imp[t] / SIM.PTS_PER_TD, other = Math.max(SIM.OTHER_TD * teamTD, teamTD - tdSum);
    T[t] = { ps, qb, inp, recvMean, qbPass, qbPassMean: qbPass, cvPass: qb ? cvOf(logs, qb.pid, 'pass_yds', .3) * .9 : .3, tdW: [...inp.map(x => x.td), other], rushShare: inp.reduce((a, x) => a + x.rtd, 0) / Math.max(tdSum, .01) };
    for (const p of ps) out.players.set(p.pid, { name: p.name, team: t, pos: p.pos, status: p.status, v: { pass_yds: new Float32Array(N), pass_td: new Float32Array(N), rush_yds: new Float32Array(N), rec_yds: new Float32Array(N), rec: new Float32Array(N), td: new Float32Array(N) } });
  }
  const a = Math.sqrt(SIM.CORR), b = Math.sqrt(1 - SIM.CORR);
  for (let i = 0; i < N; i++) {
    const z0 = normal(R), S = {}; for (const t of teams) S[t] = Math.max(0, imp[t] + SIM.SD_TEAM * (a * z0 + b * normal(R)));
    for (const t of teams) {
      const o = teams.find(x => x !== t), X = T[t], lead = S[t] - S[o], f = S[t] / Math.max(imp[t], 1);
      out.score[t][i] = S[t];
      // passing yards: more points = more yards, but trailing teams also throw more
      const pass = X.qb ? draw(R, X.qbPass * Math.pow(f, .3) * clamp(1 - .006 * lead, .85, 1.15), X.cvPass) : 0;
      const raw = X.inp.map(x => x.rec > 0 ? draw(R, x.rec, x.cvRec * SIM.REC_CV) : 0);
      // receivers rise and fall with their QB's simulated yards (ratio to the QB's mean), keeping their own projections
      const k = X.qb ? Math.pow(pass / Math.max(X.qbPassMean, 1), SIM.QB_LINK) : 1;
      // offensive TDs from the simulated score, handed out by TD projection
      const nTD = poisson(R, S[t] / SIM.PTS_PER_TD), tds = new Array(X.inp.length).fill(0), wsum = X.tdW.reduce((s, x) => s + x, 0); let passTD = 0;
      for (let j = 0; j < nTD; j++) { let u = R() * wsum, idx = 0; while (idx < X.tdW.length - 1 && (u -= X.tdW[idx]) > 0) idx++;
        if (idx < X.inp.length) { tds[idx]++; const x = X.inp[idx]; if (R() >= x.rtd / Math.max(x.td, .001)) passTD++; } else if (R() > X.rushShare) passTD++; }
      X.inp.forEach((x, j) => { const v = out.players.get(x.p.pid).v;
        v.rush_yds[i] = x.rush > 0 ? Math.round(draw(R, x.rush * clamp(1 + SIM.LEAD_RUSH * lead, .7, 1.35), x.cvRush)) : 0;
        v.rec_yds[i] = Math.round(raw[j] * k); v.rec[i] = x.recN > 0 ? poisson(R, x.recN * Math.pow(Math.max(raw[j], .1) / Math.max(x.rec, .1), .6)) : 0;
        v.td[i] = tds[j]; if (x.p === X.qb) { v.pass_yds[i] = Math.round(pass); v.pass_td[i] = passTD; } });
    }
  }
  out.imp = imp; return out;
}
const ALIAS = { 'pass yds': 'pass_yds', 'passing yards': 'pass_yds', 'pass yards': 'pass_yds', 'rush yds': 'rush_yds', 'rushing yards': 'rush_yds', 'rush yards': 'rush_yds', 'rec yds': 'rec_yds', 'receiving yards': 'rec_yds', 'rec yards': 'rec_yds',
  receptions: 'rec', rec: 'rec', 'anytime td': 'td', td: 'td', 'anytime touchdown': 'td', 'rush+rec yds': 'rr', 'rush + rec yds': 'rr', 'rush+rec yards': 'rr', 'pass tds': 'pass_td', 'passing tds': 'pass_td', 'pass td': 'pass_td' };
const series = (p, s) => { if (s !== 'rr') return p.v[s]; const o = new Float32Array(p.v.rush_yds.length); for (let i = 0; i < o.length; i++) o[i] = p.v.rush_yds[i] + p.v.rec_yds[i]; return o; };
const qt = (a, q) => { const s = Float32Array.from(a).sort(); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const pOver = (a, l) => { let n = 0; for (const x of a) if (x > l) n++; return n / a.length; };
const norm = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim();

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2), nums = args.filter(a => /^\d+$/.test(a)).map(Number);
  let season, week; if (nums.length >= 2 && nums[0] > 2000) [season, week] = nums;
  else { const f = readdirSync(ROOT + 'projections').filter(f => /^\d{4}-wk\d\d\.json$/.test(f)).sort().pop(); [season, week] = [+f.slice(0, 4), +f.slice(7, 9)]; }
  const N = nums.find(n => n >= 100 && n !== season) || 10000, only = (args.find(a => a.startsWith('GAME=')) || '').slice(5).toUpperCase(), linesFile = args.find(a => a.endsWith('.txt'));
  const outNames = new Set((args.find(a => a.startsWith('OUT=')) || '').slice(4).split(/[;,]/).map(norm).filter(Boolean));
  const W = JSON.parse(readFileSync(ROOT + `projections/${season}-wk${String(week).padStart(2, '0')}.json`, 'utf8')), logs = loadLogs();
  const pct = x => (x * 100).toFixed(0) + '%', f0 = x => Math.round(x), sims = [];
  for (const g of W.games) {
    if (only && `${g.away}@${g.home}` !== only) continue;
    if (g.total == null || g.spread_home == null) { console.log(`\n${g.away} @ ${g.home}: no betting line yet, skipped`); continue; }
    const S = simulateGame(g, W.players.filter(p => p.team === g.home || p.team === g.away), logs, N, 11, outNames); sims.push(S);
    const H = S.score[g.home], A = S.score[g.away]; let hw = 0, cov = 0, ov = 0; const mar = new Float32Array(N), tot = new Float32Array(N);
    for (let i = 0; i < N; i++) { const h = Math.round(H[i]), a = Math.round(A[i]); hw += h > a ? 1 : h === a ? .5 : 0; mar[i] = h - a; tot[i] = h + a; if (h - a + g.spread_home > 0) cov++; if (h + a > g.total) ov++; }
    console.log(`\n=== ${g.away} @ ${g.home}  (${N.toLocaleString()} sims)  line: ${g.home} ${g.spread_home > 0 ? '+' : ''}${g.spread_home}, total ${g.total}`);
    console.log(`  Median score ${g.away} ${f0(qt(A, .5))} - ${g.home} ${f0(qt(H, .5))} | ${g.home} win ${pct(hw / N)} | ${g.home} covers ${pct(cov / N)} | over ${pct(ov / N)} | margin 80% range ${f0(qt(mar, .1))} to ${f0(qt(mar, .9))}`);
    for (const p of [...S.players.values()].sort((a, b) => (b.pos === 'QB') - (a.pos === 'QB') || qt(series(b, 'rr'), .5) - qt(series(a, 'rr'), .5))) {
      const m = s => f0(qt(series(p, s), .5)), r = s => `${f0(qt(series(p, s), .25))}-${f0(qt(series(p, s), .75))}`, td = pOver(p.v.td, .5);
      if (p.pos === 'QB') console.log(`   ${p.name.padEnd(24)} QB  pass ${m('pass_yds')} (${r('pass_yds')}) | 2+ pass TD ${pct(pOver(p.v.pass_td, 1.5))} | rush ${m('rush_yds')}`);
      else if (qt(series(p, 'rr'), .5) >= 8) console.log(`   ${p.name.padEnd(24)} ${p.pos.padEnd(3)} ${p.v.rush_yds.some(x => x) && qt(p.v.rush_yds, .5) >= 5 ? `rush ${m('rush_yds')} (${r('rush_yds')}) ` : ''}rec ${m('rec')} for ${m('rec_yds')} (${r('rec_yds')}) | anytime TD ${pct(td)}${p.status ? '  [' + p.status + ']' : ''}`);
    }
  }
  if (linesFile) {
    const price = s => { if (s == null || s === '') return null; s = String(s).trim(); if (/x$/i.test(s)) return 100 / parseFloat(s); const v = parseFloat(s); return isFinite(v) ? (v > 1 ? v : v * 100) : null; };
    console.log('\n=== Lines (simulation odds) ==='); const res = [];
    for (const raw of readFileSync(linesFile, 'utf8').split(/\n/).map(l => l.trim()).filter(l => l && !l.startsWith('#'))) {
      const [name, st, ln, po, pu] = raw.split(/\s*[,|\t]\s*/), stat = ALIAS[(st || '').toLowerCase().trim()], line = parseFloat(ln) || .5;
      let p = null; for (const S of sims) for (const q of S.players.values()) if (norm(q.name) === norm(name || '')) p = q;
      if (!p || !stat) { res.push({ raw }); continue; }
      const q = pOver(series(p, stat), line), o = price(po), u = price(pu), eo = o != null ? q * 100 - o : (q - .5) * 100, eu = u != null ? (1 - q) * 100 - u : (.5 - q) * 100;
      res.push({ ...(eo >= eu ? { side: 'Over', ch: q, pr: o, edge: eo } : { side: 'Under', ch: 1 - q, pr: u, edge: eu }), name: p.name, st, line, med: qt(series(p, stat), .5) });
    }
    for (const r of res.sort((a, b) => (b.edge ?? -99) - (a.edge ?? -99))) console.log(r.name ? `${(r.edge > 0 ? '+' : '') + r.edge.toFixed(0)}`.padStart(4) + `  ${r.side.padEnd(5)} ${r.name} ${r.st} ${r.line} | sim median ${r.med} | ${pct(r.ch)}${r.pr != null ? ' vs price ' + r.pr.toFixed(0) + '%' : ''}` : `   ?? ${r.raw}`);
  }
}
