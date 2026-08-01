import { createClient } from '@supabase/supabase-js'

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL!
const supabaseKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!

export const supabase = createClient(supabaseUrl, supabaseKey)

// 타입 정의
export type Channel = {
  id: number
  name: string
  type: 'online' | 'offline'
  fee_rate: number
  color: string
}

export type Item = {
  id: number
  name: string
  sku: string
  category: string
  option_name: string
  sell_price: number
  cost_price: number
  season: string
}

export type Sale = {
  id: number
  item_id: number
  channel_id: number
  order_date: string
  qty: number
  unit_price: number
  gross_revenue: number
  fee_amount: number
  net_revenue: number
  order_no: string
}

export type InventorySummary = {
  id: number
  name: string
  sku: string
  category: string
  option_name: string
  sell_price: number
  cost_price: number
  initial_qty: number
  reorder_qty: number
  damaged_qty: number
  total_sold: number
  available_qty: number
}

export type MonthlySalesByChannel = {
  month: string
  channel: string
  color: string
  gross: number
  fees: number
  net: number
  qty: number
}