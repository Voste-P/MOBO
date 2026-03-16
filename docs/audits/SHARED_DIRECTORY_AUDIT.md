# Shared Directory Audit Report

> Full analysis of `@mobo/shared` — the shared package consumed by all 5 Next.js apps (buyer, mediator, agency, brand, admin).

---

## 1. Complete File Listing (63 files)

```
shared/
├── package.json                  # @mobo/shared v0.0.0, ESM, React 19 peer dep
├── tsconfig.json                 # ES2022, Bundler resolution, strict: false
├── types.ts                      # Central type definitions (~320 lines)
├── apps/
│   ├── AgencyApp.tsx             # Agency shell — auth guard + dashboard
│   ├── BrandApp.tsx              # Brand shell — auth guard + dashboard
│   ├── ConsumerApp.tsx           # Buyer shell — auth + tab navigation + contexts
│   └── MediatorApp.tsx           # Mediator shell — auth guard + dashboard
├── components/
│   ├── AppSwitchboard.tsx        # Landing page — 5 portal cards
│   ├── Chatbot.tsx               # AI chatbot (voice, images, deals) ~855 lines
│   ├── DesktopShell.tsx          # Sidebar + main responsive layout
│   ├── DisableNumberScroll.tsx   # Prevents scroll-wheel on number inputs
│   ├── ErrorBoundary.tsx         # React class error boundary
│   ├── MobileTabBar.tsx          # Bottom tab bar (glass/dark variants)
│   ├── Navbar.tsx                # Minimal top navbar
│   ├── NotificationSystem.tsx    # Stub — returns null (disabled)
│   ├── PortalGuard.tsx           # Wrong-role access guard
│   ├── ProductCard.tsx           # Product display with image proxy
│   ├── ZoomableImage.tsx         # Click-to-zoom fullscreen overlay
│   └── ui/
│       ├── index.ts              # Barrel exports
│       ├── cn.ts                 # className joiner utility
│       ├── Badge.tsx             # 5 variants (neutral/success/warning/danger/info)
│       ├── Button.tsx            # 4 variants, 4 sizes, icon support, forwardRef
│       ├── Card.tsx              # Card / CardHeader / CardContent
│       ├── EmptyState.tsx        # Empty state with icon + action
│       ├── FullPage.tsx          # FullPageLoading / Error / NotFound
│       ├── IconButton.tsx        # Round icon button (3 variants)
│       ├── Input.tsx             # Input with label/hint/error/icon, light+dark
│       ├── RealtimeStatusBadge.tsx # LIVE / OFFLINE status indicator
│       └── Spinner.tsx           # CSS border spinner
├── context/
│   ├── AuthContext.tsx           # JWT auth, login/register/logout, session restore
│   ├── CartContext.tsx           # Shopping cart with localStorage persistence
│   ├── ChatContext.tsx           # Per-user chat messages in sessionStorage
│   ├── NotificationContext.tsx   # Server + local notifications, realtime sync
│   └── ToastContext.tsx          # Ephemeral toasts (success/error/info/warning)
├── hooks/
│   └── useRealtimeConnection.ts  # SSE connection status tracker
├── layouts/
│   └── MoboHead.tsx             # Shared <head> — fonts, animations, CSS
├── pages/
│   ├── AdminPortal.tsx          # Admin dashboard (~2148 lines)
│   ├── AgencyAuth.tsx           # Agency login/register (~280 lines)
│   ├── AgencyDashboard.tsx      # Agency dashboard (~3679 lines)
│   ├── Auth.tsx                 # Buyer login/register (~262 lines)
│   ├── BrandAuth.tsx            # Brand login/register (~281 lines)
│   ├── BrandDashboard.tsx       # Brand dashboard (~2724 lines)
│   ├── Explore.tsx              # Product discovery (~200 lines)
│   ├── Home.tsx                 # Buyer home — wraps Chatbot (~16 lines)
│   ├── MediatorAuth.tsx         # Mediator login/register (~301 lines)
│   ├── MediatorDashboard.tsx    # Mediator dashboard (~2791 lines)
│   ├── Orders.tsx               # Buyer orders + proof upload (~2130 lines)
│   └── Profile.tsx              # Buyer profile + stats (~360 lines)
├── services/
│   ├── api.ts                   # Production REST API client (~993 lines)
│   ├── mockBackend.ts           # localStorage mock backend (~713 lines)
│   ├── mockData.ts              # Seed data generator (~552 lines)
│   └── realtime.ts              # SSE streaming client (~260 lines)
├── styles/
│   └── moboGlobals.ts           # HTML/body className constants
└── utils/
    ├── apiBaseUrl.ts            # API URL resolver (multi-env)
    ├── csvHelpers.ts            # CSV export with formula injection protection
    ├── errors.ts                # formatErrorMessage()
    ├── exportToSheets.ts        # Google Sheets OAuth export
    ├── formatCurrency.ts        # INR formatter (Intl.NumberFormat)
    ├── imageHelpers.ts          # urlToBase64 with origin check
    ├── mobiles.ts               # Indian mobile normalization (10 digits)
    ├── mojibake.ts              # UTF-8 → Win-1252 charset fix
    └── orderHelpers.ts          # getPrimaryOrderId helper
```

