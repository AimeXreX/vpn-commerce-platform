import fs from 'node:fs/promises';
import { readStore, mutateStore, newId, now } from './store.js';
import { provision, updateClient } from './xui.js';
import { createCryptoPayment } from './nowpayments.js';
import { info as logInfo, error as logError } from './logger.js';

let notifier = null;
const deliveryLocks = new Map();
export function setOrderNotifier(fn) { notifier = fn; }
async function notify(type, order) {
  try { await notifier?.(type, order); } catch (error) { logError('telegram.notification_failed', 'ارسال اعلان تلگرام ناموفق بود', { type, orderCode: order?.code, error: error.message }); }
}

export const publicOrder = order => ({
  code: order.code,
  status: order.status,
  method: order.method,
  amount: order.amount,
  createdAt: order.createdAt,
  plan: order.planSnapshot,
  rejectionReason: order.status === 'rejected' ? order.rejectionReason : undefined,
  subscriptionUrl: order.status === 'delivered' ? order.delivery?.subscriptionUrl : undefined,
  configUrl: order.status === 'delivered' ? order.delivery?.configUrl : undefined,
  clientId: order.status === 'delivered' ? order.delivery?.clientId : undefined,
  discount: order.discount,
  renewalServiceId: order.renewalServiceId,
  demo: order.delivery?.demo
});

export async function quoteOrder(planId, discountCode = '') {
  const db = await readStore();
  const plan = db.plans.find(item => item.id === planId && item.active);
  if (!plan) throw Object.assign(new Error('پلن انتخاب‌شده موجود نیست'), { status: 404 });
  const code = String(discountCode || '').trim().toUpperCase();
  if (!code) return { plan, originalAmount: plan.price, amount: plan.price, discount: null };
  const item = (db.discounts || []).find(discount => discount.code === code && discount.active !== false);
  if (!item || (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) || (item.usageLimit && Number(item.usedCount || 0) >= Number(item.usageLimit))) throw Object.assign(new Error('کد تخفیف معتبر نیست یا ظرفیت آن تمام شده است'), { status: 400 });
  const value = item.type === 'fixed' ? Number(item.value) : Math.round(plan.price * Number(item.value) / 100);
  const discount = { code: item.code, type: item.type, value: item.value, amount: Math.min(value, plan.price) };
  return { plan, originalAmount: plan.price, amount: Math.max(0, plan.price - discount.amount), discount };
}

