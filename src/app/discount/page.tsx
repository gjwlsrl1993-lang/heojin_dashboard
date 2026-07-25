'use client'

import { useEffect, useState } from 'react'
import { supabase } from '@/lib/supabase'

// 1원 단위까지 정확하게 표시 (formatKRW의 축약 표기 대신)
function formatWon(n: number): string {
  return (n || 0).toLocaleString('ko-KR') + '원'
}

// 플랫폼별 수수료율 (기존 각 채널 페이지에서 쓰는 값과 동일하게 맞춤)
const PLATFORM_FEE_RATE: Record<string, number> = {
  '자사몰': 0.035,
  '무신사': 0.29,
  'WOO': 0.40,
  'REKET': 0.30,
  '클라만': 0.30,
}
const PLATFORMS = ['자사몰', '무신사', 'WOO', 'REKET', '클라만']
// 할인(%)을 걸면 10%마다 수수료가 1%p씩 낮아지는 플랫폼 (무신사/REKET만 해당)
const FEE_DISCOUNT_APPLICABLE: Record<string, boolean> = {
  '자사몰': false, '무신사': true, 'REKET': true, 'WOO': false, '클라만': false,
}
// 무신사/REKET만 쿠폰을 "플랫폼쿠폰"(플랫폼이 비용 부담) / "브랜드쿠폰"(셀러가 비용 부담)으로 분리
const PLATFORM_COUPON_LABEL: Record<string, string> = { '무신사': '무신사쿠폰', 'REKET': '리켓쿠폰' }
function usesSplitCoupon(platform: string) {
  return platform === '무신사' || platform === 'REKET'
}
// WOO, 클라만은 쿠폰 자체가 없음
function hasCoupon(platform: string) {
  return platform !== 'WOO' && platform !== '클라만'
}

// 오늘 기준 건당 택배비 (26년 5월 이후 구간과 동일하게 맞춤)
const CURRENT_SHIPPING_FEE = 2990

type ItemAgg = {
  key: string
  name: string
  category: string
  season: string
  cost_price: number
  sell_price: number
  stockByOption: { option: string; qty: number }[]
}

// "25SS", "25FW", "26SS" 같은 시즌 문자열을 시간순으로 정렬하기 위한 값 계산 (연도*10 + SS:0/FW:1)
function seasonSortValue(season: string): number {
  const match = /^(\d{2})(SS|FW)$/i.exec((season || '').trim())
  if (!match) return -1
  const yy = parseInt(match[1], 10)
  const seasonCode = match[2].toUpperCase() === 'SS' ? 0 : 1
  return yy * 10 + seasonCode
}

// 카테고리 표시 순서: 아우터 > 상의 > 하의 > 악세서리 > 그 외
const CATEGORY_ORDER = ['아우터', '상의', '하의', '악세서리']
function categorySortValue(cat: string): number {
  const idx = CATEGORY_ORDER.indexOf(cat)
  return idx === -1 ? CATEGORY_ORDER.length : idx
}

// 옵션(사이즈) 표시 순서: 1, 2, 3 > XS, S, M, L, XL > 그 외
const OPTION_ORDER = ['1', '2', '3', 'XS', 'S', 'M', 'L', 'XL']
function optionSortValue(option: string): number {
  const idx = OPTION_ORDER.indexOf((option || '').trim().toUpperCase())
  return idx === -1 ? OPTION_ORDER.length : idx
}

