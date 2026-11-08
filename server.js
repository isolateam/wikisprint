// WIKISPRINT server: the daily sprint and party rooms, over plain HTTP.
// All state lives in Redis (Upstash) so it works on serverless hosts like Vercel,
// where every request may be handled by a different short-lived instance.
// With no Redis configured it falls back to a local file store for development.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;
const PUB = path.join(__dirname, 'public');
const STUDY_MS = 20_000;
const START_ELO = 1000;
const ROOM_TTL = 6 * 3600;        // rooms vanish after 6 idle hours
const DAY_TTL = 60 * 86400;       // daily results are kept for 60 days

// ---------- storage ----------
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

let pipeline;
if (REDIS_URL && REDIS_TOKEN) {
  pipeline = async cmds => {
    const r = await fetch(REDIS_URL.replace(/\/$/, '') + '/pipeline', {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(cmds.map(c => c.map(String))),
    });
    if (!r.ok) throw new Error('Redis HTTP ' + r.status);
    return (await r.json()).map(x => { if (x.error) throw new Error('Redis: ' + x.error); return x.result; });
  };
} else {
  pipeline = localStore();
  console.log('No Redis configured, using data/local-store.json');
}
const redis = async (...cmd) => (await pipeline([cmd]))[0];

// Minimal stand-in for the handful of Redis commands used here.
function localStore() {
  const FILE = path.join(__dirname, 'data', 'local-store.json');
  let s = {};
  try { s = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch {}
  let timer;
  const persist = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      try { fs.mkdirSync(path.dirname(FILE), { recursive: true }); fs.writeFileSync(FILE, JSON.stringify(s)); }
      catch (e) { console.error('Could not save local store:', e.message); }
    }, 200);
  };
  const live = k => { const e = s[k]; if (e && e.exp && e.exp < Date.now()) { delete s[k]; return null; } return e || null; };
  const hash = k => live(k) || (s[k] = { v: {}, exp: 0 });
  const run = ([cmd, k, ...a]) => {
    const e = live(k);
    switch (cmd.toUpperCase()) {
      case 'GET': return e ? e.v : null;
      case 'SET': {
        if (a.includes('NX') && e) return null;
        const ex = a.indexOf('EX');
        s[k] = { v: a[0], exp: ex >= 0 ? Date.now() + a[ex + 1] * 1000 : 0 };
        return 'OK';
      }
      case 'DEL': { let n = 0; for (const key of [k, ...a]) if (live(key)) { delete s[key]; n++; } return n; }
      case 'EXPIRE': if (e) { e.exp = Date.now() + a[0] * 1000; return 1; } return 0;
      case 'HSET': { const h = hash(k); let n = 0; for (let i = 0; i < a.length; i += 2) { if (!(a[i] in h.v)) n++; h.v[a[i]] = a[i + 1]; } return n; }
      case 'HSETNX': { const h = hash(k); if (a[0] in h.v) return 0; h.v[a[0]] = a[1]; return 1; }
      case 'HGET': return e && a[0] in e.v ? e.v[a[0]] : null;
      case 'HMGET': return a.map(f => (e && f in e.v ? e.v[f] : null));
      case 'HGETALL': return e ? Object.entries(e.v).flat() : [];
      case 'HDEL': { let n = 0; if (e) for (const f of a) if (f in e.v) { delete e.v[f]; n++; } return n; }
      case 'HINCRBY': { const h = hash(k); h.v[a[0]] = String(parseInt(h.v[a[0]] || '0', 10) + parseInt(a[1], 10)); return +h.v[a[0]]; }
      case 'ZADD': { const z = hash(k); for (let i = 0; i < a.length; i += 2) z.v[a[i + 1]] = +a[i]; return 1; }
      case 'ZREVRANGE': {
        if (!e) return [];
        const arr = Object.entries(e.v).sort((x, y) => y[1] - x[1]).slice(+a[0], +a[1] + 1);
        return a.includes('WITHSCORES') ? arr.flatMap(([m, sc]) => [m, String(sc)]) : arr.map(x => x[0]);
      }
      default: throw new Error('local store does not support ' + cmd);
    }
  };
  return async cmds => { const out = cmds.map(c => run(c.map(String))); persist(); return out; };
}

const hobj = arr => { const o = {}; for (let i = 0; i < (arr || []).length; i += 2) o[arr[i]] = arr[i + 1]; return o; };
const J = s => { try { return JSON.parse(s); } catch { return null; } };

