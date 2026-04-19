import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { quarantineIngest } from './quarantine.js';

const MOLTBOOK_BASE = 'https://www.moltbook.com';

const CURSORS_PATH = () =>
  path.join(process.env['DATA_DIR'] ?? '/data', 'memory', 'moltbook_cursors.json');

// Per-submolt set of post IDs already returned to the agent.
// Keeps at most 200 IDs per submolt to prevent unbounded growth.
function loadCursors(): Record<string, string[]> {
  try {
    const raw = fs.readFileSync(CURSORS_PATH(), 'utf8');
    return JSON.parse(raw) as Record<string, string[]>;
  } catch {
    return {};
  }
}

function saveCursors(cursors: Record<string, string[]>): void {
  try {
    const dir = path.dirname(CURSORS_PATH());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CURSORS_PATH(), JSON.stringify(cursors, null, 2), 'utf8');
  } catch (e) {
    console.warn('[moltbook] could not save cursor file:', e);
  }
}

function authHeader(): Record<string, string> {
  const key = process.env['MOLTBOOK_API_KEY'];
  if (!key) throw new Error('MOLTBOOK_API_KEY not set');
  // Per https://www.moltbook.com/developers — bot API keys (what
  // monet has) authenticate via `Authorization: Bearer ...`. The
  // `X-Moltbook-App-Key` header is for *app* keys (moltdev_…), used
  // for verifying user identity tokens, not for agent posting.
  return { Authorization: `Bearer ${key}` };
}

export interface MoltbookPost {
  id: string;
  author: string;
  title?: string;
  body: string;
  ts: string;
  vote_count?: number;
}

// Normalize raw API post shape → MoltbookPost.
// The API returns `content`, `created_at`, `author` (object), `upvotes` —
// different from the interface field names.
function normalizePost(raw: Record<string, unknown>): MoltbookPost {
  const author = raw['author'];
  const authorName =
    author && typeof author === 'object'
      ? String((author as Record<string, unknown>)['name'] ?? '')
      : String(author ?? '');
  return {
    id: String(raw['id'] ?? ''),
    author: authorName,
    title: raw['title'] != null ? String(raw['title']) : undefined,
    body: String(raw['content'] ?? raw['body'] ?? ''),
    ts: String(raw['created_at'] ?? raw['ts'] ?? ''),
    vote_count: typeof raw['upvotes'] === 'number' ? raw['upvotes'] : typeof raw['vote_count'] === 'number' ? raw['vote_count'] : undefined,
  };
}

export async function moltbookRead(
  submolt: string,
  limit = 10,
): Promise<{ posts: MoltbookPost[]; injection_suspected: boolean; new_count: number; already_seen_skipped: number }> {
  const resp = await axios.get(`${MOLTBOOK_BASE}/api/v1/posts`, {
    headers: { ...authHeader() },
    params: { submolt, sort: 'new', limit: Math.min(limit, 10) },
    timeout: 15_000,
  });

  const rawPosts: unknown[] = Array.isArray(resp.data)
    ? resp.data
    : ((resp.data as Record<string, unknown>)['posts'] as unknown[] ?? []);

  if (rawPosts.length === 0) {
    return { posts: [], injection_suspected: false, new_count: 0, already_seen_skipped: 0 };
  }

  // Filter to posts not yet seen by the agent.
  const cursors = loadCursors();
  const seenIds = new Set<string>(cursors[submolt] ?? []);
  const newRawPosts = rawPosts.filter((p) => {
    const id = String((p as Record<string, unknown>)['id'] ?? '');
    return id && !seenIds.has(id);
  });
  const skipped = rawPosts.length - newRawPosts.length;

  if (newRawPosts.length === 0) {
    return { posts: [], injection_suspected: false, new_count: 0, already_seen_skipped: skipped };
  }

  // Normalize fields locally — no LLM needed for structured API data.
  const posts = newRawPosts.map((p) => normalizePost(p as Record<string, unknown>));

  // Quarantine pass: injection detection only, not data extraction.
  // Pass post bodies as plain text; ask for a single boolean flag.
  // This is fast (tiny output) vs. the old approach of re-serializing all posts.
  const bodiesText = posts.map((p, i) => `[${i + 1}] ${p.title ?? ''}\n${p.body}`).join('\n\n');
  let injection_suspected = false;
  try {
    const result = await quarantineIngest<{ injection_suspected?: boolean }>(
      bodiesText,
      { type: 'object', properties: { injection_suspected: { type: 'boolean' } } },
    );
    injection_suspected = result.injection_suspected || Boolean(result.data.injection_suspected);
  } catch {
    // Quarantine failure is non-fatal — flag it but return the posts.
    injection_suspected = true;
    console.warn('[moltbook] quarantine failed, marking injection_suspected=true');
  }

  // Persist seen IDs so next heartbeat skips these posts.
  const updatedSeen = [...seenIds, ...posts.map((p) => p.id).filter(Boolean)];
  cursors[submolt] = updatedSeen.slice(-200);
  saveCursors(cursors);

  const totalBodyChars = posts.reduce((n, p) => n + p.body.length, 0);
  const firstTitle = posts[0]?.title ?? posts[0]?.body.slice(0, 60) ?? '(no content)';
  console.log(
    `[moltbook] ${submolt}: new=${posts.length} skipped=${skipped} ` +
    `body_chars=${totalBodyChars} injection=${injection_suspected} ` +
    `first="${firstTitle.slice(0, 80)}"`
  );

  return { posts, injection_suspected, new_count: posts.length, already_seen_skipped: skipped };
}

