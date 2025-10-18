// bot.js
require('dotenv').config();
const fs = require('fs');
// Add timestamp prefix to console output for chat/console logs
const _origConsoleLog = console.log.bind(console);
const _origConsoleWarn = console.warn.bind(console);
const _origConsoleError = console.error.bind(console);
function _ts() { return new Date().toISOString(); }
console.log = (...args) => { _origConsoleLog(`[${_ts()}]`, ...args); };
console.warn = (...args) => { _origConsoleWarn(`[${_ts()}]`, ...args); };
console.error = (...args) => { _origConsoleError(`[${_ts()}]`, ...args); };
const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

// local modules
let helpMod;
try { helpMod = require('./help'); } catch (e) { helpMod = null; }
let rpMod;
try { rpMod = require('./rp'); } catch (e) { rpMod = null; }
let gamesMod;
try { gamesMod = require('./games'); } catch (e) { gamesMod = null; }

// fetch (Node 18+ глобален; иначе ползваме node-fetch динамично)
const fetch = global.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

// Google Gemini SDK (installed as @google/generative-ai)
let GoogleGenerativeAI;
try { GoogleGenerativeAI = require('@google/generative-ai').GoogleGenerativeAI; } catch (e) { GoogleGenerativeAI = null; }
let genAI = null;
if (GoogleGenerativeAI && process.env.GEMINI_API_KEY) {
  try { genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY); } catch (e) { console.warn('Failed to init GoogleGenerativeAI:', e?.message || e); }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
});

