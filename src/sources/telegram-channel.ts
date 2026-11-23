/** Telegram outbound channel: posts a reply (split at 4096 chars) into the trigger's chat under the message. */
import type { OutboundMessage } from '../core/index.ts'
import type { ChannelLink } from './kind.ts'
import { TelegramErrorSchema, telegramGone, telegramLink, telegramScope, type TelegramConfig } from './telegram-trigger.ts'

/** The running token, refreshed by the loop on each enabled round; `channel.send` resolves it at send time. */
let activeToken: string | undefined
export const setTelegramToken = (token: string | undefined): void => { activeToken = token }

/** Telegram's per-message character limit; longer replies split into ordered chunks. */
export const MAX_MESSAGE_CHARS = 4096
/** Splits a reply into chunks at the limit, preferring paragraph and newline boundaries. */
export function chunkText(text: string, limit: number = MAX_MESSAGE_CHARS): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let rest = text
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n\n', limit)
    if (cut < Math.floor(limit / 2)) cut = rest.lastIndexOf('\n', limit)
    if (cut < Math.floor(limit / 2)) cut = limit
    chunks.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  if (rest) chunks.push(rest)
  return chunks
}

/** A minimal `fetch` shape, so tests and the Telegram Bot API client can inject one without the full `RequestInfo` union. */
export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>

/**
 * Sends a message into the trigger's chat, replying to the originating message, splitting at 4096 chars.
 * Returns `gone` when the chat can never receive another message (blocked/kicked), and throws otherwise so Outbox retries.
 */
export async function sendTelegram(message: OutboundMessage, fetchImpl: Fetcher = fetch): Promise<'sent' | 'gone'> {
  const token = activeToken
  if (!token) throw new Error('The Telegram Source has no Bot Token')
  const { chatId, messageId } = message.channel.address
  if (!chatId) throw new Error('Missing Telegram reply target')
  const chunks = chunkText(message.text)
  for (let index = 0; index < chunks.length; index++) {
    const payload: Record<string, unknown> = { chat_id: chatId, text: chunks[index] }
    if (index === 0 && messageId) payload.reply_to_message_id = Number(messageId)
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    })
    const body = TelegramErrorSchema.parse(await response.json())
    if (!body.ok) {
      if (telegramGone(body)) return 'gone'
      throw new Error(`Telegram sendMessage failed: ${body.description ?? response.status}`)
    }
  }
  return 'sent'
}

/** The panel link for a Telegram chat: a deep link to the chat, or to the message when retained. */
export function telegramChannelLink(address: Record<string, string>): ChannelLink {
  return { url: telegramLink(address), label: { zh: 'Telegram 消息', en: 'Telegram message' } }
}

/** Whether a reply may still go to `address`; the chat must stay within the Source's receipt scope. */
export function telegramAllowed(address: Record<string, string>, config: TelegramConfig): boolean {
  return telegramScope({ meta: { chatId: address.chatId ?? '', direct: address.direct === 'true' } }, config).listened
}
