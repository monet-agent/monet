// Base mainnet wallet for monet via Coinbase CDP Server Wallet v2.
//
// First use lazy-creates a CDP-managed EVM account on Base mainnet and
// persists its address to /data/memory/wallet.json so we re-use the same
// wallet across heartbeats. Private key material never touches this
// container — CDP holds the MPC shares.
//
// Tools exposed to monet:
//   - wallet_address(): returns the Base address
//   - wallet_balance(): returns native ETH + USDC balances
//   - wallet_send_usdc(to, amount_usdc): send USDC transfer on Base
//
// Guardrails: wallet_send_usdc enforces a per-call cap and a daily cap
// tracked in /data/memory/wallet_state.json. Spend caps are deliberately
// conservative — monet has to come ask for a bigger cap once it proves it
// can earn. Every send appends to the ledger as a spend entry.

import fs from 'fs';
import path from 'path';
import { CdpClient } from '@coinbase/cdp-sdk';
import { ledgerAppend } from './ledger.js';

const DATA_DIR = () => process.env['DATA_DIR'] ?? '/data';
const WALLET_PATH = () => path.join(DATA_DIR(), 'memory/wallet.json');
const WALLET_STATE_PATH = () => path.join(DATA_DIR(), 'memory/wallet_state.json');

const NETWORK = 'base' as const;
const USDC_BASE_MAINNET = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const PER_SEND_CAP_USDC = 5;
const DAILY_SEND_CAP_USDC = 20;

interface WalletRecord {
  account_name: string;
  address: string;
  created_at: string;
  network: 'base';
}

interface WalletDailyState {
  day_utc: string; // YYYY-MM-DD
  sent_usdc_today: number;
}

function getClient(): CdpClient {
  const apiKeyId = process.env['CDP_API_KEY_ID'];
  const apiKeySecret = process.env['CDP_API_KEY_SECRET'];
  const walletSecret = process.env['CDP_WALLET_SECRET'];
  if (!apiKeyId || !apiKeySecret || !walletSecret) {
    throw new Error(
      'CDP credentials not set. Need CDP_API_KEY_ID, CDP_API_KEY_SECRET, CDP_WALLET_SECRET in fly secrets.',
    );
  }
  return new CdpClient({ apiKeyId, apiKeySecret, walletSecret });
}

function readWalletRecord(): WalletRecord | null {
  if (!fs.existsSync(WALLET_PATH())) return null;
  try {
    return JSON.parse(fs.readFileSync(WALLET_PATH(), 'utf8')) as WalletRecord;
  } catch {
    return null;
  }
}

function writeWalletRecord(rec: WalletRecord): void {
  fs.mkdirSync(path.dirname(WALLET_PATH()), { recursive: true });
  fs.writeFileSync(WALLET_PATH(), JSON.stringify(rec, null, 2), 'utf8');
}

function readDailyState(): WalletDailyState {
  const today = new Date().toISOString().slice(0, 10);
  if (!fs.existsSync(WALLET_STATE_PATH())) return { day_utc: today, sent_usdc_today: 0 };
  try {
    const s = JSON.parse(fs.readFileSync(WALLET_STATE_PATH(), 'utf8')) as WalletDailyState;
    if (s.day_utc !== today) return { day_utc: today, sent_usdc_today: 0 };
    return s;
  } catch {
    return { day_utc: today, sent_usdc_today: 0 };
  }
}

function writeDailyState(s: WalletDailyState): void {
  fs.mkdirSync(path.dirname(WALLET_STATE_PATH()), { recursive: true });
  fs.writeFileSync(WALLET_STATE_PATH(), JSON.stringify(s, null, 2), 'utf8');
}

async function ensureAccount(): Promise<{ client: CdpClient; record: WalletRecord }> {
  const client = getClient();
  const existing = readWalletRecord();
  if (existing) {
    return { client, record: existing };
  }
  // First-time bootstrap: create a named CDP EVM account. The account name
  // is an idempotency key CDP uses — if the container ever loses
  // wallet.json, recreating with the same name returns the same account.
  const accountName = 'monet-primary';
  const account = await client.evm.createAccount({ name: accountName });
  const record: WalletRecord = {
    account_name: accountName,
    address: account.address,
    created_at: new Date().toISOString(),
    network: NETWORK,
  };
  writeWalletRecord(record);
  return { client, record };
}

