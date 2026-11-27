// Rappo(라포) 대화·통화 검색: 월별 카톡 노트와 통화 노트(요약·전사문)를 한 번에 검색하고, 날짜별로 펼쳐 본다.
// 노트 폴더는 이 플러그인 폴더의 data.json {"base": "..."} (Rappo 설치 프로그램이 적음). 없으면 '2. Areas/통화기록'.
// - ```대화검색``` (또는 ```카톡검색```) 코드블록 → 노트 안에 검색 화면
// - 명령 "대화·통화 검색" / 리본 아이콘 → 어디서나 창으로
const { Plugin, Modal, MarkdownRenderChild, MarkdownView, TFile, Notice, debounce } = require('obsidian');

let BASE = '2. Areas/통화기록';
let CONTACTS = BASE + '/연락처';
let KAKAO = '2. Areas/통화기록/카톡';
let CALLS = '2. Areas/통화기록/통화';
const DAY_RE = /^### (\d{4}-\d{2}-\d{2})/;
const MSG_RE = /^`(\d{2}:\d{2}(?::\d{2})?)` \*\*(.+?)\*\*: ?(.*)$/;
const LINK_RE = /\[\[(?:[^\]|]*\|)?([^\]]+)\]\]/g;
const PAGE = 100;
const CALL_PLAN_RE = /^\s*(?:[-*]\s+)?📅\s*(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}:\d{2}))?\s+(.+)$/;
const TODO_RE = /^\s*[-*]\s+\[([ xX])\]\s+(.+)$/;
const DAY_MS = 86400000;
function daysSince(d) { const x = new Date(d + 'T00:00:00'); return isNaN(x) ? 0 : Math.round((new Date(today() + 'T00:00:00') - x) / DAY_MS); }
const WEEK = ['일', '월', '화', '수', '목', '금', '토'];
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';