---

## 2. What Each Module Does

### 2.1 Services

| File | Purpose |
|------|---------|
| **api.ts** | Production HTTP client. `fetchJson()`/`fetchOk()` wrappers with JWT auto-refresh, `x-request-id` headers, 60s timeout, PWA offline detection, mojibake fixing. Namespaces: `api.auth`, `api.products`, `api.orders`, `api.chat`, `api.ops`, `api.brand`, `api.admin`, `api.tickets`, `api.ai`, `api.notifications`, `api.sheets`, `api.google`. Also exports `compressImage()` (canvas resize to 1200px, 0.7 JPEG quality). |
| **realtime.ts** | SSE (Server-Sent Events) streaming client via `RealtimeClient` class. Subscribes to `/api/events`, parses `event:`/`data:` lines, handles exponential backoff (1s→12s), idle reconnect at 70s, cross-tab auth sync via `StorageEvent`, auto token refresh on 401, mojibake fix on payloads. Exports `subscribeRealtime(listener)` and `stopRealtime()`. |
| **mockBackend.ts** | Full localStorage-based mock backend (`mobo_v7_` prefix) for offline/demo mode. Implements auth, products, orders, ops, brand, admin, and support APIs. Features: auto-settlement (14-day cooling), fraud detection (image hash), commission snapshot, duplicate order ID detection, campaign slot management, dispute freezing. |
| **mockData.ts** | Seed data generator. Creates 1 admin, 15 brands, 4 agencies, 40 campaigns, 28 mediators, 151 shoppers, ~800 orders, plus wallets and transactions. Uses realistic Indian brand names and Unsplash images. |

### 2.2 Components

| Component | Purpose |
|-----------|---------|
| **Chatbot.tsx** | AI-powered chatbot on the buyer home screen. Supports voice input (Web Speech API), image attachments (10MB max), quick-action buttons, Gemini-powered backend. Implements context caching (60s TTL), conversation history (last 6 messages), navigation via voice commands, rate-limit handling, fallback responses. Renders ProductCard carousels for deal searches and Order cards for order queries. |
| **AppSwitchboard.tsx** | Landing/role-selection screen — "BUZZMA OS" branding with 5 portal cards (Shopper, Mediator, Agency, Brand, Admin), each showing target device type (Mobile vs Web vs Terminal). |
| **DesktopShell.tsx** | Responsive sidebar+main layout for web portals. Collapsible sidebar with overlay on mobile, configurable widths, classes, and breakpoints. |
| **MobileTabBar.tsx** | Bottom floating tab bar for mobile apps with variants (`glass`, `dark`, `darkGlass`), badge support, active indicator animation, accessibility labels, safe-area padding. |
| **ProductCard.tsx** | Product display card with image proxy fallback, brand/platform tags, commission/cashback display, loot link button. Handles missing images with placeholder SVG. |
| **ZoomableImage.tsx** | Click-to-zoom fullscreen image overlay. Renders thumbnail; on click opens a fixed-position overlay with the full image. |
| **ErrorBoundary.tsx** | Standard React class error boundary with "Something went wrong" message and reload button. |
| **PortalGuard.tsx** | Shows when a user accesses the wrong role's portal. Displays "Wrong Portal" message with logout and optional back button. |
| **Navbar.tsx** | Minimal top navbar with BUZZMA branding (likely unused in favor of app-specific navbars). |
| **DisableNumberScroll.tsx** | Global listener preventing mousewheel events on `<input type="number">`. |
| **NotificationSystem.tsx** | Disabled stub — returns `null`. Notifications are handled via Chatbot header bell. |

