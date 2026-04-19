import axios from 'axios';

// imsg_send maps to Telegram Bot API.
// "damian"       → TELEGRAM_CHAT_ID_DAMIAN
// "jenny"        → TELEGRAM_CHAT_ID_JENNY
// "damian_jenny" → TELEGRAM_CHAT_ID_GROUP

type Recipient = 'damian' | 'jenny' | 'damian_jenny';

function resolveChatId(to: Recipient): string {
  const map: Record<Recipient, string | undefined> = {
    damian: process.env['TELEGRAM_CHAT_ID_DAMIAN'],
    jenny: process.env['TELEGRAM_CHAT_ID_JENNY'],
    damian_jenny: process.env['TELEGRAM_CHAT_ID_GROUP'],
  };
  const id = map[to];
  if (!id) throw new Error(`Telegram chat ID for "${to}" not configured (check Fly secrets).`);
  return id;
}

export async function imsgSend(to: Recipient, text: string): Promise<{ ok: true; to: Recipient }> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) throw new Error('TELEGRAM_BOT_TOKEN not set');

  // Scrub image markdown / <img> tags from outbound messages
  const cleanText = text
    .replace(/<img[^>]*>/gi, '[image removed]')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image removed]');

  const chatId = resolveChatId(to);

  await axios.post(
    `https://api.telegram.org/bot${token}/sendMessage`,
    {
      chat_id: chatId,
      text: cleanText,
      parse_mode: 'Markdown',
    },
    { timeout: 15_000 },
  );

  return { ok: true, to };
}

export const telegramTools = [
  {
    type: 'function' as const,
    function: {
      name: 'imsg_send',
      description:
        'Send a message to Damian, Jenny, or both via Telegram. Use "damian" for ops/daily, "jenny" for strategy, "damian_jenny" for shared decisions.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            enum: ['damian', 'jenny', 'damian_jenny'],
            description: 'Recipient: "damian", "jenny", or "damian_jenny" (group).',
          },
          text: { type: 'string', description: 'Message text. Markdown supported. No image syntax.' },
        },
        required: ['to', 'text'],
      },
    },
  },
];
