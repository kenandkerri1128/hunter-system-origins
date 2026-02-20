const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);

// CONNECTION URL
const io = new Server(server, {
    cors: { origin: ["https://originmanaseige.onrender.com", "https://originmanaseige.onrender.com/"] },
    pingTimeout: 60000 
});

// --- CRASH PREVENTION ---
process.on('uncaughtException', (err) => console.error('SYSTEM ERROR:', err));
process.on('unhandledRejection', (reason) => console.error('PROMISE ERROR:', reason));

// --- DATABASE CONFIGURATION ---
const SUPABASE_URL = 'https://wfsuxqgvshrhqfvnkzdx.supabase.co'; 
// SECURITY SHIELD: Master Service Role Key
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Indmc3V4cWd2c2hyaHFmdm5remR4Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3MDgyNTAxNCwiZXhwIjoyMDg2NDAxMDE0fQ.S4sg9RXAY5XBowA2Huim4OCLwUKpnRDeYUrzinzxmAw'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// --- ASSET DIRECTORIES ---
const uploadDirs = [
    path.join(__dirname, 'public', 'uploads', 'skins'),
    path.join(__dirname, 'public', 'uploads', 'bg'),
    path.join(__dirname, 'public', 'uploads', 'music')
];
uploadDirs.forEach(dir => {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'public', 'uploads')));

// GLOBAL STATE
let rooms = {};
let connectedUsers = {}; 
let connectedDevices = {}; 
let pendingDisconnects = {}; 
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

// --- RANK UNLOCK LOGIC ---
function getRankUnlockedItems(mana) {
    let unlocked = [];
    if (mana >= 101) unlocked.push('skin:char_knight.png'); 
    if (mana >= 301) unlocked.push('skin:char_calvary.png'); 
    if (mana >= 501) unlocked.push('skin:char_assasin.png'); 
    if (mana >= 701) unlocked.push('skin:char_sniper.png', 'eagle:eagle_premium.png'); 
    if (mana >= 901) unlocked.push('skin:char_speargirl.png', 'bg:hunterseige_bg.png'); 
    if (mana >= 1000) unlocked.push('skin:char_main char.png', 'music:Pixel Parlor Lounge.mp3'); 
    return unlocked;
}

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

async function broadcastWorldRankings(targetSocket = null) {
    try {
        const { data } = await supabase.from('Hunters').select('username, hunterpoints, wins, losses').order('hunterpoints', { ascending: false }).limit(100);
        if (data) {
            const list = data.map(r => ({ 
                ...r, 
                rankLabel: getFullRankLabel(r.hunterpoints),
                isAdmin: r.username === ADMIN_NAME 
            }));
            if(targetSocket) targetSocket.emit('updateWorldRankings', list);
            else io.emit('updateWorldRankings', list);
        }
    } catch(e) {}
}

function syncAllMonoliths() {
    const list = Object.values(rooms).filter(r => r.isOnline && !r.active).map(r => ({ id: r.id, name: r.name, count: r.players.length }));
    io.emit('updateGateList', list); 

    if (adminSocketId) {
        const activeRooms = Object.values(rooms).filter(r => r.active).map(r => ({
            id: r.id,
            name: r.name || `SOLO-GATE-${r.id.split('_')[2] || 'AI'}`,
            isOnline: r.isOnline,
            players: r.players.map(p => p.name).join(', ')
        }));
        io.to(adminSocketId).emit('updateAdminRoomList', activeRooms);
    }
}

