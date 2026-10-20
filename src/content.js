/**
 * content.js —— 隔离世界（world: ISOLATED），document_start。
 *
 * 负责：
 *   · 读写 chrome.storage.local（设置 / 学习名单 / 白名单 / 统计）
 *   · 给主世界推配置（bcs-config），收主世界的命中事件（bcs-detections）→ 计 strikes / 自动学习
 *   · DOM 兜底：B 站评论现在是 Web Components + Shadow DOM（bili-comments → bili-comment-thread-renderer …），
 *     这里递归进 open shadow root 找评论，做折叠 / 隐藏
 *   · 标记模式：点扩展图标（popup 打开）后，每条评论旁出现「标记机器人 / 这是真人」
 *   · 不做浮动徽标、不联网、不碰账号
 */
(function () {
  'use strict';
  if (window.__BCS_CONTENT__) return;
  window.__BCS_CONTENT__ = true;

  var R = window.BSH_RULES;
  if (!R) return;

  try {
    console.info('[别看大肥鱼了] content script 已注入：' + location.href);
  } catch (err) {
    /* ignore */
  }
  // 页面可见的诊断标记（Console 里一行就能判断有没有注入）
  try {
    document.documentElement.setAttribute('data-bcs-loaded', '1');
    document.documentElement.setAttribute('data-bcs-stage', 'init');
    document.documentElement.setAttribute(
      'data-bcs-ver',
      (chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '?'
    );
  } catch (err) {
    /* ignore */
  }

  function markStage(stage) {
    try {
      document.documentElement.setAttribute('data-bcs-stage', String(stage).slice(0, 120));
    } catch (err) {
      /* ignore */
    }
  }

  var lastScanUnits = 0;
  var lastCollapseBars = 0;

  var DEFAULT_SETTINGS = {
    enabled: true,
    mode: 'collapse', // collapse | hide | observe
    level: 'balanced',
    autoLearn: true,
    learnAfter: 3,
    markMode: false
  };

  var state = {
    settings: Object.assign({}, DEFAULT_SETTINGS),
    learned: {},
    nameBlocks: [],
    whitelist: {},
    strikes: {},
    stats: { total: 0, today: { date: '', collapsed: 0, hidden: 0, observed: 0 } }
  };

  // ---------------------------------------------------------------- storage

  function storageGet() {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.get(null, function (raw) {
          resolve(raw || {});
        });
      } catch (err) {
        resolve({});
      }
    });
  }

  function storageSet(obj) {
    return new Promise(function (resolve) {
      try {
        chrome.storage.local.set(obj, function () {
          resolve();
        });
      } catch (err) {
        resolve();
      }
    });
  }

  function todayKey() {
    var d = new Date();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return d.getFullYear() + '-' + m + '-' + day;
  }

  function normalize(raw) {
    raw = raw || {};
    var settings = Object.assign({}, DEFAULT_SETTINGS, raw.settings || {});
    if (['collapse', 'hide', 'observe'].indexOf(settings.mode) === -1) settings.mode = 'collapse';
    if (['conservative', 'balanced', 'aggressive'].indexOf(settings.level) === -1) settings.level = 'balanced';
    settings.learnAfter = Number(settings.learnAfter) > 0 ? Number(settings.learnAfter) : 3;
    var today = raw.stats && raw.stats.today && typeof raw.stats.today === 'object' ? raw.stats.today : {};
    return {
      settings: settings,
      learned: raw.learned && typeof raw.learned === 'object' ? raw.learned : {},
      nameBlocks: Array.isArray(raw.nameBlocks) ? raw.nameBlocks : [],
      whitelist: raw.whitelist && typeof raw.whitelist === 'object' ? raw.whitelist : {},
      strikes: raw.strikes && typeof raw.strikes === 'object' ? raw.strikes : {},
      stats: {
        total: Number(raw.stats && raw.stats.total) || 0,
        today: {
          date: today.date || todayKey(),
          collapsed: Number(today.collapsed) || 0,
          hidden: Number(today.hidden) || 0,
          observed: Number(today.observed) || 0
        }
      }
    };
  }

  function pushConfig() {
    try {
      window.dispatchEvent(
        new CustomEvent('bcs-config', {
          detail: {
            settings: state.settings,
            learnedUids: Object.keys(state.learned),
            whitelistUids: Object.keys(state.whitelist),
            nameBlocks: state.nameBlocks
          }
        })
      );
    } catch (err) {
      /* ignore */
    }
  }

  // 供 popup 诊断：点扩展图标时可以知道本页到底有没有注入、扫到几条
  try {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || message.type !== 'bcs-ping') return;
      try {
        sendResponse({
          ok: true,
          units: lastScanUnits,
          collapse: lastCollapseBars,
          mode: state.settings.mode,
          markMode: state.settings.markMode,
          enabled: state.settings.enabled,
          ver: (document.documentElement.getAttribute('data-bcs-ver') || ''),
          stage: (document.documentElement.getAttribute('data-bcs-stage') || ''),
          href: location.href,
          ts: Date.now()
        });
      } catch (err) {
        sendResponse({ ok: false });
      }
    });
  } catch (err) {
    /* ignore */
  }

  markStage('ping-ready');

  async function reload() {
    state = normalize(await storageGet());
    pushConfig();
    scheduleScan(true);
  }

  // ------------------------------------------------------- API 命中 → 学习

  var detectionQueue = Promise.resolve();

  function enqueueDetection(item) {
    detectionQueue = detectionQueue
      .then(function () {
        return handleDetection(item);
      })
      .catch(function () {
        /* 学习失败不影响页面 */
      });
  }

  async function handleDetection(item) {
    if (!item || !item.mid) return;
    var raw = await storageGet();
    var s = normalize(raw);
    if (!s.settings.enabled) return;
    var uid = String(item.mid);
    if (s.learned[uid] || s.whitelist[uid]) return;
    if (R.matchesBlockedName(item.uname, s.nameBlocks)) return;

    var strike = s.strikes[uid] || { hits: 0, seen: [], lastAt: 0 };
    var key = String(item.key || item.rpid || uid + ':' + String(item.text || '').slice(0, 40));
    if (strike.seen.indexOf(key) !== -1) return;
    strike.hits += 1;
    strike.seen.push(key);
    if (strike.seen.length > 80) strike.seen = strike.seen.slice(-80);
    strike.lastAt = Date.now();
    s.strikes[uid] = strike;

    s.stats.total += 1;
    if (s.stats.today.date !== todayKey()) {
      s.stats.today = { date: todayKey(), collapsed: 0, hidden: 0, observed: 0 };
    }
    if (item.action === 'hidden') s.stats.today.hidden += 1;
    else if (item.action === 'observed') s.stats.today.observed += 1;
    else s.stats.today.collapsed += 1;

    var learnedNow = false;
    if (s.settings.autoLearn && strike.hits >= s.settings.learnAfter) {
      s.learned[uid] = {
        uname: item.uname || '',
        addedAt: Date.now(),
        source: 'auto',
        hits: strike.hits
      };
      delete s.strikes[uid];
      learnedNow = true;
    }

    await storageSet({ strikes: s.strikes, learned: s.learned, stats: s.stats });
    if (learnedNow) {
      state = s;
      pushConfig();
      scheduleScan(true);
    }
  }

  window.addEventListener('bcs-detections', function (event) {
    try {
      var items = event && event.detail && event.detail.items;
      if (!Array.isArray(items)) return;
      for (var i = 0; i < items.length; i++) enqueueDetection(items[i]);
    } catch (err) {
      /* ignore */
    }
  });

  // --------------------------------------------------------- DOM 扫描基础

  var roots = new Set([document]);
  var rootObservers = new Map();
  var scanTimer = 0;
  var forceToken = 0;
  var lastHref = location.href;

  function observeRoot(root) {
    if (rootObservers.has(root)) return;
    try {
      var mo = new MutationObserver(function (records) {
        for (var i = 0; i < records.length; i++) {
          var added = records[i].addedNodes;
          for (var j = 0; j < added.length; j++) {
            discoverFrom(added[j]);
            // 有些自定义元素是插入之后才 attachShadow 的，稍后再探一次
            if (added[j] && added[j].nodeType === 1) {
              (function (node) {
                setTimeout(function () {
                  discoverFrom(node);
                  scheduleScan(false);
                }, 80);
              })(added[j]);
            }
          }
        }
        scheduleScan(false);
      });
      mo.observe(root, { childList: true, subtree: true, characterData: true });
      rootObservers.set(root, mo);
    } catch (err) {
      /* ignore */
    }
  }

  function addRoot(root) {
    if (!root || roots.has(root)) return;
    roots.add(root);
    observeRoot(root);
    discoverIn(root);
  }

  function discoverIn(root) {
    var all;
    try {
      all = root.querySelectorAll('*');
    } catch (err) {
      return;
    }
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.shadowRoot && !roots.has(el.shadowRoot)) addRoot(el.shadowRoot);
    }
  }

  function discoverFrom(node) {
    if (!node || node.nodeType !== 1) return;
    if (node.shadowRoot && !roots.has(node.shadowRoot)) addRoot(node.shadowRoot);
    var all;
    try {
      all = node.querySelectorAll('*');
    } catch (err) {
      return;
    }
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      if (el.shadowRoot && !roots.has(el.shadowRoot)) addRoot(el.shadowRoot);
    }
  }

  function scheduleScan(force) {
    if (force) forceToken++;
    if (scanTimer) return;
    scanTimer = setTimeout(function () {
      scanTimer = 0;
      runScan();
    }, 140);
  }

  // --------------------------------------------------------- 评论节点识别

  function tagOf(el) {
    return (el && el.tagName ? el.tagName : '').toLowerCase();
  }

  function composedParent(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    var root = node.getRootNode && node.getRootNode();
    return root && root.host ? root.host : null;
  }

  function isUnitElement(el) {
    if (!el || el.nodeType !== 1) return false;
    var tag = tagOf(el);
    if (el.classList && (el.classList.contains('reply-item') || el.classList.contains('sub-reply-item'))) return true;
    if (tag === 'bili-comment-renderer') return true;
    if (/^bili-comment-.*-renderer$/.test(tag) && !/thread|header|replies|action|user|editor|box/.test(tag)) return true;
    return false;
  }

  function closestUnit(el) {
    var node = el;
    var depth = 0;
    while (node && depth < 12) {
      if (isUnitElement(node)) return node;
      node = composedParent(node);
      depth++;
    }
    // 兜底：包含 rich-text 的那层 shadow host
    var root = el.getRootNode && el.getRootNode();
    if (root && root.host && isUnitElement(root.host)) return root.host;
    return null;
  }

  function isSubUnit(el) {
    var node = el;
    var depth = 0;
    while (node && depth < 12) {
      var tag = tagOf(node);
      var cls = String((node && node.className) || '');
      if (/replies/.test(tag) || /sub-reply/.test(cls) || /sub-reply/.test(tag)) return true;
      node = composedParent(node);
      depth++;
    }
    return false;
  }

  function deepQuery(node, selector, depth) {
    var out = [];
    var level = depth || 0;
    if (!node || level > 3) return out;
    try {
      var found = node.querySelectorAll ? node.querySelectorAll(selector) : [];
      for (var i = 0; i < found.length; i++) out.push(found[i]);
    } catch (err) {
      /* ignore */
    }
    if (level < 3) {
      try {
        if (node.shadowRoot) out = out.concat(deepQuery(node.shadowRoot, selector, level + 1));
        var all = node.querySelectorAll ? node.querySelectorAll('*') : [];
        for (var j = 0; j < all.length; j++) {
          if (all[j].shadowRoot) out = out.concat(deepQuery(all[j].shadowRoot, selector, level + 1));
        }
      } catch (err) {
        /* ignore */
      }
    }
    return out;
  }

  function findSpaceLink(unit) {
    // 优先从「用户信息组件」里取，避免把正文里 @ 别人的链接当成作者
    var candidates = [];
    var userInfo = deepQuery(unit, 'bili-comment-user-info', 0);
    for (var u = 0; u < userInfo.length; u++) {
      candidates = candidates.concat(deepQuery(userInfo[u], 'a[href*="space.bilibili.com/"]', 0));
    }
    candidates = candidates.concat(deepQuery(unit, '.sub-user-name a[href*="space.bilibili.com/"], .sub-user-name, #user-name a[href*="space.bilibili.com/"]', 0));
    candidates = candidates.concat(deepQuery(unit, 'a[href*="space.bilibili.com/"]', 0));

    var fallback = null;
    var seen = [];
    for (var i = 0; i < candidates.length; i++) {
      var a = candidates[i];
      if (!a || seen.indexOf(a) !== -1) continue;
      seen.push(a);
      var href = a.getAttribute('href') || '';
      if (!/space\.bilibili\.com\/(\d+)/.test(href)) continue;
      if (!fallback) fallback = a;
      var text = R.normalize(a.textContent || '');
      if (text) return { anchor: a, name: text };
    }
    return fallback ? { anchor: fallback, name: R.normalize(fallback.textContent || '') } : null;
  }

  function extractUnit(unit) {
    var info = { el: unit, uid: '', uname: '', text: '', isSub: isSubUnit(unit) };
    var link = findSpaceLink(unit);
    if (link) {
      var m = /space\.bilibili\.com\/(\d+)/.exec(link.anchor.getAttribute('href') || '');
      if (m) info.uid = m[1];
      info.uname = link.name;
    }
    if (!info.uid) {
      var holders = deepQuery(unit, '[data-user-profile-id], [data-user-id], [data-userid]', 0);
      for (var i = 0; i < holders.length; i++) {
        var v =
          holders[i].getAttribute('data-user-profile-id') ||
          holders[i].getAttribute('data-user-id') ||
          holders[i].getAttribute('data-userid');
        if (v) {
          info.uid = String(v);
          break;
        }
      }
    }
    // B 站新版评论正文在 <bili-rich-text> 的 shadow DOM 里（#contents）
    var rich = deepQuery(unit, 'bili-rich-text', 0);
    if (rich.length) {
      var richEl = rich[0];
      var richRoot = richEl.shadowRoot;
      var contents = richRoot && richRoot.querySelector('#contents');
      var richText = R.normalize((contents || richRoot || richEl).textContent || '');
      // 表情包没有文本，只有 img 的 alt（如 [doge]），补上以便识别
      if (contents) {
        var imgs = contents.querySelectorAll('img[alt]');
        for (var ii = 0; ii < imgs.length; ii++) {
          var alt = R.normalize(imgs[ii].getAttribute('alt') || '');
          if (alt) richText += ' ' + alt;
        }
      }
      info.text = R.normalize(richText);
    }
    if (!info.text) {
      var cls = deepQuery(unit, '.reply-content, .sub-reply-content', 0);
      if (cls.length) info.text = R.normalize(cls[0].textContent || '');
    }
    if (!info.text) {
      // 兜底：只在 shadow root 里找纯文本节点，避免把 <style> 的 CSS 当正文
      var textNodes = '';
      var root = unit.shadowRoot;
      if (root) {
        var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
        var node = walker.nextNode();
        var guard = 0;
        while (node && guard < 200) {
          guard++;
          textNodes += ' ' + (node.nodeValue || '');
          node = walker.nextNode();
        }
      }
      info.text = R.normalize(textNodes);
    }
    return info;
  }

  function collectUnits() {
    var set = new Set();
    roots.forEach(function (root) {
      try {
        var legacy = root.querySelectorAll('.reply-item, .sub-reply-item');
        for (var i = 0; i < legacy.length; i++) set.add(legacy[i]);
        var rich = root.querySelectorAll('bili-rich-text');
        for (var j = 0; j < rich.length; j++) {
          var unit = closestUnit(rich[j]);
          if (unit) set.add(unit);
        }
        var renderers = root.querySelectorAll('bili-comment-renderer');
        for (var k = 0; k < renderers.length; k++) set.add(renderers[k]);
      } catch (err) {
        /* ignore */
      }
    });
    return Array.from(set).filter(function (el) {
      return el && el.isConnected;
    });
  }

  // --------------------------------------------------------- 视觉：折叠/隐藏

  var origDisplay = new WeakMap();
  var unitBars = new WeakMap();
  var liveBars = [];

  function hideEl(el) {
    if (!origDisplay.has(el)) origDisplay.set(el, el.style.display || '');
    el.style.display = 'none';
  }

  function showEl(el) {
    if (origDisplay.has(el)) el.style.display = origDisplay.get(el) || '';
    else el.style.display = '';
  }

  function removeBars(unit) {
    var bars = unitBars.get(unit);
    if (!bars) return;
    ['collapse', 'mark'].forEach(function (k) {
      if (bars[k] && bars[k].parentNode) bars[k].parentNode.removeChild(bars[k]);
    });
    unitBars.delete(unit);
    liveBars = liveBars.filter(function (entry) {
      return entry.unit !== unit;
    });
  }

  /** 只摘掉「标记」条，保留折叠条（标记模式开关时用） */
  function removeMarkBar(unit) {
    var bars = unitBars.get(unit);
    if (!bars || !bars.mark) return;
    if (bars.mark.parentNode) bars.mark.parentNode.removeChild(bars.mark);
    delete bars.mark;
  }

  function makeButton(label, color, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.style.cssText =
      'border:1px solid ' +
      color +
      ';color:' +
      color +
      ';background:transparent;border-radius:10px;font-size:11px;padding:1px 8px;cursor:pointer;line-height:18px;';
    btn.addEventListener('click', function (event) {
      event.preventDefault();
      event.stopPropagation();
      onClick();
    });
    return btn;
  }

  function baseBarStyle() {
    return (
      'display:flex;align-items:center;gap:8px;flex-wrap:wrap;' +
      'margin:8px 0;padding:8px 12px;border:1px dashed #fb7299;border-radius:8px;' +
      'background:rgba(251,114,153,0.08);font-size:12px;color:#61666d;line-height:20px;'
    );
  }

  function ensureCollapseBar(unit, info, score, expanded) {
    var bars = unitBars.get(unit) || {};
    if (!bars.collapse || !bars.collapse.isConnected) {
      var bar = document.createElement('div');
      bar.setAttribute('data-bcs-bar', 'collapse');
      bar.style.cssText = baseBarStyle();
      var text = document.createElement('span');
      text.style.cssText = 'flex:1 1 auto;min-width:120px;';
      text.textContent =
        '🛡 疑似机器人评论 · ' + (info.uname || '未知账号') + (score ? ' · ' + score + ' 分' : '');
      var toggle = makeButton(expanded ? '收起' : '展开', '#fb7299', function () {
        unit.__bcsExpanded = !unit.__bcsExpanded;
        applyUnit(unit, info, true);
      });
      bar.appendChild(text);
      bar.appendChild(toggle);
      insertBar(unit, bar);
      bars.collapse = bar;
    } else {
      var btn = bars.collapse.querySelector('button');
      if (btn) btn.textContent = expanded ? '收起' : '展开';
      var span = bars.collapse.querySelector('span');
      if (span) {
        span.textContent =
          '🛡 疑似机器人评论 · ' + (info.uname || '未知账号') + (score ? ' · ' + score + ' 分' : '');
      }
    }
    bars.collapse.__bcsScore = score;
    unitBars.set(unit, bars);
    trackBar(bars.collapse, unit);
  }

  function ensureMarkBar(unit, info) {
    var bars = unitBars.get(unit) || {};
    if (!bars.mark || !bars.mark.isConnected) {
      var bar = document.createElement('div');
      bar.setAttribute('data-bcs-bar', 'mark');
      bar.style.cssText =
        'display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin:6px 0;padding:4px 8px;' +
        'border-radius:8px;background:rgba(0,161,214,0.06);font-size:11px;color:#9499a0;';
      var tip = document.createElement('span');
      tip.textContent = '标记：';
      bar.appendChild(tip);
      bar.appendChild(
        makeButton('🛡 标记机器人', '#fb7299', function () {
          markAccount(info.uid, info.uname, 'bot');
        })
      );
      bar.appendChild(
        makeButton('这是真人', '#9499a0', function () {
          markAccount(info.uid, info.uname, 'human');
        })
      );
      insertBar(unit, bar);
      bars.mark = bar;
    }
    unitBars.set(unit, bars);
    trackBar(bars.mark, unit);
  }

  function insertBar(unit, bar) {
    var parent = unit.parentNode;
    if (!parent) return;
    try {
      parent.insertBefore(bar, unit.nextSibling);
    } catch (err) {
      try {
        parent.appendChild(bar);
      } catch (e) {
        /* ignore */
      }
    }
  }

  function trackBar(bar, unit) {
    liveBars.push({ bar: bar, unit: unit });
    if (liveBars.length > 400) liveBars = liveBars.filter(function (e) { return e.bar.isConnected; });
  }

  function cleanupBars() {
    liveBars = liveBars.filter(function (entry) {
      var ok = entry.bar.isConnected && entry.unit.isConnected;
      if (!ok && entry.bar.parentNode) {
        try {
          entry.bar.parentNode.removeChild(entry.bar);
        } catch (err) {
          /* ignore */
        }
      }
      return ok;
    });
  }

  function applyUnit(unit, info, force) {
    var settings = state.settings;
    var uid = String(info.uid || '');
    var forced = !!(state.learned[uid] || R.matchesBlockedName(info.uname, state.nameBlocks));
    var whitelisted = !!(state.whitelist[uid]);
    var result = null;
    if (!forced && !whitelisted) {
      result = R.scoreComment({ message: info.text, uname: info.uname, isSub: info.isSub }, { level: settings.level });
    }
    var hit = !!(forced || (result && result.hit));
    var score = result ? result.score : 0;

    var expanded = !!unit.__bcsExpanded;
    var barsNow = unitBars.get(unit) || {};
    var sig = [
      settings.enabled ? 1 : 0,
      settings.mode,
      settings.level,
      settings.markMode ? 1 : 0,
      forced ? 1 : 0,
      whitelisted ? 1 : 0,
      hit ? 1 : 0,
      expanded ? 1 : 0,
      unit.style.display === 'none' ? 1 : 0,
      barsNow.collapse && barsNow.collapse.isConnected ? 1 : 0,
      barsNow.mark && barsNow.mark.isConnected ? 1 : 0,
      uid,
      info.uname,
      String(info.text || '').slice(0, 24)
    ].join('|');
    if (!force && unit.__bcsSig === sig) return;
    unit.__bcsSig = sig;

    try {
      if (!settings.enabled) {
        removeBars(unit);
        showEl(unit);
        return;
      }
      if (forced) {
        removeBars(unit);
        // 「仅记录」模式下不改变页面，只把学习结果记下来；切回折叠/隐藏时才生效
        if (settings.mode === 'observe') showEl(unit);
        else hideEl(unit);
        return;
      }
      if (whitelisted || !hit) {
        removeBars(unit);
        showEl(unit);
        if (settings.markMode && uid) ensureMarkBar(unit, info);
        return;
      }
      if (settings.mode === 'observe') {
        removeBars(unit);
        showEl(unit);
        if (settings.markMode && uid) ensureMarkBar(unit, info);
        return;
      }
      if (settings.mode === 'hide') {
        removeBars(unit);
        hideEl(unit);
        return;
      }
      // collapse
      ensureCollapseBar(unit, info, score, expanded);
      if (expanded) showEl(unit);
      else hideEl(unit);
      if (settings.markMode && uid) ensureMarkBar(unit, info);
      else removeMarkBar(unit);
    } catch (err) {
      try {
        showEl(unit);
      } catch (e) {
        /* ignore */
      }
    }
  }

  var injectedLogged = false;
  var scanLogCount = 0;

  function runScan() {
    markStage('scan-enter');
    try {
      cleanupBars();
      var units = collectUnits();
      if (!units.length) {
        // 有时自定义元素先插入、后 attachShadow，或嵌套较深：再探一轮
        discoverIn(document);
        roots.forEach(function (root) {
          discoverIn(root);
        });
        units = collectUnits();
      }
      lastScanUnits = units.length;
      lastCollapseBars = 0;
      roots.forEach(function (root) {
        try {
          lastCollapseBars += root.querySelectorAll('[data-bcs-bar="collapse"]').length;
        } catch (err) {
          /* ignore */
        }
      });
      try {
        document.documentElement.setAttribute('data-bcs-units', String(units.length));
        document.documentElement.setAttribute('data-bcs-collapsed', String(lastCollapseBars));
      } catch (err) {
        /* ignore */
      }
      markStage('scan-done:' + units.length);
    } catch (scanError) {
      try {
        console.error('[别看大肥鱼了] 扫描失败：', scanError);
      } catch (err) {
        /* ignore */
      }
      markStage('scan-error:' + (scanError && scanError.message ? scanError.message : scanError));
      return;
    }
    if (scanLogCount < 3) {
      scanLogCount += 1;
      try {
        console.info(
          '[别看大肥鱼了] 扫描：' + units.length + ' 条评论，折叠条 ' + lastCollapseBars + ' 个'
        );
      } catch (err) {
        /* ignore */
      }
    } else if (units.length && !injectedLogged) {
      injectedLogged = true;
      try {
        console.info('[别看大肥鱼了] 已注入，本页扫描到 ' + units.length + ' 条评论');
      } catch (err) {
        /* ignore */
      }
    }
    for (var i = 0; i < units.length; i++) {
      var unit = units[i];
      if (!unit || !unit.isConnected) continue;
      var info;
      try {
        info = extractUnit(unit);
      } catch (err) {
        continue;
      }
      if (!info) continue;
      // 标记模式下即使正文是纯表情也要给「标记」按钮
      if (!info.text && !state.settings.markMode) continue;
      applyUnit(unit, info, false);
    }
  }

  // --------------------------------------------------------- 手动标记 / 白名单

  async function markAccount(uid, uname, kind) {
    if (!uid) return;
    var raw = await storageGet();
    var s = normalize(raw);
    if (kind === 'bot') {
      s.learned[uid] = { uname: uname || '', addedAt: Date.now(), source: 'manual', hits: 1 };
      delete s.strikes[uid];
      delete s.whitelist[uid];
    } else {
      s.whitelist[uid] = { uname: uname || '', addedAt: Date.now() };
      delete s.learned[uid];
      delete s.strikes[uid];
    }
    await storageSet({ learned: s.learned, whitelist: s.whitelist, strikes: s.strikes });
    toast(kind === 'bot' ? '已隐藏该账号：' + (uname || uid) : '已加入白名单：' + (uname || uid));
  }

  var toastTimer = 0;
  function toast(message) {
    try {
      var el = document.getElementById('bcs-toast');
      if (!el) {
        el = document.createElement('div');
        el.id = 'bcs-toast';
        el.style.cssText =
          'position:fixed;left:50%;top:18px;transform:translateX(-50%);z-index:2147483647;' +
          'padding:8px 14px;border-radius:8px;background:rgba(24,25,28,0.92);color:#fff;' +
          'font-size:12px;line-height:18px;box-shadow:0 4px 16px rgba(0,0,0,0.2);pointer-events:none;' +
          'max-width:80vw;';
        document.body.appendChild(el);
      }
      el.textContent = message;
      el.style.display = 'block';
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () {
        el.style.display = 'none';
      }, 1800);
    } catch (err) {
      /* ignore */
    }
  }

  // --------------------------------------------------------- 启动 & 热更新

  var reloadTimer = 0;
  function scheduleReload() {
    if (reloadTimer) return;
    reloadTimer = setTimeout(function () {
      reloadTimer = 0;
      reload();
    }, 220);
  }

  try {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === 'local') scheduleReload();
    });
  } catch (err) {
    /* ignore */
  }

  function watchUrl() {
    if (location.href !== lastHref) {
      lastHref = location.href;
      forceToken++;
      scheduleScan(true);
    }
  }

  function start() {
    markStage('start-enter');
    try {
      observeRoot(document);
      discoverIn(document);
      markStage('start-observed');
      setInterval(function () {
        watchUrl();
      }, 800);
      setInterval(function () {
        discoverIn(document);
        roots.forEach(function (root) {
          if (root !== document) discoverIn(root);
        });
        scheduleScan(false);
      }, 1200);
      reload();
      scheduleScan(true);
      markStage('started');
      setTimeout(function () {
        if (lastScanUnits) return;
        try {
          console.warn(
            '[别看大肥鱼了] 4 秒内没扫描到评论节点：可能评论区还没加载，或 B 站页面结构变了。href=' +
              location.href
          );
        } catch (err) {
          /* ignore */
        }
      }, 4500);
    } catch (startError) {
      try {
        console.error('[别看大肥鱼了] 启动失败：', startError);
      } catch (err) {
        /* ignore */
      }
      markStage('start-error:' + (startError && startError.message ? startError.message : startError));
      // 即使监听/定时器起不来，也先扫一遍，至少把已有评论折叠掉
      try {
        runScan();
      } catch (scanError) {
        try {
          console.error('[别看大肥鱼了] 兜底扫描失败：', scanError);
        } catch (err) {
          /* ignore */
        }
      }
    }
  }

  // document_start 就启动：先把配置读出来（异步），同时开始监听 DOM
  try {
    start();
  } catch (startError) {
    try {
      console.error('[别看大肥鱼了] 初始化失败：', startError);
    } catch (err) {
      /* ignore */
    }
    markStage('init-error:' + (startError && startError.message ? startError.message : startError));
  }

  // 兜底：无论 start() 是否成功，1.5 秒后都再扫一次
  setTimeout(function () {
    if (lastScanUnits > 0) return;
    try {
      runScan();
    } catch (err) {
      try {
        console.error('[别看大肥鱼了] 兜底扫描失败：', err);
      } catch (e) {
        /* ignore */
      }
    }
  }, 1500);
})();
