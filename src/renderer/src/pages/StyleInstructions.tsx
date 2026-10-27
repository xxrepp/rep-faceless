import { useEffect, useState } from 'react'
import { getStyle, type VisualStyleOverride } from '@shared/styles'
import { INSTRUCTION_LIMIT } from '@shared/storyInstructions'
import type { AppSettings, InstructionMode, PromptInstructions } from '@shared/types'
import { StyleMenu } from '../components/StyleMenu'
import { Button, Segmented, inputCls } from '../components/ui'
import { errorText } from '../lib/format'

function StyleEditor({ id, settings, saveSettings, onDirtyChange }: { id: string; settings: AppSettings; saveSettings: (patch: Partial<PromptInstructions>) => Promise<void>; onDirtyChange: (key: string, dirty: boolean) => void }) {
  const original = getStyle(id)
  const saved = settings.visualStyleOverrides[id]
  const mode = saved?.mode ?? 'original'
  const savedPrompt = saved?.prompt ?? original.prompt
  const savedHint = saved?.characterHint ?? original.characterHint
  const [prompt, setPrompt] = useState(savedPrompt)
  const [hint, setHint] = useState(savedHint)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  useEffect(() => { setPrompt(savedPrompt); setHint(savedHint) }, [savedPrompt, savedHint])
  const dirty = prompt !== savedPrompt || hint !== savedHint
  useEffect(() => onDirtyChange(`style:${id}`, dirty), [id, dirty, onDirtyChange])

  const persist = async (entry: VisualStyleOverride, notice: string): Promise<void> => {
    setBusy(true); setError(''); setMessage('')
    try {
      await saveSettings({ visualStyleOverrides: { ...settings.visualStyleOverrides, [id]: entry } })
      setMessage(notice)
    } catch (e) { setError(errorText(e)) }
    finally { setBusy(false) }
  }
  const switchMode = (next: InstructionMode): void => {
    void persist({ mode: next, prompt: savedPrompt, characterHint: savedHint }, next === 'original' ? 'Gaya asli aktif. Teks kustom tetap tersimpan.' : 'Gaya kustom aktif untuk generasi berikutnya.')
  }
  const textareas = [
    { label: 'Instruksi gambar', description: 'Bentuk karakter, garis, warna, latar, detail, dan hal yang harus dihindari. Ditambahkan ke setiap prompt gambar.', text: prompt, original: original.prompt, set: setPrompt, rows: 9 },
    { label: 'Instruksi karakter reference sheet', description: 'Cara menggambar karakter pada lembar referensi. Samakan dengan instruksi gambar agar karakter konsisten.', text: hint, original: original.characterHint, set: setHint, rows: 4 }
  ]
  return <div className="flex min-w-0 flex-col gap-3">
    <h3 className="font-semibold">{original.name}</h3>
    <div role="group" aria-label={`Mode gaya ${original.name}`}>
      <Segmented<InstructionMode> value={mode} options={[{ id: 'original', label: 'Asli (Original)', disabled: busy }, { id: 'custom', label: 'Kustom (Custom)', disabled: busy }]} onChange={switchMode} />
    </div>
    {textareas.map(field => <label key={field.label} className="flex min-w-0 flex-col gap-1.5">
      <span className="text-sm font-semibold">{field.label}</span>
      <span className="text-xs text-ink-2">{field.description}</span>
      <textarea aria-label={`${field.label}: ${original.name}`} value={mode === 'original' ? field.original : field.text}
        readOnly={mode === 'original'} disabled={busy} maxLength={INSTRUCTION_LIMIT} rows={field.rows} spellCheck={false}
        className={`${inputCls} w-full resize-y py-3 font-mono text-[13px] leading-relaxed`}
        onChange={e => { field.set(e.target.value); setMessage(''); setError('') }} />
    </label>)}
    <div className="flex flex-wrap items-center justify-between gap-3">
      <span className="text-xs text-ink-2">{mode === 'original' ? 'Gaya asli aktif' : dirty ? 'Perubahan kustom belum disimpan' : 'Gaya kustom aktif'} · Maksimal 20.000 karakter per isian</span>
      <div className="flex flex-wrap gap-2">
        <Button disabled={busy || mode === 'original'} onClick={() => { setPrompt(original.prompt); setHint(original.characterHint); void persist({ mode: 'custom', prompt: original.prompt, characterHint: original.characterHint }, 'Teks kustom dikembalikan ke instruksi asli.') }}>Pulihkan teks asli</Button>
        <Button variant="primary" disabled={busy || mode === 'original' || !dirty} onClick={() => void persist({ mode: 'custom', prompt: prompt.trim() || original.prompt, characterHint: hint.trim() || original.characterHint }, 'Gaya kustom tersimpan untuk generasi berikutnya.')}>{busy ? 'Menyimpan…' : 'Simpan gaya'}</Button>
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-bad-ink">{error}</p>}
    {message && <p role="status" className="text-sm text-ok-ink">{message}</p>}
  </div>
}

export function StyleInstructions({ settings, saveSettings, onDirtyChange }: { settings: AppSettings; saveSettings: (patch: Partial<PromptInstructions>) => Promise<void>; onDirtyChange: (key: string, dirty: boolean) => void }) {
  const [selected, setSelected] = useState('stickman-minimalist')
  const [visited, setVisited] = useState(['stickman-minimalist'])
  return <section className="flex min-w-0 flex-col gap-4 rounded-2xl border border-line bg-surface p-5">
    <div>
      <h2 className="text-lg font-bold">3. Gaya visual</h2>
      <p className="mt-1 text-sm text-ink-2">Pilih gaya yang ingin kamu edit. Setiap gaya memiliki pilihan Asli/Kustom sendiri, disimpan di slot prompt ini. Thumbnail tetap contoh bawaan, bukan pratinjau hasil kustom.</p>
    </div>
    <div><StyleMenu value={selected} onChange={id => { setSelected(id); setVisited(ids => ids.includes(id) ? ids : [...ids, id]) }} /></div>
    {visited.map(id => <div key={id} className={selected === id ? '' : 'hidden'}><StyleEditor id={id} settings={settings} saveSettings={saveSettings} onDirtyChange={onDirtyChange} /></div>)}
    <p className="text-xs text-ink-2">Perubahan gaya berlaku saat membuat rencana visual, gambar, dan reference sheet baru. Buat ulang reference sheet lama jika kamu ingin karakter mengikuti gaya baru.</p>
  </section>
}