### 2.3 UI Components

| Component | Purpose |
|-----------|---------|
| **Button** | 4 variants (primary/secondary/ghost/destructive), 4 sizes (sm/md/lg/icon), forwardRef, disabled spinner, `leftIcon`/`rightIcon`, full Tailwind styling. |
| **Input** | Controlled input with label, hint, error, left icon, light/dark tone modes, forwardRef, auto-generated IDs. |
| **Card** | Card / CardHeader / CardContent — rounded-[2rem] with optional `dark` prop. |
| **Badge** | 5 variants (neutral/success/warning/danger/info), renders as `<span>`. |
| **IconButton** | Round icon button, 3 variants (neutral/primary/danger). |
| **Spinner** | CSS `border-b-transparent` spinner with `motion-reduce` support. |
| **EmptyState** | Centered icon + title + description + optional action button. |
| **FullPage** | FullPageLoading (spinner), FullPageError (retry), FullPageNotFound (back to home). |
| **RealtimeStatusBadge** | Shows "LIVE" (green) or "OFFLINE" (red) badge using `useRealtimeConnection`. |
| **cn.ts** | `cn(...args)` → `filter(Boolean).join(' ')`. Simple className joiner (no `clsx`/`tailwind-merge`). |

### 2.4 Contexts

| Context | Purpose |
|---------|---------|
| **AuthContext** | JWT auth management. Login, register (consumer via mediator code, ops via admin/agency code, brand via brand code). Stores tokens in localStorage (`mobo_tokens_v1`). Session restore on mount. Realtime user sync (wallet balance, approval status). `onAuthExpired` listener for force-logout. Profile updates via `updateUser`. |
| **CartContext** | Shopping cart state with localStorage persistence. Max 10 quantity per item, add/remove/clear operations. Badge-ready `totalItems` computed value. |
| **ChatContext** | Per-user chat message storage in sessionStorage. Scoped by user ID. Max 200 messages with FIFO eviction. Validates message integrity on load to prevent corrupt data crashes. |
| **NotificationContext** | Manages server-fetched inbox + local notifications. Realtime refresh on `orders.changed`/`users.changed`/`wallets.changed`/`tickets.changed` events. 30s polling fallback when SSE disconnected. Dismissed IDs tracked in localStorage (pruned at 500). `unreadCount`, `markAllRead()`, `removeNotification()`, `addLocalNotification()`. |
| **ToastContext** | Ephemeral toast notifications — 4 types (success/error/info/warning), auto-dismiss (configurable duration), max 4 visible, renders fixed bottom-right portal with stacking. |

### 2.5 Hooks

| Hook | Purpose |
|------|---------|
| **useRealtimeConnection** | Tracks SSE connection health. Listens to realtime events and marks `lastPing` timestamp. Every 10s, re-evaluates `connected` boolean based on 45s staleness threshold. Used by `RealtimeStatusBadge`. |

### 2.6 Utils

