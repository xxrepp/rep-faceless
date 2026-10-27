const assert = require('node:assert/strict')
const { test } = require('node:test')
const fs = require('node:fs'), path = require('node:path'), os = require('node:os')
const { DatabaseSync } = require('node:sqlite')
const ts = require('typescript')

// Execute production TS and SQL with controlled provider responses. No network, keys or user data.
class Sqlite {
  constructor(file) { this.db = new DatabaseSync(file); this.depth = 0 }
  exec(sql) { this.db.exec(sql) }
  pragma(sql, opts) { const row = this.db.prepare('PRAGMA ' + sql).get(); return opts?.simple ? Object.values(row)[0] : row }
  prepare(sql) { const statement = this.db.prepare(sql); statement.setAllowUnknownNamedParameters(true); return statement }
  close() { this.db.close() }
  transaction(fn) { return () => {
    const name = 'test_' + (++this.depth)
    this.exec('SAVEPOINT ' + name)
    try { const result = fn(); this.exec('RELEASE ' + name); return result }
    catch (e) { this.exec('ROLLBACK TO ' + name); this.exec('RELEASE ' + name); throw e }
    finally { this.depth-- }
  } }
}
function loader(mocks) {
  const cache = new Map()
  const resolve = (file) => {
    const base = path.resolve(__dirname, '../src', file)
    return fs.existsSync(base + '.ts') ? base + '.ts' : path.join(base, 'index.ts')
  }
  function load(file) {
    const full = resolve(file)
    if (mocks[file]) return mocks[file]
    if (cache.has(full)) return cache.get(full).exports
    const mod = {exports:{}}; cache.set(full, mod)
    const source = ts.transpileModule(fs.readFileSync(full, 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023,esModuleInterop:true}}).outputText
    new Function('require','module','exports',source)(name => {
      if (mocks[name]) return mocks[name]
      if (name.startsWith('@shared/')) return load('shared/' + name.slice(8))
      if (name.startsWith('.')) return load(path.relative(path.resolve(__dirname,'../src'), path.resolve(path.dirname(full),name)).replaceAll('\\','/'))
      return require(name)
    },mod,mod.exports)
    return mod.exports
  }
  load.fresh = file => { cache.delete(resolve(file)); return load(file) }
  return load
}
function scenario(t, count = 25) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'bang-visual-test-'))
  const settings = {defaultTtsProvider:'gemini',defaultLanguage:'en',imageModel:'image',videoModel:'video',llmProvider:'custom',llmModels:{custom:'fixture-model',gemini:'fixture-gemini'},visualInstructions:'Fixture instructions',visualInstructionsMode:'custom',visualStyleOverrides:{},customBaseUrl:'http://fixture.invalid'}
  const requests = [], events = [], progress = []
  let hook = null, repo, projectId
  const mocks = {
    'better-sqlite3': Sqlite,
    'main/paths': {dbPath:()=>path.join(dir,'test.sqlite'),projectDir:()=>dir,assetUrl:()=>'',projectsRoot:()=>dir},
    'main/settings': {getSettings:()=>settings},
    'main/events': {emit:new Proxy({}, {get:(_,kind)=>(value)=>events.push({kind,value})})},
    'main/services/higgsfield': {cancelRequest:async()=>{}},
    'main/services/llm': {
      activeLlm:()=>({provider:settings.llmProvider,model:settings.llmModels[settings.llmProvider]}),
      generateJson:async req => {
        requests.push(req)
        let result
        if(req.name==='continuity') result={world:'A coastal town in 2040.',direction:'Warm realistic cinema.',recurringDesigns:'A red bicycle and lighthouse remain recognizable.',characters:repo.charactersOf(projectId).map(c=>({name:c.name,description:c.description})),states:repo.clipsOf(projectId).map((_,i)=>({scene:i+1,entering:'Mara wears a blue coat and carries the key.',leaving:'Mara keeps her blue coat and key.'})),conflicts:[]}
        else if(req.name==='continuity_plan_review') result={consistent:true,issues:[],notes:['Plan internally coherent.']}
        else if(req.name==='continuity_plan_align') result={plan:null,reason:''}
        else if(req.name==='continuity_review') result={consistent:true,issues:[]}
        else if(req.name==='continuity_repair') result={edits:[]}
        else if(req.name==='continuity_repair_review') result={consistent:false,issues:['Fixture unresolved conflict'],resolutions:[]}
        else {
          const numbers = /Write visuals for these scenes only: ([\d, ]+)/.exec(req.prompt)[1].split(',').map(Number)
          result={world:'A coastal town in 2040.',characters:[],scenes:numbers.map(scene=>({scene,setting:'Coastal town in 2040, lighthouse, bench, red bicycle, warm sunset.',action:'Mara holds the key beside the bicycle.',wardrobe:[{name:'Mara',source:'reference',outfit:'blue coat'}],framing:'Medium shot at eye level.',avoid:'spaceships, medieval outfits, snow',characters:['Mara'],camera:'static',strength:'halus',motion:'Her coat moves in the breeze.',transition:'cut'}))}
        }
        return hook ? await hook(req,result) : result
      }
    }
  }
  const load = loader(mocks)
  const dbApi = load('main/db'); const db = () => dbApi.getDb()
  repo = load('main/repo')
  const project = repo.createProject({synopsis:'Mara returns a key to the lighthouse.'}); projectId = project.id
  repo.replaceScript(projectId,'Story',Array.from({length:count},(_,i)=>({title:'Scene '+(i+1),story:'Mara carries the key at the coast '+(i+1),narration:'The journey continues.',durationMs:5000})))
  db().prepare('INSERT INTO characters (id,project_id,name,description,sort) VALUES (?,?,?,?,?)').run('mara',projectId,'Mara','Human woman, dark hair. Default outfit: blue coat.',0)
  const ctx = ctrl => ({jobId:'fixture',signal:ctrl?.signal??new AbortController().signal,progress:(p,message)=>progress.push({p,message}),setRemote:()=>{}})
  t.after(()=>{dbApi.closeDb();fs.rmSync(dir,{recursive:true,force:true})})
  return {repo,settings,requests,events,progress,load,db,projectId,ctx,
    setHook:fn=>{hook=fn},
    run:(mode='missing',ctrl)=>load('main/visualPlanning').executeVisualPlanning(projectId,mode,ctx(ctrl)),
    state:()=>JSON.parse(db().prepare('SELECT state_json FROM visual_plans WHERE project_id=?').get(projectId).state_json),
    restart:()=>{dbApi.closeDb();load.fresh('main/visualPlanning')},
    clips:()=>repo.clipsOf(projectId),
    numbers:()=>requests.filter(r=>r.name==='visuals').map(r=>/Write visuals for these scenes only: ([\d, ]+)/.exec(r.prompt)[1].split(',').map(Number))
  }
}

