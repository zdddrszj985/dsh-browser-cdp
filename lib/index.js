// dsh-browser-cdp — DSH plugin (host side).
//
// Why this exists: DSH's built-in web_fetch goes through Node's undici, which
// only trusts Node's bundled CA set. If a local proxy / accelerator (Watt
// Toolkit, Steam++, Zscaler, corporate MITM, ...) maps a hostname to 127.0.0.1
// and terminates TLS with a private root CA, undici fails with
// UNABLE_TO_VERIFY_LEAF_SIGNATURE while a real browser is perfectly happy,
// because the browser reads the OS certificate store.
//
// So: spawn the user's own Chromium (Edge/Chrome), drive it over CDP, and hand
// back the fully rendered page. Zero npm dependencies — only node: builtins and
// the global fetch/WebSocket that ship with Node >= 20.
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const name = 'browser-cdp'
export const inject = ['tools']

const PORT = Number(process.env.DSH_BROWSER_CDP_PORT || 9333)
const HOST = '127.0.0.1'
const BASE = 'http://' + HOST + ':' + PORT
const HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const PROFILE_DIR = process.env.DSH_BROWSER_CDP_PROFILE || join(HOME, 'browser-cdp-profile')
const SHOT_DIR = process.env.DSH_BROWSER_CDP_SHOTS || join(HOME, 'browser-cdp-shots')

let proc = null
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function candidateBrowsers() {
  const list = []
  const explicit = process.env.DSH_BROWSER_PATH || process.env.BROWSER_PATH
  if (explicit) list.push(explicit)

  if (process.platform === 'win32') {
    list.push(
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    )
    const la = process.env.LOCALAPPDATA
    if (la) {
      list.push(
        join(la, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        join(la, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      )
    }
  } else if (process.platform === 'darwin') {
    list.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    )
  } else {
    list.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
      '/usr/bin/microsoft-edge',
      '/opt/google/chrome/chrome',
    )
  }
  return list
}

function findBrowser() {
  for (const path of candidateBrowsers()) {
    if (path && existsSync(path)) return path
  }
  return null
}

async function devtoolsInfo() {
  try {
    const res = await fetch(BASE + '/json/version')
    if (!res.ok) return null
    return await res.json()
  } catch {
    return null
  }
}

async function ensureBrowser(headful) {
  const alive = await devtoolsInfo()
  if (alive) return alive

  const exe = findBrowser()
  if (!exe) {
    throw new Error(
      'No Chromium-based browser found (Edge / Chrome / Chromium). ' +
        'Set DSH_BROWSER_PATH to the executable and try again.',
    )
  }
  mkdirSync(PROFILE_DIR, { recursive: true })
  const args = [
    '--remote-debugging-port=' + PORT,
    '--remote-debugging-address=' + HOST,
    '--user-data-dir=' + PROFILE_DIR,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate,msEdgeTranslate',
    '--disable-blink-features=AutomationControlled',
    headful ? '--start-maximized' : '--headless=new',
    'about:blank',
  ]
  const child = spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: !headful })
  child.unref()
  proc = child

  for (let i = 0; i < 150; i++) {
    await sleep(200)
    const info = await devtoolsInfo()
    if (info) return info
  }
  throw new Error('The browser started but never exposed its debugging port on ' + BASE)
}

async function shutdown() {
  const info = await devtoolsInfo()
  if (info) {
    try { await fetch(BASE + '/json/close/all') } catch {}
  }
  if (proc && proc.pid) {
    try { process.kill(proc.pid) } catch {}
  }
  proc = null
}

async function createTab() {
  const res = await fetch(BASE + '/json/new?about:blank', { method: 'PUT' })
  if (!res.ok) throw new Error('Failed to open a new tab: HTTP ' + res.status)
  return await res.json()
}

async function closeTab(id) {
  try { await fetch(BASE + '/json/close/' + id) } catch {}
}

