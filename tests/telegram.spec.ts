import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Trigger } from '../src/core/index.ts'
import { KV } from '../src/kv.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { Store } from '../src/app/store.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { testDeployment } from './fixtures/deployment.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { apply as applyTelegram, telegramKind, telegramTrigger, telegramScope, normalizeText, mentionsBot } from '../src/sources/telegram.ts'
import { pollTelegram, resolveBot, runTelegram, topicName } from '../src/sources/telegram-loops.ts'
import { sendTelegram, chunkText, setTelegramToken } from '../src/sources/telegram-channel.ts'
import { telegramWindow, threadCacheKey, remember, WINDOW_MESSAGES, WINDOW_THREADS } from '../src/sources/telegram-read.ts'
import { TelegramConfigSchema, telegramToken, type TelegramUpdate } from '../src/sources/telegram-trigger.ts'

const joinTmp = (name: string) => join(mkdtempSync(join(tmpdir(), name)), 'db.sqlite')

const BOT = { id: 123456, username: 'agent_bot' }
const MEMBER = '552211'

function update(id: number, fields: Record<string, unknown>): TelegramUpdate {
  return { update_id: id, message: { message_id: id, date: 1757376000, chat: { id: -100123, type: 'group' },
    from: { id: Number(MEMBER), is_bot: false, username: 'alice' }, text: '@agent_bot fix it', ...fields } }
}

function host(overrides: Partial<SourceContextDeps> = {}) {
  const store = new Store(joinTmp('telegram'))
  store.saveSettings(SettingsSchema.parse({
    sources: { telegram: { enabled: true, config: { token: 'tok', chats: [{ chatId: '-100123', listen: 'mentions' }], directMessages: true } } },
    policy: { sources: { telegram: { allowed: [{ id: MEMBER, name: 'Alice' }] } } },
    eval: { mode: 'auto' },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(telegramKind)
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources),
    assessor: { request: vi.fn(async () => {}) }, executor: { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) },
    outbox: { send: vi.fn(), status: () => undefined, withdraw: vi.fn() } })
  const commands = new Commands(() => testDeployment(), {}, new AbortController().signal)
  const receive = vi.fn(async (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const parts: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources,
    deployment: testDeployment(), ready: Promise.resolve(), configured: () => true, receive, ...overrides }
  const ctx = sourceContextOf(parts, telegramKind)
  const value = { ...parts, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf(parts, kind) }
  return { ...value, ctx, store, commands, receive, health: board.all }
}
/** An empty registry for the plugin test: the plugin's own registration then shows. */
function emptyRegistry(): SourceRegistry {
  return new SourceRegistry(() => SettingsSchema.parse({}), new HealthBoard())
}

/** Stubs global `fetch` with the given JSON body for the next call. */
function fetchBody(body: unknown): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => body }) as Response)
}

afterEach(() => { vi.restoreAllMocks(); setTelegramToken(undefined); telegramWindow.clear() })

