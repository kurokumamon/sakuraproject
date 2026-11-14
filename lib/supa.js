// Supabase の最小クライアント。
// 公式の supabase-js は新しい構文を使っていて iOS 12 の Safari で動かないため、
// このアプリで使う機能 (認証・テーブル・RPC・ストレージ・リアルタイム) だけを古い書き方で実装している。
// 呼び出し方は supabase-js に合わせてあり、結果は { data, error } で返す (例外は投げない)。
//
// 注意: ?. や ?? などの新しい構文は iOS 12 で動かないので使わないこと。


// ---------- エラー ----------

const MESSAGES = [
  [/invalid login credentials/i, 'メールアドレスかパスワードがちがいます'],
  [/email not confirmed/i, 'メールの確認がまだです。とどいたメールのリンクをひらいてください'],
  [/already registered|already been registered|user_already_exists/i, 'このメールアドレスはすでに登録されています。ログインしてください'],
  [/password should be at least|weak_password/i, 'パスワードが短すぎます。8文字以上にしてください'],
  [/rate limit|too many requests|over_email_send_rate_limit/i, 'しばらく待ってから、もういちど ためしてください'],
  [/unable to validate email|invalid format|email_address_invalid/i, 'メールアドレスの形がただしくありません'],
  [/anonymous sign-ins are disabled/i, 'こどものログインが無効になっています（Supabase の設定を確認してください）'],
  [/jwt expired/i, 'ログインの期限が切れました。もういちどログインしてください'],
];

function makeError(message, status, code) {
  const text = String(message || 'エラーがおきました');
  for (let i = 0; i < MESSAGES.length; i++) {
    if (MESSAGES[i][0].test(text) || (code && MESSAGES[i][0].test(code))) {
      return { message: MESSAGES[i][1], status: status, code: code, original: text };
    }
  }
  return { message: text, status: status, code: code };
}

const networkError = () => makeError('つながりませんでした。ネットワークを確認してください', 0, 'network');

// fetch して JSON を読む。失敗しても例外は投げず { data, error } で返す
async function request(url, init) {
  let res;
  try {
    res = await fetch(url, init);
  } catch (e) {
    return { data: null, error: networkError(), status: 0 };
  }
  const text = await res.text().catch(function () { return ''; });
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = text; }
  }
  if (!res.ok) {
    const b = body && typeof body === 'object' ? body : {};
    const msg = b.msg || b.message || b.error_description || b.error || (typeof body === 'string' && body) || ('HTTP ' + res.status);
    return { data: null, error: makeError(msg, res.status, b.error_code || b.code), status: res.status };
  }
  return { data: body, error: null, status: res.status };
}

function readJSON(key) {
  try {
    const v = localStorage.getItem(key);
    return v ? JSON.parse(v) : null;
  } catch (e) {
    return null;
  }
}

// ---------- 認証 ----------

class Auth {
  constructor(client) {
    this.c = client;
    this.session = null;
    this.listeners = [];
    this.refreshing = null;
    this.ready = this.init();
  }

