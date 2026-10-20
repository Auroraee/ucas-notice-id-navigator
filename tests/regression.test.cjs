'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const FakeTimers = require('@sinonjs/fake-timers');

const source = fs.readFileSync(path.join(__dirname, '..', 'new-ucas-notice-id-navigator.user.js'), 'utf8');
const exportsForTest = [
  'bootstrap', 'state', 'scheduler', 'makePolicy', 'defaultConfig', 'loadConfig', 'loadCache',
  'makeEntry', 'mergeEntry', 'persistCache', 'needsFetch', 'retryIds', 'parseNoticeDoc',
  'detectAuthIssue', 'looksLikeLoginPage', 'isLoginUrl', 'parseSafeId', 'compileQuery',
  'matchEntry', 'highlightText', 'parseRetryAfter', 'setCooldown', 'readCooldownUntil',
  'requestPage', 'runRangeScan', 'processHttpNotice', 'processIframeNotice', 'refreshCurrentPage',
  'CFG_KEY', 'TIMING_KEY', 'COOLDOWN_KEY', 'cacheKey', 'renderResults'
];
assert.equal(source.split('  bootstrap();').length, 2, 'test instrumentation must target exactly one bootstrap');
const instrumented = source.replace('  bootstrap();', `  globalThis.__test = { ${exportsForTest.join(',')} };`);

function memoryStorage() {
  const entries = new Map();
  return {
    getItem: key => entries.has(key) ? entries.get(key) : null,
    setItem: (key, value) => entries.set(key, String(value)),
    removeItem: key => entries.delete(key),
    clear: () => entries.clear()
  };
}
function atomicLocks() {
  let held = false;
  return {
    async request(name, options, callback) {
      assert.equal(options.ifAvailable, true);
      if (held) return callback(null);
      held = true;
      try { return await callback({ name }); } finally { held = false; }
    }
  };
}
function setup(t, { html = '<title>教务系统</title>', local = memoryStorage(), session = memoryStorage(), locks = atomicLocks() } = {}) {
  // No resource loader: jsdom cannot issue real HTTP/iframe requests.
  const dom = new JSDOM(html, { url: 'https://jwxk.ucas.ac.cn/notice/1/10/view', runScripts: 'outside-only' });
  const w = dom.window;
  Object.defineProperty(w, 'localStorage', { value: local });
  Object.defineProperty(w, 'sessionStorage', { value: session });
  Object.defineProperty(w.navigator, 'locks', { value: locks });
  w.fetch = () => { throw new Error('Unexpected fetch: all network calls must be mocked'); };
  const clock = FakeTimers.withGlobal(w).install({
    now: 1800000000000, toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval']
  });
  w.eval(instrumented);
  const a = w.__test;
  a.state.config = a.defaultConfig();
  const doc = html => new w.DOMParser().parseFromString(html, 'text/html');
  const policy = a.makePolicy('custom', 3, 3);
  t.after(() => { clock.uninstall(); dom.window.close(); });
  return { w, a, clock, local, session, doc, policy };
}
function notice(title = '关于秋季选课的通知', body = '请同学们按要求完成课程选择。') {
  return `<title>教务系统</title><h1 class="notice-title">${title}</h1><div class="notice-content">${body}</div>`;
}
function response(html, status = 200, retryAfter = null) {
  return {
    status, ok: status >= 200 && status < 300, redirected: false,
    url: 'https://jwxk.ucas.ac.cn/notice/1/10/view',
    headers: { get: name => name.toLowerCase() === 'retry-after' ? retryAfter : null },
    body: { cancel: async () => {} }, text: async () => html
  };
}
function options(env, ids, extra = {}) {
  return { ids, policy: env.policy, skipCached: true, mode: 'full', parserMode: 'http', ...extra };
}
function fakeFrames(env, html) {
  const { w, doc } = env, frames = [], original = w.document.createElement.bind(w.document);
  w.document.createElement = (tag, ...args) => {
    const el = original(tag, ...args);
    if (tag === 'iframe') {
      const content = doc(html);
      Object.defineProperty(content, 'URL', { value: 'https://jwxk.ucas.ac.cn/notice/1/20/view' });
      Object.defineProperty(el, 'contentDocument', { get: () => content });
      frames.push({ el, content, at: w.Date.now() });
      w.setTimeout(() => el.onload?.(), 10);
    }
    return el;
  };
  return frames;
}

