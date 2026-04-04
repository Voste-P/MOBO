'use client';

import React from 'react';
import { ExpandableText } from './ui';

/* ── Types ──────────────────────────────────────────────────────────── */

export interface RatingAiVerification {
  accountNameMatch?: boolean;
  productNameMatch?: boolean;
  detectedAccountName?: string;
  detectedProductName?: string;
  confidenceScore?: number;
  discrepancyNote?: string;
}

export interface ReturnWindowAiVerification {
  orderIdMatch?: boolean;
  productNameMatch?: boolean;
  amountMatch?: boolean;
  soldByMatch?: boolean;
  returnWindowClosed?: boolean;
  confidenceScore?: number;
  detectedReturnWindow?: string;
  discrepancyNote?: string;
}

export interface OrderAiVerification {
  orderIdMatch?: boolean;
  amountMatch?: boolean;
  confidenceScore?: number;
}

/* ── Theme variants for light/dark portals ──────────────────────────── */

type Theme = 'light' | 'dark';

const themeStyles = {
  light: {
    matchBg: 'bg-green-50 border border-green-200',
    matchText: 'text-green-600',
    mismatchBg: 'bg-red-50 border border-red-200',
    mismatchText: 'text-red-600',
    warnBg: 'bg-yellow-50 border border-yellow-200',
    warnText: 'text-yellow-600',
    detailText: 'text-slate-500',
    headerText: 'text-slate-700',
    noteText: 'text-red-500',
    confidenceText: 'text-slate-500',
  },
  dark: {
    matchBg: 'bg-green-900/30 border border-green-700',
    matchText: 'text-green-400',
    mismatchBg: 'bg-red-900/30 border border-red-700',
    mismatchText: 'text-red-400',
    warnBg: 'bg-yellow-900/30 border border-yellow-700',
    warnText: 'text-yellow-400',
    detailText: 'text-zinc-500',
    headerText: 'text-zinc-300',
    noteText: 'text-red-400',
    confidenceText: 'text-zinc-500',
  },
} as const;

/* ── Single verification item ───────────────────────────────────────── */

function VerifyItem({
  label,
  match,
  detected,
  theme,
  trueLabel = '✓ Match',
  falseLabel = '✗ Mismatch',
}: {
  label: string;
  match: boolean | undefined;
  detected?: string;
  theme: Theme;
  trueLabel?: string;
  falseLabel?: string;
}) {
  if (match === undefined) return null;
  const s = themeStyles[theme];
  const bg = match ? s.matchBg : s.mismatchBg;
  const text = match ? s.matchText : s.mismatchText;

  return (
    <div className={`p-2 rounded-lg text-center ${bg}`}>
      <p className="text-[9px] font-bold text-slate-400 uppercase">{label}</p>
      <p className={`text-xs font-bold ${text}`}>
        {match ? trueLabel : falseLabel}
      </p>
      {detected && (
        <ExpandableText text={detected} clampClass="truncate" className={`text-[9px] ${s.detailText} mt-0.5`} as="p">
          Found: {detected}
        </ExpandableText>
      )}
    </div>
  );
}

/* ── Rating AI Verification Badge ───────────────────────────────────── */

export const RatingVerificationBadge = React.memo(function RatingVerificationBadge({
  data,
  theme = 'light',
  className,
}: {
  data: RatingAiVerification;
  theme?: Theme;
  className?: string;
}) {
  const s = themeStyles[theme];
  return (
    <div className={className ?? 'space-y-1'}>
      <p className={`text-[10px] font-bold uppercase tracking-wider ${theme === 'light' ? 'text-orange-400' : 'text-orange-300'}`}>AI Rating Verification</p>
      <div className="grid grid-cols-2 gap-1">
        <VerifyItem label="Account Name" match={data.accountNameMatch} detected={data.detectedAccountName} theme={theme} />
        <VerifyItem label="Product Name" match={data.productNameMatch} detected={data.detectedProductName} theme={theme} />
      </div>
      {data.confidenceScore !== undefined && (
        <p className={`text-[9px] ${s.confidenceText}`}>Confidence: {data.confidenceScore}%</p>
      )}
    </div>
  );
});

/* ── Return Window AI Verification Badge ────────────────────────────── */

export const ReturnWindowVerificationBadge = React.memo(function ReturnWindowVerificationBadge({
  data,
  theme = 'light',
  className,
}: {
  data: ReturnWindowAiVerification;
  theme?: Theme;
  className?: string;
}) {
  const s = themeStyles[theme];
  return (
    <div className={className ?? 'space-y-1'}>
      <p className={`text-[10px] font-bold uppercase tracking-wider ${theme === 'light' ? 'text-teal-500' : 'text-teal-300'}`}>AI Return Window Verification</p>
      <div className="grid grid-cols-2 gap-1">
        <VerifyItem label="Order ID" match={data.orderIdMatch} theme={theme} />
        <VerifyItem label="Product" match={data.productNameMatch} theme={theme} />
        <VerifyItem label="Amount" match={data.amountMatch} theme={theme} />
        <VerifyItem
          label="Return Window"
          match={data.returnWindowClosed}
          theme={theme}
          trueLabel="✓ Closed"
          falseLabel="⏳ Open"
        />
      </div>
      {data.detectedReturnWindow && (
        <p className={`text-[9px] ${s.detailText}`}>Detected Window: {data.detectedReturnWindow}</p>
      )}
      {data.discrepancyNote && (
        <p className={`text-[9px] ${s.noteText} font-semibold`}>Note: {data.discrepancyNote}</p>
      )}
      {data.confidenceScore !== undefined && (
        <p className={`text-[9px] ${s.confidenceText}`}>Confidence: {data.confidenceScore}%</p>
      )}
    </div>
  );
});

/* ── Order Proof AI Verification Badge ──────────────────────────────── */

export const OrderVerificationBadge = React.memo(function OrderVerificationBadge({
  data,
  theme = 'light',
  className,
}: {
  data: OrderAiVerification;
  theme?: Theme;
  className?: string;
}) {
  const s = themeStyles[theme];
  return (
    <div className={className ?? 'space-y-1'}>
      <p className={`text-[10px] font-semibold ${s.headerText}`}>🤖 AI Order Proof Verification</p>
      <div className="grid grid-cols-2 gap-1">
        <VerifyItem label="Order ID" match={data.orderIdMatch} theme={theme} />
        <VerifyItem label="Amount" match={data.amountMatch} theme={theme} />
      </div>
      {data.confidenceScore !== undefined && (
        <p className={`text-[9px] ${s.confidenceText}`}>Confidence: {data.confidenceScore}%</p>
      )}
    </div>
  );
});
