const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
ctx.imageSmoothingEnabled = false;
ctx.textBaseline = 'top';

const VW = 1024;
const VH = 512;
const TILE = 32;
const ROWS = 16;
const STEP = 1000 / 60;

const S_EMPTY = 0;
const S_GROUND = 1;
const S_ONEWAY = 2;
const S_BRICK = 3;

const GRAVITY = 0.6;
const MAX_FALL = 12;
const ACCEL = 0.65;
const FRIC_G = 0.78;
const FRIC_A = 0.94;
const MAX_SPEED = 4.3;
const JUMP_V = -11.4;
const STOMP_V = -7.6;
const COYOTE = 7;
const BUFFER = 10;
const ENEMY_SPD = 1.1;

const PAL = [
  {
    skyTop: [110, 190, 255],
    skyBot: [226, 246, 255],
    hillFar: '#8fc98f',
    hillNear: '#4f9d5d',
    cloud: '#ffffff',
    dirt: '#8a5a30',
    dirtDark: '#6f471f',
    dirtLight: '#9c6a3a',
    grass: '#3fa34d',
    grassLight: '#63c76f',
    brick: '#b3703f',
    brickDark: '#8c5430',
    plank: '#c98b4a',
    plankLight: '#e5b06a',
    stars: false
  },
  {
    skyTop: [255, 148, 86],
    skyBot: [255, 224, 178],
    hillFar: '#9e7bb0',
    hillNear: '#6b5090',
    cloud: '#ffe0c4',
    dirt: '#7d5038',
    dirtDark: '#633e29',
    dirtLight: '#946046',
    grass: '#4f9b6a',
    grassLight: '#6dbb86',
    brick: '#a8623f',
    brickDark: '#7f472c',
    plank: '#b87c40',
    plankLight: '#d9a05c',
    stars: false
  },
  {
    skyTop: [20, 27, 61],
    skyBot: [58, 74, 130],
    hillFar: '#33407a',
    hillNear: '#232e5e',
    cloud: '#44508c',
    dirt: '#4f4a6b',
    dirtDark: '#3b3752',
    dirtLight: '#615c85',
    grass: '#3c8f7a',
    grassLight: '#54b099',
    brick: '#6d5a8c',
    brickDark: '#514269',
    plank: '#7d6a4e',
    plankLight: '#9d8a6a',
    stars: true
  }
];

const SKY_BANDS = PAL.map(p => {
  const bands = [];
  for (let i = 0; i < 16; i++) {
    const t = i / 15;
    const r = Math.round(p.skyTop[0] + (p.skyBot[0] - p.skyTop[0]) * t);
    const g = Math.round(p.skyTop[1] + (p.skyBot[1] - p.skyTop[1]) * t);
    const b = Math.round(p.skyTop[2] + (p.skyBot[2] - p.skyTop[2]) * t);
    bands.push('rgb(' + r + ',' + g + ',' + b + ')');
  }
  return bands;
});

function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s += 0x6D2B79F5;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CLOUDS = [0, 1, 2].map(i => {
  const r = rng(1000 + i * 97);
  const out = [];
  for (let x = 0; x < 4600; x += 260 + r() * 240) {
    out.push({ x: x, y: 26 + r() * 120, s: 0.7 + r() * 0.8 });
  }
  return out;
});

const STARS = (() => {
  const r = rng(777);
  const out = [];
  for (let i = 0; i < 90; i++) out.push({ x: r() * 4200, y: r() * 220, s: r() < 0.3 ? 3 : 2, b: r() });
  return out;
})();

const keys = {};
let pressed = {};
let muted = false;
let actx = null;
let master = null;
let musicTimer = null;
let musicStep = 0;
let musicNext = 0;

function initAudio() {
  if (!actx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      actx = new AC();
      master = actx.createGain();
      master.gain.value = 0.7;
      master.connect(actx.destination);
    }
  }
  if (actx && actx.state === 'suspended') actx.resume();
  if (actx && !musicTimer) musicTimer = setInterval(musicTick, 60);
}

function toggleMute() {
  muted = !muted;
  if (master) master.gain.value = muted ? 0 : 0.7;
}

function tone(freq, dur, type, vol, slide) {
  if (!actx || muted) return;
  try {
    const t0 = actx.currentTime;
    const osc = actx.createOscillator();
    const g = actx.createGain();
    osc.type = type || 'square';
    osc.frequency.setValueAtTime(freq, t0);
    if (slide) osc.frequency.exponentialRampToValueAtTime(Math.max(40, freq + slide), t0 + dur);
    g.gain.setValueAtTime(vol || 0.05, t0);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(master);
    osc.start(t0);
    osc.stop(t0 + dur);
  } catch (e) {}
}

function sndJump() { tone(300, 0.14, 'square', 0.045, 260); }
function sndCoin() { tone(950, 0.07, 'square', 0.04); setTimeout(() => tone(1400, 0.09, 'square', 0.04), 55); }
function sndStomp() { tone(220, 0.12, 'square', 0.05, -140); }
function sndHurt() { tone(300, 0.35, 'sawtooth', 0.05, -250); }
function sndClear() { [520, 660, 780, 1040].forEach((f, i) => setTimeout(() => tone(f, 0.12, 'square', 0.045), i * 90)); }
function sndWin() { [523, 659, 784, 1047, 784, 1047, 1319, 1568].forEach((f, i) => setTimeout(() => tone(f, 0.16, 'square', 0.05), i * 120)); }
function sndLose() { [392, 349, 294, 262, 196].forEach((f, i) => setTimeout(() => tone(f, i === 4 ? 0.6 : 0.22, 'sawtooth', 0.05), i * 170)); }

const STEP_SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
function nf(name) {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name);
  if (!m) return 0;
  const semi = STEP_SEMI[m[1]] + (m[2] === '#' ? 1 : (m[2] === 'b' ? -1 : 0));
  return 440 * Math.pow(2, (semi - 9) / 12 + (+m[3] - 4));
}

function buildSong(d) {
  const s = { stepDur: 60 / d.bpm / 2, len: d.bars.length * 8, bass: [], lead: [], arp: [], chord: [], kick: [], snare: [], hat: [] };
  for (let bi = 0; bi < d.bars.length; bi++) {
    const b = d.bars[bi];
    const last = bi === d.bars.length - 1;
    const kickP = last && d.kickPatLast ? d.kickPatLast : d.kickPat;
    const snareP = last && d.snarePatLast ? d.snarePatLast : d.snarePat;
    const leadRow = d.lead[bi] || [];
    for (let j = 0; j < 8; j++) {
      const bp = d.bassPat[j];
      s.bass.push(bp === 1 ? b.bass : bp === 2 ? b.fifth : bp === 3 ? b.bass * 2 : 0);
      s.lead.push(leadRow[j] || 0);
      const ap = d.arpPat[j];
      s.arp.push(ap && b.arp ? b.arp[ap - 1] || 0 : 0);
      s.chord.push(j === 0 ? b.tri : 0);
      s.kick.push(kickP[j]);
      s.snare.push(snareP[j]);
      s.hat.push(d.hatPat[j]);
    }
  }
  return s;
}

const GAME_SONG = buildSong({
  bpm: 138,
  bars: [
    { bass: nf('A2'), fifth: nf('E3'), tri: [nf('A3'), nf('C4'), nf('E4')], arp: [nf('A4'), nf('C5'), nf('E5')] },
    { bass: nf('F2'), fifth: nf('C3'), tri: [nf('F3'), nf('A3'), nf('C4')], arp: [nf('F4'), nf('A4'), nf('C5')] },
    { bass: nf('C3'), fifth: nf('G3'), tri: [nf('C4'), nf('E4'), nf('G4')], arp: [nf('C5'), nf('E5'), nf('G5')] },
    { bass: nf('G2'), fifth: nf('D3'), tri: [nf('G3'), nf('B3'), nf('D4')], arp: [nf('G4'), nf('B4'), nf('D5')] }
  ],
  bassPat: [1, 0, 1, 1, 0, 1, 2, 1],
  arpPat: [1, 2, 3, 2, 1, 2, 3, 2],
  kickPat: [1, 0, 0, 0, 1, 0, 0, 0],
  kickPatLast: [1, 0, 0, 0, 1, 0, 1, 0],
  snarePat: [0, 0, 1, 0, 0, 0, 1, 0],
  snarePatLast: [0, 0, 1, 0, 0, 0, 1, 1],
  hatPat: [1, 1, 1, 1, 1, 1, 1, 1],
  lead: [
    [nf('A4'), 0, nf('C5'), nf('E5'), nf('D5'), 0, nf('C5'), 0],
    [nf('C5'), 0, nf('D5'), nf('C5'), nf('A4'), 0, nf('C5'), 0],
    [nf('E5'), 0, nf('G5'), nf('E5'), nf('D5'), 0, nf('C5'), 0],
    [nf('D5'), 0, nf('B4'), nf('D5'), nf('C5'), nf('B4'), nf('A4'), 0]
  ]
});