// 설명은 접어 두고 ⓘ 를 누르면 펼친다
function helpTip(bar, text) {
  const a = bar.createEl('a', { cls: 'ks-help', text: 'ⓘ', attr: { 'aria-label': '설명 보기' } });
  const box = bar.createDiv({ cls: 'ks-help-text ks-muted', text });
  box.hide();
  a.onclick = () => box.toggle(!box.isShown());
  return a;
}
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
    const entry = { mtime: f.stat.mtime, src, file: f, msgs, todos: [], plans: [] };

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
          const td = TODO_RE.exec(l);
          if (td) entry.todos.push({ done: td[1] !== ' ', text: td[2].trim(), line: i });
          const pl = CALL_PLAN_RE.exec(l);
          if (pl) entry.plans.push({ date: pl[1], time: pl[2] ? pl[2].padStart(5, '0') : '', text: pl[3].trim(), line: i });
          const t = l.replace(/^\s*[-*]\s+/, '').replace(/^\[[ xX]\]\s*/, '').trim();
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
    const get = (name) => { if (!by.has(name)) by.set(name, { name, call: null, talk: null, group: false, calls: 0, days: new Set() }); return by.get(name); };
    for (const c of this.files.values()) {
      if (c.call) {
        const e = get(c.room), key = `${c.call.date} ${c.call.time}`;
        e.calls++;
        if (c.call.date) e.days.add(c.call.date);
        if (!e.call || key > e.call.key) {
          const sm = c.msgs.find((m) => m.who === '요약'), first = c.msgs.find((m) => m.who !== '요약');
          e.call = { key, date: c.call.date, time: c.call.time, dur: c.call.dur, file: c.file, line: 0,
            text: sm ? sm.text : first ? `${first.who}: ${first.text}` : '' };
        }
      } else if (c.msgs.length) {
        const m = c.msgs[c.msgs.length - 1], e = get(c.room), key = `${m.date} ${m.time}`;
        if (c.kind === '단체') e.group = true;
        for (const x of c.msgs) if (x.who !== '나') e.days.add(x.date);
        if (!e.talk || key > e.talk.key) e.talk = { key, date: m.date, time: m.time, file: c.file, line: m.line, text: `${m.who}: ${m.text}` };
      }
    }
    return [...by.values()]
      .map((e) => ({ ...e, last: (e.call?.key || '') > (e.talk?.key || '') ? e.call.key : (e.talk?.key || '') }))
      .sort((a, b) => b.last.localeCompare(a.last));
  }

  // 사람·방 한 곳의 관계 요약: 통화 수, 카톡 수, 단체방 발언, 처음·마지막 연락, 연락한 날 수
  stats(room) {
    const st = { calls: 0, talk: 0, group: 0, groups: new Set(), first: '', last: '', days: new Set(), todo: 0 };
    const see = (d) => { if (!d) return; st.days.add(d); if (!st.first || d < st.first) st.first = d; if (d > st.last) st.last = d; };
    for (const c of this.files.values()) {
      const k = this.pick(c, room, '');
      if (k === 1 && c.call) { st.calls++; see(c.call.date); }
      else if (k === 1) { st.talk += c.msgs.length; for (const m of c.msgs) see(m.date); }
      else if (k === 2) for (const m of c.msgs) if (m.who === room) { st.group++; st.groups.add(c.room); see(m.date); }
    }
    return st;
  }

  // 통화 요약에서 나온 할 일 (최신 통화부터)
  todos() {
    const out = [];
    for (const c of this.files.values()) for (const t of c.todos || []) out.push({ ...t, room: c.room, file: c.file, call: c.call });
    return out.sort((a, b) => `${b.call.date} ${b.call.time}`.localeCompare(`${a.call.date} ${a.call.time}`) || a.line - b.line);
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
    await this.plugin.tasks.load();
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
    if (s.room) this.personCard(box, s.room);
    const res = this.plugin.index.search(s);
    const calls = res.filter((m) => m.src === 'call'), talks = res.filter((m) => m.src !== 'call');
    const nCall = new Set(calls.map((m) => m.file.path)).size;
    if (!res.length) { box.createDiv({ cls: 'ks-hint', text: '찾은 내용이 없어요.' }); return; }
    const terms = s.q.toLowerCase().split(/\s+/).filter(Boolean);
    // 통화와 카톡을 따로 나눠서 (통화가 적으니 위에)
    if (calls.length) this.section(box, 'call', `📞 통화 ${nCall}건`, `${calls.length.toLocaleString()}줄`, calls, terms, 'shownCall');
    if (talks.length) this.section(box, 'kakao', '💬 카카오톡', `${talks.length.toLocaleString()}개 메시지`, talks, terms, 'shown');
  }

  personCard(box, room) {
    const st = this.plugin.index.stats(room);
    st.todo = (this.plugin.tasks.cache || []).filter((t) => t.status === ' ' && t.who === room).length;
    if (!st.last) return;
    const card = box.createDiv({ cls: 'ks-person' });
    const parts = [];
    if (st.calls) parts.push(`📞 통화 ${st.calls}건`);
    if (st.talk) parts.push(`💬 카톡 ${st.talk.toLocaleString()}개`);
    if (st.group) parts.push(`👥 단체방 ${st.groups.size}곳에서 ${st.group.toLocaleString()}번 발언`);
    card.createDiv({ cls: 'ks-person-stats', text: parts.join(' · ') });
    const gap = daysSince(st.last);
    const line = `처음 ${st.first} · 마지막 ${st.last}` + (gap > 0 ? ` (${gap}일 전)` : ' (오늘)') + ` · 연락한 날 ${st.days.size}일`;
    card.createDiv({ cls: 'ks-muted', text: line + (st.todo ? ` · 남은 할 일 ${st.todo}개` : '') });
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
  constructor(plugin, root) { this.plugin = plugin; this.app = plugin.app; this.root = root; this.shown = 20; this.groups = false; this.mode = 'recent'; }
  async render() {
    const r = this.root;
    r.empty();
    r.addClass('ks-root');
    const status = r.createDiv({ cls: 'ks-status', text: '최근 연락 정리 중…' });
    await this.plugin.index.ensure();
    status.remove();
    const bar = r.createDiv({ cls: 'ks-recent-bar' });
    const seg = bar.createDiv({ cls: 'ks-seg' });
    for (const [v, label] of [['recent', '🕘 최근 순'], ['care', '🔔 연락 챙기기']]) {
      const b = seg.createEl('button', { text: label });
      b.toggleClass('is-active', this.mode === v);
      b.onclick = () => { this.mode = v; this.shown = 20; this.render(); };
    }
    const lab = bar.createEl('label', { cls: 'ks-check' });
    const cb = lab.createEl('input', { type: 'checkbox' });
    cb.checked = this.groups;
    lab.appendText(' 단체방 포함');
    cb.onchange = () => { this.groups = cb.checked; this.shown = 20; this.render(); };
    helpTip(bar, this.mode === 'care'
      ? `자주 연락했는데 ${CARE_DAYS}일 넘게 연락이 없는 사람이에요. 오래된 순.`
      : '이름을 누르면 그 사람과의 카톡·통화 전체, 📞/💬 를 누르면 그 노트가 열려요.');
    let list = this.plugin.index.recent().filter((e) => this.groups || !e.group);
    if (this.mode === 'care') {
      // 연락한 날이 3일 이상이고, 마지막 연락이 CARE_DAYS일~1년 사이인 사람 — 평소 간격보다 길어진 사람부터
      list = list.map((e) => {
        const d = [...e.days].sort(), gap = daysSince(e.last.slice(0, 10));
        const span = d.length > 1 ? daysSince(d[0]) - gap : 0;
        return { ...e, gap, every: d.length > 1 ? Math.max(1, Math.round(span / (d.length - 1))) : 0 };
      }).filter((e) => e.days.size >= 3 && e.gap > CARE_DAYS && e.gap <= 365)
        .sort((a, b) => b.gap / (b.every || 1) - a.gap / (a.every || 1));
      if (!list.length) box0(r, '챙길 사람이 없어요. 자주 연락하던 사람과 모두 최근에 연락했어요.');
    }
    const box = r.createDiv({ cls: 'ks-recent' });
    for (const e of list.slice(0, this.shown)) {
      const row = box.createDiv({ cls: 'ks-recent-row' });
      const top = row.createDiv({ cls: 'ks-recent-top' });
      const nm = top.createEl('a', { text: (e.group ? '👥 ' : '') + e.name, cls: 'ks-recent-name' });
      nm.onclick = () => new SearchModal(this.plugin, { room: e.name }).open();
      top.createSpan({ text: this.mode === 'care' ? `${e.gap}일째 연락 없음` + (e.every ? ` · 평소 ${e.every}일마다` : '') : when(...e.last.split(' ')), cls: 'ks-recent-when' + (this.mode === 'care' ? ' is-care' : '') });
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

function box0(r, text) { r.createDiv({ cls: 'ks-hint', text }); }
const CARE_DAYS = 30;

// ---------- 할 일 (<base>/할 일.md — 통화·카톡에서 Rappo 가 찾은 것 + 직접 적은 것) ----------
// 한 줄: - [ ] 할 일 ⏫ 📅 2026-12-03 ⏰ 15:00 👤 홍길동 💬 메모 🔗 [[노트|통화 11/3]] 🆔 ab12cd
//   상태 ' ' 남음 · 'x' 끝냄 · '-' 지움(다시 생기지 않게 남겨 둠)
const TASK_LINE = /^(\s*)-\s+\[(.)\]\s+(.*)$/;
const TASK_MARK = /\s*(⏫|🔼|🔽|📅|⏰|👤|💬|🔗|📝|🆔)\s*/gu;
const PRIO_SYM = { 높음: '⏫', 보통: '🔼', 낮음: '🔽' };
const PRIO_OF = { '⏫': '높음', '🔼': '보통', '🔽': '낮음' };
const PRIO_RANK = { 높음: 0, 보통: 1, '': 1, 낮음: 2 };

function parseTask(raw, line) {
  const m = TASK_LINE.exec(raw);
  if (!m) return null;
  const t = { line, raw, status: m[2], text: '', prio: '', due: '', time: '', who: '', ctx: '', link: '', note: '', id: '' };
  const body = m[3], marks = [...body.matchAll(TASK_MARK)];
  t.text = (marks.length ? body.slice(0, marks[0].index) : body).trim();
  marks.forEach((k, i) => {
    const v = body.slice(k.index + k[0].length, i + 1 < marks.length ? marks[i + 1].index : body.length).trim();
    const s = k[1];
    if (PRIO_OF[s]) t.prio = PRIO_OF[s];
    else if (s === '📅') t.due = v; else if (s === '⏰') t.time = v; else if (s === '👤') t.who = v;
    else if (s === '💬') t.ctx = v; else if (s === '🔗') t.link = v; else if (s === '📝') t.note = v; else if (s === '🆔') t.id = v;
  });
  return t;
}
function taskLine(t) {
  const p = [`- [${t.status || ' '}] ${t.text.trim()}`];
  if (t.prio) p.push(PRIO_SYM[t.prio]);
  if (t.due) p.push(`📅 ${t.due}`);
  if (t.due && t.time) p.push(`⏰ ${t.time}`);
  if (t.who) p.push(`👤 ${t.who}`);
  if (t.ctx) p.push(`💬 ${t.ctx}`);
  if (t.link) p.push(`🔗 ${t.link}`);
  if (t.note) p.push(`📝 ${t.note}`);
  if (t.id) p.push(`🆔 ${t.id}`);
  return p.join(' ');
}
function taskSrc(t) { return /통화/.test(t.link) ? 'call' : /카톡/.test(t.link) ? 'kakao' : 'me'; }
const TASKS_HEAD = `---
tags: [할일]
---
# ✅ 할 일

Rappo 가 통화·카톡에서 **내가 하기로 정한 일**과 확정된 약속을 모아요. 대시보드의 ✅ 할 일 칸에서 우선순위를 바꾸거나 고치고 지울 수 있어요.
직접 적어도 돼요: \`- [ ] 할 일 🔼 📅 2026-12-03 👤 홍길동 💬 메모\` (⏫ 높음 · 🔼 보통 · 🔽 낮음)

## 목록
`;

class Tasks {
  constructor(plugin) { this.plugin = plugin; this.app = plugin.app; this.cache = []; }
  get path() { return `${BASE}/할 일.md`; }
  file() { const f = this.app.vault.getAbstractFileByPath(this.path); return f instanceof TFile ? f : null; }
  async load() {
    const f = this.file();
    if (!f) { this.cache = []; return this.cache; }
    const text = await this.app.vault.cachedRead(f);
    this.cache = text.split('\n').map((l, i) => parseTask(l, i)).filter(Boolean);
    return this.cache;
  }
  // 한 줄 바꾸기 (🆔 로 찾고, 없으면 원래 줄 그대로인 곳)
  async update(t, changes) {
    const f = this.file();
    if (!f) return;
    await this.app.vault.process(f, (text) => {
      const ls = text.split('\n');
      let i = t.id ? ls.findIndex((l) => l.includes(`🆔 ${t.id}`)) : -1;
      if (i < 0) i = ls[t.line] === t.raw ? t.line : ls.indexOf(t.raw);
      if (i >= 0) ls[i] = taskLine({ ...t, ...changes });
      return ls.join('\n');
    });
  }
  async add(t) {
    const line = taskLine({ status: ' ', id: Math.random().toString(16).slice(2, 8), ...t });
    const f = this.file();
    if (f) await this.app.vault.process(f, (text) => text.replace(/\n*$/, '\n') + line + '\n');
    else await this.app.vault.create(this.path, TASKS_HEAD + line + '\n');
  }
}

class TaskModal extends Modal {
  constructor(plugin, task, onSave) { super(plugin.app); this.plugin = plugin; this.task = task || {}; this.onSave = onSave; }
  onOpen() {
    const t = this.task, c = this.contentEl;
    this.titleEl.setText(t.text ? '할 일 고치기' : '할 일 추가');
    c.addClass('ks-task-form');
    const field = (label, el) => { const r = c.createDiv({ cls: 'ks-form-row' }); r.createEl('label', { text: label }); r.appendChild(el); return el; };
    const text = field('할 일', createEl('input', { type: 'text', value: t.text || '', attr: { placeholder: '무엇을 할지 (예: 견적서 보내기)' } }));
    const prio = field('우선순위', createEl('select'));
    for (const p of ['높음', '보통', '낮음']) prio.createEl('option', { value: p, text: `${PRIO_SYM[p]} ${p}` });
    prio.value = t.prio || '보통';
    const due = field('마감', createEl('input', { type: 'date', value: t.due || '' }));
    const time = field('시각', createEl('input', { type: 'time', value: t.time || '' }));
    const who = field('누구와', createEl('input', { type: 'text', value: t.who || '', attr: { placeholder: '약속한 사람' } }));
    const ctx = field('메모', createEl('input', { type: 'text', value: t.ctx || '', attr: { placeholder: '무슨 일 때문인지' } }));
    const btns = c.createDiv({ cls: 'ks-guess-btns' });
    const save = btns.createEl('button', { text: '저장', cls: 'mod-cta' });
    btns.createEl('button', { text: '취소' }).onclick = () => this.close();
    save.onclick = async () => {
      if (!text.value.trim()) { text.focus(); return; }
      await this.onSave({ text: text.value.trim(), prio: prio.value, due: due.value, time: due.value ? time.value : '', who: who.value.trim(), ctx: ctx.value.trim() });
      this.close();
    };
    setTimeout(() => text.focus(), 50);
  }
  onClose() { this.contentEl.empty(); }
}

// ---------- PARA 대상 (프로젝트·영역 노트) ----------
function paraTargets(app) {
  const out = [];
  for (const f of app.vault.getMarkdownFiles()) {
    if (f.path.startsWith('4. Archive/')) continue;
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    const ty = fm && String(fm.type || '');
    if (ty === 'project' || ty === 'area') out.push({ name: f.basename, type: ty, status: String(fm.status || ''), path: f.path });
  }
  const rank = (x) => (x.type === 'project' ? (x.status === '진행 중' ? 0 : 1) : 2);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, 'ko'));
}
// 입력해서 고르는 칸 (datalist) — 값: 노트 이름 또는 ''
function paraInput(parent, app, value) {
  const targets = paraTargets(app);
  const id = 'rappo-para-' + Math.random().toString(16).slice(2, 8);
  const inp = parent.createEl('input', { type: 'text', value: value || '', attr: { list: id, placeholder: '프로젝트·영역 (비우면 연결 안 함)' } });
  const dl = parent.createEl('datalist', { attr: { id } });
  for (const t of targets) dl.createEl('option', { value: t.name, text: `${t.type === 'project' ? '📁 프로젝트' : '🗂 영역'}${t.status ? ' · ' + t.status : ''}` });
  return { inp, pick: () => targets.find((t) => t.name === inp.value.trim()) || null };
}
function paraFm(target) {
  const link = target ? `\n  - "[[${target.name}]]"` : ' []';
  return `area:${target && target.type === 'area' ? link : ' []'}\nproject:${target && target.type === 'project' ? link : ' []'}`;
}
async function ensureFolder(app, path) {
  let cur = '';
  for (const part of path.split('/')) { cur = cur ? `${cur}/${part}` : part; if (!app.vault.getAbstractFileByPath(cur)) await app.vault.createFolder(cur).catch(() => {}); }
}
function safeName(s) { return String(s || '').replace(/[\\/:*?"<>|#^\[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80); }
function hhmm(d) { return `${pad(d.getHours())}${pad(d.getMinutes())}`; }

// ---------- 회의 녹음 ----------
class Recorder {
  constructor(plugin) {
    this.plugin = plugin; this.app = plugin.app; this.rec = null;
    this.bar = plugin.addStatusBarItem();
    this.bar.addClass('ks-rec-bar');
    this.bar.hide();
    this.bar.onclick = () => this.stop();
  }
  get on() { return !!this.rec; }
  elapsed() { const s = Math.floor((Date.now() - this.t0) / 1000); return `${pad(Math.floor(s / 60))}:${pad(s % 60)}`; }
  async start(title, target) {
    if (this.rec) return;
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: true, autoGainControl: true } }); }
    catch (e) { new Notice('마이크를 쓸 수 없어요. 시스템 설정 › 개인정보 보호 및 보안 › 마이크에서 Obsidian 을 켜 주세요.'); return; }
    const mime = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm'].find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || '';
    this.stream = stream; this.chunks = []; this.title = safeName(title) || '회의'; this.target = target; this.t0 = new Date();
    this.rec = new MediaRecorder(stream, mime ? { mimeType: mime, audioBitsPerSecond: 64000 } : undefined);
    this.mime = this.rec.mimeType || mime || 'audio/webm';
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(5000);
    this.bar.show();
    this.plugin.app.workspace.trigger('rappo:rec');
    const tick = () => this.bar.setText(`🔴 회의 녹음 ${this.elapsed()} · 눌러서 끝내기`);
    tick(); this.timer = window.setInterval(tick, 1000);
    new Notice(`🔴 회의 녹음을 시작했어요: ${this.title}\n끝낼 때는 아래 상태 막대나 명령 'Rappo 회의 녹음 끝내기'.`);
  }
  async stop() {
    if (!this.rec) return;
    const rec = this.rec;
    await new Promise((r) => { rec.onstop = r; rec.stop(); });
    this.stream.getTracks().forEach((t) => t.stop());
    window.clearInterval(this.timer);
    this.rec = null; this.bar.hide();
    this.plugin.app.workspace.trigger('rappo:rec');
    const d = this.t0, stamp = `${ymd(d)} ${hhmm(d)}`;
    const ext = /mp4/.test(this.mime) ? 'm4a' : 'webm';
    const audioName = `${stamp} ${this.title}.${ext}`;
    await ensureFolder(this.app, `${BASE}/회의/녹음`);
    const buf = await new Blob(this.chunks, { type: this.mime }).arrayBuffer();
    await this.app.vault.createBinary(`${BASE}/회의/녹음/${audioName}`, buf);
    // 프로젝트·영역에서 시작했으면 그 노트가 있는 폴더에 바로 (아니면 <저장 폴더>/회의)
    const dir = this.target ? this.target.path.split('/').slice(0, -1).join('/') : `${BASE}/회의`;
    await ensureFolder(this.app, dir);
    let notePath = `${dir}/${stamp} ${this.title}.md`, n = 2;
    while (this.app.vault.getAbstractFileByPath(notePath)) notePath = `${dir}/${stamp} ${this.title} (${n++}).md`;
    const note = await this.app.vault.create(notePath, `---
type: note
status: 메모용
${paraFm(this.target)}
created: ${ymd(d)}
title: "${this.title}"
meeting_audio: "${audioName}"
tags: [회의록]
---
# ${this.title}

![[${audioName}]]

> [!note] ⏳ Rappo 가 받아 적고 회의록으로 정리하고 있어요
> 끝나면 이 노트에 회의록 · 내 할 일 · 전사문이 채워지고, 내 할 일은 할 일 목록에도 들어가요.
`);
    await this.app.workspace.getLeaf(false).openFile(note);
    const min = Math.round((Date.now() - d) / 60000);
    new Notice(`⏹ 회의 녹음 저장 (${min}분). Rappo 가 곧 회의록으로 정리해요.`);
  }
}

