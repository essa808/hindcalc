import { findUser, isPin, verifyPin } from './_auth.js';
import { pinFailure, setCors } from './_http.js';

const AR_DIGITS = '٠١٢٣٤٥٦٧٨٩';
const toEnDigits = (value) => String(value || '').replace(/[٠-٩]/g, (d) => String(AR_DIGITS.indexOf(d)));

// Timestamps are stored in UTC, but the group plays by Riyadh time (UTC+3). A night
// that runs past midnight must be reported under its local date, otherwise games
// played after 12 AM are still labelled with the previous day.
const LOCAL_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh' });
const localDay = (entry) => {
  const ts = Date.parse(entry.endedAt || entry.startedAt || '');
  return Number.isNaN(ts) ? '' : LOCAL_DAY.format(new Date(ts));
};

// New entries carry dateIso/endedAt; older ones only have a localized date like ١٠‏/١١‏/٢٠٢٦.
// Those legacy strings also contain right-to-left marks, so keep digits and slashes only.
function dayIso(entry) {
  if (entry.dateIso) return String(entry.dateIso).slice(0, 10);
  if (entry.endedAt) return String(entry.endedAt).slice(0, 10);
  if (entry.startedAt) return String(entry.startedAt).slice(0, 10);
  const parts = toEnDigits(entry.date).replace(/[^0-9/]/g, '').split('/');
  if (parts.length === 3) {
    const [d, m, y] = parts;
    if (y.length === 4 && m && d) {
      return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
    }
  }
  return '';
}

