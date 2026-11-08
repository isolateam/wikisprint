// WIKISPRINT — multiplayer Wikipedia link race
const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const DATA = path.join(__dirname, 'data', 'players.json');
const STUDY_MS = 20_000;
const START_ELO = 1000;

// ---------- persistence (token -> {name, elo, wins, games}) ----------
let db = {};
try { db = JSON.parse(fs.readFileSync(DATA, 'utf8')); } catch {}
let saveTimer;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DATA), { recursive: true });
    fs.writeFileSync(DATA, JSON.stringify(db, null, 1));
  }, 300);
}
function profile(token, name) {
  if (!db[token]) db[token] = { name: name || 'Explorer', elo: START_ELO, wins: 0, games: 0 };
  if (name) db[token].name = name;
  save();
  return db[token];
}

// ---------- static files ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/daily')) {
    return handleDaily(req, res, url).catch(e => { console.error(e); json(res, 500, { error: 'Could not load today\'s sprint. Try again.' }); });
  }
  if (url.pathname === '/api/leaderboard') {
    const top = Object.values(db).filter(p => p.games > 0).sort((a, b) => b.elo - a.elo).slice(0, 15)
      .map(p => ({ name: p.name, elo: Math.round(p.elo), wins: p.wins, games: p.games }));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify(top));
  }
  let file = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
});

// ---------- wikipedia ----------
async function wikiApi(params) {
  const u = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const r = await fetch(u, { headers: { 'User-Agent': 'WikisprintGame/1.0 (self-hosted party game)' } });
  return r.json();
}
// Target: a long, substantial article (so it has plenty of inbound links).
// Start: a reasonably sized article (so it has plenty of outbound links).
async function pickArticles() {
  let target, start;
  for (let i = 0; i < 10 && !(target && start); i++) {
    const j = await wikiApi({ action: 'query', generator: 'random', grnnamespace: '0', grnlimit: '50', prop: 'info|pageprops', ppprop: 'disambiguation' });
    const pages = (j.query?.pages || []).filter(p => !p.pageprops && !/^(List of|Lists of)|\(disambiguation\)/i.test(p.title));
    pages.sort((a, b) => b.length - a.length);
    if (!target) target = pages.find(p => p.length > 25000)?.title;
    if (!start) start = pages.find(p => p.length > 8000 && p.title !== target)?.title;
  }
  if (!target || !start) throw new Error('Could not pick articles');
  return { target, start };
}
const norm = t => { t = String(t || '').replace(/_/g, ' ').split('#')[0].trim(); return t.charAt(0).toUpperCase() + t.slice(1); };

// ---------- daily sprint ----------
// One start/target pair per UTC day, shared by every player. One attempt per player per day.
const DAILY_FILE = path.join(__dirname, 'data', 'daily.json');
let daily = { days: {}, attempts: {}, stats: {} };
try { daily = { ...daily, ...JSON.parse(fs.readFileSync(DAILY_FILE, 'utf8')) }; } catch {}
let dailySaveTimer;
function saveDaily() {
  clearTimeout(dailySaveTimer);
  dailySaveTimer = setTimeout(() => {
    fs.mkdirSync(path.dirname(DAILY_FILE), { recursive: true });
    fs.writeFileSync(DAILY_FILE, JSON.stringify(daily));
  }, 300);
}
const EPOCH = Date.UTC(2026, 10, 8); // Sprint #1
const ABANDON_MS = 60 * 60_000;     // a run left open for an hour counts as a give-up
const todayKey = () => new Date().toISOString().slice(0, 10);
const prevDay = d => new Date(Date.parse(d) - 864e5).toISOString().slice(0, 10);
const dayNo = d => Math.round((Date.parse(d) - EPOCH) / 864e5) + 1;
const nextReset = () => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1); };
// Score: start at 1000, lose 30 per click and 1 per 2 seconds. Finishing is always worth at least 50.
const sprintScore = (clicks, ms) => Math.max(50, Math.round(1000 - 30 * clicks - ms / 2000));

const picking = {};
function getDay(d) {
  if (daily.days[d]) return Promise.resolve(daily.days[d]);
  if (!picking[d]) {
    picking[d] = pickArticles()
      .then(p => { daily.days[d] = { n: dayNo(d), ...p }; saveDaily(); return daily.days[d]; })
      .finally(() => { delete picking[d]; });
  }
  return picking[d];
}

function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise(resolve => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(s || '{}')); } catch { resolve({}); } });
  });
}

