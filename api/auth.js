import { client, ensureSchema, findUser, hashPin, isPin, verifyPin } from './_auth.js';
import { pinFailure, setCors } from './_http.js';

const parseData = (raw) => {
  try {
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
};

export default async function handler(req, res) {
  setCors(req, res, 'POST,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const body = req.body || {};
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const pin = typeof body.pin === 'string' ? body.pin.trim() : '';

  if (!email || !email.includes('@')) {
    res.status(400).json({ error: 'email required' });
    return;
  }
  if (!isPin(pin)) {
    res.status(400).json({ error: 'pin must be 4 digits' });
    return;
  }

  try {
    await ensureSchema();
    const row = await findUser(email);

    // New email: this first PIN becomes the account's password.
    if (!row) {
      await client.execute({
        sql: 'INSERT INTO hind_users (email, data, pin_hash, updated_at) VALUES (?, ?, ?, ?)',
        args: [email, '{}', hashPin(pin), new Date().toISOString()],
      });
      res.status(200).json({ ok: true, created: true, data: null });
      return;
    }

    // Account from before PINs existed: the first PIN supplied claims it.
    if (!row.pin_hash) {
      await client.execute({
        sql: 'UPDATE hind_users SET pin_hash = ? WHERE email = ?',
        args: [hashPin(pin), row.email],
      });
      res.status(200).json({ ok: true, created: false, claimed: true, data: parseData(row.data) });
      return;
    }

    if (!verifyPin(pin, row.pin_hash)) {
      return pinFailure(req, res, email);
    }

    res.status(200).json({ ok: true, data: parseData(row.data) });
  } catch (error) {
    res.status(500).json({ error: 'auth failed' });
  }
}
