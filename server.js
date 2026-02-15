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
const POWER_UPS = ['DOUBLE DAMAGE', 'GHOST WALK', 'NETHER SWAP', 'RULERS AUTHORITY'];
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

function getMoveRange(mana) {
    if (mana >= 901) return 6; // S
    if (mana >= 701) return 5; // A
    if (mana >= 501) return 4; // B
    if (mana >= 301) return 3; // C
    if (mana >= 101) return 2; // D
    return 1; // E
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

        // --- NEW MOVEMENT LOGIC ---
        const dx = data.tx - p.x;
        const dy = data.ty - p.y;
        const absDx = Math.abs(dx);
        const absDy = Math.abs(dy);
        
        if (absDx === 0 && absDy === 0) return; // No move

        // Diagonal Check: Must be exactly 1 tile
        if (absDx > 0 && absDy > 0) {
            if (absDx !== 1 || absDy !== 1) return;
        } else {
            // Cardinal Check: Must be <= Rank Range
            const dist = absDx + absDy;
            if (dist > getMoveRange(p.mana)) return;
        }

        // EXECUTE MOVE
        processMove(r, p, data.tx, data.ty);
    });

    socket.on('quitGame', () => handleDisconnect(socket, true));
    socket.on('disconnect', () => handleDisconnect(socket, false));
});


// =========================================================
//  THE NEW GAME ENGINE (RANK MOVEMENTS + QUIT LOGIC + SILVER FIX)
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
    let autoWin = false;

    // --- NETHER SWAP LOGIC (COMPLEX) ---
    // Swaps user with a random player, receives MP of loser, teleports.
    let userSwap = null;
    let otherSwap = null;

    if (attacker.activeBuff === 'NETHER SWAP') userSwap = attacker;
    else if (!isGate && defender.activeBuff === 'NETHER SWAP') userSwap = defender;

    if (userSwap) {
        // Find random substitute (Not the user, not the current opponent)
        const candidates = room.players.filter(p => p.alive && p.id !== attacker.id && p.id !== defender.id);
        
        if (candidates.length > 0) {
            cancel = true; // Cancel original battle structure
            const substitute = candidates[Math.floor(Math.random() * candidates.length)];
            
            // 1. Swap Coords
            const tx = userSwap.x; const ty = userSwap.y;
            userSwap.x = substitute.x; userSwap.y = substitute.y;
            substitute.x = tx; substitute.y = ty;
            
            io.to(room.id).emit('announcement', `🌀 ${userSwap.name} SWAPPED WITH ${substitute.name}!`);

            // 2. Execute Proxy Battle
            let proxyAttacker = (userSwap === attacker) ? substitute : attacker;
            let proxyDefender = (userSwap === defender) ? substitute : defender;
            
            // Proxy Battle Logic (Simplified)
            let loserMana = 0;
            if (proxyAttacker.mana >= proxyDefender.mana) {
                // Proxy Attacker Wins
                proxyAttacker.mana += proxyDefender.mana;
                loserMana = proxyDefender.mana;
                if(isGate) {
                     delete room.world[`${proxyAttacker.x}-${proxyAttacker.y}`];
                     if(proxyDefender.rank === 'Silver') handleWin(room, proxyAttacker.name);
                } else {
                     proxyDefender.alive = false;
                }
            } else {
                // Proxy Defender Wins
                loserMana = proxyAttacker.mana;
                if(!isGate) proxyDefender.mana += proxyAttacker.mana;
                proxyAttacker.alive = false;
            }

            // 3. User gets Loser MP
            userSwap.mana += loserMana;
            userSwap.activeBuff = null;
            io.to(room.id).emit('announcement', `🌀 ${userSwap.name} ABSORBED ${loserMana} MP FROM THE CHAOS!`);

            // 4. Teleport User to Random Living Player
            const living = room.players.filter(p => p.alive && p.id !== userSwap.id);
            if(living.length > 0) {
                const target = living[Math.floor(Math.random() * living.length)];
                userSwap.x = target.x; userSwap.y = target.y; // Teleport to same tile
                io.to(room.id).emit('announcement', `🌀 ${userSwap.name} WARPED TO ${target.name}!`);
            } else {
                teleport(userSwap);
            }

        } else {
             // Fallback if no players to swap with
             cancel = true;
             teleport(userSwap);
             userSwap.activeBuff = null;
             io.to(room.id).emit('announcement', `🌀 ${userSwap.name} NETHER SWAP (SOLO) -> TELEPORT!`);
        }
    }

    if (!cancel) {
        // 1. APPLY BUFFS
        if(attacker.activeBuff === 'DOUBLE DAMAGE') attMana *= 2;
        if(attacker.activeBuff === 'RULERS AUTHORITY' && (!isGate || defender.rank !== 'Silver')) autoWin = true;
        if(attacker.activeBuff === 'GHOST WALK') {
            cancel = true; teleport(attacker); io.to(room.id).emit('announcement', `${attacker.name} USED GHOST WALK!`);
        }
        
        if(!isGate) {
            if(defender.activeBuff === 'DOUBLE DAMAGE') defMana *= 2;
            if(defender.activeBuff === 'RULERS AUTHORITY') {
                // Defender auto-wins if attacker attacks? Or effectively cancels damage?
                // Let's say it makes them win defense.
                // But Attacker usually wins ties. 
                // Let's simply add huge mana to defender calculation.
                defMana = 99999999; 
            }
            if(defender.activeBuff === 'GHOST WALK') {
                cancel = true; teleport(defender); io.to(room.id).emit('announcement', `${defender.name} USED GHOST WALK!`);
            }
        }

        attacker.activeBuff = null; 
        if(!isGate) defender.activeBuff = null;
    }

    // 2. STANDARD COMBAT RESOLUTION
    if(!cancel) {
        if(autoWin || attMana >= defMana) {
            // ATTACKER WINS
            attacker.mana += defender.mana;
            if(isGate) {
                delete room.world[`${attacker.x}-${attacker.y}`];
                if(defender.rank === 'Silver') {
                     return handleWin(room, attacker.name); // WIN CONDITION
                }
                if(!attacker.powerUp && Math.random() < 0.2) {
                    attacker.powerUp = POWER_UPS[Math.floor(Math.random() * POWER_UPS.length)];
                    io.to(attacker.id).emit('announcement', `OBTAINED RUNE: ${attacker.powerUp}`);
                }
            } else {
                defender.alive = false;
            }
        } else {
            // DEFENDER WINS
            if(!isGate) defender.mana += attacker.mana;
            attacker.alive = false;
        }
    }

    io.to(room.id).emit('battleEnd');
    
    // Check Monarch Condition AFTER deaths logic
    checkSilverMonarchCondition(room);
    finishTurn(room);
}

