const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Supabase Configuration
const SUPABASE_URL = 'https://wfsuxqgvshrhqfvnkzdx.supabase.co'; 
const SUPABASE_KEY = 'sb_publishable_gV-RZMfBZ1dLU60Ht4J9iw_-sRWSKnL'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.static(path.join(__dirname, 'public')));

// TRACKING
let rooms = {};
let connectedUsers = {}; 
let adminSocketId = null;
let recentAdminMessages = []; // Buffer for persistent broadcasts

// CONFIGURATION
const ADMIN_NAME = "Kei"; 
const AI_NAMES = ["Sung Jinwoo", "Cha Hae-In", "Baek Yoonho", "Choi Jong-In"];
const PLAYER_COLORS = ['#00d2ff', '#ff3e3e', '#bcff00', '#ff00ff']; 
const RANK_COLORS = { 'E': '#00ff00', 'D': '#99ff00', 'C': '#ffff00', 'B': '#ff9900', 'A': '#ff00ff', 'S': '#ff0000', 'Silver': '#ffffff' };
const POWER_UPS = ['DOUBLE DAMAGE', 'GHOST WALK', 'NETHER SWAP'];

// --- RANKING HELPERS ---
function getFullRankLabel(val) {
    if (val >= 1000) return "Higher S-Rank";
    if (val >= 901) return "Lower S-Rank";
    if (val >= 801) return "Higher A-Rank";
    if (val >= 701) return "Lower A-Rank";
    if (val >= 601) return "Higher B-Rank";
    if (val >= 501) return "Lower B-Rank";
    if (val >= 401) return "Higher C-Rank";
    if (val >= 301) return "Lower C-Rank";
    if (val >= 201) return "Higher D-Rank";
    if (val >= 101) return "Lower D-Rank";
    if (val >= 51) return "Higher E-Rank";
    return "Lower E-Rank";
}

function getDisplayRank(mana) {
    if (mana >= 901) return "Rank S";
    if (mana >= 701) return "Rank A";
    if (mana >= 501) return "Rank B";
    if (mana >= 301) return "Rank C";
    if (mana >= 101) return "Rank D";
    return "Rank E"; 
}

function getSimpleRank(val) {
    if (val >= 901) return 'S';
    if (val >= 701) return 'A';
    if (val >= 501) return 'B';
    if (val >= 301) return 'C';
    if (val >= 101) return 'D';
    return 'E';
}

async function getWorldRankDisplay(username) {
    const { data } = await supabase.from('Hunters').select('username, hunterpoints').order('hunterpoints', { ascending: false });
    if (!data) return { label: '#??', color: '#888' };
    const index = data.findIndex(u => u.username === username);
    if (index === -1) return { label: '#??', color: '#888' };
    const rank = index + 1;
    let color = '#fff'; 
    if (rank <= 3) color = '#ffcc00'; 
    else if (rank <= 10) color = '#ff003c'; 
    return { label: `#${rank}`, color: color };
}

async function broadcastWorldRankings() {
    const { data } = await supabase.from('Hunters').select('username, hunterpoints, wins, losses').order('hunterpoints', { ascending: false }).limit(100);
    if (data) {
        const formattedRankings = data.map(r => ({ 
            ...r, 
            manapoints: r.hunterpoints, 
            hunterpoints: r.hunterpoints,
            rankLabel: getFullRankLabel(r.hunterpoints),
            isAdmin: r.username === ADMIN_NAME
        }));
        io.emit('updateWorldRankings', formattedRankings);
    }
}

async function sendProfileUpdate(socket, username) {
    const { data: user } = await supabase.from('Hunters').select('*').eq('username', username).maybeSingle();
    const { count } = await supabase.from('Hunters').select('*', { count: 'exact', head: true }).gt('hunterpoints', user ? user.hunterpoints : 0);
    const exactRank = (count || 0) + 1;

    if (user) {
        const letter = getSimpleRank(user.hunterpoints);
        socket.emit('authSuccess', { 
            username: user.username, mana: user.hunterpoints, rank: getFullRankLabel(user.hunterpoints), color: RANK_COLORS[letter],
            wins: user.wins || 0, losses: user.losses || 0, worldRank: exactRank, isAdmin: (user.username === ADMIN_NAME)
        });
    }
}

// --- GAME LOGIC HELPERS ---
async function processWin(room, winnerName) {
    const { data: u } = await supabase.from('Hunters').select('hunterpoints, wins').eq('username', winnerName).maybeSingle();
    if (u) {
        await supabase.from('Hunters').update({ hunterpoints: u.hunterpoints + 20, wins: (u.wins || 0) + 1 }).eq('username', winnerName);
    }
    io.to(room.id).emit('victoryEvent', { winner: winnerName });
    room.active = false;
    broadcastWorldRankings();
    const winnerPlayer = room.players.find(p => p.name === winnerName);
    if(winnerPlayer) {
        const socket = io.sockets.sockets.get(winnerPlayer.id);
        if(socket) sendProfileUpdate(socket, winnerName);
    }
    setTimeout(() => { 
        io.to(room.id).emit('returnToProfile'); 
        if(rooms[room.id]) delete rooms[room.id];
        syncAllGates();
    }, 6000); 
}

