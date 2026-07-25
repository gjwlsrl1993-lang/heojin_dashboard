'use client'

import { useEffect, useState, useRef } from 'react'
import { supabase } from '@/lib/supabase'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, LabelList } from 'recharts'

const CHANNEL_NAME = '카페24'
const FEE_RATE = 0.035 // PG 수수료
const MONTH_LABELS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월']
const CURRENT_SHIPPING_FEE = 2990

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
  // 구분자 없는 순수 숫자 형식: "260625"(YYMMDD) 혹은 "20260625"(YYYYMMDD), 뒤에 시간이 붙어도 인식
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

// 재고(items) 테이블을 여러 단계로 인덱싱해서, 스타일넘버+옵션이 정확히 일치하지 않아도
// 스타일넘버만으로, 혹은 상품명으로 폴백 매칭될 수 있게 해주는 헬퍼.
// 기존 버그: 재고쪽 option_name은 그대로("FREE" 등) 두고, 업로드 파일 쪽 옵션만
// normalizeOption()으로 변환("F")하다보니 스타일넘버가 완전히 같아도 옵션 표기가
// 다르면 매칭 자체가 실패했음. 아래는 양쪽 다 같은 규칙으로 정규화하고,
// 그래도 안 맞으면 스타일넘버만으로도 매칭되도록 단계적으로 폴백한다.
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
    if (sku && bySkuOnly.has(sku)) return bySkuOnly.get(sku) // 스타일넘버만 같아도 매칭 (원가는 보통 옵션 무관 동일)
    if (name && byNameOption.has(`${name}__${opt}`)) return byNameOption.get(`${name}__${opt}`)
    if (name && byNameOnly.has(name)) return byNameOnly.get(name)
    if (sku && byLooseSku.has(looseSku(sku))) return byLooseSku.get(looseSku(sku)) // 공백/하이픈 차이 무시
    return undefined
  }

  return { find }
}

