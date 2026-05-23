import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { setInvoiceSequence, addInvoiceHistory, getBillingRates, getBillingContacts } from '@/lib/db'
import { calculateLineItems, ratesToBillingRates } from '@/lib/invoices'
import { buildInvoiceDocx } from '@/lib/docx-invoice'
import { buildInvoicePdf } from '@/lib/pdf-invoice'
import type { BillingEntity, CompletedShiftForInvoice, MriPetMode, BillingLineItem } from '@/lib/invoices'

function formatPhone(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length === 10) return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`
  if (digits.length === 11 && digits[0] === '1') return `+1 (${digits.slice(1, 4)}) ${digits.slice(4, 7)}-${digits.slice(7)}`
  return raw
}

interface GenerateRequest {
  entity: BillingEntity
  invoiceNumber: string                   // formatted string, possibly edited by resident
  shifts: CompletedShiftForInvoice[]
  modes: Record<string, MriPetMode>       // shiftId → mode, for MRI/PET shifts
  ctEndTimes: Record<string, string>      // shiftId → CT shift endTime, for ct-pet and ct-also modes
  ctStartTimes: Record<string, string>    // shiftId → CT shift startTime, for ct-also mode
  parkingAmounts: Record<string, number>  // shiftId → parking amount
  invoiceDate: string
  format?: 'pdf' | 'docx'
  from: {
    name: string
    address: string
    phone: string
    email: string
  }
}

export async function POST(request: Request) {
  const { userId } = await auth()
  if (!userId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = (await request.json()) as GenerateRequest
  const { entity, invoiceNumber, shifts, modes, ctEndTimes, ctStartTimes, parkingAmounts, invoiceDate, format = 'pdf', from } = body

  if (!entity || !invoiceNumber || !shifts?.length || !from?.name) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const [rawRates, contacts] = await Promise.all([getBillingRates(), getBillingContacts()])
  const rates = ratesToBillingRates(rawRates)
  const contactRow = contacts.find((c) => c.entity === entity)
  const contact = contactRow
    ? { name: contactRow.contactName, org: contactRow.org, address: contactRow.address, email: contactRow.email ?? undefined }
    : undefined

  const allLineItems: BillingLineItem[] = shifts.flatMap((shift) => {
    const items = [...calculateLineItems(shift, modes[shift.shiftId] ?? null, rates, ctEndTimes?.[shift.shiftId], ctStartTimes?.[shift.shiftId])[entity]]
    const parking = parkingAmounts?.[shift.shiftId] ?? 0
    if (parking > 0) {
      items.push({
        date: shift.date,
        startTime: '',
        endTime: '',
        description: 'Parking / transportation',
        hours: 0,
        ratePerHour: 0,
        amount: parking,
      })
    }
    return items
  })

  if (allLineItems.length === 0) {
    return NextResponse.json({ error: 'No billable items for this entity' }, { status: 400 })
  }

  const user = await currentUser()
  const residentName = user?.fullName ?? from.name

  // Advance the sequence to one past whatever number the resident used
  const trailingDigits = /(\d+)$/.exec(invoiceNumber)
  if (trailingDigits) {
    await setInvoiceSequence(userId!, entity, parseInt(trailingDigits[1]) + 1)
  }

  const formattedFrom = { ...from, phone: formatPhone(from.phone) }
  const invoiceOpts = { entity, invoiceNumber, invoiceDate, contact, from: formattedFrom, lineItems: allLineItems }
  const isPdf = format !== 'docx'
  const buffer = isPdf
    ? await buildInvoicePdf(invoiceOpts)
    : await buildInvoiceDocx(invoiceOpts)

  await addInvoiceHistory({
    userId,
    residentName,
    invoiceNumber,
    entity,
    invoiceDate,
    shiftIds: shifts.map((s) => s.shiftId),
  })

  const ext = isPdf ? 'pdf' : 'docx'
  const contentType = isPdf
    ? 'application/pdf'
    : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${invoiceNumber}.${ext}"`,
    },
  })
}
