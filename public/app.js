// WIKISPRINT client
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let token = store.get('rh_token');
if (!token) { token = (crypto.randomUUID?.() || Math.random().toString(36).slice(2) + Date.now().toString(36)); store.set('rh_token', token); }
let myName = store.get('rh_name') || 'Player ' + Math.floor(1000 + Math.random() * 9000);

let me = null, lobby = null, skew = 0;
let daily = null;        // latest /api/daily state
let inDaily = false;     // is the player currently in the daily flow?
let game = null;         // the round on screen: {mode, key, target, start, studyEndsAt, raceEndsAt, date}
let studyKey = null, raceKey = null;
let hist = [];           // local navigation stack during a race
let navBusy = false;
const AVATAR_COLORS = ['#ffe866', '#ffb9a6', '#b9d3ff', '#c6ebb2', '#e4c9ff', '#ffd59e', '#a9e4e0', '#f7c1dc'];
const colorFor = id => AVATAR_COLORS[[...id].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
const serverNow = () => Date.now() + skew;
const fmtClock = ms => { ms = Math.max(0, ms); const s = Math.floor(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtCountdown = ms => { ms = Math.max(0, ms); const s = Math.ceil(ms / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const fmtDuration = ms => { const m = Math.floor(ms / 60000); const h = Math.floor(m / 60); return h ? `${h}h ${m % 60}m` : `${m}m`; };
const avatar = p => `<span class="avatar" style="background:${colorFor(p.id)}">${esc(p.name[0]?.toUpperCase() || '?')}</span>`;
const ordinal = n => n + (['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th');
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

// ---------------- ui helpers ----------------
function show(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.toggle('active', s.id === 'scr-' + name));
  window.scrollTo(0, 0);
}
let toastT;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.classList.add('show');
  clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('show'), 2600);
}
function setUrlCode(code) {
  const u = new URL(location.href);
  if (code) u.searchParams.set('code', code); else u.searchParams.delete('code');
  history.replaceState(null, '', u);
}
function renderMe() {
  $('#tbName').textContent = me?.name || myName;
  const mine = lobby?.players.find(p => p.id === token);
  $('#tbElo').textContent = mine ? mine.elo : (me ? me.elo : '—');
  $('#tbStreak').textContent = daily?.stats?.streak ?? 0;
  $('#tbRoom').classList.toggle('hidden', !lobby);
}
const isHost = () => lobby && lobby.hostId === token;

function goHome() {
  inDaily = false; game = null;
  show('home');
  loadDaily();
  loadLeaderboard();
}
$('#brandLink').addEventListener('click', e => {
  e.preventDefault();
  if (lobby) { toast('Leave the room first'); return; }
  if (game && $('#scr-race').classList.contains('active')) { toast('Your daily run is still going. Use Give up to stop.'); return; }
  goHome();
});

// ---------------- party mode (HTTP polling) ----------------
// The host may be serverless, so rooms are kept up to date by asking the server about once a second.
let room = null;         // code of the room we're in
let pollTimer = null;
let pollSeq = 0;         // ignore poll answers that arrive after a newer action's answer

async function send(o) {
  const { t, ...rest } = o;
  try {
    if (t === 'rename') { me = await api('/api/me', { name: myName }); renderMe(); return; }
    if ((t !== 'create' && t !== 'join') && !room) return;
    const seq = ++pollSeq;
    const st = await api('/api/party/' + t, { ...rest, code: t === 'join' ? rest.code : room });
    if (st.left) { leftRoom(); return; }
    if (seq === pollSeq) onPartyState(st);
  } catch (e) {
    if (e.status === 404 && room) { leftRoom(e.message); return; }
    $('#homeErr').textContent = e.message; toast(e.message);
    if (t === 'join') setUrlCode(null);
  }
}
function onPartyState(st) {
  if (!st.lobby) return;
  room = st.lobby.code;
  skew = st.lobby.now - Date.now();
  lobby = st.lobby;
  onLobby();
  if (!pollTimer) schedulePoll();
}
function schedulePoll() {
  clearTimeout(pollTimer);
  const fast = lobby && (lobby.phase === 'study' || lobby.phase === 'race' || lobby.phase === 'loading');
  pollTimer = setTimeout(async () => {
    if (!room) { pollTimer = null; return; }
    const seq = ++pollSeq;
    try {
      const st = await api('/api/party/state', { code: room });
      if (seq === pollSeq && room) onPartyState(st);
    } catch (e) {
      if (e.status === 404) { leftRoom(e.message); return; }
    }
    if (room) schedulePoll(); else pollTimer = null;
  }, fast ? 800 : 1500);
}
function leftRoom(msg) {
  room = null; lobby = null;
  clearTimeout(pollTimer); pollTimer = null;
  $('#tbExpedition').textContent = '—';
  setUrlCode(null); renderMe(); goHome();
  if (msg) toast(msg);
}
async function loadMe() {
  try { store.set('rh_name', myName); me = await api('/api/me', { name: myName }); renderMe(); } catch {}
}

// ---------------- settings (gear in the top bar) ----------------
const FONTS = ['default', 'dyslexic'];
function applyFont(f) {
  if (!FONTS.includes(f)) f = 'default';
  if (f === 'default') delete document.documentElement.dataset.font;
  else document.documentElement.dataset.font = f;
  store.set('ws_font', f);
  document.querySelectorAll('input[name="font"]').forEach(i => { i.checked = i.value === f; });
}
applyFont(store.get('ws_font') || 'default');
document.querySelectorAll('input[name="font"]').forEach(i => i.addEventListener('change', () => applyFont(i.value)));

function toggleSettings(open) {
  const panel = $('#settings'), btn = $('#gearBtn');
  open = open ?? panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !open);
  btn.setAttribute('aria-expanded', String(open));
  if (open) panel.querySelector('input:checked')?.focus();
}
$('#gearBtn').addEventListener('click', e => { e.stopPropagation(); toggleSettings(); });
document.addEventListener('click', e => { if (!e.target.closest('#settings, #gearBtn')) toggleSettings(false); });
document.addEventListener('keydown', e => {
  if (e.key === 'Escape' && !$('#settings').classList.contains('hidden')) { toggleSettings(false); $('#gearBtn').focus(); }
});

// ---------------- home: party controls ----------------
$('#nameInput').value = myName;
let renameT;
$('#nameInput').addEventListener('input', e => {
  myName = e.target.value.trim().slice(0, 20) || myName;
  store.set('rh_name', myName);
  clearTimeout(renameT); renameT = setTimeout(() => send({ t: 'rename', name: myName }), 400);
});
$('#createBtn').onclick = () => send({ t: 'create' });
$('#joinBtn').onclick = () => {
  const code = $('#codeInput').value.trim().toUpperCase();
  if (code.length !== 4) { $('#homeErr').textContent = 'Room codes are 4 letters.'; return; }
  $('#homeErr').textContent = '';
  send({ t: 'join', code });
};
$('#codeInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('#joinBtn').click(); });
$('#codeInput').addEventListener('input', e => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z]/g, ''); });

