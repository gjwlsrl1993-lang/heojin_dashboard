'use client'

import { useEffect, useState, useMemo } from 'react'
import { supabase } from '@/lib/supabase'

// 원 단위 축약 없이 1원 자리까지 전부 표시 (formatKRW의 만원/억 축약 대신)
function formatKRW(n: number): string {
  return (n || 0).toLocaleString('ko-KR') + '원'
}

type ItemRow = {
  item_id: string
  name: string
  sku: string
  category: string
  season: string
  option_name: string
  qty: number
  gross: number
  net: number
  cost: number
  margin: number
  margin_pct: number
  cancel_qty: number
}

type SortKey = 'default' | 'qty' | 'gross' | 'net' | 'cost' | 'margin' | 'cancel_qty'

type RawLine = {
  style_no: string
  item_name: string
  option_name: string
  qty: number
  gross: number
  net: number
  cost: number
  cancel_qty: number
}

const QUICK_PERIODS = [
  { label: '이번 달', fn: () => { const n=new Date(),y=n.getFullYear(),m=n.getMonth(); return { from:`${y}-${String(m+1).padStart(2,'0')}-01`, to:new Date(y,m+1,0).toISOString().slice(0,10) } } },
  { label: '지난 달', fn: () => { const n=new Date(); const m=n.getMonth()===0?11:n.getMonth()-1,y=n.getMonth()===0?n.getFullYear()-1:n.getFullYear(); return { from:`${y}-${String(m+1).padStart(2,'0')}-01`, to:new Date(y,m+1,0).toISOString().slice(0,10) } } },
  { label: '최근 7일', fn: () => { const to=new Date(),from=new Date(); from.setDate(to.getDate()-6); return { from:from.toISOString().slice(0,10), to:to.toISOString().slice(0,10) } } },
  { label: '최근 30일', fn: () => { const to=new Date(),from=new Date(); from.setDate(to.getDate()-29); return { from:from.toISOString().slice(0,10), to:to.toISOString().slice(0,10) } } },
  { label: '지난 주', fn: () => { const n=new Date(); const day=n.getDay()||7; const mon=new Date(n); mon.setDate(n.getDate()-day-6); const sun=new Date(mon); sun.setDate(mon.getDate()+6); return { from:mon.toISOString().slice(0,10), to:sun.toISOString().slice(0,10) } } },
  { label: '올해', fn: () => { const y=new Date().getFullYear(); return { from:`${y}-01-01`, to:`${y}-12-31` } } },
  { label: '전체', fn: () => ({ from: '2025-01-01', to: new Date().toISOString().slice(0,10) }) },
]

// 연도 선택 버튼에 쓸 연도 목록 (2025년 오픈 ~ 올해+1년)
function yearOptions(): number[] {
  const current = new Date().getFullYear()
  const years: number[] = []
  for (let y = 2025; y <= current + 1; y++) years.push(y)
  return years
}

