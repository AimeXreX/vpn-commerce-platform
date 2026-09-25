# پلتفرم یکپارچه فروش VPN — وب‌سایت + Telegram Mini App + Bot

این پوشه نسخه‌ی مستقل پروژه است. فایل‌های وب‌سایت اصلی و بات Python مرجع هیچ تغییری نکرده‌اند. وب‌سایت، Mini App، بات مدیر/مشتری، سفارش‌ها، NOWPayments، 3x-ui و لاگ‌ها در این نسخه از یک هسته Node.js و یک منبع داده استفاده می‌کنند.

## قابلیت‌ها

- خرید از وب‌سایت، Mini App یا مستقیماً در چت بات
- پرداخت کارت‌به‌کارت با ارسال رسید در وب یا تلگرام
- پرداخت رمزارزی NOWPayments و تحویل خودکار بعد از IPN معتبر
- اعلان فوری رسید برای همه مدیران و تأیید/رد با دکمه‌های رنگی تلگرام
- تحویل لینک اشتراک در همان کانال خرید و نمایش در «سفارش‌های من»
- پنل مدیر تلگرام: سفارش‌ها، فروش، لاگ یکپارچه، ساخت/تمدید/حذف سرویس 3x-ui
- ثبت و حذف مدیر تلگرام از داشبورد وب؛ مدیریت مالک با `/addadmin` و `/deladmin`
- ارسال پیام همگانی rate-limited با غیرفعال‌سازی خودکار کاربران مسدودکننده
- Mini App کم‌حجم با تم تلگرام، safe area، haptic feedback و اعتبارسنجی امن `initData`
- لاگ JSONL مشترک برای وب، ربات، NOWPayments و 3x-ui

## راه‌اندازی

```bash
npm install
npm test
npm start
```

فایل `.env.example` فقط ساختار تنظیمات موردنیاز را نشان می‌دهد و هیچ مقدار عملیاتی یا محرمانه‌ای در مخزن قرار ندارد. آن را با نام `.env` کپی و مقادیر را فقط در محیط محلی یا Secret Manager سرور تنظیم کنید:

```dotenv
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_IDS=
TELEGRAM_OWNER_IDS=
TELEGRAM_MODE=polling
TELEGRAM_WEBHOOK_SECRET=
```

در توسعه، `TELEGRAM_MODE=polling` و `APP_URL=http://localhost:3000` کافی است. در سرور نهایی:

```dotenv
NODE_ENV=production
APP_URL=https://your-domain.example
TELEGRAM_MODE=webhook
```

سپس در BotFather:

1. توکن بات را بسازید.
2. Main Mini App را روی `https://your-domain.example/miniapp` تنظیم کنید.
3. دامنه Mini App را همان دامنه `APP_URL` قرار دهید؛ حفاظت origin جدید تلگرام با این ساختار سازگار است.
4. تصویر، توضیح کوتاه و ویدئوی preview بات را اضافه کنید تا صفحه بات نرخ تبدیل بهتری داشته باشد.

شناسه عددی تلگرام را می‌توان از پیام ورودی/لاگ یا بات‌های شناسه‌خوان دریافت کرد. اولین شناسه‌ی `TELEGRAM_ADMIN_IDS` در صورت خالی بودن `TELEGRAM_OWNER_IDS` مالک محسوب می‌شود.

## NOWPayments

تنظیمات سایت و بات مشترک است:

```dotenv
NOWPAYMENTS_API_KEY=
NOWPAYMENTS_IPN_SECRET=
NOWPAYMENTS_SANDBOX=true
NOWPAYMENTS_USD_RATE=190000
```

آدرس IPN:

```text
https://your-domain.example/api/payments/nowpayments/ipn
```

امضای `x-nowpayments-sig` با HMAC-SHA512 بررسی می‌شود. ابتدا sandbox را کامل آزمایش کنید و بعد `NOWPAYMENTS_SANDBOX=false` بگذارید. نرخ دلار به تومان باید مرتب به‌روز شود.

## مسیرها

- فروشگاه: `/`
- Mini App: `/miniapp`
- مدیریت وب: `/admin`
- لاگ‌ها: بخش «لاگ سیستم» در مدیریت وب یا گزینه «لاگ یکپارچه» در بات

## فرمان‌های مدیر در بات

- `/admin` — مرکز فرمان
- `/logs` — آخرین لاگ‌های وب و تلگرام
- `/broadcast متن پیام` — ارسال همگانی
- `/addadmin 123456789` — افزودن مدیر (فقط مالک)
- `/deladmin 123456789` — حذف مدیر (فقط مالک)
- `/cancel` — لغو عملیات جاری

## نکات استقرار

- HTTPS معتبر برای Mini App، webhook، NOWPayments و 3x-ui الزامی است.
- پشت reverse proxy مسیر webhook و IPN باید بدون cache و بدون challenge اضافی قابل دسترس باشند.
- پوشه‌های `data/`، `uploads/` و `logs/` را روزانه backup بگیرید.
- برای چند instance هم‌زمان، منبع JSON را پیش از scale-out به PostgreSQL یا SQLite WAL منتقل کنید؛ این نسخه برای یک process بهینه شده است.
- توکن‌ها، API key، IPN secret و فایل `.env` نباید وارد Git شوند.
