import crypto from 'node:crypto';
import { info, warn, error } from './logger.js';

function config() {
  const rawIds = process.env.XUI_INBOUND_ID || '1';
  const inboundIds = rawIds.split(',').map(x => Number(x.trim())).filter(Number.isInteger);
  if (!inboundIds.length) throw new Error('XUI_INBOUND_ID معتبر نیست؛ نمونه صحیح: 1 یا 1,2');
  return { base:(process.env.XUI_BASE_URL||'').replace(/\/+$/,''), token:process.env.XUI_API_TOKEN||'', inboundIds, subBase:(process.env.XUI_PUBLIC_SUB_URL||'').replace(/\/+$/,'') };
}

async function request(apiPath, options = {}, context = {}) {
  const c=config(); if(!c.base||!c.token)throw new Error('اتصال 3x-ui هنوز تنظیم نشده است');
  const url=`${c.base}${apiPath}`, started=Date.now(), method=options.method||'GET';
  info('xui.request','ارسال درخواست به پنل',{method,apiPath,base:c.base,...context});
  let response,text,body;
  try { const {form,...fetchOptions}=options; const requestBody=form?new URLSearchParams(Object.entries(form).map(([key,value])=>[key,String(value)])):options.body; response=await fetch(url,{...fetchOptions,body:requestBody,headers:{Authorization:`Bearer ${c.token}`,'Content-Type':form?'application/x-www-form-urlencoded':'application/json',Accept:'application/json',...(options.headers||{})},signal:AbortSignal.timeout(15000)}); text=await response.text(); try{body=text?JSON.parse(text):null}catch{body={message:text}} }
  catch(e){error('xui.network_error','ارتباط شبکه با پنل شکست خورد',{method,apiPath,elapsedMs:Date.now()-started,error:e.message,...context});throw new Error(`ارتباط با پنل برقرار نشد: ${e.message}`)}
  const meta={method,apiPath,status:response.status,statusText:response.statusText,elapsedMs:Date.now()-started,response:body,...context};
  if(!response.ok||(body&&body.success===false)){error('xui.response_error','پنل پاسخ ناموفق داد',meta);const detail=body?.msg||body?.message||response.statusText;const e=new Error(`خطای 3x-ui: ${response.status}${detail?` — ${detail}`:''}`);e.status=response.status;e.details=meta;throw e}
  info('xui.response_ok','پاسخ موفق از پنل دریافت شد',meta);return body;
}

function listFrom(result){return Array.isArray(result)?result:Array.isArray(result?.obj)?result.obj:Array.isArray(result?.data)?result.data:[]}
export async function testXui(){
  if(process.env.DEMO_MODE==='true'&&!process.env.XUI_API_TOKEN)return{demo:true,message:'حالت آزمایشی فعال است'};
  const c=config(), result=await request('/panel/api/inbounds/list',{}, {operation:'connection_test'}), inbounds=listFrom(result), found=inbounds.map(x=>Number(x.id));
  const missing=c.inboundIds.filter(id=>!found.includes(id));
  if(missing.length){error('xui.config_invalid','شناسه inbound در پنل پیدا نشد',{configuredIds:c.inboundIds,availableIds:found,missingIds:missing});throw new Error(`Inbound پیدا نشد: ${missing.join(', ')} — شناسه‌های موجود: ${found.join(', ')||'هیچ‌کدام'}`)}
  info('xui.test_ok','اتصال و شناسه‌های inbound تأیید شدند',{configuredIds:c.inboundIds,availableIds:found});return{ok:true,inboundIds:c.inboundIds,inboundCount:inbounds.length};
}

