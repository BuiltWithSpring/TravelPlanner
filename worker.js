// Single source of truth for the preview prompt — shared with index.html and
// test-perplexity.js. Wrangler bundles this import at deploy (esbuild handles
// the UMD/CommonJS interop automatically).
import { PREVIEW_PROMPT } from './preview-prompt.js';

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
      // Build `path` from RAW city names — the whole string is encodeURIComponent'd
      // below, so pre-encoding here would double-encode (e.g. "San Antonio" →
      // "San%2520Antonio"), which Google cannot geocode → g.co/staticmaperror.
      // `markers` is NOT wrapped in encodeURIComponent, so it uses single-encoded names.
      const encodedCities = cities.map((c) => encodeURIComponent(c));
      const path = `color:0x7c3aedff|weight:3|${cities.join('|')}`;
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

    // ── Route: /preview — preview generation (closed proxy) ────
    // Previously forwarded the client-built Anthropic body wholesale, which made
    // this an open proxy on our API key (any model, any prompt, any max_tokens).
    // Now: new clients send { formData } and the prompt is built SERVER-SIDE;
    // legacy cached clients (full body shape) are strictly validated and the
    // outbound body is rebuilt from scratch — never forwarded as received.
    if (url.pathname === '/preview' && request.method === 'POST') {
      try {
        // Per-IP rate limit: 20 previews/hour. KV is eventually consistent, so this
        // is a deterrent rather than a fortress — pair with a Cloudflare WAF rate
        // rule on /preview for hard enforcement.
        const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
        const rlKey = `rl:${ip}:${new Date().toISOString().slice(0, 13)}`;
        const rlCount = parseInt(await env.PREVIEW_STORE.get(rlKey) || '0', 10);
        if (rlCount >= 20) {
          return corsResponse({ error: 'Too many preview requests — please try again in an hour.' }, 429);
        }
        ctx.waitUntil(env.PREVIEW_STORE.put(rlKey, String(rlCount + 1), { expirationTtl: 3600 }));

        const raw = sanitizeDeep(await request.json());
        let body;

        if (raw && raw.formData && typeof raw.formData === 'object' && !Array.isArray(raw.formData)) {
          // New shape: { formData } — server-side prompt build.
          // NOTE: claude-sonnet-4-6 does not support assistant-message prefill —
          // JSON discipline comes from the system prompt + the forgiving parser.
          body = {
            model: 'claude-sonnet-4-6',
            max_tokens: 8000,
            temperature: 0.4,
            system: CLAUDE_SYSTEM_PROMPT,
            messages: [
              { role: 'user', content: PREVIEW_PROMPT(raw.formData) }
            ]
          };
        } else {
          // Legacy shape (cached index.html): exactly one user message, string
          // content, sane length. Model/max_tokens are pinned server-side.
          const msgs = raw && Array.isArray(raw.messages) ? raw.messages : [];
          const content = (msgs.length === 1 && msgs[0] && msgs[0].role === 'user' && typeof msgs[0].content === 'string')
            ? msgs[0].content : null;
          if (!content || content.length > 30000) {
            return corsResponse({ error: 'Invalid preview request.' }, 400);
          }
          body = {
            model: 'claude-sonnet-4-6',
            max_tokens: 8000,
            messages: [{ role: 'user', content }]
          };
        }

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
        const previewRaw = await env.PREVIEW_STORE.get(sessionId);
        if (!previewRaw) {
          return corsResponse({ error: 'Preview not found or expired.' }, 404);
        }

        // Parse preview — handle both old (raw preview JSON) and new ({ preview, formData }) formats
        let previewData = {}, fData = {};
        try {
          const parsed = JSON.parse(previewRaw);
          if (parsed && parsed.preview) {
            previewData = parsed.preview;
            fData = parsed.formData || {};
          } else {
            previewData = parsed;
          }
        } catch(e) { previewData = {}; }

        // Extract fields for the email
        const firstName = fData.firstName || previewData.firstName || '';
        const country = fData.country || previewData.country || 'your destination';
        const overview = previewData.overview || '';
        const cities = Array.isArray(previewData.recommended_cities) ? previewData.recommended_cities :
                       Array.isArray(previewData.cities) ? previewData.cities : [];
        const destination = (fData.country || previewData.country || '').trim();
        // Preview-time "hidden finds" come from the preview's local_picks ({emoji,title,description}).
        // The full itinerary's hidden_finds (with city) only exists post-payment, so no city label here.
        const localPicks = Array.isArray(previewData.local_picks) ? previewData.local_picks.slice(0, 3) : [];

        // Helper: truncate overview to ~180 chars at a word boundary
        const overviewSnippet = overview.length > 180
          ? overview.substring(0, overview.lastIndexOf(' ', 180)) + '…'
          : overview;

        // City pills HTML
        const cityNames = cities.slice(0, 5)
          .map(c => typeof c === 'string' ? c : (c.city || c.name || ''))
          .filter(Boolean);
        const cityPills = cityNames.map(name =>
          `<span style="display:inline-block;background:#ede9fe;color:#6d28d9;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:13px;font-weight:600;padding:4px 12px;border-radius:99px;margin:3px 4px 3px 0;">${name}</span>`
        ).join('');

        // Hidden finds cards (name + one-line description) from the preview's local_picks
        const hiddenFindsCards = localPicks.map(f => {
          const emoji = f.emoji || '💎';
          const title = f.title || '';
          const desc = f.description || '';
          if (!title && !desc) return '';
          return `<tr><td style="padding:8px 0;vertical-align:top;"><span style="font-size:18px;">${emoji}</span></td><td style="padding:8px 0 8px 10px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:14px;color:#3d3660;line-height:1.5;"><strong style="color:#0f0c1e;">${title}</strong>${desc ? `<br>${desc}` : ''}</td></tr>`;
        }).filter(Boolean).join('');

        const greeting = firstName ? `Hey ${firstName},` : 'Hey there,';

        // "What's included" checklist — dynamic from the traveler's selected sections (stored in
        // formData). Default to all sections for previews that predate section-select.
        const sel = (Array.isArray(fData.selectedSections) && fData.selectedSections.length)
          ? fData.selectedSections
          : ['day_by_day', 'accommodations', 'transportation', 'food'];
        const checkRow = (t) => `<tr><td style="padding:3px 0;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:14px;color:#3d3660;">✓&nbsp;&nbsp;${t}</td></tr>`;
        const checklistRows = [
          sel.includes('day_by_day') ? checkRow('Day-by-day plans for every city') : checkRow('City-by-city activity & restaurant guide'),
          ...(sel.includes('day_by_day') ? [checkRow('Local restaurant picks & hidden finds')] : []),
          ...(sel.includes('accommodations') ? [checkRow('Accommodation picks per city')] : []),
          ...(sel.includes('transportation') ? [checkRow('Route-optimised transport guide')] : []),
          checkRow('What to book before you go'),
        ].join('');

        const previewEmailHtml = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600;700&family=DM+Sans:opsz,wght@9..40,400;9..40,500;9..40,600&display=swap" rel="stylesheet"/>
<title>Your ${country} preview is saved</title>
</head>
<body style="margin:0;padding:0;background:#f7f5ff;font-family:'DM Sans',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
<table width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f7f5ff;padding:32px 16px;">
<tr><td align="center">
<table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;width:100%;">

  <!-- LOGO -->
  <tr><td style="padding-bottom:28px;" align="center">
    <table cellpadding="0" cellspacing="0" border="0">
      <tr>
        <td style="vertical-align:middle;padding-right:10px;">
          <img src="https://travel.builtwithspring.com/BWSLogo.png" width="34" height="34" alt="BuiltWithSpring" style="display:block;border-radius:9px;"/>
        </td>
        <td style="vertical-align:middle;">
          <span style="font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:17px;font-weight:700;color:#0f0c1e;letter-spacing:-0.02em;">BuiltWithSpring</span>
        </td>
      </tr>
    </table>
  </td></tr>

  <!-- CARD -->
  <tr><td style="background:#ffffff;border-radius:20px;padding:40px 40px 36px;box-shadow:0 2px 12px rgba(124,58,237,0.08);">

    <!-- Greeting + headline -->
    <p style="margin:0 0 6px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:15px;color:#7c72a0;">${greeting}</p>
    <h1 style="margin:0 0 20px;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:26px;font-weight:700;color:#0f0c1e;letter-spacing:-0.03em;line-height:1.2;">Your ${country} preview<br/>is saved. ✈️</h1>

    <!-- City pills -->
    ${cityPills ? `<div style="margin-bottom:24px;">${cityPills}</div>` : ''}

    <!-- Overview excerpt -->
    ${overviewSnippet ? `<p style="margin:0 0 28px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:15px;color:#3d3660;line-height:1.7;">${overviewSnippet}</p>` : ''}

    <!-- Divider -->
    <hr style="border:none;border-top:1px solid #e4e0f5;margin:0 0 24px;"/>

    <!-- Hidden finds teaser -->
    ${hiddenFindsCards ? `
    <p style="margin:0 0 12px;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:13px;font-weight:600;color:#7c3aed;text-transform:uppercase;letter-spacing:0.06em;">A taste of what's inside your ${destination || 'trip'} itinerary</p>
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
      ${hiddenFindsCards}
    </table>
    ` : ''}

    <!-- CTA button -->
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
      <tr><td align="center">
        <a href="${`https://bws-travel-proxy.springlam-co.workers.dev/p/${sessionId}`}" style="display:inline-block;background:#7c3aed;color:#ffffff;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;letter-spacing:-0.01em;text-decoration:none;padding:15px 36px;border-radius:12px;box-shadow:0 4px 20px rgba(124,58,237,0.35);">View my preview & book →</a>
      </td></tr>
    </table>

    <!-- Urgency nudge -->
    <p style="text-align:center;margin:0 0 20px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:12px;color:#7c72a0;">Your preview is saved for 30 days · Full itinerary unlocks after checkout</p>

    <!-- What's included -->
    <div style="background:#f7f5ff;border-radius:12px;padding:20px 24px;margin-bottom:4px;">
      <p style="margin:0 0 10px;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:13px;font-weight:700;color:#0f0c1e;text-transform:uppercase;letter-spacing:0.05em;">Your full itinerary includes</p>
      <table cellpadding="0" cellspacing="0" border="0">
        ${checklistRows}
      </table>
    </div>

  </td></tr>

  <!-- FOOTER -->
  <tr><td style="padding:24px 8px 0;" align="center">
    <p style="margin:0 0 6px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:12px;color:#7c72a0;">Questions? Reply to this email — I read every one.</p>
    <p style="margin:0;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:12px;color:#c4b5fd;">© 2026 BuiltWithSpring · Austin, TX · <a href="mailto:hello@builtwithspring.com" style="color:#7c3aed;text-decoration:none;">hello@builtwithspring.com</a></p>
  </td></tr>

</table>
</td></tr>
</table>
</body>
</html>`;

        // Store the email against the session for 7 days.
        await env.PREVIEW_STORE.put(`email:${sessionId}`, email, { expirationTtl: 60 * 60 * 24 * 7 });

        // Send the preview link email — best-effort, don't fail the request if Resend blips.
        try {
          const mailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'BuiltWithSpring Travel <hello@builtwithspring.com>',
              to: [email],
              subject: firstName ? `${firstName}, your ${country} preview is saved ✈️` : `Your ${country} preview is saved ✈️`,
              html: previewEmailHtml
            })
          });
          if (!mailRes.ok) {
            const errBody = await mailRes.text();
            console.error('[preview/save-email] Resend failed:', mailRes.status, errBody);
          } else {
            console.log('[preview/save-email] Resend email sent OK');
          }
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
        const { preview, formData: savedFormData } = await request.json();
        const id = Math.random().toString(36).substring(2, 8);
        await env.PREVIEW_STORE.put(id, JSON.stringify({ preview, formData: savedFormData || {} }), { expirationTtl: 60 * 60 * 24 * 30 });
        return corsResponse({ id }, 200);
      } catch (err) {
        return corsResponse({ error: err.message }, 500);
      }
    }

    // ── Route: /p/:id — Retrieve preview and redirect ─────────
    if (url.pathname.startsWith('/p/') && request.method === 'GET') {
      try {
        const rawPath = url.pathname.replace('/p/', '');
        const isDataRequest = rawPath.endsWith('/data');
        const id = isDataRequest ? rawPath.replace('/data', '') : rawPath;
        const data = await env.PREVIEW_STORE.get(id);
        if (!data) {
          return new Response('Preview not found or expired.', { status: 404 });
        }
        // If the visitor saved this preview, merge their email into the JSON so
        // the app can pre-populate it and attribute the Stripe checkout without
        // asking them to re-enter their details.
        let previewObj = {}, restoredFormData = {};
        try {
          const parsed = JSON.parse(data);
          if (parsed && parsed.preview) {
            previewObj = parsed.preview;
            restoredFormData = parsed.formData || {};
          } else {
            previewObj = parsed;
          }
        } catch(e) { previewObj = {}; }
        const savedEmail = await env.PREVIEW_STORE.get(`email:${id}`);
        if (savedEmail) previewObj.email = savedEmail;
        if (Object.keys(restoredFormData).length) previewObj._formData = restoredFormData;
        if (isDataRequest) {
          return corsResponse({ preview: previewObj }, 200);
        }
        return Response.redirect(`https://travel.builtwithspring.com/?previewId=${id}`, 302);
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

        // Two-tier pricing, decided SERVER-SIDE from the traveler's sections so the
        // client can't request full generation at the guide price. Day-by-Day
        // included → full itinerary (STRIPE_PRICE_ID, $29). Excluded → city-guide
        // edition (STRIPE_PRICE_ID_GUIDE, $19). Falls back to the full price with a
        // loud log if the guide price isn't configured yet.
        const selSections = Array.isArray(formData.selectedSections) ? formData.selectedSections : [];
        const isFullTier = selSections.length === 0 || selSections.includes('day_by_day');
        let checkoutPriceId = env.STRIPE_PRICE_ID;
        if (!isFullTier) {
          if (env.STRIPE_PRICE_ID_GUIDE) checkoutPriceId = env.STRIPE_PRICE_ID_GUIDE;
          else console.error('[checkout] STRIPE_PRICE_ID_GUIDE not set — charging full price for a guide-tier order. Set the secret: npx wrangler secret put STRIPE_PRICE_ID_GUIDE');
        }

        // Only pass safe, short fields to Stripe metadata for reference
        const params = new URLSearchParams({
          'mode': 'payment',
          'line_items[0][price]': checkoutPriceId,
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
          'metadata[tier]': isFullTier ? 'full' : 'guide',
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

    // ── TASK 4: Serve stored itinerary HTML ──
    if (url.pathname.startsWith('/itinerary/') && request.method === 'GET') {
      const itinId = url.pathname.replace('/itinerary/', '');
      if (itinId) {
        const html = await env.PREVIEW_STORE.get(`itinerary_${itinId}`);
        if (html) return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=3600' } });
        return new Response('Itinerary not found or expired.', { status: 404 });
      }
    }
    // ── END TASK 4 ──

    // ── Route: /admin/retry — Re-queue a failed Stripe session ────
    if (url.pathname === '/admin/retry' && request.method === 'GET') {
      // Auth: check Authorization header first, then ?secret= query param.
      const authHeader = request.headers.get('Authorization') || '';
      const secretParam = url.searchParams.get('secret') || '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : secretParam;

      if (!env.ADMIN_SECRET || !token || token !== env.ADMIN_SECRET) {
        return new Response('Unauthorized', { status: 401 });
      }

      const sessionId = url.searchParams.get('session');
      if (!sessionId) {
        return corsResponse({ error: 'Missing required param: session' }, 400);
      }

      // Re-fetch the Stripe session so we have the full object the queue consumer expects.
      let stripeSession;
      try {
        const stripeRes = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`, {
          headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
        });
        if (!stripeRes.ok) {
          const errText = await stripeRes.text();
          console.error('[admin/retry] Stripe session fetch failed:', stripeRes.status, errText);
          return corsResponse({ error: `Stripe session fetch failed: ${stripeRes.status}` }, 502);
        }
        stripeSession = await stripeRes.json();
      } catch (fetchErr) {
        console.error('[admin/retry] Stripe fetch threw:', fetchErr && fetchErr.message);
        return corsResponse({ error: 'Failed to fetch Stripe session.' }, 500);
      }

      // Re-queue into ITINERARY_QUEUE — the consumer will run fulfillOrder again.
      try {
        await env.ITINERARY_QUEUE.send(stripeSession);
        console.log('[admin/retry] Re-queued session:', sessionId);
        return new Response(
          `<html><body style="font-family:sans-serif;padding:40px;max-width:480px;">` +
          `<h2 style="color:#7c3aed;">✓ Session re-queued</h2>` +
          `<p>Session <strong>${sessionId}</strong> has been sent back to the queue.</p>` +
          `<p style="color:#7c72a0;font-size:13px;">Generation will start momentarily. Check Cloudflare logs for progress.</p>` +
          `</body></html>`,
          { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } }
        );
      } catch (queueErr) {
        console.error('[admin/retry] Queue send failed:', queueErr && queueErr.message);
        return corsResponse({ error: 'Failed to enqueue session.' }, 500);
      }
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

// ── Admin: failure alert email ───────────────────────────────────
// Sends a Resend alert to Spring when itinerary generation fails.
// Best-effort — never throws; a mail delivery hiccup must not mask the original error.
async function sendFailureAlert(env, session, errorMessage) {
  try {
    const sessionId = (session && session.id) || 'unknown';
    const customerEmail = (session && session.customer_details && session.customer_details.email)
      || (session && session.metadata && session.metadata.email) || '';
    const firstName = (session && session.metadata && session.metadata.firstName) || '';
    const lastName  = (session && session.metadata && session.metadata.lastName)  || '';
    const country   = (session && session.metadata && session.metadata.country)   || '';
    const customerName = [firstName, lastName].filter(Boolean).join(' ') || '(unknown)';

    // Build a pre-authenticated one-click retry link so Spring can re-queue without a tool.
    const secret = env.ADMIN_SECRET || '';
    const retryUrl = `https://bws-travel-proxy.springlam-co.workers.dev/admin/retry?session=${encodeURIComponent(sessionId)}${secret ? '&secret=' + encodeURIComponent(secret) : ''}`;

    const html =
      `<h2 style="color:#c0392b;">⚠️ Itinerary generation failed</h2>` +
      `<table style="border-collapse:collapse;font-family:sans-serif;font-size:14px;">` +
      `<tr><td style="padding:6px 16px 6px 0;color:#7c72a0;font-weight:600;">Session ID</td><td style="padding:6px 0;">${sessionId}</td></tr>` +
      `<tr><td style="padding:6px 16px 6px 0;color:#7c72a0;font-weight:600;">Customer</td><td style="padding:6px 0;">${customerName}${customerEmail ? ' &lt;' + customerEmail + '&gt;' : ''}</td></tr>` +
      (country ? `<tr><td style="padding:6px 16px 6px 0;color:#7c72a0;font-weight:600;">Country</td><td style="padding:6px 0;">${country}</td></tr>` : '') +
      `<tr><td style="padding:6px 16px 6px 0;color:#7c72a0;font-weight:600;">Error</td><td style="padding:6px 0;color:#c0392b;">${errorMessage || 'unknown'}</td></tr>` +
      `</table>` +
      `<p style="margin-top:24px;">` +
      `<a href="${retryUrl}" style="background:#7c3aed;color:#ffffff;font-family:sans-serif;font-size:14px;font-weight:700;text-decoration:none;padding:12px 24px;border-radius:8px;">` +
      `Retry generation →</a></p>` +
      `<p style="font-size:12px;color:#7c72a0;margin-top:12px;">The retry link re-queues this session. Clicking it more than once is safe — the queue consumer is idempotent.</p>`;

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Travel Planner Alerts <hello@builtwithspring.com>',
        to: ['hello@builtwithspring.com'],
        subject: `⚠️ Itinerary failed — ${customerName}${country ? ' · ' + country : ''} · ${sessionId}`,
        html
      })
    });
    if (!res.ok) {
      console.error('[alert] Resend failed:', res.status, await res.text());
    } else {
      console.log('[alert] Failure alert sent for session:', sessionId);
    }
  } catch (alertErr) {
    console.error('[alert] sendFailureAlert threw:', alertErr && alertErr.message);
  }
}

// ── TASK 4: Itinerary rendering helpers ──────────────────────────
function esc(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// Strip non-Latin script (CJK, Kana, Hangul, Cyrillic, …) from a name, then
// HTML-escape. Safety net for venue/property names — PDF export renders
// non-Latin glyphs as blank boxes. Accented Latin (é, ñ, ü) is preserved.
function escName(s) {
  const cleaned = String(s == null ? '' : s)
    .replace(/[　-〿＀-￯]/g, '') // CJK punctuation & full/half-width forms
    .replace(/[^\P{L}\p{Script=Latin}]/gu, '')    // non-Latin letters only (keeps Latin + non-letters)
    .replace(/\(\s*\)/g, '')                        // drop parentheses left empty after stripping
    .replace(/\s{2,}/g, ' ')                        // collapse doubled spaces
    .trim();
  return esc(cleaned);
}

function parseBadge(text, tier) {
  // Treat "N/A" (e.g. a departure/transit-day slot) as empty so the slot renders nothing.
  if (/^n\s*\/?\s*a\.?$/i.test(String(text || '').trim())) return { cls: '', label: '', body: '' };
  const map = { 'Iconic': ['badge-iconic','Iconic'], 'Local Pick': ['badge-local','Local Pick'], 'Hidden Gem': ['badge-hidden','Hidden Gem'] };
  // New system: tier comes from a separate _tier field — use it directly if valid.
  if (tier && map[tier]) return { cls: map[tier][0], label: map[tier][1], body: esc(text) };
  // Legacy fallback: parse [Iconic]/[Local Pick]/[Hidden Gem] prefix from the string itself.
  const m = String(text || '').match(/^\[(Iconic|Local Pick|Hidden Gem)\]\s*/);
  if (!m) return { cls: '', label: '', body: esc(text) };
  return { cls: map[m[1]][0], label: map[m[1]][1], body: esc(text.slice(m[0].length)) };
}

function formatDateLong(s) {
  if (!s) return '';
  const d = new Date(s + 'T12:00:00Z');
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

function formatDayHead(s) {
  if (!s) return '';
  const d = new Date(s + 'T12:00:00Z');
  const dow = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getUTCDay()];
  const mon = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][d.getUTCMonth()];
  return `${dow} · ${mon} ${d.getUTCDate()}`;
}

function calcNights(checkin, checkout) {
  const a = Date.parse(checkin), b = Date.parse(checkout);
  return (!isNaN(a) && !isNaN(b) && b > a) ? Math.round((b - a) / 86400000) : null;
}

function priorityBadge(p) {
  if (!p) return '';
  if (/now/i.test(p)) return '<span class="prio prio-now">Book now</span>';
  if (/week/i.test(p)) return '<span class="prio prio-soon">4–6 weeks ahead</span>';
  return '<span class="prio prio-arrival">On arrival</span>';
}

