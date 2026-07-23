"""
Transparent activity log for the backend.

A thread-safe in-memory ring buffer of everything the backend does — proxied
Polygon calls and their outcomes, incoming HTTP requests, contest-automation
steps, and uncaught errors/tracebacks. Served as a live, human-readable page at
the backend root (http://localhost:8000/) that you can watch and copy straight
into a bug report.

Secrets are never stored here: callers pass already-sanitized messages (the
Polygon signing key/secret are filtered before logging), and the HTTP middleware
records only method/path/status — never request bodies (which carry credentials).
"""
from __future__ import annotations

import itertools
import logging
import platform
import threading
import time
import traceback

_LOCK = threading.Lock()
_BUFFER: "deque[dict]" = __import__("collections").deque(maxlen=4000)
_SEQ = itertools.count(1)
_START = time.time()

# level ∈ info | ok | warn | error | req | api | contest  (drives color on the page)


def record(level: str, category: str, message: str) -> None:
    """Append one entry (and echo to the console, preserving old behavior)."""
    entry = {
        "seq": next(_SEQ),
        "time": time.strftime("%H:%M:%S"),
        "level": level,
        "category": category,
        "message": message,
    }
    with _LOCK:
        _BUFFER.append(entry)


def snapshot(since: int = 0) -> list[dict]:
    with _LOCK:
        return [e for e in _BUFFER if e["seq"] > since]


def clear() -> None:
    with _LOCK:
        _BUFFER.clear()


def stats() -> dict:
    with _LOCK:
        buf = list(_BUFFER)
    return {
        "count": len(buf),
        "errors": sum(1 for e in buf if e["level"] in ("error", "warn")),
        "uptime_s": int(time.time() - _START),
        "last_seq": buf[-1]["seq"] if buf else 0,
    }


def as_text(entries: list[dict] | None = None) -> str:
    entries = entries if entries is not None else snapshot(0)
    return "\n".join(
        f"{e['time']} [{e['level'].upper():>5}] {e['category']}: {e['message']}" for e in entries
    )


def report_header(extra: dict | None = None) -> str:
    """A short context header for the copyable dump."""
    st = stats()
    lines = [
        "Polygon Middleman — backend activity log",
        f"platform: {platform.platform()}",
        f"uptime: {st['uptime_s']}s · entries: {st['count']} · errors/warnings: {st['errors']} · captured: {time.strftime('%Y-%m-%d %H:%M:%S')}",
    ]
    if extra:
        lines.append(" · ".join(f"{k}: {v}" for k, v in extra.items()))
    lines.append("-" * 60)
    return "\n".join(lines)


class BufferHandler(logging.Handler):
    """Route Python logging — especially uncaught-exception tracebacks emitted by
    uvicorn/Starlette — into the activity buffer so they show on the page."""

    def emit(self, rec: logging.LogRecord) -> None:
        try:
            msg = rec.getMessage()
            if rec.exc_info:
                msg = (msg + "\n" + "".join(traceback.format_exception(*rec.exc_info))).rstrip()
            level = "error" if rec.levelno >= logging.ERROR else "warn" if rec.levelno >= logging.WARNING else "info"
            record(level, rec.name, msg)
        except Exception:
            pass


def install_logging() -> None:
    handler = BufferHandler(level=logging.WARNING)
    for name in ("", "uvicorn", "uvicorn.error"):
        logging.getLogger(name).addHandler(handler)


# ── The live page (self-contained; no external assets) ──────────────────────────

