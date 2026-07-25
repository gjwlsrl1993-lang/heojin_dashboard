'use client'

import { useEffect, useState, useRef, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, LabelList } from 'recharts'

const CHANNEL_NAME = 'REKET'
const BASE_FEE_RATE = 0.30 // 기본 수수료 (할인 없을 때)
const FEE_STEP = 0.01 // 할인 10%마다 감소되는 수수료율
const MONTH_LABELS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월']

function formatWon(n: number): string {
  return (n || 0).toLocaleString('ko-KR') + '원'
}

function lastDayOfMonth(year: number, month: number): number {
  const daysInMonth = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return daysInMonth[month - 1]
}
function monthEndDateStr(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`
}

// "2026-03-16 23:54" / "2026-03-16" / "25.04.10"(YY.MM.DD) / "2025.04.10" / "260625"(YYMMDD, 구분자 없음) 등 여러 형식을 다 인식
function parseFlexibleDate(raw: string): string | null {
  const s = (raw || '').trim()
  if (!s) return null
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s)
  if (m) return `${m[1]}-${m[2]}-${m[3]}`
  m = /^(\d{2,4})\.(\d{1,2})\.(\d{1,2})/.exec(s)
  if (m) {
    let yy = m[1]
    if (yy.length === 2) yy = (Number(yy) >= 70 ? '19' : '20') + yy
    return `${yy}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`
  }
  m = /^(\d{8})(?:[\sT].*)?$/.exec(s)
  if (m) {
    const digits = m[1]
    return `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
  }
  m = /^(\d{6})(?:[\sT].*)?$/.exec(s)
  if (m) {
    const digits = m[1]
    let yy = digits.slice(0, 2)
    const mm = digits.slice(2, 4)
    const dd = digits.slice(4, 6)
    yy = (Number(yy) >= 70 ? '19' : '20') + yy
    return `${yy}-${mm}-${dd}`
  }
  const d = new Date(s)
  if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10)
  return null
}

// "25SS", "25FW", "26SS" 같은 시즌 문자열을 시간순으로 정렬하기 위한 값 계산 (연도*10 + SS:0/FW:1)
function seasonSortValue(season: string): number {
  const match = /^(\d{2})(SS|FW)$/i.exec((season || '').trim())
  if (!match) return -1
  const yy = parseInt(match[1], 10)
  const seasonCode = match[2].toUpperCase() === 'SS' ? 0 : 1
  return yy * 10 + seasonCode
}

function normalizeOption(raw: string): string {
  const v = (raw || '').replace(/^SIZE=/i, '').trim()
  if (v.toUpperCase() === 'FREE') return 'F'
  return v.toUpperCase()
}

function normalizeSku(raw: string): string {
  return String(raw || '').trim().toUpperCase()
}

// 스타일넘버 안의 공백/하이픈/언더스코어 차이까지 무시하는 최후 폴백용 키
function looseSku(raw: string): string {
  return normalizeSku(raw).replace(/[\s\-_]/g, '')
}

// 할인율(0~1)을 받아 REKET 슬라이딩 수수료율을 계산: 기본 30%, 할인 10%마다 -1%p (0% 밑으로는 안 내려감)
function reketFeeRate(discountRate: number): number {
  const steps = Math.floor((discountRate || 0) * 100 / 10)
  return Math.max(0, BASE_FEE_RATE - steps * FEE_STEP)
}

// saleAmount(결제금액)와 discountAmount(할인금액)로 할인율과 REKET 슬라이딩 수수료를 계산
function computeLineFee(saleAmount: number, discountAmount: number) {
  const preAmount = saleAmount + discountAmount
  const discountRate = preAmount > 0 ? discountAmount / preAmount : 0
  const feeRate = reketFeeRate(discountRate)
  const fee = Math.round(saleAmount * feeRate)
  return { discountRate, feeRate, fee, net: saleAmount - fee }
}

// 무신사와 동일한 건당 택배비 단가 (기간별로 변경됨): 25.10월까지 3,400원 / 25.11~26.4월 2,900원 / 그 이후 2,990원
function shippingRateFor(dateStr: string): number {
  if (!dateStr) return 2990
  if (dateStr <= '2025-10-31') return 3400
  if (dateStr <= '2026-04-30') return 2900
  return 2990
}

// 전년대비 % 배지 (값 옆에 붙이는 용도) — 전년 데이터 없으면 아무것도 표시 안 함
function YoyBadge({ pct }: { pct: number | null }) {
  if (pct === null) return null
  return (
    <span style={{ fontSize: 12, fontWeight: 700, marginLeft: 6, color: pct >= 0 ? '#059669' : '#e11d48' }}>
      전년비 {pct >= 0 ? '+' : ''}{pct}%
    </span>
  )
}

// 재고(items) 테이블을 여러 단계로 인덱싱해서, 스타일넘버+옵션이 정확히 일치하지 않아도
// 스타일넘버만으로, 혹은 상품명으로 폴백 매칭될 수 있게 해주는 헬퍼.
function buildItemMatchIndex<T extends { sku?: string; name?: string; option_name?: string }>(items: T[]) {
  const bySkuOption = new Map<string, T>()
  const bySkuOnly = new Map<string, T>()
  const byNameOption = new Map<string, T>()
  const byNameOnly = new Map<string, T>()
  const byLooseSku = new Map<string, T>()

  items.forEach(it => {
    const sku = normalizeSku(it.sku || '')
    const name = String(it.name || '').trim().toUpperCase()
    const opt = normalizeOption(it.option_name || '')
    if (sku) {
      const skuOptKey = `${sku}__${opt}`
      if (!bySkuOption.has(skuOptKey)) bySkuOption.set(skuOptKey, it)
      if (!bySkuOnly.has(sku)) bySkuOnly.set(sku, it)
      const loose = looseSku(sku)
      if (loose && !byLooseSku.has(loose)) byLooseSku.set(loose, it)
    }
    if (name) {
      const nameOptKey = `${name}__${opt}`
      if (!byNameOption.has(nameOptKey)) byNameOption.set(nameOptKey, it)
      if (!byNameOnly.has(name)) byNameOnly.set(name, it)
    }
  })

  function find(styleNo: string, itemName: string, optionRaw: string): T | undefined {
    const sku = normalizeSku(styleNo)
    const name = String(itemName || '').trim().toUpperCase()
    const opt = normalizeOption(optionRaw)
    if (sku && bySkuOption.has(`${sku}__${opt}`)) return bySkuOption.get(`${sku}__${opt}`)
    if (sku && bySkuOnly.has(sku)) return bySkuOnly.get(sku)
    if (name && byNameOption.has(`${name}__${opt}`)) return byNameOption.get(`${name}__${opt}`)
    if (name && byNameOnly.has(name)) return byNameOnly.get(name)
    if (sku && byLooseSku.has(looseSku(sku))) return byLooseSku.get(looseSku(sku))
    return undefined
  }

  return { find }
}

