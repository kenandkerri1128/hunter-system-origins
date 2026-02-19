const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

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

// --- ASSET DIRECTORIES (STORE PREP) ---
const uploadDirs = [
    path.join(__dirname, 'public', 'uploads', 'skins'),
    path.join(__dirname, 'public', 'uploads', 'bg'),
    path.join(__dirname, 'public', 'uploads', 'music')
];
uploadDirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads'))); // Serve store assets

// GLOBAL STATE
let rooms = {};
let connectedUsers = {}; 
let connectedDevices = {}; 
let adminSocketId = null;

// CONSTANTS
const ADMIN_NAME = "Kei"; 
const AI_NAMES = ["Ken Ayag", "P2", "P3", "P4"];
const PLAYER_COLORS = ['#00d2ff', '#ff3e3e', '#bcff00', '#ff00ff']; 

const RANK_COLORS = { 
    'E': '#00ff00', 'D': '#99ff00', 'C': '#ffff00', 'B': '#ff9900', 'A': '#ff00ff', 'S': '#ff0000', 'Eagle': '#ffffff' 
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

function syncAllMonoliths() {
    const list = Object.values(rooms).filter(r => r.isOnline && !r.active).map(r => ({ id: r.id, name: r.name, count: r.players.length }));
    io.emit('updateGateList', list); // Kept event name for compatibility with index.html
}

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    
    // --- DEVICE LOCK ---
    const deviceId = socket.handshake.query.deviceId;
    if (deviceId) {
        if (connectedDevices[deviceId] && io.sockets.sockets.get(connectedDevices[deviceId])) {
            socket.emit('authError', "SYSTEM: DEVICE BUSY. CLOSE OTHER TABS.");
            socket.disconnect(true);
            return;
        }
        connectedDevices[deviceId] = socket.id;
    }

    socket.on('adminAction', (data) => {
        if (socket.id !== adminSocketId) return; 
        
        // 1. KICK LOGIC
        if (data.action === 'kick' && connectedUsers[data.target]) {
            const tid = connectedUsers[data.target];
            const targetSocket = io.sockets.sockets.get(tid);
            
            if (targetSocket) {
                handleDisconnect(targetSocket, true); 
                targetSocket.emit('forceKick');
                targetSocket.disconnect(true);
            }
            delete connectedUsers[data.target];
        }
        
        // 2. BROADCAST LOGIC
        if (data.action === 'broadcast') {
            io.emit('receiveMessage', { sender: 'SYSTEM ADMIN', text: data.message, rank: 'ADMIN', timestamp: new Date().toLocaleTimeString(), isAdmin: true });
        }

        // 3. SEARCH & SPECTATE LOGIC
        if (data.action === 'search') {
            const targetName = data.target;
            let found = false;
            
            for (const roomId in rooms) {
                const r = rooms[roomId];
                const player = r.players.find(p => p.name === targetName);
                
                if (player) {
                    found = true;
                    const adminViewPlayers = r.players.map(p => ({
                        ...p,
                        powerUp: (p.powerUp ? '?' : null) 
                    }));

                    socket.emit('adminSearchResponse', {
                        found: true,
                        roomId: r.id,
                        roomName: r.name,
                        players: adminViewPlayers
                    });
                    break;
                }
            }
            if (!found) socket.emit('adminSearchResponse', { found: false, message: "PLAYER NOT IN A MATCH" });
        }
    });

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
                isAdmin: (user.username === ADMIN_NAME), music: reconnected ? null : 'menu.mp3',
                activeSkin: user.active_skin || null // Future store compatibility
            });
            
            socket.join('profile_page');
            
            if(!reconnected) { syncAllMonoliths(); broadcastWorldRankings(); }
        } else {
            socket.emit('authError', "INVALID CREDENTIALS.");
        }
    });

    socket.on('joinChatRoom', (rid) => { 
        socket.rooms.forEach(r => { if(r !== socket.id) socket.leave(r); });
        if(rid) socket.join(rid);
    });
    
    socket.on('spectateRoom', (roomId) => {
        if (rooms[roomId]) {
            socket.join(roomId);
            socket.emit('gameStart', { roomId: roomId });
            broadcastGameState(rooms[roomId]); 
        }
    });

    socket.on('sendMessage', (data) => {
        const payload = { sender: data.senderName, text: data.message, rank: data.rank, timestamp: new Date().toLocaleTimeString(), isAdmin: (data.senderName === ADMIN_NAME) };
        if (data.senderName === ADMIN_NAME && data.roomId === 'global') {
            io.emit('receiveMessage', payload);
        } else {
            io.to(data.roomId).emit('receiveMessage', payload);
        }
    });

    socket.on('requestGateList', syncAllMonoliths);
    socket.on('requestWorldRankings', broadcastWorldRankings);

    socket.on('createGate', async (data) => {
        const id = `monolith_${Date.now()}`;
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
                isAdmin: (data.host === ADMIN_NAME), turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0,
                skin: data.skin || null
            }],
            world: {},
            afkTimer: null
        };
        socket.join(id);
        io.to(id).emit('waitingRoomUpdate', rooms[id]);
        socket.emit('playMusic', 'waiting.mp3');
        syncAllMonoliths();
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
                isAdmin: (data.user === ADMIN_NAME), turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0,
                skin: data.skin || null
            });
            socket.join(data.gateID);
            io.to(data.gateID).emit('waitingRoomUpdate', r);
            socket.emit('playMusic', 'waiting.mp3');
            syncAllMonoliths();
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
                { id: socket.id, name: data.user, slot: 0, ...CORNERS[0], mana, rankLabel: getFullRankLabel(mana), alive: true, isAI: false, color: PLAYER_COLORS[0], quit: false, powerUp: null, isAdmin: (data.user === ADMIN_NAME), turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0, skin: data.skin || null },
                { id: 'ai1', name: AI_NAMES[1], slot: 1, ...CORNERS[1], mana: 200, rankLabel: "Lower D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[1], quit: false, powerUp: null, turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0, skin: null },
                { id: 'ai2', name: AI_NAMES[2], slot: 2, ...CORNERS[2], mana: 233, rankLabel: "Higher D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[2], quit: false, powerUp: null, turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0, skin: null },
                { id: 'ai3', name: AI_NAMES[3], slot: 3, ...CORNERS[3], mana: 200, rankLabel: "Lower D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[3], quit: false, powerUp: null, turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0, skin: null }
            ],
            world: {},
            afkTimer: null
        };
        socket.join(id);
        startGame(rooms[id]);
    });

    socket.on('activateSkill', (data) => {
        const r = Object.values(rooms).find(rm => rm.players.some(p => p.id === socket.id));
        if(r && r.processing) {
            const p = r.players.find(pl => pl.id === socket.id);
            if(p && p.powerUp === data.powerUp) {
                p.activeBuff = data.powerUp;
                p.powerUp = null;
                io.to(r.id).emit('announcement', `${p.name} ACTIVATED ${data.powerUp}!`);
                if (r.afkTimer) { clearTimeout(r.afkTimer); r.afkTimer = null; }
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

        if (r.afkTimer) { clearTimeout(r.afkTimer); r.afkTimer = null; }
        processMove(r, p, data.tx, data.ty);
    });

    socket.on('quitGame', () => handleDisconnect(socket, true));
    
    socket.on('disconnect', () => {
        if (deviceId && connectedDevices[deviceId] === socket.id) {
            delete connectedDevices[deviceId];
        }
        handleDisconnect(socket, false);
    });
});

