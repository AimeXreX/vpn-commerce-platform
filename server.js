import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import multer from 'multer';
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { z } from 'zod';
import { readStore, mutateStore, newId, now } from './lib/store.js';
import { testXui, getClientsLive } from './lib/xui.js';
import { verifyIpn } from './lib/nowpayments.js';
import { info as logInfo, warn as logWarn, error as logError, readLogs, logSummary, flushLogs } from './lib/logger.js';
import { validateTelegramInitData } from './lib/telegram-auth.js';
import { TelegramBot } from './lib/telegram.js';
import { createOrder, quoteOrder, publicOrder, attachReceipt, deliverOrder, rejectOrder, setOrderNotifier } from './lib/orders.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const production = process.env.NODE_ENV === 'production';
const jwtSecret = process.env.JWT_SECRET || 'development-only-secret-change-me';
const telegramInitDataMaxAge = Math.max(3600, Number(process.env.TELEGRAM_INIT_DATA_MAX_AGE_SECONDS) || 24 * 3600);
const loginAttempts = new Map();
await Promise.all([fs.mkdir(path.resolve('uploads'), { recursive: true }), fs.mkdir(path.resolve('data'), { recursive: true }), fs.mkdir(path.resolve('logs'), { recursive: true })]);

const telegram = new TelegramBot({
  token: process.env.TELEGRAM_BOT_TOKEN || '', appUrl: process.env.APP_URL || `http://localhost:${port}`,
  cardNumber: process.env.CARD_NUMBER, cardHolder: process.env.CARD_HOLDER, supportId: process.env.SUPPORT_ID
});
setOrderNotifier((type, order) => telegram.notify(type, order));

app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(helmet({
  contentSecurityPolicy: { directives: {
    "default-src": ["'self'"], "img-src": ["'self'", 'data:', 'blob:'], "script-src": ["'self'", 'https://telegram.org'],
    "style-src": ["'self'", "'unsafe-inline'"], "font-src": ["'self'", 'data:'], "connect-src": ["'self'"], "frame-ancestors": ["'self'", 'https://web.telegram.org']
  } }, crossOriginEmbedderPolicy: false, frameguard: false
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

app.post(telegram.webhookPath, async (req, res) => {
  if (!telegram.enabled) return res.status(404).end();
  const received = String(req.get('x-telegram-bot-api-secret-token') || '');
  const expected = telegram.webhookSecret;
  let valid = false;
  try { valid = received.length === expected.length && crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected)); } catch {}
  if (!valid) return res.status(401).end();
  res.json({ ok: true });
  telegram.handleUpdate(req.body).catch(error => telegram.handleError(error, req.body));
});

app.use('/api/', rateLimit({ windowMs: 60_000, limit: 500, standardHeaders: true, legacyHeaders: false }));
app.use('/api/', (req, res, next) => {
  const started = Date.now(); req.logId = crypto.randomBytes(5).toString('hex');
  const initData = String(req.get('x-telegram-init-data') || '');
  if (initData) req.telegram = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN || '', telegramInitDataMaxAge);
  res.on('finish', () => {
    if (req.path === '/admin/logs' || req.originalUrl.includes('/telegram/webhook/')) return;
    const elapsedMs = Date.now() - started;
    const safePath = req.originalUrl.split('?')[0].replace(/\/api\/orders\/V[A-F0-9]{12}/ig, '/api/orders/:code');
    const meta = { requestId: req.logId, method: req.method, path: safePath, status: res.statusCode, elapsedMs, ip: req.ip, telegramId: req.telegram?.user?.id, slow: elapsedMs >= 1000 };
    const writer = res.statusCode >= 500 ? logError : res.statusCode >= 400 ? logWarn : elapsedMs >= 1000 ? logWarn : logInfo;
    writer('http.request', `${req.method} ${safePath} → ${res.statusCode} (${elapsedMs}ms)`, meta);
  });
  next();
});

