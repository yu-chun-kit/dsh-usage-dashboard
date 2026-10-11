import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile } from 'node:fs/promises'
import { messages } from '../lib/client/messages.js'
import { normalizeLocale, metricLabel, metricValue, friendlyError } from '../lib/client/i18n.js'
import { renderDashboardHtml, normalizeDashboardLocale, renderSettingsHtml, normalizeSettingsLocale } from '../lib/client/index.js'
import { browserFixture, htmlOf, nodes } from './helpers/browser-fixture.mjs'

const locales = ['en', 'zh-Hans', 'zh-Hant', 'ja']
const idle = [{ loading:false, providers:[], activity:{} }, {loading:false, items:[]}]
const response = value => ({status:200, ok:true, json:async()=>({ok:true,value})})
test('canonical locale dictionaries have complete matching keys and formal Chinese', async () => {
  const keys = Object.keys(messages.en).sort()
  for (const locale of locales) {
    const data = JSON.parse(await readFile(new URL(`../locales/${locale}.json`, import.meta.url),'utf8'))
    assert.deepEqual(data, messages[locale])
    assert.deepEqual(Object.keys(data).sort(), keys)
    assert.ok(Object.values(data).every(value=>typeof value==='string' && value.length))
    if (locale.startsWith('zh')) assert.doesNotMatch(Object.values(data).join(' '), /[唔喺嘅佢]|呢啲|儲存緊|隻讀/)
  }
})
test('locale variants normalize identically across HTML and browser clients', () => {
  const cases = {en:'en','en-US':'en','EN_gb':'en',zh:'zh-Hans','zh-CN':'zh-Hans','zh_SG':'zh-Hans','zh-Hans-TW':'zh-Hans','zh-Hant-CN':'zh-Hant','zh-HK':'zh-Hant','zh_TW':'zh-Hant','ja-JP':'ja',JA_jp:'ja',fr:'en'}
  for(const [tag,locale] of Object.entries(cases)) {
    assert.equal(normalizeLocale(tag),locale)
    assert.equal(normalizeDashboardLocale(tag),locale)
    assert.equal(normalizeSettingsLocale(tag),locale)
    const fixture=browserFixture({locale:tag,browserLocale:'en',states:idle})
    assert.equal(fixture.render().props.lang,locale)
    assert.equal(fixture.title(),messages[locale].title)
  }
})
test('explicit English wins over Chinese browser; absent/unsupported/throwing service safely falls back', () => {
  assert.equal(browserFixture({locale:'en-US',browserLocale:'zh-TW',states:idle}).render().props.lang,'en')
  for (const options of [{locale:null},{locale:'fr'},{localeReadThrows:true}]) {
    assert.equal(browserFixture({...options,browserLocale:'ja-JP',states:idle}).render().props.lang,'ja')
  }
})
test('real DSH locale services register languages and update live with subscription disposal', async () => {
  let active='en'; const listeners=new Set(); const added=[]; const registered=[]; let disposed=0
  const service={ getLocale:()=>({active}), subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn)}, addLanguage:item=>{added.push(item);return()=>disposed++}, register:(...args)=>{registered.push(args);return()=>disposed++} }
  const fixture=browserFixture({localeService:service,browserLocale:'zh-TW',fetch:async path=>response(path.endsWith('settings')?{credentials:[]}:{providers:[],activity:{}})})
  assert.equal(fixture.render().props.lang,'en'); await fixture.flushEffects()
  assert.deepEqual(added.map(item=>item.id),['zh-Hans','zh-Hant','ja'])
  assert.deepEqual(registered.map(item=>item[1]),locales)
  active='ja'; listeners.forEach(fn=>fn())
  assert.equal(fixture.render().props.lang,'ja'); assert.equal(fixture.title(),messages.ja.title)
  fixture.dispose(); assert.equal(listeners.size,0); assert.equal(disposed,7)
})
test('all locales translate known metrics, quota units and warnings while preserving custom names', () => {
  const metric={kind:'quota',used:1234.5,limit:10000,unit:'credits',label:'Monthly'}
  for(const locale of locales) {
    const labels=messages[locale]
    assert.equal(metricLabel(metric,labels),labels.monthly)
    assert.equal(metricValue(metric,locale,labels),`${(1234.5).toLocaleString(locale)} / ${(10000).toLocaleString(locale)} ${labels.credits}`)
    assert.equal(metricLabel({kind:'balance',label:'Balance (CNY)',remaining:1,currency:'CNY'},labels),`${labels.balance} (CNY)`)
    assert.equal(metricLabel({...metric,label:'Custom <quota>'},labels),'Custom <quota>')
    assert.equal(metricLabel({...metric,label:'Code review secondary'},labels),labels.secondarySuffix.replace('{label}','Code review'))
    for(const [label,key] of Object.entries({'Rolling (5h)':'rolling5h',Weekly:'weekly','API key':'apiKey',Plan:'plan','Pay as you go':'paygo',Primary:'primary',Secondary:'secondary',Additional:'additional'})) assert.equal(metricLabel({...metric,label},labels),labels[key])
    const providers=[{providerId:'tavily',displayName:'Tavily',state:'fresh',metrics:[metric]},{providerId:'deepseek',displayName:'DeepSeek',state:'fresh',metrics:[],warning:'DeepSeek reports the balance is insufficient for API calls.'},{providerId:'kilo',displayName:'Kilo',state:'unsupported',metrics:[],warning:'No zero-cost read-only usage endpoint is verified for this provider.'}]
    const html=htmlOf(browserFixture({locale,states:[{loading:false,providers,activity:{}},idle[1]]}).render())
    for(const key of ['monthly','credits','insufficientHint','unsupportedHint']) assert.ok(html.includes(labels[key]),`${locale}.${key}`)
    assert.doesNotMatch(html,/reports the balance|zero-cost read-only/)
    const legacy=renderDashboardHtml({expanded:true,loading:false,snapshot:{providers,generatedAt:'2026-10-03'}},locale)
    assert.match(legacy,new RegExp(`lang="${locale}"`)); assert.ok(legacy.includes(labels.monthly)); assert.ok(legacy.includes(labels.insufficientHint))
  }
})
test('all coded errors are localized without displaying English backend diagnostics', async () => {
  const keys={'credential-missing':'missingHint','credential-rejected':'rejectedHint','credential-not-writable':'notWritableHint','provider-http':'providerHttpHint','provider-timeout':'timeoutHint','provider-invalid-response':'invalidResponseHint','provider-unsupported':'unsupportedHint','bad-request':'badRequestHint','endpoint-not-allowed':'endpointHint',internal:'internalHint','session-required':'sessionHint','untrusted-host':'forbiddenHint'}
  for(const locale of locales) for(const [code,key] of Object.entries(keys)) assert.equal(friendlyError({code,message:'Raw English diagnostic'},messages[locale],messages[locale].usageError),messages[locale][key])
  for(const [status,key] of [[401,'sessionHint'],[403,'forbiddenHint']]) {
    const fixture=browserFixture({locale:'ja',fetch:async()=>({status,ok:false})}); fixture.render(); await fixture.flushEffects()
    assert.ok(htmlOf(fixture.render()).includes(messages.ja[key])); assert.equal(fixture.rpcCalls.length,0)
  }
  const fixture=browserFixture({locale:'ja',fetch:async()=>({status:404,ok:false}),rpcFetch:async()=>({ok:false,error:{code:'credential-not-writable',message:'Raw English diagnostic'}})})
  fixture.render(); await fixture.flushEffects(); assert.ok(htmlOf(fixture.render()).includes(messages.ja.notWritableHint))
  const unavailable=browserFixture({locale:'ja',fetch:async()=>{throw new Error('raw') }})
  unavailable.render(); await unavailable.flushEffects(); assert.ok(htmlOf(unavailable.render()).includes(messages.ja.transportHint))
})
test('settings labels, accessibility and credential kinds are translated and escaped', () => {
  for(const locale of locales) {
    const text=messages[locale]
    const html=renderSettingsHtml({settings:{enabledProviders:['deepseek']},credentials:[{label:'Custom <label>',reference:'SAFE_REF',kind:'session',configured:true,writable:true}]},locale)
    assert.ok(html.includes(text.move.replace('{provider}','deepseek')))
    assert.ok(html.includes(text.session)); assert.ok(html.includes(text.settingsTtl))
    assert.match(html,/Custom &lt;label&gt;/); assert.doesNotMatch(html,/loopback|唔|喺|嘅/)
  }
})

