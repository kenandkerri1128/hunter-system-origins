const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');
// FIXED: Removed '-base-' from the name to match the official package
const { createClient } = require('@supabase/supabase-js'); 

// --- DATABASE CONNECTION ---
// Replace these with your actual Supabase credentials!
const supabase = createClient('YOUR_SUPABASE_URL', 'YOUR_SUPABASE_KEY');

app.use(express.static(path.join(__dirname, 'public')));

// --- GAME DATA ---
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
    
    // 1. LOGIN / SIGNUP WITH SUPABASE
    socket.on('authRequest', async (data) => {
        const { type, u, p } = data;
        
        try {
            if (type === 'signup') {
                const { data: existing } = await supabase.from('hunters').select('*').eq('username', u).single();
                if (existing) return socket.emit('authError', "HUNTER ID ALREADY EXISTS");

                await supabase.from('hunters').insert([
                    { username: u, password: p, mana: 20, wins: 0, losses: 0 }
                ]);
            }
            
            // Fetch User from Supabase
            const { data: user, error } = await supabase.from('hunters').select('*').eq('username', u).eq('password', p).single();

            if (user) {
                socket.emit('authSuccess', {
                    username: user.username,
                    mana: user.mana,
                    rank: getDetailedRank(user.mana),
                    color: '#00d2ff',
                    wins: user.wins,
                    losses: user.losses
                });
            } else {
                socket.emit('authError', "INVALID ACCESS CODE");
            }
        } catch (err) {
            console.error("Auth System Error:", err);
            socket.emit('authError', "SYSTEM OFFLINE: CHECK DATABASE CONNECTION");
        }
    });

    // 2. WORLD RANKINGS FROM SUPABASE
    socket.on('requestWorldRankings', async () => {
        try {
            const { data: rankings } = await supabase
                .from('hunters')
                .select('username, mana')
                .order('mana', { ascending: false })
                .limit(10);
                
            if (rankings) {
                socket.emit('updateWorldRankings', rankings.map(u => ({ username: u.username, manapoints: u.mana })));
            }
        } catch (err) {
            console.error("Ranking Error:", err);
        }
    });

    socket.on('sendMessage', async (data) => {
        const { roomId, message, senderName } = data;
        
        try {
            // Fetch rank dynamically for chat
            const { data: user } = await supabase.from('hunters').select('mana').eq('username', senderName).single();
            const rank = getDetailedRank(user?.mana || 0);

            if (!roomId) {
                io.emit('receiveGlobalMessage', { sender: senderName, text: message });
            } else {
                io.to(roomId).emit('receiveMessage', { sender: senderName, text: message, rank: rank });
            }
        } catch (err) {
            console.error("Chat Error:", err);
        }
    });

    socket.on('disconnect', () => { console.log('Hunter disconnected'); });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`System Online on Port ${PORT}`));