// (ready handler is defined later in the file)
// Backfill jokes4 from historical messages in the target guild (limited)
async function backfillJokes4() {
  try {
    const gid = JOKES4_GUILD;
    const guild = client.guilds.cache.get(gid) || await client.guilds.fetch(gid).catch(() => null);
    if (!guild) return;
    // only backfill if collection small to avoid heavy work on every start
    if (jokes4.items && jokes4.items.length > 200) return;
    const chans = guild.channels.cache.filter(ch => ch.isTextBased && ch.viewable);
    for (const ch of chans.values()) {
      try {
        // fetch recent messages (limit 200 per channel)
        const msgs = await ch.messages.fetch({ limit: 200 }).catch(() => null);
        if (!msgs || !msgs.size) continue;
        for (const m of msgs.values()) {
          if (!m.content || m.author?.bot) continue;
          const text = m.content.trim();
          if (text.length < 15 || text.length > 300) continue;
          if (/https?:\/\//i.test(text)) continue;
          if (/```/.test(text)) continue;
          if ((m.mentions?.users?.size || 0) > 3) continue;
          const candidate = text.replace(/\s+/g, ' ').trim();
          if (!candidate) continue;
          if (jokes4.items.find(i => i.text === candidate)) continue;
          const id = Date.now().toString(36) + '-' + Math.floor(Math.random()*1000);
          jokes4.items.push({ id, text: candidate, addedAt: new Date().toISOString() });
        }
        // small pause to avoid rate limits
        await new Promise(r => setTimeout(r, 300));
      } catch (inner) { /* ignore per-channel errors */ }
    }
    saveJokes4();
  } catch (e) { console.warn('[backfillJokes4] error:', e?.message || e); }
}

// --- Nick/display name logging ---
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    if (oldMember.partial) oldMember = await oldMember.fetch().catch(()=>oldMember);
    if (newMember.partial) newMember = await newMember.fetch().catch(()=>newMember);

    const oldNick = oldMember.nickname ?? oldMember.user.username;
    const newNick = newMember.nickname ?? newMember.user.username;
    if (oldNick === newNick) return;

    const gid = newMember.guild.id;
    const chId = settings[gid]?.nicklogs;
    if (!chId) return;
    let ch = newMember.guild.channels.cache.get(chId);
    if (!ch) ch = await newMember.guild.channels.fetch(chId).catch(() => null);
    if (!ch) {
      console.warn(`Nicklogs: configured channel ${chId} not found in guild ${gid}`);
      return;
    }

    const emb = new EmbedBuilder()
      .setTitle('✏️ Смяна на никнейм')
      .setDescription(`${newMember} смени никнейма си`)
      .addFields(
        { name: 'Стар никнейм', value: String(oldNick), inline: true },
        { name: 'Нов никнейм', value: String(newNick), inline: true },
        { name: 'Потребител', value: `${newMember.user.tag} \`${newMember.id}\`` }
      )
      .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
      .setColor(0xFEE75C)
      .setTimestamp();

    await safeSend(ch, { embeds: [emb] });

    // record history
    try {
      const g = ensureGuildStore(gid);
      if (!g.users[newMember.id]) await ensureUser(newMember.guild, newMember.id);
      const u = g.users[newMember.id];
      if (!u.nameHistory) u.nameHistory = [];
      u.nameHistory.push({ when: new Date().toISOString(), type: 'nick', old: String(oldNick), new: String(newNick) });
      save();
    } catch (e) { console.warn('Failed to record name history (guildMemberUpdate):', e?.message); }
  } catch (err) {
    console.error('Nicklog error (guildMemberUpdate):', err);
  }
});

client.on('userUpdate', async (oldUser, newUser) => {
  try {
    const usernameChanged = oldUser.username !== newUser.username;
    const displayChanged = (oldUser.globalName ?? null) !== (newUser.globalName ?? null);
    if (!usernameChanged && !displayChanged) return;

    for (const guild of client.guilds.cache.values()) {
      const member = guild.members.cache.get(newUser.id) || await guild.members.fetch(newUser.id).catch(()=>null);
      if (!member) continue;
      const chId = settings[guild.id]?.nicklogs;
      if (!chId) continue;
  let ch = guild.channels.cache.get(chId);
  if (!ch) ch = await guild.channels.fetch(chId).catch(()=>null);
  if (!ch) continue;

      const emb = new EmbedBuilder()
        .setTitle('✏️ Смяна на име')
        .setDescription(`${member} промени своето име/потребителско име`)
        .addFields(
          ...(usernameChanged ? [
            { name: 'Стар username', value: oldUser.username || '—', inline: true },
            { name: 'Нов username', value: newUser.username || '—', inline: true }
          ] : []),
          ...(displayChanged ? [
            { name: 'Стар display name', value: oldUser.globalName || '—', inline: true },
            { name: 'Нов display name', value: newUser.globalName || '—', inline: true }
          ] : []),
          { name: 'Потребител', value: `${newUser.tag} \`${newUser.id}\`` }
        )
        .setThumbnail(newUser.displayAvatarURL({ size: 128 }))
        .setColor(0xFEE75C)
        .setTimestamp();

      await safeSend(ch, { embeds: [emb] });

      // record history for each guild member affected
      try {
        const gid = guild.id;
        const uid = newUser.id;
        const g = ensureGuildStore(gid);
        if (!g.users[uid]) await ensureUser(guild, uid);
        const u = g.users[uid];
        if (!u.nameHistory) u.nameHistory = [];
        if (usernameChanged) u.nameHistory.push({ when: new Date().toISOString(), type: 'username', old: oldUser.username || '', new: newUser.username || '' });
        if (displayChanged) u.nameHistory.push({ when: new Date().toISOString(), type: 'display', old: oldUser.globalName || '', new: newUser.globalName || '' });
        save();
      } catch (e) { console.warn('Failed to record name history (userUpdate):', e?.message); }
    }
  } catch (err) {
    console.error('Nicklog error (userUpdate):', err);
  }
});

// Collect candidate jokes from a specific guild's chat
const JOKES4_GUILD = '538350666566074389';
client.on('messageCreate', async (message) => {
  try {
    if (!message.guild) return;
    if (String(message.guild.id) !== JOKES4_GUILD) return;
    if (!message.content || message.author?.bot) return;
    const text = (message.content || '').trim();
    // ignore commands (starting with prefix) and short/long messages
    const pfx = getPrefix(message.guild.id) || DEFAULT_PREFIX;
    if (text.startsWith(pfx)) return;
    if (text.length < 15 || text.length > 300) return;
    // skip messages containing urls or code blocks
    if (/https?:\/\//i.test(text)) return;
    if (/```/.test(text)) return;
    // skip if too many mentions
    if ((message.mentions?.users?.size || 0) > 3) return;

    // normalize whitespace
    const candidate = text.replace(/\s+/g, ' ').trim();
    if (!candidate) return;
    // dedupe by exact text
    if (jokes4.items.find(i => i.text === candidate)) return;
    // store
    const id = Date.now().toString(36) + '-' + Math.floor(Math.random()*1000);
    jokes4.items.push({ id, text: candidate, addedAt: new Date().toISOString() });
    saveJokes4();
    // do not spam channel with confirmation
  } catch (e) {
    console.warn('[jokes4 listener] error:', e?.message || e);
  }
});

// Записване на дата на присъединяване
client.on('guildMemberAdd', async (member) => {
  try {
    const gid = member.guild.id;
    const uid = member.id;
    const g = ensureGuildStore(gid);
    if (!g.users[uid]) await ensureUser(member.guild, uid);
    g.users[uid].joinDate = member.joinedAt ? member.joinedAt.toISOString() : new Date().toISOString();
    // clear any previous leftAt when rejoining
    if (g.users[uid].leftAt) delete g.users[uid].leftAt;
    save();
  } catch (e) { console.warn('guildMemberAdd store update failed:', e?.message); }
});

// Записване на дата на напускане
client.on('guildMemberRemove', async (member) => {
  try {
    const gid = member.guild.id;
    const uid = member.id;
    const g = ensureGuildStore(gid);
    if (!g.users[uid]) {
      // create basic entry so we can store leftAt
      g.users[uid] = { joinDate: null, leftAt: new Date().toISOString() };
    } else {
      g.users[uid].leftAt = new Date().toISOString();
    }
    save();
  } catch (e) { console.warn('guildMemberRemove store update failed:', e?.message); }
});

const DEFAULT_PREFIX = '!';

// hangman game module
const hangmanMod = require('./hangman');

function getPrefix(gid) {
  try {
    return (settings[gid] && settings[gid].prefix) || DEFAULT_PREFIX;
  } catch (e) {
    return DEFAULT_PREFIX;
  }
}

function getPrefixForUser(gid, uid) {
  try {
    const g = settings[gid] || {};
    const personal = (g.personalPrefixes && g.personalPrefixes[uid]) || null;
    const guild = g.prefix || DEFAULT_PREFIX;
    return { personal, guild, default: DEFAULT_PREFIX };
  } catch (e) {
    return { personal: null, guild: DEFAULT_PREFIX, default: DEFAULT_PREFIX };
  }
}
const dataFile = './achievements.json'; // пер-гилд структура
const settingsFile = './settings.json';
const gifsFile = './gifs.json';
const jokes3File = './jokes3.json';
const todosFile = './todos.json';
const achAuditFile = './achsetup_audit.log';

// ====== STORE (пер-гилд) ======
//
// store[guildId] = {
//   users: {
//     [userId]: {
//       messages, mentions, activeDays{}, dailyCounts{}, joinDate,
//       achievements{}, levelCache, lastActiveISO,
//       nightOwlCount, memesCount,
//       reactionsGiven, reactionsReceived,
//       dailyMentions{}, dailyReactionsGiven{},
//       voice: { totalMs, sessionStart, sessionChannelId, inAFKMs, duetStart, lastJoinSize }
//     }
//   }
// }
let store = {};
let settings = {};
let gifs = {};
let jokes3 = {}; // structure: { [guildId]: [ { id, text, addedBy, addedAt } ] }
const jokes2File = './jokes2.json';
let jokes2 = { pool: [], used: [] }; // pool: remaining jokes, used: already shown (persisted)
const jokes4File = './jokes4.json';
let jokes4 = { items: [] }; // collected from guild chat
// in-memory challenge/game tracking: pending challenges and active games keyed by message id
const pendingChallenges = {};
// pending resets require confirmation: id -> { requesterId, message, sub, targetId, everyone, createdAt }
const pendingResets = {};
const games = {}; // active games keyed by board message id
const countingGames = {}; // active counting games keyed by channel id: { max, active, current, startedBy }
const NUMBER_EMOJIS = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣'];
// Local jokes fallback (used by !joke2 and as a fallback for !joke)
const LOCAL_JOKES = [
  'Защо програмистите мразят природата? Има твърде много bugs.',
  'Какво прави програмист през уикенда? Отстранява бъгове, които сам е създал в понеделник.',
  'Защо компютърът отиде на лекар? Имаше вирус.',
  'Как програмист казва благодаря? return true;'
];

// load jokes2 persistence (pool/used)
if (fs.existsSync(jokes2File)) {
  try { jokes2 = JSON.parse(fs.readFileSync(jokes2File, 'utf8')) || { pool: [], used: [] }; } catch (e) { jokes2 = { pool: [], used: [] }; }
} else {
  // initialize pool from LOCAL_JOKES if no file
  jokes2.pool = LOCAL_JOKES.slice();
  jokes2.used = [];
  try { fs.writeFileSync(jokes2File, JSON.stringify(jokes2, null, 2)); } catch (e) { /* ignore */ }
}
// load jokes4 persisted items
if (fs.existsSync(jokes4File)) {
  try { jokes4 = JSON.parse(fs.readFileSync(jokes4File, 'utf8')) || { items: [] }; } catch (e) { jokes4 = { items: [] }; }
} else {
  jokes4 = { items: [] };
  try { fs.writeFileSync(jokes4File, JSON.stringify(jokes4, null, 2)); } catch (e) { /* ignore */ }
}

// in-memory rate-limit for old-prefix warnings: map of `${guildId}:${userId}` -> timestamp (ms)
const lastOldPrefixWarn = {};

// render board helper
function renderBoardText(board) {
  const rows = [];
    for (let r = 0; r < 3; r++) {
    const cells = [];
    for (let c = 0; c < 3; c++) {
      const idx = r*3 + c;
      const v = board[idx];
      if (v === 'X') cells.push('❌');
      else if (v === 'O') cells.push('🔴');
      else cells.push(NUMBER_EMOJIS[idx]);
    }
    rows.push(cells.join(' '));
  }
    return rows.join('\n');
}

// helper: escape string for use in RegExp
function escapeRegExp(string) {
  return String(string).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// start a tic-tac-toe game between two user ids; returns created game object
async function startTicTacToe(channel, challengerId, opponentId) {
  const board = Array(9).fill(null);
  const turn = challengerId; // challenger starts as X
  const emb = new EmbedBuilder()
    .setTitle('🎮 Морски шах (Tic-Tac-Toe)')
    .setDescription(`Ход: <@${turn}> (❌)\n\n` + renderBoardText(board))
    .setColor(0x5865F2)
    .setTimestamp();

  const boardMsg = await channel.send({ embeds: [emb] });
  for (const e of NUMBER_EMOJIS) {
    try { await boardMsg.react(e); } catch (err) {}
  }

  games[boardMsg.id] = {
    guildId: channel.guild.id,
    channelId: channel.id,
    players: { X: challengerId, O: opponentId },
    board,
    turn,
    startedAt: new Date().toISOString(),
    boardMessageId: boardMsg.id
  };

  // If opponent is the bot, let it play if it's bot's turn (rare: challenger could be bot)
  if (games[boardMsg.id].turn === client.user.id) {
    // give a slight delay for UX
    setTimeout(() => doAIMove(boardMsg.id), 700);
  }

  return games[boardMsg.id];
}

// AI logic: choose best move (win/block/center/corner/random)
function aiChooseMove(game) {
  const board = game.board;
  const myMark = (game.players.X === client.user.id) ? 'X' : 'O';
  const oppMark = myMark === 'X' ? 'O' : 'X';
  const wins = [ [0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6] ];

  // try to win
  for (const [a,b,c] of wins) {
    const vals = [board[a], board[b], board[c]];
    const empties = [a,b,c].filter(i => !board[i]);
    const countMine = vals.filter(v => v === myMark).length;
    if (countMine === 2 && empties.length === 1) return empties[0];
  }
  // try to block
  for (const [a,b,c] of wins) {
    const vals = [board[a], board[b], board[c]];
    const empties = [a,b,c].filter(i => !board[i]);
    const countOpp = vals.filter(v => v === oppMark).length;
    if (countOpp === 2 && empties.length === 1) return empties[0];
  }
  // take center
  if (!board[4]) return 4;
  // take a corner
  const corners = [0,2,6,8].filter(i => !board[i]);
  if (corners.length) return corners[Math.floor(Math.random()*corners.length)];
  // fallback random
  const empties = board.map((v,i)=>v?null:i).filter(i=>i!==null);
  if (empties.length) return empties[Math.floor(Math.random()*empties.length)];
  return -1;
}

// Execute AI move for given board message id
async function doAIMove(boardMessageId) {
  const game = games[boardMessageId];
  if (!game) return;
  if (game.turn !== client.user.id) return;
  const channel = await client.channels.fetch(game.channelId).catch(()=>null);
  if (!channel) { delete games[boardMessageId]; return; }
  const boardMsg = await channel.messages.fetch(boardMessageId).catch(()=>null);
  if (!boardMsg) { delete games[boardMessageId]; return; }

  const idx = aiChooseMove(game);
  if (idx < 0) return;
  const mark = (game.players.X === client.user.id) ? 'X' : 'O';
  if (game.board[idx]) return; // already taken
  game.board[idx] = mark;
  // switch turn
  game.turn = (game.turn === game.players.X) ? game.players.O : game.players.X;

  // check win/draw
  const wins = [ [0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6] ];
  let winner = null;
  for (const [a,b,c] of wins) {
    if (game.board[a] && game.board[a] === game.board[b] && game.board[a] === game.board[c]) { winner = game.board[a]; break; }
  }
  const isDraw = !winner && game.board.every(cell => cell !== null);

  const desc = winner ? `Победител: ${winner === 'X' ? `<@${game.players.X}> (❌)` : `<@${game.players.O}> (🔴)`}` : isDraw ? 'Равенство!' : `Ход: <@${game.turn}> (${game.turn === game.players.X ? '❌' : '🔴'})`;
  const newEmb = new EmbedBuilder()
    .setTitle('🎮 Морски шах (Tic-Tac-Toe)')
    .setDescription(desc + '\n\n' + renderBoardText(game.board))
    .setColor(winner ? 0x57F287 : 0x5865F2)
    .setTimestamp();
  await boardMsg.edit({ embeds: [newEmb] }).catch(()=>{});

  if (winner || isDraw) {
    try { await boardMsg.reactions.removeAll().catch(()=>{}); } catch (e) {}
    delete games[boardMessageId];
    return;
  }

  // if bot still has next turn (shouldn't happen often), schedule another move
  if (game.turn === client.user.id) setTimeout(() => doAIMove(boardMessageId), 600);
}

if (fs.existsSync(dataFile)) {
  try { store = JSON.parse(fs.readFileSync(dataFile, 'utf8')); } catch { store = {}; }
}
if (fs.existsSync(settingsFile)) {
  try { settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch { settings = {}; }
}
if (fs.existsSync(gifsFile)) {
  try { gifs = JSON.parse(fs.readFileSync(gifsFile, 'utf8')); } catch { gifs = {}; }
} else {
  gifs = {};
  fs.writeFileSync(gifsFile, JSON.stringify(gifs, null, 2));
}

if (fs.existsSync(jokes3File)) {
  try { jokes3 = JSON.parse(fs.readFileSync(jokes3File, 'utf8')); } catch { jokes3 = {}; }
} else {
  jokes3 = {};
  try { fs.writeFileSync(jokes3File, JSON.stringify(jokes3, null, 2)); } catch (e) { /* ignore */ }
}

// --- todos persistence (separate lightweight file to ensure durability) ---
function saveTodos() {
  try {
    const minimal = {};
    for (const gid of Object.keys(store || {})) {
      const g = store[gid];
      if (!g || !g.users) continue;
      for (const uid of Object.keys(g.users)) {
        const u = g.users[uid] || {};
        if ((u.todos && u.todos.length) || (u.doneTodos && u.doneTodos.length)) {
          if (!minimal[gid]) minimal[gid] = {};
          minimal[gid][uid] = { todos: u.todos || [], doneTodos: u.doneTodos || [] };
        }
      }
    }
    atomicWrite(todosFile, minimal);
  } catch (e) { console.error('saveTodos failed:', e); }
}

function loadTodos() {
  try {
    if (!fs.existsSync(todosFile)) return;
    const data = JSON.parse(fs.readFileSync(todosFile, 'utf8')) || {};
    for (const gid of Object.keys(data)) {
      const g = ensureGuildStore(gid);
      for (const uid of Object.keys(data[gid] || {})) {
        const udata = data[gid][uid] || {};
        if (!g.users[uid]) g.users[uid] = {};
        if (udata.todos) g.users[uid].todos = udata.todos;
        if (udata.doneTodos) g.users[uid].doneTodos = udata.doneTodos;
      }
    }
  } catch (e) { console.error('loadTodos failed:', e); }
}

// load persisted todos into store
loadTodos();

function atomicWrite(filePath, obj) {
  // fsync-backed atomic write: write to a tmp file, flush to disk, then rename.
  const tmp = filePath + '.tmp';
  const data = Buffer.from(JSON.stringify(obj, null, 2), 'utf8');
  try {
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeSync(fd, data, 0, data.length, 0);
      // flush to disk
      try { fs.fsyncSync(fd); } catch (e) { /* ignore fsync failures on some platforms */ }
    } finally {
      try { fs.closeSync(fd); } catch (e) { }
    }
    try {
      fs.renameSync(tmp, filePath);
    } catch (e) {
      // fallback: try to write directly
      try { fs.writeFileSync(filePath, data, 'utf8'); } catch (e2) { /* ignore */ }
    }
  } catch (err) {
    // as a last resort, attempt a synchronous direct write
    try { fs.writeFileSync(filePath, data, 'utf8'); } catch (e) { console.error('atomicWrite failed:', e); }
  }
}

const save = () => {
  try { atomicWrite(dataFile, store); } catch (e) { console.error('save failed:', e); }
};
const saveSettings = () => {
  try { atomicWrite(settingsFile, settings); } catch (e) { console.error('saveSettings failed:', e); }
};
const saveGifs = () => {
  try { atomicWrite(gifsFile, gifs); } catch (e) { console.error('saveGifs failed:', e); }
};
const saveJokes3 = () => {
  try { atomicWrite(jokes3File, jokes3); } catch (e) { console.error('saveJokes3 failed:', e); }
};
const saveJokes2 = () => {
  try { atomicWrite(jokes2File, jokes2); } catch (e) { console.error('saveJokes2 failed:', e); }
};
const saveJokes4 = () => {
  try { atomicWrite(jokes4File, jokes4); } catch (e) { console.error('saveJokes4 failed:', e); }
};

function ensureGuildStore(gid) {
  if (!store[gid]) store[gid] = { users: {} };
  return store[gid];
}
async function ensureUser(guild, userId) {
  const g = ensureGuildStore(guild.id);
  if (!g.users[userId]) {
    const member = await guild.members.fetch(userId).catch(() => null);
    g.users[userId] = {
      messages: 0,
      mentions: 0,
        todos: [],
      dragonEggs: 0,
      lastClaims: { daily: null, weekly: null, monthlyegg: null },
      activeDays: {},
      dailyCounts: {},
      dailyMentions: {},
      dailyReactionsGiven: {},
      joinDate: member?.joinedAt ? member.joinedAt.toISOString() : new Date().toISOString(),
      lastActiveISO: new Date().toISOString(),
      achievements: {},
      levelCache: 0,
      nightOwlCount: 0,
      memesCount: 0,
      reactionsGiven: 0,
      reactionsReceived: 0,
      voice: { totalMs: 0, sessionStart: null, sessionChannelId: null, inAFKMs: 0, duetStart: null, lastJoinSize: 0 }
    };
  } else {
    const u = g.users[userId];
    if (!u.todos) u.todos = [];
    if (!u.dailyCounts) u.dailyCounts = {};
    if (!u.dailyMentions) u.dailyMentions = {};
    if (!u.dailyReactionsGiven) u.dailyReactionsGiven = {};
    if (!u.voice) u.voice = { totalMs: 0, sessionStart: null, sessionChannelId: null, inAFKMs: 0, duetStart: null, lastJoinSize: 0 };
    if (!u.lastActiveISO) u.lastActiveISO = new Date().toISOString();
    if (typeof u.levelCache !== 'number') u.levelCache = 0;
    if (typeof u.nightOwlCount !== 'number') u.nightOwlCount = 0;
    if (typeof u.memesCount !== 'number') u.memesCount = 0;
    if (typeof u.reactionsGiven !== 'number') u.reactionsGiven = 0;
    if (typeof u.reactionsReceived !== 'number') u.reactionsReceived = 0;
  }
  return g.users[userId];
}

function ensureGuildSettings(gid) {
  if (!settings[gid]) settings[gid] = {};
  if (!settings[gid].achRoles) settings[gid].achRoles = {};
  if (!settings[gid].socialLinks) settings[gid].socialLinks = []; // допълнителни социалки за !rijkuuu
  // default number range for !n command
  if (!settings[gid].numberRange) settings[gid].numberRange = { min: 1, max: 100 };
  // default prefix
  if (!settings[gid].prefix) settings[gid].prefix = DEFAULT_PREFIX;
  // keep history of recent prefixes to help users who use the old one
  if (!settings[gid].prevPrefixes) settings[gid].prevPrefixes = [];
  // store a single oldPrefix for simple detection (compatibility with simpler setups)
  if (!settings[gid].oldPrefix) settings[gid].oldPrefix = settings[gid].prefix || DEFAULT_PREFIX;
  if (!settings[gid].personalPrefixes) settings[gid].personalPrefixes = {};
  return settings[gid];
}
function saveGuildSettings(gid, gset) {
  settings[gid] = gset;
  try {
    // backup previous settings file, then use atomicWrite so data is fsynced where possible
    try { backupJsonFile(settingsFile); } catch (e) {}
    atomicWrite(settingsFile, settings);
    // reload settings to avoid races with other writers
    try {
      const raw = fs.readFileSync(settingsFile, 'utf8');
      settings = JSON.parse(raw || '{}');
    } catch (e) {
      console.warn('saveGuildSettings: failed to reload settings:', e?.message || e);
    }
  } catch (err) {
    console.error('Error saving settings:', err);
  }
}

// create backups folder if missing
const os = require('os');
const path = require('path');
// file for storing deleted messages captured from source server
const deletedMessagesFile = path.join(process.cwd(), 'deletedMessages.json');
let deletedMessages = {};
// news persistence for owner changelog
const newsFile = path.join(process.cwd(), 'news.json');
let news = [];

function ensureBackupsFolder() {
  try {
    const envDir = process.env.BACKUP_DIR && String(process.env.BACKUP_DIR).trim();
    // prefer a project-local backups folder so developers can see backups in the repo workspace
    const projectLocal = path.join(process.cwd(), 'feelsgoodgaming_backups');
    const dir = envDir || (fs.existsSync(projectLocal) ? projectLocal : projectLocal);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
  } catch (e) { console.warn('ensureBackupsFolder failed:', e?.message); return null; }
}

// make a timestamped backup of a JSON file (safe): filePath -> backups/filename.YYYYMMDDHHmmss.bak
function backupJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const dir = ensureBackupsFolder(); if (!dir) return null;
    const base = path.basename(filePath);
    const ts = new Date().toISOString().replace(/[:.-]/g,'').slice(0,15);
    const dest = path.join(dir, `${base}.${ts}.bak`);
    fs.copyFileSync(filePath, dest);
    return dest;
  } catch (e) { console.warn('backupJsonFile failed for', filePath, e?.message); return null; }
}

// Create a timestamped snapshot of the project folder (recursively copy), excluding some dirs
function createProjectSnapshot() {
  // Snapshot feature intentionally disabled to avoid duplicating the whole project.
  // Returning null keeps callers safe and prevents creating snapshots.
  return null;
}

// load deletedMessages and other persisted files on startup
function loadJsonIfExists(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw || 'null') || fallback;
  } catch (e) { console.warn('loadJsonIfExists failed for', filePath, e?.message); return fallback; }
}

function loadAllSaved() {
  try {
    // load deleted messages
    deletedMessages = loadJsonIfExists(deletedMessagesFile, {});
    // load news
    news = loadJsonIfExists(newsFile, []);
    // load other app-specific files if needed (dataFile/settingsFile/gifsFile etc.)
    try { if (typeof settingsFile !== 'undefined' && fs.existsSync(settingsFile)) settings = JSON.parse(fs.readFileSync(settingsFile,'utf8')||'{}'); } catch (e) { console.warn('Failed to load settings:', e?.message); }
    try { if (typeof dataFile !== 'undefined' && fs.existsSync(dataFile)) store = JSON.parse(fs.readFileSync(dataFile,'utf8')||'{}'); } catch (e) { console.warn('Failed to load store:', e?.message); }
    try { if (typeof gifsFile !== 'undefined' && fs.existsSync(gifsFile)) gifs = JSON.parse(fs.readFileSync(gifsFile,'utf8')||'{}'); } catch (e) { console.warn('Failed to load gifs:', e?.message); }
    console.log('[startup] loaded persisted data');
  } catch (e) { console.error('[startup] loadAllSaved failed:', e); }
}

function persistNews() {
  try { fs.writeFileSync(newsFile, JSON.stringify(news, null, 2), 'utf8'); } catch (e) { console.warn('persistNews failed:', e?.message); }
}

// Малко форматиране на дати: dd.MM.yyyy HH:mm
function pad(n){return n<10?('0'+n):String(n);} 
function formatDateIso(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    if (isNaN(d)) return String(iso);
    return `${pad(d.getDate())}.${pad(d.getMonth()+1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  } catch (e) { return String(iso); }
}

// Audit append for achsetup changes
function appendAchAudit(entry) {
  try {
    const line = JSON.stringify(entry) + '\n';
    fs.appendFileSync(achAuditFile, line, 'utf8');
  } catch (e) {
    console.warn('Failed to write ach audit:', e?.message);
  }
}

// Autosave: interval in minutes (env or default 300 = 5 hours). Override with AUTOSAVE_MIN env var.
const AUTOSAVE_MIN = parseInt(process.env.AUTOSAVE_MIN || '300', 10) || 300;

// Rotate backups for a given base filename: keep only the newest `keep` files, delete older ones.
function rotateBackupsForFile(filePath, keep) {
  try {
    const dir = ensureBackupsFolder(); if (!dir) return;
    const base = path.basename(filePath);
    const files = fs.readdirSync(dir).filter(f => f.startsWith(base + '.') && f.endsWith('.bak'));
    if (files.length <= keep) return;
    // map to full paths and stat for mtime
    const mapped = files.map(f => {
      const p = path.join(dir, f);
      let stat = null;
      try { stat = fs.statSync(p); } catch (e) { stat = { mtimeMs: 0 }; }
      return { file: p, mtime: stat.mtimeMs || 0 };
    });
    // sort by mtime desc (newest first)
    mapped.sort((a,b) => b.mtime - a.mtime);
    const toDelete = mapped.slice(keep);
    for (const d of toDelete) {
      try { fs.unlinkSync(d.file); } catch (e) { /* ignore */ }
    }
  } catch (e) { console.warn('rotateBackupsForFile failed:', e?.message || e); }
}
let autosaveTimer = null;
function startAutosave() {
  if (autosaveTimer) clearInterval(autosaveTimer);
  autosaveTimer = setInterval(() => {
    try {
      console.log(`[autosave] saving data at ${new Date().toISOString()}`);
      // core saves
      saveSettings(); save(); saveGifs();
      // also persist additional collections requested: jokes2/jokes3/jokes4 and todos
      try { saveJokes2(); } catch (e) { console.warn('[autosave] saveJokes2 failed:', e?.message || e); }
      try { saveJokes3(); } catch (e) { console.warn('[autosave] saveJokes3 failed:', e?.message || e); }
      try { saveJokes4(); } catch (e) { console.warn('[autosave] saveJokes4 failed:', e?.message || e); }
      try { saveTodos(); } catch (e) { console.warn('[autosave] saveTodos failed:', e?.message || e); }
      // create timestamped backups for key JSON files on each autosave
      try {
        const backupsCreated = [];
        const filesToBackup = [
          typeof dataFile !== 'undefined' ? dataFile : null,
          typeof settingsFile !== 'undefined' ? settingsFile : null,
          typeof gifsFile !== 'undefined' ? gifsFile : null,
          typeof jokes3File !== 'undefined' ? jokes3File : null,
          typeof jokes2File !== 'undefined' ? jokes2File : null,
          typeof jokes4File !== 'undefined' ? jokes4File : null,
          typeof todosFile !== 'undefined' ? todosFile : null
        ].filter(Boolean);
        for (const f of filesToBackup) {
          try {
            const dest = backupJsonFile(f);
            if (dest) backupsCreated.push(dest);
          } catch (e) { /* ignore individual backup failures */ }
        }
        if (backupsCreated.length) {
          console.log(`[autosave] created ${backupsCreated.length} backups`);
          try {
            const keep = parseInt(process.env.AUTOSAVE_KEEP_BACKUPS || '30', 10) || 30;
            for (const f of filesToBackup) rotateBackupsForFile(f, keep);
          } catch (e) { console.warn('[autosave] rotate backups failed:', e?.message || e); }
        }
      } catch (e) { console.warn('[autosave] backup step failed:', e?.message || e); }
    } catch (e) { console.error('[autosave] failed:', e); }
  }, AUTOSAVE_MIN * 60 * 1000);
}
// start autosave when client is ready
client.once('ready', () => {
  try { loadAllSaved(); } catch (e) {}
  try { startAutosave(); } catch (e) {}
});

// persist deleted messages to disk
function persistDeletedMessages() {
  try { fs.writeFileSync(deletedMessagesFile, JSON.stringify(deletedMessages, null, 2), 'utf8'); } catch (e) { console.warn('persistDeletedMessages failed:', e?.message); }
}

// Capture deleted messages from source server only
const SOURCE_SERVER = '538350666566074389';
const DEST_SERVER = '682340094278893674';
client.on('messageDelete', (msg) => {
  try {
    if (!msg.guild || msg.guild.id !== SOURCE_SERVER) return;
    const gid = msg.guild.id;
    if (!deletedMessages[gid]) deletedMessages[gid] = [];
    deletedMessages[gid].unshift({ id: msg.id, author: { id: msg.author?.id, tag: msg.author?.tag }, content: msg.content, timestamp: new Date().toISOString(), channelId: msg.channelId });
    // keep only last 100 per guild to limit size
    if (deletedMessages[gid].length > 100) deletedMessages[gid].pop();
    persistDeletedMessages();
  } catch (e) { console.warn('messageDelete handler failed:', e?.message); }
});

function setGuildChannel(gid, key, channelId) { ensureGuildSettings(gid)[key] = channelId; saveSettings(); }
function getGuildChannel(guild, key, envFallbackKey) {
  const gid = guild.id;
  const id = (settings[gid] && settings[gid][key]) || process.env[envFallbackKey];
  return id ? guild.channels.cache.get(id) || null : null;
}

// ====== UTIL ======
const daysBetween = (iso) => Math.floor((new Date() - new Date(iso)) / (1000*60*60*24));
function botCan(channel, perm) {
  const me = channel.guild?.members.me;
  if (!me) return true;
  const perms = channel.permissionsFor(me);
  if (!perms) return true;
  return perms.has(perm);
}
async function sendEmbedOrText(channel, embed, plainText) {
  try {
    if (!botCan(channel, PermissionsBitField.Flags.SendMessages)) throw new Error('NO_SEND_PERMISSION');
    if (!botCan(channel, PermissionsBitField.Flags.EmbedLinks)) return await channel.send(plainText);
    return await channel.send({ embeds: [embed] });
  } catch (err) {
    try { return await channel.send(plainText); }
    catch (e2) {
      try {
        const owner = await channel.guild.fetchOwner();
        await owner.send(`❗ Не мога да пиша в <#${channel.id}>: ${e2.message}`).catch(() => {});
      } catch {}
      return null;
    }
  }
}
async function safeSend(channel, payload) {
  try {
    if (!botCan(channel, PermissionsBitField.Flags.SendMessages)) throw new Error('NO_SEND_PERMISSION');
    return await channel.send(payload);
  } catch (err) {
    try {
      const owner = await channel.guild.fetchOwner().catch(() => null);
      owner && await owner.send(`❗ Не мога да пиша в <#${channel.id}>: ${err.message}`).catch(() => {});
    } catch {}
    return null;
  }
}

// ====== ACH LABELS ======
const ACH = {
  messages10: '🗨️ Бъбривец I (10+ съобщ.)',
    veteran30d: '⌛ Старо куче (30+ дни)',
  lvl1: '🎯 Първи стъпки (Ниво 1)',
  lvl5: '🆙 Новобранец (Ниво 5)',
  lvl10: '🏅 Опитен (Ниво 10)',
  lvl25: '🥇 Гуру (Ниво 25)',
  lvl50: '🏆 Легенда (Ниво 50)',
  lvl100: '👑 Легенда+ (Ниво 100)',
  nightOwl: '🦉 Нощна птица (100 съобщ. 00–06ч)',
  marathon: '🏃 Маратонец (1000/7 дни)',
  philosopher: '🤔 Философ (50 реакции на твои съобщ.)',
  memelord: '😂 Меме лорд (100 картинки)',
  v_first: '🎙️ Първа дума (10 мин. глас)',
  v_talker: '🗣️ Събеседник (5 ч. глас)',
  v_long: '⏱️ Дълъг разговор (3+ ч. сесия)',
  v_party: '🎉 Парти животно (10+ в канала)',
  v_duet: '🎤 Дует (30 мин. 1-на-1)',
  v_afk: '😴 Капитан AFK (1 ч. в AFK)',
  reactor500: '⚡ Реактор (500 реакции поставени)',
  firstMsg: '👋 Хей, има ли някой? (1-во съобщ.)',
  firstReact: '✅ Реактор (1-ва реакция)',
  firstVoice: '🎧 Слушател (влез в гласов канал веднъж)',
  social10: '🧑‍🤝‍🧑 Социален (споменат от 10 различни)',
  veteran1y: '🎖️ Ветеран (1 година в сървъра)'
};

// ====== LEVELING ======
function computeLevel(u) { // просто и прозрачно: 1 лв / 20 съобщения
  const lvl = Math.floor((u.messages || 0) / 20);
  return lvl;
}

// ====== ACH CHECK & ROLES ======
// rate-limit warnings to guild owners about role assignment problems
const achRoleWarns = {}; // guildId -> timestamp

async function maybeAssignAchievementRoles(guild, userId, unlockedKeys) {
  const gset = ensureGuildSettings(guild.id);
  const achRoles = gset.achRoles || {};
  if (!unlockedKeys?.length) return;

  const me = guild.members.me;
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    try {
      const last = achRoleWarns[guild.id] || 0;
      if (Date.now() - last > 60*60*1000) { // once per hour
        achRoleWarns[guild.id] = Date.now();
        const owner = await guild.fetchOwner().catch(()=>null);
        const msg = `⚠️ Не мога да присвоя роли за постижения в сървъра "${guild.name}" (липсва право **Manage Roles**). Моля да разрешите правата или да ми дадете роля с позиция над ролите за постижения.`;
        if (owner) { owner.send(msg).catch(()=>{}); }
        console.warn('[achroles] missing ManageRoles for guild', guild.id);
      }
    } catch (e) { console.warn('achroles warn failed:', e?.message); }
    return;
  }

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  for (const key of unlockedKeys) {
    const roleId = achRoles[key];
    if (!roleId) continue;
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    if (me.roles.highest.position <= role.position) {
      try {
        const last = achRoleWarns[guild.id] || 0;
        if (Date.now() - last > 60*60*1000) {
          achRoleWarns[guild.id] = Date.now();
          const owner = await guild.fetchOwner().catch(()=>null);
          const msg = `⚠️ Не мога да управлявам ролята **${role.name}** (ID: ${role.id}) защото тя е с позиция по-висока или равна на моята роля. Моля преместете моята роля над тази роля или използвайте роля с по-ниска позиция.`;
          if (owner) owner.send(msg).catch(()=>{});
          console.warn('[achroles] bot role lower than achievement role', guild.id, role.id);
        }
      } catch (e) { console.warn('achroles owner notify failed:', e?.message); }
      continue;
    }
    if (!member.roles.cache.has(role.id)) {
      try {
        await member.roles.add(role);
        console.log(`[achroles] Assigned role ${role.id} to user ${userId} in guild ${guild.id} for key ${key}`);
      } catch (e) {
        console.warn(`[achroles] Failed to assign role ${role.id} to ${userId} in guild ${guild.id}:`, e?.message || e);
        try {
          const owner = await guild.fetchOwner().catch(()=>null);
          if (owner) owner.send(`❗ Не успях да присвоя роля ${role.name} (ID: ${role.id}) на потребител <@${userId}>. Грешка: ${e?.message || e}`).catch(()=>{});
        } catch (ee) {}
      }
    }
  }
}

async function announceAchievements(channel, userId, keys) {
  if (!keys.length) return;
  const names = keys.map(k => ACH[k] || k);
  const achCh = getGuildChannel(channel.guild, 'achievements', 'ACHIEVEMENT_CHANNEL_ID') || channel;
  await safeSend(achCh, `🎉 <@${userId}> отключи постижение: **${names.join('**, **')}**!`);
}

async function checkAchievements(guild, userId, channel) {
  const u = store[guild.id]?.users?.[userId];
  if (!u) return [];
  const newly = [];

  // fetch member & guild achievement role mapping so we can avoid double-awarding when role already present
  const member = await guild.members.fetch(userId).catch(()=>null);
  const gset = ensureGuildSettings(guild.id);
  const achRoles = gset.achRoles || {};

  // helper: mark achievement in store; if user already has the configured role, silently mark and persist but do NOT announce/assign
  let silentMarked = false;
  async function markAchievement(key) {
    if (u.achievements[key]) return false; // already marked
    u.achievements[key] = true;
    // if role is configured and member already has it, mark silently (no announce, no role add)
    const rid = achRoles[key];
    if (rid && member && member.roles.cache.has(rid)) {
      silentMarked = true;
      return false;
    }
    return true; // should announce + assign
  }

  // базови
  if (u.messages >= 10 && !u.achievements.messages10) { if (await markAchievement('messages10')) newly.push('messages10'); }
  if (daysBetween(u.joinDate) >= 30 && !u.achievements.veteran30d) { if (await markAchievement('veteran30d')) newly.push('veteran30d'); }
  if (daysBetween(u.joinDate) >= 365 && !u.achievements.veteran1y) { if (await markAchievement('veteran1y')) newly.push('veteran1y'); }

  // първото съобщение
  if (u.messages >= 1 && !u.achievements.firstMsg) { if (await markAchievement('firstMsg')) newly.push('firstMsg'); }

  // нива
  u.levelCache = computeLevel(u);
  const lvl = u.levelCache;
  const lvlKeys = [
    [1,'lvl1'], [5,'lvl5'], [10,'lvl10'], [25,'lvl25'], [50,'lvl50'], [100,'lvl100']
  ];
  for (const [th, key] of lvlKeys) if (lvl >= th && !u.achievements[key]) { if (await markAchievement(key)) newly.push(key); }

  // нощна птица
  if (u.nightOwlCount >= 100 && !u.achievements.nightOwl) { if (await markAchievement('nightOwl')) newly.push('nightOwl'); }

  // маратонец (сума за последните 7 дни)
  const today = new Date();
  let last7 = 0;
  for (let i=0;i<7;i++) {
    const d = new Date(today); d.setDate(today.getDate()-i);
    const key = d.toISOString().split('T')[0];
    last7 += u.dailyCounts[key] || 0;
  }
  if (last7 >= 1000 && !u.achievements.marathon) { if (await markAchievement('marathon')) newly.push('marathon'); }

  // философ (50 получени реакции)
  if (u.reactionsReceived >= 50 && !u.achievements.philosopher) { if (await markAchievement('philosopher')) newly.push('philosopher'); }

  // меме лорд (100 картинки)
  if (u.memesCount >= 100 && !u.achievements.memelord) { if (await markAchievement('memelord')) newly.push('memelord'); }

  // реактор 1-ва и 500
  if (u.reactionsGiven >= 1 && !u.achievements.firstReact) { if (await markAchievement('firstReact')) newly.push('firstReact'); }
  if (u.reactionsGiven >= 500 && !u.achievements.reactor500) { if (await markAchievement('reactor500')) newly.push('reactor500'); }

  // социален – споменат от 10 различни човека (ще поддържаме set)
  if (!u.mentionedBy) u.mentionedBy = {}; // { otherUserId: true }
  if (Object.keys(u.mentionedBy).length >= 10 && !u.achievements.social10) { if (await markAchievement('social10')) newly.push('social10'); }

  // гласови
  const v = u.voice || {};
  const minutes = Math.floor((v.totalMs || 0)/60000);
  if (minutes >= 10 && !u.achievements.v_first) { if (await markAchievement('v_first')) newly.push('v_first'); }
  if (minutes >= 300 && !u.achievements.v_talker) { if (await markAchievement('v_talker')) newly.push('v_talker'); }
  if (v.hadLongSession && !u.achievements.v_long) { if (await markAchievement('v_long')) newly.push('v_long'); }
  if (v.hadParty && !u.achievements.v_party) { if (await markAchievement('v_party')) newly.push('v_party'); }
  if (v.hadDuet && !u.achievements.v_duet) { if (await markAchievement('v_duet')) newly.push('v_duet'); }
  if ((v.inAFKMs || 0) >= 60*60000 && !u.achievements.v_afk) { if (await markAchievement('v_afk')) newly.push('v_afk'); }

  if (newly.length || silentMarked) {
    // persist any newly unlocked achievements (either announced or silently marked because the role already existed)
    save();
    if (newly.length) {
      await announceAchievements(channel, userId, newly);
      await maybeAssignAchievementRoles(guild, userId, newly);
    }
  }
  return newly;
}

// ====== GIF-и (скъсен блок – логика запазена) ======
const GIPHY_KEY = process.env.GIPHY_API_KEY || null;
const GIF_QUERIES = {
  kill:['anime dramatic kill','fatality'],
  pat:['anime headpat','pat on head'],
  slap:['anime slap','slap meme'],
  hug:['anime hug','wholesome hug'],
  kiss:['anime kiss','kiss gif'],
  shakehands:['handshake','agreement handshake'],
  wave:['anime wave','wave hi'],
  yay:['celebration yay'],
  run:['anime running'],
  lay:['lying down tired'],
  attack:['sword attack anime'],
  deffense:['block shield'],
  cry:['anime crying'],
  sad:['sad anime'],
  happy:['happy anime'],
  angry:['angry anime'],
  poke:['poke someone'],
  drink:['cheers drink'],
  hungry:['hungry anime'],
  marry:['wedding kiss'],
  divorce:['break up sad'],
  cheers:['cheers toast'],
  eat:['anime eating'],
  stare:['intense stare'],
  cringe:['cringe reaction'],
  give:['give gift'],
  highfive:['high five'],
  laugh:['anime laugh'],
  fight:['anime fight'],
  money:['make it rain money'],
  fly:['flying anime'],
  jump:['anime jump'],
  // whiskey
  drink_whiskey:['whiskey drink','whiskey cheers','whisky toast'],
  sell:['auction sold'],
  buy:['buy purchase'],
  sell1:['sell item']
};
const RP_GIFS_FALLBACK = {
  hug:['https://media.giphy.com/media/od5H3PmEG5EVq/giphy.gif']
};
const pick = arr => arr[Math.floor(Math.random()*arr.length)];
async function fetchGifFromGiphy(q){
  if (!GIPHY_KEY) return null;
  const url=`https://api.giphy.com/v1/gifs/search?api_key=${encodeURIComponent(GIPHY_KEY)}&q=${encodeURIComponent(q)}&limit=25&rating=pg-13&lang=en&bundle=messaging_non_clips`;
  try{const r=await fetch(url); if(!r.ok)return null; const d=await r.json(); const res=d?.data||[]; if(!res.length)return null; const img=pick(res).images||{}; return img.original?.url||img.downsized_medium?.url||img.downsized?.url||null;}catch{return null;}
}
function getCustomGif(type){
  try {
    const arr = gifs && gifs[type];
    if (!Array.isArray(arr) || !arr.length) return null;
    // filter only string http(s) URLs to avoid bad entries
    const ok = arr.filter(x => typeof x === 'string' && /^https?:\/\//i.test(x));
    if (!ok.length) return null;
    return pick(ok);
  } catch (e) { return null; }
}
// normalize admin-provided gif type aliases to canonical gif keys
function normalizeGifType(input) {
  if (!input) return input;
  const t = String(input).toLowerCase().trim();
  const map = {
    // coffee
    'coffee': 'drink_coffee', 'coffe': 'drink_coffee', 'кафе': 'drink_coffee', 'drink_coffee': 'drink_coffee',
    // beer
    'beer': 'drink_beer', 'бира': 'drink_beer', 'пиво': 'drink_beer', 'drink_beer': 'drink_beer',
    // tea
    'tea': 'drink_tea', 'чай': 'drink_tea', 'drink_tea': 'drink_tea',
    // water
    'water': 'drink_water', 'вода': 'drink_water', 'watter': 'drink_water', 'drink_water': 'drink_water',
    // vodka
    'vodka': 'drink_vodka', 'водка': 'drink_vodka', 'drink_vodka': 'drink_vodka',
    // cola / soda
    'cola': 'drink_cola', 'кола': 'drink_cola', 'drink_cola': 'drink_cola',
    'soda': 'drink_soda', 'сода': 'drink_soda', 'drink_soda': 'drink_soda'
      ,
      // whiskey
      'whiskey': 'drink_whiskey', 'whisky': 'drink_whiskey', 'уиски': 'drink_whiskey', 'drink_whiskey': 'drink_whiskey'
  };
  return map[t] || t;
}
async function getGifUrlFor(type){
  const cur=getCustomGif(type); if (cur) return cur;
  for (const q of (GIF_QUERIES[type]||[])){ const u=await fetchGifFromGiphy(q); if(u) return u; }
  const fb=RP_GIFS_FALLBACK[type]; return fb?pick(fb):null;
}
async function sendRPDynamic(channel, description, type) {
  const url = await getGifUrlFor(type);
  const embed = new EmbedBuilder().setDescription(description).setColor(0xEB459E);
  if (url) embed.setImage(url);
  const plain = url ? `${description}\n${url}` : description;
  return sendEmbedOrText(channel, embed, plain);
}

// ====== READY ======
client.once('ready', async () => {
  console.log(`🤘 Ботът ${client.user.tag} е онлайн и готов да троши!`);
  try {
    // set a presence/activity with the welcome text and invite link
    const text = 'Welcome to FeelsGoodGaming https://discord.gg/cw3gn47NfE';
    // use setActivity for compatibility across discord.js versions
    await client.user.setActivity(text, { type: 'PLAYING' });
    // also ensure status is online
    await client.user.setStatus?.('online');
  } catch (e) {
    console.warn('Failed to set bot presence:', e?.message || e);
  }
  // backfill historical messages for jokes4 (limited)
  try { await backfillJokes4(); } catch (e) { console.warn('backfillJokes4 failed:', e?.message || e); }
});
client.on('error', e => console.warn('Client error:', e?.message));
process.on('unhandledRejection', r => console.warn('Unhandled rejection:', r));

// Graceful shutdown: ensure data is flushed to disk on exit/crash
function persistAll(reason) {
  try {
    console.log('Persisting data before exit:', reason || 'shutdown');
    // clear autosave interval if running
    try { if (autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; } } catch (e) {}
    try { backupJsonFile(dataFile); } catch (e) {}
    try { atomicWrite(dataFile, store); } catch (e) { console.error('persist store failed:', e); }
    try { backupJsonFile(settingsFile); } catch (e) {}
    try { atomicWrite(settingsFile, settings); } catch (e) { console.error('persist settings failed:', e); }
    try { backupJsonFile(gifsFile); } catch (e) {}
    try { atomicWrite(gifsFile, gifs); } catch (e) { console.error('persist gifs failed:', e); }
    try { atomicWrite(jokes3File, jokes3); } catch (e) { console.error('persist jokes3 failed:', e); }
    try { atomicWrite(jokes2File, jokes2); } catch (e) { console.error('persist jokes2 failed:', e); }
    try { atomicWrite(jokes4File, jokes4); } catch (e) { console.error('persist jokes4 failed:', e); }
  } catch (e) { console.error('persistAll error:', e); }
}

process.on('SIGINT', () => { persistAll('SIGINT'); process.exit(0); });
process.on('SIGTERM', () => { persistAll('SIGTERM'); process.exit(0); });
process.on('beforeExit', (code) => { persistAll('beforeExit'); });
process.on('uncaughtException', (err) => { try { console.error('Uncaught exception:', err); } catch(e){}; persistAll('uncaughtException'); process.exit(1); });

// ====== MESSAGE EVENTS ======
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const guildId = message.guild.id;
  const userId = message.author.id;
  // work on a local copy of the content for parsing (allows remapping when admin fixes prefix)
  let content = message.content || '';
  const { personal, guild, default: defPref } = getPrefixForUser(guildId, userId);

  // pre-parse old-prefix detection: if the user used a previous prefix, block command execution
  try {
    const curPref = getPrefix(guildId) || DEFAULT_PREFIX;
    const gset = settings[guildId] || {};
    const candidates = [];
    if (gset.oldPrefix) candidates.push(gset.oldPrefix);
    if (Array.isArray(gset.prevPrefixes)) candidates.push(...gset.prevPrefixes);
    const oldPrefixes = [...new Set(candidates)].filter(p => p && p !== curPref).sort((a,b)=>b.length-a.length);
    const usedOld = oldPrefixes.find(p => content.startsWith(p));
    if (usedOld && !content.startsWith(curPref)) {
      // determine the attempted command following the old prefix
      const tail = content.slice(usedOld.length).trim();
      const parts = tail.split(/\s+/);
      const tryCmd = (parts[0] || '').toLowerCase();
      const trySub = (parts[1] || '').toLowerCase();
      // allow admins to run change/clear prefix even with old prefix so they can fix it
      const isAdminFix = (tryCmd === 'change' && trySub === 'prefix') || (tryCmd === 'clear' && trySub === 'prefix');
      if (isAdminFix) {
        // if admin and has perms, remap content so downstream parsing treats it as current prefix
        if (message.member && (message.member.permissions.has(PermissionFlagsBits.ManageGuild) || message.member.permissions.has(PermissionFlagsBits.Administrator))) {
          content = curPref + tail;
        } else {
          // not allowed to change prefix — show warning and stop
          const key = `${guildId}:${userId}`;
          const now = Date.now();
          const last = lastOldPrefixWarn[key] || 0;
          if (now - last > 30_000) {
            lastOldPrefixWarn[key] = now;
            await message.reply(`⚠️ Префиксът на бота е сменен, моля използвайте \`${curPref}prefix\``);
          }
          return;
        }
      } else {
        // regular user used an old prefix — show warning (rate-limited) and do NOT execute command
        const key = `${guildId}:${userId}`;
        const now = Date.now();
        const last = lastOldPrefixWarn[key] || 0;
        if (now - last > 30_000) {
          lastOldPrefixWarn[key] = now;
          await message.reply(`⚠️ Префиксът на бота е сменен, моля използвайте \`${curPref}prefix\``);
        }
        return;
      }
    }
  } catch (e) { /* ignore errors */ }
  // prefer personal prefix if set for this user (use `content` which may have been remapped for admin fixes)
  let usedPrefix = null;
  if (personal && content.startsWith(personal)) usedPrefix = personal;
  else if (content.startsWith(guild)) usedPrefix = guild;
  else if (content.startsWith(defPref)) usedPrefix = defPref;
  // (old-prefix detection moved later, after parsing command) 
  const isCommand = !!usedPrefix;
  const userData = await ensureUser(message.guild, userId);
  const today = new Date().toISOString().split('T')[0];

  // лог в конзолата
  try {
    const server = message.guild?.name || 'DM';
    const channelName = message.channel?.name || message.channel?.id || 'unknown';
    let line = `[${server} #${channelName}] ${message.author.tag}: ${message.content || ''}`.trim();
    if (message.attachments?.size) {
      const urls = [...message.attachments.values()].map(a => a.url).join(', ');
      line += ` | attachments: ${urls}`;
    }
    console.log(line);
  } catch {}

  // броим само НЕ-командни
  if (!isCommand) {
    userData.messages += 1;
    userData.activeDays[today] = true;

    // дневни броячи
    userData.dailyCounts[today] = (userData.dailyCounts[today] || 0) + 1;
    const mentionCount = message.mentions.users.size || 0;
    if (mentionCount) {
      userData.mentions += mentionCount;
      userData.dailyMentions[today] = (userData.dailyMentions[today] || 0) + mentionCount;
    }

    // нощна птица (0-5 часа включително)
    const h = message.createdAt.getHours();
    if (h >= 0 && h <= 5) userData.nightOwlCount = (userData.nightOwlCount || 0) + 1;

    // мемета / изображения
    const hasImageAttach = [...message.attachments.values()].some(a => (a.contentType||'').startsWith('image/'));
    const hasImageEmbed = (message.embeds||[]).some(e => e?.image?.url);
    if (hasImageAttach || hasImageEmbed) userData.memesCount += 1;

    userData.lastActiveISO = new Date().toISOString();
    save();
    await checkAchievements(message.guild, userId, message.channel);
    // --- Counting game: validate sequence if active in this channel ---
    try {
      const cg = countingGames[message.channel.id];
      if (cg && cg.active) {
        // accept only messages that are a single integer
        const txt = (message.content||'').trim();
        if (/^\d+$/.test(txt)) {
          const num = parseInt(txt, 10);
          const expected = cg.current + 1;
          if (num !== expected) {
            await message.channel.send(`⚠️ Последователността е нарушена! Очакваше се: ${expected}, получено: ${num}. Играта се прекратява.`);
            delete countingGames[message.channel.id];
          } else {
            cg.current = num;
            // react with checkmark to acknowledge correct sequence
            try { await message.react('✅'); } catch (e) { /* ignore reaction failures (permissions) */ }
            if (cg.current >= cg.max) {
              await message.channel.send(`🎉 Играта приключи — достигнат е максимумът ${cg.max}!`);
              delete countingGames[message.channel.id];
            }
          }
        } else {
          // non-numeric message during counting - ignore or optionally warn
        }
      }
    } catch (e) { console.warn('counting game validate failed:', e?.message); }

    // --- Hangman: ако има активна игра в този канал, обработваме букви/думи без префикс
    try {
      const hg = hangmanMod.getGame(message.channel.id);
      if (hg && !hg.finished) {
        const txt = (message.content||'').trim();
        const pfx = getPrefix(message.guild.id) || DEFAULT_PREFIX;
        if (txt && !txt.startsWith(pfx)) {
          // normalize: remove extra spaces
          const cleaned = txt.toLowerCase().trim();

          // If a choice joker is pending and this author is the requester, accept a numeric position reply
          if (hg.pendingChoice && hg.pendingChoice.requester === message.author.id) {
            const asNum = parseInt(cleaned, 10);
            if (!isNaN(asNum)) {
              const res = hangmanMod.revealPosition(hg, message.author.id, asNum);
              if (!res.ok) {
                await message.channel.send(res.msg || '⚠️ Невалидна позиция за разкриване.');
                return;
              }
              await message.channel.send(res.msg || `✨ Разкрита буква: ${res.letter}\nДума: **${hg.displayWord}**`);
              if (res.win) { await message.channel.send(`🏆 Познахте думата: **${hg.word}**!`); hangmanMod.endGame(message.channel.id); }
              if (res.lose) { await message.channel.send(`💀 Загубихте! Думата беше: **${hg.word}**.`); hangmanMod.endGame(message.channel.id); }
              return;
            }
            // if not a number, continue to normal handling
          }

          // if single character (letter)
          const letters = cleaned.replace(/\s+/g,'');
          if (letters.length === 1) {
            const res = hangmanMod.guessLetter(hg, letters[0]);
            if (!res.ok) {
              // already guessed
              if (res.reason === 'already') await message.channel.send('ℹ️ Тази буква вече е опитана.');
            } else if (res.hit) {
              await message.channel.send(`✅ Правилно! Буква **${letters[0]}** е в думата.\nДума: **${hg.displayWord}**\nГрешни букви: ${Array.from(hg.wrongLetters).join(', ') || '—'}`);
              if (res.win) {
                await message.channel.send(`🏆 Познахте думата: **${hg.word}**! Играта приключи.`);
                hangmanMod.endGame(message.channel.id);
              }
            } else {
              await message.channel.send(`❌ Неправилна буква **${letters[0]}**. Грешки: ${hg.misses}/${hg.maxMisses}\nГрешни букви: ${Array.from(hg.wrongLetters).join(', ') || '—'}`);
              if (res.lost) {
                await message.channel.send(`💀 Загубихте — достигнат е лимитът. Думата беше: **${hg.word}**.`);
                hangmanMod.endGame(message.channel.id);
              }
            }
            // do not process further as other game handlers
          } else if (letters.length > 1) {
            // full word guess
            const attempt = cleaned.replace(/[^а-яa-zёъіїґ]/g, '');
            if (attempt) {
              const res = hangmanMod.guessWord(hg, attempt);
              if (res.win) {
                await message.channel.send(`🏆 Познахте думата: **${hg.word}**! Играта приключи.`);
                hangmanMod.endGame(message.channel.id);
              } else if (res.lost) {
                await message.channel.send(`💀 Неправилна дума и достигнат лимит. Думата беше: **${hg.word}**.`);
                hangmanMod.endGame(message.channel.id);
              } else {
                await message.channel.send(`❌ Неправилна дума. Грешки: ${hg.misses}/${hg.maxMisses}`);
              }
            }
          }
        }
      }
    } catch (e) { console.warn('[hangman validate] failed:', e?.message); }
  }

  if (!isCommand) return;

  if (!isCommand) return;

  // командни аргументи (изрязваме по използвания префикс) — use `content` which may have been remapped for admin fixes
  // detect if the user used the prefix twice (e.g. '!!drink coffee' when prefix is '!')
  const isDoublePrefix = !!(usedPrefix && content.startsWith(usedPrefix + usedPrefix));
  const args = content.slice(usedPrefix.length).trim().split(/\s+/);
  let cmd = (args.shift() || '').toLowerCase();
  // normalize commands like '!drink' which appear when user typed '!!drink' -> treat as double-prefix invocation
  if (usedPrefix && cmd.startsWith(usedPrefix)) {
    cmd = cmd.slice(usedPrefix.length);
  }

  // ===== Публични =====
  // ...existing code...
  if (cmd === 'rp') {
    if (rpMod && typeof rpMod.execute === 'function') {
      try { const res = await rpMod.execute(message, safeSend); if (res && res.ok) return; } catch (e) { console.warn('[rp] module failed:', e?.message); }
    }
    return message.reply('⚠️ RP помощта е временно недостъпна.');
  }
  if (cmd === 'games') {
    if (gamesMod && typeof gamesMod.execute === 'function') {
      try { const res = await gamesMod.execute(message, safeSend); if (res && res.ok) return; } catch (e) { console.warn('[games] module failed:', e?.message); }
    }
    return message.reply('⚠️ Games помощта е временно недостъпна.');
  }
  if (cmd === 'help') {
    const subcmd = (args.shift()||'').toLowerCase();
    // If help module is available, prefer it
    if (helpMod && typeof helpMod.execute === 'function') {
      try {
        const res = await helpMod.execute(message, safeSend);
        if (res && res.ok) return;
      } catch (e) { console.warn('[help] module failed:', e?.message); }
    }
    return message.reply('⚠️ Помощта е временно недостъпна.');
  }

  

  // Админ помощ: !ahelp
  if (cmd === 'ahelp') {
    const subcmd = (args.shift()||'').toLowerCase();
    const curPrefA = getPrefix(guildId);
    const prefA = curPrefA || DEFAULT_PREFIX;
    const adminHelpShort = {
      'reset': '`' + prefA + 'reset <days|mentions|messages|reactions|achievements|all> [@user|all]` — Унифициран рестарт на статистики/постижения; за масови операции се изисква потвърждение с `' + prefA + 'confirmreset <id>`.',
      'achsetup': '`' + prefA + 'achsetup list` / `' + prefA + 'achsetup set <key> @Роля` / `' + prefA + 'achsetup clear <key>` — Настройка на роли за постижения.',
  'syncachroles': '`' + prefA + 'syncachroles` — Синхронизира и присвоява роли за постижения на потребители, които вече имат отключени постижения.',
      'call': '`' + prefA + 'call @user|<id> <текст>` — Изпраща DM съобщение на потребител (админ само).',
      'change': '`' + prefA + 'change prefix <нов префикс>` — Променя префикса на бота за този сървър (админ само).',
      'clear': '`' + prefA + 'clear prefix` — Връща префикса на бота за този сървър към подразбиращия се (`' + DEFAULT_PREFIX + '`) (админ само).'
    };
    if (subcmd) {
      if (adminHelpShort[subcmd]) return message.channel.send(adminHelpShort[subcmd]);
    }
    if (!message.member || !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('⚠️ Само администратори могат да използват тази команда.');
    }
    if (helpMod && typeof helpMod.adminExecute === 'function') {
      try {
        const res = await helpMod.adminExecute(message, safeSend);
        if (res && res.ok) return;
      } catch (e) { console.warn('[ahelp] module failed:', e?.message); }
    }
    // fallback: craft admin embed locally (minimal)
    const adminEmbed = new EmbedBuilder()
      .setTitle('⚙️ Админ команди')
      .setColor(0xE67E22)
      .setDescription('Използвайте админ команди.\n\n• ' + prefA + 'achsetup — Настройка на роли за постижения\n• ' + prefA + 'syncachroles — Синхронизация и присвояване на роли за постижения\n• ' + prefA + 'reset — Унифициран рестарт на статистики');
    return message.channel.send({ embeds: [adminEmbed] });
  }

  if (cmd === 'invite') {
    try {
      console.log(`[invite] invoked by ${message.author.tag} (${message.author.id}) in ${message.guild?.id || 'DM'}`);
    } catch (e) {}
    if (!message.member || !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      try { console.log(`[invite] blocked for ${message.author.tag} (${message.author.id}) - not admin`); } catch (e) {}
      return message.reply('⚠️ Само администратори могат да използват тази команда.');
    }
    try { console.log(`[invite] allowed for ${message.author.tag} (${message.author.id})`); } catch (e) {}
    const links = getInviteLinks();
    if (!links) return message.reply('⚠️ Опитай след секунди.');
    const emb = new EmbedBuilder()
      .setTitle('🔗 Покани бота')
      .addFields(
        { name: '🛡️ Admin права', value: `[Добави](<${links.adminInvite}>)`, inline: false },
        { name: '✅ Минимални права', value: `[Добави](<${links.minimalInvite}>) (permissions=${links.minimal})`, inline: false }
      )
      .setColor(0x57F287);
    return sendEmbedOrText(message.channel, emb, `🔗 Admin: ${links.adminInvite}\nMinimal: ${links.minimalInvite}`);
  }

  // --- Jokes: external (Gemini) and local ---
  if (cmd === 'joke2') {
    try {
      // local list of jokes (Bulgarian) - base pool if jokes2 not initialized
      const localJokes = [
        'Защо компютърът не може да играе карти? Защото винаги изважда грешен бутон.',
        'Какво казал българският програмист на кафето? „Без грешки, моля.“',
        'Как се нарича котка в интернет? Мяу-щърм.',
        'Как програмист прави чай? Налива вода, чака 0.000001 секунди и рестартира kettle()...'
      ];
      // ensure pool exists
      if (!jokes2 || !Array.isArray(jokes2.pool)) jokes2 = { pool: localJokes.slice(), used: [] };
      // if pool empty, refill from base localJokes + shuffle, and clear used
      if (!jokes2.pool.length) {
        jokes2.pool = localJokes.slice();
        // remove duplicates that may exist in used
        jokes2.pool = jokes2.pool.filter(x => !jokes2.used.includes(x));
        // if still empty (all jokes used), reset used and refill
        if (!jokes2.pool.length) {
          jokes2.used = [];
          jokes2.pool = localJokes.slice();
        }
      }
      // draw one randomly from pool
      const idx = Math.floor(Math.random() * jokes2.pool.length);
      const j = jokes2.pool.splice(idx, 1)[0];
      jokes2.used.push(j);
      // persist state
      saveJokes2();
      return message.channel.send(j);
    } catch (e) {
      console.warn('[joke2] failed:', e?.message);
      return message.reply('⚠️ Нещо се обърка при генерирането на локален виц.');
    }
  }

  // --- Jokes3: persistent user-added jokes (cross-guild sharing) ---
  // !joke3 now returns a random user-added joke (global). Use !addjoke3 to add, !removejoke3 to remove.
  if (cmd === 'joke3') {
    try {
      const all = [].concat(...Object.values(jokes3 || {}));
      if (!all.length) return message.reply('ℹ️ Няма записани вицове в системата. Можете да добавите с `!addjoke3 <текст>`');
      const sub = (args[0] || '').toString().toLowerCase();

      // List all jokes in embeds: !joke3 list
      if (sub === 'list') {
        try {
          const lines = all.map((j, idx) => `${idx+1}. ${j.text}`);
          // chunk into embed-sized descriptions (Discord embed description limit ~4096)
          const chunks = [];
          let cur = '';
          for (const line of lines) {
            const add = (cur.length ? '\n\n' : '') + line;
            if ((cur.length + add.length) > 3800) { // leave margin
              chunks.push(cur);
              cur = line;
            } else {
              cur += add;
            }
          }
          if (cur.length) chunks.push(cur);

          // send each chunk as an embed (with page footer)
          for (let i = 0; i < chunks.length; i++) {
            const emb = new EmbedBuilder()
              .setTitle(`📜 Всички добавени вицове (${all.length})` + (chunks.length > 1 ? ` — страница ${i+1}/${chunks.length}` : ''))
              .setDescription(chunks[i])
              .setColor(0x57F287);
            // send sequentially
            // small delay not necessary in most cases
            await message.channel.send({ embeds: [emb] });
          }
          return null;
        } catch (inner) {
          console.error('[joke3 list] error:', inner);
          // fallback to file
          const out = all.map((j, idx) => `${idx+1}. ${j.text}`).join('\n');
          await message.channel.send({ embeds: [new EmbedBuilder().setTitle('📜 Всички добавени вицове').setDescription('Доставям като файл поради голям обем').setColor(0xE67E22)] });
          return message.channel.send({ files: [{ attachment: Buffer.from(out, 'utf8'), name: 'jokes3-list.txt' }] });
        }
      }

      // random fallback: return a random joke
      const chosen = all[Math.floor(Math.random() * all.length)];
      return message.channel.send(chosen.text);
    } catch (err) {
      console.error('[joke3] handler error:', err);
      return message.reply('⚠️ Възникна грешка при обработката на `!joke3`.');
    }
  }

  // Shuffle & raffle: !rafflejoke3 — разбърква всички добавени вицове и връща един произволен
  if (cmd === 'rafflejoke3') {
    try {
      const all = [].concat(...Object.values(jokes3 || {}));
      if (!all.length) return message.reply('ℹ️ Няма записани вицове в системата. Можете да добавите с `!addjoke3 <текст>`');

      // Fisher-Yates shuffle
      for (let i = all.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = all[i]; all[i] = all[j]; all[j] = tmp;
      }

      const chosen = all[Math.floor(Math.random() * all.length)];
      return message.channel.send(chosen.text);
    } catch (err) {
      console.error('[rafflejoke3] handler error:', err);
      return message.reply('⚠️ Възникна грешка при обработката на `!rafflejoke3`.');
    }
  }

  // Add joke: !addjoke3 <текст>
  if (cmd === 'addjoke3') {
    try {
      const gid = message.guild ? message.guild.id : null;
      if (!gid) return message.reply('⚠️ Можете да добавяте вицове само от сървър (не в лични съобщения).');
      const text = args.join(' ').trim();
      if (!text) return message.reply('⚠️ Укажете текста на вица: `!addjoke3 Тук е вицът`');
      if (!jokes3[gid]) jokes3[gid] = [];
      const id = Date.now().toString(36) + '-' + Math.floor(Math.random()*1000);
      const entry = { id, text, addedBy: message.author.id, addedAt: new Date().toISOString() };
      jokes3[gid].push(entry);
      saveJokes3();
      return message.reply('✅ Вицът е записан с id: ' + id);
    } catch (err) {
      console.error('[addjoke3] error:', err);
      return message.reply('⚠️ Възникна грешка при добавяне на вица.');
    }
  }

  // Remove joke: !removejoke3 <id> (requires Manage Server)
  if (cmd === 'removejoke3') {
    try {
      const gid = message.guild ? message.guild.id : null;
      if (!gid) return message.reply('⚠️ Тази команда работи само в сървър.');
      if (!message.member || !message.member.permissions.has(PermissionFlagsBits.ManageGuild)) return message.reply('⛔ Само потребители с право "Manage Server" могат да изтриват вицове.');
      const id = args.shift();
      if (!id) return message.reply('⚠️ Укажете id на вица: `!removejoke3 <id>`');
      const list = jokes3[gid] || [];
      const idx = list.findIndex(x => x.id === id);
      if (idx === -1) return message.reply('⚠️ Не намерих виц с такъв id в този сървър.');
      list.splice(idx, 1);
      saveJokes3();
      return message.reply('✅ Вицът беше изтрит.');
    } catch (err) {
      console.error('[removejoke3] error:', err);
      return message.reply('⚠️ Възникна грешка при изтриване на вица.');
    }
  }

  // (joke3 removed)

  // --- Jokes4: generated from guild chat (ID 538350666566074389) ---
  if (cmd === 'joke4') {
    try {
      const sub = (args[0] || '').toString().toLowerCase();
      const all = (jokes4.items || []).slice();
      if (!all.length) return message.reply('ℹ️ Няма налични вицове генерирани от чата. Изчакай да се съберат няколко съобщения.');

      if (sub === 'list') {
        // send as embeds chunked
        const lines = all.map((j, idx) => `${idx+1}. ${j.text}`);
        const chunks = [];
        let cur = '';
        for (const line of lines) {
          const add = (cur.length ? '\n\n' : '') + line;
          if ((cur.length + add.length) > 3800) { chunks.push(cur); cur = line; } else { cur += add; }
        }
        if (cur.length) chunks.push(cur);
        for (let i = 0; i < chunks.length; i++) {
          const emb = new EmbedBuilder().setTitle(`😂 Вицове от чата (${all.length})` + (chunks.length>1?` — стр. ${i+1}/${chunks.length}`:''))
            .setDescription(chunks[i]).setColor(0x5865F2);
          await message.channel.send({ embeds: [emb] });
        }
        return null;
      }

      // random: assemble a joke from 2-3 distinct collected lines
      const count = Math.min(3, Math.max(1, Math.floor(all.length >= 3 ? 2 + Math.floor(Math.random()*2) : 1)) );
      const picked = [];
      const copy = all.slice();
      while (picked.length < count && copy.length) {
        const i = Math.floor(Math.random() * copy.length);
        picked.push(copy.splice(i,1)[0].text);
      }
      // simple assembly: join lines with newline; add a small connective if 2 lines
      let composed = picked.join('\n');
      if (picked.length === 2) composed = `${picked[0]}\n— ${picked[1]}`;
      if (picked.length === 3) composed = `${picked[0]}\n${picked[1]}\n— ${picked[2]}`;
      return message.channel.send(composed);
    } catch (err) {
      console.error('[joke4] handler error:', err);
      return message.reply('⚠️ Възникна грешка при обработка на `!joke4`.');
    }
  }

  // --- Hangman (Бесеница) ---
  if (cmd === 'hangman') {
    try {
      // usage: !hangman [@opponent]
      const gid = message.guild ? message.guild.id : null;
      const channelId = message.channel.id;
      // if a game already exists in this channel, inform
      const existing = hangmanMod.getGame(channelId);
      if (existing && !existing.finished) return message.reply('ℹ️ Вече има активна игра на бесеница в този канал. Моля завършете първо нея.');

      // determine opponent
      const mention = message.mentions.users.first();
      let vsBot = false;
      const players = [message.author.id];
      if (mention && mention.id !== message.author.id) {
        players.push(mention.id);
        await message.channel.send(`🎯 ${message.author} предизвика ${mention} на игра бесеница! Който е тагнат, отговаря когато е негов ход.`);
      } else {
        vsBot = true;
        await message.channel.send(`🎯 ${message.author} започна игра на бесеница срещу бота. Пишете букви в чата, за да познаете думата.`);
      }

      const state = hangmanMod.createGame(channelId, { players, vsBot });
      // initial display
      const emb = new EmbedBuilder()
        .setTitle('🪓 Бесеница (Hangman)')
        .setDescription(`Дума: **${state.displayWord}**\nГрешни букви: —\nХвърляния: ${state.misses}/${state.maxMisses}`)
        .setColor(0x9b59b6)
        .setFooter({ text: 'Пиши буква в чата (без префикс). Може и цяла дума.' });
      await message.channel.send({ embeds: [emb] });
      return;
    } catch (e) {
      console.error('[hangman start] error:', e);
      return message.reply('⚠️ Възникна грешка при стартиране на играта.');
    }
  }

  // Jokers for hangman: !joker <vowels|consonants|choice> (also support Bulgarian: гласни, съгласни, избор)
  if (cmd === 'joker' || cmd === 'жокер') {
    try {
      const sub = (args.shift()||'').toLowerCase();
      if (!sub) return message.reply('ℹ️ Използване: `!joker <vowels|consonants|choice>` (или `!жокер <гласни|съгласни|избор`)');
      const map = { 'vowels':'vowels', 'гласни':'vowels', 'consonants':'consonants', 'съгласни':'consonants', 'choice':'choice', 'избор':'choice' };
      const type = map[sub];
      if (!type) return message.reply('⚠️ Невалиден жокер. Опции: vowels/consonants/choice');
      const g = hangmanMod.getGame(message.channel.id);
      if (!g || g.finished) return message.reply('ℹ️ Няма активна игра на бесеница в този канал. Стартирай с `!hangman`.');
      const res = hangmanMod.useJoker(g, type, message.author.id);
      if (!res.ok) {
        if (res.reason === 'used') return message.reply('ℹ️ Този жокер вече е използван.');
        return message.reply('⚠️ Неуспешно използване на жокера.');
      }
      if (res.type === 'vowels' || res.type === 'consonants') {
        if (res.revealed && res.revealed.length) {
          const coords = res.revealed.map(r => `${r.ch} (позиция ${r.pos})`).join(', ');
          await message.channel.send(`✨ Жокер ${type}: разкрити букви: ${coords}\nДума: **${g.displayWord}**`);
          if (res.win) { await message.channel.send(`🏆 Познахте думата: **${g.word}**! Играта приключи.`); hangmanMod.endGame(message.channel.id); }
        } else {
          await message.channel.send(`ℹ️ Жокер ${type}: няма нови букви за разкриване.`);
        }
      } else if (res.type === 'choice') {
        await message.channel.send(`🔎 Жокер избор: напиши номер от 1 до ${res.totalPositions}, за да разкриеш буквата на тази позиция (премахват се интервали). Само ${message.author} може да избере.`);
      }
      return;
    } catch (e) {
      console.error('[joker] handler error:', e);
      return message.reply('⚠️ Възникна грешка при използване на жокер.');
    }
  }

  if (cmd === 'joke') {
    // Prefer SDK client if available. Supports optional model argument: !joke <model>
    // Show typing indicator to reduce perceived latency.
    try { await message.channel.sendTyping(); } catch (e) {}
    const requestedModel = (args.shift() || '').trim() || 'gemini-2.5-flash';
    // Prefer SDK client if available
    if (genAI) {
      try {
        const model = genAI.getGenerativeModel({ model: requestedModel });
  const prompt = 'Разкажи забавен виц на български език (може да е кратък или разказен), по възможност свързан с рок музика или китари.';
        const result = await model.generateContent(prompt);
        // attempt to read text from result in several possible shapes
        let responseText = null;
        try { responseText = (typeof result.response === 'function') ? result.response().text() : (result.response?.text?.() || result.text || null); } catch (e) { /* ignore */ }
        if (!responseText && result?.candidates && Array.isArray(result.candidates) && result.candidates[0]) responseText = result.candidates[0].output || result.candidates[0].content || result.candidates[0].text;
        if (!responseText) responseText = String(result).slice(0,1900);
        return message.reply('🎸 ' + responseText);
      } catch (err) {
        console.error('⚠️ Грешка при заявката към Gemini (SDK):', err);
        // If 404, try to list available models via REST to help debugging (do not throw)
        try {
          const key = process.env.GEMINI_API_KEY || (settings[message.guild?.id] && settings[message.guild.id].geminiApiKey) || null;
          const listEndpoints = [
            'https://generativelanguage.googleapis.com/v1/models',
            'https://generativelanguage.googleapis.com/v1beta/models',
            'https://generativeai.googleapis.com/v1/models'
          ];
          let modelsList = null;
          for (const ep of listEndpoints) {
            try {
              let url = ep;
              const headers = { 'Accept': 'application/json' };
              if (key && typeof key === 'string' && key.startsWith('AIza')) {
                url = ep + '?key=' + encodeURIComponent(key);
              } else if (key) {
                headers['Authorization'] = 'Bearer ' + key;
              }
              console.log('[joke] trying list-models endpoint', url);
              const r = await fetch(url, { method: 'GET', headers });
              if (!r.ok) {
                const t = await r.text().catch(() => '<no body>');
                console.warn('[joke] list-models attempt', url, 'returned', r.status, t.slice ? t.slice(0,1000) : String(t));
                continue;
              }
              const json = await r.json().catch(() => null);
              if (json) {
                // different shapes: { models: [{name: 'models/..'}, ...] } or array
                let names = [];
                if (Array.isArray(json)) names = json.map(x => x.name || x.model || String(x)).filter(Boolean);
                else if (json.models && Array.isArray(json.models)) names = json.models.map(m => m.name || m.model || '').filter(Boolean);
                else if (json.model) names = [json.model];
                if (names.length) modelsList = names;
                else modelsList = Object.keys(json).slice(0, 20);
                break;
              }
            } catch (inner) {
              console.warn('[joke] list-models inner error for', ep, inner?.message || inner);
            }
          }
          if (modelsList && modelsList.length) {
            console.log('[joke] available models (sample):', modelsList.slice(0, 20));
            const limited = modelsList.slice(0, 10).map(s => s.replace(/^models\//, '')).join(', ');
            try { await message.reply('⚠️ Gemini: моделът, който опитахме, не е наличен. Налични модели (пример): ' + limited); } catch (e) {}
            return null;
          }
        } catch (listErr) {
          console.warn('[joke] failed to list models:', listErr?.message || listErr);
        }
        // fallback to local joke
        const local = LOCAL_JOKES[Math.floor(Math.random() * LOCAL_JOKES.length)];
        try { await message.reply(local); } catch (e) {}
        return null;
      }

      // === Gemini Fetch Вицове (топ-левъл helper) ===
      async function fetchGeminiJoke(category) {
        const key = process.env.GEMINI_API_KEY;
        if (!key) return null;

        try {
          const url = `https://generativelanguage.googleapis.com/v1beta2/models/text-bison-001:generate?key=${encodeURIComponent(key)}`;
          const safeCat = (category || '').toString().trim();
          let promptText = 'Разкажи кратък, забавен български виц, без източници и без обяснения.';
          if (safeCat && safeCat.toLowerCase() !== 'random') {
            const cat = safeCat.length > 120 ? safeCat.slice(0, 120) + '...' : safeCat;
            promptText = `Разкажи кратък, забавен български виц на тема "${cat}", без източници и без обяснения.`;
          }

          const body = {
            prompt: { text: promptText },
            maxOutputTokens: 150,
          };

          const res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });

          if (!res.ok) {
            return null;
          }

          const data = await res.json().catch(() => null);
          const candidate = data?.candidates?.[0] || data?.candidate || data;
          let out = candidate?.output || candidate?.content || candidate?.text || null;
          if (typeof out === 'object') out = out?.text || JSON.stringify(out);
          if (!out) out = 'Не успях да измисля нищо смешно 😅';
          return String(out).trim();
        } catch (err) {
          return null;
        }
      }

  // (joke3 removed)
    }
    // If SDK not available, fall back to previous logic or local joke
    const local = LOCAL_JOKES[Math.floor(Math.random() * LOCAL_JOKES.length)];
    try { await message.reply(local); } catch (e) {}
    return null;
  }

  // ===== Admin shutdown/stop command =====
  if (cmd === 'shutdown' || cmd === 'stop') {
    // only allow server administrators
    if (!message.member || !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('⛔ Само администратори могат да спират бота.');
    }
    try {
      await message.channel.send('🛑 Принудително изключване: прекратявам всички активни сесии, изчиствам кешове и правя финален бекъп.');
    } catch (e) { /* ignore send failures */ }
    try {
      // mark shutting down so other handlers stop acting
      try { global.__shuttingDown = true; } catch (e) {}
      // stop autosave timer immediately
      try { if (typeof autosaveTimer !== 'undefined' && autosaveTimer) { clearInterval(autosaveTimer); autosaveTimer = null; } } catch (e) {}
      // aggressively clear in-memory structures to free resources
      try {
        for (const k of Object.keys(games)) delete games[k];
        for (const k of Object.keys(countingGames)) delete countingGames[k];
        for (const k of Object.keys(pendingChallenges)) delete pendingChallenges[k];
        for (const k of Object.keys(pendingResets)) delete pendingResets[k];
      } catch (e) {}

      // perform final synchronous persistence and create immediate backups
      persistAll(`aggressive-stop by ${message.author.id}`);
      try {
        // attempt to save known collections explicitly
        try { saveSettings(); } catch (e) {}
        try { save(); } catch (e) {}
        try { saveGifs(); } catch (e) {}
        try { saveJokes2(); } catch (e) {}
        try { saveJokes3(); } catch (e) {}
        try { saveJokes4(); } catch (e) {}
        try { saveTodos(); } catch (e) {}
        // create backups for critical files
        try { backupJsonFile(dataFile); } catch (e) {}
        try { backupJsonFile(settingsFile); } catch (e) {}
        try { backupJsonFile(gifsFile); } catch (e) {}
      } catch (e) {}
    } catch (e) { console.error('persistAll failed during shutdown:', e); }
    try { await client.destroy(); } catch (e) { /* ignore */ }
    try { process.exit(0); } catch (e) { /* ignore */ }
    return;
  }

  // ===== Manual save-all (admin) =====
  if (cmd === 'save-all') {
    // only allow server administrators
    if (!message.member || !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('⛔ Само администратори могат да извършват ръчно запис.');
    }
    try {
      await message.channel.send('💾 Извършвам ръчен запис и правя архиви (backup) в папката за бекъп...');
    } catch (e) {}
    try {
      const candidates = [
        { name: 'achievements', file: dataFile },
        { name: 'settings', file: settingsFile },
        { name: 'gifs', file: gifsFile },
        { name: 'jokes3', file: jokes3File },
        { name: 'jokes2', file: jokes2File },
        { name: 'jokes4', file: jokes4File },
        { name: 'todos', file: todosFile },
        { name: 'deletedMessages', file: deletedMessagesFile },
        { name: 'news', file: newsFile },
        { name: 'userData', file: './userData.json' },
  { name: 'personalCommands', file: './myhelp.json' }
      ];
      const created = [];
      const missing = [];
      const failed = [];

      for (const c of candidates) {
        try {
          const abs = path.resolve(c.file);
          if (!fs.existsSync(abs)) {
            missing.push({ name: c.name, path: abs });
            continue;
          }
          const dest = backupJsonFile(c.file);
          if (dest) created.push(dest);
          else failed.push({ name: c.name, path: abs });
        } catch (inner) {
          failed.push({ name: c.name, error: String(inner) });
        }
      }

      // atomic writes for live data (always attempt to write current state)
      const atomicResults = [];
      try { atomicWrite(dataFile, store); atomicResults.push('store'); } catch (e) { atomicResults.push('store:ERR'); console.error('save failed:', e); }
      try { atomicWrite(settingsFile, settings); atomicResults.push('settings'); } catch (e) { atomicResults.push('settings:ERR'); console.error('saveSettings failed:', e); }
      try { atomicWrite(gifsFile, gifs); atomicResults.push('gifs'); } catch (e) { atomicResults.push('gifs:ERR'); console.error('saveGifs failed:', e); }
      try { atomicWrite(jokes3File, jokes3); atomicResults.push('jokes3'); } catch (e) { atomicResults.push('jokes3:ERR'); console.error('saveJokes3 failed:', e); }
      try { atomicWrite(jokes2File, jokes2); atomicResults.push('jokes2'); } catch (e) { atomicResults.push('jokes2:ERR'); console.error('saveJokes2 failed:', e); }
      try { atomicWrite(jokes4File, jokes4); atomicResults.push('jokes4'); } catch (e) { atomicResults.push('jokes4:ERR'); console.error('saveJokes4 failed:', e); }
      try {
        const minimal = (function(){ const minimal = {}; for (const gid of Object.keys(store||{})) { const g = store[gid]; if (!g||!g.users) continue; for (const uid of Object.keys(g.users)) { const u = g.users[uid]||{}; if ((u.todos&&u.todos.length)||(u.doneTodos&&u.doneTodos.length)) { if (!minimal[gid]) minimal[gid]={}; minimal[gid][uid] = { todos: u.todos||[], doneTodos: u.doneTodos||[] }; } } } return minimal; })();
        atomicWrite(todosFile, minimal);
        atomicResults.push('todos');
      } catch (e) { atomicResults.push('todos:ERR'); console.error('saveTodos failed:', e); }

      // craft a concise report for the admin
      const lines = [];
      lines.push(`✅ Atomic writes: ${atomicResults.join(', ')}`);
      if (created.length) {
        lines.push(`📦 Създадени бекъпи (${created.length}):`);
        for (const p of created.slice(0,20)) lines.push(` - ${p}`);
      }
      if (missing.length) {
        lines.push(`⚠️ Липсващи файлове (${missing.length}):`);
        for (const m of missing.slice(0,20)) lines.push(` - ${m.name}: ${m.path}`);
      }
      if (failed.length) {
        lines.push(`❌ Грешки при бекъп (${failed.length}):`);
        for (const f of failed.slice(0,20)) lines.push(` - ${f.name || '?'} ${f.path ? '- ' + f.path : ''} ${f.error ? '- ' + f.error : ''}`);
      }

      try { await message.channel.send(lines.join('\n')); } catch (e) { try { await message.channel.send('✅ Ръчен запис и бекъп завършени.'); } catch (e2) {} }
      // Project snapshot creation disabled - no full-project copies will be made.
    } catch (err) {
      console.error('[save-all] failed:', err);
      try { await message.channel.send('⚠️ Възникна грешка при ръчния запис. Проверете логовете.'); } catch (e) {}
    }
    return;
  }

  // ===== Personal prefix command (!prefix) =====
  if (cmd === 'prefix') {
    const sub = (args.shift()||'').trim();
    if (!sub) {
      // show current guild prefix (the one set with !change prefix)
      const cur = getPrefix(guildId);
      return message.channel.send(`🔖 Текущ префикс за този сървър е: \`${cur}\``);
    }
    // set personal prefix
    const newPref = sub;
    if (newPref.length > 5) return message.reply('⚠️ Префиксът не може да е по-дълъг от 5 символа.');
    const gset = ensureGuildSettings(guildId);
    if (!gset.personalPrefixes) gset.personalPrefixes = {};
    if (newPref === 'clear' || newPref === 'none') {
      delete gset.personalPrefixes[userId];
      saveGuildSettings(guildId, gset);
      return message.channel.send('✅ Твоят персонален префикс беше изчистен.');
    }
    gset.personalPrefixes[userId] = newPref;
    saveGuildSettings(guildId, gset);
    return message.channel.send(`✅ Твоят персонален префикс е зададен на: \`${newPref}\``);
  }

  // ===== Prefix commands =====

  if (cmd === 'change') {
    const sub = (args.shift()||'').toLowerCase();
    if (sub === 'prefix') {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return message.reply('⛔ Само администратори/Manage Server могат да сменят префикса.');
      }
      const newPrefix = (args.join(' ') || '').trim();
      if (!newPrefix) return message.reply('ℹ️ Използване: `!change prefix <нов префикс>`');
      if (newPrefix.length > 5) return message.reply('⚠️ Префиксът не може да е по-дълъг от 5 символа.');
      const gset = ensureGuildSettings(guildId);
      // store previous prefix for a short grace period
      try {
        const prev = gset.prefix || DEFAULT_PREFIX;
        if (!gset.prevPrefixes) gset.prevPrefixes = [];
        // push to head, keep unique and limit 5
        gset.prevPrefixes.unshift(prev);
        gset.prevPrefixes = [...new Set(gset.prevPrefixes)].slice(0,5);
        // also keep single oldPrefix for compatibility
        gset.oldPrefix = prev;
      } catch (e) {}
      gset.prefix = newPrefix;
      saveGuildSettings(guildId, gset);
      return message.channel.send(`✅ Префиксът за този сървър беше променен на: \`${newPrefix}\``);
    }
  }

  // clear prefix: !clear prefix -> reset to DEFAULT_PREFIX
  if (cmd === 'clear') {
    const sub = (args.shift()||'').toLowerCase();
    if (sub === 'prefix') {
      if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
        return message.reply('⛔ Само администратори/Manage Server могат да сменят префикса.');
      }
      const gset = ensureGuildSettings(guildId);
      try {
        const prev = gset.prefix || DEFAULT_PREFIX;
        if (!gset.prevPrefixes) gset.prevPrefixes = [];
        gset.prevPrefixes.unshift(prev);
        gset.prevPrefixes = [...new Set(gset.prevPrefixes)].slice(0,5);
        gset.oldPrefix = prev;
      } catch (e) {}
      gset.prefix = DEFAULT_PREFIX;
      saveGuildSettings(guildId, gset);
      return message.channel.send(`✅ Префиксът за този сървър беше върнат към подразбиращия се: \`${DEFAULT_PREFIX}\``);
    }
  }

  if (cmd === 'ping') return message.reply('🏓 Понг!');
  if (cmd === 'bgrock') return message.channel.send('🎸 https://bgrock.eu/');

  // Fun category: joke commands grouped under !fun
  if (cmd === 'fun') {
    try {
      const emb = new EmbedBuilder()
        .setTitle('😂 Fun commands')
        .setDescription('Списък с команди за вицове и забавление')
        .addFields(
          { name: '!joke', value: 'Генерирай виц чрез Gemini AI (ако е конфигуриран API ключ)', inline: false },
          { name: '!joke2', value: 'Локален виц (изтегля от pool)', inline: false },
          { name: '!joke3', value: 'Потребителски добавени вицове (ако има такива)', inline: false },
          { name: '!funny', value: 'Забавни изображения.', inline: false },
          { name: '!random - Произволни изображения.', value: '\u200b', inline: false }
        )
        .setColor(0xF1C40F);
      return message.channel.send({ embeds: [emb] });
    } catch (e) { return message.reply('⚠️ Неуспешно зареждане на fun командите.'); }
  }

  // Random image from ./images folder
  if (cmd === 'random') {
    try {
      const imgDir = path.join(process.cwd(), 'images', 'random');
      if (!fs.existsSync(imgDir)) {
        return message.channel.send('ℹ️ Папката с изображения не съществува. Моля добави `images/random/` във файла на проекта.');
      }
      const files = fs.readdirSync(imgDir).filter(f => /\.(jpe?g|png|gif|webp)$/i.test(f));
      if (!files.length) return message.channel.send('ℹ️ Папката `images/random` е празна. Добави файлове (.jpg/.png/.gif/.webp) и опитай пак.');
      const pick = files[Math.floor(Math.random() * files.length)];
      const full = path.join(imgDir, pick);
      return message.channel.send({ files: [full] });
    } catch (e) {
      console.error('[random image] failed:', e);
      return message.reply('⚠️ Възникна грешка при изпращане на изображение.');
    }
  }

  // RP drink: lemonade (alias limonada) -> Поднеси лимонада
  if (cmd === 'lemonade' || cmd === 'limonada') {
    try {
      const target = message.mentions.users.first();
      const desc = target ? `${message.author} поднася лимонада на ${target}` : `${message.author} поднася лимонада`;
      // Prefer RP dynamic sender if available
      if (typeof sendRPDynamic === 'function') {
        try { await sendRPDynamic(message.channel, desc, 'lemonade'); } catch (e) { await message.channel.send(desc); }
      } else {
        await message.channel.send(desc);
      }
    } catch (e) {
      console.error('[lemonade] handler error:', e);
      return message.reply('⚠️ Възникна грешка при изпълнение на командата.');
    }
    return;
  }

  // ===== !funny - random funny images from images/funnyjoke
  if (cmd === 'funny') {
    try {
      const imgDir = path.join(process.cwd(), 'images', 'funnyjoke');
      if (!fs.existsSync(imgDir)) {
        return message.channel.send('ℹ️ Папката с изображения не съществува. Моля добави `images/funnyjoke/` във файла на проекта.');
      }
      const files = fs.readdirSync(imgDir).filter(f => /\.(jpe?g|png|gif|webp)$/i.test(f));
      if (!files.length) return message.channel.send('ℹ️ Папката `images/funnyjoke` е празна. Добави файлове (.jpg/.png/.gif/.webp) и опитай пак.');
      const pick = files[Math.floor(Math.random() * files.length)];
      const full = path.join(imgDir, pick);
      return message.channel.send({ files: [full] });
    } catch (e) {
      console.error('[funny image] failed:', e);
      return message.reply('⚠️ Възникна грешка при изпращане на изображение.');
    }
  }

  // ===== !got - random images from images/got
  if (cmd === 'got') {
    try {
      const imgDir = path.join(process.cwd(), 'images', 'got');
      if (!fs.existsSync(imgDir)) {
        return message.channel.send('ℹ️ Папката с изображения не съществува. Моля добави `images/got/` във файла на проекта.');
      }
      const files = fs.readdirSync(imgDir).filter(f => /\.(jpe?g|png|gif|webp)$/i.test(f));
      if (!files.length) return message.channel.send('ℹ️ Папката `images/got` е празна. Добави файлове (.jpg/.png/.gif/.webp) и опитай пак.');
      const pick = files[Math.floor(Math.random() * files.length)];
      const full = path.join(imgDir, pick);
      return message.channel.send({ files: [full] });
    } catch (e) {
      console.error('[got image] failed:', e);
      return message.reply('⚠️ Възникна грешка при изпращане на изображение.');
    }
  }

  // ===== !doc - random images from images/dr.house
  if (cmd === 'doc') {
    try {
      const imgDir = path.join(process.cwd(), 'images', 'dr.house');
      if (!fs.existsSync(imgDir)) {
        return message.channel.send('ℹ️ Папката с изображения не съществува. Моля добави `images/dr.house/` във файла на проекта.');
      }
      const files = fs.readdirSync(imgDir).filter(f => /\.(jpe?g|png|gif|webp)$/i.test(f));
      if (!files.length) return message.channel.send('ℹ️ Папката `images/dr.house` е празна. Добави файлове (.jpg/.png/.gif/.webp) и опитай пак.');
      const pick = files[Math.floor(Math.random() * files.length)];
      const full = path.join(imgDir, pick);
      return message.channel.send({ files: [full] });
    } catch (e) {
      console.error('[doc image] failed:', e);
      return message.reply('⚠️ Възникна грешка при изпращане на изображение.');
    }
  }

  

  // ===== !chess <@user> - Tic-tac-toe challenge (морски шах) =====
  if (cmd === 'chess' || cmd === 'tic' || cmd === 'tictactoe') {
    const target = message.mentions.users.first();
    if (!target) return message.reply('ℹ️ Използване: `!chess @user`');
    if (target.id === message.author.id) return message.reply('⚠️ Не можеш да предизвикваш себе си.');

    const prompt = await message.channel.send(`🎮 ${target}, получи покана за морски шах от ${message.author}. Приеми с реакция ✅ или откажи с ❌`);
      // store pending challenge keyed by message id
      pendingChallenges[prompt.id] = { players: [message.author.id, target.id], channelId: message.channel.id, challenger: message.author.id, opponent: target.id, createdAt: new Date().toISOString() };
      try { await prompt.react('✅'); await prompt.react('❌'); } catch (e) {}

      // if the opponent is the bot, auto-accept and start the game
      if (target.id === client.user.id) {
        try {
          await startTicTacToe(message.channel, message.author.id, client.user.id);
          // inform channel and cleanup the prompt
          await prompt.edit(`🎮 ${target} получи покана за морски шах от ${message.author}. Ботът автоматично прие и играта започна.`).catch(()=>{});
          try { await prompt.reactions.removeAll().catch(()=>{}); } catch (e) {}
        } catch (e) {
          console.error('Failed to start game vs bot:', e);
        }
        delete pendingChallenges[prompt.id];
        return;
      }
      return;
  }

  // ... existing commands continue

  // Монета (ези/тура)
  if (cmd === 'coinflip' || cmd === 'coin') {
    const pick = Math.random() < 0.5 ? 'Ези' : 'Тура';
    return message.reply(`🪙 Резултат: **${pick}**`);
  }

  // ===== !stick (short or long stick) =====
  if (cmd === 'stick') {
    const isShort = Math.random() < 0.5; // 50/50
    const text = isShort ? 'Къса клечка' : 'Дълга клечка';
    const emoji = isShort ? '🥢' : '🪵';
    return message.reply(`${emoji} ${text}`);
  }

  // ===== Counting game: !count [max] =====
  if (cmd === 'count') {
    const sub = (args.shift()||'').trim().toLowerCase();
    const chId = message.channel.id;
    // commands: number -> set max, status, end, or start
    if (sub === 'status') {
      const cfg = countingGames[chId];
      if (!cfg) return message.reply('ℹ️ В този канал няма зададена игра. Използвай `!count <max>` за да зададеш.');
      const s = cfg.active ? `активна (текущо: ${cfg.current}/${cfg.max})` : `задана, но неактивна (max: ${cfg.max})`;
      return message.channel.send(`📊 Статус на играта: ${s}`);
    }
    if (sub === 'end' || sub === 'stop') {
      const cfg = countingGames[chId];
      if (!cfg) return message.reply('ℹ️ Няма активна/задана игра в този канал.');
      // allow only starter or server admin to forcibly end
      const isAdmin = message.member && (message.member.permissions.has(PermissionFlagsBits.Administrator) || message.member.permissions.has(PermissionFlagsBits.ManageGuild));
      if (message.author.id !== cfg.startedBy && !isAdmin) return message.reply('⛔ Само този който е задал играта или администратор може да спре играта.');
      delete countingGames[chId];
      return message.channel.send('🛑 Играта беше прекратена ръчно.');
    }
    // if sub is a number, set max
    if (sub && /^\d+$/.test(sub)) {
      const max = parseInt(sub,10);
      if (max <= 0) return message.reply('⚠️ Максималното число трябва да е по-голямо от 0.');
      countingGames[chId] = { max, active: false, current: 0, startedBy: message.author.id };
      return message.channel.send(`✅ Зададен е брояч до **${max}**. Изпиши ` + '`' + `${getPrefix(guildId)}count` + '`' + ` за да започнеш.`);
    }
    // if no sub and a game config exists, start or show
    const cfg = countingGames[chId];
    if (!cfg) return message.reply('ℹ️ Използване: `!count <max>` за задаване или `!count` за старт на предварително зададена игра.');
    if (cfg.active) return message.reply('⚠️ Играта вече е активна в този канал.');
    cfg.active = true;
    cfg.current = 0;
    return message.channel.send(`🎲 Играта започна! Бройте до **${cfg.max}**. Започва потребител: ${message.author}. Пишете само числа последователно (1,2,3...).`);
  }

  // ===== !fingers / !finger =====
  if (cmd === 'fingers' || cmd === 'finger') {
    try {
      const fingers = ['палец', 'показалец', 'среден', 'безимен', 'кутре'];
      const pick = fingers[Math.floor(Math.random() * fingers.length)];
      const emb = new EmbedBuilder()
        .setTitle('🖐️ Изваден пръст')
        .setDescription(`Резултат: **${pick}**`)
        .setColor(0x1ABC9C)
        .setFooter({ text: 'Команда: !fingers' })
        .setTimestamp();
      return message.channel.send({ embeds: [emb] });
    } catch (e) {
      console.error('fingers cmd error:', e);
      return message.reply('❌ Грешка при изпълнение на командата.');
    }
  }

  // ===== Number commands: !n, !maxn, !lown =====
  if (cmd === 'n') {
    const gset = ensureGuildSettings(message.guild.id);
    const range = gset.numberRange || { min: 1, max: 100 };
    const min = parseInt(range.min, 10) || 1;
    const max = parseInt(range.max, 10) || 100;
    if (min > max) return message.reply('⚠️ Невалиден диапазон (min > max). Админ може да настрои с `!maxn`/`!lown`.');
    const val = Math.floor(Math.random() * (max - min + 1)) + min;
    return message.reply(`🎲 Резултат: **${val}** (диапазон: ${min}–${max})`);
  }
  if (cmd === 'maxn') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('⚠️ Само администратори могат да сменят максимума.');
    }
    const arg = args.shift();
    if (!arg || isNaN(Number(arg))) return message.reply('ℹ️ Използване: `!maxn <число>`');
    const num = parseInt(arg, 10);
    const gset = ensureGuildSettings(message.guild.id);
    gset.numberRange = gset.numberRange || { min: 1, max: 100 };
    gset.numberRange.max = num;
    saveGuildSettings(message.guild.id, gset);
    return message.channel.send(`✅ Максимум за \'!n\' е зададен на **${num}**.`);
  }

  // Personal request command: only for user 307591698857590784
  // refactor: helper to run the request logic so it can be called from multiple places
  async function runRequest(ctxChannel) {
    const T1 = '435805936985178112';
    const T2 = '287574962926125057';
    const notifyText = 'Адаша има нужда от помощ с бота';
    let sendInChannel = false;
    let t1DmFailed = false;
    let t1 = null;
    try { t1 = await client.users.fetch(T1); } catch (e) { t1 = null; }
    if (t1) {
      try {
        await t1.send(notifyText);
      } catch (e) {
        // closed DMs or blocked bot
        sendInChannel = true;
        t1DmFailed = true;
      }
    } else {
      sendInChannel = true;
      t1DmFailed = true;
    }

    let t2 = null;
    try { t2 = await client.users.fetch(T2); } catch (e) { t2 = null; }
    if (t2) {
      try { await t2.send(notifyText); } catch (e) { /* ignore failures for t2 */ }
    }

    if (sendInChannel) {
      try {
        // if T1's DM failed, mention them in-channel so they see the notification
        const mention = t1DmFailed ? `<@${T1}> ` : '';
        await ctxChannel.send(mention + notifyText);
      } catch (e) { /* ignore */ }
    }
  }

  // keep backward-compatible standalone !request command
  if (cmd === 'request') {
    const OWNER_ID = '307591698857590784';
    if (message.author.id !== OWNER_ID) return message.reply('⛔ Нямаш право да използваш тази команда.');
    await runRequest(message.channel);
    return null;
  }

  // Personal category for owner: !myhelp <sub>
  // Top-level owner-only commands: !follow and !unfollow (new)
  if (cmd === 'follow') {
    const OWNER_ID = '307591698857590784';
    if (message.author.id !== OWNER_ID) return message.reply('⛔ Нямаш право да използваш тази команда.');
    const mention = args.shift();
    if (!mention) return message.reply('⚠️ Укажи потребител за следене: `!follow @user`');
    const m = message.mentions.users.first();
    if (!m) return message.reply('⚠️ Невалиден потребител. Трябва да споменеш потребител с @.');
    let followed = {};
    try { followed = JSON.parse(fs.readFileSync('./followed.json','utf8')||'{}'); } catch(e) { followed = {}; }
    const owner = message.author.id;
    followed[owner] = followed[owner] || [];
    if (!followed[owner].includes(m.id)) {
      followed[owner].push(m.id);
      try { fs.writeFileSync('./followed.json', JSON.stringify(followed, null, 2), 'utf8'); } catch(e) {}
      return message.reply(`✅ Започвам да следя съобщенията на ${m.tag} (${m.id}).`);
    } else {
      return message.reply('ℹ️ Вече следиш този потребител.');
    }
  }
  if (cmd === 'unfollow') {
    const OWNER_ID = '307591698857590784';
    if (message.author.id !== OWNER_ID) return message.reply('⛔ Нямаш право да използваш тази команда.');
    const mention = args.shift();
    if (!mention) return message.reply('⚠️ Укажи потребител за спиране на следенето: `!unfollow @user`');
    const m = message.mentions.users.first();
    if (!m) return message.reply('⚠️ Невалиден потребител. Трябва да споменеш потребител с @.');
    let followed = {};
    try { followed = JSON.parse(fs.readFileSync('./followed.json','utf8')||'{}'); } catch(e) { followed = {}; }
    const owner = message.author.id;
    followed[owner] = followed[owner] || [];
    const idx = followed[owner].indexOf(m.id);
    if (idx !== -1) {
      followed[owner].splice(idx,1);
      try { fs.writeFileSync('./followed.json', JSON.stringify(followed, null, 2), 'utf8'); } catch(e) {}
      return message.reply(`✅ Спрях да следя ${m.tag} (${m.id}).`);
    } else {
      return message.reply('ℹ️ Този потребител не беше в списъка ти.');
    }
  }

  if (cmd === 'myhelp') {
    const OWNER_ID = '307591698857590784';
    if (message.author.id !== OWNER_ID) return message.reply('⛔ Нямаш право да използваш тази команда.');
    const sub = (args.shift() || '').toLowerCase();
  if (!sub) {
      // show personal commands header and list as an embed
      const emb = new EmbedBuilder()
        .setTitle('Лични команди на skillet95')
        .setColor(0x5865F2)
        .addFields(
          { name: '!request', value: 'Изпраща заявка за помощ', inline: false },
          { name: '!showmessage', value: 'Показва изтрити съобщения.', inline: false },
          { name: '!news', value: 'Показва добавените нови неща.', inline: false },
          { name: '!follow @user', value: 'Започва да следи съобщенията на посочен потребител (записва се в followed.json).', inline: false },
          { name: '!unfollow @user', value: 'Спира следенето на посочен потребител.', inline: false },
          { name: '!stop', value: 'Изключва бота (прави финален запис и се затваря)', inline: false }
        )
        .setTimestamp();
      // try to send as DM to the owner; if that fails (DMs closed), fallback to channel
      try {
        await message.author.send({ embeds: [emb] });
        return message.reply('✅ Изпратих ти личните команди в лично съобщение (DM).');
      } catch (e) {
        await message.channel.send({ embeds: [emb] });
        return message.reply('⚠️ Не успях да ти изпратя DM — показвам го тук.');
      }
    }
    if (sub === 'request') {
      await runRequest(message.channel);
      return null;
    }
    if (sub === 'showmessage' || sub === 'showmessages') {
      // parse optional args from the remaining args array: [authorId] [limit]
      const authorFilter = (args.shift() || '').trim() || null;
      const limit = Math.min(100, Math.max(1, parseInt(args.shift() || '10', 10) || 10));
      await runShowMessage(message, authorFilter, limit);
      return null;
    }
    if (sub === 'follow') {
      // usage: !myhelp follow @user
      const mention = args.shift();
      if (!mention) return message.reply('⚠️ Укажи потребител за следене: `!myhelp follow @user`');
      const m = message.mentions.users.first();
      if (!m) return message.reply('⚠️ Невалиден потребител. Трябва да споменеш потребител с @.');
      // load followed store
      let followed = {};
      try { followed = JSON.parse(fs.readFileSync('./followed.json','utf8')||'{}'); } catch(e) { followed = {}; }
      const owner = message.author.id;
      followed[owner] = followed[owner] || [];
      if (!followed[owner].includes(m.id)) {
        followed[owner].push(m.id);
        try { fs.writeFileSync('./followed.json', JSON.stringify(followed, null, 2), 'utf8'); } catch(e) {}
        return message.reply(`✅ Започвам да следя съобщенията на ${m.tag} (${m.id}).`);
      } else {
        return message.reply('ℹ️ Вече следиш този потребител.');
      }
    }
    if (sub === 'unfollow') {
      const mention = args.shift();
      if (!mention) return message.reply('⚠️ Укажи потребител за спиране на следенето: `!myhelp unfollow @user`');
      const m = message.mentions.users.first();
      if (!m) return message.reply('⚠️ Невалиден потребител. Трябва да споменеш потребител с @.');
      let followed = {};
      try { followed = JSON.parse(fs.readFileSync('./followed.json','utf8')||'{}'); } catch(e) { followed = {}; }
      const owner = message.author.id;
      followed[owner] = followed[owner] || [];
      const idx = followed[owner].indexOf(m.id);
      if (idx !== -1) {
        followed[owner].splice(idx,1);
        try { fs.writeFileSync('./followed.json', JSON.stringify(followed, null, 2), 'utf8'); } catch(e) {}
        return message.reply(`✅ Спрях да следя ${m.tag} (${m.id}).`);
      } else {
        return message.reply('ℹ️ Този потребител не беше в списъка ти.');
      }
    }
    // (news moved to top-level !news command)
    
    return message.reply('⚠️ Невалидна подкоманда. Използвай `!myhelp request`.');
  }

  // Global listener: if a message author is followed by someone, log and notify owner(s)
  try {
    const followedStore = JSON.parse(fs.readFileSync('./followed.json','utf8')||'{}');
    if (message.author && !message.author.bot) {
      for (const ownerId of Object.keys(followedStore)) {
        const list = followedStore[ownerId] || [];
        if (list.includes(message.author.id)) {
          // append message to followedMessages.json
          try {
            const path = './followedMessages.json';
            const store = fs.existsSync(path) ? JSON.parse(fs.readFileSync(path,'utf8')||'[]') : [];
            store.push({ when: new Date().toISOString(), owner: ownerId, author: { id: message.author.id, tag: message.author.tag }, content: message.content || '', channelId: message.channel?.id || null, guildId: message.guild?.id || null, messageId: message.id });
            // keep last 1000
            while (store.length > 1000) store.shift();
            fs.writeFileSync(path, JSON.stringify(store, null, 2), 'utf8');
          } catch (e) {}
          // DM owner (best-effort)
          try { client.users.fetch(ownerId).then(u => { u.send(`📣 [follow] ${message.author.tag} (${message.author.id}) в ${message.guild ? message.guild.name : 'DM'}#${message.channel?.id || ''}: ${message.content || '—'}`).catch(()=>{}); }).catch(()=>{}); } catch(e) {}
        }
      }
    }
  } catch (e) {}

  // Helper: send deleted messages from SOURCE_SERVER to DEST_SERVER
  async function runShowMessage(invokingMessage, authorFilter, limit) {
    try {
      const src = SOURCE_SERVER; const dst = DEST_SERVER;
      let entries = (deletedMessages[src] || []).slice(0);
      if (authorFilter) entries = entries.filter(e => e.author && String(e.author.id) === String(authorFilter));
      if (!entries.length) return invokingMessage.channel.send('ℹ️ Няма записани изтрити съобщения от източника за дадения филтър.');
      entries = entries.slice(0, limit);
      // find destination guild and a channel to post
      const guild = client.guilds.cache.get(dst) || await client.guilds.fetch(dst).catch(()=>null);
      if (!guild) return invokingMessage.channel.send('⚠️ Дестинационният сървър не е достъпен.');
      // prefer a configured channel in settings[dst].showmessagesChannel
      let targetCh = null;
      try { const chId = settings[dst] && settings[dst].showmessagesChannel; if (chId) targetCh = guild.channels.cache.get(chId) || await guild.channels.fetch(chId).catch(()=>null); } catch(e){}
      // fallback to first writable text channel
      if (!targetCh) {
        for (const ch of guild.channels.cache.values()) {
          try { if (ch.isTextBased && ch.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages)) { targetCh = ch; break; } } catch (e) {}
        }
      }
      if (!targetCh) return invokingMessage.channel.send('⚠️ Няма подходящ текстов канал в дестинационния сървър, където ботът може да пише.');
      // post entries
      for (const e of entries.reverse()) {
        const auth = e.author ? `${e.author.tag} (${e.author.id})` : 'Unknown';
        const emb = new EmbedBuilder().setTitle('🗑️ Изтрито съобщение')
          .addFields(
            { name: 'Автор', value: auth, inline: false },
            { name: 'Съдържание', value: e.content || '—', inline: false },
            { name: 'Канал (източник)', value: `<#${e.channelId}>`, inline: false }
          )
          .setTimestamp(new Date(e.timestamp))
          .setColor(0x95A5A6);
        await safeSend(targetCh, { embeds: [emb] });
      }
      return invokingMessage.channel.send('✅ Изтритите съобщения бяха изпратени.');
    } catch (e) {
      console.error('runShowMessage failed:', e);
      return invokingMessage.channel.send('❌ Възникна грешка при изпращане на изтритите съобщения.');
    }
  }

  // Top-level command: !showmessage [authorId] [limit]
  if (cmd === 'showmessage' || cmd === 'showmessages') {
    const OWNER_ID = '307591698857590784';
    if (message.author.id !== OWNER_ID) return message.reply('⛔ Нямаш право да използваш тази команда.');
    const authorFilter = (args.shift() || '').trim() || null; // optional author ID
    const limit = Math.min(100, Math.max(1, parseInt(args.shift() || '10', 10) || 10));
    await runShowMessage(message, authorFilter, limit);
    return null;
  }

  // Top-level owner-only: !news [text]
  if (cmd === 'news') {
    const OWNER_ID = '307591698857590784';
    if (message.author.id !== OWNER_ID) return message.reply('⛔ Нямаш право да използваш тази команда.');
    const text = args.join(' ').trim();
    if (!text) {
      if (!news || !news.length) return message.channel.send('ℹ️ Няма записани новини.');
      const last = news.slice(-10).reverse();
      const emb = new EmbedBuilder().setTitle('📰 Последни добавки/новини').setColor(0x57F287);
      for (const item of last) {
        const authorTag = `<@${item.by}>`;
        // показваме датата и автора заглавие на полето, а съдържанието като отделна стойност (на български)
        emb.addFields({ name: `${formatDateIso(item.when)} — публикувано от ${authorTag}`, value: item.text || '—', inline: false });
      }
      return message.channel.send({ embeds: [emb] });
    }
    const entry = { when: new Date().toISOString(), by: message.author.id, text };
    news.push(entry);
    try { persistNews(); } catch (e) { console.warn('Failed to persist news:', e?.message); }
    return message.channel.send('✅ Новина записана.');
  }

  // Owner-only: !gametime (personal command for a specific user to notify two IDs)
  if (cmd === 'gametime') {
    // only allow a single specific user to invoke this
    const ALLOWED_USER = '435805936985178112';
    if (message.author.id !== ALLOWED_USER) return message.reply('⛔ Нямаш право да използваш тази команда.');

    // targets to notify
    const TARGETS = ['287574962926125057', '307591698857590784'];
    const text = 'Време е за игри, Rijkuuu ви вика в войс канала';

    // attempt to DM each target; if DM fails for a target, fall back to mentioning them in the same channel
    const failed = [];
    for (const tid of TARGETS) {
      try {
        const user = await client.users.fetch(tid).catch(() => null);
        if (!user) { failed.push(tid); continue; }
        try {
          await user.send(text);
        } catch (e) {
          // DM failed (closed DMs or blocked) — mark as failed so we mention in-channel
          failed.push(tid);
        }
      } catch (e) {
        failed.push(tid);
      }
    }

    try {
      if (failed.length) {
        // mention failed users in-channel so they see the notification
        const mentions = failed.map(id => `<@${id}>`).join(' ');
        await message.channel.send(`${mentions} ${text}`);
        return message.channel.send('✅ Изпращане завършено (някои потребители получиха известие в канала поради затворени/липсващи DM).');
      } else {
        return message.channel.send('✅ Известията бяха изпратени като лично съобщение.');
      }
    } catch (e) {
      return message.reply('⚠️ Възникна грешка при изпращането на известия.');
    }
  }
  if (cmd === 'lown') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('⚠️ Само администратори могат да сменят минимума.');
    }
    const arg = args.shift();
    if (!arg || isNaN(Number(arg))) return message.reply('ℹ️ Използване: `!lown <число>`');
    const num = parseInt(arg, 10);
    const gset = ensureGuildSettings(message.guild.id);
    gset.numberRange = gset.numberRange || { min: 1, max: 100 };
    gset.numberRange.min = num;
    saveGuildSettings(message.guild.id, gset);
    return message.channel.send(`✅ Минимум за \'!n\' е зададен на **${num}**.`);
  }

  // ===== !askbot - simple yes/no oracle (Игри секция) =====
  if (cmd === 'askbot') {
    const q = args.join(' ').trim();
    if (!q) return message.reply('ℹ️ Използване: `!askbot <въпрос>`');
    // lightweight per-user cooldown (10s) to avoid spam
    const key = `askbot:${message.guild.id}:${message.author.id}`;
    const now = Date.now();
    if (!global.__askbot_cooldowns) global.__askbot_cooldowns = {};
    const last = global.__askbot_cooldowns[key] || 0;
    if (now - last < 10_000) return message.reply('⏳ Моля изчакай малко преди да питаш отново.');
    global.__askbot_cooldowns[key] = now;
    // respond only with 'ДА' or 'НЕ'
    const answer = Math.random() < 0.5 ? 'ДА' : 'НЕ';
    return message.channel.send(answer);
  }

  // ===== !pay (donation email) =====
  // Показва текст с покана за дарение и имейл, който е в settings.json -> donationEmail
  if (cmd === 'pay') {
    try {
      const email = (settings.donationEmail || '').trim();
      if (!email) return message.reply('ℹ️ Все още не е зададен имейл за дарения. Свържи се с администратор.');
      const emb = new EmbedBuilder()
        .setTitle('🙏 Подкрепете бота')
        .setDescription('Ако желаете бота да съществува, направете дарение по PayPal на следния имейл:')
        .addFields({ name: 'PayPal email', value: email })
        .setColor(0x57F287)
        .setTimestamp();
      return sendEmbedOrText(message.channel, emb, `Ако желаете бота да съществува, направете дарение: ${email}`);
    } catch (e) {
      console.error('pay cmd error:', e);
      return message.reply('❌ Грешка.');
    }
  }

  // === !tell (admins) ===
  // Usage: !tell #channel текст...   -> изпраща текста в посочения канал
  //        !tell link <messageLink>  -> препраща съобщение по discord message link
  if (cmd === 'tell') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('⚠️ Нямаш права да използваш тази команда.');
    }
    const mode = (args.shift() || '').toLowerCase();
    if (!mode) return message.reply('ℹ️ Използване: `!tell #канал текст...` или `!tell link <messageLink>`');

    if (mode === 'link') {
      const link = args.shift();
      if (!link) return message.reply('ℹ️ Използване: `!tell link <messageLink>`');
      const m = link.match(/channels\/(\d+)\/(\d+)\/(\d+)/);
      if (!m) return message.reply('❌ Невалиден message link. Формат: https://discord.com/channels/<guildId>/<channelId>/<messageId>');
      const [, gid, cid, mid] = m;
      try {
        const srcCh = await client.channels.fetch(cid).catch(()=>null);
        if (!srcCh || !srcCh.isTextBased()) return message.reply('❌ Невалиден канал в линка.');
        const orig = await srcCh.messages.fetch(mid).catch(()=>null);
        if (!orig) return message.reply('❌ Не намерих съобщението.');
        const content = orig.content || '';
        const embeds = orig.embeds || [];
  // destination: if user mentioned a channel in the command, use it; otherwise current channel
  const dest = message.mentions.channels.first() || message.channel;
  await safeSend(dest, { content: content, embeds });
  return message.reply(`✅ Съобщението беше препратено в <#${dest.id}>.`);
      } catch (e) {
        console.error('tell/link error:', e);
        return message.reply('❌ Грешка при препращане.');
      }
    }

    // channel mode: mode should be a channel mention or id
    // try to get mentioned channel first
    const target = message.mentions.channels.first() || await client.channels.fetch(mode).catch(()=>null);
    if (!target) return message.reply('ℹ️ Посочи канал: `!tell #канал текст...`');
    const text = args.join(' ');
    if (!text) return message.reply('ℹ️ Посочи текст за изпращане.');
  await safeSend(target, { content: text });
    return message.reply(`✅ Изпратено в <#${target.id}>`);
  }

  if (cmd === 'achievements') {
    const keys = Object.keys(userData.achievements).filter(k => userData.achievements[k]);
    if (!keys.length) return message.reply('❌ Все още нямаш отключени постижения.');
    const list = keys.map(k => ACH[k] || k).join('\n');
    return message.reply(`🏆 Твоите постижения:\n${list}`);
  }
  // 🎲 Хвърляне на зар (1–6)