// ---------- players (token -> profile) ----------
const pkey = t => 'p:' + t;
async function getProfiles(tokens) {
  if (!tokens.length) return {};
  const rows = await pipeline(tokens.map(t => ['HMGET', pkey(t), 'name', 'elo', 'wins', 'games']));
  const out = {};
  tokens.forEach((t, i) => {
    const [name, elo, wins, games] = rows[i];
    out[t] = { name: name || 'Player', elo: elo == null ? START_ELO : +elo, wins: +(wins || 0), games: +(games || 0) };
  });
  return out;
}
async function touchProfile(token, name) {
  const cmds = [['HSETNX', pkey(token), 'elo', START_ELO], ['HSETNX', pkey(token), 'name', name || 'Player']];
  if (name) cmds.push(['HSET', pkey(token), 'name', name]);
  await pipeline(cmds);
  return (await getProfiles([token]))[token];
}
const cleanName = n => String(n || '').trim().slice(0, 20) || undefined;

// ---------- wikipedia ----------
async function wikiApi(params) {
  const u = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({ format: 'json', formatversion: '2', ...params });
  const r = await fetch(u, { headers: { 'User-Agent': 'WikisprintGame/1.0 (https://www.wikisprint.online)' } });
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

// ---------- http helpers ----------
class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  if (req.body && typeof req.body === 'object') return Promise.resolve(req.body); // some hosts pre-parse
  return new Promise(resolve => {
    let s = '';
    req.on('data', c => { s += c; if (s.length > 1e5) req.destroy(); });
    req.on('end', () => resolve(J(s || '{}') || {}));
    req.on('error', () => resolve({}));
  });
}

// ================= DAILY SPRINT =================
// One start/target pair per UTC day, shared by every player. One attempt per player per day.
const EPOCH = Date.UTC(2026, 10, 8); // Sprint #1
const ABANDON_MS = 60 * 60_000;     // a run left open for an hour counts as a give-up
const todayKey = () => new Date().toISOString().slice(0, 10);
const prevDay = d => new Date(Date.parse(d) - 864e5).toISOString().slice(0, 10);
const dayNo = d => Math.round((Date.parse(d) - EPOCH) / 864e5) + 1;
const nextReset = () => { const n = new Date(); return Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate() + 1); };
// Score: start at 1000, lose 30 per click and 1 per 2 seconds. Finishing is always worth at least 50.
const sprintScore = (clicks, ms) => Math.max(50, Math.round(1000 - 30 * clicks - ms / 2000));
const attKey = d => 'd:att:' + d;

const dayCache = {};
async function getDay(d) {
  if (dayCache[d]) return dayCache[d];
  let day = J(await redis('GET', 'd:day:' + d));
  if (!day) {
    // several instances may race here: the first SET wins and everyone reads that one back
    const picked = { n: dayNo(d), ...(await pickArticles()) };
    await redis('SET', 'd:day:' + d, JSON.stringify(picked), 'NX', 'EX', DAY_TTL);
    day = J(await redis('GET', 'd:day:' + d));
  }
  return (dayCache[d] = day);
}

// Moves a run along by the clock. Returns true if it changed.
function promote(a, day, now) {
  let changed = false;
  if (a.status === 'study' && now >= a.studyEndsAt) { a.status = 'race'; a.path = [norm(day.start)]; changed = true; }
  if (a.status === 'race' && now - a.studyEndsAt > ABANDON_MS) { giveUp(a, now); changed = true; }
  return changed;
}
function giveUp(a, now) {
  a.status = 'dnf';
  a.clicks = Math.max(0, a.path.length - 1);
  a.ms = now - a.studyEndsAt;
}
const freshStats = () => ({ played: 0, finished: 0, streak: 0, maxStreak: 0, lastDate: null, totalClicks: 0 });

