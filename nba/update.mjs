#!/usr/bin/env node
// Refreshes nba/data.json: NBA schedule + betting lines, box scores (incl. DNPs) and injury reports
// for upcoming games, from ESPN's public JSON. Incremental: only fetches box scores it doesn't have.
// Usage: node nba/update.mjs            (Node 18+)
//        node nba/update.mjs --full     (re-fetch everything)
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DATA = fileURLToPath(new URL('./data.json', import.meta.url));
const API = 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba';
// ESPN season year = the year the season ends (2026-27 season = 2027)
const SEASONS = { 2026: ['2025-10-20', '2026-04-14'], 2027: ['2026-10-19', '2027-04-12'] };
export const LOG_COLS = ['gid','date','season','pid','name','team','opp','home','pos','starter','dnp','min','pts','fgm','fga','tpm','tpa','ftm','fta','reb','oreb','ast','tov','stl','blk','pf'];

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = x => { const n = parseFloat(x); return isFinite(n) ? n : 0; };
async function getJSON(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (NBA projector data update)' } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
    await sleep(700 * (i + 1));
  }
  throw new Error('Failed to fetch ' + url);
}
async function pool(items, n, fn) {
  let i = 0; const out = [];
  async function w() { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { console.warn('warn:', e.message); } } }
  await Promise.all(Array.from({ length: n }, w)); return out;
}
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');
function oddsOf(o, home) { // {ou, hs}: total and home spread (negative = home favored), from "LAL -13.5" / "EVEN"
  if (!o) return null; const ou = num(o.overUnder) || null; let hs = null;
  const m = /^([A-Z]+)\s+(-?[\d.]+)/.exec(o.details || '');
  if (m) hs = m[1] === home ? +m[2] : -m[2]; else if (/even|pk/i.test(o.details || '')) hs = 0;
  return ou || hs != null ? { ou, hs } : null;
}
function gameFromEvent(e) {
  const c = e.competitions[0], h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away');
  const o = oddsOf((c.odds || [])[0], h.team.abbreviation);
  const g = { id: e.id, date: e.date, season: e.season.year, stype: e.season.type, home: h.team.abbreviation, away: a.team.abbreviation,
    hs: num(h.score), as: num(a.score), done: c.status.type.completed, state: c.status.type.name };
  if (o) g.odds = o;
  return g;
}
function parseBox(sum, g) {
  const rows = [];
  for (const tb of (sum.boxscore && sum.boxscore.players) || []) {
    const team = tb.team.abbreviation, home = team === g.home, opp = home ? g.away : g.home;
    const st = tb.statistics && tb.statistics[0]; if (!st) continue;
    const K = st.keys; const idx = k => K.indexOf(k);
    for (const a of st.athletes || []) {
      const base = { gid: g.id, date: g.date, season: g.season, pid: a.athlete.id, name: a.athlete.displayName, team, opp, home: home ? 1 : 0,
        pos: (a.athlete.position && a.athlete.position.abbreviation) || '', starter: a.starter ? 1 : 0 };
      if (a.didNotPlay || !a.stats || !a.stats.length) { rows.push({ ...base, dnp: a.reason || 'DNP' }); continue; }
      const s = a.stats, v = k => s[idx(k)];
      const pair = k => { const [m, t] = String(v(k) || '0-0').split('-'); return [num(m), num(t)]; };
      const [fgm, fga] = pair('fieldGoalsMade-fieldGoalsAttempted'), [tpm, tpa] = pair('threePointFieldGoalsMade-threePointFieldGoalsAttempted'), [ftm, fta] = pair('freeThrowsMade-freeThrowsAttempted');
      rows.push({ ...base, dnp: '', min: num(v('minutes')), pts: num(v('points')), fgm, fga, tpm, tpa, ftm, fta, reb: num(v('rebounds')), oreb: num(v('offensiveRebounds')),
        ast: num(v('assists')), tov: num(v('turnovers')), stl: num(v('steals')), blk: num(v('blocks')), pf: num(v('fouls')) });
    }
  }
  return rows;
}
function parseInjuries(sum) {
  const out = [];
  for (const t of sum.injuries || []) for (const i of t.injuries || [])
    out.push({ team: t.team.abbreviation, pid: i.athlete && i.athlete.id, name: i.athlete && i.athlete.displayName, pos: i.athlete && i.athlete.position && i.athlete.position.abbreviation,
      status: i.status, type: i.details && i.details.type, date: i.date });
  return out;
}

