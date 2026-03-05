// All mappers accept `any` (PG rows or legacy shapes).
import { paiseToRupees } from './money.js';

/** Safely convert a value to ISO string, returning undefined for invalid dates. */
export function safeIso(val: any): string | undefined {
  if (!val) return undefined;
  const d = new Date(val);
  return isNaN(d.getTime()) ? undefined : d.toISOString();
}

export function toUiRole(role: string): 'user' | 'agency' | 'mediator' | 'brand' | 'admin' {
  if (role === 'shopper') return 'user';
  if (role === 'ops') return 'admin';
  if (role === 'agency') return 'agency';
  if (role === 'mediator') return 'mediator';
  if (role === 'brand') return 'brand';
  if (role === 'admin') return 'admin';
  return 'user';
}

export function toUiUser(
  user: any,
  wallet?: any
) {
  const walletBalancePaise = wallet?.availablePaise ?? user.walletBalancePaise ?? 0;
  const walletPendingPaise = wallet?.pendingPaise ?? user.walletPendingPaise ?? 0;

  const role = toUiRole(String(user.role));

  return {
    id: String(user._id ?? user.id),
    name: user.name,
    mobile: user.mobile,
    email: user.email,
    role,
    status: user.status,

    mediatorCode: role === 'user' ? user.parentCode : user.mediatorCode,
    parentCode: role === 'user' ? undefined : user.parentCode,
    generatedCodes: user.generatedCodes ?? [],

    brandCode: user.brandCode,
    connectedAgencies: user.connectedAgencies ?? [],
    pendingConnections: (user.pendingConnections ?? []).map((p: any) => ({
      agencyId: p.agencyId,
      agencyName: p.agencyName,
      agencyCode: p.agencyCode,
      timestamp: safeIso(p.timestamp) ?? new Date().toISOString(),
    })),

    kycStatus: user.kycStatus,
    kycDocuments: user.kycDocuments,

    isVerifiedByMediator: user.isVerifiedByMediator,

    upiId: user.upiId,
    qrCode: user.qrCode,
    bankDetails: user.bankDetails,

    walletBalance: paiseToRupees(walletBalancePaise),
    walletPending: paiseToRupees(walletPendingPaise),

    avatar: user.avatar,
    createdAt: safeIso(user.createdAt),
  };
}

export function toUiCampaign(c: any) {
  const statusMap: Record<string, 'Active' | 'Paused' | 'Completed' | 'Draft'> = {
    active: 'Active',
    paused: 'Paused',
    completed: 'Completed',
    draft: 'Draft',
  };

  const assignmentsObj =
    c.assignments instanceof Map ? Object.fromEntries(c.assignments) : c.assignments;

  // UI expects assignments as "slots per code" (number). The DB schema supports
  // { limit, payout?, commissionPaise? } objects; normalize those objects down to their limit.
  const assignments: Record<string, number> = {};
  const assignmentDetails: Record<string, { limit: number; payout: number; commission: number }> = {};
  if (assignmentsObj && typeof assignmentsObj === 'object') {
    for (const [code, raw] of Object.entries(assignmentsObj)) {
      if (typeof raw === 'number') {
        assignments[code] = raw;
        assignmentDetails[code] = { limit: raw, payout: paiseToRupees(c.payoutPaise), commission: 0 };
        continue;
      }
      if (raw && typeof raw === 'object' && typeof (raw as any).limit === 'number') {
        assignments[code] = (raw as any).limit;
        assignmentDetails[code] = {
          limit: (raw as any).limit,
          payout: paiseToRupees(typeof (raw as any).payout === 'number' ? (raw as any).payout : c.payoutPaise),
          commission: paiseToRupees((raw as any).commissionPaise ?? 0),
        };
        continue;
      }
      assignments[code] = 0;
      assignmentDetails[code] = { limit: 0, payout: paiseToRupees(c.payoutPaise), commission: 0 };
    }
  }

  return {
    id: String(c._id ?? c.id),
    title: c.title,
    brand: c.brandName,
    brandId: String(c.brandUserId ?? c.brandId ?? ''),
    platform: c.platform,
    price: paiseToRupees(c.pricePaise),
    originalPrice: paiseToRupees(c.originalPricePaise),
    payout: paiseToRupees(c.payoutPaise),
    image: c.image,
    productUrl: c.productUrl,
    totalSlots: c.totalSlots ?? 0,
    usedSlots: c.usedSlots ?? 0,
    status: statusMap[String(c.status)] ?? 'Draft',
    assignments,
    allowedAgencies: c.allowedAgencyCodes ?? c.allowedAgencies ?? [],
    createdAt: c.createdAt ? new Date(c.createdAt).getTime() : Date.now(),
    returnWindowDays: c.returnWindowDays,
    dealType: c.dealType,
    assignmentDetails,
  };
}

