export type BillingEntity = string  // entity code, e.g. 'MRCT', 'PET', 'UBC', 'BCWH'

export interface BillingRates {
  MRCT_base: number        // MRI with PET active
  MRCT_standalone: number  // MRI-only (PET down or after PET hours)
  MRCT_ct: number          // CT coverage
  PET_base: number         // PET with MRI active
  PET_standalone: number   // PET-only (MRI down)
}

export const DEFAULT_RATES: BillingRates = {
  MRCT_base: 50,
  MRCT_standalone: 75,
  MRCT_ct: 75,
  PET_base: 25,
  PET_standalone: 75,
}

export function ratesToBillingRates(raw: Record<string, number>): BillingRates {
  return {
    MRCT_base:       raw['MRCT_base']       ?? DEFAULT_RATES.MRCT_base,
    MRCT_standalone: raw['MRCT_standalone'] ?? DEFAULT_RATES.MRCT_standalone,
    MRCT_ct:         raw['MRCT_ct']         ?? DEFAULT_RATES.MRCT_ct,
    PET_base:        raw['PET_base']        ?? DEFAULT_RATES.PET_base,
    PET_standalone:  raw['PET_standalone']  ?? DEFAULT_RATES.PET_standalone,
  }
}

// How the MRI/PET resident was billing on a given shift
export type MriPetMode =
  | 'normal'           // $50/hr MRCT + $25/hr PET
  | 'two-residents'    // separate CT resident present: $75/hr MRCT + $25/hr PET
  | 'ct-also'          // sole BCCA resident covering CT too: $75/hr MRCT during CT, then $50/hr MRCT + $25/hr PET
  | 'mri-down'         // MRI scanner down, PET standalone: $75/hr PET until PET end
  | 'pet-down'         // PET down, MRI standalone: $75/hr MRCT full shift
  | 'ct-pet'           // MRI down, CT + PET running: $50/hr CT + $25/hr PET concurrent, then $75/hr for whichever continues alone
  | 'mri-ends-early'   // MRI ends before PET: concurrent until MRI end, then PET standalone until PET end

export function defaultMriPetMode(shift: { clinic: string; date: string }): MriPetMode {
  if (shift.clinic !== 'BC Cancer Agency MRI/PET') return 'normal'
  const isSunday = new Intl.DateTimeFormat('en-CA', { weekday: 'long', timeZone: 'America/Vancouver' })
    .format(new Date(shift.date + 'T12:00:00Z')) === 'Sunday'
  return isSunday ? 'pet-down' : 'normal'
}

export interface CompletedShiftForInvoice {
  shiftId: string
  date: string           // YYYY-MM-DD
  clinic: string
  startTime: string      // HH:MM — resident's actual coverage start
  endTime: string        // HH:MM — resident's actual coverage end
}

export interface BillingLineItem {
  date: string
  startTime: string      // HH:MM — start of this billing segment
  endTime: string        // HH:MM — end of this billing segment
  description: string
  hours: number
  ratePerHour: number
  amount: number
}

export interface BillingContact {
  name: string
  org: string
  address: string
  email?: string
}

export interface BillingContactRecord {
  entity: string
  contactName: string
  org: string
  address: string
  email: string | null
}

export const BILLING_CONTACTS: Record<string, BillingContact> = {
  MRCT: {
    name: 'Danielle Florendo',
    org: 'BCCA Diagnostic Imaging',
    address: '600 W 10th Ave\nVancouver BC  V5Z 4E6',
  },
  PET: {
    name: 'Chris Raiwe',
    org: 'BCCA Molecular Imaging and Therapy',
    address: '600 W 10th Ave\nVancouver BC  V5Z 4E6',
  },
  UBC: {
    name: '',
    org: 'Vancouver Imaging',
    address: '450-943 West Broadway\nVancouver BC  V5Z 4E1',
    email: 'finance@vancouverimaging.com',
  },
  BCWH: {
    name: 'Rahul Jain',
    org: 'BCW Diagnostic Imaging',
    address: '4500 Oak St.\nVancouver BC  V6H3N1',
  },
}

export function formatInvoiceNumber(initials: string, entity: string, n: number): string {
  return `${initials}_${entity}${String(n).padStart(3, '0')}`
}

