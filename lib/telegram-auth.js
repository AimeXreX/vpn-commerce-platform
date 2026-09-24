import crypto from 'node:crypto';

export function validateTelegramInitData(initData, botToken, maxAgeSeconds = 3600) {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const receivedHash = params.get('hash');
  if (!receivedHash || !/^[a-f0-9]{64}$/i.test(receivedHash)) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const expectedHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  try {
    if (!crypto.timingSafeEqual(Buffer.from(receivedHash, 'hex'), Buffer.from(expectedHash, 'hex'))) return null;
  } catch { return null; }
  const authDate = Number(params.get('auth_date'));
  if (!Number.isFinite(authDate) || Math.abs(Date.now() / 1000 - authDate) > maxAgeSeconds) return null;
  try {
    const user = JSON.parse(params.get('user') || 'null');
    return user?.id ? { user, authDate, queryId: params.get('query_id') || '' } : null;
  } catch { return null; }
}

export function telegramDisplayName(user = {}) {
  return [user.first_name, user.last_name].filter(Boolean).join(' ').trim() || user.username || `کاربر ${user.id}`;
}
