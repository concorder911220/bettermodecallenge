# How to test and demonstrate the Flash Sale service

This guide shows how to prove to the customer that the system is **correct**, matches the **Flash Sale Challenge** requirements, and that **external services are stubbed** and **performance/reliability** expectations are met.

---

## 1. One-time setup

```bash
# Clone / open repo, install deps, start DB
npm install --legacy-peer-deps
docker compose up -d postgres
# If DB "inventory" does not exist (e.g. first run):
npm run db:create

# Optional: seed sample items for manual testing
npm run db:seed
```

---

## 2. Automated tests (proof of correctness)

Run these and show **all green**:

```bash
# Unit tests
npm test

# E2E tests (requires Postgres + DB "inventory")
npm run test:e2e
```

**What the E2E suite proves:**

| Test | What it demonstrates |
|------|----------------------|
| POST /orders → RESERVED when stock available | Reserve path and `expiresAt` in response |
| 100 parallel POST /orders, stock=10 → 10 RESERVED, 90 PENDING | **Concurrency**: inventory never over-reserved; no failed requests (with retries) |
| GET /orders/:id | Order + reservation returned correctly |
| POST /orders/:id/pay → COMPLETED, idempotent | **Simulated payment** and idempotency |
| After TTL: order EXPIRED, next PENDING promoted to RESERVED | **Expiry + promotion** (FIFO) |
| Pay after expiry → 404 | Expired reservations are not payable |

This is the main evidence that the **order/reservation lifecycle** and **concurrency** behave as required.

---

## 3. Manual demo (Swagger / curl)

Start the app:

```bash
npm run start:dev
```

Open **http://localhost:3000/api** (Swagger UI). Use it to show:

1. **Create item**  
   `POST /items` → body `{ "totalStock": 3 }` → note `id`.

2. **Reserve**  
   `POST /orders` → `{ "customerId": "alice", "itemId": "<id>" }` → response `status: RESERVED`, `expiresAt` set.

3. **Second customer gets RESERVED**  
   Same item, `customerId: "bob"` → again `RESERVED`.

4. **Fourth customer gets PENDING**  
   Same item, `customerId: "charlie"` → `status: PENDING` (no slot left).

5. **Payment (simulated)**  
   `POST /orders/<order-id>/pay` for one of the RESERVED orders → `status: COMPLETED`, reservation `FINALIZED`.  
   Call **pay** again for the same order → still 201, same result (idempotent).

6. **Expiry (optional, with short TTL)**  
   Restart app with `RESERVATION_TTL_SEC=10`. Create item (e.g. stock 1), create order → RESERVED. Do **not** pay. Wait >10 s. GET same order → `status: EXPIRED`. Create another order for same item → first PENDING, then after next cron run it can be promoted (or show in a second run).

This shows that **payment is simulated** (no real gateway) and that **lifecycle and limits** work as designed.

---

## 4. Pointing to the challenge requirements

When presenting to the customer, you can say:

- **“External services are stubbed”**  
  - Payment: no real gateway; `POST /orders/:id/pay` only updates DB state.  
  - Notifications: not in scope; no external notification calls.

- **“Performance & reliability”**  
  - E2E runs **100 concurrent** order creations; result is exactly 10 RESERVED, 90 PENDING and no failed requests.  
  - README section “Compliance with challenge requirements” describes: short transactions, retries on deadlock, connection pool, SKIP LOCKED, conditional updates, and how this avoids degradation under contention.

- **“Correctness and lifecycle”**  
  - E2E tests reserve/pending, payment (simulated), idempotent pay, expiry, promotion, and pay-after-expiry 404.  
  - README documents the state machine, concurrency strategy, and trade-offs.

---

## 5. Optional: quick load check

If the customer wants to see “many requests at once” live:

```bash
# Create one item with stock 20, then fire 50 concurrent orders
ITEM_ID=$(curl -s -X POST http://localhost:3000/items -H "Content-Type: application/json" -d '{"totalStock":20}' | jq -r .id)
for i in {1..50}; do
  curl -s -X POST http://localhost:3000/orders -H "Content-Type: application/json" -d "{\"customerId\":\"u$i\",\"itemId\":\"$ITEM_ID\"}" &
done
wait
# Then e.g. count RESERVED vs PENDING (e.g. via GET /orders or DB)
```

You should see exactly 20 RESERVED and 30 PENDING (no over-reservation). This reinforces the E2E concurrency test.

---

## Summary

| Goal | How to show it |
|------|-----------------|
| Correctness & lifecycle | Run `npm test` and `npm run test:e2e` — all green. |
| Payment is stubbed | Show Swagger/curl: `POST /orders/:id/pay` only changes status; no payment provider. |
| No degradation under load | E2E “100 parallel” test passes; README explains design (retries, pool, SKIP LOCKED). |
| Demo for stakeholder | Swagger at `/api` + short manual flow (reserve → pending → pay → expiry). |
