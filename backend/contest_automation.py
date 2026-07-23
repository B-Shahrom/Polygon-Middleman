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
from contextlib import asynccontextmanager
from typing import Callable

POLYGON = "https://polygon.codeforces.com"
_PROFILE_DIR = os.path.join(os.path.dirname(__file__), ".pw-profile")

Logger = Callable[[str, str], None]  # (message, status) → None


def _import_pw():
    try:
        from playwright.async_api import async_playwright
        return async_playwright
    except ImportError:
        return None


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


async def _ensure_login(page, login: str, password: str, log: Logger) -> bool:
    """Log into Polygon if not already authenticated. Returns True on success."""
    log("Opening Polygon…", "running")
    await page.goto(f"{POLYGON}/login", wait_until="domcontentloaded")

    login_field = page.locator("input[name='login'], input#login, input[name='handleOrEmail']")
    if await login_field.count() > 0 and await login_field.first.is_visible():
        log("Logging in…", "running")
        await login_field.first.fill(login)
        await page.locator("input[type='password']").first.fill(password)
        await page.get_by_role("button", name=re.compile("login", re.I)).first.click()
        await page.wait_for_load_state("networkidle")

    pw_visible = await page.locator("input[type='password']").count() > 0 and await page.locator("input[type='password']").first.is_visible()
    if pw_visible:
        log("Login failed — check your Codeforces credentials (or log in manually with headful on).", "error")
        return False
    log("Authenticated", "done")
    return True


async def list_contests(login: str, password: str, headful: bool, log: Logger) -> dict:
    """Scrape the /contests page → [{id, name, url}]."""
    try:
        async with _browser(headful) as page:
            if not await _ensure_login(page, login, password, log):
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
            if not await _ensure_login(page, login, password, log):
                return {"ok": False, "error": "login-failed"}
            log(f"Creating contest \"{name}\"…", "running")
            await page.goto(f"{POLYGON}/contests", wait_until="domcontentloaded")
            await page.get_by_role("link", name=re.compile("new contest", re.I)).first.click()
            await page.wait_for_load_state("domcontentloaded")
            await page.locator("input[name='name'], input#name").first.fill(name)
            await page.get_by_role("button", name=re.compile("create", re.I)).first.click()
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
            if not await _ensure_login(page, login, password, log):
                return {"ok": False, "error": "login-failed"}
            log(f"Opening contest {contest_id}…", "running")
            await page.goto(f"{POLYGON}/c/{contest_id}", wait_until="networkidle")

            for i, slug in enumerate(slugs):
                log(f"Adding {slug} ({i + 1}/{len(slugs)})…", "running")
                try:
                    search = page.locator("input[name='problemName'], input[placeholder*='problem' i], input#addProblemName")
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
