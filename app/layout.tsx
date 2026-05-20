import type { Metadata } from 'next'
import { Geist } from 'next/font/google'
import Link from 'next/link'
import {
  ClerkProvider,
  Show,
  SignInButton,
  UserButton,
} from '@clerk/nextjs'
import OnboardingGuard from './components/OnboardingGuard'
import './globals.css'

const geist = Geist({ subsets: ['latin'], variable: '--font-geist' })

export const metadata: Metadata = {
  title: 'Contrast Call Scheduling',
  description: 'Resident contrast coverage scheduling for BC Cancer Agency, INITIO Medical Imaging, UBC Hospital, and BC Women\'s Hospital',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en" className={`${geist.variable} h-full`}>
        <body className="min-h-full flex flex-col bg-slate-50 font-sans antialiased">
          <header className="bg-white border-b border-slate-200 shadow-sm">
            <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between gap-3">
              <Link href="/" className="font-semibold text-slate-800 hover:text-blue-600 transition-colors shrink-0 text-base sm:text-lg">
                <span className="sm:hidden">Contrast Scheduling</span>
                <span className="hidden sm:inline">Contrast Call Scheduling</span>
              </Link>
              <nav className="flex items-center gap-3 sm:gap-6 text-sm font-medium">
                <Show when="signed-in">
                  <Link href="/profile" className="hidden sm:block text-slate-600 hover:text-blue-600 transition-colors">
                    My Profile
                  </Link>
                  <Link href="/availability" className="hidden sm:block text-slate-600 hover:text-blue-600 transition-colors">
                    Submit Availability
                  </Link>
                  <Link href="/schedule" className="hidden sm:block text-slate-600 hover:text-blue-600 transition-colors">
                    View Schedule
                  </Link>
                  <Link
                    href="/admin"
                    className="hidden sm:block bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-700 transition-colors"
                  >
                    Admin
                  </Link>
                  <UserButton />
                </Show>
                <Show when="signed-out">
                  <SignInButton mode="redirect">
                    <button className="bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-700 transition-colors">
                      Sign in
                    </button>
                  </SignInButton>
                </Show>
              </nav>
            </div>
            {/* Mobile sub-nav strip */}
            <Show when="signed-in">
              <div className="sm:hidden border-t border-slate-100">
                <div className="flex px-2 py-1">
                  <Link href="/profile" className="flex-1 text-center py-2 text-xs font-medium text-slate-600 hover:text-blue-600 hover:bg-slate-50 rounded-lg transition-colors">Profile</Link>
                  <Link href="/availability" className="flex-1 text-center py-2 text-xs font-medium text-slate-600 hover:text-blue-600 hover:bg-slate-50 rounded-lg transition-colors">Availability</Link>
                  <Link href="/schedule" className="flex-1 text-center py-2 text-xs font-medium text-slate-600 hover:text-blue-600 hover:bg-slate-50 rounded-lg transition-colors">Schedule</Link>
                  <Link href="/admin" className="flex-1 text-center py-2 text-xs font-medium text-blue-600 hover:text-blue-700 hover:bg-blue-50 rounded-lg transition-colors">Admin</Link>
                </div>
              </div>
            </Show>
          </header>
          <main className="flex-1">
            <OnboardingGuard>{children}</OnboardingGuard>
          </main>
          <footer className="border-t border-slate-200 bg-white py-4 px-4 text-center text-xs text-slate-400">
            <span className="inline-flex flex-wrap justify-center gap-x-2 gap-y-1">
              <span>BC Cancer Agency</span>
              <span aria-hidden="true">&middot;</span>
              <span>INITIO Medical Imaging</span>
              <span aria-hidden="true">&middot;</span>
              <span>UBC Hospital</span>
              <span aria-hidden="true">&middot;</span>
              <span>BC Women&apos;s Hospital</span>
            </span>
          </footer>
        </body>
      </html>
    </ClerkProvider>
  )
}
