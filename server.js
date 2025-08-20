/**
 * Realtime Bingo (QR Join + Leaderboard)
 * Single-file Node.js app using Express + Socket.IO
 * - Host creates a room, pastes 25 custom items, gets a QR code for players.
 * - Players scan QR (or open link), get a 5x5 unique bingo board, tap to toggle.
 * - Server computes completed line count (rows/cols/diagonals) and broadcasts a live leaderboard.
 *
 * How to run:
 *   1) Ensure Node.js >= 18
 *   2) npm init -y
 *   3) npm i express socket.io
 *   4) node server.js
 *   5) Open http://localhost:3000 in a browser to create a room
 *
 * Deploy easily to Render/Railway/Heroku (set PORT env var), or run on a local laptop and share via local network.
 */

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// In-memory state (simple & ephemeral)
/** @type {Record<string, Room>} */
const rooms = {};

/** @typedef {{
 *   title: string,
 *   items: string[], // length 25
 *   createdAt: number,
 *   players: Record<string, Player>, // key: socketId
 * }} Room */

/** @typedef {{
 *   id: string,        // socket.id
 *   name: string,
 *   board: string[][], // 5x5 items
 *   marks: boolean[][],
 *   lineCount: number,
 *   joinedAt: number,
 * }} Player */

// Utilities
function genRoomId() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function chunk5(a) {
  return [a.slice(0,5), a.slice(5,10), a.slice(10,15), a.slice(15,20), a.slice(20,25)];
}

function makeFalse5x5() {
  return Array.from({ length: 5 }, () => Array(5).fill(false));
}

function calcLineCount(marks) {
  let count = 0;
  // rows
  for (let r = 0; r < 5; r++) {
    if (marks[r].every(Boolean)) count++;
  }
  // cols
  for (let c = 0; c < 5; c++) {
    let ok = true;
    for (let r = 0; r < 5; r++) {
      if (!marks[r][c]) { ok = false; break; }
    }
    if (ok) count++;
  }
  // diagonals
  let d1 = true, d2 = true;
  for (let i = 0; i < 5; i++) {
    if (!marks[i][i]) d1 = false;
    if (!marks[i][4 - i]) d2 = false;
  }
  if (d1) count++;
  if (d2) count++;
  return count;
}

function sanitizeName(name) {
  const n = (name || '').toString().trim();
  return n.length ? n.slice(0, 40) : 'Player';
}

function broadcastLeaderboard(roomId) {
  const room = rooms[roomId];
  if (!room) return;
  const rows = Object.values(room.players).map(p => ({
    name: p.name,
    lineCount: p.lineCount,
    joinedAt: p.joinedAt,
  }));
  rows.sort((a, b) => {
    if (b.lineCount !== a.lineCount) return b.lineCount - a.lineCount;
    return a.joinedAt - b.joinedAt; // tiebreaker: who joined earlier
  });
  io.to(`room:${roomId}`).emit('leaderboard:update', {
    players: rows,
    timestamp: Date.now(),
  });
}

function encodeHTML(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;'
  })[c]);
}

// Routes
app.get('/', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(hostCreatorPage());
});