async function loadLeaderboard() {
  try {
    const rows = await (await fetch('/api/leaderboard')).json();
    $('#leaderboard').innerHTML = rows.length
      ? rows.map(r => `<li><span class="n">${esc(r.name)}</span><span class="w">${r.wins}W / ${r.games}</span><span class="e">${r.elo}</span></li>`).join('')
      : '<li class="muted">No party games played yet.</li>';
  } catch { $('#leaderboard').innerHTML = '<li class="muted">Unavailable.</li>'; }
}

// ---------------- daily ----------------
async function api(path, body) {
  const opts = body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token, name: myName, ...body }) } : undefined;
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { const e = new Error(j.error || 'Request failed'); e.status = r.status; throw e; }
  return j;
}
async function loadDaily() {
  try { applyDaily(await api('/api/daily?token=' + encodeURIComponent(token))); }
  catch (e) { $('#dailyBody').innerHTML = `<p class="err">${esc(e.message)}</p><button class="btn" onclick="loadDaily()">Try again</button>`; }
}
function applyDaily(st) {
  daily = st;
  if (!lobby) skew = st.now - Date.now();
  renderMe();
  renderDailyHome();
  if (!inDaily) return;
  const a = st.attempt;
  if (!a) {
    // the server has no record of the run we're playing: say so instead of hanging
    if (game?.mode === 'daily') { goHome(); toast('The server lost track of your run. Please start again.'); }
    return;
  }
  const base = { mode: 'daily', key: 'd' + st.date, target: st.target, start: st.start, studyEndsAt: a.studyEndsAt, date: st.date };
  if (a.status === 'study') enterStudy(base);
  else if (a.status === 'race') enterRace(base, a.path);
  else renderReport();
}

