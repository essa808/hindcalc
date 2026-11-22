import { findUser, isPin, verifyPin } from './_auth.js';
import { pinFailure, setCors } from './_http.js';

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
  if (!email) {
    res.status(400).json({ error: 'email required' });
    return;
  }
  if (!isPin(pin)) {
    res.status(401).json({ error: 'pin required' });
    return;
  }

  try {
    const row = await findUser(email);
    if (!row || !verifyPin(pin, row.pin_hash)) {
      return pinFailure(req, res, email);
    }

    let data = null;
    try {
      data = row.data ? JSON.parse(row.data) : null;
    } catch (e) {
      data = null;
    }
    res.status(200).json({ data });
  } catch (error) {
    res.status(500).json({ error: 'load failed' });
  }
}
