import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RpcId } from '@deepseek-ai/dsh-client-connection'
import type { WorkspaceId } from '@deepseek-ai/dsh-workspace/types'
import type { GatewayEnvelope } from '../src/gateway.ts'
import { sessionWorkspaceInterceptor } from '../src/session-workspace.ts'

const WORKSPACE_ID = 'workspace-browser' as WorkspaceId
const dirs: string[] = []

const signal = (): AbortSignal => new AbortController().signal

function envelope(value: unknown): GatewayEnvelope {
  return { type: 'server-response', rpcId: RpcId('rpc'), result: { ok: true, value } }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function tempWorkspacePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-browser-workspace-'))
  dirs.push(root)
  return join(root, 'browser-sessions')
}

describe('sessionWorkspaceInterceptor', () => {
  it('creates the directory before one cached workspace registration and injects its id', async () => {
    const workspacePath = await tempWorkspacePath()
    const forward = vi.fn(async (method: string, payload: unknown): Promise<GatewayEnvelope> => {
      if (method === 'workspace/create') {
        const path = (payload as { path: string }).path
        expect((await stat(path)).isDirectory()).toBe(true)
        return envelope({ created: true, workspace: { workspaceId: WORKSPACE_ID, path } })
      }
      return envelope({})
    })
    const warn = vi.fn()
    const interceptor = sessionWorkspaceInterceptor(forward, workspacePath, warn)
    const chosenId = 'session-chosen'

    const [first, second] = await Promise.all([
      interceptor('session/create', { cwd: '/ignored', sessionId: chosenId }, signal()),
      interceptor('session/create', {}, signal()),
    ])

    expect(forward).toHaveBeenCalledTimes(1)
    expect(forward).toHaveBeenNthCalledWith(1, 'workspace/create', { path: workspacePath }, expect.any(AbortSignal))
    expect(first).toEqual({
      kind: 'forward',
      method: 'session/create',
      payload: { sessionId: chosenId, workspaceId: WORKSPACE_ID },
    })
    expect(second).toEqual({
      kind: 'forward',
      method: 'session/create',
      payload: { workspaceId: WORKSPACE_ID },
    })
    expect(warn).not.toHaveBeenCalled()
  })

  it('passes an explicit workspace id through without preparing the configured workspace', async () => {
    const workspacePath = await tempWorkspacePath()
    const forward = vi.fn(async (): Promise<GatewayEnvelope> => envelope({}))
    const interceptor = sessionWorkspaceInterceptor(forward, workspacePath, vi.fn())
    const request = { workspaceId: 'workspace-explicit' as WorkspaceId }

    const outcome = await interceptor('session/create', request, signal())

    expect(outcome).toBeNull()
    expect(forward).not.toHaveBeenCalled()
    await expect(stat(workspacePath)).rejects.toThrow()
  })

  it('passes every method through when grouping is opted out', async () => {
    const forward = vi.fn(async (): Promise<GatewayEnvelope> => envelope({}))

    const interceptor = sessionWorkspaceInterceptor(forward, '', vi.fn())

    await expect(interceptor('session/create', {}, signal())).resolves.toBeNull()
    expect(forward).not.toHaveBeenCalled()
  })

  it('caches a missing workspace domain and falls through to plain session creation', async () => {
    const workspacePath = await tempWorkspacePath()
    const forward = vi.fn(async (method: string): Promise<GatewayEnvelope> => {
      if (method === 'workspace/create') throw new Error('workspace API is unavailable')
      return envelope({})
    })
    const warn = vi.fn()
    const interceptor = sessionWorkspaceInterceptor(forward, workspacePath, warn)
    const request = { cwd: '/original' }

    const first = await interceptor('session/create', request, signal())
    const second = await interceptor('session/create', request, signal())

    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(forward).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledOnce()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workspace API is unavailable'))
  })

  it('caches a workspace.create business failure and preserves session creation', async () => {
    const workspacePath = await tempWorkspacePath()
    const forward = vi.fn(async (method: string): Promise<GatewayEnvelope> => {
      if (method === 'workspace/create') {
        return {
          type: 'server-response',
          rpcId: RpcId('r'),
          result: {
            ok: false,
            error: { code: 'internal', message: 'workspace service missing', details: {} },
          },
        }
      }
      return envelope({})
    })
    const warn = vi.fn()
    const interceptor = sessionWorkspaceInterceptor(forward, workspacePath, warn)

    const first = await interceptor('session/create', {}, signal())
    const second = await interceptor('session/create', {}, signal())

    expect(first).toBeNull()
    expect(second).toBeNull()
    expect(forward).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('workspace/create failed'))
  })

  it('catches a thrown workspace failure and preserves session creation', async () => {
    const workspacePath = await tempWorkspacePath()
    const forward = vi.fn(async (): Promise<GatewayEnvelope> => { throw new Error('domain unavailable') })
    const warn = vi.fn()
    const interceptor = sessionWorkspaceInterceptor(forward, workspacePath, warn)

    const outcome = await interceptor('session/create', { cwd: '/original' }, signal())

    expect(outcome).toBeNull()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('domain unavailable'))
  })
})