function parseRestLine(text) {
  if (!text) return null;
  // Treat "N/A" (e.g. departure-day dinner) as no meal — render nothing.
  const isNA = (s) => /^n\s*\/?\s*a\.?$/i.test((s || '').trim());
  if (isNA(text)) return null;
  const ci = text.indexOf(':');
  if (ci === -1) return { label: 'Meal', name: text, neighborhood: '', desc: '' };
  const label = text.slice(0, ci).trim();
  const parts = text.slice(ci + 1).split('|').map(p => p.trim());
  if (isNA(parts[0])) return null;
  return { label, name: parts[0] || '', neighborhood: parts[1] || '', desc: parts[2] || '' };
}

function affViator(city, q) {
  return `https://www.viator.com/search/${encodeURIComponent(city)}?q=${encodeURIComponent(q)}&pid=P00307099&mcid=42383&medium=api`;
}
function affGYG(city, q) {
  return `https://www.getyourguide.com/s/?q=${encodeURIComponent(q + ' ' + city)}&partner_id=NLNHMQA`;
}
function affBooking(city) {
  return `https://www.booking.com/search.html?ss=${encodeURIComponent(city)}&aid=7997579`;
}
// ── END helpers ──────────────────────────────────────────────────

// ── TASK 4: renderItinerary ─────────────────────────────────────
function renderItinerary(formData, itinerary) {
  const { firstName = '', country = '', arrivalDate = '', departureDate = '' } = formData || {};
  const {
    overview = '',
    recommended_cities = [],
    days = [],
    accommodations = [],
    transport = [],
    restaurants = [],
    hidden_finds = [],
    book_before_you_go = [],
    practical_info = {}
  } = itinerary || {};

  const totalNights = calcNights(arrivalDate, departureDate) || days.length;

  // ── Cities for static map ──
  const cityOrder = [];
  for (const day of days) {
    if (day.city && !cityOrder.includes(day.city)) cityOrder.push(day.city);
  }
  // Mode B: no days — fall back to recommended_cities order
  if (!cityOrder.length) {
    const fallback = Array.isArray(itinerary && itinerary.cities)
      ? itinerary.cities
      : recommended_cities;
    for (const c of fallback) {
      const name = c && c.city;
      if (name && !cityOrder.includes(name)) cityOrder.push(name);
    }
  }
  const staticMapUrl = cityOrder.length
    ? `https://bws-travel-proxy.springlam-co.workers.dev/static-map?cities=${cityOrder.map(encodeURIComponent).join(',')}`
    : '';

  // Static-map <img> + a styled fallback that reveals itself if the map fails to load
  // (e.g. the Static Maps API errors for a given city combination). The onerror hides
  // the broken image and shows the route as a simple city list instead of a broken-map error.
  const mapFallbackInner = `<span class="rmf-label">Your Route</span>${cityOrder.map(esc).join('<span class="rmf-arrow">→</span>')}`;
  const staticMapHtml = staticMapUrl
    ? `<img class="route-map" alt="${esc(country)} route map" src="${esc(staticMapUrl)}" onerror="this.style.display='none';this.nextElementSibling.style.display='block';"><div class="route-map-fallback" style="display:none;">${mapFallbackInner}</div>`
    : '';

  // ── Cities section (from accommodations) ──
  // Group accommodations by city (preserve first-seen order) so each city renders as ONE
  // card. Claude returns up to two hotels per city; list them as Option 1 / Option 2.
  const cityAccomGroups = [];
  for (const a of accommodations) {
    if (!a || !a.city) continue;
    // Group by city + check-in date so that two stays in the same city (e.g. a round-trip
    // return) each get their own city card. Two hotels with the same city + check-in are
    // Option 1 / Option 2 for the same stay and stay grouped together.
    const stayKey = `${a.city}::${(a.checkin || '').substring(0, 10)}`;
    let g = cityAccomGroups.find(x => x.stayKey === stayKey);
    if (!g) { g = { stayKey, city: a.city, hotels: [] }; cityAccomGroups.push(g); }
    g.hotels.push(a);
  }
  const teaserByCity = {};
  for (const c of recommended_cities) { if (c && c.city) teaserByCity[c.city] = c.city_teaser || ''; }
  const cityRowsHtml = cityAccomGroups.map(g => {
    const n = calcNights(g.hotels[0].checkin, g.hotels[0].checkout);
    return `<div class="city-row intro-city">
      <div class="nights-pill"><div class="n">${n || '?'}</div><div class="l">Nights</div></div>
      <div><h3>${esc(g.city)}</h3><p>${esc(teaserByCity[g.city] || '')}</p></div>
    </div>`;
  }).join('')
    || recommended_cities.map(c =>
        `<div class="city-row intro-city"><div><h3>${esc(c.city)}</h3><p>${esc(c.city_teaser || c.why_recommended || '')}</p></div></div>`
      ).join('')
    || (Array.isArray(formData.approvedCities) ? formData.approvedCities : []).map(c => {
        const cityName = (typeof c === 'string') ? c : (c.city || '');
        const teaser = (typeof c === 'object') ? (c.city_teaser || '') : '';
        return `<div class="city-row intro-city"><div><h3>${esc(cityName)}</h3>${teaser ? `<p>${esc(teaser)}</p>` : ''}</div></div>`;
      }).join('');

  // ── Day-by-day (group consecutive days by city) ──
  const cityGroups = [];
  for (const day of days) {
    const last = cityGroups[cityGroups.length - 1];
    if (!last || last.city !== day.city) cityGroups.push({ city: day.city, days: [day] });
    else last.days.push(day);
  }

  const dayByDayHtml = cityGroups.map(group => {
    const firstDay = group.days[0];
    const lastDay = group.days[group.days.length - 1];
    const groupStart = firstDay.date;

    // A city can be visited more than once (e.g. a return leg before flying home), so
    // match the accommodation stay to THIS leg by date window — not just the city name.
    // A plain city-name find() would return the FIRST stay and render its earlier
    // checkout as this leg's end date (e.g. "Oct 13 – Oct 3"). Fall back to the stay
    // whose checkin lines up, then the closest checkin.
    const cityAccoms = accommodations.filter(a => a && a.city === group.city);
    const cityAccom =
      cityAccoms.find(a => a.checkin && a.checkout && a.checkin <= groupStart && groupStart < a.checkout) ||
      cityAccoms.find(a => a.checkin === groupStart) ||
      cityAccoms.slice().sort((a, b) =>
        Math.abs(Date.parse(a.checkin) - Date.parse(groupStart)) -
        Math.abs(Date.parse(b.checkin) - Date.parse(groupStart))
      )[0] || null;

    // Day after the last scheduled day in this city — the fallback leg end.
    const dayAfterLast = (() => {
      const d = new Date(lastDay.date);
      d.setDate(d.getDate() + 1);
      return d.toISOString().split('T')[0];
    })();
    // Use the accommodation checkout only when it's actually after this leg's start;
    // otherwise (wrong/missing stay) fall back so the end can never precede the start.
    const checkoutValid = cityAccom && cityAccom.checkout && cityAccom.checkout > groupStart;
    const checkoutDate = checkoutValid ? cityAccom.checkout : dayAfterLast;
    // Derive nights from the displayed range so header nights and dates always agree.
    const nightsInCity = calcNights(groupStart, checkoutDate) || group.days.length;
    const dateRange = `${formatDateLong(groupStart)} – ${formatDateLong(checkoutDate)}`;

    const daysHtml = group.days.map(day => {
      const morning = parseBadge(day.morning, day.morning_tier);
      const afternoon = parseBadge(day.afternoon, day.afternoon_tier);
      const evening = parseBadge(day.evening, day.evening_tier);
      const bk = parseRestLine(day.breakfast_suggestion);
      const dinner = parseRestLine(day.restaurant_suggestion);

      const slotHtml = (slot) => slot.cls
        ? `<span class="badge ${slot.cls}">${slot.label}</span>${slot.body}`
        : slot.body;

      const restLineHtml = (r) => r
        ? `<div class="restaurant-line"><span class="r-label">${esc(r.label)}</span><strong>${escName(r.name)}</strong>${r.neighborhood ? ` · ${esc(r.neighborhood)}` : ''}${r.desc ? ` — ${esc(r.desc)}` : ''}</div>`
        : '';

      return `<div class="day">
        <div class="day-head">
          <div class="d-date">${esc(formatDayHead(day.date))}</div>
          <div class="d-focus">${esc(day.neighborhood_focus || '')}</div>
          ${day.estimated_daily_cost ? `<div class="d-cost">${esc(day.estimated_daily_cost)}</div>` : ''}
        </div>
        ${morning.body ? `<div class="slot"><div class="slot-label">Morning</div><div class="slot-body">${slotHtml(morning)}</div></div>` : ''}
        ${afternoon.body ? `<div class="slot"><div class="slot-label">Afternoon</div><div class="slot-body">${slotHtml(afternoon)}</div></div>` : ''}
        ${evening.body ? `<div class="slot"><div class="slot-label">Evening</div><div class="slot-body">${slotHtml(evening)}</div></div>` : ''}
        ${restLineHtml(bk)}
        ${restLineHtml(dinner)}
      </div>`;
    }).join('');

    return `<div class="city-band"><div class="cb-city">${esc(group.city)}</div><div class="cb-meta">${esc(dateRange)} · ${nightsInCity} ${nightsInCity === 1 ? 'night' : 'nights'}</div></div>${daysHtml}`;
  }).join('');

  // ── Hidden Finds ──
  const hiddenFindsHtml = hidden_finds.map(f =>
    `<div class="find-card">
      <div class="emoji">${esc(f.emoji)}</div>
      <h4>${escName(f.title)}</h4>
      <p>${esc(f.description)}</p>
      <div class="find-city">${esc(f.city)}</div>
      <div>
        <a class="aff" target="_blank" rel="noopener noreferrer" href="${esc(affViator(f.city, f.title))}">Search Viator →</a>
        <a class="aff" target="_blank" rel="noopener noreferrer" href="${esc(affGYG(f.city, f.title))}">Search GetYourGuide →</a>
      </div>
    </div>`
  ).join('');

  // ── Restaurants (grouped by city) ──
  const restCities = [...new Set(restaurants.map(r => r.city))];
  const restaurantsHtml = restCities.map(city => {
    const cityRests = restaurants.filter(r => r.city === city);
    const cardsHtml = cityRests.map(r =>
      `<div class="rest-card">
        <div class="rest-head"><h4>${escName(r.name)}</h4><span class="rest-type">${esc(r.venue_type)}</span></div>
        <p class="rest-desc">${esc(r.known_for || r.why || '')}</p>
        <div class="rest-meta"><strong>Cuisine:</strong> ${esc(r.cuisine_category)} · <strong>Price:</strong> ${esc(r.price_range)} · <strong>Area:</strong> ${esc(r.neighborhood)}</div>
        <a class="aff" target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/${encodeURIComponent(r.name + ' ' + city)}">Find on Google Maps →</a>
      </div>`
    ).join('');
    return `<div class="city-band"><div class="cb-city">${esc(city)}</div></div>${cardsHtml}`;
  }).join('');

  // ── Accommodations (grouped by city) ──
  // One city-band header per city; each hotel below it, labelled Option N when several.
  const accommodationsHtml = cityAccomGroups.map(g => {
    const cardsHtml = g.hotels.map((a, i) => {
      const n = calcNights(a.checkin, a.checkout);
      const optionPrefix = g.hotels.length > 1 ? `Option ${i + 1}: ` : '';
      return `<div class="card card-accent">
      <div class="rest-head">
        <h4 style="margin:0;font-size:18px;">${optionPrefix}${escName(a.name)}</h4>
        <span class="rest-type">${esc(a.recommended_type)}</span>
      </div>
      <div class="rest-meta" style="margin:8px 0;">
        <strong>Neighbourhood:</strong> ${esc(a.neighborhood)}<br>
        ${a.checkin ? `<strong>Check-in:</strong> ${esc(formatDateLong(a.checkin))} &nbsp;·&nbsp; <strong>Check-out:</strong> ${esc(formatDateLong(a.checkout))}${n ? ` &nbsp;·&nbsp; <strong>${n} ${n === 1 ? 'night' : 'nights'}</strong>` : ''} &nbsp;·&nbsp; ` : ''}<strong>Per night:</strong> ${esc(a.estimated_cost_per_night)}
      </div>
      <p style="margin:8px 0 10px;">${esc(a.why)}</p>
      <a class="aff" target="_blank" rel="noopener noreferrer" href="${esc(affBooking(a.city))}">Search Booking.com →</a>
    </div>`;
    }).join('');
    return `<div class="city-band"><div class="cb-city">${esc(g.city)}</div></div>${cardsHtml}`;
  }).join('');

  // ── Transport legs ──
  const transportHtml = transport.map(t =>
    `<div class="leg">
      <div class="leg-route">${esc(t.from)}<span class="arrow">→</span>${esc(t.to)}</div>
      <div class="leg-meta">
        <span><strong>Mode:</strong> ${esc(t.recommended_mode)}</span>
        <span><strong>Duration:</strong> ${esc(t.duration)}</span>
        <span><strong>Cost:</strong> ${esc(t.estimated_cost)}</span>
      </div>
      <div class="leg-tip">${esc(t.booking_tip)}</div>
    </div>`
  ).join('');

  // ── Book Before You Go ──
  const bookRowsHtml = book_before_you_go.map(b =>
    `<tr>
      <td><strong>${esc(b.item_name)}</strong>${b.date ? `<br><span style="color:var(--muted)">${esc(b.date)}</span>` : ''}</td>
      <td>${priorityBadge(b.booking_priority)}</td>
      <td>${esc(b.booking_tip)}</td>
      <td>${esc(b.est_cost)}</td>
    </tr>`
  ).join('');

  // ── Getting Around (populated in Mode B recs; empty otherwise) ──
  const ga = itinerary.getting_around;
  const gettingAroundHtml = (ga && (ga.overview || (Array.isArray(ga.tips) && ga.tips.length)))
    ? `<div class="page section"><h2 class="section-header">Getting Around ${esc(country)}</h2>
      ${ga.overview ? `<div class="card card-accent"><p class="lead">${esc(ga.overview)}</p></div>` : ''}
      ${(Array.isArray(ga.tips) && ga.tips.length) ? `<div class="card">${ga.tips.map(t => `<p style="margin:0 0 8px;">• ${esc(t)}</p>`).join('')}</div>` : ''}
    </div>`
    : '';

  // ── Practical Info ──
  const pi = practical_info;
  const practicalCards = [
    pi.weather_summary     && ['☀️', 'Weather',           pi.weather_summary],
    pi.visa_requirements   && ['🛂', 'Visa &amp; Entry',   (pi.visa_requirements + (pi.entry_requirements ? ' ' + pi.entry_requirements : ''))],
    pi.currency            && ['💴', 'Currency &amp; Payments', pi.currency],
    pi.connectivity        && ['📱', 'Connectivity',       pi.connectivity],
    pi.transport_tips      && !gettingAroundHtml && ['🚆', 'Getting Around',     pi.transport_tips],
    pi.packing_tips        && ['🎒', 'Packing Tips',       pi.packing_tips],
    pi.must_know           && ['💡', 'Must Know',          pi.must_know],
  ].filter(Boolean).map(([ico, title, body]) =>
    `<div class="card info-card"><h4><span class="ico">${ico}</span>${title}</h4><p>${esc(body)}</p></div>`
  ).join('');

  // ── Assemble full page ──
  // Copy the full <style> block verbatim from /Users/springlam/Desktop/TravelPlanner/itinerary-template.html
  // (Read that file and embed the CSS content between the <style> tags as the CSS variable below)
  const CSS = `
  :root {
    --accent: #7c3aed;
    --accent-soft: #f4efff;
    --text: #0f0c1e;
    --muted: #7c72a0;
    --border: #e8e3f5;
    --gold: #b8860b;
    --gold-soft: #fbf3df;
    --teal: #0d8a7a;
    --teal-soft: #e2f5f1;
    --purple: #7c3aed;
    --purple-soft: #f4efff;
  }

  * { box-sizing: border-box; }

  html, body {
    margin: 0;
    padding: 0;
    background: #ffffff;
    color: var(--text);
    font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
    font-size: 15px;
    line-height: 1.6;
    -webkit-font-smoothing: antialiased;
  }

  .page {
    max-width: 820px;
    margin: 0 auto;
    padding: 56px 48px 72px;
  }

  /* Each major section begins a new printed page */
  .section { page-break-before: always; }

  /* ── Section headers ───────────────────────────── */
  .section-header {
    font-size: 18px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    border-left: 5px solid var(--accent);
    padding: 4px 0 4px 16px;
    margin: 0 0 28px;
  }
  .section-sub {
    color: var(--muted);
    font-size: 14px;
    margin: -20px 0 28px 21px;
  }

  /* ── Cover page ────────────────────────────────── */
  .cover {
    page-break-after: always;
    min-height: 92vh;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }
  .logo {
    font-size: 15px;
    font-weight: 700;
    letter-spacing: 0.04em;
    color: var(--accent);
    margin-bottom: 48px;
  }
  .logo .spring { color: var(--text); }
  .cover-eyebrow {
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.18em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 12px;
  }
  .cover-country {
    font-size: 64px;
    font-weight: 700;
    line-height: 1.05;
    margin: 0 0 8px;
    letter-spacing: -0.02em;
  }
  .cover-name {
    font-size: 22px;
    font-weight: 500;
    color: var(--accent);
    margin-bottom: 40px;
  }
  .cover-meta {
    display: flex;
    gap: 40px;
    border-top: 1px solid var(--border);
    border-bottom: 1px solid var(--border);
    padding: 22px 0;
    margin-bottom: 36px;
  }
  .cover-meta div { line-height: 1.4; }
  .cover-meta .label {
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 4px;
  }
  .cover-meta .value { font-size: 17px; font-weight: 600; }
  .cover-cities-title {
    font-size: 12px;
    font-weight: 600;
    letter-spacing: 0.12em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 14px;
  }
  .cover-cities { list-style: none; padding: 0; margin: 0; }
  .cover-cities li {
    font-size: 19px;
    font-weight: 600;
    padding: 10px 0 10px 18px;
    border-left: 3px solid var(--accent);
    margin-bottom: 10px;
  }
  .cover-cities li span { color: var(--muted); font-weight: 500; font-size: 15px; }

  /* ── Generic cards ─────────────────────────────── */
  .card {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 20px 22px;
    margin-bottom: 16px;
  }
  .card-accent { border-left: 4px solid var(--accent); }

  .lead {
    font-size: 17px;
    line-height: 1.7;
    color: var(--text);
  }

  /* ── Tier badges ───────────────────────────────── */
  .badge {
    display: inline-block;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.04em;
    padding: 2px 9px;
    border-radius: 5px;
    vertical-align: middle;
    margin-right: 6px;
    white-space: nowrap;
  }
  .badge-iconic { background: var(--gold-soft); color: var(--gold); }
  .badge-local  { background: var(--teal-soft); color: var(--teal); }
  .badge-hidden { background: var(--purple-soft); color: var(--purple); }

  /* ── City rows (Your Cities) ───────────────────── */
  .city-row {
    display: flex;
    align-items: flex-start;
    gap: 20px;
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: 12px;
    padding: 20px 22px;
    margin-bottom: 16px;
  }
  .city-row .nights-pill {
    flex: 0 0 auto;
    text-align: center;
    background: var(--accent-soft);
    border-radius: 10px;
    padding: 12px 16px;
    min-width: 76px;
  }
  .city-row .nights-pill .n { font-size: 26px; font-weight: 700; color: var(--accent); line-height: 1; }
  .city-row .nights-pill .l { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.08em; }
  .city-row h3 { margin: 0 0 4px; font-size: 19px; }
  .city-row p { margin: 0; color: var(--muted); }

  /* ── Day-by-day ────────────────────────────────── */
  .city-band {
    margin: 36px 0 20px;
    padding: 10px 0 10px 16px;
    border-left: 5px solid var(--accent);
  }
  .city-band:first-child { margin-top: 0; }
  .city-band .cb-city { font-size: 20px; font-weight: 700; }
  .city-band .cb-meta { font-size: 13px; color: var(--muted); }

  .day {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 22px 24px;
    margin-bottom: 18px;
  }
  .day-head {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    gap: 16px;
    border-bottom: 1px solid var(--border);
    padding-bottom: 12px;
    margin-bottom: 16px;
  }
  .day-head .d-date { font-size: 16px; font-weight: 700; }
  .day-head .d-focus { font-size: 13px; color: var(--muted); }
  .day-head .d-cost { font-size: 13px; color: var(--accent); font-weight: 600; }

  .slot { margin-bottom: 14px; }
  .slot:last-child { margin-bottom: 0; }
  .slot .slot-label {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 3px;
  }
  .slot .slot-body { font-size: 15px; }

  .restaurant-line {
    margin-top: 16px;
    padding: 12px 14px;
    background: var(--accent-soft);
    border-radius: 8px;
    font-size: 14px;
  }
  .restaurant-line .r-label {
    font-weight: 700;
    color: var(--accent);
    text-transform: uppercase;
    font-size: 11px;
    letter-spacing: 0.08em;
    margin-right: 6px;
  }

  /* ── Affiliate links ───────────────────────────── */
  .aff {
    display: inline-block;
    margin-top: 6px;
    margin-right: 14px;
    font-size: 12px;
    font-weight: 600;
    color: #7c3aed;
    text-decoration: none;
  }
  .aff:hover { color: #5b21b6; }

  /* ── Hidden finds ──────────────────────────────── */
  .finds-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }
  .find-card {
    border: 1px solid var(--border);
    border-left: 4px solid var(--purple);
    border-radius: 12px;
    padding: 18px 20px;
  }
  .find-card .emoji { font-size: 26px; line-height: 1; }
  .find-card h4 { margin: 10px 0 6px; font-size: 16px; }
  .find-card p { margin: 0 0 8px; color: var(--muted); font-size: 14px; }
  .find-card .find-city {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--purple);
  }

  /* ── Restaurants ───────────────────────────────── */
  .rest-card {
    border: 1px solid var(--border);
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 12px;
  }
  .rest-head { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; }
  .rest-head h4 { margin: 0; font-size: 16px; }
  .rest-type {
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent);
    background: var(--accent-soft);
    padding: 2px 9px;
    border-radius: 5px;
    white-space: nowrap;
  }
  .rest-card .rest-desc { margin: 6px 0 8px; }
  .rest-meta { font-size: 13px; color: var(--muted); }
  .rest-meta strong { color: var(--text); font-weight: 600; }

  /* ── Tables ────────────────────────────────────── */
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 14px;
  }
  thead th {
    text-align: left;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--muted);
    border-bottom: 2px solid var(--border);
    padding: 0 12px 10px;
  }
  tbody td {
    padding: 14px 12px;
    border-bottom: 1px solid var(--border);
    vertical-align: top;
  }
  tbody tr:last-child td { border-bottom: none; }
  .prio {
    display: inline-block;
    font-size: 11px;
    font-weight: 700;
    padding: 2px 9px;
    border-radius: 5px;
    white-space: nowrap;
  }
  .prio-now { background: #fdeaea; color: #c0392b; }
  .prio-soon { background: var(--gold-soft); color: var(--gold); }
  .prio-arrival { background: var(--teal-soft); color: var(--teal); }

  /* ── Transport ─────────────────────────────────── */
  .leg {
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: 12px;
    padding: 18px 22px;
    margin-bottom: 14px;
  }
  .leg-route { font-size: 17px; font-weight: 700; margin-bottom: 4px; }
  .leg-route .arrow { color: var(--accent); margin: 0 8px; }
  .leg-meta { font-size: 13px; color: var(--muted); margin-bottom: 10px; }
  .leg-meta span { margin-right: 18px; }
  .leg-meta strong { color: var(--text); font-weight: 600; }
  .leg-tip { font-size: 14px; }

  /* ── Practical info ────────────────────────────── */
  .info-block { margin-bottom: 18px; }
  .info-block h4 {
    margin: 0 0 4px;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .info-block p { margin: 0; }
  .info-card { margin-bottom: 12px; }
  .info-card h4 {
    margin: 0 0 6px;
    font-size: 13px;
    font-weight: 700;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--accent);
  }
  .info-card h4 .ico {
    font-size: 16px;
    margin-right: 7px;
    letter-spacing: normal;
  }
  .info-card p { margin: 0; }

  .emergency-card {
    border: 1px solid var(--border);
    border-left: 4px solid #c0392b;
    border-radius: 12px;
    padding: 16px 20px;
    margin-bottom: 12px;
  }
  .emergency-card h4 { margin: 0 0 8px; font-size: 16px; }
  .emergency-card .erow { font-size: 14px; margin-bottom: 4px; }
  .emergency-card .erow .ek {
    display: inline-block;
    min-width: 150px;
    font-weight: 600;
    color: var(--muted);
  }
  .emergency-number { font-weight: 700; color: #c0392b; }

  .footer-note {
    margin-top: 40px;
    padding-top: 20px;
    border-top: 1px solid var(--border);
    font-size: 12px;
    color: var(--muted);
    text-align: center;
  }

  /* ── Route map (static maps image) ─────────────── */
  .route-map {
    display: block;
    width: 100%;
    max-width: 600px;
    height: auto;
    border: 1px solid var(--border);
    border-radius: 12px;
    margin: 4px 0 18px;
  }
  /* Fallback shown (via inline onerror) when the static map fails to load. */
  .route-map-fallback {
    max-width: 600px;
    border: 1px solid var(--border);
    border-left: 4px solid var(--accent);
    border-radius: 12px;
    padding: 16px 20px;
    margin: 4px 0 18px;
    color: var(--text);
    font-size: 15px;
    font-weight: 600;
    line-height: 1.5;
  }
  .route-map-fallback .rmf-label {
    display: block;
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.1em;
    text-transform: uppercase;
    color: var(--muted);
    margin-bottom: 6px;
  }
  .route-map-fallback .rmf-arrow { color: var(--accent); margin: 0 6px; }

  /* ── Enriched place data (rating / hours) ──────── */
  .rest-enrich { font-size: 13px; color: var(--muted); margin: 6px 0 2px; }
  .rest-rating { color: var(--gold); font-weight: 700; }

  /* ── Section disclaimer ────────────────────────── */
  .disclaimer {
    font-size: 12px;
    font-style: italic;
    color: var(--muted);
    margin-top: 18px;
    padding-top: 12px;
    border-top: 1px solid var(--border);
  }

  /* ── Itinerary header (title row + Download PDF) ── */
  .itin-header {
    max-width: 820px;
    margin: 0 auto;
    padding: 20px 48px 0;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
  }
  .itin-header .logo { margin: 0; }
  .dl-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    background: #ffffff;
    color: var(--accent);
    font-family: inherit;
    font-weight: 700;
    font-size: 13px;
    padding: 8px 16px;
    border: 1.5px solid var(--accent);
    border-radius: 8px;
    cursor: pointer;
    white-space: nowrap;
  }
  .dl-btn:hover { background: var(--accent-soft); }

  /* ── Tab bar (desktop only; mobile falls back to full scroll) ── */
  .tab-bar { display: none; }
  @media (min-width: 768px) {
    .tab-bar {
      display: flex;
      gap: 4px;
      position: sticky;
      top: 0;
      z-index: 20;
      max-width: 820px;
      margin: 14px auto 0;
      padding: 8px 40px;
      background: rgba(255,255,255,0.96);
      -webkit-backdrop-filter: blur(8px);
      backdrop-filter: blur(8px);
      border-bottom: 1px solid var(--border);
      overflow-x: auto;
      -webkit-overflow-scrolling: touch;
    }
    .tab-btn {
      flex: 0 0 auto;
      background: transparent;
      border: none;
      border-radius: 999px;
      font-family: inherit;
      font-size: 13px;
      font-weight: 600;
      color: var(--muted);
      padding: 8px 14px;
      cursor: pointer;
      white-space: nowrap;
    }
    .tab-btn:hover { color: var(--accent); }
    .tab-btn.active { background: var(--accent); color: #ffffff; }
    /* Desktop: only the active section shows. Mobile keeps every section stacked. */
    .tab-section { display: none; }
    .tab-section.active { display: block; }
  }

  /* ── Combined intro page (cover + cities + overview) ── */
  .intro-page { padding-top: 36px; padding-bottom: 36px; }
  .intro-page .logo { margin-bottom: 18px; }
  .intro-country {
    font-size: 42px;
    font-weight: 700;
    line-height: 1.05;
    margin: 0 0 6px;
    letter-spacing: -0.02em;
  }
  .intro-page .cover-name { margin-bottom: 20px; }
  .intro-meta { padding: 16px 0; margin-bottom: 26px; }
  .intro-subhead {
    font-size: 14px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    border-left: 5px solid var(--accent);
    padding: 3px 0 3px 14px;
    margin: 0 0 14px;
  }
  .intro-subhead.spaced { margin-top: 26px; }
  .intro-city { padding: 13px 18px; margin-bottom: 12px; }
  .intro-city h3 { font-size: 17px; }
  .intro-city p { font-size: 14px; }
  .intro-city .nights-pill { padding: 8px 14px; min-width: 64px; }
  .intro-city .nights-pill .n { font-size: 22px; }
  .intro-overview .lead { font-size: 15px; line-height: 1.6; }

  /* ── Print rules ───────────────────────────────── */
  @media print {
    /* Hide the interactive chrome and reveal every section regardless of active tab */
    .itin-header, .tab-bar { display: none !important; }
    .tab-section { display: block !important; }
    @page { margin: 14mm; }
    body { font-size: 12pt; }
    .page { max-width: none; margin: 0; padding: 0; }
    .screen-only { display: none !important; }
    .lead, .slot-body, .rest-desc, .leg-tip, .info-block p,
    .city-row p, .find-card p, td, .erow { color: #000 !important; }
    .card, .day, .city-row, .leg, .find-card, .rest-card,
    .emergency-card { break-inside: avoid; }
    .intro-overview { break-inside: auto; }
    .aff { color: var(--accent) !important; }
    .finds-grid { grid-template-columns: 1fr 1fr; }
  }
`;

  // ── Tab bar + section switching (screen, ≥768px only). On mobile the tab bar
  // is hidden and every .tab-section stays stacked, so this is a no-op there. ──
  const buildTabBar = (tabs) =>
    `<nav class="tab-bar screen-only" role="tablist">${tabs.map(t =>
      `<button class="tab-btn" type="button" data-tab="${t.id}">${t.label}</button>`).join('')}</nav>`;

  const TAB_SCRIPT = `<script>
(function(){
  var btns = Array.prototype.slice.call(document.querySelectorAll('.tab-btn'));
  var sections = Array.prototype.slice.call(document.querySelectorAll('.tab-section'));
  if (!btns.length) return;
  var ids = sections.map(function(s){ return s.getAttribute('data-tab'); });
  function activate(id){
    if (ids.indexOf(id) === -1) id = 'overview';
    sections.forEach(function(s){ s.classList.toggle('active', s.getAttribute('data-tab') === id); });
    btns.forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-tab') === id); });
    try { sessionStorage.setItem('itinTab', id); } catch(e){}
  }
  btns.forEach(function(b){ b.addEventListener('click', function(){ activate(b.getAttribute('data-tab')); }); });
  var saved = 'overview';
  try { saved = sessionStorage.getItem('itinTab') || 'overview'; } catch(e){}
  activate(saved);
})();
</script>`;

  const itinHeader = `<div class="itin-header screen-only">
  <div class="logo">Built<span class="spring">WithSpring</span></div>
  <button class="dl-btn" type="button" onclick="window.print()" title="In the print dialog, choose 'Save as PDF'">⬇ Download PDF</button>
</div>`;

  // ── MODE B (recs) — city-organized stacked list, no day-by-day schedule ──
  if (itinerary.mode === 'recs') {
    const tierBadge = (t) => {
      const m = { 'Iconic': 'badge-iconic', 'Local Pick': 'badge-local', 'Hidden Gem': 'badge-hidden' };
      return (t && m[t]) ? `<span class="badge ${m[t]}">${esc(t)}</span> ` : '';
    };
    const recsCities = Array.isArray(itinerary.cities) ? itinerary.cities : [];
    const recsCityRows = recsCities.map(c =>
      `<div class="city-row intro-city"><div><h3>${esc(c.city)}</h3>${c.city_teaser ? `<p>${esc(c.city_teaser)}</p>` : ''}</div></div>`
    ).join('');
    const recsCitiesHtml = recsCities.map(c => {
      const acts = (c.activities || []).map(a =>
        `<div class="card"><h4 style="margin:0 0 4px;font-size:16px;">${tierBadge(a.spot_tier)}${escName(a.name)}</h4><p style="margin:0;color:var(--muted);">${esc(a.description || '')}</p></div>`
      ).join('');
      const rests = (c.restaurants || []).map(r => {
        // Only show venue-type tags that make sense without a schedule; drop meal-time labels.
        const showTag = ['Street Food', 'Cafe', 'Fine Dining', 'Bar', 'Brunch Spot'].includes(r.venue_type);
        return `<div class="rest-card">
        <div class="rest-head"><h4>${escName(r.name)}</h4>${showTag ? `<span class="rest-type">${esc(r.venue_type)}</span>` : ''}</div>
        <p class="rest-desc">${esc(r.known_for || r.why || '')}</p>
        <div class="rest-meta"><strong>Cuisine:</strong> ${esc(r.cuisine_category)} · <strong>Price:</strong> ${esc(r.price_range)} · <strong>Area:</strong> ${esc(r.neighborhood)}</div>
        <a class="aff" target="_blank" rel="noopener noreferrer" href="https://www.google.com/maps/search/${encodeURIComponent((r.name || '') + ' ' + c.city)}">Find on Google Maps →</a>
      </div>`;
      }).join('');
      const gems = (c.hidden_finds || []).map(f =>
        `<div class="find-card">
        <div class="emoji">${esc(f.emoji)}</div>
        <h4>${escName(f.title)}</h4>
        <p>${esc(f.description)}</p>
        <div class="find-city">${esc(f.city || c.city)}</div>
        <div>
          <a class="aff" target="_blank" rel="noopener noreferrer" href="${esc(affViator(f.city || c.city, f.title))}">Search Viator →</a>
          <a class="aff" target="_blank" rel="noopener noreferrer" href="${esc(affGYG(f.city || c.city, f.title))}">Search GetYourGuide →</a>
        </div>
      </div>`
      ).join('');
      return `<div class="city-band"><div class="cb-city">${esc(c.city)}</div></div>
      ${acts ? `<h2 class="intro-subhead">Activities</h2>${acts}` : ''}
      ${rests ? `<h2 class="intro-subhead spaced">Restaurants</h2>${rests}` : ''}
      ${gems ? `<h2 class="intro-subhead spaced">Hidden Finds</h2><div class="finds-grid">${gems}</div>` : ''}`;
    }).join('');

    // Only render a tab (button + section) when its underlying data is non-empty.
    const tabsB = [
      { id: 'overview',  label: 'Overview',           show: true },
      { id: 'bestof',    label: 'Best Of',            show: true },
      { id: 'transport', label: 'Getting There',      show: !!gettingAroundHtml },
      { id: 'stays',     label: 'Where to Stay',      show: accommodations.length > 0 },
      { id: 'book',      label: 'Book Before You Go', show: book_before_you_go.length > 0 },
      { id: 'practical', label: 'Practical Info',     show: true },
    ].filter(t => t.show);

    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your ${esc(country)} Recommendations — BuiltWithSpring</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
${itinHeader}
${buildTabBar(tabsB)}
<div class="tab-section" data-tab="overview">
<div class="page intro-page">
  <div class="cover-eyebrow">Your Personalized Recommendations</div>
  <h1 class="intro-country">${esc(country)}</h1>
  <div class="cover-name">Prepared for ${esc(firstName)}</div>
  <div class="cover-meta intro-meta">
    <div><div class="label">Arrival</div><div class="value">${esc(formatDateLong(arrivalDate))}</div></div>
    <div><div class="label">Departure</div><div class="value">${esc(formatDateLong(departureDate))}</div></div>
    <div><div class="label">Duration</div><div class="value">${totalNights} ${totalNights === 1 ? 'night' : 'nights'}</div></div>
  </div>
  <h2 class="intro-subhead">Your Cities</h2>
  ${recsCityRows}
  ${staticMapHtml}
  <h2 class="intro-subhead spaced">Trip Overview</h2>
  <div class="card card-accent intro-overview"><p class="lead">${esc(overview)}</p></div>
</div>
</div>
<div class="tab-section" data-tab="bestof">
<div class="page section">
  <h2 class="section-header">Best of Your Trip</h2>
  <p class="section-sub">A city-by-city stack of everything worth your time — no fixed schedule.</p>
  ${recsCitiesHtml}
  <p class="disclaimer">Hours and availability verified at time of generation — confirm before visiting.</p>
</div>
</div>
${gettingAroundHtml ? `<div class="tab-section" data-tab="transport">${gettingAroundHtml}</div>` : ''}
${accommodations.length ? `<div class="tab-section" data-tab="stays">
<div class="page section">
  <h2 class="section-header">Accommodation Picks</h2>
  ${accommodationsHtml}
</div>
</div>` : ''}
${book_before_you_go.length ? `<div class="tab-section" data-tab="book">
<div class="page section">
  <h2 class="section-header">Book Before You Go</h2>
  <table><thead><tr><th>What to book</th><th>When</th><th>Why it matters</th><th>Est. cost</th></tr></thead>
  <tbody>${bookRowsHtml}</tbody></table>
</div>
</div>` : ''}
<div class="tab-section" data-tab="practical">
<div class="page section">
  <h2 class="section-header">Practical &amp; Emergency Info</h2>
  ${practicalCards}
  <div class="footer-note screen-only">BuiltWithSpring · Crafted for your trip · Affiliate links help support this service at no extra cost to you.</div>
</div>
</div>
${TAB_SCRIPT}
</body></html>`;
  }

  // Only render a tab (button + section) when its underlying data is non-empty.
  const tabsA = [
    { id: 'overview',    label: 'Overview',           show: true },
    { id: 'plan',        label: 'Day by Day',         show: true },
    { id: 'hidden',      label: 'Hidden Finds',       show: hidden_finds.length > 0 },
    { id: 'restaurants', label: 'Restaurants',        show: restaurants.length > 0 },
    { id: 'stays',       label: 'Where to Stay',      show: accommodations.length > 0 },
    { id: 'transport',   label: 'Getting There',      show: transport.length > 0 },
    { id: 'book',        label: 'Book Before You Go', show: book_before_you_go.length > 0 },
    { id: 'practical',   label: 'Practical Info',     show: true },
  ].filter(t => t.show);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Your ${esc(country)} Itinerary — BuiltWithSpring</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:ital,opsz,wght@0,9..40,400;0,9..40,500;0,9..40,600;0,9..40,700;1,9..40,400&display=swap" rel="stylesheet">
<style>${CSS}</style>
</head>
<body>
${itinHeader}
${buildTabBar(tabsA)}
<div class="tab-section" data-tab="overview">
<div class="page intro-page">
  <div class="cover-eyebrow">Your Personalized Itinerary</div>
  <h1 class="intro-country">${esc(country)}</h1>
  <div class="cover-name">Prepared for ${esc(firstName)}</div>
  <div class="cover-meta intro-meta">
    <div><div class="label">Arrival</div><div class="value">${esc(formatDateLong(arrivalDate))}</div></div>
    <div><div class="label">Departure</div><div class="value">${esc(formatDateLong(departureDate))}</div></div>
    <div><div class="label">Duration</div><div class="value">${totalNights} ${totalNights === 1 ? 'night' : 'nights'}</div></div>
  </div>
  <h2 class="intro-subhead">Your Cities</h2>
  ${cityRowsHtml}
  ${staticMapHtml}
  <h2 class="intro-subhead spaced">Trip Overview</h2>
  <div class="card card-accent intro-overview"><p class="lead">${esc(overview)}</p></div>
</div>
</div>
<div class="tab-section" data-tab="plan">
<div class="page section">
  <h2 class="section-header">Day-by-Day Plan</h2>
  ${dayByDayHtml}
  <p class="disclaimer">Hours and availability verified at time of generation — confirm before visiting.</p>
</div>
</div>
${hidden_finds.length ? `<div class="tab-section" data-tab="hidden">
<div class="page section">
  <h2 class="section-header">Hidden Finds</h2>
  <p class="section-sub">Places you almost certainly wouldn't have found on your own.</p>
  <div class="finds-grid">${hiddenFindsHtml}</div>
</div>
</div>` : ''}
${restaurants.length ? `<div class="tab-section" data-tab="restaurants">
<div class="page section">
  <h2 class="section-header">Restaurants</h2>
  <p class="section-sub">Extra dining options beyond your day-by-day picks, grouped by city.</p>
  ${restaurantsHtml}
  <p class="disclaimer">Hours and availability verified at time of generation — confirm before visiting.</p>
</div>
</div>` : ''}
${accommodations.length ? `<div class="tab-section" data-tab="stays">
<div class="page section">
  <h2 class="section-header">Accommodation Picks</h2>
  ${accommodationsHtml}
</div>
</div>` : ''}
${transport.length ? `<div class="tab-section" data-tab="transport">
<div class="page section">
  <h2 class="section-header">Transport Between Cities</h2>
  ${transportHtml}
</div>
</div>` : ''}
${book_before_you_go.length ? `<div class="tab-section" data-tab="book">
<div class="page section">
  <h2 class="section-header">Book Before You Go</h2>
  <table><thead><tr><th>What to book</th><th>When</th><th>Why it matters</th><th>Est. cost</th></tr></thead>
  <tbody>${bookRowsHtml}</tbody></table>
</div>
</div>` : ''}
<div class="tab-section" data-tab="practical">
<div class="page section">
  <h2 class="section-header">Practical &amp; Emergency Info</h2>
  ${practicalCards}
  <div class="footer-note screen-only">BuiltWithSpring · Crafted for your trip · Affiliate links help support this service at no extra cost to you.</div>
</div>
</div>
${TAB_SCRIPT}
</body></html>`;
}
// ── END renderItinerary ──────────────────────────────────────────

// ── Itinerary generation ────────────────────────────────────────

// Appended to the prompt on retry to force clean JSON output.
const JSON_RETRY_INSTRUCTION = '\n\nIMPORTANT: Return only valid JSON. No markdown formatting, no code fences, no explanation before or after. Your response must start with { and end with }.';

// The full itinerary prompt. `d` carries the traveler's form data plus the
// approved city plan and approved teaser day retrieved from KV at fulfillment.
const ITINERARY_PROMPT = (d, perplexityResearch = null) => {
  const t = d.teaserDay || {};
  const approvedCities = JSON.stringify(d.approvedCities || []);
  const hasApprovedCities = Array.isArray(d.approvedCities) && d.approvedCities.length > 0;
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
  // Round-trip detection: when arrival and departure airports resolve to the same hub,
  // the city route MUST loop back and end at (or within ~90 min of) that airport. Without
  // this, the model optimises geographic flow, ends on the far side of the country, and
  // appends an unaccounted "head to [airport]" line on the last day (e.g. ending a LIR
  // round-trip in San José). Compared in code so it doesn't rely on the model matching codes.
  const normAirport = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const isRoundTrip = !!d.arrivalAirport && !!d.departureAirport
    && normAirport(d.arrivalAirport) === normAirport(d.departureAirport);
  const roundTripDirective = isRoundTrip ? `
ROUND-TRIP ROUTING (CRITICAL — arrival and departure airport are the SAME: ${d.departureAirport}):
This is a round-trip booking that departs from the SAME airport it arrived into. The city route MUST form a loop that ends with the traveler's FINAL NIGHT in a city within ~90 minutes ground transport of ${d.departureAirport}. This is a HARD CITY-SELECTION CONSTRAINT on where the last night is spent — NOT merely a disclosure or transport-costing rule.
- HARD RULE — FIRST NIGHT LOCATION: The FIRST city of the route must be the arrival airport city itself, with at least 1 night, so the traveler lands and settles before the loop begins. On multi-city round trips the airport city appears TWICE in the route — as the opening stop and as the closing stop. EXCEPTION: if the traveler's mustSee/extraNotes say they don't want to stay there on arrival, honor the notes — they outrank this rule.
- GATEWAY NIGHTS: if the airport city is itself a world-class or must-visit destination (e.g. Singapore, Tokyo, Paris, Rome, Bangkok, Istanbul), its COMBINED nights across the opening + closing stays must meet the recommended total for its size classification adjusted for pace — a Large airport city at fast pace needs 3 combined nights (e.g. 2 opening + 1 closing), never 1+1. Fund this by trimming mid-route cities. Only airport cities with little tourist value stay at the 1-night minimum per stay.
- HARD RULE — LAST NIGHT LOCATION: The LAST city of the route (where the final night is spent) must itself be the airport city or another city within ~90 min of ${d.departureAirport}. Plan the city order as a loop from the start so the trip naturally arrives back near the airport for the final night. Never treat a distant city that happens to have its own airport (e.g. San José when the booking departs from Liberia/LIR) as the departure city — the actual departure airport is ${d.departureAirport}, and the FINAL NIGHT must be near IT.
- DO NOT compress the return journey into departure-day morning as a substitute for relocating the final night. A costed, well-disclosed "leave at 5am and drive 3–4 hours to the airport" is NOT compliant — a long departure-day dash does not satisfy this rule. The traveler must already BE near the airport when they wake on departure day, not racing across the country to reach it.
- IF THE BEST FINAL DESTINATION IS FAR FROM THE AIRPORT: When the single strongest final-stop city (e.g. Manuel Antonio, ~3.5–4 hrs from Liberia/LIR) is more than 90 min from ${d.departureAirport}, spend the SECOND-TO-LAST night there, then move so the LAST night is at a city near the airport (the airport city itself, or another airport-adjacent town). It is acceptable and expected for the final full day to be shorter and transitional — a scenic drive back plus a relaxed last evening near the airport — in order to make this happen. Relocating the final night is REQUIRED, not optional.
- APPROVED CITY PLAN OVERRIDE: If the APPROVED CITY PLAN below sets a final city that is more than 90 min from the departure airport, this round-trip routing rule takes priority over the approved plan for the final night only. Add a transitional last stop at the airport city (or another city within ~90 min of the airport) as the new final city — keeping all other approved cities and nights intact. A brief, transitional evening at the airport city is expected and acceptable. The approved city plan governs city order and nights for all stops except the final night location, which this rule overrides when needed.
` : '';
  return `You are an expert travel planner. Generate a personalized travel itinerary following every step below in order.
${roundTripDirective}

──────────────────────────────────────────────
APPROVED CITY PLAN — USE EXACTLY AS IS:
The traveler has reviewed and approved this city and nights plan. It has already
been validated in code for arrival/departure-city night coverage and total-nights
accuracy — treat it as ground truth.
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
${perplexityResearch ? `
CURRENT DESTINATION RESEARCH
Real-time research from travel blogs, review sites, and local guides.
Use named restaurants, activities, and hidden gems from this research throughout the itinerary — prioritise these specific places over generic suggestions.
For any city where research is missing, use your best training knowledge — do not flag the gap.
Match each "### [City]" section below to that city's day-by-day and restaurants output.

${perplexityResearch}
──────────────────────────────────────────────
` : ''}
${!hasApprovedCities ? `STEP 1 — CITY DURATION FRAMEWORK
NOTE: If approved cities are provided above, skip night allocation — use approved nights exactly.
Only apply this step if no approved city plan exists.

Classify each city before allocating nights:
- Micro → 0.5–1 night · Small → 1–2 · Medium → 2–3 · Large → 3–5 · Mega → 4–6

Pace rules:
- Target the AVERAGE of each city's band (Large 3–5 → 4 nights). Pace nudges WITHIN the band, never outside it: Fast pace → lean 1 night below the average, dense daily schedule, maximize daily activities. Relaxed pace → lean 1 night above, lighter schedule, room to breathe.
- Pace is primarily about DAY DENSITY, not city count. Never add a city that only fits at its bare band minimum — every extra city costs roughly half a day in transit and check-in, so a packed trip means fuller days, not more stops.
- Never compress below the band minimum. If cities × minimum > total days → remove cities.
- Departure city classified Large or Mega → minimum 2 nights.
- If departure city differs from arrival city and has significant tourist value → include it regardless of pace or night count. Compress other cities before removing the departure city.

Travel day deductions:
- Travel 2–4 hours → half day lost. Over 4 hours → full day lost.
- City losing full day to travel → add 1 night.
- Travel days → activity placement follows DEPARTURE DAY STRUCTURE (STEP 10): no departing-city activities; a mid-trip transit day has one afternoon activity and one evening activity at the arrival city. Flag travel days clearly.

` : ''}STEP 2 — CITY SELECTION
NOTE: If approved cities are provided above, skip city selection entirely — proceed to Step 3.
Only apply this step if no approved city plan exists.

Calculate total trip days from arrival to departure.
- All selected cities must be within the country submitted. Never recommend cities in other countries unless explicitly listed in must-see or extra notes.
- SAFETY EXCLUSIONS — LEVEL 4 (DO NOT TRAVEL): Never recommend any destination classified as US State Department Travel Advisory Level 4. These are hard blocks — never suggest them as overnight destinations regardless of what the traveler requests. Current Level 4 countries (verified July 2026): Afghanistan, Belarus, Burkina Faso, Burma (Myanmar), Central African Republic, Chad, Democratic Republic of the Congo, Haiti, Iran, Iraq, Lebanon, Libya, Mali, Niger, North Korea, Russia, Somalia, South Sudan, Sudan, Syria, Uganda, Ukraine, Yemen. If the traveler submits one of these as their destination country, respond in the overview: "We're unable to generate an itinerary for [country] due to a current US State Department Level 4 (Do Not Travel) advisory. Please check travel.state.gov for the latest guidance."
- SAFETY WARNINGS — LEVEL 3 (RECONSIDER TRAVEL): For destinations classified as Level 3, do not block city selection — many are popular tourist destinations with specific regional risks. Instead, add one sentence to the overview: "Note: [Country] is currently under a US State Department Level 3 (Reconsider Travel) advisory — review travel.state.gov before booking." Current Level 3 countries (verified July 2026): Azerbaijan, Bahrain, Bangladesh, Burundi, Colombia, Ethiopia, Guatemala, Guinea-Bissau, Guyana, Honduras, Israel/West Bank/Gaza, Kuwait, Mauritania, Nicaragua, Nigeria, Oman, Pakistan, Papua New Guinea, Qatar, Rwanda, São Tomé and Príncipe, Saudi Arabia, Tanzania, Trinidad and Tobago, United Arab Emirates, Venezuela.
- MEXICO STATE-LEVEL EXCLUSIONS: Mexico is Level 2 overall but specific states carry Level 3/4. Never recommend these as overnight destinations: Guerrero state (including Acapulco), Sinaloa state (including Culiacán and Mazatlán areas outside designated tourist hotel zones), Tamaulipas state, Zacatecas state, Colima state, Michoacán state interior (excluding Morelia, which may be included with a caution note). If the traveler explicitly requests one of these in mustSee or extraNotes, add a note in the overview: "We've routed around [location] due to current travel advisories; please check the latest US State Department guidance before traveling." Suggest a safe alternative in the same region where possible.
- ADVISORY ACCURACY: Advisory levels change. The lists above reflect July 2026 data. If there is any reason to believe a destination's status may have changed, note in the overview that the traveler should verify current advisories at travel.state.gov before booking.
- Always consider arrival and departure airport cities as candidates. Include them for flying trips unless the traveler chose different cities or the airport has no tourist value.
- ARRIVAL CITY RULE: Always include the arrival airport city for at least 1 night unless the traveler's mustSee/extraNotes indicate they don't want to stay there (any clear phrasing counts — "skip Hong Kong", "no overnight in HK", "go straight to Guilin" — exact wording irrelevant; honor the intent fully and route them onward on arrival day). Otherwise they need time to land, clear customs, get to accommodation, and decompress. If the arrival city is a world-class or must-visit destination (e.g. Rome, Paris, Tokyo, New York, Bangkok, Istanbul, Barcelona, London, Sydney) → allocate nights based on typical visitor recommendations adjusted for their pace: target the band average, Fast pace → lean 1 night below (never below the band minimum), Relaxed pace → lean 1 night above. Never drop the arrival city unless the traveler explicitly names a different starting city or their notes say not to stay there.
- DEPARTURE CITY RULE: Always include the departure airport city for at least 1 night unless the traveler's notes indicate they don't want to stay there (same any-clear-phrasing standard as the arrival rule). Never route a traveler out of any city they have not spent at least one night in — they need accommodation, time to reach the airport, and a buffer for their flight. If the traveler opted out, honor it and flag the departure-day transfer implications in the overview. If the departure city is a world-class or must-visit destination → allocate nights based on typical visitor recommendations adjusted for their pace, same as arrival city logic above. Adjust other city night allocations to fit both arrival and departure city requirements.
- Cities listed, AI false → respect list. Adjust count if needed. Explain changes in overview.
- AI true, anchors provided → anchors are fixed. Fill remaining days with best-fit cities.
- AI true, no cities → select from scratch weighted by interests, travel party, travel style, weather, routing.
- NATURAL SITES AS DESTINATIONS (CRITICAL): Never create a combined overnight destination from two or more natural sites (waterfalls, hot springs, thermal pools, cloud forests, beaches, national parks, lagoons) that are not in the same valley or within 1.5 hours of each other. If a natural site has no local accommodation hub, treat it as a DAY TRIP from the nearest city — not an overnight destination. A combined destination like "Hierve el Agua & Valle Nacional" is only valid if both sites are within 1.5 hours of the same accommodation base. If they are not, include the closer one as a day trip from the origin city and omit or separately accommodate the other.
- When a traveler or the AI selects a natural area as an overnight destination, verify it has real accommodation options (eco-lodges, guesthouses, or nearby village hotels) before placing it in the itinerary as an overnight stop. If accommodation is sparse or unverifiable, reclassify it as a day trip.
- Too many cities → keep best subset, explain removals. Too few → add complementary cities.
- Every city must have why_recommended max 25 words: "[City] is [known for] — chosen for your [interest or preference]." Never generic or logistical.
- Every city must also have city_teaser: ONE evocative sentence (~15 words) on what makes this city special on this trip — sensory and specific, never logistical. Example: "Ancient canal town where silk weaving and garden culture meet."
CITY TEASER VOICE: Always write from the perspective of arriving and discovering — never from a departure perspective. Forbidden phrases: "one last night", "before dawn takes you home", "wrapping up", "final night in", "before heading home", "ends the journey". These belong in the overview only, never in a city_teaser. On round-trips where the same city appears as both the opening and closing stop, write the teaser as if the traveler is arriving for the first time.

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

Relaxed pace reduces frequency one tier: High → every 2–3 days, Medium → once per city stay.

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

ADDITIONAL ARRAY: The restaurants array is a reference tab of ADDITIONAL dining options, separate from the day-by-day restaurant_suggestion picks; the per-city minimum counts below describe this additional array. (No venue may repeat between the two sets, or across days — enforced in STEP 14.5.)

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
Last transport entry → final city to departure airport. This must be a real, accurately costed leg with the correct mode and realistic duration — never a throwaway "head to the airport" line. If the final city is NOT the departure-airport city, the transfer back to the airport (whether a domestic flight, train, or private car) must be fully accounted for with its true mode, duration, and cost — and if it exceeds ~90 minutes, flag it in the overview so the traveler is not surprised by an unbudgeted departure-day journey.

Match to trip structure:
- road_trip → rental car. Include fuel and toll estimates.
- train → specific rail service per leg. Flag pre-departure passes as Book now.
- flying → flights between cities plus rideshare/shuttle airport transfers.
- Not provided → apply smart transport logic from Step 2B per leg.

Every booking_tip is one sentence including booking window. Never label a road shuttle as Train. Flag cities with multiple airports.

FLIGHT FREQUENCY ACCURACY (CRITICAL): Never invent a flight time-of-day or airline. Only name an airline on a leg if you are confident it actually operates that route. Secondary and regional routes (e.g. Chiang Mai→Luang Prabang) often run only a FEW days per week with a single departure time — if the research above (or your knowledge) does not confirm a daily schedule, do NOT write "morning flight" or plan around a specific departure time. Instead: describe the leg as "flight — limited schedule, verify days and times before booking", say the same in the booking_tip, and keep that arrival day's plan light and flexible (no timed activities that depend on a morning arrival). A traveler who books hotels around a flight that doesn't exist that day is the worst possible failure.

GUILIN → YANGSHUO ROUTING: When the itinerary includes a Guilin-to-Yangshuo leg, the Li River cruise (Guilin → Yangshuo, ~4.5 hours, morning departure) IS the recommended transfer — list it as the transport mode for this leg. On the travel day, schedule the cruise as the morning activity slot. Do NOT schedule the Li River cruise as a standalone day activity on any day the traveler is already staying in Yangshuo — it cannot be done in reverse and cannot be repeated.

STEP 10 — GEOGRAPHIC CLUSTERING
(Covers how each day is assembled: neighbourhood clustering, the per-day dinner and breakfast picks, and departure/transit-day structure.)
Cluster morning, afternoon, evening in same or adjacent neighborhoods. Plan full days around must-sees. Never zigzag. On departure/transit days, follow DEPARTURE DAY STRUCTURE below (no activities at the departing city; a transit-day afternoon activity and evening activity happen at the ARRIVAL city). Assign neighborhood_focus and restaurant_suggestion per day using this logic:
- Regular days → restaurant_suggestion must always be DINNER. Name a specific, real, well-regarded dinner restaurant suited to that city's evening. Lunch is never the restaurant_suggestion unless the traveler has an explicit half-day or no evening activity in that city. Label clearly as Dinner. Breakfast is handled separately — see below.
- Day trip days → restaurant_suggestion must always be a DINNER at the BASE city accommodation area (for the evening when the group returns). Never use a lunch spot at the day-trip destination as the restaurant_suggestion. If there is a standout lunch spot at the day-trip destination, work it into the afternoon activity description only (e.g. "Trattoria X — honest cucina povera in the trulli zone, ideal for lunch between sights"). Never leave a day without a dinner suggestion — the FINAL departure day (returning home) is the sole exception, with its dinner field set to N/A.
- Final departure day (the trip's LAST day, returning home) → set the dinner field to exactly N/A (see DEPARTURE DAY STRUCTURE below). Do not name a dinner restaurant on the final departure day.
- Arrival day (the trip's FIRST day, arriving from home — not a mid-trip transit day) → pick a restaurant near the arrival accommodation for the first meal in the new city.
- Full travel day / mid-trip transit day → dinner IS a real, specific restaurant near the ARRIVAL city accommodation (their first dinner in the new city); the activities are one afternoon slot and one evening slot at the arrival city (see DEPARTURE DAY STRUCTURE below).
- Restaurant suggestion should always be geographically logical for that day's context.
- Restaurant suggestion must be a specific real venue (uniqueness vs the restaurants array and across days is enforced in STEP 14.5).
- BREAKFAST IS MANDATORY EVERY DAY: in addition to restaurant_suggestion, every day must include a separate breakfast_suggestion — a specific, real, well-regarded breakfast spot or cafe near that day's accommodation or first activity. Format it exactly like restaurant_suggestion (Breakfast: Name | neighborhood | one line why it fits today). It must not duplicate any venue used in restaurant_suggestion or in the restaurants array. Transit days are always exempt — never include breakfast_suggestion on transit days (see TRANSIT DAY BREAKFAST below).
- BREAKFAST PLACEMENT: the breakfast spot must be geographically close to where that day's morning activity takes place — or near the hotel if it is an early-departure day. Never recommend a breakfast spot in a different neighbourhood that forces the traveler to backtrack before the morning activity. For example: if the morning activity is in West Vancouver, put breakfast near West Vancouver or the West End — never in Mount Pleasant or Gastown.

MEAL VENUE UNIQUENESS (CRITICAL):
No restaurant, cafe, or food venue may appear more than once in the entire itinerary. This applies:
- Across all meal types (BREAKFAST, DINNER)
- Across all days, including consecutive nights in the same city
- Across different cities (do not repeat a chain or franchise across cities)

SAME-CITY CONSECUTIVE DAYS (most common failure): If a traveler spends 2+ nights in the same city, each day needs a DIFFERENT breakfast and dinner venue. Day 1 in Liberia and Day 2 in Liberia must use different cafés for breakfast — even if Day 2 is a transit/departure morning. A city always has more than one good breakfast option.

Before finalizing each meal recommendation, verify this venue has not already been recommended on any earlier day. If the same venue would appear twice, replace one instance with a different venue.

LODGE DINING EXCEPTION (narrow): For a multi-night stay at a remote lodge or eco-resort where there is genuinely no alternative breakfast option within a 30-minute drive (e.g., a jungle lodge in Rincón de la Vieja, a national park ecolodge), using the lodge's own dining room for breakfast on consecutive mornings of that stay is acceptable. This exception applies to BREAKFAST ONLY, not dinner, and only when no walk-in alternative is realistically accessible.

TRANSIT DAY BREAKFAST:
On transit days, omit the breakfast_suggestion field entirely. Do not name any breakfast venue. The morning slot is N/A (checkout and travel), so listing a breakfast venue would be inaccurate — the traveler has no time for a sit-down meal. The first meal of a transit day is dinner in the arrival city.

DEPARTURE DAY STRUCTURE (CRITICAL):
All departures are scheduled in the morning. Apply this structure on every departure day:

TRANSIT DAYS (moving from one city to the next mid-trip):
- MORNING slot: N/A — traveler is checking out and departing. Write a brief note, e.g., "N/A — checking out of [departure city] and catching the morning [train/flight] to [arrival city]."
- AFTERNOON slot: ONE light activity at the ARRIVAL city — choose something easy and low-effort for arrival day (a neighborhood walk, a scenic viewpoint, a stroll through a local market, a lakeside path). Assign a tier badge.
- EVENING slot: ONE activity at the ARRIVAL city. Assign a tier badge.

BREAKFAST: omit — the traveler is in transit. Do NOT include a breakfast_suggestion on transit days. The morning is consumed by checkout and travel.
DINNER: recommend an arrival-city dinner venue as usual — this is the traveler's first meal in the new city.

PACING NOTE: This transit day structure applies to ALL pacing modes including fast-paced itineraries. The MORNING=N/A note must appear as an explicit slot in the day-by-day output on every transit day, regardless of pace.

FINAL DEPARTURE DAY (last day of the trip, returning home):
- MORNING slot: N/A — traveler is checking out and heading to the airport
- AFTERNOON slot: N/A
- EVENING slot: N/A
- DINNER field: N/A

ARRIVAL DAY (first day of the trip, arriving from home):
- MORNING slot: N/A — traveler is arriving; customs, baggage, and transfer to accommodation consume the morning. Write: "N/A — arriving at [Airport name] and transferring to accommodation in [neighborhood/area]."
- AFTERNOON slot: ONE easy, low-energy activity close to the arrival accommodation — a neighborhood walk, a first café, a local market browse, a scenic square. Keep it light. Assign a tier badge.
- EVENING slot: ONE activity at the arrival city. Assign a tier badge.
- DINNER field: recommend a real restaurant near the arrival accommodation — first meal in the new city.

This structure applies regardless of pace setting. Do NOT assign a morning activity on the first day of the trip.

Never assign any activity at the departing city on a departure day.
Never write "Departure." or "Departure" as a standalone word in any slot — use N/A.
EXCEPTION: when the inter-city transfer is itself the scheduled sightseeing experience (e.g. the Guilin → Yangshuo Li River cruise), that transfer occupies the morning slot as its named activity instead of N/A.
This structure overrides the STEP 14 PACE STRUCTURE slot pattern on departure days.

STEP 11 — ACTIVITY TIME BUDGET VALIDATION
Before finalizing each day, validate the day's activities against a realistic time budget.

Time budgets per pace:
- Fast pace → ~10 hours of activity time available
- Relaxed pace → ~6 hours of activity time available

Activity time classifications:
- Quick activity (market visit, viewpoint, short walk) → 1–2 hours
- Standard activity (museum, temple, neighborhood walk) → 2–3 hours
- Half-day activity (cooking class, boat tour, major landmark) → 4–5 hours
- Full-day activity (theme park, long day trip, trek) → 6–8 hours including transport

Validation rules:
- Full-day activity → that is the day's primary activity. Add ONE light nearby evening activity only.
- Day trip (90+ min each way) → counts as half-day minimum just for transport. (STEP 4 sets the max allowable day-trip distance per travel party; this rule governs how many OTHER activities can share the day.) Relaxed pace + day trip → day trip IS the day, no other activities. Fast pace + day trip → pair with one nearby activity max only if the destination is under 90 min each way; at 90+ min each way the day trip stands alone.
- Half-day activity → can pair with one standard activity on the same day max.
- Never schedule 3 time-intensive activities (each 3+ hours) on the same day regardless of pace.
- Travel/transit days → no activities at the departing city; follow DEPARTURE DAY STRUCTURE (a transit day has one afternoon activity and one evening activity at the arrival city).

STEP 12 — BOOK BEFORE YOU GO
A curated advance-booking guide — not a tracker. Include only items that genuinely benefit from booking ahead: flights, accommodation, high-demand restaurants, activities that sell out, rail passes, entry tickets with timed slots. Sort by urgency: Book now → 4–6 weeks ahead → On arrival.
Every entry needs: item_name, city, date, est_cost, booking_priority, booking_tip (one sentence — where and how to book using the PLATFORM NAME ONLY in plain text, and why booking ahead matters for this item), booking_link (always an empty string — see NO URLS below).
Do NOT include generic items that need no advance booking (e.g. free parks, markets, casual walk-in cafes). Quality over quantity — only items where booking ahead genuinely helps the traveler.
SCHEDULED-ONLY: Any activity, attraction, experience, or restaurant in this list MUST already appear in the days array (as a scheduled morning/afternoon/evening activity or a day's restaurant_suggestion). Do NOT introduce supplementary attractions or experiences that are not in the day-by-day plan. Logistics items — flights, accommodation, inter-city transport/rail passes, and visa/entry requirements — are exempt and may be included as usual.

BOOK BEFORE YOU GO — ALIGNMENT:
Every restaurant listed in Book Before You Go for a specific date must exactly match the dinner restaurant listed in the day-by-day plan for that date. Every activity listed in Book Before You Go must actually appear in the day-by-day plan. Do not recommend booking a restaurant or activity that is not already in the plan. Cross-check every single Book Before You Go entry against the day-by-day before finalizing.

BOOK BEFORE YOU GO — EXCLUSIONS:
Do not include travel insurance in the Book Before You Go section.
Travel insurance is a generic logistics item that is not specific to this itinerary. If there is nothing additional worth booking, omit the slot rather than filling it with a generic reminder.
Only include items that are genuinely specific to this trip: venue reservations, timed entry tickets, permits, transport bookings, experience slots.

BOOK BEFORE YOU GO — NO URLS:
Never include hyperlinks or URLs in the Book Before You Go section.
Instead, specify where to book using plain text — the platform name only.
Examples of correct format:
  - "Reserve via Resy"
  - "Book via OpenTable"
  - "Tickets via the venue's website"
  - "Permits via Texas State Parks reservation system"
  - "Reserve directly by phone"
Never write a URL. The customer will search or use the platform name to find the booking page.
The booking_link field must always be an empty string.

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
SEASONAL EVENT ACCURACY (CRITICAL): When including a seasonal event or festival as a city guide activity (e.g. Day of the Dead, cherry blossom, carnival, Songkran), only describe the traveler as experiencing it if the trip dates overlap with the actual event window, or the trip ends within 7 days of the event start. If the trip ends more than 7 days before the event begins: you MAY mention the event as future context ("Oaxaca's Day of the Dead (Nov 1–2) is one of Mexico's most extraordinary festivals — consider timing a future visit") but you MUST NOT imply the traveler will see preparations, atmosphere, or early decorations during their actual visit dates. Do not include the event as an activity recommendation in the city guide. Apply the same rule to the Practical Info section — do not claim the traveler's dates overlap with seasonal atmosphere unless the dates are genuinely close.
RECURRING EVENT ACCURACY: The same rule applies to recurring events that happen on a fixed calendar date — monthly flea markets, weekly craft markets, shrine fair days, regular night markets. If the specific occurrence date falls outside the trip dates, do not recommend the event as something the traveler can attend. Example: Toji Temple Flea Market (Kyoto, every 21st) — if the trip is Oct 1–9, the Oct 21 market is not attendable; either omit it or reframe it as future context: "The Toji Flea Market on the 21st is a Kyoto institution — if your dates align, it's unmissable." Apply this check to the city guide AND hidden finds.

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
- FAME CHECK: never badge an internationally famous venue as Hidden Gem — anything on World's 50 Best lists, Michelin flagships, or major skyline attractions (e.g. Atlas Bar or LeVeL33 in Singapore) is Iconic, no matter how atmospheric it feels. If a first-page Google search for the city's best bars/restaurants would surface it, it is not a Hidden Gem.
- For day-by-day entries, output the tier in the SEPARATE \`morning_tier\`, \`afternoon_tier\`, or \`evening_tier\` field — NOT as a prefix in the activity description string. The tier field must be exactly one of: \`Iconic\`, \`Local Pick\`, or \`Hidden Gem\` (no brackets, no extra text). Examples:
  morning: "Yanaka Cemetery Walk — quiet neighborhood necropolis turned local strolling ground, lined with cats and craft shops."
  morning_tier: "Local Pick"
  afternoon: "Nishiki Market — five-block covered arcade of pickles, tofu, and Kyoto street snacks."
  afternoon_tier: "Iconic"
- For city_guide entries, add spot_tier as a separate field (see JSON schema below).
- CRITICAL FINAL CHECK: before outputting, verify every non-N/A, non-"Free afternoon" morning/afternoon/evening slot has a corresponding \`_tier\` field set to exactly \`Iconic\`, \`Local Pick\`, or \`Hidden Gem\`. A missing or blank \`_tier\` field is an error — populate it before outputting. No days skipped.
- This applies to ALL slot types without exception — named venues, markets, ruins, archaeological sites, bars, mezcalerias, cantinas, distilleries, craft workshops, pottery studios, outdoor activities, hikes, cycling routes, river experiences, nature walks, viewpoints, and cultural performances.
  ✓ Correct: morning: "Mercado de Abastos — vast indigenous market", morning_tier: "Iconic"
  ✓ Correct: afternoon: "Mezcaleria In Situ — curated library of 40+ small-batch mezcales", afternoon_tier: "Local Pick"
  ✗ Wrong: morning: "[Iconic] Mercado de Abastos — vast indigenous market" (tier embedded in string — put it in morning_tier instead)
  ✗ Wrong: morning: "Mercado de Abastos — vast indigenous market", morning_tier: "" (blank tier — must be populated)
- Pay special attention to the FIRST FULL DAY in each new city — this is the most common location for missed tier fields. After every transit day, confirm the following day's slots all carry \`_tier\` fields.

STEP 14 — ACTIVITY FRAMING
(Covers how to fill and word each day's activity slots: pace structure, slot–venue fit, and field formatting.)
CULTURAL RESTRICTION WARNINGS: For any venue or experience with a strictly enforced rule that would surprise or create risk for a foreign visitor, include the key restriction in the activity description — woven into the description itself, not as a footnote. Required warnings for known high-risk venues: San Juan Chamula church (Chiapas) — "Photography is strictly forbidden inside — phones and cameras have been confiscated and confrontations occur." Any active mosque (non-tourist context) — include dress code note. Example for San Juan Chamula: ✓ "[Iconic] San Juan Chamula — a Tzotzil Maya village church where Catholic saints and pre-Hispanic shamanic rituals fuse; unlike anywhere on earth. Photography strictly forbidden inside — leave your camera at the entrance." ✗ "[Iconic] San Juan Chamula — a Tzotzil Maya village church where Catholic saints and pre-Hispanic shamanic rituals fuse inside a candle-and-pine-needle-covered church."

Pace density rules — apply to every day-by-day entry (governed by PACE STRUCTURE below):
- Fast pace → populate morning, afternoon AND evening with distinct, fully-committed activities. All 3 slots required. EXCEPTION: on a day dominated by a full-day activity or a 90+ min day trip, follow STEP 11 instead (the big activity is the day; add one light nearby evening activity only).
- Relaxed pace → follow PACE STRUCTURE below: morning activity, a free afternoon, and one relaxed evening activity. EXCEPTION: on a day dominated by a full-day activity or a 90+ min day trip, follow STEP 11 instead (the big activity IS the day — no separate morning/evening activities).

PACE STRUCTURE:
Relaxed pace and fast pace must produce structurally different itineraries — not just different language.

RELAXED PACE:
- Morning slot: one unhurried activity (coffee, a park, a market, a slow neighbourhood walk)
- Afternoon slot: write "Free afternoon — rest, explore at your own pace, or revisit somewhere you loved." Do NOT assign a specific venue or activity.
- Evening slot: one relaxed evening activity (drinks at a local bar, live music, a sunset walk)
- The day feels spacious. Two committed activities per day maximum.

FAST PACE:
- Morning slot: one activity
- Afternoon slot: one activity (a specific venue or neighbourhood, fully committed)
- Evening slot: one activity
- All three slots are filled with specific recommendations.

Never describe a 3-slot day as "relaxed" or "unhurried." Relaxed pace means the afternoon slot is always free time.
This slot pattern (both paces) yields to STEP 11 when a full-day activity or a 90+ min day trip dominates the day — then the big activity is the day, and to DEPARTURE DAY STRUCTURE on departure/transit days.

All day-by-day activity fields: "[Activity name] — [one line what it is and why it suits this traveler]." No duration, category label, neighborhood tag, or pipes. Max 20 words.
NEVER output "Free time" (or "Free time — explore [neighborhood] at your own pace", or any generic placeholder) as a morning or evening slot entry, and never as an afternoon slot on a FAST-pace day. Every such slot must name a specific place in that city — a named neighbourhood to wander, a named market, a named viewpoint, a named park — each with a one-line description, formatted exactly like every other activity slot. The ONLY exception is the RELAXED-pace afternoon slot, which uses the exact free-afternoon line specified in PACE STRUCTURE above.

SLOT–VENUE FIT — assign every venue only to a slot where it is actually open and at its best:
- General: never recommend a venue at a time it is not known for.
- Morning slots: only venues open before noon. Never bars, nightlife venues, honky-tonks, cocktail bars, or evening-only entertainment (dance halls, nightclubs, speakeasies, comedy clubs, late-night music venues) — if a venue's primary hours are after noon, it belongs in the afternoon or evening only.
- Breakfast field: only venues that open before noon and serve morning food — never dinner-only restaurants, cocktail bars, or evening-only venues. If unsure, pick a well-known café, bakery, or all-day diner in the correct neighborhood.
- Evening slot: a non-dining experience only — music, live entertainment, a bar for drinks, a scenic walk, a neighbourhood to explore, a cultural venue, a rooftop. Never a restaurant, café, or dining experience: the DINNER field already captures where the customer eats, and the evening slot is what they do before or after dinner. If the best evening option is a meal, put it in the DINNER field and choose a non-dining evening experience.
- Animal experiences: schedule only when the animals are active and visible. Giant panda bases (Chengdu Research Base and similar) → morning only (pandas are active 8am–noon, asleep in the afternoon). Wildlife reserves and safari parks → the reserve's recommended viewing windows (typically dawn or dusk). Never place a morning-active animal experience in the afternoon or evening.

NIGHTTIME-ONLY EXPERIENCES:
Some experiences only work after dark and must only be placed in the EVENING slot.
- Bioluminescence tours (lagoons, bays, beaches where water glows at night): EVENING only. These are physically invisible in daylight — never assign to MORNING or AFTERNOON.
- Stargazing tours, astronomy nights, observatory visits: EVENING only.
- Firefly watching: EVENING only.
- Night markets that operate exclusively after sunset: EVENING only.
If the activity description or name contains the words "night", "nocturnal", "after dark", "glows at night", or "bioluminescence", it must be in the EVENING slot.

SUNRISE ATTRACTIONS — MORNING ONLY:
Some attractions exist specifically to watch the sunrise and lose their entire value at any other time of day. These must only be placed in the MORNING slot.
- Any attraction whose name contains "sunrise", "dawn", or "ilchulbong", or whose primary identity is watching the sunrise from a crater rim, hilltop, or peak: MORNING only.
- Example failure: Seongsan Ilchulbong (Jeju's Sunrise Peak) placed in the AFTERNOON — completely wrong. The site's entire purpose is the sunrise from the crater; an afternoon visit has no distinguishing value.
Never place a sunrise attraction in the AFTERNOON or EVENING slot.

SUNSET ATTRACTIONS — EVENING ONLY:
Attractions specifically famous for watching the sunset must be placed in the EVENING slot.
- Named sunset viewpoints, clifftop walks, or ocean-view spots whose primary draw is the sunset: EVENING only.
Never place a sunset attraction in the MORNING or AFTERNOON slot.

DAILY GEOGRAPHIC FEASIBILITY:
Before finalising any day, verify all three slots are physically achievable in a single day given real travel times and activity durations.
- If the morning activity takes 3+ hours (a full mountain hike, a half-day tour), the afternoon activity must be within 60 minutes of where the morning activity ends — not on the opposite side of the destination.
- If two major activities are 90+ minutes apart from each other, they cannot both be "full" activities on the same day.
- Example failure: Hallasan Eorimok hike (3–4 hrs, central-west Jeju) MORNING + Seongsan Ilchulbong (90-min drive east) AFTERNOON + Udo Island sunset ferry EVENING — the last Seongsan ferry departs ~17:30; after a full morning hike and a cross-island drive, this is physically impossible.
- When a full hike or major site anchors the morning, the afternoon and evening activities must be geographically near that same area, or the day must be redesigned to fit what is actually achievable.

STEP 14.5 — NO REPETITION RULE (applies across the ENTIRE trip)
Every activity, attraction, and restaurant must be unique across all days. Never schedule the same place, sight, or restaurant more than once, even across different days in the same city — not just consecutive days. This applies to morning, afternoon, and evening slots AND to restaurant_suggestion and breakfast_suggestion equally. It also applies BETWEEN sets: the day-by-day restaurant_suggestion / breakfast_suggestion picks and the separate restaurants array (Food & Drink tab) are disjoint — no venue appears in both — so together they widen the traveler's options rather than repeat.
- For multi-day stays in one city, treat the city's attractions as a finite set you are distributing across days — once a place is used on one day, it is unavailable for every other day.
- Before finalizing each day, check it against all previous days and confirm no activity, attraction, or restaurant has already appeared.
- If a city has more days than distinct marquee attractions, fill remaining slots with neighborhoods, local experiences, day trips, markets, parks, or lesser-known spots rather than repeating a famous site.
- The single exception is unavoidable logistics (e.g. the same airport for arrival and departure) — transport hubs may recur, but no activity, sight, or restaurant ever may.

STEP 15 — OUTPUT FORMATTING
- Activities: clean sentence, max 20 words, no pipes
- Do not include foreign language characters or non-Latin script in any venue names, titles, or parenthetical translations. English names only.
- NAMED TRAIL ACCURACY: Never claim a specific named trail reaches a summit, crater, or viewpoint that it does not. Describe only what that trail actually delivers. Example failure: Hallasan Eorimok Trail described as "crater hike" and "climb South Korea's highest peak" — Eorimok ends at Witseoreum shelter, not the crater. Only Gwaneumsa and Seongpanak trails reach Baeknodam crater. When naming a trail, describe its actual scenery and endpoint rather than the mountain's overall summit.
- NO MARKDOWN IN ANY TEXT FIELD: Never use markdown formatting inside any string value — no **bold**, no _italic_, no ##headers, no backticks. All text fields must be clean plain text. Example failure: a dinner description rendered entirely in bold because the model wrapped it in **text** — this is forbidden in all fields including morning, afternoon, evening, restaurant_suggestion, breakfast_suggestion, city_teaser, and every other string field.
- Transport booking_tip: one sentence only
- Practical info: max 4 sentences per field, most critical first. Plain prose, no bullet symbols.
- Costs: always a range with currency symbol
- Temperatures: always in Fahrenheit (°F). Never use Celsius.

DAILY BUDGET CONSISTENCY (CRITICAL): estimated_daily_cost is not an independent guess — it must actually cover that day's specific named picks. Before writing it, add up the realistic real-world cost of the day's actual recommendations: the accommodation for that night, the named dinner restaurant in restaurant_suggestion, breakfast, and any paid morning/afternoon/evening activities. The range you output must be able to pay for all of them for the stated travel party.
- The LOW end of estimated_daily_cost must never be lower than the realistic per-person (or per-party, matching how you present the range) cost of that day's own named dinner restaurant alone. If the day's dinner is a high-end or globally acclaimed restaurant (e.g. Narisawa in Tokyo realistically ¥30,000–¥50,000+ per person), the daily budget must reflect that — never show a daily total lower than the dinner it recommends.
- If a single named venue makes the day unusually expensive, let the daily total rise to match it rather than quoting a comfortable-looking range that the day's own picks would blow past.
- Sanity-check every day before finalizing: if the named dinner or a marquee activity costs more than the daily budget's low end, raise the budget until it genuinely covers the picks.

CURRENCY FORMAT:
Always use the local currency symbol — never the ISO code or three-letter abbreviation.
- China: ¥ (not CNY, not RMB). Format: ¥800–¥1,200
- USA: $ (not USD). Format: $50–$80
- UK: £ (not GBP). Format: £30–£50
- Europe: € (not EUR). Format: €40–€60
Apply this consistently throughout the entire itinerary — in cost estimates, restaurant price guidance, experience fees, and all budget sections.

LONG TRIP DESCRIPTION BREVITY:
If the total trip is longer than 10 nights, limit every prose description to one sentence maximum (approximately 15–20 words). This applies to: morning, afternoon, and evening slot descriptions; breakfast_suggestion and restaurant_suggestion descriptions; hidden_finds descriptions.
Do not shorten venue names, tier labels, or booking platform hints — only the prose that follows the venue name.
Example of correct format for a long trip:
  "South Congress Ave · SoCo — Austin's most iconic strip of shops, cafés, and street art."
Example of incorrect (too long) format:
  "South Congress Ave · SoCo — Austin's most iconic stretch, lined with eclectic boutiques, vintage shops, acclaimed restaurants, food trucks, and the legendary Ann W. Richards Congress Avenue Bridge just to the north."

OUTPUT HYGIENE (CRITICAL) — never let internal text leak into any customer-facing field:
- No planning notes: never write "UNCERTAIN", "TBD", "cannot confirm", "leave as is", or similar. If you cannot confidently name a specific breakfast restaurant for a day, omit the breakfast field entirely (see TRANSIT DAY BREAKFAST) — never a placeholder.
- No self-correction or revision markers: never write "wait", "instead", "actually", "correction:", "updated:", "revised:", "I meant", or "scratch that". If you change your mind mid-generation, write only the final choice — never the reasoning or the discarded option.
- No citation/footnote markers: never write "[1]", "[2]", "[7]", or any bracketed source numbers. State facts plainly, without a source annotation.

STEP 16 — ACCURACY
Only use what was submitted. Never reference or invent details not provided. Never invent property names, venue names, or transport services you cannot reasonably verify exist.
Never assume or infer the traveler's nationality — not from their name, their departure city, or any other detail — and never state or imply that this is a domestic trip or that the traveler is a citizen of the destination country. For visa_requirements and entry_requirements in practical_info, give generic, passport-agnostic advice: state that entry requirements vary by passport, name the most common visa-free nationalities for this destination if well-known (e.g. US/Canada, UK, EU, Australia), cover visa-on-arrival availability, e-visa options, and processing time, and always tell the traveler to verify their own passport's specific requirements before travel.
Always address the traveler directly as "you" and "your" throughout the entire output — never by name, and never in third person ("the couple", "the traveler", "the group", or any third-person narrative).

TEMPORAL ACCURACY — before assigning any venue or event, verify it actually operates on that date; if unsure, do not assign it. Check both:
- Day of week: venues that run only on certain days must fall on a day they are open. Common pitfalls: farmers markets (often Saturday/Sunday only — check the specific market), weekend-only brunch spots, weekly events (trivia nights, open mics, pop-ups). When a description references day type ("quiet on weekday afternoons," "busy on weekend mornings," "closed Mondays"), confirm it matches the real weekday for that date — e.g. never call a Saturday visit "quiet on a weekday." Monday closures: for a wine tasting, boutique, or tasting-room activity that falls on a Monday in a Monday-closure region (Hill Country wineries, wine country, small European-style towns), add a note in the activity description — "Note: Call ahead — some tasting rooms in this area close on Mondays." — do not rely on Practical Info alone.
  DAY-OF-WEEK IN VENUE NAMES (CRITICAL): If a venue or event name contains a day of the week — for example "Sunday Market", "Monday Night Jazz", "Wednesday Farmers Market", "Friday Street Food Night" — that day is a hard scheduling constraint. The venue must only be placed on the matching day of the week. No exceptions. Before assigning any venue whose name contains a day of the week, confirm that the calendar date in the itinerary matches that day. Example: "Tlacolula Sunday Market" → only assign on a Sunday. If no Sunday falls within that city's stay, do not assign this venue.
- Time of year: seasonal venues/events must run during the travel dates. Examples: summer festivals, outdoor summer dances, winter-only attractions, holiday markets, harvest events, seasonal park programs. Common pitfall: outdoor summer events (Memorial Day through Labor Day) placed on autumn, winter, or spring dates.

Treat mustSee and extraNotes as hard instructions, not suggestions. They are the traveler's direct voice and override EVERY rule in this prompt — arrival/departure city rules, night allocation, city selection, routing — with ONE exception: the SAFETY EXCLUSIONS in Step 2 can never be overridden by notes. Apply the notes before generating any output. If the traveler mentions existing bookings, flights, or accommodation — include them in book_before_you_go as already confirmed and reflect them in the day-by-day.
Cross-country airports: if arrival and departure airports are in different countries, note this in the overview and clarify which country the itinerary covers. Never plan activities or cities outside the submitted country.

OUTPUT — return exactly this JSON:
{
  "recommended_cities": [
    {
      "city": "string",
      "why_recommended": "string — max 25 words",
      "city_teaser": "string — REQUIRED. One evocative sentence on what makes this city special on this trip."
    }
  ],
  "days": [
    {
      "date": "YYYY-MM-DD",
      "city": "string",
      "neighborhood_focus": "string",
      "morning": "string — Activity name — one line description. Max 20 words. No tier prefix in this string.",
      "morning_tier": "Iconic | Local Pick | Hidden Gem — required unless morning is N/A or Free afternoon",
      "afternoon": "string — Activity name — one line description. Max 20 words. No tier prefix in this string.",
      "afternoon_tier": "Iconic | Local Pick | Hidden Gem — required unless afternoon is N/A or Free afternoon",
      "evening": "string — Activity name — one line description. Max 20 words. No tier prefix in this string.",
      "evening_tier": "Iconic | Local Pick | Hidden Gem — required unless evening is N/A",
      "breakfast_suggestion": "string — Breakfast: Restaurant or cafe name | neighborhood | one line why it fits today",
      "restaurant_suggestion": "string — Meal type (Lunch/Dinner): Restaurant name | neighborhood | one line why it fits today. On the FINAL departure day only (returning home), set this to exactly: N/A. On a mid-trip transit day, this is a real dinner near the arrival city.",
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
  "book_before_you_go": [
    {
      "booking_priority": "Book now · 4–6 weeks ahead · On arrival",
      "item_name": "string",
      "city": "string",
      "date": "string",
      "est_cost": "string",
      "booking_tip": "string — one sentence, why booking ahead matters for this item",
      "booking_link": "string — always an empty string; never a URL (see NO URLS rule)"
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
Arrival airport: ${d.arrivalAirport || ''}${d.arrivalCityName ? ` (city: ${d.arrivalCityName})` : ''}
Departure airport: ${d.departureAirport || ''}${d.departureCityName ? ` (city: ${d.departureCityName})` : ''}
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
Pace: ${d.paceOfTravel || ''} (packed = Fast pace, relaxed = Relaxed pace — apply the Fast/Relaxed pace rules throughout)
Travel style: ${travelStyle}
Accommodation style: ${accommodationStyle}
Interests weighted: ${interests}
Cuisine preferences: ${cuisinePreferences}
Must see: ${d.mustSee || ''}
Extra notes: ${d.extraNotes || ''}`;
};

// ── MODE B: recommendations-only prompt (no day-by-day schedule) ────────────────
const RECS_PROMPT = (d, flags) => {
  const interests = JSON.stringify(d.interests || {});
  const cuisinePreferences = JSON.stringify(d.cuisinePreferences || []);
  const citiesRequested = JSON.stringify(d.citiesToVisit || []);
  const approvedCities = JSON.stringify(d.approvedCities || []);
  const travelStyle = d.travelStyle || d.budgetTier || '';
  return `You are an expert travel planner. Generate a city-organized best-of recommendations list for ${d.country || 'the destination'}.
Do not create a day-by-day schedule. For each city, consolidate your best activities, restaurants, and hidden finds into a stacked list organized by city. This should be a robust, thorough list — include everything you would have recommended across the full trip.

Return ONLY valid JSON starting with { and ending with }. No markdown, no code fences.

CITIES: Use the approved city plan if provided; otherwise select the best-fit cities for this traveler.
Approved cities: ${approvedCities}
Cities requested: ${citiesRequested}

For EACH city provide:
- city_teaser: ONE evocative sentence on what makes this city special on this trip (sensory, specific, not logistical).
- activities: 5–8 specific things to do, best-first. Each: name, description (max 25 words, why it suits this traveler), spot_tier (Iconic · Local Pick · Hidden Gem).
- restaurants: 5–8 specific venues across meal types. Each: name, venue_type, cuisine_category, price_range, known_for (max 8 words), neighborhood, why (max 10 words). Never use the destination city or country name as the restaurant name (e.g. "Chengdu Restaurant" in Chengdu is not acceptable — use the venue's actual name).
- hidden_finds: 2–3 genuinely non-obvious places most visitors miss. Each: emoji, title, description (max 25 words), city.
  HIDDEN FIND TITLES: The title of every hidden find must be the real, specific name of an actual venue, experience, or place — not a descriptive phrase or thematic label.
    WRONG: "Pinot Poured With Local Pride" / "A Hidden Garden at Dusk" / "Craft Beer Off the Beaten Path"
    RIGHT: "Eyrie Vineyards Tasting Room" / "Fredericksburg Herb Farm" / "Occidental Brewing"
    If you cannot name a specific real venue, do not include it as a hidden find.
  HIDDEN FINDS — DEDUPLICATION (CRITICAL): Before finalizing ANY hidden find, cross-check its venue name against EVERY other part of this city's list — every activity and every restaurant. If a venue appears ANYWHERE in the above, it MUST NOT appear in hidden finds. No exceptions. Apply this check to every single hidden find before including it. If you are unsure whether two entries refer to the same venue, treat them as duplicates and exclude it. NAME VARIATIONS: Treat names as matching even when one includes a category prefix or uses different spacing/formatting. Strip the following prefixes before comparing: Cerveceria, Mezcalería, Mezcaleria, Café, Cafe, Bar, Cantina, Pulquería, Pulqueria, Taquería, Taqueria, Restaurante, Restaurant, Cocina. Example: "Cerveceria Tierra Adentro" and "TierrAdentro" — strip "Cerveceria" and normalize spacing → both reduce to "tierra adentro" → same venue → exclude from hidden finds.

Weight everything by the traveler's interests and cuisine preferences. Exclude any interest at 0%. Address the traveler as "you".

SEASONAL EVENT ACCURACY (CRITICAL): When including a seasonal event or festival as a recommendation (e.g. Day of the Dead, cherry blossom, carnival, Songkran), only describe the traveler as experiencing it if the trip dates overlap with the actual event window, or the trip ends within 7 days of the event start. If the trip ends more than 7 days before the event begins: you MAY mention the event as future context ("Oaxaca's Day of the Dead (Nov 1–2) is one of Mexico's most extraordinary festivals — consider timing a future visit") but you MUST NOT imply the traveler will see preparations, atmosphere, or early decorations during their actual visit dates. Do not include the event as an activity or hidden find. Apply the same rule to any practical/seasonal notes — do not claim the traveler's dates overlap with seasonal atmosphere unless the dates are genuinely close.
RECURRING EVENT ACCURACY: The same rule applies to recurring events that happen on a fixed calendar date — monthly flea markets, weekly craft markets, shrine fair days, regular night markets. If the specific occurrence date falls outside the trip dates, do not recommend the event as something the traveler can attend. Example: Toji Temple Flea Market (Kyoto, every 21st) — if the trip is Oct 1–9, the Oct 21 market is not attendable; either omit it or reframe it as future context: "The Toji Flea Market on the 21st is a Kyoto institution — if your dates align, it's unmissable." Apply this check to the activities AND hidden finds.
${flags.wantTransportation ? `\nGETTING AROUND: Provide a general "Getting Around ${d.country || 'the destination'}" guide — transport options, tips, and how to move between the main areas. General guidance only.` : ''}
${flags.wantAccommodations ? `\nACCOMMODATIONS: Provide exactly 3 hotel picks per city (never fewer than 3), matched to the traveler's accommodation style and budget.` : ''}

TRAVELER PREFERENCES:
Country: ${d.country || ''}
Arrival date: ${d.arrivalDate || ''}
Departure date: ${d.departureDate || ''}
Travel party: ${d.travelParty || ''}
Group size: ${d.groupSize || 'not specified'}
Travel style: ${travelStyle}
Accommodation style: ${JSON.stringify(d.accommodationStyle || [])}
Interests weighted: ${interests}
Cuisine preferences: ${cuisinePreferences}
Must see: ${d.mustSee || ''}
Extra notes: ${d.extraNotes || ''}

Do not include foreign language characters or non-Latin script in any venue names, titles, or parenthetical translations. English names only.

OUTPUT HYGIENE: Never let internal text leak into any output field — no citation or footnote markers ("[1]", "[7]", or any bracketed numbers), no self-correction or revision language ("note:", "instead", "actually", "revised:"), and no internal planning notes ("UNCERTAIN", "TBD", "cannot confirm"). Write only the final answer.

VISA & ENTRY: Never assume or infer the traveler's nationality, and never state or imply that this is a domestic trip or that the traveler is a citizen of the destination country. For visa_requirements and entry_requirements, give generic, passport-agnostic advice: state that entry requirements vary by passport, name the most common visa-free nationalities for this destination if well-known (e.g. US/Canada, UK, EU, Australia), cover visa-on-arrival availability, e-visa options, and processing time, and always tell the traveler to verify their own passport's specific requirements before travel.

OUTPUT — return exactly this JSON:
{
  "overview": "string — max 3 sentences",
  "cities": [
    {
      "city": "string",
      "city_teaser": "string — REQUIRED. One evocative sentence on what makes this city special on this trip.",
      "activities": [
        { "name": "string", "description": "string — max 25 words", "spot_tier": "Iconic · Local Pick · Hidden Gem" }
      ],
      "restaurants": [
        { "name": "string", "venue_type": "Breakfast · Brunch · Cafe · Bakery · Lunch · Dinner · Street Food · Dessert", "cuisine_category": "string", "price_range": "string", "known_for": "string — max 8 words", "neighborhood": "string", "why": "string — max 10 words" }
      ],
      "hidden_finds": [
        { "emoji": "string", "title": "string — max 8 words", "description": "string — max 25 words", "city": "string" }
      ]
    }
  ],${flags.wantAccommodations ? `
  "accommodations": [
    { "city": "string", "recommended_type": "string", "name": "string", "neighborhood": "string", "estimated_cost_per_night": "string", "why": "string — max 15 words" }
  ],` : ''}${flags.wantTransportation ? `
  "getting_around": { "overview": "string — 2–3 sentences", "tips": ["string", "string"] },` : ''}
  "book_before_you_go": [
    { "item_name": "string", "city": "string", "date": "string", "est_cost": "string", "booking_priority": "Book now · 4–6 weeks ahead · On arrival", "booking_tip": "string — one sentence, name the booking platform in plain text only, never a URL", "booking_link": "string — always an empty string; never include a URL" }
  ],
  "practical_info": {
    "weather_summary": "string", "visa_requirements": "string", "entry_requirements": "string",
    "currency": "string", "connectivity": "string", "transport_tips": "string",
    "packing_tips": "string", "must_know": "string", "booking_priority": "string"
  }
}

Real named places only. No hedging.`;
};

// Assemble the generation prompt for the requested sections. Mode A (schedule) = the full
// day-by-day prompt with conditional directives that drop accommodations/transport when not
// requested. Mode B (recs) = a city-organized best-of list, no schedule.
function buildPrompt(d, flags) {
  const bbyg = () => {
    const r = ['BOOK BEFORE YOU GO FILTER:'];
    if (!flags.wantAccommodations) r.push('- Do NOT include hotel/accommodation booking items.');
    if (!flags.wantTransportation)  r.push('- Do NOT include transport booking tips (rail passes, inter-city flights, transfers).');
    r.push('- ALWAYS include when relevant: visa/entry requirements, and activity/attraction reservations that sell out or need timed entry.');
    r.push('- Do NOT include travel insurance — it is a generic logistics reminder, not specific to this itinerary.');
    return r.join('\n');
  };
  if (flags.wantDayByDay) {
    const add = ['\n──────────────────────────────────────────────\nSECTION SELECTION OVERRIDES (apply after all steps above):'];
    if (!flags.wantAccommodations) add.push('ACCOMMODATIONS NOT REQUESTED: Output "accommodations": []. Recommend no hotels/lodging anywhere in the output.');
    if (!flags.wantTransportation)  add.push('TRANSPORTATION NOT REQUESTED: Output "transport": []. No inter-city routing or transfer logistics. Airports only anchor the first/last city.');
    add.push(bbyg());
    return ITINERARY_PROMPT(d, null) + '\n' + add.join('\n\n');
  }
  return RECS_PROMPT(d, flags) + '\n\n' + bbyg();
}

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
function hasRequiredKeys(obj, mode = 'schedule') {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
  // overview is generated in a separate post-call (generateOverview) so not required here.
  // accommodations/transport are conditional (section-select), so not required.
  const req = mode === 'recs'
    ? ['cities', 'book_before_you_go', 'practical_info']
    : ['days', 'restaurants', 'city_guide', 'book_before_you_go', 'practical_info'];
  return req.every(k => k in obj);
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

// Shared system prompt — persona + output contract live here instead of at the
// top of each (already long) user prompt. Applied to every callClaude call.
// NOTE: claude-sonnet-4-6 does not support assistant-message prefill ("start the
// response with {"), so JSON discipline is enforced here + by the forgiving
// parsers (parseClaudeResponse / parsePreviewJson strip any stray fences).
const CLAUDE_SYSTEM_PROMPT = 'You are an expert travel planner producing output for an automated pipeline. Follow every instruction in the user message exactly. Output ONLY the requested format — no markdown code fences, no preamble, no commentary before or after your answer. When the user message requests JSON, your response must begin with the opening { or [ of that JSON and end with its closing } or ].';

// Single Claude API call for itinerary generation. Returns the response text,
// or null on any failure (errors are logged inside streamAnthropic).
// maxTokens / timeoutMs default to the STANDARD-trip budget; generateItinerary
// passes larger tier-scaled values for MEDIUM/LONG trips. 64000 is the
// claude-sonnet-4-6 output ceiling.
//
// opts.temperature — defaults to 0.4: this is constraint-heavy structured
// generation, not open-ended prose. (API default is 1.0.)
async function callClaude(env, prompt, maxTokens = 32000, timeoutMs = 300000, opts = {}) {
  const body = {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    temperature: (opts.temperature != null ? opts.temperature : 0.4),
    system: CLAUDE_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: prompt }]
  };
  const { text } = await streamAnthropic(env, body, timeoutMs);
  return text || null;
}

// ── Perplexity research for itinerary generation ────────────────────────────
// Only called when env.USE_PERPLEXITY === 'true'. Runs two parallel queries
// (experiences + logistics) and returns combined research text for injection
// into ITINERARY_PROMPT. Fails silently — if Perplexity errors, generation
// continues with Claude-only (no research injected).

const TRAVEL_DOMAINS = [
  'timeout.com', 'tripadvisor.com', 'yelp.com', 'lonelyplanet.com',
  'cntraveler.com', 'theguardian.com', 'atlasobscura.com', 'eater.com',
  'theinfatuation.com', 'elizabethminchilli.com', 'fodors.com', 'frommers.com',
  'afar.com', 'thefork.com', 'viator.com', 'getyourguide.com',
  'italymagazine.com', 'walksofitaly.com', 'italybyus.com'
];

async function callPerplexity(env, systemPrompt, userQuery, maxTokens = 800, useReasoning = false) {
  const TIMEOUT_MS = 30000;
  const model = useReasoning ? 'sonar-reasoning-pro' : 'sonar-pro';

  const doCall = (m) => fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${env.PERPLEXITY_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: m,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userQuery }
      ],
      max_tokens: maxTokens,
      temperature: 0.2,
      search_domain_filter: TRAVEL_DOMAINS,
      search_recency_filter: 'year'
    })
  });

  const timeout = (ms) => new Promise((_, reject) =>
    setTimeout(() => reject(new Error('timeout')), ms)
  );

  let res;
  try {
    res = await Promise.race([doCall(model), timeout(TIMEOUT_MS)]);
  } catch (err) {
    if (useReasoning && err.message === 'timeout') {
      console.log('Perplexity sonar-reasoning-pro timed out — falling back to sonar-pro');
      res = await doCall('sonar-pro');
    } else {
      throw err;
    }
  }

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Perplexity ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content || '';
}

async function buildPerplexityResearch(env, d) {
  const cities = [...new Set([
    ...(Array.isArray(d.citiesToVisit)   ? d.citiesToVisit   : []),
    ...(Array.isArray(d.approvedCities)  ? d.approvedCities.map(c => c.city || c) : [])
  ])].filter(Boolean);

  const cityList = cities.length ? cities : [d.country];
  const month    = (() => {
    try { return new Date(d.arrivalDate).toLocaleString('en-US', { month: 'long', year: 'numeric' }); }
    catch (_) { return d.arrivalDate || ''; }
  })();

  const interests = d.interests || {};
  const sortedInterests = Object.entries(interests).sort(([,a],[,b]) => b - a).filter(([,v]) => v > 0);
  const primary   = sortedInterests.filter(([,v]) => v >= 20).map(([k]) => k);
  const secondary = sortedInterests.filter(([,v]) => v >= 11 && v < 20).map(([k]) => k);
  const excluded  = sortedInterests.filter(([,v]) => v === 0).map(([k]) => k);

  const budget    = d.travelStyle || d.budgetTier || 'mid-range';
  const budgetDesc = budget === 'budget' ? '$50–100/day per person' :
                     budget === 'luxury' ? '$250+/day per person' :
                                          '$100–250/day per person';
  const pace      = d.paceOfTravel === 'packed'  ? 'packed — morning, afternoon AND evening all filled' :
                    d.paceOfTravel === 'relaxed' ? 'relaxed — morning + one of afternoon or evening' :
                                                  'balanced';
  const groupSize = d.groupSize ? `Group of ${d.groupSize}` : (d.travelParty || '');
  const cityPairs = cityList.slice(0, -1).map((c, i) => `${c} → ${cityList[i + 1]}`);

  console.log(`Perplexity research — cities: ${cityList.join(', ')}`);

  // QUERY 1: Experiences → day-by-day activities, restaurants, local picks
  const experiencesQuery = `
Trip: ${cityList.join(' → ')}, ${d.country}. Dates: ${d.arrivalDate} to ${d.departureDate} (${month}).
Party: ${groupSize}. Budget: ${budgetDesc}. Pace: ${pace}.
Primary interests (feature prominently): ${primary.join(', ') || 'food, culture'}.
${secondary.length ? `Secondary (include if natural): ${secondary.join(', ')}.` : ''}
${excluded.length  ? `Exclude entirely: ${excluded.join(', ')}.`               : ''}

For EACH city (${cityList.join(', ')}), provide:

RESTAURANTS — 3 specific named restaurants, group-friendly, seats ${d.groupSize || '6+'}, ${budgetDesc}:
- [Name] | [neighbourhood] | [signature dish] | [why locals rate it]

ACTIVITIES — 3 specific named experiences matching primary interests:
- [Name] | [neighbourhood] | [what it is + why it suits these interests]

LOCAL PICKS — 1 non-tourist hidden gem per city (specific real place most visitors miss):
- [Emoji] [Name] — [why it's special, max 15 words]

FORMAT: Use exact headings "### [City Name]", then "RESTAURANTS", "ACTIVITIES", "LOCAL PICKS".
Real named places only. No hedging or disclaimers. Note any August closures inline.
`.trim();

  // QUERY 2: Logistics → transport legs + seasonal notes
  const logisticsQuery = `
${d.country} trip: ${cityList.join(' → ')}. Dates: ${d.arrivalDate} to ${d.departureDate}.
Party: ${groupSize}.

TRANSPORT — for each leg, best option with time and cost:
${cityPairs.length ? cityPairs.map(l => `- ${l}: drive time OR train OR flight; if flight, state WHICH airlines actually operate the route, how many flights per week, and typical departure times; cost estimate, booking tip`).join('\n') : `- Internal travel within ${d.country}`}

FLIGHT FREQUENCY — explicitly call out any leg served by fewer than one flight per day (state days of week and departure time if known).

SEASONAL NOTES — any closures, festivals, or crowd warnings for these exact dates.

Headings: "## TRANSPORT", "## FLIGHT FREQUENCY", "## SEASONAL NOTES". Specific times and costs. No hedging.
`.trim();

  try {
    const [exp, log] = await Promise.all([
      callPerplexity(
        env,
        `You are a local travel expert. Always give real named places. Never hedge or say you cannot find information. Answer in exact format requested only.`,
        experiencesQuery, 1400, true
      ).catch(err => { console.error('Perplexity experiences failed:', err.message); return '[Experiences research unavailable]'; }),

      callPerplexity(
        env,
        'You are a travel logistics expert. Specific transport times, costs, and seasonal facts only. No hedging.',
        logisticsQuery, 600, false
      ).catch(err => { console.error('Perplexity logistics failed:', err.message); return '[Logistics research unavailable]'; })
    ]);

    return `## EXPERIENCES\n${exp}\n\n## LOGISTICS\n${log}`;
  } catch (err) {
    console.error('buildPerplexityResearch failed:', err.message);
    return null;
  }
}

// ── Overview post-generation call ─────────────────────────────────────────────
// Called after the main itinerary validates. Receives only the actual city
// sequence, transport, and dates — structurally prevents hallucinating routing
// or cities not in the plan. Fails gracefully — falls back to a generic overview.
async function generateOverview(env, itinerary, d) {
  try {
    // Build city sequence from approved cities (most reliable) or from days
    const approvedCities = d.approvedCities || [];
    let cityLines;
    if (approvedCities.length > 0) {
      cityLines = approvedCities.map(c => `- ${c.city || c.name}: ${c.nights} night${c.nights === 1 ? '' : 's'}`).join('\n');
    } else {
      // Fall back to deriving from days array
      const seen = new Map();
      for (const day of (itinerary.days || [])) {
        if (day.city && !seen.has(day.city)) seen.set(day.city, 0);
        if (day.city) seen.set(day.city, (seen.get(day.city) || 0) + 1);
      }
      cityLines = [...seen.entries()].map(([city, nights]) => `- ${city}: ${nights} night${nights === 1 ? '' : 's'}`).join('\n');
    }

    // Build transport summary (key inter-city modes only)
    const transports = (itinerary.transport || []).slice(1, -1) // skip airport transfers
      .map(t => `${t.from} → ${t.to}: ${t.recommended_mode}`)
      .join(', ');

    // Round-trip detection
    const normAirport = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const isRoundTrip = d.arrivalAirport && d.departureAirport
      && normAirport(d.arrivalAirport) === normAirport(d.departureAirport);
    const finalCity = approvedCities.length > 0
      ? (approvedCities[approvedCities.length - 1].city || approvedCities[approvedCities.length - 1].name)
      : '';

    const prompt = `You are an expert travel writer. Write a 3-sentence trip overview for the itinerary below.

Destination: ${d.country || 'the destination'}
Dates: ${d.arrivalDate || ''} to ${d.departureDate || ''}
Travel party: ${d.travelParty || ''}
Travel style: ${d.travelStyle || d.budgetTier || ''}
Pace: ${d.paceOfTravel || ''}
Key interests: ${Object.entries(d.interests || {}).filter(([,v]) => Number(v) >= 11).map(([k]) => k).join(', ') || 'varied'}

CITY SEQUENCE (the actual itinerary — describe ONLY these cities and nights):
${cityLines}

Inter-city transport: ${transports || 'varied'}
Departure airport: ${d.departureAirport || ''}
${isRoundTrip ? `Round-trip: YES — the trip departs from the same airport it arrived into. The actual final city is ${finalCity}. Do NOT write "returning to" any city that is not in the city sequence above.` : 'One-way or multi-destination trip.'}

Rules:
- Write in second person ("you", "your") — address the traveler directly.
- Describe ONLY the cities and routing listed above. Never mention a city not in the list.
- Never write "returning to [city]" unless that city appears as the LAST item in the city sequence above.
- 3 sentences max: (1) cities + overall trip tone, (2) routing logic or highlight experiences, (3) seasonal or timing note if relevant.
- Do not start with "You'll" — vary the opening.
- No markdown, no code fences. Return the 3-sentence overview as plain text only.`;

    // Plain-prose call — no prefill, and a higher temperature than the structured
    // calls so the overview doesn't read flat.
    const raw = await callClaude(env, prompt, 500, 30000, { temperature: 0.7 });
    if (!raw) {
      const cityNames = (d.approvedCities || []).map(c => c.city || c.name).filter(Boolean).join(', ');
      return cityNames ? `A personalized ${d.country || 'travel'} itinerary: ${cityNames}.` : '';
    }
    // Strip any accidental markdown or quotes
    return raw.trim().replace(/^["']|["']$/g, '').trim();
  } catch (err) {
    console.error('[generateOverview] failed (continuing without overview):', err.message);
    const cityNames = (d.approvedCities || []).map(c => c.city || c.name).filter(Boolean).join(', ');
    return cityNames ? `A personalized ${d.country || 'travel'} itinerary: ${cityNames}.` : '';
  }
}

// ── Hidden Finds post-generation call ────────────────────────────────────────
// Called after the main itinerary validates. Builds a complete exclusion list
// from the main itinerary (all day-by-day activities, meals, and restaurants)
// then makes a separate, lightweight Claude call to generate hidden_finds.
// Fails gracefully — if this call errors, itinerary.hidden_finds is set to [].
async function generateHiddenFinds(env, itinerary, d) {
  try {
    const cities = (d.approvedCities || []).map(c => c.city || c.name || '').filter(Boolean);
    const cityCount = cities.length || 1;

    // Build exclusion list: all named venues already in the itinerary
    const usedVenues = new Set();
    const addVenue = (str) => {
      if (!str || typeof str !== 'string') return;
      // Strip meal-type prefix: "Dinner: Venue Name | ..." → "Venue Name"
      let s = str.replace(/^(breakfast|lunch|dinner|brunch):\s*/i, '');
      // Take only the venue name (before | or —)
      s = s.split(/[|—–]/, 1)[0].trim();
      // Strip tier prefix if present (legacy format)
      s = s.replace(/^\[(Iconic|Local Pick|Hidden Gem)\]\s*/i, '').trim();
      if (s.length > 2) usedVenues.add(s.toLowerCase());
    };

    for (const day of (itinerary.days || [])) {
      addVenue(day.morning);
      addVenue(day.afternoon);
      addVenue(day.evening);
      addVenue(day.breakfast_suggestion);
      addVenue(day.restaurant_suggestion);
    }
    for (const r of (itinerary.restaurants || [])) {
      if (r.name) usedVenues.add(r.name.toLowerCase());
    }

    const exclusionList = [...usedVenues].map(v => `- ${v}`).join('\n');

    // Scaling: 1–2 cities → 3/city, 3–4 cities → 2/city, 5+ → 1/city, hard cap 8
    const perCity = cityCount >= 5 ? 1 : cityCount >= 3 ? 2 : 3;
    const targetCount = Math.min(cityCount * perCity, 8);

    const citySequence = cities.length
      ? cities.join(' → ')
      : (d.country || 'the destination');

    const prompt = `You are an expert travel planner. Generate exactly ${targetCount} hidden finds for a trip to ${d.country || 'the destination'}.

Cities visited: ${citySequence}
Trip dates: ${d.arrivalDate || ''} to ${d.departureDate || ''}
Travel party: ${d.travelParty || ''}
Interests: ${JSON.stringify(d.interests || {})}

EXCLUDED VENUES — these are already used elsewhere in this itinerary. Never include any of them as a hidden find, even under a slightly different name:
${exclusionList || '(none)'}

Rules:
- Every title must be the real, specific name of an actual venue, experience, or place — not a descriptive phrase or thematic label.
  WRONG: "Pinot Poured With Local Pride" / "A Hidden Garden at Dusk" / "Craft Beer Off the Beaten Path"
  RIGHT: "Eyrie Vineyards Tasting Room" / "Fredericksburg Herb Farm" / "Occidental Brewing"
- Each entry must pass the "wouldn't have found this on my own" test — genuinely non-obvious, specific, surprising.
- Cross-check every title against the EXCLUDED VENUES list above before including it.
- Distribute finds across the cities — don't cluster all finds in one city.
- Max title length: 8 words.
- Description: max 25 words, why it's special and non-obvious.
- Target count: exactly ${targetCount} (hard cap 8 total).

Return ONLY a valid JSON array, starting with [ and ending with ]. No markdown, no code fences, no explanation. All string field values must be clean plain text — no **bold**, no _italic_, no ##headers. Example format:
[
  {"emoji": "🍵", "title": "Ippodo Tea Kyoto", "description": "300-year-old tea merchant where staff brew samples and explain grades — tourists walk past, tea lovers stay an hour.", "city": "Kyoto"},
  {"emoji": "🏺", "title": "Kaikado Kyoto", "description": "Six-generation tin canister workshop open to browsers — their signature cylindrical tea caddies are still hand-spun on-site.", "city": "Kyoto"}
]`;

    const raw = await callClaude(env, prompt, 4000, 60000);
    if (!raw) return [];

    // Parse JSON array from response
    const cleaned = raw.trim().replace(/^```json\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/i, '').trim();
    const match = cleaned.match(/\[[\s\S]*\]/);
    if (!match) return [];
    const finds = JSON.parse(match[0]);
    if (!Array.isArray(finds)) return [];
    return finds.slice(0, 8); // enforce hard cap
  } catch (err) {
    console.error('[generateHiddenFinds] failed (continuing without hidden finds):', err.message);
    return [];
  }
}

// Generate, parse, validate, and (once) retry the full itinerary.
// Always resolves — returns the itinerary object or a clean error object.
// NOTE: Perplexity is no longer used pre-generation. It runs post-generation
// in verifyAndEnrichWithPerplexity (called from fulfillOrder) to web-check
// Claude's venue picks and replace closed venues and low-quality/stale gems.
async function generateItinerary(env, d) {
  try {
    const flags = d.flags || { wantDayByDay: true, wantAccommodations: true, wantTransportation: true };
    const mode = flags.wantDayByDay ? 'schedule' : 'recs';
    const finalize = (p) => { p.mode = mode; p.selected_sections = d.selectedSections || []; return p; };
    const basePrompt = buildPrompt(d, flags);

    // Scale output budget + timeout to trip length (same tiers as tripTier in
    // ITINERARY_PROMPT): STANDARD ≤7n, MEDIUM 8–10n, LONG 11–14n.
    const tripNights = (() => {
      const a = Date.parse(d.arrivalDate), b = Date.parse(d.departureDate);
      if (!isNaN(a) && !isNaN(b) && b > a) return Math.round((b - a) / 86400000);
      const sum = (d.approvedCities || []).reduce((n, c) => n + (Number(c.nights) || 0), 0);
      return sum || 0;
    })();
    const maxTokens = tripNights >= 11 ? 64000 : tripNights >= 8 ? 48000 : 32000;
    const timeoutMs = tripNights >= 11 ? 720000 : tripNights >= 8 ? 420000 : 300000;

    // Attempt 1 — base prompt
    let rawText = await callClaude(env, basePrompt, maxTokens, timeoutMs);
    let parsed = parseClaudeResponse(rawText);
    if (hasRequiredKeys(parsed, mode)) {
      // Debug: warn if days are empty (overview is now post-generated so skip that check)
      const daysEmpty = mode === 'schedule' && Array.isArray(parsed.days) && parsed.days.length === 0;
      if (daysEmpty) {
        console.error('[DEBUG] hasRequiredKeys passed but days array is empty — raw response length:', rawText?.length, '| first 500 chars of raw:', rawText?.substring(0, 500));
      }
      // Run post-generation calls in parallel: overview (accuracy-guaranteed) + hidden finds
      // (full exclusion list, own token budget). Both fail gracefully.
      if (mode === 'schedule') {
        const [overview, hiddenFinds] = await Promise.all([
          generateOverview(env, parsed, d),
          generateHiddenFinds(env, parsed, d)
        ]);
        parsed.overview = overview;
        parsed.hidden_finds = hiddenFinds;
      }
      return finalize(parsed);
    }
    console.error('Itinerary attempt 1 failed (parse or missing keys). Raw response:', rawText);

    // LONG trips: skip the retry — a second 9-min call risks exceeding the queue
    // consumer wall-clock. Fail fast instead.
    if (tripNights >= 11) {
      console.error('LONG trip — skipping retry to stay within queue consumer time budget.');
      return { error: true, message: 'Itinerary generation failed — please try again.' };
    }

    // Attempt 2 — retry once with strict JSON instruction appended
    rawText = await callClaude(env, basePrompt + JSON_RETRY_INSTRUCTION, maxTokens, timeoutMs);
    parsed = parseClaudeResponse(rawText);
    if (hasRequiredKeys(parsed, mode)) {
      if (mode === 'schedule') {
        const [overview, hiddenFinds] = await Promise.all([
          generateOverview(env, parsed, d),
          generateHiddenFinds(env, parsed, d)
        ]);
        parsed.overview = overview;
        parsed.hidden_finds = hiddenFinds;
      }
      return finalize(parsed);
    }
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

// ── Currency normalization ───────────────────────────────────────────────────
// Perplexity-sourced cost strings sometimes come back with ISO codes
// ("CNY 600–900", "USD 50–80") instead of the local symbol the prompt asks for.
// Normalize any such string before it's stored on the itinerary. No-op for
// non-strings and for strings that already use symbols.
function normalizeCurrencyString(costStr) {
  if (!costStr || typeof costStr !== 'string') return costStr;
  // Replace ISO codes with symbols
  return costStr
    .replace(/\bCNY\s*/g, '¥')
    .replace(/\bRMB\s*/g, '¥')
    .replace(/\bUSD\s*/g, '$')
    .replace(/\bGBP\s*/g, '£')
    .replace(/\bEUR\s*/g, '€')
    .replace(/\bAUD\s*/g, 'A$')
    .replace(/\bCAD\s*/g, 'C$')
    .replace(/\bJPY\s*/g, '¥')
    .replace(/\bKRW\s*/g, '₩')
    .replace(/\bTHB\s*/g, '฿')
    .replace(/\bINR\s*/g, '₹')
    .replace(/\bMXN\s*/g, '$');
}

// ── Meal venue dedup (guards Perplexity restaurant replacements) ──────────────
// Perplexity restaurant swaps bypass the MEAL VENUE UNIQUENESS prompt rule, so a
// replacement can silently re-introduce a venue already used elsewhere. Build the
// set of meal venues currently in the itinerary, then test each candidate against it.
function buildMealVenueSet(days) {
  const venues = new Set();
  for (const day of days) {
    for (const field of ['restaurant_suggestion', 'breakfast_suggestion', 'lunch_suggestion']) {
      const meal = day[field];
      if (!meal) continue;
      const name = (typeof meal === 'string' ? meal : (meal.name || meal.venue || '')).toLowerCase().trim();
      if (name) venues.add(name);
    }
  }
  return venues;
}

function mealVenueAlreadyUsed(candidateName, existingVenues) {
  const name = candidateName.toLowerCase().trim();
  // Exact match
  if (existingVenues.has(name)) return true;
  // Fuzzy: if candidate shares a distinctive long word with an existing venue
  const candidateWords = name.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 5);
  for (const existing of existingVenues) {
    const existingWords = existing.replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 5);
    if (candidateWords.some(w => existingWords.includes(w))) return true;
  }
  return false;
}

// ── Perplexity post-generation verification ──────────────────────────────────
// Verifies restaurants, accommodations, and hidden finds via Perplexity
// web-check. Replaces closed venues and low-quality/stale gems in place —
// count stays flat. Mutates itinerary in place. Fails silently — itinerary
// always ships.
async function verifyAndEnrichWithPerplexity(env, itinerary, formData) {
  console.log('Perplexity post-gen verification starting...');
  const isRecs = itinerary.mode === 'recs';
  const days = Array.isArray(itinerary.days) ? itinerary.days : [];
  const recCities = Array.isArray(itinerary.cities) ? itinerary.cities : [];
  if (!days.length && !recCities.length) return;

  // 1. Collect restaurants and hidden finds to verify
  // Restaurants: only day-by-day picks are verified (recs restaurants stay as generated).
  const restaurants = [];
  for (const day of days) {
    if (!day || typeof day !== 'object') continue;
    const city = day.city || '';
    const dinnerName = extractRestaurantVenue(day.restaurant_suggestion);
    if (dinnerName) restaurants.push({ day, field: 'restaurant_suggestion', name: dinnerName, city });
    const breakfastName = extractRestaurantVenue(day.breakfast_suggestion);
    if (breakfastName) restaurants.push({ day, field: 'breakfast_suggestion', name: breakfastName, city });
  }
  // Hidden finds live at itinerary.hidden_finds (schedule) or cities[].hidden_finds (recs).
  // Hold a live object reference per gem so REPLACE mutates the itinerary in place either way.
  const gemRefs = [];
  if (isRecs) {
    for (const c of recCities) for (const g of (c.hidden_finds || [])) gemRefs.push({ obj: g, name: g.title, city: g.city || c.city });
  } else {
    for (const g of (itinerary.hidden_finds || [])) gemRefs.push({ obj: g, name: g.title, city: g.city });
  }
  const cities = isRecs
    ? [...new Set(recCities.map(c => c.city).filter(Boolean))]
    : [...new Set(days.map(d => d.city).filter(Boolean))];

  // One accommodation per city (these are live references into itinerary.accommodations,
  // so mutating them updates the itinerary in place).
  const accommodations = [];
  const seenAccomCities = new Set();
  for (const a of (itinerary.accommodations || [])) {
    if (!a || !a.city || seenAccomCities.has(a.city)) continue;
    seenAccomCities.add(a.city);
    accommodations.push(a);
  }

  if (!restaurants.length && !cities.length) return;

  // 2. Build verification prompt — structured so we can parse the response reliably
  const month = (() => {
    try { return new Date(formData.arrivalDate).toLocaleString('en-US', { month: 'long', year: 'numeric' }); }
    catch (_) { return formData.arrivalDate || ''; }
  })();

  const restaurantLines = restaurants.map((r, i) =>
    `R${i + 1} | ${r.city} | ${r.name}`
  ).join('\n');

  const accommodationLines = accommodations.map((a, i) =>
    `A${i + 1} | ${a.city} | ${a.name} | ${a.estimated_cost_per_night || ''} | ${a.recommended_type || ''}`
  ).join('\n');

  const gemLines = gemRefs.map((g, i) =>
    `G${i + 1} | ${g.city} | ${g.name}`
  ).join('\n');

  // Activity names already in the day-by-day — Perplexity must not propose these as gem
  // replacements. Activities are strings like "[Local Pick] Name — description", so strip
  // the tier prefix and take the text before the description separator.
  const stripTier = (s) => (s || '').replace(/^\s*\[[^\]]*\]\s*/, '');
  const activityName = (s) => stripTier(s).split('—')[0].split(' - ')[0].trim();
  const existingActivities = [];
  for (const day of days) {
    for (const slot of [day.morning, day.afternoon, day.evening, day.breakfast_suggestion, day.restaurant_suggestion]) {
      const name = activityName(slot);
      if (name) existingActivities.push(name);
    }
  }
  for (const c of recCities) {
    for (const a of (c.activities || [])) { if (a && a.name) existingActivities.push(a.name); }
  }
  const existingActivityList = [...new Set(existingActivities)].join(', ');

  // Traveler profile, used to bias gem verification + replacements toward their interests.
  const travelStyle = formData.travelStyle || formData.budgetTier || '';
  const interestList = (formData.interests && typeof formData.interests === 'object')
    ? Object.keys(formData.interests).join(', ')
    : '';
  const groupDesc = formData.groupSize ? `Group of ${formData.groupSize}` : (formData.travelParty || 'travelers');
  const profileTraits = [travelStyle, interestList].filter(Boolean).join(', ') || 'general interests';
  const travelerProfile = `Traveler profile: ${groupDesc} traveling ${profileTraits}. When evaluating gems and selecting replacements, prioritize picks that match these interests over generic sightseeing.`;

  const verificationPrompt = `
You are verifying travel recommendations for a ${formData.country} trip in ${month}.

RESTAURANTS TO VERIFY (web-search each one):
${restaurantLines || '(none)'}

ACCOMMODATIONS TO VERIFY (web-search each one):
${accommodationLines || '(none)'}

The itinerary already includes these activities by name. Do NOT suggest any of these as gem replacements: ${existingActivityList || '(none)'}

HIDDEN GEMS TO VERIFY (web-search each one):
${gemLines || '(none)'}

${travelerProfile}

For each item, respond on ONE LINE in EXACTLY this format:

For restaurants:
R[N] | OPEN | (no replacement needed)
R[N] | CLOSED | Replacement Name | neighbourhood | one line why it's a great substitute
R[N] | UNCERTAIN | (cannot confirm — leave as is)

For accommodations:
A[N] | OPEN | (confirmed operating)
A[N] | CLOSED | Replacement Name | property type | price range | one sentence why it's comparable
A[N] | UNCERTAIN | (cannot confirm — leave as is)
Replacement constraints: same city, same price tier (within 20%), same property type (masseria stays masseria, cave hotel stays cave hotel, boutique stays boutique), minimum 4-star reviews.

For hidden gems (prioritize matches to the traveler profile above; any replacement MUST be in the same city as the gem it replaces):
G[N] | VERIFIED | (no change needed)
G[N] | REPLACE | Replacement Venue Name | 8-word reason

Real places only. Web-search before answering. No hedging.
`.trim();

  const rawResult = await callPerplexity(
    env,
    'You are a travel fact-checker. Web-search every venue before responding. Return only the structured format requested — no prose, no preamble.',
    verificationPrompt,
    1400,
    false
  );

  if (!rawResult || typeof rawResult !== 'string') return;

  // 3. Parse the structured response and apply changes
  const lines = rawResult.split('\n').map(l => l.trim()).filter(Boolean);

  // Meal venues already in the itinerary — guards restaurant replacements from
  // re-introducing a duplicate. Accepted replacements are added back to the set so
  // two Perplexity swaps can't both introduce the same venue.
  const mealVenueSet = buildMealVenueSet(days);

  // Gems flagged for replacement in Phase 1; descriptions written by Claude in Phase 2.
  const gemReplacements = [];

  for (const line of lines) {
    const parts = line.split('|').map(p => p.trim());

    // Restaurant verification
    if (/^R\d+$/i.test(parts[0])) {
      const idx = parseInt(parts[0].slice(1), 10) - 1;
      const status = (parts[1] || '').toUpperCase();
      const entry = restaurants[idx];
      if (!entry) continue;

      if (status === 'CLOSED' && parts[2] && parts[2] !== '(no replacement needed)') {
        // Skip a replacement that would re-introduce a venue already in the itinerary
        // (Perplexity swaps bypass the MEAL VENUE UNIQUENESS prompt rule).
        if (mealVenueAlreadyUsed(parts[2], mealVenueSet)) {
          console.warn('[MEAL DEDUP] Skipped Perplexity replacement — venue already in itinerary:', parts[2]);
          continue;
        }
        // Rebuild the field string preserving original format prefix (Dinner:/Breakfast:)
        const original = entry.day[entry.field] || '';
        const prefixMatch = original.match(/^(Dinner|Lunch|Breakfast)\s*:/i);
        const prefix = prefixMatch ? prefixMatch[0] + ' ' : '';
        const neighbourhood = parts[3] || '';
        const why = normalizeCurrencyString(parts[4] || '');
        entry.day[entry.field] = `${prefix}${parts[2]}${neighbourhood ? ' | ' + neighbourhood : ''}${why ? ' — ' + why : ''}`;
        // Register the accepted replacement so later swaps can't duplicate it.
        mealVenueSet.add(parts[2].toLowerCase().trim());
        console.log(`Perplexity: replaced closed ${entry.name} → ${parts[2]} (${entry.city})`);
      }
      continue;
    }

    // Accommodation verification — swap permanently-closed properties for a comparable one
    if (/^A\d+$/i.test(parts[0])) {
      const idx = parseInt(parts[0].slice(1), 10) - 1;
      const status = (parts[1] || '').toUpperCase();
      const accom = accommodations[idx];
      if (!accom) continue;

      if (status === 'CLOSED' && parts[2] && parts[2] !== '(no replacement needed)') {
        const oldName = accom.name;
        accom.name = parts[2];
        if (parts[3]) accom.recommended_type = parts[3];
        if (parts[4]) accom.estimated_cost_per_night = normalizeCurrencyString(parts[4]);
        if (parts[5]) accom.why = parts[5];
        console.log(`Perplexity: replaced closed accommodation ${oldName} → ${accom.name} (${accom.city})`);
      }
      continue;
    }

    // Hidden gem verification — Phase 1: Perplexity flags which gems to replace (no descriptions)
    if (/^G\d+$/i.test(parts[0])) {
      const idx = parseInt(parts[0].slice(1), 10) - 1;
      const status = (parts[1] || '').toUpperCase();
      const gem = gemRefs[idx];
      if (!gem || !gem.obj) continue;
      if (status === 'REPLACE' && parts[2]) {
        const originalCity = gem.city || (gem.obj && gem.obj.city) || '';
        console.log(`Perplexity: gem flagged REPLACE "${gem.name}" → "${parts[2]}" (original city: ${originalCity || 'unknown'})`);
        // City boundary check — never swap in a cross-city replacement.
        if (!originalCity) {
          console.warn(`Perplexity: skipping gem replacement for "${gem.name}" — city could not be confirmed`);
          continue;
        }
        gemReplacements.push({ idx, venue: parts[2], city: originalCity });
      }
      continue;
    }
  }

  // Phase 2 — Claude writes the discovery cards (title + description) for the flagged venues.
  // Count stays flat; emoji and city are left unchanged. Fails silently — gems left as-is on error.
  if (gemReplacements.length) {
    try {
      // The customer uses each accommodation city as a homebase, so a gem may sit in a nearby
      // town. Detect a differing town from the venue name (comma, or a known trip city) so
      // Claude can add a "X minutes from your <base>" travel-time note.
      const gemCards = gemReplacements.map(g => {
        let venueName = g.venue;
        let gemCity = g.city;
        const ci = g.venue.indexOf(',');
        if (ci !== -1) {
          const namePart = g.venue.slice(0, ci).trim();
          const townPart = g.venue.slice(ci + 1).trim();
          if (namePart) venueName = namePart;
          if (townPart && townPart.toLowerCase() !== g.city.toLowerCase()) gemCity = townPart;
        } else {
          const alt = cities.find(c => c && c.toLowerCase() !== g.city.toLowerCase()
            && g.venue.toLowerCase().includes(c.toLowerCase()));
          if (alt) gemCity = alt;
        }
        return { ...g, venueName, gemCity, differs: gemCity.toLowerCase() !== g.city.toLowerCase() };
      });

      const venueListText = gemCards.map(g => g.differs
        ? `${g.city} area | ${g.gemCity} | ${g.venueName}`
        : `${g.city}: ${g.venueName}`
      ).join('\n');

      const gemWriterPrompt = `You are a hidden gems travel writer. Write discovery cards for the following venues. Each card needs:
- Title: the real, specific name of the venue — exactly as it is known locally (required). Never a descriptive phrase or thematic label. If the venue is "Hoppy Street Asakusa", the title must be "Hoppy Street Asakusa" or the venue's known local name — never "Showa-Era Drinking Lane Lives On" or any invented evocative phrase.
- Description: 2 sentences, max 35 words total. Capture WHY this is a genuine hidden find — the detail a local would know.

The customer stays in each accommodation city as a homebase. Venue lines are one of two formats:
- "Accommodation city: Venue" — the gem is in the accommodation city.
- "Accommodation city area | Venue town | Venue" — the gem is in a nearby town, reachable from the accommodation city.
If the venue city differs from the accommodation city, end the description with a natural phrase indicating its travel time from the base, e.g. '25 minutes from your Ostuni base' or 'just 20 minutes from Monopoli.' Keep the total description under 40 words including this phrase.

Traveler profile: ${groupDesc}, ${travelStyle || 'no specific style'}, interests: ${interestList || 'general'}

Format each response EXACTLY as:
VENUE_NAME | TITLE | DESCRIPTION

Venues:
${venueListText}`;

      const gemWriterRaw = await callClaude(env, gemWriterPrompt);
      if (gemWriterRaw && typeof gemWriterRaw === 'string') {
        for (const line of gemWriterRaw.split('\n').map(l => l.trim()).filter(Boolean)) {
          const gp = line.split('|').map(p => p.trim());
          if (gp.length < 3) continue;
          const venueName = gp[0], title = gp[1], description = gp[2];
          // Match Claude's card back to a flagged replacement by venue name.
          const match = gemCards.find(g => g.venueName.toLowerCase() === venueName.toLowerCase()
            || g.venue.toLowerCase() === venueName.toLowerCase());
          if (!match) continue;
          const itinGem = gemRefs[match.idx] && gemRefs[match.idx].obj;
          if (itinGem && title && description) {
            itinGem.title = title;
            itinGem.description = description;
            console.log(`Gem rewrite: "${match.venueName}" → "${title}" (${match.differs ? match.gemCity + ', drive from ' + match.city : match.city})`);
          }
        }
      }
    } catch (gemErr) {
      console.error('Gem rewrite (Phase 2) failed (continuing):', gemErr && gemErr.message);
    }
  }
}

// ── Book Before You Go validator ──────────────────────────────────────────────
// STEP 12 requires every activity/restaurant in book_before_you_go to already
// appear in the day-by-day plan. Logistics items (rail passes, IC cards,
// accommodation, flights, visas) are exempt. Everything else is removed if it
// cannot be found in the days array. Non-blocking — never throws.
function validateBookBeforeYouGo(itinerary) {
  if (!Array.isArray(itinerary.book_before_you_go) || !itinerary.book_before_you_go.length) return;
  if (!Array.isArray(itinerary.days) || !itinerary.days.length) return;

  // Keywords that identify logistics items — always keep these.
  const LOGISTICS_RE = /rail pass|jr pass|jrpass|suica|pasmo|ic card|oyster|navigo|visa|entry|passport|flight|airport|insurance|accommodation|hotel|ryokan|hostel|check.?in/i;

  // Build a searchable string from all day-by-day content
  const dayContent = itinerary.days.flatMap(day => [
    day.morning, day.afternoon, day.evening,
    day.breakfast_suggestion, day.restaurant_suggestion
  ]).filter(Boolean).join(' ').toLowerCase();

  const normalize = (s) => (s || '').toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

  const before = itinerary.book_before_you_go.length;
  itinerary.book_before_you_go = itinerary.book_before_you_go.filter(entry => {
    const name = entry.item_name || '';

    // Always keep logistics items
    if (LOGISTICS_RE.test(name) || LOGISTICS_RE.test(entry.booking_tip || '')) return true;

    // Always keep accommodation entries — match against accommodations array
    const accommodations = Array.isArray(itinerary.accommodations) ? itinerary.accommodations : [];
    if (accommodations.some(a => a.name && normalize(a.name).includes(normalize(name).split(' ')[0]))) return true;

    // For activities and restaurants: must appear in day-by-day content
    const normalName = normalize(name);
    // Extract key words (>3 chars) from the item name for matching
    const keyWords = normalName.split(/\s+/).filter(w => w.length > 3);
    if (!keyWords.length) return true; // can't validate — keep

    // Keep if any significant key word from the item name appears in day content
    const found = keyWords.some(w => dayContent.includes(w));
    if (!found) {
      console.log(`[bbyg-validate] Removed "${name}" — not found in day-by-day plan`);
    }
    return found;
  });

  const removed = before - itinerary.book_before_you_go.length;
  if (removed > 0) console.log(`[bbyg-validate] Removed ${removed} Book Before You Go item(s) not in day-by-day`);
}

// ── Hidden finds hard dedup ───────────────────────────────────────────────
// Backstop: removes any hidden find whose title is an exact substring match of
// a venue already used in the day-by-day plan or restaurants array.
// generateHiddenFinds already applies semantic dedup via its exclusion list,
// so this only catches exact duplicates that slipped through.
// Runs after Claude generation, before Perplexity verification.
function deduplicateHiddenFinds(itinerary) {
  const days = Array.isArray(itinerary.days) ? itinerary.days : [];

  // Collect all day-by-day venue name fragments (lowercase, stripped of tier labels)
  const stripTier = (s) => (s || '').replace(/^\s*\[[^\]]*\]\s*/, '').toLowerCase();
  const nameFragment = (s) => stripTier(s).split('—')[0].split(' - ')[0].split('·')[0].trim();

  const activityNames = new Set();
  for (const day of days) {
    for (const slot of [day.morning, day.afternoon, day.evening, day.breakfast_suggestion, day.restaurant_suggestion]) {
      const frag = nameFragment(slot);
      if (frag && frag.length > 3) activityNames.add(frag);
    }
  }

  // Also cross-check against the restaurants[] array — hidden finds must not duplicate
  // any venue already listed there (Breakfast, Cafe, Bakery, Lunch, Dinner, etc.)
  const restaurants = Array.isArray(itinerary.restaurants) ? itinerary.restaurants : [];
  for (const r of restaurants) {
    const frag = (r.name || '').toLowerCase().trim();
    if (frag && frag.length > 3) activityNames.add(frag);
  }

  if (!Array.isArray(itinerary.hidden_finds) || !activityNames.size) return;

  const before = itinerary.hidden_finds.length;
  itinerary.hidden_finds = itinerary.hidden_finds.filter(gem => {
    if (!gem || !gem.title) return true;
    const gemName = gem.title.toLowerCase().trim();
    for (const activity of activityNames) {
      // Exact substring containment only — generateHiddenFinds already handles semantic dedup.
      // Word-overlap matching caused false positives (e.g. "Arashiyama" matching a different
      // Arashiyama venue, "Nakamura" matching a different city's Nakamura venue).
      if (gemName.includes(activity) || activity.includes(gemName)) {
        console.log(`[dedup] Removed hidden find "${gem.title}" — exact match with day-by-day activity or restaurants list`);
        return false;
      }
    }
    return true;
  });

  const removed = before - itinerary.hidden_finds.length;
  if (removed > 0) console.log(`[dedup] Removed ${removed} duplicate hidden find(s)`);
}

// ── Post-generation tier-badge validation ────────────────────────────────────
// The prompt requires every non-N/A morning/afternoon/evening slot to begin with
// a tier badge ([Iconic]/[Local Pick]/[Hidden Gem]), but the model occasionally
// drops them. This scans the generated days and returns the slots missing a badge
// so we can log visibility. Non-blocking — never throws, never mutates.
function validateTierBadges(days) {
  const validTiers = new Set(['Iconic', 'Local Pick', 'Hidden Gem']);
  const badgePrefixes = ['[Iconic]', '[Local Pick]', '[Hidden Gem]'];
  const missing = [];

  for (const day of days) {
    for (const slot of ['morning', 'afternoon', 'evening']) {
      const content = day[slot];
      if (!content) continue;
      // Skip N/A slots
      if (typeof content === 'string' && content.trim().toUpperCase().startsWith('N/A')) continue;
      if (typeof content === 'object' && content.description &&
          content.description.trim().toUpperCase().startsWith('N/A')) continue;
      // Skip relaxed-pace free afternoon slots — intentional per PACE STRUCTURE, no badge required
      if (typeof content === 'string' && content.trim().toLowerCase().startsWith('free afternoon')) continue;
      if (typeof content === 'object' && content.description &&
          content.description.trim().toLowerCase().startsWith('free afternoon')) continue;

      const text = typeof content === 'string' ? content :
                   (content.description || content.name || '');
      if (text.length <= 5) continue;

      // New system: check the separate _tier field. Legacy fallback: check string prefix.
      const tierField = day[`${slot}_tier`];
      const hasTier = validTiers.has(tierField) || badgePrefixes.some(b => text.includes(b));

      if (!hasTier) {
        missing.push({ date: day.date, slot });
      }
    }
  }

  if (missing.length > 0) {
    console.warn('[BADGE VALIDATION] Missing tier badges:', JSON.stringify(missing));
  }

  return missing;
}

// ── DAY-OF-WEEK VENUE VALIDATOR ─────────────────────────────────────────────
// STEP 16 backstop: a venue whose NAME contains a weekday ("Sunday Market",
// "Saturday Walking Street") is a hard scheduling constraint. If it lands on a
// different weekday, the traveler gets sent to a market that isn't running.
// Activity slots are REPLACED with a safe free-slot line; meal suggestions are
// logged only (removing a meal would leave a visible gap in the render).
const DOW_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
function validateDayOfWeekVenues(days) {
  const notes = [];
  if (!Array.isArray(days)) return notes;
  const dowRe = /\b(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i;
  days.forEach(day => {
    const t = Date.parse(day && day.date);
    if (isNaN(t)) return;
    const actualDow = new Date(t).getUTCDay(); // YYYY-MM-DD parses as UTC midnight
    ['morning', 'afternoon', 'evening'].forEach(slot => {
      const text = day[slot];
      if (typeof text !== 'string') return;
      const m = text.match(dowRe);
      if (!m) return;
      const namedDow = DOW_NAMES.indexOf(m[1].toLowerCase());
      if (namedDow === actualDow) return;
      notes.push(`${day.date} is a ${DOW_NAMES[actualDow]} but ${slot} names ${m[1]}: "${text.substring(0, 70)}" — slot replaced`);
      day[slot] = slot === 'evening'
        ? 'Evening at leisure — explore the neighbourhood\'s night scene at your own pace.'
        : 'Free ' + slot + ' — rest, explore at your own pace, or revisit somewhere you loved.';
      delete day[slot + '_tier']; // free slots carry no tier badge
    });
    ['restaurant_suggestion', 'breakfast_suggestion'].forEach(meal => {
      const text = day[meal];
      if (typeof text !== 'string') return;
      const m = text.match(dowRe);
      if (m && DOW_NAMES.indexOf(m[1].toLowerCase()) !== actualDow) {
        notes.push(`${day.date} (${DOW_NAMES[actualDow]}) ${meal} names ${m[1]} — left in place, review: "${text.substring(0, 70)}"`);
      }
    });
  });
  return notes;
}

// ── DAILY BUDGET SANITY CHECK (log-only) ────────────────────────────────────
// The prompt's DAILY BUDGET CONSISTENCY rule is judgment-based and occasionally
// ignored. This is the codeable slice: a day's budget low end that can't even
// cover that city's own accommodation nightly low end is provably understated.
// Visibility only — we log and ship; mutating customer-facing prices in code
// risks making them wrong in the other direction.
function parseCostLow(str) {
  if (typeof str !== 'string') return null;
  const m = str.replace(/,/g, '').match(/(\d+(?:\.\d+)?)/);
  return m ? parseFloat(m[1]) : null;
}
function validateDailyBudgets(itinerary) {
  const notes = [];
  const days = Array.isArray(itinerary && itinerary.days) ? itinerary.days : [];
  const accoms = Array.isArray(itinerary && itinerary.accommodations) ? itinerary.accommodations : [];
  if (!days.length || !accoms.length) return notes;
  const hotelLowByCity = {};
  accoms.forEach(a => {
    const low = parseCostLow(a.estimated_cost_per_night);
    if (a.city && low != null) hotelLowByCity[String(a.city).toLowerCase()] = low;
  });
  days.forEach(day => {
    const dayLow = parseCostLow(day.estimated_daily_cost);
    const hotelLow = hotelLowByCity[String(day.city || '').toLowerCase()];
    if (dayLow != null && hotelLow != null && dayLow < hotelLow) {
      notes.push(`${day.date} (${day.city}): daily cost low ${dayLow} < accommodation nightly low ${hotelLow} — budget understated`);
    }
  });
  return notes;
}

// ── CITY PLAN VALIDATOR ─────────────────────────────────────────────────────
// Inline copy of city-plan-validator.js (browser runs the same logic after every
// preview parse). KEEP THE TWO IN SYNC. Deterministic enforcement of the
// arrival/departure-city night rules — prompt compliance alone is probabilistic,
// and in the paid flow the prompt's STEP 1/2 rules are skipped entirely whenever
// an approved city plan exists. This is the backstop that actually guarantees:
//   · arrival city present with ≥1 night (inserted as first stop if missing)
//   · departure city present with ≥1 night on one-way trips (appended if missing)
//   · nights sum to the trip's total nights
// POSITION IS ENFORCED: arrival city must be the FIRST stop (moved if mid-route);
// on one-way trips the departure city must be the FINAL stop. Round trips: the trip
// must OPEN in the arrival city — if it appears only as the loop-closing final stop,
// a separate 1-night opening stay is inserted (renderer supports repeat city cards).
// The loop-closing stop itself belongs to the ROUND-TRIP ROUTING directive
// (airport-adjacent towns are legitimate there).
const cpvNorm = (s) => String(s || '')
  .toLowerCase()
  .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]/g, '');

function cpvCityMatch(a, b) {
  const na = cpvNorm(a), nb = cpvNorm(b);
  if (!na || !nb) return false;
  return na === nb || na.indexOf(nb) === 0 || nb.indexOf(na) === 0;
}

// Traveler notes outrank the arrival/departure defaults. REPAIR SUPPRESSOR, not
// decision-maker: the model builds the plan from the notes; this only stops us
// re-inserting a city the traveler plausibly opted out of ("skip Hong Kong",
// "no overnight in HK", "straight to Guilin"). False positives are safe — we
// just defer to the model. City refs: full name, initials ("hong kong" → "hk"),
// and the city-specific airport code. Opt-out + ref must share a sentence.
const CPV_INITIALS_STOPLIST = ['no', 'to', 'in', 'on', 'at', 'so', 'do', 'be', 'me', 'my', 'we', 'us', 'an', 'as', 'by', 'of', 'or', 'up', 'if', 'it', 'la', 'st', 'de'];
const cpvEscRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const CPV_OPT_OUT_RE = /\b(skip|pass(ing)? through|transit only|layover only|no stop(s)?|straight to|directly to)\b|\b(no|not|don'?t|do not|avoid|without|zero)\b[^.;!?\n]{0,40}\b(overnight(s)?|stay(ing|s)?|night(s)?|sleep(ing)?|stop(ping)?)\b/;

function cpvTravelerSkips(cityName, fd) {
  const text = ((fd.mustSee || '') + '. ' + (fd.extraNotes || '')).toLowerCase();
  if (!cityName || !text.trim()) return false;
  const name = String(cityName).toLowerCase().trim();
  const words = name.split(/\s+/).filter(Boolean);
  const refs = [name];
  if (words.length > 1) {
    const initials = words.map(w => w[0]).join('');
    if (initials.length >= 2 && CPV_INITIALS_STOPLIST.indexOf(initials) === -1) refs.push(initials);
  }
  if (cpvCityMatch(cityName, fd.arrivalCityName) && typeof fd.arrivalAirport === 'string' && fd.arrivalAirport.trim().length === 3) {
    refs.push(fd.arrivalAirport.trim().toLowerCase());
  }
  if (cpvCityMatch(cityName, fd.departureCityName) && typeof fd.departureAirport === 'string' && fd.departureAirport.trim().length === 3) {
    refs.push(fd.departureAirport.trim().toLowerCase());
  }
  return text.split(/[.;!?\n]+/).some(sentence =>
    CPV_OPT_OUT_RE.test(sentence) && refs.some(r => r.length >= 2 && new RegExp('\\b' + cpvEscRe(r) + '\\b').test(sentence))
  );
}

function validateAndRepairCityPlan(cities, formData) {
  const notes = [];
  if (!Array.isArray(cities) || cities.length === 0) {
    return { changed: false, notes: ['empty or missing cities array — validation skipped'] };
  }
  const fd = formData || {};
  const arrCity = fd.arrivalCityName || null;
  const depCity = fd.departureCityName || null;
  const isRoundTrip = !!(arrCity && depCity && cpvCityMatch(arrCity, depCity));
  let changed = false;

  cities.forEach(c => {
    const n = Number(c.nights);
    c.nights = isFinite(n) && n > 0 ? n : 0;
  });

  const nameOf = (c) => c.city || c.name || '';
  const findIdx = (name) => {
    for (let i = 0; i < cities.length; i++) {
      if (cpvCityMatch(nameOf(cities[i]), name)) return i;
    }
    return -1;
  };
  const stealNight = (protectedIdxs) => {
    let idx = -1, best = 1;
    cities.forEach((c, i) => {
      if (protectedIdxs.indexOf(i) !== -1) return;
      if (c.nights > best) { best = c.nights; idx = i; }
    });
    if (idx >= 0) { cities[idx].nights -= 1; return true; }
    return false;
  };

  if (arrCity && !cpvTravelerSkips(arrCity, fd)) {
    let ai = findIdx(arrCity);
    if (ai === -1) {
      cities.unshift({
        city: arrCity,
        nights: 1,
        why_recommended: 'Your arrival city — a first night to land, clear customs, and settle in before the trip begins.'
      });
      stealNight([0]);
      changed = true;
      notes.push('inserted missing arrival city "' + arrCity + '" as first stop (1 night)');
    } else if (ai !== 0) {
      if (isRoundTrip && ai === cities.length - 1 && cities.length > 1) {
        // Round trip where the arrival city appears only as the loop-closing
        // final stop: keep that closer intact and add a separate opening stay
        // (the renderer supports repeat city cards on round trips).
        cities.unshift({
          city: arrCity,
          nights: 1,
          why_recommended: 'Your arrival city — a first night to land and settle in before the loop begins.'
        });
        stealNight([0, cities.length - 1]);
        changed = true;
        notes.push('added opening 1-night stay in round-trip arrival city "' + arrCity + '"');
      } else {
        // Mid-route arrival city — move it to the front; relative order of the
        // other stops is unchanged.
        const entry = cities.splice(ai, 1)[0];
        cities.unshift(entry);
        changed = true;
        notes.push('moved arrival city "' + arrCity + '" to first stop');
      }
    }
    if (cities[0].nights < 1 && cpvCityMatch(nameOf(cities[0]), arrCity)) {
      cities[0].nights = 1;
      stealNight([0]);
      changed = true;
      notes.push('raised arrival city "' + arrCity + '" to 1 night');
    }
  }

  if (depCity && !isRoundTrip && !cpvTravelerSkips(depCity, fd)) {
    const di = findIdx(depCity);
    if (di === -1) {
      cities.push({
        city: depCity,
        nights: 1,
        why_recommended: 'Your departure city — a final night nearby so the flight home is never a cross-country race.'
      });
      stealNight([cities.length - 1]);
      changed = true;
      notes.push('appended missing departure city "' + depCity + '" as final stop (1 night)');
    } else {
      if (di !== cities.length - 1) {
        // Mid-route departure city — move it to the end; relative order of the
        // other stops is unchanged.
        const entry = cities.splice(di, 1)[0];
        cities.push(entry);
        changed = true;
        notes.push('moved departure city "' + depCity + '" to final stop');
      }
      const last = cities.length - 1;
      if (cities[last].nights < 1 && cpvCityMatch(nameOf(cities[last]), depCity)) {
        cities[last].nights = 1;
        stealNight([last]);
        changed = true;
        notes.push('raised departure city "' + depCity + '" to 1 night');
      }
    }
  }

  const totalNights = calcNights(fd.arrivalDate, fd.departureDate) || null;
  const allInts = cities.every(c => c.nights === Math.round(c.nights));
  if (totalNights && allInts) {
    let sum = cities.reduce((n, c) => n + c.nights, 0);
    let guard = 50;
    const protectedIdxs = [];
    if (arrCity) { const i = findIdx(arrCity); if (i !== -1) protectedIdxs.push(i); }
    if (depCity) { const i = findIdx(depCity); if (i !== -1) protectedIdxs.push(i); }
    while (sum > totalNights && guard-- > 0) {
      if (!stealNight(protectedIdxs) && !stealNight([])) break;
      sum -= 1; changed = true;
    }
    if (sum < totalNights) {
      let idx = 0, best = -1;
      cities.forEach((c, i) => { if (c.nights > best) { best = c.nights; idx = i; } });
      cities[idx].nights += (totalNights - sum);
      changed = true;
    }
    const finalSum = cities.reduce((n, c) => n + c.nights, 0);
    if (finalSum !== totalNights) {
      notes.push('warning: nights sum ' + finalSum + ' still != trip nights ' + totalNights + ' (left for model output)');
    } else if (changed) {
      notes.push('rebalanced nights to sum to ' + totalNights);
    }
  }

  return { changed, notes };
}
// ── END CITY PLAN VALIDATOR ─────────────────────────────────────────────────

// Runs in the queue consumer after a confirmed payment: pull form data from KV,
// generate the itinerary directly via Claude, then hand the parsed JSON to Make.
async function fulfillOrder(env, session) {
  try {
    // Idempotency guard — a retry (or duplicate queue delivery) must not double-deliver.
    const sessionId = session && session.id;
    if (sessionId && await env.PREVIEW_STORE.get(`done:${sessionId}`)) {
      console.log('[fulfillOrder] Already completed, skipping session:', sessionId);
      return;
    }

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

    // Section-select: what the traveler asked for (default to all four for old orders).
    const selectedSections = (Array.isArray(formData.selectedSections) && formData.selectedSections.length)
      ? formData.selectedSections
      : ['day_by_day', 'accommodations', 'transportation', 'food'];
    const flags = {
      wantDayByDay: selectedSections.includes('day_by_day'),
      wantAccommodations: selectedSections.includes('accommodations'),
      wantTransportation: selectedSections.includes('transportation'),
    };

    // Server-side backstop: re-validate the approved city plan before spending a
    // full generation on it. The plan is client-supplied (built at preview time) —
    // this guarantees arrival/departure night coverage even if the preview-side
    // check was bypassed, stale, or the order predates the validator. Old orders
    // without arrivalCityName/departureCityName no-op gracefully.
    if (Array.isArray(approvedCities) && approvedCities.length) {
      try {
        const repair = validateAndRepairCityPlan(approvedCities, formData);
        if (repair.changed) console.warn('[CITY PLAN] repaired before generation:', repair.notes.join(' · '));
      } catch (vErr) {
        console.error('[CITY PLAN] validator error (continuing with plan as-is):', vErr && vErr.message);
      }
    }

    // Generate the full itinerary directly via Claude (no longer done in Make).
    const itinerary = await generateItinerary(env, { ...formData, approvedCities, teaserDay, selectedSections, flags });
    if (itinerary && itinerary.error) {
      console.error('Itinerary generation failed for session', session.id, '-', itinerary.message);
      await sendFailureAlert(env, session, itinerary.message);
      return; // stop — do not render or POST a broken itinerary to n8n
    } else {
      // Hard dedup — remove hidden finds that duplicate day-by-day activities
      deduplicateHiddenFinds(itinerary);

      // Strip Book Before You Go entries not present in the day-by-day plan (STEP 12 backstop)
      validateBookBeforeYouGo(itinerary);

      // Weekday-named venues on wrong dates → replace slot + log (STEP 16 backstop)
      const dowNotes = validateDayOfWeekVenues(itinerary.days);
      if (dowNotes.length) console.warn('[DOW VALIDATION] ' + dowNotes.join(' | '));

      // Daily budget vs own accommodation — visibility only
      const budgetNotes = validateDailyBudgets(itinerary);
      if (budgetNotes.length) console.warn('[BUDGET VALIDATION] ' + budgetNotes.join(' | '));

      // Visibility only — flag activity slots the model left without a tier badge.
      // Non-blocking: we log and still ship so the traveler always gets an itinerary.
      if (Array.isArray(itinerary.days) && itinerary.days.length) {
        const missingBadges = validateTierBadges(itinerary.days);
        const totalSlots = itinerary.days.length * 3;
        if (totalSlots > 0 && missingBadges.length / totalSlots > 0.15) {
          const pct = Math.round((missingBadges.length / totalSlots) * 100);
          console.warn(`[BADGE VALIDATION] ${missingBadges.length}/${totalSlots} activity slots (${pct}%) missing tier badges — session ${session.id}`);
        }
      }

      // ── Post-gen Perplexity verification ────────────────────────────────────
      // Web-checks Claude's restaurant, accommodation, and hidden gem picks,
      // replacing closed venues and low-quality/stale gems in place (count
      // stays flat). Isolated — any failure leaves the itinerary intact and
      // still ships.
      if (env.USE_PERPLEXITY === 'true') {
        try {
          await verifyAndEnrichWithPerplexity(env, itinerary, formData);
        } catch (pErr) {
          console.error('Perplexity verification failed (continuing):', pErr && pErr.message);
        }
      } else {
        // Loud and unmissable in `wrangler tail`: with verification off, closed
        // venues, stale locations, and invented hidden finds ship unchecked.
        console.warn('[VERIFY] USE_PERPLEXITY is OFF — venue verification and hidden-finds fact-checking were SKIPPED for session', session.id);
      }

      // Enrich day-by-day venues with Google Places (v1) before sending. Isolated
      // so any enrichment failure leaves the itinerary intact and still ships.
      try {
        await enrichItineraryWithPlaces(env, itinerary);
      } catch (enrichErr) {
        console.error('Places enrichment failed (continuing unenriched):', enrichErr && enrichErr.message);
      }
    }

    // ── TASK 4: Generate and store itinerary HTML page ──
    const itineraryId = Math.random().toString(36).substring(2, 12);
    const itineraryHtml = renderItinerary({ ...formData, approvedCities }, itinerary);
    await env.PREVIEW_STORE.put(`itinerary_${itineraryId}`, itineraryHtml, { expirationTtl: 60 * 60 * 24 * 365 });
    const itineraryUrl = `https://bws-travel-proxy.springlam-co.workers.dev/itinerary/${itineraryId}`;
    // ── END TASK 4 ──

    // Ready-to-use "What's inside" bullets for the n8n delivery email — dynamic by section
    // so recs-only orders don't advertise a day-by-day plan they didn't get.
    const cityCount = (Array.isArray(itinerary.cities) && itinerary.cities.length)
      ? itinerary.cities.length
      : (Array.isArray(approvedCities) ? approvedCities.length : 0);
    const whatsInside = [];
    whatsInside.push(flags.wantDayByDay
      ? 'Day-by-day plan with morning, afternoon & evening'
      : `City-by-city activity & restaurant guide${cityCount ? ' for ' + cityCount + ' cities' : ''}`);
    if (selectedSections.includes('food')) whatsInside.push('Restaurant guide with ratings & Google Maps links');
    if (flags.wantAccommodations) whatsInside.push('Accommodation picks by neighbourhood');
    if (flags.wantTransportation) whatsInside.push('Transport between cities with booking links');
    whatsInside.push("Hidden Finds — handpicked spots you wouldn't find on your own");
    whatsInside.push('Book Before You Go — sorted by urgency');
    whatsInside.push('Practical info, visa, currency & emergency contacts');

    // Normalize hidden finds across Mode A (top-level array) and Mode B (nested in cities)
    const allFinds = itinerary.mode === 'recs'
      ? (itinerary.cities || []).flatMap(c => c.hidden_finds || [])
      : (itinerary.hidden_finds || []);
    const teaserFinds = allFinds.slice(0, 3);
    const hiddenFindsTeaserHtml = teaserFinds.map(f => `
  <div style="display:flex;gap:14px;align-items:flex-start;background:#f5f3ff;border:1px solid #ddd6fe;border-radius:10px;padding:14px 16px;margin-bottom:10px;">
    <div style="font-size:22px;line-height:1.2;flex-shrink:0;">${f.emoji || '💎'}</div>
    <div>
      <div style="font-size:14px;font-weight:700;color:#5b21b6;margin-bottom:4px;">${f.title || ''}</div>
      <div style="font-size:13px;color:#374151;line-height:1.5;">${f.description || ''}</div>
    </div>
  </div>`).join('');

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
      itineraryUrl,
      whatsInside,
      hiddenFindsTeaserHtml,
    };

    let delivered = false;
    try {
      // Retry the n8n delivery up to 3 times: wait 3s before attempt 2, 6s before attempt 3.
      // Retries on both non-ok responses and network errors; the final response/error
      // falls through to the existing failure handling below.
      let makeResponse = null;
      let lastErr = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        if (attempt > 1) {
          await new Promise(r => setTimeout(r, attempt === 2 ? 3000 : 6000));
        }
        try {
          makeResponse = await fetch(env.N8N_WEBHOOK_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(makePayload)
          });
          lastErr = null;
          if (makeResponse.ok) break;
        } catch (fetchErr) {
          lastErr = fetchErr;
          makeResponse = null;
        }
      }
      if (lastErr) throw lastErr;
      delivered = makeResponse.ok;
      if (!makeResponse.ok) {
        console.error('n8n webhook failed:', makeResponse.status, await makeResponse.text());
        await sendFailureAlert(env, session, `n8n delivery failed with status ${makeResponse.status}`);
      }
    } catch (makeErr) {
      console.error('Make webhook error:', makeErr.message);
      await sendFailureAlert(env, session, `n8n delivery failed: ${makeErr.message}`);
    }

    // Mark complete only if delivery to n8n succeeded, so a failed delivery stays
    // retryable via /admin/retry (the guard above skips only truly-delivered sessions).
    if (sessionId && delivered) {
      await env.PREVIEW_STORE.put(`done:${sessionId}`, '1', { expirationTtl: 60 * 60 * 24 * 7 });
    }
  } catch (err) {
    console.error('fulfillOrder error:', err.message);
    await sendFailureAlert(env, session, err.message);
  }
}