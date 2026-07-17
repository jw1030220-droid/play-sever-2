// server.js — 惡搞棋院 帳號 / 進度 / 配對 伺服器 + 後台管理 API
//
// 部署（Render）：
//   Build Command: npm install
//   Start Command: npm start
//   環境變數：
//     GOOGLE_CLIENT_ID = 你的 OAuth 用戶端 ID（必填，要跟前端填的那個一模一樣）
//     ADMIN_PASSWORD   = 後台密碼（必填，不要用預設值）
//     DB_PATH          = 選填，資料檔路徑；掛了 Disk 的話指到磁碟上

const path = require('path');
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const db = require('./db');
const auth = require('./auth');

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const PORT = process.env.PORT || 3000;
// 公共配對等這麼久還湊不到人，就用 AI 補位讓玩家直接開打
const QUEUE_AI_FILL_MS = Number(process.env.QUEUE_AI_FILL_MS || 15000);

const app = express();
app.set('trust proxy', true);
app.use(cors());
app.use(express.json({ limit:'64kb' }));
app.use('/admin', express.static(path.join(__dirname, 'public')));
// 遊戲本體。放這裡的好處是：遊戲和 API 同一個網域，
// 前端可以自動抓到伺服器位置和 Client ID，玩家完全不用設定任何東西。
app.use('/', express.static(path.join(__dirname, 'game')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin:'*' } });

/* ================= public ================= */

// 前端開機時會打這支，自動取得 Google Client ID。
// 這樣 Client ID 只要在伺服器設一次環境變數，App 端不用填、也不用改程式碼。
// Client ID 本來就是公開資訊（會出現在網頁原始碼裡），這樣傳沒有安全問題。
app.get('/api/config', (req, res) => {
  res.json({
    googleClientId: process.env.GOOGLE_CLIENT_ID || '',
    configured: !!process.env.GOOGLE_CLIENT_ID
  });
});

app.get('/', (req,res)=>res.send('惡搞棋院 server is running. Admin: /admin'));
app.get('/api/health', (req,res)=>res.json({
  ok:true,
  googleConfigured: !!auth.GOOGLE_CLIENT_ID,
  time: Date.now()
}));

/* ================= auth ================= */

// 註冊 + 登入是同一個入口：第一次來就自動建帳號，之後就是登入。
app.post('/api/auth/google', async (req,res)=>{
  const { credential } = req.body || {};
  if(!credential) return res.status(400).json({ error:'missing_credential' });
  try{
    const profile = await auth.verifyGoogleCredential(credential);
    const { account, isNew } = db.upsertGoogleAccount(profile);
    if(account.banned) return res.status(403).json({ error:'banned' });

    const meta = { ip: auth.clientIp(req), userAgent: req.headers['user-agent'] || '' };
    const session = db.createSession(account.id, meta);
    db.recordLogin(account.id, { ...meta, method:'google', isNew });

    res.json({
      token: session.token,
      isNew,
      account: auth.publicAccount(account)
    });
  }catch(e){
    console.error('google auth failed:', e.message);
    res.status(401).json({ error:'invalid_credential', message:e.message });
  }
});

app.get('/api/me', auth.requireAuth, (req,res)=>{
  res.json({ account: auth.publicAccount(req.account) });
});

app.post('/api/logout', auth.requireAuth, (req,res)=>{
  db.revokeSession(req.session.token);
  res.json({ ok:true });
});

// 進度存檔。
// 注意：這裡是「相信用戶端」的做法 —— 金幣是前端算完再送上來的，
// 有心人可以改用戶端直接灌金幣。要完全防作弊，得把整個對局規則搬到
// 伺服器上驗證。以目前這種單機為主的休閒遊戲來說算可接受的取捨。
app.post('/api/progress', auth.requireAuth, (req,res)=>{
  const p = db.saveProgress(req.account.id, req.body || {});
  res.json({ progress: p });
});

// AI 的對手模型（你的失誤習慣）。存在帳號上，換手機也記得。
app.post('/api/oppmodel', auth.requireAuth, (req,res)=>{
  const m = db.saveOppModel(req.account.id, (req.body && req.body.model) || {});
  res.json({ oppModel: m });
});
app.get('/api/oppmodel', auth.requireAuth, (req,res)=>{
  res.json({ oppModel: db.getOppModel(req.account.id) });
});

/* ================= admin ================= */

