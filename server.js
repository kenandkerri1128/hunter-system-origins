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
let recentAdminMessages = [];

// CONFIGURATION
const ADMIN_NAME = "Kei"; 
const AI_NAMES = ["Sung Jinwoo", "Cha Hae-In", "Baek Yoonho", "Choi Jong-In"];
const PLAYER_COLORS = ['#00d2ff', '#ff3e3e', '#bcff00', '#ff00ff']; 
const RANK_COLORS = { 'E': '#00ff00', 'D': '#99ff00', 'C': '#ffff00', 'B': '#ff9900', 'A': '#ff00ff', 'S': '#ff0000', 'Silver': '#ffffff' };
const POWER_UPS = ['DOUBLE DAMAGE', 'GHOST WALK', 'NETHER SWAP'];
const corners = [{x:0,y:0}, {x:14,y:0}, {x:0,y:14}, {x:14,y:14}];

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

function getStepLimit(mana) {
    if (mana >= 901) return 6; // S Rank
    if (mana >= 701) return 5; // A Rank
    if (mana >= 501) return 4; // B Rank
    if (mana >= 301) return 3; // C Rank
    if (mana >= 101) return 2; // D Rank
    return 1; // E Rank
}

async function getWorldRankDisplay(username) {
    const { data } = await supabase.from('Hunters').select('username, hunterpoints').order('hunterpoints', { ascending: false });
    if (!data) return { label: '#??', color: '#888' };
    const index = data.findIndex(u => u.username === username);
    if (index === -1) return { label: '#??', color: '#888' };
    const rank = index + 1;
    let color = (rank <= 3) ? '#ffcc00' : ((rank <= 10) ? '#ff003c' : '#fff'); 
    return { label: `#${rank}`, color: color };
}

async function broadcastWorldRankings() {
    const { data } = await supabase.from('Hunters').select('username, hunterpoints, wins, losses').order('hunterpoints', { ascending: false }).limit(100);
    if (data) {
        const formatted = data.map(r => ({ ...r, rankLabel: getFullRankLabel(r.hunterpoints), isAdmin: r.username === ADMIN_NAME }));
        io.emit('updateWorldRankings', formatted);
    }
}

async function sendProfileUpdate(socket, username) {
    const { data: user } = await supabase.from('Hunters').select('*').eq('username', username).maybeSingle();
    if (user && socket) {
        const { count } = await supabase.from('Hunters').select('*', { count: 'exact', head: true }).gt('hunterpoints', user.hunterpoints);
        const letter = getSimpleRank(user.hunterpoints);
        socket.emit('authSuccess', { 
            username: user.username, mana: user.hunterpoints, rank: getFullRankLabel(user.hunterpoints), color: RANK_COLORS[letter],
            wins: user.wins || 0, losses: user.losses || 0, worldRank: (count || 0) + 1, isAdmin: (user.username === ADMIN_NAME)
        });
    }
}

// --- GAME LOGIC HELPERS ---
async function recordLoss(username, winnerInGameMana, quitPenalty = false) {
    const { data: u } = await supabase.from('Hunters').select('hunterpoints, losses').eq('username', username).maybeSingle();
    if (u) {
        let deduction = 20; 
        if (!quitPenalty) {
            const mpStr = winnerInGameMana.toString();
            deduction = (winnerInGameMana >= 10000) ? parseInt(mpStr.substring(0, 2)) : parseInt(mpStr.substring(0, 1));
        }
        await supabase.from('Hunters').update({ hunterpoints: Math.max(0, u.hunterpoints - Math.max(1, deduction)), losses: (u.losses || 0) + 1 }).eq('username', username);
    }
}

async function processWin(room, winnerName) {
    const { data: u } = await supabase.from('Hunters').select('hunterpoints, wins').eq('username', winnerName).maybeSingle();
    if (u && room.isOnline) await supabase.from('Hunters').update({ hunterpoints: u.hunterpoints + 20, wins: (u.wins || 0) + 1 }).eq('username', winnerName);
    
    io.to(room.id).emit('victoryEvent', { winner: winnerName });
    room.active = false;
    broadcastWorldRankings();
    
    const winnerPlayer = room.players.find(p => p.name === winnerName);
    if(winnerPlayer) {
        const socket = io.sockets.sockets.get(winnerPlayer.id);
        if(socket) sendProfileUpdate(socket, winnerName);
    }

    setTimeout(() => { 
        if (rooms[room.id]) {
            io.to(room.id).emit('returnToProfile'); 
            delete rooms[room.id];
            syncAllGates();
        }
    }, 6000); 
}