export async function provision(order,plan){
  const c=config(),uuid=crypto.randomUUID(),subId=crypto.randomBytes(8).toString('hex'),email=`shop-${order.code.toLowerCase()}`;
  if(process.env.DEMO_MODE==='true'&&!process.env.XUI_API_TOKEN)return{clientId:uuid,subId,clientEmail:email,configUrl:`vless://${uuid}@demo.invalid:443?security=tls&type=ws#${email}`,subscriptionUrl:`https://demo.invalid/sub/${subId}`,demo:true};
  const client={id:uuid,email,enable:true,flow:'',tgId:0,subId,limitIp:plan.devices,totalGB:plan.unlimited?0:plan.trafficGb*1024**3,expiryTime:Date.now()+plan.days*86400000,reset:0};
  info('xui.provision_start','ساخت سرویس مشتری آغاز شد',{orderCode:order.code,inboundIds:c.inboundIds,trafficGb:plan.trafficGb,days:plan.days,devices:plan.devices,clientEmail:email});
  let created=[];
  try {
    await request('/panel/api/clients/add',{method:'POST',body:JSON.stringify({client,inboundIds:c.inboundIds})},{operation:'create_client_v3',orderCode:order.code,inboundIds:c.inboundIds,clientEmail:email});
    created=[...c.inboundIds];
  } catch(e) {
    if(e.status!==404){error('xui.provision_failed','ساخت مشتری با API جدید شکست خورد',{orderCode:order.code,inboundIds:c.inboundIds,error:e.message});throw e}
    warn('xui.legacy_fallback','مسیر API جدید موجود نبود؛ تلاش با API قدیمی',{orderCode:order.code});
    for(const inboundId of c.inboundIds){try{await request('/panel/api/inbounds/addClient',{method:'POST',form:{id:inboundId,settings:JSON.stringify({clients:[client]})}},{operation:'add_client_legacy',orderCode:order.code,inboundId,clientEmail:email});created.push(inboundId)}catch(legacyError){error('xui.provision_failed','ساخت مشتری با API قدیمی شکست خورد',{orderCode:order.code,inboundId,createdInboundIds:created,error:legacyError.message});throw new Error(`${legacyError.message} (Inbound ${inboundId})`)}}
  }
  info('xui.provision_success','سرویس مشتری با موفقیت ساخته شد',{orderCode:order.code,inboundIds:created,clientId:uuid,subId});
  return{clientId:uuid,subId,clientEmail:email,inboundIds:created,subscriptionUrl:c.subBase?`${c.subBase}/${subId}`:'',configUrl:''};
}

function parseClients(inbound) {
  try { const settings = typeof inbound?.settings === 'string' ? JSON.parse(inbound.settings) : inbound?.settings; return Array.isArray(settings?.clients) ? settings.clients : []; }
  catch { return []; }
}

async function findClient(clientId) {
  const result = await request('/panel/api/inbounds/list', {}, { operation: 'find_client', clientId });
  let found = null;
  const traffics = [];
  for (const inbound of listFrom(result)) {
    const client = parseClients(inbound).find(item => item.id === clientId);
    if (!client) continue;
    found ||= { inbound, client };
    const stats = Array.isArray(inbound.clientStats) ? inbound.clientStats : [];
    traffics.push(...stats.filter(item => item.email === client.email || item.uuid === clientId));
  }
  return found ? { ...found, traffics } : null;
}

export async function getClientLive(delivery) {
  if (delivery?.demo) return { exists: true, enable: true, totalGb: 0, usedGb: 0, remainingGb: 0, expiryTime: 0, demo: true };
  const found = await findClient(delivery.clientId);
  if (!found) return { exists: false, enable: false, expired: true };
  const total = Number(found.client.totalGB || 0);
  const expiryTime = Number(found.client.expiryTime || 0);
  // The list response already contains per-client traffic. This also works with
  // token-based/newer panel APIs where the legacy getClientTraffics route is 404.
  const used = found.traffics.reduce((sum, item) => sum + Number(item.up || 0) + Number(item.down || 0), 0);
  return { exists: true, email: found.client.email, enable: found.client.enable !== false, totalGb: +(total / 1024 ** 3).toFixed(2), usedGb: +(used / 1024 ** 3).toFixed(2), remainingGb: +(Math.max(total - used, 0) / 1024 ** 3).toFixed(2), expiryTime, expired: expiryTime > 0 && expiryTime <= Date.now() };
}

