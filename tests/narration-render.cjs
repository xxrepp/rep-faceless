const assert = require('node:assert/strict')
const {test} = require('node:test')
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript')
function load(file, mocks = {}) {
 const module = {exports:{}}
 const js = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', file), 'utf8'), {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2023}}).outputText
 new Function('require','module','exports',js)(name => name === '@shared/promptPresets' ? load('shared/promptPresets.ts') : mocks[name] ?? require(name),module,module.exports)
 return module.exports
}
const speech = load('shared/speech.ts')
const enc = load('main/exportEncoding.ts')
const caps = {logicalCores:16,encoders:[{id:'cpu',available:true},{id:'amd',available:true},{id:'intel',available:false},{id:'nvidia',available:false}]}
test('clean narration retains spoken words, silent pause tags and scene boundaries', () => {
 const original='The soldiers waited. <sigh>\n<long pause>\n[whispers] Then they marched. <breath> <gasp> <chuckles>'
 const clean=speech.cleanNarrationText(original)
 assert.deepEqual(speech.spokenWords(clean),speech.spokenWords(original))
 assert.match(clean,/\n<long pause>\n/)
 assert.doesNotMatch(clean,/sigh|whisper|breath|gasp|chuckle/)
 assert.equal(speech.cleanNarrationText('He gasped at the news.'),'He gasped at the news.')
})
test('Gemini delivery instructions are metadata, never transcript', async () => {
 let request
 const api=load('main/services/gemini.ts', {
  '@shared/speech':speech, '@shared/models':{}, '../secrets':{requireSecret:()=> 'fake'},
  '../settings':{getSettings:()=>({geminiTtsModel:'gemini-3.8-flash-tts'})},
  './audio':{isWav:()=>true}, './json':{}, './visualRetry':load('main/services/visualRetry.ts'),
  '@google/genai':{GoogleGenAI:class {models={generateContent:async r=>{request=r;return {candidates:[{content:{parts:[{inlineData:{data:Buffer.from('RIFF').toString('base64'),mimeType:'audio/wav'}}]}}]}}}}}
 })
 await api.speak('Hello. <sigh>\n<long pause>\nWorld.','Kore','en')
 const part=request.contents[0].parts[0]
 assert.equal(part.text,'Hello. \n<long pause>\nWorld.')
 assert.equal(part.speechMetadata.style,speech.CLEAN_NARRATION_STYLE)
 assert.doesNotMatch(part.text,/No audible breathing/)
})
test('resource plans bound workers, memory and CPU thread budget', () => {
 assert.deepEqual(enc.renderPlan({resources:'responsive',resolution:1080},caps,32*1024**3),{encoder:'amd',workers:1,threads:4})
 assert.deepEqual(enc.renderPlan({resources:'maximum',encoder:'cpu',resolution:1080},caps,32*1024**3),{encoder:'cpu',workers:4,threads:16})
 assert.equal(enc.renderPlan({resources:'maximum',resolution:2160},caps,8*1024**3).workers,1)
 assert.equal(enc.renderPlan({encoder:'intel'},caps).encoder,'cpu')
 assert.throws(()=>enc.renderPlan({encoder:'shell'},caps),/tidak valid/)
 assert.throws(()=>enc.renderPlan({resources:'unlimited'},caps),/tidak valid/)
})
test('hardware fallback never swallows filter or cancellation errors', () => {
 assert.equal(enc.hardwareFailure(new Error('AMF failed to initialize')),true)
 assert.equal(enc.hardwareFailure(new Error('No such filter: perspective')),false)
 assert.equal(enc.hardwareFailure(new Error('Dibatalkan')),false)
 for(const id of ['cpu','amd','intel','nvidia']) assert.ok(enc.encodingArgs(id).includes('-c:v'))
})

test('scene assembly preserves wording and deliberate pauses without adding scene pauses', () => {
 const lines=[' The army ', 'advanced <short pause> through', 'the valley. <long pause> Then winter came. ']
 const joined=speech.joinNarrationScenes(lines)
 assert.equal(joined,'The army advanced <short pause> through the valley. <long pause> Then winter came.')
 assert.deepEqual(speech.spokenWords(joined),lines.flatMap(speech.spokenWords))
 assert.equal(speech.joinNarrationScenes(['One scene.','Another scene.']),'One scene. Another scene.')
 assert.match(speech.CLEAN_NARRATION_STYLE,/do not add a pause just because the scene changes/)
 assert.match(speech.CLEAN_NARRATION_STYLE,/No audible breathing, sighs, gasps, whispering/)
})

