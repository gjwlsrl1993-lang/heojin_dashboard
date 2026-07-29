'use client'

import { useEffect, useState, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, LabelList } from 'recharts'

const BASE_FEE = 0.29
const DISCOUNT_FEE_REDUCTION = 0.01 // 10% 할인 시 수수료 1% 감소
const MONTH_LABELS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월']
const CHANNEL_NAME = '무신사'

// new Date(y, m, 0).toISOString()는 시간대 변환 과정에서 하루가 밀릴 수 있어서(특히 UTC+9),
// 순수 달력 계산으로 그 달의 마지막 날짜를 구함 (연도/월 1~12 기준)
function lastDayOfMonth(year: number, month: number): number {
  const daysInMonth = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return daysInMonth[month - 1]
}
function monthEndDateStr(year: number, month: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(lastDayOfMonth(year, month)).padStart(2, '0')}`
}

// "25SS", "25FW", "26SS" 같은 시즌 문자열을 시간순으로 정렬하기 위한 값 계산 (연도*10 + SS:0/FW:1)
function seasonSortValue(season: string): number {
  const match = /^(\d{2})(SS|FW)$/i.exec((season || '').trim())
  if (!match) return -1
  const yy = parseInt(match[1], 10)
  const seasonCode = match[2].toUpperCase() === 'SS' ? 0 : 1
  return yy * 10 + seasonCode
}

// formatKRW가 만원 단위로 축약해서 보여주는 것과 별개로, 1원 단위까지 정확한 금액을 표시
function formatWon(n: number): string {
  return (n || 0).toLocaleString('ko-KR') + '원'
}

export default function MusinsaPage() {
  const [year, setYear] = useState(new Date().getFullYear())
  const [sales, setSales] = useState<any[]>([])
  const [monthlyGross, setMonthlyGross] = useState<number[]>(new Array(12).fill(0))
  const [monthlyAdCost, setMonthlyAdCost] = useState<number[]>(new Array(12).fill(0))
  const [monthlyAdRevenue, setMonthlyAdRevenue] = useState<number[]>(new Array(12).fill(0))
  // 무신사가 매달 무료로 지급하는 10만원은 제외하고, 실제로 내 돈으로 충전한 광고비만 월별로 직접 입력해서 관리 (순수익에서 차감)
  const [monthlyAdCharge, setMonthlyAdCharge] = useState<number[]>(new Array(12).fill(0))
  const [viewMonthIdx, setViewMonthIdx] = useState(new Date().getMonth())
  const [loading, setLoading] = useState(true)
  const [discountApplied, setDiscountApplied] = useState(false)
  const [adUploading, setAdUploading] = useState(false)
  const [uploadMsg, setUploadMsg] = useState('')
  // 배송중(정산 대기) — 송장파일(invoice_list)로 등록됐지만 아직 정산내역에 안 나온 주문 수량
  const [pendingQtyTotal, setPendingQtyTotal] = useState(0)
  const [pendingMonthlyQty, setPendingMonthlyQty] = useState<number[]>(new Array(12).fill(0))
  const [showPendingModal, setShowPendingModal] = useState(false)
  const [pendingRows, setPendingRows] = useState<any[]>([])
  const [pendingLoading, setPendingLoading] = useState(false)
  const [pendingMonthOnly, setPendingMonthOnly] = useState(false) // 월별 카드에서 열면 그 달만 보기
  const [rankInputs, setRankInputs] = useState<Record<string, string>>({})
  const [yoyDashboardPct, setYoyDashboardPct] = useState<number | null>(null)
  const [dashPrevYearMonthlyGross, setDashPrevYearMonthlyGross] = useState<number[]>(new Array(12).fill(0))
  const [prevYearNetTotal, setPrevYearNetTotal] = useState(0)
  const [prevYearProfitTotal, setPrevYearProfitTotal] = useState(0)
  const [dashPrevYearMonthlyNet, setDashPrevYearMonthlyNet] = useState<number[]>(new Array(12).fill(0))
  const [dashPrevYearMonthlyProfit, setDashPrevYearMonthlyProfit] = useState<number[]>(new Array(12).fill(0))
  const [categorySales, setCategorySales] = useState<{ category: string; qty: number }[]>([])
  const [bestItems, setBestItems] = useState<{ key: string; item_name: string; style_no: string; option_name: string; qty: number; pendingQty: number; revenue: number; netRevenue: number; profit: number; season: string }[]>([])
  const [showByOption, setShowByOption] = useState(false)
  const [bestItemSeasonFilter, setBestItemSeasonFilter] = useState('전체')
  // 베스트 상품 순위 / 카테고리별 판매량 전용 연도 필터 — 기본값 '전체'(전체 기간), 상단 KPI의 year와 무관하게 독립 동작
  const [bestCatYearFilter, setBestCatYearFilter] = useState('전체')
  const [bestCatAvailableYears, setBestCatAvailableYears] = useState<number[]>([])
  const [bestCatLoading, setBestCatLoading] = useState(false)
  const adFileRef = useRef<HTMLInputElement>(null)

  const [showDailyModal, setShowDailyModal] = useState(false)
  const [dailyMonthIdx, setDailyMonthIdx] = useState(new Date().getMonth())
  const [dailyYear, setDailyYear] = useState(new Date().getFullYear())
  const [dailyRows, setDailyRows] = useState<any[]>([])
  const [dailyLoading, setDailyLoading] = useState(false)

  const [showOrderModal, setShowOrderModal] = useState(false)
  const [orderYear, setOrderYear] = useState(new Date().getFullYear())
  const [orderMonthIdx, setOrderMonthIdx] = useState(new Date().getMonth())
  const [orderRows, setOrderRows] = useState<any[]>([])
  const [orderExtraFees, setOrderExtraFees] = useState<any>(null)
  const [orderLoading, setOrderLoading] = useState(false)
  const [orderSaleOrderNos, setOrderSaleOrderNos] = useState<Set<string>>(new Set())
  const [orderSeasonBySkuOption, setOrderSeasonBySkuOption] = useState<Map<string, string>>(new Map())
  const [orderSeasonByNameOption, setOrderSeasonByNameOption] = useState<Map<string, string>>(new Map())
  const [breakdown, setBreakdown] = useState<{ title: string; items: { label: string; value: number }[] } | null>(null)
  const [editLineTarget, setEditLineTarget] = useState<any>(null)
  const [editLineForm, setEditLineForm] = useState({ item_name: '', style_no: '' })
  const [editLineSaving, setEditLineSaving] = useState(false)

  const [showCostModal, setShowCostModal] = useState(false)
  const [costRows, setCostRows] = useState<{ key: string; itemName: string; styleNo: string; option: string; qty: number; cost: number; matched: boolean }[]>([])
  const [costLoading, setCostLoading] = useState(false)

  const [monthlyClaim, setMonthlyClaim] = useState<number[]>(new Array(12).fill(0))
  const [monthlySettleGross, setMonthlySettleGross] = useState<number[]>(new Array(12).fill(0))
  const [monthlySettleNet, setMonthlySettleNet] = useState<number[]>(new Array(12).fill(0))
  const [monthlySettleCost, setMonthlySettleCost] = useState<number[]>(new Array(12).fill(0))
  const [monthlySettleShipping, setMonthlySettleShipping] = useState<number[]>(new Array(12).fill(0))
  const [monthlyQtySale, setMonthlyQtySale] = useState<number[]>(new Array(12).fill(0))
  const [monthlyQtyRefund, setMonthlyQtyRefund] = useState<number[]>(new Array(12).fill(0))
  // 월별 매출/판매수량 차트 전용 연도 (상단 KPI의 year와 별개로 이동 가능)
  const [chartYear, setChartYear] = useState(new Date().getFullYear())
  const [chartLoading, setChartLoading] = useState(false)
  const [chartMonthlyGross, setChartMonthlyGross] = useState<number[]>(new Array(12).fill(0))
  const [chartMonthlySettleNet, setChartMonthlySettleNet] = useState<number[]>(new Array(12).fill(0))
  const [chartMonthlyQtySale, setChartMonthlyQtySale] = useState<number[]>(new Array(12).fill(0))
  const [chartMonthlyQtyRefund, setChartMonthlyQtyRefund] = useState<number[]>(new Array(12).fill(0))
  const [chartPrevYearQtySale, setChartPrevYearQtySale] = useState<number[]>(new Array(12).fill(0))
  const [chartPrevYearGross, setChartPrevYearGross] = useState<number[]>(new Array(12).fill(0))
  const [chartPrevYearNet, setChartPrevYearNet] = useState<number[]>(new Array(12).fill(0))
  const [chartHasPrevYearData, setChartHasPrevYearData] = useState(false)
  const [chartHasData, setChartHasData] = useState(false)
  const [hasSettlementData, setHasSettlementData] = useState(false)
  const [settleUploading, setSettleUploading] = useState(false)
  const [settleDragOver, setSettleDragOver] = useState(false)
  const [insightsCollapsed, setInsightsCollapsed] = useState(true)
  const settleFileRef = useRef<HTMLInputElement>(null)

  const feeRate = discountApplied ? BASE_FEE - DISCOUNT_FEE_REDUCTION : BASE_FEE

  useEffect(() => { loadData() }, [year])
  useEffect(() => { setChartYear(year); loadChartData(year) }, [year])
  useEffect(() => { loadBestAndCategory(bestCatYearFilter) }, [bestCatYearFilter])

  // 정산금액 계산 공식을 한 곳에서 관리:
  // - "정산내역-상세" 파일에서 온 행은 net_settlement가 없으므로 기존 공식(매출액-총수수료)으로 계산
  // - "일일정산확인" 파일에서 온 행은 무신사가 이미 계산해서 준 최종 정산금액(net_settlement)을 그대로 신뢰해서 사용
  //   (이 경우 "총수수료"는 매출액-정산금액으로 역산해서, 화면에 표시되는 매출액/총수수료/정산금액 세 숫자가 항상 서로 맞도록 함)
  function computeCommissionAndSettlement(row: any): { totalCommission: number; settlementAmount: number } {
    if (row.net_settlement !== null && row.net_settlement !== undefined) {
      const settlementAmount = row.net_settlement
      const totalCommission = (row.revenue_ao || 0) - settlementAmount
      return { totalCommission, settlementAmount }
    }
    const musinsaDiscountTotal = (row.discount || 0) + (row.musinsa_coupon || 0) + (row.musinsa_cart_coupon || 0) + (row.reward_points || 0)
    const totalCommission = (row.commission_sale || 0) - (row.penalty || 0) - (row.claim_shipping_fee || 0) - (row.review_boost || 0) - (row.mfs_logistics || 0) + musinsaDiscountTotal
    const settlementAmount = (row.revenue_ao || 0) - totalCommission
    return { totalCommission, settlementAmount }
  }

  // 환불행 판정용 키 만들기 — 주문일련번호(상품 줄 단위 고유)를 우선 쓰고,
  // 일련번호가 없으면 주문번호+스타일넘버+옵션 조합으로 대체
  function saleLineKeysOf(row: any): string[] {
    const keys: string[] = []
    const serial = (row.order_serial || '').trim()
    if (serial) keys.push(`S:${serial}`)
    const orderNo = (row.order_no || '').trim()
    if (orderNo) keys.push(`O:${orderNo}__${normalizeSkuForMatch(row.style_no)}__${normalizeOptionForMatch(row.option_name)}`)
    return keys
  }

  // 전체 기간의 "판매" 건 키 집합 (환불을 -1로 차감할지 0으로 둘지 판단용)
  // Supabase 기본 1000행 제한을 넘지 않도록 페이지 단위로 끝까지 읽어옴
  async function loadSaleLineKeys(): Promise<Set<string>> {
    const keys = new Set<string>()
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('musinsa_settlement_lines')
        .select('order_no, order_serial, style_no, option_name')
        .eq('channel', CHANNEL_NAME)
        .eq('order_type', '판매')
        .range(from, from + PAGE - 1)
      if (error || !data || data.length === 0) break
      data.forEach((r: any) => saleLineKeysOf(r).forEach(k => keys.add(k)))
      if (data.length < PAGE) break
    }
    return keys
  }

  // 이 환불행에 대응되는 "판매" 건이 실제로 데이터에 있는지
  function refundHasMatchingSale(row: any, saleKeys: Set<string>): boolean {
    return saleLineKeysOf(row).some(k => saleKeys.has(k))
  }

  // 옵션명 매칭용 정규화: 대소문자 무관 + "NONE"/"FREE"/"F"/빈값을 전부 "옵션 없음"으로 동일 취급
  // (재고 테이블엔 "F"로 짧게 저장된 경우가 있고, 정산내역엔 "NONE"으로 찍히는 등 표기가 제각각이라서)
  function normalizeOptionForMatch(opt: any): string {
    const v = String(opt || '').trim().toUpperCase()
    if (v === '' || v === 'NONE' || v === 'FREE' || v === 'F') return 'FREE'
    return v
  }

  // 스타일넘버 매칭용 정규화: 대소문자 무관 + 공백 전부 제거 ("SH #1" vs "SH#1" 같은 표기 차이 흡수)
  function normalizeSkuForMatch(sku: any): string {
    return String(sku || '').toUpperCase().replace(/\s+/g, '')
  }

  function shiftViewMonth(delta: number) {
    let nextMonth = viewMonthIdx + delta
    let nextYear = year
    if (nextMonth < 0) { nextMonth = 11; nextYear -= 1 }
    else if (nextMonth > 11) { nextMonth = 0; nextYear += 1 }
    setViewMonthIdx(nextMonth)
    if (nextYear !== year) setYear(nextYear)
  }

  async function loadChartData(targetYear: number) {
    setChartLoading(true)
    const { data: curRows } = await supabase
      .from('musinsa_settlement_lines')
      .select('settle_date, qty, revenue_ao, commission_sale, discount, musinsa_coupon, musinsa_cart_coupon, reward_points, penalty, claim_shipping_fee, review_boost, mfs_logistics, net_settlement, order_type')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', `${targetYear}-01-01`)
      .lte('settle_date', `${targetYear}-12-31`)

    const grossArr = new Array(12).fill(0)
    const netArr = new Array(12).fill(0)
    const qtyArr = new Array(12).fill(0)
    const refundQtyArr = new Array(12).fill(0)
    ;(curRows || []).forEach((row: any) => {
      const m = new Date(row.settle_date).getMonth()
      const { settlementAmount } = computeCommissionAndSettlement(row)
      grossArr[m] += row.revenue_ao || 0
      netArr[m] += settlementAmount
      const orderType = row.order_type || ''
      if (orderType === '판매') qtyArr[m] += row.qty || 0
      else if (orderType.includes('환불') || orderType.includes('반품')) refundQtyArr[m] += row.qty || 0
    })
    setChartMonthlyGross(grossArr)

    // 대시보드 KPI와 완전히 같은 결과가 나오도록, 날짜 없는 기간 요약 항목(반품비결제 등)도 반영
    const { data: extraRows } = await supabase
      .from('musinsa_settlement_extra_fees')
      .select('month, return_fee_settle, claim_return_fee, shipping_fee_settle, review_boost_extra, mfs_logistics_extra, low_price_shipping_support')
      .eq('channel', CHANNEL_NAME)
      .eq('year', targetYear)
    ;(extraRows || []).forEach((row: any) => {
      const idx = (row.month || 1) - 1
      const extraTotal = (row.return_fee_settle || 0) + (row.claim_return_fee || 0) + (row.shipping_fee_settle || 0) + (row.review_boost_extra || 0) + (row.mfs_logistics_extra || 0) + (row.low_price_shipping_support || 0)
      netArr[idx] -= extraTotal
    })

    setChartMonthlySettleNet(netArr)
    setChartMonthlyQtySale(qtyArr)
    setChartMonthlyQtyRefund(refundQtyArr)
    setChartHasData((curRows || []).length > 0)

    const prevYear = targetYear - 1
    const { data: prevRows } = await supabase
      .from('musinsa_settlement_lines')
      .select('settle_date, qty, revenue_ao, commission_sale, discount, musinsa_coupon, musinsa_cart_coupon, reward_points, penalty, claim_shipping_fee, review_boost, mfs_logistics, net_settlement, order_type')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', `${prevYear}-01-01`)
      .lte('settle_date', `${prevYear}-12-31`)

    const prevGrossArr = new Array(12).fill(0)
    const prevNetArr = new Array(12).fill(0)
    const prevQtySaleArr = new Array(12).fill(0)
    ;(prevRows || []).forEach((row: any) => {
      const m = new Date(row.settle_date).getMonth()
      const { settlementAmount } = computeCommissionAndSettlement(row)
      prevGrossArr[m] += row.revenue_ao || 0
      prevNetArr[m] += settlementAmount
      if ((row.order_type || '') === '판매') prevQtySaleArr[m] += row.qty || 0
    })
    setChartPrevYearGross(prevGrossArr)
    setChartPrevYearNet(prevNetArr)
    setChartPrevYearQtySale(prevQtySaleArr)
    setChartHasPrevYearData((prevRows || []).length > 0)

    setChartLoading(false)
  }

  function shiftChartYear(delta: number) {
    const nextYear = chartYear + delta
    setChartYear(nextYear)
    loadChartData(nextYear)
  }

  async function loadData() {
    setLoading(true)

    // 배송중(정산 대기) 주문 — 송장파일로 등록됐지만 아직 정산내역에 안 나온 건들 (재고 파악용 수량)
    const { data: pendingRows } = await supabase
      .from('musinsa_pending_orders')
      .select('qty, ordered_at')
      .eq('channel', CHANNEL_NAME)
    let pendTotal = 0
    const pendMonthly = new Array(12).fill(0)
    ;(pendingRows || []).forEach((row: any) => {
      const q = row.qty || 0
      pendTotal += q
      if (row.ordered_at) {
        const d = new Date(row.ordered_at)
        if (d.getFullYear() === year) pendMonthly[d.getMonth()] += q
      }
    })
    setPendingQtyTotal(pendTotal)
    setPendingMonthlyQty(pendMonthly)
    const { data } = await supabase
      .from('sales')
      .select(`qty, gross_revenue, net_revenue, order_date, items!inner(id, name, option_name, cost_price), channels!inner(name)`)
      .eq('channels.name', CHANNEL_NAME)
      .gte('order_date', `${year}-01-01`)
      .lte('order_date', `${year}-12-31`)

    const map: Record<string, any> = {}
    const monthly = new Array(12).fill(0)
    ;(data || []).forEach((row: any) => {
      const key = `${row.items?.id}`
      if (!map[key]) map[key] = { item_id: row.items?.id, item_name: row.items?.name || '', option_name: row.items?.option_name || '', qty: 0, gross: 0, cost: row.items?.cost_price || 0 }
      map[key].qty   += row.qty || 0
      map[key].gross += row.gross_revenue || 0

      if (row.order_date) {
        const m = new Date(row.order_date).getMonth()
        monthly[m] += row.gross_revenue || 0
      }
    })
    setSales(Object.values(map).sort((a: any, b: any) => b.qty - a.qty))
    setMonthlyGross(monthly)

    // 광고 성과 (엑셀로 업로드된 ad_performance 테이블에서 조회)
    const { data: adRows } = await supabase
      .from('ad_performance')
      .select('ad_date, ad_cost, conversion_revenue')
      .eq('channel', CHANNEL_NAME)
      .gte('ad_date', `${year}-01-01`)
      .lte('ad_date', `${year}-12-31`)

    const adCostArr = new Array(12).fill(0)
    const adRevenueArr = new Array(12).fill(0)
    ;(adRows || []).forEach((row: any) => {
      const m = new Date(row.ad_date).getMonth()
      adCostArr[m] += row.ad_cost || 0
      adRevenueArr[m] += row.conversion_revenue || 0
    })
    setMonthlyAdCost(adCostArr)
    setMonthlyAdRevenue(adRevenueArr)

    // 충전 광고비 — 무신사가 매달 무료로 주는 10만원을 제외하고, 실제로 내가 충전한 금액만 직접 입력해서 관리
    const { data: chargeRows } = await supabase
      .from('musinsa_ad_charge')
      .select('month, charged_amount')
      .eq('channel', CHANNEL_NAME)
      .eq('year', year)
    const chargeArr = new Array(12).fill(0)
    ;(chargeRows || []).forEach((row: any) => {
      const idx = (row.month || 1) - 1
      chargeArr[idx] = row.charged_amount || 0
    })
    setMonthlyAdCharge(chargeArr)

    // 정산내역 — 일별 주문표(musinsa_settlement_lines)의 건별 데이터를 그대로 합산
    // (팝업에서 보이는 매출액/정산금액 계산식과 완전히 동일하게 맞춰서 숫자가 항상 일치하도록 함)
    const { data: lineRows } = await supabase
      .from('musinsa_settlement_lines')
      .select('settle_date, qty, revenue_ao, commission_sale, discount, musinsa_coupon, musinsa_cart_coupon, reward_points, penalty, claim_shipping_fee, review_boost, mfs_logistics, net_settlement, claim_amount, matched_cost, order_type, item_name, style_no, option_name')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', `${year}-01-01`)
      .lte('settle_date', `${year}-12-31`)

    // 베스트 상품 순위 / 카테고리별 판매량은 loadBestAndCategory()에서 별도(전체 기간/연도 필터) 처리함
    const claimArr = new Array(12).fill(0)
    const settleGrossArr = new Array(12).fill(0)   // 매출액(AO) 합계
    const settleNetArr = new Array(12).fill(0)      // 정산금액 합계 (= 순매출액)
    const settleCostArr = new Array(12).fill(0)
    const settleShippingArr = new Array(12).fill(0)
    const qtySaleArr = new Array(12).fill(0)        // 구분="판매" 수량
    const qtyRefundArr = new Array(12).fill(0)      // 구분에 "환불"/"반품" 포함된 수량
    ;(lineRows || []).forEach((row: any) => {
      const m = new Date(row.settle_date).getMonth()
      const { settlementAmount } = computeCommissionAndSettlement(row)
      const lineShipping = (row.qty || 0) * shippingRateFor(row.settle_date)

      const orderType = row.order_type || ''
      // 순수 "판매"만 판매수량으로 집계 (판매/교환, 판매/환불처럼 섞인 구분은 제외)
      // 무신사 정산 파일의 "판매/환불" 조정 행은 수량이 항상 0으로 찍혀있어서(환불 수량이 원래 판매 행에만 기록됨),
      // 그대로 더하면 환불수량이 항상 0이 되어버림 → 환불 행인데 수량이 0이면 최소 1개로 추정해서 집계
      if (orderType.includes('환불') || orderType.includes('반품')) qtyRefundArr[m] += (row.qty && row.qty > 0) ? row.qty : 1
      else if (orderType === '판매') {
        qtySaleArr[m] += row.qty || 0
      }

      claimArr[m] += row.claim_amount || 0
      settleGrossArr[m] += row.revenue_ao || 0
      settleNetArr[m] += settlementAmount
      settleCostArr[m] += row.matched_cost || 0
      settleShippingArr[m] += lineShipping
    })

    // 전년 대비 매출/순매출액/순수익 (대시보드 3개 카드용, 연간 합계 + 월별 둘 다 계산 — 없으면 0으로 처리)
    const prevYearForDash = year - 1
    const { data: prevYearRows } = await supabase
      .from('musinsa_settlement_lines')
      .select('settle_date, qty, revenue_ao, commission_sale, discount, musinsa_coupon, musinsa_cart_coupon, reward_points, penalty, claim_shipping_fee, review_boost, mfs_logistics, net_settlement, matched_cost')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', `${prevYearForDash}-01-01`)
      .lte('settle_date', `${prevYearForDash}-12-31`)
    const prevYearMonthlyGrossArr = new Array(12).fill(0)
    const prevYearMonthlyNetArr = new Array(12).fill(0)
    const prevYearMonthlyCostArr = new Array(12).fill(0)
    const prevYearMonthlyShippingArr = new Array(12).fill(0)
    ;(prevYearRows || []).forEach((r: any) => {
      const m = new Date(r.settle_date).getMonth()
      const { settlementAmount } = computeCommissionAndSettlement(r)
      prevYearMonthlyGrossArr[m] += r.revenue_ao || 0
      prevYearMonthlyNetArr[m] += settlementAmount
      prevYearMonthlyCostArr[m] += r.matched_cost || 0
      prevYearMonthlyShippingArr[m] += (r.qty || 0) * shippingRateFor(r.settle_date)
    })

    // 전년도 날짜 없는 기간 요약 항목(반품비결제 등)도 순매출액에서 차감
    const { data: prevExtraRows } = await supabase
      .from('musinsa_settlement_extra_fees')
      .select('month, return_fee_settle, claim_return_fee, shipping_fee_settle, review_boost_extra, mfs_logistics_extra, low_price_shipping_support')
      .eq('channel', CHANNEL_NAME)
      .eq('year', prevYearForDash)
    ;(prevExtraRows || []).forEach((row: any) => {
      const idx = (row.month || 1) - 1
      const extraTotal = (row.return_fee_settle || 0) + (row.claim_return_fee || 0) + (row.shipping_fee_settle || 0) + (row.review_boost_extra || 0) + (row.mfs_logistics_extra || 0) + (row.low_price_shipping_support || 0)
      prevYearMonthlyNetArr[idx] -= extraTotal
    })

    // 전년도 충전 광고비
    const { data: prevChargeRows } = await supabase
      .from('musinsa_ad_charge')
      .select('month, charged_amount')
      .eq('channel', CHANNEL_NAME)
      .eq('year', prevYearForDash)
    const prevYearMonthlyAdChargeArr = new Array(12).fill(0)
    ;(prevChargeRows || []).forEach((row: any) => {
      const idx = (row.month || 1) - 1
      prevYearMonthlyAdChargeArr[idx] = row.charged_amount || 0
    })

    const prevYearMonthlyProfitArr = prevYearMonthlyNetArr.map((net, i) => net - prevYearMonthlyCostArr[i] - prevYearMonthlyShippingArr[i] - prevYearMonthlyAdChargeArr[i])

    setDashPrevYearMonthlyGross(prevYearMonthlyGrossArr)
    setDashPrevYearMonthlyNet(prevYearMonthlyNetArr)
    setDashPrevYearMonthlyProfit(prevYearMonthlyProfitArr)

    const prevYearGrossSum = prevYearMonthlyGrossArr.reduce((s, v) => s + v, 0)
    const prevYearNetSum = prevYearMonthlyNetArr.reduce((s, v) => s + v, 0)
    const prevYearProfitSum = prevYearMonthlyProfitArr.reduce((s, v) => s + v, 0)
    setPrevYearNetTotal(prevYearNetSum)
    setPrevYearProfitTotal(prevYearProfitSum)

    const thisYearGrossSum = (lineRows || []).reduce((s: number, r: any) => s + (r.revenue_ao || 0), 0)
    setYoyDashboardPct(prevYearGrossSum > 0 ? Math.round(((thisYearGrossSum - prevYearGrossSum) / prevYearGrossSum) * 1000) / 10 : null)

    // 날짜 없는 기간 요약 항목(반품비결제/청구반품비/배송비결제/후기부스팅/MFS물류비)도
    // 해당 월의 순매출액에서 추가로 차감 (일별 주문표 팝업 footer랑 항상 같은 결과가 나오도록)
    const { data: extraRows } = await supabase
      .from('musinsa_settlement_extra_fees')
      .select('month, return_fee_settle, claim_return_fee, shipping_fee_settle, review_boost_extra, mfs_logistics_extra, low_price_shipping_support')
      .eq('channel', CHANNEL_NAME)
      .eq('year', year)
    ;(extraRows || []).forEach((row: any) => {
      const idx = (row.month || 1) - 1
      const extraTotal = (row.return_fee_settle || 0) + (row.claim_return_fee || 0) + (row.shipping_fee_settle || 0) + (row.review_boost_extra || 0) + (row.mfs_logistics_extra || 0) + (row.low_price_shipping_support || 0)
      settleNetArr[idx] -= extraTotal
    })

    setMonthlyClaim(claimArr)
    setMonthlySettleGross(settleGrossArr)
    setMonthlySettleNet(settleNetArr)
    setMonthlySettleCost(settleCostArr)
    setMonthlySettleShipping(settleShippingArr)
    setMonthlyQtySale(qtySaleArr)
    setMonthlyQtyRefund(qtyRefundArr)
    setHasSettlementData((lineRows || []).length > 0)

    setLoading(false)
  }

  // 베스트 상품 순위 / 카테고리별 판매량 전용 로더
  // 상단 KPI의 year와 완전히 독립적으로 동작: yearFilter가 '전체'면 전체 기간을 다 모아서 집계하고,
  // 특정 연도가 선택되면 그 연도만 집계함. 필터가 무엇이든 사용 가능한 연도 목록(전체 데이터 기준)은 항상 최신으로 유지
  async function loadBestAndCategory(yearFilter: string) {
    setBestCatLoading(true)

    let query = supabase
      .from('musinsa_settlement_lines')
      .select('settle_date, qty, revenue_ao, commission_sale, discount, musinsa_coupon, musinsa_cart_coupon, reward_points, penalty, claim_shipping_fee, review_boost, mfs_logistics, net_settlement, matched_cost, order_type, item_name, style_no, option_name')
      .eq('channel', CHANNEL_NAME)
    if (yearFilter !== '전체') {
      query = query.gte('settle_date', `${yearFilter}-01-01`).lte('settle_date', `${yearFilter}-12-31`)
    }
    const { data: rows } = await query

    // 환불 건을 차감할지 판단하기 위해, 전체 기간의 "판매" 건 키를 미리 모아둠
    // (환불의 원래 판매분이 다른 연도/월에 있을 수 있어서 연도 필터와 무관하게 전체를 조회)
    const saleLineKeys = await loadSaleLineKeys()

    // 재고와 매칭할 카테고리·시즌 정보 조회
    const { data: catItems } = await supabase.from('items').select('sku, name, option_name, category, season')
    const catBySkuOption = new Map<string, { category: string; season: string }>()
    const catByNameOption = new Map<string, { category: string; season: string }>()
    const nameBySku = new Map<string, string>() // 스타일넘버 → 재고 제어판에 등록된 정식 상품명 (옵션 무관, 표시용)
    ;(catItems || []).forEach((it: any) => {
      const info = { category: it.category || '미분류', season: it.season || '미지정' }
      const opt = normalizeOptionForMatch(it.option_name)
      if (it.sku) {
        const skuKeyCI = normalizeSkuForMatch(it.sku)
        catBySkuOption.set(`${skuKeyCI}__${opt}`, info)
        if (it.name && !nameBySku.has(skuKeyCI)) nameBySku.set(skuKeyCI, it.name)
      }
      catByNameOption.set(`${String(it.name).trim().toUpperCase()}__${opt}`, info)
    })

    const bestItemMap = new Map<string, { key: string; item_name: string; style_no: string; option_name: string; qty: number; pendingQty: number; revenue: number; netRevenue: number; profit: number; season: string }>()
    const categoryQtyMap = new Map<string, number>()
    const yearsInData = new Set<number>()

    ;(rows || []).forEach((row: any) => {
      if (row.settle_date) yearsInData.add(new Date(row.settle_date).getFullYear())

      const orderType = row.order_type || ''
      // 환불/반품 건은 그 주문의 "판매" 건이 데이터에 실제로 있을 때만 수량을 차감함.
      // (원래 판매 기록이 없는 환불행까지 빼면 팔지도 않은 수량이 마이너스로 잡히므로 그런 행은 0으로 처리)
      // 파일에 수량이 0으로 찍힌 환불행은 일별 주문표와 똑같이 1개로 추정
      const isRefund = orderType.includes('반품') || orderType.includes('환불')
      const rawQty = row.qty || 0
      const hasMatchingSale = isRefund && refundHasMatchingSale(row, saleLineKeys)
      const signedQty = isRefund ? (hasMatchingSale ? -(rawQty > 0 ? rawQty : 1) : 0) : rawQty

      const { settlementAmount } = computeCommissionAndSettlement(row)
      const lineShipping = signedQty * shippingRateFor(row.settle_date)
      const lineCost = isRefund ? -(row.matched_cost || 0) : (row.matched_cost || 0)
      // 순수익(라인 단위) = 정산금액 - 원가 - 택배비 (대시보드 전체 순수익 계산식과 동일)
      const lineProfit = settlementAmount - lineCost - lineShipping

      const styleNo = (row.style_no || '').trim()
      const optionName = (row.option_name || '').trim()
      const itemName = (row.item_name || '').trim()
      const rowOptKeyBC = normalizeOptionForMatch(optionName)
      const info = (styleNo && catBySkuOption.get(`${normalizeSkuForMatch(styleNo)}__${rowOptKeyBC}`)) || catByNameOption.get(`${itemName.toUpperCase()}__${rowOptKeyBC}`)
      const category = info?.category || '미분류'
      const season = info?.season || '미지정'
      // 재고 제어판에 등록된 스타일넘버가 있으면 그 정식 상품명으로 표시(정산내역 상품명 표기가 들쭉날쭉해도 통일됨), 없으면 정산내역 상품명 그대로
      const displayName = (styleNo && nameBySku.get(normalizeSkuForMatch(styleNo))) || row.item_name || '(상품명 없음)'

      const key = `${row.style_no || ''}__${row.option_name || ''}__${displayName}`
      const prev = bestItemMap.get(key) || { key, item_name: displayName, style_no: row.style_no || '-', option_name: row.option_name || '-', qty: 0, pendingQty: 0, revenue: 0, netRevenue: 0, profit: 0, season }
      bestItemMap.set(key, { ...prev, qty: prev.qty + signedQty, revenue: prev.revenue + (row.revenue_ao || 0), netRevenue: prev.netRevenue + settlementAmount, profit: prev.profit + lineProfit })

      categoryQtyMap.set(category, (categoryQtyMap.get(category) || 0) + signedQty)
    })

    // 배송중(정산 대기) 주문도 같은 상품 줄에 합쳐서 보여줌 — 수량만 별도 컬럼으로 표시(매출/순수익엔 미반영)
    const { data: pendRows } = await supabase
      .from('musinsa_pending_orders')
      .select('style_no, option_name, item_name, qty')
      .eq('channel', CHANNEL_NAME)
    ;(pendRows || []).forEach((p: any) => {
      const styleNo = (p.style_no || '').trim()
      const optionName = (p.option_name || '').trim()
      const itemName = (p.item_name || '').trim()
      const optKey = normalizeOptionForMatch(optionName)
      const info = (styleNo && catBySkuOption.get(`${normalizeSkuForMatch(styleNo)}__${optKey}`)) || catByNameOption.get(`${itemName.toUpperCase()}__${optKey}`)
      const season = info?.season || '미지정'
      const displayName = (styleNo && nameBySku.get(normalizeSkuForMatch(styleNo))) || itemName || '(상품명 없음)'

      // 정산에서 만들어진 줄과 같은 키를 쓰되, 옵션 표기가 미세하게 달라 못 찾으면
      // 스타일넘버+옵션이 같은 기존 줄을 찾아 거기에 합침 (그래도 없으면 새 줄 생성)
      const key = `${styleNo}__${optionName}__${displayName}`
      let target = bestItemMap.get(key)
      if (!target) {
        for (const v of bestItemMap.values()) {
          if (normalizeSkuForMatch(v.style_no) === normalizeSkuForMatch(styleNo) && normalizeOptionForMatch(v.option_name) === optKey) { target = v; break }
        }
      }
      if (target) {
        bestItemMap.set(target.key, { ...target, pendingQty: target.pendingQty + (p.qty || 0) })
      } else {
        bestItemMap.set(key, {
          key, item_name: displayName, style_no: styleNo || '-', option_name: optionName || '-',
          qty: 0, pendingQty: p.qty || 0, revenue: 0, netRevenue: 0, profit: 0, season,
        })
      }
    })

    // 스크롤로 전체를 볼 수 있게 개수 제한 없이 전부 저장 (정렬은 판매량 + 배송중 합계 기준)
    setBestItems(Array.from(bestItemMap.values()).sort((a, b) => (b.qty + b.pendingQty) - (a.qty + a.pendingQty)))
    setCategorySales(Array.from(categoryQtyMap.entries()).map(([category, qty]) => ({ category, qty })).sort((a, b) => b.qty - a.qty))

    // '전체' 기간으로 불러왔을 때만 연도 드롭다운 목록을 갱신 (특정 연도만 조회하면 그 연도 데이터만 보여서 목록이 좁아짐)
    if (yearFilter === '전체' && yearsInData.size > 0) {
      setBestCatAvailableYears(Array.from(yearsInData).sort((a, b) => b - a))
    }

    setBestCatLoading(false)
  }

  // "2,930" 같은 콤마 포함 숫자/퍼센트 문자열을 숫자로 변환
  function parseNum(v: any): number {
    if (v === null || v === undefined || v === '') return 0
    if (typeof v === 'number') return v
    const cleaned = String(v).replace(/,/g, '').replace(/%/g, '').trim()
    const n = parseFloat(cleaned)
    return isNaN(n) ? 0 : n
  }

  async function parseAdFile(file: File): Promise<any[]> {
    if (file.name.toLowerCase().endsWith('.csv')) {
      const text = await file.text()
      const lines = text.replace(/^\uFEFF/, '').split(/\r\n|\n/).filter(l => l.trim().length > 0)
      if (lines.length < 2) return []
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
          } else {
            cur += ch
          }
        }
        cells.push(cur)
        return cells
      }
      const headers = parseLine(lines[0])
      return lines.slice(1).map(line => {
        const cells = parseLine(line)
        const obj: any = {}
        headers.forEach((h, i) => { obj[h] = cells[i] })
        return obj
      })
    } else {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const sheetName = wb.SheetNames.includes('광고 성과') ? '광고 성과' : wb.SheetNames[0]
      return XLSX.utils.sheet_to_json(wb.Sheets[sheetName])
    }
  }

  async function loadDailyRows(targetYear: number, monthIdx: number) {
    setDailyLoading(true)
    const m = monthIdx + 1
    const startDate = `${targetYear}-${String(m).padStart(2, '0')}-01`
    const endDate = monthEndDateStr(targetYear, m)
    const { data } = await supabase
      .from('ad_performance')
      .select('*')
      .eq('channel', CHANNEL_NAME)
      .gte('ad_date', startDate)
      .lte('ad_date', endDate)
      .order('ad_date', { ascending: true })
    setDailyRows(data || [])
    setDailyLoading(false)
  }

  function openDailyModal() {
    setShowDailyModal(true)
    setDailyYear(year)
    setDailyMonthIdx(viewMonthIdx)
    loadDailyRows(year, viewMonthIdx)
  }

  function shiftDailyMonth(delta: number) {
    let nextMonth = dailyMonthIdx + delta
    let nextYear = dailyYear
    if (nextMonth < 0) { nextMonth = 11; nextYear -= 1 }
    else if (nextMonth > 11) { nextMonth = 0; nextYear += 1 }
    setDailyMonthIdx(nextMonth)
    setDailyYear(nextYear)
    loadDailyRows(nextYear, nextMonth)
  }

  async function loadOrderRows(targetYear: number, monthIdx: number) {
    setOrderLoading(true)
    const m = monthIdx + 1
    const startDate = `${targetYear}-${String(m).padStart(2, '0')}-01`
    const endDate = monthEndDateStr(targetYear, m)
    const { data } = await supabase
      .from('musinsa_settlement_lines')
      .select('*')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', startDate)
      .lte('settle_date', endDate)
      .order('settle_date', { ascending: true })
    setOrderRows(data || [])

    // 시즌 표시용 — 스타일넘버+옵션 우선, 없으면 상품명+옵션으로 재고 아이템과 매칭 (다른 곳의 매칭 로직과 동일)
    const { data: seasonItems } = await supabase.from('items').select('sku, name, option_name, season')
    const bySkuOption = new Map<string, string>()
    const byNameOption = new Map<string, string>()
    ;(seasonItems || []).forEach((it: any) => {
      const season = it.season || '미지정'
      const opt = normalizeOptionForMatch(it.option_name)
      if (it.sku) bySkuOption.set(`${normalizeSkuForMatch(it.sku)}__${opt}`, season)
      byNameOption.set(`${String(it.name).trim().toUpperCase()}__${opt}`, season)
    })
    setOrderSeasonBySkuOption(bySkuOption)
    setOrderSeasonByNameOption(byNameOption)

    // 환불행을 -1로 볼지 0으로 볼지 판단용 — 전체 기간의 "판매" 건 키 목록
    // 주문번호는 주문 단위(한 주문에 여러 상품 가능)라 상품 줄 단위로 고유한 "주문일련번호"로 대조하고,
    // 일련번호가 없는 예전 데이터는 주문번호+스타일넘버+옵션 조합으로 보조 대조
    setOrderSaleOrderNos(await loadSaleLineKeys())

    const { data: extraData } = await supabase
      .from('musinsa_settlement_extra_fees')
      .select('*')
      .eq('channel', CHANNEL_NAME)
      .eq('year', targetYear)
      .eq('month', m)
      .maybeSingle()
    setOrderExtraFees(extraData || null)

    setOrderLoading(false)
  }

  function openOrderModal() {
    setShowOrderModal(true)
    setOrderYear(year)
    setOrderMonthIdx(viewMonthIdx)
    loadOrderRows(year, viewMonthIdx)
  }

  // 배송중(정산 대기) 목록 팝업 — 송장파일로 등록됐지만 아직 정산내역에 안 나온 주문들
  async function openPendingModal(monthOnly: boolean) {
    setShowPendingModal(true)
    setPendingMonthOnly(monthOnly)
    setPendingLoading(true)
    const { data } = await supabase
      .from('musinsa_pending_orders')
      .select('*')
      .eq('channel', CHANNEL_NAME)
      .order('ordered_at', { ascending: false })
    setPendingRows(data || [])
    setPendingLoading(false)
  }

  // 이 주문은 이미 정산에 반영됐거나 취소돼서 목록에서 빼고 싶을 때 직접 삭제
  async function deletePendingOrder(row: any) {
    if (!confirm(`이 주문을 배송중 목록에서 지울까요?\n${row.item_name || ''} ${row.option_name || ''} ${row.qty}개`)) return
    const { error } = await supabase.from('musinsa_pending_orders').delete().eq('id', row.id)
    if (error) { alert(`삭제 실패: ${error.message}`); return }
    setPendingRows(rows => rows.filter(r => r.id !== row.id))
    loadData()
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

  // 지금 팝업에서 보고 있는 "그 달"만 정확히 지움 — 다른 달 데이터는 날짜 범위 밖이라 절대 영향 없음
  async function deleteMonthData() {
    const m = orderMonthIdx + 1
    const startDate = `${orderYear}-${String(m).padStart(2, '0')}-01`
    const endDate = monthEndDateStr(orderYear, m)

    const confirmMsg = `${orderYear}년 ${m}월 정산 데이터를 전체 삭제할까요?\n(${startDate} ~ ${endDate})\n\n이 작업은 되돌릴 수 없고, 다른 달 데이터는 전혀 영향받지 않습니다.`
    if (!confirm(confirmMsg)) return
    if (!confirm('정말로 삭제하시겠습니까? 한 번 더 확인합니다.')) return

    setOrderLoading(true)
    const { error: linesErr } = await supabase.from('musinsa_settlement_lines')
      .delete().eq('channel', CHANNEL_NAME).gte('settle_date', startDate).lte('settle_date', endDate)
    const { error: dailyErr } = await supabase.from('musinsa_settlement')
      .delete().eq('channel', CHANNEL_NAME).gte('settle_date', startDate).lte('settle_date', endDate)

    if (linesErr || dailyErr) {
      alert('삭제 중 오류가 발생했습니다.\n' + (linesErr?.message || '') + ' ' + (dailyErr?.message || ''))
    } else {
      alert(`${orderYear}년 ${m}월 데이터를 삭제했습니다.`)
    }
    loadOrderRows(orderYear, orderMonthIdx)
    loadData()
    loadChartData(chartYear)
    loadBestAndCategory(bestCatYearFilter)
  }

  // 원가 확인 팝업 — 일별 주문표(musinsa_settlement_lines)와 완전히 같은 테이블에서 집계하므로
  // 두 팝업의 숫자가 항상 서로 일치함. monthIdx를 주면 그 달만, 안 주면 연간 전체 집계
  const [costModalScope, setCostModalScope] = useState<string>('') // 화면에 표시할 범위 라벨
  async function loadCostBreakdown(monthIdx?: number) {
    setCostLoading(true)
    let startDate = `${year}-01-01`
    let endDate = `${year}-12-31`
    if (monthIdx !== undefined) {
      const m = monthIdx + 1
      startDate = `${year}-${String(m).padStart(2, '0')}-01`
      endDate = monthEndDateStr(year, m)
      setCostModalScope(`${year}년 ${m}월`)
    } else {
      setCostModalScope(`${year}년 전체`)
    }
    const { data } = await supabase
      .from('musinsa_settlement_lines')
      .select('item_name, style_no, option_name, qty, matched_cost, cost_matched')
      .eq('channel', CHANNEL_NAME)
      .gte('settle_date', startDate)
      .lte('settle_date', endDate)

    const map = new Map<string, { key: string; itemName: string; styleNo: string; option: string; qty: number; cost: number; matched: boolean }>()
    ;(data || []).forEach((row: any) => {
      const key = `${row.style_no || ''}__${row.option_name || ''}__${row.item_name || ''}`
      const prev = map.get(key) || { key, itemName: row.item_name || '(상품명 없음)', styleNo: row.style_no || '-', option: row.option_name || '-', qty: 0, cost: 0, matched: row.cost_matched }
      map.set(key, {
        ...prev,
        qty: prev.qty + (row.qty || 0),
        cost: prev.cost + (row.matched_cost || 0),
        matched: prev.matched || row.cost_matched,
      })
    })
    setCostRows(Array.from(map.values()).sort((a, b) => (a.matched === b.matched ? b.cost - a.cost : a.matched ? 1 : -1)))
    setCostLoading(false)
  }

  function openEditLine(row: any) {
    setEditLineTarget(row)
    setEditLineForm({ item_name: row.item_name || '', style_no: row.style_no || '' })
  }

  async function saveEditLine() {
    if (!editLineTarget) return
    setEditLineSaving(true)
    try {
      const newItemName = editLineForm.item_name.trim()
      const newStyleNo = editLineForm.style_no.trim()
      const optionName = (editLineTarget.option_name || '').trim()

      // 수정한 스타일넘버/상품명으로 재고를 다시 매칭해서 원가·판매가도 같이 갱신
      const { data: allItems } = await supabase.from('items').select('sku, name, option_name, cost_price, sell_price')
      const optionKeyEL = normalizeOptionForMatch(optionName)
      const matched = (allItems || []).find((it: any) =>
        (newStyleNo && normalizeSkuForMatch(it.sku) === normalizeSkuForMatch(newStyleNo) && normalizeOptionForMatch(it.option_name) === optionKeyEL)
        || (String(it.name).trim().toUpperCase() === newItemName.toUpperCase() && normalizeOptionForMatch(it.option_name) === optionKeyEL)
      )
      const qty = editLineTarget.qty || 0
      const matchedCost = matched ? (matched.cost_price || 0) * qty : 0
      const registeredSellPrice = matched ? (matched.sell_price || 0) : 0

      const { error } = await supabase.from('musinsa_settlement_lines').update({
        item_name: newItemName,
        style_no: newStyleNo,
        matched_cost: matchedCost,
        cost_matched: !!matched,
        registered_sell_price: registeredSellPrice,
      }).eq('id', editLineTarget.id)

      if (error) {
        alert('저장 실패: ' + (error.message || JSON.stringify(error)))
      } else {
        setEditLineTarget(null)
        loadOrderRows(orderYear, orderMonthIdx)
        loadData()
        loadChartData(chartYear)
        loadBestAndCategory(bestCatYearFilter)
      }
    } finally {
      setEditLineSaving(false)
    }
  }

  function openCostModal() {
    setShowCostModal(true)
    loadCostBreakdown()
  }

  function openCostModalForMonth() {
    setShowCostModal(true)
    loadCostBreakdown(viewMonthIdx)
  }

  // 무신사 "정산내역-상세" 파일은 진짜 엑셀이 아니라 HTML 표를 xls 확장자로 감싼 형태
  // 헤더 중 "반영금액"이 여러 번 중복돼서 이름으로는 못 찾으므로, 컬럼 위치(문자)로 직접 읽음
  const COL = {
    CATEGORY: 0, DATE: 1, ITEM_NAME: 7, OPTION: 8, STYLE_NO: 9, QTY: 17,
    SALE_AMOUNT: 18, CLAIM: 19,
    DISCOUNT: 21, MUSINSA_COUPON: 22, REWARD_POINTS: 23, MUSINSA_CART_COUPON: 25,
    VENDOR_COUPON: 29, CART_VENDOR_COUPON: 30,
    COMMISSION_SALE: 42, COMMISSION_DISCOUNT: 43, SUPPORT_FUND: 45, PENALTY: 46, CLAIM_SHIPPING_FEE: 47,
    REVIEW_BOOST: 48, MFS_LOGISTICS: 49,
    REVENUE_AO: 40, COMMISSION_AY: 50, NET_AZ: 51,
  }

  // 무신사 "일일정산확인" 파일 (역시 HTML 표를 xls 확장자로 감싼 형태) — "정산내역-상세"와 컬럼 구성이 다름
  // 0행이 바로 헤더이고, 상품명이 없는 행은 "총합계" 또는 "반품배송비/청구반품비/저단가배송비지원액/후기부스팅/배송비결제" 같은
  // 날짜 없는 기간 요약 행 (정산금액(AV, 페널티차감)열을 그대로 신뢰해서 씀 — 무신사가 이미 최종 계산해서 준 값)
  const COL2 = {
    CATEGORY: 0, DATE: 1, ITEM_NAME: 7, OPTION: 8, STYLE_NO: 9, QTY: 16,
    SALE_AMOUNT: 17, CLAIM: 18, DISCOUNT: 19, MUSINSA_COUPON: 20, MUSINSA_CART_COUPON: 21,
    VENDOR_COUPON: 23, CART_VENDOR_COUPON: 25, REWARD_POINTS: 27,
    COMMISSION_SALE: 40, PENALTY: 44, CLAIM_SHIPPING_FEE: 45, REVIEW_BOOST: 46,
    NET_SETTLEMENT: 47,
  }

  type ParsedSettlement =
    | { format: 'detail'; header: string[]; rows: string[][] }
    | { format: 'daily'; header: string[]; rows: string[][] }
    | { format: 'invoice'; header: string[]; rows: string[][] }
    | { format: 'unknown'; header: string[]; rows: string[][] }
    | { format: 'frameset'; sheetFiles: string[]; header: string[]; rows: string[][] }

  async function parseAnySettlementFile(file: File): Promise<ParsedSettlement> {
    const text = await file.text()
    const parser = new DOMParser()
    const doc = parser.parseFromString(text, 'text/html')
    const table = doc.querySelector('table')
    if (!table) {
      // 엑셀에서 "웹 페이지, 전체"로 저장하면 이 .xls 파일 자체에는 표가 없고, 실제 데이터는
      // 같이 생성된 폴더(예: "파일명.files/sheet001.htm") 안에 따로 들어있는 경우가 있음 — 그 경우를 구분해서 안내
      if (text.includes('Excel Workbook Frameset') || /<frameset/i.test(text)) {
        const sheetFiles = Array.from(text.matchAll(/href="([^"]+\.files\/sheet\d+\.htm)"/gi)).map(m => m[1])
        return { format: 'frameset', sheetFiles: Array.from(new Set(sheetFiles)), header: [], rows: [] }
      }
      return { format: 'unknown', header: [], rows: [] }
    }
    const trs = Array.from(table.querySelectorAll('tr'))
    if (trs.length < 2) return { format: 'unknown', header: [], rows: [] }

    const allRowCells = trs.map(tr => Array.from(tr.querySelectorAll('td,th')).map(td => (td.textContent || '').trim()))

    // 파일마다 안내문/빈 줄이 앞에 몇 줄 더 붙어있을 수 있어서, 헤더 위치를 고정하지 않고
    // 앞쪽 몇 줄(최대 5줄) 안에서 "이 줄이 헤더다"라는 특징적인 셀들이 들어있는지로 찾음
    const scanLimit = Math.min(5, allRowCells.length)

    // "송장 주문내역(invoice_list)" 형식: 출고차수/주문번호로 시작하고 주문수량 열이 있는 행
    // (주문 직후 송장 출력용으로 받는 파일 — 정산 전이라 금액 없이 수량만 "배송중(정산 대기)"으로 저장)
    for (let i = 0; i < scanLimit; i++) {
      const cells = allRowCells[i]
      if (cells[0] === '출고차수' && cells.includes('주문번호')) {
        return { format: 'invoice', header: cells, rows: allRowCells.slice(i + 1) }
      }
    }

    // "일일정산확인" 형식: 구분/일자로 시작하고, 스타일넘버·판매수수료·정산금액(페널티차감) 열 이름이 어딘가에 들어있는 행
    for (let i = 0; i < scanLimit; i++) {
      const cells = allRowCells[i]
      if (cells[0] === '구분' && cells[1] === '일자' && cells.includes('스타일넘버') && cells.includes('판매수수료') && cells.includes('정산금액(페널티차감)')) {
        const rows = allRowCells.slice(i + 1)
        return { format: 'daily', header: cells, rows }
      }
    }

    // "정산내역-상세" 형식: "판매수수료"와 "합계금액" 열 이름이 함께 들어있는(52칸 이상) 행
    for (let i = 0; i < scanLimit; i++) {
      const cells = allRowCells[i]
      if (cells.length >= 52 && cells.includes('판매수수료') && cells.includes('합계금액')) {
        const rows = allRowCells.slice(i + 1)
        return { format: 'detail', header: cells, rows }
      }
    }

    console.warn('정산내역 업로드: 지원하는 헤더를 찾지 못했습니다. 앞 5줄:', allRowCells.slice(0, scanLimit))
    return { format: 'unknown', header: allRowCells[0] || [], rows: [] }
  }

  // 25.10월까지 -3,400원 / 25.11~26.4월 -2,900원 / 그 이후 -2,990원
  function shippingRateFor(dateStr: string): number {
    if (dateStr <= '2025-10-31') return 3400
    if (dateStr <= '2026-04-30') return 2900
    return 2990
  }

  async function processSettlementFile(file: File): Promise<{ added: number; failed: number; error: string; fileName: string }> {
    try {
      const parsed = await parseAnySettlementFile(file)

      // "송장 주문내역(invoice_list)" 파일: 주문 직후라 정산 전이므로 금액 없이 수량만 "배송중(정산 대기)"으로 저장.
      // 나중에 정산내역/일일정산확인이 업로드되면 주문번호+주문일련번호로 대조해서 자동으로 지워짐.
      if (parsed.format === 'invoice') {
        // B열(1)=주문번호, C열(2)=주문일련번호, M열(12)=스타일넘버, O열(14)=옵션, P열(15)=주문수량, Q열(16)=상품명, R열(17)=주문일시
        const pendingRecords: any[] = []
        for (const cells of parsed.rows) {
          const orderNo = (cells[1] || '').trim()
          const orderSerial = (cells[2] || '').trim()
          const qty = parseNum(cells[15]) || 0
          if (!orderNo || qty <= 0) continue
          const orderedAtRaw = (cells[17] || '').trim()
          pendingRecords.push({
            channel: CHANNEL_NAME,
            order_no: orderNo,
            order_serial: orderSerial,
            style_no: (cells[12] || '').trim(),
            option_name: (cells[14] || '').trim(),
            item_name: (cells[16] || '').trim(),
            qty,
            ordered_at: orderedAtRaw ? orderedAtRaw.replace(' ', 'T') : null,
          })
        }
        if (pendingRecords.length === 0) {
          return { added: 0, failed: 0, fileName: file.name, error: ' ⚠️ 송장파일로 인식했지만 저장할 주문 행이 없어요.' }
        }
        // 같은 주문번호+일련번호는 덮어쓰기 — 같은 송장파일을 다시 올려도 중복 안 생김
        const { error: pendErr } = await supabase.from('musinsa_pending_orders')
          .upsert(pendingRecords, { onConflict: 'order_no,order_serial' })
        if (pendErr) {
          const detail = `code=${pendErr.code || '-'} message=${pendErr.message || '-'}`
          console.error('musinsa_pending_orders upsert error:', detail, pendErr)
          return { added: 0, failed: pendingRecords.length, fileName: file.name, error: ` ⚠️ 배송중 주문 저장 실패: ${detail}` }
        }
        const totalQty = pendingRecords.reduce((s, r) => s + r.qty, 0)
        return { added: 0, failed: 0, fileName: file.name, error: ` 📦 송장파일로 인식 — 배송중(정산 대기) ${pendingRecords.length}건 / ${totalQty}개 저장됨. 나중에 정산내역이 업로드되면 자동으로 정리돼요.` }
      }

      // 무신사 "정산내역-상세" 또는 "일일정산확인" 형식인지 자동으로 인식 — 둘 다 아니면 데이터가 깨질 수 있어서 미리 막음
      // (기존 데이터 삭제/새 데이터 삽입을 시도하기 전에 미리 걸러서 데이터 손실을 막음)
      if (parsed.format === 'frameset') {
        // 엑셀에서 "웹 페이지, 전체"로 저장하면 이 .xls 파일에는 실제 표가 없고, 데이터는 같이 만들어진
        // "파일명.files" 폴더 안의 sheet001.htm 등에 들어있음 — 그 파일을 대신 올려야 함을 안내
        const sheetHint = parsed.sheetFiles.length > 0
          ? `이 파일과 같이 생성된 "${parsed.sheetFiles[0].split('/')[0]}" 폴더 안에서 "${parsed.sheetFiles[0].split('/')[1]}" 파일을 찾아 그걸 대신 업로드해주세요.`
          : '이 파일과 같이 생성된 "(파일명).files" 폴더 안의 "sheet001.htm" 파일을 찾아 그걸 대신 업로드해주세요.'
        return {
          added: 0,
          failed: 0,
          fileName: file.name,
          error: ` ⚠️ 이 파일은 실제 데이터가 없는 "틀" 파일이에요 (엑셀에서 "웹 페이지, 전체"로 저장하면 이렇게 나뉘어요). ${sheetHint} (팁: xls 파일과 그 옆의 ".files" 폴더 안 파일들을 한 번에 다 같이 선택해서 업로드하면, 다음부터는 알아서 실제 데이터 파일을 찾아 자동으로 처리해줘요.) 또는 무신사에서 다시 다운로드할 때 폴더 없이 파일 하나로 저장되는 방식으로 받아보세요. (아무 데이터도 변경되지 않았습니다)`,
        }
      }
      if (parsed.format === 'unknown') {
        // 콘솔 없이도 화면에서 바로 원인을 알 수 있도록, 실제로 인식한 첫 줄의 칸 수와 앞부분 내용을 그대로 붙여서 보여줌
        const headerPreview = (parsed.header || []).slice(0, 12).map((c, i) => `${i}:${c || '(빈칸)'}`).join(' / ')
        return {
          added: 0,
          failed: 0,
          fileName: file.name,
          error: ` ⚠️ 지원하지 않는 파일 형식이에요. 무신사 "정산내역-상세", "일일정산확인", 송장 주문내역(invoice_list) 파일만 업로드해주세요. (아무 데이터도 변경되지 않았습니다)\n[진단용 v2] 첫 줄 ${(parsed.header || []).length}칸 인식됨: ${headerPreview || '(내용 없음 — 표를 아예 못 읽었을 수 있음)'}`,
        }
      }
      const { rows } = parsed

      // 재고 아이템 조회 (스타일넘버+옵션 조합으로 매칭 — 같은 스타일넘버도 사이즈별로 옵션이 다르므로)
      const { data: allItems } = await supabase.from('items').select('sku, name, option_name, cost_price, sell_price')
      const bySkuOption = new Map<string, any>()
      const byNameOption = new Map<string, any>()
      ;(allItems || []).forEach((it: any) => {
        const opt = normalizeOptionForMatch(it.option_name)
        if (it.sku) bySkuOption.set(`${normalizeSkuForMatch(it.sku)}__${opt}`, it)
        byNameOption.set(`${String(it.name).trim().toUpperCase()}__${opt}`, it)
      })
      function matchItem(styleNo: string, itemName: string, optionName: string) {
        const optKey = normalizeOptionForMatch(optionName)
        return (styleNo && bySkuOption.get(`${normalizeSkuForMatch(styleNo)}__${optKey}`)) || byNameOption.get(`${String(itemName).trim().toUpperCase()}__${optKey}`)
      }

      const dailyMap = new Map<string, { gross: number; commission: number; vendorCoupon: number; claim: number; final: number; cost: number; shipping: number }>()
      const lineRecords: any[] = []
      let minDate = '', maxDate = ''
      // 정산에 등장한 주문번호/일련번호 — "배송중(정산 대기)" 목록에서 지우는 데 사용 (두 형식 모두 C열=주문번호, D열=주문일련번호)
      const settledOrderKeys: { orderNo: string; orderSerial: string }[] = []

      // 날짜 없는 "기간 전체 요약" 행들 — 정산내역-상세: 반품비결제/청구반품비/배송비결제/후기부스팅/MFS물류비
      //                                    일일정산확인: 반품배송비/청구반품비/저단가배송비지원액/후기부스팅/배송비결제
      const extraFees: Record<string, number> = {
        '반품비결제': 0, '청구반품비': 0, '배송비결제': 0, '후기부스팅': 0, 'MFS물류비': 0, '저단가배송비지원액': 0,
      }

      // 한 줄이라도 이 금액을 넘으면 "합계/소계" 행이 잘못 섞였거나 파싱이 어긋난 것으로 보고 그 행만 건너뜀
      // (DB integer 컬럼 범위를 넘는 이상치가 섞이면 전체 배치 insert가 통째로 실패하므로, 개별 행 단위로 미리 걸러냄)
      const MAX_REASONABLE_LINE_AMOUNT = 50_000_000
      const skippedAnomalyRows: string[] = []

      if (parsed.format === 'detail') {
      // 날짜 없는 "기간 전체 요약" 행 (반품비결제/청구반품비/배송비결제/후기부스팅/MFS물류비) 추출
      // 이 행들은 콤마 정렬(colspan) 때문에 셀 개수가 다를 수 있어서, 행 안의 숫자처럼 보이는 셀 중 절댓값이 가장 큰 값을 그 항목의 금액으로 봄
      const EXTRA_CATEGORIES = ['반품비결제', '청구반품비', '배송비결제', '후기부스팅', 'MFS물류비']
      for (const cells of rows) {
        const category = (cells[COL.CATEGORY] || '').trim()
        if (!EXTRA_CATEGORIES.includes(category)) continue
        let maxAbs = 0
        for (const cell of cells) {
          const n = parseNum(cell)
          if (Math.abs(n) > Math.abs(maxAbs)) maxAbs = n
        }
        extraFees[category] += maxAbs
      }

      for (const cells of rows) {
        const category = (cells[COL.CATEGORY] || '').trim()
        // "합계"라는 글자가 포함된 행은 우리가 직접 다시 계산하므로 건너뜀 (앞뒤 공백/전체합계 등 변형도 함께 걸러지도록 포함 검사)
        if (!category || category.includes('합계')) continue
        const dateRaw = cells[COL.DATE]
        if (!dateRaw || dateRaw === '-' || dateRaw.length < 8) continue // 날짜 없는 카테고리 소계 행은 건너뜀

        // 행 전체 어디에든 "체험단"이라는 단어가 있으면 그 행은 제외 (쿠폰명/비고 등 정확한 컬럼 위치를 몰라도 안전하게 걸러짐)
        if (cells.some(c => (c || '').includes('체험단'))) continue

        const dateStr = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`

        const revenue    = parseNum(cells[COL.REVENUE_AO])      // AO: 매출
        const commission = parseNum(cells[COL.COMMISSION_AY])   // AY: 수수료
        const net         = parseNum(cells[COL.NET_AZ])         // AZ: 순매출(합계금액)
        const claim       = parseNum(cells[COL.CLAIM])
        const vendorCoupon = parseNum(cells[COL.VENDOR_COUPON]) + parseNum(cells[COL.CART_VENDOR_COUPON])
        const qty         = parseNum(cells[COL.QTY]) || 0
        const saleAmount        = parseNum(cells[COL.SALE_AMOUNT])
        const discount          = parseNum(cells[COL.DISCOUNT])
        const musinsaCoupon     = parseNum(cells[COL.MUSINSA_COUPON])
        const musinsaCartCoupon = parseNum(cells[COL.MUSINSA_CART_COUPON])
        const rewardPoints      = parseNum(cells[COL.REWARD_POINTS])
        const vendorCouponRaw     = parseNum(cells[COL.VENDOR_COUPON])
        const cartVendorCouponRaw = parseNum(cells[COL.CART_VENDOR_COUPON])
        const commissionSale    = parseNum(cells[COL.COMMISSION_SALE])
        const commissionDiscount = parseNum(cells[COL.COMMISSION_DISCOUNT])
        const supportFund       = parseNum(cells[COL.SUPPORT_FUND])
        const penalty           = parseNum(cells[COL.PENALTY])
        const claimShippingFee  = parseNum(cells[COL.CLAIM_SHIPPING_FEE])
        const reviewBoost       = parseNum(cells[COL.REVIEW_BOOST])
        const mfsLogistics      = parseNum(cells[COL.MFS_LOGISTICS])

        // 이 행에서 파싱된 금액 중 하나라도 이상치 기준을 넘으면, 이 행 전체를 건너뛰고 경고만 남김
        const parsedAmounts = [revenue, commission, net, claim, vendorCoupon, saleAmount, discount, musinsaCoupon, musinsaCartCoupon, rewardPoints, vendorCouponRaw, cartVendorCouponRaw, commissionSale, commissionDiscount, supportFund, penalty, claimShippingFee, reviewBoost, mfsLogistics]
        if (parsedAmounts.some(v => Math.abs(v) > MAX_REASONABLE_LINE_AMOUNT)) {
          skippedAnomalyRows.push(`${dateRaw} / ${category} / ${(cells[COL.ITEM_NAME] || '').trim()}`)
          continue
        }

        if (!minDate || dateStr < minDate) minDate = dateStr
        if (!maxDate || dateStr > maxDate) maxDate = dateStr

        settledOrderKeys.push({ orderNo: (cells[2] || '').trim(), orderSerial: (cells[3] || '').trim() })

        // 스타일넘버+옵션 조합 우선, 없으면 상품명+옵션으로 재고 아이템 매칭
        // (상품명이 한글/영문으로 서로 달라도 스타일넘버+옵션으로 매칭됨)
        const styleNo = (cells[COL.STYLE_NO] || '').trim()
        const itemName = (cells[COL.ITEM_NAME] || '').trim()
        const optionName = (cells[COL.OPTION] || '').trim()
        const matched = matchItem(styleNo, itemName, optionName)
        const lineCost = matched ? (matched.cost_price || 0) * qty : 0
        const registeredSellPrice = matched ? (matched.sell_price || 0) : 0
        const lineShipping = qty * shippingRateFor(dateStr)

        const prev = dailyMap.get(dateStr) || { gross: 0, commission: 0, vendorCoupon: 0, claim: 0, final: 0, cost: 0, shipping: 0 }
        dailyMap.set(dateStr, {
          gross: prev.gross + revenue,
          commission: prev.commission + commission,
          vendorCoupon: prev.vendorCoupon + vendorCoupon,
          claim: prev.claim + claim,
          final: prev.final + net,
          cost: prev.cost + lineCost,
          shipping: prev.shipping + lineShipping,
        })

        // 일별 주문표에서 보여줄 건별 상세 기록
        lineRecords.push({
          channel: CHANNEL_NAME,
          settle_date: dateStr,
          order_no: (cells[2] || '').trim(),
          order_serial: (cells[3] || '').trim(),
          order_type: category,
          item_name: itemName,
          style_no: styleNo,
          option_name: optionName,
          qty,
          sale_amount: saleAmount,
          claim_amount: claim,
          discount,
          musinsa_coupon: musinsaCoupon,
          musinsa_cart_coupon: musinsaCartCoupon,
          reward_points: rewardPoints,
          vendor_coupon: vendorCouponRaw,
          cart_vendor_coupon: cartVendorCouponRaw,
          commission_sale: commissionSale,
          commission_discount: commissionDiscount,
          support_fund: supportFund,
          penalty,
          claim_shipping_fee: claimShippingFee,
          review_boost: reviewBoost,
          mfs_logistics: mfsLogistics,
          revenue_ao: revenue,
          final_amount: net,
          net_settlement: null,
          matched_cost: lineCost,
          cost_matched: !!matched,
          registered_sell_price: registeredSellPrice,
        })
      }
      } else {
        // "일일정산확인" 형식 — 상품명(H열)이 없는 행은 상품 건이 아니라 "총합계"(구분도 빈칸) 또는
        // "반품배송비/청구반품비/저단가배송비지원액/후기부스팅/배송비결제" 같은 날짜 없는 기간 요약 행
        const EXTRA_CATEGORY_MAP: Record<string, string> = {
          '반품배송비': '반품비결제',
          '청구반품비': '청구반품비',
          '배송비결제': '배송비결제',
          '후기부스팅': '후기부스팅',
          '저단가배송비지원액': '저단가배송비지원액',
        }

        for (const cells of rows) {
          const category = (cells[COL2.CATEGORY] || '').trim()
          const dateRaw = (cells[COL2.DATE] || '').trim()
          const itemName = (cells[COL2.ITEM_NAME] || '').trim()

          if (!itemName) {
            // 상품명 없는 행: 카테고리 요약 행이면 정산금액(AV, 이미 최종 계산된 값)을 그대로 그 항목에 누적,
            // 구분도 빈칸인 "총합계" 행은 다른 행들의 합계라 건너뜀 (그대로 더하면 이중 집계됨)
            if (category && EXTRA_CATEGORY_MAP[category]) {
              extraFees[EXTRA_CATEGORY_MAP[category]] += parseNum(cells[COL2.NET_SETTLEMENT])
            }
            continue
          }

          if (!category || category.includes('합계')) continue
          if (!dateRaw || dateRaw.length < 8) continue
          if (cells.some(c => (c || '').includes('체험단'))) continue

          const dateStr = `${dateRaw.slice(0, 4)}-${dateRaw.slice(4, 6)}-${dateRaw.slice(6, 8)}`

          const qty = parseNum(cells[COL2.QTY]) || 0
          const saleAmount = parseNum(cells[COL2.SALE_AMOUNT])
          const claim = parseNum(cells[COL2.CLAIM])
          const discount = parseNum(cells[COL2.DISCOUNT])
          const musinsaCoupon = parseNum(cells[COL2.MUSINSA_COUPON])
          const musinsaCartCoupon = parseNum(cells[COL2.MUSINSA_CART_COUPON])
          const vendorCouponRaw = parseNum(cells[COL2.VENDOR_COUPON])
          const cartVendorCouponRaw = parseNum(cells[COL2.CART_VENDOR_COUPON])
          const rewardPoints = parseNum(cells[COL2.REWARD_POINTS])
          const commissionSale = parseNum(cells[COL2.COMMISSION_SALE])
          const penalty = parseNum(cells[COL2.PENALTY])
          const claimShippingFee = parseNum(cells[COL2.CLAIM_SHIPPING_FEE])
          const reviewBoost = parseNum(cells[COL2.REVIEW_BOOST])
          const netSettlement = parseNum(cells[COL2.NET_SETTLEMENT])

          const parsedAmounts = [saleAmount, claim, discount, musinsaCoupon, musinsaCartCoupon, vendorCouponRaw, cartVendorCouponRaw, rewardPoints, commissionSale, penalty, claimShippingFee, reviewBoost, netSettlement]
          if (parsedAmounts.some(v => Math.abs(v) > MAX_REASONABLE_LINE_AMOUNT)) {
            skippedAnomalyRows.push(`${dateRaw} / ${category} / ${itemName}`)
            continue
          }

          if (!minDate || dateStr < minDate) minDate = dateStr
          if (!maxDate || dateStr > maxDate) maxDate = dateStr

          settledOrderKeys.push({ orderNo: (cells[2] || '').trim(), orderSerial: (cells[3] || '').trim() })

          const styleNo = (cells[COL2.STYLE_NO] || '').trim()
          const optionName = (cells[COL2.OPTION] || '').trim()
          const matched = matchItem(styleNo, itemName, optionName)
          const lineCost = matched ? (matched.cost_price || 0) * qty : 0
          const registeredSellPrice = matched ? (matched.sell_price || 0) : 0
          const lineShipping = qty * shippingRateFor(dateStr)

          const prev = dailyMap.get(dateStr) || { gross: 0, commission: 0, vendorCoupon: 0, claim: 0, final: 0, cost: 0, shipping: 0 }
          dailyMap.set(dateStr, {
            gross: prev.gross + saleAmount,
            commission: prev.commission + commissionSale,
            vendorCoupon: prev.vendorCoupon + vendorCouponRaw + cartVendorCouponRaw,
            claim: prev.claim + claim,
            final: prev.final + netSettlement,
            cost: prev.cost + lineCost,
            shipping: prev.shipping + lineShipping,
          })

          // "정산금액(페널티차감)" 열은 무신사가 이미 최종 계산해서 준 값이라 net_settlement에 그대로 저장해두고,
          // 화면/집계에서는 (formula 재계산 대신) 이 값을 그대로 신뢰해서 씀
          lineRecords.push({
            channel: CHANNEL_NAME,
            settle_date: dateStr,
            order_no: (cells[2] || '').trim(),
            order_serial: (cells[3] || '').trim(),
            order_type: category,
            item_name: itemName,
            style_no: styleNo,
            option_name: optionName,
            qty,
            sale_amount: saleAmount,
            claim_amount: claim,
            discount,
            musinsa_coupon: musinsaCoupon,
            musinsa_cart_coupon: musinsaCartCoupon,
            reward_points: rewardPoints,
            vendor_coupon: vendorCouponRaw,
            cart_vendor_coupon: cartVendorCouponRaw,
            commission_sale: commissionSale,
            commission_discount: 0,
            support_fund: 0,
            penalty,
            claim_shipping_fee: claimShippingFee,
            review_boost: reviewBoost,
            mfs_logistics: 0,
            revenue_ao: saleAmount,
            final_amount: netSettlement,
            net_settlement: netSettlement,
            matched_cost: lineCost,
            cost_matched: !!matched,
            registered_sell_price: registeredSellPrice,
          })
        }
      }

      if (skippedAnomalyRows.length > 0) {
        console.warn(`정산내역 업로드: 금액이 비정상적으로 큰 행 ${skippedAnomalyRows.length}건을 건너뛰었습니다 (합계/소계 행이 섞였을 가능성). 내용:`, skippedAnomalyRows)
      }

      // 같은 날짜 범위를 다시 업로드하면(수정본), 그 기간의 기존 데이터를 통째로 지우고 새로 넣어서
      // 항상 "마지막에 올린 파일"로 완전히 교체되도록 함 (일별 합계 + 건별 상세 둘 다)
      let deleteErrorMsg = ''
      if (minDate && maxDate) {
        const { error: delLinesErr, count: delLinesCount } = await supabase.from('musinsa_settlement_lines')
          .delete({ count: 'exact' }).eq('channel', CHANNEL_NAME).gte('settle_date', minDate).lte('settle_date', maxDate)
        if (delLinesErr) {
          deleteErrorMsg += `건별 삭제 실패: code=${delLinesErr.code || '-'} message=${delLinesErr.message || '-'}\n`
          console.error('musinsa_settlement_lines delete error:', delLinesErr)
        }
        const { error: delDailyErr, count: delDailyCount } = await supabase.from('musinsa_settlement')
          .delete({ count: 'exact' }).eq('channel', CHANNEL_NAME).gte('settle_date', minDate).lte('settle_date', maxDate)
        if (delDailyErr) {
          deleteErrorMsg += `일별 합계 삭제 실패: code=${delDailyErr.code || '-'} message=${delDailyErr.message || '-'}\n`
          console.error('musinsa_settlement delete error:', delDailyErr)
        }
        console.log(`기존 데이터 삭제: 건별 ${delLinesCount ?? '?'}건, 일별합계 ${delDailyCount ?? '?'}건 (범위 ${minDate}~${maxDate})`)
      }
      if (lineRecords.length > 0) {
        const { error: lineErr } = await supabase.from('musinsa_settlement_lines').insert(lineRecords)
        if (lineErr) {
          const detail = `code=${lineErr.code || '-'} message=${lineErr.message || '-'} details=${lineErr.details || '-'} hint=${lineErr.hint || '-'}`
          console.error('musinsa_settlement_lines insert error:', detail, lineErr)
        }
      }

      // 날짜 없는 기간 요약 항목(반품비결제 등)은 파일이 다루는 기간(minDate 기준 월)에 귀속시켜 저장
      if (minDate) {
        const [exYear, exMonth] = minDate.split('-').map(Number)
        const { error: extraErr } = await supabase.from('musinsa_settlement_extra_fees').upsert({
          channel: CHANNEL_NAME,
          year: exYear,
          month: exMonth,
          return_fee_settle: extraFees['반품비결제'],
          claim_return_fee: extraFees['청구반품비'],
          shipping_fee_settle: extraFees['배송비결제'],
          review_boost_extra: extraFees['후기부스팅'],
          mfs_logistics_extra: extraFees['MFS물류비'],
          low_price_shipping_support: extraFees['저단가배송비지원액'],
        }, { onConflict: 'channel,year,month' })
        if (extraErr) {
          const detail = `code=${extraErr.code || '-'} message=${extraErr.message || '-'} details=${extraErr.details || '-'} hint=${extraErr.hint || '-'}`
          console.error('musinsa_settlement_extra_fees upsert error:', detail, extraErr)
        }
      }

      // 정산에 등장한 주문은 "배송중(정산 대기)" 목록에서 제거 (송장파일로 미리 등록해둔 건들의 자동 정리)
      // 주문일련번호가 있으면 그걸로(라인 단위 정확 매칭), 없으면 주문번호로 삭제
      if (settledOrderKeys.length > 0) {
        const serials = Array.from(new Set(settledOrderKeys.map(k => k.orderSerial).filter(Boolean)))
        for (let i = 0; i < serials.length; i += 200) {
          const { error: pdErr } = await supabase.from('musinsa_pending_orders')
            .delete().eq('channel', CHANNEL_NAME).in('order_serial', serials.slice(i, i + 200))
          if (pdErr) console.error('musinsa_pending_orders delete(serial) error:', pdErr)
        }
        const noSerialOrderNos = Array.from(new Set(settledOrderKeys.filter(k => !k.orderSerial && k.orderNo).map(k => k.orderNo)))
        for (let i = 0; i < noSerialOrderNos.length; i += 200) {
          const { error: pdErr } = await supabase.from('musinsa_pending_orders')
            .delete().eq('channel', CHANNEL_NAME).in('order_no', noSerialOrderNos.slice(i, i + 200))
          if (pdErr) console.error('musinsa_pending_orders delete(order_no) error:', pdErr)
        }
      }

      let added = 0, failed = 0
      let firstError = ''
      for (const [settleDate, agg] of dailyMap) {
        const { error } = await supabase.from('musinsa_settlement').insert({
          channel: CHANNEL_NAME,
          settle_date: settleDate,
          gross_amount: agg.gross,
          commission_amount: agg.commission,
          vendor_coupon_amount: agg.vendorCoupon,
          claim_amount: agg.claim,
          final_amount: agg.final,
          cost_amount: agg.cost,
          shipping_amount: agg.shipping,
        })
        if (error) {
          failed++
          const detail = `code=${error.code || '-'} message=${error.message || '-'} details=${error.details || '-'} hint=${error.hint || '-'}`
          if (!firstError) firstError = detail
          console.error('musinsa_settlement insert error:', detail, error)
        }
        else added++
      }
      const anomalyMsg = skippedAnomalyRows.length > 0
        ? ` ⚠️ 금액이 비정상적으로 큰 행 ${skippedAnomalyRows.length}건은 합계/소계 행으로 보고 건너뛰었습니다 (콘솔 로그에서 상세 확인 가능).`
        : ''
      const summaryMsg = `${firstError ? ' 오류: ' + firstError : ''}${deleteErrorMsg ? ' ' + deleteErrorMsg : ''}${anomalyMsg}`
      return { added, failed, error: summaryMsg, fileName: file.name }
    } catch (e: any) {
      console.error(e)
      return { added: 0, failed: 0, error: e?.message || String(e), fileName: file.name }
    }
  }

  // 드롭/폴더 선택으로 딸려온 하위 디렉토리 항목(FileSystemDirectoryEntry)까지 재귀적으로 전부 File로 펼쳐서 모음
  // ("웹 페이지, 전체"로 저장된 xls는 항상 같은 이름의 ".files" 폴더가 옆에 같이 생기는데,
  //  탐색기에서 xls와 그 폴더를 통째로 같이 드래그하면 이 함수가 폴더 속까지 다 펼쳐서 한 배치로 만들어줌)
  async function collectFilesFromDataTransfer(dataTransfer: DataTransfer): Promise<File[]> {
    const items = Array.from(dataTransfer.items || [])
    const entries = items.map(it => (it as any).webkitGetAsEntry ? (it as any).webkitGetAsEntry() : null)
    // 폴더 API를 지원하지 않는 환경이면 그냥 최상위로 드롭된 파일들만 사용
    if (entries.every(e => !e)) return Array.from(dataTransfer.files || [])

    async function readEntry(entry: any): Promise<File[]> {
      if (!entry) return []
      if (entry.isFile) {
        return await new Promise<File[]>(resolve => entry.file((f: File) => resolve([f]), () => resolve([])))
      }
      if (entry.isDirectory) {
        const reader = entry.createReader()
        const allEntries: any[] = []
        // Chrome은 readEntries가 한 번에 최대 100개까지만 주므로 빈 배열이 나올 때까지 반복 호출
        while (true) {
          const batch: any[] = await new Promise(resolve => reader.readEntries((rs: any[]) => resolve(rs), () => resolve([])))
          if (batch.length === 0) break
          allEntries.push(...batch)
        }
        const nested = await Promise.all(allEntries.map(readEntry))
        return nested.flat()
      }
      return []
    }

    const nested = await Promise.all(entries.map(readEntry))
    return nested.flat()
  }

  async function processSettlementFileBatch(files: File[]) {
    setSettleUploading(true)
    // 파일명 기준으로 같이 선택된 파일들을 찾을 수 있도록 맵을 만들어둠
    // ("웹 페이지, 전체"로 저장된 xls 틀 파일을 올렸을 때, 같이 선택한 sheet001.htm 등을
    //  같은 배치 안에서 자동으로 찾아 대신 처리하기 위함 — xls와 .files 폴더를 통째로 같이 선택/드롭하면 바로 동작함)
    const filesByName = new Map<string, File>()
    files.forEach(f => filesByName.set(f.name.toLowerCase(), f))

    // 실제 정산 파일이 아닌 부속 파일(tabstrip.htm, filelist.xml 등)까지 전부 처리 시도할 필요는 없어서,
    // xls/xlsx/csv/htm/html 확장자를 가진 파일만 대상으로 함
    const candidateFiles = files.filter(f => /\.(xls|xlsx|csv|htm|html)$/i.test(f.name))

    const results: { added: number; failed: number; error: string; fileName: string }[] = []
    for (const file of candidateFiles) {
      const preParsed = await parseAnySettlementFile(file)
      if (preParsed.format === 'frameset') {
        let resolved: File | null = null
        for (const sheetPath of preParsed.sheetFiles) {
          const baseName = sheetPath.split('/').pop() || ''
          const candidate = filesByName.get(baseName.toLowerCase())
          if (!candidate) continue
          const candidateParsed = await parseAnySettlementFile(candidate)
          if (candidateParsed.format === 'daily' || candidateParsed.format === 'detail') {
            resolved = candidate
            break
          }
        }
        if (resolved) {
          const result = await processSettlementFile(resolved)
          results.push({ ...result, fileName: `${file.name} → ${resolved.name}` })
          continue
        }
      }
      const result = await processSettlementFile(file)
      results.push(result)
    }
    const totalAdded = results.reduce((s, r) => s + r.added, 0)
    const totalFailed = results.reduce((s, r) => s + r.failed, 0)
    const errorLines = results.filter(r => r.error).map(r => `[${r.fileName}]${r.error}`).join('\n')
    setUploadMsg(
      `정산내역 업로드 완료 (v2 · ${candidateFiles.length}개 파일): ${totalAdded}일치 반영 / ${totalFailed}일치 실패`
      + (errorLines ? `\n${errorLines}` : '')
    )
    loadData()
    loadChartData(chartYear)
    loadBestAndCategory(bestCatYearFilter)
    setSettleUploading(false)
  }

  async function handleSettlementUpload(fileList: FileList) {
    await processSettlementFileBatch(Array.from(fileList))
    if (settleFileRef.current) settleFileRef.current.value = ''
  }

  async function handleSettlementDrop(e: any) {
    e.preventDefault()
    setSettleDragOver(false)
    const files = await collectFilesFromDataTransfer(e.dataTransfer)
    if (files.length > 0) await processSettlementFileBatch(files)
  }

  async function handleAdExcelUpload(file: File) {
    setAdUploading(true)
    try {
      const rows = await parseAdFile(file)

      let added = 0, skipped = 0
      let firstError = ''
      if (rows.length > 0 && !('날짜' in rows[0])) {
        firstError = `'날짜' 컬럼을 못 찾음. 실제 헤더: ${Object.keys(rows[0]).join(' | ')}`
      }
      for (const row of rows) {
        const rawDate = row['날짜']
        if (!rawDate) {
          skipped++
          if (!firstError) firstError = `날짜 값 비어있음 (해당 행: ${JSON.stringify(row).slice(0, 200)})`
          continue
        }
        let adDate: string
        if (typeof rawDate === 'number') adDate = XLSX.SSF.format('yyyy-mm-dd', rawDate)
        else {
          const parsed = new Date(String(rawDate).trim().replace(/\./g, '-'))
          if (isNaN(parsed.getTime())) {
            skipped++
            if (!firstError) firstError = `날짜 형식을 못 읽음: "${rawDate}"`
            continue
          }
          adDate = parsed.toISOString().slice(0, 10)
        }

        // 무신사 리포트 원본 컬럼명(집행 광고비/매출/노출 수/클릭 수/판매 수)과
        // 저희 템플릿 컬럼명(광고비/전환매출/노출수/클릭수/전환수) 둘 다 지원
        const adCost     = parseNum(row['집행 광고비'] ?? row['광고비'])
        const revenue    = parseNum(row['매출'] ?? row['전환매출'])
        const impressions = parseNum(row['노출 수'] ?? row['노출수'])
        const clicks     = parseNum(row['클릭 수'] ?? row['클릭수'])
        const conversions = parseNum(row['판매 수'] ?? row['전환수'])
        const roasPct         = parseNum(row['광고 수익률(ROAS)'])
        const directRoasPct   = parseNum(row['직접 광고 수익률(ROAS)'])
        const indirectRoasPct = parseNum(row['간접 광고 수익률(ROAS)'])
        const cpc  = parseNum(row['클릭당 광고비'])
        const cpm  = parseNum(row['CPM'])
        const directRevenue   = parseNum(row['직접 전환 매출'])
        const indirectRevenue = parseNum(row['간접 전환 매출'])
        const directConversions   = parseNum(row['직접 전환 판매 수'])
        const indirectConversions = parseNum(row['간접 전환 판매 수'])
        const ctrPct = parseNum(row['클릭률'])
        const cvrPct = parseNum(row['전환율'])

        const { error } = await supabase.from('ad_performance').upsert({
          channel: CHANNEL_NAME,
          ad_date: adDate,
          ad_cost: adCost,
          impressions,
          clicks,
          conversions,
          conversion_revenue: revenue,
          roas_pct: roasPct,
          direct_roas_pct: directRoasPct,
          indirect_roas_pct: indirectRoasPct,
          cpc,
          cpm,
          direct_revenue: directRevenue,
          indirect_revenue: indirectRevenue,
          direct_conversions: directConversions,
          indirect_conversions: indirectConversions,
          ctr_pct: ctrPct,
          cvr_pct: cvrPct,
        }, { onConflict: 'channel,ad_date' })

        if (error) {
          skipped++
          const detail = `code=${error.code || '-'} message=${error.message || '-'} details=${error.details || '-'} hint=${error.hint || '-'}`
          if (!firstError) firstError = detail
          console.error('ad_performance upsert error:', detail, error)
        }
        else added++
      }
      setUploadMsg(`광고 성과 업로드 완료: ${added}건 반영 / ${skipped}건 건너뜀` + (firstError ? `\n오류: ${firstError}` : ''))
      loadData()
    } catch (e: any) {
      console.error(e)
      setUploadMsg('광고 엑셀 처리 중 오류가 발생했습니다.')
    } finally {
      setAdUploading(false)
      if (adFileRef.current) adFileRef.current.value = ''
    }
  }

  // 무신사가 매달 무료로 지급하는 10만원 광고비는 제외하고, 실제로 내가 충전(결제)한 광고비만 직접 입력해서 저장
  // (선택된 달=viewMonthIdx 기준으로 입력하며, 이 금액은 순수익 계산에서 차감됨)
  async function promptAdCharge() {
    const targetMonth = viewMonthIdx + 1
    const current = monthlyAdCharge[viewMonthIdx] || 0
    const input = window.prompt(`${year}년 ${targetMonth}월에 실제로 충전(결제)한 광고비를 입력해주세요.\n(무신사가 매달 무료로 주는 10만원은 제외하고, 내 돈으로 충전한 금액만)`, current ? String(current) : '')
    if (input === null) return
    const amount = parseNum(input)
    if (isNaN(amount) || amount < 0) {
      alert('올바른 금액을 입력해주세요.')
      return
    }
    const { error } = await supabase.from('musinsa_ad_charge').upsert({
      channel: CHANNEL_NAME,
      year,
      month: targetMonth,
      charged_amount: amount,
    }, { onConflict: 'channel,year,month' })
    if (error) {
      alert('저장 실패: ' + (error.message || JSON.stringify(error)))
      return
    }
    setMonthlyAdCharge(prev => {
      const next = [...prev]
      next[viewMonthIdx] = amount
      return next
    })
  }

  const salesGross = sales.reduce((s, r) => s + r.gross, 0)
  const yearSettleGross = monthlySettleGross.reduce((s, v) => s + v, 0)   // 매출액 = 일별 주문표 매출액(AO) 전부 합
  const yearSettleNet = monthlySettleNet.reduce((s, v) => s + v, 0)       // 순매출액 = 일별 주문표 정산금액 전부 합
  const yearSettleCost = monthlySettleCost.reduce((s, v) => s + v, 0)
  const yearSettleShipping = monthlySettleShipping.reduce((s, v) => s + v, 0)
  const yearQtySale = monthlyQtySale.reduce((s, v) => s + v, 0)
  const yearQtyRefund = monthlyQtyRefund.reduce((s, v) => s + v, 0)
  const yearNetQty = yearQtySale - yearQtyRefund
  const yearClaim = monthlyClaim.reduce((s, v) => s + v, 0)

  // 정산내역(일별 주문표 데이터)이 있으면 그걸 그대로 쓰고, 없으면 sales 테이블 기준으로 대체
  const totalGross = hasSettlementData ? yearSettleGross : salesGross
  const totalFee   = Math.round(totalGross * feeRate)
  const totalCost  = sales.reduce((s: any, r: any) => s + r.cost * r.qty, 0)

  const totalNetActual = hasSettlementData ? yearSettleNet : (totalGross - totalFee)
  // 순수익 = 순매출액 - 원가 - 택배비 - 충전 광고비(무신사 무료 10만원 제외, 내가 직접 충전한 금액)
  const totalCostActual = hasSettlementData ? (yearSettleCost + yearSettleShipping) : totalCost
  const yearAdCharge = monthlyAdCharge.reduce((s, v) => s + v, 0)
  const totalProfit = totalNetActual - totalCostActual - yearAdCharge
  // 매출액 대비 각 항목 비중 (원가/택배비/광고비/수수료 — 플랫폼 공헌이익률 참고용)
  const costPctOfGross = totalGross > 0 ? Math.round((yearSettleCost / totalGross) * 1000) / 10 : 0
  const shippingPctOfGross = totalGross > 0 ? Math.round((yearSettleShipping / totalGross) * 1000) / 10 : 0
  const adChargePctOfGross = totalGross > 0 ? Math.round((yearAdCharge / totalGross) * 1000) / 10 : 0
  const feePctOfGross = totalGross > 0 ? Math.round(((totalGross - totalNetActual) / totalGross) * 1000) / 10 : 0

  // 전년 대비 순매출액/순수익 % (전년 데이터가 없으면 0으로 처리되므로 분모가 0일 땐 %는 표시 안 함)
  const prevYearGrossTotal = dashPrevYearMonthlyGross.reduce((s, v) => s + v, 0)
  const netYoyPct = prevYearNetTotal > 0 ? Math.round(((totalNetActual - prevYearNetTotal) / prevYearNetTotal) * 1000) / 10 : null
  const profitYoyPct = prevYearProfitTotal > 0 ? Math.round(((totalProfit - prevYearProfitTotal) / prevYearProfitTotal) * 1000) / 10 : null

  const yearAdCost = monthlyAdCost.reduce((s, v) => s + v, 0)
  const yearAdRevenue = monthlyAdRevenue.reduce((s, v) => s + v, 0)
  const yearRoas = yearAdCost > 0 ? Math.round((yearAdRevenue / yearAdCost) * 1000) / 10 : 0
  const yearAcos = yearAdRevenue > 0 ? Math.round((yearAdCost / yearAdRevenue) * 1000) / 10 : 0
  const yearTacos = totalGross > 0 ? Math.round((yearAdCost / totalGross) * 1000) / 10 : 0

  // 선택 월 지표 — 마찬가지로 일별 주문표 라인 데이터 기준
  const mGross = hasSettlementData ? monthlySettleGross[viewMonthIdx] : monthlyGross[viewMonthIdx]
  const mPrevYearGross = dashPrevYearMonthlyGross[viewMonthIdx]
  const mYoyPct = mPrevYearGross > 0 ? Math.round(((mGross - mPrevYearGross) / mPrevYearGross) * 1000) / 10 : null
  const mNetQty = monthlyQtySale[viewMonthIdx] - monthlyQtyRefund[viewMonthIdx]
  const mNet = hasSettlementData ? monthlySettleNet[viewMonthIdx] : (monthlyGross[viewMonthIdx] - Math.round(monthlyGross[viewMonthIdx] * feeRate))
  const mFee = mGross - mNet
  const mClaim = monthlyClaim[viewMonthIdx]
  const mSettleCost = monthlySettleCost[viewMonthIdx]
  const mSettleShipping = monthlySettleShipping[viewMonthIdx]
  // 정산내역이 있으면 실제 매칭된 원가+택배비, 없으면 연간 원가율을 이 달 매출에 비례 적용해 추정
  const costRatio = totalGross > 0 ? totalCost / totalGross : 0
  const mCost = hasSettlementData ? (mSettleCost + mSettleShipping) : Math.round(mGross * costRatio)
  const mAdCharge = monthlyAdCharge[viewMonthIdx] || 0
  const mProfit = mNet - mCost - mAdCharge
  const mPrevYearNet = dashPrevYearMonthlyNet[viewMonthIdx]
  const mNetYoyPct = mPrevYearNet > 0 ? Math.round(((mNet - mPrevYearNet) / mPrevYearNet) * 1000) / 10 : null
  const mPrevYearProfit = dashPrevYearMonthlyProfit[viewMonthIdx]
  const mProfitYoyPct = mPrevYearProfit > 0 ? Math.round(((mProfit - mPrevYearProfit) / mPrevYearProfit) * 1000) / 10 : null
  const mAdCost = monthlyAdCost[viewMonthIdx]
  const mAdRevenue = monthlyAdRevenue[viewMonthIdx]
  const mRoas = mAdCost > 0 ? Math.round((mAdRevenue / mAdCost) * 1000) / 10 : 0
  const mAcos = mAdRevenue > 0 ? Math.round((mAdCost / mAdRevenue) * 1000) / 10 : 0
  const mTacos = mGross > 0 ? Math.round((mAdCost / mGross) * 1000) / 10 : 0

  const chartData = sales.slice(0, 8).map(s => ({ name: `${s.item_name}(${s.option_name})`, 판매수량: s.qty }))
  const monthlyChartData = MONTH_LABELS.map((label, i) => ({
    name: label,
    매출: chartMonthlyGross[i],
    순매출액: chartMonthlySettleNet[i],
    작년순매출액: chartPrevYearNet[i],
  }))
  const qtyChartData = MONTH_LABELS.map((label, i) => ({ name: label, 판매수량: chartMonthlyQtySale[i], 작년판매수량: chartPrevYearQtySale[i] }))

  const chartYearGrossSum = chartMonthlyGross.reduce((s, v) => s + v, 0)
  const chartPrevYearGrossSum = chartPrevYearGross.reduce((s, v) => s + v, 0)
  const yoyGrossPct = chartHasPrevYearData && chartPrevYearGrossSum > 0
    ? Math.round(((chartYearGrossSum - chartPrevYearGrossSum) / chartPrevYearGrossSum) * 1000) / 10
    : null

  // 매출 막대 위에 금액 + 그 달의 전년동월대비 %를 같이 표시
  function renderRevenueLabel(props: any) {
    const { x, y, width, value } = props
    if (!value) return null
    return (
      <text x={x + width / 2} y={y - 4} textAnchor="middle" fontSize={8} fontWeight={700} fill="#3b82f6">
        {value.toLocaleString('ko-KR')}
      </text>
    )
  }

  // 규칙 기반 AI 추천 인사이트 (이미 계산된 지표들을 바탕으로 자동 생성)
  function generateInsights() {
    const sales: string[] = []
    const ads: string[] = []
    const items: string[] = []

    // 매출 관련
    if (yoyDashboardPct !== null) {
      if (yoyDashboardPct >= 10) sales.push(`${year}년 매출이 전년 대비 ${yoyDashboardPct}% 성장했어요. 지금 잘 팔리는 상품/카테고리 위주로 재고를 넉넉히 준비해보세요.`)
      else if (yoyDashboardPct <= -10) sales.push(`${year}년 매출이 전년 대비 ${yoyDashboardPct}% 감소했어요. 최근 몇 달간 매출이 급감한 달이 있는지, 광고비를 줄인 시기와 겹치는지 확인해보시는 걸 추천해요.`)
      else sales.push(`${year}년 매출은 전년 대비 ${yoyDashboardPct >= 0 ? '+' : ''}${yoyDashboardPct}%로 큰 변화 없이 유지되고 있어요.`)
    }
    if (mYoyPct !== null) {
      if (mYoyPct <= -20) sales.push(`${viewMonthIdx + 1}월 매출이 작년 같은 달보다 ${mYoyPct}%나 낮아요. 이 시기에 프로모션이나 할인 행사를 검토해볼 만해요.`)
      else if (mYoyPct >= 20) sales.push(`${viewMonthIdx + 1}월 매출이 작년보다 ${mYoyPct}% 늘었어요. 이번 달 잘 팔린 이유(광고, 시즌, 할인 등)를 파악해두면 다음 시즌에도 재현할 수 있어요.`)
    }
    const totalMarginRate = totalGross > 0 ? Math.round((totalProfit / totalGross) * 1000) / 10 : null
    if (totalMarginRate !== null) {
      if (totalMarginRate < 0) sales.push(`공헌이익률이 ${totalMarginRate}%로 마이너스예요. 팔수록 손해라는 뜻이라 지금 바로 원가·판매가·광고비 구조를 점검해야 해요. (일반적으로 0% 미만은 즉시 조치가 필요한 위험 신호예요)`)
      else if (totalMarginRate < 10) sales.push(`공헌이익률이 ${totalMarginRate}%로 낮은 편이에요. 보통 10% 미만이면 원가·수수료·택배비 부담이 커서 매출 규모를 키워도 남는 게 적을 수 있어요. 원가 비중이 높은 상품이 있는지 "원가 확인" 팝업에서 점검해보세요.`)
      else if (totalMarginRate < 20) sales.push(`공헌이익률이 ${totalMarginRate}%예요. 20% 이상이면 안정권으로 보는 경우가 많은데, 지금은 그보다 낮으니 원가나 할인 정책을 조금 더 다듬어볼 만해요.`)
      else if (totalMarginRate >= 30) sales.push(`공헌이익률이 ${totalMarginRate}%로 양호해요. 지금의 원가·수수료 구조를 유지하면서 매출 규모를 키우는 데 집중해도 좋아요.`)
    }

    // 광고 관련 — 연간
    if (yearAdCost > 0) {
      if (yearRoas < 150) ads.push(`[연간] ROAS가 ${yearRoas}%로 낮은 편이에요. 광고비 대비 전환매출이 충분하지 않으니, 광고 소재나 타겟을 다시 점검해보세요.`)
      else if (yearRoas >= 400) ads.push(`[연간] ROAS가 ${yearRoas}%로 효율이 아주 좋아요. 예산을 더 늘려도 좋은 성과가 나올 가능성이 높아요.`)
      if (yearTacos >= 20) ads.push(`[연간] TACOS가 ${yearTacos}%로 전체 매출에서 광고비가 차지하는 비중이 커요. 광고 의존도를 낮추고 자연 유입(재구매, 리뷰 등)을 늘리는 전략도 함께 고려해보세요.`)
      if (yearAcos >= 50) ads.push(`[연간] ACOS가 ${yearAcos}%로 높아요. 광고 전환매출 대비 광고비 부담이 큰 편이니, 저효율 캠페인은 축소를 검토해보세요.`)
    } else {
      ads.push('아직 업로드된 연간 광고 성과 데이터가 없어요. "업로드" 버튼으로 광고 리포트를 올리면 ROAS/ACOS/TACOS 기반 피드백을 드릴 수 있어요.')
    }

    // 광고 관련 — 선택한 달
    if (mAdCost > 0) {
      if (mRoas < 150) ads.push(`[${viewMonthIdx + 1}월] ROAS가 ${mRoas}%로 낮은 편이에요. 광고비 대비 전환매출이 충분하지 않으니, 이 달 광고 소재나 타겟을 다시 점검해보세요.`)
      else if (mRoas >= 400) ads.push(`[${viewMonthIdx + 1}월] ROAS가 ${mRoas}%로 효율이 아주 좋아요. 이 시기 소재/타겟을 다른 달에도 참고해볼 만해요.`)
      if (mTacos >= 20) ads.push(`[${viewMonthIdx + 1}월] TACOS가 ${mTacos}%로 이 달 매출에서 광고비가 차지하는 비중이 커요. 광고 의존도를 낮출 방법을 함께 고려해보세요.`)
      if (mAcos >= 50) ads.push(`[${viewMonthIdx + 1}월] ACOS가 ${mAcos}%로 높아요. 이 달 저효율 캠페인이 있었는지 확인해보세요.`)
    } else {
      ads.push(`아직 ${viewMonthIdx + 1}월 광고 성과 데이터가 없어요.`)
    }

    // 아이템 관련
    if (bestItems.length > 0) {
      const top = bestItems[0]
      const bestPeriodLabel = bestCatYearFilter === '전체' ? '전체 기간' : `${bestCatYearFilter}년`
      items.push(`${bestPeriodLabel} 가장 많이 팔린 상품은 "${top.item_name}"(${top.qty}장)이에요. 관련 색상/스타일을 확장하거나 재입고를 우선 검토해볼 만해요.`)
      const unmatchedCount = bestItems.filter(it => it.style_no === '-' || !it.style_no).length
      if (unmatchedCount > 0) items.push(`스타일넘버가 비어있거나 매칭 안 된 상품이 ${unmatchedCount}건 있어요. 원가 계산 정확도를 위해 재고 스타일넘버를 확인해보세요.`)
    }
    if (categorySales.length > 0) {
      const topCat = categorySales[0]
      const totalCatQty = categorySales.reduce((s, c) => s + c.qty, 0)
      const catShare = totalCatQty > 0 ? Math.round((topCat.qty / totalCatQty) * 100) : 0
      items.push(`"${topCat.category}" 카테고리가 전체 판매량의 ${catShare}%를 차지해요. 이 카테고리 위주로 신상품을 기획하면 반응이 좋을 가능성이 높아요.`)
      if (categorySales.some(c => c.category === '미분류')) {
        items.push(`"미분류" 카테고리로 잡힌 판매 건이 있어요. 재고 제어판에서 해당 상품의 카테고리를 지정해주시면 더 정확한 분석이 가능해요.`)
      }
    }
    if (yearClaim > 0 && totalGross > 0) {
      const claimRate = Math.round((yearClaim / totalGross) * 1000) / 10
      if (claimRate >= 5) items.push(`클레임(환불/교환) 금액이 매출의 ${claimRate}%를 차지해요. 반복적으로 클레임이 발생하는 상품이 있는지 확인해보세요.`)
    }

    return { sales, ads, items }
  }

  return (
    <div>
      <div className="page-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ width: 12, height: 12, borderRadius: '50%', background: '#3b82f6', display: 'inline-block' }}></span>
          <h2 className="page-title" style={{ margin: 0 }}>무신사 (MUSINSA) 손익 & 업로드</h2>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            onClick={() => setDiscountApplied(v => !v)}
            style={{ ...btnStyle, background: discountApplied ? '#dbeafe' : '#f8fafc', color: discountApplied ? '#2563eb' : '#475569', fontWeight: 600, fontSize: 12 }}
          >
            10% 할인 {discountApplied ? 'ON' : 'OFF'} → 수수료 {(feeRate * 100).toFixed(0)}%
          </button>
        </div>
      </div>

      {loading ? <div className="loading">로딩 중...</div> : (
        <>
          {/* AI 추천 인사이트 (맨 위) */}
          {(() => {
            const insights = generateInsights()
            const groups = [
              { title: '📈 매출 현황', items: insights.sales, color: '#2563eb' },
              { title: '👕 아이템 피드백', items: insights.items, color: '#8b5cf6' },
              { title: '📢 광고 성과', items: insights.ads, color: '#e11d48' },
            ]
            return (
              <div style={{ background: 'linear-gradient(135deg, #f5f3ff 0%, #eff6ff 100%)', border: '1px solid #94a3b8', borderRadius: 16, padding: 24, marginBottom: 24 }}>
                <div
                  onClick={() => setInsightsCollapsed(v => !v)}
                  style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, marginBottom: insightsCollapsed ? 0 : 4, cursor: 'pointer' }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ fontSize: 18 }}>🤖</span>
                    <div style={{ fontWeight: 800, fontSize: 16 }}>AI 추천 인사이트</div>
                  </div>
                  <span style={{ fontSize: 13, color: '#94a3b8', transform: insightsCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s' }}>▼</span>
                </div>
                {!insightsCollapsed && (
                  <>
                    <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 18 }}>
                      {year}년 {viewMonthIdx + 1}월 기준 데이터를 바탕으로 자동 생성된 참고용 피드백이에요 (정확한 판단은 실제 데이터를 함께 확인해주세요)
                    </div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
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
                  </>
                )}
              </div>
            )
          })()}

          {/* 연간 KPI + 광고 성과 지표 (1:1:1:3) */}
          <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 16 }}>
            <button onClick={() => setYear(y => y - 1)} style={monthNavBtnStyle}>◀</button>
            <span style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8' }}>{year}년</span>
            <button onClick={() => setYear(y => y + 1)} style={monthNavBtnStyle}>▶</button>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 16, marginBottom: 20, minWidth: 0 }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16, minWidth: 0 }}>
            <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 14, color: '#000', fontWeight: 700 }}>{year}년 총 매출액</span>
                <div
                  onDragOver={e => { e.preventDefault(); setSettleDragOver(true) }}
                  onDragLeave={() => setSettleDragOver(false)}
                  onDrop={handleSettlementDrop}
                  style={{ display: 'flex', gap: 4, border: settleDragOver ? '1px dashed #2563eb' : '1px dashed transparent', borderRadius: 6, padding: 2 }}
                >
                  <input ref={settleFileRef} type="file" accept=".xls,.xlsx,.csv,.htm,.html" multiple style={{ display: 'none' }}
                    onChange={e => { const files = e.target.files; if (files && files.length > 0) handleSettlementUpload(files) }} />
                  <button onClick={() => settleFileRef.current?.click()} disabled={settleUploading}
                    title='"정산내역-상세", "일일정산확인", 송장 주문내역(invoice_list) 파일 모두 자동 인식해서 업로드됩니다. 송장파일은 배송중(정산 대기) 수량으로 저장되고, 나중에 정산내역이 올라오면 자동으로 정리돼요. 파일이나 폴더를 이 버튼 위로 드래그해서 놓아도 업로드돼요.'
                    style={{ border: '1px solid #94a3b8', background: '#fff', color: '#2563eb', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>
                    {settleUploading ? '업로드 중...' : settleDragOver ? '여기에 놓기' : '📤 정산내역'}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#0f172a', marginBottom: 4 }}>
                {formatWon(totalGross)}
                {yoyDashboardPct !== null && (
                  <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 6, color: yoyDashboardPct >= 0 ? '#059669' : '#e11d48' }}>
                    (전년대비 {yoyDashboardPct >= 0 ? '+' : ''}{yoyDashboardPct}%)
                  </span>
                )}
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8' }}>
                {salesGross > 0 ? '결제 완료 총액 (GROSS)' : (totalGross > 0 ? '정산내역 기준 (판매금액)' : '결제 완료 총액 (GROSS)')}
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>{year - 1}년 매출액 {formatWon(prevYearGrossTotal)}</div>
              {hasSettlementData && (
                <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, marginTop: 2 }}>
                  {yearNetQty}개 <span style={{ fontWeight: 500, color: '#94a3b8' }}>(판매{yearQtySale}/환불{yearQtyRefund})</span>
                </div>
              )}
              {pendingQtyTotal > 0 && (
                <div onClick={() => openPendingModal(false)}
                  style={{ fontSize: 11, color: '#d97706', fontWeight: 700, marginTop: 2, cursor: 'pointer', textDecoration: 'underline dotted' }}
                  title="클릭하면 어떤 주문인지 목록이 열려요 (매출·순수익엔 미반영, 재고 파악용)">
                  📦 배송중(정산 대기) {pendingQtyTotal}개
                </div>
              )}
            </div>
            <div style={{ background: '#eff6ff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 14, color: '#000', fontWeight: 700 }}>순매출액</span>
                <div style={{ display: 'flex', gap: 4 }}>
                  <button onClick={openOrderModal}
                    style={{ border: '1px solid #bfdbfe', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>
                    📋 일별 주문표
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: '#2563eb', marginBottom: 4 }}>
                {formatWon(totalNetActual)}
                {netYoyPct !== null && (
                  <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 6, color: netYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                    (전년대비 {netYoyPct >= 0 ? '+' : ''}{netYoyPct}%)
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <span style={{ fontSize: 12, color: '#e11d48', fontWeight: 700 }}>- {formatWon(totalGross - totalNetActual)}</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>
                  {hasSettlementData ? '총수수료' : `수수료 (${(feeRate*100).toFixed(0)}%${discountApplied ? ', 할인적용' : ''}, 추정)`}
                </span>
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>{year - 1}년 순매출액 {formatWon(prevYearNetTotal)}</div>
              {hasSettlementData && yearClaim > 0 && (
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>환불/교환 {formatWon(yearClaim)}</div>
              )}
            </div>
            <div style={{ background: totalProfit >= 0 ? '#f0fdf4' : '#fff1f2', border: '1px solid #94a3b8', borderRadius: 16, padding: 20, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontSize: 14, color: '#000', fontWeight: 700 }}>순수익 (공헌이익)</span>
                {hasSettlementData && (
                  <button onClick={openCostModal}
                    style={{ border: '1px solid #bbf7d0', background: '#fff', color: '#059669', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 6 }}>
                    🔍 원가 확인
                  </button>
                )}
              </div>
              <div style={{ fontSize: 26, fontWeight: 800, color: totalProfit >= 0 ? '#059669' : '#e11d48', marginBottom: 4 }}>
                {formatWon(totalProfit)}
                {totalGross > 0 && (
                  <span style={{ fontSize: 13, fontWeight: 700, marginLeft: 6, color: totalProfit >= 0 ? '#059669' : '#e11d48' }}>
                    ({Math.round((totalProfit / totalGross) * 1000) / 10}%)
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <span style={{ fontSize: 12, color: '#64748b', fontWeight: 700 }}>- {formatWon(totalCostActual)}</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>{hasSettlementData ? '원가+택배비' : '원가합계'}</span>
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
                {year - 1}년 순수익 {formatWon(prevYearProfitTotal)}
                {profitYoyPct !== null && (
                  <span style={{ fontWeight: 700, color: profitYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                    {' '}(전년대비 {profitYoyPct >= 0 ? '+' : ''}{profitYoyPct}%)
                  </span>
                )}
              </div>
              {hasSettlementData && (
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>원가 {formatWon(yearSettleCost)} · 택배비 {formatWon(yearSettleShipping)}{yearAdCharge > 0 ? ` · 충전 광고비 ${formatWon(yearAdCharge)}` : ''}</div>
              )}
              {hasSettlementData && (
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
                  원가 {costPctOfGross}% · 택배비 {shippingPctOfGross}% · 광고비 {adChargePctOfGross}% · 수수료 {feePctOfGross}%
                </div>
              )}
              <div style={{ fontSize: 10, color: '#dc2626', fontWeight: 400, marginTop: 6 }}>공헌이익률 10% 미만 위험 · 20% 미만 주의 · 25%↑ 안정권</div>
            </div>
            </div>
            <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20, minWidth: 0 }}>
              <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
                <span style={{ fontSize: 13, color: '#94a3b8', fontWeight: 700 }}>광고 성과 지표</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 3, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#475569' }}>광고비 {formatWon(yearAdCost)}</span>
                  <span style={{ fontSize: 10, color: '#cbd5e1' }}>→</span>
                  <span style={{ fontSize: 10, fontWeight: 700, color: '#4f46e5' }}>전환매출 {formatWon(yearAdRevenue)}</span>
                  {yearAdCharge > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: '#e11d48' }}>· 충전 광고비 {formatWon(yearAdCharge)}</span>
                  )}
                </div>
                <button onClick={openDailyModal}
                  style={{ border: '1px solid #94a3b8', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6 }}>
                  📅 일별 광고표
                </button>
                <input ref={adFileRef} type="file" accept=".xlsx,.xls,.csv" style={{ display: 'none' }}
                  onChange={e => { const f = e.target.files?.[0]; if (f) handleAdExcelUpload(f) }} />
                <button onClick={() => adFileRef.current?.click()} disabled={adUploading}
                  style={{ border: '1px solid #94a3b8', background: '#fff', color: '#2563eb', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6 }}>
                  {adUploading ? '업로드 중...' : '📤 업로드'}
                </button>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-around', flexWrap: 'wrap', gap: 8 }}>
                <div style={{ textAlign: 'center', flex: 1 }}>
                  <div style={{ fontSize: 26, fontWeight: 800, color: '#4f46e5' }}>{yearRoas ? `${yearRoas}%` : '-'}</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4, fontWeight: 700 }}>ROAS</div>
                  <div style={{ fontSize: 10, color: '#4f46e5', marginTop: 2, lineHeight: 1.3, fontWeight: 600 }}>광고비 대비 전환매출 비율<br/>(전환매출 ÷ 광고비 × 100).<br/>높을수록 광고 효율이 좋음</div>
                </div>
                <div style={{ textAlign: 'center', flex: 1 }}>
                  <div style={{ fontSize: 26, fontWeight: 800, color: '#e11d48' }}>{yearAcos ? `${yearAcos}%` : '-'}</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4, fontWeight: 700 }}>ACOS</div>
                  <div style={{ fontSize: 10, color: '#e11d48', marginTop: 2, lineHeight: 1.3, fontWeight: 600 }}>전환매출 대비 광고비 비율<br/>(광고비 ÷ 전환매출 × 100).<br/>낮을수록 좋음</div>
                </div>
                <div style={{ textAlign: 'center', flex: 1 }}>
                  <div style={{ fontSize: 26, fontWeight: 800, color: '#d97706' }}>{yearTacos ? `${yearTacos}%` : '-'}</div>
                  <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 4, fontWeight: 700 }}>TACOS</div>
                  <div style={{ fontSize: 10, color: '#d97706', marginTop: 2, lineHeight: 1.3, fontWeight: 600 }}>전체 매출 대비 광고비 비율<br/>(광고비 ÷ 전체 매출 × 100).<br/>낮을수록 광고 의존도가 낮음</div>
                </div>
              </div>
              <div style={{ fontSize: 9, color: '#16a34a', fontWeight: 700, marginTop: 10, textAlign: 'center', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                위험 : ROAS 400% 미만 (ACOS 25% 이상) / 적정 : ROAS 600% ~ 700% (ACOS 14% ~ 16%) / 대박 : ROAS 1,000% 이상 (ACOS 10% 이하)
              </div>
            </div>
          </div>

          {uploadMsg && (
            <div style={{ marginBottom: 20, padding: '10px 14px', background: '#ecfdf5', borderRadius: 10, fontSize: 13, color: '#059669', fontWeight: 600, whiteSpace: 'pre-line' }}>
              ✓ {uploadMsg}
            </div>
          )}

          {/* 월별 매출 */}
          <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20, marginBottom: 24 }}>
            <div style={{ display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginBottom: 16 }}>
              <button onClick={() => shiftViewMonth(-1)} style={monthNavBtnStyle}>◀</button>
              <span style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8' }}>{year}년 {viewMonthIdx + 1}월</span>
              <button onClick={() => shiftViewMonth(1)} style={monthNavBtnStyle}>▶</button>
            </div>

            {/* 선택 월 KPI + 광고 성과 지표 (1:1:1:3) */}
            <div style={{ display: 'grid', gridTemplateColumns: '3fr 2fr', gap: 12, marginBottom: 20, minWidth: 0 }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 12, minWidth: 0 }}>
              <div style={{ background: '#f8fafc', borderRadius: 12, padding: 16 }}>
                <div style={{ fontSize: 14, color: '#000', fontWeight: 700, marginBottom: 6 }}>{year}년 {viewMonthIdx + 1}월 매출액</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 20, fontWeight: 800 }}>{formatWon(mGross)}</span>
                  {mYoyPct !== null && (
                    <span style={{ fontSize: 11, fontWeight: 700, color: mYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                      ({mYoyPct >= 0 ? '+' : ''}{mYoyPct}%)
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 3 }}>{year - 1}년 {viewMonthIdx + 1}월 {formatWon(mPrevYearGross)}</div>
                {hasSettlementData && (
                  <div style={{ fontSize: 10, color: '#64748b', fontWeight: 700, marginTop: 4 }}>
                    {mNetQty}개 <span style={{ fontWeight: 500, color: '#94a3b8' }}>(판매{monthlyQtySale[viewMonthIdx]}/환불{monthlyQtyRefund[viewMonthIdx]})</span>
                  </div>
                )}
                {pendingMonthlyQty[viewMonthIdx] > 0 && (
                  <div onClick={() => openPendingModal(true)}
                    style={{ fontSize: 10, color: '#d97706', fontWeight: 700, marginTop: 3, cursor: 'pointer', textDecoration: 'underline dotted' }}
                    title="클릭하면 어떤 주문인지 목록이 열려요 (매출·순수익엔 미반영, 재고 파악용)">
                    📦 배송중(정산 대기) {pendingMonthlyQty[viewMonthIdx]}개
                  </div>
                )}
              </div>
              <div style={{ background: '#eff6ff', borderRadius: 12, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 14, color: '#000', fontWeight: 700 }}>순매출액</span>
                  <button onClick={openOrderModal} title="이 달 주문표 보기"
                    style={{ border: 'none', background: 'none', color: '#2563eb', cursor: 'pointer', fontSize: 13, padding: 0 }}>📋</button>
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: '#2563eb' }}>
                  {formatWon(mNet)}
                  {mNetYoyPct !== null && (
                    <span style={{ fontSize: 11, fontWeight: 700, marginLeft: 4, color: mNetYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                      ({mNetYoyPct >= 0 ? '+' : ''}{mNetYoyPct}%)
                    </span>
                  )}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <span style={{ fontSize: 11, color: '#e11d48', fontWeight: 700 }}>- {formatWon(mFee)}</span>
                  <span style={{ fontSize: 10, color: '#94a3b8' }}>
                    {hasSettlementData ? '총수수료' : `수수료 (${(feeRate*100).toFixed(0)}%, 추정)`}
                  </span>
                </div>
                <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 3 }}>{year - 1}년 {viewMonthIdx + 1}월 {formatWon(mPrevYearNet)}</div>
                {hasSettlementData && mClaim > 0 && (
                  <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 3 }}>환불/교환 {formatWon(mClaim)}</div>
                )}
              </div>
              <div style={{ background: mProfit >= 0 ? '#f0fdf4' : '#fff1f2', borderRadius: 12, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                  <span style={{ fontSize: 14, color: '#000', fontWeight: 700 }}>순수익 (공헌이익)</span>
                  {hasSettlementData && (
                    <button onClick={openCostModalForMonth} title="이 달 원가 확인"
                      style={{ border: 'none', background: 'none', color: '#059669', cursor: 'pointer', fontSize: 13, padding: 0 }}>🔍</button>
                  )}
                </div>
                <div style={{ fontSize: 20, fontWeight: 800, color: mProfit >= 0 ? '#059669' : '#e11d48' }}>
                  {formatWon(mProfit)}
                  {mGross > 0 && (
                    <span style={{ fontSize: 11, fontWeight: 700, marginLeft: 4 }}>
                      ({Math.round((mProfit / mGross) * 1000) / 10}%)
                    </span>
                  )}
                  {mProfitYoyPct !== null && (
                    <span style={{ fontSize: 11, fontWeight: 700, marginLeft: 4, color: mProfitYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                      (전년대비 {mProfitYoyPct >= 0 ? '+' : ''}{mProfitYoyPct}%)
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 3 }}>{year - 1}년 {viewMonthIdx + 1}월 {formatWon(mPrevYearProfit)}</div>
                {hasSettlementData && (
                  <div style={{ fontSize: 9, color: '#94a3b8', marginTop: 3 }}>원가 {formatWon(mSettleCost)} · 택배비 {formatWon(mSettleShipping)}{mAdCharge > 0 ? ` · 충전 광고비 ${formatWon(mAdCharge)}` : ''}</div>
                )}
              </div>
              </div>
              <div style={{ background: '#f8fafc', borderRadius: 12, padding: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8, flexWrap: 'wrap', gap: 6 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700 }}>광고 성과 지표</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#475569' }}>광고비 {formatWon(mAdCost)}</span>
                    <span style={{ fontSize: 10, color: '#cbd5e1' }}>→</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: '#4f46e5' }}>전환매출 {formatWon(mAdRevenue)}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: mAdCharge > 0 ? '#e11d48' : '#94a3b8' }}>
                      · {mAdCharge > 0 ? `충전 광고비 ${formatWon(mAdCharge)}` : '충전 광고비 미입력'}
                    </span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <button onClick={promptAdCharge} title="이 달 충전 광고비 입력 (무신사 무료 10만원 제외)"
                      style={{ border: '1px solid #fbcfe8', background: '#fff', color: '#db2777', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>
                      💳 입력
                    </button>
                    <button onClick={openDailyModal} title="이 달 일별 광고표 보기"
                      style={{ border: 'none', background: 'none', color: '#475569', cursor: 'pointer', fontSize: 13, padding: 0 }}>📅</button>
                  </div>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-around', flexWrap: 'wrap', gap: 8 }}>
                  <div style={{ textAlign: 'center', flex: 1 }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#4f46e5' }}>{mRoas ? `${mRoas}%` : '-'}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, fontWeight: 700 }}>ROAS</div>
                  </div>
                  <div style={{ textAlign: 'center', flex: 1 }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#e11d48' }}>{mAcos ? `${mAcos}%` : '-'}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, fontWeight: 700 }}>ACOS</div>
                  </div>
                  <div style={{ textAlign: 'center', flex: 1 }}>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#d97706' }}>{mTacos ? `${mTacos}%` : '-'}</div>
                    <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, fontWeight: 700 }}>TACOS</div>
                  </div>
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{chartYear}년 월별 매출 / 판매수량</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => shiftChartYear(-1)} style={monthNavBtnStyle}>◀</button>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#94a3b8' }}>{chartYear}년</span>
                <button onClick={() => shiftChartYear(1)} style={monthNavBtnStyle}>▶</button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
              매출액 · 순매출액 {chartHasPrevYearData ? `· ${chartYear - 1}년 순매출액(비교)` : ''}
            </div>
            {chartLoading ? <div className="loading">로딩 중...</div> : !chartHasData ? (
              <div className="chart-empty">{chartYear}년 데이터가 없습니다</div>
            ) : (
            <>
            <ResponsiveContainer width="100%" height={312}>
              <BarChart data={monthlyChartData} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 14 }} />
                <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(v / 10000)}만`} />
                <Tooltip formatter={(v: number) => formatWon(v)} />
                <Bar dataKey="매출" fill="#3b82f6" radius={[4, 4, 0, 0]}>
                  <LabelList dataKey="매출" content={renderRevenueLabel} />
                </Bar>
                <Bar dataKey="순매출액" fill="#059669" radius={[4, 4, 0, 0]}>
                  <LabelList dataKey="순매출액" position="top" formatter={(v: number) => v ? v.toLocaleString('ko-KR') : ''} style={{ fontSize: 8, fill: '#059669', fontWeight: 700 }} />
                </Bar>
                {chartHasPrevYearData && (
                  <Bar dataKey="작년순매출액" fill="#475569" radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="작년순매출액" position="top" formatter={(v: number) => v ? v.toLocaleString('ko-KR') : ''} style={{ fontSize: 8, fill: '#475569', fontWeight: 700 }} />
                  </Bar>
                )}
              </BarChart>
            </ResponsiveContainer>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,1fr)', marginTop: 4, paddingLeft: 4, paddingRight: 4 }}>
              {MONTH_LABELS.map((_, i) => {
                const cur = chartMonthlyGross[i]
                const prev = chartPrevYearGross[i]
                const pct = prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null
                return (
                  <div key={i} style={{ textAlign: 'center', fontSize: 11, fontWeight: 700, color: pct === null ? '#cbd5e1' : pct >= 0 ? '#2563eb' : '#e11d48' }}>
                    {pct === null ? '-' : `${pct >= 0 ? '+' : ''}${pct}%`}
                  </div>
                )
              })}
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', gap: 20, marginTop: 10 }}>
              {[
                { label: '매출', color: '#3b82f6' },
                { label: '순매출액', color: '#059669' },
                ...(chartHasPrevYearData ? [{ label: '작년순매출액', color: '#475569' }] : []),
              ].map(item => (
                <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: item.color, display: 'inline-block' }} />
                  <span style={{ fontSize: 12, color: '#475569' }}>{item.label}</span>
                </div>
              ))}
            </div>
            </>
            )}

            <div style={{ fontWeight: 700, fontSize: 15, marginTop: 24, marginBottom: 4 }}>{chartYear}년 월별 판매수량</div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>순수 판매 건수 · 전년동월 판매건수 비교</div>
            {!chartLoading && chartHasData && (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={qtyChartData} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="name" tick={{ fontSize: 14 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip formatter={(v: number) => `${v}개`} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="판매수량" fill="#f59e0b" radius={[4, 4, 0, 0]}>
                  <LabelList dataKey="판매수량" position="top" formatter={(v: number) => v ? `${v}개` : ''} style={{ fontSize: 9, fill: '#f59e0b', fontWeight: 700 }} />
                </Bar>
                {chartHasPrevYearData && (
                  <Bar dataKey="작년판매수량" fill="#94a3b8" radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="작년판매수량" position="top" formatter={(v: number) => v ? `${v}개` : ''} style={{ fontSize: 9, fill: '#64748b', fontWeight: 700 }} />
                  </Bar>
                )}
              </BarChart>
            </ResponsiveContainer>

            )}
          </div>

          {/* 베스트 상품 + 카테고리별 판매량 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 24 }}>
            <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>무신사 베스트 상품 순위</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <select value={bestCatYearFilter} onChange={e => setBestCatYearFilter(e.target.value)}
                    style={{ border: '1px solid #94a3b8', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 6, fontFamily: 'inherit' }}>
                    <option value="전체">전체 기간</option>
                    {bestCatAvailableYears.map(y => (
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
                    style={{ border: '1px solid #94a3b8', background: showByOption ? '#eef2ff' : '#fff', color: '#4f46e5', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6 }}>
                    {showByOption ? '아이템별로 보기' : '옵션별로 보기'}
                  </button>
                </div>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
순판매 수량 기준, 환불 차감됨 (정산내역 기준, {bestCatYearFilter === '전체' ? '전체 기간' : `${bestCatYearFilter}년`}){showByOption ? ' · 옵션별' : ' · 옵션 제외, 아이템당 합계'} · 배송중은 정산 전이라 매출엔 미반영 · 스크롤로 전체 확인{bestCatLoading ? ' · 불러오는 중...' : ''}
              </div>
              {(() => {
                const filtered = bestItemSeasonFilter === '전체' ? bestItems : bestItems.filter(it => it.season === bestItemSeasonFilter)
                if (filtered.length === 0) return <div className="chart-empty">데이터 없음</div>

                let displayRows: any[]
                if (showByOption) {
                  displayRows = filtered
                } else {
                  const byItemMap = new Map<string, { key: string; item_name: string; style_no: string; qty: number; pendingQty: number; revenue: number; netRevenue: number; profit: number }>()
                  filtered.forEach(it => {
                    const key = `${it.style_no}__${it.item_name}`
                    const prev = byItemMap.get(key) || { key, item_name: it.item_name, style_no: it.style_no, qty: 0, pendingQty: 0, revenue: 0, netRevenue: 0, profit: 0 }
                    byItemMap.set(key, { ...prev, qty: prev.qty + it.qty, pendingQty: prev.pendingQty + (it.pendingQty || 0), revenue: prev.revenue + it.revenue, netRevenue: prev.netRevenue + it.netRevenue, profit: prev.profit + it.profit })
                  })
                  displayRows = Array.from(byItemMap.values()).sort((a, b) => (b.qty + b.pendingQty) - (a.qty + a.pendingQty))
                }

                return (
                  <div style={{ maxHeight: 420, overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                      <thead>
                        <tr style={{ background: '#f8fafc' }}>
                          {(showByOption ? ['순위', '상품명', '스타일넘버', '옵션', '판매량', '배송중', '매출', '순매출', '순수익'] : ['순위', '상품명', '스타일넘버', '판매량', '배송중', '매출', '순매출', '순수익']).map(h => (
                            <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', fontSize: 11, color: '#94a3b8', fontWeight: 700, position: 'sticky', top: 0, background: '#f8fafc' }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {displayRows.map((it: any, i) => (
                          showByOption ? (
                            <tr key={it.key} style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: i < 3 ? '#2563eb' : '#94a3b8' }}>{i + 1}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>{it.item_name}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b', fontFamily: 'monospace' }}>{it.style_no}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{it.option_name}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: '#2563eb' }}>{it.qty}장</td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: it.pendingQty > 0 ? '#d97706' : '#cbd5e1' }}
                                title={it.pendingQty > 0 ? '송장은 나갔지만 아직 정산에 안 잡힌 수량 (매출·순수익엔 미반영)' : undefined}>
                                {it.pendingQty > 0 ? `${it.pendingQty}장` : '-'}
                              </td>
                              <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(it.revenue)}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', color: '#475569' }}>{formatWon(it.netRevenue)}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600, color: it.profit >= 0 ? '#059669' : '#e11d48' }}>{formatWon(it.profit)}</td>
                            </tr>
                          ) : (
                            <tr key={it.key} style={{ borderBottom: '1px solid #f1f5f9' }}>
                              <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: i < 3 ? '#2563eb' : '#94a3b8' }}>{i + 1}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>{it.item_name}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b', fontFamily: 'monospace' }}>{it.style_no}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: '#2563eb' }}>{it.qty}장</td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: it.pendingQty > 0 ? '#d97706' : '#cbd5e1' }}
                                title={it.pendingQty > 0 ? '송장은 나갔지만 아직 정산에 안 잡힌 수량 (매출·순수익엔 미반영)' : undefined}>
                                {it.pendingQty > 0 ? `${it.pendingQty}장` : '-'}
                              </td>
                              <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(it.revenue)}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', color: '#475569' }}>{formatWon(it.netRevenue)}</td>
                              <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600, color: it.profit >= 0 ? '#059669' : '#e11d48' }}>{formatWon(it.profit)}</td>
                            </tr>
                          )
                        ))}
                      </tbody>
                    </table>
                  </div>
                )
              })()}
            </div>

            {/* 카테고리별 판매량 */}
            <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, gap: 8 }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>카테고리별 판매량</div>
                <select value={bestCatYearFilter} onChange={e => setBestCatYearFilter(e.target.value)}
                  style={{ border: '1px solid #94a3b8', background: '#fff', color: '#475569', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '4px 8px', borderRadius: 6, fontFamily: 'inherit' }}>
                  <option value="전체">전체 기간</option>
                  {bestCatAvailableYears.map(y => (
                    <option key={y} value={String(y)}>{y}년</option>
                  ))}
                </select>
              </div>
              <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>{bestCatYearFilter === '전체' ? '전체 기간' : `${bestCatYearFilter}년`} 순수 판매 건 기준, 재고 카테고리와 매칭{bestCatLoading ? ' · 불러오는 중...' : ''}</div>
              {categorySales.length === 0 ? (
                <div className="chart-empty" style={{ height: 120 }}>정산내역을 먼저 업로드해주세요</div>
              ) : (
                <>
                  <ResponsiveContainer width="100%" height={180}>
                    <BarChart data={categorySales.map(c => ({ name: c.category, 판매량: c.qty }))} layout="vertical" margin={{ left: 10 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                      <XAxis type="number" tick={{ fontSize: 11 }} />
                      <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={70} />
                      <Tooltip formatter={(v: number) => `${v}개`} />
                      <Bar dataKey="판매량" fill="#8b5cf6" radius={[0, 4, 4, 0]}>
                        <LabelList dataKey="판매량" position="right" formatter={(v: number) => v ? `${v}개` : ''} style={{ fontSize: 11, fill: '#8b5cf6', fontWeight: 700 }} />
                      </Bar>
                    </BarChart>
                  </ResponsiveContainer>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 16 }}>
                    {categorySales.map((c, i) => (
                      <div key={c.category} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', background: '#f8fafc', borderRadius: 10 }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: i < 3 ? '#8b5cf6' : '#94a3b8', width: 20, textAlign: 'center' }}>{i + 1}</span>
                        <div style={{ flex: 1, fontSize: 13, fontWeight: 600, textAlign: 'center' }}>{c.category}</div>
                        <span style={{ fontSize: 13, fontWeight: 700, color: '#8b5cf6' }}>{c.qty}개</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        </>
      )}

      {showDailyModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setShowDailyModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 1400, height: 780, overflow: 'auto', flexShrink: 0 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>무신사 일별 광고표</div>
              <button onClick={() => setShowDailyModal(false)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#94a3b8', lineHeight: 1 }}>×</button>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <button onClick={() => shiftDailyMonth(-1)} style={monthNavBtnStyle}>◀</button>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{dailyYear}년 {dailyMonthIdx + 1}월</span>
              <button onClick={() => shiftDailyMonth(1)} style={monthNavBtnStyle}>▶</button>
            </div>

            {dailyLoading ? (
              <div className="loading">로딩 중...</div>
            ) : dailyRows.filter((r: any) => (r.ad_cost || 0) > 0).length === 0 ? (
              <div className="chart-empty">이 달에는 광고비가 발생한 날이 없습니다</div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      {['날짜', '집행광고비', '광고수익률', '직접광고수익률', '직접전환매출(판매수)', '간접광고수익률', '간접전환매출(판매수)', '클릭수', '클릭당광고비', '클릭률', 'CPM', '매출', '전환율'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', color: '#94a3b8', fontWeight: 700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {dailyRows.filter((r: any) => (r.ad_cost || 0) > 0).map((r: any) => (
                      <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.ad_date}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(Math.round(r.ad_cost || 0))}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.roas_pct ?? 0}%</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.direct_roas_pct ?? 0}%</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(Math.round(r.direct_revenue || 0))} ({r.direct_conversions || 0}건)</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.indirect_roas_pct ?? 0}%</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(Math.round(r.indirect_revenue || 0))} ({r.indirect_conversions || 0}건)</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.clicks || 0}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.cpc ? formatWon(Math.round(r.cpc)) : '-'}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.ctr_pct ?? 0}%</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(Math.round(r.cpm || 0))}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(Math.round(r.conversion_revenue || 0))}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.cvr_pct ?? 0}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {showPendingModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setShowPendingModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 1000, maxHeight: 720, overflow: 'auto', flexShrink: 0 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>📦 배송중 (정산 대기) 주문</div>
              <button onClick={() => setShowPendingModal(false)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#94a3b8', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
              송장파일로 등록됐지만 아직 정산내역에 나오지 않은 주문이에요. 매출·순수익에는 반영되지 않고 재고 파악용 수량으로만 잡힙니다.
              정산내역을 업로드하면 주문번호로 대조해서 자동으로 사라져요.{pendingLoading ? ' · 불러오는 중...' : ''}
            </div>
            {(() => {
              const rowsAll = pendingRows
              const rows = pendingMonthOnly
                ? rowsAll.filter(r => {
                    if (!r.ordered_at) return false
                    const d = new Date(r.ordered_at)
                    return d.getFullYear() === year && d.getMonth() === viewMonthIdx
                  })
                : rowsAll
              if (rows.length === 0) return <div className="chart-empty">배송중인 주문이 없어요</div>
              const totalQty = rows.reduce((s, r) => s + (r.qty || 0), 0)
              return (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap' }}>
                    <thead>
                      <tr style={{ background: '#f8fafc' }}>
                        {['주문일시', '아이템명', '스타일넘버', '옵션', '수량', '주문번호', ''].map((h, i) => (
                          <th key={i} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', color: '#94a3b8', fontWeight: 700 }}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r: any) => (
                        <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>
                            {r.ordered_at ? String(r.ordered_at).replace('T', ' ').slice(0, 16) : '-'}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 600 }}>{r.item_name || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontFamily: 'monospace', color: '#64748b' }}>{r.style_no || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{r.option_name || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700, color: '#d97706' }}>{r.qty}개</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}>{r.order_no}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                            <button onClick={() => deletePendingOrder(r)} title="이 주문을 목록에서 삭제"
                              style={{ border: '1px solid #fecdd3', background: '#fff', color: '#e11d48', cursor: 'pointer', fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 6 }}>
                              삭제
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr style={{ background: '#f8fafc', borderTop: '2px solid #94a3b8' }}>
                        <td colSpan={4} style={{ padding: '10px', textAlign: 'right', fontWeight: 700, color: '#374151' }}>합계 ({rows.length}건)</td>
                        <td style={{ padding: '10px', textAlign: 'center', fontWeight: 800, color: '#d97706' }}>{totalQty}개</td>
                        <td colSpan={2}></td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )
            })()}
          </div>
        </div>
      )}

      {showOrderModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setShowOrderModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 1400, height: 780, overflow: 'auto', flexShrink: 0 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>무신사 일별 주문표</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <button onClick={deleteMonthData}
                  style={{ border: '1px solid #fecdd3', background: '#fff', color: '#e11d48', cursor: 'pointer', fontSize: 11, fontWeight: 700, padding: '5px 10px', borderRadius: 6 }}>
                  🗑 이 달({orderYear}.{orderMonthIdx + 1}) 전체 삭제
                </button>
                <button onClick={() => setShowOrderModal(false)}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#94a3b8', lineHeight: 1 }}>×</button>
              </div>
            </div>

            <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 12, marginBottom: 16 }}>
              <button onClick={() => shiftOrderMonth(-1)} style={monthNavBtnStyle}>◀</button>
              <span style={{ fontWeight: 700, fontSize: 15 }}>{orderYear}년 {orderMonthIdx + 1}월</span>
              <button onClick={() => shiftOrderMonth(1)} style={monthNavBtnStyle}>▶</button>
            </div>

            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 8, textAlign: 'center' }}>
              [무신사할인] [브랜드할인] [수수료] 칸의 금액을 클릭하면 세부 내역이 뜹니다
            </div>

            {orderLoading ? (
              <div className="loading">로딩 중...</div>
            ) : orderRows.length === 0 ? (
              <div className="chart-empty">이 달에는 등록된 주문 내역이 없습니다</div>
            ) : (() => {
              // 하단 합계용 계산 (개별 행과 완전히 같은 공식 사용)
              let sumMusinsaDiscount = 0, sumBrandDiscount = 0, sumCommissionAQ = 0
              let sumRevenueAO = 0, sumTotalCommission = 0, sumSettlement = 0
              orderRows.forEach((r: any) => {
                const musinsaDiscountTotal = (r.discount || 0) + (r.musinsa_coupon || 0) + (r.musinsa_cart_coupon || 0) + (r.reward_points || 0)
                const brandDiscountTotal = (r.vendor_coupon || 0) + (r.cart_vendor_coupon || 0)
                const commissionAQ = r.commission_sale || 0
                const revenueAO = r.revenue_ao || 0
                const { totalCommission, settlementAmount } = computeCommissionAndSettlement(r)
                sumMusinsaDiscount += musinsaDiscountTotal
                sumBrandDiscount += brandDiscountTotal
                sumCommissionAQ += commissionAQ
                sumRevenueAO += revenueAO
                sumTotalCommission += totalCommission
                sumSettlement += settlementAmount
              })

              return (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, whiteSpace: 'nowrap' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      {['날짜', '주문번호', '시즌', '구분', '아이템명', '스타일넘버', '옵션', '수량', '판매가', '할인율', '판매금액', '클레임내역', '무신사할인', '브랜드할인', '수수료', '매출액', '총수수료', '정산금액'].map(h => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', color: '#94a3b8', fontWeight: 700 }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {orderRows.map((r: any) => {
                      const musinsaDiscountTotal = (r.discount || 0) + (r.musinsa_coupon || 0) + (r.musinsa_cart_coupon || 0) + (r.reward_points || 0)
                      const brandDiscountTotal = (r.vendor_coupon || 0) + (r.cart_vendor_coupon || 0)
                      // 판매가는 재고에 등록된 실제 판매가(스타일넘버+옵션 매칭) 우선, 매칭 안 되면 판매금액÷수량으로 대체
                      const unitPrice = r.registered_sell_price > 0
                        ? r.registered_sell_price
                        : (r.qty > 0 ? Math.round((r.sale_amount || 0) / r.qty) : 0)
                      // 할인율 = 판매가 대비 판매금액(1개당)이 몇 % 낮은지 — (판매가 - 판매금액/수량) / 판매가 × 100
                      const perUnitSaleAmount = r.qty > 0 ? (r.sale_amount || 0) / r.qty : 0
                      const discountRate = unitPrice > 0 ? Math.round(((unitPrice - perUnitSaleAmount) / unitPrice) * 1000) / 10 : 0
                      // 매출액(AO), 수수료(AQ=판매수수료), 총수수료 = AQ-AU(패널티)-AV(청구반품비)-AW(후기부스팅)-AX(MFS물류비)+무신사할인, 정산금액 = 매출액-총수수료
                      // (단, "일일정산확인"으로 업로드된 행은 net_settlement에 무신사가 계산해준 최종 정산금액이 저장되어 있어 그 값을 그대로 사용)
                      const revenueAO = r.revenue_ao || 0
                      const commissionAQ = r.commission_sale || 0
                      const { totalCommission, settlementAmount } = computeCommissionAndSettlement(r)
                      const rowOptKey = normalizeOptionForMatch(r.option_name)
                      const skuKey = r.style_no ? `${normalizeSkuForMatch(r.style_no)}__${rowOptKey}` : ''
                      const nameKey = `${String(r.item_name || '').trim().toUpperCase()}__${rowOptKey}`
                      const seasonLabel = (skuKey && orderSeasonBySkuOption.get(skuKey)) || orderSeasonByNameOption.get(nameKey) || '미지정'
                      return (
                        <tr key={r.id} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.settle_date}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontFamily: 'monospace', fontSize: 11, color: '#94a3b8' }}
                            title={r.order_no ? `주문번호 ${r.order_no}${r.order_serial ? ` / 일련번호 ${r.order_serial}` : ''}` : '이 행은 주문번호 컬럼 추가 전에 업로드된 데이터예요 — 해당 기간 정산내역을 다시 업로드하면 채워집니다'}>
                            {r.order_no || '-'}
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: '#64748b' }}>{seasonLabel}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                            <span style={{
                              fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 6,
                              background: r.order_type === '판매' ? '#eef2ff' : r.order_type?.includes('반품') || r.order_type?.includes('환불') ? '#fef2f2' : '#fff7ed',
                              color: r.order_type === '판매' ? '#4f46e5' : r.order_type?.includes('반품') || r.order_type?.includes('환불') ? '#e11d48' : '#d97706',
                            }}>{r.order_type || '-'}</span>
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', cursor: 'pointer', textDecoration: 'underline dotted' }}
                            onClick={() => openEditLine(r)} title="클릭해서 아이템명/스타일넘버 수정">{r.item_name || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontFamily: 'monospace', cursor: 'pointer', textDecoration: 'underline dotted' }}
                            onClick={() => openEditLine(r)} title="클릭해서 아이템명/스타일넘버 수정">{r.style_no || '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.option_name || '-'}</td>
                          {(() => {
                            // 환불행은 그 주문의 "판매" 건이 데이터에 있을 때만 -N으로 차감하고,
                            // 원래 판매 기록이 없으면 0으로 표시 (팔지 않은 수량이 마이너스로 잡히지 않도록)
                            const isRefundRow = !!(r.order_type?.includes('반품') || r.order_type?.includes('환불'))
                            const hasSale = isRefundRow && refundHasMatchingSale(r, orderSaleOrderNos)
                            const displayQty = isRefundRow
                              ? (hasSale ? `-${r.qty && r.qty > 0 ? r.qty : 1}${!r.qty ? '(추정)' : ''}` : '0')
                              : (r.qty || 0)
                            const tip = isRefundRow
                              ? (hasSale
                                  ? (!r.qty ? '파일에 수량이 0으로 찍혀있어 1개로 추정' : undefined)
                                  : '같은 주문(주문일련번호)의 판매 건이 데이터에 없어서 0으로 처리 (원래 판매분이 있는 기간의 정산내역을 올리면 -1로 반영됨)')
                              : undefined
                            return (
                              <td style={{
                                padding: '8px 10px', textAlign: 'center', fontWeight: 700,
                                color: isRefundRow ? (hasSale ? '#e11d48' : '#94a3b8') : undefined,
                              }} title={tip}>
                                {displayQty}개
                              </td>
                            )
                          })()}
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: r.registered_sell_price > 0 ? undefined : '#d97706' }} title={r.registered_sell_price > 0 ? '재고 등록 판매가' : '재고 미매칭 — 판매금액÷수량으로 추정'}>{formatWon(unitPrice)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{unitPrice > 0 ? `${discountRate}%` : '-'}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(r.sale_amount)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', color: r.claim_amount > 0 ? '#e11d48' : undefined }}>{formatWon(r.claim_amount)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                            <button onClick={() => setBreakdown({
                              title: '무신사할인 세부 내역',
                              items: [
                                { label: '할인', value: r.discount || 0 },
                                { label: '무신사쿠폰', value: r.musinsa_coupon || 0 },
                                { label: '장바구니쿠폰(무신사)', value: r.musinsa_cart_coupon || 0 },
                                { label: '적립금', value: r.reward_points || 0 },
                              ],
                            })} style={{ border: 'none', background: 'none', color: '#2563eb', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>
                              {formatWon(musinsaDiscountTotal)}
                            </button>
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                            <button onClick={() => setBreakdown({
                              title: '브랜드할인 세부 내역',
                              items: [
                                { label: '업체쿠폰(브랜드쿠폰)', value: r.vendor_coupon || 0 },
                                { label: '장바구니쿠폰(업체)', value: r.cart_vendor_coupon || 0 },
                              ],
                            })} style={{ border: 'none', background: 'none', color: '#d97706', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>
                              {formatWon(brandDiscountTotal)}
                            </button>
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(commissionAQ)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(revenueAO)}</td>
                          <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                            <button onClick={() => setBreakdown({
                              title: '총수수료 세부 내역 (AQ-AU-AV-AW-AX+무신사할인)',
                              items: [
                                { label: '수수료(AQ, 판매수수료)', value: commissionAQ },
                                { label: '- 패널티(AU)', value: -(r.penalty || 0) },
                                { label: '- 청구반품비(AV)', value: -(r.claim_shipping_fee || 0) },
                                { label: '- 후기부스팅(AW)', value: -(r.review_boost || 0) },
                                { label: '- MFS물류비(AX)', value: -(r.mfs_logistics || 0) },
                                { label: '+ 무신사할인', value: musinsaDiscountTotal },
                              ],
                            })} style={{ border: 'none', background: 'none', color: '#e11d48', textDecoration: 'underline', cursor: 'pointer', fontSize: 12 }}>
                              {formatWon(totalCommission)}
                            </button>
                          </td>
                          <td style={{ padding: '8px 10px', textAlign: 'center', fontWeight: 700 }}>{formatWon(settlementAmount)}</td>
                        </tr>
                      )
                    })}
                  </tbody>
                  <tfoot>
                    <tr style={{ background: '#f8fafc', borderTop: '2px solid #94a3b8' }}>
                      <td colSpan={12} style={{ padding: '10px', textAlign: 'right', fontWeight: 700, color: '#374151' }}>합계</td>
                      <td style={{ padding: '10px', textAlign: 'center', fontWeight: 800, color: '#2563eb' }}>{formatWon(sumMusinsaDiscount)}</td>
                      <td style={{ padding: '10px', textAlign: 'center', fontWeight: 800, color: '#d97706' }}>{formatWon(sumBrandDiscount)}</td>
                      <td style={{ padding: '10px', textAlign: 'center', fontWeight: 800 }}>{formatWon(sumCommissionAQ)}</td>
                      <td style={{ padding: '10px', textAlign: 'center', fontWeight: 800 }}>{formatWon(sumRevenueAO)}</td>
                      <td style={{ padding: '10px', textAlign: 'center', fontWeight: 800, color: '#e11d48' }}>{formatWon(sumTotalCommission)}</td>
                      <td style={{ padding: '10px', textAlign: 'center', fontWeight: 800 }}>{formatWon(sumSettlement)}</td>
                    </tr>
                    {orderExtraFees && (() => {
                      const extraItems = [
                        { label: '반품비결제', value: orderExtraFees.return_fee_settle || 0 },
                        { label: '청구반품비', value: orderExtraFees.claim_return_fee || 0 },
                        { label: '배송비결제', value: orderExtraFees.shipping_fee_settle || 0 },
                        { label: '후기부스팅', value: orderExtraFees.review_boost_extra || 0 },
                        { label: 'MFS물류비', value: orderExtraFees.mfs_logistics_extra || 0 },
                      ]
                      const extraTotal = extraItems.reduce((s, it) => s + it.value, 0)
                      if (extraTotal === 0) return null
                      return (
                        <>
                          <tr>
                            <td colSpan={18} style={{ padding: '8px 10px 2px', fontSize: 11, color: '#94a3b8', fontWeight: 700 }}>
                              날짜 없는 기간 요약 항목 (총수수료에 포함됨)
                            </td>
                          </tr>
                          <tr style={{ background: '#fff7ed' }}>
                            <td colSpan={12} style={{ padding: '8px 10px', textAlign: 'right', color: '#92400e' }}>
                              {extraItems.map(it => `${it.label} ${formatWon(it.value)}`).join('  ·  ')}
                            </td>
                            <td colSpan={3} style={{ padding: '8px 10px', textAlign: 'center', color: '#92400e', fontWeight: 700 }}>
                              소계 {formatWon(extraTotal)}
                            </td>
                            <td colSpan={1}></td>
                            <td colSpan={2}></td>
                          </tr>
                          <tr style={{ background: '#f8fafc', borderTop: '1px solid #94a3b8' }}>
                            <td colSpan={14} style={{ padding: '10px', textAlign: 'right', fontWeight: 700, color: '#374151' }}>최종 합계 (기간 요약 항목 반영)</td>
                            <td colSpan={2} style={{ padding: '10px', textAlign: 'center', fontWeight: 800, color: '#e11d48' }}>{formatWon(sumTotalCommission + extraTotal)}</td>
                            <td style={{ padding: '10px', textAlign: 'center', fontWeight: 800 }}>{formatWon(sumSettlement - extraTotal)}</td>
                          </tr>
                        </>
                      )
                    })()}
                  </tfoot>
                </table>
              </div>
              )
            })()}
          </div>
        </div>
      )}

      {showCostModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}
          onClick={() => setShowCostModal(false)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 24, width: 900, height: 700, overflow: 'auto', flexShrink: 0 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 16 }}>아이템별 원가 확인</div>
              <button onClick={() => setShowCostModal(false)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 20, color: '#94a3b8', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
              {costModalScope} · 일별 주문표와 같은 데이터를 기준으로 집계돼서 두 팝업 숫자는 항상 일치해요
            </div>

            {costLoading ? (
              <div className="loading">로딩 중...</div>
            ) : costRows.length === 0 ? (
              <div className="chart-empty">해당 기간에 데이터가 없습니다</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {['상품명', '스타일넘버', '옵션', '수량', '매칭 원가', '매칭 상태'].map(h => (
                      <th key={h} style={{ padding: '8px 10px', textAlign: 'center', borderBottom: '1px solid #94a3b8', color: '#94a3b8', fontWeight: 700 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {costRows.map(r => (
                    <tr key={r.key} style={{ borderBottom: '1px solid #f1f5f9', background: r.matched ? undefined : '#fff7ed' }}>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.itemName}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center', fontFamily: 'monospace' }}>{r.styleNo}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.option}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>{r.qty}개</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>{formatWon(r.cost)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                        {r.matched ? (
                          <span style={{ color: '#059669', fontWeight: 700 }}>✓ 매칭됨</span>
                        ) : (
                          <span style={{ color: '#d97706', fontWeight: 700 }}>⚠ 미매칭 (원가 0)</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {editLineTarget && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}
          onClick={() => setEditLineTarget(null)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 20, width: 400 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>아이템명 / 스타일넘버 수정</div>
              <button onClick={() => setEditLineTarget(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18, color: '#94a3b8', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 12 }}>
              대소문자·띄어쓰기 차이로 재고와 매칭이 안 될 때 여기서 고치면, 저장 즉시 재고와 다시 매칭해서 원가·판매가도 같이 갱신돼요.<br/>
              (날짜: {editLineTarget.settle_date} / 옵션: {editLineTarget.option_name || '-'})
            </div>
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>아이템명</div>
              <input value={editLineForm.item_name} onChange={e => setEditLineForm(v => ({ ...v, item_name: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit' }} />
            </div>
            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>스타일넘버</div>
              <input value={editLineForm.style_no} onChange={e => setEditLineForm(v => ({ ...v, style_no: e.target.value }))}
                style={{ width: '100%', padding: '8px 10px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'monospace' }} />
            </div>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button onClick={() => setEditLineTarget(null)}
                style={{ padding: '7px 16px', border: '1px solid #94a3b8', borderRadius: 8, background: '#f8fafc', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>취소</button>
              <button onClick={saveEditLine} disabled={editLineSaving}
                style={{ padding: '7px 16px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
                {editLineSaving ? '저장 중...' : '저장'}
              </button>
            </div>
          </div>
        </div>
      )}

      {breakdown && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1100 }}
          onClick={() => setBreakdown(null)}>
          <div style={{ background: '#fff', borderRadius: 16, padding: 20, width: 360 }}
            onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div style={{ fontWeight: 700, fontSize: 14 }}>{breakdown.title}</div>
              <button onClick={() => setBreakdown(null)} style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18, color: '#94a3b8', lineHeight: 1 }}>×</button>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {breakdown.items.map((it, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13 }}>
                  <span style={{ color: '#64748b' }}>{it.label}</span>
                  <span style={{ fontWeight: 700 }}>{formatWon(it.value)}</span>
                </div>
              ))}
              <div style={{ borderTop: '1px solid #94a3b8', marginTop: 6, paddingTop: 8, display: 'flex', justifyContent: 'space-between', fontSize: 13, fontWeight: 800 }}>
                <span>합계</span>
                <span>{formatWon(breakdown.items.reduce((s, it) => s + it.value, 0))}</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  background: '#f8fafc', border: '1px solid #94a3b8', borderRadius: 8,
  padding: '6px 12px', cursor: 'pointer', fontSize: 14, fontWeight: 700,
}
const monthNavBtnStyle: React.CSSProperties = {
  background: '#fff', border: '1px solid #94a3b8', borderRadius: 6,
  padding: '2px 8px', cursor: 'pointer', fontSize: 10, fontWeight: 700, color: '#475569',
  width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
}