const MENU_SONG = buildSong({
  bpm: 96,
  bars: [
    { bass: nf('C3'), tri: [nf('C4'), nf('E4'), nf('G4'), nf('B4')], arp: [nf('E5'), nf('G5'), nf('B5')] },
    { bass: nf('A2'), tri: [nf('A3'), nf('C4'), nf('E4'), nf('G4')], arp: [nf('C5'), nf('E5'), nf('G5')] },
    { bass: nf('F2'), tri: [nf('F3'), nf('A3'), nf('C4'), nf('E4')], arp: [nf('A4'), nf('C5'), nf('E5')] },
    { bass: nf('G2'), tri: [nf('G3'), nf('B3'), nf('D4'), nf('F4')], arp: [nf('B4'), nf('D5'), nf('G5')] }
  ],
  bassPat: [1, 0, 0, 0, 1, 0, 0, 0],
  arpPat: [0, 0, 1, 0, 0, 0, 1, 0],
  kickPat: [1, 0, 0, 0, 1, 0, 0, 0],
  snarePat: [0, 0, 0, 0, 0, 0, 0, 0],
  hatPat: [1, 0, 1, 0, 1, 0, 1, 0],
  lead: [
    [0, nf('G4'), 0, 0, nf('E4'), 0, 0, 0],
    [0, nf('A4'), 0, 0, nf('C5'), 0, 0, 0],
    [0, nf('C5'), 0, 0, nf('A4'), 0, 0, 0],
    [0, nf('B4'), 0, 0, nf('D5'), 0, nf('G4'), 0]
  ]
});

let noiseBuf = null;

function getNoise() {
  if (!noiseBuf) {
    noiseBuf = actx.createBuffer(1, Math.floor(actx.sampleRate * 0.2), actx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return noiseBuf;
}

function playNote(freq, time, dur, type, vol, det) {
  const osc = actx.createOscillator();
  const g = actx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, time);
  g.gain.setValueAtTime(0.0001, time);
  g.gain.exponentialRampToValueAtTime(vol, time + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, time + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(time);
  osc.stop(time + dur + 0.03);
  if (det) {
    const o2 = actx.createOscillator();
    o2.type = type;
    o2.frequency.setValueAtTime(freq * (1 + det), time);
    o2.connect(g);
    o2.start(time);
    o2.stop(time + dur + 0.03);
  }
}

function playKick(time, vol) {
  const osc = actx.createOscillator();
  const g = actx.createGain();
  osc.type = 'sine';
  osc.frequency.setValueAtTime(150, time);
  osc.frequency.exponentialRampToValueAtTime(45, time + 0.12);
  g.gain.setValueAtTime(vol, time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.16);
  osc.connect(g);
  g.connect(master);
  osc.start(time);
  osc.stop(time + 0.18);
}

function playSnare(time, vol) {
  const src = actx.createBufferSource();
  src.buffer = getNoise();
  const bp = actx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 1900;
  bp.Q.value = 0.8;
  const g = actx.createGain();
  g.gain.setValueAtTime(vol, time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.14);
  src.connect(bp);
  bp.connect(g);
  g.connect(master);
  src.start(time);
  src.stop(time + 0.16);
  const osc = actx.createOscillator();
  const g2 = actx.createGain();
  osc.type = 'triangle';
  osc.frequency.setValueAtTime(190, time);
  g2.gain.setValueAtTime(vol * 0.7, time);
  g2.gain.exponentialRampToValueAtTime(0.0001, time + 0.08);
  osc.connect(g2);
  g2.connect(master);
  osc.start(time);
  osc.stop(time + 0.09);
}

function playHat(time, vol) {
  const src = actx.createBufferSource();
  src.buffer = getNoise();
  const hp = actx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 6500;
  const g = actx.createGain();
  g.gain.setValueAtTime(vol, time);
  g.gain.exponentialRampToValueAtTime(0.0001, time + 0.05);
  src.connect(hp);
  hp.connect(g);
  g.connect(master);
  src.start(time);
  src.stop(time + 0.06);
}

function scheduleStep(song, i, t) {
  const st = song.stepDur;
  const b = song.bass[i];
  if (b) playNote(b, t, st * 0.9, 'triangle', 0.05);
  const a = song.arp[i];
  if (a) playNote(a, t, st * 0.45, 'square', 0.013);
  const l = song.lead[i];
  if (l) playNote(l, t, st * 0.8, 'square', 0.03, 0.006);
  const ch = song.chord[i];
  if (ch) for (const f of ch) playNote(f, t, st * 7.6, 'triangle', 0.011);
  if (song.kick[i]) playKick(t, 0.17);
  if (song.snare[i]) playSnare(t, 0.13);
  if (song.hat[i]) playHat(t, i % 2 === 0 ? 0.018 : 0.011);
}

const SONGS = { menu: MENU_SONG, game: GAME_SONG };
let musicSong = '';

function musicTick() {
  if (!actx || muted || (state !== 'menu' && state !== 'playing')) {
    musicNext = 0;
    return;
  }
  const key = state === 'menu' ? 'menu' : 'game';
  if (musicSong !== key) {
    musicSong = key;
    musicStep = 0;
    musicNext = 0;
  }
  if (musicNext === 0 || musicNext < actx.currentTime - 0.5) musicNext = actx.currentTime + 0.08;
  const song = SONGS[key];
  while (musicNext < actx.currentTime + 0.2) {
    scheduleStep(song, musicStep, musicNext);
    musicStep = (musicStep + 1) % song.len;
    musicNext += song.stepDur;
  }
}

const BLOCK = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'KeyW', 'KeyA', 'KeyS', 'KeyD'];

window.addEventListener('keydown', e => {
  const tag = e.target && e.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (BLOCK.indexOf(e.code) >= 0) e.preventDefault();
  if (!e.repeat) pressed[e.code] = true;
  keys[e.code] = true;
  initAudio();
  if (e.code === 'KeyM') toggleMute();
});
window.addEventListener('keyup', e => { keys[e.code] = false; });
window.addEventListener('blur', () => {
  for (const k in keys) keys[k] = false;
  setTouchBtn('left', false);
  setTouchBtn('right', false);
  setTouchBtn('jump', false);
  setTouchBtn('down', false);
});
canvas.addEventListener('click', () => {
  initAudio();
  if (state === 'menu') {
    if (!(window.PK && PK.uiLock)) startGame();
  } else if (state === 'paused') state = 'playing';
  else if (state === 'gameover' || state === 'win') {
    if (window.PK && PK.uiLock) return;
    if (window.PK && PK.online) cycleSpectate();
    else startGame();
  }
});

const touch = { left: false, right: false, jump: false, down: false };
const touchMode = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
const touchUIEl = document.getElementById('touch-ui');

function setTouchBtn(name, on) {
  if (touch[name] === on) return;
  touch[name] = on;
  if (on) {
    if (name === 'jump') pressed.TouchJump = true;
    initAudio();
  }
  if (touchUIEl) {
    const b = touchUIEl.querySelector('[data-t="' + name + '"]');
    if (b) b.classList.toggle('on', on);
  }
}

function refreshTouchUI() {
  if (!touchMode || !touchUIEl) return;
  const want = state !== 'menu' && state !== 'gameover' && state !== 'win';
  touchUIEl.classList.toggle('on', want);
  touchUIEl.classList.toggle('fly', !!adminFly);
  if (!want) {
    setTouchBtn('left', false);
    setTouchBtn('right', false);
    setTouchBtn('jump', false);
    setTouchBtn('down', false);
  } else if (!adminFly && touch.down) {
    setTouchBtn('down', false);
  }
}

if (touchMode) {
  document.body.classList.add('touch');
  if (touchUIEl) {
    touchUIEl.querySelectorAll('.tbtn').forEach(btn => {
      const name = btn.getAttribute('data-t');
      btn.addEventListener('pointerdown', e => {
        e.preventDefault();
        try { btn.setPointerCapture(e.pointerId); } catch (err) {}
        setTouchBtn(name, true);
      });
      const release = () => setTouchBtn(name, false);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('lostpointercapture', release);
      btn.addEventListener('contextmenu', e => e.preventDefault());
    });
  }
}

function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
function overlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}
function inset(e, m) { return { x: e.x + m, y: e.y + m, w: e.w - m * 2, h: e.h - m * 2 }; }