// 베스트 상품 순위 / 카테고리별 판매량 계산 (연도 전체 or 특정 연도만, yearFilter='전체'면 전체 기간)
function computeBestAndCategory(
  lines: any[],
  catIndex: ReturnType<typeof buildItemMatchIndex>,
  yearFilter: string
) {
  const filtered = yearFilter === '전체'
    ? lines
    : lines.filter((r: any) => r.settle_date && String(r.settle_date).slice(0, 4) === yearFilter)

  const bestItemMap = new Map<string, {
    key: string; item_name: string; style_no: string; season: string
    qty: number; revenue: number; netRevenue: number; profit: number
    options: Map<string, { qty: number; revenue: number; netRevenue: number; profit: number }>
  }>()
  const categoryQtyMap = new Map<string, number>()

  filtered.forEach((row: any) => {
    const revenue = row.sale_amount || 0
    const { fee } = computeLineFee(revenue, row.discount_amount || 0)
    const netRevenue = revenue - fee
    const cost = row.matched_cost || 0
    const shipping = shippingRateFor(row.settle_date || '')
    const profit = netRevenue - cost - shipping

    const info: any = catIndex.find(row.style_no || '', row.item_name || '', row.option_name || '')
    const category = info?.category || '미분류'
    const season = info?.season || '미지정'

    const groupKey = row.style_no || row.item_name || '(스타일넘버 없음)'
    const prev = bestItemMap.get(groupKey) || {
      key: groupKey, item_name: row.item_name || '(상품명 없음)', style_no: row.style_no || '-',
      season, qty: 0, revenue: 0, netRevenue: 0, profit: 0, options: new Map<string, { qty: number; revenue: number; netRevenue: number; profit: number }>(),
    }
    const optKey = row.option_name || '-'
    const prevOpt = prev.options.get(optKey) || { qty: 0, revenue: 0, netRevenue: 0, profit: 0 }
    prev.options.set(optKey, { qty: prevOpt.qty + 1, revenue: prevOpt.revenue + revenue, netRevenue: prevOpt.netRevenue + netRevenue, profit: prevOpt.profit + profit })
    bestItemMap.set(groupKey, { ...prev, qty: prev.qty + 1, revenue: prev.revenue + revenue, netRevenue: prev.netRevenue + netRevenue, profit: prev.profit + profit })

    categoryQtyMap.set(category, (categoryQtyMap.get(category) || 0) + 1)
  })

  return {
    bestItems: Array.from(bestItemMap.values()).sort((a, b) => b.qty - a.qty),
    categorySales: Array.from(categoryQtyMap.entries()).map(([category, qty]) => ({ category, qty })).sort((a, b) => b.qty - a.qty),
  }
}

