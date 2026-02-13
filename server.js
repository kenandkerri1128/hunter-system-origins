const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createClient } = require('@supabase/supabase-js');
const path = require('path');

const app = express();
const server = http.createServer(app);

/* ✅ REQUIRED for Render */
const io = new Server(server, {
    cors: { origin: "*" }
});

// Supabase Configuration
const SUPABASE_URL = 'https://wfsuxqgvshrhqfvnkzdx.supabase.co'; 
const SUPABASE_KEY = 'sb_publishable_gV-RZMfBZ1dLU60Ht4J9iw_-sRWSKnL'; 
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

app.use(express.static(path.join(__dirname, 'public')));

let rooms = {};
const AI_NAMES = ["Sung Jinwoo", "Cha Hae-In", "Baek Yoonho", "Choi Jong-In"];
const PLAYER_COLORS = ['#00d2ff', '#ff3e3e', '#bcff00', '#ff00ff']; 
const RANK_COLORS = {
    E:'#00ff00', D:'#99ff00', C:'#ffff00',
    B:'#ff9900', A:'#ff00ff', S:'#ff0000',
    Silver:'#ffffff'
};
const POWER_UPS = ['DOUBLE DAMAGE', 'GHOST WALK', 'NETHER SWAP'];

// ================= CHAT HELPERS =================
function sendSystemChat(roomId, text) {
    io.to(roomId).emit('chatMessage', {
        user: 'SYSTEM',
        message: text
    });
}
// ===============================================

// --- RANKING HELPERS ---
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

function getSimpleRank(mana) {
    if (mana >= 901) return 'S';
    if (mana >= 701) return 'A';
    if (mana >= 501) return 'B';
    if (mana >= 301) return 'C';
    if (mana >= 101) return 'D';
    return 'E';
}

function syncAllGates() {
    const list = Object.values(rooms)
        .filter(r => r.isOnline && !r.active)
        .map(r => ({ id: r.id, name: r.name, count: r.players.length }));
    io.emit('updateGateList', list);
}

io.on('connection', (socket) => {

    /* ✅ CHAT — supports client WITHOUT changes */
    socket.on('chatMessage', (data) => {
        const room = Object.values(rooms).find(r =>
            r.players.some(p => p.id === socket.id)
        );
        if (!room) return;

        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        io.to(room.id).emit('chatMessage', {
            user: player.name,
            message: data.message
        });
    });

    socket.on('authRequest', async (data) => {
        if (data.type === 'signup') {
            const { data: existing } = await supabase
                .from('Hunters')
                .select('username')
                .eq('username', data.u)
                .maybeSingle();

            if (existing) return socket.emit('authError', "HUNTER ID ALREADY EXISTS");

            await supabase.from('Hunters').insert([
                { username: data.u, password: data.p, manapoints: 0, wins: 0, losses: 0 }
            ]);
        }

        const { data: user } = await supabase
            .from('Hunters')
            .select('*')
            .eq('username', data.u)
            .eq('password', data.p)
            .maybeSingle();

        if (user) {
            const letter = getSimpleRank(user.manapoints);
            socket.emit('authSuccess', {
                username: user.username,
                mana: user.manapoints,
                rank: getFullRankLabel(user.manapoints),
                color: RANK_COLORS[letter],
                wins: user.wins || 0,
                losses: user.losses || 0
            });
            syncAllGates();
        } else {
            socket.emit('authError', "INVALID ACCESS CODE OR ID");
        }
    });

    // 🔹 EVERYTHING ELSE BELOW REMAINS UNCHANGED 🔹
});

/* ✅ THIS LINE FIXES YOUR RENDER CRASH */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`SERVER ONLINE ON PORT ${PORT}`);
});
