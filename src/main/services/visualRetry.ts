import { setTimeout as delay } from 'node:timers/promises'

export const VISUAL_ATTEMPTS = 3
export const VISUAL_TIMEOUT_MS = 240_000
export class VisualValidationError extends Error {
  constructor(public readonly code: string, message: string, public readonly issues?: string[]) {
    super(message)
    this.name = 'VisualValidationError'
  }
}

const MAX_DELAY_MS = 60_000
const TRANSPORT = /^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EPIPE|UND_ERR_CONNECT_TIMEOUT|UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|UND_ERR_SOCKET)$/

type Failure = { status: number; code: string; retryAfterMs: number; temporary: boolean }

/** Persist only diagnostic identifiers, never provider response bodies or request content. */
export function visualFailure(error: unknown): Failure {
  type ErrorInfo = { status?: number; code?: string | number; name?: string; message?: string; retryAfterMs?: number; cause?: unknown; errors?: unknown[] }
  const chain: ErrorInfo[] = []
  const waiting: unknown[] = [error]
  while (waiting.length && chain.length < 12) {
    const current = waiting.shift() as ErrorInfo | undefined
    if (!current || chain.includes(current)) continue
    chain.push(current)
    if (current.cause) waiting.push(current.cause)
    if (Array.isArray(current.errors)) waiting.push(...current.errors.slice(0, 8))
  }
  const httpCode = (value: unknown): number => Number.isInteger(Number(value)) && Number(value) >= 100 && Number(value) <= 599 ? Number(value) : 0
  const timeout = chain.some((e) => e.name === 'TimeoutError')
  const status = chain.map((e) => httpCode(e.status) || httpCode(e.code)).find(Boolean) || (timeout ? 408 : 0)
  const transport = chain.map((e) => String(e.code ?? '')).find((code) => TRANSPORT.test(code))
  const badPort = chain.some((e) => e.message === 'bad port')
  const rawCode = badPort ? 'BAD_PORT' : transport ?? (timeout ? 'TimeoutError' : chain.find((e) => typeof e.code === 'string')?.code ?? chain[0]?.name ?? 'Error')
  const code = /^[A-Za-z0-9_]{1,64}$/.test(String(rawCode)) ? String(rawCode) : 'Error'
  const temporary = status ? [408, 429, 500, 502, 503, 504, 520, 522, 524].includes(status) :
    !badPort && (!!transport || timeout || chain.some((e) => /^(fetch failed|network error|network request failed)$/i.test(e.message ?? '')))
  return { status, code, retryAfterMs: Math.max(0, ...chain.map((e) => Number(e.retryAfterMs) || 0)), temporary }

}

export function retryAfterDelay(value: string | null): number {
  if (!value) return 0
  const ms = /^\d+(\.\d+)?$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()
  return Number.isFinite(ms) ? Math.max(0, ms) : 0
}

export async function visualRequest<T>(
  run: (signal: AbortSignal) => Promise<T>,
  options: { signal: AbortSignal; provider: string; model: string; stage: string; range: string;
    progress(attempt: number, retrying: boolean): void; diagnostic(value: string): void },
  timing = { timeoutMs: VISUAL_TIMEOUT_MS, random: Math.random, wait: (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }) }
): Promise<T> {
  for (let attempt = 1; attempt <= VISUAL_ATTEMPTS; attempt++) {
    options.signal.throwIfAborted()
    options.progress(attempt, attempt > 1)
    const started = Date.now()
    const timeout = AbortSignal.timeout(timing.timeoutMs)
    const signal = AbortSignal.any([options.signal, timeout])
    try {
      // Race as well as abort: an SDK must not strand a canceled job if it ignores abortSignal.
      return await new Promise<T>((resolve, reject) => {
        const abort = (): void => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
        Promise.resolve().then(() => run(signal)).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
      })
    } catch (error) {
      if (options.signal.aborted) throw options.signal.reason
      const facts = visualFailure(timeout.aborted ? timeout.reason : error)
      const context = `${options.provider}/${options.model} · ${options.stage} ${options.range} · attempt ${attempt}/${VISUAL_ATTEMPTS} · ${Date.now() - started}ms · HTTP ${facts.status || '-'} · ${facts.code}`
      options.diagnostic(context)
      if (!facts.temporary || attempt === VISUAL_ATTEMPTS || facts.retryAfterMs > MAX_DELAY_MS) {
        const reason = error instanceof VisualValidationError ? error.message : facts.code === 'BAD_PORT' ? 'Port endpoint diblokir oleh runtime. Periksa alamat endpoint di Pengaturan.' : facts.status === 413 ? 'Konteks lengkap terlalu besar. Pilih model dengan konteks lebih besar; naskah tidak dipotong.' :
          facts.retryAfterMs > MAX_DELAY_MS ? 'Provider meminta jeda lebih dari 60 detik. Tunggu lalu lanjutkan.' :
          facts.temporary ? 'Gangguan sementara belum pulih. Lanjutkan untuk mencoba bagian yang belum tersimpan.' :
          facts.status === 401 || facts.status === 403 ? 'Periksa kunci dan izin provider.' :
          facts.status === 404 ? 'Model tidak tersedia. Pilih model lain.' :
          facts.status === 400 || facts.status === 422 ? 'Permintaan ditolak. Periksa model dan batas konteks provider.' :
          'Respons tidak valid atau continuity bertentangan. Periksa naskah/referensi dan coba lagi.'
        if (error instanceof VisualValidationError)
          throw new VisualValidationError(error.code, `${reason}\n${context}`, error.issues)
        throw new Error(`${reason}\n${context}`)
      }
      const backoff = Math.min(MAX_DELAY_MS, 1500 * 2 ** (attempt - 1) + timing.random() * 750)
      await timing.wait(Math.max(backoff, facts.retryAfterMs), options.signal)
    }
  }
  throw new Error('Percobaan visual habis.')
}