test('live locale changes also translate stored form messages and error outcomes', () => {
  const reference='DEEPSEEK_API_KEY'
  const fixture=browserFixture({locale:'en',states:[{loading:false,providers:[],activity:{},error:{code:'provider-timeout'}},{loading:false,items:[{reference,configured:true,writable:true}]},{},null,{[reference]:{key:'saved'}},true,true]})
  assert.ok(htmlOf(fixture.render()).includes(messages.en.saved))
  fixture.setLocale('ja')
  const html=htmlOf(fixture.render())
  assert.ok(html.includes(messages.ja.saved)); assert.ok(html.includes(messages.ja.timeoutHint))
  assert.doesNotMatch(html,/The provider timed out|Saved\./)
})

test('stale data and Deepgram option hints are translated without duplicates', () => {
  for(const locale of locales) {
    const providers=[{providerId:'deepgram',displayName:'Deepgram',state:'needs-configuration',metrics:[],warning:'Deepgram needs providerOptions.deepgram.projectId and balanceId before the balance can be fetched. The API key alone is not enough.'},{providerId:'deepseek',displayName:'DeepSeek',state:'stale',metrics:[],warning:'Provider raw English error'}]
    const html=htmlOf(browserFixture({locale,states:[{loading:false,providers,activity:{}},idle[1]]}).render())
    assert.ok(html.includes(messages[locale].staleHint))
    assert.equal(html.split(messages[locale].needsDeepgramOptions).length,2)
    assert.doesNotMatch(html,/Provider raw English error/)
  }
})
