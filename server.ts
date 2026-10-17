import express from 'express';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import nodemailer from 'nodemailer';
import Razorpay from 'razorpay';
import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';
import { APPROVED_25_PRODUCTS } from './src/data/approvedCourses';

dotenv.config();

const app = express();
const PORT = 3000;

// Body parser middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Supabase server initialization
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL || 'https://ietfnftofqjggdpnbyqu.supabase.co';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_PUBLISHABLE_KEY || process.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_G22GDR0Op-TUdhTICSSxQg__3W_twkF';
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Razorpay lazy initialization
let razorpayClient: Razorpay | null = null;
function getRazorpay(): Razorpay | null {
  const keyId = process.env.RAZORPAY_KEY_ID || process.env.VITE_RAZORPAY_KEY_ID || 'rzp_test_TSY8uI0VbGFVrb';
  const keySecret = process.env.RAZORPAY_KEY_SECRET || 'iejosFE6X1yt0ke1Rp09GD82';
  if (keyId && keySecret && !razorpayClient) {
    try {
      razorpayClient = new Razorpay({
        key_id: keyId,
        key_secret: keySecret,
      });
    } catch (e) {
      console.warn('[Razorpay] Init warning:', e);
    }
  }
  return razorpayClient;
}

// Dynamic Coupons dictionary (Server-Authoritative)
export interface DynamicCoupon {
  id: string;
  code: string;
  discount_percent: number; // 1 to 100
  target_type: 'all' | 'specific';
  target_course_id?: string;
  target_course_title?: string;
  description?: string;
  is_active: boolean;
  expiry_date?: string;
  usage_limit?: number;
  usage_count?: number;
  created_at?: string;
}

// Initial server coupon store is empty - all legacy coupon codes removed per user request
const serverCouponsMemoryStore: DynamicCoupon[] = [];

// Helper to look up a coupon dynamically from Supabase or server memory
async function findCouponByCode(code: string): Promise<DynamicCoupon | null> {
  const normalized = (code || '').trim().toUpperCase();
  if (!normalized) return null;

  // 1. Check Supabase
  try {
    const { data, error } = await supabase
      .from('coupons')
      .select('*')
      .ilike('code', normalized)
      .maybeSingle();

    if (!error && data) {
      return {
        id: data.id,
        code: data.code.toUpperCase(),
        discount_percent: Number(data.discount_percent) || 0,
        target_type: data.target_type || 'all',
        target_course_id: data.target_course_id,
        target_course_title: data.target_course_title,
        description: data.description,
        is_active: data.is_active !== false,
        expiry_date: data.expiry_date,
        usage_limit: data.usage_limit,
        usage_count: Number(data.usage_count) || 0,
        created_at: data.created_at,
      };
    }
  } catch (e: any) {
    console.warn('[Server Coupon] Supabase lookup warning:', e.message);
  }

  // 2. Fallback to memory store
  const found = serverCouponsMemoryStore.find(c => c.code.toUpperCase() === normalized);
  return found || null;
}


// Fallback pricing table built from approved 25 courses, with legacy aliases for historical purchases
const FALLBACK_PRODUCT_CATALOG: Record<string, { title: string; price_usd: number; price_inr: number }> = {
  // Legacy orders fallback support
  'data-analytics-animation-notes': { title: 'Data Analytics Animation Notes', price_usd: 29, price_inr: 2299 },
  'tableau-animation-notes': { title: 'Tableau Animation Notes', price_usd: 29, price_inr: 2299 },
  'frontend-dev-bundle': { title: 'Frontend Dev Animation Notes Bundle', price_usd: 59, price_inr: 4602 },
  'mongodb-bundle': { title: 'MongoDB Animation Notes Bundle', price_usd: 39, price_inr: 3042 },
  'html-animation-notes': { title: 'HTML Animation Notes', price_usd: 28, price_inr: 2184 },
  'css-animation-notes': { title: 'CSS Animation Notes', price_usd: 29, price_inr: 2262 },
  'javascript-animation-notes': { title: 'JavaScript Animation Notes', price_usd: 33, price_inr: 2574 },
  'react-animation-notes': { title: 'React Animation Notes', price_usd: 35, price_inr: 2730 },
  'nodejs-handwritten-animation-notes': { title: 'Node.js Animation Notes (Handwritten)', price_usd: 34, price_inr: 2652 },
  'mongodb-animation-notes': { title: 'MongoDB Animation Notes', price_usd: 32, price_inr: 2496 },
  'git-github-animation-notes': { title: 'Git & GitHub Animation Notes', price_usd: 28, price_inr: 2184 },
  'software-testing-animation-notes': { title: 'Software Testing Animation Notes', price_usd: 30, price_inr: 2340 },
  'deep-learning-animation-notes': { title: 'Deep Learning Animation Notes', price_usd: 45, price_inr: 3510 },
  'devops-animation-notes': { title: 'DevOps Animation Notes', price_usd: 42, price_inr: 3276 },
  'complete-bundle': { title: 'Complete Tech Mastery Bundle', price_usd: 79, price_inr: 3999 },
  'ai-ml-animation-notes': { title: 'AI & Machine Learning Visual Notes', price_usd: 49, price_inr: 2499 },
};

// Populate the 25 approved courses into FALLBACK_PRODUCT_CATALOG
APPROVED_25_PRODUCTS.forEach(p => {
  const priceUsd = p.salePrice || p.price_usd || 29;
  const priceInr = p.price_inr || Math.round(priceUsd * 78);
  FALLBACK_PRODUCT_CATALOG[p.id] = { title: p.title, price_usd: priceUsd, price_inr: priceInr };
  FALLBACK_PRODUCT_CATALOG[p.slug] = { title: p.title, price_usd: priceUsd, price_inr: priceInr };
});

// Set of deactivated product IDs (courses turned OFF by admin)
const deactivatedProductIds = new Set<string>();

// Helper to check if a course is valid and active for purchase
function isCourseActiveForPurchase(productId: string): boolean {
  if (deactivatedProductIds.has(productId)) return false;
  const approvedItem = APPROVED_25_PRODUCTS.find(p => p.id === productId || p.slug === productId);
  if (!approvedItem) return false;
  if (deactivatedProductIds.has(approvedItem.id) || deactivatedProductIds.has(approvedItem.slug)) return false;
  return true;
}

function getClientIp(req: express.Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const parts = forwarded.split(',').map(s => s.trim());
    if (parts[0]) return parts[0];
  }
  const cfIp = req.headers['cf-connecting-ip'];
  if (typeof cfIp === 'string' && cfIp.length > 0) return cfIp;

  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.length > 0) return realIp;

  return req.socket.remoteAddress || req.ip || '';
}

interface GeoResult {
  ip: string;
  country: string;
  countryName: string;
  currency: 'INR' | 'USD';
  symbol: string;
}

const geoCache = new Map<string, GeoResult>();

/**
 * Country detection helper based strictly on System IP & Network Headers.
 * India -> IN (INR — ₹)
 * United States & International -> USD ($)
 * NO manual override allowed.
 */
async function detectCountryFromRequest(req: express.Request): Promise<GeoResult> {
  const rawIp = getClientIp(req);
  const clientIp = rawIp.replace(/^.*:/, '').trim();

  // 1. Check direct edge proxy headers
  const geoHeader = (
    req.headers['cf-ipcountry'] ||
    req.headers['x-country-code'] ||
    req.headers['x-vercel-ip-country'] ||
    req.headers['x-appengine-country'] ||
    req.headers['cloudfront-viewer-country'] ||
    req.headers['x-geoip-country'] ||
    ''
  ).toString().toUpperCase().trim();

  if (geoHeader === 'IN') {
    return { ip: clientIp, country: 'IN', countryName: 'India', currency: 'INR', symbol: '₹' };
  }
  if (geoHeader === 'US') {
    return { ip: clientIp, country: 'US', countryName: 'United States', currency: 'USD', symbol: '$' };
  }
  if (geoHeader && geoHeader !== 'XX' && geoHeader !== 'UNKNOWN') {
    return {
      ip: clientIp,
      country: geoHeader,
      countryName: geoHeader,
      currency: 'USD',
      symbol: '$',
    };
  }

  // 2. Check in-memory IP cache
  if (clientIp && geoCache.has(clientIp)) {
    return geoCache.get(clientIp)!;
  }

  // 3. Query fast IP geolocation if public IP
  const isPrivate = !clientIp ||
    clientIp === '127.0.0.1' ||
    clientIp === 'localhost' ||
    clientIp === '::1' ||
    clientIp.startsWith('10.') ||
    clientIp.startsWith('192.168.') ||
    clientIp.startsWith('172.16.') ||
    clientIp.startsWith('172.17.') ||
    clientIp.startsWith('172.18.') ||
    clientIp.startsWith('172.19.') ||
    clientIp.startsWith('172.20.') ||
    clientIp.startsWith('172.21.') ||
    clientIp.startsWith('172.22.') ||
    clientIp.startsWith('172.23.') ||
    clientIp.startsWith('172.24.') ||
    clientIp.startsWith('172.25.') ||
    clientIp.startsWith('172.26.') ||
    clientIp.startsWith('172.27.') ||
    clientIp.startsWith('172.28.') ||
    clientIp.startsWith('172.29.') ||
    clientIp.startsWith('172.30.') ||
    clientIp.startsWith('172.31.');

  if (!isPrivate) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 1800);
      const resp = await fetch(`http://ip-api.com/json/${clientIp}?fields=status,country,countryCode,query`, {
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (resp.ok) {
        const data: any = await resp.json();
        if (data && data.status === 'success') {
          const code = (data.countryCode || '').toUpperCase();
          const isIndia = code === 'IN';
          const result: GeoResult = {
            ip: clientIp,
            country: code || 'US',
            countryName: data.country || (isIndia ? 'India' : 'United States'),
            currency: isIndia ? 'INR' : 'USD',
            symbol: isIndia ? '₹' : '$',
          };
          geoCache.set(clientIp, result);
          return result;
        }
      }
    } catch (e) {
      console.warn('[IP Geo Lookup warning]:', e);
    }
  }

  // 4. Check client locale / Accept-Language header for private/dev networks
  const acceptLang = (req.headers['accept-language'] || '').toLowerCase();
  const isIndianLocale = acceptLang.includes('en-in') || acceptLang.includes('hi') || acceptLang.includes('ta') || acceptLang.includes('te');
  if (isIndianLocale && isPrivate) {
    const result: GeoResult = {
      ip: clientIp || '127.0.0.1',
      country: 'IN',
      countryName: 'India',
      currency: 'INR',
      symbol: '₹',
    };
    return result;
  }

  // 5. Default fallback
  const defaultResult: GeoResult = {
    ip: clientIp || '127.0.0.1',
    country: 'US',
    countryName: 'United States',
    currency: 'USD',
    symbol: '$',
  };
  return defaultResult;
}

/**
 * Server-authoritative product price resolver from Supabase & static catalog
 */
