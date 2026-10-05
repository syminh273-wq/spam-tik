const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell } = require('electron')
const path = require('path')
const fs = require('fs')
const { spawn } = require('child_process')
const CDP = require('chrome-remote-interface')
const WebSocket = require('ws')

const BACKEND_URL = process.env.BACKEND_URL || 'https://tiktok.sminh.id.vn'
const CDP_PORT = Number(process.env.CDP_PORT || 9222)
const USER_DATA_DIR = path.join(app.getPath('userData'), 'chrome-profile')
const TOKEN_FILE = path.join(app.getPath('userData'), 'agent-token.json')

let tray = null
let win = null
let chromeProc = null
let backendWs = null
let reconnectTimer = null
let tabsCache = []
let agentId = null
let agentToken = null

// ─── Token persistence ─────────────────────────────────────────────
function loadToken() {
  try {
    const raw = fs.readFileSync(TOKEN_FILE, 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}
function saveToken(id, token) {
  fs.writeFileSync(TOKEN_FILE, JSON.stringify({ id, token }))
  agentId = id
  agentToken = token
}

function logToUI(level, msg) {
  console.log(`[${level}] ${msg}`)
  if (win && !win.isDestroyed()) {
    win.webContents.send('log', { level, msg, ts: Date.now() })
  }
}

// ─── Chrome lifecycle ──────────────────────────────────────────────
function findChromePath() {
  const candidates = process.platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
    : process.platform === 'win32'
      ? ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
         'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe']
      : ['/usr/bin/google-chrome', '/usr/bin/chromium-browser', '/usr/bin/chromium']
  return candidates.find(p => fs.existsSync(p))
}

async function isCdpUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/version`)
    return res.ok
  } catch {
    return false
  }
}

async function startChrome() {
  if (await isCdpUp()) {
    logToUI('info', `Chrome debug already running on :${CDP_PORT}`)
    return
  }
  const chromePath = findChromePath()
  if (!chromePath) {
    logToUI('error', 'Không tìm thấy Chrome. Cài Chrome để dùng tool.')
    return
  }
  fs.mkdirSync(USER_DATA_DIR, { recursive: true })
  const args = [
    `--remote-debugging-port=${CDP_PORT}`,
    `--remote-debugging-address=127.0.0.1`,
    `--remote-allow-origins=*`,
    `--user-data-dir=${USER_DATA_DIR}`,
    '--no-first-run',
    '--no-default-browser-check',
    'about:blank',
  ]
  chromeProc = spawn(chromePath, args, { detached: true, stdio: 'ignore' })
  chromeProc.unref()
  logToUI('info', `Chrome started (pid ${chromeProc.pid})`)
  // wait for CDP
  for (let i = 0; i < 15; i++) {
    if (await isCdpUp()) return
    await new Promise(r => setTimeout(r, 500))
  }
  logToUI('error', 'Chrome failed to expose CDP after 7.5s')
}

// ─── Tab scanning ──────────────────────────────────────────────────
async function scanTabs() {
  try {
    const list = await CDP.List({ port: CDP_PORT })
    const tiktokHosts = ['tiktok.com', 'tiktokv.com', 'musical.ly']
    return list
      .filter(t => t.type === 'page' && tiktokHosts.some(h => t.url.toLowerCase().includes(h)))
      .filter(t => {
        const u = t.url.toLowerCase()
        // Only video pages — not photo (slide), /foryou, profile, etc.
        return u.includes('/video/')
      })
      .map(t => ({
        uid: t.id,
        url: t.url,
        title: t.title,
        active: t.webSocketDebuggerUrl ? true : false,
      }))
  } catch (e) {
    logToUI('error', `scanTabs failed: ${e.message}`)
    return []
  }
}

async function broadcastTabs() {
  tabsCache = await scanTabs()
  if (win && !win.isDestroyed()) {
    win.webContents.send('tabs', tabsCache)
  }
  // Push to backend over WS
  if (backendWs && backendWs.readyState === WebSocket.OPEN) {
    backendWs.send(JSON.stringify({ type: 'tabs', tabs: tabsCache }))
  }
}

// ─── Comment poster (runs in user Chrome via CDP) ──────────────────
async function postComment(tabUid, comment) {
  let client
  try {
    client = await CDP({ port: CDP_PORT })
    const { Runtime, Target, Input } = client

    let targetId = tabUid
    if (!targetId) {
      const tgts = await Target.getTargets()
      const page = tgts.targetInfos.find(t => t.type === 'page' && t.url.includes('tiktok.com'))
      targetId = page && page.targetId
    }

    let sessionId
    if (targetId) {
      try {
        const att = await Target.attachToTarget({ targetId, flatten: true })
        sessionId = att.sessionId
      } catch (e) {}
    }

    // Step 1: find the comment box + its x,y coordinates.
    const findScript = `
      (function(){
        var sels = [
          '[contenteditable="true"]',
          '[data-e2e="comment-input"]',
          'div[contenteditable][spellcheck]',
          'textarea[placeholder*="comment" i]',
          'div[aria-label*="comment" i][contenteditable]',
        ];
        var box = null;
        for (var s = 0; s < sels.length; s++) {
          var c = document.querySelectorAll(sels[s]);
          for (var i = 0; i < c.length; i++) {
            var r = c[i].getBoundingClientRect();
            if (r.width > 30 && r.height > 8 && r.top > window.innerHeight * 0.3 && r.top < window.innerHeight * 0.95) {
              box = c[i]; break;
            }
          }
          if (box) break;
        }
        if (!box) return JSON.stringify({ok:false,error:'comment box not found'});
        var rect = box.getBoundingClientRect();
        return JSON.stringify({ok:true, x: Math.round(rect.left + rect.width/2), y: Math.round(rect.top + rect.height/2)});
      })()
    `

    const findArgs = sessionId
      ? [{ expression: findScript, returnByValue: true }, sessionId]
      : [{ expression: findScript, returnByValue: true }]
    const findR = await Runtime.evaluate(...findArgs)
    const findRaw = findR && findR.result ? findR.result.value : null
    const findResult = typeof findRaw === 'string' ? JSON.parse(findRaw) : findRaw
    if (!findResult || !findResult.ok) {
      return { ok: false, error: findResult ? findResult.error : 'no-result' }
    }

    // Step 2: use CDP Input.dispatchMouseEvent to focus the comment box.
    // This routes through Chrome's input pipeline, giving the box real focus.
    // Note: this may briefly focus Chrome but it's required for Input.insertText
    // to target the right element.
    const inputOpts = sessionId ? { sessionId } : {}
    await Input.dispatchMouseEvent({ type: 'mousePressed', x: findResult.x, y: findResult.y, button: 'left', clickCount: 1, ...inputOpts })
    await Input.dispatchMouseEvent({ type: 'mouseReleased', x: findResult.x, y: findResult.y, button: 'left', clickCount: 1, ...inputOpts })
    await new Promise(r => setTimeout(r, 100))

    // Step 3: CDP Input.insertText inserts them through the OS-level input
    // pipeline. TikTok's React editor captures this and updates its state,
    // which enables the Post button.
    await Input.insertText({ text: comment, ...inputOpts })
    await new Promise(r => setTimeout(r, 300))

    // Step 4: try to click Post. If button is disabled, the text didn't
    // commit to React state. Fix: dispatch a synthetic InputEvent with
    // insertFromPaste inputType — Draft.js recognises this and updates.
    const clickScript = `
      (async function(){
        function findPostBtn() {
          var all = document.querySelectorAll('button');
          for (var i = 0; i < all.length; i++) {
            var b = all[i];
            var e2e = b.getAttribute('data-e2e') || '';
            var lbl = b.getAttribute('aria-label') || '';
            if ((e2e === 'comment-post' || /^post$/i.test(lbl)) && !b.disabled) {
              return b;
            }
          }
          return null;
        }
        var btn = findPostBtn();
        if (btn) { btn.click(); return 'click-post'; }

        // Button disabled — text didn't reach React. Try to commit by
        // dispatching InputEvent with insertFromPaste on the contenteditable.
        var box = null;
        var sels = [
          '[contenteditable="true"]',
          '[data-e2e="comment-input"]',
          'div[contenteditable][spellcheck]',
        ];
        for (var s = 0; s < sels.length; s++) {
          var c = document.querySelectorAll(sels[s]);
          for (var i = 0; i < c.length; i++) {
            box = c[i]; break;
          }
          if (box) break;
        }
        if (!box) return 'no-box';
        // Set text directly (Draft.js uses innerText, not value).
        box.innerText = ${JSON.stringify(comment)};
        // Fire input event with insertFromPaste — Draft.js recognises this.
        box.dispatchEvent(new InputEvent('input', {
          bubbles: true, cancelable: true,
          data: ${JSON.stringify(comment)}, inputType: 'insertFromPaste',
        }));
        await new Promise(r => setTimeout(r, 200));

        btn = findPostBtn();
        if (btn) { btn.click(); return 'click-post-after-commit'; }

        // Last resort: dispatch Enter.
        box.focus();
        box.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true,
        }));
        return 'enter';
      })()
    `
    const clickArgs = sessionId
      ? [{ expression: clickScript, returnByValue: true, awaitPromise: true }, sessionId]
      : [{ expression: clickScript, returnByValue: true, awaitPromise: true }]
    const clickR = await Runtime.evaluate(...clickArgs)
    const clickResult = clickR && clickR.result ? clickR.result.value : 'none'

    return { ok: true, comment, by: clickResult }
  } catch (e) {
    return { ok: false, error: e.message }
  } finally {
    if (client) await client.close()
  }
}


// ─── Spam loop ────────────────────────────────────────────────────
const _spamLoops = {}  // tabUid -> { stop: bool, counters: {...} }
const _spamStates = {} // tabUid -> latest state snapshot (for UI polling)

async function scrollToNextVideo(tabUid) {
  const client = await CDP({ port: CDP_PORT })
  try {
    const { Runtime, Target } = client
    let targetId = tabUid
    if (!targetId) {
      const tgts = await Target.getTargets()
      const page = tgts.targetInfos.find(t => t.type === 'page' && t.url.includes('tiktok.com'))
      targetId = page && page.targetId
    }
    let sessionId
    if (targetId) {
      try {
        const att = await Target.attachToTarget({ targetId, flatten: true })
        sessionId = att.sessionId
      } catch {}
    }

    const expr = `
      (function(){
        var path = location.pathname || '';
        // Strategy A: scroll an existing scrollable list (right-side feed).
        var all = document.querySelectorAll([
          'a[href*="/video/"]',
          'a[href^="/@"][href*="/video/"]',
          'div[data-e2e="recommend-list"] a',
          '[class*="DivVideoFeed"] a[href*="/video/"]',
        ].join(','));
        if (all.length < 2) {
          all = document.querySelectorAll('a[href]');
          var filtered = [];
          for (var i = 0; i < all.length; i++) {
            var h = all[i].getAttribute('href') || '';
            if (/\\/video\\//.test(h) || (h.indexOf('@') === 0 && h.indexOf('/video/') > -1)) filtered.push(all[i]);
          }
          all = filtered;
        }
        if (all.length >= 2) {
          function findScrollableAncestor(el) {
            var n = el;
            while (n && n !== document.body) {
              if (n.scrollHeight > n.clientHeight + 8) return n;
              n = n.parentElement;
            }
            return document.scrollingElement;
          }
          var target = findScrollableAncestor(all[1]);
          if (target) {
            var before = target.scrollTop;
            target.scrollTo({ top: target.scrollHeight, behavior: 'instant' });
            var after = target.scrollTop;
            if (after === before) {
              for (var i = 0; i < 10; i++) {
                target.scrollBy(0, 400);
                if (target.scrollTop !== after) { after = target.scrollTop; break; }
              }
            }
            if (after > before) return 'list-scroll ' + (after - before);
          }
        }

        // Strategy B: dispatch ArrowDown keydown on body — TikTok's in-feed
        // player (both /foryou and /video/) listens for it and advances.
        document.body.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowDown', code: 'ArrowDown',
          keyCode: 40, which: 40, bubbles: true,
        }));
        window.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'ArrowDown', code: 'ArrowDown',
          keyCode: 40, which: 40, bubbles: true,
        }));
        return 'arrowdown-dispatched';
      })()
    `
    const args = sessionId
      ? [{ expression: expr, returnByValue: true }, sessionId]
      : [{ expression: expr, returnByValue: true }]
    const r = await Runtime.evaluate(...args)
    logToUI('info', '↕ ' + (r.result.value || 'no-result'))

    // Otherwise (we're on a /video/<id> page). TikTok Desktop shows a vertical
    // sidebar with the next-video list. We scroll it programmatically. We
    // never call Page.navigate (which would steal focus to Chrome).
    try {
      const a = await Runtime.evaluate({
        expression: `
          (function(){
            // Find any element that contains multiple /video/ links — that's
            // the next-video sidebar.
            var all = document.querySelectorAll('a[href*="/video/"]');
            if (all.length < 2) return 'few-links ' + all.length;

            // Find the deepest common scrollable ancestor of the first 2 video links.
            function findScrollableAncestor(el) {
              var n = el;
              while (n && n !== document.body) {
                if (n.scrollHeight > n.clientHeight + 8) return n;
                n = n.parentElement;
              }
              return document.scrollingElement;
            }
            var target = findScrollableAncestor(all[1]);
            if (!target) return 'no-target';

            // TikTok uses IntersectionObserver; scrolling to bottom triggers it.
            var before = target.scrollTop;
            target.scrollTo({ top: target.scrollHeight, behavior: 'instant' });
            return 'scrolled-by=' + (target.scrollTop - before);
          })()
        `,
        returnByValue: true,
      }, sessionId)
      const ra = a.result.value
      logToUI('info', '↕ ' + ra)
    } catch (e) {
      logToUI('warn', `scroll-list failed: ${e.message}`)
    }

    // No navigate fallback — that would steal focus. Just bail.
  } finally {
    await client.close()
  }
}

function sleepCancellable(ms, isCancelled) {
  return new Promise(resolve => {
    const step = 200
    let elapsed = 0
    const tick = () => {
      if (isCancelled() || elapsed >= ms) return resolve()
      elapsed += step
      setTimeout(tick, step)
    }
    tick()
  })
}

async function startSpamLoop(tabUid, settings, requestId) {
  if (_spamLoops[tabUid] && !_spamLoops[tabUid]._done) {
    logToUI('warn', `Spam loop already running for ${tabUid}`)
    backendWs.send(JSON.stringify({ type: 'spam_ack', requestId, ok: false, error: 'already running' }))
    return
  }
  const templates = (settings.templates || []).filter(Boolean)
  if (templates.length === 0) {
    backendWs.send(JSON.stringify({ type: 'spam_ack', requestId, ok: false, error: 'no templates' }))
    return
  }
  const dwellMs = Math.max(1000, Number(settings.dwell_s || 3) * 1000)
  const cooldownMs = Math.max(500, Number(settings.cooldown_s || 8) * 1000)
  const maxComments = Math.max(1, Number(settings.max_comments || 0)) // 0 = unlimited
  const scrollAfterEach = settings.scroll_after_each !== false

  const counters = { sent: 0, failed: 0, started_at: new Date().toISOString() }
  const ctrl = { _done: false, stop: () => { ctrl._done = true } }
  _spamLoops[tabUid] = { ...counters, stop: ctrl.stop, _done: false }
  _spamStates[tabUid] = {
    is_running: true,
    started_at: counters.started_at,
    comments_sent: 0,
    comments_failed: 0,
    current_video: tabUid,
    last_comment: null,
    last_error: null,
    last_at: counters.started_at,
  }

  backendWs.send(JSON.stringify({
    type: 'spam_ack', requestId, ok: true,
    state: { is_running: true, started_at: counters.started_at, comments_sent: 0, comments_failed: 0 },
  }))
  logToUI('info', `Spam started on ${tabUid} (max=${maxComments || '∞'}, cooldown=${cooldownMs / 1000}s)`)

  ;(async () => {
    let i = 0
    while (!ctrl._done) {
      if (maxComments && counters.sent >= maxComments) break
      // Safety: bail if too many consecutive failures (likely wrong tab / no box).
      if (counters.failed >= 8 && counters.sent === 0) {
        logToUI('warn', `Aborting: ${counters.failed} fails, 0 successes — wrong tab?`)
        break
      }
      const text = templates[i % templates.length]
      i++
      const res = await postComment(tabUid, text)
      const now = new Date().toISOString()
      if (res.ok) {
        counters.sent++
        logToUI('info', `✓ #${counters.sent}  [${res.by || '?'}] ${text.slice(0, 30)} btns=${(res.btns || []).length}:${(res.btns || []).slice(0,15).map(b => (b.t||b.a||'?')+'/'+(b.cls||'').slice(0,10)).join('|')}`)
      } else {
        counters.failed++
        logToUI('warn', `✗ ${res.error || 'unknown'} — ${text.slice(0, 60)}`)
      }
      // report progress to backend
      const state = {
        is_running: !ctrl._done && (!maxComments || counters.sent < maxComments),
        comments_sent: counters.sent,
        comments_failed: counters.failed,
        last_comment: text,
        last_error: res.ok ? null : (res.error || 'unknown'),
        last_at: now,
        current_video: tabUid,
        started_at: counters.started_at,
      }
      _spamStates[tabUid] = state
      backendWs.send(JSON.stringify({
        type: 'spam_progress',
        tabUid,
        state,
      }))
      // wait dwell on this video, then (maybe) scroll
      await sleepCancellable(dwellMs, () => ctrl._done)
      if (ctrl._done) break
      if (scrollAfterEach) {
        try {
          await scrollToNextVideo(tabUid)
        } catch (e) {
          logToUI('warn', `scroll failed: ${e.message}`)
        }
      }
      // cooldown before next comment
      await sleepCancellable(cooldownMs, () => ctrl._done)
    }
    const final = {
      is_running: false,
      comments_sent: counters.sent,
      comments_failed: counters.failed,
      stopped_at: new Date().toISOString(),
    }
    _spamStates[tabUid] = { ...(_spamStates[tabUid] || {}), ...final }
    _spamLoops[tabUid] = { ..._spamLoops[tabUid], _done: true, ...final }
    backendWs.send(JSON.stringify({
      type: 'spam_progress', tabUid, state: final,
    }))
    logToUI('info', `Spam stopped on ${tabUid} — sent=${counters.sent} failed=${counters.failed}`)
  })().catch(e => logToUI('error', `spam loop crashed: ${e.message}`))
}

