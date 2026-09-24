const $ = selector => document.querySelector(selector);
const esc = value => String(value ?? '').replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]);
const fa = value => Number(value || 0).toLocaleString(window.StoreI18n?.locale === 'fa' ? 'fa-IR' : window.StoreI18n?.locale || 'en');
const tg = window.Telegram?.WebApp;
const initData = tg?.initData || '';
const i18n = window.StoreI18n; const tr = key => i18n.t(key);
const isAndroid = /Android/i.test(navigator.userAgent) || tg?.platform === 'android';
if (isAndroid) document.documentElement.classList.add('android-webview');
const statusLabel = value => tr(value);
const trafficLabel = plan => plan?.unlimited ? tr('unlimited') : `${fa(plan?.trafficGb || 0)} ${tr('gb')}`;
let config = null, user = null, selectedPlan = null, currentOrder = null, ordersLoaded = false, servicesLoaded = false, renewalServiceId = null;

async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(value);
    else throw new Error('clipboard unavailable');
  } catch {
    const input = document.createElement('textarea'); input.value = value; input.setAttribute('readonly', ''); input.style.position = 'fixed'; input.style.opacity = '0';
    document.body.appendChild(input); input.select(); const copied = document.execCommand('copy'); input.remove();
    if (!copied) throw new Error('copy failed');
  }
}

function haptic(type = 'light') { try { tg?.HapticFeedback?.impactOccurred(type); } catch {} }
function syncStableViewport() {
  const height = Number(tg?.viewportStableHeight || window.innerHeight);
  if (height > 0) document.documentElement.style.setProperty('--app-stable-height', `${Math.round(height)}px`);
}
function toast(message) { const element = $('#toast'); element.textContent = message; element.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => element.classList.remove('show'), 2800); }
function openSheet() {
  const sheet = $('#checkout');
  if (sheet.open) return;
  try { sheet.showModal(); } catch { sheet.setAttribute('open', ''); sheet.classList.add('dialog-fallback'); }
  tg?.BackButton?.show();
}
function closeSheet() {
  const sheet = $('#checkout');
  if (sheet.hasAttribute('open')) { try { sheet.close(); } catch {} sheet.removeAttribute('open'); }
  sheet.classList.remove('dialog-fallback');
  tg?.BackButton?.hide();
}
async function api(url, options = {}) {
  const headers = new Headers(options.headers || {}); if (initData) headers.set('x-telegram-init-data', initData);
  const attempts = !options.method || options.method === 'GET' ? 2 : 1;
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await fetch(url, { ...options, headers, signal: options.signal || AbortSignal.timeout(15000) }); const data = await response.json().catch(() => ({}));
      if (!response.ok) throw Object.assign(new Error(data.error || tr('networkError')), { status: response.status });
      setConnectionState(true); return data;
    } catch (error) {
      lastError = error; if (error.status || attempt + 1 >= attempts) break; await new Promise(resolve => setTimeout(resolve, 650));
    }
  }
  setConnectionState(false); throw lastError;
}
function setConnectionState(online) { const el=$('#connection-state'); if(!el)return; el.textContent=tr(online?'connectionOnline':'connectionOffline'); el.className=`connection-state ${online?'online':'offline'} show`; clearTimeout(setConnectionState.timer); setConnectionState.timer=setTimeout(()=>el.classList.remove('show'),online?1200:5000); }
window.addEventListener('online',()=>setConnectionState(true)); window.addEventListener('offline',()=>setConnectionState(false));

async function boot() {
  syncStableViewport(); tg?.onEvent?.('viewportChanged', event => { if (event?.isStateStable !== false) syncStableViewport(); });
  tg?.ready(); tg?.expand(); tg?.setHeaderColor?.('secondary_bg_color'); tg?.setBackgroundColor?.('bg_color');
  try {
    const requests = [api('/api/public/config')];
    if (initData) requests.push(api('/api/telegram/auth', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ initData }) }));
    const results = await Promise.all(requests); config = results[0]; user = results[1]?.user || tg?.initDataUnsafe?.user || null;
    if (!localStorage.getItem('storeLanguage') && results[1]?.language) i18n.setLocale(results[1].language, { persist:false });
    $('#store-name').textContent = config.storeName; $('#support-id').textContent = config.supportId; $('#profile').textContent = (user?.first_name || 'م').charAt(0); document.title = `${config.storeName} · تلگرام`;
    i18n.mount(() => { renderPlans(); if ($('#checkout').hasAttribute('open') && selectedPlan) openCheckout(selectedPlan.id); if (ordersLoaded) loadOrders(); if (servicesLoaded) loadServices(); }); renderPlans(); bind(); if (initData) loadReferral(); handleReturn();
  } catch (error) {
    const authExpired = /(هویت تلگرام|اعتبار ورود|معتبر یا تازه نیست)/.test(error.message);
    $('#plans').innerHTML = `<div class="empty"><b>${tr('unavailable')}</b>${esc(error.message)}${authExpired ? `<button type="button" class="primary" id="reload-miniapp">${tr('reload')}</button>` : ''}</div>`;
    $('#reload-miniapp')?.addEventListener('click', () => location.reload());
  }
}

