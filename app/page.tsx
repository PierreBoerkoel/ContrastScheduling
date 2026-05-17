import Link from 'next/link'

export default function Home() {
  return (
    <div className="max-w-3xl mx-auto px-4 py-16">
      <h1 className="text-3xl font-bold text-slate-800 mb-3">Contrast Coverage Scheduling</h1>
      <p className="text-slate-500 mb-12 text-lg">
        Resident call scheduling for contrast coverage across three clinic locations.
      </p>

      <div className="grid sm:grid-cols-2 gap-6">
        <Link
          href="/availability"
          className="group block bg-white rounded-xl border border-slate-200 shadow-sm p-6 hover:border-blue-400 hover:shadow-md transition-all"
        >
          <div className="text-2xl mb-3">📅</div>
          <h2 className="text-lg font-semibold text-slate-800 mb-1 group-hover:text-blue-600 transition-colors">
            Submit Availability
          </h2>
          <p className="text-sm text-slate-500">
            Enter your name and mark which shifts you are available to cover. You can update your
            submission at any time before the schedule is generated.
          </p>
        </Link>

        <Link
          href="/schedule"
          className="group block bg-white rounded-xl border border-slate-200 shadow-sm p-6 hover:border-blue-400 hover:shadow-md transition-all"
        >
          <div className="text-2xl mb-3">🗓️</div>
          <h2 className="text-lg font-semibold text-slate-800 mb-1 group-hover:text-blue-600 transition-colors">
            View Schedule
          </h2>
          <p className="text-sm text-slate-500">
            See the published call schedule. Shifts are distributed evenly based on submitted
            availability.
          </p>
        </Link>
      </div>

      <div className="mt-8 bg-blue-50 border border-blue-100 rounded-xl p-5">
        <h3 className="text-sm font-semibold text-blue-800 mb-1">Clinic locations</h3>
        <ul className="text-sm text-blue-700 space-y-0.5 list-disc list-inside">
          <li>BC Cancer Agency</li>
          <li>INITIO Medical Imaging</li>
          <li>UBC Hospital</li>
          <li>BC Women&apos;s Hospital</li>
        </ul>
      </div>
    </div>
  )
}
