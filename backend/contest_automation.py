"""
Polygon contest automation via browser (Playwright).

Polygon exposes NO API for creating contests or adding problems to them
(contest.problems / contest.xml are read-only), so this drives the website:
list contests, create a contest, and add problems to a contest by slug.

⚠️  The selectors below are best-effort and WILL need tuning against the live
    polygon.codeforces.com DOM. Run with headful=True to watch and adjust.
    Login to Polygon is your Codeforces account (Polygon uses CF SSO).

Requires:  pip install playwright  &&  playwright install chromium
"""
from __future__ import annotations

import asyncio
import os
import re
import sys
import time
from contextlib import asynccontextmanager
from typing import Callable

POLYGON = "https://polygon.codeforces.com"
_PROFILE_DIR = os.path.join(os.path.dirname(__file__), ".pw-profile")

# How long to wait for the human to finish logging in + pass Cloudflare's
# "Verify you are human" check in the headful window. The persistent profile
# then remembers the session, so this cost is paid at most once per session.
LOGIN_WAIT_SECONDS = 300

Logger = Callable[[str, str], None]  # (message, status) → None


def _import_pw():
    try:
        from playwright.async_api import async_playwright
        return async_playwright
    except ImportError:
        return None


def run_sync(coro_factory: Callable):
    """Run an async Playwright coroutine on a subprocess-capable event loop.

    Playwright launches the browser via asyncio subprocesses. On Windows,
    uvicorn installs the Selector event loop, which CANNOT spawn subprocesses
    (raises NotImplementedError) — so awaiting Playwright directly on the
    server's loop crashes with a 500 before any browser opens. We instead run
    the coroutine on a freshly-created ProactorEventLoop.

    MUST be called from a worker thread with no running loop (e.g. via FastAPI's
    run_in_threadpool), never on the server's event loop. `coro_factory` is a
    zero-arg callable returning the coroutine, so it's created on this loop.
    """
    if sys.platform == "win32":
        loop = asyncio.ProactorEventLoop()
    else:
        loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    try:
        return loop.run_until_complete(coro_factory())
    finally:
        loop.close()
        asyncio.set_event_loop(None)


