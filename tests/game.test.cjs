// Run with: node tests/game.test.cjs
// These tests execute the real script with DOM, canvas and audio test doubles.
// They do not replace a visual/browser or audible playback check.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(process.env.SNAKE_TEST_SOURCE || path.join(root, 'game.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const plain = value => JSON.parse(JSON.stringify(value));

function boot({ saved = {}, storageBlocked = false, audio = 'available', width = 638, dpr = 1 } = {}) {
  let now = 0;
  let nextId = 0;
  const frames = new Map();
  const timers = new Map();
  const storage = new Map(Object.entries(saved));
  const drawing = [];
  const sounds = [];
  const contexts = [];

  function canvasContext() {
    let transform = [1, 0, 0, 1, 0, 0];
    const stack = [];
    const finite = args => args.forEach(n => assert.ok(Number.isFinite(n), `Invalid canvas number: ${n}`));
    const gradient = () => ({ addColorStop(offset) { assert.ok(offset >= 0 && offset <= 1); } });
    return {
      setTransform(...args) { finite(args); transform = args; },
      save() { stack.push([...transform]); },
      restore() { assert.ok(stack.length, 'Unbalanced canvas restore'); transform = stack.pop(); },
      translate(x, y) { finite([x, y]); transform[4] += x; transform[5] += y; },
      rotate(angle) { finite([angle]); },
      scale(x, y) { finite([x, y]); },
      moveTo(x, y) { finite([x, y]); },
      lineTo(x, y) { finite([x, y]); drawing.push([x + transform[4], y + transform[5]]); },
      arc(x, y, radius, start, end) { finite([x, y, radius, start, end]); assert.ok(radius >= 0); },
      ellipse(x, y, rx, ry, rotation, start, end) { finite([x, y, rx, ry, rotation, start, end]); assert.ok(rx >= 0 && ry >= 0); },
      createRadialGradient(...args) { finite(args); assert.ok(args[2] >= 0 && args[5] >= 0); return gradient(); },
      fillRect(...args) { finite(args); },
      clearRect(...args) { finite(args); },
      fillText(text, x, y) { finite([x, y]); },
      drawImage(image, ...args) { finite(args); assert.ok(image.width > 0 && image.height > 0); },
      beginPath() {}, closePath() {}, stroke() {}, fill() {},
      get stackDepth() { return stack.length; },
    };
  }

  class Element {
    constructor(id = '') {
      this.id = id;
      this.dataset = {};
      this.listeners = {};
      this.attrs = {};
      this.textContent = '';
      this.offsetWidth = width;
      this.classes = new Set();
      this.classList = {
        add: (...names) => names.forEach(n => this.classes.add(n)),
        remove: (...names) => names.forEach(n => this.classes.delete(n)),
        toggle: (name, force = !this.classes.has(name)) => force ? this.classes.add(name) : this.classes.delete(name),
        contains: name => this.classes.has(name),
      };
    }
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
    fire(type, event = {}) { for (const fn of this.listeners[type] || []) fn({ target: this, currentTarget: this, ...event }); }
    setAttribute(name, value) { this.attrs[name] = value; }
    focus() { document.activeElement = this; }
    blur() { if (document.activeElement === this) document.activeElement = null; }
    querySelector() { return elements[{ menuOverlay: 'playBtn', pauseOverlay: 'resumeBtn', overOverlay: 'againBtn' }[this.id]] || null; }
    getBoundingClientRect() { return { width, height: width }; }
    getContext(type) { assert.equal(type, '2d'); return this.context ||= canvasContext(); }
  }
  class Button extends Element {}
  class Input extends Element { constructor(value) { super(); this.type = 'radio'; this.value = value; } }
  const elements = {};
  for (const match of html.matchAll(/<([a-z][a-z0-9]*)\b[^>]*\bid="([^"]+)"[^>]*>/g)) {
    elements[match[2]] = match[1] === 'button' ? new Button(match[2]) : new Element(match[2]);
  }
  const radios = [...html.matchAll(/<input[^>]*name="difficulty"[^>]*value="([^"]+)"/g)].map(m => new Input(m[1]));
  const document = new Element();
  document.body = new Element();
  document.getElementById = id => { assert.ok(elements[id], `Missing HTML element ${id}`); return elements[id]; };
  document.querySelectorAll = () => radios;
  document.createElement = () => new Element();

  class Param {
    constructor(positive = false) { this.positive = positive; this.value = 0; }
    check(value, time) { assert.ok(Number.isFinite(value) && Number.isFinite(time) && time >= 0); }
    setValueAtTime(value, time) { this.check(value, time); sounds.push(['set', value, time]); }
    exponentialRampToValueAtTime(value, time) { this.check(value, time); assert.ok(value > 0); sounds.push(['ramp', value, time]); }
    setTargetAtTime(value, time, constant) { this.check(value, time); assert.ok(constant > 0); sounds.push(['target', value]); }
  }
  class AudioNode {
    constructor(kind) { this.kind = kind; this.gain = new Param(); this.frequency = new Param(true); this.Q = new Param(); this.threshold = {}; this.ratio = {}; }
    connect(node) { assert.ok(node); sounds.push(['connect', this.kind]); }
    start(time) { assert.ok(Number.isFinite(time) && time >= 0); this.started = time; sounds.push(['start', this.kind]); }
    stop(time) { assert.ok(time > this.started); sounds.push(['stop', this.kind]); }
  }
  class AudioContext {
    constructor() {
      if (audio === 'throws') throw new Error('Audio device unavailable');
      this.state = 'suspended'; this.currentTime = 1; this.sampleRate = 48000; this.destination = new AudioNode('destination'); contexts.push(this);
    }
    createDynamicsCompressor() { return new AudioNode('compressor'); }
    createGain() { return new AudioNode('gain'); }
    createOscillator() { return new AudioNode('oscillator'); }
    createBufferSource() { return new AudioNode('noise'); }
    createBiquadFilter() { return new AudioNode('filter'); }
    createBuffer(channels, length, rate) { assert.equal(channels, 1); assert.equal(rate, this.sampleRate); return { getChannelData: () => new Float32Array(length) }; }
    resume() { this.state = 'running'; return Promise.resolve(); }
  }

  const window = new Element();
  window.devicePixelRatio = dpr;
  if (audio !== 'missing') window.AudioContext = AudioContext;
  const sandbox = {
    document, window, HTMLElement: Element, HTMLButtonElement: Button, HTMLInputElement: Input,
    performance: { now: () => now },
    localStorage: {
      getItem(key) { if (storageBlocked) throw new Error('Storage denied'); return storage.get(key) ?? null; },
      setItem(key, value) { if (storageBlocked) throw new Error('Quota exceeded'); storage.set(key, value); },
    },
    requestAnimationFrame(fn) { const id = ++nextId; frames.set(id, fn); return id; },
    setTimeout(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    ResizeObserver: class { constructor(fn) { this.fn = fn; } observe() { this.fn(); } },
  };
  // Expose internals only in the test VM; production code keeps its private scope.
  const instrumented = source.replace(/\}\)\(\);\s*$/, `globalThis.app = {
    SnakeGame, DIFFICULTIES, Sound, el, fx, snakePath, drawSnake, render, resize,
    startGame, pauseGame, resumeGame, goToMenu, setDifficulty, best,
    get game() { return game; }, get state() { return state; }
  }; })();`);
  vm.runInNewContext(instrumented, sandbox, { filename: 'game.js' });
  const app = sandbox.app;
  assert.ok(app, 'Test instrumentation must expose app');
  return {
    ...app, app, elements, document, window, storage, drawing, sounds, contexts,
    tick(dt = 16) {
      now += dt;
      const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn(now));
      for (const [id, timer] of timers) if (timer.at <= now) { timers.delete(id); timer.fn(); }
    },
    key(key, code = key, options = {}) {
      let prevented = false;
      const target = document.activeElement || document;
      document.fire('keydown', { target, key, code, preventDefault() { prevented = true; }, ...options });
      // A full key press activates a focused button through the browser default.
      if (!prevented && target instanceof Button && (key === 'Enter' || key === ' ')) target.fire('click', { detail: 0 });
      return prevented;
    },
  };
}

