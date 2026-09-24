import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import QRCode from 'qrcode';
import { readStore, mutateStore, newId, now } from './store.js';
import { createOrder, quoteOrder, publicOrder, attachReceipt, deliverOrder, rejectOrder } from './orders.js';
import { provision, getClientLive, updateClient, deleteClient } from './xui.js';
import { readLogs, info as logInfo, warn as logWarn, error as logError } from './logger.js';

const html = value => String(value ?? '').replace(/[&<>]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[char]);
const money = value => `${Number(value || 0).toLocaleString('fa-IR')} تومان`;
const statusText = { awaiting_receipt: 'در انتظار رسید', reviewing: 'در حال بررسی', awaiting_payment: 'در انتظار پرداخت', provisioning: 'در حال ساخت', delivered: 'تحویل‌شده', rejected: 'ردشده' };
const button = (text, callback_data, style) => ({ text, callback_data, ...(style ? { style } : {}) });
const rows = (...inline_keyboard) => ({ inline_keyboard });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const botCopy = {
  fa:{welcome:'خرید امن و دریافت آنی سرویس، داخل ربات یا Mini App.',shop:'✨ ورود به فروشگاه',buy:'🛍 خرید در ربات',orders:'📦 سفارش‌های من',support:'💬 پشتیبانی',language:'🌐 زبان',choose:'یک پلن انتخاب کنید',back:'بازگشت',days:'روز',devices:'اتصال',card:'کارت‌به‌کارت',crypto:'رمزارز',created:'✅ کانفیگ با موفقیت ایجاد شد',volume:'حجم',validity:'اعتبار',sub:'لینک ساب',myOrders:'سفارش‌های من'},
  en:{welcome:'Secure purchase and instant delivery in the bot or Mini App.',shop:'✨ Open store',buy:'🛍 Buy in bot',orders:'📦 My orders',support:'💬 Support',language:'🌐 Language',choose:'Choose a plan',back:'Back',days:'days',devices:'devices',card:'Card transfer',crypto:'Crypto',created:'✅ Configuration created successfully',volume:'Volume',validity:'Validity',sub:'Subscription link',myOrders:'My orders'},
  ru:{welcome:'Безопасная покупка и мгновенная доставка в боте или Mini App.',shop:'✨ Открыть магазин',buy:'🛍 Купить',orders:'📦 Мои заказы',support:'💬 Поддержка',language:'🌐 Язык',choose:'Выберите тариф',back:'Назад',days:'дней',devices:'устройств',card:'Перевод на карту',crypto:'Криптовалюта',created:'✅ Конфигурация успешно создана',volume:'Объём',validity:'Срок',sub:'Ссылка подписки',myOrders:'Мои заказы'},
  fr:{welcome:'Achat sécurisé et livraison instantanée dans le bot ou la Mini App.',shop:'✨ Ouvrir la boutique',buy:'🛍 Acheter',orders:'📦 Mes commandes',support:'💬 Assistance',language:'🌐 Langue',choose:'Choisissez un forfait',back:'Retour',days:'jours',devices:'appareils',card:'Virement bancaire',crypto:'Crypto',created:'✅ Configuration créée avec succès',volume:'Volume',validity:'Validité',sub:"Lien d’abonnement",myOrders:'Mes commandes'}
};
const botExtra={fa:{invoice:'فاکتور آماده است',afterNetwork:'پس از تأیید شبکه، سرویس خودکار ارسال می‌شود.',cardPay:'واریز کارت‌به‌کارت',amount:'مبلغ',cardNumber:'شماره کارت',cardHolder:'به نام',sendReceipt:'پس از واریز، تصویر رسید را همین‌جا ارسال کنید.',receiptSaved:'✅ رسید ثبت شد',receiptReview:'پس از بررسی مدیر، نتیجه همین‌جا ارسال می‌شود.',newPurchase:'خرید جدید',noOrders:'هنوز سفارشی ندارید.',order:'سفارش',plan:'پلن',status:'وضعیت'},en:{invoice:'Invoice ready',afterNetwork:'The service will be delivered automatically after network confirmation.',cardPay:'Card transfer',amount:'Amount',cardNumber:'Card number',cardHolder:'Card holder',sendReceipt:'After payment, send the receipt image here.',receiptSaved:'✅ Receipt submitted',receiptReview:'The result will be sent here after administrator review.',newPurchase:'New purchase',noOrders:'You have no orders yet.',order:'Order',plan:'Plan',status:'Status'},ru:{invoice:'Счёт готов',afterNetwork:'Сервис будет доставлен автоматически после подтверждения сети.',cardPay:'Перевод на карту',amount:'Сумма',cardNumber:'Номер карты',cardHolder:'Получатель',sendReceipt:'После оплаты отправьте изображение чека сюда.',receiptSaved:'✅ Чек отправлен',receiptReview:'Результат придёт сюда после проверки администратора.',newPurchase:'Новая покупка',noOrders:'Заказов пока нет.',order:'Заказ',plan:'Тариф',status:'Статус'},fr:{invoice:'Facture prête',afterNetwork:'Le service sera livré automatiquement après confirmation du réseau.',cardPay:'Virement bancaire',amount:'Montant',cardNumber:'Numéro de carte',cardHolder:'Titulaire',sendReceipt:'Après le paiement, envoyez la photo du reçu ici.',receiptSaved:'✅ Reçu envoyé',receiptReview:"Le résultat sera envoyé ici après vérification de l’administrateur.",newPurchase:'Nouvel achat',noOrders:'Vous n’avez aucune commande.',order:'Commande',plan:'Forfait',status:'Statut'}};
const bt = (lang, key) => botCopy[lang]?.[key] || botExtra[lang]?.[key] || botCopy.fa[key] || botExtra.fa[key] || key;
const planNames = { starter:{fa:'شروع',en:'Starter',ru:'Старт',fr:'Découverte'}, plus:{fa:'روزمره',en:'Everyday',ru:'Повседневный',fr:'Quotidien'}, pro:{fa:'حرفه‌ای',en:'Professional',ru:'Профессиональный',fr:'Professionnel'}, max:{fa:'حداکثر',en:'Maximum',ru:'Максимум',fr:'Maximum'} };
const localizedPlanName = (lang, plan = {}) => planNames[plan.id]?.[lang] || plan.name || plan.id || '—';
const localizedStatus = (lang, status) => ({
  fa:{awaiting_receipt:'در انتظار رسید',reviewing:'در حال بررسی',awaiting_payment:'در انتظار پرداخت',provisioning:'در حال ساخت',delivered:'تحویل‌شده',rejected:'ردشده'},
  en:{awaiting_receipt:'Awaiting receipt',reviewing:'Under review',awaiting_payment:'Awaiting payment',provisioning:'Creating service',delivered:'Delivered',rejected:'Rejected'},
  ru:{awaiting_receipt:'Ожидается чек',reviewing:'На проверке',awaiting_payment:'Ожидается оплата',provisioning:'Создание сервиса',delivered:'Доставлено',rejected:'Отклонено'},
  fr:{awaiting_receipt:'Reçu attendu',reviewing:'En cours de vérification',awaiting_payment:'Paiement attendu',provisioning:'Création du service',delivered:'Livré',rejected:'Refusé'}
}[lang]?.[status] || statusText[status] || status);
const localizedMoney = (lang, value) => `${Number(value || 0).toLocaleString(lang === 'fa' ? 'fa-IR' : lang)} ${lang === 'fa' ? 'تومان' : lang === 'ru' ? 'томан' : lang === 'fr' ? 'tomans' : 'Toman'}`;
const localizedTraffic = (lang, plan = {}) => plan.unlimited ? ({ fa:'نامحدود', en:'Unlimited', ru:'Безлимит', fr:'Illimité' }[lang] || 'Unlimited') : `${plan.trafficGb || 0}GB`;
const deliveryHint = lang => ({ fa:'لینک را در Hiddify یا v2rayNG وارد کنید و آن را با دیگران به اشتراک نگذارید. اگر اتصال برقرار نشد، پشتیبانی کنار شماست.', en:'Import the link into Hiddify or v2rayNG. Keep it private; support is ready if you need help.', ru:'Импортируйте ссылку в Hiddify или v2rayNG. Не передавайте её другим; при проблемах обратитесь в поддержку.', fr:'Importez le lien dans Hiddify ou v2rayNG. Gardez-le privé ; l’assistance reste disponible.' }[lang] || 'Import the link into Hiddify or v2rayNG. Keep it private.');
const discountText = (lang, key) => ({fa:{button:'🎟 کد تخفیف',prompt:'کد تخفیف را ارسال کنید.',applied:'✅ کد تخفیف اعمال شد',invalid:'کد تخفیف معتبر نیست'},en:{button:'🎟 Discount code',prompt:'Send your discount code.',applied:'✅ Discount applied',invalid:'Invalid discount code'},ru:{button:'🎟 Промокод',prompt:'Отправьте промокод.',applied:'✅ Промокод применён',invalid:'Неверный промокод'},fr:{button:'🎟 Code promo',prompt:'Envoyez votre code promo.',applied:'✅ Code promo appliqué',invalid:'Code promo invalide'}}[lang]?.[key] || key);
const customerText={
  fa:{join:'برای استفاده از ربات ابتدا عضو کانال شوید.',required:'کانال موردنیاز',joined:'عضویت شما تأیید شد ✅',joinButton:'📢 عضویت در کانال',verifyButton:'✅ عضو شدم؛ بررسی کن',notJoined:'هنوز عضویت شما تأیید نشد.',cancelled:'عملیات جاری لغو شد.',noAccess:'شما دسترسی مدیریت ندارید.',support:'پشتیبانی',useMenu:'از منوی زیر انتخاب کنید؛ برای پیگیری می‌توانید کد سفارش را هم بفرستید.',planUnavailable:'این پلن دیگر فعال نیست.',viewPlans:'مشاهده پلن‌ها',tryAgain:'تلاش دوباره',imageOnly:'فقط تصویر JPG/PNG/WebP یا PDF قابل قبول است.',fileTooLarge:'حجم فایل باید کمتر از ۵ مگابایت باشد.',receiptUnavailable:'سفارش قابل دریافت رسید نیست.',orderNotFound:'سفارش پیدا نشد.',refresh:'به‌روزرسانی',lowVolume:'حجم باقی‌مانده سرویس شما',expiresIn:'اعتبار سرویس شما به پایان می‌رسد؛ روز باقی‌مانده',renewHint:'برای تمدید یا افزایش حجم، Mini App را باز کنید.',renewService:'♻️ تمدید سرویس',receiptRejected:'رسید سفارش تأیید نشد.',temporaryError:'❌ خطای موقت رخ داد؛ دوباره تلاش کنید.'},
  en:{join:'Join the channel before using the bot.',required:'Required channel',joined:'Membership verified ✅',joinButton:'📢 Join channel',verifyButton:'✅ I joined; verify',notJoined:'Your membership is not verified yet.',cancelled:'Current operation cancelled.',noAccess:'You do not have administrator access.',support:'Support',useMenu:'Choose an option below. You can also send an order code to track it.',planUnavailable:'This plan is no longer available.',viewPlans:'View plans',tryAgain:'Try again',imageOnly:'Only JPG, PNG, WebP images or PDF files are accepted.',fileTooLarge:'The file must be smaller than 5 MB.',receiptUnavailable:'This order cannot accept a receipt.',orderNotFound:'Order not found.',refresh:'Refresh',lowVolume:'Your remaining service data is',expiresIn:'Your service expires soon; days remaining',renewHint:'Open the Mini App to renew or add data.',renewService:'♻️ Renew service',receiptRejected:'The order receipt was rejected.',temporaryError:'❌ A temporary error occurred. Please try again.'},
  ru:{join:'Перед использованием бота вступите в канал.',required:'Обязательный канал',joined:'Участие подтверждено ✅',joinButton:'📢 Вступить в канал',verifyButton:'✅ Я вступил; проверить',notJoined:'Участие пока не подтверждено.',cancelled:'Текущая операция отменена.',noAccess:'У вас нет доступа администратора.',support:'Поддержка',useMenu:'Выберите пункт ниже. Для отслеживания можно отправить код заказа.',planUnavailable:'Этот тариф больше недоступен.',viewPlans:'Посмотреть тарифы',tryAgain:'Повторить',imageOnly:'Допустимы только JPG, PNG, WebP или PDF.',fileTooLarge:'Размер файла должен быть меньше 5 МБ.',receiptUnavailable:'Для этого заказа нельзя отправить чек.',orderNotFound:'Заказ не найден.',refresh:'Обновить',lowVolume:'Остаток трафика',expiresIn:'Сервис скоро истекает; осталось дней',renewHint:'Откройте Mini App для продления или добавления трафика.',renewService:'♻️ Продлить сервис',receiptRejected:'Чек заказа отклонён.',temporaryError:'❌ Временная ошибка. Попробуйте ещё раз.'},
  fr:{join:'Rejoignez la chaîne avant d’utiliser le bot.',required:'Chaîne obligatoire',joined:'Adhésion vérifiée ✅',joinButton:'📢 Rejoindre la chaîne',verifyButton:'✅ J’ai rejoint ; vérifier',notJoined:'Votre adhésion n’est pas encore vérifiée.',cancelled:'Opération en cours annulée.',noAccess:'Vous n’avez pas les droits administrateur.',support:'Assistance',useMenu:'Choisissez une option ci-dessous. Vous pouvez aussi envoyer un code de commande.',planUnavailable:'Ce forfait n’est plus disponible.',viewPlans:'Voir les forfaits',tryAgain:'Réessayer',imageOnly:'Seuls les fichiers JPG, PNG, WebP ou PDF sont acceptés.',fileTooLarge:'Le fichier doit faire moins de 5 Mo.',receiptUnavailable:'Cette commande ne peut pas recevoir de reçu.',orderNotFound:'Commande introuvable.',refresh:'Actualiser',lowVolume:'Données restantes',expiresIn:'Le service expire bientôt ; jours restants',renewHint:'Ouvrez la Mini App pour renouveler ou ajouter des données.',renewService:'♻️ Renouveler',receiptRejected:'Le reçu de la commande a été refusé.',temporaryError:'❌ Une erreur temporaire est survenue. Réessayez.'}
};
const ct=(lang,key)=>customerText[lang]?.[key]||customerText.fa[key]||key;
const referralText={fa:{button:'🎁 دعوت و تخفیف',title:'دعوت کن، تخفیف بگیر',body:'۱ دعوت: ۵٪ برای یک سفارش\n۴ دعوت: ۱۰٪ برای یک سفارش\n۱۰ دعوت: ۲۰٪ برای پنج سفارش',count:'دعوت‌های موفق',rewards:'پاداش‌های آماده',share:'ارسال لینک دعوت'},en:{button:'🎁 Invite & save',title:'Invite friends, earn discounts',body:'1 invite: 5% for one order\n4 invites: 10% for one order\n10 invites: 20% for five orders',count:'Successful invites',rewards:'Available rewards',share:'Share invite link'},ru:{button:'🎁 Пригласить',title:'Приглашайте и получайте скидки',body:'1 приглашение: 5% на один заказ\n4 приглашения: 10% на один заказ\n10 приглашений: 20% на пять заказов',count:'Успешные приглашения',rewards:'Доступные награды',share:'Поделиться ссылкой'},fr:{button:'🎁 Inviter et économiser',title:'Invitez et gagnez des réductions',body:'1 invitation : 5% sur une commande\n4 invitations : 10% sur une commande\n10 invitations : 20% sur cinq commandes',count:'Invitations réussies',rewards:'Récompenses disponibles',share:'Partager le lien'}};
const rt=(lang,key)=>referralText[lang]?.[key]||referralText.fa[key]||key;

