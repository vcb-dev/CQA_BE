-- Phiếu chuyển kho ghi nhận "hàng đang về" (incoming) tại kho nhận,
-- khớp mô hình Sapo: hàng đang chuyển không biến mất khỏi mọi chỉ số.
ALTER TYPE "MovementType" ADD VALUE 'incoming_transfer';
