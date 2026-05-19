import postgres from 'postgres'
import { readFileSync } from 'fs'

const env = readFileSync('/Users/pierreboerkoel/Programming/ContrastScheduling/.env.local', 'utf8')
const url = env.match(/POSTGRES_URL="([^"]+)"/)?.[1]
if (!url) { console.error('No POSTGRES_URL found'); process.exit(1) }

const sql = postgres(url, { ssl: 'require' })

try {
  // Run the shift_splits migration first (in case it hasn't run yet)
  await sql`
    CREATE TABLE IF NOT EXISTS shift_splits (
      id               TEXT PRIMARY KEY,
      shift_id         TEXT NOT NULL,
      offeror_name     TEXT NOT NULL,
      offeror_user_id  TEXT NOT NULL,
      offered_start    TEXT NOT NULL,
      offered_end      TEXT NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',
      acceptor_name    TEXT,
      acceptor_user_id TEXT,
      offered_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
      accepted_at      TIMESTAMPTZ
    )
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS split_one_pending_per_person
    ON shift_splits (shift_id, offeror_user_id) WHERE status = 'pending'
  `
  console.log('✓ Migrations applied')

  // Truncate all tables (order matters for any FKs)
  const tables = [
    'shift_splits',
    'swap_requests',
    'shift_history',
    'availability_submissions',
    'shifts',
    'schedule',
    'scheduling_periods',
  ]

  for (const t of tables) {
    await sql.unsafe(`TRUNCATE TABLE "${t}" RESTART IDENTITY CASCADE`)
    console.log(`✓ Cleared ${t}`)
  }

  console.log('\nDatabase cleared and ready for testing.')
} catch (e) {
  console.error(e.message)
} finally {
  await sql.end()
}
