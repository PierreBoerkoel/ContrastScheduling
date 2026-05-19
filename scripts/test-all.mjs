/**
 * Comprehensive integration test for ContrastScheduling.
 * Tests DB functions, computeCoverageSegments, generateSchedule, and split validation logic.
 */
import postgres from 'postgres'
import { readFileSync } from 'fs'

// ── env ──────────────────────────────────────────────────────────────────────
const env = readFileSync('/Users/pierreboerkoel/Programming/ContrastScheduling/.env.local', 'utf8')
const url = env.match(/POSTGRES_URL="([^"]+)"/)?.[1]
if (!url) { console.error('No POSTGRES_URL'); process.exit(1) }
const sql = postgres(url, { ssl: 'require' })

// ── helpers ───────────────────────────────────────────────────────────────────
let passed = 0, failed = 0
function assert(condition, label) {
  if (condition) { console.log(`  ✓ ${label}`); passed++ }
  else           { console.error(`  ✗ ${label}`); failed++ }
}
function section(name) { console.log(`\n▶ ${name}`) }

// ── inline business logic (mirrors lib/types.ts) ─────────────────────────────
function computeCoverageSegments(shift, assignedResident, allSplits) {
  if (!assignedResident) return []
  if (!shift.startTime || !shift.endTime) return [{ residentName: assignedResident, start: '', end: '' }]
  const accepted = allSplits.filter(s => s.status === 'accepted')
  function segments(owner, ownedStart, ownedEnd) {
    const given = accepted
      .filter(s => s.offerorName.toLowerCase() === owner.toLowerCase() &&
                   s.offeredStart >= ownedStart && s.offeredEnd <= ownedEnd)
      .sort((a, b) => a.offeredStart.localeCompare(b.offeredStart))
    if (given.length === 0) return [{ residentName: owner, start: ownedStart, end: ownedEnd }]
    const result = []
    let pos = ownedStart
    for (const g of given) {
      if (pos < g.offeredStart) result.push({ residentName: owner, start: pos, end: g.offeredStart })
      result.push(...segments(g.acceptorName, g.offeredStart, g.offeredEnd))
      pos = g.offeredEnd
    }
    if (pos < ownedEnd) result.push({ residentName: owner, start: pos, end: ownedEnd })
    return result
  }
  return segments(assignedResident, shift.startTime, shift.endTime)
}

function generateSchedule(shifts, submissions) {
  const sorted = [...shifts].sort((a, b) =>
    a.date === b.date ? a.clinic.localeCompare(b.clinic) : a.date.localeCompare(b.date))
  const totalAssignments = {}
  const maxShiftsMap = {}
  for (const sub of submissions) {
    totalAssignments[sub.residentName] = 0
    if (sub.maxShifts && sub.maxShifts > 0) maxShiftsMap[sub.residentName] = sub.maxShifts
  }
  const assignedOnDate = {}
  const assignments = []
  for (const shift of sorted) {
    if (!assignedOnDate[shift.date]) assignedOnDate[shift.date] = new Set()
    const candidates = submissions
      .filter(sub =>
        sub.availableShiftIds.includes(shift.id) &&
        !assignedOnDate[shift.date].has(sub.residentName) &&
        totalAssignments[sub.residentName] < (maxShiftsMap[sub.residentName] ?? Infinity))
      .map(sub => sub.residentName)
    if (candidates.length === 0) { assignments.push({ shiftId: shift.id, residentName: null }); continue }
    candidates.sort((a, b) => {
      const diff = totalAssignments[a] - totalAssignments[b]
      return diff !== 0 ? diff : Math.random() - 0.5
    })
    const assigned = candidates[0]
    assignments.push({ shiftId: shift.id, residentName: assigned })
    totalAssignments[assigned]++
    assignedOnDate[shift.date].add(assigned)
  }
  return assignments
}

