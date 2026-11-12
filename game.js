'use strict';

(() => {
  // ═══════════════════════════════ Config ═══════════════════════════════

  const GRID = 20;
  const TAU = Math.PI * 2;

  const DIFFICULTIES = {
    easy:   { label: 'Easy',   desc: 'Relaxed pace · walls wrap around',      interval: 150, min: 115, accel: 0.5,  wrap: true,  points: 5 },
    normal: { label: 'Normal', desc: 'Classic pace · walls are deadly',       interval: 110, min: 75,  accel: 1,    wrap: false, points: 10 },
    hard:   { label: 'Hard',   desc: 'Fast, and speeds up quickly as you grow', interval: 82, min: 48, accel: 1.5,  wrap: false, points: 15 },
    insane: { label: 'Insane', desc: 'Blistering speed from the very first move', interval: 56, min: 38, accel: 0.75, wrap: false, points: 25 },
  };
  const DIFF_ORDER = Object.keys(DIFFICULTIES);

  const DIRS = { up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 } };
  const OPPOSITE = { up: 'down', down: 'up', left: 'right', right: 'left' };
  const KEY_DIRS = {
    ArrowUp: 'up', KeyW: 'up',
    ArrowDown: 'down', KeyS: 'down',
    ArrowLeft: 'left', KeyA: 'left',
    ArrowRight: 'right', KeyD: 'right',
  };

  const BONUS_EVERY = 5;      // a golden star appears after every Nth food
  const BONUS_LIFE = 6000;    // ms of game time the star stays on the board
  const BONUS_MULT = 5;       // star is worth up to N× a normal food
  const MAX_QUEUED_TURNS = 3; // buffered inputs so quick double-turns register

  const STORAGE = {
    highs: 'snake.highscores.v1',
    difficulty: 'snake.difficulty',
    muted: 'snake.muted',
    colorblind: 'snake.colorblind',
  };

  // ═══════════════════════════════ Storage ══════════════════════════════

  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
      } catch {
        return fallback;
      }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
    },
  };

  // ═══════════════════════════════ Audio ════════════════════════════════

  const Sound = (() => {
    const VOLUME = 0.55;
    let ctx = null;
    let master = null;
    let noiseBuffer = null;
    let muted = store.get(STORAGE.muted, false) === true;

    function init() {
      if (ctx) return ctx;
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      try { ctx = new AC(); } catch { return null; }

      const comp = ctx.createDynamicsCompressor();
      comp.threshold.value = -16;
      comp.ratio.value = 4;
      master = ctx.createGain();
      master.gain.value = muted ? 0 : VOLUME;
      master.connect(comp);
      comp.connect(ctx.destination);

      noiseBuffer = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
      const data = noiseBuffer.getChannelData(0);
      for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
      return ctx;
    }

    // Must be called from a user gesture so browsers allow audio playback.
    function unlock() {
      const c = init();
      if (c && c.state === 'suspended') c.resume().catch(() => {});
    }

    function live() {
      if (muted) return null;
      const c = init();
      if (!c) return null;
      if (c.state === 'suspended') c.resume().catch(() => {});
      return c;
    }

    function envelope(c, gainNode, t0, vol, attack, dur) {
      gainNode.gain.setValueAtTime(0.0001, t0);
      gainNode.gain.exponentialRampToValueAtTime(vol, t0 + attack);
      gainNode.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    }

    function tone({ freq, to, type = 'sine', dur = 0.12, vol = 0.3, delay = 0, attack = 0.005 }) {
      const c = live();
      if (!c) return;
      const t0 = c.currentTime + delay;
      const osc = c.createOscillator();
      const g = c.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, t0);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, t0 + dur);
      envelope(c, g, t0, vol, attack, dur);
      osc.connect(g);
      g.connect(master);
      osc.start(t0);
      osc.stop(t0 + dur + 0.05);
    }

    function noise({ dur = 0.3, vol = 0.25, delay = 0, freq = 2000, to = 200, q = 0.8 }) {
      const c = live();
      if (!c) return;
      const t0 = c.currentTime + delay;
      const src = c.createBufferSource();
      src.buffer = noiseBuffer;
      const filter = c.createBiquadFilter();
      filter.type = 'lowpass';
      filter.Q.value = q;
      filter.frequency.setValueAtTime(freq, t0);
      filter.frequency.exponentialRampToValueAtTime(to, t0 + dur);
      const g = c.createGain();
      envelope(c, g, t0, vol, 0.004, dur);
      src.connect(filter);
      filter.connect(g);
      g.connect(master);
      src.start(t0);
      src.stop(t0 + dur + 0.05);
    }

    const note = (base, semitones) => base * Math.pow(2, semitones / 12);
    const PENTATONIC = [0, 2, 4, 7, 9, 12, 14, 16, 19, 21, 24];
    const C5 = 523.25;

    function arpeggio(steps, { base = C5, type = 'triangle', gap = 0.07, dur = 0.14, vol = 0.2, delay = 0 } = {}) {
      steps.forEach((s, i) => tone({ freq: note(base, s), type, dur, vol, delay: delay + i * gap }));
    }

    return {
      unlock,
      get muted() { return muted; },
      setMuted(value) {
        muted = value;
        store.set(STORAGE.muted, value);
        if (master) master.gain.setTargetAtTime(value ? 0 : VOLUME, ctx.currentTime, 0.02);
      },

      // Eating climbs a pentatonic scale, so streaks sound like a melody.
      eat(count) {
        const f = note(C5, PENTATONIC[(count - 1) % PENTATONIC.length]);
        tone({ freq: f, to: f * 1.5, type: 'triangle', dur: 0.09, vol: 0.32 });
        tone({ freq: f * 2, type: 'sine', dur: 0.12, vol: 0.1, delay: 0.045 });
      },
      bonus() {
        arpeggio([0, 4, 7, 12, 16], { base: 659.25, type: 'square', gap: 0.045, dur: 0.1, vol: 0.08 });
        tone({ freq: 2093, to: 3136, type: 'sine', dur: 0.3, vol: 0.07, delay: 0.22 });
      },
      bonusSpawn() {
        tone({ freq: 1568, to: 2349, type: 'sine', dur: 0.12, vol: 0.09 });
        tone({ freq: 2349, to: 3136, type: 'sine', dur: 0.14, vol: 0.07, delay: 0.08 });
      },
      bonusExpire() {
        tone({ freq: 784, to: 330, type: 'triangle', dur: 0.25, vol: 0.12 });
      },
      turn() {
        tone({ freq: 190, to: 130, type: 'sine', dur: 0.035, vol: 0.06, attack: 0.002 });
      },
      die() {
        tone({ freq: 440, to: 55, type: 'sawtooth', dur: 0.65, vol: 0.2 });
        tone({ freq: 220, to: 40, type: 'square', dur: 0.5, vol: 0.08, delay: 0.05 });
        noise({ dur: 0.45, vol: 0.28, freq: 2600, to: 120 });
      },
      start() {
        arpeggio([0, 4, 7, 12], { vol: 0.2 });
      },
      pause() {
        tone({ freq: 659.25, type: 'sine', dur: 0.1, vol: 0.16 });
        tone({ freq: 440, type: 'sine', dur: 0.16, vol: 0.16, delay: 0.08 });
      },
      resume() {
        tone({ freq: 440, type: 'sine', dur: 0.1, vol: 0.16 });
        tone({ freq: 659.25, type: 'sine', dur: 0.16, vol: 0.16, delay: 0.08 });
      },
      select() {
        tone({ freq: 880, to: 1046.5, type: 'triangle', dur: 0.05, vol: 0.12 });
      },
      highScore() {
        arpeggio([0, 4, 7, 12, 16, 19, 24], { base: C5, type: 'square', gap: 0.06, dur: 0.12, vol: 0.07 });
        [0, 4, 7].forEach((s) => tone({ freq: note(C5 * 2, s), type: 'triangle', dur: 0.6, vol: 0.08, delay: 0.42 }));
      },
      win() {
        arpeggio([0, 4, 7, 12, 7, 12, 16, 19, 24], { base: C5, type: 'square', gap: 0.08, dur: 0.16, vol: 0.08 });
        [0, 4, 7, 12].forEach((s) => tone({ freq: note(C5, s), type: 'triangle', dur: 1.2, vol: 0.1, delay: 0.75 }));
      },
    };
  })();

  // ═══════════════════════════════ Game model ═══════════════════════════

  class SnakeGame {
    constructor(cfg, hooks = {}) {
      this.cfg = cfg;
      this.hooks = hooks;
      this.reset();
    }

    emit(name, ...args) {
      const fn = this.hooks[name];
      if (fn) fn(...args);
    }

    reset() {
      const y = Math.floor(GRID / 2);
      const x = Math.floor(GRID / 2) - 2;
      this.snake = [{ x, y }, { x: x - 1, y }, { x: x - 2, y }];
      this.prevHead = { x, y }; // where the head was before the last step (for interpolation)
      this.prevTail = null;     // where the tail was before the last step (null if it grew)
      this.dir = 'right';
      this.queue = [];
      this.score = 0;
      this.eaten = 0;
      this.time = 0;
      this.acc = 0;
      this.alive = true;
      this.won = false;
      this.deathCause = null;
      this.diedAt = 0;
      this.bonus = null;
      this.food = null;
      this.food = this.randomEmptyCell();
    }

    get interval() {
      return Math.max(this.cfg.min, this.cfg.interval - this.eaten * this.cfg.accel);
    }

    /** 0..1 progress between the previous and the next tick, used for smooth rendering. */
    get progress() {
      return this.alive ? Math.min(1, this.acc / this.interval) : 1;
    }

    randomEmptyCell() {
      const taken = new Set(this.snake.map((p) => p.y * GRID + p.x));
      if (this.food) taken.add(this.food.y * GRID + this.food.x);
      if (this.bonus) taken.add(this.bonus.y * GRID + this.bonus.x);
      const free = [];
      for (let i = 0; i < GRID * GRID; i++) if (!taken.has(i)) free.push(i);
      if (!free.length) return null;
      const i = free[(Math.random() * free.length) | 0];
      return { x: i % GRID, y: (i / GRID) | 0, born: performance.now() };
    }

    /** Queue a direction change. Ignores reversals and repeats relative to the last queued move. */
    turn(dir) {
      const last = this.queue.length ? this.queue[this.queue.length - 1] : this.dir;
      if (dir === last || dir === OPPOSITE[last] || this.queue.length >= MAX_QUEUED_TURNS) return false;
      this.queue.push(dir);
      return true;
    }

    /** The cell one step from `from` in `dir`, or null if it is outside a walled board. */
    neighbor(from, dir) {
      let x = from.x + DIRS[dir].x;
      let y = from.y + DIRS[dir].y;
      if (this.cfg.wrap) {
        x = (x + GRID) % GRID;
        y = (y + GRID) % GRID;
      } else if (x < 0 || y < 0 || x >= GRID || y >= GRID) {
        return null;
      }
      return { x, y };
    }

    hitsBody(cell, grows) {
      const end = grows ? this.snake.length : this.snake.length - 1; // the tail moves out of the way
      for (let i = 0; i < end; i++) {
        if (this.snake[i].x === cell.x && this.snake[i].y === cell.y) return true;
      }
      return false;
    }

    update(dt) {
      if (!this.alive) return;
      this.time += dt;
      this.acc += dt;

      if (this.bonus && this.time >= this.bonus.expires) {
        const b = this.bonus;
        this.bonus = null;
        this.emit('bonusExpire', b);
      }

      let steps = 0;
      while (this.alive && this.acc >= this.interval) {
        this.acc -= this.interval;
        this.step();
        if (++steps >= 4) { this.acc = 0; break; } // never spiral after a long frame
      }
    }

    step() {
      this.emit('beforeStep', this);
      if (this.queue.length) {
        this.dir = this.queue.shift();
        this.emit('turn', this.dir);
      }

      const head = this.snake[0];
      const next = this.neighbor(head, this.dir);
      if (!next) return this.die('wall');

      const eatsFood = !!this.food && next.x === this.food.x && next.y === this.food.y;
      if (this.hitsBody(next, eatsFood)) return this.die('self');

      const tail = this.snake[this.snake.length - 1];
      this.prevHead = { x: head.x, y: head.y };
      this.snake.unshift(next);
      if (eatsFood) {
        this.prevTail = null;
      } else {
        this.snake.pop();
        this.prevTail = { x: tail.x, y: tail.y };
      }

      if (eatsFood) {
        this.eaten++;
        this.score += this.cfg.points;
        this.emit('eat', next, this.cfg.points, this);
        this.food = this.randomEmptyCell();
        // Regular food takes priority when a bonus occupies the last free cell.
        if (!this.food && this.bonus) {
          const b = this.bonus;
          this.bonus = null;
          this.emit('bonusExpire', b);
          this.food = this.randomEmptyCell();
        }
        if (!this.food) return this.win();
        if (!this.bonus && this.eaten % BONUS_EVERY === 0) this.spawnBonus();
      }

      if (this.bonus && next.x === this.bonus.x && next.y === this.bonus.y) {
        const remaining = Math.max(0, (this.bonus.expires - this.time) / this.bonus.life);
        const raw = this.cfg.points * BONUS_MULT * (0.4 + 0.6 * remaining); // faster = more points
        const pts = Math.max(5, Math.round(raw / 5) * 5);
        this.bonus = null;
        this.score += pts;
        this.emit('bonus', next, pts, this);
      }
    }

    spawnBonus() {
      const b = this.randomEmptyCell();
      if (!b) return;
      b.expires = this.time + BONUS_LIFE;
      b.life = BONUS_LIFE;
      this.bonus = b;
      this.emit('bonusSpawn', b);
    }

    freeze() {
      this.alive = false;
      this.prevHead = { ...this.snake[0] };
      this.prevTail = null;
      this.queue = [];
      this.acc = 0;
      this.diedAt = performance.now();
    }

    die(cause) {
      this.freeze();
      this.deathCause = cause;
      this.emit('die', cause, this);
    }

    win() {
      this.freeze();
      this.won = true;
      this.emit('win', this);
    }
  }

  // ═══════════════════════════════ Attract-mode AI ══════════════════════
  // A simple greedy snake that plays behind the start menu.

  function reachable(game, start, limit) {
    const blocked = new Set(game.snake.slice(0, -1).map((p) => p.y * GRID + p.x));
    const seen = new Set([start.y * GRID + start.x]);
    const stack = [start];
    while (stack.length && seen.size < limit) {
      const c = stack.pop();
      for (const d of DIR_NAMES) {
        const n = game.neighbor(c, d);
        if (!n) continue;
        const k = n.y * GRID + n.x;
        if (seen.has(k) || blocked.has(k)) continue;
        seen.add(k);
        stack.push(n);
      }
    }
    return seen.size;
  }

  const DIR_NAMES = Object.keys(DIRS);

  function demoThink(game) {
    const head = game.snake[0];
    const target = game.bonus || game.food;
    let best = null;
    let bestScore = Infinity;
    for (const d of DIR_NAMES) {
      if (d === OPPOSITE[game.dir]) continue;
      const n = game.neighbor(head, d);
      if (!n) continue;
      const grows = game.food && n.x === game.food.x && n.y === game.food.y;
      if (game.hitsBody(n, grows)) continue;
      let score = target ? Math.abs(n.x - target.x) + Math.abs(n.y - target.y) : 0;
      if (reachable(game, n, game.snake.length + 2) <= game.snake.length) score += 1000; // avoid traps
      if (d !== game.dir) score += 0.3;
      score += Math.random() * 0.5;
      if (score < bestScore) { bestScore = score; best = d; }
    }
    game.queue = best ? [best] : [];
  }

  // ═══════════════════════════════ DOM refs ═════════════════════════════

  const $ = (id) => document.getElementById(id);
  const el = {
    board: $('board'),
    canvas: $('canvas'),
    score: $('score'),
    best: $('best'),
    bestStat: $('bestStat'),
    diffTag: $('diffTag'),
    pauseBtn: $('pauseBtn'),
    muteBtn: $('muteBtn'),
    menu: $('menuOverlay'),
    pause: $('pauseOverlay'),
    over: $('overOverlay'),
    playBtn: $('playBtn'),
    resumeBtn: $('resumeBtn'),
    restartBtn: $('restartBtn'),
    pauseMenuBtn: $('pauseMenuBtn'),
    againBtn: $('againBtn'),
    overMenuBtn: $('overMenuBtn'),
    diffDesc: $('diffDesc'),
    menuBest: $('menuBest'),
    overTitle: $('overTitle'),
    overReason: $('overReason'),
    finalScore: $('finalScore'),
    newBest: $('newBest'),
    sumBest: $('sumBest'),
    sumLength: $('sumLength'),
    sumFood: $('sumFood'),
    sumTime: $('sumTime'),
    radios: [...document.querySelectorAll('input[name="difficulty"]')],
    colorblindBoxes: [$('colorblindMenu'), $('colorblindPause')],
  };

  // ═══════════════════════════════ Effects ══════════════════════════════

  const fx = {
    particles: [],
    floaters: [],
    shake: 0,
    flash: 0,
    clear() {
      this.particles.length = 0;
      this.floaters.length = 0;
      this.shake = 0;
      this.flash = 0;
    },
  };
  const SHAKE_MS = 450;
  const FLASH_MS = 380;

  function burst(cell, colors, count, speed = 6) {
    for (let i = 0; i < count; i++) {
      const a = Math.random() * TAU;
      const v = speed * (0.35 + Math.random() * 0.65);
      const life = 380 + Math.random() * 420;
      fx.particles.push({
        x: cell.x + 0.5,
        y: cell.y + 0.5,
        vx: Math.cos(a) * v,
        vy: Math.sin(a) * v,
        life,
        max: life,
        size: 0.06 + Math.random() * 0.1,
        color: colors[(Math.random() * colors.length) | 0],
      });
    }
  }

  function floater(cell, text, color) {
    fx.floaters.push({ x: cell.x + 0.5, y: cell.y + 0.5, text, color, life: 900, max: 900 });
  }

  function updateFx(dt) {
    const s = dt / 1000;
    for (let i = fx.particles.length - 1; i >= 0; i--) {
      const p = fx.particles[i];
      p.life -= dt;
      if (p.life <= 0) { fx.particles.splice(i, 1); continue; }
      p.x += p.vx * s;
      p.y += p.vy * s;
      p.vx *= 0.92;
      p.vy *= 0.92;
    }
    for (let i = fx.floaters.length - 1; i >= 0; i--) {
      if ((fx.floaters[i].life -= dt) <= 0) fx.floaters.splice(i, 1);
    }
    fx.shake = Math.max(0, fx.shake - dt);
    fx.flash = Math.max(0, fx.flash - dt);
  }

  // ═══════════════════════════════ Rendering ════════════════════════════

  const ctx = el.canvas.getContext('2d');
  const bgCanvas = document.createElement('canvas');
  let dpr = 1;
  let size = 0;
  let cell = 0;

  const PALETTE = {
    alive: { head: [134, 239, 172], tail: [21, 128, 61], glow: 'rgba(74, 222, 128, 0.55)' },
    dead: { head: [251, 113, 133], tail: [71, 85, 105], glow: 'rgba(251, 113, 133, 0.35)' },
    flash: { head: [255, 255, 255], tail: [254, 205, 211], glow: 'rgba(255, 255, 255, 0.6)' },
    win: { head: [253, 230, 138], tail: [217, 119, 6], glow: 'rgba(251, 191, 36, 0.6)' },
    // Red–green colorblind mode: blue/white palette that relies on luminance and shape.
    cb: { head: [191, 232, 253], tail: [40, 150, 226], glow: 'rgba(125, 211, 252, 0.5)', cb: true },
    cbDead: { head: [226, 232, 240], tail: [100, 116, 139], glow: 'rgba(226, 232, 240, 0.3)', cb: true },
  };

  let colorblind = store.get(STORAGE.colorblind, false) === true;

  function resize() {
    const rect = el.canvas.getBoundingClientRect();
    if (!rect.width) return;
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    size = rect.width;
    cell = size / GRID;
    el.canvas.width = Math.round(size * dpr);
    el.canvas.height = Math.round(size * dpr);
    buildBackground();
  }

  function buildBackground() {
    bgCanvas.width = el.canvas.width;
    bgCanvas.height = el.canvas.height;
    const b = bgCanvas.getContext('2d');
    b.setTransform(dpr, 0, 0, dpr, 0, 0);
    b.fillStyle = '#0a1020';
    b.fillRect(0, 0, size, size);
    b.fillStyle = '#0d1529';
    for (let y = 0; y < GRID; y++) {
      for (let x = 0; x < GRID; x++) {
        if ((x + y) % 2) continue;
        const x0 = Math.round(x * cell);
        const y0 = Math.round(y * cell);
        b.fillRect(x0, y0, Math.round((x + 1) * cell) - x0, Math.round((y + 1) * cell) - y0);
      }
    }
    const v = b.createRadialGradient(size / 2, size / 2, size * 0.25, size / 2, size / 2, size * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.4)');
    b.fillStyle = v;
    b.fillRect(0, 0, size, size);
  }

  const lerp = (a, b, t) => a + (b - a) * t;
  const mixRgb = (a, b, t) => `rgb(${lerp(a[0], b[0], t) | 0},${lerp(a[1], b[1], t) | 0},${lerp(a[2], b[2], t) | 0})`;
  const easeOutBack = (t) => 1 + 2.7 * Math.pow(t - 1, 3) + 1.7 * Math.pow(t - 1, 2);

  /** Shift `b` by whole board widths so it lies next to `a` (used for wrap-around continuity). */
  function nearest(a, b) {
    return {
      x: b.x + Math.round((a.x - b.x) / GRID) * GRID,
      y: b.y + Math.round((a.y - b.y) / GRID) * GRID,
    };
  }

  function lerpCell(from, to, t) {
    const b = nearest(from, to);
    return { x: lerp(from.x, b.x, t), y: lerp(from.y, b.y, t) };
  }

  /** Continuous (unwrapped) centerline of the snake, in cell units, smoothly interpolated. */
  function snakePath(game) {
    const t = game.progress;
    const s = game.snake;
    const pts = [lerpCell(game.prevHead, s[0], t)];
    for (let i = 1; i < s.length; i++) pts.push({ x: s[i].x, y: s[i].y });
    if (game.prevTail) pts.push(lerpCell(game.prevTail, s[s.length - 1], t));
    for (let i = 1; i < pts.length; i++) pts[i] = nearest(pts[i - 1], pts[i]);
    return pts;
  }

  function render(game, now) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size, size);

    ctx.save();
    if (fx.shake > 0) {
      const m = (fx.shake / SHAKE_MS) * cell * 0.4;
      ctx.translate((Math.random() * 2 - 1) * m, (Math.random() * 2 - 1) * m);
    }
    ctx.drawImage(bgCanvas, 0, 0, size, size);

    if (game) {
      if (game.food) drawFood(game.food, now);
      if (game.bonus) drawBonus(game, now);
      drawSnake(game, now);
    }
    drawParticles();
    drawFloaters();
    ctx.restore();

    if (fx.flash > 0) {
      ctx.fillStyle = `rgba(251, 113, 133, ${(fx.flash / FLASH_MS) * 0.28})`;
      ctx.fillRect(0, 0, size, size);
    }
  }

  function drawSnake(game, now) {
    const pts = snakePath(game);

    let palette = colorblind ? PALETTE.cb : PALETTE.alive;
    if (game.won) palette = PALETTE.win;
    else if (!game.alive) {
      const since = now - game.diedAt;
      const dead = colorblind ? PALETTE.cbDead : PALETTE.dead;
      palette = since < 650 && Math.floor(since / 110) % 2 === 0 ? PALETTE.flash : dead;
    }

    // A long snake can wind around the board several times. Draw every copy
    // whose bounds intersect the board, including a cell of margin for glow.
    const offsets = (axis) => {
      if (!game.cfg.wrap) return [0];
      const values = pts.map((p) => p[axis]);
      const min = Math.min(...values);
      const max = Math.max(...values);
      const result = [];
      for (let k = Math.ceil((-1 - max) / GRID); k <= Math.floor((GRID - min) / GRID); k++) {
        result.push(k * GRID);
      }
      return result;
    };
    const offsetsX = offsets('x');
    const offsetsY = offsets('y');

    for (const ox of offsetsX) {
      for (const oy of offsetsY) {
        ctx.save();
        ctx.translate(ox * cell, oy * cell);
        drawSnakeBody(pts, palette, game);
        ctx.restore();
      }
    }
  }

  function drawSnakeBody(pts, palette, game) {
    const px = (p) => (p.x + 0.5) * cell;
    const py = (p) => (p.y + 0.5) * cell;
    const width = cell * 0.78;
    const n = pts.length;

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Glow underlay
    ctx.save();
    ctx.shadowColor = palette.glow;
    ctx.shadowBlur = cell * 0.7;
    ctx.strokeStyle = mixRgb(palette.head, palette.tail, 0.5);
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(px(pts[0]), py(pts[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(px(pts[i]), py(pts[i]));
    if (n === 1) ctx.lineTo(px(pts[0]) + 0.01, py(pts[0]));
    ctx.stroke();
    ctx.restore();

    // Pale rim: keeps the silhouette readable against the board regardless of hue
    if (palette.cb) {
      ctx.strokeStyle = '#f0f9ff';
      ctx.lineWidth = width + Math.max(2, cell * 0.1);
      ctx.beginPath();
      ctx.moveTo(px(pts[0]), py(pts[0]));
      for (let i = 1; i < n; i++) ctx.lineTo(px(pts[i]), py(pts[i]));
      if (n === 1) ctx.lineTo(px(pts[0]) + 0.01, py(pts[0]));
      ctx.stroke();
    }

    // Gradient body, drawn tail → head so the head sits on top
    ctx.lineWidth = width;
    for (let i = n - 2; i >= 0; i--) {
      ctx.strokeStyle = mixRgb(palette.head, palette.tail, i / Math.max(1, n - 2));
      ctx.beginPath();
      ctx.moveTo(px(pts[i + 1]), py(pts[i + 1]));
      ctx.lineTo(px(pts[i]), py(pts[i]));
      ctx.stroke();
    }

    // Glossy highlight along the spine
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.13)';
    ctx.lineWidth = width * 0.3;
    ctx.beginPath();
    ctx.moveTo(px(pts[0]), py(pts[0]));
    for (let i = 1; i < n; i++) ctx.lineTo(px(pts[i]), py(pts[i]));
    ctx.stroke();

    // Head
    const hx = px(pts[0]);
    const hy = py(pts[0]);
    if (palette.cb) {
      ctx.fillStyle = '#f0f9ff';
      ctx.beginPath();
      ctx.arc(hx, hy, width * 0.56 + Math.max(1, cell * 0.05), 0, TAU);
      ctx.fill();
    }
    ctx.fillStyle = `rgb(${palette.head.join(',')})`;
    ctx.beginPath();
    ctx.arc(hx, hy, width * 0.56, 0, TAU);
    ctx.fill();

    drawEyes(hx, hy, DIRS[game.dir], !game.alive && !game.won, !!palette.cb);
  }

  function drawEyes(hx, hy, d, dead, cb) {
    const perp = { x: -d.y, y: d.x };
    const fwd = cell * 0.14;
    const side = cell * 0.2;
    for (const s of [-1, 1]) {
      const ex = hx + d.x * fwd + perp.x * side * s;
      const ey = hy + d.y * fwd + perp.y * side * s;
      if (dead) {
        const r = cell * 0.09;
        ctx.strokeStyle = '#1f2937';
        ctx.lineWidth = cell * 0.06;
        ctx.beginPath();
        ctx.moveTo(ex - r, ey - r); ctx.lineTo(ex + r, ey + r);
        ctx.moveTo(ex + r, ey - r); ctx.lineTo(ex - r, ey + r);
        ctx.stroke();
      } else {
        if (cb) {
          // Dark socket so the eyes stand out on the light head
          ctx.fillStyle = '#0b1220';
          ctx.beginPath();
          ctx.arc(ex, ey, cell * 0.155, 0, TAU);
          ctx.fill();
        }
        ctx.fillStyle = '#f8fafc';
        ctx.beginPath();
        ctx.arc(ex, ey, cell * 0.12, 0, TAU);
        ctx.fill();
        ctx.fillStyle = '#0b1220';
        ctx.beginPath();
        ctx.arc(ex + d.x * cell * 0.045, ey + d.y * cell * 0.045, cell * 0.065, 0, TAU);
        ctx.fill();
      }
    }
  }

  function drawFood(f, now) {
    const cx = (f.x + 0.5) * cell;
    const cy = (f.y + 0.5) * cell;
    const pop = easeOutBack(Math.min(1, Math.max(0, now - f.born) / 280));
    const r = cell * 0.34 * pop * (1 + Math.sin(now / 170) * 0.06);
    if (r <= 0) return;

    if (colorblind) {
      // Bright solid diamond with a dark outline: shape and luminance, not hue
      const d = r * 1.2;
      ctx.save();
      ctx.shadowColor = 'rgba(255, 255, 255, 0.8)';
      ctx.shadowBlur = cell * 0.5;
      ctx.beginPath();
      ctx.moveTo(cx, cy - d);
      ctx.lineTo(cx + d, cy);
      ctx.lineTo(cx, cy + d);
      ctx.lineTo(cx - d, cy);
      ctx.closePath();
      ctx.fillStyle = '#ffffff';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineJoin = 'miter';
      ctx.lineWidth = Math.max(1.5, cell * 0.07);
      ctx.strokeStyle = '#0b1220';
      ctx.stroke();
      ctx.restore();
      return;
    }

    ctx.save();
    ctx.shadowColor = 'rgba(251, 113, 133, 0.9)';
    ctx.shadowBlur = cell * 0.8;
    const g = ctx.createRadialGradient(cx - r * 0.35, cy - r * 0.35, r * 0.1, cx, cy, r);
    g.addColorStop(0, '#ffe4e9');
    g.addColorStop(0.35, '#fb7185');
    g.addColorStop(1, '#be123c');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, TAU);
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = '#4ade80';
    ctx.beginPath();
    ctx.ellipse(cx + r * 0.3, cy - r * 0.95, r * 0.38, r * 0.17, -0.6, 0, TAU);
    ctx.fill();
  }

  function drawBonus(game, now) {
    const b = game.bonus;
    const remaining = Math.max(0, (b.expires - game.time) / b.life);
    const cx = (b.x + 0.5) * cell;
    const cy = (b.y + 0.5) * cell;
    const pop = easeOutBack(Math.min(1, Math.max(0, now - b.born) / 320));
    const cb = colorblind;
    // Colorblind mode never dims or resizes the bonus; the shrinking ring shows the time left.
    const blinking = !cb && remaining < 0.3 && Math.floor(now / 120) % 2 === 0;

    ctx.save();
    ctx.globalAlpha = blinking ? 0.35 : 1;

    // Countdown ring
    ctx.strokeStyle = cb ? '#64748b' : 'rgba(251, 191, 36, 0.25)';
    ctx.lineWidth = cb ? Math.max(2, cell * 0.1) : cell * 0.07;
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.47, 0, TAU);
    ctx.stroke();
    ctx.strokeStyle = cb ? '#ffd21f' : '#fbbf24';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.arc(cx, cy, cell * 0.47, -Math.PI / 2, -Math.PI / 2 + TAU * remaining);
    ctx.stroke();

    // Spinning star (upright in colorblind mode)
    ctx.translate(cx, cy);
    if (!cb) ctx.rotate(now / 650);
    ctx.scale(pop, pop);
    ctx.shadowColor = 'rgba(251, 191, 36, 0.95)';
    ctx.shadowBlur = cell * 0.9;
    const outer = cell * (cb ? 0.3 : 0.33);
    const inner = outer * 0.48;
    ctx.beginPath();
    for (let i = 0; i < 10; i++) {
      const r = i % 2 ? inner : outer;
      const a = (i / 10) * TAU - Math.PI / 2;
      ctx.lineTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    ctx.closePath();
    if (cb) {
      ctx.fillStyle = '#ffd21f';
      ctx.fill();
      ctx.shadowBlur = 0;
      ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(1.5, cell * 0.06);
      ctx.strokeStyle = '#422006';
      ctx.stroke();
      ctx.restore();
      return;
    }
    const g = ctx.createRadialGradient(0, -outer * 0.3, 0, 0, 0, outer);
    g.addColorStop(0, '#fffbeb');
    g.addColorStop(0.5, '#fcd34d');
    g.addColorStop(1, '#f59e0b');
    ctx.fillStyle = g;
    ctx.fill();
    ctx.restore();
  }

  function drawParticles() {
    for (const p of fx.particles) {
      ctx.globalAlpha = Math.max(0, p.life / p.max);
      ctx.fillStyle = p.color;
      ctx.beginPath();
      ctx.arc(p.x * cell, p.y * cell, p.size * cell * (0.5 + 0.5 * (p.life / p.max)), 0, TAU);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
  }

  function drawFloaters() {
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const f of fx.floaters) {
      const t = 1 - f.life / f.max;
      ctx.globalAlpha = t < 0.7 ? 1 : 1 - (t - 0.7) / 0.3;
      ctx.font = `800 ${Math.round(cell * 0.62)}px ui-sans-serif, system-ui, sans-serif`;
      ctx.fillStyle = f.color;
      ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
      ctx.shadowBlur = 6;
      // Keep text inside the board horizontally
      const x = Math.min(size - cell * 1.5, Math.max(cell * 1.5, f.x * cell));
      ctx.fillText(f.text, x, (f.y - 0.6 - t * 1.3) * cell);
    }
    ctx.shadowBlur = 0;
    ctx.globalAlpha = 1;
  }

  // ═══════════════════════════════ App state ════════════════════════════

  let state = 'menu'; // 'menu' | 'playing' | 'paused' | 'over'
  const savedDifficulty = store.get(STORAGE.difficulty, 'normal');
  let difficulty = DIFF_ORDER.includes(savedDifficulty) ? savedDifficulty : 'normal';
  const savedHighs = store.get(STORAGE.highs, {});
  const highs = {};
  if (savedHighs && typeof savedHighs === 'object' && !Array.isArray(savedHighs)) {
    for (const key of DIFF_ORDER) {
      const value = savedHighs[key];
      if (Number.isSafeInteger(value) && value >= 0) highs[key] = value;
    }
  }

  let game = null;
  let startBest = 0;
  let beatBestAnnounced = false;
  let overTimer = 0;
  let celebrateTimer = 0;
  let overReady = false;

  const demoCfg = { ...DIFFICULTIES.normal, interval: 85, min: 85, accel: 0 };
  let demo = new SnakeGame(demoCfg, {
    beforeStep: demoThink,
    die: () => { demoResetAt = performance.now() + 1400; },
    win: () => { demoResetAt = performance.now() + 1400; },
  });
  let demoResetAt = 0;

  const gameHooks = {
    turn: () => Sound.turn(),
    eat: (cell, pts, g) => {
      Sound.eat(g.eaten);
      burst(cell, colorblind ? ['#ffffff', '#e0f2fe', '#7dd3fc'] : ['#fb7185', '#fda4af', '#4ade80', '#bbf7d0'], 16, 7);
      floater(cell, `+${pts}`, colorblind ? '#e0f2fe' : '#bbf7d0');
      onScore(g);
    },
    bonus: (cell, pts, g) => {
      Sound.bonus();
      burst(cell, ['#fbbf24', '#fde68a', '#fff7ed', '#f59e0b'], 30, 9);
      floater(cell, `+${pts}`, '#fde68a');
      onScore(g);
    },
    bonusSpawn: () => Sound.bonusSpawn(),
    bonusExpire: (b) => {
      Sound.bonusExpire();
      burst(b, ['#78716c', '#a8a29e'], 10, 3);
    },
    die: (cause, g) => {
      Sound.die();
      fx.shake = SHAKE_MS;
      fx.flash = FLASH_MS;
      burst(g.snake[0], colorblind ? ['#e2e8f0', '#94a3b8', '#ffffff'] : ['#fb7185', '#f43f5e', '#fecdd3', '#ffffff'], 36, 10);
      endGame(false);
    },
    win: (g) => {
      Sound.win();
      for (let i = 0; i < 6; i++) {
        burst({ x: Math.random() * GRID, y: Math.random() * GRID }, ['#fbbf24', '#4ade80', '#22d3ee', '#fb7185', '#ffffff'], 24, 10);
      }
      endGame(true);
    },
  };

  function best() {
    return highs[difficulty] || 0;
  }

  function setState(next) {
    state = next;
    document.body.dataset.state = next;
    el.pauseBtn.disabled = !(next === 'playing' || next === 'paused');
    const label = next === 'paused' ? 'Resume (Space)' : 'Pause (Space)';
    el.pauseBtn.setAttribute('aria-label', label);
    el.pauseBtn.title = label;
  }

  function showOverlay(which) {
    const map = { menu: el.menu, paused: el.pause, over: el.over };
    for (const [key, node] of Object.entries(map)) {
      const on = key === which;
      node.classList.toggle('show', on);
      node.inert = !on;
    }
    const node = map[which];
    if (node) {
      const target = node.querySelector('[data-autofocus]');
      if (target) requestAnimationFrame(() => target.focus({ preventScroll: true }));
    } else if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  }

  function bump(node) {
    node.classList.remove('bump');
    void node.offsetWidth; // restart the animation
    node.classList.add('bump');
  }

  function updateHud() {
    const score = game && state !== 'menu' ? game.score : 0;
    el.score.textContent = score;
    el.best.textContent = Math.max(best(), score);
    el.diffTag.textContent = DIFFICULTIES[difficulty].label;
    el.bestStat.classList.toggle('record', state !== 'menu' && score > 0 && score > startBest);
  }

  function onScore(g) {
    bump(el.score);
    if (g.score > best()) {
      highs[difficulty] = g.score;
      store.set(STORAGE.highs, highs);
      bump(el.best);
    }
    if (startBest > 0 && g.score > startBest && !beatBestAnnounced) {
      beatBestAnnounced = true;
      Sound.highScore();
      floater({ x: GRID / 2 - 0.5, y: 3 }, 'NEW BEST!', '#fbbf24');
    }
    updateHud();
  }

  function setDifficulty(key, { sound = true } = {}) {
    if (!DIFF_ORDER.includes(key)) return;
    const changed = key !== difficulty;
    difficulty = key;
    store.set(STORAGE.difficulty, key);
    for (const r of el.radios) r.checked = r.value === key;
    el.diffDesc.textContent = DIFFICULTIES[key].desc;
    el.menuBest.textContent = best();
    if (changed && sound) Sound.select();
    updateHud();
  }

  /** Applies immediately (the renderer reads `colorblind` every frame); never touches game state. */
  function setColorblind(value, { persist = true } = {}) {
    colorblind = value === true;
    for (const box of el.colorblindBoxes) box.checked = colorblind;
    if (persist) store.set(STORAGE.colorblind, colorblind);
  }

  function cycleDifficulty(delta) {
    const i = DIFF_ORDER.indexOf(difficulty);
    setDifficulty(DIFF_ORDER[(i + delta + DIFF_ORDER.length) % DIFF_ORDER.length]);
  }

  function startGame() {
    clearTimeout(overTimer);
    clearTimeout(celebrateTimer);
    overReady = false;
    Sound.unlock();
    Sound.start();
    fx.clear();
    game = new SnakeGame(DIFFICULTIES[difficulty], gameHooks);
    startBest = best();
    beatBestAnnounced = false;
    el.board.classList.toggle('wrap', game.cfg.wrap);
    el.board.classList.remove('danger');
    setState('playing');
    showOverlay(null);
    updateHud();
  }

  function pauseGame() {
    if (state !== 'playing') return;
    setState('paused');
    showOverlay('paused');
    Sound.pause();
  }

  function resumeGame() {
    if (state !== 'paused') return;
    setState('playing');
    showOverlay(null);
    Sound.resume();
  }

  function togglePause() {
    if (state === 'playing') pauseGame();
    else if (state === 'paused') resumeGame();
  }

  function goToMenu() {
    clearTimeout(overTimer);
    clearTimeout(celebrateTimer);
    overReady = false;
    fx.clear();
    demo.reset();
    demoResetAt = 0;
    el.board.classList.remove('wrap', 'danger');
    setState('menu');
    showOverlay('menu');
    setDifficulty(difficulty, { sound: false });
  }

  function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  }

  const DEATH_REASONS = {
    wall: ['You crashed into the wall.', 'The wall did not move.', 'Walls: 1, Snake: 0.'],
    self: ['You bit your own tail.', 'Ouch — that was you.', 'Self-snack detected.'],
  };

  function endGame(won) {
    setState('over');
    el.board.classList.toggle('danger', !won);

    const score = game.score;
    const isNewBest = score > startBest && score > 0;
    if (score > best()) {
      highs[difficulty] = score;
      store.set(STORAGE.highs, highs);
    }
    if (isNewBest && !beatBestAnnounced && !won) {
      // First-ever score on this difficulty, or beat it on the final bite — celebrate after the crash.
      celebrateTimer = setTimeout(() => Sound.highScore(), 650);
    }

    const reasons = DEATH_REASONS[game.deathCause] || ['Game over.'];
    el.overTitle.textContent = won ? 'You Win!' : 'Game Over';
    el.overTitle.classList.toggle('win', won);
    el.overTitle.classList.toggle('lose', !won);
    el.overReason.textContent = won ? 'You filled the entire board. Incredible.' : reasons[(Math.random() * reasons.length) | 0];
    el.finalScore.textContent = score;
    el.newBest.hidden = !isNewBest;
    el.sumBest.textContent = best();
    el.sumLength.textContent = game.snake.length;
    el.sumFood.textContent = game.eaten;
    el.sumTime.textContent = formatTime(game.time);
    updateHud();

    // Let the death animation play before covering the board.
    overTimer = setTimeout(() => {
      overReady = true;
      showOverlay('over');
    }, won ? 1400 : 850);
  }

  // ═══════════════════════════════ Input ════════════════════════════════

  function onKeyDown(e) {
    Sound.unlock();
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const target = e.target;
    const onButton = target instanceof HTMLButtonElement;
    const onRadio = target instanceof HTMLInputElement && target.type === 'radio';
    const onCheckbox = target instanceof HTMLInputElement && target.type === 'checkbox';
    const key = e.key;
    const dir = KEY_DIRS[e.code];

    // Space on a focused checkbox is the browser's native toggle, not pause/resume.
    if (onCheckbox && key === ' ') return;

    // ── Movement
    if (dir) {
      if (state === 'playing') {
        e.preventDefault();
        game.turn(dir);
      } else if (state === 'menu' && !onRadio) {
        e.preventDefault();
        if (dir === 'left' || dir === 'up') cycleDifficulty(-1);
        else cycleDifficulty(1);
      } else if (state !== 'menu' && key.startsWith('Arrow')) {
        e.preventDefault(); // don't scroll the page
      }
      return;
    }

    if (e.repeat) return;
    const lower = key.length === 1 ? key.toLowerCase() : key;

    // Let focused buttons handle their own Enter/Space activation.
    if (onButton && (key === 'Enter' || key === ' ')) return;

    switch (lower) {
      case 'm':
        toggleMute();
        break;

      case 'Enter':
      case ' ':
        e.preventDefault();
        if (state === 'menu') startGame();
        else if (state === 'playing' && key === ' ') pauseGame();
        else if (state === 'paused') resumeGame();
        else if (state === 'over' && overReady) startGame();
        break;

      case 'p':
        if (state === 'playing' || state === 'paused') togglePause();
        break;

      case 'Escape':
        if (state === 'playing' || state === 'paused') togglePause();
        else if (state === 'over' && overReady) goToMenu();
        break;

      case 'r':
        if (state === 'playing' || state === 'paused' || (state === 'over' && overReady)) startGame();
        break;

      case '1': case '2': case '3': case '4':
        if (state === 'menu') setDifficulty(DIFF_ORDER[Number(key) - 1]);
        break;

      default:
        break;
    }
  }

  function toggleMute() {
    Sound.setMuted(!Sound.muted);
    document.body.dataset.muted = String(Sound.muted);
    const label = Sound.muted ? 'Unmute (M)' : 'Mute (M)';
    el.muteBtn.setAttribute('aria-label', label);
    el.muteBtn.title = label;
    if (!Sound.muted) Sound.select();
  }

  // Swipe controls for touch screens — steer continuously while the finger moves.
  let touchOrigin = null;
  const SWIPE_PX = 22;

  function onTouchStart(e) {
    Sound.unlock();
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    touchOrigin = { x: t.clientX, y: t.clientY };
  }

  function onTouchMove(e) {
    if (!touchOrigin || state !== 'playing') return;
    e.preventDefault();
    const t = e.touches[0];
    const dx = t.clientX - touchOrigin.x;
    const dy = t.clientY - touchOrigin.y;
    if (Math.max(Math.abs(dx), Math.abs(dy)) < SWIPE_PX) return;
    const dir = Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
    game.turn(dir);
    touchOrigin = { x: t.clientX, y: t.clientY };
  }

  function onTouchEnd() {
    touchOrigin = null;
  }

  // Buttons clicked with a mouse shouldn't keep focus (it would swallow Space/Enter later).
  function clickThen(fn) {
    return (e) => {
      Sound.unlock();
      if (e.detail > 0 && e.currentTarget instanceof HTMLElement) e.currentTarget.blur();
      fn();
    };
  }

  document.addEventListener('keydown', onKeyDown);
  el.board.addEventListener('touchstart', onTouchStart, { passive: true });
  el.board.addEventListener('touchmove', onTouchMove, { passive: false });
  el.board.addEventListener('touchend', onTouchEnd);
  el.board.addEventListener('touchcancel', onTouchEnd);

  el.playBtn.addEventListener('click', clickThen(startGame));
  el.resumeBtn.addEventListener('click', clickThen(resumeGame));
  el.restartBtn.addEventListener('click', clickThen(startGame));
  el.pauseMenuBtn.addEventListener('click', clickThen(goToMenu));
  el.againBtn.addEventListener('click', clickThen(startGame));
  el.overMenuBtn.addEventListener('click', clickThen(goToMenu));
  el.pauseBtn.addEventListener('click', clickThen(togglePause));
  el.muteBtn.addEventListener('click', clickThen(toggleMute));
  for (const r of el.radios) {
    r.addEventListener('change', () => { Sound.unlock(); setDifficulty(r.value); });
  }

  for (const box of el.colorblindBoxes) {
    box.addEventListener('change', () => { Sound.unlock(); setColorblind(box.checked); });
  }

  // Auto-pause when the player leaves the tab or window.
  document.addEventListener('visibilitychange', () => { if (document.hidden) pauseGame(); });
  window.addEventListener('blur', pauseGame);

  // ═══════════════════════════════ Main loop ════════════════════════════

  let lastFrame = performance.now();

  function frame(now) {
    const dt = Math.min(200, now - lastFrame);
    lastFrame = now;

    if (state === 'playing') {
      game.update(dt);
    } else if (state === 'menu') {
      if (demo.alive) {
        demo.update(dt);
        if (demo.snake.length > 45) { demo.freeze(); demoResetAt = now + 800; }
      } else if (now >= demoResetAt) {
        demo.reset();
      }
    }

    updateFx(dt);
    render(state === 'menu' ? demo : game, now);
    requestAnimationFrame(frame);
  }

  // ═══════════════════════════════ Boot ═════════════════════════════════

  new ResizeObserver(resize).observe(el.canvas);
  resize();

  document.body.dataset.muted = String(Sound.muted);
  if (Sound.muted) {
    el.muteBtn.setAttribute('aria-label', 'Unmute (M)');
    el.muteBtn.title = 'Unmute (M)';
  }
  setColorblind(colorblind, { persist: false });
  setState('menu');
  setDifficulty(difficulty, { sound: false });
  showOverlay('menu');
  requestAnimationFrame(frame);
})();
