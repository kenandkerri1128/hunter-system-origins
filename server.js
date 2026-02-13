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

let rooms = {};
const AI_NAMES = ["Sung Jinwoo", "Cha Hae-In", "Baek Yoonho", "Choi Jong-In"];
const PLAYER_COLORS = ['#00d2ff', '#ff3e3e', '#bcff00', '#ff00ff']; 
const RANK_COLORS = { 'E': '#00ff00', 'D': '#99ff00', 'C': '#ffff00', 'B': '#ff9900', 'A': '#ff00ff', 'S': '#ff0000', 'Silver': '#ffffff' };
const POWER_UPS = ['DOUBLE DAMAGE', 'GHOST WALK', 'NETHER SWAP'];

// --- RANKING HELPERS ---

// Used for the Profile View (Contains Higher/Lower)
function getFullRankLabel(mana) {
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

// Used for the In-Game Name Board (Removes Higher/Lower)
function getShortRankLabel(mana) {
    if (mana >= 901) return "S-Rank";
    if (mana >= 701) return "A-Rank";
    if (mana >= 501) return "B-Rank";
    if (mana >= 301) return "C-Rank";
    if (mana >= 101) return "D-Rank";
    return "E-Rank";
}

function getSimpleRank(mana) {
    if (mana >= 901) return 'S';
    if (mana >= 701) return 'A';
    if (mana >= 501) return 'B';
    if (mana >= 301) return 'C';
    if (mana >= 101) return 'D';
    return 'E';
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

io.on('connection', (socket) => {
    socket.on('authRequest', async (data) => {
        if (data.type === 'signup') {
            const { data: existing } = await supabase.from('Hunters').select('username').eq('username', data.u).maybeSingle();
            if (existing) return socket.emit('authError', "HUNTER ID ALREADY EXISTS");
            await supabase.from('Hunters').insert([{ username: data.u, password: data.p, manapoints: 0, wins: 0, losses: 0 }]);
        }
        const { data: user } = await supabase.from('Hunters').select('*').eq('username', data.u).eq('password', data.p).maybeSingle();
        if (user) {
            const letter = getSimpleRank(user.manapoints);
            const fullLabel = getFullRankLabel(user.manapoints);
            
            // Sending wins/losses here for the profile UI
            socket.emit('authSuccess', { 
                username: user.username, 
                mana: user.manapoints, 
                rank: fullLabel, 
                color: RANK_COLORS[letter],
                wins: user.wins || 0,
                losses: user.losses || 0
            });
            syncAllGates();
        } else {
            socket.emit('authError', "INVALID ACCESS CODE OR ID");
        }
    });

    socket.on('requestWorldRankings', async () => {
        const { data } = await supabase.from('Hunters').select('username, manapoints, wins, losses').order('manapoints', { ascending: false }).limit(10);
        socket.emit('updateWorldRankings', data);
    });

    socket.on('requestGateList', () => syncAllGates());

    socket.on('createGate', (data) => {
        const id = `gate_${Date.now()}`;
        rooms[id] = {
            id, name: data.name, isOnline: true, active: false, turn: 0, globalTurns: 0, survivorTurns: 0,
            respawnHappened: false,
            players: [{ id: socket.id, name: data.host, x:0, y:0, mana: Math.floor(Math.random()*201)+100, alive: true, confirmed: false, color: PLAYER_COLORS[0], isAI: false, quit: false, powerUp: null }],
            world: {}
        };
        socket.join(id);
        io.to(id).emit('waitingRoomUpdate', rooms[id]);
        syncAllGates();
    });

    socket.on('joinGate', (data) => {
        const room = rooms[data.gateID];
        if (room && room.players.length < 4) {
            if (room.players.some(p => p.name === data.user)) return; 
            const idx = room.players.length;
            const corners = [{x:0,y:0}, {x:14,y:0}, {x:0,y:14}, {x:14,y:14}];
            room.players.push({ id: socket.id, name: data.user, ...corners[idx], mana: Math.floor(Math.random()*201)+100, alive: true, confirmed: false, color: PLAYER_COLORS[idx], isAI: false, quit: false, powerUp: null });
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
                io.to(room.id).emit('gameStart');
                broadcastGameState(room);
                syncAllGates();
            } else { io.to(room.id).emit('waitingRoomUpdate', room); }
        }
    });

    socket.on('startSoloAI', (data) => {
        Object.keys(rooms).forEach(rid => {
            if (rooms[rid].players.some(p => p.id === socket.id)) delete rooms[rid];
        });

        const id = `solo_${socket.id}_${Date.now()}`;
        const corners = [{x:0,y:0}, {x:14,y:0}, {x:0,y:14}, {x:14,y:14}];
        rooms[id] = {
            id, active: true, turn: 0, isOnline: false, mode: data.diff, globalTurns: 0, survivorTurns: 0,
            respawnHappened: false,
            players: [
                { id: socket.id, name: data.user, ...corners[0], mana: Math.floor(Math.random()*201)+100, alive: true, isAI: false, color: PLAYER_COLORS[0], quit: false, powerUp: null },
                { id: 'ai1', name: AI_NAMES[1], ...corners[1], mana: Math.floor(Math.random()*201)+100, alive: true, isAI: true, color: PLAYER_COLORS[1], quit: false, powerUp: null },
                { id: 'ai2', name: AI_NAMES[2], ...corners[2], mana: Math.floor(Math.random()*201)+100, alive: true, isAI: true, color: PLAYER_COLORS[2], quit: false, powerUp: null },
                { id: 'ai3', name: AI_NAMES[3], ...corners[3], mana: Math.floor(Math.random()*201)+100, alive: true, isAI: true, color: PLAYER_COLORS[3], quit: false, powerUp: null }
            ],
            world: {}
        };
        for(let i=0; i<5; i++) spawnGate(rooms[id]);
        socket.join(id);
        socket.emit('gameStart');
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

    async function handleExit(s) {
        const room = Object.values(rooms).find(r => r.players.some(p => p.id === s.id));
        if (room) {
            const p = room.players.find(pl => pl.id === s.id);
            if (p && room.isOnline && !p.quit && room.active) {
                p.quit = true; p.alive = false; 
                const { data: u } = await supabase.from('Hunters').select('manapoints, losses').eq('username', p.name).maybeSingle();
                if (u) await supabase.from('Hunters').update({ 
                    manapoints: Math.max(0, u.manapoints - 20),
                    losses: (u.losses || 0) + 1 
                }).eq('username', p.name);
                io.to(room.id).emit('announcement', `${p.name} ABANDONED THE QUEST. -20 MP & LOSS RECORDED.`);
            }

            const activeHuman = room.players.filter(pl => !pl.quit && !pl.isAI);
            if (activeHuman.length === 1 && room.active && room.isOnline) {
                const winner = activeHuman[0];
                const { data: u } = await supabase.from('Hunters').select('manapoints, wins').eq('username', winner.name).maybeSingle();
                if (u) await supabase.from('Hunters').update({ 
                    manapoints: u.manapoints + 20,
                    wins: (u.wins || 0) + 1
                }).eq('username', winner.name);
                io.to(room.id).emit('victoryEvent', { winner: winner.name });
                io.to(room.id).emit('announcement', `ALL OTHER HUNTERS QUIT. ${winner.name} WINS BY DEFAULT. +20 MP & WIN RECORDED.`);
                setTimeout(() => { delete rooms[room.id]; syncAllGates(); }, 5000);
            }

            if (!room.active) room.players = room.players.filter(pl => pl.id !== s.id);
            if (room.players.length === 0 || room.players.every(pl => pl.isAI && !room.active)) delete rooms[room.id];
            else broadcastGameState(room);
            syncAllGates();
            s.emit('returnToProfile');
        }
    }

    socket.on('playerAction', async (data) => {
        const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
        if (!room || !room.active) return;
        const p = room.players[room.turn];
        if (p.id !== socket.id) return;

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
});

async function resolveConflict(room, p) {
    const coord = `${p.x}-${p.y}`;
    const opponent = room.players.find(o => o.id !== p.id && o.alive && o.x === p.x && o.y === p.y);
    const aliveCount = room.players.filter(pl => pl.alive).length;
    
    if (opponent) {
        room.players.forEach(pl => {
            io.to(pl.id).emit('battleStart', { 
                hunter: p.name, 
                target: opponent.name, 
                targetId: opponent.id, 
                targetMana: opponent.mana, 
                powerUp: (pl.id === opponent.id || pl.id === p.id) ? pl.powerUp : null
            });
        });

        await new Promise(r => setTimeout(r, 6000));
        
        let pCalcMana = p.mana, oCalcMana = opponent.mana, combatCancelled = false;
        let attacker = p;
        let defender = opponent;

        [attacker, defender].forEach(player => {
            if (player.activePowerUp) {
                const type = player.activePowerUp.type;
                if (type === 'DOUBLE DAMAGE') { 
                    if (player.id === attacker.id) pCalcMana *= 2; else oCalcMana *= 2; 
                }
                else if (type === 'GHOST WALK') { 
                    combatCancelled = true; 
                    teleportAway(player); 
                    io.to(room.id).emit('announcement', `${player.name} used GHOST WALK!`); 
                }
                else if (type === 'NETHER SWAP') {
                    const others = room.players.filter(pl => pl.alive && pl.id !== attacker.id && pl.id !== defender.id);
                    if (others.length > 0) {
                        const targetPlayer = others[Math.floor(Math.random() * others.length)];
                        io.to(room.id).emit('announcement', `🌀 NETHER SWAP! ${targetPlayer.name} was pulled into the fight!`);
                        if (pCalcMana >= targetPlayer.mana) {
                            player.mana += targetPlayer.mana;
                            targetPlayer.alive = false;
                            io.to(room.id).emit('announcement', `${player.name} stole ${targetPlayer.name}'s mana!`);
                        } else {
                            player.mana += attacker.mana;
                            attacker.alive = false;
                            io.to(room.id).emit('announcement', `${player.name} stole ${attacker.name}'s mana!`);
                        }
                        combatCancelled = true; 
                    }
                }
                player.activePowerUp = null;
            }
        });

        if (!combatCancelled) {
            if (pCalcMana >= oCalcMana) { 
                p.mana += opponent.mana; opponent.alive = false; 
            }
            else { 
                opponent.mana += p.mana; p.alive = false; 
            }
        }
        return;
    }

    if (room.world[coord]) {
        const gate = room.world[coord];
        io.to(room.id).emit('battleStart', { hunter: p.name, target: `RANK ${gate.rank}`, targetMana: gate.mana });
        await new Promise(r => setTimeout(r, 5000));
        
        if (p.mana >= gate.mana) {
            p.mana += gate.mana;
            delete room.world[coord];
            if (gate.rank === 'Silver') {
                const humanPlayer = room.players.find(pl => !pl.isAI && pl.id === p.id);
                if (humanPlayer && room.isOnline) {
                    const { data: u } = await supabase.from('Hunters').select('manapoints, wins').eq('username', humanPlayer.name).maybeSingle();
                    if (u) await supabase.from('Hunters').update({ 
                        manapoints: u.manapoints + 20,
                        wins: (u.wins || 0) + 1 
                    }).eq('username', humanPlayer.name);
                }
                io.to(room.id).emit('victoryEvent', { winner: p.name });
                room.active = false;
                setTimeout(() => { 
                    io.to(room.id).emit('returnToProfile'); 
                    delete rooms[room.id];
                    syncAllGates();
                }, 5100); 
            } else {
                const aliveSorted = [...room.players].filter(pl => pl.alive).sort((a,b) => a.mana - b.mana);
                if (Math.random() < (aliveSorted[0].id === p.id ? 0.6 : 0.15) && !p.powerUp) {
                    p.powerUp = POWER_UPS[Math.floor(Math.random() * POWER_UPS.length)];
                    io.to(p.id).emit('announcement', `SYSTEM: POWER-UP OBTAINED: ${p.powerUp}`);
                }
            }
        } else {
            if (aliveCount === 1) {
                triggerRespawn(room, p.id); 
            } else {
                p.alive = false;
            }
        }
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
        if (pl.id !== lastPlayerId) {
            const resurrectionBonus = Math.floor(Math.random() * 1001) + 500;
            pl.mana += resurrectionBonus; 
        }
        pl.alive = true;
    });
    
    room.world = {}; 
    room.globalTurns = 0;
    room.survivorTurns = 0; 
    const lastPlayerIdx = room.players.findIndex(pl => pl.id === lastPlayerId);
    room.turn = lastPlayerIdx;

    for(let i=0; i<5; i++) spawnGate(room);
    io.to(room.id).emit('announcement', `SYSTEM: QUEST FAILED. ALL HUNTERS REAWAKENED.`);
    broadcastGameState(room);
}

function spawnGate(room) {
    let x, y;
    let tries = 0;
    do { 
        x = Math.floor(Math.random() * 15); y = Math.floor(Math.random() * 15); 
        tries++;
    } while ((room.players.some(p => p.alive && p.x === x && p.y === y) || room.world[`${x}-${y}`]) && tries < 100);
    
    const cycle = Math.floor(room.globalTurns / room.players.length);
    let pool = room.respawnHappened 
        ? (cycle >= 6 ? ['A', 'S'] : (cycle >= 3 ? ['B', 'A'] : ['C', 'B']))
        : (cycle >= 6 ? ['C', 'B'] : (cycle >= 3 ? ['D', 'C'] : ['E', 'D']));
    
    const rank = pool[Math.floor(Math.random() * pool.length)];
    const manaMap = { 'E': [0, 100], 'D': [101, 300], 'C': [301, 500], 'B': [501, 700], 'A': [701, 900], 'S': [901, 1200] };
    const range = manaMap[rank];
    room.world[`${x}-${y}`] = { rank, color: RANK_COLORS[rank], mana: Math.floor(Math.random() * (range[1] - range[0] + 1)) + range[0] };
}

// Updated to use the Short Rank Label for the In-Game UI
function broadcastGameState(room) { 
    const sanitizedPlayers = room.players.map(p => ({
        ...p,
        rankLabel: getShortRankLabel(p.mana) // This ensures "Higher/Lower" is hidden in the game board
    }));
    
    const state = { ...room, players: sanitizedPlayers };
    io.to(room.id).emit('gameStateUpdate', state); 
}

function advanceTurn(room) {
    if (!rooms[room.id]) return; 
    
    const aliveCount = room.players.filter(p => p.alive).length;
    const currentActivePlayer = room.players[room.turn];

    if (aliveCount === 1 && room.survivorTurns >= 5) {
        triggerRespawn(room, currentActivePlayer.id);
        return;
    }

    room.globalTurns++;
    if (room.globalTurns % (room.players.length * 3) === 0) for(let i=0; i<5; i++) spawnGate(room);
    
    let attempts = 0;
    do { 
        room.turn = (room.turn + 1) % room.players.length; 
        attempts++; 
    } while (!room.players[room.turn].alive && attempts < 10);
    
    if (aliveCount === 1 && !Object.values(room.world).some(g => g.rank === 'Silver')) {
        let sx, sy;
        const survivor = room.players.find(p => p.alive);
        let validPos = false;
        for (let tries = 0; tries < 50; tries++) {
            let offsetX = (Math.random() > 0.5 ? 1 : -1) * (Math.floor(Math.random() * 2) + 3);
            let offsetY = (Math.random() > 0.5 ? 1 : -1) * (Math.floor(Math.random() * 2) + 3);
            sx = Math.max(0, Math.min(14, survivor.x + offsetX));
            sy = Math.max(0, Math.min(14, survivor.y + offsetY));
            if (!room.players.some(p => p.alive && p.x === sx && p.y === sy) && !room.world[`${sx}-${sy}`]) {
                validPos = true; break;
            }
        }
        if (!validPos) {
            do { sx = Math.floor(Math.random()*15); sy = Math.floor(Math.random()*15); } 
            while (room.players.some(p => p.alive && p.x === sx && p.y === sy));
        }
        room.world[`${sx}-${sy}`] = { rank: 'Silver', color: '#fff', mana: Math.floor(Math.random()*10000)+500 };
        io.to(room.id).emit('announcement', "SYSTEM: THE SILVER GATE HAS APPEARED NEARBY.");
    }

    const nextPlayer = room.players[room.turn];
    if (nextPlayer.isAI && nextPlayer.alive) {
        setTimeout(async () => {
            if (!rooms[room.id] || room.turn !== room.players.indexOf(nextPlayer)) return;
            const ai = nextPlayer;
            let tx = ai.x, ty = ai.y;

            if (room.mode === 'Monarch') {
                let targets = [];
                Object.keys(room.world).forEach(coord => {
                    const gate = room.world[coord];
                    const [gx, gy] = coord.split('-').map(Number);
                    if (ai.mana >= gate.mana) targets.push({ x: gx, y: gy, mana: gate.mana });
                });
                room.players.forEach(p => {
                    if (p.alive && p.id !== ai.id && ai.mana > p.mana) targets.push({ x: p.x, y: p.y, mana: p.mana });
                });
                if (targets.length > 0) {
                    targets.sort((a,b) => (Math.abs(ai.x - a.x) + Math.abs(ai.y - a.y)) - (Math.abs(ai.x - b.x) + Math.abs(ai.y - b.y)));
                    const best = targets[0];
                    if (best.x > ai.x) tx++; else if (best.x < ai.x) tx--;
                    if (best.y > ai.y) ty++; else if (best.y < ai.y) ty--;
                } else {
                    tx += (Math.random() > 0.5 ? 1 : -1); ty += (Math.random() > 0.5 ? 1 : -1);
                }
            } else {
                tx = Math.max(0, Math.min(14, ai.x + (Math.random() > 0.5 ? 1 : -1)));
                ty = Math.max(0, Math.min(14, ai.y + (Math.random() > 0.5 ? 1 : -1)));
            }
            tx = Math.max(0, Math.min(14, tx)); ty = Math.max(0, Math.min(14, ty));

            if (!isPathBlocked(room, ai.x, ai.y, tx, ty)) {
                ai.x = tx; ai.y = ty;
                if (aliveCount === 1) room.survivorTurns++;
                await resolveConflict(room, ai);
            }
            if (rooms[room.id]) advanceTurn(room);
        }, 800);
    }
    if (rooms[room.id]) broadcastGameState(room);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SYSTEM: Server is active on port ${PORT}`));