function report(d, token, day, all) {
  const list = Object.entries(all).map(([id, a]) => ({ id, ...a }));
  const fin = list.filter(a => a.status === 'done');
  const me = all[token];
  const done = me.status === 'done';
  const others = fin.filter(a => a.id !== token);
  const pct = f => (others.length ? Math.round(100 * others.filter(f).length / others.length) : null);
  const hist = Array(10).fill(0);
  fin.forEach(a => { hist[Math.min(Math.max(a.clicks, 1), 10) - 1]++; });
  const best = fin.slice().sort((a, b) => a.clicks - b.clicks || a.ms - b.ms)[0];
  const times = fin.map(a => a.ms).sort((a, b) => a - b);
  return {
    start: day.start, target: day.target,
    raced: list.filter(a => a.status !== 'study').length,
    finished: fin.length,
    rank: done ? 1 + fin.filter(a => a.score > me.score).length : null,
    fewerClicksThan: done ? pct(a => a.clicks > me.clicks) : null,
    fasterThan: done ? pct(a => a.ms > me.ms) : null,
    hist, myBucket: done ? Math.min(me.clicks, 10) - 1 : null,
    avgClicks: fin.length ? +(fin.reduce((s, a) => s + a.clicks, 0) / fin.length).toFixed(1) : null,
    medianMs: times.length ? times[Math.floor(times.length / 2)] : null,
    best: best && { name: best.name, clicks: best.clicks, ms: best.ms, path: best.path, you: best.id === token },
  };
}

async function loadAttempts(d) {
  const raw = hobj(await redis('HGETALL', attKey(d)));
  const all = {};
  for (const [t, v] of Object.entries(raw)) { const a = J(v); if (a) all[t] = a; }
  return all;
}

async function dailyState(token, d, day, all) {
  const now = Date.now();
  all = all || await loadAttempts(d);
  const a = all[token];
  if (a && promote(a, day, now)) await redis('HSET', attKey(d), token, JSON.stringify(a));
  const st = token ? J(await redis('HGET', 'd:stats', token)) : null;
  const today = todayKey();
  const top = Object.entries(all)
    .filter(([, x]) => x.status === 'done')
    .sort(([, x], [, y]) => y.score - x.score || x.ms - y.ms)
    .slice(0, 10)
    .map(([id, x]) => ({ name: x.name, clicks: x.clicks, ms: x.ms, score: x.score, you: id === token }));
  const out = {
    date: d, n: day.n, now, nextAt: nextReset(),
    players: Object.keys(all).length,
    top,
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
    if (a.status === 'done' || a.status === 'dnf') out.report = report(d, token, day, all);
  }
  return out;
}

async function handleDaily(route, b, token) {
  // runs started just before midnight finish against the day they started on
  const d = route === '/api/daily' || route === '/api/daily/begin' || !/^\d{4}-\d\d-\d\d$/.test(b.date || '') ? todayKey() : b.date;
  const day = await getDay(d);
  if (route === '/api/daily') return dailyState(token, d, day);
  if (!token) throw new HttpError(400, 'Missing player token.');

  if (route === '/api/daily/begin') {
    const prof = await touchProfile(token, cleanName(b.name));
    const now = Date.now();
    const fresh = { name: prof.name, beganAt: now, studyEndsAt: now + STUDY_MS, status: 'study', path: [] };
    // HSETNX makes "one attempt per day" hold even if begin is sent twice at once
    const created = await redis('HSETNX', attKey(d), token, JSON.stringify(fresh));
    if (created) {
      const st = J(await redis('HGET', 'd:stats', token)) || freshStats();
      st.played++;
      await pipeline([['HSET', 'd:stats', token, JSON.stringify(st)], ['EXPIRE', attKey(d), DAY_TTL]]);
    }
    return dailyState(token, d, day);
  }

  const a = J(await redis('HGET', attKey(d), token));
  if (!a) throw new HttpError(400, 'You have not started this sprint.');
  const now = Date.now();
  let changed = promote(a, day, now);
  if (route === '/api/daily/nav' && a.status === 'race') {
    const title = norm(b.title).slice(0, 300);
    if (title && a.path[a.path.length - 1] !== title) {
      a.path.push(title);
      changed = true;
      if (title === norm(day.target)) {
        a.status = 'done'; a.finishedAt = now;
        a.clicks = a.path.length - 1;
        a.ms = now - a.studyEndsAt;
        a.score = sprintScore(a.clicks, a.ms);
        const st = J(await redis('HGET', 'd:stats', token)) || freshStats();
        st.finished++; st.totalClicks += a.clicks;
        st.streak = st.lastDate === d ? st.streak : st.lastDate === prevDay(d) ? st.streak + 1 : 1;
        st.maxStreak = Math.max(st.maxStreak, st.streak);
        st.lastDate = d;
        await redis('HSET', 'd:stats', token, JSON.stringify(st));
      }
    }
  } else if (route === '/api/daily/giveup' && (a.status === 'race' || a.status === 'study')) {
    giveUp(a, now);
    changed = true;
  }
  if (changed) await redis('HSET', attKey(d), token, JSON.stringify(a));
  return dailyState(token, d, day);
}