export class TelegramBot {
  constructor({ token, appUrl, cardNumber, cardHolder, supportId }) {
    this.token = token;
    this.appUrl = String(appUrl || '').replace(/\/+$/, '');
    this.cardNumber = cardNumber || '';
    this.cardHolder = cardHolder || '';
    this.supportId = supportId || '@support';
    this.apiBase = token ? `https://api.telegram.org/bot${token}` : '';
    this.fileBase = token ? `https://api.telegram.org/file/bot${token}` : '';
    this.sessions = new Map();
    this.polling = false;
    this.offset = 0;
    this.webhookSecret = process.env.TELEGRAM_WEBHOOK_SECRET || crypto.randomBytes(20).toString('hex');
    this.botUser = null;
    this.membershipCache = new Map();
    this.membershipGateReady = false;
  }

  get enabled() { return Boolean(this.token); }
  get webhookPath() { return `/api/telegram/webhook/${this.webhookSecret}`; }
  requiredChannel() { return String(process.env.TELEGRAM_REQUIRED_CHANNEL || '').trim(); }
  requiredChannelUrl() {
    const configured = String(process.env.TELEGRAM_REQUIRED_CHANNEL_URL || '').trim();
    const channel = this.requiredChannel();
    return configured || (channel.startsWith('@') ? `https://t.me/${channel.slice(1)}` : '');
  }
  envAdminIds() { return String(process.env.TELEGRAM_ADMIN_IDS || '').split(',').map(Number).filter(Number.isSafeInteger); }
  ownerIds() { const configured = String(process.env.TELEGRAM_OWNER_IDS || '').split(',').map(Number).filter(Number.isSafeInteger); return configured.length ? configured : this.envAdminIds().slice(0, 1); }