test('boots the actual HTML references and renders the menu/demo for 2,000 frames', () => {
  const h = boot();
  assert.equal(h.app.state, 'menu');
  assert.equal(h.elements.diffTag.textContent, 'Normal');
  assert.equal(h.elements.pauseBtn.disabled, true);
  for (let i = 0; i < 2000; i++) h.tick(16);
  assert.ok(h.drawing.length > 10000);
  assert.equal(h.elements.canvas.context.stackDepth, 0);
});

test('moves on ticks, grows, scores and accelerates correctly on every difficulty', () => {
  const { SnakeGame, DIFFICULTIES } = boot();
  for (const cfg of Object.values(DIFFICULTIES)) {
    const g = new SnakeGame(cfg);
    g.food = { x: 9, y: 10, born: 0 };
    g.update(cfg.interval - 1);
    assert.equal(g.snake[0].x, 8);
    g.update(1);
    assert.equal(g.snake[0].x, 9);
    assert.equal(g.snake.length, 4);
    assert.equal(g.eaten, 1);
    assert.equal(g.score, cfg.points);
    assert.equal(g.interval, cfg.interval - cfg.accel);
    g.eaten = 10000;
    assert.equal(g.interval, cfg.min);
  }
});

test('buffers quick turns, rejects reversals/repeats, and caps the queue', () => {
  const h = boot(); const g = new h.SnakeGame(h.DIFFICULTIES.normal);
  assert.equal(g.turn('left'), false);
  assert.equal(g.turn('right'), false);
  assert.equal(g.turn('up'), true);
  assert.equal(g.turn('down'), false);
  assert.equal(g.turn('left'), true);
  assert.equal(g.turn('down'), true);
  assert.equal(g.turn('right'), false);
  for (const dir of ['up', 'left', 'down']) { g.step(); assert.equal(g.dir, dir); }
  assert.equal(g.alive, true);
});

