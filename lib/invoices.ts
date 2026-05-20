export type BillingEntity = 'MRCT' | 'PET' | 'UBCMR' | 'BCWHMR'

// How the MRI/PET resident was billing on a given shift
export type MriPetMode =
  | 'normal'        // $50/hr MRCT + $25/hr PET
  | 'two-residents' // separate CT resident present: $75/hr MRCT + $25/hr PET
  | 'ct-also'       // sole BCCA resident covering CT too: $75/hr MRCT during CT, then $50/hr MRCT + $25/hr PET
  | 'mri-down'      // MRI scanner down, PET standalone: $75/hr PET until 21:00
  | 'pet-down'      // PET down, MRI standalone: $75/hr MRCT full shift

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

export const BILLING_CONTACTS: Record<BillingEntity, BillingContact> = {
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
  UBCMR: {
    name: '',
    org: 'Vancouver Imaging',
    address: '450-943 West Broadway\nVancouver BC  V5Z 4E1',
    email: 'finance@vancouverimaging.com',
  },
  BCWHMR: {
    name: 'Rahul Jain',
    org: 'BCW Diagnostic Imaging',
    address: '4500 Oak St.\nVancouver BC  V6H3N1',
  },
}

export const SERIES_DIGITS: Record<BillingEntity, number> = {
  MRCT: 3,
  PET: 3,
  UBCMR: 3,
  BCWHMR: 3,
}

const ENTITY_LABEL: Record<BillingEntity, string> = {
  MRCT: 'BCCA_MRCT',
  PET: 'BCCA_PET',
  UBCMR: 'UBC_MRI',
  BCWHMR: 'BCWH_MRI',
}

export function formatInvoiceNumber(initials: string, entity: BillingEntity, n: number): string {
  const digits = SERIES_DIGITS[entity]
  return `${initials}_${ENTITY_LABEL[entity]}${String(n).padStart(digits, '0')}`
}

export function deriveInitials(fullName: string): string {
  const parts = fullName.trim().split(/\s+/)
  if (parts.length === 0) return ''
  const first = parts[0][0] ?? ''
  const last = parts[parts.length - 1][0] ?? ''
  return (parts.length > 1 ? first + last : first).toUpperCase()
}

// Which billing entities a clinic contributes to
export function clinicEntities(clinic: string): BillingEntity[] {
  if (clinic === 'BC Cancer Agency CT') return ['MRCT']
  if (clinic === 'BC Cancer Agency MRI/PET') return ['MRCT', 'PET']
  if (clinic === 'UBC Hospital') return ['UBCMR']
  if (clinic === "BC Women's Hospital") return ['BCWHMR']
  return [] // INITIO and unknown — no invoice
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

export function calculateLineItems(
  shift: CompletedShiftForInvoice,
  mode: MriPetMode | null,
): Record<BillingEntity, BillingLineItem[]> {
  const result: Record<BillingEntity, BillingLineItem[]> = { MRCT: [], PET: [], UBCMR: [], BCWHMR: [] }
  const { date, clinic, startTime: sS, endTime: sE } = shift

  if (clinic === 'BC Cancer Agency CT') {
    result.MRCT.push(item(date, sS, sE, 'CT coverage', 75))
    return result
  }

  if (clinic === 'BC Cancer Agency MRI/PET') {
    const petEnd = mins(sE) > mins(PET_END) ? PET_END : sE
    const ct = ctPeriod(date)

    switch (mode ?? 'normal') {
      case 'normal': {
        const inPet = overlapInterval(sS, sE, sS, petEnd)
        const afterPet = overlapInterval(sS, sE, PET_END, sE)
        if (inPet) result.MRCT.push(item(date, inPet.start, inPet.end, 'MRI coverage', 50))
        if (afterPet) result.MRCT.push(item(date, afterPet.start, afterPet.end, 'MRI standalone coverage', 75))
        if (inPet) result.PET.push(item(date, inPet.start, inPet.end, 'PET coverage', 25))
        break
      }

      case 'two-residents': {
        const inPet = overlapInterval(sS, sE, sS, petEnd)
        const afterPet = overlapInterval(sS, sE, PET_END, sE)
        if (inPet) result.MRCT.push(item(date, inPet.start, inPet.end, 'MRI coverage', 75))
        if (afterPet) result.MRCT.push(item(date, afterPet.start, afterPet.end, 'MRI standalone coverage', 75))
        if (inPet) result.PET.push(item(date, inPet.start, inPet.end, 'PET coverage', 25))
        break
      }

      case 'ct-also': {
        const ctSeg = overlapInterval(sS, sE, ct.start, ct.end)
        const postCt = overlapInterval(sS, sE, ct.end, petEnd)
        const afterPet = overlapInterval(sS, sE, PET_END, sE)
        if (ctSeg) result.MRCT.push(item(date, ctSeg.start, ctSeg.end, 'MRI and CT coverage', 75))
        if (postCt) result.MRCT.push(item(date, postCt.start, postCt.end, 'MRI coverage', 50))
        if (afterPet) result.MRCT.push(item(date, afterPet.start, afterPet.end, 'MRI standalone coverage', 75))
        const petSeg = overlapInterval(sS, sE, sS, petEnd)
        if (petSeg) result.PET.push(item(date, petSeg.start, petSeg.end, 'PET coverage', 25))
        break
      }

      case 'mri-down': {
        const petSeg = overlapInterval(sS, sE, sS, petEnd)
        if (petSeg) result.PET.push(item(date, petSeg.start, petSeg.end, 'PET standalone coverage', 75))
        break
      }

      case 'pet-down': {
        result.MRCT.push(item(date, sS, sE, 'MRI standalone coverage', 75))
        break
      }
    }
    return result
  }

  if (clinic === 'UBC Hospital') {
    result.UBCMR.push(item(date, sS, sE, 'MR coverage', 75))
    return result
  }

  if (clinic === "BC Women's Hospital") {
    result.BCWHMR.push(item(date, sS, sE, 'MR coverage', 75))
    return result
  }

  return result
}
