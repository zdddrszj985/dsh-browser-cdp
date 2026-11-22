// Smoke test without DSH: import the plugin, capture the registered tool, call it.
// Run: node test/smoke.mjs
import { apply } from '../lib/index.js'

let definition = null
const ctx = { tools: { register: (def) => { definition = def } } }

apply(ctx)
if (!definition) throw new Error('apply() did not register any tool')
if (definition.name !== 'browser_open') throw new Error('unexpected tool name: ' + definition.name)

const result = await definition.execute({ url: 'https://example.com' })
console.log(JSON.stringify({
  title: result.title,
  chars: result.chars,
  browser: result.browser,
  elapsedMs: result.elapsedMs,
}, null, 2))

if (!/Example Domain/i.test(result.title)) throw new Error('unexpected page title: ' + result.title)
if (result.chars < 50) throw new Error('page text looks empty (' + result.chars + ' chars)')
console.log('ok')
