// NBA projection model (shared by project/grade/review/backtest scripts).
// Projection = projected minutes × per-minute rates, adjusted for:
//  - teammates out (minutes rescaled to 240; usage/rebound share boosts),
//  - opponent (stat allowed vs league, ^OPP_W), Vegas implied team points (pace/scoring), blowout risk, back-to-backs,
//  - then shaded toward a typical (median) game (TYPICAL), since stat distributions are right-skewed.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// tuned on the Dec 2025-Nov 2026 backtest (node nba/backtest.mjs)
export const P = { HL_MIN: 3, HL_RATE: 20, PRIOR_W: .35, SHRINK_MIN: 20, OPP_W: .3, VEGAS_W: .7, USE_B: .6, REB_B: .5, B2B: .94, BLOWOUT: .012, TYPICAL: .94, TYP_CNT: .9, SD_K: 1.15, STAR_TYP: .045 };
export const STATS = ['pts', 'reb', 'ast', 'tpm', 'stl', 'blk', 'tov', 'fga', 'fta'];
export const COMBOS = { pra: ['pts', 'reb', 'ast'], pr: ['pts', 'reb'], pa: ['pts', 'ast'], ra: ['reb', 'ast'], stocks: ['stl', 'blk'] };
export const LABEL = { pts: 'Points', reb: 'Rebounds', ast: 'Assists', tpm: '3-pointers made', stl: 'Steals', blk: 'Blocks', tov: 'Turnovers', pra: 'Pts+Reb+Ast', pr: 'Pts+Reb', pa: 'Pts+Ast', ra: 'Reb+Ast', stocks: 'Stl+Blk', min: 'Minutes' };
const COUNT = new Set(['tpm', 'stl', 'blk', 'tov']);   // low counts: Poisson odds
const INJURY_DNP = /injur|illness|not with team|suspend|personal|rest|g league|health|protocol|surgery|sore|sprain|strain|out/i;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

export function loadData(path = fileURLToPath(new URL('./data.json', import.meta.url))) {
  const D = JSON.parse(readFileSync(path, 'utf8'));
  const C = D.logs.cols, rows = D.logs.rows.map(r => Object.fromEntries(C.map((c, i) => [c, r[i]])));
  const byPlayer = new Map(), byGame = new Map(), teamGames = new Map();
  for (const r of rows) {
    (byPlayer.get(r.pid) || byPlayer.set(r.pid, []).get(r.pid)).push(r);
    (byGame.get(r.gid) || byGame.set(r.gid, []).get(r.gid)).push(r);
  }
  const games = D.games.filter(g => g.stype === 2 || g.stype === 3);
  for (const g of games) if (g.done) for (const t of [g.home, g.away]) (teamGames.get(t) || teamGames.set(t, []).get(t)).push(g);
  return { D, rows, byPlayer, byGame, teamGames, games, gameById: new Map(games.map(g => [g.id, g])) };
}

// team-level context before `cutoff`: points for/against, stats allowed, usage/rebound totals
function teamStats(X, team, cutoff, season, n = 20) {
  const gs = (X.teamGames.get(team) || []).filter(g => g.date < cutoff && (g.season === season || g.season === season - 1)).slice(-n);
  const o = { n: gs.length, pf: 0, pa: 0, allow: Object.fromEntries(STATS.map(s => [s, 0])), use: 0, reb: 0 };
  for (const g of gs) {
    const home = g.home === team; o.pf += home ? g.hs : g.as; o.pa += home ? g.as : g.hs;
    for (const r of X.byGame.get(g.id) || []) { if (r.dnp) continue;
      if (r.team === team) { o.use += r.fga + .44 * r.fta + r.tov; o.reb += r.reb; } else for (const s of STATS) o.allow[s] += r[s]; }
  }
  if (o.n) { o.pf /= o.n; o.pa /= o.n; o.use /= o.n; o.reb /= o.n; for (const s of STATS) o.allow[s] /= o.n; }
  return o;
}
function league(X, cutoff, season) {
  const key = cutoff.slice(0, 10) + season; X._lg = X._lg || new Map(); if (X._lg.has(key)) return X._lg.get(key);
  const teams = [...X.teamGames.keys()], T = Object.fromEntries(teams.map(t => [t, teamStats(X, t, cutoff, season)]));
  const ok = teams.filter(t => T[t].n >= 3), avg = f => ok.reduce((a, t) => a + f(T[t]), 0) / Math.max(ok.length, 1);
  const L = { T, pts: avg(t => t.pf), allow: Object.fromEntries(STATS.map(s => [s, avg(t => t.allow[s])])) };
  X._lg.set(key, L); return L;
}

