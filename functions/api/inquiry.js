import { connect } from "cloudflare:sockets";

const EMAIL_TO = "marsel@reedcloudsec.com";
const MAX_BODY_BYTES = 100_000;
const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; upgrade-insecure-requests",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
};

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function parseInquiry(formData) {
  return {
    name: String(formData.get("name") || "").trim(),
    email: String(formData.get("email") || "").trim(),
    company: String(formData.get("company") || "").trim(),
    title: String(formData.get("title") || "").trim(),
    inquiryType: String(formData.get("inquiryType") || "").trim(),
    message: String(formData.get("message") || "").trim(),
    website: String(formData.get("website") || "").trim(),
  };
}

function validateInquiry(inquiry) {
  if (inquiry.website) return "Unable to process inquiry.";
  if (!inquiry.name || !inquiry.email || !inquiry.message) {
    return "Name, email, and project notes are required.";
  }
  if (inquiry.name.length > 120) return "Name is too long.";
  if (inquiry.email.length > 254) return "Email is too long.";
  if (inquiry.company.length > 160) return "Company is too long.";
  if (inquiry.title.length > 160) return "Title is too long.";
  if (inquiry.inquiryType.length > 120) return "Service need is too long.";
  if (inquiry.message.length > 5000) return "Project notes are too long.";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(inquiry.email)) {
    return "Please enter a valid email address.";
  }
  return "";
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
  const encoder = new TextEncoder();
  const content = [
    "BT",
    "/F1 11 Tf",
    "54 742 Td",
    "14 TL",
    ...lines.flatMap((line, index) => [
      `${index === 0 ? "" : "T* " }(${escapePdfText(line)}) Tj`.trim(),
    ]),
    "ET",
  ].join("\n");

  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];

  let pdf = "%PDF-1.4\n";
  const offsets = [0];

  objects.forEach((object, index) => {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });

  const xrefOffset = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += "0000000000 65535 f \n";
  for (let index = 1; index < offsets.length; index += 1) {
    pdf += `${String(offsets[index]).padStart(10, "0")} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`;
  pdf += `startxref\n${xrefOffset}\n%%EOF\n`;

  return encoder.encode(pdf);
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
    `Routed To: ${EMAIL_TO}`,
    "Source: reedcloudsec.com inquiry form",
  ];

  return createPdf(lines.slice(0, 48));
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function foldBase64(value) {
  return value.match(/.{1,76}/g)?.join("\r\n") || "";
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
    `Routed To: ${EMAIL_TO}`,
    "Source: reedcloudsec.com inquiry form",
  ].join("\n");

  const pdfBytes = buildInquiryPdf(inquiry, receivedAt);
  const pdfFilename = `rtg-inquiry-${receivedAt.replace(/[:.]/g, "-")}.pdf`;

  return { subject, text, pdfBytes, pdfFilename };
}

function successPage() {
  return htmlResponse(`<!doctype html>
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
        <p>Your inquiry has been received. Reed Technology Group will review it and follow up soon.</p>
        <p class="response-note">You will be redirected back to the home page shortly.</p>
        <a class="button primary" href="/index.html#inquiry-form">Back to Site</a>
      </section>
    </main>
  </body>
</html>`);
}

function errorPage(message, status = 500) {
  return htmlResponse(
    `<!doctype html>
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
</html>`,
    status,
  );
}

function htmlResponse(body, status = 200) {
  return new Response(body, {
    status,
    headers: { ...SECURITY_HEADERS, "Content-Type": "text/html; charset=utf-8" },
  });
}

function smtpConfigured(env) {
  return Boolean(env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS && env.EMAIL_FROM);
}

class SmtpSession {
  constructor(socket) {
    this.socket = socket;
    this.reader = socket.readable.getReader();
    this.writer = socket.writable.getWriter();
    this.decoder = new TextDecoder();
    this.encoder = new TextEncoder();
    this.buffer = "";
  }

  async read() {
    while (true) {
      const lines = this.buffer.split(/\r?\n/).filter(Boolean);
      const last = lines.at(-1) || "";
      if (/^\d{3} /.test(last)) {
        const response = this.buffer.trim();
        this.buffer = "";
        const code = Number(last.slice(0, 3));
        if (code >= 400) {
          throw new Error(response);
        }
        return response;
      }

      const { value, done } = await this.reader.read();
      if (done) {
        throw new Error("SMTP connection closed unexpectedly.");
      }
      this.buffer += this.decoder.decode(value, { stream: true });
    }
  }

  async command(command) {
    await this.writer.write(this.encoder.encode(`${command}\r\n`));
    return this.read();
  }

  release() {
    this.reader.releaseLock();
    this.writer.releaseLock();
  }
}

async function sendSmtp(env, email, replyTo) {
  let socket = connect(
    { hostname: env.SMTP_HOST, port: Number(env.SMTP_PORT || 587) },
    { secureTransport: "starttls" },
  );
  let smtp = new SmtpSession(socket);

  await smtp.read();
  await smtp.command(`EHLO ${env.SMTP_HELO || "reedcloudsec.com"}`);
  await smtp.command("STARTTLS");
  smtp.release();

  socket = socket.startTls();
  smtp = new SmtpSession(socket);
  await smtp.command(`EHLO ${env.SMTP_HELO || "reedcloudsec.com"}`);
  await smtp.command("AUTH LOGIN");
  await smtp.command(btoa(env.SMTP_USER));
  await smtp.command(btoa(env.SMTP_PASS));
  await smtp.command(`MAIL FROM:<${env.EMAIL_FROM}>`);
  await smtp.command(`RCPT TO:<${EMAIL_TO}>`);
  await smtp.command("DATA");

  const boundary = `rtg-inquiry-${Date.now()}`;
  const headers = [
    `From: Reed Technology Group Website <${sanitizeHeader(env.EMAIL_FROM)}>`,
    `To: ${sanitizeHeader(EMAIL_TO)}`,
    `Reply-To: ${sanitizeHeader(replyTo)}`,
    `Subject: ${sanitizeHeader(email.subject)}`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ].join("\r\n");
  const message = [
    `--${boundary}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    email.text,
    "",
    `--${boundary}`,
    `Content-Type: application/pdf; name="${sanitizeHeader(email.pdfFilename)}"`,
    "Content-Transfer-Encoding: base64",
    `Content-Disposition: attachment; filename="${sanitizeHeader(email.pdfFilename)}"`,
    "",
    foldBase64(bytesToBase64(email.pdfBytes)),
    "",
    `--${boundary}--`,
  ].join("\r\n");
  const safeMessage = message.replace(/^\./gm, "..");

  await smtp.writer.write(smtp.encoder.encode(`${headers}\r\n\r\n${safeMessage}\r\n.\r\n`));
  await smtp.read();
  await smtp.command("QUIT");
  socket.close();
}

export async function onRequestPost({ request, env }) {
  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_BODY_BYTES) {
      return errorPage("The inquiry is too large.", 413);
    }

    if (!smtpConfigured(env)) {
      return errorPage("Email service is not configured.", 500);
    }

    const formData = await request.formData();
    const inquiry = parseInquiry(formData);
    const validationError = validateInquiry(inquiry);
    if (validationError) {
      return errorPage(validationError, 400);
    }

    await sendSmtp(env, buildEmail(inquiry), inquiry.email);
    return successPage();
  } catch (error) {
    console.error(error);
    return errorPage("The inquiry could not be sent.", 500);
  }
}

export function onRequestGet() {
  return Response.redirect("/index.html#inquiry-form", 302);
}