const upload = multer({
  storage: multer.diskStorage({ destination: 'uploads', filename: (_, file, cb) => cb(null, `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`) }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_, file, cb) => ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(file.mimetype) ? cb(null, true) : cb(new multer.MulterError('LIMIT_UNEXPECTED_FILE', 'receipt'))
});
const orderSchema = z.object({
  planId: z.string().min(1).max(80), name: z.string().trim().min(2).max(80),
  phone: z.string().trim().max(20).default(''), contact: z.string().trim().max(120).default(''), method: z.enum(['card', 'crypto']),
  discountCode: z.string().trim().max(40).optional(), renewalServiceId: z.string().trim().max(100).optional()
});
const loginSchema = z.object({ username: z.string().min(1).max(100), password: z.string().min(1).max(500) });
const planSchema = z.object({ name: z.string().trim().min(2).max(40), days: z.coerce.number().int().min(1).max(730), trafficGb: z.coerce.number().int().min(0).max(10000), unlimited: z.boolean().default(false), devices: z.coerce.number().int().min(1).max(50), price: z.coerce.number().int().min(1000), popular: z.boolean().default(false), active: z.boolean().default(true) }).refine(plan => plan.unlimited || plan.trafficGb >= 1, { message:'برای پلن حجمی حداقل یک گیگ وارد کنید' });
const telegramAdminSchema = z.object({ id: z.coerce.number().int().safe().positive() });
const discountSchema = z.object({
  code: z.string().trim().min(2).max(40).transform(x => x.toUpperCase()), type: z.enum(['percent', 'fixed']),
  value: z.coerce.number().positive(), usageLimit: z.coerce.number().int().positive().nullable().optional(),
  expiresAt: z.string().datetime().nullable().optional(), active: z.boolean().default(true)
}).refine(x => x.type !== 'percent' || x.value <= 100, { message: 'درصد تخفیف حداکثر ۱۰۰ است' });

function adminOnly(req, res, next) {
  try { req.admin = jwt.verify(req.cookies.admin_token || '', jwtSecret); next(); }
  catch { res.status(401).json({ error: 'ابتدا وارد حساب مدیریت شوید' }); }
}
function configPublic() {
  return {
    storeName: process.env.STORE_NAME || 'ProSySVPN', supportId: process.env.SUPPORT_ID || '@support',
    cardNumber: process.env.CARD_NUMBER || '', cardHolder: process.env.CARD_HOLDER || '', demoMode: process.env.DEMO_MODE === 'true',
    telegramEnabled: telegram.enabled, miniAppEnabled: telegram.enabled && String(process.env.APP_URL || '').startsWith('https://'),
    telegramBotUrl: (telegram.botUser?.username || process.env.TELEGRAM_BOT_USERNAME) ? `https://t.me/${String(telegram.botUser?.username || process.env.TELEGRAM_BOT_USERNAME).replace(/^@/, '')}` : '',
    telegramChannelUrl: process.env.TELEGRAM_REQUIRED_CHANNEL_URL || ''
  };
}

