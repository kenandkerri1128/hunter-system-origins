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

// CONFIGURATION
const ADMIN_NAME = "Kei"; 
const AI_NAMES = ["Sung Jinwoo", "Cha Hae-In", "Baek Yoonho", "Choi Jong-In"];
const PLAYER_COLORS = ['#00d2ff', '#ff3e3e', '#bcff00', '#ff00ff']; 
const RANK_COLORS = { 'E': '#00ff00', 'D': '#99ff00', 'C': '#ffff00', 'B': '#ff9900', 'A': '#ff00ff', 'S': '#ff0000', 'Silver': '#ffffff' };
const POWER_UPS = ['DOUBLE DAMAGE', 'GHOST WALK', 'NETHER SWAP'];
const CORNERS = [{x:0,y:0}, {x:14,y:0}, {x:0,y:14}, {x:14,y:14}];

// --- HELPERS ---
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
        const isAdmin = (user.username === ADMIN_NAME);
        
        socket.emit('authSuccess', { 
            username: user.username, 
            mana: user.hunterpoints, 
            rank: getFullRankLabel(user.hunterpoints), 
            color: RANK_COLORS[letter],
            wins: user.wins || 0,
            losses: user.losses || 0,
            worldRank: exactRank,
            music: 'menu.mp3',
            isAdmin: isAdmin
        });
    }
}

async function recordLoss(username, winnerInGameMana) {
    const { data: u } = await supabase.from('Hunters').select('hunterpoints, losses').eq('username', username).maybeSingle();
    if (u) {
        const lossAmount = (winnerInGameMana === true) ? 20 : 5;
        await supabase.from('Hunters').update({ 
            hunterpoints: Math.max(0, u.hunterpoints - lossAmount), 
            losses: (u.losses || 0) + 1 
        }).eq('username', username);
    }
}

async function processWin(room, winnerName) {
    const { data: u } = await supabase.from('Hunters').select('hunterpoints, wins').eq('username', winnerName).maybeSingle();
    if (u) {
        const hupGain = room.isOnline ? 20 : 5;
        await supabase.from('Hunters').update({ 
            hunterpoints: u.hunterpoints + hupGain, 
            wins: (u.wins || 0) + 1 
        }).eq('username', winnerName);
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
        if(rooms[room.id]) {
            io.to(room.id).emit('returnToProfile'); 
            delete rooms[room.id];
            syncAllGates();
        }
    }, 6000); 
}

function syncAllGates() {
    const list = Object.values(rooms).filter(r => r.isOnline && !r.active).map(r => ({ id: r.id, name: r.name, count: r.players.length }));
    io.emit('updateGateList', list);
}

function isPathBlocked(room, x1, y1, x2, y2) {
    let dx = x2 - x1;
    let dy = y2 - y1;
    let steps = Math.max(Math.abs(dx), Math.abs(dy));
    if (steps <= 1) return false; 
    for (let i = 1; i < steps; i++) {
        let checkX = x1 + Math.round((dx / steps) * i);
        let checkY = y1 + Math.round((dy / steps) * i);
        if (room.world[`${checkX}-${checkY}`]) return true;
    }
    return false;
}

