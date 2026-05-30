import { sql, db } from '@vercel/postgres'
import type { Shift, AvailabilitySubmission, SwapRequest, ShiftAssignment, SchedulingPeriod, ShiftSplit, Clinic } from './types'
import type { BillingContactRecord } from './invoices'

let _ready: Promise<void> | null = null
export function ensureDb(): Promise<void> {
  return (_ready ??= initDb().catch((e) => { _ready = null; throw e }))
}

export async function initDb(): Promise<void> {
  // ── Scheduling periods ────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS scheduling_periods (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name         TEXT NOT NULL,
      start_date   DATE NOT NULL,
      end_date     DATE NOT NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      published_at TIMESTAMPTZ,
      generated_at TIMESTAMPTZ,
      updated_at   TIMESTAMPTZ,
      deleted_at   TIMESTAMPTZ
    )
  `

  // ── Clinics (absorbs old clinic_defaults) ─────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS clinics (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name          TEXT UNIQUE NOT NULL,
      abbreviation  TEXT NOT NULL DEFAULT '',
      active_days   INTEGER[] NOT NULL DEFAULT '{}',
      weekday_start TEXT,
      weekday_end   TEXT,
      weekend_start TEXT,
      weekend_end   TEXT,
      billing_mode  TEXT NOT NULL DEFAULT 'simple',
      sort_order    INTEGER NOT NULL DEFAULT 0
    )
  `
  type ClinicSeedRow = [string, string, number[], string | null, string | null, string | null, string | null, string, number]
  const clinicSeeds: ClinicSeedRow[] = [
    ['BC Cancer Agency CT',      'BCCA CT',      [6],              '17:00', '19:00', '08:00', '16:00', 'simple',            1],
    ['BC Cancer Agency MRI/PET', 'BCCA MRI/PET', [0,1,2,3,4,5,6], '17:00', '22:00', '08:00', '21:00', 'mrct_pet_combined', 2],
    ['INITIO Medical Imaging',   'INITIO',       [0,1,2,3,4,5,6], '17:30', '21:30', '08:00', '16:00', 'simple',            3],
    ['UBC Hospital',             'UBC',          [1,2,3,4,5],     '17:30', '22:30', null,    null,    'simple',            4],
    ["BC Women's Hospital",      'BCWH',         [2],             '17:30', '21:30', null,    null,    'simple',            5],
  ]
  for (const [name, abbr, days, ws, we, ss, se, mode, order] of clinicSeeds) {
    await sql`
      INSERT INTO clinics (name, abbreviation, active_days, weekday_start, weekday_end, weekend_start, weekend_end, billing_mode, sort_order)
      VALUES (${name}, ${abbr}, ${days as unknown as string}, ${ws}, ${we}, ${ss}, ${se}, ${mode}, ${order})
      ON CONFLICT (name) DO NOTHING
    `
  }

  // ── Billing entities ──────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS billing_entities (
      id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      code  TEXT UNIQUE NOT NULL,
      label TEXT NOT NULL
    )
  `
  // Rename legacy codes before seeding so ON CONFLICT skips them correctly
  await sql`UPDATE billing_entities SET code = 'UBC'  WHERE code = 'UBCMR'`
  await sql`UPDATE billing_entities SET code = 'BCWH' WHERE code = 'BCWHMR'`

  const entitySeeds: [string, string][] = [
    ['MRCT',   'BCCA Diagnostic Imaging'],
    ['PET',    'BCCA Molecular Imaging and Therapy'],
    ['UBC',    'Vancouver Imaging'],
    ['BCWH',   'BCW Diagnostic Imaging'],
    ['INITIO', 'INITIO Medical Imaging'],
  ]
  for (const [code, label] of entitySeeds) {
    await sql`INSERT INTO billing_entities (code, label) VALUES (${code}, ${label}) ON CONFLICT (code) DO NOTHING`
  }

  // ── Clinic → billing entity mapping ──────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS clinic_billing_entities (
      clinic_id UUID NOT NULL REFERENCES clinics(id) ON DELETE CASCADE,
      entity_id UUID NOT NULL REFERENCES billing_entities(id) ON DELETE CASCADE,
      PRIMARY KEY (clinic_id, entity_id)
    )
  `
  await sql`
    INSERT INTO clinic_billing_entities (clinic_id, entity_id)
    SELECT c.id, be.id FROM clinics c, billing_entities be
    WHERE (c.name = 'BC Cancer Agency CT'      AND be.code = 'MRCT')
       OR (c.name = 'BC Cancer Agency MRI/PET' AND be.code IN ('MRCT', 'PET'))
       OR (c.name = 'UBC Hospital'             AND be.code = 'UBC')
       OR (c.name = 'BC Women''s Hospital'     AND be.code = 'BCWH')
       OR (c.name = 'INITIO Medical Imaging'   AND be.code = 'INITIO')
    ON CONFLICT DO NOTHING
  `

  // ── Shifts (clinic_id UUID FK, replaces old clinic TEXT column) ───────────
  await sql`
    CREATE TABLE IF NOT EXISTS shifts (
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      date       TEXT NOT NULL,
      clinic_id  UUID NOT NULL REFERENCES clinics(id) ON DELETE RESTRICT,
      period_id  UUID REFERENCES scheduling_periods(id) ON DELETE CASCADE,
      start_time TEXT,
      end_time   TEXT
    )
  `

  // ── Assignments, submissions, swap requests, splits ───────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS shift_assignments (
      shift_id      UUID    NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      period_id     UUID    NOT NULL REFERENCES scheduling_periods(id) ON DELETE CASCADE,
      is_draft      BOOLEAN NOT NULL,
      user_id       TEXT,
      resident_name TEXT,
      PRIMARY KEY (shift_id, is_draft)
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS availability_submissions (
      id                  TEXT PRIMARY KEY,
      user_id             TEXT,
      resident_name       TEXT NOT NULL,
      submitted_at        TIMESTAMPTZ NOT NULL,
      available_shift_ids TEXT[] NOT NULL DEFAULT '{}',
      period_id           TEXT,
      max_shifts          INTEGER
    )
  `
  await sql`
    CREATE UNIQUE INDEX IF NOT EXISTS submissions_user_period_idx
    ON availability_submissions (user_id, period_id)
    WHERE user_id IS NOT NULL AND period_id IS NOT NULL
  `
  await sql`
    CREATE TABLE IF NOT EXISTS swap_requests (
      id                  TEXT PRIMARY KEY,
      requested_at        TIMESTAMPTZ NOT NULL,
      status              TEXT NOT NULL DEFAULT 'pending',
      requestor_user_id   TEXT,
      requestor_name      TEXT NOT NULL,
      requestor_shift_id  UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      period_id           UUID REFERENCES scheduling_periods(id) ON DELETE CASCADE,
      acceptor_name       TEXT,
      acceptor_user_id    TEXT,
      acceptor_shift_id   UUID REFERENCES shifts(id) ON DELETE CASCADE,
      accepted_at         TIMESTAMPTZ
    )
  `
  await sql`
    CREATE TABLE IF NOT EXISTS shift_splits (
      id               TEXT PRIMARY KEY,
      shift_id         UUID NOT NULL REFERENCES shifts(id) ON DELETE CASCADE,
      period_id        UUID REFERENCES scheduling_periods(id) ON DELETE CASCADE,
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

  // ── Legacy table cleanup ──────────────────────────────────────────────────
  await sql`DROP TABLE IF EXISTS shift_history`
  await sql`DROP TABLE IF EXISTS schedule`

  // ── Migrations for existing DBs ───────────────────────────────────────────
  await sql`ALTER TABLE scheduling_periods ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ`
  await sql`ALTER TABLE clinics ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ`
  await sql`ALTER TABLE clinics ADD COLUMN IF NOT EXISTS pet_end_time TEXT`
  await sql`UPDATE clinics SET pet_end_time = '21:00' WHERE name = 'BC Cancer Agency MRI/PET' AND pet_end_time IS NULL`

  // Ensure period_id FKs have ON DELETE CASCADE
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'swap_requests_period_id_fkey' AND constraint_type = 'FOREIGN KEY') THEN
        ALTER TABLE swap_requests DROP CONSTRAINT swap_requests_period_id_fkey;
        ALTER TABLE swap_requests ADD CONSTRAINT swap_requests_period_id_fkey FOREIGN KEY (period_id) REFERENCES scheduling_periods(id) ON DELETE CASCADE;
      END IF;
    END $$
  `
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'shift_splits_period_id_fkey' AND constraint_type = 'FOREIGN KEY') THEN
        ALTER TABLE shift_splits DROP CONSTRAINT shift_splits_period_id_fkey;
        ALTER TABLE shift_splits ADD CONSTRAINT shift_splits_period_id_fkey FOREIGN KEY (period_id) REFERENCES scheduling_periods(id) ON DELETE CASCADE;
      END IF;
    END $$
  `

  // Migrate shifts.clinic TEXT → shifts.clinic_id UUID
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='shifts' AND column_name='clinic') THEN
        ALTER TABLE shifts ADD COLUMN IF NOT EXISTS clinic_id UUID;
        UPDATE shifts s SET clinic_id = c.id FROM clinics c WHERE c.name = s.clinic AND s.clinic_id IS NULL;
        DELETE FROM shifts WHERE clinic_id IS NULL;
        ALTER TABLE shifts ALTER COLUMN clinic_id SET NOT NULL;
        IF NOT EXISTS (SELECT 1 FROM information_schema.table_constraints WHERE constraint_name = 'shifts_clinic_id_fkey') THEN
          ALTER TABLE shifts ADD CONSTRAINT shifts_clinic_id_fkey FOREIGN KEY (clinic_id) REFERENCES clinics(id) ON DELETE RESTRICT;
        END IF;
        ALTER TABLE shifts DROP COLUMN clinic;
      END IF;
    END $$
  `

  // ── Invoice tables ────────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS invoice_sequences (
      resident_name TEXT NOT NULL,
      series        TEXT NOT NULL,
      next_number   INTEGER NOT NULL DEFAULT 1,
      user_id       TEXT,
      PRIMARY KEY (resident_name, series)
    )
  `
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

  // ── Billing rates (entity_id FK, replaces old key TEXT PK) ───────────────
  // Migration: drop old KV format (no live data to preserve pre-rollout)
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_rates' AND column_name='key') THEN
        DROP TABLE billing_rates;
      END IF;
    END $$
  `
  await sql`
    CREATE TABLE IF NOT EXISTS billing_rates (
      id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id UUID NOT NULL REFERENCES billing_entities(id) ON DELETE CASCADE,
      rate_key  TEXT NOT NULL,
      rate      NUMERIC NOT NULL,
      UNIQUE (entity_id, rate_key)
    )
  `
  const rateSeeds: [string, string, number][] = [
    ['MRCT',   'base',       50],
    ['MRCT',   'standalone', 75],
    ['MRCT',   'ct',         75],
    ['PET',    'base',       25],
    ['PET',    'standalone', 75],
    ['UBC',    'rate',       75],
    ['BCWH',   'rate',       75],
    ['INITIO', 'rate',       75],
  ]
  for (const [entityCode, rateKey, rate] of rateSeeds) {
    await sql`
      INSERT INTO billing_rates (entity_id, rate_key, rate)
      SELECT id, ${rateKey}, ${rate} FROM billing_entities WHERE code = ${entityCode}
      ON CONFLICT DO NOTHING
    `
  }
  // Remove legacy rate_key='MR' rows — seeds now insert rate_key='rate'
  await sql`
    DELETE FROM billing_rates br
    USING billing_entities be
    WHERE br.entity_id = be.id
      AND be.code IN ('UBC', 'BCWH')
      AND br.rate_key = 'MR'
  `

  // ── Billing contacts (entity_id FK, replaces old entity TEXT PK) ─────────
  // Migration: drop old format if present
  await sql`
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_contacts' AND column_name='entity')
         AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_contacts' AND column_name='entity_id') THEN
        DROP TABLE billing_contacts;
      END IF;
    END $$
  `
  await sql`
    CREATE TABLE IF NOT EXISTS billing_contacts (
      id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      entity_id    UUID UNIQUE NOT NULL REFERENCES billing_entities(id) ON DELETE CASCADE,
      contact_name TEXT NOT NULL DEFAULT '',
      org          TEXT NOT NULL DEFAULT '',
      address      TEXT NOT NULL DEFAULT '',
      email        TEXT
    )
  `
  const contactSeeds: [string, string, string, string, string | null][] = [
    ['MRCT',   'Danielle Florendo', 'BCCA Diagnostic Imaging',            '600 W 10th Ave\nVancouver BC  V5Z 4E6',        null],
    ['PET',    'Chris Raiwe',       'BCCA Molecular Imaging and Therapy', '600 W 10th Ave\nVancouver BC  V5Z 4E6',        null],
    ['UBC',    '',                  'Vancouver Imaging',                  '450-943 West Broadway\nVancouver BC  V5Z 4E1', 'finance@vancouverimaging.com'],
    ['BCWH',   'Rahul Jain',        'BCW Diagnostic Imaging',             '4500 Oak St.\nVancouver BC  V6H3N1',           null],
    ['INITIO', '',                  'INITIO Medical Imaging',             '',                                             null],
  ]
  for (const [entityCode, name, org, address, email] of contactSeeds) {
    await sql`
      INSERT INTO billing_contacts (entity_id, contact_name, org, address, email)
      SELECT id, ${name}, ${org}, ${address}, ${email} FROM billing_entities WHERE code = ${entityCode}
      ON CONFLICT DO NOTHING
    `
  }

  // ── Resident preferences ──────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS resident_preferences (
      user_id        TEXT PRIMARY KEY,
      shift_defaults JSONB NOT NULL DEFAULT '{}'::jsonb,
      clinic_prefs   JSONB NOT NULL DEFAULT '{}'::jsonb
    )
  `

  // ── Resident contacts ─────────────────────────────────────────────────────
  await sql`
    CREATE TABLE IF NOT EXISTS resident_contacts (
      user_id TEXT PRIMARY KEY,
      address TEXT NOT NULL DEFAULT '',
      phone   TEXT NOT NULL DEFAULT '',
      email   TEXT NOT NULL DEFAULT ''
    )
  `

  // ── Invoice sequences (migrate from resident_name PK to user_id PK) ───────
  await sql`
    DO $$ BEGIN
      IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'invoice_sequences' AND column_name = 'resident_name'
      ) THEN
        DROP TABLE invoice_sequences;
      END IF;
    END $$
  `
  await sql`
    CREATE TABLE IF NOT EXISTS invoice_sequences (
      user_id     TEXT NOT NULL,
      series      TEXT NOT NULL,
      next_number INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (user_id, series)
    )
  `

  // ── Drop legacy clinic_defaults ───────────────────────────────────────────
  await sql`DROP TABLE IF EXISTS clinic_defaults`
}

