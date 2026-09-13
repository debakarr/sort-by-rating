/**
 * Integration tests for the content script.
 *
 * The real content/content.js is evaluated inside a jsdom document that mimics
 * an Amazon / Flipkart results page. The extension's public entry point (the
 * runtime.onMessage bridge) is then used to trigger the sorts, exactly like the
 * popup would.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { JSDOM } from 'jsdom';

const here = dirname(fileURLToPath(import.meta.url));
const CODE = readFileSync(join(here, '..', 'src', 'content', 'content.js'), 'utf8');

/** Rough stand-in for innerText: textContent with block boundaries as newlines. */
function approxInnerText(root) {
  let out = '';
  const walk = (node) => {
    for (const child of node.childNodes) {
      if (child.nodeType === 3) {
        out += child.nodeValue;
      } else if (child.nodeType === 1) {
        if (child.tagName === 'BR') { out += '\n'; continue; }
        out += '\n';
        walk(child);
        out += '\n';
      }
    }
  };
  walk(root);
  return out.replace(/[ \t]+/g, ' ').replace(/\n{2,}/g, '\n').trim();
}

const DEFAULT_SETTINGS = { mode: 'reviews-desc', auto: false, bar: false };

async function boot(url, bodyHtml, settings) {
  const dom = new JSDOM(
    `<!doctype html><html><head></head><body>${bodyHtml}</body></html>`,
    { url, pretendToBeVisual: true, runScripts: 'outside-only' }
  );
  const { window } = dom;

  Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
    configurable: true,
    get() { return approxInnerText(this); }
  });

  const listeners = [];
  const store = { sbrSettings: { ...DEFAULT_SETTINGS, ...(settings || {}) } };

  window.chrome = {
    runtime: { lastError: undefined, onMessage: { addListener(fn) { listeners.push(fn); } } },
    storage: { sync: { get(key, cb) { cb({ [key]: store[key] }); }, set() {} } }
  };

  // jsdom keeps readyState at "loading" and never fires DOMContentLoaded for a
  // document built from a string. Real injection happens at document_idle, so
  // pin the state to "complete" to make init() run synchronously and
  // deterministically.
  Object.defineProperty(window.document, 'readyState', {
    configurable: true,
    get() { return 'complete'; }
  });

  window.eval(CODE);

  const send = (msg) => {
    let response = null;
    for (const fn of listeners) fn(msg, {}, (r) => { response = r; });
    return response;
  };

  return { dom, window, send };
}

function orderOf(window, selector) {
  return Array.from(window.document.querySelectorAll(selector))
    .map((el) => el.getAttribute('data-asin') || el.getAttribute('data-id'));
}

/* ------------------------------------------------------------- fixtures */

function amazonCard(asin, rating, count) {
  const stars = rating == null
    ? ''
    : `<i class="a-icon a-icon-star-small"><span class="a-icon-alt">${rating} out of 5 stars</span></i>`;
  const reviews = count == null
    ? ''
    : `<a class="a-link-normal" href="/gp/customerReviews/${asin}"><span class="a-size-base s-underline-text">${count}</span></a>`;
  return `<div data-component-type="s-search-result" data-asin="${asin}">
    <h2 class="a-size-base-plus">Product ${asin}</h2>
    ${stars}${reviews}
    <span class="a-price"><span class="a-offscreen">&#8377;1,234</span></span>
  </div>`;
}

const AMAZON_BODY = `<div class="s-main-slot">
  ${amazonCard('A1', '4.1', '1,200')}
  ${amazonCard('B2', '4.8', '90')}
  <div class="s-result-item-separator">SEP</div>
  ${amazonCard('C3', '3.9', '15,000')}
  ${amazonCard('D4', '4.5', '300')}
  ${amazonCard('E5', null, null)}
</div>`;

