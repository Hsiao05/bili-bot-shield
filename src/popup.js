/* 「别看大肥鱼了！」popup 控制面板
 * ------------------------------------------------------------------
 * 数据契约：chrome.storage.local（直接读写，不经过消息）
 * 读写原则：
 *   1. 读取一律 chrome.storage.local.get(null)，再用默认值深合并，缺字段按默认；
 *   2. 写入一律先 get 最新值、改字段、再 set(patch)，不整块覆盖、不丢别的字段；
 *   3. 监听 chrome.storage.onChanged：页面脚本/其他窗口改了数据，面板自动重渲染。
 * 权限：
 *   - storage：读写设置与账号数据；
 *   - activeTab / scripting：仅用于顶部「页面注入状态」诊断（检测/补注入 content script），不发网络请求。
 * 页面标记按钮由 content.js 根据 settings.markMode 显示，本面板只负责开关与文案。
 * ------------------------------------------------------------------ */
'use strict';

const DEFAULT_SETTINGS = {
  enabled: true,
  mode: 'collapse',          // 'collapse' 折叠（默认） | 'hide' 隐藏 | 'observe' 仅记录
  level: 'balanced',         // 'conservative' | 'balanced'（默认） | 'aggressive'
  autoLearn: true,
  learnAfter: 3,             // 同一账号命中几次后按 UID 隐藏
  markMode: false,           // 手动标记模式：默认关闭，由本面板开关控制
  markModeMigrated: false,   // 一次性迁移标记（旧版「打开面板自动开标记」→ false）
  theme: 'auto'              // 'auto' 跟随设备（默认） | 'light' 浅色 | 'dark' 深色
};

const DEFAULT_STATS = {
  total: 0,
  today: { date: '', collapsed: 0, hidden: 0 }
};

const LEARN_STEPS = [2, 3, 5, 10];
const THEMES = ['auto', 'light', 'dark'];

const UI = {};
let current = null;
let toastTimer = 0;
let refreshTimer = 0;
let storageListenerBound = false;
// 写操作串行化：避免快速连点两个开关时，两个「读-改-写」互相覆盖
let writeChain = Promise.resolve();

/* ================================================================
 * 启动
 * ================================================================ */

async function boot() {
  cacheDom();
  setVersion();
  bindEvents();
  bindStorageListener();

  // 一次性迁移：旧版每次打开面板都会把 markMode 置 true，新版改为默认关闭。
  await migrateMarkModeOnce();

  try {
    const raw = await chrome.storage.local.get(null);
    current = mergeState(raw);
    render();
  } catch (error) {
    showError('读取扩展数据失败：' + errorText(error));
    current = mergeState({});
    render();
  }

  refreshPageStatus();
}

/* 旧数据兼容：只在第一次升级到新版时执行一次。
 * 旧版 markMode 可能是被「打开面板自动开启」写进去的 true，这里重置为 false 并记下迁移标记。 */
async function migrateMarkModeOnce() {
  try {
    const raw = await chrome.storage.local.get(null);
    const rawSettings = isPlainObject(raw.settings) ? raw.settings : {};
    if (rawSettings.markModeMigrated === true) return;

    const settings = {
      ...mergeState(raw).settings,
      markMode: false,
      markModeMigrated: true
    };
    await chrome.storage.local.set({ settings: settings });
  } catch (error) {
    showError('设置迁移失败：' + errorText(error));
  }
}

