#!/usr/bin/env node
/**
 * Truncates all operational data tables.
 * Usage: node --env-file=.env.local scripts/clear-db.mjs
 */
import postgres from 'postgres'
const { POSTGRES_URL } = process.env
if (!POSTGRES_URL) { console.error('POSTGRES_URL missing'); process.exit(1) }
const db = postgres(POSTGRES_URL, { ssl: 'require' })

const tables = [
  'shift_splits',
  'swap_requests',
  'availability_submissions',
  'shift_history',
  'shifts',
  'scheduling_periods',
  'schedule',
  'invoice_sequences',
  'billing_rates',
  'billing_contacts',
  'resident_preferences',
  'clinic_defaults',
]

for (const t of tables) {
  await db`TRUNCATE TABLE ${db(t)} CASCADE`
  console.log(`  cleared ${t}`)
}

await db.end()
console.log('\nDatabase cleared.')