function connect(wsUrl, signal) {
  const ws = new WebSocket(wsUrl)
  let seq = 0
  const pending = new Map()
  const events = new Map()

  const opened = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve())
    ws.addEventListener('error', () => reject(new Error('Cannot connect to the browser debug socket')))
  })

  ws.addEventListener('message', (ev) => {
    let msg
    try { msg = JSON.parse(ev.data) } catch { return }
    if (msg.id && pending.has(msg.id)) {
      const p = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message))
      else p.resolve(msg.result)
      return
    }
    if (msg.method) {
      const listeners = events.get(msg.method) || []
      events.set(msg.method, [])
      for (const fn of listeners) fn(msg.params)
    }
  })

  if (signal) {
    signal.addEventListener('abort', () => { try { ws.close() } catch {} }, { once: true })
  }

  return {
    opened,
    send(method, params, timeoutMs) {
      const id = ++seq
      const budget = timeoutMs || 30000
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject })
        try {
          ws.send(JSON.stringify({ id, method, params: params || {} }))
        } catch (error) {
          pending.delete(id)
          reject(error)
          return
        }
        setTimeout(() => {
          if (pending.has(id)) {
            pending.delete(id)
            reject(new Error('Browser did not answer: ' + method))
          }
        }, budget)
      })
    },
    once(method, timeoutMs) {
      return new Promise((resolve) => {
        const listeners = events.get(method) || []
        const fn = (params) => {
          const i = listeners.indexOf(fn)
          if (i >= 0) listeners.splice(i, 1)
          resolve(params)
        }
        listeners.push(fn)
        events.set(method, listeners)
        setTimeout(() => resolve(null), timeoutMs)
      })
    },
    close() { try { ws.close() } catch {} },
  }
}

async function evaluate(c, expression) {
  const res = await c.send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true,
  })
  if (res.exceptionDetails) {
    throw new Error('Page script threw: ' + (res.exceptionDetails.text || 'unknown error'))
  }
  return res.result ? res.result.value : undefined
}

