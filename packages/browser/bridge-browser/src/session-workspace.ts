/**
 * Best-effort workspace grouping for sessions created through the browser
 * bridge. The interceptor changes only implicit `session/create` requests;
 * explicit workspace choices and every other gateway method pass through.
 * @module @deepseek-ai/dsh-bridge-browser/src/session-workspace
 */

import { mkdir } from 'node:fs/promises'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { GatewayEnvelope, InterceptOutcome, RpcInterceptor } from './gateway.ts'
type Warn = (message: string) => void

/**
 * Build the workspace-grouping RPC interceptor.
 *
 * @param forward - function dispatching one RPC to the gateway and returning its envelope.
 * @param workspacePath - Dedicated directory, or an empty string to opt out.
 * @param warn - Logger called once when grouping cannot be established.
 * @returns an interceptor that injects the workspace id into implicit session creation.
 */
export function sessionWorkspaceInterceptor(
  forward: (method: string, payload: unknown, signal: AbortSignal) => Promise<GatewayEnvelope>,
  workspacePath: string,
  warn: Warn,
): RpcInterceptor {
  if (workspacePath === '') return () => Promise.resolve(null)

  let workspacePromise: Promise<WorkspaceId | undefined> | undefined
  const ensureWorkspace = (): Promise<WorkspaceId | undefined> => {
    if (workspacePromise !== undefined) return workspacePromise
    workspacePromise = (async () => {
      try {
        await mkdir(workspacePath, { recursive: true })
        const response = await forward('workspace/create', { path: workspacePath }, new AbortController().signal)
        if (!response.result.ok) {
          warn(
            `browser bridge: workspace/create failed for "${workspacePath}" `
            + `(${response.result.error.code}: ${response.result.error.message}); sessions will remain ungrouped`,
          )
          return undefined
        }
        const value = response.result.value as { workspace?: { workspaceId?: WorkspaceId } } | undefined
        return value?.workspace?.workspaceId
      } catch (error: unknown) {
        warn(
          `browser bridge: could not prepare session workspace "${workspacePath}": `
          + `${String(error)}; sessions will remain ungrouped`,
        )
        return undefined
      }
    })()
    return workspacePromise
  }

  return async (method, payload, _signal): Promise<InterceptOutcome | null> => {
    if (method !== 'session/create') return null
    const request = (typeof payload === 'object' && payload !== null ? payload : {}) as {
      workspaceId?: unknown
      cwd?: unknown
    }
    if (request.workspaceId !== undefined) return null
    const workspaceId = await ensureWorkspace()
    if (workspaceId === undefined) return null
    const rewritten: Record<string, unknown> = { ...(payload as object), workspaceId }
    delete rewritten.cwd
    return { kind: 'forward', method: 'session/create', payload: rewritten }
  }
}
