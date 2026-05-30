#!/usr/bin/env node
/**
 * Comprehensive test suite — business logic, DB layer, and HTTP API.
 * Usage: node --env-file=.env.local scripts/test.mjs
 */

const { POSTGRES_URL, CLERK_SECRET_KEY } = process.env
const BASE_URL = process.env.TEST_BASE_URL ?? 'http://localhost:3000'
if (!POSTGRES_URL)     { console.error('POSTGRES_URL missing — run: node --env-file=.env.local scripts/test.mjs'); process.exit(1) }
if (!CLERK_SECRET_KEY) { console.error('CLERK_SECRET_KEY missing — run: node --env-file=.env.local scripts/test.mjs'); process.exit(1) }

import postgres from 'postgres'
const db = postgres(POSTGRES_URL, { ssl: 'require' })

// ── Test runner ───────────────────────────────────────────────────────────────
let passed = 0, failed = 0
const failures = []
const ok   = (label)            => { console.log(`  ✓ ${label}`); passed++ }
const fail = (label, detail='') => { const m = detail ? `${label}: ${detail}` : label; console.error(`  ✗ ${m}`); failures.push(m); failed++ }
const assert = (cond, label, detail='') => cond ? ok(label) : fail(label, detail)
const section = (name) => console.log(`\n── ${name} ──`)

// ── Inline business logic (mirrors lib/types.ts + lib/scheduler.ts) ───────────
function computeCoverageSegments(shift, assignedResident, allSplits, assignedUserId) {
  if (!assignedResident) return []
  if (!shift.startTime || !shift.endTime)
    return [{ residentName: assignedResident, userId: assignedUserId, start: '', end: '' }]
  const accepted = allSplits.filter(s => s.status === 'accepted')
  function segments(owner, ownerId, ownedStart, ownedEnd) {
    const given = accepted
      .filter(s => s.offerorUserId === ownerId && s.offeredStart >= ownedStart && s.offeredEnd <= ownedEnd)
      .sort((a, b) => a.offeredStart.localeCompare(b.offeredStart))
    if (!given.length) return [{ residentName: owner, userId: ownerId, start: ownedStart, end: ownedEnd }]
    const result = []; let pos = ownedStart
    for (const g of given) {
      if (pos < g.offeredStart) result.push({ residentName: owner, userId: ownerId, start: pos, end: g.offeredStart })
      result.push(...segments(g.acceptorName, g.acceptorUserId, g.offeredStart, g.offeredEnd))
      pos = g.offeredEnd
    }
    if (pos < ownedEnd) result.push({ residentName: owner, userId: ownerId, start: pos, end: ownedEnd })
    return result
  }
  const raw = segments(assignedResident, assignedUserId, shift.startTime, shift.endTime)
  const merged = []
  for (const seg of raw) {
    const prev = merged[merged.length - 1]
    const same = prev
      ? (prev.userId && seg.userId ? prev.userId === seg.userId : prev.residentName.toLowerCase() === seg.residentName.toLowerCase())
      : false
    if (same && prev.end === seg.start) { prev.end = seg.end } else { merged.push({ ...seg }) }
  }
  return merged
}

function generateSchedule(shifts, submissions, prefsByUserId = {}) {
  function isWeekend(date) { return [0, 6].includes(new Date(date + 'T00:00:00Z').getUTCDay()) }
  function fairRandom(items) { return items[Math.floor(Math.random() * items.length)] }
  function topAvailable(remaining, ranking) {
    for (const clinic of ranking) {
      const match = remaining.find((s) => s.clinic === clinic)
      if (match) return match
    }
    return fairRandom(remaining)
  }

  const subByKey = new Map()
  for (const sub of submissions) subByKey.set(sub.userId ?? sub.residentName, sub)

  const totalAssignments = {}, maxShiftsMap = {}, availableIds = new Map()
  for (const [key, sub] of subByKey) {
    totalAssignments[key] = 0
    if (sub.maxShifts && sub.maxShifts > 0) maxShiftsMap[key] = sub.maxShifts
    availableIds.set(key, new Set(sub.availableShiftIds))
  }

  const shiftsByDate = new Map()
  for (const shift of [...shifts].sort((a, b) => a.date.localeCompare(b.date))) {
    let dayShifts = shiftsByDate.get(shift.date)
    if (!dayShifts) { dayShifts = []; shiftsByDate.set(shift.date, dayShifts) }
    dayShifts.push(shift)
  }

  const dayEntries = [...shiftsByDate.entries()]
  for (let i = dayEntries.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [dayEntries[i], dayEntries[j]] = [dayEntries[j], dayEntries[i]]
  }

  const allAssignments = new Map()

  for (const [date, dayShifts] of dayEntries) {
    const weekend = isWeekend(date)
    const remaining = new Map(dayShifts.map((s) => [s.id, s]))
    const pool = new Set(
      [...subByKey.keys()].filter(
        (key) =>
          dayShifts.some((s) => availableIds.get(key).has(s.id)) &&
          totalAssignments[key] < (maxShiftsMap[key] ?? Infinity)
      )
    )

    while (remaining.size > 0 && pool.size > 0) {
      const drawn = fairRandom([...pool])
      pool.delete(drawn)
      const ids = availableIds.get(drawn)
      const available = [...remaining.values()].filter((s) => ids.has(s.id))
      if (available.length === 0) continue

      const sub = subByKey.get(drawn)
      const prefs = sub.userId ? prefsByUserId[sub.userId] : undefined
      const rawRanking = prefs ? (weekend ? prefs.weekendRanking : prefs.weekdayRanking) : []
      const availableClinics = new Set(available.map((s) => s.clinic))
      const ranking = (rawRanking ?? []).filter((c) => availableClinics.has(c))
      const assigned = topAvailable(available, ranking)

      allAssignments.set(assigned.id, {
        shiftId: assigned.id,
        residentName: sub.residentName,
        userId: sub.userId ?? null,
      })
      remaining.delete(assigned.id)
      totalAssignments[drawn]++

      for (const key of pool) {
        const keyIds = availableIds.get(key)
        if (![...remaining.keys()].some((id) => keyIds.has(id))) pool.delete(key)
      }
    }

    for (const [id] of remaining) allAssignments.set(id, { shiftId: id, residentName: null, userId: null })
  }

  return shifts.map(
    (s) => allAssignments.get(s.id) ?? { shiftId: s.id, residentName: null, userId: null }
  )
}

function validateSplit({ offeredStart, offeredEnd, ownedStart, ownedEnd, givenAway = [], hasPending = false }) {
  const mins = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
  const halfHour = t => /^\d{2}:\d{2}$/.test(t) && parseInt(t.split(':')[1]) % 30 === 0
  if (!halfHour(offeredStart) || !halfHour(offeredEnd)) return '30-min boundary required'
  if (mins(offeredStart) >= mins(offeredEnd)) return 'start must be before end'
  if (mins(offeredStart) < mins(ownedStart) || mins(offeredEnd) > mins(ownedEnd)) return 'outside owned window'
  for (const g of givenAway) {
    if (Math.max(mins(offeredStart), mins(g.offeredStart)) < Math.min(mins(offeredEnd), mins(g.offeredEnd)))
      return 'overlaps already-given portion'
  }
  if (hasPending) return 'already has pending offer'
  return null
}

// ════════════════════════════════════════════════════════════════════════════
// SECTION 1 — Pure business logic (no I/O)
// ════════════════════════════════════════════════════════════════════════════
section('1.1  computeCoverageSegments — no splits')
const SHIFT = { startTime: '08:00', endTime: '21:00' }
const s1 = computeCoverageSegments(SHIFT, 'Alice', [], 'uA')
assert(s1.length === 1, 'returns 1 segment')
assert(s1[0].start === '08:00' && s1[0].end === '21:00', 'full window')
assert(s1[0].userId === 'uA', 'userId tagged')

section('1.2  computeCoverageSegments — 2-way split')
const s2 = computeCoverageSegments(SHIFT, 'Alice', [
  { offerorUserId: 'uA', acceptorName: 'Bob', acceptorUserId: 'uB', offeredStart: '14:00', offeredEnd: '21:00', status: 'accepted' }
], 'uA')
assert(s2.length === 2, '2 segments')
assert(s2[0].userId === 'uA' && s2[0].end === '14:00', 'Alice covers 08:00–14:00')
assert(s2[1].userId === 'uB' && s2[1].start === '14:00', 'Bob covers 14:00–21:00')

section('1.3  computeCoverageSegments — 3-way chain')
const s3 = computeCoverageSegments(SHIFT, 'Alice', [
  { offerorUserId: 'uA', acceptorName: 'Bob',   acceptorUserId: 'uB', offeredStart: '12:00', offeredEnd: '21:00', status: 'accepted' },
  { offerorUserId: 'uB', acceptorName: 'Carol',  acceptorUserId: 'uC', offeredStart: '16:00', offeredEnd: '21:00', status: 'accepted' },
], 'uA')
assert(s3.length === 3, '3 segments')
assert(s3[0].userId === 'uA' && s3[0].end === '12:00', 'Alice: 08:00–12:00')
assert(s3[1].userId === 'uB' && s3[1].start === '12:00' && s3[1].end === '16:00', 'Bob: 12:00–16:00')
assert(s3[2].userId === 'uC' && s3[2].start === '16:00', 'Carol: 16:00–21:00')

