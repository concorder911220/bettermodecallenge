# Inventory reservation service (Bettermode Backend Challenge)

## What you built

Backend service for **limited-inventory items** with **reservations** and **pending queue**. Users create orders; if stock is available they get a time-limited reservation (awaiting payment); otherwise the order stays PENDING (FIFO). When a reservation expires, inventory is released and the next PENDING order is promoted. Payment finalizes the order. Implemented in **TypeScript + NestJS**, **PostgreSQL**, with **transactional concurrency** and a **scheduler** for expiry + promotion.

## Assumptions (Step 0)

- **Items**: Multiple items supported; each has `totalStock` and `soldStock`. Available for sale = totalStock − soldStock; available to reserve = that minus sum(ACTIVE reservation quantities). When totalStock − soldStock = 0, the item is **sold out** and `POST /orders` returns 400.
- **Order amount**: Each order has an `amount` (default 1); the user can reserve/buy multiple units in one order.
- **Reservation TTL**: 2 minutes (configurable via `RESERVATION_TTL_SEC`).
- **Payment**: Simulated via `POST /orders/:id/pay` (no real gateway).
- **Fairness**: PENDING orders are promoted FIFO by `created_at`.
- **Auth**: None; gateway is trusted (customer IDs are taken from request body).


## Architecture overview

- **NestJS** modules: `AppModule`, `OrdersModule`, `ItemsModule`.
- **DB**: PostgreSQL, **TypeORM**, `synchronize: true` for dev (use migrations in prod).
- **Worker**: `@nestjs/schedule` cron every 2 seconds to find expired reservations, mark them EXPIRED, and run **promotion** for the same item.


## Data model

| Table          | Main fields                                                                 | Invariants |
|----------------|-----------------------------------------------------------------------------|------------|
| **items**      | id, total_stock, sold_stock                                                | sold_stock ≤ total_stock |
| **orders**    | id, customer_id, item_id, amount, status, created_at                      | status ∈ PENDING \| RESERVED \| COMPLETED \| CANCELED \| EXPIRED; amount ≥ 1 |
| **reservations** | id, order_id (unique), item_id, quantity, status, expires_at, created_at | quantity = order.amount; sum(ACTIVE quantities per item) ≤ total_stock − sold_stock |


## API endpoints

| Method | Path | Body | Response |
|--------|------|------|----------|
| POST | /items | `{ "totalStock": 10 }` (integer ≥ 0) | Item |
| GET | /items/:id | - | Item |
| POST | /orders | `{ "customerId": "u1", "itemId": "<uuid>", "amount": 1 }` (amount optional, default 1) | Order (+ `expiresAt` if RESERVED). **400** if item sold out (totalStock − soldStock = 0). |
| GET | /orders/:id | - | Order with reservation (+ `expiresAt` when RESERVED) |
| POST | /orders/:id/pay | - | Order (COMPLETED); idempotent. When item becomes sold out, all PENDING orders for that item are set to EXPIRED. |
| POST | /orders/:id/cancel | - | Order (CANCELED). PENDING → CANCELED; RESERVED → CANCELED + release reservation and promote next PENDING. 400 if already COMPLETED/EXPIRED/CANCELED. |

**Example**

```bash
# Create item
curl -X POST http://localhost:3000/items -H "Content-Type: application/json" -d '{"totalStock": 10}'
# Create order (reserve or pending; amount optional, default 1)
curl -X POST http://localhost:3000/orders -H "Content-Type: application/json" -d '{"customerId":"u1","itemId":"<item-id>","amount":2}'
# Pay
curl -X POST http://localhost:3000/orders/<order-id>/pay
```


## Lifecycle (state machine)

```
Order:    [create] → PENDING or RESERVED
              RESERVED --(pay in time)--> COMPLETED
              RESERVED --(TTL passed)--> EXPIRED → [promote next PENDING → RESERVED]
              PENDING --(promoted)--> RESERVED

Reservation: ACTIVE --(pay)--> FINALIZED
             ACTIVE --(TTL)--> EXPIRED
```


## Concurrency strategy

- **Create order + reserve**: One transaction per request. Lock item row with `SELECT ... FOR UPDATE` (TypeORM `pessimistic_write`). Count ACTIVE reservations for that item; if `available > 0` create order (RESERVED) + reservation (ACTIVE, expires_at); else create order (PENDING). Guarantees at most `totalStock` active reservations per item under concurrent requests.
- **Pay**: Transaction with **pessimistic lock** on order + reservation to prevent race condition with expiry scheduler. Check reservation ACTIVE and `expires_at > now()`; then use **conditional update** with status check (`WHERE status = ACTIVE`) to set reservation → FINALIZED, order → COMPLETED. Idempotent: if already COMPLETED, return success. If conditional update affects 0 rows (race detected), re-check and return appropriate result.
- **Expiry processing**: Uses `SKIP LOCKED` when locking expired reservations to avoid blocking when multiple reservations expire simultaneously. Each reservation is processed in its own transaction with pessimistic lock + SKIP LOCKED, then conditionally updated (only if still ACTIVE).
- **Promotion**: Inside expiry job, per expired reservation we run a transaction that: marks reservation EXPIRED, order EXPIRED; then **promotes**: lock item row, take oldest PENDING order (by created_at) with `SKIP LOCKED` to avoid blocking concurrent promotions, if stock available create new ACTIVE reservation and set order RESERVED with conditional update. Item lock prevents double promotion for the same item. Defensive checks: verify reservation doesn't already exist, rollback if order status changed during promotion.


