import { DEFAULT_IMAGE_MODEL, DEFAULT_VIDEO_MODEL, getImageModel, getVideoModel } from '@shared/higgsfield'
import { promptFields } from '@shared/promptPresets'
import type { AppSettings, PromptPreset } from '@shared/types'
import { isFlowModel } from '@shared/media'
import { INSTRUCTION_LIMIT } from '@shared/storyInstructions'
import { VISUAL_STYLES, type VisualStyleOverride } from '@shared/styles'
import { getDb } from './db'

export const DEFAULT_SETTINGS: AppSettings = {
  promptPresets: [],
  scriptInstructionsMode: 'original',
  visualInstructionsMode: 'original',
  visualStyleOverrides: {},
  scriptInstructions: '',
  visualInstructions: '',
  defaultTtsProvider: 'gemini',
  defaultLanguage: 'id',
  exportFolder: null,
  llmProvider: 'gemini',
  llmModels: { gemini: 'gemini-3.8-flash', openrouter: '', groq: '', custom: '' },
  customBaseUrl: '',
  flowBaseUrl: 'http://localhost:8000',
  flowLocalEnabled: false,
  flowImageConcurrency: 2,
  geminiTtsModel: 'gemini-3.8-flash-tts',
  elevenModel: 'eleven_multilingual_v2',
  imageModel: DEFAULT_IMAGE_MODEL,
  videoModel: DEFAULT_VIDEO_MODEL,
  whisperAuto: true
}

export function getSettings(): AppSettings {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as { key: string; value: string }[]
  const out: AppSettings = { ...DEFAULT_SETTINGS, llmModels: { ...DEFAULT_SETTINGS.llmModels }, visualStyleOverrides: {} }
  for (const r of rows) {
    if (!(r.key in out)) continue
    const value = JSON.parse(r.value)
    if (r.key === 'llmModels') out.llmModels = { ...out.llmModels, ...value }
    else (out as unknown as Record<string, unknown>)[r.key] = value
  }
  for (const key of ['scriptInstructions', 'visualInstructions'] as const) {
    if (typeof out[key] !== 'string' || out[key].length > INSTRUCTION_LIMIT) out[key] = ''
  }
  for (const [text, mode] of [['scriptInstructions', 'scriptInstructionsMode'], ['visualInstructions', 'visualInstructionsMode']] as const) {
    // Preserve the behavior of instructions saved before explicit mode switches existed.
    if (!rows.some(row => row.key === mode)) out[mode] = out[text].trim() ? 'custom' : 'original'
    else if (out[mode] !== 'original' && out[mode] !== 'custom') out[mode] = 'original'
  }
  const overrides: Record<string, VisualStyleOverride> = {}
  if (out.visualStyleOverrides && typeof out.visualStyleOverrides === 'object') {
    for (const [id, value] of Object.entries(out.visualStyleOverrides)) {
      if (validStyleOverride(id, value)) overrides[id] = value
    }
  }
  out.visualStyleOverrides = overrides
  // Expose the old slot as a preset without rewriting it or changing existing projects.
  if (!rows.some(row => row.key === 'promptPresets'))
    out.promptPresets = [{ id: 'legacy', name: 'Prompt lama', ...promptFields(out) }]
  else out.promptPresets = validatePromptPresets(out.promptPresets)
  // A provider that no longer exists (e.g. from an older build) falls back to Gemini.
  if (!(out.llmProvider in DEFAULT_SETTINGS.llmModels)) out.llmProvider = 'gemini'
  out.flowImageConcurrency = Number.isInteger(out.flowImageConcurrency) ? Math.max(1, Math.min(8, out.flowImageConcurrency)) : 2
  // Models dropped from the Higgsfield catalog fall back to the defaults.
  if (!isFlowModel(out.imageModel)) out.imageModel = getImageModel(out.imageModel).id
  if (!isFlowModel(out.videoModel)) out.videoModel = getVideoModel(out.videoModel).id
  return out
}

function validStyleOverride(id: string, value: unknown): value is VisualStyleOverride {
  if (!VISUAL_STYLES.some(style => style.id === id) || !value || typeof value !== 'object') return false
  const entry = value as VisualStyleOverride
  return ['original', 'custom'].includes(entry.mode) && typeof entry.prompt === 'string' && entry.prompt.length <= INSTRUCTION_LIMIT && typeof entry.characterHint === 'string' && entry.characterHint.length <= INSTRUCTION_LIMIT
}

