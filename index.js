const { Client, GatewayIntentBits, Collection } = require('discord.js');
const { joinVoiceChannel, createAudioPlayer, createAudioResource, AudioPlayerStatus, VoiceConnectionStatus } = require('@discordjs/voice');
const ytdl = require('@distube/ytdl-core');
const ytSearch = require('yt-search');
require('dotenv').config();

// ============================================================
//  🎭 COLUMBINA — Discord Music Bot
// ============================================================

const BOT_NAME    = 'Columbina';
const PREFIX      = '!';
const OWNER_ID    = process.env.OWNER_ID;   // Set in .env

// Per-guild set of user IDs allowed to use no-prefix commands
// Persisted in memory; resets on restart (extend with a JSON file if needed)
const noPrefixUsers = new Map(); // guildId -> Set<userId>

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// Queue: Map of guildId -> { songs: [], player, connection, textChannel }
const queues = new Map();

// ── Ready ────────────────────────────────────────────────────
client.once('ready', () => {
  console.log(`✅ ${BOT_NAME} is online as ${client.user.tag}`);
  client.user.setActivity(`🎵 ${PREFIX}help for commands`);
});

// ── Message handler ──────────────────────────────────────────
client.on('messageCreate', async (message) => {
  if (message.author.bot) return;

  const guildId   = message.guild?.id;
  const authorId  = message.author.id;
  const isOwner   = authorId === OWNER_ID;

  // Determine if this message is a command ─────────────────
  // Priority: prefix first, then no-prefix whitelist
  let content;
  if (message.content.startsWith(PREFIX)) {
    content = message.content.slice(PREFIX.length).trim();
  } else if (isOwner || (guildId && noPrefixUsers.get(guildId)?.has(authorId))) {
    content = message.content.trim();
  } else {
    return; // not a command
  }

  if (!content) return;
  const args    = content.split(/ +/);
  const command = args.shift().toLowerCase();

  // ── OWNER-ONLY: grant no-prefix ──────────────────────────
  if (command === 'grant') {
    if (!isOwner) return message.reply(`🔒 Only **${BOT_NAME}'s owner** can use this command.`);

    const target = message.mentions.users.first();
    if (!target) return message.reply('❌ Mention a user to grant no-prefix access.\nUsage: `!grant @user`');

    if (!noPrefixUsers.has(guildId)) noPrefixUsers.set(guildId, new Set());
    noPrefixUsers.get(guildId).add(target.id);

    return message.reply(`✅ **${target.username}** can now use ${BOT_NAME} without the \`${PREFIX}\` prefix!`);
  }

  // ── OWNER-ONLY: revoke no-prefix ────────────────────────
  if (command === 'revoke') {
    if (!isOwner) return message.reply(`🔒 Only **${BOT_NAME}'s owner** can use this command.`);

    const target = message.mentions.users.first();
    if (!target) return message.reply('❌ Mention a user to revoke no-prefix access.\nUsage: `!revoke @user`');

    noPrefixUsers.get(guildId)?.delete(target.id);
    return message.reply(`✅ Removed no-prefix access from **${target.username}**.`);
  }

  // ── OWNER-ONLY: list no-prefix users ────────────────────
  if (command === 'noprefix') {
    if (!isOwner) return message.reply(`🔒 Only **${BOT_NAME}'s owner** can use this command.`);

    const set = noPrefixUsers.get(guildId);
    if (!set || set.size === 0) return message.reply('📭 No users have no-prefix access in this server.');

    const list = [...set].map((id) => `<@${id}>`).join(', ');
    return message.reply(`🎟️ **No-prefix users:** ${list}`);
  }

  // ── PLAY ─────────────────────────────────────────────────
  if (command === 'play' || command === 'p') {
    if (!args.length) return message.reply('❌ Please provide a song name or YouTube URL.');

    const voiceChannel = message.member?.voice?.channel;
    if (!voiceChannel) return message.reply('❌ You need to be in a voice channel!');

    const permissions = voiceChannel.permissionsFor(message.client.user);
    if (!permissions.has('Connect') || !permissions.has('Speak'))
      return message.reply('❌ I need **Connect** and **Speak** permissions in your voice channel!');

    const query = args.join(' ');
    message.channel.send(`🔍 Searching for **${query}**...`);

    try {
      let url, title, duration = '', thumbnail = '';

      if (!query.startsWith('http')) {
        const results = await ytSearch(query);
        if (!results.videos.length) return message.reply('❌ No results found!');
        const video = results.videos[0];
        url = video.url; title = video.title;
        duration = video.timestamp; thumbnail = video.thumbnail;
      } else {
        const info = await ytdl.getInfo(query);
        url = query;
        title = info.videoDetails.title;
        duration = formatDuration(parseInt(info.videoDetails.lengthSeconds));
        thumbnail = info.videoDetails.thumbnails[0]?.url;
      }

      const song = { url, title, duration, thumbnail, requestedBy: message.author.username };

      let queue = queues.get(guildId);
      if (!queue) {
        queue = {
          songs: [], player: createAudioPlayer(),
          connection: null, textChannel: message.channel,
        };
        queues.set(guildId, queue);

        queue.player.on(AudioPlayerStatus.Idle, () => {
          queue.songs.shift();
          if (queue.songs.length > 0) {
            playSong(guildId, queue.songs[0]);
          } else {
            queue.textChannel.send(`✅ Queue finished! ${BOT_NAME} is leaving the voice channel.`);
            setTimeout(() => { queue.connection?.destroy(); queues.delete(guildId); }, 3000);
          }
        });

        queue.player.on('error', (err) => {
          console.error('Player error:', err);
          queue.textChannel.send(`❌ Audio error: ${err.message}`);
        });
      }

      queue.songs.push(song);
      queue.textChannel = message.channel;

      if (!queue.connection || queue.connection.state.status === VoiceConnectionStatus.Destroyed) {
        queue.connection = joinVoiceChannel({
          channelId: voiceChannel.id,
          guildId,
          adapterCreator: message.guild.voiceAdapterCreator,
        });
        queue.connection.subscribe(queue.player);
      }

      if (queue.songs.length === 1) {
        message.channel.send(`▶️ Now playing: **${title}** \`[${duration}]\` — requested by ${message.author.username}`);
        playSong(guildId, song);
      } else {
        message.channel.send(`➕ Added to queue: **${title}** \`[${duration}]\` (position #${queue.songs.length})`);
      }
    } catch (err) {
      console.error(err);
      message.reply(`❌ Error: ${err.message}`);
    }
  }

  // ── SKIP ─────────────────────────────────────────────────
  else if (command === 'skip' || command === 's') {
    const queue = queues.get(guildId);
    if (!queue?.songs.length) return message.reply('❌ Nothing is playing!');
    queue.player.stop();
    message.channel.send('⏭️ Skipped!');
  }

  // ── STOP ─────────────────────────────────────────────────
  else if (command === 'stop') {
    const queue = queues.get(guildId);
    if (!queue) return message.reply('❌ Nothing is playing!');
    queue.songs = [];
    queue.player.stop();
    queue.connection?.destroy();
    queues.delete(guildId);
    message.channel.send('⏹️ Stopped and cleared the queue.');
  }

  // ── PAUSE ────────────────────────────────────────────────
  else if (command === 'pause') {
    const queue = queues.get(guildId);
    if (!queue) return message.reply('❌ Nothing is playing!');
    queue.player.pause();
    message.channel.send('⏸️ Paused.');
  }

  // ── RESUME ───────────────────────────────────────────────
  else if (command === 'resume' || command === 'r') {
    const queue = queues.get(guildId);
    if (!queue) return message.reply('❌ Nothing is paused!');
    queue.player.unpause();
    message.channel.send('▶️ Resumed.');
  }

  // ── QUEUE ────────────────────────────────────────────────
  else if (command === 'queue' || command === 'q') {
    const queue = queues.get(guildId);
    if (!queue?.songs.length) return message.reply('📭 The queue is empty.');
    const list = queue.songs
      .map((s, i) => `${i === 0 ? '▶️' : `${i}.`} **${s.title}** \`[${s.duration}]\` — ${s.requestedBy}`)
      .join('\n');
    message.channel.send(`🎵 **Queue (${queue.songs.length} songs):**\n${list}`);
  }

  // ── NOW PLAYING ──────────────────────────────────────────
  else if (command === 'np' || command === 'nowplaying') {
    const queue = queues.get(guildId);
    if (!queue?.songs.length) return message.reply('❌ Nothing is playing!');
    const s = queue.songs[0];
    message.channel.send(`🎵 Now playing: **${s.title}** \`[${s.duration}]\` — requested by ${s.requestedBy}`);
  }

  // ── LEAVE ────────────────────────────────────────────────
  else if (command === 'leave' || command === 'disconnect') {
    const queue = queues.get(guildId);
    if (queue) {
      queue.songs = [];
      queue.player.stop();
      queue.connection?.destroy();
      queues.delete(guildId);
    }
    message.channel.send(`👋 ${BOT_NAME} has left the voice channel.`);
  }

  // ── HELP ─────────────────────────────────────────────────
  else if (command === 'help') {
    const isNoPrefixUser = isOwner || noPrefixUsers.get(guildId)?.has(authorId);
    const p = isNoPrefixUser ? '' : PREFIX;

    message.channel.send(`
🎭 **${BOT_NAME} — Commands**

**Music**
\`${PREFIX}play <song/url>\` — Play a song or add to queue
\`${PREFIX}skip\` — Skip current song
\`${PREFIX}stop\` — Stop and clear queue
\`${PREFIX}pause\` / \`${PREFIX}resume\` — Pause or resume
\`${PREFIX}queue\` — Show the queue
\`${PREFIX}np\` — Show now playing
\`${PREFIX}leave\` — Disconnect bot

**Owner Only** 🔒
\`${PREFIX}grant @user\` — Give a user no-prefix access
\`${PREFIX}revoke @user\` — Remove no-prefix access
\`${PREFIX}noprefix\` — List no-prefix users

**Aliases:** \`p\` = play, \`s\` = skip, \`q\` = queue, \`r\` = resume
    `.trim());
  }
});

// ── Helpers ──────────────────────────────────────────────────
function playSong(guildId, song) {
  const queue = queues.get(guildId);
  if (!queue) return;
  const stream = ytdl(song.url, {
    filter: 'audioonly', quality: 'highestaudio',
    highWaterMark: 1 << 25,
  });
  queue.player.play(createAudioResource(stream));
}

function formatDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

client.login(process.env.DISCORD_TOKEN);
