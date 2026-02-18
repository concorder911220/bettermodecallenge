#!/usr/bin/env sh
# Demo: hit the load-balanced endpoint (2 replicas) with 100 concurrent orders for one item (stock 10).
# Expect: exactly 10 RESERVED, 90 PENDING. Proves "autoscaler + multiple replicas" still correct.
set -e
BASE="${BASE_URL:-http://localhost:3000}"
echo "Creating item (totalStock=10) at $BASE..."
ITEM_ID=""
for attempt in 1 2 3 4 5 6 7 8 9 10 11 12; do
  RESP=$(curl -s -w "\n%{http_code}" -X POST "$BASE/items" -H "Content-Type: application/json" -d '{"totalStock":10}')
  CODE=$(echo "$RESP" | tail -n1)
  BODY=$(echo "$RESP" | sed '$d')
  ITEM_ID=$(echo "$BODY" | grep -o '"id":"[^"]*"' | cut -d'"' -f4)
  if [ -n "$ITEM_ID" ]; then
    break
  fi
  if [ "$attempt" -lt 12 ]; then
    echo "  Attempt $attempt: HTTP $CODE — waiting 5s..."
    echo "$BODY" | head -c 200
    echo ""
    sleep 5
  fi
done
if [ -z "$ITEM_ID" ]; then
  echo "Failed to create item after 12 attempts. Last response (HTTP $CODE):"
  echo "$BODY"
  exit 1
fi
echo "Item ID: $ITEM_ID"
echo "Sending 100 concurrent POST /orders..."
for i in $(seq 1 100); do
  curl -s -X POST "$BASE/orders" -H "Content-Type: application/json" -d "{\"customerId\":\"user-$i\",\"itemId\":\"$ITEM_ID\"}" > "/tmp/order-$i.json" &
done
wait
RESERVED=$(grep -l '"status":"RESERVED"' /tmp/order-*.json 2>/dev/null | wc -l | tr -d ' ')
PENDING=$(grep -l '"status":"PENDING"' /tmp/order-*.json 2>/dev/null | wc -l | tr -d ' ')
echo "Result: $RESERVED RESERVED, $PENDING PENDING"
if [ "$RESERVED" = "10" ] && [ "$PENDING" = "90" ]; then
  echo "OK — inventory correct under load across replicas."
else
  echo "Unexpected counts (expected 10 RESERVED, 90 PENDING)."
  exit 1
fi
rm -f /tmp/order-*.json
