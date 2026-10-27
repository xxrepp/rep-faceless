import { useEffect, useState } from 'react'
import { Copy, Download, Image as ImageIcon, Sparkles } from 'lucide-react'
import type { PublicationMaterials } from '@shared/types'
import { getMediaImageModel } from '@shared/media'
import { getStyle } from '@shared/styles'
import { Button, Field, Modal, Progress, confirmDialog, inputCls } from '../../components/ui'
import { errorText } from '../../lib/format'
import { useApp } from '../../store/app'
import { isRunning, jobFor, useProject } from '../../store/project'

export function PublicationPanel({ onClose }: { onClose: () => void }) {
  const { project, assets, jobs, flush, upsertJob } = useProject()
  const { toast } = useApp()
  const [data, setData] = useState<PublicationMaterials | null>(null)
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const writing = jobFor(jobs, 'publication', {}), imaging = jobFor(jobs, 'thumbnail', {})
  const active = isRunning(writing) ? writing : isRunning(imaging) ? imaging : null
  useEffect(() => {
    let alive = true
    if (project) void window.api.publication.get(project.id).then(value => { if (alive) { setData(value); setDirty(false) } }).catch(e => { if (alive) setError(errorText(e)) })
    return () => { alive = false }
  }, [project?.id, writing?.id, writing?.status])
  if (!project) return null
  const thumbnail = Object.values(assets).filter(a => a.meta.purpose === 'thumbnail').sort((a, b) => b.createdAt - a.createdAt)[0]
  const save = async (): Promise<void> => {
    if (!data || !dirty) return
    const value = await window.api.publication.save(project.id, data)
    setData(value); setDirty(false)
  }
  const perform = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true); setError(null)
    try { await action() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const close = (): void => { void perform(async () => { await save(); onClose() }) }
  const generate = (image: boolean): void => { void perform(async () => {
    if (!image && data && (data.title || data.description || data.thumbnailPrompt) && !await confirmDialog({ title: 'Generate ulang materi publikasi?', body: 'Judul, deskripsi, dan prompt akan diganti setelah hasil baru selesai. Thumbnail yang sudah dibuat tetap tersimpan.', confirm: 'Generate ulang' })) return
    await flush()
    if (useProject.getState().saveState === 'error') throw new Error('Simpan perubahan proyek dulu sebelum generate.')
    await save()
    upsertJob(await (image ? window.api.publication.thumbnail(project.id) : window.api.publication.generate(project.id)))
  }) }
  const update = (key: 'title' | 'description' | 'thumbnailPrompt', value: string): void => { setData({ ...data!, [key]: value }); setDirty(true) }
  const copy = (value: string): void => { void perform(async () => { await window.api.app.copyText(value); toast('success', 'Teks disalin.') }) }
  return <Modal open onClose={close} title="Materi publikasi" subtitle="Thumbnail dan deskripsi untuk unggahanmu. Tersimpan terpisah dari adegan dan tidak ikut diekspor ke video." width={1020}>
    <div className="flex flex-wrap items-center gap-3">
      <Button variant="primary" icon={<Sparkles size={16} />} disabled={!data || !!active || busy} onClick={() => generate(false)}>Generate judul & deskripsi</Button>
      <span className="text-sm text-ink-2">{getStyle(project.styleId).name} · {project.aspectRatio === '9:16' ? 'Shorts 9:16' : 'YouTube 16:9'}</span>
    </div>
    {data?.stale && <p role="status" className="rounded-xl bg-sun-soft p-3 text-sm text-ink">Konten atau gaya proyek berubah sejak materi ini dibuat. Periksa atau generate ulang sebelum mengunggah.</p>}
    <div className="grid min-w-0 grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)] gap-6">
      <div className="min-w-0 space-y-4">
        <div className="flex min-h-48 items-center justify-center overflow-hidden rounded-xl border border-line bg-paper" style={{ aspectRatio: project.aspectRatio === '9:16' ? '9 / 16' : '16 / 9', maxHeight: 300 }}>
          {thumbnail ? <img src={thumbnail.url} alt="Thumbnail publikasi proyek" className="max-h-[300px] w-full object-contain" /> : <div className="px-5 text-center text-sm text-ink-2"><ImageIcon className="mx-auto mb-3 size-7" />Generate konsep, lalu buat thumbnail.</div>}
        </div>
        <p className="text-xs text-muted">Model gambar: {getMediaImageModel(project.imageModel).name}. Memakai gaya dan referensi pemeran proyek. Generate gambar memakai layanan yang dipilih di proyek.</p>
        <div className="flex flex-wrap gap-2">
          <Button icon={<ImageIcon size={16} />} disabled={!data?.thumbnailPrompt.trim() || !!active || busy} onClick={() => generate(true)}>{thumbnail ? 'Buat ulang thumbnail' : 'Buat thumbnail'}</Button>
          {thumbnail && <Button icon={<Download size={16} />} disabled={busy} onClick={() => void perform(async () => { const path = await window.api.publication.saveThumbnail(project.id, thumbnail.id); if (path) toast('success', 'Thumbnail disimpan.') })}>Simpan gambar</Button>}
        </div>
        <Field label="Arahan thumbnail" hint="Boleh diedit sebelum membuat gambar. Fokuskan pada momen utama tanpa membocorkan akhir cerita.">
          <textarea aria-label="Arahan thumbnail" rows={5} maxLength={12000} disabled={!data || !!active || busy} value={data?.thumbnailPrompt ?? ''} onChange={e => update('thumbnailPrompt', e.target.value)} className={`${inputCls} w-full resize-y py-3 text-sm`} />
        </Field>
      </div>
      <div className="min-w-0 space-y-4">
        <Field label="Judul unggahan">
          <input aria-label="Judul unggahan" maxLength={100} disabled={!data || !!active || busy} value={data?.title ?? ''} onChange={e => update('title', e.target.value)} className={`${inputCls} h-11 w-full`} />
        </Field>
        <Button size="sm" icon={<Copy size={14} />} disabled={!data?.title || busy} onClick={() => copy(data!.title)}>Salin judul</Button>
        <Field label="Deskripsi video / Shorts">
          <textarea aria-label="Deskripsi video / Shorts" rows={10} maxLength={5000} disabled={!data || !!active || busy} value={data?.description ?? ''} onChange={e => update('description', e.target.value)} className={`${inputCls} w-full resize-y py-3 text-sm`} />
        </Field>
        <div className="flex items-center justify-between gap-2">
          <Button size="sm" icon={<Copy size={14} />} disabled={!data?.description || busy} onClick={() => copy(data!.description)}>Salin deskripsi</Button>
          <span className="text-xs text-muted">{data?.description.length ?? 0} / 5.000</span>
        </div>
      </div>
    </div>
    {active && <div role="status" aria-live="polite"><p className="mb-2 text-sm">{active.message ?? 'Menyiapkan…'}</p><Progress value={active.progress} /><Button size="sm" className="mt-2" disabled={busy} onClick={() => void perform(() => window.api.generate.cancel(active.id))}>Batalkan</Button></div>}
    {(error || writing?.error || imaging?.error) && <p role="alert" className="whitespace-pre-wrap break-words text-sm text-bad-ink">{error || writing?.error || imaging?.error}</p>}
    <div className="flex items-center justify-end gap-3 border-t border-line pt-4">
      <span role="status" className="mr-auto text-sm text-muted">{dirty ? 'Perubahan belum disimpan' : 'Materi tersimpan di proyek'}</span>
      <Button disabled={!dirty || busy || !!active} onClick={() => void perform(save)}>Simpan perubahan</Button>
      <Button disabled={busy} onClick={close}>Tutup</Button>
    </div>
  </Modal>
}
