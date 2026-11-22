# Changelog

All notable changes to this project are documented here.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and the project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — 2026-11-22

First public release.

- `browser_open` tool: open a URL in the local Chromium browser over CDP and return the rendered page.
- Options: `waitForSelector`, `click`, `evaluate`, `settleMs`, `timeoutMs`, `html`, `screenshot`, `headful`, `keepOpen`, `close`.
- Browser instance reused across calls, tab closed after each call, instance killed on plugin unload.
- Browser auto-detection on Windows / macOS / Linux; override with `DSH_BROWSER_PATH`.
- Zero npm dependencies; requires Node 20+ for the global `WebSocket`.
