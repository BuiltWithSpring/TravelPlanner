/**
 * city-plan-validator.js — Deterministic validation + repair for AI-generated city plans.
 *
 * WHY THIS EXISTS: The "arrival city ≥1 night / departure city ≥1 night" business rule
 * was previously enforced by prompt text only, which the model follows probabilistically.
 * This module enforces it in code, after every preview generation and again server-side
 * before paid itinerary generation (worker.js keeps an inline copy — see the
 * "CITY PLAN VALIDATOR" section there; KEEP THE TWO IN SYNC).
 *
 * Works in both browser (index.html via <script src>) and Node.js (tests via require) —
 * same UMD pattern as preview-prompt.js.
 *
 * Usage:
 *   const result = CityPlanValidator.validateAndRepairCityPlan(preview.cities, formData);
 *   // cities array is repaired IN PLACE; result = { changed, notes }
 *
 * formData fields used: arrivalCityName, departureCityName, arrivalDate, departureDate,
 *                       mustSee, extraNotes
 */
(function (root, factory) {
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = factory();
  } else {
    root.CityPlanValidator = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {

  // Accent/punctuation-insensitive city-name comparison ("São Paulo" ≈ "Sao Paulo",
  // "New York City" ≈ "New York").
  const norm = (s) => String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]/g, '');

  function cityMatch(a, b) {
    const na = norm(a), nb = norm(b);
    if (!na || !nb) return false;
    return na === nb || na.indexOf(nb) === 0 || nb.indexOf(na) === 0;
  }

  function calcTotalNights(arrivalDate, departureDate) {
    const a = Date.parse(arrivalDate), b = Date.parse(departureDate);
    if (isNaN(a) || isNaN(b) || b <= a) return null;
    return Math.round((b - a) / 86400000);
  }

  // Traveler notes outrank the arrival/departure defaults. This is a REPAIR
  // SUPPRESSOR, not a decision-maker: the model reads the notes with full
  // comprehension and builds the plan; this check only stops us from "repairing"
  // a city back IN when the traveler's own notes plausibly asked for it to be
  // left out. Loose matching is safe here — a false positive just means we defer
  // to the model's judgment instead of overriding it.
  //
  // Catches any clear opt-out phrasing in the same sentence as a reference to the
  // city: "skip Hong Kong", "no overnight in HK", "don't want to stay in HK",
  // "go straight to Guilin", "transit only". City references include the full
  // name, initials of multi-word names ("hong kong" → "hk"), and the matching
  // airport code.
  const INITIALS_STOPLIST = ['no', 'to', 'in', 'on', 'at', 'so', 'do', 'be', 'me', 'my', 'we', 'us', 'an', 'as', 'by', 'of', 'or', 'up', 'if', 'it', 'la', 'st', 'de'];
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const OPT_OUT_RE = /\b(skip|pass(ing)? through|transit only|layover only|no stop(s)?|straight to|directly to)\b|\b(no|not|don'?t|do not|avoid|without|zero)\b[^.;!?\n]{0,40}\b(overnight(s)?|stay(ing|s)?|night(s)?|sleep(ing)?|stop(ping)?)\b/;

  function travelerSkips(cityName, fd) {
    const text = ((fd.mustSee || '') + '. ' + (fd.extraNotes || '')).toLowerCase();
    if (!cityName || !text.trim()) return false;
    const name = String(cityName).toLowerCase().trim();
    const words = name.split(/\s+/).filter(Boolean);
    const refs = [name];
    if (words.length > 1) {
      const initials = words.map(w => w[0]).join('');
      if (initials.length >= 2 && INITIALS_STOPLIST.indexOf(initials) === -1) refs.push(initials);
    }
    // Airport codes are city-specific: only attach the code that maps to THIS city,
    // so "no overnight in HKG" never suppresses the departure city's repair.
    if (cityMatch(cityName, fd.arrivalCityName) && typeof fd.arrivalAirport === 'string' && fd.arrivalAirport.trim().length === 3) {
      refs.push(fd.arrivalAirport.trim().toLowerCase());
    }
    if (cityMatch(cityName, fd.departureCityName) && typeof fd.departureAirport === 'string' && fd.departureAirport.trim().length === 3) {
      refs.push(fd.departureAirport.trim().toLowerCase());
    }
    // Opt-out phrase and city reference must share a sentence.
    return text.split(/[.;!?\n]+/).some(sentence =>
      OPT_OUT_RE.test(sentence) && refs.some(r => r.length >= 2 && new RegExp('\\b' + escRe(r) + '\\b').test(sentence))
    );
  }

  /**
   * Validates and repairs the plan IN PLACE. Conservative by design:
   *  - Missing arrival city  → insert as FIRST stop with 1 night (funded from the largest stay).
   *  - Missing departure city (one-way trips only) → append as FINAL stop with 1 night (same funding).
   *  - Arrival/departure city present but <1 night → bump to 1 (same funding).
   *  - Nights sum ≠ trip nights (when dates are parseable and all nights are integers)
   *    → rebalance on the largest stay, never dropping any city below 1 night.
   *  - POSITION IS ENFORCED: the arrival city must be the FIRST stop (moved there if
   *    mid-route), and on one-way trips the departure city must be the FINAL stop.
   *  - Round trips (arrival city == departure city): the trip must OPEN in the arrival
   *    city. If the city appears only as the loop-closing final stop, a separate 1-night
   *    opening stay is inserted (renderer supports repeat city cards). The final-stop
   *    loop itself is governed by the ROUND-TRIP ROUTING prompt directive, which
   *    legitimately allows airport-adjacent towns we can't verify in code.
   */
  function validateAndRepairCityPlan(cities, formData) {
    const notes = [];
    if (!Array.isArray(cities) || cities.length === 0) {
      return { changed: false, notes: ['empty or missing cities array — validation skipped'] };
    }
    const fd = formData || {};
    const arrCity = fd.arrivalCityName || null;
    const depCity = fd.departureCityName || null;
    const isRoundTrip = !!(arrCity && depCity && cityMatch(arrCity, depCity));
    let changed = false;

    // Normalize nights to non-negative numbers (leave fractions like 0.5 intact).
    cities.forEach(c => {
      const n = Number(c.nights);
      c.nights = isFinite(n) && n > 0 ? n : 0;
    });

    const nameOf = (c) => c.city || c.name || '';
    const findIdx = (name) => {
      for (let i = 0; i < cities.length; i++) {
        if (cityMatch(nameOf(cities[i]), name)) return i;
      }
      return -1;
    };

    // Take 1 night from the longest stay that can spare it (never drops a city below 1).
    const stealNight = (protectedIdxs) => {
      let idx = -1, best = 1;
      cities.forEach((c, i) => {
        if (protectedIdxs.indexOf(i) !== -1) return;
        if (c.nights > best) { best = c.nights; idx = i; }
      });
      if (idx >= 0) { cities[idx].nights -= 1; return true; }
      return false;
    };

    // ── Rule 1: arrival city must OPEN the trip with ≥1 night ───────────────
    if (arrCity && !travelerSkips(arrCity, fd)) {
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
      if (cities[0].nights < 1 && cityMatch(nameOf(cities[0]), arrCity)) {
        cities[0].nights = 1;
        stealNight([0]);
        changed = true;
        notes.push('raised arrival city "' + arrCity + '" to 1 night');
      }
    }

    // ── Rule 2: departure city present with ≥1 night (one-way trips) ────────
    if (depCity && !isRoundTrip && !travelerSkips(depCity, fd)) {
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
        if (cities[last].nights < 1 && cityMatch(nameOf(cities[last]), depCity)) {
          cities[last].nights = 1;
          stealNight([last]);
          changed = true;
          notes.push('raised departure city "' + depCity + '" to 1 night');
        }
      }
    }

    // ── Rule 3: nights must sum to the trip's total nights ──────────────────
    const total = calcTotalNights(fd.arrivalDate, fd.departureDate);
    const allInts = cities.every(c => c.nights === Math.round(c.nights));
    if (total && allInts) {
      let sum = cities.reduce((n, c) => n + c.nights, 0);
      let guard = 50;
      const protectedIdxs = [];
      if (arrCity) { const i = findIdx(arrCity); if (i !== -1) protectedIdxs.push(i); }
      if (depCity) { const i = findIdx(depCity); if (i !== -1) protectedIdxs.push(i); }
      while (sum > total && guard-- > 0) {
        if (!stealNight(protectedIdxs) && !stealNight([])) break;
        sum -= 1; changed = true;
      }
      if (sum < total) {
        // Add the shortfall to the longest stay.
        let idx = 0, best = -1;
        cities.forEach((c, i) => { if (c.nights > best) { best = c.nights; idx = i; } });
        cities[idx].nights += (total - sum);
        changed = true;
      }
      const finalSum = cities.reduce((n, c) => n + c.nights, 0);
      if (finalSum !== total) {
        notes.push('warning: nights sum ' + finalSum + ' still != trip nights ' + total + ' (left for model output)');
      } else if (changed) {
        notes.push('rebalanced nights to sum to ' + total);
      }
    }

    // ── Rule 4: every city should belong to one of the submitted countries ──
    // Log only — unlike Rules 1-3, code has no gazetteer to know the "correct"
    // replacement city for a hallucinated country, so this can't be safely
    // auto-repaired. Surfaces in wrangler tail / order notes for manual review.
    const countriesArr = Array.isArray(fd.countries) && fd.countries.length ? fd.countries
      : (fd.country ? [fd.country] : []);
    if (countriesArr.length) {
      cities.forEach(c => {
        const cCountry = c.country || null;
        if (!cCountry) return; // model omitted the field — nothing to check
        const inList = countriesArr.some(want => cityMatch(cCountry, want));
        if (!inList) {
          notes.push('warning: city "' + nameOf(c) + '" has country "' + cCountry + '" not in submitted list (' + countriesArr.join(', ') + ') — verify traveler notes requested it');
        }
      });
    }

    return { changed, notes };
  }

  return { validateAndRepairCityPlan, cityMatch, calcTotalNights };
});
