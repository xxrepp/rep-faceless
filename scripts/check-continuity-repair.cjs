/* Isolated Electron UI check. All generation is served by a local, controlled HTTP provider. */
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),cp=require('node:child_process'),assert=require('node:assert/strict')
const root=path.resolve(__dirname,'..')
const folder=fs.mkdtempSync(path.join(os.tmpdir(),'bang-continuity-ui-'))
const requests=[]
let secondBatch=0,continuityRejected=false
const world='A coastal town in 2040.'
const server=http.createServer(async(req,res)=>{
 let text='';for await(const chunk of req)text+=chunk
 try{
  const body=JSON.parse(text),stage=body.response_format.json_schema.name,prompt=body.messages[1].content
  requests.push({stage})
  let result,wait=100
  if(stage==='continuity')result={world,direction:'Warm realistic cinema.',recurringDesigns:'Red bicycle and lighthouse.',characters:[{name:'Mara',description:'Human woman, dark hair. Default outfit: blue coat.'}],states:Array.from({length:25},(_,i)=>({scene:i+1,entering:'Mara carries the key in her blue coat.',leaving:'Mara keeps the key and blue coat.'})),conflicts:['Adegan 25: kepemilikan kunci perlu diperjelas.']}
  else if(stage==='continuity_plan_review')result={consistent:true,issues:[],notes:['Plan internally coherent.']}
  else if(stage==='continuity_repair')result={edits:[{scene:25,story:'Mara keeps the key in her blue coat beside the lighthouse.',narration:'The journey continues.',visualPrompt:'',videoPrompt:'',reason:'Memperjelas kepemilikan kunci sesuai plan.'}]}
  else if(stage==='continuity_repair_review')result={consistent:true,issues:[],resolutions:[{conflict:1,note:'Adegan 25 kini mengikuti kepemilikan kunci di plan.'}]}
  else if(stage==='continuity_review'){
   const scenes=JSON.parse(prompt).scenes
   if(scenes[0].scene===14 && !continuityRejected){continuityRejected=true;result={consistent:false,issues:['Adegan 14: sarung tangan harus sesuai keadaan masuk.']}}
   else result={consistent:true,issues:[]}
  }
  else{
   const numbers=/Write visuals for these scenes only: ([\d, ]+)/.exec(prompt)[1].split(',').map(Number)
   requests.at(-1).numbers=numbers
   requests.at(-1).repair=prompt.includes('Rejected draft and review findings:')
   if(requests.at(-1).repair)assert.match(prompt,/sarung tangan harus sesuai/)
   if(numbers[0]===14){
    secondBatch++
    if(secondBatch===1){res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture credentials rejected'}}));return}
    if(secondBatch===2)wait=5000
   }
   result={world,characters:[],scenes:numbers.map(scene=>({scene,setting:'Coastal town in 2040 with a lighthouse, bicycle, bench and warm sunset.',action:'Mara holds the key beside the red bicycle.',wardrobe:[{name:'Mara',source:'reference',outfit:'blue coat'}],framing:'Medium eye-level shot.',avoid:'spaceships, armor, snow',characters:['Mara'],camera:'static',strength:'halus',motion:'Her coat moves in the breeze.',transition:'cut'}))}
  }
  await new Promise(r=>setTimeout(r,wait))
  if(!res.destroyed){res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:JSON.stringify(result)}}]}))}
 }catch(e){res.writeHead(500);res.end('fixture error')}
})
const check=`const check=(v,m)=>{if(!v)throw Error(m)}`
const waitJob=`const waitJob=async status=>{for(let i=0;i<200;i++){const b=await window.api.projects.get(window.fixtureId);const j=b.jobs.filter(j=>j.kind==='visuals').at(-1);if(j?.status===status)return b;await new Promise(r=>setTimeout(r,100))}throw Error('Job did not reach '+status)}`
const open=`${check};const button=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Visual workflow fixture'));check(button,'Fixture project missing');button.click()`
const panel=`document.querySelector('[aria-label="Perencanaan prompt visual"]')`
async function launch(steps,name){
 const plan=path.join(folder,name+'.json'),log=path.join(folder,name+'.log')
 fs.writeFileSync(plan,JSON.stringify(steps.map(step=>step.js?{...step,js:'{\n'+step.js+'\n}'}:step)))
 const env={...process.env,STUDIO_USER_DATA:path.join(folder,'userdata'),STUDIO_CAPTURE_PLAN:plan,STUDIO_CAPTURE_HIDDEN:'1',STUDIO_LOG:log}
 delete env.ELECTRON_RUN_AS_NODE
 const child=cp.spawn(require('electron'),['.'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
 let stderr='';child.stderr.on('data',d=>{stderr=(stderr+d).slice(-8000);fs.appendFileSync(path.join(folder,name+'-main.log'),d)});child.stdout.on('data',()=>{})
 const code=await new Promise((resolve,reject)=>{
  const timeout=setTimeout(()=>{if(process.platform==='win32')cp.spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});else child.kill();reject(Error('Electron timed out: '+stderr))},240000)
  child.on('error',e=>{clearTimeout(timeout);reject(e)});child.on('close',c=>{clearTimeout(timeout);resolve(c)})
 })
 const content=fs.existsSync(log)?fs.readFileSync(log,'utf8'):''
 assert.equal(code,0,stderr)
 assert.doesNotMatch(content,/\[harness\] step failed|\[gone\]/,content+'\n'+stderr)
 return content
}
async function main(){
 await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(Number(process.env.STUDIO_VISUAL_TEST_PORT)||18744,'127.0.0.1',resolve)})
 const base='http://127.0.0.1:'+server.address().port+'/v1'
 const setup=`(async()=>{
   await window.api.settings.set({llmProvider:'custom',llmModels:{custom:'fixture-ui'},customBaseUrl:${JSON.stringify(base)},flowLocalEnabled:false});
   const b=await window.api.projects.create({synopsis:'Mara takes the key home.',language:'en'});b.project.title='Visual workflow fixture';b.project.step=2;b.project.status='script';
   b.characters=[{id:crypto.randomUUID(),projectId:b.project.id,name:'Mara',description:'Human woman, dark hair. Default outfit: blue coat.',sort:0}];
   b.clips=Array.from({length:25},(_,i)=>({id:crypto.randomUUID(),projectId:b.project.id,sort:i,title:'Scene '+(i+1),story:'Mara carries the key '+(i+1),narration:'The journey continues.',durationMs:5000,visualPrompt:i===0?'USER APPROVED PROMPT':'',characterIds:[],motionType:'camera',cameraPreset:'static',motionStrength:'halus',videoPrompt:'',transition:'cut',videoCamera:'static',videoStrength:'halus',transitionMs:null,voiceGainDb:0,mediaInMs:0,voiceInMs:0,voiceOutMs:null,voiceStartMs:0}));
   await window.api.projects.save(b);location.reload()
 })()`
 const first=await launch([
  {js:setup,wait:1600},
  {js:open,wait:1000},
  {js:`(async()=>{${check};const p=(await window.api.projects.list())[0];window.fixtureId=p.id;const b=await window.api.projects.get(p.id);check(b.clips.length===25,'Expected 25 scenes');const button=Array.from(document.querySelectorAll('button')).find(b=>/Perbarui visual/.test(b.textContent));check(button,'Visual action missing');button.click()})()`,wait:200},
  {js:`(async()=>{${check};${waitJob};const b=await waitJob('failed');check(b.clips.filter(c=>c.visualPrompt).length===13,'Earlier batch missing');check(b.visualCorrections.length===1,'Correction audit missing');check(b.clips[24].story==='Mara keeps the key in her blue coat beside the lighthouse.','Script correction missing');check(b.visualCorrections[0].changes[0].before==='Mara carries the key 25','Original text missing');check(b.clips[0].visualPrompt==='USER APPROVED PROMPT','Manual prompt overwritten');await new Promise(r=>setTimeout(r,300));check(${panel}.textContent.includes('Coba lagi'),'Resume action missing');console.log('VISUAL_FAILED_WITH_SAVED_BATCH '+b.visualContinuity.version)})()`,wait:200,shot:path.join(folder,'failed.png')},
  {wait:100,quit:true}
 ],'first')
 assert.match(first,/VISUAL_FAILED_WITH_SAVED_BATCH/)
 const version=/VISUAL_FAILED_WITH_SAVED_BATCH ([\w-]+)/.exec(first)[1]
 const second=await launch([
  {js:open,wait:900},
  {js:`(async()=>{${check};window.fixtureId=(await window.api.projects.list())[0].id;check(${panel}.textContent.includes('HTTP 401'),'Persistent error missing after restart');const b=await window.api.projects.get(window.fixtureId);check(b.visualContinuity.version===${JSON.stringify(version)},'Plan version changed on restart');Array.from(${panel}.querySelectorAll('button')).find(b=>b.textContent.includes('Coba lagi')).click()})()`,wait:500,shot:path.join(folder,'running.png')},
  {js:`(async()=>{${check};${waitJob};const b=await waitJob('done');check(b.clips.every(c=>c.visualPrompt.trim()),'False completion');check(b.clips[0].visualPrompt==='USER APPROVED PROMPT','Manual prompt lost');check(b.visualContinuity.version===${JSON.stringify(version)},'Resume changed plan');check(!document.querySelector('fieldset').disabled,'Editing stayed disabled');console.log('VISUAL_UI_DONE 25 '+b.visualContinuity.version)})()`,wait:250,shot:path.join(folder,'done.png')},
  {js:`${check};const toggle=${panel}.querySelector('button[aria-expanded]');check(toggle.getAttribute('aria-expanded')==='false','Completed panel should start compact');toggle.click()`,wait:150,shot:path.join(folder,'details-open.png')},
  {js:`${check};Array.from(document.querySelectorAll('summary')).find(s=>s.textContent.includes('Catatan koreksi otomatis')).click();Array.from(document.querySelectorAll('summary')).find(s=>s.textContent.includes('Adegan 25')).click()`,wait:200,shot:path.join(folder,'correction-notes.png')},
  {js:`${check};let toggle=${panel}.querySelector('button[aria-expanded]');check(toggle.getAttribute('aria-expanded')==='true','Details did not open');check(!document.getElementById(toggle.getAttribute('aria-controls')).hidden,'Details still hidden');toggle.click()`,wait:150,shot:path.join(folder,'details-closed.png')},
  {js:`location.reload()`,wait:1200},
  {js:open,wait:700},
  {js:`${check};const toggle=${panel}.querySelector('button[aria-expanded]');check(toggle.getAttribute('aria-expanded')==='false','Collapsed preference did not survive reload');check(document.getElementById(toggle.getAttribute('aria-controls')).hidden,'Reload displayed hidden details');console.log('VISUAL_DETAILS_TOGGLE_PERSISTED');check(document.body.textContent.includes('Catatan koreksi otomatis'),'Audit UI missing');check(document.body.textContent.includes('Memperjelas kepemilikan'),'Audit reason missing');console.log('CONTINUITY_REPAIR_UI_PERSISTED')`,wait:100},
  {wait:100,quit:true}
 ],'second')
 assert.match(second,/VISUAL_UI_DONE 25/);assert.equal(requests.filter(r=>r.stage==='continuity').length,1);assert.equal(requests.filter(r=>r.stage==='continuity_repair').length,1);assert.equal(requests.filter(r=>r.stage==='continuity_repair_review').length,1);assert.match(second,/CONTINUITY_REPAIR_UI_PERSISTED/)
 assert.equal(requests.filter(r=>r.numbers?.[0]===2).length,1)
 assert.deepEqual(requests.filter(r=>r.numbers).map(r=>[r.numbers[0],r.numbers.at(-1)]),[[2,13],[14,25],[14,25],[14,25]])
 assert.equal(requests.filter(r=>r.repair).length,1)
 console.log(JSON.stringify({folder,ui:'passed',restart:true,manualPrompt:true,oneContinuityPlan:true,continuityCorrection:true,detailsToggle:true,requests}))
}
main().catch(e=>{console.error(e.stack);console.error('Artifacts: '+folder);process.exitCode=1}).finally(()=>server.close())
