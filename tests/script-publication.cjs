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
    if(base.endsWith('.json'))return base
    return fs.existsSync(base + '.ts') ? base + '.ts' : path.join(base, 'index.ts')
  }
  function load(file) {
    const full = resolve(file)
    if(full.endsWith('.json'))return JSON.parse(fs.readFileSync(full,'utf8'))
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

function fixture(t, total=25) {
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bang-script-publication-'))
 const settings={defaultTtsProvider:'gemini',defaultLanguage:'en',imageModel:'flow2api:fixture-landscape',videoModel:'video',llmProvider:'custom',llmModels:{custom:'fixture'},scriptInstructionsMode:'custom',scriptInstructions:'Keep Mara and the key consistent.',visualStyleOverrides:{},customBaseUrl:'http://fixture.invalid'}
 let hook=null, repo, id
 const requests=[], tasks=[], images=[]
 const ctx={jobId:'fixture',signal:new AbortController().signal,progress(){},setRemote(){}}
 const mocks={
  'better-sqlite3':Sqlite,
  'main/paths':{dbPath:()=>path.join(dir,'test.sqlite'),projectDir:()=>dir,assetUrl:()=>'',projectsRoot:()=>dir,assetAbsPath:(id,rel)=>path.join(dir,rel)},
  'main/settings':{getSettings:()=>settings},'main/events':{emit:new Proxy({},{get:()=>()=>{}})},
  'main/services/higgsfield':{cancelRequest:async()=>{},submit:async()=> 'request',waitForResult:async()=>({images:[{url:'https://fixture.invalid/image.png'}]})},
  'main/services/audio':{probeSize:async()=>({width:1280,height:720}),probeDurationMs:async()=>5000},
  'main/services/http':{downloadTo:async()=>({bytes:Buffer.from('fixture image'),contentType:'image/png'})},
  'main/services/flow2api':{generate:async(model,prompt,refs)=>{images.push({model,prompt,refs});return {bytes:Buffer.from('fixture image'),contentType:'image/png',url:null}}},
  'main/services/gemini':{}, 'main/services/elevenlabs':{},
  'main/jobs':{runJob:(job,queue,fn)=>{tasks.push(async()=>{try {const result=await fn(ctx);repo.updateJob(job.id,{status:'done',...(typeof result==='string'?{resultAssetId:result}:{})})} catch(e){repo.updateJob(job.id,{status:'failed'});throw e}});return job}},
  'main/services/llm':{activeLlm:()=>({provider:settings.llmProvider,model:'fixture'}),generateJson:async req=>{
   requests.push(req)
   if(hook){const value=await hook(req);if(value!==undefined)return value}
   if(req.name==='script_outline')return {title:'Mara and the key',beats:Array.from({length:total},(_,i)=>'Mara carries the key through beat '+(i+1))}
   if(req.name==='publication')return {title:'Can you return this key?',description:'Mara crosses the coast. What would you do? Like and subscribe.',thumbnailPrompt:'Mara holds a brass key at the lighthouse, warm illustrated style.'}
   const [,count,start]=/Write exactly (\d+) scenes, ONLY scene numbers (\d+)/.exec(req.prompt)
   return {title:'Mara',scenes:Array.from({length:+count},(_,i)=>({title:'Scene '+(+start+i),story:'Mara keeps her brass key '+(+start+i),narration:'Mara walks toward the lighthouse '+(+start+i)}))}
  }}
 }
 const load=loader(mocks), dbApi=load('main/db');repo=load('main/repo')
 id=repo.createProject({synopsis:'Mara carries a key to the lighthouse.'}).id
 const db=()=>dbApi.getDb()
 db().prepare('UPDATE projects SET duration_sec=?,image_model=? WHERE id=?').run(total*5.5,settings.imageModel,id)
 repo.replaceScript(id,'Approved original',[{title:'Approved',story:'Original story',narration:'Original narration',durationMs:5000}])
 t.after(()=>{dbApi.closeDb();fs.rmSync(dir,{recursive:true,force:true})})
 return {load,repo,id,db,settings,requests,tasks,ctx,images,hook:fn=>hook=fn,
  run:(mode='resume',context=ctx)=>load('main/scriptPlanning').executeScriptPlanning(id,mode,context),
  draft:()=>JSON.parse(db().prepare('SELECT state_json FROM script_drafts WHERE project_id=?').get(id).state_json),
  restart:()=>{dbApi.closeDb();load.fresh('main/scriptPlanning')},
  ranges:()=>requests.filter(r=>r.name==='script').map(r=>/ONLY scene numbers (\d+) through (\d+)/.exec(r.prompt).slice(1).map(Number))}
}

test('a later failed batch never destroys approved media; restart resumes only unfinished scenes with the same outline',async t=>{
 const s=fixture(t);let fail=true
 s.hook(req=>{if(req.name==='script'&&req.prompt.includes('numbers 13 through')&&fail)throw Object.assign(new Error('denied'),{status:401})})
 await assert.rejects(s.run(),/Periksa kunci/)
 assert.equal(s.draft().scenes.length,12)
 assert.equal(s.repo.clipsOf(s.id)[0].narration,'Original narration')
 const outline=s.draft().outline
 fail=false;s.restart();await s.run()
 assert.deepEqual(s.ranges(),[[1,12],[13,24],[13,24],[25,25]])
 assert.equal(s.requests.filter(r=>r.name==='script_outline').length,1)
 for(const r of s.requests.filter(r=>r.name==='script'))assert.ok(r.prompt.includes(JSON.stringify(outline)))
 assert.match(s.requests.filter(r=>r.name==='script').at(-1).prompt,/Mara walks toward the lighthouse 24/)
 assert.equal(s.repo.clipsOf(s.id).length,25)
 assert.equal(s.db().prepare('SELECT count(*) n FROM script_drafts').get().n,0)
})

test('canceling an in-flight batch preserves earlier batches, then changed input invalidates that draft',async t=>{
 const s=fixture(t),ctrl=new AbortController()
 s.hook(req=>{if(req.name==='script'&&req.prompt.includes('numbers 13 through'))ctrl.abort()})
 await assert.rejects(s.run('resume',{...s.ctx,signal:ctrl.signal}))
 assert.equal(s.draft().scenes.length,12)
 s.hook(null);s.db().prepare('UPDATE projects SET synopsis=? WHERE id=?').run('Mara returns the key to a new harbor.',s.id)
 await s.run();assert.deepEqual(s.ranges().at(-3),[1,12]);assert.equal(s.requests.filter(r=>r.name==='script_outline').length,2)
})

test('invalid scene counts fail visibly rather than silently shortening the script',async t=>{
 const s=fixture(t)
 s.hook(req=>req.name==='script'?{title:'Bad',scenes:[]}:undefined)
 await assert.rejects(s.run(),/Batch adegan 1â€“12 belum lengkap/)
 assert.equal(s.draft().scenes.length,0);assert.equal(s.repo.clipsOf(s.id).length,1)
})

test('duplicate starts share one job and saving edits is blocked while the script owns the project',t=>{
 const s=fixture(t),api=s.load('main/scriptPlanning')
 const a=api.startScriptPlanning(s.id),b=api.startScriptPlanning(s.id)
 assert.equal(a.id,b.id);assert.equal(s.tasks.length,1)
 assert.throws(()=>s.repo.saveSnapshot({project:{id:s.id}}),/Batalkan dulu/)
})

test('manual scene edits during a provider call reject stale output instead of overwriting the edit',async t=>{
 const s=fixture(t)
 s.hook(req=>{if(req.name==='script')s.db().prepare('UPDATE clips SET narration=? WHERE project_id=?').run('Manual decision',s.id)})
 await assert.rejects(s.run(),/berubah/)
 assert.equal(s.repo.clipsOf(s.id)[0].narration,'Manual decision');assert.equal(s.draft().scenes.length,0)
})

test('publication uses the actual content, persists edits, and marks changed content stale without changing any clips',async t=>{
 const s=fixture(t),api=s.load('main/publication'),before=s.repo.clipsOf(s.id)
 const job=api.generatePublication(s.id);assert.equal(api.generatePublication(s.id).id,job.id)
 await s.tasks.at(-1)()
 const request=s.requests.find(r=>r.name==='publication')
 assert.match(request.system,/quoted on-image headline/);assert.match(request.prompt,/2–5 punchy words/);assert.match(request.prompt,/at most 350 characters/);
 assert.match(request.prompt,/Original narration/);assert.match(request.prompt,/artStyle/)
 const saved=api.savePublication(s.id,{...api.getPublication(s.id),description:'My own description'})
 assert.equal(saved.stale,false);assert.equal(api.getPublication(s.id).description,'My own description')
 assert.deepEqual(s.repo.clipsOf(s.id),before)
 const duplicate=s.repo.duplicateProject(s.id);assert.equal(api.getPublication(duplicate.id).description,'My own description')
 s.db().prepare('UPDATE projects SET aspect_ratio=? WHERE id=?').run('9:16',s.id)
 assert.equal(api.getPublication(s.id).stale,true)
})

for(const provider of ['flow','higgsfield'])test(provider+' thumbnails stay outside clips, cover and timeline, using project style',async t=>{
 const s=fixture(t),pub=s.load('main/publication')
 if(provider==='higgsfield')s.db().prepare('UPDATE projects SET image_model=NULL WHERE id=?').run(s.id)
 pub.savePublication(s.id,{title:'Mara',description:'Mara at the coast.',thumbnailPrompt:'Mara holding a key beside the lighthouse. TEXT: "THE KEY?" in large bold letters.'})
 const before=s.repo.clipsOf(s.id),cover=s.repo.getProject(s.id).coverAssetId
 const generation=s.load('main/generation'),job=generation.generateThumbnail(s.id)
 assert.equal(generation.generateThumbnail(s.id).id,job.id)
 await s.tasks.at(-1)()
 const bundle=s.repo.getBundle(s.id),image=bundle.assets.find(a=>a.meta.purpose==='thumbnail')
 assert.ok(image);assert.equal(image.clipId,null);assert.equal(image.characterId,null)
 assert.deepEqual(bundle.clips,before);assert.equal(bundle.project.coverAssetId,cover)
 assert.match(image.prompt,/Art style:/);assert.match(image.prompt,/Standalone thumbnail/);assert.match(image.prompt,/exact quoted hook headline/);assert.match(image.prompt,/THE KEY\?/);assert.doesNotMatch(image.prompt,/No storyboard panels, lettering/)
 assert.equal(image.provider,provider==='flow'?'flow2api':'higgsfield')
})

for(const [aspect,limit] of [['16:9',350],['9:16',220]])test('generated '+aspect+' descriptions reject long recaps while preserving previous material',async t=>{
 const s=fixture(t),api=s.load('main/publication')
 s.db().prepare('UPDATE projects SET aspect_ratio=? WHERE id=?').run(aspect,s.id)
 api.savePublication(s.id,{title:'Approved',description:'Keep this concise hook.',thumbnailPrompt:'Approved concept'})
 s.hook(req=>req.name==='publication'?{title:'New',description:'x'.repeat(limit+1),thumbnailPrompt:'TEXT: "THE KEY?". Bold lettering beside the lighthouse.'}:undefined)
 api.generatePublication(s.id)
 await assert.rejects(s.tasks.at(-1)(),/melebihi batas/)
 assert.equal(api.getPublication(s.id).description,'Keep this concise hook.')
 assert.equal(s.requests.at(-1).schema.properties.description.maxLength,limit)
})
