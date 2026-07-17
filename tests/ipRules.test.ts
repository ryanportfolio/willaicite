import { describe, it, expect } from 'vitest';
import { isBlockedAddress } from '../src/ipRules.js';

describe('isBlockedAddress — IPv4', () => {
  it('blocks loopback, private, link-local, CGNAT, unspecified, reserved, multicast', () => {
    for (const ip of [
      '127.0.0.1',
      '127.0.0.53',
      '10.0.0.1',
      '172.16.5.4',
      '172.31.255.255',
      '192.168.1.1',
      '169.254.169.254',
      '100.64.0.1',
      '0.0.0.0',
      '224.0.0.1',
      '240.0.0.1',
      '255.255.255.255',
      '198.18.0.1',
    ])
      expect(isBlockedAddress(ip), ip).toBe(true);
  });
  it('allows ordinary public IPv4', () => {
    for (const ip of ['1.1.1.1', '8.8.8.8', '93.184.216.34', '172.15.0.1', '172.32.0.1', '11.0.0.1'])
      expect(isBlockedAddress(ip), ip).toBe(false);
  });
});

describe('isBlockedAddress — IPv6', () => {
  it('blocks loopback, ULA, link-local, multicast, unspecified', () => {
    for (const ip of ['::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '::'])
      expect(isBlockedAddress(ip), ip).toBe(true);
  });
  it('blocks IPv4-mapped/6to4/NAT64 that embed a private v4 (the bypass)', () => {
    for (const ip of [
      '::ffff:127.0.0.1',
      '::ffff:169.254.169.254',
      '::ffff:10.0.0.1',
      '2002:a00:0001::', // 6to4 wrapping 10.0.0.1
      '64:ff9b::a00:1', // NAT64 wrapping 10.0.0.1
    ])
      expect(isBlockedAddress(ip), ip).toBe(true);
  });
  it('allows a mapped/6to4/NAT64 that embeds a public v4', () => {
    for (const ip of ['::ffff:93.184.216.34', '2002:5db8:d822::', '64:ff9b::808:808'])
      expect(isBlockedAddress(ip), ip).toBe(false);
  });
  it('allows ordinary public IPv6', () => {
    for (const ip of ['2606:4700:4700::1111', '2001:4860:4860::8888'])
      expect(isBlockedAddress(ip), ip).toBe(false);
  });
  it('returns true (fail closed) for unparseable input', () => {
    expect(isBlockedAddress('not-an-ip')).toBe(true);
    expect(isBlockedAddress('')).toBe(true);
    expect(isBlockedAddress('999.1.1.1')).toBe(true);
  });
});
