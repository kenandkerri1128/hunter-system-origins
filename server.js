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
const POWER_UPS = ['DOUBLE DAMAGE', 'GHOST WALK', 'NETHER SWAP', "GOD'S STRENGTH"];
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

function getStepLimit(mana) {
    if (mana >= 901) return 6; 
    if (mana >= 701) return 5; 
    if (mana >= 501) return 4; 
    if (mana >= 301) return 3; 
    if (mana >= 101) return 2; 
    return 1; 
}

// --- DATABASE & AUTH ---
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
        socket.emit('authSuccess', { 
            username: user.username, mana: user.hunterpoints, rank: getFullRankLabel(user.hunterpoints), color: RANK_COLORS[getDisplayRank(user.hunterpoints).split(' ')[1]],
            wins: user.wins || 0, losses: user.losses || 0, worldRank: (count || 0) + 1, isAdmin: (user.username === ADMIN_NAME)
        });
    }
}

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
    let gain = 0;
    if (room.isOnline) gain = 20; 
    else if (room.mode === 'Monarch') gain = 5; 

    if (u && gain > 0) {
        await supabase.from('Hunters').update({ hunterpoints: u.hunterpoints + gain, wins: (u.wins || 0) + 1 }).eq('username', winnerName);
    }
    
    io.to(room.id).emit('victoryEvent', { winner: winnerName, points: gain });
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

// --- GATE SYNC ---
function syncAllGates() {
    const list = Object.values(rooms)
        .filter(r => r.isOnline && !r.active && r.players && r.players.length > 0)
        .map(r => ({ id: r.id, name: r.name, count: r.players.length }));
    io.emit('updateGateList', list);
}

