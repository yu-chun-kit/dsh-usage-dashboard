import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
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
  const {SlotCore}=await load('dsh-client-ui-slots')
  const ctx=new Context()
  const routes=new Map()
  ctx.provide('webServer',{register(route){routes.set(route.path,route);return()=>routes.delete(route.path)}})
  ctx.provide('webRuntime',{trustedHosts:[]})
  new HostConnectionService(ctx,['phone.test'],{isAuthenticated:request=>request.headers.cookie==='fixture-login'})
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
