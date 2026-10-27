import { projectPromptSettings } from '@shared/promptPresets'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { estimateWordTimings } from '@shared/captions'
import { stripVoiceTags } from '@shared/speech'
import { getImageModel, getVideoModel, imageBody, maxRefs, promptLimit, videoBody, type HfModel } from '@shared/higgsfield'
import { getStyle } from '@shared/styles'
import { flowAspectModel, isFlowModel } from '@shared/media'
import { voiceSpan } from '@shared/timeline'
import type { AspectRatio, Asset, Character, Clip, CreditEstimate, Job, Project, WordTiming } from '@shared/types'
import { getDb } from './db'
import { emit } from './events'
import { runJob, type TaskCtx } from './jobs'
import { assetAbsPath } from './paths'
import {
  activeJobFor,
  activeProjectJob,
  charactersOf,
  clipsOf,
  getAsset,
  getCharacter,
  getClip,
  getJob,
  getProject,
  insertAsset,
  insertJob,
  patchClip,
  setCharacterSheet,
  touchProject,
  unfinishedJobs,
  updateAssetMeta,
  updateJob
} from './repo'
import { getPublication } from './publication'
import { dropCache, getSettings, readCache, writeCache } from './settings'
import { probeDurationMs, probeSize } from './services/audio'
import * as eleven from './services/elevenlabs'
import * as gemini from './services/gemini'
import * as hf from './services/higgsfield'
import * as flow from './services/flow2api'
import { downloadTo, sleep } from './services/http'

const DAY = 24 * 60 * 60 * 1000

function extFromType(contentType: string, url: string, fallback: string): string {
  if (/png/.test(contentType)) return '.png'
  if (/jpe?g/.test(contentType)) return '.jpg'
  if (/webp/.test(contentType)) return '.webp'
  if (/mp4/.test(contentType)) return '.mp4'
  const m = /\.(png|jpe?g|webp|mp4|mov)(\?|$)/i.exec(url)
  return m ? `.${m[1].toLowerCase()}` : fallback
}

function saveFile(projectId: string, folder: string, ext: string, bytes: Buffer): string {
  const rel = `${folder}/${randomUUID()}${ext}`
  const abs = assetAbsPath(projectId, rel)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, bytes)
  return rel
}

/** A URL Higgsfield can fetch for a stored asset: its own recent result URL, or a fresh upload. */
async function publicUrlFor(asset: Asset, signal: AbortSignal): Promise<string> {
  if (asset.remoteUrl && asset.provider === 'higgsfield' && Date.now() - asset.createdAt < 6 * DAY) return asset.remoteUrl
  const up = asset.meta.uploadedUrl as string | undefined
  const at = asset.meta.uploadedAt as number | undefined
  if (up && at && Date.now() - at < 0.5 * DAY) return up
  const url = await hf.uploadFile(assetAbsPath(asset.projectId, asset.localPath), signal)
  updateAssetMeta(asset.id, { ...asset.meta, uploadedUrl: url, uploadedAt: Date.now() })
  return url
}

function imageProgress(ctx: TaskCtx, what: string) {
  return (status: hf.HfStatus, elapsed: number): void => {
    if (status === 'queued') ctx.progress(0.12, 'Mengantre di Higgsfield')
    else ctx.progress(0.15 + 0.75 * (1 - Math.exp(-elapsed / 45_000)), what)
  }
}

// ---------- prompts ----------

function characterLine(c: Character): string {
  return `${c.name}: ${c.description}`
}

/** Splits the storyboard's "Avoid:" line off the scene, so it can be phrased as a clear instruction. */
function splitAvoid(visual: string): { scene: string; avoid: string } {
  const lines = visual.split('\n')
  const i = lines.findIndex((l) => /^\s*avoid\s*:/i.test(l))
  if (i < 0) return { scene: visual.trim(), avoid: '' }
  const avoid = lines[i].replace(/^\s*avoid\s*:\s*/i, '').replace(/\.$/, '').trim()
  lines.splice(i, 1)
  return { scene: lines.join('\n').trim(), avoid }
}

