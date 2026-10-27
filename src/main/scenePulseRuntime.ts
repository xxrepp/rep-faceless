import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, copyFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { app } from 'electron'
import ffmpegStatic from 'ffmpeg-static'
import { Browser, computeExecutablePath, detectBrowserPlatform, getDownloadUrl, install } from '@puppeteer/browsers'
import { EFFECT_ROLES, EFFECT_SOUNDS, EFFECT_STYLES, SCENEPULSE_VERSION, type SceneEffect, type ScenePulseStatus } from '@shared/scenePulse'
import type { TaskCtx } from './jobs'
import { binPath, dataDir } from './paths'

const BROWSER_BUILD = '152.0.7977.30'
export function scenePulseSkillDir(): string {
  return app.isPackaged ? join(process.resourcesPath, 'scenepulse/skill') : join(app.getAppPath(), 'resources/scenepulse/skill')
}
function moduleFile(relative: string): string { return binPath(join(app.getAppPath(), 'node_modules', relative)) }
export function scenePulseBrowser(): string {
  if (!app.isPackaged && process.env.STUDIO_SCENEPULSE_BROWSER) return process.env.STUDIO_SCENEPULSE_BROWSER
  const platform = detectBrowserPlatform()
  if (!platform) throw new Error('Sistem ini belum mendukung render Motion + SFX')
  return computeExecutablePath({browser: Browser.CHROMEHEADLESSSHELL,buildId:BROWSER_BUILD,platform,cacheDir:join(dataDir(),'scenepulse/browser')})
}
export function verifyScenePulseSkill(): void {
  const root = scenePulseSkillDir()
  const origin = JSON.parse(readFileSync(join(root,'../ORIGIN.json'),'utf8')) as {skillVersion:string;files:{file:string;sha256:string}[]}
  if (origin.skillVersion !== SCENEPULSE_VERSION) throw new Error('Versi skill ScenePulse tidak cocok. Pasang ulang paket Bang Story terbaru.')
  for (const file of origin.files) {
    if (file.file.split(/[\\/]/).includes('..')) throw new Error('Path skill tidak valid')
    const hash = createHash('sha256').update(readFileSync(join(root,file.file))).digest('hex')
    if (hash !== file.sha256) throw new Error(`Berkas skill ScenePulse berubah: ${file.file}. Sinkronkan ulang paket skill.`)
  }
}
export function scenePulseStatus(): ScenePulseStatus {
  let skillIncluded = false
  try { verifyScenePulseSkill(); skillIncluded = true } catch { /* Setup reports the actionable verification error. */ }
  return {ready:skillIncluded && existsSync(scenePulseBrowser()),skillIncluded,skillVersion:SCENEPULSE_VERSION,engine:'HyperFrames 0.8.171'}
}

export async function setupScenePulse(ctx: TaskCtx): Promise<void> {
  verifyScenePulseSkill()
  if (existsSync(scenePulseBrowser())) return
  const platform = detectBrowserPlatform()!
  const cacheDir = join(dataDir(),'scenepulse/browser')
  const url = getDownloadUrl(Browser.CHROMEHEADLESSSHELL,platform,BROWSER_BUILD)
  const folder = join(cacheDir,Browser.CHROMEHEADLESSSHELL)
  mkdirSync(folder,{recursive:true})
  const archive = join(folder,`${BROWSER_BUILD}-${basename(url.pathname)}`), part = archive+'.part'
  try {
    const response = await fetch(url,{signal:AbortSignal.any([ctx.signal,AbortSignal.timeout(300000)])})
    if (!response.ok || !response.body) throw new Error(`Unduhan runtime gagal (HTTP ${response.status}). Coba pasang lagi.`)
    const total = Number(response.headers.get('content-length')) || 0
    let received = 0
    const stream = Readable.fromWeb(response.body as never)
    stream.on('data',(data:Buffer) => { received += data.length; ctx.progress(total ? .05 + .7*received/total : .2,'Mengunduh runtime render terpisah…') })
    await pipeline(stream,createWriteStream(part),{signal:ctx.signal})
    if (ctx.signal.aborted) throw new Error('Dibatalkan')
    renameSync(part,archive)
    ctx.progress(.8,'Menyiapkan runtime render…')
    await install({browser:Browser.CHROMEHEADLESSSHELL,buildId:BROWSER_BUILD,platform,cacheDir})
    if (!existsSync(scenePulseBrowser())) throw new Error('Runtime belum lengkap. Coba pasang lagi.')
  } finally { rmSync(part,{force:true}) }
}

