/** Telegram Bot API update to Trigger translation, configuration schema, scope and chat links. */
import { z } from 'zod'
import { key, threadKey, type ChannelRef, type ScopeResult, type Trigger } from '../core/index.ts'

export const SOURCE = 'telegram'

/** A Telegram Bot API `Update`, reduced to the fields translation reads. */
const TelegramUser = z.object({ id: z.number().int(), is_bot: z.boolean().default(false), username: z.string().optional() })
const TelegramChat = z.object({ id: z.number().int(), type: z.enum(['private', 'group', 'supergroup', 'channel']), username: z.string().optional() })
export const TelegramMessageSchema = z.looseObject({
  message_id: z.number().int(),
  from: TelegramUser.optional(),
  chat: TelegramChat,
  date: z.number().int(),
  text: z.string().optional(),
  message_thread_id: z.number().int().optional(),
  reply_to_message: z.looseObject({ message_id: z.number().int() }).optional(),
})
export type TelegramMessage = z.infer<typeof TelegramMessageSchema>
export const TelegramUpdateSchema = z.looseObject({
  update_id: z.number().int(),
  message: TelegramMessageSchema.optional(),
  edited_message: TelegramMessageSchema.optional(),
})
export type TelegramUpdate = z.infer<typeof TelegramUpdateSchema>

/** Bot identity as Telegram reports it from `getMe`. */
export const TelegramBotInfoSchema = z.object({ id: z.number().int(), username: z.string().optional() })
export type TelegramBotInfo = z.infer<typeof TelegramBotInfoSchema>

/** One configured chat the bot receives: its numeric id and how much of it the Source takes in. */
export const TelegramChatSchema = z.object({
  chatId: z.string().trim().regex(/^-?[0-9]+$/, 'Telegram numeric chat id (negative for groups, channels and topics)'),
  listen: z.enum(['mentions', 'all']),
}).strict()
/**
 * The Telegram Source configuration. `token` is the running Bot Token; it defaults to empty so an unconfigured instance
 * still validates (the loop reports it is waiting), and an operator may instead supply it through `TG_BOT_TOKEN`, which
 * keeps it out of the stored configuration.
 */
export const TelegramConfigSchema = z.object({
  token: z.string().trim().default(''),
  chats: z.array(TelegramChatSchema)
    .refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs')
    .default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  /** Open a forum topic for a mentioned message in a forum group, as Feishu threads a reply under the message. */
  autoTopics: z.boolean().default(true),
  pollTimeoutSeconds: z.number().int().min(1).max(60).default(25),
  pollIntervalSeconds: z.number().int().min(1).max(300).default(1),
}).strict()
export type TelegramConfig = z.infer<typeof TelegramConfigSchema>

/** The Bot Token in effect: `TG_BOT_TOKEN` when set, otherwise the one saved in the Source configuration. */
export const telegramToken = (config: TelegramConfig, env: Record<string, string | undefined> = process.env): string =>
  (env.TG_BOT_TOKEN ?? '').trim() || config.token.trim()

/** Removes the bot's `@username` mention from a text; leaves other text untouched. */
export function normalizeText(text: string, botUsername?: string): string {
  const trimmed = (text ?? '').trim()
  if (!botUsername) return trimmed
  const mention = `@${botUsername}`
  return trimmed.replace(new RegExp(`\\s*${mention.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*`, 'g'), ' ').trim()
}

/** Whether the text mentions the bot (`@username`, case-insensitive). */
export function mentionsBot(text: string, botUsername?: string): boolean {
  if (!botUsername) return false
  return new RegExp(`(^|[^\\w])@${botUsername.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w]|$)`, 'i').test(text ?? '')
}

/** The thread a message belongs to after resolving bot-opened topics: the conversation root and, inside a topic, its id. */
export type TelegramThread = { root: string; topic?: number }

/**
 * Translates one Telegram update into a Trigger, or undefined for the bot's own messages.
 * A stable id `telegram:<update_id>:<message_id>` makes re-reading a round safe; edits reuse the message id, so an
 * `edited_message` replaces the text of the event already stored rather than opening a second Ticket.
 */
