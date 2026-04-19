import axios from 'axios';

export interface CitationResult {
  verified: boolean;
  url: string;
  quoted_text: string;
  reason?: string;
}

export async function verifyCitation(url: string, quotedText: string): Promise<CitationResult> {
  // Block non-http(s) and non-allowlist domains in production
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    return { verified: false, url, quoted_text: quotedText, reason: 'Non-HTTP URL rejected.' };
  }

  let pageText: string;
  try {
    const resp = await axios.get(url, {
      timeout: 15_000,
      maxContentLength: 5 * 1024 * 1024, // 5 MB max
      headers: { 'User-Agent': 'monet-agent/1.0 citation-verifier' },
    });
    pageText = typeof resp.data === 'string' ? resp.data : JSON.stringify(resp.data);
  } catch (err) {
    return {
      verified: false,
      url,
      quoted_text: quotedText,
      reason: `Fetch failed: ${String(err)}`,
    };
  }

  // Normalise whitespace for comparison
  const normalise = (s: string) =>
    s
      .replace(/\s+/g, ' ')
      .replace(/[""]/g, '"')
      .replace(/['']/g, "'")
      .toLowerCase()
      .trim();

  const normPage = normalise(pageText);
  const normQuote = normalise(quotedText);

  // Require at least 80% of quote tokens to appear in order (sliding window)
  const tokens = normQuote.split(' ').filter(Boolean);
  let matched = 0;
  let searchFrom = 0;
  for (const token of tokens) {
    const idx = normPage.indexOf(token, searchFrom);
    if (idx !== -1) {
      matched++;
      searchFrom = idx + token.length;
    }
  }
  const ratio = tokens.length > 0 ? matched / tokens.length : 0;
  const verified = ratio >= 0.8;

  return {
    verified,
    url,
    quoted_text: quotedText,
    reason: verified
      ? `${Math.round(ratio * 100)}% of quote tokens found in order.`
      : `Only ${Math.round(ratio * 100)}% matched — citation rejected.`,
  };
}

export const citationTools = [
  {
    type: 'function' as const,
    function: {
      name: 'verify_citation',
      description:
        'Check that quoted_text appears on the page at url. Returns {verified: bool}. Required before any citation earns points or appears in the public log.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'The source URL to fetch.' },
          quoted_text: { type: 'string', description: 'The exact text claimed to be from the source.' },
        },
        required: ['url', 'quoted_text'],
      },
    },
  },
];