/* 当前页面注入状态 + 未注入时尝试补注入（点图标会授予 activeTab） */
async function refreshPageStatus() {
  const el = UI['page-status'];
  if (!el) return;
  const set = (text, state) => {
    el.textContent = text;
    el.dataset.state = state;
  };

  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs && tabs[0];
    if (!tab || !tab.id) {
      set('没有找到当前标签页', 'warn');
      return;
    }

    let res = null;
    try {
      res = await chrome.tabs.sendMessage(tab.id, { type: 'bcs-ping' });
    } catch (error) {
      res = null;
    }

    if (!res || !res.ok) {
      // 页面脚本可能没注入（例如装完没刷新、站点访问权限/版本差异），这里补一次
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['src/rules.js', 'src/content.js']
        });
      } catch (error) {
        /* 非 B 站页面会失败，下面统一提示 */
      }
      try {
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'MAIN',
          files: ['src/rules.js', 'src/main-world.js']
        });
      } catch (error) {
        /* main-world 失败不影响折叠，忽略 */
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
      try {
        res = await chrome.tabs.sendMessage(tab.id, { type: 'bcs-ping' });
      } catch (error) {
        res = null;
      }
    }

    if (!res || !res.ok) {
      // 消息通道没通：再从页面标记里读一次，区分「没注入」和「注入了但监听没起来」
      let info = null;
      try {
        const probed = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => ({
            loaded: document.documentElement.dataset.bcsLoaded || '',
            ver: document.documentElement.dataset.bcsVer || '',
            stage: document.documentElement.dataset.bcsStage || '',
            units: document.documentElement.dataset.bcsUnits || '',
            main: document.documentElement.dataset.bcsMain || ''
          })
        });
        info = probed && probed[0] && probed[0].result;
      } catch (error) {
        info = null;
      }
      if (info && info.loaded) {
        set(
          `页面有脚本标记，但消息通道没通（ver=${info.ver || '-'}，stage=${info.stage || '-'}，units=${info.units || '-'}，main=${info.main || '-'}）`,
          'warn'
        );
      } else {
        set('未检测到页面脚本：请确认当前是 B 站视频/动态页，并刷新一次页面', 'error');
      }
      return;
    }

    const modeText = { collapse: '折叠', hide: '隐藏', observe: '仅记录' }[res.mode] || res.mode;
    const markText = res.markMode ? ' · 手动标记模式' : '';
    if (res.units > 0) {
      set(
        `✅ 已注入 v${res.ver || '?'}：本页扫描到 ${res.units} 条评论，当前「${modeText}」${markText}`,
        'ok'
      );
    } else {
      set(
        `⚠️ 已注入 v${res.ver || '?'}，但还没扫描到评论（stage=${res.stage || '-'}）：向下滚动评论区或刷新页面再试`,
        'warn'
      );
    }
  } catch (error) {
    set('检测失败：' + errorText(error), 'error');
  }
}

/* ================================================================
 * 主题
 * ================================================================ */

function applyTheme(theme) {
  const value = THEMES.indexOf(theme) === -1 ? 'auto' : theme;
  document.documentElement.dataset.theme = value;
}

/* ================================================================
 * DOM 缓存
 * ================================================================ */

function cacheDom() {
  UI['version'] = document.getElementById('version');
  UI['error-bar'] = document.getElementById('error-bar');
  UI['page-status'] = document.getElementById('page-status');
  UI['theme-auto'] = document.getElementById('theme-auto');
  UI['theme-light'] = document.getElementById('theme-light');
  UI['theme-dark'] = document.getElementById('theme-dark');
  UI['enabled-toggle'] = document.getElementById('enabled-toggle');
  UI['mode-collapse'] = document.getElementById('mode-collapse');
  UI['mode-hide'] = document.getElementById('mode-hide');
  UI['mode-observe'] = document.getElementById('mode-observe');
  UI['markmode-toggle'] = document.getElementById('markmode-toggle');
  UI['level-conservative'] = document.getElementById('level-conservative');
  UI['level-balanced'] = document.getElementById('level-balanced');
  UI['level-aggressive'] = document.getElementById('level-aggressive');
  UI['autolearn-toggle'] = document.getElementById('autolearn-toggle');
  UI['learn-after-select'] = document.getElementById('learn-after-select');
  UI['name-input'] = document.getElementById('name-input');
  UI['name-add'] = document.getElementById('name-add');
  UI['name-list'] = document.getElementById('name-list');
  UI['name-empty'] = document.getElementById('name-empty');
  UI['learned-count'] = document.getElementById('learned-count');
  UI['learned-list'] = document.getElementById('learned-list');
  UI['learned-empty'] = document.getElementById('learned-empty');
  UI['whitelist-count'] = document.getElementById('whitelist-count');
  UI['whitelist-list'] = document.getElementById('whitelist-list');
  UI['whitelist-empty'] = document.getElementById('whitelist-empty');
  UI['stat-collapsed'] = document.getElementById('stat-collapsed');
  UI['stat-hidden'] = document.getElementById('stat-hidden');
  UI['stat-total'] = document.getElementById('stat-total');
  UI['stat-learned'] = document.getElementById('stat-learned');
  UI['export-btn'] = document.getElementById('export-btn');
  UI['import-btn'] = document.getElementById('import-btn');
  UI['clear-btn'] = document.getElementById('clear-btn');
  UI['import-file'] = document.getElementById('import-file');
  UI['toast'] = document.getElementById('toast');
}

