import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import {
  getShifts, getSubmissions, getPeriod, getSchedulingPeriods,
  updatePeriodDraft, publishPeriod, updatePeriodPublishedAssignments,
  getAllPublishedAssignments, getShiftSplits, getSwapRequests,
  updateShiftSplit, getAllResidentPreferences,
} from '@/lib/db'
import { generateSchedule } from '@/lib/scheduler'
import { computeCoverageSegments } from '@/lib/types'
import type { ShiftAssignment } from '@/lib/types'

async function requireAdmin() {
  const user = await currentUser()
  return (user?.publicMetadata as { role?: string })?.role === 'admin'
}

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  // Return all periods so clients can read per-period draft + published state
  const periods = await getSchedulingPeriods()
  return NextResponse.json(periods)
}

export async function POST(request: Request) {
  if (!await requireAdmin()) {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const body = await request.json() as { action: 'generate' | 'publish'; periodId?: string }
  const { action, periodId } = body

  if (!periodId) return NextResponse.json({ error: 'periodId required' }, { status: 400 })

  const period = await getPeriod(periodId)
  if (!period) return NextResponse.json({ error: 'Period not found' }, { status: 404 })

  if (action === 'generate') {
    const [allShifts, allSubmissions, prefsByUserId] = await Promise.all([
      getShifts(), getSubmissions(), getAllResidentPreferences(),
    ])
    const shifts = allShifts.filter((s) => s.periodId === periodId)
    const submissions = allSubmissions.filter((s) => s.periodId === periodId)
    const newAssignments = generateSchedule(shifts, submissions, prefsByUserId)
    const generatedAt = new Date().toISOString()
    await updatePeriodDraft(periodId, newAssignments, generatedAt)
    return NextResponse.json({ ...period, assignments: newAssignments, generatedAt })
  }

  if (action === 'publish') {
    const { publishedAt, updatedAt } = await publishPeriod(periodId, period.assignments)
    return NextResponse.json({ ...period, publishedAssignments: period.assignments, publishedAt, updatedAt })
  }

  return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
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

  // Find the period this shift belongs to
  const allShifts = await getShifts()
  const shift = allShifts.find((s) => s.id === shiftId)
  if (!shift?.periodId) return NextResponse.json({ error: 'Shift not found' }, { status: 404 })

  const period = await getPeriod(shift.periodId)
  if (!period) return NextResponse.json({ error: 'Period not found' }, { status: 404 })

  const idx = period.assignments.findIndex((a) => a.shiftId === shiftId)
  if (idx < 0) return NextResponse.json({ error: 'Shift not in draft' }, { status: 404 })

  const updated = [...period.assignments]
  updated[idx] = { shiftId, residentName, userId: residentUserId ?? null }
  await updatePeriodDraft(shift.periodId, updated, period.generatedAt ?? null)
  return NextResponse.json({ ok: true })
}

export async function PUT(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { shiftId, swap } = (await request.json()) as { shiftId: string; swap?: boolean }

  // Find the period this shift belongs to and verify it's published
  const allShifts = await getShifts()
  const shift = allShifts.find((s) => s.id === shiftId)
  if (!shift?.periodId) return NextResponse.json({ error: 'Shift not found' }, { status: 404 })

  const period = await getPeriod(shift.periodId)
  if (!period?.publishedAt) {
    return NextResponse.json({ error: 'No published schedule' }, { status: 400 })
  }

  const published = period.publishedAssignments
  const idx = published.findIndex((a: ShiftAssignment) => a.shiftId === shiftId)
  if (idx < 0) return NextResponse.json({ error: 'Shift not in schedule' }, { status: 404 })
  if (published[idx].residentName !== null) {
    return NextResponse.json({ error: 'Shift is already assigned' }, { status: 409 })
  }

  const user = await currentUser()
  const name = user?.fullName ?? [user?.firstName, user?.lastName].filter(Boolean).join(' ') ?? ''
  if (!name) return NextResponse.json({ error: 'Could not determine your name' }, { status: 400 })

  const targetDate = shiftId.split('|')[0]
  const existingOnDay = published.find(
    (a) => a.shiftId !== shiftId && a.shiftId.startsWith(targetDate + '|') && a.userId === userId
  )

  const [allSplits, allSwaps] = await Promise.all([getShiftSplits(), getSwapRequests()])
  const shiftById = Object.fromEntries(allShifts.map((s) => [s.id, s]))

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

  // Check if the user fully covers another shift as a split acceptor on this day
  let fullCoverageSplitShiftId: string | null = null
  const myAcceptedSplitsOnDay = allSplits.filter(
    (sp) => sp.status === 'accepted' && sp.acceptorUserId === userId &&
      sp.shiftId.split('|')[0] === targetDate
  )
  if (myAcceptedSplitsOnDay.length > 0) {
    const shiftIdsOnDay = [...new Set(myAcceptedSplitsOnDay.map((sp) => sp.shiftId))]
    for (const sid of shiftIdsOnDay) {
      const parentShift = shiftById[sid]
      if (!parentShift?.startTime || !parentShift?.endTime) continue
      // Look up the parent assignment from the relevant period's published assignments
      const allPublished = await getAllPublishedAssignments()
      const parentAssignment = allPublished.find((a) => a.shiftId === sid)
      const segments = computeCoverageSegments(
        parentShift, parentAssignment?.residentName ?? null,
        allSplits.filter((sp) => sp.shiftId === sid), parentAssignment?.userId ?? null
      )
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

  if (!fullCoverageSplitShiftId && newShift?.startTime && newShift?.endTime) {
    for (const sp of allSplits) {
      if (sp.status !== 'accepted') continue
      if (sp.acceptorUserId !== userId) continue
      if (sp.shiftId.split('|')[0] !== targetDate) continue
      if (overlaps(newShift.startTime, newShift.endTime, sp.offeredStart, sp.offeredEnd)) {
        return NextResponse.json({ error: 'You are already scheduled on this day' }, { status: 409 })
      }
    }
  }

  if (existingOnDay && !userFullyGivenAway && !swap) {
    return NextResponse.json({ error: 'You are already scheduled on this day' }, { status: 409 })
  }

  // Helper: update a single assignment in a period's published assignments
  async function patchPublished(pShiftId: string, assignment: ShiftAssignment) {
    const pShift = shiftById[pShiftId]
    if (!pShift?.periodId) return
    const p = await getPeriod(pShift.periodId)
    if (!p) return
    const newPub = p.publishedAssignments.map((a) => a.shiftId === pShiftId ? assignment : a)
    await updatePeriodPublishedAssignments(pShift.periodId, newPub)
  }

  if (existingOnDay && !userFullyGivenAway && swap) {
    if (newShift?.startTime && newShift?.endTime) {
      for (const sp of allSplits) {
        if (sp.status !== 'pending') continue
        if (sp.offerorUserId !== userId) continue
        if (sp.shiftId.split('|')[0] !== targetDate) continue
        if (overlaps(newShift.startTime, newShift.endTime, sp.offeredStart, sp.offeredEnd)) {
          return NextResponse.json(
            { error: `You have a pending portion offer (${sp.offeredStart}–${sp.offeredEnd}) on this day. Cancel it before swapping.` },
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
            { error: 'You have a pending shift offer on this day. Cancel it before swapping.' },
            { status: 409 }
          )
        }
      }
    }
    const hasGivenAwayPortion = allSplits.some(
      (sp) => sp.status === 'accepted' && sp.shiftId === existingOnDay.shiftId && sp.offerorUserId === userId
    )
    if (hasGivenAwayPortion) {
      return NextResponse.json(
        { error: 'You cannot swap shifts while someone else is covering a portion of your current shift.' },
        { status: 409 }
      )
    }
    await patchPublished(existingOnDay.shiftId, { shiftId: existingOnDay.shiftId, residentName: null, userId: null })
  }

  if (fullCoverageSplitShiftId) {
    const splitsToCancel = allSplits.filter(
      (sp) => sp.shiftId === fullCoverageSplitShiftId && sp.acceptorUserId === userId && sp.status === 'accepted'
    )
    await Promise.all(splitsToCancel.map((sp) => updateShiftSplit(sp.id, { status: 'cancelled' })))
    await patchPublished(fullCoverageSplitShiftId, { shiftId: fullCoverageSplitShiftId, residentName: null, userId: null })
  }

  // Assign the target shift
  const newPub = period.publishedAssignments.map((a, i) =>
    i === idx ? { shiftId, residentName: name, userId } : a
  )
  await updatePeriodPublishedAssignments(shift.periodId, newPub)
  return NextResponse.json({ ok: true })
}