function getAllVaultItems() {
    const items = [];
    const skinDir = path.join(__dirname, 'public', 'uploads', 'skins');
    if (fs.existsSync(skinDir)) {
        fs.readdirSync(skinDir).forEach(f => {
            if(f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg')) {
                if (f.startsWith('char_')) items.push(`skin:${f}`);
                else if (f.startsWith('eagle_')) items.push(`eagle:${f}`);
            }
        });
    }
    
    const bgDir = path.join(__dirname, 'public', 'uploads', 'bg');
    if (fs.existsSync(bgDir)) {
        fs.readdirSync(bgDir).forEach(f => {
            if(f.endsWith('.png') || f.endsWith('.jpg') || f.endsWith('.jpeg')) items.push(`bg:${f}`);
        });
    }

    const musicDir = path.join(__dirname, 'public', 'uploads', 'music');
    if (fs.existsSync(musicDir)) {
        fs.readdirSync(musicDir).forEach(f => {
            if(f.endsWith('.mp3') || f.endsWith('.wav')) items.push(`music:${f}`);
        });
    }

    const PRIORITY_ITEMS = [
        'skin:char_knight.png', 'skin:char_calvary.png', 'skin:char_assasin.png',
        'skin:char_sniper.png', 'eagle:eagle_premium.png', 'skin:char_speargirl.png',
        'bg:hunterseige_bg.png', 'skin:char_main char.png', 'music:Pixel Parlor Lounge.mp3'
    ];

    items.sort((a, b) => {
        const indexA = PRIORITY_ITEMS.indexOf(a);
        const indexB = PRIORITY_ITEMS.indexOf(b);
        if (indexA !== -1 && indexB !== -1) return indexA - indexB;
        if (indexA !== -1) return -1;
        if (indexB !== -1) return 1;
        return a.localeCompare(b);
    });

    return items;
}