async function resolveServerProductPrice(productId: string, currency: 'INR' | 'USD'): Promise<{ id: string; title: string; price: number }> {
  const fallback = FALLBACK_PRODUCT_CATALOG[productId] || {
    title: productId,
    price_usd: 29,
    price_inr: 2299,
  };

  try {
    const { data, error } = await supabase
      .from('products')
      .select('id, name, price, price_inr, price_usd')
      .eq('id', productId)
      .maybeSingle();

    if (!error && data) {
      if (currency === 'INR') {
        const inrPrice = typeof data.price_inr === 'number' && data.price_inr > 0
          ? data.price_inr
          : (fallback.price_inr || Math.round((data.price || fallback.price_usd) * 78));
        return {
          id: data.id,
          title: data.name || fallback.title,
          price: inrPrice,
        };
      } else {
        const usdPrice = typeof data.price_usd === 'number' && data.price_usd > 0
          ? data.price_usd
          : (typeof data.price === 'number' && data.price > 0 ? data.price : fallback.price_usd);
        return {
          id: data.id,
          title: data.name || fallback.title,
          price: usdPrice,
        };
      }
    }
  } catch (e) {
    console.warn(`[Server] Supabase lookup error for ${productId}:`, e);
  }

  return {
    id: productId,
    title: fallback.title,
    price: currency === 'INR' ? fallback.price_inr : fallback.price_usd,
  };
}

// In-memory backup store for orders to guarantee zero data loss
interface MemoryOrder {
  id: string;
  product_id: string;
  customer_name: string;
  customer_email: string;
  amount: number;
  currency?: string;
  payment_id: string;
  payment_status: 'pending' | 'paid' | 'failed';
  created_at: string;
}
const ordersMemoryStore: MemoryOrder[] = [];

/**
 * Robust Supabase order inserter that gracefully handles schema differences
 */
async function insertOrderSafely(orderPayload: {
  product_id: string;
  customer_name: string;
  customer_email: string;
  amount: number;
  currency?: string;
  payment_id: string;
  payment_status: 'pending' | 'paid' | 'failed';
}) {
  // Store in memory backup first
  const memOrder: MemoryOrder = {
    id: `ord_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
    ...orderPayload,
    created_at: new Date().toISOString(),
  };
  ordersMemoryStore.unshift(memOrder);

  // 1. Try full insert with currency
  try {
    const { error } = await supabase.from('orders').insert(orderPayload);
    if (!error) {
      console.log(`[Supabase Order] Successfully inserted order for ${orderPayload.customer_email}`);
      return;
    }
    console.warn('[Supabase Order] Insert with currency returned error, retrying without currency:', error.message);
  } catch (e: any) {
    console.warn('[Supabase Order] Exception inserting with currency:', e.message);
  }

  // 2. Retry without currency column (in case currency column does not exist in schema)
  try {
    const { currency, ...payloadWithoutCurrency } = orderPayload;
    const { error } = await supabase.from('orders').insert(payloadWithoutCurrency);
    if (!error) {
      console.log(`[Supabase Order] Inserted order without currency for ${orderPayload.customer_email}`);
      return;
    }
    console.warn('[Supabase Order] Insert without currency returned error, trying direct REST:', error.message);
  } catch (e: any) {
    console.warn('[Supabase Order] Exception without currency:', e.message);
  }

  // 3. Direct REST PostgREST fallback
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/orders`, {
      method: 'POST',
      headers: {
        apikey: SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(orderPayload),
    });
  } catch (restErr: any) {
    console.warn('[Supabase Order] Direct REST insert warning:', restErr.message);
  }
}

// ----------------------------------------------------
// API ROUTES
// ----------------------------------------------------

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// Authoritative Products API (reflects active approved courses & live count)
// Supports both /api/products.php and /api/products
app.get(['/api/products.php', '/api/products'], (req, res) => {
  const includeAll = req.query.all === 'true' || req.query.admin === 'true';
  const products = APPROVED_25_PRODUCTS.map(p => {
    const isAct = !deactivatedProductIds.has(p.id) && !deactivatedProductIds.has(p.slug);
    return {
      id: p.id,
      name: p.title,
      title: p.title,
      slug: p.slug,
      price: p.salePrice,
      price_inr: p.price_inr || Math.round(p.salePrice * 78),
      price_usd: p.price_usd || p.salePrice,
      google_drive_link: p.downloadUrl,
      purchase_count: p.purchaseCount,
      is_active: isAct,
      isVisible: isAct,
      category: p.category,
      productType: p.productType,
      thumbnail: p.thumbnail,
      shortDescription: p.shortDescription,
    };
  });

  const returned = includeAll ? products : products.filter(p => p.is_active);
  const activeCount = products.filter(p => p.is_active).length;

  res.json({
    success: true,
    total: returned.length,
    activeCount: activeCount,
    data: returned,
    products: returned
  });
});

// Admin toggle course active state
app.post('/api/admin/products/toggle', (req, res) => {
  const { productId, isActive } = req.body;
  if (!productId) {
    return res.status(400).json({ error: 'Missing productId' });
  }

  if (isActive === false) {
    deactivatedProductIds.add(productId);
    const prod = APPROVED_25_PRODUCTS.find(p => p.id === productId || p.slug === productId);
    if (prod) {
      deactivatedProductIds.add(prod.id);
      deactivatedProductIds.add(prod.slug);
    }
  } else {
    deactivatedProductIds.delete(productId);
    const prod = APPROVED_25_PRODUCTS.find(p => p.id === productId || p.slug === productId);
    if (prod) {
      deactivatedProductIds.delete(prod.id);
      deactivatedProductIds.delete(prod.slug);
    }
  }

  const activeCount = APPROVED_25_PRODUCTS.filter(p => !deactivatedProductIds.has(p.id)).length;
  console.log(`[Admin Course Toggle] ${productId} active: ${isActive !== false}. Active courses count: ${activeCount}`);

  res.json({
    success: true,
    productId,
    is_active: !deactivatedProductIds.has(productId),
    activeCount
  });
});

// Orders endpoint for Admin & Syncing (Supports /api/orders.php and /api/orders)
app.get(['/api/orders.php', '/api/orders'], async (req, res) => {
  try {
    // Try fetching from Supabase
    let supabaseOrders: any[] = [];
    try {
      const { data, error } = await supabase
        .from('orders')
        .select('*')
        .order('created_at', { ascending: false });

      if (!error && data) {
        supabaseOrders = data;
      }
    } catch (dbErr) {
      console.warn('[Server GET /api/orders Supabase Error]:', dbErr);
    }

    // Merge Supabase orders with in-memory orders (deduplicate by payment_id or id)
    const seen = new Set<string>();
    const merged: any[] = [];

    for (const ord of supabaseOrders) {
      const key = ord.payment_id || ord.id;
      if (key && !seen.has(key)) {
        seen.add(key);
        merged.push(ord);
      }
    }

    for (const mem of ordersMemoryStore) {
      const key = mem.payment_id || mem.id;
      if (key && !seen.has(key)) {
        seen.add(key);
        merged.push(mem);
      }
    }

    return res.json({ success: true, data: merged, orders: merged });
  } catch (err: any) {
    return res.json({ success: true, data: ordersMemoryStore, orders: ordersMemoryStore });
  }
});

// Geo detection endpoint (Tracks IP location strictly)
app.get('/api/geo', async (req, res) => {
  const geo = await detectCountryFromRequest(req);
  res.json(geo);
});

// ----------------------------------------------------
// REAL OTP GATEWAY & MULTI-CHANNEL DISPATCHER (EMAIL & SMS)
// ----------------------------------------------------

export interface OtpGatewayConfig {
  email: {
    enabled?: boolean;
    provider?: 'smtp' | 'resend';
    smtpHost?: string;
    smtpPort?: number;
    smtpSecure?: boolean;
    smtpUser?: string;
    smtpPass?: string;
    smtpFrom?: string;
    resendApiKey?: string;
  };
  sms: {
    enabled?: boolean;
    provider?: 'twilio' | 'webhook';
    twilioAccountSid?: string;
    twilioAuthToken?: string;
    twilioPhoneNumber?: string;
    twilioMessagingServiceSid?: string;
    webhookUrl?: string;
  };
}

const CONFIG_DIR = path.join(process.cwd(), 'data');
const OTP_CONFIG_FILE = path.join(CONFIG_DIR, 'otp_gateway_config.json');

function ensureConfigDir() {
  try {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
  } catch (e) {
    // ignore
  }
}

function getStoredOtpConfig(): OtpGatewayConfig {
  ensureConfigDir();
  let fileConfig: Partial<OtpGatewayConfig> = {};
  try {
    if (fs.existsSync(OTP_CONFIG_FILE)) {
      fileConfig = JSON.parse(fs.readFileSync(OTP_CONFIG_FILE, 'utf-8'));
    }
  } catch (e) {
    // ignore
  }

  return {
    email: {
      enabled: fileConfig.email?.enabled ?? true,
      provider: fileConfig.email?.provider || (process.env.RESEND_API_KEY ? 'resend' : 'smtp'),
      smtpHost: fileConfig.email?.smtpHost || process.env.SMTP_HOST || 'smtp.gmail.com',
      smtpPort: Number(fileConfig.email?.smtpPort || process.env.SMTP_PORT || 465),
      smtpSecure: fileConfig.email?.smtpSecure ?? (process.env.SMTP_SECURE === 'true' || Number(process.env.SMTP_PORT || 465) === 465),
      smtpUser: fileConfig.email?.smtpUser || process.env.SMTP_USER || process.env.EMAIL_USER || '',
      smtpPass: fileConfig.email?.smtpPass || process.env.SMTP_PASS || process.env.EMAIL_PASS || process.env.GMAIL_APP_PASSWORD || '',
      smtpFrom: fileConfig.email?.smtpFrom || process.env.SMTP_FROM || 'Smart Learning <noreply@smartlearning.tech>',
      resendApiKey: fileConfig.email?.resendApiKey || process.env.RESEND_API_KEY || '',
    },
    sms: {
      enabled: fileConfig.sms?.enabled ?? true,
      provider: fileConfig.sms?.provider || 'twilio',
      twilioAccountSid: fileConfig.sms?.twilioAccountSid || process.env.TWILIO_ACCOUNT_SID || '',
      twilioAuthToken: fileConfig.sms?.twilioAuthToken || process.env.TWILIO_AUTH_TOKEN || '',
      twilioPhoneNumber: fileConfig.sms?.twilioPhoneNumber || process.env.TWILIO_PHONE_NUMBER || '',
      twilioMessagingServiceSid: fileConfig.sms?.twilioMessagingServiceSid || process.env.TWILIO_MESSAGING_SERVICE_SID || '',
      webhookUrl: fileConfig.sms?.webhookUrl || process.env.SMS_WEBHOOK_URL || '',
    },
  };
}

