// client.js - логика фронтенда для SuperChat
const socket = io();

let me = null;
let localStream = null;
const pcs = {}; // peer connections by remote username

// --- DOM ---
const auth = document.getElementById('auth');
const authMsg = document.getElementById('authMsg');
const usernameInput = document.getElementById('usernameInput');
const passwordInput = document.getElementById('passwordInput');
const avatarInput = document.getElementById('avatarInput');
const registerBtn = document.getElementById('registerBtn');
const loginBtn = document.getElementById('loginBtn');

const chat = document.getElementById('chat');
const usersPanel = document.getElementById('usersPanel');
const messagesList = document.getElementById('messages');
const msgInput = document.getElementById('msgInput');
const sendBtn = document.getElementById('sendBtn');
const fileInput = document.getElementById('fileInput');

// --- helpers ---
function el(tag, cls, inner){
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (inner !== undefined) e.innerHTML = inner;
  return e;
}

function showAuthMsg(text, isError = false){
  authMsg.style.color = isError ? '#ffb4b4' : '';
  authMsg.textContent = text;
  setTimeout(()=>{ authMsg.textContent = '' }, 4000);
}

// --- registration/login ---
registerBtn.onclick = async () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  const avatarFile = avatarInput.files[0];

  if (!username || !password) return showAuthMsg('Введите логин и пароль', true);

  let avatarData = null;
  if (avatarFile){
    avatarData = await fileToDataURL(avatarFile);
  }

  const res = await fetch('/register', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ username, password, avatar: avatarData })
  });
  const j = await res.json();
  if (!j.ok) return showAuthMsg(j.msg, true);
  showAuthMsg(j.msg);
};

loginBtn.onclick = async () => {
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) return showAuthMsg('Введите логин и пароль', true);

  const res = await fetch('/login', {
    method:'POST',
    headers:{ 'Content-Type':'application/json' },
    body: JSON.stringify({ username, password })
  });
  const j = await res.json();
  if (!j.ok) return showAuthMsg(j.msg, true);

  me = { username: j.username, avatar: j.avatar || null };
  enterChat();
};

// --- switch to chat UI ---
function enterChat(){
  auth.classList.add('hidden');
  chat.classList.remove('hidden');

  // tell server we're present for audio list
  socket.emit('join-audio', me.username);

  sendBtn.onclick = sendMessage;
  msgInput.addEventListener('keydown', (e)=>{ if (e.key === 'Enter') sendMessage(); });
  fileInput.addEventListener('change', handleFileInput);

  // listen socket events
  socket.on('chat message', onChatMessage);
  socket.on('chat image', onChatImage);
  socket.on('chat-cleared', clearAllMessages);

  socket.on('audio-users', (list) => renderUsers(list));
  socket.on('new-audio-user', (u) => addSimpleNotice(`${u} пришёл в аудио`));
  socket.on('audio-left', (u) => addSimpleNotice(`${u} ушёл из аудио`));

  // webRTC signaling
  socket.on('audio-offer', async (payload) => {
    if (payload.to !== me.username) return;
    await ensureLocalStream(true, true); // allow mic+cam
    await handleOffer(payload);
  });
  socket.on('audio-answer', async (payload) => {
    if (payload.to !== me.username) return;
    await handleAnswer(payload);
  });
  socket.on('ice-candidate', async (payload) => {
    if (payload.to !== me.username) return;
    await handleRemoteIce(payload);
  });
}

// --- messages ---
function sendMessage(){
  const text = msgInput.value.trim();
  if (!text) return;
  const msg = { from: me.username, avatar: me.avatar, text };
  socket.emit('chat message', msg);
  msgInput.value = '';
}

