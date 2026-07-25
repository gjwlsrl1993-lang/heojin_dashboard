'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'
import { formatKRW } from '@/lib/utils'
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  PieChart, Pie, Cell, LineChart, Line, Legend, ComposedChart, Area, LabelList
} from 'recharts'
import Link from 'next/link'

// ------------------------------------------------------------------
// 플랫폼 채널 설정 — 각 채널 페이지가 실제로 쓰는 정산 테이블에서 직접 집계한다.
// (예전 monthly_sales_by_channel / sales 뷰는 어느 채널 페이지도 더 이상 쓰지 않아서 항상 비어있었음)
// 새 채널이 생기면 이 배열에 한 줄만 추가하면 대시보드에 자동으로 반영됨.
// 수수료율은 각 채널 페이지의 대표 요율(할인 연동 등 세부 변동분은 제외한 근사치)이며,
// 정확한 수수료·정산금액은 각 채널 페이지에서 확인 가능.
// ------------------------------------------------------------------
type ChannelConfig = {
  name: string   // 정산 테이블의 channel 컬럼 값 (쿼리 전용, 절대 바꾸면 안 됨 — DB에 저장된 값과 일치해야 함)
  label: string  // 화면에 표시할 이름
  color: string
  table: string
  dateCol: string
  grossCol: string
  // 순매출액(수수료 제외) 계산 방식 — 각 채널 페이지가 실제로 쓰는 공식과 동일하게 맞춤
  //  'flat'               : feeRate 고정 요율 (카페24 3.5% PG수수료 / WOO 40% / 클라만 30%)
  //  'reket-sliding'       : REKET — 기본 30%, 할인 10%마다 -1%p (reket-page.tsx의 reketFeeRate와 동일)
  //  'musinsa-commission'  : 무신사 — net_settlement가 있으면 그 값을 그대로, 없으면 커미션 항목들을 합산해 역산 (musinsa-page.tsx의 computeCommissionAndSettlement와 동일)
  netMode: 'flat' | 'reket-sliding' | 'musinsa-commission'
  feeRate?: number // netMode='flat'일 때만 사용
  monthOnly?: boolean // true면 dateCol이 'YYYY-MM'(월 단위) 포맷 (예: 클라만)
  shipping: 'qty-tiered' | 'row-tiered' | 'row-flat' | 'none' // 채널별 택배비 계산 방식 (각 채널 페이지와 동일)
}

const CHANNELS: ChannelConfig[] = [
  { name: '카페24', label: '자사몰', color: '#10b981', table: 'cafe24_settlement_lines', dateCol: 'settle_date', grossCol: 'sale_amount', netMode: 'flat', feeRate: 0.035, shipping: 'row-flat' },
  { name: '무신사', label: '무신사', color: '#3b82f6', table: 'musinsa_settlement_lines', dateCol: 'settle_date', grossCol: 'revenue_ao', netMode: 'musinsa-commission', shipping: 'qty-tiered' },
  { name: 'WOO', label: 'WOO', color: '#8b5cf6', table: 'woo_settlement_lines', dateCol: 'settle_date', grossCol: 'sale_amount', netMode: 'flat', feeRate: 0.40, shipping: 'row-tiered' },
  { name: 'REKET', label: 'REKET', color: '#f43f5e', table: 'reket_settlement_lines', dateCol: 'settle_date', grossCol: 'sale_amount', netMode: 'reket-sliding', shipping: 'row-tiered' },
  { name: '클라만', label: '클라만', color: '#f59e0b', table: 'claman_settlement_lines', dateCol: 'settle_month', grossCol: 'sale_amount', netMode: 'flat', feeRate: 0.30, monthOnly: true, shipping: 'none' },
]

type ChannelMonthRow = { channel: string; color: string; month: string; gross: number; fees: number; net: number }
type ChannelYearData = { gross: number[]; cost: number[]; shipping: number[]; net: number[] }

const MONTH_LABELS = ['1월','2월','3월','4월','5월','6월','7월','8월','9월','10월','11월','12월']

function emptyChannelYearData(): ChannelYearData[] {
  return CHANNELS.map(() => ({ gross: new Array(12).fill(0), cost: new Array(12).fill(0), shipping: new Array(12).fill(0), net: new Array(12).fill(0) }))
}

// 1의 자리까지 정확한 원 단위 표시 (각 채널 페이지와 동일한 포맷)
function formatWon(n: number): string {
  return (n || 0).toLocaleString('ko-KR') + '원'
}

// 무신사/WOO/REKET가 공통으로 쓰는 건당 택배비 단가 (기간별로 변경됨):
// 25.10월까지 3,400원 / 25.11~26.4월 2,900원 / 그 이후 2,990원
function shippingRateFor(dateStr: string): number {
  if (dateStr <= '2025-10-31') return 3400
  if (dateStr <= '2026-04-30') return 2900
  return 2990
}