export interface SubmoltInfo {
  name: string;
  display_name: string;
  description: string;
  subscriber_count: number;
  post_count: number;
}

export async function moltbookListSubmolts(): Promise<{ submolts: SubmoltInfo[]; total: number }> {
  const resp = await axios.get(`${MOLTBOOK_BASE}/api/v1/submolts`, {
    headers: { ...authHeader() },
    timeout: 15_000,
  });
  const d = resp.data as Record<string, unknown>;
  const raw: unknown[] = Array.isArray(d['submolts']) ? (d['submolts'] as unknown[]) : [];
  const submolts: SubmoltInfo[] = raw
    .filter((s) => {
      const r = s as Record<string, unknown>;
      return !r['is_nsfw'] && !r['is_private'];
    })
    .map((s) => {
      const r = s as Record<string, unknown>;
      return {
        name: String(r['name'] ?? ''),
        display_name: String(r['display_name'] ?? ''),
        description: String(r['description'] ?? ''),
        subscriber_count: Number(r['subscriber_count'] ?? 0),
        post_count: Number(r['post_count'] ?? 0),
      };
    })
    .sort((a, b) => b.post_count - a.post_count);
  return { submolts, total: submolts.length };
}

export async function moltbookPost(
  submolt: string,
  title: string,
  body: string,
): Promise<{ ok: true; post_id: string }> {
  // Scrub any image markdown or <img> tags before posting
  const cleanBody = body
    .replace(/<img[^>]*>/gi, '[image removed]')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[image removed]');

  const resp = await axios.post(
    `${MOLTBOOK_BASE}/api/v1/posts`,
    { submolt_name: submolt, title, content: cleanBody },
    { headers: { ...authHeader(), 'Content-Type': 'application/json' }, timeout: 15_000 },
  );

  const d = resp.data as Record<string, unknown>;
  // POST response shape: { success, message, post: { id, ... }, tip }
  const postObj = d['post'] as Record<string, unknown> | undefined;
  const postId = String(postObj?.['id'] ?? d['id'] ?? '');
  return { ok: true, post_id: postId };
}

export const moltbookTools = [
  {
    type: 'function' as const,
    function: {
      name: 'moltbook_list_submolts',
      description:
        'List all public Moltbook submolts sorted by post_count. Call this before moltbook_read to discover active submolts — do not guess or reuse the same 3 names. Returns name, display_name, description, subscriber_count, post_count.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'moltbook_read',
      description:
        'Read recent UNSEEN posts from a Moltbook submolt (already-seen posts are automatically skipped via cursor). Call moltbook_list_submolts first to pick an active submolt. Returns new_count and already_seen_skipped so you know whether to bother acting on results.',
      parameters: {
        type: 'object',
        properties: {
          submolt: { type: 'string', description: 'Submolt name (without m/ prefix, e.g. "agentfinance").' },
          limit: { type: 'number', description: 'Max posts to return (max 10).' },
        },
        required: ['submolt'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'moltbook_post',
      description:
        'Post to a Moltbook submolt. Requires Tier 1. Body is public — no secrets, no image markdown.',
      parameters: {
        type: 'object',
        properties: {
          submolt: { type: 'string' },
          title: { type: 'string' },
          body: { type: 'string', description: 'Post body in markdown. Images will be stripped.' },
        },
        required: ['submolt', 'title', 'body'],
      },
    },
  },
];
