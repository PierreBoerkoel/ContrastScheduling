'use client'

import { useUser } from '@clerk/nextjs'
import { useRouter, usePathname } from 'next/navigation'
import { useEffect } from 'react'

const SKIP_PATHS = ['/', '/sign-in', '/sign-up', '/onboarding']

export default function OnboardingGuard({ children }: { children: React.ReactNode }) {
  const { user, isLoaded } = useUser()
  const router = useRouter()
  const pathname = usePathname()

  useEffect(() => {
    if (!isLoaded) return
    if (!user) return
    if (SKIP_PATHS.some((p) => pathname === p || pathname.startsWith(p + '/'))) return
    if (!user.firstName && !user.lastName) {
      router.replace('/onboarding')
    }
  }, [isLoaded, user, pathname, router])

  return <>{children}</>
}