/**
 * The image prompt for a clip. The scene comes first so the model gets the content right, then who the
 * characters are, then the art style. Clothing follows the scene's Wardrobe line when it has one, so a
 * character can change out of the outfit on their reference sheet (no spacesuit indoors).
 */
function clipPrompt(project: Project, clip: Clip, chars: Character[], refNames: string[], limit: number): string {
  const style = getStyle(project.styleId, projectPromptSettings(getSettings(), project).visualStyleOverrides)
  const { scene, avoid } = splitAvoid(clip.visualPrompt)
  const wardrobe = /^\s*wardrobe\s*:/im.test(scene)
  const parts = [`Scene:\n${scene}`]
  if (chars.length)
    parts.push(
      `Recurring characters in this scene. Keep each one's body, face, hair and skin exactly as described${refNames.length ? ' and as on their reference sheet' : ''}.` +
        (wardrobe
          ? ' Their clothing follows the Wardrobe line of the scene: the default outfit only where it says so, otherwise the custom outfit.'
          : ' They wear their default outfit.') +
        `\n${chars.map(characterLine).join('\n')}`
    )
  if (refNames.length)
    parts.push(
      `Reference images are character sheets, in this order: ${refNames.join(', ')}. Use them for each character's identity, proportions and colors. ` +
        (wardrobe ? 'Copy the costume from a sheet only for characters whose Wardrobe line says "default outfit". ' : 'Match the costume to the sheet. ') +
        'Do not copy the sheet layout, poses or plain background.'
    )
  const styleScope = 'Identity scope: character-specific rules in the art style apply only to that exact named character when present. Render only the scene cast; never add the channel protagonist or give their face, age, body, hair, costume or accessories to another character. The supplied character descriptions and scene Wardrobe take priority over shared style text.'
  parts.push(`Art style: ${style.prompt}`, styleScope)
  if (avoid) parts.push(`Must not appear in the image: ${avoid}.`)
  parts.push(`Frame format ${project.aspectRatio}, full-bleed composition.`)
  const full = parts.join('\n\n')
  if (full.length <= limit) return full
  // Models with short prompt limits get the scene first, so trimming only loses style detail.
  return [scene, chars.map(characterLine).join('; '), avoid && `Must not appear: ${avoid}.`, style.prompt, styleScope].filter(Boolean).join('\n\n')
}

function sheetPrompt(project: Project, c: Character): string {
  const style = getStyle(project.styleId, projectPromptSettings(getSettings(), project).visualStyleOverrides)
  return [
    `Character reference sheet for "${c.name}". Render ONLY this target identity: ${c.description}`,
    'The target description is the authority for identity and default outfit. Shared art and presentation instructions below control rendering only; they cannot replace the target with another named person, a channel host or a recurring protagonist.',
    `Shared art direction:\n${style.prompt}`,
    `Shared sheet presentation guidance:\n${style.characterHint}`,
    'Show the SAME character three times side by side: front view, three-quarter view and side view, full body, neutral standing pose, evenly spaced, on a plain light neutral background (this overrides any background instruction above). Consistent proportions, costume and colors in all three views.',
    `Final identity check: every view depicts "${c.name}" only, with these exact physical traits and default clothing: ${c.description}. Ignore identity, sex, age, hair, outfit and accessory instructions for any other named character in the shared guidance.`
  ].join('\n\n')
}

// ---------- waiting for character sheets ----------

async function waitForSheets(characterIds: string[], signal: AbortSignal): Promise<void> {
  const started = Date.now()
  while (Date.now() - started < 15 * 60 * 1000) {
    const pending = characterIds.some((id) => activeJobFor({ characterId: id }, 'sheet'))
    if (!pending) return
    await sleep(2000, signal)
  }
}

async function referenceUrls(model: HfModel, chars: Character[], signal: AbortSignal): Promise<{ urls: string[]; names: string[] }> {
  const limit = maxRefs(model)
  if (limit === 0) return { urls: [], names: [] }
  await waitForSheets(
    chars.map((c) => c.id),
    signal
  )
  const urls: string[] = []
  const names: string[] = []
  for (const c of chars) {
    const fresh = getCharacter(c.id)
    const sheet = getAsset(fresh.sheetAssetId)
    if (!sheet || urls.length >= limit) continue
    urls.push(await publicUrlFor(sheet, signal))
    names.push(fresh.name)
  }
  return { urls, names }
}