test('later failure commits earlier batch; restart resumes pending scenes with one saved continuity version and preserves manual edits', async t=>{
 const s=scenario(t)
 let fail=true
 s.setHook((req,result)=>{if(fail && req.name==='visuals' && result.scenes[0].scene===13) throw Object.assign(new Error('denied'),{status:401});return result})
 await assert.rejects(s.run(),/HTTP 401/)
 assert.equal(s.clips().filter(c=>c.visualPrompt).length,12)
 const version=s.state().version
 const first=s.clips()[0]
 s.db().prepare('UPDATE clips SET visual_prompt=? WHERE id=?').run('USER MANUAL PROMPT',first.id)
 s.restart();fail=false
 await s.run()
 assert.equal(s.state().version,version)
 assert.equal(s.requests.filter(r=>r.name==='continuity').length,1)
 assert.equal(s.clips()[0].visualPrompt,'USER MANUAL PROMPT')
 assert.equal(s.clips().filter(c=>c.visualPrompt).length,25)
 assert.deepEqual(s.numbers().map(n=>[n[0],n.at(-1)]),[[1,12],[13,24],[13,24],[25,25]])
 assert.equal(s.state().plan.characters[0].description,'Human woman, dark hair. Default outfit: blue coat.')
 for(const req of s.requests.filter(r=>r.name==='visuals')) {
   assert.match(req.prompt,/Scene 25:/)
   assert.match(req.prompt,/Full script:/)
   assert.match(req.prompt,/Shared continuity plan/)
   assert.match(req.prompt,/Entering\/leaving states/)
 }
})

test('cancel aborts further requests and preserves saved batches for Resume',async t=>{
 const s=scenario(t);const ctrl=new AbortController()
 s.setHook((req,result)=>{if(req.name==='visuals' && result.scenes[0].scene===13)ctrl.abort();return result})
 await assert.rejects(s.run('missing',ctrl))
 assert.equal(s.clips().filter(c=>c.visualPrompt).length,12)
 const version=s.state().version;s.setHook(null)
 await s.run()
 assert.equal(s.state().version,version)
 assert.equal(s.requests.filter(r=>r.name==='continuity').length,1)
 assert.equal(s.clips().filter(c=>c.visualPrompt).length,25)
})

test('duplicate clicks share the same persisted job; active snapshots cannot overwrite generated output',async t=>{
 const s=scenario(t,1), workflow=s.load('main/visualPlanning'),jobs=s.load('main/jobs')
 s.setHook(()=>new Promise(()=>{}))
 const first=workflow.startVisualPlanning(s.projectId,'missing')
 const second=workflow.startVisualPlanning(s.projectId,'all')
 assert.equal(first.id,second.id)
 assert.equal(s.db().prepare('SELECT count(*) AS n FROM jobs').get().n,1)
 assert.throws(()=>s.repo.saveSnapshot(s.repo.getBundle(s.projectId)),/Batalkan dulu/)
 await jobs.cancelJob(first.id)
 for(let i=0;i<100 && ['queued','running'].includes(s.repo.getJob(first.id).status);i++) await new Promise(r=>setTimeout(r,5))
 assert.equal(s.repo.getJob(first.id).status,'canceled')
})

test('changed script cannot accept stale in-flight results; changed style invalidates only unedited generated visuals',async t=>{
 const s=scenario(t,13)
 s.setHook((req,result)=>{if(req.name==='visuals')s.db().prepare('UPDATE clips SET story=? WHERE sort=0').run('A new script input');return result})
 await assert.rejects(s.run(),/Input atau provider berubah/)
 assert.equal(s.clips().filter(c=>c.visualPrompt).length,0)
 s.setHook(null);await s.run()
 const version=s.state().version
 const first=s.clips()[0]
 s.db().prepare('UPDATE clips SET visual_prompt=? WHERE id=?').run('MANUAL APPROVED',first.id)
 s.settings.visualInstructions='New visual instructions'
 const before=s.requests.length
 await s.run()
 assert.notEqual(s.state().version,version)
 assert.equal(s.clips()[0].visualPrompt,'MANUAL APPROVED')
 assert.equal(s.requests.slice(before).filter(r=>r.name==='continuity').length,1)
 assert.equal(s.numbers().at(-1)[0],2)
})

for(const kind of ['missing','duplicate','out-of-range','camera','strength','transition','character','wardrobe','prompt']) test('invalid '+kind+' batch cannot produce false completion',async t=>{
 const s=scenario(t,2)
 s.setHook((req,result)=>{
   if(req.name==='visuals') {
    const a=result.scenes[0]
    if(kind==='missing')result.scenes.pop()
    if(kind==='duplicate')result.scenes[1].scene=1
    if(kind==='out-of-range')a.scene=99
    if(kind==='camera')a.camera='unsupported'
    if(kind==='strength')a.strength='unsupported'
    if(kind==='transition')a.transition='unsupported'
    if(kind==='character')a.characters=['Unknown']
    if(kind==='wardrobe')a.wardrobe[0].name='Unknown'
    if(kind==='prompt')a.action=' '
   }return result
 })
 await assert.rejects(s.run())
 assert.equal(s.clips().filter(c=>c.visualPrompt).length,0)
 assert.equal(Object.keys(s.state().outputs).length,0)
 assert.equal(s.requests.filter(r=>r.name==='continuity_review').length,0)
})

test('semantic continuity rejection never saves an inconsistent batch',async t=>{
 const s=scenario(t,13)
 s.setHook((req,result)=>req.name==='continuity_review'?{consistent:false,issues:['Outfit changes without a story event.']}:result)
 await assert.rejects(s.run())
 assert.equal(s.clips().filter(c=>c.visualPrompt).length,0)
})

test('unresolved plan conflicts are saved, surfaced and reused until input changes',async t=>{
 const s=scenario(t,1)
 s.setHook((req,result)=>req.name==='continuity'?{...result,conflicts:['Approved reference contradicts synopsis.']}:result)
 await assert.rejects(s.run(),/konflik/i)
 await assert.rejects(s.run(),/konflik/i)
 assert.equal(s.requests.filter(r=>r.name==='continuity').length,1)
 assert.equal(s.repo.getBundle(s.projectId).visualContinuity.conflicts.length,1)
 assert.equal(s.numbers().length,0)
})

test('SQL failure rolls back the entire batch and its checkpoint together',async t=>{
 const s=scenario(t,2)
 s.db().exec("CREATE TRIGGER reject_second BEFORE UPDATE OF visual_prompt ON clips WHEN OLD.sort = 1 BEGIN SELECT RAISE(ABORT, 'fixture disk failure'); END")
 await assert.rejects(s.run(),/fixture disk failure/)
 assert.equal(s.clips().filter(c=>c.visualPrompt).length,0)
 assert.equal(Object.keys(s.state().outputs).length,0)
})

