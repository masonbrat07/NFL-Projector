#!/usr/bin/env node
// Refreshes data.json for NFL Projector — the same snapshot format the web app loads on open.
// Mirrors the app's "Quick update": schedule + betting lines, new box scores, rosters, injury
// statuses, depth charts and game-time weather. Usage: node scripts/update-data.mjs  (Node 18+)
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const DATA = fileURLToPath(new URL('../data.json', import.meta.url));
const API = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const BASE = ['cmp','pass_att','pass_yds','pass_td','int','rush_att','rush_yds','rush_td','tgt','rec','rec_yds','rec_td','fum_lost'];
const PG_COLS = ['gid','pid','name','team','opp','home','season','week','date',...BASE];
const TEAMS = 'ARI,ATL,BAL,BUF,CAR,CHI,CIN,CLE,DAL,DEN,DET,GB,HOU,IND,JAX,KC,LV,LAC,LAR,MIA,MIN,NE,NO,NYG,NYJ,PHI,PIT,SF,SEA,TB,TEN,WSH'.split(',');
const INJ_STATUS = { 'Injured Reserve': 'IR', Out: 'OUT', Doubtful: 'Doubtful', Questionable: 'Questionable', Suspension: 'SUSP', Active: '' };
const STATE_NAME = { AL:'Alabama',AZ:'Arizona',CA:'California',CO:'Colorado',FL:'Florida',GA:'Georgia',IL:'Illinois',IN:'Indiana',LA:'Louisiana',MA:'Massachusetts',MD:'Maryland',MI:'Michigan',MN:'Minnesota',MO:'Missouri',NC:'North Carolina',NJ:'New Jersey',NV:'Nevada',NY:'New York',OH:'Ohio',PA:'Pennsylvania',TN:'Tennessee',TX:'Texas',WA:'Washington',WI:'Wisconsin',DC:'District of Columbia',KS:'Kansas',VA:'Virginia' };
const COUNTRY = { England:'GB','United Kingdom':'GB',Germany:'DE',Mexico:'MX',Brazil:'BR',Ireland:'IE',Spain:'ES',Australia:'AU',France:'FR',Canada:'CA' };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = x => { const n = parseFloat(x); return isFinite(n) ? n : 0; };
const round2 = x => typeof x === 'number' ? +x.toFixed(2) : x;

async function getJSON(url) {
  for (let i = 0; i < 4; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (NFL Projector data update)' } });
      if (r.ok) return await r.json();
      if (r.status === 404) return null;
    } catch {}
    await sleep(600 * (i + 1));
  }
  throw new Error('Failed to fetch ' + url);
}
async function pool(items, n, fn) {
  let i = 0; const out = [];
  async function w() { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch (e) { console.warn('warn:', e.message); } } }
  await Promise.all(Array.from({ length: n }, w)); return out;
}