| Utility | Purpose |
|---------|---------|
| **apiBaseUrl.ts** | Resolves API base URL from multiple sources: `globalThis.__MOBO_API_BASE__`, `NEXT_PUBLIC_API_URL`, `VITE_API_URL`, same-origin proxy, localhost:3001 fallback. Also exports `getApiBaseAbsolute()` for image proxy / CSV endpoints. |
| **csvHelpers.ts** | CSV export utilities: `escapeCSV()` (RFC 4180), `sanitizeCSVInjection()` (strips `=+-@\t\r` formula prefixes), `downloadCSV()` (UTF-8 BOM Blob download). |
| **errors.ts** | `formatErrorMessage(err, fallback)` — extracts `.message` from error objects, appends `(Ref: requestId)` if available. |
| **exportToSheets.ts** | Google Sheets export via OAuth popup. Caches connection status for 5 minutes. Flow: check connection → popup if needed → `api.sheets.exportReport()` → open resulting spreadsheet URL. Fallback to CSV on failure. |
| **formatCurrency.ts** | `formatINR(n)` / `formatINRCompact(n)` — `Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' })`. Compact uses `notation: 'compact'`. |
| **imageHelpers.ts** | `urlToBase64(url)` — fetches image via fetch(), converts to data URI via FileReader. Includes same-origin security check (skips if cross-origin). |
| **mobiles.ts** | `normalizeMobileTo10Digits(raw)` — strips `+91`, `0091`, country code, leading `0`, non-digits. Validates 10-digit result. `normalizeMobileForStorage(raw)` — returns `+91` prefixed format. |
| **mojibake.ts** | Fixes UTF-8 content decoded as Windows-1252. Contains byte-pair mapping table for common corruption patterns (e.g., `â€"` → `–`). `fixMojibakeDeep()` recursively fixes objects/arrays. |
| **orderHelpers.ts** | `getPrimaryOrderId(order)` — returns `externalOrderId` if present, else `id`. |

### 2.7 App Shells

| File | Purpose |
|------|---------|
| **ConsumerApp.tsx** | Most complex shell. Wraps in Toast → Cart → Chat → Notification providers. Shows auth screen if not logged in, PortalGuard if wrong role, "Verification Pending" card if `isVerifiedByMediator === false`. Tab navigation: Home, Explore, Orders, Profile via MobileTabBar. |
| **MediatorApp.tsx** | Toast + Notification providers. Auth guard for `mediator` role. Renders MediatorDashboard. |
| **AgencyApp.tsx** | Toast provider. Auth guard for `agency` role. Renders AgencyDashboard. |
| **BrandApp.tsx** | Toast provider. Auth guard for `brand` role. Renders BrandDashboard. |

### 2.8 Pages

| Page | Lines | Purpose |
|------|-------|---------|
| **AdminPortal.tsx** | 2148 | Full admin dashboard. Users, orders, inventory, invites, tickets, stats, charts (Recharts). Auth via admin ID + passkey. Views: dashboard, users, orders, inventory, invites, tickets, config. |
| **AgencyDashboard.tsx** | 3679 | Agency dashboard. Views: dashboard, team (mediators), inventory (campaigns), finance, payouts, brands, profile. Sub-components: AgencyProfile, FinanceView, BrandsView, PayoutsView, DashboardView, InventoryView, TeamView. |
| **BrandDashboard.tsx** | 2724 | Brand dashboard. Views: dashboard, orders, campaigns, profile. Agency payout modal. Sheets export. Sub-components: BrandProfileView, DashboardView, OrdersView, CampaignsView. |
| **MediatorDashboard.tsx** | 2791 | Mediator dashboard. Views: inbox (orders/users/tickets), market (campaigns/deals), squad (buyers), profile. LedgerModal for buyer payment tracking. AI proof analysis. Sub-components: InboxView, MarketView, SquadView, MediatorProfileView, LedgerModal. |
| **Orders.tsx** | 2130 | Buyer orders page. New order creation with product selection, screenshot upload, AI order extraction (OCR). Proof upload (order/payment/rating/review/returnWindow). Status tracking. Support tickets. Sheets export. |
| **Auth.tsx** | 262 | Buyer auth — splash → login/register. Password validation (8+ chars, upper/lower/number/special). Mobile normalization. Mediator code required for registration. |
| **AgencyAuth.tsx** | 280 | Agency auth — splash (split layout) → login/register with admin code. |
| **BrandAuth.tsx** | 281 | Brand auth — splash (split layout) → login/register with brand code. |
| **MediatorAuth.tsx** | 301 | Mediator auth — splash → login/register with agency code. Handles pending-approval state. |
| **Explore.tsx** | 200 | Product discovery. Search + category filter. Realtime inventory sync via SSE. |
| **Profile.tsx** | 360 | Buyer profile — avatar/QR upload, name/UPI editing, wallet stats, order history, logout. |
| **Home.tsx** | 16 | Thin wrapper — renders Chatbot with `onVoiceNavigate` prop. |