test('AND, OR and NOT apply together, with empty groups imposing no constraint', t => {
  const { a } = setup(t);
  const query = a.compileQuery({ all: '选课 通知', any: '秋季 春季', none: '补选 取消' });
  const check = title => a.matchEntry(a.makeEntry(1, 'ok', { title }), query, 'title').hit;
  assert.equal(check('关于秋季选课的通知'), true);
  assert.equal(check('关于春季选课的通知'), true);
  assert.equal(check('关于夏季选课的通知'), false);
  assert.equal(check('关于秋季选课补选的通知'), false);
  assert.equal(check('秋季课程安排'), false);
  const empty = a.compileQuery({});
  assert.equal(a.matchEntry(a.makeEntry(1, 'ok', { title: '通知正文' }), empty, 'title').hit, true);
});

test('unknown full text stays pending for NOT or missing positive terms', t => {
  const { a } = setup(t);
  const e = a.makeEntry(1, 'ok', { title: '秋季选课通知', bodyText: '正文尚未完整' });
  const negative = a.compileQuery({ all: '选课', none: '补选' });
  assert.equal(a.matchEntry(e, negative, 'full').pending, true);
  assert.equal(a.matchEntry(e, negative, 'full').hit, false);
  assert.equal(a.matchEntry(e, negative, 'title').hit, true);
  assert.equal(a.matchEntry(e, a.compileQuery({ all: '奖学金' }), 'full').pending, true);
  assert.equal(a.matchEntry(e, a.compileQuery({ all: '选课' }), 'full').hit, true);
  e.bodyText = '本通知用于补选';
  assert.equal(a.matchEntry(e, negative, 'full').pending, false);
  assert.equal(a.matchEntry(e, negative, 'full').hit, false);
  e.bodyText = '请按时选择课程。'; e.bodyComplete = true;
  assert.equal(a.matchEntry(e, negative, 'full').hit, true);
});

test('full text beyond character 400 survives persistence and supports exclusions', t => {
  const { a } = setup(t);
  const e = a.makeEntry(20, 'ok', { title: '关于选课的通知', bodyText: '正文'.repeat(700) + '尾部关键词补选', bodyComplete: true });
  a.state.results.set(20, e);
  assert.equal(a.persistCache(), true);
  const loaded = a.loadCache()[0];
  assert.equal(loaded.bodyText, e.bodyText);
  assert.equal(loaded.bodyComplete, true);
  assert.equal(a.matchEntry(loaded, a.compileQuery({ all: '尾部关键词' }), 'full').hit, true);
  assert.equal(a.matchEntry(loaded, a.compileQuery({ all: '选课', none: '补选' }), 'full').hit, false);
});

test('highlighting cannot alter markup or entities and supports Unicode normalization', t => {
  const { a, doc } = setup(t);
  const text = '<img src=x onerror=alert(1)> & mark ＡＢＣ 😀选课';
  const html = a.highlightText(text, ['mark', '&', 'img', 'abc', '😀选课']);
  const parsed = doc(`<div id="result">${html}</div>`);
  assert.equal(parsed.querySelector('#result').textContent, text);
  assert.equal(parsed.querySelectorAll('img,script,[onerror]').length, 0);
  assert.equal(parsed.querySelectorAll('mark').length, 5);
  assert.equal(a.matchEntry(a.makeEntry(1, 'ok', { title: 'ＡＢＣ　选课' }), a.compileQuery({ all: 'abc 选课' }), 'title').hit, true);
});

test('parser retains body headings and selects labeled publication date only', t => {
  const { a, doc } = setup(t);
  const p = a.parseNoticeDoc(doc(notice(undefined, '<h1>补选要求</h1><p>选课开始日期为 2026-10-20。</p>')));
  assert.equal(p.bodyReady, true);
  assert.match(p.bodyText, /补选要求/);
  assert.equal(p.date, '');
  const labeled = a.parseNoticeDoc(doc(notice() + '<p>发布日期：2026年10月19日</p>'));
  assert.equal(labeled.date, '2026-10-19');
  const invalid = a.parseNoticeDoc(doc(notice() + '<span class="publish-date">2026-02-30</span>'));
  assert.equal(invalid.date, '');
});

