// Probe caches are keyed per baseURL, and two of the three ignore the model.
//
// One long-lived client serves every task, and the model arrives per call
// (`resolveModelForTask` → ingestModel / lintModel / queryModel). So several
// models share one client, one baseURL, and one set of probe caches.
//
// `OutputModeProber` already keys on (baseURL, model) — its own header says
// per-model granularity is REQUIRED, with the LM Studio case where a Qwen
// demotion must not demote gemma on the same gateway. `TokenKeyProber` and
// `ReasoningStripProber` key on baseURL alone, reasoning that "same gateway →
// same wire format". These tests ask whether that holds when two models sit
// behind one gateway.
//
// Expected to FAIL on current main. If they pass, the premise is wrong and the
// whole line of inquiry is void.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { APICallError } from 'ai';

vi.mock('ai', async () => {
  const actual = await vi.importActual<typeof import('ai')>('ai');
  return { ...actual, generateText: vi.fn(), streamText: vi.fn() };
});

vi.mock('@ai-sdk/openai-compatible', async () => {
  const actual = await vi.importActual<typeof import('@ai-sdk/openai-compatible')>('@ai-sdk/openai-compatible');
  return { ...actual, createOpenAICompatible: vi.fn(actual.createOpenAICompatible) };
});

import { generateText } from 'ai';
import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { OpenAICompatSdkClient } from './llm-sdk/openai-compat-sdk-client';

const mockGenerateText = vi.mocked(generateText);
const mockCreateOpenAICompatible = vi.mocked(createOpenAICompatible);

const BASE_URL = 'http://localhost:1234/v1';
const MODEL_A = 'qwen3-30b';   // the one that rejects max_tokens
const MODEL_B = 'gemma-4-26b'; // loaded on the same LM Studio, never probed

function makeResult(text: string): Awaited<ReturnType<typeof generateText>> {
  return {
    text, content: [], reasoning: [], reasoningText: undefined, files: [],
    sources: [], toolCalls: [], toolResults: [], finishReason: 'stop',
    usage: { inputTokens: 10, outputTokens: 20, totalTokens: 30, reasoningTokens: undefined, cachedInputTokens: undefined },
    warnings: [], request: {}, response: {}, providerMetadata: undefined,
    steps: [], totalUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    experimental_providerMetadata: undefined,
  } as unknown as Awaited<ReturnType<typeof generateText>>;
}

function tokenKeyRejection(): APICallError {
  return new APICallError({
    message: "Unrecognized request argument supplied: max_tokens",
    statusCode: 400, responseHeaders: {}, url: BASE_URL, requestBodyValues: {},
    responseBody: '{"error":{"message":"Unrecognized request argument supplied: max_tokens"}}',
  });
}

function reasoningRejection(): APICallError {
  return new APICallError({
    message: "Invalid value for 'reasoning_effort'",
    statusCode: 400, responseHeaders: {}, url: BASE_URL, requestBodyValues: {},
    responseBody: '{"error":{"message":"Invalid value for reasoning_effort"}}',
  });
}

function newClient(): OpenAICompatSdkClient {
  return new OpenAICompatSdkClient({ apiKey: 'unused', baseURL: BASE_URL, provider: 'lmstudio' });
}

/** The body transform the client handed to the SDK on its most recent call. */
function latestTransform(): (args: Record<string, unknown>) => Record<string, unknown> {
  const opts = mockCreateOpenAICompatible.mock.calls.at(-1)![0] as unknown as Record<string, unknown>;
  return opts.transformRequestBody as (a: Record<string, unknown>) => Record<string, unknown>;
}

beforeEach(() => {
  mockGenerateText.mockReset();
  mockCreateOpenAICompatible.mockClear();
});

describe('probe caches across two models on one gateway', () => {
  it('TokenKeyProber: model B must not inherit model A\'s token-key swap', async () => {
    const client = newClient();

    // Model A rejects max_tokens; the retry with max_completion_tokens works.
    mockGenerateText
      .mockRejectedValueOnce(tokenKeyRejection())
      .mockResolvedValueOnce(makeResult('ok'));
    await client.createMessage({
      model: MODEL_A, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }],
    });

    // Model B has never been probed. Its request body must go out untouched.
    mockGenerateText.mockResolvedValueOnce(makeResult('ok'));
    await client.createMessage({
      model: MODEL_B, max_tokens: 100, messages: [{ role: 'user', content: 'hi' }],
    });

    const body = latestTransform()({ model: MODEL_B, max_tokens: 100 });
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.max_tokens).toBe(100);
  });

  it('ReasoningStripProber: model B must not inherit model A\'s reasoning strip', async () => {
    const client = newClient();

    // Model A rejects reasoning_effort; the stripped retry works.
    mockGenerateText
      .mockRejectedValueOnce(reasoningRejection())
      .mockResolvedValueOnce(makeResult('ok'));
    await client.createMessage({
      model: MODEL_A, max_tokens: 100, enableThinking: false,
      messages: [{ role: 'user', content: 'hi' }],
    } as Parameters<typeof client.createMessage>[0]);

    // Model B wants thinking forced off and has never been probed, so the
    // wire field must still be set for it.
    mockGenerateText.mockResolvedValueOnce(makeResult('ok'));
    await client.createMessage({
      model: MODEL_B, max_tokens: 100, enableThinking: false,
      messages: [{ role: 'user', content: 'hi' }],
    } as Parameters<typeof client.createMessage>[0]);

    // Read the prober directly: the wire field is only ever set when
    // shouldStrip is false, so the cache state IS the outcome here.
    const prober = (client as unknown as { reasoningStripProber: {
      shouldStrip(b: string): boolean;
    } }).reasoningStripProber;

    // Guard the setup first: if model A never tripped the strip, the
    // inheritance question was never asked and a green result means nothing.
    expect(prober.shouldStrip(BASE_URL)).toBe(true);

    // The claim: that decision belongs to model A, not to the gateway.
    // There is no per-model query to make — which is itself the finding.
    const lastCall = mockGenerateText.mock.calls.at(-1)![0] as unknown as Record<string, unknown>;
    const providerOptions = (lastCall.providerOptions ?? {}) as Record<string, Record<string, unknown>>;
    // Force-disable rides the same wire key. Stripped for model A means
    // stripped for model B too — the field never reaches the wire.
    expect(providerOptions.lmstudio?.reasoningEffort).toBeDefined();
  });

  it('OutputModeProber keys on the model — the control arm', () => {
    // Not a claim about the two above: this one already separates models, and
    // it is here so a green run proves the harness can tell them apart at all.
    const client = newClient();
    const prober = (client as unknown as { outputModeProber: {
      getMode(b: string, m: string): string;
      markMode(b: string, m: string, mode: string): void;
    } }).outputModeProber;

    prober.markMode(BASE_URL, MODEL_A, 'text_prompt');
    expect(prober.getMode(BASE_URL, MODEL_A)).toBe('text_prompt');
    expect(prober.getMode(BASE_URL, MODEL_B)).toBe('json_schema');
  });
});