function syncAllGates() {
    const list = Object.values(rooms).filter(r => r.isOnline && !r.active).map(r => ({ id: r.id, name: r.name, count: r.players.length }));
    io.emit('updateGateList', list);
}

function broadcastGameState(room) { 
    if (!room) return;
    const roomClients = io.sockets.adapter.rooms.get(room.id);
    if (roomClients) {
        roomClients.forEach(socketId => {
            const isSpectatingAdmin = (socketId === adminSocketId);
            const sanitizedPlayers = room.players.map(p => ({
                ...p,
                mana: (p.id === socketId || isSpectatingAdmin) ? p.mana : null, 
                powerUp: (p.id === socketId || isSpectatingAdmin) ? p.powerUp : null,
                rankLabel: getFullRankLabel(p.mana), 
                displayRank: getDisplayRank(p.mana)
            }));
            io.to(socketId).emit('gameStateUpdate', { ...room, players: sanitizedPlayers });
        });
    }
}

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    
    // Admin Actions
    socket.on('adminAction', async (data) => {
        if (socket.id !== adminSocketId) return; 

        if (data.action === 'kick') {
            const targetName = data.target;
            const targetSocketId = connectedUsers[targetName];
            
            // 1. Process Penalty & Room Exit immediately
            const room = Object.values(rooms).find(r => r.players.some(p => p.name === targetName));
            if (room) {
                const p = room.players.find(pl => pl.name === targetName);
                if (p && !p.quit) {
                    p.quit = true; p.alive = false;
                    // Deduct 20 HuP
                    const { data: u } = await supabase.from('Hunters').select('hunterpoints, losses').eq('username', targetName).maybeSingle();
                    if (u) await supabase.from('Hunters').update({ hunterpoints: Math.max(0, u.hunterpoints - 20), losses: (u.losses || 0) + 1 }).eq('username', targetName);
                    
                    io.to(room.id).emit('announcement', `SYSTEM: ${targetName} WAS FORCIBLY REMOVED BY ADMIN. -20 HuP.`);
                    
                    // Check for immediate win
                    const activeHumans = room.players.filter(pl => !pl.quit && !pl.isAI);
                    if (activeHumans.length === 1 && room.active) {
                        await processWin(room, activeHumans[0].name);
                    } else {
                        broadcastGameState(room);
                    }
                }
            }

            // 2. Disconnect Socket
            if (targetSocketId) {
                const targetSocket = io.sockets.sockets.get(targetSocketId);
                if (targetSocket) {
                    targetSocket.emit('authError', "SYSTEM: FORCED LOGOUT BY ADMINISTRATOR.");
                    // Small delay to ensure they see the message
                    setTimeout(() => targetSocket.disconnect(true), 500);
                }
                socket.emit('sysLog', `KICKED & PENALIZED: ${targetName}`);
            } else {
                socket.emit('sysLog', `USER ${targetName} NOT FOUND.`);
            }
            broadcastWorldRankings();
        }
        
        if (data.action === 'broadcast') {
            const msgObj = { 
                sender: 'SYSTEM ADMIN', text: data.message, rank: 'ADMIN', 
                timestamp: new Date().toLocaleTimeString(), isAdmin: true 
            };
            recentAdminMessages.push(msgObj);
            if(recentAdminMessages.length > 5) recentAdminMessages.shift(); // Keep last 5

            io.emit('receiveMessage', msgObj);
            socket.emit('sysLog', `BROADCAST SENT.`);
        }

        if (data.action === 'spectate') {
            // Find room by player name
            const room = Object.values(rooms).find(r => r.players.some(p => p.name === data.targetName));
            if (room) {
                socket.join(room.id);
                socket.emit('gameStart', { roomId: room.id });
                broadcastGameState(room);
                socket.emit('sysLog', `SPECTATING ${data.targetName} IN ROOM: ${room.name}`);
            } else {
                socket.emit('sysLog', `PLAYER "${data.targetName}" IS NOT IN A GAME.`);
            }
        }
    });

    socket.on('authRequest', async (data) => {
        const { data: user } = await supabase.from('Hunters').select('*').eq('username', data.u).eq('password', data.p).maybeSingle();
        if (user) {
            connectedUsers[user.username] = socket.id; 
            if (user.username === ADMIN_NAME) adminSocketId = socket.id;
            sendProfileUpdate(socket, user.username);
            syncAllGates();
            broadcastWorldRankings(); 
        } else {
            socket.emit('authError', "INVALID ACCESS CODE OR ID.");
        }
    });

    socket.on('joinChatRoom', (roomId) => {
        for (const room of socket.rooms) { if (room !== socket.id) socket.leave(room); }
        if (roomId) { 
            socket.join(roomId); 
            socket.emit('joinedRoom', roomId); 
            // Send recent admin broadcasts to the player in this new room
            recentAdminMessages.forEach(msg => socket.emit('receiveMessage', msg));
        }
    });

    socket.on('sendMessage', async (data) => {
        const { roomId, message, senderName } = data;
        const { data: user } = await supabase.from('Hunters').select('hunterpoints').eq('username', senderName).maybeSingle();
        const rank = user ? getDisplayRank(user.hunterpoints) : "Rank E"; 
        const chatData = { sender: senderName, text: message, rank: rank, timestamp: new Date().toLocaleTimeString(), isAdmin: (senderName === ADMIN_NAME) };
        if (!roomId || roomId === 'global' || roomId === 'null') { io.emit('receiveMessage', chatData); } 
        else { io.to(roomId).emit('receiveMessage', chatData); }
    });

    // ... createGate, joinGate, playerConfirm, startSoloAI logic remains same ...
    const corners = [{x:0,y:0}, {x:14,y:0}, {x:0,y:14}, {x:14,y:14}];
    socket.on('createGate', async (data) => {
        const id = `gate_${Date.now()}`;
        const wrData = await getWorldRankDisplay(data.host);
        rooms[id] = {
            id, name: data.name, isOnline: true, active: false, turn: 0, globalTurns: 0, survivorTurns: 0, respawnHappened: false,
            players: [{ id: socket.id, name: data.host, x: corners[0].x, y: corners[0].y, mana: 100, rankLabel: "Lower E-Rank", worldsRankLabel: wrData.label, worldsRankColor: wrData.color, alive: true, confirmed: false, color: PLAYER_COLORS[0], isAI: false, quit: false, powerUp: null, isAdmin: (data.host === ADMIN_NAME) }],
            world: {}
        };
        socket.join(id);
        io.to(id).emit('waitingRoomUpdate', rooms[id]);
        syncAllGates();
    });

    socket.on('joinGate', async (data) => {
        const room = rooms[data.gateID];
        if (room && room.players.length < 4) {
            const idx = room.players.length;
            const wrData = await getWorldRankDisplay(data.user);
            room.players.push({ id: socket.id, name: data.user, x: corners[idx].x, y: corners[idx].y, mana: 100, rankLabel: "Lower E-Rank", worldsRankLabel: wrData.label, worldsRankColor: wrData.color, alive: true, confirmed: false, color: PLAYER_COLORS[idx], isAI: false, quit: false, powerUp: null, isAdmin: (data.user === ADMIN_NAME) });
            socket.join(data.gateID);
            io.to(data.gateID).emit('waitingRoomUpdate', room);
            syncAllGates();
        }
    });

    socket.on('playerConfirm', (data) => {
        const room = rooms[data.gateID];
        if (room) {
            const p = room.players.find(pl => pl.id === socket.id);
            if(p) p.confirmed = true;
            if (room.players.length >= 2 && room.players.every(pl => pl.confirmed)) {
                room.active = true;
                for(let i=0; i<5; i++) spawnGate(room);
                io.to(room.id).emit('gameStart', { roomId: room.id });
                broadcastGameState(room);
                syncAllGates();
            } else { io.to(room.id).emit('waitingRoomUpdate', room); }
        }
    });

    socket.on('playerAction', async (data) => {
        const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
        if (!room || !room.active) return;
        const p = room.players[room.turn];
        if (!p || p.id !== socket.id) return;
        p.x = data.tx; p.y = data.ty;
        await resolveConflict(room, p);
        if (rooms[room.id]) advanceTurn(room);
    });

    socket.on('disconnect', () => handleExit(socket));
});

// Logic for advanceTurn, resolveConflict, spawnGate remains same as previous working versions
function spawnGate(room) {
    let x = Math.floor(Math.random()*15), y = Math.floor(Math.random()*15);
    room.world[`${x}-${y}`] = { rank: 'E', color: RANK_COLORS['E'], mana: 50 };
}

async function resolveConflict(room, p) {
    const coord = `${p.x}-${p.y}`;
    if (room.world[coord]) {
        p.mana += room.world[coord].mana;
        delete room.world[coord];
    }
}

function advanceTurn(room) {
    room.turn = (room.turn + 1) % room.players.length;
    broadcastGameState(room);
}

async function handleExit(s) {
    const name = Object.keys(connectedUsers).find(k => connectedUsers[k] === s.id);
    if(name) delete connectedUsers[name];
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SYSTEM: Server active on ${PORT}`));
