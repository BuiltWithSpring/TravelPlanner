export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── CORS preflight ─────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    // ── Route: /static-map — Google Static Maps proxy ──────────
    if (url.pathname === '/static-map' && request.method === 'GET') {
      const cities = (url.searchParams.get('cities') || '')
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);

      if (cities.length === 0) {
        return corsResponse({ error: 'Missing required "cities" query param.' }, 400);
      }

      // Purple path connecting the cities in order + a purple marker per city.
      const encodedCities = cities.map((c) => encodeURIComponent(c));
      const path = `color:0x7c3aedff|weight:3|${encodedCities.join('|')}`;
      const markers = encodedCities
        .map((c) => `markers=color:purple%7C${c}`)
        .join('&');

      const mapUrl =
        'https://maps.googleapis.com/maps/api/staticmap' +
        '?size=600x300' +
        '&maptype=roadmap' +
        `&path=${encodeURIComponent(path)}` +
        `&${markers}` +
        `&key=${env.STATIC_MAPS_KEY}`;

      try {
        const googleResp = await fetch(mapUrl);
        if (!googleResp.ok) {
          return corsResponse({ error: 'Static Maps request failed.' }, 502);
        }
        return new Response(googleResp.body, {
          status: 200,
          headers: {
            'Content-Type': 'image/png',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=86400',
          },
        });
      } catch (err) {
        return corsResponse({ error: err.message }, 502);
      }
    }

    // ── Route: /preview — Anthropic API proxy ──────────────────
    if (url.pathname === '/preview' && request.method === 'POST') {
      try {
        const body = sanitizeDeep(await request.json());

        // Same streaming SSE path as the itinerary call — keeps a continuous byte
        // flow so larger previews never trip Cloudflare's outbound idle timeout.
        // 300s abort matches callClaude's backstop; it should rarely fire.
        const result = await streamAnthropic(env, body, 300000);

        if (result.error) {
          if (result.error.type === 'timeout') {
            return corsResponse({ error: 'timeout', message: 'Preview generation timed out — please try again.' }, 504);
          }
          return corsResponse({ error: result.error.detail || result.error.type || 'Preview generation failed.' }, 500);
        }

        // Re-wrap the assembled text into the non-streaming Anthropic shape the
        // front-end still expects: data.content[0].text.
        return corsResponse({
          content: [{ type: 'text', text: result.text }],
          stop_reason: result.stopReason
        }, 200);
      } catch (err) {
        return corsResponse({ error: err.message }, 500);
      }
    }

    // ── Route: /preview/save-email — Attach an email to a preview session ──
    if (url.pathname === '/preview/save-email' && request.method === 'POST') {
      try {
        const { email, sessionId } = await request.json();
        if (!email || !sessionId) {
          return corsResponse({ error: 'Missing required fields: email and sessionId.' }, 400);
        }

        // Confirm the session actually has preview data before attaching an email.
        const preview = await env.PREVIEW_STORE.get(sessionId);
        if (!preview) {
          return corsResponse({ error: 'Preview not found or expired.' }, 404);
        }

        // Store the email against the session for 7 days.
        await env.PREVIEW_STORE.put(`email:${sessionId}`, email, { expirationTtl: 60 * 60 * 24 * 7 });

        // Send the preview link email — best-effort, don't fail the request if Resend blips.
        try {
          const previewUrl = `https://bws-travel-proxy.springlam-co.workers.dev/p/${sessionId}`;
          await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'BuiltWithSpring Travel <hello@builtwithspring.com>',
              to: [email],
              subject: 'Your travel preview is ready ✈️',
              html: `<!DOCTYPE html><html><body style="margin:0;padding:0;background:#f7f5ff;font-family:Helvetica,Arial,sans-serif;">
                <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f5ff;padding:32px 16px;">
                  <tr><td align="center">
                    <table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;">
                      <tr><td style="background:#7c3aed;height:5px;border-radius:12px 12px 0 0;font-size:0;">&nbsp;</td></tr>
                      <tr><td style="background:#fff;border:1px solid #e4e0f5;border-top:none;border-radius:0 0 12px 12px;padding:32px 40px;">
                        <p style="text-align:center;margin:0 0 8px;">
                          <img src="https://travel.builtwithspring.com/BWSLogo.png" width="44" height="44" style="border-radius:10px;"/>
                        </p>
                        <p style="text-align:center;font-size:12px;font-weight:bold;color:#6b5fa0;margin:0 0 24px;">BuiltWithSpring &middot; AI-Powered Travel Planner</p>
                        <h2 style="text-align:center;font-size:20px;color:#1a1640;margin:0 0 10px;">Your preview is saved ✈️</h2>
                        <p style="text-align:center;font-size:14px;color:#6b5fa0;line-height:1.7;margin:0 0 24px;">
                          Click below anytime to pick up where you left off — your preview will be waiting.
                        </p>
                        <table cellpadding="0" cellspacing="0" style="margin:0 auto 24px;">
                          <tr><td style="background:#7c3aed;border-radius:10px;">
                            <a href="${previewUrl}" style="display:inline-block;padding:14px 36px;font-size:15px;font-weight:bold;color:#fff;text-decoration:none;">
                              View my preview &rarr;
                            </a>
                          </td></tr>
                        </table>
                        <p style="text-align:center;font-size:12px;color:#9b87d4;margin:0 0 24px;">
                          Ready to get the full itinerary? Hit <strong>Buy</strong> on the preview page.
                        </p>
                        <hr style="border:none;border-top:1px solid #e4e0f5;margin:0 0 20px;"/>
                        <p style="text-align:center;font-size:11px;color:#9b87d4;margin:0;">
                          &copy; 2026 BuiltWithSpring &middot; <a href="https://builtwithspring.com" style="color:#9b87d4;">builtwithspring.com</a>
                        </p>
                      </td></tr>
                      <tr><td style="background:#7c3aed;height:4px;border-radius:0 0 12px 12px;font-size:0;">&nbsp;</td></tr>
                    </table>
                  </td></tr>
                </table>
              </body></html>`
            })
          });
        } catch (mailErr) {
          console.error('[preview/save-email] Resend failed:', mailErr && mailErr.message);
        }

        return corsResponse({ ok: true }, 200);
      } catch (err) {
        return corsResponse({ error: err.message }, 500);
      }
    }

    // ── Route: /p/save — Save preview to KV ───────────────────
    if (url.pathname === '/p/save' && request.method === 'POST') {
      try {
        const { preview } = await request.json();
        const id = Math.random().toString(36).substring(2, 8);
        await env.PREVIEW_STORE.put(id, JSON.stringify(preview), { expirationTtl: 60 * 60 * 24 * 30 });
        return corsResponse({ id }, 200);
      } catch (err) {
        return corsResponse({ error: err.message }, 500);
      }
    }

    // ── Route: /p/:id — Retrieve preview and redirect ─────────
    if (url.pathname.startsWith('/p/') && request.method === 'GET') {
      try {
        const id = url.pathname.replace('/p/', '');
        const data = await env.PREVIEW_STORE.get(id);
        if (!data) {
          return new Response('Preview not found or expired.', { status: 404 });
        }
        const encoded = btoa(encodeURIComponent(data));
        const redirectUrl = `https://travel.builtwithspring.com/?preview=${encoded}`;
        return Response.redirect(redirectUrl, 302);
      } catch (err) {
        return corsResponse({ error: err.message }, 500);
      }
    }

    // ── Route: /pexels-photo — City photo proxy (KV-cached 7d) ──
    if (url.pathname === '/pexels-photo' && request.method === 'POST') {
      try {
        const { city } = await request.json();
        if (!city || typeof city !== 'string') {
          return corsResponse({ url: null }, 200);
        }
        const cacheKey = 'pexels:' + city.toLowerCase().trim();

        // Serve from KV if we've looked this city up before (incl. cached misses)
        const cached = await env.PREVIEW_STORE.get(cacheKey);
        if (cached !== null) {
          return corsResponse({ url: cached || null }, 200);
        }

        const query = encodeURIComponent(city + ' city landmark');
        const pexelsRes = await fetch(
          `https://api.pexels.com/v1/search?query=${query}&per_page=1&orientation=landscape`,
          { headers: { Authorization: env.PEXELS_API_KEY } }
        );

        let photoUrl = null;
        if (pexelsRes.ok) {
          const data = await pexelsRes.json();
          if (data.photos && data.photos[0] && data.photos[0].src) {
            photoUrl = data.photos[0].src.medium || null;
          }
        }

        // Cache result for 7 days. Store '' for a miss so we don't re-hit Pexels.
        await env.PREVIEW_STORE.put(cacheKey, photoUrl || '', { expirationTtl: 60 * 60 * 24 * 7 });

        return corsResponse({ url: photoUrl }, 200);
      } catch (err) {
        return corsResponse({ url: null }, 200);
      }
    }

    // ── Route: /review/submit — Save feedback to Sheets + notify ──
    if (url.pathname === '/review/submit' && request.method === 'POST') {
      try {
        const { name, email, country, rating, comment, recommend } = await request.json();

        if (!name || !email || !rating) {
          return corsResponse({ error: 'Missing required fields: name, email, and rating.' }, 400);
        }

        // Append the feedback row to Google Sheets (authoritative — fail the
        // request if this write doesn't land).
        await updateFeedbackRow(env, { name, email, country, rating, comment, recommend });

        // Notify the team via Resend. Best-effort: a delivery hiccup must not
        // lose feedback we've already persisted, so log and continue.
        try {
          await sendFeedbackEmail(env, { name, email, country, rating, comment, recommend });
        } catch (mailErr) {
          console.error('[review] Resend notification failed:', mailErr && mailErr.message);
        }

        return corsResponse({ ok: true }, 200);
      } catch (err) {
        console.error('[review] submit failed:', err && err.message);
        return corsResponse({ error: err.message }, 500);
      }
    }

    // ── Route: /create-checkout ────────────────────────────────
    if (url.pathname === '/create-checkout' && request.method === 'POST') {
      try {
        const raw = await request.json();

        // Sanitize all incoming data to strip characters that break JSON downstream
        const formData = sanitizeFormData(raw.formData || {});
        const approvedCities = sanitizeDeep(raw.approvedCities || []);
        const teaserDay = sanitizeDeep(raw.teaserDay || null);

        // Store full form data in KV — bypasses Stripe 500-char limit entirely
        const formId = Math.random().toString(36).substring(2, 12);
        const fullPayload = {
          formData,
          approvedCities: approvedCities || [],
          teaserDay: teaserDay || null
        };
        await env.PREVIEW_STORE.put(
          `form_${formId}`,
          JSON.stringify(fullPayload),
          { expirationTtl: 60 * 60 * 24 * 7 } // 7 days
        );

        // Only pass safe, short fields to Stripe metadata for reference
        const params = new URLSearchParams({
          'mode': 'payment',
          'line_items[0][price]': env.STRIPE_PRICE_ID,
          'line_items[0][quantity]': '1',
          'allow_promotion_codes': 'true',
          'success_url': `https://travel.builtwithspring.com/success?session_id={CHECKOUT_SESSION_ID}`,
          'cancel_url': `https://travel.builtwithspring.com/`,
          'customer_email': formData.email,
          // KV key — this is all we need to retrieve everything
          'metadata[formDataId]': formId,
          // Short reference fields for Stripe dashboard readability
          'metadata[firstName]': (formData.firstName || '').substring(0, 100),
          'metadata[lastName]': (formData.lastName || '').substring(0, 100),
          'metadata[email]': (formData.email || '').substring(0, 200),
          'metadata[country]': (formData.country || '').substring(0, 100),
          'metadata[arrivalDate]': formData.arrivalDate || '',
          'metadata[departureDate]': formData.departureDate || '',
          'metadata[travelParty]': formData.travelParty || '',
        });

        const stripeResponse = await fetch('https://api.stripe.com/v1/checkout/sessions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${env.STRIPE_SECRET_KEY}`,
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: params.toString()
        });

        const session = await stripeResponse.json();

        if (session.error) {
          return corsResponse({ error: session.error.message }, 400);
        }

        return corsResponse({ url: session.url, sessionId: session.id }, 200);

      } catch (err) {
        return corsResponse({ error: err.message }, 500);
      }
    }

    // ── Route: /webhook — Stripe payment confirmation ──────────
    if (url.pathname === '/webhook' && request.method === 'POST') {
      try {
        const body = await request.text();
        const sig = request.headers.get('stripe-signature');

        const event = await verifyStripeWebhook(body, sig, env.STRIPE_WEBHOOK_SECRET);
        console.log('[webhook] verified event.type:', event.type, '| has queue binding:', !!env.ITINERARY_QUEUE);

        if (event.type === 'checkout.session.completed') {
          // Enqueue fulfillment. The queue consumer (queue() below) runs in its own
          // invocation with no waitUntil/timeout limits, so the long Claude call never
          // races this request. Stripe is acked immediately after the message is queued.
          console.log('[webhook] sending to ITINERARY_QUEUE, session:', event.data.object && event.data.object.id);
          await env.ITINERARY_QUEUE.send(event.data.object);
          console.log('[webhook] queue.send() resolved OK');
        } else {
          console.log('[webhook] event.type not checkout.session.completed — nothing queued');
        }

        return new Response('OK', { status: 200 });

      } catch (err) {
        console.error('[webhook] handler threw:', err && err.message);
        return new Response(`Webhook error: ${err.message}`, { status: 400 });
      }
    }

    // ── Route: /success ────────────────────────────────────────
    if (url.pathname === '/success') {
      return Response.redirect('https://travel.builtwithspring.com/success', 302);
    }

    return corsResponse({ error: 'Not found' }, 404);
  },

  // ── Queue consumer ─────────────────────────────────────────
  // Bound to ITINERARY_QUEUE. Each message body is the Stripe session object
  // enqueued by /webhook. Runs in its own invocation, so generateItinerary() has
  // no waitUntil/timeout pressure. Ack on success; retry on unexpected failure.
  async queue(batch, env, ctx) {
    for (const message of batch.messages) {
      try {
        await fulfillOrder(env, message.body);
        message.ack();
      } catch (err) {
        console.error('Queue message failed:', err && err.message, '— will retry');
        message.retry();
      }
    }
  }
};

