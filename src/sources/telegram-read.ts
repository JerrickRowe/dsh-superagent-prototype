/** Telegram thread context for assessments: the messages of a Trigger's thread from the shared read window. */
import type { Trigger } from '../core/index.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'
import { normalizeText, type TelegramBotInfo, type TelegramMessage } from './telegram-trigger.ts'

/**
 * The retained window of messages the polling loop keeps, keyed `chatId:root` then message id. Telegram's Bot API cannot
 * read a chat's history at will, so assessments read only the messages the bot has received; parent and root resolve within it.
 */
export type TelegramCache = Map<string, Map<string, TelegramMessage>>

/** The shared read window, resized per chat thread on each poll; the loop writes it and the reader reads it. */
export const telegramWindow: TelegramCache = new Map()
/** Caps so the in-memory window stays bounded in a long-running process: newest threads and messages are kept. */
export const WINDOW_THREADS = 500
export const WINDOW_MESSAGES = 200

/**
 * Retains one received message in its thread window, keeping at most `WINDOW_MESSAGES` per thread and
 * `WINDOW_THREADS` threads (evicting the least recently used thread when over).
 */
export function remember(key: string, message: TelegramMessage): void {
  const window = telegramWindow.get(key) ?? new Map<string, TelegramMessage>()
  const id = String(message.message_id)
  window.delete(id)
  window.set(id, message)
  while (window.size > WINDOW_MESSAGES) {
    const oldest = window.keys().next().value
    if (oldest === undefined) break
    window.delete(oldest)
  }
  telegramWindow.delete(key)
  telegramWindow.set(key, window)
  while (telegramWindow.size > WINDOW_THREADS) {
    const oldest = telegramWindow.keys().next().value
    if (oldest === undefined) break
    telegramWindow.delete(oldest)
  }
}

/** The cache key for a thread: `chatId:root`. */
export const threadCacheKey = (trigger: Trigger): string => `${String(trigger.meta.chatId ?? '')}:${String(trigger.meta.root ?? trigger.meta.messageId ?? '')}`

/** Normalizes a retained Telegram message into a `ContextMessage` for the assessing Session. */
export function telegramMessage(message: TelegramMessage, bot?: TelegramBotInfo): ContextMessage {
  return {
    id: String(message.message_id),
    from: String(message.from?.id ?? ''),
    at: new Date(message.date * 1000).toISOString(),
    text: normalizeText(message.text ?? '', bot?.username),
    ...(message.from?.is_bot ? { bot: true as const } : {}),
    ...(message.reply_to_message ? { reply_to: String(message.reply_to_message.message_id) } : {}),
  }
}

/** Reads a Trigger's thread window; the bot identity is supplied by the caller from the resolved deployment-independent value. */
export const telegramThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read: (_commands, trigger, part) => {
    const window = telegramWindow.get(threadCacheKey(trigger)) ?? new Map<string, TelegramMessage>()
    const bot: TelegramBotInfo | undefined = undefined
    if (part === 'parent') {
      const parentId = trigger.meta.replyToMessageId
      const parent = typeof parentId === 'number' ? window.get(String(parentId)) : undefined
      return Promise.resolve(parent
        ? { messages: [telegramMessage(parent, bot)], body: { status: 'available' }, status: 'available' } as ContextPart
        : { messages: [], body: { status: 'no_parent' }, status: 'no_parent' } as ContextPart)
    }
    if (part === 'root') {
      const rootId = String(trigger.meta.root ?? trigger.meta.messageId ?? '')
      const root = window.get(rootId)
      return Promise.resolve(root
        ? { messages: [telegramMessage(root, bot)], body: { status: 'available' }, status: 'available' } as ContextPart
        : { messages: [], body: { status: 'no_root' }, status: 'no_root' } as ContextPart)
    }
    const messages = [...window.values()].sort((a, b) => a.message_id - b.message_id)
      .map(message => telegramMessage(message, bot))
    return Promise.resolve({ messages, body: { status: 'available', messages }, status: 'available' } as ContextPart)
  },
}
