// bot.js
require('dotenv').config();
const fs = require('fs');
const {
  Client,
  GatewayIntentBits,
  PermissionsBitField,
  Partials,
  EmbedBuilder,
  PermissionFlagsBits,
} = require('discord.js');

// fetch (Node 18+ глобален; иначе ползваме node-fetch динамично)
const fetch = global.fetch || ((...args) => import('node-fetch').then(({ default: f }) => f(...args)));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildVoiceStates
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User]
});

const PREFIX = '!';
const dataFile = './achievements.json'; // пер-гилд структура
const settingsFile = './settings.json';
const gifsFile = './gifs.json';

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

const save         = () => fs.writeFileSync(dataFile, JSON.stringify(store, null, 2));
const saveSettings = () => fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
const saveGifs     = () => fs.writeFileSync(gifsFile, JSON.stringify(gifs, null, 2));

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
  return settings[gid];
}
function saveGuildSettings(gid, gset) {
  settings[gid] = gset;
  try {
    fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  } catch (err) {
    console.error("Error saving settings:", err);
  }
}
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
async function maybeAssignAchievementRoles(guild, userId, unlockedKeys) {
  const gset = ensureGuildSettings(guild.id);
  const achRoles = gset.achRoles || {};
  if (!unlockedKeys?.length) return;

  const me = guild.members.me;
  if (!me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  for (const key of unlockedKeys) {
    const roleId = achRoles[key];
    if (!roleId) continue;
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    if (me.roles.highest.position <= role.position) continue;
    if (!member.roles.cache.has(role.id)) {
      await member.roles.add(role).catch(() => {});
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

  // базови
  if (u.messages >= 10 && !u.achievements.messages10) { u.achievements.messages10 = true; newly.push('messages10'); }
  if (daysBetween(u.joinDate) >= 30 && !u.achievements.veteran30d) { u.achievements.veteran30d = true; newly.push('veteran30d'); }
  if (daysBetween(u.joinDate) >= 365 && !u.achievements.veteran1y) { u.achievements.veteran1y = true; newly.push('veteran1y'); }

  // първото съобщение
  if (u.messages >= 1 && !u.achievements.firstMsg) { u.achievements.firstMsg = true; newly.push('firstMsg'); }

  // нива
  u.levelCache = computeLevel(u);
  const lvl = u.levelCache;
  const lvlKeys = [
    [1,'lvl1'], [5,'lvl5'], [10,'lvl10'], [25,'lvl25'], [50,'lvl50'], [100,'lvl100']
  ];
  for (const [th, key] of lvlKeys) if (lvl >= th && !u.achievements[key]) { u.achievements[key] = true; newly.push(key); }

  // нощна птица
  if (u.nightOwlCount >= 100 && !u.achievements.nightOwl) { u.achievements.nightOwl = true; newly.push('nightOwl'); }

  // маратонец (сума за последните 7 дни)
  const today = new Date();
  let last7 = 0;
  for (let i=0;i<7;i++) {
    const d = new Date(today); d.setDate(today.getDate()-i);
    const key = d.toISOString().split('T')[0];
    last7 += u.dailyCounts[key] || 0;
  }
  if (last7 >= 1000 && !u.achievements.marathon) { u.achievements.marathon = true; newly.push('marathon'); }

  // философ (50 получени реакции)
  if (u.reactionsReceived >= 50 && !u.achievements.philosopher) { u.achievements.philosopher = true; newly.push('philosopher'); }

  // меме лорд (100 картинки)
  if (u.memesCount >= 100 && !u.achievements.memelord) { u.achievements.memelord = true; newly.push('memelord'); }

  // реактор 1-ва и 500
  if (u.reactionsGiven >= 1 && !u.achievements.firstReact) { u.achievements.firstReact = true; newly.push('firstReact'); }
  if (u.reactionsGiven >= 500 && !u.achievements.reactor500) { u.achievements.reactor500 = true; newly.push('reactor500'); }

  // социален – споменат от 10 различни човека (ще поддържаме set)
  if (!u.mentionedBy) u.mentionedBy = {}; // { otherUserId: true }
  if (Object.keys(u.mentionedBy).length >= 10 && !u.achievements.social10) { u.achievements.social10 = true; newly.push('social10'); }

  // гласови
  const v = u.voice || {};
  const minutes = Math.floor((v.totalMs || 0)/60000);
  if (minutes >= 10 && !u.achievements.v_first) { u.achievements.v_first = true; newly.push('v_first'); }
  if (minutes >= 300 && !u.achievements.v_talker) { u.achievements.v_talker = true; newly.push('v_talker'); }
  if (v.hadLongSession && !u.achievements.v_long) { u.achievements.v_long = true; newly.push('v_long'); }
  if (v.hadParty && !u.achievements.v_party) { u.achievements.v_party = true; newly.push('v_party'); }
  if (v.hadDuet && !u.achievements.v_duet) { u.achievements.v_duet = true; newly.push('v_duet'); }
  if ((v.inAFKMs || 0) >= 60*60000 && !u.achievements.v_afk) { u.achievements.v_afk = true; newly.push('v_afk'); }

  if (newly.length) {
    await announceAchievements(channel, userId, newly);
    await maybeAssignAchievementRoles(guild, userId, newly);
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
function getCustomGif(type){ return gifs[type]?.length ? pick(gifs[type]) : null; }
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
// някъде горе в bot.js (над handler-а за guildMemberUpdate)
const nickCache = new Map(); // key: `${guildId}:${userId}` -> lastNickname

// ====== READY ======
client.once('ready', async () => {
  console.log(`🤘 Ботът ${client.user.tag} е онлайн и готов да троши!`);
  // след ready блока, но не вътре в него
client.on('guildMemberUpdate', onNickChange);
// Логване при смяна на глобално име/дисплей име
client.on('userUpdate', async (oldUser, newUser) => {
  const usernameChanged   = oldUser.username    !== newUser.username;
  const displayChanged    = (oldUser.globalName ?? null) !== (newUser.globalName ?? null);
  if (!usernameChanged && !displayChanged) return;

  // мини през всички сървъри, където ботът е и потребителят е член
  for (const guild of client.guilds.cache.values()) {
    const member = guild.members.cache.get(newUser.id);
    if (!member) continue;

    const chId = getGuildChannel(guild.id, 'nicklogs');
    const logChannel = chId && guild.channels.cache.get(chId);
    if (!logChannel) continue;

    const emb = new EmbedBuilder()
      .setTitle('✏️ Смяна на глобално име')
      .setDescription(`${member} промени глобалното си име`)
      .addFields(
        ...(usernameChanged ? [
          { name: 'Стар username', value: oldUser.username || '—', inline: true },
          { name: 'Нов username',  value: newUser.username || '—', inline: true },
        ] : []),
        ...(displayChanged ? [
          { name: 'Стар display name', value: oldUser.globalName || '—', inline: true },
          { name: 'Нов display name',  value: newUser.globalName || '—', inline: true },
        ] : []),
        { name: 'Потребител', value: `${newUser.tag} \`${newUser.id}\`` }
      )
      .setThumbnail(newUser.displayAvatarURL({ size: 128 }))
      .setColor(0xFEE75C)
      .setTimestamp();

    await logChannel.send({ embeds: [emb] });
  }
});
function onNickChange(oldMember, newMember) {
   // (по желание – за по-точно сравнение веднага след старта; тежко за големи сървъри)
  // for (const g of client.guilds.cache.values()) {
  //   try { await g.members.fetch(); } catch (_) {}
  // }

  // Напълни локалния кеш с вече кешираните членове
  client.guilds.cache.forEach(g => {
    g.members.cache.forEach(m => {
      nickCache.set(`${g.id}:${m.id}`, m.nickname || m.user.username);
    });
  });

  console.log(`[nicklog] cached ${nickCache.size} members across ${client.guilds.cache.size} guilds.`);
});

client.on('error', e => console.warn('Client error:', e?.message));
process.on('unhandledRejection', r => console.warn('Unhandled rejection:', r));
// Логика за логване на смяна на ник
async function onNickChange(oldMember, newMember) {
  try {
    if (oldMember.partial) oldMember = await oldMember.fetch().catch(() => null);
    if (newMember.partial) newMember = await newMember.fetch().catch(() => null);
    if (!oldMember || !newMember) return;

    const oldNick = oldMember.nickname ?? oldMember.user.username;
    const newNick = newMember.nickname ?? newMember.user.username;
    if (oldNick === newNick) return;

    const chId = getGuildChannel(newMember.guild.id, 'nicklogs');
    const logChannel = chId && newMember.guild.channels.cache.get(chId);
    if (!logChannel) return;

    const emb = new EmbedBuilder()
      .setTitle('✏️ Смяна на никнейм')
      .setDescription(`${newMember} смени никнейма си`)
      .addFields(
        { name: 'Стар', value: String(oldNick).slice(0, 256), inline: true },
        { name: 'Нов',  value: String(newNick).slice(0, 256), inline: true },
        { name: 'Потребител', value: `${newMember.user.tag} \`${newMember.id}\`` }
      )
      .setThumbnail(newMember.user.displayAvatarURL({ size: 128 }))
      .setColor(0xFEE75C)
      .setTimestamp();

    await logChannel.send({ embeds: [emb] });

    if (typeof nickCache?.set === 'function') {
      nickCache.set(`${newMember.guild.id}:${newMember.id}`, newNick);
    }
  } catch (err) {
    console.error('[nicklog] error:', err);
  }
}

// === LOG NICKNAME CHANGES ===
client.on('guildMemberUpdate', async (oldMember, newMember) => {
  try {
    if (oldMember.partial) oldMember = await oldMember.fetch();
    if (newMember.partial) newMember = await newMember.fetch();

    const curr = newMember.nickname || newMember.user.username;
    const key  = `${newMember.guild.id}:${newMember.id}`;
    const prev = nickCache.get(key) ?? (oldMember.nickname || oldMember.user.username);

    if (prev !== curr) {
      const chId = getGuildChannel(newMember.guild.id, 'nicklogs');
      if (chId) {
        const logChannel = newMember.guild.channels.cache.get(chId);
        if (logChannel) {
          const emb = new EmbedBuilder()
            .setTitle('✏️ Смяна на никнейм')
            .setDescription(`${newMember} смени никнейма си`)
            .addFields(
              { name: 'Стар никнейм', value: String(prev), inline: true },
              { name: 'Нов никнейм', value: String(curr), inline: true }
            )
            .setColor(0xFEE75C)
            .setTimestamp();
          await logChannel.send({ embeds: [emb] });
        }
      }
    }

    // винаги обновявай кеша накрая
    nickCache.set(key, curr);

  } catch (err) {
    console.error('❌ Nickname log error:', err);
  }
});


// ====== MESSAGE EVENTS ======
client.on('messageCreate', async (message) => {
  if (!message.guild || message.author.bot) return;

  const guildId = message.guild.id;
  const userId = message.author.id;
  const isCommand = message.content.startsWith(PREFIX);
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
  }

  if (!isCommand) return;

  // командни аргументи
  const args = message.content.slice(PREFIX.length).trim().split(/\s+/);
  const cmd = (args.shift() || '').toLowerCase();

  // ===== Публични =====
  if (cmd === 'help') {
    const help = new EmbedBuilder()
      .setTitle('📜 Команди на бота')
      .addFields(
        {
          name: '👥 Публични',
          value: [
            '`!help` – списък с команди',
            '`!invite` – линкове за покана',
            '`!achievements` – твоите постижения',
            '`!top` – топ по постижения (този сървър)',
            '`!bgrock` – линк към bgrock.eu',
            '`!ping` – жив ли съм',
            '`!stats` – твоята статистика (вкл. днес, този сървър)',
            '`!today` – кой колко е писал днес (този сървър)',
            '`!messages [@user]` – съобщения на потребител (този сървър)',
            '`!report @user причина | доказателства` – доклад към админите',
            '`!suggest <текст>` – предложение',
            '`!feedback <текст>` – обратна връзка',
            '`!rijkuuu` – социалните мрежи на Rijkuuu',
			'`!socials` – Показва социални мрежи',
			'`!dice` – Хвърля зар',
			'`!rps` – Играеш камък, ножица и хартия',
			'`!team` – Показва контакт за връзка с екипа',
			
          ].join('\n')
        },
        {
          name: '🎭 Roleplay',
          value: [
            '`!kill @user`, `!pat @user`, `!slap @user`, `!hug @user`, `!kiss @user`, `!shakehands @user`, `!wave @user`, `!poke @user`',
            '`!yay`, `!run`, `!lay`, `!attack`, `!defense`, `!cry`, `!sad`, `!happy`, `!angry`',
            '`!drink`, `!hungry`, `!cheers`, `!eat`, `!marry @user`, `!divorce @user`',
            '`!stare`, `!cringe`, `!highfive @user`, `!give предмет @user`',
            '`!laugh`, `!fight @user`, `!money`, `!fly`, `!jump`, `!sell @user`, `!buy [предмет]`, `!sell1 <предмет> @user`',
			`!kick`, `!tickle`, `!punch`
          ].join('\n')
        },
        {
          name: '🛠 Админ',
          value: [
            '`!del <1-100> [@user]`',
            '`!resetachievements`',
            '`!resetmessages [@user|all]` | `!resetdays [@user|all]` | `!resetmentions [@user|all]` | `!resetall [@user|all]`',
            '`!addmessages @user <брой>` / `!rmessages @user <брой>` | `!topres`',
            '`!achsetup (set|clear|list)`',
            '`!addgif <тип> <url>` / `!delgif <тип> <№>` / `!listgifs <тип>` | `!testgifs`',
            '`!setchannel <тип> #канал` | `!showchannels`',
            '`!pin <ID|линк>` / `!unpin <ID|линк>`',
            '`!check bots|users|stats @user`',
            '`!addsocial <url>`',
            '`!monthly` – активност последните 30 дни',
            '`!active @user` – последна активност',
			'!removesocial <url> - Премахва социален линк',
			'!addteam - добавя контакт за връзка с екипа',
			'!removeteam - премахва контакт за връзка с екипа',
			
          ].join('\n')
        }
      )
      .setColor(0x5865F2);
    return sendEmbedOrText(message.channel, help, '📜 Виж списъка с команди в embed-а.');
  }

  if (cmd === 'invite') {
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

  if (cmd === 'ping') return message.reply('🏓 Понг!');
  if (cmd === 'bgrock') return message.channel.send('🎸 https://bgrock.eu/');

  if (cmd === 'rijkuuu') {
  const gset = ensureGuildSettings(message.guild.id);

  const desc =
    'Социалните мрежи на Rijkuuu може да намерите тук\n\n' +
    'Twitch - https://www.twitch.tv/rijkuuu\n\n' +
    'Instagram - https://www.instagram.com/rijkuuu._.art\n\n' +
    'TikTok - https://www.tiktok.com/@rijkuuu.gaming\n\n' +
    'Main profile - https://www.instagram.com/_theangelofdarkness';

  const emb = new EmbedBuilder()
    .setTitle('🌐 Социални мрежи на Rijkuuu')
    .setDescription(desc)
    .setColor(0xFEE75C);

  return sendEmbedOrText(message.channel, emb, desc);
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

  const gifs = require('./gifs.json');
  const arr = gifs.kick || [];
  const gif = arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;

  const embed = new EmbedBuilder()
    .setDescription(`👢 ${message.author} изрита ${t}!`)
    .setColor(0xff0000);

  if (gif) embed.setImage(gif);

  return message.channel.send({ embeds: [embed] });
}

if (cmd === 'tickle') {
  const t = message.mentions.users.first();
  if (!t) return message.reply('ℹ️ Ползвай: `!tickle @user`');

  const gifs = require('./gifs.json');
  const arr = gifs.tickle || [];
  const gif = arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;

  const embed = new EmbedBuilder()
    .setDescription(`🤣 ${message.author} гъделичка ${t}!`)
    .setColor(0xFFC83D);

  if (gif) embed.setImage(gif);

  return message.channel.send({ embeds: [embed] });
}
if (cmd === 'punch') {
  const t = message.mentions.users.first();
  if (!t) return message.reply('⚠️ Трябва да споменеш потребител! Използвай: `!punch @user`');

  const gifs = require('./gifs.json');
  const arr = gifs.punch || [];
  const gif = arr.length ? arr[Math.floor(Math.random() * arr.length)] : null;

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
  if (cmd === 'drink')    return sendRPDynamic(message.channel, `🍺 ${message.author} вдигна чаша!`,'drink');
  if (cmd === 'hungry')   return sendRPDynamic(message.channel, `😋 ${message.author} огладня.`,'hungry');
  if (cmd === 'cheers')   return sendRPDynamic(message.channel, `🥂 ${message.author} каза: Наздраве!`,'cheers');
  if (cmd === 'eat')      return sendRPDynamic(message.channel, `🍽️ ${message.author} похапва.`,'eat');
  if (cmd === 'stare')    return sendRPDynamic(message.channel, `👀 ${message.author} се втренчи.`,'stare');
  if (cmd === 'cringe')   return sendRPDynamic(message.channel, `😬 ${message.author} кринджна.`,'cringe');
  if (cmd === 'laugh')    return sendRPDynamic(message.channel, `😂 ${message.author} се залива от смях.`,'laugh');
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
    'addgif','delgif','listgifs','testgifs','pin','unpin','check','addsocial','monthly','active'
  ];
  if (adminOnly.includes(cmd)) {
    if (!message.member.permissions.has(PermissionsBitField.Flags.Administrator)) {
      return message.reply('⛔ Само администратори.');
    }
  }

  // ===== Админ команди =====
  if (cmd === 'del') {
    const amount = parseInt(args[0],10);
    if (isNaN(amount)||amount<1||amount>100) return message.reply('ℹ️ `!del <1-100> [@user]`');
    const target = message.mentions.users.first();
    const fetched = await message.channel.messages.fetch({ limit: 100 });
    let toDelete = fetched.filter(m => Date.now()-m.createdTimestamp < 14*24*60*60*1000);
    if (target) toDelete = toDelete.filter(m => m.author.id === target.id);
    toDelete = toDelete.first(amount);
    if (!toDelete?.length) return message.reply('⚠️ Няма подходящи съобщения.');
    await message.channel.bulkDelete(toDelete, true).catch(() => {});
    const m = await message.channel.send(`🧹 Изтрити: **${toDelete.length}** ${target?`на ${target}`:''}.`);
    setTimeout(()=>m.delete().catch(()=>{}), 4000);
    const log = getGuildChannel(message.guild, 'logs', 'LOG_CHANNEL_ID');
    log && log.send(`📝 DELETE | 👮 ${message.author} | ${message.channel} | ${toDelete.length}${target?` | 🎯 ${target}`:''}`).catch(()=>{});
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
      save();
      const log = getGuildChannel(message.guild, 'logs', 'LOG_CHANNEL_ID');
      log && log.send(`🗑️ RESETALL от ${message.author} → всички (този сървър).`).catch(()=>{});
      return message.channel.send('🗑️ Всичко е нулирано за **всички** (вкл. joinDate) в този сървър.');
    }
    const u = t || message.author;
    await ensureUser(message.guild, u.id); resetUser(u.id); save();
    const log = getGuildChannel(message.guild, 'logs', 'LOG_CHANNEL_ID');
    log && log.send(`🗑️ RESETALL от ${message.author} → ${u} (този сървър).`).catch(()=>{});
    return message.channel.send(`🗑️ Всичко е нулирано за ${u} (вкл. joinDate) в този сървър.`);
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
      const rows = valid.map(k => `• ${ACH[k]} → ${gset.achRoles[k] ? `<@&${gset.achRoles[k]}>` : '—'}`).join('\n');
      const emb = new EmbedBuilder().setTitle('🏷️ Роли за постижения').setDescription(rows).setColor(0x57F287);
      return sendEmbedOrText(message.channel, emb, `Роли за постижения:\n${rows}`);
    }
    if (sub==='set') {
      const key = (args.shift()||''); if (!valid.includes(key)) return message.reply('❌ Невалиден ключ (виж `!achsetup list`).');
      const role = message.mentions.roles.first(); if (!role) return message.reply('ℹ️ Посочи роля: `!achsetup set <key> @Роля`');
      if (!message.guild.members.me?.permissions.has(PermissionsBitField.Flags.ManageRoles)) return message.reply('⚠️ Липсва право **Manage Roles**.');
      if (message.guild.members.me.roles.highest.position <= role.position) return message.reply('⚠️ Не мога да управлявам тази роля.');
      gset.achRoles[key] = role.id; saveSettings();
      return message.channel.send(`✅ За **${ACH[key]}** ще се дава ${role}.`);
    }
    if (sub==='clear') {
      const key = (args.shift()||''); if (!valid.includes(key)) return message.reply('❌ Невалиден ключ.');
      delete gset.achRoles[key]; saveSettings();
      return message.channel.send(`🧹 Ролята за **${ACH[key]}** е изчистена.`);
    }
    return message.reply('ℹ️ `!achsetup help`');
  }

  if (cmd === 'addgif') { const type=(args[0]||'').toLowerCase(); const url=args[1]||''; if(!type||!url) return message.reply('ℹ️ `!addgif <тип> <url>`'); if(!gifs[type]) gifs[type]=[]; gifs[type].push(url); saveGifs(); return message.channel.send(`✅ Добавен GIF към **${type}**.`); }
  if (cmd === 'delgif') { const type=(args[0]||'').toLowerCase(); const idx=parseInt(args[1],10)-1; if(!type||isNaN(idx)) return message.reply('ℹ️ `!delgif <тип> <номер>`'); if(!gifs[type]||!gifs[type][idx]) return message.reply('⚠️ Няма такъв GIF.'); gifs[type].splice(idx,1); saveGifs(); return message.channel.send(`🗑️ Премахнат GIF #${idx+1} от **${type}**.`); }
  if (cmd === 'listgifs') { const type=(args[0]||'').toLowerCase(); if(!type||!gifs[type]?.length) return message.reply('⚠️ Няма GIF-ове за този тип.'); const list=gifs[type].map((g,i)=>`${i+1}. ${g}`).join('\n'); const emb=new EmbedBuilder().setTitle(`📂 GIF-ове за ${type}`).setDescription(list).setColor(0x5865F2); return sendEmbedOrText(message.channel, emb, `GIF-ове за ${type}:\n${list}`); }

  if (cmd === 'setchannel') {
    const type = (args.shift()||'').toLowerCase();
    const ch = message.mentions.channels.first();
    const allowed = ['reports','logs','console','suggest','feedback','achievements', 'nicklogs'];
    if (!type || !allowed.includes(type) || !ch) {
      return message.reply('ℹ️ `!setchannel <тип> #канал` (тип: reports, logs, console, suggest, feedback, achievements, nicklogs)' );
    }
    setGuildChannel(message.guild.id, type, ch.id);
    if (type === 'console') consoleTargetChannelId = ch.id;
    return message.channel.send(`✅ Зададен канал за **${type}**: <#${ch.id}>`);
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
      `📖 Смяна на никнейм: ${s.nicklogs ? `<#${s.nicklogs}>` : '—'}\n`+
      `🔗 Социалки: ${(s.socialLinks||[]).length} запис(а)`;

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
    const t = message.mentions.users.first();
    if (!t) return message.reply('ℹ️ `!active @user`');
    await ensureUser(message.guild, t.id);
    const d = store[guildId].users[t.id];
    return message.channel.send(`🕒 Последна активност на ${t}: **${new Date(d.lastActiveISO).toLocaleString()}**`);
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
  if (!reaction.message?.guild || user.bot) return;
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