## Timeout strategy (expiry)

- **Variant A – Scheduler polling**: Cron every 2 seconds (`@Cron('*/2 * * * * *')`). Query reservations with `status = ACTIVE` and `expires_at <= now()`, then for each (in its own transaction) use pessimistic lock with `SKIP LOCKED` to avoid blocking, re-check ACTIVE, conditionally update to EXPIRED (only if still ACTIVE), and run promotion. Errors are caught and logged per reservation to prevent one failure from blocking others. Trade-off: simple, no queue; slight delay (up to poll interval) and polling overhead.


## Trade-offs and alternatives

- **Polling vs delayed jobs**: Delayed jobs (e.g. BullMQ) would give exact expiry timing and less DB polling, but add Redis and more infra; for this challenge polling is acceptable.
- **synchronize: true**: Used for quick setup; production should use migrations.
- **Promotion lock**: Item row lock is used so only one promoter per item at a time; alternative is advisory lock (e.g. `pg_advisory_xact_lock(item_id_hash)`).
- **SKIP LOCKED usage**: Used in expiry processing and promotion to prevent deadlocks and blocking when multiple operations happen simultaneously. Alternative would be NOWAIT (fail fast) or retry logic, but SKIP LOCKED provides better throughput.
- **Conditional updates**: All critical state transitions use conditional updates (WHERE status = expected_status) for extra safety and idempotency. This ensures operations are safe even if called multiple times or in edge cases.
- **Error handling**: Expiry processing catches and logs errors per reservation to prevent cascading failures. Production should also include monitoring/alerting for repeated failures.


**Demo for customer:** see **[DEMO.md](./DEMO.md)** for step-by-step testing and how to show that external services are stubbed and performance/reliability expectations are met.

---

## How to run

**Prerequisites**: Node 20+, Docker (for Postgres).

1. **Start Postgres**
   ```bash
   docker compose up -d postgres
   npm install --legacy-peer-deps
   npm run start:dev
   ```
   Or run app in Docker too:
   ```bash
   docker compose up -d
   ```

2. **Env** (optional): `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `RESERVATION_TTL_SEC` (default 120), `PORT` (default 3000).

3. **Seed DB** (for local testing with sample data)
   ```bash
   npm run db:seed          # truncate + insert 5 items (requires DB running)
   npm run db:start:seed   # start Postgres (Docker), create DB, then seed
   ```

4. **Swagger**  
   After starting the app, open **http://localhost:3000/api** for interactive API docs.

5. **Tests**
   - Unit: `npm test`
   - E2E (requires Postgres): Start Postgres first (`docker compose up -d postgres`); ensure `inventory` DB exists (`npm run db:create` if using Docker). Then `npm run test:e2e` (uses `RESERVATION_TTL_SEC=2` for expiry tests).

E2E covers: create order (reserve/pending), concurrency (100 requests, stock 10 → 10 RESERVED / 90 PENDING), payment idempotency, expiry + promotion, pay-after-expiry returns 404.

---

## Compliance with challenge requirements

### External services (stubbed / simulated)

- **Payment**: Fully **simulated**. There is no integration with Stripe or any real payment provider. The endpoint `POST /orders/:id/pay` only updates order and reservation status in the DB (COMPLETED / FINALIZED). No external HTTP calls, no webhooks. This satisfies: *"External services such as payment providers ... should be stubbed or simulated."*
- **Notifications**: **Not implemented** (out of scope). The challenge does not require email/SMS/push; promotion of the next PENDING order is done internally by the scheduler. If needed later, a notification call could be stubbed the same way as payment.

### Performance & reliability expectations

- **Predictable, low-latency responses under concurrency**:  
  - Each API path uses short, single transactions with row-level locks (`FOR UPDATE` on item/order/reservation).  
  - No long-running or blocking work in the request path; expiry and promotion run in a background cron.  
  - Deadlocks on `create` are handled with **automatic retry** (up to 5 attempts, then 8 in e2e), so transient contention does not surface as 500s to the client.

- **No degradation under contention**:  
  - **Connection pool** is set (e.g. `extra.max: 110`) so many concurrent requests do not exhaust connections.  
  - **SKIP LOCKED** in expiry and promotion avoids one slow or stuck reservation from blocking others.  
  - **Conditional updates** (`WHERE status = ACTIVE`) ensure correctness under races; failed updates are handled (e.g. idempotent pay, re-check).  
  - E2E test **100 parallel POST /orders** for one item (stock 10) and assert exactly 10 RESERVED and 90 PENDING with no failed requests (after retries), demonstrating correct and stable behavior under load.

- **Autoscaler assumption** (“ideal, lag-free autoscaler”): the service is stateless (DB is the only shared state). To **simulate** multiple replicas, use `docker compose -f docker-compose.scale.yml up` (2 app replicas + nginx round-robin) and run `sh scripts/demo-scale-load.sh`: again 100 concurrent orders, stock 10 → 10 RESERVED, 90 PENDING. So we can **show** the customer that “autoscaled” replicas still behave correctly (see [DEMO.md](./DEMO.md) §6).