---

## 3. Bugs, Missing Error Handling & Edge Cases

### 3.1 Critical Bugs

| # | File | Issue |
|---|------|-------|
| 1 | **api.ts** | `refreshTokens()` has a deduplication promise (`refreshPromise`), but if the refresh request itself throws a network error (not a 401), the `refreshPromise` is never cleared. Subsequent calls will await the rejected promise indefinitely. The `finally` block only clears on success or explicit failure. |
| 2 | **realtime.ts** | `RealtimeClient` calls `abort()` on the AbortController in `stop()`, but if `subscribe()` is called again immediately after `stop()`, there's a race condition where the old `fetch` response hasn't fully closed yet and the new connection reuses the same URL, potentially getting stale data from HTTP caching. No `Cache-Control: no-cache` header is set. |
| 3 | **AuthContext.tsx** | `restoreSession()` reads tokens from localStorage and calls the profile endpoint, but if the token has expired and the refresh also fails (e.g., refresh token revoked server-side), the user sees a brief flash of the loading state before being logged out. There's no explicit `isRestoring` loading state exposed to app shells. |
| 4 | **CartContext.tsx** | The cart persists to localStorage but is NOT scoped to a user ID. If user A logs out and user B logs in on the same device, user B sees user A's cart items. |
| 5 | **ConsumerApp.tsx** | Uses `setActiveTab(id as any)` type cast — this bypasses TypeScript safety on tab IDs. |
| 6 | **Explore.tsx** | The category filter uses hardcoded keywords (`'shirt'`, `'shoe'`, `'perfume'`). If product titles don't contain these exact English words, items won't appear in the correct category. The category list (`['All', 'Electronics', 'Fashion', 'Beauty', 'Home']`) is also hardcoded — not derived from actual product data. |
| 7 | **All Dashboard files** | AgencyDashboard (3679 lines), BrandDashboard (2724 lines), MediatorDashboard (2791 lines), AdminPortal (2148 lines), Orders (2130 lines) are **massively oversized single-file components**. This is the #1 structural issue — see Section 5. |

### 3.2 Missing Error Handling

| # | File | Issue |
|---|------|-------|
| 1 | **api.ts** `compressImage()` | Uses `canvas.toBlob()` callback but doesn't handle the case where `blob` is `null` (happens when the browser can't encode the image format). Silently resolves with `null`. |
| 2 | **realtime.ts** | If `response.body` is `null` (e.g., server returns 204), `getReader()` will throw. No null check before `response.body!.getReader()`. |
| 3 | **Chatbot.tsx** | `SpeechRecognition` API errors are `console.error`'d but not surfaced to the user. If the mic permission is denied, the user gets no feedback. |
| 4 | **Chatbot.tsx** | Uses `navigator.clipboard.writeText()` without a try-catch. This throws in insecure contexts (HTTP) or when the document is not focused. |
| 5 | **exportToSheets.ts** | The OAuth popup flow uses `window.open()`. If popups are blocked by the browser, `window.open()` returns `null`, but the code enters a polling loop checking `popup.closed` — this will throw on `null.closed`. |
| 6 | **imageHelpers.ts** | `urlToBase64()` uses `fetch()` but has no timeout. A slow image server will hang the caller indefinitely. |
| 7 | **mockBackend.ts** | Many methods do `JSON.parse(localStorage.getItem(...))` without try-catch. If localStorage data is corrupted (manual tampering, storage quota), the entire mock backend crashes. |
| 8 | **Profile.tsx** | `FileReader.onerror` is handled, but `FileReader.onabort` is not. If reading is aborted (e.g., component unmounts during read), the promise hangs. |
| 9 | **All auth screens** | After successful login, `isLoading` is never set back to `false` (relies on component unmounting during navigation). If login succeeds but the role check fails and throws, the button stays in the loading state. |
| 10 | **NotificationContext.tsx** | `fetchNotifications()` silently catches errors with `console.error`. If the API is down, the user has no idea notifications aren't loading — no retry mechanism beyond the 30s poll. |

### 3.3 Edge Cases

