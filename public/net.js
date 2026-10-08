(function () {
  const $ = id => document.getElementById(id);
  const menuUi = $('menu-ui');
  const lobbyUi = $('lobby-ui');
  const scoreUi = $('score-ui');
  const resultsUi = $('results-ui');
  const resultsNote = $('results-note');
  const roomChip = $('room-chip');
  const statusEl = $('status');
  const offlineMsg = $('offline-msg');
  const adminUi = $('admin-ui');
  const adminLogin = $('admin-login');
  const adminPowers = $('admin-powers');
  const adminStatus = $('admin-status');
  let adminOn = false;

  const PK = window.PK = {
    uiLock: true,
    online: false,
    gameActive: false,
    won: false,
    done: false,
    inResults: false,
    scoreLocked: false,
    code: null,
    me: null,
    players: [],
    hostId: null,
    scoreboard: [],
    remotes: {}
  };

  const FB_SDK = 'https://www.gstatic.com/firebasejs/13.0.0/';
  const COLORS = ['#e0473a', '#3b78e0', '#5cb85c', '#ffd23f', '#b06bff', '#ff8a3d', '#37d0c0', '#ff6fae'];

  let db = null;
  let FBDB = null;
  let fbApp = null;
  let libLoading = false;
  let libQueue = [];
  let pendingAction = null;
  let actionBusy = false;

  let sendTimer = null;
  let statsAcc = 0;

  let connWatchStarted = false;
  let everConnected = false;
  let connCbQueue = [];
  let connTimeout = null;

  let infoCache = null;
  let lobbyCache = {};
  let rawState = {};
  let rawWorld = {};
  let unsubs = [];
  let resultsSent = false;
  let hostGoneNote = false;

  function cleanName(n) {
    if (typeof n !== 'string') return 'Jugador';
    n = n.replace(/<[^>]*>/g, '').replace(/[<>&"'`]/g, '').trim().slice(0, 12);
    return n || 'Jugador';
  }

  function makeCode() {
    const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 4; i++) c += cs[Math.floor(Math.random() * cs.length)];
    return c;
  }

  function newPid() {
    let a, b;
    if (window.crypto && crypto.getRandomValues) {
      const u = crypto.getRandomValues(new Uint32Array(2));
      a = u[0]; b = u[1];
    } else {
      a = Math.floor(Math.random() * 0xffffffff);
      b = Math.floor(Math.random() * 0xffffffff);
    }
    return 'p' + (a >>> 0).toString(36) + (b >>> 0).toString(36);
  }

  function lobbyEntry(name, color) {
    return {
      name: cleanName(name),
      color: color,
      joinedAt: Date.now(),
      done: false,
      win: false,
      finished: false,
      score: 0
    };
  }

  function num(v, max) {
    return Math.max(0, Math.min(max, +v || 0));
  }

  function hotState(s) {
    return {
      x: +s.x || 0,
      y: +s.y || 0,
      face: s.face === -1 ? -1 : 1,
      onGround: !!s.onGround,
      run: +s.run || 0,
      alive: s.state !== 'dying' && s.state !== 'gameover' && s.state !== 'win',
      level: Math.max(1, Math.min(3, +s.level || 1)),
      score: num(s.score, 9999999),
      coins: num(s.coins, 999),
      coinsMax: num(s.coinsMax, 999),
      enemies: num(s.enemies, 999),
      lives: num(s.lives, 99)
    };
  }

  function coldWorld(s) {
    return {
      we: Array.isArray(s.we) ? s.we.slice(0, 64).map(a => Array.isArray(a) && a.length >= 4
        ? [num(a[0], 999), num(a[1], 99999), num(a[2], 99999), a[3] === -1 ? -1 : 1, a[4] ? 1 : 0]
        : null).filter(Boolean) : [],
      wc: typeof s.wc === 'string' ? s.wc.replace(/[^01]/g, '').slice(0, 64) : ''
    };
  }

  function scoreboardList() {
    const out = [];
    for (const pid in lobbyCache) {
      const e = lobbyCache[pid];
      if (!e || !e.finished) continue;
      out.push({ id: pid, name: e.name, color: e.color, score: +e.score || 0, times: e.times || {} });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  function resultList() {
    const out = scoreboardList();
    const seen = {};
    for (const e of out) seen[e.id] = true;
    for (const pid in lobbyCache) {
      const e = lobbyCache[pid];
      if (!e || seen[pid]) continue;
      out.push({ id: pid, name: e.name, color: e.color, score: 0, times: {} });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  function errMsg(e) {
    const c = e && e.code;
    if (c === 'PERMISSION_DENIED') return 'Firebase rechazó la operación: revisa las reglas de la base de datos';
    if (c === 'UNAVAILABLE' || c === 'NETWORK_REQUEST_FAILED') return 'Sin conexión con Firebase';
    return (e && e.message) || 'Error de conexión con Firebase';
  }

  function showOffline(msg) {
    show(offlineMsg);
    setStatus(msg || '');
    actionBusy = false;
    if (msg) console.error('[PixelPark]', msg);
    setLock();
  }

  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }
  function esc(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[c]));
  }
  function fmt(ms) {
    if (!ms) return '-';
    const s = ms / 1000;
    const m = Math.floor(s / 60);
    const r = (s - m * 60).toFixed(1);
    return m + ':' + (r < 10 ? '0' : '') + r;
  }
  function setStatus(msg) { statusEl.textContent = msg || ''; }

  function setLock() {
    PK.uiLock = !menuUi.classList.contains('hidden') ||
      !lobbyUi.classList.contains('hidden') ||
      !offlineMsg.classList.contains('hidden') ||
      !resultsUi.classList.contains('hidden') ||
      !adminUi.classList.contains('hidden');
  }

  function updateRecord() {
    let b = 0;
    try { b = +(window.localStorage && localStorage.getItem('pixelpark_best')) || 0; } catch (e) {}
    $('menu-record').textContent = b > 0 ? 'RÉCORD LOCAL: ' + b : '';
  }

  function showMenu() {
    hide(menuUi);
    hide(lobbyUi);
    hide(roomChip);
    hide(scoreUi);
    hide(resultsUi);
    hide(adminUi);
    PK.inResults = false;
    PK.scoreLocked = false;
    setStatus('');
    if (PK.online && PK.code) {
      PK.gameActive = false;
      $('lobby-code').textContent = PK.code;
      renderLobby({ code: PK.code, hostId: PK.hostId, started: true, players: PK.players });
      show(lobbyUi);
    } else {
      updateRecord();
      show(menuUi);
    }
    setLock();
  }

  function hideAll() {
    hide(menuUi);
    hide(lobbyUi);
    hide(scoreUi);
    hide(resultsUi);
    hide(adminUi);
    PK.remotes = {};
    setLock();
  }

  function renderAdmin() {
    if (!window.PKAdmin) return;
    const fly = $('btn-admin-fly');
    const lives = $('btn-admin-lives');
    fly.classList.toggle('active', !!window.PKAdmin.fly);
    fly.textContent = window.PKAdmin.fly ? 'VOLAR (ON)' : 'VOLAR';
    lives.classList.toggle('active', !!window.PKAdmin.lives);
    lives.textContent = window.PKAdmin.lives ? 'VIDAS INFINITAS (ON)' : 'VIDAS INFINITAS';
  }

  function openAdmin() {
    if (!window.PKAdmin) return;
    show(adminUi);
    if (adminOn || window.PKAdmin.on) {
      adminOn = true;
      window.PKAdmin.on = true;
      hide(adminLogin);
      show(adminPowers);
      renderAdmin();
    } else {
      hide(adminPowers);
      show(adminLogin);
      adminStatus.textContent = '';
    }
    setLock();
    try { $('admin-code').focus(); } catch (e) {}
  }

  function closeAdmin() {
    hide(adminUi);
    setLock();
  }

  function resetRoom() {
    PK.online = false;
    PK.gameActive = false;
    PK.won = false;
    PK.done = false;
    PK.inResults = false;
    PK.scoreLocked = false;
    PK.code = null;
    PK.me = null;
    PK.hostId = null;
    PK.players = [];
    PK.scoreboard = [];
    PK.remotes = {};
    infoCache = null;
    lobbyCache = {};
    rawState = {};
    rawWorld = {};
    resultsSent = false;
    hostGoneNote = false;
    statsAcc = 0;
    hide(roomChip);
    hide(scoreUi);
    hide(resultsUi);
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
  }

  function leaveRoom() {
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
    if (PK.online) detachRoom(true);
    resetRoom();
    if (window.PKGame) PKGame.toMenu();
    showMenu();
  }

  function renderLobby(data) {
    PK.players = data.players || [];
    PK.hostId = data.hostId;
    if (!PK.code) PK.code = data.code;
    $('lobby-code').textContent = PK.code || '----';
    const box = $('players');
    box.innerHTML = '';
    for (const p of PK.players) {
      const chip = document.createElement('div');
      chip.className = 'chip';
      chip.innerHTML = '<span class="dot" style="background:' + esc(p.color) + '"></span>' +
        esc(p.name) + (p.host ? ' <span class="tag">ANFITRIÓN</span>' : '');
      box.appendChild(chip);
    }
    $('chip-count').textContent = PK.players.length + '/8';
    if (!PK.gameActive) {
      const isHost = PK.me && data.hostId === PK.me.id;
      const btnStart = $('btn-start');
      const btnEnter = $('btn-enter');
      const wait = $('lobby-wait');
      if (PK.done) { hide(btnStart); hide(btnEnter); hide(wait); }
      else if (isHost && !data.started) { show(btnStart); hide(btnEnter); hide(wait); }
      else if (!data.started && !isHost) { hide(btnStart); hide(btnEnter); show(wait); }
      else if (data.started) { hide(btnStart); show(btnEnter); hide(wait); }
      else { hide(btnStart); hide(btnEnter); hide(wait); }
      $('btn-leave').disabled = false;
    }
    if (PK.gameActive) return;
    $('lobby-note').textContent = PK.done
      ? 'Terminaste la partida: ahora solo puedes espectar'
      : (hostGoneNote ? 'El anfitrión ha abandonado la partida' : '');
  }

  function renderScoreboard() {
    const body = $('score-body');
    body.innerHTML = '';
    if (!PK.scoreboard.length) {
      body.innerHTML = '<tr><td colspan="5" style="color:#9fb3d9">Sin resultados todavía</td></tr>';
      return;
    }
    for (const e of PK.scoreboard) {
      const tr = document.createElement('tr');
      tr.innerHTML =
        '<td><span style="color:' + esc(e.color) + '">●</span> ' + esc(e.name) + '</td>' +
        '<td style="color:#ffd23f">' + e.score + '</td>' +
        '<td>' + fmt(e.times[1]) + '</td>' +
        '<td>' + fmt(e.times[2]) + '</td>' +
        '<td>' + fmt(e.times[3]) + '</td>';
      body.appendChild(tr);
    }
  }

  function showResults(data) {
    PK.inResults = true;
    PK.gameActive = false;
    PK.scoreLocked = false;
    hide(scoreUi);
    hide(menuUi);
    hide(lobbyUi);
    hide(roomChip);
    const box = $('results-rows');
    box.innerHTML = '';
    const list = data && data.scoreboard ? data.scoreboard : [];
    list.forEach((e, i) => {
      const row = document.createElement('div');
      row.className = 'res-row' + (i === 0 ? ' first' : '');
      row.style.animationDelay = (i * 0.35) + 's';
      row.innerHTML = '<span class="pos">' + (i + 1) + 'º</span>' +
        '<span class="nm"><span class="dot" style="background:' + esc(e.color) + '"></span> ' + esc(e.name) + '</span>' +
        '<span class="pt">' + e.score + '</span>';
      box.appendChild(row);
    });
    const rematch = $('btn-rematch');
    const isHost = !!(PK.me && data && data.hostId === PK.me.id);
    if (isHost) show(rematch); else hide(rematch);
    show(resultsNote);
    resultsNote.textContent = isHost
      ? 'Inicia otra partida cuando quieras'
      : 'Esperando a que el anfitrión inicie otra partida...';
    show(resultsUi);
    setLock();
  }

  // ---------------- Firebase: carga del SDK y conexión ----------------

  function loadFirebase(cb) {
    if (db) return cb(null);
    libQueue.push(cb);
    if (libLoading) return;
    libLoading = true;
    Promise.all([
      import(FB_SDK + 'firebase-app.js'),
      import(FB_SDK + 'firebase-database.js')
    ]).then(mods => {
      const cfg = window.FIREBASE_CONFIG;
      if (!cfg || !cfg.apiKey || !cfg.databaseURL) {
        throw new Error('Falta public/firebase-config.js con window.FIREBASE_CONFIG (databaseURL incluida)');
      }
      if (!fbApp) fbApp = mods[0].initializeApp(cfg);
      FBDB = mods[1];
      db = FBDB.getDatabase(fbApp);
      libLoading = false;
      const q = libQueue;
      libQueue = [];
      q.forEach(f => f(null));
    }).catch(err => {
      libLoading = false;
      const q = libQueue;
      libQueue = [];
      q.forEach(f => f(err || new Error('sin SDK de Firebase')));
    });
  }

  function startConnWatch() {
    if (connWatchStarted || !db) return;
    connWatchStarted = true;
    FBDB.onValue(FBDB.ref(db, '.info/connected'), snap => {
      const up = !!snap.val();
      if (up) {
        everConnected = true;
        if (connTimeout) { clearTimeout(connTimeout); connTimeout = null; }
        setStatus('');
        if (connCbQueue.length) {
          const q = connCbQueue;
          connCbQueue = [];
          q.forEach(f => f());
        }
        return;
      }
      if (!everConnected) return;
      if (PK.online) {
        detachRoom(true);
        resetRoom();
        if (window.PKGame) PKGame.toMenu();
        showMenu();
        setStatus('Conexión perdida con Firebase');
      }
    });
  }

  function ensureFirebase(cb) {
    loadFirebase(err => {
      if (err) {
        console.error('[PixelPark] No se pudo cargar Firebase:', err);
        showOffline('No se pudo cargar Firebase: ' + errMsg(err));
        return;
      }
      startConnWatch();
      if (everConnected) { cb(); return; }
      setStatus('Conectando al servidor...');
      connCbQueue.push(cb);
      if (!connTimeout) {
        connTimeout = setTimeout(() => {
          connTimeout = null;
          if (connCbQueue.length) {
            connCbQueue = [];
            showOffline('No se puede conectar con Firebase. Revisa tu conexión e inténtalo otra vez.');
          }
        }, 8000);
      }
    });
  }

  // ---------------- Sala: listeners y estado ----------------

  function handleInfo(val) {
    if (!PK.online) return;
    if (!val) { roomClosed(); return; }
    const prev = infoCache;
    infoCache = val;
    const started = !!val.started;
    if (!prev) {
      detectHostGone();
      syncLobbyUi();
      maybeResults();
      if (started && !PK.gameActive && !PK.done) enterGame();
      return;
    }
    if (prev.started !== started) {
      if (started) {
        resultsSent = false;
        if (!PK.done && !PK.gameActive) enterGame();
      } else {
        onNewMatch();
        return;
      }
    }
    detectHostGone();
    syncLobbyUi();
    maybeResults();
  }

  function handleLobby(val) {
    if (!PK.online) return;
    const prev = lobbyCache;
    lobbyCache = val || {};
    const prevIds = Object.keys(prev);
    const nowIds = Object.keys(lobbyCache);
    if (prevIds.length !== nowIds.length || nowIds.some(id => !prev[id])) hostGoneNote = false;
    for (const pid of nowIds) mergeRemote(pid);
    detectHostGone();
    syncLobbyUi();
    maybeResults();
  }

  function onRemoteData(kind, pid, val) {
    if (!val || (PK.me && pid === PK.me.id)) return;
    if (kind === 'state') rawState[pid] = val;
    else rawWorld[pid] = val;
    mergeRemote(pid);
  }

  function onRemoteGone(kind, pid) {
    if (kind === 'state') {
      delete rawState[pid];
      delete PK.remotes[pid];
    } else {
      delete rawWorld[pid];
    }
  }

  function mergeRemote(pid) {
    const s = rawState[pid];
    if (!s || (PK.me && pid === PK.me.id)) return;
    const w = rawWorld[pid];
    const e = lobbyCache[pid];
    let r = PK.remotes[pid];
    if (!r) r = PK.remotes[pid] = { x: +s.x || 0, y: +s.y || 0, tx: +s.x || 0, ty: +s.y || 0 };
    r.tx = +s.x || 0;
    r.ty = +s.y || 0;
    r.face = s.face === -1 ? -1 : 1;
    r.onGround = !!s.onGround;
    r.run = +s.run || 0;
    r.alive = !!s.alive;
    r.level = Math.max(1, Math.min(3, +s.level || 1));
    r.score = +s.score || 0;
    r.coins = +s.coins || 0;
    r.coinsMax = +s.coinsMax || 0;
    r.enemies = +s.enemies || 0;
    r.lives = +s.lives || 0;
    if (w) {
      if (w.we) r.we = w.we;
      if (w.wc !== undefined && w.wc !== null) r.wc = w.wc;
    }
    if (e) { r.name = e.name; r.color = e.color; }
  }

  function syncLobbyUi() {
    if (!PK.online || !infoCache) return;
    const hostId = infoCache.hostId;
    const players = Object.keys(lobbyCache).map(pid => ({
      id: pid,
      name: lobbyCache[pid] ? lobbyCache[pid].name : '',
      color: lobbyCache[pid] ? lobbyCache[pid].color : '',
      host: pid === hostId
    }));
    renderLobby({ code: PK.code, hostId: hostId, started: !!infoCache.started, players: players });
    PK.scoreboard = scoreboardList();
    if (!scoreUi.classList.contains('hidden')) renderScoreboard();
    if (PK.inResults) {
      if (PK.me && hostId === PK.me.id) show($('btn-rematch'));
      else hide($('btn-rematch'));
    }
  }

  function detectHostGone() {
    if (!PK.online || !db || !infoCache || !PK.code) return;
    const gone = infoCache.hostId;
    if (!gone || lobbyCache[gone]) return;
    const ids = Object.keys(lobbyCache);
    if (!ids.length) return;
    const candidate = ids.slice().sort((a, b) => {
      const ja = (lobbyCache[a].joinedAt || 0) - (lobbyCache[b].joinedAt || 0);
      return ja || (a < b ? -1 : 1);
    })[0];
    hostGoneNote = true;
    if (PK.inResults) {
      const isHost = !!(PK.me && PK.me.id === candidate);
      show(resultsNote);
      resultsNote.textContent = isHost
        ? 'Ahora tú eres el anfitrión: pulsa VOLVER A EMPEZAR'
        : 'El anfitrión ha abandonado la partida';
      if (isHost) show($('btn-rematch'));
      else hide($('btn-rematch'));
    }
    FBDB.runTransaction(FBDB.ref(db, 'rooms/' + PK.code + '/info'), cur => {
      if (!cur) return null;
      if (cur.hostId !== gone) return undefined;
      cur.hostId = candidate;
      return cur;
    }).catch(() => {});
  }

  function maybeResults() {
    if (!infoCache || !infoCache.started || resultsSent) return;
    const ids = Object.keys(lobbyCache);
    if (!ids.length) return;
    if (!ids.every(id => lobbyCache[id] && lobbyCache[id].done)) return;
    resultsSent = true;
    showResults({ scoreboard: resultList(), hostId: infoCache.hostId });
  }

  function onNewMatch() {
    hide(resultsUi);
    hide(scoreUi);
    hide(menuUi);
    hide(roomChip);
    PK.inResults = false;
    PK.won = false;
    PK.done = false;
    PK.scoreLocked = false;
    PK.gameActive = false;
    resultsSent = false;
    hostGoneNote = false;
    PK.remotes = {};
    rawState = {};
    rawWorld = {};
    PK.scoreboard = [];
    show(lobbyUi);
    setLock();
    syncLobbyUi();
  }

  function roomClosed() {
    detachRoom(true);
    resetRoom();
    if (window.PKGame) PKGame.toMenu();
    showMenu();
    setStatus('La sala fue cerrada');
  }

  function attachRoom(code, pid) {
    const base = 'rooms/' + code;
    unsubs.push(FBDB.onValue(FBDB.ref(db, base + '/info'), s => handleInfo(s.val())));
    unsubs.push(FBDB.onValue(FBDB.ref(db, base + '/lobby'), s => handleLobby(s.val())));
    for (const kind of ['state', 'world']) {
      const r = FBDB.ref(db, base + '/' + kind);
      unsubs.push(FBDB.onChildAdded(r, s => onRemoteData(kind, s.key, s.val())));
      unsubs.push(FBDB.onChildChanged(r, s => onRemoteData(kind, s.key, s.val())));
      unsubs.push(FBDB.onChildRemoved(r, s => onRemoteGone(kind, s.key)));
    }
    for (const sub of ['lobby', 'state', 'world']) {
      try {
        const pr = FBDB.onDisconnect(FBDB.ref(db, base + '/' + sub + '/' + pid)).remove();
        if (pr && pr.catch) pr.catch(() => {});
      } catch (e) {}
    }
  }

  function detachRoom(removeMe) {
    const code = PK.code;
    const pid = PK.me && PK.me.id;
    const us = unsubs;
    unsubs = [];
    us.forEach(u => { try { u(); } catch (e) {} });
    rawState = {};
    rawWorld = {};
    infoCache = null;
    lobbyCache = {};
    if (!removeMe || !db || !code || !pid) return;
    const base = 'rooms/' + code;
    const paths = ['lobby/' + pid, 'state/' + pid, 'world/' + pid];
    const removals = paths.map(p => FBDB.remove(FBDB.ref(db, base + '/' + p)).catch(() => {}));
    Promise.all(removals).then(() => {
      FBDB.runTransaction(FBDB.ref(db, base), cur => {
        if (!cur) return null;
        if (cur.lobby && Object.keys(cur.lobby).length > 0) return undefined;
        return null;
      }).catch(() => {});
    }).catch(() => {});
  }

  function joinSuccess(code, pid, entry, started) {
    PK.online = true;
    PK.code = code;
    PK.me = { id: pid, name: entry.name, color: entry.color };
    setStatus('');
    hide(menuUi);
    hide(offlineMsg);
    attachRoom(code, pid);
    if (started) { enterGame(); return; }
    $('lobby-code').textContent = code;
    $('lobby-note').textContent = '';
    show(lobbyUi);
    setLock();
  }

  function attemptCreate(n, pid, entry) {
    const code = makeCode();
    FBDB.runTransaction(FBDB.ref(db, 'rooms/' + code), cur => {
      if (cur) {
        if (cur.lobby && Object.keys(cur.lobby).length > 0) return undefined;
      }
      const room = { info: { hostId: pid, started: false, createdAt: Date.now() }, lobby: {} };
      room.lobby[pid] = entry;
      return room;
    }).then(res => {
      if (res && res.committed) {
        pendingAction = null;
        actionBusy = false;
        joinSuccess(code, pid, entry, false);
      } else if (n < 7) {
        attemptCreate(n + 1, pid, entry);
      } else {
        pendingAction = null;
        actionBusy = false;
        setStatus('No se pudo crear la sala, inténtalo otra vez');
      }
    }).catch(err => {
      actionBusy = false;
      setStatus(errMsg(err));
    });
  }

  function createRoom() {
    if (PK.online || actionBusy) return;
    pendingAction = createRoom;
    actionBusy = true;
    ensureFirebase(() => {
      setStatus('Creando sala...');
      const pid = newPid();
      attemptCreate(0, pid, lobbyEntry($('nick').value, COLORS[0]));
    });
  }

  function joinRoom() {
    const code = $('code-in').value.toUpperCase().trim();
    if (code.length !== 4) { setStatus('El código tiene 4 caracteres'); return; }
    if (PK.online || actionBusy) return;
    pendingAction = joinRoom;
    actionBusy = true;
    ensureFirebase(() => {
      setStatus('Uniéndote...');
      const pid = newPid();
      FBDB.get(FBDB.ref(db, 'rooms/' + code)).then(snap => {
        if (!snap.exists()) {
          pendingAction = null;
          actionBusy = false;
          setStatus('Sala no encontrada');
          return;
        }
        const val = snap.val() || {};
        const lc = val.lobby || {};
        const n = Object.keys(lc).length;
        const started = !!(val.info && val.info.started);
        if (n >= 8) {
          pendingAction = null;
          actionBusy = false;
          setStatus('Sala llena (máx. 8)');
          return;
        }
        const entry = lobbyEntry($('nick').value, COLORS[n % COLORS.length]);
        return FBDB.runTransaction(FBDB.ref(db, 'rooms/' + code + '/lobby'), cur => {
          if (!cur) return { [pid]: entry };
          if (Object.keys(cur).length >= 8) return undefined;
          cur[pid] = entry;
          return cur;
        }).then(res => {
          pendingAction = null;
          actionBusy = false;
          if (!res || !res.committed) { setStatus('Sala no encontrada o llena'); return; }
          joinSuccess(code, pid, entry, started);
        });
      }).catch(err => {
        actionBusy = false;
        setStatus(errMsg(err));
      });
    });
  }

  function writeDone(win) {
    if (!db || !PK.online || !PK.me) return;
    FBDB.update(FBDB.ref(db, 'rooms/' + PK.code + '/lobby/' + PK.me.id), { done: true, win: !!win }).catch(() => {});
  }

  function enterGame() {
    if (PK.done || PK.gameActive) return;
    PK.gameActive = true;
    PK.scoreLocked = false;
    hide(scoreUi);
    hide(resultsUi);
    PK.inResults = false;
    hide(menuUi);
    hide(lobbyUi);
    show(roomChip);
    $('chip-code').textContent = PK.code || '----';
    setLock();
    if (window.PKGame) PKGame.start();
    if (!sendTimer) sendTimer = setInterval(sendTick, 66);
  }

  function sendTick() {
    if (!PK.online || !PK.gameActive || !db || !PK.me || !window.PKGame) return;
    const s = PKGame.getState();
    if (!PK.done && s.state === 'gameover') {
      PK.done = true;
      writeDone(false);
    }
    const base = 'rooms/' + PK.code;
    FBDB.set(FBDB.ref(db, base + '/state/' + PK.me.id), hotState(s)).catch(() => {});
    statsAcc += 66;
    if (statsAcc >= 500) {
      statsAcc = 0;
      FBDB.set(FBDB.ref(db, base + '/world/' + PK.me.id), coldWorld({
        we: s.world ? s.world.we : [],
        wc: s.world ? s.world.wc : ''
      })).catch(() => {});
    }
  }

  $('btn-solo').addEventListener('click', () => {
    if (window.PKGame) { hideAll(); PKGame.start(); }
  });
  $('btn-create').addEventListener('click', createRoom);
  $('btn-join').addEventListener('click', joinRoom);
  $('code-in').addEventListener('keydown', e => {
    if (e.key === 'Enter') joinRoom();
    e.stopPropagation();
  });
  $('btn-start').addEventListener('click', () => {
    if (!db || !PK.online || !infoCache || !PK.me) return;
    if (infoCache.hostId !== PK.me.id || infoCache.started) return;
    FBDB.update(FBDB.ref(db, 'rooms/' + PK.code + '/info'), { started: true })
      .catch(err => setStatus(errMsg(err)));
  });
  $('btn-enter').addEventListener('click', enterGame);
  $('btn-leave').addEventListener('click', leaveRoom);
  $('btn-exit').addEventListener('click', leaveRoom);
  $('btn-offline-ok').addEventListener('click', () => {
    hide(offlineMsg);
    setLock();
  });
  $('btn-rematch').addEventListener('click', () => {
    if (!db || !PK.online || !infoCache || !PK.me || infoCache.hostId !== PK.me.id) return;
    const upd = { 'info/started': false, state: null, world: null };
    for (const pid in lobbyCache) {
      const e = lobbyCache[pid] || {};
      upd['lobby/' + pid] = {
        name: e.name,
        color: e.color,
        joinedAt: e.joinedAt || Date.now(),
        done: false,
        win: false,
        finished: false,
        score: 0
      };
    }
    FBDB.update(FBDB.ref(db, 'rooms/' + PK.code), upd)
      .catch(err => setStatus(errMsg(err)));
  });
  $('btn-results-leave').addEventListener('click', leaveRoom);
  $('btn-corner-menu').addEventListener('click', () => {
    if (PK.online || !window.PKGame) return;
    PKGame.toMenu();
    showMenu();
  });
  $('btn-retry').addEventListener('click', () => {
    hide(offlineMsg);
    setLock();
    if (pendingAction) pendingAction();
    else { setStatus('Conectando al servidor...'); ensureFirebase(() => setStatus('')); }
  });

  $('btn-corner-code').addEventListener('click', openAdmin);
  $('btn-admin-cancel').addEventListener('click', closeAdmin);
  $('btn-admin-close').addEventListener('click', closeAdmin);
  $('admin-code').addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      $('btn-admin-ok').click();
    }
  });
  $('btn-admin-ok').addEventListener('click', () => {
    const v = $('admin-code').value.trim();
    if (v === '3465') {
      adminOn = true;
      if (window.PKAdmin) window.PKAdmin.on = true;
      adminStatus.textContent = '';
      hide(adminLogin);
      show(adminPowers);
      renderAdmin();
    } else {
      adminStatus.textContent = v ? 'Código incorrecto' : 'Introduce el código';
    }
  });
  $('btn-admin-fly').addEventListener('click', () => {
    if (!adminOn || !window.PKAdmin) return;
    window.PKAdmin.toggleFly();
    renderAdmin();
  });
  $('btn-admin-lives').addEventListener('click', () => {
    if (!adminOn || !window.PKAdmin) return;
    window.PKAdmin.toggleLives();
    renderAdmin();
  });
  $('btn-admin-points').addEventListener('click', () => {
    if (!adminOn || !window.PKAdmin) return;
    window.PKAdmin.addPoints();
  });

  $('nick').addEventListener('change', () => {
    try { localStorage.setItem('pixelpark_name', $('nick').value); } catch (e) {}
  });
  try {
    const n = localStorage.getItem('pixelpark_name');
    if (n) $('nick').value = n;
  } catch (e) {}

  window.addEventListener('keydown', e => {
    const tag = e.target && e.target.tagName;
    if (e.code === 'Escape' && !adminUi.classList.contains('hidden')) {
      e.preventDefault();
      e.stopPropagation();
      closeAdmin();
      return;
    }
    if (e.code === 'Tab') {
      if (PK.gameActive && !PK.inResults) {
        e.preventDefault();
        renderScoreboard();
        show(scoreUi);
      }
      return;
    }
    if (e.code === 'Enter' && !menuUi.classList.contains('hidden') &&
        offlineMsg.classList.contains('hidden') && window.PKGame &&
        tag !== 'BUTTON' && (e.target && e.target.id) !== 'code-in') {
      e.preventDefault();
      e.stopPropagation();
      hideAll();
      PKGame.start();
      return;
    }
    if (tag === 'INPUT' || tag === 'BUTTON' || tag === 'TEXTAREA') return;
    if (!scoreUi.classList.contains('hidden') && !PK.scoreLocked) hide(scoreUi);
  }, true);
  window.addEventListener('keyup', e => {
    if (e.code === 'Tab' && !PK.scoreLocked) hide(scoreUi);
  }, true);

  window.PKNet = {
    hideAll: hideAll,
    showMenu: showMenu,
    leaveRoom: leaveRoom,
    showScore: () => {
      if (!PK.online) return;
      PK.won = true;
      PK.done = true;
      PK.scoreLocked = true;
      writeDone(true);
      renderScoreboard();
      show(scoreUi);
    },
    finish: (level, timeMs, sc) => {
      if (!db || !PK.online || !PK.gameActive || !PK.me) return;
      FBDB.runTransaction(FBDB.ref(db, 'rooms/' + PK.code + '/lobby/' + PK.me.id), cur => {
        const e = cur || {
          name: (PK.me && PK.me.name) || '',
          color: (PK.me && PK.me.color) || '',
          joinedAt: Date.now()
        };
        const lvl = Math.max(1, Math.min(3, +level || 1));
        const t = Math.max(0, +timeMs || 0);
        const points = Math.max(0, +sc || 0);
        e.score = Math.max(+e.score || 0, points);
        e.times = e.times || {};
        if (t && (!e.times[lvl] || t < e.times[lvl])) e.times[lvl] = t;
        e.finished = true;
        return e;
      }).catch(() => {});
    }
  };

  updateRecord();
  setLock();
  try { $('nick').focus(); } catch (e) {}
})();
