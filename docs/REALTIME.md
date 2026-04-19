# Realtime (SSE) Contract

This system provides **server-sent events (SSE)** for real-time UI refresh.

## Endpoint

- `GET /api/realtime/stream`

  - Auth: `Authorization: Bearer <accessToken>`
  - Response: `text/event-stream`
  - Notes:
    - Server sends `ready` once connected.
    - Server sends `ping` every ~25s.
    - Clients should reconnect with backoff.

- `GET /api/realtime/health`
  - Auth: none
  - Response: `{ "status": "ok" }`
  - Notes: lightweight health check (does not open an SSE stream).

## Message shape

Events are delivered as SSE `event:` with a `data:` JSON payload:

```json
{
  "ts": "2026-01-12T00:00:00.000Z",
  "payload": { "...": "..." }
}
```

The shared client maps this to:

- `type` = SSE event name
- `ts` = timestamp
- `payload` = inner payload

## Event types (current)

These events are intentionally small and are usually used as "invalidate + refetch" signals.

- `ready` — stream handshake
- `ping` — keepalive
- `auth.error` — emitted client-side when the stream gets a 401/403

Domain refresh events:

- `deals.changed`

  - Meaning: campaign/deal inventory changed for the current user’s scope
  - Typical triggers:
    - Brand creates/updates a campaign and assigns/removes agencies
    - Agency assigns slots to mediators for a campaign
    - Inventory campaigns created by agency/mediator

- `users.changed`

  - Meaning: user/network state changed
  - Typical triggers:
    - Buyer created under a mediator code
    - Buyer approved/rejected by mediator
    - Mediator join request created (mediator joins via agency code)
    - Mediator approved by agency/admin/ops
    - Brand↔Agency connection approved/rejected/removed

- `wallets.changed`

  - Meaning: wallet balances/ledger changed

- `orders.changed`

  - Meaning: orders workflow/visibility changed

- `tickets.changed`

  - Meaning: ticket state changed

- `notifications.changed`
  - Meaning: notifications inbox/derived notifications may have changed

## Audience / scoping

The backend scopes delivery using audience selectors.

Important: events **must** include an explicit `audience` (fail-closed).
Broadcasts must be explicit (`{ audience: { broadcast: true } }`).

- `broadcast: true` — deliver to all connected users (avoid for high-volume events)
- `userIds: string[]` — deliver to specific users by `id`
- `roles: Role[]` — deliver to all connected users with matching roles
- `agencyCodes: string[]` — deliver to agency users whose `mediatorCode` matches
- `mediatorCodes: string[]` — deliver to mediator users whose `mediatorCode` matches
- `brandCodes: string[]` — deliver to brand users whose `brandCode` matches
- `parentCodes: string[]` — deliver to users whose `parentCode` matches (e.g., shoppers)

In production, prefer **scoped** delivery (code/userId) over broadcast.

## Client implementation

The shared SSE client is in `shared/services/realtime.ts`.

- Uses `fetch()` with `Accept: text/event-stream`
- Parses `event:` and `data:` frames
- Implements reconnect with exponential backoff

Production note:

- The client prefers connecting **directly to the backend** for the SSE stream when an absolute backend URL is available (e.g. via `NEXT_PUBLIC_API_PROXY_TARGET`).
  - This avoids hosting proxies/CDNs that may buffer or disrupt long-lived streaming responses.
  - Ensure the backend `CORS_ORIGINS` allows the portal origins.

UIs generally subscribe and then schedule a debounced `fetchData()` when receiving relevant event types.
