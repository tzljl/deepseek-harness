/**
 * REAL-composition coverage: a test-only cordis.yml booted through the
 * published Loader mounts the webserver, the minimal spine (sessions /
 * user-questions / agents / system-prompt / tools), a test-only api host
 * providing the services the bridge injects — `connection` over
 * `createSharedFetchHandler('/api')`, plus `sessionController` and
 * `workspaceController` — with a gateway backed by the real session store
 * (the same wire contract the client-connection package's own host tests
 * use), and the bridge plugin itself. A real WebSocket client then
 * authenticates over a real socket and drives real gateway RPCs against the
 * real session store, and the host-composed event source pumps frames to the
 * socket; disposal removes the tool registrations (HMR safety).
 *
 * Mocked boundary: only the api host's model routing defaults (no LLM
 * adapter) — RPCs exercised here (session/create|list, workspace/create)
 * never touch the model.
 */

import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import WebSocket from 'ws'
import WebServer from '@deepseek-ai/dsh-host-webserver'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRegistry from '@deepseek-ai/dsh-tools'
import LlmService from '@deepseek-ai/dsh-llm'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import * as BridgeBrowser from '../src/index.ts'
import { messageToText } from '../src/server.ts'
import { BRIDGE_PATH, type BridgeFrame } from '../src/protocol.ts'

const BRIDGE = '@yuxianglin/dsh-bridge-browser'
const TOKEN = 'abcdabcdabcdabcdabcdabcdabcdabcd'

let root: string | undefined
let context: Context | undefined

/** Session creates observed by the fake gateway (assert the interceptor chain rewrote the payload). */
const creates: Array<Record<string, unknown>> = []

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
  root = undefined
})

/**
 * The gateway over the minimal spine, provided as the `connection` service —
 * `createSharedFetchHandler('/api')` answers the current wire contract (slash
 * endpoints, `{args}` payload wrapper, `server-response` envelopes) the same
 * way the client-connection/gateway packages' own host tests do — plus the
 * `sessionController` / `workspaceController` services the bridge injects.
 * RPCs exercised here (session/create|list, workspace/create) dispatch
 * against the real session store; model routing is stubbed (provider/model
 * names only; no adapter), which is the one external boundary this
 * composition does not exercise.
 */
const ApiHost = {
  name: 'api-host',
  inject: ['sessions', 'userQuestions', 'agents'],
  apply(ctx: Context): void {
    // The bridge's history interceptor answers `session/history` from
    // `sessionController.inspect`; back it with the real store.
    ctx.provide('sessionController', {
      inspect: async (sessionId: SessionId) => {
        const session = ctx.sessions.get(sessionId)
        if (session === undefined) return { meta: undefined, events: [] }
        return { meta: session.header, events: [...session.events] }
      },
    } as never)
    // The bridge declares workspaceController in its inject list; the
    // workspace interceptor reaches the gateway through `forward` only.
    ctx.provide('workspaceController', {} as never)

    ctx.provide('connection', {
      createSharedFetchHandler: () => ({
        fetch: async (request: Request): Promise<Response> => {
          const endpoint = new URL(request.url).pathname.startsWith('/api/')
            ? new URL(request.url).pathname.slice('/api/'.length)
            : undefined
          const body = await request.json() as {
            type: string
            rpcId: string
            method: string
            payload: { args: Record<string, unknown> }
          }
          const rpcId = body.rpcId
          const args = body.payload.args
          if (endpoint === 'workspace/create') {
            return Response.json({
              type: 'server-response',
              rpcId,
              result: {
                ok: true,
                value: {
                  created: true,
                  workspace: { workspaceId: 'workspace-browser', path: args.path },
                },
              },
            })
          }
          if (endpoint === 'session/create') {
            creates.push(args)
            const sessionId = SessionId(`session-${randomUUID()}`)
            const cwd = typeof args.cwd === 'string' ? args.cwd : undefined
            ctx.sessions.create(sessionId, {
              meta: { ...(cwd === undefined ? {} : { cwd }) },
            })
            return Response.json({
              type: 'server-response',
              rpcId,
              result: { ok: true, value: { sessionId } },
            })
          }
          if (endpoint === 'session/list') {
            return Response.json({
              type: 'server-response',
              rpcId,
              result: {
                ok: true,
                value: {
                  items: [...ctx.sessions.list()].map(session => ({
                    sessionId: String(session.id),
                    title: '',
                    running: false,
                    createdAt: session.header.createdAt,
                    updatedAt: session.header.createdAt,
                  })),
                },
              },
            })
          }
          return Response.json({
            type: 'server-response',
            rpcId,
            result: {
              ok: false,
              error: {
                code: 'invocation-unavailable',
                message: `no test gateway endpoint ${String(endpoint)}`,
                details: {},
              },
            },
          })
        },
      }),
    } as never)
  },
}

