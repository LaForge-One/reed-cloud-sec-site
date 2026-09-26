const http = require("node:http");
const fs = require("node:fs/promises");
const { createReadStream } = require("node:fs");
const path = require("node:path");
const { StringDecoder } = require("node:string_decoder");
const dns = require("node:dns/promises");
const nodemailer = require("nodemailer");

const root = __dirname;
const port = Number(process.env.PORT || 4180);
const host = process.env.HOST || "0.0.0.0";
const emailTo = "support@reedcloudsec.com";
const emailFrom = process.env.EMAIL_FROM || emailTo;
const maxBodyBytes = 100_000;
const rateLimitWindowMs = Number(process.env.RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const rateLimitMax = Number(process.env.RATE_LIMIT_MAX || 5);
const rateLimitStore = new Map();
const requireSmtp = process.env.REQUIRE_SMTP === "true" || process.env.NODE_ENV === "production";

const securityHeaders = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'sha256-7y6ZoRyHcqvmhgfO5Vn4aOceGf0bvrYIYH4ngO6dK5E='; script-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

const contentTypes = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".mp4": "video/mp4",
};

function withSecurityHeaders(headers = {}) {
  return { ...securityHeaders, ...headers };
}

function cacheControlFor(relativePath) {
  return relativePath === "index.html" ? "no-cache" : "public, max-age=300, must-revalidate";
}

