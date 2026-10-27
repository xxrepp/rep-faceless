import { projectPromptSettings } from '@shared/promptPresets'
import { createHash, randomUUID } from 'node:crypto'
import type { Clip, ContinuityCorrection, Job } from '@shared/types'
import { needsVisual, visualSourceOf } from '@shared/script'
import { visualSystem } from '@shared/storyInstructions'
import { getStyle } from '@shared/styles'
import { getDb } from './db'
import { emit } from './events'
import { runJob, type TaskCtx } from './jobs'
import { activeProjectJob, applyVisuals, charactersOf, clipsOf, getBundle, getProject, insertJob, patchClip, patchClipText, touchProject, type SceneVisual } from './repo'
import { activeLlm } from './services/llm'
import { VisualValidationError, visualRequest } from './services/visualRetry'
import { getSettings } from './settings'
import { generateVisualBatch, planContinuity, reviewVisualBatch, type ContinuityPlan, type VisualBatchRepair } from './story'

import { proposeContinuityRepair, REPAIR_FIELDS, reviewContinuityRepair, type ContinuityEdit } from './continuityRepair'

import { proposePlanAlignment, reviewContinuityPlan } from './planAlignment'

const BATCH_SIZE = 12
const MAX_CONTINUITY_REPAIRS = 2
interface VisualState {
  version: string
  fingerprint: string
  plan: ContinuityPlan | null
  targets: Record<string, string>
  outputs: Record<string, { signature: string; version: string }>
  planReviewed?: string
  corrections?: ContinuityCorrection[]
  diagnostics?: string[]
  repair?: { numbers: number[]; baselines: Record<string, string>; draft: VisualBatchRepair }
}

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')
export const visualSignature = (c: Clip): string => hash([
  c.visualPrompt, c.videoPrompt, c.cameraPreset, c.motionStrength, c.transition, c.characterIds
])

function fingerprint(projectId: string): string {
  const p = getProject(projectId)
  const settings = projectPromptSettings(getSettings(), p)
  return hash([
    p.synopsis, p.styleId, p.aspectRatio, p.language,
    visualSystem(settings.visualInstructions, settings.visualInstructionsMode), getStyle(p.styleId, settings.visualStyleOverrides),
    clipsOf(projectId).map((c) => [c.id, c.title, c.story, c.narration]),
    charactersOf(projectId).map((c) => [c.id, c.name, c.description, c.sheetAssetId])
  ])
}

function readState(projectId: string): VisualState | null {
  const row = getDb().prepare('SELECT state_json FROM visual_plans WHERE project_id = ?').get(projectId) as { state_json: string } | undefined
  return row ? JSON.parse(row.state_json) as VisualState : null
}
function saveState(projectId: string, state: VisualState): void {
  getDb().prepare('INSERT INTO visual_plans (project_id, state_json) VALUES (?, ?) ON CONFLICT(project_id) DO UPDATE SET state_json = excluded.state_json')
    .run(projectId, JSON.stringify(state))
}

function publish(projectId: string): void {
  const bundle = getBundle(projectId)
  for (const c of bundle.characters) emit.character({ characterId: c.id, patch: c })
  for (const c of bundle.clips) emit.clip({ clipId: c.id, patch: c })
}

/** Resume is explicit after restart: the existing startup recovery marks interrupted jobs failed. */
export function startVisualPlanning(projectId: string, mode: 'missing' | 'all'): Job {
  const active = activeProjectJob(projectId, 'visuals')
  if (active) return active
  if (activeProjectJob(projectId, 'story')) throw new Error('Tunggu penyusunan naskah selesai dulu.')
  getProject(projectId)
  const clips = clipsOf(projectId)
  const llm = activeLlm()
  const job = insertJob({ projectId, kind: 'visuals', provider: llm.provider, payload: { mode, model: llm.model, batchSize: BATCH_SIZE } })
  emit.job(job)
  return runJob(job, 'visuals', async (ctx) => {
    // Setup failures belong to the persistent job too, rather than disappearing in a toast.
    if (!clips.length || clips.some((c) => !c.story.trim() && !c.narration.trim()))
      throw new Error('Isi alur atau narasi setiap adegan dulu.')
    if (!llm.model) throw new Error('Pilih model dulu di Pengaturan.')
    await executeVisualPlanning(projectId, mode, ctx)
    return { message: `${clipsOf(projectId).length}/${clipsOf(projectId).length} prompt visual tersimpan. Gambar belum dibuat.` }
  })
}

