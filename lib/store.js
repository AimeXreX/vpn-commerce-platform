import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const root = path.resolve(process.env.DATA_DIR || 'data');
const file = path.join(root, 'store.json');
let queue = Promise.resolve();

const seed = {
  plans: [
    { id: 'starter', name: 'شروع', days: 30, trafficGb: 5, devices: 1, price: 39000, popular: false, active: true },
    { id: 'plus', name: 'روزمره', days: 30, trafficGb: 20, devices: 1, price: 89000, popular: true, active: true },
    { id: 'pro', name: 'حرفه‌ای', days: 30, trafficGb: 50, devices: 2, price: 169000, popular: false, active: true },
    { id: 'max', name: 'حداکثر', days: 60, trafficGb: 100, devices: 3, price: 289000, popular: false, active: true }
  ],
  orders: [],
  services: [],
  discounts: [],
  telegramUsers: [],
  settings: { telegramAdmins: [] }
};

async function ensure() {
  await fs.mkdir(root, { recursive: true });
  try { await fs.access(file); } catch { await fs.writeFile(file, JSON.stringify(seed, null, 2), { mode: 0o600 }); }
}

export async function readStore() {
  await ensure();
  const db = JSON.parse(await fs.readFile(file, 'utf8'));
  db.plans ||= [];
  db.orders ||= [];
  db.services ||= [];
  db.discounts ||= [];
  db.telegramUsers ||= [];
  db.settings ||= {};
  db.settings.telegramAdmins ||= [];
  return db;
}

export function mutateStore(fn) {
  const operation = queue.catch(() => {}).then(async () => {
    const db = await readStore();
    const result = await fn(db);
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(db, null, 2), { mode: 0o600 });
      await fs.rename(tmp, file);
    } catch (error) {
      await fs.unlink(tmp).catch(() => {});
      throw error;
    }
    return result;
  });
  // Keep the internal chain usable after a rejected mutation while returning
  // the original rejection to its caller.
  queue = operation.catch(() => {});
  return operation;
}

export const newId = (prefix = '') => prefix + crypto.randomBytes(6).toString('hex').toUpperCase();
export const now = () => new Date().toISOString();
