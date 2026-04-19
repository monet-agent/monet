import axios from 'axios';
import { quarantineIngest } from './quarantine.js';

const MOLTBOOK_BASE = 'https://www.moltbook.com';

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

export async function moltbookRead(
  submolt: string,
  limit = 10,
): Promise<{ posts: MoltbookPost[]; injection_suspected: boolean }> {
  const resp = await axios.get(`${MOLTBOOK_BASE}/api/v1/posts`, {
    headers: { ...authHeader() },
    params: { submolt, sort: 'new', limit: Math.min(limit, 10) },
    timeout: 15_000,
  });

  const rawPosts = Array.isArray(resp.data) ? resp.data : (resp.data as Record<string, unknown>)['posts'];
  const rawContent = JSON.stringify(rawPosts);

  const schema = {
    type: 'object',
    properties: {
      posts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            author: { type: 'string' },
            title: { type: 'string' },
            body: { type: 'string' },
            ts: { type: 'string' },
            vote_count: { type: 'number' },
          },
        },
      },
      injection_suspected: { type: 'boolean' },
    },
  };

  const result = await quarantineIngest<{ posts: MoltbookPost[]; injection_suspected?: boolean }>(
    rawContent,
    schema,
  );

  return {
    posts: result.data.posts ?? [],
    injection_suspected: result.injection_suspected || Boolean(result.data.injection_suspected),
  };
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

  const postId = String((resp.data as Record<string, unknown>)['id'] ?? '');
  return { ok: true, post_id: postId };
}

export const moltbookTools = [
  {
    type: 'function' as const,
    function: {
      name: 'moltbook_read',
      description:
        'Read recent posts from a Moltbook submolt. Output is automatically quarantine-filtered. Use m/agentfinance, m/ponderings, etc.',
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
