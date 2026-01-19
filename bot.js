const fs = require('fs');
const path = require('path');
const archiver = require('archiver');
const mineflayer = require('mineflayer');
const { Client, GatewayIntentBits } = require('discord.js');
const { Authflow } = require('prismarine-auth');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');

// ---- Log / warning filter to hide noisy protocol messages ----
const _origLog = console.log.bind(console);
const _origWarn = console.warn.bind(console);
const FILTER_RE = /Chunk size is \d+ but only \d+ was read|partial packet|buffer :|DeprecationWarning/i;
function shouldFilter(msg) {
    if (!msg) return false;
    try { msg = msg.toString(); } catch (e) { }
    return FILTER_RE.test(msg);
}
console.log = (...args) => {
    const txt = args.join(' ');
    if (shouldFilter(txt)) return;
    _origLog(...args);
};
console.warn = (...args) => {
    const txt = args.join(' ');
    if (shouldFilter(txt)) return;
    _origWarn(...args);
};
process.on('warning', (w) => {
    const txt = w && (w.stack || w.message || w.name);
    if (shouldFilter(txt)) return;
    _origWarn(txt);
});
// ---------------------------------------------------------------
const readline = require('readline');

const cfgPath = process.env.AFK_CONFIG || './config.json';
if (!fs.existsSync(cfgPath)) {
    console.error('Config bulunamadı:', cfgPath);
    process.exit(1);
}
const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));

// --- TEKİL ÇALIŞMA KİLİDİ (SINGLE INSTANCE LOCK) ---
const net = require('net');
const LOCK_PORT = 65432; // Bu portu kilitleyeceğiz
const locker = net.createServer();
locker.listen(LOCK_PORT, () => {
    console.log('[System] Tekil çalışma kilidi alındı.');
});
locker.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        console.error('HATA: Bu bot zaten çalışıyor! (Port 65432 dolu)');
        console.error('Lütfen diğer konsolu kapatın.');
        console.error('!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!');
        process.exit(1);
    }
});
// ---------------------------------------------------

let mcBot = null;
let discordClient = null;
let discordChannel = null;
let commandQueue = [];
let queueRunning = false;
const LOG_ROOT = path.resolve('./logs');
const CHAT_DIR = path.join(LOG_ROOT, 'chat');
const EVENT_DIR = path.join(LOG_ROOT, 'events');
const CHAT_FILENAME = 'chat.txt';
const EVENT_FILENAME = 'events.log';
let reconnectDelay = 10000; // ms
const RECONNECT_MAX = 60 * 1000; // 1 minute
let currentChatDate = null;
let currentEventDate = null;


let shouldReconnect = true;
let afkActive = false;
let afkTimer = null;
let loginTimestamp = null;
let isBusy = false; // Spawner kırma vb. işlem yaparken AFK hareketlerini durdurmak için

// Spawner kontrolü için interval
let spawnerCheckInterval = null;

function startAntiAfk() {
    if (afkActive) return;
    afkActive = true;
    scheduleNextAfkMove();
}

function stopAntiAfk() {
    afkActive = false;
    if (afkTimer) {
        clearTimeout(afkTimer);
        afkTimer = null;
    }
}

function scheduleNextAfkMove() {
    if (!afkActive) return;
    // 10 saniye ile 60 saniye arasında rastgele bir süre
    const delay = Math.floor(Math.random() * 50000) + 10000;
    afkTimer = setTimeout(() => {
        performAfkMove();
        scheduleNextAfkMove();
    }, delay);
}

function performAfkMove() {
    if (!mcBot || !afkActive || isBusy) return;
    try {
        // %50 şansla zıpla, %50 şansla etrafa bak
        if (Math.random() > 0.5) {
            mcBot.setControlState('jump', true);
            setTimeout(() => mcBot.setControlState('jump', false), 500);
        } else {
            const yaw = Math.random() * Math.PI * 2;
            const pitch = (Math.random() - 0.5) * Math.PI / 2;
            mcBot.look(yaw, pitch);
        }
    } catch (e) { }
}


