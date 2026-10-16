import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '@/server/ai/anthropic';
import { WritingCheckOutput } from '@/server/ai/outputs';
import { AiError, type AiRequest } from '@/server/ai/types';

/**
 * Провайдер Anthropic через настоящий SDK, но без сети: HTTP подменён. Проверяем разбор
 * ответов, структурированный вывод и перевод ошибок провайдера в понятные коды.
 */
const KEY = 'test-key-not-a-real-secret-000000';
const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_test' } });
const message = (content: string, stop = 'end_turn', model = 'claude-opus-5-5') => ({
  id: 'msg_1',
  type: 'message',
  role: 'assistant',
  model,
  content: [{ type: 'text', text: content }],
  stop_reason: stop,
  stop_sequence: null,
  usage: { input_tokens: 120, output_tokens: 40 },
});

const textRequest: AiRequest = { feature: 'conversation', system: 'sys', messages: [{ role: 'user', content: 'Hello' }], maxOutputTokens: 300, timeoutMs: 5_000 };

function provider(handler: (body: Record<string, unknown>, init: RequestInit) => Response | Promise<Response>) {
  const calls: { body: Record<string, unknown>; headers: Headers }[] = [];
  const fetchFn = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    calls.push({ body, headers: new Headers(init?.headers) });
    return handler(body, init ?? {});
  }) as typeof fetch;
  return { p: new AnthropicProvider(KEY, 'claude-opus-5-5', { fetch: fetchFn, maxRetries: 0 }), calls };
}

const codeOf = async (promise: Promise<unknown>) => {
  try {
    await promise;
    return 'resolved';
  } catch (e) {
    return e instanceof AiError ? e.code : `unexpected: ${String(e)}`;
  }
};

describe('AnthropicProvider', () => {
  it('returns text and usage; sends the model, fallbacks and the system prompt server-side', async () => {
    const { p, calls } = provider(() => json(200, message('Hi! What would you like to order?')));
    const r = await p.complete(textRequest);
    expect(r).toEqual({ output: 'Hi! What would you like to order?', usage: { model: 'claude-opus-5-5', inputTokens: 120, outputTokens: 40 } });
    expect(calls[0]!.body).toMatchObject({ model: 'claude-opus-5-5', max_tokens: 300, system: 'sys', fallbacks: 'default' });
    expect(calls[0]!.headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    // Ключ — только в заголовке запроса сервера, никогда в теле.
    expect(JSON.stringify(calls[0]!.body)).not.toContain(KEY);
  });

  it('parses structured output with the Zod schema', async () => {
    const out = { summary: 'Good', corrections: [{ original: 'I goes', suggestion: 'I go', explanation: 'First person', category: 'grammar' }], strengths: [], uncertainty: '' };
    const { p, calls } = provider(() => json(200, message(JSON.stringify(out))));
    const r = await p.complete({ ...textRequest, feature: 'writing_check', schema: WritingCheckOutput });
    expect(r.output).toEqual(out);
    expect(calls[0]!.body.output_config).toMatchObject({ format: { type: 'json_schema' } });
  });

  it('maps an answer that does not match the schema to ai_invalid_output', async () => {
    const { p } = provider(() => json(200, message(JSON.stringify({ summary: '', corrections: 'nope' }))));
    expect(await codeOf(p.complete({ ...textRequest, schema: WritingCheckOutput }))).toBe('ai_invalid_output');
  });

  it('maps refusals and truncated answers', async () => {
    expect(await codeOf(provider(() => json(200, message('', 'refusal'))).p.complete(textRequest))).toBe('ai_refused');
    expect(await codeOf(provider(() => json(200, message('Half an ans', 'max_tokens'))).p.complete(textRequest))).toBe('ai_invalid_output');
  });

  it('keeps usage on failures after tokens were spent (for the cost ledger)', async () => {
    try {
      await provider(() => json(200, message('', 'refusal'))).p.complete(textRequest);
    } catch (e) {
      expect((e as { usage: unknown }).usage).toEqual({ model: 'claude-opus-5-5', inputTokens: 120, outputTokens: 40 });
    }
  });

  it('maps HTTP errors of the provider to user-safe codes', async () => {
    const err = (status: number, type: string) => () => json(status, { type: 'error', error: { type, message: 'internal detail that must not leak' } });
    expect(await codeOf(provider(err(429, 'rate_limit_error')).p.complete(textRequest))).toBe('ai_rate_limited');
    expect(await codeOf(provider(err(500, 'api_error')).p.complete(textRequest))).toBe('ai_unavailable');
    expect(await codeOf(provider(err(529, 'overloaded_error')).p.complete(textRequest))).toBe('ai_unavailable');
    expect(await codeOf(provider(err(401, 'authentication_error')).p.complete(textRequest))).toBe('ai_unavailable');
    expect(await codeOf(provider(err(400, 'invalid_request_error')).p.complete(textRequest))).toBe('ai_invalid_output');
    try {
      await provider(err(500, 'api_error')).p.complete(textRequest);
    } catch (e) {
      expect((e as Error).message).not.toContain('internal detail');
    }
  });

  it('times out instead of hanging', async () => {
    const { p } = provider(
      (_b, init) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    );
    const started = Date.now();
    expect(await codeOf(p.complete({ ...textRequest, timeoutMs: 100 }))).toBe('ai_timeout');
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  it('network failures are "unavailable"', async () => {
    const { p } = provider(() => {
      throw new TypeError('fetch failed');
    });
    expect(await codeOf(p.complete(textRequest))).toBe('ai_unavailable');
  });
});
