-- 무신사 정산 건별 테이블에 주문번호/주문일련번호 컬럼 추가
-- (일별 주문표에서 날짜 클릭 시 주문번호를 보여주기 위함 — 판매/환불 매칭용)
-- Supabase SQL Editor에서 실행. 이미 실행했어도 다시 실행 가능 (if not exists 처리됨).

alter table musinsa_settlement_lines add column if not exists order_no text;
alter table musinsa_settlement_lines add column if not exists order_line_no text;