// ── Shifts ────────────────────────────────────────────────────────────────────

export async function getShifts(): Promise<Shift[]> {
  await ensureDb()
  const { rows } = await sql`
    SELECT s.id, s.date, c.name AS clinic, s.period_id, s.start_time, s.end_time
    FROM shifts s JOIN clinics c ON c.id = s.clinic_id
    ORDER BY s.date, c.name
  `
  return rows.map((r) => ({
    id: r.id,
    date: r.date,
    clinic: r.clinic as string,
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
      await client.sql`
        INSERT INTO shifts (id, date, clinic_id, period_id, start_time, end_time)
        VALUES (${s.id}, ${s.date}, (SELECT id FROM clinics WHERE name = ${s.clinic}), ${periodId ?? null}, ${s.startTime ?? null}, ${s.endTime ?? null})
      `
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
      SELECT id FROM availability_submissions WHERE user_id = ${submission.userId} AND period_id IS NULL
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

function periodMetaFromRow(r: Record<string, unknown>): Omit<SchedulingPeriod, 'assignments' | 'publishedAssignments'> {
  return {
    id: r.id as string,
    name: r.name as string,
    startDate: r.start_date as string,
    endDate: r.end_date as string,
    createdAt: r.created_at as string,
    publishedAt: (r.published_at as string | null) ?? undefined,
    generatedAt: (r.generated_at as string | null) ?? undefined,
    updatedAt: (r.updated_at as string | null) ?? undefined,
    deletedAt: (r.deleted_at as string | null) ?? undefined,
  }
}

async function loadAssignmentsForPeriods(periodIds: string[]): Promise<{
  draft: Map<string, ShiftAssignment[]>
  published: Map<string, ShiftAssignment[]>
}> {
  const draft = new Map<string, ShiftAssignment[]>()
  const published = new Map<string, ShiftAssignment[]>()
  if (periodIds.length === 0) return { draft, published }

  const { rows } = await sql`
    SELECT shift_id, period_id, is_draft, user_id, resident_name
    FROM shift_assignments
    WHERE period_id = ANY(${periodIds as unknown as string})
  `
  for (const r of rows) {
    const pid = r.period_id as string
    const a: ShiftAssignment = {
      shiftId: r.shift_id as string,
      residentName: (r.resident_name as string | null) ?? null,
      userId: (r.user_id as string | null) ?? null,
    }
    if (r.is_draft) {
      if (!draft.has(pid)) draft.set(pid, [])
      draft.get(pid)!.push(a)
    } else {
      if (!published.has(pid)) published.set(pid, [])
      published.get(pid)!.push(a)
    }
  }
  return { draft, published }
}

export async function getSchedulingPeriods(): Promise<SchedulingPeriod[]> {
  await ensureDb()
  const { rows } = await sql`
    SELECT id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date,
           created_at, published_at, generated_at, updated_at, deleted_at
    FROM scheduling_periods
    WHERE deleted_at IS NULL
    ORDER BY start_date
  `
  const ids = rows.map((r) => r.id as string)
  const { draft, published } = await loadAssignmentsForPeriods(ids)
  return rows.map((r) => ({
    ...periodMetaFromRow(r),
    assignments: draft.get(r.id as string) ?? [],
    publishedAssignments: published.get(r.id as string) ?? [],
  }))
}

export async function getAllSchedulingPeriods(): Promise<SchedulingPeriod[]> {
  await ensureDb()
  const { rows } = await sql`
    SELECT id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date,
           created_at, published_at, generated_at, updated_at, deleted_at
    FROM scheduling_periods
    ORDER BY start_date
  `
  const ids = rows.map((r) => r.id as string)
  const { draft, published } = await loadAssignmentsForPeriods(ids)
  return rows.map((r) => ({
    ...periodMetaFromRow(r),
    assignments: draft.get(r.id as string) ?? [],
    publishedAssignments: published.get(r.id as string) ?? [],
  }))
}

export async function getPeriod(id: string): Promise<SchedulingPeriod | null> {
  await ensureDb()
  const { rows } = await sql`
    SELECT id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date,
           created_at, published_at, generated_at, updated_at, deleted_at
    FROM scheduling_periods WHERE id = ${id}
  `
  if (rows.length === 0) return null
  const { draft, published } = await loadAssignmentsForPeriods([id])
  return {
    ...periodMetaFromRow(rows[0]),
    assignments: draft.get(id) ?? [],
    publishedAssignments: published.get(id) ?? [],
  }
}

export async function addSchedulingPeriod(
  period: Pick<SchedulingPeriod, 'name' | 'startDate' | 'endDate'>
): Promise<SchedulingPeriod> {
  await ensureDb()
  const { rows } = await sql`
    INSERT INTO scheduling_periods (name, start_date, end_date)
    VALUES (${period.name}, ${period.startDate}, ${period.endDate})
    RETURNING id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date,
              created_at, published_at, generated_at, updated_at, deleted_at
  `
  return { ...periodMetaFromRow(rows[0]), assignments: [], publishedAssignments: [] }
}

export async function deleteSchedulingPeriod(id: string): Promise<void> {
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    // Hard-delete future shifts so they don't persist as orphaned upcoming shifts.
    // Past shifts are kept for invoice history. CASCADE handles assignments/splits/swaps.
    await client.sql`DELETE FROM shifts WHERE period_id = ${id} AND date::date >= CURRENT_DATE`
    await client.sql`DELETE FROM availability_submissions WHERE period_id = ${id}`
    await client.sql`UPDATE scheduling_periods SET deleted_at = NOW() WHERE id = ${id}`
    await client.sql`COMMIT`
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

export async function findPeriodByName(name: string): Promise<SchedulingPeriod | null> {
  await ensureDb()
  const { rows } = await sql`
    SELECT id, name, start_date::TEXT AS start_date, end_date::TEXT AS end_date,
           created_at, published_at, generated_at, updated_at, deleted_at
    FROM scheduling_periods
    WHERE name = ${name} AND deleted_at IS NULL
    LIMIT 1
  `
  if (rows.length === 0) return null
  const id = rows[0].id as string
  const { draft, published } = await loadAssignmentsForPeriods([id])
  return {
    ...periodMetaFromRow(rows[0]),
    assignments: draft.get(id) ?? [],
    publishedAssignments: published.get(id) ?? [],
  }
}

export async function updateSchedulingPeriod(
  id: string,
  patch: Pick<SchedulingPeriod, 'startDate' | 'endDate'>
): Promise<void> {
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    await client.sql`
      UPDATE scheduling_periods
      SET start_date = ${patch.startDate}, end_date = ${patch.endDate},
          generated_at = NULL, updated_at = NULL, published_at = NULL
      WHERE id = ${id}
    `
    // Clear all assignments, splits, swaps, and availability submissions for this period
    await client.sql`DELETE FROM shift_assignments      WHERE period_id = ${id}`
    await client.sql`DELETE FROM shift_splits           WHERE period_id = ${id}`
    await client.sql`DELETE FROM swap_requests          WHERE period_id = ${id}`
    await client.sql`DELETE FROM availability_submissions WHERE period_id = ${id}`
    await client.sql`COMMIT`
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

export async function updatePeriodDraft(
  id: string,
  assignments: ShiftAssignment[],
  generatedAt: string | null
): Promise<void> {
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    await client.sql`DELETE FROM shift_assignments WHERE period_id = ${id} AND is_draft = true`
    for (const a of assignments) {
      await client.sql`
        INSERT INTO shift_assignments (shift_id, period_id, is_draft, user_id, resident_name)
        VALUES (${a.shiftId}, ${id}, true, ${a.userId ?? null}, ${a.residentName ?? null})
        ON CONFLICT (shift_id, is_draft) DO UPDATE SET
          user_id       = EXCLUDED.user_id,
          resident_name = EXCLUDED.resident_name
      `
    }
    await client.sql`UPDATE scheduling_periods SET generated_at = ${generatedAt} WHERE id = ${id}`
    await client.sql`COMMIT`
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

export async function publishPeriod(
  id: string,
  assignments: ShiftAssignment[]
): Promise<{ publishedAt: string; updatedAt: string | null }> {
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    await client.sql`DELETE FROM shift_assignments WHERE period_id = ${id} AND is_draft = false`
    for (const a of assignments) {
      await client.sql`
        INSERT INTO shift_assignments (shift_id, period_id, is_draft, user_id, resident_name)
        VALUES (${a.shiftId}, ${id}, false, ${a.userId ?? null}, ${a.residentName ?? null})
        ON CONFLICT (shift_id, is_draft) DO UPDATE SET
          user_id       = EXCLUDED.user_id,
          resident_name = EXCLUDED.resident_name
      `
    }
    const { rows } = await client.sql`
      UPDATE scheduling_periods
      SET published_at = COALESCE(published_at, NOW()),
          updated_at   = CASE WHEN published_at IS NOT NULL THEN NOW() ELSE NULL END
      WHERE id = ${id}
      RETURNING published_at, updated_at
    `
    await client.sql`COMMIT`
    return {
      publishedAt: rows[0].published_at as string,
      updatedAt: (rows[0].updated_at as string | null) ?? null,
    }
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

export async function updatePeriodPublishedAssignments(
  id: string,
  assignments: ShiftAssignment[]
): Promise<void> {
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    await client.sql`DELETE FROM shift_assignments WHERE period_id = ${id} AND is_draft = false`
    for (const a of assignments) {
      await client.sql`
        INSERT INTO shift_assignments (shift_id, period_id, is_draft, user_id, resident_name)
        VALUES (${a.shiftId}, ${id}, false, ${a.userId ?? null}, ${a.residentName ?? null})
        ON CONFLICT (shift_id, is_draft) DO UPDATE SET
          user_id       = EXCLUDED.user_id,
          resident_name = EXCLUDED.resident_name
      `
    }
    await client.sql`COMMIT`
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

export async function getAllPublishedAssignments(): Promise<ShiftAssignment[]> {
  await ensureDb()
  const { rows } = await sql`
    SELECT sa.shift_id, sa.user_id, sa.resident_name
    FROM shift_assignments sa
    JOIN scheduling_periods p ON p.id = sa.period_id
    WHERE sa.is_draft = false
      AND p.published_at IS NOT NULL
      AND p.deleted_at IS NULL
  `
  return rows.map((r) => ({
    shiftId: r.shift_id as string,
    residentName: (r.resident_name as string | null) ?? null,
    userId: (r.user_id as string | null) ?? null,
  }))
}

// ── Swap requests ─────────────────────────────────────────────────────────────

export async function getSwapRequests(): Promise<SwapRequest[]> {
  await ensureDb()
  const { rows } = await sql`
    SELECT sr.id, sr.requested_at, sr.status, sr.requestor_user_id, sr.requestor_name,
           sr.requestor_shift_id, sr.period_id, sr.acceptor_name, sr.acceptor_user_id,
           sr.acceptor_shift_id, sr.accepted_at
    FROM swap_requests sr
    LEFT JOIN scheduling_periods p ON p.id = sr.period_id
    WHERE sr.period_id IS NULL OR p.deleted_at IS NULL
    ORDER BY sr.requested_at DESC
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
  req: SwapRequest & { requestorUserId: string; periodId?: string }
): Promise<void> {
  await ensureDb()
  await sql`
    INSERT INTO swap_requests (id, requested_at, status, requestor_user_id, requestor_name, requestor_shift_id, period_id)
    VALUES (${req.id}, ${req.requestedAt}, ${req.status}, ${req.requestorUserId}, ${req.requestorName}, ${req.requestorShiftId}, ${req.periodId ?? null})
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
      acceptor_user_id  = COALESCE(${patch.acceptorUserId ?? null}, acceptor_user_id),
      acceptor_shift_id = COALESCE(${patch.acceptorShiftId ?? null}, acceptor_shift_id),
      accepted_at       = COALESCE(${patch.acceptedAt ?? null}, accepted_at)
    WHERE id = ${id}
    RETURNING id, requested_at, status, requestor_user_id, requestor_name,
              requestor_shift_id, period_id, acceptor_name, acceptor_user_id,
              acceptor_shift_id, accepted_at
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
    SELECT ss.id, ss.shift_id, ss.offeror_name, ss.offeror_user_id, ss.offered_start,
           ss.offered_end, ss.status, ss.acceptor_name, ss.acceptor_user_id,
           ss.offered_at, ss.accepted_at
    FROM shift_splits ss
    LEFT JOIN scheduling_periods p ON p.id = ss.period_id
    WHERE ss.period_id IS NULL OR p.deleted_at IS NULL
    ORDER BY ss.offered_at ASC
  `
  return rows.map(rowToSplit)
}

export async function addShiftSplit(
  split: Omit<ShiftSplit, 'offeredAt' | 'acceptorName' | 'acceptedAt'> & { offerorUserId: string; periodId?: string }
): Promise<ShiftSplit> {
  await ensureDb()
  const { rows } = await sql`
    INSERT INTO shift_splits (id, shift_id, period_id, offeror_name, offeror_user_id, offered_start, offered_end, status)
    VALUES (${split.id}, ${split.shiftId}, ${split.periodId ?? null}, ${split.offerorName}, ${split.offerorUserId}, ${split.offeredStart}, ${split.offeredEnd}, 'pending')
    RETURNING id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status, acceptor_name, acceptor_user_id, offered_at, accepted_at
  `
  return rowToSplit(rows[0])
}

export async function addAcceptedShiftSplit(split: {
  id: string
  shiftId: string
  periodId?: string
  offerorName: string
  offerorUserId: string
  acceptorName: string
  acceptorUserId: string
  offeredStart: string
  offeredEnd: string
}): Promise<ShiftSplit> {
  await ensureDb()
  const { rows } = await sql`
    INSERT INTO shift_splits (id, shift_id, period_id, offeror_name, offeror_user_id, offered_start, offered_end, status, acceptor_name, acceptor_user_id, accepted_at)
    VALUES (${split.id}, ${split.shiftId}, ${split.periodId ?? null}, ${split.offerorName}, ${split.offerorUserId}, ${split.offeredStart}, ${split.offeredEnd}, 'accepted', ${split.acceptorName}, ${split.acceptorUserId}, NOW())
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
  await sql`
    INSERT INTO invoice_sequences (user_id, series, next_number)
    VALUES (${userId}, ${series}, ${nextNumber})
    ON CONFLICT (user_id, series) DO UPDATE SET next_number = EXCLUDED.next_number
  `
}

// ── Billing entities ─────────────────────────────────────────────────────────

export interface BillingEntityRecord {
  id: string
  code: string
  label: string
  simpleRate: number | null  // single flat rate if simple; null for complex multi-rate entities
}

export async function getBillingEntities(): Promise<BillingEntityRecord[]> {
  await ensureDb()
  const { rows } = await sql`
    SELECT be.id, be.code, be.label,
           (SELECT br.rate FROM billing_rates br WHERE br.entity_id = be.id AND br.rate_key = 'rate' LIMIT 1) AS simple_rate
    FROM billing_entities be
    ORDER BY be.code
  `
  return rows.map((r) => ({
    id: r.id as string,
    code: r.code as string,
    label: r.label as string,
    simpleRate: r.simple_rate != null ? parseFloat(r.simple_rate as string) : null,
  }))
}

export async function addBillingEntity(data: {
  code: string
  label: string
  rate: number
  contactName: string
  org: string
  address: string
  email: string | null
}): Promise<BillingEntityRecord> {
  await ensureDb()
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    const { rows } = await client.sql`
      INSERT INTO billing_entities (code, label)
      VALUES (${data.code}, ${data.label})
      RETURNING id
    `
    const id = rows[0].id as string
    await client.sql`
      INSERT INTO billing_rates (entity_id, rate_key, rate)
      VALUES (${id}, 'rate', ${data.rate})
    `
    await client.sql`
      INSERT INTO billing_contacts (entity_id, contact_name, org, address, email)
      VALUES (${id}, ${data.contactName}, ${data.org}, ${data.address}, ${data.email})
    `
    await client.sql`COMMIT`
    return { id, code: data.code, label: data.label, simpleRate: data.rate }
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

export async function updateBillingEntity(id: string, data: {
  code: string
  label: string
  rate: number
}): Promise<void> {
  await ensureDb()
  await sql`UPDATE billing_entities SET code = ${data.code}, label = ${data.label} WHERE id = ${id}`
  await sql`
    INSERT INTO billing_rates (entity_id, rate_key, rate)
    VALUES (${id}, 'rate', ${data.rate})
    ON CONFLICT (entity_id, rate_key) DO UPDATE SET rate = ${data.rate}
  `
}

// ── Clinics ───────────────────────────────────────────────────────────────────

export async function getClinics(opts: { includeArchived?: boolean; archivedOnly?: boolean } = {}): Promise<Clinic[]> {
  await ensureDb()
  const archivedOnly = opts.archivedOnly ?? false
  const includeArchived = opts.includeArchived ?? false
  const { rows } = await sql`
    SELECT c.id, c.name, c.abbreviation, c.active_days, c.weekday_start, c.weekday_end,
           c.weekend_start, c.weekend_end, c.billing_mode, c.sort_order, c.pet_end_time, c.archived_at,
           COALESCE(array_agg(be.code ORDER BY be.code) FILTER (WHERE be.code IS NOT NULL), '{}') AS entity_codes
    FROM clinics c
    LEFT JOIN clinic_billing_entities cbe ON cbe.clinic_id = c.id
    LEFT JOIN billing_entities be ON be.id = cbe.entity_id
    WHERE (${archivedOnly}::boolean AND c.archived_at IS NOT NULL)
       OR (NOT ${archivedOnly}::boolean AND (${includeArchived}::boolean OR c.archived_at IS NULL))
    GROUP BY c.id
    ORDER BY c.sort_order, c.name
  `
  return rows.map((r) => ({
    id: r.id as string,
    name: r.name as string,
    abbreviation: r.abbreviation as string,
    activeDays: r.active_days as number[],
    weekdayStart: (r.weekday_start as string | null) ?? null,
    weekdayEnd: (r.weekday_end as string | null) ?? null,
    weekendStart: (r.weekend_start as string | null) ?? null,
    weekendEnd: (r.weekend_end as string | null) ?? null,
    billingMode: r.billing_mode as string,
    billingEntityCodes: r.entity_codes as string[],
    sortOrder: r.sort_order as number,
    petEndTime: (r.pet_end_time as string | null) ?? null,
    archivedAt: (r.archived_at as string | null) ?? null,
  }))
}

export async function archiveClinic(id: string, archive: boolean): Promise<void> {
  await ensureDb()
  if (archive) {
    await sql`UPDATE clinics SET archived_at = now() WHERE id = ${id}`
  } else {
    await sql`UPDATE clinics SET archived_at = NULL WHERE id = ${id}`
  }
}

export const getClinicDefaults = getClinics

export async function addClinic(data: Omit<Clinic, 'id'>): Promise<Clinic> {
  await ensureDb()
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    const { rows } = await client.sql`
      INSERT INTO clinics (name, abbreviation, active_days, weekday_start, weekday_end, weekend_start, weekend_end, billing_mode, sort_order, pet_end_time)
      VALUES (${data.name}, ${data.abbreviation}, ${data.activeDays as unknown as string}, ${data.weekdayStart}, ${data.weekdayEnd}, ${data.weekendStart}, ${data.weekendEnd}, ${data.billingMode}, ${data.sortOrder}, ${data.petEndTime ?? null})
      RETURNING id
    `
    const id = rows[0].id as string
    for (const code of data.billingEntityCodes) {
      await client.sql`
        INSERT INTO clinic_billing_entities (clinic_id, entity_id)
        SELECT ${id}, be.id FROM billing_entities be WHERE be.code = ${code}
        ON CONFLICT DO NOTHING
      `
    }
    await client.sql`COMMIT`
    return { ...data, id }
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

export async function updateClinic(id: string, data: Omit<Clinic, 'id'>): Promise<void> {
  await ensureDb()
  const client = await db.connect()
  try {
    await client.sql`BEGIN`
    await client.sql`
      UPDATE clinics SET
        name          = ${data.name},
        abbreviation  = ${data.abbreviation},
        active_days   = ${data.activeDays as unknown as string},
        weekday_start = ${data.weekdayStart},
        weekday_end   = ${data.weekdayEnd},
        weekend_start = ${data.weekendStart},
        weekend_end   = ${data.weekendEnd},
        billing_mode  = ${data.billingMode},
        sort_order    = ${data.sortOrder},
        pet_end_time  = ${data.petEndTime ?? null}
      WHERE id = ${id}
    `
    await client.sql`DELETE FROM clinic_billing_entities WHERE clinic_id = ${id}`
    for (const code of data.billingEntityCodes) {
      await client.sql`
        INSERT INTO clinic_billing_entities (clinic_id, entity_id)
        SELECT ${id}, be.id FROM billing_entities be WHERE be.code = ${code}
        ON CONFLICT DO NOTHING
      `
    }
    await client.sql`COMMIT`
  } catch (e) {
    await client.sql`ROLLBACK`
    throw e
  } finally {
    client.release()
  }
}

export async function deleteClinic(id: string): Promise<void> {
  await ensureDb()
  // Delete billing entities (and their contacts/rates via CASCADE) that are
  // exclusively linked to this clinic and will become orphaned after deletion.
  await sql`
    DELETE FROM billing_entities
    WHERE id IN (
      SELECT cbe.entity_id FROM clinic_billing_entities cbe
      WHERE cbe.clinic_id = ${id}
        AND NOT EXISTS (
          SELECT 1 FROM clinic_billing_entities cbe2
          WHERE cbe2.entity_id = cbe.entity_id AND cbe2.clinic_id != ${id}
        )
    )
  `
  await sql`DELETE FROM clinics WHERE id = ${id}`
}

// ── Billing contacts ──────────────────────────────────────────────────────────

export async function getBillingContacts(): Promise<BillingContactRecord[]> {
  await ensureDb()
  const { rows } = await sql`
    SELECT be.code AS entity, bc.contact_name, bc.org, bc.address, bc.email
    FROM billing_contacts bc
    JOIN billing_entities be ON be.id = bc.entity_id
    ORDER BY be.code
  `
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
    INSERT INTO billing_contacts (entity_id, contact_name, org, address, email)
    SELECT be.id, ${data.contactName}, ${data.org}, ${data.address}, ${data.email}
    FROM billing_entities be WHERE be.code = ${entity}
    ON CONFLICT (entity_id) DO UPDATE SET
      contact_name = ${data.contactName},
      org          = ${data.org},
      address      = ${data.address},
      email        = ${data.email}
  `
}

// ── Billing rates ─────────────────────────────────────────────────────────────

export async function getBillingRates(): Promise<Record<string, number>> {
  await ensureDb()
  const { rows } = await sql`
    SELECT be.code, br.rate_key, br.rate
    FROM billing_rates br
    JOIN billing_entities be ON be.id = br.entity_id
  `
  return Object.fromEntries(rows.map((r) => [`${r.code}_${r.rate_key}`, parseFloat(r.rate as string)]))
}

export async function setBillingRate(key: string, value: number): Promise<void> {
  await ensureDb()
  const sep = key.indexOf('_')
  const entityCode = key.slice(0, sep)
  const rateKey = key.slice(sep + 1)
  await sql`
    UPDATE billing_rates br SET rate = ${value}
    FROM billing_entities be
    WHERE be.id = br.entity_id AND be.code = ${entityCode} AND br.rate_key = ${rateKey}
  `
}

// ── Resident preferences ──────────────────────────────────────────────────────

export interface ResidentPreferences {
  shiftDefaults:  Record<string, { weekday: boolean; weekend: boolean }>
  weekdayRanking: string[]
  weekendRanking: string[]
}

function parsePrefs(shiftDefaultsRaw: unknown, clinicPrefsRaw: unknown): ResidentPreferences {
  const shiftDefaults = (shiftDefaultsRaw ?? {}) as ResidentPreferences['shiftDefaults']
  const raw = (clinicPrefsRaw ?? {}) as Record<string, unknown>
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

// ── Resident contacts ─────────────────────────────────────────────────────────

export interface ResidentContact {
  address: string
  phone: string
  email: string
}

export async function getResidentContact(userId: string): Promise<ResidentContact | null> {
  await ensureDb()
  const { rows } = await sql`
    SELECT address, phone, email FROM resident_contacts WHERE user_id = ${userId}
  `
  if (rows.length === 0) return null
  return { address: rows[0].address as string, phone: rows[0].phone as string, email: rows[0].email as string }
}

export async function upsertResidentContact(userId: string, contact: ResidentContact): Promise<void> {
  await ensureDb()
  await sql`
    INSERT INTO resident_contacts (user_id, address, phone, email)
    VALUES (${userId}, ${contact.address}, ${contact.phone}, ${contact.email})
    ON CONFLICT (user_id) DO UPDATE SET
      address = EXCLUDED.address,
      phone   = EXCLUDED.phone,
      email   = EXCLUDED.email
  `
}

export async function getAllResidentContacts(): Promise<Record<string, ResidentContact>> {
  await ensureDb()
  const { rows } = await sql`SELECT user_id, address, phone, email FROM resident_contacts`
  return Object.fromEntries(
    rows.map((r) => [r.user_id as string, { address: r.address as string, phone: r.phone as string, email: r.email as string }])
  )
}
