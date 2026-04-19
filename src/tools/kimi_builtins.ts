// Moonshot-hosted builtin tools for Kimi K2.5.
//
// Pattern (per platform.kimi.ai/docs/guide/use-web-search):
//   1. Declare each tool as {type: "builtin_function", function: {name: "$name"}}.
//   2. When the model emits a tool_call for one of these, the client MUST
//      echo tool_call.function.arguments back as the tool message content.
//      Moonshot then executes the tool server-side and resumes generation.
//
// We do NOT implement the execution — that's what "builtin" means. Our
// dispatcher just returns the arguments verbatim so Moonshot can pick up
// the call. See dispatchKimiBuiltin() below.
//
// Scoping: the builtins run inside Moonshot's infra with Moonshot's
// network posture — independent of our Fly egress allowlist. Output still
// flows through the thinking stream into our context, so apply normal
// quarantine discipline for anything you cite downstream.

// The OpenAI SDK's ChatCompletionTool type doesn't know about
// builtin_function, so we erase the type before exporting.
type BuiltinTool = { type: 'builtin_function'; function: { name: string } };

// ONLY tools that Moonshot accepts as builtin_function go here.
// Anything unverified gets a 400 "unexpected builtin function: $x" that
// fails the whole request — there's no per-tool skipping on their end.
//
// Verified so far: $web_search (dedicated doc page at
// platform.kimi.ai/docs/guide/use-web-search). Add others one at a
// time after confirming they return 200.
const BUILTIN_NAMES = [
  '$web_search',
] as const;

export type KimiBuiltinName = (typeof BUILTIN_NAMES)[number];

const builtinTools: BuiltinTool[] = BUILTIN_NAMES.map((name) => ({
  type: 'builtin_function',
  function: { name },
}));

// Cast to the OpenAI tool type for merging into ALL_TOOLS. The server
// accepts the builtin_function type even though the SDK types only
// describe "function".
export const kimiBuiltinTools = builtinTools as unknown as import('openai/resources/chat/completions.js').ChatCompletionTool[];

export function isKimiBuiltin(name: string): boolean {
  return name.startsWith('$');
}

// Echo pattern: return the model-supplied arguments verbatim so Moonshot
// can execute the builtin server-side on the next turn.
export function dispatchKimiBuiltin(rawArgs: string): string {
  return rawArgs;
}
