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
            Interested in on-site contrast reaction monitoring coverage by UBC Radiology Residents? Send us a message.
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
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-8 sm:py-12 w-full">
      <h1 className="text-2xl font-semibold text-slate-800 mb-8">
        Welcome back, {firstName}
      </h1>

      {/* Desktop: shifts left (wider), availability + offers right (stacked). Mobile: single column. */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">

        {/* Upcoming Shifts — spans 2 cols on desktop */}
        <div className="sm:col-span-2 bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
            <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center shrink-0">
              <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
              </svg>
            </div>
            <h2 className="text-sm font-semibold text-slate-700">Upcoming Shifts</h2>
          </div>
          <div className="flex-1 px-5 py-4">
            {!data ? (
              <p className="text-sm text-slate-400">Loading…</p>
            ) : data.upcomingShifts.length > 0 ? (
              <ul className="divide-y divide-slate-100">
                {data.upcomingShifts.map((s) => (
                  <li key={s.id} className="py-3 first:pt-0 last:pb-0 flex items-center justify-between gap-4">
                    <div>
                      <div className="text-sm font-medium text-slate-800">{formatShiftDate(s.date)}</div>
                      <div className="text-sm text-slate-500 mt-0.5">{s.clinic}</div>
                    </div>
                    {s.startTime && (
                      <div className="text-sm text-slate-500 shrink-0 tabular-nums">{s.startTime}–{s.endTime}</div>
                    )}
                  </li>
                ))}
              </ul>
            ) : (
              <div className="flex flex-col items-center justify-center py-8 text-center">
                <svg className="w-8 h-8 text-slate-200 mb-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <p className="text-sm text-slate-400">No upcoming shifts</p>
              </div>
            )}
          </div>
          <div className="px-5 py-3 border-t border-slate-100 bg-slate-50">
            <Link href="/schedule" className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors">
              View full schedule →
            </Link>
          </div>
        </div>

        {/* Right column: Availability + Open Offers stacked */}
        <div className="flex flex-col gap-4">

          {/* Availability */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-green-50 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                </svg>
              </div>
              <h2 className="text-sm font-semibold text-slate-700">Availability</h2>
            </div>
            <div className="flex-1 px-5 py-4">
              {!data ? (
                <p className="text-sm text-slate-400">Loading…</p>
              ) : data.openPeriods.length > 0 ? (
                <ul className="space-y-3">
                  {data.openPeriods.map((p) => (
                    <li key={p.id} className="flex items-center justify-between gap-2">
                      <span className="text-sm text-slate-700 font-medium">{p.name}</span>
                      {p.hasSubmitted ? (
                        <span className="text-xs font-medium text-green-600 bg-green-50 px-2 py-0.5 rounded-full shrink-0">Submitted</span>
                      ) : (
                        <span className="text-xs font-medium text-amber-600 bg-amber-50 px-2 py-0.5 rounded-full shrink-0">Pending</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-sm text-slate-400">No open periods</p>
              )}
            </div>
            <div className="px-5 py-3 border-t border-slate-100 bg-slate-50">
              <Link href="/availability" className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors">
                Submit availability →
              </Link>
            </div>
          </div>

          {/* Open Offers */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm flex flex-col overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7h12m0 0l-4-4m4 4l-4 4m0 6H4m0 0l4 4m-4-4l4-4" />
                </svg>
              </div>
              <h2 className="text-sm font-semibold text-slate-700">Open Offers</h2>
            </div>
            <div className="flex-1 px-5 py-4">
              {!data ? (
                <p className="text-sm text-slate-400">Loading…</p>
              ) : pendingTotal > 0 ? (
                <ul className="space-y-2">
                  {data.pendingCounts.swaps > 0 && (
                    <li className="flex items-center justify-between">
                      <span className="text-sm text-slate-600">Shift offers</span>
                      <span className="text-sm font-semibold text-slate-800">{data.pendingCounts.swaps}</span>
                    </li>
                  )}
                  {data.pendingCounts.splits > 0 && (
                    <li className="flex items-center justify-between">
                      <span className="text-sm text-slate-600">Split offers</span>
                      <span className="text-sm font-semibold text-slate-800">{data.pendingCounts.splits}</span>
                    </li>
                  )}
                </ul>
              ) : (
                <p className="text-sm text-slate-400">No open offers</p>
              )}
            </div>
            <div className="px-5 py-3 border-t border-slate-100 bg-slate-50">
              <Link href="/schedule" className="text-xs font-medium text-blue-600 hover:text-blue-700 transition-colors">
                View schedule →
              </Link>
            </div>
          </div>

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