if (cmd === 'dice') {
  const result = Math.floor(Math.random() * 6) + 1; // число от 1 до 6
  return message.reply(`🎲 Хвърлих зара и се падна: **${result}**`);
}
// ✊🤚✌️ Камък – Хартия – Ножица
if (cmd === 'rps') {
  // нормализиране на входа (приема BG/EN и емоджита)
  const raw = (args[0] || '').toLowerCase();
  const map = {
    'камък': 'rock', 'kamen': 'rock', 'rock': 'rock', '✊': 'rock',
    'хартия': 'paper', 'hartia': 'paper', 'paper': 'paper', '✋': 'paper',
    'ножица': 'scissors', 'ножици': 'scissors', 'nojica': 'scissors', 'scissors': 'scissors', '✌': 'scissors', '✌️': 'scissors'
  };
  const user = map[raw];

  if (!user) {
    return message.reply('❌ Използвай: `!rps <камък|хартия|ножица>` (приемат се и ✊ ✋ ✌️ / rock|paper|scissors)');
  }

  const choices = ['rock', 'paper', 'scissors'];
  const bot = choices[Math.floor(Math.random() * choices.length)];
  const pretty = { rock: 'камък', paper: 'хартия', scissors: 'ножица' };

  let result;
  if (user === bot) {
    result = '🤝 Равенство!';
  } else if (
    (user === 'rock' && bot === 'scissors') ||
    (user === 'scissors' && bot === 'paper') ||
    (user === 'paper' && bot === 'rock')
  ) {
    result = '🎉 Ти победи!';
  } else {
    result = '😅 Аз победих!';
  }

  const emb = new EmbedBuilder()
    .setTitle('✊🤚✌️ Камък – Хартия – Ножица')
    .setDescription(`Ти: **${pretty[user]}**\nАз: **${pretty[bot]}**\n\n${result}`)
    .setColor(0x5865F2);

  // ако имаш помощника sendEmbedOrText – използвай него; иначе изпрати embed-а директно
  return (typeof sendEmbedOrText === 'function')
    ? sendEmbedOrText(message.channel, emb, `Ти: ${pretty[user]}\nАз: ${pretty[bot]}\n${result}`)
    : message.channel.send({ embeds: [emb] });
}


  // ===== СОЦИАЛНИ МРЕЖИ =====