// ---------- finishing a Higgsfield request (also used to resume after a restart) ----------

interface HfPayload {
  target: 'clip-image' | 'sheet' | 'clip-video' | 'thumbnail'
  model: string
  prompt: string
}

async function finishHiggsfield(ctx: TaskCtx, job: Job, requestId: string, payload: HfPayload): Promise<string> {
  const isVideo = payload.target === 'clip-video'
  const result = await hf.waitForResult(
    requestId,
    imageProgress(ctx, isVideo ? 'Membuat video' : payload.target === 'sheet' ? 'Membuat lembar karakter' : 'Membuat gambar'),
    ctx.signal,
    isVideo ? 30 * 60 * 1000 : 15 * 60 * 1000
  )
  const url = isVideo ? result.video?.url : result.images?.[0]?.url
  if (!url) throw new Error('Higgsfield selesai tanpa file hasil')
  ctx.progress(0.93, 'Mengunduh hasil')
  const { bytes, contentType } = await downloadTo(url, ctx.signal)
  const rel = saveFile(job.projectId, isVideo ? 'videos' : 'images', extFromType(contentType, url, isVideo ? '.mp4' : '.png'), bytes)
  const abs = assetAbsPath(job.projectId, rel)
  const size = await probeSize(abs)
  const durationMs = isVideo ? await probeDurationMs(abs).catch(() => null) : null
  const asset = insertAsset({
    projectId: job.projectId,
    clipId: job.clipId,
    characterId: job.characterId,
    kind: isVideo ? 'video' : 'image',
    provider: 'higgsfield',
    model: payload.model,
    prompt: payload.prompt,
    remoteId: requestId,
    remoteUrl: url,
    localPath: rel,
    durationMs,
    width: size?.width ?? null,
    height: size?.height ?? null,
    meta: payload.target === 'thumbnail' ? { purpose: 'thumbnail' } : {}
  })
  emit.asset(asset)
  if (payload.target === 'sheet' && job.characterId) {
    setCharacterSheet(job.characterId, asset.id)
    emit.character({ characterId: job.characterId, patch: { sheetAssetId: asset.id } })
  } else if (payload.target === 'clip-image' && job.clipId) {
    patchClip(job.clipId, { imageAssetId: asset.id })
    emit.clip({ clipId: job.clipId, patch: { imageAssetId: asset.id } })
    const project = getProject(job.projectId)
    const first = clipsOf(job.projectId)[0]
    if (!project.coverAssetId || first?.id === job.clipId) touchProject(job.projectId, { coverAssetId: asset.id })
  } else if (payload.target === 'clip-video' && job.clipId) {
    const patch = { videoAssetId: asset.id, motionType: 'video' as const, mediaInMs: 0 }
    patchClip(job.clipId, patch)
    emit.clip({ clipId: job.clipId, patch })
  }
  touchProject(job.projectId)
  return asset.id
}

function startHiggsfield(job: Job, build: (ctx: TaskCtx) => Promise<{ endpoint: string; body: Record<string, unknown>; payload: HfPayload }>): Job {
  emit.job(job)
  return runJob(job, 'higgsfield', async (ctx) => {
    ctx.progress(0.04, 'Menyiapkan prompt')
    const { endpoint, body, payload } = await build(ctx)
    ctx.progress(0.08, 'Mengirim ke Higgsfield')
    const requestId = await hf.submit(endpoint, body, ctx.signal)
    ctx.setRemote(requestId)
    updateJobPayload(job.id, payload)
    return finishHiggsfield(ctx, job, requestId, payload)
  })
}

function updateJobPayload(jobId: string, payload: HfPayload): void {
  getDb().prepare('UPDATE jobs SET payload_json = ? WHERE id = ?').run(JSON.stringify(payload), jobId)
}

// ---------- public entry points ----------