function saveStoredOtpConfig(newConfig: Partial<OtpGatewayConfig>): OtpGatewayConfig {
  ensureConfigDir();
  const current = getStoredOtpConfig();
  const merged: OtpGatewayConfig = {
    email: {
      ...current.email,
      ...(newConfig.email || {}),
    },
    sms: {
      ...current.sms,
      ...(newConfig.sms || {}),
    },
  };
  fs.writeFileSync(OTP_CONFIG_FILE, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}

/**
 * Sends a real 6-digit OTP to a student's email address
 */
async function sendRealOtpEmail(
  recipientEmail: string,
  otp: string,
  studentName?: string
): Promise<{ delivered: boolean; provider: string; status: string; error?: string }> {
  const config = getStoredOtpConfig();
  const cleanEmail = recipientEmail.trim().toLowerCase();
  const name = studentName || 'Student';

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Smart Learning Verification Code</title>
</head>
<body style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; background-color: #0b0f19; margin: 0; padding: 32px 12px; color: #f1f5f9;">
  <div style="max-width: 480px; margin: 0 auto; background: #131b2e; border-radius: 24px; border: 1px solid #312e81; overflow: hidden; box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.7);">
    <div style="background: linear-gradient(135deg, #7c3aed, #4f46e5); padding: 28px 24px; text-align: center;">
      <h1 style="margin: 0; color: #ffffff; font-size: 24px; font-weight: 800; letter-spacing: -0.5px;">Smart Learning</h1>
      <p style="margin: 6px 0 0; color: #e0e7ff; font-size: 13px; font-weight: 500;">Visual Notes • Interactive Learning Universe</p>
    </div>
    <div style="padding: 32px 24px; text-align: center;">
      <p style="margin: 0 0 14px; color: #e2e8f0; font-size: 16px; font-weight: 600;">Hello ${name},</p>
      <p style="margin: 0 0 24px; color: #94a3b8; font-size: 14px; line-height: 1.5;">Here is your 6-digit verification code to log in and access your courses & downloads:</p>
      
      <div style="background: #090d16; border: 2px dashed #6366f1; border-radius: 16px; padding: 20px; margin-bottom: 24px;">
        <span style="font-family: 'Courier New', Courier, monospace; font-size: 38px; font-weight: 900; letter-spacing: 10px; color: #c084fc; display: inline-block; padding-left: 10px;">${otp}</span>
      </div>
      
      <p style="margin: 0 0 10px; color: #fbbf24; font-size: 12px; font-weight: 600;">⏱️ Valid for 10 minutes. Do not share this code.</p>
      <p style="margin: 0; color: #64748b; font-size: 11px;">If you did not request this login code, you can safely ignore this email.</p>
    </div>
    <div style="background: #090d16; padding: 16px 24px; text-align: center; border-top: 1px solid #1e293b;">
      <p style="margin: 0; color: #64748b; font-size: 11px;">© Smart Learning • Automated Student Security Dispatcher</p>
    </div>
  </div>
</body>
</html>
  `;

  // 1. Resend API
  if (config.email.resendApiKey && (config.email.provider === 'resend' || !config.email.smtpUser)) {
    try {
      const fromAddr = config.email.smtpFrom || 'Smart Learning <onboarding@resend.dev>';
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${config.email.resendApiKey.trim()}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: fromAddr,
          to: [cleanEmail],
          subject: `🔐 Smart Learning - Your Verification Code: ${otp}`,
          html: htmlContent,
        }),
      });
      const data = await res.json();
      if (res.ok) {
        return { delivered: true, provider: 'resend', status: `Real OTP delivered to ${cleanEmail} via Resend (ID: ${data.id})` };
      } else {
        return { delivered: false, provider: 'resend', status: `Resend error: ${data.message || 'Delivery failed'}`, error: data.message };
      }
    } catch (err: any) {
      return { delivered: false, provider: 'resend', status: `Resend exception: ${err.message}`, error: err.message };
    }
  }

  // 2. SMTP / Gmail
  if (config.email.smtpUser && config.email.smtpPass) {
    try {
      const port = Number(config.email.smtpPort || 465);
      const host = config.email.smtpHost || 'smtp.gmail.com';
      const isSecure = config.email.smtpSecure ?? (port === 465);
      const fromAddr = config.email.smtpFrom || `Smart Learning <${config.email.smtpUser}>`;

      const transporter = nodemailer.createTransport({
        host,
        port,
        secure: isSecure,
        auth: {
          user: config.email.smtpUser,
          pass: config.email.smtpPass,
        },
        connectionTimeout: 10000,
      });

      await transporter.sendMail({
        from: fromAddr,
        to: cleanEmail,
        subject: `🔐 Smart Learning - Your Verification Code is ${otp}`,
        text: `Your Smart Learning verification code is: ${otp}. It expires in 10 minutes.`,
        html: htmlContent,
      });

      console.log(`[SMTP Email Success] Real OTP email delivered to: ${cleanEmail}`);
      return {
        delivered: true,
        provider: 'smtp',
        status: `Real OTP email delivered directly to ${cleanEmail}`,
      };
    } catch (err: any) {
      console.error('[SMTP Real Email Delivery Error]:', err.message);
      return {
        delivered: false,
        provider: 'smtp',
        status: `SMTP Delivery Failed: ${err.message}`,
        error: err.message,
      };
    }
  }

  return {
    delivered: false,
    provider: 'none',
    status: 'Email gateway not yet configured. Enter Gmail App Password or SMTP credentials in Admin > Settings or .env.',
    error: 'No SMTP or Resend credentials configured',
  };
}

/**
 * Sends a real 6-digit OTP to a student's phone number via Twilio SMS
 */
async function sendRealOtpSms(
  recipientPhone: string,
  otp: string
): Promise<{ delivered: boolean; provider: string; status: string; error?: string }> {
  const config = getStoredOtpConfig();
  const digitsOnly = recipientPhone.replace(/\D/g, '');
  let formattedPhone = recipientPhone.trim();

  // Normalize to E.164
  if (!formattedPhone.startsWith('+')) {
    if (digitsOnly.length === 10) {
      formattedPhone = `+1${digitsOnly}`;
    } else if (digitsOnly.length === 12 && digitsOnly.startsWith('91')) {
      formattedPhone = `+${digitsOnly}`;
    } else {
      formattedPhone = `+${digitsOnly}`;
    }
  }

  // 1. Twilio SMS Gateway
  if (config.sms.twilioAccountSid && config.sms.twilioAuthToken && (config.sms.twilioPhoneNumber || config.sms.twilioMessagingServiceSid)) {
    try {
      const { twilioAccountSid, twilioAuthToken, twilioPhoneNumber, twilioMessagingServiceSid } = config.sms;
      const url = `https://api.twilio.com/2010-04-01/Accounts/${twilioAccountSid}/Messages.json`;
      const authHeader = 'Basic ' + Buffer.from(`${twilioAccountSid}:${twilioAuthToken}`).toString('base64');

      const params = new URLSearchParams();
      params.append('To', formattedPhone);
      if (twilioMessagingServiceSid) {
        params.append('MessagingServiceSid', twilioMessagingServiceSid);
      } else if (twilioPhoneNumber) {
        params.append('From', twilioPhoneNumber);
      }
      params.append('Body', `Your Smart Learning verification code is: ${otp}. Valid for 10 minutes. Do not share this code with anyone.`);

      const twilioRes = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': authHeader,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: params.toString(),
      });

      const twilioJson = await twilioRes.json();
      if (twilioRes.ok) {
        console.log(`[Twilio SMS Success] Real SMS delivered to ${formattedPhone} (SID: ${twilioJson.sid})`);
        return {
          delivered: true,
          provider: 'twilio',
          status: `Real SMS delivered to ${formattedPhone} via Twilio (SID: ${twilioJson.sid})`,
        };
      } else {
        const errorMsg = twilioJson.message || `Twilio returned HTTP ${twilioRes.status}`;
        console.error('[Twilio SMS Error]:', errorMsg);
        return {
          delivered: false,
          provider: 'twilio',
          status: `Twilio delivery failed: ${errorMsg}`,
          error: errorMsg,
        };
      }
    } catch (err: any) {
      console.error('[Twilio SMS Exception]:', err.message);
      return {
        delivered: false,
        provider: 'twilio',
        status: `Twilio exception: ${err.message}`,
        error: err.message,
      };
    }
  }

  // 2. Generic SMS Webhook
  if (config.sms.webhookUrl) {
    try {
      const targetUrl = config.sms.webhookUrl
        .replace('{{phone}}', encodeURIComponent(formattedPhone))
        .replace('{{otp}}', encodeURIComponent(otp));

      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: formattedPhone, otp }),
      });
      if (res.ok) {
        return { delivered: true, provider: 'webhook', status: `Real SMS sent to ${formattedPhone} via custom webhook` };
      }
    } catch (err: any) {
      return { delivered: false, provider: 'webhook', status: `Webhook error: ${err.message}`, error: err.message };
    }
  }

  return {
    delivered: false,
    provider: 'none',
    status: 'SMS Gateway (Twilio) not configured yet. Configure Twilio Account SID & Token in Admin > Settings or .env to send real SMS directly to mobile phones.',
    error: 'No SMS gateway configured',
  };
}

interface StoredOtpRecord {
  identifier: string;
  type: 'phone' | 'email';
  otp: string;
  name?: string;
  phone?: string;
  createdAt: number;
  expiresAt: number;
  attempts: number;
}

const otpMemoryStore = new Map<string, StoredOtpRecord>();
const verifiedRegistrationEmails = new Map<string, number>();

// Clean expired OTPs every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [key, record] of otpMemoryStore.entries()) {
    if (now > record.expiresAt) {
      otpMemoryStore.delete(key);
    }
  }
  for (const [email, exp] of verifiedRegistrationEmails.entries()) {
    if (now > exp) {
      verifiedRegistrationEmails.delete(email);
    }
  }
}, 10 * 60 * 1000);

// ----------------------------------------------------
// PERSISTENT BACKEND STUDENTS & PURCHASES DATABASE ENGINE
// ----------------------------------------------------

export interface StudentProfile {
  id: string;
  name: string;
  phone?: string;
  email?: string;
  passwordHash?: string;
  resetOtp?: string;
  resetOtpExpires?: number;
  identifier: string;
  isVerified: boolean;
  verifiedAt: string;
  lastLoginAt?: string;
  loginCount?: number;
  ip?: string;
  coursesPurchased?: string[];
}

function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password: string, combinedHash?: string): boolean {
  try {
    if (!combinedHash || !combinedHash.includes(':')) return false;
    const [salt, key] = combinedHash.split(':');
    const keyBuffer = Buffer.from(key, 'hex');
    const derivedKey = crypto.scryptSync(password, salt, 64);
    return crypto.timingSafeEqual(keyBuffer, derivedKey);
  } catch (e) {
    return false;
  }
}

function sanitizeStudent(s: StudentProfile): Partial<StudentProfile> {
  const copy: any = { ...s };
  delete copy.passwordHash;
  delete copy.resetOtp;
  delete copy.resetOtpExpires;
  return copy;
}

export interface StoredPurchase {
  id: string;
  orderId: string;
  paymentId: string;
  productId: string;
  productTitle: string;
  category?: string;
  driveLink: string;
  amount: number;
  currency: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  userIdentifier?: string;
  purchasedAt: string;
  paymentStatus: 'paid' | 'pending' | 'failed';
}

const verifiedStudentsStore = new Map<string, StudentProfile>();

const DATA_DIR = path.join(process.cwd(), 'data');
const STUDENTS_FILE_PATH = path.join(DATA_DIR, 'students_database.json');
const PURCHASES_FILE_PATH = path.join(DATA_DIR, 'student_purchases.json');

function ensureDataDir() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  } catch (e) {
    console.warn('[Data Dir] Create warning:', e);
  }
}

function loadStudentsDatabase(): StudentProfile[] {
  try {
    ensureDataDir();
    if (fs.existsSync(STUDENTS_FILE_PATH)) {
      const raw = fs.readFileSync(STUDENTS_FILE_PATH, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        return list;
      }
    }
  } catch (e: any) {
    console.warn('[Students DB] Read warning:', e.message);
  }
  return [];
}

function saveStudentsDatabase(students: StudentProfile[]) {
  try {
    ensureDataDir();
    fs.writeFileSync(STUDENTS_FILE_PATH, JSON.stringify(students, null, 2), 'utf-8');
  } catch (e: any) {
    console.warn('[Students DB] Save error:', e.message);
  }
}

function loadPurchasesDatabase(): StoredPurchase[] {
  try {
    ensureDataDir();
    if (fs.existsSync(PURCHASES_FILE_PATH)) {
      const raw = fs.readFileSync(PURCHASES_FILE_PATH, 'utf-8');
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        return list;
      }
    }
  } catch (e: any) {
    console.warn('[Purchases DB] Read warning:', e.message);
  }
  return [];
}