function logAndForward(text) {
    if (shouldFilter(text)) return;
    _origLog(text);
    if (discordChannel) {
        discordChannel.send(text).catch(() => { });
    }
}

function ensureLogDirs() {
    try {
        fs.mkdirSync(CHAT_DIR, { recursive: true });
        fs.mkdirSync(EVENT_DIR, { recursive: true });
    } catch (e) { }
}

function dateString(d) {
    return d.toISOString().slice(0, 10);
}

function rotateIfNeeded(type) {
    const nowDate = dateString(new Date());
    if (type === 'chat') {
        if (!currentChatDate) currentChatDate = nowDate;
        if (currentChatDate !== nowDate) {
            performRotate(CHAT_DIR, CHAT_FILENAME, currentChatDate);
            currentChatDate = nowDate;
        }
    } else if (type === 'event') {
        if (!currentEventDate) currentEventDate = nowDate;
        if (currentEventDate !== nowDate) {
            performRotate(EVENT_DIR, EVENT_FILENAME, currentEventDate);
            currentEventDate = nowDate;
        }
    }
}

function performRotate(dir, filename, dateStr) {
    try {
        const filePath = path.join(dir, filename);
        if (!fs.existsSync(filePath)) return;
        const datedName = `${path.basename(filename, path.extname(filename))}-${dateStr}${path.extname(filename)}`;
        const datedPath = path.join(dir, datedName);
        // rename current to dated
        fs.renameSync(filePath, datedPath);
        // create zip
        const zipName = `${path.basename(filename, path.extname(filename))}-${dateStr}.zip`;
        const zipPath = path.join(dir, zipName);
        const output = fs.createWriteStream(zipPath);
        const archive = archiver('zip', { zlib: { level: 9 } });
        output.on('close', () => {
            try { fs.unlinkSync(datedPath); } catch (e) { }
        });
        archive.on('error', (err) => {
            recordEvent('Archive error: ' + (err && err.message ? err.message : err));
        });
        archive.pipe(output);
        archive.file(datedPath, { name: datedName });
        archive.finalize();
    } catch (e) {
        recordEvent('Rotate error: ' + (e && e.message ? e.message : e));
    }
}

function appendLogType(type, text) {
    try {
        ensureLogDirs();
        rotateIfNeeded(type);
        const line = `[${new Date().toISOString()}] ${text}\n`;
        const target = type === 'chat' ? path.join(CHAT_DIR, CHAT_FILENAME) : path.join(EVENT_DIR, EVENT_FILENAME);
        fs.appendFile(target, line, (err) => { });
    } catch (e) { }
}

function recordChat(text) { appendLogType('chat', text); }
function recordEvent(text) { appendLogType('event', text); }

// --- Yeni Özellik: Spawner Kırma ve Çıkma ---

function startSpawnerCheck() {
    if (spawnerCheckInterval) clearInterval(spawnerCheckInterval);
    spawnerCheckInterval = setInterval(checkSurroundings, 5000); // 5 saniyede bir kontrol
}

async function checkSurroundings() {
    if (!mcBot || isBusy) return;

    // 1. Çevrede Oyuncu Var mı? (Maksimum mesafe - Botun görebildiği herkes)
    // nearestEntity'e mesafe vermezsek, load chunklardaki her şeyi tarar.
    const filter = (entity) => entity.type === 'player' && entity.username !== mcBot.username;
    const playerEntity = mcBot.nearestEntity(filter);

    if (!playerEntity) return; // Oyuncu yoksa

    // 2. 10 blok çapında Spawner Var mı? (Hepsini bul)
    const spawnerPositions = mcBot.findBlocks({
        matching: mcBot.registry.blocksByName.spawner.id,
        maxDistance: 10,
        count: 20 // Aynı anda en fazla 20 spawner
    });

    if (spawnerPositions.length === 0) return;

    // Hem oyuncu var hem spawner var.
    logAndForward(`[Auto] Oyuncu tespit edildi (${playerEntity.username}) ve yakında ${spawnerPositions.length} spawner var. Güvenlik protokolü başlatılıyor...`);
    breakAllAndQuit(spawnerPositions);
}

