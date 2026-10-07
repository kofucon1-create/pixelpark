const { Server } = require('socket.io');

const COLORS = ['#e0473a', '#3b78e0', '#5cb85c', '#ffd23f', '#b06bff', '#ff8a3d', '#37d0c0', '#ff6fae'];

function attachGameServer(httpServer, opts) {
  const io = new Server(httpServer, {
    cors: { origin: true, methods: ['GET', 'POST'] },
    transports: ['websocket']
  });
  const rooms = new Map();

  function cleanName(n) {
    if (typeof n !== 'string') return 'Jugador';
    n = n.replace(/<[^>]*>/g, '').replace(/[<>&"'`]/g, '').trim().slice(0, 12);
    return n || 'Jugador';
  }

  function makeCode() {
    const cs = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c;
    do {
      c = '';
      for (let i = 0; i < 4; i++) c += cs[Math.floor(Math.random() * cs.length)];
    } while (rooms.has(c));
    return c;
  }

  function playerList(room) {
    return room.players.map(p => ({ id: p.id, name: p.name, color: p.color, host: p.id === room.hostId }));
  }

  function scoreboard(room) {
    const out = [];
    for (const s of room.scores.values()) {
      out.push({ id: s.id, name: s.name, color: s.color, score: s.score, times: s.times });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  function resultBoard(room) {
    const out = scoreboard(room);
    const seen = new Set(out.map(e => e.id));
    for (const p of room.players) {
      if (!seen.has(p.id)) out.push({ id: p.id, name: p.name, color: p.color, score: 0, times: {} });
    }
    out.sort((a, b) => b.score - a.score);
    return out;
  }

  function maybeResults(room) {
    if (!room.started || room.resultsSent) return;
    if (!room.players.length) return;
    if (!room.players.every(p => p.done)) return;
    room.resultsSent = true;
    io.to(room.code).emit('results', { scoreboard: resultBoard(room), hostId: room.hostId });
  }

  function broadcastLobby(room) {
    io.to(room.code).emit('lobby', {
      code: room.code,
      hostId: room.hostId,
      started: room.started,
      players: playerList(room)
    });
  }

  function removePlayer(room, id) {
    const i = room.players.findIndex(p => p.id === id);
    if (i < 0) return;
    const wasHost = room.hostId === id;
    room.players.splice(i, 1);
    room.scores.delete(id);
    if (room.hostId === id) room.hostId = room.players.length ? room.players[0].id : null;
    if (room.players.length === 0) {
      rooms.delete(room.code);
    } else {
      broadcastLobby(room);
      if (wasHost) io.to(room.code).emit('hostleft', { hostId: room.hostId });
      maybeResults(room);
    }
  }

  io.on('connection', socket => {
    let room = null;
    let me = null;

    socket.on('create', (rawName, cb) => {
      if (room) return cb && cb({ error: 'Ya estás en una sala' });
      const code = makeCode();
      room = { code, hostId: socket.id, started: false, resultsSent: false, players: [], scores: new Map() };
      rooms.set(code, room);
      me = { id: socket.id, name: cleanName(rawName), color: COLORS[0], state: null, done: false, win: false };
      room.players.push(me);
      socket.join(code);
      cb && cb({ code: code, you: { id: me.id, name: me.name, color: me.color } });
      broadcastLobby(room);
    });

    socket.on('join', (data, cb) => {
      if (room) return cb && cb({ error: 'Ya estás en una sala' });
      const code = String((data && data.code) || '').toUpperCase().trim();
      const target = rooms.get(code);
      if (!target) return cb && cb({ error: 'Sala no encontrada' });
      if (target.players.length >= 8) return cb && cb({ error: 'Sala llena (máx. 8)' });
      room = target;
      me = {
        id: socket.id,
        name: cleanName(data && data.name),
        color: COLORS[target.players.length % COLORS.length],
        state: null,
        done: false,
        win: false
      };
      room.players.push(me);
      socket.join(code);
      cb && cb({
        code: code,
        you: { id: me.id, name: me.name, color: me.color },
        started: room.started
      });
      broadcastLobby(room);
    });

    socket.on('start', () => {
      if (!room || !me || room.hostId !== socket.id) return;
      room.started = true;
      io.to(room.code).emit('started', { players: playerList(room) });
    });

    socket.on('state', s => {
      if (!me || !s) return;
      const num = (v, max) => Math.max(0, Math.min(max, +v || 0));
      me.state = {
        x: +s.x || 0,
        y: +s.y || 0,
        face: s.face === -1 ? -1 : 1,
        onGround: !!s.onGround,
        run: +s.run || 0,
        alive: !!s.alive,
        level: Math.max(1, Math.min(3, +s.level || 1)),
        score: num(s.score, 9999999),
        coins: num(s.coins, 999),
        coinsMax: num(s.coinsMax, 999),
        enemies: num(s.enemies, 999),
        lives: num(s.lives, 99),
        we: Array.isArray(s.we) ? s.we.slice(0, 64).map(a => Array.isArray(a) && a.length >= 4
          ? [num(a[0], 999), num(a[1], 99999), num(a[2], 99999), a[3] === -1 ? -1 : 1, a[4] ? 1 : 0]
          : null).filter(Boolean) : undefined,
        wc: typeof s.wc === 'string' ? s.wc.replace(/[^01]/g, '').slice(0, 64) : undefined
      };
    });

    socket.on('finish', f => {
      if (!room || !me || !f) return;
      const lvl = Math.max(1, Math.min(3, +f.level || 1));
      const t = Math.max(0, +f.time || 0);
      const sc = Math.max(0, +f.score || 0);
      let s = room.scores.get(me.id);
      if (!s) {
        s = { id: me.id, name: me.name, color: me.color, score: 0, times: {} };
        room.scores.set(me.id, s);
      }
      s.name = me.name;
      s.score = Math.max(s.score, sc);
      if (t && (!s.times[lvl] || t < s.times[lvl])) s.times[lvl] = t;
      io.to(room.code).emit('scoreboard', scoreboard(room));
    });

    socket.on('done', d => {
      if (!room || !me) return;
      me.done = true;
      me.win = !!(d && d.win);
      maybeResults(room);
    });

    socket.on('restart', () => {
      if (!room || room.hostId !== socket.id) return;
      room.started = false;
      room.resultsSent = false;
      room.scores.clear();
      for (const p of room.players) {
        p.done = false;
        p.win = false;
        p.state = null;
      }
      io.to(room.code).emit('scoreboard', []);
      io.to(room.code).emit('newmatch', {});
      broadcastLobby(room);
    });

    socket.on('leave', () => {
      if (room) {
        socket.leave(room.code);
        removePlayer(room, socket.id);
        room = null;
        me = null;
      }
    });

    socket.on('disconnect', () => {
      if (room) removePlayer(room, socket.id);
    });
  });

  const timer = setInterval(() => {
    for (const room of rooms.values()) {
      if (!room.started) continue;
      const arr = [];
      for (const p of room.players) {
        if (p.state) arr.push({ id: p.id, name: p.name, color: p.color, s: p.state });
      }
      if (arr.length) io.to(room.code).emit('world', arr);
    }
  }, 66);
  if (timer.unref) timer.unref();

  return io;
}

module.exports = { attachGameServer };