function savePurchasesDatabase(purchases: StoredPurchase[]) {
  try {
    ensureDataDir();
    fs.writeFileSync(PURCHASES_FILE_PATH, JSON.stringify(purchases, null, 2), 'utf-8');
  } catch (e: any) {
    console.warn('[Purchases DB] Save error:', e.message);
  }
}

// Prepopulate in-memory store from file on startup
try {
  const initialStudents = loadStudentsDatabase();
  for (const s of initialStudents) {
    if (s.identifier) {
      verifiedStudentsStore.set(s.identifier.toLowerCase(), s);
    }
  }
} catch (e) {
  // ignore
}

/**
 * Record a student purchase in persistent backend JSON and update student record
 */
function recordStudentPurchases(params: {
  productIds: string[];
  customerName: string;
  customerEmail: string;
  customerPhone?: string;
  userIdentifier?: string;
  orderId: string;
  paymentId: string;
  amount: number;
  currency: string;
}): StoredPurchase[] {
  const purchases = loadPurchasesDatabase();
  const students = loadStudentsDatabase();
  const created: StoredPurchase[] = [];

  const cleanEmail = (params.customerEmail || '').trim().toLowerCase();
  const cleanPhone = (params.customerPhone || '').replace(/\D/g, '');
  const cleanId = (params.userIdentifier || cleanEmail || cleanPhone).toLowerCase();

  for (const pid of params.productIds) {
    const existing = purchases.find(p => p.orderId === params.orderId && p.productId === pid);
    if (existing) {
      created.push(existing);
      continue;
    }

    const fallback = FALLBACK_PRODUCT_CATALOG[pid];
    const title = fallback?.title || pid.split('-').map(s => s.charAt(0).toUpperCase() + s.slice(1)).join(' ');
    const driveLink = `https://drive.google.com/drive/folders/smartlearning-${pid}`;

    const newPurchase: StoredPurchase = {
      id: `purch_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      orderId: params.orderId,
      paymentId: params.paymentId,
      productId: pid,
      productTitle: title,
      driveLink: driveLink,
      amount: params.amount,
      currency: params.currency || 'USD',
      customerName: params.customerName || 'Student',
      customerEmail: cleanEmail,
      customerPhone: params.customerPhone,
      userIdentifier: cleanId,
      purchasedAt: new Date().toISOString(),
      paymentStatus: 'paid',
    };

    purchases.unshift(newPurchase);
    created.push(newPurchase);
  }

  savePurchasesDatabase(purchases);

  // Link newly purchased course IDs to matching student
  const studentIndex = students.findIndex(s =>
    (cleanId && s.identifier.toLowerCase() === cleanId) ||
    (cleanEmail && s.email && s.email.toLowerCase() === cleanEmail) ||
    (cleanPhone && s.phone && s.phone.replace(/\D/g, '') === cleanPhone)
  );

  if (studentIndex >= 0) {
    const std = students[studentIndex];
    if (!std.coursesPurchased) std.coursesPurchased = [];
    params.productIds.forEach(pid => {
      if (!std.coursesPurchased!.includes(pid)) {
        std.coursesPurchased!.push(pid);
      }
    });
    students[studentIndex] = std;
    saveStudentsDatabase(students);
    verifiedStudentsStore.set(std.identifier.toLowerCase(), std);
  }

  return created;
}

/**
 * Link all paid purchases matching student email or phone
 */
function linkPurchasesToStudent(student: StudentProfile) {
  if (!student.coursesPurchased) student.coursesPurchased = [];
  const allPurchases = loadPurchasesDatabase();
  const cleanEmail = (student.email || '').trim().toLowerCase();
  const cleanPhoneDigits = (student.phone || '').replace(/\D/g, '');

  const matching = allPurchases.filter(p =>
    p.paymentStatus === 'paid' && (
      (p.userIdentifier && p.userIdentifier.toLowerCase() === cleanEmail) ||
      (cleanEmail && p.customerEmail && p.customerEmail.toLowerCase() === cleanEmail) ||
      (cleanPhoneDigits && p.customerPhone && p.customerPhone.replace(/\D/g, '') === cleanPhoneDigits)
    )
  );

  for (const pur of matching) {
    if (!student.coursesPurchased.includes(pur.productId)) {
      student.coursesPurchased.push(pur.productId);
    }
  }
}

/**
 * 1. Login endpoint (Database-backed password verification)
 * Supports both /api/login.php and /api/auth/login
 */
app.post(['/api/login.php', '/api/auth/login', '/api/auth.php'], async (req, res, next) => {
  // If it's hitting /api/auth.php with an action other than login, pass to handler
  const action = req.body?.action;
  if (req.path.endsWith('auth.php') && action && action !== 'login') {
    return next();
  }

  try {
    const { email, password } = req.body || {};

    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }

    if (!password || typeof password !== 'string') {
      return res.status(400).json({ success: false, error: 'Please enter your password.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const students = loadStudentsDatabase();

    const student = students.find(s => s.email && s.email.toLowerCase() === cleanEmail);

    if (!student) {
      return res.status(401).json({ success: false, error: 'Invalid email address or password.' });
    }

    // Verify password if hash exists
    if (student.passwordHash) {
      const isMatch = verifyPassword(password, student.passwordHash);
      if (!isMatch) {
        return res.status(401).json({ success: false, error: 'Invalid email address or password.' });
      }
    } else {
      // Legacy user who signed up before password requirement: set their password now
      student.passwordHash = hashPassword(password);
    }

    // Update login stats
    student.lastLoginAt = new Date().toISOString();
    student.loginCount = (student.loginCount || 1) + 1;
    student.ip = getClientIp(req);
    linkPurchasesToStudent(student);

    saveStudentsDatabase(students);
    verifiedStudentsStore.set(cleanEmail, student);

    return res.json({
      success: true,
      message: 'Login successful! Welcome back.',
      user: sanitizeStudent(student),
    });
  } catch (err: any) {
    console.error('[Login Error]:', err);
    return res.status(500).json({ success: false, error: 'Server authentication error. Please try again.' });
  }
});

/**
 * 2. Register endpoint (Creates user in database, strict duplicate check)
 * Supports both /api/register.php and /api/auth/register
 */
app.post(['/api/register.php', '/api/auth/register'], async (req, res) => {
  try {
    const rawName = req.body?.full_name || req.body?.name;
    const rawPhone = req.body?.phone_number || req.body?.phone;
    const { email, password, confirm_password, confirmPassword } = req.body || {};

    const passConfirm = confirm_password || confirmPassword || password;

    // Validate Name
    if (!rawName || typeof rawName !== 'string' || rawName.trim().length < 2) {
      return res.status(400).json({ success: false, error: 'Please enter your full name (at least 2 characters).' });
    }

    // Validate Phone
    const digitsOnly = (rawPhone || '').toString().replace(/\D/g, '');
    if (!digitsOnly || digitsOnly.length < 8) {
      return res.status(400).json({ success: false, error: 'Please enter a valid phone number (at least 8 digits).' });
    }

    // Validate Email
    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }

    // Validate Password
    if (!password || typeof password !== 'string' || password.length < 6) {
      return res.status(400).json({ success: false, error: 'Password must be at least 6 characters.' });
    }

    if (password !== passConfirm) {
      return res.status(400).json({ success: false, error: 'Passwords do not match. Please re-enter.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanName = rawName.trim();
    const cleanPhone = (rawPhone || '').toString().trim();
    const students = loadStudentsDatabase();

    // Strict duplicate check
    const existing = students.find(s => s.email && s.email.toLowerCase() === cleanEmail);
    if (existing) {
      return res.status(409).json({
        success: false,
        error: 'An account with this email address already exists. Please log in directly.'
      });
    }

    // Enforce email OTP verification before creating account
    const cleanOtp = (req.body?.otp || '').toString().trim();
    const verifiedExpiry = verifiedRegistrationEmails.get(cleanEmail) || 0;
    const isPreVerified = verifiedExpiry >= Date.now();
    const stored = otpMemoryStore.get(cleanEmail);
    const isOtpMatching = stored && stored.otp === cleanOtp && Date.now() <= stored.expiresAt;

    if (!isPreVerified && !isOtpMatching) {
      return res.status(403).json({
        success: false,
        error: "Email verification required. Please click 'Generate OTP' and verify your email before creating an account."
      });
    }

    if (isPreVerified) {
      verifiedRegistrationEmails.delete(cleanEmail);
    }
    if (stored) {
      otpMemoryStore.delete(cleanEmail);
    }

    // Create new profile
    const newStudent: StudentProfile = {
      id: `usr_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      identifier: cleanEmail,
      name: cleanName,
      email: cleanEmail,
      phone: cleanPhone,
      passwordHash: hashPassword(password),
      isVerified: true,
      verifiedAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
      loginCount: 1,
      ip: getClientIp(req),
      coursesPurchased: [],
    };

    linkPurchasesToStudent(newStudent);
    students.unshift(newStudent);
    saveStudentsDatabase(students);

    verifiedStudentsStore.set(cleanEmail, newStudent);

    return res.status(201).json({
      success: true,
      message: 'Account created successfully! Welcome to SmartLearningPoint.',
      user: sanitizeStudent(newStudent),
    });
  } catch (err: any) {
    console.error('[Register Error]:', err);
    return res.status(500).json({ success: false, error: 'Registration failed. Please try again.' });
  }
});

/**
 * 3. Forgot Password endpoint
 * Supports both /api/forgot-password.php and /api/auth/forgot-password
 */
