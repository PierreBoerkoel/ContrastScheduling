import { NextResponse } from 'next/server'
import { initDb } from '@/lib/db'

export async function POST() {
  await initDb()
  return NextResponse.json({ ok: true, message: 'Database tables created.' })
}
