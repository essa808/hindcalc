const attempts = new Map();

export function allowAttempt(key, limit, windowMs) {
  const now = Date.now();
  const recent = (attempts.get(key) || []).filter((t) => now - t < windowMs);
  if (recent.length >= limit) {
    attempts.set(key, recent);
    return false;
  }
  recent.push(now);
  attempts.set(key, recent);
  if (attempts.size > 5000) {
    for (const [k, list] of attempts) {
      if (!list.length || now - list[list.length - 1] > windowMs) attempts.delete(k);
    }
  }
  return true;
}

export function clientIp(req) {
  const forwarded = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || (req.socket && req.socket.remoteAddress) || 'unknown';
}

export function setCors(req, res, methods) {
  const allowed = String(process.env.ALLOWED_ORIGIN || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  const origin = req.headers.origin;
  if (origin && allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', methods);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export function pinFailure(req, res, email, asText) {
  const allowed =
    allowAttempt(`pin-fail-ip:${clientIp(req)}`, 20, 10 * 60 * 1000) &&
    allowAttempt(`pin-fail-user:${email}`, 10, 10 * 60 * 1000);
  if (!allowed) {
    return res.status(429).json({ error: 'too_many_attempts' });
  }
  if (asText) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.status(401).send('الرقم السري غير صحيح');
  }
  return res.status(401).json({ error: 'wrong_pin' });
}
