// Shared front-end helpers: layout (navbar + sidebar from the Majestic template), session check, API calls, toasts.
// Must be loaded BEFORE template.js, which highlights the active sidebar link on DOM ready.
(function () {
  'use strict';

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

  const RACES = ['天族', '魔族'];
  const CLASSES = ['战士', '剑星', '守护星', '侦察者', '杀星', '弓星', '法师', '魔道星', '精灵星', '祭司', '治愈星', '护法星'];
  const WAREHOUSES = { 0: '背包 / 装备', 1: '角色仓库', 5: '邮箱' };

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function navbarHtml() {
    return `
<nav class="navbar col-lg-12 col-12 p-0 fixed-top d-flex flex-row">
  <div class="navbar-brand-wrapper d-flex justify-content-center">
    <div class="navbar-brand-inner-wrapper d-flex justify-content-between align-items-center w-100">
      <a class="navbar-brand brand-logo aa-brand" href="index.html"><i class="mdi mdi-castle"></i> 永恒之塔 GM</a>
      <a class="navbar-brand brand-logo-mini aa-brand" href="index.html"><i class="mdi mdi-castle"></i></a>
      <button class="navbar-toggler navbar-toggler align-self-center" type="button" data-toggle="minimize">
        <span class="mdi mdi-sort-variant"></span>
      </button>
    </div>
  </div>
  <div class="navbar-menu-wrapper d-flex align-items-center justify-content-end">
    <ul class="navbar-nav mr-lg-4 w-100">
      <li class="nav-item d-none d-lg-block w-100"><span class="text-muted aa-subtitle">Aion 2.7 管理后台</span></li>
    </ul>
    <ul class="navbar-nav navbar-nav-right">
      <li class="nav-item">
        <a class="nav-link" href="#" id="aa-logout" title="退出登录"><i class="mdi mdi-logout text-primary"></i> 退出</a>
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
      <a class="nav-link" href="${m.href}"${m.soon ? ' title="即将推出"' : ''}>
        <i class="mdi ${m.icon} menu-icon"></i>
        <span class="menu-title">${m.title}${m.soon ? ' <small>(即将推出)</small>' : ''}</span>
      </a>
    </li>`).join('');
    return `<nav class="sidebar sidebar-offcanvas" id="sidebar"><ul class="nav">${items}</ul></nav>`;
  }

  function footerHtml() {
    return `
<footer class="footer">
  <div class="d-sm-flex justify-content-center justify-content-sm-between">
    <span class="text-muted text-center text-sm-left d-block d-sm-inline-block">AionAdmin · 直连 CacheD 与游戏数据库</span>
    <span class="float-none float-sm-right d-block mt-1 mt-sm-0 text-center">界面模板：Majestic Admin（MIT）</span>
  </div>
</footer>`;
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
  }

  async function api(method, url, body) {
    const opt = { method, headers: {} };
    if (body !== undefined) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    }
    const r = await fetch(url, opt);
    let data = null;
    try { data = await r.json(); } catch { /* empty body */ }
    if (r.status === 401 && !location.pathname.endsWith('login.html')) {
      location.href = 'login.html';
      throw new Error('请先登录');
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

  function raceBadge(r) {
    return `<span class="badge ${r === 0 ? 'bg-info' : 'bg-danger'}">${RACES[r] ?? r}</span>`;
  }

  window.AA = { api, toast, esc, fmtTime, raceBadge, RACES, CLASSES, WAREHOUSES };

  if (!location.pathname.endsWith('login.html')) {
    mountLayout();
    api('GET', '/api/session').then((s) => { if (!s.authed) location.href = 'login.html'; }).catch(() => {});
  }
})();