| # | File | Issue |
|---|------|-------|
| 1 | **api.ts** | `readTokens()` catches JSON.parse errors and returns `null`, but doesn't clear the corrupted localStorage entry. The next request will re-attempt parsing the same bad data. |
| 2 | **realtime.ts** | The idle reconnect timer (70s) doesn't account for the browser tab being in the background. `setTimeout` in background tabs can be throttled to 1+ minutes, meaning the idle threshold may fire incorrectly. |
| 3 | **CartContext.tsx** | Max 10 quantity per item, but no limit on total items in cart. A user could theoretically add thousands of distinct products. |
| 4 | **ChatContext.tsx** | FIFO eviction at 200 messages, but the count isn't shown to the user. Old messages silently disappear, which may confuse users looking for conversation history. |
| 5 | **mobiles.ts** | Only handles Indian mobile numbers (+91). International users will have their numbers incorrectly normalized (e.g., `+1234567890` becomes `1234567890` and fails the 10-digit check). |
| 6 | **mojibake.ts** | The byte-pair mapping is hardcoded for specific UTF-8→Win-1252 corruption patterns. If the backend introduces new corrupt patterns (e.g., from a different charset), they won't be fixed. |
| 7 | **apiBaseUrl.ts** | Same-origin proxy detection (`window.location.origin + '/api'`) doesn't verify the proxy actually exists. If deployed to a domain without `/api` proxy, all requests will 404. |
| 8 | **formatCurrency.ts** | Uses `'en-IN'` locale which is correct for INR, but if the platform expands to other currencies, this util needs a complete rewrite. No currency parameter. |
| 9 | **cn.ts** | Simple string join — doesn't handle conditional classes or class deduplication. `cn('p-4', 'p-8')` produces `"p-4 p-8"`, where Tailwind will apply the last one by CSS specificity (not reliably). |
| 10 | **ZoomableImage.tsx** | No keyboard navigation support. The overlay can only be closed by clicking — `Escape` key doesn't close it. No focus trap. |
| 11 | **ErrorBoundary.tsx** | `componentDidCatch` logs to console only. No error reporting to a monitoring service (Sentry, etc.). |
| 12 | **useRealtimeConnection.ts** | 10-second re-render interval is wasteful. The hook sets up `setInterval` that forces a re-render every 10s even when the connection state hasn't changed. |
| 13 | **Orders.tsx** | `MAX_PROOF_SIZE_BYTES = 50 * 1024 * 1024` (50MB) is excessive for proof screenshots. This allows uploading very large files that could strain the backend. |

---

## 4. Improvements Needed

### 4.1 Architecture — File Size Crisis

The most pressing issue is the **god-file problem**. Five files exceed 2000 lines each:

| File | Lines | Recommendation |
|------|-------|----------------|
| AgencyDashboard.tsx | 3679 | Split into ~8 files: AgencyDashboard (shell), AgencyProfile, FinanceView, BrandsView, PayoutsView, DashboardOverview, InventoryView, TeamView |
| MediatorDashboard.tsx | 2791 | Split into ~6 files: MediatorDashboard (shell), InboxView, MarketView, SquadView, MediatorProfileView, LedgerModal |
| BrandDashboard.tsx | 2724 | Split into ~5 files: BrandDashboard (shell), BrandProfileView, DashboardOverview, OrdersView, CampaignsView |
| AdminPortal.tsx | 2148 | Split into ~7 files: AdminPortal (shell), AdminAuth, UsersView, OrdersView, InventoryView, InvitesView, TicketsView |
| Orders.tsx | 2130 | Split into ~4 files: Orders (shell), NewOrderModal, ProofUpload, OrderDetail |

Each already has clearly delineated sub-components — they're just all in one file.

### 4.2 TypeScript Strictness

- `tsconfig.json` has `strict: false`. Enabling strict mode would catch numerous potential null/undefined bugs.
- Pervasive use of `any` type in props: `({ user }: any)`, `({ stats, allOrders }: any)` — every sub-component in the dashboards uses `any` for props.
- No shared prop interfaces for dashboard sub-components.

### 4.3 Service Layer

