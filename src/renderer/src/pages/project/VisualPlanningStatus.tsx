import { useEffect, useId, useState } from 'react'
import { ChevronDown, ChevronUp } from 'lucide-react'
import type { ProjectBundle } from '@shared/types'
import { needsVisual } from '@shared/script'
import { Button, Progress } from '../../components/ui'
import { errorText } from '../../lib/format'
import { isRunning, jobFor, useProject } from '../../store/project'

/** Job errors outlive toasts and remain available after restarting the app. */
export function VisualPlanningStatus() {
  const { project, jobs, clips, flush, upsertJob } = useProject()
  const job = jobFor(jobs, 'visuals', {})
  const running = isRunning(job)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [continuity, setContinuity] = useState<ProjectBundle['visualContinuity']>(null)
  const [corrections, setCorrections] = useState<NonNullable<ProjectBundle['visualCorrections']>>([])
  const [diagnostics, setDiagnostics] = useState<string[]>([])
  const [detailsPreference, setDetailsPreference] = useState<boolean | null>(() => {
    try {
      const saved = localStorage.getItem('bangstory.visualPlanning.details')
      return saved === 'open' ? true : saved === 'closed' ? false : null
    } catch { return null }
  })
  const detailsId = useId()
  const projectId = project?.id
  useEffect(() => {
    let alive = true
    if (projectId) void window.api.projects.get(projectId).then((b) => { if (alive) { setContinuity(b.visualContinuity); setDiagnostics(b.visualDiagnostics ?? []); setCorrections(b.visualCorrections ?? []) } }).catch(() => {})
    return () => { alive = false }
  }, [projectId, job?.id, job?.status])
  if (!project || (!job && !error)) return null
  const resume = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    setDismissed(null)
    try {
      await flush()
      if (useProject.getState().saveState === 'error') throw new Error('Simpan perubahan proyek dulu sebelum melanjutkan.')
      upsertJob(await window.api.story.visuals(project.id, 'missing'))
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const cancel = async (): Promise<void> => {
    setBusy(true)
    try { await window.api.generate.cancel(job!.id) } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const failure = error ?? (job?.status === 'failed' && dismissed !== job.id ? job.error : null)
  const unfinished = clips.some(needsVisual) || job?.status === 'failed' || job?.status === 'canceled'
  const expanded = detailsPreference ?? (running || !!failure)
  const toggleDetails = (): void => {
    const next = !expanded
    setDetailsPreference(next)
    try { localStorage.setItem('bangstory.visualPlanning.details', next ? 'open' : 'closed') } catch { /* The toggle still works when storage is unavailable. */ }
  }
  return (
    <section aria-label="Perencanaan prompt visual" className="shrink-0 border-b border-line bg-surface px-8 py-2">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1" role="status" aria-live="polite">
          <p className="text-sm font-semibold">{running ? job?.message ?? 'Menyiapkan perencanaan visual…' : job?.status === 'done' ? 'Proses terakhir selesai · Prompt visual tersimpan' : `${clips.filter((c) => !needsVisual(c)).length}/${clips.length} prompt tersedia · Perencanaan terhenti`}</p>
        </div>
        {running ? <Button size="sm" loading={busy} onClick={() => void cancel()}>Batalkan</Button> : unfinished && <Button size="sm" variant="primary" loading={busy} onClick={() => void resume()}>{job?.status === 'failed' ? 'Coba lagi / Lanjutkan' : 'Lanjutkan'}</Button>}
        <Button size="sm" variant="ghost" aria-expanded={expanded} aria-controls={detailsId} onClick={toggleDetails}>
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          {expanded ? 'Sembunyikan detail' : failure ? 'Lihat error' : corrections.length ? `Catatan koreksi (${corrections.length})` : 'Tampilkan detail'}
        </Button>
      </div>
      <div id={detailsId} hidden={!expanded}>
        <p className="mt-1 text-xs text-muted">Perencanaan ini menyusun prompt. Gambar dibuat terpisah di Storyboard. {running && 'Batalkan dulu untuk mengedit naskah atau referensi.'}</p>
        {running && <Progress value={job!.progress} className="mt-2" />}
        {failure && <div role="alert" className="mt-2 flex items-start gap-3 text-sm text-bad-ink">
          <p className="min-w-0 flex-1 whitespace-pre-wrap break-words">{failure}</p>
          <Button size="sm" onClick={() => { setDismissed(job?.id ?? null); setError(null) }}>Tutup pesan</Button>
        </div>}
        {diagnostics.length > 0 && <details className="mt-2 max-h-32 overflow-auto text-xs text-ink-2">
          <summary className="cursor-pointer font-semibold">Detail percobaan provider</summary>
          {diagnostics.map((line, i) => <p key={i} className="mt-1 break-words">{line}</p>)}
        </details>}
        {corrections.length > 0 && <details className="mt-2 max-h-64 overflow-auto text-xs text-ink-2">
          <summary className="cursor-pointer font-semibold">Catatan koreksi otomatis · {corrections.length} pemeriksaan selesai</summary>
          {corrections.map((entry, i) => <div key={i} className="mt-3 border-t border-line pt-2">
            <p>{entry.planRevision && `Revisi plan ${entry.planRevision.from.slice(0, 8)} → ${entry.planRevision.to.slice(0, 8)} · `}{new Date(entry.at).toLocaleString('id-ID')} · {entry.provider}/{entry.model}</p>
            {entry.notes.map((note, n) => <p key={n} className="mt-1 whitespace-pre-wrap break-words">{note}</p>)}
            {!entry.changes.length && <p className="mt-1">Tidak ada teks diubah. Review memastikan konflik sudah terjelaskan oleh naskah.</p>}
            {entry.changes.map((change, n) => <details key={n} className="mt-2">
              <summary className="cursor-pointer font-semibold">{change.scene ? `Adegan ${change.scene}` : 'Continuity plan'} · {({ 'plan.entering': 'Plan: status masuk', 'plan.leaving': 'Plan: status keluar', 'plan.recurringDesigns': 'Plan: ruang dan properti', 'plan.conflicts': 'Plan: daftar konflik', story: 'Alur', narration: 'Narasi', visualPrompt: 'Prompt gambar', videoPrompt: 'Prompt video', audioAssetId: 'Suara perlu dibuat ulang', imageAssetId: 'Gambar perlu dibuat ulang', videoAssetId: 'Video perlu dibuat ulang' } as Record<string, string>)[change.field] ?? change.field}</summary>
              <p className="mt-1 whitespace-pre-wrap break-words">{change.reason}</p>
              <p className="mt-1 whitespace-pre-wrap break-words">Sebelum: {change.before || '(kosong)'}</p>
              <p className="mt-1 whitespace-pre-wrap break-words">Sesudah: {change.after || '(kosong)'}</p>
            </details>)}
          </div>)}
        </details>}
        {continuity && <details className="mt-2 max-h-40 overflow-auto text-xs text-ink-2">
          <summary className="cursor-pointer font-semibold">Continuity plan tersimpan · {continuity.version.slice(0, 8)}</summary>
          <p className="mt-2 whitespace-pre-wrap break-words">{[continuity.world, continuity.direction, continuity.recurringDesigns].join('\n')}</p>
          {continuity.conflicts.map((c, i) => <p key={i} className="mt-1 break-words text-bad-ink">{c}</p>)}
        </details>}
      </div>
    </section>
  )
}