function isPublicPath(relativePath) {
  return (
    relativePath === "index.html" ||
    relativePath === "styles.css" ||
    relativePath === "redesign.css" ||
    relativePath === "favicon.ico" ||
    relativePath === "robots.txt" ||
    relativePath === "sitemap.xml" ||
    relativePath.startsWith(`assets${path.sep}`)
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseForm(body) {
  const params = new URLSearchParams(body);
  return {
    name: (params.get("name") || "").trim(),
    email: (params.get("email") || "").trim(),
    company: (params.get("company") || "").trim(),
    title: (params.get("title") || "").trim(),
    inquiryType: (params.get("inquiryType") || "").trim(),
    message: (params.get("message") || "").trim(),
    website: (params.get("website") || "").trim(),
    phone: (params.get("phone") || "").trim(),
  };
}

function validateInquiry(inquiry) {
  if (inquiry.website || inquiry.phone) return "Unable to process inquiry.";
  if (!inquiry.name || !inquiry.email || !inquiry.message)
    return "Name, email, and project notes are required.";
  if (inquiry.name.length > 120) return "Name is too long.";
  if (inquiry.email.length > 254) return "Email is too long.";
  if (inquiry.company.length > 160) return "Company is too long.";
  if (inquiry.title.length > 160) return "Title is too long.";
  if (inquiry.inquiryType.length > 120) return "Service need is too long.";
  if (inquiry.message.length > 5000) return "Project notes are too long.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inquiry.email))
    return "Please enter a valid email address.";
  return "";
}

// Flags obvious keyboard-mash / bot-generated text: real English runs roughly
// 35-45% vowels and rarely stacks more than ~4 consonants in a row. Gibberish
// like "Egjnjmfnefjwdifj fkmdkdwdwkdwjj" is well outside both, so the
// thresholds below are set loose enough to leave genuine (even terse or
// non-native) writing alone while still catching that pattern.
function looksLikeGibberish(text) {
  const letters = text.replace(/[^a-zA-Z]/g, "");
  if (letters.length < 8) return false;
  const vowels = (letters.match(/[aeiouAEIOU]/g) || []).length;
  const vowelRatio = vowels / letters.length;
  const longestConsonantRun = Math.max(
    0,
    ...(text.match(/[b-df-hj-np-tv-zB-DF-HJ-NP-TV-Z]+/g) || []).map((run) => run.length)
  );
  // Some generators pad in stray vowels specifically to dodge a ratio check,
  // so also catch the tell their output still can't hide: no real English
  // word (even compound/technical ones like "internationalization") runs
  // past 20 letters unbroken. Split on slashes/hyphens too, since real
  // titles like "Infrastructure/DevOps" use those as word boundaries.
  const longestWord = Math.max(
    0,
    ...text.split(/[\s/&,-]+/).map((word) => word.replace(/[^a-zA-Z]/g, "").length)
  );
  return vowelRatio < 0.25 || longestConsonantRun >= 6 || longestWord > 20;
}

function inquiryLooksLikeSpam(inquiry) {
  return (
    looksLikeGibberish(inquiry.name) ||
    looksLikeGibberish(inquiry.title) ||
    looksLikeGibberish(inquiry.message)
  );
}

// Confirms the email's domain can actually receive mail (has MX records, or
// at least an A/AAAA as a legacy fallback) before we forward the inquiry.
// Catches typo'd and fabricated domains without maintaining a blocklist.
async function emailDomainIsDeliverable(email) {
  const domain = email.split("@")[1];
  if (!domain) return false;
  try {
    const mx = await dns.resolveMx(domain);
    if (mx.length > 0) return true;
  } catch {
    // fall through to A/AAAA fallback below
  }
  try {
    const a = await dns.resolve4(domain).catch(() => []);
    const aaaa = await dns.resolve6(domain).catch(() => []);
    return a.length > 0 || aaaa.length > 0;
  } catch {
    return false;
  }
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.socket.remoteAddress || "unknown";
}

function rateLimitExceeded(req) {
  const now = Date.now();
  const ip = clientIp(req);
  const record = rateLimitStore.get(ip) || { count: 0, resetAt: now + rateLimitWindowMs };
  if (record.resetAt <= now) {
    record.count = 0;
    record.resetAt = now + rateLimitWindowMs;
  }
  record.count += 1;
  rateLimitStore.set(ip, record);
  for (const [key, value] of rateLimitStore) {
    if (value.resetAt <= now) rateLimitStore.delete(key);
  }
  return record.count > rateLimitMax;
}

function sanitizeHeader(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

function pdfText(value) {
  return String(value).replace(/[^\t\n\r -~]/g, "?");
}

function escapePdfText(value) {
  return pdfText(value).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function wrapLine(value, width = 88) {
  const words = pdfText(value).split(/\s+/);
  const lines = [];
  let line = "";
  for (const word of words) {
    if (!word) continue;
    if (!line) {
      line = word;
    } else if (`${line} ${word}`.length <= width) {
      line += ` ${word}`;
    } else {
      lines.push(line);
      line = word;
    }
  }
  if (line) lines.push(line);
  return lines.length ? lines : [""];
}

function createPdf(lines) {
  const content = [
    "BT",
    "/F1 11 Tf",
    "54 742 Td",
    "14 TL",
    ...lines.flatMap((line, index) => [
      `${index === 0 ? "" : "T* "}(${escapePdfText(line)}) Tj`.trim(),
    ]),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content, "ascii")} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(pdf, "ascii"));
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = Buffer.byteLength(pdf, "ascii");
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, "ascii");
}

function buildInquiryPdf(inquiry, receivedAt) {
  const company = inquiry.company || "Company not provided";
  const title = inquiry.title || "Title not provided";
  const inquiryType = inquiry.inquiryType || "General inquiry";
  const messageLines = pdfText(inquiry.message)
    .split(/\r?\n/)
    .flatMap((line) => wrapLine(line));
  const lines = [
    "Reed Technology Group",
    "Website Inquiry",
    "",
    "Summary",
    `Service Need: ${inquiryType}`,
    `Company: ${company}`,
    `Received: ${receivedAt}`,
    "",
    "Contact",
    `Name: ${inquiry.name}`,
    `Title: ${title}`,
    `Email: ${inquiry.email}`,
    "",
    "Message",
    ...messageLines,
    "",
    `Routed To: ${emailTo}`,
    "Source: reedcloudsec.com inquiry form",
  ];
  return createPdf(lines.slice(0, 48));
}

function buildEmail(inquiry) {
  const company = inquiry.company || "Company not provided";
  const title = inquiry.title || "Title not provided";
  const inquiryType = inquiry.inquiryType || "General inquiry";
  const receivedAt = new Date().toISOString();
  const subject = sanitizeHeader(`Website inquiry: ${inquiryType} - ${inquiry.name}`);
  const text = [
    "NEW WEBSITE INQUIRY",
    "Reed Technology Group",
    "==============================",
    "",
    "SUMMARY",
    `Service Need: ${inquiryType}`,
    `Company: ${company}`,
    `Received: ${receivedAt}`,
    "",
    "CONTACT",
    `Name: ${inquiry.name}`,
    `Title: ${title}`,
    `Email: ${inquiry.email}`,
    `Reply-To: ${inquiry.email}`,
    "",
    "MESSAGE",
    "------------------------------",
    inquiry.message,
    "",
    "------------------------------",
    `Routed To: ${emailTo}`,
    "Source: reedcloudsec.com inquiry form",
  ].join("\n");

  const pdfBytes = buildInquiryPdf(inquiry, receivedAt);
  const pdfFilename = `rtg-inquiry-${receivedAt.replace(/[:.]/g, "-")}.pdf`;
  return { subject, text, pdfBytes, pdfFilename };
}

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function createTransport() {
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const secure = process.env.SMTP_SECURE === "true" || smtpPort === 465;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: smtpPort,
    secure,
    requireTLS: !secure && process.env.SMTP_STARTTLS !== "false",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
    tls: {
      rejectUnauthorized: process.env.SMTP_TLS_REJECT_UNAUTHORIZED !== "false",
    },
  });
}