function checkSilverMonarchCondition(room) {
    if (!room.active) return;
    
    // Check if only 1 player alive (Total, implies AI or Human)
    const aliveTotal = room.players.filter(p => p.alive); 

    // Condition: Only 1 person ALIVE
    if (aliveTotal.length === 1) {
        const silverGate = Object.values(room.world).find(g => g.rank === 'Silver');
        if(!silverGate) {
            let sx, sy;
            do { sx=rInt(15); sy=rInt(15); } while(room.players.some(p=>p.x===sx && p.y===sy) || room.world[`${sx}-${sy}`]);
            
            const smMana = Math.floor(Math.random() * (17000 - 1500 + 1)) + 1500;
            room.world[`${sx}-${sy}`] = { rank: 'Silver', color: '#fff', mana: smMana };
            
            io.to(room.id).emit('announcement', `SYSTEM: THE SILVER MONARCH [MP:${smMana}] HAS DESCENDED! DEFEAT IT IN 5 TURNS!`);
            room.survivorTurns = 0;
        }
    } 
}

function finishTurn(room) {
    if(!room.active) return;
    room.processing = false; 
    room.globalTurns++;

    // GATE SPAWNING (3-5 gates every 3 turns)
    if(room.globalTurns % 3 === 0) {
        const count = 3 + rInt(3); // 3 to 5
        for(let i=0; i<count; i++) spawnGate(room);
        broadcastGameState(room);
    }

    const silverGate = Object.values(room.world).find(g => g.rank === 'Silver');
    const alive = room.players.filter(p => p.alive);
    
    // Silver Monarch Timer
    if (silverGate && alive.length === 1) {
        room.survivorTurns++;
        if (room.survivorTurns >= 5) {
            triggerRespawn(room, alive[0].id);
            return;
        }
    }

    // Determine Next Turn
    let attempts = 0;
    do {
        room.turn = (room.turn + 1) % room.players.length;
        attempts++;
    } while((!room.players[room.turn].alive || room.players[room.turn].quit) && attempts < 10);

    // If everyone is dead or quit
    const activePlayers = room.players.filter(p => p.alive && !p.quit);
    if (activePlayers.length === 0) {
        // If everyone died, Respawn
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

    let target = null;
    let minDist = 999;
    
    // AI moves based on its rank range too? Assuming AI follows same rules
    const range = getMoveRange(ai.mana);

    // Scan Gates
    for(const key in room.world) {
        const [gx, gy] = key.split('-').map(Number);
        const g = room.world[key];
        const dist = Math.abs(ai.x - gx) + Math.abs(ai.y - gy);
        if(ai.mana >= g.mana && dist < minDist) { minDist = dist; target = {x:gx, y:gy}; }
    }

    if(room.mode === 'Monarch') {
        room.players.forEach(p => {
            if(p.id !== ai.id && p.alive && ai.mana > p.mana) {
                const dist = Math.abs(ai.x - p.x) + Math.abs(ai.y - p.y);
                if(dist < minDist) { minDist = dist; target = {x:p.x, y:p.y}; }
            }
        });
    }

    let tx = ai.x, ty = ai.y;
    if(target) {
        // AI Pathfinding (Simple step towards target)
        // Since AI can move >1 steps now, we move towards target up to Range
        const dx = target.x - ai.x;
        const dy = target.y - ai.y;
        
        // Simple heuristic: Move X then Y
        // We need to clamp total movement to 'range'
        let remaining = range;
        
        let moveX = 0;
        if(dx !== 0) {
            moveX = (dx > 0) ? Math.min(dx, remaining) : Math.max(dx, -remaining);
            tx += moveX;
            remaining -= Math.abs(moveX);
        }
        if(dy !== 0 && remaining > 0) {
            let moveY = (dy > 0) ? Math.min(dy, remaining) : Math.max(dy, -remaining);
            ty += moveY;
        }

    } else {
        // Random Move
        const dir = Math.floor(Math.random()*4);
        if(dir===0) tx+=1; else if(dir===1) tx-=1; else if(dir===2) ty+=1; else ty-=1;
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
    const winPoints = room.isOnline ? 20 : 5;
    
    // Update Winner
    dbUpdateHunter(winnerName, winPoints, true);

    // Update Losers (Online Only)
    if(room.isOnline) {
        room.players.forEach(p => {
            if(p.name !== winnerName && !p.quit && !p.isAI) {
                // "losing players (not those who quit but stayed till the end) will lose 5 HuP"
                dbUpdateHunter(p.name, -5, false);
            }
        });
    }

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
            p.quit = true; 
            p.alive = false; // Treat as dead for turns
            
            // Immediate Penalty (Only if Online PvP)
            if(room.isOnline) {
                dbUpdateHunter(p.name, -20, false);
                io.to(room.id).emit('announcement', `${p.name} HAS QUIT (PENALTY -20).`);
            } else {
                io.to(room.id).emit('announcement', `${p.name} HAS QUIT.`);
            }

            // --- CHECK FOR WINNER BY DEFAULT (PvP) ---
            const activeHumans = room.players.filter(pl => !pl.quit && !pl.isAI);
            if(room.isOnline && activeHumans.length === 1) {
                // Last man standing wins immediately
                handleWin(room, activeHumans[0].name);
                return;
            }

            // --- END GAME IF SOLO ---
            if(!room.isOnline) {
                io.to(room.id).emit('returnToProfile'); // Force back
                delete rooms[room.id];
                syncAllGates();
                return;
            }

            // If game continues, pass turn if it was theirs
            if(p === room.players[room.turn]) finishTurn(room);
        }
        
        // Cleanup if empty
        const connected = room.players.filter(pl => !pl.quit && !pl.isAI); 
        // If everyone is gone:
        if(isQuit && connected.length === 0 && !room.isOnline) delete rooms[room.id]; 
        
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
    
    room.players.forEach(p => {
        if(!p.quit) {
            p.alive = true;
            if(survivorId && p.id !== survivorId) {
                 // Defeated players respawn with bonus 500-1500 MP
                 p.mana += Math.floor(Math.random() * 1001) + 500;
            }
            // Survivor retains current MP (no changes)
        }
    });
    
    for(let i=0; i<5; i++) spawnGate(room);
    finishTurn(room);
}

function spawnGate(room) {
    let sx, sy, safe=0;
    do { sx=rInt(15); sy=rInt(15); safe++; } while((room.players.some(p=>p.x===sx && p.y===sy) || room.world[`${sx}-${sy}`]) && safe<50);
    if(safe>=50) return;

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
