// Rappo(라포) 대화·통화 검색: 월별 카톡 노트와 통화 노트(요약·전사문)를 한 번에 검색하고, 날짜별로 펼쳐 본다.
// 노트 폴더는 이 플러그인 폴더의 data.json {"base": "..."} (Rappo 설치 프로그램이 적음). 없으면 '2. Areas/통화기록'.
// - ```대화검색``` (또는 ```카톡검색```) 코드블록 → 노트 안에 검색 화면
// - 명령 "대화·통화 검색" / 리본 아이콘 → 어디서나 창으로
const { Plugin, Modal, MarkdownRenderChild, TFile, debounce } = require('obsidian');

let KAKAO = '2. Areas/통화기록/카톡';
let CALLS = '2. Areas/통화기록/통화';
const DAY_RE = /^### (\d{4}-\d{2}-\d{2})/;
const MSG_RE = /^`(\d{2}:\d{2}(?::\d{2})?)` \*\*(.+?)\*\*: ?(.*)$/;
const LINK_RE = /\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g;
const PAGE = 100;
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

function clean(t) { return t.replace(/<br\s*\/?>/gi, ' ⏎ '); }
function weekday(d) { const x = new Date(d + 'T00:00:00'); return isNaN(x) ? '' : WEEK[x.getDay()]; }
function pad(v) { return String(v).padStart(2, '0'); }
function today() { const x = new Date(); return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; }
function when(d, t) {
  const td = today();
  const y = new Date(td + 'T00:00:00'); y.setDate(y.getDate() - 1);
  const yd = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`;
  if (d === td) return `오늘 ${t}`;
  if (d === yd) return `어제 ${t}`;
  if (d.slice(0, 4) === td.slice(0, 4)) return `${d.slice(5).replace('-', '/')} ${t}`;
  return d;
}
// 한글 초성 문자열 (ㅇㅁ → 엄마 같은 초성 검색용)
function chosung(s) {
  let o = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0) - 0xac00;
    o += c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch;
  }
  return o;
}
function matchName(name, q) {
  if (!q) return true;
  const n = name.toLowerCase().replace(/\s+/g, ''), k = q.toLowerCase().replace(/\s+/g, '');
  if (n.includes(k)) return true;
  return /^[ㄱ-ㅎ]+$/.test(k) && chosung(n).includes(k);
}
// [[엄마 (010-1234-5678)]] → 엄마 , [[010-1234-5678]] → 010-1234-5678
function contactName(v) {
  const s = String(v || '').replace(LINK_RE, '$1').trim();
  return s.replace(/\s*\([0-9-+ ]+\)\s*$/, '') || s;
}

// ---------- 색인 ----------
// 파일마다 {src:'kakao'|'call', room, kind, file, msgs:[{date,time,who,text,line,off?}], call?}
class Index {
  constructor(app) { this.app = app; this.files = new Map(); this.building = null; }

  srcOf(f) {
    if (!(f instanceof TFile) || f.extension !== 'md') return '';
    if (f.path.startsWith(KAKAO + '/') && /\d{4}-\d{2}$/.test(f.basename)) return 'kakao';
    if (f.path.startsWith(CALLS + '/')) return 'call';
    return '';
  }

  async parse(f, src) {
    const text = await this.app.vault.cachedRead(f);
    const fm = this.app.metadataCache.getFileCache(f)?.frontmatter || {};
    const lines = text.split('\n');
    const msgs = [];
    const entry = { mtime: f.stat.mtime, src, file: f, msgs };

    if (src === 'kakao') {
      entry.room = String(fm.room || f.parent?.name || f.basename.replace(/ \d{4}-\d{2}$/, ''));
      entry.kind = String(fm.kind || '') === '단체' ? '단체' : '카톡';
      let date = '';
      for (let i = 0; i < lines.length; i++) {
        const d = DAY_RE.exec(lines[i]);
        if (d) { date = d[1]; continue; }
        const m = MSG_RE.exec(lines[i]);
        if (m && date) {
          const who = m[2].replace(LINK_RE, '$1');
          msgs.push({ date, time: m[1], who, text: m[3], lower: m[3].toLowerCase(), line: i });
        }
      }
    } else {
      // 통화 노트: 날짜·시각은 datetime 속성(없으면 파일 이름 "YYYY-MM-DD HHMM ...")
      const fmName = String(fm.name || '').trim();
      const name = fmName && fmName !== '정보 없음' ? fmName
        : String(fm.phone || '') || contactName(fm.contact || f.basename.replace(/^\S+ \d{4} /, ''));
      let dt = String(fm.datetime || '');
      const b = /^(\d{4}-\d{2}-\d{2}) (\d{2})(\d{2})/.exec(f.basename);
      if (!/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(dt) && b) dt = `${b[1]}T${b[2]}:${b[3]}`;
      const date = dt.slice(0, 10), time = dt.slice(11, 16);
      entry.room = name;
      entry.kind = '통화';
      entry.call = { date, time, dur: String(fm.duration || '') };
      let sec = '';
      for (let i = 0; i < lines.length; i++) {
        const l = lines[i];
        if (/^## /.test(l)) { sec = l.slice(3).trim(); continue; }
        if (sec === '요약') {
          const t = l.replace(/^\s*[-*]\s+/, '').trim();
          if (t && t !== '(요약 없음)') msgs.push({ date, time, who: '요약', text: t, lower: t.toLowerCase(), line: i, off: '' });
        } else if (sec === '전사문') {
          const m = MSG_RE.exec(l);
          if (m) {
            const who = m[2] === '상대' ? name : m[2].replace(LINK_RE, '$1');
            msgs.push({ date, time, who, text: m[3], lower: m[3].toLowerCase(), line: i, off: m[1] });
          }
        }
      }
    }
    this.files.set(f.path, entry);
  }

  async ensure() {
    if (this.building) return this.building;
    this.building = (async () => {
      const targets = [];
      for (const f of this.app.vault.getMarkdownFiles()) { const s = this.srcOf(f); if (s) targets.push([f, s]); }
      const alive = new Set(targets.map(([f]) => f.path));
      for (const p of [...this.files.keys()]) if (!alive.has(p)) this.files.delete(p);
      for (const [f, s] of targets) {
        const c = this.files.get(f.path);
        if (!c || c.mtime !== f.stat.mtime) await this.parse(f, s);
      }
    })();
    try { await this.building; } finally { this.building = null; }
  }

  // 방·연락처 목록: [{name, kinds:Set, last}] — 최근 대화 순
  rooms() {
    const s = new Map();
    for (const c of this.files.values()) {
      const r = s.get(c.room) || { name: c.room, kinds: new Set(), last: '' };
      r.kinds.add(c.kind);
      const last = c.call ? c.call.date : (c.msgs.length ? c.msgs[c.msgs.length - 1].date : '');
      if (last > r.last) r.last = last;
      s.set(c.room, r);
    }
    // 단체방에서 말한 사람도 '사람'으로 (이름으로 고르면 그 사람이 단체방에서 한 말까지 보임)
    for (const c of this.files.values()) {
      if (c.kind !== '단체') continue;
      const seen = new Map();
      for (const m of c.msgs) if (m.who !== '나') seen.set(m.who, m.date);
      for (const [who, d] of seen) {
        const r = s.get(who) || { name: who, kinds: new Set(), last: '' };
        r.kinds.add('사람');
        if (d > r.last) r.last = d;
        s.set(who, r);
      }
    }
    return [...s.values()].sort((a, b) => b.last.localeCompare(a.last) || a.name.localeCompare(b.name, 'ko'));
  }

  // 0: 제외, 1: 그 방·연락처 전체, 2: 단체방에서 그 사람이 한 말만
  pick(c, room, src) {
    if (src && c.src !== src) return 0;
    if (!room || c.room === room) return 1;
    return c.kind === '단체' ? 2 : 0;
  }

  // q: 검색어(공백으로 여러 단어, 모두 포함), room, who, from/to, src('kakao'|'call'|'')
  search({ q, room, who, from, to, src }) {
    const terms = (q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const w = (who || '').trim();
    const out = [];
    for (const c of this.files.values()) {
      const k = this.pick(c, room, src);
      if (!k) continue;
      for (const m of c.msgs) {
        if (k === 2 && m.who !== room) continue;
        if (from && m.date < from) continue;
        if (to && m.date > to) continue;
        if (w && !m.who.includes(w)) continue;
        if (terms.length && !terms.every((t) => m.lower.includes(t) || m.who.toLowerCase().includes(t))) continue;
        out.push({ ...m, room: c.room, file: c.file, src: c.src, call: c.call });
      }
    }
    // 날짜는 최신 순, 같은 날 안에서는 대화 흐름대로(시간 순)
    out.sort((a, b) => b.date.localeCompare(a.date) || a.time.localeCompare(b.time) ||
      (a.file.path === b.file.path ? a.line - b.line : a.file.path.localeCompare(b.file.path)));
    return out;
  }

  // 특정 날짜: 카톡은 방별, 통화는 통화별 묶음 (시간 순)
  day(date, room, src) {
    const groups = [];
    for (const c of this.files.values()) {
      const k = this.pick(c, room, src);
      if (!k) continue;
      if (c.call) {
        if (c.call.date === date) groups.push({ c, msgs: c.msgs, first: c.call.time });
      } else {
        const ms = c.msgs.filter((m) => m.date === date);
        // 단체방은 그 사람이 그날 말했을 때만, 앞뒤 흐름이 보이게 그날 대화 전체를
        if (ms.length && (k === 1 || ms.some((m) => m.who === room))) groups.push({ c, msgs: ms, first: ms[0].time, person: k === 2 ? room : '' });
      }
    }
    return groups.sort((a, b) => a.first.localeCompare(b.first));
  }

  // 대화가 있는 가장 가까운 날 (dir: -1 이전, +1 다음)
  nearestDay(date, dir, room, src) {
    let best = '';
    const see = (d) => {
      if (dir < 0 ? d < date && d > best : d > date && (!best || d < best)) best = d;
    };
    for (const c of this.files.values()) {
      const k = this.pick(c, room, src);
      if (!k) continue;
      if (c.call) see(c.call.date); else for (const m of c.msgs) if (k === 1 || m.who === room) see(m.date);
    }
    return best;
  }

  // 최근 연락: 사람(또는 방)별 마지막 통화·마지막 카톡
  recent() {
    const by = new Map();
    const get = (name) => { if (!by.has(name)) by.set(name, { name, call: null, talk: null, group: false, calls: 0 }); return by.get(name); };
    for (const c of this.files.values()) {
      if (c.call) {
        const e = get(c.room), key = `${c.call.date} ${c.call.time}`;
        e.calls++;
        if (!e.call || key > e.call.key) {
          const sm = c.msgs.find((m) => m.who === '요약'), first = c.msgs.find((m) => m.who !== '요약');
          e.call = { key, date: c.call.date, time: c.call.time, dur: c.call.dur, file: c.file, line: 0,
            text: sm ? sm.text : first ? `${first.who}: ${first.text}` : '' };
        }
      } else if (c.msgs.length) {
        const m = c.msgs[c.msgs.length - 1], e = get(c.room), key = `${m.date} ${m.time}`;
        if (c.kind === '단체') e.group = true;
        if (!e.talk || key > e.talk.key) e.talk = { key, date: m.date, time: m.time, file: c.file, line: m.line, text: `${m.who}: ${m.text}` };
      }
    }
    return [...by.values()]
      .map((e) => ({ ...e, last: (e.call?.key || '') > (e.talk?.key || '') ? e.call.key : (e.talk?.key || '') }))
      .sort((a, b) => b.last.localeCompare(a.last));
  }

  latestDay() {
    let best = '';
    for (const c of this.files.values()) {
      const d = c.call ? c.call.date : (c.msgs.length ? c.msgs[c.msgs.length - 1].date : '');
      if (d > best) best = d;
    }
    return best || today();
  }
}

function kindIcon(kinds) {
  let s = '';
  if (kinds.has('단체')) s += '👥';
  if (kinds.has('카톡')) s += '💬';
  if (kinds.has('통화')) s += '📞';
  if (kinds.has('사람') && !kinds.has('카톡') && !kinds.has('통화')) s += '👤';
  return s;
}

// ---------- 방·연락처 입력 찾기 ----------
class RoomPicker {
  constructor(parent, rooms, value, onPick) {
    this.rooms = rooms; this.onPick = onPick; this.sel = 0; this.items = [];
    const wrap = parent.createDiv({ cls: 'ks-picker' });
    this.input = wrap.createEl('input', { type: 'text', cls: 'ks-room', placeholder: '방·연락처 찾기 (전체)' });
    this.input.value = value;
    this.clear = wrap.createEl('span', { cls: 'ks-clear', text: '✕', attr: { 'aria-label': '전체 보기' } });
    this.clear.toggle(!!value);
    this.list = wrap.createDiv({ cls: 'ks-suggest' });
    this.list.hide();
    this.input.onfocus = () => { this.input.select(); this.show(''); };
    this.input.oninput = () => this.show(this.input.value);
    this.input.onblur = () => setTimeout(() => { this.list.hide(); this.input.value = this.current || ''; }, 150);
    this.input.onkeydown = (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.sel = Math.max(0, Math.min(this.items.length - 1, this.sel + (e.key === 'ArrowDown' ? 1 : -1)));
        this.mark();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (this.items[this.sel] !== undefined) this.choose(this.items[this.sel]);
      } else if (e.key === 'Escape') { this.input.blur(); }
    };
    this.clear.onclick = () => this.choose('');
    this.current = value;
  }
  show(q) {
    const l = this.list;
    l.empty();
    const hits = this.rooms.filter((r) => matchName(r.name, q.trim()));
    this.items = q.trim() ? [] : [''];
    this.items.push(...hits.slice(0, 80).map((r) => r.name));
    this.sel = 0;
    if (!this.items.length) l.createDiv({ cls: 'ks-opt ks-muted', text: '일치하는 방·연락처가 없어요' });
    this.items.forEach((name, i) => {
      const r = this.rooms.find((x) => x.name === name);
      const o = l.createDiv({ cls: 'ks-opt' });
      if (!name) o.setText('전체 (모든 방·통화)');
      else if (!r.kinds.has('카톡') && !r.kinds.has('통화') && !r.kinds.has('단체')) {
        o.createSpan({ text: '👤 ', cls: 'ks-opt-icon' });
        o.createSpan({ text: name });
        o.createSpan({ text: ' 단체방 발언', cls: 'ks-muted' });
      }
      else {
        o.createSpan({ text: kindIcon(r.kinds) + ' ', cls: 'ks-opt-icon' });
        o.createSpan({ text: name });
        if (r.last) o.createSpan({ text: ` ${r.last}`, cls: 'ks-muted' });
      }
      o.onmousedown = (e) => { e.preventDefault(); this.choose(name); };
      o.dataset.i = i;
    });
    if (hits.length > 80) l.createDiv({ cls: 'ks-opt ks-muted', text: `… ${hits.length - 80}개 더 (더 입력해서 좁혀 보세요)` });
    this.mark();
    l.show();
  }
  mark() {
    this.list.querySelectorAll('.ks-opt').forEach((o) => o.toggleClass('is-selected', Number(o.dataset.i) === this.sel && o.dataset.i !== undefined));
    const cur = this.list.querySelector('.is-selected');
    if (cur) cur.scrollIntoView({ block: 'nearest' });
  }
  choose(name) {
    this.current = name;
    this.input.value = name;
    this.clear.toggle(!!name);
    this.list.hide();
    this.input.blur();
    this.onPick(name);
  }
}

// ---------- 화면 ----------
class SearchView {
  constructor(plugin, root, opts = {}) {
    this.plugin = plugin;
    this.app = plugin.app;
    this.root = root;
    this.onOpen = opts.onOpen || (() => {});
    this.state = { q: '', room: '', who: '', from: '', to: '', src: '', date: '', mode: 'search', shown: PAGE };
  }

  async render() {
    const r = this.root;
    r.empty();
    r.addClass('ks-root');
    const status = r.createDiv({ cls: 'ks-status', text: '대화·통화 색인 중…' });
    await this.plugin.index.ensure();
    status.remove();
    const idx = this.plugin.index;

    const top = r.createDiv({ cls: 'ks-tabs' });
    const tSearch = top.createEl('button', { text: '🔍 내용으로 찾기' });
    const tDay = top.createEl('button', { text: '📅 날짜로 보기' });
    tSearch.toggleClass('is-active', this.state.mode === 'search');
    tDay.toggleClass('is-active', this.state.mode === 'day');
    tSearch.onclick = () => { this.state.mode = 'search'; this.render(); };
    tDay.onclick = () => { this.state.mode = 'day'; if (!this.state.date) this.state.date = idx.latestDay(); this.render(); };
    top.createDiv({ cls: 'ks-spacer' });
    const seg = top.createDiv({ cls: 'ks-seg' });
    for (const [v, label] of [['', '전체'], ['kakao', '💬 카톡'], ['call', '📞 통화']]) {
      const b = seg.createEl('button', { text: label });
      b.toggleClass('is-active', this.state.src === v);
      b.onclick = () => { this.state.src = v; this.state.shown = PAGE; this.state.shownCall = PAGE; this.render(); };
    }

    const bar = r.createDiv({ cls: 'ks-bar' });
    new RoomPicker(bar, idx.rooms(), this.state.room, (name) => {
      this.state.room = name; this.state.shown = PAGE; this.state.shownCall = PAGE; this.refresh();
    });

    if (this.state.mode === 'search') this.searchBar(bar);
    else this.dayBar(bar);

    this.results = r.createDiv({ cls: 'ks-results' });
    this.refresh();
  }

  searchBar(bar) {
    const q = bar.createEl('input', { type: 'search', cls: 'ks-q', placeholder: '단어 검색 (선택 · 띄어쓰기로 여러 단어)' });
    q.value = this.state.q;
    const who = bar.createEl('input', { type: 'text', cls: 'ks-who', placeholder: '말한 사람' });
    who.value = this.state.who;
    const row = bar.createDiv({ cls: 'ks-range' });
    const from = row.createEl('input', { type: 'date' });
    row.createSpan({ text: '~' });
    const to = row.createEl('input', { type: 'date' });
    from.value = this.state.from; to.value = this.state.to;
    const clear = row.createEl('button', { text: '기간 지우기' });
    const go = debounce(() => {
      Object.assign(this.state, { q: q.value, who: who.value, from: from.value, to: to.value, shown: PAGE, shownCall: PAGE });
      this.refresh();
    }, 250, true);
    q.oninput = go; who.oninput = go; from.onchange = go; to.onchange = go;
    clear.onclick = () => { from.value = ''; to.value = ''; go(); };
  }

  dayBar(bar) {
    const row = bar.createDiv({ cls: 'ks-range' });
    const prev = row.createEl('button', { text: '◀ 이전', cls: 'ks-nav' });
    const date = row.createEl('input', { type: 'date' });
    const next = row.createEl('button', { text: '다음 ▶', cls: 'ks-nav' });
    date.value = this.state.date;
    date.onchange = () => { this.state.date = date.value; this.refresh(); };
    const jump = (dir) => {
      const s = this.state;
      const d = this.plugin.index.nearestDay(s.date, dir, s.room, s.src);
      if (d) { s.date = d; date.value = d; this.refresh(); }
    };
    prev.onclick = () => jump(-1);
    next.onclick = () => jump(1);
  }

  refresh() {
    const box = this.results;
    if (!box) return;
    box.empty();
    if (this.state.mode === 'day') return this.renderDay(box);
    const s = this.state;
    if (!s.q.trim() && !s.who.trim() && !s.from && !s.to && !s.room && !s.src) {
      box.createDiv({ cls: 'ks-hint', text: '방·연락처를 고르면 그 대화 전체가 최신 날짜부터 보여요. 단어를 입력하면 카톡과 통화 내용을 한 번에 찾아요.' });
      return;
    }
    const res = this.plugin.index.search(s);
    const calls = res.filter((m) => m.src === 'call'), talks = res.filter((m) => m.src !== 'call');
    const nCall = new Set(calls.map((m) => m.file.path)).size;
    if (!res.length) { box.createDiv({ cls: 'ks-hint', text: '찾은 내용이 없어요.' }); return; }
    const terms = s.q.toLowerCase().split(/\s+/).filter(Boolean);
    // 통화와 카톡을 따로 나눠서 (통화가 적으니 위에)
    if (calls.length) this.section(box, 'call', `📞 통화 ${nCall}건`, `${calls.length.toLocaleString()}줄`, calls, terms, 'shownCall');
    if (talks.length) this.section(box, 'kakao', '💬 카카오톡', `${talks.length.toLocaleString()}개 메시지`, talks, terms, 'shown');
  }

  section(box, kind, title, sub, list, terms, key) {
    const s = this.state;
    if (!s[key]) s[key] = PAGE;
    s.open = s.open || {};
    const det = box.createEl('details', { cls: `ks-section is-${kind}` });
    det.open = s.open[kind] !== false;
    det.ontoggle = () => { s.open[kind] = det.open; };
    const sum = det.createEl('summary', { cls: 'ks-section-head' });
    sum.createSpan({ text: title, cls: 'ks-section-title' });
    sum.createSpan({ text: ` ${sub}`, cls: 'ks-muted' });
    let lastDate = '', lastCall = '';
    for (const m of list.slice(0, s[key])) {
      if (m.date !== lastDate) {
        lastDate = m.date; lastCall = '';
        const h = det.createDiv({ cls: 'ks-date' });
        h.createSpan({ text: `${m.date} (${weekday(m.date)})` });
        const b = h.createEl('a', { text: '그날 전체 보기', cls: 'ks-daylink' });
        b.onclick = () => { Object.assign(this.state, { mode: 'day', date: m.date }); this.render(); };
      }
      if (m.src === 'call' && m.file.path !== lastCall) { lastCall = m.file.path; this.callHead(det, m); }
      this.msgRow(det, m, terms, m.src !== 'call' && (!s.room || m.room !== s.room));
    }
    if (list.length > s[key]) {
      const more = det.createEl('button', { text: `더 보기 (${(list.length - s[key]).toLocaleString()}개 남음)`, cls: 'ks-more' });
      more.onclick = () => { s[key] += PAGE; this.refresh(); };
    }
  }

  callHead(parent, m) {
    const h = parent.createDiv({ cls: 'ks-callhead' });
    h.createSpan({ text: `📞 ${m.room} · ${m.call.time}` + (m.call.dur ? ` · ${m.call.dur}` : '') });
    const a = h.createEl('a', { text: '통화 노트', cls: 'ks-daylink' });
    a.onclick = (e) => { e.stopPropagation(); this.open(m.file, 0); };
  }

  renderDay(box) {
    const s = this.state, d = s.date;
    if (!d) return;
    const groups = this.plugin.index.day(d, s.room, s.src);
    box.createDiv({ cls: 'ks-count', text: `${d} (${weekday(d)})` });
    if (!groups.length) {
      box.createDiv({ cls: 'ks-hint', text: '이날은 대화가 없어요. ◀ ▶ 로 대화가 있는 날로 이동할 수 있어요.' });
      return;
    }
    const calls = groups.filter((g) => g.c.call), talks = groups.filter((g) => !g.c.call);
    for (const [kind, title, gs] of [['call', `📞 통화 ${calls.length}건`, calls], ['kakao', `💬 카카오톡 ${talks.length}개 방`, talks]]) {
      if (!gs.length) continue;
      const sec = box.createDiv({ cls: `ks-section is-${kind}` });
      sec.createDiv({ cls: 'ks-section-head', text: title });
      for (const { c, msgs, person } of gs) {
        const det = sec.createEl('details', { cls: 'ks-dayroom' + (c.call ? ' is-call' : '') });
        if (gs.length <= 3 || s.room) det.open = true;
        const sum = det.createEl('summary');
        if (c.call) {
          sum.createSpan({ text: c.room, cls: 'ks-roomname' });
          sum.createSpan({ text: ` ${c.call.time}` + (c.call.dur ? ` · ${c.call.dur}` : ''), cls: 'ks-muted' });
        } else {
          sum.createSpan({ text: (c.kind === '단체' ? '👥 ' : '') + c.room, cls: 'ks-roomname' });
          sum.createSpan({ text: ` ${msgs.length}개`, cls: 'ks-muted' });
          if (person) sum.createSpan({ text: ` · ${person} 님 발언 표시`, cls: 'ks-muted' });
        }
        const open = sum.createEl('a', { text: '노트 열기', cls: 'ks-daylink' });
        open.onclick = (e) => { e.preventDefault(); this.open(c.file, c.call ? 0 : msgs[0].line - 1); };
        if (!msgs.length) det.createDiv({ cls: 'ks-hint', text: '(전사문 없음)' });
        for (const m of msgs) {
          const row = this.msgRow(det, { ...m, room: c.room, file: c.file, src: c.src }, [], false);
          if (person && m.who === person) row.addClass('is-target');
        }
      }
    }
  }

  msgRow(parent, m, terms, showRoom) {
    const isCall = m.src === 'call';
    const row = parent.createDiv({ cls: 'ks-msg' + (m.who === '나' ? ' is-me' : '') + (isCall ? ' is-call' : '') + (m.who === '요약' ? ' is-summary' : '') });
    row.createSpan({ text: isCall ? (m.off || '요약') : m.time, cls: 'ks-time' });
    if (showRoom && !isCall) row.createSpan({ text: m.room, cls: 'ks-roomtag' });
    if (m.who !== '요약') row.createSpan({ text: m.who, cls: 'ks-who-name' });
    const t = row.createSpan({ cls: 'ks-text' });
    this.highlight(t, clean(m.text), terms);
    row.onclick = () => this.open(m.file, m.line);
    return row;
  }

  highlight(el, text, terms) {
    if (!terms.length) { el.setText(text); return; }
    const low = text.toLowerCase();
    let i = 0;
    while (i < text.length) {
      let at = -1, len = 0;
      for (const t of terms) {
        const k = low.indexOf(t, i);
        if (k >= 0 && (at < 0 || k < at)) { at = k; len = t.length; }
      }
      if (at < 0) { el.appendText(text.slice(i)); break; }
      el.appendText(text.slice(i, at));
      el.createEl('mark', { text: text.slice(at, at + len) });
      i = at + len;
    }
  }

  async open(file, line) {
    this.onOpen();
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(file, { eState: { line: Math.max(0, line) } });
  }
}

class SearchModal extends Modal {
  constructor(plugin, preset) { super(plugin.app); this.plugin = plugin; this.preset = preset; }
  onOpen() {
    this.modalEl.addClass('ks-modal');
    this.titleEl.setText('Rappo 대화·통화 검색');
    this.view = new SearchView(this.plugin, this.contentEl, { onOpen: () => this.close() });
    if (this.plugin.lastState) Object.assign(this.view.state, this.plugin.lastState);
    if (this.preset) Object.assign(this.view.state, { q: '', who: '', from: '', to: '', src: '', mode: 'search', shown: PAGE, shownCall: PAGE }, this.preset);
    this.view.render();
  }
  onClose() { this.plugin.lastState = { ...this.view.state }; this.contentEl.empty(); }
}

// ---------- 최근 연락 (카톡·통화 구분 없이) ----------
class RecentView {
  constructor(plugin, root) { this.plugin = plugin; this.app = plugin.app; this.root = root; this.shown = 20; this.groups = false; }
  async render() {
    const r = this.root;
    r.empty();
    r.addClass('ks-root');
    const status = r.createDiv({ cls: 'ks-status', text: '최근 연락 정리 중…' });
    await this.plugin.index.ensure();
    status.remove();
    const bar = r.createDiv({ cls: 'ks-recent-bar' });
    const lab = bar.createEl('label', { cls: 'ks-check' });
    const cb = lab.createEl('input', { type: 'checkbox' });
    cb.checked = this.groups;
    lab.appendText(' 단체방 포함');
    cb.onchange = () => { this.groups = cb.checked; this.shown = 20; this.render(); };
    bar.createSpan({ cls: 'ks-muted', text: '이름을 누르면 그 사람과의 카톡·통화 전체, 📞/💬 를 누르면 그 노트가 열려요.' });
    const list = this.plugin.index.recent().filter((e) => this.groups || !e.group);
    const box = r.createDiv({ cls: 'ks-recent' });
    for (const e of list.slice(0, this.shown)) {
      const row = box.createDiv({ cls: 'ks-recent-row' });
      const top = row.createDiv({ cls: 'ks-recent-top' });
      const nm = top.createEl('a', { text: (e.group ? '👥 ' : '') + e.name, cls: 'ks-recent-name' });
      nm.onclick = () => new SearchModal(this.plugin, { room: e.name }).open();
      top.createSpan({ text: when(...e.last.split(' ')), cls: 'ks-recent-when' });
      const ch = row.createDiv({ cls: 'ks-recent-ch' });
      const latest = (e.call?.key || '') > (e.talk?.key || '') ? 'call' : 'talk';
      for (const [k, icon, v] of [['call', '📞', e.call], ['talk', '💬', e.talk]]) {
        if (!v) continue;
        const b = ch.createEl('a', { cls: 'ks-badge' + (k === latest ? ' is-latest' : '') });
        b.setText(`${icon} ${when(v.date, v.time)}` + (k === 'call' ? (v.dur ? ` · ${v.dur}` : '') + (e.calls > 1 ? ` · ${e.calls}건` : '') : ''));
        b.onclick = () => this.open(v.file, v.line);
      }
      const last = latest === 'call' ? e.call : e.talk;
      if (last?.text) row.createDiv({ cls: 'ks-recent-text', text: clean(last.text) });
    }
    if (list.length > this.shown) {
      const more = box.createEl('button', { text: `더 보기 (${list.length - this.shown}명 남음)`, cls: 'ks-more' });
      more.onclick = () => { this.shown += 20; this.render(); };
    }
  }
  async open(file, line) {
    await this.app.workspace.getLeaf(false).openFile(file, { eState: { line: Math.max(0, line) } });
  }
}

class RecentChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() { new RecentView(this.plugin, this.containerEl).render(); }
}

class BlockChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() { this.containerEl.addClass('ks-block'); new SearchView(this.plugin, this.containerEl).render(); }
}

module.exports = class RappoSearch extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    const base = String(data.base || '2. Areas/통화기록').replace(/\/+$/, '');
    KAKAO = base + '/카톡'; CALLS = base + '/통화';
    this.index = new Index(this.app);
    const handler = (src, el, ctx) => ctx.addChild(new BlockChild(this, el));
    for (const name of ['대화검색', '카톡검색', 'kakao-search']) this.registerMarkdownCodeBlockProcessor(name, handler);
    this.registerMarkdownCodeBlockProcessor('최근연락', (src, el, ctx) => ctx.addChild(new RecentChild(this, el)));
    this.addCommand({ id: 'open', name: 'Rappo 대화·통화 검색', callback: () => new SearchModal(this).open() });
    this.addRibbonIcon('message-circle', 'Rappo 대화·통화 검색', () => new SearchModal(this).open());
    // 바뀐 파일은 다음 검색 때 다시 읽는다 (mtime 비교)
    this.registerEvent(this.app.vault.on('delete', (f) => this.index.files.delete(f.path)));
    this.registerEvent(this.app.vault.on('rename', (f, old) => this.index.files.delete(old)));
  }
};
