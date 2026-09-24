import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = path.resolve('logs');
let queue = Promise.resolve();
const secrets = ['authorization','token','password','secret','cookie','apiKey','api_key'];
const retentionDays = Math.max(7, Number(process.env.LOG_RETENTION_DAYS) || 30);
let lastCleanupDay = '';

function clean(value, depth = 0) {
  if (depth > 5) return '[depth-limit]';
  if (Array.isArray(value)) return value.slice(0, 30).map(v => clean(v, depth + 1));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, secrets.some(s => k.toLowerCase().includes(s.toLowerCase())) ? '[REDACTED]' : clean(v, depth + 1)]));
  if (typeof value === 'string') return value.length > 1500 ? `${value.slice(0,1500)}…` : value;
  return value;
}

export function log(level, event, message, meta = {}) {
  const entry = { id: crypto.randomBytes(5).toString('hex'), at: new Date().toISOString(), level, event, message, meta: clean(meta) };
  queue = queue.then(async () => {
    await fs.mkdir(dir, { recursive: true, mode: 0o750 });
    const day = entry.at.slice(0,10), file = path.join(dir, `app-${day}.jsonl`);
    await fs.appendFile(file, `${JSON.stringify(entry)}\n`, { encoding: 'utf8', mode: 0o640 });
    if (lastCleanupDay !== day) { lastCleanupDay = day; await cleanupOldLogs(); }
  }).catch(console.error);
  const line = `[${entry.at}] ${level.toUpperCase()} ${event}: ${message}`;
  level === 'error' ? console.error(line, entry.meta) : console.log(line);
  return entry.id;
}

async function cleanupOldLogs() {
  const cutoff = Date.now() - retentionDays * 86400000;
  const files = await fs.readdir(dir).catch(() => []);
  await Promise.all(files.filter(file => /^app-\d{4}-\d{2}-\d{2}\.jsonl$/.test(file) && Date.parse(file.slice(4,14)) < cutoff).map(file => fs.unlink(path.join(dir, file)).catch(() => {})));
}
export const info = (event,message,meta) => log('info',event,message,meta);
export const warn = (event,message,meta) => log('warn',event,message,meta);
export const error = (event,message,meta) => log('error',event,message,meta);

export async function readLogs({ limit = 300, level, event, search } = {}) {
  await fs.mkdir(dir, { recursive: true });
  const files = (await fs.readdir(dir)).filter(f => /^app-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().reverse().slice(0,14);
  const entries = [];
  for (const file of files) {
    const text = await fs.readFile(path.join(dir,file),'utf8');
    for (const line of text.trim().split('\n').reverse()) { if (!line) continue; try { const e=JSON.parse(line); if (level && e.level!==level) continue; if (event && e.event!==event) continue; if (search && !JSON.stringify(e).toLowerCase().includes(search.toLowerCase())) continue; entries.push(e); if(entries.length>=limit)return entries; } catch {} }
  }
  return entries;
}

export async function logSummary({ hours = 24 } = {}) {
  const since = Date.now() - Math.min(Math.max(Number(hours) || 24, 1), 336) * 3600000;
  const entries = await readLogs({ limit: 10000 });
  const recent = entries.filter(entry => Date.parse(entry.at) >= since);
  const levels = { info: 0, warn: 0, error: 0 };
  const events = {};
  let slowRequests = 0, maxRequestMs = 0;
  for (const entry of recent) {
    levels[entry.level] = (levels[entry.level] || 0) + 1;
    events[entry.event] = (events[entry.event] || 0) + 1;
    if (entry.event === 'http.request') {
      const elapsed = Number(entry.meta?.elapsedMs || 0);
      if (elapsed >= 1000) slowRequests++;
      maxRequestMs = Math.max(maxRequestMs, elapsed);
    }
  }
  return { hours: Math.min(Math.max(Number(hours) || 24, 1), 336), total: recent.length, levels, slowRequests, maxRequestMs, topEvents: Object.entries(events).sort((a,b) => b[1] - a[1]).slice(0,10).map(([event,count]) => ({ event, count })) };
}

export async function flushLogs() { await queue; }
