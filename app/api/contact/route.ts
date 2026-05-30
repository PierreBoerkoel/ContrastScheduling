import { NextResponse } from 'next/server'
import { clerkClient } from '@clerk/nextjs/server'
import { Resend } from 'resend'

const resend = new Resend(process.env.RESEND_API_KEY)
const FROM = process.env.RESEND_FROM_EMAIL ?? 'CA Shift Scheduling <onboarding@resend.dev>'

export async function POST(request: Request) {
  const { name, email, message } = (await request.json()) as {
    name?: string
    email?: string
    message?: string
  }

  if (!name?.trim() || !email?.trim() || !message?.trim()) {
    return NextResponse.json({ error: 'All fields are required' }, { status: 400 })
  }

  const client = await clerkClient()
  const { data: users } = await client.users.getUserList({ limit: 500 })
  const coordinator = users.find(
    (u) => (u.publicMetadata as { coordinator?: boolean })?.coordinator === true
  )
  const coordinatorEmail = coordinator?.emailAddresses[0]?.emailAddress

  if (!coordinatorEmail) {
    return NextResponse.json({ error: 'No coordinator is currently available' }, { status: 503 })
  }

  const { error } = await resend.emails.send({
    from: FROM,
    to: coordinatorEmail,
    replyTo: email.trim(),
    subject: `Home page inquiry from ${name.trim()}`,
    html: `<p><strong>Name:</strong> ${name.trim()}</p>
<p><strong>Email:</strong> ${email.trim()}</p>
<p><strong>Message:</strong></p>
<p>${message.trim().replace(/\n/g, '<br>')}</p>`,
  })

  if (error) return NextResponse.json({ error: 'Failed to send message' }, { status: 500 })
  return NextResponse.json({ ok: true })
}