async function breakAllAndQuit(positions) {
    isBusy = true;
    shouldReconnect = false; // Otomatik yeniden bağlanmayı kapat

    try {
        const items = mcBot.inventory.items();
        // 1. İpeksi Kazma Bul (Öncelikli)
        let pickaxeToUse = items.find(item => {
            if (!item.name.includes('pickaxe')) return false;
            if (item.enchants) {
                return item.enchants.some(e => e.name === 'silk_touch' || e.lvl > 0);
            }
            if (item.nbt && item.nbt.value) {
                const enchs = item.nbt.value.Enchantments || item.nbt.value.StoredEnchantments;
                if (enchs && enchs.value && enchs.value.value) {
                    return enchs.value.value.some(e => String(e.id.value || e.id).includes('silk_touch'));
                }
            }
            return false;
        });

        // Fallback: İpeksi yoksa Elmas/Netherite
        if (!pickaxeToUse) {
            pickaxeToUse = items.find(item => item.name === 'diamond_pickaxe' || item.name === 'netherite_pickaxe');
            if (pickaxeToUse) {
                logAndForward('[Auto] İpeksi Dokunuş NBT verisinde görülemedi ancak Elmas/Netherite kazma var. Devam ediliyor.');
            }
        }

        if (!pickaxeToUse) {
            logAndForward('[Auto] Envanterde KAZMA bulunamadı! Spawnerları kıramıyorum ama oyuncu var. (Çıkış yapılıyor güvenlik için)');
            // İsteğe bağlı: Kazma yoksa bile kaçmak için çıkış yapabiliriz.
            mcBot.end();
            return;
        }

        await mcBot.equip(pickaxeToUse, 'hand');

        // Spawner kırma mekaniği için gerekli hareketler
        const defaultMove = new Movements(mcBot);
        defaultMove.canDig = false; // Spawner'a giderken başka blok kırmasın (düşmemek için)
        mcBot.pathfinder.setMovements(defaultMove);

        // Her bir spawner için döngü
        logAndForward(`[Auto] ${positions.length} spawner sırayla kırılacak...`);
        for (const pos of positions) {
            // Bloğun hala spawner olup olmadığını kontrol et
            const block = mcBot.blockAt(pos);
            if (!block || block.name !== 'spawner') continue;

            logAndForward(`[Auto] Spawner'a gidiliyor: (${pos.x}, ${pos.y}, ${pos.z})`);

            // Yanına git (Tam içine girmeye çalışma, 1 blok yakınına git)
            try {
                await mcBot.pathfinder.setGoal(new goals.GoalNear(pos.x, pos.y, pos.z, 1));
            } catch (e) {
                logAndForward(`[Auto] Gidiş hatası: ${e.message}`);
                continue;
            }

            // Hareketi Sıfırla
            mcBot.pathfinder.setGoal(null); // Hedefi kaldır
            mcBot.clearControlStates(); // Tuşları bırak

            // Bloğa bak
            await mcBot.lookAt(pos.offset(0.5, 0.5, 0.5));

            // Kır
            logAndForward('[Auto] Sabitlendi, kırılıyor...');
            mcBot.setControlState('sneak', true);
            try {
                await mcBot.dig(block, 'ignore', 'raycast');
            } catch (digErr) {
                logAndForward(`[Auto Hata] Bloğu kazarken sorun oldu: ${digErr.message}`);
            }
            mcBot.setControlState('sneak', false);

            // Eşyayı toplamak için bekle
            await new Promise(resolve => setTimeout(resolve, 800));
        }

        logAndForward('================================================');
        logAndForward('[Auto] OYUNCU TESPİT EDİLDİ - İŞLEM TAMAMLANDI');
        logAndForward('[Auto] Güvenli çıkış yapılıyor. Sistem kapatılıyor.');
        logAndForward('================================================');

        mcBot.end();
        isBusy = false;

        setTimeout(() => {
            console.log('[System] Process exiting...');
            process.exit(0);
        }, 2000);

    } catch (err) {
        logAndForward(`[Auto Hata] Genel İşlem hatası: ${err.message}`);
        mcBot.setControlState('sneak', false);
        mcBot.end();
        setTimeout(() => process.exit(0), 2000);
    }
}

