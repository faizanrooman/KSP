/**
 * Outbound (egress) guard for integration adapters — SSRF protection.
 *
 *  - Production: https only. Other environments: http allowed (local stubs).
 *  - URLs with embedded credentials are rejected (credentials come from `credentials_ref` secrets).
 *  - Destinations resolving to loopback / private / link-local / CGNAT / multicast / reserved / NAT64 ranges are
 *    denied unless explicitly allow-listed by DEPLOYMENT config (env INTEGRATION_EGRESS_ALLOW = comma-separated
 *    hostnames and/or CIDRs). The allow-list is deliberately not editable through the API/DB.
 *  - Cloud metadata endpoints are ALWAYS denied, even if allow-listed.
 *  - DNS is resolved by our own lookup at connect time and every resolved address is checked (defeats DNS
 *    rebinding between validation and connection). Redirects are never followed.
 */
import { isIP } from 'node:net';
import { lookup as dnsLookup, type LookupAddress } from 'node:dns';
import { loadConfig } from '@ksp/core';
import { ipInCidr } from '../plugins/auth.js';
import { IntegrationError } from './types.js';

export interface EgressPolicy {
  production: boolean;
  allowHosts: string[];
  allowCidrs: string[];
}

export function egressPolicy(): EgressPolicy {
  const entries = (process.env.INTEGRATION_EGRESS_ALLOW ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return {
    production: loadConfig().NODE_ENV === 'production',
    allowCidrs: entries.filter((e) => isIP(e.split('/')[0] ?? '') !== 0).map((e) => (e.includes('/') ? e : `${e}/${isIP(e) === 6 ? 128 : 32}`)),
    allowHosts: entries.filter((e) => isIP(e.split('/')[0] ?? '') === 0),
  };
}

const BLOCKED_V4 = [
  '0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8', '169.254.0.0/16', '172.16.0.0/12', '192.0.0.0/24', '192.0.2.0/24',
  '192.88.99.0/24', '192.168.0.0/16', '198.18.0.0/15', '198.51.100.0/24', '203.0.113.0/24', '224.0.0.0/4', '240.0.0.0/4',
];
const ALWAYS_DENIED = new Set(['169.254.169.254', '169.254.170.2', 'fd00:ec2::254', '100.100.100.200']);
const BLOCKED_HOSTNAMES = [/^localhost$/, /\.localhost$/, /^metadata\.google\.internal$/, /^metadata$/, /\.internal$/, /\.local$/];

function expandV6(ip: string): string {
  const [head = '', tail = ''] = ip.toLowerCase().split('::');
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = ip.includes('::') ? Array(Math.max(0, 8 - h.length - t.length)).fill('0') : [];
  return [...h, ...fill, ...t].map((x) => x.padStart(4, '0')).join(':');
}

/** True for addresses an integration must never reach unless allow-listed. */
export function isRestrictedIp(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) return BLOCKED_V4.some((c) => ipInCidr(ip, c));
  if (v === 6) {
    const x = expandV6(ip);
    if (x === '0000:0000:0000:0000:0000:0000:0000:0000' || x === '0000:0000:0000:0000:0000:0000:0000:0001') return true;
    const mapped = ip.toLowerCase().match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isRestrictedIp(mapped[1]!);
    if (x.startsWith('0000:0000:0000:0000:0000:ffff:')) return true; // hex-form mapped v4: deny
    const first = parseInt(x.slice(0, 4), 16);
    if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
    if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
    if ((first & 0xff00) === 0xff00) return true; // multicast
    if (x.startsWith('0064:ff9b:')) return true; // NAT64
    if (x.startsWith('2001:0db8:')) return true; // documentation
    return false;
  }
  return true; // not an IP at all
}

function ipAllowListed(ip: string, policy: EgressPolicy): boolean {
  return policy.allowCidrs.some((c) => (isIP(ip) === 4 && c.includes('.') ? ipInCidr(ip, c) : c.split('/')[0] === ip.toLowerCase()));
}

/** Check one resolved/literal address for a hostname. */
export function assertAddressAllowed(host: string, ip: string, policy: EgressPolicy): void {
  const plain = ip.replace(/^::ffff:(?=\d+\.)/i, '');
  if (ALWAYS_DENIED.has(plain.toLowerCase())) throw new IntegrationError('BLOCKED_DESTINATION', 'Destination address is not permitted (metadata endpoint)');
  if (!isRestrictedIp(ip)) return;
  if (policy.allowHosts.includes(host.toLowerCase()) || ipAllowListed(plain, policy)) return;
  throw new IntegrationError('BLOCKED_DESTINATION', `Destination ${host} resolves to a restricted address range; allow-list it in INTEGRATION_EGRESS_ALLOW if intended`);
}

/** Static validation of a configured base URL (on create/update and before every request). */
export function validateBaseUrl(raw: string, policy: EgressPolicy = egressPolicy()): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new IntegrationError('BLOCKED_DESTINATION', 'Base URL is not a valid URL');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !policy.production)) {
    throw new IntegrationError('BLOCKED_DESTINATION', policy.production ? 'Base URL must use https in production' : 'Base URL must use http or https');
  }
  if (url.username || url.password) throw new IntegrationError('BLOCKED_DESTINATION', 'Base URL must not embed credentials; use credentialsRef');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(host)) {
    assertAddressAllowed(host, host, policy);
  } else if (BLOCKED_HOSTNAMES.some((re) => re.test(host)) && !policy.allowHosts.includes(host)) {
    throw new IntegrationError('BLOCKED_DESTINATION', `Destination host ${host} is not permitted`);
  }
  return url;
}

type LookupCb = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** `lookup` implementation for http(s).request that refuses restricted destinations at connect time. */
export function guardedLookup(policy: EgressPolicy) {
  return (hostname: string, options: { all?: boolean; family?: number } | number, cb: LookupCb) => {
    dnsLookup(hostname, { all: true }, (err, addresses) => {
      if (err) return cb(err, []);
      try {
        for (const a of addresses) assertAddressAllowed(hostname, a.address, policy);
      } catch (e) {
        return cb(e as NodeJS.ErrnoException, []);
      }
      const all = typeof options === 'object' && options.all;
      if (all) return cb(null, addresses);
      const first = addresses[0];
      if (!first) return cb(Object.assign(new Error(`No address for ${hostname}`), { code: 'ENOTFOUND' }), []);
      return cb(null, first.address, first.family);
    });
  };
}