async function openPage(opts, signal) {
  const started = Date.now()
  const info = await ensureBrowser(opts.headful)
  const tab = await createTab()
  const c = connect(tab.webSocketDebuggerUrl, signal)

  try {
    await c.opened
    await c.send('Page.enable')
    await c.send('Runtime.enable', {}, opts.timeoutMs)

    const loaded = c.once('Page.loadEventFired', opts.timeoutMs)
    const nav = await c.send('Page.navigate', { url: opts.url }, opts.timeoutMs)
    if (nav && nav.errorText) throw new Error('Navigation failed: ' + nav.errorText)
    await loaded
    await sleep(opts.settleMs)

    if (opts.waitForSelector) {
      const selector = JSON.stringify(opts.waitForSelector)
      const deadline = Date.now() + opts.timeoutMs
      let found = false
      while (Date.now() < deadline) {
        found = await evaluate(c, '!!document.querySelector(' + selector + ')')
        if (found) break
        await sleep(200)
      }
      if (!found) throw new Error('Timed out waiting for selector: ' + opts.waitForSelector)
      await sleep(300)
    }

    if (opts.click) {
      const selector = JSON.stringify(opts.click)
      const expr =
        '(() => { const el = document.querySelector(' + selector + '); if (!el) return false; el.click(); return true })()'
      const clicked = await evaluate(c, expr)
      if (!clicked) throw new Error('Nothing to click for selector: ' + opts.click)
      await sleep(Math.max(opts.settleMs, 800))
    }

    let data = ''
    if (opts.evaluateJs) {
      const value = await evaluate(c, opts.evaluateJs)
      data = typeof value === 'string' ? value : JSON.stringify(value)
    }

    // innerText keeps growing while a SPA paints; wait until it stops changing.
    let text = ''
    let previous = -1
    for (let i = 0; i < 12; i++) {
      text = String((await evaluate(c, '(document.body ? document.body.innerText : "")')) || '')
      if (text.length === previous) break
      previous = text.length
      await sleep(350)
    }

    const meta = JSON.parse(
      String(await evaluate(c, 'JSON.stringify({ url: location.href, title: document.title })')),
    )

    let shotPath = ''
    if (opts.screenshot) {
      mkdirSync(SHOT_DIR, { recursive: true })
      const png = await c.send('Page.captureScreenshot', { format: 'png' }, opts.timeoutMs)
      shotPath = join(SHOT_DIR, 'shot-' + Date.now() + '.png')
      writeFileSync(shotPath, Buffer.from(png.data, 'base64'))
    }

    if (opts.html) {
      text = String((await evaluate(c, 'document.documentElement.outerHTML')) || '')
    }

    return {
      url: meta.url,
      title: meta.title,
      text,
      chars: text.length,
      data,
      screenshot: shotPath,
      browser: String(info.Browser || ''),
      elapsedMs: Date.now() - started,
    }
  } finally {
    if (!opts.keepOpen) await closeTab(tab.id)
    c.close()
  }
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'browser_open',
    description:
      'Open a URL in a real local Chromium browser (Edge/Chrome) over CDP and return the rendered page text. ' +
      'Use it when the built-in web_fetch fails (certificate interception, 403 from a non-browser user agent, ' +
      'JavaScript-only pages) or when a page has to be seen rather than parsed. Supports waiting for a selector, ' +
      'clicking an element, running page JS, and screenshots.',
    timeoutMs: 180000,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        url: { type: 'string', description: 'Absolute http(s) URL to open.' },
        waitForSelector: { type: 'string', description: 'CSS selector to wait for before extracting.' },
        click: { type: 'string', description: 'CSS selector to click after load, then re-settle.' },
        evaluate: { type: 'string', description: 'JavaScript expression to run in the page; its value is returned as a JSON string in data.' },
        settleMs: { type: 'integer', description: 'Extra settle time after load, milliseconds. Default 1200.' },
        timeoutMs: { type: 'integer', description: 'Navigation and per-call budget in milliseconds. Default 30000.' },
        headful: { type: 'boolean', description: 'Show a visible browser window instead of running headless.' },
        keepOpen: { type: 'boolean', description: 'Leave the tab open after extraction.' },
        screenshot: { type: 'boolean', description: 'Capture a PNG screenshot and return its path.' },
        html: { type: 'boolean', description: 'Return outer HTML instead of visible text.' },
        close: { type: 'boolean', description: 'Shut the shared browser instance down instead of opening a page.' },
      },
      required: ['url'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          url: { type: 'string' },
          title: { type: 'string' },
          text: { type: 'string' },
          chars: { type: 'integer' },
          data: { type: 'string' },
          screenshot: { type: 'string' },
          browser: { type: 'string' },
          elapsedMs: { type: 'integer' },
        },
        required: ['url', 'title', 'text', 'chars', 'data', 'screenshot', 'browser', 'elapsedMs'],
      },
      render(_args, value) {
        const head =
          '[' + value.browser + '] ' + value.title + '\n' +
          value.url + '  (' + value.chars + ' chars, ' + value.elapsedMs + 'ms)'
        const shot = value.screenshot ? '\nscreenshot: ' + value.screenshot : ''
        const data = value.data ? '\nscript result: ' + String(value.data).slice(0, 2000) : ''
        const body = String(value.text || '').slice(0, 60000)
        return [{ type: 'text', text: head + shot + data + '\n----- page text -----\n' + body }]
      },
    },
    async execute(args, exec) {
      if (args.close) {
        await shutdown()
        return {
          url: '', title: '', text: 'Browser closed.', chars: 15, data: '', screenshot: '', browser: '', elapsedMs: 0,
        }
      }
      return openPage(
        {
          url: args.url,
          waitForSelector: args.waitForSelector,
          click: args.click,
          evaluateJs: args.evaluate,
          settleMs: args.settleMs === undefined ? 1200 : args.settleMs,
          timeoutMs: args.timeoutMs === undefined ? 30000 : args.timeoutMs,
          headful: args.headful === true,
          keepOpen: args.keepOpen === true,
          screenshot: args.screenshot === true,
          html: args.html === true,
        },
        exec && exec.signal,
      )
    },
  })

  return () => { void shutdown() }
}
