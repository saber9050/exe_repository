/**
 * 依赖库下载页 —— 无框架实现。
 *
 * 兼容性口径：Windows 7 上能装的 Chrome / Edge / Firefox（ES2015 + CSS 变量 + Flex）。
 * 刻意不使用可选链、空值合并、Array.prototype.flat、String.padStart 这些较新的语法糖，
 * 也不使用 type="module"，普通 <script> 加载，旧内核不会因为模块解析失败而整页白屏。
 */
(function () {
  'use strict';

  var CATEGORY_ORDER = ['installer', 'runtime', 'driver', 'patch', 'other'];

  var CATEGORY_CLASS = {
    installer: 'cat-installer',
    runtime: 'cat-runtime',
    driver: 'cat-driver',
    patch: 'cat-patch',
    other: 'cat-other'
  };

  // 内联图标，避免额外请求
  var ICON = {
    package:
      '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 3 4 7v10l8 4 8-4V7l-8-4Z"/><path d="m4 7 8 4 8-4"/><path d="M12 11v10"/></svg>',
    windows:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M3 5.5 10.5 4.4v7.1H3V5.5Zm0 13 7.5 1.1v-7H3v5.9Zm8.6 1.3L21 21V12.4h-9.4v7.4Zm0-15.6v7.3H21V3l-9.4 1.2Z"/></svg>',
    apple:
      '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
      '<path d="M17.05 20.28c-.98.95-2.05.8-3.08.35-1.09-.46-2.09-.48-3.24 0-1.44.62-2.2.44-3.06-.35C2.79 15.25 3.51 7.59 9.05 7.31c1.35.07 2.29.74 3.08.8 1.18-.24 2.31-.93 3.57-.84 1.51.12 2.65.72 3.4 1.8-3.12 1.87-2.38 5.98.48 7.13-.57 1.5-1.31 2.99-2.54 4.09l.01-.01ZM12.03 7.25c-.15-2.23 1.66-4.07 3.74-4.25.29 2.58-2.34 4.5-3.74 4.25Z"/></svg>',
    linux:
      '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" aria-hidden="true">' +
      '<path d="M12 1.6c-2.25 0-4 2-4 4.35 0 1.2.3 2.3.3 3.3 0 .95-.6 1.85-1.3 2.85-1 1.4-1.9 3-1.9 4.75 0 1.35.6 2.4 1.6 2.9-.1.6 0 1.15.4 1.65.7.75 1.95 1.15 3 1.25.6.06 1.3.06 1.9.06s1.3 0 1.9-.06c1.05-.1 2.3-.5 3-1.25.4-.5.5-1.05.4-1.65 1-.5 1.6-1.55 1.6-2.9 0-1.75-.9-3.35-1.9-4.75-.7-1-1.3-1.9-1.3-2.85 0-1 .3-2.1.3-3.3 0-2.35-1.75-4.35-4-4.35Zm-1.65 3.1c.55 0 1 .75 1 1.6s-.45 1.6-1 1.6-1-.75-1-1.6.45-1.6 1-1.6Zm3.3 0c.55 0 1 .75 1 1.6s-.45 1.6-1 1.6-1-.75-1-1.6.45-1.6 1-1.6Z"/></svg>',
    download:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M12 4v10"/><path d="m8 11 4 4 4-4"/><path d="M5 19h14"/></svg>',
    check:
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="m5 12 4.5 4.5L19 7"/></svg>',
    close:
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
      '<path d="M6 6l12 12M18 6 6 18"/></svg>'
  };

  function platformIcon(os) {
    if (os === 'macos') return ICON.apple;
    if (os === 'linux') return ICON.linux;
    return ICON.windows;
  }

  var state = {
    items: [],
    query: '',
    platform: 'all',
    category: 'all',
    arch: '',
    loading: true,
    error: '',
    drawer: null,
    clicked: {}
  };

  function byId(id) {
    return document.getElementById(id);
  }

  var dom = {
    grid: byId('grid'),
    empty: byId('empty'),
    emptyTitle: byId('emptyTitle'),
    emptyDesc: byId('emptyDesc'),
    clearFilters: byId('clearFilters'),
    alert: byId('alert'),
    alertText: byId('alertText'),
    retry: byId('retry'),
    q: byId('q'),
    qClear: byId('qClear'),
    platforms: byId('platforms'),
    categories: byId('categories'),
    catSep: byId('catSep'),
    archWrap: byId('archWrap'),
    arch: byId('arch'),
    refresh: byId('refresh')
  };

  /* ---------------- 工具函数 ---------------- */

  function pad2(n) {
    return n < 10 ? '0' + n : '' + n;
  }

  function formatBytes(bytes) {
    if (!bytes || bytes <= 0) {
      return '—';
    }
    var units = ['B', 'KB', 'MB', 'GB'];
    var value = bytes;
    var i = 0;
    while (value >= 1024 && i < units.length - 1) {
      value = value / 1024;
      i += 1;
    }
    var text = value >= 100 || i === 0 ? String(Math.round(value)) : value.toFixed(1);
    return text + ' ' + units[i];
  }

  function formatDate(iso) {
    if (!iso) {
      return '—';
    }
    var d = new Date(iso);
    if (isNaN(d.getTime())) {
      return '—';
    }
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function node(tag, className, text) {
    var n = document.createElement(tag);
    if (className) {
      n.className = className;
    }
    if (text !== undefined && text !== null) {
      n.textContent = String(text);
    }
    return n;
  }

  /* ---------------- 数据 ---------------- */

  function load(refresh) {
    state.loading = true;
    state.error = '';
    render();

    var url = '/client/deps/catalog' + (refresh ? '?refresh=1' : '');
    fetch(url, { headers: { Accept: 'application/json' } })
      .then(function (res) {
        if (!res.ok) {
          return res
            .json()
            .catch(function () {
              return { message: '请求失败（' + res.status + '）' };
            })
            .then(function (body) {
              throw new Error(body.message || '请求失败（' + res.status + '）');
            });
        }
        return res.json();
      })
      .then(function (data) {
        state.items = data.items || [];
      })
      .catch(function (err) {
        state.error = err && err.message ? err.message : '目录加载失败';
        state.items = [];
      })
      .then(function () {
        state.loading = false;
        render();
      });
  }

  /* ---------------- 过滤 ---------------- */

  function visibleItems() {
    var kw = state.query.trim().toLowerCase();
    return state.items.filter(function (item) {
      if (state.category !== 'all' && item.category !== state.category) {
        return false;
      }
      if (state.platform !== 'all' && item.platform !== state.platform) {
        return false;
      }
      if (state.arch && item.arch !== state.arch) {
        return false;
      }
      if (!kw) {
        return true;
      }
      var haystack = [
        item.name,
        item.code,
        item.description,
        item.platform_label
      ]
        .join(' ')
        .toLowerCase();
      if (haystack.indexOf(kw) !== -1) {
        return true;
      }
      for (var i = 0; i < (item.tags || []).length; i += 1) {
        if (String(item.tags[i]).toLowerCase().indexOf(kw) !== -1) {
          return true;
        }
      }
      return false;
    });
  }

  function categoryList() {
    var seen = {};
    var list = [];
    state.items.forEach(function (item) {
      if (!seen[item.category]) {
        seen[item.category] = true;
        list.push({ key: item.category, label: item.category_label });
      }
    });
    list.sort(function (a, b) {
      return CATEGORY_ORDER.indexOf(a.key) - CATEGORY_ORDER.indexOf(b.key);
    });
    // 只有一种分类时没必要显示筛选
    return list.length > 1 ? [{ key: 'all', label: '全部类型' }].concat(list) : [];
  }

  /* ---------------- 渲染：筛选区 ---------------- */

  function renderCategories() {
    var list = categoryList();
    dom.categories.innerHTML = '';
    dom.catSep.hidden = list.length === 0;

    list.forEach(function (cat) {
      var btn = node('button', 'chip' + (state.category === cat.key ? ' is-active' : ''), cat.label);
      btn.type = 'button';
      btn.setAttribute('data-category', cat.key);
      dom.categories.appendChild(btn);
    });

    dom.archWrap.hidden = state.items.length === 0;
    dom.arch.value = state.arch;
    dom.refresh.disabled = state.loading;
    dom.qClear.hidden = state.query.length === 0;
  }

  function renderPlatformState() {
    var buttons = dom.platforms.getElementsByTagName('button');
    for (var i = 0; i < buttons.length; i += 1) {
      var key = buttons[i].getAttribute('data-platform');
      if (key === state.platform) {
        buttons[i].className = 'is-active';
      } else {
        buttons[i].className = '';
      }
    }
  }

  /* ---------------- 渲染：卡片 ---------------- */

  function buildCard(item) {
    var card = node('article', 'card');
    var key = item.key;
    var clicked = !!state.clicked[key];

    // 顶部：图标 + 名称 + 平台/架构徽章
    var top = node('div', 'card__top');
    var icon = node('div', 'card__icon ' + (CATEGORY_CLASS[item.category] || 'cat-other'));
    icon.innerHTML = ICON.package;
    top.appendChild(icon);

    var title = node('div', 'card__title');
    title.appendChild(node('h3', '', item.name));
    title.appendChild(node('code', 'card__code', item.code));
    top.appendChild(title);

    var badges = node('div', 'card__badges');
    badges.appendChild(node('span', 'tag tag--platform platform-' + item.platform, item.platform_label));
    badges.appendChild(node('span', 'tag tag--arch arch-' + item.arch, item.arch));
    top.appendChild(badges);
    card.appendChild(top);

    if (item.description) {
      card.appendChild(node('p', 'card__desc', item.description));
    }

    // 分类 + 标签
    var tags = node('div', 'card__tags');
    tags.appendChild(
      node('span', 'tag tag--category ' + (CATEGORY_CLASS[item.category] || 'cat-other'), item.category_label)
    );
    (item.tags || []).forEach(function (t) {
      if (t !== item.category_label) {
        tags.appendChild(node('span', 'tag tag--ghost', t));
      }
    });
    card.appendChild(tags);

    // 版本 / 大小 / 时间
    var meta = node('dl', 'card__meta');
    appendMeta(meta, '最新版本', 'v' + item.version);
    appendMeta(meta, '文件大小', formatBytes(item.size));
    appendMeta(meta, '更新时间', formatDate(item.updated_at));
    card.appendChild(meta);

    // 底部：平台 + 操作
    var foot = node('div', 'card__foot');
    var plat = node('span', 'platform platform-' + item.platform);
    plat.innerHTML = platformIcon(item.os);
    plat.appendChild(document.createTextNode(item.platform_label));
    foot.appendChild(plat);

    var actions = node('div', 'card__actions');

    if ((item.versions || []).length > 1) {
      var vBtn = node('button', 'btn btn--ghost');
      vBtn.type = 'button';
      vBtn.setAttribute('data-act', 'versions');
      vBtn.setAttribute('data-key', key);
      vBtn.appendChild(document.createTextNode('版本'));
      vBtn.appendChild(node('span', 'btn__count', item.versions.length));
      actions.appendChild(vBtn);
    }

    var link = node('a', 'btn btn--primary');
    link.href = item.download_url;
    link.setAttribute('data-act', 'download');
    link.setAttribute('data-key', key);
    if (clicked) {
      link.className = 'btn btn--primary is-clicked';
      link.innerHTML = ICON.check + '<span>已开始</span>';
    } else {
      link.innerHTML = ICON.download + '<span>下载</span>';
    }
    actions.appendChild(link);

    foot.appendChild(actions);
    card.appendChild(foot);

    return card;
  }

  function appendMeta(list, label, value) {
    var wrap = node('div');
    wrap.appendChild(node('dt', '', label));
    wrap.appendChild(node('dd', 'mono', value));
    list.appendChild(wrap);
  }

  function renderGrid() {
    var items = visibleItems();
    dom.grid.innerHTML = '';

    if (state.loading) {
      for (var i = 0; i < 3; i += 1) {
        var sk = node('div', 'card card--skeleton');
        sk.innerHTML =
          '<div class="sk sk--icon"></div><div class="sk sk--line"></div>' +
          '<div class="sk sk--line sk--short"></div><div class="sk sk--block"></div>';
        dom.grid.appendChild(sk);
      }
      dom.empty.hidden = true;
      return;
    }

    if (items.length === 0) {
      dom.empty.hidden = false;
      var noData = state.items.length === 0;
      dom.emptyTitle.textContent = noData ? '暂时没有可下载的内容' : '没有匹配的结果';
      dom.emptyDesc.textContent = noData
        ? '组件正在陆续上架，稍后再来看看。'
        : '换个关键词，或把系统和类型筛回「全部」。';
      var filtered = state.query || state.category !== 'all' || state.platform !== 'all' || state.arch;
      dom.clearFilters.hidden = !filtered || noData;
      return;
    }

    dom.empty.hidden = true;
    items.forEach(function (item) {
      dom.grid.appendChild(buildCard(item));
    });
  }

  function renderAlert() {
    if (state.error) {
      dom.alert.hidden = false;
      dom.alertText.textContent = state.error;
    } else {
      dom.alert.hidden = true;
    }
  }

  function render() {
    renderPlatformState();
    renderCategories();
    renderAlert();
    renderGrid();
  }

  /* ---------------- 版本抽屉 ---------------- */

  var drawerRoot = null;

  function openDrawer(item) {
    closeDrawer();
    state.drawer = item;

    var root = node('div', 'drawer');
    var mask = node('div', 'drawer__mask');
    mask.setAttribute('data-act', 'close-drawer');

    var panel = node('div', 'drawer__panel');
    panel.setAttribute('role', 'dialog');
    panel.setAttribute('aria-label', item.name + ' 历史版本');

    var head = node('div', 'drawer__head');
    var headText = node('div');
    headText.appendChild(node('h2', '', item.name));
    headText.appendChild(node('code', 'card__code', item.code));
    head.appendChild(headText);

    var closeBtn = node('button', 'icon-btn icon-btn--lg');
    closeBtn.type = 'button';
    closeBtn.setAttribute('data-act', 'close-drawer');
    closeBtn.setAttribute('aria-label', '关闭');
    closeBtn.innerHTML = ICON.close;
    head.appendChild(closeBtn);
    panel.appendChild(head);

    panel.appendChild(node('p', 'drawer__hint', '旧版本保留用于回退，标有「最新」的是推荐版本。'));

    var list = node('ul', 'versions');
    (item.versions || []).forEach(function (v) {
      var row = node('li', 'versions__row' + (v.is_latest ? ' is-latest' : ''));

      var info = node('div', 'versions__info');
      var verLine = node('div', 'versions__ver');
      verLine.appendChild(node('span', 'mono', 'v' + v.version));
      if (v.is_latest) {
        verLine.appendChild(node('span', 'tag tag--live', '最新'));
      }
      info.appendChild(verLine);
      info.appendChild(node('span', 'versions__date', formatDate(v.created_at)));
      row.appendChild(info);

      var dl = node('a', 'btn ' + (v.is_latest ? 'btn--primary' : 'btn--ghost') + ' btn--sm');
      dl.href = v.download_url;
      dl.setAttribute('data-act', 'download');
      dl.setAttribute('data-key', item.key);
      dl.innerHTML = ICON.download + '<span>下载</span>';
      row.appendChild(dl);

      list.appendChild(row);
    });
    panel.appendChild(list);

    var foot = node('div', 'drawer__foot');
    foot.appendChild(field('文件名', item.file_name));
    foot.appendChild(field('适用系统', item.platform_label + ' · ' + item.arch));
    panel.appendChild(foot);

    root.appendChild(mask);
    root.appendChild(panel);
    document.body.appendChild(root);
    drawerRoot = root;

    document.body.style.overflow = 'hidden';
  }

  function field(label, value) {
    var wrap = node('div', 'field');
    wrap.appendChild(node('span', 'field__label', label));
    wrap.appendChild(node('code', 'mono', value));
    return wrap;
  }

  function closeDrawer() {
    if (drawerRoot && drawerRoot.parentNode) {
      drawerRoot.parentNode.removeChild(drawerRoot);
    }
    drawerRoot = null;
    state.drawer = null;
    document.body.style.overflow = '';
  }

  /* ---------------- 提示条 ---------------- */

  var toastTimer = null;
  var toastNode = null;

  function toast(text) {
    if (toastTimer) {
      clearTimeout(toastTimer);
    }
    if (toastNode && toastNode.parentNode) {
      toastNode.parentNode.removeChild(toastNode);
    }
    toastNode = node('div', 'toast toast--ok', text);
    toastNode.setAttribute('role', 'status');
    document.body.appendChild(toastNode);

    toastTimer = setTimeout(function () {
      if (toastNode && toastNode.parentNode) {
        toastNode.parentNode.removeChild(toastNode);
      }
      toastNode = null;
    }, 3200);
  }

  /* ---------------- 交互 ---------------- */

  function markClicked(key) {
    state.clicked[key] = true;
    renderGrid();
    setTimeout(function () {
      delete state.clicked[key];
      renderGrid();
    }, 2500);
  }

  dom.q.addEventListener('input', function () {
    state.query = dom.q.value;
    dom.qClear.hidden = state.query.length === 0;
    renderGrid();
  });

  dom.qClear.addEventListener('click', function () {
    dom.q.value = '';
    state.query = '';
    dom.qClear.hidden = true;
    renderGrid();
  });

  dom.platforms.addEventListener('click', function (e) {
    var target = e.target;
    if (target && target.tagName === 'BUTTON') {
      state.platform = target.getAttribute('data-platform');
      render();
    }
  });

  dom.categories.addEventListener('click', function (e) {
    var target = e.target;
    if (target && target.tagName === 'BUTTON') {
      state.category = target.getAttribute('data-category');
      render();
    }
  });

  dom.arch.addEventListener('change', function () {
    state.arch = dom.arch.value;
    renderGrid();
  });

  dom.refresh.addEventListener('click', function () {
    load(true);
  });

  dom.retry.addEventListener('click', function () {
    load(true);
  });

  dom.clearFilters.addEventListener('click', function () {
    state.query = '';
    state.category = 'all';
    state.platform = 'all';
    state.arch = '';
    dom.q.value = '';
    render();
  });

  dom.grid.addEventListener('click', function (e) {
    var target = e.target;
    // 从点击处向上找带 data-act 的元素（按钮或链接）
    while (target && target !== dom.grid && !target.getAttribute) {
      target = target.parentNode;
    }
    if (!target || !target.getAttribute) {
      return;
    }
    var act = target.getAttribute('data-act');
    if (!act) {
      // 点到了图标或文字，往上找一层
      var parent = target.parentNode;
      if (parent && parent.getAttribute) {
        act = parent.getAttribute('data-act');
        if (act) {
          target = parent;
        }
      }
    }
    if (!act) {
      return;
    }

    var key = target.getAttribute('data-key');
    var item = findItem(key);

    if (act === 'versions' && item) {
      openDrawer(item);
    } else if (act === 'download') {
      toast('已开始下载 ' + (item ? item.file_name : '文件'));
      markClicked(key);
    }
  });

  document.addEventListener('click', function (e) {
    var target = e.target;
    while (target && !target.getAttribute) {
      target = target.parentNode;
    }
    if (target && target.getAttribute && target.getAttribute('data-act') === 'close-drawer') {
      closeDrawer();
    }
  });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && state.drawer) {
      closeDrawer();
    }
  });

  function findItem(key) {
    for (var i = 0; i < state.items.length; i += 1) {
      if (state.items[i].key === key) {
        return state.items[i];
      }
    }
    return null;
  }

  /* ---------------- 启动 ---------------- */

  render();
  load(false);
})();