section('1.4  computeCoverageSegments — sandwich (middle given away)')
const s4 = computeCoverageSegments(SHIFT, 'Alice', [
  { offerorUserId: 'uA', acceptorName: 'Bob', acceptorUserId: 'uB', offeredStart: '10:00', offeredEnd: '14:00', status: 'accepted' }
], 'uA')
assert(s4.length === 3, '3 segments for sandwich')
assert(s4[0].userId === 'uA' && s4[0].end === '10:00', 'Alice: 08:00–10:00')
assert(s4[1].userId === 'uB', 'Bob: 10:00–14:00')
assert(s4[2].userId === 'uA' && s4[2].start === '14:00', 'Alice: 14:00–21:00')

section('1.5  computeCoverageSegments — pending + cancelled ignored')
const sp = computeCoverageSegments(SHIFT, 'Alice', [
  { offerorUserId: 'uA', acceptorName: 'Bob',   acceptorUserId: 'uB', offeredStart: '12:00', offeredEnd: '21:00', status: 'pending' },
  { offerorUserId: 'uA', acceptorName: 'Carol', acceptorUserId: 'uC', offeredStart: '08:00', offeredEnd: '12:00', status: 'cancelled' },
], 'uA')
assert(sp.length === 1 && sp[0].userId === 'uA', 'pending/cancelled splits ignored')

section('1.6  computeCoverageSegments — 4-way chain coverage integrity')
const s5 = computeCoverageSegments(SHIFT, 'Alice', [
  { offerorUserId: 'uA', acceptorName: 'Bob',   acceptorUserId: 'uB', offeredStart: '12:00', offeredEnd: '21:00', status: 'accepted' },
  { offerorUserId: 'uB', acceptorName: 'Carol',  acceptorUserId: 'uC', offeredStart: '16:00', offeredEnd: '21:00', status: 'accepted' },
  { offerorUserId: 'uC', acceptorName: 'David',  acceptorUserId: 'uD', offeredStart: '18:30', offeredEnd: '21:00', status: 'accepted' },
], 'uA')
assert(s5.length === 4, '4 segments for 4-way chain')
const mins = t => { const [h,m] = t.split(':').map(Number); return h*60+m }
const total = s5.reduce((n, s) => n + mins(s.end) - mins(s.start), 0)
assert(total === mins('21:00') - mins('08:00'), `total coverage = full shift (${total} min)`)

section('1.7  computeCoverageSegments — adjacent same-user segments merge')
const sm = computeCoverageSegments(SHIFT, 'Alice', [
  { offerorUserId: 'uA', acceptorName: 'Bob', acceptorUserId: 'uB', offeredStart: '12:00', offeredEnd: '14:00', status: 'accepted' },
  { offerorUserId: 'uA', acceptorName: 'Bob', acceptorUserId: 'uB', offeredStart: '16:00', offeredEnd: '18:00', status: 'accepted' },
], 'uA')
// Alice: 08-12, Bob: 12-14, Alice: 14-16, Bob: 16-18, Alice: 18-21
assert(sm.length === 5, '5 segments (non-adjacent Bob portions)')
assert(sm.filter(s => s.userId === 'uA').length === 3, 'Alice has 3 non-contiguous segments')

section('1.8  computeCoverageSegments — unassigned returns empty')
assert(computeCoverageSegments(SHIFT, null, []).length === 0, 'null assignee → []')

section('1.9  generateSchedule — deterministic single-resident')
const sched1 = generateSchedule(
  [{ id: 'S1', date: '2026-01-05', clinic: 'A' }],
  [{ residentName: 'Alice', userId: 'uA', availableShiftIds: ['S1'] }]
)
assert(sched1[0]?.residentName === 'Alice', 'Alice gets the only shift she is available for')

section('1.10 generateSchedule — maxShifts cap')
const shifts6 = Array.from({ length: 6 }, (_, i) => ({ id: `D${i}`, date: `2026-0${i+1}-01`, clinic: 'A' }))
const sub3 = [
  { residentName: 'R1', userId: 'u1', availableShiftIds: shifts6.map(s => s.id), maxShifts: 2 },
  { residentName: 'R2', userId: 'u2', availableShiftIds: shifts6.map(s => s.id) },
  { residentName: 'R3', userId: 'u3', availableShiftIds: shifts6.map(s => s.id) },
]
const lb = generateSchedule(shifts6, sub3)
assert(lb.filter(a => a.residentName === 'R1').length <= 2, 'maxShifts=2 respected for R1')
assert(lb.filter(a => a.residentName !== null).length === 6, 'all 6 shifts assigned')

section('1.11 generateSchedule — one shift per day per resident')
const twoSameDay = [
  { id: 'X1', date: '2026-07-01', clinic: 'A' },
  { id: 'X2', date: '2026-07-01', clinic: 'B' },
  { id: 'X3', date: '2026-07-02', clinic: 'A' },
]
const oneSub = [{ residentName: 'Alice', userId: 'uA', availableShiftIds: ['X1','X2','X3'] }]
const dayTest = generateSchedule(twoSameDay, oneSub)
const aliceOnSameDay = dayTest.filter(a => a.residentName === 'Alice' && a.shiftId !== 'X3').length
assert(aliceOnSameDay <= 1, 'Alice gets at most 1 shift on 2026-07-01')

section('1.12 generateSchedule — null when no eligible candidates')
const nullTest = generateSchedule(
  [{ id: 'Z1', date: '2026-01-01', clinic: 'A' }],
  [{ residentName: 'Bob', userId: 'uB', availableShiftIds: [] }]
)
assert(nullTest[0]?.residentName === null, 'null assigned when nobody available')

section('1.13 validateSplit — valid offer')
assert(validateSplit({ offeredStart: '12:00', offeredEnd: '18:00', ownedStart: '08:00', ownedEnd: '21:00' }) === null, 'valid offer accepted')

section('1.14 validateSplit — boundary / range / overlap checks')
assert(validateSplit({ offeredStart: '12:15', offeredEnd: '18:00', ownedStart: '08:00', ownedEnd: '21:00' }) !== null, 'rejects non-30-min boundary')
assert(validateSplit({ offeredStart: '18:00', offeredEnd: '12:00', ownedStart: '08:00', ownedEnd: '21:00' }) !== null, 'rejects start >= end')
assert(validateSplit({ offeredStart: '06:00', offeredEnd: '12:00', ownedStart: '08:00', ownedEnd: '21:00' }) !== null, 'rejects before owned window')
assert(validateSplit({ offeredStart: '12:00', offeredEnd: '22:00', ownedStart: '08:00', ownedEnd: '21:00' }) !== null, 'rejects past owned window')
assert(validateSplit({
  offeredStart: '10:00', offeredEnd: '14:00', ownedStart: '08:00', ownedEnd: '21:00',
  givenAway: [{ offeredStart: '12:00', offeredEnd: '18:00' }]
}) !== null, 'rejects overlap with given portion')
assert(validateSplit({ offeredStart: '12:00', offeredEnd: '18:00', ownedStart: '08:00', ownedEnd: '21:00', hasPending: true }) !== null, 'rejects when already pending')

section('1.15 generateSchedule — top-ranked clinic chosen (single user, two clinics same day)')
const pref1Shifts = [
  { id: 'P1', date: '2026-07-15', clinic: 'BCWH' },
  { id: 'P2', date: '2026-07-15', clinic: 'CT' },
]
const pref1Subs = [{ residentName: 'Alice', userId: 'uA', availableShiftIds: ['P1', 'P2'] }]
const pref1Prefs = { uA: { weekdayRanking: ['CT', 'BCWH'], weekendRanking: [] } }
const pref1Result = generateSchedule(pref1Shifts, pref1Subs, pref1Prefs)
assert(pref1Result.find(a => a.shiftId === 'P2')?.userId === 'uA', 'Alice placed at top-ranked clinic CT')
assert(pref1Result.find(a => a.shiftId === 'P1')?.residentName === null, 'BCWH unassigned (only one resident, placed at CT)')

section('1.16 generateSchedule — two users, different top preferences (deterministic, no conflict)')
const pref2Shifts = [
  { id: 'Q1', date: '2026-07-16', clinic: 'A' },
  { id: 'Q2', date: '2026-07-16', clinic: 'B' },
]
const pref2Subs = [
  { residentName: 'Alice', userId: 'uA', availableShiftIds: ['Q1', 'Q2'] },
  { residentName: 'Bob',   userId: 'uB', availableShiftIds: ['Q1', 'Q2'] },
]
const pref2Prefs = {
  uA: { weekdayRanking: ['A', 'B'], weekendRanking: [] },
  uB: { weekdayRanking: ['B', 'A'], weekendRanking: [] },
}
const pref2Result = generateSchedule(pref2Shifts, pref2Subs, pref2Prefs)
assert(pref2Result.find(a => a.shiftId === 'Q1')?.userId === 'uA', 'Alice gets clinic A (her top preference)')
assert(pref2Result.find(a => a.shiftId === 'Q2')?.userId === 'uB', 'Bob gets clinic B (his top preference)')

section('1.17 generateSchedule — two users, same top preference (one gets it, other falls back)')
const pref3Shifts = [
  { id: 'R1', date: '2026-07-17', clinic: 'A' },
  { id: 'R2', date: '2026-07-17', clinic: 'B' },
]
const pref3Subs = [
  { residentName: 'Alice', userId: 'uA', availableShiftIds: ['R1', 'R2'] },
  { residentName: 'Bob',   userId: 'uB', availableShiftIds: ['R1', 'R2'] },
]
const pref3Prefs = {
  uA: { weekdayRanking: ['A', 'B'], weekendRanking: [] },
  uB: { weekdayRanking: ['A', 'B'], weekendRanking: [] },
}
const pref3Result = generateSchedule(pref3Shifts, pref3Subs, pref3Prefs)
const r3A = pref3Result.find(a => a.shiftId === 'R1')
const r3B = pref3Result.find(a => a.shiftId === 'R2')
assert(r3A?.userId !== null && r3B?.userId !== null, 'both shifts assigned when 2 users share top preference')
assert(
  (r3A.userId === 'uA' && r3B.userId === 'uB') || (r3A.userId === 'uB' && r3B.userId === 'uA'),
  'each user assigned exactly one shift'
)
assert(r3A.userId !== r3B.userId, 'different users on each shift (no double-booking)')

