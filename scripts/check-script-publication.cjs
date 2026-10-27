const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),http=require('node:http'),cp=require('node:child_process'),assert=require('node:assert/strict')
const root=path.resolve(__dirname,'..'),folder=fs.mkdtempSync(path.join(root,'qa-script-publication-'))
let failed=false;const requests=[]
const server=http.createServer(async(req,res)=>{
 let raw='';for await(const c of req)raw+=c
 try{
  const body=JSON.parse(raw),name=body.response_format?.json_schema?.name;requests.push({name})
  let data
  if(body.stream){data='data:image/png;base64,'+fs.readFileSync(path.join(root,'build/icon.png')).toString('base64')}
  else if(name==='script_outline')data={title:'Mara and the key',beats:Array.from({length:25},(_,i)=>'Mara follows the coast '+(i+1))}
  else if(name==='publication')data={title:'You Find a Key That Opens the Lighthouse',description:'You carry a mysterious key along the coast. Would you open the lighthouse door? Like and subscribe for more adventures.',thumbnailPrompt:'A woman in a blue coat holds a brass key beside a lighthouse, warm illustrated style, bold silhouette, no text.'}
  else {const [,count,start]=/Write exactly (\d+) scenes, ONLY scene numbers (\d+)/.exec(body.messages[1].content);requests.at(-1).start=+start;if(+start===13&&!failed){failed=true;res.writeHead(401,{'content-type':'application/json'});res.end(JSON.stringify({error:{message:'fixture unauthorized'}}));return}data={title:'Mara and the key',scenes:Array.from({length:+count},(_,i)=>({title:'Scene '+(+start+i),story:'Mara walks along the coast with the key '+(+start+i),narration:'You carry the key along the coast toward the lighthouse '+(+start+i)}))}}
  await new Promise(r=>setTimeout(r,250));res.writeHead(200,{'content-type':'application/json'});res.end(JSON.stringify({choices:[{message:{content:typeof data==='string'?data:JSON.stringify(data)}}]}))
 }catch(e){console.error(e);res.writeHead(500);res.end('{}')}
})
async function launch(steps,name){
 const file=path.join(folder,name+'.json'),log=path.join(folder,name+'.log');fs.writeFileSync(file,JSON.stringify(steps))
 const env={...process.env,STUDIO_USER_DATA:path.join(folder,'userdata'),STUDIO_CAPTURE_PLAN:file,STUDIO_CAPTURE_HIDDEN:'1',STUDIO_LOG:log};delete env.ELECTRON_RUN_AS_NODE
 const child=cp.spawn(require('electron'),[process.env.STUDIO_TEST_APP||'.'],{cwd:root,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let error='';child.stdout.on('data',()=>{});child.stderr.on('data',d=>error+=d)
 const code=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{cp.spawnSync('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true});reject(Error('UI timeout '+error.slice(-2000)))},90000);child.on('error',reject);child.on('close',code=>{clearTimeout(timer);resolve(code)})})
 assert.equal(code,0,error.slice(-2000));const content=fs.readFileSync(log,'utf8');assert.doesNotMatch(content,/\[harness\] step failed|\[gone\]/,content);return content
}
const wait=`const wait=async(kind,status)=>{for(let n=0;n<250;n++){const b=await window.api.projects.get(window.fixtureId);if(b.jobs.filter(j=>j.kind===kind).at(-1)?.status===status)return b;await new Promise(r=>setTimeout(r,100))}throw Error(kind+' did not reach '+status)};`
const open=`(async()=>{window.fixtureId=(await window.api.projects.list())[0].id;Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes('Script publication fixture')).click()})()`
const click=text=>`const b=Array.from(document.querySelectorAll('button')).find(b=>b.textContent.includes(${JSON.stringify(text)}));if(!b)throw Error('Missing button: '+${JSON.stringify(text)});b.click();`
async function main(){
 await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port+'/v1'
 await launch([
 {js:`(async()=>{await window.api.settings.set({llmProvider:'custom',llmModels:{custom:'fixture'},customBaseUrl:${JSON.stringify(base)},flowLocalEnabled:false,flowBaseUrl:${JSON.stringify(base)}});const b=await window.api.projects.create({synopsis:'Mara carries a key to the lighthouse.',durationSec:137.5,language:'en'});b.project.title='Script publication fixture';b.project.imageModel='flow2api:fixture-landscape';await window.api.projects.save(b);location.reload()})()`,wait:1500},
 {js:open,wait:800},{js:`{${click('Susun naskah')}}`,wait:600,shot:path.join(folder,'script-running.png')},
 {js:`(async()=>{${wait}const b=await wait('story','failed');if(b.clips.length)throw Error('Partial replaced approved script');const p=document.querySelector('[aria-label="Penyusunan naskah"]');if(!p.textContent.includes('HTTP 401'))throw Error('Persistent failure missing');console.log('SCRIPT_CHECKPOINT_FAILED_VISIBLE')})()`,shot:path.join(folder,'script-failed.png')}, {quit:true,wait:100}
 ],'first')
 await launch([
 {js:open,wait:700},{js:`{${click('Lanjutkan naskah')}}`,wait:300},
 {js:`(async()=>{${wait}const b=await wait('story','done');if(b.clips.length!==25)throw Error('Incomplete script');console.log('SCRIPT_RESUMED_25')})()`,wait:700,shot:path.join(folder,'script-complete.png')},
 {js:`{${click('Storyboard')}}`,wait:700},
 {main:'key',provider:'flow2api',ok:true,wait:100},
 {js:`{${click('Materi publikasi')}}`,wait:500},
 {js:`{${click('Generate judul & deskripsi')}}`,wait:500},
 {js:`(async()=>{${wait}await wait('publication','done');await new Promise(r=>setTimeout(r,500));if(!document.querySelector('[aria-label="Deskripsi video / Shorts"]').value.includes('Would you'))throw Error('Description missing');console.log('PUBLICATION_GENERATED')})()`,shot:path.join(folder,'publication.png')},
 {js:`{${click('Buat thumbnail')}}`,wait:700},
 {js:`(async()=>{${wait}const b=await wait('thumbnail','done');if(!b.assets.some(a=>a.meta.purpose==='thumbnail'&&!a.clipId))throw Error('Thumbnail missing');if(b.clips.some(c=>c.imageAssetId))throw Error('Thumbnail leaked to video');console.log('THUMBNAIL_ISOLATED');console.log('UI_BOUNDS '+JSON.stringify({width:innerWidth,height:innerHeight,scroll:document.documentElement.scrollWidth}))})()`,shot:path.join(folder,'thumbnail.png')},
 {quit:true,wait:100}
 ],'second')
 assert.deepEqual(requests.filter(r=>r.name==='script').map(r=>r.start),[1,13,13,25]);assert.equal(requests.filter(r=>r.name==='script_outline').length,1)
 console.log('PASS: real Electron UI, batch failure/restart/resume, description, thumbnail isolation. Artifacts: '+folder)
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>server.close())