// 판매 추이 차트용 날짜 헬퍼 — 해당 날짜가 속한 주의 월요일을 반환
function mondayOfDate(d: Date): Date {
  const day = d.getDay() || 7
  const mon = new Date(d)
  mon.setDate(d.getDate() - day + 1)
  mon.setHours(0, 0, 0, 0)
  return mon
}
function mondayOfDateStr(dateStr: string): Date {
  return mondayOfDate(new Date(dateStr + 'T00:00:00'))
}
function fmtDateShort(d: Date): string {
  return `${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

function sumArr(a: number[]): number {
  return a.reduce((s, v) => s + v, 0)
}

// 채널별 실제 순매출액(수수료 제외) 계산 — 각 채널 페이지의 공식을 그대로 재사용
function computeLineNet(channel: ChannelConfig, row: any, gross: number): number {
  if (channel.netMode === 'reket-sliding') {
    const discountAmount = row.discount_amount || 0
    const preAmount = gross + discountAmount
    const discountRate = preAmount > 0 ? discountAmount / preAmount : 0
    const steps = Math.floor((discountRate || 0) * 100 / 10)
    const feeRate = Math.max(0, 0.30 - steps * 0.01)
    return gross - Math.round(gross * feeRate)
  }
  if (channel.netMode === 'musinsa-commission') {
    if (row.net_settlement !== null && row.net_settlement !== undefined) {
      return row.net_settlement
    }
    const musinsaDiscountTotal = (row.discount || 0) + (row.musinsa_coupon || 0) + (row.musinsa_cart_coupon || 0) + (row.reward_points || 0)
    const totalCommission = (row.commission_sale || 0) - (row.penalty || 0) - (row.claim_shipping_fee || 0) - (row.review_boost || 0) - (row.mfs_logistics || 0) + musinsaDiscountTotal
    return gross - totalCommission
  }
  // flat
  return gross - Math.round(gross * (channel.feeRate || 0))
}

function selectColsFor(channel: ChannelConfig): string {
  const cols = [channel.dateCol, channel.grossCol, 'matched_cost']
  if (channel.shipping === 'qty-tiered') cols.push('qty')
  if (channel.netMode === 'reket-sliding') cols.push('discount_amount')
  if (channel.netMode === 'musinsa-commission') {
    cols.push('net_settlement', 'commission_sale', 'discount', 'musinsa_coupon', 'musinsa_cart_coupon', 'reward_points', 'penalty', 'claim_shipping_fee', 'review_boost', 'mfs_logistics')
  }
  return cols.join(', ')
}

// 전체 누적(총매출) 팝업 — 시즌 매칭을 위해 style_no/option_name/item_name까지 함께 조회
function selectColsForFull(channel: ChannelConfig): string {
  return selectColsFor(channel) + ', style_no, option_name, item_name'
}

// "25SS", "25FW" 같은 시즌 문자열을 시간순으로 정렬하기 위한 값 계산 (연도*10 + SS:0/FW:1), 미지정은 맨 뒤로
function seasonSortValue(season: string): number {
  const match = /^(\d{2})(SS|FW)$/i.exec((season || '').trim())
  if (!match) return -1
  const yy = parseInt(match[1], 10)
  const seasonCode = match[2].toUpperCase() === 'SS' ? 0 : 1
  return yy * 10 + seasonCode
}

// 채널 하나의 연간(1~12월) 매출·원가·택배비·순매출액을 해당 채널의 정산 테이블에서 직접 집계
// (각 채널 페이지가 순수익을 계산하는 방식과 동일한 공식을 그대로 재사용)
async function loadChannelYearData(channel: ChannelConfig, targetYear: number): Promise<ChannelYearData> {
  const gross = new Array(12).fill(0)
  const cost = new Array(12).fill(0)
  const shipping = new Array(12).fill(0)
  const net = new Array(12).fill(0)
  const base = supabase.from(channel.table).select(selectColsFor(channel)).eq('channel', channel.name)
  const { data } = channel.monthOnly
    ? await base.gte(channel.dateCol, `${targetYear}-01`).lte(channel.dateCol, `${targetYear}-12`)
    : await base.gte(channel.dateCol, `${targetYear}-01-01`).lte(channel.dateCol, `${targetYear}-12-31`)
  ;(data || []).forEach((row: any) => {
    const raw = row[channel.dateCol]
    const m = channel.monthOnly ? (parseInt(String(raw).slice(5, 7), 10) - 1) : new Date(raw).getMonth()
    if (m < 0 || m >= 12) return
    const g = row[channel.grossCol] || 0
    gross[m] += g
    cost[m] += row.matched_cost || 0
    net[m] += computeLineNet(channel, row, g)
    if (channel.shipping === 'qty-tiered') shipping[m] += (row.qty || 0) * shippingRateFor(String(raw))
    else if (channel.shipping === 'row-tiered') shipping[m] += shippingRateFor(String(raw))
    else if (channel.shipping === 'row-flat') shipping[m] += 2990
  })
  return { gross, cost, shipping, net }
}

// 무신사 "날짜 없는 기간 요약 항목"(반품비결제·청구반품비·배송비결제·후기부스팅·MFS물류비 등)을 월별로 집계
// — musinsa_settlement_lines에는 안 잡히고 musinsa_settlement_extra_fees에 별도로 저장되어 있어서, 순매출액에서 추가로 차감해야 함
async function loadMusinsaExtraFeesByMonth(targetYear: number): Promise<number[]> {
  const arr = new Array(12).fill(0)
  const { data } = await supabase
    .from('musinsa_settlement_extra_fees')
    .select('month, return_fee_settle, claim_return_fee, shipping_fee_settle, review_boost_extra, mfs_logistics_extra, low_price_shipping_support')
    .eq('channel', '무신사')
    .eq('year', targetYear)
  ;(data || []).forEach((row: any) => {
    const idx = (row.month || 1) - 1
    if (idx < 0 || idx >= 12) return
    arr[idx] += (row.return_fee_settle || 0) + (row.claim_return_fee || 0) + (row.shipping_fee_settle || 0) + (row.review_boost_extra || 0) + (row.mfs_logistics_extra || 0) + (row.low_price_shipping_support || 0)
  })
  return arr
}

// 전 채널 연간 데이터 로드 + 무신사 날짜 없는 기간 요약 항목까지 반영한 최종 순매출액
async function loadAllChannelsForYear(targetYear: number): Promise<ChannelYearData[]> {
  const [results, musinsaExtra] = await Promise.all([
    Promise.all(CHANNELS.map(c => loadChannelYearData(c, targetYear))),
    loadMusinsaExtraFeesByMonth(targetYear),
  ])
  const musinsaIdx = CHANNELS.findIndex(c => c.name === '무신사')
  if (musinsaIdx >= 0) {
    for (let m = 0; m < 12; m++) results[musinsaIdx].net[m] -= musinsaExtra[m]
  }
  return results
}

// 전 채널 월별 판매수량 — 무신사(qty 컬럼 보유)는 qty 합산, 나머지 채널(자사몰/WOO/REKET/클라만)은
// 각 채널 페이지와 동일하게 정산 라인 1건 = 판매 1건으로 집계. 매출이 0 이하인 행(환불·취소)은 제외.
async function loadMonthlyQtyForYear(targetYear: number): Promise<number[]> {
  const qty = new Array(12).fill(0)
  await Promise.all(CHANNELS.map(async (c) => {
    const cols = c.shipping === 'qty-tiered' ? `${c.dateCol}, ${c.grossCol}, qty` : `${c.dateCol}, ${c.grossCol}`
    const base = supabase.from(c.table).select(cols).eq('channel', c.name)
    const { data } = c.monthOnly
      ? await base.gte(c.dateCol, `${targetYear}-01`).lte(c.dateCol, `${targetYear}-12`)
      : await base.gte(c.dateCol, `${targetYear}-01-01`).lte(c.dateCol, `${targetYear}-12-31`)
    ;(data || []).forEach((row: any) => {
      const raw = row[c.dateCol]
      const m = c.monthOnly ? (parseInt(String(raw).slice(5, 7), 10) - 1) : new Date(raw).getMonth()
      if (m < 0 || m >= 12) return
      const g = row[c.grossCol] || 0
      if (g <= 0) return
      qty[m] += c.shipping === 'qty-tiered' ? (row.qty || 0) : 1
    })
  }))
  return qty
}

function buildChannelRows(targetYear: number, results: ChannelYearData[]): ChannelMonthRow[] {
  const rows: ChannelMonthRow[] = []
  CHANNELS.forEach((c, ci) => {
    results[ci].gross.forEach((gross, mi) => {
      const net = results[ci].net[mi] || 0
      rows.push({
        channel: c.label,
        color: c.color,
        month: `${targetYear}-${String(mi + 1).padStart(2, '0')}-01`,
        gross,
        fees: gross - net,
        net,
      })
    })
  })
  return rows
}

// 채널 결과 배열(연간 or 특정 월)을 매출/원가/택배비/순매출액 합계로 집계 (수수료는 매출-순매출로 역산)
function aggregateChannels(results: ChannelYearData[], monthIdx?: number) {
  let gross = 0, net = 0, cost = 0, shipping = 0
  CHANNELS.forEach((c, ci) => {
    const r = results[ci]
    if (!r) return
    const g = monthIdx === undefined ? sumArr(r.gross) : (r.gross[monthIdx] || 0)
    const n = monthIdx === undefined ? sumArr(r.net) : (r.net[monthIdx] || 0)
    const co = monthIdx === undefined ? sumArr(r.cost) : (r.cost[monthIdx] || 0)
    const sh = monthIdx === undefined ? sumArr(r.shipping) : (r.shipping[monthIdx] || 0)
    gross += g
    net += n
    cost += co
    shipping += sh
  })
  return { gross, net, fee: gross - net, cost, shipping }
}

// 플랫폼별 매출 비중 도넛 차트 — 슬라이스 안쪽에 "채널명 몇%"를 직접 표시
function renderPieLabel(props: any) {
  const { cx, cy, midAngle, innerRadius, outerRadius, percent, name } = props
  if (!percent) return null
  const RADIAN = Math.PI / 180
  const radius = innerRadius + (outerRadius - innerRadius) * 0.6
  const x = cx + radius * Math.cos(-midAngle * RADIAN)
  const y = cy + radius * Math.sin(-midAngle * RADIAN)
  return (
    <text x={x} y={y} fill="#000" textAnchor="middle" dominantBaseline="central" fontSize={10} fontWeight={700}>
      {`${name} ${Math.round(percent * 100)}%`}
    </text>
  )
}

type KpiStat = {
  gross: number; fee: number; net: number; cost: number; shipping: number; adCharge: number; profit: number
  prevGross: number; prevNet: number; prevProfit: number
}

function emptyKpiStat(): KpiStat {
  return { gross: 0, fee: 0, net: 0, cost: 0, shipping: 0, adCharge: 0, profit: 0, prevGross: 0, prevNet: 0, prevProfit: 0 }
}

// 무신사 충전 광고비(월별)를 조회 — 무신사가 매달 무료로 주는 10만원 제외하고 실제 충전한 금액만
async function loadMusinsaAdChargeByMonth(targetYear: number): Promise<number[]> {
  const arr = new Array(12).fill(0)
  const { data } = await supabase.from('musinsa_ad_charge').select('month, charged_amount').eq('channel', '무신사').eq('year', targetYear)
  ;(data || []).forEach((r: any) => {
    const idx = (r.month || 1) - 1
    if (idx >= 0 && idx < 12) arr[idx] = r.charged_amount || 0
  })
  return arr
}

export default function DashboardPage() {
  const [year, setYear] = useState(new Date().getFullYear())
  const [monthlySales, setMonthlySales] = useState<ChannelMonthRow[]>([])
  const [thisMonthSales, setThisMonthSales] = useState<ChannelMonthRow[]>([])
  const [loading, setLoading] = useState(true)

  // 연간 KPI (총매출/순매출/순수익) — 원가·택배비·충전광고비까지 반영한 정확한 값 + 전년 대비
  const [annualKpi, setAnnualKpi] = useState<KpiStat>(emptyKpiStat())
  // 선택한 달(selYear/selMonth) KPI — 위와 동일한 구조, 전년동월 대비
  const [monthKpi, setMonthKpi] = useState<KpiStat>(emptyKpiStat())

  const thisYear  = new Date().getFullYear()
  const thisMonth = new Date().getMonth() + 1
  const [selYear,  setSelYear]  = useState(thisYear)
  const [selMonth, setSelMonth] = useState(thisMonth)
  const [chartMonth, setChartMonth] = useState(thisMonth)
  const [chartYear,  setChartYear]  = useState(thisYear)

  // 광고 성과지표 (연도 / 월별) — 현재는 무신사만 ad_performance에 광고비·전환매출을 기록하고 있어서
  // 우선 무신사 데이터만 연동. 다른 채널도 광고 데이터가 쌓이면 CHANNELS처럼 배열로 확장하면 됨.
  // 상단 year와 별개로 자체 연도/월 이동 가능 (기본값: 올해/이번달)
  const [adYear, setAdYear] = useState(thisYear)
  const [adMonth, setAdMonth] = useState(thisMonth)
  const [adLoading, setAdLoading] = useState(false)
  const [adMonthlyCost, setAdMonthlyCost] = useState<number[]>(new Array(12).fill(0))
  const [adMonthlyRevenue, setAdMonthlyRevenue] = useState<number[]>(new Array(12).fill(0))
  const [adMonthlyGross, setAdMonthlyGross] = useState<number[]>(new Array(12).fill(0)) // TACOS 분모(전 채널 매출)
  const [adMonthlyCharge, setAdMonthlyCharge] = useState<number[]>(new Array(12).fill(0)) // 충전 광고비(musinsa_ad_charge, 무료 10만원 제외 실 충전액)

  // AI 추천 인사이트 (규칙 기반, 채널 페이지들과 동일한 방식) — 기본 접힘
  const [insightsExpanded, setInsightsExpanded] = useState(false)
  // 채널별 매출 요약 테이블 — 상단 year와 별개로 연도 이동 가능 (기본값: 올해), 연도/월별 전환 가능
  const [channelSummaryYear, setChannelSummaryYear] = useState(thisYear)
  const [channelSummaryMonth, setChannelSummaryMonth] = useState(thisMonth)
  const [channelSummaryMode, setChannelSummaryMode] = useState<'year' | 'month'>('year')
  const [channelSummaryData, setChannelSummaryData] = useState<ChannelYearData[]>(emptyChannelYearData())
  const [channelSummaryLoading, setChannelSummaryLoading] = useState(false)
  // 채널별 매출요약 카드 하단 — channelSummaryYear 기준 시즌별 매출/순매출/순수익
  const [channelSummarySeasonData, setChannelSummarySeasonData] = useState<{ season: string; gross: number; net: number; cost: number; shipping: number; profit: number }[]>([])
  const [channelSummarySeasonLoading, setChannelSummarySeasonLoading] = useState(false)
  const [channelSummarySeasonIdx, setChannelSummarySeasonIdx] = useState(0)
  // 시즌별 판매표 팝업 — 시즌별 아이템·옵션별 판매수량
  const [showSeasonSalesModal, setShowSeasonSalesModal] = useState(false)
  const [seasonSalesDetail, setSeasonSalesDetail] = useState<Record<string, { item: string; option: string; qty: number }[]>>({})
  // 시즌이 지정되지 않아 시즌별 집계에서 빠진 판매 (통합 재고 제어판에서 시즌 지정하면 사라짐)
  const [seasonUnmatched, setSeasonUnmatched] = useState({ gross: 0, count: 0 })
  // 재고 현황 (현재 시점 기준, 연도와 무관) — 채널별 매출요약 표 맨 마지막 줄에 표시
  const [invSkuCount, setInvSkuCount] = useState(0)
  const [invTotalQty, setInvTotalQty] = useState(0)
  const [invTotalValue, setInvTotalValue] = useState(0)

  // 플랫폼별 월 매출 현황 차트 전용 데이터 (chartYear 이동 시 그 해/전년도를 별도로 조회), 연도/월별 전환 가능
  const [chartChannelCur, setChartChannelCur] = useState<ChannelYearData[]>(emptyChannelYearData())
  const [chartChannelPrev, setChartChannelPrev] = useState<ChannelYearData[]>(emptyChannelYearData())
  const [chartDataLoading, setChartDataLoading] = useState(false)
  const [platformChartMode, setPlatformChartMode] = useState<'year' | 'month'>('month')

  // 판매 추이 — 일간/주간/월간으로 전환 가능한 판매 그래프 (전 채널 합산)
  const [trendMode, setTrendMode] = useState<'daily' | 'weekly' | 'monthly'>('daily')
  const [trendLoading, setTrendLoading] = useState(false)
  const [trendDailyMap, setTrendDailyMap] = useState<Record<string, { gross: number; net: number }>>({})
  // 일간 모드 — 달력으로 원하는 주를 선택 (anchor는 그 주 안의 아무 날짜, 기본값: 오늘이 속한 주)
  const [trendWeekAnchor, setTrendWeekAnchor] = useState(() => new Date().toISOString().slice(0, 10))
  const [showTrendDatePicker, setShowTrendDatePicker] = useState(false)
  // 주간 모드 — 보고 싶은 달을 선택하면 그 달까지 최근 12주를 표시 (기본값: 이번 달)
  const [trendMonthAnchor, setTrendMonthAnchor] = useState(() => new Date().toISOString().slice(0, 7))

  // {연도}년 월별 매출 / 판매수량 — 자사몰·무신사 페이지와 동일한 구성의 12개월 전체 추이 차트
  // (상단 year와 별개로 이동 가능, 전 채널 합산 기준)
  const [salesChartYear, setSalesChartYear] = useState(thisYear)
  const [salesChartLoading, setSalesChartLoading] = useState(false)
  const [salesChartCur, setSalesChartCur] = useState<ChannelYearData[]>(emptyChannelYearData())
  const [salesChartPrev, setSalesChartPrev] = useState<ChannelYearData[]>(emptyChannelYearData())
  const [salesChartQty, setSalesChartQty] = useState<number[]>(new Array(12).fill(0))
  const [salesChartPrevQty, setSalesChartPrevQty] = useState<number[]>(new Array(12).fill(0))

  // 상단 year(연간 KPI 조회 기준)의 채널별 원본 데이터 — 이번달 KPI(selYear/selMonth)를 매번 새로
  // 다시 조회하지 않고 재사용하기 위해 보관 (selYear가 year와 다를 때만 별도로 다시 조회)
  const [curChannelData, setCurChannelData] = useState<ChannelYearData[]>(emptyChannelYearData())
  const [prevChannelData, setPrevChannelData] = useState<ChannelYearData[]>(emptyChannelYearData())
  const [curAdChargeArr, setCurAdChargeArr] = useState<number[]>(new Array(12).fill(0))
  const [prevAdChargeArr, setPrevAdChargeArr] = useState<number[]>(new Array(12).fill(0))

  // 플랫폼별 매출 비중 도넛 차트 — 전체(현재 연도 누적) / 연도별 / 월별 전환 + 연도·월별 선택 시 이동 가능
  const [pieMode, setPieMode] = useState<'all' | 'year' | 'month'>('all')
  const [pieYear, setPieYear] = useState(thisYear)
  const [pieMonth, setPieMonth] = useState(thisMonth)
  const [pieChannelData, setPieChannelData] = useState<ChannelYearData[]>(emptyChannelYearData())
  const [pieDataLoading, setPieDataLoading] = useState(false)

  // 전체 누적(총매출) 팝업 — 연도 구분 없이 지금까지 쌓인 전 채널 데이터를 한 번에 집계 + 시즌별 매출/순수익
  const [showTotalModal, setShowTotalModal] = useState(false)
  const [totalModalLoading, setTotalModalLoading] = useState(false)
  const [totalModalLoaded, setTotalModalLoaded] = useState(false)
  const [totalSummary, setTotalSummary] = useState({ gross: 0, net: 0, cost: 0, shipping: 0, adCharge: 0, profit: 0 })
  const [seasonSummary, setSeasonSummary] = useState<{ season: string; gross: number; net: number; profit: number }[]>([])

  const selMonthStr  = String(selMonth).padStart(2, '0')
  const thisMonthStart = `${selYear}-${selMonthStr}-01`
  const thisMonthEnd   = new Date(selYear, selMonth, 0).toISOString().slice(0, 10)

  function prevMonth() {
    if (selMonth === 1) { setSelYear(y => y - 1); setSelMonth(12) }
    else setSelMonth(m => m - 1)
  }
  function nextMonth() {
    if (selMonth === 12) { setSelYear(y => y + 1); setSelMonth(1) }
    else setSelMonth(m => m + 1)
  }

  useEffect(() => { loadData() }, [year])
  useEffect(() => { loadChartComparisonData(chartYear) }, [chartYear])
  useEffect(() => { loadSalesChartData(salesChartYear) }, [salesChartYear])
  useEffect(() => { loadChannelSummaryData(channelSummaryYear) }, [channelSummaryYear])
  // 시즌별 매출은 전 기간 기준이라 연도와 무관하게 한 번만 로드
  useEffect(() => { loadChannelSummarySeasonData() }, [])
  useEffect(() => { loadInventoryTotals() }, [])
  useEffect(() => { loadAdPerformance(adYear) }, [adYear])

  // 광고 성과지표 — adYear 기준 월별 광고비/전환매출(무신사, ad_performance) + 충전광고비(musinsa_ad_charge) + TACOS 분모인 전 채널 매출
  async function loadAdPerformance(targetYear: number) {
    setAdLoading(true)
    const [{ data: adRows }, channelResults, chargeArr] = await Promise.all([
      supabase.from('ad_performance').select('ad_date, ad_cost, conversion_revenue').eq('channel', '무신사')
        .gte('ad_date', `${targetYear}-01-01`).lte('ad_date', `${targetYear}-12-31`),
      loadAllChannelsForYear(targetYear),
      loadMusinsaAdChargeByMonth(targetYear),
    ])
    const adCostArr = new Array(12).fill(0)
    const adRevenueArr = new Array(12).fill(0)
    ;(adRows || []).forEach((row: any) => {
      const m = new Date(row.ad_date).getMonth()
      adCostArr[m] += row.ad_cost || 0
      adRevenueArr[m] += row.conversion_revenue || 0
    })
    const grossArr = MONTH_LABELS.map((_, i) => aggregateChannels(channelResults, i).gross)
    setAdMonthlyCost(adCostArr)
    setAdMonthlyRevenue(adRevenueArr)
    setAdMonthlyGross(grossArr)
    setAdMonthlyCharge(chargeArr)
    setAdLoading(false)
  }
  function prevAdMonth() {
    if (adMonth === 1) { setAdYear(y => y - 1); setAdMonth(12) }
    else setAdMonth(m => m - 1)
  }
  function nextAdMonth() {
    if (adMonth === 12) { setAdYear(y => y + 1); setAdMonth(1) }
    else setAdMonth(m => m + 1)
  }
  useEffect(() => { loadTrendData(trendMode, trendWeekAnchor, trendMonthAnchor) }, [trendMode, trendWeekAnchor, trendMonthAnchor])

  // 판매 추이 — 모드(일간/주간/월간)에 맞는 기간만큼 전 채널 정산 라인을 가져와 날짜별로 집계
  // (일간: 선택한 주 · 주간: 선택한 달까지 최근 12주 · 월간: 최근 12개월. 클라만은 월 단위 데이터라 해당 월 1일에 반영됨)
  async function loadTrendData(mode: 'daily' | 'weekly' | 'monthly', weekAnchor: string, monthAnchor: string) {
    setTrendLoading(true)
    const today = new Date()
    let fromStr: string
    let toStr: string
    if (mode === 'daily') {
      const start = mondayOfDateStr(weekAnchor)
      const end = new Date(start); end.setDate(start.getDate() + 6)
      fromStr = start.toISOString().slice(0, 10)
      toStr = end.toISOString().slice(0, 10)
    } else if (mode === 'weekly') {
      const [my, mm] = monthAnchor.split('-').map(Number)
      const monthEnd = new Date(my, mm, 0)
      const end = monthEnd < today ? monthEnd : today
      const start = new Date(end); start.setDate(end.getDate() - 7 * 11)
      fromStr = start.toISOString().slice(0, 10)
      toStr = end.toISOString().slice(0, 10)
    } else {
      const from = new Date(today); from.setMonth(from.getMonth() - 12)
      fromStr = from.toISOString().slice(0, 10)
      toStr = today.toISOString().slice(0, 10)
    }
    const fromMonthStr = fromStr.slice(0, 7)
    const toMonthStr = toStr.slice(0, 7)

    const map: Record<string, { gross: number; net: number }> = {}
    await Promise.all(CHANNELS.map(async (c) => {
      const base = supabase.from(c.table).select(selectColsFor(c)).eq('channel', c.name)
      const { data } = c.monthOnly
        ? await base.gte(c.dateCol, fromMonthStr).lte(c.dateCol, toMonthStr)
        : await base.gte(c.dateCol, fromStr).lte(c.dateCol, toStr)
      ;(data || []).forEach((row: any) => {
        const raw = row[c.dateCol]
        const dateKey = c.monthOnly ? `${raw}-01` : String(raw).slice(0, 10)
        const g = row[c.grossCol] || 0
        const n = computeLineNet(c, row, g)
        if (!map[dateKey]) map[dateKey] = { gross: 0, net: 0 }
        map[dateKey].gross += g
        map[dateKey].net += n
      })
    }))
    setTrendDailyMap(map)
    setTrendLoading(false)
  }

  // 채널별 매출요약 표 — channelSummaryYear(기본값: 올해)의 채널별 매출을 상단 year와 별개로 조회
  async function loadChannelSummaryData(targetYear: number) {
    setChannelSummaryLoading(true)
    const data = await loadAllChannelsForYear(targetYear)
    setChannelSummaryData(data)
    setChannelSummaryLoading(false)
  }

  // 시즌별 매출 — 한 시즌(예: 25FW)은 25년 말~26년 초에 걸쳐 팔리므로 연도로 자르면 매출이 잘려나감.
  // 그래서 연도 필터 없이 전 기간의 판매 라인을 전부 조회해서 items.season과 매칭한다 (플랫폼별 분석과 동일한 정산 테이블·동일한 순매출 공식 사용).
  async function loadChannelSummarySeasonData() {
    setChannelSummarySeasonLoading(true)
    // 통합 재고 수동 제어판에서 방금 시즌을 다시 지정했을 수 있으므로 items 테이블을 매번 새로 조회
    const { data: catItems } = await supabase.from('items').select('sku, name, option_name, season')
    const bySkuOption = new Map<string, string>()
    const byNameOption = new Map<string, string>()
    // 옵션명이 달라 매칭이 안 되는 경우를 대비한 폴백 — 스타일넘버/상품명만으로도 매칭 (같은 스타일이면 시즌은 동일하다고 가정)
    const bySkuOnly = new Map<string, string>()
    const byNameOnly = new Map<string, string>()
    ;(catItems || []).forEach((it: any) => {
      const season = it.season || '미지정'
      if (season === '미지정') return
      const skuKey = String(it.sku || '').trim().toUpperCase()
      const nameKey = String(it.name || '').trim().toUpperCase()
      const optionKey = String(it.option_name || '').trim().toUpperCase()
      if (skuKey) {
        bySkuOption.set(`${skuKey}__${optionKey}`, season)
        bySkuOnly.set(skuKey, season)
      }
      if (nameKey) {
        byNameOption.set(`${nameKey}__${optionKey}`, season)
        byNameOnly.set(nameKey, season)
      }
    })

    const seasonMap = new Map<string, { gross: number; net: number; cost: number; shipping: number; profit: number }>()
    // 시즌별 아이템·옵션별 판매수량 (판매표 팝업용) — season → "상품명__옵션" → 수량
    const detailMap = new Map<string, Map<string, { item: string; option: string; qty: number }>>()
    let unmatchedGross = 0
    let unmatchedCount = 0
    await Promise.all(CHANNELS.map(async (c) => {
      // 연도 제한 없이 전 기간 조회 (시즌은 연도 경계를 넘나들기 때문)
      const { data } = await supabase.from(c.table).select(selectColsForFull(c)).eq('channel', c.name)
      ;(data || []).forEach((row: any) => {
        const raw = row[c.dateCol]
        const g = row[c.grossCol] || 0
        const n = computeLineNet(c, row, g)
        const lineCost = row.matched_cost || 0
        let lineShipping = 0
        if (c.shipping === 'qty-tiered') lineShipping = (row.qty || 0) * shippingRateFor(String(raw))
        else if (c.shipping === 'row-tiered') lineShipping = shippingRateFor(String(raw))
        else if (c.shipping === 'row-flat') lineShipping = 2990

        const styleNo = (row.style_no || '').trim().toUpperCase()
        const optionName = (row.option_name || '').trim().toUpperCase()
        const itemName = (row.item_name || '').trim().toUpperCase()
        const season = (styleNo && bySkuOption.get(`${styleNo}__${optionName}`))
          || (itemName && byNameOption.get(`${itemName}__${optionName}`))
          || (styleNo && bySkuOnly.get(styleNo))
          || (itemName && byNameOnly.get(itemName))
          || '미지정'
        if (season === '미지정') { unmatchedGross += g; unmatchedCount += 1 }
        const prev = seasonMap.get(season) || { gross: 0, net: 0, cost: 0, shipping: 0, profit: 0 }
        seasonMap.set(season, {
          gross: prev.gross + g,
          net: prev.net + n,
          cost: prev.cost + lineCost,
          shipping: prev.shipping + lineShipping,
          profit: prev.profit + (n - lineCost - lineShipping),
        })

        // 판매수량 집계 — 환불/취소(매출 0 이하) 행은 제외, 무신사는 qty 컬럼, 나머지 채널은 라인 1건 = 1장
        if (g > 0) {
          const soldQty = c.shipping === 'qty-tiered' ? (row.qty || 0) : 1
          if (soldQty > 0) {
            const displayItem = (row.item_name || '').trim() || (row.style_no || '').trim() || '(상품명 없음)'
            const displayOption = (row.option_name || '').trim() || '-'
            const key = `${displayItem.toUpperCase()}__${displayOption.toUpperCase()}`
            if (!detailMap.has(season)) detailMap.set(season, new Map())
            const m = detailMap.get(season)!
            const prevD = m.get(key)
            if (prevD) prevD.qty += soldQty
            else m.set(key, { item: displayItem, option: displayOption, qty: soldQty })
          }
        }
      })
    }))

    setChannelSummarySeasonData(
      Array.from(seasonMap.entries())
        .filter(([season]) => season !== '미지정')
        .map(([season, v]) => ({ season, ...v }))
        .sort((a, b) => seasonSortValue(b.season) - seasonSortValue(a.season))
    )
    const detailObj: Record<string, { item: string; option: string; qty: number }[]> = {}
    detailMap.forEach((m, season) => {
      detailObj[season] = Array.from(m.values()).sort((a, b) => a.item.localeCompare(b.item, 'ko') || a.option.localeCompare(b.option, 'ko'))
    })
    setSeasonSalesDetail(detailObj)
    setSeasonUnmatched({ gross: unmatchedGross, count: unmatchedCount })
    setChannelSummarySeasonIdx(0)
    setChannelSummarySeasonLoading(false)
  }

  // 재고 현황 — "통합 재고 수동 제어판"과 완전히 동일한 계산식으로 연동
  // (inventory_summary 뷰의 available_qty는 리오더/시딩/협찬을 반영 못 하므로, 제어판처럼
  //  제작수량 + 리오더 합계 - 총판매 - 시딩 - 협찬(미회수) - 수선불가 로 직접 재계산)
  async function loadInventoryTotals() {
    const [{ data: items }, { data: reorders }, { data: seedingRecords }] = await Promise.all([
      supabase.from('inventory_summary').select('id, sku, initial_qty, total_sold, damaged_qty, cost_price'),
      supabase.from('reorders').select('item_id, qty'),
      supabase.from('seeding_records').select('item_id, type, qty, returned_qty'),
    ])

    const reorderTotalByItem = new Map<number, number>()
    ;(reorders || []).forEach((r: any) => {
      reorderTotalByItem.set(r.item_id, (reorderTotalByItem.get(r.item_id) || 0) + (r.qty || 0))
    })
    const seedingTotalByItem = new Map<number, number>()
    const sponsorshipOutstandingByItem = new Map<number, number>()
    ;(seedingRecords || []).forEach((r: any) => {
      if (r.type === '시딩') {
        seedingTotalByItem.set(r.item_id, (seedingTotalByItem.get(r.item_id) || 0) + (r.qty || 0))
      } else if (r.type === '협찬') {
        sponsorshipOutstandingByItem.set(r.item_id, (sponsorshipOutstandingByItem.get(r.item_id) || 0) + ((r.qty || 0) - (r.returned_qty || 0)))
      }
    })

    const rows = items || []
    let totalQty = 0
    let totalValue = 0
    rows.forEach((item: any) => {
      const available = (item.initial_qty || 0)
        + (reorderTotalByItem.get(item.id) || 0)
        - (item.total_sold || 0)
        - (seedingTotalByItem.get(item.id) || 0)
        - (sponsorshipOutstandingByItem.get(item.id) || 0)
        - (item.damaged_qty || 0)
      totalQty += available
      totalValue += available * (item.cost_price || 0)
    })

    // "재고 SKU"는 옵션(사이즈)별 행 개수가 아니라 고유 스타일넘버(sku) 개수로 집계
    const uniqueSkuCount = new Set(rows.map((r: any) => r.sku).filter(Boolean)).size
    setInvSkuCount(uniqueSkuCount)
    setInvTotalQty(totalQty)
    setInvTotalValue(totalValue)
  }

  // {연도}년 월별 매출/판매수량 차트 — salesChartYear(및 전년도)의 채널별 매출·순매출·판매수량을 불러옴
  async function loadSalesChartData(targetYear: number) {
    setSalesChartLoading(true)
    const [cur, prev, qty, prevQty] = await Promise.all([
      loadAllChannelsForYear(targetYear),
      loadAllChannelsForYear(targetYear - 1),
      loadMonthlyQtyForYear(targetYear),
      loadMonthlyQtyForYear(targetYear - 1),
    ])
    setSalesChartCur(cur)
    setSalesChartPrev(prev)
    setSalesChartQty(qty)
    setSalesChartPrevQty(prevQty)
    setSalesChartLoading(false)
  }
  function shiftSalesChartYear(delta: number) { setSalesChartYear(y => y + delta) }
  // 플랫폼별 매출 비중 — '연도'/'월별' 모드일 때만 pieYear의 채널별 매출을 따로 조회 ('전체'는 기존 channelTotals 재사용)
  useEffect(() => { if (pieMode !== 'all') loadPieData(pieYear) }, [pieMode, pieYear])

  async function loadPieData(targetYear: number) {
    setPieDataLoading(true)
    const data = await loadAllChannelsForYear(targetYear)
    setPieChannelData(data)
    setPieDataLoading(false)
  }

  // "총매출" 버튼 — 연도 구분 없이 전 채널 정산 테이블을 통째로 조회해 전체 누적 매출/순매출/순수익과
  // 시즌별(품목의 items.season 매칭) 매출·순수익을 함께 집계. 데이터량이 많을 수 있어 팝업을 열 때 한 번만 로드.
  async function openTotalModal() {
    setShowTotalModal(true)
    // 통합 재고 수동 제어판에서 시즌을 다시 지정했을 수 있으므로 열 때마다 items 테이블을 새로 조회
    setTotalModalLoading(true)

    const { data: catItems } = await supabase.from('items').select('sku, name, option_name, season')
    const bySkuOption = new Map<string, string>()
    const byNameOption = new Map<string, string>()
    // 옵션명이 달라 매칭이 안 되는 경우를 대비한 폴백 — 스타일넘버/상품명만으로도 매칭
    const bySkuOnly = new Map<string, string>()
    const byNameOnly = new Map<string, string>()
    ;(catItems || []).forEach((it: any) => {
      const season = it.season || '미지정'
      if (season === '미지정') return
      const skuKey = String(it.sku || '').trim().toUpperCase()
      const nameKey = String(it.name || '').trim().toUpperCase()
      const optionKey = String(it.option_name || '').trim().toUpperCase()
      if (skuKey) {
        bySkuOption.set(`${skuKey}__${optionKey}`, season)
        bySkuOnly.set(skuKey, season)
      }
      if (nameKey) {
        byNameOption.set(`${nameKey}__${optionKey}`, season)
        byNameOnly.set(nameKey, season)
      }
    })

    let gross = 0, net = 0, cost = 0, shipping = 0
    const seasonMap = new Map<string, { gross: number; net: number; profit: number }>()

    await Promise.all(CHANNELS.map(async (c) => {
      const { data } = await supabase.from(c.table).select(selectColsForFull(c)).eq('channel', c.name)
      ;(data || []).forEach((row: any) => {
        const raw = row[c.dateCol]
        const g = row[c.grossCol] || 0
        const n = computeLineNet(c, row, g)
        const lineCost = row.matched_cost || 0
        let lineShipping = 0
        if (c.shipping === 'qty-tiered') lineShipping = (row.qty || 0) * shippingRateFor(String(raw))
        else if (c.shipping === 'row-tiered') lineShipping = shippingRateFor(String(raw))
        else if (c.shipping === 'row-flat') lineShipping = 2990

        gross += g
        net += n
        cost += lineCost
        shipping += lineShipping

        const styleNo = (row.style_no || '').trim().toUpperCase()
        const optionName = (row.option_name || '').trim().toUpperCase()
        const itemName = (row.item_name || '').trim().toUpperCase()
        const season = (styleNo && bySkuOption.get(`${styleNo}__${optionName}`))
          || (itemName && byNameOption.get(`${itemName}__${optionName}`))
          || (styleNo && bySkuOnly.get(styleNo))
          || (itemName && byNameOnly.get(itemName))
          || '미지정'
        const prev = seasonMap.get(season) || { gross: 0, net: 0, profit: 0 }
        seasonMap.set(season, { gross: prev.gross + g, net: prev.net + n, profit: prev.profit + (n - lineCost - lineShipping) })
      })
    }))

    // 무신사 "날짜 없는 기간 요약 항목"(반품비결제 등, 전체 기간) 차감
    const { data: extraRows } = await supabase
      .from('musinsa_settlement_extra_fees')
      .select('return_fee_settle, claim_return_fee, shipping_fee_settle, review_boost_extra, mfs_logistics_extra, low_price_shipping_support')
      .eq('channel', '무신사')
    const extraTotal = (extraRows || []).reduce((s: number, r: any) =>
      s + (r.return_fee_settle || 0) + (r.claim_return_fee || 0) + (r.shipping_fee_settle || 0) + (r.review_boost_extra || 0) + (r.mfs_logistics_extra || 0) + (r.low_price_shipping_support || 0), 0)
    net -= extraTotal

    // 무신사 전체 누적 충전 광고비
    const { data: adChargeRows } = await supabase.from('musinsa_ad_charge').select('charged_amount').eq('channel', '무신사')
    const adCharge = (adChargeRows || []).reduce((s: number, r: any) => s + (r.charged_amount || 0), 0)

    const profit = net - cost - shipping - adCharge
    setTotalSummary({ gross, net, cost, shipping, adCharge, profit })
    setSeasonSummary(
      Array.from(seasonMap.entries())
        .filter(([season]) => season !== '미지정')
        .map(([season, v]) => ({ season, ...v }))
        .sort((a, b) => seasonSortValue(b.season) - seasonSortValue(a.season))
    )
    setTotalModalLoaded(true)
    setTotalModalLoading(false)
  }

  function prevPiePeriod() {
    if (pieMode === 'year') { setPieYear(y => y - 1); return }
    if (pieMonth === 1) { setPieYear(y => y - 1); setPieMonth(12) }
    else setPieMonth(m => m - 1)
  }
  function nextPiePeriod() {
    if (pieMode === 'year') { setPieYear(y => y + 1); return }
    if (pieMonth === 12) { setPieYear(y => y + 1); setPieMonth(1) }
    else setPieMonth(m => m + 1)
  }
  // 이번달(selYear/selMonth) KPI — 월 이동 버튼을 누를 때마다 바로 재계산되도록 별도 effect로 분리
  // (예전엔 loadData()가 [year]에만 반응해서 월만 옮기면 값이 그대로 멈춰있던 버그를 수정)
  useEffect(() => { updateMonthKpi() }, [selYear, selMonth, year, curChannelData, prevChannelData, curAdChargeArr, prevAdChargeArr])

  // 플랫폼별 월 매출 현황 차트 전용 — chartYear(및 그 전년도)의 채널별 매출을 따로 불러옴
  // (상단 year 선택과 별개로 이 차트만 이동할 수 있어서 loadData()와는 독립적으로 조회)
  async function loadChartComparisonData(targetYear: number) {
    setChartDataLoading(true)
    const [cur, prev] = await Promise.all([
      loadAllChannelsForYear(targetYear),
      loadAllChannelsForYear(targetYear - 1),
    ])
    setChartChannelCur(cur)
    setChartChannelPrev(prev)
    setChartDataLoading(false)
  }

  async function loadData() {
    setLoading(true)

    // 플랫폼별 매출·원가·택배비·순매출액 — 자사몰(카페24)부터 무신사/WOO/REKET/클라만까지 전 채널을
    // 각자의 정산 테이블에서 각 채널 페이지와 동일한 수수료 공식으로 직접 집계
    // (데이터가 아직 없는 채널은 0원으로 표시됨)
    const [curResults, prevResults] = await Promise.all([
      loadAllChannelsForYear(year),
      loadAllChannelsForYear(year - 1),
    ])
    setCurChannelData(curResults)
    setPrevChannelData(prevResults)
    const newMonthlySales = buildChannelRows(year, curResults)
    setMonthlySales(newMonthlySales)

    // 충전 광고비 — 현재는 무신사만 기록 (musinsa_ad_charge, 무신사가 매달 무료 지급하는 10만원 제외한 실 충전액)
    const [adChargeByMonth, prevAdChargeByMonth] = await Promise.all([
      loadMusinsaAdChargeByMonth(year),
      loadMusinsaAdChargeByMonth(year - 1),
    ])
    setCurAdChargeArr(adChargeByMonth)
    setPrevAdChargeArr(prevAdChargeByMonth)

    // 연간 KPI 집계 (순매출액은 각 채널의 실제 수수료 공식으로 계산된 net을 그대로 합산)
    const curAgg = aggregateChannels(curResults)
    const prevAgg = aggregateChannels(prevResults)
    const curAdCharge = sumArr(adChargeByMonth)
    const prevAdCharge = sumArr(prevAdChargeByMonth)
    const curProfit = curAgg.net - curAgg.cost - curAgg.shipping - curAdCharge
    const prevProfit = prevAgg.net - prevAgg.cost - prevAgg.shipping - prevAdCharge
    setAnnualKpi({
      gross: curAgg.gross, fee: curAgg.fee, net: curAgg.net, cost: curAgg.cost, shipping: curAgg.shipping,
      adCharge: curAdCharge, profit: curProfit,
      prevGross: prevAgg.gross, prevNet: prevAgg.net, prevProfit,
    })

    setLoading(false)
  }

  // 이번달(selYear/selMonth) KPI 재계산 — selYear가 상단에서 조회 중인 year와 같으면 이미 불러온
  // curChannelData/prevChannelData를 그대로 재사용하고, 다르면 그 해만 별도로 조회
  async function updateMonthKpi() {
    const mIdx = selMonth - 1
    let selCur = curChannelData
    let selPrev = prevChannelData
    let selAdChargeByMonth = curAdChargeArr
    let selPrevAdChargeByMonth = prevAdChargeArr
    if (selYear !== year) {
      const [sc, sp, sa, spa] = await Promise.all([
        loadAllChannelsForYear(selYear),
        loadAllChannelsForYear(selYear - 1),
        loadMusinsaAdChargeByMonth(selYear),
        loadMusinsaAdChargeByMonth(selYear - 1),
      ])
      selCur = sc; selPrev = sp; selAdChargeByMonth = sa; selPrevAdChargeByMonth = spa
    }

    const newThisMonthSales: ChannelMonthRow[] = CHANNELS.map((c, ci) => {
      const gross = selCur[ci]?.gross[mIdx] || 0
      const net = selCur[ci]?.net[mIdx] || 0
      return { channel: c.label, color: c.color, month: thisMonthStart, gross, fees: gross - net, net }
    })
    setThisMonthSales(newThisMonthSales)

    const mAgg = aggregateChannels(selCur, mIdx)
    const mPrevAgg = aggregateChannels(selPrev, mIdx)
    const mAdCharge = selAdChargeByMonth[mIdx] || 0
    const mPrevAdCharge = selPrevAdChargeByMonth[mIdx] || 0
    const mProfit = mAgg.net - mAgg.cost - mAgg.shipping - mAdCharge
    const mPrevProfit = mPrevAgg.net - mPrevAgg.cost - mPrevAgg.shipping - mPrevAdCharge
    setMonthKpi({
      gross: mAgg.gross, fee: mAgg.fee, net: mAgg.net, cost: mAgg.cost, shipping: mAgg.shipping,
      adCharge: mAdCharge, profit: mProfit,
      prevGross: mPrevAgg.gross, prevNet: mPrevAgg.net, prevProfit: mPrevProfit,
    })
  }

  const totalGross   = monthlySales.reduce((s, r) => s + (r.gross || 0), 0)

  // YoY(%) 계산 헬퍼 — 전년(동월) 값이 0이면 비교 불가로 null 처리
  function yoyPct(cur: number, prev: number): number | null {
    return prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null
  }
  const grossYoyPct   = yoyPct(annualKpi.gross, annualKpi.prevGross)
  const netYoyPct     = yoyPct(annualKpi.net, annualKpi.prevNet)
  const profitYoyPct  = yoyPct(annualKpi.profit, annualKpi.prevProfit)
  const mGrossYoyPct  = yoyPct(monthKpi.gross, monthKpi.prevGross)
  const mNetYoyPct    = yoyPct(monthKpi.net, monthKpi.prevNet)
  const mProfitYoyPct = yoyPct(monthKpi.profit, monthKpi.prevProfit)

  // 순수익 카드용 구성비 (총매출액 대비 %)
  const costPct    = annualKpi.gross > 0 ? Math.round((annualKpi.cost / annualKpi.gross) * 1000) / 10 : 0
  const shippingPct = annualKpi.gross > 0 ? Math.round((annualKpi.shipping / annualKpi.gross) * 1000) / 10 : 0
  const adChargePct = annualKpi.gross > 0 ? Math.round((annualKpi.adCharge / annualKpi.gross) * 1000) / 10 : 0
  const feePct      = annualKpi.gross > 0 ? Math.round((annualKpi.fee / annualKpi.gross) * 1000) / 10 : 0
  const mCostPct    = monthKpi.gross > 0 ? Math.round((monthKpi.cost / monthKpi.gross) * 1000) / 10 : 0
  const mShippingPct = monthKpi.gross > 0 ? Math.round((monthKpi.shipping / monthKpi.gross) * 1000) / 10 : 0
  const mAdChargePct = monthKpi.gross > 0 ? Math.round((monthKpi.adCharge / monthKpi.gross) * 1000) / 10 : 0
  const mFeePct      = monthKpi.gross > 0 ? Math.round((monthKpi.fee / monthKpi.gross) * 1000) / 10 : 0

  const channelTotals = Object.values(
    monthlySales.reduce((acc, r) => {
      if (!acc[r.channel]) acc[r.channel] = { channel: r.channel, gross: 0, fees: 0, net: 0, color: r.color || '#888' }
      acc[r.channel].gross += r.gross || 0
      acc[r.channel].fees  += r.fees || 0
      acc[r.channel].net   += r.net || 0
      return acc
    }, {} as Record<string, { channel: string; gross: number; fees: number; net: number; color: string }>)
  )

  // 채널별 매출요약 표 전용 — channelSummaryYear(기본값: 올해) 기준 채널별 합계 (상단 year와 무관), 연도/월별 전환 가능
  // 총매출액/수수료/순매출액/순수익(원가·택배비 반영)까지 함께 계산
  const channelSummaryMonthIdx = channelSummaryMonth - 1
  const channelSummaryTotals = CHANNELS.map(c => {
    const ci = CHANNELS.indexOf(c)
    const d = channelSummaryData[ci]
    const gross = channelSummaryMode === 'year' ? sumArr(d?.gross || []) : (d?.gross[channelSummaryMonthIdx] || 0)
    const net = channelSummaryMode === 'year' ? sumArr(d?.net || []) : (d?.net[channelSummaryMonthIdx] || 0)
    const cost = channelSummaryMode === 'year' ? sumArr(d?.cost || []) : (d?.cost[channelSummaryMonthIdx] || 0)
    const shipping = channelSummaryMode === 'year' ? sumArr(d?.shipping || []) : (d?.shipping[channelSummaryMonthIdx] || 0)
    return { channel: c.label, color: c.color, gross, fees: gross - net, net, cost, shipping, profit: net - cost - shipping }
  })
  const channelSummaryTotalGross = channelSummaryTotals.reduce((s, c) => s + (c.gross || 0), 0)

  const chartMonthStr = String(chartMonth).padStart(2,'0')

  // 선택 달(또는 연도 전체)의 채널별 매출액 / 순매출액 / 전년도 매출액 (플랫폼별 월 매출 현황 차트 전용)
  const platformMonthlyChartData = CHANNELS.map((c, ci) => {
    const grossArr = chartChannelCur[ci]?.gross || []
    const netArr = chartChannelCur[ci]?.net || []
    const prevGrossArr = chartChannelPrev[ci]?.gross || []
    const gross = platformChartMode === 'year' ? sumArr(grossArr) : (grossArr[chartMonth - 1] || 0)
    const net = platformChartMode === 'year' ? sumArr(netArr) : (netArr[chartMonth - 1] || 0)
    const prevGross = platformChartMode === 'year' ? sumArr(prevGrossArr) : (prevGrossArr[chartMonth - 1] || 0)
    return { channel: c.label, color: c.color, 매출액: gross, 순매출액: net, 전년도매출액: prevGross }
  }).sort((a, b) => b.매출액 - a.매출액)
  const platformMonthlyHasData = platformMonthlyChartData.some(d => d.매출액 > 0 || d.전년도매출액 > 0)

  // {연도}년 월별 매출/판매수량 — 12개월 전체 추이 (자사몰·무신사 페이지의 월별 매출/판매수량 그래프와 동일한 구성)
  const monthlySalesChartData = MONTH_LABELS.map((label, i) => {
    const agg = aggregateChannels(salesChartCur, i)
    const prevAgg = aggregateChannels(salesChartPrev, i)
    return { name: label, 매출: agg.gross, 순매출액: agg.net, 작년순매출액: prevAgg.net }
  })
  const salesChartMonthlyGross = MONTH_LABELS.map((_, i) => aggregateChannels(salesChartCur, i).gross)
  const salesChartPrevMonthlyGross = MONTH_LABELS.map((_, i) => aggregateChannels(salesChartPrev, i).gross)
  const salesChartHasData = monthlySalesChartData.some(d => d.매출 > 0)
  const salesChartHasPrevYearData = monthlySalesChartData.some(d => d.작년순매출액 > 0)
  const qtyChartData = MONTH_LABELS.map((label, i) => ({ name: label, 판매수량: salesChartQty[i], 작년판매수량: salesChartPrevQty[i] }))

  const WEEKDAY_LABELS = ['일', '월', '화', '수', '목', '금', '토']

  // 판매 추이 — trendMode에 따라 trendDailyMap을 일간/주간/월간 단위로 재집계
  // (일간·주간은 매출이 없는 날/주도 0으로 채워서 빠짐없이 표시)
  const trendChartData = (() => {
    if (trendMode === 'daily') {
      const start = mondayOfDateStr(trendWeekAnchor)
      const days = []
      for (let i = 0; i < 7; i++) {
        const d = new Date(start); d.setDate(start.getDate() + i)
        const key = d.toISOString().slice(0, 10)
        const v = trendDailyMap[key] || { gross: 0, net: 0 }
        days.push({ name: `${fmtDateShort(d)}(${WEEKDAY_LABELS[d.getDay()]})`, 매출: v.gross, 순매출액: v.net })
      }
      return days
    }
    if (trendMode === 'weekly') {
      const [my, mm] = trendMonthAnchor.split('-').map(Number)
      const monthEnd = new Date(my, mm, 0)
      const today = new Date()
      const end = monthEnd < today ? monthEnd : today
      const endMonday = mondayOfDate(end)
      const weeks = []
      for (let i = 11; i >= 0; i--) {
        const wkStart = new Date(endMonday); wkStart.setDate(endMonday.getDate() - 7 * i)
        let gross = 0, net = 0
        for (let d = 0; d < 7; d++) {
          const dd = new Date(wkStart); dd.setDate(wkStart.getDate() + d)
          const v = trendDailyMap[dd.toISOString().slice(0, 10)]
          if (v) { gross += v.gross; net += v.net }
        }
        weeks.push({ name: fmtDateShort(wkStart), 매출: gross, 순매출액: net })
      }
      return weeks
    }
    const entries = Object.entries(trendDailyMap).sort((a, b) => a[0].localeCompare(b[0]))
    const buckets: Record<string, { gross: number; net: number }> = {}
    entries.forEach(([date, v]) => {
      const key = date.slice(0, 7)
      if (!buckets[key]) buckets[key] = { gross: 0, net: 0 }
      buckets[key].gross += v.gross
      buckets[key].net += v.net
    })
    return Object.entries(buckets).sort((a, b) => a[0].localeCompare(b[0])).map(([mo, v]) => ({ name: mo, 매출: v.gross, 순매출액: v.net }))
  })()
  const trendHasData = trendChartData.some(d => d.매출 > 0)
  const trendWeekLabel = (() => {
    const start = mondayOfDateStr(trendWeekAnchor)
    const end = new Date(start); end.setDate(start.getDate() + 6)
    return `${fmtDateShort(start)} ~ ${fmtDateShort(end)}`
  })()

  function shiftTrendWeek(delta: number) {
    const d = mondayOfDateStr(trendWeekAnchor)
    d.setDate(d.getDate() + 7 * delta)
    setTrendWeekAnchor(d.toISOString().slice(0, 10))
  }

  const pieMonthStr = String(pieMonth).padStart(2, '0')
  // 플랫폼별 매출 비중 데이터 — 전체(현재 채널별 매출 요약 누적) / 특정 연도 누적 / 특정 월
  const pieChartData = pieMode === 'all'
    ? channelTotals
    : CHANNELS.map((c, ci) => {
        const arr = pieChannelData[ci]?.gross || new Array(12).fill(0)
        const gross = pieMode === 'year' ? sumArr(arr) : (arr[pieMonth - 1] || 0)
        return { channel: c.label, color: c.color, gross }
      }).filter(d => d.gross > 0)

  function prevChartMonth() {
    if (platformChartMode === 'year') { setChartYear(y => y - 1); return }
    if (chartMonth === 1) { setChartYear(y => y - 1); setChartMonth(12) }
    else setChartMonth(m => m - 1)
  }
  function nextChartMonth() {
    if (platformChartMode === 'year') { setChartYear(y => y + 1); return }
    if (chartMonth === 12) { setChartYear(y => y + 1); setChartMonth(1) }
    else setChartMonth(m => m + 1)
  }

  function prevChannelSummaryPeriod() {
    if (channelSummaryMode === 'year') { setChannelSummaryYear(y => y - 1); return }
    if (channelSummaryMonth === 1) { setChannelSummaryYear(y => y - 1); setChannelSummaryMonth(12) }
    else setChannelSummaryMonth(m => m - 1)
  }
  function nextChannelSummaryPeriod() {
    if (channelSummaryMode === 'year') { setChannelSummaryYear(y => y + 1); return }
    if (channelSummaryMonth === 12) { setChannelSummaryYear(y => y + 1); setChannelSummaryMonth(1) }
    else setChannelSummaryMonth(m => m + 1)
  }

  // 광고 성과지표 파생값 — 연간(adYear 전체) / 선택한 달(adMonth) 합계, ROAS·ACOS·TACOS까지
  const adTotalCost = adMonthlyCost.reduce((s, v) => s + v, 0)
  const adTotalRevenue = adMonthlyRevenue.reduce((s, v) => s + v, 0)
  const adTotalGross = adMonthlyGross.reduce((s, v) => s + v, 0)
  const adTotalCharge = adMonthlyCharge.reduce((s, v) => s + v, 0)
  const adTotalRoas = adTotalCost > 0 ? Math.round((adTotalRevenue / adTotalCost) * 1000) / 10 : null
  const adTotalAcos = adTotalRevenue > 0 ? Math.round((adTotalCost / adTotalRevenue) * 1000) / 10 : null
  const adTotalTacos = adTotalGross > 0 ? Math.round((adTotalCost / adTotalGross) * 1000) / 10 : null

  const adMonthIdx = adMonth - 1
  const adMonthCost = adMonthlyCost[adMonthIdx] || 0
  const adMonthRevenue = adMonthlyRevenue[adMonthIdx] || 0
  const adMonthGross = adMonthlyGross[adMonthIdx] || 0
  const adMonthCharge = adMonthlyCharge[adMonthIdx] || 0
  const adMonthRoas = adMonthCost > 0 ? Math.round((adMonthRevenue / adMonthCost) * 1000) / 10 : null
  const adMonthAcos = adMonthRevenue > 0 ? Math.round((adMonthCost / adMonthRevenue) * 1000) / 10 : null
  const adMonthTacos = adMonthGross > 0 ? Math.round((adMonthCost / adMonthGross) * 1000) / 10 : null
  const adMonthStr = String(adMonth).padStart(2, '0')

  const adMonthlyChartData = MONTH_LABELS.map((label, i) => {
    const cost = adMonthlyCost[i]
    const revenue = adMonthlyRevenue[i]
    const gross = adMonthlyGross[i]
    const charge = adMonthlyCharge[i]
    return {
      name: label,
      광고비: cost,
      전환매출: revenue,
      충전광고비: charge,
      ROAS: cost > 0 ? Math.round((revenue / cost) * 1000) / 10 : 0,
      ACOS: revenue > 0 ? Math.round((cost / revenue) * 1000) / 10 : 0,
      TACOS: gross > 0 ? Math.round((cost / gross) * 1000) / 10 : 0,
    }
  })

  // AI 추천 인사이트 (규칙 기반) — 각 채널 페이지의 인사이트 생성 방식과 동일한 패턴
  function generateInsights() {
    const sales: string[] = []
    const channels: string[] = []

    if (grossYoyPct !== null) {
      if (grossYoyPct >= 10) sales.push(`${year}년 총매출이 전년 대비 ${grossYoyPct}% 성장했어요. 잘 되는 채널 위주로 재고를 넉넉히 준비해보세요.`)
      else if (grossYoyPct <= -10) sales.push(`${year}년 총매출이 전년 대비 ${grossYoyPct}% 감소했어요. 급감한 채널이나 시기가 있는지 확인해보세요.`)
      else sales.push(`${year}년 총매출은 전년 대비 ${grossYoyPct >= 0 ? '+' : ''}${grossYoyPct}%로 큰 변화 없이 유지되고 있어요.`)
    }
    const marginRate = annualKpi.gross > 0 ? Math.round((annualKpi.profit / annualKpi.gross) * 1000) / 10 : null
    if (marginRate !== null) {
      if (marginRate < 15) sales.push(`전체 공헌이익률이 ${marginRate}%로 위험 구간(15% 미만)이에요. 원가·수수료·광고비 구조를 바로 점검해야 해요.`)
      else if (marginRate < 20) sales.push(`전체 공헌이익률이 ${marginRate}%로 주의 구간이에요. 원가 비중이 높은 채널이 있는지 점검해보세요.`)
      else if (marginRate < 30) sales.push(`전체 공헌이익률이 ${marginRate}%예요. 30% 이상이 안정권으로 보는 경우가 많아요.`)
      else sales.push(`전체 공헌이익률이 ${marginRate}%로 안정권이에요. 지금의 구조를 유지하면서 매출 규모를 키우는 데 집중해도 좋아요.`)
    }

    const activeChannels = (channelTotals as any[]).filter(c => c.gross > 0)
    if (activeChannels.length > 0) {
      const top = [...activeChannels].sort((a, b) => b.gross - a.gross)[0]
      const topShare = totalGross > 0 ? Math.round((top.gross / totalGross) * 100) : 0
      channels.push(`"${top.channel}" 채널이 전체 매출의 ${topShare}%를 차지하는 주력 채널이에요.`)
    }
    const inactiveChannels = (channelTotals as any[]).filter(c => c.gross === 0).map(c => c.channel)
    if (inactiveChannels.length > 0) {
      channels.push(`${inactiveChannels.join(', ')} 채널은 아직 매출 데이터가 없어요. 해당 채널 페이지에서 정산 데이터를 업로드하면 여기에도 반영돼요.`)
    }

    return { sales, channels }
  }

  return (
    <div>
      {/* 헤더 */}
      <div className="page-header">
        <div>
          <h2 className="page-title">브랜드 통합 경영 대시보드</h2>
          <p className="page-sub">모든 플랫폼 매출, 통합 재고 현황 요약</p>
        </div>
      </div>

      {loading ? (
        <div className="loading">데이터 로딩 중...</div>
      ) : (
        <>
          {/* AI 추천 인사이트 (맨 위, 기본 접힘) */}
          {(() => {
            const insights = generateInsights()
            const groups = [
              { title: '📈 매출 현황', items: insights.sales, color: '#4f46e5' },
              { title: '📊 채널별 피드백', items: insights.channels, color: '#059669' },
            ]
            return (
              <div style={{ background: 'linear-gradient(135deg, #eff6ff 0%, #f0fdf4 100%)', border: '1px solid #94a3b8', borderRadius: 16, padding: insightsExpanded ? 24 : '12px 20px', marginBottom: 24 }}>
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
                      {year}년 채널 데이터를 바탕으로 자동 생성된 참고용 피드백이에요
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
                  </>
                )}
              </div>
            )
          })()}

          {/* 연도 이동 + 총매출 팝업 */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 6, marginBottom: 12 }}>
            <button onClick={() => setYear(y => y - 1)} style={yearBtnStyle}>◀</button>
            <span style={{ fontWeight: 700, fontSize: 15, minWidth: 60, textAlign: 'center' }}>{year}년</span>
            <button onClick={() => setYear(y => y + 1)} style={yearBtnStyle}>▶</button>
            <button onClick={openTotalModal} style={{ ...yearBtnStyle, marginLeft: 6, background: '#0f172a', color: '#fff', border: '1px solid #0f172a' }}>총매출</button>
          </div>

          {/* KPI 3개 */}
          <div className="kpi-grid" style={{ gridTemplateColumns: 'repeat(3,1fr)' }}>
            <div className="kpi-card" style={{ border: '1px solid #94a3b8' }}>
              <div className="kpi-label" style={{ fontSize: 15, color: '#000', fontWeight: 700 }}>{year}년 총 매출액 (GROSS)</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span className="kpi-value" style={{ color: '#000', fontSize: 25 }}>{formatWon(annualKpi.gross)}</span>
                {grossYoyPct !== null && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: grossYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                    ({grossYoyPct >= 0 ? '+' : ''}{grossYoyPct}%)
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>전년도 매출액 {formatWon(annualKpi.prevGross)}</div>
              <div className="kpi-sub">전 채널 결제 완료 합산</div>
            </div>
            <div className="kpi-card" style={{ border: '1px solid #94a3b8' }}>
              <div className="kpi-label" style={{ fontSize: 15, color: '#000', fontWeight: 700 }}>순매출액 (수수료 제외)</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span className="kpi-value" style={{ color: '#2563eb', fontSize: 25 }}>{formatWon(annualKpi.net)}</span>
                {netYoyPct !== null && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: netYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                    ({netYoyPct >= 0 ? '+' : ''}{netYoyPct}%)
                  </span>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>전년도 순매출액 {formatWon(annualKpi.prevNet)}</div>
              <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ fontSize: 12, color: '#e11d48', fontWeight: 700 }}>- {formatWon(annualKpi.fee)}</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>수수료</span>
              </div>
            </div>
            <div className="kpi-card" style={{ border: '1px solid #94a3b8' }}>
              <div className="kpi-label" style={{ fontSize: 15, color: '#000', fontWeight: 700 }}>순수익</div>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                <span className="kpi-value" style={{ color: annualKpi.profit >= 0 ? '#059669' : '#e11d48', fontSize: 25 }}>{formatWon(annualKpi.profit)}</span>
                {annualKpi.gross > 0 && (
                  <span style={{ fontSize: 13, fontWeight: 700, color: annualKpi.profit >= 0 ? '#059669' : '#e11d48' }}>
                    ({Math.round((annualKpi.profit / annualKpi.gross) * 1000) / 10}%)
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                <span style={{ fontSize: 12, color: '#64748b', fontWeight: 700 }}>- {formatWon(annualKpi.cost + annualKpi.shipping)}</span>
                <span style={{ fontSize: 11, color: '#94a3b8' }}>원가+택배비</span>
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
                {year - 1}년 순수익 {formatWon(annualKpi.prevProfit)}
                {profitYoyPct !== null && (
                  <span style={{ fontWeight: 700, color: profitYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                    {' '}(전년대비 {profitYoyPct >= 0 ? '+' : ''}{profitYoyPct}%)
                  </span>
                )}
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
                원가 {formatWon(annualKpi.cost)} · 택배비 {formatWon(annualKpi.shipping)}{annualKpi.adCharge > 0 ? ` · 충전 광고비 ${formatWon(annualKpi.adCharge)}` : ''}
              </div>
              <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
                원가 {costPct}% · 택배비 {shippingPct}% · 광고비 {adChargePct}% · 수수료 {feePct}%
              </div>
              <div style={{ fontSize: 10, color: '#dc2626', fontWeight: 400, marginTop: 6 }}>공헌이익률 15% 미만 위험 · 20% 미만 주의 · 30%↑ 안정권</div>
            </div>
          </div>

          {/* 이번달 KPI */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#64748b' }}>
                {selYear}년 {selMonth}월 매출
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button onClick={prevMonth} style={monthBtnStyle}>◀</button>
                <span style={{ fontSize: 13, fontWeight: 700, minWidth: 70, textAlign: 'center' }}>{selYear}.{selMonthStr}</span>
                <button onClick={nextMonth} style={monthBtnStyle}>▶</button>
              </div>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
              <div style={{ background: '#fafafa', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
                <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 8 }}>{selYear % 100}.{selMonthStr} 매출액</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 22, fontWeight: 800, color: '#000' }}>{formatWon(monthKpi.gross)}</span>
                  {mGrossYoyPct !== null && (
                    <span style={{ fontSize: 12, fontWeight: 700, color: mGrossYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                      ({mGrossYoyPct >= 0 ? '+' : ''}{mGrossYoyPct}%)
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>전년동월 매출액 {formatWon(monthKpi.prevGross)}</div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>결제 완료 총액</div>
              </div>
              <div style={{ background: '#fafafa', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
                <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 8 }}>{selYear % 100}.{selMonthStr} 순매출액 (수수료 제외)</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 22, fontWeight: 800, color: '#2563eb' }}>{formatWon(monthKpi.net)}</span>
                  {mNetYoyPct !== null && (
                    <span style={{ fontSize: 12, fontWeight: 700, color: mNetYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                      ({mNetYoyPct >= 0 ? '+' : ''}{mNetYoyPct}%)
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>전년동월 순매출액 {formatWon(monthKpi.prevNet)}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4 }}>
                  <span style={{ fontSize: 12, color: '#e11d48', fontWeight: 700 }}>- {formatWon(monthKpi.fee)}</span>
                  <span style={{ fontSize: 11, color: '#94a3b8' }}>수수료</span>
                </div>
              </div>
              <div style={{ background: '#fafafa', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
                <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 8 }}>{selYear % 100}.{selMonthStr} 순수익</div>
                <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                  <span style={{ fontSize: 22, fontWeight: 800, color: monthKpi.profit >= 0 ? '#059669' : '#e11d48' }}>{formatWon(monthKpi.profit)}</span>
                  {monthKpi.gross > 0 && (
                    <span style={{ fontSize: 12, fontWeight: 700, color: monthKpi.profit >= 0 ? '#059669' : '#e11d48' }}>
                      ({Math.round((monthKpi.profit / monthKpi.gross) * 1000) / 10}%)
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
                  전년동월 순수익 {formatWon(monthKpi.prevProfit)}
                  {mProfitYoyPct !== null && (
                    <span style={{ fontWeight: 700, color: mProfitYoyPct >= 0 ? '#059669' : '#e11d48' }}>
                      {' '}(전년대비 {mProfitYoyPct >= 0 ? '+' : ''}{mProfitYoyPct}%)
                    </span>
                  )}
                </div>
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
                  원가 {formatWon(monthKpi.cost)} · 택배비 {formatWon(monthKpi.shipping)}{monthKpi.adCharge > 0 ? ` · 충전 광고비 ${formatWon(monthKpi.adCharge)}` : ''}
                </div>
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 4 }}>
                  원가 {mCostPct}% · 택배비 {mShippingPct}% · 광고비 {mAdChargePct}% · 수수료 {mFeePct}%
                </div>
              </div>
            </div>
          </div>

          {/* {연도}년 시즌별 매출 — 채널별 매출요약과 같은 channelSummaryYear 기준, 이번달 KPI와 동일한 큰 카드 구조 + 시즌 이동 버튼
              총매출액/수수료/순매출액/순수익 + 원가·택배비 + 전 시즌 대비 증감률까지 함께 표시 */}
          <div style={{ marginBottom: 24 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 13, fontWeight: 700, color: '#64748b' }}>시즌별 매출</div>
                <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>
                  전 기간 누적 기준 (시즌은 연도 경계를 넘나들기 때문에 연도로 나누지 않음)
                  {seasonUnmatched.count > 0 && (
                    <span style={{ color: '#e11d48', fontWeight: 700 }}>
                      {' '}· 시즌 미지정 {seasonUnmatched.count.toLocaleString('ko-KR')}건 {formatWon(seasonUnmatched.gross)} 제외됨
                    </span>
                  )}
                </div>
              </div>
              {channelSummarySeasonData.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  {/* ◀ = 이전(과거) 시즌으로 이동 (26SS → 25FW → 25SS …), ▶ = 최신 시즌 방향. 새 시즌(26FW, 27SS 등)을 등록하면 자동으로 목록에 추가됨 */}
                  <button onClick={() => setChannelSummarySeasonIdx(i => Math.min(i + 1, channelSummarySeasonData.length - 1))} style={monthBtnStyle}>◀</button>
                  <span style={{ fontSize: 13, fontWeight: 700, minWidth: 70, textAlign: 'center', color: '#000' }}>
                    {channelSummarySeasonData[channelSummarySeasonIdx]?.season}
                  </span>
                  <button onClick={() => setChannelSummarySeasonIdx(i => Math.max(i - 1, 0))} style={monthBtnStyle}>▶</button>
                  <button onClick={() => setShowSeasonSalesModal(true)} style={{ ...monthBtnStyle, marginLeft: 6, background: '#0f172a', color: '#fff', border: '1px solid #0f172a' }}>판매표</button>
                </div>
              )}
            </div>
            {channelSummarySeasonLoading ? (
              <div className="chart-empty">불러오는 중...</div>
            ) : channelSummarySeasonData.length === 0 ? (
              <div className="chart-empty">시즌 정보가 매칭된 판매 데이터가 없습니다</div>
            ) : (() => {
              const s = channelSummarySeasonData[channelSummarySeasonIdx]
              if (!s) return null
              // "전 시즌" = 정렬된 목록에서 현재 시즌 바로 다음(더 과거) 시즌
              const prevS = channelSummarySeasonData[channelSummarySeasonIdx + 1]
              const grossPct = prevS ? yoyPct(s.gross, prevS.gross) : null
              const netPct = prevS ? yoyPct(s.net, prevS.net) : null
              const profitPct = prevS ? yoyPct(s.profit, prevS.profit) : null
              const costShipPct = prevS ? yoyPct(s.cost + s.shipping, prevS.cost + prevS.shipping) : null
              const fees = s.gross - s.net
              return (
                <>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 16 }}>
                    <div style={{ background: '#fafafa', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
                      <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 8 }}>총 매출액</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ fontSize: 22, fontWeight: 800, color: '#000' }}>{formatWon(s.gross)}</span>
                        {grossPct !== null && (
                          <span style={{ fontSize: 12, fontWeight: 700, color: grossPct >= 0 ? '#059669' : '#e11d48' }}>
                            ({grossPct >= 0 ? '+' : ''}{grossPct}%)
                          </span>
                        )}
                      </div>
                      {prevS && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 6 }}>전 시즌({prevS.season}) 매출액 {formatWon(prevS.gross)}</div>}
                    </div>
                    <div style={{ background: '#fafafa', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
                      <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 8 }}>순매출액</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ fontSize: 22, fontWeight: 800, color: '#2563eb' }}>{formatWon(s.net)}</span>
                        {netPct !== null && (
                          <span style={{ fontSize: 12, fontWeight: 700, color: netPct >= 0 ? '#059669' : '#e11d48' }}>
                            ({netPct >= 0 ? '+' : ''}{netPct}%)
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: '#e11d48', marginTop: 6 }}>- {formatWon(fees)} 수수료</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>수수료 제외 실매출</div>
                      {prevS && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>전 시즌({prevS.season}) 순매출액 {formatWon(prevS.net)}</div>}
                    </div>
                    <div style={{ background: '#fafafa', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
                      <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 8 }}>순수익</div>
                      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
                        <span style={{ fontSize: 22, fontWeight: 800, color: s.profit >= 0 ? '#059669' : '#e11d48' }}>{formatWon(s.profit)}</span>
                        {profitPct !== null && (
                          <span style={{ fontSize: 12, fontWeight: 700, color: profitPct >= 0 ? '#059669' : '#e11d48' }}>
                            ({profitPct >= 0 ? '+' : ''}{profitPct}%)
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 11, color: '#64748b', marginTop: 6, fontWeight: 700 }}>
                        - {formatWon(s.cost + s.shipping)} 원가+택배비
                        {costShipPct !== null && (
                          <span style={{ fontWeight: 700, color: costShipPct >= 0 ? '#e11d48' : '#059669' }}>
                            {' '}({costShipPct >= 0 ? '+' : ''}{costShipPct}%)
                          </span>
                        )}
                      </div>
                      <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>원가 {formatWon(s.cost)} · 택배비 {formatWon(s.shipping)}</div>
                      {prevS && <div style={{ fontSize: 10, color: '#94a3b8', marginTop: 2 }}>전 시즌({prevS.season}) 순수익 {formatWon(prevS.profit)}</div>}
                    </div>
                  </div>
                </>
              )
            })()}
          </div>

          {/* 채널별 매출요약 + 플랫폼별 월 매출 현황 + 플랫폼별 매출 비중 — 2:2:1 비율로 한 줄에 배치 */}
          <div style={{ display: 'grid', gridTemplateColumns: '2fr 2fr 1fr', gap: 16, alignItems: 'start', marginBottom: 24 }}>
          {/* 채널별 요약 — 자체 연도/월별 이동 가능 */}
          <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#000' }}>채널별 매출요약</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <div style={{ display: 'flex', gap: 4 }}>
                  {(['year', 'month'] as const).map(m => (
                    <button
                      key={m}
                      onClick={() => setChannelSummaryMode(m)}
                      style={{
                        background: channelSummaryMode === m ? '#0f172a' : '#f8fafc',
                        color: channelSummaryMode === m ? '#fff' : '#000',
                        border: '1px solid #94a3b8', borderRadius: 6,
                        padding: '4px 9px', cursor: 'pointer', fontSize: 11, fontWeight: 700,
                      }}
                    >
                      {m === 'year' ? '연도' : '월별'}
                    </button>
                  ))}
                </div>
                <button onClick={prevChannelSummaryPeriod} style={monthBtnStyle}>◀</button>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#000', minWidth: 50, textAlign: 'center' }}>
                  {channelSummaryMode === 'year' ? `${channelSummaryYear}년` : `${channelSummaryYear % 100}.${String(channelSummaryMonth).padStart(2, '0')}`}
                </span>
                <button onClick={nextChannelSummaryPeriod} style={monthBtnStyle}>▶</button>
              </div>
            </div>
            {channelSummaryLoading ? (
              <div className="chart-empty">불러오는 중...</div>
            ) : channelSummaryTotals.length === 0 ? (
              <div className="chart-empty">데이터 없음</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {['채널', '총 매출액', '수수료', '순매출액', '순수익', '비중'].map(h => (
                      <th key={h} style={{ padding: '10px 14px', textAlign: 'center', borderBottom: '1px solid #94a3b8', fontSize: 11, color: '#94a3b8', fontWeight: 700 }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {channelSummaryTotals.map((c, i) => (
                    <tr key={i} style={{ borderBottom: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '12px 14px' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                          <span style={{ width: 10, height: 10, borderRadius: '50%', background: c.color, display: 'inline-block', flexShrink: 0 }}></span>
                          <span style={{ fontWeight: 600, color: '#000' }}>{c.channel}</span>
                        </div>
                      </td>
                      <td style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 600, color: '#000' }}>{formatWon(c.gross)}</td>
                      <td style={{ padding: '12px 14px', textAlign: 'right', color: '#e11d48' }}>- {formatWon(c.fees)}</td>
                      <td style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 600, color: '#2563eb' }}>{formatWon(c.net)}</td>
                      <td style={{ padding: '12px 14px', textAlign: 'right', fontWeight: 600, color: c.profit >= 0 ? '#059669' : '#e11d48' }}>{formatWon(c.profit)}</td>
                      <td style={{ padding: '12px 14px', textAlign: 'center' }}>
                        <span style={{ background: '#f1f5f9', borderRadius: 6, padding: '2px 8px', fontSize: 12, fontWeight: 600, color: '#000' }}>
                          {channelSummaryTotalGross > 0 ? ((c.gross / channelSummaryTotalGross) * 100).toFixed(1) : 0}%
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr style={{ borderTop: '2px solid #94a3b8', background: '#f8fafc' }}>
                    <td colSpan={6} style={{ padding: '10px 14px' }}>
                      <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'center', gap: 16, fontSize: 12, fontWeight: 700, color: '#000' }}>
                        <span>재고 SKU {invSkuCount.toLocaleString('ko-KR')}개</span>
                        <span>재고수량 {invTotalQty.toLocaleString('ko-KR')}개</span>
                        <span>재고금액 {formatWon(invTotalValue)}</span>
                      </div>
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </div>

            <div className="chart-card" style={{ border: '1px solid #94a3b8' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
                <div className="chart-title" style={{ margin: 0 }}>플랫폼별 월 매출 현황</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['year', 'month'] as const).map(m => (
                      <button
                        key={m}
                        onClick={() => setPlatformChartMode(m)}
                        style={{
                          background: platformChartMode === m ? '#0f172a' : '#f8fafc',
                          color: platformChartMode === m ? '#fff' : '#000',
                          border: '1px solid #94a3b8', borderRadius: 6,
                          padding: '4px 9px', cursor: 'pointer', fontSize: 11, fontWeight: 700,
                        }}
                      >
                        {m === 'year' ? '연도' : '월별'}
                      </button>
                    ))}
                  </div>
                  <button onClick={prevChartMonth} style={monthBtnStyle}>◀</button>
                  <span style={{ fontSize: 13, fontWeight: 700, minWidth: 60, textAlign: 'center' }}>
                    {platformChartMode === 'year' ? `${chartYear}년` : `${chartYear % 100}.${chartMonthStr}`}
                  </span>
                  <button onClick={nextChartMonth} style={monthBtnStyle}>▶</button>
                </div>
              </div>
              <div className="chart-sub">
                각 플랫폼 {platformChartMode === 'year' ? `${chartYear}년` : `${chartYear % 100}.${chartMonthStr}`} 매출액 · 순매출액 · 전년도 매출액
              </div>
              {chartDataLoading ? (
                <div className="chart-empty">불러오는 중...</div>
              ) : !platformMonthlyHasData ? (
                <div className="chart-empty">해당 월 데이터가 없습니다</div>
              ) : (
                <ResponsiveContainer width="100%" height={280}>
                  <BarChart data={platformMonthlyChartData} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="channel" tick={{ fontSize: 12 }} />
                    <YAxis tickFormatter={v => `${(v/10000).toFixed(0)}만`} tick={{ fontSize: 11 }} />
                    <Tooltip formatter={(v: any) => [formatKRW(v)]} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="매출액" name="매출액" fill="#4f46e5" radius={[4,4,0,0]}>
                      <LabelList dataKey="매출액" position="top" formatter={(v: any) => v ? v.toLocaleString('ko-KR') : ''} style={{ fontSize: 9, fontWeight: 700, fill: '#4f46e5' }} />
                    </Bar>
                    <Bar dataKey="순매출액" name="순매출액" fill="#059669" radius={[4,4,0,0]}>
                      <LabelList dataKey="순매출액" position="top" formatter={(v: any) => v ? v.toLocaleString('ko-KR') : ''} style={{ fontSize: 9, fontWeight: 700, fill: '#059669' }} />
                    </Bar>
                    <Bar dataKey="전년도매출액" name="전년도 매출액" fill="#94a3b8" radius={[4,4,0,0]}>
                      <LabelList dataKey="전년도매출액" position="top" formatter={(v: any) => v ? v.toLocaleString('ko-KR') : ''} style={{ fontSize: 9, fontWeight: 700, fill: '#64748b' }} />
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              )}
            </div>

            <div className="chart-card" style={{ border: '1px solid #94a3b8' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, flexWrap: 'wrap', gap: 6 }}>
                <div className="chart-title" style={{ margin: 0 }}>플랫폼별 매출 비중</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 4 }}>
                    {(['all','year','month'] as const).map(m => (
                      <button
                        key={m}
                        onClick={() => setPieMode(m)}
                        style={{
                          background: pieMode === m ? '#0f172a' : '#f8fafc',
                          color: pieMode === m ? '#fff' : '#000',
                          border: '1px solid #94a3b8', borderRadius: 6,
                          padding: '4px 9px', cursor: 'pointer', fontSize: 11, fontWeight: 700,
                        }}
                      >
                        {m === 'all' ? '전체' : m === 'year' ? '연도' : '월별'}
                      </button>
                    ))}
                  </div>
                  {pieMode !== 'all' && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <button onClick={prevPiePeriod} style={monthBtnStyle}>◀</button>
                      <span style={{ fontSize: 12, fontWeight: 700, color: '#000', minWidth: pieMode === 'year' ? 40 : 50, textAlign: 'center' }}>
                        {pieMode === 'year' ? `${pieYear}년` : `${pieYear % 100}.${pieMonthStr}`}
                      </span>
                      <button onClick={nextPiePeriod} style={monthBtnStyle}>▶</button>
                    </div>
                  )}
                </div>
              </div>
              <div className="chart-sub" style={{ color: '#000' }}>
                {pieMode === 'all' ? '전체 기간 누적 기준' : pieMode === 'year' ? `${pieYear}년 누적 기준` : `${pieYear}.${pieMonthStr} 매출 기준`}
              </div>
              {pieMode !== 'all' && pieDataLoading ? (
                <div className="chart-empty">불러오는 중...</div>
              ) : pieChartData.length === 0 ? (
                <div className="chart-empty">데이터 없음</div>
              ) : (
                <ResponsiveContainer width="100%" height={220}>
                  <PieChart>
                    <Pie data={pieChartData} dataKey="gross" nameKey="channel" cx="50%" cy="50%" outerRadius={90} innerRadius={45}
                      label={renderPieLabel} labelLine={false}>
                      {pieChartData.map((entry, i) => <Cell key={i} fill={entry.color} />)}
                    </Pie>
                    <Tooltip formatter={(v: any) => formatKRW(v)} />
                  </PieChart>
                </ResponsiveContainer>
              )}
            </div>
          </div>

          {/* {연도}년 월별 매출 / 판매수량 — 자사몰·무신사 페이지와 동일한 구성 (전 채널 합산, 상단 year와 별개로 이동) */}
          <div className="chart-card" style={{ marginBottom: 24, border: '1px solid #94a3b8' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#000' }}>{salesChartYear}년 월별 매출 / 판매수량</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button onClick={() => shiftSalesChartYear(-1)} style={monthBtnStyle}>◀</button>
                <span style={{ fontSize: 13, fontWeight: 700, color: '#000' }}>{salesChartYear}년</span>
                <button onClick={() => shiftSalesChartYear(1)} style={monthBtnStyle}>▶</button>
              </div>
            </div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
              매출액 · 순매출액 {salesChartHasPrevYearData ? `· ${salesChartYear - 1}년 순매출액(비교)` : ''}
            </div>
            {salesChartLoading ? (
              <div className="chart-empty">불러오는 중...</div>
            ) : !salesChartHasData ? (
              <div className="chart-empty">{salesChartYear}년 데이터가 없습니다</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={312}>
                  <BarChart data={monthlySalesChartData} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(v / 10000)}만`} />
                    <Tooltip formatter={(v: any) => formatWon(Number(v))} />
                    <Bar dataKey="매출" fill="#3b82f6" radius={[4, 4, 0, 0]}>
                      <LabelList dataKey="매출" position="top" formatter={(v: any) => v ? v.toLocaleString('ko-KR') : ''} style={{ fontSize: 8, fill: '#3b82f6', fontWeight: 700 }} />
                    </Bar>
                    <Bar dataKey="순매출액" fill="#059669" radius={[4, 4, 0, 0]}>
                      <LabelList dataKey="순매출액" position="top" formatter={(v: any) => v ? v.toLocaleString('ko-KR') : ''} style={{ fontSize: 8, fill: '#059669', fontWeight: 700 }} />
                    </Bar>
                    {salesChartHasPrevYearData && (
                      <Bar dataKey="작년순매출액" fill="#475569" radius={[4, 4, 0, 0]}>
                        <LabelList dataKey="작년순매출액" position="top" formatter={(v: any) => v ? v.toLocaleString('ko-KR') : ''} style={{ fontSize: 8, fill: '#475569', fontWeight: 700 }} />
                      </Bar>
                    )}
                  </BarChart>
                </ResponsiveContainer>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(12,1fr)', marginTop: 4, paddingLeft: 4, paddingRight: 4 }}>
                  {MONTH_LABELS.map((_, i) => {
                    const cur = salesChartMonthlyGross[i]
                    const prev = salesChartPrevMonthlyGross[i]
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
                    ...(salesChartHasPrevYearData ? [{ label: '작년순매출액', color: '#475569' }] : []),
                  ].map(item => (
                    <div key={item.label} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, background: item.color, display: 'inline-block' }} />
                      <span style={{ fontSize: 12, color: '#000' }}>{item.label}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <div style={{ fontWeight: 700, fontSize: 15, color: '#000', marginTop: 24, marginBottom: 4 }}>{salesChartYear}년 월별 판매수량</div>
            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>순수 판매 건수 · 전년동월 판매건수 비교</div>
            {!salesChartLoading && salesChartHasData && (
              <ResponsiveContainer width="100%" height={200}>
                <BarChart data={qtyChartData} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 12 }} />
                  <YAxis tick={{ fontSize: 11 }} />
                  <Tooltip formatter={(v: any) => `${v}개`} />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="판매수량" fill="#f59e0b" radius={[4, 4, 0, 0]}>
                    <LabelList dataKey="판매수량" position="top" formatter={(v: any) => v ? `${v}개` : ''} style={{ fontSize: 9, fill: '#f59e0b', fontWeight: 700 }} />
                  </Bar>
                  {salesChartHasPrevYearData && (
                    <Bar dataKey="작년판매수량" fill="#94a3b8" radius={[4, 4, 0, 0]}>
                      <LabelList dataKey="작년판매수량" position="top" formatter={(v: any) => v ? `${v}개` : ''} style={{ fontSize: 9, fill: '#64748b', fontWeight: 700 }} />
                    </Bar>
                  )}
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* 판매 추이 — 일간/주간/월간 전환 가능 (전 채널 합산) */}
          <div className="chart-card" style={{ marginBottom: 24, border: '1px solid #94a3b8' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4, flexWrap: 'wrap', gap: 8 }}>
              <div style={{ fontWeight: 700, fontSize: 15, color: '#000' }}>판매 추이</div>
              <div style={{ display: 'flex', gap: 4 }}>
                {(['daily', 'weekly', 'monthly'] as const).map(m => (
                  <button
                    key={m}
                    onClick={() => setTrendMode(m)}
                    style={{
                      background: trendMode === m ? '#0f172a' : '#f8fafc',
                      color: trendMode === m ? '#fff' : '#000',
                      border: '1px solid #94a3b8', borderRadius: 6,
                      padding: '5px 12px', cursor: 'pointer', fontSize: 12, fontWeight: 700,
                    }}
                  >
                    {m === 'daily' ? '일간' : m === 'weekly' ? '주간' : '월간'}
                  </button>
                ))}
              </div>
            </div>

            {trendMode === 'daily' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 10, position: 'relative' }}>
                <button onClick={() => shiftTrendWeek(-1)} style={monthBtnStyle}>◀</button>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#000', minWidth: 100, textAlign: 'center' }}>{trendWeekLabel}</span>
                <button onClick={() => shiftTrendWeek(1)} style={monthBtnStyle}>▶</button>
                <button
                  onClick={() => setShowTrendDatePicker(v => !v)}
                  title="주 선택"
                  style={{ border: '1px solid #94a3b8', background: '#fff', borderRadius: 6, padding: '4px 8px', cursor: 'pointer', fontSize: 13 }}
                >📅</button>
                {showTrendDatePicker && (
                  <input
                    type="date"
                    value={trendWeekAnchor}
                    onChange={e => { setTrendWeekAnchor(e.target.value); setShowTrendDatePicker(false) }}
                    style={{ position: 'absolute', left: 0, top: 30, zIndex: 10, border: '1px solid #94a3b8', borderRadius: 6, padding: '4px 8px', fontSize: 12, background: '#fff' }}
                  />
                )}
              </div>
            )}
            {trendMode === 'weekly' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10 }}>
                <span style={{ fontSize: 12, color: '#94a3b8' }}>이 달까지</span>
                <input
                  type="month"
                  value={trendMonthAnchor}
                  onChange={e => setTrendMonthAnchor(e.target.value)}
                  style={{ border: '1px solid #94a3b8', borderRadius: 6, padding: '4px 8px', fontSize: 12, color: '#000', background: '#fff' }}
                />
                <span style={{ fontSize: 12, color: '#94a3b8' }}>최근 12주</span>
              </div>
            )}

            <div style={{ fontSize: 12, color: '#94a3b8', marginBottom: 16 }}>
              매출액 · 순매출액 (전 채널 합산)
            </div>
            {trendLoading ? (
              <div className="chart-empty">불러오는 중...</div>
            ) : !trendHasData ? (
              <div className="chart-empty">데이터가 없습니다</div>
            ) : (
              <ResponsiveContainer width="100%" height={280}>
                <BarChart data={trendChartData} margin={{ top: 20, right: 10, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="name" tick={{ fontSize: 10 }} interval={0} />
                  <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => `${Math.round(v / 10000)}만`} />
                  <Tooltip formatter={(v: any) => formatWon(Number(v))} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Bar dataKey="매출" name="매출액" fill="#3b82f6" radius={[3, 3, 0, 0]}>
                    <LabelList dataKey="매출" position="top" formatter={(v: any) => v ? v.toLocaleString('ko-KR') : ''} style={{ fontSize: 9, fill: '#3b82f6', fontWeight: 700 }} />
                  </Bar>
                  <Bar dataKey="순매출액" name="순매출액" fill="#059669" radius={[3, 3, 0, 0]}>
                    <LabelList dataKey="순매출액" position="top" formatter={(v: any) => v ? v.toLocaleString('ko-KR') : ''} style={{ fontSize: 9, fill: '#059669', fontWeight: 700 }} />
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* 광고 성과지표 — 연도 / 월별 KPI 카드는 1:1 비율로 한 줄, 월별 성과 지표(차트+표)는 다음 줄 전체 사용
              현재는 무신사만 광고비·전환매출을 기록하고 있어서 무신사 기준으로만 표시하고, 다른 채널도 광고 데이터가 쌓이면 함께 반영하면 됨 */}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16, marginBottom: 16 }}>
            <div className="chart-card" style={{ border: '1px solid #94a3b8' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <div className="chart-title" style={{ margin: 0 }}>{adYear}년 연도 광고 성과지표</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={() => setAdYear(y => y - 1)} style={monthBtnStyle}>◀</button>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#000' }}>{adYear}년</span>
                  <button onClick={() => setAdYear(y => y + 1)} style={monthBtnStyle}>▶</button>
                </div>
              </div>
              <div className="chart-sub">무신사 기준 · 다른 채널은 광고 데이터 연동 후 반영 예정</div>
              {adLoading ? (
                <div className="chart-empty">불러오는 중...</div>
              ) : adTotalCost === 0 ? (
                <div className="chart-empty">광고 데이터가 없습니다</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
                  <div style={{ display: 'flex', gap: 24 }}>
                    <div>
                      <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>총 광고비</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#000' }}>{formatWon(adTotalCost)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>총 전환매출</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#059669' }}>{formatWon(adTotalRevenue)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-around', gap: 8 }}>
                    <div style={{ textAlign: 'center', flex: 1 }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#4f46e5' }}>{adTotalRoas !== null ? `${adTotalRoas}%` : '-'}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, fontWeight: 700 }}>ROAS</div>
                    </div>
                    <div style={{ textAlign: 'center', flex: 1 }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#e11d48' }}>{adTotalAcos !== null ? `${adTotalAcos}%` : '-'}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, fontWeight: 700 }}>ACOS</div>
                    </div>
                    <div style={{ textAlign: 'center', flex: 1 }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#d97706' }}>{adTotalTacos !== null ? `${adTotalTacos}%` : '-'}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, fontWeight: 700 }}>TACOS</div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="chart-card" style={{ border: '1px solid #94a3b8' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
                <div className="chart-title" style={{ margin: 0 }}>월별 광고 성과지표</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={prevAdMonth} style={monthBtnStyle}>◀</button>
                  <span style={{ fontSize: 12, fontWeight: 700, color: '#000' }}>{adYear}.{adMonthStr}</span>
                  <button onClick={nextAdMonth} style={monthBtnStyle}>▶</button>
                </div>
              </div>
              <div className="chart-sub">무신사 기준 · 선택한 달의 광고 실적</div>
              {adLoading ? (
                <div className="chart-empty">불러오는 중...</div>
              ) : adMonthCost === 0 ? (
                <div className="chart-empty">광고 데이터가 없습니다</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 8 }}>
                  <div style={{ display: 'flex', gap: 24 }}>
                    <div>
                      <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>이 달 광고비</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#000' }}>{formatWon(adMonthCost)}</div>
                    </div>
                    <div>
                      <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }}>이 달 전환매출</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#059669' }}>{formatWon(adMonthRevenue)}</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-around', gap: 8 }}>
                    <div style={{ textAlign: 'center', flex: 1 }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#4f46e5' }}>{adMonthRoas !== null ? `${adMonthRoas}%` : '-'}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, fontWeight: 700 }}>ROAS</div>
                    </div>
                    <div style={{ textAlign: 'center', flex: 1 }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#e11d48' }}>{adMonthAcos !== null ? `${adMonthAcos}%` : '-'}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, fontWeight: 700 }}>ACOS</div>
                    </div>
                    <div style={{ textAlign: 'center', flex: 1 }}>
                      <div style={{ fontSize: 18, fontWeight: 800, color: '#d97706' }}>{adMonthTacos !== null ? `${adMonthTacos}%` : '-'}</div>
                      <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2, fontWeight: 700 }}>TACOS</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* 월별 성과 지표 — 다음 줄 전체 폭 사용, 광고비·전환매출·ROAS·ACOS·TACOS를 차트+표로 함께 표시 */}
          <div className="chart-card" style={{ marginBottom: 24, border: '1px solid #94a3b8' }}>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, marginBottom: 4 }}>
              <div className="chart-title" style={{ margin: 0, textAlign: 'center' }}>{adYear}년 월별 성과 지표</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <button onClick={() => setAdYear(y => y - 1)} style={monthBtnStyle}>◀</button>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#000' }}>{adYear}년</span>
                <button onClick={() => setAdYear(y => y + 1)} style={monthBtnStyle}>▶</button>
              </div>
            </div>
            <div className="chart-sub" style={{ textAlign: 'center' }}>월별 광고비 · 전환매출 · 충전광고비 · ROAS · ACOS · TACOS (무신사 기준)</div>

            {adLoading ? (
              <div className="chart-empty">불러오는 중...</div>
            ) : adTotalCost === 0 ? (
              <div className="chart-empty">광고 데이터가 없습니다</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={260}>
                  <ComposedChart data={adMonthlyChartData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" vertical={false} />
                    <XAxis dataKey="name" tick={{ fontSize: 11 }} />
                    <YAxis yAxisId="left" tickFormatter={v => `${(v/10000).toFixed(0)}만`} tick={{ fontSize: 10 }} />
                    <YAxis yAxisId="right" orientation="right" tickFormatter={v => `${v}%`} tick={{ fontSize: 10 }} />
                    <Tooltip formatter={(v: any, name: any) => ['ROAS','ACOS','TACOS'].includes(name) ? [`${v}%`, name] : [formatWon(v), name]} />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar yAxisId="left" dataKey="광고비" fill="#f43f5e" radius={[4,4,0,0]} />
                    <Bar yAxisId="left" dataKey="전환매출" fill="#34d399" radius={[4,4,0,0]} />
                    <Bar yAxisId="left" dataKey="충전광고비" fill="#a855f7" radius={[4,4,0,0]} />
                    <Line yAxisId="right" dataKey="ROAS" stroke="#4f46e5" strokeWidth={2} dot={{ fill: '#4f46e5', r: 3 }} />
                    <Line yAxisId="right" dataKey="ACOS" stroke="#e11d48" strokeWidth={2} dot={{ fill: '#e11d48', r: 3 }} />
                    <Line yAxisId="right" dataKey="TACOS" stroke="#d97706" strokeWidth={2} dot={{ fill: '#d97706', r: 3 }} />
                  </ComposedChart>
                </ResponsiveContainer>

                {/* 차트 아래를 좌우로 나눠서 왼쪽에 지표 설명, 오른쪽에 월별 표를 배치 */}
                {/* 설명 열은 좁게 고정하고 표가 남은 폭을 전부 쓰도록 배치 */}
                <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', alignItems: 'start', gap: 16, marginTop: 16 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                    <div style={{ background: '#f8fafc', borderRadius: 10, padding: '14px 16px', textAlign: 'center' }}>
                      <div style={{ fontSize: 16, fontWeight: 800, color: '#4f46e5', marginBottom: 5 }}>ROAS</div>
                      <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.6 }}>
                        광고비 대비 전환매출 비율<br />(전환매출 ÷ 광고비 × 100)<br />
                        <span style={{ color: '#94a3b8' }}>높을수록 광고 효율이 좋음</span>
                      </div>
                    </div>
                    <div style={{ background: '#f8fafc', borderRadius: 10, padding: '14px 16px', textAlign: 'center' }}>
                      <div style={{ fontSize: 16, fontWeight: 800, color: '#e11d48', marginBottom: 5 }}>ACOS</div>
                      <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.6 }}>
                        전환매출 대비 광고비 비율<br />(광고비 ÷ 전환매출 × 100)<br />
                        <span style={{ color: '#94a3b8' }}>낮을수록 좋음</span>
                      </div>
                    </div>
                    <div style={{ background: '#f8fafc', borderRadius: 10, padding: '14px 16px', textAlign: 'center' }}>
                      <div style={{ fontSize: 16, fontWeight: 800, color: '#d97706', marginBottom: 5 }}>TACOS</div>
                      <div style={{ fontSize: 13, color: '#475569', lineHeight: 1.6 }}>
                        전체 매출 대비 광고비 비율<br />(광고비 ÷ 전체 매출 × 100)<br />
                        <span style={{ color: '#94a3b8' }}>낮을수록 광고 의존도가 낮음</span>
                      </div>
                    </div>
                  </div>
                  {/* 행·열을 바꿔서 지표가 행, 월이 열로 가로로 길게 표시 — 남은 폭을 꽉 채워서 크게 */}
                  <div style={{ overflowX: 'auto', minWidth: 0 }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}>
                    <thead>
                      <tr style={{ background: '#f8fafc' }}>
                        <th style={{ padding: '13px 14px', textAlign: 'center', borderBottom: '1px solid #94a3b8', fontSize: 13, color: '#94a3b8', fontWeight: 700, whiteSpace: 'nowrap' }}>구분</th>
                        {adMonthlyChartData.map((row, i) => (
                          <th key={i} style={{ padding: '13px 14px', textAlign: 'center', borderBottom: '1px solid #94a3b8', fontSize: 13, color: '#94a3b8', fontWeight: 700, whiteSpace: 'nowrap' }}>{row.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {([
                        { label: '광고비', color: '#000', get: (r: any) => formatWon(r.광고비) },
                        { label: '전환매출', color: '#059669', get: (r: any) => formatWon(r.전환매출) },
                        { label: '충전광고비', color: '#a855f7', get: (r: any) => formatWon(r.충전광고비) },
                        { label: 'ROAS', color: '#4f46e5', get: (r: any) => r.광고비 > 0 ? `${r.ROAS}%` : '-' },
                        { label: 'ACOS', color: '#e11d48', get: (r: any) => r.광고비 > 0 ? `${r.ACOS}%` : '-' },
                        { label: 'TACOS', color: '#d97706', get: (r: any) => r.광고비 > 0 ? `${r.TACOS}%` : '-' },
                      ] as const).map(metric => (
                        <tr key={metric.label} style={{ borderBottom: '1px solid #f1f5f9' }}>
                          <td style={{ padding: '13px 14px', textAlign: 'center', fontWeight: 700, fontSize: 14, color: '#000', whiteSpace: 'nowrap', background: '#f8fafc' }}>{metric.label}</td>
                          {adMonthlyChartData.map((row, i) => (
                            <td key={i} style={{ padding: '13px 14px', textAlign: 'center', fontWeight: 600, color: metric.color, whiteSpace: 'nowrap' }}>{metric.get(row)}</td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              </>
            )}
          </div>

          {/* 빈 상태 */}
          {monthlySales.every(r => r.gross === 0) && (
            <div className="empty-state">
              <p>아직 데이터가 없어요.<br />각 채널 페이지에서 데이터를 업로드하면 대시보드가 채워집니다.</p>
            </div>
          )}

        </>
      )}

      {/* 시즌별 판매표 팝업 — 현재 선택된 시즌의 아이템·옵션별 판매수량 */}
      {showSeasonSalesModal && (() => {
        const curSeason = channelSummarySeasonData[channelSummarySeasonIdx]?.season
        const rows = (curSeason && seasonSalesDetail[curSeason]) || []
        const totalQty = rows.reduce((s, r) => s + r.qty, 0)
        // 상품명별 소계를 위해 같은 상품명 행을 연속으로 묶어서 표시
        return (
          <div
            onClick={() => setShowSeasonSalesModal(false)}
            style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}
          >
            <div
              onClick={e => e.stopPropagation()}
              style={{ background: '#fff', borderRadius: 20, padding: 28, width: '100%', maxWidth: 640, maxHeight: '85vh', overflowY: 'auto' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
                <div style={{ fontSize: 18, fontWeight: 800, color: '#000' }}>{curSeason} 판매표 (전 기간)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <button onClick={() => setChannelSummarySeasonIdx(i => Math.min(i + 1, channelSummarySeasonData.length - 1))} style={monthBtnStyle}>◀</button>
                  <span style={{ fontSize: 13, fontWeight: 700, minWidth: 60, textAlign: 'center', color: '#000' }}>{curSeason}</span>
                  <button onClick={() => setChannelSummarySeasonIdx(i => Math.max(i - 1, 0))} style={monthBtnStyle}>▶</button>
                  <button
                    onClick={() => setShowSeasonSalesModal(false)}
                    style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', color: '#64748b', lineHeight: 1, marginLeft: 6 }}
                  >✕</button>
                </div>
              </div>
              {rows.length === 0 ? (
                <div className="chart-empty">이 시즌의 판매 데이터가 없습니다</div>
              ) : (
                <div style={{ border: '1px solid #94a3b8', borderRadius: 12, overflow: 'hidden' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                      <tr style={{ background: '#f8fafc' }}>
                        <th style={{ textAlign: 'left', padding: '8px 12px', color: '#000' }}>상품명</th>
                        <th style={{ textAlign: 'left', padding: '8px 12px', color: '#000' }}>옵션</th>
                        <th style={{ textAlign: 'right', padding: '8px 12px', color: '#000' }}>판매수량</th>
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((r, i) => {
                        const isFirstOfItem = i === 0 || rows[i - 1].item !== r.item
                        const itemTotal = rows.filter(x => x.item === r.item).reduce((s, x) => s + x.qty, 0)
                        const itemRowCount = rows.filter(x => x.item === r.item).length
                        return (
                          <tr key={`${r.item}__${r.option}`} style={{ borderTop: '1px solid #f1f5f9' }}>
                            {isFirstOfItem && (
                              <td rowSpan={itemRowCount} style={{ padding: '8px 12px', fontWeight: 700, color: '#000', verticalAlign: 'top', borderRight: '1px solid #f1f5f9' }}>
                                {r.item}
                                {itemRowCount > 1 && <div style={{ fontSize: 10, color: '#94a3b8', fontWeight: 400, marginTop: 2 }}>합계 {itemTotal.toLocaleString('ko-KR')}장</div>}
                              </td>
                            )}
                            <td style={{ padding: '8px 12px', color: '#000' }}>{r.option}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', fontWeight: 700, color: '#000' }}>{r.qty.toLocaleString('ko-KR')}장</td>
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr style={{ borderTop: '2px solid #94a3b8', background: '#f8fafc' }}>
                        <td colSpan={2} style={{ padding: '10px 12px', fontWeight: 800, color: '#000' }}>총 판매수량</td>
                        <td style={{ padding: '10px 12px', textAlign: 'right', fontWeight: 800, color: '#000' }}>{totalQty.toLocaleString('ko-KR')}장</td>
                      </tr>
                    </tfoot>
                  </table>
                </div>
              )}
            </div>
          </div>
        )
      })()}

      {/* 총매출 팝업 — 연도 구분 없는 전체 누적 매출/순매출/순수익 + 시즌별 매출·순수익 */}
      {showTotalModal && (
        <div
          onClick={() => setShowTotalModal(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20 }}
        >
          <div
            onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 20, padding: 28, width: '100%', maxWidth: 560, maxHeight: '85vh', overflowY: 'auto' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
              <div style={{ fontSize: 18, fontWeight: 800, color: '#000' }}>전체 누적 실적 (연도 전체)</div>
              <button
                onClick={() => setShowTotalModal(false)}
                style={{ background: 'transparent', border: 'none', fontSize: 20, cursor: 'pointer', color: '#64748b', lineHeight: 1 }}
              >✕</button>
            </div>

            {totalModalLoading ? (
              <div className="chart-empty">전체 데이터를 불러오는 중...</div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 12, marginBottom: 24 }}>
                  <div style={{ background: '#f8fafc', borderRadius: 14, padding: 16 }}>
                    <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 6 }}>총 매출액</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#000' }}>{formatWon(totalSummary.gross)}</div>
                  </div>
                  <div style={{ background: '#f8fafc', borderRadius: 14, padding: 16 }}>
                    <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 6 }}>순매출액</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: '#2563eb' }}>{formatWon(totalSummary.net)}</div>
                  </div>
                  <div style={{ background: '#f8fafc', borderRadius: 14, padding: 16 }}>
                    <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 6 }}>순수익</div>
                    <div style={{ fontSize: 16, fontWeight: 800, color: totalSummary.profit >= 0 ? '#059669' : '#e11d48' }}>{formatWon(totalSummary.profit)}</div>
                  </div>
                </div>
                <div style={{ fontSize: 11, color: '#94a3b8', marginBottom: 20 }}>
                  원가 {formatWon(totalSummary.cost)} · 택배비 {formatWon(totalSummary.shipping)}{totalSummary.adCharge > 0 ? ` · 충전 광고비 ${formatWon(totalSummary.adCharge)}` : ''} (전 채널·전 기간 누적)
                </div>

                <div style={{ fontSize: 14, fontWeight: 800, color: '#000', marginBottom: 10 }}>시즌별 판매 수익</div>
                {seasonSummary.length === 0 ? (
                  <div className="chart-empty">시즌 정보가 매칭된 판매 데이터가 없습니다</div>
                ) : (
                  <div style={{ border: '1px solid #94a3b8', borderRadius: 12, overflow: 'hidden' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: '#f8fafc' }}>
                          <th style={{ textAlign: 'left', padding: '8px 12px', color: '#000' }}>시즌</th>
                          <th style={{ textAlign: 'right', padding: '8px 12px', color: '#000' }}>매출액</th>
                          <th style={{ textAlign: 'right', padding: '8px 12px', color: '#2563eb' }}>순매출액</th>
                          <th style={{ textAlign: 'right', padding: '8px 12px', color: '#059669' }}>순수익</th>
                        </tr>
                      </thead>
                      <tbody>
                        {seasonSummary.map(s => (
                          <tr key={s.season} style={{ borderTop: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '8px 12px', fontWeight: 700, color: '#000' }}>{s.season}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: '#000' }}>{formatWon(s.gross)}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: '#2563eb' }}>{formatWon(s.net)}</td>
                            <td style={{ padding: '8px 12px', textAlign: 'right', color: s.profit >= 0 ? '#059669' : '#e11d48' }}>{formatWon(s.profit)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

const btnStyle: React.CSSProperties = {
  background: '#f8fafc', border: '1px solid #94a3b8', borderRadius: 8,
  padding: '7px 14px', cursor: 'pointer', fontSize: 15, fontWeight: 700,
}

// 연도 이동 버튼 — btnStyle보다 3px 작게
const yearBtnStyle: React.CSSProperties = {
  background: '#f8fafc', border: '1px solid #94a3b8', borderRadius: 8,
  padding: '5px 11px', cursor: 'pointer', fontSize: 12, fontWeight: 700,
}

const monthBtnStyle: React.CSSProperties = {
  background: '#f8fafc', border: '1px solid #94a3b8', borderRadius: 6,
  padding: '4px 10px', cursor: 'pointer', fontSize: 13, fontWeight: 700,
}