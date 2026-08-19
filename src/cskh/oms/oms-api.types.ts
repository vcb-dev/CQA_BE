export interface OmsLocation {
  id: string;
  sapo_id: string;
  code: string | null;
  name: string;
  status: string;
  default_location: boolean;
}

export interface OmsLocationsResponse {
  data: OmsLocation[];
}

export interface OmsCategory {
  id: string;
  name: string;
  alias: string;
  parent_id: string | null;
  products_count: number;
  children: OmsCategory[];
}

export interface OmsCategoriesResponse {
  data: OmsCategory[];
}

export interface OmsMetricValue {
  value: number;
  change_pct?: number;
}

export interface OmsTopOrderedProduct {
  product_id: string;
  name: string;
  category: string;
  order_count: number;
  quantity: number;
  change_pct: number;
}

export interface OmsOutOfStockItem {
  variant_id: string;
  sku: string;
  product_name: string;
  shortage: number;
  available: number;
  stuck_orders: number;
}

export interface OmsCategoryDistributionItem {
  category: string;
  revenue: number;
  pct: number;
}

export interface OmsRevenueByProductRow {
  label: string;
  sku: string;
  quantity: number;
  order_count: number;
  total_price: number;
}

export interface OmsRevenueByProductResponse {
  data: OmsRevenueByProductRow[];
}

export interface OmsProductListItem {
  id: string;
  name: string;
  image_url: string | null;
  default_sku: string | null;
  skus: string[];
  variant_count: number;
  price_from: number | null;
  is_published: boolean;
}

export interface OmsProductsResponse {
  data: OmsProductListItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface OmsProductVariant {
  id: string;
  sku: string | null;
  price: number;
  enabled: boolean;
  option_values: string[];
  image_url: string | null;
}

export interface OmsProductDetail {
  id: string;
  name: string;
  image_url: string | null;
  is_published: boolean;
  variants: OmsProductVariant[];
}

export interface OmsProductDetailResponse {
  data: OmsProductDetail;
}

export interface OmsInventoryRow {
  variant_id: string;
  location_id: string;
  location_name: string;
  available: number;
  on_hand: number;
}

export interface OmsInventoryResponse {
  data: OmsInventoryRow[];
}

export interface OmsCustomer {
  id: string;
  name: string | null;
  first_name: string | null;
  phone: string | null;
}

export interface OmsCustomersResponse {
  data: OmsCustomer[];
}

export interface OmsOrder {
  id?: string;
  name?: string;
  order_number?: string;
  total_price?: number | string;
  [key: string]: unknown;
}

export interface OmsProductOperationsReport {
  period: { year: number; month: number; from: string; to: string };
  filters: { category_id: string | null; location_id: string | null };
  kpis: {
    products_ordered: OmsMetricValue;
    products_shipped: OmsMetricValue;
    ship_to_order_rate: OmsMetricValue;
    products_out_of_stock: OmsMetricValue;
  };
  top_ordered_products: OmsTopOrderedProduct[];
  out_of_stock: {
    items: OmsOutOfStockItem[];
    summary: { count: number; total_stuck_orders: number };
  };
  additional_metrics: {
    revenue: OmsMetricValue;
    category_distribution: OmsCategoryDistributionItem[];
    products_without_orders: { value: number };
    avg_processing_days: { value: number };
    cancel_return_rate: { value: number };
  };
}
