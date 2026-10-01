#!/usr/bin/env node
// Pulls NFL prediction-market prices from Kalshi and Polymarket into markets.json, and keeps a
// pre-kickoff copy per week in markets/<season>-wk<NN>.json for the weekly review.
// Usage: node scripts/update-markets.mjs  (Node 18+). Prints a summary and any titles it couldn't read.
//
// markets.json format:
// { generated_at, season, week,
//   games: [{ source, home, away, kickoff, home_win, total, spread_home }],   // spread_home < 0 = home favored
//   props: [{ source, player, home, away, kickoff, stat, ladder: [{ line, p_over }] }] }
// Kalshi player ladders are "Player: N+ <stat>" contracts; N+ is stored as line N-0.5 with p_over = price.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const POLY = 'https://gamma-api.polymarket.com';
const TEAMS = 'ARI,ATL,BAL,BUF,CAR,CHI,CIN,CLE,DAL,DEN,DET,GB,HOU,IND,JAX,KC,LV,LAC,LAR,MIA,MIN,NE,NO,NYG,NYJ,PHI,PIT,SF,SEA,TB,TEN,WSH'.split(',');
const ALIAS = { JAC: 'JAX', WAS: 'WSH', LA: 'LAR', LVR: 'LV', ARZ: 'ARI', GNB: 'GB', KAN: 'KC', NWE: 'NE', NOR: 'NO', SFO: 'SF', TAM: 'TB' };
// Team names as they appear in market titles and outcomes
const NAMES = { ARI: ['Cardinals', 'Arizona'], ATL: ['Falcons', 'Atlanta'], BAL: ['Ravens', 'Baltimore'], BUF: ['Bills', 'Buffalo'],
  CAR: ['Panthers', 'Carolina'], CHI: ['Bears', 'Chicago'], CIN: ['Bengals', 'Cincinnati'], CLE: ['Browns', 'Cleveland'],
  DAL: ['Cowboys', 'Dallas'], DEN: ['Broncos', 'Denver'], DET: ['Lions', 'Detroit'], GB: ['Packers', 'Green Bay'],
  HOU: ['Texans', 'Houston'], IND: ['Colts', 'Indianapolis'], JAX: ['Jaguars', 'Jacksonville'], KC: ['Chiefs', 'Kansas City'],
  LV: ['Raiders', 'Las Vegas'], LAC: ['Chargers', 'Los Angeles C'], LAR: ['Rams', 'Los Angeles R'], MIA: ['Dolphins', 'Miami'],
  MIN: ['Vikings', 'Minnesota'], NE: ['Patriots', 'New England'], NO: ['Saints', 'New Orleans'], NYG: ['Giants', 'New York G'],
  NYJ: ['Jets', 'New York J'], PHI: ['Eagles', 'Philadelphia'], PIT: ['Steelers', 'Pittsburgh'], SF: ['49ers', 'San Francisco'],
  SEA: ['Seahawks', 'Seattle'], TB: ['Buccaneers', 'Tampa Bay'], TEN: ['Titans', 'Tennessee'], WSH: ['Commanders', 'Washington'] };
// Market wording -> the app's stat keys (order matters: specific before general)
const STAT_RE = [[/pass(ing)?\s*(yards|yds)/i, 'pass_yds'], [/pass(ing)?\s*(touchdowns|tds?)\b/i, 'pass_td'],
  [/pass(ing)?\s*attempts/i, 'pass_att'], [/(pass(ing)?\s*)?completions/i, 'cmp'], [/interceptions?\s*thrown/i, 'int'],
  [/rush(ing)?\s*(\+|and)\s*rec(eiving)?\s*(yards|yds)/i, 'rr_yds'], [/rush(ing)?\s*(yards|yds)/i, 'rush_yds'],
  [/rush(ing)?\s*attempts|carries/i, 'rush_att'], [/receiving\s*(yards|yds)/i, 'rec_yds'], [/receptions|catches/i, 'rec'],
  [/(anytime\s*)?(touchdowns?|tds?)\b/i, 'any_td']];
// Single-game sanity caps; anything above is a career/season market, not a weekly prop
const CAP = { pass_yds: 600, pass_td: 7, pass_att: 75, cmp: 50, int: 6, rr_yds: 350, rush_yds: 300, rush_att: 45, rec_yds: 300, rec: 20, any_td: 5 };

