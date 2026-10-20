// ==UserScript==
// @name         UCAS 教务通知检索 / ID 导航
// @namespace    https://jwxk.ucas.ac.cn/
// @version      1.4.0
// @description  通知 ID 导航、范围检索、AND/OR/NOT 表达式与括号、可拖动悬浮球；支持自定义间隔、停止、失败重试和跨标签页互斥。
// @author       DSH
// @match        https://jwxk.ucas.ac.cn/*
// @match        http://jwxk.ucas.ac.cn/*
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

/*
 * v1.4.0：收起为可拖动悬浮球；单框布尔表达式，支持 AND / OR / NOT、括号和引号。
 * 优先级 NOT > AND > OR；相邻关键词默认 AND，空表达式不限制结果。
 * 默认请求完成后等待 3～5 秒，可自定义；跨任务/标签页共享间隔和冷却。
 * 用本文件替换旧脚本，避免同时启用多个版本。推荐通过 HTTPS 使用。
 * 浏览器不支持 Web Locks 时保留导航和缓存筛选，扫描会提示切换浏览器/HTTPS。
 * HTTP 限制同源；iframe 地址只由通知 ID 构造，可能随站点的登录流程跳转。
 * 全文指页面正文，不搜索附件内部文字。正文完整度未知时显示“待检查”。
 */