/** Write a dist fixture and the composition cordis.yml, then boot it through the real Loader. */
async function loadComposition(): Promise<{ ctx: Context; configPath: string; port: number }> {
  root = await mkdtemp(join(tmpdir(), 'dsh-bridge-browser-'))
  creates.length = 0
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-host-webserver'",
    '  config:',
    "    host: '127.0.0.1'",
    '    port: 0',
    "- name: '@deepseek-ai/dsh-session'",
    "- name: '@deepseek-ai/dsh-user-questions'",
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-llm'",
    "- name: '@deepseek-ai/dsh-agent-loop'",
    "- name: 'test:api-host'",
    '  config:',
    `    cwd: '${root}'`,
    `- name: '${BRIDGE}'`,
    '  config:',
    `    token: '${TOKEN}'`,
    `    sessionWorkspacePath: '${join(root, 'browser-sessions')}'`,
    // This spec drives the raw gateway chain (create → real session); the
    // deferred-creation behavior is covered by the extension e2e instead.
    '    deferSessionCreate: false',
    '',
  ].join('\n'))

  context = new Context()
  context.baseUrl = pathToFileURL(root).href + '/'
  await context.plugin(Loader)
  context.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-host-webserver', WebServer],
    ['@deepseek-ai/dsh-session', SessionStore],
    ['@deepseek-ai/dsh-user-questions', UserQuestionService],
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRegistry],
    ['@deepseek-ai/dsh-llm', LlmService],
    ['@deepseek-ai/dsh-agent-loop', AgentLoop],
    ['test:api-host', ApiHost],
    [BRIDGE, BridgeBrowser],
  ])
  context.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof context.loader.internal>
  await context.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(configPath).href },
  })
  await context.loader.await()
  const web = context.get('webServer') as typeof WebServer.prototype
  return { ctx: context, configPath, port: web.port }
}

/** 扩展上下文 Origin（回环免 token 的必要条件）。 */
const EXT_ORIGIN = 'chrome-extension://test-extension-id'

