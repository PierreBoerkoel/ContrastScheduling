import { PDFDocument, StandardFonts, rgb, PDFFont, PDFPage } from 'pdf-lib'
import type { BillingContact, BillingEntity, BillingLineItem } from './invoices'
import { BILLING_CONTACTS } from './invoices'
import type { InvoiceDocOptions } from './docx-invoice'

export type { InvoiceDocOptions }

// ── Helpers ───────────────────────────────────────────────────────────────────

const MM_TO_PT = 2.8346

function mm(n: number) { return n * MM_TO_PT }

function formatDate(dateStr: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(dateStr + 'T00:00:00Z'))
}

function formatDateShort(dateStr: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC',
  }).format(new Date(dateStr + 'T00:00:00Z'))
}

function formatTime(t: string): string {
  const [h, m] = t.split(':').map(Number)
  const ampm = h < 12 ? 'AM' : 'PM'
  const hour = h % 12 || 12
  return m === 0 ? `${hour} ${ampm}` : `${hour}:${m.toString().padStart(2, '0')} ${ampm}`
}

function formatTimeRange(start: string, end: string): string {
  return `${formatTime(start)} – ${formatTime(end)}`
}

function formatCurrency(n: number): string {
  return `$${n.toFixed(2)}`
}

// Draw text, clipping to maxWidth by truncating with ellipsis
function drawText(
  page: PDFPage,
  text: string,
  x: number,
  y: number,
  font: PDFFont,
  size: number,
  color = rgb(0, 0, 0),
  maxWidth?: number,
) {
  let t = text
  if (maxWidth !== undefined) {
    while (t.length > 0 && font.widthOfTextAtSize(t, size) > maxWidth) {
      t = t.slice(0, -1)
    }
    if (t.length < text.length && t.length > 1) t = t.slice(0, -1) + '…'
  }
  page.drawText(t, { x, y, font, size, color })
}

// ── Layout constants ──────────────────────────────────────────────────────────

const PAGE_W = 612   // Letter width in pt
const PAGE_H = 792   // Letter height in pt
const MARGIN = mm(20)
const CONTENT_W = PAGE_W - 2 * MARGIN

// Column widths for services table (must sum to CONTENT_W ≈ 572)
const COL_W = [170, 110, 150, 44, 52, 52]  // Date | Time | Description | Hrs | Rate | Amount
const COL_LABELS = ['Date', 'Time', 'Description', 'Hours', 'Rate', 'Amount']
const COL_ALIGN: Array<'left' | 'right' | 'center'> = ['left', 'left', 'left', 'right', 'right', 'right']

const ROW_H = 20
const HEADER_H = 22
const FONT_SIZE = 9
const LABEL_SIZE = 8

// ── Table drawing ─────────────────────────────────────────────────────────────

interface DrawTableOptions {
  page: PDFPage
  y: number          // top-left y of table
  regular: PDFFont
  bold: PDFFont
  lineItems: BillingLineItem[]
}

function colX(colIdx: number): number {
  let x = MARGIN
  for (let i = 0; i < colIdx; i++) x += COL_W[i]
  return x
}

function cellTextX(colIdx: number, align: 'left' | 'right' | 'center', text: string, font: PDFFont, size: number): number {
  const x = colX(colIdx)
  if (align === 'left') return x + 3
  if (align === 'right') return x + COL_W[colIdx] - 3 - font.widthOfTextAtSize(text, size)
  return x + (COL_W[colIdx] - font.widthOfTextAtSize(text, size)) / 2
}

function drawTableHeader(page: PDFPage, y: number, bold: PDFFont) {
  // Header background
  page.drawRectangle({
    x: MARGIN, y: y - HEADER_H, width: CONTENT_W, height: HEADER_H,
    color: rgb(0.24, 0.36, 0.55),
  })
  for (let i = 0; i < COL_LABELS.length; i++) {
    const label = COL_LABELS[i]
    const tx = cellTextX(i, COL_ALIGN[i], label, bold, LABEL_SIZE)
    drawText(page, label, tx, y - HEADER_H + 7, bold, LABEL_SIZE, rgb(1, 1, 1))
  }
  return y - HEADER_H
}

function drawTableRow(page: PDFPage, y: number, item: BillingLineItem, rowIndex: number, regular: PDFFont, bold: PDFFont): number {
  const bg = rowIndex % 2 === 0 ? rgb(0.97, 0.97, 0.98) : rgb(1, 1, 1)
  page.drawRectangle({ x: MARGIN, y: y - ROW_H, width: CONTENT_W, height: ROW_H, color: bg })

  const hasTime = !!(item.startTime && item.endTime)
  const cells = [
    formatDateShort(item.date),
    hasTime ? formatTimeRange(item.startTime, item.endTime) : '',
    item.description,
    hasTime ? item.hours.toFixed(2) : '',
    hasTime ? formatCurrency(item.ratePerHour) + '/hr' : '',
    formatCurrency(item.amount),
  ]

  for (let i = 0; i < cells.length; i++) {
    const text = cells[i]
    const tx = cellTextX(i, COL_ALIGN[i], text, regular, FONT_SIZE)
    const maxW = COL_W[i] - 6
    drawText(page, text, tx, y - ROW_H + 6, regular, FONT_SIZE, rgb(0.1, 0.1, 0.1), maxW)
  }

  // Bottom border
  page.drawLine({
    start: { x: MARGIN, y: y - ROW_H },
    end: { x: MARGIN + CONTENT_W, y: y - ROW_H },
    thickness: 0.5, color: rgb(0.85, 0.85, 0.85),
  })

  return y - ROW_H
}