test('walls kill on three difficulties and all four edges wrap on easy', () => {
  const h = boot();
  for (const mode of ['normal', 'hard', 'insane']) {
    for (const [dir, x, y] of [['left', 0, 5], ['right', 19, 5], ['up', 5, 0], ['down', 5, 19]]) {
      const g = new h.SnakeGame(h.DIFFICULTIES[mode]); g.snake = [{ x, y }]; g.dir = dir; g.step();
      assert.equal(g.deathCause, 'wall'); assert.equal(g.alive, false);
    }
  }
  for (const [dir, x, y, nx, ny] of [['left', 0, 5, 19, 5], ['right', 19, 5, 0, 5], ['up', 5, 0, 5, 19], ['down', 5, 19, 5, 0]]) {
    const g = new h.SnakeGame(h.DIFFICULTIES.easy); g.snake = [{ x, y }]; g.dir = dir; g.food = null; g.step();
    assert.equal(g.alive, true); assert.deepEqual(plain(g.snake[0]), { x: nx, y: ny });
  }
});

test('self collision kills, but moving into a vacating tail is legal', () => {
  const h = boot();
  const g = new h.SnakeGame(h.DIFFICULTIES.normal);
  g.snake = [{ x: 2, y: 2 }, { x: 2, y: 3 }, { x: 1, y: 3 }, { x: 1, y: 2 }];
  g.dir = 'left'; g.food = null; g.step();
  assert.equal(g.alive, true);
  g.snake = [{ x: 2, y: 2 }, { x: 2, y: 3 }, { x: 1, y: 3 }, { x: 1, y: 2 }, { x: 0, y: 2 }];
  g.step(); assert.equal(g.alive, false); assert.equal(g.deathCause, 'self');
});

test('food and bonuses spawn only in free cells; bonus scoring and expiry work', () => {
  const h = boot(); let expired = 0;
  const g = new h.SnakeGame(h.DIFFICULTIES.normal, { bonusExpire: () => expired++ });
  for (let i = 0; i < 5; i++) { g.food = g.neighbor(g.snake[0], g.dir); g.step(); }
  assert.equal(g.eaten, 5); assert.equal(g.score, 50); assert.ok(g.bonus);
  for (let i = 0; i < 100; i++) {
    const p = g.randomEmptyCell();
    assert.ok(!g.snake.some(s => s.x === p.x && s.y === p.y));
    assert.notDeepEqual(plain(p), plain(g.food)); assert.notDeepEqual(plain(p), plain(g.bonus));
  }
  g.bonus = { ...g.neighbor(g.snake[0], g.dir), expires: g.time + 6000, life: 6000 };
  g.food = { x: 0, y: 0 };
  const length = g.snake.length; g.step();
  assert.equal(g.score, 100); assert.equal(g.snake.length, length); assert.equal(g.bonus, null);
  g.spawnBonus(); g.bonus.expires = g.time + 1; g.update(1);
  assert.equal(expired, 1); assert.equal(g.bonus, null);
});

test('a bonus in the last free cell does not trigger a premature win', () => {
  const h = boot(); const g = new h.SnakeGame(h.DIFFICULTIES.easy);
  const cells = Array.from({ length: 400 }, (_, i) => ({ x: i % 20, y: Math.floor(i / 20) }));
  g.snake = cells.slice(2); g.dir = 'left'; g.food = { x: 1, y: 0 };
  g.bonus = { x: 0, y: 0, expires: 6000, life: 6000 };
  g.step();
  assert.equal(g.snake.length, 399); assert.equal(g.won, false); assert.equal(g.alive, true);
  assert.ok(g.food); assert.equal(g.food.x, 0); assert.equal(g.food.y, 0);
  assert.equal(g.bonus, null);
  g.step(); assert.equal(g.snake.length, 400); assert.equal(g.won, true); assert.equal(g.alive, false);
});