function label(str, x, y, size, color, align) {
  ctx.font = 'bold ' + size + 'px monospace';
  ctx.textAlign = align || 'left';
  ctx.fillStyle = '#0b1020';
  const o = Math.max(2, Math.round(size / 10));
  ctx.fillText(str, x + o, y + o);
  ctx.fillStyle = color || '#ffffff';
  ctx.fillText(str, x, y);
}

function bigTitle(str, x, y, size, fill, align) {
  ctx.font = 'bold ' + size + 'px monospace';
  ctx.textAlign = align || 'center';
  const offs = [[-4, 0], [4, 0], [0, -4], [0, 4], [-3, -3], [3, 3], [3, -3], [-3, 3]];
  ctx.fillStyle = '#151d38';
  for (const o of offs) ctx.fillText(str, x + o[0], y + o[1]);
  ctx.fillStyle = fill;
  ctx.fillText(str, x, y);
}

class LevelBuilder {
  constructor(w, name, pal) {
    this.w = w;
    this.name = name;
    this.pal = pal;
    this.grid = [];
    for (let y = 0; y < ROWS; y++) this.grid.push(new Array(w).fill(S_EMPTY));
    this.coins = [];
    this.enemies = [];
    this.spikes = [];
    this.start = { col: 2, row: 14 };
    this.flag = { col: w - 3, row: 14 };
  }
  set(col, row, v) {
    if (col >= 0 && col < this.w && row >= 0 && row < ROWS) this.grid[row][col] = v;
    return this;
  }
  ground(a, b, top) {
    if (top === undefined) top = 14;
    for (let c = a; c <= b; c++) for (let r = top; r < ROWS; r++) this.set(c, r, S_GROUND);
    return this;
  }
  plat(a, b, row) {
    for (let c = a; c <= b; c++) this.set(c, row, S_BRICK);
    return this;
  }
  oneway(a, b, row) {
    for (let c = a; c <= b; c++) this.set(c, row, S_ONEWAY);
    return this;
  }
  coin(col, row) { this.coins.push({ col: col, row: row }); return this; }
  coinRow(a, b, row) { for (let c = a; c <= b; c++) this.coin(c, row); return this; }
  enemy(col, row, dir) {
    if (row === undefined) row = 14;
    if (dir === undefined) dir = this.enemies.length % 2 === 0 ? -1 : 1;
    this.enemies.push({ col: col, row: row, dir: dir });
    return this;
  }
  spike(a, b, row) {
    if (row === undefined) row = 14;
    for (let c = a; c <= b; c++) this.spikes.push({ col: c, row: row });
    return this;
  }
  player(col, row) {
    if (row === undefined) row = 14;
    this.start = { col: col, row: row };
    return this;
  }
  goal(col, row) {
    if (row === undefined) row = 14;
    this.flag = { col: col, row: row };
    return this;
  }
}

function levelOne() {
  const L = new LevelBuilder(112, 'Bosque Soleado', 0);
  L.player(2).goal(109);
  L.ground(0, 22).ground(25, 46).ground(50, 68).ground(72, 90).ground(94, 111);
  L.plat(30, 34, 11);
  L.coinRow(31, 33, 9);
  L.oneway(55, 59, 11);
  L.coinRow(56, 58, 9);
  L.plat(76, 80, 11);
  L.coinRow(77, 79, 9);
  L.coinRow(5, 9, 12);
  L.coin(23, 12); L.coin(24, 12);
  L.coin(47, 12); L.coin(48, 11); L.coin(49, 12);
  L.coin(69, 12); L.coin(70, 11); L.coin(71, 12);
  L.coin(91, 12); L.coin(92, 11); L.coin(93, 12);
  L.coinRow(60, 64, 10);
  L.spike(39, 40);
  L.enemy(12).enemy(35).enemy(62).enemy(84).enemy(100);
  return L;
}

function levelTwo() {
  const L = new LevelBuilder(126, 'Colinas del Atardecer', 1);
  L.player(2).goal(123);
  L.ground(0, 16).ground(20, 36).ground(41, 54).ground(59, 70).ground(75, 92).ground(97, 110).ground(114, 125);
  L.oneway(38, 39, 11); L.coin(38, 9); L.coin(39, 9);
  L.oneway(56, 57, 11); L.coin(56, 9); L.coin(57, 9);
  L.oneway(72, 73, 11); L.coin(72, 9); L.coin(73, 9);
  L.oneway(94, 95, 11); L.coin(94, 9); L.coin(95, 9);
  L.plat(44, 50, 11);
  L.plat(46, 48, 8);
  L.coinRow(46, 48, 7);
  L.plat(101, 105, 11);
  L.coinRow(102, 104, 9);
  L.coin(17, 12); L.coin(18, 11); L.coin(19, 12);
  L.coin(111, 12); L.coin(112, 11); L.coin(113, 12);
  L.coinRow(21, 24, 12);
  L.spike(64, 66);
  L.spike(84, 85);
  L.enemy(8).enemy(26).enemy(48, 11).enemy(61).enemy(80).enemy(104).enemy(118);
  return L;
}

function levelThree() {
  const L = new LevelBuilder(138, 'La Cumbre', 2);
  L.player(2).goal(135);
  L.ground(0, 14).ground(18, 30).ground(34, 44).ground(49, 58).ground(63, 74).ground(79, 88).ground(93, 104).ground(109, 120).ground(124, 137);
  L.oneway(46, 47, 11); L.coin(46, 9); L.coin(47, 9);
  L.oneway(60, 61, 11); L.coin(60, 9); L.coin(61, 9);
  L.oneway(76, 77, 11); L.coin(76, 9); L.coin(77, 9);
  L.oneway(90, 91, 11); L.coin(90, 9); L.coin(91, 9);
  L.oneway(106, 107, 11); L.coin(106, 9); L.coin(107, 9);
  L.plat(66, 70, 11);
  L.plat(67, 69, 8);
  L.coinRow(67, 69, 7);
  L.plat(96, 100, 11);
  L.coinRow(97, 99, 9);
  L.coin(15, 12); L.coin(16, 11); L.coin(17, 12);
  L.coin(31, 12); L.coin(32, 11); L.coin(33, 12);
  L.coin(121, 12); L.coin(122, 11); L.coin(123, 12);
  L.spike(37, 38);
  L.spike(53, 55);
  L.spike(114, 116);
  L.spike(130, 131);
  L.enemy(8).enemy(24).enemy(41).enemy(56).enemy(71).enemy(84).enemy(99).enemy(117).enemy(133);
  return L;
}

const LEVELS = [levelOne(), levelTwo(), levelThree()];

let state = 'menu';
let levelIndex = 0;
let level = null;
let score = 0;
let lives = 3;
let best = 0;
let frame = 0;
let stateTimer = 0;
let shake = 0;
let levelT0 = 0;
let spectate = null;
let spectLastCycle = 0;
let particles = [];
let camera = { x: 0, y: 0 };
let adminFly = false;
let adminLives = false;

const player = {
  x: 0, y: 0, w: 22, h: 30,
  vx: 0, vy: 0,
  onGround: false, coyote: 0, buffer: 0,
  face: 1, run: 0, inv: 0,
  prevBottom: 0
};

function loadBest() {
  try {
    const v = window.localStorage && window.localStorage.getItem('pixelpark_best');
    return v ? (+v || 0) : 0;
  } catch (e) { return 0; }
}

function saveBest() {
  if (score > best) {
    best = score;
    try { if (window.localStorage) window.localStorage.setItem('pixelpark_best', String(best)); } catch (e) {}
  }
}