function startFlow(projectId: string, target: HfPayload['target'], clipId?: string, characterId?: string): Job {
  const video = target === 'clip-video'
  const job = insertJob({ projectId, clipId, characterId, kind: video ? 'video' : target === 'sheet' ? 'sheet' : target === 'thumbnail' ? 'thumbnail' : 'image', provider: 'flow2api' })
  emit.job(job)
  return runJob(job, target === 'sheet' ? 'flow2api-sheet' : video ? 'flow2api-video' : 'flow2api', async (ctx) => {
    const project = getProject(projectId)
    const selected = video ? project.videoModel : project.imageModel
    if (!selected || !isFlowModel(selected)) throw new Error('Penyedia proyek berubah. Pilih model Flow2API lalu coba lagi.')
    let model = flowAspectModel(selected, target === 'sheet' ? '16:9' : project.aspectRatio)
    const refs: string[] = []
    let prompt: string
    ctx.progress(0.05, 'Menyiapkan prompt Flow2API')
    if (target === 'thumbnail') {
      const names: string[] = []
      for (const c of charactersOf(projectId)) {
        const sheet = getAsset(c.sheetAssetId)
        if (sheet && refs.length < 3) { refs.push(flow.imageData(assetAbsPath(projectId, sheet.localPath))); names.push(c.name) }
      }
      prompt = thumbnailPrompt(project, names)
    } else if (target === 'sheet') {
      prompt = sheetPrompt(project, getCharacter(characterId!)) + '\nFrame format 16:9.'
    } else {
      const clip = getClip(clipId!)
      if (video) {
        const image = getAsset(clip.imageAssetId)
        if (!image) throw new Error('Gambar klip tidak ditemukan')
        const audio = getAsset(clip.audioAssetId)
        const voiceMs = audio?.durationMs != null ? voiceSpan(clip, audio.durationMs).playMs : 0
        model = await flow.resolveVideoModel(selected, project.aspectRatio, (voiceMs > 0 ? voiceMs : clip.durationMs) / 1000, ctx.signal)
        refs.push(flow.imageData(assetAbsPath(projectId, image.localPath)))
        prompt = (clip.videoPrompt.trim() || `${splitAvoid(clip.visualPrompt).scene}. Subtle natural motion, slow camera push in.`) + '\nKeep the art style, characters and composition of the first frame. No music, no speech, no vocals.'
      } else {
        const chars = charactersOf(projectId).filter(c => clip.characterIds.includes(c.id))
        await waitForSheets(chars.map(c => c.id), ctx.signal)
        const names: string[] = []
        for (const c of chars) {
          const sheet = getAsset(getCharacter(c.id).sheetAssetId)
          if (!sheet || refs.length >= 3) continue
          refs.push(flow.imageData(assetAbsPath(projectId, sheet.localPath)))
          names.push(c.name)
        }
        prompt = clipPrompt(project, clip, chars, names, Number.MAX_SAFE_INTEGER)
      }
    }
    ctx.progress(0.15, video ? 'Membuat video di Flow2API' : 'Membuat gambar di Flow2API')
    const result = await flow.generate(model, prompt, refs, video ? 'video' : 'image', ctx.signal, message => ctx.progress(0.5, message))
    ctx.progress(0.93, 'Menyimpan hasil Flow2API')
    const rel = saveFile(projectId, video ? 'videos' : 'images', extFromType(result.contentType, result.url ?? '', video ? '.mp4' : '.png'), result.bytes)
    const abs = assetAbsPath(projectId, rel)
    const size = await probeSize(abs)
    const durationMs = video ? await probeDurationMs(abs) : null
    const asset = insertAsset({ projectId, clipId, characterId, kind: video ? 'video' : 'image', provider: 'flow2api', model, prompt, remoteUrl: result.url, localPath: rel, durationMs, width: size?.width ?? null, height: size?.height ?? null, meta: target === 'thumbnail' ? { purpose: 'thumbnail' } : {} })
    emit.asset(asset)
    if (target === 'sheet') {
      setCharacterSheet(characterId!, asset.id)
      emit.character({ characterId: characterId!, patch: { sheetAssetId: asset.id } })
    } else if (target !== 'thumbnail') {
      const patch = video ? { videoAssetId: asset.id, motionType: 'video' as const, mediaInMs: 0 } : { imageAssetId: asset.id }
      patchClip(clipId!, patch)
      emit.clip({ clipId: clipId!, patch })
      if (!video && (!project.coverAssetId || clipsOf(projectId)[0]?.id === clipId)) touchProject(projectId, { coverAssetId: asset.id })
    }
    touchProject(projectId)
    return asset.id
  })
}

