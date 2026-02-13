const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// Mock database for Hunter Records
let hunters = {}; 
let rooms = {};

// --- RANKING HELPERS ---
function getDetailedRank(mana) {
    if (mana >= 1000) return "Higher S-Rank";
    if (mana >= 901) return "Lower S-Rank";
    if (mana >= 801) return "Higher A-Rank";
    if (mana >= 701) return "Lower A-Rank";
    if (mana >= 601) return "Higher B-Rank";
    if (mana >= 501) return "Lower B-Rank";
    if (mana >= 401) return "Higher C-Rank";
    if (mana >= 301) return "Lower C-Rank";
    if (mana >= 201) return "Higher D-Rank";
    if (mana >= 101) return "Lower D-Rank";
    if (mana >= 51) return "Higher E-Rank";
    return "Lower E-Rank";
}

function getShortRankLabel(mana) {
    return getDetailedRank(mana).replace("-Rank", "");
}

// --- CORE FUNCTIONS ---
function broadcastGameState(room) { 
    if (!room) return;
    const sanitizedPlayers = room.players.map(p => ({
        ...p,
        rankLabel: getShortRankLabel(p.mana),
        displayName: `${p.name} [${getShortRankLabel(p.mana)}]` 
    }));
    const state = { ...room, players: sanitizedPlayers };
    io.to(room.id).emit('gameStateUpdate', state); 
}

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    console.log('Hunter Connected:', socket.id);

    // 1. AUTHENTICATION (The fix for your login issue)
    socket.on('authRequest', (data) => {
        const { type, u, p } = data;
        if (type === 'signup') {
            if (hunters[u]) return socket.emit('authError', "ID ALREADY REGISTERED");
            hunters[u] = { username: u, password: p, mana: 10, wins: 0, losses: 0 };
        }
        
        const user = hunters[u];
        if (user && user.password === p) {
            socket.emit('authSuccess', {
                username: user.username,
                mana: user.mana,
                rank: getDetailedRank(user.mana),
                wins: user.wins,
                losses: user.losses,
                color: 'var(--sys-blue)'
            });
        } else {
            socket.emit('authError', "INVALID ACCESS CODE");
        }
    });

    // 2. WORLD RANKINGS
    socket.on('requestWorldRankings', () => {
        const list = Object.values(hunters)
            .sort((a, b) => b.mana - a.mana)
            .map(h => ({ username: h.username, manapoints: h.mana }));
        socket.emit('updateWorldRankings', list);
    });

    // 3. CHAT SYSTEM
    socket.on('sendMessage', (data) => {
        const shortRank = "E-Rank"; // Default if not in room
        const chatPayload = {
            sender: data.senderName,
            text: data.message,
            rank: shortRank,
            time: new Date().toLocaleTimeString()
        };

        if (data.roomId) {
            io.to(data.roomId).emit('receiveMessage', chatPayload);
        } else {
            io.emit('receiveGlobalMessage', chatPayload);
        }
    });

    // 4. LOBBY & GATES
    socket.on('requestGateList', () => {
        const list = Object.values(rooms).filter(r => !r.started).map(r => ({
            id: r.id,
            name: r.name,
            count: r.players.length
        }));
        socket.emit('updateGateList', list);
    });

    socket.on('createGate', (data) => {
        const roomId = 'GATE-' + Math.random().toString(36).substr(2, 4).toUpperCase();
        rooms[roomId] = {
            id: roomId,
            name: data.name,
            players: [],
            world: {},
            gates: [],
            turn: 0,
            started: false
        };
        socket.emit('waitingRoomUpdate', rooms[roomId]);
    });

    socket.on('joinGate', (data) => {
        const room = rooms[data.gateID];
        if (room) {
            socket.join(data.gateID);
            if (!room.players.find(p => p.name === data.user)) {
                room.players.push({
                    id: socket.id,
                    name: data.user,
                    mana: hunters[data.user]?.mana || 10,
                    alive: true,
                    x: 0, y: 0, color: 'var(--sys-blue)'
                });
            }
            io.to(data.gateID).emit('waitingRoomUpdate', room);
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected');
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`System Online on Port ${PORT}`);
});
