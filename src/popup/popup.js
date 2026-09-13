/* Popup logic: reads/writes the shared settings and talks to the content
 * script of the active tab. */
(function () {
  'use strict';

  var api = (typeof browser !== 'undefined' && browser.runtime) ? browser
          : (typeof chrome !== 'undefined' && chrome.runtime) ? chrome : null;

  var SETTINGS_KEY = 'sbrSettings';
  var DEFAULTS = { mode: 'reviews-desc', auto: false, bar: true };

  var els = {
    status: document.getElementById('status'),
    mode: document.getElementById('mode'),
    rescan: document.getElementById('rescan'),
    auto: document.getElementById('auto'),
    bar: document.getElementById('bar')
  };

  var settings = Object.assign({}, DEFAULTS);
  var activeTabId = null;
  var supported = false;

  var SITE_LABELS = { amazon: 'Amazon', flipkart: 'Flipkart', meesho: 'Meesho', myntra: 'Myntra' };

  function siteLabel(site) {
    return SITE_LABELS[site] || 'This site';
  }

  function setStatus(text, kind) {
    els.status.textContent = text;
    els.status.className = 'status' + (kind ? ' ' + kind : '');
  }

  function setEnabled(on) {
    supported = on;
    [els.mode, els.rescan, els.auto, els.bar].forEach(function (el) { el.disabled = !on; });
  }

  function storeArea() {
    try {
      if (api.storage && api.storage.sync && typeof api.storage.sync.get === 'function') {
        return api.storage.sync;
      }
    } catch (e) { /* ignore */ }
    return api.storage ? api.storage.local : null;
  }

  function loadSettings(cb) {
    var area = storeArea();
    if (!area) { cb(); return; }
    try {
      area.get(SETTINGS_KEY, function (res) {
        if (res && res[SETTINGS_KEY]) settings = Object.assign({}, DEFAULTS, res[SETTINGS_KEY]);
        cb();
      });
    } catch (e) {
      cb();
    }
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

  function queryActiveTab(cb) {
    try {
      api.tabs.query({ active: true, currentWindow: true }, function (tabs) {
        cb(tabs && tabs[0] ? tabs[0] : null);
      });
    } catch (e) {
      cb(null);
    }
  }

  function send(msg, cb) {
    if (activeTabId == null) { cb(null); return; }
    var done = false;
    try {
      api.tabs.sendMessage(activeTabId, msg, function (resp) {
        done = true;
        var err = api.runtime.lastError; // reading this also clears it
        cb(err ? null : (resp || null));
      });
    } catch (e) {
      if (!done) cb(null);
    }
  }

  function applyToPage() {
    send({
      channel: 'sbr',
      action: 'sort',
      mode: settings.mode,
      auto: settings.auto,
      bar: settings.bar
    }, function (resp) {
      if (!resp) {
        setStatus('Could not reach this page. Reload it and try again.', 'warn');
        return;
      }
      setStatus(
        siteLabel(resp.site) + ' — ' +
        resp.count + ' products found' +
        (resp.sorted ? ', ' + resp.sorted + ' re-ordered.' : '.')
      );
    });
  }

  function refreshStatus() {
    send({ channel: 'sbr', action: 'status' }, function (resp) {
      if (!resp) {
        setEnabled(false);
        setStatus('Open a supported results page (Amazon, Flipkart, Meesho or Myntra) to use this extension.', 'warn');
        return;
      }
      setEnabled(true);
      setStatus(
        siteLabel(resp.site) + ' — ' +
        resp.count + ' products detected on this page.'
      );
    });
  }

  /* ----------------------------------------------------------------- wiring */

  els.mode.addEventListener('change', function () {
    settings.mode = els.mode.value;
    persist();
    if (supported) applyToPage();
  });

  els.rescan.addEventListener('click', function () {
    if (!supported) return;
    send({ channel: 'sbr', action: 'rescan' }, function (resp) {
      if (resp) setStatus('Re-applied — ' + resp.count + ' products on this page.');
    });
  });

  els.auto.addEventListener('change', function () {
    settings.auto = els.auto.checked;
    persist();
    if (supported) applyToPage();
  });

  els.bar.addEventListener('change', function () {
    settings.bar = els.bar.checked;
    persist();
    if (supported) applyToPage();
  });

  loadSettings(function () {
    els.mode.value = settings.mode;
    els.auto.checked = !!settings.auto;
    els.bar.checked = settings.bar !== false;
    queryActiveTab(function (tab) {
      activeTabId = tab ? tab.id : null;
      refreshStatus();
    });
  });
})();