// --- GAME LOGIC ---
function broadcastGameState(room) { 
    if (!room) return;
    
    // CUSTOM BROADCAST: Hide Enemy MP (Fog of War)
    room.players.forEach(targetPlayer => {
        const socketId = targetPlayer.id;
        
        // Map players specifically for THIS target socket
        const securePlayers = room.players.map(p => {
            const isMe = (p.id === socketId);
            return {
                ...p,
                // If it's me, show Mana. If enemy, show "Rank X"
                mana: isMe ? p.mana : getDisplayRank(p.mana), 
                rankLabel: getFullRankLabel(p.mana), 
                displayRank: getDisplayRank(p.mana),
                stepLimit: getStepLimit(p.mana),
                // Only show my own powerup
                powerUp: isMe ? p.powerUp : null 
            };
        });

        io.to(socketId).emit('gameStateUpdate', { ...room, players: securePlayers });
    });
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

async function resolveConflict(room, p) {
    const coord = `${p.x}-${p.y}`;
    const opponent = room.players.find(o => o.id !== p.id && o.alive && o.x === p.x && o.y === p.y);
    
    // --- PVP COMBAT ---
    if (opponent) {
        // Show battle screen with delayed result
        io.to(room.id).emit('battleStart', { 
            hunter: p.name, hunterColor: p.color, 
            target: opponent.name, targetRank: getDisplayRank(opponent.mana), targetColor: opponent.color 
        });
        
        await new Promise(r => setTimeout(r, 6000));
        if(!rooms[room.id]) return; // Safety check

        // POWER UP CHECKS
        const pPower = p.activePowerUp;
        const oPower = opponent.activePowerUp;
        p.activePowerUp = null; // Consume
        opponent.activePowerUp = null; // Consume

        // 1. GOD'S STRENGTH (Instant Win & Steal)
        if (pPower === "GOD'S STRENGTH") {
            p.mana += opponent.mana;
            opponent.alive = false;
            io.to(room.id).emit('announcement', `${p.name} USED GOD'S STRENGTH!`);
            if (!opponent.isAI && room.isOnline) await recordLoss(opponent.name, p.mana);
        }
        else if (oPower === "GOD'S STRENGTH") {
             opponent.mana += p.mana;
             p.alive = false;
             io.to(room.id).emit('announcement', `${opponent.name} USED GOD'S STRENGTH!`);
             if (!p.isAI && room.isOnline) await recordLoss(p.name, opponent.mana);
        }
        // 2. STANDARD BATTLE
        else {
            if (p.mana >= opponent.mana) { 
                p.mana += opponent.mana; 
                opponent.alive = false; 
                if (!opponent.isAI && room.isOnline) await recordLoss(opponent.name, p.mana); 
            } else { 
                opponent.mana += p.mana; 
                p.alive = false; 
                if (!p.isAI && room.isOnline) await recordLoss(p.name, opponent.mana); 
            }
        }
        
        // Check Wipe
        if (room.players.every(pl => !pl.alive)) triggerRespawn(room);
        io.to(room.id).emit('battleEnd');
        return;
    }

    // --- GATE COMBAT ---
    if (room.world[coord]) {
        const gate = room.world[coord];
        io.to(room.id).emit('battleStart', { 
            hunter: p.name, hunterColor: p.color, 
            target: `RANK ${gate.rank}`, targetRank: `MP: ${gate.mana}`, targetColor: gate.color 
        });
        
        await new Promise(r => setTimeout(r, 6000));
        if(!rooms[room.id]) return;

        // God's Strength FAILS against gates (as requested)
        if (p.activePowerUp === "GOD'S STRENGTH") {
             io.to(room.id).emit('announcement', `${p.name}'S GOD STRENGTH FAILED AGAINST THE GATE!`);
             p.activePowerUp = null;
        }

        if (p.mana >= gate.mana) {
            p.mana += gate.mana; 
            delete room.world[coord];
            
            // GATE REWARD: 20% Chance for Power Up
            if (Math.random() < 0.2) {
                const item = POWER_UPS[Math.floor(Math.random() * POWER_UPS.length)];
                p.powerUp = item;
                io.to(room.id).emit('announcement', `${p.name} OBTAINED RUNE: ${item}`);
            }

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
    
    // FREEZE FIX: Check if anyone is actually alive
    const aliveHunters = room.players.filter(p => p.alive);
    if (aliveHunters.length === 0) return; 

    room.globalTurns++;
    // Spawn gates periodically
    if (room.globalTurns % (room.players.length * 3) === 0) for(let i=0; i<3; i++) spawnGate(room);
    
    // Silver Gate Logic
    if (aliveHunters.length === 1 && !Object.values(room.world).some(g => g.rank === 'Silver')) {
        let sx = Math.floor(Math.random() * 15), sy = Math.floor(Math.random() * 15);
        room.world[`${sx}-${sy}`] = { rank: 'Silver', color: '#ffffff', mana: Math.floor(Math.random() * 15501) + 1500 };
        io.to(room.id).emit('announcement', "A SILVER MONARCH GATE HAS OPENED.");
    }

    // Find next turn
    let attempts = 0;
    do { 
        room.turn = (room.turn + 1) % room.players.length; 
        attempts++; 
    } while (!room.players[room.turn].alive && attempts < 20); // Safety break
    
    const nextP = room.players[room.turn];

    // AI Logic
    if (nextP.isAI && nextP.alive) {
        setTimeout(async () => {
            if (!rooms[room.id] || !room.active) return;
            try {
                // AI Movement logic (simplified for stability)
                let tx = nextP.x, ty = nextP.y;
                let moved = false;
                
                // AI simply moves randomly to neighbors for stability
                const moveOpts = [{x:0,y:1}, {x:0,y:-1}, {x:1,y:0}, {x:-1,y:0}];
                const choice = moveOpts[Math.floor(Math.random() * moveOpts.length)];
                
                tx = Math.max(0, Math.min(14, tx + choice.x));
                ty = Math.max(0, Math.min(14, ty + choice.y));
                
                nextP.x = tx; nextP.y = ty;
                await resolveConflict(room, nextP);
                advanceTurn(room);
            } catch (error) {
                console.error("AI Error:", error);
                advanceTurn(room);
            }
        }, 800);
    } else {
        broadcastGameState(room);
    }
}

async function handleExit(socket) {
    const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
    
    // Clean up global user tracking
    const username = Object.keys(connectedUsers).find(key => connectedUsers[key] === socket.id);
    if(username) delete connectedUsers[username];

    if (room) {
        // Remove player from data
        const wasActive = room.active;
        const p = room.players.find(pl => pl.id === socket.id);
        
        if (!wasActive) {
             // LOBBY/WAITING: Full removal
             room.players = room.players.filter(pl => pl.id !== socket.id);
             socket.leave(room.id);
             
             if (room.players.length === 0) delete rooms[room.id];
             else io.to(room.id).emit('waitingRoomUpdate', room);
             
             syncAllGates(); 
             return;
        }

        // IN GAME: Mark quit
        if (p) {
            p.quit = true; p.alive = false;
            socket.leave(room.id);
            socket.emit('returnToProfile'); // Go back to menu
            
            if (room.isOnline) {
                await recordLoss(p.name, 0, true);
                const active = room.players.filter(pl => !pl.quit && !pl.isAI);
                
                // If only 1 human left, they win
                if (active.length === 1 && room.active) {
                    await processWin(room, active[0].name);
                }
                // If 0 humans left, delete room
                if (active.length === 0) {
                     delete rooms[room.id];
                }
            } else {
                delete rooms[room.id]; // Delete solo room
            }
        }
        broadcastGameState(room);
        syncAllGates();
    }
}

// --- SOCKETS ---
io.on('connection', (socket) => {
    socket.on('requestGateList', () => syncAllGates());
    socket.on('requestWorldRankings', () => broadcastWorldRankings());

    socket.on('adminAction', async (data) => {
        if (socket.id !== adminSocketId) return;
        if (data.action === 'kick') {
            const tId = connectedUsers[data.target];
            if (tId) {
                const s = io.sockets.sockets.get(tId);
                if (s) { s.emit('authError', "KICKED"); handleExit(s); s.disconnect(); }
            }
        }
        if (data.action === 'broadcast') io.emit('receiveMessage', { sender: 'ADMIN', text: data.message, rank: 'GM', isAdmin: true });
        if (data.action === 'spectate') {
            const r = Object.values(rooms).find(rm => rm.players.some(p => p.name === data.targetName));
            if (r) { socket.join(r.id); socket.emit('gameStart', {roomId:r.id}); broadcastGameState(r); }
        }
    });

    socket.on('authRequest', async (data) => {
        if (data.type === 'signup') {
             const { data: ex } = await supabase.from('Hunters').select('username').eq('username', data.u).maybeSingle();
             if (ex) return socket.emit('authError', "USERNAME TAKEN");
             const { error } = await supabase.from('Hunters').insert([{ username: data.u, password: data.p, hunterpoints: 0 }]);
             socket.emit('authError', error ? "ERROR" : "SUCCESS");
        } else {
             // Refresh/Login Logic
             if (connectedUsers[data.u] && connectedUsers[data.u] !== socket.id) {
                 // Check if old socket is actually dead
                 const oldS = io.sockets.sockets.get(connectedUsers[data.u]);
                 if (oldS && oldS.connected) {
                     return socket.emit('authError', "ALREADY LOGGED IN");
                 }
             }
             
             const { data: user } = await supabase.from('Hunters').select('*').eq('username', data.u).eq('password', data.p).maybeSingle();
             if (user) {
                 connectedUsers[user.username] = socket.id;
                 if (user.username === ADMIN_NAME) adminSocketId = socket.id;
                 sendProfileUpdate(socket, user.username);
                 syncAllGates();
                 broadcastWorldRankings();
             } else socket.emit('authError', "INVALID");
        }
    });

    socket.on('activatePowerUp', (data) => {
        const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
        if (room && room.active) {
            const p = room.players.find(pl => pl.id === socket.id);
            if (p && p.alive && p.powerUp === data.type) {
                p.activePowerUp = data.type; // Stage it for next battle
                p.powerUp = null; // Remove from inventory
                io.to(room.id).emit('announcement', `${p.name} IS PREPARING ${data.type}...`);
            }
        }
    });

    socket.on('joinChatRoom', (rid) => { socket.leaveAll(); socket.join(rid); });
    socket.on('sendMessage', (d) => {
        const msg = { sender: d.senderName, text: d.message, timestamp: new Date().toLocaleTimeString(), isAdmin: d.senderName === ADMIN_NAME };
        if(!d.roomId || d.roomId==='global') io.emit('receiveMessage', msg);
        else io.to(d.roomId).emit('receiveMessage', msg);
    });

    socket.on('createGate', async (d) => {
        const id = `g_${Date.now()}`;
        const wr = await getWorldRankDisplay(d.host);
        rooms[id] = { id, name: d.name, isOnline: true, active: false, turn: 0, globalTurns: 0, players: [{id:socket.id, name:d.host, x:0, y:0, mana:150, worldsRankLabel:wr.label, confirmed:false, color:PLAYER_COLORS[0], alive:true, powerUp:null, isAdmin:d.host===ADMIN_NAME}], world:{} };
        socket.join(id);
        io.to(id).emit('waitingRoomUpdate', rooms[id]);
        syncAllGates();
    });

    socket.on('joinGate', async (d) => {
        const r = rooms[d.gateID];
        if (r && r.players.length < 4) {
            const wr = await getWorldRankDisplay(d.user);
            r.players.push({id:socket.id, name:d.user, x:0, y:0, mana:150, worldsRankLabel:wr.label, confirmed:false, color:PLAYER_COLORS[r.players.length], alive:true, powerUp:null, isAdmin:d.user===ADMIN_NAME});
            socket.join(d.gateID);
            io.to(d.gateID).emit('waitingRoomUpdate', r);
            syncAllGates();
        }
    });

    socket.on('playerConfirm', (d) => {
        const r = rooms[d.gateID];
        if(r) {
            const p = r.players.find(pl => pl.id === socket.id);
            if(p) p.confirmed = true;
            if(r.players.length >= 2 && r.players.every(pl=>pl.confirmed)) {
                r.active = true;
                for(let i=0; i<5; i++) spawnGate(r);
                io.to(r.id).emit('gameStart', {roomId:r.id});
                advanceTurn(r);
                syncAllGates(); // Remove from lobby list
            } else io.to(r.id).emit('waitingRoomUpdate', r);
        }
    });

    socket.on('startSoloAI', (d) => {
        const id = `s_${socket.id}`;
        rooms[id] = { id, active:true, turn:0, mode:d.mode, globalTurns:0, isOnline:false, players:[
            {id:socket.id, name:d.user, x:0, y:0, mana:150, alive:true, color:PLAYER_COLORS[0], powerUp:null, isAdmin:d.user===ADMIN_NAME},
            {id:'ai1', name:AI_NAMES[1], x:14, y:0, mana:200, alive:true, isAI:true, color:PLAYER_COLORS[1]},
            {id:'ai2', name:AI_NAMES[2], x:0, y:14, mana:200, alive:true, isAI:true, color:PLAYER_COLORS[2]},
            {id:'ai3', name:AI_NAMES[3], x:14, y:14, mana:200, alive:true, isAI:true, color:PLAYER_COLORS[3]}
        ], world:{} };
        for(let i=0; i<5; i++) spawnGate(rooms[id]);
        socket.join(id);
        socket.emit('gameStart', {roomId:id});
        advanceTurn(rooms[id]);
    });

    socket.on('playerAction', async (d) => {
        const r = Object.values(rooms).find(rm => rm.players.some(p => p.id === socket.id));
        if(!r || !r.active) return;
        const p = r.players[r.turn];
        if(!p || p.id !== socket.id) return;
        
        const dist = Math.abs(p.x - d.tx) + Math.abs(p.y - d.ty);
        if(dist <= getStepLimit(p.mana)) {
            p.x = d.tx; p.y = d.ty;
            await resolveConflict(r, p);
            advanceTurn(r);
        }
    });

    socket.on('quitGame', () => handleExit(socket));
    socket.on('disconnect', () => handleExit(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SYSTEM: Server active on ${PORT}`));