section('1.18 generateSchedule — pool pruning (resident with no remaining available shifts excluded)')
const pref4Shifts = [
  { id: 'T1', date: '2026-07-18', clinic: 'A' },
  { id: 'T2', date: '2026-07-18', clinic: 'B' },
]
const pref4Subs = [
  { residentName: 'R1', userId: 'u1', availableShiftIds: ['T1'] },
  { residentName: 'R2', userId: 'u2', availableShiftIds: ['T1'] },
]
let poolPruneOk = true
for (let i = 0; i < 10; i++) {
  const r = generateSchedule(pref4Shifts, pref4Subs)
  const assigned = r.filter(a => a.residentName !== null)
  if (assigned.length !== 1 || r.find(a => a.shiftId === 'T2')?.residentName !== null) {
    poolPruneOk = false; break
  }
}
assert(poolPruneOk, 'pool pruning: T2 always unassigned (nobody submitted availability for it)')

section('1.19 computeCoverageSegments — shift has no times, has resident → single timeless segment')
const sNoTime = computeCoverageSegments({ startTime: undefined, endTime: undefined }, 'Alice', [], 'uA')
assert(sNoTime.length === 1, 'returns 1 segment even without shift times')
assert(sNoTime[0].start === '' && sNoTime[0].end === '', 'segment bounds are empty strings')
assert(sNoTime[0].userId === 'uA', 'userId preserved in timeless segment')

section('1.20 validateSplit — zero-length window (start === end) rejected')
assert(validateSplit({ offeredStart: '12:00', offeredEnd: '12:00', ownedStart: '08:00', ownedEnd: '21:00' }) !== null, 'start === end rejected')

section('1.21 generateSchedule — weekend ranking used on weekend dates')
// 2026-07-19 is a Sunday
const wkShifts = [
  { id: 'W1', date: '2026-07-19', clinic: 'A' },
  { id: 'W2', date: '2026-07-19', clinic: 'B' },
]
const wkSub = [{ residentName: 'Alice', userId: 'uA', availableShiftIds: ['W1', 'W2'] }]
const wkPrefs = { uA: { weekdayRanking: ['B', 'A'], weekendRanking: ['A', 'B'] } }
const wkResult = generateSchedule(wkShifts, wkSub, wkPrefs)
assert(wkResult.find(a => a.shiftId === 'W1')?.userId === 'uA', 'weekend ranking: Alice assigned to top-ranked weekend clinic A')
assert(wkResult.find(a => a.shiftId === 'W2')?.residentName === null, 'clinic B unassigned (only one resident placed at weekend top-rank)')

section('1.22 generateSchedule — name-keyed submission (no userId) still assigns correctly')
const nkResult = generateSchedule(
  [{ id: 'NK1', date: '2026-08-01', clinic: 'A' }],
  [{ residentName: 'Legacy', userId: null, availableShiftIds: ['NK1'] }]
)
assert(nkResult[0]?.residentName === 'Legacy', 'name-keyed submission (no userId) assigns correctly')
assert(nkResult[0]?.userId === null, 'assignment carries null userId for name-keyed submission')

// ── Inline helpers mirroring lib/invoices.ts ──────────────────────────────────
function formatInvoiceNumber(initials, entity, n) {
  return `${initials}_${entity}${String(n).padStart(3, '0')}`
}
function deriveInitials(fullName) {
  const parts = fullName.trim().split(/\s+/)
  if (parts.length === 0) return ''
  const first = parts[0][0] ?? ''
  const last = parts[parts.length - 1][0] ?? ''
  return (parts.length > 1 ? first + last : first).toUpperCase()
}
function clinicEntities(clinic) {
  if (clinic === 'BC Cancer Agency CT')      return ['MRCT']
  if (clinic === 'BC Cancer Agency MRI/PET') return ['MRCT', 'PET']
  if (clinic === 'UBC Hospital')             return ['UBC']
  if (clinic === "BC Women's Hospital")      return ['BCWH']
  return []
}

section('1.23 formatInvoiceNumber — format pattern')
assert(formatInvoiceNumber('AB', 'UBC', 1)    === 'AB_UBC001',  'simple clinic invoice number (UBC)')
assert(formatInvoiceNumber('AB', 'BCWH', 5)   === 'AB_BCWH005', 'simple clinic invoice number (BCWH)')
assert(formatInvoiceNumber('AB', 'MRCT', 12)  === 'AB_MRCT012', 'complex entity invoice number (MRCT)')
assert(formatInvoiceNumber('AB', 'PET', 100)  === 'AB_PET100',  '3-digit sequence not zero-padded beyond 3')
assert(formatInvoiceNumber('PB', 'INITIO', 3) === 'PB_INITIO003', 'INITIO invoice number')

section('1.24 deriveInitials — standard and edge cases')
assert(deriveInitials('Pierre Boerkoel') === 'PB', 'two-part name → first initials of first + last')
assert(deriveInitials('Alice')           === 'A',  'single name → first letter only')
assert(deriveInitials('Mary Jane Watson') === 'MW', 'three-part name → first + last initial')
assert(deriveInitials('  Bob  Smith  ')  === 'BS', 'trims and collapses internal spaces')

section('1.25 clinicEntities — entity codes reflect rename')
assert(JSON.stringify(clinicEntities('UBC Hospital'))          === JSON.stringify(['UBC']),         "UBC Hospital → ['UBC'] (not UBCMR)")
assert(JSON.stringify(clinicEntities("BC Women's Hospital"))   === JSON.stringify(['BCWH']),        "BC Women's Hospital → ['BCWH'] (not BCWHMR)")
assert(JSON.stringify(clinicEntities('BC Cancer Agency CT'))   === JSON.stringify(['MRCT']),        'BC Cancer Agency CT → MRCT unchanged')
assert(JSON.stringify(clinicEntities('BC Cancer Agency MRI/PET')) === JSON.stringify(['MRCT','PET']), 'BC Cancer Agency MRI/PET → [MRCT, PET] unchanged')
assert(JSON.stringify(clinicEntities('Unknown Clinic'))        === JSON.stringify([]),              'unknown clinic → empty array')

// ════════════════════════════════════════════════════════════════════════════
// SECTION 2 — DB layer
// ════════════════════════════════════════════════════════════════════════════
const TEST_PERIOD_NAME = '__TEST_SUITE__'
let testPeriodId = null

// Cleanup any stale test data from a previous failed run
const stale = await db`SELECT id FROM scheduling_periods WHERE name = ${TEST_PERIOD_NAME}`
for (const p of stale) {
  await db`DELETE FROM availability_submissions WHERE period_id = ${p.id}`
  await db`DELETE FROM scheduling_periods WHERE id = ${p.id}`
  // FK CASCADE handles: shifts → shift_splits, swap_requests, shift_assignments
}
await db`DELETE FROM invoice_sequences WHERE user_id = '__test_user__'`

section('2.1  Schema — required tables exist')
const TABLES = [
  'shifts', 'scheduling_periods', 'shift_assignments', 'availability_submissions',
  'swap_requests', 'shift_splits', 'invoice_sequences',
  'billing_rates', 'billing_contacts', 'resident_preferences',
  'clinics', 'billing_entities', 'clinic_billing_entities',
]
for (const t of TABLES) {
  const [{ count }] = await db`SELECT COUNT(*) FROM information_schema.tables WHERE table_name = ${t} AND table_schema = 'public'`
  assert(count === '1', `table "${t}" exists`)
}

section('2.2  Schema — key columns and UUID types')
const splitCols = (await db`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'shift_splits' AND table_schema = 'public'`).reduce((m, r) => { m[r.column_name] = r.data_type; return m }, {})
for (const col of ['id','shift_id','offeror_user_id','offered_start','offered_end','status','acceptor_user_id']) {
  assert(col in splitCols, `shift_splits.${col} exists`)
}
assert(splitCols['shift_id'] === 'uuid', 'shift_splits.shift_id is UUID type')
assert(splitCols['period_id'] === 'uuid', 'shift_splits.period_id is UUID type')

const subCols = (await db`SELECT column_name FROM information_schema.columns WHERE table_name = 'availability_submissions' AND table_schema = 'public'`).map(r => r.column_name)
for (const col of ['user_id','period_id','max_shifts']) {
  assert(subCols.includes(col), `availability_submissions.${col} exists`)
}

const shiftCols = (await db`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'shifts' AND table_schema = 'public'`).reduce((m, r) => { m[r.column_name] = r.data_type; return m }, {})
assert(shiftCols['id'] === 'uuid', 'shifts.id is UUID type')
assert(shiftCols['period_id'] === 'uuid', 'shifts.period_id is UUID type')
assert(shiftCols['clinic_id'] === 'uuid', 'shifts.clinic_id is UUID type')
assert(!('clinic' in shiftCols), 'shifts.clinic TEXT column removed')

const clinicCols = (await db`SELECT column_name FROM information_schema.columns WHERE table_name = 'clinics' AND table_schema = 'public'`).map(r => r.column_name)
for (const col of ['id', 'name', 'abbreviation', 'active_days', 'billing_mode', 'sort_order']) {
  assert(clinicCols.includes(col), `clinics.${col} exists`)
}

