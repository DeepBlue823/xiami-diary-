import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../edit.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].split('        // 初始化')[0];

class Element {
    constructor(tag = 'div') {
        this.tagName = tag;
        this.children = [];
        this.dataset = {};
        this.style = {};
        this.attributes = {};
        this.events = {};
        this.value = '';
        this.textContent = '';
        this.className = '';
        this.disabled = false;
        this.classList = {
            contains: name => this.className.split(' ').includes(name),
            add: name => { if (!this.classList.contains(name)) this.className += ` ${name}`; },
            remove: name => { this.className = this.className.split(' ').filter(item => item !== name).join(' '); },
            toggle: (name, force) => {
                const enabled = force ?? !this.classList.contains(name);
                this.classList[enabled ? 'add' : 'remove'](name);
                return enabled;
            }
        };
    }
    set innerHTML(value) { this.rawHTML = value; this.children = []; }
    appendChild(child) {
        if (child.tagName === 'fragment') child.children.forEach(item => this.appendChild(item));
        else { child.parent = this; this.children.push(child); }
        return child;
    }
    prepend(child) { child.parent = this; this.children.unshift(child); }
    replaceChildren(...children) { this.children = []; children.forEach(child => this.appendChild(child)); }
    addEventListener(name, callback) { this.events[name] = callback; }
    setAttribute(name, value) { this.attributes[name] = value; }
    focus() { this.focused = true; }
    remove() { this.parent.children = this.parent.children.filter(child => child !== this); }
    querySelector(selector) { return descendants(this).find(node => node.classList.contains(selector.slice(1))) || null; }
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }
function response(data, status = 200) { return { ok: status >= 200 && status < 300, status, json: async () => data }; }
function setup(fetchImplementation = async () => response([]), storedToken = 'token') {
    const ids = new Map();
    const fieldIds = ['diaryTitle', 'diaryContent', 'diaryDate', 'girlfriendLocation', 'myLocation', 'newMeetingStart', 'newMeetingEnd'];
    const get = id => {
        if (!ids.has(id)) ids.set(id, new Element(fieldIds.includes(id) ? 'input' : 'div'));
        return ids.get(id);
    };
    const container = new Element();
    const logout = new Element('button');
    const moods = ['happy', 'love', 'peaceful', 'sad', 'angry', 'tired'].map(mood => {
        const node = new Element('button'); node.dataset.mood = mood; return node;
    });
    const controls = [...fieldIds.map(get), get('saveDiaryButton'), logout, ...moods];
    const storage = new Map(storedToken ? [['xiami_token', storedToken]] : []);
    const events = {};
    const calls = [];
    const context = vm.createContext({
        document: {
            getElementById: get,
            querySelector: selector => selector === '.container' ? container : logout,
            querySelectorAll: selector => selector === '.mood-btn' ? moods : controls,
            createElement: tag => new Element(tag),
            createDocumentFragment: () => new Element('fragment')
        },
        window: { addEventListener: (name, callback) => { events[name] = callback; }, scrollTo() {} },
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) },
        fetch: async (...args) => { calls.push(args); return fetchImplementation(...args); },
        confirm: () => true,
        setTimeout: () => 1,
        clearTimeout() {},
        AbortController,
        console
    });
    vm.runInContext(script, context);
    return { context, get, controls, storage, calls, events, container, run: code => vm.runInContext(code, context) };
}

test('existing token is verified before hiding the login overlay', async () => {
    const app = setup(async () => response({ success: true }));
    assert.equal(await app.context.checkAuth(), true);
    assert.equal(app.calls[0][0], '/api/auth');
    assert.equal(app.calls[0][1].headers.Authorization, 'Bearer token');
    assert.equal(app.get('loginOverlay').style.display, 'none');
    assert.equal(app.container.inert, false);
});