test('real WAV cuts reassemble the continuous take without padding, missing samples or changed scene text', async () => {
 const os=require('node:os'),cp=require('node:child_process'),ffmpeg=require('ffmpeg-static')
 const audio=load('main/services/audio.ts',{'../paths':{binPath:p=>p},'ffmpeg-static':{default:ffmpeg}})
 const captions=load('shared/captions.ts'),timeline=load('shared/timeline.ts')
 const script=load('shared/script.ts',{'./speech':speech}),cuts=load('main/cuts.ts')
 const rate=24000,pcm=Buffer.alloc(rate*2.4*2)
 for(let i=0;i<pcm.length/2;i++) {
  const t=i/rate
  // A deliberate natural pause must survive exactly, alongside continuous speech.
  const silent=t>=.6&&t<.74
  pcm.writeInt16LE(silent?0:Math.round(9000*Math.sin(i*.117)),i*2)
 }
 const wav=audio.pcmToWav(pcm,rate)
 const times=[.1,.33,.75,1.01,1.4,1.8].map((start,i)=>({text:['The','army','advanced','through','the','valley.'][i],start,end:[.32,.6,.99,1.35,1.7,2.15][i]}))
 for(const mode of ['gemini-whisper','gemini-estimated','elevenlabs']) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'bang-narration-continuity-'))
  try {
   const provider=mode==='elevenlabs'?'elevenlabs':'gemini'
   const clips=['The army','advanced through','the valley.'].map((narration,i)=>({id:'clip-'+i,projectId:'project',narration,durationMs:4000,audioAssetId:null,story:'scene-'+i}))
   const project={id:'project',ttsProvider:provider,ttsVoice:'test-voice',language:'en'}
   const assets=[],patches=[],requests=[];let completion
   const service={speak:async text=>{requests.push(text);return provider==='gemini'?wav:{audio:wav,words:times}}}
   const repo={activeProjectJob:()=>null,clipsOf:()=>clips,getClip:id=>clips.find(c=>c.id===id),getProject:()=>project,
    insertJob:value=>({...value,id:'job'}),insertAsset:value=>{const a={...value,id:'asset-'+assets.length};assets.push(a);return a},
    patchClip:(id,patch)=>patches.push({id,patch}),touchProject(){}}
   const api=load('main/narration.ts',{
    '@shared/captions':captions,'@shared/script':script,'@shared/speech':speech,'./cuts':cuts,'ffmpeg-static':{default:ffmpeg},
    './events':{emit:{job(){},asset(){},clip(){}}},'./repo':repo,
    './jobs':{runJob:(job,lane,work)=>{completion=work({jobId:'job',signal:new AbortController().signal,progress(){}});return job}},
    './paths':{dataDir:()=>root,assetAbsPath:(id,rel)=>path.join(root,'projects',id,rel),binPath:p=>p},
    './settings':{getSettings:()=>({whisperAuto:mode==='gemini-whisper',geminiTtsModel:'test',elevenModel:'test'})},
    './services/audio':audio,'./services/gemini':service,'./services/elevenlabs':service,
    './whisper':{whisperReady:()=>true,timeScript:async()=>times}
   })
   api.generateNarration('project','all');await completion
   assert.deepEqual(requests,['The army advanced through the valley.'])
   assert.deepEqual(assets.map(a=>a.prompt),clips.map(c=>c.narration))
   assert.equal(assets.length,3);assert.equal(patches.length,3)
   const pieces=assets.map((a,i)=>{
    const file=path.join(root,'projects','project',a.localPath)
    const bytes=cp.execFileSync(ffmpeg,['-v','error','-i',file,'-f','s16le','-acodec','pcm_s16le','-'],{windowsHide:true})
    const ms=bytes.length/(rate*2)*1000
    assert.equal(patches[i].patch.durationMs,a.durationMs)
    assert.ok(Math.abs(ms-a.durationMs)<=1)
    assert.ok(a.durationMs<1500)
    assert.equal(timeline.voiceSpan(patches[i].patch,a.durationMs).playMs,a.durationMs)
    assert.ok(a.meta.words.every(w=>w.start>=0&&w.end<=ms/1000+.001))
    return bytes
   })
   assert.equal(patches.reduce((sum,p)=>sum+p.patch.durationMs,0),2400)
   assert.deepEqual(Buffer.concat(pieces),pcm,mode+' must retain every source sample and natural pause')
  } finally {fs.rmSync(root,{recursive:true,force:true})}
 }
})

test('restoring a continuous narration segment does not add the legacy 400 ms gap', async () => {
 let patch
 const asset={id:'audio',clipId:'clip',kind:'audio',durationMs:670,meta:{take:'continuous-take'}}
 const api=load('main/generation.ts',{
  '@shared/captions':{},'@shared/speech':speech,'@shared/timeline':{},'@shared/higgsfield':{},'@shared/styles':{},'@shared/media':{},
  './db':{},'./events':{emit:{clip(){}}},'./jobs':{},'./paths':{},'./settings':{},
  './services/audio':{},'./services/elevenlabs':{},'./services/gemini':{},'./services/higgsfield':{},'./services/flow2api':{},'./services/http':{},
  './repo':{getAsset:()=>asset,patchClip:(id,value)=>{patch=value}}
 })
 await api.setActiveAsset('clip','audio')
 assert.equal(patch.durationMs,670)
 assert.equal(patch.voiceStartMs,0)
 delete asset.meta.take
 await api.setActiveAsset('clip','audio')
 assert.equal(patch.durationMs,1500) // Standalone legacy audio keeps its existing behavior.
})