export default function Cafe24Page() {
  const [year, setYear] = useState(new Date().getFullYear())
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const [monthlyGross, setMonthlyGross] = useState<number[]>(new Array(12).fill(0))
  const [monthlyDiscount, setMonthlyDiscount] = useState<number[]>(new Array(12).fill(0))
  const [monthlyCost, setMonthlyCost] = useState<number[]>(new Array(12).fill(0))
  const [monthlyShipping, setMonthlyShipping] = useState<number[]>(new Array(12).fill(0))
  const [monthlyQty, setMonthlyQty] = useState<number[]>(new Array(12).fill(0))
  const [monthlyQtySale, setMonthlyQtySale] = useState<number[]>(new Array(12).fill(0))
  const [monthlyQtyRefund, setMonthlyQtyRefund] = useState<number[]>(new Array(12).fill(0))
  const [hasData, setHasData] = useState(false)
  const [viewMonthIdx, setViewMonthIdx] = useState(new Date().getMonth())

  const [bestItems, setBestItems] = useState<{ key: string; item_name: string; style_no: string; season: string; qty: number; revenue: number; cost: number; options: Map<string, { qty: number; revenue: number; cost: number }> }[]>([])
  const [categorySales, setCategorySales] = useState<{ category: string; qty: number }[]>([])
  const [showByOption, setShowByOption] = useState(false)
  const [bestItemSeasonFilter, setBestItemSeasonFilter] = useState('전체')
  const [yoyDashboardPct, setYoyDashboardPct] = useState<number | null>(null)
  const [monthlyPrevYearGross, setMonthlyPrevYearGross] = useState<number[]>(new Array(12).fill(0))
  const [monthlyPrevYearNet, setMonthlyPrevYearNet] = useState<number[]>(new Array(12).fill(0))
  const [monthlyPrevYearProfit, setMonthlyPrevYearProfit] = useState<number[]>(new Array(12).fill(0))
  const [insightsExpanded, setInsightsExpanded] = useState(false)
  const [claudeLoading, setClaudeLoading] = useState(false)
  const [claudeResult, setClaudeResult] = useState('')

  // 베스트 상품 순위 / 카테고리별 판매량 전용 — 연간 KPI의 year와 별개로, 기본값은 "전체" 기간
  const [rankYearFilter, setRankYearFilter] = useState<string>('전체')
  const [rankLoading, setRankLoading] = useState(true)
  const [availableYears, setAvailableYears] = useState<number[]>([])

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
  useEffect(() => { loadRankingData(rankYearFilter) }, [rankYearFilter])

  async function loadData() {
    setLoading(true)
    const { data: lineRows } = await supabase
      .from('cafe24_settlement_lines')
      .select('settle_date, sale_amount, discount_amount, matched_cost, item_name, style_no, option_name, cost_matched')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', `${year}-01-01`)
      .lte('settle_date', `${year}-12-31`)

    const grossArr = new Array(12).fill(0)
    const discountArr = new Array(12).fill(0)
    const costArr = new Array(12).fill(0)
    const shippingArr = new Array(12).fill(0)
    const qtyArr = new Array(12).fill(0)
    const qtySaleArr = new Array(12).fill(0)
    const qtyRefundArr = new Array(12).fill(0)

    ;(lineRows || []).forEach((row: any) => {
      const m = new Date(row.settle_date).getMonth()
      grossArr[m] += row.sale_amount || 0
      discountArr[m] += row.discount_amount || 0
      costArr[m] += row.matched_cost || 0
      shippingArr[m] += CURRENT_SHIPPING_FEE
      qtyArr[m] += 1
      // 판매금액이 음수면 환불(반품) 건으로 취급 (자사몰 파일에는 별도 구분 컬럼이 없어서 부호로 판단)
      if ((row.sale_amount || 0) < 0) qtyRefundArr[m] += 1
      else qtySaleArr[m] += 1
    })

    setMonthlyQtySale(qtySaleArr)
    setMonthlyQtyRefund(qtyRefundArr)
    setMonthlyGross(grossArr)
    setMonthlyDiscount(discountArr)
    setMonthlyCost(costArr)
    setMonthlyShipping(shippingArr)
    setMonthlyQty(qtyArr)
    setHasData((lineRows || []).length > 0)

    // 전년 대비 매출/순매출/순수익 (연간 총계 + 월별 비교 둘 다 계산 — 데이터 없으면 0으로 처리)
    const prevYear = year - 1
    const { data: prevRows } = await supabase
      .from('cafe24_settlement_lines')
      .select('settle_date, sale_amount, matched_cost')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', `${prevYear}-01-01`)
      .lte('settle_date', `${prevYear}-12-31`)
    const prevGrossArr = new Array(12).fill(0)
    const prevCostArr = new Array(12).fill(0)
    const prevShippingArr = new Array(12).fill(0)
    ;(prevRows || []).forEach((r: any) => {
      const m = new Date(r.settle_date).getMonth()
      prevGrossArr[m] += r.sale_amount || 0
      prevCostArr[m] += r.matched_cost || 0
      prevShippingArr[m] += CURRENT_SHIPPING_FEE
    })
    const prevNetArr = prevGrossArr.map(g => g - Math.round(g * FEE_RATE))
    const prevProfitArr = prevNetArr.map((n, i) => n - prevCostArr[i] - prevShippingArr[i])
    setMonthlyPrevYearGross(prevGrossArr)
    setMonthlyPrevYearNet(prevNetArr)
    setMonthlyPrevYearProfit(prevProfitArr)
    const prevSum = prevGrossArr.reduce((s, v) => s + v, 0)
    const thisSum = grossArr.reduce((s, v) => s + v, 0)
    setYoyDashboardPct(prevSum > 0 ? Math.round(((thisSum - prevSum) / prevSum) * 1000) / 10 : null)

    setLoading(false)
  }

  // 베스트 상품 순위 / 카테고리별 판매량 — 기본은 "전체" 기간 전부를 집계하고,
  // 드롭다운으로 특정 연도만 골라서 볼 수도 있게 함 (연간 KPI의 year와는 독립적으로 동작)
  async function loadRankingData(yearFilter: string) {
    setRankLoading(true)
    let query = supabase
      .from('cafe24_settlement_lines')
      .select('settle_date, sale_amount, matched_cost, item_name, style_no, option_name')
      .eq('channel', CHANNEL_NAME)
    if (yearFilter !== '전체') {
      query = query.gte('settle_date', `${yearFilter}-01-01`).lte('settle_date', `${yearFilter}-12-31`)
    }
    const { data: lineRows } = await query

    // "전체" 조회 결과에서 실제 존재하는 연도 목록을 뽑아 드롭다운 옵션으로 사용
    if (yearFilter === '전체') {
      const years = Array.from(new Set((lineRows || []).map((r: any) => new Date(r.settle_date).getFullYear())))
        .sort((a, b) => b - a)
      setAvailableYears(years)
    }

    // 재고 카테고리+시즌 조회 (스타일넘버 우선, 상품명 폴백 — 옵션 표기가 달라도 스타일넘버가 같으면 매칭)
    const { data: catItems } = await supabase.from('items').select('sku, name, option_name, category, season')
    const catIndex = buildItemMatchIndex((catItems || []).map((it: any) => ({
      sku: it.sku, name: it.name, option_name: it.option_name, category: it.category, season: it.season,
    })))

    // 스타일넘버 기준으로 묶음 (옵션은 별도 목록으로 함께 저장 → 옵션별 보기 토글에 사용)
    const bestItemMap = new Map<string, { key: string; item_name: string; style_no: string; season: string; qty: number; revenue: number; cost: number; options: Map<string, { qty: number; revenue: number; cost: number }> }>()
    const categoryQtyMap = new Map<string, number>()

    ;(lineRows || []).forEach((row: any) => {
      const info: any = catIndex.find(row.style_no || '', row.item_name || '', row.option_name || '')
      const category = info?.category || '미분류'
      const season = info?.season || '미지정'

      // 스타일넘버(없으면 상품명)로 그룹 묶음 — 같은 스타일넘버는 옵션이 달라도 하나로 합쳐짐
      const groupKey = row.style_no || row.item_name || '(스타일넘버 없음)'
      const prev = bestItemMap.get(groupKey) || {
        key: groupKey, item_name: row.item_name || '(상품명 없음)', style_no: row.style_no || '-',
        season, qty: 0, revenue: 0, cost: 0, options: new Map<string, { qty: number; revenue: number; cost: number }>(),
      }
      const optKey = row.option_name || '-'
      const prevOpt = prev.options.get(optKey) || { qty: 0, revenue: 0, cost: 0 }
      prev.options.set(optKey, { qty: prevOpt.qty + 1, revenue: prevOpt.revenue + (row.sale_amount || 0), cost: prevOpt.cost + (row.matched_cost || 0) })
      bestItemMap.set(groupKey, { ...prev, qty: prev.qty + 1, revenue: prev.revenue + (row.sale_amount || 0), cost: prev.cost + (row.matched_cost || 0) })

      categoryQtyMap.set(category, (categoryQtyMap.get(category) || 0) + 1)
    })

    setBestItems(Array.from(bestItemMap.values()).sort((a, b) => b.qty - a.qty))
    setCategorySales(Array.from(categoryQtyMap.entries()).map(([category, qty]) => ({ category, qty })).sort((a, b) => b.qty - a.qty))
    setRankLoading(false)
  }

  // 매출(판매금액)에서 순수익(공헌이익)을 역산: 순매출액(수수료 반영) - 원가 - 택배비
  function estimateProfit(revenue: number, cost: number, qty: number): number {
    const net = revenue - Math.round(revenue * FEE_RATE)
    return net - cost - qty * CURRENT_SHIPPING_FEE
  }

  async function loadChartData(targetYear: number) {
    setChartLoading(true)
    const { data: curRows } = await supabase
      .from('cafe24_settlement_lines')
      .select('settle_date, sale_amount')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', `${targetYear}-01-01`)
      .lte('settle_date', `${targetYear}-12-31`)
    const grossArr = new Array(12).fill(0)
    const qtySaleArr = new Array(12).fill(0)
    ;(curRows || []).forEach((row: any) => {
      const m = new Date(row.settle_date).getMonth()
      grossArr[m] += row.sale_amount || 0
      // 판매금액이 음수면 환불 건이라 판매수량 집계에서는 제외 (자사몰 파일엔 별도 구분 컬럼이 없어서 부호로 판단)
      if ((row.sale_amount || 0) >= 0) qtySaleArr[m] += 1
    })
    setChartMonthlyGross(grossArr)
    setChartMonthlyQtySale(qtySaleArr)
    setChartHasData((curRows || []).length > 0)

    const prevYear = targetYear - 1
    const { data: prevRows } = await supabase
      .from('cafe24_settlement_lines')
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

  // 선택 월 KPI의 월 이동 — 1월에서 ◀ 누르거나 12월에서 ▶ 누르면 연도까지 같이 넘어가도록
  function shiftViewMonth(delta: number) {
    let nextMonth = viewMonthIdx + delta
    let nextYear = year
    if (nextMonth < 0) { nextMonth = 11; nextYear -= 1 }
    else if (nextMonth > 11) { nextMonth = 0; nextYear += 1 }
    setViewMonthIdx(nextMonth)
    if (nextYear !== year) setYear(nextYear) // year가 바뀌면 useEffect가 loadData()를 다시 호출함
  }

  function parseNum(v: any): number {
    if (v === null || v === undefined || v === '') return 0
    // 콤마(1,000)뿐 아니라 "₩18,000"처럼 통화 기호가 섞여 있어도 숫자만 남기고 다 제거
    // (기존엔 콤마만 제거해서 "₩"가 남으면 parseFloat이 NaN → 0으로 처리되던 버그)
    const cleaned = String(v).replace(/[^0-9.\-]/g, '').trim()
    if (!cleaned || cleaned === '-') return 0
    const n = parseFloat(cleaned)
    return isNaN(n) ? 0 : n
  }

  function parseCsv(text: string): string[][] {
    const clean = text.replace(/^\uFEFF/, '')
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
        name: headers.findIndex(h => h.includes('상품명')),           // 상품명(he.o jin) - 표시/폴백매칭용
        styleNo: headers.findIndex(h => h.includes('스타일넘버')),     // 진짜 스타일넘버 컬럼 (있으면 우선 사용)
        option: headers.findIndex(h => h.includes('상품옵션')),
        amount: headers.findIndex(h => h.includes('상품구매금액')),
        discount: headers.findIndex(h => h.includes('추가할인금액')),
        paid: headers.findIndex(h => h.includes('결제금액')),          // 할인 반영된 실결제액 (없으면 구매금액-할인 계산)
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
        const itemName = rawName.replace(/<br>/gi, ' ').replace(/\s+/g, ' ').trim() // 표시/폴백매칭용
        // 실제 "스타일넘버" 컬럼이 있으면 그 값을 그대로 사용, 없으면(구버전 파일) 상품명에서 만들어냄
        const styleNo = idx.styleNo >= 0
          ? (cells[idx.styleNo] || '').trim()
          : rawName.replace(/<br>/gi, '_').trim()
        const optionName = normalizeOption(cells[idx.option] || '')
        const discountAmount = parseNum(cells[idx.discount])
        // 매출 기준 금액: "결제금액" 컬럼이 있으면 그 값(이미 할인 반영됨) 사용, 없으면 상품구매금액-할인 직접 계산
        const saleAmount = idx.paid >= 0 ? parseNum(cells[idx.paid]) : parseNum(cells[idx.amount]) - discountAmount
        const recipient = (cells[idx.recipient] || '').trim()

        // 스타일넘버(재고 sku)로 우선 매칭, 안 되면 상품명으로, 그래도 안 되면 느슨한 스타일넘버 비교로 폴백
        const matched = itemIndex.find(styleNo, itemName, optionName)
        if (!matched) {
          unmatchedTotal++
          const sample = styleNo || itemName || '(스타일넘버/상품명 없음)'
          if (unmatchedSamples.length < 5 && !unmatchedSamples.includes(sample)) unmatchedSamples.push(sample)
        }
        const matchedCost = matched ? (matched.cost_price || 0) : 0
        const registeredSellPrice = matched ? (matched.sell_price || 0) : 0

        lineRecords.push({
          channel: CHANNEL_NAME,
          settle_date: dateStr,
          style_no: styleNo,
          item_name: itemName,
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
        const { error: delErr } = await supabase.from('cafe24_settlement_lines')
          .delete().eq('channel', CHANNEL_NAME).gte('settle_date', minDate).lte('settle_date', maxDate)
        if (delErr) deleteErrorMsg = `삭제 실패: ${delErr.message}`
      }

      let added = 0, failed = 0, firstError = ''
      if (lineRecords.length > 0) {
        const { error } = await supabase.from('cafe24_settlement_lines').insert(lineRecords)
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
      .from('cafe24_settlement_lines')
      .select('*')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', startDate)
      .lte('settle_date', endDate)
      .order('settle_date', { ascending: true })

    // 시즌은 정산 라인 자체엔 없고 재고(items)에만 있어서, 스타일넘버/상품명으로 매칭해서 붙여줌
    const { data: seasonItems } = await supabase.from('items').select('sku, name, option_name, season')
    const seasonIndex = buildItemMatchIndex((seasonItems || []).map((it: any) => ({
      sku: it.sku, name: it.name, option_name: it.option_name, season: it.season,
    })))
    const rowsWithSeason = (data || []).map((row: any) => {
      const info: any = seasonIndex.find(row.style_no || '', row.item_name || '', row.option_name || '')
      return { ...row, season: info?.season || '미지정' }
    })

    setOrderRows(rowsWithSeason)
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
      .from('cafe24_settlement_lines')
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

  // 규칙 기반 AI 추천 인사이트
  function generateInsights() {
    const sales: string[] = []
    const items: string[] = []

    if (yoyDashboardPct !== null) {
      if (yoyDashboardPct >= 10) sales.push(`${year}년 매출이 전년 대비 ${yoyDashboardPct}% 성장했어요. 잘 팔리는 상품 위주로 재고를 넉넉히 준비해보세요.`)
      else if (yoyDashboardPct <= -10) sales.push(`${year}년 매출이 전년 대비 ${yoyDashboardPct}% 감소했어요. 급감한 시기가 있는지 확인해보세요.`)
      else sales.push(`${year}년 매출은 전년 대비 ${yoyDashboardPct >= 0 ? '+' : ''}${yoyDashboardPct}%로 큰 변화 없이 유지되고 있어요.`)
    }
    if (marginRate !== null) {
      if (marginRate < 0) sales.push(`공헌이익률이 ${marginRate}%로 마이너스예요. 팔수록 손해라는 뜻이라 즉시 원가·판매가 구조를 점검해야 해요. (0% 미만은 위험 신호)`)
      else if (marginRate < 10) sales.push(`공헌이익률이 ${marginRate}%로 낮은 편이에요. 보통 10% 미만이면 원가·수수료·택배비 부담이 커요. "원가 확인" 팝업에서 점검해보세요.`)
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

  async function runClaudeAI() {
    setClaudeLoading(true)
    setClaudeResult('')
    try {
      const insights = generateInsights()
      const bulletLines = [...insights.sales, ...insights.items].map(t => `- ${t}`).join('\n')
      const prompt = `아래는 "${CHANNEL_NAME}" 채널의 ${year}년 매출 데이터를 바탕으로 만든 규칙 기반 인사이트와 핵심 KPI야.\n\n[규칙 기반 인사이트]\n${bulletLines || '(참고할 만한 인사이트 없음)'}\n\n[핵심 KPI]\n- 총 매출액: ${formatWon(totalGross)}\n- 정산금액(순매출액): ${formatWon(totalNet)}\n- 총 판매수량: ${totalNetQty}건\n\n위 내용을 바탕으로 실제 데이터 관점에서 간결한 분석과 구체적인 다음 액션 제안을 한국어로 작성해줘.`

      const res = await fetch('/api/ai-insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      const data = await res.json()
      setClaudeResult(data.text || data.error || '분석 실패')
    } catch {
      setClaudeResult('AI 분석 중 오류가 발생했습니다.')
    } finally {
      setClaudeLoading(false)
    }
  }

  const totalGross = monthlyGross.reduce((s, v) => s + v, 0)
  const totalQtySale = monthlyQtySale.reduce((s, v) => s + v, 0)
  const totalQtyRefund = monthlyQtyRefund.reduce((s, v) => s + v, 0)
  const totalNetQty = totalQtySale - totalQtyRefund
  const totalFee = Math.round(totalGross * FEE_RATE)
  const totalNet = totalGross - totalFee
  const totalCost = monthlyCost.reduce((s, v) => s + v, 0)
  const totalShipping = monthlyShipping.reduce((s, v) => s + v, 0)
  // 순수익(공헌이익)엔 광고비를 포함하지 않음 — 위 안내 문구에도 "광고료 제외"라고 명시
  // 아직 광고를 집행하지 않아서 광고비는 0%로 고정 표시 — 나중에 광고비 데이터가 생기면 실제 값으로 연동
  const totalProfit = totalNet - totalCost - totalShipping
  const marginRate = totalNet > 0 ? Math.round((totalProfit / totalNet) * 1000) / 10 : null
  const totalPrevYearGross = monthlyPrevYearGross.reduce((s, v) => s + v, 0)
  const totalPrevYearNet = monthlyPrevYearNet.reduce((s, v) => s + v, 0)
  const totalPrevYearProfit = monthlyPrevYearProfit.reduce((s, v) => s + v, 0)
  const netYoyPct = totalPrevYearNet > 0 ? Math.round(((totalNet - totalPrevYearNet) / totalPrevYearNet) * 1000) / 10 : null

  const mGross = monthlyGross[viewMonthIdx]
  const mFee = Math.round(mGross * FEE_RATE)
  const mNet = mGross - mFee
  const mCost = monthlyCost[viewMonthIdx]
  const mShipping = monthlyShipping[viewMonthIdx]
  const mProfit = mNet - mCost - mShipping
  const mPrevYearGross = monthlyPrevYearGross[viewMonthIdx]
  const mPrevYearNet = monthlyPrevYearNet[viewMonthIdx]
  const mPrevYearProfit = monthlyPrevYearProfit[viewMonthIdx]
  const mYoyPct = mPrevYearGross > 0 ? Math.round(((mGross - mPrevYearGross) / mPrevYearGross) * 1000) / 10 : null
  const mNetYoyPct = mPrevYearNet > 0 ? Math.round(((mNet - mPrevYearNet) / mPrevYearNet) * 1000) / 10 : null
  const mMarginRate = mNet > 0 ? Math.round((mProfit / mNet) * 1000) / 10 : null

  const monthlyChartData = MONTH_LABELS.map((label, i) => ({ name: label, 매출: chartMonthlyGross[i], 작년매출: chartPrevYearGross[i] }))
  const qtyChartData = MONTH_LABELS.map((label, i) => ({ name: label, 판매수량: chartMonthlyQtySale[i], 작년판매수량: chartPrevYearQtySale[i] }))

  function renderRevenueLabel(props: any) {
    const { x, y, width, value } = props
    if (!value) return null
    return (
      <text x={x + width / 2} y={y - 4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#10b981">
        {value.toLocaleString('ko-KR')}
      </text>
    )
  }

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#10b981', display: 'inline-block' }}></span>
          <h2 className="page-title" style={{ margin: 0 }}>자사몰 (카페24) 손익 & 업로드</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#10b981', fontWeight: 600 }}>수수료 PG {(FEE_RATE * 100).toFixed(1)}%</span>
        </div>
      </div>

      {loading ? <div className="loading">로딩 중...</div> : (
        <>
          {/* AI 추천 인사이트 (맨 위) */}
          {(() => {
            const insights = generateInsights()
            const groups = [
              { title: '📈 매출 현황', items: insights.sales, color: '#10b981' },
              { title: '👕 아이템 피드백', items: insights.items, color: '#8b5cf6' },
            ]
            return (
              <div style={{ background: 'linear-gradient(135deg, #f0fdf4 0%, #eff6ff 100%)', border: '1px solid #94a3b8', borderRadius: 16, padding: 24, marginBottom: 24 }}>
                <div
                  onClick={() => setInsightsExpanded(v => !v)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18 }}>🤖</span>
                    <div style={{ fontWeight: 800, fontSize: 16 }}>AI 추천 인사이트</div>
                  </div>
                  <span style={{ fontSize: 12, color: '#64748b', fontWeight: 700, display: 'flex', alignItems: 'center', gap: 4 }}>
                    {insightsExpanded ? '접기' : '펼치기'}
                    <span style={{ display: 'inline-block', transform: insightsExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.15s' }}>▾</span>
                  </span>
                </div>
                {insightsExpanded && (
                  <>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4, marginBottom: 18 }}>
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

                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                      <div style={{ fontWeight: 700, fontSize: 13, color: '#4f46e5' }}>🤖 Claude AI 분석</div>
                      <button
                        onClick={runClaudeAI}
                        disabled={claudeLoading}
                        style={{
                          border: '1px solid #4f46e5',
                          background: claudeLoading ? '#f8fafc' : '#4f46e5',
                          color: claudeLoading ? '#94a3b8' : '#fff',
                          cursor: claudeLoading ? 'not-allowed' : 'pointer',
                          fontSize: 11,
                          fontWeight: 700,
                          padding: '5px 12px',
                          borderRadius: 8,
                        }}
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

          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <button onClick={() => setYear(y => y - 1)} style={yearBtnStyle}>◀</button>
            <span style={{ fontSize: 15, fontWeight: 700, color: '#94a3b8' }}>{year}년</span>
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
                    style={{ border: '1px solid #bbf7d0', background: '#fff', color: '#059669', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>
                    {uploading ? '업로드 중...' : '📤 업로드'}
                  </button>
                </div>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 26, fontWeight: 800, color: '#000000' }}>{formatWon(totalGross)}</span>
                {yoyDashboardPct !== null && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: yoyDashboardPct >= 0 ? '#059669' : '#e11d48' }}>
                    ({yoyDashboardPct >= 0 ? '+' : ''}{yoyDashboardPct}%)
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>전년도 매출액 {formatWon(totalPrevYearGross)}</div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4 }}>
                결제금액 합계 (할인 반영 후)
                {hasData && (
                  <span style={{ marginLeft: 6, color: '#64748b', fontWeight: 700 }}>
                    {totalNetQty}건 <span style={{ fontWeight: 500, color: '#94a3b8' }}>(판매{totalQtySale}/환불{totalQtyRefund})</span>
                  </span>
                )}
              </div>
            </div>
            <div style={{ background: '#f0fdf4', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 14, color: '#000000', fontWeight: 700 }}>순매출액</span>
                <button onClick={openOrderModal}
                  style={{ border: '1px solid #94a3b8', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>
                  📋 일별 주문표
                </button>
              </div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span style={{ fontSize: 26, fontWeight: 800, color: '#2563eb' }}>{formatWon(totalNet)}</span>
                {netYoyPct !== null && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: netYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                    ({netYoyPct >= 0 ? '+' : ''}{netYoyPct}%)
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, marginBottom: 4 }}>전년도 순매출액 {formatWon(totalPrevYearNet)}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <span style={{ fontSize: 12, color: '#e11d48', fontWeight: 700 }}>- {formatWon(totalFee)}</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>PG 수수료 ({(FEE_RATE * 100).toFixed(1)}%)</span>
              </div>
            </div>
            <div style={{ background: totalProfit >= 0 ? '#eff6ff' : '#fff1f2', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 14, color: '#000000', fontWeight: 700 }}>순수익 (공헌이익)</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={openCostModal}
                    style={{ border: '1px solid #bfdbfe', background: '#fff', color: '#2563eb', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>
                    🔍 원가 확인
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: totalProfit >= 0 ? '#059669' : '#e11d48', marginBottom: 4 }}>
                {formatWon(totalProfit)}
                {marginRate !== null && (
                  <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 6 }}>({marginRate}%)</span>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 4 }}>전년도 순수익 {formatWon(totalPrevYearProfit)}</div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>원가 {formatWon(totalCost)} · 택배비 {formatWon(totalShipping)}</div>
              <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 4 }}>
                원가 {totalGross > 0 ? Math.round((totalCost / totalGross) * 1000) / 10 : 0}% · 택배비 {totalGross > 0 ? Math.round((totalShipping / totalGross) * 1000) / 10 : 0}% · 광고비 0% · 수수료 {totalGross > 0 ? Math.round((totalFee / totalGross) * 1000) / 10 : 0}%
              </div>
              <div style={{ fontSize: 9, color: '#e11d48', marginTop: 2 }}>공헌이익률 45% 미만 위험 · 60% 미만 주의 · 65%↑ 안정권 (광고료 제외)</div>
            </div>
          </div>

          {uploadMsg && (
            <div style={{ marginBottom: 20, padding: '10px 14px', background: '#ecfdf5', borderRadius: 10, fontSize: 13, color: '#059669', fontWeight: 600, whiteSpace: 'pre-line' }}>
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
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 20, fontWeight: 800, color: '#000000' }}>{formatWon(mGross)}</span>
                  {mYoyPct !== null && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: mYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                      ({mYoyPct >= 0 ? '+' : ''}{mYoyPct}%)
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>전년동월 매출액 {formatWon(mPrevYearGross)}</div>
              </div>
              <div style={{ background: '#f0fdf4', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 14, color: '#000000', fontWeight: 700, marginBottom: 6 }}>순매출액</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 20, fontWeight: 800, color: '#2563eb' }}>{formatWon(mNet)}</span>
                  {mNetYoyPct !== null && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: mNetYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                      ({mNetYoyPct >= 0 ? '+' : ''}{mNetYoyPct}%)
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>전년동월 순매출액 {formatWon(mPrevYearNet)}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <span style={{ fontSize: 11, color: '#e11d48', fontWeight: 700 }}>- {formatWon(mFee)}</span>
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>PG 수수료 ({(FEE_RATE * 100).toFixed(1)}%)</span>
                </div>
              </div>
              <div style={{ background: mProfit >= 0 ? '#eff6ff' : '#fff1f2', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 14, color: '#000000', fontWeight: 700, marginBottom: 6 }}>순수익 (공헌이익)</div>
                <div style={{ fontSize: 20, fontWeight: 800, color: mProfit >= 0 ? '#059669' : '#e11d48' }}>
                  {formatWon(mProfit)}
                  {mMarginRate !== null && (
                    <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 6 }}>({mMarginRate}%)</span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>전년동월 순수익 {formatWon(mPrevYearProfit)}</div>
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
            {chartLoading ? <div className="loading">로딩 중...</div> : !chartHasData ? (
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
                  <Bar dataKey="매출" fill="#10b981" radius={[4, 4, 0, 0]}>
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
                  <Tooltip formatter={(v: any) => `${v}건`} />
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
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>자사몰 베스트 상품 순위</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <select value={rankYearFilter} onChange={e => setRankYearFilter(e.target.value)}
                    style={{ border: '1px solid #94a3b8', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 6, fontFamily: 'inherit' }}>
                    <option value="전체">전체 기간</option>
                    {availableYears.map(y => (
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
                    style={{ border: '1px solid #94a3b8', background: showByOption ? '#f0fdf4' : '#fff', color: '#059669', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6 }}>
                    {showByOption ? '스타일넘버로 통합보기' : '옵션별로 보기'}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
                주문 건수 기준 ({rankYearFilter === '전체' ? '전체 기간' : `${rankYearFilter}년`}){showByOption ? ' · 옵션별' : ' · 스타일넘버 기준 통합'} · 스크롤로 전체 확인
              </div>
              {rankLoading ? <div className="loading">로딩 중...</div> : (() => {
                const filtered = bestItemSeasonFilter === '전체' ? bestItems : bestItems.filter(it => it.season === bestItemSeasonFilter)
                if (filtered.length === 0) return <div className="chart-empty">데이터 없음</div>

                type Row = { key: string; item_name: string; style_no: string; option_name: string; qty: number; revenue: number; cost: number }
                let displayRows: Row[]
                if (showByOption) {
                  displayRows = []
                  filtered.forEach(it => {
                    Array.from(it.options.entries()).forEach(([opt, v]) => {
                      displayRows.push({ key: `${it.key}__${opt}`, item_name: it.item_name, style_no: it.style_no, option_name: opt, qty: v.qty, revenue: v.revenue, cost: v.cost })
                    })
                  })
                  displayRows.sort((a, b) => b.qty - a.qty)
                } else {
                  displayRows = filtered.map(it => ({ key: it.key, item_name: it.item_name, style_no: it.style_no, option_name: '-', qty: it.qty, revenue: it.revenue, cost: it.cost }))
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
                        {displayRows.map((it, i) => {
                          const itemNet = it.revenue - Math.round(it.revenue * FEE_RATE)
                          const itemProfit = estimateProfit(it.revenue, it.cost, it.qty)
                          return (
                          <tr key={it.key} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: i < 3 ? '#059669' : '#94a3b8' }}>{i + 1}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>{it.item_name}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b', fontFamily: 'monospace' }}>{it.style_no}</td>
                            {showByOption && <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{it.option_name}</td>}
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: '#059669' }}>{it.qty}건</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(it.revenue)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: '#2563eb' }}>{formatWon(itemNet)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: itemProfit >= 0 ? '#059669' : '#e11d48' }}>{formatWon(itemProfit)}</td>
                          </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )
              })()}
            </div>

            <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>카테고리별 판매량</div>
                <select value={rankYearFilter} onChange={e => setRankYearFilter(e.target.value)}
                  style={{ border: '1px solid #94a3b8', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 6, fontFamily: 'inherit' }}>
                  <option value="전체">전체 기간</option>
                  {availableYears.map(y => (
                    <option key={y} value={String(y)}>{y}년</option>
                  ))}
                </select>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
                {rankYearFilter === '전체' ? '전체 기간' : `${rankYearFilter}년`} 기준, 재고 카테고리와 매칭
              </div>
              {rankLoading ? <div className="loading">로딩 중...</div> : categorySales.length === 0 ? (
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
              <div style={{ fontWeight: 700, fontSize: 16 }}>자사몰 일별 주문표</div>
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
                      {['날짜', '시즌', '상품명', '스타일넘버', '옵션', '판매가', '할인금액', '판매금액', '원가', '정산액(수수료 제외)', '순수익'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', color: '#94a3b8', fontWeight: 700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orderRows.map((r: any) => {
                      const settlement = Math.round((r.sale_amount || 0) * (1 - FEE_RATE))
                      const profit = settlement - (r.matched_cost || 0) - CURRENT_SHIPPING_FEE
                      return (
                        <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.settle_date}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{r.season}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.item_name || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontFamily: 'monospace', color: r.cost_matched ? undefined : '#d97706' }} title={r.cost_matched ? '재고 매칭됨' : '재고 미매칭 — 원가 0으로 처리됨'}>{r.style_no || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.option_name || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon((r.sale_amount || 0) + (r.discount_amount || 0))}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#e11d48' }}>{formatWon(r.discount_amount)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(r.sale_amount)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: r.cost_matched ? undefined : '#d97706', fontWeight: r.cost_matched ? undefined : 700 }}>
                            {r.cost_matched ? formatWon(r.matched_cost) : '미매칭'}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(settlement)}</td>
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
  padding: '6px 12px', cursor: 'pointer', fontSize: 14, fontWeight: 700,
}
const monthNavBtnStyle: React.CSSProperties = {
  background: '#fff', border: '1px solid #94a3b8', borderRadius: 6,
  padding: '4px 10px', cursor: 'pointer', fontSize: 12, fontWeight: 700, color: '#475569',
}