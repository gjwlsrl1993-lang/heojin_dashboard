'use client'

import { useEffect, useState, useRef } from 'react'
import * as XLSX from 'xlsx'
import { supabase } from '@/lib/supabase'

type Item = {
  id: number
  name: string
  sku: string
  category: string
  option_name: string
  cost_price: number
  sell_price: number
  image_url?: string
  initial_qty: number
  reorder_qty: number   // 뷰(inventory_summary)에서 이미 리오더 합계를 반영해 내려준다고 가정
  damaged_qty: number
  total_sold: number
  available_qty: number
  season?: string
}

type Reorder = {
  id: number
  item_id: number
  round_no: number
  qty: number
  reorder_date: string
  vendor: string | null
  memo: string | null
}

type SeedingRecord = {
  id: number
  item_id: number
  type: '시딩' | '협찬'
  qty: number
  returned_qty: number
  recipient: string | null
  sent_date: string
  memo: string | null
}

type SalesDetailData = {
  channels: { name: string; qty: number; revenue: number; net: number }[]
  totalQty: number
  totalRevenue: number
  totalNet: number
  totalCost: number
  totalProfit: number
}

const CATEGORIES = ['상의', '하의', '아우터', '원피스', '가방', '액세서리', '기타']
const SEASONS = ['25SS', '25FW', '26SS', '26FW', '27SS', '27FW', '28SS', '28FW']
const SIZES = ['F', 'XS', 'S', 'M', 'L', 'XL', '1', '2', '3', 'NONE']

// 옵션(사이즈)을 XS → S → M → L → XL 순으로 정렬하기 위한 기준 순서
const SIZE_ORDER = ['F', 'XS', 'S', 'M', 'L', 'XL', '1', '2', '3', 'NONE']
function optionSortValue(opt?: string): number {
  const idx = SIZE_ORDER.indexOf((opt || '').toUpperCase())
  return idx === -1 ? 999 : idx
}

// 원가/판매가를 30,950원처럼 전체 숫자 + 콤마로 표시 (formatKRW의 만원 단위 축약 대신)
function formatFullKRW(n: number): string {
  return (n || 0).toLocaleString('ko-KR') + '원'
}

// 오프라인 재고(클라만 등) 매칭용 정규화 — inventory_summary 뷰와 동일한 규칙:
// 스타일넘버는 trim+대문자+공백/하이픈/언더스코어 제거("JK #1 BK" = "JK #1BK"), 옵션은 '', 'NONE', 'F'를 전부 같은 값으로 취급
function normalizeSkuKey(v?: string): string {
  return (v || '').trim().toUpperCase().replace(/[\s\-_]/g, '')
}
function normalizeOptKey(v?: string): string {
  const t = (v || '').trim().toUpperCase()
  return (t === '' || t === 'NONE' || t === 'F') ? 'F' : t
}
function offlineMatchKey(sku?: string, option?: string): string {
  return `${normalizeSkuKey(sku)}__${normalizeOptKey(option)}`
}

// 시즌별로 배지 색을 다르게 표시하기 위한 팔레트
function seasonStyle(season?: string): { bg: string; color: string } {
  const map: Record<string, { bg: string; color: string }> = {
    '25SS': { bg: '#eff6ff', color: '#2563eb' },
    '25FW': { bg: '#fdf2f8', color: '#db2777' },
    '26SS': { bg: '#f0fdf4', color: '#059669' },
    '26FW': { bg: '#fff7ed', color: '#d97706' },
    '27SS': { bg: '#f5f3ff', color: '#7c3aed' },
    '27FW': { bg: '#fef2f2', color: '#e11d48' },
    '28SS': { bg: '#ecfeff', color: '#0891b2' },
    '28FW': { bg: '#fffbeb', color: '#b45309' },
  }
  return map[season || ''] || { bg: '#f1f5f9', color: '#475569' }
}