function setVersion() {
  try {
    UI['version'].textContent = 'v' + chrome.runtime.getManifest().version;
  } catch (error) {
    UI['version'].textContent = 'v?';
  }
}

/* ================================================================
 * 事件绑定
 * ================================================================ */

function bindEvents() {
  // 外观：先立即套用主题（不等 storage 回写），再持久化
  bindRadioGroup(['theme-auto', 'theme-light', 'theme-dark'], 'theme', function (value) {
    applyTheme(value);
  });

  UI['enabled-toggle'].addEventListener('change', function () {
    updateSettings({ enabled: UI['enabled-toggle'].checked });
  });

  bindRadioGroup(['mode-collapse', 'mode-hide', 'mode-observe'], 'mode');
  bindRadioGroup(['level-conservative', 'level-balanced', 'level-aggressive'], 'level');

  UI['autolearn-toggle'].addEventListener('change', function () {
    updateSettings({ autoLearn: UI['autolearn-toggle'].checked });
  });

  UI['learn-after-select'].addEventListener('change', function () {
    const value = Number(UI['learn-after-select'].value);
    if (LEARN_STEPS.indexOf(value) === -1) return;
    updateSettings({ learnAfter: value });
  });

  UI['markmode-toggle'].addEventListener('change', async function () {
    await updateSettings({ markMode: UI['markmode-toggle'].checked });
    // 开关会影响页面上的标记按钮，顺手刷新顶部状态文案
    refreshPageStatus();
  });

  UI['name-add'].addEventListener('click', addBlockedName);
  UI['name-input'].addEventListener('keydown', function (event) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    addBlockedName();
  });

  UI['name-list'].addEventListener('click', function (event) {
    const button = closestAction(event, 'remove-name');
    if (!button) return;
    removeBlockedName(button.dataset.name || '');
  });

  UI['learned-list'].addEventListener('click', function (event) {
    const button = closestAction(event, 'remove-learned');
    if (!button) return;
    removeLearned(button.dataset.uid || '');
  });

  UI['whitelist-list'].addEventListener('click', function (event) {
    const button = closestAction(event, 'remove-whitelist');
    if (!button) return;
    removeWhitelist(button.dataset.uid || '');
  });

  UI['export-btn'].addEventListener('click', exportData);

  UI['import-btn'].addEventListener('click', function () {
    UI['import-file'].value = '';
    UI['import-file'].click();
  });
  UI['import-file'].addEventListener('change', handleImportFile);

  UI['clear-btn'].addEventListener('click', clearAllData);
}

function bindRadioGroup(ids, key, onChange) {
  ids.forEach(function (id) {
    const input = UI[id];
    input.addEventListener('change', function () {
      if (!input.checked) return;
      if (typeof onChange === 'function') onChange(input.value);
      const patch = {};
      patch[key] = input.value;
      updateSettings(patch);
    });
  });
}

function bindStorageListener() {
  if (storageListenerBound) return;
  if (!chrome.storage || !chrome.storage.onChanged) return;
  storageListenerBound = true;
  chrome.storage.onChanged.addListener(function (changes, areaName) {
    if (areaName !== 'local') return;
    scheduleRefresh();
  });
}

function closestAction(event, action) {
  const target = event.target;
  if (!target || !target.closest) return null;
  return target.closest('[data-action="' + action + '"]');
}

/* ================================================================
 * 渲染
 * ================================================================ */