if (cmd === 'socials') {
  console.log('[cmd] socials');
  const gset = ensureGuildSettings(message.guild.id);
  gset.customSocials = gset.customSocials || [];

  if (gset.customSocials.length === 0) {
    return message.reply("ℹ️ Все още няма добавени социални мрежи. Използвай `!addsocial <линк>` за да добавиш.");
  }
  const desc = gset.customSocials.map((u, i) => `${i + 1}. ${u}`).join('\n');
  const emb = new EmbedBuilder()
    .setTitle('🌐 Социални мрежи на сървъра')
    .setDescription(desc)
    .setColor(0x57F287);

  return sendEmbedOrText(message.channel, emb, desc);
}
if (cmd === 'addsocial') {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return message.reply("⚠️ Само администратори могат да добавят социални линкове.");
  }
  const url = args.join(" ").trim();
  if (!url) {
    return message.reply("❌ Използвай: `!addsocial <линк>`");
  }
  const gset = ensureGuildSettings(message.guild.id);
  gset.customSocials = gset.customSocials || [];

  if (gset.customSocials.includes(url)) {
    return message.reply("⚠️ Този линк вече съществува в списъка.");
  }
  gset.customSocials.push(url);
  saveSettings(); 
  return message.reply(`✅ Линкът **${url}** беше добавен успешно.`);
}

