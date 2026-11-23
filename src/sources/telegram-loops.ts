/** Telegram polling loop and cursor; waits for setup, follows the switch, and takes each update in after the cursor. */
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, type SourceContext } from './host.ts'
import { GetMeSchema, TelegramUpdateSchema, telegramToken, telegramTrigger, type TelegramBotInfo, type TelegramConfig } from './telegram-trigger.ts'
import { setTelegramToken, type Fetcher } from './telegram-channel.ts'
import { remember } from './telegram-read.ts'

const GetUpdatesResponseSchema = z.object({ ok: z.literal(true), result: z.array(TelegramUpdateSchema) })

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
    const trigger = telegramTrigger(update, bot)
    // Retain the message in its thread window even when it produces no Trigger (the bot's own message).
    const message = update.message ?? update.edited_message
    if (message) {
      const root = message.message_thread_id !== undefined ? String(message.message_thread_id) : String(message.message_id)
      remember(`${message.chat.id}:${root}`, message)
    }
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
