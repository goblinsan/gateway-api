const fs = require('fs').promises;
const path = require('path');
const https = require('https');
const http = require('http');
const Jimp = require('jimp');

const UNSPLASH_ACCESS_KEY = process.env.UNSPLASH_ACCESS_KEY;

// Each bot's personality drives its palette inspiration chain:
// seed word → datamuse association → unsplash image → extracted palette
const BOT_PERSONALITIES = {
    mireille:   { seeds: ['jazz', 'patisserie', 'lavender', 'champagne', 'ballet', 'autumn', 'lace'] },
    hex_junkie: { seeds: ['circuit', 'neon', 'ramen', 'keyboard', 'plasma', 'glitch', 'laser'] },
    sol_studio: { seeds: ['surfing', 'lemon', 'california', 'sunrise', 'sand', 'tide', 'hammock'] },
    nyx:        { seeds: ['midnight', 'cathedral', 'obsidian', 'galaxy', 'smoke', 'eclipse', 'onyx'] },
    sundrop:    { seeds: ['mango', 'sunflower', 'tropics', 'citrus', 'coral', 'marigold', 'saffron'] },
    fieldnotes: { seeds: ['hiking', 'forest', 'mushroom', 'fog', 'moss', 'fern', 'pine'] },
    retrograde: { seeds: ['vinyl', 'cassette', 'diner', 'polaroid', 'chrome', 'arcade', 'television'] },
    civic_grey: { seeds: ['concrete', 'overcast', 'urban', 'steel', 'subway', 'rain', 'asphalt'] },
    pastelwave: { seeds: ['blossom', 'mochi', 'cotton', 'daydream', 'rose', 'petal', 'cloud'] },
    inkwell:    { seeds: ['coffee', 'library', 'ink', 'parchment', 'candle', 'leather', 'sepia'] },
    saltflat:   { seeds: ['desert', 'salt', 'mirage', 'horizon', 'bleached', 'dust', 'bone'] },
    velvetroom: { seeds: ['velvet', 'bourbon', 'candlelight', 'silk', 'noir', 'burgundy', 'mahogany'] },
    chromalab:  { seeds: ['pigment', 'paint', 'watercolor', 'spectrum', 'dye', 'prism', 'gradient'] },
    zestpop:    { seeds: ['citrus', 'bubblegum', 'candy', 'neon', 'soda', 'confetti', 'sherbet'] },
    driftwood:  { seeds: ['driftwood', 'fog', 'tide', 'barnacle', 'kelp', 'coastal', 'pebble'] },
};

const BOTS = Object.keys(BOT_PERSONALITIES);

const WORKSPACE_DIR = '/home/momito/.openclaw/workspace';
const ACTIVITY_LOG_PATH = path.join(WORKSPACE_DIR, 'memory', 'kulrs-activity-log.json');
const AUTH_HEALTH_LOG_PATH = path.join(WORKSPACE_DIR, 'memory', 'kulrs-auth-health.json');
const CREDS_PATH = '/home/momito/.openclaw/kulrs.json';
const CRON_LOG_PATH = path.join(WORKSPACE_DIR, 'memory', 'kulrs-cron.log');
const CRON_LOG_MAX_LINES = 100;

async function rotateCronLog() {
    try {
        const data = await fs.readFile(CRON_LOG_PATH, 'utf-8');
        const lines = data.split('\n');
        if (lines.length > CRON_LOG_MAX_LINES) {
            await fs.writeFile(CRON_LOG_PATH, lines.slice(-CRON_LOG_MAX_LINES).join('\n'), 'utf-8');
        }
    } catch (e) {
        if (e.code !== 'ENOENT') console.warn('Log rotate failed:', e.message);
    }
}

// --- Helpers ---

async function readJson(filePath, defaultValue = null) {
    try {
        const data = await fs.readFile(filePath, 'utf-8');
        if (data.trim() === '') return defaultValue;
        return JSON.parse(data);
    } catch (error) {
        if (error.code === 'ENOENT') return defaultValue;
        if (error instanceof SyntaxError) return defaultValue;
        throw error;
    }
}

async function writeJson(filePath, data) {
    await fs.writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}

function httpsGet(url) {
    return new Promise((resolve, reject) => {
        const options = {
            headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36' },
        };
        https.get(url, options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    reject(new Error(`httpsGet ${url} returned ${res.statusCode}`));
                    return;
                }
                try { resolve({ status: res.statusCode, body: JSON.parse(body) }); }
                catch (e) { reject(new Error(`JSON parse failed for ${url}: ${e.message}`)); }
            });
        }).on('error', reject);
    });
}

function apiRequest(options, postData = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => {
                try {
                    if (res.statusCode >= 200 && res.statusCode < 300) {
                        resolve(JSON.parse(body || '{}'));
                    } else {
                        reject(new Error(`API ${options.path} failed ${res.statusCode}: ${body}`));
                    }
                } catch (e) {
                    reject(new Error(`Failed to parse response from ${options.path}: ${e.message}`));
                }
            });
        });
        req.on('error', reject);
        if (postData) req.write(postData);
        req.end();
    });
}