// ================= PARTY ROOMS =================
// Clients poll /api/party/state about once a second. Phases are worked out from timestamps,
// so no server-side timers are needed. Each player only ever writes their own hash field,
// and only the host writes the room record, so concurrent requests don't overwrite each other.
const rk = code => 'r:' + code;
const ONLINE_MS = 8000;    // no poll for this long = shown as away
const DROP_MS = 120_000;   // no poll for this long = removed from the room

function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  return Array.from({ length: 4 }, () => A[Math.floor(Math.random() * A.length)]).join('');
}
function phaseOf(meta, winner, now) {
  if (meta.phase === 'loading' && now - meta.loadingAt > 30_000) return 'lobby';
  if (meta.phase !== 'round') return meta.phase;
  const r = meta.round;
  if (winner || meta.ended || now >= r.raceEndsAt) return 'results';
  return now < r.studyEndsAt ? 'study' : 'race';
}

// Loads everything about a room in two round trips and marks the caller as seen.
async function loadRoom(code, token) {
  const now = Date.now();
  const cmds = [['GET', rk(code)], ['HGETALL', rk(code) + ':pl'], ['HGETALL', rk(code) + ':seen']];
  if (token) cmds.unshift(['HSET', rk(code) + ':seen', token, now]);
  const res = await pipeline(cmds);
  if (token) res.shift();
  const meta = J(res[0]);
  if (!meta) throw new HttpError(404, 'That room no longer exists.');
  const pl = {}; for (const [t, v] of Object.entries(hobj(res[1]))) pl[t] = J(v) || {};
  const seen = {}; for (const [t, v] of Object.entries(hobj(res[2]))) seen[t] = +v;

  // forget players who haven't polled in a while
  const gone = Object.keys(pl).filter(t => t !== token && now - (seen[t] || pl[t].joinedAt || 0) > DROP_MS);
  if (gone.length) {
    await pipeline([['HDEL', rk(code) + ':pl', ...gone], ['HDEL', rk(code) + ':seen', ...gone]]);
    gone.forEach(t => delete pl[t]);
  }

  const n = meta.n || 0;
  const tokens = Object.keys(pl);
  const more = [['HGETALL', `${rk(code)}:paths:${n}`], ['GET', `${rk(code)}:win:${n}`], ['GET', `${rk(code)}:delta:${n}`]];
  const [pathsRaw, winner, deltaRaw] = await pipeline(more);
  const paths = {}; for (const [t, v] of Object.entries(hobj(pathsRaw))) paths[t] = J(v) || [];
  const profiles = await getProfiles(tokens);

  const online = t => now - (seen[t] || 0) < ONLINE_MS;
  // if the host has gone quiet, the longest-standing player who is still here takes over
  const byJoin = tokens.slice().sort((a, b) => (pl[a].joinedAt || 0) - (pl[b].joinedAt || 0));
  const hostId = pl[meta.host] && online(meta.host) ? meta.host : (byJoin.find(online) || meta.host);
  return { meta, pl, seen, paths, winner, deltas: J(deltaRaw) || {}, profiles, now, online, hostId, phase: phaseOf(meta, winner, now) };
}

function snapshot(R) {
  const { meta, pl, paths, winner, deltas, profiles, now, online, hostId, phase } = R;
  const r = meta.round;
  const inRound = meta.phase === 'round' && r;
  const players = Object.keys(pl).sort((a, b) => (pl[a].joinedAt || 0) - (pl[b].joinedAt || 0)).map(id => {
    const prog = inRound && r.participants.includes(id) ? (paths[id] || [r.start]) : null;
    return {
      id, name: profiles[id]?.name || pl[id].name || 'Player', elo: profiles[id]?.elo ?? START_ELO,
      connected: online(id), host: id === hostId,
      clicks: prog ? prog.length - 1 : 0, inRace: !!prog,
      path: phase === 'results' && prog ? prog : undefined,
      delta: phase === 'results' ? deltas[id] : undefined,
    };
  });
  return {
    code: meta.code, phase, hostId, settings: meta.settings, players, now,
    round: inRound ? {
      n: meta.n, target: r.target,
      start: phase === 'study' ? null : r.start,
      studyEndsAt: r.studyEndsAt, raceEndsAt: r.raceEndsAt,
      winner: winner || null,
    } : null,
    error: meta.phase === 'loading' && phase === 'lobby' ? 'Picking articles took too long. Try again.' : meta.error,
  };
}