export default function DiscountSettingsPage() {
  const [platform, setPlatform] = useState('자사몰')
  const [season, setSeason] = useState('전체')
  const [category, setCategory] = useState('전체')
  const [items, setItems] = useState<ItemAgg[]>([])
  const [seasons, setSeasons] = useState<string[]>([])
  const [categories, setCategories] = useState<string[]>([])
  const [loading, setLoading] = useState(true)
  const [couponRates, setCouponRates] = useState<Record<string, number>>({}) // 일반 플랫폼용 단일 쿠폰(%)
  const [platformCouponRates, setPlatformCouponRates] = useState<Record<string, number>>({}) // 무신사/리켓 쿠폰(%) - 플랫폼 부담
  const [brandCouponRates, setBrandCouponRates] = useState<Record<string, number>>({}) // 브랜드쿠폰(%) - 셀러 부담
  const [discountRates, setDiscountRates] = useState<Record<string, number>>({}) // item key -> 할인율(%)

  // 일괄입력용 임시 값 (적용 버튼을 눌러야 실제 반영됨)
  const [bulkDiscount, setBulkDiscount] = useState('')
  const [bulkCoupon, setBulkCoupon] = useState('')
  const [bulkPlatformCoupon, setBulkPlatformCoupon] = useState('')
  const [bulkBrandCoupon, setBulkBrandCoupon] = useState('')

  const STORAGE_KEY = 'heojin_discount_settings_v1'

  // 새로고침해도 남아있도록 localStorage에서 불러오기 (플랫폼별로 다르게 저장됨)
  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY)
      if (saved) {
        const parsed = JSON.parse(saved)
        setDiscountRates(parsed.discountRates || {})
        setCouponRates(parsed.couponRates || {})
        setPlatformCouponRates(parsed.platformCouponRates || {})
        setBrandCouponRates(parsed.brandCouponRates || {})
      }
    } catch {}
  }, [])

  // 값이 바뀔 때마다 localStorage에 저장
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ discountRates, couponRates, platformCouponRates, brandCouponRates }))
    } catch {}
  }, [discountRates, couponRates, platformCouponRates, brandCouponRates])

  // 플랫폼마다 다른 값이 저장되도록, 실제 저장 키에 플랫폼 이름을 붙임
  function rateKey(itemKey: string) {
    return `${platform}::${itemKey}`
  }

  useEffect(() => { loadItems() }, [])

  async function loadItems() {
    setLoading(true)
    const { data } = await supabase
      .from('items')
      .select('id, name, option_name, category, season, cost_price, sell_price, inventory(initial_qty, damaged_qty)')
      .order('season', { ascending: false })
      .order('name')

    // 옵션 상관없이 가격이 같으므로, 상품명 기준으로만 묶고 옵션별 재고는 따로 리스트로 모음
    const map = new Map<string, ItemAgg>()
    ;(data || []).forEach((it: any) => {
      const key = it.name
      const inv = Array.isArray(it.inventory) ? it.inventory[0] : it.inventory
      const stockQty = (inv?.initial_qty || 0) - (inv?.damaged_qty || 0)
      if (!map.has(key)) {
        map.set(key, {
          key,
          name: it.name,
          category: it.category || '미분류',
          season: it.season || '미지정',
          cost_price: it.cost_price || 0,
          sell_price: it.sell_price || 0,
          stockByOption: [{ option: it.option_name || '-', qty: stockQty }],
        })
      } else {
        map.get(key)!.stockByOption.push({ option: it.option_name || '-', qty: stockQty })
      }
    })
    const merged = Array.from(map.values()).sort((a, b) => {
      const seasonDiff = seasonSortValue(b.season) - seasonSortValue(a.season) // 최신 시즌 먼저
      if (seasonDiff !== 0) return seasonDiff
      const catDiff = categorySortValue(a.category) - categorySortValue(b.category) // 아우터>상의>하의>악세서리
      if (catDiff !== 0) return catDiff
      return a.name.localeCompare(b.name)
    })
    merged.forEach(it => {
      it.stockByOption.sort((a, b) => optionSortValue(a.option) - optionSortValue(b.option))
    })
    setItems(merged)
    setSeasons(Array.from(new Set(merged.map(it => it.season))).sort((a, b) => seasonSortValue(b) - seasonSortValue(a)))
    setCategories(Array.from(new Set(merged.map(it => it.category))).sort((a, b) => categorySortValue(a) - categorySortValue(b)))
    setLoading(false)
  }

  function setRate(setter: React.Dispatch<React.SetStateAction<Record<string, number>>>, key: string, value: string) {
    const pct = Math.max(0, Math.min(100, Number(value) || 0))
    setter(v => ({ ...v, [key]: pct }))
  }

  const feeRate = PLATFORM_FEE_RATE[platform] ?? 0
  const splitCoupon = usesSplitCoupon(platform)
  const showCoupon = hasCoupon(platform)
  const filtered = items.filter(it =>
    (season === '전체' || it.season === season) && (category === '전체' || it.category === category)
  )

  // 현재 화면에 보이는(시즌/카테고리 필터 적용된) 상품 전체에 같은 값을 일괄 적용
  function applyBulk(field: 'discount' | 'coupon' | 'platformCoupon' | 'brandCoupon', rawValue: string) {
    const pct = Math.max(0, Math.min(100, Number(rawValue) || 0))
    const setterMap: Record<string, React.Dispatch<React.SetStateAction<Record<string, number>>>> = {
      discount: setDiscountRates,
      coupon: setCouponRates,
      platformCoupon: setPlatformCouponRates,
      brandCoupon: setBrandCouponRates,
    }
    const setter = setterMap[field]
    setter(prev => {
      const next = { ...prev }
      filtered.forEach(it => { next[rateKey(it.key)] = pct })
      return next
    })
  }

  const baseHeaders = ['시즌', '카테고리', '상품명', '재고(옵션별)', '원가', '판매가', '할인(%)', '할인적용가']
  const couponHeaders = !showCoupon
    ? []
    : splitCoupon
      ? [`${PLATFORM_COUPON_LABEL[platform]}(%)`, '브랜드쿠폰(%)']
      : ['쿠폰(%)']
  const tailHeaders = [
    ...(showCoupon ? ['쿠폰적용가'] : []),
    '원가 대비 배수', '적용 수수료', '정산액(수수료 제외)', '순수익(원가·택배비 제외)',
  ]
  const headers = [...baseHeaders, ...couponHeaders, ...tailHeaders]

  return (
    <div>
      <div className="page-header">
        <div>
          <h2 className="page-title">할인 설정 시뮬레이터</h2>
          <p className="page-sub">플랫폼·시즌별로 쿠폰(%)을 넣어보면서 예상 정산액/순수익을 미리 계산해볼 수 있어요</p>
        </div>
      </div>

      {/* 플랫폼 버튼 */}
      <div style={{ marginBottom: 14 }}>
        <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 6 }}>플랫폼</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {PLATFORMS.map(p => (
            <button key={p} onClick={() => setPlatform(p)}
              style={{
                padding: '8px 16px', borderRadius: 8, cursor: 'pointer', fontSize: 13, fontWeight: 700,
                border: platform === p ? '2px solid #4f46e5' : '1px solid #94a3b8',
                background: platform === p ? '#eef2ff' : '#fff',
                color: platform === p ? '#4f46e5' : '#475569',
              }}>
              {p} <span style={{ fontWeight: 500, fontSize: 11, color: '#94a3b8' }}>({(PLATFORM_FEE_RATE[p] * 100).toFixed(1)}%)</span>
            </button>
          ))}
        </div>
      </div>

      {/* 시즌 / 카테고리 드롭다운 */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 6 }}>시즌</div>
          <select value={season} onChange={e => setSeason(e.target.value)}
            style={{ padding: '8px 12px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: '#fff' }}>
            <option value="전체">전체 시즌</option>
            {seasons.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 6 }}>카테고리</div>
          <select value={category} onChange={e => setCategory(e.target.value)}
            style={{ padding: '8px 12px', border: '1px solid #94a3b8', borderRadius: 8, fontSize: 13, fontFamily: 'inherit', background: '#fff' }}>
            <option value="전체">전체 카테고리</option>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
      </div>

      {/* 일괄입력 패널: 현재 시즌/카테고리 필터에 걸린 상품 전체에 같은 값을 한번에 적용 */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap',
        marginBottom: 20, padding: '14px 16px', background: '#f8fafc', border: '1px solid #94a3b8', borderRadius: 12,
      }}>
        <div style={{ fontSize: 11, color: '#64748b', fontWeight: 700, marginRight: 4 }}>
          일괄입력<br />
          <span style={{ fontWeight: 400, color: '#94a3b8' }}>({filtered.length}개 상품)</span>
        </div>

        <div>
          <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 6 }}>할인(%)</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <input type="number" min={0} max={100} value={bulkDiscount} placeholder="0"
              onChange={e => setBulkDiscount(e.target.value)}
              style={{ width: 70, padding: '6px 8px', border: '1px solid #94a3b8', borderRadius: 6, textAlign: 'center', fontSize: 13, fontFamily: 'inherit' }} />
            <button onClick={() => applyBulk('discount', bulkDiscount)}
              style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #4f46e5', background: '#4f46e5', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
              전체 적용
            </button>
          </div>
        </div>

        {showCoupon && !splitCoupon && (
          <div>
            <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 6 }}>쿠폰(%)</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input type="number" min={0} max={100} value={bulkCoupon} placeholder="0"
                onChange={e => setBulkCoupon(e.target.value)}
                style={{ width: 70, padding: '6px 8px', border: '1px solid #94a3b8', borderRadius: 6, textAlign: 'center', fontSize: 13, fontFamily: 'inherit' }} />
              <button onClick={() => applyBulk('coupon', bulkCoupon)}
                style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #4f46e5', background: '#4f46e5', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                전체 적용
              </button>
            </div>
          </div>
        )}

        {showCoupon && splitCoupon && (
          <>
            <div>
              <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 6 }}>{PLATFORM_COUPON_LABEL[platform]}(%)</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="number" min={0} max={100} value={bulkPlatformCoupon} placeholder="0"
                  onChange={e => setBulkPlatformCoupon(e.target.value)}
                  style={{ width: 70, padding: '6px 8px', border: '1px solid #94a3b8', borderRadius: 6, textAlign: 'center', fontSize: 13, fontFamily: 'inherit' }} />
                <button onClick={() => applyBulk('platformCoupon', bulkPlatformCoupon)}
                  style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #4f46e5', background: '#4f46e5', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                  전체 적용
                </button>
              </div>
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#94a3b8', fontWeight: 700, marginBottom: 6 }}>브랜드쿠폰(%)</div>
              <div style={{ display: 'flex', gap: 6 }}>
                <input type="number" min={0} max={100} value={bulkBrandCoupon} placeholder="0"
                  onChange={e => setBulkBrandCoupon(e.target.value)}
                  style={{ width: 70, padding: '6px 8px', border: '1px solid #94a3b8', borderRadius: 6, textAlign: 'center', fontSize: 13, fontFamily: 'inherit' }} />
                <button onClick={() => applyBulk('brandCoupon', bulkBrandCoupon)}
                  style={{ padding: '6px 12px', borderRadius: 6, border: '1px solid #4f46e5', background: '#4f46e5', color: '#fff', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>
                  전체 적용
                </button>
              </div>
            </div>
          </>
        )}

        <div style={{ fontSize: 11, color: '#cbd5e1' }}>
          * 현재 선택된 시즌·카테고리 필터에 걸린 상품에만 적용돼요
        </div>
      </div>

      {loading ? <div className="loading">로딩 중...</div> : (
        <div style={{ background: '#fff', border: '1px solid #94a3b8', borderRadius: 16, overflow: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
            <thead>
              <tr style={{ background: '#f8fafc' }}>
                {headers.map(h => (
                  <th key={h} style={{ padding: '10px 8px', textAlign: 'center', borderBottom: '1px solid #94a3b8', fontSize: 11, color: '#0f172a', fontWeight: 700, whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={headers.length} style={{ textAlign: 'center', padding: 48, color: '#94a3b8' }}>해당 시즌에 등록된 상품이 없습니다.</td></tr>
              ) : filtered.map(it => {
                const discountPct = discountRates[rateKey(it.key)] ?? 0
                const discountPrice = Math.round(it.sell_price * (1 - discountPct / 100))

                let couponPrice: number      // 최종 고객 결제가 (모든 쿠폰 반영)
                let settlementBase: number   // 정산액 계산에 쓸 금액 (플랫폼 부담 쿠폰은 제외)
                const platformCouponPct = platformCouponRates[rateKey(it.key)] ?? 0
                const brandCouponPct = brandCouponRates[rateKey(it.key)] ?? 0
                const couponPct = couponRates[rateKey(it.key)] ?? 0

                if (!showCoupon) {
                  couponPrice = discountPrice
                  settlementBase = discountPrice
                } else if (splitCoupon) {
                  couponPrice = Math.round(discountPrice * (1 - platformCouponPct / 100) * (1 - brandCouponPct / 100))
                  settlementBase = Math.round(discountPrice * (1 - brandCouponPct / 100)) // 플랫폼쿠폰은 제외
                } else {
                  couponPrice = Math.round(discountPrice * (1 - couponPct / 100))
                  settlementBase = couponPrice
                }

                const multiple = it.cost_price > 0 ? Math.round((couponPrice / it.cost_price) * 100) / 100 : 0

                // 할인(%) 10%마다 수수료 1%p 감소 (WOO, 클라만 제외)
                const feeReduction = FEE_DISCOUNT_APPLICABLE[platform] ? Math.floor(discountPct / 10) * 0.01 : 0
                const effectiveFeeRate = Math.max(0, feeRate - feeReduction)

                const settlement = Math.round(settlementBase * (1 - effectiveFeeRate))
                const profit = settlement - it.cost_price - CURRENT_SHIPPING_FEE
                return (
                  <tr key={it.key} style={{ borderBottom: '1px solid #f1f5f9' }}>
                    <td style={{ padding: '8px', textAlign: 'center' }}>
                      <span style={{ background: '#f1f5f9', color: '#475569', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>{it.season}</span>
                    </td>
                    <td style={{ padding: '8px', textAlign: 'center' }}><span style={{ background: '#eef2ff', color: '#4f46e5', padding: '2px 8px', borderRadius: 6, fontSize: 11, fontWeight: 600 }}>{it.category}</span></td>
                    <td style={{ padding: '8px 12px', fontWeight: 600, textAlign: 'center' }}>{it.name}</td>
                    <td style={{ padding: '8px', textAlign: 'center', fontSize: 12 }}>
                      {(it.stockByOption || []).map(s => (
                        <span key={s.option} style={{ marginRight: 8, whiteSpace: 'nowrap' }}>
                          {s.option}: <span style={{ color: '#2563eb', fontWeight: 700 }}>{s.qty}</span>
                        </span>
                      ))}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'center', color: '#64748b' }}>{formatWon(it.cost_price)}</td>
                    <td style={{ padding: '8px', textAlign: 'center' }}>{formatWon(it.sell_price)}</td>
                    <td style={{ padding: '8px', textAlign: 'center' }}>
                      <input type="number" min={0} max={100} value={discountPct || ''} placeholder="0"
                        onChange={e => setRate(setDiscountRates, rateKey(it.key), e.target.value)}
                        style={{ width: 60, padding: '5px 8px', border: '1px solid #94a3b8', borderRadius: 6, textAlign: 'center', fontSize: 13, fontFamily: 'inherit' }} />
                      <span style={{ marginLeft: 2, fontSize: 12, color: '#94a3b8' }}>%</span>
                    </td>
                    <td style={{ padding: '8px', textAlign: 'center', fontWeight: 700, color: '#d97706' }}>{formatWon(discountPrice)}</td>

                    {!showCoupon ? null : splitCoupon ? (
                      <>
                        <td style={{ padding: '8px', textAlign: 'center' }}>
                          <input type="number" min={0} max={100} value={platformCouponPct || ''} placeholder="0"
                            onChange={e => setRate(setPlatformCouponRates, rateKey(it.key), e.target.value)}
                            style={{ width: 60, padding: '5px 8px', border: '1px solid #94a3b8', borderRadius: 6, textAlign: 'center', fontSize: 13, fontFamily: 'inherit' }} />
                          <span style={{ marginLeft: 2, fontSize: 12, color: '#94a3b8' }}>%</span>
                        </td>
                        <td style={{ padding: '8px', textAlign: 'center' }}>
                          <input type="number" min={0} max={100} value={brandCouponPct || ''} placeholder="0"
                            onChange={e => setRate(setBrandCouponRates, rateKey(it.key), e.target.value)}
                            style={{ width: 60, padding: '5px 8px', border: '1px solid #94a3b8', borderRadius: 6, textAlign: 'center', fontSize: 13, fontFamily: 'inherit' }} />
                          <span style={{ marginLeft: 2, fontSize: 12, color: '#94a3b8' }}>%</span>
                        </td>
                      </>
                    ) : (
                      <td style={{ padding: '8px', textAlign: 'center' }}>
                        <input type="number" min={0} max={100} value={couponPct || ''} placeholder="0"
                          onChange={e => setRate(setCouponRates, rateKey(it.key), e.target.value)}
                          style={{ width: 60, padding: '5px 8px', border: '1px solid #94a3b8', borderRadius: 6, textAlign: 'center', fontSize: 13, fontFamily: 'inherit' }} />
                        <span style={{ marginLeft: 2, fontSize: 12, color: '#94a3b8' }}>%</span>
                      </td>
                    )}

                    {showCoupon && (
                      <td style={{ padding: '8px', textAlign: 'center', fontWeight: 700, color: '#2563eb' }}>{formatWon(couponPrice)}</td>
                    )}
                    <td style={{ padding: '8px', textAlign: 'center', color: '#8b5cf6', fontWeight: 700 }}>{multiple}배</td>
                    <td style={{ padding: '8px', textAlign: 'center', color: feeReduction > 0 ? '#059669' : undefined, fontWeight: feeReduction > 0 ? 700 : undefined }}>
                      {(effectiveFeeRate * 100).toFixed(1)}%{feeReduction > 0 ? ` (-${(feeReduction * 100).toFixed(0)}%p)` : ''}
                    </td>
                    <td style={{ padding: '8px', textAlign: 'center' }}>{formatWon(settlement)}</td>
                    <td style={{ padding: '8px', textAlign: 'center', fontWeight: 800, color: profit >= 0 ? '#059669' : '#e11d48' }}>{formatWon(profit)}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}

      <div style={{ marginTop: 16, fontSize: 12, color: '#94a3b8' }}>
        · 옵션(사이즈)은 가격이 동일해서 상품명 기준으로 한 줄로 합쳤어요 · 할인은 판매가에 먼저 적용되고, 쿠폰은 할인적용가에 추가로 적용돼요
        · 무신사/REKET은 쿠폰이 "{PLATFORM_COUPON_LABEL['무신사']}/{PLATFORM_COUPON_LABEL['REKET']}"(플랫폼 부담)과 "브랜드쿠폰"(셀러 부담)으로 나뉘고, <b>정산액 계산에는 플랫폼 부담 쿠폰이 반영되지 않아요</b>
        · 자사몰/무신사/REKET은 할인 10%마다 수수료가 1%p씩 낮아져요(WOO·클라만 제외) · 쿠폰/할인(%)은 화면에서만 계산되는 시뮬레이션 값이에요(저장되지 않음) · 택배비는 현재 기준({formatWon(CURRENT_SHIPPING_FEE)}) 고정 · 상단 "일괄입력"으로 현재 필터에 걸린 상품 전체에 같은 값을 한번에 넣을 수 있어요
      </div>
    </div>
  )
}