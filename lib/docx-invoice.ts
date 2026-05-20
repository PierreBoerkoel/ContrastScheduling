import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  AlignmentType,
  WidthType,
  BorderStyle,
  convertMillimetersToTwip,
} from 'docx'
import type { BillingContact, BillingEntity, BillingLineItem } from './invoices'
import { BILLING_CONTACTS } from './invoices'

export interface InvoiceDocOptions {
  entity: BillingEntity
  invoiceNumber: string
  invoiceDate: string      // YYYY-MM-DD
  contact?: BillingContact // overrides hardcoded BILLING_CONTACTS default
  from: {
    name: string
    address: string
    phone: string
    email: string
  }
  lineItems: BillingLineItem[]
}

// ── Formatting helpers ────────────────────────────────────────────────────────

function formatDate(dateStr: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(dateStr))
}

function formatTimeRange(startTime: string, endTime: string): string {
  const fmt = (t: string) => {
    const [h, m] = t.split(':').map(Number)
    const ampm = h < 12 ? 'AM' : 'PM'
    const hour = h % 12 || 12
    return m === 0 ? `${hour} ${ampm}` : `${hour}:${m.toString().padStart(2, '0')} ${ampm}`
  }
  return `${fmt(startTime)} – ${fmt(endTime)}`
}

function formatCurrency(n: number): string {
  return `$${n.toFixed(2)}`
}

const NO_BORDER = {
  top: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  bottom: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  left: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
  right: { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' },
}

const CELL_BORDER = {
  top: { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' },
  bottom: { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' },
  left: { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' },
  right: { style: BorderStyle.SINGLE, size: 4, color: 'AAAAAA' },
}

const HEADER_BORDER = {
  top: { style: BorderStyle.SINGLE, size: 6, color: '555555' },
  bottom: { style: BorderStyle.SINGLE, size: 6, color: '555555' },
  left: { style: BorderStyle.SINGLE, size: 6, color: '555555' },
  right: { style: BorderStyle.SINGLE, size: 6, color: '555555' },
}

// Columns: Date | Time | Description | Hours | Rate | Amount
// Total ≈ 9360 twips (Letter with 25 mm margins)
const COL_WIDTHS = [2520, 1440, 2520, 720, 1080, 1080]
const COL_LABELS = ['Date', 'Time', 'Description', 'Hours', 'Rate', 'Amount']

function dataCell(text: string, colIdx: number, opts: { bold?: boolean; size?: number; color?: string } = {}): TableCell {
  return new TableCell({
    borders: CELL_BORDER,
    width: { size: COL_WIDTHS[colIdx], type: WidthType.DXA },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text, bold: opts.bold, size: opts.size ?? 20, color: opts.color })],
      }),
    ],
  })
}

function headerCell(text: string, colIdx: number): TableCell {
  return new TableCell({
    borders: HEADER_BORDER,
    width: { size: COL_WIDTHS[colIdx], type: WidthType.DXA },
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text, bold: true, size: 20, color: '333333' })],
      }),
    ],
  })
}

function headerRow(): TableRow {
  return new TableRow({ children: COL_LABELS.map((l, i) => headerCell(l, i)) })
}

function lineItemRow(lineItem: BillingLineItem): TableRow {
  const hasTime = !!(lineItem.startTime && lineItem.endTime)
  return new TableRow({
    children: [
      dataCell(formatDate(lineItem.date), 0),
      dataCell(hasTime ? formatTimeRange(lineItem.startTime, lineItem.endTime) : '', 1),
      dataCell(lineItem.description, 2),
      dataCell(hasTime ? lineItem.hours.toFixed(2) : '', 3),
      dataCell(hasTime ? formatCurrency(lineItem.ratePerHour) + '/hr' : '', 4),
      dataCell(formatCurrency(lineItem.amount), 5),
    ],
  })
}

function para(text: string, opts: { bold?: boolean; size?: number; color?: string; spacing?: number; align?: (typeof AlignmentType)[keyof typeof AlignmentType] } = {}): Paragraph {
  return new Paragraph({
    alignment: opts.align,
    spacing: { after: opts.spacing ?? 80 },
    children: [new TextRun({ text, bold: opts.bold, size: opts.size ?? 20, color: opts.color })],
  })
}