function renderDailyHome() {
  const st = daily;
  const d = new Date(st.date + 'T00:00:00Z');
  $('#dailyDate').textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  $("#dailyNum").textContent = st.n;
  $('#dailyPlayers').textContent = st.players ? `${plural(st.players, 'player')} today` : 'Be the first today';
  const a = st.attempt;
  const nextIn = `Next sprint in ${fmtDuration(st.nextAt - serverNow())}`;
  let html;
  if (!a) {
    html = `<p class="daily-blurb">The target stays hidden until you start. Once you press play, you get 20 seconds to read it, then the clock runs until you arrive.</p>
      <button class="btn btn-primary btn-big" id="playDaily">Play today's sprint</button>
      <p class="muted small">One attempt per day. Everyone gets the same articles.</p>`;
  } else if (a.status === 'study' || a.status === 'race') {
    html = `<p class="daily-blurb">Your run is still going. The clock didn't stop while you were away.</p>
      <button class="btn btn-primary btn-big" id="playDaily">Resume your run</button>`;
  } else if (a.status === 'done') {
    const r = st.report;
    html = `<div class="done-line"><b>${plural(a.clicks, 'click')}</b><span>·</span><b>${fmtClock(a.ms)}</b><span>·</span><b>${a.score} pts</b></div>
      <p class="daily-blurb">You reached <em>${esc(st.target)}</em>${r.rank ? `, ranked ${ordinal(r.rank)} of ${r.finished}` : ''}.</p>
      <button class="btn btn-primary" id="playDaily">See your results</button>
      <p class="muted small">${nextIn}</p>`;
  } else {
    html = `<p class="daily-blurb">You gave up on today's sprint. The target was <em>${esc(st.target)}</em>.</p>
      <button class="btn" id="playDaily">See how others did</button>
      <p class="muted small">${nextIn}</p>`;
  }
  $('#dailyBody').innerHTML = html;
  $('#playDaily').onclick = startDaily;
  $('#dailyTop').innerHTML = st.top.length
    ? st.top.slice(0, 8).map(r => `<li class="${r.you ? 'you' : ''}"><span class="n">${esc(r.name)}</span><span class="w">${plural(r.clicks, 'click')} · ${fmtClock(r.ms)}</span><span class="e">${r.score}</span></li>`).join('')
    : '<li class="muted">Nobody has finished yet today.</li>';
}

async function startDaily() {
  if (lobby) { toast('Leave the room first'); return; }
  inDaily = true;
  try { applyDaily(daily.attempt ? await api('/api/daily?token=' + encodeURIComponent(token)) : await api('/api/daily/begin', {})); }
  catch (e) { inDaily = false; toast(e.message); }
}

$('#giveUpBtn').onclick = async () => {
  if (!confirm('Give up on today\'s sprint? You only get one attempt per day.')) return;
  try { applyDaily(await api('/api/daily/giveup', { date: game.date })); } catch (e) { toast(e.message); }
};

