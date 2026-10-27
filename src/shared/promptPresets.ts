import type { AppSettings, Project, PromptInstructions, PromptPreset } from './types'

export const ORIGINAL_PROMPT_PRESET: PromptPreset = {
  id: 'original', name: 'Asli (bawaan aplikasi)', scriptInstructionsMode: 'original', visualInstructionsMode: 'original',
  scriptInstructions: '', visualInstructions: '', visualStyleOverrides: {}
}

export function promptFields(source: PromptInstructions): PromptInstructions {
  return {
    scriptInstructionsMode: source.scriptInstructionsMode, visualInstructionsMode: source.visualInstructionsMode,
    scriptInstructions: source.scriptInstructions, visualInstructions: source.visualInstructions,
    visualStyleOverrides: structuredClone(source.visualStyleOverrides)
  }
}

export function snapshotPromptPreset(settings: AppSettings, id?: string): PromptPreset | null {
  // Older API callers retain their existing global behavior; the new-project UI always makes an explicit choice.
  if (id === undefined) return null
  const preset = id === 'original' ? ORIGINAL_PROMPT_PRESET : settings.promptPresets.find(p => p.id === id)
  if (!preset) throw new Error('Preset prompt tidak ditemukan. Pilih ulang sebelum membuat proyek.')
  return { id: preset.id, name: preset.name, ...promptFields(preset) }
}

export function projectPromptSettings(settings: AppSettings, project: Pick<Project, 'promptProfile'>): AppSettings {
  return project.promptProfile ? { ...settings, ...promptFields(project.promptProfile) } : settings
}
