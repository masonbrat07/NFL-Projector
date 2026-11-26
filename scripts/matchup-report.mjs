#!/usr/bin/env node
// Matchup report for one NFL game: both teams' offense and defense, season and last 4 games, with league ranks,
// what each defense allows by position (RB rushing, RB/WR/TE receiving), betting line, weather, injury report, and
// flags for props (e.g. a bottom-5 run defense vs the opponent's lead back). Run before giving picks for any game.
// Usage: node scripts/matchup-report.mjs AWAY@HOME [season week]     e.g. node scripts/matchup-report.mjs PHI@DAL
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const [key, sArg, wArg] = process.argv.slice(2);
if (!key || !key.includes('@')) { console.error('usage: node scripts/matchup-report.mjs AWAY@HOME [season week]'); process.exit(1); }
const [AWAY, HOME] = key.toUpperCase().split('@');
const d = JSON.parse(readFileSync(ROOT + 'data.json', 'utf8'));
const C = d.pg.cols, rows = d.pg.rows.map(r => Object.fromEntries(C.map((c, i) => [c, r[i]])));
const pos = new Map(d.players.map(p => [p.id, p.pos]));
const game = d.games.filter(g => g.home === HOME && g.away === AWAY && (!sArg || (g.season === +sArg && g.week === +wArg))).sort((a, b) => a.date < b.date ? 1 : -1)[0];
if (!game) { console.error('game not found in data.json'); process.exit(1); }
const season = game.season;
const G = d.games.filter(g => g.season === season && g.stype === 2 && g.completed && g.date < game.date).sort((a, b) => a.date < b.date ? -1 : 1);
const byGame = new Map(); for (const r of rows) if (r.season === season) (byGame.get(r.gid) || byGame.set(r.gid, []).get(r.gid)).push(r);
const sum = (a, f) => a.reduce((s, x) => s + (f(x) || 0), 0);

// per team-game: what the offense did and what the defense allowed
function teamGames(t) {
  return G.filter(g => g.home === t || g.away === t).map(g => {
    const opp = g.home === t ? g.away : g.home, mine = (byGame.get(g.id) || []).filter(r => r.team === t), theirs = (byGame.get(g.id) || []).filter(r => r.team === opp);
    const line = (rs) => ({ rushY: sum(rs, r => r.rush_yds), rushA: sum(rs, r => r.rush_att), passY: sum(rs, r => r.pass_yds), passA: sum(rs, r => r.pass_att), passTD: sum(rs, r => r.pass_td),
      rushTD: sum(rs, r => r.rush_td), rbRush: sum(rs.filter(r => pos.get(r.pid) === 'RB'), r => r.rush_yds), qbRush: sum(rs.filter(r => pos.get(r.pid) === 'QB'), r => r.rush_yds),
      ...Object.fromEntries(['RB', 'WR', 'TE'].flatMap(p => { const x = rs.filter(r => pos.get(r.pid) === p); return [[p + 'recY', sum(x, r => r.rec_yds)], [p + 'rec', sum(x, r => r.rec)], [p + 'td', sum(x, r => r.rec_td)]]; })) });
    const pf = g.home === t ? g.hs : g.as, pa = g.home === t ? g.as : g.hs, sp = g.odds && g.odds.hs != null ? (g.home === t ? g.odds.hs : -g.odds.hs) : null;
    return { w: g.week, opp, pf, pa, off: line(mine), def: line(theirs), ats: sp == null ? null : Math.sign(pf - pa + sp), ou: g.odds && g.odds.ou ? Math.sign(pf + pa - g.odds.ou) : null };
  });
}
const teams = [...new Set(G.flatMap(g => [g.home, g.away]))], TG = Object.fromEntries(teams.map(t => [t, teamGames(t)]));
const avg = (arr, f) => arr.length ? sum(arr, f) / arr.length : 0;
const METRICS = { pts: [x => x.pf, x => x.pa], rushY: [x => x.off.rushY, x => x.def.rushY], ypc: [null, null], passY: [x => x.off.passY, x => x.def.passY], ypa: [null, null],
  rbRush: [x => x.off.rbRush, x => x.def.rbRush], qbRush: [x => x.off.qbRush, x => x.def.qbRush], WRrecY: [x => x.off.WRrecY, x => x.def.WRrecY], TErecY: [x => x.off.TErecY, x => x.def.TErecY], RBrecY: [x => x.off.RBrecY, x => x.def.RBrecY],
  WRrec: [x => x.off.WRrec, x => x.def.WRrec], TErec: [x => x.off.TErec, x => x.def.TErec], RBrec: [x => x.off.RBrec, x => x.def.RBrec], passTD: [x => x.off.passTD, x => x.def.passTD], rushTD: [x => x.off.rushTD, x => x.def.rushTD] };
function stat(t, m, side, last) { const a = last ? TG[t].slice(-last) : TG[t], k = side === 'off' ? 0 : 1;
  if (m === 'ypc') { const s = side === 'off' ? 'off' : 'def'; return sum(a, x => x[s].rushY) / Math.max(1, sum(a, x => x[s].rushA)); }
  if (m === 'ypa') { const s = side === 'off' ? 'off' : 'def'; return sum(a, x => x[s].passY) / Math.max(1, sum(a, x => x[s].passA)); }
  return avg(a, METRICS[m][k]); }
