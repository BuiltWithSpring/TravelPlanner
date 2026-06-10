export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // ── CORS preflight ─────────────────────────────────────────
    if (request.method === 'OPTIONS') {
      return corsResponse(null, 204);
    }

    // ── Route: /preview — Anthropic API proxy ──────────────────
    if (url.pathname === '/preview' && request.method === 'POST') {
      try {
        const body = sanitizeDeep(await request.json());

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 55000);

        let response;
        try {
          response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            signal: controller.signal,
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': env.ANTHROPIC_API_KEY,
              'anthropic-version': '2023-06-01'
            },
            body: JSON.stringify(body)
          });
          clearTimeout(timeoutId);
        } catch (fetchErr) {
          clearTimeout(timeoutId);
          if (fetchErr.name === 'AbortError') {
            return corsResponse({ error: 'timeout', message: 'Preview generation timed out — please try again.' }, 504);
          }
          throw fetchErr;
        }

        const data = await response.json();
        return corsResponse(data, 200);
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

        if (event.type === 'checkout.session.completed') {
          // Itinerary generation can take 30–120s — far longer than Stripe will
          // wait for an ack. Run fulfillment in the background and respond 200 now.
          ctx.waitUntil(fulfillOrder(env, event.data.object));
        }

        return new Response('OK', { status: 200 });

      } catch (err) {
        return new Response(`Webhook error: ${err.message}`, { status: 400 });
      }
    }

    // ── Route: /success ────────────────────────────────────────
    if (url.pathname === '/success') {
      return Response.redirect('https://travel.builtwithspring.com/success', 302);
    }

    return corsResponse({ error: 'Not found' }, 404);
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

// ── Itinerary generation ────────────────────────────────────────
// Top-level keys every valid itinerary must contain.
const REQUIRED_KEYS = ['overview', 'days', 'accommodations', 'transport', 'restaurants', 'city_guide', 'booking_tracker', 'practical_info'];

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

train → cities along logical rail corridor. Major train stations only. No car/bus connections. Recommend specific rail pass (JR Pass, Eurail, Trenitalia, SNCF etc). Include day trips by local train within 60–90 min. Flag pre-departure rail passes as Book now in booking_tracker.

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
Generate 3–5 accommodation options per city, diversified across the traveler's selected styles.

Style distribution rules:
- One style selected → provide 3–5 options all of that type, ranging from best value to premium within the travel style tier
- Two styles selected → provide 2–3 options of each type, minimum 2 per style
- Three or more styles → provide at least 1–2 options per style, prioritizing styles that best suit the destination and travel party

Quality and safety rules:
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

- 20%+ → MINIMUM per city (6 entries flat):
  · 1 breakfast spot (set venue_type: "Breakfast") — or Brunch in cities where brunch culture is strong e.g. New York, London, Sydney, Melbourne, Cape Town
  · 1 cafe or specialty coffee shop (set venue_type: "Cafe")
  · 1 bakery or patisserie (set venue_type: "Bakery")
  · 1 lunch spot (set venue_type: "Lunch")
  · 2 dinner restaurants (set venue_type: "Dinner")
  · For every additional 2 nights in the same city beyond the first 2, add 1 more dinner entry
  · Street food and dessert are BONUS entries — add them where highly culturally relevant (e.g. street food in Asia/Mexico/Middle East, gelato in Italy, bubble tea in Asia) but they are not required minimums

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
- Regular days → pick the most appropriate meal based on the day's flow. Label clearly as Breakfast, Lunch, or Dinner. Always pick from the restaurants array for that city.
- Departure day → pick a restaurant near the departure hotel or point — last meal in that city before leaving.
- Arrival day → pick a restaurant near the arrival accommodation — first meal in the new city.
- Full travel day → pick a restaurant near the arrival accommodation for dinner on arrival.
- Never repeat the same venue on consecutive days across both restaurant_suggestion and restaurants array.
- Restaurant suggestion should always be geographically logical for that day's context.
- Restaurant suggestion must always be a venue already listed in the restaurants array for that city.

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

STEP 12 — BOOKING TRACKER
Every item requiring booking sorted: Book now → 4–6 weeks ahead → On arrival. Include all flights, accommodation, restaurants needing advance booking, activities needing advance booking. Every entry needs: category, item_name, city, date, est_cost, booking_priority, booking_tip (one sentence with where and how to book), booking_link (official URL where bookable — use the most direct official booking source; leave empty string if no reliable URL exists).

STEP 13 — CITY GUIDE
A comprehensive reference pool of everything worth visiting, weighted by interest scores. Richer and broader than the day-by-day plan.

Include:
- All activities from day-by-day
- Additional options per city beyond what is in day-by-day, scaled by interest weight below
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

STEP 14 — ACTIVITY FRAMING
Pace density rules — apply to every day-by-day entry:
- Full days → populate morning, afternoon AND evening with distinct activities. All 3 slots required.
- Relaxed days → populate morning and either afternoon OR evening. One slot can be left as "Free time — explore [neighborhood] at your own pace" if the day's activities are time-intensive.

All day-by-day activity fields: "[Activity name] — [one line what it is and why it suits this traveler]." No duration, category label, neighborhood tag, or pipes. Max 20 words.

STEP 15 — SPREADSHEET FORMATTING
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
Treat mustSee and extraNotes as hard instructions, not suggestions. Apply them before generating any output. If the traveler mentions existing bookings, flights, or accommodation — include them in booking_tracker as already confirmed and reflect them in the day-by-day.
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
      "restaurant_suggestion": "string — Meal type (Breakfast/Lunch/Dinner): Restaurant name | neighborhood | one line why it fits today",
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
          "best_time": "Morning · Afternoon · Evening · Full Day · Any",
          "est_cost": "string — range with currency or Free",
          "neighborhood": "string"
        }
      ]
    }
  ],
  "booking_tracker": [
    {
      "booking_priority": "Book now · 4–6 weeks ahead · On arrival",
      "category": "Flight · Train · Bus · Shuttle · Ferry · Rental Car · Hotel · Restaurant · Activity · Wellness",
      "item_name": "string",
      "city": "string",
      "date": "string",
      "est_cost": "string",
      "booking_tip": "string — one sentence",
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

// Single Claude API call. Returns the response text, or null on any failure.
async function callClaude(env, prompt) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        messages: [{ role: 'user', content: prompt }]
      })
    });
    clearTimeout(timeoutId);
    const data = await response.json();
    if (!response.ok) {
      console.error('Anthropic API error:', response.status, JSON.stringify(data));
      return null;
    }
    return (data && data.content && data.content[0] && data.content[0].text) || null;
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('Anthropic call failed:', err.name === 'AbortError' ? 'timeout' : err.message);
    return null;
  }
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

// Runs in the background after a confirmed payment: pull form data from KV,
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