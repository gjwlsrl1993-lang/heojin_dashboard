import type { Metadata } from 'next'
import Link from 'next/link'
import './globals.css'

export const metadata: Metadata = {
  title: '헤오진 대시보드',
  description: '다채널 통합 매출 & 재고 관리',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>
        <div className="app-body">
          {/* 사이드바 */}
          <aside className="sidebar">
            <div style={{ marginTop: -10 }}>
              {/* 헤오진 대시보드 - 원래 상단 헤더에 있던 내용을 사이드바 맨 위로 이동 */}
              <div style={{ padding: '4px 4px 16px', borderBottom: '1px solid #e2e8f0', marginBottom: 12 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <div className="header-icon">
                    <svg width="22" height="22" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" />
                    </svg>
                  </div>
                  <Link href="/" style={{ textDecoration: 'none' }}>
                    <div>
                      <span className="header-title" style={{ fontSize: 15 }}>헤오진 대시보드</span>
                      <span className="header-badge">v1.0</span>
                    </div>
                    <div className="header-sub" style={{ fontSize: 11 }}>카페24 / 무신사 / WOO / REKET / 클라만</div>
                  </Link>
                </div>
                <div className="header-alert">
                  <span className="alert-dot"></span>
                  가용재고 실시간 감지 중
                </div>
              </div>

              {/* 종합 분석 */}
              <div className="sidebar-section">
                <span className="sidebar-label">종합 분석</span>
                <Link href="/" className="sidebar-link">
                  <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                  </svg>
                  통합 종합 대시보드
                </Link>
                <Link href="/items" className="sidebar-link">
                  <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  아이템 카테고리별 손익
                </Link>
              </div>

              {/* 채널별 */}
              <div className="sidebar-section">
                <span className="sidebar-label">플랫폼별 분석 & 업로드</span>
                {[
                  { href: '/channel/cafe24',  label: '자사몰 (카페24)',    color: '#10b981' },
                  { href: '/channel/musinsa', label: '무신사 (MUSINSA)', color: '#3b82f6' },
                  { href: '/channel/woo',     label: 'WOO',               color: '#8b5cf6' },
                  { href: '/channel/reket',   label: 'REKET',             color: '#f43f5e' },
                  { href: '/channel/claman',  label: '클라만 (오프라인)', color: '#f59e0b' },
                ].map(item => (
                  <Link key={item.href} href={item.href} className="sidebar-link">
                    <span className="channel-dot" style={{ background: item.color }}></span>
                    {item.label}
                  </Link>
                ))}
                <Link href="/discount" className="sidebar-link" style={{ marginTop: -5 }}>
                  <span style={{ fontSize: 16, marginRight: 2 }}>🏷️</span>
                  할인설정
                </Link>
              </div>

              {/* 재고 */}
              <div className="sidebar-section">
                <span className="sidebar-label">재고 관리</span>
                <Link href="/inventory" className="sidebar-link">
                  <svg width="20" height="20" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
                  </svg>
                  통합 재고 수동 제어판
                </Link>
                <Link href="/seeding" className="sidebar-link" style={{ marginTop: -5 }}>
                  <span style={{ fontSize: 16, marginRight: 2 }}>🎁</span>
                  시딩
                </Link>
                <Link href="/sponsorship" className="sidebar-link">
                  <span style={{ fontSize: 16, marginRight: 2 }}>🤝</span>
                  협찬
                </Link>
                <Link href="/repair" className="sidebar-link">
                  <span style={{ fontSize: 16, marginRight: 2 }}>🔧</span>
                  수선
                </Link>

              </div>
            </div>

            {/* 하단 상태 */}
            <div className="sidebar-bottom">
              <div className="sidebar-status">
                <span className="status-dot"></span>
                Supabase 연결됨
              </div>
              <div className="sidebar-status-sub">실시간 재고 & 매출 데이터 동기화 중</div>
            </div>
          </aside>

          {/* 메인 */}
          <main className="main-content">
            {children}
          </main>
        </div>
      </body>
    </html>
  )
}