test('existing approved prompts are skipped; explicit regeneration resumes only its unfinished targets',async t=>{
 const s=scenario(t,14)
 s.db().prepare('UPDATE clips SET visual_prompt=?,visual_source=story WHERE sort=0').run('EXISTING MANUAL')
 await s.run()
 assert.equal(s.numbers()[0][0],2)
 assert.equal(s.clips()[0].visualPrompt,'EXISTING MANUAL')
 let failed=false
 s.setHook((req,result)=>{if(req.name==='visuals'&&result.scenes[0].scene===13){failed=true;throw Object.assign(new Error('permanent'),{status:404})}return result})
 await assert.rejects(s.run('all'))
 assert.ok(failed)
 const before=s.numbers().length;s.setHook(null);await s.run()
 assert.deepEqual(s.numbers().slice(before),[[13,14]])
})

const retry = loader({})('main/services/visualRetry')
const options=ctrl=>({signal:ctrl.signal,provider:'custom',model:'fixture',stage:'visuals',range:'13–24',progress:()=>{},diagnostic:()=>{}})
test('transient errors retry at most three attempts with jitter and Retry-After; permanent failures stop once',async()=>{
 for(const error of [Object.assign(new Error('fetch failed'),{cause:{code:'ECONNRESET'}}),{status:408},{status:429,retryAfterMs:8000},{status:503}]){
  let count=0;const waits=[]
  await assert.rejects(retry.visualRequest(async()=>{count++;throw error},options(new AbortController()),{timeoutMs:1000,random:()=>0.5,wait:async ms=>waits.push(ms)}))
  assert.equal(count,3);assert.equal(waits.length,2)
  assert.ok(waits.every(ms=>ms>0 && ms<=60000))
  if(error.retryAfterMs)assert.ok(waits.every(ms=>ms>=error.retryAfterMs))
 }
 for(const status of [400,401,403,404,413,422]){
  let count=0
  await assert.rejects(retry.visualRequest(async()=>{count++;throw {status}},options(new AbortController())))
  assert.equal(count,1)
 }
 let count=0
 await assert.rejects(retry.visualRequest(async()=>{count++;throw {status:429,retryAfterMs:120000}},options(new AbortController())),/60 detik/)
 assert.equal(count,1)
})

test('timeout/cancel bound an uncooperative provider; safe diagnostics retain transport code without leaking message/body',async()=>{
 const ctrl=new AbortController();let attempts=0;const lines=[]
 const opts={...options(ctrl),diagnostic:v=>lines.push(v)}
 await assert.rejects(retry.visualRequest(async()=>{attempts++;throw Object.assign(new Error('secret story and API key'),{cause:{code:'UND_ERR_SOCKET'}})},opts,{timeoutMs:100,random:()=>0,wait:async()=>{}}))
 assert.equal(attempts,3);assert.ok(lines.every(v=>v.includes('UND_ERR_SOCKET')))
 assert.ok(lines.every(v=>!v.includes('secret')))
 const timer=setInterval(()=>{},1000)
 try{
  await assert.rejects(retry.visualRequest(()=>new Promise(()=>{}),options(new AbortController()),{timeoutMs:5,random:()=>0,wait:async()=>{}}),/HTTP 408/)
  const canceled=new AbortController()
  const pending=retry.visualRequest(()=>new Promise(()=>{}),options(canceled));setTimeout(()=>canceled.abort(),5)
  await assert.rejects(pending)
 }finally{clearInterval(timer)}
})


test('migration adds planning storage without altering an existing project, prompt, reference or asset link',async t=>{
 const s=scenario(t,1)
 s.db().prepare("UPDATE clips SET visual_prompt='LEGACY MANUAL',image_asset_id='asset-kept'").run()
 s.db().prepare("UPDATE characters SET sheet_asset_id='sheet-kept'").run()
 const version=s.db().pragma('user_version',{simple:true})
 s.db().exec('DROP TABLE visual_plans; DROP TABLE script_drafts; DROP TABLE publication_materials; ALTER TABLE projects DROP COLUMN prompt_profile_json; PRAGMA user_version = '+(version-3))
 s.restart()
 assert.equal(s.db().pragma('user_version',{simple:true}),version)
 assert.equal(s.clips()[0].visualPrompt,'LEGACY MANUAL')
 assert.equal(s.clips()[0].imageAssetId,'asset-kept')
 assert.equal(s.repo.charactersOf(s.projectId)[0].sheetAssetId,'sheet-kept')
 assert.equal(s.repo.getBundle(s.projectId).visualContinuity,null)
})

test('provider selection and reference changes reject in-flight results before any commit',async t=>{
 for(const kind of ['provider','reference']){
  const s=scenario(t,1)
  s.setHook((req,result)=>{
   if(req.name==='visuals'){
    if(kind==='provider')s.settings.llmProvider='gemini'
    else s.db().prepare("UPDATE characters SET description='New approved reference'").run()
   }
   return result
  })
  await assert.rejects(s.run(),/Input atau provider berubah/)
  assert.equal(s.clips()[0].visualPrompt,'')
 }
})

test('unrelated style overrides do not invalidate a saved plan or completed visuals',async t=>{
 const s=scenario(t,1);await s.run();const version=s.state().version
 const count=s.requests.length
 s.settings.visualStyleOverrides={'cinematic-realistic':{mode:'custom',prompt:'Unrelated style',characterHint:'Unrelated'}}
 await s.run()
 assert.equal(s.state().version,version)
 assert.equal(s.requests.length,count)
})

for(const provider of ['custom','gemini'])test(provider+' adapter uses bounded retry, abort signals and safe transport/HTTP diagnostics',async t=>{
 const settings={llmProvider:provider,llmModels:{[provider]:'fixture'},customBaseUrl:'http://fixture.invalid'}
 const calls=[];let failures=1
 const handle = async()=>{
   if(failures-->0)throw Object.assign(new Error('fetch failed'),{cause:{code:'ECONNRESET'}})
   return {ok:true}
 }
 const load=loader({
  'main/settings':{getSettings:()=>settings},
  'main/secrets':{getSecret:()=> 'fixture-key',requireSecret:()=> 'fixture-key',PROVIDER_NAMES:{custom:'Custom',gemini:'Gemini'}},
  'main/services/elevenlabs':{},'main/services/flow2api':{},'main/services/audio':{},
  '@google/genai':{GoogleGenAI:class{models={generateContent:async req=>{calls.push(req);return {text:JSON.stringify(await handle())}}}}}
 })
 if(provider==='custom')t.mock.method(globalThis,'fetch',async(url,init)=>{
   calls.push({url,init});return new Response(JSON.stringify({choices:[{message:{content:JSON.stringify(await handle())}}]}),{status:200})
 })
 const llm=load('main/services/llm')
 const req={system:'safe system',prompt:'fixture story',schema:{type:'object'},name:'fixture'}
 const logs=[]
 const result=await retry.visualRequest(signal=>llm.generateJson({...req,signal}),{...options(new AbortController()),provider,diagnostic:v=>logs.push(v)}, {timeoutMs:1000,random:()=>0,wait:async()=>{}})
 assert.equal(result.ok,true);assert.equal(calls.length,2)
 assert.match(logs[0],/ECONNRESET/)
 if(provider==='gemini'){
  assert.equal(calls[0].config.httpOptions.retryOptions.attempts,1)
  assert.ok(calls[0].config.abortSignal instanceof AbortSignal)
 }else assert.ok(calls[0].init.signal instanceof AbortSignal)
})