export default function InventoryPage() {
  const [items, setItems] = useState<Item[]>([])
  const [reorders, setReorders] = useState<Reorder[]>([])
  const [seedingRecords, setSeedingRecords] = useState<SeedingRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [selectedSeason, setSelectedSeason] = useState<string>('전체')
  const [selectedCategory, setSelectedCategory] = useState<string>('전체')
  const [showAddForm, setShowAddForm] = useState(false)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editValues, setEditValues] = useState<Partial<Item>>({})
  const [saving, setSaving] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [uploadingReorder, setUploadingReorder] = useState(false)
  const [dismissedLowStock, setDismissedLowStock] = useState<Set<number>>(new Set())
  const [showLowStockModal, setShowLowStockModal] = useState(false)

  // 리오더 숫자 클릭 시 뜨는 리오더 이력 팝업 상태
  const [reorderDetailItem, setReorderDetailItem] = useState<Item | null>(null)
  // 리오더 이력 팝업 안에서 직접 입력하는 새 리오더 폼 상태
  const [newReorder, setNewReorder] = useState({ option_name: '', round_no: '', qty: '', reorder_date: '', vendor: '', memo: '' })
  const [savingReorder, setSavingReorder] = useState(false)

  // 배수/총판매/총재고/온라인재고 정렬 상태 — 정렬 중일 때는 같은 스타일넘버 병합(rowSpan)을 끄고 행별로 보여줌
  const [sortBy, setSortBy] = useState<'multiplier' | 'total_sold' | 'total_stock' | 'online_stock' | null>(null)
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')

  // 오프라인 매장(클라만 등) 재고 — 매장별로 나눠서 관리, 나중에 매장이 늘어나면 배열에 추가만 하면 됨
  const [offlineStores, setOfflineStores] = useState<{ name: string; qtyMap: Map<string, number> }[]>([])
  const [offlineDetailItem, setOfflineDetailItem] = useState<Item | null>(null)

  // 총판매 숫자 클릭 시 뜨는 매출 상세 팝업 상태
  const [salesDetailItem, setSalesDetailItem] = useState<Item | null>(null)
  const [salesDetailLoading, setSalesDetailLoading] = useState(false)
  const [salesDetailData, setSalesDetailData] = useState<SalesDetailData | null>(null)

  useEffect(() => {
    try {
      const saved = localStorage.getItem('heojin_dismissed_low_stock')
      if (saved) setDismissedLowStock(new Set(JSON.parse(saved)))
    } catch {}
  }, [])

  function dismissLowStock(id: number) {
    setDismissedLowStock(prev => {
      const next = new Set(prev)
      next.add(id)
      try { localStorage.setItem('heojin_dismissed_low_stock', JSON.stringify(Array.from(next))) } catch {}
      return next
    })
  }

  const [newItem, setNewItem] = useState({
    name: '', sku: '', season: '', category: '상의', option_name: 'F',
    cost_price: '', sell_price: '', image_url: ''
  })

  const excelInputRef = useRef<HTMLInputElement | null>(null)
  const reorderExcelInputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => { loadItems(); loadReorders(); loadSeedingRecords(); loadOfflineStock() }, [])

  // 오프라인 매장 재고 = 입고 수량 - 판매 수량 (스타일넘버+옵션 기준)
  // 지금은 클라만만 있지만, 다른 오프라인 매장이 생기면 여기 배열에 추가하면 됨
  async function loadOfflineStock() {
    const { data: stockRows } = await supabase.from('claman_stock_lines').select('style_no, option_name')
    const { data: soldRows } = await supabase.from('claman_settlement_lines').select('style_no, option_name, sale_amount')

    const stockCount = new Map<string, number>()
    ;(stockRows || []).forEach((r: any) => {
      const k = offlineMatchKey(r.style_no, r.option_name)
      stockCount.set(k, (stockCount.get(k) || 0) + 1)
    })

    const soldCount = new Map<string, number>()
    ;(soldRows || []).forEach((r: any) => {
      const k = offlineMatchKey(r.style_no, r.option_name)
      const delta = (r.sale_amount || 0) >= 0 ? 1 : -1
      soldCount.set(k, (soldCount.get(k) || 0) + delta)
    })

    const netMap = new Map<string, number>()
    const allKeys = new Set<string>([...stockCount.keys(), ...soldCount.keys()])
    allKeys.forEach(k => {
      netMap.set(k, (stockCount.get(k) || 0) - (soldCount.get(k) || 0))
    })

    setOfflineStores([{ name: '클라만', qtyMap: netMap }])
  }

  // 이 아이템이 오프라인 매장별로 몇 장 있는지 (매장이 늘어나도 그대로 동작)
  function offlineBreakdownFor(item: Item): { name: string; qty: number }[] {
    const key = offlineMatchKey(item.sku, item.option_name)
    return offlineStores.map(store => ({ name: store.name, qty: store.qtyMap.get(key) || 0 }))
  }
  function offlineTotalFor(item: Item): number {
    return offlineBreakdownFor(item).reduce((s, r) => s + r.qty, 0)
  }

  // 배수/총판매/총재고/온라인재고 정렬 버튼 클릭 시: 없음 -> 내림차순 -> 오름차순 -> 없음 순으로 순환
  function toggleSort(key: 'multiplier' | 'total_sold' | 'total_stock' | 'online_stock') {
    if (sortBy !== key) { setSortBy(key); setSortDir('desc') }
    else if (sortDir === 'desc') { setSortDir('asc') }
    else { setSortBy(null); setSortDir('desc') }
  }

  function sortValueFor(item: Item, key: 'multiplier' | 'total_sold' | 'total_stock' | 'online_stock'): number {
    switch (key) {
      case 'multiplier': return item.cost_price > 0 ? item.sell_price / item.cost_price : 0
      case 'total_sold': return item.total_sold || 0
      case 'total_stock': return computeAvailable(item)
      case 'online_stock': return computeAvailable(item) - offlineTotalFor(item)
      default: return 0
    }
  }

  async function loadItems() {
    setLoading(true)
    const { data, error } = await supabase
      .from('inventory_summary')
      .select('*')
      .order('name')
    if (error) {
      console.error('inventory_summary load error:', JSON.stringify(error, null, 2))
      console.error('inventory_summary load error message:', error.message, 'code:', error.code, 'details:', error.details, 'hint:', error.hint)
    }
    setItems(data || [])
    setLoading(false)
  }

  async function loadReorders() {
    const { data } = await supabase
      .from('reorders')
      .select('*')
      .order('reorder_date', { ascending: false })
    setReorders(data || [])
  }

  async function loadSeedingRecords() {
    const { data } = await supabase
      .from('seeding_records')
      .select('*')
      .order('sent_date', { ascending: false })
    setSeedingRecords(data || [])
  }

  function seedingFor(itemId: number, type: '시딩' | '협찬') {
    return seedingRecords.filter(r => r.item_id === itemId && r.type === type)
  }

  // 시딩 총량 (돌려받지 않음 — 나가면 그대로 재고 차감)
  function seedingTotal(itemId: number) {
    return seedingFor(itemId, '시딩').reduce((s, r) => s + r.qty, 0)
  }

  // 협찬 미회수 수량 (returned_qty만큼 빼줘서, 회수되면 그만큼 재고에 다시 반영됨)
  function sponsorshipOutstanding(itemId: number) {
    return seedingFor(itemId, '협찬').reduce((s, r) => s + (r.qty - r.returned_qty), 0)
  }

  async function addSeedingRecord(itemId: number, type: '시딩' | '협찬') {
    const qtyStr = window.prompt(`${type}으로 내보낼 수량을 입력하세요`)
    if (!qtyStr) return
    const qty = parseInt(qtyStr)
    if (!qty || qty <= 0) { alert('올바른 수량을 입력해주세요.'); return }
    const recipient = window.prompt('받는 사람/업체 (선택 사항, 취소해도 됨)') || null
    await supabase.from('seeding_records').insert({
      item_id: itemId,
      type,
      qty,
      recipient,
      sent_date: new Date().toISOString().slice(0, 10),
    })
    loadSeedingRecords()
  }

  async function returnSponsorship(itemId: number) {
    const outstandingRecords = seedingFor(itemId, '협찬').filter(r => r.qty - r.returned_qty > 0)
    if (outstandingRecords.length === 0) { alert('회수할 협찬 건이 없습니다.'); return }
    const totalOutstanding = outstandingRecords.reduce((s, r) => s + (r.qty - r.returned_qty), 0)
    const qtyStr = window.prompt(`회수할 수량을 입력하세요 (미회수 ${totalOutstanding}개 중)`)
    if (!qtyStr) return
    let qty = parseInt(qtyStr)
    if (!qty || qty <= 0) { alert('올바른 수량을 입력해주세요.'); return }
    if (qty > totalOutstanding) { alert('미회수 수량보다 많이 회수할 수 없습니다.'); return }

    // 오래된 협찬 건부터 순서대로 회수 처리
    for (const rec of outstandingRecords) {
      if (qty <= 0) break
      const remain = rec.qty - rec.returned_qty
      const applyQty = Math.min(remain, qty)
      await supabase.from('seeding_records').update({ returned_qty: rec.returned_qty + applyQty }).eq('id', rec.id)
      qty -= applyQty
    }
    loadSeedingRecords()
    loadItems()
  }

  async function addItem() {
    if (!newItem.name) return
    if (!newItem.sku.trim()) { alert('스타일넘버를 입력해주세요. 리오더/정산 매칭의 기준이 되는 값입니다.'); return }
    // 스타일넘버는 상품 단위로 같아도 되고(사이즈별로 옵션만 다름), 스타일넘버+옵션 조합이 완전히 같을 때만 중복으로 봄
    const dup = items.find(i => i.sku === newItem.sku.trim() && i.option_name === newItem.option_name)
    if (dup) { alert('이미 같은 스타일넘버+옵션 조합이 등록되어 있습니다.'); return }
    setSaving(true)
    const { data: itemData, error } = await supabase.from('items').insert({
      name: newItem.name,
      sku: newItem.sku.trim(),
      season: newItem.season || null,
      category: newItem.category,
      option_name: newItem.option_name,
      cost_price: parseInt(newItem.cost_price) || 0,
      sell_price: parseInt(newItem.sell_price) || 0,
    }).select().single()

    if (!error && itemData) {
      await supabase.from('inventory').insert({
        item_id: itemData.id,
        initial_qty: 0, reorder_qty: 0, damaged_qty: 0,
      })
    }
    setSaving(false)
    setShowAddForm(false)
    setNewItem({ name: '', sku: '', season: '', category: '상의', option_name: 'F', cost_price: '', sell_price: '', image_url: '' })
    loadItems()
  }

  async function saveEdit(id: number) {
    setSaving(true)
    const checkSku = editValues.sku
    const checkOption = editValues.option_name
    if (checkSku && items.some(i => i.sku === checkSku && i.option_name === checkOption && i.id !== id)) {
      alert('이미 같은 스타일넘버+옵션 조합이 등록되어 있습니다.'); setSaving(false); return
    }
    const { error: itemErr } = await supabase.from('items').update({
      name: editValues.name,
      sku: editValues.sku,
      season: editValues.season,
      category: editValues.category,
      option_name: editValues.option_name,
      cost_price: editValues.cost_price,
      sell_price: editValues.sell_price,
    }).eq('id', id)

    if (itemErr) {
      console.error('items update error:', itemErr)
      alert('저장 실패: ' + (itemErr.message || JSON.stringify(itemErr)))
      setSaving(false)
      return
    }

    const { error: invErr } = await supabase.from('inventory').upsert({
      item_id: id,
      initial_qty: editValues.initial_qty || 0,
      damaged_qty: editValues.damaged_qty || 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'item_id' })

    if (invErr) {
      const detail = `code=${invErr.code || '-'} message=${invErr.message || '-'} details=${invErr.details || '-'} hint=${invErr.hint || '-'}`
      console.error('inventory upsert error:', detail, invErr)
      alert('재고 수량 저장 실패: ' + detail)
    }

    setSaving(false)
    setEditingId(null)
    loadItems()
  }

  async function deleteItem(id: number) {
    if (!confirm('상품을 삭제할까요? 연결된 판매/리오더 데이터도 삭제됩니다.')) return
    await supabase.from('items').delete().eq('id', id)
    loadItems()
    loadReorders()
  }

  // 전체 상품 삭제 — 다시 처음부터 등록할 때 초기화용. 되돌릴 수 없어서 두 번 확인.
  async function deleteAllItems() {
    if (!confirm('정말 모든 상품을 삭제할까요?\n재고/리오더/시딩/협찬 기록도 전부 함께 삭제되며 되돌릴 수 없습니다.')) return
    if (!confirm('한 번 더 확인합니다. 전체 삭제를 진행할까요?')) return
    setSaving(true)
    await supabase.from('seeding_records').delete().neq('id', 0)
    await supabase.from('reorders').delete().neq('id', 0)
    await supabase.from('inventory').delete().neq('item_id', 0)
    await supabase.from('items').delete().neq('id', 0)
    setSaving(false)
    loadItems()
    loadReorders()
    loadSeedingRecords()
  }

  // ------------------------------------------------------------------
  // 리오더 관련
  // ------------------------------------------------------------------
  async function deleteReorder(id: number) {
    if (!confirm('이 리오더 기록을 삭제할까요?')) return
    await supabase.from('reorders').delete().eq('id', id)
    loadReorders()
    loadItems()
  }

  function reordersFor(itemId: number) {
    return reorders.filter(r => r.item_id === itemId)
  }

  // 리오더 이력 팝업 안 입력폼에서 "추가" 눌렀을 때 — 선택한 옵션(사이즈)의 item_id로 리오더 등록
  async function addReorderInline(sku: string) {
    if (!newReorder.option_name) { alert('옵션(사이즈)을 선택해주세요.'); return }
    if (!newReorder.qty || Number(newReorder.qty) <= 0) { alert('수량을 입력해주세요.'); return }
    if (!newReorder.reorder_date) { alert('일자를 입력해주세요.'); return }
    const target = items.find(i => i.sku === sku && i.option_name === newReorder.option_name)
    if (!target) { alert('해당 옵션의 상품을 찾을 수 없습니다.'); return }
    setSavingReorder(true)
    const { error } = await supabase.from('reorders').insert({
      item_id: target.id,
      round_no: Number(newReorder.round_no) || 1,
      qty: Number(newReorder.qty),
      reorder_date: newReorder.reorder_date,
      vendor: newReorder.vendor.trim() || null,
      memo: newReorder.memo.trim() || null,
    })
    setSavingReorder(false)
    if (error) { alert('리오더 등록 실패: ' + error.message); return }
    setNewReorder({ option_name: '', round_no: '', qty: '', reorder_date: '', vendor: '', memo: '' })
    loadReorders()
    loadItems()
  }

  // 같은 스타일넘버(같은 상품)의 모든 옵션(사이즈)을 합쳐서 리오더 이력을 보여주기 위한 헬퍼
  // 각 이력에 어느 옵션의 리오더인지 표시할 수 있도록 option_name을 함께 반환
  function reordersForSku(sku: string) {
    const itemIds = items.filter(i => i.sku === sku).map(i => i.id)
    return reorders
      .filter(r => itemIds.includes(r.item_id))
      .map(r => ({ ...r, option_name: items.find(i => i.id === r.item_id)?.option_name || '-' }))
  }

  // 실제 가용 재고 = 제작수량 + 리오더 합계 - 총판매 - 시딩 - 협찬(미회수) - 수선불가
  // (Supabase 뷰의 available_qty는 리오더/시딩/협찬을 반영 못 하므로 여기서 다시 계산)
  function computeAvailable(item: Item): number {
    const reorderTotal = reordersFor(item.id).reduce((s, r) => s + r.qty, 0)
    return (item.initial_qty || 0)
      + reorderTotal
      - (item.total_sold || 0)
      - seedingTotal(item.id)
      - sponsorshipOutstanding(item.id)
      - (item.damaged_qty || 0)
  }

  // ------------------------------------------------------------------
  // 매출 상세 팝업 (총판매 숫자 클릭 시) — 무신사/자사몰 정산 데이터를
  // 이 아이템의 스타일넘버+옵션으로 매칭해서 매출액/순매출액/순수익을 계산
  // ------------------------------------------------------------------
  function openSalesDetail(item: Item) {
    setSalesDetailItem(item)
    setSalesDetailData(null)
    setSalesDetailLoading(true)
    loadSalesDetail(item)
  }

  async function loadSalesDetail(item: Item) {
    // 뷰(inventory_summary)와 동일하게 trim + 대문자로 정규화해서 매칭 —
    // ilike만 쓰면 스타일넘버/옵션에 붙은 앞뒤 공백 차이 때문에 매칭이 빠지는 행이 생김.
    // 정산 테이블에는 옵션 없는 상품이 'NONE' 또는 빈 문자열로 저장되는데, items 쪽엔 같은
    // 상품이 'F'(프리사이즈)로 등록돼 있는 경우가 많아 '', 'NONE', 'F'를 전부 같은 값으로 취급
    const skuKey = normalizeSkuKey(item.sku)
    const optKey = normalizeOptKey(item.option_name)
    const isMatch = (r: any) =>
      normalizeSkuKey(r.style_no) === skuKey &&
      normalizeOptKey(r.option_name) === optKey

    const [musinsaRes, cafe24Res, wooRes, reketRes, clamanRes] = await Promise.all([
      supabase.from('musinsa_settlement_lines').select('style_no, option_name, qty, sale_amount, revenue_ao, final_amount'),
      supabase.from('cafe24_settlement_lines').select('style_no, option_name, sale_amount, discount_amount'),
      supabase.from('woo_settlement_lines').select('style_no, option_name, sale_amount, discount_amount'),
      supabase.from('reket_settlement_lines').select('style_no, option_name, sale_amount, discount_amount'),
      supabase.from('claman_settlement_lines').select('style_no, option_name, sale_amount'),
    ])

    if (musinsaRes.error) console.error('musinsa_settlement_lines load error:', musinsaRes.error)
    if (cafe24Res.error) console.error('cafe24_settlement_lines load error:', cafe24Res.error)
    if (wooRes.error) console.error('woo_settlement_lines load error:', wooRes.error)
    if (reketRes.error) console.error('reket_settlement_lines load error:', reketRes.error)
    if (clamanRes.error) console.error('claman_settlement_lines load error:', clamanRes.error)

    const musinsaRows: any[] = (musinsaRes.data || []).filter(isMatch)
    const cafe24Rows: any[] = (cafe24Res.data || []).filter(isMatch)
    const wooRows: any[] = (wooRes.data || []).filter(isMatch)
    const reketRows: any[] = (reketRes.data || []).filter(isMatch)
    const clamanRows: any[] = (clamanRes.data || []).filter(isMatch)

    // 매출액/순매출액은 "판매된 것"만 반영 — 환불(반품) 행은 매출액 계산에서 제외.
    // 판매수량(qty)은 기존처럼 환불을 차감한 순수량을 그대로 사용.
    const isSoldRow = (r: any) => (r.sale_amount || 0) >= 0

    const musinsaSoldRows = musinsaRows.filter(isSoldRow)
    const musinsaQty = musinsaRows.reduce((s, r) => s + (r.qty || 0), 0)
    // "매출액"은 무신사 정산 테이블의 revenue_ao(AO 매출액) 컬럼 기준 — sale_amount(판매금액)와는 다른 값
    const musinsaRevenue = musinsaSoldRows.reduce((s, r) => s + (r.revenue_ao || 0), 0)
    const musinsaNet = musinsaSoldRows.reduce((s, r) => s + (r.final_amount || 0), 0)

    // 자사몰/WOO는 수량 컬럼이 없어 1행 = 1개, 판매금액이 음수면 환불(-1)로 계산
    const cafe24SoldRows = cafe24Rows.filter(isSoldRow)
    const cafe24Qty = cafe24Rows.reduce((s, r) => s + ((r.sale_amount || 0) >= 0 ? 1 : -1), 0)
    const cafe24Revenue = cafe24SoldRows.reduce((s, r) => s + ((r.sale_amount || 0) - (r.discount_amount || 0)), 0)
    const cafe24Net = cafe24Revenue // 자사몰은 별도 수수료 컬럼이 없어 실결제 금액을 그대로 순매출로 봄

    const wooSoldRows = wooRows.filter(isSoldRow)
    const wooQty = wooRows.reduce((s, r) => s + ((r.sale_amount || 0) >= 0 ? 1 : -1), 0)
    const wooRevenue = wooSoldRows.reduce((s, r) => s + (r.sale_amount || 0), 0) // WOO는 이미 할인 반영된 결제금액을 직접 입력
    const wooFee = Math.round(wooRevenue * 0.40) // WOO 입점 수수료 40% (woo-page.tsx FEE_RATE와 동일)
    const wooNet = wooRevenue - wooFee

    // REKET은 할인율에 따라 수수료가 슬라이딩(기본 30%, 할인 10%마다 -1%p, 0% 밑으로는 안 내려감) — reket-page.tsx와 동일 로직
    const reketSoldRows = reketRows.filter(isSoldRow)
    const reketQty = reketRows.reduce((s, r) => s + ((r.sale_amount || 0) >= 0 ? 1 : -1), 0)
    const reketRevenue = reketSoldRows.reduce((s, r) => s + (r.sale_amount || 0), 0)
    const reketNet = reketSoldRows.reduce((s, r) => {
      const sale = r.sale_amount || 0
      const discount = r.discount_amount || 0
      const preAmount = sale + discount
      const discountRate = preAmount > 0 ? discount / preAmount : 0
      const feeRate = Math.max(0, 0.30 - Math.floor((discountRate * 100) / 10) * 0.01)
      const fee = Math.round(sale * feeRate)
      return s + (sale - fee)
    }, 0)

    // 클라만은 위탁 판매, 수수료 고정 30% — claman-page.tsx와 동일
    const clamanSoldRows = clamanRows.filter(isSoldRow)
    const clamanQty = clamanRows.reduce((s, r) => s + ((r.sale_amount || 0) >= 0 ? 1 : -1), 0)
    const clamanRevenue = clamanSoldRows.reduce((s, r) => s + (r.sale_amount || 0), 0)
    const clamanFee = Math.round(clamanRevenue * 0.30)
    const clamanNet = clamanRevenue - clamanFee

    const totalQty = musinsaQty + cafe24Qty + wooQty + reketQty + clamanQty
    const totalRevenue = musinsaRevenue + cafe24Revenue + wooRevenue + reketRevenue + clamanRevenue
    const totalNet = musinsaNet + cafe24Net + wooNet + reketNet + clamanNet
    const totalCost = (item.cost_price || 0) * totalQty
    const totalProfit = totalNet - totalCost

    setSalesDetailData({
      channels: [
        { name: '무신사', qty: musinsaQty, revenue: musinsaRevenue, net: musinsaNet },
        { name: '자사몰', qty: cafe24Qty, revenue: cafe24Revenue, net: cafe24Net },
        { name: 'WOO', qty: wooQty, revenue: wooRevenue, net: wooNet },
        { name: 'REKET', qty: reketQty, revenue: reketRevenue, net: reketNet },
        { name: '클라만', qty: clamanQty, revenue: clamanRevenue, net: clamanNet },
      ],
      totalQty, totalRevenue, totalNet, totalCost, totalProfit,
    })
    setSalesDetailLoading(false)
  }

  // ------------------------------------------------------------------
  // 엑셀 업로드 (재고 등록 시트 + 리오더 등록 시트를 한 파일에서 함께 처리)
  // ------------------------------------------------------------------
  async function processReorderSheet(wb: XLSX.WorkBook) {
    let added = 0
    let skipped = 0
    const sheetName = wb.SheetNames.includes('리오더 등록') ? '리오더 등록' : wb.SheetNames[0]
    const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName])
    const { data: allItems } = await supabase.from('items').select('id, sku, option_name')

    for (const row of rows) {
      const styleNo = row['스타일넘버']?.toString().trim()
      const qty = Number(row['리오더수량'])
      if (!styleNo || !qty) { skipped++; continue }
      const optionName = row['옵션']?.toString().trim() || 'F'

      // 스타일넘버만으로 매칭하면 같은 스타일넘버의 여러 옵션(사이즈) 중 하나로만 전부 몰림 —
      // 반드시 스타일넘버+옵션 조합으로 매칭해야 사이즈별로 정확히 나뉨
      let match = allItems?.find(i => i.sku === styleNo && i.option_name === optionName)
      if (!match) match = allItems?.find(i => i.sku === styleNo) // 옵션이 정확히 안 맞으면 스타일넘버만으로라도 폴백
      if (!match) { skipped++; continue }

      const roundNo = Number(row['차수']) || 1

      let reorderDate = new Date().toISOString().slice(0, 10)
      const rawDate = row['일자'] ?? row['날짜']
      if (rawDate) {
        if (rawDate instanceof Date && !isNaN(rawDate.getTime())) {
          reorderDate = rawDate.toISOString().slice(0, 10)
        } else if (typeof rawDate === 'number') {
          reorderDate = XLSX.SSF.format('yyyy-mm-dd', rawDate)
        } else {
          const parsed = new Date(String(rawDate).trim().replace(/\./g, '-').replace(/\/g/, '-'))
          if (!isNaN(parsed.getTime())) {
            reorderDate = parsed.toISOString().slice(0, 10)
          }
          // 파싱 실패하면 오늘 날짜로 대체하고 계속 진행 (전체 업로드를 막지 않음)
        }
      }

      const { error: reorderInsertErr } = await supabase.from('reorders').insert({
        item_id: match.id,
        round_no: roundNo,
        qty,
        reorder_date: reorderDate,
        vendor: row['업체']?.toString().trim() || null,
        memo: row['메모']?.toString().trim() || null,
      })
      if (reorderInsertErr) {
        console.error('reorders insert error:', reorderInsertErr)
        skipped++
        continue
      }
      added++
    }
    return { added, skipped }
  }

  async function handleExcelUpload(file: File) {
    setUploading(true)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })

      let addedItems = 0
      let skipped = 0

      // --- 시트 1: 재고 등록 ---
      if (wb.SheetNames.includes('재고 등록')) {
        const rows: any[] = XLSX.utils.sheet_to_json(wb.Sheets['재고 등록'])
        const { data: existing } = await supabase.from('items').select('sku, option_name')
        // 스타일넘버만으로 중복을 판단하면 같은 스타일넘버의 다른 사이즈(옵션)가 전부 건너뛰어짐 —
        // 반드시 "스타일넘버+옵션" 조합 기준으로 중복을 체크해야 함
        const existingCombos = new Set((existing || []).map(i => `${i.sku}__${i.option_name}`))

        for (const row of rows) {
          const name = row['상품명']?.toString().trim()
          const styleNo = row['스타일넘버']?.toString().trim()
          if (!name || !styleNo) { skipped++; continue }
          const optionName = row['옵션']?.toString().trim() || 'F'
          const comboKey = `${styleNo}__${optionName}`
          if (existingCombos.has(comboKey)) { skipped++; continue } // 같은 스타일넘버+옵션 조합만 중복으로 취급
          existingCombos.add(comboKey)

          const { data: itemData, error } = await supabase.from('items').insert({
            name,
            sku: styleNo,
            season: row['시즌']?.toString().trim() || null,
            category: row['카테고리']?.toString().trim() || '기타',
            option_name: optionName,
            cost_price: Number(row['원가']) || 0,
            sell_price: Number(row['판매가']) || 0,
          }).select().single()

          if (!error && itemData) {
            await supabase.from('inventory').insert({
              item_id: itemData.id,
              initial_qty: Number(row['제작수량']) || 0,
              damaged_qty: 0,
            })
            addedItems++
          } else {
            skipped++
          }
        }
      }

      // --- 시트 2: 리오더 등록 (스타일넘버로 기존 아이템 매칭) ---
      let addedReorders = 0
      if (wb.SheetNames.includes('리오더 등록')) {
        const result = await processReorderSheet(wb)
        addedReorders = result.added
        skipped += result.skipped
      }

      alert(`업로드 완료\n신규 상품 ${addedItems}건 / 리오더 ${addedReorders}건 등록\n건너뜀 ${skipped}건`)
      loadItems()
      loadReorders()
    } catch (e: any) {
      console.error(e)
      alert('엑셀 처리 중 오류가 발생했습니다.\n' + (e?.message || String(e)))
    } finally {
      setUploading(false)
      if (excelInputRef.current) excelInputRef.current.value = ''
    }
  }

  // 리오더 관리 섹션 전용 업로드 — "리오더 등록" 시트만 처리
  async function handleReorderExcelUpload(file: File) {
    setUploadingReorder(true)
    try {
      const buf = await file.arrayBuffer()
      const wb = XLSX.read(buf, { type: 'array' })
      const { added, skipped } = await processReorderSheet(wb)
      alert(`리오더 업로드 완료\n등록 ${added}건 / 건너뜀 ${skipped}건`)
      loadReorders()
      loadItems()
    } catch (e: any) {
      console.error(e)
      alert('엑셀 처리 중 오류가 발생했습니다.\n' + (e?.message || String(e)))
    } finally {
      setUploadingReorder(false)
      if (reorderExcelInputRef.current) reorderExcelInputRef.current.value = ''
    }
  }


  // 시즌 문자열(예: 26FW)을 최신순 정렬용 숫자로 변환 — 같은 연도면 FW가 SS보다 나중(최신)
  function seasonSortValue(season?: string): number {
    if (!season) return -1
    const m = season.match(/^(\d{2})(SS|FW)$/)
    if (!m) return -1
    const year = parseInt(m[1])
    const half = m[2] === 'FW' ? 1 : 0
    return year * 2 + half
  }

  const filtered = items
    .filter(r => {
      const matchSearch = !search || r.name?.includes(search) || r.category?.includes(search) ||
        r.sku?.includes(search) || r.option_name?.includes(search)
      const matchSeason = selectedSeason === '전체' || r.season === selectedSeason
      const matchCategory = selectedCategory === '전체' || r.category === selectedCategory
      return matchSearch && matchSeason && matchCategory
    })
    .sort((a, b) => {
      // 배수/총판매/총재고/온라인재고 정렬 버튼이 눌려있으면 그 기준으로 정렬 (그룹 병합은 꺼짐)
      if (sortBy) {
        const va = sortValueFor(a, sortBy)
        const vb = sortValueFor(b, sortBy)
        const diff = sortDir === 'asc' ? va - vb : vb - va
        if (diff !== 0) return diff
        return a.name.localeCompare(b.name)
      }
      const seasonDiff = seasonSortValue(b.season) - seasonSortValue(a.season) // 최신 시즌 먼저
      if (seasonDiff !== 0) return seasonDiff
      const skuA = a.sku || ''
      const skuB = b.sku || ''
      if (skuA !== skuB) return skuA.localeCompare(skuB) // 같은 시즌 안에서는 스타일넘버순 (같은 상품 그룹 병합의 기준)
      const optionDiff = optionSortValue(a.option_name) - optionSortValue(b.option_name) // 같은 스타일넘버 안에서는 XS→S→M→L→XL 순
      if (optionDiff !== 0) return optionDiff
      return a.name.localeCompare(b.name)
    })

  const filteredStockQty = filtered.reduce((s, r) => s + computeAvailable(r), 0)
  const filteredStockValue = filtered.reduce((s, r) => s + computeAvailable(r) * (r.cost_price || 0), 0)
  // SKU 개수는 옵션(사이즈)별로 나눈 행 수가 아니라, 스타일넘버 기준 고유 개수로 셈
  const filteredSkuCount = new Set(filtered.map(r => r.sku)).size

  const totalItems = new Set(items.map(r => r.sku)).size
  const totalStock = items.reduce((s, r) => s + computeAvailable(r), 0)
  const lowStockItems = items.filter(r => computeAvailable(r) <= 5 && !dismissedLowStock.has(r.id))

  return (
    <div>
      {/* 헤더 */}
      <div className="page-header">
        <div>
          <h2 className="page-title">통합 재고 수동 제어판</h2>
          <p className="page-sub">상품 등록 · 이미지 · 재고 수량 · 리오더 이력 관리</p>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input placeholder="상품명 / SKU / 카테고리 검색..." value={search}
            onChange={e => setSearch(e.target.value)}
            style={{ padding: '8px 12px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', width: 220 }} />
          <input ref={excelInputRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleExcelUpload(f) }} />
          <button onClick={() => excelInputRef.current?.click()} disabled={uploading}
            style={{ padding: '9px 16px', border: '1px solid #94a3b8', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#475569' }}>
            {uploading ? '업로드 중...' : '📤 엑셀 업로드'}
          </button>
          <input ref={reorderExcelInputRef} type="file" accept=".xlsx,.xls" style={{ display: 'none' }}
            onChange={e => { const f = e.target.files?.[0]; if (f) handleReorderExcelUpload(f) }} />
          <button onClick={() => reorderExcelInputRef.current?.click()} disabled={uploadingReorder}
            style={{ padding: '9px 16px', border: '1px solid #94a3b8', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#475569' }}>
            {uploadingReorder ? '업로드 중...' : '📤 리오더 업로드'}
          </button>
          <button onClick={deleteAllItems} disabled={saving}
            style={{ padding: '9px 16px', border: '1px solid #fecdd3', borderRadius: 8, background: '#fff', cursor: 'pointer', fontSize: 13, fontWeight: 700, color: '#e11d48' }}>
            🗑 전체 삭제
          </button>
        </div>
      </div>

      {/* 시즌 드롭다운 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 16, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 600 }}>시즌:</span>
        <select value={selectedSeason} onChange={e => setSelectedSeason(e.target.value)}
          style={{ padding: '7px 12px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: '#fff', color: '#1e293b', fontWeight: 600, cursor: 'pointer', minWidth: 100 }}>
          <option value="전체">전체</option>
          {SEASONS.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span style={{ fontSize: 12, color: '#94a3b8', fontWeight: 600, marginLeft: 8 }}>카테고리:</span>
        <select value={selectedCategory} onChange={e => setSelectedCategory(e.target.value)}
          style={{ padding: '7px 12px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: '#fff', color: '#1e293b', fontWeight: 600, cursor: 'pointer', minWidth: 100 }}>
          <option value="전체">전체</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span style={{ fontSize: 12, color: '#94a3b8' }}>
          {filteredSkuCount}개 SKU · 재고 {filteredStockQty}개 · 재고금액 {formatFullKRW(filteredStockValue)}
        </span>
      </div>

      {/* KPI */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 20 }}>
        <KpiCard label="전체 SKU" value={`${totalItems}개`} sub="등록된 상품" />
        <KpiCard label="총 가용 재고" value={`${totalStock}개`} sub="전 SKU 합산" color="#2563eb" />
        <div onClick={() => setShowLowStockModal(true)} style={{ cursor: 'pointer' }} title="클릭해서 시즌별 재고 부족 상품 보기">
          <KpiCard label="재고 부족" value={`${lowStockItems.length}개`} sub="5개 이하 SKU · 클릭해서 확인" color={lowStockItems.length > 0 ? '#e11d48' : '#94a3b8'} />
        </div>
        <KpiCard label="총 판매" value={`${items.reduce((s, r) => s + (r.total_sold || 0), 0)}개`} sub="누적 판매 수량" color="#059669" />
      </div>

      {/* 상품 추가 폼 */}
      {showAddForm && (
        <div style={{ background: '#fff', border: '2px solid #4f46e5', borderRadius: 16, padding: 20, marginBottom: 20 }}>
          <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 16, color: '#4f46e5' }}>+ 새 상품 등록</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 12 }}>
            <div>
              <div style={labelStyle}>시즌</div>
              <select value={newItem.season} onChange={e => setNewItem(p => ({ ...p, season: e.target.value }))} style={selectStyle}>
                <option value="">선택</option>
                {SEASONS.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <FormField label="상품명 *" value={newItem.name}
              onChange={(v: string) => setNewItem(p => ({ ...p, name: v }))} placeholder="예: 플라워티" />
            <FormField label="스타일넘버 *" value={newItem.sku}
              onChange={(v: string) => setNewItem(p => ({ ...p, sku: v }))} placeholder="예: FLOWER-01" />
            <div>
              <div style={labelStyle}>카테고리</div>
              <select value={newItem.category} onChange={e => setNewItem(p => ({ ...p, category: e.target.value }))} style={selectStyle}>
                {CATEGORIES.map(c => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <div style={labelStyle}>옵션 (사이즈)</div>
              <select value={newItem.option_name} onChange={e => setNewItem(p => ({ ...p, option_name: e.target.value }))} style={selectStyle}>
                {SIZES.map(s => <option key={s}>{s}</option>)}
              </select>
            </div>
            <FormField label="원가 (원)" value={newItem.cost_price} type="number"
              onChange={(v: string) => setNewItem(p => ({ ...p, cost_price: v }))} placeholder="예: 15000" />
            <FormField label="판매가 (원)" value={newItem.sell_price} type="number"
              onChange={(v: string) => setNewItem(p => ({ ...p, sell_price: v }))} placeholder="예: 49000" />
          </div>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button onClick={() => setShowAddForm(false)}
              style={{ padding: '8px 18px', border: '1px solid #94a3b8', borderRadius: 8, background: '#f8fafc', cursor: 'pointer', fontSize: 13, fontWeight: 600 }}>취소</button>
            <button onClick={addItem} disabled={saving || !newItem.name}
              style={{ padding: '8px 18px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700 }}>
              {saving ? '저장 중...' : '등록'}
            </button>
          </div>
        </div>
      )}

      {/* 상품 테이블 */}
      {loading ? <div className="loading">로딩 중...</div> : (
        <div style={{ background: '#fff', border: `1px solid ${CELL_BORDER_COLOR}`, borderRadius: 16, overflow: 'hidden', marginBottom: 24 }}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                {/* 그룹 헤더 — 상품정보/가격·마진/생산·실판매/마케팅수량/재고현황/관리 */}
                <tr style={{ background: '#f8fafc' }}>
                  <th colSpan={5} style={groupHeaderStyle('#2563eb')}>🏷️ 상품 정보 <span style={groupHeaderSubStyle}>(PRODUCT INFO)</span></th>
                  <th colSpan={3} style={groupHeaderStyle('#059669')}>₩ 가격 및 마진 <span style={groupHeaderSubStyle}>(PRICE &amp; MARGIN)</span></th>
                  <th colSpan={3} style={groupHeaderStyle('#4f46e5')}>📦 생산 및 실판매 <span style={groupHeaderSubStyle}>(PRODUCTION &amp; SALES)</span></th>
                  <th colSpan={3} style={groupHeaderStyle('#d97706')}>📣 마케팅 수량 <span style={groupHeaderSubStyle}>(MARKETING)</span></th>
                  <th colSpan={3} style={groupHeaderStyle('#0891b2', true)}>🗂️ 재고 현황 <span style={groupHeaderSubStyle}>(STOCK STATUS)</span></th>
                  <th style={groupHeaderStyle('#64748b')}>관리</th>
                </tr>
                {/* 개별 컬럼 헤더 */}
                <tr style={{ background: '#f8fafc' }}>
                  {[
                    { label: '시즌' }, { label: '카테고리' }, { label: '스타일' }, { label: '상품명' }, { label: '옵션', boundary: true },
                    { label: '원가' }, { label: '판매가' }, { label: '배수', boundary: true, sortKey: 'multiplier' as const },
                    { label: '제작수량' }, { label: '리오더' }, { label: '총판매', boundary: true, sortKey: 'total_sold' as const },
                    { label: '시딩' }, { label: '협찬' }, { label: '수선불가', boundary: true },
                    { label: '총재고', sortKey: 'total_stock' as const }, { label: '오프라인' }, { label: '온라인재고', boundary: true, sortKey: 'online_stock' as const },
                    { label: '' },
                  ].map((col, idx) => (
                    <th key={idx} style={{ padding: '10px 6px', textAlign: 'center', borderBottom: `1px solid ${CELL_BORDER_COLOR}`, borderRight: col.boundary ? GROUP_DIVIDER : undefined, fontSize: 11, color: '#0f172a', fontWeight: 700 }}>
                      {col.label}
                      {col.sortKey && (
                        <button onClick={() => toggleSort(col.sortKey!)}
                          title="클릭해서 오름차순/내림차순 정렬"
                          style={{ border: 'none', background: 'none', cursor: 'pointer', marginLeft: 3, fontSize: 11, fontWeight: 800, color: sortBy === col.sortKey ? '#4f46e5' : '#94a3b8', padding: 0 }}>
                          {sortBy === col.sortKey ? (sortDir === 'asc' ? '▲' : '▼') : '⇅'}
                        </button>
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.length === 0 ? (
                  <tr><td colSpan={18} style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>
                    {search ? '검색 결과가 없습니다.' : '+ 상품 추가 버튼으로 첫 상품을 등록해보세요.'}
                  </td></tr>
                ) : filtered.map((item, idx) => {
                  const isEdit = editingId === item.id
                  const avail = computeAvailable(item)
                  const itemReorderTotal = reordersFor(item.id).reduce((s, r) => s + r.qty, 0)

                  // 같은 스타일넘버끼리 묶어서 시즌/상품명 셀을 병합 (rowSpan)
                  // 스타일넘버가 "상품 자체"를 나타내는 기준값이라, 이름 표기가 서로 달라도(한글/영문 등) 정확히 묶임
                  // filtered는 스타일넘버순으로 정렬되어 있으므로 같은 스타일넘버는 항상 연속으로 붙어있음
                  // 정렬 버튼(배수/총판매/총재고/온라인재고)이 눌려있으면 같은 스타일넘버 병합을 끄고 행별로 보여줌
                  const groupingEnabled = !sortBy
                  const prevItem = filtered[idx - 1]
                  const isFirstOfGroup = !groupingEnabled || !prevItem || prevItem.sku !== item.sku
                  let groupSize = 1
                  if (groupingEnabled && isFirstOfGroup) {
                    for (let j = idx + 1; j < filtered.length && filtered[j].sku === item.sku; j++) groupSize++
                  }
                  // 그룹 내 아무 행이나 수정 중이면, 그 그룹은 병합 없이 개별 표시 (수정 UI 충돌 방지)
                  let groupHasEditing = false
                  if (groupingEnabled) {
                    let start = idx
                    while (start > 0 && filtered[start - 1].sku === item.sku) start--
                    for (let j = start; j < filtered.length && filtered[j].sku === item.sku; j++) {
                      if (editingId === filtered[j].id) { groupHasEditing = true; break }
                    }
                  }
                  const showMergedCells = groupingEnabled && !groupHasEditing
                  const isGroupStart = showMergedCells ? isFirstOfGroup : true
                  const rowSpanValue = showMergedCells ? groupSize : 1

                  const isLastOfGroup = showMergedCells ? (idx + 1 >= filtered.length || filtered[idx + 1].sku !== item.sku) : true

                  return (
                    <tr key={item.id} style={{ borderBottom: isLastOfGroup ? `1px solid ${CELL_BORDER_COLOR}` : '1px solid #f8fafc' }}
                      onMouseEnter={e => (e.currentTarget.style.background = '#f8fafc')}
                      onMouseLeave={e => (e.currentTarget.style.background = '')}>

                      {isGroupStart && (
                        <td rowSpan={rowSpanValue} style={{ padding: '10px 8px', textAlign: 'center', verticalAlign: 'middle' }}>
                          {isEdit ? (
                            <select value={editValues.season || ''} onChange={e => setEditValues(v => ({ ...v, season: e.target.value }))} style={{ ...inlineInputStyle, width: 70 }}>
                              <option value="">-</option>
                              {SEASONS.map(s => <option key={s}>{s}</option>)}
                            </select>
                          ) : (
                            <span style={{ background: seasonStyle(item.season).bg, color: seasonStyle(item.season).color, padding: '3px 8px', borderRadius: 6, fontSize: 14, fontWeight: 700 }}>{item.season || '-'}</span>
                          )}
                        </td>
                      )}

                      <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                        {isEdit ? (
                          <select value={editValues.category || ''} onChange={e => setEditValues(v => ({ ...v, category: e.target.value }))} style={{ ...inlineInputStyle, width: 80 }}>
                            {CATEGORIES.map(c => <option key={c}>{c}</option>)}
                          </select>
                        ) : (
                          <span style={{ background: '#eef2ff', color: '#4f46e5', padding: '3px 8px', borderRadius: 6, fontSize: 12, fontWeight: 600 }}>{item.category}</span>
                        )}
                      </td>

                      {/* 스타일넘버 - 같은 스타일넘버끼리 병합 */}
                      {isGroupStart && (
                        <td rowSpan={rowSpanValue} style={{ padding: '10px 8px', textAlign: 'center', verticalAlign: 'middle' }}>
                          {isEdit ? (
                            <input value={editValues.sku || ''} onChange={e => setEditValues(v => ({ ...v, sku: e.target.value }))} style={{ ...inlineInputStyle, width: 90 }} />
                          ) : (
                            <span style={{ fontSize: 12, color: '#64748b', fontFamily: 'monospace' }}>{item.sku || '-'}</span>
                          )}
                        </td>
                      )}

                      {isGroupStart && (
                        <td rowSpan={rowSpanValue} style={{ padding: '10px 12px', minWidth: 190, maxWidth: 230, textAlign: 'center', verticalAlign: 'middle' }}>
                          {isEdit ? (
                            <input value={editValues.name || ''} onChange={e => setEditValues(v => ({ ...v, name: e.target.value }))} style={{ ...inlineInputStyle, textAlign: 'center' }} />
                          ) : (
                            <div style={{ fontWeight: 600, color: '#1e293b' }}>{item.name}</div>
                          )}
                        </td>
                      )}

                      <td style={{ padding: '10px 8px', textAlign: 'center', borderRight: GROUP_DIVIDER }}>
                        {isEdit ? (
                          <select value={editValues.option_name || ''} onChange={e => setEditValues(v => ({ ...v, option_name: e.target.value }))} style={{ ...inlineInputStyle, width: 60 }}>
                            {SIZES.map(s => <option key={s}>{s}</option>)}
                          </select>
                        ) : (
                          <span style={{ color: '#475569', fontWeight: 500 }}>{item.option_name}</span>
                        )}
                      </td>

                      <td style={{ padding: '10px 8px', textAlign: 'center', minWidth: 80 }}>
                        {isEdit ? (
                          <input type="number" value={editValues.cost_price || ''} onChange={e => setEditValues(v => ({ ...v, cost_price: +e.target.value }))} style={{ ...inlineInputStyle, width: 80, textAlign: 'center' }} />
                        ) : (
                          <span style={{ color: '#64748b' }}>{formatFullKRW(item.cost_price)}</span>
                        )}
                      </td>

                      <td style={{ padding: '10px 8px', textAlign: 'center', minWidth: 90 }}>
                        {isEdit ? (
                          <input type="number" value={editValues.sell_price || ''} onChange={e => setEditValues(v => ({ ...v, sell_price: +e.target.value }))} style={{ ...inlineInputStyle, width: 80, textAlign: 'center' }} />
                        ) : (
                          <span style={{ fontWeight: 600 }}>{formatFullKRW(item.sell_price)}</span>
                        )}
                      </td>

                      {/* 배수 — 원가 대비 판매가 배수, 자동 계산 */}
                      <td style={{ padding: '10px 8px', textAlign: 'center', borderRight: GROUP_DIVIDER }}>
                        {(() => {
                          const cost = isEdit ? (editValues.cost_price ?? item.cost_price) : item.cost_price
                          const sell = isEdit ? (editValues.sell_price ?? item.sell_price) : item.sell_price
                          return (
                            <span style={{ fontSize: 12, fontWeight: 700, color: '#4f46e5', background: '#eef2ff', padding: '2px 8px', borderRadius: 6 }}>
                              {cost > 0 ? (sell / cost).toFixed(1) + '배' : '-'}
                            </span>
                          )
                        })()}
                      </td>

                      {/* 제작수량 (수정 가능) */}
                      <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                        {isEdit ? (
                          <input type="number" value={editValues.initial_qty ?? item.initial_qty} onChange={e => setEditValues(v => ({ ...v, initial_qty: +e.target.value }))} style={{ ...inlineInputStyle, width: 60, textAlign: 'center' }} />
                        ) : (
                          <span style={{ fontWeight: 700 }}>{item.initial_qty ?? 0}</span>
                        )}
                      </td>

                      {/* 리오더 합계 — 클릭하면 언제 몇 장 리오더했는지 이력 팝업 */}
                      <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                        <button onClick={() => setReorderDetailItem(item)}
                          title="클릭해서 리오더 이력 보기"
                          style={{ border: 'none', background: 'none', cursor: 'pointer', fontWeight: 700, color: '#94a3b8', padding: '2px 8px', borderRadius: 6 }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#f1f5f9')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          {itemReorderTotal}
                        </button>
                      </td>

                      {/* 총판매 — 클릭하면 이 아이템의 매출/순매출/순수익 상세 팝업 */}
                      <td style={{ padding: '10px 8px', textAlign: 'center', borderRight: GROUP_DIVIDER }}>
                        <button onClick={() => openSalesDetail(item)}
                          title="클릭해서 매출 상세 보기"
                          style={{ border: 'none', background: 'none', cursor: 'pointer', fontWeight: 700, color: '#059669', padding: '2px 8px', borderRadius: 6 }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#f0fdf4')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          {item.total_sold ?? 0}
                        </button>
                      </td>

                      {/* 시딩 — 나가면 그대로 차감, 회수 없음 */}
                      <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                        <button onClick={() => addSeedingRecord(item.id, '시딩')}
                          title="클릭해서 시딩 추가"
                          style={{ border: 'none', background: 'none', cursor: 'pointer', fontWeight: 700, color: '#475569', padding: '2px 8px', borderRadius: 6 }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#f1f5f9')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          {seedingTotal(item.id)}
                        </button>
                      </td>

                      {/* 협찬 — 미회수분만 차감, 회수되면 재고로 복귀 */}
                      <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                        <div style={{ display: 'flex', gap: 4, justifyContent: 'center', alignItems: 'center' }}>
                          <button onClick={() => addSeedingRecord(item.id, '협찬')}
                            title="클릭해서 협찬 추가"
                            style={{ border: 'none', background: 'none', cursor: 'pointer', fontWeight: 700, color: '#475569', padding: '2px 6px', borderRadius: 6 }}
                            onMouseEnter={e => (e.currentTarget.style.background = '#f1f5f9')}
                            onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                            {sponsorshipOutstanding(item.id)}
                          </button>
                          {sponsorshipOutstanding(item.id) > 0 && (
                            <button onClick={() => returnSponsorship(item.id)}
                              title="회수 처리"
                              style={{ border: '1px solid #94a3b8', background: '#fff', cursor: 'pointer', fontSize: 11, color: '#4f46e5', padding: '2px 6px', borderRadius: 6, fontWeight: 700 }}>
                              ↩ 회수
                            </button>
                          )}
                        </div>
                      </td>

                      <td style={{ padding: '10px 8px', textAlign: 'center', borderRight: GROUP_DIVIDER }}>
                        {isEdit ? (
                          <input type="number" value={editValues.damaged_qty ?? item.damaged_qty} onChange={e => setEditValues(v => ({ ...v, damaged_qty: +e.target.value }))} style={{ ...inlineInputStyle, width: 60, textAlign: 'center' }} />
                        ) : (
                          <span style={{ fontWeight: 700, color: item.damaged_qty > 0 ? '#e11d48' : '#94a3b8' }}>{item.damaged_qty ?? 0}</span>
                        )}
                      </td>

                      {/* 총재고 — 리오더/시딩/협찬/수선불가까지 반영한 전체 재고 (오프라인 매장 보유분 포함) */}
                      <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                        <span style={{
                          fontWeight: 800, fontSize: 15, padding: '3px 10px', borderRadius: 8,
                          background: avail <= 0 ? '#fef2f2' : avail <= 5 ? '#fff7ed' : '#f0fdf4',
                          color: avail <= 0 ? '#e11d48' : avail <= 5 ? '#d97706' : '#059669'
                        }}>
                          {avail}
                        </span>
                      </td>

                      {/* 오프라인 — 클라만 등 오프라인 매장에 입고돼 있는 수량. 클릭하면 매장별 상세 팝업 */}
                      <td style={{ padding: '10px 8px', textAlign: 'center' }}>
                        <button onClick={() => setOfflineDetailItem(item)}
                          title="클릭해서 매장별 오프라인 재고 보기"
                          style={{ border: 'none', background: 'none', cursor: 'pointer', fontWeight: 700, color: '#7c3aed', padding: '2px 8px', borderRadius: 6 }}
                          onMouseEnter={e => (e.currentTarget.style.background = '#f5f3ff')}
                          onMouseLeave={e => (e.currentTarget.style.background = 'transparent')}>
                          {offlineTotalFor(item)}
                        </button>
                      </td>

                      {/* 재고 — 총재고에서 오프라인 매장 보유분을 뺀, 온라인 채널에서 실제 판매 가능한 수량 */}
                      <td style={{ padding: '10px 8px', textAlign: 'center', borderRight: GROUP_DIVIDER }}>
                        {(() => {
                          const onlineAvail = avail - offlineTotalFor(item)
                          return (
                            <span style={{
                              fontWeight: 800, fontSize: 15, padding: '3px 10px', borderRadius: 8,
                              background: onlineAvail <= 0 ? '#fef2f2' : onlineAvail <= 5 ? '#fff7ed' : '#f0fdf4',
                              color: onlineAvail <= 0 ? '#e11d48' : onlineAvail <= 5 ? '#d97706' : '#059669'
                            }}>
                              {onlineAvail}
                            </span>
                          )
                        })()}
                      </td>

                      <td style={{ padding: '10px 10px', textAlign: 'center', whiteSpace: 'nowrap' }}>
                        {isEdit ? (
                          <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                            <button onClick={() => saveEdit(item.id)} disabled={saving}
                              style={{ padding: '5px 12px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                              {saving ? '...' : '저장'}
                            </button>
                            <button onClick={() => setEditingId(null)}
                              style={{ padding: '5px 10px', background: '#f1f5f9', border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 12, color: '#64748b' }}>
                              취소
                            </button>
                          </div>
                        ) : (
                          <div style={{ display: 'flex', gap: 4, justifyContent: 'center' }}>
                            <button onClick={() => { setEditingId(item.id); setEditValues({ ...item }) }}
                              style={{ padding: '5px 10px', border: '1px solid #94a3b8', borderRadius: 6, background: '#f8fafc', cursor: 'pointer', fontSize: 12, color: '#475569', fontWeight: 600 }}>
                              수정
                            </button>
                            <button onClick={() => deleteItem(item.id)}
                              style={{ padding: '5px 8px', border: '1px solid #fecdd3', borderRadius: 6, background: '#fff', cursor: 'pointer', fontSize: 12, color: '#e11d48' }}>
                              삭제
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* 오프라인 재고 팝업 — 오프라인 숫자를 클릭하면 매장별 상세 표시 */}
      {offlineDetailItem && (
        <div onClick={() => setOfflineDetailItem(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 16, padding: 24, width: 420, maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a' }}>{offlineDetailItem.name}</div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{offlineDetailItem.sku} · {offlineDetailItem.option_name}</div>
              </div>
              <button onClick={() => setOfflineDetailItem(null)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18, color: '#94a3b8', fontWeight: 800 }}>×</button>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
              <thead>
                <tr style={{ background: '#f8fafc' }}>
                  {['매장', '재고'].map(h => (
                    <th key={h} style={{ padding: '8px', textAlign: 'center', fontSize: 11, color: '#94a3b8', fontWeight: 700, borderBottom: '1px solid #94a3b8' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {offlineBreakdownFor(offlineDetailItem).map(row => (
                  <tr key={row.name}>
                    <td style={{ padding: '8px', textAlign: 'center', fontWeight: 600 }}>{row.name}</td>
                    <td style={{ padding: '8px', textAlign: 'center', fontWeight: 700, color: '#7c3aed' }}>{row.qty}개</td>
                  </tr>
                ))}
                <tr style={{ borderTop: '2px solid #94a3b8', fontWeight: 800 }}>
                  <td style={{ padding: '8px', textAlign: 'center' }}>합계</td>
                  <td style={{ padding: '8px', textAlign: 'center' }}>{offlineTotalFor(offlineDetailItem)}개</td>
                </tr>
              </tbody>
            </table>

            <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 12 }}>
              * 클라만 입고 수량에서 클라만 판매 수량을 뺀 값입니다. 다른 오프라인 매장이 추가되면 여기에 같이 표시됩니다.
            </div>
          </div>
        </div>
      )}

      {/* 리오더 이력 팝업 — 리오더 숫자를 클릭하면 뜸 */}
      {reorderDetailItem && (
        <div onClick={() => setReorderDetailItem(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 16, padding: 24, width: 480, maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a' }}>{reorderDetailItem.name}</div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{reorderDetailItem.sku}</div>
              </div>
              <button onClick={() => setReorderDetailItem(null)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18, color: '#94a3b8', fontWeight: 800 }}>×</button>
            </div>

            {/* 새 리오더 직접 입력 폼 */}
            <div style={{ background: '#f8fafc', borderRadius: 10, padding: 12, marginBottom: 16 }}>
              <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 8 }}>+ 리오더 직접 입력</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
                <select value={newReorder.option_name} onChange={e => setNewReorder(v => ({ ...v, option_name: e.target.value }))} style={inlineInputStyle}>
                  <option value="">옵션 선택</option>
                  {items.filter(i => i.sku === reorderDetailItem.sku).map(i => (
                    <option key={i.id} value={i.option_name}>{i.option_name}</option>
                  ))}
                </select>
                <input type="date" value={newReorder.reorder_date} onChange={e => setNewReorder(v => ({ ...v, reorder_date: e.target.value }))} style={inlineInputStyle} />
                <input type="number" placeholder="차수" value={newReorder.round_no} onChange={e => setNewReorder(v => ({ ...v, round_no: e.target.value }))} style={inlineInputStyle} />
                <input type="number" placeholder="수량" value={newReorder.qty} onChange={e => setNewReorder(v => ({ ...v, qty: e.target.value }))} style={inlineInputStyle} />
                <input placeholder="업체" value={newReorder.vendor} onChange={e => setNewReorder(v => ({ ...v, vendor: e.target.value }))} style={inlineInputStyle} />
                <input placeholder="메모" value={newReorder.memo} onChange={e => setNewReorder(v => ({ ...v, memo: e.target.value }))} style={inlineInputStyle} />
              </div>
              <button onClick={() => addReorderInline(reorderDetailItem.sku)} disabled={savingReorder}
                style={{ width: '100%', padding: '8px', background: '#4f46e5', color: '#fff', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, fontWeight: 700 }}>
                {savingReorder ? '등록 중...' : '추가'}
              </button>
            </div>

            {reordersForSku(reorderDetailItem.sku).length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 13 }}>리오더 이력이 없습니다.</div>
            ) : (
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
                <thead>
                  <tr style={{ background: '#f8fafc' }}>
                    {['일자', '옵션', '차수', '수량', '업체', '메모', ''].map(h => (
                      <th key={h} style={{ padding: '8px', textAlign: 'center', fontSize: 11, color: '#94a3b8', fontWeight: 700, borderBottom: '1px solid #94a3b8' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {reordersForSku(reorderDetailItem.sku)
                    .slice()
                    .sort((a, b) => (a.reorder_date < b.reorder_date ? 1 : -1))
                    .map(r => (
                      <tr key={r.id}>
                        <td style={{ padding: '8px', textAlign: 'center', color: '#475569' }}>{r.reorder_date}</td>
                        <td style={{ padding: '8px', textAlign: 'center', color: '#475569' }}>{r.option_name}</td>
                        <td style={{ padding: '8px', textAlign: 'center', color: '#475569' }}>{r.round_no}차</td>
                        <td style={{ padding: '8px', textAlign: 'center', fontWeight: 700, color: '#4f46e5' }}>{r.qty}장</td>
                        <td style={{ padding: '8px', textAlign: 'center', color: '#64748b' }}>{r.vendor || '-'}</td>
                        <td style={{ padding: '8px', textAlign: 'center', color: '#94a3b8', fontSize: 12 }}>{r.memo || '-'}</td>
                        <td style={{ padding: '8px', textAlign: 'center' }}>
                          <button onClick={() => deleteReorder(r.id)}
                            style={{ border: 'none', background: 'none', color: '#e11d48', cursor: 'pointer', fontSize: 11 }}>
                            삭제
                          </button>
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* 매출 상세 팝업 — 총판매 숫자를 클릭하면 뜸 */}
      {salesDetailItem && (
        <div onClick={() => setSalesDetailItem(null)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 16, padding: 24, width: 480, maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a' }}>{salesDetailItem.name}</div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>{salesDetailItem.sku} · {salesDetailItem.option_name}</div>
              </div>
              <button onClick={() => setSalesDetailItem(null)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18, color: '#94a3b8', fontWeight: 800 }}>×</button>
            </div>

            {salesDetailLoading || !salesDetailData ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8' }}>불러오는 중...</div>
            ) : (
              <>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      {['채널', '판매수량', '매출액', '순매출액'].map(h => (
                        <th key={h} style={{ padding: '8px', textAlign: 'center', fontSize: 11, color: '#94a3b8', fontWeight: 700, borderBottom: '1px solid #94a3b8' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {salesDetailData.channels.map(c => (
                      <tr key={c.name}>
                        <td style={{ padding: '8px', textAlign: 'center', fontWeight: 600 }}>{c.name}</td>
                        <td style={{ padding: '8px', textAlign: 'center' }}>{c.qty}개</td>
                        <td style={{ padding: '8px', textAlign: 'center' }}>{formatFullKRW(c.revenue)}</td>
                        <td style={{ padding: '8px', textAlign: 'center' }}>{formatFullKRW(c.net)}</td>
                      </tr>
                    ))}
                    <tr style={{ borderTop: '2px solid #94a3b8', fontWeight: 800 }}>
                      <td style={{ padding: '8px', textAlign: 'center' }}>합계</td>
                      <td style={{ padding: '8px', textAlign: 'center' }}>{salesDetailData.totalQty}개</td>
                      <td style={{ padding: '8px', textAlign: 'center' }}>{formatFullKRW(salesDetailData.totalRevenue)}</td>
                      <td style={{ padding: '8px', textAlign: 'center' }}>{formatFullKRW(salesDetailData.totalNet)}</td>
                    </tr>
                  </tbody>
                </table>

                <div style={{ background: '#f8fafc', borderRadius: 12, padding: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 13, marginBottom: 8 }}>
                    <span style={{ color: '#64748b' }}>총 원가</span>
                    <span style={{ fontWeight: 700 }}>{formatFullKRW(salesDetailData.totalCost)}</span>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 15 }}>
                    <span style={{ fontWeight: 700, color: '#0f172a' }}>순수익</span>
                    <span style={{ fontWeight: 800, color: salesDetailData.totalProfit >= 0 ? '#059669' : '#e11d48' }}>
                      {formatFullKRW(salesDetailData.totalProfit)}
                    </span>
                  </div>
                </div>

                <div style={{ fontSize: 11, color: '#94a3b8', marginTop: 12 }}>
                  * 무신사/자사몰/WOO/REKET/클라만 정산 데이터를 모두 합산한 값입니다.
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {/* 재고 부족 팝업 — KPI "재고 부족" 카드 클릭 시, 시즌별로 묶어서 표시 */}
      {showLowStockModal && (
        <div onClick={() => setShowLowStockModal(false)}
          style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div onClick={e => e.stopPropagation()}
            style={{ background: '#fff', borderRadius: 16, padding: 24, width: 520, maxWidth: '90vw', maxHeight: '85vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 16 }}>
              <div>
                <div style={{ fontWeight: 800, fontSize: 16, color: '#0f172a' }}>⚠ 재고 부족 상품</div>
                <div style={{ fontSize: 12, color: '#94a3b8', marginTop: 2 }}>가용 재고 5개 이하 · 시즌별로 표시</div>
              </div>
              <button onClick={() => setShowLowStockModal(false)}
                style={{ border: 'none', background: 'none', cursor: 'pointer', fontSize: 18, color: '#94a3b8', fontWeight: 800 }}>×</button>
            </div>

            {lowStockItems.length === 0 ? (
              <div style={{ textAlign: 'center', padding: 40, color: '#94a3b8', fontSize: 13 }}>재고 부족 상품이 없습니다.</div>
            ) : (
              Array.from(
                lowStockItems.reduce((map, r) => {
                  const key = r.season || '미지정'
                  if (!map.has(key)) map.set(key, [])
                  map.get(key)!.push(r)
                  return map
                }, new Map<string, Item[]>())
              )
                .sort((a, b) => seasonSortValue(b[0]) - seasonSortValue(a[0]))
                .map(([season, list]) => (
                  <div key={season} style={{ marginBottom: 16 }}>
                    <div style={{ fontSize: 15, fontWeight: 700, color: seasonStyle(season).color, background: seasonStyle(season).bg, padding: '4px 10px', borderRadius: 6, display: 'inline-block', marginBottom: 8 }}>
                      {season}
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                      {list.map(r => (
                        <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, background: '#fff1f2', border: '1px solid #fecdd3', borderRadius: 8, padding: '8px 12px' }}>
                          <span style={{ fontSize: 13, color: '#be123c', fontWeight: 600 }}>
                            {r.name} ({r.option_name}) — {computeAvailable(r)}개
                          </span>
                          <button onClick={() => dismissLowStock(r.id)} title="이 알림 숨기기"
                            style={{ border: 'none', background: 'none', cursor: 'pointer', color: '#be123c', fontWeight: 800, fontSize: 14, padding: '0 4px', lineHeight: 1 }}>
                            ×
                          </button>
                        </div>
                      ))}
                    </div>
                  </div>
                ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function KpiCard({ label, value, sub, color }: { label: string; value: string; sub: string; color?: string }) {
  return (
    <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 14, padding: 18 }}>
      <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 8 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 800, color: color || '#0f172a', marginBottom: 4 }}>{value}</div>
      <div style={{ fontSize: 12, color: '#94a3b8' }}>{sub}</div>
    </div>
  )
}

function FormField({ label, value, onChange, placeholder, type = 'text' }: any) {
  return (
    <div>
      <div style={labelStyle}>{label}</div>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        style={{ width: '100%', padding: '8px 10px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: '#fff' }} />
    </div>
  )
}

// 컬럼 그룹 경계선 색 — 헤더/본문 표에 공통으로 사용
const GROUP_DIVIDER = '2px solid #94a3b8'
// 일반 셀 테두리 색 — 표 전체에서 통일해서 사용 (그룹 경계선과 동일한 색)
const CELL_BORDER_COLOR = '#94a3b8'

// 상품 테이블 그룹 헤더(상품정보/가격·마진/생산·실판매/마케팅수량/재고현황) 공통 스타일
function groupHeaderStyle(color: string, emphasized = false): React.CSSProperties {
  return {
    padding: '10px 8px',
    textAlign: 'center',
    borderBottom: emphasized ? `2px solid ${color}` : `1px solid ${CELL_BORDER_COLOR}`,
    borderRight: GROUP_DIVIDER,
    fontSize: 12,
    fontWeight: emphasized ? 800 : 700,
    color,
    whiteSpace: 'nowrap',
    background: emphasized ? `${color}0d` : undefined,
  }
}
const groupHeaderSubStyle: React.CSSProperties = { fontSize: 9, color: '#94a3b8', fontWeight: 600, marginLeft: 4, textTransform: 'uppercase' }

const labelStyle: React.CSSProperties = { fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 4 }
const selectStyle: React.CSSProperties = { width: '100%', padding: '8px 10px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: '#fff' }
const inlineInputStyle: React.CSSProperties = { padding: '5px 8px', border: '1px solid #94a3b8', borderRadius: 6, fontSize: 12, fontFamily: 'inherit', background: '#fff', width: '100%' }