function startGame(room) {
    room.active = true;
    for(let i=0; i<5; i++) spawnMonolith(room);
    io.to(room.id).emit('gameStart', { roomId: room.id });
    io.to(room.id).emit('playMusic', 'gameplay.mp3');
    broadcastGameState(room);
}

function processMove(room, player, tx, ty) {
    room.processing = true;
    player.x = tx;
    player.y = ty;

    const enemy = room.players.find(other => other.id !== player.id && other.alive && other.x === tx && other.y === ty);
    const monolithKey = `${tx}-${ty}`;
    const monolith = room.world[monolithKey];

    if (enemy || monolith) {
        room.currentBattle = { attacker: player.id, defender: enemy ? enemy.id : 'monolith' };
        broadcastGameState(room); 

        io.to(room.id).emit('battleStart', {
            hunter: player.name, hunterColor: player.color, hunterMana: player.mana,
            target: enemy ? enemy.name : (monolith.rank === 'Eagle' ? "SILVER EAGLE" : `MONOLITH ${monolith.rank}`),
            targetColor: enemy ? enemy.color : monolith.color, targetRank: `MP: ${enemy ? enemy.mana : monolith.mana}`
        });

        setTimeout(() => {
            resolveBattle(room, player, enemy || monolith, !!monolith);
        }, 5000);
    } else {
        finishTurn(room);
    }
}

