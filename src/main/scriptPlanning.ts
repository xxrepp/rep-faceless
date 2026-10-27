import { createHash } from 'node:crypto'
import { LANGUAGES, clipCountFor } from '@shared/models'
import { projectPromptSettings } from '@shared/promptPresets'
import { estimateNarrationMs } from '@shared/script'
import { scriptSystem } from '@shared/storyInstructions'
import type { Job } from '@shared/types'
import { getDb } from './db'
import { emit } from './events'
import { runJob, type TaskCtx } from './jobs'
import { activeProjectJob, clipsOf, getProject, insertJob, replaceScript } from './repo'
import { activeLlm, generateJson } from './services/llm'
import { visualRequest, VisualValidationError } from './services/visualRetry'
import { getSettings } from './settings'
import { SCRIPT_SCHEMA } from './story'

const BATCH_SIZE = 12
type Scene = { title: string; story: string; narration: string }
interface Draft { input: string; baseline: string; outline: { title: string; beats: string[] } | null; scenes: Scene[] }
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const baseline = (id: string): string => hash(clipsOf(id))
function input(id: string): string {
  const p = getProject(id), s = projectPromptSettings(getSettings(), p)
  return hash([p.synopsis, p.durationSec, p.language, scriptSystem(p.language, s.scriptInstructions, s.scriptInstructionsMode)])
}
function save(id: string, draft: Draft): void {
  getDb().prepare('INSERT INTO script_drafts (project_id, state_json) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET state_json = excluded.state_json').run(id, JSON.stringify(draft))
}
export function startScriptPlanning(id: string, mode: 'resume' | 'new' = 'resume'): Job {
  const active = activeProjectJob(id, 'story')
  if (active) return active
  if (activeProjectJob(id, 'visuals')) throw new Error('Tunggu perencanaan visual selesai dulu.')
  if (!getProject(id).synopsis.trim()) throw new Error('Tulis ide cerita atau sinopsis dulu.')
  const llm = activeLlm()
  const job = insertJob({ projectId: id, kind: 'story', provider: llm.provider })
  emit.job(job)
  return runJob(job, 'visuals', async ctx => {
    await executeScriptPlanning(id, mode, ctx)
    return { message: `${clipsOf(id).length} adegan siap. Baca dan rapikan naskahnya dulu.` }
  })
}

