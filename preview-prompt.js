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
- Never place a city more than 90 min from ${d.departureAirport} as the final city in the plan.
- If the most exciting destination is more than 90 min away, place it second-to-last. Use the airport city or an airport-adjacent town as the final stop.
- The final pre-departure night near the airport is expected to be a transitional, lighter day. That is fine and expected.
- The final airport-adjacent city should appear as its own city card in the plan with its own nights allocation — do not hide it.
- ROAD TRIP OVERRIDE (takes precedence over all rules above for road_trip trips): If the trip structure is road_trip, the final night MUST be in the DEPARTURE CITY ITSELF — the actual named city of ${d.departureAirport}. For example: GIG = Rio de Janeiro, GRU = São Paulo, CDG = Paris, LAX = Los Angeles. Do NOT substitute a rural area, mountain town, small village, or any "airport-adjacent" alternative — major hub airports are typically far from rural areas, so proximity claims for rural destinations are unreliable. The ~90-min and "airport-adjacent town" options above do NOT apply to road trips. Return to the exact departure city. The loop must close at the origin.
` : '';

    return `You are an expert travel planner. Generate a quick trip preview only.
Return ONLY valid JSON starting with { and ending with }. No markdown. No code fences.
${roundTripCityPlanDirective}

STEP 1 — NIGHT ALLOCATION
Classify each city: Micro 0.5–1 · Small 1–2 · Medium 2–3 · Large 3–5 · Mega 4–6 nights.
- Full days (Pack it in) = minimum nights per city, more cities possible.
- Relaxed days = maximum nights per city, fewer cities, slower pace.
- HARD CAP: Do not include a city that cannot receive its minimum nights. Remove lowest-priority cities until every remaining city gets its minimum. Never list a city with 0 or 1 night if its size classification requires more — cut the city instead, unless the traveler explicitly requests it in mustSee or extraNotes.
- If cities × minimum nights > total trip days → remove lowest-priority cities first (not the arrival or departure city).
- Travel days over 4 hours = full day lost → add 1 night to that city.
- Departure city classified Large or Mega → MINIMUM 2 nights, non-negotiable. WORKED EXAMPLE: if the trip is 7 nights and 5 cities are requested but enforcing 2 nights for the Large/Mega departure city leaves no room — drop the lowest-priority middle city, not the departure city nights. Never give a Large or Mega departure city only 1 night.
- Arrival and departure cities always get at least 1 night each — apply rules in Step 2.

STEP 2 — CITY SELECTION
Calculate total trip days from arrival to departure date.
- All cities must be within the submitted country unless traveler explicitly listed others.
- Always consider arrival and departure airport cities as candidates.
- ARRIVAL CITY RULE: The arrival airport city MUST appear in the city list for at least 1 night, no exceptions. If the model omits the arrival city, that is a prompt violation. The only override is if the traveler explicitly writes to skip it in mustSee or extraNotes.
- DEPARTURE CITY RULE: The departure airport city MUST appear in the city list for at least 1 night, no exceptions. Never route a traveler home from a city they haven't slept in. The only override is if the traveler explicitly writes to skip it in mustSee or extraNotes.
- cityPlanningMode "know" → respect listed cities exactly. Adjust count if needed.
- aiCityRecommendation true + anchorCities → anchors are fixed, fill remaining with best-fit.
- aiCityRecommendation true + no cities → select from scratch weighted by interests, budget, travel dates, routing.
- Large countries (USA, Australia, Canada, Brazil, China) + flying + no anchor cities → restrict to cities within the same state or within a 3-hour flight of the arrival airport. Do not mix US regions (e.g. do not combine Texas with Appalachia or the Northeast). Stay geographically coherent.
- Prefer well-known cities unless Adventure interest exceeds 25%.
- Verify cities suit exact travel dates — flag festivals or seasonal highlights in overview.

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
HARD INSTRUCTIONS: mustSee and extraNotes override all defaults. Never ignore them.

Return exactly this JSON:
{"overview":"max 3 sentences","cities":[{"city":"string","nights":0,"why_recommended":"string"}],"local_picks":[{"emoji":"string","title":"string","description":"string"}],"teaser_day":{"city":"string","day_label":"string","morning":"string","afternoon":"string","evening":"string","restaurant_suggestion":"string"},"visa_badge":"string"}

TRAVELER:
First name: ${d.firstName}
Last name: ${d.lastName}
Country: ${d.country}
Arrival airport: ${d.arrivalAirport}
Departure airport: ${d.departureAirport}
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
