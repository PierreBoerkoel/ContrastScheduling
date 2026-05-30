'use client'

import { useEffect, useState } from 'react'
import { useUser } from '@clerk/nextjs'
import Link from 'next/link'
import type { Shift } from '@/lib/types'

interface DashboardData {
  upcomingShifts: Shift[]
  openPeriods: { id: string; name: string; startDate: string; endDate: string; hasSubmitted: boolean }[]
  pendingCounts: { swaps: number; splits: number }
}

function formatShiftDate(d: string) {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(d + 'T00:00:00Z'))
}

function LoggedOutLanding() {
  const [hasCoordinator, setHasCoordinator] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [sent, setSent] = useState(false)
  const [contactError, setContactError] = useState('')

  useEffect(() => {
    fetch('/api/coordinator')
      .then((r) => r.json())
      .then((d) => setHasCoordinator(!!d.hasCoordinator))
      .catch(() => {})
  }, [])

  async function sendMessage(e: React.FormEvent) {
    e.preventDefault()
    setSending(true)
    setContactError('')
    try {
      const res = await fetch('/api/contact', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, email, message }),
      })
      if (!res.ok) {
        const d = await res.json()
        setContactError(d.error ?? 'Failed to send message')
      } else {
        setSent(true)
      }
    } catch {
      setContactError('Something went wrong. Please try again.')
    } finally {
      setSending(false)
    }
  }

  return (
    <div className="max-w-2xl mx-auto px-6 py-16 sm:py-24 w-full">
      <div className="mb-12 text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-blue-600 mb-6 shadow-md">
          <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
          </svg>
        </div>
        <h1 className="text-3xl font-bold text-slate-800 mb-3 tracking-tight">Contrast Coverage</h1>
        <p className="text-slate-500 text-base max-w-md mx-auto leading-relaxed">
          Coordinating after-hours contrast reaction coverage for UBC Radiology Residents.
        </p>
      </div>

      <div className="grid sm:grid-cols-2 gap-4 items-start">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6 flex flex-col">
          <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center mb-4">
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
          <h2 className="text-base font-semibold text-slate-800 mb-1.5">Residents</h2>
          <p className="text-sm text-slate-500 leading-relaxed flex-1">
            Submit your availability, view your assigned shifts, and manage splits and swaps — all in one place.
          </p>
          <Link href="/sign-in" className="mt-4 text-sm font-medium text-blue-600 hover:text-blue-700 transition-colors">
            Sign in →
          </Link>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-6">
          <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center mb-4">
            <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
            </svg>
          </div>
          <h2 className="text-base font-semibold text-slate-800 mb-1.5">Imaging Clinics</h2>
          <p className="text-sm text-slate-500 leading-relaxed mb-4">
            Interested in on-site contrast reaction monitoring coverage from UBC Radiology Clinical Associates? Send us a message.
          </p>

          {!hasCoordinator ? (
            <p className="text-sm text-slate-400">Contact information coming soon</p>
          ) : sent ? (
            <p className="text-sm text-green-600 font-medium">Message sent — we'll be in touch shortly.</p>
          ) : (
            <form onSubmit={sendMessage} className="space-y-2.5">
              <input
                type="text"
                placeholder="Your name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <input
                type="email"
                placeholder="Your email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <textarea
                placeholder="Your message"
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                required
                rows={3}
                className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent resize-none"
              />
              {contactError && <p className="text-xs text-red-500">{contactError}</p>}
              <button
                type="submit"
                disabled={sending}
                className="w-full bg-blue-600 text-white text-sm font-medium py-2 rounded-lg hover:bg-blue-700 transition-colors disabled:opacity-50"
              >
                {sending ? 'Sending…' : 'Send message'}
              </button>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

function Dashboard({ firstName }: { firstName: string }) {
  const [data, setData] = useState<DashboardData | null>(null)

  useEffect(() => {
    fetch('/api/dashboard')
      .then((r) => r.json())
      .then(setData)
      .catch(() => {})
  }, [])

  const pendingTotal = (data?.pendingCounts.swaps ?? 0) + (data?.pendingCounts.splits ?? 0)

  return (
    <div className="max-w-2xl mx-auto px-4 py-8 sm:py-12 w-full">
      <h1 className="text-xl font-semibold text-slate-800 mb-6">
        Welcome back, {firstName}
      </h1>

      <div className="grid sm:grid-cols-3 gap-4">
        {/* Upcoming Shifts */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-col">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Upcoming Shifts</h2>
          <div className="flex-1">
            {!data ? (
              <p className="text-sm text-slate-400">Loading…</p>
            ) : data.upcomingShifts.length > 0 ? (
              <ul className="space-y-2.5">
                {data.upcomingShifts.map((s) => (
                  <li key={s.id}>
                    <div className="text-sm font-medium text-slate-700">{formatShiftDate(s.date)}</div>
                    <div className="text-xs text-slate-500">{s.clinic}{s.startTime ? ` · ${s.startTime}–${s.endTime}` : ''}</div>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">No upcoming shifts</p>
            )}
          </div>
          <Link href="/schedule" className="mt-3 text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors">
            View schedule →
          </Link>
        </div>

        {/* Availability */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-col">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Availability</h2>
          <div className="flex-1">
            {!data ? (
              <p className="text-sm text-slate-400">Loading…</p>
            ) : data.openPeriods.length > 0 ? (
              <ul className="space-y-2.5">
                {data.openPeriods.map((p) => (
                  <li key={p.id}>
                    <div className="text-sm font-medium text-slate-700">{p.name}</div>
                    {p.hasSubmitted ? (
                      <div className="text-xs text-green-600">Submitted</div>
                    ) : (
                      <div className="text-xs text-amber-600">Not yet submitted</div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">No open periods</p>
            )}
          </div>
          <Link href="/availability" className="mt-3 text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors">
            Submit availability →
          </Link>
        </div>

        {/* Open Offers */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 flex flex-col">
          <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">Open Offers</h2>
          <div className="flex-1">
            {!data ? (
              <p className="text-sm text-slate-400">Loading…</p>
            ) : pendingTotal > 0 ? (
              <ul className="space-y-1.5">
                {data.pendingCounts.swaps > 0 && (
                  <li className="text-sm text-slate-700">
                    <span className="font-medium">{data.pendingCounts.swaps}</span> shift offer{data.pendingCounts.swaps !== 1 ? 's' : ''}
                  </li>
                )}
                {data.pendingCounts.splits > 0 && (
                  <li className="text-sm text-slate-700">
                    <span className="font-medium">{data.pendingCounts.splits}</span> split offer{data.pendingCounts.splits !== 1 ? 's' : ''}
                  </li>
                )}
              </ul>
            ) : (
              <p className="text-sm text-slate-400">No open offers</p>
            )}
          </div>
          <Link href="/schedule" className="mt-3 text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors">
            View schedule →
          </Link>
        </div>
      </div>
    </div>
  )
}

export default function Home() {
  const { user, isLoaded, isSignedIn } = useUser()

  if (!isLoaded) return null

  if (isSignedIn) {
    const firstName = user.firstName ?? user.fullName?.split(' ')[0] ?? 'there'
    return <Dashboard firstName={firstName} />
  }

  return <LoggedOutLanding />
}