function syncAllGates() {
    // Only list rooms that have players
    const list = Object.values(rooms).filter(r => r.isOnline && !r.active && r.players.length > 0).map(r => ({ id: r.id, name: r.name, count: r.players.length }));
    io.emit('updateGateList', list);
}

function broadcastGameState(room) { 
    if (!room) return;
    const sanitizedPlayers = room.players.map(p => ({
        ...p, // Restores isAdmin and other properties for the Crown
        rankLabel: getFullRankLabel(p.mana), 
        displayRank: getDisplayRank(p.mana),
        stepLimit: getStepLimit(p.mana) // Send step limit to client
    }));
    io.to(room.id).emit('gameStateUpdate', { ...room, players: sanitizedPlayers });
}

function spawnGate(room) {
    let x, y, tries = 0;
    do { x = Math.floor(Math.random() * 15); y = Math.floor(Math.random() * 15); tries++; } 
    while ((room.players.some(p => p.alive && p.x === x && p.y === y) || room.world[`${x}-${y}`]) && tries < 100);
    
    const cycle = Math.floor(room.globalTurns / room.players.length);
    let pool = (cycle >= 6) ? ['B', 'A', 'S'] : (cycle >= 3 ? ['C', 'B'] : ['E', 'D']);
    const rank = pool[Math.floor(Math.random() * pool.length)];
    const manaMap = { 'E': [0, 100], 'D': [101, 300], 'C': [301, 500], 'B': [501, 700], 'A': [701, 900], 'S': [901, 1200] };
    const range = manaMap[rank];
    room.world[`${x}-${y}`] = { rank, color: RANK_COLORS[rank], mana: Math.floor(Math.random() * (range[1] - range[0] + 1)) + range[0] };
}

function triggerRespawn(room) {
    io.to(room.id).emit('announcement', "SYSTEM: EMERGENCY RESPAWN INITIATED.");
    room.world = {};
    room.globalTurns = 0;
    room.players.forEach(p => {
        if (!p.quit) {
            p.alive = true;
            p.mana += 500;
        }
    });
    for(let i=0; i<5; i++) spawnGate(room);
    broadcastGameState(room);
}

// --- BATTLE ENGINE ---
async function resolveConflict(room, p) {
    const coord = `${p.x}-${p.y}`;
    const opponent = room.players.find(o => o.id !== p.id && o.alive && o.x === p.x && o.y === p.y);
    
    if (opponent) {
        io.to(room.id).emit('battleStart', { hunter: p.name, hunterColor: p.color, target: opponent.name, targetRank: `MP: ${opponent.mana}`, targetColor: opponent.color });
        await new Promise(r => setTimeout(r, 6000));
        if(!rooms[room.id]) return;

        if (p.mana >= opponent.mana) { p.mana += opponent.mana; opponent.alive = false; if (!opponent.isAI && room.isOnline) await recordLoss(opponent.name, p.mana); }
        else { opponent.mana += p.mana; p.alive = false; if (!p.isAI && room.isOnline) await recordLoss(p.name, opponent.mana); }
        
        // Check for Respawn if all died in PvP/Solo
        if (room.players.every(pl => !pl.alive)) triggerRespawn(room);
        
        io.to(room.id).emit('battleEnd');
        return;
    }

    if (room.world[coord]) {
        const gate = room.world[coord];
        io.to(room.id).emit('battleStart', { hunter: p.name, hunterColor: p.color, target: `RANK ${gate.rank}`, targetRank: `MP: ${gate.mana}`, targetColor: gate.color });
        await new Promise(r => setTimeout(r, 6000));
        if(!rooms[room.id]) return;

        if (p.mana >= gate.mana) {
            p.mana += gate.mana; delete room.world[coord];
            if (gate.rank === 'Silver') return await processWin(room, p.name);
        } else {
            p.alive = false; 
            if (!p.isAI && room.isOnline) await recordLoss(p.name, gate.mana);
            
            const aliveHunters = room.players.filter(pl => pl.alive);
            if (aliveHunters.length === 0) triggerRespawn(room);
        }
        io.to(room.id).emit('battleEnd');
    }
}

