// 숫자 → 원화 포맷
export function formatKRW(amount: number): string {
  if (amount >= 100_000_000) {
    return `${(amount / 100_000_000).toFixed(1)}억`
  }
  if (amount >= 10_000) {
    return `${(amount / 10_000).toFixed(0)}만원`
  }
  return `${amount.toLocaleString()}원`
}

// 숫자 → 퍼센트
export function formatPct(value: number, digits = 1): string {
  return `${(value * 100).toFixed(digits)}%`
}

// 마진율 계산
export function calcMargin(sellPrice: number, costPrice: number, feeRate: number): number {
  const net = sellPrice * (1 - feeRate)
  return (net - costPrice) / sellPrice
}

// 채널 수수료율
export const PLATFORM_FEES: Record<string, number> = {
  '카페24': 0.035,
  '무신사': 0.30,
  'WOO':    0.25,
  'REKET':  0.22,
  '클라만': 0.35,
}

// 카페24 CSV 컬럼 매핑
// 카페24 주문내역 엑셀 다운로드 기준
export const CAFE24_COLUMN_MAP: Record<string, string> = {
  '주문번호':       'order_no',
  '주문일':        'order_date',
  '상품명':        'product_name',
  '옵션':         'option_name',
  '수량':         'qty',
  '상품금액':      'unit_price',
  '결제금액':      'payment_amount',
}

// CSV 행 → Sale 객체 변환
export function parseCafe24Row(row: Record<string, string>, itemMap: Record<string, number>, channelId: number) {
  const qty = parseInt(row['수량'] || '0')
  const unitPrice = parseInt((row['상품금액'] || '0').replace(/,/g, ''))
  const gross = qty * unitPrice
  const fee = Math.round(gross * PLATFORM_FEES['카페24'])

  return {
    channel_id: channelId,
    order_date: parseKoreanDate(row['주문일'] || ''),
    qty,
    unit_price: unitPrice,
    fee_amount: fee,
    net_revenue: gross - fee,
    order_no: row['주문번호'] || '',
  }
}

// 한국 날짜 포맷 변환 (2024.01.15 → 2024-01-15)
function parseKoreanDate(dateStr: string): string {
  return dateStr.replace(/\./g, '-').trim().slice(0, 10)
}

// 월 라벨 포맷 (2024-01-01 → 1월)
export function formatMonth(dateStr: string): string {
  const d = new Date(dateStr)
  return `${d.getMonth() + 1}월`
}