function validatePromptPresets(value: unknown): PromptPreset[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error('Daftar preset tidak valid. Maksimal 100 slot prompt.')
  const ids = new Set<string>(), names = new Set<string>()
  return value.map((p: PromptPreset) => {
    if (!p || typeof p.id !== 'string' || !p.id.trim() || p.id.length > 80 || p.id === 'original' || ids.has(p.id) ||
        typeof p.name !== 'string' || !p.name.trim() || p.name.trim().length > 80 || names.has(p.name.trim().toLowerCase()) ||
        !['original', 'custom'].includes(p.scriptInstructionsMode) || !['original', 'custom'].includes(p.visualInstructionsMode) ||
        typeof p.scriptInstructions !== 'string' || p.scriptInstructions.length > INSTRUCTION_LIMIT ||
        typeof p.visualInstructions !== 'string' || p.visualInstructions.length > INSTRUCTION_LIMIT ||
        !p.visualStyleOverrides || typeof p.visualStyleOverrides !== 'object' || Array.isArray(p.visualStyleOverrides) ||
        Object.entries(p.visualStyleOverrides).some(([id, entry]) => !validStyleOverride(id, entry)))
      throw new Error('Preset tidak valid. Gunakan nama unik (maksimal 80 karakter), mode Asli/Kustom, dan instruksi yang sesuai batas.')
    ids.add(p.id); names.add(p.name.trim().toLowerCase())
    return { id: p.id, name: p.name.trim(), ...promptFields(p) }
  })
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  if (patch.promptPresets !== undefined) patch = { ...patch, promptPresets: validatePromptPresets(patch.promptPresets) }
  for (const key of ['scriptInstructionsMode', 'visualInstructionsMode'] as const) {
    if (patch[key] !== undefined && !['original', 'custom'].includes(patch[key]!)) throw new Error('Pilih mode Asli atau Kustom.')
  }
  if (patch.visualStyleOverrides !== undefined && (!patch.visualStyleOverrides || typeof patch.visualStyleOverrides !== 'object' || Array.isArray(patch.visualStyleOverrides) || Object.entries(patch.visualStyleOverrides).some(([id, value]) => !validStyleOverride(id, value))))
    throw new Error(`Gaya visual tidak valid. Setiap instruksi maksimal ${INSTRUCTION_LIMIT} karakter.`)
  for (const key of ['scriptInstructions', 'visualInstructions'] as const) {
    if (patch[key] !== undefined && (typeof patch[key] !== 'string' || patch[key]!.length > INSTRUCTION_LIMIT))
      throw new Error(`Instruksi harus berupa teks maksimal ${INSTRUCTION_LIMIT} karakter.`)
  }
  if (patch.flowImageConcurrency !== undefined && (!Number.isInteger(patch.flowImageConcurrency) || patch.flowImageConcurrency < 1 || patch.flowImageConcurrency > 8))
    throw new Error('Jumlah gambar Flow paralel harus berupa angka bulat dari 1 sampai 8.')
  if (patch.flowBaseUrl !== undefined) {
    const url = new URL(patch.flowBaseUrl.trim())
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
      throw new Error('Alamat Flow2API harus berupa URL http:// atau https:// tanpa kredensial.')
    patch = { ...patch, flowBaseUrl: url.toString().replace(/\/+$/, '').replace(/\/v1$/, '') }
    dropCache('models:flow2api-')
    getDb().prepare("UPDATE secrets SET last_ok = NULL, last_message = NULL, checked_at = NULL WHERE provider = 'flow2api'").run()
  }
  if (patch.flowLocalEnabled !== undefined) dropCache('models:flow2api-')
  const current = getSettings()
  const stmt = getDb().prepare(
    'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  )
  getDb().transaction(() => {
    for (const [k, v] of Object.entries(patch)) {
      if (!(k in DEFAULT_SETTINGS)) continue
      const value = k === 'llmModels' ? { ...current.llmModels, ...(v as object) } : k === 'visualStyleOverrides' ? { ...current.visualStyleOverrides, ...(v as object) } : v
      stmt.run(k, JSON.stringify(value))
    }
  })()
  return getSettings()
}

// ---------- small key/value cache (model lists) ----------

export function readCache<T>(key: string): { value: T; updatedAt: number } | null {
  const row = getDb().prepare('SELECT value, updated_at FROM cache WHERE key = ?').get(key) as
    | { value: string; updated_at: number }
    | undefined
  return row ? { value: JSON.parse(row.value) as T, updatedAt: row.updated_at } : null
}

export function writeCache(key: string, value: unknown): number {
  const now = Date.now()
  getDb()
    .prepare('INSERT INTO cache (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, JSON.stringify(value), now)
  return now
}

export function dropCache(prefix: string): void {
  getDb().prepare('DELETE FROM cache WHERE key LIKE ?').run(`${prefix}%`)
}