function stopSpamLoop(tabUid) {
  const loop = _spamLoops[tabUid]
  if (loop && loop.stop) loop.stop()
}


// ─── Browse-only loop (scroll videos, no comments) ──────────────
const _browseLoops = {}  // tabUid -> { _done, started_at }

async function startBrowseLoop(tabUid, intervalSec) {
  if (_browseLoops[tabUid] && !_browseLoops[tabUid]._done) {
    logToUI('warn', `Browse already running on ${tabUid}`)
    return
  }
  _browseLoops[tabUid] = { _done: false, started_at: new Date().toISOString() }
  logToUI('info', `Browse started on ${tabUid.slice(0, 12)} (every ${intervalSec}s)`)

  ;(async () => {
    while (!_browseLoops[tabUid]._done) {
      try {
        await scrollToNextVideo(tabUid)
        logToUI('info', `↻ scrolled on ${tabUid.slice(0, 12)}`)
      } catch (e) {
        logToUI('warn', `scroll failed: ${e.message}`)
      }
      // Sleep in 1s chunks so stop is responsive.
      for (let i = 0; i < intervalSec * 1000 && !_browseLoops[tabUid]._done; i += 1000) {
        await new Promise(r => setTimeout(r, 1000))
      }
    }
    _browseLoops[tabUid]._done = true
    logToUI('info', `Browse stopped on ${tabUid.slice(0, 12)}`)
  })().catch(e => logToUI('error', `browse loop crashed: ${e.message}`))
}