function resolveBattle(room, attacker, defender, isMonolith) {
    if(!room.active) return;
    room.currentBattle = null;
    
    attacker.turnsWithoutBattle = 0;
    if(!isMonolith) {
        attacker.turnsWithoutPvP = 0;
        defender.turnsWithoutBattle = 0;
        defender.turnsWithoutPvP = 0;
    }

    let battleAttacker = attacker;
    let battleDefender = defender;
    let swapper = null;

    if (attacker.activeBuff === 'SOUL SWAP') swapper = attacker;
    else if (!isMonolith && defender.activeBuff === 'SOUL SWAP') swapper = defender;

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
            if(!isMonolith) defender.activeBuff = null;
        }
    }

    let attMana = battleAttacker.mana;
    let defMana = battleDefender.mana;
    let cancel = false;
    let autoWin = false;

    if (battleAttacker.activeBuff === 'DOUBLE DAMAGE') attMana *= 2;
    if (battleAttacker.activeBuff === 'RULERS POWER' && (!isMonolith || battleDefender.rank !== 'Eagle')) autoWin = true;
    if (battleAttacker.activeBuff === 'AIR WALK') { cancel = true; teleport(battleAttacker); }
    
    if(!isMonolith) {
        if(battleDefender.activeBuff === 'DOUBLE DAMAGE') defMana *= 2;
        if(battleDefender.activeBuff === 'RULERS POWER') defMana = 99999999;
        if(battleDefender.activeBuff === 'AIR WALK') { cancel = true; teleport(battleDefender); }
    }
    
    if(battleAttacker.id !== (swapper?.id)) battleAttacker.activeBuff = null;
    if(!isMonolith && battleDefender.id !== (swapper?.id)) battleDefender.activeBuff = null;

    let loser = null;

    if(!cancel) {
        if(autoWin || attMana >= defMana) {
            battleAttacker.mana += battleDefender.mana;
            if(isMonolith) {
                delete room.world[`${attacker.x}-${attacker.y}`];
                if(battleDefender.rank === 'Eagle') return handleWin(room, battleAttacker.name);
                if(!battleAttacker.powerUp && Math.random() < 0.2) {
                    battleAttacker.powerUp = POWER_UPS[Math.floor(Math.random() * POWER_UPS.length)];
                    // Send to attacker only (even if AI - effectively hidden)
                    io.to(battleAttacker.id).emit('announcement', `OBTAINED RUNE: ${battleAttacker.powerUp}`);
                }
            } else {
                battleDefender.alive = false;
                loser = battleDefender;
            }
        } else {
            if(!isMonolith) battleDefender.mana += battleAttacker.mana;
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
    checkEagleCondition(room);
    finishTurn(room);
}

function checkEagleCondition(room) {
    if (!room.active) return;
    const aliveTotal = room.players.filter(p => p.alive); 
    if (aliveTotal.length === 1) {
        const eagleMonolith = Object.values(room.world).find(g => g.rank === 'Eagle');
        if(!eagleMonolith) {
            let sx, sy;
            do { sx=rInt(15); sy=rInt(15); } while(room.players.some(p=>p.x===sx && p.y===sy) || room.world[`${sx}-${sy}`]);
            const smMana = Math.floor(Math.random() * (17000 - 1500 + 1)) + 1500;
            room.world[`${sx}-${sy}`] = { rank: 'Eagle', color: '#fff', mana: smMana };
            io.to(room.id).emit('announcement', `THE SILVER EAGLE HAS DESCENDED! DEFEAT IT IN 4 TURNS!`);
            room.survivorTurns = 0;
        }
    } 
}

function finishTurn(room) {
    if(!room.active) return;
    
    if (room.afkTimer) { clearTimeout(room.afkTimer); room.afkTimer = null; }

    room.processing = false; 
    const justPlayed = room.players[room.turn];
    
    if(justPlayed && justPlayed.alive) {
        justPlayed.turnsWithoutBattle++;
        justPlayed.turnsWithoutPvP++;

        if (justPlayed.turnsWithoutBattle >= 5 && !justPlayed.isStunned) {
            justPlayed.isStunned = true;
            justPlayed.stunDuration = 1;
            io.to(room.id).emit('announcement', `${justPlayed.name} is EXHAUSTED (No Battle)! STUNNED for 1 Turn!`);
        }
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
            for(let i=0; i<(3 + rInt(3)); i++) spawnMonolith(room);
        }
    }

    const eagleMonolith = Object.values(room.world).find(g => g.rank === 'Eagle');
    const alive = room.players.filter(p => p.alive);
    if (eagleMonolith && alive.length === 1) {
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
                     validNext = true; 
                 } else {
                     io.to(room.id).emit('announcement', `${nextP.name} is still STUNNED (${nextP.stunDuration} turns left).`);
                 }
            } else {
                 validNext = true;

                 if (!nextP.isAI) {
                     room.afkTimer = setTimeout(() => {
                         io.to(room.id).emit('announcement', `SYSTEM: ${nextP.name} WAS CONSUMED BY THE SHADOWS (AFK).`);
                         const afkSocket = io.sockets.sockets.get(nextP.id);
                         if (afkSocket) handleDisconnect(afkSocket, true); 
                     }, 180000); 
                 }
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
    if(room.afkTimer) clearTimeout(room.afkTimer);
    
    dbUpdateHunter(winnerName, room.isOnline ? 25 : 6, true);
    
    room.players.forEach(p => { 
        if(p.name !== winnerName && !p.quit && !p.isAI) {
            dbUpdateHunter(p.name, -5, false); 
        }
    });

    broadcastWorldRankings();
    setTimeout(() => { io.to(room.id).emit('returnToProfile'); delete rooms[room.id]; syncAllMonoliths(); }, 6000);
}