test('login refreshes both diaries and meeting dates', async () => {
    const app = setup(async url => response(url === '/api/auth' ? { success: true, token: 'new-token' } : []), '');
    app.get('password').value = 'password';
    await app.context.login();
    assert.deepEqual(app.calls.map(call => call[0]), ['/api/auth', '/api/diaries', '/api/diaries?action=meetings']);
    assert.equal(app.storage.get('xiami_token'), 'new-token');
    assert.equal(app.get('password').value, '');
});

test('stored markup and crafted IDs render as text, never executable HTML', () => {
    const app = setup();
    const payload = '<img src=x onerror=alert(1)>';
    app.context.renderDiaryList([{ id: '1);alert(1)//', date: '2026-10-24', title: payload, content: payload, girlfriendLocation: payload, mood: '__proto__' }]);
    const nodes = descendants(app.get('diaryListContent'));
    assert.equal(nodes.filter(node => node.textContent.includes(payload)).length, 3);
    assert.ok(nodes.every(node => !node.rawHTML?.includes(payload)));
    assert.ok(nodes.every(node => !node.attributes.onclick));
    assert.equal(nodes.filter(node => node.classList.contains('mood')).length, 0);
    const edit = nodes.find(node => node.textContent === '编辑');
    assert.equal(typeof edit.events.click, 'function');
});

test('double save submits once and disables edits until the result arrives', async () => {
    let resolveWrite;
    const app = setup(async (_url, options) => options.method === 'POST' ? await new Promise(resolve => { resolveWrite = resolve; }) : response([]));
    app.get('diaryContent').value = '保留这一天';
    const first = app.context.saveDiary();
    await app.context.saveDiary();
    assert.equal(app.calls.length, 1);
    assert.ok(app.controls.every(control => control.disabled));
    resolveWrite(response({ success: true }));
    await first;
    assert.equal(app.calls.filter(call => call[1].method === 'POST').length, 1);
    assert.equal(app.get('diaryContent').value, '');
    assert.ok(app.controls.every(control => !control.disabled));
});

test('expired authentication reopens login without discarding the draft', async () => {
    const app = setup(async () => response({ error: 'expired' }, 401));
    app.get('diaryContent').value = '尚未保存的日记';
    await app.context.saveDiary();
    assert.equal(app.get('diaryContent').value, '尚未保存的日记');
    assert.equal(app.get('loginOverlay').style.display, 'flex');
    assert.equal(app.container.inert, true);
    assert.equal(app.storage.has('xiami_token'), false);
    assert.ok(app.controls.every(control => !control.disabled));
});

test('non-JSON server failures preserve input and release the save button', async () => {
    const app = setup(async () => ({ status: 502, ok: false, json: async () => { throw new SyntaxError(); } }));
    app.get('diaryTitle').value = '不能丢失';
    await app.context.saveDiary();
    assert.equal(app.get('diaryTitle').value, '不能丢失');
    assert.match(app.get('toast').textContent, /服务器暂时无法响应/);
    assert.equal(app.get('saveDiaryButton').disabled, false);
});

test('reversed meeting date range never reaches the API', async () => {
    const app = setup();
    app.get('newMeetingStart').value = '2026-10-25';
    app.get('newMeetingEnd').value = '2026-10-24';
    await app.context.addMeeting();
    assert.equal(app.calls.length, 0);
    assert.match(app.get('toast').textContent, /结束日期不能早于开始日期/);
});

test('editing an entry with an unknown mood clears the previous selection', async () => {
    const app = setup(async () => response([{ id: 1, title: '已有日记', mood: 'unknown' }]));
    await app.context.fetchDiaries();
    app.context.setMood('happy');
    app.context.editDiary(1);
    assert.equal(app.run('selectedMood'), null);
    assert.equal(app.run('editingId'), 1);
});

test('unsaved diary changes trigger the browser navigation guard', () => {
    const app = setup();
    let prevented = false;
    const event = { preventDefault() { prevented = true; } };
    app.events.beforeunload(event);
    assert.equal(prevented, false);
    app.get('diaryContent').value = '还没保存';
    app.events.beforeunload(event);
    assert.equal(prevented, true);
});