test('page chrome and unfilled/loading body containers cannot become full text', t => {
  const { a, doc } = setup(t);
  for (const body of [
    '<nav>' + '导航选课'.repeat(30) + '</nav><main><h1>秋季选课通知</h1></main>',
    notice(undefined, '') + '<main><p>' + '无关内容'.repeat(50) + '</p></main>',
    '<h1>秋季选课通知</h1><div class="notice-content" aria-busy="true">请稍候，当前显示的是占位说明文字。</div>',
    notice(undefined, '正在加载中，请稍候')
  ]) assert.equal(a.parseNoticeDoc(doc(body)).bodyReady, false);
  const ready = a.parseNoticeDoc(doc('<h3>关于秋季选课的通知</h3><div class="main-content"><p>' + '正文信息'.repeat(30) + '</p></div>'));
  assert.equal(ready.title, '关于秋季选课的通知');
  assert.equal(ready.bodyReady, true);
});

test('ucas host redirects do not match cas, but portal password forms do', t => {
  const { a, doc } = setup(t);
  assert.equal(a.isLoginUrl('https://jwxk.ucas.ac.cn/notice/1/100/view'), false);
  assert.equal(a.detectAuthIssue({ redirected: true, url: 'https://jwxk.ucas.ac.cn/notice/1/100/view' }, doc(notice())), false);
  assert.equal(a.isLoginUrl('https://sep.ucas.ac.cn/'), true);
  assert.equal(a.isLoginUrl('https://jwxk.ucas.ac.cn/cas/login'), true);
  assert.equal(a.looksLikeLoginPage(doc('<title>信息门户</title><form><input name="username"><input type="password"></form>')), true);
  assert.equal(a.looksLikeLoginPage(doc(notice())), false);
});

test('migration keeps keyword/filter choices but invalidates old body completeness', t => {
  const { a, local, session } = setup(t);
  local.setItem(a.CFG_KEY, JSON.stringify({
    requestPolicy: { mode: 'custom', customMinSeconds: 2, customMaxSeconds: 4 },
    ui: { keyword: '选课 通知', searchMode: 'full', skipCached: false }
  }));
  const { cfg } = a.loadConfig();
  assert.equal(cfg.ui.all, '选课 通知');
  assert.equal(cfg.ui.skipCached, false);
  assert.equal(cfg.requestPolicy.mode, 'custom');
  session.setItem(a.cacheKey(), JSON.stringify({ v: 2, entries: [{
    id: 20, status: 'ok', title: '秋季选课通知', bodyText: '此前误认为完整的内容', bodyComplete: true, httpStatus: 200
  }] }));
  const e = a.loadCache()[0];
  assert.equal(e.bodyComplete, false);
  assert.equal(e.httpStatus, 200);
});

test('skip completed respects mode, unchecked setting, failures, and 404 TTL', t => {
  const env = setup(t), { a, clock } = env;
  a.state.results.set(1, a.makeEntry(1, 'ok', { title: '秋季选课通知', bodyComplete: true }));
  assert.equal(a.needsFetch(1, options(env, [1])), false);
  assert.equal(a.needsFetch(1, options(env, [1], { skipCached: false })), true);
  assert.equal(a.needsFetch(1, options(env, [1], { force: true })), true);
  a.state.results.set(2, a.makeEntry(2, 'ok', { title: '只获取了标题' }));
  assert.equal(a.needsFetch(2, options(env, [2])), true);
  assert.equal(a.needsFetch(2, options(env, [2], { mode: 'title' })), false);
  a.state.results.set(3, a.makeEntry(3, 'parsefail'));
  assert.equal(a.needsFetch(3, options(env, [3])), true);
  a.state.results.set(4, a.makeEntry(4, 'notfound', { httpStatus: 404 }));
  assert.equal(a.needsFetch(4, options(env, [4])), false);
  clock.tick(86400000);
  assert.equal(a.needsFetch(4, options(env, [4])), true);
});

test('quota fallback marks persisted body incomplete without truncating live search', t => {
  const session = memoryStorage(), original = session.setItem;
  session.setItem = (key, value) => {
    if (value.length > 1000) throw new Error('QuotaExceededError');
    original(key, value);
  };
  const { a } = setup(t, { session });
  const e = a.makeEntry(1, 'ok', { title: '秋季选课通知', bodyText: '正文'.repeat(1000), bodyComplete: true });
  a.state.results.set(1, e);
  assert.equal(a.persistCache(), false);
  assert.equal(a.state.results.get(1).bodyText.length, 2000);
  assert.equal(a.loadCache()[0].bodyComplete, false);
  assert.equal(a.loadCache()[0].bodyText, '');
  assert.match(a.state.storageWarning, /空间不足/);
});