const sleep = ms => new Promise(r => setTimeout(r, ms));
const num = x => { const n = parseFloat(x); return isFinite(n) ? n : null; };
const round3 = x => Math.round(x * 1000) / 1000;
const unread = [];
async function getJSON(url) {
  for (let i = 0; i < 3; i++) {
    try { const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'Mozilla/5.0 (NFL Projector markets update)' } });
      if (r.ok) return await r.json(); if (r.status === 404) return null; if (r.status === 429) await sleep(2000); } catch {}
    await sleep(700 * (i + 1));
  }
  throw new Error('Failed to fetch ' + url);
}
const teamCode = c => { c = String(c || '').toUpperCase(); c = ALIAS[c] || c; return TEAMS.includes(c) ? c : null; };
function teamFromText(t) { t = String(t || ''); for (const [k, v] of Object.entries(NAMES)) if (v.some(n => t.includes(n))) return k; return null; }
// Ticker suffix like 26OCT04BUFKC -> [BUF, KC] (away, home); team codes are 2-3 letters, so try both splits
function teamsFromTicker(tk) {
  const m = String(tk).match(/\d{2}[A-Z]{3}\d{2}([A-Z]{4,6})(?:$|-)/); if (!m) return null; const s = m[1];
  for (let i = 2; i <= 3; i++) { const a = teamCode(s.slice(0, i)), h = teamCode(s.slice(i)); if (a && h) return [a, h]; }
  return null;
}
// Mid of the bid/ask when the market is tight; otherwise the last trade. Handles both cent and dollar fields.
function kalshiPrice(m) {
  const d = (k) => m[k + '_dollars'] != null ? num(m[k + '_dollars']) : m[k] != null ? num(m[k]) / 100 : null;
  const bid = d('yes_bid'), ask = d('yes_ask'), last = d('last_price');
  if (bid != null && ask != null && ask > 0 && ask - bid <= .15) return (bid + ask) / 2;
  return last != null && last > 0 ? last : bid != null && ask != null && ask > 0 ? (bid + ask) / 2 : null;
}

/* ---------- Kalshi ---------- */
async function kalshi(games, props) {
  const sj = await getJSON(`${KALSHI}/series?category=Sports`);
  const series = (sj?.series || []).filter(s => /^KXNFL/.test(s.ticker) && !/CAREER|SEASON|MVP|DRAFT|AWARD|SB|SUPERBOWL|PLAYOFF|DIV|CONF|WINS|COACH/i.test(s.ticker));
  const counts = {};
  for (const s of series) {
    let cursor = '', events = [];
    do { const j = await getJSON(`${KALSHI}/events?series_ticker=${s.ticker}&status=open&with_nested_markets=true&limit=200${cursor ? '&cursor=' + cursor : ''}`);
      events = events.concat(j?.events || []); cursor = j?.cursor || ''; await sleep(150) } while (cursor);
    for (const ev of events) {
      if (/career|season/i.test(ev.title || '')) continue;
      const tm = teamsFromTicker(ev.event_ticker); if (!tm) { unread.push(`Kalshi event ${ev.event_ticker}: ${ev.title}`); continue; }
      const [away, home] = tm, kickoff = ev.strike_date || ev.markets?.[0]?.expected_expiration_time || null, mk = ev.markets || [];
      if (/GAME$/.test(s.ticker)) { // winner: one market per team
        const hm = mk.find(m => teamFromText(m.yes_sub_title || m.title) === home || m.ticker.endsWith('-' + home));
        const p = hm && kalshiPrice(hm); if (p != null) { games.push({ source: 'Kalshi', home, away, kickoff, home_win: round3(p) }); counts[s.ticker] = (counts[s.ticker] || 0) + 1 }
        continue }
      if (/TOTAL$/.test(s.ticker)) { // "Over N points" ladder -> line closest to 50%
        const lad = mk.map(m => ({ line: num(m.floor_strike), p: kalshiPrice(m) })).filter(x => x.line != null && x.p != null);
        const best = lad.sort((a, b) => Math.abs(a.p - .5) - Math.abs(b.p - .5))[0];
        if (best) { const g = games.find(g => g.source === 'Kalshi' && g.home === home && g.away === away); if (g) g.total = best.line; else games.push({ source: 'Kalshi', home, away, kickoff, total: best.line }); counts[s.ticker] = (counts[s.ticker] || 0) + 1 }
        continue }
      // player ladders: "Player: N+ <stat>"
      const byKey = new Map();
      for (const m of mk) {
        const title = m.title || m.yes_sub_title || '', mm = title.match(/^(.+?):\s*([\d,.]+)\+\s*(.+)$/);
        if (!mm) { if (!/TD$/.test(s.ticker)) unread.push(`Kalshi ${m.ticker}: ${title}`); continue }
        const stat = STAT_RE.find(([re]) => re.test(mm[3]))?.[1]; const n = num(mm[2].replace(/,/g, '')), p = kalshiPrice(m);
        if (!stat || n == null || p == null || n > CAP[stat]) { if (!stat) unread.push(`Kalshi ${m.ticker}: ${title}`); continue }
        const player = mm[1].trim(), key = player + '|' + stat;
        if (!byKey.has(key)) byKey.set(key, { source: 'Kalshi', player, home, away, kickoff, stat, ladder: [] });
        byKey.get(key).ladder.push({ line: n - .5, p_over: round3(p) });
      }
      for (const pr of byKey.values()) { pr.ladder.sort((a, b) => a.line - b.line); props.push(pr); counts[s.ticker] = (counts[s.ticker] || 0) + 1 }
    }
  }
  return counts;
}

