/**
 * main-world.js —— 运行在页面主世界（world: MAIN），document_start。
 *
 * 只做两件事：
 *   1. 拦截 B 站评论接口的 fetch 响应，在 B 站前端读取之前把命中的评论摘掉（hide 模式），
 *      或原样放行（collapse / observe 模式）；
 *   2. 把「疑似命中」的评论通过 CustomEvent 交给隔离世界（content.js）去计数、学习、折叠。
 *
 * 不碰账号、不发网络请求、不读 cookie。任何异常都不得影响页面。
 */
(function () {
  'use strict';
  if (window.__BCS_MAIN__) return;
  window.__BCS_MAIN__ = true;

  var R = window.BSH_RULES;
  if (!R) return;

  var EVENT_CONFIG = 'bcs-config';
  var EVENT_DETECT = 'bcs-detections';

  try {
    console.info('[别看大肥鱼了] main-world 已注入：' + location.href);
    document.documentElement.setAttribute('data-bcs-main', '1');
  } catch (err) {
    /* ignore */
  }

  // 页面默认配置（content.js 启动后会推一份真实配置过来）
  var state = {
    enabled: true,
    mode: 'collapse', // collapse | hide | observe
    level: 'balanced',
    learned: new Set(),
    whitelist: new Set(),
    nameBlocks: []
  };

  var emitted = new Set(); // 同一 rpid 只上报一次（翻页/重渲染去重）

  function safe(fn, fallback) {
    try {
      return fn();
    } catch (err) {
      return fallback;
    }
  }

  window.addEventListener(EVENT_CONFIG, function (event) {
    safe(function () {
      var detail = event && event.detail;
      if (!detail) return;
      if (detail.settings) {
        state.enabled = detail.settings.enabled !== false;
        state.mode = detail.settings.mode || 'collapse';
        state.level = detail.settings.level || 'balanced';
      }
      if (Array.isArray(detail.learnedUids)) {
        state.learned = new Set(detail.learnedUids.map(String));
      }
      if (Array.isArray(detail.whitelistUids)) {
        state.whitelist = new Set(detail.whitelistUids.map(String));
      }
      if (Array.isArray(detail.nameBlocks)) {
        state.nameBlocks = detail.nameBlocks;
      }
    });
  });

  function getBvid() {
    var m = /\/video\/(BV[0-9A-Za-z]+)/.exec(location.pathname);
    if (m) return m[1];
    m = /[?&]bvid=(BV[0-9A-Za-z]+)/.exec(location.search);
    return m ? m[1] : '';
  }

  function isCommentApi(url) {
    if (!url) return false;
    // 只认读评论：/x/v2/reply/main、/x/v2/reply/wbi/main、/x/v2/reply/reply
    return /\/x\/v2\/reply\/(?:wbi\/)?(?:main|reply)(?:[\/?#]|$)/.test(url);
  }

  function isSubContext(url) {
    return /\/x\/v2\/reply\/reply(?:[\/?#]|$)/.test(url || '');
  }

  function textOf(entry) {
    var content = entry && entry.content;
    if (!content) return '';
    if (typeof content.message === 'string') return content.message;
    if (content.message && typeof content.message === 'object') {
      // 部分接口会把 message 包成 {message: '...'}
      return String(content.message.message || '');
    }
    return '';
  }

  function memberOf(entry) {
    return (entry && entry.member) || {};
  }

  function readEntry(entry, isSub) {
    if (!entry || typeof entry !== 'object') return null;
    var member = memberOf(entry);
    var mid = member.mid != null ? member.mid : entry.mid;
    if (mid == null) return null;
    return {
      entry: entry,
      mid: String(mid),
      uname: R.normalize(member.uname || ''),
      message: R.normalize(textOf(entry)),
      rpid: entry.rpid != null ? String(entry.rpid) : '',
      isSub: !!isSub
    };
  }

  /** 收集本次响应里的所有评论（顶层 + 楼中楼预览），标注是否属于楼中楼 */
  function collectAll(data, subContext) {
    var out = [];
    if (!data || typeof data !== 'object') return out;

    function pushList(list, isSub) {
      if (!Array.isArray(list)) return;
      for (var i = 0; i < list.length; i++) {
        var item = readEntry(list[i], isSub);
        if (!item) continue;
        out.push(item);
        // 顶层评论里可能内嵌两条楼中楼预览
        var subReplies = list[i] && list[i].replies;
        if (Array.isArray(subReplies)) {
          for (var j = 0; j < subReplies.length; j++) {
            var sub = readEntry(subReplies[j], true);
            if (sub) out.push(sub);
          }
        }
      }
    }

    if (subContext) {
      pushList(data.replies, true);
    } else {
      pushList(data.replies, false);
      pushList(data.top_replies, false);
      if (data.top && typeof data.top === 'object') {
        pushList(data.top.replies, false);
      }
    }
    return out;
  }

  function isForced(item) {
    if (state.whitelist.has(item.mid)) return false;
    if (state.learned.has(item.mid)) return true;
    return R.matchesBlockedName(item.uname, state.nameBlocks || []);
  }

  function isWhitelisted(item) {
    return state.whitelist.has(item.mid);
  }

  function report(items, mode) {
    if (!items.length) return;
    var action = mode === 'hide' ? 'hidden' : mode === 'observe' ? 'observed' : 'collapsed';
    var bvid = getBvid();
    var payload = [];
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var key = item.rpid || (item.mid + ':' + item.message.slice(0, 40));
      if (emitted.has(key)) continue;
      emitted.add(key);
      if (emitted.size > 2000) emitted.clear();
      payload.push({
        mid: item.mid,
        uname: item.uname,
        rpid: item.rpid,
        key: key,
        text: item.message.slice(0, 200),
        score: item.score,
        reasons: item.reasons,
        isSub: item.isSub,
        action: action,
        bvid: bvid,
        at: Date.now()
      });
    }
    if (!payload.length) return;
    safe(function () {
      window.dispatchEvent(new CustomEvent(EVENT_DETECT, { detail: { items: payload } }));
    });
  }

  /** 处理一次评论接口响应；返回 true 表示 JSON 被修改过 */
  function processPayload(url, json) {
    if (!state.enabled) return false;
    if (!json || json.code !== 0 || !json.data) return false;

    var subContext = isSubContext(url);
    var all = collectAll(json.data, subContext);
    if (!all.length) return false;

    // 顶层评论用于「同页多账号同模板」聚类
    var topTexts = [];
    for (var i = 0; i < all.length; i++) {
      if (!all[i].isSub) topTexts.push({ uid: all[i].mid, text: all[i].message });
    }

    var remove = [];
    var detections = [];

    for (var k = 0; k < all.length; k++) {
      var item = all[k];

      if (isWhitelisted(item)) continue;

      if (isForced(item)) {
        // 已学习 / 手动屏蔽：除了「仅记录」外都直接从接口层摘掉（页面根本拿不到）
        if (state.mode !== 'observe') remove.push(item);
        continue;
      }

      // 楼中楼只由 ID/名字规则处理，不参与启发式判定（避免误伤正常回复）
      if (item.isSub) continue;

      var result = R.scoreComment(
        { message: item.message, uname: item.uname, isSub: false },
        { level: state.level }
      );
      var score = result.score;
      var reasons = result.reasons.slice();

      if (R.hasCluster(topTexts, item.message, item.mid)) {
        score += 2;
        reasons.push('同页多账号同模板');
      }

      if (score < result.threshold) continue;

      item.score = score;
      item.reasons = reasons;
      detections.push(item);
      if (state.mode === 'hide') remove.push(item);
    }

    report(detections, state.mode);

    if (!remove.length) return false;

    // 从数组里摘掉（顶层评论整条拿走，楼中楼只摘命中的那条）
    var removed = new Set();
    for (var r = 0; r < remove.length; r++) {
      if (remove[r].rpid) removed.add(remove[r].rpid);
      else remove[r].entry.__bcsRemove = true;
    }

    function filterList(list) {
      if (!Array.isArray(list)) return;
      for (var idx = list.length - 1; idx >= 0; idx--) {
        var entry = list[idx];
        if (!entry) continue;
        if (entry.__bcsRemove || (entry.rpid != null && removed.has(String(entry.rpid)))) {
          list.splice(idx, 1);
          continue;
        }
        if (Array.isArray(entry.replies)) filterList(entry.replies);
      }
    }

    if (subContext) filterList(json.data.replies);
    else {
      filterList(json.data.replies);
      filterList(json.data.top_replies);
      if (json.data.top && typeof json.data.top === 'object') filterList(json.data.top.replies);
    }
    return true;
  }

  // ---- 拦截 fetch ----
  var nativeFetch = window.fetch;
  if (typeof nativeFetch === 'function') {
    window.fetch = function (input, init) {
      var request;
      safe(function () {
        if (typeof Request !== 'undefined' && input instanceof Request) request = input;
      });
      var url = request ? request.url : typeof input === 'string' ? input : input && input.url;
      var method = (init && init.method) || (request && request.method) || 'GET';

      var promise = nativeFetch.apply(this, arguments);
      if (!isCommentApi(url) || String(method).toUpperCase() !== 'GET') return promise;

      return promise.then(function (response) {
        return safe(function () {
          if (!response || !response.ok) return response;
          var type = response.headers.get('content-type') || '';
          if (type.indexOf('json') === -1) return response;
          return response
            .clone()
            .text()
            .then(function (body) {
              return safe(function () {
                var json = JSON.parse(body);
                var changed = processPayload(url, json);
                if (!changed) return response;
                return new Response(JSON.stringify(json), {
                  status: response.status,
                  statusText: response.statusText,
                  headers: response.headers
                });
              }, response);
            })
            .catch(function () {
              return response;
            });
        }, response);
      });
    };
  }

  // ---- 兜底：B 站若改用 XMLHttpRequest（当前版本用 fetch），DOM 层仍能折叠/隐藏 ----
  // 这里不做 XHR 改写（改写 response 只读属性风险高），由 content.js 的 DOM 扫描兜底。
})();