export async function createOrder(input, telegram = null) {
  const db = await readStore();
  const plan = db.plans.find(item => item.id === input.planId && item.active);
  if (!plan) throw Object.assign(new Error('پلن انتخاب‌شده موجود نیست'), { status: 404 });
  let discount;
  const discountCode = String(input.discountCode || '').trim().toUpperCase();
  if (discountCode) {
    const item = (db.discounts || []).find(x => x.code === discountCode && x.active !== false);
    if (!item || (item.expiresAt && Date.parse(item.expiresAt) <= Date.now()) || (item.usageLimit && Number(item.usedCount || 0) >= Number(item.usageLimit))) {
      throw Object.assign(new Error('کد تخفیف معتبر نیست یا ظرفیت آن تمام شده است'), { status: 400 });
    }
    const value = item.type === 'fixed' ? Number(item.value) : Math.round(plan.price * Number(item.value) / 100);
    discount = { code: item.code, type: item.type, value: item.value, amount: Math.min(value, plan.price) };
  }
  let referralReward;
  if (telegram?.id) {
    const user = (db.telegramUsers || []).find(item => Number(item.id) === Number(telegram.id));
    referralReward = (user?.referralRewards || []).filter(item => Number(item.remaining || 0) > 0).sort((a,b) => Number(b.percent) - Number(a.percent))[0];
    if (referralReward) {
      const amount = Math.round(plan.price * Number(referralReward.percent) / 100);
      if (!discount || amount > discount.amount) discount = { code: `REFERRAL-${referralReward.percent}`, type: 'percent', value: referralReward.percent, amount, source: 'referral', rewardId: referralReward.id };
      else referralReward = null;
    }
  }
  const order = {
    id: newId('ord_'), code: newId('V'), planId: plan.id,
    name: input.name, phone: input.phone || '', contact: input.contact || '', method: input.method,
    amount: Math.max(0, plan.price - Number(discount?.amount || 0)), discount, renewalServiceId: input.renewalServiceId || undefined,
    planSnapshot: { ...plan }, status: input.method === 'card' ? 'awaiting_receipt' : 'awaiting_payment',
    source: telegram ? (input.source || 'telegram') : (input.source || 'website'),
    telegram: telegram ? { id: Number(telegram.id), username: telegram.username || '', firstName: telegram.first_name || '', lastName: telegram.last_name || '' } : undefined,
    createdAt: now(), events: [{ type: 'created', at: now(), actor: telegram ? `telegram:${telegram.id}` : 'website' }]
  };
  await mutateStore(store => {
    if (discount) {
      if (discount.source === 'referral') {
        const user = store.telegramUsers.find(item => Number(item.id) === Number(telegram.id));
        const reward = (user?.referralRewards || []).find(item => item.id === discount.rewardId);
        if (!reward || Number(reward.remaining || 0) < 1) throw Object.assign(new Error('پاداش دعوت دیگر در دسترس نیست'), { status: 409 });
        reward.remaining -= 1; reward.usedCount = Number(reward.usedCount || 0) + 1; reward.lastUsedAt = now();
      } else {
        const item = store.discounts.find(x => x.code === discount.code);
        if (!item || (item.usageLimit && Number(item.usedCount || 0) >= Number(item.usageLimit))) throw Object.assign(new Error('ظرفیت کد تخفیف تمام شده است'), { status: 409 });
        item.usedCount = Number(item.usedCount || 0) + 1;
      }
    }
    store.orders.unshift(order);
  });
  logInfo('order.created', 'سفارش جدید ثبت شد', { orderCode: order.code, planId: order.planId, method: order.method, amount: order.amount, source: order.source, telegramId: order.telegram?.id, phoneSuffix: order.phone.slice(-4) });
  let paymentUrl;
  if (order.method === 'crypto') {
    try {
      const payment = await createCryptoPayment(order);
      await mutateStore(store => { const target = store.orders.find(item => item.id === order.id); if (target) target.payment = payment; });
      order.payment = payment;
      paymentUrl = payment.invoice_url;
    } catch (error) {
      if (discount) await mutateStore(store => { if (discount.source === 'referral') { const user=store.telegramUsers.find(item=>Number(item.id)===Number(telegram?.id)); const reward=(user?.referralRewards||[]).find(item=>item.id===discount.rewardId); if(reward){reward.remaining+=1;reward.usedCount=Math.max(0,Number(reward.usedCount||0)-1)} } else { const item = store.discounts.find(x => x.code === discount.code); if (item) item.usedCount = Math.max(0, Number(item.usedCount || 0) - 1); } });
      logError('payment.invoice_failed', 'ساخت فاکتور رمزارزی ناموفق بود', { orderCode: order.code, error: error.message });
      throw Object.assign(error, { status: 502, order });
    }
  }
  await notify('created', order);
  return { order, paymentUrl };
}

export async function attachReceipt(code, receipt) {
  const order = await mutateStore(store => {
    const target = store.orders.find(item => item.code === code.toUpperCase() && item.method === 'card');
    if (!target || ['delivered', 'rejected'].includes(target.status)) return null;
    target.receipt = receipt;
    target.status = 'reviewing';
    target.events.push({ type: 'receipt_uploaded', at: now(), actor: receipt.source || 'website' });
    return target;
  });
  if (!order) return null;
  logInfo('order.receipt_uploaded', 'رسید سفارش ثبت شد', { orderCode: order.code, mime: receipt.mime, source: receipt.source, size: receipt.size });
  await notify('receipt', order);
  return order;
}

export async function deliverOrder(code, actor = 'system') {
  const key = String(code || '').toUpperCase();
  if (deliveryLocks.has(key)) return deliveryLocks.get(key);
  const operation = deliverOrderUnlocked(key, actor).finally(() => deliveryLocks.delete(key));
  deliveryLocks.set(key, operation);
  return operation;
}