test('custom Retry-After is retained; invalid credentials/model/request do not negotiate response formats',async t=>{
 const settings={llmProvider:'custom',llmModels:{custom:'fixture'},customBaseUrl:'http://fixture.invalid'}
 let count=0,status=429,detail='rate limit'
 const load=loader({'main/settings':{getSettings:()=>settings},'main/secrets':{getSecret:()=>null,PROVIDER_NAMES:{custom:'Custom'}},'main/services/gemini':{},'main/services/elevenlabs':{},'main/services/flow2api':{}})
 t.mock.method(globalThis,'fetch',async()=>{count++;return new Response(JSON.stringify({error:{message:detail}}),{status,headers:{'retry-after':'9'}})})
 const llm=load('main/services/llm'),req={system:'s',prompt:'p',schema:{},name:'fixture'}
 await assert.rejects(llm.generateJson(req),e=>e.status===429&&e.retryAfterMs===9000)
 assert.equal(count,1)
 for(const value of [400,401,404]){
  status=value;detail=value===404?'Model does not exist':'Invalid request';count=0
  await assert.rejects(llm.generateJson(req));assert.equal(count,1)
 }
 status=400;detail='response_format json_schema is not supported';count=0
 await assert.rejects(llm.generateJson(req));assert.equal(count,3)
})

test('Gemini forwards Retry-After from SDK HTTP hook and retains permanent HTTP statuses',async()=>{
 const load=loader({
  'main/settings':{getSettings:()=>({})},'main/secrets':{requireSecret:()=> 'fixture-key'},'main/services/audio':{},
  '@google/genai':{GoogleGenAI:class{models={generateContent:async req=>{
    await req.config.httpOptions.fetch('http://fixture.invalid')
    throw Object.assign(new Error('Rate limited'),{status:429})
  }}}}
 })
 const original=globalThis.fetch
 globalThis.fetch=async()=>new Response('{}',{status:429,headers:{'retry-after':'7'}})
 try{
  await assert.rejects(load('main/services/gemini').generateJson('fixture','s','p',{},new AbortController().signal),e=>e.status===429&&e.retryAfterMs===7000)
 }finally{globalThis.fetch=original}
})


test('a delayed Start reply cannot hide an already-running continuity stage or reopen a finished visual job',()=>{
 const store=loader({})('renderer/src/store/project').useProject
 store.setState({project:{id:'project'},jobs:{}})
 const queued={id:'visual-job',projectId:'project',kind:'visuals',status:'queued',progress:0,message:null,createdAt:1,updatedAt:1}
 store.getState().upsertJob({...queued,status:'running',message:'Menyusun continuity plan',updatedAt:2})
 store.getState().upsertJob(queued)
 assert.equal(store.getState().jobs[queued.id].message,'Menyusun continuity plan')
 store.getState().upsertJob({...queued,status:'done',updatedAt:3})
 store.getState().upsertJob({...queued,status:'running',updatedAt:2})
 assert.equal(store.getState().jobs[queued.id].status,'done')
})

test('the latest actionable visual error remains in project bundles beyond the transient job history window',async t=>{
 const s=scenario(t,1)
 const job=s.repo.insertJob({projectId:s.projectId,kind:'visuals',provider:'custom'})
 s.repo.updateJob(job.id,{status:'failed',error:'Resume required'})
 s.db().prepare('UPDATE jobs SET created_at=?,updated_at=? WHERE id=?').run(Date.now()-86400000,Date.now()-86400000,job.id)
 assert.equal(s.repo.getBundle(s.projectId).jobs.find(j=>j.id===job.id).error,'Resume required')
})


test('aggregate transport causes retain their diagnostic code and a blocked endpoint port is permanent',async()=>{
 assert.equal(retry.visualFailure(new TypeError('fetch failed',{cause:new AggregateError([Object.assign(new Error('connect'),{code:'ECONNREFUSED'})])})).code,'ECONNREFUSED')
 let attempts=0
 await assert.rejects(retry.visualRequest(async()=>{attempts++;throw new TypeError('fetch failed',{cause:new Error('bad port')})},options(new AbortController())),/Port endpoint diblokir/)
 assert.equal(attempts,1)
})


test('Gemini permanent HTTP failures cannot be mistaken for response-format negotiation',async()=>{
 for(const status of [401,403,404,413,429,503]){
  let calls=0
  const load=loader({'main/secrets':{requireSecret:()=> 'fixture'},'main/settings':{},'main/services/audio':{},'@google/genai':{GoogleGenAI:class{models={generateContent:async()=>{calls++;throw Object.assign(new Error('schema service unavailable'),{status})}}}}})
  await assert.rejects(load('main/services/gemini').generateJson('fixture','s','p',{},new AbortController().signal),e=>e.status===status)
  assert.equal(calls,1)
 }
})


test('continuity planning uses its own output contract instead of the detailed-scene schema instructions',async t=>{
 const s=scenario(t,1);await s.run()
 const request=s.requests.find(r=>r.name==='continuity')
 assert.match(request.system,/shared continuity bible BEFORE/)
 assert.match(request.system,/Fixture instructions/)
 assert.doesNotMatch(request.system,/only the requested numbered scenes/)
 assert.match(request.system,/world, direction, recurringDesigns, characters, states and conflicts/)
})


test('missing model selection becomes a persistent actionable job error rather than a disappearing startup toast',async t=>{
 const s=scenario(t,1);s.settings.llmModels.custom=''
 const job=s.load('main/visualPlanning').startVisualPlanning(s.projectId,'missing')
 for(let i=0;i<100 && ['queued','running'].includes(s.repo.getJob(job.id).status);i++)await new Promise(r=>setTimeout(r,5))
 const saved=s.repo.getBundle(s.projectId).jobs.find(j=>j.id===job.id)
 assert.equal(saved.status,'failed')
 assert.match(saved.error,/Pilih model/)
 assert.equal(s.requests.length,0)
})


