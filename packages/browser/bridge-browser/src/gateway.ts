/**
 * Gateway RPC carrier for the bridge plugin.
 *
 * The bridge forwards extension RPC frames to the same shared `/api` channel
 * the GUI uses, so schema validation, error envelopes, and method claims stay
 * identical to the browser path. The carrier is the fetch-shaped handler from
 * `ctx.connection.createSharedFetchHandler('/api')`; this module owns the
 * wire-shape translation (slash method names, `{args}` payload wrapping) and
 * the envelope contract consumed by the bridge server.
 *
 * @module
 */

import { RpcId } from '@deepseek-ai/dsh-client-connection'
import type { RpcId as RpcIdType } from '@deepseek-ai/dsh-client-connection'
import { randomUUID } from 'node:crypto'

/** One gateway success/error result, mirroring the Connection RPC result shape. */
export type GatewayResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string; readonly details: object } }

/** The full wire envelope the /api channel returns for one unary RPC. */
export interface GatewayEnvelope {
  readonly type: 'server-response'
  readonly rpcId: RpcIdType
  readonly result: GatewayResult
}

/** Transport shape the bridge server consumes (same as `ConnectionFetchHandler`). */
export interface GatewayFetchHandler {
  fetch(request: Request, peer?: unknown): Promise<Response>
}

/**
 * Forward one unary RPC through the shared /api channel with the current wire
 * contract: slash endpoint names and an `{args}` payload wrapper.
 * @param apiHandler - fetch-shaped carrier from `createSharedFetchHandler('/api')`.
 * @param method - slash-separated endpoint such as `session/list`.
 * @param payload - business payload, wrapped as `{args}` on the wire.
 * @param signal - optional caller cancellation.
 * @returns the full gateway envelope.
 */
export async function gatewayRequest(
  apiHandler: GatewayFetchHandler,
  method: string,
  payload: unknown,
  signal?: AbortSignal,
): Promise<GatewayEnvelope> {
  const rpcId = RpcId(randomUUID())
  const request = new Request(new URL(`/api/${method}`, 'http://dsh.internal'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      type: 'client-request',
      rpcId,
      method,
      payload: { args: payload },
    }),
    ...(signal === undefined ? {} : { signal }),
  })
  const response = await apiHandler.fetch(request)
  const text = await response.text()
  if (!response.ok) {
    return {
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code: 'http', message: text, details: {} } },
    }
  }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return {
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code: 'internal', message: 'gateway returned non-JSON', details: {} } },
    }
  }
  if (typeof body !== 'object' || body === null
    || (body as { type?: unknown }).type !== 'server-response'
    || (body as { rpcId?: unknown }).rpcId !== rpcId) {
    return {
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code: 'internal', message: 'gateway returned an invalid envelope', details: {} } },
    }
  }
  const result = (body as { result?: unknown }).result
  if (typeof result !== 'object' || result === null
    || typeof (result as { ok?: unknown }).ok !== 'boolean') {
    return {
      type: 'server-response',
      rpcId,
      result: { ok: false, error: { code: 'internal', message: 'gateway returned an invalid result', details: {} } },
    }
  }
  const ok = (result as { ok: boolean }).ok
  if (ok) {
    return {
      type: 'server-response',
      rpcId,
      result: { ok: true, value: (result as { value?: unknown }).value },
    }
  }
  const error = (result as { error?: unknown }).error
  return {
    type: 'server-response',
    rpcId,
    result: {
      ok: false,
      error: typeof error === 'object' && error !== null
        ? (error as { code: string; message: string; details: object })
        : { code: 'internal', message: 'gateway returned an invalid failure', details: {} },
    },
  }
}

/** A forward/reply decision produced by one bridge RPC interception stage. */
export type InterceptOutcome =
  | { readonly kind: 'forward'; readonly method: string; readonly payload: unknown }
  | { readonly kind: 'reply'; readonly envelope: GatewayEnvelope }

/** One stage in the bridge RPC interception chain. */
export type RpcInterceptor = (
  method: string,
  payload: unknown,
  signal: AbortSignal,
) => Promise<InterceptOutcome | null>

/** Compose interceptors in order; the first non-null decision wins. */
export function composeInterceptors(interceptors: readonly RpcInterceptor[]): RpcInterceptor {
  return async (method, payload, signal) => {
    for (const interceptor of interceptors) {
      const outcome = await interceptor(method, payload, signal)
      if (outcome !== null) return outcome
    }
    return null
  }
}

/** Map one legacy dotted method name to the current slash endpoint, when known. */
export function legacyMethodName(method: string): string | undefined {
  return LEGACY_TO_CURRENT[method]
}

/** Legacy dotted names the extension used against the 0.1.1-rc.1 gateway. */
const LEGACY_TO_CURRENT: Readonly<Record<string, string>> = {
  'session.list': 'session/list',
  'session.create': 'session/create',
  'session.history': 'session/history',
  'session.prompt': 'session/prompt',
  'session.cancel': 'session/cancel',
  'session.selectModel': 'session/selectModel',
  'session.attachment': 'session/attachment',
  'session.rename': 'session/rename',
  'session.fork': 'session/fork',
  'session.updateQueue': 'session/updateQueue',
  'workspace.create': 'workspace/create',
}
