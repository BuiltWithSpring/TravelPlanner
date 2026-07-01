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
        // selectedSections is our own field for section-select logic — strip it so it's
        // never forwarded to Anthropic (unrecognised fields cause a 400).
        const { selectedSections, ...body } = sanitizeDeep(await request.json());

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
        const teaser = previewData.teaser_day || null;
        const teaserLabel = teaser ? (teaser.title || teaser.day || 'Day 1') : '';
        const teaserMorning = teaser ? (teaser.morning || '') : '';
        const teaserAfternoon = teaser ? (teaser.afternoon || '') : '';
        const teaserEvening = teaser ? (teaser.evening || '') : '';

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

        // Teaser day rows
        const teaserRows = [
          teaserMorning ? `<tr><td style="padding:6px 0;vertical-align:top;"><span style="font-size:15px;">🌅</span></td><td style="padding:6px 0 6px 10px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:14px;color:#3d3660;line-height:1.5;"><strong style="color:#0f0c1e;">Morning</strong> — ${teaserMorning}</td></tr>` : '',
          teaserAfternoon ? `<tr><td style="padding:6px 0;vertical-align:top;"><span style="font-size:15px;">☀️</span></td><td style="padding:6px 0 6px 10px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:14px;color:#3d3660;line-height:1.5;"><strong style="color:#0f0c1e;">Afternoon</strong> — ${teaserAfternoon}</td></tr>` : '',
          teaserEvening ? `<tr><td style="padding:6px 0;vertical-align:top;"><span style="font-size:15px;">🌙</span></td><td style="padding:6px 0 6px 10px;font-family:'DM Sans',Helvetica,Arial,sans-serif;font-size:14px;color:#3d3660;line-height:1.5;"><strong style="color:#0f0c1e;">Evening</strong> — ${teaserEvening}</td></tr>` : '',
        ].filter(Boolean).join('');

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

    <!-- Teaser day -->
    ${teaserRows ? `
    <p style="margin:0 0 12px;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:13px;font-weight:600;color:#7c3aed;text-transform:uppercase;letter-spacing:0.06em;">A taste of what's inside</p>
    ${teaserLabel ? `<p style="margin:0 0 12px;font-family:'Space Grotesk',Helvetica,Arial,sans-serif;font-size:16px;font-weight:700;color:#0f0c1e;">📍 ${teaserLabel}${cityNames[0] ? ` · ${cityNames[0]}` : ''}</p>` : ''}
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:28px;">
      ${teaserRows}
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

function parseBadge(text) {
  const m = String(text || '').match(/^\[(Iconic|Local Pick|Hidden Gem)\]\s*/);
  if (!m) return { cls: '', label: '', body: esc(text) };
  const map = { 'Iconic': ['badge-iconic','Iconic'], 'Local Pick': ['badge-local','Local Pick'], 'Hidden Gem': ['badge-hidden','Hidden Gem'] };
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
  const ci = text.indexOf(':');
  if (ci === -1) return { label: 'Meal', name: text, neighborhood: '', desc: '' };
  const label = text.slice(0, ci).trim();
  const parts = text.slice(ci + 1).split('|').map(p => p.trim());
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
  const staticMapUrl = cityOrder.length
    ? `https://bws-travel-proxy.springlam-co.workers.dev/static-map?cities=${cityOrder.map(encodeURIComponent).join(',')}`
    : '';

  // ── Cities section (from accommodations) ──
  // Group accommodations by city (preserve first-seen order) so each city renders as ONE
  // card. Claude returns up to two hotels per city; list them as Option 1 / Option 2.
  const cityAccomGroups = [];
  for (const a of accommodations) {
    if (!a || !a.city) continue;
    let g = cityAccomGroups.find(x => x.city === a.city);
    if (!g) { g = { city: a.city, hotels: [] }; cityAccomGroups.push(g); }
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
    // Use accommodation checkout for accurate night count + date range end
    const cityAccom = accommodations.find(a => a.city === group.city);
    const checkoutDate = cityAccom ? cityAccom.checkout : (() => {
      const d = new Date(group.days[group.days.length - 1].date);
      d.setDate(d.getDate() + 1);
      return d.toISOString().split('T')[0];
    })();
    const nightsInCity = cityAccom
      ? (calcNights(cityAccom.checkin, cityAccom.checkout) || group.days.length)
      : group.days.length;
    const dateRange = `${formatDateLong(firstDay.date)} – ${formatDateLong(checkoutDate)}`;

    const daysHtml = group.days.map(day => {
      const morning = parseBadge(day.morning);
      const afternoon = parseBadge(day.afternoon);
      const evening = parseBadge(day.evening);
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
        <div class="slot"><div class="slot-label">Morning</div><div class="slot-body">${slotHtml(morning)}</div></div>
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
        <strong>Check-in:</strong> ${esc(formatDateLong(a.checkin))} &nbsp;·&nbsp; <strong>Check-out:</strong> ${esc(formatDateLong(a.checkout))}${n ? ` &nbsp;·&nbsp; <strong>${n} nights</strong>` : ''} &nbsp;·&nbsp; <strong>Per night:</strong> ${esc(a.estimated_cost_per_night)}
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
      <td>${esc(b.booking_tip)}${b.booking_link ? `<br><a class="aff" target="_blank" rel="noopener noreferrer" href="${esc(b.booking_link)}">Book →</a>` : ''}</td>
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

  /* ── Download bar (screen only) ────────────────── */
  .dl-bar { max-width: 820px; margin: 0 auto; padding: 24px 48px 0; }
  .print-btn {
    display: block;
    width: 100%;
    background: #7c3aed;
    color: #ffffff;
    font-family: inherit;
    font-weight: 700;
    font-size: 14px;
    padding: 14px;
    border: none;
    border-radius: 8px;
    cursor: pointer;
  }
  .print-btn:hover { background: #6d28d9; }
  .print-hint { font-size: 12px; color: var(--muted); text-align: center; margin: 8px 0 0; }

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
    .dl-bar, .print-btn, .print-hint { display: none !important; }
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
<div class="dl-bar screen-only">
  <button class="print-btn" type="button" onclick="window.print()">⬇ Download as PDF</button>
  <p class="print-hint">In the print dialog, choose 'Save as PDF'</p>
</div>
<div class="page intro-page">
  <div class="logo">Built<span class="spring">WithSpring</span></div>
  <div class="cover-eyebrow">Your Personalized Recommendations</div>
  <h1 class="intro-country">${esc(country)}</h1>
  <div class="cover-name">Prepared for ${esc(firstName)}</div>
  <div class="cover-meta intro-meta">
    <div><div class="label">Arrival</div><div class="value">${esc(formatDateLong(arrivalDate))}</div></div>
    <div><div class="label">Departure</div><div class="value">${esc(formatDateLong(departureDate))}</div></div>
    <div><div class="label">Duration</div><div class="value">${totalNights} nights</div></div>
  </div>
  <h2 class="intro-subhead">Your Cities</h2>
  ${recsCityRows}
  <h2 class="intro-subhead spaced">Trip Overview</h2>
  <div class="card card-accent intro-overview"><p class="lead">${esc(overview)}</p></div>
</div>
<div class="page section">
  <h2 class="section-header">Best of Your Trip</h2>
  <p class="section-sub">A city-by-city stack of everything worth your time — no fixed schedule.</p>
  ${recsCitiesHtml}
  <p class="disclaimer">Hours and availability verified at time of generation — confirm before visiting.</p>
</div>
${gettingAroundHtml}
${accommodations.length ? `<div class="page section">
  <h2 class="section-header">Accommodation Picks</h2>
  ${accommodationsHtml}
</div>` : ''}
${book_before_you_go.length ? `<div class="page section">
  <h2 class="section-header">Book Before You Go</h2>
  <table><thead><tr><th>What to book</th><th>When</th><th>Why it matters</th><th>Est. cost</th></tr></thead>
  <tbody>${bookRowsHtml}</tbody></table>
</div>` : ''}
<div class="page section">
  <h2 class="section-header">Practical &amp; Emergency Info</h2>
  ${practicalCards}
  <div class="footer-note screen-only">BuiltWithSpring · Crafted for your trip · Affiliate links help support this service at no extra cost to you.</div>
</div>
</body></html>`;
  }

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
<div class="dl-bar screen-only">
  <button class="print-btn" type="button" onclick="window.print()">⬇ Download as PDF</button>
  <p class="print-hint">In the print dialog, choose 'Save as PDF'</p>
</div>
<div class="page intro-page">
  <div class="logo">Built<span class="spring">WithSpring</span></div>
  <div class="cover-eyebrow">Your Personalized Itinerary</div>
  <h1 class="intro-country">${esc(country)}</h1>
  <div class="cover-name">Prepared for ${esc(firstName)}</div>
  <div class="cover-meta intro-meta">
    <div><div class="label">Arrival</div><div class="value">${esc(formatDateLong(arrivalDate))}</div></div>
    <div><div class="label">Departure</div><div class="value">${esc(formatDateLong(departureDate))}</div></div>
    <div><div class="label">Duration</div><div class="value">${totalNights} nights</div></div>
  </div>
  <h2 class="intro-subhead">Your Cities</h2>
  ${cityRowsHtml}
  ${staticMapUrl ? `<img class="route-map" alt="${esc(country)} route map" src="${esc(staticMapUrl)}">` : ''}
  <h2 class="intro-subhead spaced">Trip Overview</h2>
  <div class="card card-accent intro-overview"><p class="lead">${esc(overview)}</p></div>
</div>
<div class="page section">
  <h2 class="section-header">Day-by-Day Plan</h2>
  ${dayByDayHtml}
  <p class="disclaimer">Hours and availability verified at time of generation — confirm before visiting.</p>
</div>
${hidden_finds.length ? `<div class="page section">
  <h2 class="section-header">Hidden Finds</h2>
  <p class="section-sub">Places you almost certainly wouldn't have found on your own.</p>
  <div class="finds-grid">${hiddenFindsHtml}</div>
</div>` : ''}
${restaurants.length ? `<div class="page section">
  <h2 class="section-header">Restaurants</h2>
  <p class="section-sub">Extra dining options beyond your day-by-day picks, grouped by city.</p>
  ${restaurantsHtml}
  <p class="disclaimer">Hours and availability verified at time of generation — confirm before visiting.</p>
</div>` : ''}
${accommodations.length ? `<div class="page section">
  <h2 class="section-header">Accommodation Picks</h2>
  ${accommodationsHtml}
</div>` : ''}
${transport.length ? `<div class="page section">
  <h2 class="section-header">Transport Between Cities</h2>
  ${transportHtml}
</div>` : ''}
${book_before_you_go.length ? `<div class="page section">
  <h2 class="section-header">Book Before You Go</h2>
  <table><thead><tr><th>What to book</th><th>When</th><th>Why it matters</th><th>Est. cost</th></tr></thead>
  <tbody>${bookRowsHtml}</tbody></table>
</div>` : ''}
<div class="page section">
  <h2 class="section-header">Practical &amp; Emergency Info</h2>
  ${practicalCards}
  <div class="footer-note screen-only">BuiltWithSpring · Crafted for your trip · Affiliate links help support this service at no extra cost to you.</div>
</div>
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
${perplexityResearch ? `
CURRENT DESTINATION RESEARCH
Real-time research from travel blogs, review sites, and local guides.
Use named restaurants, activities, and hidden gems from this research throughout the itinerary — prioritise these specific places over generic suggestions.
For any city where research is missing, use your best training knowledge — do not flag the gap.
Match each "### [City]" section below to that city's day-by-day and restaurants output.

${perplexityResearch}
──────────────────────────────────────────────
` : ''}
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
- Every city must also have city_teaser: ONE evocative sentence (~15 words) on what makes this city special on this trip — sensory and specific, never logistical. Example: "Ancient canal town where silk weaving and garden culture meet."

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
- Regular days → restaurant_suggestion must always be DINNER. Name a specific, real, well-regarded dinner restaurant suited to that city's evening. Lunch is never the restaurant_suggestion unless the traveler has an explicit half-day or no evening activity in that city. Label clearly as Dinner. Breakfast is handled separately — see below.
- Day trip days → restaurant_suggestion must always be a DINNER at the BASE city accommodation area (for the evening when the group returns). Never use a lunch spot at the day-trip destination as the restaurant_suggestion. If there is a standout lunch spot at the day-trip destination, work it into the afternoon activity description only (e.g. "Trattoria X — honest cucina povera in the trulli zone, ideal for lunch between sights"). Never leave a day without a dinner suggestion.
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
- CRITICAL FINAL CHECK: Before outputting, scan every morning, afternoon, and evening field across ALL days. Every single slot must begin with [Iconic], [Local Pick], or [Hidden Gem]. A slot missing this prefix is a formatting error — add the tier before outputting. No exceptions, no days skipped.

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
- Do not include foreign language characters or non-Latin script in any venue names, titles, or parenthetical translations. English names only.
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
      "why_recommended": "string — max 25 words",
      "city_teaser": "string — REQUIRED. One evocative sentence on what makes this city special on this trip."
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
- activities: 5–8 specific, real, named things to do, best-first. Each: name, description (max 25 words, why it suits this traveler), spot_tier (Iconic · Local Pick · Hidden Gem).
- restaurants: 5–8 specific, real, named venues across meal types. Each: name, venue_type, cuisine_category, price_range, known_for (max 8 words), neighborhood, why (max 10 words).
- hidden_finds: 2–3 genuinely non-obvious places most visitors miss. Each: emoji, title (max 6 words), description (max 25 words), city.

Weight everything by the traveler's interests and cuisine preferences. Exclude any interest at 0%. Address the traveler as "you".
${flags.wantTransportation ? `\nGETTING AROUND: Provide a general "Getting Around ${d.country || 'the destination'}" guide — transport options, tips, and how to move between the main areas. General guidance only, NOT day-by-day routing.` : ''}
${flags.wantAccommodations ? `\nACCOMMODATIONS: Provide hotel picks per city (1–2 each) matched to the traveler's accommodation style and budget.` : ''}

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

OUTPUT — return exactly this JSON:
{
  "overview": "string — max 3 sentences, second person",
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
        { "emoji": "string", "title": "string — max 6 words", "description": "string — max 25 words", "city": "string" }
      ]
    }
  ],${flags.wantAccommodations ? `
  "accommodations": [
    { "city": "string", "recommended_type": "string", "name": "string", "neighborhood": "string", "estimated_cost_per_night": "string", "why": "string — max 15 words" }
  ],` : ''}${flags.wantTransportation ? `
  "getting_around": { "overview": "string — 2–3 sentences", "tips": ["string", "string"] },` : ''}
  "book_before_you_go": [
    { "item_name": "string", "city": "string", "date": "string", "est_cost": "string", "booking_priority": "Book now · 4–6 weeks ahead · On arrival", "booking_tip": "string — one sentence", "booking_link": "string — official URL or empty string" }
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
    r.push('- ALWAYS include when relevant: visa/entry requirements, activity/attraction reservations that sell out or need timed entry, and travel insurance.');
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
  // accommodations/transport are conditional (section-select), so not required.
  const req = mode === 'recs'
    ? ['overview', 'cities', 'book_before_you_go', 'practical_info']
    : ['overview', 'days', 'restaurants', 'city_guide', 'book_before_you_go', 'practical_info'];
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

// Single Claude API call for itinerary generation. Returns the response text,
// or null on any failure (errors are logged inside streamAnthropic).
// maxTokens / timeoutMs default to the STANDARD-trip budget; generateItinerary
// passes larger tier-scaled values for MEDIUM/LONG trips. 64000 is the
// claude-sonnet-4-6 output ceiling.
async function callClaude(env, prompt, maxTokens = 32000, timeoutMs = 300000) {
  const { text } = await streamAnthropic(env, {
    model: 'claude-sonnet-4-6',
    max_tokens: maxTokens,
    messages: [{ role: 'user', content: prompt }]
  }, timeoutMs);
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
${cityPairs.length ? cityPairs.map(l => `- ${l}: drive time OR train, cost estimate, booking tip`).join('\n') : `- Internal travel within ${d.country}`}

SEASONAL NOTES — any closures, festivals, or crowd warnings for these exact dates.

Headings: "## TRANSPORT", "## SEASONAL NOTES". Specific times and costs. No hedging.
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
      // Debug: warn if content looks suspiciously empty
      const daysEmpty = mode === 'schedule' && Array.isArray(parsed.days) && parsed.days.length === 0;
      const overviewEmpty = !parsed.overview || parsed.overview.trim() === '';
      if (daysEmpty || overviewEmpty) {
        console.error('[DEBUG] hasRequiredKeys passed but content is empty — days:', parsed.days?.length, '| overview length:', (parsed.overview || '').length, '| raw response length:', rawText?.length, '| first 500 chars of raw:', rawText?.substring(0, 500));
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
    if (hasRequiredKeys(parsed, mode)) return finalize(parsed);
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
    for (const slot of [day.morning, day.afternoon, day.evening]) {
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
        // Rebuild the field string preserving original format prefix (Dinner:/Breakfast:)
        const original = entry.day[entry.field] || '';
        const prefixMatch = original.match(/^(Dinner|Lunch|Breakfast)\s*:/i);
        const prefix = prefixMatch ? prefixMatch[0] + ' ' : '';
        const neighbourhood = parts[3] || '';
        const why = parts[4] || '';
        entry.day[entry.field] = `${prefix}${parts[2]}${neighbourhood ? ' | ' + neighbourhood : ''}${why ? ' — ' + why : ''}`;
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
        if (parts[4]) accom.estimated_cost_per_night = parts[4];
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
- Title: 4–6 evocative words (not the venue name verbatim)
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

    // Section-select: what the traveler asked for (default to all four for old orders).
    const selectedSections = (Array.isArray(formData.selectedSections) && formData.selectedSections.length)
      ? formData.selectedSections
      : ['day_by_day', 'accommodations', 'transportation', 'food'];
    const flags = {
      wantDayByDay: selectedSections.includes('day_by_day'),
      wantAccommodations: selectedSections.includes('accommodations'),
      wantTransportation: selectedSections.includes('transportation'),
    };

    // Generate the full itinerary directly via Claude (no longer done in Make).
    const itinerary = await generateItinerary(env, { ...formData, approvedCities, teaserDay, selectedSections, flags });
    if (itinerary && itinerary.error) {
      console.error('Itinerary generation failed for session', session.id, '-', itinerary.message);
    } else {
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
    };

    try {
      const makeResponse = await fetch(env.N8N_WEBHOOK_URL, {
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