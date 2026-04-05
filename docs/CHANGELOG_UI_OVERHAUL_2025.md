# UI/UX Overhaul & Performance Tuning — June 2025

## Summary

Complete brand-color alignment across all 5 MOBO apps, performance optimizations, AI verification threshold tuning, and folder structure cleanup.

---

## Brand Color Migration

### Problem
Pervasive use of Tailwind `indigo-*` classes across all shared components and pages, conflicting with the MOBO design system (mobo.lime/mobo.dark/accent `#CCF381`).

### Color Mapping Applied

| Context | Before (indigo) | After (brand) |
|---------|-----------------|---------------|
| Primary buttons/tabs | `bg-indigo-600` | `bg-zinc-900` |
| AI verification sections | `indigo-*` | `lime-*` (bg-lime-50, border-lime-100, text-lime-600) |
| Focus rings on inputs | `ring-indigo-300` | `ring-lime-300` |
| Focus rings on cards | `ring-indigo-400` | `ring-zinc-400` |
| Brand/reviewer text | `text-indigo-600/500/700` | `text-zinc-600/500/700` |
| Confidence labels | `text-indigo-500` | `text-lime-600` |
| Tab bar active states | `bg-indigo-500/600` | `bg-lime-500 text-zinc-900` |
| Hover states | `hover:bg-indigo-*` | `hover:bg-zinc-*` or `hover:bg-lime-*` |

### Files Modified

#### Shared UI Components
- **Button.tsx** — Added `accent` and `success` variants; primary `bg-indigo-600` → `bg-zinc-900`
- **Modal.tsx** — Close button enlarged to 40px (44px mobile touch target)
- **Input.tsx** — Focus rings `indigo-400` → `lime-400` (dark/light modes)
- **ConfirmDialog.tsx** — Default variant `indigo-600` → `zinc-900`
- **FullPage.tsx** — CTA link `indigo-600` → `zinc-900`
- **IconButton.tsx** — Primary variant `indigo-600` → `zinc-900`
- **SidebarItem.tsx** — Admin theme: ring, indicator, badge colors → lime/zinc

#### Shared Layout Components
- **Navbar.tsx** — Added `notificationCount`, `onNotificationClick`, `actions` slot; brand colors
- **MobileTabBar.tsx** — Focus rings, active tab, CTA → lime/zinc
- **ProductCard.tsx** — Brand label `text-indigo-600` → `text-zinc-700`
- **AppSwitchboard.tsx** — Background gradients → zinc; mediator card → lime; removed unused indigo map entry
- **TicketDetailModal.tsx** — Textarea focus ring → lime-300

#### Page Components
- **Auth.tsx** — Splash background blob → lime
- **BrandAuth.tsx** — Splash blob → lime
- **AgencyAuth.tsx** — Logo gradient → purple-to-zinc
- **ConsumerApp.tsx** — Verification pending screen → lime/zinc
- **MediatorDashboard.tsx** — ~12 fixes: hero, badges, AI sections, filters, rings
- **Orders.tsx** — Focus rings, reviewer name
- **AgencyDashboard.tsx** — 14 fixes: header, campaign badges, AI sections, payout, filters
- **BrandDashboard.tsx** — 8 fixes: reviewer, AI verification, filters
- **AdminPortal.tsx** — ~25 fixes: login, sidebar, mobile, avatar, cards, badges, tickets, invite, finance, proof modal AI section

### Intentionally Preserved
- `CHART_COLORS.indigo` (line 81) — chart visualization constant
- `bgFromText['text-indigo-600']` (line 91) — JIT safelist mapping
- `bgLightFromText['text-indigo-600']` (line 100) — JIT safelist mapping
- `ORDER_STATUS_COLORS.Ordered` (line 145) — semantic status color for "Ordered" state

---

## AI Verification Threshold

- `AI_AUTO_VERIFY_THRESHOLD`: **85 → 80** (more aggressive auto-approval for correct proofs)
- `AI_PROOF_CONFIDENCE_THRESHOLD`: **70** (unchanged, for bulk auto-verify)
- File: `backend/config/env.ts`

---

## Performance Optimizations

### Bundle Size
- Added `framer-motion` to `optimizePackageImports` in all 5 `next.config.js` files
- Estimated savings: ~30-50 KB gzip per app

### Already Well-Optimized
- All 5 apps use `lazyRetry()` (React.lazy + chunk retry) with Suspense boundaries
- `ProxiedImage` has `loading="lazy"` + `decoding="async"` on all images
- `optimizePackageImports` already covered `lucide-react` and `recharts`
- Charts wrapped in `ChartSuspense` boundaries
- Key shared components already wrapped in `React.memo`

---

## Folder Structure

- **Deleted**: `shared/utils/auditDisplay.ts` (dead code — exported functions never imported)
- **Added to .gitignore**: `generated/` at root level for Prisma generated output safety
- **Verified clean**: No orphaned temp files, no committed `.env` files, no misplaced configs
