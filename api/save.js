import { client, findUser, isPin, verifyPin } from './_auth.js';
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

  const { email, pin, players, currentRound, roundsHistory, savedNames, stats, daysHistory, currentGameHands, gameStartedAt, lastRoundEndTime, statsCommittedRounds, handsCountedForGame } = req.body || {};
  const address = typeof email === 'string' ? email.trim().toLowerCase() : '';
  if (!address) {
    res.status(400).json({ error: 'email required' });
    return;
  }
  if (!isPin(pin)) {
    res.status(401).json({ error: 'pin required' });
    return;
  }

  try {
    // Saves are refused without the account PIN, so nobody can overwrite (or wipe)
    // someone's stats just by knowing their email. Login through /api/auth first.
    const row = await findUser(address);
    if (!row || !verifyPin(pin, row.pin_hash)) {
      return pinFailure(req, res, address);
    }

    await client.execute({
      sql: 'UPDATE hind_users SET data = ?, updated_at = ? WHERE email = ?',
      args: [
        JSON.stringify({ players, currentRound, roundsHistory, savedNames, stats, daysHistory, currentGameHands, gameStartedAt, lastRoundEndTime, statsCommittedRounds, handsCountedForGame }),
        new Date().toISOString(),
        row.email,
      ],
    });

    res.status(200).json({ ok: true });
  } catch (error) {
    res.status(500).json({ error: 'save failed' });
  }
}