function render() {
  if (!current) return;
  renderSettings();
  renderNameBlocks();
  renderLearned();
  renderWhitelist();
  renderStats();
}

function renderSettings() {
  const settings = current.settings;

  UI['theme-auto'].checked = settings.theme === 'auto';
  UI['theme-light'].checked = settings.theme === 'light';
  UI['theme-dark'].checked = settings.theme === 'dark';
  applyTheme(settings.theme);

  UI['enabled-toggle'].checked = settings.enabled !== false;
  UI['mode-collapse'].checked = settings.mode === 'collapse';
  UI['mode-hide'].checked = settings.mode === 'hide';
  UI['mode-observe'].checked = settings.mode === 'observe';
  UI['markmode-toggle'].checked = settings.markMode === true;
  UI['level-conservative'].checked = settings.level === 'conservative';
  UI['level-balanced'].checked = settings.level === 'balanced';
  UI['level-aggressive'].checked = settings.level === 'aggressive';
  UI['autolearn-toggle'].checked = settings.autoLearn !== false;
  UI['learn-after-select'].value = String(settings.learnAfter);
  UI['learn-after-select'].disabled = settings.autoLearn === false;
}

function renderNameBlocks() {
  const source = Array.isArray(current.nameBlocks) ? current.nameBlocks : [];
  const names = source
    .map(blockNameOf)
    .filter(function (name) {
      return !!name;
    });

  const list = UI['name-list'];
  list.textContent = '';
  names.forEach(function (name) {
    const chip = el('span', 'chip');
    chip.appendChild(el('span', 'chip-name', name));
    const remove = el('button', 'chip-x', '×');
    remove.type = 'button';
    remove.dataset.action = 'remove-name';
    remove.dataset.name = name;
    remove.setAttribute('aria-label', '删除 ' + name);
    chip.appendChild(remove);
    list.appendChild(chip);
  });
  UI['name-empty'].hidden = names.length > 0;
}

function renderLearned() {
  const learned = isPlainObject(current.learned) ? current.learned : {};
  const entries = Object.keys(learned).map(function (uid) {
    const info = isPlainObject(learned[uid]) ? learned[uid] : {};
    return {
      uid: uid,
      uname: cleanText(info.uname, 40),
      hits: toCount(info.hits),
      source: info.source === 'manual' ? 'manual' : 'auto',
      addedAt: toCount(info.addedAt)
    };
  }).sort(function (a, b) {
    return (b.addedAt - a.addedAt) || String(a.uid).localeCompare(String(b.uid));
  });

  const list = UI['learned-list'];
  list.textContent = '';
  entries.forEach(function (entry) {
    const item = el('li', 'account');
    const info = el('div', 'account-info');
    info.appendChild(el('span', 'account-name', entry.uname || '（无昵称）'));
    info.appendChild(el('span', 'account-meta',
      'UID ' + entry.uid + ' · 命中 ' + entry.hits + ' 次 · ' +
      (entry.source === 'manual' ? '手动标记' : '自动学习')));
    const remove = el('button', 'row-btn', '删除');
    remove.type = 'button';
    remove.dataset.action = 'remove-learned';
    remove.dataset.uid = entry.uid;
    item.appendChild(info);
    item.appendChild(remove);
    list.appendChild(item);
  });
  UI['learned-count'].textContent = String(entries.length);
  UI['learned-empty'].hidden = entries.length > 0;
}

function renderWhitelist() {
  const whitelist = isPlainObject(current.whitelist) ? current.whitelist : {};
  const entries = Object.keys(whitelist).map(function (uid) {
    const info = isPlainObject(whitelist[uid]) ? whitelist[uid] : {};
    return {
      uid: uid,
      uname: cleanText(info.uname, 40),
      addedAt: toCount(info.addedAt)
    };
  }).sort(function (a, b) {
    return (b.addedAt - a.addedAt) || String(a.uid).localeCompare(String(b.uid));
  });

  const list = UI['whitelist-list'];
  list.textContent = '';
  entries.forEach(function (entry) {
    const item = el('li', 'account');
    const info = el('div', 'account-info');
    info.appendChild(el('span', 'account-name', entry.uname || '（无昵称）'));
    info.appendChild(el('span', 'account-meta', 'UID ' + entry.uid));
    const remove = el('button', 'row-btn', '删除');
    remove.type = 'button';
    remove.dataset.action = 'remove-whitelist';
    remove.dataset.uid = entry.uid;
    item.appendChild(info);
    item.appendChild(remove);
    list.appendChild(item);
  });
  UI['whitelist-count'].textContent = String(entries.length);
  UI['whitelist-empty'].hidden = entries.length > 0;
}

