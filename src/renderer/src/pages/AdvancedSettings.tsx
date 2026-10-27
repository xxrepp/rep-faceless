import { useCallback, useEffect, useState } from 'react'
import { DEFAULT_SCRIPT_INSTRUCTIONS, DEFAULT_VISUAL_INSTRUCTIONS, INSTRUCTION_LIMIT, resolveInstructions } from '@shared/storyInstructions'
import { ORIGINAL_PROMPT_PRESET } from '@shared/promptPresets'
import type { AppSettings, InstructionMode, PromptInstructions, PromptPreset } from '@shared/types'
import { StyleInstructions } from './StyleInstructions'
import { Select } from '../components/Select'
import { Button, Segmented, confirmDialog, inputCls } from '../components/ui'
import { errorText } from '../lib/format'

type InstructionKey = 'scriptInstructions' | 'visualInstructions'

function InstructionEditor({ field, title, description, fallback, settings, saveSettings, onDirtyChange }: {
  field: InstructionKey
  title: string
  description: string
  fallback: string
  settings: AppSettings
  saveSettings: (patch: Partial<PromptInstructions>) => Promise<void>
  onDirtyChange: (key: string, dirty: boolean) => void
}) {
  const modeKey = field === 'scriptInstructions' ? 'scriptInstructionsMode' : 'visualInstructionsMode'
  const mode = settings[modeKey]
  const saved = resolveInstructions(settings[field], fallback)
  const [draft, setDraft] = useState(saved)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => { setDraft(saved) }, [saved])
  const dirty = draft.trim() !== saved.trim()
  useEffect(() => onDirtyChange(field, dirty), [field, dirty, onDirtyChange])

  const changeMode = async (value: InstructionMode): Promise<void> => {
    setBusy(true)
    setError('')
    try { await saveSettings({ [modeKey]: value }); setMessage(value === 'original' ? 'Instruksi asli aktif. Teks kustom tetap tersimpan.' : 'Instruksi kustom aktif untuk generasi berikutnya.') }
    catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  const save = async (reset = false): Promise<void> => {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const text = reset ? '' : draft.trim()
      const value = !text || text === fallback ? '' : text
      await saveSettings({ [field]: value })
      setDraft(resolveInstructions(value, fallback))
      setMessage(reset ? 'Instruksi bawaan dipulihkan.' : 'Instruksi tersimpan untuk generasi berikutnya.')
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }

  return <section className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
    <div>
      <h2 className="text-lg font-bold">{title}</h2>
      <p className="mt-1 text-sm text-ink-2">{description}</p>
    </div>
    <div role="group" aria-label={`Mode ${title}`}>
      <Segmented<InstructionMode> value={mode} options={[{ id: 'original', label: 'Asli (Original)', disabled: busy }, { id: 'custom', label: 'Kustom (Custom)', disabled: busy }]} onChange={value => void changeMode(value)} />
    </div>
    <textarea aria-label={title} value={mode === 'original' ? fallback : draft} readOnly={mode === 'original'} disabled={busy} maxLength={INSTRUCTION_LIMIT} rows={12}
      spellCheck={false} className={`${inputCls} min-h-[240px] w-full resize-y py-3 font-mono text-[13px] leading-relaxed`}
      onChange={e => { setDraft(e.target.value); setMessage(''); setError('') }} />
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-xs text-ink-2">{(mode === 'original' ? fallback : draft).length.toLocaleString('id-ID')} / {INSTRUCTION_LIMIT.toLocaleString('id-ID')} karakter · {mode === 'original' ? (dirty ? 'Asli aktif · perubahan kustom belum disimpan' : 'Instruksi asli aktif') : dirty ? 'Perubahan kustom belum disimpan' : 'Instruksi kustom aktif'}</span>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || mode === 'original' || (!dirty && !settings[field]?.trim())} onClick={() => void save(true)}>Pulihkan bawaan</Button>
        <Button variant="primary" disabled={busy || mode === 'original' || !dirty} onClick={() => void save()}>{busy ? 'Menyimpan…' : 'Simpan instruksi'}</Button>
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-bad-ink">{error}</p>}
    {message && <p role="status" className="text-sm text-ok-ink">{message}</p>}
  </section>
}

