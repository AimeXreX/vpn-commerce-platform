import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('all storefront locales expose the same complete translation shape', () => {
  const storage = new Map();
  const context = { navigator:{ language:'en-US' }, localStorage:{ getItem:key=>storage.get(key)||null, setItem:(key,value)=>storage.set(key,value) }, document:{ querySelector:()=>null, querySelectorAll:()=>[], documentElement:{} }, window:{} };
  context.window.window=context.window; context.window.navigator=context.navigator; context.window.localStorage=context.localStorage; context.window.document=context.document;
  vm.runInNewContext(fs.readFileSync('public/store-i18n.js','utf8'), context);
  const audit=context.window.StoreI18n.audit(), baseline=Array.from(audit.fa.keys);
  for(const lang of ['en','ru','fr']) assert.deepEqual(Array.from(audit[lang].keys),Array.from(baseline),`${lang} keys differ from fa`);
  for(const lang of ['fa','en','ru','fr']) { assert.equal(audit[lang].mini,17); assert.equal(audit[lang].guide,4); }
});