// --- SOCKET LOGIC ---
io.on('connection', (socket) => {
    
    socket.lastMsgTime = 0;
    socket.lastGateTime = 0;

    const deviceId = socket.handshake.query.deviceId;
    if (deviceId) {
        if (connectedDevices[deviceId] && io.sockets.sockets.get(connectedDevices[deviceId])) {
            socket.emit('authError', "SYSTEM: DEVICE BUSY. CLOSE OTHER TABS.");
            socket.disconnect(true);
            return;
        }
        connectedDevices[deviceId] = socket.id;
    }

    socket.on('requestInventoryUpdate', async (username) => {
        try {
            const { data: user } = await supabase.from('Hunters').select('hunterpoints, inventory, active_cosmetics').eq('username', username).single();
            if (user) {
                const rankItems = getRankUnlockedItems(user.hunterpoints);
                const totalOwned = [...new Set([...(user.inventory || []), ...rankItems])];
                socket.emit('inventoryUpdate', { 
                    inventory: getAllVaultItems(), 
                    ownedItems: totalOwned,
                    activeCosmetics: user.active_cosmetics 
                });
            }
        } catch(e) {}
    });

    socket.on('requestAdminVault', () => {
        if (socket.id !== adminSocketId) return;
        socket.emit('adminVaultData', getAllVaultItems());
    });

    socket.on('adminAction', async (data) => {
        if (socket.id !== adminSocketId) return; 
        
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
        
        if (data.action === 'broadcast') {
            io.emit('receiveMessage', { sender: 'SYSTEM ADMIN', text: data.message, rank: 'ADMIN', timestamp: new Date().toLocaleTimeString(), isAdmin: true });
        }

        if (data.action === 'search') {
            const targetName = data.target;
            let found = false;
            for (const roomId in rooms) {
                const r = rooms[roomId];
                const player = r.players.find(p => p.name === targetName);
                if (player) {
                    found = true;
                    const adminViewPlayers = r.players.map(p => ({ ...p, powerUp: (p.powerUp ? '?' : null) }));
                    socket.emit('adminSearchResponse', { found: true, roomId: r.id, roomName: r.name, players: adminViewPlayers });
                    break;
                }
            }
            if (!found) socket.emit('adminSearchResponse', { found: false, message: "PLAYER NOT IN A MATCH" });
        }

        if (data.action === 'grantItem') {
            try {
                const { data: u } = await supabase.from('Hunters').select('inventory').eq('username', data.target).single();
                if (u) {
                    let inv = u.inventory || [];
                    if (!inv.includes(data.item)) {
                        inv.push(data.item);
                        await supabase.from('Hunters').update({ inventory: inv }).eq('username', data.target);
                        
                        const targetSocketId = connectedUsers[data.target];
                        if (targetSocketId) {
                            const { data: freshUser } = await supabase.from('Hunters').select('hunterpoints, inventory, active_cosmetics').eq('username', data.target).single();
                            const rankItems = getRankUnlockedItems(freshUser.hunterpoints);
                            const totalOwned = [...new Set([...(freshUser.inventory || []), ...rankItems])];
                            
                            io.to(targetSocketId).emit('inventoryUpdate', { 
                                inventory: getAllVaultItems(), 
                                ownedItems: totalOwned,
                                activeCosmetics: freshUser.active_cosmetics 
                            });
                            
                            const displayName = data.item.split(':')[1];
                            io.to(targetSocketId).emit('announcement', `SYSTEM: YOU RECEIVED A NEW ITEM - ${displayName}`);
                        }
                    }
                }
            } catch(e) {}
        }
    });

    socket.on('authRequest', async (data) => {
        if (!data || typeof data.u !== 'string' || typeof data.p !== 'string') return;

        if (connectedUsers[data.u]) {
            const old = io.sockets.sockets.get(connectedUsers[data.u]);
            if (old && old.connected) return socket.emit('authError', "ALREADY LOGGED IN.");
        }
        
        if (data.type === 'signup') {
            const { data: existing } = await supabase.from('Hunters').select('username').eq('username', data.u).maybeSingle();
            if(existing) return socket.emit('authError', "USERNAME TAKEN.");
            const { error } = await supabase.from('Hunters').insert([{ username: data.u, password: data.p, hunterpoints: 0, inventory: [], active_cosmetics: {} }]);
            if (error) return socket.emit('authError', "CREATION FAILED.");
        }

        const { data: user } = await supabase.from('Hunters').select('*').eq('username', data.u).eq('password', data.p).maybeSingle();
        if (user) {
            if (pendingDisconnects[user.username]) {
                clearTimeout(pendingDisconnects[user.username]);
                delete pendingDisconnects[user.username];
            }

            connectedUsers[user.username] = socket.id;
            if(user.username === ADMIN_NAME) adminSocketId = socket.id;

            let reconnected = false;
            const existingRoom = Object.values(rooms).find(r => r.players.some(p => p.name === user.username));
            if(existingRoom) {
                const p = existingRoom.players.find(p => p.name === user.username);
                p.id = socket.id; 
                p.activeCosmetics = user.active_cosmetics || {}; 
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

            const startingMusic = user.active_cosmetics?.music || (reconnected ? null : 'menu.mp3');
            if (startingMusic) socket.emit('playMusic', startingMusic);

            const rankItems = getRankUnlockedItems(user.hunterpoints);
            const totalOwned = [...new Set([...(user.inventory || []), ...rankItems])];

            socket.emit('authSuccess', { 
                username: user.username, mana: user.hunterpoints, 
                rank: getFullRankLabel(user.hunterpoints), color: RANK_COLORS[letter],
                wins: user.wins||0, losses: user.losses||0, worldRank: (count||0)+1,
                isAdmin: (user.username === ADMIN_NAME), music: null, 
                inventory: getAllVaultItems(), 
                ownedItems: totalOwned, 
                activeCosmetics: user.active_cosmetics || {},
                reconnected: reconnected // Sends reconnect state to frontend to block menu wipe
            });
            
            socket.join('profile_page');
            if(!reconnected) { syncAllMonoliths(); broadcastWorldRankings(socket); }
        } else {
            socket.emit('authError', "INVALID CREDENTIALS.");
        }
    });

    socket.on('equipItem', async (data) => {
        if (!data || !data.username || !data.type || !data.item) return;

        try {
            const { data: user } = await supabase.from('Hunters').select('hunterpoints, inventory, active_cosmetics').eq('username', data.username).single();
            const invString = `${data.type}:${data.item}`;
            
            const isAdmin = (data.username === ADMIN_NAME);
            const rankItems = user ? getRankUnlockedItems(user.hunterpoints) : [];
            const totalOwned = [...new Set([...(user ? user.inventory || [] : []), ...rankItems])];

            if (isAdmin || totalOwned.includes(invString)) {
                let cosmetics = user.active_cosmetics || {};
                if (cosmetics[data.type] === data.item) cosmetics[data.type] = null;
                else cosmetics[data.type] = data.item;

                await supabase.from('Hunters').update({ active_cosmetics: cosmetics }).eq('username', data.username);
                
                socket.emit('inventoryUpdate', { 
                    inventory: getAllVaultItems(), 
                    ownedItems: totalOwned,
                    activeCosmetics: cosmetics 
                });

                if (data.type === 'music') {
                    if (cosmetics.music) socket.emit('playMusic', cosmetics.music);
                    else {
                        const pRoom = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
                        if (!pRoom) socket.emit('playMusic', 'menu.mp3');
                        else if (pRoom.active) socket.emit('playMusic', 'gameplay.mp3');
                        else socket.emit('playMusic', 'waiting.mp3');
                    }
                }

                for (const roomId in rooms) {
                    const r = rooms[roomId];
                    const player = r.players.find(p => p.name === data.username);
                    if (player) {
                        player.activeCosmetics = cosmetics; 
                        player.skin = cosmetics.skin || null; 
                        broadcastGameState(r);
                    }
                }
            } else {
                socket.emit('announcement', `SYSTEM: ITEM LOCKED. GRIND FOR RANK OR VANGUARD STATUS.`);
            }
        } catch(e) {}
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
        const now = Date.now();
        if (now - socket.lastMsgTime < 1000) { 
            return socket.emit('announcement', 'SYSTEM: Slow down your transmission.');
        }
        socket.lastMsgTime = now;

        if (!data || typeof data.message !== 'string') return;
        const safeMessage = data.message.substring(0, 200); 

        const payload = { sender: data.senderName, text: safeMessage, rank: data.rank, timestamp: new Date().toLocaleTimeString(), isAdmin: (data.senderName === ADMIN_NAME) };
        if (data.senderName === ADMIN_NAME && data.roomId === 'global') io.emit('receiveMessage', payload);
        else io.to(data.roomId).emit('receiveMessage', payload);
    });

    socket.on('requestGateList', syncAllMonoliths);
    socket.on('requestWorldRankings', () => broadcastWorldRankings(socket));

    socket.on('createGate', async (data) => {
        const now = Date.now();
        if (now - socket.lastGateTime < 5000) { 
            return socket.emit('announcement', 'SYSTEM: Re-calibration required. Wait before opening another Gate.');
        }
        socket.lastGateTime = now;

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
                skin: data.cosmetics?.skin || null, 
                activeCosmetics: data.cosmetics || {}
            }],
            world: {},
            afkTimer: null
        };
        socket.join(id);
        io.to(id).emit('waitingRoomUpdate', rooms[id]);
        if (!data.cosmetics?.music) socket.emit('playMusic', 'waiting.mp3');
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
                skin: data.cosmetics?.skin || null, 
                activeCosmetics: data.cosmetics || {}
            });
            socket.join(data.gateID);
            io.to(data.gateID).emit('waitingRoomUpdate', r);
            if (!data.cosmetics?.music) socket.emit('playMusic', 'waiting.mp3');
            syncAllMonoliths();
        }
    });

    socket.on('playerConfirm', (data) => {
        const r = rooms[data.gateID];
        if(r) {
            const p = r.players.find(pl => pl.id === socket.id);
            if(p) p.confirmed = true;
            if(r.players.length >= 2 && r.players.every(pl => pl.confirmed)) startGame(r);
            else io.to(r.id).emit('waitingRoomUpdate', r);
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
                { id: socket.id, name: data.user, slot: 0, ...CORNERS[0], mana, rankLabel: getFullRankLabel(mana), alive: true, isAI: false, color: PLAYER_COLORS[0], quit: false, powerUp: null, isAdmin: (data.user === ADMIN_NAME), turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0, skin: data.cosmetics?.skin || null, activeCosmetics: data.cosmetics || {} },
                { id: 'ai1', name: AI_NAMES[1], slot: 1, ...CORNERS[1], mana: 200, rankLabel: "Lower D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[1], quit: false, powerUp: null, turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0, skin: null, activeCosmetics: {} },
                { id: 'ai2', name: AI_NAMES[2], slot: 2, ...CORNERS[2], mana: 233, rankLabel: "Higher D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[2], quit: false, powerUp: null, turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0, skin: null, activeCosmetics: {} },
                { id: 'ai3', name: AI_NAMES[3], slot: 3, ...CORNERS[3], mana: 200, rankLabel: "Lower D-Rank", alive: true, isAI: true, color: PLAYER_COLORS[3], quit: false, powerUp: null, turnsWithoutBattle: 0, turnsWithoutPvP: 0, isStunned: false, stunDuration: 0, skin: null, activeCosmetics: {} }
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
        if (!data || typeof data.tx !== 'number' || typeof data.ty !== 'number') return;
        if (data.tx < 0 || data.tx > 14 || data.ty < 0 || data.ty > 14) return; 

        const r = Object.values(rooms).find(rm => rm.players.some(p => p.id === socket.id));
        if(!r || !r.active || r.processing) return; 
        
        const p = r.players[r.turn];
        if(!p || p.id !== socket.id) return;

        const dx = Math.abs(data.tx - p.x);
        const dy = Math.abs(data.ty - p.y);
        if (dx === 0 && dy === 0) return; 

        if (dx > 0 && dy > 0) { if (dx !== 1 || dy !== 1) return; } 
        else { if (dx + dy > getMoveRange(p.mana)) return; }

        if (r.afkTimer) { clearTimeout(r.afkTimer); r.afkTimer = null; }
        processMove(r, p, data.tx, data.ty);
    });

    socket.on('quitGame', () => {
        // Find player and manually process quit penalty outside of disconnect timeout
        const room = Object.values(rooms).find(r => r.players.some(p => p.id === socket.id));
        if (room) {
            const p = room.players.find(pl => pl.id === socket.id);
            if (p && !p.quit) {
                dbUpdateHunter(p.name, room.isOnline ? -20 : -3, false);
            }
        }
        handleDisconnect(socket, true);
    });
    
    socket.on('disconnect', () => {
        if (deviceId && connectedDevices[deviceId] === socket.id) delete connectedDevices[deviceId];
        const username = Object.keys(connectedUsers).find(key => connectedUsers[key] === socket.id);

        if (username) {
            // FIX: Disconnect timeout changed to exactly 2 Minutes (120000ms)
            pendingDisconnects[username] = setTimeout(() => {
                delete pendingDisconnects[username];
                if (!connectedUsers[username] || connectedUsers[username] === socket.id) {
                    const room = Object.values(rooms).find(r => r.players.some(p => p.name === username));
                    if(room) {
                        io.to(room.id).emit('announcement', `SYSTEM: ${username} WAS CONSUMED BY THE SHADOWS (DISCONNECTED).`);
                        const p = room.players.find(pl => pl.name === username);
                        if (p && !p.quit) dbUpdateHunter(p.name, room.isOnline ? -20 : -3, false); // Applies correct quit penalty
                    }
                    handleDisconnect(socket, true); 
                }
            }, 120000); 
        } else handleDisconnect(socket, false);
    });
});

// --- CORE LOGIC FUNCTIONS ---
function startGame(room) {
    room.active = true;
    for(let i=0; i<5; i++) spawnMonolith(room);
    io.to(room.id).emit('gameStart', { roomId: room.id });
    room.players.forEach(p => { if (!p.isAI && !p.activeCosmetics?.music) io.to(p.id).emit('playMusic', 'gameplay.mp3'); });
    
    // FIX: Trigger 2-Minute AFK timer immediately for first player
    const p1 = room.players[0];
    if (!p1.isAI) {
        room.afkTimer = setTimeout(() => {
            io.to(room.id).emit('announcement', `SYSTEM: ${p1.name} WAS CONSUMED BY THE SHADOWS (AFK).`);
            const afkSocket = io.sockets.sockets.get(p1.id);
            if (afkSocket) {
                dbUpdateHunter(p1.name, room.isOnline ? -20 : -3, false);
                handleDisconnect(afkSocket, true);
            } else { 
                p1.quit = true; p1.alive = false; 
                dbUpdateHunter(p1.name, room.isOnline ? -20 : -3, false);
                if(room.isOnline && room.players.filter(pl => !pl.quit && !pl.isAI).length === 1) handleWin(room, room.players.find(pl => !pl.quit && !pl.isAI).name);
                else finishTurn(room); 
            }
        }, 120000);
    }
    
    broadcastGameState(room);
    syncAllMonoliths();
}

function processMove(room, player, tx, ty) {
    room.processing = true;
    player.x = tx; player.y = ty;
    const enemy = room.players.find(other => other.id !== player.id && other.alive && other.x === tx && other.y === ty);
    const monolith = room.world[`${tx}-${ty}`];

    if (enemy || monolith) {
        room.currentBattle = { attacker: player.id, defender: enemy ? enemy.id : 'monolith' };
        broadcastGameState(room); 
        io.to(room.id).emit('battleStart', {
            hunter: player.name, hunterColor: player.color, hunterMana: player.mana,
            target: enemy ? enemy.name : (monolith.rank === 'Eagle' ? "SILVER EAGLE" : `MONOLITH ${monolith.rank}`),
            targetColor: enemy ? enemy.color : monolith.color, targetRank: `MP: ${enemy ? enemy.mana : monolith.mana}`
        });
        setTimeout(() => { resolveBattle(room, player, enemy || monolith, !!monolith); }, 3000);
    } else finishTurn(room);
}

function resolveBattle(room, attacker, defender, isMonolith) {
    if(!room.active) return;
    room.currentBattle = null;
    attacker.turnsWithoutBattle = 0;
    if(!isMonolith) { attacker.turnsWithoutPvP = 0; defender.turnsWithoutBattle = 0; defender.turnsWithoutPvP = 0; }

    let bAtt = attacker; let bDef = defender; let swp = null;
    if (attacker.activeBuff === 'SOUL SWAP') swp = attacker;
    else if (!isMonolith && defender.activeBuff === 'SOUL SWAP') swp = defender;

    if (swp) {
        const victims = room.players.filter(p => p.alive && !p.quit && p.id !== attacker.id && p.id !== (isMonolith ? null : defender.id));
        if (victims.length > 0) {
            const v = victims[Math.floor(Math.random() * victims.length)];
            io.to(room.id).emit('announcement', `${swp.name} used SOUL SWAP! Swapping with ${v.name}!`);
            if (swp.id === attacker.id) bAtt = v; else bDef = v;
            swp.activeBuff = null;
        } else { bAtt.activeBuff = null; if(!isMonolith) bDef.activeBuff = null; }
    }

    let aM = bAtt.mana; let dM = bDef.mana; let can = false; let aw = false;
    if (bAtt.activeBuff === 'DOUBLE DAMAGE') aM *= 2;
    if (bAtt.activeBuff === 'RULERS POWER' && (!isMonolith || bDef.rank !== 'Eagle')) aw = true;
    if (bAtt.activeBuff === 'AIR WALK') { can = true; teleport(bAtt); }
    if(!isMonolith) {
        if(bDef.activeBuff === 'DOUBLE DAMAGE') dM *= 2;
        if(bDef.activeBuff === 'RULERS POWER') dM = 99999999;
        if(bDef.activeBuff === 'AIR WALK') { can = true; teleport(bDef); }
    }
    
    if(bAtt.id !== swp?.id) bAtt.activeBuff = null;
    if(!isMonolith && bDef.id !== swp?.id) bDef.activeBuff = null;

    if(!can) {
        if(aw || aM >= dM) {
            bAtt.mana += bDef.mana;
            if(isMonolith) {
                delete room.world[`${attacker.x}-${attacker.y}`];
                if(bDef.rank === 'Eagle') return handleWin(room, bAtt.name);
                if(!bAtt.powerUp && Math.random() < 0.2) {
                    bAtt.powerUp = POWER_UPS[Math.floor(Math.random() * POWER_UPS.length)];
                    io.to(bAtt.id).emit('announcement', `OBTAINED RUNE: ${bAtt.powerUp}`);
                }
            } else { bDef.alive = false; if (swp) { swp.mana += bDef.mana; swp.x = bDef.x; swp.y = bDef.y; } }
        } else {
            if(!isMonolith) bDef.mana += bAtt.mana;
            bAtt.alive = false;
        }
    }
    io.to(room.id).emit('battleEnd');
    checkEagleCondition(room);
    finishTurn(room);
}

function checkEagleCondition(room) {
    if (!room.active) return;
    if (room.players.filter(p => p.alive).length === 1) {
        if(!Object.values(room.world).find(g => g.rank === 'Eagle')) {
            let sx, sy; do { sx=rInt(15); sy=rInt(15); } while(room.players.some(p=>p.x===sx && p.y===sy) || room.world[`${sx}-${sy}`]);
            room.world[`${sx}-${sy}`] = { rank: 'Eagle', color: '#fff', mana: Math.floor(Math.random() * 15500) + 1500 };
            io.to(room.id).emit('announcement', `THE SILVER EAGLE HAS DESCENDED!`);
            room.survivorTurns = 0;
        }
    } 
}

function finishTurn(room) {
    if(!room.active) return;
    if (room.afkTimer) { clearTimeout(room.afkTimer); room.afkTimer = null; }
    room.processing = false; 
    
    const p = room.players[room.turn];
    if(p && p.alive) { 
        p.turnsWithoutBattle++; p.turnsWithoutPvP++; 
        if (p.turnsWithoutPvP >= 10 && !p.isStunned) {
            p.isStunned = true; p.stunDuration = 2; p.turnsWithoutPvP = 0; 
            io.to(room.id).emit('announcement', `${p.name} is COWARDLY! STUNNED for 2 Turns!`);
        } else if (p.turnsWithoutBattle >= 5 && !p.isStunned) {
            p.isStunned = true; p.stunDuration = 1; p.turnsWithoutBattle = 0; 
            io.to(room.id).emit('announcement', `${p.name} is EXHAUSTED! STUNNED for 1 Turn!`);
        }
    }

    room.currentRoundMoves++;
    if (room.currentRoundMoves >= room.players.filter(pl => pl.alive).length) {
        room.currentRoundMoves = 0; room.round++;
        if (room.round % 3 === 0) { room.spawnCounter++; for(let i=0; i<3; i++) spawnMonolith(room); }
    }

    if (Object.values(room.world).find(g => g.rank === 'Eagle') && room.players.filter(pl => pl.alive).length === 1) {
        room.survivorTurns++; if (room.survivorTurns >= 5) { triggerRespawn(room, null); return; }
    }

    let attempts = 0; let valid = false;
    do {
        room.turn = (room.turn + 1) % room.players.length;
        const n = room.players[room.turn];
        if (n.alive && !n.quit) {
            if (n.isStunned) { 
                n.stunDuration--; 
                if (n.stunDuration <= 0) { n.isStunned = false; valid = true; } 
            } else { 
                valid = true; 
                if (!n.isAI) {
                    // FIX: 2 Minute In-Game AFK Timer triggers here for active games
                    room.afkTimer = setTimeout(() => {
                        io.to(room.id).emit('announcement', `SYSTEM: ${n.name} WAS CONSUMED BY THE SHADOWS (AFK).`);
                        const afkSocket = io.sockets.sockets.get(n.id);
                        if (afkSocket) {
                            dbUpdateHunter(n.name, room.isOnline ? -20 : -3, false);
                            handleDisconnect(afkSocket, true);
                        } else {
                            n.quit = true; n.alive = false;
                            dbUpdateHunter(n.name, room.isOnline ? -20 : -3, false);
                            if(room.isOnline && room.players.filter(pl => !pl.quit && !pl.isAI).length === 1) handleWin(room, room.players.find(pl => !pl.quit && !pl.isAI).name);
                            else finishTurn(room);
                        }
                    }, 120000); 
                }
            }
        }
        attempts++;
    } while(!valid && attempts < 10);

    if (room.players.filter(pl => pl.alive && !pl.quit).length === 0) { triggerRespawn(room, null); return; }
    broadcastGameState(room);
    
    const nextP = room.players[room.turn];
    if(nextP.alive && nextP.isAI) setTimeout(() => runAIMove(room, nextP), 1000);
}

// FIX: Hardcoded Math (Win +25/6, Loss -5)
function handleWin(room, winner) {
    io.to(room.id).emit('victoryEvent', { winner });
    room.active = false; if(room.afkTimer) clearTimeout(room.afkTimer);
    
    // WINNER MATH
    dbUpdateHunter(winner, room.isOnline ? 25 : 6, true);
    
    // LOSER MATH (-5 for both PvP and AI)
    room.players.forEach(p => { 
        if(p.name !== winner && !p.quit && !p.isAI) dbUpdateHunter(p.name, -5, false); 
    });
    
    broadcastWorldRankings();
    setTimeout(() => { 
        io.to(room.id).emit('returnToProfile'); 
        room.players.forEach(p => { if (!p.isAI && !p.activeCosmetics?.music) io.to(p.id).emit('playMusic', 'menu.mp3'); });
        delete rooms[room.id]; syncAllMonoliths(); 
    }, 6000);
}

function handleDisconnect(socket, isQuit) {
    if (!socket) return; 
    let room = null;
    
    // Locate room either by socket ID or if the user completely dropped off
    for (const rid in rooms) {
        if (rooms[rid].players.some(p => p.id === socket.id)) {
            room = rooms[rid];
            break;
        }
    }

    if(room) {
        if(room.afkTimer) clearTimeout(room.afkTimer);
        const p = room.players.find(pl => pl.id === socket.id);
        if(isQuit && p && !p.quit) {
            p.quit = true; p.alive = false; 
            socket.leave(room.id); socket.emit('returnToProfile'); 
            if(room.isOnline && room.players.filter(pl => !pl.quit && !pl.isAI).length === 1) handleWin(room, room.players.find(pl => !pl.quit && !pl.isAI).name);
            else finishTurn(room);
        }
        if(room.players.filter(pl => !pl.quit && !pl.isAI).length === 0) delete rooms[room.id]; 
        syncAllMonoliths();
    }
    const u = Object.keys(connectedUsers).find(key => connectedUsers[key] === socket.id);
    if(u) delete connectedUsers[u];
}

function triggerRespawn(room, sid) {
    io.to(room.id).emit('announcement', "REAWAKENING PROTOCOL...");
    room.respawnHappened = true; room.world = {}; 
    room.players.forEach(p => { if(!p.quit) { p.alive = true; teleport(p); p.mana += 500; } });
    for(let i=0; i<5; i++) spawnMonolith(room);
    finishTurn(room);
}

function spawnMonolith(room) {
    let sx, sy; do { sx=rInt(15); sy=rInt(15); } while(room.players.some(p=>p.x===sx && p.y===sy) || room.world[`${sx}-${sy}`]);
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

    const eagleKey = Object.keys(room.world).find(k => room.world[k].rank === 'Eagle');
    if (eagleKey) {
         const [sx, sy] = eagleKey.split('-').map(Number);
         target = {x: sx, y: sy};
    }

    if (!target) {
        const killable = room.players.filter(p => p.id !== ai.id && p.alive && ai.mana >= p.mana);
        if(killable.length > 0) {
             for(const k of killable) {
                 const dist = Math.abs(ai.x - k.x) + Math.abs(ai.y - k.y);
                 if(dist < minDist) { minDist = dist; target = {x: k.x, y: k.y}; }
             }
        }
    }

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
        if (Math.abs(dx) === 1 && Math.abs(dy) === 1) { tx += dx; ty += dy; } 
        else {
            if (Math.abs(dx) >= Math.abs(dy)) { let stepX = (dx > 0) ? Math.min(dx, range) : Math.max(dx, -range); tx += stepX; } 
            else { let stepY = (dy > 0) ? Math.min(dy, range) : Math.max(dy, -range); ty += stepY; }
        }
    } else {
        tx = Math.max(0, Math.min(14, ai.x + (Math.random() < 0.5 ? 1 : -1)));
        ty = Math.max(0, Math.min(14, ai.y + (Math.random() < 0.5 ? 1 : -1)));
    }

    if (ai.powerUp) {
        const enemy = room.players.find(p => p.alive && p.x === tx && p.y === ty && p.id !== ai.id);
        const monolith = room.world[`${tx}-${ty}`];
        if (enemy || monolith) {
            let activate = false;
            if (ai.powerUp === 'RULERS POWER') activate = true;
            else if (ai.powerUp === 'DOUBLE DAMAGE') activate = true;
            else if (ai.powerUp === 'SOUL SWAP' && ai.mana < 300) activate = true;

            if (activate) {
                ai.activeBuff = ai.powerUp; ai.powerUp = null;
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
    try {
        const { afkTimer, hostCosmetics, ...safeRoom } = room; 
        const sockets = await io.in(room.id).fetchSockets();
        
        for (const socket of sockets) {
            const isAdm = (socket.id === adminSocketId);
            const tp = safeRoom.players.find(p => p.id === socket.id);
            const sanitized = safeRoom.players.map(pl => ({
                ...pl, activeCosmetics: undefined, mana: (pl.id === socket.id || isAdm) ? pl.mana : null,
                powerUp: (pl.id === socket.id) ? pl.powerUp : (isAdm && pl.powerUp ? '?' : null),
                displayRank: getDisplayRank(pl.mana)
            }));
            socket.emit('gameStateUpdate', { ...safeRoom, players: sanitized, hostCosmetics: tp ? tp.activeCosmetics : {} });
        }
    } catch(e) { console.error("Broadcast Error", e); }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SYSTEM: ONLINE ON PORT ${PORT}`));