function requireAdmin(req,res,next){
  if((req.headers['x-admin-password']||'') !== ADMIN_PASSWORD){
    return res.status(401).json({ error:'unauthorized' });
  }
  next();
}

app.post('/api/admin/login', (req,res)=>{
  if((req.body||{}).password === ADMIN_PASSWORD) return res.json({ ok:true });
  res.status(401).json({ ok:false, error:'wrong password' });
});

app.get('/api/admin/stats', requireAdmin, (req,res)=>{
  res.json({ ...db.stats(), onlineSockets: io.engine.clientsCount, activeRooms: Object.keys(rooms).length });
});

app.get('/api/admin/accounts', requireAdmin, (req,res)=>{
  res.json({ accounts: db.listAccounts() });
});

app.get('/api/admin/accounts/:id', requireAdmin, (req,res)=>{
  const a = db.getAccount(req.params.id);
  if(!a) return res.status(404).json({ error:'not found' });
  res.json({
    account: a,
    logins: db.listLoginRecords({ accountId:a.id, limit:50 }),
    sessions: db.listSessions(a.id)
  });
});

app.post('/api/admin/accounts/:id/currency', requireAdmin, (req,res)=>{
  const { field, delta } = req.body || {};
  const d = parseInt(delta);
  if(isNaN(d)) return res.status(400).json({ error:'delta must be a number' });
  const a = db.adjustCurrency(req.params.id, field, d);
  if(!a) return res.status(404).json({ error:'not found or bad field' });
  res.json({ account: a });
});

app.post('/api/admin/accounts/:id/ban', requireAdmin, (req,res)=>{
  const a = db.setBanned(req.params.id, !!(req.body||{}).banned);
  if(!a) return res.status(404).json({ error:'not found' });
  res.json({ account: a });
});

app.post('/api/admin/accounts/:id/kick', requireAdmin, (req,res)=>{
  db.revokeAllSessions(req.params.id);
  res.json({ ok:true });
});

app.get('/api/admin/logins', requireAdmin, (req,res)=>{
  res.json({ logins: db.listLoginRecords({ limit: parseInt(req.query.limit)||200 }) });
});

app.get('/api/admin/games', requireAdmin, (req,res)=>{
  res.json({ games: db.listGames(parseInt(req.query.limit)||100) });
});

/* ================= matchmaking ================= */

const queues = {};
const rooms = {};

function queueKey(f,v,t){ return `${f}:${v}:${t}`; }
function neededPlayers(type){ return type==='2v2' ? 4 : 2; }

function tryMatch(key){
  const q = queues[key];
  if(!q) return;
  const [family, variant, type] = key.split(':');
  const need = neededPlayers(type);
  while(q.length >= need) formRoom(family, variant, type, q.splice(0,need));
}

function formRoom(family, variant, type, group){
  const gameId = 'room_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2,6);
  // 座位顏色 = index % 2。這樣不論 1v1 或 2v2，出手順序都是 白→黑→白→黑…
  // 2v2 時座位 0,2 同屬白隊、1,3 同屬黑隊，同隊自然輪流動同一色的棋子。
  const seats = group.map((e,i)=>({
    socketId: e.socketId, accountId: e.accountId, name: e.name, seat: i,
    team: i%2===0 ? 'w' : 'b'
  }));
  const dbGame = db.createGame({
    family, variant, type,
    players: seats.map(s=>({ accountId:s.accountId, seat:s.seat, team:s.team }))
  });
  rooms[gameId] = { family, variant, type, seats, dbGameId: dbGame.id };

  seats.forEach(s=>{
    const sock = io.sockets.sockets.get(s.socketId);
    if(!sock) return;
    sock.join(gameId);
    sock.data.gameId = gameId;
    if(sock.data.queueTimer){ clearTimeout(sock.data.queueTimer); sock.data.queueTimer=null; }
    sock.emit('queue:matched', {
      gameId, dbGameId: dbGame.id, family, variant, type,
      yourSeat: s.seat, yourTeam: s.team,
      players: seats.length,
      seatNames: seats.map(x=>x.name),
      seats: seats.map(x=>({ seat:x.seat, team:x.team, name:x.name }))
    });
  });
}


function seatOf(gameId, socketId){
  const room = rooms[gameId];
  if(!room) return null;
  const s = room.seats.find(x=>x.socketId===socketId);
  return s ? s.seat : null;
}