const billingEntityCols = (await db`SELECT column_name FROM information_schema.columns WHERE table_name = 'billing_entities' AND table_schema = 'public'`).map(r => r.column_name)
assert(billingEntityCols.includes('code'), 'billing_entities.code exists')

const billingRateCols = (await db`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'billing_rates' AND table_schema = 'public'`).reduce((m, r) => { m[r.column_name] = r.data_type; return m }, {})
assert(billingRateCols['entity_id'] === 'uuid', 'billing_rates.entity_id is UUID')
assert(billingRateCols['rate_key'] !== undefined, 'billing_rates.rate_key exists')
assert(!('key' in billingRateCols), 'billing_rates old key column removed')

const billingContactCols = (await db`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'billing_contacts' AND table_schema = 'public'`).reduce((m, r) => { m[r.column_name] = r.data_type; return m }, {})
assert(billingContactCols['entity_id'] === 'uuid', 'billing_contacts.entity_id is UUID')
assert(!('entity' in billingContactCols), 'billing_contacts old entity TEXT column removed')

const swapCols = (await db`SELECT column_name, data_type FROM information_schema.columns WHERE table_name = 'swap_requests' AND table_schema = 'public'`).reduce((m, r) => { m[r.column_name] = r.data_type; return m }, {})
assert(swapCols['requestor_shift_id'] === 'uuid', 'swap_requests.requestor_shift_id is UUID type')
assert(swapCols['period_id'] === 'uuid', 'swap_requests.period_id is UUID type')

const seqCols = (await db`SELECT column_name FROM information_schema.columns WHERE table_name = 'invoice_sequences' AND table_schema = 'public'`).map(r => r.column_name)
assert(seqCols.includes('user_id'), 'invoice_sequences.user_id exists')

section('2.3  Scheduling period CRUD')
const [{ id: pid }] = await db`
  INSERT INTO scheduling_periods (name, start_date, end_date)
  VALUES (${TEST_PERIOD_NAME}, '2099-12-01', '2099-12-05')
  RETURNING id
`
testPeriodId = pid
const [period] = await db`SELECT * FROM scheduling_periods WHERE id = ${pid}`
assert(period.name === TEST_PERIOD_NAME, 'period created with correct name')

section('2.4  Shifts CRUD — DB generates UUID ids')
// Insert shifts without specifying id; DB uses gen_random_uuid()
const TEST_SHIFTS = []
const shiftData = [
  { date: '2099-12-01', clinic: 'BC Cancer Agency MRI/PET', startTime: '08:00', endTime: '17:00' },
  { date: '2099-12-01', clinic: 'BC Cancer Agency CT',      startTime: '08:00', endTime: '17:00' },
  { date: '2099-12-02', clinic: 'BC Cancer Agency MRI/PET', startTime: '08:00', endTime: '17:00' },
  { date: '2099-12-03', clinic: 'BC Cancer Agency MRI/PET', startTime: '08:00', endTime: '17:00' },
  { date: '2099-12-04', clinic: 'BC Cancer Agency MRI/PET', startTime: '08:00', endTime: '17:00' },
]
for (const s of shiftData) {
  const [row] = await db`
    INSERT INTO shifts (date, clinic_id, period_id, start_time, end_time)
    VALUES (${s.date}, (SELECT id FROM clinics WHERE name = ${s.clinic}), ${pid}, ${s.startTime}, ${s.endTime})
    RETURNING id
  `
  TEST_SHIFTS.push({ ...s, id: row.id })
}
const [{ count: shiftCount }] = await db`SELECT COUNT(*) FROM shifts WHERE period_id = ${pid}`
assert(shiftCount === '5', '5 shifts inserted')
assert(TEST_SHIFTS.every(s => /^[0-9a-f-]{36}$/.test(s.id)), 'all shift ids are valid UUIDs')

section('2.5  Availability submission — upsert idempotency')
const subId1 = crypto.randomUUID()
const subUserId = 'test_user_db_' + Date.now()
await db`
  INSERT INTO availability_submissions (id, user_id, resident_name, submitted_at, available_shift_ids, period_id)
  VALUES (${subId1}, ${subUserId}, 'Test User', NOW(), ${[TEST_SHIFTS[0].id]}, ${pid})
`
const subId2 = crypto.randomUUID()
await db`
  INSERT INTO availability_submissions (id, user_id, resident_name, submitted_at, available_shift_ids, period_id)
  VALUES (${subId2}, ${subUserId}, 'Test User', NOW(), ${[TEST_SHIFTS[2].id]}, ${pid})
  ON CONFLICT (user_id, period_id) WHERE user_id IS NOT NULL AND period_id IS NOT NULL
  DO UPDATE SET
    id                  = EXCLUDED.id,
    available_shift_ids = EXCLUDED.available_shift_ids
`
const [updated] = await db`SELECT available_shift_ids FROM availability_submissions WHERE user_id = ${subUserId} AND period_id = ${pid}`
assert(JSON.stringify(updated.available_shift_ids) === JSON.stringify([TEST_SHIFTS[2].id]), 'upsert overwrites prior submission')
const [{ count: subCount }] = await db`SELECT COUNT(*) FROM availability_submissions WHERE user_id = ${subUserId} AND period_id = ${pid}`
assert(subCount === '1', 'exactly one row per user per period')

section('2.6  Shift splits — pending, accept, unique index, cancel-then-repend')
const splitId = crypto.randomUUID()
await db`
  INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status)
  VALUES (${splitId}, ${TEST_SHIFTS[0].id}, 'Test User', ${subUserId}, '12:00', '17:00', 'pending')
`
const [split] = await db`SELECT * FROM shift_splits WHERE id = ${splitId}`
assert(split.status === 'pending' && split.offered_start === '12:00', 'split inserted as pending')

await db`UPDATE shift_splits SET status = 'accepted', acceptor_name = 'Other User', acceptor_user_id = 'other_user', accepted_at = NOW() WHERE id = ${splitId}`
const [accepted] = await db`SELECT status, acceptor_name FROM shift_splits WHERE id = ${splitId}`
assert(accepted.status === 'accepted' && accepted.acceptor_name === 'Other User', 'split accepted correctly')

// Unique pending index: second pending from same user on same shift is blocked
const sp2Id = crypto.randomUUID()
await db`
  INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status)
  VALUES (${sp2Id}, ${TEST_SHIFTS[0].id}, 'Test User', ${subUserId}, '08:00', '12:00', 'pending')
`
try {
  await db`
    INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status)
    VALUES (${crypto.randomUUID()}, ${TEST_SHIFTS[0].id}, 'Test User', ${subUserId}, '10:00', '12:00', 'pending')
  `
  fail('unique pending index', 'should have rejected duplicate pending')
} catch (e) {
  assert(e.code === '23505', 'unique pending index blocks second offer from same user on same shift')
}
await db`UPDATE shift_splits SET status = 'cancelled' WHERE id = ${sp2Id}`
try {
  await db`
    INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status)
    VALUES (${crypto.randomUUID()}, ${TEST_SHIFTS[0].id}, 'Test User', ${subUserId}, '10:00', '12:00', 'pending')
  `
  ok('new pending offer allowed after prior is cancelled')
} catch {
  fail('new pending after cancel', 'should have been allowed')
}

section('2.7  Invoice sequences — user_id keyed')
await db`
  INSERT INTO invoice_sequences (user_id, series, next_number)
  VALUES ('__test_user__', 'MRCT', 1)
  ON CONFLICT (user_id, series) DO NOTHING
`
await db`UPDATE invoice_sequences SET next_number = next_number + 1 WHERE user_id = '__test_user__' AND series = 'MRCT'`
const [seq] = await db`SELECT next_number FROM invoice_sequences WHERE user_id = '__test_user__' AND series = 'MRCT'`
assert(seq.next_number === 2, 'invoice sequence incremented correctly')
const [{ count: seqCount }] = await db`SELECT COUNT(*) FROM invoice_sequences WHERE user_id = '__test_user__' AND series = 'MRCT'`
assert(seqCount === '1', 'single sequence row per user+series')

section('2.8  shift_splits — direct accepted insertion (admin-split pattern)')
const adminSplitId2 = crypto.randomUUID()
await db`
  INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status, acceptor_name, acceptor_user_id, accepted_at)
  VALUES (${adminSplitId2}, ${TEST_SHIFTS[0].id}, 'Admin Offeror', 'admin_u_test', '08:00', '12:00', 'accepted', 'Admin Acceptor', 'acceptor_u_test', NOW())
`
const [adminSplitRow] = await db`SELECT status, acceptor_name FROM shift_splits WHERE id = ${adminSplitId2}`
assert(adminSplitRow.status === 'accepted', 'admin-created split inserted directly as accepted')
assert(adminSplitRow.acceptor_name === 'Admin Acceptor', 'acceptor name stored correctly in direct-accepted split')