// one player's baseline before `cutoff`: weighted minutes (recent rotation role) and per-minute rates
function baseline(X, pid, team, cutoff, season) {
  const all = (X.byPlayer.get(pid) || []).filter(r => r.date < cutoff && (r.season === season || r.season === season - 1));
  if (!all.length) return null;
  const teamRows = all.filter(r => r.team === team && r.season === season);
  // minutes: last 10 team games where the player was available (coach's-decision DNPs count as 0)
  const avail = teamRows.filter(r => !r.dnp || !INJURY_DNP.test(r.dnp)).slice(-10);
  let wm = 0, ws = 0; avail.forEach((r, i) => { const w = Math.pow(.5, (avail.length - 1 - i) / P.HL_MIN); wm += w * (r.dnp ? 0 : r.min); ws += w; });
  let min = ws ? wm / ws : 0;
  if (avail.length < 3) { // new team / early season: lean on all recent games
    const pl = all.filter(r => !r.dnp).slice(-10); if (pl.length) min = (min * avail.length + pl.reduce((a, r) => a + r.min, 0) / pl.length * (3 - avail.length)) / 3; }
  const played = all.filter(r => !r.dnp && r.min > 0);
  const rate = {}, sd = {}; let wmin = 0; const acc = Object.fromEntries(STATS.map(s => [s, 0]));
  played.forEach((r, i) => { const w = Math.pow(.5, (played.length - 1 - i) / P.HL_RATE) * (r.season === season ? 1 : P.PRIOR_W); wmin += w * r.min; for (const s of STATS) acc[s] += w * r[s]; });
  const recent = played.slice(-25);
  for (const s of [...STATS, ...Object.keys(COMBOS)]) {
    const v = r => COMBOS[s] ? COMBOS[s].reduce((a, k) => a + r[k], 0) : r[s];
    const pm = recent.map(r => v(r) / Math.max(r.min, 1)), m = pm.reduce((a, x) => a + x, 0) / Math.max(pm.length, 1);
    sd[s] = pm.length > 2 ? Math.sqrt(pm.reduce((a, x) => a + (x - m) ** 2, 0) / (pm.length - 1)) : null; // per-minute sd
  }
  for (const s of STATS) rate[s] = wmin ? acc[s] / wmin : 0;
  return { min, rate, wmin, sd, n: played.length, games: recent, last: all[all.length - 1] };
}
const posGroup = p => /C/.test(p) ? 'C' : /F/.test(p) ? 'F' : 'G';