io.on('connection', (socket)=>{

  // 線上對戰現在也要登入：用 REST 拿到的 session token 換身分
  socket.on('auth', ({ token })=>{
    const session = token && db.getSession(token);
    if(!session){ socket.emit('error', { message:'請先登入' }); return; }
    const account = db.getAccount(session.accountId);
    if(!account || account.banned){ socket.emit('error', { message:'帳號無法使用' }); return; }
    socket.data.accountId = account.id;
    socket.data.name = account.name;
    socket.emit('authed', { account: auth.publicAccount(account) });
  });

  socket.on('queue:join', ({ family, variant, type })=>{
    if(!socket.data.accountId) return socket.emit('error', { message:'請先登入' });
    if(!family || !variant || !type) return socket.emit('error', { message:'缺少配對參數' });
    const key = queueKey(family, variant, type);
    queues[key] = (queues[key]||[]).filter(e=>e.socketId!==socket.id);
    queues[key].push({ socketId:socket.id, accountId:socket.data.accountId, name:socket.data.name });
    socket.emit('queue:waiting', { key, position:queues[key].length });
    tryMatch(key);

    // 等太久湊不到人就用 AI 補位開打，不要讓玩家乾等
    if(socket.data.queueTimer) clearTimeout(socket.data.queueTimer);
    socket.data.queueTimer = setTimeout(()=>{
      const q = queues[key] || [];
      const me = q.find(e=>e.socketId===socket.id);
      if(!me) return;   // 已經配對成功了
      queues[key] = q.filter(e=>e.socketId!==socket.id);
      const need = type==='2v2' ? 4 : 2;
      socket.emit('queue:timeout', {
        family, variant, type, players: need,
        seats: [{ name: socket.data.name || '你' }]   // 只有自己，其餘交給前端補 AI
      });
    }, QUEUE_AI_FILL_MS);
  });

  socket.on('queue:leave', ()=>{
    if(socket.data.queueTimer){ clearTimeout(socket.data.queueTimer); socket.data.queueTimer=null; }
    Object.keys(queues).forEach(k=>{ queues[k] = queues[k].filter(e=>e.socketId!==socket.id); });
  });

  socket.on('move', ({ gameId, move })=>{
    if(!gameId || !rooms[gameId]) return;
    db.bumpMoveCount(rooms[gameId].dbGameId);
    socket.to(gameId).emit('move', { move, fromSeat: seatOf(gameId, socket.id) });
  });

  socket.on('duck', ({ gameId, duck })=>{
    if(!gameId || !rooms[gameId]) return;
    socket.to(gameId).emit('duck', { duck, fromSeat: seatOf(gameId, socket.id) });
  });

  // 象棋走法轉發。跟西洋棋一樣，伺服器只負責轉發、不驗證規則。
  socket.on('room:create', ({ family, variant, type, need })=>{
    const code = genRoomCode();
    const room = {
      code, hostId: socket.id, family: family||'western', variant: variant||'duck',
      type: type||'1v1', need: need===4 ? 4 : 2,
      members: [{ socketId: socket.id, accountId: socket.data.accountId, name: socket.data.name || '玩家' }]
    };
    privateRooms[code] = room;
    socket.join('room:'+code);
    socket.data.roomCode = code;
    broadcastRoom(io, room);
  });

  socket.on('room:join', ({ code })=>{
    const c = String(code||'').toUpperCase();
    const room = privateRooms[c];
    if(!room){ socket.emit('room:error', { message:'找不到這個房間，請確認代碼' }); return; }
    if(room.members.length >= room.need){ socket.emit('room:error', { message:'房間已經滿了' }); return; }
    if(room.members.some(m=>m.socketId===socket.id)){ socket.emit('room:error', { message:'你已經在房間裡了' }); return; }
    room.members.push({ socketId: socket.id, accountId: socket.data.accountId, name: socket.data.name || '玩家' });
    socket.join('room:'+c);
    socket.data.roomCode = c;
    broadcastRoom(io, room);
  });

  socket.on('room:leave', ({ code })=>{
    const room = privateRooms[String(code||'').toUpperCase()];
    if(!room) return;
    room.members = room.members.filter(m=>m.socketId!==socket.id);
    socket.leave('room:'+room.code);
    socket.data.roomCode = null;
    if(room.members.length && room.hostId===socket.id) room.hostId = room.members[0].socketId;
    broadcastRoom(io, room);
    destroyRoomIfEmpty(room.code);
  });

  socket.on('room:start', ({ code })=>{
    const room = privateRooms[String(code||'').toUpperCase()];
    if(!room) return;
    if(room.hostId !== socket.id){ socket.emit('room:error', { message:'只有房主可以開始遊戲' }); return; }

    // 沒滿就用 AI 補位，不用乾等
    if(room.members.length < room.need){
      room.members.forEach((m,i)=>{
        io.to(m.socketId).emit('room:started', {
          aiFill: true, family: room.family, variant: room.variant,
          players: room.need,
          seats: Array.from({length:room.need}, (_,k)=> room.members[k]
            ? { name: room.members[k].name } : null)
        });
      });
      delete privateRooms[room.code];
      return;
    }

    const gameId = 'g_' + Math.random().toString(36).slice(2,10);
    const seats = room.members.map((m,i)=>({
      socketId:m.socketId, accountId:m.accountId, name:m.name, seat:i,
      team: i%2===0 ? 'w' : 'b'
    }));
    const dbGame = db.createGame({
      family: room.family, variant: room.variant, type: room.type,
      players: seats.map(x=>({ accountId:x.accountId, seat:x.seat, team:x.team }))
    });
    rooms[gameId] = { family:room.family, variant:room.variant, type:room.type, seats, dbGameId: dbGame.id };
    seats.forEach(sx=>{
      const sk = io.sockets.sockets.get(sx.socketId);
      if(!sk) return;
      sk.join(gameId);
      sk.data.gameId = gameId;
      sk.emit('room:started', {
        gameId, dbGameId: dbGame.id, family: room.family, variant: room.variant, type: room.type,
        yourSeat: sx.seat, yourTeam: sx.team,
        players: seats.length,
        seatNames: seats.map(x=>x.name),
        seats: seats.map(x=>({ seat:x.seat, team:x.team, name:x.name }))
      });
    });
    delete privateRooms[room.code];
  });

  socket.on('xqmove', ({ gameId, action })=>{
    if(!gameId || !rooms[gameId]) return;
    db.bumpMoveCount(rooms[gameId].dbGameId);
    socket.to(gameId).emit('xqmove', { action, fromSeat: seatOf(gameId, socket.id) });
  });

  socket.on('action', ({ gameId, payload })=>{
    if(!gameId || !rooms[gameId]) return;
    socket.to(gameId).emit('action', { payload, fromSeat: seatOf(gameId, socket.id) });
  });

  socket.on('game:end', ({ gameId, result, winnerTeam })=>{
    if(!gameId || !rooms[gameId]) return;
    const room = rooms[gameId];
    room.seats.forEach(s=>{
      if(!s.accountId) return;
      const isDraw = result==='draw';
      db.recordResult(s.accountId, isDraw ? 'draw' : (winnerTeam && s.team===winnerTeam ? 'win' : 'loss'));
    });
    db.endGame(room.dbGameId, { team: winnerTeam || null, result });
    io.to(gameId).emit('game:ended', { result, winnerTeam });
    delete rooms[gameId];
  });

  socket.on('disconnect', ()=>{
    if(socket.data.queueTimer) clearTimeout(socket.data.queueTimer);
    Object.keys(queues).forEach(k=>{ queues[k] = queues[k].filter(e=>e.socketId!==socket.id); });
    // 離開私人房間，房主走了就換人當
    const code = socket.data.roomCode;
    if(code && privateRooms[code]){
      const room = privateRooms[code];
      room.members = room.members.filter(m=>m.socketId!==socket.id);
      if(room.members.length && room.hostId===socket.id) room.hostId = room.members[0].socketId;
      broadcastRoom(io, room);
      destroyRoomIfEmpty(code);
    }
    const gameId = socket.data.gameId;
    if(gameId && rooms[gameId]) socket.to(gameId).emit('opponent:left', {});
  });
});

server.listen(PORT, ()=>{
  console.log(`惡搞棋院 server listening on ${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin`);
  if(!auth.GOOGLE_CLIENT_ID) console.warn('⚠️  沒有設定 GOOGLE_CLIENT_ID，Google 登入會失敗');
  if(ADMIN_PASSWORD === 'changeme') console.warn('⚠️  ADMIN_PASSWORD 還是預設值，請務必更改');
});