// ── Helpers ─────────────────────────────────────────────────────
function corsResponse(data, status) {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  return new Response(
    data ? JSON.stringify(data) : null,
    { status, headers }
  );
}

// ── Input sanitization — prevents malformed JSON from special characters ──
// Strips/replaces characters that commonly break JSON when echoed back by the model:
// smart quotes, em/en dashes, middle dots, zero-width spaces, control chars, etc.
function sanitizeText(str) {
  if (typeof str !== 'string') return str;
  return str
    // Smart double quotes → straight
    .replace(/[\u201C\u201D\u201E\u201F\u2033\u2036]/g, '"')
    // Smart single quotes / apostrophes → straight
    .replace(/[\u2018\u2019\u201A\u201B\u2032\u2035]/g, "'")
    // Em dash, en dash, horizontal bar, minus → hyphen
    .replace(/[\u2013\u2014\u2015\u2212]/g, '-')
    // Middle dot, bullet, interpunct → comma+space (common paste artifact)
    .replace(/[\u00B7\u2022\u2027\u2219\u25CF\u25AA]/g, ', ')
    // Ellipsis → three dots
    .replace(/\u2026/g, '...')
    // Non-breaking space and other unicode spaces → regular space
    .replace(/[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g, ' ')
    // Zero-width spaces, joiners, BOM → remove entirely
    .replace(/[\u200B\u200C\u200D\uFEFF]/g, '')
    // Control characters (except tab/newline/carriage return) → remove
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    // Collapse runs of whitespace
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

// Recursively sanitize every string in an object/array
function sanitizeDeep(value) {
  if (typeof value === 'string') return sanitizeText(value);
  if (Array.isArray(value)) return value.map(sanitizeDeep);
  if (value && typeof value === 'object') {
    const out = {};
    for (const k in value) out[k] = sanitizeDeep(value[k]);
    return out;
  }
  return value;
}

// Sanitize form data specifically
function sanitizeFormData(formData) {
  return sanitizeDeep(formData);
}

async function verifyStripeWebhook(payload, sig, secret) {
  const parts = sig.split(',');
  const timestamp = parts.find(p => p.startsWith('t=')).split('=')[1];
  const signatures = parts
    .filter(p => p.startsWith('v1='))
    .map(p => p.split('=')[1]);

  const signedPayload = `${timestamp}.${payload}`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signedPayload)
  );
  const expectedSig = Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  if (!signatures.some(s => s === expectedSig)) {
    throw new Error('Invalid webhook signature');
  }

  if (Math.abs(Date.now() / 1000 - parseInt(timestamp)) > 300) {
    throw new Error('Webhook timestamp too old');
  }

  return JSON.parse(payload);
}