| Issue | Recommendation |
|-------|----------------|
| `api.ts` has 70+ methods in a single file | Group into separate files per domain: `api/auth.ts`, `api/orders.ts`, `api/products.ts`, etc. |
| No request cancellation | Add `AbortController` support to API methods for component unmount cleanup |
| No request deduplication | Concurrent identical GET requests (e.g., two components fetching `/api/products`) fire separate network calls |
| `compressImage()` lives in api.ts | Move to `utils/imageCompression.ts` — it's a utility, not an API call |
| Hardcoded 60s timeout | Make timeout configurable per request (some uploads may need longer) |
| Token refresh retry | If refresh fails, it immediately logs out. Should attempt at least one retry. |

### 4.4 Realtime Layer

| Issue | Recommendation |
|-------|----------------|
| No reconnection limit | Backoff goes 1s→12s but retries infinitely. After N failures, should show a "connection failed" UI and stop retrying. |
| No heartbeat/ping | Relies on data freshness (70s idle) to detect stale connections. A proper ping/pong protocol would catch silent disconnects faster. |
| `useRealtimeConnection` polls every 10s | Use an event-driven approach — subscribe to connection state changes instead of polling with `setInterval`. |
| No message queue for offline | If the connection drops, messages during the gap are lost. Should request a catch-up from the server on reconnect (e.g., `Last-Event-ID`). |

### 4.5 Context Layer

| Issue | Recommendation |
|-------|----------------|
| CartContext not scoped to user | Prefix cart localStorage key with user ID |
| No context composition pattern | Each app shell manually wraps with 3-5 providers — create a `<SharedProviders>` composite |
| NotificationContext has dual fetch strategy | Polling + SSE — the polling fallback should be clearly gated behind a `connected` check, not just a timer |
| AuthContext `restoreSession` doesn't expose loading state | Add `isInitializing` state so app shells can show a splash screen during session restore |
| ToastContext renders its own portal | Consider extracting the render target to avoid React portal issues with SSR (Next.js) |

### 4.6 Component Quality

| Issue | Recommendation |
|-------|----------------|
| `cn()` is too simplistic | Replace with `clsx` + `tailwind-merge` for proper class deduplication. Current implementation breaks with conflicting Tailwind classes. |
| No form library | All forms use raw `useState`. Consider `react-hook-form` or at least a shared `useForm` hook for consistent validation patterns. |
| Password validation duplicated 4x | Auth.tsx, AgencyAuth.tsx, BrandAuth.tsx, MediatorAuth.tsx all have identical password rules. Extract to `utils/validation.ts`. |
| Explore.tsx category filter is brittle | Derive categories from product data, or use server-provided categories. The keyword-matching approach (`title.includes('shirt')`) will break with non-English or differently named products. |
| `ZoomableImage.tsx` lacks accessibility | Add `Escape` key handler, focus trap, `role="dialog"`, `aria-label`. |
| Error messages show raw server errors | Wrap all user-facing error messages through a sanitization layer. |

### 4.7 Performance

| Issue | Recommendation |
|-------|----------------|
| Dashboard pages re-fetch ALL data on any SSE event | Implement granular event handling — `orders.changed` should only refresh orders, not users + campaigns + wallets |
| No pagination on any list | Product list, order list, user list, transaction list — all loaded fully. Will degrade with data growth. |
| No `React.memo` or `useMemo` on expensive renders | Dashboard sub-components re-render on every parent state change |
| Chatbot.tsx (855 lines) is always mounted on Home tab | Lazy-load the Chatbot component |
| Large base64 images stored in state | Avatar/QR uploads are stored as full base64 strings in React state and localStorage. Consider using object URLs or server-side upload. |

---

## 5. Missing Shared Functionality

### 5.1 Should Exist But Doesn't