class MeetingModal extends Modal {
  constructor(plugin, target) { super(plugin.app); this.plugin = plugin; this.target = target || null; }
  onOpen() {
    const c = this.contentEl;
    this.titleEl.setText('🎙 회의 녹음');
    c.addClass('ks-task-form');
    const r1 = c.createDiv({ cls: 'ks-form-row' }); r1.createEl('label', { text: '회의 이름' });
    const title = r1.createEl('input', { type: 'text', value: '', attr: { placeholder: '예: 주간 회의' } });
    const r2 = c.createDiv({ cls: 'ks-form-row' }); r2.createEl('label', { text: '연결' });
    const para = paraInput(r2, this.app, this.target ? this.target.name : '');
    c.createDiv({ cls: 'ks-muted', text: '녹음은 이 볼트에 저장되고, Rappo 앱이 이 맥 안에서 받아 적어 회의록을 만들어요. 참석자에게 녹음한다고 알려 주세요.' });
    const btns = c.createDiv({ cls: 'ks-guess-btns' });
    const go = btns.createEl('button', { text: '🔴 녹음 시작', cls: 'mod-cta' });
    btns.createEl('button', { text: '취소' }).onclick = () => this.close();
    go.onclick = async () => { this.close(); await this.plugin.recorder.start(title.value || '회의', para.pick() || this.target); };
    setTimeout(() => title.focus(), 50);
  }
  onClose() { this.contentEl.empty(); }
}

// ---------- PARA 노트 안의 회의 칸: ```회의``` ----------
function targetOf(app, file) {
  const fm = file && app.metadataCache.getFileCache(file)?.frontmatter;
  const ty = fm && String(fm.type || '');
  return ty === 'project' || ty === 'area' ? { name: file.basename, type: ty, status: String(fm.status || ''), path: file.path } : null;
}
function meetingsOf(app, name) {
  const out = [];
  for (const f of app.vault.getMarkdownFiles()) {
    const fm = app.metadataCache.getFileCache(f)?.frontmatter;
    if (!fm || !fm.meeting_audio) continue;
    const links = [].concat(fm.project || [], fm.area || []).map((x) => String(x).replace(/^\[\[|\]\]$/g, '').split('|')[0]);
    if (links.includes(name)) out.push({ file: f, done: !!fm.meeting_done, summary: String(fm.summary || ''), created: String(fm.created || ''), title: String(fm.title || f.basename) });
  }
  return out.sort((a, b) => b.file.basename.localeCompare(a.file.basename));
}
class MeetingsChild extends MarkdownRenderChild {
  constructor(plugin, el, sourcePath) { super(el); this.plugin = plugin; this.sourcePath = sourcePath; }
  onload() {
    this.render();
    this.registerEvent(this.plugin.app.workspace.on('rappo:rec', () => this.render()));
    this.registerEvent(this.plugin.app.metadataCache.on('changed', (f) => { if (this.plugin.app.metadataCache.getFileCache(f)?.frontmatter?.meeting_audio) this.render(); }));
    this.registerInterval(window.setInterval(() => { if (this.plugin.recorder.on && this.btn) this.btn.setText(`⏹ 회의 끝내기 · ${this.plugin.recorder.elapsed()}`); }, 1000));
  }
  render() {
    const app = this.plugin.app, el = this.containerEl, rec = this.plugin.recorder;
    el.empty(); el.addClass('ks-root', 'ks-meet');
    const file = app.vault.getAbstractFileByPath(this.sourcePath);
    const target = file instanceof TFile ? targetOf(app, file) : null;
    const bar = el.createDiv({ cls: 'ks-recent-bar' });
    this.btn = bar.createEl('button', { cls: rec.on ? 'ks-rec-on' : 'mod-cta', text: rec.on ? `⏹ 회의 끝내기 · ${rec.elapsed()}` : '🎙 새 회의' });
    this.btn.onclick = () => rec.on ? rec.stop() : new MeetingModal(this.plugin, target).open();
    if (rec.on) bar.createSpan({ cls: 'ks-muted', text: `녹음 중: ${rec.title}` });
    else helpTip(bar, '녹음을 끝내면 Rappo 가 회의록으로 정리하고, 내가 맡은 일은 할 일 목록에 넣어요.');
    const list = target ? meetingsOf(app, target.name) : [];
    if (!list.length) { el.createDiv({ cls: 'ks-hint', text: target ? '아직 이 노트에 연결된 회의가 없어요.' : '프로젝트·영역 노트(type: project/area)에 넣으면 그 노트의 회의가 모여요.' }); return; }
    const box = el.createDiv({ cls: 'ks-recent' });
    for (const m of list.slice(0, 20)) {
      const row = box.createDiv({ cls: 'ks-recent-row' });
      const top = row.createDiv({ cls: 'ks-recent-top' });
      const a = top.createEl('a', { cls: 'ks-recent-name', text: m.title });
      a.onclick = () => app.workspace.getLeaf(false).openFile(m.file);
      top.createSpan({ cls: 'ks-recent-when', text: (m.done ? '✓ 회의록 · ' : '⏳ 정리 중 · ') + m.file.basename.slice(0, 10) });
      if (m.summary) row.createDiv({ cls: 'ks-recent-text', text: m.summary });
    }
  }
}