// ---------------- daily report ----------------
function renderReport() {
  game = null;
  show('report');
  const st = daily, a = st.attempt, r = st.report;
  const done = a.status === 'done';
  $('#repKicker').textContent = `Sprint #${st.n} · ${r.start} to ${r.target}`;
  $('#repHeadline').textContent = done
    ? (r.rank === 1 ? 'Top of the board.' : r.rank <= 3 ? 'On the podium.' : 'You made it.')
    : 'You gave up this time.';
  $('#repRoute').textContent = done
    ? `${plural(a.clicks, 'click')} in ${fmtClock(a.ms)}, ranked ${ordinal(r.rank)} of ${plural(r.finished, 'finisher')} so far.`
    : `${plural(r.finished, 'player')} of ${r.raced} reached the target today.`;

  const tiles = done
    ? [['Score', a.score], ['Clicks', a.clicks], ['Time', fmtClock(a.ms)], ['Rank', `${r.rank} / ${r.finished}`]]
    : [['Clicks made', a.clicks || 0], ['Finish rate', r.raced ? Math.round(100 * r.finished / r.raced) + '%' : '—'], ['Average clicks', r.avgClicks ?? '—'], ['Median time', r.medianMs != null ? fmtClock(r.medianMs) : '—']];
  $('#repStats').innerHTML = tiles.map(([k, v]) => `<div class="stat"><div class="label">${k}</div><b>${esc(v)}</b></div>`).join('');

  const lines = [];
  if (done && r.fewerClicksThan != null) {
    lines.push(`<p class="cmp"><b>${r.fewerClicksThan}%</b> of other finishers needed more clicks than you.</p>`);
    lines.push(`<p class="cmp"><b>${r.fasterThan}%</b> of other finishers were slower than you.</p>`);
  } else if (done) {
    lines.push('<p class="cmp">You\'re the first to finish today. Check back later to see how you stack up.</p>');
  }
  if (r.avgClicks != null) lines.push(`<p class="cmp muted">Today's average is ${r.avgClicks} clicks, and the median time is ${fmtClock(r.medianMs)}. ${r.raced ? `${Math.round(100 * r.finished / r.raced)}% of players who started reached the target.` : ''}</p>`);
  $('#repCompare').innerHTML = lines.join('');

  const max = Math.max(1, ...r.hist);
  $('#repHist').innerHTML = r.hist.map((n, i) => `
    <div class="hcol ${i === r.myBucket ? 'mine' : ''}" title="${n} finished in ${i === 9 ? '10 or more' : i + 1} clicks">
      <span class="hn">${n || ''}</span>
      <div class="hbar" style="height:${Math.max(n ? 6 : 2, Math.round(100 * n / max))}%"></div>
      <span class="hl">${i === 9 ? '10+' : i + 1}</span>
    </div>`).join('');

  const s = st.stats || {};
  $('#repHistory').innerHTML = [
    ['Played', s.played ?? 0], ['Finished', s.played ? Math.round(100 * (s.finished || 0) / s.played) + '%' : '—'],
    ['Current streak', s.streak ?? 0], ['Best streak', s.maxStreak ?? 0], ['Average clicks', s.avgClicks ?? '—'],
  ].map(([k, v]) => `<div><b>${v}</b><span>${k}</span></div>`).join('');

  const chips = (path, target) => path.map(t => `<span class="chip ${t === target ? 'goal' : ''}">${esc(t)}</span>`).join('<span class="arr">→</span>');
  $('#repMyPath').innerHTML = a.path.length ? chips(a.path, r.target) : '<span class="muted">You didn\'t make any clicks.</span>';
  if (r.best && !(done && r.best.you)) {
    $('#repBestBlock').classList.remove('hidden');
    $('#repBestLabel').textContent = `Shortest route today, by ${r.best.name} (${plural(r.best.clicks, 'click')}, ${fmtClock(r.best.ms)})`;
    $('#repBestPath').innerHTML = chips(r.best.path, r.target);
  } else if (r.best) {
    $('#repBestBlock').classList.remove('hidden');
    $('#repBestLabel').textContent = 'Shortest route today';
    $('#repBestPath').innerHTML = '<span class="muted">That\'s you. Nobody has beaten your route yet.</span>';
  } else $('#repBestBlock').classList.add('hidden');

  $('#repTop').innerHTML = st.top.length
    ? st.top.map(t => `<li class="${t.you ? 'you' : ''}"><span class="n">${esc(t.name)}</span><span class="w">${plural(t.clicks, 'click')}</span><span class="w">${fmtClock(t.ms)}</span><span class="e">${t.score}</span></li>`).join('')
    : '<li class="muted">Nobody has finished yet today.</li>';

  $('#shareBtn').classList.toggle('hidden', !done);
  $('#repNext').textContent = `Next sprint in ${fmtDuration(st.nextAt - serverNow())}`;
}
$('#shareBtn').onclick = async () => {
  const a = daily.attempt, r = daily.report;
  const text = `Wikisprint #${daily.n}\n${plural(a.clicks, 'click')} · ${fmtClock(a.ms)} · ${a.score} pts\nRanked ${r.rank} of ${r.finished}\n${location.origin}`;
  try { await navigator.clipboard.writeText(text); toast('Result copied'); } catch { toast(text); }
};
$('#reportHomeBtn').onclick = goHome;

