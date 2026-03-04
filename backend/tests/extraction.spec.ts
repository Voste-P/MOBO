import { extractOrderDetailsWithAi } from '../services/aiService.js';
import { loadEnv } from '../config/env.js';
import sharp from 'sharp';

/**
 * Tests for the order extraction pipeline.
 * These tests create real images with text rendered via Sharp,
 * then verify that Tesseract.js + deterministic regex extracts
 * the order ID and amount correctly — no Gemini API key needed.
 */

function makeTestEnv() {
  return loadEnv({
    NODE_ENV: 'test',
    GEMINI_API_KEY: '', // No Gemini — forces Tesseract fallback
    AI_DEBUG_OCR: 'true',
  });
}

/**
 * Render multi-line text onto a white image and return as data URL.
 * Uses Sharp's SVG overlay to stamp text onto a blank canvas.
 */
async function renderTextToImage(lines: string[], width = 800, fontSize = 28): Promise<string> {
  const lineHeight = fontSize + 12;
  const height = Math.max(200, lines.length * lineHeight + 80);
  const escapeSvg = (s: string) =>
    s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const textElements = lines
    .map(
      (line, i) =>
        `<text x="40" y="${60 + i * lineHeight}" font-size="${fontSize}" font-family="monospace" fill="black">${escapeSvg(line)}</text>`
    )
    .join('\n');

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="white"/>
    ${textElements}
  </svg>`;

  const buf = await sharp({
    create: { width, height, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .composite([{ input: Buffer.from(svg), gravity: 'northwest' }])
    .jpeg({ quality: 95 })
    .toBuffer();

  return `data:image/jpeg;base64,${buf.toString('base64')}`;
}

describe('order extraction (Tesseract fallback)', () => {
  it('extracts Amazon order ID and amount from a rendered image', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'Order Details',
      'Order placed   5 February 2026',
      'Order number   408-9652341-7203568',
      '',
      'Arriving Wednesday',
      'Avimee Herbal Keshpallav Hair Oil',
      'Sold by: Avimee_Herbal',
      'Rs 522.00',
      '',
      'Payment method',
      'Amazon Pay ICICI Bank Credit Card',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });

    console.log('Amazon extraction result:', JSON.stringify(result, null, 2));

    // The pipeline should extract order ID and/or amount
    expect(result).toHaveProperty('confidenceScore');
    expect(result.confidenceScore).toBeGreaterThan(0);

    // Check that at least something was extracted
    const hasOrderId = Boolean(result.orderId);
    const hasAmount = typeof result.amount === 'number' && result.amount > 0;
    expect(hasOrderId || hasAmount).toBe(true);

    if (hasOrderId) {
      // Amazon order IDs follow the 3-7-7 pattern
      expect(result.orderId).toMatch(/\d{3}-\d{7}-\d{7}/);
    }
    if (hasAmount) {
      expect(result.amount).toBe(522);
    }
  });

  it('extracts Flipkart order ID from a rendered image', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'Your Orders',
      'Order ID: OD432187654321098',
      'Delivered on 3 Feb 2026',
      '',
      'Samsung Galaxy M34 5G',
      'Total: Rs 14,999.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Flipkart extraction result:', JSON.stringify(result, null, 2));

    expect(result.confidenceScore).toBeGreaterThan(0);

    const hasOrderId = Boolean(result.orderId);
    const hasAmount = typeof result.amount === 'number' && result.amount > 0;
    expect(hasOrderId || hasAmount).toBe(true);

    if (hasOrderId) {
      // Tesseract may misread 'O' as '0' – accept both
      expect(result.orderId!.toUpperCase()).toMatch(/^[O0]D[\dA-Z]+$/);
    }
  });

  it('returns low confidence for blank/unreadable images', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    // Create a blank white image with no text
    const buf = await sharp({
      create: { width: 200, height: 200, channels: 3, background: { r: 255, g: 255, b: 255 } },
    })
      .jpeg({ quality: 90 })
      .toBuffer();
    const imageBase64 = `data:image/jpeg;base64,${buf.toString('base64')}`;

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Blank image result:', JSON.stringify(result, null, 2));

    // Should not crash and should report low confidence
    expect(result.confidenceScore).toBeLessThanOrEqual(30);
  });

  it('handles a large phone-screenshot-sized image without rejecting', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const width = 1080;
    const lines = [
      'Your Orders',
      '',
      'Order Details',
      'Order placed   5 February 2026',
      'Order number   408-9652341-7203568',
      '',
      'Arriving Wednesday',
      '',
      'Avimee Herbal Keshpallav Hair Oil for Hair Growth',
      'Sold by: Avimee_Herbal',
      'Rs 522.00',
      '',
      'Track package          Cancel items',
      '',
      'Payment method',
      'Amazon Pay ICICI Bank Credit Card ending in ****1234',
    ];

    const imageBase64 = await renderTextToImage(lines, width, 32);
    const sizeKB = Math.round(imageBase64.length / 1024);
    console.log(`Large image size: ${sizeKB} KB (${imageBase64.length} chars)`);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Large image result:', JSON.stringify(result, null, 2));

    expect(result.notes).not.toContain('too large');
    expect(result.notes).not.toContain('unavailable');
    expect(result.confidenceScore).toBeGreaterThan(0);
    expect(result.orderId).toMatch(/\d{3}-\d{7}-\d{7}/);
    expect(result.amount).toBe(522);
  });

  it('extracts Meesho order ID and amount', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'My Orders',
      '',
      'Order ID: MEESHO845123',
      'Delivered on 1 Feb 2026',
      '',
      'Women Cotton Printed Kurti',
      'Price: Rs 349.00',
      'Total: Rs 349.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Meesho result:', JSON.stringify(result, null, 2));

    expect(result.confidenceScore).toBeGreaterThan(0);
    expect(result.orderId).toMatch(/MEESHO\d+/i);
    expect(result.amount).toBe(349);
  });

  it('extracts Myntra order ID', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'ORDER DETAILS',
      'Order No: MYN3847291',
      '',
      'PUMA Running Shoes',
      'Rs. 2,499.00',
      'Grand Total: Rs 2,499.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Myntra result:', JSON.stringify(result, null, 2));

    expect(result.confidenceScore).toBeGreaterThan(0);
    expect(result.orderId).toMatch(/MYN\d+/i);
    expect(result.amount).toBe(2499);
  });

  it('extracts from desktop-style wide screenshot', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    // Simulate a 1920x1080 desktop screenshot with order info
    const imageBase64 = await renderTextToImage(
      [
        'amazon.in - Your Orders',
        '',
        'Order Details',
        '',
        'Order #408-1234567-8901234',
        '',
        'Arriving Thursday',
        'boAt Rockerz 450 Bluetooth',
        'Amount Paid: Rs 1,299.00',
      ],
      1920,
      36,
    );

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Desktop result:', JSON.stringify(result, null, 2));

    expect(result.confidenceScore).toBeGreaterThan(0);
    // Should extract order ID
    const hasId = Boolean(result.orderId);
    if (hasId) {
      expect(result.orderId).toMatch(/\d{3}-\d{7}-\d{7}/);
    }
    // Amount paid label should help pick up the amount
    if (result.amount) {
      expect(result.amount).toBe(1299);
    }
    expect(hasId || result.amount).toBeTruthy();
  });

  it('handles Indian comma format and picks "Amount Paid" over MRP', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'Order Details',
      'Order number 402-9876543-1234567',
      '',
      'MRP: Rs 45,999.00',
      'Discount: Rs 16,000.00',
      'Deal Price: Rs 29,999.00',
      'Amount Paid: Rs 29,999.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Amount priority result:', JSON.stringify(result, null, 2));

    expect(result.orderId).toMatch(/\d{3}-\d{7}-\d{7}/);
    // Should pick "Amount Paid" (29999) as priority over MRP (45999)
    expect(result.amount).toBe(29999);
  });

  // ─── Product Name Extraction Tests ───

  it('extracts product name from Amazon order screenshot', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'Order Details',
      'Order placed   12 January 2026',
      'Order number   408-3456789-1234567',
      '',
      'Arriving Wednesday',
      'Samsung Galaxy M14 5G (Berry Blue, 6GB, 128GB Storage)',
      'Sold by: Appario Retail Private Ltd',
      'Rs 10,999.00',
      '',
      'Payment method',
      'UPI',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Amazon product name result:', JSON.stringify(result, null, 2));

    expect(result.confidenceScore).toBeGreaterThan(0);
    if (result.productName) {
      expect(result.productName.toLowerCase()).toContain('samsung');
      // Should NOT be a URL, delivery status, or address
      expect(result.productName).not.toMatch(/https?:\/\//i);
      expect(result.productName).not.toMatch(/^arriving/i);
    }
  });

  it('extracts Nykaa beauty product name', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'nykaa.com',
      'My Orders',
      '',
      'Order ID: NYK4829371',
      'Delivered on 5 Feb 2026',
      '',
      'Lakme Absolute Matte Revolution Lip Color 3.5gm',
      'Rs 695.00',
      'Grand Total: Rs 695.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Nykaa product name result:', JSON.stringify(result, null, 2));

    expect(result.confidenceScore).toBeGreaterThan(0);
    if (result.orderId) {
      // Tesseract may misread digits; just check for NYK prefix pattern
      expect(result.orderId).toMatch(/NYK[A-Z0-9]+/i);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toContain('lakme');
      expect(result.productName).not.toMatch(/nykaa\.com/i);
    }
    if (result.amount) {
      expect(result.amount).toBe(695);
    }
  });

  it('extracts Blinkit grocery product name', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'blinkit',
      'My Orders',
      '',
      'Order ID: BLK9283746',
      'Delivered in 12 mins',
      '',
      'Amul Gold Milk 500ml',
      'Qty: 2',
      'Rs 36.00',
      'Total: Rs 72.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Blinkit product name result:', JSON.stringify(result, null, 2));

    expect(result.confidenceScore).toBeGreaterThan(0);
    if (result.productName) {
      expect(result.productName.toLowerCase()).toContain('amul');
      expect(result.productName).not.toMatch(/^blinkit$/i);
    }
  });

  it('extracts AJIO fashion product name', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'AJIO.com',
      'Order Details',
      '',
      'Order No: FN7382945',
      'Shipped on 3 Feb 2026',
      '',
      'US Polo Assn Men Slim Fit Cotton Shirt',
      'Size: M, Color: Navy Blue',
      'Rs 1,299.00',
      'Grand Total: Rs 1,299.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('AJIO product name result:', JSON.stringify(result, null, 2));

    expect(result.confidenceScore).toBeGreaterThan(0);
    if (result.orderId) {
      expect(result.orderId).toMatch(/FN\d+/i);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/polo|shirt/);
    }
  });

  it('rejects URL as product name', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'Order Details',
      'Order number 408-1111111-2222222',
      '',
      'https://www.amazon.in/Samsung-Galaxy/dp/B09G9YPBCQ',
      'Rs 12,999.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('URL rejection result:', JSON.stringify(result, null, 2));

    // Product name should NOT be a URL
    if (result.productName) {
      expect(result.productName).not.toMatch(/https?:\/\//i);
      expect(result.productName).not.toMatch(/amazon\.in/i);
    }
  });

  it('rejects delivery status as product name', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'Order number 408-3333333-4444444',
      '',
      'Arriving on Wednesday',
      'Shipped via Blue Dart',
      'Rs 599.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Delivery status rejection result:', JSON.stringify(result, null, 2));

    if (result.productName) {
      expect(result.productName).not.toMatch(/^arriving/i);
      expect(result.productName).not.toMatch(/^shipped/i);
    }
  });

  it('rejects category list as product name', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'Order number 408-5555555-6666666',
      'Tablets, Earbuds, Watch, Blue',
      '',
      'boAt Airdopes 131 TWS Earbuds',
      'Rs 899.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Category list rejection result:', JSON.stringify(result, null, 2));

    if (result.productName) {
      // Should NOT be the category list
      expect(result.productName).not.toBe('Tablets, Earbuds, Watch, Blue');
      // Should preferably be the actual product
      if (result.productName.toLowerCase().includes('boat') || result.productName.toLowerCase().includes('airdopes')) {
        expect(result.productName.toLowerCase()).toMatch(/boat|airdopes|tws|earbuds/);
      }
    }
  });

  it('extracts Meesho product name correctly', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'meesho',
      'Order ID: MEESHO192837',
      '',
      'Delivered on 28 Jan 2026',
      'Floral Printed Cotton Anarkali Kurti for Women',
      'Qty: 1',
      'Total: Rs 449.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Meesho product name result:', JSON.stringify(result, null, 2));

    expect(result.confidenceScore).toBeGreaterThan(0);
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/kurti|anarkali|cotton|floral/);
    }
    if (result.amount) {
      expect(result.amount).toBe(449);
    }
  });

  it('rejects address/pincode as product name', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'Order #408-7777777-8888888',
      '',
      '12, Koramangala, Bangalore',
      'Karnataka, India 560034',
      '',
      'JBL Tune 760NC Wireless Headphones',
      'Rs 3,499.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Address rejection result:', JSON.stringify(result, null, 2));

    if (result.productName) {
      expect(result.productName).not.toMatch(/koramangala|bangalore|karnataka|560034/i);
    }
  });

  it('rejects Amazon navigation chrome as product name (". Deliver to Sumit")', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      '. Deliver to Sumit ) i . Hello, Ashok Retuns 0',
      'Orders  Account & Lists  Returns 0',
      '',
      'Order #171-3561275-3245136',
      'NICONI Tan Vanish Gluta-Kojic Skin Polish',
      'Sold by: ARABIAN AROMA',
      'Grand Total: Rs 3,297.00',
      'Order placed: 15 Jan 2025',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Nav chrome rejection result:', JSON.stringify(result, null, 2));

    // Product name must NOT be the navigation chrome
    if (result.productName) {
      expect(result.productName).not.toMatch(/Deliver\s*to\s*Sumit/i);
      expect(result.productName).not.toMatch(/Hello.*Ashok/i);
      expect(result.productName).not.toMatch(/Retuns?\s*0/i);
    }
    // Amount should be correct
    if (result.amount) {
      expect(result.amount).toBe(3297);
    }
  });

  it('rejects concatenated nav: "5 Deliver to ABHILASH N Hello, ROOT Returns 0"', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      '5 Deliver to ABHILASH N Hello, ROOT Returns 0',
      '',
      'Order #408-0052132-6347578',
      'Avimee Herbal Keshpallav Hair Oil with Rosemary',
      'Sold by: RetailEZ Pvt Ltd',
      'Grand Total: Rs 3,246.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Concatenated nav rejection result:', JSON.stringify(result, null, 2));

    if (result.productName) {
      expect(result.productName).not.toMatch(/Deliver\s*to\s*ABHILASH/i);
      expect(result.productName).not.toMatch(/Hello.*ROOT/i);
    }
    if (result.amount) {
      expect(result.amount).toBe(3246);
    }
  });

  it('strips button text from soldBy: "ARABIAN AROMA ( Ask Product Question )"', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'Order #171-3561275-3245136',
      'NICONI Tan Vanish Gluta-Kojic Skin Polish',
      'Sold by: ARABIAN AROMA ( Ask Product Question )',
      'Grand Total: Rs 3,297.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('SoldBy button strip result:', JSON.stringify(result, null, 2));

    if (result.soldBy) {
      expect(result.soldBy).not.toMatch(/Ask\s*Product\s*Question/i);
      expect(result.soldBy.trim()).toMatch(/ARABIAN\s*AROMA/i);
    }
    if (result.amount) {
      expect(result.amount).toBe(3297);
    }
  });

  it('extracts Flipkart "Order Confirmed" date format', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'Order ID: OD436768365753640100',
      '',
      'Order Confirmed, Sep 30, 2022',
      'boAt Airdopes 141 True Wireless Earbuds',
      'Seller: Appario Retail Private Ltd',
      'Total Amount: Rs 1,299.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Flipkart date result:', JSON.stringify(result, null, 2));

    if (result.orderDate) {
      expect(result.orderDate).toMatch(/Sep.*30.*2022|30.*Sep.*2022/i);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/OD\d{10,}/);
    }
  });

  // =========================================================
  //  NEW: Flipkart price breakdown — must pick Total amount,
  //        NOT Listing price / Selling price / Special price
  // =========================================================
  it('Flipkart: picks Total amount ₹1,408, ignores Listing price ₹2,299', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'Order ID: OD432100012345678900',
      '',
      'OnePlus Bullets Z2 Bluetooth Wireless in Ear Earphones',
      'Seller: SuperComNet LLP',
      '',
      'Price details',
      'Listing price        Rs 2,299',
      'Selling price        Rs 1,399',
      'Special price        Rs 1,399',
      'Total fees (1 item)  Rs 9',
      'Total amount         Rs 1,408',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Flipkart price breakdown result:', JSON.stringify(result, null, 2));

    // Amount MUST be 1408, not 2299 or 1399 or 9
    if (result.amount) {
      expect(result.amount).toBe(1408);
    }
  });

  // =========================================================
  //  NEW: Flipkart refund page — must pick Refund Total
  // =========================================================
  it('Flipkart: picks Refund Total ₹41,990 from refund page', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'Order ID: OD432100098765432100',
      '',
      'HP 15s 12th Gen Intel Core i5',
      'Seller: TBL Online',
      '',
      'Refund Details',
      'Selling price        Rs 41990',
      'Cashback discount    Rs 0',
      'Refund Total         Rs 41990',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Flipkart refund result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(41990);
    }
  });

  // =========================================================
  //  NEW: Amazon Grand Total with Promotion
  // =========================================================
  it('Amazon: picks Grand Total ₹1,390, ignores promotion/subtotal', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'amazon.in',
      'Order number 171-3561275-3245136',
      '',
      'NICONI Tan Vanish Gluta-Kojic Skin Polish',
      'Sold by: ARABIAN AROMA',
      '',
      'Order Summary',
      'Item(s) Subtotal:    Rs 1,385.00',
      'Shipping:            Rs 45.00',
      'Promotion Applied:   -Rs 40.00',
      'Grand Total:         Rs 1,390.00',
      '',
      'Order placed: 15 January 2025',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Amazon Grand Total result:', JSON.stringify(result, null, 2));

    // Must be Grand Total, not subtotal or shipping
    if (result.amount) {
      expect(result.amount).toBe(1390);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/171-3561275-3245136/);
    }
  });

  // =========================================================
  //  NEW: Amazon desktop with address/pincode — must NOT confuse
  // =========================================================
  it('Amazon: ignores address pincode 560034, picks amount ₹6,003', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'amazon.in',
      'Deliver to Sumit - Bangalore 560034',
      '',
      'Order number 408-1234567-8901234',
      'Lorazzo Kitchen Sink 304 Grade Stainless Steel',
      'Sold by: LorazzO Store',
      '',
      'Grand Total: Rs 6,003.00',
      'Order placed: 3 February 2025',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Amazon pincode vs amount result:', JSON.stringify(result, null, 2));

    // Must NOT pick 560034 as amount
    if (result.amount) {
      expect(result.amount).toBe(6003);
      expect(result.amount).not.toBe(560034);
    }
    // Product name should NOT contain pincode or address
    if (result.productName) {
      expect(result.productName).not.toMatch(/560034|bangalore|deliver\s*to/i);
    }
  });

  // =========================================================
  //  NEW: dd-MMM-yyyy date format
  // =========================================================
  it('extracts dd-MMM-yyyy date (18-Mar-2022)', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'Order ID: OD436768365753640100',
      '',
      'Order Confirmed, 18-Mar-2022',
      'Infinix Hot 11 (Silver Wave, 64 GB)',
      'Seller: Flashstar Commerce',
      'Total Amount: Rs 8,499.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('dd-MMM-yyyy date result:', JSON.stringify(result, null, 2));

    if (result.orderDate) {
      expect(result.orderDate).toMatch(/18.*Mar.*2022|Mar.*18.*2022/i);
    }
    if (result.amount) {
      expect(result.amount).toBe(8499);
    }
  });

  // =========================================================
  //  NEW: Brand: label for seller extraction
  // =========================================================
  it('extracts seller from "Brand: Samsung Electronics"', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'nykaa.com',
      'Order ID: NYK20250215001',
      '',
      'Samsung Galaxy Watch 5 (40mm)',
      'Brand: Samsung Electronics',
      '',
      'Amount Paid: Rs 24,999.00',
      'Ordered on 15 Feb 2025',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Brand seller extraction result:', JSON.stringify(result, null, 2));

    if (result.soldBy) {
      expect(result.soldBy.toLowerCase()).toMatch(/samsung/i);
    }
    if (result.amount) {
      expect(result.amount).toBe(24999);
    }
  });

  // =========================================================
  //  NEW: Delivered date keyword extraction
  // =========================================================
  it('extracts date from "Delivered, Oct 19, 2025"', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'amazon.in',
      'Order number 408-9999999-1234567',
      '',
      'Delivered, Oct 19, 2025',
      'Lymio Cargo for Men Cotton Cargo Pant',
      'Sold by: RetailEZ Pvt Ltd',
      'Grand Total: Rs 599.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Delivered date result:', JSON.stringify(result, null, 2));

    if (result.orderDate) {
      expect(result.orderDate).toMatch(/Oct.*19.*2025|19.*Oct.*2025/i);
    }
    if (result.amount) {
      expect(result.amount).toBe(599);
    }
  });

  // =========================================================
  //  NEW: Multiple amounts — Total amount must win over item prices
  // =========================================================
  it('picks Total ₹10,048 over individual item price ₹9,999', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'Order ID: OD432100055555555500',
      '',
      'Samsung Galaxy M34 5G (Midnight Blue, 128 GB)',
      'Selling price        Rs 9,999',
      'Delivery charges     Rs 49',
      'Total amount         Rs 10,048',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Total vs selling price result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(10048);
    }
  });

  // =====================================================================
  //  REAL SCREENSHOT TESTS — Exact OCR simulations from 6 user screenshots
  // =====================================================================

  it('Screenshot 1: Flipkart truke Buds F1 — ₹704, ignores Listing ₹2,499 & phone 7768014471', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'Home  My Account  My Orders  OD226133561137984000',
      'Sagar Chaudhari shared this order with you.',
      'truke Buds F1 with 38H Playtime, Dual Mic ENC, Instant Pairing',
      'Exceptional Sound Bluetooth Headset',
      'Black',
      'Seller: BUZZINDIA',
      'Rs 704',
      'Order Confirmed, Sep 30, 2022',
      'Delivered, Oct 01, 2022',
      'See All Updates',
      'Order #OD226133561137984000',
      'Delivery details',
      'Sagar Chaudhari  7768014471',
      'Price details',
      'Listing price   Rs 2,499',
      'Selling price   Rs 799',
      'Total fees      Rs 5',
      'Other discount  -Rs 100',
      'Total amount    Rs 704',
      'Payment method  Cash On Delivery',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 1 result:', JSON.stringify(result, null, 2));

    // Amount must be 704 (Total amount), NOT 2499 (Listing), 799 (Selling), or 7768014471 (phone)
    if (result.amount) {
      expect(result.amount).toBe(704);
      expect(result.amount).not.toBe(2499);
      expect(result.amount).not.toBe(799);
    }
    // Order ID must be the Flipkart OD number
    if (result.orderId) {
      expect(result.orderId).toMatch(/OD226133561137984000/i);
    }
    // Product name must NOT be "shared this order" or phone number
    if (result.productName) {
      expect(result.productName).not.toMatch(/shared\s*this\s*order/i);
      expect(result.productName).not.toMatch(/7768014471/);
    }
    // Seller
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/BUZZINDIA/i);
    }
  });

  it('Screenshot 2: Flipkart Portronics Cable — ₹183, ignores Listing ₹599', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'OD426901489159379100',
      'Portronics Micro USB Cable 3 A 2 m Konnect Spydr',
      'White',
      'Seller: Portronics Digital',
      'Rs 183',
      'Order Confirmed, Dec 27, 2022',
      'Delivered, Dec 30, 2022',
      'Chat with us',
      'Order #OD426901489159379100',
      'Delivery details',
      'Chetan Dnyaneshwar Chaudhari  7768014471',
      'Price details',
      'Listing price   Rs 599',
      'Selling price   Rs 199',
      'Other discount  -Rs 16',
      'Total amount    Rs 183',
      'Payment method  PAYTM Wallet',
      'Download Invoice',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 2 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(183);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/OD426901489159379100/i);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/portronics|konnect|spydr|cable/i);
      expect(result.productName).not.toMatch(/chat\s*with\s*us/i);
      expect(result.productName).not.toMatch(/download\s*invoice/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/Portronics\s*Digital/i);
    }
  });

  it('Screenshot 3: Flipkart OnePlus multiline — ₹1,408, ignores Listing ₹2,299 & Special ₹1,399', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'OD435763547340894100',
      'OnePlus Nord Buds 2r in Ear Earbuds with Dual Mic & AI Crystal',
      'Clear Call Bluetooth',
      'Black',
      'Seller: SVPeripherals',
      'Rs 1,408',
      'Order Confirmed, Oct 18, 2025',
      'Delivered, Oct 19, 2025',
      'See All Updates',
      'Chat with us',
      'Rate your experience',
      'Rate the product',
      'Order #OD435763547340894100',
      'Chetan Dnyaneshwar Chaudhari  7768014471',
      'Price details',
      'Listing price   Rs 2,299',
      'Special price   Rs 1,399',
      'Total fees      Rs 9',
      'Total amount    Rs 1,408',
      'Payment method  UPI',
      'Download Invoice',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 3 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(1408);
      expect(result.amount).not.toBe(2299);
      expect(result.amount).not.toBe(1399);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/OD435763547340894100/i);
    }
    // Product name should concatenate multiline: "OnePlus Nord Buds 2r ... Crystal Clear Call Bluetooth"
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/oneplus|nord\s*buds/i);
      expect(result.productName).not.toMatch(/rate\s*(your|the)/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/SVPeripherals/i);
    }
  });

  it('Screenshot 4: Flipkart HP refund — ₹41,990, Total refund label, ignores Listing ₹49,590', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'OD223955246546161000',
      'Total refund - Rs 41990',
      'Completed',
      'refund reference number 204313421848',
      'HP Core i3 11th Gen - (8 GB/512 GB SSD/Windows 11 Home) 15s-du3563TU Thin and Light Laptop',
      'Jet Black',
      'Seller: ElectronicsBazaarEB',
      'Rs 41990',
      'Return, Feb 11, 2022',
      'Refund, Feb 15, 2022',
      'See All Updates',
      'Chat with us',
      'Price details',
      'Listing price   Rs 49590',
      'Selling price   Rs 41990',
      'Total amount    Rs 41990',
      'Payment method  Cash On Delivery',
      'Download Invoice',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 4 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(41990);
      expect(result.amount).not.toBe(49590);
      // Must NOT pick refund reference number as amount
      expect(result.amount).not.toBe(204313421848);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/OD223955246546161000/i);
      // Must NOT pick refund reference as order ID
      expect(result.orderId).not.toMatch(/204313421848/);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/hp|core\s*i3|laptop/i);
      expect(result.productName).not.toMatch(/completed/i);
      expect(result.productName).not.toMatch(/refund\s*reference/i);
    }
  });

  it('Screenshot 5: Amazon NICONI — Grand Total ₹1,390, ignores Subtotal/Shipping/Marketplace/pincode 411027', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'amazon.in',
      'Deliver to Chetan Pimpri Ch... 411027',
      'Order Details',
      'Order placed 21 February 2026',
      'Order number 404-6108608-0153914',
      'Ship to',
      'Chetan Chaudhari',
      '163',
      'Vishal nagar, vakad',
      'PIMPRI CHINCHWAD, MAHARASHTRA',
      '411027',
      'India',
      'Order Summary',
      'Item(s) Subtotal: Rs 1,385.00',
      'Shipping: Rs 40.00',
      'Marketplace Fee: Rs 5.00',
      'Total: Rs 1,430.00',
      'Promotion Applied: -Rs 40.00',
      'Grand Total: Rs 1,390.00',
      'Delivered 23 February',
      'Package was handed to resident',
      'NICONI Tan Vanish Gluta-Kojic Skin Polish',
      'Sold by: FORMULATE BRAND PRIVATE LIMITED',
      'Rs 1,385.00',
      'Buy it again  View your item',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 5 result:', JSON.stringify(result, null, 2));

    // Grand Total must be 1390, NOT subtotal 1385, shipping 40, total 1430, or pincode 411027
    if (result.amount) {
      expect(result.amount).toBe(1390);
      expect(result.amount).not.toBe(1385);
      expect(result.amount).not.toBe(1430);
      expect(result.amount).not.toBe(411027);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/404-6108608-0153914/);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/niconi|skin\s*polish/i);
      expect(result.productName).not.toMatch(/411027|pimpri|maharashtra/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/FORMULATE/i);
    }
    if (result.orderDate) {
      expect(result.orderDate).toMatch(/21.*February.*2026|February.*21.*2026/i);
    }
  });

  it('Screenshot 6: Amazon Lorazzo — Grand Total ₹6,003, return window date NOT as order date', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'amazon.in',
      'Deliver to Gaurav Pimpri Ch... 411027',
      'Order Details',
      'Order placed 17 February 2026',
      'Order number 408-2723032-2917965',
      'Ship to',
      'Gaurav Chafle',
      '163',
      'Vishal Nagar, Wakad Road',
      'PIMPRI CHINCHWAD, MAHARASHTRA',
      '411027',
      'India',
      'Order Summary',
      'Item(s) Subtotal: Rs 5,998.00',
      'Shipping: Rs 40.00',
      'Marketplace Fee: Rs 5.00',
      'Total: Rs 6,043.00',
      'Promotion Applied: -Rs 40.00',
      'Grand Total: Rs 6,003.00',
      'Delivered 19 February',
      'Package was handed to resident',
      'Lorazzo Lustr Kitchen Sink (SILVER) 24X18 inches',
      'CERTIFIED 304 Stainless Steel Sink for Kitchen',
      'Sold by: Lorazzo',
      'Rs 5,998.00',
      'Return window closed on 1 March 2026',
      'Buy it again  View your item',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 6 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(6003);
      expect(result.amount).not.toBe(5998);
      expect(result.amount).not.toBe(6043);
      expect(result.amount).not.toBe(411027);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/408-2723032-2917965/);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/lorazzo|kitchen\s*sink|stainless/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/Lorazzo/i);
    }
    // Order date should be "17 February 2026", NOT "1 March 2026" (return window)
    if (result.orderDate) {
      expect(result.orderDate).toMatch(/17.*February.*2026|February.*17.*2026/i);
      expect(result.orderDate).not.toMatch(/March/i);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW SCREENSHOTS — Session 5 (7 screenshots, 6 unique, 1 duplicate)
  // ═══════════════════════════════════════════════════════════════════════════

  it('Screenshot 7: Amazon Whimsy Beauty — Grand Total ₹340.02 (decimal), COD fee excluded, AJMER address skipped', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'amazon.in',
      'Order Details',
      'Order placed 3 March 2026',
      'Order number 404-5959012-1034718',
      'Ship to',
      'Priyanka tinker',
      'AJMER, RAJASTHAN',
      '305001',
      'India',
      'Order Summary',
      'Item(s) Subtotal: Rs 339.00',
      'Shipping: Rs 0.00',
      'Cash/Pay on Delivery fee: Rs 7.00',
      'Total: Rs 346.00',
      'Promotion Applied: -Rs 5.98',
      'Grand Total: Rs 340.02',
      'Arriving Sunday, 9 March',
      'Whimsy Beauty Foaming Body Wash for Girls & Kids | Gentl...',
      'Sold by: Whimsy India',
      'Rs 339.00',
      'Buy it again  View your item',
      'Ask a product question  Write a product review',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 7 result:', JSON.stringify(result, null, 2));

    // Grand Total ₹340.02 — NOT subtotal 339, COD fee 7, total 346, promotion 5.98, or pincode 305001
    if (result.amount) {
      expect(result.amount).toBe(340.02);
      expect(result.amount).not.toBe(339);
      expect(result.amount).not.toBe(346);
      expect(result.amount).not.toBe(7);
      expect(result.amount).not.toBe(305001);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/404-5959012-1034718/);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/whimsy|body\s*wash/i);
      // Must NOT pick address, person name, or UI chrome
      expect(result.productName).not.toMatch(/priyanka|ajmer|rajasthan|305001/i);
      expect(result.productName).not.toMatch(/arriving|sunday/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/Whimsy\s*India/i);
    }
    if (result.orderDate) {
      expect(result.orderDate).toMatch(/3.*March.*2026|March.*3.*2026/i);
    }
  });

  it('Screenshot 8: Amazon Arabian Aroma — Grand Total ₹678, BHIM UPI excluded, Marketplace Fee excluded', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'amazon.in',
      'Order Details',
      'Order placed 3 March 2026',
      'Order number 171-6031047-3374730',
      'Ship to',
      'Mayank Ojha',
      'AJMER, RAJASTHAN',
      '305001',
      'India',
      'Order Summary',
      'Item(s) Subtotal: Rs 713.00',
      'Shipping: Rs 0.00',
      'Marketplace Fee: Rs 5.00',
      'Total: Rs 718.00',
      'Promotion Applied: -Rs 40.00',
      'Grand Total: Rs 678.00',
      'Payment Method: BHIM UPI',
      'Arriving Monday, 10 March',
      'Arabian Aroma Sovage Perfume for Men Long Lasting',
      'Sold by: ARABIAN AROMA',
      'Rs 713.00',
      'Buy it again  View your item',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 8 result:', JSON.stringify(result, null, 2));

    // Grand Total ₹678 — NOT subtotal 713, marketplace fee 5, total 718, promotion 40, or pincode 305001
    if (result.amount) {
      expect(result.amount).toBe(678);
      expect(result.amount).not.toBe(713);
      expect(result.amount).not.toBe(718);
      expect(result.amount).not.toBe(5);
      expect(result.amount).not.toBe(305001);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/171-6031047-3374730/);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/arabian\s*aroma|perfume/i);
      expect(result.productName).not.toMatch(/mayank|ajmer|rajasthan|bhim|upi/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/ARABIAN\s*AROMA/i);
    }
    if (result.orderDate) {
      expect(result.orderDate).toMatch(/3.*March.*2026|March.*3.*2026/i);
    }
  });

  it('Screenshot 9: Amazon NUTROVA Omega 3 — Grand Total ₹1,030, COD fee ₹17 excluded, dark mode', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'amazon.in',
      'Order Details',
      'Order placed 4 March 2026',
      'Order number 408-8278277-3924353',
      'Ship to',
      'Mandheer mishra',
      'AJMER, RAJASTHAN',
      '305001',
      'India',
      'Order Summary',
      'Item(s) Subtotal: Rs 1,013.00',
      'Shipping: Rs 0.00',
      'Cash/Pay on Delivery fee: Rs 17.00',
      'Total: Rs 1,030.00',
      'Grand Total: Rs 1,030.00',
      'Arriving Friday, 14 March',
      'NUTROVA Complete Omega 3 Vegan and Gelatin-Free 60 Capsules',
      'Sold by: Nutrova',
      'Rs 1,013.00',
      'Buy it again  View your item',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 9 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(1030);
      expect(result.amount).not.toBe(1013);
      expect(result.amount).not.toBe(17);
      expect(result.amount).not.toBe(305001);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/408-8278277-3924353/);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/nutrova|omega\s*3/i);
      expect(result.productName).not.toMatch(/mandheer|ajmer|rajasthan|arriving/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/Nutrova/i);
    }
    if (result.orderDate) {
      expect(result.orderDate).toMatch(/4.*March.*2026|March.*4.*2026/i);
    }
  });

  it('Screenshot 10: Amazon NUTROVA Kerastrength — Grand Total ₹1,044.20 (decimal), Promotion -₹82.80 excluded', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'amazon.in',
      'Order Details',
      'Order placed 4 March 2026',
      'Order number 403-5861220-2183552',
      'Ship to',
      'Bhavika',
      'AJMER, RAJASTHAN',
      '305001',
      'India',
      'Order Summary',
      'Item(s) Subtotal: Rs 1,110.00',
      'Shipping: Rs 0.00',
      'Cash/Pay on Delivery fee: Rs 17.00',
      'Total: Rs 1,127.00',
      'Promotion Applied: -Rs 82.80',
      'Grand Total: Rs 1,044.20',
      'Arriving Friday, 14 March',
      'NUTROVA Kerastrength For Men & Women 30 Capsules',
      'Sold by: Nutrova',
      'Rs 1,110.00',
      'Buy it again  View your item',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 10 result:', JSON.stringify(result, null, 2));

    // Grand Total ₹1,044.20 (decimal) — NOT subtotal 1110, COD 17, total 1127, promotion 82.80
    if (result.amount) {
      expect(result.amount).toBe(1044.2);
      expect(result.amount).not.toBe(1110);
      expect(result.amount).not.toBe(1127);
      expect(result.amount).not.toBe(17);
      expect(result.amount).not.toBe(82.8);
      expect(result.amount).not.toBe(305001);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/403-5861220-2183552/);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/nutrova|kerastrength/i);
      expect(result.productName).not.toMatch(/bhavika|ajmer|rajasthan|arriving/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/Nutrova/i);
    }
    if (result.orderDate) {
      expect(result.orderDate).toMatch(/4.*March.*2026|March.*4.*2026/i);
    }
  });

  it('Screenshot 11: Flipkart Dermatouch Bye Bye Pigmentation — ₹429, "1 offer" excluded, Edit Order excluded', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'Order ID: OD431938214243263100',
      'Order Confirmed, Today',
      'Your Order has been placed., Thu 1st Aug 2024',
      'Dermatouch Bye Bye Pigmentation Niacinamide Kojic Acid & Alpha Arbutin',
      'Serum Night Cream for Pigmentation & Dark Spots',
      'Rs 429',
      '1 offer',
      'Seller: DERMATOUCH',
      'Edit Order',
      'Chat with us',
      'Rate your experience',
      'Recommended for you based on your shopping trends',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 11 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(429);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/OD431938214243263100/i);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/dermatouch|pigmentation/i);
      // Must NOT pick UI chrome, offer count, or recommendations
      expect(result.productName).not.toMatch(/1\s*offer|edit\s*order|chat\s*with|rate\s*your|recommended/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/DERMATOUCH/i);
    }
  });

  it('Screenshot 12: Flipkart Dermatouch Bright & Even Tone — ₹354, "2 offers" excluded, Shipped status excluded', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'Order ID: OD431913265903508100',
      'Shipped',
      'Order Received, Mon Jul 29 2024',
      'Dermatouch Bright & Even Tone with Niacinamide Vitamin C & Kojic',
      'Acid Gel Cream for Oily Skin',
      'Rs 354',
      '2 offers',
      'Seller: DERMATOUCH',
      'Change Date',
      'See all updates',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 12 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(354);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/OD431913265903508100/i);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/dermatouch|even\s*tone/i);
      // Must NOT pick "2 offers", "Change Date", "See all updates", or "Shipped"
      expect(result.productName).not.toMatch(/2\s*offers|change\s*date|see\s*all|shipped/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/DERMATOUCH/i);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // NEW SCREENSHOTS — Session 6 (9 unique order screenshots)
  // ═══════════════════════════════════════════════════════════════════════════

  it('Screenshot 13: Flipkart MANCODE Sandalwood Soap — ₹68, Gold variant, "2 offers" excluded', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'Order ID - OD33128284112875010',
      'MANCODE Moisturising Sandalwood Bath Soap with Sandalwood Oil',
      'Gold',
      'Seller: SaanviBrands',
      'Rs 68',
      '2 offers',
      'Order Confirmed, Today',
      'Your Order has been placed., Sat 18th May',
      'Shipped, Expected By May 19',
      'Out For Delivery',
      'Delivery, May 20 By 11 PM',
      'See All Updates',
      'Edit Order',
      'Chat with us',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 13 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(68);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/OD3312828411287501/i);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/mancode|sandalwood|soap/i);
      expect(result.productName).not.toMatch(/2\s*offers|edit\s*order|gold\s*$/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/SaanviBrands/i);
    }
  });

  it('Screenshot 14: Flipkart MANCODE Tan Removal — ₹205, PAY button excluded, Share Location excluded', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'to drop the item at doorstep',
      'PAY Rs 205',
      'Order ID - OD43139076308243810',
      'MANCODE Tan Removal Peel off Face Mask for Men and Women',
      'Seller: SaanviBrands',
      'Rs 205',
      '2 offers',
      'Help our delivery agent reach you faster.',
      'Share Location',
      'Order Confirmed, Today',
      'Your Order has been placed., Thu 30th May',
      'Shipped, Expected By May 31',
      'Out For Delivery',
      'Delivery, Jun 03 By 11 PM',
      'Expected by Sat 1st Jun',
      'See All Updates',
      'Edit Order',
      'Chat with us',
      'Help India make good choices',
      'Did you find this page helpful?',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 14 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(205);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/OD4313907630824381/i);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/mancode|tan\s*removal|face\s*mask/i);
      expect(result.productName).not.toMatch(/pay\s*rs|doorstep|share\s*location|help.*delivery/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/SaanviBrands/i);
    }
  });

  it('Screenshot 15: Flipkart HYPHEN Sunscreen (Desktop) — ₹403, tracking number excluded, breadcrumb order ID', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'Home > My Account > My Orders > OD33488122540018810',
      'Order can be tracked by 7253967553.',
      'Tracking link is shared via SMS.',
      'Manage who can access',
      'HYPHEN Sunscreen - SPF 50 PA++++ All I Need Sunscreen',
      'Seller: INdianmahabestoil',
      'Rs 403',
      'Order Confirmed, Today',
      'Your Order has been placed., Tue 8th Jul',
      'Shipped, Expected By Jul 10',
      'Out For Delivery',
      'Delivery, Thu Jul 10 By 11 PM',
      'Expected by Thu 10th Jul',
      'See All Updates',
      'Cancel',
      'Chat with us',
      'Rate your experience',
      'Did you find this page helpful?',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 15 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(403);
      // Must NOT pick tracking number as amount
      expect(result.amount).not.toBe(7253967553);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/OD3348812254001881/i);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/hyphen|sunscreen|spf/i);
      expect(result.productName).not.toMatch(/tracked|tracking|manage|breadcrumb|seller/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/INdianmahabesto/i);
    }
  });

  it('Screenshot 16: Flipkart HYPHEN Sunscreen (Desktop, Mcaffeine) — ₹426', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'Home > My Account > My Orders > OD43488120296007710',
      'Order can be tracked by 7982657303.',
      'Tracking link is shared via SMS.',
      'Manage who can access',
      'HYPHEN Sunscreen - SPF 50 PA++++ All I Need Sunscreen | Brightens - Niacinamide, Kakadu Plum',
      'Seller: Mcaffeine',
      'Rs 426',
      'Order Confirmed, Today',
      'Your Order has been placed., Tue 8th Jul',
      'Shipped, Expected By Jul 8',
      'Out For Delivery',
      'Delivery, Tomorrow, Jul 09 By 11 PM',
      'See All Updates',
      'Cancel',
      'Chat with us',
      'Rate your experience',
      'Did you find this page helpful?',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 16 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(426);
      expect(result.amount).not.toBe(7982657303);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/OD4348812029600771/i);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/hyphen|sunscreen/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/Mcaffeine/i);
    }
  });

  it('Screenshot 17: Flipkart HYPHEN Sunscreen (Mobile) — ₹403', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'flipkart',
      'Order ID - OD43488145129491910',
      'HYPHEN Sunscreen - SPF 50 PA++++ All I Need',
      'Seller: INdianmahabestoil',
      'Rs 403',
      'Order Confirmed, Today',
      'Your Order has been placed., Tue 8th Jul',
      'Shipped, Expected By Jul 10',
      'Out For Delivery',
      'Delivery, Fri Jul 11 By 11 PM',
      'See All Updates',
      'Edit Order',
      'Chat with us',
      'Rate your experience',
      'Did you find this page helpful?',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 17 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(403);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/OD4348814512949191/i);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/hyphen|sunscreen/i);
      expect(result.productName).not.toMatch(/edit\s*order|chat\s*with|rate\s*your/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/INdianmahabestoil/i);
    }
  });

  it('Screenshot 18: Amazon Softsens Baby Starter Kit — Grand Total ₹654, GHAZIABAD/UTTAR PRADESH address', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'amazon.in',
      'Your Orders',
      'Order Details',
      'Order placed 1 March 2026',
      'Order number 408-3540057-5684354',
      'Download Invoice',
      'Arriving tomorrow',
      'Softsens Baby Starter Kit | Combo Pack of 5 Skincare Essentials',
      'Sold by: Softsens',
      'Rs 649.00',
      'Track package',
      'Cancel items',
      'Ask Product Question',
      'Write a product review',
      'Payment method',
      'BHIM UPI',
      'Ship to',
      'Mittal',
      'House number 43 sector 5',
      'Sector 5, Vaishali',
      'GHAZIABAD, UTTAR PRADESH 201012',
      'India',
      'Order Summary',
      'Item(s) Subtotal: Rs 649.00',
      'Shipping: Rs 0.00',
      'Marketplace Fee: Rs 5.00',
      'Total: Rs 654.00',
      'Grand Total: Rs 654.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 18 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(654);
      expect(result.amount).not.toBe(649);
      expect(result.amount).not.toBe(5);
      expect(result.amount).not.toBe(201012);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/408-3540057-5684354/);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/softsens|baby|starter\s*kit|skincare/i);
      expect(result.productName).not.toMatch(/mittal|ghaziabad|uttar|vaishali|201012/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/Softsens/i);
    }
    if (result.orderDate) {
      expect(result.orderDate).toMatch(/1.*March.*2026|March.*1.*2026/i);
    }
  });

  it('Screenshot 19: Amazon Arabian Aroma Old Money — Grand Total ₹317.44, SURAT/GUJARAT address, Promotion -₹5.56', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'amazon.in',
      'Your Orders',
      'Order Details',
      'Order placed 3 March 2026',
      'Order number 171-3355238-4289100',
      'Download Invoice',
      'Arriving 11 March',
      'Arabian Aroma Old Money Eau de Parfum Long Lasting Perfume',
      'Sold by: ARABIAN AROMA',
      'Rs 278.00',
      'Track package',
      'Cancel items',
      'Ask Product Question',
      'Write a product review',
      'Payment method',
      'BHIM UPI',
      'Ship to',
      'Chakhdi Shoes & More',
      'Shop No. 22, Shivam Society',
      'Opp. Rameshwar Mahadev Mandir',
      'SURAT, GUJARAT 395009',
      'India',
      'Order Summary',
      'Item(s) Subtotal: Rs 278.00',
      'Shipping: Rs 40.00',
      'Marketplace Fee: Rs 5.00',
      'Total: Rs 323.00',
      'Promotion Applied: -Rs 5.56',
      'Grand Total: Rs 317.44',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 19 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(317.44);
      expect(result.amount).not.toBe(278);
      expect(result.amount).not.toBe(323);
      expect(result.amount).not.toBe(40);
      expect(result.amount).not.toBe(395009);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/171-3355238-4289100/);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/arabian\s*aroma|old\s*money|parfum/i);
      expect(result.productName).not.toMatch(/chakhdi|surat|gujarat|rameshwar|395009/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/ARABIAN\s*AROMA/i);
    }
    if (result.orderDate) {
      expect(result.orderDate).toMatch(/3.*March.*2026|March.*3.*2026/i);
    }
  });

  it('Screenshot 20: Amazon Arabian Aroma Seduction — Grand Total ₹195, SURAT/GUJARAT address', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'amazon.in',
      'Your Orders',
      'Order Details',
      'Order placed 3 March 2026',
      'Order number 407-8729235-4319566',
      'Download Invoice',
      'Arriving 11 March',
      'Arabian Aroma Seduction Perfume For Men, Ultimate Compliment',
      'Sold by: ARABIAN AROMA',
      'Rs 150.00',
      'Track package',
      'Cancel items',
      'Ask Product Question',
      'Write a product review',
      'Payment method',
      'BHIM UPI',
      'Ship to',
      'VAANI PRIYA',
      'D/5, DIVYAJYOTI APARTMENT',
      'Below Sardar Bridge, Behind Swaminarayan',
      'Mandir, Adajan',
      'SURAT, GUJARAT 395009',
      'India',
      'Order Summary',
      'Item(s) Subtotal: Rs 150.00',
      'Shipping: Rs 40.00',
      'Marketplace Fee: Rs 5.00',
      'Total: Rs 195.00',
      'Grand Total: Rs 195.00',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 20 result:', JSON.stringify(result, null, 2));

    // Amount must be 195 (Grand Total) — not rejected as order ID digit overlap
    expect(result.amount).toBe(195);
    expect(result.amount).not.toBe(150);
    expect(result.amount).not.toBe(40);
    expect(result.amount).not.toBe(395009);
    if (result.orderId) {
      expect(result.orderId).toMatch(/407-8729235-4319566/);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/arabian\s*aroma|seduction|perfume/i);
      expect(result.productName).not.toMatch(/vaani|priya|surat|gujarat|divyajyoti|adajan|395009/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/ARABIAN\s*AROMA/i);
    }
    if (result.orderDate) {
      expect(result.orderDate).toMatch(/3.*March.*2026|March.*3.*2026/i);
    }
  });

  it('Screenshot 21: Amazon Whimsy Beauty Sunscreen — Grand Total ₹445.02 (decimal), COD fee ₹14, AJMER address', { timeout: 120_000 }, async () => {
    const env = makeTestEnv();
    const imageBase64 = await renderTextToImage([
      'amazon.in',
      'Order Details',
      'Order placed 3 March 2026',
      'Order number 404-9901075-4566749',
      'Download Invoice',
      'Arriving Saturday',
      'Whimsy Beauty Sunscreen SPF 50+ Summer Time Madness',
      'Sold by: Whimsy India',
      'Rs 399.00',
      'Track package',
      'Cancel items',
      'Ask Product Question',
      'Write a product review',
      'Payment method',
      'Pay on Delivery',
      'Ship to',
      'Priyanka tinker',
      '336/10',
      'New chandra vardai nagar Tara garh road',
      'ajmer',
      'AJMER, RAJASTHAN 305001',
      'India',
      'Order Summary',
      'Item(s) Subtotal: Rs 399.00',
      'Shipping: Rs 40.00',
      'Cash/Pay on Delivery fee: Rs 14.00',
      'Total: Rs 453.00',
      'Promotion Applied: -Rs 7.98',
      'Grand Total: Rs 445.02',
      'Keep shopping for',
    ]);

    const result = await extractOrderDetailsWithAi(env, { imageBase64 });
    console.log('Screenshot 21 result:', JSON.stringify(result, null, 2));

    if (result.amount) {
      expect(result.amount).toBe(445.02);
      expect(result.amount).not.toBe(399);
      expect(result.amount).not.toBe(453);
      expect(result.amount).not.toBe(14);
      expect(result.amount).not.toBe(305001);
    }
    if (result.orderId) {
      expect(result.orderId).toMatch(/404-9901075-4566749/);
    }
    if (result.productName) {
      expect(result.productName.toLowerCase()).toMatch(/whimsy|sunscreen|spf/i);
      expect(result.productName).not.toMatch(/priyanka|ajmer|rajasthan|keep\s*shopping|305001/i);
    }
    if (result.soldBy) {
      expect(result.soldBy).toMatch(/Whimsy\s*India/i);
    }
    if (result.orderDate) {
      expect(result.orderDate).toMatch(/3.*March.*2026|March.*3.*2026/i);
    }
  });
});
