-- 무신사 정산 데이터 전체 삭제 (재업로드로 주문번호를 새로 채우기 위한 초기화)
-- Supabase SQL Editor에서 실행하세요. 되돌릴 수 없으니 실행 전에 한 번 더 확인하세요.
-- 광고비(musinsa_ad_charge)는 정산 업로드와 무관한 수동 입력 데이터라 건드리지 않습니다.

delete from musinsa_settlement_lines where channel = '무신사';
delete from musinsa_settlement where channel = '무신사';
delete from musinsa_settlement_extra_fees where channel = '무신사';
