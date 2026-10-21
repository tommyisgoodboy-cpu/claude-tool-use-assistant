#!/usr/bin/env node
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { DEFAULT_MODEL, runAgent } from './agent.js';
import { createMockClient } from './mock-llm.js';
import { createHandlers } from './tools.js';

const { values } = parseArgs({
  options: {
    mock: { type: 'boolean', default: false },
    yes: { type: 'boolean', default: false },
    ask: { type: 'string' },
  },
});

const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const rl = createInterface({ input: process.stdin, output: process.stdout });

async function makeClient() {
  if (values.mock || !process.env.ANTHROPIC_API_KEY) {
    console.log(dim('Mock mode: scripted model, no API calls. Set ANTHROPIC_API_KEY to use Claude.'));
    return createMockClient();
  }
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  return new Anthropic();
}

// Human-in-the-loop gate for the one tool that writes.
async function confirm(ticket) {
  console.log(`\nThe assistant wants to create a ticket:\n${JSON.stringify(ticket, null, 2)}`);
  if (values.yes) return true;
  if (!process.stdin.isTTY && values.ask) return false;
  const answer = await rl.question('Create it? [y/N] ');
  return /^y(es)?$/i.test(answer.trim());
}

const client = await makeClient();
const handlers = createHandlers({ confirm });
const model = process.env.ANTHROPIC_MODEL || DEFAULT_MODEL;
let history = [];

async function ask(text) {
  const result = await runAgent({
    client, handlers, model, history, userMessage: text,
    onToolCall: (call) => console.log(dim(`→ ${call.name} ${JSON.stringify(call.input)}`)),
  });
  history = result.messages;
  console.log(`\n${result.text}\n`);
}

try {
  if (values.ask) {
    await ask(values.ask);
  } else {
    console.log('IT support assistant. Ctrl+C to exit.\n');
    for (;;) {
      const text = (await rl.question('you> ')).trim();
      if (text) await ask(text);
    }
  }
} catch (err) {
  if (err.code !== 'ABORT_ERR') console.error(`Error: ${err.message}`);
  process.exitCode = 1;
} finally {
  rl.close();
}