function thumbnailPrompt(project: Project, refNames: string[] = []): string {
  const data = getPublication(project.id)
  if (!data.thumbnailPrompt.trim()) throw new Error('Generate materi publikasi atau isi prompt thumbnail dulu.')
  const style = getStyle(project.styleId, projectPromptSettings(getSettings(), project).visualStyleOverrides)
  const chars = charactersOf(project.id)
  return [data.thumbnailPrompt, `Art style: ${style.prompt}`,
    `Character identities (render only characters needed by the chosen moment):\n${chars.map(characterLine).join('\n')}`,
    refNames.length ? `Reference sheets in this exact order: ${refNames.join(', ')}. Match identity only; do not copy the sheet layout. Do not introduce an unrelated channel host.` : 'Use the supplied character descriptions. Do not introduce an unrelated channel host.',
    `Standalone thumbnail, frame format ${project.aspectRatio}, full bleed, strong focal subject. Render the exact quoted hook headline specified in the thumbnail directions, large and legible at mobile size, separate from the focal subject. Thumbnail headline/typography instructions take priority over generic no-text guidance in the shared art style. No additional text, full video title, storyboard panels, logos or watermark. Keep the bottom-right clear for the duration badge.`].join('\n\n')
}

export function generateThumbnail(projectId: string): Job {
  const existing = activeProjectJob(projectId, 'thumbnail')
  if (existing) return existing
  if (activeProjectJob(projectId, 'publication')) throw new Error('Tunggu konsep thumbnail selesai dulu.')
  const project = getProject(projectId)
  thumbnailPrompt(project)
  if (isFlowModel(project.imageModel)) return startFlow(projectId, 'thumbnail')
  const job = insertJob({ projectId, kind: 'thumbnail', provider: 'higgsfield' })
  return startHiggsfield(job, async ctx => {
    const fresh = getProject(projectId), model = getImageModel(fresh.imageModel)
    const chars = charactersOf(projectId)
    const refs = await referenceUrls(model, chars, ctx.signal)
    const prompt = thumbnailPrompt(fresh, refs.names)
    return { endpoint: model.id, body: imageBody(model, prompt, fresh.aspectRatio, refs.urls), payload: { target: 'thumbnail', model: model.id, prompt } }
  })
}

export function generateClipImage(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'image')
  if (existing) return existing
  const clip = getClip(clipId)
  if (isFlowModel(getProject(clip.projectId).imageModel)) return startFlow(clip.projectId, 'clip-image', clipId)
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'image', provider: 'higgsfield' })
  return startHiggsfield(job, async (ctx) => {
    const fresh = getClip(clipId)
    const project = getProject(fresh.projectId)
    const model = getImageModel(project.imageModel)
    const chars = charactersOf(project.id).filter((c) => fresh.characterIds.includes(c.id))
    const refs = await referenceUrls(model, chars, ctx.signal)
    const prompt = clipPrompt(project, fresh, chars, refs.names, promptLimit(model))
    return {
      endpoint: model.id,
      body: imageBody(model, prompt, project.aspectRatio, refs.urls),
      payload: { target: 'clip-image', model: model.id, prompt }
    }
  })
}

export function generateCharacterSheet(characterId: string): Job {
  const existing = activeJobFor({ characterId }, 'sheet')
  if (existing) return existing
  const c = getCharacter(characterId)
  if (isFlowModel(getProject(c.projectId).imageModel)) return startFlow(c.projectId, 'sheet', undefined, characterId)
  const job = insertJob({ projectId: c.projectId, characterId, kind: 'sheet', provider: 'higgsfield' })
  return startHiggsfield(job, async () => {
    const project = getProject(c.projectId)
    const model = getImageModel(project.imageModel)
    const prompt = sheetPrompt(project, getCharacter(characterId))
    return {
      endpoint: model.id,
      body: imageBody(model, prompt, '16:9', []),
      payload: { target: 'sheet', model: model.id, prompt }
    }
  })
}