if (cmd === 'removesocial') {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return message.reply("⚠️ Само администратори могат да премахват социални линкове.");
  }
  if (!args[0]) {
    return message.reply("❌ Използвай: `!removesocial <линк|номер от !socials>`");
  }
  const gset = ensureGuildSettings(message.guild.id);
  gset.customSocials = gset.customSocials || [];

  let removed;
  const a = args[0];

  if (/^\d+$/.test(a)) {
    const idx = parseInt(a, 10) - 1;
    if (idx < 0 || idx >= gset.customSocials.length) {
      return message.reply("⚠️ Невалиден номер. Виж `!socials` за номерацията.");
    }
    removed = gset.customSocials.splice(idx, 1)[0];
  } else {
    const i = gset.customSocials.findIndex(u => u.trim() === a.trim());
    if (i === -1) {
      return message.reply("⚠️ Този линк не е намерен в списъка.");
    }
    removed = gset.customSocials.splice(i, 1)[0];
  }

  saveSettings(); 
  return message.reply(`✅ Премахнат: **${removed}**`);
}
  if (cmd === 'top') {
    const g = ensureGuildStore(guildId);
    const top = Object.entries(g.users)
      .sort((a,b) => Object.keys(b[1].achievements).length - Object.keys(a[1].achievements).length)
      .slice(0, 5)
      .map(([id, data], i) => `${i+1}. <@${id}> — ${Object.keys(data.achievements).length} постижения`);
    return message.channel.send(top.length ? `📊 Топ 5 (този сървър):\n${top.join('\n')}` : '❌ Няма класация.');
  }

  if (cmd === 'stats') {
    const todayKey = new Date().toISOString().split('T')[0];
    const todayCount = userData.dailyCounts?.[todayKey] || 0;
    const lvl = computeLevel(userData);
    return message.reply(
      `📊 Статистика за <@${userId}> (този сървър):\n` +
      `🆙 Ниво: ${lvl}\n` +
      `📝 Съобщения: ${userData.messages}\n` +
      `🗓️ Днес: ${todayCount}\n` +
      `🖼️ Мемета/снимки: ${userData.memesCount}\n` +
      `💬 Споменавания: ${userData.mentions}\n` +
      `💖 Получени реакции: ${userData.reactionsReceived} | ⚡ Поставени реакции: ${userData.reactionsGiven}\n` +
      `🔥 Активни дни: ${Object.keys(userData.activeDays).length}\n` +
      `🏆 Постижения: ${Object.keys(userData.achievements).length}`
    );
  }

  if (cmd === 'today') {
    const g = ensureGuildStore(guildId);
    const todayKey = new Date().toISOString().split('T')[0];
    const rows = Object.entries(g.users)
      .map(([id, d]) => ({ id, n: d.dailyCounts?.[todayKey] || 0 }))
      .filter(r => r.n > 0)
      .sort((a,b) => b.n - a.n)
      .slice(0, 20);
    if (!rows.length) return message.channel.send('📭 Днес няма съобщения.');
    const lines = await Promise.all(rows.map(async (r,i) => {
      const m = await message.guild.members.fetch(r.id).catch(()=>null);
      const label = m ? m.toString() : `<@${r.id}>`;
      return `${i+1}. ${label} — **${r.n}**`;
    }));
    const emb = new EmbedBuilder().setTitle('🗓️ Топ активни ДНЕС (този сървър)').setDescription(lines.join('\n')).setColor(0xFEE75C);
    return sendEmbedOrText(message.channel, emb, `🗓️ Топ активни ДНЕС:\n${lines.join('\n')}`);
  }

  if (cmd === 'messages') {
    const t = message.mentions.users.first() || message.author;
    await ensureUser(message.guild, t.id);
    const d = store[guildId].users[t.id];
    return message.channel.send(`✉️ ${t} има **${d?.messages || 0}** съобщения (в този сървър).`);
  }

  // ===== RP (с mention) =====
  const needMention = (t) => { if (!t) { message.reply('ℹ️ Ползвай: `!команда @user`'); return false; } return true; };
  if (cmd === 'kill'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `☠️ ${message.author} уби ${t}!`,'kill'); }
  if (cmd === 'pat'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `🐾 ${message.author} погали ${t}.`,'pat'); }
  if (cmd === 'slap'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `🖐️ ${message.author} зашлеви ${t}!`,'slap'); }
  if (cmd === 'hug'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `🤗 ${message.author} прегърна ${t}.`,'hug'); }
  if (cmd === 'kiss'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `💋 ${message.author} целуна ${t}.`,'kiss'); }
  if (cmd === 'shakehands'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `🤝 ${message.author} стисна ръката на ${t}.`,'shakehands'); }
  if (cmd === 'massage'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `💆 ${message.author} направи релаксиращ масаж на ${t}.`,'massage'); }
  if (cmd === 'wave'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `👋 ${message.author} помаха на ${t}.`,'wave'); }
  if (cmd === 'poke'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `👉 ${message.author} сръчка ${t}.`,'poke'); }
  if (cmd === 'marry'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `💍 ${message.author} се ожени за ${t}!`,'marry'); }
  if (cmd === 'divorce'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `💔 ${message.author} се разведе с ${t}.`,'divorce'); }
  if (cmd === 'highfive'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `✋ ${message.author} плесна пет с ${t}!`,'highfive'); }
  if (cmd === 'give'){
    const t=message.mentions.users.first(); if(!needMention(t))return;
    const item=args.filter(a=>!/^<@!?\d+>$/.test(a)).join(' ').trim();
    if(!item) return message.reply('ℹ️ Ползвай: `!give предмет @user`');
    return sendRPDynamic(message.channel, `🎁 ${message.author} даде **${item}** на ${t}.`,'give');
  }
  if (cmd === 'take'){
    const t=message.mentions.users.first(); if(!needMention(t))return;
    const item=args.filter(a=>!/^<@!?\d+>$/.test(a)).join(' ').trim();
    if(!item) return message.reply('ℹ️ Ползвай: `!take <предмет> @user`');
    return sendRPDynamic(message.channel, `🫳 ${message.author} взе **${item}** от ${t}.`,'give');
  }
  if (cmd === 'fight'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `🥊 ${message.author} се бие с ${t}!`,'fight'); }
  if (cmd === 'sell'){ const t=message.mentions.users.first(); if(!needMention(t))return; return sendRPDynamic(message.channel, `🛒 ${message.author} „продаде“ нещо на ${t}.`,'sell'); }
  if (cmd === 'sell1'){
    const t=message.mentions.users.first(); if(!needMention(t))return;
    const item=args.filter(a=>!/^<@!?\d+>$/.test(a)).join(' ').trim();
    if(!item) return message.reply('ℹ️ Ползвай: `!sell1 <предмет> @user`');
    return sendRPDynamic(message.channel, `💼 ${message.author} продаде **${item}** на ${t}.`,'sell1');
  }
  if (cmd === 'kick') {
  const t = message.mentions.users.first();
  if (!t) return message.reply("⚠️ Трябва да споменеш потребител! Използвай: `!kick @user`");

  const gif = getCustomGif('kick');

  const embed = new EmbedBuilder()
    .setDescription(`👢 ${message.author} изрита ${t}!`)
    .setColor(0xff0000);

  if (gif) embed.setImage(gif);

  return message.channel.send({ embeds: [embed] });
}