// ── Feedback: Google Sheets append + Resend notification ────────
const FEEDBACK_SPREADSHEET_ID = '1YIyN4y26-WBJTA0FluHeDrFI6rkMmgzA18kU5ijnx6Q';
const FEEDBACK_SHEET_GID = 779249867;

// base64url-encode raw bytes (used for the JWT signature and segments).
function base64urlFromBytes(buffer) {
  const bytes = new Uint8Array(buffer);
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// base64url-encode a UTF-8 string (JWT header/claim segments).
function base64urlEncode(str) {
  return base64urlFromBytes(new TextEncoder().encode(str));
}

// Convert a PEM private key into an ArrayBuffer of its DER bytes.
function pemToArrayBuffer(pem) {
  const b64 = pem
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

// Mint a short-lived Google OAuth2 access token from the service-account
// credentials using the JWT-bearer flow (RS256, signed via WebCrypto).
async function getGoogleAccessToken(env, scope) {
  const creds = JSON.parse(env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const now = Math.floor(Date.now() / 1000);
  const tokenUri = creds.token_uri || 'https://oauth2.googleapis.com/token';

  const header = base64urlEncode(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = base64urlEncode(JSON.stringify({
    iss: creds.client_email,
    scope,
    aud: tokenUri,
    iat: now,
    exp: now + 3600
  }));
  const signingInput = `${header}.${claim}`;

  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToArrayBuffer(creds.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput)
  );
  const jwt = `${signingInput}.${base64urlFromBytes(signature)}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    }).toString()
  });
  const data = await res.json();
  if (!res.ok || !data.access_token) {
    throw new Error(`Google token exchange failed: ${data.error_description || data.error || res.status}`);
  }
  return data.access_token;
}

// Resolve a sheet tab's name from its numeric gid (needed for the A1 append range).
async function getSheetNameByGid(token, spreadsheetId, gid) {
  const res = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?fields=sheets.properties(sheetId,title)`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  const data = await res.json();
  if (!res.ok) throw new Error(`Sheets metadata lookup failed: ${(data.error && data.error.message) || res.status}`);
  const sheet = (data.sheets || []).find(s => s.properties && s.properties.sheetId === gid);
  if (!sheet) throw new Error(`No sheet found with gid ${gid}`);
  return sheet.properties.title;
}

// Find existing customer row by email, update columns N/O/P; fallback to append.
async function updateFeedbackRow(env, { name, email, country, rating, comment, recommend }) {
  const token = await getGoogleAccessToken(env, 'https://www.googleapis.com/auth/spreadsheets');
  const sheetName = await getSheetNameByGid(token, FEEDBACK_SPREADSHEET_ID, FEEDBACK_SHEET_GID);

  // Read all data (A:P) to find the row matching this email
  const readRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${FEEDBACK_SPREADSHEET_ID}/values/${encodeURIComponent(sheetName + '!A:P')}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!readRes.ok) throw new Error(`Sheets read failed: ${readRes.status}`);
  const { values = [] } = await readRes.json();

  // Find the 1-based row index where any cell matches the submitted email
  let rowIndex = -1;
  for (let i = 0; i < values.length; i++) {
    if (values[i].some(cell => cell === email)) {
      rowIndex = i + 1;
      break;
    }
  }

  if (rowIndex === -1) {
    // Email not found — append a new row as fallback
    console.warn('[review] Email not found in sheet, appending:', email);
    const appendRes = await fetch(
      `https://sheets.googleapis.com/v4/spreadsheets/${FEEDBACK_SPREADSHEET_ID}/values/${encodeURIComponent(sheetName + '!A:A')}:append?valueInputOption=USER_ENTERED&insertDataOption=INSERT_ROWS`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          values: [[new Date().toISOString().split('T')[0], name, email, country || '', '', '', '', '', '', '', '', '', '', String(rating), comment || '', recommend || '']]
        })
      }
    );
    if (!appendRes.ok) throw new Error(`Sheets append failed: ${appendRes.status} ${await appendRes.text()}`);
    return;
  }

  // Update columns N (rating), O (comment), P (recommend) on the matched row
  const updateRange = `${sheetName}!N${rowIndex}:P${rowIndex}`;
  const updateRes = await fetch(
    `https://sheets.googleapis.com/v4/spreadsheets/${FEEDBACK_SPREADSHEET_ID}/values/${encodeURIComponent(updateRange)}?valueInputOption=USER_ENTERED`,
    {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        range: updateRange,
        majorDimension: 'ROWS',
        values: [[String(rating), comment || '', recommend || '']]
      })
    }
  );
  if (!updateRes.ok) throw new Error(`Sheets update failed: ${updateRes.status} ${await updateRes.text()}`);
}

// Send the feedback notification email via Resend.
async function sendFeedbackEmail(env, { name, email, country, rating, comment, recommend }) {
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const html =
    `<h2>New feedback received</h2>` +
    `<p><strong>Name:</strong> ${esc(name)}</p>` +
    `<p><strong>Email:</strong> ${esc(email)}</p>` +
    `<p><strong>Country:</strong> ${esc(country) || '—'}</p>` +
    `<p><strong>Rating:</strong> ${esc(rating)}/5</p>` +
    `<p><strong>Comment:</strong><br>${esc(comment) || '—'}</p>` +
    `<p><strong>Recommend:</strong> ${esc(recommend) || '—'}</p>`;

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'Feedback <feedback@builtwithspring.com>',
      to: ['hello@builtwithspring.com'],
      subject: `New feedback — ${rating}/5 from ${name}`,
      html
    })
  });
  if (!res.ok) {
    throw new Error(`Resend send failed: ${res.status} ${await res.text()}`);
  }
}

// ── Itinerary generation ────────────────────────────────────────
// Top-level keys every valid itinerary must contain.
const REQUIRED_KEYS = ['overview', 'days', 'accommodations', 'transport', 'restaurants', 'city_guide', 'book_before_you_go', 'practical_info'];

// Appended to the prompt on retry to force clean JSON output.
const JSON_RETRY_INSTRUCTION = '\n\nIMPORTANT: Return only valid JSON. No markdown formatting, no code fences, no explanation before or after. Your response must start with { and end with }.';

