const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    pingTimeout: 60000 
});

// --- CRASH PREVENTION ---
process.on('uncaughtException', (err) => console.error('SYSTEM ERROR:', err));
process.on('unhandledRejection', (reason) => console.error('PROMISE ERROR:', reason));

// Supabase Configuration
const SUPABASE_URL = 'https://wfsuxqgvshrhqfvnkzdx.supabase.co'; 
const SUPABASE_KEY = 'sb_publishable_gV-RZMfBZ1dLU60Ht4J9iw_-sRWSKnL'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.static(path.join(__dirname, 'public')));

// GLOBAL STATE
let rooms = {};
let connectedUsers = {}; 
let adminSocketId = null;

// CONSTANTS
const ADMIN_NAME = "Kei"; 
const AI_NAMES = ["Sung Jinwoo", "Cha Hae-In", "Baek Yoonho", "Choi Jong-In"];
const PLAYER_COLORS = ['#00d2ff', '#ff3e3e', '#bcff00', '#ff00ff']; 
const RANK_COLORS = { 'E': '#00ff00', 'D': '#99ff00', 'C': '#ffff00', 'B': '#ff9900', 'A': '#ff00ff', 'S': '#ff0000', 'Silver': '#ffffff' };
const POWER_UPS = ['DOUBLE DAMAGE', 'GHOST WALK', 'NETHER SWAP'];
const CORNERS = [{x:0,y:0}, {x:14,y:0}, {x:0,y:14}, {x:14,y:14}];

// --- DATABASE HELPERS (Non-Blocking) ---
async function dbUpdateHunter(username, points, isWin) {
    try {
        const { data: u } = await supabase.from('Hunters').select('hunterpoints, wins, losses').eq('username', username).maybeSingle();
        if(u) {
            const updates = { hunterpoints: Math.max(0, u.hunterpoints + points) };
            if(isWin) updates.wins = (u.wins || 0) + 1;
            else updates.losses = (u.losses || 0) + 1;
            await supabase.from('Hunters').update(updates).eq('username', username);
        }
    } catch(e) {}
}

// --- RANKING UTILS ---
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
    try {
        const { data } = await supabase.from('Hunters').select('username, hunterpoints').order('hunterpoints', { ascending: false });
        if (!data) return { label: '#??', color: '#888' };
        const index = data.findIndex(u => u.username === username);
        if (index === -1) return { label: '#??', color: '#888' };
        const rank = index + 1;
        let color = '#fff'; 
        if (rank <= 3) color = '#ffcc00'; 
        else if (rank <= 10) color = '#ff003c'; 
        return { label: `#${rank}`, color: color };
    } catch(e) { return { label: '#??', color: '#888' }; }
}

async function broadcastWorldRankings() {
    try {
        const { data } = await supabase.from('Hunters').select('username, hunterpoints, wins, losses').order('hunterpoints', { ascending: false }).limit(100);
        if (data) {
            const list = data.map(r => ({ 
                ...r, 
                rankLabel: getFullRankLabel(r.hunterpoints),
                isAdmin: r.username === ADMIN_NAME 
            }));
            io.emit('updateWorldRankings', list);
        }
    } catch(e) {}
}

