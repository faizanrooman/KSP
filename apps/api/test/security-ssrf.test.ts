/**
 * SSRF: integration base_url validation and connect-time address checks (apps/api/src/integrations/egress.ts).
 * Every listed destination must be refused in a non-production policy with an empty allow-list.
 */
import { describe, expect, it } from 'vitest';
import { guardedLookup, isRestrictedIp, validateBaseUrl, type EgressPolicy } from '../src/integrations/egress.js';

const dev: EgressPolicy = { production: false, allowHosts: [], allowCidrs: [] };
const prod: EgressPolicy = { production: true, allowHosts: [], allowCidrs: [] };

describe('SSRF: base URL validation', () => {
  it.each([
    'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://0177.0.0.1/', 'http://127.1/', 'http://0/',
    'http://[::1]/', 'http://[0:0:0:0:0:0:0:1]/', 'http://[::ffff:127.0.0.1]/', 'http://[::ffff:7f00:1]/',
    'http://[::127.0.0.1]/', 'http://[::a00:1]/', // IPv4-compatible IPv6 (deprecated ::/96)
    'http://169.254.169.254/latest/meta-data/', 'http://[fd00:ec2::254]/', 'http://100.100.100.200/',
    'http://10.0.0.1/', 'http://192.168.1.1/', 'http://172.31.255.255/', 'http://[fe80::1]/', 'http://[fc00::1]/',
    'http://localhost/', 'http://api.localhost/', 'http://metadata.google.internal/', 'http://printer.local/',
    'file:///etc/passwd', 'gopher://example.org/', 'ftp://example.org/', 'dict://example.org/', 'ldap://example.org/',
    'http://user:pw@example.org/', 'javascript:alert(1)', 'not a url',
  ])('refuses %s', (url) => {
    expect(() => validateBaseUrl(url, dev)).toThrow();
  });

  it('production requires https', () => {
    expect(() => validateBaseUrl('http://cctns.example.gov.in/', prod)).toThrow(/https/);
    expect(validateBaseUrl('https://cctns.example.gov.in/', prod).hostname).toBe('cctns.example.gov.in');
  });

  it('::/96 (IPv4-compatible) and the unspecified address are restricted', () => {
    for (const ip of ['::7f00:1', '::a00:1', '::c0a8:101', '::']) expect(isRestrictedIp(ip), ip).toBe(true);
    expect(isRestrictedIp('2606:4700::1111')).toBe(false);
  });

  it('DNS rebinding: a hostname resolving to loopback is refused at connect time', async () => {
    const err = await new Promise<Error | null>((resolve) => guardedLookup(dev)('localhost', { all: false }, (e) => resolve(e)));
    expect(err?.message).toMatch(/restricted/);
  });
});
