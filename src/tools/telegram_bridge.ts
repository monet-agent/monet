import axios from 'axios';
import fs from 'fs';
import path from 'path';

// imsg_send maps to Telegram Bot API.
// "damian"       → TELEGRAM_CHAT_ID_DAMIAN
// "jenny"        → TELEGRAM_CHAT_ID_JENNY
// "damian_jenny" → TELEGRAM_CHAT_ID_GROUP

type Recipient = 'damian' | 'jenny' | 'damian_jenny';

const DATA_DIR = (): string => process.env['DATA_DIR'] ?? '/data';
const INBOX_PATH = (): string => path.join(DATA_DIR(), 'memory/inbox.md');
const OFFSET_PATH = (): string => path.join(DATA_DIR(), 'memory/.telegram_offset');

export interface TgMessage {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; first_name?: string; username?: string };
    chat: { id: number; type: string };
    date: number;
    text?: string;
  };
}

function resolveSenderLabel(chatId: number, from?: { id: number; first_name?: string; username?: string }): string {
  const damian = process.env['TELEGRAM_CHAT_ID_DAMIAN'];
  const jenny = process.env['TELEGRAM_CHAT_ID_JENNY'];
  const group = process.env['TELEGRAM_CHAT_ID_GROUP'];
  const cid = String(chatId);
  if (cid === damian) return 'Damian (DM)';
  if (cid === jenny) return 'Jenny (DM)';
  if (cid === group) {
    const who = from?.username ?? from?.first_name ?? `user:${from?.id ?? '?'}`;
    return `${who} (group)`;
  }
  return `unknown chat ${cid}`;
}

// Pull new Telegram messages sent TO the bot since our last offset,
// append them as inbox entries. Called at the start of every heartbeat.
// Silently returns 0 on any failure — we do not want a flaky Telegram
// call to block heartbeat execution.
export async function pollTelegramInbox(): Promise<number> {
  const token = process.env['TELEGRAM_BOT_TOKEN'];
  if (!token) return 0;

  let offset = 0;
  try {
    if (fs.existsSync(OFFSET_PATH())) {
      offset = parseInt(fs.readFileSync(OFFSET_PATH(), 'utf8').trim(), 10) || 0;
    }
  } catch { /* ignore, start from 0 */ }

  let updates: TgMessage[] = [];
  try {
    const resp = await axios.get(
      `https://api.telegram.org/bot${token}/getUpdates`,
      {
        params: {
          offset: offset > 0 ? offset + 1 : undefined,
          timeout: 0, // short-poll; we do not hold the socket
          allowed_updates: ['message'],
        },
        timeout: 20_000,
      },
    );
    updates = ((resp.data as { result?: TgMessage[] }).result ?? []).filter(
      (u) => u.message?.text,
    );
  } catch (err) {
    console.warn('[telegram] getUpdates failed:', String(err).slice(0, 200));
    return 0;
  }

  console.log(`[telegram] poll: ${updates.length} update(s) since offset ${offset}`);

  if (updates.length === 0) return 0;

  const knownChats = [
    process.env['TELEGRAM_CHAT_ID_DAMIAN'],
    process.env['TELEGRAM_CHAT_ID_JENNY'],
    process.env['TELEGRAM_CHAT_ID_GROUP'],
  ].filter((x): x is string => Boolean(x));

  const entries: string[] = [];
  let maxOffset = offset;
  for (const u of updates) {
    maxOffset = Math.max(maxOffset, u.update_id);
    if (!u.message?.text) continue;
    const chatId = String(u.message.chat.id);
    if (!knownChats.includes(chatId)) {
      console.warn(`[telegram] dropped update ${u.update_id} from unknown chat ${chatId} — text: "${u.message.text.slice(0, 60)}"`);
      continue;
    }
    const sender = resolveSenderLabel(u.message.chat.id, u.message.from);
    const iso = new Date(u.message.date * 1000).toISOString();
    console.log(`[telegram] accepted update ${u.update_id} from ${sender}: "${u.message.text.slice(0, 60)}"`);
    entries.push(`## ${iso} — from ${sender}\n\n${u.message.text.trim()}\n\n---\n`);
  }

  // Always advance the offset, even if we filtered every message —
  // we never want to replay an unknown-sender message on every heartbeat.
  try {
    fs.writeFileSync(OFFSET_PATH(), String(maxOffset), 'utf8');
  } catch (e) {
    console.warn('[telegram] failed to persist offset:', e);
  }

  if (entries.length === 0) return 0;

  appendToInbox(entries.join('\n'));
  return entries.length;
}

function appendToInbox(entry: string): void {
  const inboxPath = INBOX_PATH();
  fs.mkdirSync(path.dirname(inboxPath), { recursive: true });
  const existing = fs.existsSync(inboxPath) ? fs.readFileSync(inboxPath, 'utf8') : '';
  const emptyMarker = '_(No pending instructions.)_';
  const base = existing.includes(emptyMarker)
    ? existing.replace(emptyMarker, '').trimEnd() + '\n'
    : existing.trimEnd() + '\n\n';
  fs.writeFileSync(inboxPath, base + entry, 'utf8');
}

// Process a single Telegram update synchronously (used by webhook handler).
// Returns true if the message was accepted and written to inbox.
export function ingestTelegramUpdate(u: TgMessage): boolean {
  if (!u.message?.text) return false;

  const knownChats = [
    process.env['TELEGRAM_CHAT_ID_DAMIAN'],
    process.env['TELEGRAM_CHAT_ID_JENNY'],
    process.env['TELEGRAM_CHAT_ID_GROUP'],
  ].filter((x): x is string => Boolean(x));

  const chatId = String(u.message.chat.id);
  if (!knownChats.includes(chatId)) {
    console.warn(`[telegram/webhook] dropped update ${u.update_id} from unknown chat ${chatId}`);
    return false;
  }

  const sender = resolveSenderLabel(u.message.chat.id, u.message.from);
  const iso = new Date(u.message.date * 1000).toISOString();
  console.log(`[telegram/webhook] accepted update ${u.update_id} from ${sender}: "${u.message.text.slice(0, 60)}"`);

  // Advance offset so the next cron poll doesn't replay this update.
  try {
    const current = fs.existsSync(OFFSET_PATH())
      ? parseInt(fs.readFileSync(OFFSET_PATH(), 'utf8').trim(), 10) || 0
      : 0;
    if (u.update_id > current) {
      fs.writeFileSync(OFFSET_PATH(), String(u.update_id), 'utf8');
    }
  } catch { /* non-fatal */ }

  appendToInbox(`## ${iso} — from ${sender}\n\n${u.message.text.trim()}\n\n---\n`);
  return true;
}

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

  // Try Markdown first, fall back to plain text on 400 (common when the
  // message has unbalanced *, _, or [ that break Telegram's legacy parser).
  try {
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: cleanText, parse_mode: 'Markdown' },
      { timeout: 15_000 },
    );
  } catch (err) {
    const status = (err as { response?: { status?: number } })?.response?.status;
    if (status !== 400) throw err;
    console.warn('[telegram] Markdown parse failed, retrying as plain text');
    await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: chatId, text: cleanText },
      { timeout: 15_000 },
    );
  }

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
