/* Validate packaged resources and invoke the shipped headless backend without opening the app UI. */
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process'),crypto=require('node:crypto'),assert=require('node:assert/strict')
const root=path.resolve(__dirname,'..'),app=process.env.STUDIO_PACKAGED_APP || path.join(root,'dist/win-unpacked'),resources=path.join(app,'resources')
assert.equal(fs.readFileSync(path.join(resources,'licenses/GSAP-README.md'),'utf8'),fs.readFileSync(path.join(root,'node_modules/gsap/README.md'),'utf8'),'The packaged GSAP notice must survive dependency README stripping')
const origin=JSON.parse(fs.readFileSync(path.join(resources,'scenepulse/ORIGIN.json'),'utf8'))
for(const record of origin.files) assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(resources,'scenepulse/skill',record.file))).digest('hex'),record.sha256)
const modules=path.join(resources,'app.asar.unpacked/node_modules'),exe=path.join(app,'Bang Story.exe'),cli=path.join(modules,'hyperframes/bin/hyperframes.mjs')
const env={...process.env,ELECTRON_RUN_AS_NODE:'1',HYPERFRAMES_NO_TELEMETRY:'1',DO_NOT_TRACK:'1',
 HYPERFRAMES_BROWSER_PATH:process.env.STUDIO_SCENEPULSE_BROWSER,
 HYPERFRAMES_FFMPEG_PATH:path.join(modules,'ffmpeg-static/ffmpeg.exe'),
 HYPERFRAMES_FFPROBE_PATH:path.join(modules,'ffprobe-static/bin/win32/x64/ffprobe.exe')}
const version=cp.execFileSync(exe,[cli,'--version'],{env,windowsHide:true,encoding:'utf8',timeout:30000})
assert.equal(version.trim(),'0.8.171')
if(process.argv[2]) {
 const project=path.resolve(process.argv[2]),output=path.join(project,'packaged-check.mp4')
 assert.ok(!fs.existsSync(output),'Choose a fresh check output')
 cp.execFileSync(exe,[cli,'render',project,'--output',output,'--fps','30','--workers','1','--low-memory-mode','--no-browser-gpu','--no-best-effort','--quiet'],
  {env,cwd:project,windowsHide:true,encoding:'utf8',timeout:180000})
 const probe=JSON.parse(cp.execFileSync(env.HYPERFRAMES_FFPROBE_PATH,['-v','error','-show_format','-of','json',output],{encoding:'utf8',windowsHide:true}))
 assert.ok(Number(probe.format.duration)>0)
 console.log(JSON.stringify({packagedSkillFiles:origin.files.length,version:version.trim(),nativeRender:true,output}))
} else console.log(JSON.stringify({packagedSkillFiles:origin.files.length,version:version.trim()}))
