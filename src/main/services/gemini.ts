import { CLEAN_NARRATION_STYLE, cleanNarrationText } from '@shared/speech'
import { GoogleGenAI } from '@google/genai'
import { GEMINI_LIBRARY_VOICES, GEMINI_VOICES, geminiVoiceName, geminiVoiceTone } from '@shared/models'
import type { KeyTestResult, ModelOption, VoiceOption } from '@shared/types'
import { getSecret, requireSecret } from '../secrets'
import { getSettings, readCache, writeCache } from '../settings'
import { isWav, pcmToWav } from './audio'
import { extractJson } from './json'
import { retryAfterDelay } from './visualRetry'

function client(key?: string, provider: 'gemini' | 'gemini-tts' = 'gemini'): GoogleGenAI {
  return new GoogleGenAI({ apiKey: key ?? requireSecret(provider) })
}

function friendly(e: unknown): Error {
  const original = e as { status?: number; code?: number; cause?: unknown }
  const wrap = (message: string): Error => Object.assign(new Error(message, { cause: e }), { status: original?.status ?? original?.code ?? 0 })
  const msg = (e as Error)?.message ?? String(e)
  if (/API key not valid|API_KEY_INVALID|PERMISSION_DENIED|401|403/i.test(msg))
    return wrap('Kunci Gemini ditolak. Periksa kunci di Pengaturan.')
  if (/RESOURCE_EXHAUSTED|429/i.test(msg)) return wrap('Kuota Gemini habis atau terlalu banyak permintaan. Coba lagi sebentar.')
  if (/not found|404/i.test(msg)) return wrap(`Model Gemini tidak tersedia untuk kunci ini: ${msg}`)
  return wrap(`Gemini gagal: ${msg}`)
}

export async function testKey(key?: string, provider: 'gemini' | 'gemini-tts' = 'gemini'): Promise<KeyTestResult> {
  const k = key ?? getSecret(provider)
  if (!k) return { ok: false, message: 'Kunci belum diatur' }
  try {
    const pager = await client(k).models.list({ config: { pageSize: 50 } })
    return { ok: true, message: `Terhubung · ${pager.page.length}+ model tersedia` }
  } catch (e) {
    return { ok: false, message: friendly(e).message }
  }
}

const NOT_TEXT = /tts|embedding|imagen|image|veo|native-audio|live|aqa|transcribe|robotics|computer-use|lyria/i

/** Live model list: 'text' models for writing stories, or 'tts' models for narration. */
export async function listModels(kind: 'text' | 'tts'): Promise<ModelOption[]> {
  const out: ModelOption[] = []
  try {
    const pager = await client(undefined, kind === 'tts' ? 'gemini-tts' : 'gemini').models.list({ config: { pageSize: 200 } })
    for await (const m of pager) {
      const id = (m.name ?? '').replace(/^models\//, '')
      if (!id) continue
      const actions = m.supportedActions ?? []
      if (!actions.includes('generateContent')) continue
      const isTts = /tts/i.test(id)
      if (kind === 'tts' ? !isTts : NOT_TEXT.test(id)) continue
      out.push({
        id,
        name: m.displayName || id,
        description: m.description?.slice(0, 280),
        contextLength: m.inputTokenLimit ?? null,
        priceIn: null,
        priceOut: null,
        tags: kind === 'text' && id.startsWith('gemini') ? ['JSON'] : []
      })
    }
  } catch (e) {
    throw friendly(e)
  }
  // Gemini models first, newest versions first (3.8 before 3.5 before 2.5).
  return out.sort((a, b) => {
    const ga = a.id.startsWith('gemini') ? 0 : 1
    const gb = b.id.startsWith('gemini') ? 0 : 1
    return ga - gb || b.id.localeCompare(a.id, 'en', { numeric: true })
  })
}

/** Structured JSON output; falls back to schema-in-prompt for models without JSON mode (e.g. Gemma). */
export async function generateJson(model: string, system: string, prompt: string, schema: object, signal?: AbortSignal): Promise<unknown> {
  const ai = client()
  let retryAfterMs = 0
  const httpOptions = signal ? {
    retryOptions: { attempts: 1 },
    fetch: async (...args: Parameters<typeof fetch>): Promise<Response> => {
      const response = await fetch(...args)
      retryAfterMs = retryAfterDelay(response.headers.get('retry-after'))
      return response
    }
  } : undefined
  const failure = (error: unknown): Error => Object.assign(friendly(error), { retryAfterMs })
  try {
    const res = await ai.models.generateContent({
      model,
      contents: prompt,
      config: { systemInstruction: system, responseMimeType: 'application/json', responseJsonSchema: schema, abortSignal: signal, httpOptions }
    })
    return JSON.parse(res.text ?? '')
  } catch (e) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    const msg = (e as Error)?.message ?? ''
    const status = Number((e as { status?: number })?.status)
    if ((status && ![400, 422].includes(status)) || /model.*(?:not found|unavailable|not supported)|unsupported model/i.test(msg) ||
        !/json|schema|mime|not supported|Unexpected token|Expected/i.test(msg)) throw failure(e)
  }
  try {
    const res = await ai.models.generateContent({
      model,
      contents: prompt,
      config: {
        abortSignal: signal,
        httpOptions,
        systemInstruction: `${system}\n\nReply with ONE JSON object only (no markdown, no commentary) that matches this JSON Schema:\n${JSON.stringify(schema)}`
      }
    })
    return extractJson(res.text ?? '')
  } catch (e) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    throw failure(e)
  }
}

