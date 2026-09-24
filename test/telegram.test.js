import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramBot } from '../lib/telegram.js';

test('edit ignores Telegram message-not-modified responses', async () => {
  const bot = new TelegramBot({ token: 'test' });
  bot.api = async () => { throw new Error('Bad Request: message is not modified'); };
  assert.equal(await bot.edit(1, 2, 'same text', { inline_keyboard: [] }), false);
});

test('edit falls back to editing a caption for photo messages', async () => {
  const bot = new TelegramBot({ token: 'test' });
  const calls = [];
  bot.api = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'editMessageText') throw new Error('Bad Request: there is no text in the message to edit');
    return { message_id: 2 };
  };

  await bot.edit(1, 2, 'new caption', { inline_keyboard: [] });
  assert.deepEqual(calls.map(call => call.method), ['editMessageText', 'editMessageCaption']);
  assert.equal(calls[1].payload.caption, 'new caption');
  assert.equal('text' in calls[1].payload, false);
});

test('apiMultipart sends locally uploaded receipt media to Telegram', async t => {
  const bot = new TelegramBot({ token: 'test-token' });
  const originalFetch = global.fetch;
  let request;
  global.fetch = async (url, options) => { request = { url, options }; return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), { status: 200 }); };
  t.after(() => { global.fetch = originalFetch; });
  await bot.apiMultipart('sendPhoto', { chat_id: 123, caption: 'receipt', reply_markup: { inline_keyboard: [] } }, { data: Buffer.from('image'), filename: 'receipt.jpg', mime: 'image/jpeg' });
  assert.match(request.url, /sendPhoto$/);
  assert.equal(request.options.body.get('chat_id'), '123');
  assert.equal(request.options.body.get('caption'), 'receipt');
  assert.equal(request.options.body.get('photo').name, 'receipt.jpg');
});