function promote(a, day, now) {
  if (a.status === 'study' && now >= a.studyEndsAt) { a.status = 'race'; a.path = [norm(day.start)]; saveDaily(); }
  if (a.status === 'race' && now - a.studyEndsAt > ABANDON_MS) giveUp(a);
}
function giveUp(a) {
  a.status = 'dnf';
  a.clicks = Math.max(0, a.path.length - 1);
  a.ms = Date.now() - a.studyEndsAt;
  saveDaily();
}
function finishDaily(a, token, d) {
  const now = Date.now();
  a.status = 'done'; a.finishedAt = now;
  a.clicks = a.path.length - 1;
  a.ms = now - a.studyEndsAt;
  a.score = sprintScore(a.clicks, a.ms);
  const st = daily.stats[token];
  st.finished++; st.totalClicks += a.clicks;
  st.streak = st.lastDate === d ? st.streak : st.lastDate === prevDay(d) ? st.streak + 1 : 1;
  st.maxStreak = Math.max(st.maxStreak, st.streak);
  st.lastDate = d;
}
const nameOf = (id, a) => db[id]?.name || a.name;

function topToday(d, token) {
  return Object.entries(daily.attempts[d] || {})
    .filter(([, a]) => a.status === 'done')
    .sort(([, a], [, b]) => b.score - a.score || a.ms - b.ms)
    .slice(0, 10)
    .map(([id, a]) => ({ name: nameOf(id, a), clicks: a.clicks, ms: a.ms, score: a.score, you: id === token }));
}

function report(d, token, day) {
  const all = Object.entries(daily.attempts[d] || {}).map(([id, a]) => ({ id, ...a }));
  const fin = all.filter(a => a.status === 'done');
  const me = daily.attempts[d][token];
  const done = me.status === 'done';
  const others = fin.filter(a => a.id !== token);
  const pct = f => (others.length ? Math.round(100 * others.filter(f).length / others.length) : null);
  const hist = Array(10).fill(0);
  fin.forEach(a => { hist[Math.min(Math.max(a.clicks, 1), 10) - 1]++; });
  const best = fin.slice().sort((a, b) => a.clicks - b.clicks || a.ms - b.ms)[0];
  const times = fin.map(a => a.ms).sort((a, b) => a - b);
  return {
    start: day.start, target: day.target,
    raced: all.filter(a => a.status !== 'study').length,
    finished: fin.length,
    rank: done ? 1 + fin.filter(a => a.score > me.score).length : null,
    fewerClicksThan: done ? pct(a => a.clicks > me.clicks) : null,
    fasterThan: done ? pct(a => a.ms > me.ms) : null,
    hist, myBucket: done ? Math.min(me.clicks, 10) - 1 : null,
    avgClicks: fin.length ? +(fin.reduce((s, a) => s + a.clicks, 0) / fin.length).toFixed(1) : null,
    medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
    best: best && { name: nameOf(best.id, best), clicks: best.clicks, ms: best.ms, path: best.path, you: best.id === token },
  };
}

function dailyState(token, d, day) {
  const now = Date.now();
  const a = daily.attempts[d]?.[token];
  if (a) promote(a, day, now);
  const st = daily.stats[token];
  const today = todayKey();
  const out = {
    date: d, n: day.n, now, nextAt: nextReset(),
    players: Object.keys(daily.attempts[d] || {}).length,
    top: topToday(d, token),
    stats: st && {
      played: st.played, finished: st.finished, maxStreak: st.maxStreak,
      streak: st.lastDate === today || st.lastDate === prevDay(today) ? st.streak : 0,
      avgClicks: st.finished ? +(st.totalClicks / st.finished).toFixed(1) : null,
    },
    attempt: null,
  };
  if (a) {
    out.target = day.target;
    out.start = a.status === 'study' ? null : day.start;
    out.attempt = { status: a.status, studyEndsAt: a.studyEndsAt, path: a.status === 'study' ? [] : a.path, clicks: a.clicks, ms: a.ms, score: a.score };
    if (a.status === 'done' || a.status === 'dnf') out.report = report(d, token, day);
  }
  return out;
}