// ---------- 할 일 → PARA 노트 ----------
class ParaModal extends Modal {
  constructor(plugin, task, done) { super(plugin.app); this.plugin = plugin; this.task = task; this.done = done; }
  onOpen() {
    const c = this.contentEl, t = this.task;
    this.titleEl.setText('📝 PARA 할 일 노트 만들기');
    c.addClass('ks-task-form');
    const r1 = c.createDiv({ cls: 'ks-form-row' }); r1.createEl('label', { text: '노트 이름' });
    const name = r1.createEl('input', { type: 'text', value: safeName(t.text) });
    const r2 = c.createDiv({ cls: 'ks-form-row' }); r2.createEl('label', { text: '연결' });
    const para = paraInput(r2, this.app, '');
    const r3 = c.createDiv({ cls: 'ks-form-row' }); r3.createEl('label', { text: '마감' });
    const end = r3.createEl('input', { type: 'date', value: t.due || '' });
    c.createDiv({ cls: 'ks-muted', text: "상태 '시작 전'인 노트로 만들어서 PARA 대시보드의 할 일 보드에 나와요. 프로젝트·영역을 고르면 그 폴더로 옮겨져요." });
    const btns = c.createDiv({ cls: 'ks-guess-btns' });
    const go = btns.createEl('button', { text: '만들기', cls: 'mod-cta' });
    btns.createEl('button', { text: '취소' }).onclick = () => this.close();
    go.onclick = async () => {
      const nm = safeName(name.value) || safeName(t.text);
      let path = `0. Inbox/${nm}.md`, n = 2;
      while (this.app.vault.getAbstractFileByPath(path)) path = `0. Inbox/${nm} (${n++}).md`;
      await ensureFolder(this.app, '0. Inbox');
      const lk = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(t.link || '');
      const f = await this.app.vault.create(path, `---
type: note
status: 시작 전
${paraFm(para.pick())}
end: ${end.value || ''}
created: ${today()}
---
## 할 일
- [ ] ${t.text}

${t.who ? `- 누구와: ${t.who}\n` : ''}${t.ctx ? `- 무슨 일: ${t.ctx}\n` : ''}${lk ? `- 출처: [[${lk[1]}|${lk[2] || lk[1]}]]\n` : ''}- 할 일 목록: [[할 일]]
`);
      await this.done(f.basename, end.value);
      this.close();
      new Notice(`📝 노트를 만들었어요: ${f.basename}`);
    };
  }
  onClose() { this.contentEl.empty(); }
}

class TodoView {
  constructor(plugin, root) { this.plugin = plugin; this.app = plugin.app; this.root = root; this.view = 'open'; this.src = ''; this.shown = 30; }
  async render() {
    const r = this.root;
    r.empty();
    r.addClass('ks-root');
    const tk = this.plugin.tasks;
    const all = await tk.load();
    this.calIds = new Set((await this.plugin.days.calDone())?.ids || []);
    const bar = r.createDiv({ cls: 'ks-recent-bar' });
    const seg = bar.createDiv({ cls: 'ks-seg' });
    const cnt = (s) => all.filter((t) => t.status === s).length;
    for (const [v, label] of [['open', `남은 일 ${cnt(' ')}`], ['done', `끝낸 일 ${cnt('x') + cnt('X')}`], ['del', `지운 일 ${cnt('-')}`]]) {
      const b = seg.createEl('button', { text: label });
      b.toggleClass('is-active', this.view === v);
      b.onclick = () => { this.view = v; this.shown = 30; this.render(); };
    }
    const seg2 = bar.createDiv({ cls: 'ks-seg' });
    for (const [v, label] of [['', '전체'], ['call', '📞 통화'], ['kakao', '💬 카톡'], ['me', '✏️ 직접']]) {
      const b = seg2.createEl('button', { text: label });
      b.toggleClass('is-active', this.src === v);
      b.onclick = () => { this.src = v; this.render(); };
    }
    const add = bar.createEl('button', { text: '＋ 할 일 추가' });
    add.onclick = () => new TaskModal(this.plugin, null, async (v) => { await tk.add(v); this.render(); }).open();
    const st = { open: [' '], done: ['x', 'X'], del: ['-'] }[this.view];
    const list = all.filter((t) => st.includes(t.status) && (!this.src || taskSrc(t) === this.src))
      .sort((a, b) => (PRIO_RANK[a.prio] - PRIO_RANK[b.prio]) || ((a.due || '9999') .localeCompare(b.due || '9999')) || a.line - b.line);
    if (!list.length) {
      r.createDiv({ cls: 'ks-hint', text: this.view === 'open' ? '남은 할 일이 없어요. 통화·카톡에서 내가 하기로 한 일이 생기면 여기에 모여요.' : '없어요.' });
      return;
    }
    const box = r.createDiv({ cls: 'ks-recent' });
    for (const t of list.slice(0, this.shown)) this.row(box, t);
    if (list.length > this.shown) {
      const more = box.createEl('button', { text: `더 보기 (${list.length - this.shown}개)`, cls: 'ks-more' });
      more.onclick = () => { this.shown += 30; this.render(); };
    }
  }
  async toCalendar(t) {
    const go = async (tt) => {
      this.plugin.data.calTasks = { ...(this.plugin.data.calTasks || {}), [tt.id]: true };
      await this.plugin.saveData(this.plugin.data);
      await this.plugin.days.upcoming();          // calendar.json 다시 쓰기 → Rappo 앱이 캘린더에
      new Notice('📅 캘린더에 넣어요 (Rappo 앱이 곧 반영해요)');
      this.render();
    };
    if (t.due) return go(t);
    new Notice('캘린더에 넣으려면 마감 날짜가 필요해요.');
    new TaskModal(this.plugin, t, async (v) => { await this.plugin.tasks.update(t, v); if (v.due) await go({ ...t, ...v }); else this.render(); }).open();
  }
  async syncNote(t, status) {
    const nl = /\[\[([^\]|]+)/.exec(t.note || '');
    const f = nl && this.app.metadataCache.getFirstLinkpathDest(nl[1], this.plugin.tasks.path);
    if (f) await this.app.fileManager.processFrontMatter(f, (fm) => { fm.status = status; });
  }
  row(box, t) {
    const tk = this.plugin.tasks;
    const row = box.createDiv({ cls: 'ks-todo' + (t.status !== ' ' ? ' is-done' : '') });
    const c = row.createEl('input', { type: 'checkbox' });
    c.checked = t.status === 'x' || t.status === 'X';
    c.disabled = t.status === '-';
    c.onchange = async () => {
      await tk.update(t, { status: c.checked ? 'x' : ' ' });
      await this.syncNote(t, c.checked ? '완료' : '시작 전');
      this.render();
    };
    const body = row.createDiv({ cls: 'ks-todo-body' });
    const top = body.createDiv({ cls: 'ks-todo-top' });
    const pr = top.createEl('a', { cls: `ks-prio is-${{ 높음: 'high', 보통: 'mid', 낮음: 'low' }[t.prio || '보통']}`, text: t.prio || '보통', attr: { 'aria-label': '눌러서 우선순위 바꾸기' } });
    pr.onclick = async () => { const n = { 높음: '보통', 보통: '낮음', 낮음: '높음', '': '높음' }[t.prio]; await tk.update(t, { prio: n }); this.render(); };
    top.createSpan({ cls: 'ks-todo-text', text: t.text });
    if (t.due) {
      const d = -daysSince(t.due);
      top.createSpan({ cls: 'ks-dday' + (d < 0 ? ' is-late' : d <= 3 ? ' is-soon' : ''),
        text: (d < 0 ? `${-d}일 지남` : d === 0 ? '오늘까지' : `D-${d}`) + ` · ${t.due.slice(5).replace('-', '/')}` + (t.time ? ` ${t.time}` : '') });
    }
    const meta = body.createDiv({ cls: 'ks-muted ks-todo-meta' });
    if (t.who) { const a = meta.createEl('a', { text: `👤 ${t.who}`, cls: 'ks-daylink' }); a.onclick = () => new SearchModal(this.plugin, { room: t.who }).open(); }
    if (t.ctx) meta.createSpan({ text: `💬 ${t.ctx}` });
    const lk = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/.exec(t.link || '');
    if (lk) { const a = meta.createEl('a', { text: `🔗 ${lk[2] || lk[1]}`, cls: 'ks-daylink' }); a.onclick = () => this.app.workspace.openLinkText(lk[1], this.plugin.tasks.path, false); }
    const act = row.createDiv({ cls: 'ks-todo-act' });
    if (t.status === ' ') {
      const inCal = this.calIds.has(`task:${t.id}`), asked = !!(this.plugin.data.calTasks || {})[t.id];
      const cal = act.createEl('a', { text: inCal ? '📅✓' : asked ? '📅…' : '📅', attr: { 'aria-label': inCal ? '캘린더에 들어감' : asked ? '캘린더에 넣는 중 (Rappo 앱)' : '캘린더에 넣기' } });
      if (!inCal && !asked) cal.onclick = () => this.toCalendar(t);
      const nl = /\[\[([^\]|]+)/.exec(t.note || '');
      const pn = act.createEl('a', { text: nl ? '📝✓' : '📝', attr: { 'aria-label': nl ? 'PARA 노트 열기' : 'PARA 할 일 노트 만들기' } });
      pn.onclick = () => nl ? this.app.workspace.openLinkText(nl[1], tk.path, false)
        : new ParaModal(this.plugin, t, async (name, end) => { await tk.update(t, { note: `[[${name}]]`, due: t.due || end }); this.render(); }).open();
    }
    const ed = act.createEl('a', { text: '✏️', attr: { 'aria-label': '고치기' } });
    ed.onclick = () => new TaskModal(this.plugin, t, async (v) => { await tk.update(t, v); this.render(); }).open();
    if (t.status === '-') {
      const back = act.createEl('a', { text: '↩︎', attr: { 'aria-label': '되살리기' } });
      back.onclick = async () => { await tk.update(t, { status: ' ' }); this.render(); };
    } else {
      const del = act.createEl('a', { text: '🗑', attr: { 'aria-label': '지우기 (잘못 생긴 할 일)' } });
      del.onclick = async () => { await tk.update(t, { status: '-' }); this.render(); };
    }
  }
}

class TodoChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() { new TodoView(this.plugin, this.containerEl).render(); }
}

class RecentChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() { new RecentView(this.plugin, this.containerEl).render(); }
}

class BlockChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() { this.containerEl.addClass('ks-block'); new SearchView(this.plugin, this.containerEl).render(); }
}

// ---------- 챙길 날: 생일·기념일·관계별 날 (어버이날, 설·추석 …) ----------
// 직접 적는 곳: <base>/챙길 날.md 의 "- 이름 | 종류 | 날짜" 줄, 또는 연락처 노트의 birthday / relation 속성.
//   - 엄마 | 관계 | 부모          → 어버이날·설·추석에 엄마가 함께 표시
//   - 엄마 | 생일 | 음력 03-15     → 해마다 음력 3월 15일
//   - 홍길동 | 결혼기념일 | 2020-10-03 → 해마다 10월 3일 (몇 주년인지도)
// 카톡에서 "생일 축하" 한 날을 찾아 생일 후보도 보여 주고, 저장하면 위 노트에 한 줄이 생긴다.
const DATE_RE = /^(음력\s*)?(?:(\d{4})[-.\/])?(\d{1,2})[-.\/](\d{1,2})$/;
const LINE_RE = /^\s*[-*]\s+([^|]+?)\s*\|\s*([^|]+?)\s*(?:\|\s*([^|]*?)\s*)?(?:\|\s*(.*?)\s*)?$/;
const CONG_RE = /생일\s*(?:을\s*)?(?:축하|ㅊㅋ)|생축|해피\s*버스?데이|happy\s*birth/i;
const THANK_RE = /고마|고맙|감사|땡큐|ㄳ|ㄱㅅ|thank/i;
// 관계별로 챙길 날: 대화에서 올해 이미 이야기했거나, 2해 이상 그 사람과 그 무렵 연락(언급·통화)한 경우에만
const HOLIDAYS = [
  { label: '어버이날', m: 5, d: 8, lunar: false, kw: /어버이날|카네이션/ },
  { label: '스승의 날', m: 5, d: 15, lunar: false, kw: /스승의\s*날/ },
  { label: '어린이날', m: 5, d: 5, lunar: false, kw: /어린이날/ },
  { label: '설날', m: 1, d: 1, lunar: true, kw: /설날|설\s*연휴|세배|떡국|새해\s*복|명절/ },
  { label: '추석', m: 8, d: 15, lunar: true, kw: /추석|송편|한가위|성묘|명절/ },
];
// 대화 속 일정: 날짜 표현 + 약속 말이 함께 있는 메시지
const PLAN_KW = /보자|봐요|봬요|뵐게|뵙|볼까|만나|만날|약속|예약|미팅|회의|모임|방문|가자|갈게|올게|오기로|가기로|하기로|출발|픽업|데리러|식사|점심|저녁\s*먹|밥\s*먹|일정|잡자|잡을게|진료|병원|시술|상담|면접|수업|레슨/;
const WD = '일월화수목금토';
const AHEAD = 400;
const LUNAR = (() => { try { return new Intl.DateTimeFormat('ko-KR-u-ca-chinese', { month: 'numeric', day: 'numeric' }); } catch (e) { return null; } })();

function ymd(x) { return `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`; }
function lunarOf(x) {
  if (!LUNAR) return null;
  const p = LUNAR.formatToParts(x), m = p.find((v) => v.type === 'month').value, d = p.find((v) => v.type === 'day').value;
  return { leap: /윤|bis/.test(m), m: Number(m.replace(/\D/g, '')), d: Number(d.replace(/\D/g, '')) };
}
// 오늘부터 AHEAD일 동안의 양력·음력 날짜 표 (한 번 만들어 재사용)
let CAL = null, CAL_DAY = '';
function calendar() {
  if (CAL && CAL_DAY === today()) return CAL;
  CAL_DAY = today(); CAL = [];
  const t = new Date(CAL_DAY + 'T12:00:00');
  for (let i = 0; i < AHEAD; i++) {
    const x = new Date(t); x.setDate(t.getDate() + i);
    CAL.push({ i, date: ymd(x), m: x.getMonth() + 1, d: x.getDate(), l: lunarOf(x) });
  }
  return CAL;
}
// 다음에 오는 그날 (없는 날이면 하루 앞당겨: 2/29 → 2/28, 음력 30일 → 29일)
function nextOf(m, d, lunar) {
  const cal = calendar();
  for (const dd of [d, d - 1]) {
    const hit = cal.find((c) => lunar ? c.l && !c.l.leap && c.l.m === m && c.l.d === dd : c.m === m && c.d === dd);
    if (hit) return hit;
  }
  return null;
}
function parseDate(v) {
  const k = DATE_RE.exec(String(v || '').trim());
  return k ? { lunar: !!k[1], year: k[2] ? Number(k[2]) : 0, m: Number(k[3]), d: Number(k[4]) } : null;
}
function mdText(e) { return `${e.lunar ? '음력 ' : ''}${e.m}월 ${e.d}일`; }
function addDays(d, n) { const x = new Date(d + 'T12:00:00'); x.setDate(x.getDate() + n); return ymd(x); }
function validYmd(y, m, d) { const x = new Date(y, m - 1, d, 12); return x.getMonth() === m - 1 && x.getDate() === d ? ymd(x) : ''; }
// 메시지 한 줄에서 날짜·시각 (base: 메시지를 보낸 날)
function planWhen(text, base) {
  const by = Number(base.slice(0, 4));
  let date = '', k;
  if ((k = /(?:(\d{4})년\s*)?(\d{1,2})월\s*(\d{1,2})일/.exec(text))) {
    date = validYmd(k[1] ? Number(k[1]) : by, Number(k[2]), Number(k[3]));
    if (date && !k[1] && date < base) date = validYmd(by + 1, Number(k[2]), Number(k[3]));
  } else if ((k = /(?<![\d.\/:])(\d{1,2})\/(\d{1,2})(?![\d\/])/.exec(text))) {
    date = validYmd(by, Number(k[1]), Number(k[2]));
    if (date && date < base) date = validYmd(by + 1, Number(k[1]), Number(k[2]));
  } else if ((k = /(오늘|내일|낼|모레|글피)/.exec(text))) {
    date = addDays(base, { 오늘: 0, 내일: 1, 낼: 1, 모레: 2, 글피: 3 }[k[1]]);
  } else if ((k = /(이번\s*주|다다음\s*주|다음\s*주|담주)?\s*([월화수목금토일])요일/.exec(text))) {
    const b = new Date(base + 'T12:00:00').getDay(), t = WD.indexOf(k[2]);
    const mon = addDays(base, -((b + 6) % 7));            // 이번 주 월요일
    const off = (t + 6) % 7;                               // 월=0 … 일=6
    const w = (k[1] || '').replace(/\s/g, '');
    if (w === '이번주') date = addDays(mon, off);
    else if (w === '다음주' || w === '담주') date = addDays(mon, 7 + off);
    else if (w === '다다음주') date = addDays(mon, 14 + off);
    else { let n = (t - b + 7) % 7; if (n === 0) n = 7; date = addDays(base, n); }
  }
  if (!date) return null;
  let time = '';
  if ((k = /(오전|오후|아침|점심|저녁|밤|새벽|낮)?\s*(\d{1,2})\s*시(?!간|쯤에?\s*끝)\s*(?:(\d{1,2})\s*분|(반))?/.exec(text))) {
    let h = Number(k[2]); const mm = k[3] ? Number(k[3]) : k[4] ? 30 : 0;
    if (/오후|저녁|밤/.test(k[1] || '') && h < 12) h += 12;
    else if (/점심|낮/.test(k[1] || '') && h <= 5) h += 12;
    else if (!k[1] && h >= 1 && h <= 7) h += 12;
    if (h <= 24 && mm < 60) time = `${pad(h % 24)}:${pad(mm)}`;
  } else if ((k = /(?<!\d)(\d{1,2}):(\d{2})(?!\d)/.exec(text))) {
    if (Number(k[1]) < 24 && Number(k[2]) < 60) time = `${pad(Number(k[1]))}:${k[2]}`;
  }
  return { date, time };
}
// 그해의 음력 날짜 → 양력 (명절 근거 찾기용)
const LUNAR_YEAR = new Map();
function lunarIn(year, m, d) {
  const key = `${year}`;
  if (!LUNAR_YEAR.has(key)) {
    const map = new Map();
    const x = new Date(year, 0, 1, 12);
    while (x.getFullYear() === year) { const l = lunarOf(x); if (l && !l.leap) { const k2 = `${l.m}-${l.d}`; if (!map.has(k2)) map.set(k2, ymd(x)); } x.setDate(x.getDate() + 1); }
    LUNAR_YEAR.set(key, map);
  }
  return LUNAR_YEAR.get(key).get(`${m}-${d}`) || '';
}

class Days {
  constructor(plugin) { this.plugin = plugin; this.app = plugin.app; }
  get notePath() { return `${BASE}/챙길 날.md`; }

