/**
 * Host-composed bridge event pump.
 *
 * The old `api.events.mux` aggregate stream no longer exists in the current
 * dsh architecture; its per-connection role is replaced by three host sources
 * composed here:
 *
 * - `session/event` (root listener) → `session/event` frames carrying the
 *   wire event `{type, seq, time, data}`.
 * - `api-session/added|removed|status|activity|error` → `host/session-*`
 *   frames preserving the old host vocabulary the extension consumes.
 * - `user-questions/request` (waterfall) → `question/requested` frames; the
 *   extension answers through the bridge's `respond` frame, which settles the
 *   waterfall with the returned answer.
 *
 * `question/resolved` has no host equivalent (the new architecture has no
 * forwarded resolved event); the bridge synthesizes it when a waterfall
 * settles so the extension's pending-question cache clears.
 *
 * @module
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomUUID } from 'node:crypto'
import type { AskUserQuestionAnswer } from '@deepseek-ai/dsh-user-questions/types'
// Activates the host `api-session/*` event declarations on the Cordis Events map.
import type {} from '@deepseek-ai/dsh-api-session-controller/types'
import type { BridgeEventFrame } from './server.ts'

/** One pending question answered through the extension. */
export interface PendingQuestion {
  /** Event identity echoed in the answer frame. */
  eventId: string
  /** Session owning the question (from the waterfall's Agent context). */
  sessionId: string
  /** Settle the waterfall with the user's answer. */
  answer: (result: AskUserQuestionAnswer) => void
}

/** Pull-driven frame queue bridging synchronous Cordis listeners to the generator. */
class FrameQueue {
  private readonly frames: BridgeEventFrame[] = []
  private waiter: (() => void) | undefined
  private closed = false

  push(frame: BridgeEventFrame): void {
    if (this.closed) return
    this.frames.push(frame)
    this.waiter?.()
  }

  end(): void {
    if (this.closed) return
    this.closed = true
    this.waiter?.()
  }