function flipkartCard(id, rating, count) {
  const badge = rating == null ? '' : `<div class="_3LWZlK">${rating}</div>`;
  const reviews = count == null ? '' : `<span class="_2_R_DZ">${count} Ratings &amp; 30 Reviews</span>`;
  return `<div data-id="${id}">
    <div class="title">Product ${id}</div>
    ${badge}${reviews}
    <div class="_30jeq3">&#8377;1,234</div>
  </div>`;
}

const FLIPKART_BODY = `<div class="grid">
  ${flipkartCard('ITM1', '4.1', '1,200')}
  ${flipkartCard('ITM2', '4.8', '90')}
  <div class="ad-slot">SEP</div>
  ${flipkartCard('ITM3', '3.9', '15,000')}
  ${flipkartCard('ITM4', '4.5', '300')}
  ${flipkartCard('ITM5', null, null)}
</div>`;

const AMAZON_SEL = 'div[data-component-type="s-search-result"]';
const FLIPKART_SEL = 'div[data-id^="ITM"]';

/* ---------------------------------------------------------------- tests */

test('amazon: sorts by number of reviews (most rated first)', async () => {
  const { window, send } = await boot('https://www.amazon.in/s?k=phones', AMAZON_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-desc' });
  assert.deepEqual(orderOf(window, AMAZON_SEL), ['C3', 'A1', 'D4', 'B2', 'E5']);
});

test('amazon: sorts by highest rating', async () => {
  const { window, send } = await boot('https://www.amazon.in/s?k=phones', AMAZON_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'rating-desc' });
  assert.deepEqual(orderOf(window, AMAZON_SEL), ['B2', 'D4', 'A1', 'C3', 'E5']);
});

test('amazon: sorts by lowest rating', async () => {
  const { window, send } = await boot('https://www.amazon.in/s?k=phones', AMAZON_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'rating-asc' });
  assert.deepEqual(orderOf(window, AMAZON_SEL), ['C3', 'A1', 'D4', 'B2', 'E5']);
});

test('amazon: sorts by fewest reviews', async () => {
  const { window, send } = await boot('https://www.amazon.in/s?k=phones', AMAZON_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-asc' });
  assert.deepEqual(orderOf(window, AMAZON_SEL), ['B2', 'D4', 'A1', 'C3', 'E5']);
});

test('amazon: unrated products stay at the bottom in every mode', async () => {
  const { window, send } = await boot('https://www.amazon.in/s?k=phones', AMAZON_BODY);
  for (const mode of ['reviews-desc', 'rating-desc', 'rating-asc', 'reviews-asc']) {
    send({ channel: 'sbr', action: 'sort', mode });
    const order = orderOf(window, AMAZON_SEL);
    assert.equal(order[order.length - 1], 'E5', `mode ${mode}`);
  }
});

test('amazon: default order restores the original sequence', async () => {
  const { window, send } = await boot('https://www.amazon.in/s?k=phones', AMAZON_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'rating-desc' });
  send({ channel: 'sbr', action: 'sort', mode: 'default' });
  assert.deepEqual(orderOf(window, AMAZON_SEL), ['A1', 'B2', 'C3', 'D4', 'E5']);
});

