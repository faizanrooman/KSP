import { describe, expect, it } from 'vitest';
import { ipInCidr } from '../src/plugins/auth.js';

describe('API-client IP allow-list matching (FN-15)', () => {
  it('matches IPv4 subnets and exact addresses, incl. IPv4-mapped IPv6 clients', () => {
    expect(ipInCidr('10.1.2.3', '10.1.0.0/16')).toBe(true);
    expect(ipInCidr('10.2.0.1', '10.1.0.0/16')).toBe(false);
    expect(ipInCidr('192.168.1.5', '192.168.1.5')).toBe(true);
    expect(ipInCidr('::ffff:10.1.2.3', '10.1.0.0/16')).toBe(true);
    expect(ipInCidr('1.2.3.4', '0.0.0.0/0')).toBe(true);
  });
  it('matches IPv6 subnets and exact addresses', () => {
    expect(ipInCidr('2001:db8:abcd:12::1', '2001:db8:abcd::/48')).toBe(true);
    expect(ipInCidr('2001:db8:abce::1', '2001:db8:abcd::/48')).toBe(false);
    expect(ipInCidr('::1', '::1')).toBe(true);
    expect(ipInCidr('fd00::5', 'fd00::/8')).toBe(true);
  });
  it('never matches across families or on malformed input', () => {
    expect(ipInCidr('10.1.2.3', '2001:db8::/32')).toBe(false);
    expect(ipInCidr('2001:db8::1', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('10.1.2.3', '10.1.0.0/33')).toBe(false);
    expect(ipInCidr('not-an-ip', '10.0.0.0/8')).toBe(false);
    expect(ipInCidr('10.1.2.3', 'garbage/8')).toBe(false);
    expect(ipInCidr('10.1.2.3', '')).toBe(false);
  });
});
