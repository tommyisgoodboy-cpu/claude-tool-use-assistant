import { readFile, writeFile } from 'node:fs/promises';
import { Resolver } from 'node:dns/promises';
import { fileURLToPath } from 'node:url';
import { assertPublicHost } from './net-safety.js';

const dataPath = (name) => fileURLToPath(new URL(`./data/${name}`, import.meta.url));
const loadJson = async (name) => JSON.parse(await readFile(dataPath(name), 'utf8'));

export const SERVICES = ['vpn', 'email', 'wifi', 'file-share', 'ticketing'];
export const RECORD_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];
export const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];
const HOSTNAME = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const MAX_REDIRECTS = 3;
const HTTP_TIMEOUT_MS = 5000;

const strictTool = (name, description, properties) => ({
  name,
  description,
  strict: true,
  input_schema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false },
});

// Read-only tools run freely. create_ticket writes, so the handler asks a human first.
export const TOOLS = [
  strictTool('lookup_asset', 'Look up an asset record (laptop, printer, switch) by its asset ID, e.g. LT-1042.', {
    asset_id: { type: 'string', description: 'Asset ID in the form AA-0000.' },
  }),
  strictTool('search_kb', 'Search the internal knowledge base for troubleshooting steps. Returns up to 3 articles.', {
    query: { type: 'string', description: 'Short keyword query, e.g. "wifi certificate".' },
  }),
  strictTool('check_service_status', 'Get the current status of an internal service.', {
    service: { type: 'string', enum: SERVICES },
  }),
  strictTool('dns_lookup', 'Resolve a public hostname with a live DNS query and return the records.', {
    hostname: { type: 'string', description: 'Public hostname, e.g. example.org.' },
    record_type: { type: 'string', enum: RECORD_TYPES },
  }),
  strictTool('http_check', 'Request a public http(s) URL and report status code, redirect chain and response time.', {
    url: { type: 'string', description: 'Full URL including http:// or https://.' },
  }),
  strictTool('create_ticket', 'Create a helpdesk ticket. Requires human confirmation. Use an empty string for asset_id when no asset applies.', {
    title: { type: 'string', description: 'Short ticket title.' },
    description: { type: 'string', description: 'What is wrong and what has already been checked.' },
    priority: { type: 'string', enum: PRIORITIES },
    asset_id: { type: 'string' },
  }),
];

export function createHandlers({
  confirm = async () => false,
  ticketsFile = dataPath('tickets.json'),
  resolver = new Resolver({ timeout: 3000, tries: 1 }),
  fetchImpl = fetch,
  assertPublic = assertPublicHost,
} = {}) {
  return {
    async lookup_asset({ asset_id }) {
      const asset = (await loadJson('assets.json')).find((a) => a.asset_id.toLowerCase() === asset_id.trim().toLowerCase());
      return asset ?? { found: false, asset_id };
    },

    async search_kb({ query }) {
      const words = query.toLowerCase().split(/\W+/).filter(Boolean);
      const scored = (await loadJson('kb.json'))
        .map((a) => {
          const haystack = `${a.title} ${a.tags.join(' ')}`.toLowerCase();
          return { article: a, score: words.filter((w) => haystack.includes(w)).length };
        })
        .filter((r) => r.score > 0)
        .sort((x, y) => y.score - x.score)
        .slice(0, 3);
      return { matches: scored.map((r) => r.article) };
    },

    async check_service_status({ service }) {
      const entry = (await loadJson('services.json')).find((s) => s.service === service);
      if (!entry) throw new Error(`Unknown service: ${service}`);
      return entry;
    },

    async dns_lookup({ hostname, record_type }) {
      if (!HOSTNAME.test(hostname)) throw new Error(`Not a valid hostname: ${hostname}`);
      if (!RECORD_TYPES.includes(record_type)) throw new Error(`Unsupported record type: ${record_type}`);
      try {
        const records = await resolver.resolve(hostname, record_type);
        return { hostname, record_type, records };
      } catch (err) {
        // NXDOMAIN and "no data" are answers, not tool failures.
        if (['ENOTFOUND', 'ENODATA'].includes(err.code)) return { hostname, record_type, records: [], dns_error: err.code };
        throw new Error(`DNS query failed: ${err.code ?? err.message}`);
      }
    },

    async http_check({ url }) {
      let current = new URL(url);
      const chain = [];
      const started = performance.now();
      for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
        if (!['http:', 'https:'].includes(current.protocol)) throw new Error(`Only http and https are allowed: ${current.protocol}`);
        await assertPublic(current.hostname);
        const res = await fetchImpl(current, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
        await res.body?.cancel();
        chain.push({ url: current.href, status: res.status });
        const location = res.headers.get('location');
        if (res.status >= 300 && res.status < 400 && location) {
          current = new URL(location, current);
          continue;
        }
        return {
          final_url: current.href,
          status: res.status,
          redirects: chain.length - 1,
          chain,
          elapsed_ms: Math.round(performance.now() - started),
          server: res.headers.get('server'),
          content_type: res.headers.get('content-type'),
        };
      }
      throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
    },

    async create_ticket(input) {
      const approved = await confirm(input);
      if (!approved) throw new Error('The user declined to create this ticket. Do not retry; tell them it was not created.');
      let tickets = [];
      try {
        tickets = JSON.parse(await readFile(ticketsFile, 'utf8'));
      } catch (err) {
        if (err.code !== 'ENOENT') throw err;
      }
      const ticket = { id: `TKT-${String(tickets.length + 1).padStart(4, '0')}`, created_at: new Date().toISOString(), ...input, asset_id: input.asset_id || null };
      tickets.push(ticket);
      await writeFile(ticketsFile, JSON.stringify(tickets, null, 2));
      return ticket;
    },
  };
}