// Project every player on both teams of game `g` using only data before tip-off.
// outFn(pid, team) -> true if the player won't play (injury report for upcoming games; box score for past games)
export function projectGame(X, g, outFn, opts = {}) {
  const cutoff = g.date, season = g.season, L = league(X, cutoff, season), res = [];
  // shrink rates toward the league per-minute average by position
  const lgRate = X._lgRate || (X._lgRate = new Map()); const lrKey = season + cutoff.slice(0, 7);
  if (!lgRate.has(lrKey)) { const acc = {}; for (const r of X.rows) { if (r.dnp || r.date >= cutoff || r.season < season - 1 || r.min < 10) continue; const k = posGroup(r.pos); const a = acc[k] || (acc[k] = { min: 0, ...Object.fromEntries(STATS.map(s => [s, 0])) }); a.min += r.min; for (const s of STATS) a[s] += r[s]; }
    lgRate.set(lrKey, Object.fromEntries(Object.entries(acc).map(([k, a]) => [k, Object.fromEntries(STATS.map(s => [s, a[s] / a.min]))]))); }
  const LR = lgRate.get(lrKey);
  for (const [team, opp, home] of [[g.home, g.away, true], [g.away, g.home, false]]) {
    const T = L.T[team] || teamStats(X, team, cutoff, season), O = L.T[opp] || teamStats(X, opp, cutoff, season);
    // roster: anyone who appeared for this team in its last 12 games
    const tg = (X.teamGames.get(team) || []).filter(x => x.date < cutoff && x.season === season).slice(-12);
    const pids = new Set(); for (const x of tg) for (const r of X.byGame.get(x.id) || []) if (r.team === team) pids.add(r.pid);
    if (opts.extra && opts.extra[team]) for (const p of opts.extra[team]) pids.add(p);
    const B = [];
    // live only: also out if missing from the team's last 3 box scores, or the last 2 games were injury DNPs (ESPN's report can lag)
    const absent = pid => { if (tg.length < 3) return false; const rs = tg.slice(-3).map(x => (X.byGame.get(x.id) || []).find(r => r.pid === pid));
      if (rs.every(r => !r)) return true; const l2 = rs.slice(-2); return l2.every(r => r && r.dnp && INJURY_DNP.test(r.dnp)); };
    for (const pid of pids) { const b = baseline(X, pid, team, cutoff, season); if (!b) continue; const out = outFn(pid, team) || (opts.live && absent(pid));
      const pg = posGroup(b.last.pos), lr = LR[pg] || LR.G;
      for (const s of STATS) b.rate[s] = (b.rate[s] * b.wmin + lr[s] * P.SHRINK_MIN) / (b.wmin + P.SHRINK_MIN);
      B.push({ pid, name: b.last.name, pos: b.last.pos, b, out }); }
    const act = B.filter(x => !x.out && x.b.min > 0);
    // minutes: rescale the active rotation to 240 (cap 40), then blowout and back-to-back trims
    let mins = new Map(act.map(x => [x.pid, x.b.min]));
    for (let k = 0; k < 4; k++) { const tot = [...mins.values()].reduce((a, v) => a + v, 0); if (!tot) break; const f = 240 / tot; for (const [p, m] of mins) mins.set(p, Math.min(m * (f > 1 ? f : 1 - (1 - f) * .5) , 40)); }
    const sp = g.odds && g.odds.hs != null ? (home ? g.odds.hs : -g.odds.hs) : 0; // negative = this team favored
    const blow = Math.max(0, Math.abs(sp) - 8) * P.BLOWOUT;
    const prev = (X.teamGames.get(team) || []).filter(x => x.date < cutoff).slice(-1)[0];
    const b2b = prev && (new Date(cutoff) - new Date(prev.date)) < 30 * 36e5;
    for (const [p, m] of mins) mins.set(p, m * (m > 28 ? (1 - blow) * (b2b ? P.B2B : 1) : 1 + blow * .5));
    // share boosts when teammates are out: team usage / rebounds the active group normally produces vs the team's usual total
    const projUse = act.reduce((a, x) => a + mins.get(x.pid) * (x.b.rate.fga + .44 * x.b.rate.fta + x.b.rate.tov), 0);
    const projReb = act.reduce((a, x) => a + mins.get(x.pid) * x.b.rate.reb, 0);
    const useF = T.use && projUse ? clamp(Math.pow(T.use / projUse, P.USE_B), .85, 1.3) : 1;
    const rebF = T.reb && projReb ? clamp(Math.pow(T.reb / projReb, P.REB_B), .85, 1.25) : 1;
    // Vegas: implied team points vs the team's usual scoring
    let implied = null, vegF = 1;
    if (g.odds && g.odds.ou && g.odds.hs != null) { implied = home ? g.odds.ou / 2 - g.odds.hs / 2 : g.odds.ou / 2 + g.odds.hs / 2; if (T.pf) vegF = clamp(Math.pow(implied / T.pf, P.VEGAS_W), .85, 1.15); }
    const oppF = s => O.n >= 3 && L.allow[s] ? clamp(Math.pow(O.allow[s] / L.allow[s], P.OPP_W), .85, 1.15) : 1;
    for (const x of B) {
      const m = x.out ? 0 : (mins.get(x.pid) || 0), r = x.b.rate, proj = { min: m };
      const fac = { pts: useF * vegF, tpm: useF * vegF, ast: Math.sqrt(useF) * vegF, fga: useF, fta: useF, tov: Math.sqrt(useF), reb: rebF, stl: 1, blk: 1 };
      // stars' scoring/playmaking is less right-skewed than role players': shade it less (live-like backtest: stars beat the
      // 0.94-shaded points 54.8% of the time, PRA 56.6%); full adjustment at 30+ minutes, none below 22
      const star = P.STAR_TYP * clamp((x.b.min - 22) / 8, 0, 1), typ = s => (COUNT.has(s) ? P.TYP_CNT : P.TYPICAL) + (s === 'pts' || s === 'ast' || s === 'tpm' ? star : 0);
      for (const s of STATS) proj[s] = m * r[s] * fac[s] * (s === 'fga' || s === 'fta' ? 1 : oppF(s)) * typ(s);
      for (const [c, parts] of Object.entries(COMBOS)) proj[c] = parts.reduce((a, k) => a + proj[k], 0);
      const sd = {}; for (const s of [...STATS, ...Object.keys(COMBOS)]) sd[s] = P.SD_K * (x.b.sd[s] != null ? Math.max(x.b.sd[s] * m, Math.sqrt(Math.max(proj[s], .5))) : Math.max(.35 * proj[s], 1));
      res.push({ pid: x.pid, name: x.name, pos: x.pos, team, opp, home, out: x.out, proj, sd, base: x.b, implied, spread: sp, b2b, useF, rebF, vegF, gid: g.id, date: g.date });
    }
  }
  return res;
}

