import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcId } from '@deepseek-ai/dsh-client-connection'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { GatewayEnvelope, RpcInterceptor } from '../src/gateway.ts'
import { sessionDeferralInterceptor } from '../src/session-deferral.ts'

const signal = (): AbortSignal => new AbortController().signal

function envelope(value: unknown, rpcId = RpcId('rpc')): GatewayEnvelope {
  return { type: 'server-response', rpcId, result: { ok: true, value } }
}

/** Gateway forward mock: session/create answers with the requested id; everything else echoes ok. */
function forwardHarness() {
  const forward = vi.fn(async (method: string, payload: unknown): Promise<GatewayEnvelope> => {
    if (method === 'session/create') {
      const sessionId = (payload as { sessionId?: unknown }).sessionId
      return envelope({ sessionId: sessionId ?? 'session-real' })
    }
    return envelope({ accepted: true })
  })
  return { forward }
}

/** Call the interceptor's `session/create` and return the provisional id from the reply envelope. */
async function provisionalId(interceptor: RpcInterceptor, payload: Record<string, unknown> = {}): Promise<string> {
  const outcome = await interceptor('session/create', payload, signal())
  if (outcome === null || outcome.kind !== 'reply') {
    throw new Error('unreachable: provisional create must reply')
  }
  const result = outcome.envelope.result
  if (!result.ok) throw new Error('unreachable: provisional create must succeed')
  return (result.value as { sessionId: string }).sessionId
}

const PROMPT = (sessionId: string): Record<string, unknown> => ({
  sessionId,
  mode: 'queue',
  content: [],
})