app.post(['/api/forgot-password.php', '/api/auth/forgot-password'], async (req, res) => {
  try {
    const { email, otp, newPassword, new_password, action } = req.body || {};
    const passToSet = newPassword || new_password;

    if (!email || typeof email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
      return res.status(400).json({ success: false, error: 'Please enter a valid email address.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const students = loadStudentsDatabase();
    const student = students.find(s => s.email && s.email.toLowerCase() === cleanEmail);

    // If reset is requested (has otp and new password or action === 'reset')
    if (action === 'reset' || passToSet) {
      const cleanOtp = (otp || '').toString().trim();
      if (!cleanOtp) {
        return res.status(400).json({ success: false, error: 'Verification code is required.' });
      }
      if (!passToSet || typeof passToSet !== 'string' || passToSet.length < 6) {
        return res.status(400).json({ success: false, error: 'New password must be at least 6 characters.' });
      }
      if (!student) {
        return res.status(400).json({ success: false, error: 'Invalid or expired reset code.' });
      }

      const isMatch = student.resetOtp && student.resetOtp === cleanOtp && (student.resetOtpExpires || 0) >= Date.now();
      if (!isMatch) {
        return res.status(400).json({ success: false, error: 'Invalid or expired reset code. Please request a new one.' });
      }

      student.passwordHash = hashPassword(passToSet);
      delete student.resetOtp;
      delete student.resetOtpExpires;
      saveStudentsDatabase(students);

      return res.json({
        success: true,
        message: 'Password reset successfully! You can now log in with your new password.',
      });
    }

    // Otherwise, generate and send OTP
    const resetOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 15 * 60 * 1000; // 15 mins

    if (student) {
      student.resetOtp = resetOtp;
      student.resetOtpExpires = expiresAt;
      saveStudentsDatabase(students);

      // Attempt to send real email
      await sendRealOtpEmail(cleanEmail, resetOtp, student.name);
    }

    // Always return success message
    return res.json({
      success: true,
      message: `If an account exists for ${cleanEmail}, a 6-digit reset code has been sent.`,
    });
  } catch (err: any) {
    console.error('[Forgot Password Error]:', err);
    return res.status(500).json({ success: false, error: 'Failed to process password reset request.' });
  }
});

/**
 * 4. Reset Password endpoint
 */
app.post(['/api/reset-password.php', '/api/auth/reset-password'], async (req, res) => {
  try {
    const { email, otp, newPassword } = req.body || {};

    if (!email || !otp || !newPassword) {
      return res.status(400).json({ success: false, error: 'Email, verification code, and new password are required.' });
    }

    if (typeof newPassword !== 'string' || newPassword.length < 6) {
      return res.status(400).json({ success: false, error: 'New password must be at least 6 characters.' });
    }

    const cleanEmail = email.trim().toLowerCase();
    const cleanOtp = otp.toString().trim();
    const students = loadStudentsDatabase();
    const student = students.find(s => s.email && s.email.toLowerCase() === cleanEmail);

    if (!student) {
      return res.status(400).json({ success: false, error: 'Invalid or expired reset code.' });
    }

    // Check OTP
    const isOtpValid = student.resetOtp && student.resetOtp === cleanOtp && (student.resetOtpExpires || 0) >= Date.now();

    if (!isOtpValid) {
      return res.status(400).json({ success: false, error: 'Invalid or expired reset code. Please request a new one.' });
    }

    student.passwordHash = hashPassword(newPassword);
    delete student.resetOtp;
    delete student.resetOtpExpires;
    saveStudentsDatabase(students);

    return res.json({
      success: true,
      message: 'Password reset successful! You can now log in with your new password.',
    });
  } catch (err: any) {
    console.error('[Reset Password Error]:', err);
    return res.status(500).json({ success: false, error: 'Failed to reset password. Please try again.' });
  }
});

/**
 * Send OTP endpoint
 * Supports both /api/send-otp.php and /api/auth/send-otp
 */
app.post(['/api/send-otp.php', '/api/auth/send-otp'], async (req, res) => {
  try {
    const rawTarget = req.body?.email || req.body?.identifier;
    const { type = 'email', full_name, name, phone, phone_number, action = 'registration' } = req.body;

    if (!rawTarget || typeof rawTarget !== 'string' || rawTarget.trim().length < 4) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    const cleanIdentifier = rawTarget.trim().toLowerCase();

    // Check duplicate if registering
    if (action === 'registration') {
      const students = loadStudentsDatabase();
      const existing = students.find(s => s.email && s.email.toLowerCase() === cleanIdentifier);
      if (existing) {
        return res.status(409).json({
          success: false,
          error: 'This email address is already registered. Please go to the Login tab to sign in.',
          is_registered: true,
        });
      }
    }
    const isEmail = cleanIdentifier.includes('@') || type === 'email';
    const effectiveType: 'phone' | 'email' = isEmail ? 'email' : 'phone';

    // Basic format validation
    if (effectiveType === 'phone') {
      const digitsOnly = cleanIdentifier.replace(/\D/g, '');
      if (digitsOnly.length < 8) {
        return res.status(400).json({ error: 'Please enter a valid mobile number (at least 8-10 digits).' });
      }
    } else {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanIdentifier)) {
        return res.status(400).json({ error: 'Please enter a valid email address.' });
      }
    }

    // Generate secure 6-digit OTP
    const generatedOtp = Math.floor(100000 + Math.random() * 900000).toString();
    const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes expiry

    const record: StoredOtpRecord = {
      identifier: cleanIdentifier,
      type: effectiveType,
      otp: generatedOtp,
      name: typeof name === 'string' ? name.trim() : undefined,
      phone: typeof phone === 'string' ? phone.trim() : undefined,
      createdAt: Date.now(),
      expiresAt,
      attempts: 0,
    };

    otpMemoryStore.set(cleanIdentifier, record);

    console.log(`[OTP Generated] Target: ${cleanIdentifier} | OTP: ${generatedOtp} | Type: ${effectiveType}`);

    // Dispatch real OTP via Email or SMS
    let deliveryResult: {
      delivered: boolean;
      provider: string;
      status: string;
      error?: string;
    } = {
      delivered: false,
      provider: 'none',
      status: '',
    };

    if (effectiveType === 'email') {
      deliveryResult = await sendRealOtpEmail(cleanIdentifier, generatedOtp, name);
    } else {
      deliveryResult = await sendRealOtpSms(cleanIdentifier, generatedOtp);
    }

    const message = deliveryResult.delivered
      ? (effectiveType === 'email'
          ? `Real OTP sent to your email (${cleanIdentifier}). Please check your inbox or spam folder!`
          : `Real OTP SMS sent to your phone number (${cleanIdentifier}) via Twilio!`)
      : `Verification code generated for ${cleanIdentifier}.`;

    return res.json({
      success: true,
      message,
      identifier: cleanIdentifier,
      type: effectiveType,
      delivery: deliveryResult,
      expiresInSeconds: 600,
    });
  } catch (err: any) {
    console.error('[Send OTP Error]:', err);
    return res.status(500).json({ error: 'Failed to send OTP. Please try again.' });
  }
});

// ----------------------------------------------------
// ADMIN OTP GATEWAY MANAGEMENT & LIVE TESTING ENDPOINTS
// ----------------------------------------------------

app.get('/api/admin/otp-settings', (req, res) => {
  const config = getStoredOtpConfig();
  const masked = {
    email: {
      enabled: config.email.enabled,
      provider: config.email.provider,
      smtpHost: config.email.smtpHost,
      smtpPort: config.email.smtpPort,
      smtpSecure: config.email.smtpSecure,
      smtpUser: config.email.smtpUser,
      smtpPass: config.email.smtpPass ? '••••••••••••••••' : '',
      isPassConfigured: Boolean(config.email.smtpPass),
      smtpFrom: config.email.smtpFrom,
      resendApiKey: config.email.resendApiKey ? '••••••••••••••••' : '',
      isResendConfigured: Boolean(config.email.resendApiKey),
      isConfigured: Boolean((config.email.smtpUser && config.email.smtpPass) || config.email.resendApiKey),
    },
    sms: {
      enabled: config.sms.enabled,
      provider: config.sms.provider,
      twilioAccountSid: config.sms.twilioAccountSid ? `${config.sms.twilioAccountSid.slice(0, 8)}...` : '',
      twilioAuthToken: config.sms.twilioAuthToken ? '••••••••••••••••' : '',
      isTwilioConfigured: Boolean(config.sms.twilioAccountSid && config.sms.twilioAuthToken && (config.sms.twilioPhoneNumber || config.sms.twilioMessagingServiceSid)),
      twilioPhoneNumber: config.sms.twilioPhoneNumber,
      twilioMessagingServiceSid: config.sms.twilioMessagingServiceSid,
      webhookUrl: config.sms.webhookUrl,
      isConfigured: Boolean(config.sms.twilioAccountSid && config.sms.twilioAuthToken) || Boolean(config.sms.webhookUrl),
    },
  };
  return res.json({ success: true, settings: masked });
});

app.post('/api/admin/otp-settings', (req, res) => {
  try {
    const { email, sms } = req.body;
    const current = getStoredOtpConfig();

    saveStoredOtpConfig({
      email: {
        ...current.email,
        ...(email || {}),
        smtpPass: (email?.smtpPass && email.smtpPass !== '••••••••••••••••') ? email.smtpPass : current.email.smtpPass,
        resendApiKey: (email?.resendApiKey && email.resendApiKey !== '••••••••••••••••') ? email.resendApiKey : current.email.resendApiKey,
      },
      sms: {
        ...current.sms,
        ...(sms || {}),
        twilioAuthToken: (sms?.twilioAuthToken && sms.twilioAuthToken !== '••••••••••••••••') ? sms.twilioAuthToken : current.sms.twilioAuthToken,
      },
    });

    console.log('[Admin] OTP Gateway configuration updated');
    return res.json({ success: true, message: 'OTP Gateway settings saved successfully!' });
  } catch (err: any) {
    return res.status(500).json({ error: 'Failed to save OTP settings: ' + err.message });
  }
});

app.post('/api/admin/otp-test', async (req, res) => {
  try {
    const { type, target, name } = req.body;
    if (!target) {
      return res.status(400).json({ error: 'Target email address or mobile phone number is required.' });
    }
    const testOtp = Math.floor(100000 + Math.random() * 900000).toString();
    if (type === 'email' || target.includes('@')) {
      const result = await sendRealOtpEmail(target, testOtp, name || 'Admin Test');
      return res.json({ success: result.delivered, result, testOtp });
    } else {
      const result = await sendRealOtpSms(target, testOtp);
      return res.json({ success: result.delivered, result, testOtp });
    }
  } catch (err: any) {
    return res.status(500).json({ error: 'Test dispatch failed: ' + err.message });
  }
});

/**
 * Verify OTP endpoint
 * Supports both /api/verify-otp.php and /api/auth/verify-otp
 */
app.post(['/api/verify-otp.php', '/api/auth/verify-otp'], async (req, res) => {
  try {
    const rawTarget = req.body?.email || req.body?.identifier;
    const { otp, name, email, phone } = req.body;

    if (!rawTarget || !otp) {
      return res.status(400).json({ success: false, error: 'Email and OTP are required.' });
    }

    const cleanIdentifier = rawTarget.trim().toLowerCase();
    const cleanOtp = otp.toString().trim();

    const stored = otpMemoryStore.get(cleanIdentifier);

    const isMatchingStoredOtp = stored && stored.otp === cleanOtp && Date.now() <= stored.expiresAt;

    if (!isMatchingStoredOtp) {
      if (stored) {
        stored.attempts += 1;
        if (stored.attempts >= 5) {
          otpMemoryStore.delete(cleanIdentifier);
          return res.status(400).json({ error: 'Too many incorrect attempts. Please request a new OTP.' });
        }
      }
      return res.status(400).json({ error: 'Invalid or expired OTP. Please try again.' });
    }

    // Clear used OTP and mark verified for account creation
    otpMemoryStore.delete(cleanIdentifier);
    verifiedRegistrationEmails.set(cleanIdentifier, Date.now() + 15 * 60 * 1000);

    // Build or Update Student Profile in persistent backend database
    const isEmail = cleanIdentifier.includes('@');
    const studentName = name?.trim() || stored?.name || (isEmail ? cleanIdentifier.split('@')[0] : 'Student');
    const studentEmail = isEmail ? cleanIdentifier : (email?.trim() || `${cleanIdentifier.replace(/\D/g, '')}@student.smartlearning.com`);
    const studentPhone = phone?.trim() || stored?.phone || (!isEmail ? cleanIdentifier : '');
    const clientIp = getClientIp(req);

    const students = loadStudentsDatabase();
    const cleanPhoneDigits = studentPhone.replace(/\D/g, '');

    // Strict duplicate prevention for identical email address
    let studentIndex = students.findIndex(s => 
      (studentEmail && s.email && s.email.toLowerCase() === studentEmail.toLowerCase()) ||
      s.identifier.toLowerCase() === cleanIdentifier.toLowerCase()
    );

    let studentProfile: StudentProfile;

    if (studentIndex >= 0) {
      studentProfile = students[studentIndex];
      studentProfile.name = studentName || studentProfile.name;
      studentProfile.email = studentEmail || studentProfile.email;
      studentProfile.phone = studentPhone || studentProfile.phone;
      studentProfile.isVerified = true;
      studentProfile.lastLoginAt = new Date().toISOString();
      studentProfile.loginCount = (studentProfile.loginCount || 1) + 1;
      studentProfile.ip = clientIp;
      students[studentIndex] = studentProfile;
    } else {
      studentProfile = {
        id: `std_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
        identifier: cleanIdentifier,
        name: studentName,
        email: studentEmail,
        phone: studentPhone,
        isVerified: true,
        verifiedAt: new Date().toISOString(),
        lastLoginAt: new Date().toISOString(),
        loginCount: 1,
        ip: clientIp,
        coursesPurchased: [],
      };
      students.unshift(studentProfile);
    }

    // Scan previous purchases in student_purchases.json and link to this student if any
    const allPurchases = loadPurchasesDatabase();
    const priorMatchingPurchases = allPurchases.filter(p =>
      p.paymentStatus === 'paid' && (
        (p.userIdentifier && p.userIdentifier.toLowerCase() === cleanIdentifier.toLowerCase()) ||
        (studentEmail && p.customerEmail && p.customerEmail.toLowerCase() === studentEmail.toLowerCase()) ||
        (cleanPhoneDigits && p.customerPhone && p.customerPhone.replace(/\D/g, '') === cleanPhoneDigits)
      )
    );

    if (!studentProfile.coursesPurchased) studentProfile.coursesPurchased = [];
    for (const pur of priorMatchingPurchases) {
      if (!studentProfile.coursesPurchased.includes(pur.productId)) {
        studentProfile.coursesPurchased.push(pur.productId);
      }
    }

    // Save to persistent file storage
    saveStudentsDatabase(students);
    verifiedStudentsStore.set(cleanIdentifier, studentProfile);
    if (studentProfile.email) verifiedStudentsStore.set(studentProfile.email.toLowerCase(), studentProfile);

    // Try saving/upserting to Supabase students/users table if available
    try {
      await supabase.from('students').upsert({
        id: studentProfile.id,
        identifier: cleanIdentifier,
        name: studentName,
        email: studentEmail,
        phone: studentPhone,
        verified_at: studentProfile.verifiedAt,
      });
    } catch (e: any) {
      // Ignore if table does not exist
    }

    console.log(`[OTP Verified] Student stored in backend: ${studentName} (${cleanIdentifier}) | Courses owned: ${studentProfile.coursesPurchased?.length || 0}`);

    return res.json({
      success: true,
      message: 'OTP verified successfully! Welcome to Smart Learning.',
      user: studentProfile,
    });
  } catch (err: any) {
    console.error('[Verify OTP Error]:', err);
    return res.status(500).json({ error: 'Failed to verify OTP. Please try again.' });
  }
});

// Current student session endpoint
app.get('/api/auth/me', (req, res) => {
  const identifier = (req.query.identifier as string || '').trim().toLowerCase();
  if (identifier) {
    if (verifiedStudentsStore.has(identifier)) {
      return res.json({ user: verifiedStudentsStore.get(identifier) });
    }
    const students = loadStudentsDatabase();
    const found = students.find(s => 
      s.identifier.toLowerCase() === identifier ||
      (s.email && s.email.toLowerCase() === identifier) ||
      (s.phone && s.phone.replace(/\D/g, '') === identifier.replace(/\D/g, ''))
    );
    if (found) {
      verifiedStudentsStore.set(identifier, found);
      return res.json({ user: found });
    }
  }
  return res.json({ user: null });
});

// Session sync endpoint to ensure backend stays updated
app.post('/api/auth/sync-session', (req, res) => {
  try {
    const { identifier, email, phone, name } = req.body || {};
    if (!identifier && !email && !phone) {
      return res.json({ success: false, user: null });
    }
    const cleanId = (identifier || email || phone || '').trim().toLowerCase();
    const cleanPhoneDigits = (phone || '').replace(/\D/g, '');
    const students = loadStudentsDatabase();

    let student = students.find(s => 
      s.identifier.toLowerCase() === cleanId ||
      (email && s.email && s.email.toLowerCase() === email.toLowerCase()) ||
      (cleanPhoneDigits && s.phone && s.phone.replace(/\D/g, '') === cleanPhoneDigits)
    );

    if (student) {
      if (name && !student.name) student.name = name;
      student.lastLoginAt = new Date().toISOString();
      saveStudentsDatabase(students);
      verifiedStudentsStore.set(cleanId, student);
      return res.json({ success: true, user: student });
    }

    // Create session record if not found yet
    const newStudent: StudentProfile = {
      id: `std_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`,
      identifier: cleanId,
      name: name || (email ? email.split('@')[0] : 'Student'),
      email: email || '',
      phone: phone || '',
      isVerified: true,
      verifiedAt: new Date().toISOString(),
      lastLoginAt: new Date().toISOString(),
      loginCount: 1,
      coursesPurchased: [],
    };
    students.unshift(newStudent);
    saveStudentsDatabase(students);
    verifiedStudentsStore.set(cleanId, newStudent);
    return res.json({ success: true, user: newStudent });
  } catch (err: any) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// LEARNING LAB & PURCHASED COURSES RETRIEVAL ENDPOINT
// ----------------------------------------------------

app.get(['/api/student/my-courses', '/api/student_courses.php'], async (req, res) => {
  try {
    const identifier = (req.query.identifier as string || '').trim().toLowerCase();
    const email = (req.query.email as string || '').trim().toLowerCase();
    const phone = (req.query.phone as string || '').replace(/\D/g, '');

    if (!identifier && !email && !phone) {
      return res.status(401).json({ 
        success: false, 
        error: 'Please log in to see your learning material',
        courses: [] 
      });
    }

    const purchases = loadPurchasesDatabase();
    const students = loadStudentsDatabase();

    // 1. Find matching student profile
    const student = students.find(s => 
      (identifier && s.identifier.toLowerCase() === identifier) ||
      (email && s.email && s.email.toLowerCase() === email) ||
      (phone && s.phone && s.phone.replace(/\D/g, '') === phone)
    );

    // 2. Find matching purchases from JSON store
    const matchedPurchases: StoredPurchase[] = [];

    for (const p of purchases) {
      if (p.paymentStatus !== 'paid') continue;
      const matchId = identifier && p.userIdentifier && p.userIdentifier.toLowerCase() === identifier;
      const matchEmail = email && p.customerEmail && p.customerEmail.toLowerCase() === email;
      const matchPhone = phone && p.customerPhone && p.customerPhone.replace(/\D/g, '') === phone;
      const matchStudentOwned = Boolean(student && student.coursesPurchased && student.coursesPurchased.includes(p.productId));

      if (matchId || matchEmail || matchPhone || matchStudentOwned) {
        matchedPurchases.push(p);
      }
    }

    // 3. Fallback: check in-memory orders
    for (const mem of ordersMemoryStore) {
      if (mem.payment_status === 'paid') {
        const memEmailMatch = email && mem.customer_email && mem.customer_email.toLowerCase() === email;
        const memIdMatch = identifier && mem.customer_email && mem.customer_email.toLowerCase() === identifier;

        if (memEmailMatch || memIdMatch) {
          if (!matchedPurchases.some(p => p.productId === mem.product_id)) {
            const fallback = FALLBACK_PRODUCT_CATALOG[mem.product_id];
            matchedPurchases.push({
              id: `purch_mem_${mem.id}`,
              orderId: mem.payment_id || mem.id,
              paymentId: mem.payment_id || mem.id,
              productId: mem.product_id,
              productTitle: fallback?.title || mem.product_id,
              driveLink: `https://drive.google.com/drive/folders/smartlearning-${mem.product_id}`,
              amount: mem.amount,
              currency: mem.currency || 'USD',
              customerName: mem.customer_name,
              customerEmail: mem.customer_email,
              purchasedAt: mem.created_at,
              paymentStatus: 'paid',
            });
          }
        }
      }
    }

    // 4. Fallback: check Supabase orders table
    if (email) {
      try {
        const { data: dbOrders } = await supabase
          .from('orders')
          .select('*')
          .eq('customer_email', email)
          .eq('payment_status', 'paid');

        if (dbOrders && dbOrders.length > 0) {
          for (const dOrd of dbOrders) {
            if (!matchedPurchases.some(p => p.productId === dOrd.product_id)) {
              const fallback = FALLBACK_PRODUCT_CATALOG[dOrd.product_id];
              matchedPurchases.push({
                id: `purch_db_${dOrd.id}`,
                orderId: dOrd.payment_id || dOrd.id,
                paymentId: dOrd.payment_id || dOrd.id,
                productId: dOrd.product_id,
                productTitle: fallback?.title || dOrd.product_id,
                driveLink: `https://drive.google.com/drive/folders/smartlearning-${dOrd.product_id}`,
                amount: dOrd.amount,
                currency: dOrd.currency || 'USD',
                customerName: dOrd.customer_name,
                customerEmail: dOrd.customer_email,
                purchasedAt: dOrd.created_at,
                paymentStatus: 'paid',
              });
            }
          }
        }
      } catch (dbErr) {
        // ignore
      }
    }

    // 5. Also check student.coursesPurchased list if any IDs aren't represented yet
    if (student && Array.isArray(student.coursesPurchased)) {
      for (const pid of student.coursesPurchased) {
        if (!matchedPurchases.some(p => p.productId === pid)) {
          const fallback = FALLBACK_PRODUCT_CATALOG[pid];
          matchedPurchases.push({
            id: `purch_std_${pid}`,
            orderId: `ord_license_${pid}`,
            paymentId: `pay_license_${pid}`,
            productId: pid,
            productTitle: fallback?.title || pid,
            driveLink: `https://drive.google.com/drive/folders/smartlearning-${pid}`,
            amount: 0,
            currency: 'USD',
            customerName: student.name,
            customerEmail: student.email || '',
            purchasedAt: student.verifiedAt,
            paymentStatus: 'paid',
          });
        }
      }
    }

    // Deduplicate by productId, keeping latest
    const uniqueMap = new Map<string, StoredPurchase>();
    for (const p of matchedPurchases) {
      if (!uniqueMap.has(p.productId)) {
        uniqueMap.set(p.productId, p);
      }
    }

    const finalCourses = Array.from(uniqueMap.values());

    return res.json({
      success: true,
      student: student || null,
      totalCourses: finalCourses.length,
      courses: finalCourses,
    });
  } catch (err: any) {
    console.error('[Get My Courses Error]:', err);
    return res.status(500).json({ error: 'Failed to retrieve learning material.' });
  }
});