  // 노트·연락처 속성에서 사람별 관계와 날짜를 모은다
  async load() {
    const dated = [], dismissed = new Set();
    const f = this.app.vault.getAbstractFileByPath(this.notePath);
    if (f instanceof TFile) {
      const text = await this.app.vault.cachedRead(f);
      // "## 목록" 제목이 있으면 그 아래만 읽는다 (위쪽 설명의 예시는 건너뜀)
      const start = text.split('\n').findIndex((l) => /^##\s*목록/.test(l));
      text.split('\n').forEach((l, line) => {
        if (line < start) return;
        const k = LINE_RE.exec(l);
        if (!k) return;
        const [, name, kind, val = '', memo = ''] = k;
        if (kind === '무시') dismissed.add(`${name}|${val || '생일'}`);
        else { const p = parseDate(val); if (p) dated.push({ name, label: kind, memo, line, ...p }); }
      });
    }
    for (const c of this.app.vault.getMarkdownFiles()) {
      if (!c.path.startsWith(CONTACTS + '/')) continue;
      const fm = this.app.metadataCache.getFileCache(c)?.frontmatter;
      if (!fm) continue;
      const nm = String(fm.name || '').trim();
      const name = nm && nm !== '정보 없음' ? nm : String(fm.phone || c.basename);
      for (const [key, label] of [['birthday', '생일'], ['anniversary', '기념일']]) {
        const p = parseDate(fm[key]);
        if (p && !dated.some((x) => x.name === name && x.label === label)) dated.push({ name, label, memo: '', ...p, file: c });
      }
    }
    return { dated, dismissed };
  }

  // 카톡에서 생일 후보: 1:1 방에서 내가 "생일 축하"한 날, 단체방에서 이름을 불러 축하하거나 축하받고 고마워한 사람
  infer() {
    const hits = new Map();
    const add = (name, date) => { if (!name || name === '나') return; const s = hits.get(name) || new Set(); s.add(date); hits.set(name, s); };
    for (const c of this.plugin.index.files.values()) {
      if (c.src !== 'kakao') continue;
      const byDay = new Map();
      for (const m of c.msgs) { if (!byDay.has(m.date)) byDay.set(m.date, []); byDay.get(m.date).push(m); }
      const people = new Set(c.msgs.map((m) => m.who).filter((w) => w !== '나'));
      for (const [date, ms] of byDay) {
        const cong = ms.filter((m) => CONG_RE.test(m.text));
        if (!cong.length) continue;
        if (c.kind !== '단체') { if (cong.some((m) => m.who === '나')) add(c.room, date); continue; }
        let named = false;
        for (const m of cong) for (const p of people) {
          if (p === m.who) continue;
          const given = p.length >= 3 ? p.slice(1) : '';
          if (m.text.includes(p) || (given && m.text.includes(given))) { add(p, date); named = true; }
        }
        if (named) continue;
        const who = new Set(cong.map((m) => m.who)), first = cong[0].time;
        const thank = new Set(ms.filter((m) => m.time >= first && !who.has(m.who) && THANK_RE.test(m.text)).map((m) => m.who));
        if (thank.size === 1) add([...thank][0], date);
      }
    }
    // 해마다 같은 양력 날인지, 음력 날인지 — 앞뒤 2일 안의 축하를 같은 날로 센다
    const out = [];
    for (const [name, set] of hits) {
      const ds = [...set].sort().map((s) => { const x = new Date(s + 'T12:00:00'); return { s, x, l: lunarOf(x) }; });
      const best = (key, doy) => {
        let top = null;
        for (const a of ds) {
          const k = key(a); if (!k) continue;
          const sup = new Set(ds.filter((b) => { const kb = key(b); return kb && Math.abs(doy(kb) - doy(k)) <= 2; }).map((b) => b.s.slice(0, 4))).size;
          const exact = ds.filter((b) => { const kb = key(b); return kb && kb.m === k.m && kb.d === k.d; }).length;
          if (!top || sup > top.sup || (sup === top.sup && exact > top.exact)) top = { ...k, sup, exact };
        }
        return top;
      };
      const solar = best((a) => ({ m: a.x.getMonth() + 1, d: a.x.getDate() }), (k) => k.m * 31 + k.d);
      const lunar = LUNAR ? best((a) => (a.l && !a.l.leap ? { m: a.l.m, d: a.l.d } : null), (k) => k.m * 30 + k.d) : null;
      const pickL = lunar && solar && lunar.sup > solar.sup;
      const b = pickL ? lunar : solar;
      if (b) out.push({ name, m: b.m, d: b.d, lunar: !!pickL, years: b.sup, last: ds[ds.length - 1].s });
    }
    return out.sort((a, b) => b.years - a.years || b.last.localeCompare(a.last));
  }

  // 명절·기념일마다 근거가 있는 방·사람: {name: {years:Set, planned}}
  holidayWho(h, next) {
    const who = new Map();
    const files = [...this.plugin.index.files.values()];
    let first = today();
    for (const c of files) { const d = c.call ? c.call.date : c.msgs[0]?.date; if (d && d < first) first = d; }
    const occ = [];
    for (let y = Number(first.slice(0, 4)); y <= Number(today().slice(0, 4)); y++) {
      const d = h.lunar ? lunarIn(y, h.m, h.d) : validYmd(y, h.m, h.d);
      if (d && d < today()) occ.push(d);
    }
    const hit = (name, key, val) => { const e = who.get(name) || { years: new Set(), planned: false }; if (key === 'y') e.years.add(val); else e.planned = true; who.set(name, e); };
    for (const c of files) {
      if (c.kind === '단체' && new Set(c.msgs.map((m) => m.who)).size > 8) continue;
      for (const o of occ) {
        const lo = addDays(o, -10), hi = addDays(o, 2);
        if (c.call) { if (c.call.date >= addDays(o, -1) && c.call.date <= addDays(o, 1)) hit(c.room, 'y', o.slice(0, 4)); }
        if (c.msgs.some((m) => m.date >= lo && m.date <= hi && h.kw.test(m.text))) hit(c.room, 'y', o.slice(0, 4));
      }
      // 올해 그날을 앞두고 이미 이야기한 경우
      if (next && c.msgs.some((m) => m.date >= addDays(next.date, -40) && m.date <= today() && h.kw.test(m.text))) hit(c.room, 'p');
    }
    return [...who].filter(([, e]) => e.years.size >= 2 || e.planned);
  }

  // 대화 속 일정 후보: 최근 60일 메시지에서, 오늘~180일 뒤의 날짜
  plans() {
    const td = today(), from = addDays(td, -60), until = addDays(td, 180), out = new Map();
    for (const c of this.plugin.index.files.values()) {
      if (c.src !== 'kakao') continue;
      for (const m of c.msgs) {
        if (m.date < from || !PLAN_KW.test(m.text)) continue;
        const w = planWhen(m.text, m.date);
        if (!w || w.date < td || w.date > until) continue;
        const key = `kakao|${c.room}|${w.date}|${w.time}`;
        const prev = out.get(key);
        if (!prev || `${m.date} ${m.time}` > prev.said) out.set(key, { id: 'plan:' + key, ...w, room: c.room, src: 'kakao', who: m.who, text: m.text, file: c.file, line: m.line, said: `${m.date} ${m.time}` });
      }
    }
    // 할 일 중 날짜·시각이 정해진 약속 (통화·카톡에서 AI 가 찾은 것)
    const tf = this.plugin.tasks.file();
    for (const t of this.plugin.tasks.cache || []) {
      if (t.status !== ' ' || !t.due || !t.time || t.due < td || t.due > until) continue;
      const key = `task|${t.id || t.text}`;
      out.set(key, { id: 'plan:' + key, date: t.due, time: t.time, room: t.who || '나', src: taskSrc(t) === 'call' ? 'call' : 'kakao', text: t.text + (t.ctx ? ` (${t.ctx})` : ''), file: tf, line: t.line, said: '할 일' });
    }
    return [...out.values()].sort((a, b) => `${a.date} ${a.time}`.localeCompare(`${b.date} ${b.time}`));
  }

  // 다가오는 날 목록 [{date, dday, title, label, names[], kind, guess?}]
  async upcoming() {
    await this.plugin.index.ensure();
    await this.plugin.tasks.load();
    const { dated, dismissed } = await this.load();
    const ev = [];
    const push = (hit, o) => { if (hit) ev.push({ date: hit.date, dday: hit.i, ...o }); };
    for (const e of dated) {
      const hit = nextOf(e.m, e.d, e.lunar);
      let label = e.label;
      if (e.year && e.label !== '생일' && hit) { const n = Number(hit.date.slice(0, 4)) - e.year; if (n > 0) label += ` ${n}주년`; }
      push(hit, { title: `${e.name} ${label}`, label, names: [e.name], kind: e.label === '생일' ? 'birth' : 'anniv', sub: mdText(e) + (e.memo ? ` · ${e.memo}` : '') });
    }
    // 관계별로 챙길 날 (근거 있는 사람·방만)
    for (const h of HOLIDAYS) {
      if (h.lunar && !LUNAR) continue;
      const next = nextOf(h.m, h.d, h.lunar);
      const who = this.holidayWho(h, next);
      if (!who.length) continue;
      const names = who.map(([n]) => n);
      const why = who.slice(0, 4).map(([n, e]) => `${n}(${e.planned ? '대화에서 이야기함' : e.years.size + '해째'})`).join(', ') + (who.length > 4 ? ` 외 ${who.length - 4}` : '');
      push(next, { title: h.label, label: h.label, names, kind: 'holiday', sub: (h.lunar ? `음력 ${h.m}월 ${h.d}일 · ` : '') + why });
    }
    // 카톡에서 찾은 생일 후보 (저장·무시하지 않은 것)
    const saved = new Set(dated.filter((e) => e.label === '생일').map((e) => e.name));
    const guesses = this.infer().filter((g) => !saved.has(g.name) && !dismissed.has(`${g.name}|생일`));
    for (const g of guesses) push(nextOf(g.m, g.d, g.lunar), { title: `${g.name} 생일`, label: '생일', names: [g.name], kind: 'birth', guess: g, sub: mdText(g) + ' · 카톡에서 추정' });
    ev.sort((a, b) => a.dday - b.dday || a.title.localeCompare(b.title, 'ko'));
    this.writeOut(ev);
    const plans = this.plans();
    this.writeCal(ev, plans);
    return { ev, guesses, plans };
  }

  // 메뉴막대 앱이 읽어 맥 알림을 띄우는 파일 (확정된 날만)
  async writeOut(ev) {
    try {
      const out = ev.filter((e) => !e.guess).map((e) => ({ date: e.date, title: e.title, sub: e.sub || '' }));
      const s = JSON.stringify({ made: today(), events: out }, null, 1);
      const p = `${this.plugin.manifest.dir}/upcoming.json`;
      if (this.lastOut !== s) { await this.app.vault.adapter.write(p, s); this.lastOut = s; }
    } catch (e) { console.warn('Rappo: upcoming.json', e); }
  }

  // 메뉴막대 앱이 읽어 캘린더에 넣는 파일: 확정된 챙길 날(60일 안) + 넣기로 한 대화 일정
  async writeCal(ev, plans) {
    try {
      const st = this.plugin.data.plans || {};
      const auto = !!this.plugin.data.autoPlan;
      const events = ev.filter((e) => !e.guess && e.dday <= 60).map((e) => ({ id: `day:${e.title}:${e.date}`, title: (e.kind === 'birth' ? '🎂 ' : e.kind === 'anniv' ? '💐 ' : '🗓 ') + e.title, date: e.date, time: '', notes: e.sub || '' }));
      for (const p of plans) {
        const s0 = st[p.id];
        if (s0 === 'no' || (!s0 && !(auto && p.time))) continue;
        events.push({ id: p.id, title: `${p.room} · ${clean(p.text).slice(0, 40)}`, date: p.date, time: p.time,
          notes: `${p.src === 'call' ? '통화' : '카톡'} ${p.room} (${p.said})\n${p.who ? p.who + ': ' : ''}${clean(p.text)}` });
      }
      const ct = this.plugin.data.calTasks || {};
      for (const t of this.plugin.tasks.cache || []) {
        if (!ct[t.id] || !t.due || t.status === '-') continue;
        events.push({ id: `task:${t.id}`, title: `✅ ${t.text}`, date: t.due, time: t.time || '',
          notes: [t.who && `누구와: ${t.who}`, t.ctx && `무슨 일: ${t.ctx}`, 'Rappo 할 일'].filter(Boolean).join('\n') });
      }
      const s = JSON.stringify({ made: today(), events }, null, 1);
      if (this.lastCal !== s) { await this.app.vault.adapter.write(`${this.plugin.manifest.dir}/calendar.json`, s); this.lastCal = s; }
    } catch (e) { console.warn('Rappo: calendar.json', e); }
  }
  // 앱이 캘린더에 넣은 것 {calendar, ids[]}
  async calDone() {
    try { return JSON.parse(await this.app.vault.adapter.read(`${this.plugin.manifest.dir}/calendar-done.json`)); } catch (e) { return null; }
  }
  async setPlan(id, v) {
    this.plugin.data.plans = this.plugin.data.plans || {};
    this.plugin.data.plans[id] = v;
    await this.plugin.saveData(this.plugin.data);
  }

  async append(line) {
    const p = this.notePath;
    const f = this.app.vault.getAbstractFileByPath(p);
    if (f instanceof TFile) await this.app.vault.process(f, (t) => t.replace(/\n*$/, '\n') + line + '\n');
    else await this.app.vault.create(p, DAYS_NOTE + line + '\n');
  }
  async openNote() {
    let f = this.app.vault.getAbstractFileByPath(this.notePath);
    if (!(f instanceof TFile)) f = await this.app.vault.create(this.notePath, DAYS_NOTE);
    await this.app.workspace.getLeaf(false).openFile(f);
  }
}

const DAYS_NOTE = `---
tags: [대시보드]
---
# 🎂 챙길 날

Rappo 대시보드의 **챙길 날**과 맥 알림이 이 목록을 읽어요. 한 줄에 하나씩 \`- 이름 | 종류 | 날짜(또는 관계)\` 로 적어요.
- 날짜: \`05-03\`, \`음력 03-15\`, 연도를 넣으면 기념일은 몇 주년인지도 보여요 (\`2020-10-03\`).
- 어버이날·설·추석 같은 날은 따로 적지 않아도 돼요. 올해 대화에서 이미 이야기했거나, 2해 이상 그 무렵 그 사람과 연락(이야기·통화)했으면 자동으로 나타나요.

예)
- 엄마 | 생일 | 음력 03-15
- 홍길동 | 결혼기념일 | 2020-10-03 | 꽃 준비

## 목록
`;

class DaysView {
  constructor(plugin, root) { this.plugin = plugin; this.app = plugin.app; this.root = root; this.range = 60; }
  async render() {
    const r = this.root;
    r.empty();
    r.addClass('ks-root');
    const status = r.createDiv({ cls: 'ks-status', text: '챙길 날 찾는 중…' });
    const { ev, guesses, plans } = await this.plugin.days.upcoming();
    const done = await this.plugin.days.calDone();
    status.remove();
    this.planSection(r, plans, done);
    const bar = r.createDiv({ cls: 'ks-recent-bar' });
    const seg = bar.createDiv({ cls: 'ks-seg' });
    for (const [v, label] of [[30, '30일'], [60, '60일'], [AHEAD, '1년']]) {
      const b = seg.createEl('button', { text: label });
      b.toggleClass('is-active', this.range === v);
      b.onclick = () => { this.range = v; this.render(); };
    }
    const add = bar.createEl('button', { text: '✏️ 날짜·관계 적기' });
    add.onclick = () => this.plugin.days.openNote();
    helpTip(bar, '7일·3일·1일 전과 당일에 맥 알림으로 알려 주고, 60일 안의 날은 캘린더에도 넣어요. ✏️ 날짜·관계 적기에서 생일·기념일을 직접 적을 수 있어요.');
    const list = ev.filter((e) => e.dday <= this.range);
    if (!list.length) r.createDiv({ cls: 'ks-hint', text: `앞으로 ${this.range === AHEAD ? '1년' : this.range + '일'} 안에 챙길 날이 없어요. 생일·관계를 적으면 여기 나타나요.` });
    const box = r.createDiv({ cls: 'ks-recent' });
    const recent = new Map(this.plugin.index.recent().map((e) => [e.name, e.last]));
    for (const e of list) {
      const row = box.createDiv({ cls: 'ks-day-row' + (e.guess ? ' is-guess' : '') });
      row.createSpan({ cls: 'ks-dday' + (e.dday <= 7 ? ' is-soon' : ''), text: e.dday === 0 ? '오늘' : `D-${e.dday}` });
      const body = row.createDiv({ cls: 'ks-todo-body' });
      const icon = e.kind === 'birth' ? '🎂' : e.kind === 'anniv' ? '💐' : '🗓';
      body.createDiv({ cls: 'ks-todo-text', text: `${icon} ${e.title}  ` }).createSpan({ cls: 'ks-muted', text: `${e.date.slice(5).replace('-', '/')} (${weekday(e.date)})` });
      const meta = body.createDiv({ cls: 'ks-muted' });
      meta.appendText(e.sub || '');
      if (e.names.length === 1) {
        const last = recent.get(e.names[0]);
        if (last) meta.appendText(` · 마지막 연락 ${daysSince(last.slice(0, 10))}일 전`);
        const a = meta.createEl('a', { text: ' 대화 보기', cls: 'ks-daylink' });
        a.onclick = () => new SearchModal(this.plugin, { room: e.names[0] }).open();
      }
      if (e.guess) this.guessButtons(body, e.guess);
    }
    // 아직 다가오지 않아 위에 없는 후보도 확인할 수 있게
    const later = guesses.filter((g) => !list.some((e) => e.guess === g));
    if (later.length) {
      const det = r.createEl('details', { cls: 'ks-section' });
      det.createEl('summary', { cls: 'ks-section-head', text: `🔎 카톡에서 찾은 생일 후보 ${later.length}명 — 맞으면 저장해 주세요` });
      for (const g of later) {
        const row = det.createDiv({ cls: 'ks-day-row is-guess' });
        const body = row.createDiv({ cls: 'ks-todo-body' });
        body.createDiv({ cls: 'ks-todo-text', text: `🎂 ${g.name} · ${mdText(g)}` });
        body.createDiv({ cls: 'ks-muted', text: `${g.years}해 축하한 기록 · 마지막 ${g.last}` });
        this.guessButtons(body, g);
      }
    }
  }
  // 📅 대화에서 정한 일정 → 캘린더
  planSection(r, plans, done) {
    const st = this.plugin.data.plans || {}, auto = !!this.plugin.data.autoPlan;
    const ids = new Set(done?.ids || []);
    const list = plans.filter((p) => st[p.id] !== 'no');
    const sec = r.createDiv({ cls: 'ks-section is-call' });
    const head = sec.createDiv({ cls: 'ks-recent-bar' });
    head.createSpan({ cls: 'ks-section-title', text: `📅 대화에서 정한 일정 ${list.length}개` });
    const lab = head.createEl('label', { cls: 'ks-check' });
    const cb = lab.createEl('input', { type: 'checkbox' });
    cb.checked = auto;
    lab.appendText(' 시각까지 정해진 일정은 자동으로 캘린더에');
    cb.onchange = async () => { this.plugin.data.autoPlan = cb.checked; await this.plugin.saveData(this.plugin.data); this.render(); };
    head.createSpan({ cls: 'ks-muted', text: done?.calendar ? `→ ${done.calendar}` : '→ Rappo 설정 › 정리·AI·캘린더에서 캘린더를 골라 주세요' });
    if (!list.length) { sec.createDiv({ cls: 'ks-hint', text: '최근 60일 대화에서 앞으로의 약속을 찾지 못했어요.' }); return; }
    for (const p of list.slice(0, this.planShown || 10)) {
      const row = sec.createDiv({ cls: 'ks-day-row' });
      const dd = daysSince(p.date) * -1;
      row.createSpan({ cls: 'ks-dday' + (dd <= 7 ? ' is-soon' : ''), text: dd === 0 ? '오늘' : `D-${dd}` });
      const body = row.createDiv({ cls: 'ks-todo-body' });
      const t = body.createDiv({ cls: 'ks-todo-text', text: `${p.date.slice(5).replace('-', '/')} (${weekday(p.date)})${p.time ? ' ' + p.time : ''} · ${p.room}  ` });
      t.createSpan({ cls: 'ks-muted', text: p.src === 'call' ? '📞 통화 요약' : '💬 카톡' });
      const q = body.createEl('a', { cls: 'ks-muted', text: `${p.who ? p.who + ': ' : ''}${clean(p.text)}` });
      q.onclick = () => this.app.workspace.getLeaf(false).openFile(p.file, { eState: { line: p.line } });
      const btns = body.createDiv({ cls: 'ks-guess-btns' });
      const inCal = ids.has(p.id), want = st[p.id] === 'add' || (auto && p.time);
      if (inCal) btns.createSpan({ cls: 'ks-muted', text: '✅ 캘린더에 들어감' });
      else if (want) btns.createSpan({ cls: 'ks-muted', text: '⏳ 캘린더에 넣는 중 (Rappo 앱)' });
      else {
        const add = btns.createEl('button', { text: '📅 캘린더에 넣기' });
        add.onclick = async () => { await this.plugin.days.setPlan(p.id, 'add'); this.render(); };
      }
      if (!inCal) {
        const no = btns.createEl('button', { text: '일정 아니에요' });
        no.onclick = async () => { await this.plugin.days.setPlan(p.id, 'no'); this.render(); };
      }
    }
    if (list.length > (this.planShown || 10)) {
      const more = sec.createEl('button', { text: `더 보기 (${list.length - (this.planShown || 10)}개)`, cls: 'ks-more' });
      more.onclick = () => { this.planShown = (this.planShown || 10) + 10; this.render(); };
    }
  }