function handleDisconnect(socket, isQuit) {
    const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
    if(room) {
        if(room.afkTimer) clearTimeout(room.afkTimer);

        if (!room.active) {
            const index = room.players.findIndex(pl => pl.id === socket.id);
            if (index !== -1) {
                room.players.splice(index, 1);
                if (room.players.length === 0) delete rooms[room.id];
                else io.to(room.id).emit('waitingRoomUpdate', room);
            }
            syncAllMonoliths();
            const u = Object.keys(connectedUsers).find(key => connectedUsers[key] === socket.id);
            if(u) delete connectedUsers[u];
            return;
        }

        const p = room.players.find(pl => pl.id === socket.id);
        if(isQuit) {
            p.quit = true; p.alive = false; 
            
            const quitPenalty = room.isOnline ? -20 : -3;
            dbUpdateHunter(p.name, quitPenalty, false);
            
            socket.leave(room.id);
            socket.emit('returnToProfile'); 
            const activeHumans = room.players.filter(pl => !pl.quit && !pl.isAI);
            if(room.isOnline && activeHumans.length === 1) { handleWin(room, activeHumans[0].name); return; }
            if(!room.isOnline) { delete rooms[room.id]; syncAllMonoliths(); return; }
            if(p === room.players[room.turn]) finishTurn(room);
        }
        if(room.players.filter(pl => !pl.quit && !pl.isAI).length === 0) delete rooms[room.id]; 
        syncAllMonoliths();
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
    if(room.afkTimer) clearTimeout(room.afkTimer);
    
    let revivers = 0;
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
            revivers++;
        }
    });
    
    if (revivers === 0) {
        delete rooms[room.id];
        return;
    }
    
    for(let i=0; i<5; i++) spawnMonolith(room);
    finishTurn(room);
}

function spawnMonolith(room) {
    let sx, sy;
    do { sx=rInt(15); sy=rInt(15); } while(room.players.some(p=>p.x===sx && p.y===sy) || room.world[`${sx}-${sy}`]);
    let tiers = room.respawnHappened ? ['S', 'A'] : (room.spawnCounter <= 3 ? ['E', 'D'] : (room.spawnCounter <= 5 ? ['E', 'D', 'C', 'B'] : ['A', 'B', 'C', 'D', 'E']));
    const rank = tiers[rInt(tiers.length)];
    const range = { 'E':[10,100], 'D':[101,200], 'C':[201,400], 'B':[401,600], 'A':[601,900], 'S':[901,1500] }[rank];
    room.world[`${sx}-${sy}`] = { rank, color: RANK_COLORS[rank], mana: rInt(range[1]-range[0]) + range[0] };
}

