import { strict as assert } from 'assert';
import fs from 'fs';
import vm from 'vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = html.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\/\/ 初始化[\s\S]*$/, '');

function element() {
    const children = new Map();
    return {
        innerHTML: '', textContent: '', dataset: {}, style: {}, value: '', disabled: false,
        addEventListener() {}, setAttribute() {},
        querySelector(selector) {
            if (!children.has(selector)) children.set(selector, element());
            return children.get(selector);
        },
        querySelectorAll() { return []; }
    };
}

function page(options = {}) {
    const elements = new Map();
    const context = vm.createContext({
        console, URL, AbortController: globalThis.AbortController,
        localStorage: options.localStorage || { getItem() { return null; }, setItem() {} },
        document: {
            getElementById(id) {
                if (!elements.has(id)) elements.set(id, element());
                return elements.get(id);
            },
            querySelectorAll() { return []; }
        },
        fetch: options.fetch || (() => { throw new Error('Unexpected fetch'); })
    });
    vm.runInContext(source, context);
    return { context, elements, run: code => vm.runInContext(code, context) };
}

const checks = [];
function test(name, check) { checks.push([name, check]); }

test('日记、评论、表情、地点和 ID 不会成为 HTML 或事件代码', () => {
    const { context, run } = page();
    context.attack = `<img src=x onerror=alert(1)>"'&`;
    run(`renderDiaryList([{ id: attack, date: '2026-10-24', title: attack, content: attack, girlfriendLocation: attack, mood: '__proto__' }])`);
    const diaryHtml = run(`document.getElementById('diaryListContent').innerHTML`);
    assert.ok(diaryHtml.includes('&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;'));
    assert.ok(!diaryHtml.includes('<img src=x'));
    assert.ok(!diaryHtml.includes('onclick="viewDiary'));
    context.commentContainer = element();
    run(`renderComments(attack, [{ id: attack, user: 'me', content: attack, emoji: attack, createdAt: '2026-10-24' }], commentContainer)`);
    assert.ok(!context.commentContainer.innerHTML.includes('<img src=x'));
    assert.ok(!context.commentContainer.innerHTML.includes('deleteComment('));
    assert.ok(context.commentContainer.innerHTML.includes('哥哥'));
});

test('被禁用的本地存储不会让公共页停止初始化', () => {
    const { run } = page({ localStorage: { getItem() { throw new Error('Storage denied'); }, setItem() { throw new Error('Storage denied'); } } });
    assert.equal(run('currentUser'), 'girlfriend');
    assert.doesNotThrow(() => run(`selectUser('me')`));
    assert.equal(run('getCommentToken()'), '');
});

test('日期在上海和夏令时时区均稳定，周年和百日正确', () => {
    const oldTimezone = process.env.TZ;
    try {
        for (const timezone of ['Asia/Shanghai', 'America/Los_Angeles']) {
            process.env.TZ = timezone;
            const { run } = page();
            assert.equal(run(`getDateKey('2026-10-24')`), '2026-10-24');
            assert.equal(run(`daysTogether(new Date(2025, 11, 7))`), 100);
            for (const [year, expected] of [[2025, '我们的故事开始啦'], [2026, '在一起 1 周年'], [2027, '在一起 2 周年']]) {
                run(`currentYear = ${year}; currentMonth = 7; renderCalendar()`);
                const calendar = run(`document.getElementById('calendarDays').innerHTML`);
                assert.ok(calendar.includes(expected), `${timezone}: ${year}-08-29 应显示 ${expected}`);
                assert.ok(!calendar.includes(`在一起 ${year - 2025 + 1} 周年`));
            }
            run('currentYear = 2026; currentMonth = 7; renderCalendar()');
            assert.ok(run(`document.getElementById('calendarDays').innerHTML`).includes('在一起 1 周年'));
            run(`diaries = [{ id: 1, date: '2026-08-29', content: '<img src=x onerror=alert(1)>', mood: '__proto__' }]; renderCalendar()`);
            const calendar = run(`document.getElementById('calendarDays').innerHTML`);
            assert.ok(!calendar.includes('<img src=x'));
            assert.ok(calendar.includes('role="button" tabindex="0"'));
        }
    } finally {
        if (oldTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = oldTimezone;
    }
});

test('见面接口失败时仍加载日记；错误响应提供重试', async () => {
    const { run } = page({ fetch: async url => {
        if (url.includes('meetings')) throw new Error('Offline');
        return { ok: true, json: async () => [{ id: 1, date: '2026-10-24', title: '仍可阅读', content: '正文' }] };
    } });
    await run('fetchDiaries()');
    assert.ok(run(`document.getElementById('diaryListContent').innerHTML`).includes('仍可阅读'));
    const failed = page({ fetch: async () => ({ ok: false, json: async () => ({ error: 'failure' }) }) });
    await failed.run('fetchDiaries()');
    assert.ok(failed.run(`document.getElementById('diaryListContent').innerHTML`).includes('重新加载'));
});

test('评论重复提交只发送一次，429 保留草稿并恢复按钮', async () => {
    let complete;
    const calls = [];
    const { run } = page({ fetch: (url, options) => {
        calls.push({ url, ...options });
        return new Promise(resolve => { complete = resolve; });
    } });
    run(`document.getElementById('input-1').value = '测试草稿'`);
    const first = run('submitComment(1)');
    await run(`submitComment('1')`);
    assert.equal(calls.length, 1);
    assert.equal(JSON.parse(calls[0].body).user, 'girlfriend');
    complete({ ok: false, status: 429, json: async () => ({ error: 'Too many requests' }) });
    await first;
    assert.equal(run(`document.getElementById('input-1').value`), '测试草稿');
    assert.equal(run(`document.getElementById('input-1').disabled`), false);
    assert.match(run(`document.getElementById('comments-1').querySelector('.comment-status').textContent`), /频繁/);
});

test('哥哥评论需要登录；已登录请求带 Bearer 并使用兼容身份', async () => {
    let calls = 0;
    const anonymous = page({ fetch: async () => { calls++; } });
    anonymous.run(`currentUser = 'me'; document.getElementById('input-1').value = '评论'`);
    await anonymous.run('submitComment(1)');
    assert.equal(calls, 0);
    assert.match(anonymous.run(`document.getElementById('comments-1').querySelector('.comment-status').textContent`), /登录/);
    let request;
    const authenticated = page({
        localStorage: { getItem(key) { return key === 'xiami_token' ? 'test-token' : 'me'; } },
        fetch: async (url, options) => {
            request = options;
            return { ok: false, status: 401, json: async () => ({ error: '登录已失效' }) };
        }
    });
    authenticated.run(`document.getElementById('input-1').value = '评论'`);
    await authenticated.run('submitComment(1)');
    assert.equal(request.headers.Authorization, 'Bearer test-token');
    assert.equal(JSON.parse(request.body).user, 'boyfriend');
    assert.equal(authenticated.run(`document.getElementById('input-1').value`), '评论');
});

test('输入法确认不会发送评论', () => {
    const { context, run } = page();
    let calls = 0;
    context.submitComment = () => { calls++; };
    context.composingEvent = { key: 'Enter', isComposing: true, preventDefault() {} };
    run('handleCommentKeypress(composingEvent, 1)');
    assert.equal(calls, 0);
    context.composingEvent.isComposing = false;
    run('handleCommentKeypress(composingEvent, 1)');
    assert.equal(calls, 1);
});

for (const [name, check] of checks) {
    await check();
    console.log(`✓ ${name}`);
}
console.log(`公共页 ${checks.length} 项回归检查通过。`);