function renderStats() {
  const stats = isPlainObject(current.stats) ? current.stats : DEFAULT_STATS;
  const today = isPlainObject(stats.today) ? stats.today : {};
  // 今天的日期对不上（换天了、页面脚本还没写新数据）时，今日数字按 0 展示，避免拿昨天的数字充今天
  const fresh = today.date === dateKey();
  UI['stat-collapsed'].textContent = String(fresh ? toCount(today.collapsed) : 0);
  UI['stat-hidden'].textContent = String(fresh ? toCount(today.hidden) : 0);
  UI['stat-total'].textContent = String(toCount(stats.total));
  UI['stat-learned'].textContent = String(Object.keys(isPlainObject(current.learned) ? current.learned : {}).length);
}

/* ================================================================
 * 读写存储
 * ================================================================ */

async function updateSettings(patch) {
  const result = await mutate(function (state) {
    state.settings = { ...state.settings, ...patch };
    return { settings: state.settings };
  });
  await loadAndRender();
  return result;
}

function mutate(change) {
  writeChain = writeChain.then(function () {
    return runMutation(change);
  });
  return writeChain;
}

async function runMutation(change) {
  try {
    const state = mergeState(await chrome.storage.local.get(null));
    const patch = change(state);
    if (!patch) return 'noop';
    await chrome.storage.local.set(patch);
    hideError();
    return 'ok';
  } catch (error) {
    showError('保存失败：' + errorText(error));
    return 'error';
  }
}

async function loadAndRender() {
  try {
    current = mergeState(await chrome.storage.local.get(null));
    render();
  } catch (error) {
    showError('刷新数据失败：' + errorText(error));
  }
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(function () {
    loadAndRender();
  }, 80);
}

/* ================================================================
 * 名称屏蔽
 * ================================================================ */

async function addBlockedName() {
  const name = normalizeName(UI['name-input'].value);
  if (!name) {
    toast('请输入账号名称');
    return;
  }
  if (name.length > 40) {
    toast('账号名称最多 40 个字符');
    return;
  }

  let duplicate = false;
  const result = await mutate(function (state) {
    const list = Array.isArray(state.nameBlocks) ? state.nameBlocks.slice() : [];
    const key = name.toLowerCase();
    const exists = list.some(function (item) {
      return blockNameOf(item).toLowerCase() === key;
    });
    if (exists) {
      duplicate = true;
      return null;
    }
    list.push({ name: name, addedAt: Date.now() });
    return { nameBlocks: list };
  });

  await loadAndRender();
  if (result === 'ok') {
    UI['name-input'].value = '';
    toast('已添加名称屏蔽：' + name);
  } else if (duplicate) {
    toast('这个名称已经在列表里了（忽略大小写）');
  }
}

async function removeBlockedName(name) {
  const key = normalizeName(name).toLowerCase();
  if (!key) return;
  const result = await mutate(function (state) {
    const list = Array.isArray(state.nameBlocks) ? state.nameBlocks : [];
    const next = list.filter(function (item) {
      return blockNameOf(item).toLowerCase() !== key;
    });
    if (next.length === list.length) return null;
    return { nameBlocks: next };
  });
  await loadAndRender();
  if (result === 'ok') toast('已移除名称屏蔽：' + name);
}

/* ================================================================
 * 已学习 / 白名单
 * ================================================================ */

