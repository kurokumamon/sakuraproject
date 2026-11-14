// さくらトーク: 家族専用メッセンジャー (ビルド不要の静的 PWA)
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_ANON_KEY, VAPID_PUBLIC_KEY } from './config.js';

const app = document.getElementById('app');
const toastEl = document.getElementById('toast');

// ---------- 小道具 ----------

function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}
const show = (...nodes) => app.replaceChildren(...nodes);

let toastTimer;
function toast(msg) {
  toastEl.textContent = msg;
  toastEl.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.hidden = true; }, 4000);
}
const errText = (e) => (e && e.message) || 'エラーがおきました';

// ボタンの二度押し防止つきで非同期処理を実行する
function busy(fn) {
  return async (ev) => {
    const btn = ev.currentTarget;
    btn.disabled = true;
    try { await fn(ev); } catch (e) { toast(errText(e)); } finally { btn.disabled = false; }
  };
}

function fmtTime(iso) {
  const d = new Date(iso), now = new Date();
  const hm = `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
  return d.toDateString() === now.toDateString() ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

// ---------- 起動 ----------

if (SUPABASE_URL.includes('YOUR-PROJECT')) {
  show(h('div', { class: 'pad stack' },
    h('h2', null, 'せっていが必要です'),
    h('p', null, 'config.js に Supabase の URL と anon キーを入れてください。')));
  throw new Error('config.js が未設定です');
}

// 登録確認メールのリンクから来たかどうか (URL は Supabase が読み取ったあと消えるので先に見ておく)
const cameFromEmail = /access_token=|type=signup|[?&]code=/.test(location.hash + location.search);
const emailLinkError = /error_description=([^&]+)/.exec(location.hash + location.search);

// 招待QRから開いたときの招待コード (?join=XXXXXXXX)
const joinCode = new URLSearchParams(location.search).get('join');
let joinTried = false;

const sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
const state = { me: null, family: null, members: [], channels: [], onVisible: null };

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.onVisible) state.onVisible();
});

function cleanup() {
  for (const ch of state.channels) sb.removeChannel(ch);
  state.channels = [];
  state.onVisible = null;
}

// iPhone では、メールのリンクは Safari で開く。ホーム画面のアプリとはログイン状態が別なので、
// ここで続けさせず、アプリに戻ってログインするよう案内する
function viewEmailConfirmed() {
  show(h('div', { class: 'pad stack' },
    h('h2', { class: 'center' }, '✅ メールの確認ができました'),
    h('p', null, 'ホーム画面の「さくらトーク」をひらいて、登録したメールアドレスとパスワードでログインしてください。'),
    h('p', { class: 'muted' }, 'この画面はとじてかまいません。'),
    h('button', { class: 'big sub', onclick: () => { history.replaceState(null, '', location.pathname); boot(); } },
      'この画面のまま つづける')));
}

let emailLandingShown = false;

async function boot() {
  cleanup();
  const { data: { session } } = await sb.auth.getSession();
  if (cameFromEmail && !emailLandingShown && navigator.standalone === false) {
    emailLandingShown = true;
    return viewEmailConfirmed();
  }
  if (emailLinkError && !emailLandingShown) {
    emailLandingShown = true;
    toast('メールのリンクが使えませんでした（期限切れなど）。もういちど登録するか、ログインをためしてください。');
  }
  if (!session) {
    if (joinCode && !joinTried) return joinFromLink();
    return viewWelcome();
  }
  const { data: me, error } = await sb.from('members').select('*').eq('user_id', session.user.id).maybeSingle();
  if (error) return show(h('div', { class: 'pad stack' },
    h('p', null, 'つながりませんでした。'), h('p', { class: 'muted' }, errText(error)),
    h('button', { class: 'big', onclick: boot }, 'もういちど')));
  if (!me && session.user.is_anonymous && joinCode && !joinTried) return joinFromLink();
  if (!me) return session.user.is_anonymous ? viewChildJoin() : viewCreateFamily();
  state.me = me;
  return viewHome();
}

// ---------- はじめの画面 ----------

function installHint() {
  // iPhone の Safari で開いている (ホーム画面アプリではない) ときだけ出す
  if (navigator.standalone !== false) return null;
  return h('div', { class: 'hint' },
    'さきに、下の共有ボタンから「ホーム画面に追加」をして、ホーム画面のアイコンから開いてください。',
    'Safari のままはじめると、ホーム画面のアプリに引きつがれません。');
}

function viewWelcome() {
  show(h('div', { class: 'pad stack' },
    h('h2', { class: 'center' }, '🌸 さくらトーク'),
    h('p', { class: 'center muted' }, 'かぞくだけのメッセージ'),
    installHint(),
    h('button', { class: 'big', onclick: viewChildJoin }, 'こども（コードをいれる）'),
    h('button', { class: 'big sub', onclick: viewParentAuth }, 'おとな（ログイン・登録）'),
    howTo()));
}

// 最初の画面に出す、かんたんな使い方
function howTo() {
  const steps = (items) => h('ol', null, items.map((t) => h('li', null, t)));
  return h('div', { class: 'howto' },
    h('h3', null, 'つかいかた'),
    h('h4', null, 'おとな（さいしょの1回）'),
    steps([
      '「おとな」をおして、メールアドレスとパスワードを入れて「はじめて使う」をおす',
      'とどいたメールのリンクをひらく',
      'ここにもどってログインし、家族をつくる',
      '「せってい」でこどもを追加して、招待コードを出す',
    ]),
    h('h4', null, 'こども'),
    steps([
      '「こども」をおす',
      'おとなのスマホに出ている 8もじのコードを入れる',
    ]),
    h('h4', null, 'みんな'),
    steps([
      'ホームの「🔔 つうちを オン にする」をおす',
      'なまえをおして、メッセージをおくる',
    ]));
}

function viewParentAuth() {
  const email = h('input', { type: 'email', placeholder: 'メールアドレス', autocomplete: 'email' });
  const pass = h('input', { type: 'password', placeholder: 'パスワード（8文字以上）', autocomplete: 'current-password' });
  const creds = () => ({ email: email.value.trim(), password: pass.value });

  const login = busy(async () => {
    const { error } = await sb.auth.signInWithPassword(creds());
    if (error) throw error;
    await boot();
  });
  const signup = busy(async () => {
    const { data, error } = await sb.auth.signUp({ ...creds(), options: { emailRedirectTo: new URL('./', location.href).href } });
    if (error) throw error;
    if (data.session) return boot();
    toast('確認メールを送りました。メールのリンクを開いたあと、ここでログインしてください。');
  });

  show(h('div', { class: 'pad stack' },
    h('h2', null, 'おとなのログイン'),
    email, pass,
    h('button', { class: 'big', onclick: login }, 'ログイン'),
    h('button', { class: 'big sub', onclick: signup }, 'はじめて使う（新規登録）'),
    h('button', { class: 'small', onclick: viewWelcome }, 'もどる')));
}

function viewCreateFamily() {
  const fam = h('input', { placeholder: '家族の名前（例: すずき家）' });
  const name = h('input', { placeholder: 'あなたの表示名（例: パパ）' });
  const create = busy(async () => {
    if (!fam.value.trim() || !name.value.trim()) throw new Error('両方入力してください');
    const { error } = await sb.rpc('create_family', { family_name: fam.value.trim(), my_name: name.value.trim() });
    if (error) throw error;
    await boot();
  });
  show(h('div', { class: 'pad stack' },
    h('h2', null, '家族をつくる'),
    fam, name,
    h('button', { class: 'big', onclick: create }, 'つくる'),
    h('button', { class: 'small', onclick: logout }, 'ログアウト')));
}

// 招待コードで家族に参加する (こどもの端末はメールアドレスなしの匿名サインイン)
async function joinWithCode(code) {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) {
    const { error } = await sb.auth.signInAnonymously();
    if (error) throw error;
  }
  const { error } = await sb.rpc('redeem_invite', { invite_code: code });
  if (error) throw error;
}

// 招待QRから開いたとき
async function joinFromLink() {
  // iPhone の Safari: ここで参加するとホーム画面のアプリに引きつがれないので、先に追加してもらう
  if (navigator.standalone === false) {
    return show(h('div', { class: 'pad stack' },
      h('h2', { class: 'center' }, '🌸 さくらトーク'),
      h('div', { class: 'howto' },
        h('h3', null, 'あと 2つ で はじめられます'),
        h('ol', null,
          h('li', null, 'がめんの下の 共有ボタン（□に↑）をおして、「ホーム画面に追加」をえらぶ'),
          h('li', null, 'ホーム画面にできた「さくらトーク」をひらく')),
        h('p', { class: 'muted' }, 'ひらくと、じどうで かぞくに はいります。')),
      h('button', { class: 'small', onclick: viewChildJoin }, 'コードを手で入れる')));
  }
  joinTried = true;
  show(h('p', { class: 'center muted pad' }, 'かぞくに はいっています…'));
  try {
    await joinWithCode(joinCode);
  } catch (e) {
    viewChildJoin();
    toast(errText(e) + '　おとなに あたらしいコードを 出してもらってください。');
    return;
  }
  await boot();
}

function viewChildJoin() {
  const code = h('input', {
    placeholder: 'コード（8もじ）', maxlength: '8', autocapitalize: 'characters',
    autocomplete: 'off', autocorrect: 'off', spellcheck: 'false',
  });
  const join = busy(async () => {
    if (code.value.trim().length < 8) throw new Error('コードは8もじです');
    await joinWithCode(code.value);
    await boot();
  });
  show(h('div', { class: 'pad stack' },
    h('h2', null, 'コードをいれてね'),
    h('p', { class: 'muted' }, 'おうちのひとのスマホに出ているコードをいれます。'),
    installHint(),
    code,
    h('button', { class: 'big', onclick: join }, 'はじめる'),
    h('button', { class: 'small', onclick: viewWelcome }, 'もどる')));
}

async function logout() {
  cleanup();
  await sb.auth.signOut();
  state.me = null;
  viewWelcome();
}

// ---------- プッシュ通知 ----------

const pushSupported = 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

function keyBytes(b64url) {
  const b64 = (b64url + '='.repeat((4 - (b64url.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
}

// この端末の通知の宛先を登録する。許可ずみのときだけ呼ぶ
async function savePushSubscription() {
  const reg = await navigator.serviceWorker.ready;
  const subscribe = () => reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) });
  const save = (sub) => {
    const j = sub.toJSON();
    return sb.from('push_subscriptions').upsert(
      { member_id: state.me.id, endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth },
      { onConflict: 'endpoint' });
  };
  let sub = (await reg.pushManager.getSubscription()) || (await subscribe());
  let { error } = await save(sub);
  if (error) {
    // 同じ端末が以前べつのメンバーで登録されていた場合など。宛先を作り直して登録しなおす
    await sub.unsubscribe();
    sub = await subscribe();
    ({ error } = await save(sub));
    if (error) throw error;
  }
}

// ホームの上に出す「通知をオンにする」ボタン。不要なら null
function pushBanner() {
  if (!pushSupported) return null;
  if (Notification.permission === 'granted') {
    savePushSubscription().catch(() => {}); // 宛先は変わることがあるので、開くたびに登録しなおす
    return null;
  }
  if (Notification.permission === 'denied') {
    return h('div', { class: 'hint banner' }, 'つうちが オフ になっています。iPhone の「設定」→「通知」→「さくらトーク」でオンにできます。');
  }
  const box = h('div', { class: 'banner' });
  box.append(h('button', {
    class: 'big',
    onclick: busy(async () => {
      const result = await Notification.requestPermission();
      if (result !== 'granted') throw new Error('つうちが許可されませんでした');
      await savePushSubscription();
      box.remove();
      toast('つうちを オン にしました');
    }),
  }, '🔔 つうちを オン にする'));
  return box;
}

// ---------- ホーム (会話の一覧) ----------

async function viewHome() {
  cleanup();
  const me = state.me;
  const rows = h('div', { class: 'rows' }, h('p', { class: 'center muted' }, 'よみこみちゅう…'));
  const title = h('h1', null, 'さくらトーク');

  show(
    h('header', { class: 'bar' }, title,
      me.role === 'parent' && h('button', { onclick: viewSettings }, 'せってい')),
    pushBanner(),
    rows);

  async function load() {
    const [fam, mem, cv] = await Promise.all([
      sb.from('families').select('name').maybeSingle(),
      sb.from('members').select('id,display_name,role,user_id').order('created_at'),
      sb.from('conversations').select('id,is_group,conversation_members(member_id,last_read_at)'),
    ]);
    const error = fam.error || mem.error || cv.error;
    if (error) return toast(errText(error));
    state.family = fam.data;
    state.members = mem.data;
    if (fam.data) title.textContent = fam.data.name;

    // 各会話の最新メッセージ
    const latest = {};
    await Promise.all(cv.data.map(async (c) => {
      const { data } = await sb.from('messages').select('body,image_path,sender_id,created_at')
        .eq('conversation_id', c.id).order('id', { ascending: false }).limit(1);
      if (data && data[0]) latest[c.id] = data[0];
    }));

    const preview = (c) => {
      const m = c && latest[c.id];
      if (!m) return 'まだメッセージはありません';
      return m.image_path ? '📷 しゃしん' : m.body;
    };
    const unread = (c) => {
      const m = c && latest[c.id];
      const mine = c && c.conversation_members.find((x) => x.member_id === me.id);
      return !!(m && mine && m.sender_id !== me.id && new Date(m.created_at) > new Date(mine.last_read_at));
    };
    const row = (label, initial, c, open) =>
      h('button', { class: 'row', onclick: busy(open) },
        h('div', { class: 'avatar' }, initial),
        h('div', { class: 'main' },
          h('div', { class: 'name' }, label),
          h('div', { class: 'last' }, preview(c))),
        unread(c) && h('div', { class: 'dot' }));

    const items = [];
    const group = cv.data.find((c) => c.is_group);
    if (group) items.push(row('かぞくみんな', '🌸', group, () => viewChat(group.id, 'かぞくみんな')));

    for (const m of mem.data) {
      if (m.id === me.id) continue;
      const dm = cv.data.find((c) => !c.is_group && c.conversation_members.some((x) => x.member_id === m.id));
      items.push(row(m.display_name, Array.from(m.display_name)[0] || '?', dm, async () => {
        let id = dm && dm.id;
        if (!id) {
          const { data, error: e } = await sb.rpc('get_or_create_dm', { other_member: m.id });
          if (e) throw e;
          id = data;
        }
        await viewChat(id, m.display_name);
      }));
    }
    if (mem.data.length <= 1 && me.role === 'parent') {
      items.push(h('p', { class: 'center muted' }, '「せってい」から、こどもを追加してください。'));
    }
    rows.replaceChildren(...items);
  }

  let timer;
  const reload = () => { clearTimeout(timer); timer = setTimeout(load, 300); };
  state.channels.push(sb.channel('home')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, reload)
    .subscribe());
  state.onVisible = load; // バックグラウンド中は接続が切れるので、戻ってきたら取り直す
  await load();
}

// ---------- チャット ----------

const imageUrls = new Map();
async function imageUrl(path) {
  if (!imageUrls.has(path)) {
    const { data, error } = await sb.storage.from('chat-images').createSignedUrl(path, 60 * 60 * 12);
    if (error) throw error;
    imageUrls.set(path, data.signedUrl);
  }
  return imageUrls.get(path);
}

// iPhone の写真は大きいので、送る前に長辺 1600px の JPEG に縮める
async function shrink(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * s);
    c.height = Math.round(img.naturalHeight * s);
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.8));
    if (!blob) throw new Error('しゃしんを読みこめませんでした');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function viewChat(convId, title) {
  cleanup();
  const me = state.me;
  const names = Object.fromEntries(state.members.map((m) => [m.id, m.display_name]));
  let msgs = [];
  let reads = [];
  const seen = new Set();

  const list = h('div', { class: 'msgs' });
  const input = h('textarea', { placeholder: 'メッセージ', rows: '1' });
  const file = h('input', { type: 'file', accept: 'image/*' });

  const toBottom = () => { list.scrollTop = list.scrollHeight; };

  function readLabel(m) {
    if (m.sender_id !== me.id) return '';
    const n = reads.filter((r) => r.member_id !== me.id && new Date(r.last_read_at) >= new Date(m.created_at)).length;
    if (!n) return '';
    return reads.length > 2 ? `きどく ${n}  ` : 'きどく  ';
  }

  function render() {
    list.replaceChildren(...msgs.map((m) => {
      const mine = m.sender_id === me.id;
      const bubble = h('div', { class: 'bubble' });
      if (m.image_path) {
        const img = h('img', { alt: 'しゃしん' });
        img.addEventListener('load', toBottom);
        imageUrl(m.image_path).then((u) => { img.src = u; }).catch(() => { bubble.textContent = '（しゃしんを表示できません）'; });
        bubble.append(img);
      } else {
        bubble.textContent = m.body;
      }
      return h('div', { class: mine ? 'msg mine' : 'msg' },
        !mine && h('div', { class: 'who' }, names[m.sender_id] || '？'),
        bubble,
        h('div', { class: 'meta' }, readLabel(m) + fmtTime(m.created_at)));
    }));
    toBottom();
  }

  // 既読位置は「見た中で最新のメッセージの時刻」(サーバー時刻) で記録する。端末の時計に頼らない
  async function markRead() {
    if (document.visibilityState !== 'visible' || !msgs.length) return;
    const last = msgs[msgs.length - 1].created_at;
    const mine = reads.find((r) => r.member_id === me.id);
    if (!mine || new Date(mine.last_read_at) >= new Date(last)) return;
    mine.last_read_at = last;
    await sb.from('conversation_members').update({ last_read_at: last })
      .eq('conversation_id', convId).eq('member_id', me.id);
  }

  function add(m) {
    if (seen.has(m.id)) return;
    seen.add(m.id);
    msgs.push(m);
    msgs.sort((a, b) => a.id - b.id);
    render();
    markRead();
  }

  async function load() {
    const [a, b] = await Promise.all([
      sb.from('messages').select('*').eq('conversation_id', convId).order('id', { ascending: false }).limit(200),
      sb.from('conversation_members').select('member_id,last_read_at').eq('conversation_id', convId),
    ]);
    if (a.error || b.error) return toast(errText(a.error || b.error));
    msgs = a.data.reverse();
    reads = b.data;
    seen.clear();
    msgs.forEach((m) => seen.add(m.id));
    render();
    markRead();
  }

  async function send(fields) {
    const { data, error } = await sb.from('messages')
      .insert({ conversation_id: convId, sender_id: me.id, ...fields }).select().single();
    if (error) throw error;
    add(data);
  }

  const sendText = busy(async () => {
    const body = input.value.trim();
    if (!body) return;
    input.value = '';
    try { await send({ body }); } catch (e) { input.value = body; throw e; }
  });

  file.addEventListener('change', async () => {
    const f = file.files[0];
    file.value = '';
    if (!f) return;
    try {
      toast('しゃしんを送っています…');
      const blob = await shrink(f);
      const path = `${convId}/${crypto.randomUUID()}.jpg`;
      const { error } = await sb.storage.from('chat-images').upload(path, blob, { contentType: 'image/jpeg' });
      if (error) throw error;
      await send({ image_path: path });
      toastEl.hidden = true;
    } catch (e) {
      toast(errText(e));
    }
  });

  show(
    h('header', { class: 'bar' },
      h('button', { onclick: viewHome }, '‹ もどる'),
      h('h1', null, title)),
    list,
    h('div', { class: 'composer' },
      h('label', { class: 'icon', 'aria-label': 'しゃしんを送る' }, '📷', file),
      input,
      h('button', { class: 'icon', 'aria-label': '送る', onclick: sendText }, '➤')));

  state.channels.push(sb.channel('chat-' + convId)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${convId}` },
      (p) => add(p.new))
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'conversation_members', filter: `conversation_id=eq.${convId}` },
      (p) => {
        const r = reads.find((x) => x.member_id === p.new.member_id);
        if (r) r.last_read_at = p.new.last_read_at; else reads.push(p.new);
        render();
      })
    .subscribe());
  state.onVisible = load;
  await load();
}

