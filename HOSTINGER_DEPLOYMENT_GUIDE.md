# Hostinger Deployment Guide for Smart Learning App

This guide explains how to deploy the **Smart Learning** application to **Hostinger** step-by-step.

---

## 🚀 Option 1: Hostinger Node.js Application / VPS (Recommended for Full-Stack)

Use this option if you have **Hostinger Cloud Hosting with Node.js support** or a **Hostinger VPS**. This runs both the frontend and backend server (for Razorpay order creation, API validation, and dynamic coupons).

### Step 1: Export or Clone the Project
1. Download the ZIP from AI Studio Settings -> Export, or push the repository to GitHub.
2. If using GitHub, in your Hostinger panel / VPS terminal, clone the repo:
   ```bash
   git clone <your-repo-url>
   cd <repo-folder>
   ```

### Step 2: Install Dependencies & Build
Run the following commands:
```bash
npm install
npm run build
```
This will compile the frontend assets into `dist/` and create the self-contained backend server file `dist/server.cjs`.

### Step 3: Configure Environment Variables
Create a `.env` file in the root directory (refer to `.env.example`):
```env
NODE_ENV=production
PORT=3000

# Supabase Credentials
VITE_SUPABASE_URL=https://ietfnftofqjggdpnbyqu.supabase.co
VITE_SUPABASE_ANON_KEY=sb_publishable_G22GDR0Op-TUdhTICSSxQg__3W_twkF
SUPABASE_URL=https://ietfnftofqjggdpnbyqu.supabase.co
SUPABASE_PUBLISHABLE_KEY=sb_publishable_G22GDR0Op-TUdhTICSSxQg__3W_twkF

# Razorpay Payment Gateway (Live or Test)
RAZORPAY_KEY_ID=rzp_test_TSY8uI0VbGFVrb
RAZORPAY_KEY_SECRET=iejosFE6X1yt0ke1Rp09GD82
VITE_RAZORPAY_KEY_ID=rzp_test_TSY8uI0VbGFVrb
```

### Step 4: Start the Production Server with PM2
If PM2 is installed on your server:
```bash
npm install -g pm2
pm2 start ecosystem.config.cjs
pm2 save
pm2 startup
```
Or start directly:
```bash
npm run start
```

---

## 🌐 Option 2: Hostinger Shared Web Hosting (Static SPA Deployment)

Use this option if you are using standard **Hostinger Web Hosting (hPanel)** where you upload static files directly to `public_html`.

### Step 1: Build the Static Bundle Locally
On your local machine, run:
```bash
npm install
npm run build
```
This generates the `dist/` directory, which includes:
- `index.html`
- `assets/` (bundled JS & CSS)
- `.htaccess` (pre-configured for Hostinger LiteSpeed/Apache routing)

### Step 2: Upload to Hostinger `public_html`
1. Log in to your **Hostinger hPanel**.
2. Go to **Websites** -> Manage -> **File Manager**.
3. Open the `public_html` directory of your domain.
4. Upload all files and folders from inside the `dist/` directory into `public_html`.
5. Ensure the `.htaccess` file is present in `public_html`. This ensures that routes like `/checkout`, `/admin`, and `/courses` resolve without 404 errors.

---

## ⚙️ Post-Deployment Verification Checklist

1. **Test Navigation**: Visit your domain (`https://yourdomain.com`), and navigate to `/admin`, `/checkout`, etc. Refresh the page to verify `.htaccess` routing.
2. **Test 100% Free Coupon**: Apply coupon `FREE100` on the checkout page to confirm instant zero-cost Google Drive link unlocking.
3. **Test Payment Gateway**: If using Razorpay, perform a test transaction to verify modal display and order recording in Supabase.