async function sendSmtp({ subject, text, replyTo, pdfBytes, pdfFilename }) {
  const transporter = createTransport();
  await transporter.sendMail({
    from: `Reed Technology Group Website <${emailFrom}>`,
    to: emailTo,
    replyTo,
    subject,
    text,
    attachments: [
      {
        filename: pdfFilename,
        content: pdfBytes,
        contentType: "application/pdf",
      },
    ],
  });
}

async function saveLocalInquiry(inquiry, email) {
  const outbox = path.join(root, "outbox");
  await fs.mkdir(outbox, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const textFile = path.join(outbox, `${stamp}-inquiry.txt`);
  const pdfFile = path.join(outbox, `${stamp}-inquiry.pdf`);
  await fs.writeFile(textFile, email.text, "utf8");
  await fs.writeFile(pdfFile, email.pdfBytes);
  return { textFile, pdfFile };
}

// Flagged submissions never reach support@ or get emailed/PDF'd, but they are
// still recorded here so a human can spot-check for false positives.
async function saveSpamLog(inquiry, reason, req) {
  const spamDir = path.join(root, "spam-log");
  await fs.mkdir(spamDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const record = {
    receivedAt: new Date().toISOString(),
    reason,
    ip: clientIp(req),
    inquiry,
  };
  await fs.writeFile(
    path.join(spamDir, `${stamp}-flagged.json`),
    JSON.stringify(record, null, 2),
    "utf8"
  );
}

function successPage() {
  const status =
    "Your inquiry has been received. Reed Technology Group will review it and follow up soon.";
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta http-equiv="refresh" content="5; url=/index.html" />
    <title>Inquiry Received | Reed Technology Group</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="response-page">
      <section class="response-card">
        <p class="section-kicker">Inquiry Received</p>
        <h1>Thank you.</h1>
        <p>${escapeHtml(status)}</p>
        <p class="response-note">You will be redirected back to the home page shortly.</p>
        <a class="button primary" href="/index.html#inquiry-form">Back to Site</a>
      </section>
    </main>
  </body>
</html>`;
}

function errorPage(message) {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Inquiry Error | Reed Technology Group</title>
    <link rel="stylesheet" href="/styles.css" />
  </head>
  <body>
    <main class="response-page">
      <section class="response-card">
        <p class="section-kicker">Inquiry Error</p>
        <h1>Please try again.</h1>
        <p>${escapeHtml(message)}</p>
        <a class="button primary" href="/index.html#inquiry-form">Back to Form</a>
      </section>
    </main>
  </body>
</html>`;
}

async function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8");
    let body = "";
    req.on("data", (chunk) => {
      body += decoder.write(chunk);
      if (body.length > maxBodyBytes) {
        reject(new Error("Request body is too large."));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body + decoder.end()));
    req.on("error", reject);
  });
}

