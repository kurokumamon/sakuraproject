// さくらトークの通話ページ (1対1のビデオ／音声通話)。
// iOS 12 のホーム画面アプリではカメラが使えないので、このページは別オリジンに置き、Safari で開く。
// ログインはせず、アプリが発行した短時間だけ有効なトークン (#t=...) で参加する。
//
// 流れ: トークンを Edge Function "call" に送る → 部屋 (broadcast のチャンネル名) と ICE サーバーをもらう
//   → 「はじめる」でカメラ・マイクを取る (iPhone ではボタンを押したときでないと音が出ないため)
//   → Supabase Realtime の broadcast で SDP と ICE をやりとりする。オファーを出すのは かけた側 だけ。
//
// 注意: iOS 12 の Safari で動かすため、?. や ?? などの新しい構文は使わない。
import { createClient } from './lib/supa.js?v=2';
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './config.js';

const $ = (id) => document.getElementById(id);
const remoteVideo = $('remote');
const localVideo = $('local');
const peerEl = $('peer');
const statusEl = $('status');
const actionsEl = $('actions');
const controls = $('controls');

const token = new URLSearchParams(location.hash.replace(/^#/, '')).get('t');
const FN_URL = SUPABASE_URL + '/functions/v1/call';
const myId = Math.random().toString(36).slice(2) + Date.now().toString(36); // この画面の ID (ひらきなおすと変わる)

let info = null;     // { role, video, room, me, peer, iceServers }
let localStream = null;
let pc = null;
let sid = null;      // いまの接続の ID (かけた側が決める)。古い接続の ICE を捨てるのに使う
let pendingIce = [];
let channel = null;
let sb = null;
let lastOffer = 0;
let connectedOnce = false;
let finished = false;
let pollTimer = null;
let leaveTimer = null;
let signalQueue = Promise.resolve();

// ---------- 画面 ----------

function setStatus(text) { statusEl.textContent = text; }

function button(label, cls, onclick) {
  const b = document.createElement('button');
  b.className = 'big' + (cls ? ' ' + cls : '');
  b.textContent = label;
  b.addEventListener('click', onclick);
  return b;
}

function setActions(list) {
  while (actionsEl.firstChild) actionsEl.removeChild(actionsEl.firstChild);
  for (let i = 0; i < list.length; i++) actionsEl.appendChild(list[i]);
}

function finish(text) {
  if (finished) return;
  finished = true;
  clearInterval(pollTimer);
  clearTimeout(leaveTimer);
  if (pc) { try { pc.close(); } catch (e) { /* もう閉じている */ } }
  pc = null;
  if (localStream) localStream.getTracks().forEach(function (t) { t.stop(); });
  if (channel && sb) sb.removeChannel(channel);
  document.body.className = '';
  controls.hidden = true;
  remoteVideo.srcObject = null;
  setStatus(text + '\nこの画面をとじて、さくらトークにもどってください。');
  setActions([]);
}

// ---------- Edge Function ----------

async function callFn(action) {
  let res;
  try {
    res = await fetch(FN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: token, action: action }),
    });
  } catch (e) {
    return { error: 'network' };
  }
  try { return await res.json(); } catch (e) { return { error: 'HTTP ' + res.status }; }
}

const OVER = {
  ended: 'でんわは おわりました。',
  declined: 'あいては でられませんでした。',
  missed: 'あいては でませんでした。',
  canceled: 'でんわは とりけされました。',
};

function errorText(r) {
  if (r.error === 'over') return OVER[r.status] || 'でんわは おわりました。';
  if (r.error === 'expired') return 'このリンクは きげんぎれです。さくらトークから もういちど かけてください。';
  if (r.error === 'network') return 'つながりませんでした。ネットワークを たしかめてください。';
  return 'このリンクは つかえません。さくらトークから もういちど かけてください。';
}

// ---------- WebRTC ----------

