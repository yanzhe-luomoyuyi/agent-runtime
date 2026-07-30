import { describe, expect, it } from 'vitest';

import { parseOpenAIChatStream } from '../src/model/openai-compatible.js';

function sseBody(chunks: unknown[]): ReadableStream<Uint8Array> {
  const text =
    chunks.map((c) => `data: ${typeof c === 'string' ? c : JSON.stringify(c)}`).join('\n\n') +
    '\n\ndata: [DONE]\n\n';
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      controller.close();
    },
  });
}

describe('parseOpenAIChatStream', () => {
  it('yields content tokens then a final stop chunk', async () => {
    const body = sseBody([
      { choices: [{ delta: { content: 'Hel' } }] },
      { choices: [{ delta: { content: 'lo' }, finish_reason: 'stop' }] },
      { usage: { prompt_tokens: 3, completion_tokens: 2 } },
    ]);
    const out = [];
    for await (const chunk of parseOpenAIChatStream(body)) out.push(chunk);

    expect(out.filter((c) => 'content' in c && c.content)).toEqual([
      { content: 'Hel' },
      { content: 'lo' },
    ]);
    const final = out[out.length - 1];
    expect(final).toMatchObject({
      stopReason: 'stop',
      usage: { promptTokens: 3, completionTokens: 2 },
    });
  });

  it('assembles incremental tool_calls into completed toolCall chunks', async () => {
    const body = sseBody([
      {
        choices: [
          {
            delta: {
              tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '' } }],
            },
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '{"path":' } }] },
          },
        ],
      },
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] },
            finish_reason: 'tool_calls',
          },
        ],
      },
    ]);
    const out = [];
    for await (const chunk of parseOpenAIChatStream(body)) out.push(chunk);

    const tool = out.find((c) => 'toolCall' in c && c.toolCall);
    expect(tool).toEqual({
      toolCall: { id: 'c1', name: 'read_file', arguments: { path: 'a.ts' } },
    });
    expect(out[out.length - 1]).toMatchObject({ stopReason: 'tool_calls' });
  });

  it('yields reasoning_content as thinking tokens', async () => {
    const body = sseBody([
      { choices: [{ delta: { reasoning_content: 'think ' } }] },
      { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] },
    ]);
    const out = [];
    for await (const chunk of parseOpenAIChatStream(body)) out.push(chunk);
    expect(out[0]).toEqual({ thinking: 'think ' });
    expect(out[1]).toEqual({ content: 'ok' });
  });

  it('accepts delta.reasoning as thinking tokens', async () => {
    const body = sseBody([
      { choices: [{ delta: { reasoning: 'plan' } }] },
      { choices: [{ delta: { content: 'done' }, finish_reason: 'stop' }] },
    ]);
    const out = [];
    for await (const chunk of parseOpenAIChatStream(body)) out.push(chunk);
    expect(out[0]).toEqual({ thinking: 'plan' });
  });
});