if (cmd === 'tickle') {
  const t = message.mentions.users.first();
  if (!t) return message.reply('ℹ️ Ползвай: `!tickle @user`');

  const gif = getCustomGif('tickle');

  const embed = new EmbedBuilder()
    .setDescription(`🤣 ${message.author} гъделичка ${t}!`)
    .setColor(0xFFC83D);

  if (gif) embed.setImage(gif);

  return message.channel.send({ embeds: [embed] });
}
if (cmd === 'punch') {
  const t = message.mentions.users.first();
  if (!t) return message.reply('⚠️ Трябва да споменеш потребител! Използвай: `!punch @user`');

  const gif = getCustomGif('punch');

  const embed = new EmbedBuilder()
    .setDescription(`👊 ${message.author} удари ${t}!`)
    .setColor(0xff4500);

  if (gif) embed.setImage(gif);

  return message.channel.send({ embeds: [embed] });
}


  // ===== RP (без mention) =====
  if (cmd === 'yay')      return sendRPDynamic(message.channel, `🎉 ${message.author} се зарадва!`,'yay');
  if (cmd === 'run')      return sendRPDynamic(message.channel, `🏃 ${message.author} побяга.`,'run');
  if (cmd === 'lay')      return sendRPDynamic(message.channel, `🛏️ ${message.author} полегна.`,'lay');
  if (cmd === 'attack')   return sendRPDynamic(message.channel, `⚔️ ${message.author} се приготвя за нападение!`,'attack');
  if (cmd === 'defense') return sendRPDynamic(message.channel, `🛡️ ${message.author} се защитава!`,'deffense');
  if (cmd === 'cry')      return sendRPDynamic(message.channel, `😭 ${message.author} плаче.`,'cry');
  if (cmd === 'sad')      return sendRPDynamic(message.channel, `😔 ${message.author} е тъжен.`,'sad');
  if (cmd === 'happy')    return sendRPDynamic(message.channel, `😄 ${message.author} е весел!`,'happy');
  if (cmd === 'angry')    return sendRPDynamic(message.channel, `😠 ${message.author} е ядосан!`,'angry');
  // generic drink (raise a glass)
  if (cmd === 'drink') {
    return sendRPDynamic(message.channel, `🍺 ${message.author} вдигна чаша!`, 'drink');
  }

  // Individual drink commands (single-prefix) - user will add gifs manually to gifs.json
  if (cmd === 'coffee' || cmd === 'coffe' || cmd === 'кафе') {
    return sendRPDynamic(message.channel, `☕️ ${message.author} си направи кафе.`, 'drink_coffee');
  }
  if (cmd === 'beer' || cmd === 'бира' || cmd === 'пиво') {
    return sendRPDynamic(message.channel, `🍺 ${message.author} вдигна биричка.`, 'drink_beer');
  }
  if (cmd === 'tea' || cmd === 'чай') {
    return sendRPDynamic(message.channel, `🍵 ${message.author} отпи чай.`, 'drink_tea');
  }
  if (cmd === 'water' || cmd === 'вода') {
    return sendRPDynamic(message.channel, `💧 ${message.author} изпие вода.`, 'drink_water');
  }
  if (cmd === 'vodka' || cmd === 'водка') {
    return sendRPDynamic(message.channel, `🍸 ${message.author} вдигна водка.`, 'drink_vodka');
  }
  if (cmd === 'cola' || cmd === 'кола') {
    return sendRPDynamic(message.channel, `🥤 ${message.author} изпие кола.`, 'drink_cola');
  }
  if (cmd === 'soda' || cmd === 'сода') {
    return sendRPDynamic(message.channel, `🥤 ${message.author} изпие сода.`, 'drink_soda');
  }
  if (cmd === 'whiskey' || cmd === 'whisky' || cmd === 'уиски') {
    return sendRPDynamic(message.channel, `🥃 ${message.author} изпива уиски.`, 'drink_whiskey');
  }
  if (cmd === 'hungry')   return sendRPDynamic(message.channel, `😋 ${message.author} огладня.`,'hungry');
  if (cmd === 'cheers')   return sendRPDynamic(message.channel, `🥂 ${message.author} каза: Наздраве!`,'cheers');
  if (cmd === 'eat')      return sendRPDynamic(message.channel, `🍽️ ${message.author} похапва.`,'eat');
  if (cmd === 'stare')    return sendRPDynamic(message.channel, `👀 ${message.author} се втренчи.`,'stare');
  if (cmd === 'cringe')   return sendRPDynamic(message.channel, `😬 ${message.author} кринджна.`,'cringe');
  if (cmd === 'laugh')    return sendRPDynamic(message.channel, `😂 ${message.author} се залива от смях.`,'laugh');
  if (cmd === 'huh')      return sendRPDynamic(message.channel, `🤨 ${message.author} изглежда недоумява.`,'huh');
  if (cmd === 'money')    return sendRPDynamic(message.channel, `💸 ${message.author} „вали“ пари.`,'money');
  if (cmd === 'fly')      return sendRPDynamic(message.channel, `🕊️ ${message.author} полетя!`,'fly');
  if (cmd === 'jump')     return sendRPDynamic(message.channel, `🪂 ${message.author} подскочи.`,'jump');
  if (cmd === 'buy') {
    const item = args.join(' ').trim();
    return sendRPDynamic(message.channel, item ? `🛍️ ${message.author} купи **${item}**.` : `🛍️ ${message.author} купи нещо интересно.`, 'buy');
  }

  // ===== Suggest / Feedback =====
  if (cmd === 'suggest') {
    const text = args.join(' ').trim();
    if (!text) return message.reply('ℹ️ Ползвай: `!suggest <текст>`');
    const ch = getGuildChannel(message.guild, 'suggest', 'SUGGEST_CHANNEL_ID');
    if (!ch) return message.reply('⚠️ Няма зададен канал: `!setchannel suggest #канал`');
    const emb = new EmbedBuilder().setTitle('💡 Ново предложение')
      .addFields({ name:'От', value:`${message.author} (${message.author.id})` },{ name:'Канал', value:`${message.channel}` },{ name:'Текст', value:text })
      .setTimestamp(new Date()).setColor(0xFEE75C);
    await sendEmbedOrText(ch, emb, `💡 Предложение от ${message.author} (${message.author.id})\nКанал: ${message.channel}\nТекст: ${text}`);
    return message.reply('✅ Изпратено. Благодарим!');
  }
  if (cmd === 'feedback') {
    const text = args.join(' ').trim();
    if (!text) return message.reply('ℹ️ Ползвай: `!feedback <текст>`');
    const ch = getGuildChannel(message.guild, 'feedback', 'FEEDBACK_CHANNEL_ID');
    if (!ch) return message.reply('⚠️ Няма зададен канал: `!setchannel feedback #канал`');
    const emb = new EmbedBuilder().setTitle('📝 Обратна връзка')
      .addFields({ name:'От', value:`${message.author} (${message.author.id})` },{ name:'Канал', value:`${message.channel}` },{ name:'Текст', value:text })
      .setTimestamp(new Date()).setColor(0x57F287);
    await sendEmbedOrText(ch, emb, `📝 Обратна връзка от ${message.author} (${message.author.id})\nКанал: ${message.channel}\nТекст: ${text}`);
    return message.reply('✅ Изпратено. 🙏');
  }

  // ===== Report =====
  if (cmd === 'report') {
    const reported = message.mentions.users.first();
    if (!reported) {
      return message.reply('ℹ️ Ползвай: `!report @user причина | доказателства`\n• Като доказателства може да качите скрийншоти, линкове и прочие.');
    }
    const raw = message.content.replace(/^!report\s+<@!?(\d+)>\s*/i, '').trim();
    if (!raw) return message.reply('ℹ️ Добави причина и доказателства (разделени с `|`).');

    let reason = raw, evidence = 'не са предоставени';
    if (raw.includes('|')) {
      const [l, r] = raw.split('|');
      reason = (l || '').trim() || '—';
      evidence = (r || '').trim() || 'не са предоставени';
    }
    if (message.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
      message.delete().catch(() => {});
    }

    const reportChannel = getGuildChannel(message.guild, 'reports', 'REPORT_CHANNEL_ID');
    const payload =
      `🚨 **REPORT**\n` +
      `👤 От: ${message.author} (${message.author.id})\n` +
      `🎯 Срещу: ${reported} (${reported.id})\n` +
      `📄 Причина: ${reason}\n` +
      `📎 Доказателства: ${evidence}\n` +
      `📍 Канал: ${message.channel}\n` +
      `⏰ Време: ${new Date().toLocaleString()}`;

    if (reportChannel) await safeSend(reportChannel, payload);
    else { const owner = await message.guild.fetchOwner().catch(()=>null); owner && await owner.send(payload).catch(()=>{}); }

    await message.author.send('Докладът е изпратен към админите и се обработва, моля изчакайте.').catch(()=>{});
    return;
  }

  // ===== Админ gate =====
  const adminOnly = [
    'del','resetachievements','resetmessages','resetdays','resetmentions','resetall',
    'addmessages','rmessages','topres','achsetup','setchannel','showchannels',
    'addgif','delgif','listgifs','testgifs','pin','unpin','check','addsocial','monthly','active','save-all',
    'ask','ask2'
  ];
  if (adminOnly.includes(cmd)) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('⛔ Само администратори.');
    }
  }

  // ===== !setdonation =====
  if (cmd === 'setdonation') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('⛔ Само администратори могат да задават имейла за дарения.');
    }
    const raw = args.join(' ').trim();
    if (!raw) return message.reply('ℹ️ Използване: `!setdonation <email>` или `!setdonation off` за изключване.');
    if (raw.toLowerCase() === 'off') {
      settings.donationEmail = '';
      saveSettings();
      return message.channel.send('✅ Имейлът за дарения беше премахнат.');
    }
    // прост валидатор на email (не перфектен, но достатъчен)
    const email = raw;
    const emailRe = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
    if (!emailRe.test(email)) return message.reply('❌ Невалиден email формат.');
    settings.donationEmail = email;
    saveSettings();
    return message.channel.send(`✅ Имейлът за дарения беше зададен: ${email}`);
  }

  // ===== !createrole =====
  if (cmd === 'createrole') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('⛔ Нямаш права (Manage Roles).');
    }
    // named color map (common simple names)
    const namedColors = {
      black: '#000000',
      white: '#FFFFFF',
      red: '#FF0000',
      maroon: '#800000',
      green: '#00FF00',
      lime: '#00FF00',
      olive: '#808000',
      navy: '#000080',
      blue: '#0000FF',
      skyblue: '#87CEEB',
      teal: '#008080',
      cyan: '#00FFFF',
      aqua: '#00FFFF',
      yellow: '#FFFF00',
      gold: '#FFD700',
      orange: '#FFA500',
      coral: '#FF7F50',
      salmon: '#FA8072',
      purple: '#800080',
      violet: '#EE82EE',
      magenta: '#FF00FF',
      pink: '#FFC0CB',
      fuchsia: '#FF00FF',
      grey: '#808080',
      gray: '#808080',
      silver: '#C0C0C0',
      brown: '#8B4513',
      sienna: '#A0522D',
      tan: '#D2B48C',
      beige: '#F5F5DC',
      mint: '#98FF98',
      seafoam: '#9FE2BF',
      ivory: '#FFFFF0',
      charcoal: '#36454F',
      midnight: '#191970',
      indigo: '#4B0082',
    };

    // collect name parts until a color-like token is found
    const nameParts = [];
    while (args.length && !/^#?[0-9A-Fa-f]{3,6}$/.test(args[0]) && !namedColors.hasOwnProperty(args[0].toLowerCase())) {
      nameParts.push(args.shift());
    }
    const name = nameParts.join(' ').trim();
    let color = args.shift();
    if (!name) return message.reply('ℹ️ Използване: `!createrole <име> <цвят>` (напр. `!createrole "Нов Рол" #FF8800` или `!createrole "Нов Рол" yellow`)');

    // normalize color: support named colors and hex (with or without #)
    if (color) {
      const key = color.toLowerCase();
      if (namedColors.hasOwnProperty(key)) {
        color = namedColors[key];
      } else if (/^[0-9A-Fa-f]{3}$/.test(color)) {
        color = `#${color}`;
      } else if (/^[0-9A-Fa-f]{6}$/.test(color)) {
        color = `#${color}`;
      } else if (/^#?[0-9A-Fa-f]{3,6}$/.test(color)) {
        // ensure leading #
        if (!color.startsWith('#')) color = `#${color}`;
      } else {
        // not a valid color token, treat it as part of the name
        // put it back into name if it looks like a word
        args.unshift(color);
        color = undefined;
      }
    }

    try {
      const createOpts = { name };
      if (color) createOpts.color = color;
      const role = await message.guild.roles.create({ name: createOpts.name, color: createOpts.color || undefined, reason: `Created by ${message.author.tag}` });
      return message.channel.send(`✅ Ролята **${role.name}** беше създадена.`);
    } catch (e) {
      console.error('createrole error:', e);
      return message.reply('❌ Не успях да създам ролята. Провери правата ми и позицията на ролята.');
    }
  }

  // ===== Админ команди =====
  // ===== !editrole =====
  if (cmd === 'editrole') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('⛔ Нямаш права (Manage Roles).');
    }

    // role mention or id or name
    const target = args.shift();
    if (!target) return message.reply('ℹ️ Използване: `!editrole @role <ново име> <цвят>`');
    // resolve role
    let role = null;
    // mention
    const mentionMatch = target.match(/^<@&([0-9]+)>$/);
    if (mentionMatch) role = message.guild.roles.cache.get(mentionMatch[1]);
    if (!role && /^\d+$/.test(target)) role = message.guild.roles.cache.get(target);
    if (!role) role = message.guild.roles.cache.find(r => r.name.toLowerCase() === target.toLowerCase());
    if (!role) return message.reply('❌ Не намерих ролята. Моля използвай mention, id или точно име.');

    // check bot permissions and role position
    const me = message.guild.members.me;
    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
      return message.reply('❌ Нямам Manage Roles право.');
    }
    if (me.roles.highest.position <= role.position) {
      return message.reply('❌ Ролята е с позиция по-висока или равна на моята. Нямам право да я редактирам.');
    }

    // named color map (reuse same set as createrole)
    const namedColors = {
      black: '#000000', white: '#FFFFFF', red: '#FF0000', maroon: '#800000',
      green: '#00FF00', lime: '#00FF00', olive: '#808000', navy: '#000080',
      blue: '#0000FF', skyblue: '#87CEEB', teal: '#008080', cyan: '#00FFFF',
      aqua: '#00FFFF', yellow: '#FFFF00', gold: '#FFD700', orange: '#FFA500',
      coral: '#FF7F50', salmon: '#FA8072', purple: '#800080', violet: '#EE82EE',
      magenta: '#FF00FF', pink: '#FFC0CB', fuchsia: '#FF00FF', grey: '#808080',
      gray: '#808080', silver: '#C0C0C0', brown: '#8B4513', sienna: '#A0522D',
      tan: '#D2B48C', beige: '#F5F5DC', mint: '#98FF98', seafoam: '#9FE2BF',
      ivory: '#FFFFF0', charcoal: '#36454F', midnight: '#191970', indigo: '#4B0082'
    };

    // gather new name parts until a color token
    const newNameParts = [];
    while (args.length && !/^#?[0-9A-Fa-f]{3,6}$/.test(args[0]) && !namedColors.hasOwnProperty(args[0].toLowerCase())) {
      newNameParts.push(args.shift());
    }
    const newName = newNameParts.join(' ').trim();
    let newColor = args.shift();

    if (newColor) {
      const key = newColor.toLowerCase();
      if (namedColors.hasOwnProperty(key)) {
        newColor = namedColors[key];
      } else if (/^[0-9A-Fa-f]{3}$/.test(newColor)) {
        newColor = `#${newColor}`;
      } else if (/^[0-9A-Fa-f]{6}$/.test(newColor)) {
        newColor = `#${newColor}`;
      } else if (/^#?[0-9A-Fa-f]{3,6}$/.test(newColor)) {
        if (!newColor.startsWith('#')) newColor = `#${newColor}`;
      } else {
        // not a color token
        args.unshift(newColor);
        newColor = undefined;
      }
    }

    const editObj = {};
    if (newName) editObj.name = newName;
    if (newColor) editObj.color = newColor;
    if (!Object.keys(editObj).length) return message.reply('ℹ️ Нищо за редактиране. Укажи ново име и/или цвят.');

    try {
      await role.edit(editObj, `Edited by ${message.author.tag}`);
      return message.channel.send(`✅ Ролята беше обновена: **${role.name}**`);
    } catch (e) {
      console.error('editrole error:', e);
      return message.reply('❌ Не успях да редактирам ролята. Провери правата и позицията ми.');
    }
  }

  // ===== !removerole / !remove =====
  if (cmd === 'removerole' || cmd === 'remove') {
    if (!message.member.permissions.has(PermissionFlagsBits.ManageRoles) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('⛔ Само администратори/ManageRoles.');
    }
    const target = args.shift();
    if (!target) return message.reply('ℹ️ Използване: `!removerole @role`');

    let role = null;
    const mentionMatch = target.match(/^<@&([0-9]+)>$/);
    if (mentionMatch) role = message.guild.roles.cache.get(mentionMatch[1]);
    if (!role && /^\d+$/.test(target)) role = message.guild.roles.cache.get(target);
    if (!role) role = message.guild.roles.cache.find(r => r.name.toLowerCase() === target.toLowerCase());
    if (!role) return message.reply('❌ Не намерих ролята.');

    const me = message.guild.members.me;
    if (!me.permissions.has(PermissionsBitField.Flags.ManageRoles)) return message.reply('❌ Нямам Manage Roles право.');
    if (me.roles.highest.position <= role.position) return message.reply('❌ Ролята е с по-висока или равна позиция спрямо мен.');

    try {
      await role.delete(`Deleted by ${message.author.tag}`);
      return message.channel.send(`🗑️ Ролята **${role.name}** беше изтрита.`);
    } catch (e) {
      console.error('removerole error:', e);
      return message.reply('❌ Не успях да изтрия ролята. Провери правата и позицията ми.');
    }
  }

  if (cmd === 'del') {
    const amount = parseInt(args[0], 10);
    if (isNaN(amount) || amount < 1 || amount > 200) return message.reply('ℹ️ `!del <1-200> [@user]`');
    const target = message.mentions.users.first() || null;

    try {
      const now = Date.now();
      const maxAge = 14 * 24 * 60 * 60 * 1000; // 14 days

      // collect messages to delete (respecting optional target filter)
      let collected = [];
      let beforeId = null;
      while (collected.length < amount) {
        const fetchLimit = 100; // max per fetch
        const options = { limit: fetchLimit };
        if (beforeId) options.before = beforeId;
        const fetched = await message.channel.messages.fetch(options);
        if (!fetched.size) break;

        // iterate in chronological order (newest first)
        for (const m of fetched.values()) {
          if (collected.length >= amount) break;
          if (now - m.createdTimestamp > maxAge) continue; // too old
          if (target && m.author.id !== target.id) continue;
          collected.push(m);
        }

        // prepare for next fetch
        beforeId = fetched.last()?.id;
        if (fetched.size < fetchLimit) break;
      }

      if (!collected.length) return message.reply('⚠️ Няма подходящи съобщения за изтриване.');

      // bulk delete in chunks of up to 100
      let deletedCount = 0;
      while (collected.length) {
        const chunk = collected.splice(0, 100);
        const ids = chunk.map(m => m.id);
        const res = await message.channel.bulkDelete(ids, true).catch(() => null);
        if (res) deletedCount += res.size || 0;
        else { /* continue attempting remaining */ }
        // small delay to be kind to the API (not strictly necessary)
        await new Promise(r => setTimeout(r, 250));
      }

      const infoMsg = await message.channel.send(`🧹 Изтрити: **${deletedCount}** ${target ? `на ${target}` : ''}.`);
      setTimeout(() => infoMsg.delete().catch(() => { }), 4000);

      const log = getGuildChannel(message.guild, 'logs', 'LOG_CHANNEL_ID');
      log && log.send(`📝 DELETE | 👮 ${message.author} | ${message.channel} | ${deletedCount}${target ? ` | 🎯 ${target}` : ''}`).catch(() => { });
      return;
    } catch (e) {
      console.error('del command error:', e);
      return message.reply('❌ Грешка при изтриване.');
    }
  }

  // Admin: !ask — post announcement and mention @everyone
  if (cmd === 'ask') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('⛔ Само администратори.');
    // usage: !ask [#channel] <text...>
    let targetCh = message.mentions.channels.first() || null;
    if (targetCh) args.shift();
    const text = args.join(' ').trim();
    if (!text) return message.reply('ℹ️ Използване: `!ask [#канал] <текст>`');
    const ch = targetCh || message.channel;
    try {
      await ch.send(`@everyone ${text}`);
      return message.channel.send('✅ Обявата беше публикувана.');
    } catch (e) {
      console.warn('ask command failed:', e?.message || e);
      return message.reply('❌ Не мога да изпратя съобщение в посочения канал. Проверете правата ми.');
    }
  }

  // Admin: !ask2 — create a poll. Usage: !ask2 [#channel] Question | option1 | option2 | ... (up to 10)
  if (cmd === 'ask2') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('⛔ Само администратори.');
    let targetCh = message.mentions.channels.first() || null;
    if (targetCh) args.shift();
    const raw = args.join(' ').trim();
    if (!raw) return message.reply('ℹ️ Използване: `!ask2 [#канал] Въпрос | опция1 | опция2 | ...`');
    const parts = raw.split('|').map(s=>s.trim()).filter(Boolean);
    if (parts.length < 2) return message.reply('ℹ️ Трябва да има въпрос и поне една опция (в разделяне с `|`).');
    const question = parts.shift();
    const options = parts.slice(0,10);
    const emojis = ['1️⃣','2️⃣','3️⃣','4️⃣','5️⃣','6️⃣','7️⃣','8️⃣','9️⃣','🔟'];
    const emb = new EmbedBuilder().setTitle('📊 ' + question).setDescription(options.map((o,i)=>`${emojis[i]} ${o}`).join('\n')).setColor(0x5865F2).setTimestamp();
    const ch = targetCh || message.channel;
    try {
      const sent = await ch.send({ embeds: [emb] });
      for (let i=0;i<options.length;i++) {
        try { await sent.react(emojis[i]); } catch (e) { /* ignore reaction failures */ }
      }
      return message.channel.send('✅ Анкетата беше създадена.');
    } catch (e) {
      console.warn('ask2 command failed:', e?.message || e);
      return message.reply('❌ Не мога да публикувам анкетата в този канал. Проверете правата ми.');
    }
  }
  
  if (cmd === 'pin' || cmd === 'unpin') {
    const token = args[0];
    if (!token) return message.reply(`ℹ️ Ползвай: \`!${cmd} <ID или линк към съобщение>\``);
    let channelId = message.channel.id, messageId = null;
    const m = token.match(/^https?:\/\/(?:ptb\.|canary\.)?discord\.com\/channels\/(\d+)\/(\d+)\/(\d+)$/);
    if (m) { channelId = m[2]; messageId = m[3]; } else { messageId = token; }
    try {
      const ch = message.guild.channels.cache.get(channelId) || await client.channels.fetch(channelId);
      if (!ch || !('messages' in ch)) return message.reply('⚠️ Не намирам канала на това съобщение.');
      const msg = await ch.messages.fetch(messageId);
      if (cmd === 'pin') { await msg.pin(); return message.channel.send(`🧷 Закачено: [линк](${msg.url})`); }
      else { await msg.unpin(); return message.channel.send(`❎ Откачено: [линк](${msg.url})`); }
    } catch (e) { return message.reply(`❌ Не успях: ${e.message || e}`); }
  }

  if (cmd === 'resetachievements') {
    const nowISO = new Date().toISOString();
    const g = ensureGuildStore(guildId);
    for (const id of Object.keys(g.users)) {
      g.users[id].achievements = {};
      g.users[id].messages = 0;
      g.users[id].mentions = 0;
      g.users[id].activeDays = {};
      g.users[id].dailyCounts = {};
      g.users[id].dailyMentions = {};
      g.users[id].dailyReactionsGiven = {};
      g.users[id].joinDate = nowISO;
      g.users[id].levelCache = 0;
      g.users[id].nightOwlCount = 0;
      g.users[id].memesCount = 0;
      g.users[id].reactionsGiven = 0;
      g.users[id].reactionsReceived = 0;
      g.users[id].voice = { totalMs:0, sessionStart:null, sessionChannelId:null, inAFKMs:0, duetStart:null, lastJoinSize:0 };
    }
    save();
    return message.channel.send('♻️ Постиженията и броячите са нулирани (вкл. joinDate) за този сървър.');
  }

  if (cmd === 'resetmessages') {
    const t = message.mentions.users.first();
    const g = ensureGuildStore(guildId);
    if ((args[0]||'').toLowerCase()==='all') {
      for (const id in g.users) { g.users[id].messages=0; g.users[id].dailyCounts={}; g.users[id].levelCache = computeLevel(g.users[id]); }
      save(); return message.channel.send('🔄 Нулирани съобщения за **всички** (този сървър).');
    }
    if (!t) return message.reply('ℹ️ `!resetmessages @user` или `!resetmessages all`');
    await ensureUser(message.guild, t.id); g.users[t.id].messages = 0; g.users[t.id].dailyCounts={}; g.users[t.id].levelCache=0; save();
    return message.channel.send(`🔄 Нулирани съобщения за ${t}.`);
  }

  if (cmd === 'resetdays') {
    const t = message.mentions.users.first();
    const g = ensureGuildStore(guildId);
    if ((args[0]||'').toLowerCase()==='all') {
      for (const id in g.users) g.users[id].activeDays={}; save();
      return message.channel.send('🔄 Нулирани активни дни за **всички** (този сървър).');
    }
    if (!t) return message.reply('ℹ️ `!resetdays @user` или `!resetdays all`');
    await ensureUser(message.guild, t.id); g.users[t.id].activeDays={}; save();
    return message.channel.send(`🔄 Нулирани активни дни за ${t}.`);
  }

  if (cmd === 'resetmentions') {
    const t = message.mentions.users.first();
    const g = ensureGuildStore(guildId);
    if ((args[0]||'').toLowerCase()==='all') {
      for (const id in g.users) g.users[id].mentions=0; save();
      return message.channel.send('🔄 Нулирани споменавания за **всички** (този сървър).');
    }
    if (!t) return message.reply('ℹ️ `!resetmentions @user` или `!resetmentions all`');
    await ensureUser(message.guild, t.id); g.users[t.id].mentions=0; save();
    return message.channel.send(`🔄 Нулирани споменавания за ${t}.`);
  }

  if (cmd === 'resetall') {
    const g = ensureGuildStore(guildId);
    const t = message.mentions.users.first() || null;
    const everyone = (args.join(' ').toLowerCase().trim()==='all' || args.join(' ').toLowerCase().trim()==='всички');
    const nowISO = new Date().toISOString();
    const resetUser = (id) => {
      g.users[id] = {
        messages: 0, mentions: 0, activeDays: {}, dailyCounts:{}, dailyMentions:{}, dailyReactionsGiven:{},
        joinDate: nowISO, lastActiveISO: nowISO, achievements: {}, levelCache: 0,
        nightOwlCount:0, memesCount:0, reactionsGiven:0, reactionsReceived:0,
        voice:{ totalMs:0, sessionStart:null, sessionChannelId:null, inAFKMs:0, duetStart:null, lastJoinSize:0 }
      };
    };
    if (everyone) {
      for (const id of Object.keys(g.users)) resetUser(id);
      // remove achievement roles from all members where configured
      let removedLog = [];
      try {
        const gset = ensureGuildSettings(message.guild.id);
        const achRoles = Object.values(gset.achRoles || {});
        if (achRoles.length && message.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
          await message.guild.members.fetch();
          for (const [mid, mem] of message.guild.members.cache) {
            const toRemove = achRoles.filter(rid => mem.roles.cache.has(rid));
            if (!toRemove.length) continue;
            // filter out roles above bot's highest
            const removable = toRemove.filter(rid => {
              const role = message.guild.roles.cache.get(rid);
              return role && (message.guild.members.me.roles.highest.position > role.position);
            });
            if (!removable.length) continue;
            await mem.roles.remove(removable).catch(()=>{});
            removedLog.push({ userId: mid, roles: removable });
          }
        }
      } catch (e) { /* ignore role cleanup failures */ }
      save();
      const log = getGuildChannel(message.guild, 'logs', 'LOG_CHANNEL_ID');
      log && log.send(`🗑️ RESETALL от ${message.author} → всички (този сървър).`).catch(()=>{});
      return message.channel.send('🗑️ Всичко е нулирано за **всички** (вкл. joinDate) в този сървър.');
    }
    const u = t || message.author;
    await ensureUser(message.guild, u.id); resetUser(u.id);
    // remove achievement roles from this specific user if any
    let removedLogSingle = [];
    try {
      const gset = ensureGuildSettings(message.guild.id);
      const achRoles = Object.values(gset.achRoles || {});
      if (achRoles.length && message.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
        const member = await message.guild.members.fetch(u.id).catch(()=>null);
        if (member) {
          const toRemove = achRoles.filter(rid => member.roles.cache.has(rid));
          const removable = toRemove.filter(rid => {
            const role = message.guild.roles.cache.get(rid);
            return role && (message.guild.members.me.roles.highest.position > role.position);
          });
          if (removable.length) { await member.roles.remove(removable).catch(()=>{}); removedLogSingle = removable.slice(); }
        }
      }
    } catch (e) {}
    save();
    const log = getGuildChannel(message.guild, 'logs', 'LOG_CHANNEL_ID');
    log && log.send(`🗑️ RESETALL от ${message.author} → ${u} (този сървър).`).catch(()=>{});
    // report removed roles to logs channel if any
    try {
      const logCh = getGuildChannel(message.guild, 'logs', 'LOG_CHANNEL_ID');
      if (removedLog.length && logCh) {
        for (const item of removedLog) {
          const uname = `<@${item.userId}>`;
          const rnames = item.roles.map(rid => { const r = message.guild.roles.cache.get(rid); return r ? `${r.name} (ID: ${rid})` : rid; }).join(', ');
          await safeSend(logCh, `🗑️ Роли премахнати при RESETALL за ${uname}: ${rnames}`);
        }
      }
      if (removedLogSingle.length && logCh) {
        const rnames = removedLogSingle.map(rid => { const r = message.guild.roles.cache.get(rid); return r ? `${r.name} (ID: ${rid})` : rid; }).join(', ');
        await safeSend(logCh, `🗑️ Роли премахнати при RESETALL за ${u}: ${rnames}`);
      }
    } catch (e) {}
    return message.channel.send(`🗑️ Всичко е нулирано за ${u} (вкл. joinDate) в този сървър.`);
  }

  // Unified `!reset` command: supports subcommands and optional @user or 'all'
  if (cmd === 'reset') {
    const sub = (args.shift()||'').toLowerCase();
    const target = message.mentions.users.first() || null;
    const everyone = (args.join(' ').toLowerCase().trim()==='all' || args.join(' ').toLowerCase().trim()==='всички');
    if (!sub) return message.reply('ℹ️ Използване: `!reset <days|mentions|messages|reactions|achievements|all> [@user|all]`');

    // create a pending reset and require confirmation for destructive ops (all or achievements/all)
    const id = Math.random().toString(36).slice(2,10);
    pendingResets[id] = {
      requesterId: message.author.id,
      channelId: message.channel.id,
      guildId: message.guild.id,
      sub,
      targetId: target ? target.id : null,
      everyone,
      createdAt: new Date().toISOString()
    };

    // if it's a small/non-destructive opt (messages/days/mentions/reactions for single user) we can execute immediately
    const immediate = ['messages','days','mentions','reactions'];
    if (immediate.includes(sub) && !everyone && pendingResets[id].targetId) {
      // execute immediately by delegating to the earlier logic
      delete pendingResets[id];
      return client.emit('messageCreate', Object.assign(Object.create(message), { content: `!reset${sub} <@${pendingResets[id]?.targetId || ''}>` }));
    }

    // otherwise require explicit confirmation
    await message.channel.send(`⚠️ Потвърдете рестарт: изпишете \`!confirmreset ${id}\` в следващите 60 секунди за да потвърдите операцията (${sub} ${everyone ? 'всички' : (target ? `<@${target.id}>` : '')}).`);
    // auto-expire
    setTimeout(() => { if (pendingResets[id]) delete pendingResets[id]; }, 60000);
    return;
  }

  // confirmation command for pending resets
  if (cmd === 'confirmreset') {
    const id = (args.shift()||'').trim();
    const p = pendingResets[id];
    if (!p) return message.reply('❌ Няма чакаща заявка за рестарт с това ID или вече е изтекла.');
    if (p.requesterId !== message.author.id && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('⚠️ Само заявилия или администратор може да потвърди рестарт.');
    }
    // construct a synthetic message to forward to existing handlers
    const synthetic = Object.assign(Object.create(message), { guild: message.guild, content: (()=>{
      const sub = p.sub;
      if (sub === 'all') return '!resetall' + (p.everyone ? ' all' : (p.targetId ? ` <@${p.targetId}>` : ''));
      if (sub === 'achievements') return '!resetachievements' + (p.targetId ? ` <@${p.targetId}>` : '');
      if (sub === 'messages') return p.everyone ? '!resetmessages all' : `!resetmessages <@${p.targetId}>`;
      if (sub === 'days') return p.everyone ? '!resetdays all' : `!resetdays <@${p.targetId}>`;
      if (sub === 'mentions') return p.everyone ? '!resetmentions all' : `!resetmentions <@${p.targetId}>`;
      if (sub === 'reactions') return p.everyone ? '!reset reactions all' : `!reset reactions <@${p.targetId}>`;
      return '';
    })() });
    delete pendingResets[id];
    await message.channel.send(`✅ Потвърдихте рестарт: ${p.sub} ${p.everyone ? 'всички' : (p.targetId ? `<@${p.targetId}>` : '')}`);
    return client.emit('messageCreate', synthetic);
  }
  
  if (cmd === 'cancelreset') {
    const id = (args.shift()||'').trim();
    const p = pendingResets[id];
    if (!p) return message.reply('❌ Няма чакаща заявка с това ID.');
    if (p.requesterId !== message.author.id && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('⚠️ Само заявилия или администратор може да отмени заявка.');
    }
    delete pendingResets[id];
    return message.channel.send(`❌ Заявката за рестарт ${id} беше отменена.`);
  }

  if (cmd === 'addmessages') {
    const t = message.mentions.users.first();
    const n = parseInt(args[0],10);
    const g = ensureGuildStore(guildId);
    if (!t || isNaN(n) || n<1) return message.reply('ℹ️ `!addmessages @user <брой>`');
    await ensureUser(message.guild, t.id); g.users[t.id].messages += n; g.users[t.id].levelCache = computeLevel(g.users[t.id]); save();
    return message.channel.send(`➕ Добавени **${n}** съобщения за ${t} (този сървър).`);
  }

  if (cmd === 'rmessages') {
    const t = message.mentions.users.first();
    const n = parseInt(args[0],10);
    const g = ensureGuildStore(guildId);
    if (!t || isNaN(n) || n<1) return message.reply('ℹ️ `!rmessages @user <брой>`');
    await ensureUser(message.guild, t.id);
    g.users[t.id].messages = Math.max(0, (g.users[t.id].messages || 0) - n);
    g.users[t.id].levelCache = computeLevel(g.users[t.id]); save();
    return message.channel.send(`➖ Премахнати **${n}** съобщения от ${t} (този сървър).`);
  }

  if (cmd === 'topres') {
    store[guildId] = { users: {} };
    save();
    return message.channel.send('🗑️ Топ класацията и списъкът с потребители са нулирани (този сървър).');
  }

  if (cmd === 'achsetup') {
    const sub = (args.shift()||'').toLowerCase();
    const valid = Object.keys(ACH);
    const gset = ensureGuildSettings(message.guild.id);
    if (!sub || sub==='help') {
      return message.reply('ℹ️ `!achsetup list`\n`!achsetup set <key> @Роля`\n`!achsetup clear <key>`');
    }
    if (sub==='list') {
      // show key, achievement name, and configured role (mention if available)
      const rows = valid.map(k => '• `' + k + '` — ' + (ACH[k] || k) + ' — Роля: ' + (gset.achRoles[k] ? ('<@&' + gset.achRoles[k] + '> (ID: ' + gset.achRoles[k] + ')') : '—')).join('\n');
      const emb = new EmbedBuilder().setTitle('🏷️ Роли за постижения').setDescription(rows).setColor(0x57F287);
      return sendEmbedOrText(message.channel, emb, 'Роли за постижения:\n' + rows);
    }
    if (sub==='set') {
      const key = (args.shift()||''); if (!valid.includes(key)) return message.reply('❌ Невалиден ключ (виж `!achsetup list`).');
      const role = message.mentions.roles.first(); if (!role) return message.reply('ℹ️ Посочи роля: `!achsetup set <key> @Роля`');
      if (!message.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) return message.reply('⚠️ Липсва право **Manage Roles**.');
      if (message.guild.members.me.roles.highest.position <= role.position) return message.reply('⚠️ Не мога да управлявам тази роля.');
  const oldRole = gset.achRoles[key] || null;
  gset.achRoles[key] = role.id; saveGuildSettings(message.guild.id, gset);
  // audit
  appendAchAudit({ when: new Date().toISOString(), action: 'set', guildId: message.guild.id, guildName: message.guild.name, by: message.author.id, byTag: message.author.tag, key, oldRole, newRole: role.id });
      return message.channel.send(`✅ За **${ACH[key]}** ще се дава ${role}.`);
    }
    if (sub==='clear') {
      const key = (args.shift()||''); if (!valid.includes(key)) return message.reply('❌ Невалиден ключ.');
  const old = gset.achRoles[key] || null;
  delete gset.achRoles[key]; saveGuildSettings(message.guild.id, gset);
  appendAchAudit({ when: new Date().toISOString(), action: 'clear', guildId: message.guild.id, guildName: message.guild.name, by: message.author.id, byTag: message.author.tag, key, oldRole: old, newRole: null });
      return message.channel.send(`🧹 Ролята за **${ACH[key]}** е изчистена.`);
    }
    return message.reply('ℹ️ `!achsetup help`');
  }

  // Admin: synchronize achievement roles for users who already unlocked them
  if (cmd === 'syncachroles') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('⛔ Само администратори.');
    const gid = message.guild.id;
    const gset = ensureGuildSettings(gid);
    const achRoles = gset.achRoles || {};
    const keys = Object.keys(achRoles);
    if (!keys.length) return message.channel.send('ℹ️ Няма конфигурирани роли за постижения. Настрой с `!achsetup set <key> @Роля`.');

    if (!message.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) return message.reply('⚠️ Липсва право Manage Roles.');

    await message.channel.send('🔄 Синхронизация на роли за постижения — започвам. Това може да отнеме малко.');
    await message.guild.members.fetch().catch(()=>{});

    let assigned = 0;
    let usersTouched = 0;
    const gstore = ensureGuildStore(gid);
    for (const [mid, member] of message.guild.members.cache) {
      if (member.user.bot) continue;
      const u = gstore.users && gstore.users[mid];
      if (!u || !u.achievements) continue;
      const toAdd = [];
      for (const k of Object.keys(u.achievements)) {
        if (!u.achievements[k]) continue;
        const rid = achRoles[k];
        if (!rid) continue;
        const role = message.guild.roles.cache.get(rid);
        if (!role) continue;
        if (member.roles.cache.has(rid)) continue;
        if (message.guild.members.me.roles.highest.position <= role.position) continue;
        toAdd.push(rid);
      }
      if (toAdd.length) {
        try { await member.roles.add(toAdd).catch(()=>{}); assigned += toAdd.length; usersTouched += 1; } catch (e) {}
      }
    }

    return message.channel.send(`✅ Синхронизация завърши. Присвоени роли: **${assigned}** за **${usersTouched}** потребителя(и).`);
  }

  // Admin: save all persistent files (settings, store, gifs)
  if (cmd === 'save-all') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('⛔ Само администратори.');
    try {
      saveSettings();
      save();
      saveGifs();
      return message.channel.send('✅ Всички конфигурации и данни бяха записани на диск.');
    } catch (e) {
      console.error('save-all error:', e);
      return message.reply('❌ Грешка при запис. Виж логовете.');
    }
  }

  // Admin: show audit entries for achsetup
  if (cmd === 'show-audit') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('⛔ Само администратори.');
    const mode = (args.shift()||'').toLowerCase();
    if (!mode || (mode !== 'key' && mode !== 'guild')) return message.reply('ℹ️ Използване: `!show-audit key <key> [page]` или `!show-audit guild <guildId> [page]`');
    const target = args.shift();
    const page = Math.max(1, parseInt(args.shift()||'1',10) || 1);
    if (!target) return message.reply('ℹ️ Посочи ключ или guildId.');
    // read audit file (may be large) — stream and filter
    try {
      if (!fs.existsSync(achAuditFile)) return message.reply('ℹ️ Няма audit записи.');
      const raw = fs.readFileSync(achAuditFile, 'utf8').trim().split('\n').map(l=>l.trim()).filter(Boolean);
      const entries = raw.map(l=>{ try{return JSON.parse(l);}catch(e){return null;} }).filter(Boolean);
      let filtered = [];
      if (mode === 'key') filtered = entries.filter(e=>e.key === target);
      else filtered = entries.filter(e=>e.guildId === target);
      if (!filtered.length) return message.reply('ℹ️ Няма намерени записи.');
      const perPage = 10;
      const total = filtered.length;
      const pages = Math.ceil(total / perPage);
      const p = Math.min(pages, page);
      const start = (p-1)*perPage;
      const slice = filtered.slice(start, start+perPage);
      const lines = slice.map(e => `• [${formatDateIso(e.when)}] ${e.action.toUpperCase()} key=${e.key} by=${e.byTag||e.by} old=${e.oldRole||'null'} new=${e.newRole||'null'} guild=${e.guildName||e.guildId}`);
      const header = `📜 Audit (${mode}=${target}) — страница ${p}/${pages} — общо ${total} записи`;
      for (const c of [header, ...lines]) await message.author.send(c).catch(()=>{});
      return message.channel.send('📬 Audit записите бяха изпратени в твоите лични съобщения (DM).');
    } catch (e) {
      console.error('show-audit error:', e);
      return message.reply('❌ Грешка при четене на audit файла.');
    }
  }

  // Admin: send a DM to a user by mention or id
  if (cmd === 'call') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('⛔ Само администратори.');
    const firstArg = args[0] || '';
    let target = null;
    // prefer explicit mention parsed by discord.js
    if (message.mentions && message.mentions.users && message.mentions.users.size) {
      target = message.mentions.users.first();
      // remove the mention token (could be <@id> or <@!id> or raw id) from args
      for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === `<@${target.id}>` || a === `<@!${target.id}>` || a === target.id) { args.splice(i,1); break; }
      }
    } else {
      // try common mention/id formats in the first arg
      const m = firstArg.match(/^<@!?(\d+)>$/) || firstArg.match(/^(\d+)$/);
      if (m) {
        const id = m[1] || m[0];
        target = await client.users.fetch(id).catch(()=>null);
        if (target) args.shift();
      }
    }
    if (!target) return message.reply('ℹ️ Ползване: `!call @user|<id> <съобщение>`');
    const text = args.join(' ').trim();
    if (!text) return message.reply('ℹ️ Укажи текст: `!call @user <текст>`');
    try {
      // Sanitize text: remove any explicit mentions of the command author so DM does not reveal who sent it
      const authorMentionForms = [`<@${message.author.id}>`, `<@!${message.author.id}>`, message.author.id];
      let safeText = text;
      for (const form of authorMentionForms) {
        safeText = safeText.split(form).join('[скрито]');
      }
      // Also remove a literal "from @username" pattern if present (basic)
      const fromPattern = new RegExp(`from\s+@?${escapeRegExp(message.author.username)}`, 'ig');
      safeText = safeText.replace(fromPattern, '[скрито]');

      await target.send(safeText);
      // Keep channel confirmation minimal (do not reveal recipient or sender)
      return message.channel.send('✅ Съобщението беше изпратено.');
    } catch (e) {
      console.error('call DM error:', e);
      return message.reply('❌ Не успях да изпратя DM (потребителят може да има затворени DM).');
    }
  }

  // (removed !la admin command)

  if (cmd === 'addgif') {
    const rawType = (args[0] || '');
    const type = normalizeGifType(rawType);
    const url = (args[1] || '').trim();
    if (!type || !url) return message.reply('ℹ️ `!addgif <тип> <url>`');
    // simple URL validation: must start with http or https
    if (!/^https?:\/\//i.test(url)) return message.reply('⚠️ Невалиден URL. Моля използвай връзка, започваща с http:// или https://');
    if (!gifs[type]) gifs[type] = [];
    // prevent duplicates
    if (gifs[type].includes(url)) return message.channel.send('⚠️ Този GIF вече е добавен за този тип.');
    gifs[type].push(url);
    try { saveGifs(); } catch (e) { console.warn('saveGifs failed on addgif:', e?.message); }
    return message.channel.send(`✅ Добавен GIF към **${type}** (от ` + rawType + `).`);
  }

  if (cmd === 'delgif') {
    const rawType = (args[0] || '');
    const type = normalizeGifType(rawType);
    const idx = parseInt(args[1], 10) - 1;
    if (!type || isNaN(idx)) return message.reply('ℹ️ `!delgif <тип> <номер>`');
    if (!gifs[type] || !gifs[type][idx]) return message.reply('⚠️ Няма такъв GIF.');
    const removed = gifs[type].splice(idx, 1)[0];
    try { saveGifs(); } catch (e) { console.warn('saveGifs failed on delgif:', e?.message); }
    return message.channel.send(`🗑️ Премахнат GIF #${idx+1} от **${type}** (от ` + rawType + `).`);
  }

  if (cmd === 'listgifs') {
    const rawType = (args[0] || '');
    const type = normalizeGifType(rawType);
    if (!type || !gifs[type]?.length) return message.reply('⚠️ Няма GIF-ове за този тип.');
    const list = gifs[type].map((g, i) => `${i+1}. ${g}`).join('\n');
    const emb = new EmbedBuilder().setTitle(`📂 GIF-ове за ${type} (from ${rawType})`).setDescription(list).setColor(0x5865F2);
    return sendEmbedOrText(message.channel, emb, `GIF-ове за ${type}:\n${list}`);
  }

  // Admin: test all GIF URLs in gifs.json for reachability/content-type
  if (cmd === 'testgifs') {
    // adminOnly gate above ensures only admins reach here
    const timeoutMs = 8000;

    const checkUrl = (url) => new Promise(resolve => {
      try {
        const u = new URL(url);
        const mod = u.protocol === 'https:' ? require('https') : require('http');

        const doHead = () => {
          const req = mod.request({ method: 'HEAD', host: u.hostname, path: u.pathname + (u.search||''), port: u.port || (u.protocol === 'https:' ? 443 : 80), timeout: timeoutMs }, res => {
            const status = res.statusCode || 0;
            const ct = (res.headers['content-type'] || '').toLowerCase();
            // if server rejects HEAD with 405, fallback to GET
            if (status === 405 || status >= 400) return doGet();
            res.resume();
            resolve({ ok: status >= 200 && status < 400, status, contentType: ct });
          });
          req.on('error', (e) => { /* fallback to GET */ doGet(); });
          req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
          req.end();
        };

        const doGet = () => {
          const req = mod.request({ method: 'GET', host: u.hostname, path: u.pathname + (u.search||''), port: u.port || (u.protocol === 'https:' ? 443 : 80), timeout: timeoutMs, headers: { 'Range': 'bytes=0-1023' } }, res => {
            const status = res.statusCode || 0;
            const ct = (res.headers['content-type'] || '').toLowerCase();
            // read a small chunk then destroy
            res.on('data', () => { /* noop */ });
            res.on('end', () => {});
            // consider 200-399 ok
            resolve({ ok: status >= 200 && status < 400, status, contentType: ct });
            res.resume();
          });
          req.on('error', (e) => { resolve({ ok: false, error: e.message }); });
          req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
          req.end();
        };

        // start with HEAD
        doHead();
      } catch (e) { resolve({ ok: false, error: e.message }); }
    });

    try {
      if (!gifs || !Object.keys(gifs).length) return message.reply('ℹ️ Нямам GIF конфигурации (gifs.json е празен).');
      await message.channel.send('🔎 Стартирам проверка на GIF-овете. Резултатите ще ти бъдат изпратени в DM.');

      const reportLines = [];
      const failures = [];
      // iterate types and urls sequentially to be gentle
      for (const t of Object.keys(gifs)) {
        const arr = gifs[t] || [];
        for (let i = 0; i < arr.length; i++) {
          const url = arr[i];
          const res = await checkUrl(url);
          const idx = i+1;
          if (res.ok) {
            reportLines.push(`✅ ${t} #${idx} ${url} — ${res.status} ${res.contentType || ''}`);
          } else {
            const why = res.error ? res.error : (`status=${res.status} content-type=${res.contentType||'unknown'}`);
            reportLines.push(`❌ ${t} #${idx} ${url} — ${why}`);
            failures.push({ type: t, index: idx, url, reason: why });
          }
          // small delay to avoid hammering
          await new Promise(r => setTimeout(r, 200));
        }
      }

      // send report in DM (split into chunks if necessary)
      const chunkSize = 30; // lines per message
      for (let i = 0; i < reportLines.length; i += chunkSize) {
        const slice = reportLines.slice(i, i + chunkSize).join('\n');
        await message.author.send(slice).catch(() => { /* ignore DM failures */ });
      }

      if (failures.length) {
        await message.channel.send(`⚠️ Проверката завърши: ${failures.length} неуспешни линка (пратих детайли в DM).`);
      } else {
        await message.channel.send('✅ Проверката завърши: всички GIF-ове изглеждат достъпни (изпратено в DM).');
      }
      return;
    } catch (e) {
      console.error('testgifs error:', e);
      return message.reply('❌ Грешка по време на проверката на GIF-овете.');
    }
  }

  if (cmd === 'setchannel') {
    const type = (args.shift()||'').toLowerCase();
    const ch = message.mentions.channels.first();
    // Added 'nicklogs' into allowed channel types
    const allowed = ['reports','logs','console','suggest','feedback','achievements','nicklogs'];
    if (!type || !allowed.includes(type) || !ch) {
      return message.reply('ℹ️ `!setchannel <тип> #канал` (тип: reports, logs, console, suggest, feedback, achievements, nicklogs)');
    }
    setGuildChannel(message.guild.id, type, ch.id);
    if (type === 'console') consoleTargetChannelId = ch.id;
    return message.channel.send(`✅ Зададен канал за **${type}**: <#${ch.id}>`);
  }
  // === !nicklogs on|off|show ===
  if (cmd === 'nicklogs') {
    if (!message.guild) return message.reply('⚠️ Тази команда е само за сървъри.');
    if (!message.member.permissions.has(PermissionFlagsBits.ManageGuild) && !message.member.permissions.has(PermissionFlagsBits.Administrator)) {
      return message.reply('⚠️ Нямаш права да променяш настройки. Нужно е `Manage Server` или `Administrator`.');
    }
    const sub = (args.shift()||'').toLowerCase();
    if (!sub || !['on','off','show'].includes(sub)) return message.reply('ℹ️ Използване: `!nicklogs on #канал` | `!nicklogs off` | `!nicklogs show`');
    const gset = ensureGuildSettings(message.guild.id);
    if (sub === 'show') {
      return message.channel.send(`🔔 Nicklogs: ${gset.nicklogs ? `<#${gset.nicklogs}>` : '—'}`);
    }
    if (sub === 'off') {
      delete gset.nicklogs; saveGuildSettings(message.guild.id, gset);
      return message.channel.send('✅ Nicklogs изключени за този сървър.');
    }
    // on
    const ch = message.mentions.channels.first();
    if (!ch) return message.reply('ℹ️ Посочи канал: `!nicklogs on #канал`');
    gset.nicklogs = ch.id; saveGuildSettings(message.guild.id, gset);
    return message.channel.send(`✅ Nicklogs ще се изпращат в: <#${ch.id}>`);
  }
  if (cmd === 'showchannels') {
    const s = ensureGuildSettings(message.guild.id);
    const list =
      `🏆 Постижения: ${s.achievements ? `<#${s.achievements}>` : '—'}\n`+
      `🚨 Репорти: ${s.reports ? `<#${s.reports}>` : '—'}\n`+
      `📝 Логове: ${s.logs ? `<#${s.logs}>` : '—'}\n`+
      `🖥️ Конзола: ${s.console ? `<#${s.console}>` : '—'}\n`+
      `💡 Предложения: ${s.suggest ? `<#${s.suggest}>` : '—'}\n`+
      `📝 Обратна връзка: ${s.feedback ? `<#${s.feedback}>` : '—'}\n`+
  `🔗 Социалки: ${(s.socialLinks||[]).length} запис(а)`+
  `
🔔 Nicklogs: ${s.nicklogs ? `<#${s.nicklogs}>` : '—'}`;
    return message.channel.send(`🔧 Настройки:\n${list}`);
  }

  if (cmd === 'check') {
    const sub = (args.shift()||'').toLowerCase();
    if (!sub) return message.reply('ℹ️ `!check bots|users|stats @user`');
    await message.guild.members.fetch().catch(()=>{});
    if (sub === 'bots') {
      const bots = message.guild.members.cache.filter(m => m.user.bot).size;
      return message.channel.send(`🤖 Ботове в сървъра: **${bots}**`);
    }
    if (sub === 'users') {
      const users = message.guild.members.cache.filter(m => !m.user.bot).size;
      return message.channel.send(`👥 Потребители (хора): **${users}**`);
    }
    if (sub === 'stats') {
      const t = message.mentions.users.first();
      if (!t) return message.reply('ℹ️ `!check stats @user`');
      await ensureUser(message.guild, t.id);
      const d = store[guildId].users[t.id] || {};
      const todayKey = new Date().toISOString().split('T')[0];
      const todayCount = d.dailyCounts?.[todayKey] || 0;
      const text =
        `📊 Статистика за ${t} (този сървър):\n` +
        `🆙 Ниво: ${computeLevel(d)}\n` +
        `📝 Съобщения: ${d.messages||0}\n` +
        `🗓️ Днес: ${todayCount}\n` +
        `🖼️ Мемета/снимки: ${d.memesCount||0}\n` +
        `💬 Споменавания: ${d.mentions||0}\n` +
        `💖 Получени реакции: ${d.reactionsReceived||0} | ⚡ Поставени реакции: ${d.reactionsGiven||0}\n` +
        `🔥 Активни дни: ${Object.keys(d.activeDays||{}).length}\n` +
        `🏆 Постижения: ${Object.keys(d.achievements||{}).length}`;
      return message.channel.send(text);
    }
    return message.reply('❌ Невалиден подтип. Ползвай: `bots|users|stats @user`');
  }

  if (cmd === 'monthly') {
    const g = ensureGuildStore(guildId);
    const since = new Date(); since.setDate(since.getDate()-30);
    const days = [];
    for (let i=0;i<30;i++) { const d=new Date(); d.setDate(d.getDate()-i); days.push(d.toISOString().split('T')[0]); }
    const rows = Object.entries(g.users).map(([id,u])=>{
      let msgs=0, mentions=0, reacts=0;
      for (const d of days) {
        msgs += u.dailyCounts?.[d] || 0;
        mentions += u.dailyMentions?.[d] || 0;
        reacts += u.dailyReactionsGiven?.[d] || 0;
      }
      return { id, msgs, mentions, reacts };
    }).filter(r => r.msgs || r.mentions || r.reacts)
      .sort((a,b)=> (b.msgs+b.mentions+b.reacts) - (a.msgs+a.mentions+a.reacts))
      .slice(0,15);
    if (!rows.length) return message.channel.send('📭 Няма активност за последните 30 дни.');
    const lines = await Promise.all(rows.map(async (r,i)=>{
      const m = await message.guild.members.fetch(r.id).catch(()=>null);
      const label = m? m.toString() : `<@${r.id}>`;
      return `${i+1}. ${label} — 📝${r.msgs} | ⚡${r.reacts} | 💬${r.mentions}`;
    }));
    const emb = new EmbedBuilder().setTitle('📆 Месечна активност (30 дни)').setDescription(lines.join('\n')).setColor(0x57F287);
    return sendEmbedOrText(message.channel, emb, `📆 Месечна активност (30 дни):\n${lines.join('\n')}`);
  }

  if (cmd === 'active') {
    // Accept either a mention or a raw user ID as argument
    let targetUser = message.mentions.users.first();
    const raw = args[0];
    if (!targetUser && raw && /^\d+$/.test(raw)) {
      // try fetch member by id
      const mem = await message.guild.members.fetch(raw).catch(()=>null);
      if (mem) targetUser = mem.user;
    }
    if (!targetUser) return message.reply('ℹ️ `!active @user|<userId>`');

    await ensureUser(message.guild, targetUser.id);
    const d = store[guildId].users[targetUser.id] || {};

    // Prefer internal lastActiveISO if available
    if (d.lastActiveISO) {
      return message.channel.send(`🕒 Последна активност на ${targetUser}: **${new Date(d.lastActiveISO).toLocaleString()}**`);
    }

    // Fallbacks: presence (online/offline) and lastMessage
    const member = await message.guild.members.fetch(targetUser.id).catch(()=>null);
    let fallback = null;
    if (member) {
      if (member.presence && member.presence.status) {
        fallback = `в момента е ${member.presence.status}`;
      }
      if (!fallback && member.lastMessage && member.lastMessage.createdAt) {
        fallback = `последно писано: ${member.lastMessage.createdAt.toLocaleString()}`;
      }
    }

    if (fallback) return message.channel.send(`🕒 Последна активност на ${targetUser}: **${fallback}**`);
    return message.channel.send(`ℹ️ Няма данни за последна активност на ${targetUser}.`);
  }

  // ===== Dragon eggs economy: !daily, !weekly, !monthlyegg =====
  if (cmd === 'daily' || cmd === 'weekly' || cmd === 'monthlyegg') {
    // cooldowns in milliseconds
    const now = Date.now();
    const uid = message.author.id;
    const g = ensureGuildStore(guildId);
    await ensureUser(message.guild, uid);
    const u = g.users[uid];

    const cfg = {
      daily: { ms: 24*60*60*1000, min: 1, max: 5, key: 'daily' },
      weekly: { ms: 7*24*60*60*1000, min: 5, max: 15, key: 'weekly' },
      monthlyegg: { ms: 30*24*60*60*1000, min: 20, max: 50, key: 'monthlyegg' }
    };

    const conf = cfg[cmd];
    if (!conf) return message.reply('❌ Невалидна команда.');

    const last = u.lastClaims && u.lastClaims[conf.key] ? new Date(u.lastClaims[conf.key]).getTime() : 0;
    if (last && now - last < conf.ms) {
      const left = conf.ms - (now - last);
      const hrs = Math.floor(left / (1000*60*60));
      const mins = Math.floor((left % (1000*60*60)) / (1000*60));
      return message.reply(`⏳ Вече получи ${cmd} — опитай след ${hrs}ч ${mins}м.`);
    }

    const reward = Math.floor(Math.random() * (conf.max - conf.min + 1)) + conf.min;
    u.dragonEggs = (u.dragonEggs || 0) + reward;
    u.lastClaims = u.lastClaims || { daily: null, weekly: null, monthlyegg: null };
    u.lastClaims[conf.key] = new Date().toISOString();
    save();

    const emb = new EmbedBuilder()
      .setTitle('🥚 Dragon Eggs')
      .setDescription(`✅ ${message.author}, получи **${reward}** драконови яйца! Имаш общо **${u.dragonEggs}**.`)
      .setColor(0xFFD166)
      .setTimestamp();
    return sendEmbedOrText(message.channel, emb, `${message.author.tag} получи ${reward} dragon eggs (общо ${u.dragonEggs}).`);
  }

  // ===== !checknames =====
  if (cmd === 'checknames') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('⛔ Само администратори.');
    let targetUser = message.mentions.users.first();
    const raw = args[0];
    if (!targetUser && raw && /^\d+$/.test(raw)) {
      const mem = await message.guild.members.fetch(raw).catch(()=>null);
      if (mem) targetUser = mem.user;
    }
    if (!targetUser) return message.reply('ℹ️ Използване: `!checknames @user|<userId>`');

    await ensureUser(message.guild, targetUser.id);
    const d = store[message.guild.id]?.users?.[targetUser.id];
    if (!d || !d.nameHistory || !d.nameHistory.length) return message.channel.send(`ℹ️ Няма записани смени на имена за ${targetUser}.`);

    const lines = d.nameHistory.slice(-50).map(h => {
      const t = new Date(h.when).toLocaleString();
      return `• [${t}] (${h.type}) **${h.old}** → **${h.new}**`;
    }).reverse();
    const chunks = [];
    // split into messages of ~1800 chars
    let cur = '';
    for (const ln of lines) {
      if ((cur + '\n' + ln).length > 1800) { chunks.push(cur); cur = ln; } else { cur = cur ? cur + '\n' + ln : ln; }
    }
    if (cur) chunks.push(cur);
    for (const c of chunks) {
      await message.channel.send(c);
    }
    return;
  }

  // ===== !eggs - show user's dragon egg balance =====
  if (cmd === 'eggs') {
    await ensureUser(message.guild, message.author.id);
    const u = store[guildId].users[message.author.id] || {};
    const count = u.dragonEggs || 0;
    const emb = new EmbedBuilder()
      .setTitle('🥚 Твоите Dragon яйца')
      .setDescription(`${message.author}, имаш **${count}** драконови яйца.`)
      .setColor(0xFFD166)
      .setTimestamp();
    return sendEmbedOrText(message.channel, emb, `${message.author.tag} има ${count} dragon eggs.`);
  }

  // ===== !todo (add personal todo) =====
  if (cmd === 'todo') {
    const text = args.join(' ').trim();
    if (!text) return message.reply('ℹ️ Използване: `!todo <текст>`');
    await ensureUser(message.guild, message.author.id);
    const u = store[guildId].users[message.author.id];
    u.todos = u.todos || [];
    u.todos.push({ when: new Date().toISOString(), text });
    save();
  try { saveTodos(); } catch (e) {}
    return message.channel.send(`✅ Добавена задача за ${message.author}: **${text}**`);
  }

  // ===== !mytodo (show caller's todos) =====
  if (cmd === 'mytodo') {
    await ensureUser(message.guild, message.author.id);
    const u = store[guildId].users[message.author.id] || {};
    const list = (u.todos || []).slice(-50).map((t,i) => `${i+1}. [${new Date(t.when).toLocaleString()}] ${t.text}`).join('\n');
    if (!list) return message.reply('ℹ️ Нямаш добавени задачи. Използвай `!todo <текст>` за да добавиш.');
    const chunks = [];
    let cur = '';
    for (const line of list.split('\n')) {
      if ((cur + '\n' + line).length > 1800) { chunks.push(cur); cur = line; } else { cur = cur ? cur + '\n' + line : line; }
    }
    if (cur) chunks.push(cur);
    // attempt to send chunks to DM; if any fail, notify in-channel
    let failed = false;
    for (const c of chunks) {
      try {
        await message.author.send(c);
      } catch (e) {
        failed = true;
        break;
      }
    }
    if (failed) {
      return message.channel.send(`${message.author}, не мога да ти изпратя лични съобщения (DM). Моля провери настройките си и опитай отново.`);
    }
    return message.channel.send('📬 Изпратени до твоите лично съобщения (DM).');
  }

  // ===== !deltodo <n> - remove a todo by index (caller only) =====
  if (cmd === 'deltodo') {
    const idx = parseInt(args[0], 10);
    if (isNaN(idx) || idx < 1) return message.reply('ℹ️ Използване: `!deltodo <номер>` (виж `!mytodo` за номерация)');
    await ensureUser(message.guild, message.author.id);
    const u = store[guildId].users[message.author.id];
    if (!u.todos || u.todos.length < idx) return message.reply('⚠️ Невалиден номер.');
    const removed = u.todos.splice(idx-1, 1)[0];
    save();
  try { saveTodos(); } catch (e) {}
    return message.channel.send(`🗑️ Премахната задача: **${removed.text}**`);
  }

  // ===== !donetodo <n> - mark a todo as done (moves to done list) =====
  if (cmd === 'donetodo') {
    const idx = parseInt(args[0], 10);
    if (isNaN(idx) || idx < 1) return message.reply('ℹ️ Използване: `!donetodo <номер>`');
    await ensureUser(message.guild, message.author.id);
    const u = store[guildId].users[message.author.id];
    if (!u.todos || u.todos.length < idx) return message.reply('⚠️ Невалиден номер.');
    const done = u.todos.splice(idx-1, 1)[0];
    u.doneTodos = u.doneTodos || [];
    u.doneTodos.push({ ...done, doneAt: new Date().toISOString() });
    save();
  try { saveTodos(); } catch (e) {}
    return message.channel.send(`✅ Маркирана като свършена: **${done.text}**`);
  }

  // ===== !edittodo <n> <text> - edit existing todo =====
  if (cmd === 'edittodo') {
    const idx = parseInt(args.shift(), 10);
    const text = args.join(' ').trim();
    if (isNaN(idx) || idx < 1 || !text) return message.reply('ℹ️ Използване: `!edittodo <номер> <нов текст>`');
    await ensureUser(message.guild, message.author.id);
    const u = store[guildId].users[message.author.id];
    if (!u.todos || u.todos.length < idx) return message.reply('⚠️ Невалиден номер.');
    const old = u.todos[idx-1];
    u.todos[idx-1] = { when: old.when, text };
    save();
    try { saveTodos(); } catch (e) {}
    return message.channel.send(`✏️ Актуализирана задача #${idx}: **${text}**`);
  }

  // ===== Admin: !showservers =====
  if (cmd === 'showservers') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('⛔ Само администратори.');
    try {
      const guilds = client.guilds.cache.map(g => `• ${g.name} (ID: ${g.id})`).join('\n') || 'Нямам присъствие в сървъри.';
      const emb = new EmbedBuilder().setTitle('🌐 Сървъри с бота').setDescription(guilds).setColor(0x57F287).setTimestamp();
      return message.channel.send({ embeds: [emb] });
    } catch (e) {
      console.error('showservers error:', e);
      return message.reply('❌ Грешка при получаване на списък със сървъри.');
    }
  }
  
  // ===== Admin: !info @user|<id> =====
  if (cmd === 'info') {
    if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) return message.reply('⛔ Само администратори.');
    const firstArg = args[0] || '';
    let targetUser = message.mentions.users.first() || null;
    if (!targetUser && firstArg && /^\d+$/.test(firstArg)) {
      targetUser = await client.users.fetch(firstArg).catch(()=>null);
      if (targetUser) args.shift();
    } else if (message.mentions.users.first()) {
      args.shift();
    }
    if (!targetUser) return message.reply('ℹ️ Използване: `!info @user` или `!info <userId>`');

    try {
      // try to fetch member in current guild for roles and nickname
      const member = await message.guild.members.fetch(targetUser.id).catch(()=>null);

  const nick = member ? (member.nickname || targetUser.username) : (targetUser.username);
  const displayName = targetUser.globalName || targetUser.username || (member && member.displayName) || nick;

      // roles in this guild (only show role names for readability)
      let rolesList = '—';
      if (member) {
        const roles = member.roles.cache
          .filter(r => r.id !== message.guild.id)
          .map(r => r.name);
        rolesList = roles.length ? roles.join(', ') : '—';
      }

      // gather join/leave dates from store and member
      const gstore = ensureGuildStore(message.guild.id);
      const userStore = gstore.users && gstore.users[targetUser.id] ? gstore.users[targetUser.id] : null;

      // servers where the bot can see the user (guilds where member exists)
      const guilds = [];
      for (const g of client.guilds.cache.values()) {
        const m = g.members.cache.get(targetUser.id) || await g.members.fetch(targetUser.id).catch(()=>null);
        if (m) guilds.push(`• ${g.name} (ID: ${g.id})`);
      }

      const guildsText = guilds.length ? guilds.join('\n') : 'Не е намерен в познатите ми сървъри.';

      const emb = new EmbedBuilder()
        .setTitle(`ℹ️ Информация за ${targetUser.tag}`)
        .addFields(
          { name: 'Никнейм в сървъра', value: String(nick), inline: true },
          { name: 'Display name / Глобално име', value: String(displayName), inline: true },
          { name: 'ID', value: `\`${targetUser.id}\``, inline: true },
          { name: 'Роли в този сървър', value: rolesList, inline: false },
          { name: 'Дата на присъединяване (този сървър)', value: member?.joinedAt ? formatDateIso(member.joinedAt.toISOString()) : (userStore?.joinDate ? formatDateIso(userStore.joinDate) : '—'), inline: true },
          { name: 'Дата на напускане (последно)', value: userStore?.leftAt ? formatDateIso(userStore.leftAt) : 'Не е напускал или не е записано', inline: true },
          { name: 'Avatar URL', value: targetUser.displayAvatarURL({ size: 1024 }), inline: false },
          { name: 'Сървъри (където ме вижда)', value: guildsText, inline: false }
        )
        .setThumbnail(targetUser.displayAvatarURL({ size: 128 }))
        .setColor(0x5865F2)
        .setTimestamp();

      return sendEmbedOrText(message.channel, emb, `Информация за ${targetUser.tag}: Nick=${nick}, ID=${targetUser.id}`);
    } catch (e) {
      console.error('info cmd error:', e);
      return message.reply('❌ Грешка при получаване на информация за потребителя.');
    }
  }
  // ====== TEAM CONTACTS ======