async function signInBot(email, password, apiKey) {
    const body = JSON.stringify({ email, password, returnSecureToken: true });
    const options = {
        hostname: 'identitytoolkit.googleapis.com',
        path: `/v1/accounts:signInWithPassword?key=${apiKey}`,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const res = await apiRequest(options, body);
    return res.idToken;
}

// --- Inspiration Chain ---

// Step 1: pick a random seed from the bot's personality
function pickSeed(bot) {
    const seeds = BOT_PERSONALITIES[bot].seeds;
    return seeds[Math.floor(Math.random() * seeds.length)];
}

// Step 2: get words strongly associated with the seed via Datamuse
async function getAssociatedWord(seed) {
    const { status, body } = await httpsGet(
        `https://api.datamuse.com/words?rel_trg=${encodeURIComponent(seed)}&max=30`
    );
    if (status !== 200 || !Array.isArray(body) || body.length === 0) {
        throw new Error(`Datamuse returned no associations for "${seed}"`);
    }
    // Pick from top 15 results (higher score = stronger association)
    const pool = body.slice(0, 15);
    return pool[Math.floor(Math.random() * pool.length)].word;
}

// Step 3: search Unsplash for photos matching the associated word
async function searchUnsplash(query) {
    if (!UNSPLASH_ACCESS_KEY) throw new Error('UNSPLASH_ACCESS_KEY env var not set');
    const options = {
        hostname: 'api.unsplash.com',
        path: `/search/photos?page=1&per_page=20&query=${encodeURIComponent(query)}`,
        method: 'GET',
        headers: {
            'Authorization': `Client-ID ${UNSPLASH_ACCESS_KEY}`,
            'Accept-Version': 'v1',
        },
    };
    const res = await apiRequest(options);
    if (!res.results || res.results.length === 0) {
        throw new Error(`Unsplash returned no photos for "${query}"`);
    }
    const photo = res.results[Math.floor(Math.random() * res.results.length)];
    return { url: photo.urls.small, id: photo.id, description: photo.alt_description || query };
}

// Step 4: download image and extract sampled RGB pixels (max 5000)
async function extractPixelsFromUrl(imageUrl) {
    const buffer = await new Promise((resolve, reject) => {
        const client = imageUrl.startsWith('https') ? https : http;
        const get = (url) => client.get(url, (res) => {
            if (res.statusCode === 301 || res.statusCode === 302) {
                return get(res.headers.location);
            }
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => resolve(Buffer.concat(chunks)));
            res.on('error', reject);
        }).on('error', reject);
        get(imageUrl);
    });

    const image = await Jimp.read(buffer);
    const { width, height } = image.bitmap;
    const total = width * height;
    const step = Math.max(1, Math.floor(total / 5000));
    const pixels = [];
    for (let i = 0; i < total; i += step) {
        const x = i % width;
        const y = Math.floor(i / width);
        const rgba = Jimp.intToRGBA(image.getPixelColor(x, y));
        pixels.push({ r: rgba.r, g: rgba.g, b: rgba.b });
    }
    return pixels;
}

// Step 5: POST pixels to Kulrs /generate/image → get OKLCH palette
async function generatePaletteFromPixels(pixels, token) {
    const body = JSON.stringify({ pixels, colorCount: 5 });
    const options = {
        hostname: 'api.kulrs.com',
        path: '/generate/image',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Origin': 'https://kulrs.com',
            'User-Agent': 'Mozilla/5.0',
            'Content-Length': Buffer.byteLength(body),
        },
    };
    const res = await apiRequest(options, body);
    return res.data; // { colors: [{role, color: {h,c,l}}], metadata: {...} }
}

// --- Core Actions ---

async function performCreateAction(bot, token) {
    const seed = pickSeed(bot);
    let word;
    try {
        word = await getAssociatedWord(seed);
    } catch (e) {
        console.warn(`Datamuse fallback for "${seed}": ${e.message}`);
        word = seed;
    }
    const photo = await searchUnsplash(word);
    const pixels = await extractPixelsFromUrl(photo.url);
    const generated = await generatePaletteFromPixels(pixels, token);

    const postBody = JSON.stringify({
        palette: {
            colors: generated.colors,
            metadata: {
                generator: `kulrs-pulse:${bot}`,
                explanation: `${seed} → ${word}`,
                timestamp: new Date().toISOString(),
            },
        },
        name: `${word} by ${bot}`,
        description: `Inspired by "${seed}" → "${word}"`,
        isPublic: true,
    });
    const options = {
        hostname: 'api.kulrs.com',
        path: '/palettes',
        method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'Origin': 'https://kulrs.com',
            'User-Agent': 'Mozilla/5.0',
            'Content-Length': Buffer.byteLength(postBody),
        },
    };
    const res = await apiRequest(options, postBody);
    const paletteId = res.data.id;
    console.log(`[${bot}] CREATE ok: seed="${seed}" word="${word}" image="${photo.description}" photo_id="${photo.id}" palette=${paletteId}`);
    return paletteId;
}

