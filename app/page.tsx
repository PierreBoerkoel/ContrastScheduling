import Link from 'next/link'

export default function Home() {
  return (
    <div className="min-h-screen bg-gradient-to-b from-slate-50 to-white flex items-center">
      <div className="max-w-2xl mx-auto px-6 py-20 w-full">

        <div className="mb-12 text-center">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-blue-600 mb-6 shadow-md">
            <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <h1 className="text-3xl font-bold text-slate-800 mb-3 tracking-tight">
            Contrast Coverage Scheduling
          </h1>
          <p className="text-slate-500 text-base max-w-md mx-auto leading-relaxed">
            Resident call scheduling for contrast coverage at BC Cancer, INITIO, UBC, and BC Women&apos;s.
          </p>
        </div>

        <div className="grid sm:grid-cols-2 gap-4">
          <Link
            href="/availability"
            className="group bg-white rounded-2xl border border-slate-200 shadow-sm p-6 hover:border-blue-300 hover:shadow-md transition-all duration-200"
          >
            <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center mb-4 group-hover:bg-blue-100 transition-colors">
              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
              </svg>
            </div>
            <h2 className="text-base font-semibold text-slate-800 mb-1.5 group-hover:text-blue-600 transition-colors">
              Submit Availability
            </h2>
            <p className="text-sm text-slate-500 leading-relaxed">
              Mark which shifts you&apos;re available to cover for the upcoming block. You can update your submission any time before the schedule is generated.
            </p>
          </Link>

          <Link
            href="/schedule"
            className="group bg-white rounded-2xl border border-slate-200 shadow-sm p-6 hover:border-blue-300 hover:shadow-md transition-all duration-200"
          >
            <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center mb-4 group-hover:bg-blue-100 transition-colors">
              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 10h16M4 14h16M4 18h16" />
              </svg>
            </div>
            <h2 className="text-base font-semibold text-slate-800 mb-1.5 group-hover:text-blue-600 transition-colors">
              View Schedule
            </h2>
            <p className="text-sm text-slate-500 leading-relaxed">
              See the published call schedule and claim any uncovered shifts. Splits and swaps can be arranged directly from the schedule view.
            </p>
          </Link>
        </div>

      </div>
    </div>
  )
}