export function toUiDeal(d: any, mediatorName?: string) {
  const placeholderImage =
    'data:image/svg+xml;utf8,' +
    encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160" viewBox="0 0 160 160">' +
        '<rect width="160" height="160" rx="24" fill="#F3F4F6"/>' +
        '<circle cx="80" cy="64" r="24" fill="#E5E7EB"/>' +
        '<rect x="32" y="104" width="96" height="16" rx="8" fill="#E5E7EB"/>' +
      '</svg>'
    );
  const safeText = (value: unknown) => String(value || '').replace(/["\\]/g, '').trim();
  const image = safeText(d.image) || placeholderImage;

  return {
    id: String(d._id ?? d.id),
    title: safeText(d.title),
    description: safeText(d.description) || 'Exclusive',
    price: paiseToRupees(d.pricePaise),
    originalPrice: paiseToRupees(d.originalPricePaise),
    commission: paiseToRupees(d.commissionPaise),
    image,
    productUrl: safeText(d.productUrl),
    rating: d.rating ?? 5,
    category: safeText(d.category) || 'General',
    platform: safeText(d.platform),
    dealType: safeText(d.dealType),
    brandName: safeText(d.brandName),
    mediatorCode: safeText(d.mediatorCode),
    mediatorName: safeText(mediatorName || d.mediatorName),
    campaignId: String(d.campaignId),
    active: !!d.active,
    inventoryCount: d.inventoryCount ?? 0,
  };
}

/**
 * Lightweight order summary for LIST endpoints.
 * Strips screenshots, events, AI verification, and missing-proof details
 * to reduce payload from ~5-20 KB/order to ~0.5-1 KB/order.
 */
export function toUiOrderSummary(o: any) {
  if (!o || typeof o !== 'object') {
    throw new Error('toUiOrderSummary: received null or non-object input');
  }
  const verification = (o.verification && typeof o.verification === 'object') ? o.verification : {};
  const dealTypes = (o.items ?? []).map((it: any) => String(it?.dealType || '')).filter(Boolean);
  const requiresReview = dealTypes.includes('Review');
  const requiresRating = dealTypes.includes('Rating');
  const requiresReturnWindow = requiresReview || requiresRating;

  const orderVerifiedAt = verification.order?.verifiedAt ? new Date(verification.order.verifiedAt) : null;
  const reviewVerifiedAt = verification.review?.verifiedAt ? new Date(verification.review.verifiedAt) : null;
  const ratingVerifiedAt = verification.rating?.verifiedAt ? new Date(verification.rating.verifiedAt) : null;
  const returnWindowVerifiedAt = verification.returnWindow?.verifiedAt ? new Date(verification.returnWindow.verifiedAt) : null;

  return {
    id: String(o._id ?? o.id),
    userId: String(o.userId),
    items: (o.items ?? []).map((it: any) => ({
      title: it.title,
      image: it.image,
      dealType: it.dealType,
      quantity: it.quantity,
      platform: it.platform,
      brandName: it.brandName,
    })),
    total: paiseToRupees(o.totalPaise),
    status: o.status,
    workflowStatus: o.workflowStatus,
    frozen: !!o.frozen,
    paymentStatus: o.paymentStatus,
    affiliateStatus: o.affiliateStatus,
    externalOrderId: o.externalOrderId,
    hasOrderProof: !!(o.screenshots?.order || o.screenshots?.payment),
    hasReviewProof: !!(o.reviewLink || o.screenshots?.review),
    hasRatingProof: !!o.screenshots?.rating,
    hasReturnWindowProof: !!o.screenshots?.returnWindow,
    // Lightweight screenshots flags (truthy markers, NOT base64 data)
    // Enables frontend proof indicators and ProofImage component checks
    screenshots: {
      order: o.screenshots?.order ? 'exists' : null,
      payment: o.screenshots?.payment ? 'exists' : null,
      review: o.screenshots?.review ? 'exists' : null,
      rating: o.screenshots?.rating ? 'exists' : null,
      returnWindow: o.screenshots?.returnWindow ? 'exists' : null,
    },
    reviewLink: o.reviewLink || null,
    verification: {
      orderVerified: !!orderVerifiedAt,
      reviewVerified: !!reviewVerifiedAt,
      ratingVerified: !!ratingVerifiedAt,
      returnWindowVerified: !!returnWindowVerifiedAt,
    },
    requirements: {
      required: [
        ...(requiresReview ? (['review'] as const) : []),
        ...(requiresRating ? (['rating'] as const) : []),
        ...(requiresReturnWindow ? (['returnWindow'] as const) : []),
      ],
    },
    rejection: o.rejection
      ? { type: o.rejection.type, reason: o.rejection.reason }
      : undefined,
    managerName: o.managerName,
    agencyName: o.agencyName,
    buyerName: o.buyerName,
    brandName: o.brandName,
    createdAt: safeIso(o.createdAt ?? o.createdAtIso) ?? new Date().toISOString(),
    expectedSettlementDate: safeIso(o.expectedSettlementDate),
  };
}

/**
 * Lightweight order summary for brand list endpoints.
 * Excludes buyer PII (name, mobile) and heavy data.
 */
export function toUiOrderSummaryForBrand(o: any) {
  if (!o || typeof o !== 'object') {
    throw new Error('toUiOrderSummaryForBrand: received null or non-object input');
  }
  const verification = (o.verification && typeof o.verification === 'object') ? o.verification : {};
  const dealTypes = (o.items ?? []).map((it: any) => String(it?.dealType || '')).filter(Boolean);
  const requiresReview = dealTypes.includes('Review');
  const requiresRating = dealTypes.includes('Rating');
  const requiresReturnWindow = requiresReview || requiresRating;

  const orderVerifiedAt = verification.order?.verifiedAt ? new Date(verification.order.verifiedAt) : null;
  const reviewVerifiedAt = verification.review?.verifiedAt ? new Date(verification.review.verifiedAt) : null;
  const ratingVerifiedAt = verification.rating?.verifiedAt ? new Date(verification.rating.verifiedAt) : null;
  const returnWindowVerifiedAt = verification.returnWindow?.verifiedAt ? new Date(verification.returnWindow.verifiedAt) : null;

  return {
    id: String(o._id ?? o.id),
    items: (o.items ?? []).map((it: any) => ({
      title: it.title,
      image: it.image,
      dealType: it.dealType,
      quantity: it.quantity,
      platform: it.platform,
      brandName: it.brandName,
    })),
    total: paiseToRupees(o.totalPaise),
    status: o.status,
    workflowStatus: o.workflowStatus,
    frozen: !!o.frozen,
    paymentStatus: o.paymentStatus,
    affiliateStatus: o.affiliateStatus,
    externalOrderId: o.externalOrderId,
    hasOrderProof: !!(o.screenshots?.order || o.screenshots?.payment),
    hasReviewProof: !!(o.reviewLink || o.screenshots?.review),
    hasRatingProof: !!o.screenshots?.rating,
    hasReturnWindowProof: !!o.screenshots?.returnWindow,
    // Lightweight screenshots flags (truthy markers, NOT base64 data)
    screenshots: {
      order: o.screenshots?.order ? 'exists' : null,
      payment: o.screenshots?.payment ? 'exists' : null,
      review: o.screenshots?.review ? 'exists' : null,
      rating: o.screenshots?.rating ? 'exists' : null,
      returnWindow: o.screenshots?.returnWindow ? 'exists' : null,
    },
    reviewLink: o.reviewLink || null,
    verification: {
      orderVerified: !!orderVerifiedAt,
      reviewVerified: !!reviewVerifiedAt,
      ratingVerified: !!ratingVerifiedAt,
      returnWindowVerified: !!returnWindowVerifiedAt,
    },
    requirements: {
      required: [
        ...(requiresReview ? (['review'] as const) : []),
        ...(requiresRating ? (['rating'] as const) : []),
        ...(requiresReturnWindow ? (['returnWindow'] as const) : []),
      ],
    },
    rejection: o.rejection
      ? { type: o.rejection.type, reason: o.rejection.reason }
      : undefined,
    managerName: o.managerName,
    agencyName: o.agencyName,
    reviewerName: o.reviewerName,
    brandName: o.brandName,
    createdAt: safeIso(o.createdAt ?? o.createdAtIso) ?? new Date().toISOString(),
    expectedSettlementDate: safeIso(o.expectedSettlementDate),
  };
}

export function toUiOrder(o: any) {
  if (!o || typeof o !== 'object') {
    throw new Error('toUiOrder: received null or non-object input');
  }
  const verification = (o.verification && typeof o.verification === 'object') ? o.verification : {};
  const dealTypes = (o.items ?? []).map((it: any) => String(it?.dealType || '')).filter(Boolean);
  const requiresReview = dealTypes.includes('Review');
  const requiresRating = dealTypes.includes('Rating');
  const requiresReturnWindow = requiresReview || requiresRating;

  const hasReviewProof = !!(o.reviewLink || o.screenshots?.review);
  const hasRatingProof = !!o.screenshots?.rating;
  const hasReturnWindowProof = !!o.screenshots?.returnWindow;

  const orderVerifiedAt = verification.order?.verifiedAt ? new Date(verification.order.verifiedAt) : null;
  const reviewVerifiedAt = verification.review?.verifiedAt ? new Date(verification.review.verifiedAt) : null;
  const ratingVerifiedAt = verification.rating?.verifiedAt ? new Date(verification.rating.verifiedAt) : null;
  const returnWindowVerifiedAt = verification.returnWindow?.verifiedAt ? new Date(verification.returnWindow.verifiedAt) : null;

  const requiredSteps: Array<'review' | 'rating' | 'returnWindow'> = [
    ...(requiresReview ? (['review'] as const) : []),
    ...(requiresRating ? (['rating'] as const) : []),
    ...(requiresReturnWindow ? (['returnWindow'] as const) : []),
  ];

  const missingProofs: Array<'review' | 'rating' | 'returnWindow'> = [
    ...(requiresReview && !hasReviewProof ? (['review'] as const) : []),
    ...(requiresRating && !hasRatingProof ? (['rating'] as const) : []),
    ...(requiresReturnWindow && !hasReturnWindowProof ? (['returnWindow'] as const) : []),
  ];

  const missingVerifications: Array<'review' | 'rating' | 'returnWindow'> = [
    ...(requiresReview && !reviewVerifiedAt ? (['review'] as const) : []),
    ...(requiresRating && !ratingVerifiedAt ? (['rating'] as const) : []),
    ...(requiresReturnWindow && !returnWindowVerifiedAt ? (['returnWindow'] as const) : []),
  ];
  return {
    id: String(o._id ?? o.id),
    userId: String(o.userId),
    items: (o.items ?? []).map((it: any) => ({
      productId: it.productId,
      title: it.title,
      image: it.image,
      priceAtPurchase: paiseToRupees(it.priceAtPurchasePaise),
      commission: paiseToRupees(it.commissionPaise),
      campaignId: String(it.campaignId),
      dealType: it.dealType,
      quantity: it.quantity,
      platform: it.platform,
      brandName: it.brandName,
    })),
    total: paiseToRupees(o.totalPaise),
    status: o.status,
    workflowStatus: o.workflowStatus,
    frozen: !!o.frozen,
    frozenAt: safeIso(o.frozenAt),
    frozenReason: o.frozenReason,
    paymentStatus: o.paymentStatus,
    affiliateStatus: o.affiliateStatus,
    externalOrderId: o.externalOrderId,
    settlementRef: (o as any).settlementRef,
    screenshots: o.screenshots ?? {},
    reviewLink: o.reviewLink,
    rejection: o.rejection
      ? {
          type: o.rejection.type,
          reason: o.rejection.reason,
          rejectedAt: safeIso(o.rejection.rejectedAt),
          rejectedBy: o.rejection.rejectedBy ? String(o.rejection.rejectedBy) : undefined,
        }
      : undefined,
    verification: {
      orderVerified: !!orderVerifiedAt,
      orderVerifiedAt: safeIso(orderVerifiedAt),
      reviewVerified: !!reviewVerifiedAt,
      reviewVerifiedAt: safeIso(reviewVerifiedAt),
      ratingVerified: !!ratingVerifiedAt,
      ratingVerifiedAt: safeIso(ratingVerifiedAt),
      returnWindowVerified: !!returnWindowVerifiedAt,
      returnWindowVerifiedAt: safeIso(returnWindowVerifiedAt),
    },
    requirements: {
      required: requiredSteps,
      missingProofs,
      missingVerifications,
    },
    ratingAiVerification: o.ratingAiVerification ? {
      accountNameMatch: o.ratingAiVerification.accountNameMatch,
      productNameMatch: o.ratingAiVerification.productNameMatch,
      detectedAccountName: o.ratingAiVerification.detectedAccountName,
      detectedProductName: o.ratingAiVerification.detectedProductName,
      confidenceScore: o.ratingAiVerification.confidenceScore,
    } : undefined,
    orderAiVerification: o.orderAiVerification ? {
      orderIdMatch: o.orderAiVerification.orderIdMatch,
      amountMatch: o.orderAiVerification.amountMatch,
      detectedOrderId: o.orderAiVerification.detectedOrderId,
      detectedAmount: o.orderAiVerification.detectedAmount,
      confidenceScore: o.orderAiVerification.confidenceScore,
      discrepancyNote: o.orderAiVerification.discrepancyNote,
    } : undefined,
    returnWindowAiVerification: o.returnWindowAiVerification ? {
      orderIdMatch: o.returnWindowAiVerification.orderIdMatch,
      productNameMatch: o.returnWindowAiVerification.productNameMatch,
      amountMatch: o.returnWindowAiVerification.amountMatch,
      soldByMatch: o.returnWindowAiVerification.soldByMatch,
      returnWindowClosed: o.returnWindowAiVerification.returnWindowClosed,
      confidenceScore: o.returnWindowAiVerification.confidenceScore,
      detectedReturnWindow: o.returnWindowAiVerification.detectedReturnWindow,
      discrepancyNote: o.returnWindowAiVerification.discrepancyNote,
    } : undefined,
    returnWindowDays: o.returnWindowDays ?? 7,
    missingProofRequests: Array.isArray(o.missingProofRequests)
      ? o.missingProofRequests.map((r: any) => ({
          type: r?.type,
          note: r?.note,
          requestedAt: safeIso(r?.requestedAt),
          requestedBy: r?.requestedBy ? String(r.requestedBy) : undefined,
        }))
      : [],
    managerName: o.managerName,
    agencyName: o.agencyName,
    buyerName: o.buyerName,
    buyerMobile: o.buyerMobile,
    reviewerName: o.reviewerName,
    brandName: o.brandName,
    orderDate: safeIso(o.orderDate),
    soldBy: o.soldBy,
    extractedProductName: o.extractedProductName,
    createdAt: safeIso(o.createdAt ?? o.createdAtIso) ?? new Date().toISOString(),
    expectedSettlementDate: safeIso(o.expectedSettlementDate),
    // Audit trail: sanitized event log (strip internal metadata)
    events: Array.isArray(o.events)
      ? o.events.map((e: any) => ({
          type: e.type,
          at: safeIso(e.at),
          metadata: e.metadata ? { ...e.metadata, aiVerification: undefined } : undefined,
        }))
      : [],
  };
}

// Brand must never receive buyer PII (name, phone, etc.) but CAN see proof artifacts.
export function toUiOrderForBrand(o: any) {
  if (!o || typeof o !== 'object') {
    throw new Error('toUiOrderForBrand: received null or non-object input');
  }
  const verification = (o.verification && typeof o.verification === 'object') ? o.verification : {};
  const dealTypes = (o.items ?? []).map((it: any) => String(it?.dealType || '')).filter(Boolean);
  const requiresReview = dealTypes.includes('Review');
  const requiresRating = dealTypes.includes('Rating');
  const requiresReturnWindow = requiresReview || requiresRating;

  const hasReviewProof = !!(o.reviewLink || o.screenshots?.review);
  const hasRatingProof = !!o.screenshots?.rating;
  const hasReturnWindowProof = !!o.screenshots?.returnWindow;

  const orderVerifiedAt = verification.order?.verifiedAt ? new Date(verification.order.verifiedAt) : null;
  const reviewVerifiedAt = verification.review?.verifiedAt ? new Date(verification.review.verifiedAt) : null;
  const ratingVerifiedAt = verification.rating?.verifiedAt ? new Date(verification.rating.verifiedAt) : null;
  const returnWindowVerifiedAt = verification.returnWindow?.verifiedAt ? new Date(verification.returnWindow.verifiedAt) : null;

  const requiredSteps: Array<'review' | 'rating' | 'returnWindow'> = [
    ...(requiresReview ? (['review'] as const) : []),
    ...(requiresRating ? (['rating'] as const) : []),
    ...(requiresReturnWindow ? (['returnWindow'] as const) : []),
  ];

  const missingProofs: Array<'review' | 'rating' | 'returnWindow'> = [
    ...(requiresReview && !hasReviewProof ? (['review'] as const) : []),
    ...(requiresRating && !hasRatingProof ? (['rating'] as const) : []),
    ...(requiresReturnWindow && !hasReturnWindowProof ? (['returnWindow'] as const) : []),
  ];

  const missingVerifications: Array<'review' | 'rating' | 'returnWindow'> = [
    ...(requiresReview && !reviewVerifiedAt ? (['review'] as const) : []),
    ...(requiresRating && !ratingVerifiedAt ? (['rating'] as const) : []),
    ...(requiresReturnWindow && !returnWindowVerifiedAt ? (['returnWindow'] as const) : []),
  ];

  return {
    id: String(o._id ?? o.id),
    items: (o.items ?? []).map((it: any) => ({
      productId: it.productId,
      title: it.title,
      image: it.image,
      priceAtPurchase: paiseToRupees(it.priceAtPurchasePaise),
      commission: paiseToRupees(it.commissionPaise),
      campaignId: String(it.campaignId),
      dealType: it.dealType,
      quantity: it.quantity,
      platform: it.platform,
      brandName: it.brandName,
    })),
    total: paiseToRupees(o.totalPaise),
    status: o.status,
    workflowStatus: o.workflowStatus,
    frozen: !!o.frozen,
    frozenAt: safeIso(o.frozenAt),
    frozenReason: o.frozenReason,
    paymentStatus: o.paymentStatus,
    affiliateStatus: o.affiliateStatus,
    externalOrderId: o.externalOrderId,
    settlementRef: (o as any).settlementRef,
    // Brand can see proof artifacts to verify that orders are genuine.
    screenshots: o.screenshots ?? {},
    reviewLink: o.reviewLink,
    hasOrderProof: !!(o.screenshots?.order || o.screenshots?.payment),
    hasReviewProof,
    hasRatingProof,
    hasReturnWindowProof,
    verification: {
      orderVerified: !!orderVerifiedAt,
      orderVerifiedAt: safeIso(orderVerifiedAt),
      reviewVerified: !!reviewVerifiedAt,
      reviewVerifiedAt: safeIso(reviewVerifiedAt),
      ratingVerified: !!ratingVerifiedAt,
      ratingVerifiedAt: safeIso(ratingVerifiedAt),
      returnWindowVerified: !!returnWindowVerifiedAt,
      returnWindowVerifiedAt: safeIso(returnWindowVerifiedAt),
    },
    requirements: {
      required: requiredSteps,
      missingProofs,
      missingVerifications,
    },
    rejection: o.rejection
      ? {
          type: o.rejection.type,
          reason: o.rejection.reason,
          rejectedAt: safeIso(o.rejection.rejectedAt),
        }
      : undefined,
    missingProofRequests: Array.isArray(o.missingProofRequests)
      ? o.missingProofRequests.map((r: any) => ({
          type: r?.type,
          note: r?.note,
          requestedAt: safeIso(r?.requestedAt),
        }))
      : [],
    managerName: o.managerName,
    agencyName: o.agencyName,
    reviewerName: o.reviewerName,
    brandName: o.brandName,
    orderDate: safeIso(o.orderDate),
    soldBy: o.soldBy,
    extractedProductName: o.extractedProductName,
    createdAt: safeIso(o.createdAt ?? o.createdAtIso) ?? new Date().toISOString(),
    expectedSettlementDate: safeIso(o.expectedSettlementDate),
    // Audit trail (brand view: omit actorUserId for privacy)
    events: Array.isArray(o.events)
      ? o.events.map((e: any) => ({
          type: e.type,
          at: safeIso(e.at),
        }))
      : [],
  };
}

export function toUiTicketForBrand(t: any) {
  return {
    id: String(t._id ?? t.id),
    // Do not leak who the buyer is to brands.
    userName: 'User',
    role: t.role,
    orderId: t.orderId,
    issueType: t.issueType,
    description: t.description,
    status: t.status,
    priority: t.priority || 'medium',
    targetRole: t.targetRole || null,
    resolutionNote: t.resolutionNote || null,
    resolvedAt: safeIso(t.resolvedAt) ?? null,
    createdAt: safeIso(t.createdAt) ?? new Date().toISOString(),
  };
}
export function toUiTicket(t: any) {
  return {
    id: String(t._id ?? t.id),
    userId: String(t.userId),
    userName: t.userName,
    role: t.role,
    orderId: t.orderId,
    issueType: t.issueType,
    description: t.description,
    status: t.status,
    priority: t.priority || 'medium',
    targetRole: t.targetRole || null,
    resolutionNote: t.resolutionNote || null,
    resolvedBy: t.resolvedBy || null,
    resolvedByName: t.resolvedByName || null,
    resolvedAt: safeIso(t.resolvedAt) ?? null,
    createdAt: safeIso(t.createdAt) ?? new Date().toISOString(),
  };
}
