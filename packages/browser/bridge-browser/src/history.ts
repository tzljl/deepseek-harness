/**
 * Bridge-side `session/history` interceptor.
 *
 * The current dsh architecture replaced the old unary `session/history`
 * endpoint with the `session/page` + `session/follow` pair. The extension
 * still calls `session/history` to seed its conversation view; this
 * interceptor answers it from the host `SessionController.inspect()` so the
 * extension keeps its existing wire contract without adopting page cursors.
 *
 * @module
 */

import type { SessionController } from '@deepseek-ai/dsh-api-session-controller'
import type { RpcId } from '@deepseek-ai/dsh-client-connection'
import type { InterceptOutcome, RpcInterceptor } from './gateway.ts'

/** The history value shape the extension expects (old gateway contract). */
export interface BridgeHistoryValue {
  readonly events: readonly { readonly event: unknown }[]
  readonly hasMore: boolean
  readonly projections?: {
    readonly asOfSeq: number
    readonly values: Record<string, unknown>
  }
}

/**
 * Build the history interceptor backed by host inspection.
 * @param sessionController - host SessionController service.
 * @param rpcId - minted correlation id for the synthetic envelope.
 * @returns an interceptor answering `session/history` for real sessions.
 */
export function sessionHistoryInterceptor(
  sessionController: SessionController,
  rpcId: () => RpcId,
): RpcInterceptor {
  return async (method, payload, signal): Promise<InterceptOutcome | null> => {
    if (method !== 'session/history') return null
    const sessionId = (payload as { sessionId?: unknown } | null)?.sessionId
    if (typeof sessionId !== 'string' || sessionId.length === 0) return null
    const inspected = await sessionController.events({ address: { sessionId } } as never, signal)
    const value: BridgeHistoryValue = {
      events: inspected.records.map((event: unknown) => ({ event })),
      hasMore: inspected.hasMore,
    }
    return {
      kind: 'reply',
      envelope: {
        type: 'server-response',
        rpcId: rpcId(),
        result: { ok: true, value },
      },
    }
  }
}