(function () {
  'use strict';
  const VERSION = '1.4.0';
  const NS = 'ucas_notice_nav_v2';
  const LEGACY_NS = 'ucas_notice_nav_v1';
  const PARSER_VERSION = 3;
  const RECOMMENDED = Object.freeze({ minSeconds: 3, maxSeconds: 5 });
  const MAX_INTERVAL_SECONDS = 86400;
  const MAX_RANGE_COUNT = 3000;
  const MAX_QUERY_LENGTH = 8192;
  const BALL_SIZE = 56;
  const BALL_MARGIN = 8;
  const HTTP_TIMEOUT_MS = 15000;
  const IFRAME_TIMEOUT_MS = 12000;
  const IFRAME_STABLE_MS = 750;
  const IFRAME_GRACE_MS = 1500;
  const MAX_RETRIES = 2;
  const MAX_CONSECUTIVE_FAILURES = 3;
  const NOTFOUND_TTL_MS = 86400000;
  const CFG_KEY = NS + ':config';
  const TIMING_KEY = NS + ':timing';
  const COOLDOWN_KEY = NS + ':cooldown';
  const LOCK_NAME = NS + ':request-lock';
  const RETRYABLE = new Set(['parsefail', 'net', 'timeout', 'httperror', 'blocked', 'ratelimit', 'auth', 'forbidden']);
  const STATUS_LABELS = {
    ok: '正常', notfound: '不存在(404)', forbidden: '拒绝访问(403)', auth: '登录失效',
    parsefail: '解析失败', net: '网络或登录跳转错误', timeout: '超时',
    httperror: 'HTTP 错误', blocked: 'iframe 无法读取', ratelimit: '限流(429)'
  };
  const PATH = String(location.pathname || '');
  if (!/^\/notice(?:\/|$)/i.test(PATH)) return;
  const detail = PATH.match(/^\/notice\/(\d+)\/(\d+)(?:\/view)?(?:;[^/]*)?\/?$/i);
  const category = PATH.match(/^\/notice\/(?:view\/|list\/)?(\d+)(?:\/|$)/i);
  const CAT = detail ? detail[1] : category ? category[1] : '1';
  const CUR_ID = detail ? parseSafeId(detail[2]) : null;
  const IS_DETAIL = CUR_ID !== null;
  const noticeUrl = (id) => location.origin + '/notice/' + CAT + '/' + id + '/view';
  const cacheKey = () => NS + ':cache:' + CAT;
  const legacyCacheKey = () => LEGACY_NS + ':res:' + CAT;
  const state = {
    config: null, results: new Map(), task: null, scanStats: null,
    storageWarning: '', authNotice: '', persistTimer: 0, renderTimer: 0,
    lastValidCustom: { min: 3, max: 5 }, currentParsed: null, currentFetchedByTask: false,
    ballPosition: null
  };
  let ui = null;
  const now = () => Date.now();
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const pad2 = (n) => String(n).padStart(2, '0');
  const formatSeconds = (n) => String(Math.round(Number(n) * 1000) / 1000);

  function parseSafeId(raw) {
    const s = String(raw == null ? '' : raw).trim();
    if (!/^\d{1,9}$/.test(s)) return null;
    const id = Number(s);
    return Number.isSafeInteger(id) && id > 0 ? id : null;
  }
  function readRaw(area, key) {
    try {
      const raw = area.getItem(key);
      return { present: raw !== null, value: raw === null ? null : JSON.parse(raw), error: null };
    } catch (error) { return { present: true, value: null, error }; }
  }
  function writeRaw(area, key, value) {
    try { area.setItem(key, JSON.stringify(value)); return true; } catch (_) { return false; }
  }
  function removeRaw(area, key) { try { area.removeItem(key); } catch (_) { /* 保留内存结果 */ } }
  function abortError() { return Object.assign(new Error('任务已停止'), { name: 'AbortError', kind: 'aborted' }); }
  function isAbortError(e) { return !!e && (e.name === 'AbortError' || e.kind === 'aborted'); }
  function sleepAbortable(ms, signal) {
    if (signal.aborted) return Promise.reject(abortError());
    if (ms <= 0) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); resolve(); }, Math.min(ms, 2147483647));
      const onAbort = () => { cleanup(); reject(abortError()); };
      function cleanup() { clearTimeout(timer); signal.removeEventListener('abort', onAbort); }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }

  // ---------- 页面解析 ----------
  const GENERIC_TITLES = [
    /^(首页|登录|登陆|通知|通知公告|公告|错误|404|国科大|中国科学院大学|信息门户)$/,
    /^(通知详情|通知内容|通知浏览|查看通知|详情|正文|系统通知|通知页面)$/,
    /^(统一身份认证|中国科学院大学教务部)/, /教务系统$/, /选课系统$/,
    /页面不存在|系统提示|无标题|access denied|not found|internal server error/i
  ];
  const TITLE_SELECTORS = [
    '.notice-title', '.article-title', '.detail-title', '.cont-title', '.content-title',
    '.article h1', '.detail h1', '.notice h1', 'h1', 'h2.title', 'h3.title', '.title'
  ];
  const BODY_SELECTORS = [
    '.notice-content', '.article-content', '.detail-content', '.content-detail', '.article-body',
    '.notice-body', '.news-content', '.view-content', '.show-content', '.rich-text',
    '.ql-editor', '.editor-content', '.content-body'
  ];
  const FALLBACK_BODY_SELECTORS = ['.article', '#article', '.detail', '.news-detail', '.content', '#content', '.main-content', '.con', 'article', 'main'];
  const DATE_SELECTORS = ['.notice-date', '.publish-date', '.pub-date', '.article-date', '[itemprop="datePublished"]'];
  const NOISE_SELECTORS = 'script,style,noscript,nav,header,footer,aside,form,button,.nav,.menu,.sidebar,.breadcrumb,.pagination,#ucas-notice-nav-host,[data-ucas-notice-iframe]';
  const LOADING_TEXT = /^(?:正文)?(?:正在)?加载(?:中|正文)?[，,.。…\s]*(?:请稍候[。.！!…]*)?$|^loading[.\s…]*$/i;

  function isGenericTitle(t) { return !norm(t) || norm(t).length < 3 || GENERIC_TITLES.some((re) => re.test(norm(t))); }
  function cleanTitle(raw) {
    return norm(raw).replace(/^(中国科学院大学|国科大|教务系统|选课系统)\s*[-_|–—]\s*/i, '')
      .replace(/\s+[-_|–—]+\s+(中国科学院大学.*|国科大.*|.*教务系统.*|.*选课系统.*|.*教务部.*)$/i, '').trim();
  }
  function cleanClone(el) {
    if (!el) return null;
    const clone = el.cloneNode(true);
    clone.querySelectorAll(NOISE_SELECTORS + ',[hidden],[aria-hidden="true"]').forEach((n) => n.remove());
    return clone;
  }
  function extractDate(text) {
    const m = norm(text).match(/(20\d{2})\s*[-年/.]\s*(\d{1,2})\s*[-月/.]\s*(\d{1,2})/);
    if (!m) return '';
    const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() + 1 === Number(m[2]) && d.getUTCDate() === Number(m[3])
      ? m[1] + '-' + pad2(m[2]) + '-' + pad2(m[3]) : '';
  }
  function extractPublishDate(doc) {
    for (const sel of DATE_SELECTORS) {
      const el = doc.querySelector(sel);
      if (el) {
        const date = extractDate(el.getAttribute('datetime') || el.getAttribute('content') || el.textContent);
        if (date) return date;
      }
    }
    const text = norm(cleanClone(doc.body || doc.documentElement)?.textContent);
    const labeled = text.match(/(?:发布时间|发布日期|发布于)\s*[：:]?\s*(20\d{2}\s*[-年/.]\s*\d{1,2}\s*[-月/.]\s*\d{1,2})/);
    return labeled ? extractDate(labeled[1]) : '';
  }
  function extractNoticeTitle(doc) {
    for (const sel of TITLE_SELECTORS) {
      for (const el of doc.querySelectorAll(sel)) {
        if (el.closest('nav,header,footer,aside,.sidebar,.menu')) continue;
        const t = cleanTitle(el.textContent);
        if (t.length >= 4 && t.length <= 200 && !isGenericTitle(t)) return t;
      }
    }
    const pageTitle = cleanTitle(doc.title);
    if (!isGenericTitle(pageTitle) && pageTitle.length <= 200) return pageTitle;
    let best = '', score = 0;
    for (const el of Array.from(doc.querySelectorAll('h2,h3,h4,h5,td,strong,b,[class*="title" i],[id*="title" i]')).slice(0, 600)) {
      if (el.closest('nav,header,footer,aside,.sidebar,.menu')) continue;
      const t = cleanTitle(el.textContent);
      if (t.length < 6 || t.length > 150 || isGenericTitle(t) || /首页|返回|下一页|版权所有/.test(t)) continue;
      const s = /关于|通知|公告|安排|办法|公示|方案|须知/.test(t) ? 2 : 0;
      if (s > score) { best = t; score = s; }
    }
    return best;
  }
  function hasLoadingMarker(el) {
    const selector = '[aria-busy="true"],.loading,.spinner,.skeleton,[data-loading="true"]';
    return [el.closest(selector), ...el.querySelectorAll(selector)].filter(Boolean)
      .some((n) => !n.closest('[hidden],[aria-hidden="true"]') && !/display\s*:\s*none/i.test(n.getAttribute('style') || ''));
  }
  function bodyCandidate(el, title, specific) {
    const clone = cleanClone(el);
    clone.querySelectorAll(TITLE_SELECTORS.join(',')).forEach((n) => {
      if (cleanTitle(n.textContent) === title) n.remove();
    });
    clone.querySelectorAll(DATE_SELECTORS.join(',')).forEach((n) => n.remove());
    let text = norm(clone.textContent);
    if (title && text.startsWith(title)) text = text.slice(title.length).trim();
    text = text.replace(/(?:发布时间|发布日期|发布于)\s*[：:]?\s*20\d{2}\s*[-年/.]\s*\d{1,2}\s*[-月/.]\s*\d{1,2}\s*日?(?:\s+\d{1,2}:\d{2}(?::\d{2})?)?/g, '').trim();
    const loading = hasLoadingMarker(el) || /(?:正文)?(?:正在)?加载中[，,\s]*(?:请稍候)?|^loading[.\s…]*$/i.test(text);
    const meaningful = text.length >= 4 && !LOADING_TEXT.test(text);
    const structured = Array.from(clone.querySelectorAll('p,td')).some((n) => norm(n.textContent).length >= 80);
    return { bodyText: text, bodyReady: meaningful && !loading && (specific || (structured && !!title)), loading, specific };
  }
  function parseNoticeDoc(doc) {
    const title = extractNoticeTitle(doc);
    let body = { bodyText: '', bodyReady: false, loading: false };
    for (const sel of BODY_SELECTORS) {
      for (const el of doc.querySelectorAll(sel)) {
        if (el.closest('nav,header,footer,aside,.sidebar,.menu')) continue;
        const candidate = bodyCandidate(el, title, true);
        if (candidate.bodyReady) return { title, date: extractPublishDate(doc), ...candidate };
        if (!body.specific || candidate.bodyText.length > body.bodyText.length || candidate.loading) body = candidate;
      }
    }
    // 明确正文节点尚未加载时，不以外围导航/页脚冒充正文。
    if (body.specific) return { title, date: extractPublishDate(doc), ...body };
    for (const sel of FALLBACK_BODY_SELECTORS) {
      for (const el of doc.querySelectorAll(sel)) {
        const candidate = bodyCandidate(el, title, false);
        if (candidate.bodyReady) return { title, date: extractPublishDate(doc), ...candidate };
        if (candidate.bodyText.length > body.bodyText.length) body = candidate;
      }
    }
    return { title, date: extractPublishDate(doc), ...body };
  }
  function isLoginUrl(raw) {
    try {
      const u = new URL(raw, location.href);
      if (u.hostname === 'sep.ucas.ac.cn') return true;
      const hosts = new Set(['cas', 'sso', 'authserver', 'login', 'passport', 'signin', 'idp']);
      const paths = new Set(['login', 'signin', 'sign_in', 'cas', 'sso', 'authserver', 'passport', 'loginpage']);
      return u.hostname.toLowerCase().split('.').some((x) => hosts.has(x)) ||
        u.pathname.toLowerCase().split('/').some((x) => paths.has(x));
    } catch (_) { return false; }
  }
  function looksLikeLoginPage(doc) {
    const password = doc?.querySelector('input[type="password"]');
    if (!password) return false;
    const form = password.closest('form');
    const title = norm(doc.title) + ' ' + norm(doc.querySelector('h1,h2,h3,.login-title')?.textContent);
    return /信息门户|登录|登陆|统一身份认证|sign ?in|log ?in/i.test(title + ' ' + norm(form?.textContent)) ||
      !!form?.querySelector('input[autocomplete="username"],input[name="username"],input[name="userName"],input[name="user"]') ||
      !!(form && isLoginUrl(form.getAttribute('action') || ''));
  }
  function detectAuthIssue(res, doc) {
    if (res?.status === 401 || looksLikeLoginPage(doc)) return true;
    if (res?.redirected && isLoginUrl(res.url)) return true;
    const text = norm(doc?.body?.textContent);
    return text.length < 1000 && /请重新登录|会话已过期|登录已过期|登录超时/.test(text);
  }

  // ---------- 配置与缓存 ----------
  function makePolicy(mode, minSeconds, maxSeconds) {
    return Object.freeze({
      mode, minSeconds, maxSeconds,
      intervalMinMs: Math.round(minSeconds * 1000), intervalMaxMs: Math.round(maxSeconds * 1000),
      label: (mode === 'recommended' ? '推荐' : '自定义') + '：' + formatSeconds(minSeconds) + '～' + formatSeconds(maxSeconds) + ' 秒/次'
    });
  }
  function validIntervals(min, max) {
    return Number.isFinite(min) && Number.isFinite(max) && min >= 0.001 && min <= max && max <= MAX_INTERVAL_SECONDS;
  }
  function defaultConfig() {
    return {
      version: 4, requestPolicy: { mode: 'recommended', customMinSeconds: 3, customMaxSeconds: 5 },
      ui: { from: '', to: '', expression: '', searchMode: 'title', parserMode: 'auto', onlyHit: true, skipCached: true, collapsed: false, ballPosition: null }
    };
  }
  function loadConfig() {
    const cfg = defaultConfig();
    const saved = readRaw(localStorage, CFG_KEY);
    const legacy = saved.present ? saved : readRaw(localStorage, LEGACY_NS + ':cfg');
    if (legacy.error) return { cfg, notice: '配置无法读取，已使用推荐配置。' };
    if (!legacy.value || typeof legacy.value !== 'object') return { cfg, notice: '' };
    const raw = legacy.value;
    let notice = '';
    const rp = raw.requestPolicy;
    if (rp) {
      const min = Number(rp.customMinSeconds), max = Number(rp.customMaxSeconds);
      if ((rp.mode === 'custom' || rp.mode === 'recommended') && validIntervals(min, max)) {
        cfg.requestPolicy = { mode: rp.mode, customMinSeconds: min, customMaxSeconds: max };
      } else notice = '保存的频率配置无效，已使用推荐配置。';
    }
    const u = raw.ui || raw;
    for (const key of ['from', 'to']) if (parseSafeId(u[key])) cfg.ui[key] = String(u[key]);
    cfg.ui.expression = typeof u.expression === 'string' ? u.expression : migrateKeywordExpression(u);
    if (u.ballPosition && Number.isFinite(u.ballPosition.x) && Number.isFinite(u.ballPosition.y)) {
      cfg.ui.ballPosition = { x: u.ballPosition.x, y: u.ballPosition.y };
    }
    for (const key of ['onlyHit', 'skipCached', 'collapsed']) if (typeof u[key] === 'boolean') cfg.ui[key] = u[key];
    if (['title', 'full'].includes(u.searchMode)) cfg.ui.searchMode = u.searchMode;
    if (['auto', 'http', 'iframe'].includes(u.parserMode)) cfg.ui.parserMode = u.parserMode;
    return { cfg, notice };
  }
  function sanitizeEntry(raw, legacy = false) {
    const id = parseSafeId(raw?.id);
    if (!id) return null;
    let status = raw.status;
    if (legacy) status = ({ empty: 'parsefail', error: 'net', login: 'auth', http: raw.code === 404 ? 'notfound' : 'httperror' })[status] || status;
    if (!Object.hasOwn(STATUS_LABELS, status)) status = 'parsefail';
    const upgraded = !legacy && raw.parserVersion === PARSER_VERSION;
    const entry = {
      id, status, title: String(raw.title || ''), date: upgraded ? String(raw.date || '') : '',
      bodyText: String(raw.bodyText || raw.text || ''), bodyComplete: upgraded && raw.bodyComplete === true,
      httpStatus: Number(raw.httpStatus || raw.code) || 0, source: String(raw.source || (legacy ? 'legacy' : 'cache')),
      fetchedAt: Number(raw.fetchedAt) || 0, error: String(raw.error || ''), parserVersion: upgraded ? PARSER_VERSION : 0,
      lastFailure: raw.lastFailure && RETRYABLE.has(raw.lastFailure.status) ? { ...raw.lastFailure } : null
    };
    if (entry.status === 'ok' && isGenericTitle(entry.title)) entry.status = 'parsefail';
    return entry;
  }
  function loadCache() {
    const current = readRaw(sessionStorage, cacheKey());
    if (Array.isArray(current.value?.entries)) return current.value.entries.map((e) => sanitizeEntry(e)).filter(Boolean);
    const legacy = readRaw(sessionStorage, legacyCacheKey());
    return Array.isArray(legacy.value) ? legacy.value.map((e) => sanitizeEntry(e, true)).filter(Boolean) : [];
  }
  function makeEntry(id, status, extra = {}) {
    return { id, status, title: '', date: '', bodyText: '', bodyComplete: false, source: 'http',
      httpStatus: 0, fetchedAt: now(), error: '', parserVersion: PARSER_VERSION, lastFailure: null, ...extra };
  }
  function mergeEntry(id, incoming) {
    const prev = state.results.get(id);
    if (prev?.status === 'ok' && (incoming.status !== 'ok' || (prev.bodyComplete && !incoming.bodyComplete))) {
      const retained = { ...prev, lastFailure: incoming.status === 'ok' ? null : {
        status: incoming.status, httpStatus: incoming.httpStatus, at: now(), error: incoming.error
      }};
      state.results.set(id, retained);
      return retained;
    }
    state.results.set(id, incoming);
    return incoming;
  }
  function persistCache() {
    const entries = Array.from(state.results.values());
    if (writeRaw(sessionStorage, cacheKey(), { v: 3, entries })) {
      removeRaw(sessionStorage, legacyCacheKey());
      return true;
    }
    const trimmed = entries.map((e) => ({ ...e, bodyText: '', bodyComplete: false }));
    if (writeRaw(sessionStorage, cacheKey(), { v: 3, entries: trimmed, truncated: true })) {
      state.storageWarning = '缓存空间不足：本页仍使用完整正文；刷新后需要重新获取正文。';
    } else {
      removeRaw(sessionStorage, cacheKey());
      state.storageWarning = '缓存写入失败：本页结果仍可使用，刷新后可能丢失。';
    }
    renderBanner();
    return false;
  }
  function schedulePersist() {
    if (!state.persistTimer) state.persistTimer = setTimeout(() => { state.persistTimer = 0; persistCache(); }, 500);
  }
  function needsFetch(id, options) {
    const e = state.results.get(id);
    if (options.retryOnly) return !!e && RETRYABLE.has(e.lastFailure?.status || e.status);
    if (options.force || !options.skipCached) return true;
    if (!e || e.lastFailure) return true;
    if (e.status === 'notfound') return !e.fetchedAt || now() - e.fetchedAt >= NOTFOUND_TTL_MS;
    return options.mode === 'full' ? !(e.status === 'ok' && e.bodyComplete) : e.status !== 'ok';
  }
  function retryIds() {
    return Array.from(state.results.values()).filter((e) => RETRYABLE.has(e.lastFailure?.status || e.status))
      .map((e) => e.id).filter((id) => parseSafeId(id)).sort((a, b) => b - a);
  }

  // ---------- 全局调度：原子锁，间隔/冷却跨任务持久化 ----------
  function readShared(key) {
    const stored = readRaw(localStorage, key);
    if (stored.error) throw new Error('无法读取请求间隔记录，请允许此站点使用本地存储后重试。');
    return stored.value || {};
  }
  function writeShared(key, value) {
    if (!writeRaw(localStorage, key, value)) throw new Error('无法保存请求间隔记录，已停止继续抓取。');
  }
  function readCooldownUntil() {
    const until = Number(readShared(COOLDOWN_KEY).until);
    return Number.isFinite(until) ? Math.max(0, until) : 0;
  }
  function setCooldown(seconds) {
    const until = Math.max(readCooldownUntil(), now() + seconds * 1000);
    if (!Number.isSafeInteger(Math.ceil(until))) throw new Error('服务器给出的冷却时间无法处理，请稍后再试。');
    writeShared(COOLDOWN_KEY, { until, at: now() });
    renderBanner();
  }
  function parseRetryAfter(value) {
    const s = String(value ?? '').trim();
    if (!s) return null;
    if (/^\d+$/.test(s)) {
      const seconds = Number(s);
      return Number.isSafeInteger(seconds) && Number.isSafeInteger(now() + seconds * 1000) ? seconds : null;
    }
    const date = Date.parse(s);
    return Number.isFinite(date) ? Math.max(0, Math.ceil((date - now()) / 1000)) : null;
  }
  const scheduler = {
    running: false, current: null, taskId: 0, lockHeld: false,
    isBusy() { return this.running; },
    assertActive(task) {
      if (task.signal.aborted || this.current !== task || !this.lockHeld) throw abortError();
    },
    stop() {
      if (!this.current) return false;
      this.current.ctrl.abort();
      this.resume();
      return true;
    },
    resume() {
      const task = this.current;
      if (!task) return;
      task.paused = false;
      task.resumeWaiter?.();
      task.resumeWaiter = null;
      updateRunUI();
    },
    async waitWhilePaused(task) {
      while (task.paused && !task.signal.aborted) await new Promise((resolve) => { task.resumeWaiter = resolve; });
      this.assertActive(task);
    },
    async run(policy, work) {
      if (this.running) throw Object.assign(new Error('已有任务在运行'), { code: 'BUSY' });
      if (!navigator.locks?.request) throw new Error('此页面无法使用跨标签页互斥。请通过 HTTPS 在支持 Web Locks 的新版浏览器中扫描。');
      this.running = true; // 在请求锁之前占用本页，防止重复点击竞争
      const ctrl = new AbortController();
      const task = {
        id: ++this.taskId, ctrl, signal: ctrl.signal, policy: Object.freeze({ ...policy }),
        paused: false, resumeWaiter: null, requestCount: 0, consecutiveFails: 0,
        authExpired: false, nextBackoffAt: 0
      };
      this.current = task;
      updateRunUI();
      try {
        return await navigator.locks.request(LOCK_NAME, { mode: 'exclusive', ifAvailable: true }, async (lock) => {
          if (!lock) throw Object.assign(new Error('另一个标签页正在扫描'), { code: 'LOCKED' });
          this.lockHeld = true;
          this.assertActive(task);
          writeShared(TIMING_KEY, readShared(TIMING_KEY));
          try { return await work(task); }
          finally { this.lockHeld = false; }
        });
      } finally {
        ctrl.abort();
        task.resumeWaiter?.();
        this.lockHeld = false;
        this.current = null;
        this.running = false;
        updateRunUI();
      }
    }
  };
  async function waitTurn(task, timeoutMs) {
    while (true) {
      await scheduler.waitWhilePaused(task);
      const timing = readShared(TIMING_KEY);
      const next = Number(timing.nextAllowedAt) || 0;
      const finished = Number(timing.lastFinishedAt) || 0;
      const target = Math.max(next, finished ? finished + task.policy.intervalMinMs : 0, readCooldownUntil(), task.nextBackoffAt);
      const wait = target - now();
      if (wait <= 0) break;
      setWaitStatus('等待 ' + Math.ceil(wait / 1000) + ' 秒后发起下一条…');
      renderBanner();
      await sleepAbortable(Math.min(wait, 1000), task.signal);
    }
    scheduler.assertActive(task);
    setWaitStatus('');
    task.gapMs = Math.round(task.policy.intervalMinMs + Math.random() * (task.policy.intervalMaxMs - task.policy.intervalMinMs));
    // 页面在请求中关闭时，保留保守预约时间，防止另一标签页立即再发请求。
    writeShared(TIMING_KEY, { lastFinishedAt: 0, nextAllowedAt: now() + timeoutMs + task.gapMs });
    task.requestCount++;
  }
  function finishRequest(task) {
    writeShared(TIMING_KEY, { lastFinishedAt: now(), nextAllowedAt: now() + task.gapMs });
  }
  async function requestPage(task, timeoutMs, transport) {
    await waitTurn(task, timeoutMs);
    const ctrl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctrl.abort();
    task.signal.addEventListener('abort', onAbort, { once: true });
    if (task.signal.aborted) ctrl.abort();
    const timer = setTimeout(() => { timedOut = true; ctrl.abort(); }, timeoutMs);
    try {
      const result = await transport(ctrl.signal);
      scheduler.assertActive(task);
      return result;
    } catch (e) {
      if (task.signal.aborted) throw abortError();
      if (timedOut) throw Object.assign(new Error('页面加载超时'), { kind: 'timeout' });
      throw e;
    } finally {
      clearTimeout(timer);
      task.signal.removeEventListener('abort', onAbort);
      finishRequest(task);
    }
  }
  async function noteFailure(task, attempt) {
    task.consecutiveFails++;
    task.nextBackoffAt = now() + Math.min(60000, 5000 * (2 ** attempt));
    if (task.consecutiveFails >= MAX_CONSECUTIVE_FAILURES) {
      task.consecutiveFails = 0;
      task.paused = true;
      toast('连续请求失败，已暂停；可点“继续”或“停止”。', 5000);
      updateRunUI();
      // 先返回本条已确认的失败，让范围任务保存；下一次请求在 waitTurn 中等待继续。
    }
  }
  function safeNoticeUrl(id) {
    if (!parseSafeId(id)) throw new Error('无效的通知 ID');
    const u = new URL(noticeUrl(id));
    if (u.origin !== location.origin) throw new Error('拒绝请求站外地址');
    return u.href;
  }
  async function processHttpNotice(task, id) {
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      let raw;
      try {
        raw = await requestPage(task, HTTP_TIMEOUT_MS, async (signal) => {
          const res = await fetch(safeNoticeUrl(id), {
            credentials: 'same-origin', mode: 'same-origin', cache: 'no-store', signal, redirect: 'follow'
          });
          if (res.status === 429 || (res.status === 503 && res.headers.get('retry-after'))) {
            setCooldown(parseRetryAfter(res.headers.get('retry-after')) ?? 60);
            if (res.body?.cancel) await res.body.cancel();
            return { res, text: '' };
          }
          return { res, text: await res.text() };
        });
      } catch (e) {
        if (isAbortError(e)) throw e;
        if (e.kind !== 'timeout' && e.name !== 'TypeError' && !/fetch|network|网络|load/i.test(e.message || '')) throw e;
        await noteFailure(task, attempt);
        if (attempt < MAX_RETRIES) continue;
        return makeEntry(id, e.kind === 'timeout' ? 'timeout' : 'net', { error: e.message || '网络错误，可能需要重新登录' });
      }
      const { res, text } = raw;
      const code = res.status;
      if (code === 429) {
        task.consecutiveFails = 0;
        if (attempt < MAX_RETRIES) continue;
        return makeEntry(id, 'ratelimit', { httpStatus: code, error: '服务器限流' });
      }
      const doc = new DOMParser().parseFromString(text, 'text/html');
      if (detectAuthIssue(res, doc)) {
        task.authExpired = true;
        return makeEntry(id, 'auth', { httpStatus: code, error: '登录态可能已失效' });
      }
      if (code >= 500) {
        await noteFailure(task, attempt);
        if (attempt < MAX_RETRIES) continue;
        return makeEntry(id, 'httperror', { httpStatus: code, error: 'HTTP ' + code });
      }
      task.consecutiveFails = 0;
      task.nextBackoffAt = 0;
      if (!res.ok) return makeEntry(id, code === 404 ? 'notfound' : code === 403 ? 'forbidden' : 'httperror', { httpStatus: code, error: 'HTTP ' + code });
      const p = parseNoticeDoc(doc);
      if (!p.title) return makeEntry(id, 'parsefail', { httpStatus: code, error: '未识别通知标题' });
      return makeEntry(id, 'ok', { title: p.title, date: p.date, bodyText: p.bodyText, bodyComplete: p.bodyReady, httpStatus: code });
    }
  }
  async function processIframeNotice(task, id) {
    let lastParsed = null;
    let entry;
    try {
      entry = await requestPage(task, IFRAME_TIMEOUT_MS, (signal) => new Promise((resolve, reject) => {
        const startedAt = now(); // 获得调度许可后，才开始计算加载时间
        const frame = document.createElement('iframe');
        frame.setAttribute('sandbox', 'allow-same-origin allow-scripts allow-forms');
        frame.setAttribute('data-ucas-notice-iframe', '1');
        frame.style.cssText = 'position:fixed;left:-12000px;width:1100px;height:900px;border:0;opacity:0;pointer-events:none';
        let settled = false, loaded = false, signature = '', stableAt = startedAt;
        let pollTimer = 0;
        const finish = (result, error) => {
          if (settled) return;
          settled = true;
          clearInterval(pollTimer);
          signal.removeEventListener('abort', onAbort);
          frame.onload = frame.onerror = null;
          frame.remove();
          if (error) reject(error); else resolve(result);
        };
        const onAbort = () => finish(null, abortError());
        const inspect = () => {
          if (settled) return;
          let doc;
          try { doc = frame.contentDocument; } catch (_) { doc = null; }
          if (!doc || doc.URL === 'about:blank') {
            if (loaded) finish(makeEntry(id, 'blocked', { source: 'iframe', error: '无法读取页面；可能是登录跳转或禁止嵌入' }));
            return;
          }
          if (detectAuthIssue(null, doc) || isLoginUrl(doc.URL)) {
            task.authExpired = true;
            finish(makeEntry(id, 'auth', { source: 'iframe', error: 'iframe 内出现登录页' }));
            return;
          }
          const p = parseNoticeDoc(doc);
          lastParsed = p;
          const nextSignature = p.title + '\n' + p.bodyText;
          if (nextSignature !== signature) { signature = nextSignature; stableAt = now(); }
          if (loaded && p.title && p.bodyReady && now() - stableAt >= IFRAME_STABLE_MS && now() - startedAt >= IFRAME_GRACE_MS) {
            finish(makeEntry(id, 'ok', { source: 'iframe', title: p.title, date: p.date, bodyText: p.bodyText, bodyComplete: true }));
          }
        };
        const tick = () => {
          try { inspect(); }
          catch (e) { finish(makeEntry(id, 'parsefail', { source: 'iframe', error: e.message || 'iframe 解析失败' })); }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        if (signal.aborted) { onAbort(); return; }
        frame.onload = () => { loaded = true; tick(); };
        frame.onerror = () => finish(makeEntry(id, 'blocked', { source: 'iframe', error: 'iframe 加载失败' }));
        frame.src = safeNoticeUrl(id);
        pollTimer = setInterval(tick, 250);
        (document.body || document.documentElement).appendChild(frame);
      }));
    } catch (e) {
      if (isAbortError(e)) throw e;
      if (e.kind !== 'timeout') throw e;
      entry = lastParsed?.title
        ? makeEntry(id, 'ok', { source: 'iframe', title: lastParsed.title, date: lastParsed.date, bodyText: lastParsed.bodyText, bodyComplete: false, error: '等待结束，正文完整度尚未确认' })
        : makeEntry(id, 'timeout', { source: 'iframe', error: 'iframe 加载超时' });
    }
    if (['timeout', 'blocked'].includes(entry.status)) await noteFailure(task, 0);
    else task.consecutiveFails = 0;
    return entry;
  }
  async function fetchNoticeEntry(task, id, options) {
    if (options.parserMode === 'iframe') return processIframeNotice(task, id);
    const http = await processHttpNotice(task, id);
    if (task.authExpired || options.parserMode === 'http') return http;
    const fallback = http.status === 'parsefail' || (options.mode === 'full' && http.status === 'ok' && !http.bodyComplete);
    if (!fallback) return http;
    const iframe = await processIframeNotice(task, id);
    if (iframe.status === 'auth' || iframe.status === 'ok') return iframe;
    return http.status === 'ok' ? http : iframe;
  }

  // ---------- 布尔表达式：词法分析 → 语法树 → 三态求值，不执行输入的代码 ----------
  function tokenize(text) { return String(text || '').trim().split(/\s+/).filter(Boolean); }
  function migrateKeywordExpression(fields) {
    const terms = (s) => tokenize(typeof s === 'string' ? s.slice(0, 500) : '').map((t) => JSON.stringify(t));
    const all = terms(typeof fields.all === 'string' ? fields.all : fields.keyword);
    const any = terms(fields.any), none = terms(fields.none);
    return [
      all.join(' AND '),
      any.length ? '(' + any.join(' OR ') + ')' : '',
      none.length ? 'NOT (' + none.join(' OR ') + ')' : ''
    ].filter(Boolean).join(' AND ');
  }
  function foldChar(c) {
    return c.normalize('NFKC').toLowerCase().replace(/\s/g, '').replace(/[‐‑‒–—―]/g, '-').replace(/['“”‘’「」]/g, '"');
  }
  function foldText(text, withMap = false) {
    let out = '', index = 0;
    const map = [];
    for (const char of String(text || '')) {
      const folded = foldChar(char);
      out += folded;
      if (withMap) for (let j = 0; j < folded.length; j++) map.push({ start: index, end: index + char.length });
      index += char.length;
    }
    return { text: out, map };
  }
  function compileQuery(expression) {
    const input = String(expression ?? '');
    const fail = (message, at) => { throw Object.assign(new Error(message), { at }); };
    try {
      if (input.length > MAX_QUERY_LENGTH) fail('表达式最多 ' + MAX_QUERY_LENGTH + ' 个字符', MAX_QUERY_LENGTH);
      const tokens = [];
      let pos = 0;
      while (pos < input.length) {
        if (/\s/.test(input[pos])) { pos++; continue; }
        const at = pos, c = input[pos];
        if ('()（）'.includes(c)) {
          tokens.push({ type: '（('.includes(c) ? '(' : ')', at }); pos++;
        } else if (c === '"' || c === '“') {
          const close = c === '“' ? '”' : '"';
          let value = '', closed = false;
          pos++;
          while (pos < input.length) {
            const ch = input[pos++];
            if (ch === close) { closed = true; break; }
            if (ch === '\\') {
              if (pos >= input.length) fail('转义符后缺少字符', pos - 1);
              value += input[pos++];
            } else value += ch;
          }
          if (!closed) fail('引号未闭合', at);
          if (!foldText(value).text) fail('引号中的关键词不能为空', at);
          tokens.push({ type: 'term', value, at });
        } else {
          let value = '';
          while (pos < input.length && !/[\s()（）"“”]/.test(input[pos])) value += input[pos++];
          if (!value) fail('没有对应的左引号', at);
          const operator = value.normalize('NFKC').toUpperCase();
          tokens.push({ type: ['AND', 'OR', 'NOT'].includes(operator) ? operator : 'term', value, at });
        }
        if (tokens.length > 2048) fail('表达式过于复杂，请减少关键词或括号', at);
      }
      tokens.push({ type: 'end', at: input.length });
      let index = 0;
      const peek = () => tokens[index];
      const accept = (type) => peek().type === type ? (index++, true) : false;
      function unary(depth) {
        if (depth > 64) fail('括号或 NOT 嵌套不能超过 64 层', peek().at);
        if (accept('NOT')) return { type: 'not', child: unary(depth + 1) };
        if (accept('(')) {
          if (peek().type === ')') fail('括号中缺少关键词', peek().at);
          const node = disjunction(depth + 1);
          if (!accept(')')) fail('缺少右括号 )', peek().at);
          return node;
        }
        if (peek().type === 'term') {
          const token = tokens[index++];
          return { type: 'term', value: foldText(token.value).text, raw: token.value };
        }
        fail('此处需要关键词、NOT 或左括号 (', peek().at);
      }
      function conjunction(depth) {
        const children = [unary(depth)];
        while (true) {
          if (accept('AND')) children.push(unary(depth));
          else if (['term', '(', 'NOT'].includes(peek().type)) children.push(unary(depth)); // 隐式 AND
          else break;
        }
        return children.length === 1 ? children[0] : { type: 'and', children };
      }
      function disjunction(depth) {
        const children = [conjunction(depth)];
        while (accept('OR')) children.push(conjunction(depth));
        return children.length === 1 ? children[0] : { type: 'or', children };
      }
      const ast = peek().type === 'end' ? { type: 'true' } : disjunction(0);
      if (peek().type !== 'end') fail('多余的右括号 ) 或缺少运算符', peek().at);
      const highlight = new Set();
      function visit(node, negated = false) {
        if (node.type === 'term' && !negated) highlight.add(node.raw);
        else if (node.type === 'not') visit(node.child, !negated);
        else node.children?.forEach((child) => visit(child, negated));
      }
      visit(ast);
      return { valid: true, ast, highlight: [...highlight], error: '' };
    } catch (e) {
      return { valid: false, ast: null, highlight: [], error: '第 ' + ((e.at ?? 0) + 1) + ' 位：' + e.message };
    }
  }
  // null 表示全文未完成，无法确认。NOT 未知仍未知，避免把尚未读取的排除词当作不存在。
  function evaluateQuery(node, termValue) {
    if (node.type === 'true') return true;
    if (node.type === 'term') return termValue(node.value);
    if (node.type === 'not') {
      const value = evaluateQuery(node.child, termValue);
      return value === null ? null : !value;
    }
    let unknown = false;
    for (const child of node.children) {
      const value = evaluateQuery(child, termValue);
      if (node.type === 'and' && value === false) return false;
      if (node.type === 'or' && value === true) return true;
      if (value === null) unknown = true;
    }
    return unknown ? null : node.type === 'and';
  }
  const normalizedEntries = new WeakMap();
  function matchEntry(entry, query, mode) {
    if (!query.valid) return { hit: false, pending: false, inTitle: false };
    let folded = normalizedEntries.get(entry);
    if (!folded || folded.rawTitle !== entry.title || folded.rawBody !== entry.bodyText) {
      folded = { rawTitle: entry.title, rawBody: entry.bodyText, title: foldText(entry.title).text, body: foldText(entry.bodyText).text };
      normalizedEntries.set(entry, folded);
    }
    const inTitle = (t) => folded.title.includes(t);
    const contains = (t) => inTitle(t) || (mode === 'full' && folded.body.includes(t));
    const incomplete = mode === 'full' && !entry.bodyComplete;
    const value = evaluateQuery(query.ast, (term) => contains(term) ? true : incomplete ? null : false);
    const titleValue = evaluateQuery(query.ast, (term) => inTitle(term) ? true : mode === 'full' ? null : false);
    return { hit: value === true, pending: value === null, inTitle: titleValue === true };
  }
  function highlightText(text, tokens) {
    const src = String(text || ''), folded = foldText(src, true), ranges = [];
    for (const token of tokens) {
      const needle = foldText(token).text;
      if (!needle) continue;
      for (let start = 0; start <= folded.text.length;) {
        const i = folded.text.indexOf(needle, start);
        if (i < 0) break;
        ranges.push([folded.map[i].start, folded.map[i + needle.length - 1].end]);
        start = i + needle.length;
      }
    }
    ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
    const merged = [];
    for (const r of ranges) {
      const prev = merged[merged.length - 1];
      if (prev && r[0] <= prev[1]) prev[1] = Math.max(prev[1], r[1]); else merged.push([...r]);
    }
    let html = '', pos = 0;
    for (const [start, end] of merged) {
      html += esc(src.slice(pos, start)) + '<mark>' + esc(src.slice(start, end)) + '</mark>';
      pos = end;
    }
    return html + esc(src.slice(pos));
  }

  // ---------- UI ----------
  const CSS = `
:host{all:initial;display:block;--bg:#fff;--fg:#111827;--muted:#6b7280;--bd:#e5e7eb;--soft:#f6f7f9;--soft2:#eef2ff;--accent:#2563eb;--danger:#dc2626}
*{box-sizing:border-box}[hidden]{display:none!important}
@media(prefers-color-scheme:dark){:host{--bg:#161a21;--fg:#e5e7eb;--muted:#9aa4b2;--bd:#2c333d;--soft:#1f242c;--soft2:#1e293b;--accent:#3b82f6;--danger:#f87171}}
.panel{position:fixed;top:48px;right:16px;width:410px;max-height:calc(100vh - 64px);display:flex;flex-direction:column;z-index:2147483647;background:var(--bg);color:var(--fg);border:1px solid var(--bd);border-radius:14px;box-shadow:0 18px 48px #0f172a38;overflow:hidden;font:12.5px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
@media(max-width:760px){.panel{left:8px;right:8px;width:auto}}
.hdr{display:flex;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(135deg,#1d4ed8,#2563eb);color:#fff}
.hdr strong{flex:1}.hdr small{opacity:.8}.hdr button{padding:1px 8px;background:#ffffff22;color:white;border:0}
.body{display:flex;flex-direction:column;gap:10px;padding:10px 12px 12px;overflow:auto}
.sec{border:1px solid var(--bd);background:var(--soft);border-radius:10px;padding:9px 10px}
.cur{background:var(--soft2)}.cur strong{overflow-wrap:anywhere}.hint{color:var(--muted);font-size:11px;line-height:1.6}.sec-title{font-weight:650;margin-bottom:7px}
.row{display:flex;gap:6px;align-items:center}.row+.row{margin-top:7px}.wrap{flex-wrap:wrap}.grow{flex:1;min-width:0}
input[type=number],input[type=text],select{min-width:0;padding:6px 8px;border:1px solid var(--bd);border-radius:7px;background:var(--bg);color:var(--fg);font:inherit}
input:focus,select:focus{outline:2px solid var(--accent);outline-offset:1px}input.invalid{border-color:var(--danger)}
button{font:inherit;padding:6px 9px;border-radius:7px;border:1px solid var(--bd);background:var(--bg);color:var(--fg);cursor:pointer;white-space:nowrap}
button:hover{background:var(--soft2)}button:disabled{opacity:.45;cursor:not-allowed}.primary{background:var(--accent);color:#fff;border-color:var(--accent)}
.small{font-size:11px;padding:3px 7px}.query-label{display:block;font-size:11.5px;margin-bottom:5px}.query-input{width:100%}.query-tools{display:flex;gap:5px;margin-top:6px}.query-tools button{font:600 11px/1.4 ui-monospace,monospace}
details{margin:8px 0;border:1px dashed var(--bd);border-radius:8px;padding:6px 8px}summary{cursor:pointer;font-size:11.5px}details .row{margin-top:7px}.freq input[type=number]{width:76px}
.err{color:var(--danger);font-size:11px}.tag{display:inline-block;padding:0 6px;border-radius:20px;background:var(--accent);color:#fff;font-size:10.5px;line-height:18px}.tag.gray{background:var(--soft);border:1px solid var(--bd);color:var(--muted)}.tag.pending{background:#b45309;color:#fff}
.prog{height:5px;background:var(--bd);border-radius:20px;overflow:hidden;margin:8px 0 5px}.prog i{display:block;background:var(--accent);height:100%;width:0}
.results{max-height:32vh;overflow:auto;border:1px solid var(--bd);border-radius:9px}.empty{padding:15px;color:var(--muted);font-size:11.5px}
.item{display:flex;gap:6px;padding:8px;border-bottom:1px solid var(--bd)}.item:last-child{border:0}.item a{flex:1;min-width:0;text-decoration:none;color:inherit;overflow-wrap:anywhere}.item .id{color:var(--accent);font-weight:650;margin-right:5px}.item .meta{display:flex;gap:5px;flex-wrap:wrap;margin-top:4px}.item .go{align-self:flex-start;padding:1px 6px}
mark{background:#fde68a;color:#78350f;border-radius:2px}.banner{padding:8px;border:1px solid #dc262640;background:#dc262610;color:var(--danger);border-radius:8px;font-size:11.5px;white-space:pre-wrap}.banner:empty{display:none}
.toast{position:fixed;right:20px;bottom:25px;max-width:380px;z-index:2147483647;padding:8px 12px;border-radius:8px;background:#111827f2;color:#fff;font:12px/1.5 sans-serif;opacity:0;pointer-events:none}.toast.show{opacity:1}
.float-ball{position:fixed;width:56px;height:56px;border-radius:50%;padding:0;border:1px solid #ffffff55;z-index:2147483647;background:linear-gradient(145deg,#2563eb,#1d4ed8);color:#fff;box-shadow:0 4px 18px #0f172a40;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:1px;font:600 13px/1.25 "Microsoft YaHei",sans-serif;touch-action:none;user-select:none;cursor:grab}
.float-ball:hover{background:linear-gradient(145deg,#3b82f6,#1d4ed8)}.float-ball.dragging{cursor:grabbing;box-shadow:0 6px 24px #0f172a55}.float-ball:focus-visible{outline:3px solid #93c5fd;outline-offset:3px}.float-ball small{font-size:10px;font-weight:400;opacity:.85}.float-ball[data-state=paused]{border:3px solid #fbbf24}.float-ball[data-state=running]{border:3px solid #86efac}
`;
  const HTML = `
<div class="panel" id="panel">
 <div class="hdr"><strong>教务通知检索</strong><small>v${VERSION}</small><button id="collapse" title="收起为悬浮球" aria-label="收起为悬浮球" aria-controls="panel">−</button></div>
 <div class="body">
  <div class="sec cur"><strong id="curTitle"></strong><div class="hint" id="curMeta"></div></div>
  <div class="banner" id="banner"></div>
  <div class="sec">
   <div class="sec-title">单条跳转</div>
   <div class="row"><button id="prev" title="ID - 1">◀</button><input class="grow" id="jumpId" type="number" min="1" step="1" placeholder="通知 ID" aria-label="通知 ID"><button id="next" title="ID + 1">▶</button><button id="go">打开</button></div>
  </div>
  <div class="sec">
   <div class="sec-title">检索范围 <span class="tag gray" id="scanState">未开始</span></div>
   <div class="row"><input class="grow" id="rangeFrom" type="number" min="1" step="1" placeholder="起始 ID" aria-label="起始 ID"><span>→</span><input class="grow" id="rangeTo" type="number" min="1" step="1" placeholder="结束 ID" aria-label="结束 ID"></div>
   <details class="freq" id="freqFold"><summary>检索频率 · <span id="freqSummary"></span></summary>
    <div class="row"><label><input id="freqRecommended" name="freqMode" type="radio"> 推荐 3～5 秒</label><label><input id="freqCustom" name="freqMode" type="radio"> 自定义</label></div>
    <div class="row"><input id="freqMin" type="number" min="0.001" step="any" aria-label="最小间隔秒数"><span>～</span><input id="freqMax" type="number" min="0.001" step="any" aria-label="最大间隔秒数"><span>秒</span><button class="small" id="freqReset">恢复推荐</button></div>
    <div class="err" id="freqErr"></div><div class="hint">上一条页面抓取结束后再等待；两值相同表示固定间隔。运行中修改，下次任务生效。</div>
   </details>
   <label class="query-label" for="expression">关键词表达式</label>
   <input class="query-input" id="expression" type="text" maxlength="${MAX_QUERY_LENGTH}" placeholder="选课 AND (秋季 OR 春季) AND NOT 补选" aria-describedby="queryHelp queryError" autocomplete="off" spellcheck="false">
   <div class="query-tools"><button class="small" data-insert="AND" aria-label="插入 AND">AND</button><button class="small" data-insert="OR" aria-label="插入 OR">OR</button><button class="small" data-insert="NOT" aria-label="插入 NOT">NOT</button><button class="small" data-insert="()" aria-label="插入括号">()</button></div>
   <div class="err" id="queryError" role="alert"></div>
   <div class="hint" id="queryHelp" style="margin:6px 0">优先级 NOT → AND → OR，括号优先；空格默认 AND。用双引号包住含空格、括号或运算符的关键词。留空不限制。</div>
   <div class="row"><select id="searchMode" class="grow" aria-label="搜索范围"><option value="title">标题搜索</option><option value="full">标题 + 全文</option></select><select id="parserMode" class="grow" aria-label="解析方式"><option value="auto">自动解析</option><option value="http">仅 HTTP</option><option value="iframe">强制 iframe</option></select></div>
   <div class="row wrap"><button class="primary" id="scan">开始扫描</button><button id="stop" disabled>停止</button><button id="resume" disabled>继续</button><button id="retry" disabled>重试失败项</button><button id="force">强制重扫</button></div>
   <div class="row wrap hint"><label><input id="onlyHit" type="checkbox"> 只看命中 / 待检查</label><label title="取消后重新获取范围内全部记录"><input id="skipCached" type="checkbox"> 跳过已完成</label></div>
   <div class="prog"><i id="progressBar"></i></div><div class="hint" id="scanStats">就绪</div><div class="hint" id="taskPolicy"></div><div class="hint" id="waitStatus"></div>
  </div>
  <div class="row"><strong class="grow">结果 <span class="tag" id="hitBadge">0</span></strong><button class="small" id="diag">诊断</button><button class="small" id="copy">复制</button><button class="small" id="clear">清空</button></div>
  <div class="hint" id="resultCounts"></div><div class="results" id="results"></div>
  <div class="hint">正文未完整时，无法确认的条件显示“待检查”。全文指页面正文，不含附件内部文字。标题在新标签打开，↵ 在本页打开。Alt+N 收起 / 展开。</div>
 </div>
</div><button class="float-ball" id="floatBall" hidden aria-label="展开通知检索面板" aria-controls="panel" aria-expanded="false" title="点击展开，拖动调整位置；聚焦后可用方向键移动"><span>通知</span><small id="floatState">打开</small></button><div class="toast" id="toast" role="status"></div>`;
  function buildUI() {
    if (document.getElementById('ucas-notice-nav-host')) return false;
    const host = document.createElement('div');
    host.id = 'ucas-notice-nav-host';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = '<style>' + CSS + '</style>' + HTML;
    (document.body || document.documentElement).appendChild(host);
    const els = {};
    root.querySelectorAll('[id]').forEach((el) => { els[el.id] = el; });
    ui = { host, root, els };
    return true;
  }
  function placeFloatingBall(position = state.ballPosition) {
    const width = window.innerWidth || document.documentElement.clientWidth || 1024;
    const height = window.innerHeight || document.documentElement.clientHeight || 768;
    const requested = position || { x: width - BALL_SIZE - 16, y: 48 };
    const clamp = (value, size) => Math.round(Math.max(BALL_MARGIN, Math.min(value, Math.max(BALL_MARGIN, size - BALL_SIZE - BALL_MARGIN))));
    state.ballPosition = { x: clamp(requested.x, width), y: clamp(requested.y, height) };
    ui.els.floatBall.style.left = state.ballPosition.x + 'px';
    ui.els.floatBall.style.top = state.ballPosition.y + 'px';
  }
  function setPanelCollapsed(collapsed, { persist = true, focus = true } = {}) {
    ui.els.panel.hidden = collapsed;
    ui.els.floatBall.hidden = !collapsed;
    ui.els.floatBall.setAttribute('aria-expanded', String(!collapsed));
    placeFloatingBall();
    if (persist) saveConfig();
    if (focus) (collapsed ? ui.els.floatBall : ui.els.collapse).focus({ preventScroll: true });
  }
  function bindFloatingBall() {
    const ball = ui.els.floatBall;
    let drag = null, suppressClick = false;
    const move = (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      const dx = event.clientX - drag.startX, dy = event.clientY - drag.startY;
      if (!drag.moved && Math.hypot(dx, dy) < 5) return;
      drag.moved = true;
      ball.classList.add('dragging');
      placeFloatingBall({ x: drag.origin.x + dx, y: drag.origin.y + dy });
      if (event.cancelable) event.preventDefault();
    };
    const end = (cancelled) => {
      if (!drag) return;
      const finished = drag;
      drag = null; // releasePointerCapture 可能立即触发 lostpointercapture
      if (cancelled) placeFloatingBall(finished.origin);
      suppressClick = cancelled || finished.moved;
      ball.classList.remove('dragging');
      try { ball.releasePointerCapture?.(finished.id); } catch (_) { /* 指针已释放 */ }
      if (finished.moved) saveConfig();
    };
    ball.addEventListener('pointerdown', (event) => {
      if (ball.hidden || drag || event.button !== 0 || event.isPrimary === false) return;
      suppressClick = false;
      drag = { id: event.pointerId, startX: event.clientX, startY: event.clientY, origin: { ...state.ballPosition }, moved: false };
      ball.focus({ preventScroll: true });
      try { ball.setPointerCapture?.(event.pointerId); } catch (_) { /* window 监听仍可完成拖动 */ }
    });
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', (event) => {
      if (!drag || event.pointerId !== drag.id) return;
      move(event); end(false);
    });
    window.addEventListener('pointercancel', (event) => { if (drag?.id === event.pointerId) end(true); });
    ball.addEventListener('lostpointercapture', () => end(true));
    window.addEventListener('blur', () => end(true));
    ball.addEventListener('click', (event) => {
      // 只吞掉拖动产生的指针 click；键盘/辅助技术触发的 detail=0 仍可以展开。
      if (suppressClick && (event.detail !== 0 || event.pointerType)) { suppressClick = false; event.preventDefault(); return; }
      suppressClick = false;
      setPanelCollapsed(false);
    });
    ball.addEventListener('keydown', (event) => {
      if (event.altKey || event.ctrlKey || event.metaKey) return;
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
      if (!delta) return;
      event.preventDefault();
      const step = event.shiftKey ? 36 : 12;
      placeFloatingBall({ x: state.ballPosition.x + delta[0] * step, y: state.ballPosition.y + delta[1] * step });
      saveConfig();
    });
    window.addEventListener('resize', () => {
      end(true);
      placeFloatingBall();
      saveConfig();
    });
  }
  let toastTimer = 0;
  function toast(text, duration = 3500) {
    if (!ui) return;
    ui.els.toast.textContent = text;
    ui.els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => ui.els.toast.classList.remove('show'), duration);
  }
  function showBanner(text) { if (ui) { ui.els.banner.dataset.manual = text || ''; renderBanner(); } }
  function renderBanner() {
    if (!ui) return;
    let cooldown = 0;
    try { cooldown = Math.max(0, readCooldownUntil() - now()); } catch (_) { /* 任务开始时报告存储错误 */ }
    ui.els.banner.textContent = [
      ui.els.banner.dataset.manual, state.authNotice, state.storageWarning,
      cooldown ? '服务器冷却剩余约 ' + Math.ceil(cooldown / 1000) + ' 秒；重新开始也会等待。' : '',
      scheduler.current?.paused ? '任务已暂停，点“继续”恢复，或点“停止”结束。' : ''
    ].filter(Boolean).join('\n');
  }
  function readPolicyFromUI() {
    if (ui.els.freqRecommended.checked) return { ok: true, policy: makePolicy('recommended', RECOMMENDED.minSeconds, RECOMMENDED.maxSeconds) };
    const min = Number(ui.els.freqMin.value), max = Number(ui.els.freqMax.value);
    if (!validIntervals(min, max)) return { ok: false, error: '间隔需为 0.001～86400 秒，且最小值不大于最大值。' };
    return { ok: true, policy: makePolicy('custom', min, max) };
  }
  function updateFreqUI() {
    const p = readPolicyFromUI();
    ui.els.freqMin.disabled = ui.els.freqMax.disabled = ui.els.freqRecommended.checked;
    ui.els.freqSummary.textContent = p.ok ? p.policy.label : '请修正配置';
    ui.els.freqErr.textContent = p.ok ? '' : p.error;
  }
  function collectUiFields() {
    const e = ui.els;
    return {
      from: e.rangeFrom.value, to: e.rangeTo.value, expression: e.expression.value,
      searchMode: e.searchMode.value, parserMode: e.parserMode.value, onlyHit: e.onlyHit.checked,
      skipCached: e.skipCached.checked, collapsed: e.panel.hidden, ballPosition: { ...state.ballPosition }
    };
  }
  function saveConfig() {
    const p = readPolicyFromUI();
    let rp = state.config.requestPolicy;
    if (p.ok) {
      if (p.policy.mode === 'custom') state.lastValidCustom = { min: p.policy.minSeconds, max: p.policy.maxSeconds };
      rp = { mode: p.policy.mode, customMinSeconds: state.lastValidCustom.min, customMaxSeconds: state.lastValidCustom.max };
    }
    state.config = { version: 4, requestPolicy: rp, ui: collectUiFields() };
    if (!writeRaw(localStorage, CFG_KEY, state.config)) {
      state.storageWarning = '设置保存失败，刷新后可能恢复为之前的配置。';
      renderBanner();
    }
  }
  function applyConfig() {
    const e = ui.els, u = state.config.ui, rp = state.config.requestPolicy;
    state.lastValidCustom = { min: rp.customMinSeconds, max: rp.customMaxSeconds };
    e.freqRecommended.checked = rp.mode !== 'custom'; e.freqCustom.checked = rp.mode === 'custom';
    e.freqMin.value = rp.customMinSeconds; e.freqMax.value = rp.customMaxSeconds;
    e.rangeFrom.value = u.from || (IS_DETAIL ? Math.max(1, CUR_ID - 150) : '');
    e.rangeTo.value = u.to || (IS_DETAIL ? CUR_ID : '');
    e.jumpId.value = CUR_ID || '';
    e.prev.disabled = e.next.disabled = !IS_DETAIL;
    e.expression.value = u.expression;
    e.searchMode.value = u.searchMode; e.parserMode.value = u.parserMode;
    e.onlyHit.checked = u.onlyHit; e.skipCached.checked = u.skipCached;
    state.ballPosition = u.ballPosition;
    setPanelCollapsed(u.collapsed, { persist: false, focus: false });
    updateFreqUI();
  }
  let cachedExpression = null, cachedQuery = null;
  function getQuery() {
    const expression = ui.els.expression.value;
    if (expression !== cachedExpression) {
      cachedExpression = expression; cachedQuery = compileQuery(expression);
    }
    return cachedQuery;
  }
  function updateQueryUI() {
    const query = getQuery();
    ui.els.queryError.textContent = query.error;
    ui.els.expression.setAttribute('aria-invalid', String(!query.valid));
    ui.els.expression.classList.toggle('invalid', !query.valid);
    return query;
  }
  function insertQueryOperator(operator) {
    const input = ui.els.expression;
    const start = input.selectionStart ?? input.value.length, end = input.selectionEnd ?? start;
    const selected = input.value.slice(start, end);
    const wrapped = operator === '()' || (operator === 'NOT' && !!selected);
    const inserted = wrapped ? (operator === 'NOT' ? 'NOT ' : '') + '(' + selected + ')' : ' ' + operator + ' ';
    if (input.value.length - (end - start) + inserted.length > MAX_QUERY_LENGTH) { toast('表达式已达到长度上限。'); return; }
    input.setRangeText(inserted, start, end, 'end');
    if (operator === '()' && !selected) input.setSelectionRange(start + 1, start + 1);
    input.focus({ preventScroll: true });
    updateQueryUI(); saveConfig(); renderResults();
  }
  function scoredResults() {
    const query = getQuery(), mode = ui.els.searchMode.value;
    if (!query.valid) return [];
    return Array.from(state.results.values()).filter((e) => e.status === 'ok')
      .map((e) => ({ e, ...matchEntry(e, query, mode) })).sort((a, b) => b.e.id - a.e.id);
  }
  function scheduleRender() {
    if (!state.renderTimer) state.renderTimer = setTimeout(() => { state.renderTimer = 0; renderResults(); }, 140);
  }
  function renderResults() {
    if (!ui) return;
    const query = updateQueryUI();
    if (!query.valid) {
      ui.els.hitBadge.textContent = '—';
      ui.els.resultCounts.textContent = '表达式有误，修正后重新筛选已有结果。';
      ui.els.results.innerHTML = '<div class="empty">请按输入框下方提示修正表达式。已抓取的记录会保留。</div>';
      updateRunUI();
      return;
    }
    const all = scoredResults();
    const hits = all.filter((x) => x.hit).length, pending = all.filter((x) => x.pending).length;
    ui.els.hitBadge.textContent = hits;
    ui.els.resultCounts.textContent = '已收录 ' + all.length + ' · 命中 ' + hits + ' · 待检查 ' + pending + ' · 失败待重试 ' + retryIds().length;
    const list = ui.els.onlyHit.checked ? all.filter((x) => x.hit || x.pending) : all;
    const scroll = ui.els.results.scrollTop;
    ui.els.results.innerHTML = list.length ? list.map(({ e, hit, pending: unknown, inTitle }) => {
      const label = unknown ? '待检查全文' : hit ? (inTitle ? '标题符合' : '全文符合') : '不符合';
      const snippet = e.bodyText.slice(0, 100) + (e.bodyText.length > 100 ? '…' : '');
      return '<div class="item"><a href="' + esc(noticeUrl(e.id)) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="id">#' + e.id + '</span>' + highlightText(e.title, query.highlight) +
        (snippet ? '<div class="hint">' + highlightText(snippet, query.highlight) + '</div>' : '') +
        '<div class="meta"><span class="tag ' + (unknown ? 'pending' : hit ? '' : 'gray') + '">' + label + '</span>' +
        (e.bodyComplete ? '' : '<span class="tag gray">正文待确认</span>') +
        (e.date ? '<span class="hint">' + esc(e.date) + '</span>' : '') +
        (e.lastFailure ? '<span class="tag gray">上次抓取：' + esc(STATUS_LABELS[e.lastFailure.status] || '失败') + '</span>' : '') +
        '</div></a><button class="go" data-open-self="' + e.id + '" title="在当前标签打开">↵</button></div>';
    }).join('') : '<div class="empty">' + (all.length ? '没有符合条件的记录。可调整与 / 或 / 非条件或切换搜索范围。' : '设置 ID 范围后开始扫描。') + '</div>';
    ui.els.results.scrollTop = scroll;
    updateRunUI();
  }
  function updateRunUI() {
    if (!ui) return;
    const busy = scheduler.running;
    const valid = updateQueryUI().valid;
    ui.els.scan.disabled = ui.els.force.disabled = busy || !valid;
    ui.els.retry.disabled = busy || !valid || !retryIds().length;
    ui.els.copy.disabled = !valid;
    ui.els.clear.disabled = busy; ui.els.stop.disabled = !busy;
    ui.els.resume.disabled = !scheduler.current?.paused;
    if (busy) ui.els.scanState.textContent = scheduler.current?.paused ? '已暂停' : '扫描中…';
    const ballState = busy ? (scheduler.current?.paused ? 'paused' : 'running') : 'idle';
    ui.els.floatBall.dataset.state = ballState;
    ui.els.floatState.textContent = { paused: '暂停', running: '扫描', idle: '打开' }[ballState];
    ui.els.floatBall.setAttribute('aria-label', '展开通知检索面板' + (busy ? '，' + ui.els.floatState.textContent + '中' : ''));
    renderBanner();
  }
  function setWaitStatus(text) { if (ui) ui.els.waitStatus.textContent = text; }
  function renderProgress() {
    if (!ui) return;
    const t = state.task, s = state.scanStats;
    ui.els.progressBar.style.width = t?.total ? Math.min(100, Math.round(t.done / t.total * 100)) + '%' : '0%';
    ui.els.scanStats.textContent = t ? '进度 ' + t.done + '/' + t.total + ' · 成功 ' + s.ok + ' · 正文待确认 ' + s.partial + ' · 失败 ' + s.failed : '就绪';
    ui.els.taskPolicy.textContent = t ? '本次：' + t.policyLabel + ' · ' + (t.mode === 'full' ? '获取全文' : '获取标题') : '';
  }
  function refreshCurrentPage() {
    if (!IS_DETAIL || looksLikeLoginPage(document)) return;
    const p = parseNoticeDoc(document);
    state.currentParsed = p;
    if (p.title && !state.currentFetchedByTask) {
      mergeEntry(CUR_ID, makeEntry(CUR_ID, 'ok', { title: p.title, date: p.date, bodyText: p.bodyText, bodyComplete: p.bodyReady, source: 'current' }));
      schedulePersist();
    }
    if (ui) {
      ui.els.curTitle.textContent = p.title || '未识别通知标题，可复制诊断信息';
      ui.els.curMeta.textContent = '#' + CUR_ID + ' · 分类 ' + CAT + (p.date ? ' · ' + p.date : ' · 发布日期未知');
      renderResults();
    }
  }

  // ---------- 任务与交互 ----------
  async function runRangeScan(options) {
    return scheduler.run(options.policy, async (task) => {
      const ids = options.ids;
      if (!Array.isArray(ids) || ids.length > MAX_RANGE_COUNT || ids.some((id) => !parseSafeId(id))) throw new Error('待抓取 ID 列表无效或超过上限');
      const todo = [...new Set(ids)].filter((id) => needsFetch(id, options));
      state.task = { total: todo.length, done: 0, policyLabel: options.policy.label, mode: options.mode };
      state.scanStats = { ok: 0, partial: 0, failed: 0 };
      renderProgress();
      let stopped = false;
      try {
        for (const id of todo) {
          scheduler.assertActive(task);
          const entry = await fetchNoticeEntry(task, id, options);
          scheduler.assertActive(task);
          if (id === CUR_ID) state.currentFetchedByTask = true;
          mergeEntry(id, entry);
          state.task.done++;
          if (entry.status === 'ok') { state.scanStats.ok++; if (!entry.bodyComplete) state.scanStats.partial++; }
          else state.scanStats.failed++;
          schedulePersist(); scheduleRender(); renderProgress();
          if (task.authExpired) break;
        }
      } catch (e) {
        if (!isAbortError(e)) throw e;
        stopped = true;
      }
      return { stopped, authExpired: task.authExpired, total: todo.length, skipped: ids.length - todo.length };
    });
  }
  async function startScan(retryOnly = false, force = false) {
    if (scheduler.running) { toast('已有任务运行中，请先停止或等待完成。'); return; }
    if (!updateQueryUI().valid) { renderResults(); ui.els.expression.focus(); toast('请先修正关键词表达式。'); return; }
    const pol = readPolicyFromUI();
    if (!pol.ok) { updateFreqUI(); ui.els.freqFold.open = true; toast(pol.error); return; }
    let ids;
    if (retryOnly) {
      ids = retryIds();
      if (!ids.length) { toast('没有可重试的失败项。'); return; }
      if (ids.length > MAX_RANGE_COUNT) { toast('失败项超过 ' + MAX_RANGE_COUNT + ' 条，请用 ID 范围分批重试。'); return; }
    } else {
      const from = parseSafeId(ui.els.rangeFrom.value), to = parseSafeId(ui.els.rangeTo.value);
      if (!from || !to) { toast('起止 ID 必须是 1～999999999 的整数。'); return; }
      const lo = Math.min(from, to), hi = Math.max(from, to);
      if (hi - lo + 1 > MAX_RANGE_COUNT) { toast('每次最多扫描 ' + MAX_RANGE_COUNT + ' 个 ID。'); return; }
      ids = Array.from({ length: hi - lo + 1 }, (_, i) => hi - i);
    }
    saveConfig();
    state.authNotice = ''; showBanner('');
    let status = '已完成';
    try {
      const result = await runRangeScan({
        ids, retryOnly, force, policy: pol.policy, skipCached: ui.els.skipCached.checked,
        mode: ui.els.searchMode.value, parserMode: ui.els.parserMode.value
      });
      if (result.authExpired) {
        status = '登录中断';
        state.authNotice = '检测到登录失效，已停止后续抓取。请重新登录后重试失败项。';
      } else if (result.stopped) {
        status = '已停止'; toast('已停止扫描，已取得的结果已保留。');
      } else if (!result.total) toast('范围内结果已满足当前模式，本次未发起请求；可使用强制重扫。', 5000);
      else toast('扫描完成：成功 ' + state.scanStats.ok + ' 条，失败 ' + state.scanStats.failed + ' 条。');
    } catch (e) {
      status = '已停止';
      if (!isAbortError(e)) showBanner(e.message || String(e));
    } finally {
      ui.els.scanState.textContent = status; setWaitStatus('');
      persistCache(); renderResults(); renderProgress(); updateRunUI();
    }
  }
  async function copyToClipboard(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch (_) { /* fallback */ }
    const input = document.createElement('textarea');
    input.value = text; input.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(input); input.select();
    try { return document.execCommand('copy'); } catch (_) { return false; } finally { input.remove(); }
  }
  function goTo(id) {
    const safe = parseSafeId(id);
    if (!safe) { toast('通知 ID 必须是 1～999999999 的整数。'); return; }
    scheduler.stop(); saveConfig(); persistCache();
    location.href = noticeUrl(safe);
  }
  function bindEvents() {
    const e = ui.els;
    e.scan.addEventListener('click', () => { void startScan(); });
    e.force.addEventListener('click', () => { void startScan(false, true); });
    e.retry.addEventListener('click', () => { void startScan(true); });
    e.stop.addEventListener('click', () => scheduler.stop());
    e.resume.addEventListener('click', () => scheduler.resume());
    e.go.addEventListener('click', () => goTo(e.jumpId.value));
    e.prev.addEventListener('click', () => goTo(CUR_ID - 1));
    e.next.addEventListener('click', () => goTo(CUR_ID + 1));
    e.jumpId.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); goTo(e.jumpId.value); } });
    for (const key of ['freqRecommended', 'freqCustom', 'freqMin', 'freqMax']) {
      e[key].addEventListener('change', () => {
        updateFreqUI(); saveConfig();
        if (scheduler.running) toast('频率已修改，将在下次任务生效。');
      });
      if (key === 'freqMin' || key === 'freqMax') e[key].addEventListener('input', updateFreqUI);
    }
    e.freqReset.addEventListener('click', () => {
      e.freqRecommended.checked = true; e.freqCustom.checked = false;
      updateFreqUI(); saveConfig();
      toast(scheduler.running ? '已恢复推荐频率，下次任务生效。' : '已恢复推荐频率。');
    });
    e.expression.addEventListener('input', () => { updateRunUI(); saveConfig(); scheduleRender(); });
    ui.root.querySelectorAll('[data-insert]').forEach((button) => {
      button.addEventListener('click', () => insertQueryOperator(button.dataset.insert));
    });
    for (const key of ['rangeFrom', 'rangeTo', 'searchMode', 'parserMode', 'onlyHit', 'skipCached']) {
      e[key].addEventListener('change', () => {
        saveConfig(); scheduleRender();
        if (scheduler.running && ['searchMode', 'parserMode', 'skipCached'].includes(key)) toast('筛选立即更新；抓取方式将在下次任务生效。');
      });
    }
    e.collapse.addEventListener('click', () => setPanelCollapsed(true));
    bindFloatingBall();
    e.results.addEventListener('click', (event) => {
      const button = event.target.closest('[data-open-self]');
      if (button) { event.preventDefault(); goTo(button.dataset.openSelf); }
    });
    e.clear.addEventListener('click', () => {
      if (scheduler.running || !window.confirm('清空当前分类的检索缓存？')) return;
      clearTimeout(state.persistTimer); state.persistTimer = 0;
      state.results.clear(); state.task = state.scanStats = null;
      persistCache(); renderResults(); renderProgress();
      ui.els.scanState.textContent = '未开始'; setWaitStatus(''); toast('已清空。');
    });
    e.copy.addEventListener('click', async () => {
      const rows = scoredResults().filter((x) => !e.onlyHit.checked || x.hit || x.pending);
      if (!rows.length) { toast('没有可复制的结果。'); return; }
      const text = rows.map((x) => [x.e.id, x.pending ? '待检查' : x.hit ? '命中' : '不符合', x.e.date, x.e.title, noticeUrl(x.e.id)].join('\t')).join('\n');
      toast(await copyToClipboard(text) ? '已复制 ' + rows.length + ' 条（含匹配状态）。' : '复制失败。');
    });
    e.diag.addEventListener('click', async () => {
      const data = {
        version: VERSION, url: location.href, title: document.title, parsedTitle: state.currentParsed?.title,
        bodyLength: state.currentParsed?.bodyText.length || 0, bodyComplete: !!state.currentParsed?.bodyReady,
        fields: collectUiFields(), sample: Array.from(state.results.values()).slice(0, 10).map((x) => ({
          id: x.id, status: x.status, title: x.title, bodyLength: x.bodyText.length, bodyComplete: x.bodyComplete, error: x.error
        }))
      };
      toast(await copyToClipboard(JSON.stringify(data, null, 2)) ? '诊断信息已复制。' : '复制失败。');
    });
    document.addEventListener('keydown', (event) => {
      if (event.defaultPrevented || !event.altKey || event.ctrlKey || event.metaKey) return;
      const target = event.composedPath()[0];
      if (target?.closest?.('input,textarea,select,[contenteditable="true"]')) return;
      if (IS_DETAIL && ['ArrowUp', 'ArrowDown'].includes(event.key)) {
        event.preventDefault(); goTo(CUR_ID + (event.key === 'ArrowUp' ? 1 : -1));
      } else if (event.key.toLowerCase() === 'n') {
        event.preventDefault(); setPanelCollapsed(!e.panel.hidden);
      }
    }, true);
    window.addEventListener('pagehide', () => {
      scheduler.stop();
      clearTimeout(state.persistTimer); state.persistTimer = 0;
      persistCache();
    });
    window.addEventListener('storage', (event) => { if (event.key === COOLDOWN_KEY) renderBanner(); });
  }
  function bootstrap() {
    const loaded = loadConfig();
    state.config = loaded.cfg;
    for (const entry of loadCache()) state.results.set(entry.id, entry);
    if (!buildUI()) return;
    applyConfig(); bindEvents();
    if (IS_DETAIL) {
      refreshCurrentPage();
      [600, 1500, 3200].forEach((ms) => setTimeout(refreshCurrentPage, ms)); // 只读 DOM，不发请求
    } else {
      ui.els.curTitle.textContent = '通知范围检索';
      ui.els.curMeta.textContent = '分类 ' + CAT + ' · 请填写需要检索的 ID 范围';
    }
    if (looksLikeLoginPage(document)) state.authNotice = '当前页可能是登录页，请先完成登录。';
    if (loaded.notice) { showBanner(loaded.notice); saveConfig(); }
    renderResults(); renderProgress(); updateRunUI();
  }
  bootstrap();
})();