test('compatible nested scene_number/visual/camera responses keep exact scene identity and canonical reference outfits',async t=>{
 const s=scenario(t,14)
 s.setHook((req,result)=>{
  if(req.name!=='visuals')return result
  return {...result,scenes:result.scenes.map(({scene,setting,action,characters,framing,avoid,camera,strength,transition,motion})=>({
   scene_number:scene,story:'Provider story must not replace the reviewed script.',narration:'Provider narration must not replace reviewed words.',
   visual:{setting,action,characters,wardrobe:'reference',framing,avoid},camera:{type:camera,strength},transition,motion
  })).reverse()}
 })
 const original=s.clips().map(c=>[c.id,c.story,c.narration])
 await s.run()
 assert.equal(s.clips().filter(c=>c.visualPrompt).length,14)
 assert.deepEqual(s.clips().map(c=>[c.id,c.story,c.narration]),original)
 assert.ok(s.clips().every(c=>c.characterIds.includes('mara')))
 assert.ok(s.clips().every(c=>c.visualPrompt.includes('Mara - default outfit as on the reference sheet')))
 assert.ok(s.clips().every(c=>c.cameraPreset==='static' && c.motionStrength==='halus'))
})

for(const alias of ['number','setting','strength'])test('conflicting compatible '+alias+' fields are rejected instead of guessing',async t=>{
 const s=scenario(t,2)
 s.setHook((req,result)=>{
  if(req.name==='visuals'){
   const first=result.scenes[0]
   if(alias==='number')first.scene_number=2
   if(alias==='setting')first.visual={setting:'Contradictory setting'}
   if(alias==='strength')first.camera={type:'static',strength:'kuat'}
  }return result
 })
 await assert.rejects(s.run(),/VISUAL_AMBIGUOUS_FIELDS/)
 assert.equal(s.clips().filter(c=>c.visualPrompt).length,0)
})

test('unsupported wardrobe prose is rejected clearly instead of silently assigning a default outfit',async t=>{
 const s=scenario(t,1)
 s.setHook((req,result)=>{if(req.name==='visuals')result.scenes[0].wardrobe='A completely different costume';return result})
 await assert.rejects(s.run(),/VISUAL_WARDROBE/)
 assert.equal(s.clips()[0].visualPrompt,'')
})

test('domain validation preserves a useful field reason without leaking the response or retrying it',async()=>{
 const {VisualValidationError}=retry
 let attempts=0
 await assert.rejects(retry.visualRequest(async()=>{attempts++;throw new VisualValidationError('VISUAL_ENUM','Adegan 4: nilai camera tidak didukung.')},options(new AbortController())),e=>{
  assert.match(e.message,/Adegan 4: nilai camera tidak didukung/)
  assert.match(e.message,/VISUAL_ENUM/)
  return true
 })
 assert.equal(attempts,1)
})

test('strict compatible requests include the exact schema in model-visible instructions even if the route ignores response_format',async t=>{
 const settings={llmProvider:'custom',llmModels:{custom:'fixture'},customBaseUrl:'http://fixture.invalid'}
 let sent
 const load=loader({'main/settings':{getSettings:()=>settings},'main/secrets':{getSecret:()=>null,PROVIDER_NAMES:{custom:'Custom'}},'main/services/gemini':{},'main/services/elevenlabs':{},'main/services/flow2api':{}})
 t.mock.method(globalThis,'fetch',async(url,init)=>{sent=JSON.parse(init.body);return new Response(JSON.stringify({choices:[{message:{content:'{"scenes":[]}'}}]}),{status:200})})
 const schema={type:'object',properties:{scenes:{type:'array',items:{type:'object',properties:{scene:{type:'integer'}}}}},required:['scenes']}
 await load('main/services/llm').generateJson({system:'An old example uses scene_number.',prompt:'fixture',schema,name:'visuals'})
 assert.equal(sent.response_format.type,'json_schema')
 assert.ok(sent.messages[0].content.includes(JSON.stringify(schema)))
 assert.ok(sent.messages[0].content.indexOf('Required wire format')>sent.messages[0].content.indexOf('scene_number'))
})


test('continuity review distinguishes omitted reversible transitions but still rejects explicit conflicts with an actionable reason',async t=>{
 const s=scenario(t,2)
 s.setHook((req,result)=>{
  if(req.name==='continuity_review'){
   assert.match(req.system,/omitted reversible transition/)
   assert.match(req.system,/do not invent new powers/)
   assert.match(req.system,/Reject explicit contradictions/)
   return {consistent:false,issues:['Adegan 2: pakaian berubah tanpa peristiwa dalam naskah.']}
  }
  return result
 })
 await assert.rejects(s.run(),/Adegan 2: pakaian berubah/)
 assert.equal(s.clips().filter(c=>c.visualPrompt).length,0)
})


test('a rejected later batch is corrected with its findings and immutable plan without regenerating the first 24 prompts',async t=>{
 const s=scenario(t,37);let approved,repairSeen=false
 const issue='Adegan 36: keadaan masuk meminta soaked gloves; tangan terbuka bertentangan dengan rencana.'
 s.setHook((req,result)=>{
  if(req.name==='visuals' && result.scenes[0].scene===25){
   approved ??= s.clips().slice(0,24).map(c=>[c.id,c.visualPrompt,c.videoPrompt])
   assert.equal(approved.filter(c=>c[1]).length,24)
   if(req.prompt.includes('Rejected draft and review findings:')){
    repairSeen=true;assert.ok(req.prompt.includes(issue));assert.match(req.prompt,/SAME immutable plan/)
    assert.match(req.prompt,/scene-specific outfit adjustment/)
    result.scenes.at(-1).action='Mara touches the screen with soaked gloves while carrying the key.'
    result.scenes.at(-1).motion='Her soaked gloves move over the screen.'
   }else result.scenes.at(-1).action='Mara touches the screen with bare wet fingers.'
  }
  if(req.name==='continuity_review'){
   const {scenes}=JSON.parse(req.prompt),last=scenes.find(c=>c.scene===36)
   if(last && !(last.visualPrompt.includes('soaked gloves') && last.videoPrompt.includes('soaked gloves')))
    return {consistent:false,issues:[issue]}
  }
  return result
 })
 await s.run()
 assert.ok(repairSeen);assert.equal(s.clips().filter(c=>c.visualPrompt).length,37)
 assert.deepEqual(s.clips().slice(0,24).map(c=>[c.id,c.visualPrompt,c.videoPrompt]),approved)
 assert.deepEqual(s.numbers().map(n=>[n[0],n.at(-1)]),[[1,12],[13,24],[25,36],[25,36],[37,37]])
 assert.equal(s.requests.filter(r=>r.name==='continuity').length,1)
 assert.equal(s.state().repair,undefined)
})

