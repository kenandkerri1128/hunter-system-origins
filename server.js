// --- UPDATED RANKING HELPERS ---

// Used for the In-Game Name Board (Removes Higher/Lower)
function getShortRankLabel(mana) {
    if (mana >= 901) return "S-Rank";
    if (mana >= 701) return "A-Rank";
    if (mana >= 501) return "B-Rank";
    if (mana >= 301) return "C-Rank";
    if (mana >= 101) return "D-Rank";
    return "E-Rank";
}

// --- UPDATED CORE FUNCTIONS ---

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
        // Force update the rank label immediately on respawn
        pl.rankLabel = getShortRankLabel(pl.mana);
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

function broadcastGameState(room) { 
    const sanitizedPlayers = room.players.map(p => {
        const shortRank = getShortRankLabel(p.mana);
        return {
            ...p,
            rankLabel: shortRank,
            // We override the display name property if your frontend uses a specific field for the tag
            displayName: `${p.name} (${shortRank})` 
        };
    });
    
    const state = { ...room, players: sanitizedPlayers };
    io.to(room.id).emit('gameStateUpdate', state); 
}