const saveMeta = (code, meta) => pipeline([
  ['SET', rk(code), JSON.stringify(meta), 'EX', ROOM_TTL],
  ['EXPIRE', rk(code) + ':pl', ROOM_TTL], ['EXPIRE', rk(code) + ':seen', ROOM_TTL],
]);

async function applyElo(code, n, participants, winnerId) {
  const profiles = await getProfiles(participants);
  const deltas = {};
  if (participants.length > 1) {
    // Winner beats every other racer. Pair K shrinks as the field grows.
    const K = 40 / Math.sqrt(participants.length - 1);
    const w = profiles[winnerId];
    let gain = 0;
    for (const id of participants) {
      if (id === winnerId) continue;
      const expected = 1 / (1 + 10 ** ((profiles[id].elo - w.elo) / 400));
      const d = K * (1 - expected);
      gain += d;
      deltas[id] = -Math.round(d);
    }
    deltas[winnerId] = Math.round(gain);
    const cmds = [];
    for (const id of participants) {
      cmds.push(['HINCRBY', pkey(id), 'elo', deltas[id]], ['HINCRBY', pkey(id), 'games', 1]);
      cmds.push(['ZADD', 'lb', profiles[id].elo + deltas[id], id]);
    }
    cmds.push(['HINCRBY', pkey(winnerId), 'wins', 1]);
    await pipeline(cmds);
  }
  await redis('SET', `${rk(code)}:delta:${n}`, JSON.stringify(deltas), 'EX', ROOM_TTL);
}