test('amazon: non-product siblings keep their slot position', async () => {
  const { window, send } = await boot('https://www.amazon.in/s?k=phones', AMAZON_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-desc' });
  const slot = window.document.querySelector('.s-main-slot');
  const kids = Array.from(slot.children).map((el) =>
    el.classList.contains('s-result-item-separator') ? 'SEP'
      : el.getAttribute('data-asin'));
  assert.equal(kids.indexOf('SEP'), 2);
  assert.equal(kids.length, 6);
});

test('amazon: status reports the detected product count', async () => {
  const { send } = await boot('https://www.amazon.in/s?k=phones', AMAZON_BODY);
  const status = send({ channel: 'sbr', action: 'status' });
  assert.equal(status.site, 'amazon');
  assert.equal(status.count, 5);
});

test('flipkart: sorts by number of reviews (most rated first)', async () => {
  const { window, send } = await boot('https://www.flipkart.com/search?q=phones', FLIPKART_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-desc' });
  assert.deepEqual(orderOf(window, FLIPKART_SEL), ['ITM3', 'ITM1', 'ITM4', 'ITM2', 'ITM5']);
});

test('flipkart: sorts by highest rating', async () => {
  const { window, send } = await boot('https://www.flipkart.com/search?q=phones', FLIPKART_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'rating-desc' });
  assert.deepEqual(orderOf(window, FLIPKART_SEL), ['ITM2', 'ITM4', 'ITM1', 'ITM3', 'ITM5']);
});

test('flipkart: default order restores the original sequence', async () => {
  const { window, send } = await boot('https://www.flipkart.com/search?q=phones', FLIPKART_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-desc' });
  send({ channel: 'sbr', action: 'sort', mode: 'default' });
  assert.deepEqual(orderOf(window, FLIPKART_SEL), ['ITM1', 'ITM2', 'ITM3', 'ITM4', 'ITM5']);
});

test('flipkart: status reports the detected product count', async () => {
  const { send } = await boot('https://www.flipkart.com/search?q=phones', FLIPKART_BODY);
  const status = send({ channel: 'sbr', action: 'status' });
  assert.equal(status.site, 'flipkart');
  assert.equal(status.count, 5);
});

test('flipkart: non-product siblings keep their slot position', async () => {
  const { window, send } = await boot('https://www.flipkart.com/search?q=phones', FLIPKART_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'rating-desc' });
  const grid = window.document.querySelector('.grid');
  const kids = Array.from(grid.children).map((el) =>
    el.classList.contains('ad-slot') ? 'SEP' : el.getAttribute('data-id'));
  assert.equal(kids.indexOf('SEP'), 2);
  assert.equal(kids.length, 6);
});

/* ------------------------------------------------ regression: unrated cards */

const AMAZON_UNRATED_FIRST_BODY = `<div class="s-main-slot">
  ${amazonCard('U0', null, null)}
  ${amazonCard('A1', '4.1', '1,200')}
  ${amazonCard('C3', '3.9', '15,000')}
</div>`;

const FLIPKART_UNRATED_FIRST_BODY = `<div class="grid">
  ${flipkartCard('ITMU', null, null)}
  ${flipkartCard('ITM1', '4.1', '1,200')}
  ${flipkartCard('ITM3', '3.9', '15,000')}
</div>`;

const UNRATED_CASES = [
  ['reviews-desc', ['C3', 'A1', 'U0']],
  ['reviews-asc', ['A1', 'C3', 'U0']],
  ['rating-desc', ['A1', 'C3', 'U0']],
  ['rating-asc', ['C3', 'A1', 'U0']]
];

test('amazon: unrated product first is moved to the bottom in every mode', async () => {
  const { window, send } = await boot('https://www.amazon.in/s?k=phones', AMAZON_UNRATED_FIRST_BODY);
  for (const [mode, expected] of UNRATED_CASES) {
    send({ channel: 'sbr', action: 'sort', mode });
    assert.deepEqual(orderOf(window, AMAZON_SEL), expected, `mode ${mode}`);
  }
});

test('flipkart: unrated product first is moved to the bottom in every mode', async () => {
  const { window, send } = await boot('https://www.flipkart.com/search?q=phones', FLIPKART_UNRATED_FIRST_BODY);
  const cases = UNRATED_CASES.map(([mode, expected]) =>
    [mode, expected.map((id) => (id === 'U0' ? 'ITMU' : id.replace('A1', 'ITM1').replace('C3', 'ITM3')))]);
  for (const [mode, expected] of cases) {
    send({ channel: 'sbr', action: 'sort', mode });
    assert.deepEqual(orderOf(window, FLIPKART_SEL), expected, `mode ${mode}`);
  }
});

/* ------------------------------------- regression: count vs star aria-label */

// The reviews link carries only an aria-label. The star part of the label must
// not be mistaken for the review count.
function amazonCardAriaOnly(asin, rating, count) {
  return `<div data-component-type="s-search-result" data-asin="${asin}">
    <a class="a-link-normal" href="/gp/customerReviews/${asin}"
       aria-label="${rating} out of 5 stars ${count} ratings"></a>
    <i class="a-icon a-icon-star-small"><span class="a-icon-alt">${rating} out of 5 stars</span></i>
  </div>`;
}

const AMAZON_ARIA_BODY = `<div class="s-main-slot">
  ${amazonCardAriaOnly('P1', '4.9', '90')}
  ${amazonCardAriaOnly('Q2', '4.1', '5,000')}
</div>`;

test('amazon: a star rating in the reviews aria-label is not read as the count', async () => {
  const { window, send } = await boot('https://www.amazon.in/s?k=phones', AMAZON_ARIA_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-desc' });
  // Q2 has 5,000 ratings and P1 only 90, so Q2 must come first. If the "4.9" /
  // "4.1" were parsed as counts the order would be reversed.
  assert.deepEqual(orderOf(window, AMAZON_SEL), ['Q2', 'P1']);
});

/* --------------------------------- regression: live Flipkart markup 2024+ */

function flipkartLiveCard(id, rating, countText, extraSpecs) {
  const badge = rating == null ? '' : `<span class="CjyrHS" id="productRating_${id}"><div class="MKiFS6">${rating}</div></span>`;
  const count = countText == null ? '' : `<span class="PvbNMB"><span><span>${countText} Ratings&nbsp;</span><span>&amp;</span><span>&nbsp;100 Reviews</span></span></span>`;
  return `<div class="lvJbLV col-12-12"><div class="nZIRY7"><div data-id="${id}" style="width:100%">` +
    `<div class="RG5Slk">Product ${id}</div><div class="a7saXW">${badge}${count}</div>` +
    `<div class="CMXw7N"><ul><li>256 GB ROM</li><li>${extraSpecs || '16.0 cm Display'}</li></ul></div>` +
    `</div></div></div>`;
}

const FLIPKART_LIVE_BODY = `<div class="QSCKDh dLgFEE">` +
  `<div class="QSCKDh eRsYMo col-12-12">header</div>` +
  flipkartLiveCard('MOBAAA', '4.6', '26,324', 'Apple One (1) Year Limited Warranty') +
  flipkartLiveCard('MOBBBB', '4', '1,12,928', '6.75 inch Display') +
  flipkartLiveCard('MOBCCC', '3.8', '2,48,263', '5000 mAh Battery') +
  `</div>`;

const FLIPKART_LIVE_SEL = 'div[data-id]';

test('flipkart live: finds category-prefixed ids inside nested wrappers', async () => {
  const { send } = await boot('https://www.flipkart.com/search?q=phones', FLIPKART_LIVE_BODY);
  const status = send({ channel: 'sbr', action: 'status' });
  assert.equal(status.site, 'flipkart');
  assert.equal(status.count, 3);
});

test('flipkart live: sorts nested wrappers by count, header stays first', async () => {
  const { window, send } = await boot('https://www.flipkart.com/search?q=phones', FLIPKART_LIVE_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-desc' });
  assert.deepEqual(orderOf(window, FLIPKART_LIVE_SEL), ['MOBCCC', 'MOBBBB', 'MOBAAA']);
  const container = window.document.querySelector('.QSCKDh.dLgFEE');
  assert.match(container.children[0].className, /eRsYMo/);
});

test('flipkart live: integer rating badge parses and warranty (1) is not a count', async () => {
  const body = `<div class="QSCKDh dLgFEE">` +
    flipkartLiveCard('MOBRATED', '4', '5,170', '6 GB RAM') +
    `<div class="lvJbLV col-12-12"><div class="nZIRY7"><div data-id="MOBUNRATED" style="width:100%">` +
    `<div class="RG5Slk">Unrated</div><div class="CMXw7N"><ul><li>Apple One (1) Year Limited Warranty</li></ul></div>` +
    `</div></div></div></div>`;
  const { window, send } = await boot('https://www.flipkart.com/search?q=phones', body);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-desc' });
  assert.deepEqual(orderOf(window, FLIPKART_LIVE_SEL), ['MOBRATED', 'MOBUNRATED']);
  send({ channel: 'sbr', action: 'sort', mode: 'rating-desc' });
  assert.deepEqual(orderOf(window, FLIPKART_LIVE_SEL), ['MOBRATED', 'MOBUNRATED']);
});

/* ---------------------------------- regression: live Amazon markup 2024+ */

function amazonLiveCard(asin, rating, linkText, aria, extra) {
  const stars = rating == null ? '' : `<span class="a-icon-alt">${rating} out of 5 stars</span>`;
  const link = linkText == null ? '' :
    `<a class="a-link-normal" href="/gp/customerReviews/${asin}" aria-label="${aria}"><span>${linkText}</span></a>`;
  // New markup reuses .s-underline-text for the title link (contains prices).
  const titleLink = `<a class="a-link-normal s-underline-text" href="/dp/${asin}">Product ${asin} ₹8,988 M.R.P: ₹15,999</a>`;
  return `<div data-component-type="s-search-result" data-asin="${asin}">${titleLink}${stars}${link}${extra || ''}</div>`;
}

test('amazon live: parenthesized and k-suffixed counts sort, unrated sinks', async () => {
  const body = `<div class="s-main-slot">` +
    amazonLiveCard('U0', null, null, null) +
    amazonLiveCard('A1', '4.1 out of 5 stars', '(605)', '605 ratings') +
    amazonLiveCard('B2', '4.2 out of 5 stars', '(2.3K)', '2,365 ratings') +
    `</div>`;
  const { window, send } = await boot('https://www.amazon.in/s?k=phones', body);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-desc' });
  // B2 (2365) > A1 (605) > U0 (unrated, price link must not count as 8988).
  assert.deepEqual(orderOf(window, AMAZON_SEL), ['B2', 'A1', 'U0']);
});

test('amazon live: bare star rating is never read as a count', async () => {
  const body = `<div class="s-main-slot">` +
    `<div data-component-type="s-search-result" data-asin="P1"><span class="a-icon-alt">4.9 out of 5 stars</span><span>4.9</span></div>` +
    amazonLiveCard('Q2', '4.1 out of 5 stars', '(90)', '90 ratings') +
    `</div>`;
  const { window, send } = await boot('https://www.amazon.in/s?k=phones', body);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-desc' });
  assert.deepEqual(orderOf(window, AMAZON_SEL), ['Q2', 'P1']);
});

/* ------------------------------------------------- Myntra fixtures/tests */

function myntraCard(id, rating, countText) {
  const ratings = rating == null
    ? ''
    : `<div class="product-ratingsContainer"><span>${rating}</span><span>★</span><span>|</span><span>${countText}</span></div>`;
  return `<li class="product-base" data-id="${id}">` +
    `<div class="product-productMetaInfo"><h4 class="product-product">Tee ${id}</h4>` +
    `${ratings}` +
    `<div class="product-price"><span class="product-discountedPrice">Rs. 499</span><span class="product-strike">Rs. 1,499</span></div>` +
    `</div></li>`;
}

const MYNTRA_BODY = `<ul class="results-base">` +
  myntraCard('M1', '4.2', '1.2k') +
  myntraCard('M2', '4.8', '90') +
  `<li class="ad-slot">SEP</li>` +
  myntraCard('M3', '3.9', '15.3k') +
  myntraCard('M4', null, null) +
  `</ul>`;

const MYNTRA_SEL = 'li.product-base';

test('myntra: status reports site and product count', async () => {
  const { send } = await boot('https://www.myntra.com/men-tshirts', MYNTRA_BODY);
  const status = send({ channel: 'sbr', action: 'status' });
  assert.equal(status.site, 'myntra');
  assert.equal(status.count, 4);
});

test('myntra: sorts by number of reviews (most rated first)', async () => {
  const { window, send } = await boot('https://www.myntra.com/men-tshirts', MYNTRA_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-desc' });
  // M3 15.3k > M1 1.2k > M2 90 > M4 unrated (Rs. prices are not counts).
  assert.deepEqual(orderOf(window, MYNTRA_SEL), ['M3', 'M1', 'M2', 'M4']);
});

test('myntra: sorts by highest rating, unrated sinks', async () => {
  const { window, send } = await boot('https://www.myntra.com/men-tshirts', MYNTRA_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'rating-desc' });
  assert.deepEqual(orderOf(window, MYNTRA_SEL), ['M2', 'M1', 'M3', 'M4']);
});

test('myntra: default order restores the original sequence', async () => {
  const { window, send } = await boot('https://www.myntra.com/men-tshirts', MYNTRA_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-desc' });
  send({ channel: 'sbr', action: 'sort', mode: 'default' });
  assert.deepEqual(orderOf(window, MYNTRA_SEL), ['M1', 'M2', 'M3', 'M4']);
});

/* ------------------------------------------------- Meesho fixtures/tests */

function meeshoCard(id, pid, rating, countText) {
  const badge = rating == null ? '' : `<span class="pill">${rating} ★</span>`;
  const count = countText == null ? '' : `<span class="rcount">(${countText})</span>`;
  return `<div class="cardwrap" data-id="${id}">` +
    `<a href="/fancy-kurti/p/${pid}"><div><span>Kurti ${id}</span>${badge}${count}` +
    `<span>₹499</span></div></a></div>`;
}

const MEESHO_BODY = `<div class="plp-grid">` +
  meeshoCard('S1', 'aaa', '4.1', '1,200') +
  meeshoCard('S2', 'bbb', '4.8', '90') +
  `<div class="ad-slot">SEP</div>` +
  meeshoCard('S3', 'ccc', '3.9', '15,000') +
  meeshoCard('S4', 'ddd', null, null) +
  `</div>`;

const MEESHO_SEL = 'div.cardwrap';

test('meesho: status reports site and product count', async () => {
  const { send } = await boot('https://www.meesho.com/search?q=kurti', MEESHO_BODY);
  const status = send({ channel: 'sbr', action: 'status' });
  assert.equal(status.site, 'meesho');
  assert.equal(status.count, 4);
});

test('meesho: sorts by number of reviews (most rated first)', async () => {
  const { window, send } = await boot('https://www.meesho.com/search?q=kurti', MEESHO_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-desc' });
  // S3 15,000 > S1 1,200 > S2 90 > S4 unrated (₹ price is not a count).
  assert.deepEqual(orderOf(window, MEESHO_SEL), ['S3', 'S1', 'S2', 'S4']);
});

test('meesho: sorts by highest rating, unrated sinks', async () => {
  const { window, send } = await boot('https://www.meesho.com/search?q=kurti', MEESHO_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'rating-desc' });
  assert.deepEqual(orderOf(window, MEESHO_SEL), ['S2', 'S1', 'S3', 'S4']);
});

test('meesho: default order restores the original sequence', async () => {
  const { window, send } = await boot('https://www.meesho.com/search?q=kurti', MEESHO_BODY);
  send({ channel: 'sbr', action: 'sort', mode: 'reviews-desc' });
  send({ channel: 'sbr', action: 'sort', mode: 'default' });
  assert.deepEqual(orderOf(window, MEESHO_SEL), ['S1', 'S2', 'S3', 'S4']);
});

test('unsupported hosts are ignored', async () => {
  const { send } = await boot('https://example.com/', '<div>nothing</div>');
  assert.equal(send({ channel: 'sbr', action: 'status' }), null);
});