function stopBrowseLoop(tabUid) {
  const loop = _browseLoops[tabUid]
  if (loop) loop._done = true
}

// ─── Backend WebSocket ─────────────────────────────────────────────
function connectBackend() {
  if (!agentId || !agentToken) {
    logToUI('warn', 'Agent not registered yet')
    return
  }
  const wsUrl = BACKEND_URL.replace(/^http/, 'ws') + `/api/agent/ws?agent_id=${agentId}&token=${encodeURIComponent(agentToken)}`
  logToUI('info', `Connecting to backend: ${wsUrl.replace(/token=[^&]+/, 'token=***')}`)
  backendWs = new WebSocket(wsUrl, {
    // `simple_websocket` (used by flask-sock) does not implement
    // permessage-deflate. Disable it explicitly to avoid frame rejection.
    perMessageDeflate: false,
    headers: { 'Host': new URL(BACKEND_URL).host },
  })

  backendWs.on('open', () => {
    logToUI('info', 'Backend connected')
    broadcastTabs()
  })
  backendWs.on('message', async (data) => {
    let msg
    try { msg = JSON.parse(data) } catch { return }
    if (msg.type === 'scan') {
      await broadcastTabs()
    } else if (msg.type === 'comment' && msg.tabUid && msg.text) {
      const result = await postComment(msg.tabUid, msg.text)
      backendWs.send(JSON.stringify({
        type: 'comment_result',
        requestId: msg.requestId,
        ok: result.ok,
        error: result.error,
      }))
    } else if (msg.type === 'navigate' && msg.tabUid && msg.url) {
      try {
        const client = await CDP({ port: CDP_PORT })
        const { Page } = client
        await Page.navigate({ url: msg.url })
        await client.close()
        backendWs.send(JSON.stringify({ type: 'navigate_ok', requestId: msg.requestId }))
      } catch (e) {
        backendWs.send(JSON.stringify({ type: 'navigate_err', requestId: msg.requestId, error: e.message }))
      }
    } else if (msg.type === 'spam_start') {
      startSpamLoop(msg.tabUid, msg.settings || {}, msg.requestId)
    } else if (msg.type === 'spam_stop') {
      stopSpamLoop(msg.tabUid)
      if (msg.requestId) {
        backendWs.send(JSON.stringify({ type: 'spam_stopped', requestId: msg.requestId, tabUid: msg.tabUid }))
      }
    } else if (msg.type === 'spam_all') {
      // Backend telling us to spam on every /video/ tab. We mirror the
      // IPC handler used by the UI's "Spam All" button.
      const tabs = await scanTabs()
      let started = 0
      for (const t of tabs) {
        if (_spamLoops[t.uid] && !_spamLoops[t.uid]._done) continue
        startSpamLoop(t.uid, msg.settings || {}, null)
        started++
      }
      logToUI('info', `Spam All (from backend): started ${started} loop(s)`)
      if (msg.requestId) {
        backendWs.send(JSON.stringify({ type: 'spam_all_ack', requestId: msg.requestId, started }))
      }
    }
  })
  backendWs.on('unexpected-response', (req, res) => {
    // WS upgrade was rejected (e.g. 401). Re-register to get fresh token.
    logToUI('warn', `Backend rejected upgrade (HTTP ${res.statusCode}), re-registering...`)
    registerAgent().then(() => {
      setTimeout(connectBackend, 500)
    })
  })

  backendWs.on('error', (e) => {
    const msg = e.message || ''
    logToUI('error', `WS error: ${msg}`)
    // 401 from upgrade means stale token — re-register.
    if (msg.includes('401') || msg.includes('4401')) {
      logToUI('info', 'Token rejected by backend, re-registering...')
      // Clear cached token so registerAgent assigns a new agent_id
      try { fs.unlinkSync(TOKEN_FILE) } catch {}
      agentId = null
      agentToken = null
      registerAgent().then(() => {
        reconnectTimer = setTimeout(connectBackend, 1000)
      })
      return
    }
  })

  backendWs.on('unexpected-response', (req, res) => {
    // WS upgrade was rejected (e.g. 401). Re-register to get fresh token.
    logToUI('warn', `Backend rejected upgrade (HTTP ${res.statusCode}), re-registering...`)
    try { fs.unlinkSync(TOKEN_FILE) } catch {}
    agentId = null
    agentToken = null
    registerAgent().then(() => {
      setTimeout(connectBackend, 500)
    })
  })

  backendWs.on('close', (code, reason) => {
    logToUI('warn', `Backend disconnected (code=${code}), retry in 5s`)
    // 4401 = custom code we'll send on token failure
    if (code === 4401 || code === 1006) {
      logToUI('info', 'Token may be stale, re-registering...')
      registerAgent().then(() => {})
    }
    reconnectTimer = setTimeout(connectBackend, 5000)
  })
  backendWs.on('error', (e) => logToUI('error', `WS error: ${e.message}`))
}