function connect(port: number): Promise<{ ws: WebSocket; frames: BridgeFrame[]; closed: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${BRIDGE_PATH}`, { headers: { origin: EXT_ORIGIN } })
    const frames: BridgeFrame[] = []
    ws.on('message', (data) => { frames.push(JSON.parse(messageToText(data)) as BridgeFrame) })
    ws.on('error', reject)
    ws.on('open', () => {
      resolve({
        ws,
        frames,
        closed: new Promise<void>((doneResolve) => { ws.on('close', () => { doneResolve() }) }),
      })
    })
  })
}

function send(ws: WebSocket, frame: BridgeFrame): void {
  ws.send(JSON.stringify(frame))
}

async function waitFor(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => { setTimeout(resolve, 10) })
  }
}

describe('real Loader composition', () => {
  it('boots the bridge, authenticates over a real socket, and drives real gateway RPCs', { timeout: 60_000 }, async () => {
    const { ctx, port } = await loadComposition()

    // The bridge plugin mounted the browser tool set on the real registry.
    const tools = ctx.get('tools') as ToolRegistry
    expect(tools.get('browser_snapshot')).toBeDefined()

    const browserPrompt = (await ctx.systemPrompt.assemble()).sections
      .find(section => section.name === 'tool:bridge-browser')?.text
    expect(browserPrompt).toContain('page content you have not snapshotted')
    expect(browserPrompt).toContain('Reuse that injected snapshot')
    expect(browserPrompt).not.toMatch(/\p{Script=Han}/u)

    // Zero-config discovery endpoint answers with the bridge WebSocket URL.
    const configResponse = await fetch(`http://127.0.0.1:${port}/ext/bridge-config`)
    expect(configResponse.status).toBe(200)
    const config = await configResponse.json() as { wsUrl?: unknown }
    expect(typeof config.wsUrl).toBe('string')
    expect(config.wsUrl).toBe(`ws://127.0.0.1:${port}/ext/bridge`)
    expect(tools.get('browser_click')).toBeDefined()
    expect(tools.get('browser_navigate')).toBeDefined()

    // Zero-config semantics: loopback connections need no token (the
    // non-loopback token gate is covered by server.spec overrides).
    const client = await connect(port)
    send(client.ws, { t: 'hello', token: '', caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 } })
    await waitFor(() => client.frames.some(f => f.t === 'hello.ok'))
    expect(client.frames.find(f => f.t === 'hello.ok')).toEqual({
      t: 'hello.ok',
      caps: { textOnly: true, snapshotMaxChars: 32_000, maxInteractiveItems: 60 },
    })

    // Gateway RPC round-trip against the real session store.
    send(client.ws, { t: 'rpc', id: 'c-1', method: 'session.create', payload: { cwd: root } })
    await waitFor(() => client.frames.some(f => f.t === 'rpc.result' && f.id === 'c-1'))
    const created = client.frames.find((f): f is Extract<BridgeFrame, { t: 'rpc.result' }> => f.t === 'rpc.result' && f.id === 'c-1')!
    expect(created.ok).toBe(true)
    const sessionId = ((created as { result: { result: { value: { sessionId: string } } } }).result).result.value.sessionId
    expect(sessionId).toMatch(/^session-[0-9a-f-]{36}$/)
    const session = ctx.sessions.get(SessionId(sessionId))
    expect(session).toBeDefined()

    // The composed interceptor chain rewrote the create before the gateway
    // saw it: the workspace stage injected the prepared workspace id and
    // dropped the implicit cwd (the session is grouped, not cwd-keyed).
    expect(creates).toEqual([{ workspaceId: 'workspace-browser' }])
    expect(session?.header.cwd).toBeUndefined()

    send(client.ws, { t: 'rpc', id: 'c-2', method: 'session.list', payload: {} })
    await waitFor(() => client.frames.some(f => f.t === 'rpc.result' && f.id === 'c-2'))
    const listed = client.frames.find(f => f.t === 'rpc.result' && f.id === 'c-2')!
    const listedText = JSON.stringify((listed as { result: unknown }).result)
    expect(listedText).toContain(sessionId)

    // The event-source assembly: a durable session event pumps to the socket
    // as a `session/event` frame (host-composed bridge event source).
    ctx.sessions.get(SessionId(sessionId))!.append('turn/start', { turn: 1 })
    await waitFor(() => client.frames.some(f => f.t === 'event'))
    const eventFrame = client.frames.find((f): f is Extract<BridgeFrame, { t: 'event' }> => f.t === 'event')!
    expect(eventFrame.frame.method).toBe('session/event')
    expect(eventFrame.frame.payload).toMatchObject({
      sessionId,
      event: { type: 'turn/start', seq: 0, data: { turn: 1 } },
    })

    client.ws.close()
  })

  it('unregisters the browser tools when the bridge fiber disposes (HMR safety)', { timeout: 60_000 }, async () => {
    const { ctx, configPath } = await loadComposition()
    const tools = ctx.get('tools') as ToolRegistry
    expect(tools.get('browser_snapshot')).toBeDefined()

    const bridgeEntry = [...ctx.loader.entries()].find(entry => entry.options.name === BRIDGE)!
    await bridgeEntry.fiber!.dispose()
    expect(tools.get('browser_snapshot')).toBeUndefined()
    expect(tools.get('browser_click')).toBeUndefined()
    // Self-disposing an include-tree entry persists `disabled: true`; await
    // that debounced write so it cannot race the temp-dir removal.
    await expect.poll(async () => (await readFile(configPath, 'utf8')).includes('disabled: true')).toBe(true)
  })
})