// ── Main builder ──────────────────────────────────────────────────────────────

export async function buildInvoicePdf(opts: InvoiceDocOptions): Promise<Buffer> {
  const contact: BillingContact = BILLING_CONTACTS[opts.entity]
  const total = opts.lineItems.reduce((s, l) => s + l.amount, 0)

  const pdfDoc = await PDFDocument.create()
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica)
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold)

  const page = pdfDoc.addPage([PAGE_W, PAGE_H])
  let y = PAGE_H - MARGIN

  // ── Title ──────────────────────────────────────────────────────────────────
  drawText(page, 'INVOICE', MARGIN, y - 28, bold, 28, rgb(0.1, 0.2, 0.4))
  y -= 36

  drawText(page, `${opts.from.name}  ·  ${opts.invoiceNumber}`, MARGIN, y - 12, regular, 10, rgb(0.45, 0.45, 0.45))
  y -= 24

  // Divider
  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + CONTENT_W, y }, thickness: 1.5, color: rgb(0.24, 0.36, 0.55) })
  y -= 16

  // ── FROM / TO / DATE ───────────────────────────────────────────────────────
  const colFromW = CONTENT_W * 0.38
  const colToW = CONTENT_W * 0.38
  const colDateW = CONTENT_W * 0.24

  const toLines = [
    contact.name?.trim() || null,
    contact.org,
    ...contact.address.split('\n'),
    contact.email ?? null,
  ].filter(Boolean) as string[]

  const fromLines = [
    opts.from.name,
    ...opts.from.address.split('\n'),
    opts.from.phone,
    opts.from.email,
  ]

  const sectionTop = y

  // Labels
  drawText(page, 'FROM', MARGIN, sectionTop, bold, LABEL_SIZE, rgb(0.5, 0.5, 0.5))
  drawText(page, 'TO', MARGIN + colFromW, sectionTop, bold, LABEL_SIZE, rgb(0.5, 0.5, 0.5))
  drawText(page, 'INVOICE DATE', MARGIN + colFromW + colToW, sectionTop, bold, LABEL_SIZE, rgb(0.5, 0.5, 0.5))

  y = sectionTop - 14

  // FROM column
  let fromY = y
  for (const line of fromLines) {
    const isName = line === opts.from.name
    drawText(page, line, MARGIN, fromY, isName ? bold : regular, FONT_SIZE, rgb(0.1, 0.1, 0.1), colFromW - 8)
    fromY -= 13
  }

  // TO column
  let toY = y
  for (const line of toLines) {
    const isOrg = line === contact.org || line === contact.name
    drawText(page, line, MARGIN + colFromW, toY, isOrg ? bold : regular, FONT_SIZE, rgb(0.1, 0.1, 0.1), colToW - 8)
    toY -= 13
  }

  // DATE column
  drawText(page, formatDate(opts.invoiceDate), MARGIN + colFromW + colToW, y, regular, FONT_SIZE, rgb(0.1, 0.1, 0.1), colDateW - 4)

  y = Math.min(fromY, toY) - 20

  // Divider
  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + CONTENT_W, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) })
  y -= 16

  // ── Services table ─────────────────────────────────────────────────────────
  y = drawTableHeader(page, y, bold)

  for (let i = 0; i < opts.lineItems.length; i++) {
    y = drawTableRow(page, y, opts.lineItems[i], i, regular, bold)
  }

  y -= 12

  // ── Total ──────────────────────────────────────────────────────────────────
  const totalLabel = 'Total:'
  const totalValue = formatCurrency(total)
  const totalLabelW = bold.widthOfTextAtSize(totalLabel, 11)
  const totalValueW = bold.widthOfTextAtSize(totalValue, 11)
  drawText(page, totalLabel, MARGIN + CONTENT_W - totalValueW - totalLabelW - 8, y, bold, 11, rgb(0.1, 0.1, 0.1))
  drawText(page, totalValue, MARGIN + CONTENT_W - totalValueW, y, bold, 11, rgb(0.1, 0.2, 0.4))
  y -= 24

  // ── Payment terms ──────────────────────────────────────────────────────────
  page.drawLine({ start: { x: MARGIN, y }, end: { x: MARGIN + CONTENT_W, y }, thickness: 0.5, color: rgb(0.8, 0.8, 0.8) })
  y -= 14
  drawText(page, 'Payment terms: Net 30 days', MARGIN, y, regular, LABEL_SIZE, rgb(0.55, 0.55, 0.55))

  const pdfBytes = await pdfDoc.save()
  return Buffer.from(pdfBytes)
}
