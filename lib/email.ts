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

async function getUserEmail(userId: string): Promise<string | null> {
  const client = await clerkClient()
  const user = await client.users.getUser(userId)
  return user.emailAddresses[0]?.emailAddress ?? null
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

export async function sendSwapAcceptedNotification(params: {
  requestorUserId: string
  date: string
  clinic: string
  acceptorName: string
}): Promise<void> {
  const email = await getUserEmail(params.requestorUserId)
  if (!email) return

  const date = formatDate(params.date)
  const { error } = await resend.emails.send({
    from: FROM,
    to: email,
    subject: `Your shift offer has been accepted`,
    html: `<p>Hi,</p>
<p>Your shift offer for <strong>${params.clinic}</strong> on <strong>${date}</strong> has been accepted by <strong>${params.acceptorName}</strong>.</p>
<p>This shift has been transferred — you are no longer assigned to it.</p>
<p><a href="${BASE_URL}/schedule">View schedule →</a></p>`,
  })
  if (error) throw new Error(`Resend error: ${error.message}`)
}

export async function sendSplitAcceptedNotification(params: {
  offerorUserId: string
  date: string
  clinic: string
  offeredStart: string
  offeredEnd: string
  acceptorName: string
}): Promise<void> {
  const email = await getUserEmail(params.offerorUserId)
  if (!email) return

  const date = formatDate(params.date)
  const { error } = await resend.emails.send({
    from: FROM,
    to: email,
    subject: `Your shift split has been accepted`,
    html: `<p>Hi,</p>
<p>Your split offer for <strong>${params.clinic}</strong> on <strong>${date}</strong> (${params.offeredStart}–${params.offeredEnd}) has been accepted by <strong>${params.acceptorName}</strong>.</p>
<p><a href="${BASE_URL}/schedule">View schedule →</a></p>`,
  })
  if (error) throw new Error(`Resend error: ${error.message}`)
}
