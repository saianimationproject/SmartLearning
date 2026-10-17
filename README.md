# SmartLearningPoint

SmartLearningPoint is a visual technology-learning website for browsing
and purchasing digital learning materials, notes, and course bundles.
This README is based on the available project context and screenshots.
Confirm implementation-specific filenames, routes, and environment
variable names against the actual source code before deployment.

## Main Features

-   Public navigation for Home, Courses, Learning Lab, Help, and account
    access.
-   Course/product catalog and pricing.
-   User registration and login with email OTP verification.
-   User account records and purchase history.
-   Checkout with full name, course-delivery email, optional coupon
    code, and Razorpay payment.
-   Admin panel for users, courses/products, orders/transactions, and
    coupons.
-   Email delivery for OTPs and intended purchase
    confirmations/course-access links.
-   Course access should be granted only after backend payment
    verification.

## Technology and Services

The available screenshots indicate Hostinger hosting and a MySQL
database managed through phpMyAdmin. Visible database tables include
`auth_users`, `auth_otps`, `coupons`, `orders`, and `products`.

The exact frontend framework, backend language, API routes, and email
library must be confirmed from the source ZIP. Do not assume a planned
technology stack is the one actually implemented.

Services described or shown: - **Database:** MySQL - **Hosting:**
Hostinger - **Payment gateway:** Razorpay - **Email:** Existing SMTP
delivery used for OTP messages

## Purchase Flow

1.  A visitor browses the catalog and selects a course.
2.  If logged out, the visitor signs in or registers and completes email
    OTP verification.
3.  The authenticated user confirms their name and course-delivery
    email.
4.  The user may apply a coupon.
5.  The backend validates the coupon and calculates the amount from
    server-side product data.
6.  The backend creates the payment order and the customer pays through
    Razorpay.
7.  The backend verifies payment before marking the order paid.
8.  The order is associated with the authenticated user's database ID.
9.  After verified payment, the system should email the correct
    course-access link to the selected delivery address.
10. Failed, pending, cancelled, or unverified payments must not grant
    course access.

**Important:** Purchase email delivery has previously been reported as
unreliable. Test it in the deployed environment rather than assuming it
works because checkout succeeds.

## Admin Panel

The admin panel is intended to display records from the same database
used by registration, checkout, and course management. Expected sections
include: - Dashboard and performance metrics - Registered users - Orders
and transactions - Course/product catalog - Coupons and discounts -
Admin settings and database-related tools

Admin data should come from real backend queries, not hardcoded or demo
data. If registration reports that an email already exists but the user
is missing from the admin panel, investigate the database connection,
API endpoint, SQL query, joins, filters, pagination, and status
conditions. Do not create duplicate users to work around a display
issue.

Use **User** rather than **Student** in user-facing and admin-facing
labels.

## Configuration and Secrets

Keep credentials server-side. Never commit production secrets or expose
them in browser code.

Depending on the implementation, configuration may be needed for: -
MySQL host, database name, username, and password - SMTP host, port,
username, password, and sender address - Razorpay key ID and secret -
Application base URL and session/security settings

Use the variable names already expected by the codebase. The following
are illustrative placeholders only, not a guaranteed working
configuration:

``` dotenv
DB_HOST=your_database_host
DB_NAME=your_database_name
DB_USER=your_database_user
DB_PASSWORD=replace_with_secret

SMTP_HOST=your_smtp_host
SMTP_PORT=your_smtp_port
SMTP_USERNAME=your_smtp_username
SMTP_PASSWORD=replace_with_secret
MAIL_FROM=support@smartlearningpoint.com

RAZORPAY_KEY_ID=your_key_id
RAZORPAY_KEY_SECRET=replace_with_secret
APP_BASE_URL=https://your-domain.example
```

Do not put real passwords, API secrets, OTPs, or database credentials in
this README.

## Setup and Deployment

The exact runtime and commands must be confirmed from the project files.
Use this general process:

1.  Extract the project ZIP and preserve its directory structure.
2.  Identify the frontend and backend entry points, dependency files,
    database configuration, and API routes.
3.  Install dependencies using the instructions provided by the project.
4.  Configure the existing database connection with the correct hosting
    credentials.
5.  Verify that the target is the intended database before running
    migrations or SQL scripts.
