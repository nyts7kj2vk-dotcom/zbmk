require('dotenv').config();

const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const {
  joinVoiceChannel,
  createAudioPlayer,
  createAudioResource,
  AudioPlayerStatus,
  VoiceConnectionStatus,
  entersState,
  StreamType,
} = require('@discordjs/voice');
const youtubedl = require('youtube-dl-exec');
const { spawn } = require('node:child_process');

const TOKEN = (process.env.DISCORD_TOKEN || '').trim();
const PREFIX = process.env.COMMAND_PREFIX ?? '';
const VOLUME = Math.max(0, Math.min(1, Number(process.env.VOLUME || 0.65)));

if (!TOKEN) {
  console.error('DISCORD_TOKEN is missing. Add your bot token to the .env file.');
  process.exit(1);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

const guildStates = new Map();

function getState(guildId) {
  if (!guildStates.has(guildId)) {
    const player = createAudioPlayer();
    const state = { player, connection: null, queue: [], current: null, ffmpeg: null };

    player.on(AudioPlayerStatus.Idle, () => {
      stopFfmpeg(state);
      state.current = null;
      playNext(guildId).catch(console.error);
    });
    player.on('error', (error) => {
      console.error('Audio player error:', error);
      stopFfmpeg(state);
      state.current = null;
      playNext(guildId).catch(console.error);
    });

    guildStates.set(guildId, state);
  }
  return guildStates.get(guildId);
}

function stopFfmpeg(state) {
  if (state.ffmpeg && !state.ffmpeg.killed) {
    state.ffmpeg.kill('SIGKILL');
  }
  state.ffmpeg = null;
}

function isHttpUrl(value) {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

async function extractTrack(url, requester) {
  const raw = await youtubedl(url, {
    dumpSingleJson: true,
    noPlaylist: true,
    format: 'bestaudio/best',
    quiet: true,
    noWarnings: true,
    socketTimeout: 20,
    retries: 3,
    extractorRetries: 2,
  });

  const info = typeof raw === 'string' ? JSON.parse(raw) : raw;
  if (!info) throw new Error('Could not read track information.');
  const entry = Array.isArray(info.entries) ? info.entries.find(Boolean) : info;
  if (!entry || !entry.url) throw new Error('No playable audio stream was found.');

  return {
    streamUrl: entry.url,
    title: entry.title || 'Untitled track',
    webpageUrl: entry.webpage_url || url,
    requester,
  };
}

async function updatePresence(track) {
  try {
    await client.user.setPresence({
      status: 'online',
      activities: track ? [{ name: track.title.slice(0, 128), type: ActivityType.Listening }] : [],
    });
  } catch (error) {
    console.error('Presence update failed:', error);
  }
}

async function playNext(guildId) {
  const state = getState(guildId);
  if (!state.connection || state.player.state.status !== AudioPlayerStatus.Idle) return;

  const track = state.queue.shift();
  if (!track) {
    await updatePresence(null);
    return; // Keep the bot connected to the voice channel, as the Python version does.
  }

  state.current = track;
  try {
    const ffmpeg = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error',
      '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5',
      '-i', track.streamUrl,
      '-vn', '-f', 's16le', '-ar', '48000', '-ac', '2', 'pipe:1',
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    state.ffmpeg = ffmpeg;
    ffmpeg.stderr.on('data', (data) => console.error('FFmpeg:', data.toString().trim()));
    ffmpeg.on('error', (error) => console.error('FFmpeg process error:', error));

    const resource = createAudioResource(ffmpeg.stdout, {
      inputType: StreamType.Raw,
      inlineVolume: true,
    });
    resource.volume.setVolume(VOLUME);
    state.player.play(resource);
    await updatePresence(track);
    console.log(`Now playing in guild ${guildId}: ${track.title}`);
  } catch (error) {
    console.error('Could not start track:', error);
    stopFfmpeg(state);
    state.current = null;
    setImmediate(() => playNext(guildId).catch(console.error));
  }
}

async function connectToMemberChannel(message) {
  const channel = message.member?.voice?.channel;
  if (!channel) throw new Error('ادخل روم صوتي أولًا ثم أرسل الأمر.');
  if (!channel.joinable || !channel.speakable) {
    throw new Error('ما عندي صلاحية دخول الروم أو التحدث فيه.');
  }

  const state = getState(message.guild.id);
  if (state.connection && state.connection.joinConfig.channelId !== channel.id) {
    state.connection.destroy();
    state.connection = null;
  }

  if (!state.connection) {
    state.connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: message.guild.id,
      adapterCreator: message.guild.voiceAdapterCreator,
      selfDeaf: true,
    });
    state.connection.subscribe(state.player);
    state.connection.on(VoiceConnectionStatus.Disconnected, async () => {
      try {
        await Promise.race([
          entersState(state.connection, VoiceConnectionStatus.Signalling, 5_000),
          entersState(state.connection, VoiceConnectionStatus.Connecting, 5_000),
        ]);
      } catch {
        state.connection?.destroy();
        state.connection = null;
      }
    });
    await entersState(state.connection, VoiceConnectionStatus.Ready, 20_000);
  }
  return state;
}

