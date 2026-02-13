const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
const { createClient } = require('@supabase/supabase-js'); 

// --- DATABASE CONNECTION ---
const supabaseUrl = 'https://wfsuxqgvshrhqfvnkzdx.supabase.co'; 
const supabaseKey = 'sb_secret_zJcSVUKBPb1ZPOYuRGYOjg_6H090DFK';
const supabase = createClient(supabaseUrl, supabaseKey);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// --- RANKING HELPERS ---
function getDetailedRank(mana) {
    if (mana >= 1000) return "HIGHER S";
    if (mana >= 901) return "LOWER S";
    if (mana >= 801) return "HIGHER A";
    if (mana >= 701) return "LOWER A";
    if (mana >= 601) return "HIGHER B";
    if (mana >= 501) return "LOWER B";
    if (mana >= 401) return "HIGHER C";
    if (mana >= 301) return "LOWER C";
    if (mana >= 201) return "HIGHER D";
    if (mana >= 101) return "LOWER D";
    if (mana >= 51) return "HIGHER E";
    return "LOWER E";
}

function getShortRankLabel(mana) {
    if (mana >= 901) return "S-Rank";
    if (mana >= 701) return "A-Rank";
    if (mana >= 501) return "B-Rank";
    if (mana >= 301) return "C-Rank";
    if (mana >= 101) return "D-Rank";
    return "E-Rank";
}

// --- CORE LOGIC ---
function spawnGate(room) {
    const x = Math.floor(Math.random() * 15);
    const y = Math.floor(Math.random() * 15);
    const power = Math.floor(Math.random() * 300) + 50;
    room.world[`${x}-${y}`] = { type: 'mana', color: '#00ff00', power: power };
}

function spawnSilverGate(room) {
    const x = Math.floor(Math.random() * 15);
    const y = Math.floor(Math.random() * 15);
    const power = Math.floor(Math.random() * 1001) + 500; 
    room.world[`${x}-${y}`] = { 
        type: 'silver', 
        color: '#c0c0c0', 
        power: power,
        rank: 'Silver'
    };
    io.to(room.id).emit('announcement', `WARNING: SILVER GATE MANIFESTED. POWER: ${power}`);
}

function broadcastGameState(room) { 
    const alivePlayers = room.players.filter(p => p.alive && !p.quit);
    const silverExists = Object.values(room.world).some(cell => cell.type === 'silver');

    if (alivePlayers.length === 1 && !silverExists) {
        spawnSilverGate(room);
    }

    spawnGate(room);

    const sanitizedPlayers = room.players.map(p => {
        const shortRank = getShortRankLabel(p.mana);
        return {
            ...p,
            rankLabel: shortRank,
            displayName: `${p.name} (${shortRank})` 
        };
    });
    
    io.to(room.id).emit('gameStateUpdate', { ...room, players: sanitizedPlayers }); 
}

// --- SOCKET CONNECTION ---
io.on('connection', (socket) => {
    
    socket.on('authRequest', async (data) => {
        const { type, u, p } = data;
        try {
            if (type === 'signup') {
                // FIXED: Changed 'hunters' to 'Hunters'
                const { data: existing } = await supabase.from('Hunters').select('username').eq('username', u);
                if (existing && existing.length > 0) return socket.emit('authError', "HUNTER ID ALREADY EXISTS");
                // FIXED: mana column is actually 'manapoints'
                await supabase.from('Hunters').insert([{ username: u, password: p, manapoints: 20, wins: 0, losses: 0 }]);
            }

            // FIXED: Changed 'hunters' to 'Hunters'
            const { data: users, error } = await supabase
                .from('Hunters')
                .select('*')
                .eq('username', u)
                .eq('password', p);

            if (users && users.length > 0) {
                const user = users[0];
                socket.emit('authSuccess', {
                    username: user.username,
                    mana: user.manapoints, // FIXED: column name
                    rank: getDetailedRank(user.manapoints),
                    color: '#00d2ff',
                    wins: user.wins,
                    losses: user.losses
                });
            } else {
                socket.emit('authError', "INVALID ACCESS CODE");
            }
        } catch (err) {
            socket.emit('authError', "DATABASE CONNECTION ERROR");
        }
    });

    socket.on('requestWorldRankings', async () => {
        try {
            // FIXED: Changed 'hunters' to 'Hunters' and 'mana' to 'manapoints'
            const { data: list } = await supabase
                .from('Hunters')
                .select('username, manapoints')
                .order('manapoints', { ascending: false })
                .limit(10);
            socket.emit('updateWorldRankings', list || []);
        } catch (err) {
            console.error("Rankings Fetch Failed");
        }
    });

    socket.on('handleBattle', async (data) => {
        const { roomId, playerId, gateKey } = data;
        const room = rooms[roomId];
        if (!room) return;
        const player = room.players.find(p => p.id === playerId);
        const gate = room.world[gateKey];

        if (gate && gate.type === 'silver') {
            if (player.mana >= gate.power) {
                io.to(roomId).emit('announcement', `${player.name} HAS DEFEATED THE SILVER GATE!`);
            } else {
                io.to(roomId).emit('announcement', `${player.name} FELL. ALL PLAYERS RESPAWNED!`);
                delete room.world[gateKey];
                room.players.forEach(p => { p.alive = true; p.quit = false; });
                broadcastGameState(room);
            }
        }
    });

    socket.on('sendMessage', async (data) => {
        const { roomId, message, senderName } = data;
        try {
            // FIXED: Changed 'hunters' to 'Hunters'
            const { data: users } = await supabase.from('Hunters').select('manapoints').eq('username', senderName);
            const rank = (users && users.length > 0) ? getDetailedRank(users[0].manapoints) : "E-Rank";
            if (!roomId) {
                io.emit('receiveGlobalMessage', { sender: senderName, text: message });
            } else {
                io.to(roomId).emit('receiveMessage', { sender: senderName, text: message, rank: rank });
            }
        } catch (err) {}
    });

    socket.on('disconnect', () => { console.log('Hunter disconnected'); });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`System Online on Port ${PORT}`));
