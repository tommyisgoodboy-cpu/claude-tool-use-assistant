import { isIP } from 'node:net';
import { lookup } from 'node:dns/promises';

// The model chooses the hostname, so the network tools must not become a way to
// probe internal addresses. Only publicly routable targets are allowed.
export function isPublicAddress(ip) {
  const kind = isIP(ip);
  if (kind === 4) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && b === 168) return false;
    if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
    if (a >= 224) return false; // multicast and reserved
    return true;
  }
  if (kind === 6) {
    const v = ip.toLowerCase();
    if (v === '::' || v === '::1') return false;
    if (/^f[cd]/.test(v) || /^fe[89ab]/.test(v)) return false; // unique-local, link-local
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPublicAddress(mapped[1]) : true;
  }
  return false;
}

export async function assertPublicHost(hostname, resolve = lookup) {
  if (isIP(hostname)) {
    if (!isPublicAddress(hostname)) throw new Error(`Refusing to contact non-public address ${hostname}`);
    return;
  }
  let addresses;
  try {
    addresses = await resolve(hostname, { all: true });
  } catch (err) {
    throw new Error(`Cannot resolve ${hostname}: ${err.code ?? err.message}`);
  }
  const blocked = addresses.find((a) => !isPublicAddress(a.address));
  if (blocked) throw new Error(`Refusing to contact ${hostname}: it resolves to non-public address ${blocked.address}`);
}
