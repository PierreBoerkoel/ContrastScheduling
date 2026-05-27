import { NextRequest, NextResponse } from 'next/server'

// Shift archiving is no longer needed — soft-deleted periods preserve all assignment history.
export async function GET(request: NextRequest) {
  const auth = request.headers.get('authorization')
  if (auth !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  return NextResponse.json({ processed: 0 })
}
