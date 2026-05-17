'use client'

import { useState } from 'react'
import { useUser } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'

export default function OnboardingPage() {
  const { user, isLoaded } = useUser()
  const router = useRouter()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  if (!isLoaded) return null

  // Already has a name — skip onboarding
  if (user?.firstName || user?.lastName) {
    router.replace('/')
    return null
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!firstName.trim() || !lastName.trim()) {
      setError('Both fields are required.')
      return
    }
    setSaving(true)
    setError('')
    try {
      await user!.update({ firstName: firstName.trim(), lastName: lastName.trim() })
      router.replace('/')
    } catch {
      setError('Something went wrong. Please try again.')
      setSaving(false)
    }
  }

  return (
    <div className="max-w-md mx-auto px-4 py-16">
      <h1 className="text-2xl font-bold text-slate-800 mb-2">Complete your profile</h1>
      <p className="text-slate-500 text-sm mb-8">
        Your name will appear on the schedule and swap requests.
      </p>
      <form onSubmit={handleSubmit} className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
        <label className="flex flex-col gap-1 text-sm text-slate-600">
          First name
          <input
            type="text"
            value={firstName}
            onChange={(e) => setFirstName(e.target.value)}
            autoFocus
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>
        <label className="flex flex-col gap-1 text-sm text-slate-600">
          Last name
          <input
            type="text"
            value={lastName}
            onChange={(e) => setLastName(e.target.value)}
            className="border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </label>
        {error && <p className="text-sm text-red-500">{error}</p>}
        <button
          type="submit"
          disabled={saving}
          className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          {saving ? 'Saving…' : 'Save and continue'}
        </button>
      </form>
    </div>
  )
}
