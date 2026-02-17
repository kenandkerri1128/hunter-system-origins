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
let connectedDevices = {}; // NEW: Track unique devices
let adminSocketId = null;

// CONSTANTS
const ADMIN_NAME = "Kei"; 
const AI_NAMES = ["Ken Ayag", "Elton Bosch", "Jordan Comighod", "Jermaine Etcuban"];
const PLAYER_COLORS = ['#00d2ff', '#ff3e3e', '#bcff00', '#ff00ff']; 

// COLOR SCHEME
const RANK_COLORS = { 
    'E': '#00ff00', 'D': '#99ff00', 'C': '#ffff00', 'B': '#ff9900', 'A': '#ff00ff', 'S': '#ff0000', 'Silver': '#ffffff' 
};

const POWER_UPS = ['DOUBLE DAMAGE', 'AIR WALK', 'SOUL SWAP', 'RULERS POWER'];
const CORNERS = [{x:0,y:0}, {x:14,y:0}, {x:0,y:14}, {x:14,y:14}];

// --- DATABASE HELPERS ---
async function dbUpdateHunter(username, points, isWin) {
    try {
        const { data: u } = await supabase.from('Hunters').select('hunterpoints, wins, losses').eq('username', username).maybeSingle();
        if(u) {
            const updates = { hunterpoints: Math.max(0, u.hunterpoints + points) };
            if(isWin === true) updates.wins = (u.wins || 0) + 1;
            else if(isWin === false) updates.losses = (u.losses || 0) + 1;
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

function getMoveRange(mana) {
    if (mana >= 901) return 6;
    if (mana >= 701) return 5;
    if (mana >= 501) return 4;
    if (mana >= 301) return 3;
    if (mana >= 101) return 2;
    return 1;
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
    
    // --- ONE GAME PER DEVICE (Using Unique Device ID from Client) ---
    const deviceId = socket.handshake.query.deviceId;

    if (deviceId) {
        if (connectedDevices[deviceId]) {
            // Device is already connected -> Block this new connection
            socket.emit('authError', "SYSTEM: DEVICE ALREADY CONNECTED IN ANOTHER TAB.");
            socket.disconnect(true);
            return;
        }
        // Register this device ID
        connectedDevices[deviceId] = socket.id;
    }
    // ----------------------------------------------------------------

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

    // 2. AUTHENTICATION
    socket.on('authRequest', async (data) => {
        if (connectedUsers[data.u]) {
            const old = io.sockets.sockets.get(connectedUsers[data.u]);
            if (old && old.connected) return socket.emit('authError', "ALREADY LOGGED IN.");
        }
        
        if (data.type === 'signup') {
            const { data: existing } = await supabase.from('Hunters').select('username').eq('username', data.u).maybeSingle();
            if(existing) return socket.emit('authError', "USERNAME TAKEN.");
            const { error } = await supabase.from('Hunters').insert([{ username: data.u, password: data.p, hunterpoints: 0 }]);
            if (error) return socket.emit('authError', "CREATION FAILED.");
        }

        const { data: user } = await supabase.from('Hunters').select('*').eq('username', data.u).eq('password', data.p).maybeSingle();
        if (user) {
            connectedUsers[user.username] = socket.id;
            if(user.username === ADMIN_NAME) adminSocketId = socket.id;

            let reconnected = false;
            const existingRoom = Object.values(rooms).find(r => r.players.some(p => p.name === user.username));
            if(existingRoom) {
                const p = existingRoom.players.find(p => p.name === user.username);
                p.id = socket.id; 
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

    socket.on('joinChatRoom', (rid) => { 
        socket.rooms.forEach(r => { if(r !== socket.id) socket.leave(r); });
        if(rid) socket.join(rid);
    });
    
    socket.on('sendMessage', (data) => {
        const payload = { sender: data.senderName, text: data.message, rank: data.rank, timestamp: new Date().toLocaleTimeString(), isAdmin: (data.senderName === ADMIN_NAME) };
        if(!data.roomId || data.roomId === 'global') io.emit('receiveMessage', payload);
        else io.to(data.roomId).emit('receiveMessage', payload);
    });

    socket.on('requestGateList', syncAllGates);
    socket.on('requestWorldRankings', broadcastWorldRankings);

    socket.on('createGate', async (data) => {
        const id = `gate_${Date.now()}`;
        const wr = await getWorldRankDisplay(data.host);
        const mana = Math.floor(Math.random() * 251) + 50;
        
        rooms[id] = {
            id, name: data.name, isOnline: true, active: false, processing: false,
            turn: 0, currentRoundMoves: 0, round: 1, spawnCounter: 0, 
            survivorTurns: 0, respawnHappened: false, currentBattle: null,
            players: [{ 
                id: socket.id, name: data.host, slot: 0, ...CORNERS[0], 
                mana, rankLabel: getFullRankLabel(mana), worldRankLabel: wr.label, 
                alive: true, confirmed: false, color: PLAYER_COLORS[0], isAI: false, quit: false, powerUp: null,
                isAdmin: (data.host === ADMIN_NAME), turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0
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
                isAdmin: (data.user === ADMIN_NAME), turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0
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
            turn: 0, currentRoundMoves: 0, round: 1, spawnCounter: 0, 
            survivorTurns: 0, respawnHappened: false, currentBattle: null,
            players: [
                { id: socket.id, name: data.user, slot: 0, ...CORNERS[0], mana, rankLabel: getFullRankLabel(mana), alive: true, isAI: false, color: PLAYER_COLORS[0], quit: false, powerUp: null, isAdmin: (data.user === ADMIN_NAME), turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0 },
                { id: 'ai1', name: AI_NAMES[1], slot: 1, ...CORNERS[1], mana: 200, rankLabel: "Lower D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[1], quit: false, powerUp: null, turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0 },
                { id: 'ai2', name: AI_NAMES[2], slot: 2, ...CORNERS[2], mana: 233, rankLabel: "Higher D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[2], quit: false, powerUp: null, turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0 },
                { id: 'ai3', name: AI_NAMES[3], slot: 3, ...CORNERS[3], mana: 200, rankLabel: "Lower D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[3], quit: false, powerUp: null, turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0 }
            ],
            world: {}
        };
        socket.join(id);
        startGame(rooms[id]);
    });

    // 5. IN-GAME ACTIONS
    socket.on('activateSkill', (data) => {
        const r = Object.values(rooms).find(rm => rm.players.some(p => p.id === socket.id));
        if(r && r.processing) {
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
        if(!r || !r.active || r.processing) return; 
        
        const p = r.players[r.turn];
        if(!p || p.id !== socket.id) return;

        const dx = Math.abs(data.tx - p.x);
        const dy = Math.abs(data.ty - p.y);
        
        if (dx === 0 && dy === 0) return; 

        if (dx > 0 && dy > 0) {
            if (dx !== 1 || dy !== 1) return;
        } else {
            const dist = dx + dy;
            if (dist > getMoveRange(p.mana)) return;
        }

        processMove(r, p, data.tx, data.ty);
    });

    socket.on('quitGame', () => handleDisconnect(socket, true));
    
    // --- HANDLE DISCONNECT & CLEANUP DEVICE ID ---
    socket.on('disconnect', () => {
        if (deviceId && connectedDevices[deviceId] === socket.id) {
            delete connectedDevices[deviceId];
        }
        handleDisconnect(socket, false);
    });
});

function startGame(room) {
    room.active = true;
    for(let i=0; i<5; i++) spawnGate(room);
    io.to(room.id).emit('gameStart', { roomId: room.id });
    io.to(room.id).emit('playMusic', 'gameplay.mp3');
    broadcastGameState(room);
}

function processMove(room, player, tx, ty) {
    room.processing = true;
    player.x = tx;
    player.y = ty;

    const enemy = room.players.find(other => other.id !== player.id && other.alive && other.x === tx && other.y === ty);
    const gateKey = `${tx}-${ty}`;
    const gate = room.world[gateKey];

    if (enemy || gate) {
        room.currentBattle = { attacker: player.id, defender: enemy ? enemy.id : 'gate' };
        broadcastGameState(room); 

        io.to(room.id).emit('battleStart', {
            hunter: player.name, hunterColor: player.color, hunterMana: player.mana,
            target: enemy ? enemy.name : (gate.rank === 'Silver' ? "SILVER MONARCH" : `RANK ${gate.rank}`),
            targetColor: enemy ? enemy.color : gate.color, targetRank: `MP: ${enemy ? enemy.mana : gate.mana}`
        });

        setTimeout(() => {
            resolveBattle(room, player, enemy || gate, !!gate);
        }, 5000);
    } else {
        finishTurn(room);
    }
}

function resolveBattle(room, attacker, defender, isGate) {
    if(!room.active) return;
    room.currentBattle = null;
    
    // --- RESET STUN COUNTERS ON BATTLE ---
    attacker.turnsWithoutBattle = 0;
    if(!isGate) {
        // PvP Battle
        attacker.turnsWithoutPvP = 0;
        defender.turnsWithoutBattle = 0;
        defender.turnsWithoutPvP = 0;
    }

    // --- SOUL SWAP LOGIC ---
    let battleAttacker = attacker;
    let battleDefender = defender;
    let swapper = null;

    if (attacker.activeBuff === 'SOUL SWAP') swapper = attacker;
    else if (!isGate && defender.activeBuff === 'SOUL SWAP') swapper = defender;

    if (swapper) {
        const victims = room.players.filter(p => p.alive && !p.quit && p.id !== attacker.id && p.id !== defender.id);
        if (victims.length > 0) {
            const victim = victims[Math.floor(Math.random() * victims.length)];
            io.to(room.id).emit('announcement', `${swapper.name} used SOUL SWAP! Swapping with ${victim.name}!`);
            if (swapper.id === attacker.id) battleAttacker = victim;
            else battleDefender = victim;
            swapper.activeBuff = null;
        } else {
            io.to(room.id).emit('announcement', `${swapper.name}'s SOUL SWAP failed! No targets.`);
            swapper = null; 
            attacker.activeBuff = null; 
            if(!isGate) defender.activeBuff = null;
        }
    }

    let attMana = battleAttacker.mana;
    let defMana = battleDefender.mana;
    let cancel = false;
    let autoWin = false;

    if (battleAttacker.activeBuff === 'DOUBLE DAMAGE') attMana *= 2;
    if (battleAttacker.activeBuff === 'RULERS POWER' && (!isGate || battleDefender.rank !== 'Silver')) autoWin = true;
    if (battleAttacker.activeBuff === 'AIR WALK') { cancel = true; teleport(battleAttacker); }
    
    if(!isGate) {
        if(battleDefender.activeBuff === 'DOUBLE DAMAGE') defMana *= 2;
        if(battleDefender.activeBuff === 'RULERS POWER') defMana = 99999999;
        if(battleDefender.activeBuff === 'AIR WALK') { cancel = true; teleport(battleDefender); }
    }
    
    if(battleAttacker.id !== (swapper?.id)) battleAttacker.activeBuff = null;
    if(!isGate && battleDefender.id !== (swapper?.id)) battleDefender.activeBuff = null;

    let loser = null;

    if(!cancel) {
        if(autoWin || attMana >= defMana) {
            battleAttacker.mana += battleDefender.mana;
            if(isGate) {
                delete room.world[`${attacker.x}-${attacker.y}`];
                if(battleDefender.rank === 'Silver') return handleWin(room, battleAttacker.name);
                if(!battleAttacker.powerUp && Math.random() < 0.2) {
                    battleAttacker.powerUp = POWER_UPS[Math.floor(Math.random() * POWER_UPS.length)];
                    io.to(battleAttacker.id).emit('announcement', `OBTAINED RUNE: ${battleAttacker.powerUp}`);
                }
            } else {
                battleDefender.alive = false;
                loser = battleDefender;
            }
        } else {
            if(!isGate) battleDefender.mana += battleAttacker.mana;
            battleAttacker.alive = false;
            loser = battleAttacker;
        }
    }

    if (swapper && loser) {
        io.to(room.id).emit('announcement', `${swapper.name} reaps MP and positions from ${loser.name}!`);
        swapper.mana += loser.mana; 
        swapper.x = loser.x;        
        swapper.y = loser.y;
    }

    io.to(room.id).emit('battleEnd');
    checkSilverMonarchCondition(room);
    finishTurn(room);
}

function checkSilverMonarchCondition(room) {
    if (!room.active) return;
    const aliveTotal = room.players.filter(p => p.alive); 
    if (aliveTotal.length === 1) {
        const silverGate = Object.values(room.world).find(g => g.rank === 'Silver');
        if(!silverGate) {
            let sx, sy;
            do { sx=rInt(15); sy=rInt(15); } while(room.players.some(p=>p.x===sx && p.y===sy) || room.world[`${sx}-${sy}`]);
            const smMana = Math.floor(Math.random() * (17000 - 1500 + 1)) + 1500;
            room.world[`${sx}-${sy}`] = { rank: 'Silver', color: '#fff', mana: smMana };
            io.to(room.id).emit('announcement', `THE MONARCH HAS DESCENDED! DEFEAT IT IN 4 TURNS!`);
            room.survivorTurns = 0;
        }
    } 
}

function finishTurn(room) {
    if(!room.active) return;
    room.processing = false; 
    const justPlayed = room.players[room.turn];
    
    // --- STUNNED MECHANICS (UPDATED) ---
    if(justPlayed && justPlayed.alive) {
        justPlayed.turnsWithoutBattle++;
        justPlayed.turnsWithoutPvP++;

        // 1. General Stun (No Battle in 5 turns) -> Stun for 1 turn
        if (justPlayed.turnsWithoutBattle >= 5 && !justPlayed.isStunned) {
            justPlayed.isStunned = true;
            justPlayed.stunDuration = 1;
            io.to(room.id).emit('announcement', `${justPlayed.name} is EXHAUSTED (No Battle)! STUNNED for 1 Turn!`);
        }
        // 2. PvP Stun (No PvP in 10 turns) -> Stun for 2 turns
        else if (justPlayed.turnsWithoutPvP >= 10 && !justPlayed.isStunned) {
            justPlayed.isStunned = true;
            justPlayed.stunDuration = 2;
            io.to(room.id).emit('announcement', `${justPlayed.name} is COWARDLY (No PvP)! STUNNED for 2 Turns!`);
        }
    }

    room.currentRoundMoves++;
    const activeList = room.players.filter(p => p.alive);
    if (room.currentRoundMoves >= activeList.length) {
        room.currentRoundMoves = 0;
        room.round++;
        if (room.round % 3 === 0) {
            room.spawnCounter++;
            for(let i=0; i<(3 + rInt(3)); i++) spawnGate(room);
        }
    }

    const silverGate = Object.values(room.world).find(g => g.rank === 'Silver');
    const alive = room.players.filter(p => p.alive);
    if (silverGate && alive.length === 1) {
        room.survivorTurns++;
        if (room.survivorTurns >= 5) { triggerRespawn(room, alive[0].id); return; }
    }

    let attempts = 0;
    let validNext = false;
    do {
        room.turn = (room.turn + 1) % room.players.length;
        const nextP = room.players[room.turn];
        if (nextP.alive && !nextP.quit) {
            if (nextP.isStunned) {
                 nextP.stunDuration--;
                 if (nextP.stunDuration <= 0) {
                     nextP.isStunned = false; 
                     nextP.turnsWithoutBattle = 0;
                     nextP.turnsWithoutPvP = 0; 
                     io.to(room.id).emit('announcement', `${nextP.name} recovers from STUN.`);
                 } else {
                     io.to(room.id).emit('announcement', `${nextP.name} is still STUNNED (${nextP.stunDuration} turns left).`);
                 }
            } else {
                 validNext = true;
            }
        }
        attempts++;
    } while(!validNext && attempts < 10);

    if (room.players.filter(p => p.alive && !p.quit).length === 0) { triggerRespawn(room, null); return; }
    broadcastGameState(room);
    const nextP = room.players[room.turn];
    if(nextP.alive && nextP.isAI) setTimeout(() => runAIMove(room, nextP), 1000);
}

function handleWin(room, winnerName) {
    io.to(room.id).emit('victoryEvent', { winner: winnerName });
    room.active = false;
    
    // WINNER
    dbUpdateHunter(winnerName, room.isOnline ? 20 : 5, true);
    
    // LOSERS (Game Loss = -1 Penalty)
    room.players.forEach(p => { 
        if(p.name !== winnerName && !p.quit && !p.isAI) {
            dbUpdateHunter(p.name, -1, false); 
        }
    });

    broadcastWorldRankings();
    setTimeout(() => { io.to(room.id).emit('returnToProfile'); delete rooms[room.id]; syncAllGates(); }, 6000);
}

function handleDisconnect(socket, isQuit) {
    const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
    if(room) {
        if (!room.active) {
            const index = room.players.findIndex(pl => pl.id === socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                if (room.players.length === 0) delete rooms[room.id];
                else io.to(room.id).emit('waitingRoomUpdate', room);
            }
            syncAllGates();
            const u = Object.keys(connectedUsers).find(key => connectedUsers[key] === socket.id);
            if(u) delete connectedUsers[u];
            return;
        }

        const p = room.players.find(pl => pl.id === socket.id);
        if(isQuit) {
            p.quit = true; p.alive = false; 
            // QUIT = GAME LOSS = -1 Penalty
            dbUpdateHunter(p.name, -1, false);
            
            socket.leave(room.id);
            socket.emit('returnToProfile'); 
            const activeHumans = room.players.filter(pl => !pl.quit && !pl.isAI);
            if(room.isOnline && activeHumans.length === 1) { handleWin(room, activeHumans[0].name); return; }
            if(!room.isOnline) { delete rooms[room.id]; syncAllGates(); return; }
            if(p === room.players[room.turn]) finishTurn(room);
        }
        if(room.players.filter(pl => !pl.quit && !pl.isAI).length === 0) delete rooms[room.id]; 
        syncAllGates();
    }
    const u = Object.keys(connectedUsers).find(key => connectedUsers[key] === socket.id);
    if(u) delete connectedUsers[u];
}

function triggerRespawn(room, survivorId) {
    io.to(room.id).emit('announcement', "SYSTEM: TIME LIMIT EXCEEDED / HERO FALLEN. REAWAKENING PROTOCOL...");
    room.respawnHappened = true;
    room.world = {}; 
    room.survivorTurns = 0;
    room.currentBattle = null;
    room.processing = false;
    
    room.players.forEach(p => {
        if(!p.quit) {
            p.alive = true;
            p.turnsWithoutBattle = 0;
            p.turnsWithoutPvP = 0;
            p.isStunned = false;
            p.stunDuration = 0;
            teleport(p);
            if (!survivorId || p.id !== survivorId) {
                 p.mana += Math.floor(Math.random() * 1001) + 500;
            }
        }
    });
    
    for(let i=0; i<5; i++) spawnGate(room);
    finishTurn(room);
}

function spawnGate(room) {
    let sx, sy;
    do { sx=rInt(15); sy=rInt(15); } while(room.players.some(p=>p.x===sx && p.y===sy) || room.world[`${sx}-${sy}`]);
    let tiers = room.respawnHappened ? ['S', 'A'] : (room.spawnCounter <= 3 ? ['E', 'D'] : (room.spawnCounter <= 5 ? ['E', 'D', 'C', 'B'] : ['A', 'B', 'C', 'D', 'E']));
    const rank = tiers[rInt(tiers.length)];
    const range = { 'E':[10,100], 'D':[101,200], 'C':[201,400], 'B':[401,600], 'A':[601,900], 'S':[901,1500] }[rank];
    room.world[`${sx}-${sy}`] = { rank, color: RANK_COLORS[rank], mana: rInt(range[1]-range[0]) + range[0] };
}

function runAIMove(room, ai) {
    if(!room.active) return;
    
    let target = null;
    let minDist = 999;
    const range = getMoveRange(ai.mana);

    // 1. MONARCH PRIORITY
    const alivePlayers = room.players.filter(p => p.alive);
    if(alivePlayers.length === 1 && alivePlayers[0].id === ai.id) {
        const silverKey = Object.keys(room.world).find(k => room.world[k].rank === 'Silver');
        if(silverKey) {
             const [sx, sy] = silverKey.split('-').map(Number);
             target = {x: sx, y: sy};
        }
    }

    // 2. KILLABLE PLAYER PRIORITY
    if(!target) {
        const killable = room.players.filter(p => p.id !== ai.id && p.alive && ai.mana >= p.mana);
        if(killable.length > 0) {
             for(const k of killable) {
                 const dist = Math.abs(ai.x - k.x) + Math.abs(ai.y - k.y);
                 if(dist < minDist) { minDist = dist; target = {x: k.x, y: k.y}; }
             }
        }
    }

    // 3. FARM GATE PRIORITY
    if (!target) {
        minDist = 999;
        for(const key in room.world) {
            const [gx, gy] = key.split('-').map(Number);
            const dist = Math.abs(ai.x - gx) + Math.abs(ai.y - gy);
            if(ai.mana >= room.world[key].mana && dist < minDist) { minDist = dist; target = {x:gx, y:gy}; }
        }
    }

    let tx = ai.x, ty = ai.y;
    if(target) {
        const dx = target.x - ai.x; const dy = target.y - ai.y;
        if (Math.abs(dx) > 0 && Math.abs(dy) > 0) { tx += (dx > 0 ? 1 : -1); ty += (dy > 0 ? 1 : -1); }
        else {
            let rem = range;
            if(dx !== 0) { let mx = (dx > 0) ? Math.min(dx, rem) : Math.max(dx, -rem); tx += mx; rem -= Math.abs(mx); }
            if(dy !== 0 && rem > 0) { let my = (dy > 0) ? Math.min(dy, rem) : Math.max(dy, -rem); ty += my; }
        }
    }
    tx = Math.max(0, Math.min(14, tx)); ty = Math.max(0, Math.min(14, ty));
    processMove(room, ai, tx, ty);
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
            socket.emit('gameStateUpdate', { ...room, players: sanitized, currentBattle: room.currentBattle }); 
        }
    });
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SYSTEM: ONLINE ON PORT ${PORT}`));