if (cmd === 'addteam') {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return message.reply("⚠️ Само администратори могат да добавят контакти към екипа.");
  }

  const text = args.join(" ");
  if (!text) {
    return message.reply("❌ Използвай: `!addteam <контакт>`");
  }

  const gset = ensureGuildSettings(message.guild.id);
  gset.teamContacts = gset.teamContacts || [];

  gset.teamContacts.push(text);
  saveGuildSettings(message.guild.id, gset);

  return message.reply(`✅ Контактът беше добавен: **${text}**`);
}

if (cmd === 'removeteam') {
  if (!message.member.permissions.has(PermissionFlagsBits.Administrator)) {
    return message.reply("⚠️ Само администратори могат да премахват контакти от екипа.");
  }

  if (!args[0]) {
    return message.reply("❌ Използвай: `!removeteam <номер от !team>`");
  }

  const gset = ensureGuildSettings(message.guild.id);
  gset.teamContacts = gset.teamContacts || [];

  const idx = parseInt(args[0], 10) - 1; // превръща се в индекс (1-базирано)
  if (isNaN(idx) || idx < 0 || idx >= gset.teamContacts.length) {
    return message.reply("⚠️ Невалиден номер. Виж `!team` за номерацията.");
  }

  const removed = gset.teamContacts.splice(idx, 1)[0];
  saveGuildSettings(message.guild.id, gset);

  return message.reply(`✅ Контактът беше премахнат: **${removed}**`);
}