export async function executeVisualPlanning(projectId: string, mode: 'missing' | 'all', ctx: TaskCtx): Promise<void> {
  const db = getDb()
  let state = readState(projectId)
  const input = fingerprint(projectId)
  if (!state || state.fingerprint !== input || mode === 'all') {
    const previous = state
    // Invalidate only unchanged machine output. Edited and legacy prompts remain approved material.
    db.transaction(() => {
      for (const c of clipsOf(projectId)) {
        if (previous?.outputs[c.id]?.signature === visualSignature(c))
          db.prepare('UPDATE clips SET visual_source = ? WHERE id = ? AND project_id = ?').run(`continuity:${previous.version}:stale`, c.id, projectId)
      }
      state = { version: randomUUID(), fingerprint: input, plan: null, outputs: previous?.outputs ?? {}, targets: {}, diagnostics: previous?.diagnostics ?? [], corrections: previous?.corrections ?? [] }
      for (const c of clipsOf(projectId)) {
        if (mode === 'all' || needsVisual(c)) state.targets[c.id] = visualSignature(c)
      }
      saveState(projectId, state)
    })()
    publish(projectId)
  }
  const session = state!
  // A cleared or newly invalidated visual can be included without regenerating an unchanged bible.
  for (const c of clipsOf(projectId)) {
    if (needsVisual(c) && !(c.id in session.targets)) session.targets[c.id] = visualSignature(c)
  }
  saveState(projectId, session)
  const llm = activeLlm()
  const providerSelection = hash([llm, getSettings().customBaseUrl])
  const assertCurrent = (): void => {
    ctx.signal.throwIfAborted()
    if (fingerprint(projectId) !== session.fingerprint || hash([activeLlm(), getSettings().customBaseUrl]) !== providerSelection)
      throw new Error('Input atau provider berubah. Hasil yang masih diproses tidak disimpan. Lanjutkan untuk memakai input terbaru.')
  }
  const pending = (): Clip[] => clipsOf(projectId).filter((c) => {
    if (!(c.id in session.targets)) return false
    const signature = visualSignature(c)
    const saved = session.outputs[c.id]
    if (saved?.version === session.version && saved.signature === signature && !needsVisual(c)) return false
    // A manual edit made after cancellation is an explicit decision, not unfinished model work.
    if (signature !== session.targets[c.id] && c.visualPrompt.trim() && !needsVisual(c)) return false
    return true
  })
  const request = <T>(stage: string, numbers: number[], run: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const range = numbers.length ? `adegan ${numbers.every((n, i) => !i || n === numbers[i - 1] + 1) ? `${numbers[0]}â€“${numbers.at(-1)}` : numbers.join(', ')}` : 'continuity plan'
    return visualRequest(async (signal) => { assertCurrent(); return run(signal) }, {
      signal: ctx.signal, ...llm, stage, range,
      progress: (attempt, retrying) => {
        assertCurrent()
        const total = clipsOf(projectId).length
        const completed = total - pending().length
        ctx.progress(completed / total, `${completed}/${total} prompt tersimpan Â· ${retrying ? `Mencoba ulang ${range} Â· Percobaan ${attempt}/3` : stage === 'continuity' ? 'Menyusun continuity plan' : stage === 'continuity_plan_review' ? 'Memeriksa konsistensi plan' : stage === 'continuity_plan_align' ? 'Menyelaraskan continuity plan' : stage === 'continuity_repair' ? 'Memperbaiki konflik naskah/visual' : stage === 'continuity_repair_review' ? 'Memeriksa koreksi naskah/visual' : stage === 'review' ? `Memeriksa continuity ${range}` : stage === 'repair' ? `Memperbaiki continuity ${range}` : `Memproses ${range}`}`)
      },
      diagnostic: (value) => {
        // Job messages persist across restart. Only identifiers/status/codes enter this diagnostic.
        session.diagnostics = [...(session.diagnostics ?? []), `${session.version.slice(0, 8)} Â· ${value}`].slice(-30)
        saveState(projectId, session)
        ctx.progress((clipsOf(projectId).length - pending().length) / clipsOf(projectId).length, value)
      }
    })
  }
  assertCurrent()
  if (!session.plan && pending().length) {
    const plan = await request('continuity', [], (signal) => planContinuity(projectId, signal))
    assertCurrent()
    db.transaction(() => {
      session.plan = plan
      if (!plan.conflicts.length) applyVisuals(projectId, plan.characters, [])
      // Newly established canonical characters are part of every subsequent fingerprint and batch.
      session.fingerprint = fingerprint(projectId)
      saveState(projectId, session)
    })()
    publish(projectId)
  }
  // A derived plan must be coherent before it can constrain scene repairs. Cache only a reviewed input/plan pair.
  if (session.plan && (pending().length || session.plan.conflicts.length) && session.planReviewed !== hash([session.fingerprint, session.plan])) {
    const original = session.plan
    const baselines = hash(clipsOf(projectId))
    let candidate = original
    let review = await request('continuity_plan_review', [], signal => reviewContinuityPlan(projectId, original, candidate, signal))
    let reason = ''
    for (let attempt = 0; !review.consistent && attempt < MAX_CONTINUITY_REPAIRS; attempt++) {
      const proposal = await request('continuity_plan_align', [], signal => proposePlanAlignment(projectId, original, review.issues, signal))
      candidate = proposal.plan; reason = proposal.reason
      review = await request('continuity_plan_review', [], signal => reviewContinuityPlan(projectId, original, candidate, signal))
    }
    if (!review.consistent)
      throw new VisualValidationError('VISUAL_PLAN_CONTRADICTION', `Plan masih kontradiktif setelah ${MAX_CONTINUITY_REPAIRS} penyelarasan. Plan dan naskah sebelumnya tetap aman.\n${review.issues.join('\n')}`, review.issues)
    assertCurrent()
    if (hash(clipsOf(projectId)) !== baselines) throw new Error('Adegan berubah saat plan direview. Revisi tidak disimpan agar edit kamu tetap aman.')
    db.transaction(() => {
      if (candidate !== original) {
        const oldVersion = session.version, nextVersion = randomUUID()
        const changes: ContinuityCorrection['changes'] = []
        const affected = new Set<number>()
        for (const state of candidate.states) {
          const before = original.states.find(s => s.scene === state.scene)!
          for (const field of ['entering', 'leaving'] as const) if (before[field] !== state[field]) {
            affected.add(state.scene)
            changes.push({ scene: state.scene, clipId: clipsOf(projectId)[state.scene - 1].id, field: `plan.${field}`, before: before[field], after: state[field], reason })
          }
        }
        const globalChange = candidate.recurringDesigns !== original.recurringDesigns
        for (const field of ['recurringDesigns', 'conflicts'] as const) {
          const before = typeof original[field] === 'string' ? original[field] : JSON.stringify(original[field])
          const after = typeof candidate[field] === 'string' ? candidate[field] : JSON.stringify(candidate[field])
          if (before !== after) changes.push({ scene: 0, clipId: '', field: `plan.${field}`, before, after, reason })
        }
        // Keep valid completed batches on the new revision; invalidate only unchanged AI output affected by revised rules.
        for (const c of clipsOf(projectId)) {
          const output = session.outputs[c.id]
          if (!output || output.version !== oldVersion || output.signature !== visualSignature(c)) continue
          if (globalChange || affected.has(c.sort + 1)) {
            db.prepare('UPDATE clips SET visual_source = ? WHERE id = ? AND project_id = ?').run(`continuity:${nextVersion}:stale`, c.id, projectId)
            session.targets[c.id] = visualSignature(c)
          } else output.version = nextVersion
        }
        session.version = nextVersion; session.plan = candidate
        delete session.repair
        session.corrections = [...(session.corrections ?? []), { at: Date.now(), version: nextVersion, ...llm,
          planRevision: { from: oldVersion, to: nextVersion }, notes: [reason, ...review.notes], changes }]
        touchProject(projectId)
      }
      session.planReviewed = hash([session.fingerprint, session.plan])
      saveState(projectId, session)
    })()
    publish(projectId)
  }
  if (session.plan?.conflicts.length) {
    const plan = session.plan
    let feedback: string[] = []
    let edits: ContinuityEdit[] = [], notes: string[] = []
    const baselines = hash(clipsOf(projectId))
    for (let attempt = 0; attempt < MAX_CONTINUITY_REPAIRS; attempt++) {
      edits = await request('continuity_repair', [], signal => proposeContinuityRepair(projectId, plan, feedback, signal))
      try {
        notes = await request('continuity_repair_review', [], signal => reviewContinuityRepair(projectId, plan, edits, signal))
        break
      } catch (error) {
        if (!(error instanceof VisualValidationError) || error.code !== 'VISUAL_CONTINUITY') throw error
        feedback = error.issues ?? []
        delete session.planReviewed
        saveState(projectId, session)
        if (attempt === MAX_CONTINUITY_REPAIRS - 1)
          throw new VisualValidationError(error.code, `Konflik belum selesai setelah ${MAX_CONTINUITY_REPAIRS} koreksi otomatis. Naskah dan prompt asli tetap aman. Periksa detail continuity.\n${error.message}`, feedback)
      }
    }
    assertCurrent()
    if (hash(clipsOf(projectId)) !== baselines) throw new Error('Adegan berubah saat koreksi diproses. Koreksi tidak disimpan agar edit kamu tetap aman.')
    db.transaction(() => {
      const changes: ContinuityCorrection['changes'] = []
      const originals = clipsOf(projectId)
      for (const edit of edits) {
        const clip = originals[edit.scene - 1]
        for (const field of REPAIR_FIELDS) if (clip[field] !== edit[field])
          changes.push({ scene: edit.scene, clipId: clip.id, field, before: clip[field], after: edit[field], reason: edit.reason })
        const storyChanged = clip.story !== edit.story || clip.narration !== edit.narration
        patchClipText(clip.id, { story: edit.story, narration: edit.narration })
        db.prepare('UPDATE clips SET visual_prompt = ?, video_prompt = ?, visual_source = ? WHERE id = ? AND project_id = ?')
          .run(edit.visualPrompt, edit.videoPrompt, storyChanged ? `continuity:${session.version}:stale` : visualSourceOf(edit), clip.id, projectId)
        // Assets remain in history; detach stale media so corrected text cannot play old evidence or speech.
        const media: Partial<Clip> = {}
        if (clip.narration !== edit.narration && clip.audioAssetId) { media.audioAssetId = null; media.voiceInMs = 0; media.voiceOutMs = null; media.voiceStartMs = 0 }
        if (storyChanged || clip.visualPrompt !== edit.visualPrompt || clip.videoPrompt !== edit.videoPrompt) {
          if (clip.imageAssetId) media.imageAssetId = null
          if (clip.videoAssetId) media.videoAssetId = null
        }
        for (const field of ['audioAssetId', 'imageAssetId', 'videoAssetId'] as const) if (field in media)
          changes.push({ scene: edit.scene, clipId: clip.id, field, before: clip[field] ?? '', after: '', reason: 'Perlu dibuat ulang setelah koreksi; aset lama tetap ada di riwayat.' })
        patchClip(clip.id, media)
        if (storyChanged || clip.visualPrompt !== edit.visualPrompt || clip.videoPrompt !== edit.videoPrompt) {
          delete session.outputs[clip.id]
          const current = clipsOf(projectId).find(c => c.id === clip.id)!
          session.targets[clip.id] = visualSignature(current)
          if (!storyChanged && current.visualPrompt.trim() && !needsVisual(current))
            session.outputs[clip.id] = { signature: visualSignature(current), version: session.version }
        }
      }
      session.corrections = [...(session.corrections ?? []), { at: Date.now(), version: session.version, ...llm, notes: plan.conflicts.map((issue, i) => `${issue}\nPenyelesaian: ${notes[i]}`), changes }]
      session.plan = { ...plan, conflicts: [] }
      applyVisuals(projectId, plan.characters, [])
      session.fingerprint = fingerprint(projectId)
      session.planReviewed = hash([session.fingerprint, session.plan])
      delete session.repair
      touchProject(projectId)
      saveState(projectId, session)
    })()
    publish(projectId)
  }
  while (pending().length) {
    assertCurrent()
    const batch = pending().slice(0, BATCH_SIZE)
    const clips = clipsOf(projectId)
    const numbers = batch.map((c) => clips.findIndex((a) => a.id === c.id) + 1)
    const baselines = new Map(batch.map((c) => [c.id, visualSignature(c)]))
    const savedRepair = session.repair
    let repair = savedRepair && hash(savedRepair.numbers) === hash(numbers) &&
      [...baselines].every(([id, signature]) => savedRepair.baselines[id] === signature) ? savedRepair.draft : undefined
    let updates: SceneVisual[]
    for (let correction = 0; ; correction++) {
      updates = await request(repair ? 'repair' : 'visuals', numbers, (signal) => generateVisualBatch(projectId, numbers, session.plan!, signal, repair))
      try {
        await request('review', numbers, (signal) => reviewVisualBatch(session.plan!, updates.map((v, i) => ({ ...v, scene: numbers[i] })), signal))
        break
      } catch (error) {
        // Only a typed semantic rejection can trigger bounded draft correction, never HTTP/parse failures.
        if (!(error instanceof VisualValidationError) || error.code !== 'VISUAL_CONTINUITY' || !error.issues?.length) throw error
        assertCurrent()
        if (clipsOf(projectId).some((c) => baselines.has(c.id) && baselines.get(c.id) !== visualSignature(c)))
          throw new Error('Visual diedit saat batch diproses. Hasil batch ditahan agar edit kamu tetap aman.')
        repair = { scenes: updates, issues: error.issues }
        // Keep rejected drafts separate from approved clips so Resume can use feedback after restart.
        session.repair = { numbers, baselines: Object.fromEntries(baselines), draft: repair }
        saveState(projectId, session)
        if (correction >= MAX_CONTINUITY_REPAIRS)
          throw new VisualValidationError(error.code, `Batch masih bertentangan setelah ${MAX_CONTINUITY_REPAIRS} perbaikan otomatis. Prompt sebelumnya tetap aman. Lanjutkan untuk mencoba kembali.\n${error.message}`, error.issues)
      }
    }
    assertCurrent()
    if (clipsOf(projectId).some((c) => baselines.has(c.id) && baselines.get(c.id) !== visualSignature(c)))
      throw new Error('Visual diedit saat batch diproses. Hasil batch ditahan agar edit kamu tetap aman.')
    db.transaction(() => {
      if (repair) {
        const changes: ContinuityCorrection['changes'] = []
        for (let i = 0; i < updates.length; i++) for (const field of ['visualPrompt', 'videoPrompt'] as const) {
          const before = repair.scenes[i][field], after = updates[i][field]
          if (before !== after) changes.push({ scene: numbers[i], clipId: updates[i].clipId, field, before, after, reason: repair.issues.join('\n') })
        }
        session.corrections = [...(session.corrections ?? []), { at: Date.now(), version: session.version, ...llm, notes: repair.issues, changes }]
      }
      applyVisuals(projectId, [], updates)
      delete session.repair
      for (const c of clipsOf(projectId)) {
        if (baselines.has(c.id)) session.outputs[c.id] = { signature: visualSignature(c), version: session.version }
      }
      saveState(projectId, session)
    })()
    publish(projectId)
    const total = clipsOf(projectId).length
    ctx.progress((total - pending().length) / total, `${total - pending().length}/${total} prompt visual tersimpan`)
  }
  assertCurrent()
  if (clipsOf(projectId).some(needsVisual)) throw new Error('Masih ada visual yang kosong atau usang. Lanjutkan untuk menyelesaikannya.')
}
