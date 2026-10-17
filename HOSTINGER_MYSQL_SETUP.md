# Hostinger MySQL Database & Authentication Setup Guide

Your app is configured to connect to your **Hostinger MySQL Database** (`u272917491_SmartLearning`) using lightweight PHP backend API endpoints (`/api/auth.php`, `/api/orders.php`, `/api/coupons.php`, `/api/products.php`).

---

## 📋 Your Database Credentials:
- **MySQL Database**: `u272917491_SmartLearning`
- **MySQL User**: `u272917491_smartlearning`
- **MySQL Host**: `localhost`
- **Password**: *(The password you created in Hostinger hPanel)*

---

## 🛠️ Step 1: Import or Update Tables in Hostinger phpMyAdmin

1. Log in to **[Hostinger hPanel](https://hpanel.hostinger.com/)**.
2. Go to **Databases** &rarr; **Management**.
3. Find your database `u272917491_SmartLearning` and click **Enter phpMyAdmin**.
4. Click on the **SQL** tab at the top.
5. Paste the following SQL script and click **Go**:

```sql
-- 1. ORDERS TABLE
CREATE TABLE IF NOT EXISTS orders (
  id VARCHAR(100) PRIMARY KEY,
  product_id VARCHAR(100) NOT NULL,
  customer_name VARCHAR(255) NOT NULL,
  customer_email VARCHAR(255) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  currency VARCHAR(10) DEFAULT 'USD',
  payment_id VARCHAR(150),
  payment_status VARCHAR(50) DEFAULT 'paid',
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_customer_email (customer_email),
  INDEX idx_product_id (product_id),
  INDEX idx_payment_id (payment_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 2. PRODUCTS TABLE
CREATE TABLE IF NOT EXISTS products (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  price DECIMAL(10, 2) NOT NULL DEFAULT 0.00,
  price_inr DECIMAL(10, 2) DEFAULT NULL,
  price_usd DECIMAL(10, 2) DEFAULT NULL,
  google_drive_link TEXT DEFAULT NULL,
  purchase_count INT DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 3. COUPONS TABLE
CREATE TABLE IF NOT EXISTS coupons (
  id VARCHAR(100) PRIMARY KEY,
  code VARCHAR(100) UNIQUE NOT NULL,
  discount_percent DECIMAL(5, 2) NOT NULL DEFAULT 20.00,
  target_type VARCHAR(50) DEFAULT 'all',
  target_course_id VARCHAR(100) DEFAULT NULL,
  target_course_title VARCHAR(255) DEFAULT NULL,
  description TEXT DEFAULT NULL,
  usage_limit INT DEFAULT NULL,
  usage_count INT DEFAULT 0,
  is_active TINYINT(1) DEFAULT 1,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 4. USERS AUTHENTICATION TABLE (Password-Backed & OTP Verified)
CREATE TABLE IF NOT EXISTS users (
  id VARCHAR(100) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  phone VARCHAR(50) NOT NULL,
  email VARCHAR(255) NOT NULL UNIQUE,
  password_hash VARCHAR(255) DEFAULT NULL,
  reset_otp VARCHAR(20) DEFAULT NULL,
  reset_otp_expires DATETIME DEFAULT NULL,
  is_verified TINYINT(1) DEFAULT 1,
  verified_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_email (email),
  INDEX idx_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- If users table already exists, run these migration lines:
ALTER TABLE users ADD COLUMN IF NOT EXISTS password_hash VARCHAR(255) DEFAULT NULL AFTER email;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_otp VARCHAR(20) DEFAULT NULL AFTER password_hash;
ALTER TABLE users ADD COLUMN IF NOT EXISTS reset_otp_expires DATETIME DEFAULT NULL AFTER reset_otp;
```

---

## 📧 Step 2: Configure Hostinger SMTP for Email Delivery

To send real verification codes and password reset OTPs from your custom domain:

1. In **Hostinger hPanel**, go to **Emails** &rarr; **Email Accounts**.
2. Create or find your mailbox (e.g., `support@smartlearningpoint.com` or `admin@yourdomain.com`).
3. Note your email address and password.
4. Open **`api/config.php`** (either in `public/api/config.php` before build, or in `public_html/api/config.php` on Hostinger):
   ```php
   // Hostinger SMTP Email Configuration
   define('SMTP_HOST', 'smtp.hostinger.com');
   define('SMTP_PORT', 465); // 465 for SSL, or 587 for TLS
   define('SMTP_USER', 'support@smartlearningpoint.com'); // Your Hostinger webmail
   define('SMTP_PASS', 'YOUR_EMAIL_ACCOUNT_PASSWORD');   // Your mailbox password
   define('SMTP_FROM_EMAIL', 'support@smartlearningpoint.com');
   define('SMTP_FROM_NAME', 'Smart Learning');
   ```

---

## 🔐 Step 3: Set your MySQL Password in `api/config.php`

In **`api/config.php`**, ensure your database password matches the one set in Hostinger:
```php
define('DB_HOST', 'localhost');
define('DB_NAME', 'u272917491_SmartLearning');
define('DB_USER', 'u272917491_smartlearning');
define('DB_PASS', 'JnkvV6266#'); // Put your actual database password here
```

---

## 🚀 Step 4: Build & Upload to Hostinger `public_html`

1. Build the production files:
   ```bash
   npm run build
   ```
2. Upload the contents of the `dist/` directory into your Hostinger `public_html`:
   - `index.html`
   - `.htaccess`
   - `assets/` directory
   - `api/` directory (`config.php`, `auth.php`, `orders.php`, `coupons.php`, `products.php`)
   - `database.sql`

---

## 🔒 Authentication Flow Summary

- **Login Tab**: Users enter their registered Email & Password to log in directly without requiring OTP every time. Password hashes are verified securely in PHP (`password_verify`) and Node (`scryptSync`).
- **Create Account Tab**: All inputs start clean and empty (no prefilled names/emails). New users provide Full Name, Phone with Country Code, Email, and Password. Email duplication is strictly prevented.
- **Forgot Password**: Users can enter their registered email to receive a 6-digit verification code and reset their password securely.
