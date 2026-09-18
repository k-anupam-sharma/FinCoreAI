# Demo script — Phase 3: WhatsApp webhook

Reproducible verification steps for the `whatsapp-webhook` backend function.
Replace `<VERIFY_TOKEN>` and `<APP_SECRET>` with the real values stored via
`supabase_add_secret` — never commit real secret values here.

Base URL: `https://spb-t4nh1r2458mb8j8t.supabase.opentrust.net/functions/v1/whatsapp-webhook`

## 1. GET verification handshake

```bash
BASE="https://spb-t4nh1r2458mb8j8t.supabase.opentrust.net/functions/v1/whatsapp-webhook"

# Correct token -> 200, echoes the challenge
curl -s -o /tmp/out.txt -w "HTTP_STATUS:%{http_code}" "$BASE?hub.mode=subscribe&hub.verify_token=<VERIFY_TOKEN>&hub.challenge=CHALLENGE_ACCEPTED_123"; cat /tmp/out.txt

# Wrong token -> 403, no challenge echoed
curl -s -o /tmp/out.txt -w "HTTP_STATUS:%{http_code}" "$BASE?hub.mode=subscribe&hub.verify_token=wrong-token&hub.challenge=SHOULD_NOT_APPEAR"; cat /tmp/out.txt
```

## 2. POST with a valid signed payload

```bash
cat > /tmp/payload.json << 'EOF'
{"entry":[{"changes":[{"value":{"messages":[{"from":"911234567890","id":"wamid.TESTMSG001","timestamp":"1700000000","type":"text","text":{"body":"Hi"}}],"contacts":[{"wa_id":"911234567890","profile":{"name":"Test User"}}]}}]}]}
EOF

APP_SECRET="<APP_SECRET>"
BODY=$(cat /tmp/payload.json)
SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$APP_SECRET" | sed 's/^.* //')

curl -s -w "HTTP_STATUS:%{http_code}" -X POST "$BASE" -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=$SIG" --data-raw "$BODY"
# Expect: {"received":true} / HTTP 200
```

Verify the write in the database:

```sql
select * from conversation_sessions where wa_id = '911234567890';
select * from conversation_messages
  where session_id in (select id from conversation_sessions where wa_id = '911234567890')
  order by created_at;
-- Expect: one session, one inbound row ("Hi"), one outbound row (the main menu text)
```

## 3. POST with an invalid signature (negative test)

```bash
curl -s -w "HTTP_STATUS:%{http_code}" -X POST "$BASE" -H "Content-Type: application/json" -H "X-Hub-Signature-256: sha256=0000000000000000000000000000000000000000000000000000000000000000" --data-raw "$BODY"
# Expect: "Invalid signature" / HTTP 401, and no new rows written to either table
```

## 4. Live end-to-end test (real Meta credentials)

1. In Meta's App Dashboard, WhatsApp, Configuration: set the callback URL to the base URL above and the verify token to the value stored as `WHATSAPP_VERIFY_TOKEN`.
2. Subscribe to the `messages` webhook field.
3. From a real WhatsApp number, send "Hi" to the connected test business number.
4. Expect the 8-item main menu back within a few seconds; sending arbitrary text gets an echo/not-yet-implemented notice; sending an image gets an acknowledgement-only reply.

Verified live on 2026-09-18 — see the architecture plan's Phase 3 verification checklist.

## Status of later phases

Onboarding, invoice analysis, duplicate/vendor/anomaly detection, the decision
engine, Q&A, alerts, and forecasting are not yet wired into this webhook.
They currently exist only as the client-side demo at `/assistant`
(`src/lib/fincore/*`, `src/data/fincoreStore.ts`) and will be ported to
real backend functions phase by phase, per
`.enter/plans/fincore-ai-architecture.md`.