best = loadBest();

function buildLevel() {
  const def = LEVELS[levelIndex];
  level = {
    w: def.w,
    name: def.name,
    pal: def.pal,
    grid: def.grid.map(r => r.slice()),
    coins: def.coins.map(c => ({
      x: c.col * TILE + 8,
      y: c.row * TILE + 8,
      w: 16, h: 16,
      taken: false,
      ph: (c.col * 13 + c.row * 7) % 63
    })),
    enemies: def.enemies.map((e, i) => ({
      id: i,
      x: e.col * TILE + 3,
      y: e.row * TILE - 28,
      w: 26, h: 28,
      dir: e.dir, vx: 0, vy: 0,
      onGround: false, prevBottom: 0,
      dead: false, deadT: 0,
      anim: i * 11
    })),
    spikes: def.spikes.map(s => ({
      x: s.col * TILE + 4,
      y: s.row * TILE - 16,
      w: TILE - 8, h: 16
    })),
    start: { x: def.start.col * TILE + 5, y: def.start.row * TILE - 30 },
    flag: { x: def.flag.col * TILE, y: def.flag.row * TILE - 96, w: 36, h: 96 }
  };
  player.x = level.start.x;
  player.y = level.start.y;
  player.vx = 0;
  player.vy = 0;
  player.onGround = false;
  player.coyote = 0;
  player.buffer = 0;
  player.face = 1;
  player.run = 0;
  player.inv = 90;
  particles = [];
  camera.x = clamp(player.x + 11 - VW / 2, 0, Math.max(0, level.w * TILE - VW));
  camera.y = 0;
  levelT0 = Date.now();
}

function startGame() {
  score = 0;
  lives = 3;
  levelIndex = 0;
  buildLevel();
  state = 'playing';
  if (window.PKNet) PKNet.hideAll();
  tone(520, 0.1, 'square', 0.045);
}

function toMenu() {
  levelIndex = 0;
  buildLevel();
  state = 'menu';
}

function tileAt(col, row) {
  if (col < 0 || col >= level.w) return S_BRICK;
  if (row < 0 || row >= ROWS) return S_EMPTY;
  return level.grid[row][col];
}

function isSolid(t) { return t === S_GROUND || t === S_BRICK; }

function moveX(e) {
  e.x += e.vx;
  if (e.vx === 0) return false;
  const top = Math.floor(e.y / TILE);
  const bot = Math.floor((e.y + e.h - 0.01) / TILE);
  if (e.vx > 0) {
    const col = Math.floor((e.x + e.w - 0.01) / TILE);
    for (let r = top; r <= bot; r++) {
      if (isSolid(tileAt(col, r))) {
        e.x = col * TILE - e.w;
        e.vx = 0;
        return true;
      }
    }
  } else {
    const col = Math.floor(e.x / TILE);
    for (let r = top; r <= bot; r++) {
      if (isSolid(tileAt(col, r))) {
        e.x = (col + 1) * TILE;
        e.vx = 0;
        return true;
      }
    }
  }
  return false;
}

function moveY(e) {
  e.y += e.vy;
  let landed = false;
  const left = Math.floor(e.x / TILE);
  const right = Math.floor((e.x + e.w - 0.01) / TILE);
  if (e.vy > 0) {
    const row = Math.floor((e.y + e.h - 0.01) / TILE);
    for (let c = left; c <= right; c++) {
      const t = tileAt(c, row);
      const oneWay = t === S_ONEWAY && e.prevBottom <= row * TILE + 1;
      if (isSolid(t) || oneWay) {
        e.y = row * TILE - e.h;
        e.vy = 0;
        landed = true;
        break;
      }
    }
  } else if (e.vy < 0) {
    const row = Math.floor(e.y / TILE);
    for (let c = left; c <= right; c++) {
      if (isSolid(tileAt(c, row))) {
        e.y = (row + 1) * TILE;
        e.vy = 0;
        break;
      }
    }
  }
  e.onGround = landed;
  return landed;
}

function burst(x, y, colors, n, opt) {
  opt = opt || {};
  const r = rng((frame * 97 + particles.length * 31 + Math.round(x)) >>> 0);
  for (let i = 0; i < n; i++) {
    const life = (opt.life || 34) + r() * 22;
    particles.push({
      x: x, y: y,
      vx: (opt.vx !== undefined ? opt.vx : -3 + r() * 6),
      vy: opt.vy !== undefined ? opt.vy + r() * 2 : -5.5 + r() * 3,
      g: opt.g !== undefined ? opt.g : 0.24,
      life: life, max: life,
      c: colors[i % colors.length],
      s: (opt.s || 3) + Math.floor(r() * 3)
    });
  }
}

function updateParticles() {
  for (const p of particles) {
    p.x += p.vx;
    p.y += p.vy;
    p.vy += p.g;
    p.life--;
  }
  particles = particles.filter(p => p.life > 0);
}

function updatePlayer() {
  const left = keys.ArrowLeft || keys.KeyA || touch.left;
  const right = keys.ArrowRight || keys.KeyD || touch.right;
  const jumpHeld = keys.Space || keys.ArrowUp || keys.KeyW || touch.jump;
  const jumpPressed = pressed.Space || pressed.ArrowUp || pressed.KeyW || pressed.TouchJump;

  if (left && !right) {
    player.vx -= ACCEL;
    player.face = -1;
  } else if (right && !left) {
    player.vx += ACCEL;
    player.face = 1;
  } else {
    player.vx *= player.onGround ? FRIC_G : FRIC_A;
    if (Math.abs(player.vx) < 0.06) player.vx = 0;
  }
  player.vx = clamp(player.vx, -MAX_SPEED, MAX_SPEED);

  if (adminFly) {
    const up = keys.Space || keys.ArrowUp || keys.KeyW || touch.jump;
    const down = keys.ArrowDown || keys.KeyS || touch.down;
    player.vy = up ? -4.3 : down ? 4.3 : player.vy * 0.85;
    player.prevBottom = player.y + player.h;
    moveX(player);
    moveY(player);
    player.run += Math.abs(player.vx);
    if (player.inv > 0) player.inv--;
    return;
  }

  if (player.onGround) player.coyote = COYOTE;
  else player.coyote--;
  if (jumpPressed) player.buffer = BUFFER;
  else player.buffer--;

  if (player.buffer > 0 && player.coyote > 0) {
    player.vy = JUMP_V;
    player.buffer = 0;
    player.coyote = 0;
    sndJump();
    burst(player.x + 11, player.y + 30, ['#dff5df', '#a8d8f0'], 5, { vy: -2, g: 0.16, s: 2 });
  }
  if (!jumpHeld && player.vy < -7) player.vy = -7;

  player.vy = Math.min(player.vy + GRAVITY, MAX_FALL);
  player.prevBottom = player.y + player.h;
  moveX(player);
  moveY(player);

  player.run += Math.abs(player.vx);
  if (player.inv > 0) player.inv--;
}

function updateEnemies() {
  for (const en of level.enemies) {
    if (en.dead) {
      en.deadT++;
      continue;
    }
    en.vx = en.dir * ENEMY_SPD;
    if (moveX(en)) en.dir *= -1;
    en.prevBottom = en.y + en.h;
    en.vy = Math.min(en.vy + GRAVITY, MAX_FALL);
    moveY(en);
    if (en.onGround) {
      const ahead = en.dir > 0
        ? Math.floor((en.x + en.w + 2) / TILE)
        : Math.floor((en.x - 2) / TILE);
      const below = Math.floor((en.y + en.h + 4) / TILE);
      if (tileAt(ahead, below) === S_EMPTY) en.dir *= -1;
    }
    if (en.y > ROWS * TILE + 80) {
      en.dead = true;
      en.deadT = 1000;
      continue;
    }
    if (state === 'playing' && player.inv <= 0 && overlap(inset(player, 3), en)) {
      if (player.vy > 0 && player.prevBottom <= en.y + 12) {
        en.dead = true;
        en.deadT = 0;
        player.vy = STOMP_V;
        score += 20;
        shake = 5;
        sndStomp();
        burst(en.x + 13, en.y + 14, ['#5cb85c', '#dff5df', '#2e6b34'], 10);
      } else {
        die();
      }
    }
  }
  level.enemies = level.enemies.filter(e => !e.dead || (e.deadT <= 24 && e.deadT < 900));
}

