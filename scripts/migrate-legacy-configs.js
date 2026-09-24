import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';

const legacyPath = process.argv[2] || '/root/xui-bot/xui-bot/xui_bot/xui_bot/bot_database.sqlite';
const storePath = new URL('../data/store.json', import.meta.url);
const legacy = new DatabaseSync(legacyPath, { readOnly: true });
const rows = legacy.prepare('SELECT * FROM configs ORDER BY id').all();
legacy.close();

const db = JSON.parse(await fs.readFile(storePath, 'utf8'));
db.orders ||= [];
db.services ||= [];
const migrated = new Set(db.services.filter(x => x.migration?.source === 'legacy-xui-bot').map(x => Number(x.migration.legacyId)));
const inboundIds = String(process.env.XUI_INBOUND_ID || '').split(',').map(Number).filter(Number.isFinite);
const subBase = String(process.env.XUI_PUBLIC_SUB_URL || '').replace(/\/$/, '');
let added = 0;

for (const row of rows) {
  if (migrated.has(Number(row.id))) continue;
  const createdAt = new Date(Number(row.created_at) * 1000).toISOString();
  const expiryAt = new Date(Number(row.expiry_ms)).toISOString();
  const hash = crypto.createHash('sha256').update(String(row.uuid)).digest('hex').slice(0, 12).toUpperCase();
  const code = `V${hash}`;
  const planSnapshot = {
    id: 'legacy', name: 'سرویس انتقال‌یافته', days: Number(row.duration_days),
    trafficGb: Number(row.volume_gb), devices: 1, price: 0, active: false
  };
  const delivery = {
    clientId: String(row.uuid), subId: String(row.sub_id), clientEmail: String(row.email),
    inboundIds, subscriptionUrl: `${subBase}/${row.sub_id}`, configUrl: '', migrated: true
  };
  const migration = { source: 'legacy-xui-bot', legacyId: Number(row.id), migratedAt: new Date().toISOString() };
  const telegram = { id: Number(row.admin_id), username: '', firstName: '', lastName: '' };
  db.orders.push({
    id: `ord_legacy_${row.id}`, code, planId: 'legacy', name: `Legacy ${row.admin_id}`,
    phone: '', contact: `tg:${row.admin_id}`, method: 'legacy', amount: 0, planSnapshot,
    status: 'delivered', source: 'legacy-xui-bot', telegram, createdAt, paidAt: createdAt,
    deliveredAt: createdAt, delivery, migration,
    events: [{ type: 'migrated', at: migration.migratedAt, actor: 'migration:legacy-xui-bot' }]
  });
  db.services.push({
    id: `svc_legacy_${row.id}`, orderCode: code, ownerTelegramId: Number(row.admin_id),
    createdBy: 'migration:legacy-xui-bot', planSnapshot, delivery, createdAt,
    expiryAt, active: Number(row.expiry_ms) > Date.now(), migration, alertState: {}
  });
  added++;
}

const tmp = new URL(`../data/store.json.${process.pid}.tmp`, import.meta.url);
await fs.writeFile(tmp, JSON.stringify(db, null, 2));
await fs.rename(tmp, storePath);
console.log(JSON.stringify({ legacyRows: rows.length, added, totalOrders: db.orders.length, totalServices: db.services.length }));
