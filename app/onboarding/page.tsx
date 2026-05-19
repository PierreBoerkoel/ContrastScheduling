'use client'

import { useState } from 'react'
import { useUser } from '@clerk/nextjs'
import { useRouter } from 'next/navigation'

export default function OnboardingPage() {
  const { user, isLoaded } = useUser()
  const router = useRouter()
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [middleName, setMiddleName] = useState('')
  const [step, setStep] = useState<'name' | 'middle'>('name')
  const [saving, setSaving] = useState(false)
  const [checking, setChecking] = useState(false)
  const [error, setError] = useState('')

  if (!isLoaded) return null

  // Already has a name — skip onboarding
  if (user?.firstName || user?.lastName) {
    router.replace('/')
    return null
  }

  async function save(fn: string, ln: string) {
    setSaving(true)
    setError('')
    try {
      await user!.update({ firstName: fn, lastName: ln })
      router.replace('/')
    } catch {
      setError('Something went wrong. Please try again.')
      setSaving(false)
    }
  }

  async function handleNameSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!firstName.trim() || !lastName.trim()) {
      setError('Both fields are required.')
      return
    }
    setChecking(true)
    setError('')
    try {
      const res = await fetch('/api/check-name', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ firstName: firstName.trim(), lastName: lastName.trim() }),
      })
      const data = await res.json()
      if (data.collision) {
        setStep('middle')
        setChecking(false)
      } else {
        await save(firstName.trim(), lastName.trim())
      }
    } catch {
      setError('Something went wrong. Please try again.')
      setChecking(false)
    }
  }

  async function handleMiddleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!middleName.trim()) {
      setError('A middle name or initial is required.')
      return
    }
    await save(`${firstName.trim()} ${middleName.trim()}`, lastName.trim())
  }

  if (step === 'middle') {
    return (
      <div className="max-w-md mx-auto px-4 py-16">
        <h1 className="text-2xl font-bold text-slate-800 mb-2">One more thing</h1>
        <p className="text-slate-500 text-sm mb-8">
          Another resident named <strong>{firstName.trim()} {lastName.trim()}</strong> is already in the system.
          Please add a middle name or initial so you can be told apart on the schedule.
        </p>
        <form onSubmit={handleMiddleSubmit} className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
          <div className="text-sm text-slate-500 space-y-1">
            <p>Your name will appear as:</p>
            <p className="font-medium text-slate-800">
              {firstName.trim()} {middleName.trim() || '…'} {lastName.trim()}
            </p>
          </div>
          <label className="flex flex-col gap-1 text-sm text-slate-600">
            Middle name or initial
            <input
              type="text"
              value={middleName}
              onChange={(e) => setMiddleName(e.target.value)}
              autoFocus
              placeholder="e.g. M. or Marie"
              className="border border-slate-300 rounded-lg px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </label>
          {error && <p className="text-sm text-red-500">{error}</p>}
          <div className="flex gap-3">
            <button
              type="submit"
              disabled={saving}
              className="flex-1 bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
            >
              {saving ? 'Saving…' : 'Save and continue'}
            </button>
            <button
              type="button"
              onClick={() => { setStep('name'); setError('') }}
              className="px-4 py-2.5 rounded-lg text-sm text-slate-500 hover:bg-slate-100 transition-colors"
            >
              Back
            </button>
          </div>
        </form>
      </div>
    )
  }

  return (
    <div className="max-w-md mx-auto px-4 py-16">
      <h1 className="text-2xl font-bold text-slate-800 mb-2">Complete your profile</h1>
      <p className="text-slate-500 text-sm mb-8">
        Your name will appear on the schedule and swap requests.
      </p>
      <form onSubmit={handleNameSubmit} className="bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
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
          disabled={saving || checking}
          className="w-full bg-blue-600 text-white py-2.5 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-40 transition-colors"
        >
          {checking ? 'Checking…' : saving ? 'Saving…' : 'Save and continue'}
        </button>
      </form>
    </div>
  )
}
