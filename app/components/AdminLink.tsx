'use client'

import { useUser } from '@clerk/nextjs'
import Link from 'next/link'

export function AdminLink({ mobile }: { mobile?: boolean }) {
  const { user } = useUser()
  const isAdmin = (user?.publicMetadata as { role?: string })?.role === 'admin'
  if (!isAdmin) return null

  if (mobile) {
    return (
      <Link
        href="/admin"
        className="flex-1 text-center py-2 text-xs font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors"
      >
        Admin
      </Link>
    )
  }

  return (
    <Link
      href="/admin"
      className="hidden sm:block bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-700 transition-colors"
    >
      Admin
    </Link>
  )
}