app.get('/api/public/config', async (_, res) => { const db = await readStore(); res.json({ ...configPublic(), plans: db.plans.filter(plan => plan.active) }); });
app.post('/api/public/quote', async (req, res) => { try { const quote = await quoteOrder(String(req.body?.planId || ''), String(req.body?.discountCode || '')); res.json({ originalAmount: quote.originalAmount, amount: quote.amount, discount: quote.discount }); } catch (error) { res.status(error.status || 400).json({ error: error.message }); } });
app.get('/api/health', (_, res) => res.set('Cache-Control', 'no-store').json({ ok: true, uptimeSeconds: Math.floor(process.uptime()), at: now() }));
app.post('/api/telegram/auth', async (req, res) => {
  const initData = String(req.body?.initData || req.get('x-telegram-init-data') || '');
  const auth = validateTelegramInitData(initData, process.env.TELEGRAM_BOT_TOKEN || '', telegramInitDataMaxAge);
  if (!auth) return res.status(401).json({ error: 'هویت تلگرام معتبر یا تازه نیست' });
  await telegram.registerUser(auth.user);
  if (!await telegram.hasRequiredMembership(auth.user.id)) return res.status(403).json({ error: 'برای استفاده از Mini App ابتدا عضو کانال شوید', joinRequired: true, channel: telegram.requiredChannel(), channelUrl: telegram.requiredChannelUrl() });
  res.json({ user: auth.user, isAdmin: await telegram.isAdmin(auth.user.id), language: await telegram.userLanguage(auth.user.id) });
});
app.post('/api/orders', async (req, res) => {
  if (req.get('x-telegram-init-data') && !req.telegram) return res.status(401).json({ error: 'اعتبار ورود تلگرام پایان یافته؛ Mini App را دوباره باز کنید' });
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'اطلاعات واردشده کامل یا معتبر نیست' });
  if (!req.telegram && (!/^09\d{9}$/.test(parsed.data.phone) || parsed.data.contact.length < 2)) return res.status(400).json({ error: 'شماره موبایل و راه ارتباطی معتبر وارد کنید' });
  if (req.telegram && !parsed.data.contact) parsed.data.contact = req.telegram.user.username ? `@${req.telegram.user.username}` : `tg:${req.telegram.user.id}`;
  try {
    const result = await createOrder({ ...parsed.data, source: req.telegram ? 'telegram-miniapp' : 'website' }, req.telegram?.user || null);
    res.status(201).json({ order: publicOrder(result.order), paymentUrl: result.paymentUrl });
  } catch (error) { res.status(error.status || 500).json({ error: error.message, ...(error.order ? { order: publicOrder(error.order) } : {}) }); }
});
app.post('/api/orders/:code/receipt', upload.single('receipt'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'تصویر یا PDF معتبر انتخاب کنید (حداکثر ۵ مگابایت)' });
  const updated = await attachReceipt(req.params.code, { file: req.file.filename, originalName: req.file.originalname, mime: req.file.mimetype, uploadedAt: now(), source: req.telegram ? 'telegram-miniapp' : 'website', size: req.file.size });
  if (!updated) { await fs.unlink(req.file.path).catch(() => {}); return res.status(404).json({ error: 'سفارش کارت‌به‌کارت قابل دریافت رسید پیدا نشد' }); }
  res.json({ order: publicOrder(updated) });
});
app.get('/api/orders/:code', async (req, res) => {
  const db = await readStore(); const order = db.orders.find(item => item.code === req.params.code.toUpperCase());
  if (!order) return res.status(404).json({ error: 'سفارشی با این کد پیدا نشد' });
  if (req.telegram && order.telegram?.id && order.telegram.id !== req.telegram.user.id) return res.status(403).json({ error: 'این سفارش متعلق به حساب شما نیست' });
  res.json(publicOrder(order));
});
app.get('/api/orders/:code/qr', async (req, res) => {
  const db = await readStore(); const order = db.orders.find(item => item.code === req.params.code.toUpperCase());
  if (!order || order.status !== 'delivered') return res.status(404).json({ error: 'سرویس آماده پیدا نشد' });
  if (req.telegram && order.telegram?.id && order.telegram.id !== req.telegram.user.id) return res.status(403).json({ error: 'این سفارش متعلق به حساب شما نیست' });
  const link = order.delivery?.subscriptionUrl || order.delivery?.configUrl;
  if (!link) return res.status(404).json({ error: 'لینک اشتراک موجود نیست' });
  res.type('png').set('Cache-Control', 'private, max-age=300').send(await QRCode.toBuffer(link, { width: 720, margin: 2, errorCorrectionLevel: 'M' }));
});
app.get('/api/telegram/orders', async (req, res) => {
  if (!req.telegram) return res.status(401).json({ error: 'ورود تلگرام معتبر نیست' });
  const db = await readStore(); res.json(db.orders.filter(order => order.telegram?.id === req.telegram.user.id).slice(0, 30).map(publicOrder));
});
app.get('/api/telegram/referral', async (req, res) => { if (!req.telegram) return res.status(401).json({ error:'ورود تلگرام معتبر نیست' }); res.json(await telegram.referralInfo(req.telegram.user.id)); });
app.get('/api/telegram/services', async (req, res) => {
  if (!req.telegram) return res.status(401).json({ error: 'ورود تلگرام معتبر نیست' });
  const db = await readStore();
  const services = db.services.filter(item => Number(item.ownerTelegramId) === Number(req.telegram.user.id));
  let liveByClient = new Map();
  try { liveByClient = await getClientsLive(services.map(service => service.delivery)); }
  catch (error) { logWarn('service.live_unavailable', 'وضعیت زنده سرویس‌ها دریافت نشد', { serviceCount: services.length, error: error.message }); }
  const result = services.map(service => {
    const live = liveByClient.get(service.delivery?.clientId) || null;
    return { id: service.id, orderCode: service.orderCode, plan: service.planSnapshot, subscriptionUrl: service.delivery?.subscriptionUrl, clientId: service.delivery?.clientId, createdAt: service.createdAt, expiryAt: live?.expiryTime ? new Date(live.expiryTime).toISOString() : service.expiryAt, active: live ? live.exists && live.enable && !live.expired : service.active, live };
  });
  res.json(result);
});
app.post('/api/telegram/services/:id/renew', async (req, res) => {
  if (!req.telegram) return res.status(401).json({ error: 'ورود تلگرام معتبر نیست' });
  const parsed = orderSchema.safeParse({ ...req.body, renewalServiceId: req.params.id });
  if (!parsed.success) return res.status(400).json({ error: 'اطلاعات تمدید معتبر نیست' });
  const db = await readStore();
  const service = db.services.find(item => item.id === req.params.id && Number(item.ownerTelegramId) === Number(req.telegram.user.id));
  if (!service) return res.status(404).json({ error: 'سرویس متعلق به شما پیدا نشد' });
  try { const result = await createOrder({ ...parsed.data, source: 'telegram-miniapp-renewal' }, req.telegram.user); res.status(201).json({ order: publicOrder(result.order), paymentUrl: result.paymentUrl }); }
  catch (error) { res.status(error.status || 500).json({ error: error.message }); }
});
app.post('/api/payments/nowpayments/ipn', async (req, res) => {
  if (!verifyIpn(req.body, req.get('x-nowpayments-sig'))) { logWarn('payment.ipn_rejected', 'امضای وب‌هوک NOWPayments نامعتبر بود', { orderCode: req.body?.order_id }); return res.status(401).json({ error: 'امضای وب‌هوک معتبر نیست' }); }
  const code = String(req.body.order_id || '').toUpperCase();
  await mutateStore(db => { const order = db.orders.find(item => item.code === code); if (order) { order.paymentStatus = req.body.payment_status; order.events.push({ type: `payment_${req.body.payment_status}`, at: now(), actor: 'nowpayments' }); } });
  if (['finished', 'confirmed'].includes(req.body.payment_status)) await deliverOrder(code, 'nowpayments');
  logInfo('payment.ipn_received', 'وضعیت پرداخت رمزارزی دریافت شد', { orderCode: code, paymentStatus: req.body.payment_status, paymentId: req.body.payment_id });
  res.json({ ok: true });
});