// The full itinerary prompt. `d` carries the traveler's form data plus the
// approved city plan and approved teaser day retrieved from KV at fulfillment.
const ITINERARY_PROMPT = (d) => {
  const t = d.teaserDay || {};
  const approvedCities = JSON.stringify(d.approvedCities || []);
  const citiesRequested = JSON.stringify(d.citiesToVisit || []);
  const anchorCities = JSON.stringify(d.anchorCities || []);
  const accommodationStyle = JSON.stringify(d.accommodationStyle || []);
  const interests = JSON.stringify(d.interests || {});
  const cuisinePreferences = JSON.stringify(d.cuisinePreferences || []);
  const travelStyle = d.travelStyle || d.budgetTier || '';
  // Total trip nights, derived from arrival/departure dates. Falls back to the sum of
  // approved-city nights if the dates are missing/unparseable. Drives the per-tier
  // output caps in STEP 6 (accommodation), STEP 7 (food), and STEP 13 (city guide).
  const tripNights = (() => {
    const a = Date.parse(d.arrivalDate), b = Date.parse(d.departureDate);
    if (!isNaN(a) && !isNaN(b) && b > a) return Math.round((b - a) / 86400000);
    const sum = (d.approvedCities || []).reduce((n, c) => n + (Number(c.nights) || 0), 0);
    return sum || 0;
  })();
  const tripTier = tripNights >= 11 ? 'LONG (11–14 nights)'
    : tripNights >= 8 ? 'MEDIUM (8–10 nights)'
    : 'STANDARD (≤7 nights)';
  return `You are an expert travel planner. Generate a personalized travel itinerary following every step below in order.

──────────────────────────────────────────────
APPROVED CITY PLAN — USE EXACTLY AS IS:
The traveler has reviewed and approved this city and nights plan.
Do not change cities, order, or nights under any circumstances.
Skip Step 1 night allocation — nights are already set:
${approvedCities}

APPROVED TEASER DAY — INCLUDE VERBATIM IN DAY-BY-DAY:
Place this content on the most logical day for ${t.city || ''}
that is NOT a travel day and fits the neighborhood flow of surrounding days.
Do not alter the content — use it exactly as provided:
Morning: ${t.morning || ''}
Afternoon: ${t.afternoon || ''}
Evening: ${t.evening || ''}
Restaurant suggestion: ${t.restaurant_suggestion || ''}
──────────────────────────────────────────────

STEP 1 — CITY DURATION FRAMEWORK
NOTE: If approved cities are provided above, skip night allocation — use approved nights exactly.
Only apply this step if no approved city plan exists.

Classify each city before allocating nights:
- Micro → 0.5–1 night · Small → 1–2 · Medium → 2–3 · Large → 3–5 · Mega → 4–6

Pace rules:
- Full days → minimum nights. Dense schedule, maximize daily activities.
- Relaxed days → maximum nights. Lighter schedule, room to breathe.
- Never compress below minimum. If cities × minimum > total days → remove cities.
- Departure city classified Large or Mega → minimum 2 nights.
- If departure city differs from arrival city and has significant tourist value → include it regardless of pace or night count. Compress other cities before removing the departure city.

Travel day deductions:
- Travel 2–4 hours → half day lost. Over 4 hours → full day lost.
- City losing full day to travel → add 1 night.
- Travel days → max 2 activities near hotel or departure point. Flag clearly.

STEP 2 — CITY SELECTION
NOTE: If approved cities are provided above, skip city selection entirely — proceed to Step 3.
Only apply this step if no approved city plan exists.

Calculate total trip days from arrival to departure.
- All selected cities must be within the country submitted. Never recommend cities in other countries unless explicitly listed in must-see or extra notes.
- Always consider arrival and departure airport cities as candidates. Include them for flying trips unless the traveler chose different cities or the airport has no tourist value.
- ARRIVAL CITY RULE: Always include the arrival airport city for at least 1 night unless the traveler explicitly says to skip it. They need time to land, clear customs, get to accommodation, and decompress. If the arrival city is a world-class or must-visit destination (e.g. Rome, Paris, Tokyo, New York, Bangkok, Istanbul, Barcelona, London, Sydney) → allocate nights based on typical visitor recommendations adjusted for their pace: Full days pace → minimum nights for that city size. Relaxed pace → maximum nights. Never drop the arrival city unless the traveler explicitly names a different starting city or says "skip [city]" in mustSee or extraNotes.
- DEPARTURE CITY RULE: Always include the departure airport city for at least 1 night unless the traveler explicitly says to skip it. Never route a traveler out of any city they have not spent at least one night in — they need accommodation, time to reach the airport, and a buffer for their flight. If the departure city is a world-class or must-visit destination → allocate nights based on typical visitor recommendations adjusted for their pace, same as arrival city logic above. Adjust other city night allocations to fit both arrival and departure city requirements.
- Cities listed, AI false → respect list. Adjust count if needed. Explain changes in overview.
- AI true, anchors provided → anchors are fixed. Fill remaining days with best-fit cities.
- AI true, no cities → select from scratch weighted by interests, travel party, travel style, weather, routing.
- Too many cities → keep best subset, explain removals. Too few → add complementary cities.
- Every city must have why_recommended max 25 words: "[City] is [known for] — chosen for your [interest or preference]." Never generic or logistical.

STEP 2B — TRIP STRUCTURE
Single city trips → skip all corridor and routing logic below. If train selected → recommend local train day trips within 60–90 min and city transport tips only. All other structures → default to activity-based day planning.

road_trip → cities along efficient driving corridor, driveable in 2–5 hour legs, no backtracking.

train → cities along logical rail corridor. Major train stations only. No car/bus connections. Recommend specific rail pass (JR Pass, Eurail, Trenitalia, SNCF etc). Include day trips by local train within 60–90 min. Flag pre-departure rail passes as Book now in book_before_you_go.

flying → each city fully independent. Select by interest profile not geography. Day trips within 90 min per city. Never choose a city just because it sits between others.

Not provided → MANDATORY: evaluate every leg independently using actual train and flight travel times before recommending any transport mode. Do not default to flying. Apply this logic to every city pair:
- Under 3 hours by high-speed or intercity train → ALWAYS recommend train. Account for airport check-in (2hrs), security, boarding, transit to/from airports — train is always faster door-to-door for short legs.
- 3–5 hours by train → train is almost always faster or equal door-to-door once you add full airport overhead. Only recommend flying in this bracket if the flight is over 2 hours AND there is a major hub airport with fast city-centre transit. Always note both options in booking_tip with realistic door-to-door times.
- Over 5 hours by train AND flight is under 2 hours → flying is likely faster door-to-door. Recommend flying.
- No direct rail connection → recommend flying or bus depending on distance, or rental car if it is a popular scenic driving route between those cities.
- Rental car / self-drive → recommend proactively when: (1) the route is a well-known scenic drive, (2) there is no direct train or the train is significantly slower, or (3) the traveler has selected road_trip structure.
- Never recommend flying between two cities where high-speed rail is under 4 hours.
- China: always check HSR times first. Europe: always check Eurostar/TGV/ICE/Thalys/Frecciarossa/Renfe AVE first. Japan: always recommend Shinkansen for legs under 4 hours.

City familiarity bias → prefer well-known cities unless Adventure interest exceeds 25%. For large countries (USA, Australia, Canada, Brazil, China) with FLYING structure explicitly selected → same region or coast only.

STEP 3 — DECISION HIERARCHY
Apply in order to every recommendation:
1. Travel party (Step 4)
2. Travel style: shapes accommodation tier, food price range, and activity quality only. Never apply to transport routing or mode selection — always choose the most time-efficient transport option regardless of travel style.
3. Interest weights (Step 5)
4. Routing efficiency — minimize backtracking
5. Weather and seasonality — verify all recommendations suit exact travel dates. Flag festivals and highlights in overview.
6. Holidays and closures — flag closures, adjust plan
7. City familiarity bias (Step 2B)

STEP 4 — TRAVEL PARTY
- Couple → romantic, intimate. Day trips max 90 min each way.
- Family with kids → kid-friendly without exception. Adventure & fun → theme parks, water parks, zip lines, go-karts, family outdoor activities only. Never adult-only or age-restricted venues. Day trips max 90 min.
- Family no kids → adult experiences. Day trips max 90 min.
- Friends group → social, communal, group-capacity venues. Group size drives seating, accommodation, transport. Day trips max 2 hours.
- Solo → flexible, independent, safe. Day trips max 2 hours.
- Never schedule same-day connections under 2 hours between arriving flight and departing train.

STEP 5 — INTEREST WEIGHTS
- 20%+ High → day-by-day every 1–2 days. Best-in-city only.
- 11–19% Medium → day-by-day every 2–3 days.
- 1–10% Low → city guide pool only. Never in day-by-day. Max 1 per city.
- 0% → exclude entirely from all output.

Relaxed days pace reduces frequency one tier: High → every 2–3 days, Medium → once per city stay.

STEP 6 — ACCOMMODATION
The NUMBER of accommodations is driven entirely by how many accommodation styles the traveler selected (see "Accommodation style" in the trip details below). This SUPERSEDES any earlier per-city count or trip-length accommodation cap:
- 0 styles selected → generate NO accommodations. Output "accommodations": [] — a clean, present empty array (never null, never a missing key). Do NOT invent a default style or add any property.
- 1 style selected → 2 accommodations of that type, per city.
- 2+ styles selected → 1 accommodation of EACH selected type, per city.

When accommodations are generated (1+ styles selected), apply these quality and safety rules:
- Only recommend accommodations with strong reputations — minimum 3.8 stars or equivalent
- Never recommend a property with known safety concerns, poor reviews, or in an unsafe area
- Always recommend neighborhoods that are safe, well-located, and convenient for planned activities
- Match travel style tier strictly — never exceed
- Families with kids → ground floor or elevator access, family rooms or connecting rooms only
- Couples → boutique hotels, intimate properties, romantic neighborhoods preferred
- Friends groups → properties with social spaces, proximity to nightlife if Nightlife & bars > 0%

Every accommodation entry must include:
- city, checkin (YYYY-MM-DD), checkout (YYYY-MM-DD)
- recommended_type: specific property type
- name: specific recommended property name where possible
- neighborhood: district name and why it's a good base
- estimated_cost_per_night: range with currency symbol
- why: max 15 words — what makes this property a good fit for this traveler


STEP 7 — FOOD & DRINK
Scale to Food & drink interest weight. These are HARD MINIMUMS per city — never go below them. Each venue type below is a SEPARATE entry in the restaurants array:

NO DUPLICATION OF DAY-BY-DAY DINNERS: The restaurants array is a reference tab of ADDITIONAL dining options. Do NOT re-list any restaurant that already appears as a day's restaurant_suggestion in the day-by-day plan. Every entry in the restaurants array must be a DIFFERENT venue, not already named in any day's restaurant_suggestion — together the two sets widen the traveler's options rather than repeat. The per-day restaurant_suggestion itself is preserved exactly as is; this rule governs ONLY the separate restaurants array. The per-city minimum counts below describe this additional restaurants array.

- 20%+ → MINIMUM per city (6 entries flat):
  · 1 breakfast spot (set venue_type: "Breakfast") — or Brunch in cities where brunch culture is strong e.g. New York, London, Sydney, Melbourne, Cape Town
  · 1 cafe or specialty coffee shop (set venue_type: "Cafe")
  · 1 bakery or patisserie (set venue_type: "Bakery")
  · 1 lunch spot (set venue_type: "Lunch")
  · 2 dinner restaurants (set venue_type: "Dinner")
  · Street food and dessert are BONUS entries — add them where highly culturally relevant (e.g. street food in Asia/Mexico/Middle East, gelato in Italy, bubble tea in Asia) but they are not required minimums
  · TRIP-LENGTH SCALING for this 20%+ tier (by TRIP LENGTH TIER above):
    - STANDARD (≤7 nights) → keep the 6 entries above AND add 1 more dinner entry for every additional 2 nights in the same city beyond the first 2.
    - MEDIUM (8–10 nights) → cap at 5 per city: 1 breakfast, 1 cafe, 1 lunch, 2 dinner. NO per-night dinner escalator.
    - LONG (11–14 nights) → cap at 4 per city: 1 breakfast, 1 lunch, 2 dinner (drop cafe and bakery). NO per-night dinner escalator.
    On MEDIUM and LONG trips these caps OVERRIDE the 6-entry minimum and the "cafes/bakeries are REQUIRED" note below.

- 11–19% → MINIMUM per city (4 entries flat):
  · 1 breakfast or brunch spot (set venue_type: "Breakfast" or "Brunch")
  · 1 cafe (set venue_type: "Cafe")
  · 1 lunch spot (set venue_type: "Lunch")
  · 2 dinner restaurants (set venue_type: "Dinner")
  · Street food is a bonus entry where highly relevant — not required

- 1–10% → 1 dinner entry per city only (set venue_type: "Dinner")
- 0% → no food recommendations anywhere

IMPORTANT: Cafes, bakeries, and breakfast spots are REQUIRED separate entries — not optional. A cafe is not a restaurant. A bakery is not a lunch spot. Each must appear as its own distinct entry in the restaurants array with the correct venue_type.

Default to top 3 local cuisine styles if no preference selected.
Filter by travel party first, then travel style tier.
Fine dining + Budget → most affordable fine dining available.
Every venue must include venue_type, known_for (max 8 words), neighborhood.
Never recommend a venue at a time it is not known for.
Never repeat the same venue as restaurant suggestion on consecutive days.
Only include venues that are widely acclaimed or have strong local reputation.
Bars and cocktail bars → city guide only, never in the restaurants array.


STEP 8 — WELLNESS
- 0% → exclude all wellness from entire output.
- 1–10% → one named venue per city in city guide only.
- 11–19% → one named venue per city in day-by-day.
- 20%+ → multiple named venues per city, prominent in day-by-day.
Named venues only: spa, thermal bath, hammam, massage centre, wellness retreat.

STEP 9 — TRANSPORT
Resolve airports first: interpret city names, airport names, or IATA codes. Use correct IATA code and full name throughout. Note ambiguity in overview.
First transport entry → arrival airport to first accommodation.
Last transport entry → final city to departure airport.

Match to trip structure:
- road_trip → rental car. Include fuel and toll estimates.
- train → specific rail service per leg. Flag pre-departure passes as Book now.
- flying → flights between cities plus rideshare/shuttle airport transfers.
- Not provided → apply smart transport logic from Step 2B per leg.

Every booking_tip is one sentence including booking window. Never label a road shuttle as Train. Flag cities with multiple airports.

STEP 10 — GEOGRAPHIC CLUSTERING
Cluster morning, afternoon, evening in same or adjacent neighborhoods. Plan full days around must-sees. Never zigzag. On travel days all activities near hotel or departure point only. Assign neighborhood_focus and restaurant_suggestion per day using this logic:
- Regular days → pick the most appropriate meal based on the day's flow. Label clearly as Lunch or Dinner (breakfast is handled separately — see below). Name a specific, real, well-regarded restaurant suited to that city and meal.
- Departure day → pick a restaurant near the departure hotel or point — last meal in that city before leaving.
- Arrival day → pick a restaurant near the arrival accommodation — first meal in the new city.
- Full travel day → pick a restaurant near the arrival accommodation for dinner on arrival.
- Never repeat the same venue on consecutive days across both restaurant_suggestion and restaurants array.
- Restaurant suggestion should always be geographically logical for that day's context.
- Restaurant suggestion must be a specific real venue and must NOT duplicate any venue in the restaurants array (Food & Drink tab) — the day-by-day picks and the Food & Drink list are disjoint sets, so together they broaden the traveler's dining options.
- BREAKFAST IS MANDATORY EVERY DAY: in addition to restaurant_suggestion, every day must include a separate breakfast_suggestion — a specific, real, well-regarded breakfast spot or cafe near that day's accommodation or first activity. Format it exactly like restaurant_suggestion (Breakfast: Name | neighborhood | one line why it fits today). It must not duplicate any venue used in restaurant_suggestion or in the restaurants array.

STEP 11 — ACTIVITY TIME BUDGET VALIDATION
Before finalizing each day, validate the day's activities against a realistic time budget.

Time budgets per pace:
- Full days → ~10 hours of activity time available
- Relaxed days → ~6 hours of activity time available

Activity time classifications:
- Quick activity (market visit, viewpoint, short walk) → 1–2 hours
- Standard activity (museum, temple, neighborhood walk) → 2–3 hours
- Half-day activity (cooking class, boat tour, major landmark) → 4–5 hours
- Full-day activity (theme park, long day trip, trek) → 6–8 hours including transport

Validation rules:
- Full day activity → that is the day's primary activity. Add ONE light nearby evening activity only.
- Day trip (90+ min each way) → counts as half-day minimum just for transport. Relaxed day + day trip → day trip IS the day, no other activities. Full days + day trip → only if destination is under 90 min each way, pair with one nearby activity max.
- Half-day activity → can pair with one standard activity on the same day max.
- Never schedule 3 time-intensive activities (each 3+ hours) on the same day regardless of pace.
- Travel days → max 2 quick activities near departure point only.

STEP 12 — BOOK BEFORE YOU GO
A curated advance-booking guide — not a tracker. Include only items that genuinely benefit from booking ahead: flights, accommodation, high-demand restaurants, activities that sell out, rail passes, entry tickets with timed slots. Sort by urgency: Book now → 4–6 weeks ahead → On arrival.
Every entry needs: item_name, city, date, est_cost, booking_priority, booking_tip (one sentence — where and how to book, and why booking ahead matters for this item), booking_link (most direct official booking URL; leave empty string if no reliable URL exists).
Do NOT include generic items that need no advance booking (e.g. free parks, markets, casual walk-in cafes). Quality over quantity — only items where the link genuinely helps the traveler act.

STEP 13 — CITY GUIDE
A reference pool of EXTRA options not already in your daily plan, weighted by interest scores. These are ADDITIONAL ideas beyond the day-by-day — never the same entries.

Include:
- ONLY additional options per city beyond what is already in the day-by-day plan, scaled by interest weight below. Do NOT re-list any activity, attraction, or place that already appears in the day-by-day — those live in the day-by-day tab and duplicating them wastes output.
- Nightlife venues if Nightlife & bars > 0%

Exclude:
- All food and beverage dining venues — these belong in the restaurants array only
- Wellness if interest is 0%
- Nightlife if interest is 0%
- Any category at 0%

Interest weight scaling per category:
- 20%+ → 4–6 entries per city
- 11–19% → 2–3 entries
- 1–10% → 1 additional entry only
- 0% → exclude

HARD CAP — MAXIMUM city_guide entries per city total, scaled by TRIP LENGTH TIER (above):
- STANDARD (≤7 nights) → 12 per city
- MEDIUM (8–10 nights) → 8 per city
- LONG (11–14 nights) → 6 per city
This cap OVERRIDES the per-category guidance above whenever the per-category sums would exceed it. When capped, allocate the available slots by interest weight — highest-weighted categories get their slots first, lower-weighted categories yield remaining slots, and drop the lowest-weighted categories entirely if needed to stay within the cap.

Category to type mapping:
- History & heritage → Historic Site, Monument, Heritage Walk, Palace, Temple, Ruins
- Nature & outdoors → Natural Landmark, Park, Beach, Viewpoint, Hiking Trail, Botanical Garden, Zoo, Wildlife Reserve
- Culture & museums → Museum, Gallery, Theatre, Cultural Center, Science Center
- Wellness & spa → Wellness (named venue only)
- Shopping → Market, Shopping District, Boutique, Artisan Shop
- Adventure & fun → Theme Park, Water Park, Adventure Activity, Family Activity, Boat Tour
- Nightlife & bars → Nightlife (rooftop bar, jazz club, live music, cocktail bar only)

Quality filter: widely visited, highly regarded, or iconic only.

Each entry must include:
- type: from the type list above
- name: venue or location name
- description: always populated, max 25 words — what it is and why it suits you. Never empty.
- category: interest category it maps to
- best_time: Morning · Afternoon · Evening · Full Day · Any
- est_cost: range with currency or "Free"
- neighborhood: district or area

STEP 13.5 — SPOT TIERING
Every activity in the day-by-day AND every entry in the city_guide must be assigned a spot_tier. Apply to all morning, afternoon, and evening slots, and to all city_guide entries.

Tier definitions:
- "Iconic" — widely known, appears in most guidebooks, worth doing despite crowds. Think Sagrada Família, Senso-ji, the Louvre.
- "Local Pick" — well-regarded by those who know the destination, less touristed than iconic sites, won't appear on a first-Google search. The kind of place a well-travelled friend would recommend.
- "Hidden Gem" — genuinely off the beaten path. Requires research or local knowledge to find. Not on mainstream tourist itineraries. Specific, surprising, memorable.

Rules:
- Every trip must include at least 2 Hidden Gem entries across the day-by-day.
- Every trip must include at least 3 Local Pick entries across the day-by-day.
- Do not label everything as Hidden Gem — use sparingly and only when truly justified.
- Tier must reflect objective popularity, not subjective preference.
- For day-by-day entries, include spot_tier as a prefix inside the activity string in square brackets: "[Iconic] " · "[Local Pick] " · "[Hidden Gem] "
  Example morning: "[Local Pick] Yanaka Cemetery Walk — a quiet neighborhood necropolis turned local strolling ground, lined with cats and old craft shops."
- For city_guide entries, add spot_tier as a separate field (see JSON schema below).

STEP 13.6 — HIDDEN FINDS
Select the most surprising, non-obvious experiences or places, scaled by the number of cities in the itinerary:
- 1–2 cities → 3 Hidden Finds PER CITY
- 3+ cities → 2 Hidden Finds PER CITY
These are the "I wouldn't have found this on my own" moments — things that make the itinerary feel genuinely researched rather than AI-generated. Draw from Hidden Gem and strong Local Pick entries.
Each entry: emoji, title (max 6 words), description (max 25 words — why it's special and not obvious), city.
Each Hidden Find must be a place NOT already listed as a morning, afternoon, or evening activity in the day-by-day — no repeats from the daily plan. Draw instead from the city_guide Hidden Gem / Local Pick entries or genuinely new places.
These appear as a standalone section in the PDF — make them count.

STEP 14 — ACTIVITY FRAMING
Pace density rules — apply to every day-by-day entry:
- Full days → populate morning, afternoon AND evening with distinct activities. All 3 slots required.
- Relaxed days → populate morning and either afternoon OR evening. If the day's activities are time-intensive, one slot can be a lighter, low-key suggestion — but it must still name a specific place (see the Free time rule below), never a generic placeholder.

All day-by-day activity fields: "[Activity name] — [one line what it is and why it suits this traveler]." No duration, category label, neighborhood tag, or pipes. Max 20 words.
NEVER output "Free time" (or "Free time — explore [neighborhood] at your own pace", or any generic placeholder) as a morning, afternoon, or evening slot entry. Every slot must name a specific place in that city — a named neighbourhood to wander, a named market, a named viewpoint, a named park — each with a one-line description, formatted exactly like every other activity slot.

STEP 14.5 — NO REPETITION RULE (applies across the ENTIRE trip)
Every activity, attraction, and restaurant must be unique across all days. Never schedule the same place, sight, or restaurant more than once, even across different days in the same city. This applies to morning, afternoon, and evening slots equally.
- For multi-day stays in one city, treat the city's attractions as a finite set you are distributing across days — once a place is used on one day, it is unavailable for every other day.
- Before finalizing each day, check it against all previous days and confirm no activity, attraction, or restaurant has already appeared.
- If a city has more days than distinct marquee attractions, fill remaining slots with neighborhoods, local experiences, day trips, markets, parks, or lesser-known spots rather than repeating a famous site.
- The single exception is unavoidable logistics (e.g. the same airport for arrival and departure) — transport hubs may recur, but no activity, sight, or restaurant ever may.

STEP 15 — OUTPUT FORMATTING
- Activities: clean sentence, max 20 words, no pipes
- Transport booking_tip: one sentence only
- Practical info: max 4 sentences per field, most critical first. Plain prose, no bullet symbols.
- Overview: max 3 sentences — cities, trip tone, seasonal highlight. Always written in second person addressing the traveler as "you" and "your" — never "the couple", "the traveler", "the group", or any third person narrative.
- Costs: always a range with currency symbol
- Temperatures: always in Fahrenheit (°F). Never use Celsius.

STEP 16 — ACCURACY
Only use what was submitted. Never reference or invent details not provided. Never invent property names, venue names, or transport services you cannot reasonably verify exist.
Never assume or infer the traveler's nationality from their name or any other detail. For visa_requirements and entry_requirements in practical_info, provide general requirements covering the most common passport types: US/Canada, UK, EU, Australia. Note if visa-free for most Western passports. Include visa-on-arrival availability, e-visa options, and processing time.
Always address the traveler directly as "you" throughout the entire output — never refer to them by name or in third person.
Treat mustSee and extraNotes as hard instructions, not suggestions. Apply them before generating any output. If the traveler mentions existing bookings, flights, or accommodation — include them in book_before_you_go as already confirmed and reflect them in the day-by-day.
Cross-country airports: if arrival and departure airports are in different countries, note this in the overview and clarify which country the itinerary covers. Never plan activities or cities outside the submitted country.

OUTPUT — return exactly this JSON:
{
  "overview": "string — max 3 sentences",
  "recommended_cities": [
    {
      "city": "string",
      "why_recommended": "string — max 25 words"
    }
  ],
  "days": [
    {
      "date": "YYYY-MM-DD",
      "city": "string",
      "neighborhood_focus": "string",
      "morning": "string — Activity name — one line description. Max 20 words.",
      "afternoon": "string — Activity name — one line description. Max 20 words.",
      "evening": "string — Activity name — one line description. Max 20 words.",
      "breakfast_suggestion": "string — Breakfast: Restaurant or cafe name | neighborhood | one line why it fits today",
      "restaurant_suggestion": "string — Meal type (Lunch/Dinner): Restaurant name | neighborhood | one line why it fits today",
      "estimated_daily_cost": "string — range with currency"
    }
  ],
  "accommodations": [
    {
      "city": "string",
      "checkin": "YYYY-MM-DD",
      "checkout": "YYYY-MM-DD",
      "recommended_type": "string",
      "name": "string",
      "neighborhood": "string",
      "estimated_cost_per_night": "string",
      "why": "string — max 15 words"
    }
  ],
  "transport": [
    {
      "from": "string",
      "to": "string",
      "date": "YYYY-MM-DD",
      "recommended_mode": "string",
      "duration": "string",
      "estimated_cost": "string",
      "booking_tip": "string — one sentence"
    }
  ],
  "restaurants": [
    {
      "city": "string",
      "name": "string",
      "venue_type": "Breakfast · Brunch · Cafe · Bakery · Lunch · Dinner · Street Food · Dessert",
      "cuisine_category": "string",
      "price_range": "string",
      "known_for": "string — max 8 words",
      "neighborhood": "string",
      "travel_party_fit": "string",
      "why": "string — max 10 words"
    }
  ],
  "city_guide": [
    {
      "city": "string",
      "entries": [
        {
          "type": "string — from type list in Step 13",
          "name": "string",
          "description": "string — always populated, max 25 words. Never empty.",
          "category": "string — interest category",
          "spot_tier": "Iconic · Local Pick · Hidden Gem",
          "best_time": "Morning · Afternoon · Evening · Full Day · Any",
          "est_cost": "string — range with currency or Free",
          "neighborhood": "string"
        }
      ]
    }
  ],
  "hidden_finds": [
    // Variable length — NOT a fixed 5. Count = (cities ≤ 2 ? 3 : 2) × number of cities.
    {
      "emoji": "string — single relevant emoji",
      "title": "string — max 6 words",
      "description": "string — max 25 words, why it's special and non-obvious",
      "city": "string"
    }
  ],
  "book_before_you_go": [
    {
      "booking_priority": "Book now · 4–6 weeks ahead · On arrival",
      "item_name": "string",
      "city": "string",
      "date": "string",
      "est_cost": "string",
      "booking_tip": "string — one sentence, why booking ahead matters for this item",
      "booking_link": "string — official booking URL or empty string"
    }
  ],
  "practical_info": {
    "weather_summary": "string",
    "visa_requirements": "string",
    "entry_requirements": "string",
    "currency": "string",
    "connectivity": "string",
    "transport_tips": "string",
    "packing_tips": "string",
    "must_know": "string",
    "booking_priority": "string"
  }
}

TRAVELER PREFERENCES:
First name: ${d.firstName || ''}
Last name: ${d.lastName || ''}
Country: ${d.country || ''}
Arrival airport: ${d.arrivalAirport || ''}
Departure airport: ${d.departureAirport || ''}
Arrival date: ${d.arrivalDate || ''}
Departure date: ${d.departureDate || ''}
Total trip nights: ${tripNights || 'unknown'} (derived from arrival/departure dates)
TRIP LENGTH TIER: ${tripTier} — apply the per-tier output caps in STEP 6, STEP 7, and STEP 13. STANDARD trips keep the full current experience; only longer trips get leaner.
City planning mode: ${d.cityPlanningMode || ''}
Trip structure: ${d.tripStructure || 'not specified'}
Cities requested: ${citiesRequested}
AI recommendation: ${d.aiCityRecommendation}
Anchor cities: ${anchorCities}
Travel party: ${d.travelParty || ''}
Group size: ${d.groupSize || 'not specified'}
Pace: ${d.paceOfTravel || ''}
Travel style: ${travelStyle}
Accommodation style: ${accommodationStyle}
Interests weighted: ${interests}
Cuisine preferences: ${cuisinePreferences}
Must see: ${d.mustSee || ''}
Extra notes: ${d.extraNotes || ''}`;
};