function advanceTurn(room) {
    if (!rooms[room.id] || !room.active) return;
    
    room.globalTurns++;
    if (room.globalTurns % (room.players.length * 3) === 0) for(let i=0; i<3; i++) spawnGate(room);
    
    const aliveHunters = room.players.filter(p => p.alive);
    
    // Spawn Silver Gate (1,500 - 17,000 MP)
    if (aliveHunters.length === 1 && !Object.values(room.world).some(g => g.rank === 'Silver')) {
        let sx = Math.floor(Math.random() * 15), sy = Math.floor(Math.random() * 15);
        room.world[`${sx}-${sy}`] = { rank: 'Silver', color: '#ffffff', mana: Math.floor(Math.random() * 15501) + 1500 };
        io.to(room.id).emit('announcement', "A SILVER MONARCH GATE HAS OPENED.");
    }

    let attempts = 0;
    do { room.turn = (room.turn + 1) % room.players.length; attempts++; } 
    while (!room.players[room.turn].alive && attempts < 10);
    
    const nextP = room.players[room.turn];

    if (nextP.isAI && nextP.alive) {
        setTimeout(async () => {
            if (!rooms[room.id]) return;
            let tx = nextP.x, ty = nextP.y;
            // AI Movement Logic
            const steps = getStepLimit(nextP.mana);
            
            if (room.mode === 'Monarch') {
                let targets = [];
                Object.keys(room.world).forEach(c => targets.push({x: parseInt(c.split('-')[0]), y: parseInt(c.split('-')[1])}));
                room.players.forEach(pl => { if(pl.alive && pl.id !== nextP.id) targets.push({x: pl.x, y: pl.y}); });
                targets.sort((a,b) => (Math.abs(nextP.x-a.x)+Math.abs(nextP.y-a.y)) - (Math.abs(nextP.x-b.x)+Math.abs(nextP.y-b.y)));
                
                if(targets[0]) {
                   // Calculate direction towards target
                   let dx = targets[0].x - nextP.x;
                   let dy = targets[0].y - nextP.y;
                   
                   // AI takes multiple steps if allowed
                   for(let s=0; s<steps; s++) {
                       if(Math.abs(dx) > Math.abs(dy)) {
                           if(dx > 0) tx++; else tx--;
                       } else {
                           if(dy > 0) ty++; else ty--;
                       }
                       // Simple check to not go out of bounds mid-step
                       tx = Math.max(0, Math.min(14, tx));
                       ty = Math.max(0, Math.min(14, ty));
                       // Re-calc delta
                       dx = targets[0].x - tx;
                       dy = targets[0].y - ty;
                   }
                }
            } else { 
                // Random walk logic adjusted for steps
                 for(let s=0; s<steps; s++) {
                    tx += (Math.random()>0.5?1:-1); 
                    ty += (Math.random()>0.5?1:-1); 
                 }
            }
            nextP.x = Math.max(0, Math.min(14, tx)); nextP.y = Math.max(0, Math.min(14, ty));
            await resolveConflict(room, nextP);
            advanceTurn(room);
        }, 800);
    }
    broadcastGameState(room);
}

