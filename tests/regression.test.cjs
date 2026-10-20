'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const FakeTimers = require('@sinonjs/fake-timers');

const source = fs.readFileSync(path.join(__dirname, '..', 'new-ucas-notice-id-navigator.user.js'), 'utf8');
const mcBodyNotice = fs.readFileSync(path.join(__dirname, 'fixtures', 'mc-body-notice.html'), 'utf8');
const exportsForTest = [
  'bootstrap', 'state', 'scheduler', 'makePolicy', 'defaultConfig', 'loadConfig', 'loadCache',
  'makeEntry', 'mergeEntry', 'persistCache', 'needsFetch', 'retryIds', 'parseNoticeDoc',
  'detectAuthIssue', 'looksLikeLoginPage', 'isLoginUrl', 'parseSafeId', 'compileQuery',
  'matchEntry', 'highlightText', 'parseRetryAfter', 'setCooldown', 'readCooldownUntil',
  'requestPage', 'runRangeScan', 'processHttpNotice', 'processIframeNotice', 'refreshCurrentPage',
  'CFG_KEY', 'TIMING_KEY', 'COOLDOWN_KEY', 'cacheKey', 'renderResults', 'startScan', 'migrateKeywordExpression'
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

test('AND, OR and NOT compose in a single expression, with empty input imposing no constraint', t => {
  const { a } = setup(t);
  const query = a.compileQuery('选课 AND 通知 AND (秋季 OR 春季) AND NOT (补选 OR 取消)');
  assert.equal(query.valid, true);
  const check = title => a.matchEntry(a.makeEntry(1, 'ok', { title }), query, 'title').hit;
  assert.equal(check('关于秋季选课的通知'), true);
  assert.equal(check('关于春季选课的通知'), true);
  assert.equal(check('关于夏季选课的通知'), false);
  assert.equal(check('关于秋季选课补选的通知'), false);
  assert.equal(check('秋季课程安排'), false);
  const empty = a.compileQuery('');
  assert.equal(a.matchEntry(a.makeEntry(1, 'ok', { title: '通知正文' }), empty, 'title').hit, true);
});

test('unknown full text stays pending for NOT or missing positive terms', t => {
  const { a } = setup(t);
  const e = a.makeEntry(1, 'ok', { title: '秋季选课通知', bodyText: '正文尚未完整' });
  const negative = a.compileQuery('选课 AND NOT 补选');
  assert.equal(a.matchEntry(e, negative, 'full').pending, true);
  assert.equal(a.matchEntry(e, negative, 'full').hit, false);
  assert.equal(a.matchEntry(e, negative, 'title').hit, true);
  assert.equal(a.matchEntry(e, a.compileQuery('奖学金'), 'full').pending, true);
  assert.equal(a.matchEntry(e, a.compileQuery('选课'), 'full').hit, true);
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
  assert.equal(a.matchEntry(loaded, a.compileQuery('尾部关键词'), 'full').hit, true);
  assert.equal(a.matchEntry(loaded, a.compileQuery('选课 AND NOT 补选'), 'full').hit, false);
});

test('highlighting cannot alter markup or entities and supports Unicode normalization', t => {
  const { a, doc } = setup(t);
  const text = '<img src=x onerror=alert(1)> & mark ＡＢＣ 😀选课';
  const html = a.highlightText(text, ['mark', '&', 'img', 'abc', '😀选课']);
  const parsed = doc(`<div id="result">${html}</div>`);
  assert.equal(parsed.querySelector('#result').textContent, text);
  assert.equal(parsed.querySelectorAll('img,script,[onerror]').length, 0);
  assert.equal(parsed.querySelectorAll('mark').length, 5);
  assert.equal(a.matchEntry(a.makeEntry(1, 'ok', { title: 'ＡＢＣ　选课' }), a.compileQuery('abc 选课'), 'title').hit, true);
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

test('UCAS mc-body template yields its exact h3 title and full adjacent body', t => {
  const { a, doc } = setup(t);
  const longHtml = mcBodyNotice.replace('全文末尾测试关键词', '中间正文内容。'.repeat(150) + '全文末尾测试关键词');
  const p = a.parseNoticeDoc(doc(longHtml));
  assert.equal(p.title, '中国科学院大学2025-2026学年秋季学期研究生课程网络选课说明');
  assert.equal(p.bodyReady, true);
  assert.ok(p.bodyText.length > 900);
  assert.match(p.bodyText, /正文内的小标题/);
  assert.match(p.bodyText, /跨学科兼修/);
  assert.doesNotMatch(p.bodyText, /页头导航|页脚导航|测试附件文件名|查看通知-选课系统/);
  assert.equal(p.date, '', 'course and signature dates are not explicit publication metadata');
  const arbitraryTitle = mcBodyNotice.replace(/<h3>[^<]+<\/h3>/, '<h3>研究生课程跨学科兼修</h3>');
  assert.equal(a.parseNoticeDoc(doc(arbitraryTitle)).title, '研究生课程跨学科兼修');
});

test('empty or loading mc-body content cannot use attachment filenames as full text', t => {
  const { a, doc } = setup(t);
  for (const body of ['', '<div></div>', '<div aria-busy="true">正在加载中</div>']) {
    const p = a.parseNoticeDoc(doc(`<title>查看通知-选课系统</title>
      <div class="m-cbox"><div class="mc-body"><h3>研究生课程网络选课说明</h3>${body}
      <div id="existsfiles"><a href="/notice/file/1/file.pdf">附件名称与内容提示</a></div></div></div>`));
    assert.equal(p.title, '研究生课程网络选课说明');
    assert.equal(p.bodyReady, false);
    assert.doesNotMatch(p.bodyText, /附件名称/);
  }
});

test('mc-body title and tail keywords work through HTTP, iframe and restored cache', async t => {
  const env = setup(t), { a, w, clock, policy } = env;
  w.fetch = async () => response(mcBodyNotice);
  await a.runRangeScan(options(env, [794], { parserMode: 'auto', mode: 'title' }));
  const e = a.state.results.get(794);
  assert.equal(e.status, 'ok');
  assert.equal(e.bodyComplete, true);
  assert.equal(a.matchEntry(e, a.compileQuery('2025-2026'), 'title').hit, true);
  assert.equal(a.matchEntry(e, a.compileQuery('跨学科兼修'), 'full').hit, true);
  a.persistCache();
  assert.equal(a.matchEntry(a.loadCache()[0], a.compileQuery('跨学科兼修'), 'full').hit, true);
  fakeFrames(env, mcBodyNotice);
  const iframe = a.scheduler.run(policy, task => a.processIframeNotice(task, 795));
  await clock.tickAsync(5000);
  const rendered = await iframe;
  assert.equal(rendered.title, e.title);
  assert.equal(rendered.bodyComplete, true);
  assert.equal(rendered.bodyText, e.bodyText);
});

test('current-page bootstrap reads the mc-body template without issuing requests', t => {
  const { a } = setup(t, { html: mcBodyNotice });
  a.bootstrap();
  assert.equal(a.state.results.get(10).title, '中国科学院大学2025-2026学年秋季学期研究生课程网络选课说明');
  assert.equal(a.state.results.get(10).bodyComplete, true);
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
  assert.equal(cfg.ui.expression, '"选课" AND "通知"');
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

test('an older parser cache is revalidated even in title mode with skip completed on', async t => {
  const env = setup(t), { a, session, w } = env;
  session.setItem(a.cacheKey(), JSON.stringify({ v: 2, entries: [{
    ...a.makeEntry(794, 'ok', { title: '旧版选中的正文小标题', bodyText: '旧版正文', bodyComplete: true }),
    parserVersion: 3
  }] }));
  const old = a.loadCache()[0];
  a.state.results.set(794, old);
  assert.equal(old.bodyComplete, false);
  assert.equal(a.needsFetch(794, options(env, [794], { mode: 'title' })), true);
  assert.equal(a.needsFetch(794, options(env, [794], { mode: 'full' })), true);
  w.fetch = async () => response(mcBodyNotice);
  await a.runRangeScan(options(env, [794], { mode: 'title' }));
  assert.equal(a.state.results.get(794).title, '中国科学院大学2025-2026学年秋季学期研究生课程网络选课说明');
  assert.equal(a.needsFetch(794, options(env, [794], { mode: 'title' })), false);
  assert.equal(a.needsFetch(794, options(env, [794], { mode: 'full' })), false);
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
  assert.equal(root.querySelectorAll('#allWords,#anyWords,#noneWords').length, 0);
  root.querySelector('#expression').value = '选课 AND (秋季 OR 春季) AND NOT 补选';
  root.querySelector('#expression').dispatchEvent(new w.Event('input'));
  await clock.tickAsync(140);
  assert.equal(a.loadConfig().cfg.ui.expression, '选课 AND (秋季 OR 春季) AND NOT 补选');
  assert.equal(root.querySelector('#hitBadge').textContent, '1');
  const link = root.querySelector('#results a');
  assert.equal(link.target, '_blank');
  root.querySelector('#expression').value = '选课 AND NOT 秋季';
  root.querySelector('#expression').dispatchEvent(new w.Event('input'));
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

test('operator precedence, parentheses and repeated NOT implement arbitrary combinations', t => {
  const { a } = setup(t);
  const hit = (expression, title) => {
    const q = a.compileQuery(expression);
    assert.equal(q.valid, true, q.error);
    return a.matchEntry(a.makeEntry(1, 'ok', { title }), q, 'title').hit;
  };
  assert.equal(hit('秋季 OR 春季 AND 选课', '秋季安排'), true);
  assert.equal(hit('(秋季 OR 春季) AND 选课', '秋季安排'), false);
  assert.equal(hit('NOT 秋季 AND 春季', '秋季春季通知'), false);
  assert.equal(hit('NOT (秋季 AND 春季)', '秋季通知'), true);
  assert.equal(hit('(选课 AND 秋季) OR (考试 AND NOT 补考)', '考试通知'), true);
  assert.equal(hit('(选课 AND 秋季) OR (考试 AND NOT 补考)', '考试补考通知'), false);
  assert.equal(hit('NOT NOT 选课', '选课通知'), true);
  assert.equal(hit('选课（秋季 or 春季）not 补选', '春季选课通知'), true);
  assert.equal(hit('选课 通知 NOT 补选', '选课补选通知'), false);
  assert.equal(hit('"OR" OR "AND"', 'OR 运算规则'), true);
  assert.equal(hit('“学术 英语” AND 通知', '学术英语课程通知'), true);
  assert.equal(hit('"a\\"b" AND "c\\\\d"', 'a"b c\\d'), true);
});

test('syntax errors are explicit and bounded, never silently converted into a different query', t => {
  const { a, w } = setup(t);
  for (const input of ['AND 选课', 'OR', 'NOT', '选课 AND', '选课 OR OR 通知', '()', '(选课', '选课)', '"选课', '""', '”']) {
    const q = a.compileQuery(input);
    assert.equal(q.valid, false, input);
    assert.match(q.error, /^第 \d+ 位：/);
    assert.equal(a.matchEntry(a.makeEntry(1, 'ok', { title: '选课通知' }), q, 'title').hit, false);
  }
  assert.equal(a.compileQuery('('.repeat(70) + '选课' + ')'.repeat(70)).valid, false);
  assert.equal(a.compileQuery('NOT '.repeat(70) + '选课').valid, false);
  assert.equal(a.compileQuery('选课'.repeat(5000)).valid, false);
  assert.equal(a.compileQuery('a '.repeat(2200)).valid, false);
  a.compileQuery('globalThis.__pwned = true');
  assert.equal(w.__pwned, undefined);
});

test('nested expressions propagate incomplete full text without false exclusions or positives', t => {
  const { a } = setup(t);
  const e = a.makeEntry(1, 'ok', { title: '选课通知', bodyText: '秋季课程', bodyComplete: false });
  const match = (s) => a.matchEntry(e, a.compileQuery(s), 'full');
  assert.equal(match('选课 OR NOT 补选').hit, true);
  assert.equal(match('NOT (补选 OR 取消)').pending, true);
  assert.equal(match('NOT (选课 OR 补选)').hit, false);
  assert.equal(match('NOT (选课 OR 补选)').pending, false);
  assert.equal(match('NOT 选课 AND 未知词').pending, false);
  assert.equal(match('(选课 AND NOT 补选) OR 奖学金').pending, true);
  assert.equal(match('NOT NOT 选课').hit, true);
  assert.equal(match('NOT (未知词 AND NOT 选课)').hit, true);
  e.bodyComplete = true;
  assert.equal(match('(选课 AND NOT 补选) OR 奖学金').hit, true);
  assert.equal(match('NOT (补选 OR 取消)').inTitle, false); // absence needs the full body
  e.bodyText += '补选';
  assert.equal(match('(选课 AND NOT 补选) OR 奖学金').hit, false);
});

test('highlights follow NOT parity without marking operator syntax or exclusions', t => {
  const { a } = setup(t);
  const q = a.compileQuery('选课 AND NOT (补选 OR 取消) OR NOT NOT "AND"');
  assert.deepEqual(Array.from(q.highlight), ['选课', 'AND']);
  assert.deepEqual(Array.from(a.compileQuery('NOT (选课 AND NOT 秋季)').highlight), ['秋季']);
});

test('legacy three-field queries migrate without reinterpreting reserved words and punctuation', t => {
  const { a, local } = setup(t);
  local.setItem(a.CFG_KEY, JSON.stringify({
    version: 3, ui: { all: '选课 AND', any: '秋季 春季', none: '补选 (取消)', collapsed: true }
  }));
  const loaded = a.loadConfig().cfg;
  assert.equal(loaded.version, 4);
  assert.equal(loaded.ui.collapsed, true);
  const q = a.compileQuery(loaded.ui.expression);
  assert.equal(q.valid, true, q.error);
  const hit = title => a.matchEntry(a.makeEntry(1, 'ok', { title }), q, 'title').hit;
  assert.equal(hit('选课 AND 秋季通知'), true);
  assert.equal(hit('选课 秋季通知'), false);
  assert.equal(hit('选课 AND 秋季 (取消)'), false);
  local.setItem(a.CFG_KEY, JSON.stringify({ ui: { expression: '(选课 OR 考试) AND NOT 取消', all: '过时设置' } }));
  assert.equal(a.loadConfig().cfg.ui.expression, '(选课 OR 考试) AND NOT 取消');
  const maximumLegacy = a.migrateKeywordExpression({ all: 'a '.repeat(250), any: 'b '.repeat(250), none: 'c '.repeat(250) });
  assert.equal(a.compileQuery(maximumLegacy).valid, true, 'all three legacy fields can migrate at their old length limit');
});

test('migration preserves old complete-text truth table including empty groups', t => {
  const { a } = setup(t);
  for (const fields of [
    { all: '选课 通知', any: '秋季 春季', none: '补选 取消' },
    { all: '', any: '秋季 春季', none: '' },
    { all: '', any: '', none: '补选 取消' },
    { all: '', any: '', none: '' }
  ]) {
    const q = a.compileQuery(a.migrateKeywordExpression(fields));
    assert.equal(q.valid, true);
    const words = ['选课', '通知', '秋季', '春季', '补选', '取消'];
    for (let bits = 0; bits < 64; bits++) {
      const title = words.filter((_, i) => bits & (1 << i)).join(' ');
      const group = s => s.split(/\s+/).filter(Boolean);
      const expected = group(fields.all).every(t => title.includes(t)) &&
        (!fields.any || group(fields.any).some(t => title.includes(t))) &&
        !group(fields.none).some(t => title.includes(t));
      assert.equal(a.matchEntry(a.makeEntry(1, 'ok', { title, bodyComplete: true }), q, 'full').hit, expected);
    }
  }
});

test('invalid expression blocks starting or copying but preserves cached results', async t => {
  const { a, w, clock } = setup(t, { html: notice() });
  a.bootstrap();
  const root = w.document.getElementById('ucas-notice-nav-host').shadowRoot;
  const input = root.querySelector('#expression');
  input.value = '选课 AND (秋季 OR';
  input.dispatchEvent(new w.Event('input'));
  assert.equal(root.querySelector('#scan').disabled, true);
  assert.equal(root.querySelector('#force').disabled, true);
  assert.equal(root.querySelector('#copy').disabled, true);
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  await clock.tickAsync(140);
  assert.equal(root.querySelector('#hitBadge').textContent, '—');
  assert.equal(a.state.results.size, 1);
  await a.startScan(); // explicit guard also covers invocation outside the disabled button
  assert.equal(a.scheduler.running, false);
  input.value = '(选课 OR 考试) AND NOT 补选';
  input.dispatchEvent(new w.Event('input'));
  await clock.tickAsync(140);
  assert.equal(root.querySelector('#scan').disabled, false);
  assert.equal(root.querySelector('#copy').disabled, false);
  assert.equal(root.querySelector('#hitBadge').textContent, '1');
});

test('operator buttons insert at the cursor and parentheses wrap selected expressions', t => {
  const { a, w } = setup(t);
  a.bootstrap();
  const root = w.document.getElementById('ucas-notice-nav-host').shadowRoot;
  const input = root.querySelector('#expression');
  input.value = '秋季 OR 春季';
  input.setSelectionRange(0, input.value.length);
  root.querySelector('[data-insert="()"]').click();
  assert.equal(input.value, '(秋季 OR 春季)');
  input.setSelectionRange(input.value.length, input.value.length);
  root.querySelector('[data-insert="AND"]').click();
  assert.equal(input.value, '(秋季 OR 春季) AND ');
  input.setRangeText('选课', input.selectionStart, input.selectionEnd, 'end');
  input.setSelectionRange(0, input.value.length);
  root.querySelector('[data-insert="NOT"]').click();
  assert.equal(input.value, 'NOT ((秋季 OR 春季) AND 选课)');
  assert.equal(a.loadConfig().cfg.ui.expression, input.value);
  input.value = ''; input.setSelectionRange(0, 0);
  root.querySelector('[data-insert="()"]').click();
  assert.equal(input.value, '()');
  assert.equal(input.selectionStart, 1);
});

function pointer(w, target, type, x, y, { id = 1, primary = true, button = 0 } = {}) {
  const event = new w.MouseEvent(type, { bubbles: true, composed: true, cancelable: true, clientX: x, clientY: y, button });
  Object.defineProperties(event, { pointerId: { value: id }, isPrimary: { value: primary } });
  target.dispatchEvent(event);
}

test('collapse hides the entire panel and click restores it with filters unchanged', t => {
  const { a, w } = setup(t);
  a.bootstrap();
  const root = w.document.getElementById('ucas-notice-nav-host').shadowRoot;
  const panel = root.querySelector('#panel'), ball = root.querySelector('#floatBall');
  root.querySelector('#expression').value = '选课 OR 考试';
  root.querySelector('#collapse').click();
  assert.equal(panel.hidden, true);
  assert.equal(ball.hidden, false);
  assert.equal(a.loadConfig().cfg.ui.collapsed, true);
  assert.equal(root.activeElement, ball);
  ball.click();
  assert.equal(panel.hidden, false);
  assert.equal(ball.hidden, true);
  assert.equal(a.loadConfig().cfg.ui.collapsed, false);
  assert.equal(root.querySelector('#expression').value, '选课 OR 考试');
  assert.equal(root.activeElement, root.querySelector('#collapse'));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'n', altKey: true, bubbles: true }));
  assert.equal(panel.hidden, true);
  w.document.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'n', altKey: true, bubbles: true }));
  assert.equal(panel.hidden, false);
});

test('dragging saves position, suppresses its synthetic click, and allows the next tap', t => {
  const local = memoryStorage(), { a, w } = setup(t, { local });
  a.bootstrap();
  const root = w.document.getElementById('ucas-notice-nav-host').shadowRoot, ball = root.querySelector('#floatBall');
  root.querySelector('#collapse').click();
  const before = { ...a.state.ballPosition };
  pointer(w, ball, 'pointerdown', 960, 60);
  pointer(w, ball, 'pointermove', 780, 200);
  pointer(w, ball, 'pointerup', 780, 200);
  ball.dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail: 1 }));
  assert.equal(root.querySelector('#panel').hidden, true);
  assert.equal(a.state.ballPosition.x, before.x - 180);
  assert.equal(a.state.ballPosition.y, before.y + 140);
  assert.equal(a.loadConfig().cfg.ui.ballPosition.x, before.x - 180);
  assert.equal(ball.classList.contains('dragging'), false);
  const restored = setup(t, { local });
  restored.a.bootstrap();
  const restoredRoot = restored.w.document.getElementById('ucas-notice-nav-host').shadowRoot;
  assert.equal(restoredRoot.querySelector('#floatBall').hidden, false);
  assert.equal(restored.a.state.ballPosition.x, before.x - 180);
  pointer(w, ball, 'pointerdown', 780, 200);
  pointer(w, ball, 'pointerup', 781, 201);
  ball.dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail: 1 }));
  assert.equal(root.querySelector('#panel').hidden, false);
});