// ------------------------------------

async function startMinecraft() {
    const mcCfg = {
        host: config.minecraft.host,
        port: config.minecraft.port || 25565,
        username: config.minecraft.username || 'AFKConsoleBot',
        password: config.minecraft.password || undefined,
        auth: config.minecraft.auth || 'mojang',
        version: config.minecraft.version || false
    };

    if (mcCfg.auth === 'microsoft') {
        const useFlow = config.minecraft.useAuthFlow !== false;
        if (useFlow) {
            try {
                const userId = config.minecraft.username || 'afk-console-user';
                const cacheDir = config.authCacheDir || './.auth-cache';
                const flow = new Authflow(userId, cacheDir, { flow: 'live' });
                const tokenResp = await flow.getMinecraftJavaToken({
                    onMsaCode: (device) => {
                        const msg = `[Auth] Lütfen ${device.verification_uri} adresine gidip kodu girin: ${device.user_code}`;
                        _origLog(msg);
                        if (discordChannel) discordChannel.send(msg).catch(() => { });
                        recordEvent('MSA device code shown: ' + device.user_code);
                    }
                });
                if (tokenResp && tokenResp.profile) {
                    mcCfg.username = tokenResp.profile.name;
                    mcCfg.accessToken = tokenResp.token;
                    mcCfg.auth = 'microsoft';
                }
            } catch (e) {
                // Only record unexpected errors; if auth flow is misconfigured, avoid noisy repeated messages
                recordEvent('Auth error: ' + (e.message || e));
                if (config.debug) logAndForward('[Auth] Microsoft token alınamadı: ' + (e.message || e));
            }
        } else {
            _origLog('[Auth] Auth flow devre dışı bırakıldı; yapılandırılmış kimlik bilgileri kullanılacak.');
            recordEvent('Auth flow disabled in config; skipping token retrieval');
        }
    }

    mcBot = mineflayer.createBot(mcCfg);

    // Load plugins
    mcBot.loadPlugin(pathfinder);

    mcBot.on('login', () => {
        loginTimestamp = Date.now();
        logAndForward('[MC] Bot bağlandı');
        recordEvent('Login successful');
        reconnectDelay = 10000;
        // Load and start command queue after login
        loadCommandQueue();
        runCommandQueue();
        // Start Spawner Check
        startSpawnerCheck();
        try {
            if (discordChannel) discordChannel.send('🟢 Bot oyuna girdi').catch(() => { });
        } catch (e) { }
    });

    mcBot.on('end', (reason) => {
        mcBot = null;
        queueRunning = false;
        if (spawnerCheckInterval) clearInterval(spawnerCheckInterval);
        const msg = '[MC] Bağlantı kesildi: ' + (reason || 'unknown');
        logAndForward(msg);
        recordEvent('Disconnected: ' + (reason || 'unknown'));
        scheduleReconnect();
        try {
            if (discordChannel) discordChannel.send('⚠️ Baglanti koptu').catch(() => { });
        } catch (e) { }
    });

    mcBot.on('kicked', (reason) => {
        const msg = '[MC] Kicked: ' + (reason || 'no reason');
        logAndForward(msg);
        recordEvent('Kicked: ' + (reason || 'no reason'));
        try {
            if (discordChannel) discordChannel.send('⚠️ Bot sunucudan atıldı: ' + (reason || 'no reason')).catch(() => { });
        } catch (e) { }
        // For "already online" errors, wait longer before reconnecting
        try { mcBot.end(); } catch (e) { }
        const reasonStr = typeof reason === 'string' ? reason : JSON.stringify(reason || '');
        if (reasonStr.includes('already online')) {
            recordEvent('Already online error detected; waiting 30 seconds before reconnect');
            setTimeout(() => scheduleReconnect(), 30000);
        } else {
            scheduleReconnect();
        }
    });

    mcBot.on('error', (err) => {
        logAndForward('[MC] Hata: ' + err.message);
        recordEvent('Bot error: ' + (err && err.message ? err.message : err));
        // Automatically reconnect on any error
        try { mcBot.end(); } catch (e) { }
        scheduleReconnect();
    });

    mcBot.on('message', (jsonMsg, position) => {
        try {
            const text = jsonMsg.toString();
            logAndForward('[MC] ' + text);
        } catch (e) { }
    });

    mcBot.on('chat', (username, message) => {
        const text = `<${username}> ${message}`;
        // logAndForward(text); // 'message' event'i zaten konsol/discord'a atıyor, burası çift olmasın diye kapalı.
        recordChat(text); // Dosyaya yazma işlemini geri açtık.
    });
}

