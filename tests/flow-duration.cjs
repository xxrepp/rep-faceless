const {test}=require('node:test')
const assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),ts=require('typescript')
function load(file,mocks={},expose='') {
 const module={exports:{}}
 const js=ts.transpileModule(fs.readFileSync(path.join(__dirname,'../src',file),'utf8')+expose,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023,jsx:ts.JsxEmit.ReactJSX}}).outputText
 new Function('require','module','exports',js)(name=>name === '@shared/promptPresets' ? load('shared/promptPresets.ts') : mocks[name]??require(name),module,module.exports)
 return module.exports
}
const media=load('shared/media.ts',{'./higgsfield':{}})
const timeline=load('shared/timeline.ts')
const catalog=[]
for(const family of ['omni-1.1-flash','veo-3.1-fast-i2v','veo-3.1-quality-i2v'])
 for(const direction of ['landscape','portrait'])
  for(const seconds of family.startsWith('omni')?[4,6,8,10]:[4,6,8])catalog.push(`${family}-${seconds}s-${direction}`)

test('each scene chooses its nearest advertised duration rather than the selected six-second alias',()=>{
 const selected='flow2api:omni-1.1-flash-6s-landscape'
 for(const [voice,seconds] of [[4,4],[8,8],[4.5,4],[5.5,6],[5,6],[7,8],[9.8,10],[20,10]])
  assert.equal(media.flowVideoModelForDuration(selected,'16:9',voice,catalog),`flow2api:omni-1.1-flash-${seconds}s-landscape`)
})

test('duration selection preserves family, first-frame mode and project orientation',()=>{
 assert.equal(media.flowVideoModelForDuration('flow2api:veo-3.1-fast-i2v-6s-landscape','9:16',8,catalog),'flow2api:veo-3.1-fast-i2v-8s-portrait')
 assert.equal(media.flowVideoModelForDuration('flow2api:veo-3.1-quality-i2v-6s-portrait','16:9',4,catalog),'flow2api:veo-3.1-quality-i2v-4s-landscape')
 assert.equal(media.flowVideoModelForDuration('flow2api:omni-1.1-flash','9:16',4,catalog),'flow2api:omni-1.1-flash-4s-portrait')
})

test('missing durations are never invented and another family cannot be substituted',()=>{
 const selected='flow2api:veo-3.1-fast-i2v-6s-landscape'
 const older=catalog.filter(id=>!id.startsWith('veo-3.1-fast-i2v-8s'))
 assert.equal(media.flowVideoModelForDuration(selected,'16:9',8,older),selected)
 assert.throws(()=>media.flowVideoModelForDuration(selected,'16:9',8,catalog.filter(id=>!id.includes('fast-i2v'))),/Không|Không có|Không tìm|Không|Không|Tidak ada/)
 assert.equal(media.flowVideoModelForDuration('other-provider/model','16:9',4,[]),'other-provider/model')
 for(const seconds of [0,-1,NaN,Infinity])assert.throws(()=>media.flowVideoModelForDuration(selected,'16:9',seconds,catalog),/Durasi/)
})