// Strip markdown fences and extract a parseable JSON object from Claude's text.
// Returns the parsed object, or null if nothing parseable was found.
function parseClaudeResponse(rawText) {
  if (!rawText || typeof rawText !== 'string') return null;

  // Step 1 — strip markdown fences and surrounding whitespace
  let cleaned = rawText.trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  // Step 2 — attempt a direct parse
  try { return JSON.parse(cleaned); } catch (e) { /* fall through */ }

  // Step 3 — extract the first complete {...} block and try again
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch (e) { /* fall through */ }
  }

  return null;
}

// Validate the parsed object has every required top-level key.
function hasRequiredKeys(obj) {
  return !!obj && typeof obj === 'object' && !Array.isArray(obj) && REQUIRED_KEYS.every(k => k in obj);
}

// Shared streaming Anthropic call. Forces stream:true, reads the SSE stream,
// accumulates content_block_delta text, captures stop_reason from message_delta,
// stops on message_stop, and surfaces error events. Always resolves to
// { text, stopReason, error }: text is the assembled string (null on failure),
// error is null on success or { type, ... } on failure where type is one of
// 'http' | 'stream' | 'timeout' | 'exception'.
//
// Streaming keeps a continuous byte flow so Cloudflare's ~90s outbound-fetch
// idle timeout (524) never trips. timeoutMs is just a backstop AbortController
// for a genuinely stuck connection — it should rarely fire.
async function streamAnthropic(env, body, timeoutMs) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ ...body, stream: true })
    });

    if (!response.ok) {
      // Errors before the stream opens come back as a normal JSON body.
      let errBody = '';
      try { errBody = await response.text(); } catch (_) {}
      clearTimeout(timeoutId);
      console.error('Anthropic API error:', response.status, errBody);
      return { text: null, stopReason: null, error: { type: 'http', status: response.status, detail: errBody } };
    }

    // Read the SSE stream: accumulate text from content_block_delta events,
    // stop on message_stop, and surface any error events.
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let assembled = '';
    let stopReason = null;
    let streamError = null;
    let done = false;

    while (!done) {
      const { value, done: readerDone } = await reader.read();
      if (readerDone) break;
      buffer += decoder.decode(value, { stream: true });

      // SSE events are separated by blank lines; process complete lines only,
      // leaving any partial trailing line in the buffer.
      let nlIndex;
      while ((nlIndex = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nlIndex).trim();
        buffer = buffer.slice(nlIndex + 1);
        if (!line.startsWith('data:')) continue;

        const dataStr = line.slice(5).trim();
        if (!dataStr) continue;

        let event;
        try {
          event = JSON.parse(dataStr);
        } catch (_) {
          // Ignore unparseable data lines rather than aborting the whole stream.
          continue;
        }

        if (event.type === 'content_block_delta') {
          if (event.delta && typeof event.delta.text === 'string') {
            assembled += event.delta.text;
          }
        } else if (event.type === 'message_delta') {
          if (event.delta && event.delta.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
        } else if (event.type === 'error') {
          streamError = event.error || event;
        } else if (event.type === 'message_stop') {
          done = true;
          break;
        }
      }
    }
    clearTimeout(timeoutId);

    if (streamError) {
      console.error('Anthropic stream error:', JSON.stringify(streamError));
      return { text: null, stopReason, error: { type: 'stream', detail: streamError } };
    }

    console.log('Claude stream complete — length:', assembled.length, 'stop_reason:', stopReason);
    return { text: assembled || null, stopReason, error: null };
  } catch (err) {
    clearTimeout(timeoutId);
    const isTimeout = err.name === 'AbortError';
    console.error('Anthropic call failed:', isTimeout ? 'timeout' : err.message);
    return { text: null, stopReason: null, error: { type: isTimeout ? 'timeout' : 'exception', detail: err.message } };
  }
}

