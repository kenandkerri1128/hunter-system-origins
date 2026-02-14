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
        const isAdmin = (user.username === ADMIN_NAME);
        
        socket.emit('authSuccess', { 
            username: user.username, 
            mana: user.hunterpoints, 
            rank: getFullRankLabel(user.hunterpoints), 
            color: RANK_COLORS[letter],
            wins: user.wins || 0,
            losses: user.losses || 0,
            worldRank: exactRank,
            music: null,
            isAdmin: isAdmin
        });
    }
}

// --- GAME LOGIC HELPERS ---
function calculateDeduction(winnerInGameMana) {
    const mpStr = winnerInGameMana.toString();
    let deduction = 0;
    if (winnerInGameMana >= 10000) deduction = parseInt(mpStr.substring(0, 2));
    else deduction = parseInt(mpStr.substring(0, 1));
    return Math.max(1, deduction);
}

async function recordLoss(username, winnerInGameMana) {
    const { data: u } = await supabase.from('Hunters').select('hunterpoints, losses').eq('username', username).maybeSingle();
    if (u) {
        const lossAmount = calculateDeduction(winnerInGameMana);
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

// CRITICAL FIX: Find first available slot (0, 1, 2, 3) to avoid stacking
function getAvailableSlot(room) {
    const taken = room.players.map(p => p.slot);
    for(let i=0; i<4; i++) {
        if(!taken.includes(i)) return i;
    }
    return -1; // Room full
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
                    socket.emit('sysLog', `KICKED USER: ${data.target}`);
                } else {
                    socket.emit('sysLog', `USER ${data.target} NOT FOUND.`);
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
             socket.emit('sysLog', `BROADCAST SENT.`);
        }

        if (data.action === 'spectate') {
            const room = rooms[data.roomId];
            if (room) {
                socket.join(data.roomId);
                socket.emit('gameStart', { roomId: data.roomId });
                broadcastGameState(room);
                socket.emit('sysLog', `SPECTATING ROOM: ${data.roomId}`);
            } else {
                socket.emit('sysLog', `ROOM ${data.roomId} NOT FOUND.`);
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

        if (data.type === 'signup') {
            const { data: existing } = await supabase.from('Hunters').select('username').eq('username', data.u).maybeSingle();
            if (existing) return socket.emit('authError', "HUNTER ID ALREADY REGISTERED.");
            const { error } = await supabase.from('Hunters').insert([{ username: data.u, password: data.p, hunterpoints: 0, wins: 0, losses: 0 }]);
            if (error) return socket.emit('authError', "REGISTRATION FAILED.");
        }

        const { data: user } = await supabase.from('Hunters').select('*').eq('username', data.u).eq('password', data.p).maybeSingle();
        
        if (user) {
            connectedUsers[user.username] = socket.id; 
            
            const isAdmin = (user.username === ADMIN_NAME);
            if (isAdmin) adminSocketId = socket.id;

            const { count } = await supabase.from('Hunters').select('*', { count: 'exact', head: true }).gt('hunterpoints', user.hunterpoints);
            const exactRank = (count || 0) + 1;
            const letter = getSimpleRank(user.hunterpoints);
            
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
            syncAllGates();
            broadcastWorldRankings(); 
        } else {
            socket.emit('authError', "INVALID ACCESS CODE OR ID.");
        }
    });

    socket.on('joinChatRoom', (roomId) => {
        for (const room of socket.rooms) { if (room !== socket.id) socket.leave(room); }
        if (roomId) { socket.join(roomId); socket.emit('joinedRoom', roomId); socket.emit('clearChat'); }
    });

    socket.on('sendMessage', async (data) => {
        const { roomId, message, senderName } = data;
        const { data: user } = await supabase.from('Hunters').select('hunterpoints').eq('username', senderName).maybeSingle();
        const rank = user ? getDisplayRank(user.hunterpoints) : "Rank E"; 
        
        const chatData = { 
            sender: senderName, 
            text: message, 
            rank: rank, 
            timestamp: new Date().toLocaleTimeString(),
            isAdmin: (senderName === ADMIN_NAME)
        };

        if (!roomId || roomId === 'global' || roomId === 'null') { io.emit('receiveMessage', chatData); } 
        else { io.to(roomId).emit('receiveMessage', chatData); }
    });

    socket.on('requestWorldRankings', async () => broadcastWorldRankings());
    socket.on('requestGateList', () => syncAllGates());

    socket.on('createGate', async (data) => {
        const id = `gate_${Date.now()}`;
        const initialInGameMana = Math.floor(Math.random() * 251) + 50;
        const wrData = await getWorldRankDisplay(data.host);

        // FIXED: Explicit Slot 0 assignment
        rooms[id] = {
            id, name: data.name, isOnline: true, active: false, turn: 0, globalTurns: 0, survivorTurns: 0,
            respawnHappened: false,
            players: [{ 
                id: socket.id, 
                name: data.host, 
                slot: 0,
                x: CORNERS[0].x, 
                y: CORNERS[0].y, 
                mana: initialInGameMana, 
                rankLabel: getFullRankLabel(initialInGameMana),
                worldRankLabel: wrData.label,
                worldRankColor: wrData.color,
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
        const room = rooms[data.gateID];
        if (room && room.players.length < 4) {
            if (room.players.some(p => p.name === data.user)) return; 
            
            // FIXED: Get first available slot instead of length
            const slot = getAvailableSlot(room);
            if(slot === -1) return; // Should not happen if length < 4

            const playerMana = Math.floor(Math.random() * 251) + 50;
            const wrData = await getWorldRankDisplay(data.user);

            room.players.push({ 
                id: socket.id, 
                name: data.user,
                slot: slot,
                x: CORNERS[slot].x, 
                y: CORNERS[slot].y, 
                mana: playerMana, 
                rankLabel: getFullRankLabel(playerMana),
                worldRankLabel: wrData.label,
                worldRankColor: wrData.color,
                alive: true, confirmed: false, color: PLAYER_COLORS[slot], isAI: false, quit: false, powerUp: null,
                isAdmin: (data.user === ADMIN_NAME) 
            });
            socket.join(data.gateID);
            io.to(data.gateID).emit('waitingRoomUpdate', room);
            socket.emit('playMusic', 'waiting.mp3');
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
                io.to(room.id).emit('playMusic', 'gameplay.mp3');
                broadcastGameState(room);
                syncAllGates();
            } else { io.to(room.id).emit('waitingRoomUpdate', room); }
        }
    });

    socket.on('startSoloAI', async (data) => {
        const id = `solo_${socket.id}_${Date.now()}`;
        const playerMana = Math.floor(Math.random() * 251) + 50;

        rooms[id] = {
            id, active: true, turn: 0, isOnline: false, mode: data.diff, globalTurns: 0, survivorTurns: 0,
            respawnHappened: false,
            players: [
                { id: socket.id, name: data.user, slot: 0, ...CORNERS[0], mana: playerMana, rankLabel: getFullRankLabel(playerMana), alive: true, isAI: false, color: PLAYER_COLORS[0], quit: false, powerUp: null, isAdmin: (data.user === ADMIN_NAME) },
                { id: 'ai1', name: AI_NAMES[1], slot: 1, ...CORNERS[1], mana: 200, rankLabel: "Lower D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[1], quit: false, powerUp: null },
                { id: 'ai2', name: AI_NAMES[2], slot: 2, ...CORNERS[2], mana: 233, rankLabel: "Higher D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[2], quit: false, powerUp: null },
                { id: 'ai3', name: AI_NAMES[3], slot: 3, ...CORNERS[3], mana: 200, rankLabel: "Lower D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[3], quit: false, powerUp: null }
            ],
            world: {}
        };
        for(let i=0; i<5; i++) spawnGate(rooms[id]);
        socket.join(id);
        socket.emit('gameStart', { roomId: id });
        socket.emit('playMusic', 'gameplay.mp3');
        broadcastGameState(rooms[id]);
    });

    socket.on('activateSkill', (data) => {
        const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
        if (!room) return;
        const p = room.players.find(pl => pl.id === socket.id);
        if (p && p.powerUp) {
            p.activePowerUp = { type: data.powerUp };
            p.powerUp = null; 
            io.to(room.id).emit('announcement', `${p.name} ACTIVATED ${data.powerUp}!`);
        }
    });

    socket.on('disconnect', async () => { handleExit(socket); });
    socket.on('quitGame', async () => { handleExit(socket); });

    // CRITICAL FIX: Robust disconnection handling
    async function handleExit(s) {
        const username = Object.keys(connectedUsers).find(u => connectedUsers[u] === s.id);
        if (username) delete connectedUsers[username];
        if (s.id === adminSocketId) adminSocketId = null;

        const room = Object.values(rooms).find(r => r.players.some(p => p.id === s.id));
        if (room) {
            s.leave(room.id);
            const pIndex = room.players.findIndex(pl => pl.id === s.id);
            const p = room.players[pIndex];
            
            if (room.active) {
                // Game IN PROGRESS
                if (p && !p.quit) {
                    p.quit = true; p.alive = false; 
                    const { data: u } = await supabase.from('Hunters').select('hunterpoints, losses').eq('username', p.name).maybeSingle();
                    if (u) await supabase.from('Hunters').update({ 
                        hunterpoints: Math.max(0, u.hunterpoints - 20),
                        losses: (u.losses || 0) + 1 
                    }).eq('username', p.name);
                    
                    io.to(room.id).emit('announcement', `${p.name} ABANDONED THE QUEST. -20 HuP & LOSS RECORDED.`);
                    broadcastWorldRankings();

                    // CRITICAL FIX: If it was the quitter's turn, advance immediately!
                    if(room.turn === pIndex) {
                        advanceTurn(room);
                    }
                }
                
                const activeHuman = room.players.filter(pl => !pl.quit && !pl.isAI);
                if (activeHuman.length === 1 && room.isOnline) {
                    const winner = activeHuman[0];
                    await processWin(room, winner.name);
                }
                
                if (!room.active) room.players = room.players.filter(pl => pl.id !== s.id);
                if (room.players.length === 0 || room.players.every(pl => pl.isAI && !room.active)) {
                    delete rooms[room.id];
                } else { 
                    broadcastGameState(room); 
                }
            } else {
                // WAITING ROOM: Totally remove player
                room.players = room.players.filter(pl => pl.id !== s.id);
                if (room.players.length === 0) {
                    delete rooms[room.id];
                } else {
                    io.to(room.id).emit('waitingRoomUpdate', room);
                }
            }
            syncAllGates();
        }
    }

    socket.on('playerAction', async (data) => {
        const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
        if (!room || !room.active) return;
        if (socket.id === adminSocketId && !room.players.some(p => p.id === adminSocketId)) return;

        const p = room.players[room.turn];
        if (!p || p.id !== socket.id) return;
        if (isPathBlocked(room, p.x, p.y, data.tx, data.ty)) {
            socket.emit('announcement', "SYSTEM: MOVEMENT BLOCKED BY A GATE.");
            return;
        }
        const alivePlayers = room.players.filter(pl => pl.alive);
        if (alivePlayers.length === 1) room.survivorTurns++;
        p.x = data.tx; p.y = data.ty;
        await resolveConflict(room, p);
        if (rooms[room.id]) advanceTurn(room);
    });

    function broadcastGameState(room) { 
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
});

async function resolveConflict(room, p) {
    const coord = `${p.x}-${p.y}`;
    const opponent = room.players.find(o => o.id !== p.id && o.alive && o.x === p.x && o.y === p.y);
    
    try {
        if (opponent) {
            io.to(room.id).emit('battleStart', { 
                hunter: p.name, 
                hunterMana: p.mana,
                hunterColor: p.color, 
                hunterPowerUp: p.powerUp, 
                target: opponent.name, 
                targetId: opponent.id, 
                targetMana: opponent.mana,
                targetRank: `MP: ${opponent.mana}`, 
                targetColor: opponent.color 
            });
            await new Promise(r => setTimeout(r, 6000));
            
            const currP = room.players.find(pl => pl.id === p.id);
            const currOp = room.players.find(pl => pl.id === opponent.id);
            if(!currP || !currOp || !currP.alive || !currOp.alive) {
                io.to(room.id).emit('battleEnd');
                return;
            }

            let pCalcMana = p.mana, oCalcMana = opponent.mana, combatCancelled = false;
            [p, opponent].forEach(player => {
                if (player.activePowerUp) {
                    const type = player.activePowerUp.type;
                    if (type === 'DOUBLE DAMAGE') { if (player.id === p.id) pCalcMana *= 2; else oCalcMana *= 2; }
                    else if (type === 'GHOST WALK') { combatCancelled = true; teleportAway(player); io.to(room.id).emit('announcement', `${player.name} used GHOST WALK!`); }
                    else if (type === 'NETHER SWAP') {
                        const others = room.players.filter(pl => pl.alive && pl.id !== p.id && pl.id !== opponent.id);
                        if (others.length > 0) {
                            const targetPlayer = others[Math.floor(Math.random() * others.length)];
                            io.to(room.id).emit('announcement', `🌀 NETHER SWAP! ${targetPlayer.name} was pulled into the fight!`);
                            if (pCalcMana >= targetPlayer.mana) { p.mana += targetPlayer.mana; targetPlayer.alive = false; }
                            else { p.alive = false; opponent.mana += p.mana; }
                            combatCancelled = true; 
                        }
                    }
                    player.activePowerUp = null;
                }
            });
            if (!combatCancelled) {
                if (pCalcMana >= oCalcMana) { 
                    p.mana += opponent.mana; 
                    opponent.alive = false; 
                    if (!opponent.isAI && room.isOnline) {
                        await recordLoss(opponent.name, p.mana); 
                        const loserSocket = io.sockets.sockets.get(opponent.id);
                        if(loserSocket) sendProfileUpdate(loserSocket, opponent.name);
                        broadcastWorldRankings();
                    }
                } else { 
                    opponent.mana += p.mana; 
                    p.alive = false; 
                    if (!p.isAI && room.isOnline) {
                        await recordLoss(p.name, opponent.mana); 
                        const loserSocket = io.sockets.sockets.get(p.id);
                        if(loserSocket) sendProfileUpdate(loserSocket, p.name);
                        broadcastWorldRankings();
                    }
                }
            }
            io.to(room.id).emit('battleEnd');
            return;
        }

        if (room.world[coord]) {
            const gate = room.world[coord];
            io.to(room.id).emit('battleStart', { 
                hunter: p.name, 
                hunterMana: p.mana,
                hunterColor: p.color, 
                hunterPowerUp: p.powerUp, 
                target: `RANK ${gate.rank}`, 
                targetMana: gate.mana,
                targetRank: `MP: ${gate.mana}`, 
                targetColor: gate.color 
            });
            await new Promise(r => setTimeout(r, 6000));
            
            const currP = room.players.find(pl => pl.id === p.id);
            if(!currP || !currP.alive) {
                io.to(room.id).emit('battleEnd');
                return;
            }

            if (p.mana >= gate.mana) {
                p.mana += gate.mana;
                delete room.world[coord];
                if (gate.rank === 'Silver') {
                    if (!p.isAI && room.isOnline) {
                        await processWin(room, p.name);
                    } else {
                        io.to(room.id).emit('victoryEvent', { winner: p.name });
                        room.active = false;
                        setTimeout(() => { 
                            if(rooms[room.id]) {
                                io.to(room.id).emit('returnToProfile'); 
                                delete rooms[room.id];
                                syncAllGates();
                            }
                        }, 6000); 
                    }
                } else {
                    const aliveSorted = [...room.players].filter(pl => pl.alive).sort((a,b) => a.mana - b.mana);
                    if (aliveSorted.length > 0 && Math.random() < (aliveSorted[0].id === p.id ? 0.6 : 0.15) && !p.powerUp) {
                        p.powerUp = POWER_UPS[Math.floor(Math.random() * POWER_UPS.length)];
                        io.to(p.id).emit('announcement', `SYSTEM: POWER-UP OBTAINED: ${p.powerUp}`);
                    }
                }
            } else {
                const aliveCount = room.players.filter(pl => pl.alive).length;
                if (aliveCount === 1) triggerRespawn(room, p.id);
                else { 
                    p.alive = false; 
                    if (!p.isAI && room.isOnline) {
                        await recordLoss(p.name, gate.mana);
                        const loserSocket = io.sockets.sockets.get(p.id);
                        if(loserSocket) sendProfileUpdate(loserSocket, p.name);
                        broadcastWorldRankings();
                    }
                }
            }
            io.to(room.id).emit('battleEnd');
        }
    } catch (e) {
        console.error("Battle Error:", e);
        io.to(room.id).emit('battleEnd');
    }
}

function teleportAway(player) {
    player.x = Math.floor(Math.random() * 15); player.y = Math.floor(Math.random() * 15);
}

function triggerRespawn(room, lastPlayerId) {
    const candidates = room.players.filter(p => !p.quit);
    if (candidates.length === 0) { delete rooms[room.id]; return; }
    room.respawnHappened = true; 
    candidates.forEach(pl => { 
        if (pl.id !== lastPlayerId) pl.mana += Math.floor(Math.random() * 1001) + 500; 
        pl.alive = true;
    });
    room.world = {}; room.globalTurns = 0; room.survivorTurns = 0; 
    room.turn = room.players.findIndex(pl => pl.id === lastPlayerId);
    for(let i=0; i<5; i++) spawnGate(room);
    io.to(room.id).emit('announcement', `SYSTEM: QUEST FAILED. ALL HUNTERS REAWAKENED.`);
    broadcastGameState(room);
}

function spawnGate(room) {
    let x, y, tries = 0;
    do { x = Math.floor(Math.random() * 15); y = Math.floor(Math.random() * 15); tries++; } 
    while ((room.players.some(p => p.alive && p.x === x && p.y === y) || room.world[`${x}-${y}`]) && tries < 50);
    
    if(tries >= 50) return;

    const cycle = Math.floor(room.globalTurns / room.players.length);
    let pool = room.respawnHappened ? (cycle >= 6 ? ['A', 'S'] : (cycle >= 3 ? ['B', 'A'] : ['C', 'B'])) : (cycle >= 6 ? ['C', 'B'] : (cycle >= 3 ? ['D', 'C'] : ['E', 'D']));
    const rank = pool[Math.floor(Math.random() * pool.length)];
    const manaMap = { 'E': [0, 100], 'D': [101, 300], 'C': [301, 500], 'B': [501, 700], 'A': [701, 900], 'S': [901, 1200] };
    const range = manaMap[rank];
    room.world[`${x}-${y}`] = { rank, color: RANK_COLORS[rank], mana: Math.floor(Math.random() * (range[1] - range[0] + 1)) + range[0] };
}

function advanceTurn(room) {
    if (!rooms[room.id] || !room.active) return; 
    
    const aliveCount = room.players.filter(p => p.alive).length;
    if (aliveCount === 0) return; 

    if (aliveCount === 1 && room.survivorTurns >= 5) { 
        triggerRespawn(room, room.players[room.turn].id); 
        return; 
    }
    
    room.globalTurns++;
    if (room.globalTurns % (room.players.length * 3) === 0) for(let i=0; i<5; i++) spawnGate(room);
    
    let attempts = 0;
    let nextIndex = room.turn;
    do { 
        nextIndex = (nextIndex + 1) % room.players.length; 
        attempts++; 
    } while (!room.players[nextIndex].alive && attempts < room.players.length + 1);
    
    room.turn = nextIndex;

    const nextPlayer = room.players[room.turn];
    if (!nextPlayer) return; 

    if (aliveCount === 1 && !Object.values(room.world).some(g => g.rank === 'Silver')) {
        let sx, sy, validPos = false;
        const survivor = room.players.find(p => p.alive);
        for (let t = 0; t < 50; t++) {
            sx = Math.max(0, Math.min(14, survivor.x + (Math.random() > 0.5 ? 1 : -1) * (Math.floor(Math.random() * 2) + 3)));
            sy = Math.max(0, Math.min(14, survivor.y + (Math.random() > 0.5 ? 1 : -1) * (Math.floor(Math.random() * 2) + 3)));
            if (!room.players.some(p => p.alive && p.x === sx && p.y === sy) && !room.world[`${sx}-${sy}`]) { validPos = true; break; }
        }
        
        if (!validPos) { 
            let silverTries = 0;
            do { 
                sx = Math.floor(Math.random()*15); 
                sy = Math.floor(Math.random()*15); 
                silverTries++;
            } while (room.players.some(p => p.alive && p.x === sx && p.y === sy) && silverTries < 100);
            
            if (silverTries < 100) {
                const silverMana = Math.floor(Math.random() * 15501) + 1500;
                room.world[`${sx}-${sy}`] = { rank: 'Silver', color: '#fff', mana: silverMana };
                io.to(room.id).emit('announcement', "SYSTEM: THE SILVER GATE HAS APPEARED NEARBY.");
            }
        }
    }
    
    if (nextPlayer.isAI && nextPlayer.alive) {
        setTimeout(async () => {
            if (!rooms[room.id] || !room.active || room.turn !== room.players.indexOf(nextPlayer)) return;
            let tx = nextPlayer.x, ty = nextPlayer.y;
            
            if (room.mode === 'Monarch') {
                let targets = [];
                Object.keys(room.world).forEach(c => { const g = room.world[c]; const [gx, gy] = c.split('-').map(Number); if (nextPlayer.mana >= g.mana) targets.push({ x: gx, y: gy }); });
                room.players.forEach(p => { if (p.alive && p.id !== nextPlayer.id && nextPlayer.mana > p.mana) targets.push({ x: p.x, y: p.y }); });
                if (targets.length > 0) {
                    targets.sort((a,b) => (Math.abs(nextPlayer.x - a.x) + Math.abs(nextPlayer.y - a.y)) - (Math.abs(nextPlayer.x - b.x) + Math.abs(nextPlayer.y - b.y)));
                    const b = targets[0]; if (b.x > nextPlayer.x) tx++; else if (b.x < nextPlayer.x) tx--; if (b.y > nextPlayer.y) ty++; else if (b.y < nextPlayer.y) ty--;
                } else { tx += (Math.random() > 0.5 ? 1 : -1); ty += (Math.random() > 0.5 ? 1 : -1); }
            } else { tx += (Math.random() > 0.5 ? 1 : -1); ty += (Math.random() > 0.5 ? 1 : -1); }
            
            tx = Math.max(0, Math.min(14, tx)); ty = Math.max(0, Math.min(14, ty));
            if (!isPathBlocked(room, nextPlayer.x, nextPlayer.y, tx, ty)) { nextPlayer.x = tx; nextPlayer.y = ty; await resolveConflict(room, nextPlayer); }
            if (rooms[room.id]) advanceTurn(room);
        }, 800);
    } else {
        broadcastGameState(room);
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SYSTEM: Server is active on port ${PORT}`));