export function buildReport(daysHistory, options = {}) {
  const { from = null, to = null, since = null, until = null } = options;
  const sinceTs = since ? Date.parse(since) : null;
  const untilTs = until ? Date.parse(until) : null;
  const all = (daysHistory || []).map((entry) => ({ ...entry, _iso: localDay(entry) || dayIso(entry) }));
  const filtered = all.filter((e) => {
    if (!from && !to) return true;
    return (!from || e._iso >= from) && (!to || e._iso <= to);
  });

  // Time window (e.g. one game night) - entries without timestamps cannot match it.
  const windowed = (sinceTs !== null || untilTs !== null)
    ? filtered.filter((e) => {
        const ts = Date.parse(e.endedAt || e.startedAt || '');
        if (Number.isNaN(ts)) return false;
        if (sinceTs !== null && ts < sinceTs) return false;
        if (untilTs !== null && ts > untilTs) return false;
        return true;
      })
    : filtered;

  // No explicit range: treat the latest night as one session. Prefer the recorded
  // timestamps (a night that passes midnight is one session), otherwise fall back
  // to the newest date plus the day before it when they are consecutive.
  let session = windowed;
  if (!from && !to && !since && !until) {
    const stamped = windowed
      .map((e) => Date.parse(e.endedAt || e.startedAt || ''))
      .filter((t) => !Number.isNaN(t));
    if (stamped.length) {
      // Walk backwards from the newest game and stop at the first long gap, so a
      // night that passes midnight stays whole while earlier sessions drop off.
      const sortedTs = [...stamped].sort((a, b) => a - b);
      let start = sortedTs[sortedTs.length - 1];
      for (let i = sortedTs.length - 1; i > 0; i -= 1) {
        if (sortedTs[i] - sortedTs[i - 1] > 6 * 60 * 60 * 1000) break;
        start = sortedTs[i - 1];
      }
      session = windowed.filter((e) => {
        const ts = Date.parse(e.endedAt || e.startedAt || '');
        return !Number.isNaN(ts) && ts >= start;
      });
    } else if (windowed.length) {
      const dates = [...new Set(windowed.map((e) => e._iso).filter(Boolean))].sort();
      const last = dates[dates.length - 1];
      const previous = dates[dates.length - 2];
      const keep = new Set([last]);
      if (last) {
        const d = new Date(`${last}T00:00:00Z`);
        if (!Number.isNaN(d.getTime())) {
          d.setUTCDate(d.getUTCDate() - 1);
          if (previous === d.toISOString().slice(0, 10)) keep.add(previous);
        }
      }
      session = windowed.filter((e) => keep.has(e._iso));
    }
  }

  const players = new Map();
  const getPlayer = (name) => {
    if (!players.has(name)) {
      players.set(name, { name, wins: 0, lasts: 0, games: 0, points: 0, best: null, worst: null, hands: {} });
    }
    return players.get(name);
  };

  const handTotals = {};
  const games = [];

  for (const entry of session) {
    const sorted = [...(entry.players || [])].sort((a, b) => a.score - b.score);
    const storedWinner = entry.winner;
    const winner = storedWinner && sorted.some((p) => p.name === storedWinner)
      ? storedWinner
      : (sorted[0] && sorted[0].name) || '';
    const lastPlayer = sorted[sorted.length - 1];

    for (const p of sorted) {
      const rec = getPlayer(p.name);
      rec.games += 1;
      rec.points += p.score;
      rec.best = rec.best === null ? p.score : Math.min(rec.best, p.score);
      rec.worst = rec.worst === null ? p.score : Math.max(rec.worst, p.score);
    }
    if (winner) getPlayer(winner).wins += 1;
    if (lastPlayer) getPlayer(lastPlayer.name).lasts += 1;

    if (entry.hands) {
      for (const [name, counts] of Object.entries(entry.hands)) {
        const rec = getPlayer(name);
        for (const [type, count] of Object.entries(counts || {})) {
          if (!count) continue;
          rec.hands[type] = (rec.hands[type] || 0) + count;
          handTotals[type] = (handTotals[type] || 0) + count;
        }
      }
    }

    games.push({
      date: entry._iso || entry.date,
      winner,
      winnerScore: sorted[0] ? sorted[0].score : null,
      last: lastPlayer ? lastPlayer.name : null,
      lastScore: lastPlayer ? lastPlayer.score : null,
      players: sorted,
      hands: entry.hands || {},
    });
  }

  // Lowest total is the winner; ties are broken by fewer cumulative points.
  const ranking = [...players.values()]
    .map((p) => ({
      ...p,
      avg: p.games ? Math.round((p.points / p.games) * 10) / 10 : 0,
    }))
    .sort((a, b) => b.wins - a.wins || a.points - b.points);

  const handLeaders = {};
  for (const [type, total] of Object.entries(handTotals)) {
    let bestCount = 0;
    let bestPlayers = [];
    for (const p of players.values()) {
      const count = p.hands[type] || 0;
      if (count > bestCount) {
        bestCount = count;
        bestPlayers = [p.name];
      } else if (count === bestCount && count > 0) {
        bestPlayers.push(p.name);
      }
    }
    handLeaders[type] = { players: bestPlayers, count: bestCount, total };
  }

  const dates = [...new Set(session.map((e) => e._iso).filter(Boolean))].sort();

  return {
    rule: 'البطل هو الأقل نقاطاً، والخباص (الأخير) هو الأعلى نقاطاً',
    range: { from: from || dates[0] || null, to: to || dates[dates.length - 1] || null },
    dates,
    gamesCount: games.length,
    ranking,
    handTotals,
    handLeaders,
    games,
  };
}

const HAND_LABELS = {
  tayara: 'طايرة',
  hand_normal: 'هاند 200',
  hand_400: 'هاند 400',
  hand_800: 'هاند 800',
  hand_1200: 'هاند 1200',
  harq: 'حارق',
};
const HAND_ORDER = ['tayara', 'hand_normal', 'hand_400', 'hand_800', 'hand_1200', 'harq'];

const timesLabel = (n) => (n === 1 ? 'مرة' : n === 2 ? 'مرتين' : n <= 10 ? `${n} مرات` : `${n} مرة`);
const shortDate = (iso) => `${Number(iso.slice(8, 10))}/${Number(iso.slice(5, 7))}`;