test('long snakes remain continuous and visible after winding around the board repeatedly', () => {
  const h = boot(); const g = new h.SnakeGame(h.DIFFICULTIES.easy);
  g.snake = [{ x: 0, y: 0 }];
  let x = 0;
  for (let y = 0; y < 4; y++) {
    if (y) g.snake.push({ x, y });
    for (let i = 0; i < 19; i++) { x = (x + 19) % 20; g.snake.push({ x, y }); }
  }
  g.prevHead = { ...g.snake[0] }; g.acc = g.interval;
  const points = h.snakePath(g);
  for (let i = 1; i < points.length; i++) {
    assert.ok(Math.abs(points[i].x - points[i - 1].x) + Math.abs(points[i].y - points[i - 1].y) <= 1.001, `Discontinuous segment ${i}`);
  }
  h.drawSnake(g, 1000);
  const cell = 638 / 20;
  for (const p of g.snake.slice(1)) {
    assert.ok(h.drawing.some(([x, y]) => Math.abs(x - (p.x + 0.5) * cell) < 0.001 && Math.abs(y - (p.y + 0.5) * cell) < 0.001), `Invisible body cell ${JSON.stringify(p)}`);
  }
});

test('keyboard, buttons, pause, restart, game-over and menu transitions work', () => {
  const h = boot(); h.tick();
  h.key('4', 'Digit4'); assert.equal(h.elements.diffTag.textContent, 'Insane');
  h.key('1', 'Digit1'); h.elements.playBtn.fire('click', { detail: 1 });
  assert.equal(h.app.state, 'playing'); assert.equal(h.elements.pauseBtn.disabled, false);
  for (const [key, code, dir] of [['w', 'KeyW', 'up'], ['a', 'KeyA', 'left'], ['ArrowDown', 'ArrowDown', 'down']]) {
    assert.equal(h.key(key, code), true); assert.equal(h.app.game.queue.at(-1), dir);
  }
  h.key(' ', 'Space'); assert.equal(h.app.state, 'paused');
  const time = h.app.game.time; h.tick(100); assert.equal(h.app.game.time, time);
  h.key(' ', 'Space'); assert.equal(h.app.state, 'playing');
  h.window.fire('blur'); assert.equal(h.app.state, 'paused');
  h.elements.resumeBtn.fire('click', { detail: 1 }); assert.equal(h.app.state, 'playing');
  h.document.hidden = true; h.document.fire('visibilitychange'); assert.equal(h.app.state, 'paused');
  h.key('r', 'KeyR'); assert.equal(h.app.state, 'playing'); assert.equal(h.app.game.score, 0);
  h.app.game.die('wall'); assert.equal(h.app.state, 'over');
  assert.equal(h.elements.overOverlay.classList.contains('show'), false);
  h.tick(850); assert.equal(h.elements.overOverlay.classList.contains('show'), true); assert.equal(h.elements.overOverlay.inert, false);
  h.key('Escape', 'Escape'); assert.equal(h.app.state, 'menu');
});

test('swipe controls steer after the threshold and stop after touchend/cancel', () => {
  const h = boot(); h.startGame();
  const touch = (type, x, y) => h.elements.board.fire(type, { touches: [{ clientX: x, clientY: y }], preventDefault() {} });
  touch('touchstart', 100, 100); touch('touchmove', 100, 90); assert.equal(h.app.game.queue.length, 0);
  touch('touchmove', 100, 70); assert.equal(h.app.game.queue[0], 'up');
  touch('touchmove', 60, 70); assert.equal(h.app.game.queue[1], 'left');
  h.elements.board.fire('touchcancel'); touch('touchmove', 60, 110); assert.equal(h.app.game.queue.length, 2);
  touch('touchstart', 100, 100); h.elements.board.fire('touchend'); touch('touchmove', 60, 100); assert.equal(h.app.game.queue.length, 2);
});

test('score, per-difficulty bests, difficulty and mute survive reload', () => {
  const h = boot(); h.setDifficulty('hard'); h.startGame();
  h.app.game.food = { x: 9, y: 10 }; h.app.game.step();
  assert.equal(h.elements.score.textContent, 15); assert.equal(h.elements.best.textContent, 15);
  h.key('m', 'KeyM'); assert.equal(h.document.body.dataset.muted, 'true');
  const reloaded = boot({ saved: Object.fromEntries(h.storage) });
  assert.equal(reloaded.elements.diffTag.textContent, 'Hard'); assert.equal(reloaded.best(), 15);
  assert.equal(reloaded.document.body.dataset.muted, 'true');
  reloaded.setDifficulty('easy'); assert.equal(reloaded.best(), 0);
});

