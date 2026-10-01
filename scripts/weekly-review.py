#!/usr/bin/env python3
"""Scores the most recent finished NFL week with the site's own model and writes the numbers to
reviews/<season>-wk<NN>.json for the weekly review routine.

It serves this repo locally, opens index.html in headless Chromium and calls the page's
weekReview(season, week), so the review uses exactly the model the site runs.
Usage: python3 scripts/weekly-review.py [season week]   (needs: pip install playwright)
"""
import functools, glob, http.server, json, os, sys, threading

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def chromium_path():
    # use a preinstalled Chromium when Playwright's own download isn't available
    for p in sorted(glob.glob("/opt/pw-browsers/chromium-*/chrome-linux/chrome"), reverse=True):
        return p
    return None


def main():
    from playwright.sync_api import sync_playwright

    class Quiet(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a):
            pass

    handler = functools.partial(Quiet, directory=ROOT)
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    url = f"http://127.0.0.1:{srv.server_address[1]}/index.html"

    with sync_playwright() as p:
        exe = chromium_path()
        browser = p.chromium.launch(**({"executable_path": exe} if exe else {}))
        page = browser.new_page()
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        page.goto(url)
        # ready once the app has built this week's projections (its indexes exist by then)
        page.wait_for_function("typeof weekReview==='function' && typeof WP!=='undefined' && WP && WP.rows.length>0", timeout=120000)
        if len(sys.argv) == 3:
            season, week = int(sys.argv[1]), int(sys.argv[2])
        else:  # latest regular-season week with a finished game
            season, week = page.evaluate("reviewWeeks()[0]")
        review = page.evaluate(f"weekReview({season},{week})")
        browser.close()
    srv.shutdown()

    os.makedirs(os.path.join(ROOT, "reviews"), exist_ok=True)
    out = os.path.join(ROOT, "reviews", f"{season}-wk{week:02d}.json")
    with open(out, "w") as f:
        json.dump(review, f, indent=1)
    o, ou, m = review["overall"], review["ou"], review["markets"]
    if not o["n"]:
        sys.exit(f"No finished player games found for {season} week {week}; is data.json up to date?")
    print(f"Reviewed {season} week {week}: {o['n']} players, avg miss {o['mae']:.2f} pts "
          f"(normal game {o['normal_mae']:.2f}), bias {o['bias']:+.2f}, O/U picks {ou['hits']}/{ou['n']}, "
          + (f"model vs market Brier {m['model_brier']:.3f} vs {m['market_brier']:.3f} on {m['props']} lines"
             if m["props"] else "no market lines saved for this week")
          + f". Wrote {os.path.relpath(out, ROOT)}")
    if errors:
        print("Page errors:", *errors, sep="\n  ")


if __name__ == "__main__":
    main()
