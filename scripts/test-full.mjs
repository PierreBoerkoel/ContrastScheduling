/**
 * Full integration test: creates 25 residents, runs scheduling scenarios,
 * identifies bugs. Run with: node scripts/test-full.mjs
 */

import { createRequire } from 'module'
const require = createRequire(import.meta.url)
const { sql } = require('/Users/pierreboerkoel/Programming/ContrastScheduling/node_modules/@vercel/postgres/dist/index-node.cjs')

const CLERK_SECRET = 'sk_test_L75wsA3xpgv9NByi3jpQiNL2hXRsBWsFAC2O3vu1h8'
const BASE_URL = 'https://contrast-scheduling.vercel.app'

// ── Helpers ───────────────────────────────────────────────────────────────────

let passed = 0, failed = 0
const bugs = []
function ok(label) { console.log('  ✓', label); passed++ }
function fail(label, detail = '') {
  const msg = detail ? `${label} — ${detail}` : label
  console.error('  ✗', msg)
  bugs.push(msg)
  failed++
}
function section(name) { console.log(`\n── ${name} ──`) }

async function clerkReq(method, path, body) {
  const r = await fetch(`https://api.clerk.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${CLERK_SECRET}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}),
  })
  return r.json()
}
const clerkGet    = path       => clerkReq('GET',    path)
const clerkPost   = (path, b)  => clerkReq('POST',   path, b)
const clerkDelete = path       => clerkReq('DELETE', path)

// Returns { body, status } — body is parsed JSON (array or object)
async function getSessionToken(userId) {
  const session = await clerkPost('/sessions', { user_id: userId })
  if (!session.id) return null
  const tok = await clerkPost(`/sessions/${session.id}/tokens`, {})
  return tok.jwt ?? null
}

const tokenCache = {}
async function apiAs(userId, method, path, body) {
  if (!tokenCache[userId]) tokenCache[userId] = await getSessionToken(userId)
  const token = tokenCache[userId]
  if (!token) return { body: { error: 'no token' }, status: 500 }
  const opts = {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  }
  if (body !== undefined) opts.body = JSON.stringify(body)
  const r = await fetch(`${BASE_URL}${path}`, opts)
  const text = await r.text()
  let body2
  try { body2 = JSON.parse(text) } catch { body2 = text }
  return { body: body2, status: r.status }
}

// ── Resident names ────────────────────────────────────────────────────────────

const RESIDENTS = [
  ['Alice', 'Anderson'], ['Bob', 'Brown'], ['Carol', 'Chen'],
  ['David', 'Davis'], ['Emma', 'Evans'], ['Frank', 'Foster'],
  ['Grace', 'Garcia'], ['Henry', 'Hall'], ['Irene', 'Ibrahim'],
  ['James', 'Johnson'], ['Karen', 'Kim'], ['Leo', 'Lopez'],
  ['Maya', 'Martin'], ['Noah', 'Nelson'], ['Olivia', 'Ortiz'],
  ['Paul', 'Parker'], ['Quinn', 'Quinn'], ['Rachel', 'Roberts'],
  ['Sam', 'Scott'], ['Tara', 'Thompson'], ['Uma', 'Upton'],
  ['Victor', 'Vasquez'], ['Wendy', 'Wilson'], ['Xander', 'Xu'],
  ['Yara', 'Young'],
]

function dateStr(d) { return d.toISOString().split('T')[0] }
function addDays(d, n) { const r = new Date(d); r.setUTCDate(r.getUTCDate() + n); return r }

const CLINICS = ['BC Cancer Agency', 'INITIO Medical Imaging', 'UBC Hospital', "BC Women's Hospital"]
const adminId = 'user_3DrnD8vAXJ652LyUorTScqKDVMu'
const createdUsers = [] // { id, name }

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Contrast Scheduling Full Integration Test ===\n')

  // ── 1. Clean DB ──────────────────────────────────────────────────────────
  section('1. Reset database')
  await sql`DELETE FROM availability_submissions`
  await sql`DELETE FROM swap_requests`
  await sql`DELETE FROM schedule`
  await sql`DELETE FROM shifts`
  ok('Database cleared')

  // ── 2. Delete existing non-admin Clerk users ─────────────────────────────
  section('2. Clean Clerk users')
  const existing = await clerkGet('/users?limit=200')
  const toDelete = (existing.data ?? existing).filter(u => u.id !== adminId)
  for (const u of toDelete) await clerkDelete(`/users/${u.id}`)
  if (toDelete.length > 0) ok(`Removed ${toDelete.length} stale users`)
  else ok('No stale users to remove')

  // ── 3. Create 25 residents ───────────────────────────────────────────────
  section('3. Create 25 resident accounts')
  for (const [first, last] of RESIDENTS) {
    const email = `${first.toLowerCase()}.${last.toLowerCase()}@test-contrast.dev`
    const u = await clerkPost('/users', {
      first_name: first,
      last_name: last,
      email_address: [email],
      password: 'TestPassword123!',
      public_metadata: { role: 'resident' },
      skip_password_checks: true,
      skip_password_requirement: true,
    })
    if (u.id) {
      createdUsers.push({ id: u.id, name: `${first} ${last}` })
      process.stdout.write('.')
    } else {
      fail(`Create ${first} ${last}`, JSON.stringify(u.errors?.[0]?.message ?? u))
    }
  }
  console.log()
  if (createdUsers.length === RESIDENTS.length) ok(`Created ${createdUsers.length} residents`)
  else fail(`Only created ${createdUsers.length}/${RESIDENTS.length}`)

  // ── 4. Admin sees correct user list ─────────────────────────────────────
  section('4. Admin: list residents')
  const { body: userList, status: ulStatus } = await apiAs(adminId, 'GET', '/api/admin/users')
  if (ulStatus === 200 && Array.isArray(userList) && userList.length >= 25)
    ok(`Admin sees ${userList.length} users`)
  else fail('Admin user list', `status=${ulStatus} isArray=${Array.isArray(userList)} len=${Array.isArray(userList) ? userList.length : '?'}`)

  // ── 5. Set up Period A shifts ────────────────────────────────────────────
  section('5. Admin: set up Period A shifts')
  const today = new Date(); today.setUTCHours(0,0,0,0)
  const daysToMon = (8 - today.getUTCDay()) % 7 || 7
  const monday = addDays(today, daysToMon)

  const periodADates = []
  for (let i = 0; i < 14; i++) {
    const d = addDays(monday, i)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) periodADates.push(dateStr(d))
  }
  const activeClinicsA = {}
  for (const d of periodADates) activeClinicsA[d] = CLINICS

  const { status: saveAStatus } = await apiAs(adminId, 'POST', '/api/shifts', {
    startDate: periodADates[0], endDate: periodADates[periodADates.length - 1],
    activeClinics: activeClinicsA,
  })
  if (saveAStatus === 200) ok(`Period A: ${periodADates.length} days × ${CLINICS.length} clinics`)
  else fail('Save Period A shifts', `status=${saveAStatus}`)

  // ── 6. Get shifts list ───────────────────────────────────────────────────
  const { body: shiftsA, status: shiftsAStatus } = await apiAs(adminId, 'GET', '/api/shifts')
  if (shiftsAStatus === 200 && Array.isArray(shiftsA) && shiftsA.length > 0)
    ok(`${shiftsA.length} shifts in DB`)
  else { fail('Get shifts', `status=${shiftsAStatus} len=${Array.isArray(shiftsA) ? shiftsA.length : typeof shiftsA}`); return }

  // ── 7. Residents submit availability (Period A) ──────────────────────────
  section('6. Residents submit availability (Period A)')
  let availSubmitted = 0
  for (const { id: uid, name } of createdUsers) {
    const available = shiftsA.filter(() => Math.random() < 0.72).map(s => s.id)
    const { status } = await apiAs(uid, 'POST', '/api/availability', { availableShiftIds: available })
    if (status === 200) availSubmitted++
    else fail(`Avail submit: ${name}`, `status=${status}`)
  }
  ok(`${availSubmitted}/${createdUsers.length} residents submitted availability`)

  // ── 8. Generate schedule ─────────────────────────────────────────────────
  section('7. Admin: generate + publish Period A')
  const { body: genA, status: genAStatus } = await apiAs(adminId, 'POST', '/api/schedule', { action: 'generate' })
  if (genAStatus === 200 && Array.isArray(genA.assignments)) {
    const assigned   = genA.assignments.filter(a => a.residentName).length
    const unassigned = genA.assignments.filter(a => !a.residentName).length
    ok(`Generated: ${assigned} assigned, ${unassigned} unassigned`)
  } else fail('Generate schedule', `status=${genAStatus}`)

  // ── 9. No double-booking in draft ────────────────────────────────────────
  section('8. Validate: no double-booking in draft')
  const seenA = {}; let dbA = 0
  for (const a of (genA.assignments ?? [])) {
    if (!a.residentName) continue
    const key = `${a.residentName}|${a.shiftId.split('|')[0]}`
    if (seenA[key]) { dbA++; fail(`Double-booked in draft: ${a.residentName} on ${a.shiftId.split('|')[0]}`) }
    seenA[key] = true
  }
  if (dbA === 0) ok('No double-bookings in draft')

  // ── 10. Publish Period A ─────────────────────────────────────────────────
  const { body: pubA, status: pubAStatus } = await apiAs(adminId, 'POST', '/api/schedule', { action: 'publish' })
  if (pubAStatus === 200 && pubA.isPublished) ok('Period A published')
  else fail('Publish Period A', `status=${pubAStatus}`)

  // ── 11. Availability locked for published shifts ─────────────────────────
  section('9. Availability lock enforced')
  const { status: lockStatus } = await apiAs(createdUsers[0].id, 'POST', '/api/availability', {
    availableShiftIds: [shiftsA[0].id],
  })
  if (lockStatus === 409) ok('Resubmission for published shifts correctly blocked')
  else fail('Lock not enforced', `status=${lockStatus}`)

  // ── 12. Resident views published schedule ────────────────────────────────
  section('10. Resident: view schedule')
  const { body: resSched, status: resSchedStatus } = await apiAs(createdUsers[0].id, 'GET', '/api/schedule')
  if (resSchedStatus === 200 && Array.isArray(resSched.publishedAssignments) && resSched.publishedAssignments.length > 0)
    ok(`Resident sees ${resSched.publishedAssignments.length} published assignments`)
  else fail('Resident cannot see schedule', `status=${resSchedStatus}`)

  const pub = resSched.publishedAssignments ?? []

  // ── 13. Claim unassigned shift (with same-day guard) ─────────────────────
  section('11. Claim unassigned shift')
  const unassigned = pub.find(a => !a.residentName)
  if (!unassigned) {
    console.log('  (no unassigned shifts to test)')
  } else {
    const claimDate = unassigned.shiftId.split('|')[0]
    const freeResident = createdUsers.find(u =>
      !pub.some(a => a.residentName === u.name && a.shiftId.startsWith(claimDate + '|'))
    )
    if (!freeResident) {
      console.log('  (all residents busy on unassigned day)')
    } else {
      const { status: claimStatus } = await apiAs(freeResident.id, 'PUT', '/api/schedule', {
        shiftId: unassigned.shiftId,
      })
      if (claimStatus === 200) ok(`${freeResident.name} claimed shift on ${claimDate}`)
      else fail('Claim shift', `status=${claimStatus}`)

      // Same-day double-claim should be blocked
      const busyResident = createdUsers.find(u =>
        pub.some(a => a.residentName === u.name && a.shiftId.startsWith(claimDate + '|')) &&
        u.id !== freeResident.id
      )
      if (busyResident) {
        const { status: doubleStatus } = await apiAs(busyResident.id, 'PUT', '/api/schedule', {
          shiftId: unassigned.shiftId,
        })
        if (doubleStatus === 409) ok('Same-day double-claim correctly blocked')
        else fail('Same-day double-claim NOT blocked', `status=${doubleStatus}`)
      }
    }
  }

  // ── 14. Fetch fresh published schedule for swap tests ────────────────────
  const { body: freshSched } = await apiAs(adminId, 'GET', '/api/schedule')
  const freshPub = freshSched.publishedAssignments ?? []

  // ── 15. Valid swap ────────────────────────────────────────────────────────
  section('12. Swap: valid swap between two residents')
  const r2 = createdUsers[1], r3 = createdUsers[2]
  const r2Shifts = freshPub.filter(a => a.residentName === r2.name)
  const r3Shifts = freshPub.filter(a => a.residentName === r3.name)
  let swapReqId = null, s2 = null, s3 = null

  if (r2Shifts.length && r3Shifts.length) {
    for (const a of r2Shifts) {
      for (const b of r3Shifts) {
        const d2 = a.shiftId.split('|')[0], d3 = b.shiftId.split('|')[0]
        const r2HasD3 = r2Shifts.some(s => s.shiftId !== a.shiftId && s.shiftId.startsWith(d3 + '|'))
        const r3HasD2 = r3Shifts.some(s => s.shiftId !== b.shiftId && s.shiftId.startsWith(d2 + '|'))
        if (!r2HasD3 && !r3HasD2 && d2 !== d3) { s2 = a; s3 = b; break }
      }
      if (s2) break
    }
  }

  if (!s2) {
    console.log('  (no valid swap pair found)')
  } else {
    const { body: reqBody, status: reqStatus } = await apiAs(r2.id, 'POST', '/api/swaps', {
      requestorShiftId: s2.shiftId,
    })
    if (reqStatus === 201 && reqBody.id) {
      ok(`${r2.name} posted swap request`)
      swapReqId = reqBody.id

      const { body: accBody, status: accStatus } = await apiAs(r3.id, 'PATCH', `/api/swaps/${swapReqId}`, {
        action: 'accept', acceptorShiftId: s3.shiftId,
      })
      if (accStatus === 200 && accBody.status === 'accepted') ok(`${r3.name} accepted swap`)
      else fail('Accept swap', `status=${accStatus} body=${JSON.stringify(accBody)}`)

      // Verify swap reflected in publishedAssignments
      const { body: afterSched } = await apiAs(adminId, 'GET', '/api/schedule')
      const afterPub = afterSched.publishedAssignments ?? []
      const r2GotS3 = afterPub.find(a => a.shiftId === s3.shiftId)?.residentName === r2.name
      const r3GotS2 = afterPub.find(a => a.shiftId === s2.shiftId)?.residentName === r3.name
      if (r2GotS3 && r3GotS2) ok('Swap reflected correctly in publishedAssignments')
      else fail('Swap not reflected in publishedAssignments', `r2GotS3=${r2GotS3} r3GotS2=${r3GotS2}`)

      // No double-bookings after swap
      const postMap = {}; let postDB = 0
      for (const a of afterPub) {
        if (!a.residentName) continue
        const key = `${a.residentName}|${a.shiftId.split('|')[0]}`
        if (postMap[key]) { postDB++; fail(`Post-swap double-booking: ${a.residentName}`) }
        postMap[key] = true
      }
      if (postDB === 0) ok('No double-bookings after swap')
    } else fail('Post swap request', `status=${reqStatus}`)
  }

  // ── 16. Double-booking swap is blocked ───────────────────────────────────
  // Real conflict: A has shifts on Day X AND Day Y; B has a shift on Day Y.
  // A offers Day X, B accepts with Day Y → A would gain a 2nd shift on Day Y → must be rejected.
  section('13. Double-booking swap blocked')
  const { body: fresh2 } = await apiAs(adminId, 'GET', '/api/schedule')
  const pub2 = fresh2.publishedAssignments ?? []

  // Build per-resident shift index
  const byResident = {}
  for (const a of pub2) {
    if (!a.residentName) continue
    ;(byResident[a.residentName] ??= []).push(a)
  }

  // Find A (2+ shifts on different days) and B (shift on one of A's days that isn't A's offered day)
  let conflictResA = null, conflictResB = null, offeredShift = null, conflictShift = null
  outer: for (const [nameA, aShifts] of Object.entries(byResident)) {
    if (aShifts.length < 2) continue
    for (let i = 0; i < aShifts.length; i++) {
      const offered = aShifts[i]                      // A will offer this
      const dayA = offered.shiftId.split('|')[0]
      // A's OTHER shift day — A would conflict if they gain something on this day
      const otherShifts = aShifts.filter((_, j) => j !== i)
      for (const other of otherShifts) {
        const conflictDay = other.shiftId.split('|')[0]
        // Find B who has a shift on conflictDay and is not A
        for (const [nameB, bShifts] of Object.entries(byResident)) {
          if (nameB === nameA) continue
          const bOnConflictDay = bShifts.find(s => s.shiftId.startsWith(conflictDay + '|'))
          if (bOnConflictDay) {
            conflictResA = createdUsers.find(u => u.name === nameA)
            conflictResB = createdUsers.find(u => u.name === nameB)
            offeredShift = offered         // A's Day X shift
            conflictShift = bOnConflictDay // B's Day Y shift (same as A's other day)
            break outer
          }
        }
      }
    }
  }

  if (!conflictResA) {
    console.log('  (no suitable resident pair found for double-booking test)')
  } else {
    const offeredDay = offeredShift.shiftId.split('|')[0]
    const conflictDay = conflictShift.shiftId.split('|')[0]
    console.log(`  Testing: ${conflictResA.name} offers ${offeredDay}, ${conflictResB.name} accepts with ${conflictDay} (A already has ${conflictDay})`)

    const { body: dbReq, status: dbReqStatus } = await apiAs(conflictResA.id, 'POST', '/api/swaps', {
      requestorShiftId: offeredShift.shiftId,
    })
    if (dbReqStatus === 201 && dbReq.id) {
      const { status: dbAccStatus, body: dbAccBody } = await apiAs(conflictResB.id, 'PATCH', `/api/swaps/${dbReq.id}`, {
        action: 'accept', acceptorShiftId: conflictShift.shiftId,
      })
      if (dbAccStatus === 409) ok('Double-booking swap correctly rejected (409)')
      else fail('Double-booking swap NOT rejected', `status=${dbAccStatus} body=${JSON.stringify(dbAccBody)}`)
      // Cancel if not already resolved
      if (dbAccStatus !== 200) {
        await apiAs(conflictResA.id, 'PATCH', `/api/swaps/${dbReq.id}`, { action: 'cancel' })
      }
    } else {
      console.log(`  (could not post swap request: status=${dbReqStatus})`)
    }
  }

  // ── 17. Access control ───────────────────────────────────────────────────
  section('14. Access control')
  const nonAdmin = createdUsers[0].id

  const { status: acS1 } = await apiAs(nonAdmin, 'POST', '/api/shifts', {
    startDate: '2026-01-01', endDate: '2026-01-01', activeClinics: {},
  })
  if (acS1 === 403) ok('Non-admin cannot POST /api/shifts')
  else fail('Non-admin shift save not blocked', `status=${acS1}`)

  const { status: acS2 } = await apiAs(nonAdmin, 'POST', '/api/schedule', { action: 'generate' })
  if (acS2 === 403) ok('Non-admin cannot generate schedule')
  else fail('Non-admin generate not blocked', `status=${acS2}`)

  const { status: acS3 } = await apiAs(nonAdmin, 'POST', '/api/schedule', { action: 'publish' })
  if (acS3 === 403) ok('Non-admin cannot publish schedule')
  else fail('Non-admin publish not blocked', `status=${acS3}`)

  const { status: acS4 } = await apiAs(nonAdmin, 'GET', '/api/admin/users')
  if (acS4 === 403) ok('Non-admin cannot list users')
  else fail('Non-admin user list not blocked', `status=${acS4}`)

  // ── 18. Period B: new shifts while A is published ────────────────────────
  section('15. Multi-period: Period B while A is published')
  const periodBStart = addDays(monday, 14)
  const periodBDates = []
  for (let i = 0; i < 14; i++) {
    const d = addDays(periodBStart, i)
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) periodBDates.push(dateStr(d))
  }
  const activeClinicsB = {}
  for (const d of periodBDates) activeClinicsB[d] = CLINICS

  const { status: saveBStatus } = await apiAs(adminId, 'POST', '/api/shifts', {
    startDate: periodBDates[0], endDate: periodBDates[periodBDates.length - 1],
    activeClinics: activeClinicsB,
  })
  if (saveBStatus === 200) ok(`Period B shifts saved (${periodBDates.length} days)`)
  else fail('Save Period B shifts', `status=${saveBStatus}`)

  // Period A schedule still visible after Period B shifts set up
  const { body: schedAfterB } = await apiAs(createdUsers[0].id, 'GET', '/api/schedule')
  const hasPeriodA = (schedAfterB.publishedAssignments ?? []).some(a =>
    a.shiftId.startsWith(periodADates[0])
  )
  if (hasPeriodA) ok('Period A still visible after Period B shifts created')
  else fail('Period A hidden after Period B shift setup')

  // Residents can submit availability for Period B (different shift IDs)
  const { body: shiftsB } = await apiAs(adminId, 'GET', '/api/shifts')
  const shiftsBArr = Array.isArray(shiftsB) ? shiftsB : []
  let availBCount = 0
  for (const { id: uid } of createdUsers) {
    const available = shiftsBArr.filter(() => Math.random() < 0.72).map(s => s.id)
    const { status } = await apiAs(uid, 'POST', '/api/availability', { availableShiftIds: available })
    if (status === 200) availBCount++
    else fail(`Period B availability`, `uid=${uid} status=${status}`)
  }
  ok(`${availBCount}/${createdUsers.length} submitted Period B availability`)

  // Generate & publish Period B
  const { body: genB, status: genBStatus } = await apiAs(adminId, 'POST', '/api/schedule', { action: 'generate' })
  if (genBStatus === 200 && Array.isArray(genB.assignments)) {
    ok(`Period B draft: ${genB.assignments.filter(a=>a.residentName).length} assigned`)
  } else fail('Generate Period B', `status=${genBStatus}`)

  // Period A still visible during draft
  const { body: draftSched } = await apiAs(createdUsers[0].id, 'GET', '/api/schedule')
  const aVisibleDuringDraft = (draftSched.publishedAssignments ?? []).some(a =>
    a.shiftId.startsWith(periodADates[0])
  )
  if (aVisibleDuringDraft) ok('Period A still visible while Period B is in draft')
  else fail('Period A hidden during Period B draft')

  const { body: pubB, status: pubBStatus } = await apiAs(adminId, 'POST', '/api/schedule', { action: 'publish' })
  if (pubBStatus === 200 && pubB.isPublished) ok('Period B published')
  else fail('Publish Period B', `status=${pubBStatus}`)

  // Both periods visible
  const { body: bothSched } = await apiAs(createdUsers[0].id, 'GET', '/api/schedule')
  const bothPub = bothSched.publishedAssignments ?? []
  const hasBothA = bothPub.some(a => a.shiftId.startsWith(periodADates[0]))
  const hasBothB = bothPub.some(a => a.shiftId.startsWith(periodBDates[0]))
  if (hasBothA && hasBothB) ok('Both Period A and B visible in published schedule')
  else fail('Periods missing', `A=${hasBothA} B=${hasBothB}`)

  // No double-bookings across both periods
  const finalMap = {}; let finalDB = 0
  for (const a of bothPub) {
    if (!a.residentName) continue
    const key = `${a.residentName}|${a.shiftId.split('|')[0]}`
    if (finalMap[key]) { finalDB++; fail(`Double-booking across periods: ${a.residentName}`) }
    finalMap[key] = true
  }
  if (finalDB === 0) ok('No double-bookings across both published periods')

  // Period B availability is now locked
  const { status: lockBStatus } = await apiAs(createdUsers[0].id, 'POST', '/api/availability', {
    availableShiftIds: [shiftsBArr[0]?.id].filter(Boolean),
  })
  if (lockBStatus === 409) ok('Period B availability correctly locked after publish')
  else fail('Period B lock not enforced', `status=${lockBStatus}`)

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n${'═'.repeat(55)}`)
  console.log(`Results: ${passed} passed, ${failed} failed`)
  if (bugs.length > 0) {
    console.log('\nBugs found:')
    bugs.forEach((b, i) => console.log(`  ${i+1}. ${b}`))
  }
  if (failed > 0) process.exit(1)
}

main().catch(e => { console.error('Fatal:', e.stack ?? e); process.exit(1) })