6.  Configure SMTP and Razorpay credentials using secure server-side
    settings.
7.  Deploy to the correct hosting directory and confirm the configured
    document root.
8.  Test registration, OTP delivery, course browsing, checkout, coupons,
    payment verification, order storage, course access, and
    purchase-email delivery.
9.  Review application and server logs. Never log passwords, full OTP
    values, or payment secrets.

Do not import a fresh/empty database over the production database. Do
not run destructive SQL, reset tables, or create replacement tables
without reviewing the schema and making a backup.

## Database Integrity and Admin Synchronization

-   Registration, login, checkout, and admin views must use the intended
    database consistently.
-   Existing users, products, orders, and coupons should be displayed
    from real database records.
-   Admin counts should match the underlying query results, with
    intentional filters clearly understood.
-   Avoid duplicate user or order creation.
-   Preserve existing records when transferring the project between AI
    Studio accounts or hosting environments.
-   A code ZIP does not necessarily include the live database or hosting
    secrets. Database data and configuration must be transferred or
    reconnected separately and securely.

## Payment and Email Security

-   Require authentication on backend order-creation and payment
    endpoints.
-   Calculate prices and discounts on the server.
-   Verify Razorpay payment signatures and status on the server.
-   Make payment callbacks idempotent to prevent duplicate orders and
    repeated delivery.
-   Send course-access emails only after verified payment.
-   Store email-delivery status and provide a safe retry that does not
    charge the customer again.
-   Retrieve the correct course link from existing product/course data.
-   Do not return OTP values from public APIs or expose test OTPs in
    production responses.
-   Do not expose permanent course files or secret keys in public
    frontend code.

## Verification Checklist

-   [ ] Registration creates or updates the intended user record without
    duplicates.
-   [ ] Existing users can log in using the real OTP flow.
-   [ ] OTP emails arrive and the OTP is not returned by the public API.
-   [ ] The admin panel displays existing users from the live database.
-   [ ] The admin panel displays the actual course/product catalog.
-   [ ] Orders and transactions match database records.
-   [ ] Coupons reflect real eligibility, expiry, and usage limits.
-   [ ] Logged-out visitors cannot create orders through direct API
    requests.
-   [ ] Checkout does not require a mobile number if configured for the
    current purchase flow.
-   [ ] Valid and invalid coupons behave correctly.
-   [ ] Failed or unverified payments do not grant access or trigger
    delivery.
-   [ ] Successful payments are recorded once and grant only the
    purchased course.
-   [ ] The course-access email reaches the selected delivery email
    address.
-   [ ] Email failures can be retried without another charge or
    duplicate order.
-   [ ] Existing pages and unrelated functionality still work.

Only mark tests as passed after actually running them.

## Troubleshooting

### Email says "already registered," but the user is missing from the admin panel

Check whether registration and the admin panel use the same database
host and database name. Inspect the admin API response, SQL query,
filters, pagination, joins, and table/column names. Compare the MySQL
record with the response returned to the admin UI.

### OTP emails are not arriving

Check SMTP host and port, credentials, TLS/SSL mode, sender
verification, provider limits, spam folders, and server logs. Do not
expose SMTP credentials while debugging.

### Payment succeeds, but no course email arrives

Check the server-side payment-verification result, order status,
email-trigger execution, SMTP response, recipient address, course-link
data, and stored email-delivery status. A browser success screen alone
does not prove payment was verified. Retry email delivery without
repeating payment.

### Admin totals do not match database records

Check SQL aggregation, joins, status filters, date ranges, pagination,
and whether the API is connected to production rather than a development
database.

## Project-Specific Details to Confirm

Fill these in after inspecting the source code: - Frontend entry point:
`TODO` - Backend/API entry point: `TODO` - Runtime and dependency
installation command: `TODO` - Admin route and relevant API endpoint:
`TODO` - Database configuration file/environment variable names:
`TODO` - OTP sending and verification endpoints: `TODO` - Razorpay
order-creation and payment-verification endpoints: `TODO` - Purchase
email-sending implementation: `TODO` - Course-access link field or
source: `TODO` - Deployment/build command: `TODO`

------------------------------------------------------------------------

**Security note:** Keep production database credentials, SMTP passwords,
Razorpay secrets, session secrets, and customer data out of source
control and documentation.