export async function executeScriptPlanning(id: string, mode: 'resume' | 'new', ctx: TaskCtx): Promise<void> {
  const db = getDb(), project = getProject(id)
  const settings = projectPromptSettings(getSettings(), project)
  const language = LANGUAGES.find(l => l.code === project.language)?.english ?? 'Indonesian'
  const system = scriptSystem(language, settings.scriptInstructions, settings.scriptInstructionsMode)
  const total = clipCountFor(project.durationSec)
  const row = db.prepare('SELECT state_json FROM script_drafts WHERE project_id = ?').get(id) as { state_json: string } | undefined
  let draft: Draft | null = row ? JSON.parse(row.state_json) : null
  if (mode === 'new' || !draft || draft.input !== input(id) || draft.baseline !== baseline(id)) {
    draft = { input: input(id), baseline: baseline(id), outline: null, scenes: [] }
    save(id, draft)
  }
  const state = draft
  const provider = hash([activeLlm(), getSettings().customBaseUrl])
  const assertCurrent = (): void => {
    ctx.signal.throwIfAborted()
    if (state.input !== input(id) || state.baseline !== baseline(id) || provider !== hash([activeLlm(), getSettings().customBaseUrl]))
      throw new Error('Input, adegan, atau provider berubah. Hasil yang masih diproses tidak disimpan. Lanjutkan untuk memakai input terbaru.')
  }
  const request = <T>(stage: string, run: (signal: AbortSignal) => Promise<T>): Promise<T> => visualRequest(signal => {
    assertCurrent()
    return run(signal)
  }, {
    signal: ctx.signal, ...activeLlm(), stage, range: `naskah ${state.scenes.length}/${total}`,
    progress: (attempt, retrying) => ctx.progress(state.scenes.length / total,
      `${state.scenes.length}/${total} adegan tersimpan · ${retrying ? `Mencoba ulang (${attempt}/3)` : stage === 'script_outline' ? 'Menyusun kerangka cerita' : `Menulis adegan ${state.scenes.length + 1}–${Math.min(total, state.scenes.length + BATCH_SIZE)}`}`),
    diagnostic: value => ctx.progress(state.scenes.length / total, value)
  })
  if (!state.outline) {
    const outline = await request('script_outline', async signal => {
      const value = await generateJson<{ title: string; beats: string[] }>({ system,
        prompt: `Plan the COMPLETE story before drafting narration. Preserve the synopsis, character identities, causality, major turns and ending. Return exactly ${total} short, numbered-by-position scene beats, at most 20 words each. Do not write full narration yet.\nTarget: ${project.durationSec} seconds.\nSynopsis:\n${project.synopsis}`,
        schema: { type: 'object', additionalProperties: false, properties: { title: { type: 'string' }, beats: { type: 'array', items: { type: 'string' } } }, required: ['title', 'beats'] }, name: 'script_outline', signal })
      if (!value || typeof value.title !== 'string' || !Array.isArray(value.beats) || value.beats.length !== total || value.beats.some(b => typeof b !== 'string' || !b.trim()))
        throw new VisualValidationError('SCRIPT_OUTLINE_INVALID', `Kerangka harus berisi tepat ${total} adegan. Naskah lama tetap aman.`)
      return value
    })
    assertCurrent(); state.outline = outline; save(id, state)
  }
  while (state.scenes.length < total) {
    const start = state.scenes.length, count = Math.min(BATCH_SIZE, total - start)
    const scenes = await request('script', async signal => {
      const value = await generateJson<{ title: string; scenes: Scene[] }>({ system,
        prompt: [`Idea / synopsis:\n${project.synopsis}`, `Target video length: about ${project.durationSec} seconds.`,
          `Complete shared story outline (authoritative, including ending):\n${JSON.stringify(state.outline)}`,
          `Previously written scenes:\n${JSON.stringify(state.scenes)}`,
          `Write exactly ${count} scenes, ONLY scene numbers ${start + 1} through ${start + count} of ${total}, in order. Continue from the preceding scene without repeating its content. Follow these outline beats exactly. Do not restart the hook or end the story before the final batch. Narration instructions still apply to the full story; only scene 1 gets an opening, only the last scene gets a closing.`].join('\n\n'),
        schema: SCRIPT_SCHEMA, name: 'script', signal })
      if (!value || !Array.isArray(value.scenes) || value.scenes.length !== count || value.scenes.some(c => !c || ['title', 'story', 'narration'].some(k => typeof c[k as keyof Scene] !== 'string' || !c[k as keyof Scene].trim())))
        throw new VisualValidationError('SCRIPT_BATCH_INVALID', `Batch adegan ${start + 1}–${start + count} belum lengkap. Batch sebelumnya tersimpan; lanjutkan untuk mencoba bagian ini lagi.`)
      return value.scenes.map(c => ({ title: c.title.trim(), story: c.story.trim(), narration: c.narration.trim() }))
    })
    assertCurrent(); state.scenes.push(...scenes); save(id, state)
    ctx.progress(state.scenes.length / total, `${state.scenes.length}/${total} adegan tersimpan`)
  }
  assertCurrent()
  // Keep the approved script and its media intact until every batch is safely saved.
  db.transaction(() => {
    replaceScript(id, state.outline!.title.trim() || project.title, state.scenes.map(c => ({ ...c, durationMs: estimateNarrationMs(c.narration) })))
    db.prepare('DELETE FROM script_drafts WHERE project_id = ?').run(id)
  })()
}