test('ball stays on screen during dragging, viewport resize and keyboard movement', t => {
  const { a, w } = setup(t);
  a.bootstrap();
  const root = w.document.getElementById('ucas-notice-nav-host').shadowRoot, ball = root.querySelector('#floatBall');
  root.querySelector('#collapse').click();
  pointer(w, ball, 'pointerdown', 960, 60);
  pointer(w, ball, 'pointermove', 99999, 99999);
  pointer(w, ball, 'pointerup', 99999, 99999);
  assert.equal(a.state.ballPosition.x, w.innerWidth - 56 - 8);
  assert.equal(a.state.ballPosition.y, w.innerHeight - 56 - 8);
  w.innerWidth = 180; w.innerHeight = 220;
  w.dispatchEvent(new w.Event('resize'));
  assert.equal(a.state.ballPosition.x, 116);
  assert.equal(a.state.ballPosition.y, 156);
  ball.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
  assert.equal(a.state.ballPosition.x, 104);
  assert.equal(a.loadConfig().cfg.ui.ballPosition.x, 104);
  pointer(w, ball, 'pointerdown', 100, 160);
  pointer(w, ball, 'pointermove', -9999, -9999);
  pointer(w, ball, 'pointerup', -9999, -9999);
  assert.equal(a.state.ballPosition.x, 8);
  assert.equal(a.state.ballPosition.y, 8);
});

