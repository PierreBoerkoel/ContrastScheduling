import { sql, db } from '@vercel/postgres'
import type { Shift, AvailabilitySubmission, Schedule, SwapRequest, ShiftAssignment, SchedulingPeriod, ShiftSplit } from './types'

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
      user_id             TEXT UNIQUE,
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
  await sql`ALTER TABLE scheduling_periods ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ`
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
      resident_name TEXT NOT NULL
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS invoice_sequences (
      resident_name TEXT NOT NULL,
      series        TEXT NOT NULL,
      next_number   INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (resident_name, series)
    )
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
    SELECT id, resident_name, submitted_at, available_shift_ids, period_id, max_shifts
    FROM availability_submissions
    ORDER BY submitted_at
  `
  return rows.map((r) => ({
    id: r.id,
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
  const { rows } = await sql`
    SELECT id FROM availability_submissions
    WHERE user_id = ${submission.userId}
      AND (period_id = ${periodId} OR (period_id IS NULL AND ${periodId}::TEXT IS NULL))
  `
  if (rows.length > 0) {
    await sql`
      UPDATE availability_submissions SET
        id                  = ${submission.id},
        resident_name       = ${submission.residentName},
        submitted_at        = ${submission.submittedAt},
        available_shift_ids = ${submission.availableShiftIds as unknown as string},
        max_shifts          = ${maxShifts}
      WHERE user_id = ${submission.userId}
        AND (period_id = ${periodId} OR (period_id IS NULL AND ${periodId}::TEXT IS NULL))
    `
  } else {
    await sql`
      INSERT INTO availability_submissions (id, user_id, resident_name, submitted_at, available_shift_ids, period_id, max_shifts)
      VALUES (${submission.id}, ${submission.userId}, ${submission.residentName}, ${submission.submittedAt}, ${submission.availableShiftIds as unknown as string}, ${periodId}, ${maxShifts})
    `
  }
}

// ── Schedule ──────────────────────────────────────────────────────────────────

export async function getSchedule(): Promise<Schedule | null> {
  const { rows } = await sql`
    SELECT generated_at, published_at, updated_at, is_published, assignments, published_assignments
    FROM schedule WHERE singleton = 1
  `
  if (rows.length === 0) return null
  const r = rows[0]
  const parseJsonb = (v: unknown): ShiftAssignment[] => {
    if (Array.isArray(v)) return v as ShiftAssignment[]
    if (typeof v === 'string') return JSON.parse(v) as ShiftAssignment[]
    return []
  }
  return {
    generatedAt: r.generated_at,
    publishedAt: r.published_at,
    updatedAt: r.updated_at ?? null,
    isPublished: r.is_published,
    assignments: parseJsonb(r.assignments),
    publishedAssignments: parseJsonb(r.published_assignments),
  }
}

export async function setSchedule(schedule: Schedule): Promise<void> {
  const assignmentsJson = JSON.stringify(schedule.assignments)
  const publishedAssignmentsJson = JSON.stringify(schedule.publishedAssignments)
  const now = new Date().toISOString()
  await sql`
    INSERT INTO schedule (singleton, generated_at, published_at, updated_at, is_published, assignments, published_assignments)
    VALUES (1, ${schedule.generatedAt}, ${schedule.publishedAt}, ${now}, ${schedule.isPublished}, ${assignmentsJson}::jsonb, ${publishedAssignmentsJson}::jsonb)
    ON CONFLICT (singleton) DO UPDATE SET
      generated_at          = EXCLUDED.generated_at,
      published_at          = EXCLUDED.published_at,
      updated_at            = EXCLUDED.updated_at,
      is_published          = EXCLUDED.is_published,
      assignments           = EXCLUDED.assignments,
      published_assignments = EXCLUDED.published_assignments
  `
}

export async function touchScheduleTimestamp(): Promise<void> {
  await sql`UPDATE schedule SET updated_at = NOW() WHERE singleton = 1`
}

// ── Scheduling periods ────────────────────────────────────────────────────────

export async function getSchedulingPeriods(): Promise<SchedulingPeriod[]> {
  const { rows } = await sql`
    SELECT id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date, created_at, published_at
    FROM scheduling_periods
    ORDER BY start_date
  `
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    createdAt: r.created_at,
    publishedAt: r.published_at ?? undefined,
  }))
}

export async function addSchedulingPeriod(
  period: Pick<SchedulingPeriod, 'name' | 'startDate' | 'endDate'>
): Promise<SchedulingPeriod> {
  const { rows } = await sql`
    INSERT INTO scheduling_periods (name, start_date, end_date)
    VALUES (${period.name}, ${period.startDate}, ${period.endDate})
    RETURNING id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date, created_at, published_at
  `
  const r = rows[0]
  return { id: r.id, name: r.name, startDate: r.start_date, endDate: r.end_date, createdAt: r.created_at, publishedAt: r.published_at ?? undefined }
}

export async function updatePeriodPublishedAt(id: string): Promise<void> {
  await sql`UPDATE scheduling_periods SET published_at = NOW() WHERE id = ${id}`
}

export async function deleteSchedulingPeriod(id: string): Promise<void> {
  await sql`DELETE FROM scheduling_periods WHERE id = ${id}`
}

export async function findPeriodByName(name: string): Promise<SchedulingPeriod | null> {
  const { rows } = await sql`
    SELECT id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date, created_at, published_at
    FROM scheduling_periods WHERE name = ${name} LIMIT 1
  `
  if (rows.length === 0) return null
  const r = rows[0]
  return { id: r.id, name: r.name, startDate: r.start_date, endDate: r.end_date, createdAt: r.created_at, publishedAt: r.published_at ?? undefined }
}

export async function updateSchedulingPeriod(
  id: string,
  patch: Pick<SchedulingPeriod, 'startDate' | 'endDate'>
): Promise<void> {
  await sql`UPDATE scheduling_periods SET start_date = ${patch.startDate}, end_date = ${patch.endDate} WHERE id = ${id}`
}

// ── Swap requests ─────────────────────────────────────────────────────────────

export async function getSwapRequests(): Promise<SwapRequest[]> {
  const { rows } = await sql`
    SELECT id, requested_at, status, requestor_name, requestor_shift_id,
           acceptor_name, acceptor_shift_id, accepted_at
    FROM swap_requests
    ORDER BY requested_at DESC
  `
  return rows.map((r) => ({
    id: r.id,
    requestedAt: r.requested_at,
    status: r.status as SwapRequest['status'],
    requestorName: r.requestor_name,
    requestorShiftId: r.requestor_shift_id,
    acceptorName: r.acceptor_name ?? null,
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

export async function upsertShiftHistory(assignments: ShiftAssignment[]): Promise<void> {
  await ensureDb()
  for (const a of assignments) {
    if (!a.residentName) continue
    const [date, ...clinicParts] = a.shiftId.split('|')
    const clinic = clinicParts.join('|')
    await sql`
      INSERT INTO shift_history (shift_id, date, clinic, resident_name)
      VALUES (${a.shiftId}, ${date}, ${clinic}, ${a.residentName})
      ON CONFLICT (shift_id) DO UPDATE SET resident_name = EXCLUDED.resident_name
    `
  }
}

export async function getShiftHistory(): Promise<ShiftAssignment[]> {
  await ensureDb()
  const { rows } = await sql`SELECT shift_id, resident_name FROM shift_history ORDER BY date DESC`
  return rows.map((r) => ({ shiftId: r.shift_id, residentName: r.resident_name }))
}

// ── Shift splits ──────────────────────────────────────────────────────────────

function rowToSplit(r: Record<string, unknown>): ShiftSplit {
  return {
    id: r.id as string,
    shiftId: r.shift_id as string,
    offerorName: r.offeror_name as string,
    offeredStart: r.offered_start as string,
    offeredEnd: r.offered_end as string,
    status: r.status as ShiftSplit['status'],
    acceptorName: (r.acceptor_name as string) ?? null,
    offeredAt: r.offered_at as string,
    acceptedAt: (r.accepted_at as string) ?? null,
  }
}

export async function getShiftSplits(): Promise<ShiftSplit[]> {
  await ensureDb()
  const { rows } = await sql`
    SELECT id, shift_id, offeror_name, offered_start, offered_end,
           status, acceptor_name, offered_at, accepted_at
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
    RETURNING id, shift_id, offeror_name, offered_start, offered_end, status, acceptor_name, offered_at, accepted_at
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
    RETURNING id, shift_id, offeror_name, offered_start, offered_end, status, acceptor_name, offered_at, accepted_at
  `
  if (rows.length === 0) return null
  return rowToSplit(rows[0])
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

export async function claimInvoiceNumber(residentName: string, series: string): Promise<number> {
  await ensureDb()
  const { rows } = await sql`
    INSERT INTO invoice_sequences (resident_name, series, next_number)
    VALUES (${residentName}, ${series}, 2)
    ON CONFLICT (resident_name, series) DO UPDATE
      SET next_number = invoice_sequences.next_number + 1
    RETURNING next_number - 1 AS claimed
  `
  return rows[0].claimed as number
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
    requestorShiftId: r.requestor_shift_id,
    acceptorName: r.acceptor_name ?? null,
    acceptorShiftId: r.acceptor_shift_id ?? null,
    acceptedAt: r.accepted_at ?? null,
  }
}