  async init() {
    // 登録確認メールのリンクから来たとき (#access_token=...&refresh_token=...)
    const hp = new URLSearchParams(location.hash.replace(/^#/, ''));
    if (hp.get('access_token') && hp.get('refresh_token')) {
      const s = {
        access_token: hp.get('access_token'),
        refresh_token: hp.get('refresh_token'),
        expires_at: Math.floor(Date.now() / 1000) + Number(hp.get('expires_in') || 3600),
        user: null,
      };
      const u = await this.getUser(s.access_token);
      if (u.data) {
        s.user = u.data;
        this.save(s);
      }
      return;
    }
    let s = readJSON(this.c.storageKey);
    if (!s) {
      // 以前の版 (supabase-js) のログイン状態を引きつぐ
      const ref = new URL(this.c.url).hostname.split('.')[0];
      s = readJSON('sb-' + ref + '-auth-token');
      if (s && s.access_token && s.refresh_token && s.user) this.save(s);
      else s = null;
    }
    this.session = s;
  }

  save(s) {
    this.session = s;
    try {
      if (s) localStorage.setItem(this.c.storageKey, JSON.stringify(s));
      else localStorage.removeItem(this.c.storageKey);
    } catch (e) { /* プライベートブラウズなどで保存できないときは、この画面の間だけ使う */ }
    for (let i = 0; i < this.listeners.length; i++) this.listeners[i](s);
  }

  onChange(fn) {
    this.listeners.push(fn);
  }

  call(path, method, body, token) {
    const headers = { apikey: this.c.key, 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return request(this.c.url + '/auth/v1' + path, {
      method: method,
      headers: headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  getUser(token) {
    return this.call('/user', 'GET', undefined, token);
  }

  // トークン応答からセッションを作って保存する
  adopt(d) {
    const s = {
      access_token: d.access_token,
      refresh_token: d.refresh_token,
      expires_at: d.expires_at || Math.floor(Date.now() / 1000) + Number(d.expires_in || 3600),
      user: d.user,
    };
    this.save(s);
    return s;
  }

  async refresh() {
    if (!this.refreshing) {
      const rt = this.session && this.session.refresh_token;
      this.refreshing = (async () => {
        const r = await this.call('/token?grant_type=refresh_token', 'POST', { refresh_token: rt });
        if (r.data && r.data.access_token) return this.adopt(r.data);
        // 期限切れなどで使えないときはログアウトあつかい。通信エラーのときは今のセッションのまま
        if (r.status >= 400 && r.status < 500) this.save(null);
        return this.session;
      })();
      this.refreshing.then(() => { this.refreshing = null; }, () => { this.refreshing = null; });
    }
    return this.refreshing;
  }

  async getSession() {
    await this.ready;
    let s = this.session;
    if (s && (!s.expires_at || s.expires_at - Date.now() / 1000 < 60)) s = await this.refresh();
    return { data: { session: s }, error: null };
  }

  async accessToken() {
    const r = await this.getSession();
    return r.data.session ? r.data.session.access_token : null;
  }

  async signUp(opts) {
    const o = opts.options || {};
    const q = o.emailRedirectTo ? '?redirect_to=' + encodeURIComponent(o.emailRedirectTo) : '';
    const r = await this.call('/signup' + q, 'POST', { email: opts.email, password: opts.password, data: o.data || {} });
    if (r.error) return { data: { session: null, user: null }, error: r.error };
    if (r.data.access_token) {
      const s = this.adopt(r.data);
      return { data: { session: s, user: s.user }, error: null };
    }
    return { data: { session: null, user: r.data }, error: null };
  }

  async signInWithPassword(opts) {
    const r = await this.call('/token?grant_type=password', 'POST', { email: opts.email, password: opts.password });
    if (r.error) return { data: { session: null }, error: r.error };
    return { data: { session: this.adopt(r.data) }, error: null };
  }

  async signInAnonymously() {
    const r = await this.call('/signup', 'POST', { data: {} });
    if (r.error) return { data: { session: null }, error: r.error };
    return { data: { session: this.adopt(r.data) }, error: null };
  }

  async signOut() {
    const token = this.session && this.session.access_token;
    this.save(null);
    if (token) await this.call('/logout', 'POST', {}, token);
    return { error: null };
  }
}

// ---------- テーブル (PostgREST) ----------

class Query {
  constructor(client, table) {
    this.c = client;
    this.table = table;
    this.method = 'GET';
    this.params = [];
    this.cols = null;
    this.body = undefined;
    this.prefer = [];
    this.mode = 'many';
  }

  select(cols) {
    this.cols = cols || '*';
    if (this.method !== 'GET') this.prefer.push('return=representation');
    return this;
  }
  eq(k, v) { this.params.push([k, 'eq.' + v]); return this; }
  neq(k, v) { this.params.push([k, 'neq.' + v]); return this; }
  in(k, list) { this.params.push([k, 'in.(' + list.join(',') + ')']); return this; }
  order(k, o) {
    const asc = !o || o.ascending !== false;
    this.params.push(['order', k + '.' + (asc ? 'asc' : 'desc')]);
    return this;
  }
  limit(n) { this.params.push(['limit', String(n)]); return this; }
  single() { this.mode = 'single'; return this; }
  maybeSingle() { this.mode = 'maybe'; return this; }

  insert(row) { this.method = 'POST'; this.body = row; return this; }
  update(values) { this.method = 'PATCH'; this.body = values; return this; }
  delete() { this.method = 'DELETE'; return this; }
  upsert(row, o) {
    this.method = 'POST';
    this.body = row;
    this.prefer.push('resolution=merge-duplicates');
    if (o && o.onConflict) this.params.push(['on_conflict', o.onConflict]);
    return this;
  }

  then(resolve, reject) {
    return this.run().then(resolve, reject);
  }

  async run() {
    const params = this.params.slice();
    if (this.cols) params.unshift(['select', this.cols]);
    const qs = params.map(function (p) { return encodeURIComponent(p[0]) + '=' + encodeURIComponent(p[1]); }).join('&');
    const headers = await this.c.headers();
    headers['Content-Type'] = 'application/json';
    const prefer = this.prefer.slice();
    if (this.method !== 'GET' && prefer.indexOf('return=representation') < 0) prefer.push('return=minimal');
    if (prefer.length) headers.Prefer = prefer.join(',');

    const r = await request(this.c.url + '/rest/v1/' + this.table + (qs ? '?' + qs : ''), {
      method: this.method,
      headers: headers,
      body: this.body === undefined ? undefined : JSON.stringify(this.body),
    });
    if (r.error) return { data: null, error: r.error };
    let data = r.data;
    if (this.mode !== 'many') {
      const rows = Array.isArray(data) ? data : data ? [data] : [];
      if (rows.length > 1 || (this.mode === 'single' && rows.length === 0)) {
        return { data: null, error: makeError('データが見つかりませんでした', 406, 'PGRST116') };
      }
      data = rows[0] || null;
    }
    return { data: data, error: null };
  }
}

// ---------- ストレージ ----------

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

class Bucket {
  constructor(client, bucket) {
    this.c = client;
    this.bucket = bucket;
  }

  async upload(path, blob, o) {
    const headers = await this.c.headers();
    headers['Content-Type'] = (o && o.contentType) || blob.type || 'application/octet-stream';
    headers['x-upsert'] = 'false';
    headers['cache-control'] = 'max-age=3600';
    return request(this.c.url + '/storage/v1/object/' + this.bucket + '/' + encodePath(path), {
      method: 'POST', headers: headers, body: blob,
    });
  }

  async createSignedUrl(path, expiresIn) {
    const headers = await this.c.headers();
    headers['Content-Type'] = 'application/json';
    const r = await request(this.c.url + '/storage/v1/object/sign/' + this.bucket + '/' + encodePath(path), {
      method: 'POST', headers: headers, body: JSON.stringify({ expiresIn: expiresIn }),
    });
    if (r.error) return r;
    const signed = r.data.signedURL || r.data.signedUrl;
    return { data: { signedUrl: this.c.url + '/storage/v1' + signed }, error: null };
  }
}

// ---------- リアルタイム ----------

class Channel {
  constructor(rt, name) {
    this.rt = rt;
    this.topic = 'realtime:' + name;
    this.bindings = [];
  }

  // on('postgres_changes', { event, schema, table, filter }, callback)
  on(type, filter, callback) {
    if (type === 'postgres_changes') this.bindings.push({ filter: filter, callback: callback });
    return this;
  }

  subscribe() {
    this.rt.add(this);
    return this;
  }

  handle(data) {
    for (let i = 0; i < this.bindings.length; i++) {
      const f = this.bindings[i].filter;
      if (f.table !== data.table) continue;
      if (f.event && f.event !== '*' && f.event !== data.type) continue;
      try {
        this.bindings[i].callback({ eventType: data.type, new: data.record || {}, old: data.old_record || {} });
      } catch (e) {
        setTimeout(function () { throw e; });
      }
    }
  }
}

class Realtime {
  constructor(client) {
    this.c = client;
    this.ws = null;
    this.channels = [];
    this.ref = 0;
    this.heartbeat = null;
    this.retryTimer = null;
    this.retries = 0;
    client.auth.onChange((s) => {
      // トークンが更新されたら、つないでいるチャンネルにも知らせる
      if (s && this.ws && this.ws.readyState === 1) {
        this.channels.forEach((ch) => this.send(ch.topic, 'access_token', { access_token: s.access_token }));
      }
    });
    document.addEventListener('visibilitychange', () => {
      // バックグラウンドで切れた接続を、もどってきたらすぐつなぎなおす
      if (document.visibilityState === 'visible' && this.channels.length && (!this.ws || this.ws.readyState > 1)) {
        this.retries = 0;
        this.connect();
      }
    });
  }

  send(topic, event, payload) {
    if (!this.ws || this.ws.readyState !== 1) return;
    this.ref += 1;
    this.ws.send(JSON.stringify({ topic: topic, event: event, payload: payload, ref: String(this.ref) }));
  }

  async join(ch) {
    const token = await this.c.auth.accessToken();
    const changes = ch.bindings.map(function (b) {
      const c = { event: b.filter.event || '*', schema: b.filter.schema || 'public', table: b.filter.table };
      if (b.filter.filter) c.filter = b.filter.filter;
      return c;
    });
    this.send(ch.topic, 'phx_join', {
      config: { broadcast: { ack: false, self: false }, presence: { key: '' }, postgres_changes: changes, private: false },
      access_token: token,
    });
  }

  add(ch) {
    this.channels.push(ch);
    if (this.ws && this.ws.readyState === 1) this.join(ch);
    else this.connect();
  }

  remove(ch) {
    const i = this.channels.indexOf(ch);
    if (i < 0) return;
    this.channels.splice(i, 1);
    this.send(ch.topic, 'phx_leave', {});
    if (!this.channels.length) this.close();
  }

  close() {
    clearInterval(this.heartbeat);
    clearTimeout(this.retryTimer);
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onclose = null;
      try { ws.close(); } catch (e) { /* もう切れている */ }
    }
  }

  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    this.close();
    const url = this.c.url.replace(/^http/, 'ws') + '/realtime/v1/websocket?apikey=' + encodeURIComponent(this.c.key) + '&vsn=1.0.0';
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.scheduleRetry();
      return;
    }
    this.ws = ws;
    ws.onopen = () => {
      this.retries = 0;
      this.channels.forEach((ch) => this.join(ch));
      this.heartbeat = setInterval(() => this.send('phoenix', 'heartbeat', {}), 25000);
    };
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch (e) { return; }
      if (m.event !== 'postgres_changes' || !m.payload || !m.payload.data) return;
      this.channels.forEach(function (ch) { if (ch.topic === m.topic) ch.handle(m.payload.data); });
    };
    ws.onclose = () => {
      clearInterval(this.heartbeat);
      if (this.ws === ws) this.ws = null;
      this.scheduleRetry();
    };
  }

  scheduleRetry() {
    if (!this.channels.length) return;
    clearTimeout(this.retryTimer);
    const wait = [1000, 2000, 5000, 10000, 30000][Math.min(this.retries, 4)];
    this.retries += 1;
    this.retryTimer = setTimeout(() => this.connect(), wait);
  }
}

// ---------- クライアント ----------

class Client {
  constructor(url, key, options) {
    this.url = url.replace(/\/$/, '');
    this.key = key;
    this.storageKey = (options && options.storageKey) || 'sakura-auth';
    this.auth = new Auth(this);
    this.realtime = new Realtime(this);
  }

  async headers() {
    const h = { apikey: this.key };
    const token = await this.auth.accessToken();
    if (token) h.Authorization = 'Bearer ' + token;
    return h;
  }

  from(table) {
    return new Query(this, table);
  }

  async rpc(name, args) {
    const headers = await this.headers();
    headers['Content-Type'] = 'application/json';
    return request(this.url + '/rest/v1/rpc/' + name, {
      method: 'POST', headers: headers, body: JSON.stringify(args || {}),
    }).then(function (r) { return { data: r.data, error: r.error }; });
  }

  get storage() {
    const c = this;
    return { from: function (bucket) { return new Bucket(c, bucket); } };
  }

  channel(name) {
    return new Channel(this.realtime, name);
  }

  removeChannel(ch) {
    this.realtime.remove(ch);
  }
}

export function createClient(url, key, options) {
  return new Client(url, key, options);
}