// ---------- スワイプで削除 ----------

const DELETE_WIDTH = 88;
let closeOpenSwipe = null; // ひらいている行はひとつだけ

// 行を左にスワイプすると、うしろの「けす」ボタンが出る。ボタンをおすと onDelete
function swipeToDelete(content, onDelete) {
  const del = h('button', { class: 'swipe-del', onclick: onDelete }, 'けす');
  content.classList.add('swipe-front');
  const wrap = h('div', { class: 'swipe' }, del, content);

  let startX = 0, startY = 0, base = 0, x = 0, dragging = false, decided = false;
  const setX = (v, animate) => {
    x = v;
    content.style.transition = animate ? 'transform .2s' : 'none';
    content.style.transform = `translateX(${v}px)`;
  };
  const close = () => { setX(0, true); if (closeOpenSwipe === close) closeOpenSwipe = null; };

  content.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    dragging = true; decided = false;
    startX = e.clientX; startY = e.clientY; base = x;
  });
  content.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX, dy = e.clientY - startY;
    if (!decided) {
      if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
      decided = true;
      if (Math.abs(dy) > Math.abs(dx)) { dragging = false; return; } // たてのスクロール
      if (closeOpenSwipe && closeOpenSwipe !== close) closeOpenSwipe();
      content.setPointerCapture(e.pointerId);
    }
    setX(Math.max(-DELETE_WIDTH - 20, Math.min(0, base + dx)), false);
  });
  const end = () => {
    if (!dragging) return;
    dragging = false;
    if (x < -DELETE_WIDTH / 2) { setX(-DELETE_WIDTH, true); closeOpenSwipe = close; } else close();
  };
  content.addEventListener('pointerup', end);
  content.addEventListener('pointercancel', end);
  return wrap;
}