test('cancelled and secondary pointers cannot leave the ball stuck or steal a drag', t => {
  const { a, w } = setup(t);
  a.bootstrap();
  const root = w.document.getElementById('ucas-notice-nav-host').shadowRoot, ball = root.querySelector('#floatBall');
  root.querySelector('#collapse').click();
  const original = { ...a.state.ballPosition };
  pointer(w, ball, 'pointerdown', 960, 60, { button: 2 });
  pointer(w, ball, 'pointermove', 500, 200);
  assert.equal(a.state.ballPosition.x, original.x);
  pointer(w, ball, 'pointerdown', 960, 60);
  pointer(w, ball, 'pointermove', 500, 200, { id: 2, primary: false });
  assert.equal(a.state.ballPosition.x, original.x);
  pointer(w, ball, 'pointermove', 500, 200);
  pointer(w, ball, 'pointercancel', 500, 200);
  assert.equal(a.state.ballPosition.x, original.x);
  assert.equal(ball.classList.contains('dragging'), false);
  ball.dispatchEvent(new w.MouseEvent('click', { bubbles: true, detail: 1 }));
  assert.equal(root.querySelector('#panel').hidden, true);
  ball.click(); // keyboard/assistive activation (detail=0)
  assert.equal(root.querySelector('#panel').hidden, false);
});

test('collapsed panel keeps scanning and floating ball reflects running state', async t => {
  const env = setup(t), { a, w, clock } = env;
  a.bootstrap();
  w.fetch = async () => response(notice());
  const root = w.document.getElementById('ucas-notice-nav-host').shadowRoot, ball = root.querySelector('#floatBall');
  const scan = a.runRangeScan(options(env, [21, 20]));
  await clock.tickAsync(0);
  root.querySelector('#collapse').click();
  assert.equal(a.scheduler.running, true);
  assert.equal(ball.dataset.state, 'running');
  await clock.tickAsync(3000); await scan;
  assert.equal(root.querySelector('#panel').hidden, true);
  assert.equal(ball.dataset.state, 'idle');
  assert.equal(a.state.results.get(20).status, 'ok');
});
