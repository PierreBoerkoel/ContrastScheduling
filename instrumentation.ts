export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { initDb } = await import('./lib/db')
    await initDb().catch((e) => console.error('initDb failed during instrumentation (will retry on first request):', e))
  }
}
