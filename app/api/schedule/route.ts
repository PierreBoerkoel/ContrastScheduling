import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getShifts, getSubmissions, getSchedule, setSchedule, updatePeriodPublishedAt, getShiftSplits, getSwapRequests, updateShiftSplit } from '@/lib/db'
import { generateSchedule } from '@/lib/scheduler'
import { computeCoverageSegments } from '@/lib/types'
import type { Schedule, ShiftAssignment } from '@/lib/types'

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getSchedule())
}

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await request.json() as { action: 'generate' | 'publish'; periodId?: string }
  const { action } = body

  if (action === 'generate') {
    const { periodId } = body as { periodId?: string }
    const [allShifts, allSubmissions, existing] = await Promise.all([getShifts(), getSubmissions(), getSchedule()])

    const shifts = periodId ? allShifts.filter((s) => s.periodId === periodId) : allShifts
    const submissions = periodId ? allSubmissions.filter((s) => s.periodId === periodId) : allSubmissions
    const newAssignments = generateSchedule(shifts, submissions)

    // Keep other blocks' draft assignments intact
    const blockShiftIds = new Set(shifts.map((s) => s.id))
    const keptAssignments = (existing?.assignments ?? []).filter((a) => !blockShiftIds.has(a.shiftId))

    const existingPublished = existing?.publishedAssignments ?? []
    const schedule: Schedule = {
      generatedAt: new Date().toISOString(),
      publishedAt: existing?.publishedAt ?? null,
      updatedAt: null,
      // Preserve isPublished if other blocks already have published assignments — generating
      // a new draft must not revoke resident access to already-published blocks.
      isPublished: existingPublished.length > 0 ? (existing?.isPublished ?? false) : false,
      assignments: [...keptAssignments, ...newAssignments],
      publishedAssignments: existingPublished,
    }
    await setSchedule(schedule)
    return NextResponse.json(schedule)
  }

  if (action === 'publish') {
    const { periodId } = body as { periodId?: string }
    const schedule = await getSchedule()
    if (!schedule) {
      return NextResponse.json({ error: 'No schedule to publish' }, { status: 400 })
    }
    // Merge draft into existing published assignments: draft overrides for same shiftId
    const mergedMap = new Map<string, typeof schedule.assignments[number]>()
    for (const a of schedule.publishedAssignments) mergedMap.set(a.shiftId, a)
    for (const a of schedule.assignments) mergedMap.set(a.shiftId, a)
    const published: Schedule = {
      ...schedule,
      publishedAt: new Date().toISOString(),
      isPublished: true,
      publishedAssignments: Array.from(mergedMap.values()),
    }
    await setSchedule(published)
    if (periodId) await updatePeriodPublishedAt(periodId)
    return NextResponse.json(published)
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
}

