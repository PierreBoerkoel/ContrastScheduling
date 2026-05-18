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
            <div className="max-w-6xl mx-auto px-4 py-3 flex items-center justify-between">
              <Link href="/" className="text-lg font-semibold text-slate-800 hover:text-blue-600 transition-colors">
                Contrast Call Scheduling
              </Link>
              <nav className="flex items-center gap-6 text-sm font-medium">
                <Show when="signed-in">
                  <Link href="/profile" className="text-slate-600 hover:text-blue-600 transition-colors">
                    My Profile
                  </Link>
                  <Link href="/availability" className="text-slate-600 hover:text-blue-600 transition-colors">
                    Submit Availability
                  </Link>
                  <Link href="/schedule" className="text-slate-600 hover:text-blue-600 transition-colors">
                    View Schedule
                  </Link>
                  <Link
                    href="/admin"
                    className="bg-blue-600 text-white px-3 py-1.5 rounded-md hover:bg-blue-700 transition-colors"
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
          </header>
          <main className="flex-1">
            <OnboardingGuard>{children}</OnboardingGuard>
          </main>
          <footer className="border-t border-slate-200 bg-white py-4 text-center text-xs text-slate-400">
            BC Cancer Agency &middot; INITIO Medical Imaging &middot; UBC Hospital &middot; BC Women&apos;s Hospital &middot; v5
          </footer>
        </body>
      </html>
    </ClerkProvider>
  )
}
