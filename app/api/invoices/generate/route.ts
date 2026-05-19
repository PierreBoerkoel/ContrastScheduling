import { NextResponse } from 'next/server'
import { auth, currentUser } from '@clerk/nextjs/server'
import { setInvoiceSequence, addInvoiceHistory } from '@/lib/db'
import { calculateLineItems } from '@/lib/invoices'
import { buildInvoiceDocx } from '@/lib/docx-invoice'
import type { BillingEntity, CompletedShiftForInvoice, MriPetMode, BillingLineItem } from '@/lib/invoices'

interface GenerateRequest {
  entity: BillingEntity
  invoiceNumber: string                   // formatted string, possibly edited by resident
  shifts: CompletedShiftForInvoice[]
  modes: Record<string, MriPetMode>       // shiftId → mode, for MRI/PET shifts
  parkingAmounts: Record<string, number>  // shiftId → parking amount
  invoiceDate: string
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
  const { entity, invoiceNumber, shifts, modes, parkingAmounts, invoiceDate, from } = body

  if (!entity || !invoiceNumber || !shifts?.length || !from?.name) {
    return NextResponse.json({ error: 'Missing required fields' }, { status: 400 })
  }

  const allLineItems: BillingLineItem[] = shifts.flatMap((shift) => {
    const items = [...calculateLineItems(shift, modes[shift.shiftId] ?? null)[entity]]
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
    await setInvoiceSequence(residentName, entity, parseInt(trailingDigits[1]) + 1)
  }

  const buffer = await buildInvoiceDocx({
    entity,
    invoiceNumber,
    invoiceDate,
    from,
    lineItems: allLineItems,
  })

  await addInvoiceHistory({
    userId,
    residentName,
    invoiceNumber,
    entity,
    invoiceDate,
    shiftIds: shifts.map((s) => s.shiftId),
  })

  const filename = `${invoiceNumber}.docx`

  return new Response(new Uint8Array(buffer), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'Content-Disposition': `attachment; filename="${filename}"`,
    },
  })
}
