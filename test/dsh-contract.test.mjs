import assert from 'node:assert/strict'
import { readFile, mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { apply, inject } from '../lib/index.js'

// Optional offline acceptance against installed DSH. No profile or real
// credential provider is loaded, and every provider request is prohibited.
const moduleRoot=process.env.DSH_TEST_MODULE_ROOT
const load=name=>import(pathToFileURL(join(moduleRoot,'@deepseek-ai',name,'lib/index.js')).href)

test('installed DSH 0.2 accepts host lifecycle, auth fence and browser keyed seats',{skip:!moduleRoot},async()=>{
  const {Context}=await load('cordis')
  const {HostConnectionService}=await load('dsh-client-connection')
  // 0.2.1 bundles slots into the browser distribution and does not install its
  // host-only package. A test-only exact release can be supplied explicitly.
  const {SlotCore}=process.env.DSH_TEST_SLOTS_ROOT
    ? await import(pathToFileURL(join(process.env.DSH_TEST_SLOTS_ROOT,'lib/index.js')).href)
    : await load('dsh-client-ui-slots')
  const ctx=new Context()
  const routes=new Map()
  ctx.provide('webServer',{register(route){routes.set(route.path,route);return()=>routes.delete(route.path)}})
  ctx.provide('webRuntime',{trustedHosts:[]})
  new HostConnectionService(ctx,['phone.test'],{isAuthenticated:request=>request.headers.cookie==='fixture-login',authenticateApi:()=>undefined})
  ctx.provide('credentials',{resolve:async()=>undefined,describe:async()=>({configured:false,writable:false})})
  let requests=0
  ctx.provide('providerFetch',async()=>{requests++;throw new Error('Real requests prohibited')})
  const fiber=ctx.plugin({apply,inject},{enabledProviders:[]})
  try{
    await new Promise(resolve=>setTimeout(resolve,30))
    assert.equal([...routes.keys()].filter(path=>path.startsWith('/api/usage-dashboard/')).length,4)
    assert.equal(routes.has('/usage-dashboard'),false)
    const route=routes.get('/api/usage-dashboard/settings')
    let status,body
    const response={writeHead(code){status=code},end(value){body=value}}
    await route.handler({method:'POST',headers:{host:'phone.test'},socket:{remoteAddress:'127.0.0.1'}},response)
    assert.equal(status,401)
    await route.handler({method:'POST',headers:{host:'phone.test',cookie:'fixture-login'},socket:{remoteAddress:'127.0.0.1'}},response)
    assert.equal(status,200)
    assert.equal(JSON.parse(body).ok,true)
    assert.equal(requests,0)

    const core=new SlotCore()
    const releaseOwner=core.register({name:'root',children:{
      'sidebar.right.pane.tab':{kind:'keyed',scope:'session'},
      'sidebar.right.pane.tab.title':{kind:'keyed',scope:'session'},
    }},()=>null)
    const effects=[]
    let definition
    const browser={
      connection:{},locale:'en',
      sidebarRightTabs:{register(value){definition=value;return()=>{definition=undefined}}},
      slots:{inject:(_name,callback)=>callback(),register:core.register.bind(core)},
      effect(callback){effects.push(callback())},
    }
    const client=await readFile(new URL('../client.js',import.meta.url),'utf8')
    runInNewContext(client,{
      window:{__ModuleLoader__:{load(module){module.factory(()=>({})).apply(browser)}}},
      document:{querySelector:()=>true},navigator:{language:'en'},
    })
    assert.equal(definition.kind,'dsh-usage-dashboard')
    assert.equal(core.entriesOfSlot('sidebar.right.pane.tab').length,1)
    assert.equal(core.entriesOfSlot('sidebar.right.pane.tab.title').length,1)
    for(const dispose of effects.reverse())dispose()
    assert.equal(definition,undefined)
    assert.equal(core.entriesOfSlot('sidebar.right.pane.tab').length,0)
    releaseOwner()
  }finally{
    await fiber.dispose()
    assert.equal(routes.size,0)
  }
})

test('installed DSH record provider persists shared snapshots across host recreation',{skip:!moduleRoot},async()=>{
  const {Context}=await load('cordis')
  const {LocalCredentialProvider}=await load('dsh-credentials-local')
  const root=await mkdtemp(join(tmpdir(),'usage-record-fixture-'))
  const path=join(root,'fixture-records.yaml')
  let requests=0
  const activate=async(seed=false)=>{
    const ctx=new Context()
    const routes=new Map()
    ctx.provide('webServer',{register(route){routes.set(route.path,route);return()=>routes.delete(route.path)}})
    ctx.provide('connection',{requestRejection:()=>undefined})
    ctx.provide('now',()=>new Date('2026-10-24T00:00:00.000Z'))
    ctx.provide('providerFetch',async()=>{requests++;return{status:200,text:async()=>JSON.stringify({balance_infos:[{currency:'CNY',total_balance:'12'}]})}})
    const credentialFiber=ctx.plugin(LocalCredentialProvider,{path,dshHome:root,watch:false,debounceMs:0})
    await new Promise(resolve=>setTimeout(resolve,30))
    if(seed)await ctx.get('credentials').set('DEEPSEEK_API_KEY','fixture-only-provider-key')
    const dashboardFiber=ctx.plugin({apply,inject},{enabledProviders:['deepseek']})
    await new Promise(resolve=>setTimeout(resolve,30))
    return{
      async snapshot(payload){
        let result
        await routes.get('/api/usage-dashboard/snapshot').handler({method:'POST',headers:{'content-type':'application/json'},on(event,callback){if(event==='data')callback(JSON.stringify(payload));if(event==='end')callback()}},{writeHead(){},end(body){result=JSON.parse(body)}})
        assert.equal(result.ok,true)
        return result.value
      },
      async dispose(){await dashboardFiber.dispose();await credentialFiber.dispose()},
    }
  }
  let host
  try{
    host=await activate(true)
    assert.equal((await host.snapshot({})).providers[0].metrics[0].remaining,12)
    assert.equal(requests,1)
    const document=await readFile(path,'utf8')
    assert.match(document,/dsh-usage-dashboard\/snapshots/)
    if(process.platform!=='win32')assert.equal((await stat(path)).mode&0o077,0)
    await host.dispose();host=undefined
    host=await activate()
    const restored=await host.snapshot({cacheOnly:true})
    assert.equal(restored.providers[0].metrics[0].remaining,12)
    assert.equal(restored.needsRefresh,false)
    assert.equal(requests,1)
  }finally{
    await host?.dispose()
    await rm(root,{recursive:true,force:true})
  }
})