| Missing Utility/Component | Used Where | Recommendation |
|---------------------------|------------|----------------|
| **Shared password validator** | Auth.tsx, AgencyAuth.tsx, BrandAuth.tsx, MediatorAuth.tsx | Create `utils/validation.ts` with `validatePassword()`, `validateMobile()`, `validateRequired()` |
| **Shared `<ConfirmDialog>`** | Every dashboard has inline confirm patterns | Create `components/ConfirmDialog.tsx` — modal with title, message, confirm/cancel |
| **`<DataTable>` component** | Admin, Agency, Brand, Mediator dashboards all build tables manually | Sortable, filterable, paginated table component |
| **`<Modal>` / `<Sheet>` component** | Every dashboard builds its own modal/drawer patterns | Reusable modal with backdrop, close button, animation, focus trap |
| **Shared `<SearchInput>`** | Explore, Orders, every dashboard view | Search input with debounce, clear button, loading indicator |
| **`useDebounce` hook** | Search in Explore, Orders, dashboards | `useDebounce(value, delay)` for search debouncing |
| **`usePagination` hook** | No pagination exists anywhere | `usePagination(data, pageSize)` returning `{ page, totalPages, pageData, next, prev }` |
| **`<Tabs>` component** | All dashboards manually implement tab switching | Reusable tab bar with content switching |
| **`<StatusBadge>` component** | Order status, payment status, user status rendered differently everywhere | Standardized status visualization |
| **`useAsyncAction` hook** | Every form has `isLoading` + try/catch + error state pattern | `useAsyncAction(fn)` returning `{ execute, isLoading, error }` |
| **Shared auth form** | 4 nearly identical auth screens | Abstract into `<AuthForm>` with config for role-specific fields |
| **`<ImageUpload>` component** | Profile avatar/QR, order proof screenshots, all ad-hoc | Unified image upload with preview, compression, size validation |
| **Error reporting integration** | Only `console.error` throughout | Integrate Sentry or similar; wrap `ErrorBoundary` to report |
| **Feature flags / env config** | Hardcoded behavior everywhere | Create `config.ts` with environment-driven feature toggles |
| **Date formatting utility** | Date formatting scattered (`.toLocaleDateString()`, `.toLocaleTimeString()`, relative time) | Create `utils/dates.ts` centralizing date/time formatting |
| **Loading skeleton components** | Loading states show spinners only | Skeleton placeholders for cards, tables, lists |
| **`<Stat>` or `<MetricCard>`** | Each dashboard defines its own `StatCard` component | One shared version |

### 5.2 Cross-Cutting Concerns Not Addressed

1. **No i18n / localization** — All strings hardcoded in English. INR-only currency handling.
2. **No accessibility audit** — Many interactive elements lack ARIA labels, keyboard navigation, or focus management.
3. **No shared theme system** — Colors/spacing/radii defined ad-hoc in each component's Tailwind classes. No design tokens.
4. **No shared animation constants** — Each component defines its own animation classes (`animate-enter`, `animate-ping`).
5. **No offline-first strategy** — PWA detection exists in `api.ts` but no service worker, no optimistic updates, no cached data layer.
6. **No shared test utilities** — No test helpers, no mock providers, no test fixtures in shared.

---

## 6. Summary of Priority Actions

### P0 — Critical (do first)
1. **Fix CartContext user scoping** — Cart leaks between users on shared devices
2. **Fix `exportToSheets.ts` popup null check** — Will crash if popups blocked
3. **Fix `realtime.ts` null body check** — Will throw on unexpected server responses

### P1 — High (structural debt)
4. **Split the 5 god-files** into ~30 smaller, focused components (see Section 4.1)
5. **Extract shared password validation** (duplicated 4 times)
6. **Create `<ConfirmDialog>`, `<Modal>`, `<DataTable>`** shared components
7. **Enable `strict: true`** in tsconfig and fix resulting type errors
8. **Replace `any` props** with proper interfaces in all dashboard sub-components

### P2 — Medium (quality)
9. **Add request cancellation** (AbortController) to API methods
10. **Add pagination** to all list views
11. **Replace `cn()` with `clsx` + `tailwind-merge`**
12. **Add keyboard/a11y support** to ZoomableImage, modals, etc.
13. **Create `useAsyncAction` and `useDebounce` hooks**
14. **Implement granular SSE event handling** instead of full data refresh

### P3 — Nice to have
15. **Add i18n foundation** for future localization
16. **Add error monitoring** (Sentry integration)
17. **Add loading skeletons** to replace plain spinners
18. **Create shared theme/design tokens**