export async function PUT(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { shiftId, swap } = (await request.json()) as { shiftId: string; swap?: boolean }

  const schedule = await getSchedule()
  if (!schedule?.isPublished) {
    return NextResponse.json({ error: 'No published schedule' }, { status: 400 })
  }

  const idx = schedule.assignments.findIndex((a: ShiftAssignment) => a.shiftId === shiftId)
  if (idx < 0) {
    return NextResponse.json({ error: 'Shift not in schedule' }, { status: 404 })
  }
  if (schedule.assignments[idx].residentName !== null) {
    return NextResponse.json({ error: 'Shift is already assigned' }, { status: 409 })
  }

  const user = await currentUser()
  const name = user?.fullName ?? [user?.firstName, user?.lastName].filter(Boolean).join(' ') ?? ''
  if (!name) return NextResponse.json({ error: 'Could not determine your name' }, { status: 400 })

  const targetDate = shiftId.split('|')[0]
  const existingOnDay = schedule.assignments.find(
    (a) => a.shiftId !== shiftId && a.shiftId.startsWith(targetDate + '|') &&
      a.userId === userId
  )

  const [allShifts, allSplits, allSwaps] = await Promise.all([getShifts(), getShiftSplits(), getSwapRequests()])
  const shiftById = Object.fromEntries(allShifts.map((s) => [s.id, s]))

  // True when the user is the primary assignee but has given away 100% through chained splits
  const userFullyGivenAway = existingOnDay ? (() => {
    const existingShift = shiftById[existingOnDay.shiftId]
    if (!existingShift?.startTime || !existingShift?.endTime) return false
    const shiftSplits = allSplits.filter((sp) => sp.shiftId === existingOnDay.shiftId)
    const segments = computeCoverageSegments(existingShift, existingOnDay.residentName, shiftSplits, userId)
    return segments.every((seg) => seg.userId !== userId)
  })() : false

  const newShift = shiftById[shiftId]
  const mins = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m }
  const overlaps = (aS: string, aE: string, bS: string, bE: string) =>
    mins(aS) < mins(bE) && mins(bS) < mins(aE)

  // Detect if the user covers a full shift window as a split acceptor on this day.
  // If so, treat it like owning that shift: allow the swap rather than blocking.
  let fullCoverageSplitShiftId: string | null = null
  const myAcceptedSplitsOnDay = allSplits.filter(
    (sp) => sp.status === 'accepted' &&
      sp.acceptorUserId === userId &&
      sp.shiftId.split('|')[0] === targetDate
  )
  if (myAcceptedSplitsOnDay.length > 0) {
    const shiftIdsOnDay = [...new Set(myAcceptedSplitsOnDay.map((sp) => sp.shiftId))]
    for (const sid of shiftIdsOnDay) {
      const parentShift = shiftById[sid]
      if (!parentShift?.startTime || !parentShift?.endTime) continue
      const parentAssignment = schedule.publishedAssignments.find((a) => a.shiftId === sid)
      const segments = computeCoverageSegments(parentShift, parentAssignment?.residentName ?? null, allSplits.filter((sp) => sp.shiftId === sid), parentAssignment?.userId ?? null)
      const mySegs = segments.filter((seg) => seg.userId === userId)
      if (mySegs.length === 0) continue
      const ownedStart = mySegs.reduce((min, s) => s.start < min ? s.start : min, mySegs[0].start)
      const ownedEnd = mySegs.reduce((max, s) => s.end > max ? s.end : max, mySegs[0].end)
      if (ownedStart === parentShift.startTime && ownedEnd === parentShift.endTime) {
        fullCoverageSplitShiftId = sid
        break
      }
    }
  }

  // Block if the user has an accepted split portion on this day that overlaps the new shift.
  // Skip this check when the user fully covers another shift as an acceptor — handled as a swap below.
  if (!fullCoverageSplitShiftId && newShift?.startTime && newShift?.endTime) {
    for (const sp of allSplits) {
      if (sp.status !== 'accepted') continue
      if (sp.acceptorUserId !== userId) continue
      if (sp.shiftId.split('|')[0] !== targetDate) continue
      if (overlaps(newShift.startTime, newShift.endTime, sp.offeredStart, sp.offeredEnd)) {
        return NextResponse.json(
          { error: 'You are already scheduled on this day' },
          { status: 409 }
        )
      }
    }
  }

  if (existingOnDay && !userFullyGivenAway && !swap) {
    return NextResponse.json({ error: 'You are already scheduled on this day' }, { status: 409 })
  }

  // If swapping, check for pending offers that overlap the new shift before vacating
  if (existingOnDay && !userFullyGivenAway && swap) {
    if (newShift?.startTime && newShift?.endTime) {
      for (const sp of allSplits) {
        if (sp.status !== 'pending') continue
        if (sp.offerorUserId !== userId) continue
        if (sp.shiftId.split('|')[0] !== targetDate) continue
        if (overlaps(newShift.startTime, newShift.endTime, sp.offeredStart, sp.offeredEnd)) {
          return NextResponse.json(
            { error: `You have a pending portion offer (${sp.offeredStart}–${sp.offeredEnd}) on this day. Cancel it before swapping to a shift with an overlapping time.` },
            { status: 409 }
          )
        }
      }

      for (const req of allSwaps) {
        if (req.status !== 'pending') continue
        if (req.requestorUserId !== userId) continue
        if (req.requestorShiftId.split('|')[0] !== targetDate) continue
        const reqShift = shiftById[req.requestorShiftId]
        if (!reqShift?.startTime || !reqShift?.endTime) continue
        if (overlaps(newShift.startTime, newShift.endTime, reqShift.startTime, reqShift.endTime)) {
          return NextResponse.json(
            { error: 'You have a pending shift offer on this day. Cancel it before swapping to a shift with an overlapping time.' },
            { status: 409 }
          )
        }
      }
    }

    // Block swap if the user has given away accepted split portions on their existing shift
    const hasGivenAwayPortion = allSplits.some(
      (sp) =>
        sp.status === 'accepted' &&
        sp.shiftId === existingOnDay.shiftId &&
        sp.offerorUserId === userId
    )
    if (hasGivenAwayPortion) {
      return NextResponse.json(
        { error: 'You cannot swap shifts while someone else is covering a portion of your current shift.' },
        { status: 409 }
      )
    }

    const oldIdx = schedule.assignments.findIndex((a) => a.shiftId === existingOnDay.shiftId)
    if (oldIdx >= 0) schedule.assignments[oldIdx] = { shiftId: existingOnDay.shiftId, residentName: null, userId: null }
    const oldPubIdx = schedule.publishedAssignments.findIndex((a) => a.shiftId === existingOnDay.shiftId)
    if (oldPubIdx >= 0) schedule.publishedAssignments[oldPubIdx] = { shiftId: existingOnDay.shiftId, residentName: null, userId: null }
  }

  // Full-coverage split acceptor swap: cancel their accepted splits on the old shift
  // and vacate its primary assignment so it becomes unassigned (not returned to offerors).
  if (fullCoverageSplitShiftId) {
    const splitsToCancel = allSplits.filter(
      (sp) => sp.shiftId === fullCoverageSplitShiftId &&
        sp.acceptorUserId === userId &&
        sp.status === 'accepted'
    )
    await Promise.all(splitsToCancel.map((sp) => updateShiftSplit(sp.id, { status: 'cancelled' })))
    const oldIdx = schedule.assignments.findIndex((a) => a.shiftId === fullCoverageSplitShiftId)
    if (oldIdx >= 0) schedule.assignments[oldIdx] = { shiftId: fullCoverageSplitShiftId, residentName: null, userId: null }
    const oldPubIdx = schedule.publishedAssignments.findIndex((a) => a.shiftId === fullCoverageSplitShiftId)
    if (oldPubIdx >= 0) schedule.publishedAssignments[oldPubIdx] = { shiftId: fullCoverageSplitShiftId, residentName: null, userId: null }
  }

  schedule.assignments[idx] = { shiftId, residentName: name, userId }
  const pubIdx = schedule.publishedAssignments.findIndex((a) => a.shiftId === shiftId)
  if (pubIdx >= 0) schedule.publishedAssignments[pubIdx] = { shiftId, residentName: name, userId }
  await setSchedule(schedule)
  return NextResponse.json(schedule)
}

export async function PATCH(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { shiftId, residentName, userId: residentUserId } = (await request.json()) as {
    shiftId: string
    residentName: string | null
    userId?: string | null
  }

  const schedule = await getSchedule()
  if (!schedule) {
    return NextResponse.json({ error: 'No schedule exists' }, { status: 404 })
  }

  const idx = schedule.assignments.findIndex((a: ShiftAssignment) => a.shiftId === shiftId)
  if (idx < 0) {
    return NextResponse.json({ error: 'Shift not in schedule' }, { status: 404 })
  }

  schedule.assignments[idx] = { shiftId, residentName, userId: residentUserId ?? null }
  schedule.isPublished = false
  schedule.publishedAt = null
  // publishedAssignments unchanged — admin must re-publish to make edit live
  await setSchedule(schedule)
  return NextResponse.json(schedule)
}