// --- UPDATED AI MOVEMENT (STRICT RULES) ---
function runAIMove(room, ai) {
    if(!room.active) return;
    let target = null;
    let minDist = 999;
    const range = getMoveRange(ai.mana);

    // 1. SILVER EAGLE (Priority)
    const eagleKey = Object.keys(room.world).find(k => room.world[k].rank === 'Eagle');
    if (eagleKey) {
         const [sx, sy] = eagleKey.split('-').map(Number);
         target = {x: sx, y: sy};
    }

    // 2. WEAK PLAYERS
    if (!target) {
        const killable = room.players.filter(p => p.id !== ai.id && p.alive && ai.mana >= p.mana);
        if(killable.length > 0) {
             for(const k of killable) {
                 const dist = Math.abs(ai.x - k.x) + Math.abs(ai.y - k.y);
                 if(dist < minDist) { minDist = dist; target = {x: k.x, y: k.y}; }
             }
        }
    }

    // 3. FARM MONOLITHS
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
        const dx = target.x - ai.x; 
        const dy = target.y - ai.y;
        
        // --- STRICT PLAYER MOVEMENT LOGIC (ZIG-ZAG) ---
        // 1. If we are perfectly diagonal and 1 step away, take the 1 allowed diagonal step
        if (Math.abs(dx) === 1 && Math.abs(dy) === 1) {
             tx += dx;
             ty += dy;
        } 
        else {
            // 2. Cardinal Movement (Zig-Zag approach)
            // Move along X axis first if X distance is greater
            if (Math.abs(dx) >= Math.abs(dy)) {
                let stepX = (dx > 0) ? Math.min(dx, range) : Math.max(dx, -range);
                tx += stepX;
            } 
            // Move along Y axis first
            else {
                let stepY = (dy > 0) ? Math.min(dy, range) : Math.max(dy, -range);
                ty += stepY;
            }
        }
    } else {
        // Random move if no target
        tx = Math.max(0, Math.min(14, ai.x + (Math.random() < 0.5 ? 1 : -1)));
        ty = Math.max(0, Math.min(14, ai.y + (Math.random() < 0.5 ? 1 : -1)));
    }

    // --- AI POWER UP USAGE ---
    if (ai.powerUp) {
        const enemy = room.players.find(p => p.alive && p.x === tx && p.y === ty && p.id !== ai.id);
        const monolith = room.world[`${tx}-${ty}`];

        if (enemy || monolith) {
            let activate = false;
            if (ai.powerUp === 'RULERS POWER') activate = true;
            else if (ai.powerUp === 'DOUBLE DAMAGE') activate = true;
            else if (ai.powerUp === 'SOUL SWAP' && ai.mana < 300) activate = true;

            if (activate) {
                ai.activeBuff = ai.powerUp;
                ai.powerUp = null;
                io.to(room.id).emit('announcement', `${ai.name} ACTIVATED ${ai.activeBuff}!`);
            }
        }
    }

    tx = Math.max(0, Math.min(14, tx)); ty = Math.max(0, Math.min(14, ty));
    processMove(room, ai, tx, ty);
}

function teleport(p) { p.x = rInt(15); p.y = rInt(15); }
function rInt(max) { return Math.floor(Math.random() * max); }

async function broadcastGameState(room) {
    const { afkTimer, ...roomState } = room; 
    
    // FETCH ALL SOCKETS IN ROOM (Includes Players AND Spectating Admin)
    const sockets = await io.in(room.id).fetchSockets();

    for (const socket of sockets) {
        const isSocketAdmin = (socket.id === adminSocketId);
        
        const sanitized = room.players.map(pl => ({
            ...pl,
            // Admin sees EVERYONE'S Mana. Player sees only THEIR OWN.
            mana: (pl.id === socket.id || isSocketAdmin) ? pl.mana : null,
            
            // Admin sees '?' if powerup exists. Player sees their own actual powerup.
            powerUp: (pl.id === socket.id) ? pl.powerUp : (isSocketAdmin && pl.powerUp ? '?' : null),
            
            // Ensures active skins are sent over the socket to render for all players
            skin: pl.skin, 
            displayRank: getDisplayRank(pl.mana)
        }));

        socket.emit('gameStateUpdate', { ...roomState, players: sanitized, currentBattle: room.currentBattle });
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SYSTEM: ONLINE ON PORT ${PORT}`));