function scheduleReconnect() {
    if (!shouldReconnect) return;
    const delay = reconnectDelay;
    recordEvent('Reconnecting in ' + delay + 'ms');
    setTimeout(() => {
        startMinecraft().catch((e) => {
            recordEvent('Reconnect attempt failed: ' + (e && e.message ? e.message : e));
            reconnectDelay = Math.min(RECONNECT_MAX, reconnectDelay * 2);
            scheduleReconnect();
        });
    }, delay);
    reconnectDelay = Math.min(RECONNECT_MAX, reconnectDelay * 2);
}

function loadCommandQueue() {
    const commandFile = './commands.txt';
    try {
        if (!fs.existsSync(commandFile)) {
            recordEvent('commands.txt not found, skipping command queue');
            return;
        }
        const content = fs.readFileSync(commandFile, 'utf8');
        const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        commandQueue = [];
        lines.forEach(line => {
            if (line.toLowerCase().startsWith('ms ')) {
                const delayMs = parseInt(line.slice(3));
                if (!isNaN(delayMs)) commandQueue.push({ type: 'delay', ms: delayMs });
            } else {
                commandQueue.push({ type: 'command', text: line });
            }
        });
        recordEvent('Loaded ' + commandQueue.length + ' queue items from commands.txt');
    } catch (e) {
        recordEvent('Error loading commands.txt: ' + (e && e.message ? e.message : e));
    }
}

function runCommandQueue() {
    if (queueRunning || !commandQueue.length) return;
    queueRunning = true;
    processNextCommand();
}

function processNextCommand() {
    if (!commandQueue.length) {
        queueRunning = false;
        recordEvent('Command queue finished');
        return;
    }
    // Bot yoksa veya chat fonksiyonu yoksa (bağlantı kopmuşsa) durdurma, bekle
    if (!mcBot || typeof mcBot.chat !== 'function') {
        queueRunning = false;
        recordEvent('Command queue paused: Bot not ready');
        return;
    }

    const item = commandQueue.shift();
    if (item.type === 'delay') {
        recordEvent('Queue: waiting ' + item.ms + 'ms');
        setTimeout(processNextCommand, item.ms);
    } else if (item.type === 'command') {
        recordEvent('Queue: executing ' + item.text);
        logAndForward('[Queue] ' + item.text);
        try {
            mcBot.chat(item.text);
        } catch (err) {
            logAndForward(`[Queue Error] Komut gönderilemedi: ${err.message}`);
        }
        setTimeout(processNextCommand, 100);
    }
}

