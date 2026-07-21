-- Backfill: các phiếu chuyển đang trên đường (dang_chuyen) được tạo trước khi
-- có bucket incoming tại kho nhận — ghi movement + cập nhật level để
-- receive/cancel sau này trừ incoming không bị âm, và reconcile vẫn khớp.
INSERT INTO inventory_movements
  (variant_id, warehouse_id, lot_id, bucket, change, type, reference_type, reference_id, created_by, created_at)
SELECT
  sti.variant_id,
  st.to_warehouse_id,
  sti.lot_id,
  'incoming'::"InventoryBucket",
  sti.quantity,
  'incoming_transfer'::"MovementType",
  'stock_transfer',
  st.id,
  st.created_by,
  now()
FROM stock_transfer_items sti
JOIN stock_transfers st ON st.id = sti.stock_transfer_id
WHERE st.status = 'dang_chuyen';

INSERT INTO inventory_levels (variant_id, warehouse_id, incoming, updated_at)
SELECT sti.variant_id, st.to_warehouse_id, SUM(sti.quantity), now()
FROM stock_transfer_items sti
JOIN stock_transfers st ON st.id = sti.stock_transfer_id
WHERE st.status = 'dang_chuyen'
GROUP BY sti.variant_id, st.to_warehouse_id
ON CONFLICT (variant_id, warehouse_id)
DO UPDATE SET
  incoming = inventory_levels.incoming + EXCLUDED.incoming,
  updated_at = now();