/** Speaks one narration line. Returns a WAV file (24 kHz mono 16-bit). */
export async function speak(text: string, voice: string, languageCode: string, signal?: AbortSignal): Promise<Buffer> {
  try {
    const res = await client(undefined, 'gemini-tts').models.generateContent({
      model: getSettings().geminiTtsModel,
      contents: [
        {
          role: 'user',
          parts: [{ text: cleanNarrationText(text), speechMetadata: { style: CLEAN_NARRATION_STYLE } }]
        }
      ],
      config: {
        abortSignal: signal,
        responseModalities: ['AUDIO'],
        speechConfig: {
          languageCode,
          voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } }
        }
      }
    })
    const part = res.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)
    if (!part?.inlineData?.data) throw new Error('Gemini tidak mengirim audio')
    const bytes = Buffer.from(part.inlineData.data, 'base64')
    if (isWav(bytes)) return bytes
    const rate = Number(/rate=(\d+)/.exec(part.inlineData.mimeType ?? '')?.[1] ?? 24000)
    return pcmToWav(bytes, rate)
  } catch (e) {
    if (signal?.aborted) throw new Error('Dibatalkan')
    throw friendly(e)
  }
}

interface LibraryVoice {
  id?: string
  name?: string
  display_name?: string
  displayName?: string
  description?: string
  persona?: string | string[]
  language_code?: string
  languageCode?: string
}

/**
 * Prebuilt voices from Gemini's Voice Library (GET /v1beta/voices), kept for a day. Falls back to the
 * voices the app ships samples for, plus the classic 30, when the list cannot be fetched.
 */
export async function listVoices(): Promise<VoiceOption[]> {
  const cached = readCache<VoiceOption[]>('voices:gemini')
  if (cached && Date.now() - cached.updatedAt < 24 * 60 * 60 * 1000 && cached.value.length) return cached.value
  const fallback = (): VoiceOption[] => [
    ...GEMINI_LIBRARY_VOICES.map((v) => ({ id: v.id, name: v.name, description: v.tone })),
    ...GEMINI_VOICES.map((v) => ({ id: v.id, name: v.id, description: v.tone }))
  ]
  try {
    const out: VoiceOption[] = []
    let page = ''
    for (let i = 0; i < 10; i++) {
      const url = `https://generativelanguage.googleapis.com/v1beta/voices?type=prebuilt&page_size=1000${page ? `&page_token=${encodeURIComponent(page)}` : ''}`
      const res = await fetch(url, { headers: { 'x-goog-api-key': requireSecret('gemini-tts') } })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = (await res.json()) as { voices?: LibraryVoice[]; next_page_token?: string; nextPageToken?: string }
      for (const v of body.voices ?? []) {
        const id = (v.id ?? v.name ?? '').replace(/^voices\//, '')
        if (!id) continue
        const persona = Array.isArray(v.persona) ? v.persona.join(', ') : v.persona
        out.push({ id, name: v.display_name ?? v.displayName ?? geminiVoiceName(id), description: geminiVoiceTone(id) ?? persona ?? v.description?.slice(0, 80) ?? '' })
      }
      page = body.next_page_token ?? body.nextPageToken ?? ''
      if (!page) break
    }
    if (!out.length) return fallback()
    // Voices with a bundled sample first, then the classic set, then the rest of the library.
    const rank = (id: string): number => (GEMINI_LIBRARY_VOICES.some((v) => v.id === id) ? 0 : GEMINI_VOICES.some((v) => v.id === id) ? 1 : 2)
    out.sort((a, b) => rank(a.id) - rank(b.id))
    writeCache('voices:gemini', out)
    return out
  } catch (e) {
    console.warn('[gemini] voice list:', (e as Error).message)
    return fallback()
  }
}