test('persistent semantic conflicts stop after two corrections and Resume retains draft feedback without changing the plan',async t=>{
 const s=scenario(t,13);const issue='Adegan 13: '+ 'The planned gloves must remain visible. '.repeat(20)
 s.setHook((req,result)=>req.name==='continuity_review' && JSON.parse(req.prompt).scenes[0].scene===13?{consistent:false,issues:[issue]}:result)
 await assert.rejects(s.run(),/setelah 2 perbaikan otomatis/)
 assert.equal(s.clips().filter(c=>c.visualPrompt).length,12)
 assert.deepEqual(s.numbers().map(n=>n[0]),[1,13,13,13])
 assert.equal(s.state().repair.draft.issues[0],issue.trim())
 const version=s.state().version,approved=s.clips().slice(0,12).map(c=>c.visualPrompt)
 s.restart();s.setHook((req,result)=>{
  if(req.name==='visuals'){assert.ok(req.prompt.includes(issue.trim()));assert.ok(req.prompt.includes('Rejected draft and review findings:'))}
  return result
 })
 await s.run()
 assert.equal(s.state().version,version);assert.equal(s.state().repair,undefined)
 assert.deepEqual(s.clips().slice(0,12).map(c=>c.visualPrompt),approved)
 assert.equal(s.requests.filter(r=>r.name==='continuity').length,1)
})

test('cancel during correction keeps the draft separate and restart resumes with its review feedback',async t=>{
 const s=scenario(t,1),ctrl=new AbortController()
 s.setHook((req,result)=>{
  if(req.name==='continuity_review')return {consistent:false,issues:['Adegan 1: sarung tangan wajib terlihat.']}
  if(req.name==='visuals' && req.prompt.includes('Rejected draft and review findings:'))ctrl.abort()
  return result
 })
 await assert.rejects(s.run('missing',ctrl))
 assert.equal(s.clips()[0].visualPrompt,'');assert.ok(s.state().repair)
 s.restart();s.setHook((req,result)=>{if(req.name==='visuals')assert.match(req.prompt,/sarung tangan wajib/);return result})
 await s.run();assert.ok(s.clips()[0].visualPrompt);assert.equal(s.state().repair,undefined)
})

test('a manual prompt after rejection changes the pending batch and discards stale repair feedback',async t=>{
 const s=scenario(t,2)
 s.setHook((req,result)=>req.name==='continuity_review'?{consistent:false,issues:['Old rejected batch']}:result)
 await assert.rejects(s.run())
 const first=s.clips()[0];s.db().prepare('UPDATE clips SET visual_prompt=? WHERE id=?').run('MANUAL APPROVED',first.id)
 s.setHook((req,result)=>{if(req.name==='visuals')assert.ok(!req.prompt.includes('Rejected draft and review findings:'));return result})
 await s.run();assert.equal(s.clips()[0].visualPrompt,'MANUAL APPROVED');assert.equal(s.state().repair,undefined)
})

test('malformed review data and permanent provider failures cannot trigger semantic corrections',async t=>{
 for(const kind of ['malformed','http']){
  const s=scenario(t,1)
  s.setHook((req,result)=>{if(req.name==='continuity_review'){
   if(kind==='http')throw Object.assign(new Error('fixture unauthorized'),{status:401})
   return {consistent:false,issues:[null]}
  }return result})
  await assert.rejects(s.run(),kind==='http'?/HTTP 401/:/VISUAL_REVIEW_RESPONSE/)
  assert.equal(s.numbers().length,1);assert.equal(s.state().repair,undefined);assert.equal(s.clips()[0].visualPrompt,'')
 }
})


test('project prompt snapshots survive preset edit/deletion, restart, duplicate and ordinary saves',async t=>{
 const s=scenario(t,1),helper=s.load('shared/promptPresets'),base=helper.ORIGINAL_PROMPT_PRESET
 s.settings.promptPresets=[{...base,id:'a',name:'Channel A',scriptInstructionsMode:'custom',scriptInstructions:'CHANNEL_A'},{...base,id:'b',name:'Channel B',scriptInstructionsMode:'custom',scriptInstructions:'CHANNEL_B'}]
 const a=s.repo.createProject({promptPresetId:'a'}),b=s.repo.createProject({promptPresetId:'b'}),original=s.repo.createProject({promptPresetId:'original'})
 s.settings.promptPresets[0].scriptInstructions='NEW_RULES';s.settings.promptPresets=[]
 s.settings.scriptInstructions='GLOBAL_RULES'
 assert.equal(s.repo.getProject(a.id).promptProfile.scriptInstructions,'CHANNEL_A')
 assert.equal(s.repo.getProject(b.id).promptProfile.scriptInstructions,'CHANNEL_B')
 assert.equal(s.repo.getProject(original.id).promptProfile.scriptInstructionsMode,'original')
 assert.throws(()=>s.repo.createProject({promptPresetId:'deleted'}),/tidak ditemukan/)
 const copy=s.repo.duplicateProject(a.id)
 assert.deepEqual(s.repo.getProject(copy.id).promptProfile,a.promptProfile)
 s.repo.saveSnapshot({project:{...a,promptProfile:b.promptProfile},characters:[],clips:[]})
 assert.deepEqual(s.repo.getProject(a.id).promptProfile,a.promptProfile,'Autosave must never replace the chosen prompt snapshot')
 s.restart();assert.deepEqual(s.repo.getProject(a.id).promptProfile,a.promptProfile)
 assert.equal(s.repo.getProject(s.projectId).promptProfile,null,'Legacy API callers retain their previous global settings')
})

test('editing a preset library cannot invalidate a pinned project continuity plan or completed prompts',async t=>{
 const s=scenario(t,2),helper=s.load('shared/promptPresets'),profile={...helper.ORIGINAL_PROMPT_PRESET,id:'a',name:'Channel A',visualInstructionsMode:'custom',visualInstructions:'CHANNEL_A_CONTINUITY'}
 s.db().prepare('UPDATE projects SET prompt_profile_json=? WHERE id=?').run(JSON.stringify(profile),s.projectId)
 await s.run();const version=s.state().version,requests=s.requests.length,before=s.clips().map(c=>c.visualPrompt)
 assert.match(s.requests.find(r=>r.name==='visuals').system,/CHANNEL_A_CONTINUITY/)
 s.settings.promptPresets=[];s.settings.visualInstructions='OTHER_CHANNEL';s.settings.visualStyleOverrides={anime:{mode:'custom',prompt:'OTHER_ART',characterHint:'OTHER_CHARACTER'}}
 await s.run()
 assert.equal(s.state().version,version);assert.equal(s.requests.length,requests);assert.deepEqual(s.clips().map(c=>c.visualPrompt),before)
})