app.post('/api/create', (req, res) => {
  try {
    const title = (req.body.title || '').toString().trim() || 'Bingo';
    let raw = (req.body.items || '').toString();
    let items = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    if (items.length !== 25) {
      return res.status(400).json({ ok: false, error: '请提供恰好 25 个格子内容（每行一个）。' });
    }
    items = items.map(x => x.slice(0, 100));

    const roomId = genRoomId();
    rooms[roomId] = {
      title,
      items,
      createdAt: Date.now(),
      players: {},
    };

    const origin = getOrigin(req);
    const joinUrl = `${origin}/play?room=${roomId}`;
    const boardUrl = `${origin}/board?room=${roomId}`;
    res.json({ ok: true, roomId, joinUrl, boardUrl, title });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

app.get('/play', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const roomId = (req.query.room || '').toString();
  res.end(playerPage(roomId));
});

app.get('/board', (req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  const roomId = (req.query.room || '').toString();
  res.end(leaderboardPage(roomId));
});

function getOrigin(req) {
  const proto = req.headers['x-forwarded-proto'] || req.protocol;
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  return `${proto}://${host}`;
}

// Socket events
io.on('connection', (socket) => {
  // Player joins a room
  socket.on('player:join', ({ roomId, name }) => {
    const room = rooms[roomId];
    if (!room) {
      socket.emit('player:error', { message: '房间不存在或已关闭。' });
      return;
    }
    name = sanitizeName(name);

    // Generate a unique board per player by shuffling
    const shuffled = shuffle(room.items.slice());
    const board = chunk5(shuffled);
    const marks = makeFalse5x5();
    const player = {
      id: socket.id,
      name,
      board,
      marks,
      lineCount: 0,
      joinedAt: Date.now(),
    };
    room.players[socket.id] = player;

    socket.join(`room:${roomId}`);
    socket.data.roomId = roomId;

    socket.emit('player:board', {
      title: room.title,
      name: player.name,
      board: player.board,
      marks: player.marks,
      lineCount: player.lineCount,
    });

    broadcastLeaderboard(roomId);
  });

  // Player toggles a cell
  socket.on('player:toggle', ({ r, c }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    const player = room.players[socket.id];
    if (!player) return;

    if (r >= 0 && r < 5 && c >= 0 && c < 5) {
      player.marks[r][c] = !player.marks[r][c];
      player.lineCount = calcLineCount(player.marks);

      socket.emit('player:board', {
        title: room.title,
        name: player.name,
        board: player.board,
        marks: player.marks,
        lineCount: player.lineCount,
      });

      broadcastLeaderboard(roomId);
    }
  });

  socket.on('disconnect', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;
    const room = rooms[roomId];
    if (!room) return;
    delete room.players[socket.id];
    broadcastLeaderboard(roomId);
  });
});

// ---------------- HTML PAGES ----------------
function baseStyles() {
  return `
  :root { --bg:#0b1020; --card:#121a33; --muted:#a6b1d0; --accent:#5da8ff; --ok:#2ecc71; }
  *{ box-sizing:border-box; }
  html,body{ margin:0; padding:0; background:var(--bg); color:white; font-family:Inter,system-ui,Segoe UI,Roboto,Arial; }
  a{ color:var(--accent); }
  .wrap{ max-width:1000px; margin:0 auto; padding:24px; }
  .card{ background:var(--card); border-radius:18px; padding:20px; box-shadow:0 10px 30px rgba(0,0,0,.25); }
  h1,h2,h3{ margin:8px 0 12px; }
  label{ display:block; margin:12px 0 6px; color:var(--muted); font-size:14px; }
  input[type=text], textarea{ width:100%; padding:12px 14px; border-radius:12px; border:1px solid #2a355d; background:#0e1530; color:white; outline:none; }
  button{ cursor:pointer; border:0; padding:12px 16px; border-radius:12px; background:var(--accent); color:#06142d; font-weight:700; }
  button.secondary{ background:#2a355d; color:#d8def3; }
  .row{ display:flex; gap:16px; flex-wrap:wrap; }
  .col{ flex:1; min-width:280px; }
  .hint{ color:var(--muted); font-size:13px; }
  .grid{ display:grid; grid-template-columns:repeat(5,1fr); gap:8px; }
  .cell{ background:#0f1731; border:1px solid #2a355d; padding:14px; border-radius:12px; min-height:60px; display:flex; align-items:center; justify-content:center; text-align:center; font-size:14px; line-height:1.2; }
  .cell.touch{ user-select:none; -webkit-tap-highlight-color: transparent; }
  .cell.on{ background:#153652; border-color:#3f93ff; box-shadow:inset 0 0 0 2px #3f93ff; }
  .badge{ display:inline-block; padding:6px 10px; border-radius:999px; background:#1c274a; color:#bcd1ff; font-size:12px; }
  .leader{ display:grid; grid-template-columns: 1fr 80px; gap:10px; align-items:center; }
  .leader .name{ white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .leader .score{ text-align:right; font-weight:800; }
  .qr{ display:flex; align-items:center; justify-content:center; min-height:220px; background:#0f1731; border:1px dashed #2a355d; border-radius:12px; }
  .muted{ color:var(--muted); }
  @media (max-width:600px){ .cell{ min-height:54px; padding:10px; font-size:13px; } }
  `;
}

function hostCreatorPage() {
  return `<!doctype html><html lang="zh-CN"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>创建年会 Bingo 房间</title>
  <style>${baseStyles()}</style>
  <script src="/socket.io/socket.io.js"></script>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js"></script>
  </head><body>
    <div class="wrap">
      <div class="card">
        <h1>创建年会 Bingo</h1>
        <p class="hint">粘贴 <b>25</b> 个格子内容（每行一个），参会者扫码即可加入；大屏幕使用“排行榜链接”。</p>
        <div class="row">
          <div class="col">
            <label>活动标题</label>
            <input id="title" type="text" placeholder="例如：2025 年会 · 超级 Bingo" />
            <label>25 个格子内容（每行一个）</label>
            <textarea id="items" rows="12" placeholder="示例：\n认识 3 位不同部门同事\n和 HR 合影\n回答关于公司使命的问答\n……（共 25 条）"></textarea>
            <div style="display:flex; gap:8px; margin-top:12px;">
              <button id="create">创建房间</button>
              <button class="secondary" id="demo">一键填充示例</button>
            </div>
            <p class="hint" id="msg"></p>
          </div>
          <div class="col">
            <label>玩家扫码加入</label>
            <div id="qr" class="qr">等待创建房间…</div>
            <div style="margin-top:12px;">
              <div class="hint">加入链接：</div>
              <div id="joinLink" class="muted" style="word-break:break-all;"></div>
            </div>
            <div style="margin-top:12px; display:flex; gap:8px;">
              <a id="openBoard" class="badge" target="_blank" href="#">打开排行榜</a>
              <button class="secondary" id="copy">复制加入链接</button>
            </div>
          </div>
        </div>
      </div>
    </div>

    <script>
      const msg = document.getElementById('msg');
      const qrBox = document.getElementById('qr');
      let qrobj = null;

      function showQR(text){
        qrBox.innerHTML = '';
        qrobj = new QRCode(qrBox, { text, width:220, height:220 });
      }

      document.getElementById('demo').onclick = () => {
        const sample = [
          '找到与自己同月生日的人','与陌生人击掌','分享一个工作小技巧','和主管自拍','说出公司三大价值观',
          '说出一个你崇拜的同事','完成 10 次深呼吸','夸奖别人','告诉别人你的隐藏技能','找到同名同姓',
          '参与抽奖','说出一个你最喜欢的项目','找 3 个人组成拍照手势','喝一口水','讲一个冷笑话',
          '认识一位 IT 同事','认识一位 HR 同事','认识一位 Finance 同事','认识一位新同事','认识一位老同事',
          '找到今天穿红色的人','写下 2026 心愿','和同事互换名片','与陌生人对视 5 秒','和别人互换座位'
        ];
        document.getElementById('items').value = sample.join('\n');
        if(!document.getElementById('title').value) document.getElementById('title').value = '2025 年会 · 超级 Bingo';
      };

      document.getElementById('create').onclick = async () => {
        msg.textContent = '';
        const title = document.getElementById('title').value.trim() || 'Bingo';
        const items = document.getElementById('items').value.trim();
        const lines = items.split(/\n/).filter(Boolean);
        if(lines.length !== 25){ msg.textContent = '需要恰好 25 条（当前 '+lines.length+' 条）'; return; }
        const res = await fetch('/api/create', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ title, items }) });
        const data = await res.json();
        if(!data.ok){ msg.textContent = data.error || '创建失败'; return; }
        const { roomId, joinUrl, boardUrl } = data;
        showQR(joinUrl);
        document.getElementById('joinLink').textContent = joinUrl;
        const openBoard = document.getElementById('openBoard');
        openBoard.href = boardUrl;
        openBoard.className = 'badge';
        openBoard.textContent = '打开排行榜';
        document.getElementById('copy').onclick = async () => {
          await navigator.clipboard.writeText(joinUrl);
          msg.textContent = '已复制加入链接';
        };
      };
    </script>
  </body></html>`;
}

function playerPage(roomId) {
  const safeRoom = encodeHTML(roomId || '');
  return `<!doctype html><html lang="zh-CN"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>加入 Bingo</title>
  <style>${baseStyles()}</style>
  <script src="/socket.io/socket.io.js"></script>
  </head><body>
    <div class="wrap">
      <div class="card">
        <h2 id="title">Bingo</h2>
        <div class="row" style="align-items:flex-end;">
          <div class="col">
            <label>你的名字</label>
            <input id="name" type="text" placeholder="请输入你的名字" />
          </div>
          <div class="col" style="display:flex; gap:8px;">
            <button id="join">加入房间</button>
            <span class="badge" id="room">房间：${safeRoom || '未指定'}</span>
          </div>
        </div>
        <p class="hint" id="hint">加入后将生成你的 5×5 卡面，点击格子即可勾选。</p>
        <div id="boardWrap" style="display:none; margin-top:12px;">
          <div style="display:flex; align-items:center; justify-content:space-between; margin-bottom:10px;">
            <span class="badge">完成的线：<b id="lines">0</b></span>
          </div>
          <div id="grid" class="grid"></div>
        </div>
        <p class="hint" id="msg"></p>
      </div>
    </div>

    <script>
      const socket = io();
      const qsRoom = '${safeRoom}';
      const nameInput = document.getElementById('name');
      const joinBtn = document.getElementById('join');
      const msg = document.getElementById('msg');
      const hint = document.getElementById('hint');
      const titleEl = document.getElementById('title');
      const gridEl = document.getElementById('grid');
      const wrap = document.getElementById('boardWrap');
      const linesEl = document.getElementById('lines');

      let marks = Array.from({length:5},()=>Array(5).fill(false));

      joinBtn.onclick = () => {
        const name = nameInput.value.trim() || 'Player';
        if(!qsRoom){ msg.textContent = '链接缺少 room 参数'; return; }
        socket.emit('player:join', { roomId: qsRoom, name });
      };

      socket.on('player:error', (e)=>{ msg.textContent = e.message || '加入失败'; });

      socket.on('player:board', ({ title, name, board, marks: m, lineCount }) => {
        titleEl.textContent = title + ' · ' + name;
        marks = m;
        renderGrid(board, marks);
        linesEl.textContent = lineCount;
        wrap.style.display = 'block';
        hint.style.display = 'none';
        msg.textContent = '';
      });

      function renderGrid(board, marks){
        gridEl.innerHTML = '';
        for(let r=0;r<5;r++){
          for(let c=0;c<5;c++){
            const div = document.createElement('div');
            div.className = 'cell touch' + (marks[r][c] ? ' on' : '');
            div.textContent = board[r][c];
            div.onclick = ()=>{ socket.emit('player:toggle', { r, c }); };
            gridEl.appendChild(div);
          }
        }
      }
    </script>
  </body></html>`;
}

function leaderboardPage(roomId) {
  const safeRoom = encodeHTML(roomId || '');
  return `<!doctype html><html lang="zh-CN"><head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width,initial-scale=1" />
  <title>Bingo 排行榜</title>
  <style>${baseStyles()}</style>
  <script src="/socket.io/socket.io.js"></script>
  </head><body>
    <div class="wrap">
      <div class="card">
        <h1>排行榜</h1>
        <p class="hint">房间：<b>${safeRoom || '未指定'}</b>（将此页面投到大屏幕）</p>
        <div id="list" style="margin-top:10px;">
          <p class="muted">等待玩家加入…</p>
        </div>
      </div>
    </div>

    <script>
      const socket = io();
      const room = '${safeRoom}';
      const list = document.getElementById('list');
      if(room){ socket.emit('player:join', { roomId: room, name: 'Display' }); }

      socket.on('leaderboard:update', ({ players }) => {
        if(!players || !players.length){ list.innerHTML = '<p class="muted">暂无玩家</p>'; return; }
        const frag = document.createDocumentFragment();
        players.forEach((p, i) => {
          const row = document.createElement('div');
          row.className = 'leader';
          const name = document.createElement('div');
          name.className = 'name';
          name.textContent = (i+1) + '. ' + p.name;
          const score = document.createElement('div');
          score.className = 'score';
          score.textContent = p.lineCount + ' 线';
          row.appendChild(name);
          row.appendChild(score);
          frag.appendChild(row);
        });
        list.innerHTML = '';
        list.appendChild(frag);
      });
    </script>
  </body></html>`;
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Bingo server running on http://localhost:${PORT}`);
});