async function removeLearned(uid) {
  if (!uid) return;
  const result = await mutate(function (state) {
    if (!isPlainObject(state.learned) || !Object.prototype.hasOwnProperty.call(state.learned, uid)) return null;
    const learned = { ...state.learned };
    delete learned[uid];
    // 同时清掉对应的 strikes，避免下次同一账号又因为旧命中记录被立刻隐藏
    const strikes = isPlainObject(state.strikes) ? { ...state.strikes } : {};
    delete strikes[uid];
    return { learned: learned, strikes: strikes };
  });
  await loadAndRender();
  if (result === 'ok') toast('已移出已学习账号');
}

async function removeWhitelist(uid) {
  if (!uid) return;
  const result = await mutate(function (state) {
    if (!isPlainObject(state.whitelist) || !Object.prototype.hasOwnProperty.call(state.whitelist, uid)) return null;
    const whitelist = { ...state.whitelist };
    delete whitelist[uid];
    return { whitelist: whitelist };
  });
  await loadAndRender();
  if (result === 'ok') toast('已移出白名单');
}

/* ================================================================
 * 导出 / 导入 / 清空
 * ================================================================ */

async function exportData() {
  try {
    const state = mergeState(await chrome.storage.local.get(null));
    const payload = {
      settings: state.settings,
      learned: state.learned,
      nameBlocks: state.nameBlocks,
      whitelist: state.whitelist
    };
    const text = JSON.stringify(payload, null, 2);
    const blob = new Blob([text], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'bcs-backup-' + dateKey().replace(/-/g, '') + '.json';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () {
      URL.revokeObjectURL(url);
    }, 4000);
    toast('已导出备份文件');
  } catch (error) {
    showError('导出失败：' + errorText(error));
  }
}

async function handleImportFile() {
  const input = UI['import-file'];
  const file = input.files && input.files[0];
  if (!file) return;

  try {
    const text = await file.text();
    let raw = null;
    try {
      raw = JSON.parse(text);
    } catch (parseError) {
      throw new Error('不是有效的 JSON 文件');
    }
    const summary = await mergeImported(raw);
    await loadAndRender();
    toast('导入完成：' + summary);
  } catch (error) {
    toast('导入失败：' + errorText(error));
  } finally {
    input.value = '';
  }
}

async function mergeImported(raw) {
  if (!isPlainObject(raw)) throw new Error('文件内容是 JSON，但不是对象');

  const state = mergeState(await chrome.storage.local.get(null));
  const patch = {};
  const added = { settings: 0, learned: 0, whitelist: 0, names: 0 };

  if (isPlainObject(raw.settings)) {
    const clean = sanitizeSettings(raw.settings);
    if (Object.keys(clean).length > 0) {
      patch.settings = { ...state.settings, ...clean };
      added.settings = Object.keys(clean).length;
    }
  }

  if (isPlainObject(raw.learned)) {
    const learned = { ...state.learned };
    Object.keys(raw.learned).forEach(function (key) {
      const entry = sanitizeLearned(key, raw.learned[key]);
      if (!entry) return;
      const previous = isPlainObject(learned[entry.uid]) ? learned[entry.uid] : {};
      learned[entry.uid] = { ...previous, ...entry.fields };
      added.learned += 1;
    });
    if (added.learned > 0) patch.learned = learned;
  }

  if (isPlainObject(raw.whitelist)) {
    const whitelist = { ...state.whitelist };
    Object.keys(raw.whitelist).forEach(function (key) {
      const entry = sanitizeWhitelist(key, raw.whitelist[key]);
      if (!entry) return;
      const previous = isPlainObject(whitelist[entry.uid]) ? whitelist[entry.uid] : {};
      whitelist[entry.uid] = { ...previous, ...entry.fields };
      added.whitelist += 1;
    });
    if (added.whitelist > 0) patch.whitelist = whitelist;
  }

  if (Array.isArray(raw.nameBlocks)) {
    const seen = new Set(
      state.nameBlocks.map(function (item) {
        return blockNameOf(item).toLowerCase();
      }).filter(Boolean)
    );
    const list = state.nameBlocks.slice();
    raw.nameBlocks.forEach(function (item) {
      const name = blockNameOf(item).slice(0, 40);
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      list.push({ name: name, addedAt: toCount(item && item.addedAt) || Date.now() });
      added.names += 1;
    });
    if (added.names > 0) patch.nameBlocks = list;
  }

  if (Object.keys(patch).length === 0) {
    throw new Error('没有可导入的新数据（settings / learned / whitelist / nameBlocks）');
  }

  try {
    await chrome.storage.local.set(patch);
  } catch (storageError) {
    throw new Error('写入存储失败：' + errorText(storageError));
  }
  hideError();

  const parts = [];
  if (added.settings) parts.push('设置 ' + added.settings + ' 项');
  if (added.learned) parts.push('已学习账号 ' + added.learned + ' 个');
  if (added.whitelist) parts.push('白名单 ' + added.whitelist + ' 个');
  if (added.names) parts.push('名称屏蔽 ' + added.names + ' 个');
  return parts.join('、');
}

