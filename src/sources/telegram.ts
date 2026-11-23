/** Telegram source kind definition and Cordis plugin entry, exported as `./telegram-watch`. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { sourceContext } from './host.ts'
import type { Localized, SourceKind } from './kind.ts'
import type { SourceRegistry } from './registry.ts'
import { runTelegram } from './telegram-loops.ts'
import { sendTelegram, setTelegramToken, telegramAllowed, telegramChannelLink } from './telegram-channel.ts'
import { telegramThreadContext } from './telegram-read.ts'
import { SOURCE, TelegramConfigSchema, telegramRepliesTo, telegramScope, type TelegramConfig } from './telegram-trigger.ts'

export { SOURCE, TelegramConfigSchema, telegramTrigger, normalizeText, mentionsBot, telegramLink, telegramScope, telegramRepliesTo }
  from './telegram-trigger.ts'
export { sendTelegram, chunkText, MAX_MESSAGE_CHARS, setTelegramToken } from './telegram-channel.ts'
export { pollTelegram, runTelegram, resolveBot } from './telegram-loops.ts'

/** The Sender Policy shape: the `.allowed` senders who may originate work, and optional bots eligible for inferred candidacy. */
const TelegramPolicySchema = z.object({
  allowed: z.array(z.object({ id: z.string().regex(/^-?[0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
    .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate sender ids').default([]),
  bots: z.array(z.object({ id: z.string().regex(/^-?[0-9]+$/), name: z.string().trim().max(100).optional() }).strict())
    .refine(entries => new Set(entries.map(entry => entry.id)).size === entries.length, 'Duplicate bot ids').optional(),
}).strict()

export const telegramKind: SourceKind<TelegramConfig> = {
  kind: SOURCE,
  title: { zh: 'Telegram', en: 'Telegram' },
  description: { zh: '接收这些私聊、群聊与话题群中发给机器人的消息。', en: 'Receives messages to the bot in these chats and direct messages.' },
  schema: TelegramConfigSchema,
  fields: [
    { key: 'token', type: 'text', label: { zh: 'Bot Token', en: 'Bot token' }, hint: { zh: 'BotFather 签发的机器人令牌；只保存在本地配置，不回显、不打印。', en: 'The bot token from BotFather; kept only in local configuration, never echoed or logged.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的会话', en: 'Chats' },
      hint: { zh: '“仅 @”只接收 @ 机器人的消息；“全部消息”也接收其余消息。chat id 用 Telegram 数字 id（群/频道为负数）。', en: '"@ only" receives messages that mention the bot; "All" also receives the rest. chat id is the Telegram numeric id (negative for groups and channels).' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '会话', en: 'Chat' }, pattern: '-?[0-9]+' },
        { key: 'listen', type: 'select', label: { zh: '接收', en: 'Receive' }, options: [{ value: 'mentions', label: { zh: '仅 @', en: '@ only' } }, { value: 'all', label: { zh: '全部消息', en: 'All' } }] },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他会话', en: 'Other chats' }, options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '仅 @', en: '@ only' } }],
      hint: { zh: '机器人已加入、但没列在上面的会话。“仅 @”接收那里 @ 机器人的消息。', en: 'Chats the bot has joined that are not listed above.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
    { key: 'pollTimeoutSeconds', type: 'number', advanced: true, min: 1, max: 60, label: { zh: '长轮询超时 / 秒', en: 'Polling timeout / seconds' } },
    { key: 'pollIntervalSeconds', type: 'number', advanced: true, min: 1, max: 300, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' } },
  ],
  health: [SOURCE],
  scope: ({ meta }, config) => telegramScope({ meta }, config),
  channel: {
    allowed: (address, config) => telegramAllowed(address, config),
    send: (_host, message) => sendTelegram(message),
    link: (address) => telegramChannelLink(address),
  },
  threadContext: telegramThreadContext,
  find: query => ({ threads: [], terms: [...new Set(query.match(/-?\d{6,}/g) ?? [])] }),
  repliesTo: trigger => telegramRepliesTo(trigger),
  policy: {
    unnamed: { person: { zh: 'Telegram 用户', en: 'Telegram user' }, bot: { zh: 'Telegram 机器人', en: 'Telegram bot' } },
    schema: TelegramPolicySchema,
    fields: [
      { key: 'allowed', type: 'rows', label: { zh: '能发起工作的发送者', en: 'Senders who may originate work' },
        columns: [
          { key: 'id', type: 'text', label: { zh: '发送者', en: 'Sender' }, pattern: '-?[0-9]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ] },
      { key: 'bots', type: 'rows', label: { zh: '消息可以成为候选的机器人', en: 'Bots whose messages may become candidates' },
        columns: [
          { key: 'id', type: 'text', label: { zh: 'bot', en: 'Bot' }, pattern: '-?[0-9]+' },
          { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
        ] },
    ],
    explicit: { zh: '名单内的人 @ 机器人或私聊机器人，总是明确的请求，不需要配置。', en: 'Someone on the list who mentions the bot or messages it directly always makes an explicit request; that needs no setting.' },
    rows(stored) {
      const config = TelegramConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.chatId, note: chat.listen === 'all' ? { zh: '全部消息', en: 'All' } : mentions,
          cells: { listedUnaddressed: chat.listen === 'all', unlistedAddressed: true, unlistedUnaddressed: chat.listen === 'all' } })),
        { id: 'other', label: { zh: '其他会话', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_TELEGRAM_CHAT', description: { zh: '接下工单的 Telegram chat id；工单不是从 Telegram 来的时为空', en: 'chat_id of the Telegram chat that started the ticket; empty when the ticket did not start on Telegram' } },
      { key: 'DSH_SUPERAGENT_TELEGRAM_THREAD', description: { zh: '接下工单的 Telegram 线程根 id；工单不是从 Telegram 来的时为空', en: 'The Telegram thread root that started the ticket; empty when the ticket did not start on Telegram' } },
    ],
    values: ({ trigger }) => ({
      DSH_SUPERAGENT_TELEGRAM_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '',
      DSH_SUPERAGENT_TELEGRAM_THREAD: trigger?.source === SOURCE ? String(trigger.meta.root ?? trigger.meta.messageId ?? '') : '',
    }),
  },
}

/** Returns the Telegram Source's settings, falling back to schema defaults while the plugin is disabled. */
export const telegramSettings = (sources: SourceRegistry): TelegramConfig => sources.instance<TelegramConfig>(SOURCE)?.config ?? TelegramConfigSchema.parse({})

export const name = 'dsh-superagent-telegram'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(telegramKind), 'telegram: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, telegramKind)
    const controller = new AbortController()
    const running = runTelegram(source, controller.signal)
      .catch((error: unknown) => { source.report('telegram', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running; setTelegramToken(undefined) }
  })
}
