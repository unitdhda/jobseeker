import assert from 'node:assert/strict';
import test from 'node:test';
import { isPublicIpAddress } from '../src/http.ts';

test('SSRF address classification accepts only public unicast ranges', () => {
  for (const address of ['8.8.8.8','1.1.1.1','2606:4700:4700::1111']) {
    assert.equal(isPublicIpAddress(address),true,address);
  }
  for (const address of [
    '127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','100.64.0.1','169.254.1.1','0.0.0.0',
    '::','::1','fc00::1','fe80::1','::ffff:127.0.0.1','::ffff:172.16.0.1','not-an-address',
  ]) assert.equal(isPublicIpAddress(address),false,address);
});
