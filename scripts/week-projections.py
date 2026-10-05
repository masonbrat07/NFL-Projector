#!/usr/bin/env python3
"""Saves the site's projections for the next NFL week to projections/<season>-wk<NN>.json, so the
weekly review has a record of what was projected before the games were played.

It serves this repo locally, opens index.html in headless Chromium and calls the page's own
weekProjections(), so the numbers match what the site shows.
Usage: python3 scripts/week-projections.py [season week]   (needs: pip install playwright)
Default week: the earliest regular-season week that still has an unplayed game.
"""
import datetime, functools, glob, http.server, json, os, sys, threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATS = ["pass_att", "cmp", "pass_yds", "pass_td", "int", "rush_att", "rush_yds", "rush_td",
         "tgt", "rec", "rec_yds", "rec_td", "fd", "pp"]

# Runs in the page: every fantasy-relevant player plus the Over/Under picks for each stat
JS = """([season,week])=>{const W=weekProjections(season,week),r1=v=>Math.round(v*10)/10;
  const rows=W.rows.filter(P=>!P.backup&&(P.proj.fd>=4||(P.pos==='QB'&&P.proj.pass_att>=10)));
  const pick=P=>({name:P.name,pos:P.pos,team:P.team});
  return {season,week,games:W.games.map(g=>({id:g.id,date:g.date,away:g.away,home:g.home,spread_home:g.odds?g.odds.hs:null,total:g.odds?g.odds.ou:null})),
    players:rows.sort((a,b)=>b.proj.fd-a.proj.fd).map(P=>({pid:P.pid,name:P.name,pos:P.pos,team:P.team,opp:P.opp,home:P.home,status:P.status||null,
      news:P.adj?(P.adj.out?'out':P.adj.mult):null,normal_fd:r1(ouNormal(P)),proj:Object.fromEntries(%s.map(s=>[s,r1(P.proj[s]||0)]))})),
    ou:Object.fromEntries(Object.keys(OU_STATS).map(st=>{const L=ouLists(W.rows,'',st);
      return [st,{over:L.over.map(P=>({...pick(P),normal:+ouNormal(P,st).toFixed(2),proj:+ouVal(P.proj,st).toFixed(2)})),
                  under:L.under.map(P=>({...pick(P),normal:+ouNormal(P,st).toFixed(2),proj:+ouVal(P.proj,st).toFixed(2)}))}]}))}}""" % json.dumps(STATS)


def chromium_path():
    for p in sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"), reverse=True):
        return p
    return None


def main():
    from playwright.sync_api import sync_playwright

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), functools.partial(Quiet, directory=ROOT))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    with sync_playwright() as p:
        exe = chromium_path()
        browser = p.chromium.launch(**({"executable_path": exe} if exe else {}))
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(f"http://127.0.0.1:{srv.server_address[1]}/index.html")
        page.wait_for_function("typeof weekProjections==='function' && typeof WP!=='undefined' && WP && WP.rows.length>0", timeout=120000)
        if len(sys.argv) == 3:
            season, week = int(sys.argv[1]), int(sys.argv[2])
        else:
            nxt = page.evaluate("(()=>{const g=[...S.games.values()].filter(g=>g.stype===2&&!g.completed).sort((a,b)=>a.date<b.date?-1:1)[0];return g?[g.season,g.week]:null})()")
            if not nxt:
                sys.exit("No unplayed regular-season games in data.json; nothing to project.")
            season, week = nxt
        out = page.evaluate(JS, [season, week])
        browser.close()
    srv.shutdown()

    out = {"generated_at": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), **out}
    os.makedirs(os.path.join(ROOT, "projections"), exist_ok=True)
    path = os.path.join(ROOT, "projections", f"{season}-wk{week:02d}.json")
    with open(path, "w") as f:
        json.dump(out, f, indent=1)
    if not out["players"]:
        sys.exit(f"No projections built for {season} week {week}; is data.json up to date?")
    print(f"Projected {season} week {week}: {len(out['games'])} games, {len(out['players'])} players. Wrote {os.path.relpath(path, ROOT)}")
    for pos in ("QB", "RB", "WR", "TE"):
        top = [x for x in out["players"] if x["pos"] == pos][:5]
        print(f"  {pos}: " + ", ".join(f"{x['name']} ({x['team']}) {x['proj']['fd']}" for x in top))
    if errors:
        print("Page errors:", *errors, sep="\n  ")


if __name__ == "__main__":
    main()