function timeToMinutes(t) {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

function isHalfHour(t) {
  if (!/^\d{2}:\d{2}$/.test(t)) return false
  return parseInt(t.split(':')[1]) % 30 === 0
}

function validateSplitOffer({ offeredStart, offeredEnd, ownedStart, ownedEnd, existingAccepted, offerorName, existingPending }) {
  if (!isHalfHour(offeredStart) || !isHalfHour(offeredEnd)) return 'Times must be on 30-minute boundaries'
  if (timeToMinutes(offeredStart) >= timeToMinutes(offeredEnd)) return 'Start must be before end'
  if (timeToMinutes(offeredStart) < timeToMinutes(ownedStart) ||
      timeToMinutes(offeredEnd) > timeToMinutes(ownedEnd)) return 'Outside owned window'
  for (const g of existingAccepted.filter(s => s.offerorName.toLowerCase() === offerorName.toLowerCase())) {
    const overlapStart = Math.max(timeToMinutes(offeredStart), timeToMinutes(g.offeredStart))
    const overlapEnd = Math.min(timeToMinutes(offeredEnd), timeToMinutes(g.offeredEnd))
    if (overlapStart < overlapEnd) return 'Overlaps with already-given portion'
  }
  if (existingPending) return 'Already has a pending offer'
  return null
}

// ── 0. Teardown from any prior run ───────────────────────────────────────────
const prevPeriods = await sql`SELECT id FROM scheduling_periods WHERE name = 'Test Block'`
for (const p of prevPeriods) {
  await sql`DELETE FROM availability_submissions WHERE period_id = ${p.id}`
  await sql`DELETE FROM shift_splits WHERE shift_id IN (SELECT id FROM shifts WHERE period_id = ${p.id})`
  await sql`DELETE FROM shifts WHERE period_id = ${p.id}`
  await sql`DELETE FROM scheduling_periods WHERE id = ${p.id}`
}
await sql`DELETE FROM shift_history WHERE shift_id = '2026-05-01|BC Cancer Agency CT'`

// ── 1. Schema verification ────────────────────────────────────────────────────
section('1. Schema verification')
const tables = ['shifts', 'schedule', 'scheduling_periods', 'availability_submissions',
                 'swap_requests', 'shift_history', 'shift_splits']
for (const t of tables) {
  const rows = await sql`SELECT COUNT(*) FROM information_schema.tables WHERE table_name = ${t}`
  assert(rows[0].count === '1', `Table "${t}" exists`)
}

const splitCols = await sql`
  SELECT column_name FROM information_schema.columns WHERE table_name = 'shift_splits'
`
const colNames = splitCols.map(r => r.column_name)
for (const col of ['id','shift_id','offeror_name','offeror_user_id','offered_start','offered_end','status','acceptor_name','offered_at','accepted_at']) {
  assert(colNames.includes(col), `shift_splits has column "${col}"`)
}

// ── 2. Scheduling period CRUD ─────────────────────────────────────────────────
section('2. Scheduling period CRUD')
const periodId = crypto.randomUUID()
await sql`INSERT INTO scheduling_periods (id, name, start_date, end_date) VALUES (${periodId}, 'Test Block', '2026-06-01', '2026-06-30')`
const periods = await sql`SELECT * FROM scheduling_periods WHERE id = ${periodId}`
assert(periods.length === 1, 'Period created')
assert(periods[0].name === 'Test Block', 'Period name correct')
assert(periods[0].start_date instanceof Date || typeof periods[0].start_date === 'string', 'Period dates exist')

// ── 3. Shift CRUD ──────────────────────────────────────────────────────────────
section('3. Shift CRUD')
const shifts = [
  { id: '2026-06-07|BC Cancer Agency MRI/PET', date: '2026-06-07', clinic: 'BC Cancer Agency MRI/PET', startTime: '08:00', endTime: '21:00' },
  { id: '2026-06-07|BC Cancer Agency CT',      date: '2026-06-07', clinic: 'BC Cancer Agency CT',      startTime: '08:00', endTime: '16:00' },
  { id: '2026-06-14|BC Cancer Agency MRI/PET', date: '2026-06-14', clinic: 'BC Cancer Agency MRI/PET', startTime: '08:00', endTime: '21:00' },
  { id: '2026-06-21|BC Cancer Agency MRI/PET', date: '2026-06-21', clinic: 'BC Cancer Agency MRI/PET', startTime: '08:00', endTime: '21:00' },
  { id: '2026-06-28|BC Cancer Agency MRI/PET', date: '2026-06-28', clinic: 'BC Cancer Agency MRI/PET', startTime: '08:00', endTime: '21:00' },
]
for (const s of shifts) {
  await sql`INSERT INTO shifts (id, date, clinic, period_id, start_time, end_time) VALUES (${s.id}, ${s.date}, ${s.clinic}, ${periodId}, ${s.startTime}, ${s.endTime})`
}
const shiftRows = await sql`SELECT COUNT(*) FROM shifts WHERE period_id = ${periodId}`
assert(shiftRows[0].count === '5', '5 shifts inserted')

// ── 4. Availability submissions ───────────────────────────────────────────────
section('4. Availability submissions')
const residents = ['Alice Nguyen', 'Bob Chen', 'Carol Park', 'David Kim']
const mriShifts = shifts.filter(s => s.clinic === 'BC Cancer Agency MRI/PET').map(s => s.id)
const ctShifts  = shifts.filter(s => s.clinic === 'BC Cancer Agency CT').map(s => s.id)

const submissions = [
  { name: 'Alice Nguyen', shifts: [mriShifts[0], mriShifts[1], ctShifts[0]], maxShifts: 2 },
  { name: 'Bob Chen',     shifts: [mriShifts[0], mriShifts[2], ctShifts[0]], maxShifts: null },
  { name: 'Carol Park',   shifts: [mriShifts[1], mriShifts[3], ctShifts[0]], maxShifts: null },
  { name: 'David Kim',    shifts: [mriShifts[0], mriShifts[2], mriShifts[3]], maxShifts: 2 },
]
for (const sub of submissions) {
  const id = crypto.randomUUID()
  await sql`INSERT INTO availability_submissions (id, user_id, resident_name, submitted_at, available_shift_ids, period_id, max_shifts) VALUES (${id}, ${crypto.randomUUID()}, ${sub.name}, NOW(), ${sub.shifts}, ${periodId}, ${sub.maxShifts})`
}
const subRows = await sql`SELECT COUNT(*) FROM availability_submissions WHERE period_id = ${periodId}`
assert(subRows[0].count === '4', '4 submissions inserted')

// ── 5. Schedule generation ────────────────────────────────────────────────────
section('5. Schedule generation')
const subData = submissions.map(s => ({ residentName: s.name, availableShiftIds: s.shifts, maxShifts: s.maxShifts ?? undefined }))
const generated = generateSchedule(shifts, subData)
assert(generated.length === 5, 'Assignment generated for each shift')
const assignedCount = generated.filter(a => a.residentName !== null).length
assert(assignedCount >= 4, `At least 4 shifts assigned (got ${assignedCount})`)

// Check maxShifts respected for Alice (max 2)
const aliceAssignments = generated.filter(a => a.residentName === 'Alice Nguyen')
assert(aliceAssignments.length <= 2, `Alice has ≤2 shifts (has ${aliceAssignments.length})`)

// Check maxShifts respected for David (max 2)
const davidAssignments = generated.filter(a => a.residentName === 'David Kim')
assert(davidAssignments.length <= 2, `David has ≤2 shifts (has ${davidAssignments.length})`)

// Check no resident assigned twice on same day
const byDate = {}
for (const a of generated) {
  if (!a.residentName) continue
  const date = a.shiftId.split('|')[0]
  if (!byDate[date]) byDate[date] = new Set()
  assert(!byDate[date].has(a.residentName), `No duplicate on ${date} for ${a.residentName}`)
  byDate[date].add(a.residentName)
}

// Persist schedule
const assignmentsJson = JSON.stringify(generated)
await sql`
  INSERT INTO schedule (singleton, generated_at, published_at, is_published, assignments, published_assignments)
  VALUES (1, NOW(), NOW(), TRUE, ${assignmentsJson}::jsonb, ${assignmentsJson}::jsonb)
  ON CONFLICT (singleton) DO UPDATE SET
    generated_at = NOW(), published_at = NOW(), is_published = TRUE,
    assignments = ${assignmentsJson}::jsonb, published_assignments = ${assignmentsJson}::jsonb
`
const schedRows = await sql`SELECT * FROM schedule WHERE singleton = 1`
assert(schedRows.length === 1, 'Schedule persisted')
const rawPersisted = schedRows[0].published_assignments
const persisted = typeof rawPersisted === 'string' ? JSON.parse(rawPersisted) : rawPersisted
assert(Array.isArray(persisted) && persisted.length === 5, 'Schedule has 5 assignments in DB')

// ── 6. computeCoverageSegments — no splits ───────────────────────────────────
section('6. computeCoverageSegments — no splits')
const shift1 = { id: mriShifts[0], startTime: '08:00', endTime: '21:00' }
const segsNoSplit = computeCoverageSegments(shift1, 'Alice Nguyen', [])
assert(segsNoSplit.length === 1, 'Single segment when no splits')
assert(segsNoSplit[0].residentName === 'Alice Nguyen', 'Correct resident')
assert(segsNoSplit[0].start === '08:00' && segsNoSplit[0].end === '21:00', 'Full shift window')

// ── 7. computeCoverageSegments — 2-way split ──────────────────────────────────
section('7. computeCoverageSegments — 2-way split')
const split2way = [
  { shiftId: mriShifts[0], offerorName: 'Alice Nguyen', offeredStart: '12:00', offeredEnd: '21:00',
    status: 'accepted', acceptorName: 'Bob Chen' }
]
const segs2way = computeCoverageSegments(shift1, 'Alice Nguyen', split2way)
assert(segs2way.length === 2, '2 segments for 2-way split')
assert(segs2way[0].residentName === 'Alice Nguyen' && segs2way[0].start === '08:00' && segs2way[0].end === '12:00', 'Alice covers 08:00–12:00')
assert(segs2way[1].residentName === 'Bob Chen' && segs2way[1].start === '12:00' && segs2way[1].end === '21:00', 'Bob covers 12:00–21:00')

// ── 8. computeCoverageSegments — 3-way chained split ─────────────────────────
section('8. computeCoverageSegments — 3-way chained split')
const split3way = [
  { shiftId: mriShifts[0], offerorName: 'Alice Nguyen', offeredStart: '12:00', offeredEnd: '21:00', status: 'accepted', acceptorName: 'Bob Chen' },
  { shiftId: mriShifts[0], offerorName: 'Bob Chen',     offeredStart: '16:00', offeredEnd: '21:00', status: 'accepted', acceptorName: 'Carol Park' },
]
const segs3way = computeCoverageSegments(shift1, 'Alice Nguyen', split3way)
assert(segs3way.length === 3, '3 segments for 3-way split')
assert(segs3way[0].residentName === 'Alice Nguyen' && segs3way[0].start === '08:00' && segs3way[0].end === '12:00', 'Alice: 08:00–12:00')
assert(segs3way[1].residentName === 'Bob Chen'     && segs3way[1].start === '12:00' && segs3way[1].end === '16:00', 'Bob: 12:00–16:00')
assert(segs3way[2].residentName === 'Carol Park'   && segs3way[2].start === '16:00' && segs3way[2].end === '21:00', 'Carol: 16:00–21:00')

// ── 9. computeCoverageSegments — sandwich split ───────────────────────────────
section('9. computeCoverageSegments — sandwich split (middle portion given away)')
const splitSandwich = [
  { shiftId: mriShifts[0], offerorName: 'Alice Nguyen', offeredStart: '10:00', offeredEnd: '14:00', status: 'accepted', acceptorName: 'Bob Chen' },
]
const segsSandwich = computeCoverageSegments(shift1, 'Alice Nguyen', splitSandwich)
assert(segsSandwich.length === 3, '3 segments for sandwich (Alice–Bob–Alice)')
assert(segsSandwich[0].residentName === 'Alice Nguyen' && segsSandwich[0].start === '08:00' && segsSandwich[0].end === '10:00', 'Alice: 08:00–10:00')
assert(segsSandwich[1].residentName === 'Bob Chen'     && segsSandwich[1].start === '10:00' && segsSandwich[1].end === '14:00', 'Bob: 10:00–14:00')
assert(segsSandwich[2].residentName === 'Alice Nguyen' && segsSandwich[2].start === '14:00' && segsSandwich[2].end === '21:00', 'Alice: 14:00–21:00')

// ── 10. computeCoverageSegments — pending split (should not affect segments) ──
section('10. computeCoverageSegments — pending split ignored')
const splitPending = [
  { shiftId: mriShifts[0], offerorName: 'Alice Nguyen', offeredStart: '12:00', offeredEnd: '21:00', status: 'pending', acceptorName: null },
]
const segsPending = computeCoverageSegments(shift1, 'Alice Nguyen', splitPending)
assert(segsPending.length === 1, 'Pending split does not change segments')
assert(segsPending[0].residentName === 'Alice Nguyen' && segsPending[0].start === '08:00', 'Alice still owns full shift')

// ── 11. computeCoverageSegments — cancelled split ignored ─────────────────────
section('11. computeCoverageSegments — cancelled split ignored')
const splitCancelled = [
  { shiftId: mriShifts[0], offerorName: 'Alice Nguyen', offeredStart: '12:00', offeredEnd: '21:00', status: 'cancelled', acceptorName: null },
]
const segsCancelled = computeCoverageSegments(shift1, 'Alice Nguyen', splitCancelled)
assert(segsCancelled.length === 1, 'Cancelled split does not change segments')

// ── 12. Split offer validation ────────────────────────────────────────────────
section('12. Split offer validation logic')

assert(
  validateSplitOffer({ offeredStart: '12:00', offeredEnd: '21:00', ownedStart: '08:00', ownedEnd: '21:00', existingAccepted: [], offerorName: 'Alice', existingPending: false }) === null,
  'Valid offer accepted'
)
assert(
  validateSplitOffer({ offeredStart: '12:15', offeredEnd: '21:00', ownedStart: '08:00', ownedEnd: '21:00', existingAccepted: [], offerorName: 'Alice', existingPending: false }) !== null,
  'Rejects non-30-min boundary'
)
assert(
  validateSplitOffer({ offeredStart: '21:00', offeredEnd: '12:00', ownedStart: '08:00', ownedEnd: '21:00', existingAccepted: [], offerorName: 'Alice', existingPending: false }) !== null,
  'Rejects start >= end'
)
assert(
  validateSplitOffer({ offeredStart: '07:00', offeredEnd: '12:00', ownedStart: '08:00', ownedEnd: '21:00', existingAccepted: [], offerorName: 'Alice', existingPending: false }) !== null,
  'Rejects offer before owned window'
)
assert(
  validateSplitOffer({ offeredStart: '12:00', offeredEnd: '22:00', ownedStart: '08:00', ownedEnd: '21:00', existingAccepted: [], offerorName: 'Alice', existingPending: false }) !== null,
  'Rejects offer past owned window end'
)
assert(
  validateSplitOffer({
    offeredStart: '10:00', offeredEnd: '14:00', ownedStart: '08:00', ownedEnd: '21:00',
    existingAccepted: [{ offerorName: 'Alice', offeredStart: '12:00', offeredEnd: '18:00' }],
    offerorName: 'Alice', existingPending: false
  }) !== null,
  'Rejects overlap with already-given portion'
)
assert(
  validateSplitOffer({ offeredStart: '12:00', offeredEnd: '21:00', ownedStart: '08:00', ownedEnd: '21:00', existingAccepted: [], offerorName: 'Alice', existingPending: true }) !== null,
  'Rejects when already has pending offer'
)

// ── 13. DB round-trip for shift_splits ───────────────────────────────────────
section('13. shift_splits DB round-trip')
const splitId = crypto.randomUUID()
await sql`
  INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status)
  VALUES (${splitId}, ${mriShifts[0]}, 'Alice Nguyen', 'user_alice', '12:00', '21:00', 'pending')
`
const splitRows = await sql`SELECT * FROM shift_splits WHERE id = ${splitId}`
assert(splitRows.length === 1, 'Split inserted')
assert(splitRows[0].offeror_name === 'Alice Nguyen', 'Offeror name correct')
assert(splitRows[0].offered_start === '12:00', 'Offered start correct')
assert(splitRows[0].status === 'pending', 'Status is pending')

// Accept the split
await sql`
  UPDATE shift_splits SET status = 'accepted', acceptor_name = 'Bob Chen', acceptor_user_id = 'user_bob', accepted_at = NOW()
  WHERE id = ${splitId}
`
const acceptedRows = await sql`SELECT * FROM shift_splits WHERE id = ${splitId}`
assert(acceptedRows[0].status === 'accepted', 'Split accepted')
assert(acceptedRows[0].acceptor_name === 'Bob Chen', 'Acceptor set')
assert(acceptedRows[0].accepted_at !== null, 'Accepted timestamp set')

// ── 14. Unique pending index ──────────────────────────────────────────────────
section('14. Unique pending index prevents double-pending')
// Insert a pending split for Carol
await sql`INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status)
          VALUES (${crypto.randomUUID()}, ${mriShifts[1]}, 'Carol Park', 'user_carol', '14:00', '21:00', 'pending')`
try {
  await sql`INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status)
            VALUES (${crypto.randomUUID()}, ${mriShifts[1]}, 'Carol Park', 'user_carol', '10:00', '14:00', 'pending')`
  assert(false, 'Should have rejected duplicate pending offer')
} catch (e) {
  assert(e.code === '23505', 'Unique index blocks second pending offer from same person on same shift')
}

// A cancelled one should not block a new pending
await sql`UPDATE shift_splits SET status = 'cancelled' WHERE offeror_name = 'Carol Park' AND status = 'pending'`
try {
  await sql`INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status)
            VALUES (${crypto.randomUUID()}, ${mriShifts[1]}, 'Carol Park', 'user_carol', '10:00', '14:00', 'pending')`
  assert(true, 'New pending offer allowed after cancellation')
} catch (_) {
  assert(false, 'Should allow new pending after cancel')
}

// ── 15. 4-way split DB round-trip ─────────────────────────────────────────────
section('15. 4-way split — full DB round-trip with coverage check')
const shift4 = { id: mriShifts[2], startTime: '08:00', endTime: '21:00' }
// Alice → Bob (12:00–21:00) already set up via generated schedule; add fresh splits
const s1 = crypto.randomUUID()
const s2 = crypto.randomUUID()
const s3 = crypto.randomUUID()
await sql`INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status, acceptor_name, acceptor_user_id, accepted_at)
          VALUES (${s1}, ${mriShifts[2]}, 'Alice Nguyen', 'u1', '12:00', '21:00', 'accepted', 'Bob Chen',   'u2', NOW())`
await sql`INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status, acceptor_name, acceptor_user_id, accepted_at)
          VALUES (${s2}, ${mriShifts[2]}, 'Bob Chen',    'u2', '16:00', '21:00', 'accepted', 'Carol Park', 'u3', NOW())`
await sql`INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status, acceptor_name, acceptor_user_id, accepted_at)
          VALUES (${s3}, ${mriShifts[2]}, 'Carol Park',  'u3', '18:30', '21:00', 'accepted', 'David Kim',  'u4', NOW())`

const fourWaySplits = await sql`SELECT id, offeror_name, offered_start, offered_end, status, acceptor_name FROM shift_splits WHERE shift_id = ${mriShifts[2]} AND status = 'accepted'`
const splitObjs4 = fourWaySplits.map(r => ({
  shiftId: mriShifts[2], offerorName: r.offeror_name, offeredStart: r.offered_start,
  offeredEnd: r.offered_end, status: 'accepted', acceptorName: r.acceptor_name
}))
const segs4 = computeCoverageSegments(shift4, 'Alice Nguyen', splitObjs4)
assert(segs4.length === 4, `4-way split produces 4 segments (got ${segs4.length})`)
assert(segs4[0].residentName === 'Alice Nguyen' && segs4[0].start === '08:00' && segs4[0].end === '12:00', '4-way: Alice 08:00–12:00')
assert(segs4[1].residentName === 'Bob Chen'     && segs4[1].start === '12:00' && segs4[1].end === '16:00', '4-way: Bob 12:00–16:00')
assert(segs4[2].residentName === 'Carol Park'   && segs4[2].start === '16:00' && segs4[2].end === '18:30', '4-way: Carol 16:00–18:30')
assert(segs4[3].residentName === 'David Kim'    && segs4[3].start === '18:30' && segs4[3].end === '21:00', '4-way: David 18:30–21:00')

// Total coverage = full shift (no gaps, no overlaps)
const totalMinutes = segs4.reduce((sum, s) => sum + (timeToMinutes(s.end) - timeToMinutes(s.start)), 0)
const shiftMinutes = timeToMinutes('21:00') - timeToMinutes('08:00')
assert(totalMinutes === shiftMinutes, `Total coverage equals full shift (${totalMinutes} = ${shiftMinutes} min)`)

// ── 16. generateSchedule — max shifts + equalization ─────────────────────────
section('16. generateSchedule — load balancing with maxShifts')
const testShifts = [
  { id: 'X1', date: '2026-07-05', clinic: 'A' },
  { id: 'X2', date: '2026-07-06', clinic: 'A' },
  { id: 'X3', date: '2026-07-12', clinic: 'A' },
  { id: 'X4', date: '2026-07-13', clinic: 'A' },
  { id: 'X5', date: '2026-07-19', clinic: 'A' },
  { id: 'X6', date: '2026-07-20', clinic: 'A' },
]
const testSubs = [
  { residentName: 'R1', availableShiftIds: ['X1','X2','X3','X4','X5','X6'], maxShifts: 2 },
  { residentName: 'R2', availableShiftIds: ['X1','X2','X3','X4','X5','X6'], maxShifts: undefined },
  { residentName: 'R3', availableShiftIds: ['X1','X2','X3','X4','X5','X6'], maxShifts: undefined },
]
const lb = generateSchedule(testShifts, testSubs)
const r1count = lb.filter(a => a.residentName === 'R1').length
assert(r1count <= 2, `R1 capped at maxShifts=2 (assigned ${r1count})`)
const assigned6 = lb.filter(a => a.residentName !== null).length
assert(assigned6 === 6, `All 6 shifts assigned (got ${assigned6})`)

// ── 17. Shift history persistence ─────────────────────────────────────────────
section('17. Shift history')
await sql`INSERT INTO shift_history (shift_id, date, clinic, resident_name) VALUES ('2026-05-01|BC Cancer Agency CT', '2026-05-01', 'BC Cancer Agency CT', 'Alice Nguyen')`
const hist = await sql`SELECT * FROM shift_history WHERE shift_id = '2026-05-01|BC Cancer Agency CT'`
assert(hist.length === 1, 'History entry inserted')
assert(hist[0].resident_name === 'Alice Nguyen', 'History resident correct')
// Upsert (ON CONFLICT DO UPDATE)
await sql`INSERT INTO shift_history (shift_id, date, clinic, resident_name) VALUES ('2026-05-01|BC Cancer Agency CT', '2026-05-01', 'BC Cancer Agency CT', 'Bob Chen') ON CONFLICT (shift_id) DO UPDATE SET resident_name = EXCLUDED.resident_name`
const hist2 = await sql`SELECT * FROM shift_history WHERE shift_id = '2026-05-01|BC Cancer Agency CT'`
assert(hist2[0].resident_name === 'Bob Chen', 'History upsert updates existing entry')

// ── summary ───────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`)
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed} tests`)
if (failed > 0) process.exitCode = 1

await sql.end()
