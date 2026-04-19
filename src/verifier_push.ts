import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

let verifierFailures = 0;
let ledgerReadOnly = false;

function makeClient(): S3Client {
  const endpoint = `https://${process.env['R2_ACCOUNT_ID']!}.r2.cloudflarestorage.com`;
  return new S3Client({
    region: 'auto',
    endpoint,
    credentials: {
      accessKeyId: process.env['R2_VERIFIER_ACCESS_KEY_ID']!,
      secretAccessKey: process.env['R2_VERIFIER_SECRET_ACCESS_KEY']!,
    },
  });
}

export function isLedgerReadOnly(): boolean {
  return ledgerReadOnly;
}

export async function verifierPush(
  kind: 'ledger' | 'journal',
  entryHash: string,
  seq: number,
): Promise<void> {
  const client = makeClient();
  const bucket = process.env['R2_BUCKET']!;
  const key = `verifier/${kind}/tip.json`;
  const body = JSON.stringify({
    kind,
    seq,
    entry_hash: entryHash,
    ts: new Date().toISOString(),
  });

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        Body: body,
        ContentType: 'application/json',
      }),
    );
    verifierFailures = 0;
  } catch (err) {
    verifierFailures++;
    console.error(`[verifier_push] push failed (attempt ${verifierFailures}):`, err);

    if (verifierFailures >= 3) {
      ledgerReadOnly = true;
      // Defer Telegram alert to avoid circular dependency — heartbeat_loop reads this flag
      console.error('[verifier_push] 3x failure — entering ledger read-only mode');
    }
  }
}