PAGE_HTML = r"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Polygon Middleman — Backend Log</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #17130f; color: #e8e2da; font: 13px/1.5 ui-monospace, "Cascadia Code", Consolas, monospace; }
  header { position: sticky; top: 0; background: #1a1714; border-bottom: 1px solid #362f28; padding: 10px 14px; z-index: 5; }
  .row1 { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .brand { font-weight: 700; color: #fff; letter-spacing: .3px; }
  .brand b { color: #f59e0b; }
  .pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; background: #2c2722; color: #b9b1a6; white-space: nowrap; }
  .pill.err { background: rgba(239,68,68,.15); color: #fca5a5; }
  .pill.ok  { background: rgba(34,197,94,.14); color: #86efac; }
  .spacer { flex: 1; }
  button, input[type=text] { font: inherit; }
  button { background: #2c2722; color: #e8e2da; border: 1px solid #40382f; border-radius: 7px; padding: 4px 10px; cursor: pointer; }
  button:hover { background: #372f28; border-color: #f59e0b55; }
  button.on { background: #f59e0b; color: #17130f; border-color: #f59e0b; font-weight: 600; }
  .row2 { display: flex; align-items: center; gap: 8px; margin-top: 8px; flex-wrap: wrap; }
  input[type=text] { flex: 1; min-width: 140px; background: #211e1a; color: #e8e2da; border: 1px solid #40382f; border-radius: 7px; padding: 4px 10px; }
  input[type=text]:focus { outline: none; border-color: #f59e0b; }
  #log { padding: 6px 0 40vh; }
  .e { display: flex; gap: 10px; padding: 1px 14px; white-space: pre-wrap; word-break: break-word; border-left: 3px solid transparent; }
  .e:hover { background: #1d1a16; }
  .e .t { color: #6b6157; flex-shrink: 0; }
  .e .c { color: #8a8073; flex-shrink: 0; min-width: 130px; }
  .e .m { flex: 1; }
  .e.error { border-left-color: #ef4444; } .e.error .m { color: #fca5a5; }
  .e.warn  { border-left-color: #eab308; } .e.warn .m  { color: #fde68a; }
  .e.ok    .m { color: #86efac; }
  .e.api   .c { color: #f59e0b; }
  .e.req   .m { color: #9aa6b2; }
  .e.contest .c { color: #c084fc; }
  .e.server .m { color: #f59e0b; }
  .empty { color: #6b6157; padding: 24px 14px; }
  .hidden { display: none; }
  .flash { animation: fl .6s; } @keyframes fl { from { background: #f59e0b33; } to { background: transparent; } }
</style>
</head>
<body>
<header>
  <div class="row1">
    <span class="brand">Polygon <b>Middleman</b> · backend log</span>
    <span class="pill" id="p-status">connecting…</span>
    <span class="pill" id="p-uptime"></span>
    <span class="pill" id="p-count"></span>
    <span class="pill err hidden" id="p-errors"></span>
    <span class="spacer"></span>
    <button id="b-pause" title="Pause / resume live tail">⏸ Pause</button>
    <button id="b-copy" title="Copy the whole log (with a context header) for a bug report">⧉ Copy all</button>
    <button id="b-download" title="Download the log as a .txt">⭳ Download</button>
    <button id="b-clear" title="Clear the buffer">🗑 Clear</button>
  </div>
  <div class="row2">
    <button id="b-errors" title="Show only errors & warnings">Errors only</button>
    <button id="b-autoscroll" class="on" title="Auto-scroll to newest">Auto-scroll</button>
    <input id="filter" type="text" placeholder="filter text… (e.g. saveTest, FAILED, contest)">
    <span class="pill" id="p-cred"></span>
  </div>
</header>
<div id="log"><div class="empty" id="empty">Waiting for activity… trigger something in the app and it shows up here live.</div></div>

<script>
(function () {
  var log = document.getElementById('log');
  var empty = document.getElementById('empty');
  var lastSeq = 0, paused = false, errorsOnly = false, autoscroll = true, filterText = '';
  var esc = function (s) { var d = document.createElement('div'); d.textContent = s; return d.innerHTML; };

  function matches(e) {
    if (errorsOnly && e.level !== 'error' && e.level !== 'warn') return false;
    if (filterText) {
      var hay = (e.time + ' ' + e.level + ' ' + e.category + ' ' + e.message).toLowerCase();
      if (hay.indexOf(filterText) === -1) return false;
    }
    return true;
  }

  function addEntry(e) {
    var div = document.createElement('div');
    div.className = 'e ' + e.level;
    div.dataset.level = e.level;
    div.dataset.hay = (e.time + ' ' + e.level + ' ' + e.category + ' ' + e.message).toLowerCase();
    div.innerHTML = '<span class="t">' + e.time + '</span><span class="c">' + esc(e.category) + '</span><span class="m">' + esc(e.message) + '</span>';
    if (!matches(e)) div.classList.add('hidden');
    log.appendChild(div);
  }

  function applyFilter() {
    var kids = log.querySelectorAll('.e');
    for (var i = 0; i < kids.length; i++) {
      var el = kids[i];
      var ok = (!errorsOnly || el.dataset.level === 'error' || el.dataset.level === 'warn')
            && (!filterText || el.dataset.hay.indexOf(filterText) !== -1);
      el.classList.toggle('hidden', !ok);
    }
  }

  function setStatus(ok, s) {
    var p = document.getElementById('p-status');
    p.textContent = s; p.className = 'pill ' + (ok ? 'ok' : 'err');
  }

  function poll() {
    if (paused) return;
    fetch('/api/logs?since=' + lastSeq).then(function (r) { return r.json(); }).then(function (d) {
      setStatus(true, 'live');
      var s = d.server || {};
      document.getElementById('p-uptime').textContent = 'up ' + s.uptime_s + 's · v' + (s.version || '?');
      document.getElementById('p-count').textContent = (s.log_count || 0) + ' entries';
      var pe = document.getElementById('p-errors');
      if (s.error_count > 0) { pe.textContent = s.error_count + ' err/warn'; pe.classList.remove('hidden'); }
      else pe.classList.add('hidden');
      document.getElementById('p-cred').textContent =
        'API: ' + (s.credentials_set ? '✓' : '✗') + '  ·  CF login: ' + (s.cf_login_set ? '✓' : '✗');
      if (d.entries && d.entries.length) {
        if (empty) { empty.remove(); empty = null; }
        d.entries.forEach(function (e) { addEntry(e); lastSeq = e.seq; });
        if (autoscroll) window.scrollTo(0, document.body.scrollHeight);
      }
    }).catch(function () { setStatus(false, 'backend offline'); });
  }

  document.getElementById('b-pause').onclick = function () {
    paused = !paused; this.textContent = paused ? '▶ Resume' : '⏸ Pause'; this.classList.toggle('on', paused);
  };
  document.getElementById('b-errors').onclick = function () { errorsOnly = !errorsOnly; this.classList.toggle('on', errorsOnly); applyFilter(); };
  document.getElementById('b-autoscroll').onclick = function () { autoscroll = !autoscroll; this.classList.toggle('on', autoscroll); };
  document.getElementById('filter').oninput = function () { filterText = this.value.trim().toLowerCase(); applyFilter(); };
  document.getElementById('b-copy').onclick = function () {
    var btn = this;
    fetch('/api/logs.txt').then(function (r) { return r.text(); }).then(function (t) {
      navigator.clipboard.writeText(t).then(function () { btn.textContent = '✓ Copied'; setTimeout(function () { btn.textContent = '⧉ Copy all'; }, 1500); },
        function () { btn.textContent = '⚠ Copy failed'; setTimeout(function () { btn.textContent = '⧉ Copy all'; }, 1500); });
    });
  };
  document.getElementById('b-download').onclick = function () { window.location = '/api/logs.txt?download=1'; };
  document.getElementById('b-clear').onclick = function () {
    fetch('/api/logs/clear', { method: 'POST' }).then(function () {
      log.querySelectorAll('.e').forEach(function (n) { n.remove() }); lastSeq = 0;
    });
  };

  poll();
  setInterval(poll, 1000);
})();
</script>
</body>
</html>
"""