if (cmd === 'team') {
  const gset = ensureGuildSettings(message.guild.id);
  gset.teamContacts = gset.teamContacts || [];

  if (gset.teamContacts.length === 0) {
    return message.reply("ℹ️ Все още няма добавени контакти към екипа.");
  }

  const desc = gset.teamContacts.map((c, i) => `${i + 1}. ${c}`).join('\n');
  const emb = new EmbedBuilder()
    .setTitle("👥 Контакт с екипа на сървъра")
    .setDescription(desc)
    .setColor(0x00AE86);

  return sendEmbedOrText(message.channel, emb, desc);
}

});

// ====== REACTIONS ======
client.on('messageReactionAdd', async (reaction, user) => {
  // fetch partials if needed so we have full message/reaction data
  try {
    if (reaction.partial) await reaction.fetch().catch(()=>{});
    if (reaction.message && reaction.message.partial) await reaction.message.fetch().catch(()=>{});
  } catch (e) {}
  if (!reaction.message?.guild || user.bot) return;
  // check pending tic-tac-toe challenges
  try {
    const key = reaction.message.id;
    const ch = pendingChallenges[key];
    if (ch && reaction.emoji.name === '✅') {
      if (user.id !== ch.opponent) return; // only opponent may accept
      const channel = reaction.message.channel;
      await channel.send(`✅ ${user} прие предизвикателството! Играта започва между <@${ch.challenger}> и <@${ch.opponent}>.`);
      // start the game using helper
      const gm = await startTicTacToe(channel, ch.challenger, ch.opponent).catch(()=>null);
      delete pendingChallenges[key];
      return;
    }
    if (ch && reaction.emoji.name === '❌') {
      if (user.id !== ch.opponent && user.id !== ch.challenger) return;
      const channel = reaction.message.channel;
      await channel.send(`❌ Предизвикателството е отказано.`);
      delete pendingChallenges[key];
      return;
    }
  } catch (e) { /* ignore */ }
  const guild = reaction.message.guild;
  const reactorId = user.id;
  const msgAuthor = reaction.message.author;
  const today = new Date().toISOString().split('T')[0];

  // поставил реакция (reactor)
  const rUser = await ensureUser(guild, reactorId);
  rUser.reactionsGiven = (rUser.reactionsGiven || 0) + 1;
  rUser.dailyReactionsGiven[today] = (rUser.dailyReactionsGiven[today] || 0) + 1;
  rUser.lastActiveISO = new Date().toISOString();

  // получил реакция (авторът на съобщението)
  if (msgAuthor && !msgAuthor.bot) {
    const aUser = await ensureUser(guild, msgAuthor.id);
    aUser.reactionsReceived = (aUser.reactionsReceived || 0) + 1;
    aUser.lastActiveISO = new Date().toISOString();
  }

  save();
  // тригър към achievements (анонс в канала на реакцията)
  await checkAchievements(guild, reactorId, reaction.message.channel);
  if (msgAuthor && !msgAuthor.bot) await checkAchievements(guild, msgAuthor.id, reaction.message.channel);

  // --- Tic-tac-toe move handling for active games ---
  try {
    const gKey = reaction.message.id;
    const game = games[gKey];
    if (game && NUMBER_EMOJIS.includes(reaction.emoji.name)) {
      // map emoji to index
      const idx = NUMBER_EMOJIS.indexOf(reaction.emoji.name);
      if (idx < 0) return;
      // who's reacting must be one of the players
      const playerId = reactorId;
      const isX = game.players.X === playerId;
      const isO = game.players.O === playerId;
      if (!isX && !isO) return; // not a player
      // check turn
      if (game.turn !== playerId) {
        // not their turn; optionally notify
        try { await reaction.message.channel.send(`<@${playerId}>, не е твоят ход.`).then(m=>setTimeout(()=>m.delete().catch(()=>{}),3000)).catch(()=>{}); } catch {}
        return;
      }
      // check cell empty
      if (game.board[idx]) return; // already taken
  // place mark
  const mark = isX ? 'X' : 'O';
  game.board[idx] = mark;
      // switch turn
      game.turn = (game.turn === game.players.X) ? game.players.O : game.players.X;

      // check win/draw
      const b = game.board;
      const wins = [
        [0,1,2],[3,4,5],[6,7,8], // rows
        [0,3,6],[1,4,7],[2,5,8], // cols
        [0,4,8],[2,4,6]
      ];
      let winner = null;
      for (const [a,b1,c] of wins) {
        if (game.board[a] && game.board[a] === game.board[b1] && game.board[a] === game.board[c]) {
          winner = game.board[a]; break;
        }
      }
      const isDraw = !winner && game.board.every(cell => cell !== null);

      // update embed
      const renderBoard = (boardArr) => {
        const rows = [];
        for (let r = 0; r < 3; r++) {
          const cells = [];
          for (let c = 0; c < 3; c++) {
            const idxx = r*3 + c;
            const v = boardArr[idxx];
            if (v === 'X') cells.push('❌');
            else if (v === 'O') cells.push('🔴');
            else cells.push(NUMBER_EMOJIS[idxx]);
          }
          rows.push(cells.join(' '));
        }
        return rows.join('\n');
      };

      const channel = await client.channels.fetch(game.channelId).catch(()=>null);
      if (!channel) { delete games[gKey]; return; }
      const boardMsg = await channel.messages.fetch(game.boardMessageId).catch(()=>null);
      if (!boardMsg) { delete games[gKey]; return; }

      const desc = winner ? `Победител: ${winner === 'X' ? `<@${game.players.X}> (❌)` : `<@${game.players.O}> (🔴)`}` : isDraw ? 'Равенство!' : `Ход: <@${game.turn}> (${game.turn === game.players.X ? '❌' : '🔴'})`;
      const newEmb = new EmbedBuilder()
        .setTitle('🎮 Морски шах (Tic-Tac-Toe)')
        .setDescription(desc + '\n\n' + renderBoard(game.board))
        .setColor(winner ? 0x57F287 : 0x5865F2)
        .setTimestamp();

      await boardMsg.edit({ embeds: [newEmb] }).catch(()=>{});

      if (winner || isDraw) {
        // cleanup reactions to prevent further moves
        try { await boardMsg.reactions.removeAll().catch(()=>{}); } catch (e) {}
        delete games[gKey];
        return;
      }

      // if next turn belongs to the bot, schedule AI move
      if (game.turn === client.user.id) {
        setTimeout(() => doAIMove(game.boardMessageId), 700);
      }

      return;
    }
  } catch (e) { /* ignore game errors */ }
});

// ====== VOICE ======
client.on('voiceStateUpdate', async (oldState, newState) => {
  const guild = newState.guild || oldState.guild;
  if (!guild) return;

  const member = newState.member || oldState.member;
  if (!member || member.user.bot) return;

  const gid = guild.id;
  const uid = member.id;
  await ensureUser(guild, uid);
  const u = store[gid].users[uid];
  const now = Date.now();

  const afkId = guild.afkChannelId || null;

  // helper за приключване на сесия
  const endSession = (endChannelId) => {
    if (!u.voice.sessionStart) return;
    const dur = now - u.voice.sessionStart;
    u.voice.totalMs += dur;
    // дълъг разговор
    if (dur >= 3*60*60*1000) u.voice.hadLongSession = true;
    // AFK време се брои, ако сесията е била в AFK
    if (u.voice.sessionChannelId && u.voice.sessionChannelId === afkId) {
      u.voice.inAFKMs = (u.voice.inAFKMs||0) + dur;
    }
    // Дуeт (приближено): ако сесията е започнала с 2-ма и е продължила >=30 мин.
    if (u.voice.lastJoinSize === 2 && dur >= 30*60*1000) u.voice.hadDuet = true;

    u.voice.sessionStart = null;
    u.voice.sessionChannelId = null;
    u.voice.duetStart = null;
    u.voice.lastJoinSize = 0;
  };

  const oldCh = oldState.channelId;
  const newCh = newState.channelId;

  // Напускане / преместване
  if (oldCh && (!newCh || newCh !== oldCh)) {
    endSession(oldCh);
  }

  // Влизане / преместване
  if (newCh && (!oldCh || newCh !== oldCh)) {
    u.voice.sessionStart = now;
    u.voice.sessionChannelId = newCh;
    const ch = guild.channels.cache.get(newCh);
    const size = ch?.members?.size || 0;
    u.voice.lastJoinSize = size;

    // парти животно (10+ в канала при присъединяване)
    if (size >= 10) u.voice.hadParty = true;

    // слушател – първо влизане (ще се маркира в achievements при check)
    if (!u.achievements.firstVoice) u.achievements.firstVoice = true;

    u.lastActiveISO = new Date().toISOString();
  }

  save();
  // анонсите ще се пуснат при следващо текстово действие или реакция; за сигурно – тригърнем към general channel ако има
  const chForAnnounce = getGuildChannel(guild, 'achievements', 'ACHIEVEMENT_CHANNEL_ID');
  const anyTextChannel = chForAnnounce || guild.channels.cache.find(c => c.isTextBased?.());
  if (anyTextChannel) {
    await checkAchievements(guild, uid, anyTextChannel);
  }
});

// ====== INVITE LINKS ======
function getInviteLinks() {
  const clientId = client.user?.id;
  if (!clientId) return null;
  const PERM_VIEW_CHANNEL         = 1024;
  const PERM_SEND_MESSAGES        = 2048;
  const PERM_MANAGE_MESSAGES      = 8192;
  const PERM_EMBED_LINKS          = 16384;
  const PERM_ATTACH_FILES         = 32768;
  const PERM_READ_MESSAGE_HISTORY = 65536;
  const minimal =
    PERM_VIEW_CHANNEL + PERM_SEND_MESSAGES + PERM_MANAGE_MESSAGES +
    PERM_EMBED_LINKS + PERM_ATTACH_FILES + PERM_READ_MESSAGE_HISTORY; // 125952

  return {
    adminInvite:   `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=8`,
    minimalInvite: `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${minimal}`,
    minimal
  };
}

// ====== LOGIN ======
client.login(process.env.DISCORD_TOKEN);

// ====== CONSOLE CONTROL (say/sayto) ======
const readline = require('readline');
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
let consoleTargetChannelId = process.env.CONSOLE_CHANNEL_ID || null;
function printConsoleHelp() {
  console.log(`
🖥️ Console:
  help                       -> помощ
  channel <channelId>        -> задава канал за 'say'
  say <текст>                -> изпраща в текущия канал
  sayto <channelId> <текст>  -> изпраща в конкретен канал
`);}
rl.on('line', async (input) => {
  const line = input.trim(); if (!line) return;
  const [cmd, ...rest] = line.split(' '); const argText = rest.join(' ').trim();
  if (cmd === 'help') return printConsoleHelp();
  if (cmd === 'channel') { if (!rest[0]) return console.log('ℹ️ channel <channelId>'); consoleTargetChannelId = rest[0]; return console.log(`✅ Конзолен канал: ${consoleTargetChannelId}`); }
  if (cmd === 'say') {
    if (!consoleTargetChannelId) return console.log('⚠️ Задай канал: channel <id> или sayto <id> <текст>');
    const ch = client.channels.cache.get(consoleTargetChannelId); if (!ch) return console.log(`⚠️ Няма канал ${consoleTargetChannelId}`);
    try { await ch.send(argText); console.log(`➡️ #${ch.id}: ${argText}`); } catch (e) { console.log(`❗ Грешка: ${e.message}`); } return;
  }
  if (cmd === 'sayto') {
    const i = argText.indexOf(' '); if (i === -1) return console.log('ℹ️ sayto <channelId> <текст>');
    const channelId = argText.slice(0,i); const text = argText.slice(i+1);
    const ch = client.channels.cache.get(channelId); if (!ch) return console.log(`⚠️ Няма канал ${channelId}`);
    try { await ch.send(text); console.log(`➡️ #${ch.id}: ${text}`); } catch (e) { console.log(`❗ Грешка: ${e.message}`); } return;
  }
  console.log('❓ Непозната конзолна команда. Напиши "help".');
});