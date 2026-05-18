import { sql, db } from '@vercel/postgres'
import type { Shift, AvailabilitySubmission, Schedule, SwapRequest, ShiftAssignment, SchedulingPeriod } from './types'

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
  await sql`ALTER TABLE availability_submissions ADD COLUMN IF NOT EXISTS period_id TEXT`
  // Old single-user index; replaced by composite (user_id, period_id) index below
  await sql`DROP INDEX IF EXISTS submissions_user_id_idx`
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS submissions_user_period_idx
    ON availability_submissions (user_id, period_id)
    WHERE user_id IS NOT NULL AND period_id IS NOT NULL
  `
}

// ── Shifts ────────────────────────────────────────────────────────────────────

export async function getShifts(): Promise<Shift[]> {
  await ensureDb()
  const { rows } = await sql`SELECT id, date, clinic, period_id FROM shifts ORDER BY date, clinic`
  return rows.map((r) => ({ id: r.id, date: r.date, clinic: r.clinic as Shift['clinic'], periodId: r.period_id ?? undefined }))
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
      await client.sql`INSERT INTO shifts (id, date, clinic, period_id) VALUES (${s.id}, ${s.date}, ${s.clinic}, ${periodId ?? null})`
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
    SELECT id, resident_name, submitted_at, available_shift_ids, period_id
    FROM availability_submissions
    ORDER BY submitted_at
  `
  return rows.map((r) => ({
    id: r.id,
    residentName: r.resident_name,
    submittedAt: r.submitted_at,
    availableShiftIds: r.available_shift_ids as string[],
    periodId: r.period_id ?? undefined,
  }))
}

export async function upsertSubmission(
  submission: AvailabilitySubmission & { userId: string }
): Promise<void> {
  await ensureDb()
  const periodId = submission.periodId ?? null
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
        available_shift_ids = ${submission.availableShiftIds as unknown as string}
      WHERE user_id = ${submission.userId}
        AND (period_id = ${periodId} OR (period_id IS NULL AND ${periodId}::TEXT IS NULL))
    `
  } else {
    await sql`
      INSERT INTO availability_submissions (id, user_id, resident_name, submitted_at, available_shift_ids, period_id)
      VALUES (${submission.id}, ${submission.userId}, ${submission.residentName}, ${submission.submittedAt}, ${submission.availableShiftIds as unknown as string}, ${periodId})
    `
  }
}

// ── Schedule ──────────────────────────────────────────────────────────────────

export async function getSchedule(): Promise<Schedule | null> {
  const { rows } = await sql`
    SELECT generated_at, published_at, is_published, assignments, published_assignments
    FROM schedule WHERE singleton = 1
  `
  if (rows.length === 0) return null
  const r = rows[0]
  return {
    generatedAt: r.generated_at,
    publishedAt: r.published_at,
    isPublished: r.is_published,
    assignments: r.assignments as ShiftAssignment[],
    publishedAssignments: (r.published_assignments ?? []) as ShiftAssignment[],
  }
}

export async function setSchedule(schedule: Schedule): Promise<void> {
  const assignmentsJson = JSON.stringify(schedule.assignments)
  const publishedAssignmentsJson = JSON.stringify(schedule.publishedAssignments)
  await sql`
    INSERT INTO schedule (singleton, generated_at, published_at, is_published, assignments, published_assignments)
    VALUES (1, ${schedule.generatedAt}, ${schedule.publishedAt}, ${schedule.isPublished}, ${assignmentsJson}::jsonb, ${publishedAssignmentsJson}::jsonb)
    ON CONFLICT (singleton) DO UPDATE SET
      generated_at          = EXCLUDED.generated_at,
      published_at          = EXCLUDED.published_at,
      is_published          = EXCLUDED.is_published,
      assignments           = EXCLUDED.assignments,
      published_assignments = EXCLUDED.published_assignments
  `
}

// ── Scheduling periods ────────────────────────────────────────────────────────

export async function getSchedulingPeriods(): Promise<SchedulingPeriod[]> {
  const { rows } = await sql`
    SELECT id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date, created_at
    FROM scheduling_periods
    ORDER BY start_date
  `
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    startDate: r.start_date,
    endDate: r.end_date,
    createdAt: r.created_at,
  }))
}

export async function addSchedulingPeriod(
  period: Pick<SchedulingPeriod, 'name' | 'startDate' | 'endDate'>
): Promise<SchedulingPeriod> {
  const { rows } = await sql`
    INSERT INTO scheduling_periods (name, start_date, end_date)
    VALUES (${period.name}, ${period.startDate}, ${period.endDate})
    RETURNING id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date, created_at
  `
  const r = rows[0]
  return { id: r.id, name: r.name, startDate: r.start_date, endDate: r.end_date, createdAt: r.created_at }
}

export async function deleteSchedulingPeriod(id: string): Promise<void> {
  await sql`DELETE FROM scheduling_periods WHERE id = ${id}`
}

export async function findPeriodByName(name: string): Promise<SchedulingPeriod | null> {
  const { rows } = await sql`
    SELECT id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date, created_at
    FROM scheduling_periods WHERE name = ${name} LIMIT 1
  `
  if (rows.length === 0) return null
  const r = rows[0]
  return { id: r.id, name: r.name, startDate: r.start_date, endDate: r.end_date, createdAt: r.created_at }
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