export function deriveInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/)
  if (parts.length === 0) return ''
  const first = parts[0][0] ?? ''
  const last = parts[parts.length - 1][0] ?? ''
  return (parts.length > 1 ? first + last : first).toUpperCase()
}

// Which billing entities a clinic contributes to (hardcoded for existing complex-billing clinics)
export function clinicEntities(clinic: string): string[] {
  if (clinic === 'BC Cancer Agency CT') return ['MRCT']
  if (clinic === 'BC Cancer Agency MRI/PET') return ['MRCT', 'PET']
  if (clinic === 'UBC Hospital') return ['UBC']
  if (clinic === "BC Women's Hospital") return ['BCWH']
  return []
}

// ── Time helpers ──────────────────────────────────────────────────────────────

function mins(t: string): number {
  const [h, m] = t.split(':').map(Number)
  return h * 60 + m
}

// Returns the intersection of two time intervals, or null if no overlap
function overlapInterval(aS: string, aE: string, bS: string, bE: string): { start: string; end: string } | null {
  const start = mins(aS) >= mins(bS) ? aS : bS
  const end = mins(aE) <= mins(bE) ? aE : bE
  if (mins(start) >= mins(end)) return null
  return { start, end }
}

function intervalHours(start: string, end: string): number {
  return (mins(end) - mins(start)) / 60
}

function isWeekend(date: string): boolean {
  const d = new Date(date + 'T00:00:00Z').getUTCDay()
  return d === 0 || d === 6
}

function ctPeriod(date: string): { start: string; end: string } {
  return isWeekend(date)
    ? { start: '08:00', end: '16:00' }
    : { start: '17:00', end: '19:00' }
}

const PET_END = '21:00'

// ── Line item builder ─────────────────────────────────────────────────────────

function item(date: string, startTime: string, endTime: string, desc: string, rate: number): BillingLineItem {
  const hours = Math.round(intervalHours(startTime, endTime) * 100) / 100
  return { date, startTime, endTime, description: desc, hours, ratePerHour: rate, amount: Math.round(hours * rate * 100) / 100 }
}

// ── Main billing calculator ───────────────────────────────────────────────────

