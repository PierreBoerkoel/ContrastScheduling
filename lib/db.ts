import { sql, db } from '@vercel/postgres'
import type { Shift, AvailabilitySubmission, SwapRequest, ShiftAssignment, SchedulingPeriod, ShiftSplit, ClinicDefault } from './types'
import type { BillingContactRecord } from './invoices'

// Run migrations once per Lambda cold-start; all DDL uses IF NOT EXISTS so it is safe to re-run.
let _ready: Promise<void> | null = null
export function ensureDb(): Promise<void> {
  return (_ready ??= initDb())
}

export async function initDb(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS shifts (
      id      TEXT PRIMARY KEY,
      date    TEXT NOT NULL,
      clinic  TEXT NOT NULL
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS availability_submissions (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT,
      resident_name       TEXT NOT NULL,
      submitted_at        TIMESTAMPTZ NOT NULL,
      available_shift_ids TEXT[] NOT NULL DEFAULT '{}'
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS schedule (
      singleton             INTEGER PRIMARY KEY DEFAULT 1,
      generated_at          TIMESTAMPTZ,
      published_at          TIMESTAMPTZ,
      is_published          BOOLEAN NOT NULL DEFAULT FALSE,
      assignments           JSONB NOT NULL DEFAULT '[]'::jsonb,
      published_assignments JSONB NOT NULL DEFAULT '[]'::jsonb,
      CONSTRAINT schedule_singleton CHECK (singleton = 1)
    )
  `
  await sql`ALTER TABLE schedule ADD COLUMN IF NOT EXISTS published_assignments JSONB NOT NULL DEFAULT '[]'::jsonb`
  await sql`ALTER TABLE schedule ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`
  await sql`
    CREATE TABLE IF NOT EXISTS swap_requests (
      id                  TEXT PRIMARY KEY,
      requested_at        TIMESTAMPTZ NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      requestor_user_id   TEXT,
      requestor_name      TEXT NOT NULL,
      requestor_shift_id  TEXT NOT NULL,
      acceptor_name       TEXT,
      acceptor_shift_id   TEXT,
      accepted_at         TIMESTAMPTZ
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS scheduling_periods (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name       TEXT NOT NULL,
      start_date DATE NOT NULL,
      end_date   DATE NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `
  await sql`ALTER TABLE scheduling_periods ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`
  await sql`ALTER TABLE scheduling_periods ADD COLUMN IF NOT EXISTS generated_at TIMESTAMPTZ`
  await sql`ALTER TABLE scheduling_periods ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ`
  await sql`ALTER TABLE scheduling_periods ADD COLUMN IF NOT EXISTS assignments JSONB NOT NULL DEFAULT '[]'::jsonb`
  await sql`ALTER TABLE scheduling_periods ADD COLUMN IF NOT EXISTS published_assignments JSONB NOT NULL DEFAULT '[]'::jsonb`
  // Add columns to existing tables if upgrading from the pre-auth schema
  await sql`ALTER TABLE availability_submissions ADD COLUMN IF NOT EXISTS user_id TEXT`
  await sql`ALTER TABLE swap_requests ADD COLUMN IF NOT EXISTS requestor_user_id TEXT`
  await sql`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS period_id TEXT`
  await sql`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS start_time TEXT`
  await sql`ALTER TABLE shifts ADD COLUMN IF NOT EXISTS end_time TEXT`
  await sql`ALTER TABLE availability_submissions ADD COLUMN IF NOT EXISTS period_id TEXT`
  await sql`ALTER TABLE availability_submissions ADD COLUMN IF NOT EXISTS max_shifts INTEGER`
  // Old single-user indexes replaced by composite (user_id, period_id) index below
  await sql`DROP INDEX IF EXISTS submissions_user_id_idx`
  await sql`DROP INDEX IF EXISTS submissions_name_lower_idx`
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS submissions_user_period_idx
    ON availability_submissions (user_id, period_id)
    WHERE user_id IS NOT NULL AND period_id IS NOT NULL
  `
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
  await sql`
    CREATE TABLE IF NOT EXISTS shift_history (
      shift_id      TEXT PRIMARY KEY,
      date          TEXT NOT NULL,
      clinic        TEXT NOT NULL,
      resident_name TEXT NOT NULL,
      start_time    TEXT,
      end_time      TEXT
    )
  `
  await sql`ALTER TABLE shift_history ADD COLUMN IF NOT EXISTS start_time TEXT`
  await sql`ALTER TABLE shift_history ADD COLUMN IF NOT EXISTS end_time TEXT`
  await sql`ALTER TABLE shift_history ADD COLUMN IF NOT EXISTS user_id TEXT`
  await sql`ALTER TABLE swap_requests ADD COLUMN IF NOT EXISTS acceptor_user_id TEXT`
  await sql`
    CREATE TABLE IF NOT EXISTS invoice_sequences (
      resident_name TEXT NOT NULL,
      series        TEXT NOT NULL,
      next_number   INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (resident_name, series)
    )
  `
  await sql`ALTER TABLE invoice_sequences ADD COLUMN IF NOT EXISTS user_id TEXT`
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS invoice_seq_user_series_idx
    ON invoice_sequences (user_id, series)
    WHERE user_id IS NOT NULL
  `
  await sql`
    CREATE TABLE IF NOT EXISTS invoice_history (
      id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      user_id        TEXT NOT NULL,
      resident_name  TEXT NOT NULL,
      invoice_number TEXT NOT NULL,
      entity         TEXT NOT NULL,
      invoice_date   TEXT NOT NULL,
      generated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      shift_ids      TEXT[] NOT NULL DEFAULT '{}'
    )
  `
  await sql`CREATE INDEX IF NOT EXISTS invoice_history_user_idx ON invoice_history (user_id)`
  await sql`
    CREATE TABLE IF NOT EXISTS billing_rates (
      key   TEXT PRIMARY KEY,
      value NUMERIC NOT NULL
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS clinic_defaults (
      clinic        TEXT PRIMARY KEY,
      active_days   TEXT NOT NULL DEFAULT '[]',
      weekday_start TEXT,
      weekday_end   TEXT,
      weekend_start TEXT,
      weekend_end   TEXT
    )
  `
  const clinicSeeds: Array<[string, string, string | null, string | null, string | null, string | null]> = [
    ['BC Cancer Agency CT',       '[6]',               '17:00', '19:00', '08:00', '16:00'],
    ['BC Cancer Agency MRI/PET',  '[0,1,2,3,4,5,6]',  '17:00', '22:00', '08:00', '21:00'],
    ['INITIO Medical Imaging',    '[0,1,2,3,4,5,6]',  '17:30', '21:30', '08:00', '16:00'],
    ['UBC Hospital',              '[1,2,3,4,5]',       '17:30', '22:30', null,    null   ],
    ["BC Women's Hospital",       '[2]',               '17:30', '21:30', null,    null   ],
  ]
  for (const [clinic, days, ws, we, ss, se] of clinicSeeds) {
    await sql`
      INSERT INTO clinic_defaults (clinic, active_days, weekday_start, weekday_end, weekend_start, weekend_end)
      VALUES (${clinic}, ${days}, ${ws}, ${we}, ${ss}, ${se})
      ON CONFLICT (clinic) DO NOTHING
    `
  }

  // Seed billing rate defaults — only inserts when the key doesn't already exist
  const defaults: Array<[string, number]> = [
    ['MRCT_base',        50],
    ['MRCT_standalone',  75],
    ['MRCT_ct',          75],
    ['PET_base',         25],
    ['PET_standalone',   75],
    ['UBCMR_MR',         75],
    ['BCWHMR_MR',        75],
  ]
  for (const [key, value] of defaults) {
    await sql`INSERT INTO billing_rates (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO NOTHING`
  }

  await sql`
    CREATE TABLE IF NOT EXISTS billing_contacts (
      entity       TEXT PRIMARY KEY,
      contact_name TEXT NOT NULL DEFAULT '',
      org          TEXT NOT NULL DEFAULT '',
      address      TEXT NOT NULL DEFAULT '',
      email        TEXT
    )
  `
  const contactSeeds: Array<[string, string, string, string, string | null]> = [
    ['MRCT',   'Danielle Florendo', 'BCCA Diagnostic Imaging',            '600 W 10th Ave\nVancouver BC  V5Z 4E6', null],
    ['PET',    'Chris Raiwe',       'BCCA Molecular Imaging and Therapy', '600 W 10th Ave\nVancouver BC  V5Z 4E6', null],
    ['UBCMR',  '',                  'Vancouver Imaging',                  '450-943 West Broadway\nVancouver BC  V5Z 4E1', 'finance@vancouverimaging.com'],
    ['BCWHMR', 'Rahul Jain',        'BCW Diagnostic Imaging',             '4500 Oak St.\nVancouver BC  V6H3N1', null],
  ]
  for (const [entity, name, org, address, email] of contactSeeds) {
    await sql`
      INSERT INTO billing_contacts (entity, contact_name, org, address, email)
      VALUES (${entity}, ${name}, ${org}, ${address}, ${email})
      ON CONFLICT (entity) DO NOTHING
    `
  }

  await sql`
    CREATE TABLE IF NOT EXISTS resident_preferences (
      user_id       TEXT PRIMARY KEY,
      shift_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
      clinic_prefs  JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `
}

// ── Shifts ────────────────────────────────────────────────────────────────────

export async function getShifts(): Promise<Shift[]> {
  await ensureDb()
  const { rows } = await sql`SELECT id, date, clinic, period_id, start_time, end_time FROM shifts ORDER BY date, clinic`
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    clinic: r.clinic as Shift['clinic'],
    periodId: r.period_id ?? undefined,
    startTime: r.start_time ?? undefined,
    endTime: r.end_time ?? undefined,
  }))
}

export async function setShifts(shifts: Shift[], periodId?: string): Promise<void> {
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    if (periodId) {
      await client.sql`DELETE FROM shifts WHERE period_id = ${periodId}`
    } else {
      await client.sql`DELETE FROM shifts WHERE period_id IS NULL`
    }
    for (const s of shifts) {
      await client.sql`INSERT INTO shifts (id, date, clinic, period_id, start_time, end_time) VALUES (${s.id}, ${s.date}, ${s.clinic}, ${periodId ?? null}, ${s.startTime ?? null}, ${s.endTime ?? null})`
    }
    await client.sql`COMMIT`
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

// ── Availability submissions ──────────────────────────────────────────────────

export async function getSubmissions(): Promise<AvailabilitySubmission[]> {
  await ensureDb()
  const { rows } = await sql`
    SELECT id, user_id, resident_name, submitted_at, available_shift_ids, period_id, max_shifts
    FROM availability_submissions
    ORDER BY submitted_at
  `
  return rows.map((r) => ({
    id: r.id,
    userId: (r.user_id as string) ?? undefined,
    residentName: r.resident_name,
    submittedAt: r.submitted_at,
    availableShiftIds: r.available_shift_ids as string[],
    periodId: r.period_id ?? undefined,
    maxShifts: r.max_shifts ?? undefined,
  }))
}

export async function upsertSubmission(
  submission: AvailabilitySubmission & { userId: string }
): Promise<void> {
  await ensureDb()
  const periodId = submission.periodId ?? null
  const maxShifts = submission.maxShifts ?? null

  if (periodId !== null) {
    // Use the partial unique index (user_id, period_id) WHERE both NOT NULL
    await sql`
      INSERT INTO availability_submissions (id, user_id, resident_name, submitted_at, available_shift_ids, period_id, max_shifts)
      VALUES (${submission.id}, ${submission.userId}, ${submission.residentName}, ${submission.submittedAt}, ${submission.availableShiftIds as unknown as string}, ${periodId}, ${maxShifts})
      ON CONFLICT (user_id, period_id) WHERE user_id IS NOT NULL AND period_id IS NOT NULL
      DO UPDATE SET
        id                  = EXCLUDED.id,
        resident_name       = EXCLUDED.resident_name,
        submitted_at        = EXCLUDED.submitted_at,
        available_shift_ids = EXCLUDED.available_shift_ids,
        max_shifts          = EXCLUDED.max_shifts
    `
  } else {
    const { rows } = await sql`
      SELECT id FROM availability_submissions
      WHERE user_id = ${submission.userId} AND period_id IS NULL
    `
    if (rows.length > 0) {
      await sql`
        UPDATE availability_submissions SET
          id                  = ${submission.id},
          resident_name       = ${submission.residentName},
          submitted_at        = ${submission.submittedAt},
          available_shift_ids = ${submission.availableShiftIds as unknown as string},
          max_shifts          = ${maxShifts}
        WHERE user_id = ${submission.userId} AND period_id IS NULL
      `
    } else {
      await sql`
        INSERT INTO availability_submissions (id, user_id, resident_name, submitted_at, available_shift_ids, period_id, max_shifts)
        VALUES (${submission.id}, ${submission.userId}, ${submission.residentName}, ${submission.submittedAt}, ${submission.availableShiftIds as unknown as string}, NULL, ${maxShifts})
      `
    }
  }
}

// ── Scheduling periods ────────────────────────────────────────────────────────

function parseJsonb(v: unknown): ShiftAssignment[] {
  if (Array.isArray(v)) return v as ShiftAssignment[]
  if (typeof v === 'string') return JSON.parse(v) as ShiftAssignment[]
  return []
}

function periodFromRow(r: Record<string, unknown>): SchedulingPeriod {
  return {
    id: r.id as string,
    name: r.name as string,
    startDate: r.start_date as string,
    endDate: r.end_date as string,
    createdAt: r.created_at as string,
    publishedAt: (r.published_at as string | null) ?? undefined,
    generatedAt: (r.generated_at as string | null) ?? undefined,
    updatedAt: (r.updated_at as string | null) ?? undefined,
    assignments: parseJsonb(r.assignments),
    publishedAssignments: parseJsonb(r.published_assignments),
  }
}

export async function getSchedulingPeriods(): Promise<SchedulingPeriod[]> {
  await ensureDb()
  const { rows } = await sql`
    SELECT id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date,
           created_at, published_at, generated_at, updated_at, assignments, published_assignments
    FROM scheduling_periods
    ORDER BY start_date
  `
  return rows.map(periodFromRow)
}

export async function getPeriod(id: string): Promise<SchedulingPeriod | null> {
  await ensureDb()
  const { rows } = await sql`
    SELECT id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date,
           created_at, published_at, generated_at, updated_at, assignments, published_assignments
    FROM scheduling_periods WHERE id = ${id}
  `
  return rows.length === 0 ? null : periodFromRow(rows[0])
}

export async function addSchedulingPeriod(
  period: Pick<SchedulingPeriod, 'name' | 'startDate' | 'endDate'>
): Promise<SchedulingPeriod> {
  await ensureDb()
  const { rows } = await sql`
    INSERT INTO scheduling_periods (name, start_date, end_date)
    VALUES (${period.name}, ${period.startDate}, ${period.endDate})
    RETURNING id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date,
              created_at, published_at, generated_at, updated_at, assignments, published_assignments
  `
  return periodFromRow(rows[0])
}

export async function deleteSchedulingPeriod(id: string): Promise<void> {
  await ensureDb()
  await sql`DELETE FROM scheduling_periods WHERE id = ${id}`
}

export async function findPeriodByName(name: string): Promise<SchedulingPeriod | null> {
  await ensureDb()
  const { rows } = await sql`
    SELECT id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date,
           created_at, published_at, generated_at, updated_at, assignments, published_assignments
    FROM scheduling_periods WHERE name = ${name} LIMIT 1
  `
  return rows.length === 0 ? null : periodFromRow(rows[0])
}

export async function updatePeriodDraft(
  id: string,
  assignments: ShiftAssignment[],
  generatedAt: string | null
): Promise<void> {
  const json = JSON.stringify(assignments)
  await sql`
    UPDATE scheduling_periods
    SET assignments = ${json}::jsonb, generated_at = ${generatedAt}, updated_at = NULL
    WHERE id = ${id}
  `
}

export async function touchPeriodUpdatedAt(id: string): Promise<void> {
  await sql`UPDATE scheduling_periods SET updated_at = NOW() WHERE id = ${id}`
}

export async function publishPeriod(id: string, assignments: ShiftAssignment[]): Promise<void> {
  const json = JSON.stringify(assignments)
  await sql`
    UPDATE scheduling_periods
    SET published_assignments = ${json}::jsonb, published_at = NOW()
    WHERE id = ${id}
  `
}

export async function updatePeriodPublishedAssignments(
  id: string,
  assignments: ShiftAssignment[]
): Promise<void> {
  const json = JSON.stringify(assignments)
  await sql`UPDATE scheduling_periods SET published_assignments = ${json}::jsonb WHERE id = ${id}`
}

export async function getAllPublishedAssignments(): Promise<ShiftAssignment[]> {
  const { rows } = await sql`
    SELECT published_assignments FROM scheduling_periods WHERE published_at IS NOT NULL
  `
  return rows.flatMap((r) => parseJsonb(r.published_assignments))
}

export async function updateSchedulingPeriod(
  id: string,
  patch: Pick<SchedulingPeriod, 'startDate' | 'endDate'>
): Promise<void> {
  await sql`
    UPDATE scheduling_periods
    SET start_date = ${patch.startDate}, end_date = ${patch.endDate},
        assignments = '[]'::jsonb, published_assignments = '[]'::jsonb,
        generated_at = NULL, updated_at = NULL, published_at = NULL
    WHERE id = ${id}
  `
}

// ── Swap requests ─────────────────────────────────────────────────────────────

export async function getSwapRequests(): Promise<SwapRequest[]> {
  const { rows } = await sql`
    SELECT id, requested_at, status, requestor_user_id, requestor_name, requestor_shift_id,
           acceptor_name, acceptor_user_id, acceptor_shift_id, accepted_at
    FROM swap_requests
    ORDER BY requested_at DESC
  `
  return rows.map((r) => ({
    id: r.id,
    requestedAt: r.requested_at,
    status: r.status as SwapRequest['status'],
    requestorName: r.requestor_name,
    requestorUserId: (r.requestor_user_id as string) ?? undefined,
    requestorShiftId: r.requestor_shift_id,
    acceptorName: r.acceptor_name ?? null,
    acceptorUserId: (r.acceptor_user_id as string) ?? null,
    acceptorShiftId: r.acceptor_shift_id ?? null,
    acceptedAt: r.accepted_at ?? null,
  }))
}

export async function addSwapRequest(
  req: SwapRequest & { requestorUserId: string }
): Promise<void> {
  await sql`
    INSERT INTO swap_requests (id, requested_at, status, requestor_user_id, requestor_name, requestor_shift_id)
    VALUES (${req.id}, ${req.requestedAt}, ${req.status}, ${req.requestorUserId}, ${req.requestorName}, ${req.requestorShiftId})
  `
}

// ── Shift history (permanent record, survives block deletion) ─────────────────

export async function upsertShiftHistory(
  records: Array<{ shiftId: string; userId?: string | null; residentName: string; date: string; clinic: string; startTime?: string | null; endTime?: string | null }>
): Promise<void> {
  await ensureDb()
  for (const r of records) {
    await sql`
      INSERT INTO shift_history (shift_id, date, clinic, resident_name, user_id, start_time, end_time)
      VALUES (${r.shiftId}, ${r.date}, ${r.clinic}, ${r.residentName}, ${r.userId ?? null}, ${r.startTime ?? null}, ${r.endTime ?? null})
      ON CONFLICT (shift_id) DO UPDATE SET
        resident_name = EXCLUDED.resident_name,
        user_id = COALESCE(EXCLUDED.user_id, shift_history.user_id),
        start_time = EXCLUDED.start_time,
        end_time = EXCLUDED.end_time
    `
  }
}

export async function getShiftHistory(): Promise<ShiftAssignment[]> {
  await ensureDb()
  const { rows } = await sql`SELECT shift_id, date, clinic, resident_name, user_id, start_time, end_time FROM shift_history ORDER BY date DESC`
  return rows.map((r) => ({
    shiftId: r.shift_id as string,
    residentName: r.resident_name as string,
    userId: (r.user_id as string) ?? null,
    date: r.date as string,
    clinic: r.clinic as string,
    startTime: r.start_time as string | null ?? undefined,
    endTime: r.end_time as string | null ?? undefined,
  }))
}

// ── Shift splits ──────────────────────────────────────────────────────────────

function rowToSplit(r: Record<string, unknown>): ShiftSplit {
  return {
    id: r.id as string,
    shiftId: r.shift_id as string,
    offerorName: r.offeror_name as string,
    offerorUserId: (r.offeror_user_id as string) ?? undefined,
    offeredStart: r.offered_start as string,
    offeredEnd: r.offered_end as string,
    status: r.status as ShiftSplit['status'],
    acceptorName: (r.acceptor_name as string) ?? null,
    acceptorUserId: (r.acceptor_user_id as string) ?? null,
    offeredAt: r.offered_at as string,
    acceptedAt: (r.accepted_at as string) ?? null,
  }
}

export async function getShiftSplits(): Promise<ShiftSplit[]> {
  await ensureDb()
  const { rows } = await sql`
    SELECT id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end,
           status, acceptor_name, acceptor_user_id, offered_at, accepted_at
    FROM shift_splits ORDER BY offered_at ASC
  `
  return rows.map(rowToSplit)
}

export async function addShiftSplit(
  split: Omit<ShiftSplit, 'offeredAt' | 'acceptorName' | 'acceptedAt'> & { offerorUserId: string }
): Promise<ShiftSplit> {
  await ensureDb()
  const { rows } = await sql`
    INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status)
    VALUES (${split.id}, ${split.shiftId}, ${split.offerorName}, ${split.offerorUserId}, ${split.offeredStart}, ${split.offeredEnd}, 'pending')
    RETURNING id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status, acceptor_name, acceptor_user_id, offered_at, accepted_at
  `
  return rowToSplit(rows[0])
}

export async function addAcceptedShiftSplit(split: {
  id: string
  shiftId: string
  offerorName: string
  offerorUserId: string
  acceptorName: string
  acceptorUserId: string
  offeredStart: string
  offeredEnd: string
}): Promise<ShiftSplit> {
  await ensureDb()
  const { rows } = await sql`
    INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status, acceptor_name, acceptor_user_id, accepted_at)
    VALUES (${split.id}, ${split.shiftId}, ${split.offerorName}, ${split.offerorUserId}, ${split.offeredStart}, ${split.offeredEnd}, 'accepted', ${split.acceptorName}, ${split.acceptorUserId}, NOW())
    RETURNING id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status, acceptor_name, acceptor_user_id, offered_at, accepted_at
  `
  return rowToSplit(rows[0])
}

export async function updateShiftSplit(
  id: string,
  patch: { status: ShiftSplit['status']; acceptorName?: string; acceptorUserId?: string; acceptedAt?: string }
): Promise<ShiftSplit | null> {
  const { rows } = await sql`
    UPDATE shift_splits SET
      status           = ${patch.status},
      acceptor_name    = COALESCE(${patch.acceptorName ?? null}, acceptor_name),
      acceptor_user_id = COALESCE(${patch.acceptorUserId ?? null}, acceptor_user_id),
      accepted_at      = COALESCE(${patch.acceptedAt ?? null}, accepted_at)
    WHERE id = ${id}
    RETURNING id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status, acceptor_name, acceptor_user_id, offered_at, accepted_at
  `
  if (rows.length === 0) return null
  return rowToSplit(rows[0])
}

export async function deleteShiftSplit(id: string): Promise<void> {
  await sql`DELETE FROM shift_splits WHERE id = ${id}`
}

// ── Invoice history ───────────────────────────────────────────────────────────

export interface InvoiceHistoryRecord {
  id: string
  userId: string
  residentName: string
  invoiceNumber: string
  entity: string
  invoiceDate: string
  generatedAt: string
  shiftIds: string[]
}

export async function addInvoiceHistory(record: Omit<InvoiceHistoryRecord, 'id' | 'generatedAt'>): Promise<void> {
  await ensureDb()
  await sql`
    INSERT INTO invoice_history (user_id, resident_name, invoice_number, entity, invoice_date, shift_ids)
    VALUES (${record.userId}, ${record.residentName}, ${record.invoiceNumber}, ${record.entity}, ${record.invoiceDate}, ${record.shiftIds as unknown as string})
  `
}

export async function getInvoiceHistory(userId: string): Promise<InvoiceHistoryRecord[]> {
  await ensureDb()
  const { rows } = await sql`
    SELECT id, user_id, resident_name, invoice_number, entity, invoice_date, generated_at, shift_ids
    FROM invoice_history
    WHERE user_id = ${userId}
    ORDER BY generated_at DESC
  `
  return rows.map((r) => ({
    id: r.id as string,
    userId: r.user_id as string,
    residentName: r.resident_name as string,
    invoiceNumber: r.invoice_number as string,
    entity: r.entity as string,
    invoiceDate: r.invoice_date as string,
    generatedAt: r.generated_at as string,
    shiftIds: r.shift_ids as string[],
  }))
}

// ── Invoice sequences ─────────────────────────────────────────────────────────

export async function peekInvoiceNumber(userId: string, series: string): Promise<number> {
  await ensureDb()
  const { rows } = await sql`
    SELECT next_number FROM invoice_sequences
    WHERE user_id = ${userId} AND series = ${series}
  `
  return rows.length > 0 ? (rows[0].next_number as number) : 1
}

export async function setInvoiceSequence(userId: string, series: string, nextNumber: number): Promise<void> {
  await ensureDb()
  const { rowCount } = await sql`
    UPDATE invoice_sequences SET next_number = ${nextNumber}
    WHERE user_id = ${userId} AND series = ${series}
  `
  if ((rowCount ?? 0) === 0) {
    await sql`
      INSERT INTO invoice_sequences (resident_name, user_id, series, next_number)
      VALUES (${userId}, ${userId}, ${series}, ${nextNumber})
      ON CONFLICT (resident_name, series) DO NOTHING
    `
  }
}

// ── Clinic defaults ───────────────────────────────────────────────────────────

export async function getClinicDefaults(): Promise<ClinicDefault[]> {
  await ensureDb()
  const { rows } = await sql`
    SELECT clinic, active_days, weekday_start, weekday_end, weekend_start, weekend_end
    FROM clinic_defaults ORDER BY clinic
  `
  return rows.map((r) => ({
    clinic: r.clinic as string,
    activeDays: JSON.parse(r.active_days as string) as number[],
    weekdayStart: (r.weekday_start as string | null) ?? null,
    weekdayEnd: (r.weekday_end as string | null) ?? null,
    weekendStart: (r.weekend_start as string | null) ?? null,
    weekendEnd: (r.weekend_end as string | null) ?? null,
  }))
}

export async function setClinicDefault(
  clinic: string,
  data: Omit<ClinicDefault, 'clinic'>
): Promise<void> {
  await ensureDb()
  const activeDaysJson = JSON.stringify(data.activeDays)
  await sql`
    INSERT INTO clinic_defaults (clinic, active_days, weekday_start, weekday_end, weekend_start, weekend_end)
    VALUES (${clinic}, ${activeDaysJson}, ${data.weekdayStart}, ${data.weekdayEnd}, ${data.weekendStart}, ${data.weekendEnd})
    ON CONFLICT (clinic) DO UPDATE SET
      active_days   = ${activeDaysJson},
      weekday_start = ${data.weekdayStart},
      weekday_end   = ${data.weekdayEnd},
      weekend_start = ${data.weekendStart},
      weekend_end   = ${data.weekendEnd}
  `
}

// ── Billing contacts ──────────────────────────────────────────────────────────

export async function getBillingContacts(): Promise<BillingContactRecord[]> {
  await ensureDb()
  const { rows } = await sql`SELECT entity, contact_name, org, address, email FROM billing_contacts ORDER BY entity`
  return rows.map((r) => ({
    entity: r.entity as string,
    contactName: (r.contact_name as string) ?? '',
    org: (r.org as string) ?? '',
    address: (r.address as string) ?? '',
    email: (r.email as string | null) ?? null,
  }))
}

export async function setBillingContact(entity: string, data: Omit<BillingContactRecord, 'entity'>): Promise<void> {
  await ensureDb()
  await sql`
    INSERT INTO billing_contacts (entity, contact_name, org, address, email)
    VALUES (${entity}, ${data.contactName}, ${data.org}, ${data.address}, ${data.email})
    ON CONFLICT (entity) DO UPDATE SET
      contact_name = ${data.contactName},
      org          = ${data.org},
      address      = ${data.address},
      email        = ${data.email}
  `
}

// ── Billing rates ─────────────────────────────────────────────────────────────

export async function getBillingRates(): Promise<Record<string, number>> {
  await ensureDb()
  const { rows } = await sql`SELECT key, value FROM billing_rates`
  return Object.fromEntries(rows.map((r) => [r.key as string, parseFloat(r.value as string)]))
}

export async function setBillingRate(key: string, value: number): Promise<void> {
  await ensureDb()
  await sql`INSERT INTO billing_rates (key, value) VALUES (${key}, ${value}) ON CONFLICT (key) DO UPDATE SET value = ${value}`
}

// ── Swap requests ─────────────────────────────────────────────────────────────

export async function updateSwapRequest(
  id: string,
  patch: Partial<SwapRequest>
): Promise<SwapRequest | null> {
  const { rows } = await sql`
    UPDATE swap_requests SET
      status            = COALESCE(${patch.status ?? null}, status),
      acceptor_name     = COALESCE(${patch.acceptorName ?? null}, acceptor_name),
      acceptor_user_id  = COALESCE(${patch.acceptorUserId ?? null}, acceptor_user_id),
      acceptor_shift_id = COALESCE(${patch.acceptorShiftId ?? null}, acceptor_shift_id),
      accepted_at       = COALESCE(${patch.acceptedAt ?? null}, accepted_at)
    WHERE id = ${id}
    RETURNING *
  `
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    id: r.id,
    requestedAt: r.requested_at,
    status: r.status as SwapRequest['status'],
    requestorName: r.requestor_name,
    requestorUserId: (r.requestor_user_id as string) ?? undefined,
    requestorShiftId: r.requestor_shift_id,
    acceptorName: r.acceptor_name ?? null,
    acceptorUserId: (r.acceptor_user_id as string) ?? null,
    acceptorShiftId: r.acceptor_shift_id ?? null,
    acceptedAt: r.accepted_at ?? null,
  }
}

// ── Resident preferences ──────────────────────────────────────────────────────

export interface ResidentPreferences {
  shiftDefaults:  Record<string, { weekday: boolean; weekend: boolean }>
  weekdayRanking: string[]   // ordered clinic names, most preferred first
  weekendRanking: string[]
}

function parsePrefs(shiftDefaultsRaw: unknown, clinicPrefsRaw: unknown): ResidentPreferences {
  const shiftDefaults = (shiftDefaultsRaw ?? {}) as ResidentPreferences['shiftDefaults']
  const raw = (clinicPrefsRaw ?? {}) as Record<string, unknown>
  // Support both old format (Record<clinic, {weekday,weekend}>) and new format ({weekdayRanking, weekendRanking})
  const weekdayRanking = Array.isArray(raw.weekdayRanking) ? raw.weekdayRanking as string[] : []
  const weekendRanking = Array.isArray(raw.weekendRanking) ? raw.weekendRanking as string[] : []
  return { shiftDefaults, weekdayRanking, weekendRanking }
}

export async function getResidentPreferences(userId: string): Promise<ResidentPreferences> {
  await ensureDb()
  const { rows } = await sql`SELECT shift_defaults, clinic_prefs FROM resident_preferences WHERE user_id = ${userId}`
  if (rows.length === 0) return { shiftDefaults: {}, weekdayRanking: [], weekendRanking: [] }
  return parsePrefs(rows[0].shift_defaults, rows[0].clinic_prefs)
}

export async function setResidentPreferences(
  userId: string,
  prefs: Partial<ResidentPreferences>
): Promise<void> {
  await ensureDb()
  // Merge with existing so partial updates don't clobber unrelated fields
  const existing = await getResidentPreferences(userId)
  const merged: ResidentPreferences = {
    shiftDefaults:  prefs.shiftDefaults  ?? existing.shiftDefaults,
    weekdayRanking: prefs.weekdayRanking ?? existing.weekdayRanking,
    weekendRanking: prefs.weekendRanking ?? existing.weekendRanking,
  }
  const shiftDefaultsJson = JSON.stringify(merged.shiftDefaults)
  const clinicPrefsJson   = JSON.stringify({ weekdayRanking: merged.weekdayRanking, weekendRanking: merged.weekendRanking })
  await sql`
    INSERT INTO resident_preferences (user_id, shift_defaults, clinic_prefs)
    VALUES (${userId}, ${shiftDefaultsJson}::jsonb, ${clinicPrefsJson}::jsonb)
    ON CONFLICT (user_id) DO UPDATE SET
      shift_defaults = ${shiftDefaultsJson}::jsonb,
      clinic_prefs   = ${clinicPrefsJson}::jsonb
  `
}

export async function getAllResidentPreferences(): Promise<Record<string, ResidentPreferences>> {
  await ensureDb()
  const { rows } = await sql`SELECT user_id, shift_defaults, clinic_prefs FROM resident_preferences`
  return Object.fromEntries(rows.map((r) => [
    r.user_id as string,
    parsePrefs(r.shift_defaults, r.clinic_prefs),
  ]))
}
