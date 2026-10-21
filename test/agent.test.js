import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runAgent } from '../src/agent.js';
import { createMockClient } from '../src/mock-llm.js';
import { createHandlers } from '../src/tools.js';

const scripted = (...responses) => {
  const requests = [];
  return {
    requests,
    messages: { create: async (params) => { requests.push(structuredClone(params)); return responses.shift(); } },
  };
};
const use = (id, name, input) => ({ type: 'tool_use', id, name, input });

test('parallel tool calls come back in ONE user message, in order, with matching ids', async () => {
  const client = scripted(
    { stop_reason: 'tool_use', content: [use('t1', 'lookup_asset', { asset_id: 'LT-1042' }), use('t2', 'check_service_status', { service: 'wifi' })] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] },
  );
  const out = await runAgent({ client, handlers: createHandlers(), userMessage: 'hi' });
  const results = client.requests[1].messages.at(-1);
  assert.equal(results.role, 'user');
  assert.deepEqual(results.content.map((r) => r.tool_use_id), ['t1', 't2']);
  assert.equal(out.text, 'done');
  assert.equal(out.turns, 2);
});

test('a failing or unknown tool becomes is_error, and the loop continues', async () => {
  const client = scripted(
    { stop_reason: 'tool_use', content: [use('t1', 'dns_lookup', { hostname: 'bad host', record_type: 'A' }), use('t2', 'nope', {})] },
    { stop_reason: 'end_turn', content: [{ type: 'text', text: 'explained' }] },
  );
  const out = await runAgent({ client, handlers: createHandlers(), userMessage: 'x' });
  const [a, b] = client.requests[1].messages.at(-1).content;
  assert.equal(a.is_error, true);
  assert.match(b.content, /Unknown tool/);
  assert.equal(out.text, 'explained');
});

test('requests never force tool_choice and always send strict tools', async () => {
  const client = scripted({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }] });
  await runAgent({ client, handlers: createHandlers(), userMessage: 'x', model: 'm' });
  assert.equal(client.requests[0].tool_choice, undefined);
  assert.ok(client.requests[0].tools.every((t) => t.strict));
});

test('refusal, max_tokens and runaway loops are surfaced as errors', async () => {
  await assert.rejects(runAgent({ client: scripted({ stop_reason: 'refusal', content: [] }), handlers: {}, userMessage: 'x' }), /declined/);
  await assert.rejects(runAgent({ client: scripted({ stop_reason: 'max_tokens', content: [] }), handlers: {}, userMessage: 'x' }), /cut off/);
  const looping = { messages: { create: async () => ({ stop_reason: 'tool_use', content: [use('t', 'nope', {})] }) } };
  await assert.rejects(runAgent({ client: looping, handlers: {}, userMessage: 'x', maxTurns: 3 }), /3 turns/);
});

test('mock client: asset + KB + ticket flow, ticket only created when confirmed', async () => {
  const ask = async (confirm) => {
    const { mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const ticketsFile = join(await mkdtemp(join(tmpdir(), 'agent-')), 't.json');
    const handlers = createHandlers({ confirm, ticketsFile });
    return runAgent({ client: createMockClient(), handlers, userMessage: 'Laptop LT-1042 will not join Wi-Fi, please raise a ticket' });
  };
  const yes = await ask(async () => true);
  assert.match(yes.text, /LT-1042 is a ThinkBook/);
  assert.match(yes.text, /KB-001/);
  assert.match(yes.text, /Ticket TKT-0001 created/);
  const no = await ask(async () => false);
  assert.match(no.text, /create_ticket failed: The user declined/);
});