test('sparse retries keep only actual failed IDs and preserve previous good content', t => {
  const { a } = setup(t);
  a.state.results.set(1, a.makeEntry(1, 'net'));
  a.state.results.set(999999999, a.makeEntry(999999999, 'timeout'));
  const good = a.makeEntry(5, 'ok', { title: '已获取的完整通知', bodyText: '有效正文信息', bodyComplete: true });
  a.state.results.set(5, good);
  a.mergeEntry(5, a.makeEntry(5, 'httperror', { httpStatus: 503 }));
  assert.deepEqual(Array.from(a.retryIds()), [999999999, 5, 1]);
  assert.equal(a.state.results.get(5).bodyText, good.bodyText);
  assert.equal(a.state.results.get(5).lastFailure.httpStatus, 503);
});

test('request interval persists across tasks and errors', async t => {
  const { a, clock, policy, w } = setup(t);
  const times = [];
  await a.scheduler.run(policy, task => a.requestPage(task, 15000, async () => { times.push(w.Date.now()); }));
  const next = a.scheduler.run(policy, task => a.requestPage(task, 15000, async () => { times.push(w.Date.now()); }));
  await clock.tickAsync(2999);
  assert.equal(times.length, 1);
  await clock.tickAsync(1); await next;
  assert.equal(times[1] - times[0], 3000);
  const failed = a.scheduler.run(policy, task => a.requestPage(task, 15000, async () => { throw new Error('transport failed'); }));
  const rejection = assert.rejects(failed, /transport failed/);
  await clock.tickAsync(3000); await rejection;
  const third = a.scheduler.run(policy, task => a.requestPage(task, 15000, async () => { times.push(w.Date.now()); }));
  await clock.tickAsync(2999);
  assert.equal(times.length, 2);
  await clock.tickAsync(1); await third;
  assert.equal(a.scheduler.running, false);
});

test('atomic lock prevents overlapping tabs and is released on task failure', async t => {
  const locks = atomicLocks(), local = memoryStorage();
  const one = setup(t, { locks, local }), two = setup(t, { locks, local });
  let finish;
  const first = one.a.scheduler.run(one.policy, () => new Promise(resolve => { finish = resolve; }));
  await assert.rejects(two.a.scheduler.run(two.policy, () => assert.fail('second tab acquired lock')), /另一个标签页/);
  finish(); await first;
  await assert.rejects(one.a.scheduler.run(one.policy, async () => { throw new Error('unexpected'); }), /unexpected/);
  await two.a.scheduler.run(two.policy, async () => {});
  assert.equal(one.a.scheduler.running, false);
  assert.equal(two.a.scheduler.running, false);
});

test('stop aborts queue wait without issuing a new request', async t => {
  const { a, clock, policy } = setup(t);
  await a.scheduler.run(policy, task => a.requestPage(task, 10000, async () => {}));
  let calls = 0;
  const pending = a.scheduler.run(policy, task => a.requestPage(task, 10000, async () => { calls++; }));
  const stopped = assert.rejects(pending, { name: 'AbortError' });
  await clock.tickAsync(100);
  a.scheduler.stop();
  await stopped;
  await clock.tickAsync(10000);
  assert.equal(calls, 0);
  assert.equal(a.scheduler.running, false);
});

test('request timeout covers the response body and stop aborts an active fetch', async t => {
  const { a, clock, policy, w } = setup(t);
  let signal;
  const wait = task => a.requestPage(task, 15000, incoming => {
    signal = incoming;
    return new Promise((resolve, reject) => incoming.addEventListener('abort', () => reject(new w.DOMException('aborted', 'AbortError'))));
  });
  const timeout = a.scheduler.run(policy, wait);
  const timeoutCheck = assert.rejects(timeout, e => e.kind === 'timeout');
  await clock.tickAsync(15000); await timeoutCheck;
  assert.equal(signal.aborted, true);
  const active = a.scheduler.run(policy, wait);
  const stopCheck = assert.rejects(active, { name: 'AbortError' });
  await clock.tickAsync(3000);
  a.scheduler.stop(); await stopCheck;
  assert.equal(signal.aborted, true);
});

