import crypto from 'node:crypto';

const apiBase = () => process.env.NOWPAYMENTS_SANDBOX === 'true' ? 'https://api-sandbox.nowpayments.io/v1' : 'https://api.nowpayments.io/v1';

export async function createCryptoPayment(order) {
  const returnBase = String(order.source || '').startsWith('telegram') ? `${process.env.APP_URL}/miniapp` : process.env.APP_URL;
  if (!process.env.NOWPAYMENTS_API_KEY) {
    if (process.env.DEMO_MODE === 'true') return { payment_id: `demo-${order.code}`, invoice_url: `${process.env.APP_URL}/?demo-payment=${order.code}`, payment_status: 'waiting' };
    throw new Error('کلید API درگاه NOWPayments تنظیم نشده است');
  }
  const response = await fetch(`${apiBase()}/invoice`, {
    method: 'POST',
    headers: { 'x-api-key': process.env.NOWPAYMENTS_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      price_amount: Number((order.amount / Number(process.env.NOWPAYMENTS_USD_RATE || 90000)).toFixed(2)), price_currency: 'usd', order_id: order.code,
      pay_currency: process.env.NOWPAYMENTS_PAY_CURRENCY || 'usdttrc20',
      order_description: `VPN plan ${order.planId}`,
      ipn_callback_url: `${process.env.APP_URL}/api/payments/nowpayments/ipn`,
      success_url: `${returnBase}?payment=success&order=${order.code}`,
      cancel_url: `${returnBase}?payment=cancel&order=${order.code}`
    })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'خطا در ساخت فاکتور رمزارز');
  return data;
}

function sortObject(value) {
  if (Array.isArray(value)) return value.map(sortObject);
  if (value && typeof value === 'object') return Object.keys(value).sort().reduce((a, k) => (a[k] = sortObject(value[k]), a), {});
  return value;
}

export function verifyIpn(body, signature) {
  const secret = process.env.NOWPAYMENTS_IPN_SECRET;
  if (!secret || !signature) return false;
  const hash = crypto.createHmac('sha512', secret).update(JSON.stringify(sortObject(body))).digest('hex');
  try { return crypto.timingSafeEqual(Buffer.from(hash), Buffer.from(signature)); } catch { return false; }
}