function renderMessage(msg, isOwn = false, id = null){
  const li = el('li', 'message' + (isOwn ? ' own' : ''));
  if (id) li.dataset.id = id;

  const meta = el('div', 'meta');
  const avatar = el('img'); avatar.className = 'avatar'; avatar.src = msg.avatar || defaultAvatar(msg.from);
  const name = el('div', 'name', escapeHtml(msg.from));
  const time = el('div', 'time', msg.time || '');
  meta.appendChild(avatar);
  meta.appendChild(el('div', null, '')).appendChild(name);
  meta.appendChild(time);

  li.appendChild(meta);

  if (msg.text){
    const p = el('div', 'text', escapeHtml(msg.text));
    li.appendChild(p);
  }
  if (msg.image){
    const im = el('img'); im.className = 'msg-img'; im.src = msg.image;
    li.appendChild(im);
  }

  const actions = el('div', 'msg-actions');
  if (isOwn){
    const delBtn = el('button', null, '🗑');
    delBtn.title = 'Удалить (локально)';
    delBtn.onclick = () => li.remove();
    actions.appendChild(delBtn);
  }
  li.appendChild(actions);

  messagesList.appendChild(li);
  messagesList.scrollTop = messagesList.scrollHeight;
}

function onChatMessage(msg){
  const isOwn = me && msg.from === me.username;
  renderMessage(msg, isOwn);
}
function onChatImage(msg){
  const isOwn = me && msg.from === me.username;
  renderMessage(msg, isOwn);
}
function clearAllMessages(){
  messagesList.innerHTML = '';
}
function addSimpleNotice(text){
  const li = el('li','message'); li.style.opacity = 0.8;
  li.textContent = text;
  messagesList.appendChild(li);
  messagesList.scrollTop = messagesList.scrollHeight;
}

// --- file upload (image) ---
async function handleFileInput(e){
  const f = e.target.files[0];
  if (!f) return;
  // only images for now
  if (!f.type.startsWith('image/')) return alert('Можно отправлять только изображения');
  const data = await fileToDataURL(f);
  const payload = { from: me.username, avatar: me.avatar, image: data };
  socket.emit('chat image', payload);
  // reset
  fileInput.value = '';
}

// --- users panel ---
function renderUsers(list){
  usersPanel.innerHTML = '<h3>Пользователи (для звонка)</h3>';
  list.forEach(u => {
    const item = el('div','user-item');
    const img = el('img'); img.className = 'avatar'; img.src = defaultAvatar(u);
    const name = el('div','u-name', escapeHtml(u));
    item.appendChild(img);
    item.appendChild(name);

    // don't show self as clickable
    if (me && u === me.username){
      const meTag = el('div', null, ' (вы)');
      meTag.style.marginLeft = '6px'; meTag.style.color = '#94a3b8';
      name.appendChild(meTag);
    } else {
      item.style.cursor = 'pointer';
      item.onclick = () => startCallTo(u);
    }
    usersPanel.appendChild(item);
  });
}