async function registerAgent() {
  const saved = loadToken()
  if (saved) {
    agentId = saved.id
    agentToken = saved.token
  }
  try {
    const res = await fetch(`${BACKEND_URL}/api/agents/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: agentId,
        token: agentToken,
        hostname: require('os').hostname(),
        platform: process.platform,
        cdp_port: CDP_PORT,
      }),
    })
    const data = await res.json()
    if (data.ok && data.id && data.token) {
      saveToken(data.id, data.token)
      logToUI('info', `Registered as agent ${data.id}`)
    } else {
      logToUI('error', `Register failed: ${JSON.stringify(data)}`)
    }
  } catch (e) {
    logToUI('error', `Register HTTP failed: ${e.message}`)
  }
}

// ─── UI ────────────────────────────────────────────────────────────
function createWindow() {
  win = new BrowserWindow({
    width: 720,
    height: 540,
    title: 'TikTok Spam Agent',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  })
  win.loadFile(path.join(__dirname, 'renderer.html'))
  win.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault()
      win.hide()
    }
  })
}

function createTray() {
  const iconPath = path.join(__dirname, '..', 'assets', 'icon.png')
  const fallback = path.join(__dirname, 'default-icon.png')
  const icon = fs.existsSync(iconPath) ? iconPath : (fs.existsSync(fallback) ? fallback : undefined)
  // Use a minimal in-memory icon as final fallback (1x1 transparent PNG)
  if (!icon) {
    const buf = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    const { nativeImage } = require('electron')
    tray = new Tray(nativeImage.createFromBuffer(buf))
  } else {
    tray = new Tray(icon)
  }
  const menu = Menu.buildFromTemplate([
    { label: 'Mở cửa sổ', click: () => win.show() },
    { label: 'Quét lại tab', click: broadcastTabs },
    { label: 'Mở Chrome', click: startChrome },
    { type: 'separator' },
    { label: 'Thoát', click: () => { app.isQuitting = true; app.quit() } },
  ])
  tray.setToolTip('TikTok Spam Agent')
  tray.setContextMenu(menu)
  tray.on('click', () => win.show())
}

// ─── App lifecycle ─────────────────────────────────────────────────
app.whenReady().then(async () => {
  createWindow()
  try { createTray() } catch (e) { logToUI('error', `tray: ${e.message}`) }
  try { await startChrome() } catch (e) { logToUI('error', `chrome: ${e.message}`) }
  try { await registerAgent() } catch (e) { logToUI('error', `register: ${e.message}`) }
  try { connectBackend() } catch (e) { logToUI('error', `backend: ${e.message}`) }
  // Poll tabs every 5s
  setInterval(() => broadcastTabs().catch(e => logToUI('error', `poll: ${e.message}`)), 5000)
}).catch(e => logToUI('fatal', `app init: ${e.message}`))

app.on('window-all-closed', (e) => {
  // Keep running in tray on macOS
  if (process.platform !== 'darwin') app.quit()
})

// IPC from renderer
ipcMain.handle('scan', broadcastTabs)
ipcMain.handle('start-chrome', startChrome)
ipcMain.handle('get-state', () => ({
  agentId,
  agentToken: agentToken ? '***' : null,
  tabs: tabsCache,
  spamStates: { ..._spamStates },
}))

// Local spam control (UI on the agent app itself, no backend required).
ipcMain.handle('spam-start', async (_evt, { tabUid, settings }) => {
  if (!tabUid) return { ok: false, error: 'tab_uid required' }
  startSpamLoop(tabUid, settings || {}, null)
  return { ok: true }
})
ipcMain.handle('spam-stop', (_evt, { tabUid }) => {
  if (!tabUid) return { ok: false, error: 'tab_uid required' }
  stopSpamLoop(tabUid)
  return { ok: true }
})

// Browse-only: scroll videos in a loop without posting comments.
ipcMain.handle('browse-start', async (_evt, { tabUid, intervalSec }) => {
  if (!tabUid) return { ok: false, error: 'tab_uid required' }
  const sec = Math.max(2, Number(intervalSec) || 5)
  startBrowseLoop(tabUid, sec)
  return { ok: true }
})
ipcMain.handle('browse-stop', (_evt, { tabUid }) => {
  if (!tabUid) return { ok: false, error: 'tab_uid required' }
  stopBrowseLoop(tabUid)
  return { ok: true }
})

// Stop everything: all spam loops and all browse loops.
ipcMain.handle('stop-all', () => {
  let stopped = 0
  for (const uid of Object.keys(_spamLoops)) {
    stopSpamLoop(uid)
    stopped++
  }
  for (const uid of Object.keys(_browseLoops)) {
    stopBrowseLoop(uid)
    stopped++
  }
  logToUI('warn', `Stop All: terminated ${stopped} loop(s)`)
  return { ok: true, stopped }
})

// Spam All: start a spam loop on every tiktok /video/ tab in Chrome at once.
ipcMain.handle('spam-all', async (_evt, settings) => {
  const tabs = await scanTabs()
  if (tabs.length === 0) return { ok: false, error: 'no /video/ tabs found' }
  let started = 0
  for (const t of tabs) {
    if (_spamLoops[t.uid] && !_spamLoops[t.uid]._done) continue
    startSpamLoop(t.uid, settings || {}, null)
    started++
  }
  logToUI('info', `Spam All: started ${started} loop(s)`)
  return { ok: true, started }
})