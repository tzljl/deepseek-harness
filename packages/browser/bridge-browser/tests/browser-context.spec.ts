import { describe, expect, it, vi } from 'vitest'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import { type ContentBlock, type TextBlock, type UserMessage } from '@deepseek-ai/dsh-llm'
import {
  BROWSER_CONTEXT_PLUGIN,
  BrowserContextInjector,
  createBrowserSnapshotMessage,
} from '../src/browser-context.ts'

/** Narrow one content block to the text variant (the snapshot message is text-only). */
function requireText(block: ContentBlock | undefined): asserts block is TextBlock {
  if (block?.type !== 'text') throw new Error('expected a text block')
}

/** Read the first content block of the message passed to a mock `agent.inject` call. */
function firstInjectedBlock(agent: Agent & { inject: ReturnType<typeof vi.fn> }): ContentBlock {
  const message = agent.inject.mock.calls[0]![0] as UserMessage
  const block = message.content[0]
  if (block === undefined) throw new Error('expected injected message content')
  return block
}

function fakeAgent(id: string): Agent & { inject: ReturnType<typeof vi.fn> } {
  return { id, inject: vi.fn((_message: UserMessage): void => {}) } as unknown as Agent & {
    inject: ReturnType<typeof vi.fn>
  }
}

describe('browser page context', () => {
  it('builds plugin-owned snapshot context for the model', () => {
    const message = createBrowserSnapshotMessage('Page: Example')

    expect(message.role).toBe('user')
    expect(message.source).toEqual({
      kind: 'plugin',
      plugin: BROWSER_CONTEXT_PLUGIN,
      form: 'snapshot',
      sections: [{
        name: 'browser-page',
        text: expect.stringContaining('Page: Example') as unknown,
      }],
    })
    expect(message.content).toEqual([{
      type: 'text',
      text: expect.stringContaining('browser page context was refreshed') as unknown,
    }])
    const block = message.content[0]
    requireText(block)
    expect(block.text).toContain('already completed browser_snapshot')
    expect(block.text).toContain('do not take an immediate duplicate snapshot')
  })

  it('injects immediately when the Agent is live', () => {
    const agent = fakeAgent('session-live')
    const agents = { get: vi.fn(() => agent) } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(agents)

    expect(injector.inject('session-live', 'Live page')).toBe('injected')
    expect(agent.inject).toHaveBeenCalledOnce()
    const liveBlock = firstInjectedBlock(agent)
    requireText(liveBlock)
    expect(liveBlock.text).toContain('Live page')
  })

  it('retains only the latest snapshot until a deferred Agent starts', () => {
    const agent = fakeAgent('session-later')
    const agents = { get: vi.fn(() => undefined) } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(agents)

    expect(injector.inject('session-later', 'Old page')).toBe('queued')
    expect(injector.inject('session-later', 'New page')).toBe('queued')
    expect(injector.activate(agent)).toBe(true)
    expect(injector.activate(agent)).toBe(false)
    expect(agent.inject).toHaveBeenCalledOnce()
    const queuedBlock = firstInjectedBlock(agent)
    requireText(queuedBlock)
    expect(queuedBlock.text).toContain('New page')
    const olderBlock = firstInjectedBlock(agent)
    requireText(olderBlock)
    expect(olderBlock.text).not.toContain('Old page')
  })

  it('drops provisional context when the Agent becomes live before another injection', () => {
    const agent = fakeAgent('session-race')
    const get = vi.fn()
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce(agent)
    const injector = new BrowserContextInjector({ get })

    injector.inject('session-race', 'Queued page')
    injector.inject('session-race', 'Live page')

    expect(injector.activate(agent)).toBe(false)
    expect(agent.inject).toHaveBeenCalledOnce()
    const raceBlock = firstInjectedBlock(agent)
    requireText(raceBlock)
    expect(raceBlock.text).toContain('Live page')
  })

  it('bounds snapshots for provisional sessions that never materialize', () => {
    const agents = { get: vi.fn(() => undefined) } as unknown as Pick<AgentRegistry, 'get'>
    const injector = new BrowserContextInjector(agents, 2)
    const first = fakeAgent('first')
    const second = fakeAgent('second')
    const third = fakeAgent('third')

    injector.inject('first', 'First page')
    injector.inject('second', 'Second page')
    injector.inject('third', 'Third page')

    expect(injector.activate(first)).toBe(false)
    expect(injector.activate(second)).toBe(true)
    expect(injector.activate(third)).toBe(true)
  })
})