async function handleParty(action, b, token) {
  if (!token) throw new HttpError(400, 'Missing player token.');
  const code = String(b.code || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 4);

  if (action === 'create') {
    const prof = await touchProfile(token, cleanName(b.name));
    for (let i = 0; i < 20; i++) {
      const c = newCode();
      const meta = { code: c, host: token, phase: 'lobby', settings: { raceMinutes: 10 }, n: 0 };
      if (await redis('SET', rk(c), JSON.stringify(meta), 'NX', 'EX', ROOM_TTL)) {
        await pipeline([
          ['HSET', rk(c) + ':pl', token, JSON.stringify({ name: prof.name, joinedAt: Date.now() })],
          ['EXPIRE', rk(c) + ':pl', ROOM_TTL],
        ]);
        return { lobby: snapshot(await loadRoom(c, token)) };
      }
    }
    throw new HttpError(500, 'Could not create a room. Try again.');
  }
  if (!code) throw new HttpError(400, 'Missing room code.');

  if (action === 'join') {
    if (!(await redis('GET', rk(code)))) throw new HttpError(404, 'No room with that code.');
    const prof = await touchProfile(token, cleanName(b.name));
    await redis('HSETNX', rk(code) + ':pl', token, JSON.stringify({ name: prof.name, joinedAt: Date.now() }));
    return { lobby: snapshot(await loadRoom(code, token)) };
  }
  if (action === 'leave') {
    await pipeline([['HDEL', rk(code) + ':pl', token], ['HDEL', rk(code) + ':seen', token]]);
    const left = hobj(await redis('HGETALL', rk(code) + ':pl'));
    if (!Object.keys(left).length) await redis('DEL', rk(code), rk(code) + ':pl', rk(code) + ':seen');
    return { left: true };
  }

  let R = await loadRoom(code, token);
  if (!R.pl[token] && action === 'state') {
    // dropped for being away too long (closed laptop, lost signal): let them back in
    const prof = await touchProfile(token);
    await redis('HSETNX', rk(code) + ':pl', token, JSON.stringify({ name: prof.name, joinedAt: Date.now() }));
    R = await loadRoom(code, token);
  }
  if (!R.pl[token]) throw new HttpError(404, 'You are not in this room.');
  const { meta, phase } = R;
  const isHost = R.hostId === token;
  if (isHost && meta.host !== token) meta.host = token; // persist a host hand-over on the next write

  switch (action) {
    case 'state': break;
    case 'settings':
      if (isHost && phase === 'lobby' && [3, 5, 10, 15].includes(b.raceMinutes)) {
        meta.settings.raceMinutes = b.raceMinutes; await saveMeta(code, meta);
      }
      break;
    case 'start': {
      if (!isHost || !(phase === 'lobby' || phase === 'results')) break;
      meta.phase = 'loading'; meta.loadingAt = Date.now(); meta.error = null;
      await saveMeta(code, meta);
      let picks;
      try { picks = await pickArticles(); }
      catch { meta.phase = 'lobby'; meta.error = 'Wikipedia did not answer. Try again.'; await saveMeta(code, meta); break; }
      const now = Date.now();
      const participants = Object.keys(R.pl).filter(t => t === token || R.online(t));
      meta.n = (meta.n || 0) + 1;
      meta.phase = 'round'; meta.ended = false; meta.error = null;
      meta.round = { ...picks, participants, studyEndsAt: now + STUDY_MS, raceEndsAt: now + STUDY_MS + meta.settings.raceMinutes * 60_000 };
      await pipeline([
        ['HSET', `${rk(code)}:paths:${meta.n}`, ...participants.flatMap(t => [t, JSON.stringify([picks.start])])],
        ['EXPIRE', `${rk(code)}:paths:${meta.n}`, ROOM_TTL],
      ]);
      await saveMeta(code, meta);
      break;
    }
    case 'toLobby':
      if (isHost && phase === 'results') { meta.phase = 'lobby'; await saveMeta(code, meta); }
      break;
    case 'abort':
      if (isHost && (phase === 'race' || phase === 'study')) { meta.ended = true; await saveMeta(code, meta); }
      break;
    case 'nav': {
      const r = meta.round;
      if (phase !== 'race' || !r.participants.includes(token)) break;
      const key = `${rk(code)}:paths:${meta.n}`;
      const p = J(await redis('HGET', key, token)) || [r.start];
      const title = norm(b.title).slice(0, 300);
      if (!title || p[p.length - 1] === title) break;
      p.push(title);
      await redis('HSET', key, token, JSON.stringify(p));
      if (title === norm(r.target)) {
        // SET NX: if two players arrive at the same moment, only one becomes the winner
        if (await redis('SET', `${rk(code)}:win:${meta.n}`, token, 'NX', 'EX', ROOM_TTL)) {
          await applyElo(code, meta.n, r.participants, token);
        }
      }
      break;
    }
    default: throw new HttpError(404, 'Unknown action.');
  }
  return { lobby: snapshot(await loadRoom(code, null)) };
}

// ---------- request routing ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

async function handleApi(req, res, url) {
  const b = req.method === 'POST' ? await readBody(req) : {};
  const token = String(b.token || url.searchParams.get('token') || '').slice(0, 64);
  const route = url.pathname.replace(/\/$/, '');

  if (route.startsWith('/api/daily')) return json(res, 200, await handleDaily(route, b, token));
  if (route.startsWith('/api/party/')) return json(res, 200, await handleParty(route.slice('/api/party/'.length), b, token));
  if (route === '/api/me') {
    if (!token) throw new HttpError(400, 'Missing player token.');
    return json(res, 200, { id: token, ...(await touchProfile(token, req.method === 'POST' ? cleanName(b.name) : undefined)) });
  }
  if (route === '/api/leaderboard') {
    const flat = await redis('ZREVRANGE', 'lb', 0, 14, 'WITHSCORES');
    const ids = flat.filter((_, i) => i % 2 === 0);
    const profiles = await getProfiles(ids);
    return json(res, 200, ids.map(id => profiles[id]).filter(p => p.games > 0)
      .map(p => ({ name: p.name, elo: p.elo, wins: p.wins, games: p.games })));
  }
  throw new HttpError(404, 'Not found.');
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname.startsWith('/api/')) {
    try { await handleApi(req, res, url); }
    catch (e) {
      if (!(e instanceof HttpError)) console.error(e);
      json(res, e.status || 500, { error: e instanceof HttpError ? e.message : 'Something went wrong. Try again.' });
    }
    return;
  }
  const file = path.normalize(path.join(PUB, url.pathname === '/' ? 'index.html' : url.pathname));
  if (!file.startsWith(PUB)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}

const server = http.createServer(handler);
server.listen(PORT, () => console.log(`WIKISPRINT running at http://localhost:${PORT}`));
module.exports = handler;
