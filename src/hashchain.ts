import crypto from 'crypto';

export const GENESIS_HASH = 'sha256:' + '0'.repeat(64);

export function sha256hex(data: string | Buffer | Uint8Array): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

export function sha256(data: string | Buffer | Uint8Array): string {
  return 'sha256:' + sha256hex(data);
}

function sortKeysDeep(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(sortKeysDeep);
  if (obj !== null && typeof obj === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
      sorted[key] = sortKeysDeep((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return obj;
}

export function canonicalJson(obj: Record<string, unknown>): string {
  return JSON.stringify(sortKeysDeep(obj));
}

export function computeEntryHash(entry: Record<string, unknown>): string {
  const { entry_hash, ...rest } = entry;
  void entry_hash;
  return sha256(canonicalJson(rest as Record<string, unknown>));
}

export function validateChain(entries: Array<Record<string, unknown>>): boolean {
  if (entries.length === 0) return true;

  const first = entries[0];
  if (!first) return true;
  if ((first['prev_hash'] as string) !== GENESIS_HASH) return false;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const expected = computeEntryHash(entry);
    if (entry['entry_hash'] !== expected) return false;

    if (i + 1 < entries.length) {
      const next = entries[i + 1];
      if (!next) continue;
      if (next['prev_hash'] !== entry['entry_hash']) return false;
    }
  }
  return true;
}
