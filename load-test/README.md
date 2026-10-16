# Load test (k6)

Kịch bản thử tải cho API cửa hàng: ba nhóm người dùng chạy **cùng lúc**, mỗi người có "thời gian suy nghĩ" giữa các thao tác (người thật không bấm 100 lần mỗi giây).

| Nhóm | Làm gì | Tỉ trọng (profile `load`) |
|---|---|---|
| `browse` (khách) | trang chủ, tìm kiếm tiếng Việt, danh mục, sắp xếp giá, trang sản phẩm, facets | 100 người |
| `shoppers` | xem giỏ, thêm 1 đến 2 món, đặt đơn COD (có `Idempotency-Key`), xem đơn vừa đặt | 50 người |
| `account` | danh sách đơn, đếm theo trạng thái, lọc, chi tiết đơn, thanh toán, địa chỉ | 40 người |
| `flash` (`PROFILE=flash`) | 100 người cùng mua **một** sản phẩm sắp hết hàng, rồi bấm lại cùng khóa | 100 người |

## Chạy (luôn trên bản SAO của database, không bao giờ trên `ecom_db`)

```bash
# 1. Bản sao database và các dịch vụ tách biệt (backend phải đang tắt vì sao chép cần không có kết nối)
docker exec ecom_postgres psql -U root -d postgres -c "CREATE DATABASE ecom_load TEMPLATE ecom_db"
docker exec ecom_rabbitmq rabbitmqctl add_vhost load
docker exec ecom_rabbitmq rabbitmqctl set_permissions -p load admin ".*" ".*" ".*"

# 2. Bật backend trỏ vào bản sao (cổng 4100, Redis db 2, vhost riêng)
PORT=4100 DATABASE_URL=<DATABASE_URL của .env, đổi ecom_db thành ecom_load> REDIS_DB=2 \
  RABBITMQ_URL=amqp://admin:admin@localhost:5672/load node dist/main

# 3. Tạo người dùng thử kèm token (không đăng nhập qua API: đăng nhập chỉ cho 5 lần mỗi 15 phút mỗi IP)
node load-test/prepare.mjs               # 300 người, đủ cho smoke và load
USERS=800 node load-test/prepare.mjs     # cho stress

# 4. Chạy
k6 run -e PROFILE=smoke  load-test/scenario.js   # 1 phút, kiểm tra kịch bản chạy đúng
k6 run -e PROFILE=load   load-test/scenario.js   # 5 phút, một ngày đông khách
k6 run -e PROFILE=stress load-test/scenario.js   # 8 phút, tìm giới hạn
k6 run -e PROFILE=flash  load-test/scenario.js   # flash sale
```

Dọn dẹp: `DROP DATABASE ecom_load`, `rabbitmqctl delete_vhost load`, `redis-cli -n 2 FLUSHDB`.

## Ngưỡng đạt (threshold)

| Chỉ số | Ngưỡng |
|---|---|
| Yêu cầu lỗi (4xx, 5xx không mong đợi) | dưới 1% |
| Khách duyệt web | p95 dưới 400 ms, p99 dưới 1 giây |
| Người mua hàng | p95 dưới 800 ms, p99 dưới 1,5 giây |
| Xem tài khoản | p95 dưới 300 ms, p99 dưới 800 ms |
| Bị giới hạn tần suất (429) | đúng 0: kịch bản phải đi chậm hơn giới hạn của API, nếu có 429 là kịch bản sai |
| Flash sale: kết quả ngoài dự kiến | đúng 0 |

Mỗi người dùng bị giới hạn 60 lần đọc và 10 lần ghi đơn mỗi phút, nên mỗi người ảo là một **người dùng khác nhau**.

## Flash sale: kiểm tra không bán lố

Sau khi chạy `PROFILE=flash` (stock lúc bắt đầu thấy bằng lệnh đầu tiên):

```sql
-- Trước khi chạy: còn bao nhiêu
SELECT "onHand" FROM "SkuStock" WHERE "skuId" = 'seed_sku_flash';
-- Sau khi chạy: số đơn thành công phải BẰNG số đã trừ khỏi kho, và kho không âm
SELECT count(*) AS don_cua_flash FROM "OrderItem" WHERE "skuId" = 'seed_sku_flash' AND "orderId" IN (SELECT id FROM "Order" WHERE "idempotencyKey" LIKE 'flash-%');
SELECT "onHand" FROM "SkuStock" WHERE "skuId" = 'seed_sku_flash';
```

Báo cáo của k6 in `flash: created=` và `sold out=`: `created` không được vượt số hàng lúc đầu.

## Đọc kết quả

Báo cáo cuối in từng endpoint (trung vị, p95, p99, lớn nhất). Cùng lúc nên nhìn CPU của Postgres (`docker stats ecom_postgres`) và của tiến trình backend: bên nào chạm trần trước là cổ chai. File `result-<profile>.json` chứa số liệu đầy đủ (không commit).

`users.json` và `result-*.json` chứa token và bị git bỏ qua.
