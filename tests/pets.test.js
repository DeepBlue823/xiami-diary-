import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const script = html.match(/<script>([\s\S]*?)<\/script>/)[1].split('        // 初始化')[0];

class EventTargetStub {
    events = new Map();
    addEventListener(type, listener) {
        if (!this.events.has(type)) this.events.set(type, []);
        this.events.get(type).push(listener);
    }
    dispatch(type, detail = {}) {
        for (const listener of this.events.get(type) || []) listener({ type, ...detail });
    }
}

class Element extends EventTargetStub {
    constructor(tag = 'div') {
        super();
        this.tagName = tag;
        this.children = [];
        this.dataset = {};
        this.style = { setProperty(name, value) { this[name] = value; } };
        this.attributes = {};
        this.className = '';
        this.ownText = '';
        this.offsetWidth = 280;
        this.offsetHeight = 90;
        this.classList = {
            contains: name => this.className.split(/\s+/).includes(name),
            add: (...names) => { this.className = [...new Set([...this.className.split(/\s+/), ...names])].join(' '); },
            remove: (...names) => { this.className = this.className.split(/\s+/).filter(name => !names.includes(name)).join(' '); },
            toggle: (name, force) => {
                const enabled = force ?? !this.classList.contains(name);
                this.classList[enabled ? 'add' : 'remove'](name);
                return enabled;
            }
        };
    }
    set textContent(value) { this.ownText = value; this.children = []; }
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); }
    set innerHTML(value) { this.html = value; this.children = []; }
    get innerHTML() { return this.html || ''; }
    appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
    append(...children) { children.forEach(child => this.appendChild(child)); }
    remove() {
        if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(child => child !== this);
        this.parentNode = null;
    }
    get isConnected() { return this.tagName === 'body' || Boolean(this.parentNode?.isConnected); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    getBoundingClientRect() { return { left: 280, top: 320, width: 80, height: 80, bottom: 400, right: 360 }; }
    querySelectorAll(selector) {
        const descendants = this.children.flatMap(child => [child, ...child.querySelectorAll('*')]);
        return descendants.filter(node => selector.split(',').some(part => {
            part = part.trim();
            if (part === '*') return true;
            if (part.includes('img')) return node.tagName === 'img';
            return [...part.matchAll(/\.([\w-]+)/g)].every(match => node.classList.contains(match[1]));
        }));
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function setup({ reducedMotion = false } = {}) {
    const body = new Element('body');
    const document = new EventTargetStub();
    const ids = new Map();
    Object.assign(document, {
        body, hidden: false, visibilityState: 'visible',
        createElement: tag => new Element(tag),
        createTextNode: text => { const node = new Element('#text'); node.textContent = text; return node; },
        querySelectorAll: selector => body.querySelectorAll(selector),
        querySelector: selector => body.querySelector(selector),
        getElementById: id => {
            if (!ids.has(id)) ids.set(id, new Element());
            return ids.get(id);
        }
    });
    const pets = {};
    for (const type of ['cat', 'dog']) {
        const pet = new Element();
        pet.className = `pet ${type}`;
        const img = new Element('img');
        img.dataset.idleSrc = `${type}-idle.png`;
        img.dataset.frameSrcs = `${type}-run.png|${type}-run2.png`;
        img.setAttribute('src', img.dataset.idleSrc);
        pet.appendChild(img);
        body.appendChild(pet);
        pets[type] = pet;
    }
    let now = 0;
    let serial = 0;
    const timers = new Map();
    const frames = new Map();
    const window = new EventTargetStub();
    Object.assign(window, {
        innerWidth: 1000, innerHeight: 800,
        matchMedia: () => ({ matches: reducedMotion }),
        setTimeout: (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id; },
        clearTimeout: id => timers.delete(id),
        setInterval: (callback, delay) => { const id = ++serial; timers.set(id, { callback, at: now + delay, interval: delay }); return id; },
        clearInterval: id => timers.delete(id),
        requestAnimationFrame: callback => { const id = ++serial; frames.set(id, callback); return id; },
        cancelAnimationFrame: id => frames.delete(id)
    });
    const requests = [];
    const context = vm.createContext({
        console, document, window, Date, AbortController,
        localStorage: { getItem: () => null },
        Image: class {},
        fetch: (url, options) => new Promise(resolve => requests.push({ url, ...options, resolve })),
        cat: pets.cat, dog: pets.dog
    });
    const run = code => vm.runInContext(code, context);
    run(script);
    run(`diaries = [{ id: '1', date: '2026-10-24', title: '秋天', content: '今天学习辛苦啦，晚饭一起吃好吃的。' }]; initPetInteractions()`);
    return {
        run, context, document, window, requests, pets, timers, frames,
        quotes: () => document.querySelectorAll('.pet-quote'),
        tick(milliseconds) {
            const end = now + milliseconds;
            while (true) {
                const next = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
                if (!next) break;
                const [id, timer] = next;
                now = timer.at;
                timers.delete(id);
                if (timer.interval) timers.set(id, { ...timer, at: now + timer.interval });
                timer.callback();
            }
            now = end;
        }
    };
}

async function resolveQuote(request, quote) {
    request.resolve({ ok: true, json: async () => ({ quote }) });
    // Flush the fetch, JSON and quote update promise chain without real timers.
    for (let i = 0; i < 8; i++) await Promise.resolve();
}

test('点击小狗立即显示完整本地话语，同时启动跑动与远端请求', () => {
    const page = setup();
    const expected = page.run(`buildPetQuote('dog', 0)`);
    page.pets.dog.dispatch('click');
    assert.equal(page.quotes().length, 1);
    assert.equal(page.quotes()[0].textContent, `小比格：${expected}`);
    assert.ok([...expected].length >= 30);
    assert.equal(page.requests.length, 1);
    assert.ok(page.pets.dog.pageRunner);
});

test('滚动关闭气泡并停止小狗，迟到的远端响应不会重新显示', async () => {
    const page = setup();
    page.pets.dog.dispatch('click');
    page.window.dispatch('scroll');
    assert.equal(page.quotes().length, 0);
    assert.equal(page.requests[0].signal.aborted, true);
    assert.ok(!page.pets.dog.pageRunner);
    assert.equal(page.pets.dog.classList.contains('is-page-running'), false);
    assert.equal(page.frames.size, 0);
    await resolveQuote(page.requests[0], '滚动之后才到达的话');
    assert.equal(page.quotes().length, 0);
});

test('快速切换猫狗始终只有一个气泡，旧请求不会覆盖当前话语', async () => {
    const page = setup();
    page.run(`showPetQuote(dog, { petType: 'dog' })`);
    page.run(`showPetQuote(cat, { petType: 'cat' })`);
    assert.equal(page.quotes().length, 1);
    assert.equal(page.requests[0].signal.aborted, true);
    const current = page.quotes()[0];
    const fallback = current.textContent;
    await resolveQuote(page.requests[0], '过期的小狗回复');
    assert.equal(current.textContent, fallback);
    await resolveQuote(page.requests[1], '当前的小猫回复');
    assert.equal(current.textContent, '喵小咪：当前的小猫回复');
    page.run(`showPetQuote(cat, { petType: 'cat' })`);
    assert.equal(page.quotes().length, 1);
});

test('气泡从点击起 12 秒自动清理，慢响应不会延长停留时间', async () => {
    const page = setup();
    page.run(`showPetQuote(cat, { petType: 'cat' })`);
    page.tick(7000);
    await resolveQuote(page.requests[0], '七秒后才到达的回复');
    page.tick(4999);
    assert.equal(page.quotes().length, 1);
    page.tick(1);
    assert.equal(page.quotes().length, 0);
    assert.equal(page.timers.size, 0);
});

test('窗口变化、离开页面和隐藏页面均清理气泡及请求', () => {
    for (const event of ['resize', 'pagehide', 'visibilitychange']) {
        const page = setup();
        page.run(`showPetQuote(cat, { petType: 'cat' })`);
        if (event === 'visibilitychange') {
            page.document.hidden = true;
            page.document.visibilityState = 'hidden';
            page.document.dispatch(event);
        } else page.window.dispatch(event);
        assert.equal(page.quotes().length, 0, event);
        assert.equal(page.requests[0].signal.aborted, true, event);
    }
});

test('减少动态效果设置下点击仍立即说话，但猫狗不播放动画', () => {
    const page = setup({ reducedMotion: true });
    for (const type of ['dog', 'cat']) {
        page.pets[type].dispatch('click');
        assert.equal(page.quotes().length, 1);
        assert.ok(!page.pets[type].pageRunner);
        assert.equal(page.pets[type].classList.contains('is-frame-active'), false);
    }
    assert.equal(page.frames.size, 0);
});

test('成功的远端语录仍可从缓存复用', async () => {
    const page = setup();
    const first = page.run(`requestModelPetQuote('cat', getDiaryContextPair(), 0)`);
    await resolveQuote(page.requests[0], '已经生成的语录');
    assert.equal(await first, '已经生成的语录');
    const second = await page.run(`requestModelPetQuote('cat', getDiaryContextPair(), 0)`);
    assert.equal(second, '已经生成的语录');
    assert.equal(page.requests.length, 1);
});

test('回到今天将日历恢复为当前年月', () => {
    const page = setup();
    page.run('currentYear = 2020; currentMonth = 1; todayMonth()');
    const now = new Date();
    assert.equal(page.run('currentYear'), now.getFullYear());
    assert.equal(page.run('currentMonth'), now.getMonth());
    assert.equal(page.document.getElementById('currentMonth').textContent, `${now.getFullYear()}年${now.getMonth() + 1}月`);
});
