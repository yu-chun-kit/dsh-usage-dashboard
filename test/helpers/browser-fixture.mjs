import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'

const client = await readFile(new URL('../../client.js', import.meta.url), 'utf8')

/** Fixture runtime for the actual ModuleLoader entry; never contacts DSH or a provider. */
export function browserFixture({ fetch, states = [], locale = 'zh-Hant', browserLocale = typeof locale === 'string' ? locale : 'en', localeService, rpcFetch, localeReadThrows = false, localStorage } = {}) {
  let selectedLocale = localeService ?? locale
  const values = [...states]; const refs = []; const dependencies = []; const callbacks = []; const cleanups = []; const disposers = []
  let cursor = 0; let refCursor = 0; let effectCursor = 0; let callbackCursor = 0
  const effects = []; const styles = []; const rpcCalls = []
  let tab
  let body
  const registrations=[]
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat(Infinity).filter(item => item !== null && item !== undefined && item !== false) }),
    useState: initial => { const index = cursor++; if (!(index in values)) values[index] = typeof initial === 'function' ? initial() : initial; return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next }] },
    useRef: initial => { const index = refCursor++; return refs[index] ??= { current: initial } },
    useCallback: (callback, deps) => { const index = callbackCursor++; const previous = callbacks[index]; if (!previous || deps.some((dep, i) => previous.deps[i] !== dep)) callbacks[index] = { callback, deps }; return callbacks[index].callback },
    useEffect: (callback, deps) => { const index = effectCursor++; if (!dependencies[index] || deps.some((dep, i) => dependencies[index][i] !== dep)) effects.push({ index, callback }); dependencies[index] = deps },
  }
  const context = {
    get: name => { if (name === 'locale' && localeReadThrows) throw new Error('locale is unavailable'); return name === 'locale' ? selectedLocale : undefined },
    connection: { rpc: { call: async (...args) => { rpcCalls.push(args); if (rpcFetch) return rpcFetch(...args); throw new Error('legacy RPC should not be needed') } } },
    sidebarRightTabs: { register: value => { tab = value; registrations.push(value.id); return () => registrations.splice(registrations.indexOf(value.id),1) } },
    slots: { inject: (_name,callback) => callback(), register: (options,component) => { if(options.name==='sidebar.right.pane.tab')body=component; const id=options.name+':'+options.key; registrations.push(id); return () => registrations.splice(registrations.indexOf(id),1) } },
    effect: callback => { const dispose = callback(); if (typeof dispose === 'function') disposers.push(dispose) },
  }
  runInNewContext(client, {
    window: { localStorage, __ModuleLoader__: { load: module => { module.factory(name => name === 'react' ? React : undefined).apply(context) } } },
    document: { querySelector: () => null, createElement: () => ({ dataset: {} }), head: { appendChild: node => styles.push(node.textContent) } },
    fetch, Intl, Date, navigator: { language: browserLocale }, requestAnimationFrame: callback => callback(),
  })
  const expand = node => {
    if (typeof node !== 'object') return node
    if (typeof node.type === 'function') return expand(node.type(node.props))
    return { ...node, children: node.children.map(expand) }
  }
  return {
    render: () => { cursor = 0; refCursor = 0; effectCursor = 0; callbackCursor = 0; return expand(body({ sessionId:'fixture-session' })) },
    flushEffects: async () => { while (effects.length) { const { index, callback } = effects.shift(); cleanups[index]?.(); cleanups[index] = callback() } await new Promise(resolve => setImmediate(resolve)) },
    setLocale: value => { selectedLocale = value },
    dispose: () => { cleanups.forEach(dispose => dispose?.()); disposers.forEach(dispose => dispose()) },
    title: () => tab.title(),
    styles, values, rpcCalls, registrations, definition:()=>tab,
  }
}

export function nodes(tree, predicate) {
  if (typeof tree !== 'object') return []
  return [...(predicate(tree) ? [tree] : []), ...tree.children.flatMap(child => nodes(child, predicate))]
}

const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char])
export function htmlOf(tree) {
  if (typeof tree !== 'object') return escape(tree)
  const attrs = Object.entries(tree.props).filter(([key, value]) => key !== 'key' && key !== 'ref' && !key.startsWith('on') && value !== undefined && value !== false).map(([key, value]) => ` ${key === 'className' ? 'class' : key === 'dateTime' ? 'datetime' : key}="${escape(value)}"`).join('')
  return `<${tree.type}${attrs}>${tree.children.map(htmlOf).join('')}</${tree.type}>`
}