// ---------------- party: lobby ----------------
$('#leaveBtn').onclick = () => send({ t: 'leave' });
$('#copyBtn').onclick = async () => {
  const link = `${location.origin}/?code=${lobby.code}`;
  try { await navigator.clipboard.writeText(link); toast('Invite link copied'); } catch { toast(link); }
};
$('#raceSeg').addEventListener('click', e => {
  const m = +e.target.dataset.m; if (m && isHost()) send({ t: 'settings', raceMinutes: m });
});
$('#startBtn').onclick = () => send({ t: 'start' });
$('#againBtn').onclick = () => send({ t: 'start' });
$('#toLobbyBtn').onclick = () => send({ t: 'toLobby' });
$('#abortBtn').onclick = () => { if (confirm('End this round for everyone? No Elo changes.')) send({ t: 'abort' }); };

function renderLobby() {
  $('#lobbyCode').textContent = lobby.code;
  $('#crewCount').textContent = lobby.players.length;
  $('#manifest').innerHTML = lobby.players.map(p => `
    <li>${avatar(p)}<span class="n">${esc(p.name)}</span>
      ${p.host ? '<span class="badge host">host</span>' : ''}
      ${p.id === token ? '<span class="badge you">you</span>' : ''}
      ${!p.connected ? '<span class="badge off">away</span>' : ''}
      <span class="e">${p.elo}</span></li>`).join('');
  document.querySelectorAll('#raceSeg button').forEach(b => {
    b.classList.toggle('on', +b.dataset.m === lobby.settings.raceMinutes);
    b.disabled = !isHost();
  });
  $('#startBtn').classList.toggle('hidden', !isHost());
  $('#waitHost').classList.toggle('hidden', isHost());
  $('#lobbyErr').textContent = lobby.error || '';
}

function onLobby() {
  inDaily = false;
  renderMe();
  setUrlCode(lobby.code);
  $('#tbExpedition').textContent = lobby.code;
  document.querySelectorAll('.hostonly').forEach(el => el.classList.toggle('hidden', !isHost()));
  document.querySelectorAll('.guestonly').forEach(el => el.classList.toggle('hidden', isHost()));
  const ph = lobby.phase, r = lobby.round;
  const base = r && { mode: 'party', key: 'p' + lobby.code + r.n, target: r.target, start: r.start, studyEndsAt: r.studyEndsAt, raceEndsAt: r.raceEndsAt };
  if (ph === 'lobby') { game = null; renderLobby(); show('lobby'); }
  else if (ph === 'loading') show('loading');
  else if (ph === 'study') enterStudy(base);
  else if (ph === 'race') { enterRace(base); renderRacers(); }
  else if (ph === 'results') { game = null; renderResults(); }
}

