const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};

// --- RANKING HELPERS ---
// Based on instructions: 0-50 Lower E, 51-100 Higher E, 101-200 Lower D, etc.
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

// Simplified version for the Board
function getShortRankLabel(mana) {
    const detailed = getDetailedRank(mana);
    return detailed.replace("-Rank", "");
}

// --- CORE FUNCTIONS ---

function spawnGate(room) {
    // Logic to spawn gates on the board
    const id = Math.random().toString(36).substr(2, 9);
    const isSilver = room.players.filter(p => p.alive).length === 1;
    
    const gate = {
        id: id,
        type: isSilver ? 'silver' : 'normal',
        power: isSilver ? Math.floor(Math.random() * 501) + 500 : Math.floor(Math.random() * 300),
        x: Math.floor(Math.random() * 10),
        y: Math.floor(Math.random() * 10)
    };
    room.gates.push(gate);
}

function triggerRespawn(room, lastPlayerId) {
    const candidates = room.players.filter(p => !p.quit);
    if (candidates.length === 0) { delete rooms[room.id]; return; }
    
    room.respawnHappened = true; 

    candidates.forEach(pl => { 
        if (pl.id !== lastPlayerId) {
            const resurrectionBonus = Math.floor(Math.random() * 1001) + 500;
            pl.mana += resurrectionBonus; 
        }
        pl.alive = true;
    });
    
    room.gates = []; // Clear gates including the Silver Gate
    room.globalTurns = 0;
    room.survivorTurns = 0; 
    const lastPlayerIdx = room.players.findIndex(pl => pl.id === lastPlayerId);
    room.turn = lastPlayerIdx;

    for(let i=0; i<5; i++) spawnGate(room);
    io.to(room.id).emit('announcement', `SYSTEM: QUEST FAILED. ALL HUNTERS REAWAKENED.`);
    broadcastGameState(room);
}

function broadcastGameState(room) { 
    const sanitizedPlayers = room.players.map(p => {
        const shortRank = getShortRankLabel(p.mana);
        return {
            ...p,
            rankLabel: shortRank,
            displayName: `${p.name} [${shortRank}]` 
        };
    });
    
    const state = { ...room, players: sanitizedPlayers };
    io.to(room.id).emit('gameStateUpdate', state); 
}

// --- SOCKET LOGIC WITH CHAT ---

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    // Chat Message Handler
    socket.on('sendMessage', (data) => {
        // data should contain { roomId, message, senderName }
        const rank = rooms[data.roomId] 
            ? getShortRankLabel(rooms[data.roomId].players.find(p => p.id === socket.id)?.mana || 0)
            : "Unknown";

        const chatPayload = {
            sender: data.senderName,
            text: data.message,
            rank: rank,
            time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };

        if (data.roomId) {
            io.to(data.roomId).emit('receiveMessage', chatPayload);
        } else {
            // Global Lobby Chat
            io.emit('receiveGlobalMessage', chatPayload);
        }
    });

    socket.on('joinRoom', (data) => {
        const { roomId, playerName } = data;
        socket.join(roomId);

        if (!rooms[roomId]) {
            rooms[roomId] = { id: roomId, players: [], gates: [], turn: 0, started: false };
        }

        const newPlayer = {
            id: socket.id,
            name: playerName,
            mana: 10, // Starting mana
            alive: true,
            quit: false,
            x: 0,
            y: 0
        };

        rooms[roomId].players.push(newPlayer);
        broadcastGameState(rooms[roomId]);
    });

    socket.on('disconnect', () => {
        // Handle cleanup
        console.log('User disconnected');
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
