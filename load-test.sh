#!/usr/bin/env bash

ORCHESTRA_KEY="orchestra-dev-api-key-12345"
ORCHESTRA_URL="http://localhost:3000"

fire_workflow() {
  local i=$1
  curl -s -o /dev/null -w "%{http_code}\n" \
    -X POST "$ORCHESTRA_URL/workflows" \
    -H "Authorization: Bearer $ORCHESTRA_KEY" \
    -H "Content-Type: application/json" \
    -d "{
      \"name\": \"load-test-order-$i\",
      \"steps\": [
        {
          \"name\": \"validate\",
          \"type\": \"validate-order\",
          \"payload\": { \"orderId\": \"ORD-$i\", \"amount\": $((RANDOM % 500 + 10)) }
        },
        {
          \"name\": \"charge\",
          \"type\": \"charge-payment\",
          \"payload\": { \"orderId\": \"ORD-$i\", \"amount\": $((RANDOM % 500 + 10)) },
          \"dependsOn\": [\"validate\"]
        },
        {
          \"name\": \"notify-warehouse\",
          \"type\": \"notify-warehouse\",
          \"payload\": { \"orderId\": \"ORD-$i\" },
          \"dependsOn\": [\"charge\"],
          \"parallelGroup\": \"fulfillment\"
        },
        {
          \"name\": \"update-inventory\",
          \"type\": \"update-inventory\",
          \"payload\": { \"orderId\": \"ORD-$i\", \"sku\": \"SKU-$((RANDOM % 100))\" },
          \"dependsOn\": [\"charge\"],
          \"parallelGroup\": \"fulfillment\"
        },
        {
          \"name\": \"generate-invoice\",
          \"type\": \"generate-report\",
          \"payload\": { \"orderId\": \"ORD-$i\", \"format\": \"pdf\" },
          \"dependsOn\": [\"charge\"],
          \"parallelGroup\": \"fulfillment\"
        },
        {
          \"name\": \"send-confirmation\",
          \"type\": \"send-email\",
          \"payload\": { \"to\": \"user$i@example.com\", \"subject\": \"Order ORD-$i confirmed\" },
          \"dependsOn\": [\"notify-warehouse\", \"update-inventory\", \"generate-invoice\"]
        }
      ],
      \"onFailure\": {
        \"type\": \"send-email\",
        \"payload\": { \"to\": \"ops@company.com\", \"subject\": \"Order ORD-$i FAILED\" }
      }
    }"
}

export -f fire_workflow
export ORCHESTRA_KEY ORCHESTRA_URL

echo "Firing 500 workflows..."
seq 1 500 | xargs -P 50 -I{} bash -c 'fire_workflow "$@"' _ {} | sort | uniq -c | sort -rn
echo "Done."
