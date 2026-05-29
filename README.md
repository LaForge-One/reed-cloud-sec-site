# Reed Technology Group Landing Page

Static landing page with a small Node.js server for inquiry handling.

The site is also ready for Cloudflare Pages using Pages Functions.

## Run Locally

```bash
node server.js
```

Open:

```text
http://localhost:4180
```

Do not test the inquiry form from `file://.../index.html`. The static file can load in a browser, but `/api/inquiry` only exists when the Node server, Cloudflare Pages Function, or another backend is running.

If the browser shows `file:///api/inquiry`, the page was opened from the filesystem instead of the HTTP server. Start `server.js` and open `http://localhost:4180/index.html#inquiry-form`.

## Inquiry Form

The form posts to `/api/inquiry`.

All inquiries are routed server-side to:

```text
marsel@reedcloudsec.com
```

If SMTP credentials are not configured, submissions are saved to `outbox/` for local testing.

When SMTP is configured, each inquiry is sent to `marsel@reedcloudsec.com` as a readable email with a PDF inquiry document attached.

The inquiry endpoint includes basic production safeguards: required-field validation, email-format checks, length limits, a hidden spam trap, request body limits, security headers, and local in-memory rate limiting.

## VPS Production Notes

For a virtual private server, run the Node server behind a reverse proxy such as Nginx or Caddy with HTTPS enabled. Bind Node to localhost when using a reverse proxy:

```bash
HOST=127.0.0.1 \
PORT=4180 \
REQUIRE_SMTP=true \
SMTP_HOST=smtp.protonmail.ch \
SMTP_PORT=587 \
SMTP_USER=marsel@reedcloudsec.com \
SMTP_PASS=your-proton-smtp-token \
EMAIL_FROM=marsel@reedcloudsec.com \
node server.js
```

Keep `SMTP_PASS` in environment variables, a systemd environment file, or your hosting provider's secret manager. Do not place the real SMTP token in source files, zip archives, screenshots, or git history.

Do not point Nginx or Apache directly at this full project folder as a static web root. The Node server intentionally exposes only `index.html`, `styles.css`, and `assets/`; source files such as `server.js`, `README.md`, `wrangler.toml`, and `functions/` should stay server-side only.

Recommended reverse-proxy protections:

```text
HTTPS certificate
HTTP to HTTPS redirect
POST rate limit on /api/inquiry
Access and error logging
Automatic service restart
```

### VPS Smoke Test

After deploying, verify the public site and inquiry route over HTTPS:

```bash
curl -I https://your-domain.example/index.html
curl -I https://your-domain.example/api/inquiry
curl -i -X POST https://your-domain.example/api/inquiry \
  -d "name=Launch Test" \
  -d "email=test@example.com" \
  -d "company=Example Co" \
  -d "title=IT Director" \
  -d "inquiryType=Cloud security review" \
  -d "message=Production smoke test"
```

Expected results:

```text
GET /index.html       200 OK
GET /api/inquiry     302 redirect to /index.html#inquiry-form
POST /api/inquiry    200 OK with the inquiry confirmation page
```

## Cloudflare Pages Deployment

Use this option only if you want Cloudflare Pages instead of the VPS Node deployment.

Required files:

```text
index.html
styles.css
assets/
functions/api/inquiry.js
wrangler.toml
```

Cloudflare Pages will serve the static site and route `POST /api/inquiry` to the Pages Function.

Do not deploy the full project folder as the public Pages asset directory. Public assets should include only `index.html`, `styles.css`, and `assets/`; keep `server.js`, `README.md`, `wrangler.toml`, `.dev.vars`, and other source/config files outside the public asset output.

### Cloudflare Variables

The following non-secret values are already set in `wrangler.toml`:

```text
SMTP_HOST=smtp.protonmail.ch
SMTP_PORT=587
SMTP_USER=marsel@reedcloudsec.com
EMAIL_FROM=marsel@reedcloudsec.com
```

Add the Proton SMTP token as a Cloudflare Pages secret:

```text
SMTP_PASS
```

Do not commit the real token to source control.

### Deploy

Create a public asset directory, then deploy it with the Pages Function from the project:

```bash
mkdir -p public
cp index.html styles.css public/
cp -R assets public/
npx wrangler pages deploy public --project-name reed-technology-group
```

For local Cloudflare-style testing:

```bash
cp .dev.vars.example .dev.vars
# edit .dev.vars and set SMTP_PASS
npx wrangler pages dev public --functions functions --port 8788
```

To send real email, run the server with SMTP environment variables:

```bash
SMTP_HOST=smtp.example.com \
SMTP_PORT=587 \
SMTP_USER=your-user \
SMTP_PASS=your-password \
EMAIL_FROM=marsel@reedcloudsec.com \
REQUIRE_SMTP=true \
node server.js
```

For Proton SMTP:

```bash
SMTP_HOST=smtp.protonmail.ch \
SMTP_PORT=587 \
SMTP_USER=marsel@reedcloudsec.com \
SMTP_PASS=your-proton-smtp-token \
EMAIL_FROM=marsel@reedcloudsec.com \
REQUIRE_SMTP=true \
node server.js
```

Optional:

```bash
SMTP_SECURE=true
SMTP_STARTTLS=false
PORT=4180
REQUIRE_SMTP=true
```
