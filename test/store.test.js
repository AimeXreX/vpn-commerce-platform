import test from 'node:test';
import assert from 'node:assert/strict';
import { newId } from '../lib/store.js';
import { verifyIpn } from '../lib/nowpayments.js';
import crypto from 'node:crypto';

test('order ids are unique and prefixed', () => {
  const a = newId('V'); const b = newId('V');
  assert.match(a, /^V[A-F0-9]{12}$/); assert.notEqual(a, b);
});

test('NOWPayments signature validates sorted payload', () => {
  process.env.NOWPAYMENTS_IPN_SECRET = 'test-secret';
  const body = { payment_status: 'finished', order_id: 'V123', nested: { z: 2, a: 1 } };
  const sorted = { nested: { a: 1, z: 2 }, order_id: 'V123', payment_status: 'finished' };
  const sig = crypto.createHmac('sha512', 'test-secret').update(JSON.stringify(sorted)).digest('hex');
  assert.equal(verifyIpn(body, sig), true);
  assert.equal(verifyIpn(body, 'bad'), false);
});