  guessButtons(parent, g) {
    const btns = parent.createDiv({ cls: 'ks-guess-btns' });
    const save = btns.createEl('button', { text: '맞아요, 저장' });
    save.onclick = async () => { await this.plugin.days.append(`- ${g.name} | 생일 | ${g.lunar ? '음력 ' : ''}${pad(g.m)}-${pad(g.d)}`); this.render(); };
    const no = btns.createEl('button', { text: '아니에요' });
    no.onclick = async () => { await this.plugin.days.append(`- ${g.name} | 무시 | 생일`); this.render(); };
  }
}

// 할 일(왼쪽) · 챙길 날(오른쪽)을 한 화면에 — 좁으면 위아래로
class BoardChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() {
    const g = this.containerEl.createDiv({ cls: 'ks-board' });
    const col = (title) => { const c = g.createDiv({ cls: 'ks-board-col' }); c.createDiv({ cls: 'ks-board-title', text: title }); return c.createDiv(); };
    const left = col('✅ 할 일'), right = col('🎂 챙길 날');
    new TodoView(this.plugin, left).render();
    new DaysView(this.plugin, right).render();
  }
}

class DaysChild extends MarkdownRenderChild {
  constructor(plugin, el) { super(el); this.plugin = plugin; }
  onload() { new DaysView(this.plugin, this.containerEl).render(); }
}

