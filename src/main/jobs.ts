import type { Job } from '@shared/types'
import { emit } from './events'
import { getJobRaw, updateJob } from './repo'
import { cancelRequest } from './services/higgsfield'
import { getSettings } from './settings'
import { WorkQueue } from './workQueue'
import { FlowSetupError } from '@shared/flowErrors'

export type QueueName = 'visuals' | 'higgsfield' | 'flow2api' | 'flow2api-sheet' | 'flow2api-video' | 'tts' | 'whisper' | 'export' | 'effects'

export interface TaskCtx {
  jobId: string
  signal: AbortSignal
  progress(p: number, message?: string): void
  setRemote(id: string): void
}

/** A task returns the id of the asset it produced, or a message to keep on the finished job (e.g. an output path). */
export type Task = (ctx: TaskCtx) => Promise<string | void | { message: string }>

// Whisper uses most CPU cores by itself, so it runs one file at a time.
// Sheets need their own lane: a scene may wait for a sheet queued after it.
const LIMITS: Record<QueueName, number> = { visuals: 1, higgsfield: 3, flow2api: 2, 'flow2api-sheet': 1, 'flow2api-video': 1, tts: 2, whisper: 1, export: 1, effects: 1 }
const queues = Object.fromEntries(Object.keys(LIMITS).map(name => [name, new WorkQueue(() => name === 'flow2api' ? getSettings().flowImageConcurrency : LIMITS[name as QueueName])])) as Record<QueueName, WorkQueue>
const controllers = new Map<string, AbortController>()
const pending = new Map<string, QueueName>()
// A setup failure must not strand a batch behind a persistent pause state.
// Cancel only work that has not started; a submitted request may still succeed.
function stopWaitingFlowJobs(): void {
  for (const [id, name] of pending) {
    if (name.startsWith('flow2api')) controllers.get(id)?.abort()
  }
}

export function runJob(job: Job, queue: QueueName, task: Task): Job {
  const ctrl = new AbortController()
  controllers.set(job.id, ctrl)
  pending.set(job.id, queue)
  let lastEmit = 0
  const ctx: TaskCtx = {
    jobId: job.id,
    signal: ctrl.signal,
    progress: (p, message) => {
      const now = Date.now()
      const j = updateJob(job.id, { progress: Math.min(0.99, Math.max(0, p)), ...(message !== undefined ? { message } : {}) })
      if (now - lastEmit > 250 || p >= 0.99) {
        lastEmit = now
        emit.job(j)
      }
    },
    setRemote: (id) => {
      updateJob(job.id, { remoteId: id })
    }
  }
  void (async () => {
    let release: (() => void) | undefined
    try {
      release = await queues[queue].acquire(ctrl.signal)
      pending.delete(job.id)
      if (ctrl.signal.aborted) throw new Error('Canceled')
      emit.job(updateJob(job.id, { status: 'running', progress: 0.02 }))
      const result = await task(ctx)
      ctrl.signal.throwIfAborted()
      const extra =
        typeof result === 'string' ? { resultAssetId: result, message: null } : { message: result?.message ?? null }
      emit.job(updateJob(job.id, { status: 'done', progress: 1, ...extra }))
    } catch (e) {
      const canceled = ctrl.signal.aborted
      if (!canceled && queue.startsWith('flow2api') && e instanceof FlowSetupError) stopWaitingFlowJobs()
      emit.job(
        updateJob(job.id, {
          status: canceled ? 'canceled' : 'failed',
          error: canceled ? null : ((e as Error)?.message ?? String(e)),
          message: null
        })
      )
      if (!canceled) console.error(`[job ${job.kind}]`, e)
    } finally {
      pending.delete(job.id)
      release?.()
      controllers.delete(job.id)
    }
  })()
  return job
}

export async function cancelJob(id: string): Promise<void> {
  const raw = getJobRaw(id)
  if (!raw) return
  if (raw.remote_id && raw.provider === 'higgsfield') await cancelRequest(raw.remote_id)
  const ctrl = controllers.get(id)
  if (ctrl) ctrl.abort()
  else if (raw.status === 'queued' || raw.status === 'running') emit.job(updateJob(id, { status: 'canceled', message: null }))
}

export function isActive(id: string): boolean {
  return controllers.has(id)
}