section('2.9  FK ON DELETE CASCADE — deleting a shift auto-removes its splits')
const cascadeSplit2Id = crypto.randomUUID()
await db`
  INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status)
  VALUES (${cascadeSplit2Id}, ${TEST_SHIFTS[2].id}, 'Test', 'uT', '08:00', '17:00', 'pending')
`
const [{ count: cascBefore }] = await db`SELECT COUNT(*) FROM shift_splits WHERE id = ${cascadeSplit2Id}`
assert(cascBefore === '1', 'split exists before cascade delete')
// Deleting the shift (no manual split delete needed — ON DELETE CASCADE handles it)
await db`DELETE FROM shifts WHERE id = ${TEST_SHIFTS[2].id}`
const [{ count: cascSplitAfter }] = await db`SELECT COUNT(*) FROM shift_splits WHERE id = ${cascadeSplit2Id}`
assert(cascSplitAfter === '0', 'split auto-removed by FK ON DELETE CASCADE when shift deleted')
const [{ count: cascShiftAfter }] = await db`SELECT COUNT(*) FROM shifts WHERE id = ${TEST_SHIFTS[2].id}`
assert(cascShiftAfter === '0', 'shift itself removed')

section('2.10 Billing entities — renamed codes present, old codes absent')
const entityRows = await db`SELECT code FROM billing_entities`
const entityCodes = new Set(entityRows.map(r => r.code))
assert(entityCodes.has('UBC'),    "billing_entities has 'UBC'")
assert(entityCodes.has('BCWH'),   "billing_entities has 'BCWH'")
assert(entityCodes.has('INITIO'), "billing_entities has 'INITIO'")
assert(entityCodes.has('MRCT'),   "billing_entities has 'MRCT'")
assert(entityCodes.has('PET'),    "billing_entities has 'PET'")
assert(!entityCodes.has('UBCMR'),  "billing_entities does NOT have legacy 'UBCMR'")
assert(!entityCodes.has('BCWHMR'), "billing_entities does NOT have legacy 'BCWHMR'")

section('2.11 Billing rates — simple clinic rate rows present for renamed entities')
const rateRows = await db`
  SELECT be.code, br.rate_key, br.rate
  FROM billing_rates br
  JOIN billing_entities be ON be.id = br.entity_id
  WHERE be.code IN ('UBC', 'BCWH', 'INITIO')
`
const rateMap = Object.fromEntries(rateRows.map(r => [`${r.code}_${r.rate_key}`, r.rate]))
assert('UBC_rate'    in rateMap, "billing_rates has UBC rate_key='rate'")
assert('BCWH_rate'   in rateMap, "billing_rates has BCWH rate_key='rate'")
assert('INITIO_rate' in rateMap, "billing_rates has INITIO rate_key='rate'")
const legacyRates = await db`
  SELECT be.code FROM billing_rates br
  JOIN billing_entities be ON be.id = br.entity_id
  WHERE be.code IN ('UBCMR', 'BCWHMR')
`
assert(legacyRates.length === 0, 'no billing_rates rows reference legacy UBCMR/BCWHMR codes')

section('2.12 Clinic-entity mappings — renamed and new entities linked correctly')
const mappings = await db`
  SELECT c.name AS clinic, be.code AS entity
  FROM clinic_billing_entities cbe
  JOIN clinics c ON c.id = cbe.clinic_id
  JOIN billing_entities be ON be.id = cbe.entity_id
  WHERE c.name IN ('UBC Hospital', 'BC Women''s Hospital', 'INITIO Medical Imaging')
`
const mapByClinic = {}
for (const row of mappings) {
  mapByClinic[row.clinic] = mapByClinic[row.clinic] ?? []
  mapByClinic[row.clinic].push(row.entity)
}
assert(mapByClinic['UBC Hospital']?.includes('UBC'),         "UBC Hospital linked to 'UBC' entity")
assert(!mapByClinic['UBC Hospital']?.includes('UBCMR'),      "UBC Hospital NOT linked to legacy 'UBCMR'")
assert(mapByClinic["BC Women's Hospital"]?.includes('BCWH'), "BC Women's Hospital linked to 'BCWH' entity")
assert(!mapByClinic["BC Women's Hospital"]?.includes('BCWHMR'), "BC Women's Hospital NOT linked to legacy 'BCWHMR'")
assert(mapByClinic['INITIO Medical Imaging']?.includes('INITIO'), "INITIO Medical Imaging linked to 'INITIO' entity")

// ════════════════════════════════════════════════════════════════════════════
// SECTION 3 — HTTP API (end-to-end against live deployment)
// ════════════════════════════════════════════════════════════════════════════

// Clean up DB-layer test data so section 3 starts fresh
{
  const staleRows = await db`SELECT id FROM scheduling_periods WHERE name = ${TEST_PERIOD_NAME}`
  for (const p of staleRows) {
    await db`DELETE FROM availability_submissions WHERE period_id = ${p.id}`
    await db`DELETE FROM scheduling_periods WHERE id = ${p.id}`
    // FK CASCADE: shifts → shift_splits, swap_requests, shift_assignments
  }
  await db`DELETE FROM invoice_sequences WHERE user_id = '__test_user__'`
}

