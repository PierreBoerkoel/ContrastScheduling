import { NextResponse } from 'next/server'
import { getSubmissions, upsertSubmission } from '@/lib/db'
import type { AvailabilitySubmission } from '@/lib/types'

export async function GET() {
  return NextResponse.json(await getSubmissions())
}

export async function POST(request: Request) {
  const { residentName, availableShiftIds } = (await request.json()) as {
    residentName: string
    availableShiftIds: string[]
  }

  if (!residentName?.trim()) {
    return NextResponse.json({ error: 'Resident name is required' }, { status: 400 })
  }

  const submission: AvailabilitySubmission = {
    id: crypto.randomUUID(),
    residentName: residentName.trim(),
    submittedAt: new Date().toISOString(),
    availableShiftIds,
  }

  await upsertSubmission(submission)
  return NextResponse.json(submission)
}