// simpleEntityRates: entityCode → flat hourly rate, for DB-managed simple clinics
export function calculateLineItems(
  shift: CompletedShiftForInvoice,
  mode: MriPetMode | null,
  rates: BillingRates = DEFAULT_RATES,
  ctEndTime?: string,
  ctStartTime?: string,
  simpleEntityRates?: Record<string, number>,
  petEndTime?: string,
  mriEndTime?: string,
): Record<string, BillingLineItem[]> {
  const result: Record<string, BillingLineItem[]> = { MRCT: [], PET: [] }
  const { date, clinic, startTime: sS, endTime: sE } = shift
  const PET_CUTOFF = petEndTime ?? PET_END

  if (clinic === 'BC Cancer Agency CT') {
    result.MRCT.push(item(date, sS, sE, 'CT contrast coverage', rates.MRCT_ct))
    return result
  }

  if (clinic === 'BC Cancer Agency MRI/PET') {
    const petEnd = mins(sE) > mins(PET_CUTOFF) ? PET_CUTOFF : sE
    const defaultCt = ctPeriod(date)
    const ct = (ctEndTime && mode === 'ct-also')
      ? { start: ctStartTime ?? defaultCt.start, end: ctEndTime }
      : defaultCt

    switch (mode ?? 'normal') {
      case 'normal': {
        const inPet = overlapInterval(sS, sE, sS, petEnd)
        const afterPet = overlapInterval(sS, sE, PET_CUTOFF, sE)
        if (inPet) result.MRCT.push(item(date, inPet.start, inPet.end, 'MRI contrast coverage', rates.MRCT_base))
        if (afterPet) result.MRCT.push(item(date, afterPet.start, afterPet.end, 'MRI contrast coverage', rates.MRCT_standalone))
        if (inPet) result.PET.push(item(date, inPet.start, inPet.end, 'PET contrast coverage', rates.PET_base))
        break
      }

      case 'two-residents': {
        const inPet = overlapInterval(sS, sE, sS, petEnd)
        const afterPet = overlapInterval(sS, sE, PET_CUTOFF, sE)
        if (inPet) result.MRCT.push(item(date, inPet.start, inPet.end, 'MRI contrast coverage', rates.MRCT_standalone))
        if (afterPet) result.MRCT.push(item(date, afterPet.start, afterPet.end, 'MRI contrast coverage', rates.MRCT_standalone))
        if (inPet) result.PET.push(item(date, inPet.start, inPet.end, 'PET contrast coverage', rates.PET_base))
        break
      }

      case 'ct-also': {
        const ctSeg = overlapInterval(sS, sE, ct.start, ct.end)
        const postCt = overlapInterval(sS, sE, ct.end, petEnd)
        const afterPet = overlapInterval(sS, sE, PET_CUTOFF, sE)
        if (ctSeg) result.MRCT.push(item(date, ctSeg.start, ctSeg.end, 'MRI + CT contrast coverage', rates.MRCT_standalone))
        if (postCt) result.MRCT.push(item(date, postCt.start, postCt.end, 'MRI contrast coverage', rates.MRCT_base))
        if (afterPet) result.MRCT.push(item(date, afterPet.start, afterPet.end, 'MRI contrast coverage', rates.MRCT_standalone))
        const petSeg = overlapInterval(sS, sE, sS, petEnd)
        if (petSeg) result.PET.push(item(date, petSeg.start, petSeg.end, 'PET contrast coverage', rates.PET_base))
        break
      }

      case 'mri-down': {
        const petSeg = overlapInterval(sS, sE, sS, petEnd)
        if (petSeg) result.PET.push(item(date, petSeg.start, petSeg.end, 'PET contrast coverage', rates.PET_standalone))
        break
      }

      case 'mri-ends-early': {
        if (!mriEndTime) break
        const mriEnd = mins(mriEndTime) > mins(petEnd) ? petEnd : mriEndTime
        const concurrent = overlapInterval(sS, sE, sS, mriEnd)
        const petStandalone = overlapInterval(sS, sE, mriEnd, petEnd)
        if (concurrent) {
          result.MRCT.push(item(date, concurrent.start, concurrent.end, 'MRI contrast coverage', rates.MRCT_base))
          result.PET.push(item(date, concurrent.start, concurrent.end, 'PET contrast coverage', rates.PET_base))
        }
        if (petStandalone) result.PET.push(item(date, petStandalone.start, petStandalone.end, 'PET contrast coverage', rates.PET_standalone))
        break
      }

      case 'pet-down': {
        result.MRCT.push(item(date, sS, sE, 'MRI contrast coverage', rates.MRCT_standalone))
        break
      }

      case 'ct-pet': {
        if (!ctEndTime) break
        const petEnd = mins(sE) > mins(PET_CUTOFF) ? PET_CUTOFF : sE
        const ctWindow = overlapInterval(sS, sE, sS, ctEndTime)
        const bothActive = ctWindow ? overlapInterval(ctWindow.start, ctWindow.end, sS, petEnd) : null
        const ctAfterPet = ctWindow ? overlapInterval(ctWindow.start, ctWindow.end, PET_CUTOFF, sE) : null
        const petAlone = overlapInterval(sS, sE, ctEndTime, petEnd)
        if (bothActive) {
          result.MRCT.push(item(date, bothActive.start, bothActive.end, 'CT contrast coverage', rates.MRCT_base))
          result.PET.push(item(date, bothActive.start, bothActive.end, 'PET contrast coverage', rates.PET_base))
        }
        if (ctAfterPet) result.MRCT.push(item(date, ctAfterPet.start, ctAfterPet.end, 'CT contrast coverage', rates.MRCT_ct))
        if (petAlone) result.PET.push(item(date, petAlone.start, petAlone.end, 'PET contrast coverage', rates.PET_standalone))
        break
      }
    }
    return result
  }

  // Simple clinic billing — rate looked up from simpleEntityRates (DB-managed)
  if (simpleEntityRates) {
    for (const [entityCode, rate] of Object.entries(simpleEntityRates)) {
      result[entityCode] = [item(date, sS, sE, 'Contrast Reaction Monitoring', rate)]
    }
  }

  return result
}