async function loadReferral() {
  try {
    const info = await api('/api/telegram/referral');
    const copy = { fa:['دعوت کن، تخفیف بگیر','۱ دعوت: ۵٪ · ۴ دعوت: ۱۰٪ · ۱۰ دعوت: ۲۰٪ برای ۵ سفارش','دعوت موفق','ارسال لینک دعوت'], en:['Invite friends, save more','1 invite: 5% · 4: 10% · 10: 20% for 5 orders','Successful invites','Share invite link'], ru:['Приглашайте и экономьте','1: 5% · 4: 10% · 10: 20% на 5 заказов','Успешные приглашения','Поделиться ссылкой'], fr:['Invitez et économisez','1 : 5% · 4 : 10% · 10 : 20% sur 5 commandes','Invitations réussies','Partager le lien'] }[i18n.locale] || null;
    const text = copy || ['Invite friends, save more','1 invite: 5% · 4: 10% · 10: 20% for 5 orders','Successful invites','Share invite link'];
    const card = document.createElement('article'); card.className = 'plan referral-card';
    card.innerHTML = `<div class="plan-head"><div class="plan-icon">🎁</div><div><h3>${text[0]}</h3><small>${text[1]}</small></div></div><div class="plan-bottom"><b>${text[2]}: ${fa(info.count)}</b><button type="button" class="choose">${text[3]}</button></div>`;
    $('#plans').before(card); card.querySelector('button').onclick = () => tg?.openTelegramLink ? tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(info.link)}`) : window.open(`https://t.me/share/url?url=${encodeURIComponent(info.link)}`, '_blank', 'noopener');
  } catch {}
}

function bind() {
  document.querySelectorAll('[data-tab]').forEach(button => button.onclick = () => switchTab(button.dataset.tab));
  $('#checkout .close').onclick = closeSheet;
  $('#checkout').addEventListener('cancel', event => { event.preventDefault(); closeSheet(); });
  $('#profile').onclick = () => switchTab('orders');
  $('#open-support').onclick = () => {
    haptic(); const username = String(config.supportId || '').replace(/^@/, '');
    if (!username) return toast(tr('unavailable'));
    const link = `https://t.me/${username}`;
    if (tg?.openTelegramLink) tg.openTelegramLink(link); else window.open(link, '_blank', 'noopener');
  };
  tg?.BackButton?.onClick(() => $('#checkout').hasAttribute('open') ? closeSheet() : switchTab('store'));
}

function switchTab(name) {
  haptic(); document.querySelectorAll('.view').forEach(view => view.classList.toggle('active', view.id === `${name}-view`));
  document.querySelectorAll('[data-tab]').forEach(button => button.classList.toggle('active', button.dataset.tab === name));
  if (name === 'orders' && !ordersLoaded) loadOrders();
  if (name === 'services' && !servicesLoaded) loadServices(); window.scrollTo({ top:0, behavior:isAndroid ? 'auto' : 'smooth' });
}

function renderPlans() {
  $('#plan-count').textContent = `${fa(config.plans.length)} ${tr('choose')}`;
  $('#plans').innerHTML = config.plans.map(plan => `<article class="plan ${plan.popular ? 'popular' : ''}">${plan.popular ? `<span class="popular-badge">${tr('popular')}</span>` : ''}<div class="plan-head"><div class="plan-icon">◇</div><div><h3>${esc(i18n.planName(plan))}</h3><small>${fa(plan.days)} ${tr('days')}</small></div></div><div class="specs"><span>${trafficLabel(plan)}</span><span>${fa(plan.devices)} ${tr('devices')}</span><span>${tr('instant')}</span></div><div class="plan-bottom"><div class="price"><b>${fa(plan.price)}</b><small>${tr('toman')}</small></div><button type="button" class="choose" data-plan="${esc(plan.id)}">${tr('choose')}</button></div></article>`).join('');
  $('#plans').onclick = event => { const button = event.target.closest('[data-plan]'); if (button) { renewalServiceId = null; openCheckout(button.dataset.plan); } };
}

