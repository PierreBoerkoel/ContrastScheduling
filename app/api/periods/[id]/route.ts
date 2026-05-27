import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { deleteSchedulingPeriod } from '@/lib/db'

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const user = await currentUser()
  if ((user?.publicMetadata as { role?: string })?.role !== 'admin') {
    return NextResponse.json({ error: 'Admin access required' }, { status: 403 })
  }

  const { id } = await params
  await deleteSchedulingPeriod(id)
  return NextResponse.json({ ok: true })
}
