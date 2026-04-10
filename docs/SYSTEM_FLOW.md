# MOBO — Complete System Flow

> **What is MOBO?**
> MOBO is a multi-stakeholder commerce ecosystem connecting **Brands**, **Agencies**, **Mediators**, and **Buyers** in a structured deal-driven marketplace. Brands list products via campaigns, Agencies manage regional distribution through Mediator networks, Mediators connect Buyers to deals, and Buyers purchase through their assigned Mediator. An Admin panel governs the entire platform.

---

## Table of Contents

1. [Ecosystem Overview](#ecosystem-overview)
2. [Stakeholder Roles](#stakeholder-roles)
3. [Platform Architecture](#platform-architecture)
4. [End-to-End Flows](#end-to-end-flows)
   - [A. Onboarding Flow](#a-onboarding-flow)
   - [B. Campaign & Deal Pipeline](#b-campaign--deal-pipeline)
   - [C. Buyer Purchase Lifecycle](#c-buyer-purchase-lifecycle)
   - [D. Order Verification & Settlement](#d-order-verification--settlement)
   - [E. Payout & Money Flow](#e-payout--money-flow)
   - [F. Suspension & Cascade](#f-suspension--cascade)
   - [G. Support Ticket Lifecycle](#g-support-ticket-lifecycle)
   - [H. Real-time Events](#h-real-time-events)
5. [Data Backtracking & Audit Trail](#data-backtracking--audit-trail)
6. [AI Integration Points](#ai-integration-points)
7. [Security Model](#security-model)
8. [Technology Stack](#technology-stack)

---

## Ecosystem Overview

```text
┌─────────────┐     ┌─────────────┐     ┌──────────────┐     ┌──────────────┐
│   Brand     │────▶│   Agency    │────▶│   Mediator   │────▶│    Buyer     │
│  (Supply)   │     │ (Distribute)│     │   (Connect)  │     │  (Purchase)  │
└─────────────┘     └─────────────┘     └──────────────┘     └──────────────┘
       │                   │                    │                     │
       └───────────────────┴────────────────────┴─────────────────────┘
                                    │
                           ┌───────────────┐
                           │     Admin     │
                           │  (Govern all) │
                           └───────────────┘
```

**The value chain:**

1. **Brand** creates products & campaigns with funded budgets
2. **Agency** receives campaigns, creates deals with margins, assigns to mediators
3. **Mediator** shares deals with their buyer network via unique referral codes
4. **Buyer** discovers deals, places orders through their mediator
5. **Admin** oversees the entire platform — users, orders, finances, disputes

---

## Stakeholder Roles

| Role         | Portal                 | Purpose                                             | Auth Method         |
| ------------ | ---------------------- | --------------------------------------------------- | ------------------- |
| **Brand**    | brand-web (`:3004`)    | Manage products, campaigns, payouts, inventory      | Mobile + Password   |
| **Agency**   | agency-web (`:3003`)   | Run campaigns, create deals, manage mediator squads | Mobile + Password   |
| **Mediator** | mediator-app (`:3002`) | Share deals, manage buyers, track earnings (PWA)    | Mobile + Password   |
| **Buyer**    | buyer-app (`:3001`)    | Browse deals, place orders, track shipments (PWA)   | Mobile + Password   |
| **Admin**    | admin-web (`:3005`)    | Platform governance, user management, financials    | Username + Password |
| **Ops**      | admin-web (`:3005`)    | Limited admin operations, support                   | Username + Password |

---

## Platform Architecture

```text
┌──────────────────────────────────────────────────────────────┐
│                     Client Layer                              │
│  ┌────────┐ ┌──────────┐ ┌────────┐ ┌───────┐ ┌───────┐    │
│  │ Buyer  │ │ Mediator │ │ Agency │ │ Brand │ │ Admin │    │
│  │  PWA   │ │   PWA    │ │  Web   │ │  Web  │ │  Web  │    │
│  │Next.js │ │ Next.js  │ │Next.js │ │Next.js│ │Next.js│    │
│  └───┬────┘ └────┬─────┘ └───┬────┘ └───┬───┘ └───┬───┘    │
│      └───────────┴───────────┴───────────┴─────────┘         │
│                          │ HTTPS /api/*                       │
└──────────────────────────┼───────────────────────────────────┘
                           ▼
┌──────────────────────────────────────────────────────────────┐
│                    Backend API (Express 5)                     │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐    │
│  │   Auth   │ │  Orders  │ │  Wallet  │ │  AI Service  │    │
│  │ JWT+RBAC │ │ Workflow │ │  Ledger  │ │ Gemini OCR   │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘    │
│  ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐    │
│  │ Products │ │ Realtime │ │ Tickets  │ │  Push Notif  │    │
│  │ Campaigns│ │   SSE    │ │ Support  │ │  Web Push    │    │
│  └──────────┘ └──────────┘ └──────────┘ └──────────────┘    │
│                          │                                    │
│  ┌─────────────────────────────────────────────────────┐     │
│  │  Prisma ORM  →  PostgreSQL  (Schemas: production /  │     │
│  │                               test / ci)             │     │
│  └─────────────────────────────────────────────────────┘     │
└──────────────────────────────────────────────────────────────┘
```

---

## End-to-End Flows

### A. Onboarding Flow

```text
1. User opens portal → Auth page (Mobile + Password or Username + Password)
2. First-time users register with name, mobile, role
3. Backend creates User record + Wallet (balance: 0)
4. Role-specific setup:
   - Brand: profile with business details
   - Agency: profile, assigned brand connections
   - Mediator: gets unique mediatorCode, joins agency squad
   - Buyer: enters mediatorCode to link with mediator
5. Admin approves mediator registrations (PENDING_APPROVAL → active)
6. JWT access + refresh tokens issued → stored in localStorage
```

**Mediator Code System:**

- Every mediator gets a unique alphanumeric `mediatorCode`
- Buyers must enter this code during registration to link with their mediator
- This creates the Buyer → Mediator → Agency hierarchy
- All buyer orders are attributed to their mediator's network

### B. Campaign & Deal Pipeline

```text
Brand                    Agency                   Mediator
  │                        │                         │
  ├─ Create Product        │                         │
  ├─ Create Campaign ──────▶                         │
  │  (product, budget,     ├─ View Campaign          │
  │   price, qty)          ├─ Create Deal ───────────▶
  │                        │  (margin, slots,        ├─ View Deal
  │                        │   mediator assignments) ├─ Share with Buyers
  │                        │                         │  (via mediatorCode)
  │                        │                         │
  ├─ Fund Campaign ────────▶                         │
  │  (Wallet debit)        ├─ Slot allocation        │
  │                        ├─ Assign to mediators    │
  │                        │                         │
```

**Key rules:**

- Campaign has a funded budget from Brand's wallet
- Agency sets margins on deals (their commission)
- Deals have limited slots per mediator
- One active deal per product per agency at a time
- Campaigns can be paused/resumed by Brand or Admin
- **Mediators only see campaigns where they have explicit slot assignments** — agency-level access alone is not sufficient for visibility
- Commission cannot exceed the payout amount when publishing a deal

### C. Buyer Purchase Lifecycle

```text
Buyer                     Backend                   Mediator/Agency
  │                         │                         │
  ├─ Browse Deals           │                         │
  │  (Explore page)         │                         │
  ├─ Select Deal ──────────▶│                         │
  │                         ├─ Check: 1 active order  │
  │                         │  per deal per buyer     │
  ├─ Place Order ──────────▶│                         │
  │  (qty, address)         ├─ Create Order record    │
  │                         ├─ Set status: PLACED     │
  │                         ├─ SSE → Mediator ────────▶ Real-time notification
  │                         │                         │
  ├─ Track Order            │                         │
  │  (Orders page)          │                         │
  ├─ Upload Proof ─────────▶│                         │
  │  (screenshot/receipt)   ├─ AI Extract + Verify ───▶ Auto or Mediator review
  │                         │  (amount, date, UTR)    │
  │                         │                         │
```

**Order Status State Machine:**

```text
PLACED → UNDER_REVIEW → APPROVED → Pending_Cooling → SETTLED → (complete)
  │         │              │            │                 │
  ├→ CANCELLED    ├→ REJECTED   │            │                 ├→ RETURNED
  ├→ FROZEN       └→ DISPUTED   │            └→ auto-settle    ├→ DISPUTED
  │                              └→ VERIFIED                    └→ REFUNDED
```

### D. Order Verification & Settlement

```text
Buyer                  Backend AI              Mediator              Agency/Admin
  │                       │                       │                      │
  ├─ Upload proof ───────▶│                       │                      │
  │  (screenshot)         ├─ OCR via Gemini       │                      │
  │                       ├─ Extract: amount,     │                      │
  │                       │  date, UTR/txnId      │                      │
  │                       ├─ Confidence score     │                      │
  │                       │                       │                      │
  │                       ├─ Score ≥ threshold? ──┤                      │
  │                       │  YES: auto-verify ────┼──── (skip mediator) ─▶│
  │                       │  NO:  SSE notify ─────▶                      │
  │                       │                       ├─ Review proof        │
  │                       │                       ├─ Verify/Reject ─────▶│
  │                       │                       │                      │
  │                       │                       │                      ├─ Settlement
  │                       │                       │                      │  (if verified)
  │                       │                       │                      ├─ Wallet credits
  │                       │                       │                      │
```

**AI Auto-Verification (Bulk Path):**

When ALL required proofs are uploaded and each has AI confidence ≥ `AI_BULK_VERIFY_THRESHOLD` (default 70%):

1. System bulk-verifies ALL unverified steps at once
2. Order moves directly to **cooling period** (`Pending_Cooling` status)
3. No mediator manual review required
4. After cooling period (`COOLING_PERIOD_DAYS`, default 14), settlement becomes eligible

This path triggers automatically after each proof upload via `autoVerifyStep()` → `attemptBulkAutoVerify()` → `finalizeApprovalIfReady()`.

**Individual Step Auto-Verification:**

If a single proof's AI confidence ≥ `AI_AUTO_VERIFY_THRESHOLD` (default 80%), that individual step is auto-verified immediately. The system then checks if all steps are now verified to trigger the bulk approval.

**High-Confidence Fast Path:**

If a single proof's AI confidence ≥ `AI_HIGH_CONFIDENCE_THRESHOLD` (default 85%), it is auto-verified immediately regardless of other thresholds. This allows clearly genuine proofs to bypass review faster while maintaining safety. The tiered confidence system:

| Threshold                        | Default | Effect                                                     |
| -------------------------------- | ------- | ---------------------------------------------------------- |
| `AI_BULK_VERIFY_THRESHOLD`       | 70%     | Bulk auto-verify all proofs when ALL meet this minimum     |
| `AI_AUTO_VERIFY_THRESHOLD`       | 80%     | Individual proof auto-verified without mediator            |
| `AI_HIGH_CONFIDENCE_THRESHOLD`   | 85%     | Fast-path auto-verify for high-confidence proofs           |
| `AI_REVIEW_LINK_CONFIDENCE`      | 95%     | Confidence assigned to validated marketplace review links  |

**AI Extraction:**

- Buyer uploads payment screenshot
- Gemini Vision API extracts transaction details (amount, date, reference number)
- Results cached for 15 minutes (prevents duplicate API calls)
- Fields are auto-filled; if AI confidence is high enough, mediator review is skipped
- Amount guard: extracted amount must match order total (±tolerance)

### E. Payout & Money Flow

```text
┌──────────┐    Fund Campaign    ┌──────────┐
│  Brand   │────────────────────▶│  Brand   │
│ (funds)  │                     │  Wallet  │
└──────────┘                     └──────────┘
                                       │
                            Settlement │ (on verified order)
                                       ▼
                                 ┌──────────┐    Agency Payout    ┌──────────┐
                                 │  Agency  │◀───────────────────│  Brand   │
                                 │  Wallet  │    (periodic)       │  Wallet  │
                                 └──────────┘                     └──────────┘
                                       │
                           Commission  │ (mediator's share)
                                       ▼
                                 ┌──────────┐
                                 │ Mediator │
                                 │  Wallet  │
                                 └──────────┘
                                       │
                           Withdrawal  │ (request → admin approve)
                                       ▼
                                 ┌──────────┐
                                 │   Bank   │
                                 │ Transfer │
                                 └──────────┘
```

**Money Safety:**

- Every transaction has an `idempotencyKey` (prevents double-spend)
- Wallet balance is computed from ledger entries (credits - debits)
- Insufficient balance checks before every debit
- Transaction types: `CREDIT`, `DEBIT`, `FREEZE`, `RELEASE`
- All wallet operations are audited with full metadata

### F. Suspension & Cascade

```text
Admin suspends Agency
  └─▶ All Agency's Mediators → suspended
       └─▶ All Mediator's Buyers → access blocked
            └─▶ Active orders → frozen

Admin suspends Mediator
  └─▶ All Mediator's Buyers → access blocked
       └─▶ Active orders → frozen

Admin suspends Buyer
  └─▶ Active orders → frozen
```

**Reactivation:** Reversing a suspension cascades reactivation down the hierarchy.

### G. Support Ticket Lifecycle

```text
Buyer creates ticket          ──▶  targetRole = mediator
  │                                     │
  │                         Mediator manages ticket
  │                         ├── Resolve ✅  (closes ticket)
  │                         ├── Reject  ❌  (closes ticket)
  │                         └── Escalate ↑  (→ targetRole = agency)
  │                                     │
  │                         Agency manages ticket
  │                         ├── Resolve ✅
  │                         ├── Reject  ❌
  │                         └── Escalate ↑  (→ targetRole = brand)
  │                                     │
  │                         Brand manages ticket
  │                         ├── Resolve ✅
  │                         ├── Reject  ❌
  │                         └── Escalate ↑  (→ targetRole = admin)
  │                                     │
  │                         Admin manages ticket (terminal)
  │                         ├── Resolve ✅
  │                         └── Reject  ❌
```

**Cascade Routing Rules:**

| Ticket Creator | Initial Target | Escalation Path                    |
| -------------- | -------------- | ---------------------------------- |
| **Buyer**      | Mediator       | Mediator → Agency → Brand → Admin  |
| **Mediator**   | Agency         | Agency → Brand → Admin             |
| **Agency**     | Brand          | Brand → Admin                      |
| **Brand**      | Admin          | (terminal — cannot escalate)       |

**Role-Level Gating (v2):**

- Each role has a numeric level: Buyer(0) → Mediator(1) → Agency(2) → Brand(3) → Admin(4)
- Only users at or above the ticket's `targetRole` level can resolve/reject
- Ticket owners can always resolve/reject their own tickets regardless of level
- Admin/Ops can manage any ticket (privileged bypass)
- Escalation bumps `targetRole` up one level (mediator→agency→brand→admin)

**Network Scoping:**

- Mediators only see/manage tickets from buyers in their network (via `parentCode` or order linkage)
- Agencies only see/manage tickets from mediators in their squad
- Brands only see/manage tickets from connected agencies
- Admin/Ops can see and manage all tickets

**Ticket statuses:** `Open` → `Resolved` / `Rejected` (reopenable)

**Comments:** Thread-style comments on any ticket. Both the creator and the handler can comment. Real-time push notifications on new comments and status changes.

### H. Real-time Events

The platform uses **Server-Sent Events (SSE)** for real-time updates:

| Event            | Audience         | Trigger                 |
| ---------------- | ---------------- | ----------------------- |
| `order:created`  | Mediator, Agency | Buyer places order      |
| `order:updated`  | Buyer, Mediator  | Status change           |
| `order:verified` | Agency, Brand    | Mediator verifies proof |
| `ticket:created` | Admin            | Any user creates ticket |
| `ticket:reply`   | Ticket creator   | Admin responds          |
| `wallet:updated` | Wallet owner     | Credit/debit            |
| `user:suspended` | Affected user    | Admin action            |
| `deal:published` | Mediators        | Agency publishes deal   |

**SSE Health:** 45-second stale detection with automatic reconnection. Visual indicator shows connection status in real-time.

---

## Data Backtracking & Audit Trail

Every significant action in the system is traceable:

| Data Point                           | How to Backtrack                                                                                 |
| ------------------------------------ | ------------------------------------------------------------------------------------------------ |
| **Who created an order**             | `Order.buyerId` → `User` record with mobile, name, mediatorCode                                  |
| **Which mediator handled it**        | `Order.mediatorId` → links to `User` with `mediatorCode`                                         |
| **Which agency is responsible**      | Mediator → `Agency` via squad membership                                                         |
| **Which brand supplied the product** | `Order.dealId` → `Deal.campaignId` → `Campaign.brandId`                                          |
| **Money trail**                      | `Transaction` table: every credit/debit with `idempotencyKey`, `walletId`, `orderId`, timestamps |
| **Who verified the order**           | `Order.verifiedAt`, `Order.verifiedBy` fields                                                    |
| **AI extraction data**               | `Order.extractedData` JSON field (amount, date, UTR from OCR)                                    |
| **User status changes**              | `User.is_deleted` (Boolean) + `Suspension` table for suspension tracking                         |
| **Login history**                    | Auth logs via Winston structured logging (domain: auth)                                          |
| **API access**                       | HTTP request logs with userId, role, IP, route, duration                                         |
| **System errors**                    | Error logs with correlationId, stack traces, memory metrics                                      |
| **Security events**                  | Dedicated `security-*.log` files (SIEM-compatible)                                               |

**Audit Log Files (Production):**

```text
logs/
├── combined-YYYY-MM-DD.log     # All events (JSON structured)
├── error-YYYY-MM-DD.log        # Errors only
├── access-YYYY-MM-DD.log       # HTTP + auth events
├── security-YYYY-MM-DD.log     # Security incidents
└── availability-YYYY-MM-DD.log # System health events
```

---

## AI Integration Points

| Feature                   | Technology            | Purpose                                                              |
| ------------------------- | --------------------- | -------------------------------------------------------------------- |
| **Payment Proof OCR**     | Google Gemini Vision  | Extract amount, date, UTR from payment screenshots                   |
| **Rating Verification**   | Google Gemini Vision  | Verify reviewer name, product name, star rating from screenshot      |
| **Return Window Check**   | Google Gemini Vision  | Verify return window status from marketplace screenshot              |
| **AI Auto-Verify**        | Backend logic         | Auto-approve proofs at configurable confidence thresholds (70/80/85) |
| **AI Chatbot**            | Google Gemini         | Buyer assistance — product search, order status, FAQ                 |
| **Extraction Cache**      | In-memory (15min TTL) | Prevent duplicate Gemini API calls for same proof                    |
| **Smart Field Lock**      | Frontend logic        | Lock extracted fields to prevent manual override of AI data          |

---

## Security Model

| Layer                  | Implementation                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------ |
| **Authentication**     | JWT access + refresh tokens, bcrypt password hashing                                                   |
| **Authorization**      | Role-based access control (RBAC) on every route                                                        |
| **Zero-trust tokens**  | Role verified from DB on every request (not just JWT claims)                                           |
| **Cascade suspension** | Upstream suspension blocks downstream access                                                           |
| **Rate limiting**      | Per-IP and per-user rate limits; stricter per-user financial rate limit on settlement/payout endpoints |
| **CORS**               | Strict origin whitelist                                                                                |
| **Helmet**             | Security headers (CSP, HSTS, X-Frame-Options)                                                          |
| **Input validation**   | Zod schemas on all request bodies                                                                      |
| **SQL injection**      | Prisma parameterized queries                                                                           |
| **XSS**                | React auto-escaping + CSP headers                                                                      |
| **Sensitive data**     | Redaction engine masks passwords, tokens, emails, mobiles in logs                                      |
| **Idempotency**        | Unique keys on financial transactions (validated: 1-128 chars, alphanumeric)                           |
| **Frozen orders**      | Admin-frozen orders blocked from auto-approval in all verification paths                               |
| **Soft delete**        | Data preservation — `is_deleted` Boolean flag, never hard delete                                       |

---

## Technology Stack

| Component      | Technology                           | Version |
| -------------- | ------------------------------------ | ------- |
| **Runtime**    | Node.js                              | 20+     |
| **Backend**    | Express                              | 5.2     |
| **Frontend**   | Next.js                              | 15.5    |
| **UI**         | React                                | 19      |
| **Styling**    | Tailwind CSS                         | 3.4     |
| **Database**   | PostgreSQL                           | 16      |
| **ORM**        | Prisma                               | 7.4     |
| **Auth**       | JWT (jsonwebtoken)                   | -       |
| **AI**         | Google Gemini (@google/genai)        | -       |
| **Logging**    | Winston + daily-rotate-file          | 3.19    |
| **Validation** | Zod                                  | 4.1     |
| **Testing**    | Vitest + Playwright                  | -       |
| **PWA**        | next-pwa                             | -       |
| **CI/CD**      | GitHub Actions                       | -       |
| **Hosting**    | Vercel (frontend) + Render (backend) | -       |
| **Language**   | TypeScript                           | 5.8     |

---

## Folder Structure

```text
MOBO/
├── apps/                          # Frontend applications
│   ├── buyer-app/                 # Buyer PWA (port 3001)
│   ├── mediator-app/              # Mediator PWA (port 3002)
│   ├── agency-web/                # Agency dashboard (port 3003)
│   ├── brand-web/                 # Brand dashboard (port 3004)
│   └── admin-web/                 # Admin dashboard (port 3005)
├── backend/                       # Express API server
│   ├── config/                    # App config, env, logger
│   ├── controllers/               # Request handlers
│   ├── services/                  # Business logic
│   ├── routes/                    # Route definitions
│   ├── middleware/                 # Auth, errors, security
│   ├── utils/                     # Helpers (money, pagination, etc.)
│   ├── validations/               # Zod schemas
│   ├── prisma/                    # Schema & migrations
│   ├── seeds/                     # Database seeders
│   ├── scripts/                   # Deploy & maintenance scripts
│   └── tests/                     # Vitest test suites
├── shared/                        # Shared frontend code
│   ├── components/                # Reusable React components
│   │   └── ui/                    # Design system primitives
│   ├── pages/                     # Full page components
│   ├── hooks/                     # Custom React hooks
│   ├── services/                  # API client & realtime
│   ├── context/                   # React contexts (Auth, Cart, etc.)
│   ├── utils/                     # Frontend utilities
│   ├── layouts/                   # Shared HTML head/meta
│   ├── fonts/                     # Font configuration
│   └── styles/                    # Global style constants
├── e2e/                           # Playwright E2E tests
├── docs/                          # Project documentation
├── scripts/                       # Dev tooling scripts
└── .github/workflows/             # CI/CD pipeline
```