test('429 Retry-After is honored across tasks without a one-hour cap', async t => {
  const env = setup(t), { a, w, clock } = env;
  const starts = [];
  w.fetch = async () => { starts.push(w.Date.now()); return response('', 429, '7200'); };
  const scan = a.runRangeScan(options(env, [21]));
  await clock.tickAsync(0);
  assert.equal(starts.length, 1);
  assert.equal(a.readCooldownUntil() - w.Date.now(), 7200000);
  a.scheduler.stop(); assert.equal((await scan).stopped, true);
  w.fetch = async () => { starts.push(w.Date.now()); return response(notice()); };
  const next = a.runRangeScan(options(env, [22]));
  await clock.tickAsync(0);
  clock.setSystemTime(w.Date.now() + 7199000);
  await clock.tickAsync(999);
  assert.equal(starts.length, 1);
  await clock.tickAsync(1); await next;
  assert.equal(starts[1] - starts[0], 7200000);
  const future = new w.Date(w.Date.now() + 120000).toUTCString();
  assert.equal(a.parseRetryAfter(future), 120);
});

test('login response stops the range and caches a retryable auth status', async t => {
  const env = setup(t), { a, w } = env;
  let calls = 0;
  w.fetch = async () => { calls++; return response('<title>信息门户</title><form><input name="username"><input type="password"></form>'); };
  const result = await a.runRangeScan(options(env, [21, 20, 19]));
  assert.equal(result.authExpired, true);
  assert.equal(calls, 1);
  assert.equal(a.state.results.get(21).status, 'auth');
  assert.equal(a.scheduler.running, false);
});

test('three server errors pause and stop releases the task', async t => {
  const env = setup(t), { a, w, clock } = env;
  let calls = 0;
  w.fetch = async () => { calls++; return response('服务器错误', 500); };
  const scan = a.runRangeScan(options(env, [21, 20]));
  await clock.tickAsync(15000);
  assert.equal(calls, 3);
  assert.equal(a.scheduler.current.paused, true);
  assert.equal(a.state.results.get(21).status, 'httperror');
  a.scheduler.stop();
  assert.equal((await scan).stopped, true);
  assert.deepEqual(Array.from(a.retryIds()), [21]);
  assert.equal(a.scheduler.running, false);
});

test('iframe timers start after rate-limit wait and frames are cleaned up', async t => {
  const env = setup(t), { a, clock, policy, w } = env;
  const frames = fakeFrames(env, notice());
  await a.scheduler.run(policy, task => a.requestPage(task, 10000, async () => {}));
  const start = w.Date.now();
  const result = a.scheduler.run(policy, task => a.processIframeNotice(task, 20));
  await clock.tickAsync(2999); assert.equal(frames.length, 0);
  await clock.tickAsync(1); assert.equal(frames.length, 1);
  assert.equal(frames[0].at - start, 3000);
  await clock.tickAsync(1000); assert.equal(frames[0].el.isConnected, true);
  await clock.tickAsync(500);
  const entry = await result;
  assert.equal(entry.status, 'ok');
  assert.equal(entry.bodyComplete, true);
  assert.equal(frames[0].el.isConnected, false);
});

test('iframe waits for dynamic content and stop removes a still-loading frame', async t => {
  const env = setup(t), { a, clock, policy } = env;
  const frames = fakeFrames(env, '<h1>秋季选课通知</h1><div class="notice-content" aria-busy="true">正在加载中</div>');
  const pending = a.scheduler.run(policy, task => a.processIframeNotice(task, 20));
  await clock.tickAsync(2000);
  assert.equal(frames[0].el.isConnected, true);
  const body = frames[0].content.querySelector('.notice-content');
  body.removeAttribute('aria-busy'); body.textContent = '请同学们按时完成秋季课程选择。';
  await clock.tickAsync(1000);
  assert.equal((await pending).bodyComplete, true);
  const another = a.scheduler.run(policy, task => a.processIframeNotice(task, 21));
  const stopCheck = assert.rejects(another, { name: 'AbortError' });
  await clock.tickAsync(3000);
  assert.equal(frames[1].el.isConnected, true);
  a.scheduler.stop(); await stopCheck;
  assert.equal(frames[1].el.isConnected, false);
  await clock.tickAsync(20000);
  assert.equal(a.scheduler.running, false);
});