// Single Claude API call for itinerary generation. Returns the response text,
// or null on any failure (errors are logged inside streamAnthropic).
async function callClaude(env, prompt) {
  const { text } = await streamAnthropic(env, {
    model: 'claude-sonnet-4-6',
    // 32000 sizes for the 2-week worst case (14 nights, 5 cities, all interests high):
    // post-trim output estimates ~18k tokens central, ~24-27k with verbosity overrun.
    // 32000 clears that with headroom and is half the claude-sonnet-4-6 64000 ceiling,
    // so nothing within the 2-week cap should truncate. Raise toward 64000 if needed.
    max_tokens: 32000,
    messages: [{ role: 'user', content: prompt }]
  }, 300000);
  return text || null;
}

// Generate, parse, validate, and (once) retry the full itinerary.
// Always resolves — returns the itinerary object or a clean error object.
async function generateItinerary(env, d) {
  try {
    const basePrompt = ITINERARY_PROMPT(d);

    // Attempt 1 — base prompt
    let rawText = await callClaude(env, basePrompt);
    let parsed = parseClaudeResponse(rawText);
    if (hasRequiredKeys(parsed)) return parsed;
    console.error('Itinerary attempt 1 failed (parse or missing keys). Raw response:', rawText);

    // Attempt 2 — retry once with strict JSON instruction appended
    rawText = await callClaude(env, basePrompt + JSON_RETRY_INSTRUCTION);
    parsed = parseClaudeResponse(rawText);
    if (hasRequiredKeys(parsed)) return parsed;
    console.error('Itinerary retry failed (parse or missing keys). Raw response:', rawText);

    return { error: true, message: 'Itinerary generation failed — please try again.' };
  } catch (err) {
    console.error('generateItinerary exception:', err.message);
    return { error: true, message: 'Itinerary generation failed — please try again.' };
  }
}