export async function walletAddress(): Promise<{ address: string; network: string; created_at: string }> {
  const { record } = await ensureAccount();
  return { address: record.address, network: record.network, created_at: record.created_at };
}

export async function walletBalance(): Promise<{
  address: string;
  network: string;
  balances: Array<{ token: string; contract?: string; amount: string; decimals: number }>;
}> {
  const { client, record } = await ensureAccount();
  const account = await client.evm.getAccount({ name: record.account_name });
  const resp = await account.listTokenBalances({ network: NETWORK });
  const balances = (resp.balances ?? []).map((b: {
    token: { symbol?: string; contractAddress?: string; decimals?: number };
    amount: { amount: bigint; decimals: number };
  }) => ({
    token: b.token.symbol ?? 'unknown',
    contract: b.token.contractAddress,
    amount: b.amount.amount.toString(),
    decimals: b.amount.decimals,
  }));
  return { address: record.address, network: record.network, balances };
}

export async function walletSendUsdc(to: string, amountUsdc: number): Promise<{
  tx_hash: string;
  to: string;
  amount_usdc: number;
  daily_used_usdc: number;
}> {
  if (!/^0x[a-fA-F0-9]{40}$/.test(to)) {
    throw new Error(`wallet_send_usdc: "to" must be a 0x-prefixed 40-hex EVM address. got: ${to}`);
  }
  if (typeof amountUsdc !== 'number' || !isFinite(amountUsdc) || amountUsdc <= 0) {
    throw new Error('wallet_send_usdc: amount_usdc must be a positive number');
  }
  if (amountUsdc > PER_SEND_CAP_USDC) {
    throw new Error(`wallet_send_usdc: ${amountUsdc} USDC exceeds per-send cap of ${PER_SEND_CAP_USDC}. File a DECISIONS.md proposal to raise.`);
  }
  const state = readDailyState();
  if (state.sent_usdc_today + amountUsdc > DAILY_SEND_CAP_USDC) {
    throw new Error(
      `wallet_send_usdc: would exceed daily cap. sent today=${state.sent_usdc_today} + ${amountUsdc} > ${DAILY_SEND_CAP_USDC} USDC.`,
    );
  }

  const { client, record } = await ensureAccount();
  const account = await client.evm.getAccount({ name: record.account_name });

  // USDC on Base mainnet has 6 decimals.
  const amountBaseUnits = BigInt(Math.round(amountUsdc * 1_000_000));
  const result = await account.transfer({
    to: to as `0x${string}`,
    amount: amountBaseUnits,
    token: 'usdc',
    network: NETWORK,
  });
  const txHash = (result as { transactionHash?: string }).transactionHash ?? '';

  state.sent_usdc_today += amountUsdc;
  writeDailyState(state);

  try {
    // Rough USDC→CAD: 1 USDC ≈ 1 USD ≈ 1.37 CAD. Good enough for budget tracking.
    const amountCad = -(amountUsdc * 1.37);
    ledgerAppend({
      ts: new Date().toISOString(),
      type: 'spend',
      category: 'onchain_usdc_send',
      amount_cad: amountCad,
      points_delta: 0,
      description: `USDC transfer ${amountUsdc} to ${to} on Base`,
      verification: { type: 'onchain', ref: txHash, source: 'base' },
    });
  } catch (err) {
    console.warn('[wallet] ledger append failed on send (tx still sent):', err);
  }

  return { tx_hash: txHash, to, amount_usdc: amountUsdc, daily_used_usdc: state.sent_usdc_today };
}

const BASE_RPC = 'https://mainnet.base.org';
const USDC_TRANSFER_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BLOCKS_PER_HOUR = 1800;

interface WalletIncomingState {
  last_incoming_block: number;
}

function readIncomingState(): WalletIncomingState | null {
  if (!fs.existsSync(WALLET_STATE_PATH())) return null;
  try {
    const s = JSON.parse(fs.readFileSync(WALLET_STATE_PATH(), 'utf8')) as WalletDailyState & WalletIncomingState;
    if (typeof s.last_incoming_block === 'number') return { last_incoming_block: s.last_incoming_block };
    return null;
  } catch {
    return null;
  }
}