function parseOdds(o) {
  if (!o) return null; const ou = num(o.overUnder) || null;
  if (o.spread == null || !isFinite(+o.spread)) return ou ? { ou, hs: null } : null;
  const sp = Math.abs(+o.spread), hf = o.homeTeamOdds && o.homeTeamOdds.favorite, af = o.awayTeamOdds && o.awayTeamOdds.favorite;
  return { ou, hs: hf ? -sp : af ? sp : +o.spread };
}
function gameFromEvent(e, season, week, old = {}) {
  const c = e.competitions[0], h = c.competitors.find(x => x.homeAway === 'home'), a = c.competitors.find(x => x.homeAway === 'away'), v = c.venue;
  return { ...old, id: e.id, season, week, stype: 2, date: e.date, home: h.team.abbreviation, away: a.team.abbreviation, hs: num(h.score), as: num(a.score),
    completed: !!(e.status && e.status.type && e.status.type.completed), odds: parseOdds(c.odds && c.odds[0]) || old.odds || null, boxed: old.boxed || false,
    venue: v ? { name: v.fullName, city: v.address && v.address.city, state: v.address && v.address.state, country: v.address && v.address.country, indoor: !!v.indoor } : old.venue || null };
}
function parseBox(sum, g) {
  const rows = {};
  for (const tp of (sum.boxscore && sum.boxscore.players) || []) {
    const team = tp.team.abbreviation, opp = team === g.home ? g.away : g.home;
    for (const cat of tp.statistics || []) {
      if (!['passing','rushing','receiving','fumbles'].includes(cat.name)) continue; const L = cat.labels || [];
      for (const a of cat.athletes || []) {
        const id = a.athlete.id, st = a.stats || [], v = lab => { const i = L.indexOf(lab); return i < 0 ? 0 : num(st[i]); };
        const r = rows[id] || (rows[id] = { gid: g.id, pid: id, name: a.athlete.displayName, team, opp, home: team === g.home ? 1 : 0, season: g.season, week: g.week, date: g.date, ...Object.fromEntries(BASE.map(s => [s, 0])) });
        if (cat.name === 'passing') { const ca = String(st[L.indexOf('C/ATT')] || '0/0').split('/'); r.cmp = num(ca[0]); r.pass_att = num(ca[1]); r.pass_yds = v('YDS'); r.pass_td = v('TD'); r.int = v('INT'); }
        else if (cat.name === 'rushing') { r.rush_att = v('CAR'); r.rush_yds = v('YDS'); r.rush_td = v('TD'); }
        else if (cat.name === 'receiving') { r.rec = v('REC'); r.rec_yds = v('YDS'); r.rec_td = v('TD'); r.tgt = v('TGTS'); }
        else r.fum_lost = v('LOST');
      }
    }
  }
  return Object.values(rows).filter(r => r.pass_att + r.rush_att + r.tgt + r.rec > 0);
}
// ESPN depth chart → {athleteId: {pos, n}}; WR: first name in each slot is a starter (WR1..WR3)
async function fetchDepth(teamId, season) {
  const j = await getJSON(`https://sports.core.api.espn.com/v2/sports/football/leagues/nfl/seasons/${season}/teams/${teamId}/depthcharts`);
  const off = j && (j.items || []).find(i => i.positions && i.positions.qb); if (!off) return {};
  const out = {}, id = a => (String(a.athlete && a.athlete.$ref || '').match(/athletes\/(\d+)/) || [])[1];
  for (const [k, P] of [['qb','QB'],['rb','RB'],['fb','RB'],['wr','WR'],['te','TE']]) {
    const L = (off.positions[k] || {}).athletes || [];
    if (P === 'WR') { const slots = [...new Set(L.map(a => a.slot))]; let n = 0;
      slots.map(s => L.find(a => a.slot === s)).forEach(a => { const i = id(a); if (i && !out[i]) out[i] = { pos: P, n: ++n }; });
      L.forEach(a => { const i = id(a); if (i && !out[i]) out[i] = { pos: P, n: ++n }; }); }
    else { let n = k === 'fb' ? 9 : 0; L.forEach(a => { const i = id(a); if (i && !out[i]) out[i] = { pos: P, n: ++n }; }); }
  }
  return out;
}
async function geocode(v, cache) {
  const key = [v.city, v.state, v.country].join('|'); if (cache[key]) return cache[key];
  const j = await getJSON(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(v.city)}&count=10`); const R = (j && j.results) || [];
  const cc = v.country === 'USA' || v.state ? 'US' : COUNTRY[v.country];
  const hit = R.find(r => r.country_code === cc && (!v.state || !STATE_NAME[v.state] || r.admin1 === STATE_NAME[v.state])) || R.find(r => r.country_code === cc) || R[0];
  if (!hit) return null; return (cache[key] = { lat: hit.latitude, lon: hit.longitude });
}
const hourKey = d => new Date(d).toISOString().slice(0, 13) + ':00';

async function main() {
  const snap = JSON.parse(await readFile(DATA, 'utf8'));
  const games = new Map(snap.games.map(g => [g.id, g]));
  const meta = snap.meta || {}; const have = new Set(snap.pg.rows.map(r => r[0] + '|' + r[1]));

  // current week + this season's schedule and lines
  const sb = await getJSON(`${API}/scoreboard`);
  const season = sb.season.year; meta.current = { season, week: sb.week && sb.week.number, stype: sb.season.type };
  const weeks = await pool([...Array(18).keys()].map(i => i + 1), 6, w => getJSON(`${API}/scoreboard?dates=${season}&seasontype=2&week=${w}`).then(j => ({ w, j })));
  for (const { w, j } of weeks.filter(Boolean)) for (const e of (j && j.events) || []) games.set(e.id, gameFromEvent(e, season, w, games.get(e.id)));

  // new box scores
  const need = [...games.values()].filter(g => g.completed && !g.boxed); let added = 0;
  await pool(need, 6, async g => {
    const sum = await getJSON(`${API}/summary?event=${g.id}`); if (!sum) return;
    const rows = parseBox(sum, g); if (!rows.length) return;
    for (const r of rows) { const k = r.gid + '|' + r.pid; if (have.has(k)) continue; have.add(k); snap.pg.rows.push(PG_COLS.map(c => round2(r[c]))); added++; }
    g.boxed = true; if (!g.odds) g.odds = parseOdds(sum.pickcenter && sum.pickcenter[0]);
  });

  // rosters, injury status, depth charts
  const stamp = Date.now(), players = [], depth = {};
  await pool(TEAMS, 4, async t => {
    const j = await getJSON(`${API}/teams/${t.toLowerCase()}/roster`); if (!j) return;
    for (const grp of j.athletes || []) for (const it of grp.items || []) {
      const inj = it.injuries && it.injuries[0];
      let status = grp.position === 'injuredReserveOrOut' ? 'OUT' : grp.position === 'suspended' ? 'SUSP' : (inj && inj.status) || '';
      if (/injured reserve/i.test(status)) status = 'IR';
      players.push({ id: it.id, name: it.fullName, pos: it.position && it.position.abbreviation, team: t, status, rosterAt: stamp });
    }
    if (j.team && j.team.id) Object.assign(depth, await fetchDepth(j.team.id, season).catch(() => ({})));
  });
  const byId = new Map(players.map(p => [p.id, p])); players.forEach(p => p.depth = depth[p.id] || null);
  const inj = await getJSON(`${API}/injuries`); let statusChanges = 0;
  for (const t of (inj && inj.injuries) || []) for (const e of t.injuries || []) {
    const pid = (String((((e.athlete || {}).links || [])[0] || {}).href || '').match(/id\/(\d+)/) || [])[1]; const p = pid && byId.get(pid);
    const st = INJ_STATUS[e.status] != null ? INJ_STATUS[e.status] : e.status; if (p && p.status !== st) { p.status = st; statusChanges++; }
  }
  if (players.length > 1500) { snap.players = players; meta.rosterAt = stamp; } // keep old rosters if ESPN returned a partial list

  // game-time weather (Open-Meteo)
  meta.geo = meta.geo || {}; const now = Date.now();
  const wxGames = [...games.values()].filter(g => g.venue && !(g.wx && g.wx.final));
  wxGames.filter(g => g.venue.indoor).forEach(g => g.wx = { indoor: true, final: true });
  const outdoor = wxGames.filter(g => !g.venue.indoor && new Date(g.date) - now < 15 * 864e5);
  const groups = new Map(); for (const g of outdoor) { const k = [g.venue.city, g.venue.state, g.venue.country].join('|'); (groups.get(k) || groups.set(k, []).get(k)).push(g); }
  const jobs = []; for (const gs of groups.values()) {
    const old = gs.filter(g => now - new Date(g.date) > 60 * 864e5), recent = gs.filter(g => now - new Date(g.date) <= 60 * 864e5);
    const bySeason = new Map(); old.forEach(g => (bySeason.get(g.season) || bySeason.set(g.season, []).get(g.season)).push(g));
    for (const s of bySeason.values()) jobs.push({ gs: s, archive: true }); if (recent.length) jobs.push({ gs: recent, archive: false });
  }
  await pool(jobs, 4, async job => {
    const loc = await geocode(job.gs[0].venue, meta.geo); if (!loc) return;
    const vars = 'hourly=temperature_2m,precipitation,wind_speed_10m&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC';
    let url; if (job.archive) { const ds = job.gs.map(g => g.date.slice(0, 10)).sort(); url = `https://archive-api.open-meteo.com/v1/archive?latitude=${loc.lat}&longitude=${loc.lon}&start_date=${ds[0]}&end_date=${ds[ds.length - 1]}&${vars}`; }
    else url = `https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&past_days=62&forecast_days=16&${vars}`;
    const j = await getJSON(url); if (!j || !j.hourly) return; const H = j.hourly, ix = new Map(H.time.map((t, i) => [t, i]));
    for (const g of job.gs) { const i0 = ix.get(hourKey(g.date)); if (i0 == null) continue; const I = [i0, i0 + 1, i0 + 2].filter(i => i < H.time.length);
      const avg = a => I.reduce((s, i) => s + (a[i] || 0), 0) / I.length;
      g.wx = { wind: avg(H.wind_speed_10m), precip: avg(H.precipitation), temp: avg(H.temperature_2m), final: g.completed && job.archive }; }
  });

  meta.lastSync = new Date().toISOString();
  snap.games = [...games.values()]; snap.meta = meta; snap.exportedAt = meta.lastSync;
  await writeFile(DATA, JSON.stringify(snap));
  console.log(`data.json updated: season ${season} week ${meta.current.week}, ${added} new player-game rows, ${snap.players.length} rostered players, ${statusChanges} injury status changes, ${snap.pg.rows.length} total rows.`);
}
main().catch(e => { console.error(e); process.exit(1); });