const clerkReq = async (method, path, body) => {
  const r = await fetch(`https://api.clerk.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${CLERK_SECRET_KEY}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return r.json()
}

const tokenCache = {}
const getToken = async (userId) => {
  if (!tokenCache[userId]) {
    const session = await clerkReq('POST', '/sessions', { user_id: userId })
    if (!session.id) throw new Error(`Cannot create Clerk session for ${userId}`)
    const tok = await clerkReq('POST', `/sessions/${session.id}/tokens`, {})
    tokenCache[userId] = tok.jwt ?? null
  }
  return tokenCache[userId]
}

const api = async (userId, method, path, body) => {
  const token = userId ? await getToken(userId) : null
  const headers = { 'Content-Type': 'application/json' }
  if (token) headers['Authorization'] = `Bearer ${token}`
  const opts = { method, headers }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const r = await fetch(`${BASE_URL}${path}`, opts)
  const text = await r.text()
  let json; try { json = JSON.parse(text) } catch { json = text }
  return { status: r.status, body: json }
}

// ── Find admin ────────────────────────────────────────────────────────────────
section('3.0  HTTP setup — find admin, create test residents')
const userList = await clerkReq('GET', '/users?limit=200')
const adminUser = (userList.data ?? userList).find(u => u.public_metadata?.role === 'admin')
if (!adminUser) { fail('admin user', 'no admin found in Clerk — set role=admin on at least one user'); await cleanup(); process.exit(1) }
const ADMIN = adminUser.id
ok(`admin found: ${adminUser.first_name} ${adminUser.last_name}`)

// ── Create 3 test residents ───────────────────────────────────────────────────
const TEST_USERS = []
for (let i = 1; i <= 3; i++) {
  const u = await clerkReq('POST', '/users', {
    first_name: 'TestRes',
    last_name: String(i),
    email_address: [`testres${i}.${Date.now()}@example.com`],
    password: 'TestPassword123!',
    skip_password_checks: true,
    skip_password_requirement: true,
  })
  if (!u.id) { fail(`create test resident ${i}`, JSON.stringify(u.errors?.[0])); continue }
  TEST_USERS.push({ id: u.id, name: `TestRes ${i}` })
}
assert(TEST_USERS.length === 3, `3 test residents created (got ${TEST_USERS.length})`)
const [R1, R2, R3] = TEST_USERS

// ── Create test period via API, then shifts ───────────────────────────────────
const { status: pStatus, body: pBody } = await api(ADMIN, 'POST', '/api/periods', {
  name: TEST_PERIOD_NAME, startDate: '2099-12-01', endDate: '2099-12-05'
})
assert(pStatus === 201, 'admin creates test period', `status=${pStatus} body=${JSON.stringify(pBody)}`)

const activeClinics = {
  '2099-12-01': ['BC Cancer Agency MRI/PET', 'BC Cancer Agency CT'],
  '2099-12-02': ['BC Cancer Agency MRI/PET'],
  '2099-12-03': ['BC Cancer Agency MRI/PET'],
  '2099-12-04': ['BC Cancer Agency MRI/PET'],
}
const shiftTimes = Object.fromEntries(
  Object.keys(activeClinics).map(d => [d, Object.fromEntries(
    activeClinics[d].map(c => [c, { startTime: '08:00', endTime: '17:00' }])
  )])
)
const { status: shiftSaveStatus } = await api(ADMIN, 'POST', '/api/shifts', {
  blockName: TEST_PERIOD_NAME, startDate: '2099-12-01', endDate: '2099-12-04', activeClinics, shiftTimes
})
assert(shiftSaveStatus === 200, 'admin creates test shifts', `status=${shiftSaveStatus}`)

// Resolve period ID and shift UUIDs from API
const { body: periodsResp } = await api(R1.id, 'GET', '/api/periods')
const testPeriod = Array.isArray(periodsResp) ? periodsResp.find(p => p.name === TEST_PERIOD_NAME) : null
assert(!!testPeriod, 'test period visible in GET /api/periods')
const HTTP_PERIOD_ID = testPeriod?.id

const { body: allShiftsResp } = await api(ADMIN, 'GET', '/api/shifts')
const allShifts = Array.isArray(allShiftsResp) ? allShiftsResp : []
const testShifts = allShifts.filter(s => s.periodId === HTTP_PERIOD_ID)
const shiftByKey = Object.fromEntries(testShifts.map(s => [`${s.date}|${s.clinic}`, s]))
const shiftById  = Object.fromEntries(allShifts.map(s => [s.id, s]))

// S maps semantic names → UUID shift IDs
const S = {
  r1Mri01: shiftByKey['2099-12-01|BC Cancer Agency MRI/PET']?.id,
  ct01:    shiftByKey['2099-12-01|BC Cancer Agency CT']?.id,
  r2Mri02: shiftByKey['2099-12-02|BC Cancer Agency MRI/PET']?.id,
  r3Mri03: shiftByKey['2099-12-03|BC Cancer Agency MRI/PET']?.id,
  mri04:   shiftByKey['2099-12-04|BC Cancer Agency MRI/PET']?.id,
}
assert(Object.values(S).every(id => typeof id === 'string'), 'all test shift UUIDs resolved from API')

// ── 3.1  Unauthenticated → blocked ───────────────────────────────────────────
section('3.1  Auth: unauthenticated requests → blocked')
for (const [method, path] of [['GET','/api/shifts'],['GET','/api/schedule'],['GET','/api/availability'],['POST','/api/availability']]) {
  const { status, body } = await api(null, method, path, method === 'POST' ? {} : undefined)
  const blocked = status === 401 || status === 403 || status === 404 || typeof body === 'string'
  assert(blocked, `${method} ${path} → blocked without auth (status=${status})`)
}

// ── 3.2  Admin-only routes → 403 for residents ────────────────────────────────
section('3.2  Auth: admin-only routes → 403 for non-admin')
const adminOnlyChecks = [
  ['POST', '/api/shifts',                    { blockName: 'x', startDate: '2099-01-01', endDate: '2099-01-01', activeClinics: {} }],
  ['POST', '/api/schedule',                  { action: 'generate' }],
  ['POST', '/api/schedule',                  { action: 'publish' }],
  ['GET',  '/api/admin/users',               undefined],
  ['PUT',  '/api/admin/billing-rates',       { key: 'MRCT_base', value: 50 }],
  ['PUT',  '/api/admin/billing-contacts',    { entity: 'MRCT', contactName: 'x', org: 'x', address: 'x', email: null }],
]
for (const [method, path, body] of adminOnlyChecks) {
  const { status } = await api(R1.id, method, path, body)
  assert(status === 403, `${method} ${path} → 403 for non-admin`)
}

// ── 3.3  Availability submission ─────────────────────────────────────────────
section('3.3  Availability submission')
// Each resident is available for exactly one shift — guarantees deterministic schedule generation
const { status: a1 } = await api(R1.id, 'POST', '/api/availability', { availableShiftIds: [S.r1Mri01], periodId: HTTP_PERIOD_ID })
assert(a1 === 200, 'R1 submits availability')
const { status: a2 } = await api(R2.id, 'POST', '/api/availability', { availableShiftIds: [S.r2Mri02], periodId: HTTP_PERIOD_ID })
assert(a2 === 200, 'R2 submits availability')
const { status: a3 } = await api(R3.id, 'POST', '/api/availability', { availableShiftIds: [S.r3Mri03], periodId: HTTP_PERIOD_ID })
assert(a3 === 200, 'R3 submits availability')
const { status: a1b } = await api(R1.id, 'POST', '/api/availability', { availableShiftIds: [S.r1Mri01], periodId: HTTP_PERIOD_ID })
assert(a1b === 200, 'R1 can resubmit before publish (idempotent update)')

// ── 3.4  Schedule generation ─────────────────────────────────────────────────
section('3.4  Schedule generation')
const { status: genStatus, body: genBody } = await api(ADMIN, 'POST', '/api/schedule', { action: 'generate', periodId: HTTP_PERIOD_ID })
assert(genStatus === 200, 'admin generates schedule', `status=${genStatus}`)
const draftAssignments = genBody.assignments ?? []
const assignedFor = (shiftId) => draftAssignments.find(a => a.shiftId === shiftId)
assert(assignedFor(S.r1Mri01)?.userId === R1.id, 'R1 assigned to 12-01 MRI/PET (only eligible)')
assert(assignedFor(S.r2Mri02)?.userId === R2.id, 'R2 assigned to 12-02 MRI/PET (only eligible)')
assert(assignedFor(S.r3Mri03)?.userId === R3.id, 'R3 assigned to 12-03 MRI/PET (only eligible)')
assert(assignedFor(S.ct01)?.residentName === null,  '12-01 CT unassigned (no submissions)')
assert(assignedFor(S.mri04)?.residentName === null, '12-04 unassigned (no submissions)')

// No double-bookings
const dayMap = {}; let dbCount = 0
for (const a of draftAssignments) {
  if (!a.userId) continue
  const shiftDate = shiftById[a.shiftId]?.date
  if (!shiftDate) continue
  const key = `${a.userId}|${shiftDate}`
  if (dayMap[key]) dbCount++
  dayMap[key] = true
}
assert(dbCount === 0, 'no double-bookings in generated schedule')

// ── 3.5  Publish ─────────────────────────────────────────────────────────────
section('3.5  Publish schedule')
const { status: pubStatus, body: pubBody } = await api(ADMIN, 'POST', '/api/schedule', { action: 'publish', periodId: HTTP_PERIOD_ID })
assert(pubStatus === 200 && pubBody.publishedAt, 'schedule published')
const pub = pubBody.publishedAssignments ?? []
assert(pub.some(a => a.shiftId === S.r1Mri01 && a.userId === R1.id), 'R1 in published schedule')

// ── 3.6  Availability locked after publish ────────────────────────────────────
section('3.6  Availability lock')
const { status: lockStatus } = await api(R1.id, 'POST', '/api/availability', { availableShiftIds: [S.r1Mri01], periodId: HTTP_PERIOD_ID })
assert(lockStatus === 409, 'resubmission blocked after publish (409)')

// ── 3.7  Resident can view published schedule ─────────────────────────────────
section('3.7  Resident views published schedule')
const { status: viewStatus, body: viewBody } = await api(R1.id, 'GET', '/api/schedule')
assert(viewStatus === 200 && Array.isArray(viewBody), 'resident can GET schedule')
const viewPeriod = Array.isArray(viewBody) ? viewBody.find(p => p.id === HTTP_PERIOD_ID) : null
assert(viewPeriod?.publishedAssignments?.some(a => a.shiftId === S.r1Mri01), 'published assignments include test shift')

// ── 3.8  Claim unassigned shift ───────────────────────────────────────────────
section('3.8  Claim unassigned shift')
const { status: claimStatus } = await api(R3.id, 'PUT', '/api/schedule', { shiftId: S.mri04 })
assert(claimStatus === 200, 'R3 claims unassigned 12-04 shift')
const { body: afterClaimBody } = await api(ADMIN, 'GET', '/api/schedule')
const afterClaimPub = Array.isArray(afterClaimBody) ? afterClaimBody.flatMap(p => p.publishedAssignments ?? []) : []
assert(afterClaimPub.find(a => a.shiftId === S.mri04)?.userId === R3.id, 'R3 appears in publishedAssignments for 12-04')

// ── 3.9  Same-day double-claim blocked ───────────────────────────────────────
section('3.9  Same-day double-claim blocked')
// R1 is on 12-01 MRI/PET; CT on that same day is unassigned
const { status: doubleStatus } = await api(R1.id, 'PUT', '/api/schedule', { shiftId: S.ct01 })
assert(doubleStatus === 409, 'R1 cannot claim a second shift on the same day (409)')

// ── 3.10 Swap offer — post, accept, verify ────────────────────────────────────
section('3.10 Swap: R2 offers shift, R3 accepts')
const { status: swapPostStatus, body: swapBody } = await api(R2.id, 'POST', '/api/swaps', { requestorShiftId: S.r2Mri02 })
assert(swapPostStatus === 201 && swapBody.id, 'R2 posts swap offer', `status=${swapPostStatus}`)
const swapId = swapBody.id

const { status: swapAccStatus, body: swapAccBody } = await api(R3.id, 'PATCH', `/api/swaps/${swapId}`, { action: 'accept' })
assert(swapAccStatus === 200 && swapAccBody.status === 'accepted', 'R3 accepts swap', `status=${swapAccStatus}`)

const { body: afterSwapBody } = await api(ADMIN, 'GET', '/api/schedule')
const afterSwapPub = Array.isArray(afterSwapBody) ? afterSwapBody.flatMap(p => p.publishedAssignments ?? []) : []
assert(afterSwapPub.find(a => a.shiftId === S.r2Mri02)?.userId === R3.id, 'R3 now assigned to 12-02 after swap')
assert(!afterSwapPub.find(a => a.shiftId === S.r2Mri02 && a.userId === R2.id), 'R2 no longer on 12-02 after swap')

// ── 3.11 Swap already accepted — second accept blocked ────────────────────────
section('3.11 Swap: double-accept of same offer blocked')
const { status: reAccStatus } = await api(R1.id, 'PATCH', `/api/swaps/${swapId}`, { action: 'accept' })
assert(reAccStatus === 409, 'second accept of same swap blocked (409)')

// ── 3.12 Swap: cancel and re-offer works ─────────────────────────────────────
section('3.12 Swap: cancel own offer')
const { status: r1OfferStatus, body: r1OfferBody } = await api(R1.id, 'POST', '/api/swaps', { requestorShiftId: S.r1Mri01 })
assert(r1OfferStatus === 201, 'R1 posts swap offer for 12-01', `status=${r1OfferStatus}`)
const { status: cancelStatus } = await api(R1.id, 'PATCH', `/api/swaps/${r1OfferBody.id}`, { action: 'cancel' })
assert(cancelStatus === 200, 'R1 cancels their own swap offer')
// R1 can re-offer after cancelling
const { status: reOfferStatus } = await api(R1.id, 'POST', '/api/swaps', { requestorShiftId: S.r1Mri01 })
assert(reOfferStatus === 201, 'R1 can re-offer after cancelling')
// Cancel again to leave state clean
await api(R1.id, 'PATCH', `/api/swaps/${(await api(R1.id, 'GET', '/api/swaps')).body.find(r => r.requestorShiftId === S.r1Mri01 && r.status === 'pending')?.id}`, { action: 'cancel' })

// ── 3.13 Shift split — offer a portion, accept it ────────────────────────────
section('3.13 Shift split — partial offer and acceptance')
const { status: splitStatus, body: splitBody } = await api(R1.id, 'POST', '/api/splits', {
  shiftId: S.r1Mri01, offeredStart: '12:00', offeredEnd: '17:00',
})
assert(splitStatus === 201 && splitBody.id, 'R1 creates partial split offer', `status=${splitStatus}`)
const splitOfferId = splitBody.id

const { status: selfAccStatus } = await api(R1.id, 'PATCH', `/api/splits/${splitOfferId}`, { action: 'accept' })
assert(selfAccStatus === 400, 'offeror cannot accept their own split (400)')

const { status: dupStatus } = await api(R1.id, 'POST', '/api/splits', { shiftId: S.r1Mri01, offeredStart: '08:00', offeredEnd: '12:00' })
assert(dupStatus === 409, 'duplicate pending split offer rejected (409)')

const { status: splitAccStatus } = await api(R2.id, 'PATCH', `/api/splits/${splitOfferId}`, { action: 'accept' })
assert(splitAccStatus === 200, 'R2 accepts the split offer', `status=${splitAccStatus}`)

const { body: splitList } = await api(R1.id, 'GET', '/api/splits')
const activeSplits = (Array.isArray(splitList) ? splitList : []).filter(s => s.shiftId === S.r1Mri01 && s.status === 'accepted')
const segs = computeCoverageSegments({ startTime: '08:00', endTime: '17:00' }, R1.name, activeSplits.map(s => ({
  offerorUserId: s.offerorUserId, acceptorName: s.acceptorName, acceptorUserId: s.acceptorUserId,
  offeredStart: s.offeredStart, offeredEnd: s.offeredEnd, status: s.status,
})), R1.id)
assert(segs.length === 2, `coverage has 2 segments after split (got ${segs.length})`)
assert(segs[0]?.userId === R1.id && segs[0]?.end === '12:00', 'R1 covers 08:00–12:00')
assert(segs[1]?.userId === R2.id && segs[1]?.start === '12:00', 'R2 covers 12:00–17:00')

// ── 3.14 Billing contacts and rates (admin read/write) ────────────────────────
section('3.14 Admin billing contacts and rates')
const { status: bcGetStatus, body: bcGet } = await api(ADMIN, 'GET', '/api/admin/billing-contacts')
assert(bcGetStatus === 200 && Array.isArray(bcGet), 'GET billing contacts returns array')

const { status: bcPutStatus } = await api(ADMIN, 'PUT', '/api/admin/billing-contacts', {
  entity: 'MRCT', contactName: 'Test Contact', org: 'Test Org', address: '123 Test St', email: 'test@test.com'
})
assert(bcPutStatus === 200, 'PUT billing contact succeeds')

const { body: bcVerify } = await api(ADMIN, 'GET', '/api/admin/billing-contacts')
const mrctContact = Array.isArray(bcVerify) ? bcVerify.find(c => c.entity === 'MRCT') : null
assert(mrctContact?.contactName === 'Test Contact', 'billing contact update persisted')

const { status: brGetStatus, body: brGet } = await api(ADMIN, 'GET', '/api/admin/billing-rates')
assert(brGetStatus === 200 && typeof brGet === 'object' && !Array.isArray(brGet), 'GET billing rates returns rates object')

const originalMrctBase = brGet?.MRCT_base ?? 50
const { status: brPutStatus } = await api(ADMIN, 'PUT', '/api/admin/billing-rates', { key: 'MRCT_base', value: 55 })
assert(brPutStatus === 200, 'PUT billing rate succeeds')
const { body: brVerify } = await api(ADMIN, 'GET', '/api/admin/billing-rates')
assert(Number(brVerify?.MRCT_base) === 55, 'billing rate update persisted')
await api(ADMIN, 'PUT', '/api/admin/billing-rates', { key: 'MRCT_base', value: originalMrctBase })

// ── 3.15 Admin user list ──────────────────────────────────────────────────────
section('3.15 Admin user list')
const { status: ulStatus, body: ulBody } = await api(ADMIN, 'GET', '/api/admin/users')
assert(ulStatus === 200 && Array.isArray(ulBody) && ulBody.length >= 3, `admin sees ${Array.isArray(ulBody) ? ulBody.length : '?'} users`)

// ── 3.16 Admin single shift CRUD + cascade delete ─────────────────────────────
section('3.16 Admin single shift CRUD + cascade delete of splits')
const SINGLE_DATE   = '2099-12-05'
const SINGLE_CLINIC = 'BC Cancer Agency MRI/PET'

const { status: sc201, body: scBody } = await api(ADMIN, 'POST', '/api/shifts/single', {
  periodId: HTTP_PERIOD_ID, date: SINGLE_DATE, clinic: SINGLE_CLINIC,
  startTime: '08:00', endTime: '17:00',
})
assert(sc201 === 201, 'admin creates single shift via /api/shifts/single', `status=${sc201} body=${JSON.stringify(scBody)}`)
const SINGLE_UUID = scBody.id
assert(typeof SINGLE_UUID === 'string' && /^[0-9a-f-]{36}$/i.test(SINGLE_UUID), 'created shift has UUID id')

const { status: scDup } = await api(ADMIN, 'POST', '/api/shifts/single', {
  periodId: HTTP_PERIOD_ID, date: SINGLE_DATE, clinic: SINGLE_CLINIC,
})
assert(scDup === 409, 'duplicate single-shift creation rejected (409)')

const { status: scPatch } = await api(ADMIN, 'PATCH', '/api/shifts/single', {
  shiftId: SINGLE_UUID, startTime: '08:00', endTime: '16:00',
})
assert(scPatch === 200, 'admin updates single shift times')
const [{ end_time: updatedEnd }] = await db`SELECT end_time FROM shifts WHERE id = ${SINGLE_UUID}::uuid`
assert(updatedEnd === '16:00', 'shift end_time updated in DB after PATCH')

// Insert a split directly to test cascade behaviour
const cascadeSplit3Id = crypto.randomUUID()
await db`
  INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status)
  VALUES (${cascadeSplit3Id}, ${SINGLE_UUID}::uuid, 'Test', 'uT', '08:00', '12:00', 'pending')
`
const { status: scDelete } = await api(ADMIN, 'DELETE', '/api/shifts/single', { shiftId: SINGLE_UUID })
assert(scDelete === 200, 'admin deletes single shift')
const [{ count: splitGone }] = await db`SELECT COUNT(*) FROM shift_splits WHERE id = ${cascadeSplit3Id}`
assert(splitGone === '0', 'split cascade-deleted when shift removed via API')
const [{ count: shiftGone }] = await db`SELECT COUNT(*) FROM shifts WHERE id = ${SINGLE_UUID}::uuid`
assert(shiftGone === '0', 'shift record removed by delete API')

// ── 3.17 POST /api/admin/splits — input validation ────────────────────────────
section('3.17 POST /api/admin/splits — input validation')
const { status: asMissing } = await api(ADMIN, 'POST', '/api/admin/splits', {
  shiftId: S.r1Mri01, offeredStart: '10:00',
  // missing offeredEnd, acceptorUserId, acceptorName
})
assert(asMissing === 400, 'missing fields → 400')

const { status: asBoundary } = await api(ADMIN, 'POST', '/api/admin/splits', {
  shiftId: S.r1Mri01, offeredStart: '10:15', offeredEnd: '14:00',
  acceptorUserId: R2.id, acceptorName: R2.name,
})
assert(asBoundary === 400, 'non-30-min boundary → 400')

const { status: asRange } = await api(ADMIN, 'POST', '/api/admin/splits', {
  shiftId: S.r1Mri01, offeredStart: '06:00', offeredEnd: '10:00',
  acceptorUserId: R2.id, acceptorName: R2.name,
})
assert(asRange === 400, 'time outside shift range → 400')

const { status: asNonAdmin } = await api(R1.id, 'POST', '/api/admin/splits', {
  shiftId: S.r1Mri01, offeredStart: '08:00', offeredEnd: '10:00',
  acceptorUserId: R2.id, acceptorName: R2.name,
})
assert(asNonAdmin === 403, 'non-admin cannot create admin split (403)')

// ── 3.18 Admin split — create, overlap rejection, delete lifecycle ─────────────
section('3.18 Admin split — create + overlap rejection + delete lifecycle')
// S.r1Mri01 already has an accepted split 12:00-17:00 from section 3.13.
// Create a non-overlapping admin split at 08:00-10:00.
const { status: asCreate, body: asBody } = await api(ADMIN, 'POST', '/api/admin/splits', {
  shiftId: S.r1Mri01, offeredStart: '08:00', offeredEnd: '10:00',
  acceptorUserId: R2.id, acceptorName: R2.name,
})
assert(asCreate === 201 && asBody.id, 'admin creates split directly as accepted', `status=${asCreate}`)
const adminSplitCreatedId = asBody.id

// Overlapping admin split rejected (09:00-14:00 overlaps both 08:00-10:00 and 12:00-17:00)
const { status: asOverlap } = await api(ADMIN, 'POST', '/api/admin/splits', {
  shiftId: S.r1Mri01, offeredStart: '09:00', offeredEnd: '14:00',
  acceptorUserId: R3.id, acceptorName: R3.name,
})
assert(asOverlap === 409, 'overlapping admin split rejected (409)')

const { status: asDelNonAdmin } = await api(R1.id, 'DELETE', '/api/admin/splits', { splitId: adminSplitCreatedId })
assert(asDelNonAdmin === 403, 'non-admin cannot delete admin split (403)')

const { status: asDelAdmin } = await api(ADMIN, 'DELETE', '/api/admin/splits', { splitId: adminSplitCreatedId })
assert(asDelAdmin === 200, 'admin deletes split successfully')
const { body: splitsAfterAdminDel } = await api(R1.id, 'GET', '/api/splits')
const adminSplitStillExists = Array.isArray(splitsAfterAdminDel)
  ? splitsAfterAdminDel.find(s => s.id === adminSplitCreatedId)
  : true
assert(!adminSplitStillExists, 'deleted split no longer in GET /api/splits')

// ── 3.19 Resident split — overlap with already-given-away portion rejected ─────
section('3.19 Resident split — overlap with already-given-away portion rejected')
// R1 gave away 12:00-17:00 in 3.13. 10:00-14:00 overlaps the given-away window.
const { status: overlapOfferStatus } = await api(R1.id, 'POST', '/api/splits', {
  shiftId: S.r1Mri01, offeredStart: '10:00', offeredEnd: '14:00',
})
assert(overlapOfferStatus === 400, 'offer overlapping already-given-away portion rejected (400)')

// ── 3.20 Resident preferences GET/PUT ────────────────────────────────────────
section('3.20 Resident preferences GET/PUT')
const { status: prefGetStatus, body: prefs1 } = await api(R1.id, 'GET', '/api/preferences')
assert(prefGetStatus === 200, 'GET /api/preferences returns 200')
assert(typeof prefs1 === 'object' && prefs1 !== null && !Array.isArray(prefs1), 'preferences response is an object')
assert(Array.isArray(prefs1.weekdayRanking), 'response includes weekdayRanking array')
assert(Array.isArray(prefs1.weekendRanking), 'response includes weekendRanking array')

const { status: prefPutStatus } = await api(R1.id, 'PUT', '/api/preferences', {
  weekdayRanking: ['BC Cancer Agency CT', 'BC Cancer Agency MRI/PET'],
  weekendRanking: ['BC Cancer Agency MRI/PET', 'BC Cancer Agency CT'],
})
assert(prefPutStatus === 200, 'PUT /api/preferences returns 200')

const { body: prefs2 } = await api(R1.id, 'GET', '/api/preferences')
assert(prefs2.weekdayRanking?.[0] === 'BC Cancer Agency CT', 'weekday ranking persisted correctly')
assert(prefs2.weekendRanking?.[0] === 'BC Cancer Agency MRI/PET', 'weekend ranking persisted correctly')

// ── 3.21 Shift started — swap and split accepts blocked ───────────────────────
section('3.21 Shift started — swap accept and split accept blocked')
// Insert a definitively-past shift directly via DB (2020-01-01)
const [{ id: PAST_SHIFT_ID }] = await db`
  INSERT INTO shifts (date, clinic_id, period_id, start_time, end_time)
  VALUES ('2020-01-01', (SELECT id FROM clinics WHERE name = 'BC Cancer Agency MRI/PET'), ${HTTP_PERIOD_ID}::uuid, '08:00', '17:00')
  RETURNING id
`

const pastSwapId = crypto.randomUUID()
await db`
  INSERT INTO swap_requests (id, requested_at, status, requestor_user_id, requestor_name, requestor_shift_id)
  VALUES (${pastSwapId}, NOW(), 'pending', ${R1.id}, ${R1.name}, ${PAST_SHIFT_ID})
`
const { status: pastSwapAcc, body: pastSwapAccBody } = await api(R2.id, 'PATCH', `/api/swaps/${pastSwapId}`, { action: 'accept' })
assert(pastSwapAcc === 409, 'swap accept blocked when shift has already started (409)', `status=${pastSwapAcc} body=${JSON.stringify(pastSwapAccBody)}`)

const { body: swapsAfterStart } = await api(R1.id, 'GET', '/api/swaps')
const autoSwap = Array.isArray(swapsAfterStart) ? swapsAfterStart.find(r => r.id === pastSwapId) : null
assert(autoSwap?.status === 'cancelled', 'GET /api/swaps auto-cancels pending offer for started shift')

const { body: swapsAfterStart2 } = await api(R1.id, 'GET', '/api/swaps')
const autoSwap2 = Array.isArray(swapsAfterStart2) ? swapsAfterStart2.find(r => r.id === pastSwapId) : null
assert(autoSwap2?.status === 'cancelled', 'cancelled status persists in DB after auto-cancel')

const pastSplitId = crypto.randomUUID()
await db`
  INSERT INTO shift_splits (id, shift_id, offeror_name, offeror_user_id, offered_start, offered_end, status)
  VALUES (${pastSplitId}, ${PAST_SHIFT_ID}, ${R1.name}, ${R1.id}, '12:00', '17:00', 'pending')
`
const { status: pastSplitAcc, body: pastSplitAccBody } = await api(R2.id, 'PATCH', `/api/splits/${pastSplitId}`, { action: 'accept' })
assert(pastSplitAcc === 409, 'split accept blocked when shift has already started (409)', `status=${pastSplitAcc} body=${JSON.stringify(pastSplitAccBody)}`)

const { body: splitsAfterStart } = await api(R1.id, 'GET', '/api/splits')
const autoSplit = Array.isArray(splitsAfterStart) ? splitsAfterStart.find(s => s.id === pastSplitId) : null
assert(autoSplit?.status === 'cancelled', 'GET /api/splits auto-cancels pending offer for started shift')

// ── 3.22 Simple-clinic billing rates writable via API ─────────────────────────
section('3.22 Billing rates — simple clinic rate keys (UBC_rate, BCWH_rate, INITIO_rate) writable')
const simpleRateChecks = [
  { key: 'UBC_rate',    label: 'UBC' },
  { key: 'BCWH_rate',   label: 'BCWH' },
  { key: 'INITIO_rate', label: 'INITIO' },
]
for (const { key, label } of simpleRateChecks) {
  const { body: before } = await api(ADMIN, 'GET', '/api/admin/billing-rates')
  const original = before?.[key]
  const testValue = (original ?? 75) + 1
  const { status: putStatus } = await api(ADMIN, 'PUT', '/api/admin/billing-rates', { key, value: testValue })
  assert(putStatus === 200, `PUT billing rate ${key} returns 200`)
  const { body: after } = await api(ADMIN, 'GET', '/api/admin/billing-rates')
  assert(Number(after?.[key]) === testValue, `${label} rate update persisted (${key}=${testValue})`)
  if (original !== undefined) await api(ADMIN, 'PUT', '/api/admin/billing-rates', { key, value: original })
}

// ── 3.23 Malformed billing rate key rejected ─────────────────────────────────
section('3.23 Billing rates — malformed key (no underscore) rejected with 400')
const { status: badKeyStatus } = await api(ADMIN, 'PUT', '/api/admin/billing-rates', { key: 'NOUNDERSCORE', value: 50 })
assert(badKeyStatus === 400, 'key without underscore separator → 400')
const { status: emptyKeyStatus } = await api(ADMIN, 'PUT', '/api/admin/billing-rates', { key: '', value: 50 })
assert(emptyKeyStatus === 400, 'empty key → 400')

// ── 3.24 Billing contacts — renamed and new entities accepted ────────────────
section('3.24 Billing contacts — UBC, BCWH, INITIO entities accepted')
const contactChecks = [
  { entity: 'UBC',    org: 'Vancouver Imaging Test' },
  { entity: 'BCWH',  org: 'BCW Diagnostic Test' },
  { entity: 'INITIO', org: 'INITIO Test Org' },
]
for (const { entity, org } of contactChecks) {
  const { status: putStatus } = await api(ADMIN, 'PUT', '/api/admin/billing-contacts', {
    entity, contactName: 'Test Contact', org, address: '123 Test St', email: null,
  })
  assert(putStatus === 200, `PUT /api/admin/billing-contacts entity=${entity} returns 200`)
}
const { body: contactsAfter } = await api(ADMIN, 'GET', '/api/admin/billing-contacts')
assert(Array.isArray(contactsAfter), 'GET billing contacts returns array after updates')
for (const { entity, org } of contactChecks) {
  const row = contactsAfter.find(c => c.entity === entity)
  assert(row?.org === org, `billing contact for ${entity} persisted (org="${org}")`)
}

// ════════════════════════════════════════════════════════════════════════════
// Cleanup + summary
// ════════════════════════════════════════════════════════════════════════════
async function cleanup() {
  console.log('\n── Cleanup ──')
  try {
    if (HTTP_PERIOD_ID) {
      await db`DELETE FROM availability_submissions WHERE period_id = ${HTTP_PERIOD_ID}`
      await db`DELETE FROM scheduling_periods WHERE id = ${HTTP_PERIOD_ID}::uuid`
      // FK CASCADE removes: shifts → shift_splits, swap_requests, shift_assignments
    }
    await db`DELETE FROM invoice_sequences WHERE user_id = '__test_user__'`
    for (const u of TEST_USERS) await db`DELETE FROM resident_preferences WHERE user_id = ${u.id}`
    for (const u of TEST_USERS) await clerkReq('DELETE', `/users/${u.id}`)
    ok('test data removed')
  } catch (e) {
    console.error('  ! Cleanup error:', e.message)
  } finally {
    await db.end()
  }
}

await cleanup()

console.log(`\n${'═'.repeat(55)}`)
console.log(`Results: ${passed} passed, ${failed} failed out of ${passed + failed}`)
if (failures.length) {
  console.log('\nFailed:')
  failures.forEach((f, i) => console.log(`  ${i + 1}. ${f}`))
}
process.exit(failed > 0 ? 1 : 0)