export async function getClientsLive(deliveries = []) {
  const result = new Map();
  const real = deliveries.filter(delivery => delivery?.clientId && !delivery.demo);
  for (const delivery of deliveries.filter(item => item?.demo)) result.set(delivery.clientId, { exists: true, enable: true, totalGb: 0, usedGb: 0, remainingGb: 0, expiryTime: 0, demo: true });
  if (!real.length) return result;
  const response = await request('/panel/api/inbounds/list', {}, { operation: 'find_clients_bulk', clientCount: real.length });
  const wanted = new Map(real.map(delivery => [delivery.clientId, delivery]));
  const aggregate = new Map();
  for (const inbound of listFrom(response)) {
    const stats = Array.isArray(inbound.clientStats) ? inbound.clientStats : [];
    for (const client of parseClients(inbound)) {
      if (!wanted.has(client.id)) continue;
      const current = aggregate.get(client.id) || { client, traffics: [] };
      current.traffics.push(...stats.filter(item => item.email === client.email || item.uuid === client.id));
      aggregate.set(client.id, current);
    }
  }
  for (const delivery of real) {
    const found = aggregate.get(delivery.clientId);
    if (!found) { result.set(delivery.clientId, { exists: false, enable: false, expired: true }); continue; }
    const total = Number(found.client.totalGB || 0), expiryTime = Number(found.client.expiryTime || 0);
    const used = found.traffics.reduce((sum, item) => sum + Number(item.up || 0) + Number(item.down || 0), 0);
    result.set(delivery.clientId, { exists: true, email: found.client.email, enable: found.client.enable !== false, totalGb: +(total / 1024 ** 3).toFixed(2), usedGb: +(used / 1024 ** 3).toFixed(2), remainingGb: +(Math.max(total - used, 0) / 1024 ** 3).toFixed(2), expiryTime, expired: expiryTime > 0 && expiryTime <= Date.now() });
  }
  return result;
}

export async function updateClient(delivery, { addGb = 0, addDays = 0 } = {}) {
  if (!addGb && !addDays) throw new Error('مقدار تمدید مشخص نشده است');
  if (delivery?.demo) return { ...delivery, demo: true };
  const found = await findClient(delivery.clientId);
  if (!found) throw new Error('کلاینت در پنل پیدا نشد');
  const email = found.client.email || delivery.clientEmail;
  try {
    const payload = { emails: [email] };
    if (addDays) payload.addDays = Number(addDays);
    if (addGb) payload.addBytes = Number(addGb) * 1024 ** 3;
    await request('/panel/api/clients/bulkAdjust', { method: 'POST', body: JSON.stringify(payload) }, { operation: 'extend_client_v3', clientId: delivery.clientId });
  } catch (error) {
    if (error.status !== 404) throw error;
    const client = { ...found.client };
    if (addGb) client.totalGB = Number(client.totalGB || 0) + Number(addGb) * 1024 ** 3;
    if (addDays) client.expiryTime = Math.max(Number(client.expiryTime || 0), Date.now()) + Number(addDays) * 86400000;
    await request(`/panel/api/inbounds/updateClient/${delivery.clientId}`, { method: 'POST', form: { id: found.inbound.id, settings: JSON.stringify({ clients: [client] }) } }, { operation: 'extend_client_legacy', clientId: delivery.clientId, inboundId: found.inbound.id });
  }
  info('xui.client_extended', 'سرویس تمدید شد', { clientId: delivery.clientId, addGb, addDays });
  return getClientLive(delivery);
}

export async function deleteClient(delivery) {
  if (delivery?.demo) return true;
  const found = await findClient(delivery.clientId);
  if (!found) return false;
  try { await request(`/panel/api/clients/del/${encodeURIComponent(found.client.email || delivery.clientEmail || '')}`, { method: 'POST' }, { operation: 'delete_client_v3', clientId: delivery.clientId }); }
  catch (error) {
    if (error.status !== 404) throw error;
    await request(`/panel/api/inbounds/${found.inbound.id}/delClient/${delivery.clientId}`, { method: 'POST' }, { operation: 'delete_client_legacy', clientId: delivery.clientId, inboundId: found.inbound.id });
  }
  info('xui.client_deleted', 'سرویس حذف شد', { clientId: delivery.clientId });
  return true;
}
