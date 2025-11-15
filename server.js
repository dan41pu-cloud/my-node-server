// server.js
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

// ===== USERS STORAGE =====
const usersFile = "./users.json";
let users = {};

// загружаем файл при старте
if (fs.existsSync(usersFile)) {
    users = JSON.parse(fs.readFileSync(usersFile, "utf8"));
}

// сохраняем пользователей
function saveUsers() {
    fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
}

app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, 'public')));

// === REGISTER ===
app.post("/register", (req, res) => {
    const { username, password, avatar } = req.body;

    if (!username || !password)
        return res.json({ ok: false, msg: "Введите логин и пароль" });

    if (users[username])
        return res.json({ ok: false, msg: "Такой логин уже существует" });

    users[username] = {
        password,
        avatar: avatar || null
    };

    saveUsers();

    res.json({ ok: true, msg: "Регистрация успешна" });
});

// === LOGIN ===
app.post("/login", (req, res) => {
    const { username, password } = req.body;

    if (!users[username])
        return res.json({ ok: false, msg: "Пользователь не найден" });

    if (users[username].password !== password)
        return res.json({ ok: false, msg: "Неверный пароль" });

    res.json({
        ok: true,
        username,
        avatar: users[username].avatar || null,
        messages: []   // если хочешь — позже добавлю сохранение сообщений
    });
});

// ===== AUDIO USERS =====
let audioUsers = {}; // socketId → username

io.on('connection', (socket) => {
    console.log("socket connected", socket.id);

    socket.on("join-audio", (username) => {
        socket.username = username;
        audioUsers[socket.id] = username;

        io.emit("audio-users", Object.values(audioUsers));
        socket.broadcast.emit("new-audio-user", username);

        console.log("join-audio:", username);
    });

    socket.on("leave-audio", () => {
        delete audioUsers[socket.id];
        io.emit("audio-users", Object.values(audioUsers));
        socket.broadcast.emit("audio-left", socket.username);
    });

    socket.on("disconnect", () => {
        if (audioUsers[socket.id]) {
            delete audioUsers[socket.id];
            io.emit("audio-users", Object.values(audioUsers));
            socket.broadcast.emit("audio-left", socket.username);
        }
        console.log("disconnect", socket.id);
    });

    // ==== WebRTC Relay ====
    socket.on("audio-offer", (payload) => {
        for (let sid in audioUsers) {
            if (audioUsers[sid] === payload.to) {
                io.to(sid).emit("audio-offer", payload);
                break;
            }
        }
    });

    socket.on("audio-answer", (payload) => {
        for (let sid in audioUsers) {
            if (audioUsers[sid] === payload.to) {
                io.to(sid).emit("audio-answer", payload);
                break;
            }
        }
    });

    socket.on("ice-candidate", (payload) => {
        for (let sid in audioUsers) {
            if (audioUsers[sid] === payload.to) {
                io.to(sid).emit("ice-candidate", payload);
                break;
            }
        }
    });

    // CHAT
    socket.on("chat message", (msg) => {
        msg.time = new Date().toLocaleTimeString();
        io.emit("chat message", msg);
    });

    socket.on("chat image", (msg) => {
        msg.time = new Date().toLocaleTimeString();
        io.emit("chat image", msg);
    });

    socket.on("clear-messages", () => io.emit("chat-cleared"));
});

server.listen(PORT, () => console.log("Server listening " + PORT));