// --- default avatar helper ---
function defaultAvatar(name){
  // simple SVG data url with initials
  const initials = (name||'?').slice(0,2).toUpperCase();
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='64' height='64'><rect width='100%' height='100%' fill='#0b1220'/><text x='50%' y='55%' font-size='28' fill='#06b6d4' text-anchor='middle' font-family='Verdana'>${initials}</text></svg>`;
  return 'data:image/svg+xml;utf8,'+encodeURIComponent(svg);
}

// --- file to dataURL ---
function fileToDataURL(file){
  return new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = rej;
    r.readAsDataURL(file);
  });
}

// --- safe escape html ---
function escapeHtml(s){
  return (s||'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
}

/* ----------------- WebRTC (audio/video) ----------------- */
/*
  Logic:
  - When user clicks another username -> startCallTo(username)
  - We create RTCPeerConnection, get local stream, add tracks, createOffer, send 'audio-offer' with { from, to, sdp }
  - Remote receives 'audio-offer', creates pc, sets remote desc, createAnswer -> send 'audio-answer'
  - Exchange ICE via 'ice-candidate' messages with { from, to, candidate }
  - Each pc stores remote stream and opens a small window with <video> element
*/

async function ensureLocalStream(wantsAudio = true, wantsVideo = false){
  if (localStream) return localStream;
  try {
    localStream = await navigator.mediaDevices.getUserMedia({ audio: wantsAudio, video: wantsVideo });
    return localStream;
  } catch (err) {
    alert('Не удалось получить доступ к микрофону/камере: ' + (err.message || err));
    throw err;
  }
}

function createPeerConnectionFor(remote){
  if (pcs[remote]) return pcs[remote].pc;
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  const container = document.createElement('div');
  container.className = 'call-box';
  container.style = 'position:fixed;right:12px;bottom:12px;background:rgba(2,6,23,0.7);padding:8px;border-radius:10px;color:#fff;z-index:9999';
  const title = document.createElement('div'); title.textContent = 'Call: ' + remote;
  const remoteVideo = document.createElement('video'); remoteVideo.autoplay = true; remoteVideo.playsInline = true; remoteVideo.style.maxWidth = '240px'; remoteVideo.style.display = 'block';
  const endBtn = document.createElement('button'); endBtn.textContent = 'Закончить'; endBtn.style.marginTop = '6px';
  endBtn.onclick = () => endCall(remote, true);
  container.appendChild(title); container.appendChild(remoteVideo); container.appendChild(endBtn);
  document.body.appendChild(container);

  pcs[remote] = { pc, el: container, remoteVideo };

  pc.onicecandidate = (e) => {
    if (e.candidate){
      socket.emit('ice-candidate', { from: me.username, to: remote, candidate: e.candidate });
    }
  };

  const remoteStream = new MediaStream();
  pc.ontrack = (ev) => {
    ev.streams[0].getTracks().forEach(t => remoteStream.addTrack(t));
    pcs[remote].remoteVideo.srcObject = remoteStream;
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed' || pc.connectionState === 'closed'){
      endCall(remote, false);
    }
  };

  return pc;
}

async function startCallTo(remote){
  if (!me) return alert('Сначала войдите');
  if (remote === me.username) return;
  await ensureLocalStream(true, true); // ask audio+video
  const pc = createPeerConnectionFor(remote);

  // add local tracks
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // create offer
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  // send offer via signaling
  socket.emit('audio-offer', { from: me.username, to: remote, sdp: offer });
  addSimpleNotice(`Предложение звонка отправлено ${remote} — ждём ответа`);
}

async function handleOffer(payload){
  const remote = payload.from;
  await ensureLocalStream(true, true);
  const pc = createPeerConnectionFor(remote);

  // add local tracks
  localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

  // set remote description
  await pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);

  socket.emit('audio-answer', { from: me.username, to: remote, sdp: answer });
  addSimpleNotice(`Ответ на звонок отправлен ${remote}`);
}

async function handleAnswer(payload){
  const remote = payload.from;
  const obj = pcs[remote];
  if (!obj) return console.warn('Нет PC для', remote);
  await obj.pc.setRemoteDescription(new RTCSessionDescription(payload.sdp));
  addSimpleNotice('Соединение установлено с ' + remote);
}

async function handleRemoteIce(payload){
  const remote = payload.from;
  const obj = pcs[remote];
  if (!obj) return;
  try {
    await obj.pc.addIceCandidate(new RTCIceCandidate(payload.candidate));
  } catch (err) {
    console.warn('Ошибка добавления ICE', err);
  }
}

function endCall(remote, removeUi = true){
  const obj = pcs[remote];
  if (!obj) return;
  try { obj.pc.close(); } catch(e){}
  if (obj.el && removeUi) obj.el.remove();
  delete pcs[remote];
  addSimpleNotice('Звонок с ' + remote + ' завершён');
}

// --- cleanup when leaving page ---
window.addEventListener('beforeunload', () => {
  try { socket.emit('leave-audio'); } catch(e){}
});

// --- small: allow clearing chat for everyone ---
window.addEventListener('keydown', (e)=>{
  // Ctrl+Shift+K -> clear chat for everyone (demo)
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase()==='k'){
    if (confirm('Очистить чат для всех?')) socket.emit('clear-messages');
  }
});
