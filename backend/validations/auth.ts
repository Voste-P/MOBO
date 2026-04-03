import { z } from 'zod';
import { normalizeMobileTo10Digits } from '../utils/mobiles.js';

const mobile10Schema = z.preprocess(
  (value) => normalizeMobileTo10Digits(value),
  z.string().regex(/^\d{10}$/, 'Mobile number must be exactly 10 digits')
);

function emptyStringToUndefined(value: unknown) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'string' && value.trim() === '') return undefined;
  return value;
}

function optionalNonEmptyString(max: number) {
  return z.preprocess(emptyStringToUndefined, z.string().min(1).max(max).optional());
}

// Reusable strong password schema — enforced on all registration endpoints.
const strongPasswordSchema = z.string().min(8).max(200)
  .regex(/[A-Z]/, 'Password must contain at least one uppercase letter')
  .regex(/[a-z]/, 'Password must contain at least one lowercase letter')
  .regex(/[0-9]/, 'Password must contain at least one number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain at least one special character');

export const registerSchema = z.object({
  name: z.string().min(2).max(120),
  mobile: mobile10Schema,
  email: z.string().email().optional(),
  password: strongPasswordSchema,
  mediatorCode: z.string().min(1).max(64),
});

export const loginSchema = z.union([
  z.object({
    mobile: mobile10Schema,
    password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  }),
  z.object({
    username: z.string().min(2).max(64),
    password: z.string().min(8, 'Password must be at least 8 characters').max(200),
  }),
]);

export const registerOpsSchema = z.object({
  name: z.string().min(2).max(120),
  mobile: mobile10Schema,
  password: strongPasswordSchema,
  role: z.enum(['agency', 'mediator']),
  code: z.string().min(1).max(128),
});

export const registerBrandSchema = z.object({
  name: z.string().min(2).max(120),
  mobile: mobile10Schema,
  password: strongPasswordSchema,
  brandCode: z.string().min(2).max(64),
});

export const updateProfileSchema = z.object({
  userId: z.string().min(1).optional(),
  name: optionalNonEmptyString(120),
  email: z.preprocess(emptyStringToUndefined, z.string().email().optional()),
  // Data URLs / base64 images can be large; allow a reasonable limit.
  avatar: optionalNonEmptyString(5_000_000),
  upiId: optionalNonEmptyString(128),
  qrCode: optionalNonEmptyString(5_000_000),
  bankDetails: z
    .object({
      accountNumber: optionalNonEmptyString(64),
      ifsc: optionalNonEmptyString(32),
      bankName: optionalNonEmptyString(120),
      holderName: optionalNonEmptyString(120),
    })
    .optional(),
});

export const refreshSchema = z.object({
  refreshToken: z.string().min(1).max(5000),
});

// ── Forgot Password / Security Questions ──

/** Valid question IDs (1-7 predefined questions) */
const questionIdSchema = z.number().int().min(1).max(7);

/** Three distinct security question+answer pairs — set during registration */
export const securityQuestionsPayloadSchema = z
  .array(
    z.object({
      questionId: questionIdSchema,
      answer: z.string().min(1, 'Answer is required').max(200),
    })
  )
  .length(3)
  .refine(
    (items) => new Set(items.map((i) => i.questionId)).size === 3,
    { message: 'All three security questions must be different' }
  );

export const registerWithSecurityQuestionsSchema = registerSchema.extend({
  securityQuestions: securityQuestionsPayloadSchema,
});

export const registerOpsWithSecurityQuestionsSchema = registerOpsSchema.extend({
  securityQuestions: securityQuestionsPayloadSchema,
});

export const registerBrandWithSecurityQuestionsSchema = registerBrandSchema.extend({
  securityQuestions: securityQuestionsPayloadSchema,
});

export const forgotPasswordLookupSchema = z.object({
  mobile: mobile10Schema,
});

export const forgotPasswordVerifySchema = z.object({
  mobile: mobile10Schema,
  answers: z
    .array(
      z.object({
        questionId: questionIdSchema,
        answer: z.string().min(1).max(200),
      })
    )
    .length(3),
});

export const forgotPasswordResetSchema = z.object({
  mobile: mobile10Schema,
  answers: z
    .array(
      z.object({
        questionId: questionIdSchema,
        answer: z.string().min(1).max(200),
      })
    )
    .length(3),
  newPassword: strongPasswordSchema,
});
