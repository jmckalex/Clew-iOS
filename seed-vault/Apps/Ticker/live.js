// Stock Ticker's live-quote rules, kept apart so they can be tested
// (tests/ticker-live.test.js): Finnhub's /api/v1/quote, within its free
// limit of 60 requests a minute. Loaded as a plain script before app.js
// (a global, TickerLive) and as a CommonJS module by the tests.
(function (root) {
	'use strict';

	/** How far apart requests go: each symbol about once a minute, never
	 *  more than 50 a minute in all; the first round quickly. */
	function nextDelay({ symbols, firstRound }) {
		if (firstRound) return 300;
		return Math.max(Math.round(60000 / Math.max(1, symbols)), 1200);
	}

	/** The wait after a 429: Finnhub's Retry-After when it gives one,
	 *  else a minute, doubling while it goes on, five minutes at most. */
	function backoffAfter429(previous, retryAfter) {
		const said = Number(retryAfter);
		if (Number.isFinite(said) && said > 0) return Math.min(said * 1000, 300000);
		return Math.min(previous ? previous * 2 : 60000, 300000);
	}

	/** Finnhub's quote, as the band shows it — or `unknown` for a symbol
	 *  it has no quote for (it answers zeros). */
	function quoteFrom(json) {
		const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
		const price = n(json && json.c);
		const t = n(json && json.t);
		if (!price || !t) return { unknown: true };
		return { price, prevClose: n(json.pc) ?? price, change: n(json.d), pct: n(json.dp), t };
	}

	/** Open while the newest quote is under 15 minutes old; closed (as of
	 *  that quote's time) once every quote is older. */
	function marketState(quotes, nowSeconds) {
		const times = quotes.filter((q) => q && !q.unknown && q.t).map((q) => q.t);
		if (!times.length) return { state: 'none', asOf: null };
		const newest = Math.max(...times);
		return { state: nowSeconds - newest > 15 * 60 ? 'closed' : 'open', asOf: newest };
	}

	/** The request. The key goes as the `token` query parameter: Finnhub's
	 *  CORS preflight allows no request headers, so its X-Finnhub-Token
	 *  header cannot be sent from a page (measured 2026-10-04). */
	function quoteUrl(base, symbol, key) {
		return `${base}/quote?symbol=${encodeURIComponent(symbol)}&token=${encodeURIComponent(key)}`;
	}

	const api = { nextDelay, backoffAfter429, quoteFrom, marketState, quoteUrl };
	if (typeof module === 'object' && module.exports) module.exports = api;
	else root.TickerLive = api;
})(typeof globalThis === 'object' ? globalThis : this);