async function handleDaily(req, res, url) {
  const b = req.method === 'POST' ? await readBody(req) : {};
  const token = String(b.token || url.searchParams.get('token') || '').slice(0, 64);
  const route = url.pathname;
  // runs started just before midnight finish against the day they started on
  const d = route === '/api/daily' || route === '/api/daily/begin' || !/^\d{4}-\d\d-\d\d$/.test(b.date || '') ? todayKey() : b.date;
  const day = await getDay(d);
  if (route === '/api/daily') return json(res, 200, dailyState(token, d, day));
  if (!token || req.method !== 'POST') return json(res, 400, { error: 'Bad request' });

  if (route === '/api/daily/begin') {
    daily.attempts[d] ??= {};
    if (!daily.attempts[d][token]) {
      const prof = profile(token, String(b.name || '').trim().slice(0, 20) || undefined);
      const now = Date.now();
      daily.attempts[d][token] = { name: prof.name, beganAt: now, studyEndsAt: now + STUDY_MS, status: 'study', path: [] };
      const st = daily.stats[token] ??= { played: 0, finished: 0, streak: 0, maxStreak: 0, lastDate: null, totalClicks: 0 };
      st.played++;
      saveDaily();
    }
    return json(res, 200, dailyState(token, d, day));
  }

  const a = daily.attempts[d]?.[token];
  if (!a) return json(res, 400, { error: 'You have not started this sprint.' });
  promote(a, day, Date.now());
  if (route === '/api/daily/nav' && a.status === 'race') {
    const title = norm(b.title).slice(0, 300);
    if (title && a.path[a.path.length - 1] !== title) {
      a.path.push(title);
      if (title === norm(day.target)) finishDaily(a, token, d);
      saveDaily();
    }
  } else if (route === '/api/daily/giveup' && (a.status === 'race' || a.status === 'study')) {
    giveUp(a);
  }
  return json(res, 200, dailyState(token, d, day));
}

// ---------- lobbies ----------
const lobbies = new Map();   // code -> lobby
const sockets = new Map();   // token -> ws
const tokenLobby = new Map(); // token -> code

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  let c;
  do { c = Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (lobbies.has(c));
  return c;
}

function snapshot(l) {
  const r = l.round;
  const players = [...l.players.values()].map(p => {
    const prof = db[p.id];
    const prog = r?.progress[p.id];
    return {
      id: p.id, name: prof.name, elo: Math.round(prof.elo), connected: p.connected, host: p.id === l.hostId,
      clicks: prog ? prog.path.length - 1 : 0, inRace: !!prog,
      // only reveal paths once the round is over
      path: l.phase === 'results' && prog ? prog.path : undefined,
      delta: l.phase === 'results' && r.deltas ? r.deltas[p.id] : undefined,
    };
  });
  return {
    code: l.code, phase: l.phase, hostId: l.hostId, settings: l.settings, players, now: Date.now(),
    round: r && {
      n: l.roundNo, target: r.target,
      start: l.phase === 'study' ? null : r.start,
      studyEndsAt: r.studyEndsAt, raceEndsAt: r.raceEndsAt,
      winner: r.winner, endedAt: r.endedAt,
    },
    error: l.error,
  };
}
function broadcast(l) {
  const msg = JSON.stringify({ t: 'lobby', lobby: snapshot(l) });
  for (const p of l.players.values()) {
    const ws = sockets.get(p.id);
    if (ws && ws.readyState === 1) ws.send(msg);
  }
}
function send(ws, obj) { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); }

function clearTimers(l) { (l.timers || []).forEach(clearTimeout); l.timers = []; }

async function startRound(l) {
  clearTimers(l);
  l.phase = 'loading'; l.error = null; l.round = null;
  broadcast(l);
  let picks;
  try { picks = await pickArticles(); }
  catch (e) { l.phase = 'lobby'; l.error = 'Wikipedia did not answer. Try again.'; return broadcast(l); }
  if (!lobbies.has(l.code)) return;
  l.roundNo = (l.roundNo || 0) + 1;
  const now = Date.now();
  const progress = {};
  for (const p of l.players.values()) if (p.connected) progress[p.id] = { path: [picks.start], done: false };
  l.round = { ...picks, progress, studyEndsAt: now + STUDY_MS, raceEndsAt: now + STUDY_MS + l.settings.raceMinutes * 60_000 };
  l.phase = 'study';
  broadcast(l);
  l.timers.push(setTimeout(() => { l.phase = 'race'; broadcast(l); }, STUDY_MS));
  l.timers.push(setTimeout(() => endRound(l, null), l.round.raceEndsAt - now));
}

function endRound(l, winnerId) {
  if (l.phase !== 'race' && l.phase !== 'study') return;
  clearTimers(l);
  const r = l.round;
  r.winner = winnerId; r.endedAt = Date.now();
  r.deltas = {};
  const ids = Object.keys(r.progress);
  if (winnerId && ids.length > 1) {
    // Winner beats every other racer. Pair K shrinks as the field grows.
    const K = 40 / Math.sqrt(ids.length - 1);
    const w = db[winnerId];
    let gain = 0;
    for (const id of ids) {
      if (id === winnerId) continue;
      const o = db[id];
      const expected = 1 / (1 + 10 ** ((o.elo - w.elo) / 400));
      const d = K * (1 - expected);
      gain += d;
      r.deltas[id] = -Math.round(d);
    }
    r.deltas[winnerId] = Math.round(gain);
    for (const id of ids) {
      db[id].elo += r.deltas[id];
      db[id].games++;
    }
    w.wins++;
    save();
  }
  l.phase = 'results';
  broadcast(l);
}