test('initial conflicts are corrected and independently reviewed before saving; rules and audit survive restart',async t=>{
 const s=scenario(t,2),original=s.clips()[0]
 const edit={scene:1,story:'Mara carries the key in her blue coat.',narration:'She keeps the key.',visualPrompt:'',videoPrompt:'',reason:'Memperjelas pemilik kunci sesuai plan.'}
 s.setHook((req,result)=>{
  if(req.name==='continuity')result.conflicts=['Adegan 1: kepemilikan kunci perlu diperjelas.']
  if(req.name==='continuity_repair')return {edits:[edit]}
  if(req.name==='continuity_repair_review'){
   assert.equal(s.clips()[0].story,original.story,'A proposal must not be committed before review')
   assert.match(req.prompt,/Mara carries the key in her blue coat/)
   return {consistent:true,issues:[],resolutions:[{conflict:1,note:'Kepemilikan kunci sudah konsisten.'}]}
  }
  return result
 })
 await s.run()
 assert.equal(s.clips()[0].story,edit.story);assert.equal(s.clips()[0].narration,edit.narration)
 const state=s.state();assert.deepEqual(state.plan.conflicts,[]);assert.equal(state.plan.world,'A coastal town in 2040.')
 assert.equal(state.corrections.length,1);assert.equal(state.corrections[0].changes[0].before,original.story)
 assert.equal(state.corrections[0].changes[0].after,edit.story)
 assert.equal(s.requests.filter(r=>r.name==='continuity').length,1)
 s.restart();assert.deepEqual(s.repo.getBundle(s.projectId).visualCorrections,state.corrections)
 const n=s.requests.length;await s.run();assert.equal(s.requests.length,n,'Successful review must not repeat or regenerate the plan')
})

test('an informational finding can be cleared only by an independent review covering every original finding',async t=>{
 const s=scenario(t,1),before=s.clips()[0]
 s.setHook((req,result)=>{
  if(req.name==='continuity')result.conflicts=['Envelope is already handed over after police documentation.']
  if(req.name==='continuity_repair_review')return {consistent:true,issues:[],resolutions:[{conflict:1,note:'Naskah sudah menyatakan serah terima setelah dokumentasi.'}]}
  return result
 })
 await s.run();assert.equal(s.clips()[0].story,before.story);assert.equal(s.clips()[0].narration,before.narration)
 assert.equal(s.state().corrections[0].changes.length,0);assert.deepEqual(s.state().plan.conflicts,[])
})

for(const failure of ['rejected','malformed','missing-resolution','duplicate-scene','http','cancel','manual-edit'])test('continuity correction '+failure+' preserves original input and cannot clear the strict plan',async t=>{
 const s=scenario(t,2),before=s.clips()[0],ctrl=new AbortController()
 const edit={scene:1,story:'A proposed correction.',narration:before.narration,visualPrompt:'',videoPrompt:'',reason:'Fix'}
 s.setHook((req,result)=>{
  if(req.name==='continuity')result.conflicts=['Strict finding']
  if(req.name==='continuity_repair'){
   if(failure==='http')throw Object.assign(new Error('denied'),{status:401})
   if(failure==='cancel')ctrl.abort()
   if(failure==='duplicate-scene')return {edits:[edit,edit]}
   return {edits:[edit]}
  }
  if(req.name==='continuity_repair_review'){
   if(failure==='rejected')return result
   if(failure==='malformed')return {consistent:'yes',issues:[],resolutions:[]}
   if(failure==='manual-edit')s.db().prepare('UPDATE clips SET visual_prompt=? WHERE id=?').run('USER EDIT',before.id)
   return {consistent:true,issues:[],resolutions:failure==='missing-resolution'?[]:[{conflict:1,note:'Resolved'}]}
  }
  return result
 })
 await assert.rejects(s.run('missing',ctrl))
 assert.equal(s.clips()[0].story,before.story);assert.equal(s.clips()[0].narration,before.narration)
 assert.deepEqual(s.state().plan.conflicts,['Strict finding']);assert.equal(s.state().corrections?.length??0,0)
 assert.equal(s.requests.filter(r=>r.name==='continuity_repair').length,failure==='rejected'?2:1)
 if(failure==='manual-edit')assert.equal(s.clips()[0].visualPrompt,'USER EDIT')
})

test('a correction detaches obsolete media without deleting history, and a later failure cannot lose its audit',async t=>{
 const s=scenario(t,1),c=s.clips()[0]
 const a=s.repo.insertAsset({projectId:s.projectId,clipId:c.id,kind:'audio',provider:'fixture',localPath:'keep.wav'})
 s.repo.patchClip(c.id,{audioAssetId:a.id})
 s.setHook((req,result)=>{
  if(req.name==='continuity')result.conflicts=['Narration contradicts the blue coat.']
  if(req.name==='continuity_repair')return {edits:[{scene:1,story:c.story,narration:'She wears a blue coat.',visualPrompt:'',videoPrompt:'',reason:'Match plan'}]}
  if(req.name==='continuity_repair_review')return {consistent:true,issues:[],resolutions:[{conflict:1,note:'Narration now follows the strict wardrobe.'}]}
  if(req.name==='visuals')throw Object.assign(new Error('denied'),{status:401})
  return result
 })
 await assert.rejects(s.run(),/HTTP 401/)
 assert.equal(s.clips()[0].audioAssetId,null);assert.ok(s.repo.getAsset(a.id),'Old audio must remain recoverable')
 assert.ok(s.state().corrections[0].changes.some(c=>c.field==='audioAssetId'))
 s.restart();const version=s.state().version;s.setHook(null);await s.run()
 assert.equal(s.state().version,version);assert.equal(s.state().corrections.length,1)
})


test('reviewed prompt-only correction is retained without paying for a redundant visual batch',async t=>{
 const s=scenario(t,2),c=s.clips()[0]
 s.db().prepare('UPDATE clips SET visual_prompt=?,video_prompt=?,visual_source=story WHERE id=?').run('Wrong red coat','Red coat moves',c.id)
 s.setHook((req,result)=>{
  if(req.name==='continuity')result.conflicts=['Adegan 1 prompt memakai mantel merah.']
  if(req.name==='continuity_repair')return {edits:[{scene:1,story:c.story,narration:c.narration,visualPrompt:'Mara wears her blue coat.',videoPrompt:'The blue coat moves.',reason:'Blue coat required'}]}
  if(req.name==='continuity_repair_review')return {consistent:true,issues:[],resolutions:[{conflict:1,note:'Blue coat restored'}]}
  return result
 })
 await s.run();assert.equal(s.clips()[0].visualPrompt,'Mara wears her blue coat.');assert.deepEqual(s.numbers(),[[2]])
})