// 映像は H.264 を優先する (iOS 12 の Safari は H.264 しか送受信できない)
function preferH264(sdp) {
  const lines = sdp.split('\r\n');
  const mIndex = lines.findIndex(function (l) { return l.indexOf('m=video ') === 0; });
  if (mIndex < 0) return sdp;
  const h264 = [];
  lines.forEach(function (l) {
    const m = /^a=rtpmap:(\d+) H264\/90000/i.exec(l);
    if (m) h264.push(m[1]);
  });
  if (!h264.length) return sdp;
  // H.264 の再送用 (rtx) も一緒に前へ
  lines.forEach(function (l) {
    const m = /^a=fmtp:(\d+) apt=(\d+)/.exec(l);
    if (m && h264.indexOf(m[2]) >= 0) h264.push(m[1]);
  });
  const parts = lines[mIndex].split(' ');
  const head = parts.slice(0, 3);
  const pts = parts.slice(3);
  const ordered = h264.filter(function (p) { return pts.indexOf(p) >= 0; })
    .concat(pts.filter(function (p) { return h264.indexOf(p) < 0; }));
  lines[mIndex] = head.concat(ordered).join(' ');
  return lines.join('\r\n');
}

function signal(kind, data) {
  const payload = { from: myId, role: info.role, kind: kind };
  for (const k in data || {}) payload[k] = data[k];
  channel.send({ type: 'broadcast', event: 'signal', payload: payload });
}

function newPeer(newSid) {
  if (pc) {
    pc.onicecandidate = null; pc.ontrack = null; pc.oniceconnectionstatechange = null;
    try { pc.close(); } catch (e) { /* もう閉じている */ }
  }
  sid = newSid;
  pendingIce = [];
  const p = new RTCPeerConnection({ iceServers: info.iceServers });
  p.onicecandidate = function (e) {
    if (e.candidate && p === pc) signal('ice', { sid: sid, cand: e.candidate.toJSON ? e.candidate.toJSON() : e.candidate });
  };
  p.ontrack = function (e) {
    const stream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
    if (remoteVideo.srcObject !== stream) {
      remoteVideo.srcObject = stream;
      const pr = remoteVideo.play();
      if (pr && pr.catch) pr.catch(function () { showTapToPlay(); });
    }
  };
  p.oniceconnectionstatechange = function () {
    if (p !== pc || finished) return;
    const s = p.iceConnectionState;
    if (s === 'connected' || s === 'completed') {
      connectedOnce = true;
      clearTimeout(leaveTimer);
      document.body.className = 'incall' + (info.video ? ' video' : '');
      setStatus(info.video ? '' : 'つうわちゅう');
    } else if (s === 'disconnected') {
      setStatus('つながりが わるいです…');
    } else if (s === 'failed') {
      setStatus('つなぎなおしています…');
      if (info.role === 'caller') makeOffer();
    }
  };
  pc = p;
  return p;
}

function addLocalTracks(p) {
  localStream.getTracks().forEach(function (t) { p.addTrack(t, localStream); });
}

async function flushIce() {
  const list = pendingIce;
  pendingIce = [];
  for (let i = 0; i < list.length; i++) {
    try { await pc.addIceCandidate(list[i]); } catch (e) { /* 古い候補などは無視 */ }
  }
}

// かけた側: オファーを出す (相手が来たとき・つなぎなおすとき)
async function makeOffer() {
  if (Date.now() - lastOffer < 1500) return; // 「来たよ」が重なったときの二重オファーを防ぐ
  lastOffer = Date.now();
  const p = newPeer(Math.random().toString(36).slice(2));
  addLocalTracks(p);
  const offer = await p.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: info.video });
  const sdp = preferH264(offer.sdp);
  await p.setLocalDescription({ type: 'offer', sdp: sdp });
  signal('offer', { sid: sid, sdp: sdp });
}

// 出た側: オファーに答える
async function answer(msg) {
  const p = newPeer(msg.sid);
  await p.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
  addLocalTracks(p); // 相手の設定を読んでから足すと、同じ送受信の枠を使い回せる
  const ans = await p.createAnswer();
  await p.setLocalDescription(ans);
  signal('answer', { sid: sid, sdp: ans.sdp });
  await flushIce();
}

