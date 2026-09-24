import test from 'node:test';
import assert from 'node:assert/strict';
import { getClientLive, getClientsLive } from '../lib/xui.js';

test('getClientLive reads traffic from inbound list without the legacy traffic route', async t => {
  const previous = { base: process.env.XUI_BASE_URL, token: process.env.XUI_API_TOKEN, inbound: process.env.XUI_INBOUND_ID };
  process.env.XUI_BASE_URL = 'https://panel.test';
  process.env.XUI_API_TOKEN = 'token';
  process.env.XUI_INBOUND_ID = '1';
  const originalFetch = global.fetch;
  const requested = [];
  global.fetch = async url => {
    requested.push(String(url));
    return new Response(JSON.stringify({ success: true, obj: [{
      id: 1,
      settings: { clients: [{ id: 'client-1', email: 'shop-test', totalGB: 10 * 1024 ** 3, expiryTime: Date.now() + 60_000 }] },
      clientStats: [{ uuid: 'client-1', email: 'shop-test', up: 1024 ** 3, down: 2 * 1024 ** 3 }]
    }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  t.after(() => {
    global.fetch = originalFetch;
    for (const [key, value] of Object.entries({ XUI_BASE_URL: previous.base, XUI_API_TOKEN: previous.token, XUI_INBOUND_ID: previous.inbound })) value === undefined ? delete process.env[key] : process.env[key] = value;
  });

  const live = await getClientLive({ clientId: 'client-1', clientEmail: 'shop-test' });
  assert.equal(live.usedGb, 3);
  assert.equal(live.remainingGb, 7);
  assert.equal(requested.length, 1);
  assert.match(requested[0], /\/panel\/api\/inbounds\/list$/);
});

test('getClientsLive resolves multiple services with one panel request', async t => {
  const previous = { base: process.env.XUI_BASE_URL, token: process.env.XUI_API_TOKEN, inbound: process.env.XUI_INBOUND_ID };
  process.env.XUI_BASE_URL = 'https://panel.test'; process.env.XUI_API_TOKEN = 'token'; process.env.XUI_INBOUND_ID = '1';
  const originalFetch = global.fetch; let requests = 0;
  global.fetch = async () => { requests++; return new Response(JSON.stringify({ success: true, obj: [{ id: 1, settings: { clients: [{ id:'a', email:'a', totalGB:5*1024**3, expiryTime:Date.now()+60000 }, { id:'b', email:'b', totalGB:10*1024**3, expiryTime:Date.now()+60000 }] }, clientStats: [{ uuid:'a', up:1024**3, down:0 }, { uuid:'b', up:2*1024**3, down:0 }] }] }), { status:200, headers:{'content-type':'application/json'} }); };
  t.after(() => { global.fetch = originalFetch; for (const [key,value] of Object.entries({ XUI_BASE_URL:previous.base, XUI_API_TOKEN:previous.token, XUI_INBOUND_ID:previous.inbound })) value === undefined ? delete process.env[key] : process.env[key] = value; });
  const live = await getClientsLive([{clientId:'a'},{clientId:'b'}]);
  assert.equal(requests, 1); assert.equal(live.get('a').remainingGb, 4); assert.equal(live.get('b').remainingGb, 8);
});
