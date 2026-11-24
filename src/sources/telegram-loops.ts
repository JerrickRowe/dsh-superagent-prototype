/** Telegram polling loop and cursor; waits for setup, follows the switch, and takes each update in after the cursor. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, type SourceContext } from './host.ts'
import { GetMeSchema, TelegramUpdateSchema, mentionsBot, telegramToken, telegramTrigger, type TelegramBotInfo,
  type TelegramConfig, type TelegramThread } from './telegram-trigger.ts'
import { setTelegramToken, type Fetcher } from './telegram-channel.ts'
import { remember } from './telegram-read.ts'

const GetUpdatesResponseSchema = z.object({ ok: z.literal(true), result: z.array(TelegramUpdateSchema) })
/** The `getChat` answer the loop caches per chat: only `is_forum` matters, because a topic can exist only in a forum. */
const GetChatSchema = z.object({ ok: z.literal(true), result: z.object({ is_forum: z.boolean().optional() }).loose() })
/** The `createForumTopic` answer: the new topic's `message_thread_id`, which every reply into it carries. */
const CreateTopicSchema = z.object({ ok: z.literal(true), result: z.object({ message_thread_id: z.number().int() }).loose() })
/** Telegram caps a topic name at 128 characters; the first words of the message make it recognizable. */
const TOPIC_NAME_CHARS = 60

/** A forum topic name from the mentioned message, or a stable fallback so a created topic is never nameless. */
export function topicName(text: string, fallback = 'dsh-superagent'): string {
  const name = text.replace(/\s+/g, ' ').replace(/^@\S+\s*/, '').trim().slice(0, TOPIC_NAME_CHARS).trim()
  return name || fallback
}

/** Whether a group is a forum (topics enabled); a failing read is treated as not a forum so the Source stays silent. */
async function isForum(chatId: number, token: string, fetchImpl: Fetcher): Promise<boolean> {
  try {
    const body = GetChatSchema.parse(await (await fetchImpl(`https://api.telegram.org/bot${token}/getChat?chat_id=${chatId}`)).json())
    return body.result.is_forum === true
  } catch { return false }
}

/**
 * Resolves a message's thread and, for a message that mentions the bot in a forum's General area, opens a topic for the
 * conversation the way Feishu threads a reply under its message. Returns the trigger's thread and the message's window key.
 * A previously created topic is reused, so a retried round never opens a second one for the same conversation.
 */
async function resolveThread(ctx: SourceContext, config: TelegramConfig, token: string, fetchImpl: Fetcher,
  message: { chat: { id: number; type: string }; message_id: number; message_thread_id?: number; text?: string },
  bot: TelegramBotInfo | undefined): Promise<TelegramThread> {
  const chatId = message.chat.id
  if (message.message_thread_id !== undefined) {
    const topic = message.message_thread_id
    // A message inside a bot-opened topic continues the conversation whose root is stored for it.
    return { root: ctx.state.get(KV.telegram.origins(String(chatId), topic)) ?? String(topic), topic }
  }
  const root = String(message.message_id)
  if (message.chat.type === 'private' || !config.autoTopics || !mentionsBot(message.text ?? '', bot?.username)) return { root }
  const known = ctx.state.get(KV.telegram.topics(String(chatId), root))
  if (known !== undefined) return { root, topic: known }
  if (!await isForum(chatId, token, fetchImpl)) return { root }
  try {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/createForumTopic`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, name: topicName(message.text ?? '') }),
    })
    const body = CreateTopicSchema.parse(await response.json())
    const topic = body.result.message_thread_id
    ctx.state.set(KV.telegram.topics(String(chatId), root), topic)
    ctx.state.set(KV.telegram.origins(String(chatId), topic), root)
    return { root, topic }
  } catch {
    // No topic permission, a flood wait or a network error: answer in place rather than lose the message.
    return { root }
  }
}

/** The bot's identity, resolved from `getMe` once per token. */
export async function resolveBot(token: string, fetchImpl: Fetcher = fetch): Promise<TelegramBotInfo> {
  const body = GetMeSchema.passthrough().parse(await (await fetchImpl(`https://api.telegram.org/bot${token}/getMe`)).json())
  return body.result
}

/** One `getUpdates` round: read after the cursor, take each update in, then advance the cursor past the last one. */
export async function pollTelegram(ctx: SourceContext, config: TelegramConfig, token: string, bot: TelegramBotInfo | undefined,
  fetchImpl: Fetcher = fetch): Promise<{ read: number; unreadable: number }> {
  const cursor = ctx.state.get(KV.telegram.cursor) ?? 0
  const params = new URLSearchParams({ timeout: String(config.pollTimeoutSeconds) })
  if (cursor > 0) params.set('offset', String(cursor))
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?${params}`)
  const body = GetUpdatesResponseSchema.parse(await response.json())
  let unreadable = 0
  let nextCursor = cursor
  for (const update of body.result) {
    const message = update.message ?? update.edited_message
    const thread = message ? await resolveThread(ctx, config, token, fetchImpl, message, bot) : undefined
    const trigger = telegramTrigger(update, bot, undefined, thread)
    // Retain the message in its thread window even when it produces no Trigger (the bot's own message).
    if (message && thread) remember(`${message.chat.id}:${thread.root}`, message)
    if (trigger) {
      await ctx.receive(trigger)
      for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { url: trigger.url })
    }
    nextCursor = update.update_id + 1
  }
  ctx.state.set(KV.telegram.cursor, nextCursor)
  return { read: body.result.length, unreadable }
}

/** Runs the polling loop until `signal` aborts: waits for setup, follows the switch, and reports health per round. */
export async function runTelegram(ctx: SourceContext, signal: AbortSignal, env: Record<string, string | undefined> = process.env,
  fetchImpl: Fetcher = fetch): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('telegram', health('paused', 'setupPending')); return }
  let bot: TelegramBotInfo | undefined
  let failures = 0
  while (!signal.aborted) {
    const config = ctx.config<TelegramConfig>('telegram')
    const token = config ? telegramToken(config, env) : ''
    if (!config) {
      setTelegramToken(undefined)
      ctx.report('telegram', health('paused', 'sourceOff'))
    } else if (!token) {
      // An enabled Source without a token waits for the operator rather than counting as a poll failure.
      setTelegramToken(undefined)
      ctx.report('telegram', { state: 'paused', detail: 'Waiting for the Telegram Bot Token' })
    } else {
      setTelegramToken(token)
      try {
        // Resolve the bot once per token so the loop can drop its own messages even before a round.
        if (!bot) bot = await resolveBot(token, fetchImpl)
        const { read, unreadable } = await pollTelegram(ctx, config, token, bot, fetchImpl)
        failures = 0
        ctx.report('telegram', { state: 'ready', detail: `${read} messages, ${unreadable} unreadable`, at: new Date().toISOString() })
      } catch (error) {
        failures += 1
        bot = undefined
        if (!signal.aborted && failures >= 3) {
          ctx.report('telegram', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
        }
      }
    }
    const interval = (config?.pollIntervalSeconds ?? 1) * 1000
    await delay(interval, undefined, { signal }).catch(() => {})
  }
}
