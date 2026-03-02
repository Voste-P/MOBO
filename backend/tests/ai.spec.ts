import { generateChatUiResponse, verifyProofWithAi } from '../services/aiService.js';
import type { Env } from '../config/env.js';

describe('AI Service', () => {
  let env: Env;

  beforeAll(() => {
    // Mock environment - tests will skip if GEMINI_API_KEY is not set
    env = {
      NODE_ENV: 'test',
      PORT: 8080,
      JWT_ACCESS_SECRET: 'test-secret',
      JWT_REFRESH_SECRET: 'test-refresh-secret',
      JWT_ACCESS_TTL_SECONDS: 900,
      JWT_REFRESH_TTL_SECONDS: 2592000,
      CORS_ORIGINS: '',
      GEMINI_API_KEY: process.env.GEMINI_API_KEY || '',
    } as Env;
  });

  describe('generateChatUiResponse', () => {
    it('should handle chat request without API key gracefully', async () => {
      const envWithoutKey = { ...env, GEMINI_API_KEY: '' };

      await expect(
        generateChatUiResponse(envWithoutKey, {
          message: 'Hello',
          userName: 'Test User',
        })
      ).rejects.toThrow('Gemini is not configured');
    });

    it('should return structured response for greeting', { skip: !process.env.GEMINI_API_KEY }, async () => {
      const result = await generateChatUiResponse(env, {
        message: 'Hello',
        userName: 'Test User',
      });

      expect(result).toHaveProperty('text');
      expect(result).toHaveProperty('intent');
      expect(result.text).toBeTruthy();
      expect(['greeting', 'unknown']).toContain(result.intent);
    });

    it('should identify search intent', { skip: !process.env.GEMINI_API_KEY }, async () => {
      const result = await generateChatUiResponse(env, {
        message: 'Show me deals on shoes',
        userName: 'Test User',
        products: [
          {
            id: 'deal-1',
            title: 'Nike Running Shoes',
            price: 2999,
            originalPrice: 5999,
            platform: 'Amazon',
          },
          {
            id: 'deal-2',
            title: 'Laptop',
            price: 45000,
            originalPrice: 60000,
            platform: 'Flipkart',
          },
        ],
      });

      expect(result).toHaveProperty('text');
      // AI may classify as search_deals, recommend_deals, or unknown depending on model non-determinism
      expect(['search_deals', 'recommend_deals', 'unknown']).toContain(result.intent);
      // May or may not recommend products depending on AI interpretation
    });

    it('should handle empty message gracefully', { skip: !process.env.GEMINI_API_KEY }, async () => {
      const result = await generateChatUiResponse(env, {
        message: '',
        userName: 'Test User',
      });

      expect(result).toHaveProperty('text');
      expect(result).toHaveProperty('intent');
    });
  });

  describe('verifyProofWithAi', () => {
    it('should fall back to OCR verification when API key is missing', async () => {
      const envWithoutKey = { ...env, GEMINI_API_KEY: '' };

      // Simple base64 1x1 white pixel image
      const testImage = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA//2Q==';

      const result = await verifyProofWithAi(envWithoutKey, {
        imageBase64: testImage,
        expectedOrderId: 'ORD-123',
        expectedAmount: 1999,
      });

      // OCR fallback returns a result (not a throw) with low confidence for a blank image
      expect(result).toHaveProperty('orderIdMatch');
      expect(result).toHaveProperty('amountMatch');
      expect(result).toHaveProperty('confidenceScore');
      expect(typeof result.orderIdMatch).toBe('boolean');
    });

    it('should return structured verification result', { skip: !process.env.GEMINI_API_KEY }, async () => {
      // Simple base64 1x1 white pixel image (not a real receipt)
      const testImage = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAAAAAAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAv/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFQEBAQAAAAAAAAAAAAAAAAAAAAX/xAAUEQEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIRAxEAPwCwAA//2Q==';

      const result = await verifyProofWithAi(env, {
        imageBase64: testImage,
        expectedOrderId: 'ORD-123',
        expectedAmount: 1999,
      });

      expect(result).toHaveProperty('orderIdMatch');
      expect(result).toHaveProperty('amountMatch');
      expect(result).toHaveProperty('confidenceScore');
      expect(typeof result.orderIdMatch).toBe('boolean');
      expect(typeof result.amountMatch).toBe('boolean');
      expect(typeof result.confidenceScore).toBe('number');
      expect(result.confidenceScore).toBeGreaterThanOrEqual(0);
      expect(result.confidenceScore).toBeLessThanOrEqual(100);
    });

    it('should handle invalid base64 gracefully', {
      skip: !process.env.GEMINI_API_KEY || process.platform === 'win32',
      // Tesseract.js Worker emits uncaught exceptions on Windows for corrupt images.
    }, async () => {
      await expect(
        verifyProofWithAi(env, {
          imageBase64: 'invalid-base64',
          expectedOrderId: 'ORD-123',
          expectedAmount: 1999,
        })
      ).rejects.toThrow();
    });
  });
});