// ── Google Places (v1) enrichment ───────────────────────────────
// Day-by-day activities are strings; enriched lookups are attached under
// day.places[slot] as { google_url, hours, rating } or null. Uses the new
// Places API v1 endpoints with X-Goog-Api-Key / X-Goog-FieldMask headers.

// Phrases that aren't real, findable venues — never looked up.
const VAGUE_VENUE_RE = /^(explore|wander|stroll|walk around|free time|relax|enjoy|discover|roam|browse|self-guided|at your own pace)/i;

// "[Iconic] Forbidden City — walk the axis..." -> "Forbidden City"
function extractActivityVenue(activity) {
  if (typeof activity !== 'string' || !activity.trim()) return null;
  let s = activity.replace(/^\s*\[(Iconic|Local Pick|Hidden Gem)\]\s*/i, '').trim();
  s = s.split(/\s[-–—]\s/)[0].trim();              // text before the dash separator
  if (!s || s.length < 3 || VAGUE_VENUE_RE.test(s)) return null;
  return s;
}

// "Dinner: Siji Minfu | Dongcheng — why" -> "Siji Minfu"
function extractRestaurantVenue(suggestion) {
  if (typeof suggestion !== 'string' || !suggestion.trim()) return null;
  let s = suggestion;
  const colon = s.indexOf(':');
  if (colon !== -1) s = s.slice(colon + 1);
  s = s.split('|')[0].split(/\s[-–—]\s/)[0].trim();
  if (!s || s.length < 3 || VAGUE_VENUE_RE.test(s)) return null;
  return s;
}