// rank 1 = best offense (most) / best defense (least allowed)
const rank = (t, m, side) => { const v = x => stat(x, m, side); return teams.slice().sort((a, b) => side === 'off' ? v(b) - v(a) : v(a) - v(b)).indexOf(t) + 1; };
const lg = (m, side) => avg(teams, t => stat(t, m, side));
const f1 = x => x.toFixed(1), f2 = x => x.toFixed(2);
const LABEL = { pts: 'Points', rushY: 'Rush yds', ypc: 'Yds/carry', passY: 'Pass yds', ypa: 'Yds/pass att', rbRush: 'RB rush yds', qbRush: 'QB rush yds', WRrecY: 'WR rec yds', TErecY: 'TE rec yds', RBrecY: 'RB rec yds', WRrec: 'WR receptions', TErec: 'TE receptions', RBrec: 'RB receptions', passTD: 'Pass TDs', rushTD: 'Rush TDs' };

const o = game.odds || {}, imp = o.ou && o.hs != null ? { [HOME]: o.ou / 2 - o.hs / 2, [AWAY]: o.ou / 2 + o.hs / 2 } : null;
console.log(`\n${AWAY} @ ${HOME}  ${new Date(game.date).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' })} ET  | line: ${HOME} ${o.hs > 0 ? '+' : ''}${o.hs ?? '–'}, total ${o.ou ?? '–'}${imp ? ` -> implied ${AWAY} ${f1(imp[AWAY])}, ${HOME} ${f1(imp[HOME])}` : ''}`);
const wx = game.wx || {}; console.log(`Weather: ${wx.indoor ? 'indoors' : `${Math.round(wx.temp ?? 0)}°F, wind ${Math.round(wx.wind ?? 0)} mph, precip ${f1(wx.precip ?? 0)} mm`}${!wx.indoor && ((wx.wind ?? 0) >= 15 || (wx.precip ?? 0) >= 2) ? '  ** weather hurts passing **' : ''}`);
for (const t of [AWAY, HOME]) { const a = TG[t]; const r = s => `${a.filter(x => x[s] > 0).length}-${a.filter(x => x[s] < 0).length}`;
  console.log(`${t}: ${a.length} games, PF ${f1(stat(t, 'pts', 'off'))} PA ${f1(stat(t, 'pts', 'def'))} | last 4 PF ${f1(stat(t, 'pts', 'off', 4))} PA ${f1(stat(t, 'pts', 'def', 4))} | ATS ${r('ats')} | O/U ${r('ou')} | last 4: ${a.slice(-4).map(x => `${x.opp} ${x.pf}-${x.pa}`).join(', ')}`); }

// the matchup tables: each offense vs the other defense
for (const [off, dfn] of [[AWAY, HOME], [HOME, AWAY]]) {
  console.log(`\n${off} offense vs ${dfn} defense            ${off} off (rank) last4    |  ${dfn} allows (rank) last4   | league`);
  for (const m of Object.keys(METRICS)) {
    const fmt = (m === 'ypc' || m === 'ypa') ? f2 : f1;
    console.log(`  ${LABEL[m].padEnd(14)} ${fmt(stat(off, m, 'off')).padStart(7)} (${String(rank(off, m, 'off')).padStart(2)}) ${fmt(stat(off, m, 'off', 4)).padStart(7)}    | ${fmt(stat(dfn, m, 'def')).padStart(7)} (${String(rank(dfn, m, 'def')).padStart(2)}) ${fmt(stat(dfn, m, 'def', 4)).padStart(7)}   | ${fmt(lg(m, 'def'))}`);
  }
  // flags for props: bottom/top-5 defenses vs this offense
  const flags = [];
  for (const [m, who] of [['rbRush', 'lead RB rushing'], ['qbRush', 'QB rushing'], ['WRrecY', 'WR receiving'], ['TErecY', 'TE receiving'], ['RBrecY', 'RB receiving'], ['passY', 'QB passing yds'], ['passTD', 'pass TDs'], ['rushTD', 'rush TDs']]) {
    const rk = rank(dfn, m, 'def'), l4 = stat(dfn, m, 'def', 4), s = stat(dfn, m, 'def'), L = lg(m, 'def');
    if (rk >= 28) flags.push(`${dfn} is ${rk}th vs ${who} (${f1(s)}/g, last 4 ${f1(l4)}, league ${f1(L)}) -> favors ${off} Overs`);
    else if (rk <= 5) flags.push(`${dfn} is ${rk}th-best vs ${who} (${f1(s)}/g, last 4 ${f1(l4)}, league ${f1(L)}) -> favors ${off} Unders`);
    else if (l4 > s * 1.25 && l4 > L * 1.15) flags.push(`${dfn} trending worse vs ${who}: last 4 ${f1(l4)}/g vs season ${f1(s)}`);
    else if (l4 < s * .75 && l4 < L * .85) flags.push(`${dfn} trending better vs ${who}: last 4 ${f1(l4)}/g vs season ${f1(s)}`);
  }
  if (flags.length) console.log('  FLAGS: ' + flags.join('\n         '));
}
// injury report (live)
try {
  const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/summary?event=${game.id}`), j = await r.json();
  for (const t of j.injuries || []) { const l = t.injuries.filter(i => !/Injured Reserve/.test(i.status)); if (l.length) console.log(`Injuries ${t.team.abbreviation}: ${l.map(i => `${i.athlete.displayName} (${i.athlete.position && i.athlete.position.abbreviation}) ${i.status}`).join('; ')}`); }
} catch { console.log('(injury report unavailable)'); }