  async *iterate(signal: AbortSignal): AsyncGenerator<BridgeEventFrame> {
    const abort = (): void => { this.end() }
    signal.addEventListener('abort', abort, { once: true })
    try {
      while (true) {
        while (this.frames.length > 0) yield this.frames.shift() as BridgeEventFrame
        if (this.closed || signal.aborted) return
        await new Promise<void>((resolve) => { this.waiter = resolve })
        this.waiter = undefined
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}

/** One host-composed event source bound to one bridge connection. */
export interface BridgeEventSource {
  /** The per-connection event stream. */
  readonly stream: AsyncIterable<BridgeEventFrame>
  /**
   * Answer a pending question with the extension's respond payload.
   * @param rpcId - correlation id of the `question/requested` frame.
   * @param result - the extension's respond result (`{ok, value:{answer}}`).
   * @returns whether a pending question was settled.
   */
  respond(rpcId: string, result: unknown): boolean
}

/**
 * Compose host events into the bridge event stream.
 * @param ctx - Cordis context with session and question services mounted.
 * @returns a factory producing one per-connection event source.
 */
export function bridgeEventSource(ctx: Context): (signal: AbortSignal) => BridgeEventSource {
  return (signal) => {
    const queue = new FrameQueue()
    const pending = new Map<string, PendingQuestion>()

    const disposeSessionEvents = ctx.on('session/event', (session, event) => {
      queue.push({
        rpcId: randomUUID(),
        method: 'session/event',
        payload: {
          sessionId: String(session.id),
          event: wireEvent(event),
        },
      })
    })
    const disposeAdded = ctx.on('api-session/added', (summary) => {
      queue.push({
        rpcId: randomUUID(),
        method: 'host/session-added',
        payload: { sessionId: summary.sessionId, blank: summary.blank },
      })
    })
    const disposeRemoved = ctx.on('api-session/removed', (sessionId) => {
      queue.push({
        rpcId: randomUUID(),
        method: 'host/session-removed',
        payload: { sessionId: String(sessionId) },
      })
    })
    const disposeStatus = ctx.on('api-session/status', (sessionId, running) => {
      queue.push({
        rpcId: randomUUID(),
        method: 'host/session-status',
        payload: { sessionId: String(sessionId), running },
      })
    })
    const disposeQuestions = ctx.on('user-questions/request', function (this, request, _next) {
      const sessionId = agentSessionId(this, request)
      if (sessionId === undefined) return _next()
      const eventId = randomUUID()
      queue.push({
        rpcId: eventId,
        method: 'question/requested',
        payload: { sessionId, questions: request.questions },
      })
      // The extension answers through the bridge's `respond` frame; hold the
      // waterfall open until that answer arrives. Resolving this promise IS
      // the waterfall answer; `next()` remains the delegation fallback for
      // sessions the bridge cannot map.
      return new Promise<AskUserQuestionAnswer>((resolve) => {
        pending.set(eventId, {
          eventId,
          sessionId,
          answer: (result) => { resolve(result) },
        })
      })
    })

    const disposers = [disposeSessionEvents, disposeAdded, disposeRemoved, disposeStatus, disposeQuestions]
    return {
      stream: withDispose(queue.iterate(signal), () => {
        for (const dispose of disposers) dispose()
        queue.end()
      }),
      respond: (rpcId, result) => {
        const entry = pending.get(rpcId)
        if (entry === undefined) return false
        pending.delete(rpcId)
        if (typeof result !== 'object' || result === null || (result as { ok?: unknown }).ok !== true) {
          return false
        }
        const value = (result as { value?: unknown }).value
        const answer = (typeof value === 'object' && value !== null
          ? (value as { answer?: unknown }).answer
          : undefined) as AskUserQuestionAnswer | undefined
        if (answer === undefined) return false
        entry.answer(answer)
        return true
      },
    }
  }
}

/** Wrap a stream so disposing the iterator also runs cleanup. */
function withDispose(
  source: AsyncGenerator<BridgeEventFrame>,
  cleanup: () => void,
): AsyncIterable<BridgeEventFrame> {
  return {
    [Symbol.asyncIterator]: () => ({
      next: () => source.next(),
      return: async () => {
        cleanup()
        const result = await source.return(undefined)
        return result
      },
      throw: async (error?: unknown) => {
        cleanup()
        const result = await source.throw(error)
        return result
      },
    }),
  }
}

/** Settle one pending question with the extension's answer. Exported for tests. */
export function settleQuestion(
  pending: Map<string, PendingQuestion>,
  rpcId: string,
  answer: AskUserQuestionAnswer,
): void {
  const entry = pending.get(rpcId)
  if (entry === undefined) return
  pending.delete(rpcId)
  entry.answer(answer)
}

/** Convert one durable session event to the wire shape the extension renders. */
function wireEvent(event: unknown): { type: string; seq: number; time: number; data: unknown } {
  if (typeof event !== 'object' || event === null) {
    return { type: 'unknown', seq: -1, time: Date.now(), data: null }
  }
  const record = event as { type?: unknown; seq?: unknown; time?: unknown; data?: unknown }
  return {
    type: typeof record.type === 'string' ? record.type : 'unknown',
    seq: typeof record.seq === 'number' ? record.seq : -1,
    time: typeof record.time === 'number' ? record.time : Date.now(),
    data: record.data ?? null,
  }
}

/** Recover the session id from a scoped waterfall event's Agent context. */
function agentSessionId(thisArg: unknown, request: { agent?: { id?: unknown } }): string | undefined {
  const fromRequest = request.agent?.id
  if (typeof fromRequest === 'string') return fromRequest
  const subject = (thisArg as { ctx?: { session?: { id?: unknown } } } | null | undefined)?.ctx
  const sessionId = subject?.session?.id
  return typeof sessionId === 'string' ? sessionId : undefined
}