describe('sessionDeferralInterceptor', () => {
  afterEach(() => { vi.useRealTimers() })

  it('answers create with a provisional id without touching the gateway', async () => {
    const { forward } = forwardHarness()
    const interceptor = sessionDeferralInterceptor(forward, true)

    const id = await provisionalId(interceptor)

    expect(id).toMatch(/^session-/)
    expect(forward).not.toHaveBeenCalled()
  })

  it('honors an explicit session id from the caller', async () => {
    const { forward } = forwardHarness()
    const interceptor = sessionDeferralInterceptor(forward, true)

    const id = await provisionalId(interceptor, { sessionId: 'session-fixed' })

    expect(id).toBe('session-fixed')
  })

  it('serves empty history for a provisional id and passes other ids through', async () => {
    const { forward } = forwardHarness()
    const interceptor = sessionDeferralInterceptor(forward, true)
    const id = await provisionalId(interceptor)

    const empty = await interceptor('session/history', { sessionId: id }, signal())
    expect(empty).toEqual({
      kind: 'reply',
      envelope: {
        type: 'server-response',
        rpcId: expect.any(String) as never,
        result: { ok: true, value: { events: [], hasMore: false } },
      },
    })
    expect(forward).not.toHaveBeenCalled()

    const passed = await interceptor('session/history', { sessionId: 'session-real' }, signal())
    expect(passed).toBeNull()
  })

  it('advertises the real host image limits before a deferred session materializes', async () => {
    const { forward } = forwardHarness()
    const imageLimits: ImageAttachmentLimits = {
      maxImageBytes: 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4096,
      maxImagePixels: 1_000_000,
      maxImageDimension: 1200,
      mediaTypes: ['image/png', 'image/jpeg'],
    }
    const interceptor = sessionDeferralInterceptor(forward, true, imageLimits)
    const id = await provisionalId(interceptor)

    const history = await interceptor('session/history', { sessionId: id }, signal())

    expect(history).toEqual({
      kind: 'reply',
      envelope: {
        type: 'server-response',
        rpcId: expect.any(String) as never,
        result: {
          ok: true,
          value: {
            events: [],
            hasMore: false,
            projections: { asOfSeq: -1, values: { imageLimits } },
          },
        },
      },
    })
  })

  it('materializes the session on the first prompt, replaying the create payload', async () => {
    const { forward } = forwardHarness()
    const interceptor = sessionDeferralInterceptor(forward, true)
    const id = await provisionalId(interceptor, { cwd: '/work' })

    const outcome = await interceptor('session/prompt', PROMPT(id), signal())

    expect(forward).toHaveBeenCalledWith('session/create', { cwd: '/work', sessionId: id }, expect.any(AbortSignal))
    expect(outcome).toEqual({
      kind: 'forward',
      method: 'session/prompt',
      payload: {
        sessionId: id,
        mode: 'queue',
        content: [],
        requestId: expect.any(String) as never,
      },
    })

    // Materialized: history now reaches the gateway.
    expect(await interceptor('session/history', { sessionId: id }, signal())).toBeNull()
  })

  it('passes prompts for unknown sessions through untouched', async () => {
    const { forward } = forwardHarness()
    const interceptor = sessionDeferralInterceptor(forward, true)

    const outcome = await interceptor('session/prompt', PROMPT('session-existing'), signal())

    expect(outcome).toBeNull()
    expect(forward).not.toHaveBeenCalled()
  })

  it('deduplicates concurrent prompts into one materialization', async () => {
    const { forward } = forwardHarness()
    let release!: () => void
    forward.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { release = resolve })
      return envelope({ sessionId: 'session-provisional' })
    })
    const interceptor = sessionDeferralInterceptor(forward, true)
    const id = await provisionalId(interceptor)

    const first = interceptor('session/prompt', PROMPT(id), signal())
    const second = interceptor('session/prompt', PROMPT(id), signal())
    release()
    const outcomes = await Promise.all([first, second])

    expect(forward).toHaveBeenCalledTimes(1)
    expect(outcomes[0]).toMatchObject({ kind: 'forward', method: 'session/prompt' })
    expect(outcomes[1]).toMatchObject({ kind: 'forward', method: 'session/prompt' })
  })

  it('propagates a materialization failure without forwarding the prompt, and retries later', async () => {
    const { forward } = forwardHarness()
    forward.mockResolvedValueOnce({
      type: 'server-response',
      rpcId: RpcId('materialize'),
      result: {
        ok: false as const,
        error: { code: 'internal', message: 'boom', details: {} },
      },
    })
    const interceptor = sessionDeferralInterceptor(forward, true)
    const id = await provisionalId(interceptor)

    const failed = await interceptor('session/prompt', PROMPT(id), signal())
    expect(failed).toEqual({
      kind: 'reply',
      envelope: {
        type: 'server-response',
        rpcId: RpcId('materialize'),
        result: {
          ok: false,
          error: { code: 'internal', message: 'boom', details: {} },
        },
      },
    })

    // The entry survives the failure: a later prompt retries materialization.
    const retried = await interceptor('session/prompt', PROMPT(id), signal())
    expect(forward).toHaveBeenCalledTimes(2)
    expect(retried).toMatchObject({ kind: 'forward', method: 'session/prompt' })
  })

  it('propagates a thrown materialization failure and keeps the entry for retry', async () => {
    const { forward } = forwardHarness()
    forward.mockRejectedValueOnce(new Error('create exploded'))
    const interceptor = sessionDeferralInterceptor(forward, true)
    const id = await provisionalId(interceptor)

    await expect(interceptor('session/prompt', PROMPT(id), signal())).rejects.toThrow('create exploded')

    // The cleanup ran: a later prompt retries materialization.
    const retried = await interceptor('session/prompt', PROMPT(id), signal())
    expect(forward).toHaveBeenCalledTimes(2)
    expect(retried).toMatchObject({ kind: 'forward', method: 'session/prompt' })
  })

  it('prunes stale provisional entries on the next create', async () => {
    vi.useFakeTimers()
    const { forward } = forwardHarness()
    const interceptor = sessionDeferralInterceptor(forward, true)
    const first = await provisionalId(interceptor)

    vi.advanceTimersByTime(31 * 60_000)
    const second = await provisionalId(interceptor)

    // The stale id now reaches the gateway; the fresh id stays provisional.
    expect(await interceptor('session/history', { sessionId: first }, signal())).toBeNull()
    expect(await interceptor('session/history', { sessionId: second }, signal())).toMatchObject({ kind: 'reply' })
  })

  it('passes every method through when deferral is disabled', async () => {
    const { forward } = forwardHarness()
    const interceptor = sessionDeferralInterceptor(forward, false)

    await expect(interceptor('session/create', {}, signal())).resolves.toBeNull()
    expect(forward).not.toHaveBeenCalled()
  })
})