async function deliverOrderUnlocked(code, actor = 'system') {
  const db = await readStore();
  const order = db.orders.find(item => item.code === code.toUpperCase());
  if (!order) throw Object.assign(new Error('سفارش پیدا نشد'), { status: 404 });
  if (order.status === 'delivered') return order;
  if (order.status === 'rejected') throw new Error('سفارش ردشده قابل تحویل نیست');
  if (order.method === 'card' && !order.receipt) throw new Error('برای این سفارش هنوز رسیدی ثبت نشده است');
  const plan = db.plans.find(item => item.id === order.planId) || order.planSnapshot;
  logInfo('order.delivery_start', 'تأیید سفارش و ساخت سرویس آغاز شد', { orderCode: code, planId: order.planId, method: order.method, actor });
  await mutateStore(store => { const target = store.orders.find(item => item.code === order.code); target.status = 'provisioning'; target.provisioningAt = now(); target.events.push({ type: 'provisioning_started', at: now(), actor }); });
  let delivery, renewedService;
  try {
    if (order.renewalServiceId) {
      renewedService = db.services.find(item => item.id === order.renewalServiceId);
      if (!renewedService) throw Object.assign(new Error('سرویس قابل تمدید پیدا نشد'), { status: 404 });
      await updateClient(renewedService.delivery, { addGb: plan.trafficGb, addDays: plan.days });
      delivery = renewedService.delivery;
    } else delivery = await provision(order, plan);
  }
  catch (error) {
    await mutateStore(store => { const target = store.orders.find(item => item.code === order.code); target.status = order.receipt ? 'reviewing' : 'awaiting_payment'; target.lastDeliveryError = error.message; target.events.push({ type: 'provisioning_failed', at: now(), actor, message: error.message }); });
    logError('order.delivery_failed', 'تحویل سفارش شکست خورد', { orderCode: order.code, error: error.message, actor });
    throw error;
  }
  const delivered = await mutateStore(store => {
    const target = store.orders.find(item => item.code === order.code);
    target.status = 'delivered'; target.delivery = delivery; target.paidAt ||= now(); target.deliveredAt = now();
    target.events.push({ type: 'delivered', at: now(), actor }); delete target.lastDeliveryError;
    if (target.renewalServiceId) {
      const service = store.services.find(item => item.id === target.renewalServiceId);
      if (service) {
        service.active = true; service.updatedAt = now(); service.lastRenewalOrderCode = target.code;
        service.planSnapshot = { ...service.planSnapshot, days: Number(service.planSnapshot?.days || 0) + Number(plan.days), trafficGb: Number(service.planSnapshot?.trafficGb || 0) + Number(plan.trafficGb) };
      }
    } else store.services.unshift({ id: newId('svc_'), orderCode: target.code, ownerTelegramId: target.telegram?.id || null, createdBy: actor, planSnapshot: target.planSnapshot, delivery, createdAt: now(), expiryAt: new Date(Date.now() + Number(plan.days) * 86400000).toISOString(), active: true, alertState: {} });
    return target;
  });
  logInfo('order.delivered', 'سفارش با موفقیت تحویل شد', { orderCode: order.code, inboundIds: delivery.inboundIds, clientId: delivery.clientId, actor });
  await notify('delivered', delivered);
  return delivered;
}

export async function rejectOrder(code, reason, actor = 'admin') {
  const order = await mutateStore(store => {
    const target = store.orders.find(item => item.code === code.toUpperCase());
    if (!target || ['delivered', 'provisioning'].includes(target.status)) return null;
    target.status = 'rejected'; target.rejectionReason = String(reason || 'رسید پرداخت تأیید نشد').slice(0, 300);
    target.events.push({ type: 'rejected', at: now(), actor }); return target;
  });
  if (order) { logInfo('order.rejected', 'سفارش رد شد', { orderCode: order.code, actor }); await notify('rejected', order); }
  return order;
}

export async function removeReceiptFile(receipt) {
  if (receipt?.path) await fs.unlink(receipt.path).catch(() => {});
}
