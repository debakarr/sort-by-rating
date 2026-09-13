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

test('unsupported hosts are ignored', async () => {
  const { send } = await boot('https://example.com/', '<div>nothing</div>');
  assert.equal(send({ channel: 'sbr', action: 'status' }), null);
});