function leave(token) {
  const code = tokenLobby.get(token);
  const l = lobbies.get(code);
  tokenLobby.delete(token);
  if (!l) return;
  l.players.delete(token);
  if (l.players.size === 0) { clearTimers(l); lobbies.delete(code); return; }
  if (l.hostId === token) l.hostId = ([...l.players.values()].find(p => p.connected) || [...l.players.values()][0]).id;
  broadcast(l);
}

function join(token, l) {
  if (tokenLobby.get(token) && tokenLobby.get(token) !== l.code) leave(token);
  const existing = l.players.get(token);
  if (existing) existing.connected = true;
  else l.players.set(token, { id: token, connected: true });
  if (existing?.dropTimer) clearTimeout(existing.dropTimer);
  tokenLobby.set(token, l.code);
  broadcast(l);
}

const wss = new WebSocketServer({ server });
wss.on('connection', ws => {
  let token = null;
  ws.on('message', async raw => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.t === 'hello') {
      token = String(m.token || '').slice(0, 64);
      if (!token) return;
      const old = sockets.get(token);
      if (old && old !== ws) old.close();
      sockets.set(token, ws);
      const prof = profile(token, String(m.name || '').trim().slice(0, 20) || undefined);
      send(ws, { t: 'me', me: { id: token, name: prof.name, elo: Math.round(prof.elo), wins: prof.wins, games: prof.games } });
      const l = lobbies.get(tokenLobby.get(token));
      if (l) join(token, l); // reconnect
      return;
    }
    if (!token) return;
    const l = lobbies.get(tokenLobby.get(token));
    switch (m.t) {
      case 'rename': {
        const prof = profile(token, String(m.name || '').trim().slice(0, 20) || undefined);
        send(ws, { t: 'me', me: { id: token, name: prof.name, elo: Math.round(prof.elo), wins: prof.wins, games: prof.games } });
        if (l) broadcast(l);
        break;
      }
      case 'create': {
        const nl = { code: newCode(), hostId: token, players: new Map(), phase: 'lobby', settings: { raceMinutes: 10 }, timers: [] };
        lobbies.set(nl.code, nl);
        join(token, nl);
        break;
      }
      case 'join': {
        const target = lobbies.get(String(m.code || '').toUpperCase().trim());
        if (!target) return send(ws, { t: 'error', msg: 'No lobby with that code.' });
        join(token, target);
        break;
      }
      case 'leave': leave(token); send(ws, { t: 'left' }); break;
      case 'settings':
        if (l && l.hostId === token && l.phase === 'lobby' && [3, 5, 10, 15].includes(m.raceMinutes)) { l.settings.raceMinutes = m.raceMinutes; broadcast(l); }
        break;
      case 'start':
        if (l && l.hostId === token && (l.phase === 'lobby' || l.phase === 'results')) startRound(l);
        break;
      case 'toLobby':
        if (l && l.hostId === token && l.phase === 'results') { l.phase = 'lobby'; l.round = null; broadcast(l); }
        break;
      case 'abort':
        if (l && l.hostId === token && (l.phase === 'race' || l.phase === 'study')) endRound(l, null);
        break;
      case 'nav': {
        if (!l || l.phase !== 'race') return;
        const prog = l.round.progress[token];
        if (!prog || prog.done) return;
        const title = norm(m.title).slice(0, 300);
        if (!title || prog.path[prog.path.length - 1] === title) return;
        prog.path.push(title);
        if (title === norm(l.round.target)) { prog.done = true; return endRound(l, token); }
        broadcast(l);
        break;
      }
    }
  });
  ws.on('close', () => {
    if (!token || sockets.get(token) !== ws) return;
    sockets.delete(token);
    const l = lobbies.get(tokenLobby.get(token));
    if (!l) return;
    const p = l.players.get(token);
    if (!p) return;
    p.connected = false;
    broadcast(l);
    // give people a grace period to refresh / reconnect
    p.dropTimer = setTimeout(() => { if (!p.connected) leave(token); }, l.phase === 'lobby' ? 15_000 : 120_000);
  });
});

getDay(todayKey()).catch(() => {}); // pick today's articles ahead of the first visitor
server.listen(PORT, () => console.log(`WIKISPRINT running at http://localhost:${PORT}`));