async function handleInquiry(req, res) {
  try {
    if (rateLimitExceeded(req)) {
      res.writeHead(429, withSecurityHeaders({ "Content-Type": "text/html; charset=utf-8" }));
      res.end(errorPage("Too many inquiries were submitted. Please wait a few minutes and try again."));
      return;
    }

    const body = await readRequestBody(req);
    const inquiry = parseForm(body);
    const validationError = validateInquiry(inquiry);
    if (validationError) {
      res.writeHead(400, withSecurityHeaders({ "Content-Type": "text/html; charset=utf-8" }));
      res.end(errorPage(validationError));
      return;
    }

    if (inquiryLooksLikeSpam(inquiry)) {
      await saveSpamLog(inquiry, "gibberish-text", req);
      console.warn(`Inquiry flagged as spam (gibberish text) from ${clientIp(req)}`);
      res.writeHead(200, withSecurityHeaders({ "Content-Type": "text/html; charset=utf-8" }));
      res.end(successPage());
      return;
    }

    if (!(await emailDomainIsDeliverable(inquiry.email))) {
      await saveSpamLog(inquiry, "email-domain-not-deliverable", req);
      console.warn(`Inquiry flagged as spam (bad email domain) from ${clientIp(req)}: ${inquiry.email}`);
      res.writeHead(200, withSecurityHeaders({ "Content-Type": "text/html; charset=utf-8" }));
      res.end(successPage());
      return;
    }

    const email = buildEmail(inquiry);

    if (smtpConfigured()) {
      await sendSmtp({ ...email, replyTo: inquiry.email });
      console.log(`Inquiry emailed to ${emailTo} with PDF attachment ${email.pdfFilename}`);
      res.writeHead(200, withSecurityHeaders({ "Content-Type": "text/html; charset=utf-8" }));
      res.end(successPage());
      return;
    }

    if (requireSmtp) {
      console.error("Inquiry delivery failed: SMTP is required but not configured.");
      res.writeHead(500, withSecurityHeaders({ "Content-Type": "text/html; charset=utf-8" }));
      res.end(errorPage("Email service is not configured."));
      return;
    }

    const files = await saveLocalInquiry(inquiry, email);
    console.log(`Inquiry saved to file archive: ${files.textFile}`);
    console.log(`Inquiry PDF saved to file archive: ${files.pdfFile}`);
    res.writeHead(200, withSecurityHeaders({ "Content-Type": "text/html; charset=utf-8" }));
    res.end(successPage());
  } catch (error) {
    console.error("Inquiry handler error:", error);
    const status = error.message === "Request body is too large." ? 413 : 500;
    res.writeHead(status, withSecurityHeaders({ "Content-Type": "text/html; charset=utf-8" }));
    res.end(errorPage("The inquiry could not be processed."));
  }
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  let pathname;
  try {
    pathname = decodeURIComponent(requestUrl.pathname);
  } catch {
    res.writeHead(400, withSecurityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    res.end("Bad request");
    return;
  }

  if (pathname === "/") pathname = "index.html";
  pathname = pathname.replace(/^\/+/, "");
  const filePath = path.resolve(root, pathname);
  const relativePath = path.relative(root, filePath);

  if (
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath) ||
    !isPublicPath(relativePath)
  ) {
    res.writeHead(403, withSecurityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    res.end("Forbidden");
    return;
  }

  const ext = path.extname(filePath);
  const contentType = contentTypes[ext] || "application/octet-stream";

  try {
    const stat = await fs.stat(filePath);
    const lastModified = stat.mtime.toUTCString();
    const cacheHeaders = {
      "Cache-Control": cacheControlFor(relativePath),
      "Last-Modified": lastModified,
    };

    const ifModifiedSince = req.headers["if-modified-since"];
    if (
      ifModifiedSince &&
      Math.floor(new Date(ifModifiedSince).getTime() / 1000) >= Math.floor(stat.mtimeMs / 1000)
    ) {
      res.writeHead(304, withSecurityHeaders(cacheHeaders));
      res.end();
      return;
    }

    const range = req.headers.range;

    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      const start = match && match[1] ? Number(match[1]) : 0;
      const end = match && match[2] ? Number(match[2]) : stat.size - 1;

      if (!match || start > end || end >= stat.size) {
        res.writeHead(416, withSecurityHeaders({ "Content-Range": `bytes */${stat.size}` }));
        res.end();
        return;
      }

      res.writeHead(
        206,
        withSecurityHeaders({
          ...cacheHeaders,
          "Content-Type": contentType,
          "Content-Range": `bytes ${start}-${end}/${stat.size}`,
          "Accept-Ranges": "bytes",
          "Content-Length": end - start + 1,
        }),
      );
      if (req.method === "HEAD") {
        res.end();
        return;
      }
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    res.writeHead(
      200,
      withSecurityHeaders({
        ...cacheHeaders,
        "Content-Type": contentType,
        "Content-Length": stat.size,
        "Accept-Ranges": "bytes",
      }),
    );
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    createReadStream(filePath).pipe(res);
  } catch {
    res.writeHead(404, withSecurityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
    res.end("Not found");
  }
}

const server = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);

  if (requestUrl.pathname === "/api/inquiry" && req.method === "POST") {
    handleInquiry(req, res);
    return;
  }

  if (requestUrl.pathname === "/api/inquiry" && req.method === "GET") {
    res.writeHead(302, withSecurityHeaders({ Location: "/index.html#inquiry-form" }));
    res.end();
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res);
    return;
  }

  res.writeHead(405, withSecurityHeaders({ "Content-Type": "text/plain; charset=utf-8" }));
  res.end("Method not allowed");
});

server.listen(port, host, () => {
  const mode = smtpConfigured()
    ? "SMTP send mode"
    : requireSmtp
      ? "SMTP required but not configured"
      : "file archive mode";
  console.log(`Reed Technology Group site running at http://${host}:${port}`);
  console.log(`Inquiry endpoint: /api/inquiry (${mode})`);
});