function updateCoins() {
  const box = inset(player, 4);
  for (const c of level.coins) {
    if (!c.taken && overlap(box, c)) {
      c.taken = true;
      score += 10;
      sndCoin();
      burst(c.x + 8, c.y + 8, ['#ffcf3f', '#fff3b0', '#f09a1e'], 8, { g: 0.12, life: 26, s: 2 });
    }
  }
}

function die() {
  if (state !== 'playing') return;
  if (!adminLives) lives--;
  state = 'dying';
  stateTimer = 55;
  player.vy = -8.5;
  player.vx = 0;
  shake = 8;
  sndHurt();
  burst(player.x + 11, player.y + 15, ['#e0473a', '#ffd7ad', '#3b78e0', '#ffffff'], 16);
}

function clearLevel() {
  if (state !== 'playing') return;
  state = 'levelclear';
  stateTimer = 110;
  score += 150;
  shake = 4;
  sndClear();
  if (window.PKNet) PKNet.finish(levelIndex + 1, Math.round(Date.now() - levelT0), score);
  const fx = level.flag.x + 14;
  const fy = level.flag.y + 20;
  burst(fx, fy, ['#ffcf3f', '#ff5a5a', '#5cb85c', '#3b78e0', '#ffffff'], 26, { g: 0.14, life: 70, s: 4 });
}

function updateCamera() {
  const tx = clamp(player.x + player.w / 2 - VW / 2, 0, Math.max(0, level.w * TILE - VW));
  camera.x += (tx - camera.x) * 0.12;
}

function updatePlaying() {
  updatePlayer();
  updateEnemies();
  if (state !== 'playing') {
    updateParticles();
    return;
  }
  updateCoins();
  for (const s of level.spikes) {
    if (player.inv <= 0 && overlap(inset(player, 4), s)) {
      die();
      break;
    }
  }
  if (state === 'playing' && player.y > ROWS * TILE + 48) die();
  if (state === 'playing' && overlap(player, level.flag)) clearLevel();
  if (player.inv === 0 && state === 'playing') player.inv = 0;
  updateParticles();
  updateCamera();
}

function updateDying() {
  player.vy = Math.min(player.vy + GRAVITY, MAX_FALL);
  player.y += player.vy;
  updateParticles();
  stateTimer--;
  if (stateTimer <= 0) {
    if (lives <= 0) {
      state = 'gameover';
      saveBest();
      sndLose();
    } else {
      buildLevel();
      state = 'playing';
    }
  }
}

function updateClear() {
  updateParticles();
  stateTimer--;
  if (stateTimer <= 0) {
    if (levelIndex < LEVELS.length - 1) {
      levelIndex++;
      buildLevel();
      state = 'playing';
    } else {
      state = 'win';
      saveBest();
      sndWin();
      if (window.PKNet) PKNet.showScore();
    }
  }
}

function updateSpectate() {
  const R = (window.PK && PK.remotes) || null;
  if (!R) { spectate = null; return; }
  const alive = Object.keys(R).filter(id => R[id].alive);
  if (!alive.length) { spectate = null; return; }
  if (!spectate || alive.indexOf(spectate) < 0) {
    spectate = alive[0];
    spectLastCycle = frame;
  } else if (frame - spectLastCycle >= 300) {
    spectLastCycle = frame;
    spectate = alive[(alive.indexOf(spectate) + 1) % alive.length];
  }
  const t = R[spectate];
  if (t.level !== levelIndex + 1) {
    levelIndex = t.level - 1;
    buildLevel();
  }
  applySpectateWorld(t);
  const tx = clamp(t.x - VW / 2, 0, Math.max(0, level.w * TILE - VW));
  camera.x += (tx - camera.x) * 0.12;
}

function applySpectateWorld(t) {
  if (!t) return;
  if (typeof t.wc === 'string') {
    const n = Math.min(level.coins.length, t.wc.length);
    for (let i = 0; i < n; i++) level.coins[i].taken = t.wc[i] === '1';
  }
  if (!Array.isArray(t.we)) return;
  for (const en of level.enemies) en.gone = true;
  for (const w of t.we) {
    const en = level.enemies.find(e => e.id === w[0]);
    if (!en) continue;
    en.gone = false;
    en.dir = w[3];
    en.dead = !!w[4];
    if (en.wtx === undefined) {
      en.x = w[1];
      en.y = w[2];
    }
    en.wtx = w[1];
    en.wty = w[2];
  }
  for (const en of level.enemies) {
    if (en.gone || en.wtx === undefined) continue;
    en.x += (en.wtx - en.x) * 0.3;
    en.y += (en.wty - en.y) * 0.3;
  }
}

function cycleSpectate() {
  const R = (window.PK && PK.remotes) || null;
  if (!R) return;
  const alive = Object.keys(R).filter(id => R[id].alive);
  if (alive.length < 2) return;
  spectate = alive[(alive.indexOf(spectate) + 1) % alive.length];
  spectLastCycle = frame;
}

function isSpectating() {
  return !!spectate && (state === 'win' || state === 'gameover');
}

function endScreenInput() {
  const uiL = !!(window.PK && PK.uiLock);
  if (uiL) return;
  const online = !!(window.PK && PK.online);
  if (pressed.Enter || pressed.Space) {
    if (online) cycleSpectate();
    else startGame();
  } else if (pressed.Escape) {
    toMenu();
    if (window.PKNet) PKNet.showMenu();
  }
}

function drawSpectateBar() {
  if (!isSpectating()) return;
  ctx.fillStyle = 'rgba(8,12,24,0.78)';
  ctx.fillRect(0, VH - 28, VW, 28);
  ctx.fillStyle = '#3a4a78';
  ctx.fillRect(0, VH - 28, VW, 2);
  const R = window.PK && PK.remotes;
  const r = R && R[spectate];
  label('ESPECTANDO A ' + (r && r.name ? r.name : '?'), 12, VH - 21, 14, '#c8d6f0');
  if (r) {
    label('PUNTOS ' + (r.score || 0) + ' · MONEDAS ' + (r.coins || 0) + '/' + (r.coinsMax || 0) +
      ' · ENEMIGOS ' + (r.enemies || 0) + ' · VIDAS ' + (r.lives || 0),
      VW / 2, VH - 21, 14, '#ffd23f', 'center');
  }
  label('ENTER/CLIC: CAMBIAR   ESC: SALA', VW - 12, VH - 21, 14, '#9fb3d9', 'right');
}

let cornerBtnEl = null;
let cornerCodeBtnEl = null;

function updateCornerBtn() {
  if (!cornerBtnEl) cornerBtnEl = document.getElementById('btn-corner-menu');
  if (!cornerCodeBtnEl) cornerCodeBtnEl = document.getElementById('btn-corner-code');
  const b = cornerBtnEl;
  if (b && b.classList) b.classList.toggle('hidden', state === 'menu' || !!(window.PK && PK.online));
  const c = cornerCodeBtnEl;
  if (c && c.classList) c.classList.toggle('hidden', state === 'menu');
}

function update() {
  frame++;
  if (state === 'menu') {
    camera.x += 0.7;
    const maxCam = Math.max(0, level.w * TILE - VW);
    if (camera.x > maxCam) camera.x = 0;
    updateParticles();
    if (pressed.Enter || pressed.Space) {
      if (!(window.PK && PK.uiLock)) startGame();
    }
  } else if (state === 'playing') {
    if (pressed.KeyP || pressed.Escape) state = 'paused';
    else updatePlaying();
  } else if (state === 'paused') {
    if (pressed.KeyP || pressed.Escape || pressed.Enter) state = 'playing';
  } else if (state === 'dying') {
    updateDying();
  } else if (state === 'levelclear') {
    updateClear();
  } else if (state === 'gameover') {
    updateParticles();
    updateSpectate();
    endScreenInput();
  } else if (state === 'win') {
    updateParticles();
    updateSpectate();
    endScreenInput();
  }
  if (shake > 0) {
    shake *= 0.85;
    if (shake < 0.4) shake = 0;
  }
  pressed = {};
}