// Plain text for WhatsApp: *bold* is WhatsApp markdown.
export function buildMessage(report, { title = 'تقرير لعبة الهند' } = {}) {
  const dates = report.dates || [];
  const lines = [];
  lines.push(`🎴 *${title}* — تقرير الليلة`);
  if (dates.length) lines.push(`📅 ${dates.map(shortDate).join(' و ')}`);
  lines.push(`🃏 عدد الألعاب: ${report.gamesCount}`);

  if (!report.gamesCount) {
    lines.push('');
    lines.push('ما فيه جولات مسجلة لهذي الليلة.');
    return lines.join('\n');
  }

  const ranking = report.ranking || [];
  const topWins = ranking.length ? ranking[0].wins : 0;
  const champs = ranking.filter((p) => p.wins === topWins && p.wins > 0);
  if (champs.length) {
    lines.push('');
    lines.push('🏆 *الأبطال*');
    champs.forEach((p, i) => lines.push(`${i + 1}. ${p.name} — ${p.wins} فوز`));
  }

  const topLasts = ranking.reduce((m, p) => Math.max(m, p.lasts), 0);
  const worst = ranking.filter((p) => p.lasts === topLasts && p.lasts > 0);
  if (worst.length) {
    lines.push('');
    lines.push('💩 *أكثر واحد آخر*');
    worst.forEach((p, i) => lines.push(`${i + 1}. ${p.name} — ${timesLabel(p.lasts)}`));
  }

  const handLines = HAND_ORDER.filter((type) => report.handLeaders && report.handLeaders[type])
    .map((type) => {
      const lead = report.handLeaders[type];
      const label = HAND_LABELS[type] || type;
      return `• ${label}: ${lead.players.join(' و ')} × ${lead.count}`;    });
  if (handLines.length) {
    lines.push('');
    lines.push('🎯 *أكثر الهاندات*');
    lines.push(...handLines);
  }

  lines.push('');
  lines.push('📊 *الترتيب*');
  ranking.forEach((p, i) => {
    lines.push(`${i + 1}. ${p.name} — ${p.wins} فوز · ${p.lasts} أخير`);
  });

  return lines.join('\n');
}

export default async function handler(req, res) {
  setCors(req, res, 'GET,OPTIONS');

  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }

  const email = req.query.email;
  if (!email) {
    res.status(400).json({ error: 'email required' });
    return;
  }
  // Reports expose the whole history, so they need the account PIN like the app does.
  const pin = typeof req.query.pin === 'string' ? req.query.pin : '';
  if (!isPin(pin)) {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.status(401).send('الرقم السري مطلوب (4 أرقام)');
    return;
  }
  const from = typeof req.query.from === 'string' ? req.query.from : null;
  const to = typeof req.query.to === 'string' ? req.query.to : null;
  const since = typeof req.query.since === 'string' ? req.query.since : null;
  const until = typeof req.query.until === 'string' ? req.query.until : null;
  if ((since && Number.isNaN(Date.parse(since))) || (until && Number.isNaN(Date.parse(until)))) {
    res.status(400).json({ error: 'invalid since/until, expected ISO 8601' });
    return;
  }

  try {
    const row = await findUser(email);
    if (!row || !verifyPin(pin, row.pin_hash)) {
      return pinFailure(req, res, email, true);
    }

    const data = JSON.parse(row.data);
    const report = buildReport(data.daysHistory, { from, to, since, until });

    if (req.query.format === 'text') {
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.status(200).send(buildMessage(report));
      return;
    }

    res.status(200).json({
      ok: true,
      email,
      ...report,
      window: since || until ? { since, until } : null,
      cumulative: data.stats || null,
    });
  } catch (error) {
    res.status(500).json({ error: 'report failed' });
  }
}
