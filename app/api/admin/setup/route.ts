import { NextResponse } from 'next/server'
import { initDb } from '@/lib/db'

export async function POST(request: Request) {
  const secret = process.env.DB_RESET_SECRET
  const auth = request.headers.get('Authorization')
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  await initDb()
  return NextResponse.json({ ok: true, message: 'Database tables created.' })
}