test('a database failure rolls back corrected script and audit together',async t=>{
 const s=scenario(t,1),c=s.clips()[0]
 s.db().exec("CREATE TRIGGER reject_correction BEFORE UPDATE OF narration ON clips BEGIN SELECT RAISE(ABORT, 'fixture correction disk failure'); END")
 s.setHook((req,result)=>{
  if(req.name==='continuity')result.conflicts=['Strict finding']
  if(req.name==='continuity_repair')return {edits:[{scene:1,story:'Corrected story',narration:'Corrected narration',visualPrompt:'',videoPrompt:'',reason:'Fix'}]}
  if(req.name==='continuity_repair_review')return {consistent:true,issues:[],resolutions:[{conflict:1,note:'Resolved'}]}
  return result
 })
 await assert.rejects(s.run(),/fixture correction disk failure/)
 assert.equal(s.clips()[0].story,c.story);assert.equal(s.clips()[0].narration,c.narration)
 assert.deepEqual(s.state().plan.conflicts,['Strict finding']);assert.equal(s.state().corrections?.length??0,0)
})


test('a contradictory plan is aligned before scene repair, reviewed, versioned and audited without changing world or references',async t=>{
 const s=scenario(t,2),before=s.clips()[0];let original
 s.setHook((req,result)=>{
  if(req.name==='continuity') {result.states[0].entering='Mara has no key.';result.conflicts=['Key ownership contradicts the scene.'];original=structuredClone(result)}
  if(req.name==='continuity_plan_review'){
   const {candidate}=JSON.parse(req.prompt.split('\n').at(-1))
   return candidate.states[0].entering==='Mara has no key.'?{consistent:false,issues:['Plan says no key while its leaving state requires the key.'],notes:[]}:{consistent:true,issues:[],notes:['The scene explicitly retains the key.']}
  }
  if(req.name==='continuity_plan_align') {const plan=structuredClone(original);plan.states[0].entering='Mara wears a blue coat and carries the key.';return {plan,reason:'Correct the derived ownership state.'}}
  if(req.name==='continuity_repair_review')return {consistent:true,issues:[],resolutions:[{conflict:1,note:'Ownership is already explicit; no scene change required.'}]}
  return result
 })
 await s.run();assert.equal(s.clips()[0].story,before.story)
 const state=s.state();assert.equal(state.plan.states[0].entering,'Mara wears a blue coat and carries the key.')
 assert.equal(state.plan.world,original.world);assert.deepEqual(state.plan.characters,original.characters)
 const audit=state.corrections[0];assert.notEqual(audit.planRevision.from,audit.planRevision.to);assert.equal(audit.version,state.version)
 assert.equal(audit.changes[0].before,'Mara has no key.');assert.equal(audit.changes[0].field,'plan.entering')
 assert.deepEqual(s.requests.filter(r=>r.name.startsWith('continuity_plan')).map(r=>r.name),['continuity_plan_review','continuity_plan_align','continuity_plan_review'])
 const count=s.requests.length;s.restart();await s.run();assert.equal(s.requests.length,count);assert.deepEqual(s.repo.getBundle(s.projectId).visualCorrections,state.corrections)
})

for(const failure of ['still-contradictory','malformed-review','changed-world','changed-character','missing-scene','removed-conflict','http','cancel','manual-edit','database'])test('failed plan alignment '+failure+' cannot replace the old plan or silently alter a scene',async t=>{
 const s=scenario(t,2),before=s.clips()[0],ctrl=new AbortController();let original,reviewCount=0
 if(failure==='database')s.db().exec("CREATE TRIGGER reject_plan_revision BEFORE UPDATE OF state_json ON visual_plans WHEN NEW.state_json LIKE '%planRevision%' BEGIN SELECT RAISE(ABORT, 'fixture plan disk failure'); END")
 s.setHook((req,result)=>{
  if(req.name==='continuity') {result.conflicts=['Original finding'];original=structuredClone(result)}
  if(req.name==='continuity_plan_review') {
   reviewCount++
   if(reviewCount===1||failure==='still-contradictory')return {consistent:false,issues:['Internal contradiction'],notes:[]}
   if(failure==='malformed-review')return {consistent:true,issues:[],notes:[]}
   if(failure==='manual-edit')s.db().prepare('UPDATE clips SET visual_prompt=? WHERE id=?').run('USER EDIT',before.id)
   return {consistent:true,issues:[],notes:['Reviewed']}
  }
  if(req.name==='continuity_plan_align'){
   if(failure==='http')throw Object.assign(new Error('denied'),{status:401})
   if(failure==='cancel')ctrl.abort()
   const plan=structuredClone(original);plan.states[0].entering='Corrected explicit key state.'
   if(failure==='changed-world')plan.world='Another planet'
   if(failure==='changed-character')plan.characters[0].description='Different identity'
   if(failure==='missing-scene')plan.states.pop()
   if(failure==='removed-conflict')plan.conflicts=[]
   return {plan,reason:'Resolve internal contradiction'}
  }
  return result
 })
 await assert.rejects(s.run('missing',ctrl));assert.deepEqual(s.state().plan,original)
 assert.equal(s.state().corrections?.length??0,0);assert.equal(s.clips()[0].story,before.story)
 assert.equal(s.requests.filter(r=>r.name==='continuity_plan_align').length,failure==='still-contradictory'?2:1)
 if(failure==='manual-edit')assert.equal(s.clips()[0].visualPrompt,'USER EDIT')
})

test('plan revision preserves completed unaffected batches and manual prompts while regenerating only affected AI output',async t=>{
 const s=scenario(t,3);await s.run();const before=s.state(),original=structuredClone(before.plan)
 const changed=structuredClone(before);delete changed.planReviewed;changed.plan.conflicts=['State 2 contradicts source.']
 s.db().prepare('UPDATE visual_plans SET state_json=? WHERE project_id=?').run(JSON.stringify(changed),s.projectId)
 s.db().prepare('UPDATE clips SET visual_prompt=? WHERE sort=0').run('MANUAL PRESERVED')
 s.setHook((req,result)=>{
  if(req.name==='continuity_plan_review')return {consistent:JSON.parse(req.prompt.split('\n').at(-1)).candidate.states[1].entering==='Reconciled scene 2 state.',issues:JSON.parse(req.prompt.split('\n').at(-1)).candidate.states[1].entering==='Reconciled scene 2 state.'?[]:['Internal contradiction'],notes:['Review result']}
  if(req.name==='continuity_plan_align'){const plan=structuredClone(changed.plan);plan.states[1].entering='Reconciled scene 2 state.';return {plan,reason:'Source reconciliation'}}
  if(req.name==='continuity_repair_review')return {consistent:true,issues:[],resolutions:[{conflict:1,note:'Reconciled'}]}
  return result
 })
 const calls=s.requests.length;await s.run()
 assert.equal(s.clips()[0].visualPrompt,'MANUAL PRESERVED');assert.notEqual(s.state().version,before.version)
 assert.deepEqual(s.requests.slice(calls).filter(r=>r.name==='visuals').map(r=>/Write visuals for these scenes only: ([\d, ]+)/.exec(r.prompt)[1].split(',').map(Number)),[[2]])
 assert.equal(s.state().plan.world,original.world)
})