function splitCommand(content) {
  let text = content.trim();
  if (PREFIX && !text.startsWith(PREFIX)) return null;
  if (PREFIX) text = text.slice(PREFIX.length).trim();
  const match = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  if (!match) return null;
  return { command: match[1].toLowerCase(), args: (match[2] || '').trim() };
}

client.once('ready', async () => {
  console.log(`Logged in as ${client.user.tag}`);
  await updatePresence(null);
});

client.on('messageCreate', async (message) => {
  if (message.author.bot || !message.guild) return;
  const parsed = splitCommand(message.content);
  if (!parsed) return;

  const { command, args } = parsed;
  const reply = (content) => message.reply({ content, allowedMentions: { repliedUser: false } });

  if (['cmz', 'play', 'شغل'].includes(command)) {
    if (!args) return reply(`اكتب الرابط بهذا الشكل: \`${PREFIX}cmz رابط_الأغنية\``);
    if (!isHttpUrl(args)) return reply('أرسل رابطًا كاملًا يبدأ بـ http:// أو https://');

    try {
      const state = await connectToMemberChannel(message);
      const status = await reply('أتحقق من الرابط وأجهّز الأغنية...');
      const track = await extractTrack(args, message.author.tag);
      state.queue.push(track);
      const position = state.queue.length;
      await status.edit(`أُضيفت إلى الطابور: **${track.title.replace(/[*_`~|]/g, '\\$&')}** — الطلب من ${message.author} (الموضع: ${position})`);
      await playNext(message.guild.id);
    } catch (error) {
      console.error('Track request failed:', error);
      return reply(`ما قدرت أشغّل الرابط. تأكد أنه متاح وجرب رابطًا آخر. التفاصيل: \`${String(error.message || error).slice(0, 200)}\``);
    }
    return;
  }

  if (['skip', 'تخطي'].includes(command)) {
    const state = getState(message.guild.id);
    if (![AudioPlayerStatus.Playing, AudioPlayerStatus.Paused].includes(state.player.state.status)) return reply('ما فيه أغنية شغالة حاليًا.');
    state.player.stop(true);
    return reply('تم تخطي الأغنية.');
  }

  if (['pause', 'إيقاف'].includes(command)) {
    const state = getState(message.guild.id);
    if (state.player.pause()) return reply('تم الإيقاف المؤقت.');
    return reply('ما فيه أغنية شغالة.');
  }

  if (['resume', 'كمل'].includes(command)) {
    const state = getState(message.guild.id);
    if (state.player.unpause()) return reply('كملنا تشغيل الأغنية.');
    return reply('ما فيه أغنية موقوفة مؤقتًا.');
  }

  if (['queue', 'طابور'].includes(command)) {
    const state = getState(message.guild.id);
    if (!state.queue.length) return reply('الطابور فاضي.');
    const lines = state.queue.slice(0, 10).map((track, i) => `${i + 1}. ${track.title} — ${track.requester}`);
    return reply(`**الأغاني القادمة:**\n${lines.join('\n')}`);
  }

  if (['help', 'مساعدة'].includes(command)) {
    return reply(`\`${PREFIX}cmz رابط\` تشغيل/إضافة أغنية\n\`${PREFIX}skip\` تخطي\n\`${PREFIX}pause\` إيقاف مؤقت\n\`${PREFIX}resume\` متابعة\n\`${PREFIX}queue\` عرض الطابور\nيبقى البوت في الروم بعد انتهاء الأغنية.`);
  }
});

client.on('error', (error) => console.error('Discord client error:', error));

process.on('SIGINT', () => {
  for (const state of guildStates.values()) {
    stopFfmpeg(state);
    state.connection?.destroy();
  }
  client.destroy();
  process.exit(0);
});

client.login(TOKEN).catch((error) => {
  console.error('Discord login failed. Check DISCORD_TOKEN in .env:', error.message);
  process.exit(1);
});
