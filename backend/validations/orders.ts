import { z } from 'zod';

export const orderItemSchema = z.object({
  productId: z.string().min(1),
  title: z.string().min(1),
  image: z.string().min(1),
  priceAtPurchase: z.number().nonnegative().max(10_00_000),
  commission: z.number().nonnegative().max(10_00_000),
  campaignId: z.string().min(1),
  dealType: z.string().min(1),
  quantity: z.number().int().min(1).max(100),
  platform: z.string().optional(),
  brandName: z.string().optional(),
});

const isImageDataUrl = (value?: string) => {
  if (!value) return false;
  return /^data:image\/(png|jpe?g|webp|svg\+xml);base64,/i.test(value);
};

const isHttpsUrl = (value?: string) => {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:';
  } catch {
    return false;
  }
};

export const createOrderSchema = z
  .object({
  userId: z.string().min(1),
  preOrderId: z.string().min(1).optional(),
  items: z.array(orderItemSchema).min(1),
  screenshots: z
    .object({
      order: z.string().optional(),
      payment: z.string().optional(),
      review: z.string().optional(),
      rating: z.string().optional(),
      returnWindow: z.string().optional(),
    })
    .optional(),
  externalOrderId: z.string().min(1).max(128).optional(),
  reviewLink: z.string().min(1).max(2000).optional(),
  // Marketplace reviewer / profile name used by the buyer
  reviewerName: z.string().max(200).transform(v => v.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f]/g, '').trim()).optional(),
  // AI-extracted metadata from order screenshot
  orderDate: z.string().max(100).optional(),
  soldBy: z.string().max(200).transform(v => v.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f]/g, '').trim()).optional(),
  extractedProductName: z.string().max(500).transform(v => v.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f]/g, '').trim()).optional(),
})
  .superRefine((value, ctx) => {
    if (value.reviewLink && !isHttpsUrl(value.reviewLink)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['reviewLink'],
        message: 'Review link must be a valid https URL',
      });
    }
    if (value.screenshots?.order && !isImageDataUrl(value.screenshots.order)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['screenshots', 'order'],
        message: 'Order proof must be a valid image data URL',
      });
    }
    if (value.screenshots?.rating && !isImageDataUrl(value.screenshots.rating)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['screenshots', 'rating'],
        message: 'Rating proof must be a valid image data URL',
      });
    }
    if (value.screenshots?.review && !isImageDataUrl(value.screenshots.review)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['screenshots', 'review'],
        message: 'Review proof must be a valid image data URL',
      });
    }
  });

export const submitClaimSchema = z
  .object({
    orderId: z.string().min(1),
    type: z.enum(['review', 'rating', 'order', 'returnWindow']),
    data: z.string().min(1),
    // Marketplace reviewer / profile name (optional, can be updated with any proof upload)
    reviewerName: z.string().max(200).transform(v => v.replace(/<[^>]*>/g, '').replace(/[\x00-\x1f]/g, '').trim()).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.type === 'review' && !isHttpsUrl(value.data)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['data'],
        message: 'Review link must be a valid https URL',
      });
    }
    if (value.type !== 'review' && !isImageDataUrl(value.data)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['data'],
        message: 'Proof must be a valid image data URL',
      });
    }
  });