function drawCloud(cx, cy, s, color) {
  const w = 64 * s;
  const h = 20 * s;
  ctx.fillStyle = color;
  ctx.fillRect(cx, cy, w, h);
  ctx.fillRect(cx + w * 0.15, cy - h * 0.6, w * 0.34, h * 0.7);
  ctx.fillRect(cx + w * 0.52, cy - h * 0.9, w * 0.3, h);
  ctx.fillStyle = 'rgba(0,0,0,0.07)';
  ctx.fillRect(cx, cy + h - 4 * s, w, 4 * s);
}

function drawSky(pal) {
  const bands = SKY_BANDS[pal];
  for (let i = 0; i < 16; i++) {
    ctx.fillStyle = bands[i];
    ctx.fillRect(0, i * TILE, VW, TILE);
  }
  if (PAL[pal].stars) {
    for (const s of STARS) {
      const sx = s.x - camera.x * 0.12;
      if (sx < -6 || sx > VW + 6) continue;
      const tw = 0.55 + 0.45 * Math.sin((frame + s.b * 90) * 0.05);
      ctx.fillStyle = 'rgba(255,255,240,' + tw.toFixed(2) + ')';
      ctx.fillRect(Math.round(sx), Math.round(s.y), s.s, s.s);
    }
    const mx = VW - 160 - camera.x * 0.05;
    ctx.fillStyle = '#f4f0d8';
    ctx.beginPath();
    ctx.arc(mx, 76, 30, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = SKY_BANDS[pal][2];
    ctx.beginPath();
    ctx.arc(mx - 13, 68, 26, 0, Math.PI * 2);
    ctx.fill();
  } else {
    const sx = 190 - camera.x * 0.06;
    ctx.fillStyle = pal === 1 ? '#ffe066' : '#fff3a8';
    ctx.beginPath();
    ctx.arc(sx, 82, 36, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHillLayer(color, parallax, base, amp, freq, phase) {
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(-4, VH);
  for (let sx = -4; sx <= VW + 4; sx += 12) {
    const wx = (sx + camera.x * parallax) * freq + phase;
    const y = base - amp * (0.5 + 0.5 * Math.sin(wx)) - amp * 0.35 * Math.sin(wx * 2.3);
    ctx.lineTo(sx, y);
  }
  ctx.lineTo(VW + 4, VH);
  ctx.closePath();
  ctx.fill();
}

function drawBackground() {
  const pal = LEVELS[levelIndex].pal;
  drawSky(pal);
  drawHillLayer(PAL[pal].hillFar, 0.25, 400, 70, 0.004, 1.2);
  drawHillLayer(PAL[pal].hillNear, 0.5, 470, 56, 0.0055, 4.7);
  for (const c of CLOUDS[pal]) {
    const sx = c.x - camera.x * 0.35;
    if (sx < -160 || sx > VW + 60) continue;
    drawCloud(sx, c.y, c.s, PAL[pal].cloud);
  }
}

function drawGroundTile(x, y, c, r, pal) {
  const p = PAL[pal];
  ctx.fillStyle = p.dirt;
  ctx.fillRect(x, y, TILE, TILE);
  if ((c * 7 + r * 31) % 4 === 0) {
    ctx.fillStyle = p.dirtDark;
    ctx.fillRect(x + 7, y + 14, 5, 5);
  }
  if ((c * 5 + r * 17) % 5 === 0) {
    ctx.fillStyle = p.dirtLight;
    ctx.fillRect(x + 19, y + 22, 4, 4);
  }
  const above = r > 0 ? level.grid[r - 1][c] : S_GROUND;
  if (above === S_EMPTY) {
    ctx.fillStyle = p.grass;
    ctx.fillRect(x, y, TILE, 11);
    ctx.fillStyle = p.grassLight;
    ctx.fillRect(x, y, TILE, 5);
    if ((c * 3 + r) % 3 === 0) {
      ctx.fillStyle = p.grass;
      ctx.fillRect(x + 5, y + 11, 4, 4);
      ctx.fillRect(x + 20, y + 11, 3, 3);
    }
  }
  const right = c + 1 < level.w ? level.grid[r][c + 1] : S_GROUND;
  if (right === S_EMPTY) {
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(x + TILE - 3, y, 3, TILE);
  }
  const below = r + 1 < ROWS ? level.grid[r + 1][c] : S_GROUND;
  if (below === S_EMPTY && above !== S_EMPTY) {
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(x, y + TILE - 3, TILE, 3);
  }
}

function drawBrickTile(x, y, c, r, pal) {
  const p = PAL[pal];
  ctx.fillStyle = p.brick;
  ctx.fillRect(x, y, TILE, TILE);
  ctx.fillStyle = p.brickDark;
  for (let by = 0; by < TILE; by += 8) ctx.fillRect(x, y + by, TILE, 2);
  const band = (y / 8) % 2;
  for (let by = 0; by < TILE; by += 8) {
    const off = ((by / 8 + c) % 2 === 0) ? 10 : 22;
    ctx.fillRect(x + off, y + by, 2, 6);
  }
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(x, y + 2, TILE, 2);
  ctx.fillStyle = 'rgba(0,0,0,0.18)';
  ctx.fillRect(x, y + TILE - 3, TILE, 3);
}

function drawOnewayTile(x, y, pal) {
  const p = PAL[pal];
  ctx.fillStyle = p.plank;
  ctx.fillRect(x, y + 4, TILE, 11);
  ctx.fillStyle = p.plankLight;
  ctx.fillRect(x, y + 4, TILE, 3);
  ctx.fillStyle = 'rgba(0,0,0,0.25)';
  ctx.fillRect(x, y + 13, TILE, 2);
  ctx.fillStyle = p.plank;
  ctx.fillRect(x + 5, y + 15, 5, 6);
  ctx.fillRect(x + 22, y + 15, 5, 6);
}

function drawTiles() {
  const pal = level.pal;
  const c0 = Math.max(0, Math.floor(camera.x / TILE));
  const c1 = Math.min(level.w - 1, Math.floor((camera.x + VW) / TILE));
  for (let c = c0; c <= c1; c++) {
    for (let r = 0; r < ROWS; r++) {
      const t = level.grid[r][c];
      if (t === S_EMPTY) continue;
      const x = Math.round(c * TILE - camera.x);
      const y = r * TILE;
      if (t === S_GROUND) drawGroundTile(x, y, c, r, pal);
      else if (t === S_BRICK) drawBrickTile(x, y, c, r, pal);
      else drawOnewayTile(x, y, pal);
    }
  }
}

function drawSpikes() {
  for (const s of level.spikes) {
    const x = Math.round(s.x - camera.x);
    if (x < -40 || x > VW + 40) continue;
    const y = s.y;
    ctx.fillStyle = '#c8d0e0';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(x + i * 8, y + 16);
      ctx.lineTo(x + i * 8 + 4, y);
      ctx.lineTo(x + i * 8 + 8, y + 16);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#8b95ad';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath();
      ctx.moveTo(x + i * 8 + 4, y);
      ctx.lineTo(x + i * 8 + 8, y + 16);
      ctx.lineTo(x + i * 8 + 5, y + 16);
      ctx.closePath();
      ctx.fill();
    }
    ctx.fillStyle = '#5a6478';
    ctx.fillRect(x, y + 15, 24, 3);
  }
}

function drawCoins() {
  for (const c of level.coins) {
    if (c.taken) continue;
    const x = Math.round(c.x - camera.x);
    if (x < -30 || x > VW + 30) continue;
    const bob = Math.sin((frame + c.ph * 3) * 0.07) * 3;
    const wob = 0.35 + 0.65 * Math.abs(Math.sin((frame + c.ph * 3) * 0.05));
    const cy = Math.round(c.y + bob);
    ctx.save();
    ctx.translate(x + 8, cy + 8);
    ctx.scale(wob, 1);
    ctx.fillStyle = '#c98b12';
    ctx.beginPath();
    ctx.arc(0, 0, 8, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffcf3f';
    ctx.beginPath();
    ctx.arc(0, 0, 6.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#fff3b0';
    ctx.fillRect(-2, -4, 3, 5);
    ctx.restore();
  }
}

function drawFlag() {
  const f = level.flag;
  const x = Math.round(f.x - camera.x);
  if (x < -60 || x > VW + 60) return;
  const y = f.y;
  ctx.fillStyle = '#8b95ad';
  ctx.fillRect(x + 4, y, 5, 96);
  ctx.fillStyle = '#c8d0e0';
  ctx.fillRect(x + 4, y, 2, 96);
  ctx.fillStyle = '#ffd23f';
  ctx.beginPath();
  ctx.arc(x + 6.5, y - 3, 6, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#5a6478';
  ctx.fillRect(x, y + 93, 14, 3);
  const wave = Math.sin(frame * 0.09) * 4;
  const reached = state === 'levelclear';
  ctx.fillStyle = reached ? '#5cb85c' : '#ff5a5a';
  ctx.beginPath();
  ctx.moveTo(x + 9, y + 5);
  ctx.lineTo(x + 40 + wave, y + 13 + wave * 0.4);
  ctx.lineTo(x + 9, y + 24);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.75)';
  ctx.fillRect(x + 14, y + 10, 6, 6);
}

function drawEnemies() {
  for (const en of level.enemies) {
    if (en.gone) continue;
    const x = Math.round(en.x - camera.x);
    if (x < -50 || x > VW + 50) continue;
    if (en.dead && en.deadT < 900) {
      const squashed = Math.min(1, en.deadT / 4);
      const h = 10;
      const y = Math.round(en.y + en.h - h);
      ctx.fillStyle = '#2e6b34';
      ctx.fillRect(x, y, 26, h);
      ctx.fillStyle = '#5cb85c';
      ctx.fillRect(x + 2, y + 1, 22, h - 3);
      ctx.fillStyle = '#1d4a24';
      ctx.fillRect(x + 6, y + 3, 5, 2);
      ctx.fillRect(x + 15, y + 3, 5, 2);
      continue;
    }
    const y = Math.round(en.y);
    const step = Math.floor((frame + en.anim) * 0.16) % 2;
    ctx.fillStyle = '#2e6b34';
    ctx.fillRect(x + 1, y + 5, 24, 19);
    ctx.fillRect(x + 5, y + 1, 16, 7);
    ctx.fillStyle = '#5cb85c';
    ctx.fillRect(x + 3, y + 7, 20, 14);
    ctx.fillRect(x + 7, y + 3, 12, 6);
    ctx.fillStyle = '#7ed67e';
    ctx.fillRect(x + 7, y + 15, 12, 6);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x + 5, y + 7, 6, 6);
    ctx.fillRect(x + 15, y + 7, 6, 6);
    ctx.fillStyle = '#1d2430';
    const look = en.dir > 0 ? 2 : -1;
    ctx.fillRect(x + 5 + look + 1, y + 9, 3, 3);
    ctx.fillRect(x + 15 + look + 1, y + 9, 3, 3);
    ctx.fillStyle = '#2e6b34';
    if (step === 0) {
      ctx.fillRect(x + 2, y + 24, 9, 4);
      ctx.fillRect(x + 15, y + 24, 9, 4);
    } else {
      ctx.fillRect(x + 4, y + 24, 9, 4);
      ctx.fillRect(x + 13, y + 24, 9, 4);
    }
  }
}

function shade(hex, f) {
  const n = parseInt(hex.slice(1), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return 'rgb(' + r + ',' + g + ',' + b + ')';
}

function drawCharacter(x, y, face, leg, pal) {
  ctx.save();
  if (face < 0) {
    ctx.translate(x + 22, y);
    ctx.scale(-1, 1);
  } else {
    ctx.translate(x, y);
  }

  ctx.fillStyle = pal.cap;
  ctx.fillRect(2, 1, 18, 6);
  ctx.fillRect(15, 6, 7, 3);
  ctx.fillStyle = shade(pal.cap, 0.72);
  ctx.fillRect(15, 7, 7, 2);
  ctx.fillStyle = '#ffd7ad';
  ctx.fillRect(3, 8, 16, 8);
  ctx.fillStyle = '#243044';
  ctx.fillRect(13, 10, 3, 4);
  ctx.fillStyle = '#e8b07a';
  ctx.fillRect(14, 14, 5, 1);
  ctx.fillStyle = pal.shirt;
  ctx.fillRect(2, 16, 18, 9);
  ctx.fillStyle = shade(pal.shirt, 0.8);
  ctx.fillRect(2, 16, 4, 9);
  ctx.fillStyle = '#ffd7ad';
  ctx.fillRect(18, 17, 4, 6);
  ctx.fillStyle = '#2f3a56';
  ctx.fillRect(3, 25, 16, 4);

  if (leg === 2) {
    ctx.fillStyle = '#2f3a56';
    ctx.fillRect(4, 26, 6, 3);
    ctx.fillRect(12, 26, 6, 3);
    ctx.fillStyle = '#20242e';
    ctx.fillRect(3, 28, 7, 2);
    ctx.fillRect(12, 28, 7, 2);
  } else if (leg === 1) {
    ctx.fillStyle = '#2f3a56';
    ctx.fillRect(2, 26, 6, 3);
    ctx.fillRect(14, 26, 5, 3);
    ctx.fillStyle = '#20242e';
    ctx.fillRect(1, 28, 8, 2);
    ctx.fillRect(14, 28, 6, 2);
  } else if (leg === 3) {
    ctx.fillStyle = '#2f3a56';
    ctx.fillRect(4, 26, 5, 3);
    ctx.fillRect(13, 26, 6, 3);
    ctx.fillStyle = '#20242e';
    ctx.fillRect(4, 28, 6, 2);
    ctx.fillRect(13, 28, 8, 2);
  } else {
    ctx.fillStyle = '#2f3a56';
    ctx.fillRect(4, 26, 5, 3);
    ctx.fillRect(13, 26, 5, 3);
    ctx.fillStyle = '#20242e';
    ctx.fillRect(4, 28, 5, 2);
    ctx.fillRect(13, 28, 5, 2);
  }
  ctx.restore();
}

function drawPlayer() {
  if (player.inv > 0 && state === 'playing' && frame % 8 < 4) return;
  const x = Math.round(player.x - camera.x);
  const y = Math.round(player.y);
  const air = !player.onGround;
  const moving = Math.abs(player.vx) > 0.4;
  let leg = 0;
  if (air) leg = 2;
  else if (moving) leg = Math.floor(player.run * 0.13) % 2 === 0 ? 1 : 3;
  let pal = { cap: '#e0473a', shirt: '#3b78e0' };
  if (window.PK && PK.online && PK.me) {
    pal = { cap: PK.me.color, shirt: shade(PK.me.color, 0.5) };
  }
  drawCharacter(x, y, player.face, leg, pal);
}

function drawRemotes() {
  const R = window.PK && PK.remotes;
  if (!R) return;
  for (const id in R) {
    const r = R[id];
    if (!r.alive || r.level !== levelIndex + 1) continue;
    r.x += (r.tx - r.x) * 0.3;
    r.y += (r.ty - r.y) * 0.3;
    const x = Math.round(r.x - camera.x);
    const y = Math.round(r.y);
    if (x < -60 || x > VW + 60) continue;
    const leg = r.onGround ? (Math.floor((r.run || 0) * 0.13) % 2 === 0 ? 1 : 3) : 2;
    ctx.globalAlpha = 0.85;
    drawCharacter(x, y, r.face || 1, leg, { cap: r.color || '#ffffff', shirt: shade(r.color || '#ffffff', 0.5) });
    ctx.globalAlpha = 1;
    if (r.name) label(r.name, x + 11, y - 17, 12, '#ffffff', 'center');
  }
}

function drawParticles() {
  for (const p of particles) {
    const a = Math.max(0, Math.min(1, p.life / p.max));
    ctx.globalAlpha = a;
    ctx.fillStyle = p.c;
    ctx.fillRect(Math.round(p.x - camera.x), Math.round(p.y), p.s, p.s);
  }
  ctx.globalAlpha = 1;
}

function drawWorld() {
  drawTiles();
  drawSpikes();
  drawFlag();
  drawCoins();
  drawEnemies();
  if (!isSpectating()) drawPlayer();
  drawRemotes();
  drawParticles();
}

function drawHUD() {
  ctx.fillStyle = 'rgba(8,12,24,0.58)';
  ctx.fillRect(0, 0, VW, 42);
  ctx.fillStyle = 'rgba(255,255,255,0.12)';
  ctx.fillRect(0, 42, VW, 2);

  label('PUNTOS ' + score, 16, 11, 18, '#ffd23f');
  const taken = level.coins.filter(c => c.taken).length;
  label('MONEDAS ' + taken + '/' + level.coins.length, 180, 11, 18, '#ffcf3f');
  label('NIVEL ' + (levelIndex + 1) + '/3 · ' + level.name, VW / 2, 13, 16, '#ffffff', 'center');
  label('VIDAS ' + lives, VW - 16, 11, 18, '#ff8a80', 'right');
  label(muted ? 'M:SONIDO OFF' : 'M:SONIDO ON', VW - 118, 13, 16, '#9fb3d9', 'right');
}

function drawPanel(w, h) {
  const x = Math.round((VW - w) / 2);
  const y = Math.round((VH - h) / 2);
  ctx.fillStyle = 'rgba(8,12,24,0.86)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = '#1c2540';
  ctx.fillRect(x, y, w, 6);
  ctx.fillRect(x, y + h - 6, w, 6);
  ctx.fillRect(x, y, 6, h);
  ctx.fillRect(x + w - 6, y, 6, h);
  ctx.strokeStyle = '#3a4a78';
  ctx.lineWidth = 2;
  ctx.strokeRect(x + 10, y + 10, w - 20, h - 20);
}

function drawOverlay() {
  if (state === 'playing') return;
  const blink = frame % 70 < 46;

  if (state === 'paused') {
    ctx.fillStyle = 'rgba(8,12,24,0.55)';
    ctx.fillRect(0, 0, VW, VH);
    bigTitle('PAUSA', VW / 2, 190, 54, '#ffd23f');
    label('P o ENTER para continuar', VW / 2, 270, 22, '#ffffff', 'center');
    label('M para sonido', VW / 2, 304, 18, '#9fb3d9', 'center');
    return;
  }
  if (state === 'menu') {
    const locked = !!(window.PK && PK.uiLock);
    if (locked) {
      const g = ctx.createLinearGradient(0, 0, 0, 215);
      g.addColorStop(0, 'rgba(8,12,24,0.85)');
      g.addColorStop(1, 'rgba(8,12,24,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, VW, 215);
      const bob = Math.round(Math.sin(frame * 0.05) * 4);
      bigTitle('PIXEL PARK', VW / 2, 104 + bob, 66, '#ffd23f');
      label('PLATAFORMAS 2D · MULTIJUGADOR EN LÍNEA', VW / 2, 150 + bob, 18, '#c8d6f0', 'center');
      return;
    }
    ctx.fillStyle = 'rgba(8,12,24,0.42)';
    ctx.fillRect(0, 0, VW, VH);
    drawPanel(640, 330);
    bigTitle('PIXEL PARK', VW / 2, 108, 66, '#ffd23f');
    label('Un juego de plataformas', VW / 2, 190, 22, '#ffffff', 'center');
    label('Flechas / WASD  moverse      ESPACIO / W  saltar', VW / 2, 236, 18, '#c8d6f0', 'center');
    label('P  pausa      M  sonido', VW / 2, 264, 18, '#c8d6f0', 'center');
    label('Aplasta enemigos, recoge monedas y llega a la bandera', VW / 2, 300, 17, '#9fb3d9', 'center');
    const locked2 = !!(window.PK && PK.uiLock);
    if (blink && !locked2) label('PULSA ENTER O HAZ CLIC', VW / 2, 348, 26, '#5cb85c', 'center');
    if (best > 0 && !locked2) label('RECORD ' + best, VW / 2, 392, 18, '#ffcf3f', 'center');
    return;
  }
  if (state === 'levelclear') {
    ctx.fillStyle = 'rgba(8,12,24,0.35)';
    ctx.fillRect(0, 0, VW, VH);
    bigTitle('¡NIVEL COMPLETADO!', VW / 2, 200, 44, '#5cb85c');
    label('+150 PUNTOS   TOTAL ' + score, VW / 2, 268, 22, '#ffd23f', 'center');
    if (stateTimer < 70 && blink) {
      label(levelIndex < LEVELS.length - 1 ? 'SIGUIENTE NIVEL...' : 'FINAL...', VW / 2, 310, 20, '#ffffff', 'center');
    }
    return;
  }
  if (state === 'gameover') {
    if (window.PK && PK.online) return;
    ctx.fillStyle = 'rgba(40,6,10,0.55)';
    ctx.fillRect(0, 0, VW, VH);
    bigTitle('FIN DEL JUEGO', VW / 2, 180, 54, '#ff5a5a');
    label('PUNTUACION ' + score, VW / 2, 262, 26, '#ffd23f', 'center');
    label('RECORD ' + Math.max(best, score), VW / 2, 300, 20, '#ffffff', 'center');
    if (blink) label('ENTER O CLIC PARA REINTENTAR', VW / 2, 350, 22, '#ffffff', 'center');
    label('ESC para menu', VW / 2, 384, 17, '#9fb3d9', 'center');
    return;
  }
  if (state === 'win') {
    if (window.PK && PK.online) return;
    ctx.fillStyle = 'rgba(8,30,16,0.55)';
    ctx.fillRect(0, 0, VW, VH);
    bigTitle('¡GANASTE!', VW / 2, 150, 60, '#ffd23f');
    label('Has completado PixelPark', VW / 2, 236, 24, '#ffffff', 'center');
    label('PUNTUACION ' + score, VW / 2, 280, 26, '#5cb85c', 'center');
    label('RECORD ' + Math.max(best, score), VW / 2, 320, 20, '#ffffff', 'center');
    if (blink) label('ENTER O CLIC PARA JUGAR DE NUEVO', VW / 2, 372, 22, '#ffffff', 'center');
    label('ESC para menu', VW / 2, 406, 17, '#9fb3d9', 'center');
    return;
  }
}

function render() {
  drawBackground();
  const rx = shake > 0 ? Math.round((Math.random() * 2 - 1) * shake) : 0;
  const ry = shake > 0 ? Math.round((Math.random() * 2 - 1) * shake) : 0;
  ctx.save();
  ctx.translate(rx, ry);
  drawWorld();
  ctx.restore();
  if (state !== 'menu') drawHUD();
  else if (!(window.PK && PK.uiLock)) {
    ctx.fillStyle = 'rgba(8,12,24,0.5)';
    ctx.fillRect(0, 0, VW, 34);
    label('PIXEL PARK', 16, 8, 18, '#ffd23f');
    label('PLATAFORMAS', VW - 16, 8, 18, '#ffffff', 'right');
  }
  drawOverlay();
  drawSpectateBar();
  updateCornerBtn();
  refreshTouchUI();
}

let lastT = 0;
let acc = 0;

function loop(t) {
  if (!lastT) lastT = t;
  acc += Math.min(120, t - lastT);
  lastT = t;
  let steps = 0;
  while (acc >= STEP && steps < 5) {
    update();
    acc -= STEP;
    steps++;
  }
  if (steps === 5) acc = 0;
  render();
  requestAnimationFrame(loop);
}

buildLevel();
state = 'menu';
window.PKAdmin = {
  on: false,
  fly: false,
  lives: false,
  toggleFly: () => { adminFly = !adminFly; window.PKAdmin.fly = adminFly; },
  toggleLives: () => { adminLives = !adminLives; window.PKAdmin.lives = adminLives; },
  addPoints: () => { score += 100; }
};
window.PKGame = {
  start: startGame,
  toMenu: toMenu,
  getState: () => ({
    state: state,
    score: score,
    lives: lives,
    level: levelIndex + 1,
    coins: level.coins.filter(c => c.taken).length,
    coinsMax: level.coins.length,
    enemies: level.enemies.filter(e => !e.dead).length,
    world: {
      we: level.enemies.map(e => [e.id, Math.round(e.x), Math.round(e.y), e.dir, e.dead ? 1 : 0]),
      wc: level.coins.map(c => c.taken ? '1' : '0').join('')
    },
    x: player.x,
    y: player.y,
    vx: player.vx,
    vy: player.vy,
    face: player.face,
    run: player.run,
    onGround: player.onGround,
    alive: player.alive,
    elapsed: levelT0 ? Date.now() - levelT0 : 0
  })
};
requestAnimationFrame(loop);
