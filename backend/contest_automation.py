"""
Polygon contest automation via browser (Playwright).

Polygon exposes NO API for creating contests or adding problems to them
(contest.problems / contest.xml are read-only), so this drives the website
directly: log in → create a contest → add each problem by slug.

⚠️  The selectors below are best-effort and WILL need tuning against the live
    polygon.codeforces.com DOM. Run with headful=True to watch it and adjust.
    Everything is written with resilient text/role locators where possible so a
    minor markup change is less likely to break it.

Requires:  pip install playwright  &&  playwright install chromium
"""
from __future__ import annotations

import asyncio
from typing import Callable

POLYGON = "https://polygon.codeforces.com"

# A profile dir keeps cookies between runs so re-logins are rare.
import os
_PROFILE_DIR = os.path.join(os.path.dirname(__file__), ".pw-profile")


async def add_problems_to_contest(
    contest_name: str,
    slugs: list[str],
    login: str,
    password: str,
    headful: bool,
    log: Callable[[str, str], None],  # (message, status) → None
) -> dict:
    """
    Create a Polygon contest and add the given problem slugs to it.
    `log(message, status)` streams progress; status ∈ pending|running|done|error.
    Returns {"ok": bool, "added": [...], "failed": [...], "contest_url": str|None}.
    """
    try:
        from playwright.async_api import async_playwright
    except ImportError:
        log("Playwright is not installed. Run: pip install playwright && playwright install chromium", "error")
        return {"ok": False, "error": "playwright-missing"}

    added: list[str] = []
    failed: list[str] = []
    contest_url: str | None = None

    async with async_playwright() as p:
        # Persistent context so a manual login (headful) or stored cookies survive.
        ctx = await p.chromium.launch_persistent_context(
            _PROFILE_DIR, headless=not headful, args=["--start-maximized"]
        )
        page = ctx.pages[0] if ctx.pages else await ctx.new_page()
        try:
            # ── 1. Ensure logged in ────────────────────────────────────────────
            log("Opening Polygon…", "running")
            await page.goto(f"{POLYGON}/login", wait_until="domcontentloaded")

            # If a login form is present, fill it. If cookies already authenticate
            # us, Polygon redirects away from /login and these locators won't match.
            login_field = page.locator("input[name='login'], input#login, input[name='handleOrEmail']")
            if await login_field.count() > 0 and await login_field.first.is_visible():
                log("Logging in…", "running")
                await login_field.first.fill(login)
                await page.locator("input[type='password']").first.fill(password)
                await page.get_by_role("button", name="Login").first.click()
                await page.wait_for_load_state("networkidle")

            # Heuristic auth check: the login form should be gone.
            if await page.locator("input[type='password']").count() > 0 and await page.locator("input[type='password']").first.is_visible():
                log("Login failed — check your Codeforces credentials (or log in manually with headful on).", "error")
                return {"ok": False, "error": "login-failed"}
            log("Authenticated", "done")

            # ── 2. Create the contest ──────────────────────────────────────────
            log(f"Creating contest \"{contest_name}\"…", "running")
            await page.goto(f"{POLYGON}/contests", wait_until="domcontentloaded")
            # "New contest" link/button.
            await page.get_by_role("link", name="New contest").first.click()
            await page.wait_for_load_state("domcontentloaded")
            # Contest name field (Polygon labels it "Name").
            await page.locator("input[name='name'], input#name").first.fill(contest_name)
            await page.get_by_role("button", name="Create").first.click()
            await page.wait_for_load_state("networkidle")
            contest_url = page.url
            log(f"Contest created: {contest_url}", "done")

            # ── 3. Add each problem by slug ────────────────────────────────────
            for i, slug in enumerate(slugs):
                log(f"Adding {slug} ({i + 1}/{len(slugs)})…", "running")
                try:
                    # Polygon's contest page has an "Add problem" box with a search
                    # input; type the slug, pick the match, confirm.
                    search = page.locator("input[name='problemName'], input[placeholder*='problem' i], input#addProblemName")
                    await search.first.fill(slug)
                    await page.wait_for_timeout(600)  # let the autocomplete populate
                    # Click the matching suggestion, else press Enter.
                    suggestion = page.get_by_text(slug, exact=True)
                    if await suggestion.count() > 0:
                        await suggestion.first.click()
                    else:
                        await search.first.press("Enter")
                    await page.get_by_role("button", name="Add").first.click()
                    await page.wait_for_load_state("networkidle")
                    added.append(slug)
                    log(f"Added {slug}", "done")
                except Exception as e:  # one problem failing shouldn't stop the rest
                    failed.append(slug)
                    log(f"Failed to add {slug}: {e}", "error")

            ok = len(failed) == 0
            log(f"Done — {len(added)} added, {len(failed)} failed", "done" if ok else "error")
            return {"ok": ok, "added": added, "failed": failed, "contest_url": contest_url}
        finally:
            # Leave the browser open a moment in headful so the user can inspect.
            if headful:
                await asyncio.sleep(2)
            await ctx.close()
