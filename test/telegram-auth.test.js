import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { validateTelegramInitData } from '../lib/telegram-auth.js';

function signedInitData(token, authDate = Math.floor(Date.now() / 1000)) {
  const values = {
    auth_date: String(authDate),
    query_id: 'AAHdF6IQAAAAAN0XohDhrOrc',
    user: JSON.stringify({ id: 123456789, first_name: 'Ali', username: 'ali_test' })
  };
  const check = Object.entries(values).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}=${value}`).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(check).digest('hex');
  return new URLSearchParams({ ...values, hash }).toString();
}

test('Telegram Mini App initData validates with bot token', () => {
  const token = '123456:TEST_TOKEN';
  const result = validateTelegramInitData(signedInitData(token), token);
  assert.equal(result.user.id, 123456789);
  assert.equal(result.user.username, 'ali_test');
});

test('Telegram initData rejects tampering and stale authentication', () => {
  const token = '123456:TEST_TOKEN';
  assert.equal(validateTelegramInitData(signedInitData(token).replace('Ali', 'Eve'), token), null);
  assert.equal(validateTelegramInitData(signedInitData(token, 1), token), null);
});
