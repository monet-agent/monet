import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';

const PRIMARY_BASE = 'https://api.moonshot.ai/v1';
const FALLBACK_BASE = 'https://api.deepinfra.com/v1/openai';
// kimi-k2.5 is the current Moonshot thinking model and the ONLY variant
// that supports the $-prefixed builtin_function tools (web_search,
// fetch, code_runner, quickjs, memory, date, etc.). If we fall back to
// DeepInfra, builtins won't be executed — the model may still emit the
// tool_calls but nobody's home to run them. That's an acceptable
// degradation for an outage; journal if fallback_used > 0.
const PRIMARY_MODEL = 'kimi-k2.5';
const FALLBACK_MODEL = 'moonshotai/Kimi-K2.5';

function makeClient(useFallback = false): OpenAI {
  return new OpenAI({
    apiKey: useFallback
      ? process.env['KIMI_FALLBACK_KEY']
      : process.env['KIMI_API_KEY'],
    baseURL: useFallback ? FALLBACK_BASE : PRIMARY_BASE,
  });
}

export interface AgentMessage {
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string | null;
  tool_calls?: OpenAI.Chat.Completions.ChatCompletionMessageToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface CallMetrics {
  calls: number;
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
  primary_failures: number;
  fallback_used: number;
}
export const heartbeatMetrics: CallMetrics = {
  calls: 0,
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  primary_failures: 0,
  fallback_used: 0,
};
export function resetHeartbeatMetrics(): void {
  heartbeatMetrics.calls = 0;
  heartbeatMetrics.prompt_tokens = 0;
  heartbeatMetrics.completion_tokens = 0;
  heartbeatMetrics.total_tokens = 0;
  heartbeatMetrics.primary_failures = 0;
  heartbeatMetrics.fallback_used = 0;
}

const PRICE_INPUT_USD_PER_1M = 0.6;
const PRICE_OUTPUT_USD_PER_1M = 2.5;
export function estimateHeartbeatCostUSD(): number {
  return (
    (heartbeatMetrics.prompt_tokens / 1_000_000) * PRICE_INPUT_USD_PER_1M +
    (heartbeatMetrics.completion_tokens / 1_000_000) * PRICE_OUTPUT_USD_PER_1M
  );
}

// Minimal shape of an accumulated streaming tool call. We store
// partials keyed by index and stitch arguments strings as they arrive.
interface PartialToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export async function callLLM(
  messages: ChatCompletionMessageParam[],
  tools: ChatCompletionTool[],
  useFallback = false,
): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const client = makeClient(useFallback);
  const model = useFallback ? FALLBACK_MODEL : PRIMARY_MODEL;

  try {
    // Streaming is required for Kimi Thinking to work correctly per
    // Moonshot docs — reasoning_content is delivered incrementally and
    // long responses can exceed the non-streaming request timeout.
    const stream = await client.chat.completions.create({
      model,
      messages,
      tools: tools.length > 0 ? tools : undefined,
      tool_choice: tools.length > 0 ? 'auto' : undefined,
      temperature: 1.0,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: 16000,
    } as Parameters<typeof client.chat.completions.create>[0]);

    let content = '';
    let reasoning = '';
    let role: 'assistant' = 'assistant';
    let finishReason: OpenAI.Chat.Completions.ChatCompletion.Choice['finish_reason'] | null = null;
    let usage: OpenAI.CompletionUsage | undefined;
    const toolCallsByIndex = new Map<number, PartialToolCall>();
    let id = '';
    let created = 0;
    let modelReported = model;

    // The OpenAI SDK returns an AsyncIterable<ChatCompletionChunk> when
    // stream=true. Iterate, accumulate, reconstruct a ChatCompletion.
    for await (const chunk of stream as unknown as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>) {
      id = id || chunk.id;
      created = created || chunk.created;
      modelReported = chunk.model || modelReported;
      if (chunk.usage) usage = chunk.usage;

      const choice = chunk.choices?.[0];
      if (!choice) continue;
      if (choice.finish_reason) finishReason = choice.finish_reason;

      const delta = choice.delta as OpenAI.Chat.Completions.ChatCompletionChunk.Choice.Delta & {
        reasoning_content?: string;
      };
      if (!delta) continue;

      if (typeof delta.content === 'string') content += delta.content;
      if (typeof delta.reasoning_content === 'string') reasoning += delta.reasoning_content;
      if (delta.role === 'assistant') role = 'assistant';

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0;
          const existing = toolCallsByIndex.get(idx) ?? {
            id: '',
            type: 'function' as const,
            function: { name: '', arguments: '' },
          };
          if (tc.id) existing.id = tc.id;
          if (tc.function?.name) existing.function.name = tc.function.name;
          if (typeof tc.function?.arguments === 'string') {
            existing.function.arguments += tc.function.arguments;
          }
          toolCallsByIndex.set(idx, existing);
        }
      }
    }

    const toolCalls = [...toolCallsByIndex.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, v]) => v);

    const message: OpenAI.Chat.Completions.ChatCompletionMessage = {
      role,
      content: content || null,
      refusal: null,
      ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
    } as OpenAI.Chat.Completions.ChatCompletionMessage;

    // Kimi's reasoning_content must round-trip back into the next
    // request (per Moonshot docs). Hoist it onto the message so
    // downstream code that pushes the message back into `messages`
    // preserves it automatically.
    if (reasoning) {
      (message as unknown as Record<string, unknown>)['reasoning_content'] = reasoning;
    }

    const reconstructed: OpenAI.Chat.Completions.ChatCompletion = {
      id: id || `chatcmpl-${Date.now()}`,
      object: 'chat.completion',
      created: created || Math.floor(Date.now() / 1000),
      model: modelReported,
      choices: [
        {
          index: 0,
          message,
          finish_reason: finishReason ?? 'stop',
          logprobs: null,
        },
      ],
      usage,
    };

    heartbeatMetrics.calls += 1;
    if (useFallback) heartbeatMetrics.fallback_used += 1;
    if (usage) {
      heartbeatMetrics.prompt_tokens += usage.prompt_tokens ?? 0;
      heartbeatMetrics.completion_tokens += usage.completion_tokens ?? 0;
      heartbeatMetrics.total_tokens += usage.total_tokens ?? 0;
    }

    return reconstructed;
  } catch (err) {
    if (!useFallback) {
      heartbeatMetrics.primary_failures += 1;
      console.warn('[agent] Primary LLM failed, trying fallback:', err);
      return callLLM(messages, tools, true);
    }
    throw err;
  }
}