function getAvailableSlot(room) {
    const taken = room.players.map(p => p.slot);
    for(let i=0; i<4; i++) {
        if(!taken.includes(i)) return i;
    }
    return -1; 
}

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    
    socket.on('adminAction', (data) => {
        if (socket.id !== adminSocketId) return; 

        if (data.action === 'kick') {
            const targetSocketId = connectedUsers[data.target];
            if (targetSocketId) {
                const targetSocket = io.sockets.sockets.get(targetSocketId);
                if (targetSocket) {
                    targetSocket.emit('authError', "SYSTEM: FORCED LOGOUT BY ADMINISTRATOR.");
                    targetSocket.disconnect(true);
                    delete connectedUsers[data.target];
                }
            }
        }
        
        if (data.action === 'broadcast') {
            io.emit('receiveMessage', { 
                sender: 'SYSTEM ADMIN', 
                text: data.message, 
                rank: 'ADMIN', 
                timestamp: new Date().toLocaleTimeString(),
                isAdmin: true
            });
        }

        if (data.action === 'spectate') {
            let targetRoomId = data.roomId;
            const targetPlayerRoom = Object.values(rooms).find(r => r.players.some(p => p.name === data.roomId));
            if (targetPlayerRoom) targetRoomId = targetPlayerRoom.id;

            const room = rooms[targetRoomId];
            if (room) {
                socket.join(targetRoomId);
                socket.emit('gameStart', { roomId: targetRoomId });
                broadcastGameState(room);
            }
        }
    });

    socket.on('authRequest', async (data) => {
        if (connectedUsers[data.u]) {
            const oldSocket = io.sockets.sockets.get(connectedUsers[data.u]);
            if (oldSocket && oldSocket.connected) {
                return socket.emit('authError', "HUNTER ALREADY ACTIVE ON ANOTHER TERMINAL.");
            } else { delete connectedUsers[data.u]; }
        }

        const { data: user } = await supabase.from('Hunters').select('*').eq('username', data.u).eq('password', data.p).maybeSingle();
        
        if (user) {
            connectedUsers[user.username] = socket.id; 
            if (user.username === ADMIN_NAME) adminSocketId = socket.id;
            
            const { count } = await supabase.from('Hunters').select('*', { count: 'exact', head: true }).gt('hunterpoints', user.hunterpoints);
            const exactRank = (count || 0) + 1;
            
            socket.emit('authSuccess', { 
                username: user.username, 
                mana: user.hunterpoints, 
                rank: getFullRankLabel(user.hunterpoints), 
                color: RANK_COLORS[getSimpleRank(user.hunterpoints)],
                wins: user.wins || 0,
                losses: user.losses || 0,
                worldRank: exactRank,
                music: 'menu.mp3',
                isAdmin: (user.username === ADMIN_NAME)
            });
            syncAllGates();
            broadcastWorldRankings(); 
        } else {
            socket.emit('authError', "INVALID ACCESS CODE OR ID.");
        }
    });

    socket.on('playerAction', async (data) => {
        const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
        if (!room || !room.active) return;

        const p = room.players[room.turn];
        if (!p || p.id !== socket.id) return;

        if (isPathBlocked(room, p.x, p.y, data.tx, data.ty)) {
            socket.emit('sysLog', "MOVEMENT BLOCKED BY A GATE.");
            return;
        }

        p.x = data.tx; 
        p.y = data.ty;
        
        await resolveConflict(room, p);
        if (rooms[room.id]) advanceTurn(room);
    });

    socket.on('disconnect', async () => { handleExit(socket, true); });
    socket.on('quitGame', async () => { handleExit(socket, true); });

    async function handleExit(s, isExplicitQuit) {
        const username = Object.keys(connectedUsers).find(u => connectedUsers[u] === s.id);
        if (username) delete connectedUsers[username];

        const room = Object.values(rooms).find(r => r.players.some(p => p.id === s.id));
        if (room) {
            s.leave(room.id);
            const p = room.players.find(pl => pl.id === s.id);
            if (room.active && p && !p.quit) {
                p.quit = true; p.alive = false; 
                if(room.isOnline) await recordLoss(p.name, true);
                broadcastGameState(room);
                if (room.players[room.turn].id === s.id) advanceTurn(room);
            } else {
                room.players = room.players.filter(pl => pl.id !== s.id);
                if (room.players.length === 0) delete rooms[room.id];
            }
            syncAllGates();
        }
    }

    socket.on('createGate', async (data) => {
        const id = `gate_${Date.now()}`;
        const wrData = await getWorldRankDisplay(data.host);
        rooms[id] = {
            id, name: data.name, isOnline: true, active: false, turn: 0, globalTurns: 0, survivorTurns: 0,
            players: [{ 
                id: socket.id, name: data.host, slot: 0, x: CORNERS[0].x, y: CORNERS[0].y, 
                mana: 100, alive: true, confirmed: false, color: PLAYER_COLORS[0], isAI: false, quit: false 
            }],
            world: {}
        };
        socket.join(id);
        io.to(id).emit('waitingRoomUpdate', rooms[id]);
        syncAllGates();
    });

    socket.on('joinGate', async (data) => {
        const room = rooms[data.gateID];
        if (room && room.players.length < 4) {
            const slot = getAvailableSlot(room);
            room.players.push({ 
                id: socket.id, name: data.user, slot, x: CORNERS[slot].x, y: CORNERS[slot].y, 
                mana: 100, alive: true, confirmed: false, color: PLAYER_COLORS[slot], isAI: false, quit: false 
            });
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
            if (room.players.length >= 1 && room.players.every(pl => pl.confirmed)) {
                room.active = true;
                for(let i=0; i<5; i++) spawnGate(room);
                io.to(room.id).emit('gameStart', { roomId: room.id });
                broadcastGameState(room);
            } else { io.to(room.id).emit('waitingRoomUpdate', room); }
        }
    });

    socket.on('startSoloAI', async (data) => {
        const id = `solo_${socket.id}_${Date.now()}`;
        rooms[id] = {
            id, active: true, turn: 0, isOnline: false, mode: data.diff, globalTurns: 0, survivorTurns: 0,
            players: [
                { id: socket.id, name: data.user, slot: 0, ...CORNERS[0], mana: 150, alive: true, isAI: false, color: PLAYER_COLORS[0], quit: false },
                { id: 'ai1', name: AI_NAMES[1], slot: 1, ...CORNERS[1], mana: 200, alive: true, isAI: true, color: PLAYER_COLORS[1], quit: false }
            ],
            world: {}
        };
        for(let i=0; i<5; i++) spawnGate(rooms[id]);
        socket.join(id);
        socket.emit('gameStart', { roomId: id });
        broadcastGameState(rooms[id]);
    });

    function broadcastGameState(room) { 
        const roomClients = io.sockets.adapter.rooms.get(room.id);
        if (roomClients) {
            roomClients.forEach(socketId => {
                const sanitizedPlayers = room.players.map(p => ({
                    ...p,
                    rankLabel: getFullRankLabel(p.mana), 
                    displayRank: getDisplayRank(p.mana)
                }));
                io.to(socketId).emit('gameStateUpdate', { ...room, players: sanitizedPlayers });
            });
        }
    }
});