test('iframe login page is recognized rather than marked as a notice', async t => {
  const env = setup(t), { a, clock, policy } = env;
  const frames = fakeFrames(env, '<title>信息门户</title><form><input name="username"><input type="password"></form>');
  const pending = a.scheduler.run(policy, task => a.processIframeNotice(task, 20));
  await clock.tickAsync(10);
  assert.equal((await pending).status, 'auth');
  assert.equal(frames[0].el.isConnected, false);
});

test('automatic mode fetches iframe only when the selected search mode needs it', async t => {
  const env = setup(t), { a, w, clock } = env;
  w.fetch = async () => response('<title>教务系统</title><h1>秋季选课通知</h1><div class="notice-content"></div>');
  const frames = fakeFrames(env, notice());
  await a.runRangeScan(options(env, [21], { parserMode: 'auto', mode: 'title' }));
  assert.equal(frames.length, 0);
  const full = a.runRangeScan(options(env, [21], { parserMode: 'auto' }));
  await clock.tickAsync(7500); await full;
  assert.equal(frames.length, 1);
  assert.equal(a.state.results.get(21).bodyComplete, true);
});

test('delayed current-page reads cannot overwrite a fresh scanned result', async t => {
  const env = setup(t, { html: notice('旧版本通知标题', '旧版正文。') }), { a, w } = env;
  a.bootstrap();
  w.fetch = async () => response(notice('更新后的通知标题', '最新正文内容。'));
  await a.runRangeScan(options(env, [10], { force: true }));
  a.refreshCurrentPage();
  assert.equal(a.state.results.get(10).title, '更新后的通知标题');
});

test('UI boots without network probes, removes list/preset controls, and saves boolean filters', async t => {
  const env = setup(t, { html: notice() }), { a, w, clock } = env;
  a.bootstrap();
  const root = w.document.getElementById('ucas-notice-nav-host').shadowRoot;
  assert.equal(root.querySelector('#freqRecommended').checked, true);
  assert.equal(root.querySelector('#freqMin').disabled, true);
  assert.equal(root.querySelector('#freqSummary').textContent, '推荐：3～5 秒/次');
  assert.doesNotMatch(root.textContent, /抓列表|一键找选课/);
  root.querySelector('#allWords').value = '选课';
  root.querySelector('#anyWords').value = '秋季 春季';
  root.querySelector('#noneWords').value = '补选';
  root.querySelector('#noneWords').dispatchEvent(new w.Event('input'));
  await clock.tickAsync(140);
  assert.equal(a.loadConfig().cfg.ui.none, '补选');
  assert.equal(root.querySelector('#hitBadge').textContent, '1');
  const link = root.querySelector('#results a');
  assert.equal(link.target, '_blank');
  root.querySelector('#noneWords').value = '秋季';
  root.querySelector('#noneWords').dispatchEvent(new w.Event('input'));
  await clock.tickAsync(140);
  assert.equal(root.querySelector('#hitBadge').textContent, '0');
  await clock.tickAsync(3200); // current-page DOM refreshes also must not issue requests
});

test('UI validates custom interval and persists selection; fresh users get recommendation', t => {
  const { a, w } = setup(t);
  a.bootstrap();
  const root = w.document.getElementById('ucas-notice-nav-host').shadowRoot;
  root.querySelector('#freqCustom').click();
  root.querySelector('#freqMin').value = '2';
  root.querySelector('#freqMax').value = '1';
  root.querySelector('#freqMin').dispatchEvent(new w.Event('change'));
  assert.match(root.querySelector('#freqErr').textContent, /最小值/);
  root.querySelector('#freqMax').value = '4';
  root.querySelector('#freqMax').dispatchEvent(new w.Event('change'));
  assert.equal(root.querySelector('#freqErr').textContent, '');
  assert.equal(a.loadConfig().cfg.requestPolicy.customMinSeconds, 2);
  assert.equal(a.loadConfig().cfg.requestPolicy.customMaxSeconds, 4);
  root.querySelector('#freqReset').click();
  assert.equal(a.loadConfig().cfg.requestPolicy.mode, 'recommended');
});