test('malformed JSON and denied storage do not break gameplay', () => {
  for (const options of [{ storageBlocked: true }, { saved: { 'snake.highscores.v1': '{', 'snake.difficulty': 'bad JSON', 'snake.muted': '???' } }]) {
    const h = boot(options); h.startGame(); h.app.game.food = { x: 9, y: 10 }; h.app.game.step(); h.key('m', 'KeyM'); h.tick();
    assert.equal(h.app.state, 'playing'); assert.equal(h.elements.score.textContent, 10);
  }
});

test('invalid saved difficulty values fall back to normal', () => {
  for (const value of ['toString', '__proto__', 'constructor', [], {}, { toString: null }, 3, null]) {
    const h = boot({ saved: { 'snake.difficulty': JSON.stringify(value) } });
    assert.equal(h.elements.diffTag.textContent, 'Normal', JSON.stringify(value));
    h.startGame(); h.app.game.update(110); assert.equal(h.app.game.snake[0].x, 9);
  }
});

test('invalid high-score values are discarded without losing other valid scores', () => {
  for (const value of [[], 'bad', 4, null, { normal: -1 }, { normal: '90' }, { normal: {} }, { normal: 1e100 }, { normal: 1.5 }]) {
    const h = boot({ saved: { 'snake.highscores.v1': JSON.stringify(value) } });
    assert.equal(h.best(), 0, JSON.stringify(value));
    h.startGame(); h.app.game.food = { x: 9, y: 10 }; h.app.game.step();
    const reload = boot({ saved: Object.fromEntries(h.storage) }); assert.equal(reload.best(), 10);
  }
  const h = boot({ saved: { 'snake.highscores.v1': JSON.stringify({ easy: 15, normal: -1, hard: 90 }) } });
  h.setDifficulty('easy'); assert.equal(h.best(), 15); h.setDifficulty('hard'); assert.equal(h.best(), 90);
});

test('all audio effects create valid schedules, resume audio, and respect mute', () => {
  const h = boot(); h.Sound.unlock(); assert.equal(h.contexts.length, 1); assert.equal(h.contexts[0].state, 'running');
  for (const effect of ['start', 'turn', 'bonus', 'bonusSpawn', 'bonusExpire', 'die', 'pause', 'resume', 'select', 'highScore', 'win']) {
    const before = h.sounds.length; h.Sound[effect](); assert.ok(h.sounds.length > before, effect);
  }
  for (let i = 1; i <= 25; i++) h.Sound.eat(i);
  const starts = () => h.sounds.filter(s => s[0] === 'start').length;
  assert.ok(starts() > 80); assert.equal(starts(), h.sounds.filter(s => s[0] === 'stop').length);
  assert.ok(h.sounds.some(s => s[0] === 'start' && s[1] === 'noise'));
  const before = starts(); h.Sound.setMuted(true); h.Sound.start(); assert.equal(starts(), before);
  h.Sound.setMuted(false); h.Sound.start(); assert.ok(starts() > before);
});

test('unavailable AudioContext or device does not prevent play, scoring or mute', () => {
  for (const audio of ['missing', 'throws']) {
    const h = boot({ audio }); h.startGame(); h.app.game.food = { x: 9, y: 10 }; h.app.game.step(); h.key('m', 'KeyM'); h.tick();
    assert.equal(h.app.state, 'playing'); assert.equal(h.app.game.score, 10);
  }
});

test('canvas scales for device pixel ratios and draws food, bonuses, effects and end states', () => {
  for (const dpr of [1, 1.25, 2, 3]) {
    const h = boot({ dpr, width: 301.5 });
    assert.equal(h.elements.canvas.width, Math.round(301.5 * Math.min(dpr, 2)));
    h.startGame(); h.app.game.food = { x: 9, y: 10, born: 0 }; h.app.game.step(); h.tick(100);
    h.app.game.spawnBonus(); h.tick(100); h.app.game.die('self'); h.tick(16); h.tick(850);
    h.startGame(); h.app.game.win(); h.tick(16); h.tick(1400);
    assert.equal(h.elements.overTitle.textContent, 'You Win!'); assert.equal(h.elements.canvas.context.stackDepth, 0);
  }
});