export default function ReketPage() {
  const [year, setYear] = useState(new Date().getFullYear())
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const [monthlyGross, setMonthlyGross] = useState<number[]>(new Array(12).fill(0))
  const [monthlyDiscount, setMonthlyDiscount] = useState<number[]>(new Array(12).fill(0))
  const [monthlyFee, setMonthlyFee] = useState<number[]>(new Array(12).fill(0))
  const [monthlyCost, setMonthlyCost] = useState<number[]>(new Array(12).fill(0))
  const [monthlyShipping, setMonthlyShipping] = useState<number[]>(new Array(12).fill(0))
  const [monthlyAdCost, setMonthlyAdCost] = useState<number[]>(new Array(12).fill(0))
  const [insightsOpen, setInsightsOpen] = useState(false)
  const [claudeLoading, setClaudeLoading] = useState(false)
  const [claudeResult, setClaudeResult] = useState('')
  // 전년도 동일 지표 (월별) — 매출액/순매출액/순수익 비교용, 데이터 없으면 0
  const [prevYearMonthlyGross, setPrevYearMonthlyGross] = useState<number[]>(new Array(12).fill(0))
  const [prevYearMonthlyNet, setPrevYearMonthlyNet] = useState<number[]>(new Array(12).fill(0))
  const [prevYearMonthlyProfit, setPrevYearMonthlyProfit] = useState<number[]>(new Array(12).fill(0))
  const [monthlyQty, setMonthlyQty] = useState<number[]>(new Array(12).fill(0))
  const [monthlyQtySale, setMonthlyQtySale] = useState<number[]>(new Array(12).fill(0))
  const [monthlyQtyRefund, setMonthlyQtyRefund] = useState<number[]>(new Array(12).fill(0))
  const [hasData, setHasData] = useState(false)
  const [viewMonthIdx, setViewMonthIdx] = useState(new Date().getMonth())

  const [showByOption, setShowByOption] = useState(false)
  const [bestItemSeasonFilter, setBestItemSeasonFilter] = useState('전체')
  // 베스트 상품/카테고리는 연도 선택(select) 기준으로 별도 관리 — 기본은 '전체'(전체 기간)
  const [bestYearFilter, setBestYearFilter] = useState('전체')
  const [allBestLines, setAllBestLines] = useState<any[]>([])
  const [catItemsAll, setCatItemsAll] = useState<any[]>([])
  const [yoyDashboardPct, setYoyDashboardPct] = useState<number | null>(null)

  // 차트 전용 (연도 독립 이동)
  const [chartYear, setChartYear] = useState(new Date().getFullYear())
  const [chartLoading, setChartLoading] = useState(false)
  const [chartMonthlyGross, setChartMonthlyGross] = useState<number[]>(new Array(12).fill(0))
  const [chartPrevYearGross, setChartPrevYearGross] = useState<number[]>(new Array(12).fill(0))
  const [chartMonthlyQtySale, setChartMonthlyQtySale] = useState<number[]>(new Array(12).fill(0))
  const [chartPrevYearQtySale, setChartPrevYearQtySale] = useState<number[]>(new Array(12).fill(0))
  const [chartHasPrevYearData, setChartHasPrevYearData] = useState(false)
  const [chartHasData, setChartHasData] = useState(false)

  // 일별 주문표 팝업
  const [showOrderModal, setShowOrderModal] = useState(false)
  const [orderYear, setOrderYear] = useState(new Date().getFullYear())
  const [orderMonthIdx, setOrderMonthIdx] = useState(new Date().getMonth())
  const [orderRows, setOrderRows] = useState<any[]>([])
  const [orderLoading, setOrderLoading] = useState(false)

  // 원가 확인 팝업
  const [showCostModal, setShowCostModal] = useState(false)
  const [costRows, setCostRows] = useState<{ key: string; itemName: string; qty: number; cost: number; matched: boolean }[]>([])
  const [costLoading, setCostLoading] = useState(false)

  useEffect(() => { loadData() }, [year])
  useEffect(() => { setChartYear(year); loadChartData(year) }, [year])
  // 베스트 상품/카테고리는 연도 셀렉터와 무관하게 전체 기간 데이터를 한 번 불러와서 클라이언트에서 연도 필터링
  useEffect(() => { loadBestSource() }, [])

  async function loadBestSource() {
    const { data: allLines } = await supabase
      .from('reket_settlement_lines')
      .select('settle_date, sale_amount, discount_amount, matched_cost, item_name, style_no, option_name, cost_matched')
      .eq('channel', CHANNEL_NAME)
    setAllBestLines(allLines || [])

    const { data: catItems } = await supabase.from('items').select('sku, name, option_name, category, season')
    setCatItemsAll(catItems || [])
  }

  async function loadData() {
    setLoading(true)
    const { data: lineRows } = await supabase
      .from('reket_settlement_lines')
      .select('settle_date, sale_amount, discount_amount, matched_cost, item_name, style_no, option_name, cost_matched')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', `${year}-01-01`)
      .lte('settle_date', `${year}-12-31`)

    const grossArr = new Array(12).fill(0)
    const discountArr = new Array(12).fill(0)
    const feeArr = new Array(12).fill(0)
    const costArr = new Array(12).fill(0)
    const shippingArr = new Array(12).fill(0)
    const qtyArr = new Array(12).fill(0)
    const qtySaleArr = new Array(12).fill(0)
    const qtyRefundArr = new Array(12).fill(0)

    ;(lineRows || []).forEach((row: any) => {
      const m = new Date(row.settle_date).getMonth()
      const { fee } = computeLineFee(row.sale_amount || 0, row.discount_amount || 0)
      grossArr[m] += row.sale_amount || 0
      discountArr[m] += row.discount_amount || 0
      feeArr[m] += fee
      costArr[m] += row.matched_cost || 0
      shippingArr[m] += shippingRateFor(row.settle_date || '')
      qtyArr[m] += 1
      if ((row.sale_amount || 0) < 0) qtyRefundArr[m] += 1
      else qtySaleArr[m] += 1
    })

    setMonthlyQtySale(qtySaleArr)
    setMonthlyQtyRefund(qtyRefundArr)
    setMonthlyGross(grossArr)
    setMonthlyDiscount(discountArr)
    setMonthlyFee(feeArr)
    setMonthlyCost(costArr)
    setMonthlyShipping(shippingArr)
    setMonthlyQty(qtyArr)
    setHasData((lineRows || []).length > 0)

    // 광고비 (ad_performance 테이블에서 채널별로 조회 — 무신사와 동일한 방식)
    const { data: adRows } = await supabase
      .from('ad_performance')
      .select('ad_date, ad_cost')
      .eq('channel', CHANNEL_NAME)
      .gte('ad_date', `${year}-01-01`)
      .lte('ad_date', `${year}-12-31`)
    const adCostArr = new Array(12).fill(0)
    ;(adRows || []).forEach((row: any) => {
      const m = new Date(row.ad_date).getMonth()
      adCostArr[m] += row.ad_cost || 0
    })
    setMonthlyAdCost(adCostArr)

    // 전년도 동일 지표(매출액/순매출액/순수익) 월별 비교용 — 없으면 0으로 처리
    const prevYear = year - 1
    const { data: prevRows } = await supabase
      .from('reket_settlement_lines')
      .select('settle_date, sale_amount, discount_amount, matched_cost')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', `${prevYear}-01-01`)
      .lte('settle_date', `${prevYear}-12-31`)

    const prevGrossArr = new Array(12).fill(0)
    const prevFeeArr = new Array(12).fill(0)
    const prevCostArr = new Array(12).fill(0)
    const prevShippingArr = new Array(12).fill(0)
    ;(prevRows || []).forEach((row: any) => {
      const m = new Date(row.settle_date).getMonth()
      const { fee } = computeLineFee(row.sale_amount || 0, row.discount_amount || 0)
      prevGrossArr[m] += row.sale_amount || 0
      prevFeeArr[m] += fee
      prevCostArr[m] += row.matched_cost || 0
      prevShippingArr[m] += shippingRateFor(row.settle_date || '')
    })

    const { data: prevAdRows } = await supabase
      .from('ad_performance')
      .select('ad_date, ad_cost')
      .eq('channel', CHANNEL_NAME)
      .gte('ad_date', `${prevYear}-01-01`)
      .lte('ad_date', `${prevYear}-12-31`)
    const prevAdCostArr = new Array(12).fill(0)
    ;(prevAdRows || []).forEach((row: any) => {
      const m = new Date(row.ad_date).getMonth()
      prevAdCostArr[m] += row.ad_cost || 0
    })

    const prevNetArr = prevGrossArr.map((g, i) => g - prevFeeArr[i])
    const prevProfitArr = prevNetArr.map((n, i) => n - prevCostArr[i] - prevShippingArr[i] - prevAdCostArr[i])
    setPrevYearMonthlyGross(prevGrossArr)
    setPrevYearMonthlyNet(prevNetArr)
    setPrevYearMonthlyProfit(prevProfitArr)

    const prevSum = prevGrossArr.reduce((s, v) => s + v, 0)
    const thisSum = grossArr.reduce((s, v) => s + v, 0)
    setYoyDashboardPct(prevSum > 0 ? Math.round(((thisSum - prevSum) / prevSum) * 1000) / 10 : null)

    setLoading(false)
  }

  async function loadChartData(targetYear: number) {
    setChartLoading(true)
    const { data: curRows } = await supabase
      .from('reket_settlement_lines')
      .select('settle_date, sale_amount')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', `${targetYear}-01-01`)
      .lte('settle_date', `${targetYear}-12-31`)
    const grossArr = new Array(12).fill(0)
    const qtySaleArr = new Array(12).fill(0)
    ;(curRows || []).forEach((row: any) => {
      const m = new Date(row.settle_date).getMonth()
      grossArr[m] += row.sale_amount || 0
      if ((row.sale_amount || 0) >= 0) qtySaleArr[m] += 1
    })
    setChartMonthlyGross(grossArr)
    setChartMonthlyQtySale(qtySaleArr)
    setChartHasData((curRows || []).length > 0)

    const prevYear = targetYear - 1
    const { data: prevRows } = await supabase
      .from('reket_settlement_lines')
      .select('settle_date, sale_amount')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', `${prevYear}-01-01`)
      .lte('settle_date', `${prevYear}-12-31`)
    const prevArr = new Array(12).fill(0)
    const prevQtySaleArr = new Array(12).fill(0)
    ;(prevRows || []).forEach((row: any) => {
      const m = new Date(row.settle_date).getMonth()
      prevArr[m] += row.sale_amount || 0
      if ((row.sale_amount || 0) >= 0) prevQtySaleArr[m] += 1
    })
    setChartPrevYearGross(prevArr)
    setChartPrevYearQtySale(prevQtySaleArr)
    setChartHasPrevYearData((prevRows || []).length > 0)
    setChartLoading(false)
  }

  function shiftChartYear(delta: number) {
    const nextYear = chartYear + delta
    setChartYear(nextYear)
    loadChartData(nextYear)
  }

  function shiftViewMonth(delta: number) {
    let nextMonth = viewMonthIdx + delta
    let nextYear = year
    if (nextMonth < 0) { nextMonth = 11; nextYear -= 1 }
    else if (nextMonth > 11) { nextMonth = 0; nextYear += 1 }
    setViewMonthIdx(nextMonth)
    if (nextYear !== year) setYear(nextYear)
  }

  function parseNum(v: any): number {
    if (v === null || v === undefined || v === '') return 0
    const cleaned = String(v).replace(/[^0-9.\-]/g, '').trim()
    if (!cleaned || cleaned === '-') return 0
    const n = parseFloat(cleaned)
    return isNaN(n) ? 0 : n
  }

  function parseCsv(text: string): string[][] {
    const clean = text.replace(/^﻿/, '')
    const lines = clean.split(/\r\n|\n/).filter(l => l.trim().length > 0)
    const parseLine = (line: string) => {
      const cells: string[] = []
      let cur = ''
      let inQuotes = false
      for (let i = 0; i < line.length; i++) {
        const ch = line[i]
        if (ch === '"') {
          if (inQuotes && line[i + 1] === '"') { cur += '"'; i++ }
          else inQuotes = !inQuotes
        } else if (ch === ',' && !inQuotes) {
          cells.push(cur); cur = ''
        } else cur += ch
      }
      cells.push(cur)
      return cells
    }
    return lines.map(parseLine)
  }

  async function handleUpload(file: File) {
    setUploading(true)
    try {
      const text = await file.text()
      const rows = parseCsv(text)
      if (rows.length < 2) { setUploadMsg('파일에 데이터가 없습니다.'); setUploading(false); return }
      const headers = rows[0].map(h => h.trim())
      const idx = {
        date: headers.findIndex(h => h.includes('결제일시')),
        name: headers.findIndex(h => h.includes('상품명')),
        styleNo: headers.findIndex(h => h.includes('스타일넘버')),
        option: headers.findIndex(h => h.includes('상품옵션')),
        amount: headers.findIndex(h => h.includes('구매금액') || h.includes('판매가')),
        discount: headers.findIndex(h => h.includes('추가할인금액')),
        paid: headers.findIndex(h => h.includes('결제금액')),
        recipient: headers.findIndex(h => h.includes('수령인')),
      }

      const { data: allItems } = await supabase.from('items').select('sku, name, option_name, cost_price, sell_price')
      const itemIndex = buildItemMatchIndex(allItems || [])

      const lineRecords: any[] = []
      let minDate = '', maxDate = ''
      let unmatchedTotal = 0
      const unmatchedSamples: string[] = []
      for (let i = 1; i < rows.length; i++) {
        const cells = rows[i]
        const rawDate = (cells[idx.date] || '').trim()
        if (!rawDate) continue
        const dateStr = parseFlexibleDate(rawDate)
        if (!dateStr) continue
        if (!minDate || dateStr < minDate) minDate = dateStr
        if (!maxDate || dateStr > maxDate) maxDate = dateStr

        const rawName = (cells[idx.name] || '').trim()
        const itemName = rawName.replace(/<br>/gi, ' ').replace(/\s+/g, ' ').trim()
        const styleNo = idx.styleNo >= 0
          ? (cells[idx.styleNo] || '').trim()
          : rawName.replace(/<br>/gi, '_').trim()
        const optionName = normalizeOption(cells[idx.option] || '')
        const discountAmount = parseNum(cells[idx.discount])
        const saleAmount = idx.paid >= 0 ? parseNum(cells[idx.paid]) : parseNum(cells[idx.amount]) - discountAmount
        const recipient = (cells[idx.recipient] || '').trim()

        const matched = itemIndex.find(styleNo, itemName, optionName)
        if (!matched) {
          unmatchedTotal++
          const sample = styleNo || itemName || '(스타일넘버/상품명 없음)'
          if (unmatchedSamples.length < 5 && !unmatchedSamples.includes(sample)) unmatchedSamples.push(sample)
        }
        const matchedCost = matched ? (matched.cost_price || 0) : 0
        const registeredSellPrice = matched ? (matched.sell_price || 0) : 0
        // 상품명은 엑셀에 적힌 값이 아니라 재고 제어판(items)에 등록된 스타일넘버 기준 상품명을 우선 사용
        // (매칭 자체는 엑셀 원본 이름/스타일넘버로 하고, 표시용 이름만 재고쪽 것으로 교체)
        const displayName = (matched?.name ? String(matched.name).trim() : '') || itemName

        lineRecords.push({
          channel: CHANNEL_NAME,
          settle_date: dateStr,
          style_no: styleNo,
          item_name: displayName,
          option_name: optionName,
          sale_amount: saleAmount,
          discount_amount: discountAmount,
          recipient,
          matched_cost: matchedCost,
          cost_matched: !!matched,
          registered_sell_price: registeredSellPrice,
        })
      }

      let deleteErrorMsg = ''
      if (minDate && maxDate) {
        const { error: delErr } = await supabase.from('reket_settlement_lines')
          .delete().eq('channel', CHANNEL_NAME).gte('settle_date', minDate).lte('settle_date', maxDate)
        if (delErr) deleteErrorMsg = `삭제 실패: ${delErr.message}`
      }

      let added = 0, failed = 0, firstError = ''
      if (lineRecords.length > 0) {
        const { error } = await supabase.from('reket_settlement_lines').insert(lineRecords)
        if (error) { failed = lineRecords.length; firstError = error.message }
        else added = lineRecords.length
      }

      const unmatchedCount = lineRecords.filter(r => !r.cost_matched).length
      setUploadMsg(
        `업로드 완료: ${added}건 반영 / ${failed}건 실패` +
        (unmatchedCount > 0 ? `\n⚠ 재고 미매칭 ${unmatchedCount}건 (예: ${unmatchedSamples.map(s => `"${s}"`).join(', ')}) — "원가 확인" 팝업에서 확인해보세요` : '') +
        (firstError ? `\n오류: ${firstError}` : '') + (deleteErrorMsg ? `\n${deleteErrorMsg}` : '')
      )
      loadData()
      loadChartData(chartYear)
      loadBestSource()
    } catch (e: any) {
      console.error(e)
      setUploadMsg('파일 처리 중 오류가 발생했습니다.\n' + (e?.message || String(e)))
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function loadOrderRows(targetYear: number, monthIdx: number) {
    setOrderLoading(true)
    const m = monthIdx + 1
    const startDate = `${targetYear}-${String(m).padStart(2, '0')}-01`
    const endDate = monthEndDateStr(targetYear, m)
    const { data } = await supabase
      .from('reket_settlement_lines')
      .select('*')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', startDate)
      .lte('settle_date', endDate)
      .order('settle_date', { ascending: true })
    setOrderRows(data || [])
    setOrderLoading(false)
  }

  function openOrderModal() {
    setShowOrderModal(true)
    setOrderYear(year)
    setOrderMonthIdx(viewMonthIdx)
    loadOrderRows(year, viewMonthIdx)
  }

  function shiftOrderMonth(delta: number) {
    let nextMonth = orderMonthIdx + delta
    let nextYear = orderYear
    if (nextMonth < 0) { nextMonth = 11; nextYear -= 1 }
    else if (nextMonth > 11) { nextMonth = 0; nextYear += 1 }
    setOrderMonthIdx(nextMonth)
    setOrderYear(nextYear)
    loadOrderRows(nextYear, nextMonth)
  }

  async function loadCostBreakdown() {
    setCostLoading(true)
    const { data } = await supabase
      .from('reket_settlement_lines')
      .select('item_name, matched_cost, cost_matched')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', `${year}-01-01`)
      .lte('settle_date', `${year}-12-31`)
    const map = new Map<string, { key: string; itemName: string; qty: number; cost: number; matched: boolean }>()
    ;(data || []).forEach((row: any) => {
      const key = row.item_name || '(상품명 없음)'
      const prev = map.get(key) || { key, itemName: key, qty: 0, cost: 0, matched: row.cost_matched }
      map.set(key, { ...prev, qty: prev.qty + 1, cost: prev.cost + (row.matched_cost || 0), matched: prev.matched || row.cost_matched })
    })
    setCostRows(Array.from(map.values()).sort((a, b) => (a.matched === b.matched ? b.cost - a.cost : a.matched ? 1 : -1)))
    setCostLoading(false)
  }

  function openCostModal() {
    setShowCostModal(true)
    loadCostBreakdown()
  }

  // 베스트 상품/카테고리별 판매량: 연도 선택(bestYearFilter)에 따라 전체 기간 데이터에서 계산
  const catIndexAll = useMemo(() => buildItemMatchIndex(catItemsAll.map((it: any) => ({
    sku: it.sku, name: it.name, option_name: it.option_name, category: it.category, season: it.season,
  }))), [catItemsAll])

  const { bestItems, categorySales } = useMemo(
    () => computeBestAndCategory(allBestLines, catIndexAll, bestYearFilter),
    [allBestLines, catIndexAll, bestYearFilter]
  )

  const availableBestYears = useMemo(() => {
    const set = new Set<number>()
    allBestLines.forEach((r: any) => { if (r.settle_date) set.add(Number(String(r.settle_date).slice(0, 4))) })
    return Array.from(set).sort((a, b) => b - a)
  }, [allBestLines])

  function generateInsights() {
    const sales: string[] = []
    const items: string[] = []

    if (yoyDashboardPct !== null) {
      if (yoyDashboardPct >= 10) sales.push(`${year}년 매출이 전년 대비 ${yoyDashboardPct}% 성장했어요. 잘 팔리는 상품 위주로 재고를 넉넉히 준비해보세요.`)
      else if (yoyDashboardPct <= -10) sales.push(`${year}년 매출이 전년 대비 ${yoyDashboardPct}% 감소했어요. 급감한 시기가 있는지 확인해보세요.`)
      else sales.push(`${year}년 매출은 전년 대비 ${yoyDashboardPct >= 0 ? '+' : ''}${yoyDashboardPct}%로 큰 변화 없이 유지되고 있어요.`)
    }
    if (marginRate !== null) {
      if (marginRate < 0) sales.push(`공헌이익률이 ${marginRate}%로 마이너스예요. 팔수록 손해라는 뜻이라 즉시 원가·할인 구조를 점검해야 해요. (0% 미만은 위험 신호)`)
      else if (marginRate < 10) sales.push(`공헌이익률이 ${marginRate}%로 낮은 편이에요. 보통 10% 미만이면 원가·수수료 부담이 커요. "원가 확인" 팝업에서 점검해보세요.`)
      else if (marginRate < 20) sales.push(`공헌이익률이 ${marginRate}%예요. 20% 이상이 안정권으로 보는 경우가 많아요.`)
      else sales.push(`공헌이익률이 ${marginRate}%로 양호해요.`)
    }
    if (bestItems.length > 0) {
      const top = bestItems[0]
      items.push(`올해 가장 많이 팔린 상품은 "${top.item_name}"(${top.qty}건)이에요.`)
    }
    if (categorySales.length > 0) {
      const topCat = categorySales[0]
      const totalCatQty = categorySales.reduce((s, c) => s + c.qty, 0)
      const catShare = totalCatQty > 0 ? Math.round((topCat.qty / totalCatQty) * 100) : 0
      items.push(`"${topCat.category}" 카테고리가 전체 판매의 ${catShare}%를 차지해요.`)
      if (categorySales.some(c => c.category === '미분류')) {
        items.push(`"미분류" 카테고리로 잡힌 판매 건이 있어요. 재고 제어판에서 해당 상품의 카테고리를 지정해주세요.`)
      }
    }
    return { sales, items }
  }

  // Claude API를 이용한 실제 AI 분석 (규칙 기반 인사이트 + 핵심 KPI를 프롬프트로 전달)
  async function runClaudeAI() {
    setClaudeLoading(true)
    setClaudeResult('')
    try {
      const insights = generateInsights()
      const bulletLines = [...insights.sales, ...insights.items].map(t => `- ${t}`).join('\n')
      const prompt = `너는 패션 브랜드 "헤오진"의 데이터 분석가야. 아래는 "REKET" 채널의 ${year}년 데이터 요약이야.

[핵심 KPI]
- ${year}년 총 매출액: ${totalGross.toLocaleString('ko-KR')}원
- ${year}년 순매출액(정산금액, 슬라이딩 수수료 반영): ${totalNet.toLocaleString('ko-KR')}원
- ${year}년 순수익(공헌이익): ${totalProfit.toLocaleString('ko-KR')}원
- ${year}년 판매수량: ${totalQtySale.toLocaleString('ko-KR')}개

[규칙 기반 자동 인사이트]
${bulletLines || '(아직 참고할 만한 규칙 기반 인사이트가 없음)'}

위 데이터를 바탕으로 REKET 채널의 현재 상태를 간결하게 실제로 분석하고, 다음에 취할 수 있는 구체적인 액션을 제안해줘. 한국어로 답변해줘.`

      const res = await fetch('/api/ai-insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      const data = await res.json()
      setClaudeResult(data.text || data.error || '분석 실패')
    } catch (e) {
      setClaudeResult('AI 분석 중 오류가 발생했습니다.')
    } finally {
      setClaudeLoading(false)
    }
  }

  const totalGross = monthlyGross.reduce((s, v) => s + v, 0)
  const totalQtySale = monthlyQtySale.reduce((s, v) => s + v, 0)
  const totalQtyRefund = monthlyQtyRefund.reduce((s, v) => s + v, 0)
  const totalNetQty = totalQtySale - totalQtyRefund
  const totalFee = monthlyFee.reduce((s, v) => s + v, 0)
  const totalNet = totalGross - totalFee
  const totalCost = monthlyCost.reduce((s, v) => s + v, 0)
  const totalShipping = monthlyShipping.reduce((s, v) => s + v, 0)
  const totalAdCost = monthlyAdCost.reduce((s, v) => s + v, 0)
  const totalProfit = totalNet - totalCost - totalShipping - totalAdCost
  const marginRate = totalNet > 0 ? Math.round((totalProfit / totalNet) * 1000) / 10 : null
  const avgFeeRate = totalGross > 0 ? Math.round((totalFee / totalGross) * 1000) / 10 : BASE_FEE_RATE * 100

  // 순수익 구성비 (총매출액 대비 %) — 원가/택배비/광고비/수수료
  const costPct = totalGross > 0 ? Math.round((totalCost / totalGross) * 1000) / 10 : 0
  const shippingPct = totalGross > 0 ? Math.round((totalShipping / totalGross) * 1000) / 10 : 0
  const adPct = totalGross > 0 ? Math.round((totalAdCost / totalGross) * 1000) / 10 : 0
  const feePct = totalGross > 0 ? Math.round((totalFee / totalGross) * 1000) / 10 : 0

  // 공헌이익률(광고료 제외) — 위험도 판단용. 광고비는 마케팅 의사결정에 따라 변동이 커서 별도로 뺀 기준
  const profitExAd = totalNet - totalCost - totalShipping
  const marginRateExAd = totalNet > 0 ? Math.round((profitExAd / totalNet) * 1000) / 10 : null

  const mGross = monthlyGross[viewMonthIdx]
  const mFee = monthlyFee[viewMonthIdx]
  const mNet = mGross - mFee
  const mCost = monthlyCost[viewMonthIdx]
  const mShipping = monthlyShipping[viewMonthIdx]
  const mAdCost = monthlyAdCost[viewMonthIdx]
  const mProfit = mNet - mCost - mShipping - mAdCost

  // 전년도 비교 (연간 합계 / 선택 월) — 데이터 없으면 0으로 처리, 전년 값이 0이면 %는 표시 안 함
  const prevYearTotalGross = prevYearMonthlyGross.reduce((s, v) => s + v, 0)
  const prevYearTotalNet = prevYearMonthlyNet.reduce((s, v) => s + v, 0)
  const prevYearTotalProfit = prevYearMonthlyProfit.reduce((s, v) => s + v, 0)
  const yoyNetPct = prevYearTotalNet > 0 ? Math.round(((totalNet - prevYearTotalNet) / prevYearTotalNet) * 1000) / 10 : null
  const yoyProfitPct = prevYearTotalProfit > 0 ? Math.round(((totalProfit - prevYearTotalProfit) / prevYearTotalProfit) * 1000) / 10 : null

  const prevMGross = prevYearMonthlyGross[viewMonthIdx]
  const prevMNet = prevYearMonthlyNet[viewMonthIdx]
  const prevMProfit = prevYearMonthlyProfit[viewMonthIdx]
  const mYoyGrossPct = prevMGross > 0 ? Math.round(((mGross - prevMGross) / prevMGross) * 1000) / 10 : null
  const mYoyNetPct = prevMNet > 0 ? Math.round(((mNet - prevMNet) / prevMNet) * 1000) / 10 : null
  const mYoyProfitPct = prevMProfit > 0 ? Math.round(((mProfit - prevMProfit) / prevMProfit) * 1000) / 10 : null

  const monthlyChartData = MONTH_LABELS.map((label, i) => ({ name: label, 매출: chartMonthlyGross[i], 작년매출: chartPrevYearGross[i] }))
  const qtyChartData = MONTH_LABELS.map((label, i) => ({ name: label, 판매수량: chartMonthlyQtySale[i], 작년판매수량: chartPrevYearQtySale[i] }))

  function renderRevenueLabel(props: any) {
    const { x, y, width, value } = props
    if (!value) return null
    return (
      <text x={x + width / 2} y={y - 4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#f43f5e">
        {value.toLocaleString('ko-KR')}
      </text>
    )
  }

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#f43f5e', display: 'inline-block' }}></span>
          <h2 className="page-title" style={{ margin: 0 }}>REKET 손익 & 업로드</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#f43f5e', fontWeight: 600 }}>평균 수수료 {avgFeeRate}% (기본 {(BASE_FEE_RATE*100).toFixed(0)}%, 할인 10%마다 -1%p)</span>
        </div>
      </div>

      {loading ? <div className="loading">로딩 중...</div> : (
        <>
          {/* AI 추천 인사이트 (맨 위) */}
          {(() => {
            const insights = generateInsights()
            const groups = [
              { title: '📈 매출 현황', items: insights.sales, color: '#f43f5e' },
              { title: '👕 아이템 피드백', items: insights.items, color: '#8b5cf6' },
            ]
            return (
              <div style={{ background: 'linear-gradient(135deg, #fff1f2 0%, #eff6ff 100%)', border: '1px solid #94a3b8', borderRadius: 16, padding: 24, marginBottom: 24 }}>
                <div
                  onClick={() => setInsightsOpen(v => !v)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: insightsOpen ? 4 : 0, cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18 }}>🤖</span>
                    <div style={{ fontWeight: 800, fontSize: 16 }}>AI 추천 인사이트</div>
                  </div>
                  <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 700, transform: insightsOpen ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▼</span>
                </div>
                {insightsOpen && (
                  <>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 18 }}>
                      {year}년 {viewMonthIdx + 1}월 기준 데이터를 바탕으로 자동 생성된 참고용 피드백이에요
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2,1fr)', gap: 16 }}>
                      {groups.map(g => (
                        <div key={g.title} style={{ background: '#fff', borderRadius: 12, padding: 16 }}>
                          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: g.color }}>{g.title}</div>
                          {g.items.length === 0 ? (
                            <div style={{ fontSize: 12, color: '#94a3b8' }}>아직 참고할 만한 데이터가 부족해요.</div>
                          ) : (
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                              {g.items.map((text, i) => (
                                <div key={i} style={{ display: 'flex', gap: 6, alignItems: 'flex-start' }}>
                                  <span style={{ color: g.color, fontSize: 12, marginTop: 1 }}>•</span>
                                  <span style={{ fontSize: 12, color: '#374151', lineHeight: 1.5 }}>{text}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    <div style={{ borderTop: '1px solid #f1f5f9', margin: '12px 0' }} />
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: 10 }}>
                      <span style={{ fontWeight: 700, fontSize: 13, color: '#4f46e5' }}>🤖 Claude AI 분석</span>
                      <button
                        onClick={runClaudeAI}
                        disabled={claudeLoading}
                        style={{ border: '1px solid #4f46e5', background: claudeLoading ? '#f8fafc' : '#4f46e5', color: claudeLoading ? '#94a3b8' : '#fff', cursor: claudeLoading ? 'default' : 'pointer', fontSize: 12, fontWeight: 700, padding: '6px 12px', borderRadius: 8 }}
                      >
                        {claudeLoading ? '분석 중...' : 'Claude 분석 보기'}
                      </button>
                    </div>
                    <div style={{ background: '#fff', borderRadius: 12, padding: 16 }}>
                      {!claudeLoading && !claudeResult && (
                        <div style={{ fontSize: 12, color: '#94a3b8' }}>버튼을 누르면 Claude가 실제로 데이터를 분석합니다.</div>
                      )}
                      {claudeLoading && (
                        <div style={{ fontSize: 12, color: '#94a3b8' }}>Claude가 데이터를 분석하고 있어요...</div>
                      )}
                      {!claudeLoading && claudeResult && (
                        <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.7, fontSize: 13, color: '#374151' }}>{claudeResult}</div>
                      )}
                    </div>
                  </>
                )}
              </div>
            )
          })()}

          {/* 연도 변경 */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 6, marginBottom: 16 }}>
            <button onClick={() => setYear(y => y - 1)} style={yearBtnStyle}>◀</button>
            <span style={{ fontWeight: 700, fontSize: 13, minWidth: 48, textAlign: 'center' }}>{year}년</span>
            <button onClick={() => setYear(y => y + 1)} style={yearBtnStyle}>▶</button>
          </div>

          {/* 연간 KPI */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16, marginBottom: 20 }}>
            <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 14, color: '#000000', fontWeight: 700 }}>{year}년 총 매출액</span>
                <div>
                  <input ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }}
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f) }} />
                  <button onClick={() => fileRef.current?.click()} disabled={uploading}
                    style={{ border: '1px solid #fecdd3', background: '#fff', color: '#e11d48', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>
                    {uploading ? '업로드 중...' : '📤 업로드'}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#000000', marginBottom: 4 }}>
                {formatWon(totalGross)}
                <YoyBadge pct={yoyDashboardPct} />
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>작년 {formatWon(prevYearTotalGross)}</div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                결제금액 합계 (할인 반영 후)
                {hasData && (
                  <span style={{ marginLeft: 6, color: '#64748b', fontWeight: 700 }}>
                    {totalNetQty}건 <span style={{ fontWeight: 500, color: '#94a3b8' }}>(판매{totalQtySale}/환불{totalQtyRefund})</span>
                  </span>
                )}
              </div>
            </div>
            <div style={{ background: '#fff1f2', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 14, color: '#000000', fontWeight: 700 }}>순매출액</span>
                <button onClick={openOrderModal}
                  style={{ border: '1px solid #94a3b8', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>
                  📋 일별 주문표
                </button>
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#2563eb', marginBottom: 4 }}>
                {formatWon(totalNet)}
                <YoyBadge pct={yoyNetPct} />
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>작년 {formatWon(prevYearTotalNet)}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <span style={{ fontSize: 12, color: '#e11d48', fontWeight: 700 }}>- {formatWon(totalFee)}</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>수수료 (평균 {avgFeeRate}%, 할인 연동 슬라이딩)</span>
              </div>
            </div>
            <div style={{ background: totalProfit >= 0 ? '#eff6ff' : '#fff1f2', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 14, color: '#000000', fontWeight: 700 }}>순수익 (공헌이익)</span>
                <button onClick={openCostModal}
                  style={{ border: '1px solid #bfdbfe', background: '#fff', color: '#2563eb', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>
                  🔍 원가 확인
                </button>
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: totalProfit >= 0 ? '#059669' : '#e11d48', marginBottom: 4 }}>
                {formatWon(totalProfit)}
                {marginRate !== null && (
                  <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 6 }}>({marginRate}%)</span>
                )}
                <YoyBadge pct={yoyProfitPct} />
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 4 }}>작년 {formatWon(prevYearTotalProfit)}</div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 6 }}>
                원가 {costPct}% · 택배비 {shippingPct}% · 광고비 {adPct}% · 수수료 {feePct}%
              </div>
              {marginRateExAd !== null && (
                <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 700, lineHeight: 1.5 }}>
                  공헌이익률(광고료 제외) {marginRateExAd}% — 25% 미만 위험 · 35% 미만 주의 · 45%↑ 안정권
                </div>
              )}
            </div>
          </div>

          {uploadMsg && (
            <div style={{ marginBottom: 20, padding: '10px 14px', background: '#fff1f2', borderRadius: 10, fontSize: 13, color: '#e11d48', fontWeight: 600, whiteSpace: 'pre-line' }}>
              ✓ {uploadMsg}
            </div>
          )}

          {/* 선택 월 KPI */}
          <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20, marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <button onClick={() => shiftViewMonth(-1)} style={monthNavBtnStyle}>◀</button>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8' }}>{year}년 {viewMonthIdx + 1}월</span>
              <button onClick={() => shiftViewMonth(1)} style={monthNavBtnStyle}>▶</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 20 }}>
              <div style={{ background: '#f8fafc', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 14, color: '#000000', fontWeight: 700, marginBottom: 6 }}>{year}년 {viewMonthIdx + 1}월 매출액</div>
                <div style={{ fontSize: 20, fontWeight: 800 }}>
                  {formatWon(mGross)}
                  <YoyBadge pct={mYoyGrossPct} />
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>작년 {formatWon(prevMGross)}</div>
              </div>
              <div style={{ background: '#fff1f2', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 14, color: '#000000', fontWeight: 700, marginBottom: 6 }}>순매출액</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#2563eb' }}>
                  {formatWon(mNet)}
                  <YoyBadge pct={mYoyNetPct} />
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>작년 {formatWon(prevMNet)}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <span style={{ fontSize: 11, color: '#e11d48', fontWeight: 700 }}>- {formatWon(mFee)}</span>
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>수수료</span>
                </div>
              </div>
              <div style={{ background: mProfit >= 0 ? '#eff6ff' : '#fff1f2', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 14, color: '#000000', fontWeight: 700, marginBottom: 6 }}>순수익 (공헌이익)</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: mProfit >= 0 ? '#059669' : '#e11d48' }}>
                  {formatWon(mProfit)}
                  <YoyBadge pct={mYoyProfitPct} />
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 4 }}>작년 {formatWon(prevMProfit)}</div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{chartYear}년 월별 매출</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => shiftChartYear(-1)} style={monthNavBtnStyle}>◀</button>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8' }}>{chartYear}년</span>
                <button onClick={() => shiftChartYear(1)} style={monthNavBtnStyle}>▶</button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
              매출액 {chartHasPrevYearData ? `· ${chartYear - 1}년 매출(비교)` : ''}
            </div>
            {chartLoading ? <div className="loading">로딩 중...</div> : (!chartHasData && !chartHasPrevYearData) ? (
              <div className="chart-empty">{chartYear}년 데이터가 없습니다</div>
            ) : (
              <>
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={monthlyChartData} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 13 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(v / 10000)}만`} />
                  <Tooltip formatter={(v: any) => formatWon(Number(v))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="매출" fill="#f43f5e" radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="매출" content={renderRevenueLabel} />
                  </Bar>
                  {chartHasPrevYearData && <Bar dataKey="작년매출" fill="#94a3b8" radius={[4, 4, 0, 0]} />}
                </BarChart>
              </ResponsiveContainer>

              <div style={{ fontWeight: 700, fontSize: 15, marginTop: 24, marginBottom: 4 }}>{chartYear}년 월별 판매수량</div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
                순수 판매 건수 {chartHasPrevYearData ? `· ${chartYear - 1}년 판매건수(비교)` : ''}
              </div>
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={qtyChartData} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 13 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: number) => `${v}건`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="판매수량" fill="#f59e0b" radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="판매수량" position="top" formatter={(v: number) => v ? `${v}건` : ''} style={{ fontSize: 9, fill: '#f59e0b', fontWeight: 700 }} />
                  </Bar>
                  {chartHasPrevYearData && (
                    <Bar dataKey="작년판매수량" fill="#94a3b8" radius={[4, 4, 0, 0]}>
                      <LabelList dataKey="작년판매수량" position="top" formatter={(v: number) => v ? `${v}건` : ''} style={{ fontSize: 9, fill: '#64748b', fontWeight: 700 }} />
                    </Bar>
                  )}
                </BarChart>
              </ResponsiveContainer>
              </>
            )}
          </div>

          {/* 베스트 상품 + 카테고리별 판매량 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
            <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>REKET 베스트 상품 순위</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <select value={bestYearFilter} onChange={e => setBestYearFilter(e.target.value)}
                    style={{ border: '1px solid #94a3b8', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 6, fontFamily: 'inherit' }}>
                    <option value="전체">전체 연도</option>
                    {availableBestYears.map(y => (
                      <option key={y} value={String(y)}>{y}년</option>
                    ))}
                  </select>
                  <select value={bestItemSeasonFilter} onChange={e => setBestItemSeasonFilter(e.target.value)}
                    style={{ border: '1px solid #94a3b8', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 6, fontFamily: 'inherit' }}>
                    <option value="전체">전체 시즌</option>
                    {Array.from(new Set(bestItems.map(it => it.season))).sort((a, b) => seasonSortValue(b) - seasonSortValue(a)).map(s => (
                      <option key={s} value={s}>{s}</option>
                    ))}
                  </select>
                  <button onClick={() => setShowByOption(v => !v)}
                    style={{ border: '1px solid #94a3b8', background: showByOption ? '#fff1f2' : '#fff', color: '#e11d48', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6 }}>
                    {showByOption ? '스타일넘버로 통합보기' : '옵션별로 보기'}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
                주문 건수 기준 ({bestYearFilter === '전체' ? '전체 연도' : `${bestYearFilter}년`}){showByOption ? ' · 옵션별' : ' · 스타일넘버 기준 통합'} · 스크롤로 전체 확인
              </div>
              {(() => {
                const filtered = bestItemSeasonFilter === '전체' ? bestItems : bestItems.filter(it => it.season === bestItemSeasonFilter)
                if (filtered.length === 0) return <div className="chart-empty">데이터 없음</div>

                type Row = { key: string; item_name: string; style_no: string; option_name: string; qty: number; revenue: number; netRevenue: number; profit: number }
                let displayRows: Row[]
                if (showByOption) {
                  displayRows = []
                  filtered.forEach(it => {
                    Array.from(it.options.entries()).forEach(([opt, v]) => {
                      displayRows.push({ key: `${it.key}__${opt}`, item_name: it.item_name, style_no: it.style_no, option_name: opt, qty: v.qty, revenue: v.revenue, netRevenue: v.netRevenue, profit: v.profit })
                    })
                  })
                  displayRows.sort((a, b) => b.qty - a.qty)
                } else {
                  displayRows = filtered.map(it => ({ key: it.key, item_name: it.item_name, style_no: it.style_no, option_name: '-', qty: it.qty, revenue: it.revenue, netRevenue: it.netRevenue, profit: it.profit }))
                    .sort((a, b) => b.qty - a.qty)
                }

                return (
                  <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: '#f8fafc' }}>
                          {(showByOption ? ['순위', '상품명', '스타일넘버', '옵션', '건수', '매출', '순매출', '순수익'] : ['순위', '상품명', '스타일넘버', '건수', '매출', '순매출', '순수익']).map(h => (
                            <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', fontSize: 11, color: '#94a3b8', fontWeight: 700, position: 'sticky', top: 0, background: '#f8fafc' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {displayRows.map((it, i) => (
                          <tr key={it.key} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: i < 3 ? '#e11d48' : '#94a3b8' }}>{i + 1}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>{it.item_name}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b', fontFamily: 'monospace' }}>{it.style_no}</td>
                            {showByOption && <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{it.option_name}</td>}
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: '#e11d48' }}>{it.qty}건</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: '#000000' }}>{formatWon(it.revenue)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: '#2563eb' }}>{formatWon(it.netRevenue)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: it.profit >= 0 ? '#059669' : '#e11d48' }}>{formatWon(it.profit)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              })()}
            </div>

            <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>카테고리별 판매량</div>
                <select value={bestYearFilter} onChange={e => setBestYearFilter(e.target.value)}
                  style={{ border: '1px solid #94a3b8', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 6, fontFamily: 'inherit' }}>
                  <option value="전체">전체 연도</option>
                  {availableBestYears.map(y => (
                    <option key={y} value={String(y)}>{y}년</option>
                  ))}
                </select>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>{bestYearFilter === '전체' ? '전체 연도' : `${bestYearFilter}년`} 기준, 재고 카테고리와 매칭</div>
              {categorySales.length === 0 ? (
                <div className="chart-empty" style={{ height: 120 }}>정산내역을 먼저 업로드해주세요</div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={categorySales.map(c => ({ name: c.category, 판매량: c.qty }))} layout="vertical" margin={{ left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={70} />
                      <Tooltip formatter={(v: number) => `${v}건`} />
                      <Bar dataKey="판매량" fill="#8b5cf6" radius={[0, 4, 4, 0]}>
                        <LabelList dataKey="판매량" position="right" formatter={(v: number) => v ? `${v}건` : ''} style={{ fontSize: 11, fill: '#8b5cf6', fontWeight: 700 }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
                    {categorySales.map((c, i) => (
                      <div key={c.category} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', background: '#f8fafc', borderRadius: 10 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: i < 3 ? '#8b5cf6' : '#94a3b8', width: 20 }}>{i + 1}</span>
                        <div style={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{c.category}</div>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#8b5cf6' }}>{c.qty}건</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {showOrderModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setShowOrderModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 1200, height: 700, overflow: 'auto', flexShrink: 0 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>REKET 일별 주문표</div>
              <button onClick={() => setShowOrderModal(false)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#94a3b8', lineHeight: 1 }}>×</button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <button onClick={() => shiftOrderMonth(-1)} style={monthNavBtnStyle}>◀</button>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{orderYear}년 {orderMonthIdx + 1}월</span>
              <button onClick={() => shiftOrderMonth(1)} style={monthNavBtnStyle}>▶</button>
            </div>

            {orderLoading ? (
              <div className="loading">로딩 중...</div>
            ) : orderRows.length === 0 ? (
              <div className="chart-empty">이 달에는 등록된 주문 내역이 없습니다</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      {['날짜', '시즌', '상품명', '스타일넘버', '옵션', '판매가', '할인율', '할인금액', '판매금액', '원가', '적용수수료율', '정산액', '순수익'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', color: '#94a3b8', fontWeight: 700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orderRows.map((r: any) => {
                      const { discountRate, feeRate, fee, net } = computeLineFee(r.sale_amount || 0, r.discount_amount || 0)
                      const profit = net - (r.matched_cost || 0) - shippingRateFor(r.settle_date || '')
                      const matchedItem = catIndexAll.find(r.style_no || '', r.item_name || '', r.option_name || '')
                      return (
                        <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.settle_date}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{matchedItem?.season || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.item_name || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontFamily: 'monospace', color: r.cost_matched ? undefined : '#d97706' }} title={r.cost_matched ? '재고 매칭됨' : '재고 미매칭 — 원가 0으로 처리됨'}>{r.style_no || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.option_name || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon((r.sale_amount || 0) + (r.discount_amount || 0))}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{Math.round(discountRate * 1000) / 10}%</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#e11d48' }}>{formatWon(r.discount_amount)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(r.sale_amount)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: r.cost_matched ? undefined : '#d97706', fontWeight: r.cost_matched ? undefined : 700 }}>
                            {r.cost_matched ? formatWon(r.matched_cost) : '미매칭'}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#94a3b8' }}>{Math.round(feeRate * 1000) / 10}%</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(net)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: profit >= 0 ? '#059669' : '#e11d48' }}>{formatWon(profit)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {showCostModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setShowCostModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 800, height: 700, overflow: 'auto', flexShrink: 0 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>아이템별 원가 확인</div>
              <button onClick={() => setShowCostModal(false)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#94a3b8', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
              {year}년 전체 · 매칭 안 된 상품은 주황색으로 표시돼요 (재고 상품명·옵션 표기를 확인해보세요)
            </div>
            {costLoading ? (
              <div className="loading">로딩 중...</div>
            ) : costRows.length === 0 ? (
              <div className="chart-empty">데이터가 없습니다</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {['상품명(스타일넘버)', '건수', '매칭 원가', '매칭 상태'].map(h => (
                      <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', color: '#94a3b8', fontWeight: 700 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {costRows.map(r => (
                    <tr key={r.key} style={{ borderBottom: '1px solid #f1f5f9', background: r.matched ? undefined : '#fff7ed' }}>
                      <td style={{ padding: '8px 10px' }}>{r.itemName}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.qty}건</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(r.cost)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                        {r.matched ? <span style={{ color: '#059669', fontWeight: 700 }}>✓ 매칭됨</span> : <span style={{ color: '#d97706', fontWeight: 700 }}>⚠ 미매칭 (원가 0)</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const yearBtnStyle: React.CSSProperties = {
  background: '#f8fafc', border: '1px solid #94a3b8', borderRadius: 8,
  padding: '3px 9px', cursor: 'pointer', fontSize: 11, fontWeight: 700,
}
const monthNavBtnStyle: React.CSSProperties = {
  background: '#fff', border: '1px solid #94a3b8', borderRadius: 6,
  padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#475569',
}