app.post('/api/admin/login', async (req, res) => {
  const attemptKey = req.ip || req.socket.remoteAddress || 'unknown'; const attempt = loginAttempts.get(attemptKey);
  if (attempt && attempt.count >= 10 && attempt.until > Date.now()) return res.status(429).json({ error: 'تلاش‌های ناموفق بیش از حد بود؛ ۱۵ دقیقه دیگر امتحان کنید' });
  if (attempt && attempt.until <= Date.now()) loginAttempts.delete(attemptKey);
  const parsed = loginSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'نام کاربری و رمز را وارد کنید' });
  const validUser = parsed.data.username === (process.env.ADMIN_USERNAME || 'admin'); const configured = process.env.ADMIN_PASSWORD || 'ChangeMe123!';
  const validPass = configured.startsWith('$2') ? await bcrypt.compare(parsed.data.password, configured) : crypto.timingSafeEqual(crypto.createHash('sha256').update(parsed.data.password).digest(), crypto.createHash('sha256').update(configured).digest());
  if (!validUser || !validPass) { const current = loginAttempts.get(attemptKey) || { count: 0, until: Date.now() + 15 * 60_000 }; current.count += 1; loginAttempts.set(attemptKey, current); logWarn('admin.login_failed', 'ورود ناموفق مدیر', { ip: req.ip, username: parsed.data.username, attempt: current.count }); return res.status(401).json({ error: 'نام کاربری یا رمز اشتباه است' }); }
  loginAttempts.delete(attemptKey); logInfo('admin.login_success', 'مدیر وارد پنل شد', { ip: req.ip, username: parsed.data.username });
  res.cookie('admin_token', jwt.sign({ role: 'admin' }, jwtSecret, { expiresIn: '12h' }), { httpOnly: true, secure: production, sameSite: 'strict', maxAge: 43_200_000 }); res.json({ ok: true });
});
app.post('/api/admin/logout', (_, res) => { res.clearCookie('admin_token'); res.json({ ok: true }); });
app.get('/api/admin/me', adminOnly, (_, res) => res.json({ authenticated: true }));
app.get('/api/admin/orders', adminOnly, async (_, res) => { const db = await readStore(); res.json(db.orders); });
app.get('/api/admin/logs', adminOnly, async (req, res) => { const limit = Math.min(Math.max(Number(req.query.limit) || 300, 1), 1000); res.json(await readLogs({ limit, level: req.query.level || undefined, event: req.query.event || undefined, search: req.query.search || undefined })); });
app.get('/api/admin/log-summary', adminOnly, async (req, res) => res.json(await logSummary({ hours: req.query.hours })));
app.get('/api/admin/overview', adminOnly, async (_, res) => {
  const db = await readStore(); const delivered = db.orders.filter(order => order.status === 'delivered'); const today = new Date().toISOString().slice(0, 10);
  res.json({ storeName: configPublic().storeName, demoMode: configPublic().demoMode, totalOrders: db.orders.length, reviewing: db.orders.filter(order => order.status === 'reviewing').length, delivered: delivered.length, revenue: delivered.reduce((sum, order) => sum + order.amount, 0), todayOrders: db.orders.filter(order => order.createdAt?.startsWith(today)).length, plans: db.plans, telegramUsers: db.telegramUsers.length, telegramEnabled: telegram.enabled });
});
app.post('/api/admin/plans', adminOnly, async (req, res) => { const parsed = planSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'اطلاعات پلن معتبر نیست' }); const plan = { id: newId('plan_').toLowerCase(), ...parsed.data }; await mutateStore(db => { if (plan.popular) db.plans.forEach(item => item.popular = false); db.plans.push(plan); }); res.status(201).json(plan); });
app.put('/api/admin/plans/:id', adminOnly, async (req, res) => { const parsed = planSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'اطلاعات پلن معتبر نیست' }); const result = await mutateStore(db => { const plan = db.plans.find(item => item.id === req.params.id); if (!plan) return null; if (parsed.data.popular) db.plans.forEach(item => item.popular = false); Object.assign(plan, parsed.data); return plan; }); if (!result) return res.status(404).json({ error: 'پلن پیدا نشد' }); res.json(result); });
app.get('/api/admin/discounts', adminOnly, async (_, res) => { const db = await readStore(); res.json(db.discounts); });
app.post('/api/admin/discounts', adminOnly, async (req, res) => { const parsed = discountSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: parsed.error.issues[0]?.message || 'کد تخفیف معتبر نیست' }); const item = { id: newId('dsc_'), ...parsed.data, usedCount: 0, createdAt: now() }; const exists = await mutateStore(db => { if (db.discounts.some(x => x.code === item.code)) return true; db.discounts.unshift(item); return false; }); if (exists) return res.status(409).json({ error: 'این کد قبلاً ثبت شده است' }); logInfo('discount.created', 'کد تخفیف در پنل ساخته شد', { code: item.code, type: item.type, value: item.value, usageLimit: item.usageLimit }); res.status(201).json(item); });
app.put('/api/admin/discounts/:id', adminOnly, async (req, res) => { const parsed = discountSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'کد تخفیف معتبر نیست' }); const item = await mutateStore(db => { const target = db.discounts.find(x => x.id === req.params.id); if (!target) return null; Object.assign(target, parsed.data); return target; }); if (!item) return res.status(404).json({ error: 'کد پیدا نشد' }); logInfo('discount.updated', 'کد تخفیف در پنل ویرایش شد', { code: item.code, active: item.active }); res.json(item); });
app.delete('/api/admin/discounts/:id', adminOnly, async (req, res) => { let code = ''; const removed = await mutateStore(db => { code = db.discounts.find(x => x.id === req.params.id)?.code || ''; const before = db.discounts.length; db.discounts = db.discounts.filter(x => x.id !== req.params.id); return db.discounts.length !== before; }); if (!removed) return res.status(404).json({ error: 'کد پیدا نشد' }); logInfo('discount.deleted', 'کد تخفیف از پنل حذف شد', { code }); res.json({ ok: true }); });
app.get('/api/admin/receipts/:file', adminOnly, (req, res) => res.sendFile(path.resolve('uploads', path.basename(req.params.file))));
app.post('/api/admin/orders/:code/approve', adminOnly, async (req, res) => { try { res.json(await deliverOrder(req.params.code, 'web-admin')); } catch (error) { res.status(error.status || 502).json({ error: error.message }); } });
app.post('/api/admin/orders/:code/reject', adminOnly, async (req, res) => { const result = await rejectOrder(req.params.code, req.body.reason, 'web-admin'); if (!result) return res.status(404).json({ error: 'سفارش پیدا نشد' }); res.json(result); });
app.post('/api/admin/test-xui', adminOnly, async (_, res) => { try { res.json({ ok: true, result: await testXui() }); } catch (error) { res.status(502).json({ error: error.message }); } });
app.get('/api/admin/telegram', adminOnly, async (_, res) => { const db = await readStore(); res.json({ enabled: telegram.enabled, username: telegram.botUser?.username || '', users: db.telegramUsers.length, activeUsers: db.telegramUsers.filter(user => user.active !== false).length, admins: await telegram.allAdminIds(), owners: telegram.ownerIds(), mode: (process.env.TELEGRAM_MODE || (production ? 'webhook' : 'polling')) }); });
app.post('/api/admin/telegram/admins', adminOnly, async (req, res) => { const parsed = telegramAdminSchema.safeParse(req.body); if (!parsed.success) return res.status(400).json({ error: 'Telegram User ID معتبر وارد کنید' }); await mutateStore(db => { db.settings.telegramAdmins = [...new Set([...(db.settings.telegramAdmins || []).map(Number), parsed.data.id])]; }); logInfo('admin.telegram_admin_added', 'مدیر تلگرام از پنل افزوده شد', { targetId: parsed.data.id }); res.status(201).json({ admins: await telegram.allAdminIds() }); });
app.delete('/api/admin/telegram/admins/:id', adminOnly, async (req, res) => { const id = Number(req.params.id); if (telegram.envAdminIds().includes(id)) return res.status(400).json({ error: 'مدیران تعریف‌شده در env را باید از تنظیمات سرور تغییر دهید' }); await mutateStore(db => { db.settings.telegramAdmins = (db.settings.telegramAdmins || []).map(Number).filter(item => item !== id); }); logInfo('admin.telegram_admin_removed', 'دسترسی مدیر تلگرام از پنل حذف شد', { targetId: id }); res.json({ admins: await telegram.allAdminIds() }); });
app.post('/api/admin/telegram/broadcast', adminOnly, async (req, res) => { const text = String(req.body?.text || '').trim(); if (text.length < 1 || text.length > 4000) return res.status(400).json({ error: 'متن پیام باید بین ۱ تا ۴۰۰۰ کاراکتر باشد' }); if (!telegram.enabled) return res.status(400).json({ error: 'بات تلگرام فعال نیست' }); telegram.broadcast('web-admin', text); res.status(202).json({ ok: true }); });