describe('telegram source', () => {
  it('translates an update into a stable trigger, marks mentions and drops the bot\'s own message', () => {
    const trigger = telegramTrigger(update(1, {}), BOT)!
    expect(trigger).toMatchObject({
      id: key('telegram', '1', '1'), source: 'telegram',
      threads: [{ source: 'telegram', id: '-100123:1' }],
      actor: { source: 'telegram', id: MEMBER }, human: true, addressed: 'mention',
      channel: { source: 'telegram', address: { chatId: '-100123', messageId: '1', direct: 'false' } },
      meta: { chatId: '-100123', messageId: 1, root: '1', updateId: 1, direct: false },
    })
    expect(trigger.text).toBe('fix it')
    // A direct message addresses the bot without a mention.
    expect(telegramTrigger(update(2, { chat: { id: 99, type: 'private' }, text: 'hi' }), BOT)!.addressed).toBe('direct')
    // The bot's own message produces no Trigger.
    expect(telegramTrigger(update(3, { from: { id: BOT.id, is_bot: true } }), BOT)).toBeUndefined()
    // A group message without a mention is not addressed.
    expect(telegramTrigger(update(4, { text: 'plain' }), BOT)).not.toHaveProperty('addressed')
  })
  it('drops a message that carries no text after the mention, such as a photo', () => {
    // The Bot API puts a photo's caption in `caption`, where translation does not read it, so the Trigger would be empty.
    expect(telegramTrigger(update(5, { text: '@agent_bot' }), BOT)).toBeUndefined()
    expect(telegramTrigger(update(6, { text: undefined }), BOT)).toBeUndefined()
  })
  it('normalizes the mention and detects it case-insensitively', () => {
    expect(normalizeText('@agent_bot fix it', 'agent_bot')).toBe('fix it')
    expect(mentionsBot('@AGENT_BOT go', 'agent_bot')).toBe(true)
    expect(mentionsBot('no mention', 'agent_bot')).toBe(false)
  })
  it('scopes listed chats, direct messages and other chats', () => {
    const config = TelegramConfigSchema.parse({ token: 't', chats: [{ chatId: '-100123', listen: 'mentions' }] })
    expect(telegramScope({ meta: { chatId: '-100123' } }, config)).toEqual({ listened: true, observed: false, row: '-100123' })
    expect(telegramScope({ meta: { chatId: '-100999' } }, config).listened).toBe(false)
    expect(telegramScope({ meta: { direct: true } }, config).listened).toBe(true)
  })
  it('validates an unconfigured instance and resolves the token from the environment first', () => {
    // An unconfigured instance must validate, so listing Sources never throws before an operator saves one.
    expect(TelegramConfigSchema.parse({})).toMatchObject({ token: '', chats: [], directMessages: true, otherChats: 'none' })
    expect(telegramToken({ ...TelegramConfigSchema.parse({ token: 'saved' }) }, {})).toBe('saved')
    expect(telegramToken({ ...TelegramConfigSchema.parse({ token: 'saved' }) }, { TG_BOT_TOKEN: 'from-env' })).toBe('from-env')
  })
  it('lists the source from an empty registry without throwing while no config is stored', () => {
    const sources = new SourceRegistry(() => SettingsSchema.parse({}))
    sources.register(telegramKind)
    const instances = sources.instances()
    expect(instances).toEqual([expect.objectContaining({ id: 'telegram', kind: 'telegram', installed: true })])
  })
  it('waits for a Bot Token instead of polling or counting a failure when none is configured', async () => {
    const reports: { state: string; detail: string }[] = []
    const fake = {
      ready: Promise.resolve(), configured: () => true,
      config: () => ({ token: '', chats: [], directMessages: true, otherChats: 'none', pollTimeoutSeconds: 25, pollIntervalSeconds: 1 }),
      report: (_entry: string, value: { state: string; detail: string }) => { reports.push(value) },
      state: { get: () => undefined, set: () => {} }, receive: async () => {}, threads: { describe: () => {} },
    }
    const fetchImpl = vi.fn()
    const controller = new AbortController()
    const running = runTelegram(fake as never, controller.signal, {}, fetchImpl as never)
    await vi.waitFor(() => expect(reports.length).toBeGreaterThan(0))
    controller.abort(); await running
    expect(reports[0]).toEqual({ state: 'paused', detail: 'Waiting for the Telegram Bot Token' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
  it('takes a getUpdates round once, moves the cursor after it, and keeps the thread window', async () => {
    const h = host()
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/getMe')) return { ok: true, status: 200, json: async () => ({ ok: true, result: BOT }) } as Response
      return { ok: true, status: 200, json: async () => ({ ok: true, result: [update(7, {}), update(8, { message_id: 7 })] }) } as Response
    })
    const bot = await resolveBot('tok', fetchImpl)
    const result = await pollTelegram(h.ctx, TelegramConfigSchema.parse({ token: 'tok', chats: [{ chatId: '-100123', listen: 'all' }] }), 'tok', bot, fetchImpl)
    expect(result).toEqual({ read: 2, unreadable: 0 })
    expect(h.receive).toHaveBeenCalledTimes(2)
    expect(h.store.get(KV.telegram.cursor)).toBe(9)
    expect(telegramWindow.get('-100123:7')?.has('7')).toBe(true)
    h.store.close()
  })
  it('sends a reply in chunks, answers gone for a blocked bot and throws otherwise', async () => {
    setTelegramToken('tok')
    const message = { id: 'm1', channel: { source: 'telegram', thread: 'telegram:-100123:1', address: { chatId: '-100123', messageId: '1' } },
      text: 'x'.repeat(5000), kind: 'reply' as const }
    const sent = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response)
    expect(await sendTelegram(message, sent)).toBe('sent')
    expect(sent).toHaveBeenCalledTimes(2)
    const gone = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error_code: 403, description: 'bot was blocked by the user' }) }) as Response)
    expect(await sendTelegram(message, gone)).toBe('gone')
    const thrown = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: false, error_code: 429, description: 'rate limited' }) }) as Response)
    await expect(sendTelegram(message, thrown)).rejects.toThrow('rate limited')
  })
  it('chunks long text at the limit', () => {
    expect(chunkText('abc', 4096)).toEqual(['abc'])
    const long = 'a'.repeat(8192)
    expect(chunkText(long)).toHaveLength(2)
  })
  it('reads the thread window for a trigger\'s thread, root and parent', async () => {
    const h = host()
    const msg = update(1, { reply_to_message: { message_id: 5 } })
    const trigger = telegramTrigger(msg, BOT)!
    const window = telegramWindow.get(threadCacheKey(trigger)) ?? new Map()
    window.set('1', msg.message!)
    window.set('5', { ...msg.message!, message_id: 5, from: { id: 99, is_bot: false } })
    telegramWindow.set(threadCacheKey(trigger), window)
    const context = h.sources.threadContext(trigger)!
    const thread = await context.read(h.commands, 'thread')
    expect(thread.messages.length).toBe(2)
    expect((await context.read(h.commands, 'parent')).messages.map(m => m.id)).toEqual(['5'])
    h.store.close()
  })
  it('keeps the read window bounded as messages and threads accumulate', () => {
    const base = update(1, {}).message!
    for (let id = 1; id <= WINDOW_MESSAGES + 5; id++) remember('-100123:1', { ...base, message_id: id })
    expect(telegramWindow.get('-100123:1')!.size).toBe(WINDOW_MESSAGES)
    // The newest messages survive; the oldest are evicted.
    expect(telegramWindow.get('-100123:1')!.has(String(WINDOW_MESSAGES + 5))).toBe(true)
    expect(telegramWindow.get('-100123:1')!.has('1')).toBe(false)
    for (let thread = 0; thread < WINDOW_THREADS + 3; thread++) remember(`-100999:${thread}`, { ...base, message_id: thread })
    expect(telegramWindow.size).toBe(WINDOW_THREADS)
  })
  it('resolves a thread into a topic reply target while keeping the conversation root', () => {
    const trigger = telegramTrigger(update(9, {}), BOT, undefined, { root: '4', topic: 42 })!
    expect(trigger.meta.root).toBe('4')
    expect(trigger.meta.topic).toBe(42)
    expect(trigger.channel!.address).toMatchObject({ chatId: '-100123', messageId: '9', topic: '42' })
    expect(trigger.threads).toEqual([{ source: 'telegram', id: '-100123:4' }])
  })
  it('opens a forum topic for a mentioned message and continues it from messages inside the topic', async () => {
    const h = host()
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response
    const round = (updates: unknown[]) => vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/getChat')) return json({ ok: true, result: { is_forum: true } })
      if (url.includes('/createForumTopic')) {
        expect(JSON.parse(String(init?.body))).toMatchObject({ chat_id: -100123, name: 'read the README' })
        return json({ ok: true, result: { message_thread_id: 77 } })
      }
      return json({ ok: true, result: updates })
    })
    const config = TelegramConfigSchema.parse({ token: 'tok', chats: [{ chatId: '-100123', listen: 'mentions' }] })
    await pollTelegram(h.ctx, config, 'tok', BOT, round([update(10, { text: '@agent_bot read the README' })]))
    const opened = h.receive.mock.calls[0]![0] as Trigger
    expect(opened.channel!.address).toMatchObject({ chatId: '-100123', topic: '77' })
    expect(opened.threads).toEqual([{ source: 'telegram', id: '-100123:10' }])
    expect(h.store.get(KV.telegram.topics('-100123', '10'))).toBe(77)
    expect(h.store.get(KV.telegram.origins('-100123', 77))).toBe('10')
    // A message inside the opened topic continues the same conversation instead of starting another one.
    await pollTelegram(h.ctx, config, 'tok', BOT, round([update(20, { message_thread_id: 77, text: 'and the docs' })]))
    const continued = h.receive.mock.calls[1]![0] as Trigger
    expect(continued.threads).toEqual([{ source: 'telegram', id: '-100123:10' }])
    expect(continued.channel!.address).toMatchObject({ topic: '77', messageId: '20' })
    h.store.close()
  })
  it('answers in place when a topic cannot be opened', async () => {
    const h = host()
    const json = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as Response
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('/getChat')) return json({ ok: true, result: { is_forum: true } })
      if (url.includes('/createForumTopic')) return json({ ok: false, error_code: 400, description: 'not enough rights' })
      return json({ ok: true, result: [update(11, { text: '@agent_bot fix it' })] })
    })
    const config = TelegramConfigSchema.parse({ token: 'tok', chats: [{ chatId: '-100123', listen: 'mentions' }] })
    await pollTelegram(h.ctx, config, 'tok', BOT, fetchImpl)
    expect(h.receive).toHaveBeenCalledTimes(1)
    const trigger = h.receive.mock.calls[0]![0] as Trigger
    expect(trigger.channel!.address.topic).toBeUndefined()
    expect(trigger.threads).toEqual([{ source: 'telegram', id: '-100123:11' }])
    h.store.close()
  })
  it('posts into a forum topic when the address carries one', async () => {
    setTelegramToken('tok')
    const sent = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, status: 200, json: async () => ({ ok: true }) }) as Response)
    await sendTelegram({ id: 'm2', channel: { source: 'telegram', thread: 'telegram:-100123:1',
      address: { chatId: '-100123', messageId: '1', topic: '77' } }, text: 'hi', kind: 'reply' }, sent)
    expect(JSON.parse(String(sent.mock.calls[0]![1]!.body))).toMatchObject({ chat_id: '-100123', message_thread_id: 77, reply_to_message_id: 1 })
  })
  it('names a topic after the message and falls back when it is empty', () => {
    expect(topicName('@agent_bot   read the README ')).toBe('read the README')
    expect(topicName('   ')).toBe('dsh-superagent')
    expect(topicName('x'.repeat(200)).length).toBe(60)
  })
  it('registers its kind and unregisters on disposal', async () => {
    // A fresh registry so the plugin's own registration is visible.
    const h = host({ sources: emptyRegistry() })
    const disposers: (() => unknown)[] = []
    applyTelegram({ orchestrator: h, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    expect(h.sources.kind('telegram')).toBe(telegramKind)
    for (const dispose of disposers) await dispose()
    expect(h.sources.kind('telegram')).toBeUndefined()
    h.store.close()
  })
})
