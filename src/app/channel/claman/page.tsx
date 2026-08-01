'use client'

import { useEffect, useState, useRef, useMemo } from 'react'
import { supabase } from '@/lib/supabase'
import * as XLSX from 'xlsx'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, LabelList } from 'recharts'

const CHANNEL_NAME = '클라만'
const FEE_RATE = 0.30 // 위탁 판매 수수료 (오프라인 매장, 할인 연동 없이 고정)
const MONTH_LABELS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월']

// 금액은 항상 1원 단위까지 정확히 표시 (만원 단위로 반올림/축약하지 않음)
function formatWon(n: number): string {
  return (n || 0).toLocaleString('ko-KR') + '원'
}

// "25.11"(YY.MM) 또는 "26.05.12"(YY.MM.DD, 일부 입고 행은 날짜까지 적혀있음) 형태의
// "결제 달"/"입고 일시" 값을 'YYYY-MM'로 변환 (일자가 있어도 월 단위로 뭉침)
function parseYYMM(raw: any): string | null {
  if (raw === null || raw === undefined || raw === '') return null
  const s = typeof raw === 'number' ? raw.toFixed(2) : String(raw).trim()
  const m = /^(\d{1,2})\.(\d{1,2})(?:\.(\d{1,2}))?$/.exec(s)
  if (!m) return null
  const yy = Number(m[1])
  const mm = Number(m[2])
  if (mm < 1 || mm > 12) return null
  return `${2000 + yy}-${String(mm).padStart(2, '0')}`
}

function monthIdxOf(monthStr: string): number {
  return Number((monthStr || '').slice(5, 7)) - 1
}

// "25SS", "25FW", "26SS" 같은 시즌 문자열을 시간순으로 정렬하기 위한 값 계산 (연도*10 + SS:0/FW:1)
function seasonSortValue(season: string): number {
  const match = /^(\d{2})(SS|FW)$/i.exec((season || '').trim())
  if (!match) return -1
  const yy = parseInt(match[1], 10)
  const seasonCode = match[2].toUpperCase() === 'SS' ? 0 : 1
  return yy * 10 + seasonCode
}

function normalizeOption(raw: any): string {
  const v = String(raw ?? '').replace(/^SIZE=/i, '').trim()
  if (v.toUpperCase() === 'FREE') return 'F'
  return v.toUpperCase()
}

function normalizeSku(raw: any): string {
  return String(raw ?? '').trim().toUpperCase()
}

// 스타일넘버 안의 공백/하이픈/언더스코어/탭 차이까지 무시하는 최후 폴백용 키
function looseSku(raw: any): string {
  return normalizeSku(raw).replace(/[\s\-_]/g, '')
}

function parseNum(v: any): number {
  if (v === null || v === undefined || v === '') return 0
  if (typeof v === 'number') return v
  const cleaned = String(v).replace(/[^0-9.\-]/g, '').trim()
  if (!cleaned || cleaned === '-') return 0
  const n = parseFloat(cleaned)
  return isNaN(n) ? 0 : n
}

// 정산액/수수료 계산: 클라만은 할인 연동 없이 고정 30% 수수료
function computeLineFee(saleAmount: number, listPrice: number) {
  const fee = Math.round(saleAmount * FEE_RATE)
  const net = saleAmount - fee
  const discountRate = listPrice > 0 ? Math.max(0, (listPrice - saleAmount) / listPrice) : 0
  return { fee, net, discountRate }
}