function syncAllGates() {
    const list = Object.values(rooms).filter(r => r.isOnline && !r.active).map(r => ({ id: r.id, name: r.name, count: r.players.length }));
    io.emit('updateGateList', list);
}

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    
    // 1. ADMIN ACTIONS
    socket.on('adminAction', (data) => {
        if (socket.id !== adminSocketId) return; 
        if (data.action === 'kick' && connectedUsers[data.target]) {
            const tid = connectedUsers[data.target];
            io.to(tid).emit('authError', "SYSTEM: KICKED BY ADMIN.");
            io.sockets.sockets.get(tid)?.disconnect(true);
            delete connectedUsers[data.target];
        }
        if (data.action === 'broadcast') {
            io.emit('receiveMessage', { sender: 'SYSTEM ADMIN', text: data.message, rank: 'ADMIN', timestamp: new Date().toLocaleTimeString(), isAdmin: true });
        }
    });

    // 2. AUTHENTICATION & RECONNECT
    socket.on('authRequest', async (data) => {
        if (connectedUsers[data.u]) {
            const old = io.sockets.sockets.get(connectedUsers[data.u]);
            if (old && old.connected) return socket.emit('authError', "ALREADY LOGGED IN.");
        }
        
        if (data.type === 'signup') {
            const { error } = await supabase.from('Hunters').insert([{ username: data.u, password: data.p, hunterpoints: 0 }]);
            if (error) return socket.emit('authError', "USERNAME TAKEN.");
        }

        const { data: user } = await supabase.from('Hunters').select('*').eq('username', data.u).eq('password', data.p).maybeSingle();
        if (user) {
            connectedUsers[user.username] = socket.id;
            if(user.username === ADMIN_NAME) adminSocketId = socket.id;

            // Reconnect Logic
            let reconnected = false;
            const existingRoom = Object.values(rooms).find(r => r.players.some(p => p.name === user.username));
            if(existingRoom) {
                const p = existingRoom.players.find(p => p.name === user.username);
                p.id = socket.id; // Update Socket ID
                socket.join(existingRoom.id);
                if(existingRoom.active) {
                    socket.emit('gameStart', { roomId: existingRoom.id });
                    broadcastGameState(existingRoom);
                } else {
                    socket.emit('waitingRoomUpdate', existingRoom);
                }
                reconnected = true;
            }

            const { count } = await supabase.from('Hunters').select('*', { count: 'exact', head: true }).gt('hunterpoints', user.hunterpoints);
            const letter = getSimpleRank(user.hunterpoints);

            socket.emit('authSuccess', { 
                username: user.username, mana: user.hunterpoints, 
                rank: getFullRankLabel(user.hunterpoints), color: RANK_COLORS[letter],
                wins: user.wins||0, losses: user.losses||0, worldRank: (count||0)+1,
                isAdmin: (user.username === ADMIN_NAME), music: reconnected ? null : 'menu.mp3'
            });
            if(!reconnected) { syncAllGates(); broadcastWorldRankings(); }
        } else {
            socket.emit('authError', "INVALID CREDENTIALS.");
        }
    });

    // 3. CHAT
    socket.on('joinChatRoom', (rid) => { 
        socket.rooms.forEach(r => { if(r !== socket.id) socket.leave(r); });
        if(rid) socket.join(rid);
    });
    socket.on('sendMessage', (data) => {
        const payload = { sender: data.senderName, text: data.message, rank: data.rank, timestamp: new Date().toLocaleTimeString(), isAdmin: (data.senderName === ADMIN_NAME) };
        if(!data.roomId || data.roomId === 'global') io.emit('receiveMessage', payload);
        else io.to(data.roomId).emit('receiveMessage', payload);
    });

    // 4. LOBBY & GATE CREATION
    socket.on('requestGateList', syncAllGates);
    socket.on('requestWorldRankings', broadcastWorldRankings);

    socket.on('createGate', async (data) => {
        const id = `gate_${Date.now()}`;
        const wr = await getWorldRankDisplay(data.host);
        const mana = Math.floor(Math.random() * 251) + 50;
        
        rooms[id] = {
            id, name: data.name, isOnline: true, active: false, processing: false,
            turn: 0, globalTurns: 0, survivorTurns: 0, respawnHappened: false,
            players: [{ 
                id: socket.id, name: data.host, slot: 0, ...CORNERS[0], 
                mana, rankLabel: getFullRankLabel(mana), worldRankLabel: wr.label, 
                alive: true, confirmed: false, color: PLAYER_COLORS[0], isAI: false, quit: false, powerUp: null,
                isAdmin: (data.host === ADMIN_NAME)
            }],
            world: {}
        };
        socket.join(id);
        io.to(id).emit('waitingRoomUpdate', rooms[id]);
        socket.emit('playMusic', 'waiting.mp3');
        syncAllGates();
    });

    socket.on('joinGate', async (data) => {
        const r = rooms[data.gateID];
        if(r && r.players.length < 4 && !r.players.some(p => p.name === data.user)) {
            const slot = [0,1,2,3].find(s => !r.players.some(p => p.slot === s));
            const wr = await getWorldRankDisplay(data.user);
            const mana = Math.floor(Math.random() * 251) + 50;
            
            r.players.push({
                id: socket.id, name: data.user, slot, ...CORNERS[slot],
                mana, rankLabel: getFullRankLabel(mana), worldRankLabel: wr.label,
                alive: true, confirmed: false, color: PLAYER_COLORS[slot], isAI: false, quit: false, powerUp: null,
                isAdmin: (data.user === ADMIN_NAME)
            });
            socket.join(data.gateID);
            io.to(data.gateID).emit('waitingRoomUpdate', r);
            socket.emit('playMusic', 'waiting.mp3');
            syncAllGates();
        }
    });

    socket.on('playerConfirm', (data) => {
        const r = rooms[data.gateID];
        if(r) {
            const p = r.players.find(pl => pl.id === socket.id);
            if(p) p.confirmed = true;
            if(r.players.length >= 2 && r.players.every(pl => pl.confirmed)) {
                startGame(r);
            } else {
                io.to(r.id).emit('waitingRoomUpdate', r);
            }
        }
    });

    socket.on('startSoloAI', (data) => {
        const id = `solo_${socket.id}_${Date.now()}`;
        const mana = Math.floor(Math.random() * 251) + 50;
        
        rooms[id] = {
            id, isOnline: false, active: false, processing: false, mode: data.diff,
            turn: 0, globalTurns: 0, survivorTurns: 0, respawnHappened: false,
            players: [
                { id: socket.id, name: data.user, slot: 0, ...CORNERS[0], mana, rankLabel: getFullRankLabel(mana), alive: true, isAI: false, color: PLAYER_COLORS[0], quit: false, powerUp: null, isAdmin: (data.user === ADMIN_NAME) },
                { id: 'ai1', name: AI_NAMES[1], slot: 1, ...CORNERS[1], mana: 200, rankLabel: "Lower D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[1], quit: false, powerUp: null },
                { id: 'ai2', name: AI_NAMES[2], slot: 2, ...CORNERS[2], mana: 233, rankLabel: "Higher D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[2], quit: false, powerUp: null },
                { id: 'ai3', name: AI_NAMES[3], slot: 3, ...CORNERS[3], mana: 200, rankLabel: "Lower D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[3], quit: false, powerUp: null }
            ],
            world: {}
        };
        socket.join(id);
        startGame(rooms[id]);
    });

    // 5. IN-GAME ACTIONS
    socket.on('activateSkill', (data) => {
        const r = Object.values(rooms).find(rm => rm.players.some(p => p.id === socket.id));
        if(r) {
            const p = r.players.find(pl => pl.id === socket.id);
            if(p && p.powerUp === data.powerUp) {
                p.activeBuff = data.powerUp;
                p.powerUp = null;
                io.to(r.id).emit('announcement', `${p.name} ACTIVATED ${data.powerUp}!`);
            }
        }
    });

    socket.on('playerAction', (data) => {
        const r = Object.values(rooms).find(rm => rm.players.some(p => p.id === socket.id));
        if(!r || !r.active || r.processing) return; // ENGINE LOCK
        
        const p = r.players[r.turn];
        if(!p || p.id !== socket.id) return; // NOT YOUR TURN

        // Valid Move Check (Distance 1)
        const dist = Math.abs(p.x - data.tx) + Math.abs(p.y - data.ty);
        if(dist > 1) return; 

        // EXECUTE MOVE
        processMove(r, p, data.tx, data.ty);
    });

    socket.on('quitGame', () => handleDisconnect(socket, true));
    socket.on('disconnect', () => handleDisconnect(socket, false));
});


// =========================================================
//  THE NEW GAME ENGINE (SILVER MONARCH & POWERUPS ADDED)
// =========================================================

function startGame(room) {
    room.active = true;
    // Spawn initial gates
    for(let i=0; i<5; i++) spawnGate(room);
    io.to(room.id).emit('gameStart', { roomId: room.id });
    io.to(room.id).emit('playMusic', 'gameplay.mp3');
    broadcastGameState(room);
}

function processMove(room, player, tx, ty) {
    room.processing = true; // LOCK INPUT

    // 1. Update Coords
    player.x = tx;
    player.y = ty;

    // 2. Check Collisions
    const enemy = room.players.find(other => other.id !== player.id && other.alive && other.x === tx && other.y === ty);
    const gateKey = `${tx}-${ty}`;
    const gate = room.world[gateKey];

    if (enemy) {
        // --- PVP BATTLE ---
        io.to(room.id).emit('battleStart', {
            hunter: player.name, hunterColor: player.color, hunterMana: player.mana,
            target: enemy.name, targetColor: enemy.color, targetRank: `MP: ${enemy.mana}`
        });
        
        // 5s Delay for Drama
        setTimeout(() => {
            resolveBattle(room, player, enemy, false);
        }, 5000);

    } else if (gate) {
        // --- PVE BATTLE ---
        const isMonarch = (gate.rank === 'Silver');
        io.to(room.id).emit('battleStart', {
            hunter: player.name, hunterColor: player.color, hunterMana: player.mana,
            target: isMonarch ? "SILVER MONARCH" : `RANK ${gate.rank}`, 
            targetColor: gate.color, targetRank: `MP: ${gate.mana}`
        });

        // 5s Delay
        setTimeout(() => {
            resolveBattle(room, player, gate, true);
        }, 5000);

    } else {
        // --- NO CONFLICT ---
        finishTurn(room);
    }
}

function resolveBattle(room, attacker, defender, isGate) {
    if(!room.active) return; // Safety check

    let attMana = attacker.mana;
    let defMana = defender.mana;
    let cancel = false;

    // 1. APPLY POWERUPS
    if(attacker.activeBuff === 'DOUBLE DAMAGE') attMana *= 2;
    if(attacker.activeBuff === 'GHOST WALK') {
        cancel = true;
        teleport(attacker);
        io.to(room.id).emit('announcement', `${attacker.name} USED GHOST WALK!`);
    }
    if(attacker.activeBuff === 'NETHER SWAP') {
        // Find a random living player to swap with (not the defender)
        const others = room.players.filter(p => p.id !== attacker.id && p.id !== defender.id && p.alive);
        if(others.length > 0) {
            cancel = true;
            const target = others[Math.floor(Math.random() * others.length)];
            // Swap Coords
            const tx = attacker.x; const ty = attacker.y;
            attacker.x = target.x; attacker.y = target.y;
            target.x = tx; target.y = ty;
            io.to(room.id).emit('announcement', `${attacker.name} SWAPPED WITH ${target.name}!`);
        } else {
            // Fallback if no one to swap with (Solo/Final), act as Ghost Walk
            cancel = true;
            teleport(attacker);
            io.to(room.id).emit('announcement', `${attacker.name} NETHER SWAP (SOLO) -> TELEPORT!`);
        }
    }
    
    // Defender Powerups (Only if Player)
    if(!isGate && defender.activeBuff === 'DOUBLE DAMAGE') defMana *= 2;

    attacker.activeBuff = null; 
    if(!isGate) defender.activeBuff = null;

    // 2. COMBAT RESOLUTION
    if(!cancel) {
        if(attMana >= defMana) {
            // ATTACKER WINS
            attacker.mana += defender.mana;
            if(isGate) {
                delete room.world[`${attacker.x}-${attacker.y}`];
                if(defender.rank === 'Silver') {
                     // VICTORY CONDITION
                     return handleWin(room, attacker.name); 
                }
                // Chance for Powerup (20%)
                if(!attacker.powerUp && Math.random() < 0.2) {
                    attacker.powerUp = POWER_UPS[Math.floor(Math.random() * POWER_UPS.length)];
                    io.to(attacker.id).emit('announcement', `OBTAINED RUNE: ${attacker.powerUp}`);
                }
            } else {
                defender.alive = false;
                if(room.isOnline && !defender.isAI) dbUpdateHunter(defender.name, -5, false);
            }
        } else {
            // DEFENDER WINS
            if(!isGate) defender.mana += attacker.mana;
            attacker.alive = false;
            if(room.isOnline && !attacker.isAI) dbUpdateHunter(attacker.name, -5, false);
        }
    }

    io.to(room.id).emit('battleEnd');

    // 3. CHECK LAST MAN STANDING / SILVER MONARCH SPAWN
    const aliveHumans = room.players.filter(p => p.alive && !p.isAI);
    const aliveTotal = room.players.filter(p => p.alive);

    if (aliveTotal.length === 1 && aliveHumans.length === 1) {
        // Only one player left? SPAWN SILVER MONARCH
        const silverGate = Object.values(room.world).find(g => g.rank === 'Silver');
        if(!silverGate) {
            let sx, sy;
            // Find empty spot
            do { sx=rInt(15); sy=rInt(15); } while(room.players.some(p=>p.x===sx && p.y===sy) || room.world[`${sx}-${sy}`]);
            
            // Random Stats 1500 - 17000
            const smMana = Math.floor(Math.random() * (17000 - 1500 + 1)) + 1500;
            room.world[`${sx}-${sy}`] = { rank: 'Silver', color: '#fff', mana: smMana };
            
            io.to(room.id).emit('announcement', `SYSTEM: THE SILVER MONARCH [MP:${smMana}] HAS DESCENDED! DEFEAT IT IN 5 TURNS!`);
            room.survivorTurns = 0;
        }
    } else if (aliveHumans.length === 0 && room.isOnline) {
        // Everyone died - If Silver Monarch existed, logic handles respawn in finishTurn or here?
        // Actually if 0 humans left, room should close or respawn if they died to Monarch.
        // Let's rely on finishTurn to catch the respawn trigger if needed, or close room.
        // If they died to Monarch, triggerRespawn is needed.
        const sm = Object.values(room.world).find(g => g.rank === 'Silver');
        if(sm) {
            triggerRespawn(room, null); // Null ID = generic respawn
            return;
        }
    }

    finishTurn(room);
}

function finishTurn(room) {
    if(!room.active) return;
    room.processing = false; // UNLOCK
    room.globalTurns++;

    // Spawn Gates Periodically
    if(room.globalTurns % 5 === 0) {
        spawnGate(room);
        broadcastGameState(room);
    }

    // SURVIVOR / SILVER MONARCH TIMER
    const silverGate = Object.values(room.world).find(g => g.rank === 'Silver');
    const alive = room.players.filter(p => p.alive);
    
    if (silverGate && alive.length === 1) {
        room.survivorTurns++;
        if (room.survivorTurns >= 5) {
            triggerRespawn(room, alive[0].id);
            return;
        }
    }

    // Next Turn Loop
    let attempts = 0;
    do {
        room.turn = (room.turn + 1) % room.players.length;
        attempts++;
    } while(!room.players[room.turn].alive && attempts < 5);

    // If loop failed (everyone dead), trigger respawn
    if (!room.players[room.turn].alive) {
        triggerRespawn(room, null);
        return;
    }

    broadcastGameState(room);

    // AI MOVE
    const nextP = room.players[room.turn];
    if(nextP.alive && nextP.isAI) {
        setTimeout(() => runAIMove(room, nextP), 1000);
    }
}

function runAIMove(room, ai) {
    if(!room.active) return;

    // Simple AI: Target nearest Gate < My Mana
    let target = null;
    let minDist = 999;
    
    // Scan Gates
    for(const key in room.world) {
        const [gx, gy] = key.split('-').map(Number);
        const g = room.world[key];
        const dist = Math.abs(ai.x - gx) + Math.abs(ai.y - gy);
        if(ai.mana >= g.mana && dist < minDist) { minDist = dist; target = {x:gx, y:gy}; }
    }

    // Scan Players (Monarch Mode)
    if(room.mode === 'Monarch') {
        room.players.forEach(p => {
            if(p.id !== ai.id && p.alive && ai.mana > p.mana) {
                const dist = Math.abs(ai.x - p.x) + Math.abs(ai.y - p.y);
                if(dist < minDist) { minDist = dist; target = {x:p.x, y:p.y}; }
            }
        });
    }

    // Move Logic
    let tx = ai.x, ty = ai.y;
    if(target) {
        if(target.x > ai.x) tx++; else if(target.x < ai.x) tx--;
        else if(target.y > ai.y) ty++; else if(target.y < ai.y) ty--;
    } else {
        // Random Move
        if(Math.random()>0.5) tx += (Math.random()>0.5 ? 1 : -1);
        else ty += (Math.random()>0.5 ? 1 : -1);
    }

    // Clamp
    tx = Math.max(0, Math.min(14, tx));
    ty = Math.max(0, Math.min(14, ty));

    processMove(room, ai, tx, ty);
}

function handleWin(room, winnerName) {
    io.to(room.id).emit('victoryEvent', { winner: winnerName });
    room.active = false;
    
    // UPDATED HUP CALCULATIONS
    // Online Win: +20, Solo/AI Win: +5
    const points = room.isOnline ? 20 : 5;
    dbUpdateHunter(winnerName, points, true);

    broadcastWorldRankings();

    setTimeout(() => {
        io.to(room.id).emit('returnToProfile');
        delete rooms[room.id];
        syncAllGates();
    }, 6000);
}

function handleDisconnect(socket, isQuit) {
    const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
    if(room) {
        const p = room.players.find(pl => pl.id === socket.id);
        if(isQuit) {
            p.quit = true; p.alive = false;
            if(room.isOnline) dbUpdateHunter(p.name, -20, false); // QUIT PENALTY
            io.to(room.id).emit('announcement', `${p.name} HAS QUIT.`);
            if(p === room.players[room.turn]) finishTurn(room);
        }
        
        // Clean empty rooms
        const humans = room.players.filter(pl => !pl.isAI && !pl.quit);
        if(humans.length === 0) delete rooms[room.id];
        
        syncAllGates();
    }
    const u = Object.keys(connectedUsers).find(key => connectedUsers[key] === socket.id);
    if(u) delete connectedUsers[u];
}

function triggerRespawn(room, survivorId) {
    io.to(room.id).emit('announcement', "SYSTEM: TIME LIMIT EXCEEDED / HERO FALLEN. REAWAKENING PROTOCOL...");
    room.respawnHappened = true;
    room.world = {}; // Clear Gates (Despawns Monarch)
    room.survivorTurns = 0;
    
    room.players.forEach(p => {
        if(!p.quit) {
            p.alive = true;
            if(p.id !== survivorId) p.mana += 500; // Catchup mechanic
        }
    });
    
    // Respawn standard gates
    for(let i=0; i<5; i++) spawnGate(room);
    
    finishTurn(room);
}

function spawnGate(room) {
    let sx, sy, safe=0;
    do { sx=rInt(15); sy=rInt(15); safe++; } while((room.players.some(p=>p.x===sx && p.y===sy) || room.world[`${sx}-${sy}`]) && safe<50);
    if(safe>=50) return;

    // Standard Gate Logic (No Silver Monarch here)
    const tiers = room.respawnHappened ? ['A','S'] : ['E','D','C','B'];
    const rank = tiers[rInt(tiers.length)];
    const range = { 'E':[10,100], 'D':[101,200], 'C':[201,400], 'B':[401,600], 'A':[601,900], 'S':[901,1500] }[rank];
    const mana = rInt(range[1]-range[0]) + range[0];
    
    room.world[`${sx}-${sy}`] = { rank, color: RANK_COLORS[rank], mana };
}

function teleport(p) { p.x = rInt(15); p.y = rInt(15); }
function rInt(max) { return Math.floor(Math.random() * max); }

function broadcastGameState(room) {
    room.players.forEach(p => {
        const socket = io.sockets.sockets.get(p.id);
        if(socket) {
            const sanitized = room.players.map(pl => ({
                ...pl,
                mana: (pl.id===p.id || pl.isAdmin) ? pl.mana : null,
                powerUp: (pl.id===p.id || pl.isAdmin) ? pl.powerUp : null,
                displayRank: getDisplayRank(pl.mana)
            }));
            socket.emit('gameStateUpdate', { ...room, players: sanitized });
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SYSTEM: ONLINE ON PORT ${PORT}`));