// 월 선택 버튼용: 해당 연/월의 마지막 날짜 (시간대 변환으로 하루 밀리는 문제 없이 순수 달력 계산)
function lastDayOfMonth(year: number, month: number): number {
  const daysInMonth = [31, (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return daysInMonth[month - 1]
}

// 카테고리 필터 버튼 및 기본 정렬 순서: 아우터 > 상의 > 하의 > 액세서리 > 그 외
const CATEGORY_ORDER = ['아우터', '상의', '하의', '액세서리', '원피스', '가방', '기타']
function categorySortValue(c: string): number {
  const idx = CATEGORY_ORDER.indexOf(c)
  return idx === -1 ? 999 : idx
}

// "25SS", "25FW", "26SS" 같은 시즌 문자열을 시간순으로 정렬하기 위한 값 계산
function seasonSortValue(season: string): number {
  const match = /^(\d{2})(SS|FW)$/i.exec((season || '').trim())
  if (!match) return -1
  const yy = parseInt(match[1], 10)
  const seasonCode = match[2].toUpperCase() === 'SS' ? 0 : 1
  return yy * 10 + seasonCode
}

// ── 채널별 실제 매출/정산/원가 계산 공식 (각 채널 페이지의 로직과 동일하게 맞춤) ──
const MUSINSA_DISCOUNT_STEP = 0.01 // 10% 할인당 수수료 1%p 감소 (기본 페이지 참고, 라인 단위는 net_settlement 우선 사용)
const CAFE24_FEE_RATE = 0.035
const WOO_FEE_RATE = 0.40
const CLAMAN_FEE_RATE = 0.30
const REKET_BASE_FEE = 0.30
const REKET_FEE_STEP = 0.01

function reketFeeRate(discountRate: number) {
  const steps = Math.floor((discountRate || 0) * 100 / 10)
  return Math.max(0, REKET_BASE_FEE - steps * REKET_FEE_STEP)
}

function normalizeSku(raw: string): string { return String(raw || '').trim().toUpperCase() }
function looseSku(raw: string): string { return normalizeSku(raw).replace(/[\s\-_]/g, '') }
function normalizeOption(raw: string): string {
  const v = (raw || '').replace(/^SIZE=/i, '').trim()
  if (v.toUpperCase() === 'FREE') return 'F'
  return v.toUpperCase()
}

function buildItemMatchIndex(items: any[]) {
  const bySkuOption = new Map<string, any>()
  const bySkuOnly = new Map<string, any>()
  const byNameOption = new Map<string, any>()
  const byNameOnly = new Map<string, any>()
  const byLooseSku = new Map<string, any>()
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
  return function find(styleNo: string, itemName: string, optionRaw: string): any | undefined {
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
}

// 각 채널 raw row → 공통 RawLine 형태로 변환
function normalizeMusinsaRow(row: any): RawLine {
  const qty = row.qty || (row.order_type && String(row.order_type).includes('환불') ? 1 : row.qty) || 0
  const gross = row.revenue_ao || 0
  let net: number
  if (row.net_settlement !== null && row.net_settlement !== undefined) {
    net = row.net_settlement
  } else {
    const musinsaDiscountTotal = (row.discount||0)+(row.musinsa_coupon||0)+(row.musinsa_cart_coupon||0)+(row.reward_points||0)
    const totalCommission = (row.commission_sale||0)-(row.penalty||0)-(row.claim_shipping_fee||0)-(row.review_boost||0)-(row.mfs_logistics||0)+musinsaDiscountTotal
    net = gross - totalCommission
  }
  const isRefund = row.order_type && (String(row.order_type).includes('환불') || String(row.order_type).includes('반품'))
  return {
    style_no: row.style_no || '', item_name: row.item_name || '', option_name: row.option_name || '',
    qty: isRefund ? 0 : (qty || 0),
    gross, net, cost: row.matched_cost || 0,
    cancel_qty: isRefund ? (row.qty || 1) : 0,
  }
}
function normalizeCafe24Row(row: any): RawLine {
  const gross = row.sale_amount || 0
  const isRefund = gross < 0
  const net = gross - Math.round(gross * CAFE24_FEE_RATE)
  return {
    style_no: row.style_no || '', item_name: row.item_name || '', option_name: row.option_name || '',
    qty: isRefund ? 0 : 1, gross, net, cost: row.matched_cost || 0,
    cancel_qty: isRefund ? 1 : 0,
  }
}
function normalizeReketRow(row: any): RawLine {
  const gross = row.sale_amount || 0
  const isRefund = gross < 0
  const preAmount = gross + (row.discount_amount || 0)
  const discountRate = preAmount > 0 ? (row.discount_amount || 0) / preAmount : 0
  const feeRate = reketFeeRate(discountRate)
  const fee = Math.round(gross * feeRate)
  return {
    style_no: row.style_no || '', item_name: row.item_name || '', option_name: row.option_name || '',
    qty: isRefund ? 0 : 1, gross, net: gross - fee, cost: row.matched_cost || 0,
    cancel_qty: isRefund ? 1 : 0,
  }
}
function normalizeWooRow(row: any): RawLine {
  const gross = row.sale_amount || 0
  const isRefund = gross < 0
  const net = gross - Math.round(gross * WOO_FEE_RATE)
  return {
    style_no: row.style_no || '', item_name: row.item_name || '', option_name: row.option_name || '',
    qty: isRefund ? 0 : 1, gross, net, cost: row.matched_cost || 0,
    cancel_qty: isRefund ? 1 : 0,
  }
}
function normalizeClamanRow(row: any): RawLine {
  const gross = row.sale_amount || 0
  const isRefund = gross < 0
  const net = gross - Math.round(gross * CLAMAN_FEE_RATE)
  return {
    style_no: row.style_no || '', item_name: row.item_name || '', option_name: row.option_name || '',
    qty: isRefund ? 0 : 1, gross, net, cost: row.matched_cost || 0,
    cancel_qty: isRefund ? 1 : 0,
  }
}

const CHANNEL_TABLES: Record<string, { table: string; dateCol: string; normalize: (r: any) => RawLine }> = {
  '무신사': { table: 'musinsa_settlement_lines', dateCol: 'settle_date', normalize: normalizeMusinsaRow },
  '카페24': { table: 'cafe24_settlement_lines', dateCol: 'settle_date', normalize: normalizeCafe24Row },
  'REKET': { table: 'reket_settlement_lines', dateCol: 'settle_date', normalize: normalizeReketRow },
  'WOO':   { table: 'woo_settlement_lines', dateCol: 'settle_date', normalize: normalizeWooRow },
  '클라만': { table: 'claman_settlement_lines', dateCol: 'settle_month', normalize: normalizeClamanRow },
}

export default function ItemsPage() {
  const [channel, setChannel] = useState<string>('전체')
  const [dateFrom, setDateFrom] = useState(() => `${new Date().getFullYear()}-01-01`)
  const [dateTo,   setDateTo]   = useState(() => new Date().toISOString().slice(0,10))
  const [quickSel, setQuickSel] = useState('올해')
  const [showDatePicker, setShowDatePicker] = useState(false)
  const [monthPickerYear, setMonthPickerYear] = useState(new Date().getFullYear())

  const [items,   setItems]   = useState<ItemRow[]>([])
  const [prevItems, setPrevItems] = useState<ItemRow[]>([])
  const [loading, setLoading] = useState(true)
  const [sortKey, setSortKey] = useState<SortKey>('default')
  const [sortAsc, setSortAsc] = useState(false)
  const [categoryFilter, setCategoryFilter] = useState('전체')
  const [seasonFilter, setSeasonFilter] = useState('전체')
  const [aiLoading, setAiLoading] = useState(false)
  const [aiResult,  setAiResult]  = useState('')

  useEffect(() => { loadData() }, [dateFrom, dateTo, channel])

  async function fetchChannelLines(chLabel: string, from: string, to: string): Promise<any[]> {
    const cfg = CHANNEL_TABLES[chLabel]
    if (!cfg) return []
    let q = supabase.from(cfg.table).select('*')
    if (cfg.dateCol === 'settle_month') {
      q = q.gte('settle_month', from.slice(0, 7)).lte('settle_month', to.slice(0, 7))
    } else {
      q = q.gte('settle_date', from).lte('settle_date', to)
    }
    const { data, error } = await q
    if (error) { console.error(`${cfg.table} query error:`, error); return [] }
    return (data || []).map(cfg.normalize)
  }

  async function loadRange(from: string, to: string, itemIndex: (styleNo: string, name: string, opt: string) => any): Promise<ItemRow[]> {
    const channelsToFetch = channel === '전체' ? Object.keys(CHANNEL_TABLES) : [channel]
    const results = await Promise.all(channelsToFetch.map(ch => fetchChannelLines(ch, from, to)))
    const lines = results.flat()

    const map: Record<string, ItemRow> = {}
    lines.forEach(line => {
      const matched = itemIndex(line.style_no, line.item_name, line.option_name)
      const key = matched ? `id:${matched.id}` : `raw:${normalizeSku(line.style_no) || line.item_name}__${normalizeOption(line.option_name)}`
      if (!map[key]) {
        map[key] = {
          item_id: key,
          name: matched?.name || line.item_name || '(미매칭)',
          sku: matched?.sku || line.style_no || '',
          category: matched?.category || '-',
          season: matched?.season || '-',
          option_name: line.option_name || '',
          qty: 0, gross: 0, net: 0, cost: 0, margin: 0, margin_pct: 0, cancel_qty: 0,
        }
      }
      map[key].qty        += line.qty
      map[key].gross       += line.gross
      map[key].net         += line.net
      map[key].cost        += line.cost
      map[key].cancel_qty  += line.cancel_qty
    })
    return Object.values(map).map(r => {
      const margin = r.net - r.cost
      return { ...r, margin, margin_pct: r.gross > 0 ? Math.round((margin / r.gross) * 100) : 0 }
    })
  }

  async function loadData() {
    setLoading(true)
    const { data: itemsData, error: itemsError } = await supabase
      .from('items')
      .select('id, name, sku, category, option_name, season')
    if (itemsError) console.error('items query error:', itemsError)
    const itemIndex = buildItemMatchIndex(itemsData || [])

    const fromDate = new Date(dateFrom)
    const toDate   = new Date(dateTo)
    const prevFromDate = new Date(fromDate); prevFromDate.setFullYear(prevFromDate.getFullYear() - 1)
    const prevToDate   = new Date(toDate);   prevToDate.setFullYear(prevToDate.getFullYear() - 1)

    const [curr, prev] = await Promise.all([
      loadRange(dateFrom, dateTo, itemIndex),
      loadRange(prevFromDate.toISOString().slice(0,10), prevToDate.toISOString().slice(0,10), itemIndex),
    ])
    setItems(curr)
    setPrevItems(prev)
    setLoading(false)
  }

  // 전체 KPI
  const totalQty    = items.reduce((s,r) => s + r.qty, 0)
  const totalGross  = items.reduce((s,r) => s + r.gross, 0)
  const totalNet    = items.reduce((s,r) => s + r.net, 0)
  const totalCost   = items.reduce((s,r) => s + r.cost, 0)
  const totalMargin = totalNet - totalCost
  const prevQty     = prevItems.reduce((s,r) => s + r.qty, 0)
  const prevGross   = prevItems.reduce((s,r) => s + r.gross, 0)
  const diffQty     = totalQty - prevQty
  const diffGross   = totalGross - prevGross
  const diffQtyPct  = prevQty   > 0 ? Math.round((diffQty   / prevQty)   * 100) : 0
  const diffGrossPct= prevGross > 0 ? Math.round((diffGross / prevGross)  * 100) : 0
  // "전체" 기간은 특정 연도 기준 전년 동기가 없는 누적 기간이라 전년 대비 비교 자체가 의미 없음
  const showYoY = quickSel !== '전체'

  // 현재 로드된 데이터에 실제로 존재하는 카테고리/시즌만 버튼으로 노출
  const categoryOptions = useMemo(() => {
    const set = new Set(items.map(r => r.category).filter(c => c && c !== '-'))
    return Array.from(set).sort((a, b) => categorySortValue(a) - categorySortValue(b))
  }, [items])
  const seasonOptions = useMemo(() => {
    const set = new Set(items.map(r => r.season).filter(s => s && s !== '-'))
    return Array.from(set).sort((a, b) => seasonSortValue(b) - seasonSortValue(a)) // 최신 시즌(26SS)부터
  }, [items])

  // 정렬 & 카테고리/시즌 필터
  const filtered = useMemo(() => {
    let list = items.filter(r =>
      (categoryFilter === '전체' || r.category === categoryFilter) &&
      (seasonFilter === '전체' || r.season === seasonFilter)
    )
    list = [...list].sort((a, b) => {
      if (sortKey === 'default') {
        // 기본 정렬: 시즌은 최신순(26SS→25FW→25SS), 시즌 내에서는 아우터>상의>하의>액세서리 순
        const sv = seasonSortValue(b.season) - seasonSortValue(a.season)
        if (sv !== 0) return sv
        return categorySortValue(a.category) - categorySortValue(b.category)
      }
      const v = (a[sortKey] || 0) - (b[sortKey] || 0)
      return sortAsc ? v : -v
    })
    return list
  }, [items, sortKey, sortAsc, categoryFilter, seasonFilter])

  function handleSort(key: SortKey) {
    if (sortKey === key) setSortAsc(v => !v)
    else { setSortKey(key); setSortAsc(false) }
  }

  function SortIcon({ k }: { k: SortKey }) {
    if (sortKey !== k) return <span style={{ color: '#cbd5e1', marginLeft: 2 }}>↕</span>
    return <span style={{ color: '#4f46e5', marginLeft: 2 }}>{sortAsc ? '↑' : '↓'}</span>
  }

  // AI 분석 (Anthropic API)
  async function runAI() {
    setAiLoading(true)
    setAiResult('')
    const top = filtered.slice(0, 10).map(r =>
      `${r.name}(${r.option_name}): 판매${r.qty}개, 매출${formatKRW(r.gross)}, 마진${r.margin_pct}%`
    ).join('\n')
    const prompt = `다음은 패션 브랜드 헤오진의 ${dateFrom}~${dateTo} 기간 판매 데이터입니다:\n\n${top}\n\n위 데이터를 분석해서 BEST 아이템, 부진 아이템, 다음 시즌 제안을 한국어로 간결하게 알려주세요.`
    try {
      const res = await fetch('/api/ai-insight', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      })
      const data = await res.json()
      setAiResult(data.text || data.error || '분석 실패')
    } catch {
      setAiResult('AI 분석 중 오류가 발생했습니다.')
    }
    setAiLoading(false)
  }

  return (
    <div>
      {/* 헤더 */}
      <div className="page-header">
        <div>
          <h2 className="page-title">아이템 카테고리별 손익</h2>
          <p className="page-sub">기간별 판매 수량 · 매출 · 마진 분석</p>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
          {/* 플랫폼 탭 */}
          <div style={{ display: 'flex', background: '#f1f5f9', borderRadius: 12, padding: 4, gap: 2 }}>
            {[
              { label: '통합',   value: '전체',   color: '#4f46e5' },
              { label: '카페24', value: '카페24', color: '#10b981' },
              { label: '무신사', value: '무신사', color: '#3b82f6' },
              { label: 'WOO',    value: 'WOO',    color: '#8b5cf6' },
              { label: 'REKET',  value: 'REKET',  color: '#f43f5e' },
              { label: '클라만', value: '클라만', color: '#f59e0b' },
            ].map(p => (
              <button key={p.value} onClick={() => setChannel(p.value)}
                style={{ padding: '6px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', fontSize: 13, fontWeight: 600, transition: 'all 0.15s',
                  background: channel === p.value ? '#fff' : 'transparent',
                  color: channel === p.value ? p.color : '#94a3b8',
                  boxShadow: channel === p.value ? '0 1px 4px rgba(0,0,0,0.1)' : 'none',
                }}>
                {channel === p.value && <span style={{ width: 7, height: 7, borderRadius: '50%', background: p.color, display: 'inline-block', marginRight: 5, verticalAlign: 'middle' }}></span>}
                {p.label}
              </button>
            ))}
          </div>
          {/* 기간 선택 */}
        <div style={{ position: 'relative' }}>
          <button onClick={() => setShowDatePicker(v => !v)}
            style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '8px 16px', border: '1px solid #94a3b8', borderRadius: 10, background: '#fff', cursor: 'pointer', fontSize: 14, fontWeight: 600, color: '#475569' }}>
            📅 기간: {quickSel || `${dateFrom} ~ ${dateTo}`}
          </button>
          {showDatePicker && (
            <div style={{ position: 'absolute', top: 44, right: 0, zIndex: 100, background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, padding: 20, boxShadow: '0 8px 32px rgba(0,0,0,0.12)', width: 380 }}>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', marginBottom: 8 }}>빠른 선택</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {QUICK_PERIODS.map(q => (
                    <button key={q.label} onClick={() => { const r=q.fn(); setDateFrom(r.from); setDateTo(r.to); setQuickSel(q.label) }}
                      style={{ padding: '5px 12px', border: `1px solid ${quickSel===q.label?'#4f46e5':'#94a3b8'}`, borderRadius: 8, fontSize: 12, cursor: 'pointer', fontWeight: 600, background: quickSel===q.label?'#eef2ff':'#f8fafc', color: quickSel===q.label?'#4f46e5':'#64748b' }}>
                      {q.label}
                    </button>
                  ))}
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', marginBottom: 8 }}>연도 선택</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {yearOptions().map(y => {
                    const isCurrentYear = y === new Date().getFullYear()
                    const label = `${y}년`
                    const selected = quickSel === label
                    return (
                      <button key={y} onClick={() => {
                          const from = `${y}-01-01`
                          const to = isCurrentYear ? new Date().toISOString().slice(0,10) : `${y}-12-31`
                          setDateFrom(from); setDateTo(to); setQuickSel(label); setMonthPickerYear(y)
                        }}
                        style={{ padding: '5px 12px', border: `1px solid ${selected?'#4f46e5':'#94a3b8'}`, borderRadius: 8, fontSize: 12, cursor: 'pointer', fontWeight: 600, background: selected?'#eef2ff':'#f8fafc', color: selected?'#4f46e5':'#64748b' }}>
                        {label}
                      </button>
                    )
                  })}
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
                  <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8' }}>월 선택</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <button onClick={() => setMonthPickerYear(y => y - 1)}
                      style={{ width: 22, height: 22, border: '1px solid #94a3b8', borderRadius: 6, background: '#f8fafc', color: '#64748b', cursor: 'pointer', fontSize: 12, lineHeight: 1 }}>‹</button>
                    <span style={{ fontSize: 12, fontWeight: 700, color: '#475569', minWidth: 44, textAlign: 'center' }}>{monthPickerYear}년</span>
                    <button onClick={() => setMonthPickerYear(y => y + 1)}
                      style={{ width: 22, height: 22, border: '1px solid #94a3b8', borderRadius: 6, background: '#f8fafc', color: '#64748b', cursor: 'pointer', fontSize: 12, lineHeight: 1 }}>›</button>
                  </div>
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6 }}>
                  {Array.from({ length: 12 }, (_, i) => i + 1).map(m => {
                    const label = `${monthPickerYear}년 ${m}월`
                    const selected = quickSel === label
                    return (
                      <button key={m} onClick={() => {
                          const today = new Date().toISOString().slice(0,10)
                          const from = `${monthPickerYear}-${String(m).padStart(2,'0')}-01`
                          let to = `${monthPickerYear}-${String(m).padStart(2,'0')}-${String(lastDayOfMonth(monthPickerYear, m)).padStart(2,'0')}`
                          if (to > today) to = today
                          setDateFrom(from); setDateTo(to); setQuickSel(label)
                        }}
                        style={{ padding: '6px 0', border: `1px solid ${selected?'#4f46e5':'#94a3b8'}`, borderRadius: 8, fontSize: 12, cursor: 'pointer', fontWeight: 600, background: selected?'#eef2ff':'#f8fafc', color: selected?'#4f46e5':'#64748b' }}>
                        {m}월
                      </button>
                    )
                  })}
                </div>
              </div>
              <div style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: '#94a3b8', marginBottom: 8 }}>직접 입력</div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input type="date" value={dateFrom} onChange={e => { setDateFrom(e.target.value); setQuickSel('') }}
                    style={{ flex: 1, padding: '7px 10px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit' }} />
                  <span style={{ color: '#94a3b8' }}>~</span>
                  <input type="date" value={dateTo} onChange={e => { setDateTo(e.target.value); setQuickSel('') }}
                    style={{ flex: 1, padding: '7px 10px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit' }} />
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setShowDatePicker(false)}
                  style={{ padding: '7px 16px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, cursor: 'pointer', background: '#f8fafc', color: '#64748b', fontWeight: 600 }}>취소</button>
                <button onClick={() => setShowDatePicker(false)}
                  style={{ padding: '7px 16px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, cursor: 'pointer', fontWeight: 700 }}>적용</button>
              </div>
            </div>
          )}
          </div>
        </div>
      </div>

      {loading ? <div className="loading">로딩 중...</div> : (
        <>
          {/* KPI 상단 2줄 */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 12 }}>
            <KpiCard label="총 판매수량" value={`${totalQty.toLocaleString()}개`} sub={`취소 ${items.reduce((s,r)=>s+r.cancel_qty,0)}개 제외`} />
            <KpiCard label="총 매출" value={formatKRW(totalGross)} sub={`${items.length}개 품목`} />
            <KpiCard label="총 원가" value={formatKRW(totalCost)} sub="원가 합계" />
            <KpiCard label="총 마진" value={formatKRW(totalMargin)} sub={`마진율 ${totalGross > 0 ? Math.round((totalMargin/totalGross)*100) : 0}%`} color={totalMargin >= 0 ? '#059669' : '#e11d48'} />
          </div>
          {showYoY && (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 24 }}>
              <KpiCard label="전년 동기 판매수량" value={`${prevQty.toLocaleString()}개`}
                sub={<span style={{ color: diffQty >= 0 ? '#059669' : '#e11d48', fontWeight: 700 }}>{diffQty >= 0 ? '+' : ''}{diffQty}개 ({diffQtyPct >= 0 ? '+' : ''}{diffQtyPct}%)</span>} />
              <KpiCard label="전년 동기 매출" value={formatKRW(prevGross)}
                sub={<span style={{ color: diffGross >= 0 ? '#059669' : '#e11d48', fontWeight: 700 }}>{diffGross >= 0 ? '+' : ''}{formatKRW(diffGross)} ({diffGrossPct >= 0 ? '+' : ''}{diffGrossPct}%)</span>} />
              <KpiCard label="판매수량 증감" value={<span style={{ color: diffQty >= 0 ? '#059669' : '#e11d48', fontWeight: 800 }}>{diffQty >= 0 ? '+' : ''}{diffQty}개</span>}
                sub={`전년(${prevFrom(dateFrom)}~${prevFrom(dateTo)}) 대비 ${diffQtyPct >= 0 ? '+' : ''}${diffQtyPct}%`} />
              <KpiCard label="매출 증감" value={<span style={{ color: diffGross >= 0 ? '#059669' : '#e11d48', fontWeight: 800 }}>{diffGross >= 0 ? '+' : ''}{formatKRW(diffGross)}</span>}
                sub={`전년 대비 ${diffGrossPct >= 0 ? '+' : ''}${diffGrossPct}%`} />
            </div>
          )}

          {/* 베스트 10 상품 */}
          <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, overflow: 'hidden', marginBottom: 24 }}>
            <div style={{ padding: '14px 20px', background: '#f8fafc', borderBottom: '1px solid #94a3b8', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>🏆</span>
              <span style={{ fontWeight: 700, fontSize: 14 }}>베스트 10 상품</span>
              <span style={{ fontSize: 12, color: '#94a3b8' }}>판매수량 기준</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {['순위','시즌','제품명','카테고리','판매수량','매출금액','정산금액','원가(합)','마진','마진율'].map(h => (
                      <th key={h} style={{ padding: '10px 12px', textAlign: h==='제품명'||h==='카테고리'?'left':'center', borderBottom: '1px solid #94a3b8', fontSize: 11, color: '#94a3b8', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {[...items].sort((a,b) => b.qty - a.qty).slice(0,10).map((r, i) => {
                    const medals = ['🥇','🥈','🥉']
                    return (
                      <tr key={r.item_id} style={{ borderBottom: '1px solid #f1f5f9', background: i < 3 ? (i===0?'#fffbeb':i===1?'#f8fafc':'#fff') : '' }}>
                        <td style={{ padding: '12px 12px', textAlign: 'center', fontWeight: 800, fontSize: 16 }}>
                          {medals[i] || <span style={{ color: '#94a3b8', fontSize: 13 }}>{i+1}</span>}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                          <span style={{ background: '#f1f5f9', color: '#475569', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>{r.season}</span>
                        </td>
                        <td style={{ padding: '12px 12px' }}>
                          <div style={{ fontWeight: 600, color: '#1e293b' }}>{r.name}</div>
                          <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{r.option_name}</div>
                        </td>
                        <td style={{ padding: '12px 12px' }}>
                          <span style={{ background: '#eef2ff', color: '#4f46e5', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>{r.category}</span>
                        </td>
                        <td style={{ padding: '12px 12px', textAlign: 'center' }}>
                          <div style={{ fontWeight: 800, color: '#4f46e5', fontSize: 15 }}>{r.qty.toLocaleString()}개</div>
                        </td>
                        <td style={{ padding: '12px 12px', textAlign: 'right', fontWeight: 600 }}>{formatKRW(r.gross)}</td>
                        <td style={{ padding: '12px 12px', textAlign: 'right', color: '#059669', fontWeight: 600 }}>{formatKRW(r.net)}</td>
                        <td style={{ padding: '12px 12px', textAlign: 'right', color: '#64748b' }}>{formatKRW(r.cost)}</td>
                        <td style={{ padding: '12px 12px', textAlign: 'right', fontWeight: 700, color: r.margin>=0?'#059669':'#e11d48' }}>{formatKRW(r.margin)}</td>
                        <td style={{ padding: '12px 12px', textAlign: 'center' }}>
                          <span style={{ background: r.margin_pct>=40?'#dcfce7':r.margin_pct>=20?'#fff7ed':'#fef2f2', color: r.margin_pct>=40?'#059669':r.margin_pct>=20?'#d97706':'#e11d48', padding: '3px 8px', borderRadius: 6, fontSize: 12, fontWeight: 700 }}>
                            {r.margin_pct}%
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                  {items.length === 0 && (
                    <tr><td colSpan={10} style={{ textAlign: 'center', padding: 32, color: '#94a3b8' }}>데이터가 없습니다</td></tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* 카테고리 / 시즌 필터 (한 줄) */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8' }}>카테고리</span>
              {['전체', ...categoryOptions].map(c => (
                <button key={c} onClick={() => setCategoryFilter(c)}
                  style={{ padding: '5px 12px', border: `1px solid ${categoryFilter===c?'#4f46e5':'#94a3b8'}`, borderRadius: 8, fontSize: 12, cursor: 'pointer', fontWeight: 600, background: categoryFilter===c?'#eef2ff':'#f8fafc', color: categoryFilter===c?'#4f46e5':'#64748b' }}>
                  {c}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#94a3b8' }}>시즌</span>
              {['전체', ...seasonOptions].map(s => (
                <button key={s} onClick={() => setSeasonFilter(s)}
                  style={{ padding: '5px 12px', border: `1px solid ${seasonFilter===s?'#4f46e5':'#94a3b8'}`, borderRadius: 8, fontSize: 12, cursor: 'pointer', fontWeight: 600, background: seasonFilter===s?'#eef2ff':'#f8fafc', color: seasonFilter===s?'#4f46e5':'#64748b' }}>
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* 테이블 */}
          <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, overflow: 'hidden', marginBottom: 24 }}>
            <div style={{ padding: '14px 20px', background: '#f8fafc', borderBottom: '1px solid #94a3b8', fontWeight: 700, fontSize: 14 }}>
              제품별 상세
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    <th style={thStyle('center')}>시즌</th>
                    <th style={thStyle('left')}>카테고리</th>
                    <th style={thStyle('left')}>상품명</th>
                    <th style={thStyle('center')} onClick={() => handleSort('qty')}>판매수량 <SortIcon k="qty" /></th>
                    <th style={thStyle('right')} onClick={() => handleSort('gross')}>매출금액 <SortIcon k="gross" /></th>
                    <th style={thStyle('right')} onClick={() => handleSort('net')}>정산금액 <SortIcon k="net" /></th>
                    <th style={thStyle('right')} onClick={() => handleSort('cost')}>원가(합) <SortIcon k="cost" /></th>
                    <th style={thStyle('right')} onClick={() => handleSort('margin')}>마진 <SortIcon k="margin" /></th>
                    <th style={thStyle('center')} onClick={() => handleSort('cancel_qty')}>취소수량 <SortIcon k="cancel_qty" /></th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr><td colSpan={9} style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>데이터가 없습니다</td></tr>
                  ) : filtered.map((r, i) => {
                    return (
                      <tr key={r.item_id} style={{ borderBottom: '1px solid #f1f5f9', transition: 'background 0.1s' }}
                        onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                        onMouseLeave={e => (e.currentTarget.style.background = '')}>
                        <td style={{ padding: '8px 10px', textAlign: 'center' }}>
                          <span style={{ background: '#f1f5f9', color: '#475569', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>{r.season}</span>
                        </td>
                        <td style={{ padding: '12px 12px' }}>
                          <span style={{ background: '#eef2ff', color: '#4f46e5', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>{r.category}</span>
                        </td>
                        <td style={{ padding: '12px 16px', minWidth: 200 }}>
                          <div style={{ fontWeight: 600, color: '#1e293b' }}>{r.name}</div>
                          {r.sku && <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 2 }}>{r.sku} · {r.option_name}</div>}
                        </td>
                        <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                          <span style={{ fontWeight: 700, color: '#4f46e5', fontSize: 14 }}>{r.qty.toLocaleString()}개</span>
                        </td>
                        <td style={{ padding: '12px 10px', textAlign: 'right', fontWeight: 600 }}>{formatKRW(r.gross)}</td>
                        <td style={{ padding: '12px 10px', textAlign: 'right', color: '#059669', fontWeight: 600 }}>{formatKRW(r.net)}</td>
                        <td style={{ padding: '12px 10px', textAlign: 'right', color: '#64748b' }}>{formatKRW(r.cost)}</td>
                        <td style={{ padding: '12px 10px', textAlign: 'right' }}>
                          <span style={{ fontWeight: 700, color: r.margin >= 0 ? '#059669' : '#e11d48' }}>{formatKRW(r.margin)}</span>
                          <span style={{ fontSize: 11, color: '#94a3b8', marginLeft: 4 }}>({r.margin_pct}%)</span>
                        </td>
                        <td style={{ padding: '12px 10px', textAlign: 'center', color: '#94a3b8' }}>{r.cancel_qty}개</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* AI 추천 */}
          <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, overflow: 'hidden' }}>
            <div style={{ padding: '14px 20px', background: '#f8fafc', borderBottom: '1px solid #94a3b8', display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span>🤖</span>
                <span style={{ fontWeight: 700, fontSize: 14 }}>AI 추천</span>
                {!aiLoading && !aiResult && <span style={{ fontSize: 12, color: '#94a3b8' }}>{new Date().toLocaleDateString('ko-KR')} (자동)</span>}
              </div>
              <button onClick={runAI} disabled={aiLoading}
                style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 14px', border: '1px solid #94a3b8', borderRadius: 8, background: '#fff', cursor: aiLoading ? 'default' : 'pointer', fontSize: 13, fontWeight: 600, color: '#475569' }}>
                {aiLoading ? '분석 중...' : '🔄 다시 분석'}
              </button>
            </div>
            <div style={{ padding: 24, minHeight: 120 }}>
              {!aiResult && !aiLoading && (
                <div style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', paddingTop: 20 }}>
                  "다시 분석" 버튼을 누르면 AI가 현재 판매 데이터를 분석합니다.
                </div>
              )}
              {aiLoading && (
                <div style={{ color: '#94a3b8', fontSize: 13, textAlign: 'center', paddingTop: 20 }}>
                  <span className="spinner-inline"></span>AI가 데이터를 분석 중입니다...
                </div>
              )}
              {aiResult && (
                <div style={{ fontSize: 14, lineHeight: 1.8, color: '#374151', whiteSpace: 'pre-wrap' }}>
                  {aiResult}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function KpiCard({ label, value, sub, color }: { label: string; value: any; sub: any; color?: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 14, padding: 18 }}>
      <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || '#0f172a', marginBottom: 4 }}>{value}</div>
      <div style={{ fontSize: 12, color: '#94a3b8' }}>{sub}</div>
    </div>
  )
}

function prevFrom(date: string) {
  const d = new Date(date); d.setFullYear(d.getFullYear() - 1); return d.toISOString().slice(0,10)
}

const thStyle = (align: 'left'|'right'|'center') => ({
  padding: '10px 10px', textAlign: align as any,
  borderBottom: '1px solid #94a3b8', fontSize: 12,
  color: '#94a3b8', fontWeight: 700, cursor: 'pointer',
  whiteSpace: 'nowrap' as any, background: '#f8fafc',
  userSelect: 'none' as any,
})