/** Runs only app-owned tools. Cancellation terminates their dedicated process tree. */
export function scenePulseProcess(command: string, args: string[], ctx: TaskCtx, cwd: string, env = process.env, timeoutMs = 300000): Promise<string> {
  return new Promise((resolve,reject) => {
    if (ctx.signal.aborted) return reject(new Error('Dibatalkan'))
    const child = spawn(command,args,{cwd,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
    let tail = '', timedOut = false
    const stop = (): void => {
      if (process.platform === 'win32' && child.pid) spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'}).on('error',()=>child.kill())
      else child.kill('SIGKILL')
    }
    const timer = setTimeout(()=>{timedOut=true;stop()},timeoutMs)
    ctx.signal.addEventListener('abort',stop,{once:true})
    const collect = (data: Buffer): void => { tail = (tail+data.toString()).slice(-5000) }
    child.stdout.on('data',collect); child.stderr.on('data',collect)
    const clean = (): void => { clearTimeout(timer);ctx.signal.removeEventListener('abort',stop) }
    child.stdout.on('error',error=>{clean();reject(error)})
    child.stderr.on('error',error=>{clean();reject(error)})
    child.once('error',error=>{clean();reject(error)})
    child.once('close',code=>{
      clean()
      if (ctx.signal.aborted) reject(new Error('Dibatalkan'))
      else if (timedOut) reject(new Error('Render ScenePulse melewati batas waktu. Coba klip lebih pendek atau resolusi 720p.'))
      else if (code !== 0) reject(new Error(`ScenePulse gagal: ${tail.slice(-2500)}`))
      else resolve(tail)
    })
  })
}

export async function renderScenePulseSfx(effect: SceneEffect, durationMs: number, output: string, ctx: TaskCtx): Promise<void> {
  const args = ['-v','error','-nostdin','-n','-f','lavfi','-i',`anullsrc=r=48000:cl=stereo:d=${durationMs/1000}`]
  const graph: string[] = []
  for (const [i,cue] of effect.audio.entries()) {
    const role = EFFECT_ROLES.find(r=>r.id===cue.effectId)!
    const sound = EFFECT_SOUNDS.find(s=>s.id===role.defaultSoundId)!
    const path = join(scenePulseSkillDir(),sound.file)
    if (createHash('sha256').update(readFileSync(path)).digest('hex') !== sound.sha256) throw new Error('Checksum suara ScenePulse berbeda')
    args.push('-i',path)
    const length = sound.durationMs/1000, fade = Math.min(.008,length/4)
    graph.push(`[${i+1}:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=channel_layouts=stereo,volume=${cue.gainDb}dB,afade=t=in:d=${fade},afade=t=out:st=${length-fade}:d=${fade},adelay=${Math.round(cue.startMs*48)}S:all=1[s${i}]`)
  }
  graph.push(effect.audio.length ? `[0:a]${effect.audio.map((_,i)=>`[s${i}]`).join('')}amix=inputs=${effect.audio.length+1}:duration=first:normalize=0,alimiter=limit=.95:level=false:latency=1[out]` : '[0:a]anull[out]')
  args.push('-filter_complex',graph.join(';'),'-map','[out]','-t',String(durationMs/1000),'-c:a','pcm_s16le',output)
  await scenePulseProcess(binPath(ffmpegStatic!),args,ctx,dirname(output))
}

/** Native HyperFrames composition over Bang Story's already-framed silent scene. */
export async function renderScenePulseVisual(effect: SceneEffect, durationMs: number, width: number, height: number, styleId: string, base: string, output: string, ctx: TaskCtx): Promise<void> {
  await setupScenePulse(ctx)
  const root = dirname(base), length = durationMs/1000
  copyFileSync(moduleFile('gsap/dist/gsap.min.js'),join(root,'gsap.min.js'))
  copyFileSync(moduleFile('gsap/package.json'),join(root,'GSAP-PACKAGE.json'))
  // electron-builder strips dependency READMEs, so retain this notice as an explicit resource.
  const gsapReadme = app.isPackaged ? join(process.resourcesPath,'licenses/GSAP-README.md') : moduleFile('gsap/README.md')
  copyFileSync(gsapReadme,join(root,'GSAP-README.md'))
  const color = EFFECT_STYLES.find(s=>s.id===styleId)!.accentColor
  const animations: string[] = []
  const graphics = effect.graphics.map((g,i)=>{
    const start=g.startMs/1000,end=g.endMs/1000,fade=Math.min(.18,(end-start)/3)
    animations.push(`tl.fromTo('#g${i}',{autoAlpha:0},{autoAlpha:1,duration:${fade}},${start}).to('#g${i}',{autoAlpha:0,duration:${fade}},${end-fade});`)
    return `<div id="g${i}" data-start="${start}" data-duration="${end-start}" style="position:absolute;z-index:5;opacity:0;box-sizing:border-box;left:${g.x*100}%;top:${g.y*100}%;width:${g.width*100}%;height:${g.height*100}%;${g.presetId==='underline'?'border-bottom':'border'}:max(2px,.28vh) solid ${color}"></div>`
  }).join('')
  const m=effect.motion
  if (m.presetId !== 'static') {
    let from:Record<string,number>={scale:1},to:Record<string,number>={scale:1+m.amount}
    if (m.presetId==='pull-out') [from,to]=[to,from]
    if (m.presetId.startsWith('pan-')) {
      const d=m.presetId==='pan-left'?1:-1
      from={scale:1+m.amount,xPercent:d*m.amount*50};to={scale:1+m.amount,xPercent:-d*m.amount*50}
    }
    animations.push(`tl.fromTo('#camera',${JSON.stringify(from)},${JSON.stringify({...to,duration:length,ease:'power2.inOut'})},0);`)
  }
  const html=`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;background:#111;overflow:hidden}#root{position:relative;width:${width}px;height:${height}px;overflow:hidden}#camera,video{position:absolute;inset:0;width:100%;height:100%}video{object-fit:cover}</style><script src="gsap.min.js"></script></head><body><div id="root" data-composition-id="main" data-start="0" data-duration="${length}" data-width="${width}" data-height="${height}"><div id="camera"><video id="base" src="${basename(base)}" data-start="0" data-duration="${length}" data-media-start="0" muted playsinline preload="auto"></video></div>${graphics}</div><script>const tl=gsap.timeline({paused:true});${animations.join('')}tl.to({},{duration:.001},${Math.max(0,length-.001)});window.__timelines={main:tl};</script></body></html>`
  writeFileSync(join(root,'index.html'),html,'utf8')
  const ffprobe=moduleFile(`ffprobe-static/bin/${process.platform}/${process.arch}/${process.platform==='win32'?'ffprobe.exe':'ffprobe'}`)
  const env={...process.env,ELECTRON_RUN_AS_NODE:'1',HYPERFRAMES_NO_TELEMETRY:'1',DO_NOT_TRACK:'1',
    HYPERFRAMES_BROWSER_PATH:scenePulseBrowser(),HYPERFRAMES_FFMPEG_PATH:binPath(ffmpegStatic!),HYPERFRAMES_FFPROBE_PATH:ffprobe,
    HYPERFRAMES_FONT_CACHE_DIR:join(dataDir(),'scenepulse/fonts'),HYPERFRAMES_EXTRACT_CACHE_DIR:join(dataDir(),'scenepulse/frames')}
  await scenePulseProcess(process.execPath,[moduleFile('hyperframes/bin/hyperframes.mjs'),'render',root,'--output',output,
    '--fps','30','--workers','1','--low-memory-mode','--no-browser-gpu','--no-best-effort','--quiet'],ctx,root,env,Math.max(180000,length*60000))
}