export function generateClipVideo(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'video')
  if (existing) return existing
  const clip = getClip(clipId)
  if (!clip.imageAssetId) throw new Error('Buat gambar klip ini dulu sebelum membuat video AI.')
  if (isFlowModel(getProject(clip.projectId).videoModel)) return startFlow(clip.projectId, 'clip-video', clipId)
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'video', provider: 'higgsfield' })
  return startHiggsfield(job, async (ctx) => {
    const fresh = getClip(clipId)
    const image = getAsset(fresh.imageAssetId)
    if (!image) throw new Error('Gambar klip tidak ditemukan')
    const project = getProject(fresh.projectId)
    const model = getVideoModel(project.videoModel)
    ctx.progress(0.05, 'Menyiapkan gambar awal')
    const url = await publicUrlFor(image, ctx.signal)
    let prompt =
      fresh.videoPrompt.trim() ||
      `${splitAvoid(fresh.visualPrompt).scene.replace(/\.$/, '')}. Subtle natural motion of the characters and environment, the camera slowly pushes in. Keep the art style of the first frame.`
    if (model.input.mode === 'reference')
      prompt = `Open on the exact scene of the reference image and keep its art style, characters and composition. ${prompt}`
    return {
      endpoint: model.id,
      body: videoBody(model, prompt, url, fresh.durationMs / 1000, project.aspectRatio, project.videoResolution),
      payload: { target: 'clip-video', model: model.id, prompt }
    }
  })
}

export function generateClipTts(clipId: string): Job {
  const existing = activeJobFor({ clipId }, 'tts')
  if (existing) return existing
  const clip = getClip(clipId)
  const project = getProject(clip.projectId)
  const job = insertJob({ projectId: clip.projectId, clipId, kind: 'tts', provider: project.ttsProvider })
  emit.job(job)
  return runJob(job, 'tts', async (ctx) => {
    const fresh = getClip(clipId)
    const p = getProject(fresh.projectId)
    const text = fresh.narration.trim()
    if (!text) throw new Error('Naskah klip ini masih kosong')
    ctx.progress(0.2, 'Membuat suara')
    let rel: string
    let words: WordTiming[] | undefined
    let estimated = false
    const voice = p.ttsVoice || (p.ttsProvider === 'gemini' ? 'Charon' : '')
    if (p.ttsProvider === 'elevenlabs') {
      if (!voice) throw new Error('Pilih suara ElevenLabs dulu di langkah Ide cerita.')
      const out = await eleven.speak(text, voice, p.language, ctx.signal)
      rel = saveFile(p.id, 'audio', '.mp3', out.audio)
      words = out.words
    } else {
      const wav = await gemini.speak(text, voice, p.language, ctx.signal)
      rel = saveFile(p.id, 'audio', '.wav', wav)
    }
    ctx.progress(0.85, 'Mengukur durasi')
    const audioMs = await probeDurationMs(assetAbsPath(p.id, rel))
    if (!words?.length) {
      words = estimateWordTimings(stripVoiceTags(text), audioMs / 1000)
      estimated = true
    }
    const asset = insertAsset({
      projectId: p.id,
      clipId,
      kind: 'audio',
      provider: p.ttsProvider,
      model: p.ttsProvider === 'gemini' ? getSettings().geminiTtsModel : getSettings().elevenModel,
      prompt: text,
      localPath: rel,
      durationMs: audioMs,
      meta: { words, estimatedTimings: estimated, voice }
    })
    emit.asset(asset)
    const durationMs = Math.max(1500, audioMs + 400)
    const patch = { audioAssetId: asset.id, durationMs, voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0 }
    patchClip(clipId, patch)
    emit.clip({ clipId, patch })
    touchProject(p.id)
    return asset.id
  })
}

export function generateMissingImages(projectId: string): Job[] {
  const jobs: Job[] = []
  const project = getProject(projectId)
  const model = getImageModel(project.imageModel)
  if (isFlowModel(project.imageModel) || maxRefs(model) > 0) {
    const needed = new Set(clipsOf(projectId).flatMap((c) => c.characterIds))
    for (const c of charactersOf(projectId)) {
      if (needed.has(c.id) && !c.sheetAssetId) jobs.push(generateCharacterSheet(c.id))
    }
  }
  for (const clip of clipsOf(projectId)) {
    if (!clip.imageAssetId) jobs.push(generateClipImage(clip.id))
  }
  return jobs
}

