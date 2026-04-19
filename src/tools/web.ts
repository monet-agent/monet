// General web research tools. web_fetch hits any URL that the Fly
// egress allowlist permits (the firewall is the gate; this tool does
// not enforce domain restrictions itself).
//
// web_search was removed in favor of Moonshot's $web_search builtin —
// see src/tools/kimi_builtins.ts. That path is free (bundled with the
// LLM call) and better-integrated with the thinking loop than Brave.

const MAX_RESPONSE_BYTES = 256 * 1024;
const UA = 'monet-agent/0.1 (+research)';

export async function webFetch(
  url: string,
  timeoutMs = 15_000,
): Promise<{ url: string; status: number; content_type: string; body: string; truncated: boolean; note: string }> {
  if (!/^https?:\/\//i.test(url)) throw new Error('URL must be http(s).');
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json,text/*;q=0.9' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    const ct = res.headers.get('content-type') ?? 'application/octet-stream';
    const raw = await res.text();
    const truncated = raw.length > MAX_RESPONSE_BYTES;
    const body = truncated ? raw.slice(0, MAX_RESPONSE_BYTES) + '\n\n[truncated]' : raw;
    return {
      url,
      status: res.status,
      content_type: ct,
      body,
      truncated,
      note: 'UNTRUSTED external content. Pass through quarantine_ingest before extracting claims.',
    };
  } finally {
    clearTimeout(t);
  }
}

export const webTools = [
  {
    type: 'function' as const,
    function: {
      name: 'web_fetch',
      description:
        'Fetch any URL locally (goes through our quarantine pipeline when you pass the body to quarantine_ingest). Returns status, content-type, body (truncated at 256KB). UNTRUSTED. Prefer $web_search / $fetch builtins for lighter-weight research; use this one when you need the raw body for a verifiable citation.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'http(s) URL.' } },
        required: ['url'],
      },
    },
  },
];
