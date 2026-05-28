import { Resend } from 'resend'
import { clerkClient } from '@clerk/nextjs/server'

const resend = new Resend(process.env.RESEND_API_KEY)
const FROM = process.env.RESEND_FROM_EMAIL ?? 'Contrast Scheduling <onboarding@resend.dev>'
const BASE_URL = process.env.NEXT_PUBLIC_BASE_URL ?? 'https://contrast-scheduling.vercel.app'

async function getAllUserEmails(): Promise<string[]> {
  const client = await clerkClient()
  const { data: users } = await client.users.getUserList({ limit: 500 })
  return users
    .map((u) => u.emailAddresses[0]?.emailAddress)
    .filter((e): e is string => !!e)
}

function formatDate(d: string): string {
  return new Date(d + 'T00:00:00Z').toLocaleDateString('en-CA', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

export async function sendAvailabilityNotification(period: {
  name: string
  startDate: string
  endDate: string
}): Promise<void> {
  const emails = await getAllUserEmails()
  if (!emails.length) return

  const start = formatDate(period.startDate)
  const end = formatDate(period.endDate)

  const { error } = await resend.emails.send({
    from: FROM,
    to: emails,
    subject: `Availability open: ${period.name} (${start} – ${end})`,
    html: `<p>Hi,</p>
<p><strong>${period.name}</strong> (${start} – ${end}) is now open for availability submission.</p>
<p>Please log in and submit your preferences before the deadline.</p>
<p><a href="${BASE_URL}/availability">Submit availability →</a></p>`,
  })
  if (error) throw new Error(`Resend error: ${error.message}`)
}

export async function sendScheduleNotification(period: {
  name: string
  startDate: string
  endDate: string
}): Promise<void> {
  const emails = await getAllUserEmails()
  if (!emails.length) return

  const start = formatDate(period.startDate)
  const end = formatDate(period.endDate)

  const { error } = await resend.emails.send({
    from: FROM,
    to: emails,
    subject: `Schedule published: ${period.name} (${start} – ${end})`,
    html: `<p>Hi,</p>
<p>The schedule for <strong>${period.name}</strong> (${start} – ${end}) has been published.</p>
<p>Please log in to view your assigned shifts.</p>
<p><a href="${BASE_URL}/schedule">View schedule →</a></p>`,
  })
  if (error) throw new Error(`Resend error: ${error.message}`)
}