@asynccontextmanager
async def _browser(headful: bool):
    async_playwright = _import_pw()
    if async_playwright is None:
        raise RuntimeError("playwright-missing")
    async with async_playwright() as p:
        # Persistent context so a manual login (headful) survives between runs.
        ctx = await p.chromium.launch_persistent_context(
            _PROFILE_DIR, headless=not headful, args=["--start-maximized"]
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            yield page
        finally:
            if headful:
                await asyncio.sleep(1.5)
            await ctx.close()


async def _is_logged_in(page) -> bool:
    """Best-effort check that a Polygon session is active on the current page."""
    try:
        url = page.url
        if "/login" in url:
            return False
        title = ((await page.title()) or "").lower()
        if "just a moment" in title or "attention required" in title:  # Cloudflare interstitial
            return False
        # A visible password field means a login form is showing → not authed.
        pw = page.locator("input[type='password']")
        if await pw.count() > 0 and await pw.first.is_visible():
            return False
        # Positive signals only present when authenticated on Polygon.
        if await page.locator("a[href*='logout'], a:has-text('Logout')").count() > 0:
            return True
        if await page.locator("a[href*='/problems'], a[href='/contests'], a[href*='new-problem']").count() > 0:
            return True
    except Exception:
        return False
    return False


async def _dump_controls(page, log: Logger) -> None:
    """Log the visible links/buttons so blind selectors can be tuned from logs."""
    try:
        items = await page.eval_on_selector_all(
            "a, button, input[type=submit], input[type=button]",
            """els => els
                .filter(e => e.offsetParent !== null)
                .map(e => (e.innerText || e.value || e.getAttribute('title') || '').replace(/\\s+/g,' ').trim())
                .filter(Boolean).slice(0, 40)""",
        )
        if items:
            log("Visible controls on this page: " + " | ".join(items), "running")
    except Exception:
        pass


async def _ensure_login(page, login: str, password: str, headful: bool, log: Logger) -> bool:
    """Ensure an authenticated Polygon session.

    We do NOT try to defeat Cloudflare's "Verify you are human" check — that's
    bot-detection and scripting it is both disallowed and unreliable. Instead,
    the persistent profile is reused: if it already has a valid session we go
    straight through; otherwise (headful only) the human logs in + passes the
    check once in the window while we poll for success.
    """
    log("Opening Polygon…", "running")
    await page.goto(f"{POLYGON}/contests", wait_until="domcontentloaded")
    if await _is_logged_in(page):
        log("Using saved Polygon session", "done")
        return True

    if not headful:
        log("No saved session and running headless. Re-run once with 'Show browser' ON, log in and pass the "
            "'Verify you are human' check — the session is then remembered for headless runs.", "error")
        return False

    # Best-effort pre-fill so you don't retype (you still submit + pass the check).
    try:
        handle = page.locator("input[name='handleOrEmail'], input[name='login'], input#login").first
        if login and await handle.count() > 0 and await handle.is_visible():
            await handle.fill(login)
            if password:
                pwf = page.locator("input[type='password']").first
                if await pwf.count() > 0 and await pwf.is_visible():
                    await pwf.fill(password)
    except Exception:
        pass

    log("Please log in and complete 'Verify you are human' in the browser window — "
        f"waiting up to {LOGIN_WAIT_SECONDS // 60} min…", "running")
    start = time.monotonic()
    while time.monotonic() - start < LOGIN_WAIT_SECONDS:
        if await _is_logged_in(page):
            log("Logged in — session saved for next time", "done")
            return True
        await page.wait_for_timeout(2000)
    log("Timed out waiting for manual login.", "error")
    return False


async def list_contests(login: str, password: str, headful: bool, log: Logger) -> dict:
    """Scrape the /contests page → [{id, name, url}]."""
    try:
        async with _browser(headful) as page:
            if not await _ensure_login(page, login, password, headful, log):
                return {"ok": False, "error": "login-failed"}
            log("Loading contests…", "running")
            await page.goto(f"{POLYGON}/contests", wait_until="networkidle")
            # Contest links look like /c/<id> or /contest/<id>; collect id + text.
            contests = await page.eval_on_selector_all(
                "a[href*='/c/'], a[href*='/contest/']",
                """els => els.map(a => {
                    const m = a.getAttribute('href').match(/\\/(?:c|contest)\\/(\\d+)/);
                    return m ? { id: m[1], name: (a.textContent || '').trim(), url: a.href } : null;
                }).filter(Boolean)"""
            )
            # De-dupe by id, keep the first non-empty name.
            seen: dict[str, dict] = {}
            for c in contests:
                if c["id"] not in seen or (not seen[c["id"]]["name"] and c["name"]):
                    seen[c["id"]] = c
            result = list(seen.values())
            log(f"Found {len(result)} contest(s)", "done")
            return {"ok": True, "contests": result}
    except RuntimeError as e:
        if str(e) == "playwright-missing":
            log("Playwright is not installed. Run: pip install playwright && playwright install chromium", "error")
            return {"ok": False, "error": "playwright-missing"}
        raise


async def create_contest(name: str, login: str, password: str, headful: bool, log: Logger) -> dict:
    """Create a new Polygon contest. Returns {ok, id, url}."""
    try:
        async with _browser(headful) as page:
            if not await _ensure_login(page, login, password, headful, log):
                return {"ok": False, "error": "login-failed"}
            log(f"Creating contest \"{name}\"…", "running")
            await page.goto(f"{POLYGON}/contests", wait_until="domcontentloaded")

            # Find the "New contest" control (link or button — selectors are best-effort).
            create_ctl = page.get_by_role("link", name=re.compile("new contest|create contest", re.I))
            if await create_ctl.count() == 0:
                create_ctl = page.get_by_role("button", name=re.compile("new contest|create contest", re.I))
            if await create_ctl.count() == 0:
                log("Couldn't find a 'New contest' control on the contests page.", "error")
                await _dump_controls(page, log)
                return {"ok": False, "error": "control-not-found"}
            await create_ctl.first.click()
            await page.wait_for_load_state("domcontentloaded")

            name_field = page.locator("input[name='name'], input#name, input[name='contestName']")
            if await name_field.count() == 0:
                log("Couldn't find the contest-name field on the new-contest form.", "error")
                await _dump_controls(page, log)
                return {"ok": False, "error": "name-field-not-found"}
            await name_field.first.fill(name)
            await page.get_by_role("button", name=re.compile("create|save|new", re.I)).first.click()
            await page.wait_for_load_state("networkidle")
            url = page.url
            m = re.search(r"/(?:c|contest)/(\d+)", url)
            cid = m.group(1) if m else None
            log(f"Contest created: {url}", "done")
            return {"ok": True, "id": cid, "url": url}
    except RuntimeError as e:
        if str(e) == "playwright-missing":
            log("Playwright is not installed. Run: pip install playwright && playwright install chromium", "error")
            return {"ok": False, "error": "playwright-missing"}
        raise


async def add_problems(contest_id: str, slugs: list[str], login: str, password: str, headful: bool, log: Logger) -> dict:
    """Add problems to an existing contest by slug. Returns {ok, added, failed}."""
    added: list[str] = []
    failed: list[str] = []
    try:
        async with _browser(headful) as page:
            if not await _ensure_login(page, login, password, headful, log):
                return {"ok": False, "error": "login-failed"}
            log(f"Opening contest {contest_id}…", "running")
            await page.goto(f"{POLYGON}/c/{contest_id}", wait_until="networkidle")

            search_sel = "input[name='problemName'], input[placeholder*='problem' i], input#addProblemName"
            if await page.locator(search_sel).count() == 0:
                log(f"Couldn't find the add-problem search box on contest {contest_id}.", "error")
                await _dump_controls(page, log)
                return {"ok": False, "error": "control-not-found", "added": added, "failed": slugs}

            for i, slug in enumerate(slugs):
                log(f"Adding {slug} ({i + 1}/{len(slugs)})…", "running")
                try:
                    search = page.locator(search_sel)
                    await search.first.fill(slug)
                    await page.wait_for_timeout(600)  # let autocomplete populate
                    suggestion = page.get_by_text(slug, exact=True)
                    if await suggestion.count() > 0:
                        await suggestion.first.click()
                    else:
                        await search.first.press("Enter")
                    await page.get_by_role("button", name=re.compile("^add", re.I)).first.click()
                    await page.wait_for_load_state("networkidle")
                    added.append(slug)
                    log(f"Added {slug}", "done")
                except Exception as e:
                    failed.append(slug)
                    log(f"Failed to add {slug}: {e}", "error")

            ok = len(failed) == 0
            log(f"Done — {len(added)} added, {len(failed)} failed", "done" if ok else "error")
            return {"ok": ok, "added": added, "failed": failed}
    except RuntimeError as e:
        if str(e) == "playwright-missing":
            log("Playwright is not installed. Run: pip install playwright && playwright install chromium", "error")
            return {"ok": False, "error": "playwright-missing"}
        raise