function emptyPara(after = 200): Paragraph {
  return new Paragraph({ spacing: { after }, children: [] })
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildInvoiceDocx(opts: InvoiceDocOptions): Promise<Buffer> {
  const contact: BillingContact = opts.contact ?? BILLING_CONTACTS[opts.entity]
  const total = opts.lineItems.reduce((s, l) => s + l.amount, 0)

  const toLines = [
    contact.name && contact.name.trim() ? contact.name : null,
    contact.org,
    ...contact.address.split('\n'),
    contact.email ?? null,
  ].filter(Boolean) as string[]

  const serviceRows: TableRow[] = [
    headerRow(),
    ...opts.lineItems.map(lineItemRow),
  ]

  const doc = new Document({
    sections: [
      {
        properties: {
          page: {
            margin: {
              top: convertMillimetersToTwip(25),
              bottom: convertMillimetersToTwip(25),
              left: convertMillimetersToTwip(25),
              right: convertMillimetersToTwip(25),
            },
          },
        },
        children: [
          // ── Title ──
          new Paragraph({
            spacing: { after: 40 },
            children: [new TextRun({ text: 'INVOICE', bold: true, size: 48, color: '1a1a1a' })],
          }),
          new Paragraph({
            spacing: { after: 400 },
            children: [new TextRun({ text: `Invoice – ${opts.from.name} – ${opts.invoiceNumber}`, size: 22, color: '444444' })],
          }),

          // ── From / To / Date side by side ──
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            borders: {
              top: { style: BorderStyle.NONE, size: 0 },
              bottom: { style: BorderStyle.NONE, size: 0 },
              left: { style: BorderStyle.NONE, size: 0 },
              right: { style: BorderStyle.NONE, size: 0 },
              insideHorizontal: { style: BorderStyle.NONE, size: 0 },
              insideVertical: { style: BorderStyle.NONE, size: 0 },
            },
            rows: [
              new TableRow({
                children: [
                  new TableCell({
                    borders: NO_BORDER,
                    width: { size: 50, type: WidthType.PERCENTAGE },
                    children: [
                      para('FROM', { bold: true, size: 18, color: '888888', spacing: 40 }),
                      para(opts.from.name, { bold: true }),
                      ...opts.from.address.split('\n').map((l) => para(l, { spacing: 40 })),
                      para(opts.from.phone, { spacing: 40 }),
                      para(opts.from.email, { spacing: 40 }),
                    ],
                  }),
                  new TableCell({
                    borders: NO_BORDER,
                    width: { size: 35, type: WidthType.PERCENTAGE },
                    children: [
                      para('TO', { bold: true, size: 18, color: '888888', spacing: 40 }),
                      ...toLines.map((l) => para(l, { spacing: 40 })),
                    ],
                  }),
                  new TableCell({
                    borders: NO_BORDER,
                    width: { size: 15, type: WidthType.PERCENTAGE },
                    children: [
                      para('DATE', { bold: true, size: 18, color: '888888', spacing: 40 }),
                      para(formatDate(opts.invoiceDate)),
                    ],
                  }),
                ],
              }),
            ],
          }),

          emptyPara(400),

          // ── Services table ──
          new Table({
            width: { size: COL_WIDTHS.reduce((a, b) => a + b, 0), type: WidthType.DXA },
            borders: {
              top: { style: BorderStyle.NONE, size: 0 },
              bottom: { style: BorderStyle.NONE, size: 0 },
              left: { style: BorderStyle.NONE, size: 0 },
              right: { style: BorderStyle.NONE, size: 0 },
              insideHorizontal: { style: BorderStyle.NONE, size: 0 },
              insideVertical: { style: BorderStyle.NONE, size: 0 },
            },
            rows: serviceRows,
          }),

          emptyPara(160),

          // ── Total below table ──
          new Paragraph({
            alignment: AlignmentType.RIGHT,
            spacing: { after: 400 },
            children: [
              new TextRun({ text: 'Total:  ', bold: true, size: 22 }),
              new TextRun({ text: formatCurrency(total), bold: true, size: 22 }),
            ],
          }),

          // ── Payment terms ──
          para('Payment terms: Net 30 days', { color: '888888', size: 18 }),
        ],
      },
    ],
  })

  return Packer.toBuffer(doc)
}