async function handleExit(socket) {
    const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
    if (room) {
        // Remove player from array if still in waiting room
        if (!room.active) {
             room.players = room.players.filter(p => p.id !== socket.id);
             if (room.players.length === 0) {
                 delete rooms[room.id];
             }
             syncAllGates();
             io.to(room.id).emit('waitingRoomUpdate', room);
             return; 
        }

        const p = room.players.find(pl => pl.id === socket.id);
        if (p) {
            p.quit = true; p.alive = false;
            if (room.isOnline) {
                await recordLoss(p.name, 0, true);
                const active = room.players.filter(pl => !pl.quit && !pl.isAI);
                if (active.length === 1 && room.active) await processWin(room, active[0].name);
                // Clean up empty rooms even in active games if everyone leaves
                if (active.length === 0) delete rooms[room.id];
            } else {
                socket.emit('returnToProfile');
                delete rooms[room.id];
            }
        }
        broadcastGameState(room);
        syncAllGates();
    }
}

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    // RESTORED: Lobby & Global Listeners
    socket.on('requestGateList', () => syncAllGates());
    socket.on('requestWorldRankings', () => broadcastWorldRankings());

    socket.on('adminAction', async (data) => {
        if (socket.id !== adminSocketId) return;
        if (data.action === 'kick') {
            const targetSocketId = connectedUsers[data.target];
            if (targetSocketId) {
                const tSocket = io.sockets.sockets.get(targetSocketId);
                if (tSocket) {
                    tSocket.emit('authError', "FORCED LOGOUT BY ADMIN.");
                    handleExit(tSocket);
                    setTimeout(() => tSocket.disconnect(true), 500);
                }
            }
        }
        if (data.action === 'broadcast') {
            const msg = { sender: 'SYSTEM ADMIN', text: data.message, rank: 'ADMIN', timestamp: new Date().toLocaleTimeString(), isAdmin: true };
            recentAdminMessages.push(msg);
            io.emit('receiveMessage', msg);
        }
        if (data.action === 'spectate') {
            const room = Object.values(rooms).find(r => r.players.some(p => p.name === data.targetName));
            if (room) { 
                socket.join(room.id); 
                socket.emit('gameStart', { roomId: room.id }); 
                broadcastGameState(room); 
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
        } else socket.emit('authError', "INVALID ACCESS.");
    });

    socket.on('joinChatRoom', (roomId) => {
        socket.rooms.forEach(r => { if(r !== socket.id) socket.leave(r); });
        socket.join(roomId);
        socket.emit('joinedRoom', roomId);
        recentAdminMessages.slice(-5).forEach(m => socket.emit('receiveMessage', m));
    });

    socket.on('sendMessage', async (data) => {
        const { data: u } = await supabase.from('Hunters').select('hunterpoints').eq('username', data.senderName).maybeSingle();
        const msg = { sender: data.senderName, text: data.message, rank: getDisplayRank(u?.hunterpoints || 0), timestamp: new Date().toLocaleTimeString(), isAdmin: data.senderName === ADMIN_NAME };
        if (!data.roomId || data.roomId === 'global') io.emit('receiveMessage', msg);
        else io.to(data.roomId).emit('receiveMessage', msg);
    });

    socket.on('createGate', async (data) => {
        const id = `gate_${Date.now()}`;
        const wr = await getWorldRankDisplay(data.host);
        rooms[id] = { id, name: data.name, isOnline: true, active: false, turn: 0, globalTurns: 0, players: [{ id: socket.id, name: data.host, x: 0, y: 0, mana: 150, worldsRankLabel: wr.label, worldsRankColor: wr.color, alive: true, confirmed: false, color: PLAYER_COLORS[0], isAI: false, quit: false, powerUp: null, isAdmin: data.host === ADMIN_NAME }], world: {} };
        socket.join(id);
        io.to(id).emit('waitingRoomUpdate', rooms[id]);
        syncAllGates();
    });

    socket.on('joinGate', async (data) => {
        const room = rooms[data.gateID];
        if (room && room.players.length < 4) {
            const wr = await getWorldRankDisplay(data.user);
            const idx = room.players.length;
            room.players.push({ id: socket.id, name: data.user, x: corners[idx].x, y: corners[idx].y, mana: 150, worldsRankLabel: wr.label, worldsRankColor: wr.color, alive: true, confirmed: false, color: PLAYER_COLORS[idx], isAI: false, quit: false, powerUp: null, isAdmin: data.user === ADMIN_NAME });
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
                room.active = true; for(let i=0; i<5; i++) spawnGate(room);
                io.to(room.id).emit('gameStart', { roomId: room.id });
                advanceTurn(room);
                syncAllGates();
            } else io.to(room.id).emit('waitingRoomUpdate', room);
        }
    });

    socket.on('startSoloAI', async (data) => {
        const id = `solo_${socket.id}_${Date.now()}`;
        rooms[id] = {
            id, active: true, turn: 0, mode: data.diff, globalTurns: 0, isOnline: false,
            players: [
                { id: socket.id, name: data.user, x: 0, y: 0, mana: 150, alive: true, isAI: false, color: PLAYER_COLORS[0], powerUp: null, isAdmin: data.user === ADMIN_NAME },
                { id: 'ai1', name: AI_NAMES[1], x: 14, y: 0, mana: 200, alive: true, isAI: true, color: PLAYER_COLORS[1] },
                { id: 'ai2', name: AI_NAMES[2], x: 0, y: 14, mana: 200, alive: true, isAI: true, color: PLAYER_COLORS[2] },
                { id: 'ai3', name: AI_NAMES[3], x: 14, y: 14, mana: 200, alive: true, isAI: true, color: PLAYER_COLORS[3] }
            ], world: {}
        };
        for(let i=0; i<5; i++) spawnGate(rooms[id]);
        socket.join(id);
        socket.emit('gameStart', { roomId: id });
        advanceTurn(rooms[id]);
    });

    socket.on('playerAction', async (data) => {
        const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
        if (!room || !room.active) return;
        const p = room.players[room.turn];
        if (!p || p.id !== socket.id) return;
        
        // Calculate allowed step distance based on Rank
        const stepLimit = getStepLimit(p.mana);
        const dist = Math.abs(p.x - data.tx) + Math.abs(p.y - data.ty);
        
        // Only move if within rank limit
        if (dist <= stepLimit) {
            p.x = data.tx; p.y = data.ty;
            await resolveConflict(room, p);
            if(rooms[room.id]) advanceTurn(room);
        }
    });

    socket.on('quitGame', () => handleExit(socket));
    socket.on('disconnect', () => handleExit(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SYSTEM: Server active on ${PORT}`));