async function main() {
  const full = process.argv.includes('--full');
  let D = { v: 1, games: [], logs: { cols: LOG_COLS, rows: [] }, injuries: {}, updated: null };
  if (!full) try { D = JSON.parse(await readFile(DATA, 'utf8')); } catch {}
  const have = new Set(D.logs.rows.map(r => r[0]));
  const now = new Date();
  // 1) schedule, one scoreboard request per day (ESPN rejects date ranges for the NBA)
  const games = new Map(D.games.map(g => [g.id, g]));
  const days = [];
  for (const [season, [a, b]] of Object.entries(SEASONS)) {
    const end = new Date(Math.min(new Date(b + 'T12:00:00Z'), +now + 7 * 864e5));
    const known = new Set(D.games.filter(g => g.season === +season && g.done).map(g => g.date.slice(0, 10)));
    for (let d = new Date(a + 'T12:00:00Z'); d <= end; d = new Date(+d + 864e5)) {
      // days whose games are all final are skipped unless --full (ESPN dates are US-local; UTC dates can spill one day over)
      const k = d.toISOString().slice(0, 10), next = new Date(+d + 864e5).toISOString().slice(0, 10);
      if (!full && d < now - 2 * 864e5 && (known.has(k) || known.has(next))) continue;
      days.push(ymd(d));
    }
  }
  await pool(days, 8, async day => {
    const j = await getJSON(`${API}/scoreboard?dates=${day}`);
    for (const e of (j && j.events) || []) { if (e.season.type !== 2 && e.season.type !== 3) continue; const g = gameFromEvent(e); const old = games.get(g.id);
      if (old && old.odds && !g.odds) g.odds = old.odds; games.set(g.id, g); }
  });
  // 2) box scores for finished games we don't have yet; lines from pickcenter when the scoreboard had none
  const need = [...games.values()].filter(g => g.done && !have.has(g.id));
  console.log(`schedule: ${games.size} games; fetching ${need.length} box scores…`);
  let n = 0; const newRows = [];
  await pool(need, 8, async g => {
    const s = await getJSON(`${API}/summary?event=${g.id}`); if (!s) return;
    newRows.push(...parseBox(s, g));
    const pc = (s.pickcenter || [])[0]; if (pc && (!g.odds || g.odds.hs == null)) { const o = oddsOf(pc, g.home); if (o) g.odds = o; }
    if (++n % 200 === 0) console.log(`  ${n}/${need.length}`);
  });
  for (const r of newRows) D.logs.rows.push(LOG_COLS.map(c => r[c] ?? (c === 'dnp' ? '' : 0)));
  // 3) injury reports + lines for games in the next 3 days
  const soon = [...games.values()].filter(g => !g.done && new Date(g.date) - now < 3 * 864e5 && new Date(g.date) > now - 6 * 36e5);
  const inj = {};
  await pool(soon, 6, async g => {
    const s = await getJSON(`${API}/summary?event=${g.id}`); if (!s) return;
    for (const i of parseInjuries(s)) (inj[i.team] = inj[i.team] || []).push(i);
    const pc = (s.pickcenter || [])[0]; if (pc) { const o = oddsOf(pc, g.home); if (o) g.odds = o; }
  });
  for (const [t, l] of Object.entries(inj)) { const seen = new Set(); D.injuries[t] = l.filter(i => !seen.has(i.pid) && seen.add(i.pid)); }
  D.games = [...games.values()].sort((a, b) => a.date < b.date ? -1 : 1);
  D.logs.rows.sort((a, b) => a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);
  D.updated = now.toISOString();
  await writeFile(DATA, JSON.stringify(D));
  console.log(`nba/data.json: ${D.games.length} games, ${D.logs.rows.length} player rows (+${newRows.length}), injury reports for ${Object.keys(inj).length} teams.`);
}
if (import.meta.url === `file://${process.argv[1]}`) main().catch(e => { console.error(e); process.exit(1); });
