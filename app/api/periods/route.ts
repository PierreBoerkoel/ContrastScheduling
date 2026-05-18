import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { getSchedulingPeriods, addSchedulingPeriod } from '@/lib/db'

export async function GET() {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  return NextResponse.json(await getSchedulingPeriods())
}

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await currentUser()
  if ((user?.publicMetadata as { role?: string })?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { name, startDate, endDate } = (await request.json()) as {
    name: string
    startDate: string
    endDate: string
  }

  if (!name?.trim() || !startDate || !endDate || startDate > endDate) {
    return NextResponse.json({ error: 'Invalid period data' }, { status: 400 })
  }

  const period = await addSchedulingPeriod({ name: name.trim(), startDate, endDate })
  return NextResponse.json(period, { status: 201 })
}
