# dsh-browser-cdp

一个 [DeepSeek Harness](https://github.com/deepseek-ai)（DSH）插件。它注册一个给模型用的工具 `browser_open`，用**你本机的 Chromium 浏览器**（Edge / Chrome / Chromium）通过 DevTools 协议去打开网页，把渲染完的内容拿回来。

零 npm 依赖 —— 只用 `node:` 内建模块，加上 Node 20+ 自带的 `fetch` 和 `WebSocket`。

[English →](./README.md)

---

## 为什么需要它

DSH 内置的 `web_fetch` 走 Node 的 `undici`，只信 Node 自带的那套 CA。而现实里的机器经常处在会做 TLS 中间人的环境后面：

- 加速器，比如 **Watt Toolkit / Steam++**（往 `hosts` 里塞 `127.0.0.1 github.com`，在 `0.0.0.0:443` 上用自签根证书签发）
- 企业 TLS 检查（Zscaler、Netskope、Palo Alto 之类）
- 本地调试代理（mitmproxy、Charles）

这时模型拿到的是：

```
UNABLE_TO_VERIFY_LEAF_SIGNATURE: unable to verify the first certificate
```

而同一台机器上浏览器打开同一个网址毫无问题 —— 因为浏览器读的是**系统证书库**。这个差异不处理，模型就会莫名其妙地失去一大片网络；而且 `NODE_EXTRA_CA_CERTS=root.cer` 通常也救不回来（这类私有根证书经常不带中间证书）。

`browser_open` 绕开整件事：**你的浏览器能打开的，模型就能读到。**

顺带覆盖内置抓取的另外两种常见失败：

- 需要 **JavaScript** 的页面（SPA、懒加载、无限滚动）—— 插件会等 `innerText` 长度稳定再取
- 对非浏览器 UA 返回 **403** 的站点

## 安装

需要 Node 20+（为了全局 `WebSocket`），机器上有 Edge / Chrome / Chromium 之一。

### 官方 CLI

```bash
dsh plugin --profile desktop add github:zdddrszj985/dsh-browser-cdp
```

### 手动安装（任何版本都可用，已在 DSH desktop / Windows 上验证）

1. 把包放到一个固定位置，比如 `%DSH_HOME%\plugins\dsh-browser-cdp`。
2. 改 profile 清单 —— `%DSH_HOME%\profiles\<profile>\package.json`：

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

3. 让 profile 能解析到这个包，Windows 上建目录联接即可：

   ```powershell
   New-Item -ItemType Junction `
     -Path "$env:DSH_HOME\profiles\desktop\node_modules\dsh-browser-cdp" `
     -Target "$env:DSH_HOME\plugins\dsh-browser-cdp"
   ```

4. 重启 DSH，或者等一会儿 —— profile 插件是热加载的，`browser_open` 会自动出现在模型的工具列表里。

卸载：从 `bundles` 里删掉、删掉依赖、删掉目录联接。

## 用法

加载后模型可以直接调 `browser_open`：

```jsonc
{
  "url": "https://github.com/owner/repo/blob/main/README.md",
  "waitForSelector": "article.markdown-body",   // 可选
  "screenshot": true                            // 可选
}
```

返回：

```jsonc
{
  "url": "https://example.com/",       // 跟随重定向后的最终地址
  "title": "Example Domain",
  "text": "Example Domain\nThis domain is for use ...",  // 可见 innerText
  "chars": 129,
  "data": "",                          // evaluate 表达式的值
  "screenshot": "C:\\Users\\you\\.dsh\\browser-cdp-shots\\shot-1712.png",
  "browser": "Edg/157.0.4341.60",
  "elapsedMs": 3115
}
```

### 参数

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `url` | string | —（必填） | 绝对 `http(s)` 地址 |
| `waitForSelector` | string | — | 等到这个 CSS 选择器命中再取内容 |
| `click` | string | — | 加载后点这个元素，再等稳定 |
| `evaluate` | string | — | 在页面里求值的 JS 表达式，结果放 `data` |
| `settleMs` | integer | `1200` | `load` 之后再多等多久 |
| `timeoutMs` | integer | `30000` | 导航预算，以及每次 CDP 调用的预算 |
| `html` | boolean | `false` | 返回 `outerHTML` 而不是可见文本 |
| `screenshot` | boolean | `false` | 存 PNG 并返回路径 |
| `headful` | boolean | `false` | 开真窗口（需要手动登录时用） |
| `keepOpen` | boolean | `false` | 抓完不关标签页 |
| `close` | boolean | `false` | 关掉共享的浏览器实例 |

### 配置

全部可选，走环境变量：

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_BROWSER_PATH` | 自动探测 | 浏览器可执行文件路径（也接受 `BROWSER_PATH`） |
| `DSH_BROWSER_CDP_PORT` | `9333` | DevTools 端口 |
| `DSH_BROWSER_CDP_PROFILE` | `$DSH_HOME/browser-cdp-profile` | 浏览器 user-data 目录 |
| `DSH_BROWSER_CDP_SHOTS` | `$DSH_HOME/browser-cdp-shots` | 截图输出目录 |
| `DSH_HOME` | `~/.dsh` | 上面两个的根 |

自动探测覆盖 Windows / macOS / Linux 上 Edge 与 Chrome 的标准安装位置（含 `LOCALAPPDATA` 下的用户级安装、`/snap/bin/chromium`、`/opt/google/chrome/chrome`）。

## 工作原理

1. 先探 `http://127.0.0.1:PORT/json/version`，活着就复用；否则用 `--remote-debugging-port=PORT --user-data-dir=<profile>` 加 `--headless=new` 起一个实例。
2. `PUT /json/new` 开标签页，连它的 `webSocketDebuggerUrl`，用自己写的小 CDP 客户端通信（请求 id、pending map、事件监听 —— 不依赖 `chrome-remote-interface`）。
3. `Page.enable` → `Page.navigate` → 等 `Page.loadEventFired` → settle。
4. 可选：等选择器、点元素、跑 JS。
5. 循环读 `document.body.innerText`，直到长度不再变化（SPA 渲染得晚）。
6. 可选：`Page.captureScreenshot` 落盘 PNG。
7. 关标签页；浏览器实例保持热着给下一次用，插件卸载时杀掉。

## 已知限制

- **独立的浏览器 profile。** 插件用自己 user-data 目录，**不带**你日常浏览器的 cookie 和登录态。要读登录后的页面，先 `headful: true` 开一次、手动登录，这个 profile 就记住了。（另外 Chrome/Edge 136+ 本身就不允许在默认 profile 上开 `--remote-debugging-port`，独立 profile 是必须的。）
- **一个端口一个实例。** 并发调用共享实例，标签页相互独立；但别让两个 DSH profile 抢同一个端口。
- **不渲染 PDF、不处理下载、不上传文件。** 只做文本、HTML、截图。
- **不是爬虫。** 一次一页，不跟链接，不做反检测/反爬绕过。
- `--headless=new` 是真实的 Chromium 渲染，但硬封 headless 的站点（部分 bot 墙）仍会拦；用 `headful: true` 兜底。

## 安全说明

这个工具会驱动一个真实的、profile 会持久保存 cookie 的浏览器。请把那个 profile 目录当成敏感数据：它放在 `$DSH_HOME` 下，只有你的账户能读。也因为它用的是"你的浏览器"，任何能调 `browser_open({ headful: true, keepOpen: true })` 的模型，等于能访问这个 profile 里你登录过的一切 —— 请给它和给模型 shell 权限一样的信任级别。

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