/** Turns every clip that has an image but no AI video yet into a video. */
export function generateMissingVideos(projectId: string): Job[] {
  const clips = clipsOf(projectId)
  if (clips.some((c) => !c.imageAssetId)) throw new Error('Buat gambar semua klip dulu sebelum menjadikannya video.')
  return clips.filter((c) => !c.videoAssetId).map((c) => generateClipVideo(c.id))
}

export function generateMissingTts(projectId: string): Job[] {
  return clipsOf(projectId)
    .filter((c) => !c.audioAssetId && c.narration.trim())
    .map((c) => generateClipTts(c.id))
}

/** After a restart, keep polling Higgsfield requests that were already submitted; fail the rest. */
export function resumeJobs(): void {
  for (const row of unfinishedJobs()) {
    const payload = JSON.parse(row.payload_json || '{}') as Partial<HfPayload>
    if (row.provider === 'higgsfield' && row.remote_id && payload.target) {
      const job = getJob(row.id)!
      runJob(job, 'higgsfield', (ctx) => finishHiggsfield(ctx, job, row.remote_id, payload as HfPayload))
    } else {
      emit.job(updateJob(row.id, { status: 'failed', error: (row.kind === 'visuals' || row.kind === 'story') ? 'Perencanaan terhenti saat aplikasi ditutup. Batch tersimpan tetap aman; klik Lanjutkan.' : 'Terhenti karena aplikasi ditutup. Coba lagi.', message: (row.kind === 'visuals' || row.kind === 'story') ? row.message : null }))
    }
  }
}

export async function setActiveAsset(clipId: string, assetId: string): Promise<void> {
  const asset = getAsset(assetId)
  if (!asset || asset.clipId !== clipId) throw new Error('Aset tidak cocok dengan klip ini')
  const patch: Partial<Clip> =
    asset.kind === 'image'
      ? { imageAssetId: asset.id }
      : asset.kind === 'video'
        ? { videoAssetId: asset.id, mediaInMs: 0 }
        : asset.kind === 'audio'
          ? { audioAssetId: asset.id, durationMs: typeof asset.meta.take === 'string' && asset.durationMs != null ? Math.max(1, asset.durationMs) : Math.max(1500, (asset.durationMs ?? 0) + 400), voiceInMs: 0, voiceOutMs: null, voiceStartMs: 0 }
          : {}
  patchClip(clipId, patch)
  emit.clip({ clipId, patch })
}

/** Estimates that failed recently (no key, or a model the account cannot use), so pickers do not keep asking. */
const failedEstimates = new Map<string, number>()

/**
 * Credits for one image, or one clip video of about `seconds`. The model pickers ask for every model,
 * so answers are kept for a day and failures for ten minutes.
 */
export async function estimateCredits(
  kind: 'image' | 'video',
  modelId: string,
  aspect: AspectRatio,
  seconds = 5,
  resolution?: string | null
): Promise<CreditEstimate | null> {
  if (isFlowModel(modelId)) return null
  const model = kind === 'image' ? getImageModel(modelId) : getVideoModel(modelId)
  const body =
    kind === 'image'
      ? imageBody(model, 'estimate', aspect, [])
      : videoBody(model, 'estimate', 'https://example.com/frame.png', seconds, aspect, resolution)
  const key = `estimate:${model.id}:${JSON.stringify(body)}`
  const hit = readCache<CreditEstimate>(key)
  if (hit && Date.now() - hit.updatedAt < DAY) return hit.value
  const failedAt = failedEstimates.get(key)
  if (failedAt && Date.now() - failedAt < 10 * 60 * 1000) return null
  const value = await hf.estimate(model.id, body)
  if (value) writeCache(key, value)
  else failedEstimates.set(key, Date.now())
  return value
}

/** Prices can differ per account, so a new Higgsfield key starts from fresh estimates. */
export function forgetEstimates(): void {
  failedEstimates.clear()
  dropCache('estimate:')
}