// chance the stat goes over `line`
function poisCdf(lam, k) { let c = 0, p = Math.exp(-lam); for (let i = 0; i <= k; i++) { c += p; p *= lam / (i + 1); } return c; }
function normCdf(z) { const t = 1 / (1 + .2316419 * Math.abs(z)), d = .3989423 * Math.exp(-z * z / 2), p = d * t * (.3193815 + t * (-.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; }
export function pOver(R, stat, line) {
  const mu = R.proj[stat]; if (!(mu > 0)) return 0;
  if (COUNT.has(stat)) return 1 - poisCdf(mu, Math.floor(line));
  return 1 - normCdf((line - mu) / Math.max(R.sd[stat] || 0, 1));
}
// how often the player cleared the line in their last 10 games
export function hitRate(R, stat, line) {
  const g = R.base.games.slice(-10), v = r => COMBOS[stat] ? COMBOS[stat].reduce((a, k) => a + r[k], 0) : r[stat];
  return g.length ? { hit: g.filter(r => v(r) > line).length, n: g.length } : null;
}
export const STAT_ALIAS = { points: 'pts', pts: 'pts', rebounds: 'reb', reb: 'reb', rebs: 'reb', assists: 'ast', ast: 'ast', asts: 'ast', '3pm': 'tpm', threes: 'tpm', '3-pointers made': 'tpm', '3pt made': 'tpm', '3-pt made': 'tpm', 'three pointers made': 'tpm', tpm: 'tpm',
  steals: 'stl', stl: 'stl', blocks: 'blk', blk: 'blk', turnovers: 'tov', tov: 'tov', 'pts+reb+ast': 'pra', pra: 'pra', 'pts+rebs+asts': 'pra', 'pts+reb': 'pr', 'pts+rebs': 'pr', pr: 'pr', 'pts+ast': 'pa', 'pts+asts': 'pa', pa: 'pa', 'reb+ast': 'ra', 'rebs+asts': 'ra', ra: 'ra', 'stl+blk': 'stocks', 'blks+stls': 'stocks', stocks: 'stocks' };
export const normName = s => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z ]/g, '').replace(/\b(jr|sr|ii|iii|iv)\b/g, '').replace(/\s+/g, ' ').trim();
// "Out" on the injury report = out; Doubtful counts as out too (they rarely play)
export const injuredOut = (D, pid, team) => (D.injuries[team] || []).some(i => i.pid === pid && /^(out|doubtful)$/i.test(i.status));
