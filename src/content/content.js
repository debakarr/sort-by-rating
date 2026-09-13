/* Sort by Rating — content script.
 *
 * Runs on Amazon and Flipkart listing pages (search results, category pages,
 * best-seller lists). Re-orders the product cards that are already on the page
 * by rating or by number of ratings/reviews.
 *
 * Design notes:
 *  - No background worker is used, so a single MV3 manifest works on both
 *    Chrome and Firefox. Everything happens in the page.
 *  - Cards are grouped by their DOM parent and only re-ordered inside their own
 *    parent, so unrelated siblings (ads, section headings, dividers, ...) keep
 *    their position.
 *  - Every card is tagged with its original position the first time we see it,
 *    which makes "Default order" and stable tie-breaking possible.
 */
(function () {
  'use strict';

  var api = (typeof browser !== 'undefined' && browser.runtime) ? browser
          : (typeof chrome !== 'undefined' && chrome.runtime) ? chrome : null;
  if (!api || !api.runtime || !api.storage) return;

  var HOST = location.hostname.replace(/^www\./, '');
  var SITE = /(^|\.)amazon\./.test(HOST) ? 'amazon'
           : /(^|\.)flipkart\.com$/i.test(HOST) ? 'flipkart'
           : null;
  if (!SITE) return;

  var SETTINGS_KEY = 'sbrSettings';
  var DEFAULTS = { mode: 'reviews-desc', auto: false, bar: true };
  var settings = Object.assign({}, DEFAULTS);

  var ORDER_ATTR = 'data-sbr-order';
  var orderCounter = 0;
  var sorting = false;      // true while we touch the DOM (guards the observer)
  var hasSorted = false;    // true once the user opted into sorting this page
  var observer = null;
  var debounceTimer = null;
  var valueCache = new WeakMap(); // card -> { rating, count, tries, final }

  /* ------------------------------------------------------------------ utils */

  function qsa(selector, root) {
    return Array.prototype.slice.call((root || document).querySelectorAll(selector));
  }

  function textOf(el) {
    if (!el) return '';
    return String(el.textContent == null ? '' : el.textContent).replace(/\u00a0/g, ' ').trim();
  }

  /** Parse an integer that may use thousands separators or a k/m/lakh suffix. */
  function parseCount(raw) {
    if (raw == null) return NaN;
    var s = String(raw).replace(/\u00a0/g, ' ').trim();
    var m = s.match(/(\d[\d.,]*)\s*(k|m|lakh|lac|crore|cr)?/i);
    if (!m) return NaN;
    var v = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(v)) return NaN;
    var suf = (m[2] || '').toLowerCase();
    if (suf === 'k') v *= 1e3;
    else if (suf === 'm') v *= 1e6;
    else if (suf === 'lakh' || suf === 'lac') v *= 1e5;
    else if (suf === 'crore' || suf === 'cr') v *= 1e7;
    return Math.round(v);
  }

  /** Parse a star rating (0 < value <= 5). */
  function parseRating(raw) {
    if (raw == null) return NaN;
    var m = String(raw).replace(/\u00a0/g, ' ').match(/([0-5](?:\.\d+)?)/);
    if (!m) return NaN;
    var v = parseFloat(m[1]);
    return (v > 0 && v <= 5) ? v : NaN;
  }

  /**
   * Extract a review count from a short string. Prefers an explicit
   * "N ratings" / "N reviews" phrase, and only falls back to a bare number when
   * the whole string is one. Crucially it never treats a leading star rating
   * (e.g. "4.3 out of 5 stars 2,345 ratings") as the count.
   */
  function countFromText(raw) {
    if (raw == null) return NaN;
    var t = String(raw).replace(/\u00a0/g, ' ').trim();
    var m = t.match(/([\d.,]+)\s*(?:global\s+)?(?:ratings?|reviews?)\b/i);
    if (m) return parseCount(m[1]);
    if (/^\d{1,3}(?:,\d{3})*$/.test(t)) return parseCount(t);
    return NaN;
  }

  /** Collapse "missing" values (NaN) to -1 so comparisons behave predictably. */
  function norm(v) {
    return (typeof v === 'number' && isFinite(v) && v > 0) ? v : -1;
  }

  /** Keep only nodes that are not descendants of another node in the list. */
  function outermost(nodes) {
    var arr = nodes.filter(Boolean);
    return arr.filter(function (n) {
      return !arr.some(function (o) { return o !== n && o.contains(n); });
    });
  }

  function pureNumber(el) {
    // A small element whose whole text is a number, and which is not a price.
    var t = textOf(el);
    if (!/^\d{1,3}(?:,\d{3})*$/.test(t)) return NaN;
    if (el.closest && el.closest('.a-price, .a-offscreen, [class*="price"], [class*="Price"]')) return NaN;
    return parseCount(t);
  }

  /* ------------------------------------------------------- Amazon extraction */

  function amazonRating(card) {
    var el = card.querySelector('span.a-icon-alt');
    if (el) { var v = parseRating(textOf(el)); if (!isNaN(v)) return v; }

    var aria = card.querySelector('[aria-label*="out of 5 stars"]');
    if (aria) { var v2 = parseRating(aria.getAttribute('aria-label')); if (!isNaN(v2)) return v2; }

    var title = card.querySelector('[title*="out of 5 stars"]');
    if (title) { var v3 = parseRating(title.getAttribute('title')); if (!isNaN(v3)) return v3; }

    var m = (card.innerText || '').match(/([0-5](?:\.\d)?)\s*out of\s*5/i);
    if (m) { var v4 = parseRating(m[1]); if (!isNaN(v4)) return v4; }

    return NaN;
  }

  function amazonCount(card) {
    // Most reliable: the "N ratings" link. Read the visible count span first
    // and only consult the aria-label through countFromText, so a label like
    // "4.3 out of 5 stars" can never be mistaken for a count.
    var link = card.querySelector('a[href*="customerReviews"], a[href*="#customerReviews"]');
    if (link) {
      var v = countFromText(textOf(link.querySelector('span')));
      if (isNaN(v)) v = countFromText(link.getAttribute('aria-label'));
      if (isNaN(v)) v = countFromText(textOf(link));
      if (!isNaN(v) && v > 0) return v;
    }

    var arias = qsa('[aria-label]', card);
    for (var i = 0; i < arias.length; i++) {
      var label = arias[i].getAttribute('aria-label') || '';
      var m = label.match(/([\d.,]+)\s*(?:global\s+)?(?:ratings?|reviews?)\b/i);
      if (m) { var v2 = parseCount(m[1]); if (!isNaN(v2)) return v2; }
    }

    var underline = card.querySelector('span.s-underline-text, .s-underline-text');
    if (underline) { var v3 = parseCount(textOf(underline)); if (!isNaN(v3)) return v3; }

    var txt = (card.innerText || '').replace(/\u00a0/g, ' ');
    var m2 = txt.match(/([\d,]+)\s*(?:global\s+)?(?:ratings?|reviews?)\b/i);
    if (m2) { var v4 = parseCount(m2[1]); if (!isNaN(v4)) return v4; }
    var m3 = txt.match(/(?:out of\s*5\s*stars)\s*([\d,]+)/i);
    if (m3) { var v5 = parseCount(m3[1]); if (!isNaN(v5)) return v5; }

    // Best-seller style pages show a bare number next to the stars.
    var spans = qsa('span, div', card);
    for (var j = 0; j < spans.length; j++) {
      var v6 = pureNumber(spans[j]);
      if (!isNaN(v6) && v6 > 0) return v6;
    }
    return NaN;
  }

  /* ----------------------------------------------------- Flipkart extraction */

  function flipkartRating(card) {
    // The rating badge is the smallest element whose text is exactly "4.3".
    var best = null;
    var nodes = qsa('div, span', card);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!/^[1-5]\.\d$/.test(textOf(el))) continue;
      if (qsa('div, span', el).some(function (c) { return /^[1-5]\.\d$/.test(textOf(c)); })) continue;
      best = el; // deepest match wins
    }
    if (best) { var v = parseRating(textOf(best)); if (!isNaN(v)) return v; }

    var txt = (card.innerText || '').replace(/\u00a0/g, ' ');
    var m = txt.match(/\(?\s*([1-5]\.\d)\s*\)?/);
    if (m) { var v2 = parseRating(m[1]); if (!isNaN(v2)) return v2; }
    return NaN;
  }

  function flipkartCount(card) {
    var txt = (card.innerText || '').replace(/\u00a0/g, ' ');
    var m = txt.match(/([\d,]+)\s*Ratings?\b/i) ||
            txt.match(/Ratings?\s*([\d,]+)\b/i);
    if (m) { var v = parseCount(m[1]); if (!isNaN(v)) return v; }

    var m2 = txt.match(/\(([\d,]+)\)/);
    if (m2) { var v2 = parseCount(m2[1]); if (!isNaN(v2)) return v2; }

    // Older layout: "4.3" badge followed by a separate "(1,234)" span.
    var nodes = qsa('span, div', card);
    for (var i = 0; i < nodes.length; i++) {
      var v3 = parseCount(textOf(nodes[i]).replace(/[()]/g, ''));
      if (!isNaN(v3) && v3 > 0 && /^\(?[\d,]+\)?$/.test(textOf(nodes[i]))) return v3;
    }
    return NaN;
  }

  function readRating(card) {
    return SITE === 'amazon' ? amazonRating(card) : flipkartRating(card);
  }
  function readCount(card) {
    return SITE === 'amazon' ? amazonCount(card) : flipkartCount(card);
  }

  /**
   * Read a card's rating/count, caching the result so that re-sorting after
   * every DOM mutation does not repeatedly force layout through innerText.
   * Cards with no rating are re-read a few times (their rating block may still
   * be rendering) and then cached as unrated.
   */
  function valuesOf(card) {
    var hit = valueCache.get(card);
    if (hit && (hit.final || hit.rating >= 0)) return hit;

    var rating = readRating(card);
    var count = readCount(card);
    var entry = {
      rating: rating,
      count: count,
      tries: (hit ? hit.tries : 0) + 1,
      final: false
    };
    entry.final = rating >= 0 || entry.tries >= 5;
    valueCache.set(card, entry);
    return entry;
  }

  /* ----------------------------------------------------------- card finding */

  function getCards() {
    var cards = [];
    if (SITE === 'amazon') {
      cards = qsa('div[data-component-type="s-search-result"]');
      if (cards.length < 2) cards = qsa('#zg-ordered-list > li, div#gridItemRoot, div.zg-grid-general-faceout');
      if (cards.length < 2) cards = qsa('.s-result-item[data-asin]');
    } else {
      // Flipkart product ids always start with "ITM".
      cards = qsa('div[data-id^="ITM"]');
    }
    return outermost(cards);
  }

  /* --------------------------------------------------------------- ordering */

  function tagOrder(cards) {
    for (var i = 0; i < cards.length; i++) {
      if (!cards[i].hasAttribute(ORDER_ATTR)) {
        cards[i].setAttribute(ORDER_ATTR, String(orderCounter++));
      }
    }
  }

  function makeComparator(mode) {
    var primary = mode.indexOf('rating') === 0 ? 'rating' : 'count';
    var secondary = primary === 'rating' ? 'count' : 'rating';
    var dir = /asc$/.test(mode) ? 1 : -1;

    return function (a, b) {
      var ap = a[primary], bp = b[primary];
      var am = ap < 0, bm = bp < 0;
      if (am || bm) {
        if (am && bm) return a.order - b.order;
        return am ? 1 : -1; // products with no rating always sink to the bottom
      }
      if (ap !== bp) return (ap - bp) * dir;

      var as = a[secondary], bs = b[secondary];
      if (as >= 0 && bs >= 0 && as !== bs) return bs - as;

      return a.order - b.order;
    };
  }

  function sameOrder(original, sortedItems) {
    if (original.length !== sortedItems.length) return false;
    for (var i = 0; i < original.length; i++) {
      if (original[i] !== sortedItems[i].card) return false;
    }
    return true;
  }

  /**
   * Re-insert `items` into `parent`, using the current position of each card as
   * a slot. Comment markers hold the slots open while the cards are detached so
   * non-product siblings stay exactly where they were.
   */
  function reorder(parent, items, original) {
    var markers = new Array(original.length);
    for (var i = 0; i < original.length; i++) {
      var m = document.createComment('sbr');
      original[i].parentNode.insertBefore(m, original[i]);
      markers[i] = m;
    }
    for (var j = 0; j < original.length; j++) {
      if (original[j].parentNode) original[j].parentNode.removeChild(original[j]);
    }
    for (var k = 0; k < items.length; k++) {
      var marker = markers[k];
      marker.parentNode.insertBefore(items[k].card, marker);
    }
    for (var l = 0; l < markers.length; l++) {
      if (markers[l].parentNode) markers[l].parentNode.removeChild(markers[l]);
    }
  }

  function sortPage(mode) {
    mode = mode || settings.mode;
    if (mode === 'default') return restoreDefault();

    var cards = getCards();
    if (cards.length < 2) return { found: cards.length, sorted: 0 };

    tagOrder(cards);

    var groups = new Map();
    for (var i = 0; i < cards.length; i++) {
      var p = cards[i].parentElement;
      if (!p) continue;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(cards[i]);
    }

    var cmp = makeComparator(mode);
    var sorted = 0;
    sorting = true;
    try {
      groups.forEach(function (list, parent) {
        if (list.length < 2) return;
        var items = list.map(function (card) {
          var v = valuesOf(card);
          return {
            card: card,
            rating: norm(v.rating),
            count: norm(v.count),
            order: parseInt(card.getAttribute(ORDER_ATTR), 10) || 0
          };
        });
        items.sort(cmp);
        if (sameOrder(list, items)) return;
        reorder(parent, items, list);
        sorted += items.length;
      });
    } finally {
      sorting = false;
    }
    hasSorted = true;
    return { found: cards.length, sorted: sorted };
  }

  function restoreDefault() {
    var cards = getCards();
    if (cards.length < 2) return { found: cards.length, sorted: 0 };
    tagOrder(cards);
    var groups = new Map();
    cards.forEach(function (c) {
      var p = c.parentElement;
      if (!p) return;
      if (!groups.has(p)) groups.set(p, []);
      groups.get(p).push(c);
    });
    sorting = true;
    try {
      groups.forEach(function (list, parent) {
        if (list.length < 2) return;
        var items = list.map(function (card) {
          return { card: card, order: parseInt(card.getAttribute(ORDER_ATTR), 10) || 0 };
        });
        items.sort(function (a, b) { return a.order - b.order; });
        if (sameOrder(list, items)) return;
        reorder(parent, items, list);
      });
    } finally {
      sorting = false;
    }
    return { found: cards.length, sorted: 0 };
  }

  /* ----------------------------------------------------------- quick bar UI */

  var MODE_LABELS = [
    ['reviews-desc', 'Most rated (reviews)'],
    ['rating-desc', 'Highest rating'],
    ['rating-asc', 'Lowest rating'],
    ['reviews-asc', 'Fewest reviews'],
    ['default', 'Default order']
  ];

  function removeBar() {
    var el = document.getElementById('sbr-bar');
    if (el) el.remove();
  }

  function ensureBar() {
    if (!settings.bar) { removeBar(); return; }
    if (getCards().length < 2) { removeBar(); return; }

    var existing = document.getElementById('sbr-bar');
    if (existing) {
      var sel = existing.querySelector('#sbr-select');
      if (sel && sel.value !== settings.mode) sel.value = settings.mode;
      return;
    }

    var bar = document.createElement('div');
    bar.id = 'sbr-bar';
    bar.setAttribute('role', 'region');
    bar.setAttribute('aria-label', 'Sort by rating');

    var label = document.createElement('span');
    label.className = 'sbr-label';
    label.textContent = 'Sort by';

    var select = document.createElement('select');
    select.id = 'sbr-select';
    MODE_LABELS.forEach(function (pair) {
      var opt = document.createElement('option');
      opt.value = pair[0];
      opt.textContent = pair[1];
      select.appendChild(opt);
    });
    select.value = settings.mode;
    select.addEventListener('change', function () {
      settings.mode = select.value;
      persist();
      sortPage(settings.mode);
      startObserver();
    });

    var close = document.createElement('button');
    close.id = 'sbr-close';
    close.type = 'button';
    close.title = 'Hide (re-enable from the extension popup)';
    close.textContent = '\u00d7';
    close.addEventListener('click', function () {
      settings.bar = false;
      persist();
      removeBar();
    });

    bar.appendChild(label);
    bar.appendChild(select);
    bar.appendChild(close);
    document.documentElement.appendChild(bar);
  }

  /* ------------------------------------------------------------ persistence */

  function loadSettings(cb) {
    var area = storeArea();
    if (!area) { cb(); return; }
    try {
      area.get(SETTINGS_KEY, function (res) {
        if (res && res[SETTINGS_KEY]) settings = Object.assign({}, DEFAULTS, res[SETTINGS_KEY]);
        if (typeof cb === 'function') cb();
      });
    } catch (e) {
      if (typeof cb === 'function') cb();
    }
  }

  /**
   * Prefer synced storage, but fall back to local storage. Some Firefox for
   * Android builds do not expose storage.sync, and we would rather remember
   * settings on the device than not at all.
   */
  function storeArea() {
    try {
      if (api.storage && api.storage.sync && typeof api.storage.sync.get === 'function') {
        return api.storage.sync;
      }
    } catch (e) { /* ignore */ }
    return api.storage ? api.storage.local : null;
  }

  function persist() {
    var area = storeArea();
    if (!area) return;
    try {
      var payload = {};
      payload[SETTINGS_KEY] = settings;
      area.set(payload);
    } catch (e) { /* ignore */ }
  }

  /* --------------------------------------------------------- live re-sorting */

  function startObserver() {
    if (observer || !document.body) return;
    observer = new MutationObserver(function () {
      if (sorting || !hasSorted || settings.mode === 'default') return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(function () {
        if (!sorting) { sortPage(settings.mode); ensureBar(); }
      }, 400);
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  /* ----------------------------------------------------------- popup bridge */

  function onMessage(msg, sender, sendResponse) {
    if (!msg || msg.channel !== 'sbr') return;

    if (msg.action === 'status') {
      sendResponse({
        site: SITE,
        mode: settings.mode,
        auto: settings.auto,
        bar: settings.bar,
        count: getCards().length
      });
      return;
    }
    if (msg.action === 'sort') {
      if (typeof msg.mode === 'string') settings.mode = msg.mode;
      if (typeof msg.auto === 'boolean') settings.auto = msg.auto;
      if (typeof msg.bar === 'boolean') settings.bar = msg.bar;
      persist();
      var result = sortPage(settings.mode);
      ensureBar();
      startObserver();
      sendResponse({ site: SITE, mode: settings.mode, count: result.found, sorted: result.sorted });
      return;
    }
    if (msg.action === 'rescan') {
      var r = sortPage(settings.mode);
      ensureBar();
      sendResponse({ site: SITE, mode: settings.mode, count: r.found, sorted: r.sorted });
      return;
    }
  }

  /* -------------------------------------------------------------------- init */

  function init() {
    loadSettings(function () {
      var wantsWork = settings.bar || (settings.auto && settings.mode !== 'default');

      if (wantsWork) {
        // Results can render slightly after the script starts; poll briefly.
        var tries = 0;
        var timer = setInterval(function () {
          tries++;
          if (getCards().length >= 2) {
            clearInterval(timer);
            if (settings.auto && settings.mode !== 'default') {
              sortPage(settings.mode);
              startObserver();
            }
            ensureBar();
          } else if (tries >= 40) {
            clearInterval(timer);
          }
        }, 500);
      }

      if (settings.bar) ensureBar();
      api.runtime.onMessage.addListener(onMessage);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