async function clearAllData() {
  const confirmed = window.confirm(
    '确定要清空所有本地数据吗？\n' +
    '设置、已学习账号、名称屏蔽、白名单、统计都会被重置。\n' +
    '（手动标记模式会关闭，外观恢复「跟随设备」）'
  );
  if (!confirmed) return;

  try {
    await chrome.storage.local.set({
      settings: { ...DEFAULT_SETTINGS, markMode: false, markModeMigrated: true, theme: 'auto' },
      learned: {},
      nameBlocks: [],
      whitelist: {},
      strikes: {},
      stats: { total: 0, today: { date: dateKey(), collapsed: 0, hidden: 0 } }
    });
    await loadAndRender();
    hideError();
    toast('已清空本地数据');
  } catch (error) {
    showError('清空失败：' + errorText(error));
  }
}

/* ================================================================
 * 数据合并 / 校验小工具
 * ================================================================ */

function isPlainObject(value) {
  return !!value && typeof value === 'object' && Object.prototype.toString.call(value) === '[object Object]';
}

/** 用默认值深合并：对象递归补全，数组取存储值，基础值以存储值优先 */
function deepMerge(defaults, value) {
  if (Array.isArray(defaults)) {
    return Array.isArray(value) ? value.slice() : [];
  }
  if (isPlainObject(defaults)) {
    const out = {};
    Object.keys(defaults).forEach(function (key) {
      out[key] = deepMerge(defaults[key], isPlainObject(value) ? value[key] : undefined);
    });
    if (isPlainObject(value)) {
      Object.keys(value).forEach(function (key) {
        if (!Object.prototype.hasOwnProperty.call(out, key)) out[key] = value[key];
      });
    }
    return out;
  }
  return value === undefined ? defaults : value;
}

function mergeState(raw) {
  const source = isPlainObject(raw) ? raw : {};
  return {
    settings: normalizeSettings(source.settings),
    learned: isPlainObject(source.learned) ? source.learned : {},
    nameBlocks: Array.isArray(source.nameBlocks) ? source.nameBlocks : [],
    whitelist: isPlainObject(source.whitelist) ? source.whitelist : {},
    strikes: isPlainObject(source.strikes) ? source.strikes : {},
    stats: deepMerge(DEFAULT_STATS, source.stats)
  };
}

/** 读取时把设置收敛到合法值，坏数据不会让面板出现「一个都没选中」 */
function normalizeSettings(raw) {
  const merged = deepMerge(DEFAULT_SETTINGS, isPlainObject(raw) ? raw : {});
  return {
    ...merged,
    enabled: typeof merged.enabled === 'boolean' ? merged.enabled : DEFAULT_SETTINGS.enabled,
    mode: ['collapse', 'hide', 'observe'].indexOf(merged.mode) !== -1 ? merged.mode : DEFAULT_SETTINGS.mode,
    level: ['conservative', 'balanced', 'aggressive'].indexOf(merged.level) !== -1 ? merged.level : DEFAULT_SETTINGS.level,
    autoLearn: typeof merged.autoLearn === 'boolean' ? merged.autoLearn : DEFAULT_SETTINGS.autoLearn,
    learnAfter: LEARN_STEPS.indexOf(Number(merged.learnAfter)) !== -1 ? Number(merged.learnAfter) : DEFAULT_SETTINGS.learnAfter,
    markMode: typeof merged.markMode === 'boolean' ? merged.markMode : DEFAULT_SETTINGS.markMode,
    markModeMigrated: typeof merged.markModeMigrated === 'boolean' ? merged.markModeMigrated : DEFAULT_SETTINGS.markModeMigrated,
    theme: THEMES.indexOf(merged.theme) !== -1 ? merged.theme : DEFAULT_SETTINGS.theme
  };
}

