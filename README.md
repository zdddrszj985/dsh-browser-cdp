# dsh-browser-cdp

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) plugin that registers one agent-facing tool, `browser_open`, and drives **your own local Chromium browser** (Edge / Chrome / Chromium) over the DevTools Protocol to fetch a page that the built-in fetcher cannot.

Zero npm dependencies — only `node:` builtins plus the `fetch` / `WebSocket` that ship with Node 20+.

[中文说明 →](./README.zh-CN.md)

---

## Why

DSH's built-in `web_fetch` goes through Node's `undici`, which trusts only Node's bundled CA set. Plenty of real-world machines sit behind something that terminates TLS and re-signs it with a private root CA:

- proxy accelerators such as **Watt Toolkit / Steam++** (they add `127.0.0.1 github.com` lines to `hosts` and serve TLS on `0.0.0.0:443`)
- corporate TLS inspection (Zscaler, Netskope, Palo Alto, …)
- local debugging proxies (mitmproxy, Charles)

In that situation the agent gets:

```
UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate
```

…while the browser on the same machine opens the very same URL just fine, because browsers read the **OS certificate store**. Swallowing that difference means the agent silently loses access to a large part of the web, and `NODE_EXTRA_CA_CERTS=root.cer` usually does not fix it either (the private CA is often installed without its intermediate).

`browser_open` sidesteps the whole problem: if the user's browser can open it, the agent can read it.

It also covers the two other common `web_fetch` failures:

- pages that need **JavaScript** (SPAs, lazy-loaded content, infinite scroll) — the plugin waits for `innerText` to stabilise
- sites that return **403 to a non-browser user agent**

## Install

Requires Node 20+ (for the global `WebSocket`), and Edge, Chrome, or Chromium on the machine.

### Official CLI

```bash
dsh plugin --profile desktop add github:zdddrszj985/dsh-browser-cdp
```

### Manual (works on any build, verified on DSH desktop / Windows)

1. Put the package somewhere stable, for example `%DSH_HOME%\plugins\dsh-browser-cdp`.
2. Add it to the profile manifest — `%DSH_HOME%\profiles\<profile>\package.json`:

   ```json
   {
     "dependencies": {
       "dsh-browser-cdp": "link:C:/Users/you/.dsh/plugins/dsh-browser-cdp"
     },
     "dsh": {
       "profile": {
         "bundles": ["...", "dsh-browser-cdp"]
       }
     }
   }
   ```

3. Make the package resolvable from the profile, e.g. a directory junction on Windows:

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:DSH_HOME\profiles\desktop\node_modules\dsh-browser-cdp" `
     -Target "$env:DSH_HOME\plugins\dsh-browser-cdp"
   ```

4. Restart DSH, or just wait — profile plugins are hot-loaded, and `browser_open` shows up in the agent's tool list.

To uninstall, drop the bundle from `bundles`, remove the dependency, and delete the junction.

## Usage

Once loaded, the agent can call `browser_open`:

```jsonc
{
  "url": "https://github.com/owner/repo/blob/main/README.md",
  "waitForSelector": "article.markdown-body",   // optional
  "screenshot": true                            // optional
}
```

Returns:

```jsonc
{
  "url": "https://example.com/",       // final URL after redirects
  "title": "Example Domain",
  "text": "Example Domain\nThis domain is for use ...",  // visible innerText
  "chars": 129,
  "data": "",                          // value of the evaluate expression
  "screenshot": "C:\\Users\\you\\.dsh\\browser-cdp-shots\\shot-1712.png",
  "browser": "Edg/157.0.4341.60",
  "elapsedMs": 3115
}
```

### Parameters

| Parameter | Type | Default | Meaning |
|---|---|---|---|
| `url` | string | — (required) | Absolute `http(s)` URL |
| `waitForSelector` | string | — | Wait until this CSS selector matches before extracting |
| `click` | string | — | Click this element after load, then re-settle |
| `evaluate` | string | — | JS expression evaluated in the page; value returned as `data` |
| `settleMs` | integer | `1200` | Extra wait after `load` before extracting |
| `timeoutMs` | integer | `30000` | Navigation budget and per-CDP-call budget |
| `html` | boolean | `false` | Return `outerHTML` instead of visible text |
| `screenshot` | boolean | `false` | Save a PNG and return its path |
| `headful` | boolean | `false` | Show a real window (needed to log in by hand) |
| `keepOpen` | boolean | `false` | Leave the tab open afterwards |
| `close` | boolean | `false` | Shut the shared browser instance down |

### Configuration

All optional, via environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `DSH_BROWSER_PATH` | auto-detected | Path to `msedge.exe` / `chrome.exe` / chromium binary (also accepts `BROWSER_PATH`) |
| `DSH_BROWSER_CDP_PORT` | `9333` | DevTools port |
| `DSH_BROWSER_CDP_PROFILE` | `$DSH_HOME/browser-cdp-profile` | Browser user-data dir |
| `DSH_BROWSER_CDP_SHOTS` | `$DSH_HOME/browser-cdp-shots` | Screenshot output dir |
| `DSH_HOME` | `~/.dsh` | Base dir for the two above |

Auto-detection looks at the standard install locations for Edge and Chrome on Windows, macOS, and Linux (including `LOCALAPPDATA` installs, `/snap/bin/chromium`, `/opt/google/chrome/chrome`).

## How it works

1. Reuse a running instance if `http://127.0.0.1:PORT/json/version` answers, otherwise spawn the browser with `--remote-debugging-port=PORT --user-data-dir=<profile>` and `--headless=new`.
2. Open a tab (`PUT /json/new`), connect to its `webSocketDebuggerUrl` with a small hand-written CDP client (request/response ids, pending map, event listeners — no `chrome-remote-interface`).
3. `Page.enable` → `Page.navigate` → wait for `Page.loadEventFired` → settle.
4. Optionally wait for a selector, click, run JS.
5. Read `document.body.innerText` in a loop until its length stops changing (SPAs paint late).
6. Optionally `Page.captureScreenshot` → write the PNG.
7. Close the tab; the browser instance stays warm for the next call and is killed when the plugin unloads.

## Limitations

- **Separate browser profile.** The plugin's profile is its own user-data dir, so it does **not** carry your everyday cookies or logins. To read authenticated pages, open it once with `headful: true`, log in by hand, and the profile remembers it. (Chrome/Edge 136+ also refuse `--remote-debugging-port` on the default profile, so a dedicated profile is required anyway.)
- **One instance per port.** Concurrent calls share the instance; tabs are independent, but don't point two DSH profiles at the same port.
- **No PDF rendering, no downloads, no file uploads.** Text, HTML, screenshots.
- **Not a crawler.** One page per call; no link following, no stealth/anti-bot evasion.
- `--headless=new` is a real Chromium render, but anything that hard-blocks headless (some bot walls) still blocks it; `headful: true` is the escape hatch.

## Security notes

This tool drives a real browser with a persistent profile that accumulates cookies. Treat that profile directory as sensitive: it is created under `$DSH_HOME` and is readable only by your user account. Because the browser is the agent's, an agent allowed to call `browser_open({ headful: true, keepOpen: true })` can also browse anything you are logged into in that profile — grant the tool the same trust you give the agent's shell access.

## License

MIT — see [LICENSE](./LICENSE).