async function resolveConflict(room, p) {
    const coord = `${p.x}-${p.y}`;
    const gate = room.world[coord];
    if (gate) {
        if (p.mana >= gate.mana) {
            p.mana += Math.floor(gate.mana * 0.5);
            delete room.world[coord];
            if (gate.rank === 'Silver') await processWin(room, p.name);
        } else {
            p.alive = false;
        }
    }
}

function spawnGate(room) {
    let x = Math.floor(Math.random() * 15), y = Math.floor(Math.random() * 15);
    room.world[`${x}-${y}`] = { rank: 'E', color: RANK_COLORS['E'], mana: 50 };
}

function advanceTurn(room) {
    if (!rooms[room.id] || !room.active) return;
    
    let nextIndex = (room.turn + 1) % room.players.length;
    let attempts = 0;
    while (!room.players[nextIndex].alive && attempts < room.players.length) {
        nextIndex = (nextIndex + 1) % room.players.length;
        attempts++;
    }
    
    room.turn = nextIndex;
    const nextPlayer = room.players[room.turn];

    if (nextPlayer.isAI && nextPlayer.alive) {
        setTimeout(async () => {
            if (!rooms[room.id]) return;
            nextPlayer.x = Math.max(0, Math.min(14, nextPlayer.x + (Math.random() > 0.5 ? 1 : -1)));
            nextPlayer.y = Math.max(0, Math.min(14, nextPlayer.y + (Math.random() > 0.5 ? 1 : -1)));
            await resolveConflict(room, nextPlayer);
            advanceTurn(room);
        }, 1000);
    } else {
        // ESSENTIAL: Trigger fresh render for the human player
        broadcastGameState(room);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SYSTEM: Server is active on port ${PORT}`));