/** 导入时只挑出合法的 settings 字段（部分合并） */
function sanitizeSettings(raw) {
  const out = {};
  if (!isPlainObject(raw)) return out;
  if (typeof raw.enabled === 'boolean') out.enabled = raw.enabled;
  if (['collapse', 'hide', 'observe'].indexOf(raw.mode) !== -1) out.mode = raw.mode;
  if (['conservative', 'balanced', 'aggressive'].indexOf(raw.level) !== -1) out.level = raw.level;
  if (typeof raw.autoLearn === 'boolean') out.autoLearn = raw.autoLearn;
  const learnAfter = Number(raw.learnAfter);
  if (LEARN_STEPS.indexOf(learnAfter) !== -1) out.learnAfter = learnAfter;
  if (typeof raw.markMode === 'boolean') out.markMode = raw.markMode;
  if (THEMES.indexOf(raw.theme) !== -1) out.theme = raw.theme;
  return out;
}

function sanitizeLearned(uid, info) {
  const id = sanitizeUid(uid);
  if (!id || !isPlainObject(info)) return null;
  const fields = {};
  const uname = cleanText(info.uname, 40);
  if (uname) fields.uname = uname;
  if (info.hits !== undefined && Number.isFinite(Number(info.hits))) fields.hits = toCount(info.hits);
  fields.addedAt = toCount(info.addedAt) || Date.now();
  fields.source = info.source === 'manual' ? 'manual' : 'auto';
  return { uid: id, fields: fields };
}

function sanitizeWhitelist(uid, info) {
  const id = sanitizeUid(uid);
  if (!id || !isPlainObject(info)) return null;
  const fields = {};
  const uname = cleanText(info.uname, 40);
  if (uname) fields.uname = uname;
  fields.addedAt = toCount(info.addedAt) || Date.now();
  return { uid: id, fields: fields };
}

function sanitizeUid(uid) {
  const text = String(uid === null || uid === undefined ? '' : uid).trim();
  return /^\d{1,20}$/.test(text) ? text : '';
}

function normalizeName(value) {
  return String(value === null || value === undefined ? '' : value).replace(/\s+/g, ' ').trim();
}

/** nameBlocks 里兼容两种形态：'大肥鱼' 或 { name: '大肥鱼' } */
function blockNameOf(item) {
  return normalizeName(typeof item === 'string' ? item : item && item.name);
}

function cleanText(value, maxLength) {
  const limit = maxLength || 60;
  return normalizeName(value).slice(0, limit);
}

function toCount(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.trunc(number);
}

function dateKey(date) {
  const target = date || new Date();
  const pad = function (number) {
    return String(number).padStart(2, '0');
  };
  return target.getFullYear() + '-' + pad(target.getMonth() + 1) + '-' + pad(target.getDate());
}

/* ================================================================
 * 提示 / 小工具
 * ================================================================ */

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function showError(message) {
  try {
    console.error('[bili-bot-shield popup]', message);
  } catch (error) {
    /* ignore */
  }
  if (!UI['error-bar']) return;
  UI['error-bar'].textContent = message;
  UI['error-bar'].hidden = false;
}

function hideError() {
  if (!UI['error-bar']) return;
  UI['error-bar'].hidden = true;
  UI['error-bar'].textContent = '';
}

function toast(message) {
  if (!UI['toast']) return;
  UI['toast'].textContent = message;
  UI['toast'].hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    UI['toast'].hidden = true;
  }, 2600);
}

function errorText(error) {
  if (!error) return '未知错误';
  if (typeof error === 'string') return error;
  return error.message ? String(error.message) : String(error);
}

/* ================================================================
 * 入口
 * ================================================================ */

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot, { once: true });
} else {
  boot();
}