  async api(method, payload = {}, { timeout = 20000 } = {}) {
    if (!this.enabled) throw new Error('توکن بات تلگرام تنظیم نشده است');
    const response = await fetch(`${this.apiBase}/${method}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(timeout) });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || !data.ok) throw Object.assign(new Error(data.description || `Telegram API ${response.status}`), { status: response.status, telegram: data });
    return data.result;
  }

  async apiMultipart(method, fields, { data, filename, mime }) {
    if (!this.enabled) throw new Error('توکن بات تلگرام تنظیم نشده است');
    const form = new FormData();
    for (const [key, value] of Object.entries(fields)) form.append(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
    const fileField = method === 'sendDocument' ? 'document' : 'photo';
    form.append(fileField, new Blob([data], { type: mime }), filename);
    const response = await fetch(`${this.apiBase}/${method}`, { method: 'POST', body: form, signal: AbortSignal.timeout(30000) });
    const result = await response.json().catch(() => ({}));
    if (!response.ok || !result.ok) throw Object.assign(new Error(result.description || `Telegram API ${response.status}`), { status: response.status, telegram: result });
    return result.result;
  }

  send(chatId, text, reply_markup, extra = {}) { return this.api('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', link_preview_options: { is_disabled: true }, ...(reply_markup ? { reply_markup } : {}), ...extra }); }
  async edit(chatId, messageId, text, reply_markup) {
    const common = { chat_id: chatId, message_id: messageId, parse_mode: 'HTML', ...(reply_markup ? { reply_markup } : {}) };
    try {
      return await this.api('editMessageText', { ...common, text, link_preview_options: { is_disabled: true } });
    } catch (error) {
      // Repeated callback taps are harmless and should not become update failures.
      if (/message is not modified/i.test(error.message)) return false;
      // Receipt notifications are photos, so their body is a caption rather than text.
      if (/there is no text in the message to edit/i.test(error.message)) {
        try { return await this.api('editMessageCaption', { ...common, caption: text }); }
        catch (captionError) { if (/message is not modified/i.test(captionError.message)) return false; throw captionError; }
      }
      throw error;
    }
  }
  answerCallback(id, text = '', showAlert = false) { return this.api('answerCallbackQuery', { callback_query_id: id, ...(text ? { text } : {}), show_alert: showAlert }).catch(() => {}); }

  async start() {
    if (!this.enabled) { logWarn('telegram.disabled', 'بات تلگرام به‌دلیل نبودن توکن غیرفعال است'); return; }
    this.botUser = await this.api('getMe');
    await this.validateRequiredChannel();
    await this.api('setMyCommands', { commands: [
      { command: 'start', description: 'شروع و نمایش منو' }, { command: 'orders', description: 'سفارش‌های من' },
      { command: 'language', description: 'Language / زبان' }, { command: 'admin', description: 'پنل مدیریت' }, { command: 'logs', description: 'آخرین لاگ‌ها (مدیر)' }, { command: 'discounts', description: 'کدهای تخفیف (مالک)' }, { command: 'cancel', description: 'لغو عملیات جاری' }
    ] }).catch(error => logWarn('telegram.commands_failed', 'ثبت فرمان‌های بات ناموفق بود', { error: error.message }));
    if (this.appUrl.startsWith('https://')) await this.api('setChatMenuButton', { menu_button: { type: 'web_app', text: 'فروشگاه', web_app: { url: `${this.appUrl}/miniapp` } } }).catch(() => {});
    const configuredMode = (process.env.TELEGRAM_MODE || '').trim().toLowerCase();
    const useWebhook = configuredMode ? configuredMode === 'webhook' : (process.env.NODE_ENV === 'production' && this.appUrl.startsWith('https://'));
    if (useWebhook) {
      await this.api('setWebhook', { url: `${this.appUrl}${this.webhookPath}`, secret_token: this.webhookSecret, allowed_updates: ['message', 'callback_query'], drop_pending_updates: false });
      logInfo('telegram.webhook_started', 'وب‌هوک بات تلگرام فعال شد', { username: this.botUser.username });
    } else {
      await this.api('deleteWebhook', { drop_pending_updates: false }).catch(() => {});
      this.polling = true; this.pollLoop();
      logInfo('telegram.polling_started', 'بات تلگرام در حالت polling اجرا شد', { username: this.botUser.username });
    }
  }

  async pollLoop() {
    while (this.polling) {
      try {
        const updates = await this.api('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, { timeout: 35000 });
        for (const update of updates) { this.offset = update.update_id + 1; await this.handleUpdate(update).catch(error => this.handleError(error, update)); }
      } catch (error) { logError('telegram.poll_error', 'خطا در دریافت آپدیت تلگرام', { error: error.message }); await sleep(2500); }
    }
  }

  async registerUser(user) {
    if (!user?.id) return;
    await mutateStore(db => {
      let item = db.telegramUsers.find(entry => entry.id === Number(user.id));
      if (!item) { item = { id: Number(user.id), joinedAt: now(), active: true }; db.telegramUsers.push(item); }
      Object.assign(item, { username: user.username || '', firstName: user.first_name || '', lastName: user.last_name || '', languageCode: user.language_code || '', active: true, lastSeenAt: now() });
    });
  }

  async registerReferral(inviteeId, inviterId) {
    const invitee = Number(inviteeId), inviter = Number(inviterId);
    if (!Number.isSafeInteger(invitee) || !Number.isSafeInteger(inviter) || invitee === inviter) return null;
    const result = await mutateStore(db => {
      const invited = db.telegramUsers.find(user => Number(user.id) === invitee), owner = db.telegramUsers.find(user => Number(user.id) === inviter);
      if (!invited || !owner || invited.referredBy) return null;
      invited.referredBy = inviter; invited.referredAt = now();
      owner.referralCount = Number(owner.referralCount || 0) + 1; owner.referralRewards ||= []; owner.referralMilestones ||= [];
      const milestones = [{count:1,percent:5,orders:1},{count:4,percent:10,orders:1},{count:10,percent:20,orders:5}];
      const unlocked=[];
      for (const milestone of milestones) if (owner.referralCount >= milestone.count && !owner.referralMilestones.includes(milestone.count)) {
        owner.referralMilestones.push(milestone.count); const reward={id:newId('ref_'),milestone:milestone.count,percent:milestone.percent,remaining:milestone.orders,usedCount:0,createdAt:now()}; owner.referralRewards.push(reward); unlocked.push(reward);
      }
      return { inviter, invitee, count:owner.referralCount, unlocked };
    });
    if (result) { logInfo('referral.registered', 'دعوت موفق ثبت شد', { inviterId:inviter, inviteeId:invitee, referralCount:result.count, unlocked:result.unlocked.map(item=>item.percent) }); if(result.unlocked.length){const lang=await this.userLanguage(inviter);const rewards=result.unlocked.map(item=>`${item.percent}% × ${item.remaining}`).join(' · ');await this.send(inviter, `🎉 <b>${rt(lang,'rewards')}</b>\n${rewards}`, rows([button(rt(lang,'button'),'referral','success')])).catch(()=>{})} }
    return result;
  }

  async referralInfo(userId) {
    const db=await readStore(); const user=db.telegramUsers.find(item=>Number(item.id)===Number(userId));
    const username=this.botUser?.username || process.env.TELEGRAM_BOT_USERNAME || '';
    return { count:Number(user?.referralCount||0), rewards:(user?.referralRewards||[]).map(item=>({percent:item.percent,remaining:item.remaining,milestone:item.milestone})), link:username?`https://t.me/${username}?start=ref_${userId}`:'' };
  }

  async isAdmin(userId) { const db = await readStore(); return [...this.envAdminIds(), ...(db.settings.telegramAdmins || []).map(Number)].includes(Number(userId)); }
  async userLanguage(userId) { const db = await readStore(); const user=db.telegramUsers.find(item => item.id === Number(userId)); const preferred=user?.preferredLanguage; if (['fa','en','ru','fr'].includes(preferred)) return preferred; const detected=String(user?.languageCode||'').slice(0,2).toLowerCase(); return ['fa','en','ru','fr'].includes(detected) ? detected : 'fa'; }
  async allAdminIds() { const db = await readStore(); return [...new Set([...this.envAdminIds(), ...(db.settings.telegramAdmins || []).map(Number)])]; }
  async reachableAdminIds() {
    const db = await readStore();
    const admins = new Set([...this.envAdminIds(), ...this.ownerIds(), ...(db.settings.telegramAdmins || []).map(Number)]);
    return db.telegramUsers.filter(user => user.active !== false && admins.has(Number(user.id))).map(user => Number(user.id));
  }

  async hasRequiredMembership(userId, { fresh = false } = {}) {
    const channel = this.requiredChannel();
    if (!channel || !this.membershipGateReady || await this.isAdmin(userId)) return true;
    const cached = this.membershipCache.get(Number(userId));
    if (!fresh && cached?.expiresAt > Date.now()) return cached.value;
    try {
      const member = await this.api('getChatMember', { chat_id: channel, user_id: Number(userId) });
      const value = ['creator', 'administrator', 'member'].includes(member.status) || (member.status === 'restricted' && member.is_member === true);
      this.membershipCache.set(Number(userId), { value, expiresAt: Date.now() + (value ? 300_000 : 20_000) });
      return value;
    } catch (error) {
      logError('telegram.membership_check_failed', 'بررسی عضویت اجباری ناموفق بود', { telegramId: Number(userId), channel, error: error.message });
      return false;
    }
  }

  joinRequiredMenu(lang = 'fa') {
    const keyboard = [];
    if (this.requiredChannelUrl()) keyboard.push([{ text: ct(lang,'joinButton'), url: this.requiredChannelUrl() }]);
    keyboard.push([button(ct(lang,'verifyButton'), 'verifyjoin', 'success')]);
    return { inline_keyboard: keyboard };
  }

  joinRequiredText(lang = 'fa') { return `<b>${ct(lang,'join')}</b>\n\n${ct(lang,'required')}: ${html(this.requiredChannel())}`; }

  async validateRequiredChannel() {
    const channel = this.requiredChannel();
    if (!channel) { this.membershipGateReady = false; return true; }
    try {
      const member = await this.api('getChatMember', { chat_id: channel, user_id: this.botUser.id });
      this.membershipGateReady = ['creator', 'administrator'].includes(member.status);
      if (this.membershipGateReady) logInfo('telegram.membership_gate_ready', 'جوین اجباری فعال شد', { channel });
      else logWarn('telegram.membership_gate_inactive', 'جوین اجباری غیرفعال ماند؛ بات باید مدیر کانال باشد', { channel, botStatus: member.status });
    } catch (error) {
      this.membershipGateReady = false;
      logWarn('telegram.membership_gate_inactive', 'جوین اجباری غیرفعال ماند؛ دسترسی کانال موجود نیست', { channel, error: error.message });
    }
    return this.membershipGateReady;
  }

  customerMenu(lang = 'fa') {
    const keyboard = [];
    if (this.appUrl.startsWith('https://')) keyboard.push([{ text: bt(lang,'shop'), web_app: { url: `${this.appUrl}/miniapp` }, style: 'primary' }]);
    keyboard.push([button(bt(lang,'buy'), 'buy', 'success'), button(bt(lang,'orders'), 'myorders', 'primary')]);
    keyboard.push([button(rt(lang,'button'), 'referral', 'success')]);
    keyboard.push([button(bt(lang,'support'), 'support'), button(bt(lang,'language'), 'langmenu')]);
    return { inline_keyboard: keyboard };
  }

  adminMenu(owner = false) {
    return rows(
      ...(owner ? [[button('🧾 رسیدهای منتظر', 'admin:orders', 'danger'), button('🎟 کدهای تخفیف', 'admin:discounts', 'success')]] : []),
      [button('📊 آمار فروش', 'admin:stats', 'primary')],
      [button('➕ ساخت سرویس', 'admin:create', 'success'), button('🧩 سرویس‌ها', 'admin:services', 'primary')],
      [button('🗂 لاگ یکپارچه', 'admin:logs'), button('📣 پیام همگانی', 'admin:broadcast')],
      [button('🛍 نمای مشتری', 'home')]
    );
  }

  async handleUpdate(update) {
    const message = update.message;
    const callback = update.callback_query;
    const user = message?.from || callback?.from;
    if (!user) return;
    await this.registerUser(user);
    const lang = await this.userLanguage(user.id);
    const verify = callback?.data === 'verifyjoin';
    if (!await this.hasRequiredMembership(user.id, { fresh: verify })) {
      if (callback) await this.answerCallback(callback.id, ct(lang,'notJoined'), true);
      return this.send(message?.chat?.id || callback?.message?.chat?.id || user.id, this.joinRequiredText(lang), this.joinRequiredMenu(lang));
    }
    if (verify) {
      await this.answerCallback(callback.id, ct(lang,'joined'));
      return this.send(callback.message?.chat?.id || user.id, `<b>${ct(lang,'joined')}</b>\n${bt(lang, 'welcome')}`, this.customerMenu(lang));
    }
    if (message) return this.handleMessage(message);
    if (callback) return this.handleCallback(callback);
  }

  async handleMessage(message) {
    const userId = message.from.id;
    const text = (message.text || '').trim();
    const admin = await this.isAdmin(userId);
    const owner = this.ownerIds().includes(Number(userId));
    const lang = await this.userLanguage(userId);
    if (text === '/language') return this.send(userId, bt(lang,'language'), rows([button('فارسی','lang:fa'),button('English','lang:en')],[button('Русский','lang:ru'),button('Français','lang:fr')]));
    if (text === '/cancel') { this.sessions.delete(userId); return this.send(userId, ct(lang,'cancelled'), admin ? this.adminMenu(owner) : this.customerMenu(lang)); }
    if (text.startsWith('/start')) {
      this.sessions.delete(userId);
      const referralMatch=text.match(/^\/start\s+ref_(\d+)$/); if(referralMatch) await this.registerReferral(userId, Number(referralMatch[1]));
      logInfo('telegram.user_started', 'کاربر بات را شروع کرد', { telegramId: userId, username: message.from.username, isAdmin: admin });
      return this.send(userId, admin ? '<b>مرکز فرمان تلگرام آماده است.</b>\nوب‌سایت و بات از یک هسته و یک لاگ استفاده می‌کنند.' : `<b>سلام ${html(message.from.first_name)} 👋</b>\n${bt(lang,'welcome')}`, admin ? this.adminMenu(owner) : this.customerMenu(lang));
    }
    if (text === '/orders') return this.showMyOrders(userId);
    if (text === '/admin') return admin ? this.send(userId, '<b>پنل مدیریت</b>\nیک گزینه را انتخاب کنید.', this.adminMenu(owner)) : this.send(userId, ct(lang,'noAccess'), this.customerMenu(lang));
    if (text === '/logs') return admin ? this.showLogs(userId) : this.send(userId, 'این فرمان فقط برای مدیران است.');
    if (text.startsWith('/broadcast')) {
      if (!admin) return this.send(userId, 'این فرمان فقط برای مدیران است.');
      const body = text.replace(/^\/broadcast\s*/, '').trim();
      if (!body) return this.send(userId, 'متن را بعد از فرمان بنویسید:\n<code>/broadcast متن پیام</code>');
      this.broadcast(userId, body); return this.send(userId, '⏳ ارسال همگانی در پس‌زمینه آغاز شد.');
    }
    if (text.startsWith('/addadmin') || text.startsWith('/deladmin')) return this.manageAdminCommand(message, admin);
    if (text === '/discounts') return owner ? this.showDiscounts(userId) : this.send(userId, 'مدیریت تخفیف فقط برای مالک اصلی فعال است.');
    if (text.startsWith('/discount ')) return owner ? this.createDiscountCommand(message) : this.send(userId, 'ساخت تخفیف فقط برای مالک اصلی فعال است.');
    if (text.startsWith('/deldiscount ')) return owner ? this.deleteDiscountCommand(message) : this.send(userId, 'حذف تخفیف فقط برای مالک اصلی فعال است.');
    const session = this.sessions.get(userId);
    if (session?.action === 'discount_code' && text) {
      try {
        const quote = await quoteOrder(session.planId, text);
        this.sessions.set(userId, { action:'purchase_discount', planId:session.planId, discountCode:quote.discount.code });
        await this.send(userId, `${discountText(lang,'applied')}\n${bt(lang,'amount')}: <s>${localizedMoney(lang, quote.originalAmount)}</s> <b>${localizedMoney(lang, quote.amount)}</b>`);
        return this.choosePayment(userId, null, session.planId, lang, quote.discount.code);
      } catch { return this.send(userId, `❌ ${discountText(lang,'invalid')}\n${discountText(lang,'prompt')}`, rows([button(bt(lang,'back'), `plan:${session.planId}`)])); }
    }
    if (session?.action === 'receipt' && (message.photo?.length || message.document)) return this.receiveTelegramReceipt(message, session.orderCode);
    if (session?.action === 'broadcast' && admin) {
      this.sessions.delete(userId);
      this.broadcast(userId, { fromChatId: message.chat.id, messageId: message.message_id });
      return this.send(userId, '⏳ ارسال همگانی با حفظ فرمت و ایموجی‌ها آغاز شد.');
    }
    if (/^V[A-F0-9]{12}$/i.test(text)) return this.showOrder(userId, text.toUpperCase());
    return this.send(userId, admin ? 'از منوی مدیریت استفاده کنید یا /cancel را بزنید.' : ct(lang,'useMenu'), admin ? this.adminMenu(owner) : this.customerMenu(lang));
  }

  async handleCallback(callback) {
    const data = callback.data || '';
    const userId = callback.from.id;
    const admin = await this.isAdmin(userId);
    const owner = this.ownerIds().includes(Number(userId));
    const lang = await this.userLanguage(userId);
    await this.answerCallback(callback.id);
    const chatId = callback.message?.chat?.id || userId;
    const messageId = callback.message?.message_id;
    if (data === 'langmenu') return this.edit(chatId,messageId,bt(lang,'language'),rows([button('فارسی','lang:fa'),button('English','lang:en')],[button('Русский','lang:ru'),button('Français','lang:fr')]));
    if (data.startsWith('lang:')) { const selected=data.slice(5); if(!botCopy[selected]) return; await mutateStore(db=>{const item=db.telegramUsers.find(u=>u.id===Number(userId));if(item)item.preferredLanguage=selected}); return this.edit(chatId,messageId,bt(selected,'welcome'),this.customerMenu(selected)); }
    if (data === 'home') return this.edit(chatId, messageId, `<b>${bt(lang,'shop')}</b>\n${bt(lang,'welcome')}`, this.customerMenu(lang));
    if (data === 'buy') return this.showPlans(chatId, messageId, lang);
    if (data === 'myorders') return this.showMyOrders(chatId, messageId);
    if (data === 'referral') return this.showReferral(chatId, messageId, lang);
    if (data === 'support') return this.edit(chatId, messageId, `${ct(lang,'support')}: <b>${html(this.supportId)}</b>`, rows([button(bt(lang,'back'), 'home')]));
    if (data.startsWith('plan:')) return this.choosePayment(chatId, messageId, data.slice(5), lang);
    if (data.startsWith('discount:')) { const planId=data.slice(9); this.sessions.set(userId,{action:'discount_code',planId}); return this.edit(chatId,messageId,discountText(lang,'prompt'),rows([button(bt(lang,'back'),`plan:${planId}`)])); }
    if (data.startsWith('pay:')) { const [, planId, method] = data.split(':'); return this.buyInBot(callback.from, chatId, messageId, planId, method); }
    if (data.startsWith('order:')) return this.showOrder(chatId, data.slice(6), messageId);
    if (!admin) return this.answerCallback(callback.id, ct(lang,'noAccess'), true);
    if (data === 'admin') return this.edit(chatId, messageId, '<b>مرکز فرمان</b>\nهمه‌چیز با وب‌سایت همگام است.', this.adminMenu(owner));
    if (['admin:orders','admin:discounts'].includes(data) || /^(admord:|approve:|rejectask:|reject:)/.test(data)) {
      if (!owner) return this.answerCallback(callback.id, 'تأیید رسید و مدیریت تخفیف فقط برای مالک اصلی است', true);
    }
    if (data === 'admin:orders') return this.showPendingOrders(chatId, messageId);
    if (data === 'admin:discounts') return this.showDiscounts(chatId, messageId);
    if (data === 'admin:stats') return this.showStats(chatId, messageId);
    if (data === 'admin:logs') return this.showLogs(chatId, messageId);
    if (data === 'admin:broadcast') { this.sessions.set(userId, { action: 'broadcast' }); return this.edit(chatId, messageId, '<b>پیام همگانی</b>\nپیام را دقیقاً همان‌طور که باید به کاربران برسد بفرستید؛ فرمت، رسانه و Custom Emoji حفظ می‌شود.\nبرای لغو /cancel را بزنید.', rows([button('انصراف', 'admin', 'danger')])); }
    if (data === 'admin:create') return this.showVolumes(chatId, messageId);
    if (data === 'admin:services') return this.showServices(chatId, messageId);
    if (data.startsWith('admord:')) return this.showAdminOrder(chatId, messageId, data.slice(7));
    if (data.startsWith('approve:')) return this.approveFromBot(callback, data.slice(8));
    if (data.startsWith('rejectask:')) return this.edit(chatId, messageId, 'از رد کردن این سفارش مطمئن هستید؟', rows([button('بله، رد شود', `reject:${data.slice(10)}`, 'danger')], [button('بازگشت', `admord:${data.slice(10)}`)]));
    if (data.startsWith('reject:')) return this.rejectFromBot(callback, data.slice(7));
    if (data.startsWith('cfgv:')) { this.sessions.set(userId, { action: 'manual_config', volume: Number(data.slice(5)) }); return this.showDurations(chatId, messageId); }
    if (data.startsWith('cfgd:')) return this.createManualService(callback, Number(data.slice(5)));
    if (data.startsWith('svc:')) return this.showService(chatId, messageId, data.slice(4));
    if (data.startsWith('svcg:') || data.startsWith('svcd:')) return this.extendService(callback, data);
    if (data.startsWith('svcdelask:')) { const id = data.slice(10); return this.edit(chatId, messageId, 'حذف سرویس از پنل برگشت‌پذیر نیست. ادامه می‌دهید؟', rows([button('حذف قطعی', `svcdel:${id}`, 'danger')], [button('انصراف', `svc:${id}`)])); }
    if (data.startsWith('svcdel:')) return this.deleteService(callback, data.slice(7));
  }

  async showPlans(chatId, messageId, lang = 'fa') {
    const db = await readStore(); const plans = db.plans.filter(plan => plan.active);
    const markup = { inline_keyboard: [...plans.map(plan => [button(`${plan.popular ? '⭐ ' : ''}${localizedPlanName(lang, plan)} · ${localizedTraffic(lang, plan)} · ${localizedMoney(lang, plan.price)}`, `plan:${plan.id}`, plan.popular ? 'success' : undefined)]), [button(bt(lang,'back'), 'home')]] };
    return this.edit(chatId, messageId, `<b>${bt(lang,'choose')}</b>`, markup);
  }

  async showReferral(chatId, messageId, lang = 'fa') {
    const info=await this.referralInfo(chatId); const active=info.rewards.filter(item=>item.remaining>0);
    const rewardLine=active.length?active.map(item=>`${item.percent}% × ${item.remaining}`).join(' · '):'—';
    const text=`<b>${rt(lang,'title')}</b>\n\n${rt(lang,'body')}\n\n${rt(lang,'count')}: <b>${info.count}</b>\n${rt(lang,'rewards')}: <b>${rewardLine}</b>\n\n<code>${html(info.link)}</code>`;
    const share=info.link?`https://t.me/share/url?url=${encodeURIComponent(info.link)}&text=${encodeURIComponent(rt(lang,'title'))}`:'';
    const markup={inline_keyboard:[...(share?[[{text:rt(lang,'share'),url:share,style:'success'}]]:[]),[button(bt(lang,'back'),'home')]]};
    return messageId?this.edit(chatId,messageId,text,markup):this.send(chatId,text,markup);
  }

  async choosePayment(chatId, messageId, planId, lang = 'fa', discountCode = '') {
    const db = await readStore(); const plan = db.plans.find(item => item.id === planId && item.active);
    if (!plan) return this.edit(chatId, messageId, ct(lang,'planUnavailable'), rows([button(ct(lang,'viewPlans'), 'buy')]));
    let amount = plan.price, discountLine = '';
    if (discountCode) { try { const quote=await quoteOrder(planId,discountCode); amount=quote.amount; discountLine=`\n${discountText(lang,'applied')}: <code>${html(discountCode)}</code>`; } catch {} }
    const markup = rows([button(bt(lang,'card'), `pay:${plan.id}:card`, 'success'), button(bt(lang,'crypto'), `pay:${plan.id}:crypto`, 'primary')], [button(discountText(lang,'button'), `discount:${plan.id}`)], [button(bt(lang,'back'), 'buy')]);
    return messageId ? this.edit(chatId, messageId, `<b>${html(localizedPlanName(lang, plan))}</b>\n${localizedTraffic(lang, plan)} · ${plan.days} ${bt(lang,'days')} · ${plan.devices} ${bt(lang,'devices')}\n<b>${localizedMoney(lang, amount)}</b>${discountLine}`, markup) : this.send(chatId, `<b>${html(localizedPlanName(lang, plan))}</b>\n${localizedTraffic(lang, plan)} · ${plan.days} ${bt(lang,'days')}\n<b>${localizedMoney(lang, amount)}</b>${discountLine}`, markup);
  }

  async buyInBot(user, chatId, messageId, planId, method) {
    try {
      const lang = await this.userLanguage(user.id);
      const name = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || `Telegram ${user.id}`;
      const purchase = this.sessions.get(user.id); const discountCode = purchase?.action === 'purchase_discount' && purchase.planId === planId ? purchase.discountCode : '';
      const result = await createOrder({ planId, name, phone: '', contact: user.username ? `@${user.username}` : `tg:${user.id}`, method, discountCode, source: 'telegram-bot' }, user);
      this.sessions.delete(user.id);
      if (method === 'crypto') return this.edit(chatId, messageId, `<b>${bt(lang,'invoice')}</b>\n${bt(lang,'order')}: <code>${result.order.code}</code>\n${bt(lang,'afterNetwork')}`, { inline_keyboard: [[{ text: bt(lang,'crypto'), url: result.paymentUrl, style: 'success' }], [button(bt(lang,'myOrders'), `order:${result.order.code}`, 'primary')]] });
      this.sessions.set(user.id, { action: 'receipt', orderCode: result.order.code });
      return this.edit(chatId, messageId, `<b>${bt(lang,'cardPay')}</b>\n\n${bt(lang,'amount')}: <b>${localizedMoney(lang, result.order.amount)}</b>\n${bt(lang,'cardNumber')}: <code>${html(this.cardNumber || '—')}</code>\n${bt(lang,'cardHolder')}: ${html(this.cardHolder || '—')}\n\n${bt(lang,'sendReceipt')}\n${bt(lang,'order')}: <code>${result.order.code}</code>`, rows([button(bt(lang,'back'), 'home', 'danger')]));
    } catch { return this.edit(chatId, messageId, `❌ ${ct(lang,'temporaryError')}`, rows([button(ct(lang,'tryAgain'), 'buy')])); }
  }

  async receiveTelegramReceipt(message, code) {
    const lang = await this.userLanguage(message.from.id);
    const file = message.photo?.at(-1) || message.document;
    const mime = message.document?.mime_type || 'image/jpeg';
    if (!['image/jpeg', 'image/png', 'image/webp', 'application/pdf'].includes(mime)) return this.send(message.chat.id, ct(lang,'imageOnly'));
    if (Number(file.file_size || 0) > 5 * 1024 * 1024) return this.send(message.chat.id, ct(lang,'fileTooLarge'));
    try {
      const info = await this.api('getFile', { file_id: file.file_id });
      const response = await fetch(`${this.fileBase}/${info.file_path}`, { signal: AbortSignal.timeout(20000) });
      if (!response.ok) throw new Error('دانلود فایل از تلگرام ناموفق بود');
      const ext = mime === 'application/pdf' ? '.pdf' : path.extname(info.file_path) || '.jpg';
      const filename = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;
      const target = path.resolve('uploads', filename);
      await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
      const order = await attachReceipt(code, { file: filename, originalName: message.document?.file_name || `telegram-receipt${ext}`, mime, uploadedAt: now(), source: 'telegram-bot', telegramFileId: file.file_id, size: Number(file.file_size || 0) });
      if (!order) { await fs.unlink(target).catch(() => {}); throw new Error('سفارش قابل دریافت رسید نیست'); }
      this.sessions.delete(message.from.id);
      return this.send(message.chat.id, `<b>${bt(lang,'receiptSaved')}</b>\n${bt(lang,'order')}: <code>${order.code}</code>\n${bt(lang,'receiptReview')}`, rows([button(bt(lang,'myOrders'), `order:${order.code}`, 'primary'), button(bt(lang,'back'), 'home')]));
    } catch (error) { logError('telegram.receipt_failed', 'ثبت رسید تلگرامی شکست خورد', { orderCode: code, error: error.message }); return this.send(message.chat.id, `❌ ${ct(lang,'receiptUnavailable')}`); }
  }

  async showMyOrders(chatId, messageId) {
    const db = await readStore(); const list = db.orders.filter(order => order.telegram?.id === Number(chatId)).slice(0, 8);
    const lang = await this.userLanguage(chatId);
    const markup = { inline_keyboard: [...list.map(order => [button(`${order.code} · ${localizedStatus(lang, order.status)}`, `order:${order.code}`, order.status === 'delivered' ? 'success' : order.status === 'rejected' ? 'danger' : undefined)]), [button(bt(lang,'newPurchase'), 'buy', 'success'), button(bt(lang,'back'), 'home')]] };
    const text = list.length ? `<b>${bt(lang,'myOrders')}</b>\n${bt(lang,'choose')}` : `<b>${bt(lang,'noOrders')}</b>`;
    return messageId ? this.edit(chatId, messageId, text, markup) : this.send(chatId, text, markup);
  }

  async showOrder(chatId, code, messageId) {
    const db = await readStore(); const order = db.orders.find(item => item.code === code.toUpperCase());
    const lang = await this.userLanguage(chatId);
    if (!order || (order.telegram?.id && order.telegram.id !== Number(chatId) && !(await this.isAdmin(chatId)))) return this.send(chatId, ct(lang,'orderNotFound'));
    const link = order.delivery?.subscriptionUrl || order.delivery?.configUrl;
    const text = `<b>${bt(lang,'order')} ${order.code}</b>\n${bt(lang,'plan')}: ${html(localizedPlanName(lang, order.planSnapshot))}\n${bt(lang,'amount')}: ${localizedMoney(lang, order.amount)}\n${bt(lang,'status')}: <b>${localizedStatus(lang, order.status)}</b>${order.rejectionReason ? `\n${html(order.rejectionReason)}` : ''}${link ? `\n\n${bt(lang,'sub')}:\n<code>${html(link)}</code>` : ''}`;
    const markup = rows([button(ct(lang,'refresh'), `order:${order.code}`, 'primary')], [button(bt(lang,'myOrders'), 'myorders')]);
    return messageId ? this.edit(chatId, messageId, text, markup) : this.send(chatId, text, markup);
  }

  async showPendingOrders(chatId, messageId) {
    const db = await readStore(); const list = db.orders.filter(order => order.status === 'reviewing').slice(0, 12);
    const markup = { inline_keyboard: [...list.map(order => [button(`${order.code} · ${html(order.name)} · ${money(order.amount)}`, `admord:${order.code}`, 'danger')]), [button('بازگشت', 'admin')]] };
    return this.edit(chatId, messageId, list.length ? `<b>${list.length} رسید منتظر بررسی</b>` : '<b>رسید منتظری وجود ندارد ✅</b>', markup);
  }

  async showDiscounts(chatId, messageId) {
    const db = await readStore();
    const list = (db.discounts || []).slice(0, 20);
    const text = list.length ? `<b>🎟 کدهای تخفیف</b>\n\n${list.map(item => `<code>${html(item.code)}</code> · ${item.type === 'percent' ? `${item.value}٪` : money(item.value)} · ${item.active === false ? 'غیرفعال' : `${item.usedCount || 0}/${item.usageLimit || '∞'}`}`).join('\n')}\n\n<b>ساخت:</b>\n<code>/discount CODE percent 20 100 30</code>\nنوع، مقدار، سقف استفاده و روزهای اعتبار` : '<b>کد تخفیفی ثبت نشده است.</b>\n\nنمونه ساخت:\n<code>/discount SUMMER percent 20 100 30</code>';
    const markup = rows([button('بازگشت', 'admin')]);
    return messageId ? this.edit(chatId, messageId, text, markup) : this.send(chatId, text, markup);
  }

  async createDiscountCommand(message) {
    const [, rawCode, rawType, rawValue, rawLimit, rawDays] = message.text.trim().split(/\s+/);
    const code = String(rawCode || '').toUpperCase(), type = rawType === 'fixed' ? 'fixed' : rawType === 'percent' ? 'percent' : '';
    const value = Number(rawValue), usageLimit = rawLimit ? Number(rawLimit) : null, days = rawDays ? Number(rawDays) : null;
    if (!/^[A-Z0-9_-]{2,40}$/.test(code) || !type || !Number.isFinite(value) || value <= 0 || (type === 'percent' && value > 100) || (usageLimit !== null && (!Number.isInteger(usageLimit) || usageLimit < 1)) || (days !== null && (!Number.isInteger(days) || days < 1))) return this.send(message.chat.id, 'فرمت نامعتبر است.\n<code>/discount CODE percent 20 100 30</code>\nبرای تخفیف ثابت از <code>fixed</code> استفاده کنید. سقف و روزهای اعتبار اختیاری‌اند.');
    const item = { id: newId('dsc_'), code, type, value, usageLimit, expiresAt: days ? new Date(Date.now() + days * 86400000).toISOString() : null, active: true, usedCount: 0, createdAt: now() };
    const exists = await mutateStore(db => { if ((db.discounts || []).some(x => x.code === code)) return true; db.discounts.unshift(item); return false; });
    if (exists) return this.send(message.chat.id, 'این کد قبلاً ثبت شده است.');
    logInfo('discount.created', 'کد تخفیف از بات ساخته شد', { code, type, value, usageLimit, actor: `telegram-owner:${message.from.id}` });
    return this.send(message.chat.id, `✅ کد <code>${code}</code> ساخته شد.`, rows([button('مشاهده کدها', 'admin:discounts', 'primary')]));
  }

  async deleteDiscountCommand(message) {
    const code = String(message.text.trim().split(/\s+/)[1] || '').toUpperCase();
    const removed = await mutateStore(db => { const before = db.discounts.length; db.discounts = db.discounts.filter(item => item.code !== code); return db.discounts.length !== before; });
    if (!removed) return this.send(message.chat.id, 'کد تخفیف پیدا نشد.');
    logInfo('discount.deleted', 'کد تخفیف از بات حذف شد', { code, actor: `telegram-owner:${message.from.id}` });
    return this.send(message.chat.id, `کد <code>${html(code)}</code> حذف شد.`);
  }

  async showAdminOrder(chatId, messageId, code) {
    const db = await readStore(); const order = db.orders.find(item => item.code === code);
    if (!order) return this.edit(chatId, messageId, 'سفارش پیدا نشد.', rows([button('بازگشت', 'admin:orders')]));
    return this.edit(chatId, messageId, `<b>${order.code}</b>\nخریدار: ${html(order.name)}\nتماس: ${html(order.contact || order.phone || '—')}\nمبدأ: ${html(order.source || 'website')}\nپلن: ${html(order.planSnapshot?.name)}\nمبلغ: <b>${money(order.amount)}</b>\nوضعیت: ${statusText[order.status] || order.status}`, rows([button('تأیید و تحویل', `approve:${order.code}`, 'success'), button('رد رسید', `rejectask:${order.code}`, 'danger')], [button('بازگشت', 'admin:orders')]));
  }

  async approveFromBot(callback, code) {
    const chatId = callback.message.chat.id; const messageId = callback.message.message_id;
    await this.edit(chatId, messageId, '⏳ در حال ساخت و تحویل سرویس...');
    try { const order = await deliverOrder(code, `telegram-admin:${callback.from.id}`); return this.edit(chatId, messageId, `✅ سفارش <code>${order.code}</code> تحویل شد.`, rows([button('رسیدهای بعدی', 'admin:orders', 'primary'), button('پنل مدیریت', 'admin')])); }
    catch (error) { return this.edit(chatId, messageId, `❌ ${html(error.message)}`, rows([button('تلاش دوباره', `admord:${code}`)])); }
  }

  async rejectFromBot(callback, code) {
    const order = await rejectOrder(code, 'رسید پرداخت توسط مدیر تأیید نشد', `telegram-admin:${callback.from.id}`);
    return this.edit(callback.message.chat.id, callback.message.message_id, order ? `سفارش <code>${code}</code> رد شد.` : 'سفارش پیدا نشد.', rows([button('بازگشت', 'admin:orders')]));
  }

  async showStats(chatId, messageId) {
    const db = await readStore(); const delivered = db.orders.filter(order => order.status === 'delivered'); const today = new Date().toISOString().slice(0, 10);
    const text = `<b>آمار یکپارچه فروش</b>\n\nکل سفارش‌ها: ${db.orders.length}\nامروز: ${db.orders.filter(order => order.createdAt?.startsWith(today)).length}\nمنتظر بررسی: ${db.orders.filter(order => order.status === 'reviewing').length}\nتحویل موفق: ${delivered.length}\nدرآمد: <b>${money(delivered.reduce((sum, order) => sum + order.amount, 0))}</b>\nکاربران بات: ${db.telegramUsers.length}`;
    return this.edit(chatId, messageId, text, rows([button('به‌روزرسانی', 'admin:stats', 'primary')], [button('بازگشت', 'admin')]));
  }

  async showLogs(chatId, messageId) {
    const entries = await readLogs({ limit: 10 });
    const lines = entries.map(entry => `${entry.level === 'error' ? '🔴' : entry.level === 'warn' ? '🟡' : '🟢'} <code>${html(entry.event)}</code>\n${html(entry.message)}`).join('\n\n');
    const text = `<b>آخرین لاگ‌های وب‌سایت و بات</b>\n\n${lines || 'لاگی ثبت نشده است.'}`;
    return messageId ? this.edit(chatId, messageId, text.slice(0, 3900), rows([button('تازه‌سازی', 'admin:logs', 'primary')], [button('بازگشت', 'admin')])) : this.send(chatId, text.slice(0, 3900), rows([button('پنل مدیریت', 'admin')]));
  }

  showVolumes(chatId, messageId) { return this.edit(chatId, messageId, '<b>ساخت دستی سرویس</b>\nحجم را انتخاب کنید:', { inline_keyboard: [[10, 20, 30].map(value => button(`${value}GB`, `cfgv:${value}`)), [50, 70, 100].map(value => button(`${value}GB`, `cfgv:${value}`)), [button('انصراف', 'admin', 'danger')]] }); }
  showDurations(chatId, messageId) { return this.edit(chatId, messageId, 'مدت سرویس را انتخاب کنید:', { inline_keyboard: [[7, 15, 30].map(value => button(`${value} روز`, `cfgd:${value}`)), [60, 90, 180].map(value => button(`${value} روز`, `cfgd:${value}`)), [button('بازگشت', 'admin:create')]] }); }

  async createManualService(callback, days) {
    const session = this.sessions.get(callback.from.id); if (!session?.volume) return this.answerCallback(callback.id, 'اطلاعات منقضی شده است', true);
    const chatId = callback.message.chat.id; const messageId = callback.message.message_id; this.sessions.delete(callback.from.id);
    await this.edit(chatId, messageId, '⏳ در حال ساخت سرویس در 3x-ui...');
    try {
      const code = newId('A'); const plan = { name: 'ساخت دستی', trafficGb: session.volume, days, devices: 1 };
      const delivery = await provision({ code }, plan);
      const service = await mutateStore(db => { const item = { id: newId('svc_'), orderCode: null, ownerTelegramId: null, createdBy: `telegram:${callback.from.id}`, planSnapshot: plan, delivery, createdAt: now(), active: true }; db.services.unshift(item); return item; });
      logInfo('telegram.manual_service_created', 'مدیر از بات سرویس دستی ساخت', { telegramId: callback.from.id, serviceId: service.id, volume: session.volume, days });
      return this.edit(chatId, messageId, `<b>✅ سرویس ساخته شد</b>\n${session.volume} گیگ · ${days} روز\n\n<code>${html(delivery.subscriptionUrl || delivery.configUrl)}</code>`, rows([button('مشاهده سرویس‌ها', 'admin:services', 'primary'), button('ساخت بعدی', 'admin:create', 'success')]));
    } catch (error) { return this.edit(chatId, messageId, `❌ ${html(error.message)}`, rows([button('تلاش دوباره', 'admin:create')])); }
  }

  async showServices(chatId, messageId) {
    const db = await readStore(); const list = db.services.filter(service => service.active !== false).slice(0, 10);
    const markup = { inline_keyboard: [...list.map(service => [button(`${service.planSnapshot?.name || 'سرویس'} · ${service.planSnapshot?.trafficGb || 0}GB · ${service.orderCode || service.id.slice(-6)}`, `svc:${service.id}`, 'primary')]), [button('ساخت سرویس', 'admin:create', 'success'), button('بازگشت', 'admin')]] };
    return this.edit(chatId, messageId, list.length ? '<b>آخرین سرویس‌های فعال</b>' : 'سرویسی ثبت نشده است.', markup);
  }

  async showService(chatId, messageId, id) {
    const db = await readStore(); const service = db.services.find(item => item.id === id);
    if (!service) return this.edit(chatId, messageId, 'سرویس پیدا نشد.', rows([button('بازگشت', 'admin:services')]));
    let live; try { live = await getClientLive(service.delivery); } catch (error) { live = { error: error.message }; }
    const text = `<b>سرویس ${html(service.orderCode || service.id)}</b>\nحجم اولیه: ${service.planSnapshot?.trafficGb || 0}GB\nمدت: ${service.planSnapshot?.days || 0} روز\nوضعیت پنل: ${live.error ? `خطا: ${html(live.error)}` : live.exists ? (live.expired ? 'منقضی' : 'فعال') : 'پیدا نشد'}${live.usedGb != null ? `\nمصرف: ${live.usedGb} از ${live.totalGb}GB` : ''}\n\n<code>${html(service.delivery?.subscriptionUrl || service.delivery?.configUrl || '')}</code>`;
    return this.edit(chatId, messageId, text, rows([button('+۱۰ گیگ', `svcg:${id}:10`, 'success'), button('+۳۰ روز', `svcd:${id}:30`, 'success')], [button('حذف سرویس', `svcdelask:${id}`, 'danger')], [button('بازگشت', 'admin:services')]));
  }

  async extendService(callback, data) {
    const [kind, id, amountRaw] = data.split(':'); const amount = Number(amountRaw); const db = await readStore(); const service = db.services.find(item => item.id === id);
    if (!service) return this.answerCallback(callback.id, 'سرویس پیدا نشد', true);
    await this.edit(callback.message.chat.id, callback.message.message_id, '⏳ در حال تمدید...');
    try {
      await updateClient(service.delivery, kind === 'svcg' ? { addGb: amount } : { addDays: amount });
      await mutateStore(store => { const target = store.services.find(item => item.id === id); if (kind === 'svcg') target.planSnapshot.trafficGb = Number(target.planSnapshot.trafficGb || 0) + amount; else target.planSnapshot.days = Number(target.planSnapshot.days || 0) + amount; target.updatedAt = now(); });
      logInfo('telegram.service_extended', 'مدیر سرویس را از بات تمدید کرد', { telegramId: callback.from.id, serviceId: id, kind, amount });
      return this.showService(callback.message.chat.id, callback.message.message_id, id);
    } catch (error) { return this.edit(callback.message.chat.id, callback.message.message_id, `❌ ${html(error.message)}`, rows([button('بازگشت', `svc:${id}`)])); }
  }

  async deleteService(callback, id) {
    const db = await readStore(); const service = db.services.find(item => item.id === id); if (!service) return this.answerCallback(callback.id, 'سرویس پیدا نشد', true);
    try { await deleteClient(service.delivery); await mutateStore(store => { const target = store.services.find(item => item.id === id); target.active = false; target.deletedAt = now(); target.deletedBy = `telegram:${callback.from.id}`; }); logInfo('telegram.service_deleted', 'مدیر سرویس را از بات حذف کرد', { telegramId: callback.from.id, serviceId: id }); return this.edit(callback.message.chat.id, callback.message.message_id, '✅ سرویس حذف شد.', rows([button('فهرست سرویس‌ها', 'admin:services')])); }
    catch (error) { return this.edit(callback.message.chat.id, callback.message.message_id, `❌ ${html(error.message)}`, rows([button('بازگشت', `svc:${id}`)])); }
  }

  async broadcast(requesterId, content) {
    const db = await readStore(); const users = db.telegramUsers.filter(user => user.active !== false); let sent = 0; let failed = 0;
    const source = content && typeof content === 'object' ? content : null;
    logInfo('telegram.broadcast_started', 'ارسال پیام همگانی آغاز شد', { requesterId, recipients: users.length, mode: source ? 'copy' : 'text' });
    for (let index = 0; index < users.length; index += 25) {
      const batch = users.slice(index, index + 25);
      await Promise.all(batch.map(async user => { try {
        if (source) await this.api('copyMessage', { chat_id: user.id, from_chat_id: source.fromChatId, message_id: source.messageId });
        else await this.api('sendMessage', { chat_id: user.id, text: String(content || '') });
        sent += 1;
      } catch (error) { failed += 1; if ([400, 403].includes(error.status)) await mutateStore(store => { const target = store.telegramUsers.find(item => item.id === user.id); if (target) target.active = false; }); } }));
      if (index + 25 < users.length) await sleep(1100);
    }
    logInfo('telegram.broadcast_finished', 'ارسال پیام همگانی تمام شد', { requesterId, sent, failed });
    if (Number.isSafeInteger(Number(requesterId))) await this.send(Number(requesterId), `<b>ارسال همگانی تمام شد</b>\nموفق: ${sent}\nناموفق: ${failed}`, this.adminMenu()).catch(() => {});
  }

  async checkServiceAlerts() {
    if (!this.enabled) return { checked: 0, sent: 0 };
    const db = await readStore();
    const services = db.services.filter(item => item.active !== false && item.ownerTelegramId && item.delivery?.clientId);
    let sent = 0;
    for (const service of services) {
      try {
        const lang = await this.userLanguage(service.ownerTelegramId);
        const live = await getClientLive(service.delivery);
        if (!live?.exists) continue;
        const daysLeft = live.expiryTime ? Math.ceil((live.expiryTime - Date.now()) / 86400000) : null;
        const lowVolume = live.totalGb > 0 && (live.remainingGb <= 2 || live.remainingGb / live.totalGb <= 0.2);
        const expiryKey = daysLeft !== null && daysLeft <= 3 ? `${new Date(live.expiryTime).toISOString().slice(0, 10)}:${Math.max(daysLeft, 0)}` : null;
        const volumeKey = lowVolume ? String(Math.floor(live.remainingGb * 10)) : null;
        const state = service.alertState || {}, notices = [];
        if (expiryKey && state.expiryKey !== expiryKey) notices.push(`⏳ ${ct(lang,'expiresIn')}: ${Math.max(daysLeft, 0)}`);
        if (volumeKey && state.volumeKey !== volumeKey) notices.push(`⚠️ ${ct(lang,'lowVolume')}: ${live.remainingGb}GB`);
        if (!notices.length) continue;
        await this.send(service.ownerTelegramId, `${notices.join('\n')}\n\n${ct(lang,'renewHint')}`, { inline_keyboard: [[{ text: ct(lang,'renewService'), web_app: { url: `${this.appUrl}/miniapp#services` } }]] });
        await mutateStore(store => { const target = store.services.find(item => item.id === service.id); if (target) target.alertState = { ...(target.alertState || {}), ...(expiryKey ? { expiryKey } : {}), ...(volumeKey ? { volumeKey } : {}), lastSentAt: now() }; });
        sent++;
      } catch (error) { logWarn('telegram.service_alert_failed', 'ارسال هشدار سرویس ناموفق بود', { serviceId: service.id, error: error.message }); }
    }
    logInfo('telegram.service_alerts_checked', 'بررسی هشدار سرویس‌ها انجام شد', { checked: services.length, sent });
    return { checked: services.length, sent };
  }

  async manageAdminCommand(message, isAdmin) {
    const owner = this.ownerIds().includes(message.from.id); if (!isAdmin || !owner) return this.send(message.chat.id, 'مدیریت ادمین‌ها فقط برای مالک اصلی فعال است.');
    const [command, rawId] = message.text.split(/\s+/); const id = Number(rawId); if (!Number.isSafeInteger(id)) return this.send(message.chat.id, `فرمت صحیح:\n<code>${command} 123456789</code>`);
    await mutateStore(db => { const set = new Set((db.settings.telegramAdmins || []).map(Number)); command === '/addadmin' ? set.add(id) : set.delete(id); db.settings.telegramAdmins = [...set]; });
    logInfo('telegram.admins_changed', 'فهرست مدیران تلگرام تغییر کرد', { actorId: message.from.id, targetId: id, action: command });
    return this.send(message.chat.id, command === '/addadmin' ? `کاربر <code>${id}</code> مدیر شد.` : `دسترسی <code>${id}</code> حذف شد.`);
  }

  async notify(type, order) {
    if (!this.enabled) return;
    if (type === 'receipt') {
      // Bots cannot initiate a chat. A configured admin becomes reachable after
      // starting the bot once, which also registers them in telegramUsers.
      const owners = new Set(this.ownerIds());
      const admins = (await this.reachableAdminIds()).filter(id => owners.has(id));
      const caption = `<b>🧾 رسید تازه</b>\nسفارش: <code>${order.code}</code>\nخریدار: ${html(order.name)}\nمبلغ: ${money(order.amount)}\nمبدأ: ${html(order.source)}`;
      for (const adminId of admins) {
        try {
          if (order.receipt?.telegramFileId && order.receipt.mime !== 'application/pdf') await this.api('sendPhoto', { chat_id: adminId, photo: order.receipt.telegramFileId, caption, parse_mode: 'HTML', reply_markup: rows([button('تأیید و تحویل', `approve:${order.code}`, 'success'), button('رد رسید', `rejectask:${order.code}`, 'danger')]) });
          else if (order.receipt?.file) {
            const data = await fs.readFile(path.resolve('uploads', path.basename(order.receipt.file)));
            const document = order.receipt.mime === 'application/pdf';
            await this.apiMultipart(document ? 'sendDocument' : 'sendPhoto', { chat_id: adminId, caption, parse_mode: 'HTML', reply_markup: rows([button('تأیید و تحویل', `approve:${order.code}`, 'success'), button('رد رسید', `rejectask:${order.code}`, 'danger')]) }, { data, filename: order.receipt.originalName || order.receipt.file, mime: order.receipt.mime || 'image/jpeg' });
          } else await this.send(adminId, caption, rows([button('بررسی سفارش', `admord:${order.code}`, 'primary')]));
        } catch (error) { logWarn('telegram.admin_notify_failed', 'اعلان مدیر ارسال نشد', { adminId, orderCode: order.code, error: error.message }); }
      }
    }
    if (!order.telegram?.id) return;
    if (type === 'delivered') {
      const link = order.delivery?.subscriptionUrl || order.delivery?.configUrl;
      const lang = await this.userLanguage(order.telegram.id);
      const caption = `<b>${bt(lang,'created')}</b>\n\n📦 ${bt(lang,'volume')}: <b>${localizedTraffic(lang, order.planSnapshot)}</b>\n📅 ${bt(lang,'validity')}: <b>${order.planSnapshot?.days || 0} ${bt(lang,'days')}</b>\n🆔 UUID: <code>${html(order.delivery?.clientId || '—')}</code>\n\n🔗 ${bt(lang,'sub')}:\n<code>${html(link || '')}</code>\n\n${deliveryHint(lang)}`;
      try {
        const data = await QRCode.toBuffer(link || '', { width: 720, margin: 2, errorCorrectionLevel: 'M' });
        await this.apiMultipart('sendPhoto', { chat_id: order.telegram.id, caption, parse_mode: 'HTML', reply_markup: rows([button(bt(lang,'myOrders'), 'myorders', 'primary')]) }, { data, filename: `${order.code}-qr.png`, mime: 'image/png' });
      } catch (error) {
        logWarn('telegram.delivery_qr_failed', 'ارسال QR سرویس ناموفق بود؛ پیام متنی ارسال شد', { orderCode: order.code, error: error.message });
        await this.send(order.telegram.id, caption, rows([button(bt(lang,'myOrders'), 'myorders', 'primary')]));
      }
    }
    if (type === 'rejected') { const lang=await this.userLanguage(order.telegram.id); await this.send(order.telegram.id, `<b>${ct(lang,'receiptRejected')} ${order.code}</b>\n${ct(lang,'support')}: ${html(this.supportId)}`, rows([button(bt(lang,'support'), 'support', 'primary')])); }
  }

  async handleError(error, update) {
    logError('telegram.update_failed', 'پردازش آپدیت تلگرام شکست خورد', { updateId: update?.update_id, error: error.message });
    const chatId = update?.message?.chat?.id || update?.callback_query?.message?.chat?.id;
    if (chatId) { const lang=await this.userLanguage(chatId); await this.send(chatId, ct(lang,'temporaryError')).catch(() => {}); }
  }
}