// One venue lookup: Text Search -> Place Details. Resolves to
// { google_url, hours, rating } or null on any failure (never throws).
async function enrichPlace(env, venueName, city) {
  try {
    const textQuery = `${venueName} ${city || ''}`.trim();

    const searchRes = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName'
      },
      body: JSON.stringify({ textQuery })
    });
    if (!searchRes.ok) return null;

    const searchData = await searchRes.json();
    const placeId = searchData.places && searchData.places[0] && searchData.places[0].id;
    if (!placeId) return null;

    const detailsRes = await fetch(`https://places.googleapis.com/v1/places/${placeId}`, {
      method: 'GET',
      headers: {
        'X-Goog-Api-Key': env.GOOGLE_MAPS_API_KEY,
        'X-Goog-FieldMask': 'id,googleMapsUri,currentOpeningHours,rating,formattedAddress'
      }
    });
    if (!detailsRes.ok) return null;

    const details = await detailsRes.json();
    return {
      google_url: details.googleMapsUri || null,
      hours: (details.currentOpeningHours && details.currentOpeningHours.weekdayDescriptions) || null,
      rating: typeof details.rating === 'number' ? details.rating : null
    };
  } catch (_) {
    return null;
  }
}

// Enrich all named day-by-day venues in parallel. Mutates and returns the
// itinerary. Promise.allSettled isolates every failure — one bad lookup never
// breaks the rest, and a missing key/days array is a no-op.
async function enrichItineraryWithPlaces(env, itinerary) {
  if (!env.GOOGLE_MAPS_API_KEY || !itinerary || !Array.isArray(itinerary.days)) return itinerary;

  const tasks = [];
  for (const day of itinerary.days) {
    if (!day || typeof day !== 'object') continue;
    day.places = day.places || {};
    const city = day.city || '';
    for (const slot of ['morning', 'afternoon', 'evening']) {
      const name = extractActivityVenue(day[slot]);
      if (name) tasks.push({ day, key: slot, name, city });
    }
    const breakfastName = extractRestaurantVenue(day.breakfast_suggestion);
    if (breakfastName) tasks.push({ day, key: 'breakfast_suggestion', name: breakfastName, city });
    const restName = extractRestaurantVenue(day.restaurant_suggestion);
    if (restName) tasks.push({ day, key: 'restaurant_suggestion', name: restName, city });
  }
  if (!tasks.length) return itinerary;

  const results = await Promise.allSettled(tasks.map(t => enrichPlace(env, t.name, t.city)));
  results.forEach((res, i) => {
    const { day, key } = tasks[i];
    day.places[key] = res.status === 'fulfilled' ? res.value : null;
  });
  return itinerary;
}

// Runs in the queue consumer after a confirmed payment: pull form data from KV,
// generate the itinerary directly via Claude, then hand the parsed JSON to Make.
async function fulfillOrder(env, session) {
  try {
    const metadata = session.metadata || {};
    const formDataId = metadata.formDataId;

    let formData = {};
    let approvedCities = [];
    let teaserDay = null;

    if (formDataId) {
      // Retrieve full form data from KV — no truncation, no data loss
      const kvData = await env.PREVIEW_STORE.get(`form_${formDataId}`);
      if (kvData) {
        try {
          const parsed = JSON.parse(kvData);
          formData = parsed.formData || {};
          approvedCities = parsed.approvedCities || [];
          teaserDay = parsed.teaserDay || null;
        } catch (e) {
          console.error('Failed to parse KV form data:', e.message);
        }
      } else {
        console.error('KV form data not found for formDataId:', formDataId);
      }
    }

    // Generate the full itinerary directly via Claude (no longer done in Make).
    const itinerary = await generateItinerary(env, { ...formData, approvedCities, teaserDay });
    if (itinerary && itinerary.error) {
      console.error('Itinerary generation failed for session', session.id, '-', itinerary.message);
    } else {
      // Enrich day-by-day venues with Google Places (v1) before sending. Isolated
      // so any enrichment failure leaves the itinerary intact and still ships.
      try {
        await enrichItineraryWithPlaces(env, itinerary);
      } catch (enrichErr) {
        console.error('Places enrichment failed (continuing unenriched):', enrichErr && enrichErr.message);
      }
    }

    // Make now only receives the final parsed JSON plus the identifiers it needs
    // to write the Sheet row and email the traveler.
    const makePayload = {
      stripeSessionId: session.id,
      amountPaid: session.amount_total,
      email: formData.email,
      firstName: formData.firstName,
      lastName: formData.lastName,
      country: formData.country,
      arrivalDate: formData.arrivalDate,
      departureDate: formData.departureDate,
      itinerary,
    };

    try {
      const makeResponse = await fetch(env.MAKE_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makePayload)
      });
      if (!makeResponse.ok) {
        console.error('Make webhook failed:', makeResponse.status, await makeResponse.text());
      }
    } catch (makeErr) {
      console.error('Make webhook error:', makeErr.message);
    }
  } catch (err) {
    console.error('fulfillOrder error:', err.message);
  }
}