module.exports = class RappoSearch extends Plugin {
  async onload() {
    const data = (await this.loadData()) || {};
    this.data = data;
    const base = String(data.base || '2. Areas/통화기록').replace(/\/+$/, '');
    BASE = base; CONTACTS = base + '/연락처'; KAKAO = base + '/카톡'; CALLS = base + '/통화';
    this.index = new Index(this.app);
    this.days = new Days(this);
    this.tasks = new Tasks(this);
    const handler = (src, el, ctx) => ctx.addChild(new BlockChild(this, el));
    for (const name of ['대화검색', '카톡검색', 'kakao-search']) this.registerMarkdownCodeBlockProcessor(name, handler);
    this.registerMarkdownCodeBlockProcessor('최근연락', (src, el, ctx) => ctx.addChild(new RecentChild(this, el)));
    this.registerMarkdownCodeBlockProcessor('챙길날', (src, el, ctx) => ctx.addChild(new DaysChild(this, el)));
    this.addCommand({ id: 'days', name: 'Rappo 챙길 날 적기', callback: () => this.days.openNote() });
    this.recorder = new Recorder(this);
    this.registerMarkdownCodeBlockProcessor('회의', (src, el, ctx) => ctx.addChild(new MeetingsChild(this, el, ctx.sourcePath)));
    // 프로젝트·영역 노트 오른쪽 위에 🎙 새 회의 버튼
    const views = new WeakMap();
    const mark = () => {
      this.app.workspace.iterateAllLeaves((leaf) => {
        const v = leaf.view;
        if (!(v instanceof MarkdownView)) return;
        let b = views.get(v);
        if (!b) { b = v.addAction('mic', 'Rappo 새 회의', () => this.recorder.on ? this.recorder.stop() : new MeetingModal(this, targetOf(this.app, v.file)).open()); views.set(v, b); }
        b.toggle(!!targetOf(this.app, v.file) || this.recorder.on);
      });
    };
    this.registerEvent(this.app.workspace.on('layout-change', mark));
    this.registerEvent(this.app.workspace.on('file-open', mark));
    this.registerEvent(this.app.metadataCache.on('changed', mark));
    this.registerEvent(this.app.workspace.on('rappo:rec', mark));
    this.app.workspace.onLayoutReady(mark);
    this.addCommand({ id: 'meeting-block', name: 'Rappo 이 노트에 회의 칸 넣기', editorCallback: (ed) => {
      const t = ed.getValue();
      if (t.includes('```회의')) { new Notice('이미 회의 칸이 있어요'); return; }
      ed.setValue(t.replace(/\n*$/, '\n') + '\n## 회의\n```회의\n```\n');
    } });
    this.addCommand({ id: 'meeting', name: 'Rappo 회의 녹음 시작', callback: () => this.recorder.on ? this.recorder.stop() : new MeetingModal(this).open() });
    this.addCommand({ id: 'meeting-stop', name: 'Rappo 회의 녹음 끝내기', checkCallback: (chk) => { if (!this.recorder.on) return false; if (!chk) this.recorder.stop(); return true; } });
    this.addRibbonIcon('mic', 'Rappo 회의 녹음', () => this.recorder.on ? this.recorder.stop() : new MeetingModal(this).open());
    this.addCommand({ id: 'task-add', name: 'Rappo 할 일 추가', callback: () => new TaskModal(this, null, (v) => this.tasks.add(v)).open() });
    // 옵시디언을 열면 하루 한 번, 3일 안에 챙길 날을 알림으로 (맥 알림용 upcoming.json 도 이때 새로 씀)
    this.app.workspace.onLayoutReady(() => setTimeout(() => this.dayNotice(), 8000));
    this.registerMarkdownCodeBlockProcessor('할일', (src, el, ctx) => ctx.addChild(new TodoChild(this, el)));
    this.registerMarkdownCodeBlockProcessor('할일챙길날', (src, el, ctx) => ctx.addChild(new BoardChild(this, el)));
    this.addCommand({ id: 'open', name: 'Rappo 대화·통화 검색', callback: () => new SearchModal(this).open() });
    this.addRibbonIcon('message-circle', 'Rappo 대화·통화 검색', () => new SearchModal(this).open());
    // 바뀐 파일은 다음 검색 때 다시 읽는다 (mtime 비교)
    this.registerEvent(this.app.vault.on('delete', (f) => this.index.files.delete(f.path)));
    this.registerEvent(this.app.vault.on('rename', (f, old) => this.index.files.delete(old)));
  }
  onunload() { if (this.recorder && this.recorder.on) this.recorder.stop(); }
  async dayNotice() {
    try {
      const { ev } = await this.days.upcoming();
      const key = 'rappo-day-notice';
      if (window.localStorage.getItem(key) === today()) return;
      const soon = ev.filter((e) => !e.guess && e.dday <= 3);
      if (!soon.length) return;
      window.localStorage.setItem(key, today());
      new Notice('🎂 Rappo 챙길 날\n' + soon.map((e) => `${e.dday ? 'D-' + e.dday : '오늘'} ${e.title}`).join('\n'), 12000);
    } catch (e) { console.warn('Rappo: 챙길 날', e); }
  }
};