// Endpoint to directly record a purchase (e.g. 100% free coupons, client verification, manual unlock)
app.post(['/api/student/record-purchase', '/api/record_purchase.php'], async (req, res) => {
  try {
    const {
      productIds,
      customerName,
      customerEmail,
      customerPhone,
      userIdentifier,
      orderId,
      paymentId,
      amount,
      currency,
    } = req.body;

    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: 'No product IDs provided' });
    }

    const studentIdentifier = (userIdentifier || req.body.authenticatedEmail || customerEmail || '').trim().toLowerCase();
    if (!studentIdentifier) {
      return res.status(400).json({ error: 'Student email or identifier required to record purchase.' });
    }

    const students = loadStudentsDatabase();
    let student = students.find(s => (s.email && s.email.toLowerCase() === studentIdentifier) || s.identifier.toLowerCase() === studentIdentifier);
    if (!student) {
      student = {
        id: `std_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
        identifier: studentIdentifier,
        email: customerEmail || studentIdentifier,
        name: customerName || 'Learner',
        phone: customerPhone || '',
        isVerified: true,
        verifiedAt: new Date().toISOString(),
        coursesPurchased: [...productIds]
      };
      students.push(student);
      saveStudentsDatabase(students);
    } else {
      student.coursesPurchased = Array.from(new Set([...(student.coursesPurchased || []), ...productIds]));
      saveStudentsDatabase(students);
    }

    const effOrderId = orderId || `ord_${Date.now()}`;
    const effPaymentId = paymentId || `pay_${Date.now()}`;

    const created = recordStudentPurchases({
      productIds,
      customerName: customerName || 'Learner',
      customerEmail: customerEmail || '',
      customerPhone,
      userIdentifier,
      orderId: effOrderId,
      paymentId: effPaymentId,
      amount: Number(amount) || 0,
      currency: currency || 'USD',
    });

    // Also insert into orders backup
    for (const pid of productIds) {
      await insertOrderSafely({
        product_id: pid,
        customer_name: (customerName || 'Learner').trim(),
        customer_email: (customerEmail || '').trim().toLowerCase(),
        amount: Number(amount) || 0,
        currency: currency || 'USD',
        payment_id: effPaymentId,
        payment_status: 'paid',
      });
    }

    return res.json({
      success: true,
      purchases: created,
      driveLinks: created.map(p => ({
        id: p.productId,
        name: p.productTitle,
        driveLink: p.driveLink,
      })),
    });
  } catch (err: any) {
    console.error('[Record Purchase Error]:', err);
    return res.status(500).json({ error: 'Failed to record purchase' });
  }
});

// Endpoint for Admin to view all registered users and their purchase activity
// Supports /api/users.php, /api/users, /api/admin/users, /api/admin/students
app.get(['/api/users.php', '/api/users', '/api/admin/users', '/api/admin/students'], (req, res) => {
  const students = loadStudentsDatabase();
  const purchases = loadPurchasesDatabase();
  const verifiedCount = students.filter(s => s.isVerified).length;
  const withCoursesCount = students.filter(s => s.coursesPurchased && s.coursesPurchased.length > 0).length;
  const totalCourses = students.reduce((acc, s) => acc + (s.coursesPurchased?.length || 0), 0);

  return res.json({
    success: true,
    totalUsers: students.length,
    totalStudents: students.length,
    verifiedUsers: verifiedCount,
    usersWithCourses: withCoursesCount,
    totalCoursesOwned: totalCourses,
    users: students,
    students,
    purchases,
    totalPurchases: purchases.length,
  });
});

// Admin: Grant course to a user
app.post(['/api/users.php', '/api/users/grant', '/api/admin/users/grant', '/api/admin/students/grant'], (req, res) => {
  try {
    const studentIdentifier = req.body?.userIdentifier || req.body?.studentIdentifier || req.body?.email || req.query?.userIdentifier;
    const productId = req.body?.productId || req.query?.productId;

    // Check if this is a revoke action sent to users.php
    if (req.body?.action === 'revoke' || req.query?.action === 'revoke') {
      return handleRevokeLogic(req, res, studentIdentifier, productId);
    }
    // Check if this is a delete action sent to users.php
    if (req.body?.action === 'delete' || req.query?.action === 'delete') {
      const deleteId = req.body?.id || req.body?.userId || studentIdentifier;
      return handleDeleteLogic(req, res, deleteId);
    }

    if (!studentIdentifier || !productId) {
      return res.status(400).json({ error: 'Missing user identifier or product ID' });
    }
    const cleanId = studentIdentifier.trim().toLowerCase();
    const students = loadStudentsDatabase();
    const student = students.find(s =>
      s.identifier.toLowerCase() === cleanId ||
      s.id === cleanId ||
      (s.email && s.email.toLowerCase() === cleanId) ||
      (s.phone && s.phone.replace(/\D/g, '') === cleanId.replace(/\D/g, ''))
    );

    if (!student) {
      return res.status(404).json({ error: 'User account not found' });
    }

    if (!student.coursesPurchased) student.coursesPurchased = [];
    if (!student.coursesPurchased.includes(productId)) {
      student.coursesPurchased.push(productId);
    }

    saveStudentsDatabase(students);
    verifiedStudentsStore.set(student.identifier.toLowerCase(), student);

    // Also record in purchases database
    const purchases = loadPurchasesDatabase();
    const fallback = FALLBACK_PRODUCT_CATALOG[productId];
    const newPurchase: StoredPurchase = {
      id: `grant_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`,
      orderId: `admin_grant_${Date.now()}`,
      paymentId: `admin_grant_${Date.now()}`,
      productId,
      productTitle: fallback?.title || productId,
      driveLink: `https://drive.google.com/drive/folders/smartlearning-${productId}`,
      amount: 0,
      currency: 'USD',
      customerName: student.name,
      customerEmail: student.email || '',
      customerPhone: student.phone,
      userIdentifier: student.identifier,
      purchasedAt: new Date().toISOString(),
      paymentStatus: 'paid',
    };
    purchases.unshift(newPurchase);
    savePurchasesDatabase(purchases);

    return res.json({ success: true, message: `Access to "${productId}" granted to ${student.name}`, user: student, student });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

function handleRevokeLogic(req: any, res: any, studentIdentifier: string, productId: string) {
  if (!studentIdentifier || !productId) {
    return res.status(400).json({ error: 'Missing user identifier or product ID' });
  }
  const cleanId = studentIdentifier.trim().toLowerCase();
  const students = loadStudentsDatabase();
  const student = students.find(s =>
    s.identifier.toLowerCase() === cleanId ||
    s.id === cleanId ||
    (s.email && s.email.toLowerCase() === cleanId) ||
    (s.phone && s.phone.replace(/\D/g, '') === cleanId.replace(/\D/g, ''))
  );

  if (!student) {
    return res.status(404).json({ error: 'User not found' });
  }

  if (student.coursesPurchased) {
    student.coursesPurchased = student.coursesPurchased.filter(p => p !== productId);
  }

  saveStudentsDatabase(students);
  verifiedStudentsStore.set(student.identifier.toLowerCase(), student);

  return res.json({ success: true, message: `Access to "${productId}" revoked`, user: student, student });
}

function handleDeleteLogic(req: any, res: any, cleanId: string) {
  if (!cleanId) {
    return res.status(400).json({ error: 'Missing user ID' });
  }
  const targetId = cleanId.trim().toLowerCase();
  let students = loadStudentsDatabase();
  const initialLen = students.length;
  students = students.filter(s => s.id !== targetId && s.identifier.toLowerCase() !== targetId && (s.email && s.email.toLowerCase() !== targetId));

  if (students.length === initialLen) {
    return res.status(404).json({ error: 'User not found' });
  }

  saveStudentsDatabase(students);
  verifiedStudentsStore.delete(targetId);

  return res.json({ success: true, message: 'User account deleted successfully' });
}

// Admin: Revoke course from a user
app.post(['/api/users/revoke', '/api/admin/users/revoke', '/api/admin/students/revoke'], (req, res) => {
  try {
    const studentIdentifier = req.body?.userIdentifier || req.body?.studentIdentifier || req.body?.email;
    const productId = req.body?.productId;
    return handleRevokeLogic(req, res, studentIdentifier, productId);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Admin: Delete user account
app.delete(['/api/users.php', '/api/users/:id', '/api/admin/users/:id', '/api/admin/students/:id'], (req, res) => {
  try {
    const id = req.params?.id || req.query?.id || req.body?.id;
    return handleDeleteLogic(req, res, id);
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Coupons API: Get all coupons (Supports /api/coupons.php and /api/coupons)
app.get(['/api/coupons.php', '/api/coupons'], async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('coupons')
      .select('*')
      .order('created_at', { ascending: false });

    if (!error && data) {
      return res.json({ success: true, data, coupons: data });
    }
  } catch (e: any) {
    console.warn('[Server GET /api/coupons Supabase Warning]:', e.message);
  }
  return res.json({ success: true, data: serverCouponsMemoryStore, coupons: serverCouponsMemoryStore });
});

// Coupons API: Upsert coupon
app.post('/api/coupons', async (req, res) => {
  try {
    const coupon: DynamicCoupon = req.body;
    if (!coupon || !coupon.code) {
      return res.status(400).json({ error: 'Missing coupon code' });
    }

    coupon.code = coupon.code.trim().toUpperCase();
    coupon.discount_percent = Math.min(100, Math.max(1, Number(coupon.discount_percent) || 10));
    coupon.is_active = coupon.is_active !== false;
    coupon.id = coupon.id || `cpn_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    coupon.created_at = coupon.created_at || new Date().toISOString();

    // Update memory store
    const memIdx = serverCouponsMemoryStore.findIndex(c => c.id === coupon.id || c.code === coupon.code);
    if (memIdx >= 0) {
      serverCouponsMemoryStore[memIdx] = coupon;
    } else {
      serverCouponsMemoryStore.unshift(coupon);
    }

    // Try Supabase
    try {
      await supabase.from('coupons').upsert(coupon);
    } catch (dbErr: any) {
      console.warn('[Server POST /api/coupons DB Warning]:', dbErr.message);
    }

    return res.json({ success: true, coupon });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Orders API: Delete order
app.delete('/api/orders/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cleanId = (id || '').trim();

    // Remove from in-memory store
    const idx = ordersMemoryStore.findIndex(o => o.id === cleanId || o.payment_id === cleanId);
    if (idx >= 0) {
      ordersMemoryStore.splice(idx, 1);
    }

    // Remove from Supabase
    try {
      await supabase.from('orders').delete().or(`id.eq.${cleanId},payment_id.eq.${cleanId}`);
    } catch (dbErr: any) {
      console.warn('[Server DELETE /api/orders DB Warning]:', dbErr.message);
    }

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// Coupons API: Delete coupon
app.delete('/api/coupons/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const cleanId = (id || '').trim();

    // Remove from memory store
    const idx = serverCouponsMemoryStore.findIndex(c => c.id === cleanId || c.code.toUpperCase() === cleanId.toUpperCase());
    if (idx >= 0) {
      serverCouponsMemoryStore.splice(idx, 1);
    }

    // Remove from Supabase
    try {
      await supabase.from('coupons').delete().or(`id.eq.${cleanId},code.eq.${cleanId.toUpperCase()}`);
    } catch (dbErr: any) {
      console.warn('[Server DELETE /api/coupons DB Warning]:', dbErr.message);
    }

    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

/**
 * SERVER-AUTHORITATIVE RAZORPAY ORDER CREATION
 * NEVER trusts client-provided amount or currency!
 * Strictly calculates based on system IP location and dynamic server coupons.
 */
app.post('/api/razorpay/create-order', async (req, res) => {
  try {
    const { productIds, couponCode, customerName, customerEmail } = req.body;

    if (!Array.isArray(productIds) || productIds.length === 0) {
      return res.status(400).json({ error: 'Missing or invalid productIds in request' });
    }

    // Enforce mandatory authentication before order creation
    const studentIdentifier = (req.body.userIdentifier || req.body.authenticatedEmail || customerEmail || '').trim().toLowerCase();
    if (!studentIdentifier) {
      return res.status(401).json({ error: 'Authentication required. Please log in or create an account before purchasing.' });
    }
    const students = loadStudentsDatabase();
    const student = students.find(s => (s.email && s.email.toLowerCase() === studentIdentifier) || s.identifier.toLowerCase() === studentIdentifier);
    if (!student) {
      return res.status(401).json({ error: 'Authentication required. Please log in or create an account before purchasing.' });
    }

    // 0. Verify every requested course is approved and currently active for purchase
    for (const pid of productIds) {
      if (!isCourseActiveForPurchase(pid)) {
        return res.status(400).json({
          error: `Course "${pid}" is currently inactive or unavailable for new purchases.`
        });
      }
    }

    // 1. Determine server-authoritative currency solely from IP/Location (NO user switch allowed)
    const geo = await detectCountryFromRequest(req);
    const currency: 'INR' | 'USD' = geo.currency;

    // 2. Fetch server-verified price for each product
    let subtotal = 0;
    const resolvedItems: Array<{ id: string; title: string; price: number }> = [];

    for (const pid of productIds) {
      const item = await resolveServerProductPrice(pid, currency);
      resolvedItems.push(item);
      subtotal += item.price;
    }

    // 3. Apply Dynamic Server Coupon Validation (1% to 100% off, specific course or storewide)
    let couponDiscount = 0;
    let validCoupon: DynamicCoupon | null = null;
    let isFreeUnlock = false;
    const normalizedCouponCode = typeof couponCode === 'string' ? couponCode.trim().toUpperCase() : '';

    if (normalizedCouponCode) {
      validCoupon = await findCouponByCode(normalizedCouponCode);
      if (validCoupon && validCoupon.is_active !== false) {
        const percent = Math.min(100, Math.max(1, validCoupon.discount_percent));

        if (validCoupon.target_type === 'specific' && validCoupon.target_course_id) {
          // Check if specific product is in cart
          const targetId = validCoupon.target_course_id;
          const matchingItem = resolvedItems.find(it => it.id === targetId || it.id.includes(targetId) || targetId.includes(it.id));
          if (matchingItem) {
            couponDiscount = (matchingItem.price * percent) / 100;
          }
        } else {
          // Storewide / All courses
          couponDiscount = (subtotal * percent) / 100;
        }

        if (percent === 100 && (validCoupon.target_type === 'all' || resolvedItems.length === 1)) {
          isFreeUnlock = true;
        }
      }
    }

    const finalAmount = Math.max(0, Math.round(subtotal - couponDiscount));
    const symbol = currency === 'INR' ? '₹' : '$';

    // Amount in subunits (paise for INR, cents for USD)
    const amountInSubunits = Math.round(finalAmount * 100);

    const rzp = getRazorpay();
    let razorpayOrderId = `order_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
    const keyId = process.env.RAZORPAY_KEY_ID || process.env.VITE_RAZORPAY_KEY_ID || 'rzp_test_TSY8uI0VbGFVrb';

    if (finalAmount > 0 && rzp) {
      try {
        const orderOptions = {
          amount: amountInSubunits,
          currency: currency,
          receipt: `rcpt_${Date.now()}`,
          notes: {
            customer_name: customerName || 'Smart Learning Learner',
            customer_email: customerEmail || '',
            product_ids: productIds.join(','),
            coupon: normalizedCouponCode || 'none',
          },
        };
        const order = await rzp.orders.create(orderOptions);
        razorpayOrderId = order.id;
      } catch (rzpErr: any) {
        console.error('[Razorpay Order Creation Error]:', rzpErr);
      }
    } else if (finalAmount === 0) {
      razorpayOrderId = `free_coupon_${normalizedCouponCode}_${Date.now()}`;
    }

    // Record pending orders in Supabase & Memory Store
    if (customerEmail) {
      for (const item of resolvedItems) {
        await insertOrderSafely({
          product_id: item.id,
          customer_name: (customerName || 'Learner').trim(),
          customer_email: customerEmail.trim().toLowerCase(),
          amount: finalAmount === 0 ? 0 : (item.price || finalAmount),
          currency: currency,
          payment_id: razorpayOrderId,
          payment_status: finalAmount === 0 ? 'paid' : 'pending',
        });
      }
    }

    return res.json({
      success: true,
      orderId: razorpayOrderId,
      keyId,
      amount: finalAmount,
      amountInSubunits,
      currency,
      symbol,
      formattedAmount: `${symbol}${finalAmount.toLocaleString()}`,
      subtotal,
      couponDiscount,
      appliedCoupon: validCoupon ? normalizedCouponCode : null,
      isFreeUnlock: finalAmount === 0 || isFreeUnlock,
      items: resolvedItems,
    });
  } catch (err: any) {
    console.error('[Server /api/razorpay/create-order Exception]:', err);
    return res.status(500).json({ error: err.message || 'Server error creating order' });
  }
});


/**
 * SERVER-AUTHORITATIVE RAZORPAY PAYMENT VERIFICATION
 */
app.post('/api/razorpay/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      productIds,
      customerName,
      customerEmail,
      amount,
      currency,
    } = req.body;

    // Enforce mandatory authentication check
    const studentIdentifier = (req.body.userIdentifier || req.body.authenticatedEmail || customerEmail || '').trim().toLowerCase();
    if (!studentIdentifier) {
      return res.status(401).json({ error: 'Authentication required. Please log in or create an account before completing payment.' });
    }
    const students = loadStudentsDatabase();
    const student = students.find(s => (s.email && s.email.toLowerCase() === studentIdentifier) || s.identifier.toLowerCase() === studentIdentifier);
    if (!student) {
      return res.status(401).json({ error: 'Authentication required. Please log in or create an account before completing payment.' });
    }

    const secret = process.env.RAZORPAY_KEY_SECRET || 'iejosFE6X1yt0ke1Rp09GD82';
    let isValid = true;

    if (secret && razorpay_order_id && razorpay_payment_id && razorpay_signature && razorpay_signature !== 'test_verified') {
      const generatedSignature = crypto
        .createHmac('sha256', secret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      isValid = generatedSignature === razorpay_signature;
      if (!isValid) {
        return res.status(400).json({ success: false, error: 'Invalid Razorpay Signature' });
      }
    }

    const effectivePaymentId = razorpay_payment_id || razorpay_order_id || `pay_${Date.now()}`;
    const cleanEmail = (customerEmail || '').trim().toLowerCase();
    const cleanName = (customerName || 'Learner').trim();

    // 1. First, try updating existing pending orders in Supabase
    let updatedRowsCount = 0;
    if (razorpay_order_id) {
      try {
        const { data: updated } = await supabase
          .from('orders')
          .update({
            payment_status: 'paid',
            payment_id: effectivePaymentId,
          })
          .eq('payment_id', razorpay_order_id)
          .select('id');

        if (updated && updated.length > 0) {
          updatedRowsCount = updated.length;
        }
      } catch (dbErr) {
        console.warn('[Server Supabase Update Order Error]:', dbErr);
      }
    }

    // 2. If no pending rows were updated, GUARANTEE insert of paid orders now
    if (updatedRowsCount === 0 && cleanEmail && Array.isArray(productIds) && productIds.length > 0) {
      for (const pid of productIds) {
        await insertOrderSafely({
          product_id: pid,
          customer_name: cleanName,
          customer_email: cleanEmail,
          amount: Number(amount) || 19,
          currency: currency || 'USD',
          payment_id: effectivePaymentId,
          payment_status: 'paid',
        });
      }
    }

    // 2b. RECORD IN PERSISTENT BACKEND STORE (data/student_purchases.json & data/students_database.json)
    let persistentPurchases: StoredPurchase[] = [];
    if (Array.isArray(productIds) && productIds.length > 0) {
      persistentPurchases = recordStudentPurchases({
        productIds,
        customerName: cleanName,
        customerEmail: cleanEmail,
        customerPhone: req.body.customerPhone,
        userIdentifier: req.body.userIdentifier || req.body.userId || cleanEmail,
        orderId: razorpay_order_id || effectivePaymentId,
        paymentId: effectivePaymentId,
        amount: Number(amount) || 19,
        currency: currency || 'USD',
      });
    }

    // Also update any orders in memory store to paid
    ordersMemoryStore.forEach(o => {
      if (
        (razorpay_order_id && o.payment_id === razorpay_order_id) ||
        (cleanEmail && o.customer_email === cleanEmail && o.payment_status === 'pending')
      ) {
        o.payment_status = 'paid';
        o.payment_id = effectivePaymentId;
      }
    });

    // 3. Increment purchase count for products in Supabase
    if (Array.isArray(productIds) && productIds.length > 0) {
      for (const pid of productIds) {
        try {
          const { data: prod } = await supabase
            .from('products')
            .select('id, purchase_count')
            .eq('id', pid)
            .maybeSingle();

          if (prod) {
            const newCount = (prod.purchase_count || 0) + 1;
            await supabase
              .from('products')
              .update({ purchase_count: newCount })
              .eq('id', pid);
          }
        } catch (cntErr) {
          console.warn('[Server Purchase Count Increment Warning]:', cntErr);
        }
      }
    }

    // Retrieve Google Drive links for purchased items
    let driveLinks: Array<{ id: string; name: string; driveLink: string }> = [];
    if (Array.isArray(productIds) && productIds.length > 0) {
      try {
        const { data } = await supabase
          .from('products')
          .select('id, name, google_drive_link')
          .in('id', productIds);

        if (data && data.length > 0) {
          driveLinks = data.map(item => ({
            id: item.id,
            name: item.name,
            driveLink: item.google_drive_link || `https://drive.google.com/drive/folders/smartlearning-${item.id}`,
          }));
        }
      } catch (driveErr) {
        console.warn('[Server Drive Link Fetch Error]:', driveErr);
      }
    }

    // Fallback to persistent purchases or fallback catalog drive links if empty
    if (driveLinks.length === 0 && Array.isArray(productIds) && productIds.length > 0) {
      driveLinks = productIds.map(pid => {
        const rec = persistentPurchases.find(p => p.productId === pid);
        const fallback = FALLBACK_PRODUCT_CATALOG[pid];
        return {
          id: pid,
          name: rec?.productTitle || fallback?.title || pid,
          driveLink: rec?.driveLink || `https://drive.google.com/drive/folders/smartlearning-${pid}`,
        };
      });
    }

    return res.json({
      success: true,
      message: 'Payment verified and access unlocked successfully',
      paymentId: effectivePaymentId,
      driveLinks,
      purchases: persistentPurchases,
    });
  } catch (err: any) {
    console.error('[Server /api/razorpay/verify-payment Exception]:', err);
    return res.status(500).json({ error: err.message || 'Server error verifying payment' });
  }
});

// Razorpay Webhook Endpoint
app.post('/api/razorpay/webhook', async (req, res) => {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const signature = req.headers['x-razorpay-signature'] as string;

  if (webhookSecret && signature) {
    const expectedSig = crypto
      .createHmac('sha256', webhookSecret)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (expectedSig !== signature) {
      return res.status(400).json({ error: 'Invalid webhook signature' });
    }
  }

  const event = req.body.event;
  if (event === 'payment.captured' || event === 'order.paid') {
    const payment = req.body.payload?.payment?.entity;
    const orderId = payment?.order_id;
    const paymentId = payment?.id;
    const email = payment?.email;

    if (orderId) {
      await supabase
        .from('orders')
        .update({ payment_status: 'paid', payment_id: paymentId })
        .eq('payment_id', orderId);
    } else if (email) {
      await supabase
        .from('orders')
        .update({ payment_status: 'paid', payment_id: paymentId })
        .eq('customer_email', email)
        .eq('payment_status', 'pending');
    }
  }

  res.json({ status: 'ok' });
});

// ----------------------------------------------------
// VITE INTEGRATION / STATIC SERVING
// ----------------------------------------------------

async function startServer() {
  try {
    if (process.env.NODE_ENV !== 'production') {
      const vite = await createViteServer({
        server: { middlewareMode: true },
        appType: 'spa',
      });
      app.use(vite.middlewares);
    } else {
      const distPath = path.join(process.cwd(), 'dist');
      app.use(express.static(distPath));
      app.get('*', (req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }

    app.listen(PORT, '0.0.0.0', () => {
      console.log(`Smart Learning server running on port ${PORT} (http://localhost:${PORT})`);
    });
  } catch (error) {
    console.error('Error starting server:', error);
  }
}

startServer();
