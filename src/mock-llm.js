// Offline stand-in for the Messages API so the loop, tools and confirmation flow can be
// demoed without a key. It plans from keywords and summarises tool results; it is not a model.
import { SERVICES } from './tools.js';

let counter = 0;
const toolUse = (name, input) => ({ type: 'tool_use', id: `mock_toolu_${++counter}`, name, input });

function plan(text) {
  const calls = [];
  const asset = text.match(/\b([A-Z]{2}-\d{4})\b/);
  if (asset) calls.push(toolUse('lookup_asset', { asset_id: asset[1] }));

  const host = text.match(/\b((?:[a-z0-9-]+\.)+[a-z]{2,})\b/i)?.[1];
  if (host && /\b(dns|resolve|record)/i.test(text)) calls.push(toolUse('dns_lookup', { hostname: host, record_type: 'A' }));
  if (host && /\b(http|reachable|up|status code|website)\b/i.test(text)) calls.push(toolUse('http_check', { url: `https://${host}` }));

  const service = SERVICES.find((s) => new RegExp(`\\b${s.replace('-', '[- ]')}\\b`, 'i').test(text));
  if (service && /(status|outage|down|working|issue)/i.test(text)) calls.push(toolUse('check_service_status', { service }));

  if (/(how do i|how to|wi-?fi|password|printer|vpn|reset)/i.test(text)) calls.push(toolUse('search_kb', { query: text.replace(/[^\w\s-]/g, ' ').slice(0, 80) }));

  if (/(raise|create|open|log|file) (a |an )?ticket/i.test(text)) {
    calls.push(toolUse('create_ticket', {
      title: text.replace(/\s+/g, ' ').slice(0, 80),
      description: `Reported via assistant: ${text}`,
      priority: 'P3',
      asset_id: asset ? asset[1] : '',
    }));
  }
  return calls;
}

function summarise(name, content, isError) {
  if (isError) return `${name} failed: ${content}`;
  const data = JSON.parse(content);
  switch (name) {
    case 'lookup_asset': return data.found === false ? `No asset record for ${data.asset_id}.` : `${data.asset_id} is a ${data.model} (${data.os}) owned by ${data.owner}, last seen ${data.last_seen}.`;
    case 'search_kb': return data.matches.length ? `Knowledge base: ${data.matches.map((m) => `${m.id} "${m.title}" – first step: ${m.steps[0]}`).join('; ')}` : 'No matching knowledge base article.';
    case 'check_service_status': return `${data.service} is ${data.status}. ${data.note}`;
    case 'dns_lookup': return data.records.length ? `${data.hostname} ${data.record_type}: ${JSON.stringify(data.records)}.` : `${data.hostname} has no ${data.record_type} records (${data.dns_error ?? 'empty answer'}).`;
    case 'http_check': return `${data.final_url} answered ${data.status} in ${data.elapsed_ms} ms after ${data.redirects} redirect(s).`;
    case 'create_ticket': return `Ticket ${data.id} created: "${data.title}" (${data.priority}).`;
    default: return `${name}: ${content}`;
  }
}

export function createMockClient() {
  return {
    messages: {
      async create({ messages }) {
        const last = messages.at(-1);
        if (Array.isArray(last.content)) {
          const names = new Map(messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.type === 'tool_use').map((b) => [b.id, b.name]));
          const lines = last.content.map((r) => `- ${summarise(names.get(r.tool_use_id), r.content, r.is_error)}`);
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: `Here is what I found:\n${lines.join('\n')}` }] };
        }
        const calls = plan(last.content);
        if (calls.length === 0) {
          return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'I can look up assets (e.g. LT-1042), search the knowledge base, check service status, run DNS and HTTP checks, and raise tickets. What do you need?' }] };
        }
        return { stop_reason: 'tool_use', content: [{ type: 'text', text: 'Let me check that.' }, ...calls] };
      },
    },
  };
}