export function telegramTrigger(update: TelegramUpdate, bot?: TelegramBotInfo | undefined, botId?: number,
  resolved?: TelegramThread): Trigger | undefined {
  const message = update.message ?? update.edited_message
  if (!message || !message.from) return undefined
  const from = message.from
  if (botId !== undefined ? from.id === botId : bot && from.id === bot.id) return undefined
  const chatId = message.chat.id
  const isDirect = message.chat.type === 'private'
  // A resolved thread (a bot-opened topic, or a topic message mapped back to its origin) wins over the raw update.
  // Otherwise a forum topic uses its message_thread_id as the thread root and a plain or private chat uses the message itself.
  const topic = resolved?.topic ?? message.message_thread_id
  const root = resolved?.root
    ?? (message.message_thread_id !== undefined ? String(message.message_thread_id) : String(message.message_id))
  const thread = `${chatId}:${root}`
  const text = normalizeText(message.text ?? '', bot?.username)
  // A message the Bot API gives no text field (a bare photo, a voice note) carries nothing to assess: its caption lives
  // in another field this Source does not read. A text message that is only the bot's mention is the same empty request,
  // so both keep the cursor moving without opening a Ticket.
  if (!text) return undefined
  const addressed = isDirect ? 'direct' as const
    : mentionsBot(message.text ?? '', bot?.username) ? 'mention' as const : undefined
  const channel: ChannelRef = {
    source: SOURCE,
    thread: threadKey({ source: SOURCE, id: thread }),
    address: { chatId: String(chatId), messageId: String(message.message_id), direct: String(isDirect),
      ...(topic !== undefined ? { topic: String(topic) } : {}) },
  }
  return {
    id: key(SOURCE, String(update.update_id), String(message.message_id)),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: String(from.id) },
    human: !from.is_bot,
    ...(addressed ? { addressed } : {}),
    at: new Date(message.date * 1000).toISOString(),
    text,
    channel,
    url: telegramLink({ chatId: String(chatId), messageId: String(message.message_id) }),
    meta: {
      chatId: String(chatId),
      messageId: message.message_id,
      root: String(root),
      updateId: update.update_id,
      direct: isDirect,
      ...(topic !== undefined ? { topic } : {}),
      ...(message.message_thread_id !== undefined ? { messageThreadId: message.message_thread_id } : {}),
      ...(message.reply_to_message ? { replyToMessageId: message.reply_to_message.message_id } : {}),
      ...(from.username ? { fromUsername: from.username } : {}),
    },
  }
}

/** The Trigger id of the message a Trigger replies to is not derivable without its update_id, so repliesTo returns undefined. */
export function telegramRepliesTo(_trigger: Trigger): undefined { return undefined }

/**
 * Whether a message is in the Source's receipt scope, from `meta` and configuration alone.
 * Listed chats are received (`all` also observes unaddressed messages); a private chat is received under `directMessages`;
 * every other chat is received only when `otherChats` is `mentions`.
 */
export function telegramScope(input: { meta: Record<string, unknown> }, config: TelegramConfig): ScopeResult {
  if (input.meta.direct === true) {
    return config.directMessages ? { listened: true, observed: false, row: 'direct' }
      : { listened: false, reason: 'direct_messages_not_allowed' }
  }
  const chatId = String(input.meta.chatId ?? '')
  const chat = config.chats.find(item => item.chatId === chatId)
  if (chat) return { listened: true, observed: chat.listen === 'all', row: chat.chatId }
  return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' }
    : { listened: false, reason: 'chat_not_allowed' }
}

/** A Telegram chat deep link; the `c/<id>` form works for public chats and channels when the id is public. */
export function telegramLink(address: Record<string, string>): string {
  const chatId = address.chatId ?? ''
  const messageId = address.messageId
  return messageId ? `https://t.me/c/${chatId}/${messageId}` : `https://t.me/c/${chatId}`
}

/** The `getMe` answer, reduced to the bot's identity. */
export const GetMeSchema = z.object({ ok: z.literal(true), result: TelegramBotInfoSchema })
/** The `sendMessage` error body; `ok` is false on failure. */
export const TelegramErrorSchema = z.object({
  ok: z.boolean().default(false),
  description: z.string().optional(),
  error_code: z.number().int().optional(),
})

/** True when the sending chat can never accept another message (blocked, kicked, or deleted). */
export function telegramGone(error: z.infer<typeof TelegramErrorSchema>): boolean {
  return error.error_code === 403
    || /blocked|chat not found|bot was kicked|user is deactivated|chat_not_found|PEER_ID_INVALID/i.test(error.description ?? '')
}