test('real generation path sends per-scene IDs using trimmed voice length, and falls back to scene length without audio',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bang-flow-duration-'))
 const oldFetch=global.fetch
 try {
  fs.mkdirSync(path.join(root,'project'),{recursive:true});fs.writeFileSync(path.join(root,'project','frame.png'),'fixture-image')
  const sent=[],saved=[],patches=[];let completion
  global.fetch=async(url,options)=>{
   if(url.endsWith('/models'))return new Response(JSON.stringify({data:catalog.map(id=>({id}))}),{headers:{'content-type':'application/json'}})
   const body=JSON.parse(options.body);sent.push(body)
   const seconds=Number(/-(\d+)s-/.exec(body.model)[1])
   const content=`<video src='data:video/mp4;base64,${Buffer.from(String(seconds)).toString('base64')}' controls></video>`
   return new Response('data: '+JSON.stringify({choices:[{delta:{content}}]})+'\n\ndata: [DONE]\n\n',{headers:{'content-type':'text/event-stream'}})
  }
  const flow=load('main/services/flow2api.ts',{
   '@shared/media':media,'@shared/flowErrors':{flowFailure:()=>new Error('failure')},
   '../settings':{getSettings:()=>({flowLocalEnabled:false,flowBaseUrl:'http://127.0.0.1:8765'})},
   '../secrets':{requireSecret:()=> 'fake'},'./http':{},'../flowSetup':{}
  })
  const clips=[
   {id:'four',durationMs:12000,audioAssetId:'voice-four',voiceInMs:1000,voiceOutMs:5000},
   {id:'eight',durationMs:8000,audioAssetId:'voice-eight'},
   {id:'silent',durationMs:5500,audioAssetId:null}
  ].map(c=>({...c,projectId:'project',imageAssetId:'image',videoPrompt:'A flag moves.',visualPrompt:'A flag.'}))
  const assets={image:{id:'image',localPath:'frame.png'},'voice-four':{durationMs:5000},'voice-eight':{durationMs:8000}}
  const api=load('main/generation.ts',{
   '@shared/media':media,'@shared/timeline':timeline,'@shared/captions':{},'@shared/speech':{},'@shared/higgsfield':{},'@shared/styles':{},
   './db':{},'./settings':{},'./events':{emit:{job(){},asset(){},clip(){}}},
   './jobs':{runJob:(job,lane,work)=>{completion=work({signal:new AbortController().signal,progress(){}});return job}},
   './paths':{assetAbsPath:(project,rel)=>path.join(root,project,rel)},
   './repo':{activeJobFor:()=>null,getClip:id=>clips.find(c=>c.id===id),getProject:()=>({id:'project',videoModel:'flow2api:veo-3.1-fast-i2v-6s-landscape',aspectRatio:'16:9'}),
    getAsset:id=>assets[id]??null,insertJob:v=>({...v,id:'job'}),insertAsset:v=>{saved.push(v);return {...v,id:'video-'+saved.length}},
    patchClip:(id,patch)=>patches.push({id,patch}),touchProject(){}},
   './services/flow2api':flow,'./services/gemini':{},'./services/elevenlabs':{},'./services/higgsfield':{},'./services/http':{},
   './services/audio':{probeSize:async()=>({width:1280,height:720}),probeDurationMs:async file=>Number(fs.readFileSync(file).toString())*1000}
  })
  for(const clip of clips){api.generateClipVideo(clip.id);await completion}
  assert.deepEqual(sent.map(b=>b.model),['veo-3.1-fast-i2v-4s-landscape','veo-3.1-fast-i2v-8s-landscape','veo-3.1-fast-i2v-6s-landscape'])
  assert.deepEqual(saved.map(a=>a.durationMs),[4000,8000,6000])
  assert.deepEqual(saved.map(a=>a.model),sent.map(b=>'flow2api:'+b.model))
  assert.ok(sent.every(b=>b.messages[0].content[1].type==='image_url'))
  assert.ok(patches.every(p=>!('durationMs' in p.patch))) // Keep the voice and timeline unchanged.
 } finally {global.fetch=oldFetch;fs.rmSync(root,{recursive:true,force:true})}
})


test('Flow model picker explains automatic duration without changing the saved selected model',()=>{
 const React=require('react'),{renderToStaticMarkup}=require('react-dom/server')
 const ui=load('renderer/src/pages/project/ModelSection.tsx',{
  '@shared/higgsfield':{hfModelOptions:()=>[]},'@shared/media':media,
  '../../components/ModelLogo':{},'../../components/ModelPicker':{ModelPicker:props=>React.createElement('div',{'data-model':props.value},'picker')},
  '../../components/ui':{},'../../lib/format':{},'../../lib/useEstimate':{},'../../components/Select':{},
  '../../lib/useModels':{useModels:()=>({models:[],loading:false,error:null,refresh(){}})}
 },'\nexport const __test = {FlowPicker}').__test
 const value='flow2api:omni-1.1-flash-6s-landscape'
 const html=renderToStaticMarkup(React.createElement(ui.FlowPicker,{kind:'video',value,onChange(){throw new Error('must not mutate selection')}}))
 assert.match(html,/Durasi dipilih otomatis per adegan mengikuti suara/)
 assert.match(html,/jika sama dekat, pilih yang lebih panjang/)
 assert.match(html,/data-model="flow2api:omni-1.1-flash-6s-landscape"/)
})