function openCheckout(planId) {
  haptic('medium'); selectedPlan = config.plans.find(plan => plan.id === planId);
  if (!selectedPlan) return toast(tr('planGone'));
  const fullName = user ? [user.first_name, user.last_name].filter(Boolean).join(' ') : '';
  const contact = user?.username ? `@${user.username}` : user?.id ? `tg:${user.id}` : '';
  $('#checkout-body').innerHTML = `<form id="order-form"><div class="sheet-head"><span class="eyebrow">${tr(renewalServiceId?'serviceRenewal':'secureCheckout')}</span><h2>${esc(i18n.planName(selectedPlan))}</h2></div><div class="summary"><span>${fa(selectedPlan.trafficGb)} ${tr('gb')} · ${fa(selectedPlan.days)} ${tr('days')}</span><b id="checkout-amount">${fa(selectedPlan.price)} ${tr('toman')}</b></div><div class="field"><label>${tr('name')}</label><input name="name" value="${esc(fullName)}" required minlength="2" autocomplete="name"></div>${user ? '' : `<div class="field"><label>${tr('mobile')}</label><input name="phone" inputmode="numeric" pattern="09[0-9]{9}" required placeholder="09123456789"></div>`}<div class="field"><label>${tr('contact')}</label><input name="contact" value="${esc(contact)}" ${user ? 'readonly' : 'required'}></div><div class="field discount-field"><label>${tr('discountCode')} (${tr('optional')})</label><div><input name="discountCode" maxlength="40" autocomplete="off" placeholder="${tr('enterDiscount')}"><button type="button" id="apply-discount">${tr('applyDiscount')}</button></div><small id="discount-result"></small></div><div class="methods"><label class="method"><input type="radio" name="method" value="card" checked><span>${tr('card')}</span></label><label class="method"><input type="radio" name="method" value="crypto"><span>${tr('crypto')} · USDT TRC20</span></label></div><button class="primary pay-button">${renewalServiceId ? tr('renew') : tr('checkout')}</button></form>`;
  $('#order-form').onsubmit = submitOrder; $('#apply-discount').onclick = applyCheckoutDiscount; openSheet();
}

async function applyCheckoutDiscount() {
  const input = $('#order-form [name="discountCode"]'), result = $('#discount-result'), button = $('#apply-discount');
  const code = input.value.trim().toUpperCase(); if (!code) { result.textContent = tr('enterDiscount'); result.className = 'error'; return; }
  button.disabled = true;
  try { const quote = await api('/api/public/quote', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ planId:selectedPlan.id, discountCode:code }) }); input.value = code; result.textContent = `${tr('discountApplied')} · ${tr('discountSaved')}: ${fa(quote.discount.amount)} ${tr('toman')}`; result.className = 'success'; $('#checkout-amount').innerHTML = `<del>${fa(quote.originalAmount)}</del> ${fa(quote.amount)} ${tr('toman')}`; haptic('medium'); }
  catch (error) { result.textContent = error.status === 400 ? tr('discountInvalid') : error.message; result.className = 'error'; $('#checkout-amount').textContent = `${fa(selectedPlan.price)} ${tr('toman')}`; }
  finally { button.disabled = false; }
}

async function submitOrder(event) {
  event.preventDefault(); const button = event.submitter || event.target.querySelector('.pay-button'); button.disabled = true; button.textContent = tr('creating');
  const body = Object.fromEntries(new FormData(event.target)); body.planId = selectedPlan.id; body.phone ||= '';
  if (renewalServiceId) body.renewalServiceId = renewalServiceId;
  try {
    if (body.discountCode) await api('/api/public/quote', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ planId:body.planId, discountCode:body.discountCode }) });
    const endpoint = renewalServiceId ? `/api/telegram/services/${encodeURIComponent(renewalServiceId)}/renew` : '/api/orders';
    const result = await api(endpoint, { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify(body) }); currentOrder = result.order; renewalServiceId = null; ordersLoaded = false; servicesLoaded = false; localStorage.setItem('telegramLastOrder', currentOrder.code); haptic('heavy');
    if (body.method === 'crypto' && result.paymentUrl) { if (tg?.openLink) tg.openLink(result.paymentUrl, { try_instant_view:false }); else location.href = result.paymentUrl; showPaymentWaiting(); return; }
    showCardPayment();
  } catch (error) { toast(body.discountCode && error.status === 400 ? tr('discountInvalid') : error.message); button.disabled = false; button.textContent = renewalServiceId ? tr('renew') : tr('checkout'); }
}

