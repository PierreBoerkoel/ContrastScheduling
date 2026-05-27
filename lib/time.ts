export function shiftStarted(shiftDate: string, startTime?: string | null): boolean {
  const now = new Date()
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Vancouver',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })
  const parts = fmt.formatToParts(now)
  const get = (t: string) => parts.find((p) => p.type === t)!.value
  const nowDate = `${get('year')}-${get('month')}-${get('day')}`
  if (nowDate > shiftDate) return true
  if (nowDate < shiftDate) return false
  if (!startTime) return false
  return `${get('hour')}:${get('minute')}` >= startTime
}
