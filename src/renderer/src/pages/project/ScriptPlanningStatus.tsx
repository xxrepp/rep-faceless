import { useEffect, useRef, useState } from 'react'
import { Button, Progress } from '../../components/ui'
import { errorText } from '../../lib/format'
import { isRunning, jobFor, useProject } from '../../store/project'

export function ScriptPlanningStatus() {
  const { project, jobs, load, flush, upsertJob } = useProject()
  const job = jobFor(jobs, 'story', {})
  const running = isRunning(job)
  const loaded = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    if (!project || job?.status !== 'done' || loaded.current === job.id) return
    let alive = true
    void window.api.projects.get(project.id).then(bundle => {
      if (alive && useProject.getState().project?.id === project.id && useProject.getState().saveState === 'saved') {
        loaded.current = job.id
        load(bundle)
      }
    }).catch(e => { if (alive) setError(errorText(e)) })
    return () => { alive = false }
  }, [project?.id, job?.id, job?.status])
  if (!project || (!job && !error) || (job?.status === 'done' && !error)) return null
  const action = async (): Promise<void> => {
    setBusy(true); setError(null)
    try {
      if (running) await window.api.generate.cancel(job!.id)
      else {
        await flush()
        if (useProject.getState().saveState === 'error') throw new Error('Simpan perubahan proyek dulu sebelum melanjutkan.')
        upsertJob(await window.api.story.script(project.id, 'resume'))
      }
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return <section aria-label="Penyusunan naskah" className="shrink-0 border-b border-line bg-surface px-8 py-3">
    <div className="flex items-center gap-3">
      <div className="min-w-0 flex-1" role="status" aria-live="polite">
        <p className="text-sm font-semibold">{running ? job?.message ?? 'Menyiapkan naskah…' : 'Penyusunan naskah terhenti · Batch tersimpan tetap aman'}</p>
        <p className="mt-1 text-xs text-muted">Batch berjalan otomatis. Naskah lama diganti setelah seluruh adegan selesai.</p>
      </div>
      <Button size="sm" loading={busy} onClick={() => void action()}>{running ? 'Batalkan' : 'Lanjutkan naskah'}</Button>
    </div>
    {running && <Progress value={job!.progress} className="mt-2" />}
    {(error || job?.error) && <p role="alert" className="mt-2 whitespace-pre-wrap break-words text-sm text-bad-ink">{error || job?.error}</p>}
  </section>
}
