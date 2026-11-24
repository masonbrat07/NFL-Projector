#!/usr/bin/env node
// Projects every NBA game on a US (Eastern) date and saves nba/projections/<date>.json.
// Out/Doubtful players on ESPN's injury report are treated as out; their minutes and usage go to teammates.
// Usage: node nba/project.mjs [YYYY-MM-DD]      (default: today in Eastern time)
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadData, projectGame, injuredOut } from './model.mjs';

export const etDate = iso => new Date(new Date(iso) - 5 * 36e5).toISOString().slice(0, 10);
export function projectDate(X, date) {
  const games = X.games.filter(g => etDate(g.date) === date && g.stype === 2 || etDate(g.date) === date && g.stype === 3);
  const inj = (pid, team) => (X.D.injuries[team] || []).find(i => i.pid === pid);
  return games.map(g => {
    const box = g.done ? new Set((X.byGame.get(g.id) || []).filter(r => !r.dnp && r.min > 0).map(r => r.pid)) : null;
    const rows = projectGame(X, g, (pid, team) => g.done ? !box.has(pid) : injuredOut(X.D, pid, team));
    for (const r of rows) { const i = inj(r.pid, r.team); r.status = i ? i.status + (i.type ? ' (' + i.type + ')' : '') : ''; }
    return { game: g, rows };
  });
}
const r1 = x => Math.round(x * 10) / 10;
if (import.meta.url === `file://${process.argv[1]}`) {
  const X = loadData(), date = process.argv[2] || etDate(new Date().toISOString());
  const out = projectDate(X, date);
  if (!out.length) { console.log('No NBA games on', date); process.exit(0); }
  const save = { date, generated_at: new Date().toISOString(), games: out.map(({ game: g, rows }) => ({ id: g.id, tip: g.date, away: g.away, home: g.home, spread_home: g.odds?.hs ?? null, total: g.odds?.ou ?? null,
    players: rows.filter(r => r.proj.min >= 8 || r.out).sort((a, b) => b.proj.pra - a.proj.pra).map(r => ({ pid: r.pid, name: r.name, team: r.team, pos: r.pos, out: r.out, status: r.status,
      proj: Object.fromEntries(['min', 'pts', 'reb', 'ast', 'tpm', 'stl', 'blk', 'tov', 'pra', 'pr', 'pa', 'ra'].map(s => [s, r1(r.proj[s])])) })) })) };
  const dir = fileURLToPath(new URL('./projections/', import.meta.url)); mkdirSync(dir, { recursive: true });
  writeFileSync(dir + date + '.json', JSON.stringify(save, null, 1));
  for (const g of save.games) {
    console.log(`\n${g.away} @ ${g.home}  ${new Date(g.tip).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' })} ET  spread(home) ${g.spread_home ?? '–'}  total ${g.total ?? '–'}`);
    for (const p of g.players) console.log(p.out ? `   OUT ${p.name} (${p.team}) ${p.status}` : `   ${p.name.padEnd(24)} ${p.team.padEnd(4)} ${String(p.proj.min).padStart(4)} min  ${String(p.proj.pts).padStart(4)} pts ${String(p.proj.reb).padStart(4)} reb ${String(p.proj.ast).padStart(4)} ast ${String(p.proj.tpm).padStart(3)} 3pm  PRA ${p.proj.pra}${p.status ? '  [' + p.status + ']' : ''}`);
  }
  console.log(`\nSaved nba/projections/${date}.json`);
}