// 재고(items) 테이블을 여러 단계로 인덱싱해서, 스타일넘버+옵션이 정확히 일치하지 않아도
// 스타일넘버만으로, 혹은 상품명으로 폴백 매칭될 수 있게 해주는 헬퍼.
function buildItemMatchIndex<T extends {
  sku?: string; name?: string; option_name?: string
  cost_price?: number; sell_price?: number; category?: string; season?: string
}>(items: T[]) {
  const bySkuOption = new Map<string, T>()
  const bySkuOnly = new Map<string, T>()
  const byNameOption = new Map<string, T>()
  const byNameOnly = new Map<string, T>()
  const byLooseSku = new Map<string, T>()

  items.forEach(it => {
    const sku = normalizeSku(it.sku)
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
    : lines.filter((r: any) => r.settle_month && String(r.settle_month).slice(0, 4) === yearFilter)

  const bestItemMap = new Map<string, {
    key: string; item_name: string; style_no: string; season: string
    qty: number; revenue: number; net: number; profit: number
    options: Map<string, { qty: number; revenue: number; net: number; profit: number }>
  }>()
  const categoryQtyMap = new Map<string, number>()

  filtered.forEach((row: any) => {
    const revenue = row.sale_amount || 0
    const { fee, net: lineNet } = computeLineFee(revenue, row.list_price || 0)
    const cost = row.matched_cost || 0
    const profit = revenue - fee - cost

    const info: any = catIndex.find(row.style_no || '', row.item_name || '', row.option_name || '')
    const category = info?.category || '미분류'
    const season = info?.season || '미지정'

    const groupKey = row.style_no || row.item_name || '(스타일넘버 없음)'
    const prev = bestItemMap.get(groupKey) || {
      key: groupKey, item_name: row.item_name || '(상품명 없음)', style_no: row.style_no || '-',
      season, qty: 0, revenue: 0, net: 0, profit: 0, options: new Map<string, { qty: number; revenue: number; net: number; profit: number }>(),
    }
    const optKey = row.option_name || '-'
    const prevOpt = prev.options.get(optKey) || { qty: 0, revenue: 0, net: 0, profit: 0 }
    prev.options.set(optKey, { qty: prevOpt.qty + 1, revenue: prevOpt.revenue + revenue, net: prevOpt.net + lineNet, profit: prevOpt.profit + profit })
    bestItemMap.set(groupKey, { ...prev, qty: prev.qty + 1, revenue: prev.revenue + revenue, net: prev.net + lineNet, profit: prev.profit + profit })

    categoryQtyMap.set(category, (categoryQtyMap.get(category) || 0) + 1)
  })

  return {
    bestItems: Array.from(bestItemMap.values()).sort((a, b) => b.qty - a.qty),
    categorySales: Array.from(categoryQtyMap.entries()).map(([category, qty]) => ({ category, qty })).sort((a, b) => b.qty - a.qty),
  }
}

// 재고 현황(누적입고 - 누적판매) 계산: 전체 기간 데이터 기준, 스타일넘버 단위로 모으고 옵션별 내역은 하위에 보관
// 시즌은 재고(items) 테이블에서 스타일넘버로 매칭해서 붙임
function computeStockBalance(
  stockLines: any[],
  soldLines: any[],
  catIndex: ReturnType<typeof buildItemMatchIndex>
) {
  const stockMap = new Map<string, {
    key: string; item_name: string; style_no: string; season: string
    stockIn: number; lastMonth: string
    options: Map<string, { stockIn: number; lastMonth: string }>
  }>()

  stockLines.forEach((r: any) => {
    const styleKey = normalizeSku(r.style_no) || String(r.item_name || '').toUpperCase() || '(스타일넘버 없음)'
    const optKey = normalizeOption(r.option_name) || '-'
    const info: any = catIndex.find(r.style_no || '', r.item_name || '', r.option_name || '')
    const season = info?.season || '미지정'

    const prev = stockMap.get(styleKey) || {
      key: styleKey, item_name: r.item_name || '(상품명 없음)', style_no: r.style_no || '-',
      season, stockIn: 0, lastMonth: '', options: new Map<string, { stockIn: number; lastMonth: string }>(),
    }
    const prevOpt = prev.options.get(optKey) || { stockIn: 0, lastMonth: '' }
    const optLast = (!prevOpt.lastMonth || (r.stock_month || '') > prevOpt.lastMonth) ? (r.stock_month || prevOpt.lastMonth) : prevOpt.lastMonth
    prev.options.set(optKey, { stockIn: prevOpt.stockIn + 1, lastMonth: optLast })

    const newLast = (!prev.lastMonth || (r.stock_month || '') > prev.lastMonth) ? (r.stock_month || prev.lastMonth) : prev.lastMonth
    stockMap.set(styleKey, { ...prev, stockIn: prev.stockIn + 1, lastMonth: newLast })
  })

  const soldMap = new Map<string, number>()
  const soldOptMap = new Map<string, number>()
  soldLines.forEach((r: any) => {
    const styleKey = normalizeSku(r.style_no) || String(r.item_name || '').toUpperCase() || '(스타일넘버 없음)'
    const optKey = normalizeOption(r.option_name) || '-'
    soldMap.set(styleKey, (soldMap.get(styleKey) || 0) + 1)
    soldOptMap.set(`${styleKey}__${optKey}`, (soldOptMap.get(`${styleKey}__${optKey}`) || 0) + 1)
  })

  return Array.from(stockMap.values()).map(v => {
    const sold = soldMap.get(v.key) || 0
    const optionsOut = new Map<string, { stockIn: number; sold: number; remain: number; lastMonth: string }>()
    Array.from(v.options.entries()).forEach(([opt, ov]) => {
      const optSold = soldOptMap.get(`${v.key}__${opt}`) || 0
      optionsOut.set(opt, { stockIn: ov.stockIn, sold: optSold, remain: ov.stockIn - optSold, lastMonth: ov.lastMonth })
    })
    return { ...v, sold, remain: v.stockIn - sold, options: optionsOut }
  }).sort((a, b) => b.sold - a.sold)
}

export default function ClamanPage() {
  const [year, setYear] = useState(new Date().getFullYear())
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const [uploadingStock, setUploadingStock] = useState(false)
  const [uploadStockMsg, setUploadStockMsg] = useState('')
  const stockFileRef = useRef<HTMLInputElement>(null)

  const [monthlyGross, setMonthlyGross] = useState<number[]>(new Array(12).fill(0))
  const [monthlyFee, setMonthlyFee] = useState<number[]>(new Array(12).fill(0))
  const [monthlyCost, setMonthlyCost] = useState<number[]>(new Array(12).fill(0))
  const [monthlyQtySale, setMonthlyQtySale] = useState<number[]>(new Array(12).fill(0))
  const [monthlyQtyRefund, setMonthlyQtyRefund] = useState<number[]>(new Array(12).fill(0))
  // 전년도(year - 1) 월별 매출/수수료/원가 — 매출액/순매출액/순수익 카드에 전년도 값을 같이 보여주기 위함 (데이터 없으면 0)
  const [prevYearMonthlyGross, setPrevYearMonthlyGross] = useState<number[]>(new Array(12).fill(0))
  const [prevYearMonthlyFee, setPrevYearMonthlyFee] = useState<number[]>(new Array(12).fill(0))
  const [prevYearMonthlyCost, setPrevYearMonthlyCost] = useState<number[]>(new Array(12).fill(0))
  const [hasData, setHasData] = useState(false)
  const [viewMonthIdx, setViewMonthIdx] = useState(new Date().getMonth())

  const [showByOption, setShowByOption] = useState(false)
  const [bestItemSeasonFilter, setBestItemSeasonFilter] = useState('전체')
  const [bestYearFilter, setBestYearFilter] = useState('전체')
  const [allBestLines, setAllBestLines] = useState<any[]>([])
  const [catItemsAll, setCatItemsAll] = useState<any[]>([])
  const [yoyDashboardPct, setYoyDashboardPct] = useState<number | null>(null)

  // 차트 전용 (연도 독립 이동) — 매출/판매수량/입고수량 3개 차트가 이 연도를 공유
  const [chartYear, setChartYear] = useState(new Date().getFullYear())
  const [chartLoading, setChartLoading] = useState(false)
  const [chartMonthlyGross, setChartMonthlyGross] = useState<number[]>(new Array(12).fill(0))
  const [chartMonthlyNet, setChartMonthlyNet] = useState<number[]>(new Array(12).fill(0))
  const [chartPrevYearGross, setChartPrevYearGross] = useState<number[]>(new Array(12).fill(0))
  const [chartMonthlyQty, setChartMonthlyQty] = useState<number[]>(new Array(12).fill(0))
  const [chartPrevYearQty, setChartPrevYearQty] = useState<number[]>(new Array(12).fill(0))
  const [chartHasData, setChartHasData] = useState(false)
  const [chartHasPrevYearData, setChartHasPrevYearData] = useState(false)

  const [chartMonthlyStockIn, setChartMonthlyStockIn] = useState<number[]>(new Array(12).fill(0))
  const [chartPrevYearStockIn, setChartPrevYearStockIn] = useState<number[]>(new Array(12).fill(0))
  const [chartStockHasData, setChartStockHasData] = useState(false)
  const [chartStockHasPrevYearData, setChartStockHasPrevYearData] = useState(false)

  // 월별 판매내역 팝업 (일별 데이터가 없어 "월" 단위로 상세내역 확인)
  const [showOrderModal, setShowOrderModal] = useState(false)
  const [orderYear, setOrderYear] = useState(new Date().getFullYear())
  const [orderMonthIdx, setOrderMonthIdx] = useState(new Date().getMonth())
  const [orderRows, setOrderRows] = useState<any[]>([])
  const [orderLoading, setOrderLoading] = useState(false)

  // 원가 확인 팝업
  const [showCostModal, setShowCostModal] = useState(false)
  const [costRows, setCostRows] = useState<{ key: string; itemName: string; qty: number; cost: number; matched: boolean }[]>([])
  const [costLoading, setCostLoading] = useState(false)

  // 입고(재고) 데이터 — 전체 기간 누적으로 계산해서 항상 아래 표에 표시
  const [stockLinesAll, setStockLinesAll] = useState<any[]>([])
  const [stockLoading, setStockLoading] = useState(true)
  const [showStockByOption, setShowStockByOption] = useState(false)
  const [stockSeasonFilter, setStockSeasonFilter] = useState('전체')

  // 아이템별 입고 수량 그래프 팝업
  const [showStockRankModal, setShowStockRankModal] = useState(false)

  // AI 추천 인사이트 접기/펼치기 (기본은 접힌 상태)
  const [showInsights, setShowInsights] = useState(false)
  // Claude AI 실분석 (규칙 기반 인사이트와 별개로, 버튼을 눌렀을 때만 실제 Claude 호출)
  const [claudeLoading, setClaudeLoading] = useState(false)
  const [claudeResult, setClaudeResult] = useState('')

  // 월별 입고수량 차트 클릭 → 그 달 입고 상세 팝업
  const [showStockMonthModal, setShowStockMonthModal] = useState(false)
  const [stockMonthYear, setStockMonthYear] = useState(new Date().getFullYear())
  const [stockMonthIdx, setStockMonthIdx] = useState(new Date().getMonth())
  const [stockMonthRows, setStockMonthRows] = useState<{ key: string; item_name: string; style_no: string; option_name: string; qty: number }[]>([])
  const [stockMonthLoading, setStockMonthLoading] = useState(false)

  useEffect(() => { loadData() }, [year])
  useEffect(() => { setChartYear(year); loadChartData(year) }, [year])
  // 베스트 상품/카테고리는 연도 셀렉터와 무관하게 전체 기간 데이터를 한 번 불러와서 클라이언트에서 연도 필터링
  useEffect(() => { loadBestSource() }, [])
  useEffect(() => { loadStockSource() }, [])

  async function loadBestSource() {
    const { data: allLines } = await supabase
      .from('claman_settlement_lines')
      .select('settle_month, sale_amount, list_price, matched_cost, item_name, style_no, option_name, cost_matched')
      .eq('channel', CHANNEL_NAME)
    setAllBestLines(allLines || [])

    const { data: catItems } = await supabase.from('items').select('sku, name, option_name, category, season')
    setCatItemsAll(catItems || [])
  }

  async function loadStockSource() {
    setStockLoading(true)
    const { data } = await supabase
      .from('claman_stock_lines')
      .select('stock_month, item_name, style_no, option_name')
      .eq('channel', CHANNEL_NAME)
    setStockLinesAll(data || [])
    setStockLoading(false)
  }

  // 월별 입고수량 그래프의 특정 달을 클릭했을 때 그 달에 뭐가 입고됐는지 보여주는 팝업용 데이터 로드
  async function loadStockMonthRows(targetYear: number, monthIdx: number) {
    setStockMonthLoading(true)
    const monthStr = `${targetYear}-${String(monthIdx + 1).padStart(2, '0')}`
    const { data } = await supabase
      .from('claman_stock_lines')
      .select('item_name, style_no, option_name')
      .eq('channel', CHANNEL_NAME)
      .eq('stock_month', monthStr)
    const map = new Map<string, { key: string; item_name: string; style_no: string; option_name: string; qty: number }>()
    ;(data || []).forEach((row: any) => {
      const key = `${row.style_no || row.item_name}__${row.option_name || '-'}`
      const prev = map.get(key) || { key, item_name: row.item_name || '(상품명 없음)', style_no: row.style_no || '-', option_name: row.option_name || '-', qty: 0 }
      map.set(key, { ...prev, qty: prev.qty + 1 })
    })
    setStockMonthRows(Array.from(map.values()).sort((a, b) => b.qty - a.qty))
    setStockMonthLoading(false)
  }

  function openStockMonthModal(targetYear: number, monthIdx: number) {
    setShowStockMonthModal(true)
    setStockMonthYear(targetYear)
    setStockMonthIdx(monthIdx)
    loadStockMonthRows(targetYear, monthIdx)
  }

  function shiftStockMonth(delta: number) {
    let nextMonth = stockMonthIdx + delta
    let nextYear = stockMonthYear
    if (nextMonth < 0) { nextMonth = 11; nextYear -= 1 }
    else if (nextMonth > 11) { nextMonth = 0; nextYear += 1 }
    setStockMonthIdx(nextMonth)
    setStockMonthYear(nextYear)
    loadStockMonthRows(nextYear, nextMonth)
  }

  async function loadData() {
    setLoading(true)
    const { data: lineRows } = await supabase
      .from('claman_settlement_lines')
      .select('settle_month, sale_amount, list_price, matched_cost, item_name, style_no, option_name, cost_matched')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_month', `${year}-01`)
      .lte('settle_month', `${year}-12`)

    const grossArr = new Array(12).fill(0)
    const feeArr = new Array(12).fill(0)
    const costArr = new Array(12).fill(0)
    const qtySaleArr = new Array(12).fill(0)
    const qtyRefundArr = new Array(12).fill(0)

    ;(lineRows || []).forEach((row: any) => {
      const m = monthIdxOf(row.settle_month)
      if (m < 0 || m > 11) return
      const { fee } = computeLineFee(row.sale_amount || 0, row.list_price || 0)
      grossArr[m] += row.sale_amount || 0
      feeArr[m] += fee
      costArr[m] += row.matched_cost || 0
      if ((row.sale_amount || 0) < 0) qtyRefundArr[m] += 1
      else qtySaleArr[m] += 1
    })

    setMonthlyGross(grossArr)
    setMonthlyFee(feeArr)
    setMonthlyCost(costArr)
    setMonthlyQtySale(qtySaleArr)
    setMonthlyQtyRefund(qtyRefundArr)
    setHasData((lineRows || []).length > 0)

    const prevYear = year - 1
    const { data: prevRows } = await supabase
      .from('claman_settlement_lines')
      .select('settle_month, sale_amount, list_price, matched_cost')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_month', `${prevYear}-01`)
      .lte('settle_month', `${prevYear}-12`)

    const prevGrossArr = new Array(12).fill(0)
    const prevFeeArr = new Array(12).fill(0)
    const prevCostArr = new Array(12).fill(0)
    ;(prevRows || []).forEach((row: any) => {
      const m = monthIdxOf(row.settle_month)
      if (m < 0 || m > 11) return
      const { fee } = computeLineFee(row.sale_amount || 0, row.list_price || 0)
      prevGrossArr[m] += row.sale_amount || 0
      prevFeeArr[m] += fee
      prevCostArr[m] += row.matched_cost || 0
    })
    setPrevYearMonthlyGross(prevGrossArr)
    setPrevYearMonthlyFee(prevFeeArr)
    setPrevYearMonthlyCost(prevCostArr)

    const prevSum = prevGrossArr.reduce((s, v) => s + v, 0)
    const thisSum = grossArr.reduce((s, v) => s + v, 0)
    setYoyDashboardPct(prevSum > 0 ? Math.round(((thisSum - prevSum) / prevSum) * 1000) / 10 : null)

    setLoading(false)
  }

  async function loadChartData(targetYear: number) {
    setChartLoading(true)
    const prevYear = targetYear - 1

    const [curRes, prevRes, curStockRes, prevStockRes] = await Promise.all([
      supabase.from('claman_settlement_lines').select('settle_month, sale_amount')
        .eq('channel', CHANNEL_NAME).gte('settle_month', `${targetYear}-01`).lte('settle_month', `${targetYear}-12`),
      supabase.from('claman_settlement_lines').select('settle_month, sale_amount')
        .eq('channel', CHANNEL_NAME).gte('settle_month', `${prevYear}-01`).lte('settle_month', `${prevYear}-12`),
      supabase.from('claman_stock_lines').select('stock_month')
        .eq('channel', CHANNEL_NAME).gte('stock_month', `${targetYear}-01`).lte('stock_month', `${targetYear}-12`),
      supabase.from('claman_stock_lines').select('stock_month')
        .eq('channel', CHANNEL_NAME).gte('stock_month', `${prevYear}-01`).lte('stock_month', `${prevYear}-12`),
    ])

    const grossArr = new Array(12).fill(0)
    const netArr = new Array(12).fill(0)
    const qtyArr = new Array(12).fill(0)
    ;(curRes.data || []).forEach((row: any) => {
      const m = monthIdxOf(row.settle_month)
      if (m < 0 || m > 11) return
      const { fee } = computeLineFee(row.sale_amount || 0, 0)
      grossArr[m] += row.sale_amount || 0
      netArr[m] += (row.sale_amount || 0) - fee
      if ((row.sale_amount || 0) >= 0) qtyArr[m] += 1
    })
    setChartMonthlyGross(grossArr)
    setChartMonthlyNet(netArr)
    setChartMonthlyQty(qtyArr)
    setChartHasData((curRes.data || []).length > 0)

    const prevArr = new Array(12).fill(0)
    const prevQtyArr = new Array(12).fill(0)
    ;(prevRes.data || []).forEach((row: any) => {
      const m = monthIdxOf(row.settle_month)
      if (m < 0 || m > 11) return
      prevArr[m] += row.sale_amount || 0
      if ((row.sale_amount || 0) >= 0) prevQtyArr[m] += 1
    })
    setChartPrevYearGross(prevArr)
    setChartPrevYearQty(prevQtyArr)
    setChartHasPrevYearData((prevRes.data || []).length > 0)

    const stockInArr = new Array(12).fill(0)
    ;(curStockRes.data || []).forEach((row: any) => {
      const m = monthIdxOf(row.stock_month)
      if (m < 0 || m > 11) return
      stockInArr[m] += 1
    })
    setChartMonthlyStockIn(stockInArr)
    setChartStockHasData((curStockRes.data || []).length > 0)

    const prevStockInArr = new Array(12).fill(0)
    ;(prevStockRes.data || []).forEach((row: any) => {
      const m = monthIdxOf(row.stock_month)
      if (m < 0 || m > 11) return
      prevStockInArr[m] += 1
    })
    setChartPrevYearStockIn(prevStockInArr)
    setChartStockHasPrevYearData((prevStockRes.data || []).length > 0)

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

  // xlsx 파일을 [헤더행, 데이터행...] 형태의 2차원 배열로 읽기
  async function readSheetRows(file: File): Promise<any[][]> {
    const buf = await file.arrayBuffer()
    const wb = XLSX.read(buf, { type: 'array' })
    const sheet = wb.Sheets[wb.SheetNames[0]]
    return XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '', raw: true }) as any[][]
  }

  // 판매(정산) 파일 업로드 — "클라만 포멧" 시트: 결제 달 / 상품명 / 스타일넘버 / 상품옵션 / 판매가 / 결제금액
  async function handleUpload(file: File) {
    setUploading(true)
    try {
      const rows = await readSheetRows(file)
      if (rows.length < 2) { setUploadMsg('파일에 데이터가 없습니다.'); setUploading(false); return }
      const headers = rows[0].map((h: any) => String(h || '').trim())
      const idx = {
        month: headers.findIndex(h => h.includes('결제') && h.includes('달')),
        name: headers.findIndex(h => h.includes('상품명')),
        styleNo: headers.findIndex(h => h.includes('스타일넘버')),
        option: headers.findIndex(h => h.replace(/\s/g, '').includes('상품옵션')),
        listPrice: headers.findIndex(h => h.includes('판매가')),
        paid: headers.findIndex(h => h.includes('결제금액')),
      }

      const { data: allItems } = await supabase.from('items').select('sku, name, option_name, cost_price, sell_price')
      const itemIndex = buildItemMatchIndex(allItems || [])

      const lineRecords: any[] = []
      let minMonth = '', maxMonth = ''
      let unmatchedTotal = 0
      const unmatchedSamples: string[] = []

      for (let i = 1; i < rows.length; i++) {
        const cells = rows[i]
        const monthStr = parseYYMM(idx.month >= 0 ? cells[idx.month] : '')
        if (!monthStr) continue
        if (!minMonth || monthStr < minMonth) minMonth = monthStr
        if (!maxMonth || monthStr > maxMonth) maxMonth = monthStr

        const rawName = String(cells[idx.name] ?? '').trim()
        const itemName = rawName.replace(/<br>/gi, ' ').replace(/\s+/g, ' ').trim()
        const styleNo = idx.styleNo >= 0 ? String(cells[idx.styleNo] ?? '').trim() : ''
        const optionName = normalizeOption(cells[idx.option])
        const listPrice = parseNum(cells[idx.listPrice])
        const saleAmount = parseNum(cells[idx.paid])

        const matched = itemIndex.find(styleNo, itemName, optionName)
        if (!matched) {
          unmatchedTotal++
          const sample = styleNo || itemName || '(스타일넘버/상품명 없음)'
          if (unmatchedSamples.length < 5 && !unmatchedSamples.includes(sample)) unmatchedSamples.push(sample)
        }
        const matchedCost = matched ? (matched.cost_price || 0) : 0
        const registeredSellPrice = matched ? (matched.sell_price || 0) : 0
        const displayName = (matched?.name ? String(matched.name).trim() : '') || itemName

        lineRecords.push({
          channel: CHANNEL_NAME,
          settle_month: monthStr,
          style_no: styleNo,
          item_name: displayName,
          option_name: optionName,
          list_price: listPrice,
          sale_amount: saleAmount,
          matched_cost: matchedCost,
          cost_matched: !!matched,
          registered_sell_price: registeredSellPrice,
        })
      }

      let deleteErrorMsg = ''
      if (minMonth && maxMonth) {
        const { error: delErr } = await supabase.from('claman_settlement_lines')
          .delete().eq('channel', CHANNEL_NAME).gte('settle_month', minMonth).lte('settle_month', maxMonth)
        if (delErr) deleteErrorMsg = `삭제 실패: ${delErr.message}`
      }

      let added = 0, failed = 0, firstError = ''
      if (lineRecords.length > 0) {
        const { error } = await supabase.from('claman_settlement_lines').insert(lineRecords)
        if (error) { failed = lineRecords.length; firstError = error.message }
        else added = lineRecords.length
      }

      setUploadMsg(
        `업로드 완료: ${added}건 반영 / ${failed}건 실패` +
        (unmatchedTotal > 0 ? `\n⚠ 재고 미매칭 ${unmatchedTotal}건 (예: ${unmatchedSamples.map(s => `"${s}"`).join(', ')}) — "원가 확인" 팝업에서 확인해보세요` : '') +
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

  // 입고 파일 업로드 — "클라만 입고" 시트: 입고 일시 / 상품명 / 스타일넘버 / 상품 옵션 (1행 = 1개 입고, 수량 컬럼 없음)
  async function handleStockUpload(file: File) {
    setUploadingStock(true)
    try {
      const rows = await readSheetRows(file)
      if (rows.length < 2) { setUploadStockMsg('파일에 데이터가 없습니다.'); setUploadingStock(false); return }
      const headers = rows[0].map((h: any) => String(h || '').trim())
      const idx = {
        month: headers.findIndex(h => h.includes('입고')),
        name: headers.findIndex(h => h.includes('상품명')),
        styleNo: headers.findIndex(h => h.includes('스타일넘버')),
        option: headers.findIndex(h => h.replace(/\s/g, '').includes('상품옵션')),
      }

      const { data: allItems } = await supabase.from('items').select('sku, name, option_name')
      const itemIndex = buildItemMatchIndex(allItems || [])

      const stockRecords: any[] = []
      let minMonth = '', maxMonth = ''

      for (let i = 1; i < rows.length; i++) {
        const cells = rows[i]
        const monthStr = parseYYMM(idx.month >= 0 ? cells[idx.month] : '')
        if (!monthStr) continue
        if (!minMonth || monthStr < minMonth) minMonth = monthStr
        if (!maxMonth || monthStr > maxMonth) maxMonth = monthStr

        const rawName = String(cells[idx.name] ?? '').trim()
        const itemName = rawName.replace(/<br>/gi, ' ').replace(/\s+/g, ' ').trim()
        const styleNo = idx.styleNo >= 0 ? String(cells[idx.styleNo] ?? '').trim() : ''
        const optionName = normalizeOption(cells[idx.option])

        const matched = itemIndex.find(styleNo, itemName, optionName)
        const displayName = (matched?.name ? String(matched.name).trim() : '') || itemName

        stockRecords.push({
          channel: CHANNEL_NAME,
          stock_month: monthStr,
          style_no: styleNo,
          item_name: displayName,
          option_name: optionName,
        })
      }

      let deleteErrorMsg = ''
      if (minMonth && maxMonth) {
        const { error: delErr } = await supabase.from('claman_stock_lines')
          .delete().eq('channel', CHANNEL_NAME).gte('stock_month', minMonth).lte('stock_month', maxMonth)
        if (delErr) deleteErrorMsg = `삭제 실패: ${delErr.message}`
      }

      let added = 0, failed = 0, firstError = ''
      if (stockRecords.length > 0) {
        const { error } = await supabase.from('claman_stock_lines').insert(stockRecords)
        if (error) { failed = stockRecords.length; firstError = error.message }
        else added = stockRecords.length
      }

      setUploadStockMsg(
        `입고 업로드 완료: ${added}건 반영 / ${failed}건 실패` +
        (firstError ? `\n오류: ${firstError}` : '') + (deleteErrorMsg ? `\n${deleteErrorMsg}` : '')
      )
      loadStockSource()
      loadChartData(chartYear)
    } catch (e: any) {
      console.error(e)
      setUploadStockMsg('파일 처리 중 오류가 발생했습니다.\n' + (e?.message || String(e)))
    } finally {
      setUploadingStock(false)
      if (stockFileRef.current) stockFileRef.current.value = ''
    }
  }

  async function loadOrderRows(targetYear: number, monthIdx: number) {
    setOrderLoading(true)
    const monthStr = `${targetYear}-${String(monthIdx + 1).padStart(2, '0')}`
    const { data } = await supabase
      .from('claman_settlement_lines')
      .select('*')
      .eq('channel', CHANNEL_NAME)
      .eq('settle_month', monthStr)
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
      .from('claman_settlement_lines')
      .select('item_name, matched_cost, cost_matched')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_month', `${year}-01`)
      .lte('settle_month', `${year}-12`)
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
    allBestLines.forEach((r: any) => { if (r.settle_month) set.add(Number(String(r.settle_month).slice(0, 4))) })
    return Array.from(set).sort((a, b) => b - a)
  }, [allBestLines])

  const stockBalance = useMemo(
    () => computeStockBalance(stockLinesAll, allBestLines, catIndexAll),
    [stockLinesAll, allBestLines, catIndexAll]
  )
  const availableStockSeasons = useMemo(() => {
    return Array.from(new Set(stockBalance.map(it => it.season))).sort((a, b) => seasonSortValue(b) - seasonSortValue(a))
  }, [stockBalance])
  const totalStockIn = stockBalance.reduce((s, r) => s + r.stockIn, 0)
  const totalStockRemain = stockBalance.reduce((s, r) => s + r.remain, 0)

  function generateInsights() {
    const sales: string[] = []
    const items: string[] = []
    const stock: string[] = []

    if (yoyDashboardPct !== null) {
      if (yoyDashboardPct >= 10) sales.push(`${year}년 매출이 전년 대비 ${yoyDashboardPct}% 성장했어요. 잘 팔리는 상품 위주로 재고를 넉넉히 준비해보세요.`)
      else if (yoyDashboardPct <= -10) sales.push(`${year}년 매출이 전년 대비 ${yoyDashboardPct}% 감소했어요. 급감한 시기가 있는지 확인해보세요.`)
      else sales.push(`${year}년 매출은 전년 대비 ${yoyDashboardPct >= 0 ? '+' : ''}${yoyDashboardPct}%로 큰 변화 없이 유지되고 있어요.`)
    }
    if (marginRate !== null) {
      if (marginRate < 25) sales.push(`공헌이익률이 ${marginRate}%로 위험 구간(25% 미만)이에요. 즉시 원가·수수료 구조를 점검해야 해요. (광고료 제외 기준)`)
      else if (marginRate < 35) sales.push(`공헌이익률이 ${marginRate}%로 주의 구간(35% 미만)이에요. "원가 확인" 팝업에서 점검해보세요. (광고료 제외 기준)`)
      else if (marginRate < 45) sales.push(`공헌이익률이 ${marginRate}%예요. 45% 이상이 안정권이에요. (광고료 제외 기준)`)
      else sales.push(`공헌이익률이 ${marginRate}%로 안정권이에요. (광고료 제외 기준)`)
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

    const soldOut = stockBalance.filter(s => s.remain <= 0 && s.stockIn > 0)
    if (soldOut.length > 0) {
      stock.push(`현재 재고가 0 이하인 상품이 ${soldOut.length}개 있어요 (예: "${soldOut[0].item_name}"). 추가 입고가 필요한지 확인해보세요.`)
    }
    const bestButLow = bestItems.slice(0, 5).find(b => {
      const bal = stockBalance.find(s => s.style_no === b.style_no || s.item_name === b.item_name)
      return bal && bal.remain <= 1
    })
    if (bestButLow) {
      stock.push(`잘 팔리는 상품인데 재고가 얼마 남지 않은 상품이 있어요. 재입고를 고려해보세요.`)
    }
    if (stock.length === 0 && totalStockIn > 0) {
      stock.push(`현재 누적 입고 ${totalStockIn}개 중 ${totalStockRemain}개가 매장에 남아있는 것으로 계산돼요.`)
    }

    return { sales, items, stock }
  }

  // 규칙 기반 인사이트 + 헤드라인 KPI를 프롬프트로 묶어 서버 라우트(/api/ai-insight)에 전달, Claude가 실제로 분석한 결과를 받아온다.
  async function runClaudeAI() {
    setClaudeLoading(true)
    setClaudeResult('')
    try {
      const insights = generateInsights()
      const bulletLines = [...insights.sales, ...insights.items, ...insights.stock].map(t => `- ${t}`).join('\n')
      const prompt = `너는 오프라인(월정산) 패션 브랜드 채널 "${CHANNEL_NAME}"의 데이터 분석가야.
아래는 규칙 기반으로 자동 생성된 참고 인사이트와 ${year}년 핵심 KPI야. 이 데이터를 바탕으로 실제로 의미 있는 분석과 구체적인 다음 액션을 한국어로 간결하게 제안해줘.

[규칙 기반 인사이트]
${bulletLines || '(생성된 인사이트 없음)'}

[핵심 KPI - ${year}년 누적]
- 총 매출액: ${formatWon(totalGross)}
- 순매출액(정산금액): ${formatWon(totalNet)}
- 판매수량: ${totalQtySale}건`

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
  const totalProfit = totalNet - totalCost
  const marginRate = totalNet > 0 ? Math.round((totalProfit / totalNet) * 1000) / 10 : null
  // 공헌이익 구성비 (매출액 대비 %) — 택배비/광고비는 오프라인 매장 특성상 아직 별도 데이터가 없어 0%로 표시
  const totalCostPct = totalGross > 0 ? Math.round((totalCost / totalGross) * 1000) / 10 : null
  const totalFeePct = totalGross > 0 ? Math.round((totalFee / totalGross) * 1000) / 10 : null

  // 전년도(year - 1) 총매출액/순매출액/순수익 — 데이터가 없으면 배열이 전부 0이라 자연히 0으로 처리됨
  const prevYearTotalGross = prevYearMonthlyGross.reduce((s, v) => s + v, 0)
  const prevYearTotalFee = prevYearMonthlyFee.reduce((s, v) => s + v, 0)
  const prevYearTotalNet = prevYearTotalGross - prevYearTotalFee
  const prevYearTotalCost = prevYearMonthlyCost.reduce((s, v) => s + v, 0)
  const prevYearTotalProfit = prevYearTotalNet - prevYearTotalCost
  const netYoyPct = prevYearTotalNet > 0 ? Math.round(((totalNet - prevYearTotalNet) / prevYearTotalNet) * 1000) / 10 : null

  const mGross = monthlyGross[viewMonthIdx]
  const mFee = monthlyFee[viewMonthIdx]
  const mNet = mGross - mFee
  const mCost = monthlyCost[viewMonthIdx]
  const mProfit = mNet - mCost
  const mMarginRate = mNet > 0 ? Math.round((mProfit / mNet) * 1000) / 10 : null
  const mCostPct = mGross > 0 ? Math.round((mCost / mGross) * 1000) / 10 : null
  const mFeePct = mGross > 0 ? Math.round((mFee / mGross) * 1000) / 10 : null

  // 전년도(year - 1) 동월 매출액/순매출액/순수익 — 데이터 없으면 0
  const prevMGross = prevYearMonthlyGross[viewMonthIdx] || 0
  const prevMFee = prevYearMonthlyFee[viewMonthIdx] || 0
  const prevMNet = prevMGross - prevMFee
  const prevMCost = prevYearMonthlyCost[viewMonthIdx] || 0
  const prevMProfit = prevMNet - prevMCost

  const monthlyChartData = MONTH_LABELS.map((label, i) => ({ name: label, 매출: chartMonthlyGross[i], 순매출: chartMonthlyNet[i], 작년매출: chartPrevYearGross[i] }))
  const qtyChartData = MONTH_LABELS.map((label, i) => ({ name: label, 판매수량: chartMonthlyQty[i], 작년판매수량: chartPrevYearQty[i] }))
  const stockChartData = MONTH_LABELS.map((label, i) => ({ name: label, 입고수량: chartMonthlyStockIn[i], 작년입고수량: chartPrevYearStockIn[i] }))

  function renderRevenueLabel(props: any) {
    const { x, y, width, value } = props
    if (!value) return null
    return (
      <text x={x + width / 2} y={y - 4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#f59e0b">
        {value.toLocaleString('ko-KR')}
      </text>
    )
  }

  function renderNetLabel(props: any) {
    const { x, y, width, value } = props
    if (!value) return null
    return (
      <text x={x + width / 2} y={y - 4} textAnchor="middle" fontSize={9} fontWeight={700} fill="#2563eb">
        {value.toLocaleString('ko-KR')}
      </text>
    )
  }

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#f59e0b', display: 'inline-block' }}></span>
          <h2 className="page-title" style={{ margin: 0 }}>클라만 (오프라인) 손익 & 입고 현황</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontSize: 12, color: '#f59e0b', fontWeight: 600 }}>수수료 {(FEE_RATE * 100).toFixed(0)}% (위탁, 고정)</span>
        </div>
      </div>

      {loading ? <div className="loading">로딩 중...</div> : (
        <>
          {/* AI 추천 인사이트 (맨 위) */}
          {(() => {
            const insights = generateInsights()
            const groups = [
              { title: '📈 매출 현황', items: insights.sales, color: '#f59e0b' },
              { title: '👕 아이템 피드백', items: insights.items, color: '#8b5cf6' },
              { title: '📦 재고 현황', items: insights.stock, color: '#0ea5e9' },
            ]
            return (
              <div style={{ background: 'linear-gradient(135deg, #fffbeb 0%, #eff6ff 100%)', border: '1px solid #94a3b8', borderRadius: 16, padding: 24, marginBottom: 24 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: 'pointer' }}
                  onClick={() => setShowInsights(v => !v)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18 }}>🤖</span>
                    <div style={{ fontWeight: 800, fontSize: 16 }}>AI 추천 인사이트</div>
                  </div>
                  <span style={{ fontSize: 12, color: '#757575', fontWeight: 700 }}>{showInsights ? '▲ 접기' : '▼ 펼치기'}</span>
                </div>
                {showInsights && (
                  <>
                    <div style={{ fontSize: 12, color: '#757575', marginTop: 4, marginBottom: 4 }}>
                      {year}년 {viewMonthIdx + 1}월 기준 데이터를 바탕으로 자동 생성된 참고용 피드백이에요.
                    </div>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 18 }}>
                      ANTHROPIC_API_KEY 설정 필요 &gt; gemini, claude
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
                      {groups.map(g => (
                        <div key={g.title} style={{ background: '#fff', borderRadius: 12, padding: 16 }}>
                          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 10, color: g.color }}>{g.title}</div>
                          {g.items.length === 0 ? (
                            <div style={{ fontSize: 12, color: '#757575' }}>아직 참고할 만한 데이터가 부족해요.</div>
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
                  </>
                )}
              </div>
            )
          })()}

          {/* 연간 KPI */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16, marginBottom: 20 }}>
            <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: '#757575', fontWeight: 700 }}>{year}년 총 매출액</span>
                <div>
                  <input ref={fileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                    onChange={e => { const f = e.target.files?.[0]; if (f) handleUpload(f) }} />
                  <button onClick={() => fileRef.current?.click()} disabled={uploading}
                    style={{ border: '1px solid #fde68a', background: '#fff', color: '#d97706', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>
                    {uploading ? '업로드 중...' : '📤 판매 업로드'}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 29, fontWeight: 800, color: '#000000', marginBottom: 4 }}>
                {formatWon(totalGross)}
                {yoyDashboardPct !== null && (
                  <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 8, color: yoyDashboardPct >= 0 ? '#059669' : '#e11d48' }}>
                    전년대비 {yoyDashboardPct >= 0 ? '+' : ''}{yoyDashboardPct}%
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#757575', marginBottom: 4 }}>{year - 1}년 매출액 {formatWon(prevYearTotalGross)}</div>
              <div style={{ fontSize: 12, color: '#757575' }}>
                결제금액 합계
                {hasData && (
                  <span style={{ marginLeft: 6, color: '#64748b', fontWeight: 700 }}>
                    {totalNetQty}건 <span style={{ fontWeight: 500, color: '#757575' }}>(판매{totalQtySale}/환불{totalQtyRefund})</span>
                  </span>
                )}
              </div>
            </div>
            <div style={{ background: '#eff6ff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: '#757575', fontWeight: 700 }}>순매출액</span>
                <button onClick={openOrderModal}
                  style={{ border: '1px solid #94a3b8', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>
                  📋 월별 판매내역
                </button>
              </div>
              <div style={{ fontSize: 29, fontWeight: 800, color: '#2563eb', marginBottom: 4 }}>
                {formatWon(totalNet)}
                {netYoyPct !== null && (
                  <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 8, color: netYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                    전년대비 {netYoyPct >= 0 ? '+' : ''}{netYoyPct}%
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#757575', marginBottom: 4 }}>{year - 1}년 순매출액 {formatWon(prevYearTotalNet)}</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <span style={{ fontSize: 12, color: '#e11d48', fontWeight: 700 }}>- {formatWon(totalFee)}</span>
                <span style={{ fontSize: 11, color: '#757575' }}>수수료 (고정 {(FEE_RATE * 100).toFixed(0)}%)</span>
              </div>
            </div>
            <div style={{ background: totalProfit >= 0 ? '#ecfdf5' : '#fff1f2', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 11, color: '#757575', fontWeight: 700 }}>순수익 (공헌이익)</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={openCostModal}
                    style={{ border: '1px solid #bfdbfe', background: '#fff', color: '#2563eb', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>
                    🔍 원가 확인
                  </button>
                  <button onClick={() => setYear(y => y - 1)} style={{ ...yearBtnStyle, fontSize: 11, padding: '3px 9px' }}>◀</button>
                  <span style={{ fontWeight: 700, fontSize: 13, minWidth: 60, textAlign: 'center' }}>{year}년</span>
                  <button onClick={() => setYear(y => y + 1)} style={{ ...yearBtnStyle, fontSize: 11, padding: '3px 9px' }}>▶</button>
                </div>
              </div>
              <div style={{ fontSize: 29, fontWeight: 800, color: totalProfit >= 0 ? '#059669' : '#e11d48', marginBottom: 4 }}>
                {formatWon(totalProfit)}
                {marginRate !== null && (
                  <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 6 }}>({marginRate}%)</span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#757575', marginBottom: 4 }}>{year - 1}년 순수익 {formatWon(prevYearTotalProfit)}</div>
              <div style={{ fontSize: 11, color: '#757575' }}>
                원가 {totalCostPct !== null ? `${totalCostPct}%` : '-'} · 택배비 0% · 광고비 0% · 수수료 {totalFeePct !== null ? `${totalFeePct}%` : '-'}
              </div>
              <div style={{ fontSize: 11, color: '#dc2626', fontWeight: 700, marginTop: 4 }}>
                공헌이익률 25% 미만 위험 · 35% 미만 주의 · 45%↑ 안정권 (광고료 제외)
              </div>
            </div>
          </div>

          {uploadMsg && (
            <div style={{ marginBottom: 20, padding: '10px 14px', background: '#fffbeb', borderRadius: 10, fontSize: 13, color: '#d97706', fontWeight: 600, whiteSpace: 'pre-line' }}>
              ✓ {uploadMsg}
            </div>
          )}
          {uploadStockMsg && (
            <div style={{ marginBottom: 20, padding: '10px 14px', background: '#eff6ff', borderRadius: 10, fontSize: 13, color: '#2563eb', fontWeight: 600, whiteSpace: 'pre-line' }}>
              ✓ {uploadStockMsg}
            </div>
          )}

          {/* 선택 월 KPI + 월별 매출/판매수량 차트 */}
          <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20, marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <button onClick={() => shiftViewMonth(-1)} style={monthNavBtnStyle}>◀</button>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#757575' }}>{year}년 {viewMonthIdx + 1}월</span>
              <button onClick={() => shiftViewMonth(1)} style={monthNavBtnStyle}>▶</button>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 20 }}>
              <div style={{ background: '#f8fafc', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 11, color: '#757575', fontWeight: 700, marginBottom: 6 }}>{year}년 {viewMonthIdx + 1}월 매출액</div>
                <div style={{ fontSize: 23, fontWeight: 800, color: '#000000' }}>{formatWon(mGross)}</div>
                <div style={{ fontSize: 11, color: '#757575', marginTop: 4 }}>{year - 1}년 {viewMonthIdx + 1}월 {formatWon(prevMGross)}</div>
              </div>
              <div style={{ background: '#eff6ff', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 11, color: '#757575', fontWeight: 700, marginBottom: 6 }}>순매출액</div>
                <div style={{ fontSize: 23, fontWeight: 800, color: '#2563eb' }}>{formatWon(mNet)}</div>
                <div style={{ fontSize: 11, color: '#757575', marginTop: 4 }}>{year - 1}년 {viewMonthIdx + 1}월 {formatWon(prevMNet)}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <span style={{ fontSize: 11, color: '#e11d48', fontWeight: 700 }}>- {formatWon(mFee)}</span>
                  <span style={{ fontSize: 10, color: '#757575' }}>수수료</span>
                </div>
              </div>
              <div style={{ background: mProfit >= 0 ? '#ecfdf5' : '#fff1f2', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 11, color: '#757575', fontWeight: 700, marginBottom: 6 }}>순수익 (공헌이익)</div>
                <div style={{ fontSize: 23, fontWeight: 800, color: mProfit >= 0 ? '#059669' : '#e11d48' }}>
                  {formatWon(mProfit)}
                  {mMarginRate !== null && (
                    <span style={{ fontSize: 12, fontWeight: 700, marginLeft: 6 }}>({mMarginRate}%)</span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#757575', marginTop: 4 }}>{year - 1}년 {viewMonthIdx + 1}월 {formatWon(prevMProfit)}</div>
                <div style={{ fontSize: 10, color: '#757575', marginTop: 4 }}>
                  원가 {mCostPct !== null ? `${mCostPct}%` : '-'} · 택배비 0% · 광고비 0% · 수수료 {mFeePct !== null ? `${mFeePct}%` : '-'}
                </div>
                <div style={{ fontSize: 10, color: '#dc2626', fontWeight: 700, marginTop: 2 }}>
                  25%↓위험 · 35%↓주의 · 45%↑안정권 (광고료 제외)
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{chartYear}년 월별 매출</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => shiftChartYear(-1)} style={monthNavBtnStyle}>◀</button>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#757575' }}>{chartYear}년</span>
                <button onClick={() => shiftChartYear(1)} style={monthNavBtnStyle}>▶</button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: '#757575', marginBottom: 16 }}>
              매출액 · 순매출액(수수료 차감 후) {chartHasPrevYearData ? `· ${chartYear - 1}년 매출(비교)` : ''}
            </div>
            {chartLoading ? <div className="loading">로딩 중...</div> : (!chartHasData && !chartHasPrevYearData) ? (
              <div className="chart-empty">{chartYear}년 데이터가 없습니다</div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={monthlyChartData} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 13 }} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => v.toLocaleString('ko-KR')} width={70} />
                  <Tooltip formatter={(v: any) => formatWon(Number(v))} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="매출" fill="#f59e0b" radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="매출" content={renderRevenueLabel} />
                  </Bar>
                  <Bar dataKey="순매출" fill="#2563eb" radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="순매출" content={renderNetLabel} />
                  </Bar>
                  {chartHasPrevYearData && <Bar dataKey="작년매출" fill="#94a3b8" radius={[4, 4, 0, 0]} />}
                </BarChart>
              </ResponsiveContainer>
            )}

            <div style={{ fontWeight: 700, fontSize: 15, marginTop: 24, marginBottom: 4 }}>{chartYear}년 월별 판매수량</div>
            <div style={{ fontSize: 12, color: '#757575', marginBottom: 16 }}>
              순수 판매 건수 {chartHasPrevYearData ? `· ${chartYear - 1}년 판매건수(비교)` : ''}
            </div>
            {!chartLoading && (chartHasData || chartHasPrevYearData) && (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={qtyChartData} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 13 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: any) => `${v}건`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="판매수량" fill="#e11d48" radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="판매수량" position="top" formatter={(v: any) => v ? `${v}건` : ''} style={{ fontSize: 9, fill: '#e11d48', fontWeight: 700 }} />
                  </Bar>
                  {chartHasPrevYearData && (
                    <Bar dataKey="작년판매수량" fill="#94a3b8" radius={[4, 4, 0, 0]}>
                      <LabelList dataKey="작년판매수량" position="top" formatter={(v: any) => v ? `${v}건` : ''} style={{ fontSize: 9, fill: '#64748b', fontWeight: 700 }} />
                    </Bar>
                  )}
                </BarChart>
              </ResponsiveContainer>
            )}

          </div>

          {/* 베스트 상품 + 카테고리별 판매량 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
            <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8, flexWrap: 'wrap' }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>클라만 베스트 상품 순위</div>
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
                    style={{ border: '1px solid #94a3b8', background: showByOption ? '#fffbeb' : '#fff', color: '#d97706', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6 }}>
                    {showByOption ? '스타일넘버로 통합보기' : '옵션별로 보기'}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 12, color: '#757575', marginBottom: 16 }}>
                주문 건수 기준 ({bestYearFilter === '전체' ? '전체 연도' : `${bestYearFilter}년`}){showByOption ? ' · 옵션별' : ' · 스타일넘버 기준 통합'} · 스크롤로 전체 확인
              </div>
              {(() => {
                const filtered = bestItemSeasonFilter === '전체' ? bestItems : bestItems.filter(it => it.season === bestItemSeasonFilter)
                if (filtered.length === 0) return <div className="chart-empty">데이터 없음</div>

                type Row = { key: string; item_name: string; style_no: string; option_name: string; qty: number; revenue: number; net: number; profit: number }
                let displayRows: Row[]
                if (showByOption) {
                  displayRows = []
                  filtered.forEach(it => {
                    Array.from(it.options.entries()).forEach(([opt, v]) => {
                      displayRows.push({ key: `${it.key}__${opt}`, item_name: it.item_name, style_no: it.style_no, option_name: opt, qty: v.qty, revenue: v.revenue, net: v.net, profit: v.profit })
                    })
                  })
                  displayRows.sort((a, b) => b.qty - a.qty)
                } else {
                  displayRows = filtered.map(it => ({ key: it.key, item_name: it.item_name, style_no: it.style_no, option_name: '-', qty: it.qty, revenue: it.revenue, net: it.net, profit: it.profit }))
                    .sort((a, b) => b.qty - a.qty)
                }

                return (
                  <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: '#f8fafc' }}>
                          {(showByOption ? ['순위', '상품명', '스타일넘버', '옵션', '건수', '매출', '순매출', '순수익'] : ['순위', '상품명', '스타일넘버', '건수', '매출', '순매출', '순수익']).map(h => (
                            <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', fontSize: 11, color: '#757575', fontWeight: 700, position: 'sticky', top: 0, background: '#f8fafc' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {displayRows.map((it, i) => (
                          <tr key={it.key} style={{ borderBottom: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: i < 3 ? '#d97706' : '#94a3b8' }}>{i + 1}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>{it.item_name}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b', fontFamily: 'monospace' }}>{it.style_no}</td>
                            {showByOption && <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{it.option_name}</td>}
                            <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: '#d97706' }}>{it.qty}건</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: '#0f172a' }}>{formatWon(it.revenue)}</td>
                            <td style={{ padding: '8px 10px', textAlign: 'center', color: '#2563eb' }}>{formatWon(it.net)}</td>
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
              <div style={{ fontSize: 12, color: '#757575', marginBottom: 16 }}>{bestYearFilter === '전체' ? '전체 연도' : `${bestYearFilter}년`} 기준, 재고 카테고리와 매칭</div>
              {categorySales.length === 0 ? (
                <div className="chart-empty" style={{ height: 120 }}>정산내역을 먼저 업로드해주세요</div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={categorySales.map(c => ({ name: c.category, 판매량: c.qty }))} layout="vertical" margin={{ left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={70} />
                      <Tooltip formatter={(v: any) => `${v}건`} />
                      <Bar dataKey="판매량" fill="#8b5cf6" radius={[0, 4, 4, 0]}>
                        <LabelList dataKey="판매량" position="right" formatter={(v: any) => v ? `${v}건` : ''} style={{ fontSize: 11, fill: '#8b5cf6', fontWeight: 700 }} />
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

          {/* 재고(입고) 현황 — 누적 입고 vs 누적 판매로 계산한 현재 재고 (스타일넘버 기준 통합, 시즌 연동) */}
          <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8, flexWrap: 'wrap' }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>클라만 재고 현황</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <select value={stockSeasonFilter} onChange={e => setStockSeasonFilter(e.target.value)}
                  style={{ border: '1px solid #94a3b8', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 6, fontFamily: 'inherit' }}>
                  <option value="전체">전체 시즌</option>
                  {availableStockSeasons.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <button onClick={() => setShowStockByOption(v => !v)}
                  style={{ border: '1px solid #94a3b8', background: showStockByOption ? '#eff6ff' : '#fff', color: '#2563eb', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6 }}>
                  {showStockByOption ? '스타일넘버로 통합보기' : '옵션별로 보기'}
                </button>
                <button onClick={() => setShowStockRankModal(true)}
                  style={{ border: '1px solid #bfdbfe', background: '#fff', color: '#2563eb', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6 }}>
                  📊 입고 수량 그래프
                </button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: '#757575', marginBottom: 16 }}>
              누적 입고 {totalStockIn}개 · 현재 재고(추정) {totalStockRemain}개 · 누적 입고 수량에서 누적 판매 수량을 뺀 값이에요 (전체 기간 기준) · 누적 판매가 많은 순으로 정렬
            </div>
            {stockLoading ? (
              <div className="loading">로딩 중...</div>
            ) : stockBalance.length === 0 ? (
              <div className="chart-empty">입고 데이터를 먼저 업로드해주세요</div>
            ) : (() => {
              const filtered = stockSeasonFilter === '전체' ? stockBalance : stockBalance.filter(it => it.season === stockSeasonFilter)
              if (filtered.length === 0) return <div className="chart-empty">데이터 없음</div>

              type StockRow = { key: string; item_name: string; style_no: string; season: string; option_name: string; stockIn: number; sold: number; remain: number; lastMonth: string }
              let rows: StockRow[]
              if (showStockByOption) {
                rows = []
                filtered.forEach(it => {
                  Array.from(it.options.entries()).forEach(([opt, ov]) => {
                    rows.push({ key: `${it.key}__${opt}`, item_name: it.item_name, style_no: it.style_no, season: it.season, option_name: opt, stockIn: ov.stockIn, sold: ov.sold, remain: ov.remain, lastMonth: ov.lastMonth })
                  })
                })
                rows.sort((a, b) => b.sold - a.sold)
              } else {
                rows = filtered.map(it => ({ key: it.key, item_name: it.item_name, style_no: it.style_no, season: it.season, option_name: '-', stockIn: it.stockIn, sold: it.sold, remain: it.remain, lastMonth: it.lastMonth }))
              }

              return (
                <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                    <thead>
                      <tr style={{ background: '#f8fafc' }}>
                        {(showStockByOption ? ['상품명', '스타일넘버', '시즌', '옵션', '누적입고', '누적판매', '현재재고(추정)', '최근입고월'] : ['상품명', '스타일넘버', '시즌', '누적입고', '누적판매', '현재재고(추정)', '최근입고월']).map(h => (
                          <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', fontSize: 11, color: '#757575', fontWeight: 700, position: 'sticky', top: 0, background: '#f8fafc' }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map(r => (
                        <tr key={r.key} style={{ borderBottom: '1px solid #f1f5f9', background: r.remain <= 0 ? '#fff7ed' : undefined }}>
                          <td style={{ padding: '8px 10px', fontWeight: 600 }}>{r.item_name}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b', fontFamily: 'monospace' }}>{r.style_no}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{r.season}</td>
                          {showStockByOption && <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{r.option_name}</td>}
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: '#2563eb' }}>{r.stockIn}개</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#e11d48' }}>{r.sold}개</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 800, color: r.remain <= 0 ? '#d97706' : '#059669' }}>
                            {r.remain}개{r.remain <= 0 ? ' ⚠' : ''}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#757575' }}>{r.lastMonth || '-'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )
            })()}
          </div>

          {/* 월별 입고수량 (맨 아래) */}
          <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20, marginTop: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{chartYear}년 월별 입고수량</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => shiftChartYear(-1)} style={monthNavBtnStyle}>◀</button>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#757575' }}>{chartYear}년</span>
                <button onClick={() => shiftChartYear(1)} style={monthNavBtnStyle}>▶</button>
                <input ref={stockFileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleStockUpload(f) }} />
                <button onClick={() => stockFileRef.current?.click()} disabled={uploadingStock}
                  style={{ border: '1px solid #bfdbfe', background: '#fff', color: '#2563eb', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6, marginLeft: 4 }}>
                  {uploadingStock ? '업로드 중...' : '📤 입고 업로드'}
                </button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: '#757575', marginBottom: 16 }}>
              매장에 새로 입고된 수량 (건수 기준) {chartStockHasPrevYearData ? `· ${chartYear - 1}년 입고수량(비교)` : ''} · 막대를 클릭하면 그 달에 입고된 상품을 볼 수 있어요
            </div>
            {chartLoading ? <div className="loading">로딩 중...</div> : (!chartStockHasData && !chartStockHasPrevYearData) ? (
              <div className="chart-empty">{chartYear}년 입고 데이터가 없습니다</div>
            ) : (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={stockChartData} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 13 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: any) => `${v}개`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="입고수량" fill="#2563eb" radius={[4, 4, 0, 0]} cursor="pointer"
                    onClick={(_data: any, index: number) => openStockMonthModal(chartYear, index)}>
                    <LabelList dataKey="입고수량" position="top" formatter={(v: any) => v ? `${v}개` : ''} style={{ fontSize: 9, fill: '#2563eb', fontWeight: 700 }} />
                  </Bar>
                  {chartStockHasPrevYearData && (
                    <Bar dataKey="작년입고수량" fill="#94a3b8" radius={[4, 4, 0, 0]} cursor="pointer"
                      onClick={(_data: any, index: number) => openStockMonthModal(chartYear - 1, index)}>
                      <LabelList dataKey="작년입고수량" position="top" formatter={(v: any) => v ? `${v}개` : ''} style={{ fontSize: 9, fill: '#64748b', fontWeight: 700 }} />
                    </Bar>
                  )}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </>
      )}

      {showOrderModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setShowOrderModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 1100, height: 700, overflow: 'auto', flexShrink: 0 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>클라만 월별 판매내역</div>
              <button onClick={() => setShowOrderModal(false)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#757575', lineHeight: 1 }}>×</button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <button onClick={() => shiftOrderMonth(-1)} style={monthNavBtnStyle}>◀</button>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{orderYear}년 {orderMonthIdx + 1}월</span>
              <button onClick={() => shiftOrderMonth(1)} style={monthNavBtnStyle}>▶</button>
            </div>

            {orderLoading ? (
              <div className="loading">로딩 중...</div>
            ) : orderRows.length === 0 ? (
              <div className="chart-empty">이 달에는 등록된 판매 내역이 없습니다</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      {['시즌', '상품명', '스타일넘버', '옵션', '판매가', '할인율', '결제금액', '원가', '수수료', '정산액', '순수익'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', color: '#757575', fontWeight: 700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orderRows.map((r: any) => {
                      const { discountRate, fee, net } = computeLineFee(r.sale_amount || 0, r.list_price || 0)
                      const profit = net - (r.matched_cost || 0)
                      const seasonInfo: any = catIndexAll.find(r.style_no || '', r.item_name || '', r.option_name || '')
                      const season = seasonInfo?.season || '미지정'
                      return (
                        <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{season}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.item_name || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontFamily: 'monospace', color: r.cost_matched ? undefined : '#d97706' }} title={r.cost_matched ? '재고 매칭됨' : '재고 미매칭 — 원가 0으로 처리됨'}>{r.style_no || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.option_name || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(r.list_price)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{Math.round(discountRate * 1000) / 10}%</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(r.sale_amount)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: r.cost_matched ? undefined : '#d97706', fontWeight: r.cost_matched ? undefined : 700 }}>
                            {r.cost_matched ? formatWon(r.matched_cost) : '미매칭'}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#e11d48' }}>{formatWon(fee)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(net)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: profit >= 0 ? '#059669' : '#e11d48' }}>{formatWon(profit)}</td>
                        </tr>
                      )
                    })}
                    {(() => {
                      const sumList = orderRows.reduce((s: number, r: any) => s + (r.list_price || 0), 0)
                      const sumSale = orderRows.reduce((s: number, r: any) => s + (r.sale_amount || 0), 0)
                      const sumCost = orderRows.reduce((s: number, r: any) => s + (r.matched_cost || 0), 0)
                      const sumFee = orderRows.reduce((s: number, r: any) => s + computeLineFee(r.sale_amount || 0, r.list_price || 0).fee, 0)
                      const sumNet = sumSale - sumFee
                      const sumProfit = sumNet - sumCost
                      return (
                        <tr style={{ background: '#f8fafc', fontWeight: 800 }}>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }} colSpan={4}>합계</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(sumList)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>-</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(sumSale)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(sumCost)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#e11d48' }}>{formatWon(sumFee)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(sumNet)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: sumProfit >= 0 ? '#059669' : '#e11d48' }}>{formatWon(sumProfit)}</td>
                        </tr>
                      )
                    })()}
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
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#757575', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ fontSize: 12, color: '#757575', marginBottom: 16 }}>
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
                      <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', color: '#757575', fontWeight: 700 }}>{h}</th>
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

      {showStockRankModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setShowStockRankModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 720, height: 700, overflow: 'auto', flexShrink: 0 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>아이템별 입고 수량</div>
              <button onClick={() => setShowStockRankModal(false)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#757575', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ fontSize: 12, color: '#757575', marginBottom: 16 }}>
              {stockSeasonFilter === '전체' ? '전체 시즌' : `${stockSeasonFilter} 시즌`} · {showStockByOption ? '옵션별' : '스타일넘버 기준 통합'} · 누적 입고 수량이 많은 순
            </div>
            {(() => {
              const filtered = stockSeasonFilter === '전체' ? stockBalance : stockBalance.filter(it => it.season === stockSeasonFilter)
              let rankRows: { key: string; name: string; 입고수량: number }[]
              if (showStockByOption) {
                rankRows = []
                filtered.forEach(it => {
                  Array.from(it.options.entries()).forEach(([opt, ov]) => {
                    rankRows.push({ key: `${it.key}__${opt}`, name: `${it.item_name} (${opt})`, 입고수량: ov.stockIn })
                  })
                })
              } else {
                rankRows = filtered.map(it => ({ key: it.key, name: it.item_name, 입고수량: it.stockIn }))
              }
              rankRows.sort((a, b) => b.입고수량 - a.입고수량)

              if (rankRows.length === 0) return <div className="chart-empty">데이터 없음</div>

              return (
                <div style={{ maxHeight: 600, overflowY: 'auto' }}>
                  <ResponsiveContainer width="100%" height={Math.max(rankRows.length * 30, 200)}>
                    <BarChart data={rankRows} layout="vertical" margin={{ top: 4, right: 40, left: 10, bottom: 4 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={170} />
                      <Tooltip formatter={(v: any) => `${v}개`} />
                      <Bar dataKey="입고수량" fill="#2563eb" radius={[0, 4, 4, 0]}>
                        <LabelList dataKey="입고수량" position="right" formatter={(v: any) => v ? `${v}개` : ''} style={{ fontSize: 11, fill: '#2563eb', fontWeight: 700 }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )
            })()}
          </div>
        </div>
      )}

      {showStockMonthModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setShowStockMonthModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 700, height: 620, overflow: 'auto', flexShrink: 0 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>월별 입고 상세</div>
              <button onClick={() => setShowStockMonthModal(false)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#757575', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <button onClick={() => shiftStockMonth(-1)} style={monthNavBtnStyle}>◀</button>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{stockMonthYear}년 {stockMonthIdx + 1}월</span>
              <button onClick={() => shiftStockMonth(1)} style={monthNavBtnStyle}>▶</button>
            </div>
            {stockMonthLoading ? (
              <div className="loading">로딩 중...</div>
            ) : stockMonthRows.length === 0 ? (
              <div className="chart-empty">이 달에는 입고 내역이 없습니다</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {['상품명', '스타일넘버', '옵션', '입고수량'].map(h => (
                      <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', color: '#757575', fontWeight: 700 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {stockMonthRows.map(r => (
                    <tr key={r.key} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '8px 10px', fontWeight: 600 }}>{r.item_name}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b', fontFamily: 'monospace' }}>{r.style_no}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{r.option_name}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: '#2563eb' }}>{r.qty}개</td>
                    </tr>
                  ))}
                  <tr style={{ background: '#f8fafc', fontWeight: 800 }}>
                    <td colSpan={3} style={{ padding: '8px 10px', textAlign: 'center' }}>합계</td>
                    <td style={{ padding: '8px 10px', textAlign: 'center' }}>{stockMonthRows.reduce((s, r) => s + r.qty, 0)}개</td>
                  </tr>
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