function startDiscord() {
    discordClient = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

    discordClient.once('ready', async () => {
        console.log('[Discord] Hazır: ' + discordClient.user.tag);
        try {
            discordChannel = await discordClient.channels.fetch(config.channelId);
            if (!discordChannel) console.error('Discord kanalı bulunamadı:', config.channelId);
            else logAndForward('[Discord] Kanal bağlandı: ' + config.channelId);
        } catch (e) {
            console.error('Discord kanal fetch hatası:', e.message);
        }
    });

    discordClient.on('messageCreate', (msg) => {
        if (!msg.channel) return;
        if (msg.author?.bot) return;
        if (msg.channel.id !== config.channelId.toString()) return;
        const content = msg.content;
        if (!content) return;

        // Komut kontrolü
        if (content.startsWith('!')) {
            const args = content.slice(1).trim().split(/ +/);
            const command = args.shift().toLowerCase();

            if (command === 'afk') {
                if (afkActive) {
                    stopAntiAfk();
                    msg.reply('🛑 Anti-AFK durduruldu.').catch(() => { });
                } else {
                    startAntiAfk();
                    msg.reply('🏃 Anti-AFK başlatıldı (İnsancıl mod).').catch(() => { });
                    performAfkMove(); // Hemen ilk hareketi yap
                }
            } else if (command === 'durum') {
                if (!mcBot) {
                    msg.reply('🔴 Bot şu an bağlı değil.').catch(() => { });
                } else {
                    if (loginTimestamp) {
                        const diff = Date.now() - loginTimestamp;
                        const minutes = Math.floor(diff / 60000);
                        const seconds = Math.floor((diff % 60000) / 1000);
                        msg.reply(`⏱️ Bot **${minutes} dakika ${seconds} saniyedir** oyunda.`).catch(() => { });
                    } else {
                        msg.reply('❓ Bağlı ama süre bilgisi yok.').catch(() => { });
                    }
                }
            } else if (command === 'quit') {
                shouldReconnect = false;
                if (mcBot) {
                    msg.reply('🛑 Bot oyundan çıkıyor ve otomatik bağlanma kapatıldı.').catch(() => { });
                    mcBot.end();
                } else {
                    msg.reply('Zaten bağlı değil (Otomatik bağlanma kapalı).').catch(() => { });
                }
            } else if (command === 'reconnect') {
                shouldReconnect = true;
                if (!mcBot) {
                    msg.reply('🔄 Bağlanılıyor...').catch(() => { });
                    startMinecraft().catch(e => msg.reply('Hata: ' + e.message));
                } else {
                    msg.reply('⚠️ Zaten bağlı (veya bağlanıyor).').catch(() => { });
                }
            }
            return; // Komut olarak işlendi, oyuna gönderme
        }

        // Normal mesaj ise oyuna gönder
        if (mcBot && typeof mcBot.chat === 'function') {
            try {
                mcBot.chat(content);
                logAndForward(`[Discord -> MC] ${msg.author.username}: ${content}`);
            } catch (e) {
                logAndForward(`[Hata] Mesaj gönderilemedi: ${e.message}`);
            }
        } else {
            logAndForward('[Discord -> MC] Bot henüz bağlı değil. Mesaj atılamadı: ' + content);
        }
    });

    discordClient.login(config.discordToken).catch(err => {
        console.error('Discord login hatası:', err.message);
    });
}

function startConsoleInput() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.on('line', (line) => {
        if (!line) return;
        if (mcBot && mcBot.chat) {
            mcBot.chat(line);
            logAndForward('[Console -> MC] ' + line);
        } else {
            logAndForward('[Console] Bot bağlı değil, Discorda yazılıyor: ' + line);
            if (discordChannel) discordChannel.send('[Console] ' + line).catch(() => { });
        }
    });
}

startDiscord();
startMinecraft();
startConsoleInput();
