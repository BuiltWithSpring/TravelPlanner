/**
 * preview-prompt.js — Single source of truth for the BWS Travel Planner preview prompt.
 *
 * Works in both browser (index.html via <script src>) and Node.js (test-perplexity.js via require).
 *
 * Usage:
 *   Browser:  PREVIEW_PROMPT(formData)
 *   Node.js:  const { PREVIEW_PROMPT } = require('./preview-prompt.js')
 *             PREVIEW_PROMPT(formData)                    — no research (same as production)
 *             PREVIEW_PROMPT(formData, perplexityResearch) — enhanced with Perplexity context
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { PREVIEW_PROMPT: factory() };
  } else {
    root.PREVIEW_PROMPT = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  return function PREVIEW_PROMPT(d, perplexityResearch) {

    // ── Optional Perplexity research block ──────────────────────────────────
    // Injected between STEP 9 and the JSON schema when research is provided.
    // Includes city-mapping instruction and explicit fallback for uncovered cities.
    const researchBlock = perplexityResearch ? `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
CURRENT DESTINATION RESEARCH
This section contains real-time research from travel blogs, review sites, and local guides.
Use it to ground your recommendations — prioritise named places from this research over generic suggestions.

City mapping: Each "### [City]" section below corresponds to that city in your output.
For any city where this research does not name a specific restaurant or activity, use your best training knowledge — do not leave fields empty or note the gap to the traveller.

${perplexityResearch}
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
` : '';

    // Round-trip detection — mirrors worker.js ITINERARY_PROMPT. When arrival and
    // departure airports resolve to the same hub, the city plan must loop back so the
    // FINAL city sits at/near that airport. Injected here so the approved city plan is
    // already airport-closed before it ever reaches itinerary generation downstream.
    const normAirport = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
    const isRoundTrip = d.arrivalAirport && d.departureAirport
      && normAirport(d.arrivalAirport) === normAirport(d.departureAirport);
    const roundTripCityPlanDirective = isRoundTrip ? `
ROUND-TRIP ROUTING (CRITICAL — arrival and departure airport are the SAME: ${d.departureAirport}):
This trip departs from the same airport it arrived into. The city route MUST form a loop. The LAST city in the plan (where the traveler spends their final night before departure) must be the airport city itself or another city within ~90 minutes ground transport of ${d.departureAirport}.

Rules:
- The trip must also OPEN in the arrival airport city: the FIRST city in the plan must be the airport city itself with at least 1 night. On multi-city round trips, list the airport city TWICE — once as the opening stop and once as the closing stop (each with its own nights). EXCEPTION: if the traveler's mustSee/extraNotes say they don't want to stay there on arrival, honor the notes — they outrank this rule.
- GATEWAY NIGHTS (round trips): if the airport city is itself a world-class or must-visit destination (e.g. Singapore, Tokyo, Paris, Rome, Bangkok, Istanbul), its COMBINED nights across the opening + closing stays must meet the recommended total for its size classification adjusted for pace (Step 2) — a Large airport city at fast pace needs 3 combined nights (e.g. 2 opening + 1 closing), never 1+1. Fund this by trimming or dropping mid-route cities, per the Step 2 rules. Only airport cities with little tourist value stay at the 1-night minimum per stay.
- Never place a city more than 90 min from ${d.departureAirport} as the final city in the plan.
- If the most exciting destination is more than 90 min away, place it second-to-last. Use the airport city or an airport-adjacent town as the final stop.
- The final pre-departure night near the airport is expected to be a transitional, lighter day. That is fine and expected.
- The final airport-adjacent city should appear as its own city card in the plan with its own nights allocation — do not hide it.
- ROAD TRIP OVERRIDE (takes precedence over all rules above for road_trip trips): If the trip structure is road_trip, the final night MUST be in the DEPARTURE CITY ITSELF — the actual named city of ${d.departureAirport}. For example: GIG = Rio de Janeiro, GRU = São Paulo, CDG = Paris, LAX = Los Angeles. Do NOT substitute a rural area, mountain town, small village, or any "airport-adjacent" alternative — major hub airports are typically far from rural areas, so proximity claims for rural destinations are unreliable. The ~90-min and "airport-adjacent town" options above do NOT apply to road trips. Return to the exact departure city. The loop must close at the origin.
` : '';

    return `You are an expert travel planner. Generate a quick trip preview only.
Return ONLY valid JSON starting with { and ending with }. No markdown. No code fences.
${roundTripCityPlanDirective}

STEP 1 — CITY SELECTION
Calculate total trip days from arrival to departure date. Select cities FIRST, then allocate nights in Step 2.
- All cities must be within the submitted country unless traveler explicitly listed others.
- Always consider arrival and departure airport cities as candidates.
- ARRIVAL CITY RULE (outranks every other selection rule EXCEPT traveler notes): The arrival airport city${d.arrivalCityName ? ` — ${d.arrivalCityName} —` : ''} MUST appear in the city list with at least 1 night. Omitting it is a prompt violation. THE ONE OVERRIDE: any clear instruction in mustSee or extraNotes that the traveler does not want to stay there — "skip Hong Kong", "no overnight in HK", "don't want to stay in HK", "go straight to Guilin" all count, exact wording irrelevant. When the traveler opts out, honor it fully: route them onward on arrival day and do not allocate the city any nights.
- DEPARTURE CITY RULE (outranks every other selection rule EXCEPT traveler notes): The departure airport city${d.departureCityName ? ` — ${d.departureCityName} —` : ''} MUST appear in the city list with at least 1 night. Never route a traveler home from a city they haven't slept in. Same traveler-notes override as above — if they opted out, honor it and note the airport transfer implications in the overview.
- cityPlanningMode "know" → respect listed cities exactly, EXCEPT: if the traveler's list omits the arrival or departure airport city, ADD it anyway with at least 1 night — the two rules above outrank the traveler's list. Adjust count if needed.
- aiCityRecommendation true + anchorCities → anchors are fixed, fill remaining with best-fit.
- aiCityRecommendation true + no cities → select from scratch weighted by interests, budget, travel dates, routing.
- Large countries (USA, Australia, Canada, Brazil, China) + flying + no anchor cities → restrict to cities within the same state or within a 3-hour flight of the arrival airport. Do not mix US regions (e.g. do not combine Texas with Appalachia or the Northeast). Stay geographically coherent.
- Prefer well-known cities unless Adventure interest exceeds 25%.
- Verify cities suit exact travel dates — flag festivals or seasonal highlights in overview.

STEP 2 — NIGHT ALLOCATION
Classify each city: Micro 0.5–1 · Small 1–2 · Medium 2–3 · Large 3–5 · Mega 4–6 nights.
- Nights MUST sum exactly to the total trip nights (departure date minus arrival date).
- Target the AVERAGE of each city's band (Large 3–5 → 4 nights). Pace nudges WITHIN the band, never outside it: Full days (Pack it in) → lean 1 night below the average per city; Relaxed days → lean 1 night above.
- Pace is primarily about DAY DENSITY (see teaser time budget), not city count. City count follows from total trip nights ÷ average nights per city. NEVER add a city that only fits at its bare band minimum — every extra city costs roughly half a day in transit and check-in, so a packed trip means fuller days, not more stops.
- HARD CAP: Do not include a city that cannot receive its minimum nights. Remove lowest-priority cities until every remaining city gets its minimum. Never list a city with 0 or 1 night if its size classification requires more — cut the city instead, unless the traveler explicitly requests it in mustSee or extraNotes. EXCEPTION: the arrival and departure cities are EXEMPT from this cap — they may take exactly 1 night even when their size classification requires more. Never cut the arrival or departure city to satisfy this cap.
- If cities × minimum nights > total trip days → remove lowest-priority cities first (never the arrival or departure city).
- Travel days over 4 hours = full day lost → add 1 night to that city.
- Departure city classified Large or Mega → MINIMUM 2 nights when trip length allows. WORKED EXAMPLE: if the trip is 7 nights and 5 cities are requested but enforcing 2 nights for the Large/Mega departure city leaves no room — drop the lowest-priority middle city, not the departure city nights. On trips too short even for that, give the departure city 1 night — never 0, never cut it.

STEP 3 — TRIP STRUCTURE
Single city trips → skip all corridor and routing logic below. If train selected → recommend local train day trips within 60–90 min and city transport tips only. All other structures → default to activity-based day planning.
- road_trip → cities along efficient driving corridor, driveable in 2–5 hour legs, no backtracking. EXCEPTION: on round-trips (same arrival and departure airport), returning to the departure airport city for the final night IS required and overrides the no-backtracking rule — see ROUND-TRIP ROUTING above.
- train → cities along logical rail corridor, major train stations only, no car/bus connections.
- flying → each city fully independent, selected by interest profile not geography.
- Not provided → MANDATORY: evaluate every leg using actual train and flight times. Under 3 hours by train → always recommend train. 3–5 hours → recommend whichever is faster door-to-door. Over 5 hours or no rail → flying. Never recommend flying where high-speed rail is under 4 hours. China: always check HSR first. Europe: always check Eurostar/TGV/ICE/Frecciarossa first. Japan: always recommend Shinkansen for legs under 4 hours.

STEP 4 — TRAVEL PARTY RULES
- Couple → romantic, intimate venues only.
- Family with kids → kid-friendly without exception.
- Friends group → social, communal, group-capacity venues.
- Solo → flexible, independent, safe venues.

STEP 5 — INTEREST WEIGHTS
- 20%+ → feature prominently. 11–19% → include if fits naturally. 1–10% → only if nothing higher fits. 0% → exclude entirely.

STEP 6 — BUDGET
- Budget → ~$50–100/day. Mid-range → ~$100–250/day. Luxury → $250+/day. Never exceed budget tier.

STEP 7 — TEASER DAY RULES
- Pick the single most exciting city. Never a pass-through or <1 night city.
- Label as "Sample Day in [City]" — never Day 1/2/3.
- Morning, afternoon, evening in same or adjacent neighborhoods.
- Every activity: "[Name] — [what it is and why it suits this traveler]." Max 20 words.
- Restaurant: "Lunch/Dinner: [Name] — [one line why special]." Max 20 words.
- Never bars/nightlife as morning or afternoon activity.
- why_recommended: "[City] is [known for] — chosen for your [specific interest]." Max 25 words. Never generic.
- CRITICAL: evening and restaurant_suggestion must be DIFFERENT venues. Never repeat the same restaurant name in both fields. Evening = an activity or bar or walk. restaurant_suggestion = where to eat dinner.

STEP 8 — TEASER TIME BUDGET
- Full days → populate morning, afternoon AND evening.
- Relaxed days → morning and ONE of afternoon or evening.
- Full-day activity → that's the day. One light evening max.
- Never 3 time-intensive activities (3+ hrs each) in one day.

STEP 9 — LOCAL PICKS
Select 2–3 genuinely non-tourist finds relevant to this trip. Must be specific, real places or experiences that well-researched travellers would discover — not mainstream sights.
- emoji: a single relevant emoji
- title: max 5 words (the name or hook)
- description: max 20 words explaining why it's special and not obvious
- Do NOT include anything on the mainstream tourist trail (no Eiffel Tower, no Colosseum, no Great Wall as a pick)
- Span different cities if the trip has multiple stops
- Must match the traveler's interests and travel party
${researchBlock}
VISA: visa_badge is a short generic visa reminder — do NOT assume the traveler's nationality or whether they need a visa. Always use a neutral format like "🛂 Visa may be required — check requirements for your passport before travel". Never say "no visa required" or reference a specific passport type.
TONE: Always second person. Never traveler's name or "the couple/group/traveler".
HARD INSTRUCTIONS: mustSee and extraNotes are the traveler's direct voice. They override EVERY rule in this prompt — arrival/departure city rules, night allocation, city selection, routing. If a note conflicts with any rule above, the note wins. Never ignore them.

FINAL CHECK — verify before outputting, fix any violation silently:
1. ${d.arrivalCityName ? `The arrival city (${d.arrivalCityName})` : 'The arrival airport city'} appears in cities with at least 1 night${d.departureCityName && d.arrivalCityName !== d.departureCityName ? `, and the departure city (${d.departureCityName}) appears with at least 1 night` : ''} — unless the traveler's notes say not to stay there, in which case verify you honored the notes instead.
2. Nights across all cities sum exactly to the total trip nights (departure date minus arrival date).
3. On round-trips, the final city satisfies ROUND-TRIP ROUTING above, and a world-class airport city's COMBINED nights across its stays meet its size-classification recommendation (GATEWAY NIGHTS) — never 1+1.
4. A world-class or must-visit arrival or departure city on a one-way trip has its recommended nights for its size and pace — not the bare 1-night minimum.

Return exactly this JSON:
{"overview":"max 3 sentences","cities":[{"city":"string","nights":0,"why_recommended":"string"}],"local_picks":[{"emoji":"string","title":"string","description":"string"}],"teaser_day":{"city":"string","day_label":"string","morning":"string","afternoon":"string","evening":"string","restaurant_suggestion":"string"},"visa_badge":"string"}

TRAVELER:
First name: ${d.firstName}
Last name: ${d.lastName}
Country: ${d.country}
Arrival airport: ${d.arrivalAirport}${d.arrivalCityName ? ` (city: ${d.arrivalCityName})` : ''}
Departure airport: ${d.departureAirport}${d.departureCityName ? ` (city: ${d.departureCityName})` : ''}
Arrival date: ${d.arrivalDate}
Departure date: ${d.departureDate}
City planning mode: ${d.cityPlanningMode}
Trip structure: ${d.tripStructure || 'not specified'}
Cities requested: ${JSON.stringify(d.citiesToVisit)}
AI recommendation: ${d.aiCityRecommendation}
Anchor cities: ${JSON.stringify(d.anchorCities)}
Travel party: ${d.travelParty}
Group size: ${d.groupSize || "not specified"}
Pace: ${d.paceOfTravel}
Travel style: ${d.travelStyle}
Interests: ${JSON.stringify(d.interests)}
Must see: ${d.mustSee}
Extra notes: ${d.extraNotes}`;
  };

});