export function AdvancedSettings({ settings, onSettings }: { settings: AppSettings; onSettings: (settings: AppSettings) => void }) {
  const [selectedId, setSelectedId] = useState(settings.promptPresets[0]?.id ?? '')
  const selected = settings.promptPresets.find(p => p.id === selectedId) ?? settings.promptPresets[0]
  const [name, setName] = useState(selected?.name ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [dirtyFields, setDirtyFields] = useState<Record<string, boolean>>({})
  const onDirtyChange = useCallback((key: string, dirty: boolean) => {
    setDirtyFields(fields => fields[key] === dirty ? fields : { ...fields, [key]: dirty })
  }, [])
  useEffect(() => { setName(selected?.name ?? '') }, [selected?.id, selected?.name])
  const canLeave = async (): Promise<boolean> => {
    if (!Object.values(dirtyFields).some(Boolean) && name.trim() === (selected?.name ?? '')) return true
    return confirmDialog({ title: 'Abaikan perubahan belum disimpan?', body: 'Simpan perubahan pada slot ini dulu jika masih diperlukan.', confirm: 'Abaikan perubahan' })
  }
  const saveCollection = async (presets: PromptPreset[], nextId: string, notice: string): Promise<void> => {
    setBusy(true); setError(''); setMessage('')
    try {
      onSettings(await window.api.settings.set({ promptPresets: presets }))
      if (nextId !== selected?.id) setDirtyFields({})
      setSelectedId(nextId); setMessage(notice)
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  const savePreset = async (patch: Partial<PromptInstructions>): Promise<void> => {
    if (!selected) throw new Error('Pilih slot prompt dulu.')
    setBusy(true)
    try { onSettings(await window.api.settings.set({ promptPresets: settings.promptPresets.map(p => p.id === selected.id ? { ...p, ...patch } : p) })) }
    finally { setBusy(false) }
  }
  const choose = async (id: string): Promise<void> => {
    if (id === selected?.id || !(await canLeave())) return
    setSelectedId(id); setDirtyFields({}); setError(''); setMessage('')
  }
  const add = async (copy: boolean): Promise<void> => {
    if (!(await canLeave())) return
    const base = copy && selected ? selected : ORIGINAL_PROMPT_PRESET
    const prefix = copy ? `${base.name.slice(0, 55)} (salinan)` : 'Preset baru'
    let nextName = prefix, number = 2
    while (settings.promptPresets.some(p => p.name.toLowerCase() === nextName.toLowerCase())) nextName = `${prefix} ${number++}`
    const preset = { ...structuredClone(base), id: crypto.randomUUID(), name: nextName }
    await saveCollection([...settings.promptPresets, preset], preset.id, 'Slot tersimpan. Ubah namanya sesuai channel atau niche kamu.')
  }
  const remove = async (): Promise<void> => {
    if (!selected || !(await confirmDialog({ title: 'Hapus slot prompt?', body: `Slot “${selected.name}” akan dihapus. Proyek yang sudah memakai preset ini tetap menyimpan salinannya.`, confirm: 'Hapus slot', danger: true }))) return
    const remaining = settings.promptPresets.filter(p => p.id !== selected.id)
    await saveCollection(remaining, remaining[0]?.id ?? '', 'Slot dihapus. Prompt pada proyek yang sudah dibuat tetap aman.')
  }
  const editingSettings = selected ? { ...settings, ...selected } : settings
  return <>
    <div>
      <h1 className="font-display text-[34px] font-bold tracking-[-0.015em]">Pengaturan lanjutan</h1>
      <p className="mt-2 text-[15px] text-ink-2">Simpan preset prompt terpisah untuk tiap channel atau niche. Pilih presetnya saat membuat proyek baru.</p>
    </div>
    <section className="flex min-w-0 flex-col gap-3 rounded-2xl border border-line bg-surface p-5">
      <h2 className="text-lg font-bold">Slot prompt</h2>
      <div className="flex flex-wrap items-center gap-2">
        {selected && <Select label="Slot prompt yang diedit" value={selected.id} onChange={id => void choose(id)} disabled={busy}
          options={settings.promptPresets.map(p => ({ value: p.id, label: p.name }))} className="min-w-[240px]" />}
        <Button disabled={busy} onClick={() => void add(false)}>Tambah slot</Button>
        <Button disabled={busy || !selected} onClick={() => void add(true)}>Duplikat slot</Button>
        <Button disabled={busy || !selected} onClick={() => void remove()}>Hapus slot</Button>
      </div>
      {selected ? <div className="flex flex-wrap items-end gap-2">
        <label className="flex min-w-[240px] flex-1 flex-col gap-1.5"><span className="text-sm font-semibold">Nama slot / channel</span>
          <input aria-label="Nama slot prompt" className={inputCls} value={name} maxLength={80} disabled={busy} onChange={e => setName(e.target.value)} /></label>
        <Button disabled={busy || !name.trim() || name.trim() === selected.name} onClick={() => void saveCollection(settings.promptPresets.map(p => p.id === selected.id ? { ...p, name } : p), selected.id, 'Nama slot tersimpan.')}>Simpan nama</Button>
      </div> : <p className="text-sm text-ink-2">Belum ada slot tersimpan. Tambahkan slot untuk menyimpan arahan channel kamu.</p>}
      {error && <p role="alert" className="text-sm text-bad-ink">{error}</p>}
      {message && <p role="status" className="text-sm text-ok-ink">{message}</p>}
    </section>
    <div className="rounded-xl border border-line bg-sand px-4 py-3 text-sm text-ink-2">
      Proyek baru menyimpan salinan preset yang kamu pilih. Edit atau hapus slot di sini tidak mengubah proyek yang sudah dibuat. Proyek lama tetap memakai pengaturan sebelumnya.
    </div>
    {selected && <fieldset key={selected.id} disabled={busy} className="flex min-w-0 flex-col gap-5">
      <InstructionEditor field="scriptInstructions" title="1. Naskah dan hook" description="Atur pembukaan, alur cerita, ketegangan, gaya narator, dan penutup." fallback={DEFAULT_SCRIPT_INSTRUCTIONS} settings={editingSettings} saveSettings={savePreset} onDirtyChange={onDirtyChange} />
      <InstructionEditor field="visualInstructions" title="2. Storyboard dan karakter" description="Atur momen yang ditampilkan, kesinambungan adegan, framing, kostum, dan karakter. Gaya gambar tetap mengikuti pilihan proyek." fallback={DEFAULT_VISUAL_INSTRUCTIONS} settings={editingSettings} saveSettings={savePreset} onDirtyChange={onDirtyChange} />
      <StyleInstructions settings={editingSettings} saveSettings={savePreset} onDirtyChange={onDirtyChange} />
    </fieldset>}
    <details className="rounded-xl border border-line bg-surface px-4 py-3 text-sm text-ink-2">
      <summary className="cursor-pointer font-semibold text-ink">Aturan yang tetap diatur Bang Story</summary>
      <p className="mt-2">Format keluaran, bahasa proyek, jumlah adegan yang diminta, pilihan gerak kamera, dan template narasi dengan jeda hening tetap disertakan otomatis. Kamu tidak perlu menulis format JSON atau placeholder. Instruksi ini mengarahkan LLM penyusun cerita dan storyboard; prompt gaya gambar dan reference sheet tetap ditambahkan saat generasi gambar.</p>
    </details>
  </>
}
