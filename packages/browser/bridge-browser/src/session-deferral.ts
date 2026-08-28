/**
 * Defer real session creation until the first prompt.
 *
 * The panel calls `session/create` as soon as it connects, but a session that
 * is opened and never used should leave zero trace in the store/GUI. This
 * interceptor answers `session/create` with a provisional id (minted locally,
 * nothing persisted), serves `session/history` for provisional ids as empty,
 * and materializes the real session — same id, original create payload — on
 * the first `session/prompt` for that id. Abandoned provisional ids are
 * pruned after {@link PROVISIONAL_TTL_MS}.
 *
 * @module @deepseek-ai/dsh-bridge-browser/src/session-deferral
 */

import { randomUUID } from 'node:crypto'
import { RpcId } from '@deepseek-ai/dsh-client-connection'
import type { ImageAttachmentLimits } from '@deepseek-ai/dsh-attachment'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { GatewayEnvelope, InterceptOutcome, RpcInterceptor } from './gateway.ts'

/** Provisional entries older than this are dropped on the next create. */
const PROVISIONAL_TTL_MS = 30 * 60_000

interface ProvisionalEntry {
  /** The original create payload, replayed at materialization (keeps cwd/workspaceId). */
  payload: Record<string, unknown>
  createdAt: number
}

/** The gateway-side create request payload (bare, before the `{args}` wrapper). */
interface CreatePayload {
  workspaceId?: string
  cwd?: string
  sessionId?: string
  agentPreset?: string
}

/** The gateway-side prompt request payload; `requestId` is minted by the bridge. */
interface PromptPayload {
  sessionId: string
  [key: string]: unknown
}

/**
 * Build the session-deferral RPC interceptor.
 *
 * @param forward - function dispatching one RPC to the gateway and returning its envelope.
 * @param enabled - Whether deferral is active; false returns a pass-through interceptor.
 * @param imageLimits - actual host image capability, used for the synthetic
 * empty history before the deferred Session exists.
 * @returns the interceptor answering or rewriting deferred-session frames.
 */
export function sessionDeferralInterceptor(
  forward: (method: string, payload: unknown, signal: AbortSignal) => Promise<GatewayEnvelope>,
  enabled: boolean,
  imageLimits?: ImageAttachmentLimits,
): RpcInterceptor {
  if (!enabled) return () => Promise.resolve(null)

  const provisional = new Map<SessionId, ProvisionalEntry>()
  const materializing = new Map<SessionId, Promise<GatewayEnvelope>>()

  const prune = (): void => {
    const cutoff = Date.now() - PROVISIONAL_TTL_MS
    for (const [id, entry] of provisional) {
      if (entry.createdAt < cutoff) provisional.delete(id)
    }
  }

  const mintedId = (payload: CreatePayload): SessionId =>
    (payload.sessionId ?? `session-${randomUUID()}`) as SessionId

  const envelope = (value: unknown): GatewayEnvelope => ({
    type: 'server-response',
    rpcId: RpcId(randomUUID()),
    result: { ok: true, value },
  })

  return async (method, payload, signal): Promise<InterceptOutcome | null> => {
    if (method === 'session/create') {
      prune()
      const createPayload = (typeof payload === 'object' && payload !== null
        ? payload
        : {}) as CreatePayload
      const sessionId = mintedId(createPayload)
      provisional.set(sessionId, {
        payload: { ...createPayload },
        createdAt: Date.now(),
      })
      return { kind: 'reply', envelope: envelope({ sessionId }) }
    }

    if (method === 'session/history') {
      const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId
      if (typeof sessionId === 'string' && provisional.has(sessionId as SessionId)) {
        const value: Record<string, unknown> = { events: [], hasMore: false }
        if (imageLimits !== undefined) {
          value.projections = { asOfSeq: -1, values: { imageLimits } }
        }
        return { kind: 'reply', envelope: envelope(value) }
      }
      return null
    }

    if (method === 'session/prompt') {
      const promptPayload = (typeof payload === 'object' && payload !== null
        ? payload
        : {}) as PromptPayload
      const sessionId = promptPayload.sessionId as SessionId | undefined
      if (sessionId === undefined || !provisional.has(sessionId)) return null
      const entry = provisional.get(sessionId)
      if (entry === undefined) return null
      // Materialize the real session with the same id; `ensureSession` adopts
      // an existing id idempotently, so concurrent prompts share one create.
      let pending = materializing.get(sessionId)
      if (pending === undefined) {
        pending = forward('session/create', {
          ...entry.payload,
          sessionId,
        }, signal).finally(() => {
          materializing.delete(sessionId)
        })
        materializing.set(sessionId, pending)
      }
      const created = await pending
      if (!created.result.ok) return { kind: 'reply', envelope: created }
      provisional.delete(sessionId)
      // The new protocol requires a caller-minted `requestId` on every prompt.
      const rewritten = {
        ...promptPayload,
        requestId: randomUUID(),
      } as PromptPayload
      return { kind: 'forward', method: 'session/prompt', payload: rewritten }
    }

    return null
  }
}