/* ---------- Polymarket ---------- */
async function polymarket(games, props) {
  let events = [];
  for (let off = 0; off < 1000; off += 100) {
    const j = await getJSON(`${POLY}/events?tag_slug=nfl&closed=false&limit=100&offset=${off}`); if (!j?.length) break; events = events.concat(j); await sleep(150) }
  let n = 0;
  for (const ev of events) {
    const parts = String(ev.title || '').split(/\s+(?:vs\.?|@|at)\s+/i); if (parts.length !== 2) continue; // game events only
    const away = teamFromText(parts[0]), home = teamFromText(parts[1]); if (!away || !home) { unread.push(`Polymarket event: ${ev.title}`); continue }
    const g = { source: 'Polymarket', home, away, kickoff: ev.startTime || ev.endDate || null };
    for (const m of ev.markets || []) {
      let outs, prices; try { outs = JSON.parse(m.outcomes || '[]'); prices = JSON.parse(m.outcomePrices || '[]').map(Number) } catch { continue }
      const type = m.sportsMarketType || '';
      if (type === 'moneyline' || (!type && outs.length === 2 && outs.every(teamFromText))) {
        const i = outs.findIndex(o => teamFromText(o) === home); if (i >= 0 && isFinite(prices[i])) g.home_win = round3(prices[i]) }
      else if (type === 'totals' && m.line != null) { const i = outs.findIndex(o => /over/i.test(o)); if (i >= 0 && Math.abs(prices[i] - .5) < .2) g.total = num(m.line) }
      else if (type === 'spreads' && m.line != null) { const fav = teamFromText(outs[0]); if (fav && Math.abs(prices[0] - .5) < .2) g.spread_home = fav === home ? num(m.line) : -num(m.line) }
    }
    if (g.home_win != null || g.total != null) { games.push(g); n++ }
  }
  return { events: events.length, games: n };
}

/* ---------- main ---------- */
const data = JSON.parse(await readFile(ROOT + 'data.json', 'utf8'));
const cur = data.meta?.current || {}, season = cur.season, week = cur.week;
const games = [], props = [], report = [];
try { const c = await kalshi(games, props); report.push(`Kalshi: ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ') || 'no NFL markets found'}`) }
catch (e) { report.push('Kalshi failed: ' + e.message) }
try { const c = await polymarket(games, props); report.push(`Polymarket: ${c.games} games from ${c.events} events`) }
catch (e) { report.push('Polymarket failed: ' + e.message) }

// keep only this week's games (by matchup in data.json), so futures and next week's lines don't leak in
const wk = (data.games || []).filter(g => g.season === season && g.week === week && g.stype === 2);
const kick = new Map(wk.map(g => [g.away + '@' + g.home, g.date]));
const inWeek = x => kick.has(x.away + '@' + x.home);
const out = { generated_at: new Date().toISOString(), season, week, games: games.filter(inWeek), props: props.filter(inWeek) };
for (const x of [...out.games, ...out.props]) x.kickoff = kick.get(x.away + '@' + x.home);
await writeFile(ROOT + 'markets.json', JSON.stringify(out));

// weekly archive: refresh entries for games that haven't kicked off; keep the last pre-kickoff prices for the rest
await mkdir(ROOT + 'markets', { recursive: true });
const arcPath = `${ROOT}markets/${season}-wk${String(week).padStart(2, '0')}.json`;
let arc = { season, week, games: [], props: [] };
try { arc = JSON.parse(await readFile(arcPath, 'utf8')) } catch {}
const now = Date.now(), started = x => x.kickoff && new Date(x.kickoff).getTime() <= now;
arc.games = arc.games.filter(started).concat(out.games.filter(x => !started(x)));
arc.props = arc.props.filter(started).concat(out.props.filter(x => !started(x)));
arc.updated_at = out.generated_at;
await writeFile(arcPath, JSON.stringify(arc));

console.log(`Markets ${season} week ${week}: ${out.games.length} game prices, ${out.props.length} player ladders. ${report.join(' | ')}`);
if (unread.length) console.log(`Couldn't read ${unread.length} market titles, e.g.:\n  ` + [...new Set(unread)].slice(0, 12).join('\n  '));