async function onSignal(m) {
  if (finished || !m || m.from === myId || m.role === info.role) return;
  try {
    if (m.kind === 'ready') {
      // かけた側は オファーを出す。出た側は「わたしもいるよ」と返す (かけた側が開きなおしたとき用)
      if (info.role === 'caller') await makeOffer();
      else if (!m.reply) signal('ready', { reply: true });
    } else if (m.kind === 'offer' && info.role === 'callee') {
      await answer(m);
    } else if (m.kind === 'answer' && info.role === 'caller' && pc && m.sid === sid) {
      await pc.setRemoteDescription({ type: 'answer', sdp: m.sdp });
      await flushIce();
    } else if (m.kind === 'ice' && pc && m.sid === sid) {
      if (pc.remoteDescription && pc.remoteDescription.type) {
        try { await pc.addIceCandidate(m.cand); } catch (e) { /* 無視 */ }
      } else {
        pendingIce.push(m.cand);
      }
    } else if (m.kind === 'bye') {
      finish('でんわは おわりました。');
    } else if (m.kind === 'leave') {
      // 相手が画面をとじた・ひらきなおしている。30 秒もどらなければ おわりにする
      setStatus('あいてを まっています…');
      clearTimeout(leaveTimer);
      leaveTimer = setTimeout(function () {
        finish('あいてが もどってきませんでした。');
        callFn('end');
      }, 30000);
    }
  } catch (e) {
    console.error(e);
    setStatus('うまく つながりませんでした。');
  }
}

// ---------- 操作 ----------

function showTapToPlay() {
  setActions([button('🔊 タップして おとを だす', '', function () {
    remoteVideo.play();
    setActions([]);
  })]);
}

function toggle(kind, btn) {
  if (!localStream) return;
  const tracks = kind === 'audio' ? localStream.getAudioTracks() : localStream.getVideoTracks();
  if (!tracks.length) return;
  const on = !tracks[0].enabled;
  tracks.forEach(function (t) { t.enabled = on; });
  btn.className = 'ctl' + (on ? '' : ' off');
}

async function hangup() {
  if (channel) signal('bye');
  finish('でんわを きりました。');
  await callFn('end');
}

async function start() {
  setActions([]);
  setStatus('カメラと マイクを じゅんびしています…');
  try {
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: info.video ? { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } } : false,
    });
  } catch (e) {
    setStatus('カメラと マイクが つかえませんでした。\n「設定」→「Safari」→「カメラ」「マイク」を「許可」にして、もういちど ひらいてください。');
    setActions([button('もういちど', '', start)]);
    return;
  }
  if (info.video) {
    localVideo.srcObject = localStream;
    document.body.className = 'video';
  }
  $('cam').style.display = info.video ? '' : 'none';
  controls.hidden = false;
  setStatus(info.role === 'caller' ? 'よびだしています…' : 'つないでいます…');

  sb = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { storageKey: 'sakura-call' });
  channel = sb.channel('call-' + info.room)
    .on('broadcast', { event: 'signal' }, function (e) {
      // 届いた順に1つずつ処理する (オファーの処理中に ICE が来ても順番がくずれないように)
      signalQueue = signalQueue.then(function () { return onSignal(e.payload); });
    })
    .subscribe(function (s) {
      // つながるたびに「来たよ」を送る (つなぎなおしたときも、相手から接続をやりなおしてもらえる)
      if (s === 'SUBSCRIBED' && !finished) signal('ready');
    });

  // 相手が出ない・切った・取り消したことを知るため、ときどき状態を見に行く
  // (「きる」の合図が届かなかったときも、これで気づける)
  pollTimer = setInterval(async function () {
    if (finished) return;
    const r = await callFn('status');
    if (finished) return;
    if (r.error && r.error !== 'network') return finish(errorText(r));
    if (r.status && r.status !== 'ringing' && r.status !== 'active') finish(OVER[r.status] || 'でんわは おわりました。');
  }, 4000);
}

async function main() {
  if (!token) return finish('このリンクは つかえません。');
  if (!window.RTCPeerConnection || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    finished = true;
    setStatus('この ブラウザでは でんわが できません。\niPhone では「Safari」で ひらいてください。');
    return;
  }
  const r = await callFn('join');
  if (r.error) {
    finished = true;
    setStatus(errorText(r));
    return;
  }
  info = r;
  peerEl.textContent = r.peer || '';
  setStatus((r.video ? '📹 ビデオでんわ' : '📞 でんわ') + (r.role === 'caller' ? '（かける）' : ''));
  setActions([button(r.role === 'caller' ? 'かける' : 'でる', '', start)]);

  $('mic').addEventListener('click', function () { toggle('audio', $('mic')); });
  $('cam').addEventListener('click', function () { toggle('video', $('cam')); });
  $('hangup').addEventListener('click', hangup);
  // 画面をとじた・ひらきなおしたときは、相手に「はなれた」と知らせる (すぐには おわりにしない)
  window.addEventListener('pagehide', function () {
    if (channel && !finished) signal('leave');
  });
}

main();