function showPaymentWaiting() { $('#checkout-body').innerHTML = `<div class="success"><div class="success-icon">⌁</div><h2>${tr('waiting')}</h2><p><b dir="ltr">${currentOrder.code}</b><br>${tr('waitingText')}</p><button type="button" class="primary" data-orders>${tr('viewOrders')}</button></div>`; $('[data-orders]').onclick = () => { closeSheet(); ordersLoaded = false; switchTab('orders'); }; }
function showCardPayment() {
  $('#checkout-body').innerHTML = `<div class="sheet-head"><span class="eyebrow">ORDER ${currentOrder.code}</span><h2>${tr('card')}</h2></div><div class="card"><small>${tr('cardNumber')}</small><code>${esc(config.cardNumber || '—')}</code><small>${esc(config.cardHolder || '—')} · ${fa(currentOrder.amount)} ${tr('toman')}</small></div><form id="receipt-form"><label class="upload"><b>JPG / PNG / WebP / PDF</b><br>Max 5MB<input type="file" name="receipt" accept="image/jpeg,image/png,image/webp,application/pdf" required></label><button class="primary pay-button">${tr('receipt')}</button></form>`;
  $('#receipt-form').onsubmit = uploadReceipt;
}

async function uploadReceipt(event) {
  event.preventDefault(); const button = event.submitter || event.target.querySelector('.pay-button'); button.disabled = true; button.textContent = tr('uploading');
  try { await api(`/api/orders/${currentOrder.code}/receipt`, { method:'POST', body:new FormData(event.target) }); haptic('heavy'); $('#checkout-body').innerHTML = `<div class="success"><div class="success-icon">✓</div><h2>${tr('receiptDone')}</h2><p>${tr('receiptDoneText')}</p><button type="button" class="primary" data-orders>${tr('trackOrder')}</button></div>`; $('[data-orders]').onclick = () => { closeSheet(); ordersLoaded = false; switchTab('orders'); }; }
  catch (error) { toast(error.message); button.disabled = false; button.textContent = tr('receipt'); }
}

