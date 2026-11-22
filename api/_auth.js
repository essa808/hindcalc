import { createClient } from '@libsql/client';
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

export const client = createClient({
  url: process.env.TURSO_DATABASE_URL,
  authToken: process.env.TURSO_AUTH_TOKEN,
});

// The PIN column is added on first use so the existing table keeps working
// without a manual migration. Rows created before this feature have no PIN
// and are claimed by the first login that supplies one. Failures are not
// cached, so a transient error is retried on the next call.
let schemaReady = null;
export function ensureSchema() {
  if (!schemaReady) {
    schemaReady = addPinColumn().catch((error) => {
      schemaReady = null;
      throw error;
    });
  }
  return schemaReady;
}

async function addPinColumn() {
  const columns = await client.execute('PRAGMA table_info(hind_users)');
  if (columns.rows.some((column) => column.name === 'pin_hash')) return;
  await client.execute('ALTER TABLE hind_users ADD COLUMN pin_hash TEXT');
}

export const isPin = (pin) => typeof pin === 'string' && /^\d{4}$/.test(pin);

export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pin, salt, 32).toString('hex')}`;
}

export function verifyPin(pin, stored) {
  if (!stored || !isPin(pin)) return false;
  const [salt, hash] = String(stored).split(':');
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, 'hex');
  const actual = scryptSync(pin, salt, 32);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// Case-insensitive so a differently-cased address still reaches its own row.
export async function findUser(email) {
  await ensureSchema();
  const result = await client.execute({
    sql: 'SELECT email, data, pin_hash FROM hind_users WHERE lower(email) = lower(?)',
    args: [email],
  });
  return result.rows[0] || null;
}
