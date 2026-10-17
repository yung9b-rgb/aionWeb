// Shared front-end helpers: layout (navbar + sidebar from the Majestic template), session check, API calls, toasts,
// and the UI language (zh / en). Load order on every page: js/i18n.js, js/app.js, then template.js (which highlights
// the active sidebar link on DOM ready).
//
// i18n: Chinese source text is the key. AA.t('中文 {0}', x) returns the English entry from window.AA_I18N_EN when the
// UI language is English (falls back to the Chinese text if a key is missing). Static page text is translated on load
// by AA.translate(); elements marked data-no-i18n (and their children) are left alone, so data such as character and
// goods names is never touched. Every API call sends the language in X-Lang so server messages match.
(function () {
  'use strict';

  const LANGS = { zh: '中文', en: 'English' };
  let LANG = 'zh';
  try { LANG = localStorage.getItem('aa-lang') === 'en' ? 'en' : 'zh'; } catch { /* storage blocked */ }
  const EN = window.AA_I18N_EN || {};

  function fmt(s, args) { return args.length ? s.replace(/\{(\d+)\}/g, (m, i) => (args[i] ?? m)) : s; }
  function t(zh, ...args) { return fmt(LANG === 'en' && EN[zh] != null ? EN[zh] : zh, args); }

  function setLang(l) {
    try { localStorage.setItem('aa-lang', l); } catch { /* ignore */ }
    location.reload();
  }

  // Replace static Chinese text (text nodes and placeholder/title/alt attributes) found in the dictionary.
  const ATTRS = ['placeholder', 'title', 'alt', 'aria-label'];
  function translate(root) {
    if (LANG !== 'en' || !root) return;
    const skip = (el) => el && el.closest && el.closest('[data-no-i18n],script,style,textarea');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const n of nodes) {
      const raw = n.nodeValue, key = raw.trim().replace(/\s+/g, ' ');   // keys have runs of whitespace collapsed
      if (!key || !/[一-鿿]/.test(key) || skip(n.parentElement)) continue;
      if (EN[key] != null) n.nodeValue = raw.match(/^\s*/)[0] + EN[key] + raw.match(/\s*$/)[0];
    }
    const els = root.querySelectorAll ? root.querySelectorAll(ATTRS.map((a) => `[${a}]`).join(',')) : [];
    for (const el of els) {
      if (el.closest('[data-no-i18n]')) continue;   // a textarea's own placeholder is UI text, its content is not
      for (const a of ATTRS) {
        const v = el.getAttribute(a);
        if (v && EN[v.trim()] != null) el.setAttribute(a, EN[v.trim()]);
      }
    }
  }

  const MENU = [
    { href: 'index.html', icon: 'mdi-view-dashboard', title: '仪表盘' },
    { href: 'announce.html', icon: 'mdi-bullhorn', title: '公告' },
    { href: 'characters.html', icon: 'mdi-account-multiple', title: '角色管理' },
    { href: 'mail.html', icon: 'mdi-gift', title: '发送物品' },
    { href: 'proxy.html', icon: 'mdi-swap-horizontal', title: '数据报文抓取' },
    { href: 'shop.html', icon: 'mdi-store', title: '游戏商城' },
    { href: 'points.html', icon: 'mdi-cash-multiple', title: '点券管理' },
    { href: 'adminlog.html', icon: 'mdi-history', title: '操作记录' },
    { href: '#', icon: 'mdi-console', title: 'GM 命令', soon: true },
  ];

  const RACES = ['天族', '魔族'].map((x) => t(x));
  const CLASSES = ['战士', '剑星', '守护星', '侦察者', '杀星', '弓星', '法师', '魔道星', '精灵星', '祭司', '治愈星', '护法星'].map((x) => t(x));
  const WAREHOUSES = { 0: t('背包 / 装备'), 1: t('角色仓库'), 5: t('邮箱') };
  const QUALITY = { common: '普通', rare: '稀有', legend: '传承', unique: '独特', epic: '史诗', mythic: '神话' };
  const quality = (q) => t(QUALITY[String(q ?? '').toLowerCase()] ?? String(q ?? ''));
  // item name in the UI language; info is an item record from /api/items or /api/items/info
  const itemName = (info) => !info ? '' : LANG === 'en' ? (info.en || info.name || info.zh) : (info.zh || info.name);

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function langMenuHtml() {
    return `
      <li class="nav-item aa-lang">
        <a class="nav-link" href="#" id="aa-lang-btn" title="Language"><i class="mdi mdi-translate text-primary"></i> Language: ${LANGS[LANG]}</a>
        <div class="aa-lang-menu" id="aa-lang-menu">
          ${Object.entries(LANGS).map(([k, v]) => `<a href="#" data-lang="${k}" class="${k === LANG ? 'active' : ''}">${v}</a>`).join('')}
        </div>
      </li>`;
  }

  function navbarHtml() {
    return `
<nav class="navbar col-lg-12 col-12 p-0 fixed-top d-flex flex-row">
  <div class="navbar-brand-wrapper d-flex justify-content-center">
    <div class="navbar-brand-inner-wrapper d-flex justify-content-between align-items-center w-100">
      <a class="navbar-brand brand-logo aa-brand" href="index.html"><i class="mdi mdi-castle"></i> ${t('永恒之塔 GM')}</a>
      <a class="navbar-brand brand-logo-mini aa-brand" href="index.html"><i class="mdi mdi-castle"></i></a>
      <button class="navbar-toggler navbar-toggler align-self-center" type="button" data-toggle="minimize">
        <span class="mdi mdi-sort-variant"></span>
      </button>
    </div>
  </div>
  <div class="navbar-menu-wrapper d-flex align-items-center justify-content-end">
    <ul class="navbar-nav mr-lg-4 w-100">
      <li class="nav-item d-none d-lg-block w-100"><span class="text-muted aa-subtitle">${t('Aion 2.7 管理后台')}</span></li>
    </ul>
    <ul class="navbar-nav navbar-nav-right">
      ${langMenuHtml()}
      <li class="nav-item">
        <a class="nav-link" href="#" id="aa-logout" title="${t('退出登录')}"><i class="mdi mdi-logout text-primary"></i> ${t('退出')}</a>
      </li>
    </ul>
    <button class="navbar-toggler navbar-toggler-right d-lg-none align-self-center" type="button" data-toggle="offcanvas">
      <span class="mdi mdi-menu"></span>
    </button>
  </div>
</nav>`;
  }

  function sidebarHtml() {
    const items = MENU.map((m) => `
    <li class="nav-item${m.soon ? ' aa-soon' : ''}">
      <a class="nav-link" href="${m.href}"${m.soon ? ` title="${t('即将推出')}"` : ''}>
        <i class="mdi ${m.icon} menu-icon"></i>
        <span class="menu-title">${t(m.title)}${m.soon ? ` <small>(${t('即将推出')})</small>` : ''}</span>
      </a>
    </li>`).join('');
    return `<nav class="sidebar sidebar-offcanvas" id="sidebar"><ul class="nav">${items}</ul></nav>`;
  }

  function footerHtml() {
    return `
<footer class="footer">
  <div class="d-sm-flex justify-content-center justify-content-sm-between">
    <span class="text-muted text-center text-sm-left d-block d-sm-inline-block">AionWeb · ${t('直连 CacheD 与游戏数据库')}</span>
    <span class="float-none float-sm-right d-block mt-1 mt-sm-0 text-center">${t('界面模板：Majestic Admin（MIT）')}</span>
  </div>
</footer>`;
  }

  function wireLangMenu() {
    const btn = document.getElementById('aa-lang-btn'), menu = document.getElementById('aa-lang-menu');
    if (!btn || !menu) return;
    btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); menu.classList.toggle('show'); });
    document.addEventListener('click', () => menu.classList.remove('show'));
    menu.addEventListener('click', (e) => {
      const a = e.target.closest('[data-lang]'); if (!a) return;
      e.preventDefault();
      if (a.dataset.lang !== LANG) setLang(a.dataset.lang);
    });
  }

  function mountLayout() {
    const nb = document.getElementById('aa-navbar');
    const sb = document.getElementById('aa-sidebar');
    const ft = document.getElementById('aa-footer');
    if (nb) nb.outerHTML = navbarHtml();
    if (sb) sb.outerHTML = sidebarHtml();
    if (ft) ft.outerHTML = footerHtml();
    document.querySelectorAll('.aa-soon a').forEach((a) => a.addEventListener('click', (e) => e.preventDefault()));
    const lo = document.getElementById('aa-logout');
    if (lo) lo.addEventListener('click', async (e) => {
      e.preventDefault();
      await api('POST', '/api/logout', {});
      location.href = 'login.html';
    });
    wireLangMenu();
  }

  // Pages without the navbar (login) get a small floating switcher.
  function mountFloatingLang() {
    const box = document.createElement('div');
    box.className = 'aa-lang-float';
    box.innerHTML = `<ul class="list-unstyled m-0">${langMenuHtml()}</ul>`;
    document.body.appendChild(box);
    wireLangMenu();
  }

  async function api(method, url, body) {
    const opt = { method, headers: { 'X-Lang': LANG } };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(url, opt);
    let data = null;
    try { data = await r.json(); } catch { /* empty body */ }
    if (r.status === 401 && !location.pathname.endsWith('login.html')) {
      location.href = 'login.html';
      throw new Error(t('请先登录'));
    }
    if (!r.ok) throw new Error((data && data.error) || `HTTP ${r.status}`);
    return data;
  }

  function toast(msg, kind = 'success') {
    let box = document.getElementById('aa-toasts');
    if (!box) {
      box = document.createElement('div');
      box.id = 'aa-toasts';
      document.body.appendChild(box);
    }
    const el = document.createElement('div');
    el.className = `alert alert-${kind} shadow aa-toast`;
    el.textContent = msg;
    box.appendChild(el);
    setTimeout(() => el.remove(), kind === 'danger' ? 8000 : 4000);
  }

  function fmtTime(v) {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d)) return String(v);
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  const fmtNum = (n) => Number(n).toLocaleString(LANG === 'en' ? 'en-US' : 'zh-CN');

  function raceBadge(r) {
    return `<span class="badge ${r === 0 ? 'bg-info' : 'bg-danger'}">${RACES[r] ?? r}</span>`;
  }

  window.AA = { api, toast, esc, fmtTime, fmtNum, raceBadge, RACES, CLASSES, WAREHOUSES, quality, itemName,
    lang: LANG, t, translate, setLang };

  document.documentElement.lang = LANG === 'en' ? 'en' : 'zh-CN';
  if (LANG === 'en' && EN[document.title]) document.title = EN[document.title];
  if (!location.pathname.endsWith('login.html')) {
    mountLayout();
    api('GET', '/api/session').then((s) => { if (!s.authed) location.href = 'login.html'; }).catch(() => {});
  } else {
    mountFloatingLang();
  }
  translate(document.body);
})();
