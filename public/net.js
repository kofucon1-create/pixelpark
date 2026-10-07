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

  let socket = null;
  let sendTimer = null;
  let libLoading = false;
  let libQueue = [];
  let pendingAction = null;

  function serverBase() {
    try {
      const saved = (localStorage.getItem('pixelpark_server') || '').trim().replace(/\/+$/, '');
      if (saved) return saved;
    } catch (e) {}
    if (window.location && location.protocol === 'file:') return 'http://localhost:3000';
    return undefined;
  }

  function sioPath() {
    return '/socket.io';
  }

  function libCandidates() {
    const base = serverBase();
    const out = [base ? base + '/vendor/socket.io.min.js' : '/vendor/socket.io.min.js'];
    if (!base || location.protocol !== 'file:') out.push('/socket.io/socket.io.js');
    return out;
  }

  function loadSocketLib(cb) {
    if (typeof io !== 'undefined') return cb(null);
    libQueue.push(cb);
    if (libLoading) return;
    libLoading = true;
    const urls = libCandidates();
    let i = 0;
    function done(err) {
      libLoading = false;
      const q = libQueue;
      libQueue = [];
      q.forEach(f => f(err));
    }
    function attempt() {
      if (i >= urls.length) return done(new Error('sin cliente socket.io'));
      const el = document.createElement('script');
      el.src = urls[i++];
      el.onload = () => {
        el.remove();
        if (typeof io !== 'undefined') done(null);
        else attempt();
      };
      el.onerror = () => { el.remove(); attempt(); };
      document.head.appendChild(el);
    }
    attempt();
  }

  function showOffline() {
    show(offlineMsg);
    setStatus('');
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
    PK.players = [];
    PK.scoreboard = [];
    PK.remotes = {};
    hide(roomChip);
    hide(scoreUi);
    hide(resultsUi);
    if (sendTimer) { clearInterval(sendTimer); sendTimer = null; }
  }

  function leaveRoom() {
    if (socket && PK.online) socket.emit('leave');
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
      : '';
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

  function enterGame() {
    if (PK.done) return;
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
    if (!sendTimer) {
      sendTimer = setInterval(() => {
        if (!PK.online || !PK.gameActive || !socket || !window.PKGame) return;
        const s = PKGame.getState();
        if (!PK.done && s.state === 'gameover') {
          PK.done = true;
          socket.emit('done', { win: false });
        }
        socket.emit('state', {
          x: s.x, y: s.y, face: s.face, onGround: s.onGround, run: s.run,
          level: s.level, score: s.score, coins: s.coins, coinsMax: s.coinsMax,
          enemies: s.enemies, lives: s.lives,
          we: s.world.we, wc: s.world.wc,
          alive: s.state !== 'dying' && s.state !== 'gameover' && s.state !== 'win'
        });
      }, 50);
    }
  }

  function ensureSocket(cb) {
    if (socket) return cb(socket);
    setStatus('Conectando al servidor...');
    loadSocketLib(err => {
      if (err) { showOffline(); return; }
      const s = socket = io(serverBase(), { path: sioPath(), transports: ['websocket'], reconnection: true });

      s.on('connect', () => setStatus(''));
      s.on('connect_error', () => setStatus('Sin servidor: ejecuta node server.js (o JUGAR.bat) y pulsa REINTENTAR'));

    socket.on('lobby', data => {
      if (!PK.online) return;
      renderLobby(data);
      if (PK.inResults) {
        if (PK.me && PK.hostId === PK.me.id) show($('btn-rematch'));
        else hide($('btn-rematch'));
      }
    });

    socket.on('hostleft', () => {
      const gone = 'El anfitrión ha abandonado la partida';
      $('lobby-note').textContent = gone;
      if (PK.inResults) {
        const isHost = !!(PK.me && PK.hostId === PK.me.id);
        show(resultsNote);
        resultsNote.textContent = isHost
          ? 'Ahora tú eres el anfitrión: pulsa VOLVER A EMPEZAR'
          : gone;
        if (isHost) show($('btn-rematch'));
        else hide($('btn-rematch'));
      }
    });

    socket.on('started', () => {
      if (!PK.online || PK.done) return;
      enterGame();
    });

    socket.on('world', arr => {
      const seen = {};
      for (const p of arr) {
        if (PK.me && p.id === PK.me.id) continue;
        seen[p.id] = true;
        let r = PK.remotes[p.id];
        if (!r) {
          r = PK.remotes[p.id] = { x: p.s.x, y: p.s.y, tx: p.s.x, ty: p.s.y };
        }
        r.tx = p.s.x;
        r.ty = p.s.y;
        r.face = p.s.face;
        r.onGround = p.s.onGround;
        r.run = p.s.run;
        r.alive = p.s.alive;
        r.level = p.s.level;
        r.score = p.s.score;
        r.coins = p.s.coins;
        r.coinsMax = p.s.coinsMax;
        r.enemies = p.s.enemies;
        r.lives = p.s.lives;
        if (p.s.we) r.we = p.s.we;
        if (p.s.wc !== undefined) r.wc = p.s.wc;
        r.name = p.name;
        r.color = p.color;
      }
      for (const id in PK.remotes) if (!seen[id]) delete PK.remotes[id];
    });

    socket.on('scoreboard', data => {
      PK.scoreboard = data || [];
      if (!scoreUi.classList.contains('hidden')) renderScoreboard();
    });

    socket.on('results', data => {
      if (!PK.online) return;
      showResults(data);
    });

    socket.on('newmatch', () => {
      hide(resultsUi);
      hide(scoreUi);
      hide(menuUi);
      hide(roomChip);
      PK.inResults = false;
      PK.won = false;
      PK.done = false;
      PK.scoreLocked = false;
      PK.gameActive = false;
      show(lobbyUi);
      setLock();
    });

    socket.on('disconnect', () => {
      if (PK.online) {
        resetRoom();
        if (window.PKGame) PKGame.toMenu();
        showMenu();
        setStatus('Conexión perdida con el servidor');
      }
    });

      cb(s);
    });
  }

  function createRoom() {
    pendingAction = createRoom;
    ensureSocket(s => {
      setStatus('Creando sala...');
      s.emit('create', $('nick').value, res => {
        pendingAction = null;
        if (res.error) { setStatus(res.error); return; }
        PK.online = true;
        PK.code = res.code;
        PK.me = res.you;
        setStatus('');
        hide(menuUi);
        show(lobbyUi);
        $('lobby-note').textContent = '';
        renderLobby({ code: res.code, hostId: res.you.id, started: false, players: [Object.assign({ host: true }, res.you)] });
        setLock();
      });
    });
  }

  function joinRoom() {
    const code = $('code-in').value.toUpperCase().trim();
    if (code.length !== 4) { setStatus('El código tiene 4 caracteres'); return; }
    pendingAction = joinRoom;
    ensureSocket(s => {
      setStatus('Uniéndote...');
      s.emit('join', { code: code, name: $('nick').value }, res => {
        pendingAction = null;
        if (res.error) { setStatus(res.error); return; }
        PK.online = true;
        PK.code = res.code;
        PK.me = res.you;
        setStatus('');
        if (res.started) { enterGame(); return; }
        hide(menuUi);
        show(lobbyUi);
        $('lobby-note').textContent = '';
        setLock();
      });
    });
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
    if (socket) socket.emit('start');
  });
  $('btn-enter').addEventListener('click', enterGame);
  $('btn-leave').addEventListener('click', leaveRoom);
  $('btn-exit').addEventListener('click', leaveRoom);
  $('btn-offline-ok').addEventListener('click', () => {
    hide(offlineMsg);
    setLock();
  });
  $('btn-rematch').addEventListener('click', () => {
    if (socket) socket.emit('restart');
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
    else { setStatus('Conectando al servidor...'); ensureSocket(() => setStatus('Conectado')); }
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
      if (socket) socket.emit('done', { win: true });
      renderScoreboard();
      show(scoreUi);
    },
    finish: (level, timeMs, sc) => {
      if (socket && PK.online && PK.gameActive) {
        socket.emit('finish', { level: level, time: timeMs, score: sc });
      }
    }
  };

  updateRecord();
  setLock();
  try { $('nick').focus(); } catch (e) {}
})();