async function performLikeAction(bot, token, activityLog) {
    const likedIds = new Set(
        activityLog.filter(e => e.action === 'LIKE' && e.result === 'ok').map(e => e.target)
    );
    const twentyMinutesAgo = Date.now() - 20 * 60 * 1000;
    const options = {
        hostname: 'api.kulrs.com', path: '/palettes?sort=popular&limit=50', method: 'GET',
        headers: { 'Origin': 'https://kulrs.com', 'User-Agent': 'Mozilla/5.0' },
    };
    const res = await apiRequest(options);
    const palettes = res.data;
    if (!palettes || palettes.length === 0) throw new Error('No palettes returned to like');

    const eligible = palettes.filter(
        p => !likedIds.has(p.id) && new Date(p.createdAt).getTime() < twentyMinutesAgo
    );
    if (eligible.length === 0) throw new Error('No eligible palettes to like');

    const target = eligible[Math.floor(Math.random() * eligible.length)];
    const likeBody = JSON.stringify({});
    const postOptions = {
        hostname: 'api.kulrs.com', path: `/palettes/${target.id}/like`, method: 'POST',
        headers: {
            'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json',
            'Origin': 'https://kulrs.com', 'User-Agent': 'Mozilla/5.0',
            'Content-Length': Buffer.byteLength(likeBody),
        },
    };
    await apiRequest(postOptions, likeBody);
    return target.id;
}

// --- Main ---

async function main() {
    await rotateCronLog();
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const hour = now.getHours();
    if (hour < 5 || hour > 23) return;

    const slotIndex = Math.floor((hour * 60 + now.getMinutes()) / 5);
    let activityLog = await readJson(ACTIVITY_LOG_PATH, []);
    if (!Array.isArray(activityLog)) activityLog = [];

    const fifteenMinutesAgo = Date.now() - 15 * 60 * 1000;
    if (activityLog.some(e => e.slotIndex === slotIndex && new Date(e.ts).getTime() > fifteenMinutesAgo)) return;

    const bot = BOTS[slotIndex % BOTS.length];
    const action = (slotIndex % 2 === 0) ? 'CREATE' : 'LIKE';
    let result = 'fail', target = null, reason = '';

    try {
        const creds = await readJson(CREDS_PATH, {});
        if (!creds.firebaseApiKey) throw new Error('Missing firebaseApiKey in kulrs.json');
        if (!creds[bot]?.email || !creds[bot]?.password) {
            throw new Error(`Missing credentials for bot: ${bot}`);
        }
        const token = await signInBot(creds[bot].email, creds[bot].password, creds.firebaseApiKey);

        target = action === 'LIKE'
            ? await performLikeAction(bot, token, activityLog)
            : await performCreateAction(bot, token);
        result = 'ok';
    } catch (error) {
        reason = error.message;
        console.error(`[${bot}] ${action} failed:`, reason);
    }

    const timestamp = new Date().toISOString();
    const updatedActivityLog = [{ ts: timestamp, bot, action, result, target, slotIndex }, ...activityLog].slice(0, 60);
    await writeJson(ACTIVITY_LOG_PATH, updatedActivityLog);

    let authHealthLog = await readJson(AUTH_HEALTH_LOG_PATH, { entries: [] });
    if (typeof authHealthLog !== 'object' || !authHealthLog.entries) authHealthLog = { entries: [] };

    const newHealthEntry = { ts: timestamp, slotIndex, bot, action, result, reason };
    const updatedHealthEntries = [newHealthEntry, ...(Array.isArray(authHealthLog.entries) ? authHealthLog.entries : [])].slice(0, 720);

    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const thirtyMinutesAgo = Date.now() - 30 * 60 * 1000;
    const lastHourEntries = updatedHealthEntries.filter(e => new Date(e.ts).getTime() >= oneHourAgo);

    const total = lastHourEntries.length;
    const ok = lastHourEntries.filter(e => e.result === 'ok').length;
    const authFailuresLast30m = updatedHealthEntries
        .filter(e => new Date(e.ts).getTime() >= thirtyMinutesAgo && (e.reason.includes('401') || e.reason.includes('403'))).length;

    const successRate = total > 0 ? parseFloat((ok / total).toFixed(2)) : 1.0;
    let healthState = 'ok';
    if (successRate < 0.60) healthState = 'alert';
    else if (successRate < 0.80 || authFailuresLast30m > 0) healthState = 'warn';

    await writeJson(AUTH_HEALTH_LOG_PATH, {
        updatedAt: timestamp,
        entries: updatedHealthEntries,
        rollups: {
            last1h: { total, ok, fail: total - ok, successRate, authFailures: authFailuresLast30m, healthState },
        },
    });
}

main().catch(err => {
    console.error('Cron fatal:', err.message);
});