function writeIncomingState(block: number): void {
  let existing: Record<string, unknown> = {};
  if (fs.existsSync(WALLET_STATE_PATH())) {
    try {
      existing = JSON.parse(fs.readFileSync(WALLET_STATE_PATH(), 'utf8')) as Record<string, unknown>;
    } catch { /* ignore */ }
  }
  existing['last_incoming_block'] = block;
  fs.mkdirSync(path.dirname(WALLET_STATE_PATH()), { recursive: true });
  fs.writeFileSync(WALLET_STATE_PATH(), JSON.stringify(existing, null, 2), 'utf8');
}

async function baseRpc(method: string, params: unknown[]): Promise<unknown> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await fetch(BASE_RPC, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Base RPC HTTP ${res.status}`);
    const j = (await res.json()) as { result?: unknown; error?: { message?: string } };
    if (j.error) throw new Error(`Base RPC error: ${j.error.message ?? JSON.stringify(j.error)}`);
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

export async function walletCheckIncoming(sinceHours: number = 48): Promise<{
  payments: Array<{ tx_hash: string; from: string; amount_usdc: number; block_number: number }>;
  new_count: number;
  checked_to_block: number;
}> {
  const { record } = await ensureAccount();
  const monetAddress = record.address.toLowerCase();

  const latestHex = (await baseRpc('eth_blockNumber', [])) as string;
  const latestBlock = parseInt(latestHex, 16);

  const incomingState = readIncomingState();
  const fromBlock = incomingState
    ? incomingState.last_incoming_block
    : Math.max(0, latestBlock - Math.ceil(sinceHours * BLOCKS_PER_HOUR));

  const paddedAddress = '0x000000000000000000000000' + monetAddress.slice(2);
  const logs = (await baseRpc('eth_getLogs', [
    {
      address: USDC_BASE_MAINNET,
      topics: [USDC_TRANSFER_TOPIC, null, paddedAddress],
      fromBlock: '0x' + fromBlock.toString(16),
      toBlock: '0x' + latestBlock.toString(16),
    },
  ])) as Array<{ transactionHash: string; topics: string[]; data: string; blockNumber: string }>;

  const payments = logs.map((log) => ({
    tx_hash: log.transactionHash,
    from: '0x' + log.topics[1]!.slice(26),
    amount_usdc: Number(BigInt(log.data)) / 1_000_000,
    block_number: parseInt(log.blockNumber, 16),
  }));

  writeIncomingState(latestBlock + 1);

  return { payments, new_count: payments.length, checked_to_block: latestBlock };
}

export const walletTools = [
  {
    type: 'function' as const,
    function: {
      name: 'wallet_address',
      description:
        'Return monet\'s Base mainnet wallet address. Creates the wallet on first call via Coinbase CDP (MPC-custodied — no private key lives on this container). Safe to share publicly; this is where customers send USDC.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'wallet_balance',
      description:
        'Return current token balances for monet\'s Base wallet. Includes native ETH (for gas) and USDC. Use before proposing to receive payment so you know if you have gas to transact.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'wallet_check_incoming',
      description:
        'Check Base mainnet for incoming USDC transfers to monet\'s address since last call. Returns tx_hash for each payment — use as verification.ref when logging revenue_received. Call at the start of each heartbeat after inbox check. No new secrets needed — uses the public Base JSON-RPC endpoint.',
      parameters: {
        type: 'object',
        properties: {
          since_hours: {
            type: 'number',
            description: 'On first call (no saved checkpoint), how many hours back to scan. Default 48.',
          },
        },
        required: [],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'wallet_send_usdc',
      description:
        `Send USDC to an EVM address on Base mainnet. Per-send cap: ${PER_SEND_CAP_USDC} USDC. Daily cap: ${DAILY_SEND_CAP_USDC} USDC. Every send is auto-logged as a ledger spend entry. Use ONLY for: (a) refunding a customer, (b) paying another agent for a verified service, (c) on-chain operations Damian has greenlit. Do NOT use to move funds to personal addresses without explicit approval in inbox.md or DECISIONS.md.`,
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient 0x-prefixed EVM address.' },
          amount_usdc: { type: 'number', description: 'USDC amount (human units, not base units). Max 5 per send.' },
        },
        required: ['to', 'amount_usdc'],
      },
    },
  },
];