// ---------- 設定 (親のみ) ----------

async function viewSettings() {
  cleanup();
  closeOpenSwipe = null;
  const listEl = h('div');
  const codeBox = h('div');
  const name = h('input', { placeholder: 'なまえ（例: さくら）' });
  const role = h('select', null,
    h('option', { value: 'child' }, 'こども'),
    h('option', { value: 'parent' }, 'おとな（管理できる人）'));

  async function load() {
    const { data, error } = await sb.from('members').select('id,display_name,role,user_id').order('created_at');
    if (error) return toast(errText(error));
    state.members = data;
    listEl.replaceChildren(...data.map((m) => {
      const row = h('div', { class: 'member' },
        h('div', { class: 'main' },
          h('div', null, m.display_name + (m.role === 'parent' ? '（おとな）' : '')),
          h('div', { class: 'muted' }, m.user_id ? '参加ずみ' : 'まだ参加していません（左にスワイプでけせます）')),
        m.id !== state.me.id && h('button', { class: 'small', onclick: busy(() => invite(m)) },
          m.user_id ? '端末を入れかえる' : '招待コード'));
      // まだ参加していない人だけ、スワイプで削除できる
      if (m.user_id || m.id === state.me.id) return row;
      return swipeToDelete(row, busy(async () => {
        const { error: e } = await sb.rpc('remove_pending_member', { target_member: m.id });
        if (e) throw e;
        codeBox.replaceChildren();
        toast(`${m.display_name} をけしました`);
        await load();
      }));
    }));
  }

  async function invite(m) {
    const { data, error } = await sb.rpc('create_invite', { target_member: m.id });
    if (error) throw error;
    const qr = h('div', { class: 'qr' });
    codeBox.replaceChildren(
      h('h3', null, `${m.display_name} の招待`),
      qr,
      h('p', { class: 'muted center' }, '相手のスマホのカメラでこのQRを読みとります。読めないときは下のコードを入力します。'),
      h('div', { class: 'code' }, data),
      h('p', { class: 'muted' },
        '15分間・1回だけ有効です。',
        m.user_id ? ' 入力すると、いま使っている端末は使えなくなります。' : ''));
    codeBox.scrollIntoView({ behavior: 'smooth' });
    // QR はリポジトリ内のライブラリで作る (外部サイトに頼らない)。失敗したらコードだけ表示する
    try {
      const { qrCanvas } = await import('./vendor/qrcode.js?v=1');
      qr.append(qrCanvas(new URL('./?join=' + data, location.href).href, 240));
      codeBox.scrollIntoView({ behavior: 'smooth' });
    } catch (e) {
      qr.replaceChildren(h('p', { class: 'muted' }, 'QRを表示できませんでした。下のコードを入力してください。'));
    }
  }

  const addMember = busy(async () => {
    const n = name.value.trim();
    if (!n) throw new Error('なまえを入力してください');
    const { error } = await sb.rpc('add_member', { member_name: n, member_role: role.value });
    if (error) throw error;
    name.value = '';
    await load();
  });

  show(
    h('header', { class: 'bar' },
      h('button', { onclick: viewHome }, '‹ もどる'),
      h('h1', null, 'せってい')),
    h('div', { class: 'pad' },
      h('h3', null, 'メンバー'),
      listEl,
      codeBox,
      h('h3', null, 'メンバーを追加'),
      h('div', { class: 'stack' }, name, role,
        h('button', { class: 'big', onclick: addMember }, '追加する')),
      h('h3', null, 'アカウント'),
      h('button', { class: 'big sub', onclick: logout }, 'ログアウト')));
  await load();
}

boot().catch((e) => {
  show(h('div', { class: 'pad stack' },
    h('p', null, 'うまく開けませんでした。'),
    h('p', { class: 'muted' }, errText(e)),
    h('button', { class: 'big', onclick: () => location.reload() }, 'もういちど')));
});