// ---------------- wikipedia ----------------
const NS = /^(File|Image|Category|Help|Special|Wikipedia|Template|Template talk|Portal|Talk|User|User talk|Draft|Module|MediaWiki|Book|TimedText|WP|Wikt|Wiktionary|Media):/i;
const artCache = new Map();
async function fetchArticle(title) {
  if (artCache.has(title)) return artCache.get(title);
  const u = 'https://en.wikipedia.org/w/api.php?' + new URLSearchParams({
    action: 'parse', format: 'json', formatversion: '2', origin: '*', redirects: '1',
    prop: 'text|displaytitle', disableeditsection: '1', disabletoc: '1', page: title,
  });
  const j = await (await fetch(u)).json();
  if (j.error) throw new Error(j.error.info);
  const art = { title: j.parse.title, display: j.parse.displaytitle, html: j.parse.text };
  artCache.set(title, art); artCache.set(art.title, art);
  return art;
}
const DROP_SECTIONS = /^(References|Notes|Citations|Sources|Bibliography|Footnotes|Notes_and_references|References_and_notes)$/i;
function renderArticle(el, art, sub) {
  const doc = new DOMParser().parseFromString(art.html, 'text/html');
  doc.querySelectorAll('script, style, link, .mw-editsection, sup.reference, .reflist, .mw-references-wrap').forEach(n => n.remove());
  doc.querySelectorAll('h2').forEach(h => {
    if (!DROP_SECTIONS.test(h.id)) return;
    const head = h.closest('.mw-heading') || h;
    let n = head.nextElementSibling;
    while (n && !(n.matches('h2, .mw-heading2'))) { const nx = n.nextElementSibling; n.remove(); n = nx; }
    head.remove();
  });
  doc.querySelectorAll('img').forEach(img => {
    for (const a of ['src', 'srcset']) { const v = img.getAttribute(a); if (v) img.setAttribute(a, v.replace(/(^|\s|,)\/\//g, '$1https://')); }
    img.loading = 'lazy';
  });
  doc.querySelectorAll('a').forEach(a => {
    const href = a.getAttribute('href') || '';
    const m = href.match(/^\/wiki\/([^?#]+)/);
    if (m && !a.classList.contains('new')) {
      let t; try { t = decodeURIComponent(m[1]).replace(/_/g, ' '); } catch { t = null; }
      if (t && !NS.test(t)) { a.classList.add('wl'); a.dataset.title = t; a.setAttribute('href', '#'); return; }
    }
    a.classList.add('dead'); a.removeAttribute('href');
  });
  el.innerHTML = `<h1 class="art-title">${art.display || esc(art.title)}</h1><div class="art-sub">${esc(sub)}</div>` + doc.body.innerHTML;
}

// ---------------- shared study / race ----------------
function setModeUI(mode) {
  document.querySelectorAll('.party-only').forEach(el => el.classList.toggle('mode-hidden', mode !== 'party'));
  document.querySelectorAll('.daily-only').forEach(el => el.classList.toggle('mode-hidden', mode !== 'daily'));
  $('#scr-race').classList.toggle('solo', mode === 'daily');
  $('#raceClockLabel').textContent = mode === 'daily' ? 'Time' : 'Time left';
}

async function enterStudy(g) {
  game = g; setModeUI(g.mode);
  if (!$('#scr-study').classList.contains('active')) show('study');
  $('#studyTitle').textContent = g.target;
  if (studyKey === g.key) return;
  studyKey = g.key;
  $('#studyArticle').innerHTML = '<p class="muted">Loading the target…</p>';
  try { renderArticle($('#studyArticle'), await fetchArticle(g.target), 'Read this page. Links are disabled until the race starts.'); }
  catch { $('#studyArticle').innerHTML = '<p>Couldn\'t load the article. You\'ll still race to it.</p>'; }
}

async function enterRace(g, path) {
  game = g; setModeUI(g.mode);
  if (!$('#scr-race').classList.contains('active')) show('race');
  $('#raceTarget').textContent = g.target;
  if (raceKey === g.key) return;
  raceKey = g.key;
  $('#peek').classList.add('hidden');
  if (path && path.length) { hist = path.slice(); await go(hist[hist.length - 1], { resume: true }); }
  else { hist = []; await go(g.start, { initial: true }); }
}

const racing = () => game && (game.mode === 'party' ? lobby?.phase === 'race' : daily?.attempt?.status === 'race');

async function go(title, { initial = false, back = false, resume = false } = {}) {
  if (navBusy) return;
  navBusy = true;
  const el = $('#raceArticle');
  el.classList.add('loading-page');
  try {
    const art = await fetchArticle(title);
    if (!racing()) return;
    if (!back && !resume) hist.push(art.title);
    renderArticle(el, art, hist.length <= 1 ? 'Starting article' : `Click ${hist.length - 1}`);
    window.scrollTo({ top: 0 });
    renderCrumbs();
    if (!initial && !resume) {
      if (game.mode === 'party') send({ t: 'nav', title: art.title });
      else applyDaily(await api('/api/daily/nav', { date: game.date, title: art.title }));
    }
  } catch (e) {
    toast('That page wouldn\'t load. Try another link.');
  } finally {
    el.classList.remove('loading-page');
    navBusy = false;
  }
}
$('#raceArticle').addEventListener('click', e => {
  const a = e.target.closest('a');
  if (!a) return;
  e.preventDefault();
  if (a.classList.contains('wl')) go(a.dataset.title);
});
$('#backBtn').onclick = () => {
  if (hist.length < 2 || navBusy) return;
  hist.pop();
  go(hist[hist.length - 1], { back: true });
};
$('#peekBtn').onclick = async () => {
  const t = game.target;
  $('#peekTitle').textContent = t; $('#peekText').textContent = '…';
  $('#peek').classList.remove('hidden');
  try {
    const j = await (await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(t.replace(/ /g, '_')))).json();
    $('#peekText').textContent = j.extract || 'No summary available.';
  } catch { $('#peekText').textContent = 'No summary available.'; }
};
$('#peekClose').onclick = () => $('#peek').classList.add('hidden');
$('#peek').addEventListener('click', e => { if (e.target.id === 'peek') $('#peek').classList.add('hidden'); });

function renderCrumbs() {
  $('#raceClicks').textContent = Math.max(0, hist.length - 1);
  $('#backBtn').disabled = hist.length < 2;
  const shown = hist.slice(-6);
  $('#crumbs').innerHTML = (hist.length > 6 ? '<span>…</span><span class="sep">/</span>' : '') +
    shown.map((t, i) => `<span class="${i === shown.length - 1 ? 'cur' : ''}">${esc(t)}</span>`).join('<span class="sep">/</span>');
}
function renderRacers() {
  const ps = lobby.players.filter(p => p.inRace).sort((a, b) => a.clicks - b.clicks);
  $('#racers').innerHTML = ps.map(p => `
    <li>${avatar(p)}<span class="n">${esc(p.name)}${p.id === token ? ' <span class="badge you">you</span>' : ''}</span>
    ${!p.connected ? '<span class="badge off">away</span>' : ''}<span class="c">${p.clicks}</span></li>`).join('')
    || '<li class="muted">You joined mid-race. You\'ll be in the next one.</li>';
}

// ---------------- party results ----------------
function renderResults() {
  show('results');
  const r = lobby.round;
  const winner = lobby.players.find(p => p.id === r.winner);
  $('#resKicker').textContent = `Race ${r.n} · ${r.start} to ${r.target}`;
  $('#resHeadline').textContent = winner ? `${winner.name} got there first.` : 'Nobody made it in time.';
  $('#resSub').textContent = winner ? `${plural(winner.clicks, 'click')} from start to finish.` : 'No Elo changes this round.';
  const ps = lobby.players.filter(p => p.path).sort((a, b) => (b.id === r.winner) - (a.id === r.winner) || a.clicks - b.clicks);
  $('#logbook').innerHTML = ps.map(p => {
    const d = p.delta;
    const dTxt = d == null ? '' : `<span class="d ${d >= 0 ? 'up' : 'down'}">${d >= 0 ? '+' : ''}${d}</span>`;
    const chips = p.path.map(t => `<span class="chip ${t === r.target ? 'goal' : ''}">${esc(t)}</span>`).join('<span class="arr">→</span>');
    return `<li><div class="row">${avatar(p)}<span class="n">${esc(p.name)}</span>
      ${p.id === r.winner ? '<span class="winner-flag">winner</span>' : ''}
      <span class="muted">${plural(p.clicks, 'click')}</span>${dTxt}<span class="e muted">${p.elo}</span></div>
      <div class="path">${chips}</div></li>`;
  }).join('') || '<li class="muted">Nobody raced.</li>';
}

// ---------------- clocks ----------------
let studyRefetching = false;
setInterval(() => {
  if (!game) return;
  const now = serverNow();
  if ($('#scr-study').classList.contains('active')) {
    const left = game.studyEndsAt - now;
    const s = Math.max(0, Math.ceil(left / 1000));
    $('#studyClock').textContent = s;
    $('.countdown').classList.toggle('urgent', s <= 5);
    $('#studyFill').style.width = Math.max(0, Math.min(100, left / 200)) + '%';
    // the daily has no server push: ask for the start article once study time is up
    if (game.mode === 'daily' && left <= 0 && !studyRefetching) {
      studyRefetching = true;
      api('/api/daily?token=' + encodeURIComponent(token)).then(applyDaily).catch(() => {}).finally(() => { studyRefetching = false; });
    }
  } else if ($('#scr-race').classList.contains('active')) {
    $('#raceClock').textContent = game.mode === 'daily' ? fmtClock(now - game.studyEndsAt) : fmtCountdown(game.raceEndsAt - now);
  }
}, 200);

show('home');
loadDaily();
loadLeaderboard();
renderMe();
loadMe();
{ const code = new URLSearchParams(location.search).get("code"); if (code) send({ t: "join", code }); }