app.use(express.static(path.resolve('public'), { extensions: ['html'], etag: true, maxAge: production ? '1h' : 0, immutable: false }));
app.get('/admin', (_, res) => res.sendFile(path.resolve('public/admin.html')));
app.get('/miniapp', (_, res) => res.sendFile(path.resolve('public/miniapp.html')));
app.use((error, req, res, _next) => {
  logError('http.unhandled_error', 'خطای مدیریت‌نشده در درخواست', { requestId: req.logId, path: req.originalUrl, error: error.message });
  if (error instanceof multer.MulterError) return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'حجم فایل بیشتر از ۵ مگابایت است' : 'نوع یا تعداد فایل قابل قبول نیست' });
  res.status(500).json({ error: 'خطای غیرمنتظره؛ دوباره تلاش کنید' });
});

const server = app.listen(port, async () => {
  console.log(`VPN + Telegram platform is ready: http://localhost:${port}`);
  logInfo('system.started', 'پلتفرم یکپارچه وب و تلگرام اجرا شد', { port, nodeEnv: process.env.NODE_ENV || 'development', demoMode: process.env.DEMO_MODE === 'true', telegramEnabled: telegram.enabled });
  try {
    await telegram.start();
    setTimeout(() => telegram.checkServiceAlerts().catch(error => logWarn('service.alert_cycle_failed', 'چرخه هشدار اجرا نشد', { error: error.message })), 60_000).unref();
    setInterval(() => telegram.checkServiceAlerts().catch(error => logWarn('service.alert_cycle_failed', 'چرخه هشدار اجرا نشد', { error: error.message })), 6 * 3600_000).unref();
  } catch (error) { logError('telegram.start_failed', 'راه‌اندازی بات تلگرام شکست خورد', { error: error.message }); }
});
process.on('unhandledRejection', reason => logError('process.unhandled_rejection', 'Promise مدیریت‌نشده در پردازش ثبت شد', { error: reason instanceof Error ? reason.message : String(reason) }));
process.on('uncaughtExceptionMonitor', error => logError('process.uncaught_exception', 'خطای مدیریت‌نشده پردازش ثبت شد', { error: error.message, stack: error.stack }));
async function shutdown(signal) { logInfo('system.stopping', 'خاموش‌سازی امن سرویس آغاز شد', { signal }); telegram.polling = false; server.close(async () => { await flushLogs(); process.exit(0); }); setTimeout(() => process.exit(1), 10_000).unref(); }
process.once('SIGINT', () => shutdown('SIGINT')); process.once('SIGTERM', () => shutdown('SIGTERM'));
