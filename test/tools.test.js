import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHandlers, TOOLS } from '../src/tools.js';
import { assertPublicHost, isPublicAddress } from '../src/net-safety.js';

const tmpTickets = async () => join(await mkdtemp(join(tmpdir(), 'tickets-')), 'tickets.json');

test('every tool is strict, closed, and requires all of its properties', () => {
  for (const t of TOOLS) {
    assert.equal(t.strict, true, t.name);
    assert.equal(t.input_schema.additionalProperties, false, t.name);
    assert.deepEqual(t.input_schema.required.sort(), Object.keys(t.input_schema.properties).sort(), t.name);
  }
});

test('lookup_asset is case-insensitive and reports misses', async () => {
  const h = createHandlers();
  assert.equal((await h.lookup_asset({ asset_id: 'lt-1042' })).owner, 'Alex Chan');
  assert.deepEqual(await h.lookup_asset({ asset_id: 'ZZ-9999' }), { found: false, asset_id: 'ZZ-9999' });
});

test('search_kb ranks the Wi-Fi article first', async () => {
  const { matches } = await createHandlers().search_kb({ query: 'laptop wifi certificate' });
  assert.equal(matches[0].id, 'KB-001');
});

test('create_ticket writes only after confirmation', async () => {
  const ticketsFile = await tmpTickets();
  const input = { title: 'Wi-Fi down', description: 'x', priority: 'P3', asset_id: '' };

  const denied = createHandlers({ ticketsFile, confirm: async () => false });
  await assert.rejects(denied.create_ticket(input), /declined/);
  await assert.rejects(readFile(ticketsFile), { code: 'ENOENT' });

  const approved = createHandlers({ ticketsFile, confirm: async () => true });
  const ticket = await approved.create_ticket(input);
  assert.equal(ticket.id, 'TKT-0001');
  assert.equal(ticket.asset_id, null);
  assert.equal(JSON.parse(await readFile(ticketsFile, 'utf8')).length, 1);
});

test('dns_lookup validates input and treats NXDOMAIN as an answer', async () => {
  const h = createHandlers({ resolver: { resolve: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } } });
  assert.deepEqual(await h.dns_lookup({ hostname: 'nope.example.org', record_type: 'A' }), { hostname: 'nope.example.org', record_type: 'A', records: [], dns_error: 'ENOTFOUND' });
  await assert.rejects(h.dns_lookup({ hostname: 'bad host!', record_type: 'A' }), /valid hostname/);
});

test('http_check follows redirects, re-checks every hop, and stops at the limit', async () => {
  const seen = [];
  const redirectTo = (loc) => ({ status: 302, headers: new Headers({ location: loc }), body: null });
  const fetchImpl = async (url) => {
    seen.push(url.href);
    return url.pathname === '/final' ? { status: 200, headers: new Headers({ server: 'test' }), body: null } : redirectTo('/final');
  };
  const checked = [];
  const h = createHandlers({ fetchImpl, assertPublic: async (host) => { checked.push(host); } });
  const out = await h.http_check({ url: 'https://example.org/start' });
  assert.equal(out.status, 200);
  assert.equal(out.redirects, 1);
  assert.equal(checked.length, 2);

  const loop = createHandlers({ fetchImpl: async () => redirectTo('/again'), assertPublic: async () => {} });
  await assert.rejects(loop.http_check({ url: 'https://example.org/' }), /Too many redirects/);
});

test('http_check refuses non-http schemes and private targets', async () => {
  const h = createHandlers({ fetchImpl: async () => { throw new Error('must not be called'); } });
  await assert.rejects(h.http_check({ url: 'file:///etc/passwd' }), /Only http/);
  await assert.rejects(h.http_check({ url: 'http://127.0.0.1:8080/' }), /non-public/);
  await assert.rejects(h.http_check({ url: 'http://192.168.1.1/' }), /non-public/);
});

test('isPublicAddress / assertPublicHost', async () => {
  for (const ip of ['10.0.0.1', '172.20.1.1', '192.168.0.9', '127.0.0.1', '169.254.1.1', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) assert.equal(isPublicAddress(ip), true, ip);
  await assert.rejects(assertPublicHost('internal.example', async () => [{ address: '10.1.2.3' }]), /non-public/);
  await assertPublicHost('ok.example', async () => [{ address: '93.184.216.34' }]);
});