async function loadOrders() {
  const element = $('#orders');
  if (!initData) { const code = localStorage.getItem('telegramLastOrder'); if (!code) { element.innerHTML = `<div class="empty"><b>${tr('noOrders')}</b>${tr('openInTelegram')}</div>`; return; } try { renderOrders([await api(`/api/orders/${code}`)]); } catch (error) { element.innerHTML = `<div class="empty">${esc(error.message)}</div>`; } return; }
  try { const orders = await api('/api/telegram/orders'); renderOrders(orders); ordersLoaded = true; } catch (error) { element.innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
}
function renderOrders(orders) {
  $('#orders').innerHTML = orders.length ? orders.map(order => { const link=order.subscriptionUrl||order.configUrl; return `<article class="order"><div class="order-top"><code>${order.code}</code><span class="status ${order.status}">${statusLabel(order.status)}</span></div><div class="order-details"><span>${esc(order.plan ? i18n.planName(order.plan) : 'Plan')}<b>${fa(order.amount)} ${tr('toman')}</b></span><span>${new Date(order.createdAt).toLocaleDateString(i18n.locale)}</span></div>${link ? `<div class="delivery-summary"><b>${tr('created')}</b><span>📦 ${tr('volume')}: ${order.plan?.trafficGb}GB</span><span>📅 ${tr('validity')}: ${order.plan?.days} ${tr('days')}</span><code>🆔 ${esc(order.clientId||'—')}</code><img src="/api/orders/${order.code}/qr" alt="QR"><div class="delivery-link" data-copy="${esc(link)}">${esc(link)}</div></div>` : ''}${order.rejectionReason ? `<div class="delivery-link">${esc(order.rejectionReason)}</div>` : ''}</article>` }).join('') : `<div class="empty"><b>${tr('noOrders')}</b></div>`;
  document.querySelectorAll('[data-copy]').forEach(element => element.onclick = async () => { try { await copyText(element.dataset.copy); haptic(); toast(tr('copied')); } catch { toast(tr('copyFailed')); } });
}
async function loadServices() {
  const element = $('#services');
  if (!initData) { element.innerHTML = `<div class="empty"><b>${tr('telegramOnly')}</b></div>`; return; }
  try { const services = await api('/api/telegram/services'); renderServices(services); servicesLoaded = true; }
  catch (error) { element.innerHTML = `<div class="empty">${esc(error.message)}</div>`; }
}
function renderServices(services) {
  $('#services').innerHTML = services.length ? services.map(service => {
    const live = service.live || {}, unlimited = Boolean(service.plan?.unlimited), total = Number(live.totalGb || service.plan?.trafficGb || 0), remaining = Number(live.remainingGb ?? total), percent = unlimited ? 100 : total ? Math.max(0, Math.min(100, remaining / total * 100)) : 0;
    const link = service.subscriptionUrl || '';
    return `<article class="order service-card"><div class="order-top"><code>${esc(service.orderCode)}</code><span class="status ${service.active ? 'delivered' : 'rejected'}">${tr(service.active?'active':'inactive')}</span></div><div class="meter"><i style="width:${percent}%"></i></div><div class="service-stats"><span><b>${unlimited ? tr('unlimited') : `${fa(remaining)}GB`}</b> ${tr('remaining')}</span><span><b>${service.expiryAt ? new Date(service.expiryAt).toLocaleDateString(i18n.locale) : '—'}</b> ${tr('expiry')}</span></div>${link ? `<div class="delivery-link" data-copy="${esc(link)}">${esc(link)}</div><div class="quick-actions"><button data-import="hiddify" data-link="${esc(link)}">${tr('importHiddify')}</button><button data-import="v2ray" data-link="${esc(link)}">${tr('importV2ray')}</button><button data-renew="${esc(service.id)}">♻️ ${tr('renew')}</button></div>` : ''}</article>`;
  }).join('') : `<div class="empty"><b>${tr('noServices')}</b></div>`;
  document.querySelectorAll('[data-copy]').forEach(el => el.onclick = async () => { try { await copyText(el.dataset.copy); haptic(); toast(tr('copied')); } catch { toast(tr('copyFailed')); } });
  document.querySelectorAll('[data-import]').forEach(el => el.onclick = () => importToClient(el.dataset.import, el.dataset.link));
  document.querySelectorAll('[data-renew]').forEach(el => el.onclick = () => { renewalServiceId = el.dataset.renew; $('#checkout-body').innerHTML = `<div class="sheet-head"><span class="eyebrow">${tr('serviceRenewal')}</span><h2>${tr('chooseRenewal')}</h2></div><div class="renew-plans">${config.plans.map(p => `<button data-renew-plan="${esc(p.id)}"><b>${esc(i18n.planName(p))}</b><span>${fa(p.trafficGb)} ${tr('gb')} · ${fa(p.days)} ${tr('days')} · ${fa(p.price)} ${tr('toman')}</span></button>`).join('')}</div>`; openSheet(); document.querySelectorAll('[data-renew-plan]').forEach(btn => btn.onclick = () => openCheckout(btn.dataset.renewPlan)); });
}
function importToClient(client, link) {
  if (!link) return;
  haptic('medium'); copyText(link).catch(() => {});
  const encoded = encodeURIComponent(link);
  const target = client === 'v2ray' ? (isAndroid ? `intent://install-sub?url=${encoded}#Intent;scheme=v2rayng;package=com.v2ray.ang;end` : `v2rayng://install-sub?url=${encoded}`) : `hiddify://import/${encoded}`;
  window.location.href = target;
  setTimeout(() => { if (document.visibilityState === 'visible') toast(tr('importCopied')); }, 1200);
}
function handleReturn() { const params = new URLSearchParams(location.search); if (params.get('order')) { localStorage.setItem('telegramLastOrder', params.get('order')); ordersLoaded = false; servicesLoaded = false; if (params.get('payment') === 'success') { toast(tr('paymentReceived')); setTimeout(() => switchTab('orders'), 400); } else if (params.get('payment') === 'cancel') setTimeout(() => switchTab('orders'), 200); } if (location.hash === '#services') switchTab('services'); }
boot();
