'use strict';
/**
 * OBS + Puppeteer live restream engine (fixed version)
 *
 * Optional ENV:
 *   STREAM_QUALITY (360p|480p|720p|1080p)  SERVER_SELECTION  PROXY_ENGINE  ENABLE_STREAM_AUDIO (ON|OFF)
 *   OKRU_STREAM_ID  TARGET_URLS  CUSTOM_DURATION (24/7 | 10h | 1h 10min | 45m ...)
 *   X264_PRESET           (default: veryfast <=720p, ultrafast 1080p)
 *   FREEZE_LIMIT_SEC      (default 25)  playback no-movement limit
 *   VISUAL_FREEZE_SEC     (default 20)  identical-picture limit
 *   UNHEALTHY_LIMIT_SEC   (default 30)  no video / paused limit
 *   STARTUP_GRACE_SEC     (default 45)  extra patience right after loading a URL
 *   FORCE_REFRESH_MIN     (default 0 = off)
 *   HANDOVER_AFTER_MIN    (default 350 = 5h50m)
 *   HANDOVER_OVERLAP_SEC  (default 90)
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const zlib = require('zlib');
const { spawn, exec, execSync } = require('child_process');

// obs-websocket-js v5 export compatibility (named / default / module itself)
const obsMod = require('obs-websocket-js');
const OBSWebSocket = obsMod.OBSWebSocket || obsMod.default || obsMod;

// =========================================================================================
// 🛡️ GLOBAL CRASH SHIELD
// =========================================================================================
process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err && err.message));
process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason && reason.message ? reason.message : reason));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const envInt = (name, def) => {
    const v = parseInt(process.env[name], 10);
    return Number.isFinite(v) ? v : def;
};

const obs = new OBSWebSocket();
let obsConnected = false;
obs.on('ConnectionClosed', () => { obsConnected = false; });

// =========================================================================================
// ⚙️ CONFIGURATION & ENV VARIABLES
// =========================================================================================
const selectedQuality = process.env.STREAM_QUALITY || '720p';
const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

const FREEZE_LIMIT_MS = envInt('FREEZE_LIMIT_SEC', 25) * 1000;
const VISUAL_FREEZE_MS = envInt('VISUAL_FREEZE_SEC', 20) * 1000;
const UNHEALTHY_LIMIT_MS = envInt('UNHEALTHY_LIMIT_SEC', 30) * 1000;
const STARTUP_GRACE_MS = envInt('STARTUP_GRACE_SEC', 45) * 1000;
const FORCE_REFRESH_MS = envInt('FORCE_REFRESH_MIN', 0) * 60 * 1000; // 0 = disabled
const HANDOVER_AFTER_MS = envInt('HANDOVER_AFTER_MIN', 350) * 60 * 1000; // 5h50m
const HANDOVER_OVERLAP_MS = envInt('HANDOVER_OVERLAP_SEC', 90) * 1000;
const RUN_START = Date.now();

const NO_REFRESH_DOMAINS = [
    'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
    'sport4u.online', 'vercel.app', 'netlify.app'
];

let RES_W = 1280, RES_H = 720, BITRATE = 3000;
if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

const X264_PRESET = process.env.X264_PRESET || (RES_H >= 1080 ? 'ultrafast' : 'veryfast');

// ⚠️ SECURITY: In keys ko GitHub Secrets / env mein shift karna behtar hai (STREAM_KEY env override neeche support hai)
const STREAM_KEYS = {
    '1'    : '15254238731883_15281627925099_najspfkgne',
    '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
    '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
    '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
    '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
    '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
    '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
    '1.7'  : '16983259553387_18360317971051_6khoe5efge',
    '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
    '1.9'  : '16983269514859_18360335075947_363qzjlbte',
    '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
    '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
    '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
    '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
    '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
    '3'    : '15254341885547_15281821059691_hhlpb5vicy',
    '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
    '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
    '3.3'  : '17485986405995_19233134873195_iw63xjblny',
    '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
    '3.5'  : '17486002789995_19233161611883_mbg22slybe',
    '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
    '4'    : '15255022345835_15283095800427_vwrupxzstm',
    '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
    '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
    '4.3'  : '15255208599147_15283449629291_abltofuc7m',
    '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
    '4.5'  : '15255227670123_15283486263915_jpntt54mve',
    '5'    : '17135767461483_18625099401835_4gpytlxk4a',
    '5.1'  : '15273713933931_15317494860395_avj47smmim',
    '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
    '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
    '5.4'  : '15273750175339_15317561707115_csel26ku5a',
    '5.5'  : '15273760071275_15317579467371_cnewcj54me',
    '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
    '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
    's1.1' : '14204232736303_14846150314543_37jq4ryehq',
    's1.2' : '14204288179759_14846247373359_tnsknmapva',
    's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
    's1.4' : '14204331957807_14846326147631_dji2acqcze',
    's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
    's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
    's1.7' : '14204370492975_14846393649711_6fduhdqite',
    's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
    's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
    's1.10': '14204424691247_14846487562799_xmbvntt6wa',
    's2.1' : '14204490948143_14846603495983_kzevn36tii',
    's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
    's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
    's2.4' : '14204540034607_14846689085999_gjejdie4uy',
    's2.5' : '14204555304495_14846715497007_zdanghuxzu',
    's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
    's2.7' : '14204577259055_14846756194863_3ecad2535u',
    's2.8' : '14204592528943_14846785227311_4hjl46y62e',
    's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
    's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
};

const ACTIVE_STREAM_KEY = (process.env.STREAM_KEY || STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1']).trim();

// =========================================================================================
// 🔗 MULTI-URL PARSER
// =========================================================================================
const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
const urlList = rawUrls
    .split(/[,|\n]/)
    .map((u) => {
        let clean = u.split('::')[0].trim().replace(/^!/, '');
        if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
        return clean;
    })
    .filter((u) => u.length > 8);

if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

let currentUrlIndex = 0;
let browser = null;
let page = null;
let obsProcess = null;
let shuttingDown = false;
let pageCrashed = false;
const abortedReqs = new WeakSet();

// =========================================================================================
// 📊 3-PILLAR HEALTH MONITOR STATE (Network + Manifest + Visual)
// =========================================================================================
function freshNetStats() {
    return {
        lastOkTime: Date.now(),
        errorCount: 0,
        lastHttpStatus: 200,
        playlists: new Map(),      // per-playlist sequence tracking (audio/video/variants alag alag hoti hain)
        lastAdvance: Date.now(),
        targetDurationSec: 6,
        seenManifest: false,
        ended: false,
        pdtLagSec: null
    };
}
function freshVisualStats() {
    return { lastCheckTime: 0, lastGrid: null, sameSince: Date.now() };
}
let netStats = freshNetStats();
let visualStats = freshVisualStats();

function resetMonitorStats() {
    netStats = freshNetStats();
    visualStats = freshVisualStats();
}

console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps (x264 ${X264_PRESET}) | Channel: ${SELECTED_CHANNEL}`);
console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// =========================================================================================
// 🎥 OBS CONFIGURATION
// =========================================================================================
function setupOBSConfig() {
    const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
    const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
    const scenesDir = path.join(obsDir, 'basic', 'scenes');
    const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

    fs.mkdirSync(profilesDir, { recursive: true });
    fs.mkdirSync(scenesDir, { recursive: true });
    fs.mkdirSync(wsPluginDir, { recursive: true });

    // [Basic] section zaroori hai warna OBS apna default profile/scene-collection use karta hai
    fs.writeFileSync(path.join(obsDir, 'global.ini'),
`[General]
LicenseAccepted=true
FirstRun=true
EnableAutoUpdates=false
[Basic]
Profile=Untitled
ProfileDir=Untitled
SceneCollection=Untitled
SceneCollectionFile=Untitled
[BasicWindow]
ShowAutoConfig=false
Warned=true
[OBSWebSocket]
ServerEnabled=true
ServerPort=4455
ServerPassword=secret
`);

    fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
        alerts_enabled: false,
        auth_required: true,
        first_load: false,
        server_enabled: true,
        server_password: 'secret',
        server_port: 4455
    }, null, 2));

    fs.writeFileSync(path.join(profilesDir, 'basic.ini'),
`[General]
Name=Untitled
[Video]
BaseCX=${RES_W}
BaseCY=${RES_H}
OutputCX=${RES_W}
OutputCY=${RES_H}
FPSType=0
FPSCommon=30
[Audio]
SampleRate=44100
ChannelSetup=Stereo
[Output]
Mode=Advanced
Reconnect=true
RetryDelay=2
MaxRetries=999
[AdvOut]
TrackIndex=1
RecType=Standard
Encoder=obs_x264
Rescale=false
ApplyServiceSettings=false
Track1Bitrate=128
`);

    // Advanced mode mein encoder settings streamEncoder.json se aati hain ([obs_x264] section ignore hota hai)
    fs.writeFileSync(path.join(profilesDir, 'streamEncoder.json'), JSON.stringify({
        bitrate: BITRATE,
        rate_control: 'CBR',
        use_bufsize: true,
        buffer_size: BITRATE,
        keyint_sec: 2,
        preset: X264_PRESET,
        profile: 'main',
        tune: 'zerolatency'
    }, null, 2));

    fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify({
        settings: { server: 'rtmp://vsu.okcdn.ru/input/', key: ACTIVE_STREAM_KEY },
        type: 'rtmp_custom'
    }, null, 2));

    const sceneJson = {
        current_scene: 'MainScene',
        current_program_scene: 'MainScene',
        name: 'Untitled',
        scene_order: [{ name: 'WaitingScene' }, { name: 'MainScene' }],
        sources: [
            { id: 'xshm_input', name: 'Screen', settings: { show_cursor: false } },
            { id: 'pulse_output_capture', name: 'Audio', settings: { device_id: 'default' } },
            { id: 'scene', name: 'MainScene', settings: { id_counter: 2, items: [{ name: 'Screen', id: 1, visible: true }, { name: 'Audio', id: 2, visible: true }] } },
            { id: 'scene', name: 'WaitingScene', settings: { id_counter: 1, items: [{ name: 'Screen', id: 1, visible: true }] } }
        ]
    };
    fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
}

// Safety net: agar JSON se scenes/sources load na hon to WebSocket se bana do
async function ensureObsScenes() {
    try {
        const { scenes } = await obs.call('GetSceneList');
        const sceneNames = scenes.map((s) => s.sceneName);
        for (const n of ['WaitingScene', 'MainScene']) {
            if (!sceneNames.includes(n)) await obs.call('CreateScene', { sceneName: n });
        }
        const { inputs } = await obs.call('GetInputList');
        const inputNames = inputs.map((i) => i.inputName);
        if (!inputNames.includes('Screen')) {
            await obs.call('CreateInput', { sceneName: 'MainScene', inputName: 'Screen', inputKind: 'xshm_input', inputSettings: { show_cursor: false }, sceneItemEnabled: true });
        }
        if (!inputNames.includes('Audio')) {
            await obs.call('CreateInput', { sceneName: 'MainScene', inputName: 'Audio', inputKind: 'pulse_output_capture', inputSettings: { device_id: 'default' }, sceneItemEnabled: true });
        }
        const ensureItem = async (scene, source) => {
            const { sceneItems } = await obs.call('GetSceneItemList', { sceneName: scene });
            if (!sceneItems.some((i) => i.sourceName === source)) {
                await obs.call('CreateSceneItem', { sceneName: scene, sourceName: source });
            }
        };
        await ensureItem('MainScene', 'Screen');
        await ensureItem('MainScene', 'Audio');
        await ensureItem('WaitingScene', 'Screen');
        await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' });
    } catch (e) {
        console.log(`[⚠️] ensureObsScenes: ${e.message}`);
    }
}

async function connectOBS(maxTries = 20) {
    try { await obs.disconnect(); } catch (e) {}
    for (let i = 0; i < maxTries; i++) {
        if (shuttingDown) return false;
        try {
            await obs.connect('ws://127.0.0.1:4455', 'secret');
            obsConnected = true;
            console.log('[+] OBS WebSocket Connected!');
            return true;
        } catch (e) {
            await sleep(2000);
        }
    }
    return false;
}

async function startOBS() {
    console.log('[*] Configuring & Starting OBS Studio...');
    setupOBSConfig();
    try { execSync('pkill -9 -x obs 2>/dev/null || true', { stdio: 'ignore' }); } catch (e) {}

    // --disable-shutdown-check: pkill -9 ke baad "Safe Mode?" dialog aata hai jo OBS ko block kar deta hai
    obsProcess = spawn('obs', [
        '--startstreaming', '--minimize-to-tray', '--disable-updater',
        '--disable-shutdown-check', '--disable-missing-files-check'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    obsProcess.on('error', (e) => { console.error('[OBS] spawn error:', e.message); obsProcess = null; });
    obsProcess.on('exit', (code, sig) => {
        console.log(`[OBS] process exited (code=${code}, signal=${sig})`);
        obsProcess = null;
        obsConnected = false;
    });
    obsProcess.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (/rtmp|stream|websocket|output/i.test(line)) console.log(`[OBS]: ${line}`);
    });
    obsProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (/error|fail/i.test(msg)) console.log(`[OBS Error]: ${msg}`);
    });

    await sleep(4000);
    const ok = await connectOBS(20);
    if (!ok) throw new Error('OBS WebSocket connect failed');

    await ensureObsScenes();
    try {
        const st = await obs.call('GetStreamStatus');
        if (!st.outputActive) await obs.call('StartStream');
    } catch (e) {
        console.log(`[⚠️] StartStream: ${e.message}`);
    }
}

// OBS ko periodically check karo: process zinda? websocket connected? stream active?
async function monitorObs(state) {
    const now = Date.now();
    if (now - state.lastObsCheck < 10000) return;
    state.lastObsCheck = now;
    try {
        if (!obsProcess) {
            console.log('[⚠️] OBS process dead -> restarting OBS');
            await startOBS();
            return;
        }
        if (!obsConnected) {
            console.log('[⚠️] OBS WebSocket disconnected -> reconnecting');
            if (!(await connectOBS(3))) return;
        }
        const st = await obs.call('GetStreamStatus');
        if (!st.outputActive && !st.outputReconnecting) {
            console.log('[⚠️] OBS stream not active -> StartStream');
            await obs.call('StartStream');
        }
    } catch (e) {
        console.log(`[⚠️] OBS monitor: ${e.message}`);
        obsConnected = false;
    }
}

// =========================================================================================
// 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb) - non-blocking
// =========================================================================================
let lastWindowFix = 0;
function keepChromeOnTopAndHideOBS(force = false) {
    const now = Date.now();
    if (!force && now - lastWindowFix < 5000) return;
    lastWindowFix = now;
    const cmd =
        'xdotool search --class "obs" windowmove 5000 5000 windowminimize 2>/dev/null; ' +
        `xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate 2>/dev/null; ` +
        'wmctrl -x -a chrome 2>/dev/null; true';
    exec(cmd, { timeout: 4000 }, () => {});
}

// =========================================================================================
// 🎬 IN-PAGE FRAME LOCK (har frame mein chalta hai: fullscreen + auto-resume + live-edge)
// Ye function evaluateOnNewDocument se inject hota hai, isliye iframe reload hone par bhi wapas aa jata hai.
// =========================================================================================
function frameLockFn(audioEnabled) {
    if (window.__frameLockActive) return;
    window.__frameLockActive = true;

    let pausedTicks = 0;
    let lastLiveSeek = 0;
    const PLAY_BTN = '.jw-icon-display, .jw-icon-playback, button[data-plyr="play"], .vjs-big-play-button, .vjs-play-control, .fp-play';
    const LIVE_BTN = '.jw-icon-live, .vjs-live-control, [class*="live-button"], [aria-label*="Live"]';

    const pickVideo = () => {
        let best = null, bestScore = -1;
        document.querySelectorAll('video').forEach((v) => {
            const score = (v.clientWidth || 0) * (v.clientHeight || 0) + (!v.paused ? 1e7 : 0);
            if (score > bestScore) { bestScore = score; best = v; }
        });
        return best;
    };

    setInterval(() => {
        try {
            if (document.documentElement) document.documentElement.style.setProperty('background', '#000', 'important');
            if (document.body) {
                document.body.style.setProperty('background', '#000', 'important');
                document.body.style.setProperty('overflow', 'hidden', 'important');
                document.body.style.setProperty('margin', '0', 'important');
            }

            const v = pickVideo();
            if (v) {
                if (v.paused) {
                    pausedTicks++;
                    v.play().catch(() => {});
                    // Button sirf tab click karo jab play() kaam na kare (warna play+click = dobara pause)
                    if (pausedTicks >= 3) {
                        document.querySelectorAll(PLAY_BTN).forEach((b) => { try { b.click(); } catch (e) {} });
                        pausedTicks = 0;
                    }
                } else {
                    pausedTicks = 0;
                }

                // Live edge: DVR mode mein pichhe reh jaye to wapas live par
                document.querySelectorAll(LIVE_BTN).forEach((btn) => {
                    const cls = (btn.className || '').toString().toLowerCase();
                    if (cls.includes('not-live') || cls.includes('behind') || cls.includes('dvr')) {
                        try { btn.click(); } catch (e) {}
                    }
                });
                try {
                    if (!v.paused && v.duration === Infinity && v.seekable && v.seekable.length) {
                        const liveEnd = v.seekable.end(v.seekable.length - 1);
                        if (liveEnd - v.currentTime > 25 && Date.now() - lastLiveSeek > 30000) {
                            lastLiveSeek = Date.now();
                            v.currentTime = liveEnd - 2;
                        }
                    }
                } catch (e) {}

                if (v.clientWidth > 50 || !v.paused) {
                    v.muted = !audioEnabled;
                    v.volume = audioEnabled ? 1.0 : 0.0;
                    const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
                    wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
                    v.style.cssText = 'width:100% !important;height:100% !important;object-fit:contain !important;';
                    document.querySelectorAll('.jw-controls, .plyr__controls, .vjs-control-bar').forEach((c) => c.style.setProperty('display', 'none', 'important'));
                    return;
                }
            }

            // Is frame mein video nahi: sabse bada child iframe maximize karo
            const iframes = Array.from(document.querySelectorAll('iframe'));
            let best = null, maxArea = 5000;
            iframes.forEach((f) => {
                const area = f.clientWidth * f.clientHeight;
                if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
            });
            if (best) {
                iframes.forEach((f) => { if (f !== best) f.style.setProperty('display', 'none', 'important'); });
                best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483645 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
            }
        } catch (e) {}
    }, 1000);
}

// =========================================================================================
// 🛡️ POPUP & AD FIREWALL + CHECK #1: NETWORK & HLS MANIFEST FRESHNESS
// =========================================================================================
const BAD_WORDS = ['popads', 'exoclick', 'adsterra', 'onclickads', 'doubleclick', 'adexchangerapid', 'bet365', '1xbet'];
const MANIFEST_RE = /\.(m3u8|mpd)(?:$|[?#])/;
const SEGMENT_RE = /\.(ts|m4s|aac|m4a|m4v|mp4)(?:$|[?#])/;

async function setupPageProtections(p) {
    try {
        await p.setRequestInterception(true);
        p.on('request', (req) => {
            try {
                if (typeof req.isInterceptResolutionHandled === 'function' && req.isInterceptResolutionHandled()) return;
                const url = req.url().toLowerCase();
                if (BAD_WORDS.some((w) => url.includes(w))) {
                    abortedReqs.add(req);
                    return req.abort('blockedbyclient').catch(() => {});
                }
                req.continue().catch(() => {});
            } catch (e) {}
        });

        p.on('response', async (res) => {
            try {
                const url = res.url();
                const lower = url.toLowerCase();
                const isManifest = MANIFEST_RE.test(lower);
                const isSegment = SEGMENT_RE.test(lower);
                if (!isManifest && !isSegment) return;

                const status = res.status();
                netStats.lastHttpStatus = status;
                if (status >= 200 && status < 400) {
                    netStats.lastOkTime = Date.now();
                    netStats.errorCount = 0;
                } else if (status >= 400) {
                    netStats.errorCount++;
                }

                if (/\.m3u8(?:$|[?#])/.test(lower) && status >= 200 && status < 300) {
                    const text = await res.text().catch(() => '');
                    if (!text || !text.includes('#EXTM3U')) return;
                    if (text.includes('#EXT-X-STREAM-INF')) return; // master playlist: sequence nahi hoti

                    if (/#EXT-X-ENDLIST/i.test(text)) netStats.ended = true;

                    const tdMatch = text.match(/#EXT-X-TARGETDURATION:(\d+)/i);
                    if (tdMatch) netStats.targetDurationSec = parseInt(tdMatch[1], 10) || 6;

                    const seqMatch = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
                    if (seqMatch) {
                        netStats.seenManifest = true;
                        const seq = parseInt(seqMatch[1], 10);
                        const key = lower.split('?')[0];
                        const entry = netStats.playlists.get(key);
                        if (!entry || entry.seq !== seq) {
                            netStats.playlists.set(key, { seq, advanceTime: Date.now() });
                            netStats.lastAdvance = Date.now();
                        }
                    }

                    const pdtMatches = text.match(/#EXT-X-PROGRAM-DATE-TIME:([^\r\n]+)/gi);
                    if (pdtMatches && pdtMatches.length > 0) {
                        const iso = pdtMatches[pdtMatches.length - 1].replace(/#EXT-X-PROGRAM-DATE-TIME:/i, '').trim();
                        const t = Date.parse(iso);
                        if (!isNaN(t)) netStats.pdtLagSec = Math.round((Date.now() - t) / 1000);
                    }
                }
            } catch (e) {}
        });

        p.on('requestfailed', (req) => {
            try {
                if (abortedReqs.has(req)) return; // humne khud block kiya
                const u = req.url().toLowerCase();
                if (!MANIFEST_RE.test(u) && !SEGMENT_RE.test(u)) return;
                const err = (req.failure() && req.failure().errorText) || '';
                if (err.includes('ERR_ABORTED')) return; // player ne khud cancel kiya (ABR switch / navigation)
                netStats.errorCount++;
            } catch (e) {}
        });

        p.on('error', (e) => { console.log(`[💥] Page crashed: ${e && e.message}`); pageCrashed = true; });
        p.on('close', () => { pageCrashed = true; });

        await p.evaluateOnNewDocument(() => {
            window.open = () => null;
            window.alert = () => {};
            window.confirm = () => true;
            window.prompt = () => null;
        });
        await p.evaluateOnNewDocument(frameLockFn, ENABLE_STREAM_AUDIO);
    } catch (e) {
        console.log(`[⚠️] setupPageProtections: ${e.message}`);
    }
}

async function showLoadingOverlay(p, title, subtitle) {
    try {
        await p.evaluate((t, s) => {
            if (window.self !== window.top) return;
            let el = document.getElementById('bot-loading-ui');
            if (!el) {
                el = document.createElement('div');
                el.id = 'bot-loading-ui';
                el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
                (document.body || document.documentElement).appendChild(el);
            }
            el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
        }, title, subtitle);
    } catch (e) {}
}

async function hideLoadingOverlay(p) {
    try {
        await p.evaluate(() => {
            const el = document.getElementById('bot-loading-ui');
            if (el) el.remove();
        });
    } catch (e) {}
}

// =========================================================================================
// 🎬 PLAYER AUTO-PLAY / SERVER SELECT
// =========================================================================================
async function selectServer(p) {
    if (SERVER_SELECTION === 'None') return;
    for (const frame of p.frames()) {
        if (frame.isDetached()) continue;
        const clicked = await frame.evaluate((srv) => {
            // Sabse chhota matching element chuno (pehle wala "div" poora page container hota tha)
            const cands = Array.from(document.querySelectorAll('button, a, li, span, div'))
                .filter((e) => e.innerText && e.innerText.includes(srv) && e.innerText.length < srv.length + 40);
            cands.sort((a, b) => a.innerText.length - b.innerText.length);
            if (cands[0]) { cands[0].click(); return true; }
            return false;
        }, SERVER_SELECTION).catch(() => false);
        if (clicked) { await sleep(2000); return; }
    }
}

async function lockAndPlayVideo(p) {
    if (!p || p.isClosed()) return;
    try {
        await selectServer(p);

        for (let attempt = 0; attempt < 8; attempt++) {
            let playing = false;
            for (const frame of p.frames()) {
                if (frame.isDetached()) continue;
                try {
                    const status = await frame.evaluate((audioEnabled) => {
                        const vids = Array.from(document.querySelectorAll('video'));
                        let isPlaying = false;
                        vids.forEach((v) => {
                            v.muted = !audioEnabled;
                            v.volume = audioEnabled ? 1.0 : 0.0;
                            if (v.paused) v.play().catch(() => {});
                            if (!v.paused && v.readyState >= 2) isPlaying = true;
                        });
                        // Buttons tab click karo jab video na ho ya play() ke baad bhi paused ho
                        // (video element ko kabhi click nahi karte: click = pause toggle)
                        if (vids.length === 0 || vids.every((v) => v.paused)) {
                            const sel = '.jw-icon-display, .jw-icon-playback, button[data-plyr="play"], .vjs-big-play-button, .vjs-play-control, .fp-play, [class*="unmute"]';
                            document.querySelectorAll(sel).forEach((el) => { try { el.click(); } catch (e) {} });
                        }
                        return isPlaying;
                    }, ENABLE_STREAM_AUDIO);
                    if (status) { playing = true; break; }
                } catch (e) {}
            }
            if (playing) break;
            await sleep(1500);
        }

        // Fallback: agar evaluateOnNewDocument kisi frame mein na chala ho
        for (const frame of p.frames()) {
            if (frame.isDetached()) continue;
            await frame.evaluate(frameLockFn, ENABLE_STREAM_AUDIO).catch(() => {});
        }
    } catch (e) {}
}

// =========================================================================================
// 🖼️ CHECK #3: VISUAL FREEZE (tiny PNG decode + grid compare, koi extra dependency nahi)
// =========================================================================================
function decodePng(buf) {
    if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
    let pos = 8, width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString('ascii', pos + 4, pos + 8);
        const data = buf.subarray(pos + 8, pos + 8 + len);
        if (type === 'IHDR') {
            width = data.readUInt32BE(0); height = data.readUInt32BE(4);
            bitDepth = data[8]; colorType = data[9]; interlace = data[12];
        } else if (type === 'IDAT') idat.push(data);
        else if (type === 'IEND') break;
        pos += 12 + len;
    }
    if (bitDepth !== 8 || interlace !== 0 || (colorType !== 2 && colorType !== 6)) throw new Error('unsupported PNG format');
    const bpp = colorType === 6 ? 4 : 3;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = width * bpp;
    const out = Buffer.alloc(stride * height);
    for (let y = 0; y < height; y++) {
        const ft = raw[y * (stride + 1)];
        const rs = y * (stride + 1) + 1;
        for (let x = 0; x < stride; x++) {
            const r = raw[rs + x];
            const a = x >= bpp ? out[y * stride + x - bpp] : 0;
            const b = y > 0 ? out[(y - 1) * stride + x] : 0;
            const c = (x >= bpp && y > 0) ? out[(y - 1) * stride + x - bpp] : 0;
            let v;
            switch (ft) {
                case 0: v = r; break;
                case 1: v = r + a; break;
                case 2: v = r + b; break;
                case 3: v = r + ((a + b) >> 1); break;
                case 4: {
                    const pp = a + b - c, pa = Math.abs(pp - a), pb = Math.abs(pp - b), pc = Math.abs(pp - c);
                    v = r + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c));
                    break;
                }
                default: throw new Error('bad PNG filter');
            }
            out[y * stride + x] = v & 255;
        }
    }
    return { width, height, bpp, data: out };
}

function grayGrid(pngBuf) {
    const img = decodePng(Buffer.from(pngBuf));
    const GW = 9, GH = 8, grid = new Array(GW * GH);
    for (let gy = 0; gy < GH; gy++) {
        for (let gx = 0; gx < GW; gx++) {
            const px = Math.min(img.width - 1, Math.floor((gx + 0.5) * img.width / GW));
            const py = Math.min(img.height - 1, Math.floor((gy + 0.5) * img.height / GH));
            const i = (py * img.width + px) * img.bpp;
            grid[gy * GW + gx] = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
        }
    }
    return grid;
}

async function checkVisualFreshness(p) {
    const now = Date.now();
    if (now - visualStats.lastCheckTime < 6000) return { visualStatus: 'OK' };
    visualStats.lastCheckTime = now;

    try {
        const dims = await p.evaluate(() => ({ w: window.innerWidth, h: window.innerHeight }));
        // Chrome khud 5% scale par screenshot deta hai -> bohat halka (~50x30 px)
        const buf = await p.screenshot({
            type: 'png',
            captureBeyondViewport: false,
            clip: {
                x: Math.floor(dims.w * 0.1), y: Math.floor(dims.h * 0.1),
                width: Math.floor(dims.w * 0.8), height: Math.floor(dims.h * 0.8),
                scale: 0.05
            }
        });
        const grid = grayGrid(buf);

        if (visualStats.lastGrid) {
            let sum = 0;
            for (let i = 0; i < grid.length; i++) sum += Math.abs(grid[i] - visualStats.lastGrid[i]);
            const mad = sum / grid.length;
            if (mad < 0.5) {
                const frozenMs = now - visualStats.sameSince;
                if (frozenMs > VISUAL_FREEZE_MS) return { visualStatus: 'VISUAL_FROZEN', frozenSec: Math.round(frozenMs / 1000) };
                return { visualStatus: 'OK' };
            }
        }
        visualStats.lastGrid = grid;
        visualStats.sameSince = now;
        return { visualStatus: 'OK' };
    } catch (e) {
        return { visualStatus: 'OK' };
    }
}

// =========================================================================================
// 💓 CHECK #2: PLAYBACK HEALTH
// =========================================================================================
async function checkStreamHealth(p) {
    if (!p || p.isClosed()) return { status: 'DEAD' };
    try {
        const checks = p.frames().map(async (frame) => {
            if (frame.isDetached()) return null;
            try {
                return await Promise.race([
                    frame.evaluate(() => {
                        let best = null, bestScore = -1;
                        document.querySelectorAll('video').forEach((v) => {
                            const score = (v.clientWidth || 0) * (v.clientHeight || 0) + (!v.paused ? 1e7 : 0);
                            if (score > bestScore) { bestScore = score; best = v; }
                        });
                        const v = best;
                        if (!v) return null;
                        const frames = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : (v.webkitDecodedFrameCount || 0);
                        const base = { paused: v.paused, readyState: v.readyState, currentTime: v.currentTime, frames };
                        if (v.paused) return Object.assign({ status: 'PAUSED' }, base);
                        if (v.readyState >= 2 || frames > 0) return Object.assign({ status: 'HEALTHY' }, base);
                        return null;
                    }),
                    new Promise((r) => setTimeout(() => r(null), 1500))
                ]);
            } catch (e) { return null; }
        });

        const results = await Promise.all(checks);
        const healthy = results.find((r) => r && r.status === 'HEALTHY');
        if (healthy) return healthy;
        const paused = results.find((r) => r && r.status === 'PAUSED');
        if (paused) return paused;
        return { status: 'LOADING_OR_DEAD' };
    } catch (e) {
        return { status: 'DEAD' };
    }
}

function evaluateNetwork() {
    const now = Date.now();
    if (netStats.errorCount >= 6 && now - netStats.lastOkTime > 12000) return `NET_ERROR_${netStats.lastHttpStatus}`;
    if (netStats.seenManifest && !netStats.ended) {
        const limit = Math.max(25000, netStats.targetDurationSec * 3000);
        if (now - netStats.lastAdvance > limit) return 'STALE_MANIFEST';
    }
    return 'OK';
}

// =========================================================================================
// 🔄 URL LOADING & WATCHDOG
// =========================================================================================
async function loadCurrentUrl(reason) {
    const targetUrl = urlList[currentUrlIndex];
    console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

    try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
    try {
        await page.goto('about:blank');
        await page.bringToFront();
        keepChromeOnTopAndHideOBS(true);
        await showLoadingOverlay(page, 'CONNECTING STREAM', `Server ${currentUrlIndex + 1} of ${urlList.length}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        resetMonitorStats(); // navigation se aane wale purane abort/errors ko ignore karo
        await showLoadingOverlay(page, 'OPTIMIZING PLAYER', 'Locking fullscreen video...');
        await lockAndPlayVideo(page);
        await hideLoadingOverlay(page);
        keepChromeOnTopAndHideOBS(true);
    } catch (e) {
        resetMonitorStats();
        console.log(`[⚠️] Page navigation warning: ${e.message}`);
    }
    try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
}

async function startWatchdog() {
    const st = {
        lastTime: -1, lastFrames: -1, lastWall: Date.now(),
        freezeStart: Date.now(), urlStart: Date.now(), loadedAt: Date.now(),
        unhealthySince: null, lastResumeAt: 0, lastObsCheck: 0
    };
    let ticks = 0;

    const resetWatch = () => {
        st.lastTime = -1; st.lastFrames = -1; st.lastWall = Date.now();
        st.freezeStart = Date.now(); st.urlStart = Date.now(); st.loadedAt = Date.now();
        st.unhealthySince = null;
    };
    const failover = async (reason) => {
        currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
        await loadCurrentUrl(reason);
        resetWatch();
    };

    resetWatch();

    while (!shuttingDown) {
        if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');
        if (!page || page.isClosed() || pageCrashed) throw new Error('Page closed or crashed');

        keepChromeOnTopAndHideOBS();
        await monitorObs(st);

        const now = Date.now();
        const currentUrl = urlList[currentUrlIndex];
        const inGrace = now - st.loadedAt < STARTUP_GRACE_MS;
        const health = await checkStreamHealth(page);

        if (health.status === 'HEALTHY') {
            st.unhealthySince = null;

            const wallElapsed = (now - st.lastWall) / 1000;
            const timeDelta = st.lastTime !== -1 ? Math.abs(health.currentTime - st.lastTime) : wallElapsed;
            const speedRatio = wallElapsed > 0 ? (timeDelta / wallElapsed).toFixed(2) : '1.00';
            st.lastWall = now;

            const framesMoved = st.lastFrames === -1 || health.frames !== st.lastFrames;
            const timeMoved = st.lastTime === -1 || health.currentTime !== st.lastTime;
            const isMoving = framesMoved || timeMoved;

            if (!isMoving) {
                if (now - st.freezeStart > FREEZE_LIMIT_MS) {
                    await failover(`PLAYBACK FROZEN (No Frame/Time Movement for ${Math.round(FREEZE_LIMIT_MS / 1000)}s)`);
                    continue;
                }
            } else {
                st.freezeStart = now;
                st.lastTime = health.currentTime;
                st.lastFrames = health.frames;
            }

            const visual = await checkVisualFreshness(page);
            if (visual.visualStatus === 'VISUAL_FROZEN') {
                await failover(`VISUAL SCREEN FROZEN (${visual.frozenSec}s identical picture)`);
                continue;
            }

            const networkState = evaluateNetwork();
            if (networkState !== 'OK') {
                await failover(`NETWORK/MANIFEST FAIL (${networkState})`);
                continue;
            }

            await hideLoadingOverlay(page);

            const isExempt = NO_REFRESH_DOMAINS.some((d) => currentUrl.includes(d));
            if (FORCE_REFRESH_MS > 0 && !isExempt && now - st.urlStart > FORCE_REFRESH_MS) {
                await loadCurrentUrl('SCHEDULED REFRESH');
                resetWatch();
                continue;
            }

            ticks++;
            if (ticks === 1 || ticks % 10 === 0) {
                console.log(
                    `[💓] REPORT | Net: ${networkState} (HTTP:${netStats.lastHttpStatus}, ManifestAge:${netStats.seenManifest ? Math.round((now - netStats.lastAdvance) / 1000) + 's' : 'N/A'}, PDT-lag:${netStats.pdtLagSec ?? 'N/A'}s) | ` +
                    `Playback: ${health.status} (Speed:${speedRatio}x, Time:${health.currentTime.toFixed(1)}s, Frames:${health.frames}) | ` +
                    `Visual: ${visual.visualStatus} | URL [${currentUrlIndex + 1}/${urlList.length}]`
                );
            }
        } else if (health.status === 'PAUSED') {
            if (st.unhealthySince === null) st.unhealthySince = now;
            if (now - st.lastResumeAt > 8000) {
                st.lastResumeAt = now;
                console.log('[⏯️] Video PAUSED -> Auto-Play & Live-Edge resume');
                await lockAndPlayVideo(page);
            }
            if (now - st.unhealthySince > UNHEALTHY_LIMIT_MS) {
                await failover(`PAUSED TOO LONG (${Math.round(UNHEALTHY_LIMIT_MS / 1000)}s)`);
                continue;
            }
        } else {
            if (st.unhealthySince === null) st.unhealthySince = now;
            const limit = inGrace ? Math.max(STARTUP_GRACE_MS, UNHEALTHY_LIMIT_MS) : UNHEALTHY_LIMIT_MS;
            const bad = now - st.unhealthySince;
            console.log(`[⚠️] Stream Unhealthy (${health.status} | Net: ${evaluateNetwork()}) - ${Math.round(bad / 1000)}s/${Math.round(limit / 1000)}s`);
            if (now - st.lastResumeAt > 15000) {
                st.lastResumeAt = now;
                await lockAndPlayVideo(page);
            }
            if (bad > limit) {
                await failover('NO HEALTHY VIDEO -> FAILOVER NEXT URL');
                continue;
            }
        }

        await sleep(2000);
    }
}

// =========================================================================================
// 🚀 BROWSER LAUNCH, ENGINE LOOP & CLEANUP
// =========================================================================================
function checkWarpPort() {
    return new Promise((resolve) => {
        const s = net.connect({ host: '127.0.0.1', port: 40000 });
        const done = (ok) => { try { s.destroy(); } catch (e) {} resolve(ok); };
        s.setTimeout(2000, () => done(false));
        s.on('connect', () => done(true));
        s.on('error', () => done(false));
    });
}

async function launchBrowser() {
    const args = [
        '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
        '--window-position=0,0', '--kiosk', '--start-fullscreen',
        '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled', '--use-gl=egl',
        '--no-first-run', '--no-default-browser-check', '--disable-infobars',
        '--hide-crash-restore-bubble', '--disable-session-crashed-bubble',
        // Background/occluded tab throttling band (OBS window upar aaye to bhi timers na ruken)
        '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
        '--disable-backgrounding-occluded-windows'
    ];

    if (PROXY_ENGINE.includes('Cloudflare')) {
        if (!(await checkWarpPort())) console.log('[⚠️] WARP SOCKS5 127.0.0.1:40000 reachable nahi! Pages load nahi honge.');
        args.push('--proxy-server=socks5://127.0.0.1:40000');
    }

    const ublockPath = path.join(process.cwd(), 'ublock-lite');
    if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
        args.push(`--disable-extensions-except=${ublockPath}`);
        args.push(`--load-extension=${ublockPath}`);
        console.log('[🛡️] uBlock Origin Lite MV3 Extension Loading...');
    }

    pageCrashed = false;
    browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null, // kiosk mein real window size use ho (fixed emulation se black bars aate hain)
        // Puppeteer default mein --disable-extensions lagata hai: uske bina uBlock load hi nahi hota
        ignoreDefaultArgs: ['--enable-automation', '--disable-extensions'],
        args
    });

    const pages = await browser.pages();
    page = pages.find((p) => p.url() === 'about:blank') || pages[0] || await browser.newPage();
    for (const p of pages) { if (p !== page) await p.close().catch(() => {}); }

    browser.on('targetcreated', async (target) => {
        if (target.type() !== 'page') return;
        const newPage = await target.page().catch(() => null);
        if (newPage && newPage !== page) {
            setTimeout(() => {
                newPage.close().catch(() => {});
                if (page && !page.isClosed()) page.bringToFront().catch(() => {});
            }, 300);
        }
    });

    keepChromeOnTopAndHideOBS(true);
    await setupPageProtections(page);
    await loadCurrentUrl('INITIAL BOOT');
}

async function cleanupBrowser() {
    if (browser) {
        try { await Promise.race([browser.close(), sleep(5000)]); } catch (e) {}
        browser = null;
    }
    page = null;
    for (const name of ['chrome', 'chromium', 'google-chrome']) {
        try { execSync(`pkill -9 -x ${name} 2>/dev/null || true`, { stdio: 'ignore' }); } catch (e) {}
    }
}

async function cleanupAll() {
    try { await obs.disconnect(); } catch (e) {}
    obsConnected = false;
    await cleanupBrowser();
    if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
    try { execSync('pkill -9 -x obs 2>/dev/null || true', { stdio: 'ignore' }); } catch (e) {}
}

async function gracefulExit(code = 0) {
    if (shuttingDown && code === -1) return;
    shuttingDown = true;
    try { if (obsConnected) await obs.call('StopStream'); } catch (e) {}
    await cleanupAll();
    process.exit(code === -1 ? 0 : code);
}

process.on('SIGINT', () => { console.log('[🛑] SIGINT received'); gracefulExit(0); });
process.on('SIGTERM', () => { console.log('[🛑] SIGTERM received'); gracefulExit(0); });

// =========================================================================================
// ⏱️ DURATION PARSER & RELAY ENGINE (24/7, 10h, 1h 10min, 0h 10min, 45m, 90 ...)
// =========================================================================================
const RAW_DURATION = (process.env.CUSTOM_DURATION || '24/7').trim();

function parseFlexibleDuration(input) {
    if (!input) return null;
    const str = input.toLowerCase().trim();
    if (str === '24/7' || str === 'infinite' || str === 'forever') return null;

    let totalMs = 0, matched = false;
    const regex = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/g;
    let match;
    while ((match = regex.exec(str)) !== null) {
        matched = true;
        const val = parseFloat(match[1]);
        const unit = match[2];
        if (unit.startsWith('h')) totalMs += val * 3600 * 1000;
        else if (unit.startsWith('m')) totalMs += val * 60 * 1000;
        else if (unit.startsWith('s')) totalMs += val * 1000;
    }
    // Sirf number likha ho (e.g. "120") -> minutes
    if (!matched && /^\d+(\.\d+)?$/.test(str)) {
        totalMs = parseFloat(str) * 60 * 1000;
        matched = true;
    }

    if (!matched || totalMs <= 0) {
        console.log(`[⚠️] CUSTOM_DURATION "${input}" samajh nahi aaya / zero hai -> 24/7 mode use ho raha hai`);
        return null;
    }
    return Math.round(totalMs);
}

function formatMsToDurationString(ms) {
    const totalSeconds = Math.max(1, Math.round(ms / 1000));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    const parts = [];
    if (hours > 0) parts.push(`${hours}h`);
    if (minutes > 0) parts.push(`${minutes}m`);
    if (hours === 0 && minutes === 0 && seconds > 0) parts.push(`${seconds}s`);
    return parts.join(' ') || '1m';
}

// getNextDuration: function jo trigger ke waqt remaining duration string deta hai (retry par dobara calculate hota hai)
function triggerNextWorkflow(getNextDuration, attempt = 1) {
    const nextDurationValue = getNextDuration();
    console.log(`\n[🔄] Handover (try ${attempt}) -> Launching Next Action with custom_duration="${nextDurationValue}"...`);

    const args = ['workflow', 'run', 'main.yml'];
    if (process.env.GITHUB_REF_NAME) args.push('--ref', process.env.GITHUB_REF_NAME);
    args.push(
        '-f', `target_urls=${process.env.TARGET_URLS || ''}`,
        '-f', `okru_stream_channel=${SELECTED_CHANNEL}`,
        '-f', `server_selection=${SERVER_SELECTION}`,
        '-f', `stream_quality=${selectedQuality}`,
        '-f', `proxy_engine=${PROXY_ENGINE}`,
        '-f', `enable_stream_audio=${process.env.ENABLE_STREAM_AUDIO || 'ON'}`,
        '-f', `custom_duration=${nextDurationValue}`
    );

    let finished = false;
    const finish = (code) => {
        if (finished) return;
        finished = true;
        if (code === 0) {
            console.log(`[+] Next workflow triggered. Overlap ${Math.round(HANDOVER_OVERLAP_MS / 1000)}s ke liye stream chalti rahegi...`);
            setTimeout(() => gracefulExit(0), HANDOVER_OVERLAP_MS);
        } else if (attempt < 5) {
            console.error(`[⚠️] gh workflow run fail (code ${code}). 20s baad retry...`);
            setTimeout(() => triggerNextWorkflow(getNextDuration, attempt + 1), 20000);
        } else {
            console.error('[🚨] Handover 5 baar fail hua (GH_TOKEN / actions:write permission check karo). Stream chalti rahegi jab tak runner band na ho.');
        }
    };

    try {
        const child = spawn('gh', args, { stdio: 'inherit' });
        child.on('error', (e) => { console.error('[⚠️] gh spawn error:', e.message); finish(-1); });
        child.on('close', finish);
    } catch (e) {
        console.error('[⚠️] Failed to trigger next workflow:', e.message);
        finish(-1);
    }
}

const totalRequestedMs = parseFlexibleDuration(RAW_DURATION);

if (totalRequestedMs === null) {
    console.log(`[♾️] Duration Mode: 24/7 Infinite | Handover after ${formatMsToDurationString(HANDOVER_AFTER_MS)}.`);
    setTimeout(() => triggerNextWorkflow(() => '24/7'), HANDOVER_AFTER_MS);
} else if (totalRequestedMs <= HANDOVER_AFTER_MS) {
    console.log(`[⏱️] Duration Mode: Fixed (${RAW_DURATION} -> ${formatMsToDurationString(totalRequestedMs)}) | Stream will STOP when timer ends.`);
    setTimeout(async () => {
        console.log(`\n[🛑] Target Duration (${RAW_DURATION}) Reached! Stopping OBS & Ending Action...`);
        await gracefulExit(0);
    }, totalRequestedMs);
} else {
    console.log(`[⏱️] Duration Mode: Long Relay (${RAW_DURATION}) | Running ${formatMsToDurationString(HANDOVER_AFTER_MS)} now, rest goes to next Action.`);
    setTimeout(() => {
        triggerNextWorkflow(() => {
            // Actual elapsed time ke hisaab se remaining nikalo
            const remaining = totalRequestedMs - (Date.now() - RUN_START);
            return formatMsToDurationString(remaining);
        });
    }, HANDOVER_AFTER_MS);
}

// =========================================================================================
// 🔁 MAIN LOOP
// Browser fail ho to sirf browser restart hota hai (OBS stream chalta rehta hai).
// 5 consecutive failures ke baad OBS bhi full restart.
// =========================================================================================
(async () => {
    let consecutiveFailures = 0;
    while (!shuttingDown) {
        try {
            if (!obsProcess) await startOBS();
            await launchBrowser();
            consecutiveFailures = 0;
            await startWatchdog();
        } catch (err) {
            if (shuttingDown) break;
            consecutiveFailures++;
            console.error(`[🚨] Engine Error (#${consecutiveFailures}), restarting in 3s:`, err.message);
            if (consecutiveFailures >= 5) {
                console.error('[🚨] Too many failures -> full restart (OBS + Chrome)');
                await cleanupAll();
                consecutiveFailures = 0;
            } else {
                await cleanupBrowser();
            }
            await sleep(3000);
        }
    }
})();


































// ===================================================================================================
// ===================================================================================================

//     Alhamdullah Alhamdullah Alhamduallah 1st prioty most most most 1st prioty 2000% 1st prioty 
    
// ===================================================================================================
// ===================================================================================================





// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const crypto = require('crypto');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// // =========================================================================================
// // 📊 3-PILLAR HEALTH MONITOR STATE (Network + Manifest + Visual Hash)
// // =========================================================================================
// let netStats = {
//     lastSegmentOkTime: Date.now(),
//     segmentErrorCount: 0,
//     lastHttpStatus: 200,
//     lastMediaSeq: null,
//     lastSeqAdvanceTime: Date.now(),
//     staleManifestCount: 0,
//     programDateTimeLagSec: 0,
//     seenManifest: false
// };

// let visualStats = {
//     lastCheckTime: 0,
//     lastHash: null,
//     sameHashSince: Date.now(),
//     recentHashes: [] // Rolling window for repeat/loop detection
// };

// function resetMonitorStats() {
//     netStats = {
//         lastSegmentOkTime: Date.now(),
//         segmentErrorCount: 0,
//         lastHttpStatus: 200,
//         lastMediaSeq: null,
//         lastSeqAdvanceTime: Date.now(),
//         staleManifestCount: 0,
//         programDateTimeLagSec: 0,
//         seenManifest: false
//     };
//     visualStats = {
//         lastCheckTime: 0,
//         lastHash: null,
//         sameHashSince: Date.now(),
//         recentHashes: []
//     };
// }

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (With OBS 30+ WebSocket Plugin Fix)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     fs.writeFileSync(path.join(obsDir, 'global.ini'), `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Advanced\n[AdvOut]\nTrackIndex=1\nRecType=Standard\nEncoder=obs_x264\n[obs_x264]\nbitrate=${BITRATE}\nkeyint_sec=2\npreset=ultrafast\nprofile=main\ntune=zerolatency\n`);

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb Fix)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + CHECK #1: NETWORK & HLS MANIFEST FRESHNESS MONITOR
// // =========================================================================================
// async function setupPageProtections(p) {
//     try {
//         await p.setRequestInterception(true);
//         p.on('request', (req) => {
//             const url = req.url().toLowerCase();
//             const badWords = ['popads', 'exoclick', 'adsterra', 'onclickads', 'doubleclick', 'adexchangerapid', 'bet365', '1xbet'];
//             if (badWords.some(w => url.includes(w))) return req.abort().catch(() => {});
//             req.continue().catch(() => {});
//         });

//         // 📡 CHECK #1 & #3A: Network Status + HLS Manifest Sequence & Program-Date-Time
//         p.on('response', async (res) => {
//             try {
//                 const url = res.url().toLowerCase();
//                 const status = res.status();
//                 const isManifest = url.includes('.m3u8') || url.includes('.mpd');
//                 const isSegment = url.includes('.ts') || url.includes('.m4s') || url.includes('.aac') || url.includes('.mp4');

//                 if (isManifest || isSegment) {
//                     netStats.lastHttpStatus = status;
//                     if (status >= 200 && status < 400) {
//                         netStats.lastSegmentOkTime = Date.now();
//                         netStats.segmentErrorCount = 0;
//                     } else if (status >= 400) {
//                         netStats.segmentErrorCount++;
//                     }
//                 }

//                 // Parse HLS .m3u8 for #EXT-X-MEDIA-SEQUENCE & #EXT-X-PROGRAM-DATE-TIME
//                 if (url.includes('.m3u8') && status >= 200 && status < 300) {
//                     const text = await res.text().catch(() => '');
//                     if (text && text.includes('#EXTM3U')) {
//                         const seqMatch = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
//                         if (seqMatch) {
//                             netStats.seenManifest = true;
//                             const seq = parseInt(seqMatch[1], 10);
//                             if (netStats.lastMediaSeq !== null && seq === netStats.lastMediaSeq) {
//                                 netStats.staleManifestCount++;
//                             } else {
//                                 netStats.lastMediaSeq = seq;
//                                 netStats.lastSeqAdvanceTime = Date.now();
//                                 netStats.staleManifestCount = 0;
//                             }
//                         }

//                         const pdtMatches = text.match(/#EXT-X-PROGRAM-DATE-TIME:([^\r\n]+)/gi);
//                         if (pdtMatches && pdtMatches.length > 0) {
//                             const lastPdtLine = pdtMatches[pdtMatches.length - 1];
//                             const isoStr = lastPdtLine.replace(/#EXT-X-PROGRAM-DATE-TIME:/i, '').trim();
//                             const pdtTime = Date.parse(isoStr);
//                             if (!isNaN(pdtTime)) {
//                                 netStats.programDateTimeLagSec = Math.round((Date.now() - pdtTime) / 1000);
//                             }
//                         }
//                     }
//                 }
//             } catch (e) {}
//         });

//         p.on('requestfailed', (req) => {
//             const url = req.url().toLowerCase();
//             if (url.includes('.m3u8') || url.includes('.ts') || url.includes('.m4s')) {
//                 netStats.segmentErrorCount++;
//             }
//         });

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;
//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await p.evaluate((t, s) => {
//             if (window.self !== window.top) return;
//             let el = document.getElementById('bot-loading-ui');
//             if (!el) {
//                 el = document.createElement('div');
//                 el.id = 'bot-loading-ui';
//                 el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                 document.documentElement.appendChild(el);
//             }
//             el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//         }, title, subtitle);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await p.evaluate(() => {
//             const el = document.getElementById('bot-loading-ui');
//             if (el) el.remove();
//         });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY, LIVE EDGE CLICK & FULLSCREEN LOCK
// // =========================================================================================
// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Live / Unmute across all frames
//         for (let attempt = 0; attempt < 8; attempt++) {
//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await frame.evaluate((audioEnabled) => {
//                         const playAndLiveSelectors = '.jw-icon-display, .jw-icon-playback, .jw-icon-live, button[data-plyr="play"], .vjs-big-play-button, .vjs-play-control, .vjs-live-control, [class*="unmute"], .fp-play, .clappr-player, video';
//                         document.querySelectorAll(playAndLiveSelectors).forEach(el => { try { el.click(); } catch(e){} });

//                         let isPlaying = false;
//                         document.querySelectorAll('video').forEach(v => {
//                             if (v.paused) v.play().catch(() => {});
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;
//                             if (!v.paused && v.readyState >= 2) isPlaying = true;
//                         });
//                         return isPlaying;
//                     }, ENABLE_STREAM_AUDIO);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // Continuous 1s Lock: Fullscreen + Auto-Unpause if Live Pauses + Click Live Button
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await frame.evaluate((audioEnabled) => {
//                 if (window.__frameLockActive) return;
//                 window.__frameLockActive = true;
//                 setInterval(() => {
//                     document.documentElement.style.setProperty('background', '#000', 'important');
//                     if (document.body) document.body.style.setProperty('background', '#000', 'important');

//                     const v = document.querySelector('video');
//                     if (v) {
//                         // 1. Detect if Live is Paused -> Auto Play & Click Live Edge
//                         if (v.paused) {
//                             v.play().catch(() => {});
//                             const resumeSelectors = '.jw-icon-display, .jw-icon-playback, button[data-plyr="play"], .vjs-play-control, .vjs-big-play-button, .fp-play';
//                             document.querySelectorAll(resumeSelectors).forEach(btn => { try { btn.click(); } catch(e){} });
//                         }

//                         // Click "Live" button if stream falls behind live edge (e.g., DVR mode)
//                         const liveBtns = document.querySelectorAll('.jw-icon-live, .vjs-live-control, [class*="live-button"], [aria-label*="Live"]');
//                         liveBtns.forEach(btn => {
//                             const cls = (btn.className || '').toString().toLowerCase();
//                             if (cls.includes('not-live') || cls.includes('behind') || cls.includes('dvr')) {
//                                 try { btn.click(); } catch(e){}
//                             }
//                         });

//                         if (v.clientWidth > 50 || !v.paused) {
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;
//                             const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
//                             wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
//                             v.style.cssText = 'width:100% !important;height:100% !important;object-fit:contain !important;';
//                             document.querySelectorAll('.jw-controls, .plyr__controls, .vjs-control-bar').forEach(c => c.style.setProperty('display', 'none', 'important'));
//                             return;
//                         }
//                     }

//                     // Maximize child player iframe if this frame hosts nested iframes
//                     const iframes = Array.from(document.querySelectorAll('iframe'));
//                     let best = null, maxArea = 5000;
//                     iframes.forEach(f => {
//                         const area = f.clientWidth * f.clientHeight;
//                         if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
//                     });
//                     if (best) {
//                         iframes.forEach(f => { if (f !== best) f.style.setProperty('display', 'none', 'important'); });
//                         best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483645 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
//                     }
//                 }, 1000);
//             }, ENABLE_STREAM_AUDIO).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 🖼️ CHECK #3B: VISUAL FRAME HASH FREEZE & REPEAT-LOOP DETECTION
// // =========================================================================================
// async function checkVisualFreshness(p) {
//     const now = Date.now();
//     if (now - visualStats.lastCheckTime < 6000) {
//         return { visualStatus: 'OK' };
//     }
//     visualStats.lastCheckTime = now;

//     try {
//         // Capture lightweight low-res JPEG buffer from browser viewport
//         const buf = await p.screenshot({
//             type: 'jpeg',
//             quality: 25,
//             clip: {
//                 x: Math.floor(RES_W * 0.15),
//                 y: Math.floor(RES_H * 0.15),
//                 width: Math.floor(RES_W * 0.7),
//                 height: Math.floor(RES_H * 0.7)
//             }
//         });

//         const frameHash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);

//         // 1. Exact Visual Freeze Check
//         if (visualStats.lastHash === frameHash) {
//             const frozenMs = now - visualStats.sameHashSince;
//             if (frozenMs > 18000) {
//                 return { visualStatus: 'VISUAL_FROZEN', frozenSec: Math.round(frozenMs / 1000), hash: frameHash };
//             }
//         } else {
//             visualStats.lastHash = frameHash;
//             visualStats.sameHashSince = now;

//             // 2. Content Loop / Repeat Check (Track distinct frame transitions)
//             visualStats.recentHashes.push(frameHash);
//             if (visualStats.recentHashes.length > 18) visualStats.recentHashes.shift();

//             const occurrences = visualStats.recentHashes.filter(h => h === frameHash).length;
//             if (occurrences >= 5) {
//                 return { visualStatus: 'CONTENT_LOOP', hash: frameHash };
//             }
//         }

//         return { visualStatus: 'OK', hash: frameHash };
//     } catch (e) {
//         return { visualStatus: 'OK' };
//     }
// }

// // =========================================================================================
// // 💓 CHECK #2: PLAYBACK HEALTH & COMBINED WATCHDOG
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const v = document.querySelector('video');
//                         if (!v) return null;

//                         const frames = v.getVideoPlaybackQuality
//                             ? v.getVideoPlaybackQuality().totalVideoFrames
//                             : (v.webkitDecodedFrameCount || 0);

//                         // Check if live video is paused -> trigger immediate resume
//                         if (v.paused) {
//                             v.play().catch(() => {});
//                             const btns = document.querySelectorAll('.jw-icon-display, .jw-icon-live, .vjs-play-control, .vjs-live-control, button[data-plyr="play"]');
//                             btns.forEach(b => { try { b.click(); } catch(e){} });
//                             return {
//                                 status: 'PAUSED_RESUMING',
//                                 paused: true,
//                                 readyState: v.readyState,
//                                 currentTime: v.currentTime,
//                                 frames
//                             };
//                         }

//                         if (v.readyState >= 2 || frames > 0) {
//                             return {
//                                 status: 'HEALTHY',
//                                 paused: false,
//                                 readyState: v.readyState,
//                                 currentTime: v.currentTime,
//                                 frames
//                             };
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });

//         const results = await Promise.all(checks);
//         const healthy = results.find(r => r && r.status === 'HEALTHY');
//         if (healthy) return healthy;

//         const pausedStream = results.find(r => r && r.status === 'PAUSED_RESUMING');
//         if (pausedStream) return pausedStream;

//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     const targetUrl = urlList[currentUrlIndex];
//     console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);
//     resetMonitorStats();

//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//     try {
//         await page.goto('about:blank');
//         await page.bringToFront();
//         keepChromeOnTopAndHideOBS();
//         await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//         await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
//         await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//         await lockAndPlayVideo(page);
//         await hideLoadingOverlay(page);
//         keepChromeOnTopAndHideOBS();
//     } catch (e) {
//         console.log(`[⚠️] Page navigation warning: ${e.message}`);
//     }
//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1, lastWallClock = Date.now();
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         // 1. Evaluate Network & HLS Manifest Freshness
//         let networkState = 'OK';
//         if (netStats.segmentErrorCount >= 6) {
//             networkState = `NET_ERROR_${netStats.lastHttpStatus}`;
//         } else if (netStats.seenManifest && (Date.now() - netStats.lastSeqAdvanceTime > 25000)) {
//             networkState = 'STALE_MANIFEST';
//         }

//         // 2. Evaluate Playback & Visual Freshness
//         if (health.status === 'HEALTHY' || health.status === 'PAUSED_RESUMING') {
//             deadStrikes = 0;

//             if (health.status === 'PAUSED_RESUMING') {
//                 console.log(`[⏯️] Live Video was PAUSED -> Sent Auto-Play & Live-Edge click!`);
//                 await lockAndPlayVideo(page);
//             }

//             // Calculate playback speed ratio
//             const now = Date.now();
//             const wallElapsed = (now - lastWallClock) / 1000;
//             const timeDelta = lastTime !== -1 ? Math.abs(health.currentTime - lastTime) : wallElapsed;
//             const speedRatio = wallElapsed > 0 ? (timeDelta / wallElapsed).toFixed(2) : '1.00';
//             lastWallClock = now;

//             // Frame or Time moving forward OR backward means player decoder is active
//             const framesMoved = (lastFrames === -1) || (health.frames !== lastFrames);
//             const timeMoved = (lastTime === -1) || (health.currentTime !== lastTime);
//             const isMoving = framesMoved || timeMoved;

//             // Run Check #3: Visual Perceptual Hash Check (catches stuck frames & replay loops)
//             const visualCheck = await checkVisualFreshness(page);

//             if (!isMoving) {
//                 if (Date.now() - freezeStart > 18000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl('PLAYBACK FROZEN (No Frame/Time Movement for 18s)');
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                     continue;
//                 }
//             } else if (visualCheck.visualStatus === 'VISUAL_FROZEN') {
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl(`VISUAL SCREEN FROZEN (${visualCheck.frozenSec}s Static Frame)`);
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                 continue;
//             } else if (visualCheck.visualStatus === 'CONTENT_LOOP') {
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('FRESHNESS FAIL (Repeating Visual Loop Detected)');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                 continue;
//             } else if (networkState === 'STALE_MANIFEST' || networkState.startsWith('NET_ERROR')) {
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl(`NETWORK/MANIFEST FAIL (${networkState})`);
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                 continue;
//             } else {
//                 // All 3 Checks Healthy!
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }

//             ticks++;
//             if (ticks === 1 || ticks % 10 === 0) {
//                 console.log(
//                     `[💓] REPORT | Net: ${networkState} (HTTP:${netStats.lastHttpStatus}, Seq:${netStats.lastMediaSeq ?? 'N/A'}) | ` +
//                     `Playback: ${health.status} (Speed:${speedRatio}x, Time:${health.currentTime !== undefined ? health.currentTime.toFixed(1) + 's' : 'N/A'}, Frames:${health.frames ?? 'N/A'}) | ` +
//                     `Freshness: ${visualCheck.visualStatus} | URL [${currentUrlIndex + 1}/${urlList.length}]`
//                 );
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status} | Net: ${networkState}) - Strike ${deadStrikes}/5`);
//             if (deadStrikes >= 5) {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('5 STRIKES -> FAILOVER NEXT URL');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled', '--use-gl=egl'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--disable-extensions-except=${ublockPath}`);
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded!');
//     }

//     browser = await puppeteer.launch({
//         headless: false,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: ['--enable-automation'],
//         args
//     });

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         if (target.type() === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 300);
//             }
//         }
//     });

//     keepChromeOnTopAndHideOBS();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// // =========================================================================================
// // ⏱️ PROFESSIONAL MULTI-FORMAT DURATION PARSER & RELAY ENGINE (Supports 1h 10min, 0h 10min, 10h, 24/7)
// // =========================================================================================
// const RAW_DURATION = (process.env.CUSTOM_DURATION || '24/7').trim();
// const MAX_SINGLE_RUN_MS = 21000000; // 5h 50m (350 mins) - GitHub 6h hard limit se 10m pehle handover

// /**
//  * Parses formats like: "24/7", "10h", "1h 10min", "0h 10min", "2h 30m 15s", "45m", "90"
//  * Returns total milliseconds, or null if 24/7 (infinite).
//  */
// function parseFlexibleDuration(input) {
//     if (!input) return null;
//     const str = input.toLowerCase().trim();
//     if (str === '24/7' || str === 'infinite' || str === 'forever' || str === '0') return null;

//     let totalMs = 0;
//     let matched = false;

//     // Match all patterns like "1h", "10min", "30s", "2.5hrs"
//     const regex = /(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/g;
//     let match;
//     while ((match = regex.exec(str)) !== null) {
//         matched = true;
//         const val = parseFloat(match[1]);
//         const unit = match[2];
//         if (unit.startsWith('h')) totalMs += val * 3600 * 1000;
//         else if (unit.startsWith('m')) totalMs += val * 60 * 1000;
//         else if (unit.startsWith('s')) totalMs += val * 1000;
//     }

//     // Fallback: agar user ne sirf number likha ho jaise "120" -> treat as minutes
//     if (!matched && /^\d+(\.\d+)?$/.test(str)) {
//         totalMs = parseFloat(str) * 60 * 1000;
//         matched = true;
//     }

//     return (matched && totalMs > 0) ? Math.round(totalMs) : null;
// }

// /**
//  * Converts milliseconds back into clean human-readable format for next workflow (e.g., "4h 10m")
//  */
// function formatMsToDurationString(ms) {
//     const totalSeconds = Math.max(1, Math.round(ms / 1000));
//     const hours = Math.floor(totalSeconds / 3600);
//     const minutes = Math.floor((totalSeconds % 3600) / 60);
//     const seconds = totalSeconds % 60;

//     const parts = [];
//     if (hours > 0) parts.push(`${hours}h`);
//     if (minutes > 0) parts.push(`${minutes}m`);
//     if (hours === 0 && minutes === 0 && seconds > 0) parts.push(`${seconds}s`);
//     return parts.join(' ') || '1m';
// }

// /**
//  * Safely triggers the next GitHub Actions run and passes ALL inputs + remaining duration
//  */
// function triggerNextWorkflow(nextDurationValue) {
//     try {
//         console.log(`\n[🔄] Handover Initiated -> Launching Next Action with custom_duration="${nextDurationValue}"...`);
//         const args = [
//             'workflow', 'run', 'main.yml',
//             '-f', `target_urls=${process.env.TARGET_URLS || ''}`,
//             '-f', `okru_stream_channel=${SELECTED_CHANNEL}`,
//             '-f', `server_selection=${SERVER_SELECTION}`,
//             '-f', `stream_quality=${selectedQuality}`,
//             '-f', `proxy_engine=${PROXY_ENGINE}`,
//             '-f', `enable_stream_audio=${process.env.ENABLE_STREAM_AUDIO || 'ON'}`,
//             '-f', `custom_duration=${nextDurationValue}`
//         ];
//         const res = spawn('gh', args, { stdio: 'inherit' });
//         res.on('close', (code) => {
//             console.log(`[+] Next workflow triggered (Exit Code: ${code}). Keeping current stream alive for 60s overlap...`);
//             setTimeout(async () => {
//                 try { await obs.call('StopStream'); } catch (e) {}
//                 await cleanup();
//                 process.exit(0);
//             }, 60000);
//         });
//     } catch (e) {
//         console.error('[⚠️] Failed to trigger next workflow:', e.message);
//     }
// }

// const totalRequestedMs = parseFlexibleDuration(RAW_DURATION);

// if (totalRequestedMs === null) {
//     // =========================================================================
//     // MODE 1: 24/7 INFINITE STREAM
//     // =========================================================================
//     console.log(`[♾️] Duration Mode: 24/7 Infinite | Current Runner will hand over after 5h 50m.`);
//     setTimeout(() => {
//         triggerNextWorkflow('24/7');
//     }, MAX_SINGLE_RUN_MS);

// } else if (totalRequestedMs <= MAX_SINGLE_RUN_MS) {
//     // =========================================================================
//     // MODE 2: SHORT/MEDIUM DURATION (<= 5h 50m, e.g. "0h 10min", "1h 10min", "4h 10m")
//     // Stops cleanly in THIS runner without triggering a new workflow!
//     // =========================================================================
//     console.log(`[⏱️] Duration Mode: Fixed (${RAW_DURATION} -> ${formatMsToDurationString(totalRequestedMs)}) | Stream will STOP completely when timer ends.`);
//     setTimeout(async () => {
//         console.log(`\n[🛑] Target Duration (${RAW_DURATION}) Reached! Stopping OBS & Ending Action...`);
//         try { await obs.call('StopStream'); } catch (e) {}
//         await cleanup();
//         process.exit(0);
//     }, totalRequestedMs);

// } else {
//     // =========================================================================
//     // MODE 3: LONG DURATION (> 5h 50m, e.g. "10h", "12h 30min")
//     // Runs 5h 50m now, subtracts 5h 50m, and passes remaining time (e.g. "4h 10m") to next Action!
//     // =========================================================================
//     const remainingMs = totalRequestedMs - MAX_SINGLE_RUN_MS;
//     const nextDurationStr = formatMsToDurationString(remainingMs);
//     console.log(`[⏱️] Duration Mode: Long Relay (${RAW_DURATION} total) | Running 5h 50m now, then passing "${nextDurationStr}" to Next Action!`);

//     setTimeout(() => {
//         triggerNextWorkflow(nextDurationStr);
//     }, MAX_SINGLE_RUN_MS);
// }

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();



























// ================= ALhamdullah Alhamdullah yeh kaam kar raha hai dlhd done, alhamdullah hang bey nahey hur aha hai eetnaa zydaa @@@@@@@@@@ @@@@@ ###### ==================
// -=============================================================================================================================================
// ===================================================================================================



// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const crypto = require('crypto');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// // =========================================================================================
// // 📊 3-PILLAR HEALTH MONITOR STATE (Network + Manifest + Visual Hash)
// // =========================================================================================
// let netStats = {
//     lastSegmentOkTime: Date.now(),
//     segmentErrorCount: 0,
//     lastHttpStatus: 200,
//     lastMediaSeq: null,
//     lastSeqAdvanceTime: Date.now(),
//     staleManifestCount: 0,
//     programDateTimeLagSec: 0,
//     seenManifest: false
// };

// let visualStats = {
//     lastCheckTime: 0,
//     lastHash: null,
//     sameHashSince: Date.now(),
//     recentHashes: [] // Rolling window for repeat/loop detection
// };

// function resetMonitorStats() {
//     netStats = {
//         lastSegmentOkTime: Date.now(),
//         segmentErrorCount: 0,
//         lastHttpStatus: 200,
//         lastMediaSeq: null,
//         lastSeqAdvanceTime: Date.now(),
//         staleManifestCount: 0,
//         programDateTimeLagSec: 0,
//         seenManifest: false
//     };
//     visualStats = {
//         lastCheckTime: 0,
//         lastHash: null,
//         sameHashSince: Date.now(),
//         recentHashes: []
//     };
// }

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (With OBS 30+ WebSocket Plugin Fix)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     fs.writeFileSync(path.join(obsDir, 'global.ini'), `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Advanced\n[AdvOut]\nTrackIndex=1\nRecType=Standard\nEncoder=obs_x264\n[obs_x264]\nbitrate=${BITRATE}\nkeyint_sec=2\npreset=ultrafast\nprofile=main\ntune=zerolatency\n`);

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb Fix)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + CHECK #1: NETWORK & HLS MANIFEST FRESHNESS MONITOR
// // =========================================================================================
// async function setupPageProtections(p) {
//     try {
//         await p.setRequestInterception(true);
//         p.on('request', (req) => {
//             const url = req.url().toLowerCase();
//             const badWords = ['popads', 'exoclick', 'adsterra', 'onclickads', 'doubleclick', 'adexchangerapid', 'bet365', '1xbet'];
//             if (badWords.some(w => url.includes(w))) return req.abort().catch(() => {});
//             req.continue().catch(() => {});
//         });

//         // 📡 CHECK #1 & #3A: Network Status + HLS Manifest Sequence & Program-Date-Time
//         p.on('response', async (res) => {
//             try {
//                 const url = res.url().toLowerCase();
//                 const status = res.status();
//                 const isManifest = url.includes('.m3u8') || url.includes('.mpd');
//                 const isSegment = url.includes('.ts') || url.includes('.m4s') || url.includes('.aac') || url.includes('.mp4');

//                 if (isManifest || isSegment) {
//                     netStats.lastHttpStatus = status;
//                     if (status >= 200 && status < 400) {
//                         netStats.lastSegmentOkTime = Date.now();
//                         netStats.segmentErrorCount = 0;
//                     } else if (status >= 400) {
//                         netStats.segmentErrorCount++;
//                     }
//                 }

//                 // Parse HLS .m3u8 for #EXT-X-MEDIA-SEQUENCE & #EXT-X-PROGRAM-DATE-TIME
//                 if (url.includes('.m3u8') && status >= 200 && status < 300) {
//                     const text = await res.text().catch(() => '');
//                     if (text && text.includes('#EXTM3U')) {
//                         const seqMatch = text.match(/#EXT-X-MEDIA-SEQUENCE:(\d+)/i);
//                         if (seqMatch) {
//                             netStats.seenManifest = true;
//                             const seq = parseInt(seqMatch[1], 10);
//                             if (netStats.lastMediaSeq !== null && seq === netStats.lastMediaSeq) {
//                                 netStats.staleManifestCount++;
//                             } else {
//                                 netStats.lastMediaSeq = seq;
//                                 netStats.lastSeqAdvanceTime = Date.now();
//                                 netStats.staleManifestCount = 0;
//                             }
//                         }

//                         const pdtMatches = text.match(/#EXT-X-PROGRAM-DATE-TIME:([^\r\n]+)/gi);
//                         if (pdtMatches && pdtMatches.length > 0) {
//                             const lastPdtLine = pdtMatches[pdtMatches.length - 1];
//                             const isoStr = lastPdtLine.replace(/#EXT-X-PROGRAM-DATE-TIME:/i, '').trim();
//                             const pdtTime = Date.parse(isoStr);
//                             if (!isNaN(pdtTime)) {
//                                 netStats.programDateTimeLagSec = Math.round((Date.now() - pdtTime) / 1000);
//                             }
//                         }
//                     }
//                 }
//             } catch (e) {}
//         });

//         p.on('requestfailed', (req) => {
//             const url = req.url().toLowerCase();
//             if (url.includes('.m3u8') || url.includes('.ts') || url.includes('.m4s')) {
//                 netStats.segmentErrorCount++;
//             }
//         });

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;
//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await p.evaluate((t, s) => {
//             if (window.self !== window.top) return;
//             let el = document.getElementById('bot-loading-ui');
//             if (!el) {
//                 el = document.createElement('div');
//                 el.id = 'bot-loading-ui';
//                 el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                 document.documentElement.appendChild(el);
//             }
//             el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//         }, title, subtitle);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await p.evaluate(() => {
//             const el = document.getElementById('bot-loading-ui');
//             if (el) el.remove();
//         });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY, LIVE EDGE CLICK & FULLSCREEN LOCK
// // =========================================================================================
// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Live / Unmute across all frames
//         for (let attempt = 0; attempt < 8; attempt++) {
//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await frame.evaluate((audioEnabled) => {
//                         const playAndLiveSelectors = '.jw-icon-display, .jw-icon-playback, .jw-icon-live, button[data-plyr="play"], .vjs-big-play-button, .vjs-play-control, .vjs-live-control, [class*="unmute"], .fp-play, .clappr-player, video';
//                         document.querySelectorAll(playAndLiveSelectors).forEach(el => { try { el.click(); } catch(e){} });

//                         let isPlaying = false;
//                         document.querySelectorAll('video').forEach(v => {
//                             if (v.paused) v.play().catch(() => {});
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;
//                             if (!v.paused && v.readyState >= 2) isPlaying = true;
//                         });
//                         return isPlaying;
//                     }, ENABLE_STREAM_AUDIO);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // Continuous 1s Lock: Fullscreen + Auto-Unpause if Live Pauses + Click Live Button
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await frame.evaluate((audioEnabled) => {
//                 if (window.__frameLockActive) return;
//                 window.__frameLockActive = true;
//                 setInterval(() => {
//                     document.documentElement.style.setProperty('background', '#000', 'important');
//                     if (document.body) document.body.style.setProperty('background', '#000', 'important');

//                     const v = document.querySelector('video');
//                     if (v) {
//                         // 1. Detect if Live is Paused -> Auto Play & Click Live Edge
//                         if (v.paused) {
//                             v.play().catch(() => {});
//                             const resumeSelectors = '.jw-icon-display, .jw-icon-playback, button[data-plyr="play"], .vjs-play-control, .vjs-big-play-button, .fp-play';
//                             document.querySelectorAll(resumeSelectors).forEach(btn => { try { btn.click(); } catch(e){} });
//                         }

//                         // Click "Live" button if stream falls behind live edge (e.g., DVR mode)
//                         const liveBtns = document.querySelectorAll('.jw-icon-live, .vjs-live-control, [class*="live-button"], [aria-label*="Live"]');
//                         liveBtns.forEach(btn => {
//                             const cls = (btn.className || '').toString().toLowerCase();
//                             if (cls.includes('not-live') || cls.includes('behind') || cls.includes('dvr')) {
//                                 try { btn.click(); } catch(e){}
//                             }
//                         });

//                         if (v.clientWidth > 50 || !v.paused) {
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;
//                             const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
//                             wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
//                             v.style.cssText = 'width:100% !important;height:100% !important;object-fit:contain !important;';
//                             document.querySelectorAll('.jw-controls, .plyr__controls, .vjs-control-bar').forEach(c => c.style.setProperty('display', 'none', 'important'));
//                             return;
//                         }
//                     }

//                     // Maximize child player iframe if this frame hosts nested iframes
//                     const iframes = Array.from(document.querySelectorAll('iframe'));
//                     let best = null, maxArea = 5000;
//                     iframes.forEach(f => {
//                         const area = f.clientWidth * f.clientHeight;
//                         if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
//                     });
//                     if (best) {
//                         iframes.forEach(f => { if (f !== best) f.style.setProperty('display', 'none', 'important'); });
//                         best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483645 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
//                     }
//                 }, 1000);
//             }, ENABLE_STREAM_AUDIO).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 🖼️ CHECK #3B: VISUAL FRAME HASH FREEZE & REPEAT-LOOP DETECTION
// // =========================================================================================
// async function checkVisualFreshness(p) {
//     const now = Date.now();
//     if (now - visualStats.lastCheckTime < 6000) {
//         return { visualStatus: 'OK' };
//     }
//     visualStats.lastCheckTime = now;

//     try {
//         // Capture lightweight low-res JPEG buffer from browser viewport
//         const buf = await p.screenshot({
//             type: 'jpeg',
//             quality: 25,
//             clip: {
//                 x: Math.floor(RES_W * 0.15),
//                 y: Math.floor(RES_H * 0.15),
//                 width: Math.floor(RES_W * 0.7),
//                 height: Math.floor(RES_H * 0.7)
//             }
//         });

//         const frameHash = crypto.createHash('md5').update(buf).digest('hex').slice(0, 12);

//         // 1. Exact Visual Freeze Check
//         if (visualStats.lastHash === frameHash) {
//             const frozenMs = now - visualStats.sameHashSince;
//             if (frozenMs > 18000) {
//                 return { visualStatus: 'VISUAL_FROZEN', frozenSec: Math.round(frozenMs / 1000), hash: frameHash };
//             }
//         } else {
//             visualStats.lastHash = frameHash;
//             visualStats.sameHashSince = now;

//             // 2. Content Loop / Repeat Check (Track distinct frame transitions)
//             visualStats.recentHashes.push(frameHash);
//             if (visualStats.recentHashes.length > 18) visualStats.recentHashes.shift();

//             const occurrences = visualStats.recentHashes.filter(h => h === frameHash).length;
//             if (occurrences >= 5) {
//                 return { visualStatus: 'CONTENT_LOOP', hash: frameHash };
//             }
//         }

//         return { visualStatus: 'OK', hash: frameHash };
//     } catch (e) {
//         return { visualStatus: 'OK' };
//     }
// }

// // =========================================================================================
// // 💓 CHECK #2: PLAYBACK HEALTH & COMBINED WATCHDOG
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const v = document.querySelector('video');
//                         if (!v) return null;

//                         const frames = v.getVideoPlaybackQuality
//                             ? v.getVideoPlaybackQuality().totalVideoFrames
//                             : (v.webkitDecodedFrameCount || 0);

//                         // Check if live video is paused -> trigger immediate resume
//                         if (v.paused) {
//                             v.play().catch(() => {});
//                             const btns = document.querySelectorAll('.jw-icon-display, .jw-icon-live, .vjs-play-control, .vjs-live-control, button[data-plyr="play"]');
//                             btns.forEach(b => { try { b.click(); } catch(e){} });
//                             return {
//                                 status: 'PAUSED_RESUMING',
//                                 paused: true,
//                                 readyState: v.readyState,
//                                 currentTime: v.currentTime,
//                                 frames
//                             };
//                         }

//                         if (v.readyState >= 2 || frames > 0) {
//                             return {
//                                 status: 'HEALTHY',
//                                 paused: false,
//                                 readyState: v.readyState,
//                                 currentTime: v.currentTime,
//                                 frames
//                             };
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });

//         const results = await Promise.all(checks);
//         const healthy = results.find(r => r && r.status === 'HEALTHY');
//         if (healthy) return healthy;

//         const pausedStream = results.find(r => r && r.status === 'PAUSED_RESUMING');
//         if (pausedStream) return pausedStream;

//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     const targetUrl = urlList[currentUrlIndex];
//     console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);
//     resetMonitorStats();

//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//     try {
//         await page.goto('about:blank');
//         await page.bringToFront();
//         keepChromeOnTopAndHideOBS();
//         await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//         await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
//         await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//         await lockAndPlayVideo(page);
//         await hideLoadingOverlay(page);
//         keepChromeOnTopAndHideOBS();
//     } catch (e) {
//         console.log(`[⚠️] Page navigation warning: ${e.message}`);
//     }
//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1, lastWallClock = Date.now();
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         // 1. Evaluate Network & HLS Manifest Freshness
//         let networkState = 'OK';
//         if (netStats.segmentErrorCount >= 6) {
//             networkState = `NET_ERROR_${netStats.lastHttpStatus}`;
//         } else if (netStats.seenManifest && (Date.now() - netStats.lastSeqAdvanceTime > 25000)) {
//             networkState = 'STALE_MANIFEST';
//         }

//         // 2. Evaluate Playback & Visual Freshness
//         if (health.status === 'HEALTHY' || health.status === 'PAUSED_RESUMING') {
//             deadStrikes = 0;

//             if (health.status === 'PAUSED_RESUMING') {
//                 console.log(`[⏯️] Live Video was PAUSED -> Sent Auto-Play & Live-Edge click!`);
//                 await lockAndPlayVideo(page);
//             }

//             // Calculate playback speed ratio
//             const now = Date.now();
//             const wallElapsed = (now - lastWallClock) / 1000;
//             const timeDelta = lastTime !== -1 ? Math.abs(health.currentTime - lastTime) : wallElapsed;
//             const speedRatio = wallElapsed > 0 ? (timeDelta / wallElapsed).toFixed(2) : '1.00';
//             lastWallClock = now;

//             // Frame or Time moving forward OR backward means player decoder is active
//             const framesMoved = (lastFrames === -1) || (health.frames !== lastFrames);
//             const timeMoved = (lastTime === -1) || (health.currentTime !== lastTime);
//             const isMoving = framesMoved || timeMoved;

//             // Run Check #3: Visual Perceptual Hash Check (catches stuck frames & replay loops)
//             const visualCheck = await checkVisualFreshness(page);

//             if (!isMoving) {
//                 if (Date.now() - freezeStart > 18000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl('PLAYBACK FROZEN (No Frame/Time Movement for 18s)');
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                     continue;
//                 }
//             } else if (visualCheck.visualStatus === 'VISUAL_FROZEN') {
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl(`VISUAL SCREEN FROZEN (${visualCheck.frozenSec}s Static Frame)`);
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                 continue;
//             } else if (visualCheck.visualStatus === 'CONTENT_LOOP') {
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('FRESHNESS FAIL (Repeating Visual Loop Detected)');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                 continue;
//             } else if (networkState === 'STALE_MANIFEST' || networkState.startsWith('NET_ERROR')) {
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl(`NETWORK/MANIFEST FAIL (${networkState})`);
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                 continue;
//             } else {
//                 // All 3 Checks Healthy!
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }

//             ticks++;
//             if (ticks === 1 || ticks % 10 === 0) {
//                 console.log(
//                     `[💓] REPORT | Net: ${networkState} (HTTP:${netStats.lastHttpStatus}, Seq:${netStats.lastMediaSeq ?? 'N/A'}) | ` +
//                     `Playback: ${health.status} (Speed:${speedRatio}x, Time:${health.currentTime !== undefined ? health.currentTime.toFixed(1) + 's' : 'N/A'}, Frames:${health.frames ?? 'N/A'}) | ` +
//                     `Freshness: ${visualCheck.visualStatus} | URL [${currentUrlIndex + 1}/${urlList.length}]`
//                 );
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status} | Net: ${networkState}) - Strike ${deadStrikes}/5`);
//             if (deadStrikes >= 5) {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('5 STRIKES -> FAILOVER NEXT URL');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled', '--use-gl=egl'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--disable-extensions-except=${ublockPath}`);
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded!');
//     }

//     browser = await puppeteer.launch({
//         headless: false,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: ['--enable-automation'],
//         args
//     });

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         if (target.type() === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 300);
//             }
//         }
//     });

//     keepChromeOnTopAndHideOBS();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// setTimeout(() => {
//     try {
//         const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}"`;
//         execSync(cmd, { stdio: 'inherit' });
//         setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//     } catch (e) {}
// }, 21000000);

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();























// ==================================== 1 sports.online work here , the hang i thhink the hang comes when new like time starts from 0 =========================



// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (With OBS 30+ WebSocket Plugin Fix)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     fs.writeFileSync(path.join(obsDir, 'global.ini'), `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Advanced\n[AdvOut]\nTrackIndex=1\nRecType=Standard\nEncoder=obs_x264\n[obs_x264]\nbitrate=${BITRATE}\nkeyint_sec=2\npreset=ultrafast\nprofile=main\ntune=zerolatency\n`);

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb Fix)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI
// // =========================================================================================
// async function setupPageProtections(p) {
//     try {
//         await p.setRequestInterception(true);
//         p.on('request', (req) => {
//             const url = req.url().toLowerCase();
//             const badWords = ['popads', 'exoclick', 'adsterra', 'onclickads', 'doubleclick', 'adexchangerapid', 'bet365', '1xbet'];
//             if (badWords.some(w => url.includes(w))) return req.abort().catch(() => {});
//             req.continue().catch(() => {});
//         });

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;
//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await p.evaluate((t, s) => {
//             if (window.self !== window.top) return;
//             let el = document.getElementById('bot-loading-ui');
//             if (!el) {
//                 el = document.createElement('div');
//                 el.id = 'bot-loading-ui';
//                 el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                 document.documentElement.appendChild(el);
//             }
//             el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//         }, title, subtitle);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await p.evaluate(() => {
//             const el = document.getElementById('bot-loading-ui');
//             if (el) el.remove();
//         });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY, LIVE EDGE CLICK & FULLSCREEN LOCK
// // =========================================================================================
// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Live / Unmute across all frames
//         for (let attempt = 0; attempt < 8; attempt++) {
//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await frame.evaluate((audioEnabled) => {
//                         const playAndLiveSelectors = '.jw-icon-display, .jw-icon-playback, .jw-icon-live, button[data-plyr="play"], .vjs-big-play-button, .vjs-play-control, .vjs-live-control, [class*="unmute"], .fp-play, .clappr-player, video';
//                         document.querySelectorAll(playAndLiveSelectors).forEach(el => { try { el.click(); } catch(e){} });

//                         let isPlaying = false;
//                         document.querySelectorAll('video').forEach(v => {
//                             if (v.paused) v.play().catch(() => {});
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;
//                             if (!v.paused && v.readyState >= 2) isPlaying = true;
//                         });
//                         return isPlaying;
//                     }, ENABLE_STREAM_AUDIO);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // Continuous 1s Lock: Fullscreen + Auto-Unpause if Live Pauses + Click Live Button
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await frame.evaluate((audioEnabled) => {
//                 if (window.__frameLockActive) return;
//                 window.__frameLockActive = true;
//                 setInterval(() => {
//                     document.documentElement.style.setProperty('background', '#000', 'important');
//                     if (document.body) document.body.style.setProperty('background', '#000', 'important');

//                     const v = document.querySelector('video');
//                     if (v) {
//                         // 1. Detect if Live is Paused -> Auto Play & Click Live Edge
//                         if (v.paused) {
//                             v.play().catch(() => {});
//                             const resumeSelectors = '.jw-icon-display, .jw-icon-playback, button[data-plyr="play"], .vjs-play-control, .vjs-big-play-button, .fp-play';
//                             document.querySelectorAll(resumeSelectors).forEach(btn => { try { btn.click(); } catch(e){} });
//                         }

//                         // Click "Live" button if stream falls behind live edge (e.g., DVR mode)
//                         const liveBtns = document.querySelectorAll('.jw-icon-live, .vjs-live-control, [class*="live-button"], [aria-label*="Live"]');
//                         liveBtns.forEach(btn => {
//                             const cls = (btn.className || '').toString().toLowerCase();
//                             if (cls.includes('not-live') || cls.includes('behind') || cls.includes('dvr')) {
//                                 try { btn.click(); } catch(e){}
//                             }
//                         });

//                         if (v.clientWidth > 50 || !v.paused) {
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;
//                             const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
//                             wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
//                             v.style.cssText = 'width:100% !important;height:100% !important;object-fit:contain !important;';
//                             document.querySelectorAll('.jw-controls, .plyr__controls, .vjs-control-bar').forEach(c => c.style.setProperty('display', 'none', 'important'));
//                             return;
//                         }
//                     }

//                     // Maximize child player iframe if this frame hosts nested iframes
//                     const iframes = Array.from(document.querySelectorAll('iframe'));
//                     let best = null, maxArea = 5000;
//                     iframes.forEach(f => {
//                         const area = f.clientWidth * f.clientHeight;
//                         if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
//                     });
//                     if (best) {
//                         iframes.forEach(f => { if (f !== best) f.style.setProperty('display', 'none', 'important'); });
//                         best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483645 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
//                     }
//                 }, 1000);
//             }, ENABLE_STREAM_AUDIO).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG (Pause-Aware + Forward/Backward Frame Movement)
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const v = document.querySelector('video');
//                         if (!v) return null;

//                         const frames = v.getVideoPlaybackQuality
//                             ? v.getVideoPlaybackQuality().totalVideoFrames
//                             : (v.webkitDecodedFrameCount || 0);

//                         // Check if live video is paused -> trigger immediate resume
//                         if (v.paused) {
//                             v.play().catch(() => {});
//                             const btns = document.querySelectorAll('.jw-icon-display, .jw-icon-live, .vjs-play-control, .vjs-live-control, button[data-plyr="play"]');
//                             btns.forEach(b => { try { b.click(); } catch(e){} });
//                             return {
//                                 status: 'PAUSED_RESUMING',
//                                 paused: true,
//                                 currentTime: v.currentTime,
//                                 frames
//                             };
//                         }

//                         if (v.readyState >= 2 || frames > 0) {
//                             return {
//                                 status: 'HEALTHY',
//                                 paused: false,
//                                 currentTime: v.currentTime,
//                                 frames
//                             };
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });

//         const results = await Promise.all(checks);
//         const healthy = results.find(r => r && r.status === 'HEALTHY');
//         if (healthy) return healthy;

//         const pausedStream = results.find(r => r && r.status === 'PAUSED_RESUMING');
//         if (pausedStream) return pausedStream;

//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     const targetUrl = urlList[currentUrlIndex];
//     console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//     try {
//         await page.goto('about:blank');
//         await page.bringToFront();
//         keepChromeOnTopAndHideOBS();
//         await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//         await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
//         await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//         await lockAndPlayVideo(page);
//         await hideLoadingOverlay(page);
//         keepChromeOnTopAndHideOBS();
//     } catch (e) {
//         console.log(`[⚠️] Page navigation warning: ${e.message}`);
//     }
//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         // If stream is HEALTHY or even if PAUSED_RESUMING, check frame/time movement
//         if (health.status === 'HEALTHY' || health.status === 'PAUSED_RESUMING') {
//             deadStrikes = 0;

//             if (health.status === 'PAUSED_RESUMING') {
//                 console.log(`[⏯️] Live Video was PAUSED -> Sent Auto-Play & Live-Edge click!`);
//                 await lockAndPlayVideo(page);
//             }

//             // Frame or Time moving forward OR backward means stream is LIVE
//             const framesMoved = (lastFrames === -1) || (health.frames !== lastFrames);
//             const timeMoved = (lastTime === -1) || (health.currentTime !== lastTime);
//             const isMoving = framesMoved || timeMoved;

//             if (!isMoving) {
//                 // Neither frames nor time moved at all
//                 if (Date.now() - freezeStart > 18000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl('VIDEO FROZEN (No Frame Movement for 18s)');
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                 }
//             } else {
//                 // Frames or time moved (forward or backward) -> Stream is LIVE!
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/5`);
//             if (deadStrikes >= 5) {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('5 STRIKES -> FAILOVER NEXT URL');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 10 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Paused: ${health.paused ?? 'N/A'} | Time: ${health.currentTime !== undefined ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled', '--use-gl=egl'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--disable-extensions-except=${ublockPath}`);
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded!');
//     }

//     browser = await puppeteer.launch({
//         headless: false,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: ['--enable-automation'],
//         args
//     });

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         if (target.type() === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 300);
//             }
//         }
//     });

//     keepChromeOnTopAndHideOBS();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// setTimeout(() => {
//     try {
//         const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}"`;
//         execSync(cmd, { stdio: 'inherit' });
//         setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//     } catch (e) {}
// }, 21000000);

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();


























// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (With OBS 30+ WebSocket Plugin Fix)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     // Legacy + Modern OBS WebSocket Config
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Advanced\n[AdvOut]\nTrackIndex=1\nRecType=Standard\nEncoder=obs_x264\n[obs_x264]\nbitrate=${BITRATE}\nkeyint_sec=2\npreset=ultrafast\nprofile=main\ntune=zerolatency\n`);

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     // MainScene set as default so video + audio broadcast even if WebSocket is delayed
//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb Fix)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI
// // =========================================================================================
// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI (DRM-Safe CDP + Windows 11 Anti-Detect Spoof)
// // =========================================================================================
// const AD_BLOCK_PATTERNS = [
//     '*popads*', '*popcash*', '*exoclick*', '*adsterra*', '*onclickads*',
//     '*doubleclick*', '*googlesyndication*', '*adexchangerapid*', '*bet365*', '*1xbet*',
//     '*propellerads*', '*hilltopads*', '*trafficjunky*', '*juicyads*', '*clickadu*',
//     '*adcash*', '*galaksion*', '*bidvertiser*', '*revcontent*', '*mgid*',
//     '*taboola*', '*outbrain*', '*acscdn*', '*histats*', '*usrpubtrk*',
//     '*clarity.ms*', '*yandex.ru/metrika*', '*adsco.re*', '*a-ads.com*', '*bidgear*'
// ];

// async function attachCdpAdBlocker(target) {
//     try {
//         const client = await target.createCDPSession();
//         await client.send('Network.enable');
//         await client.send('Network.setBlockedURLs', { urls: AD_BLOCK_PATTERNS });
//     } catch (e) {}
// }

// async function setupPageProtections(p) {
//     try {
//         // 1. Request Interception for Ad-blocking & DRM safety
//         await p.setRequestInterception(true);
//         p.on('request', req => {
//             const url = req.url(), type = req.resourceType();
//             const critical = ['media','xhr','fetch'].includes(type) ||
//                 /\.(m3u8|ts|m4s|mpd|key)(\?|$)|license|\/key\/|jwplayer|jwpcdn/i.test(url);
//             if (critical) return req.continue();
            
//             const cleanAdDomains = AD_BLOCK_PATTERNS.map(d => d.replace(/\*/g, ''));
//             if (cleanAdDomains.some(d => url.includes(d))) return req.abort();
//             return req.continue();
//         });

//         // 2. 403 Response Logger to track exact blocked requests
//         p.on('response', r => {
//             if (r.status() === 403) console.log('[⚠️] 403 Forbidden:', r.url());
//         });

//         // 3. Spoof Windows 11 + NVIDIA GPU so Backend CDN doesn't block Linux GitHub Runner
//         await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;

//             // Hide Linux & Headless indicators from Player Anti-Bot scripts
//             Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
//             Object.defineProperty(navigator, 'webdriver', { get: () => false });
//             Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
//             Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

//             // Spoof WebGL Renderer (Hides Google SwiftShader / Virtual Xvfb GPU)
//             const getParameter = WebGLRenderingContext.prototype.getParameter;
//             WebGLRenderingContext.prototype.getParameter = function(param) {
//                 if (param === 37445) return 'Google Inc. (NVIDIA)';
//                 if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                 return getParameter.apply(this, arguments);
//             };

//             // Inject encrypted-media permission into every iframe BEFORE it loads
//             const drmAllow = 'encrypted-media; autoplay; fullscreen';
//             const patchIframe = (el) => {
//                 if (el && el.tagName === 'IFRAME') {
//                     if (!el.allow || !el.allow.includes('encrypted-media')) {
//                         el.setAttribute('allow', drmAllow);
//                     }
//                 }
//             };
//             const obs = new MutationObserver((mutations) => {
//                 for (const m of mutations) {
//                     for (const node of m.addedNodes) {
//                         if (node.nodeType === 1) {
//                             patchIframe(node);
//                             if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(patchIframe);
//                         }
//                     }
//                 }
//             });
//             obs.observe(document, { childList: true, subtree: true });

//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             if (document.documentElement) document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await p.evaluate((t, s) => {
//             if (window.self !== window.top) return;
//             let el = document.getElementById('bot-loading-ui');
//             if (!el) {
//                 el = document.createElement('div');
//                 el.id = 'bot-loading-ui';
//                 el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                 document.documentElement.appendChild(el);
//             }
//             el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//         }, title, subtitle);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await p.evaluate(() => {
//             const el = document.getElementById('bot-loading-ui');
//             if (el) el.remove();
//         });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Supports Nested Iframes like webcric)
// // =========================================================================================
// let currentPlayerTab = 0;

// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames + Instant Switch on "Protected Content" (403)
//         for (let attempt = 0; attempt < 10; attempt++) {
//             let hasProtectedError = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const errFound = await frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         return txt.includes('protected content') || txt.includes('232403') || txt.includes('cannot be played') || txt.includes('error code');
//                     });
//                     if (errFound) { hasProtectedError = true; break; }
//                 } catch (e) {}
//             }

//             if (hasProtectedError) {
//                 currentPlayerTab++;
//                 // Un-lock fullscreen iframe on main page FIRST so clicking the next Player button actually swaps the iframe!
//                 await p.evaluate((tabIdx) => {
//                     document.querySelectorAll('iframe').forEach(f => {
//                         f.style.cssText = 'width:100%;height:500px;position:relative;z-index:1;display:block;visibility:visible;';
//                     });
//                     // Find unique clickable Player / Server / Stream buttons or links
//                     const allEls = Array.from(document.querySelectorAll('a, button, .btn, [onclick], [data-stream], [data-server], li'));
//                     const playerBtns = allEls.filter(el => {
//                         if (el.children.length > 1) return false; // Avoid parent wrapper divs
//                         const t = (el.innerText || '').trim();
//                         return /^(Player|Server|Stream|Channel|Link|HD|Backup|Mirror)\s*\d*$/i.test(t) || /player|stream|embed|watch/i.test(el.getAttribute('href') || '') || el.hasAttribute('onclick');
//                     });
//                     if (playerBtns.length > 0) {
//                         const targetBtn = playerBtns[tabIdx % playerBtns.length];
//                         targetBtn.click();
//                     }
//                 }, currentPlayerTab).catch(() => {});
//                 console.log(`[⚡] Protected Content (403) -> Switched immediately to Player option #${currentPlayerTab + 1}`);
//                 await new Promise(r => setTimeout(r, 3500));
//             }

//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await frame.evaluate((audioEnabled) => {
//                         let isPlaying = false;
//                         const videos = document.querySelectorAll('video');

//                         videos.forEach(v => {
//                             // Unmute & set volume without clicking the video element
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;

//                             // ONLY call v.play() if it is actually paused! Never click <video> or .clappr-player
//                             if (v.paused) {
//                                 v.play().catch(() => {});
//                             }
//                             if (!v.paused && v.readyState >= 2) {
//                                 isPlaying = true;
//                             }
//                         });

//                         // ONLY click play overlays if NO video is playing yet
//                         if (!isPlaying) {
//                             const playSelectors = '.jw-display-icon-display, button[data-plyr="play"], .vjs-big-play-button, .player-poster[class*="clickable"]';
//                             document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });
//                         }

//                         // Click dedicated unmute buttons ONLY if they exist
//                         if (audioEnabled) {
//                             document.querySelectorAll('[class*="unmute"], .jw-icon-volume').forEach(el => {
//                                 const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
//                                 if (txt.includes('unmute') || el.className.includes('unmute')) {
//                                     try { el.click(); } catch(e){}
//                                 }
//                             });
//                         }

//                         return isPlaying;
//                     }, ENABLE_STREAM_AUDIO);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // Stretch largest iframe OR video ONLY when no "protected content" error is on screen
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await frame.evaluate((audioEnabled) => {
//                 if (window.__frameLockActive) return;
//                 window.__frameLockActive = true;
//                 setInterval(() => {
//                     const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                     if (txt.includes('protected content') || txt.includes('232403')) return; // Do NOT lock broken error frame!

//                     document.documentElement.style.setProperty('background', '#000', 'important');
//                     if (document.body) document.body.style.setProperty('background', '#000', 'important');

//                     const v = document.querySelector('video');
//                     if (v && (v.clientWidth > 50 || !v.paused)) {
//                         // Crucial Fix: If anything pauses the video, immediately resume it via JS API!
//                         if (v.paused) v.play().catch(() => {});
//                         v.muted = !audioEnabled;
//                         v.volume = audioEnabled ? 1.0 : 0.0;
//                         const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
//                         wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
//                         v.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483647 !important;background:#000 !important;object-fit:contain !important;pointer-events:none !important;';

//                         // Nuke every overlay ad, banner, iframe, or fake close button inside the video frame
//                         document.querySelectorAll('body *').forEach(el => {
//                             if (el === v || el.contains(v) || el.tagName === 'STYLE' || el.tagName === 'SCRIPT') return;
//                             el.style.setProperty('display', 'none', 'important');
//                             el.style.setProperty('visibility', 'hidden', 'important');
//                             el.style.setProperty('opacity', '0', 'important');
//                         });
//                         return;
//                     }

//                     // Maximize active player iframe & hide all surrounding page ads/banners
//                     const iframes = Array.from(document.querySelectorAll('iframe'));
//                     let best = null, maxArea = 5000;
//                     iframes.forEach(f => {
//                         const src = (f.src || '').toLowerCase();
//                         if (/popads|exoclick|adsterra|doubleclick|bet365|1xbet|juicyads|clickadu|propeller/i.test(src)) {
//                             f.remove();
//                             return;
//                         }
//                         const area = f.clientWidth * f.clientHeight;
//                         if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
//                     });
//                     if (best) {
//                         best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
//                         // Hide floating page ads/overlays while keeping player switcher buttons clickable in DOM
//                         document.querySelectorAll('body *').forEach(el => {
//                             if (el === best || el.contains(best) || el.id === 'bot-loading-ui' || el.tagName === 'STYLE' || el.tagName === 'SCRIPT') return;
//                             el.style.setProperty('opacity', '0', 'important');
//                             el.style.setProperty('pointer-events', 'none', 'important');
//                             el.style.setProperty('z-index', '-9999', 'important');
//                         });
//                     }
//                 }, 1000);
//             }, ENABLE_STREAM_AUDIO).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         if (txt.includes('protected content') || txt.includes('232403')) return null;

//                         const videos = Array.from(document.querySelectorAll('video'));
//                         for (const v of videos) {
//                             if (!v.paused && v.readyState >= 2 && v.currentTime > 0) {
//                                 const frames = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : (v.webkitDecodedFrameCount || 0);
//                                 return { status: 'HEALTHY', currentTime: v.currentTime, frames };
//                             }
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);
//         // Pick the video with the highest decoded frame count so dummy/ad videos never cause a false freeze!
//         const healthyList = results.filter(r => r && r.status === 'HEALTHY');
//         if (healthyList.length > 0) {
//             healthyList.sort((a, b) => (b.frames || 0) - (a.frames || 0));
//             return healthyList[0];
//         }
//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     const targetUrl = urlList[currentUrlIndex];
//     console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//     try {
//         await page.goto('about:blank');
//         await page.bringToFront();
//         keepChromeOnTopAndHideOBS();
//         await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//         await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        
//         // --- WIDEVINE DRM CHECK ---
//         const widevineStatus = await page.evaluate(async () => {
//             try {
//                 await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
//                     initDataTypes: ['cenc'],
//                     videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
//                 }]);
//                 return 'OK';
//             } catch (e) { return String(e); }
//         });
//         console.log(`[🔐] Widevine DRM Status: ${widevineStatus}`);
//         // --------------------------

//         await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//         await lockAndPlayVideo(page);
//         await hideLoadingOverlay(page);
//         keepChromeOnTopAndHideOBS();
//     } catch (e) {
//         console.log(`[⚠️] Page navigation warning: ${e.message}`);
//     }
//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;
            
//             // 1. Check if video is perfectly frozen
//             const isStuck = (lastTime !== -1 && health.currentTime === lastTime && health.frames === lastFrames);

//             // 2. Check if video is looping (DVR Trap)
//             let isLooping = false;
//             if (lastTime !== -1 && health.currentTime < lastTime && (lastTime - health.currentTime > 3)) {
//                 isLooping = true;
//                 console.log(`[⚠️] DVR/Loop Trap Detected! Time jumped backwards from ${lastTime.toFixed(1)}s to ${health.currentTime.toFixed(1)}s`);
//             }

//             if (isStuck || isLooping) {
//                 if (isLooping || (Date.now() - freezeStart > 18000)) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl(isLooping ? 'VIDEO LOOPING (FAILOVER)' : 'VIDEO FROZEN (18s)');
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED 9-MIN REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/12`);
//             // Gently force video.play() across all frames without re-clicking the player UI
//             for (const frame of page.frames()) {
//                 if (!frame.isDetached()) {
//                     await frame.evaluate(() => {
//                         document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                     }).catch(() => {});
//                 }
//             }
//             if (deadStrikes >= 12) {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('12 STRIKES -> FAILOVER NEXT URL');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 90 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     // Restored OBS Console Logs so you can verify RTMP streaming in GitHub Actions
//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     // 1. Pre-seed Chrome Profile with Widevine CDM so Linux Chrome enables DRM on First Boot
//     const userDataDir = path.join(os.tmpdir(), 'chrome-drm-profile');
//     const widevineHintDir = path.join(userDataDir, 'WidevineCdm');
//     const defaultProfileDir = path.join(userDataDir, 'Default');
//     fs.mkdirSync(widevineHintDir, { recursive: true });
//     fs.mkdirSync(defaultProfileDir, { recursive: true });

//     const systemWidevinePaths = [
//         '/opt/google/chrome/WidevineCdm',
//         '/usr/lib/chromium/WidevineCdm',
//         '/usr/lib/chromium-browser/WidevineCdm'
//     ];
//     const activeWidevinePath = systemWidevinePaths.find(p => fs.existsSync(p)) || '/opt/google/chrome/WidevineCdm';

//     fs.writeFileSync(
//         path.join(widevineHintDir, 'latest-component-updated-widevine-cdm'),
//         JSON.stringify({ Path: activeWidevinePath })
//     );
//     fs.writeFileSync(
//         path.join(defaultProfileDir, 'Preferences'),
//         JSON.stringify({
//             profile: { content_settings: { exceptions: { protected_media_identifier: { '*': { setting: 1 } } } } },
//             webkit: { webprefs: { encrypted_media_enabled: true } }
//         })
//     );

//     const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled',
//         '--enable-widevine',
//         '--enable-features=EncryptedMedia,Widevine',
//         '--disable-features=PermissionsPolicyHeader,WebRtcHideLocalIpsWithMdns,DisableLoadExtensionCommandLineSwitch',
//         '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
//         '--enforce-webrtc-ip-permission-check'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     // Load uBlock WITHOUT --disable-extensions-except (which kills Chrome's internal Widevine component)
//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded (DRM-Safe Mode)!');
//     }

//     const chromePaths = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
//     const executablePath = chromePaths.find(p => fs.existsSync(p));
//     if (executablePath) console.log(`[🌐] Launching Official Chrome with Widevine DRM (${activeWidevinePath})`);

//     browser = await puppeteer.launch({
//         headless: false,
//         executablePath: executablePath || undefined,
//         userDataDir: userDataDir,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: [
//             '--enable-automation',
//             '--disable-extensions',
//             '--disable-component-update',
//             '--disable-component-extensions-with-background-pages',
//             '--disable-default-apps'
//         ],
//         args
//     });

//     page = (await browser.pages())[0];

//    browser.on('targetcreated', async (target) => {
//         const tType = target.type();
//         if (tType === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 150);
//             }
//         } else if (tType === 'other' || tType === 'iframe') {
//             // Apply CDP Ad-Blocker to every nested cross-origin player iframe!
//             await attachCdpAdBlocker(target);
//         }
//     });

//     keepChromeOnTopAndHideOBS();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// // =========================================================================================
// // ⏱️ SMART DURATION & 6-HOUR HANDOVER TIMER (Supports 3h, 180m, 24/7)
// // =========================================================================================
// const rawDuration = (process.env.CUSTOM_DURATION || '24/7').trim().toLowerCase();
// const MAX_RUNNER_MS = 21000000; // 5 hours 50 minutes (350 mins)
// let totalDurationMs = Infinity;

// if (rawDuration !== '24/7' && rawDuration !== 'none' && rawDuration !== '') {
//     const hMatch = rawDuration.match(/(\d+(\.\d+)?)\s*h/);
//     const mMatch = rawDuration.match(/(\d+)\s*m/);
//     if (hMatch) {
//         totalDurationMs = Math.round(parseFloat(hMatch[1]) * 3600 * 1000);
//     } else if (mMatch) {
//         totalDurationMs = parseInt(mMatch[1], 10) * 60 * 1000;
//     } else if (!isNaN(rawDuration)) {
//         totalDurationMs = parseFloat(rawDuration) * 60 * 1000;
//     }
// }

// if (totalDurationMs <= MAX_RUNNER_MS) {
//     console.log(`[⏱️] Stream Duration Set: ${rawDuration} (${Math.round(totalDurationMs / 60000)} mins). Will auto-stop when finished.`);
//     setTimeout(async () => {
//         console.log(`\n[🛑] Scheduled Duration (${rawDuration}) Completed! Stopping stream cleanly...`);
//         await cleanup();
//         process.exit(0);
//     }, totalDurationMs);
// } else {
//     console.log(`[⏱️] Long/24x7 Stream Mode (${rawDuration}). Will handover after 5h 50m.`);
//     setTimeout(() => {
//         try {
//             let nextDuration = '24/7';
//             if (totalDurationMs !== Infinity) {
//                 const remMins = Math.max(1, Math.round((totalDurationMs - MAX_RUNNER_MS) / 60000));
//                 nextDuration = `${remMins}m`;
//             }
//             const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}" -f custom_duration="${nextDuration}"`;
//             execSync(cmd, { stdio: 'inherit' });
//             setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//         } catch (e) {}
//     }, MAX_RUNNER_MS);
// }

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();














































































































// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (Fixed: Script 2 SimpleOutput + streamEncoder.json for Zero CPU Hang)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     const iniConfig = `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`;
//     // Write to BOTH global.ini and user.ini (Required for OBS 31/32+ to block Auto-Configuration Wizard)
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), iniConfig);
//     fs.writeFileSync(path.join(obsDir, 'user.ini'), iniConfig);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     // FIXED: Using Script 2's proven Mode=Simple with rc-lookahead=0 & threads=4 so OBS never overloads CPU
//     const basicIniContent = `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Simple\n[SimpleOutput]\nVBitrate=${BITRATE}\nStreamEncoder=x264\nx264Preset=ultrafast\nx264Settings=keyint=60 tune=zerolatency profile=main threads=4 rc-lookahead=0\n`;
//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), basicIniContent);

//     // Also write streamEncoder.json as a fallback in case OBS switches to Advanced
//     fs.writeFileSync(path.join(profilesDir, 'streamEncoder.json'), JSON.stringify({
//         bitrate: BITRATE,
//         keyint_sec: 2,
//         preset: "ultrafast",
//         profile: "main",
//         tune: "zerolatency",
//         x264opts: "threads=4 rc-lookahead=0"
//     }, null, 2));

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW ONCE (Removed destructive 2s xdotool windowsize loop)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }
// const hideOBSAndFocusChromeOnce = keepChromeOnTopAndHideOBS;
// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI (DRM-Safe CDP + Windows 11 Anti-Detect Spoof)
// // =========================================================================================
// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI (DRM-Safe Interception + Windows 11 Anti-Detect Spoof)
// // =========================================================================================
// const AD_BLOCK_PATTERNS = [
//     '*popads*', '*popcash*', '*exoclick*', '*exosrv*', '*magsrv*', '*realsrv*', '*adsterra*', '*onclickads*',
//     '*doubleclick*', '*googlesyndication*', '*adexchangerapid*', '*bet365*', '*1xbet*',
//     '*propellerads*', '*hilltopads*', '*trafficjunky*', '*trafficstars*', '*tsyndicate*', '*juicyads*', '*clickadu*',
//     '*adcash*', '*galaksion*', '*bidvertiser*', '*revcontent*', '*mgid*',
//     '*taboola*', '*outbrain*', '*acscdn*', '*wpadmngr*', '*onclckmn*', '*clickaine*', '*histats*', '*usrpubtrk*',
//     '*clarity.ms*', '*yandex.ru/metrika*', '*adsco.re*', '*a-ads.com*', '*bidgear*',
//     '*stripchat*', '*strpst*', '*doppiocdn*', '*bcvcdn*', '*xlirdr*', '*adtng*',
//     '*chaturbate*', '*bongacams*', '*cam4*', '*xhamster*', '*livejasmin*'
// ];

// async function attachCdpAdBlocker(target) {
//     try {
//         const client = await target.createCDPSession();
//         await client.send('Network.enable');
//         await client.send('Network.setBlockedURLs', { urls: AD_BLOCK_PATTERNS });
//     } catch (e) {}
// }

// async function setupPageProtections(p) {
//     try {
//         // 1. Native CDP Ad-Blocker (Zero Node.js lag, never interrupts .ts video chunks, works in iframes)
//         await attachCdpAdBlocker(p.target());

//         // 2. 403 Response Logger to track exact blocked requests
//         p.on('response', r => {
//             if (r.status() === 403) console.log('[⚠️] 403 Forbidden:', r.url());
//         });

//         await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;

//             Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
//             Object.defineProperty(navigator, 'webdriver', { get: () => false });
//             Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
//             Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

//             const getParameter = WebGLRenderingContext.prototype.getParameter;
//             WebGLRenderingContext.prototype.getParameter = function(param) {
//                 if (param === 37445) return 'Google Inc. (NVIDIA)';
//                 if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                 return getParameter.apply(this, arguments);
//             };
//             if (typeof WebGL2RenderingContext !== 'undefined') {
//                 const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
//                 WebGL2RenderingContext.prototype.getParameter = function(param) {
//                     if (param === 37445) return 'Google Inc. (NVIDIA)';
//                     if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                     return getParameter2.apply(this, arguments);
//                 };
//             }

//             const drmAllow = 'encrypted-media; autoplay; fullscreen';
//             const patchIframe = (el) => {
//                 if (el && el.tagName === 'IFRAME') {
//                     if (!el.allow || !el.allow.includes('encrypted-media')) {
//                         el.setAttribute('allow', drmAllow);
//                     }
//                 }
//             };
//             const obs = new MutationObserver((mutations) => {
//                 for (const m of mutations) {
//                     for (const node of m.addedNodes) {
//                         if (node.nodeType === 1) {
//                             patchIframe(node);
//                             if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(patchIframe);
//                         }
//                     }
//                 }
//             });
//             obs.observe(document, { childList: true, subtree: true });

//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             if (document.documentElement) document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await Promise.race([
//             p.evaluate((t, s) => {
//                 if (window.self !== window.top) return;
//                 let el = document.getElementById('bot-loading-ui');
//                 if (!el) {
//                     el = document.createElement('div');
//                     el.id = 'bot-loading-ui';
//                     el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                     document.documentElement.appendChild(el);
//                 }
//                 el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//             }, title, subtitle),
//             new Promise(r => setTimeout(r, 1500))
//         ]);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await Promise.race([
//             p.evaluate(() => {
//                 const el = document.getElementById('bot-loading-ui');
//                 if (el) el.remove();
//             }),
//             new Promise(r => setTimeout(r, 1500))
//         ]);
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Script 2 Safe Lock + Script 1 403 Switcher)
// // =========================================================================================
// let currentPlayerTab = 0;

// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames + Instant Switch on "Protected Content" (403)
//         for (let attempt = 0; attempt < 10; attempt++) {
//             let hasProtectedError = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const errFound = await Promise.race([
//                         frame.evaluate(() => {
//                             const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                             return txt.includes('protected content') || txt.includes('232403') || txt.includes('cannot be played') || txt.includes('error code');
//                         }),
//                         new Promise(r => setTimeout(() => r(false), 1200))
//                     ]);
//                     if (errFound) { hasProtectedError = true; break; }
//                 } catch (e) {}
//             }

//             if (hasProtectedError) {
//                 console.log(`[⚡] Protected Content (403) Detected -> Skipping immediately to Next URL!`);
//                 return false; // Stop checking this page and trigger Next URL failover
//             }

//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await Promise.race([
//                         frame.evaluate((audioEnabled) => {
//                             let isPlaying = false;
//                             const videos = document.querySelectorAll('video');

//                             videos.forEach(v => {
//                                 v.muted = !audioEnabled;
//                                 v.volume = audioEnabled ? 1.0 : 0.0;
//                                 if (v.paused) {
//                                     v.play().catch(() => {});
//                                 }
//                                 if (!v.paused && v.readyState >= 2 && v.currentTime > 0) {
//                                     isPlaying = true;
//                                 }
//                             });

//                             if (!isPlaying) {
//                                 const playSelectors = '.jw-display-icon-display, button[data-plyr="play"], .vjs-big-play-button, .player-poster[class*="clickable"]';
//                                 document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });
//                             }

//                             if (audioEnabled) {
//                                 document.querySelectorAll('[class*="unmute"], .jw-icon-volume, .vjs-vol-muted').forEach(el => {
//                                     const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
//                                     if (txt.includes('unmute') || el.className.includes('unmute') || el.className.includes('jw-off') || el.className.includes('vjs-vol-muted')) {
//                                         try { el.click(); } catch(e){}
//                                     }
//                                 });
//                             }

//                             return isPlaying;
//                         }, ENABLE_STREAM_AUDIO),
//                         new Promise(r => setTimeout(() => r(false), 1200))
//                     ]);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // FIXED: Script 2's Clean Fullscreen Lock (No 'body *' display:none loop that breaks player internals)
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await Promise.race([
//                 frame.evaluate((audioEnabled) => {
//                     if (window.__frameLockActive) return;
//                     window.__frameLockActive = true;

//                     const style = document.createElement('style');
//                     style.innerHTML = `
//                         html, body { background-color: #000 !important; overflow: hidden !important; }
//                         .jw-controls, .jw-ui, .plyr__controls, .vjs-control-bar, [data-player] .controls, .chat, #chat, header, footer, .sidebar, .banner, .ads {
//                             display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;
//                         }
//                     `;
//                     if (document.head) document.head.appendChild(style);

//                     setInterval(() => {
//                         try {
//                             const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                             if (txt.includes('protected content') || txt.includes('232403')) return;

//                             const videos = Array.from(document.querySelectorAll('video'));
//                             let realVideo = videos.find(v => v.clientWidth > 100 && v.clientHeight > 100) || videos[0];

//                             if (realVideo && (realVideo.clientWidth > 50 || !realVideo.paused)) {
//                                 if (realVideo.paused) realVideo.play().catch(() => {});
//                                 document.querySelectorAll('video, audio').forEach(m => {
//                                     m.muted = !audioEnabled;
//                                     m.volume = audioEnabled ? 1.0 : 0.0;
//                                 });

//                                 const playerWrap = realVideo.closest('.jwplayer, #player, .plyr, .vjs-player, .shaka-video-container, [data-player], .player-poster') || realVideo;
//                                 playerWrap.style.setProperty('position', 'fixed', 'important');
//                                 playerWrap.style.setProperty('top', '0px', 'important');
//                                 playerWrap.style.setProperty('left', '0px', 'important');
//                                 playerWrap.style.setProperty('width', '100vw', 'important');
//                                 playerWrap.style.setProperty('height', '100vh', 'important');
//                                 playerWrap.style.setProperty('z-index', '2147483646', 'important');
//                                 playerWrap.style.setProperty('background-color', 'black', 'important');
//                                 playerWrap.style.setProperty('opacity', '1', 'important');
//                                 playerWrap.style.setProperty('visibility', 'visible', 'important');
//                                 playerWrap.style.setProperty('display', 'block', 'important');
//                                 if (playerWrap !== realVideo) {
//                                     realVideo.style.setProperty('width', '100%', 'important');
//                                     realVideo.style.setProperty('height', '100%', 'important');
//                                 }
//                                 realVideo.style.setProperty('object-fit', 'contain', 'important');
//                                 return;
//                             }

//                             const iframes = Array.from(document.querySelectorAll('iframe'));
//                             let mainIframe = null, maxScore = -1;
//                             iframes.forEach(ifr => {
//                                 const src = (ifr.src || '').toLowerCase();
//                                 if (/popads|exoclick|adsterra|doubleclick|bet365|1xbet|juicyads|clickadu|propeller/i.test(src)) {
//                                     ifr.remove();
//                                     return;
//                                 }
//                                 const w = ifr.clientWidth, h = ifr.clientHeight, area = w * h;
//                                 if (area < 5000 || h > w) return;
//                                 let score = area;
//                                 if (ifr.hasAttribute('allowfullscreen') || ifr.hasAttribute('webkitallowfullscreen')) score += 10000000;
//                                 if (score > maxScore) { maxScore = score; mainIframe = ifr; }
//                             });

//                             if (mainIframe) {
//                                 iframes.forEach(ifr => {
//                                     if (ifr !== mainIframe) {
//                                         ifr.style.setProperty('display', 'none', 'important');
//                                         ifr.style.setProperty('opacity', '0', 'important');
//                                     }
//                                 });
//                                 mainIframe.style.setProperty('position', 'fixed', 'important');
//                                 mainIframe.style.setProperty('top', '0px', 'important');
//                                 mainIframe.style.setProperty('left', '0px', 'important');
//                                 mainIframe.style.setProperty('width', '100vw', 'important');
//                                 mainIframe.style.setProperty('height', '100vh', 'important');
//                                 mainIframe.style.setProperty('z-index', '2147483647', 'important');
//                                 mainIframe.style.setProperty('background-color', 'black', 'important');
//                                 mainIframe.style.setProperty('border', 'none', 'important');
//                                 mainIframe.style.setProperty('opacity', '1', 'important');
//                                 mainIframe.style.setProperty('display', 'block', 'important');
//                                 mainIframe.style.setProperty('visibility', 'visible', 'important');
//                             }
//                         } catch (err) {}
//                     }, 500);
//                 }, ENABLE_STREAM_AUDIO),
//                 new Promise(r => setTimeout(r, 1500))
//             ]).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG (Fixed: Detects Screen-Only Freeze + Buffer Stall + Logs Every Hang)
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         if (txt.includes('protected content') || txt.includes('232403') || txt.includes('stream error') || txt.includes('stream unavailable')) {
//                             return { status: 'CRITICAL_ERROR' };
//                         }

//                         const videos = Array.from(document.querySelectorAll('video'));
//                         let targetV = null;
//                         for (const v of videos) {
//                             if (v.clientWidth > 0 && v.clientWidth < 100) continue;
//                             if ((v.src && v.src.startsWith('blob:')) || v.matches('.jw-video, .plyr__video, .vjs-tech')) {
//                                 targetV = v;
//                                 break;
//                             }
//                         }
//                         if (!targetV && videos.length > 0) {
//                             targetV = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
//                         }

//                         if (targetV && !targetV.ended && targetV.currentTime > 0) {
//                             let frames = 0;
//                             if (targetV.getVideoPlaybackQuality) frames = targetV.getVideoPlaybackQuality().totalVideoFrames || 0;
//                             else if (targetV.webkitDecodedFrameCount !== undefined) frames = targetV.webkitDecodedFrameCount || 0;
//                             return {
//                                 status: 'HEALTHY',
//                                 currentTime: Number(targetV.currentTime || 0),
//                                 frames: frames,
//                                 paused: !!targetV.paused,
//                                 readyState: targetV.readyState
//                             };
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);

//         if (results.some(r => r && r.status === 'CRITICAL_ERROR')) {
//             return { status: 'CRITICAL_ERROR' };
//         }

//         const healthyList = results.filter(r => r && r.status === 'HEALTHY');
//         if (healthyList.length > 0) {
//             healthyList.sort((a, b) => (b.frames || 0) - (a.frames || 0));
//             return healthyList[0];
//         }
//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     for (let urlAttempt = 0; urlAttempt < urlList.length; urlAttempt++) {
//         const targetUrl = urlList[currentUrlIndex];
//         console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//         try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//         let lockSuccess = true;
//         try {
//             await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
//             await page.bringToFront().catch(() => {});
//             keepChromeOnTopAndHideOBS();
//             await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//             await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            
//             // --- WIDEVINE DRM CHECK ---
//             const widevineStatus = await page.evaluate(async () => {
//                 try {
//                     await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
//                         initDataTypes: ['cenc'],
//                         videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
//                     }]);
//                     return 'OK';
//                 } catch (e) { return String(e); }
//             });
//             console.log(`[🔐] Widevine DRM Status: ${widevineStatus}`);
//             // --------------------------

//             await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//             lockSuccess = await lockAndPlayVideo(page);
//             if (lockSuccess !== false) {
//                 await hideLoadingOverlay(page);
//             }
//             keepChromeOnTopAndHideOBS();
//         } catch (e) {
//             console.log(`[⚠️] Page navigation warning: ${e.message}`);
//         }

//         // Agar 403 Protected Content aaye toh foran Next URL load karein
//         if (lockSuccess === false && urlList.length > 1) {
//             currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//             reason = '403 PROTECTED CONTENT -> NEXT URL';
//             continue;
//         }

//         try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
//         break;
//     }
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;

//             const isTimeStuck = (lastTime !== -1 && Math.abs(health.currentTime - lastTime) < 0.02);
//             const isFrameStuck = (lastFrames > 0 && health.frames > 0 && health.frames === lastFrames);
//             const isStuck = isTimeStuck || isFrameStuck;

//             // Check if video is looping (DVR Trap)
//             let isLooping = false;
//             if (lastTime !== -1 && health.currentTime < lastTime && (lastTime - health.currentTime > 3)) {
//                 isLooping = true;
//                 console.log(`[⚠️] DVR/Loop Trap Detected! Time jumped backwards from ${lastTime.toFixed(1)}s to ${health.currentTime.toFixed(1)}s`);
//             }

//             if (isStuck || isLooping) {
//                 const stuckMs = Date.now() - freezeStart;
//                 const freezeType = isFrameStuck && !isTimeStuck ? 'SCREEN FROZEN (AUDIO RUNNING)' : 'AUDIO & VIDEO STUCK';
//                 console.log(`[⚠️] HANG DETECTED [${freezeType}] -> Frozen ${(stuckMs / 1000).toFixed(0)}s / 14s | Time: ${health.currentTime.toFixed(1)}s | Frames: ${health.frames}`);

//                 // At 6s of real freeze, force pause->play cycle & live-edge jump to unstick stalled MSE buffer
//                 if (!isLooping && stuckMs >= 6000 && stuckMs < 8500) {
//                     for (const frame of page.frames()) {
//                         if (!frame.isDetached()) {
//                             await Promise.race([
//                                 frame.evaluate(() => {
//                                     document.querySelectorAll('video').forEach(v => {
//                                         try {
//                                             if (v.buffered && v.buffered.length > 0) {
//                                                 const end = v.buffered.end(v.buffered.length - 1);
//                                                 if (end - v.currentTime > 2) v.currentTime = end - 0.5;
//                                             }
//                                             v.pause();
//                                             setTimeout(() => v.play().catch(() => {}), 150);
//                                         } catch (e) {}
//                                     });
//                                 }),
//                                 new Promise(r => setTimeout(r, 800))
//                             ]).catch(() => {});
//                         }
//                     }
//                 }

//                 if (isLooping || stuckMs > 14000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl(isLooping ? 'VIDEO LOOPING (FAILOVER)' : `${freezeType} (14s)`);
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/10`);
//             for (const frame of page.frames()) {
//                 if (!frame.isDetached()) {
//                     await Promise.race([
//                         frame.evaluate(() => {
//                             document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                         }),
//                         new Promise(r => setTimeout(r, 800))
//                     ]).catch(() => {});
//                 }
//             }
//             if (deadStrikes >= 10 || health.status === 'CRITICAL_ERROR') {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl(`${health.status} -> FAILOVER NEXT URL`);
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 30 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     // Pre-seed Chrome Profile with Widevine CDM so Linux Chrome enables DRM on First Boot
//     const userDataDir = path.join(os.tmpdir(), 'chrome-drm-profile');
//     const widevineHintDir = path.join(userDataDir, 'WidevineCdm');
//     const defaultProfileDir = path.join(userDataDir, 'Default');
//     fs.mkdirSync(widevineHintDir, { recursive: true });
//     fs.mkdirSync(defaultProfileDir, { recursive: true });

//     const systemWidevinePaths = [
//         '/opt/google/chrome/WidevineCdm',
//         '/usr/lib/chromium/WidevineCdm',
//         '/usr/lib/chromium-browser/WidevineCdm'
//     ];
//     const activeWidevinePath = systemWidevinePaths.find(p => fs.existsSync(p)) || '/opt/google/chrome/WidevineCdm';

//     fs.writeFileSync(
//         path.join(widevineHintDir, 'latest-component-updated-widevine-cdm'),
//         JSON.stringify({ Path: activeWidevinePath })
//     );
//     fs.writeFileSync(
//         path.join(defaultProfileDir, 'Preferences'),
//         JSON.stringify({
//             profile: { content_settings: { exceptions: { protected_media_identifier: { '*': { setting: 1 } } } } },
//             webkit: { webprefs: { encrypted_media_enabled: true } }
//         })
//     );

//     // FIXED: Added Script 2's exact Xvfb/Linux video rendering & anti-occlusion flags alongside Script 1's Widevine flags
//    const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled',
//         '--disable-background-timer-throttling',
//         '--disable-backgrounding-occluded-windows',
//         '--disable-renderer-backgrounding',
//         '--enable-widevine',
//         '--enable-features=EncryptedMedia,Widevine',
//         '--disable-features=PermissionsPolicyHeader,WebRtcHideLocalIpsWithMdns,DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion',
//         '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
//         '--enforce-webrtc-ip-permission-check'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded (DRM-Safe Mode)!');
//     }

//     const chromePaths = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
//     const executablePath = chromePaths.find(p => fs.existsSync(p));
//     if (executablePath) console.log(`[🌐] Launching Official Chrome with Widevine DRM (${activeWidevinePath})`);

//     browser = await puppeteer.launch({
//         headless: false,
//         executablePath: executablePath || undefined,
//         userDataDir: userDataDir,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: [
//             '--enable-automation',
//             '--disable-extensions',
//             '--disable-component-update',
//             '--disable-component-extensions-with-background-pages',
//             '--disable-default-apps'
//         ],
//         args
//     });

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         const tType = target.type();
//         if (tType === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 150);
//             }
//         } else if (tType === 'other' || tType === 'iframe') {
//             await attachCdpAdBlocker(target);
//         }
//     });

//     hideOBSAndFocusChromeOnce();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// // =========================================================================================
// // ⏱️ SMART DURATION & 6-HOUR HANDOVER TIMER (Supports 3h, 180m, 24/7)
// // =========================================================================================
// const rawDuration = (process.env.CUSTOM_DURATION || '24/7').trim().toLowerCase();
// const MAX_RUNNER_MS = 21000000; // 5 hours 50 minutes (350 mins)
// let totalDurationMs = Infinity;

// if (rawDuration !== '24/7' && rawDuration !== 'none' && rawDuration !== '') {
//     const hMatch = rawDuration.match(/(\d+(\.\d+)?)\s*h/);
//     const mMatch = rawDuration.match(/(\d+)\s*m/);
//     if (hMatch) {
//         totalDurationMs = Math.round(parseFloat(hMatch[1]) * 3600 * 1000);
//     } else if (mMatch) {
//         totalDurationMs = parseInt(mMatch[1], 10) * 60 * 1000;
//     } else if (!isNaN(rawDuration)) {
//         totalDurationMs = parseFloat(rawDuration) * 60 * 1000;
//     }
// }

// if (totalDurationMs <= MAX_RUNNER_MS) {
//     console.log(`[⏱️] Stream Duration Set: ${rawDuration} (${Math.round(totalDurationMs / 60000)} mins). Will auto-stop when finished.`);
//     setTimeout(async () => {
//         console.log(`\n[🛑] Scheduled Duration (${rawDuration}) Completed! Stopping stream cleanly...`);
//         await cleanup();
//         process.exit(0);
//     }, totalDurationMs);
// } else {
//     console.log(`[⏱️] Long/24x7 Stream Mode (${rawDuration}). Will handover after 5h 50m.`);
//     setTimeout(() => {
//         try {
//             let nextDuration = '24/7';
//             if (totalDurationMs !== Infinity) {
//                 const remMins = Math.max(1, Math.round((totalDurationMs - MAX_RUNNER_MS) / 60000));
//                 nextDuration = `${remMins}m`;
//             }
//             const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}" -f custom_duration="${nextDuration}"`;
//             execSync(cmd, { stdio: 'inherit' });
//             setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//         } catch (e) {}
//     }, MAX_RUNNER_MS);
// }

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();


















// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (Fixed: Script 2 SimpleOutput + streamEncoder.json for Zero CPU Hang)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     const iniConfig = `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`;
//     // Write to BOTH global.ini and user.ini (Required for OBS 31/32+ to block Auto-Configuration Wizard)
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), iniConfig);
//     fs.writeFileSync(path.join(obsDir, 'user.ini'), iniConfig);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     // FIXED: Using Script 2's proven Mode=Simple with rc-lookahead=0 & threads=4 so OBS never overloads CPU
//     const basicIniContent = `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Simple\n[SimpleOutput]\nVBitrate=${BITRATE}\nStreamEncoder=x264\nx264Preset=ultrafast\nx264Settings=keyint=60 tune=zerolatency profile=main threads=4 rc-lookahead=0\n`;
//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), basicIniContent);

//     // Also write streamEncoder.json as a fallback in case OBS switches to Advanced
//     fs.writeFileSync(path.join(profilesDir, 'streamEncoder.json'), JSON.stringify({
//         bitrate: BITRATE,
//         keyint_sec: 2,
//         preset: "ultrafast",
//         profile: "main",
//         tune: "zerolatency",
//         x264opts: "threads=4 rc-lookahead=0"
//     }, null, 2));

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW ONCE (Removed destructive 2s xdotool windowsize loop)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }
// const hideOBSAndFocusChromeOnce = keepChromeOnTopAndHideOBS;
// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI (DRM-Safe CDP + Windows 11 Anti-Detect Spoof)
// // =========================================================================================
// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI (DRM-Safe Interception + Windows 11 Anti-Detect Spoof)
// // =========================================================================================
// const AD_BLOCK_PATTERNS = [
//     '*popads*', '*popcash*', '*exoclick*', '*exosrv*', '*magsrv*', '*realsrv*', '*adsterra*', '*onclickads*',
//     '*doubleclick*', '*googlesyndication*', '*adexchangerapid*', '*bet365*', '*1xbet*',
//     '*propellerads*', '*hilltopads*', '*trafficjunky*', '*trafficstars*', '*tsyndicate*', '*juicyads*', '*clickadu*',
//     '*adcash*', '*galaksion*', '*bidvertiser*', '*revcontent*', '*mgid*',
//     '*taboola*', '*outbrain*', '*acscdn*', '*wpadmngr*', '*onclckmn*', '*clickaine*', '*histats*', '*usrpubtrk*',
//     '*clarity.ms*', '*yandex.ru/metrika*', '*adsco.re*', '*a-ads.com*', '*bidgear*',
//     '*stripchat*', '*strpst*', '*doppiocdn*', '*bcvcdn*', '*xlirdr*', '*adtng*',
//     '*chaturbate*', '*bongacams*', '*cam4*', '*xhamster*', '*livejasmin*'
// ];

// async function attachCdpAdBlocker(target) {
//     try {
//         const client = await target.createCDPSession();
//         await client.send('Network.enable');
//         await client.send('Network.setBlockedURLs', { urls: AD_BLOCK_PATTERNS });
//     } catch (e) {}
// }

// async function setupPageProtections(p) {
//     try {
//         // 1. Native C++ CDP Ad-Blocker (Zero CPU lag, works in iframes, never touches DRM/HLS headers)
//         await attachCdpAdBlocker(p.target());

//         // 2. Passive 403 Response Logger (Zero lag)
//         p.on('response', r => {
//             if (r.status() === 403) console.log('[⚠️] 403 Forbidden:', r.url());
//         });

//         await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;

//             Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
//             Object.defineProperty(navigator, 'webdriver', { get: () => false });
//             Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
//             Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

//             const getParameter = WebGLRenderingContext.prototype.getParameter;
//             WebGLRenderingContext.prototype.getParameter = function(param) {
//                 if (param === 37445) return 'Google Inc. (NVIDIA)';
//                 if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                 return getParameter.apply(this, arguments);
//             };
//             if (typeof WebGL2RenderingContext !== 'undefined') {
//                 const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
//                 WebGL2RenderingContext.prototype.getParameter = function(param) {
//                     if (param === 37445) return 'Google Inc. (NVIDIA)';
//                     if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                     return getParameter2.apply(this, arguments);
//                 };
//             }

//             const drmAllow = 'encrypted-media; autoplay; fullscreen';
//             const patchIframe = (el) => {
//                 if (el && el.tagName === 'IFRAME') {
//                     if (!el.allow || !el.allow.includes('encrypted-media')) {
//                         el.setAttribute('allow', drmAllow);
//                     }
//                 }
//             };
//             const obs = new MutationObserver((mutations) => {
//                 for (const m of mutations) {
//                     for (const node of m.addedNodes) {
//                         if (node.nodeType === 1) {
//                             patchIframe(node);
//                             if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(patchIframe);
//                         }
//                     }
//                 }
//             });
//             obs.observe(document, { childList: true, subtree: true });

//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             if (document.documentElement) document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await Promise.race([
//             p.evaluate((t, s) => {
//                 if (window.self !== window.top) return;
//                 let el = document.getElementById('bot-loading-ui');
//                 if (!el) {
//                     el = document.createElement('div');
//                     el.id = 'bot-loading-ui';
//                     el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                     document.documentElement.appendChild(el);
//                 }
//                 el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//             }, title, subtitle),
//             new Promise(r => setTimeout(r, 1500))
//         ]);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await Promise.race([
//             p.evaluate(() => {
//                 const el = document.getElementById('bot-loading-ui');
//                 if (el) el.remove();
//             }),
//             new Promise(r => setTimeout(r, 1500))
//         ]);
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Script 2 Safe Lock + Script 1 403 Switcher)
// // =========================================================================================
// let currentPlayerTab = 0;

// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames + Instant Switch on "Protected Content" (403)
//         for (let attempt = 0; attempt < 10; attempt++) {
//             let hasProtectedError = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const errFound = await Promise.race([
//                         frame.evaluate(() => {
//                             const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                             return txt.includes('protected content') || txt.includes('232403') || txt.includes('cannot be played') || txt.includes('error code');
//                         }),
//                         new Promise(r => setTimeout(() => r(false), 1200))
//                     ]);
//                     if (errFound) { hasProtectedError = true; break; }
//                 } catch (e) {}
//             }

//             if (hasProtectedError) {
//                 console.log(`[⚡] Protected Content (403) Detected -> Skipping immediately to Next URL!`);
//                 return false; // Stop checking this page and trigger Next URL failover
//             }

//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await Promise.race([
//                         frame.evaluate((audioEnabled) => {
//                             let isPlaying = false;
//                             const videos = document.querySelectorAll('video');

//                             videos.forEach(v => {
//                                 v.muted = !audioEnabled;
//                                 v.volume = audioEnabled ? 1.0 : 0.0;
//                                 if (v.paused) {
//                                     v.play().catch(() => {});
//                                 }
//                                 if (!v.paused && v.readyState >= 2 && v.currentTime > 0) {
//                                     isPlaying = true;
//                                 }
//                             });

//                             if (!isPlaying) {
//                                 const playSelectors = '.jw-display-icon-display, button[data-plyr="play"], .vjs-big-play-button, .player-poster[class*="clickable"]';
//                                 document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });
//                             }

//                             if (audioEnabled) {
//                                 document.querySelectorAll('[class*="unmute"], .jw-icon-volume, .vjs-vol-muted').forEach(el => {
//                                     const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
//                                     if (txt.includes('unmute') || el.className.includes('unmute') || el.className.includes('jw-off') || el.className.includes('vjs-vol-muted')) {
//                                         try { el.click(); } catch(e){}
//                                     }
//                                 });
//                             }

//                             return isPlaying;
//                         }, ENABLE_STREAM_AUDIO),
//                         new Promise(r => setTimeout(() => r(false), 1200))
//                     ]);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // FIXED: Script 2's Clean Fullscreen Lock (No 'body *' display:none loop that breaks player internals)
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await Promise.race([
//                 frame.evaluate((audioEnabled) => {
//                     if (window.__frameLockActive) return;
//                     window.__frameLockActive = true;

//                     const style = document.createElement('style');
//                     style.innerHTML = `
//                         html, body { background-color: #000 !important; overflow: hidden !important; }
//                         .jw-controls, .jw-ui, .plyr__controls, .vjs-control-bar, [data-player] .controls, .chat, #chat, header, footer, .sidebar, .banner, .ads, [id*="ad" i], [class*="ad-" i] {
//                             display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;
//                         }
//                         /* Zero-CPU Ad Killer: Jab video/iframe lock ho jaye, toh body ke baaki tamam floating popups/widgets ko CSS se chupa dein */
//                         body[data-locked="true"] > *:not([data-stream-keep="true"]):not(#bot-loading-ui):not(script):not(style) {
//                             display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important; z-index: -999999 !important; width: 0 !important; height: 0 !important;
//                         }
//                     `;
//                     if (document.head) document.head.appendChild(style);

//                     // Sirf target element ke parent chain ko mark karta hai (sirf 3-5 elements, 0% CPU load)
//                     const markKeepChain = (targetEl) => {
//                         let curr = targetEl;
//                         while (curr && curr !== document.body && curr !== document.documentElement) {
//                             curr.setAttribute('data-stream-keep', 'true');
//                             curr = curr.parentElement;
//                         }
//                         if (document.body) document.body.setAttribute('data-locked', 'true');
//                     };

//                     setInterval(() => {
//                         try {
//                             const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                             if (txt.includes('protected content') || txt.includes('232403')) return;

//                             const videos = Array.from(document.querySelectorAll('video'));
//                             let realVideo = videos.find(v => v.clientWidth > 100 && v.clientHeight > 100) || videos[0];

//                             if (realVideo && (realVideo.clientWidth > 50 || !realVideo.paused)) {
//                                 if (realVideo.paused) realVideo.play().catch(() => {});
//                                 document.querySelectorAll('video, audio').forEach(m => {
//                                     m.muted = !audioEnabled;
//                                     m.volume = audioEnabled ? 1.0 : 0.0;
//                                 });

//                                 const playerWrap = realVideo.closest('.jwplayer, #player, .plyr, .vjs-player, .shaka-video-container, [data-player], .player-poster') || realVideo;
//                                 markKeepChain(playerWrap);

//                                 playerWrap.style.setProperty('position', 'fixed', 'important');
//                                 playerWrap.style.setProperty('top', '0px', 'important');
//                                 playerWrap.style.setProperty('left', '0px', 'important');
//                                 playerWrap.style.setProperty('width', '100vw', 'important');
//                                 playerWrap.style.setProperty('height', '100vh', 'important');
//                                 playerWrap.style.setProperty('z-index', '2147483647', 'important');
//                                 playerWrap.style.setProperty('background-color', 'black', 'important');
//                                 playerWrap.style.setProperty('opacity', '1', 'important');
//                                 playerWrap.style.setProperty('visibility', 'visible', 'important');
//                                 playerWrap.style.setProperty('display', 'block', 'important');
//                                 if (playerWrap !== realVideo) {
//                                     realVideo.style.setProperty('width', '100%', 'important');
//                                     realVideo.style.setProperty('height', '100%', 'important');
//                                 }
//                                 realVideo.style.setProperty('object-fit', 'contain', 'important');
//                                 return;
//                             }

//                             const iframes = Array.from(document.querySelectorAll('iframe'));
//                             let mainIframe = null, maxScore = -1;
//                             iframes.forEach(ifr => {
//                                 const src = (ifr.src || '').toLowerCase();
//                                 if (/popads|exoclick|exosrv|magsrv|realsrv|adsterra|doubleclick|bet365|1xbet|juicyads|clickadu|propeller|stripchat|strpst|doppiocdn|bcvcdn|xlirdr|tsyndicate|trafficstars/i.test(src)) {
//                                     ifr.remove();
//                                     return;
//                                 }
//                                 const w = ifr.clientWidth, h = ifr.clientHeight, area = w * h;
//                                 if (area < 5000 || h > w) return;
//                                 let score = area;
//                                 if (ifr.hasAttribute('allowfullscreen') || ifr.hasAttribute('webkitallowfullscreen')) score += 10000000;
//                                 if (score > maxScore) { maxScore = score; mainIframe = ifr; }
//                             });

//                             if (mainIframe) {
//                                 markKeepChain(mainIframe);
//                                 iframes.forEach(ifr => {
//                                     if (ifr !== mainIframe) {
//                                         ifr.style.setProperty('display', 'none', 'important');
//                                         ifr.style.setProperty('opacity', '0', 'important');
//                                     }
//                                 });
//                                 mainIframe.style.setProperty('position', 'fixed', 'important');
//                                 mainIframe.style.setProperty('top', '0px', 'important');
//                                 mainIframe.style.setProperty('left', '0px', 'important');
//                                 mainIframe.style.setProperty('width', '100vw', 'important');
//                                 mainIframe.style.setProperty('height', '100vh', 'important');
//                                 mainIframe.style.setProperty('z-index', '2147483647', 'important');
//                                 mainIframe.style.setProperty('background-color', 'black', 'important');
//                                 mainIframe.style.setProperty('border', 'none', 'important');
//                                 mainIframe.style.setProperty('opacity', '1', 'important');
//                                 mainIframe.style.setProperty('display', 'block', 'important');
//                                 mainIframe.style.setProperty('visibility', 'visible', 'important');
//                             }
//                         } catch (err) {}
//                     }, 500);
//                 }, ENABLE_STREAM_AUDIO),
//                 new Promise(r => setTimeout(r, 1500))
//             ]).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG (Fixed: Detects Screen-Only Freeze + Buffer Stall + Logs Every Hang)
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         if (txt.includes('protected content') || txt.includes('232403') || txt.includes('stream error') || txt.includes('stream unavailable')) {
//                             return { status: 'CRITICAL_ERROR' };
//                         }

//                         const videos = Array.from(document.querySelectorAll('video'));
//                         let targetV = null;
//                         for (const v of videos) {
//                             if (v.clientWidth > 0 && v.clientWidth < 100) continue;
//                             if ((v.src && v.src.startsWith('blob:')) || v.matches('.jw-video, .plyr__video, .vjs-tech')) {
//                                 targetV = v;
//                                 break;
//                             }
//                         }
//                         if (!targetV && videos.length > 0) {
//                             targetV = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
//                         }

//                         if (targetV && !targetV.ended && targetV.currentTime > 0) {
//                             let frames = 0;
//                             if (targetV.getVideoPlaybackQuality) frames = targetV.getVideoPlaybackQuality().totalVideoFrames || 0;
//                             else if (targetV.webkitDecodedFrameCount !== undefined) frames = targetV.webkitDecodedFrameCount || 0;
//                             return {
//                                 status: 'HEALTHY',
//                                 currentTime: Number(targetV.currentTime || 0),
//                                 frames: frames,
//                                 paused: !!targetV.paused,
//                                 readyState: targetV.readyState
//                             };
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);

//         if (results.some(r => r && r.status === 'CRITICAL_ERROR')) {
//             return { status: 'CRITICAL_ERROR' };
//         }

//         const healthyList = results.filter(r => r && r.status === 'HEALTHY');
//         if (healthyList.length > 0) {
//             healthyList.sort((a, b) => (b.frames || 0) - (a.frames || 0));
//             return healthyList[0];
//         }
//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     for (let urlAttempt = 0; urlAttempt < urlList.length; urlAttempt++) {
//         const targetUrl = urlList[currentUrlIndex];
//         console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//         try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//         let lockSuccess = true;
//         try {
//             await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
//             await page.bringToFront().catch(() => {});
//             keepChromeOnTopAndHideOBS();
//             await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//             await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            
//             // --- WIDEVINE DRM CHECK ---
//             const widevineStatus = await page.evaluate(async () => {
//                 try {
//                     await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
//                         initDataTypes: ['cenc'],
//                         videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
//                     }]);
//                     return 'OK';
//                 } catch (e) { return String(e); }
//             });
//             console.log(`[🔐] Widevine DRM Status: ${widevineStatus}`);
//             // --------------------------

//             await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//             lockSuccess = await lockAndPlayVideo(page);
//             if (lockSuccess !== false) {
//                 await hideLoadingOverlay(page);
//             }
//             keepChromeOnTopAndHideOBS();
//         } catch (e) {
//             console.log(`[⚠️] Page navigation warning: ${e.message}`);
//         }

//         // Agar 403 Protected Content aaye toh foran Next URL load karein
//         if (lockSuccess === false && urlList.length > 1) {
//             currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//             reason = '403 PROTECTED CONTENT -> NEXT URL';
//             continue;
//         }

//         try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
//         break;
//     }
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;

//             // FIXED: Use OR (||) instead of AND (&&) so Watchdog catches BOTH:
//             // 1. Audio + Video stopped (isTimeStuck)
//             // 2. Audio playing, but Video screen frozen (isFrameStuck)
//             const isTimeStuck = (lastTime !== -1 && Math.abs(health.currentTime - lastTime) < 0.02);
//             const isFrameStuck = (lastFrames > 0 && health.frames > 0 && health.frames === lastFrames);
//             const isStuck = isTimeStuck || isFrameStuck;

//             // Check if video is looping (DVR Trap)
//             let isLooping = false;
//             if (lastTime !== -1 && health.currentTime < lastTime && (lastTime - health.currentTime > 3)) {
//                 isLooping = true;
//                 console.log(`[⚠️] DVR/Loop Trap Detected! Time jumped backwards from ${lastTime.toFixed(1)}s to ${health.currentTime.toFixed(1)}s`);
//             }

//             if (isStuck || isLooping) {
//                 const stuckMs = Date.now() - freezeStart;
//                 const freezeType = isFrameStuck && !isTimeStuck ? 'SCREEN FROZEN (AUDIO RUNNING)' : 'AUDIO & VIDEO STUCK';
//                 console.log(`[⚠️] HANG DETECTED [${freezeType}] -> Frozen ${(stuckMs / 1000).toFixed(0)}s / 14s | Time: ${health.currentTime.toFixed(1)}s | Frames: ${health.frames}`);

//                 // Try a gentle play() nudge at 6s in case stream paused/stalled
//                 if (!isLooping && stuckMs >= 6000 && stuckMs < 8500) {
//                     for (const frame of page.frames()) {
//                         if (!frame.isDetached()) {
//                             await Promise.race([
//                                 frame.evaluate(() => {
//                                     document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                                 }),
//                                 new Promise(r => setTimeout(r, 800))
//                             ]).catch(() => {});
//                         }
//                     }
//                 }

//                 if (isLooping || stuckMs > 14000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl(isLooping ? 'VIDEO LOOPING (FAILOVER)' : `${freezeType} (14s)`);
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/10`);
//             for (const frame of page.frames()) {
//                 if (!frame.isDetached()) {
//                     await Promise.race([
//                         frame.evaluate(() => {
//                             document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                         }),
//                         new Promise(r => setTimeout(r, 800))
//                     ]).catch(() => {});
//                 }
//             }
//             if (deadStrikes >= 10 || health.status === 'CRITICAL_ERROR') {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl(`${health.status} -> FAILOVER NEXT URL`);
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 30 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     // Pre-seed Chrome Profile with Widevine CDM so Linux Chrome enables DRM on First Boot
//     const userDataDir = path.join(os.tmpdir(), 'chrome-drm-profile');
//     const widevineHintDir = path.join(userDataDir, 'WidevineCdm');
//     const defaultProfileDir = path.join(userDataDir, 'Default');
//     fs.mkdirSync(widevineHintDir, { recursive: true });
//     fs.mkdirSync(defaultProfileDir, { recursive: true });

//     const systemWidevinePaths = [
//         '/opt/google/chrome/WidevineCdm',
//         '/usr/lib/chromium/WidevineCdm',
//         '/usr/lib/chromium-browser/WidevineCdm'
//     ];
//     const activeWidevinePath = systemWidevinePaths.find(p => fs.existsSync(p)) || '/opt/google/chrome/WidevineCdm';

//     fs.writeFileSync(
//         path.join(widevineHintDir, 'latest-component-updated-widevine-cdm'),
//         JSON.stringify({ Path: activeWidevinePath })
//     );
//     fs.writeFileSync(
//         path.join(defaultProfileDir, 'Preferences'),
//         JSON.stringify({
//             profile: { content_settings: { exceptions: { protected_media_identifier: { '*': { setting: 1 } } } } },
//             webkit: { webprefs: { encrypted_media_enabled: true } }
//         })
//     );

//     // FIXED: Added Script 2's exact Xvfb/Linux video rendering & anti-occlusion flags alongside Script 1's Widevine flags
//    const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled',
//         '--disable-background-timer-throttling',
//         '--disable-backgrounding-occluded-windows',
//         '--disable-renderer-backgrounding',
//         '--enable-widevine',
//         '--enable-features=EncryptedMedia,Widevine',
//         '--disable-features=PermissionsPolicyHeader,WebRtcHideLocalIpsWithMdns,DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion',
//         '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
//         '--enforce-webrtc-ip-permission-check'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded (DRM-Safe Mode)!');
//     }

//     const chromePaths = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
//     const executablePath = chromePaths.find(p => fs.existsSync(p));
//     if (executablePath) console.log(`[🌐] Launching Official Chrome with Widevine DRM (${activeWidevinePath})`);

//     browser = await puppeteer.launch({
//         headless: false,
//         executablePath: executablePath || undefined,
//         userDataDir: userDataDir,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: [
//             '--enable-automation',
//             '--disable-extensions',
//             '--disable-component-update',
//             '--disable-component-extensions-with-background-pages',
//             '--disable-default-apps'
//         ],
//         args
//     });

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         const tType = target.type();
//         if (tType === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 150);
//             }
//         } else if (tType === 'other' || tType === 'iframe') {
//             await attachCdpAdBlocker(target);
//         }
//     });

//     hideOBSAndFocusChromeOnce();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// // =========================================================================================
// // ⏱️ SMART DURATION & 6-HOUR HANDOVER TIMER (Supports 3h, 180m, 24/7)
// // =========================================================================================
// const rawDuration = (process.env.CUSTOM_DURATION || '24/7').trim().toLowerCase();
// const MAX_RUNNER_MS = 21000000; // 5 hours 50 minutes (350 mins)
// let totalDurationMs = Infinity;

// if (rawDuration !== '24/7' && rawDuration !== 'none' && rawDuration !== '') {
//     const hMatch = rawDuration.match(/(\d+(\.\d+)?)\s*h/);
//     const mMatch = rawDuration.match(/(\d+)\s*m/);
//     if (hMatch) {
//         totalDurationMs = Math.round(parseFloat(hMatch[1]) * 3600 * 1000);
//     } else if (mMatch) {
//         totalDurationMs = parseInt(mMatch[1], 10) * 60 * 1000;
//     } else if (!isNaN(rawDuration)) {
//         totalDurationMs = parseFloat(rawDuration) * 60 * 1000;
//     }
// }

// if (totalDurationMs <= MAX_RUNNER_MS) {
//     console.log(`[⏱️] Stream Duration Set: ${rawDuration} (${Math.round(totalDurationMs / 60000)} mins). Will auto-stop when finished.`);
//     setTimeout(async () => {
//         console.log(`\n[🛑] Scheduled Duration (${rawDuration}) Completed! Stopping stream cleanly...`);
//         await cleanup();
//         process.exit(0);
//     }, totalDurationMs);
// } else {
//     console.log(`[⏱️] Long/24x7 Stream Mode (${rawDuration}). Will handover after 5h 50m.`);
//     setTimeout(() => {
//         try {
//             let nextDuration = '24/7';
//             if (totalDurationMs !== Infinity) {
//                 const remMins = Math.max(1, Math.round((totalDurationMs - MAX_RUNNER_MS) / 60000));
//                 nextDuration = `${remMins}m`;
//             }
//             const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}" -f custom_duration="${nextDuration}"`;
//             execSync(cmd, { stdio: 'inherit' });
//             setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//         } catch (e) {}
//     }, MAX_RUNNER_MS);
// }

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();

















// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (Fixed: Script 2 SimpleOutput + streamEncoder.json for Zero CPU Hang)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     const iniConfig = `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`;
//     // Write to BOTH global.ini and user.ini (Required for OBS 31/32+ to block Auto-Configuration Wizard)
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), iniConfig);
//     fs.writeFileSync(path.join(obsDir, 'user.ini'), iniConfig);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     // FIXED: Using Script 2's proven Mode=Simple with rc-lookahead=0 & threads=4 so OBS never overloads CPU
//     const basicIniContent = `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Simple\n[SimpleOutput]\nVBitrate=${BITRATE}\nStreamEncoder=x264\nx264Preset=ultrafast\nx264Settings=keyint=60 tune=zerolatency profile=main threads=4 rc-lookahead=0\n`;
//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), basicIniContent);

//     // Also write streamEncoder.json as a fallback in case OBS switches to Advanced
//     fs.writeFileSync(path.join(profilesDir, 'streamEncoder.json'), JSON.stringify({
//         bitrate: BITRATE,
//         keyint_sec: 2,
//         preset: "ultrafast",
//         profile: "main",
//         tune: "zerolatency",
//         x264opts: "threads=4 rc-lookahead=0"
//     }, null, 2));

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW ONCE (Removed destructive 2s xdotool windowsize loop)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }
// const hideOBSAndFocusChromeOnce = keepChromeOnTopAndHideOBS;
// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI (DRM-Safe CDP + Windows 11 Anti-Detect Spoof)
// // =========================================================================================
// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI (DRM-Safe Interception + Windows 11 Anti-Detect Spoof)
// // =========================================================================================
// const AD_BLOCK_PATTERNS = [
//     '*popads*', '*popcash*', '*exoclick*', '*exosrv*', '*magsrv*', '*adsterra*', '*onclickads*',
//     '*doubleclick*', '*googlesyndication*', '*adexchangerapid*', '*bet365*', '*1xbet*',
//     '*propellerads*', '*hilltopads*', '*trafficjunky*', '*trafficstars*', '*tsyndicate*', '*juicyads*', '*clickadu*',
//     '*adcash*', '*galaksion*', '*bidvertiser*', '*revcontent*', '*mgid*',
//     '*taboola*', '*outbrain*', '*acscdn*', '*histats*', '*usrpubtrk*',
//     '*clarity.ms*', '*yandex.ru/metrika*', '*adsco.re*', '*a-ads.com*', '*bidgear*',
//     '*stripchat*', '*strpst*', '*chaturbate*', '*bongacams*', '*cam4*', '*xhamster*', '*livejasmin*'
// ];
// async function setupPageProtections(p) {
//     try {
//         // 1. Request Interception for Ad-blocking & DRM safety
//         await p.setRequestInterception(true);
//         p.on('request', req => {
//             const url = req.url(), type = req.resourceType();
//             const critical = ['media','xhr','fetch'].includes(type) ||
//                 /\.(m3u8|ts|m4s|mpd|key)(\?|$)|license|\/key\/|jwplayer|jwpcdn/i.test(url);
//             if (critical) return req.continue();
            
//             const cleanAdDomains = AD_BLOCK_PATTERNS.map(d => d.replace(/\*/g, ''));
//             if (cleanAdDomains.some(d => url.includes(d))) return req.abort();
//             return req.continue();
//         });

//         // 2. 403 Response Logger to track exact blocked requests
//         p.on('response', r => {
//             if (r.status() === 403) console.log('[⚠️] 403 Forbidden:', r.url());
//         });

//         await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;

//             Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
//             Object.defineProperty(navigator, 'webdriver', { get: () => false });
//             Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
//             Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

//             const getParameter = WebGLRenderingContext.prototype.getParameter;
//             WebGLRenderingContext.prototype.getParameter = function(param) {
//                 if (param === 37445) return 'Google Inc. (NVIDIA)';
//                 if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                 return getParameter.apply(this, arguments);
//             };
//             if (typeof WebGL2RenderingContext !== 'undefined') {
//                 const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
//                 WebGL2RenderingContext.prototype.getParameter = function(param) {
//                     if (param === 37445) return 'Google Inc. (NVIDIA)';
//                     if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                     return getParameter2.apply(this, arguments);
//                 };
//             }

//             const drmAllow = 'encrypted-media; autoplay; fullscreen';
//             const patchIframe = (el) => {
//                 if (el && el.tagName === 'IFRAME') {
//                     if (!el.allow || !el.allow.includes('encrypted-media')) {
//                         el.setAttribute('allow', drmAllow);
//                     }
//                 }
//             };
//             const obs = new MutationObserver((mutations) => {
//                 for (const m of mutations) {
//                     for (const node of m.addedNodes) {
//                         if (node.nodeType === 1) {
//                             patchIframe(node);
//                             if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(patchIframe);
//                         }
//                     }
//                 }
//             });
//             obs.observe(document, { childList: true, subtree: true });

//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             if (document.documentElement) document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await Promise.race([
//             p.evaluate((t, s) => {
//                 if (window.self !== window.top) return;
//                 let el = document.getElementById('bot-loading-ui');
//                 if (!el) {
//                     el = document.createElement('div');
//                     el.id = 'bot-loading-ui';
//                     el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                     document.documentElement.appendChild(el);
//                 }
//                 el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//             }, title, subtitle),
//             new Promise(r => setTimeout(r, 1500))
//         ]);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await Promise.race([
//             p.evaluate(() => {
//                 const el = document.getElementById('bot-loading-ui');
//                 if (el) el.remove();
//             }),
//             new Promise(r => setTimeout(r, 1500))
//         ]);
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Script 2 Safe Lock + Script 1 403 Switcher)
// // =========================================================================================
// let currentPlayerTab = 0;

// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames + Instant Switch on "Protected Content" (403)
//         for (let attempt = 0; attempt < 10; attempt++) {
//             let hasProtectedError = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const errFound = await Promise.race([
//                         frame.evaluate(() => {
//                             const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                             return txt.includes('protected content') || txt.includes('232403') || txt.includes('cannot be played') || txt.includes('error code');
//                         }),
//                         new Promise(r => setTimeout(() => r(false), 1200))
//                     ]);
//                     if (errFound) { hasProtectedError = true; break; }
//                 } catch (e) {}
//             }

//             if (hasProtectedError) {
//                 console.log(`[⚡] Protected Content (403) Detected -> Skipping immediately to Next URL!`);
//                 return false; // Stop checking this page and trigger Next URL failover
//             }

//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await Promise.race([
//                         frame.evaluate((audioEnabled) => {
//                             let isPlaying = false;
//                             const videos = document.querySelectorAll('video');

//                             videos.forEach(v => {
//                                 v.muted = !audioEnabled;
//                                 v.volume = audioEnabled ? 1.0 : 0.0;
//                                 if (v.paused) {
//                                     v.play().catch(() => {});
//                                 }
//                                 if (!v.paused && v.readyState >= 2 && v.currentTime > 0) {
//                                     isPlaying = true;
//                                 }
//                             });

//                             if (!isPlaying) {
//                                 const playSelectors = '.jw-display-icon-display, button[data-plyr="play"], .vjs-big-play-button, .player-poster[class*="clickable"]';
//                                 document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });
//                             }

//                             if (audioEnabled) {
//                                 document.querySelectorAll('[class*="unmute"], .jw-icon-volume, .vjs-vol-muted').forEach(el => {
//                                     const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
//                                     if (txt.includes('unmute') || el.className.includes('unmute') || el.className.includes('jw-off') || el.className.includes('vjs-vol-muted')) {
//                                         try { el.click(); } catch(e){}
//                                     }
//                                 });
//                             }

//                             return isPlaying;
//                         }, ENABLE_STREAM_AUDIO),
//                         new Promise(r => setTimeout(() => r(false), 1200))
//                     ]);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // FIXED: Script 2's Clean Fullscreen Lock (No 'body *' display:none loop that breaks player internals)
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await Promise.race([
//                 frame.evaluate((audioEnabled) => {
//                     if (window.__frameLockActive) return;
//                     window.__frameLockActive = true;

//                     const style = document.createElement('style');
//                     style.innerHTML = `
//                         html, body { background-color: #000 !important; overflow: hidden !important; }
//                         .jw-controls, .jw-ui, .plyr__controls, .vjs-control-bar, [data-player] .controls, .chat, #chat, header, footer, .sidebar, .banner, .ads {
//                             display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;
//                         }
//                     `;
//                     if (document.head) document.head.appendChild(style);

//                     // Helper: Target element (Video ya Iframe) ke ilawa frame mein har floating widget/ad ko khatam karega
//                     const nukeEverythingExcept = (keepEl) => {
//                         document.querySelectorAll('body *').forEach(el => {
//                             if (el === keepEl || el.contains(keepEl) || keepEl.contains(el)) return;
//                             if (el.id === 'bot-loading-ui' || el.tagName === 'SCRIPT' || el.tagName === 'STYLE') return;

//                             // Agar yeh koi ad iframe ya floating widget hai (jaise bottom slider popup), toh seedha remove/hide karein
//                             const s = window.getComputedStyle(el);
//                             if (
//                                 el.tagName === 'IFRAME' ||
//                                 el.shadowRoot ||
//                                 s.position === 'fixed' ||
//                                 s.position === 'absolute' ||
//                                 parseInt(s.zIndex, 10) > 10 ||
//                                 el.parentElement === document.body ||
//                                 el.parentElement === document.documentElement
//                             ) {
//                                 el.style.setProperty('display', 'none', 'important');
//                                 el.style.setProperty('visibility', 'hidden', 'important');
//                                 el.style.setProperty('opacity', '0', 'important');
//                                 el.style.setProperty('z-index', '-999999', 'important');
//                                 el.style.setProperty('pointer-events', 'none', 'important');
//                                 el.style.setProperty('width', '0px', 'important');
//                                 el.style.setProperty('height', '0px', 'important');
//                                 if (el.tagName === 'IFRAME' || el.shadowRoot) {
//                                     try { el.remove(); } catch (e) {}
//                                 }
//                             }
//                         });
//                     };

//                     setInterval(() => {
//                         try {
//                             const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                             if (txt.includes('protected content') || txt.includes('232403')) return;

//                             const videos = Array.from(document.querySelectorAll('video'));
//                             let realVideo = videos.find(v => v.clientWidth > 100 && v.clientHeight > 100) || videos[0];

//                             if (realVideo && (realVideo.clientWidth > 50 || !realVideo.paused)) {
//                                 if (realVideo.paused) realVideo.play().catch(() => {});
//                                 document.querySelectorAll('video, audio').forEach(m => {
//                                     m.muted = !audioEnabled;
//                                     m.volume = audioEnabled ? 1.0 : 0.0;
//                                 });

//                                 const playerWrap = realVideo.closest('.jwplayer, #player, .plyr, .vjs-player, .shaka-video-container, [data-player], .player-poster') || realVideo;
//                                 playerWrap.style.setProperty('position', 'fixed', 'important');
//                                 playerWrap.style.setProperty('top', '0px', 'important');
//                                 playerWrap.style.setProperty('left', '0px', 'important');
//                                 playerWrap.style.setProperty('width', '100vw', 'important');
//                                 playerWrap.style.setProperty('height', '100vh', 'important');
//                                 playerWrap.style.setProperty('z-index', '2147483647', 'important');
//                                 playerWrap.style.setProperty('background-color', 'black', 'important');
//                                 playerWrap.style.setProperty('opacity', '1', 'important');
//                                 playerWrap.style.setProperty('visibility', 'visible', 'important');
//                                 playerWrap.style.setProperty('display', 'block', 'important');
//                                 if (playerWrap !== realVideo) {
//                                     realVideo.style.setProperty('width', '100%', 'important');
//                                     realVideo.style.setProperty('height', '100%', 'important');
//                                 }
//                                 realVideo.style.setProperty('object-fit', 'contain', 'important');

//                                 // Video frame ke andar aur playerWrap ke andar bhi agar koi floating ad/close button hai toh saaf karein
//                                 nukeEverythingExcept(realVideo);
//                                 return;
//                             }

//                             const iframes = Array.from(document.querySelectorAll('iframe'));
//                             let mainIframe = null, maxScore = -1;
//                             iframes.forEach(ifr => {
//                                 const src = (ifr.src || '').toLowerCase();
//                                 if (/popads|exoclick|exosrv|magsrv|adsterra|doubleclick|bet365|1xbet|juicyads|clickadu|propeller|stripchat|strpst|tsyndicate|trafficstars/i.test(src)) {
//                                     ifr.remove();
//                                     return;
//                                 }
//                                 const w = ifr.clientWidth, h = ifr.clientHeight, area = w * h;
//                                 if (area < 5000 || h > w) return;
//                                 let score = area;
//                                 if (ifr.hasAttribute('allowfullscreen') || ifr.hasAttribute('webkitallowfullscreen')) score += 10000000;
//                                 if (score > maxScore) { maxScore = score; mainIframe = ifr; }
//                             });

//                             if (mainIframe) {
//                                 mainIframe.style.setProperty('position', 'fixed', 'important');
//                                 mainIframe.style.setProperty('top', '0px', 'important');
//                                 mainIframe.style.setProperty('left', '0px', 'important');
//                                 mainIframe.style.setProperty('width', '100vw', 'important');
//                                 mainIframe.style.setProperty('height', '100vh', 'important');
//                                 mainIframe.style.setProperty('z-index', '2147483647', 'important');
//                                 mainIframe.style.setProperty('background-color', 'black', 'important');
//                                 mainIframe.style.setProperty('border', 'none', 'important');
//                                 mainIframe.style.setProperty('opacity', '1', 'important');
//                                 mainIframe.style.setProperty('display', 'block', 'important');
//                                 mainIframe.style.setProperty('visibility', 'visible', 'important');

//                                 // Parent frame mein mainIframe ke sath touch hone wale har slider/popup ad ko khatam karein!
//                                 nukeEverythingExcept(mainIframe);
//                             }
//                         } catch (err) {}
//                     }, 500);
//                 }, ENABLE_STREAM_AUDIO),
//                 new Promise(r => setTimeout(r, 1500))
//             ]).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG (Fixed: Detects Screen-Only Freeze + Buffer Stall + Logs Every Hang)
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         if (txt.includes('protected content') || txt.includes('232403') || txt.includes('stream error') || txt.includes('stream unavailable')) {
//                             return { status: 'CRITICAL_ERROR' };
//                         }

//                         const videos = Array.from(document.querySelectorAll('video'));
//                         let targetV = null;
//                         for (const v of videos) {
//                             if (v.clientWidth > 0 && v.clientWidth < 100) continue;
//                             if ((v.src && v.src.startsWith('blob:')) || v.matches('.jw-video, .plyr__video, .vjs-tech')) {
//                                 targetV = v;
//                                 break;
//                             }
//                         }
//                         if (!targetV && videos.length > 0) {
//                             targetV = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
//                         }

//                         if (targetV && !targetV.ended && targetV.currentTime > 0) {
//                             let frames = 0;
//                             if (targetV.getVideoPlaybackQuality) frames = targetV.getVideoPlaybackQuality().totalVideoFrames || 0;
//                             else if (targetV.webkitDecodedFrameCount !== undefined) frames = targetV.webkitDecodedFrameCount || 0;
//                             return {
//                                 status: 'HEALTHY',
//                                 currentTime: Number(targetV.currentTime || 0),
//                                 frames: frames,
//                                 paused: !!targetV.paused,
//                                 readyState: targetV.readyState
//                             };
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);

//         if (results.some(r => r && r.status === 'CRITICAL_ERROR')) {
//             return { status: 'CRITICAL_ERROR' };
//         }

//         const healthyList = results.filter(r => r && r.status === 'HEALTHY');
//         if (healthyList.length > 0) {
//             healthyList.sort((a, b) => (b.frames || 0) - (a.frames || 0));
//             return healthyList[0];
//         }
//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     for (let urlAttempt = 0; urlAttempt < urlList.length; urlAttempt++) {
//         const targetUrl = urlList[currentUrlIndex];
//         console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//         try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//         let lockSuccess = true;
//         try {
//             await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
//             await page.bringToFront().catch(() => {});
//             keepChromeOnTopAndHideOBS();
//             await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//             await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            
//             // --- WIDEVINE DRM CHECK ---
//             const widevineStatus = await page.evaluate(async () => {
//                 try {
//                     await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
//                         initDataTypes: ['cenc'],
//                         videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
//                     }]);
//                     return 'OK';
//                 } catch (e) { return String(e); }
//             });
//             console.log(`[🔐] Widevine DRM Status: ${widevineStatus}`);
//             // --------------------------

//             await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//             lockSuccess = await lockAndPlayVideo(page);
//             if (lockSuccess !== false) {
//                 await hideLoadingOverlay(page);
//             }
//             keepChromeOnTopAndHideOBS();
//         } catch (e) {
//             console.log(`[⚠️] Page navigation warning: ${e.message}`);
//         }

//         // Agar 403 Protected Content aaye toh foran Next URL load karein
//         if (lockSuccess === false && urlList.length > 1) {
//             currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//             reason = '403 PROTECTED CONTENT -> NEXT URL';
//             continue;
//         }

//         try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
//         break;
//     }
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;

//             // FIXED: Use OR (||) instead of AND (&&) so Watchdog catches BOTH:
//             // 1. Audio + Video stopped (isTimeStuck)
//             // 2. Audio playing, but Video screen frozen (isFrameStuck)
//             const isTimeStuck = (lastTime !== -1 && Math.abs(health.currentTime - lastTime) < 0.02);
//             const isFrameStuck = (lastFrames > 0 && health.frames > 0 && health.frames === lastFrames);
//             const isStuck = isTimeStuck || isFrameStuck;

//             // Check if video is looping (DVR Trap)
//             let isLooping = false;
//             if (lastTime !== -1 && health.currentTime < lastTime && (lastTime - health.currentTime > 3)) {
//                 isLooping = true;
//                 console.log(`[⚠️] DVR/Loop Trap Detected! Time jumped backwards from ${lastTime.toFixed(1)}s to ${health.currentTime.toFixed(1)}s`);
//             }

//             if (isStuck || isLooping) {
//                 const stuckMs = Date.now() - freezeStart;
//                 const freezeType = isFrameStuck && !isTimeStuck ? 'SCREEN FROZEN (AUDIO RUNNING)' : 'AUDIO & VIDEO STUCK';
//                 console.log(`[⚠️] HANG DETECTED [${freezeType}] -> Frozen ${(stuckMs / 1000).toFixed(0)}s / 14s | Time: ${health.currentTime.toFixed(1)}s | Frames: ${health.frames}`);

//                 // Try a gentle play() nudge at 6s in case stream paused/stalled
//                 if (!isLooping && stuckMs >= 6000 && stuckMs < 8500) {
//                     for (const frame of page.frames()) {
//                         if (!frame.isDetached()) {
//                             await Promise.race([
//                                 frame.evaluate(() => {
//                                     document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                                 }),
//                                 new Promise(r => setTimeout(r, 800))
//                             ]).catch(() => {});
//                         }
//                     }
//                 }

//                 if (isLooping || stuckMs > 14000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl(isLooping ? 'VIDEO LOOPING (FAILOVER)' : `${freezeType} (14s)`);
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/10`);
//             for (const frame of page.frames()) {
//                 if (!frame.isDetached()) {
//                     await Promise.race([
//                         frame.evaluate(() => {
//                             document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                         }),
//                         new Promise(r => setTimeout(r, 800))
//                     ]).catch(() => {});
//                 }
//             }
//             if (deadStrikes >= 10 || health.status === 'CRITICAL_ERROR') {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl(`${health.status} -> FAILOVER NEXT URL`);
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 30 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     // Pre-seed Chrome Profile with Widevine CDM so Linux Chrome enables DRM on First Boot
//     const userDataDir = path.join(os.tmpdir(), 'chrome-drm-profile');
//     const widevineHintDir = path.join(userDataDir, 'WidevineCdm');
//     const defaultProfileDir = path.join(userDataDir, 'Default');
//     fs.mkdirSync(widevineHintDir, { recursive: true });
//     fs.mkdirSync(defaultProfileDir, { recursive: true });

//     const systemWidevinePaths = [
//         '/opt/google/chrome/WidevineCdm',
//         '/usr/lib/chromium/WidevineCdm',
//         '/usr/lib/chromium-browser/WidevineCdm'
//     ];
//     const activeWidevinePath = systemWidevinePaths.find(p => fs.existsSync(p)) || '/opt/google/chrome/WidevineCdm';

//     fs.writeFileSync(
//         path.join(widevineHintDir, 'latest-component-updated-widevine-cdm'),
//         JSON.stringify({ Path: activeWidevinePath })
//     );
//     fs.writeFileSync(
//         path.join(defaultProfileDir, 'Preferences'),
//         JSON.stringify({
//             profile: { content_settings: { exceptions: { protected_media_identifier: { '*': { setting: 1 } } } } },
//             webkit: { webprefs: { encrypted_media_enabled: true } }
//         })
//     );

//     // FIXED: Added Script 2's exact Xvfb/Linux video rendering & anti-occlusion flags alongside Script 1's Widevine flags
//    const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled',
//         '--disable-background-timer-throttling',
//         '--disable-backgrounding-occluded-windows',
//         '--disable-renderer-backgrounding',
//         '--enable-widevine',
//         '--enable-features=EncryptedMedia,Widevine',
//         '--disable-features=PermissionsPolicyHeader,WebRtcHideLocalIpsWithMdns,DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion',
//         '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
//         '--enforce-webrtc-ip-permission-check'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded (DRM-Safe Mode)!');
//     }

//     const chromePaths = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
//     const executablePath = chromePaths.find(p => fs.existsSync(p));
//     if (executablePath) console.log(`[🌐] Launching Official Chrome with Widevine DRM (${activeWidevinePath})`);

//     browser = await puppeteer.launch({
//         headless: false,
//         executablePath: executablePath || undefined,
//         userDataDir: userDataDir,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: [
//             '--enable-automation',
//             '--disable-extensions',
//             '--disable-component-update',
//             '--disable-component-extensions-with-background-pages',
//             '--disable-default-apps'
//         ],
//         args
//     });

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         const tType = target.type();
//         if (tType === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 150);
//             }
//         }
//     });

//     hideOBSAndFocusChromeOnce();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// // =========================================================================================
// // ⏱️ SMART DURATION & 6-HOUR HANDOVER TIMER (Supports 3h, 180m, 24/7)
// // =========================================================================================
// const rawDuration = (process.env.CUSTOM_DURATION || '24/7').trim().toLowerCase();
// const MAX_RUNNER_MS = 21000000; // 5 hours 50 minutes (350 mins)
// let totalDurationMs = Infinity;

// if (rawDuration !== '24/7' && rawDuration !== 'none' && rawDuration !== '') {
//     const hMatch = rawDuration.match(/(\d+(\.\d+)?)\s*h/);
//     const mMatch = rawDuration.match(/(\d+)\s*m/);
//     if (hMatch) {
//         totalDurationMs = Math.round(parseFloat(hMatch[1]) * 3600 * 1000);
//     } else if (mMatch) {
//         totalDurationMs = parseInt(mMatch[1], 10) * 60 * 1000;
//     } else if (!isNaN(rawDuration)) {
//         totalDurationMs = parseFloat(rawDuration) * 60 * 1000;
//     }
// }

// if (totalDurationMs <= MAX_RUNNER_MS) {
//     console.log(`[⏱️] Stream Duration Set: ${rawDuration} (${Math.round(totalDurationMs / 60000)} mins). Will auto-stop when finished.`);
//     setTimeout(async () => {
//         console.log(`\n[🛑] Scheduled Duration (${rawDuration}) Completed! Stopping stream cleanly...`);
//         await cleanup();
//         process.exit(0);
//     }, totalDurationMs);
// } else {
//     console.log(`[⏱️] Long/24x7 Stream Mode (${rawDuration}). Will handover after 5h 50m.`);
//     setTimeout(() => {
//         try {
//             let nextDuration = '24/7';
//             if (totalDurationMs !== Infinity) {
//                 const remMins = Math.max(1, Math.round((totalDurationMs - MAX_RUNNER_MS) / 60000));
//                 nextDuration = `${remMins}m`;
//             }
//             const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}" -f custom_duration="${nextDuration}"`;
//             execSync(cmd, { stdio: 'inherit' });
//             setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//         } catch (e) {}
//     }, MAX_RUNNER_MS);
// }

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();




















// ========= iss waley me full smotth chalta hai not hang in both dlhd, tatoo, but sometime ads on th top xx **********************     =====================



// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (Fixed: Script 2 SimpleOutput + streamEncoder.json for Zero CPU Hang)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     const iniConfig = `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`;
//     // Write to BOTH global.ini and user.ini (Required for OBS 31/32+ to block Auto-Configuration Wizard)
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), iniConfig);
//     fs.writeFileSync(path.join(obsDir, 'user.ini'), iniConfig);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     // FIXED: Using Script 2's proven Mode=Simple with rc-lookahead=0 & threads=4 so OBS never overloads CPU
//     const basicIniContent = `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Simple\n[SimpleOutput]\nVBitrate=${BITRATE}\nStreamEncoder=x264\nx264Preset=ultrafast\nx264Settings=keyint=60 tune=zerolatency profile=main threads=4 rc-lookahead=0\n`;
//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), basicIniContent);

//     // Also write streamEncoder.json as a fallback in case OBS switches to Advanced
//     fs.writeFileSync(path.join(profilesDir, 'streamEncoder.json'), JSON.stringify({
//         bitrate: BITRATE,
//         keyint_sec: 2,
//         preset: "ultrafast",
//         profile: "main",
//         tune: "zerolatency",
//         x264opts: "threads=4 rc-lookahead=0"
//     }, null, 2));

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW ONCE (Removed destructive 2s xdotool windowsize loop)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }
// const hideOBSAndFocusChromeOnce = keepChromeOnTopAndHideOBS;
// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI (DRM-Safe CDP + Windows 11 Anti-Detect Spoof)
// // =========================================================================================
// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI (DRM-Safe Interception + Windows 11 Anti-Detect Spoof)
// // =========================================================================================
// const AD_BLOCK_PATTERNS = [
//     '*popads*', '*popcash*', '*exoclick*', '*adsterra*', '*onclickads*',
//     '*doubleclick*', '*googlesyndication*', '*adexchangerapid*', '*bet365*', '*1xbet*',
//     '*propellerads*', '*hilltopads*', '*trafficjunky*', '*juicyads*', '*clickadu*',
//     '*adcash*', '*galaksion*', '*bidvertiser*', '*revcontent*', '*mgid*',
//     '*taboola*', '*outbrain*', '*acscdn*', '*histats*', '*usrpubtrk*',
//     '*clarity.ms*', '*yandex.ru/metrika*', '*adsco.re*', '*a-ads.com*', '*bidgear*'
// ];

// async function setupPageProtections(p) {
//     try {
//         // 1. Request Interception for Ad-blocking & DRM safety
//         await p.setRequestInterception(true);
//         p.on('request', req => {
//             const url = req.url(), type = req.resourceType();
//             const critical = ['media','xhr','fetch'].includes(type) ||
//                 /\.(m3u8|ts|m4s|mpd|key)(\?|$)|license|\/key\/|jwplayer|jwpcdn/i.test(url);
//             if (critical) return req.continue();
            
//             const cleanAdDomains = AD_BLOCK_PATTERNS.map(d => d.replace(/\*/g, ''));
//             if (cleanAdDomains.some(d => url.includes(d))) return req.abort();
//             return req.continue();
//         });

//         // 2. 403 Response Logger to track exact blocked requests
//         p.on('response', r => {
//             if (r.status() === 403) console.log('[⚠️] 403 Forbidden:', r.url());
//         });

//         await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;

//             Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
//             Object.defineProperty(navigator, 'webdriver', { get: () => false });
//             Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
//             Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

//             const getParameter = WebGLRenderingContext.prototype.getParameter;
//             WebGLRenderingContext.prototype.getParameter = function(param) {
//                 if (param === 37445) return 'Google Inc. (NVIDIA)';
//                 if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                 return getParameter.apply(this, arguments);
//             };
//             if (typeof WebGL2RenderingContext !== 'undefined') {
//                 const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
//                 WebGL2RenderingContext.prototype.getParameter = function(param) {
//                     if (param === 37445) return 'Google Inc. (NVIDIA)';
//                     if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                     return getParameter2.apply(this, arguments);
//                 };
//             }

//             const drmAllow = 'encrypted-media; autoplay; fullscreen';
//             const patchIframe = (el) => {
//                 if (el && el.tagName === 'IFRAME') {
//                     if (!el.allow || !el.allow.includes('encrypted-media')) {
//                         el.setAttribute('allow', drmAllow);
//                     }
//                 }
//             };
//             const obs = new MutationObserver((mutations) => {
//                 for (const m of mutations) {
//                     for (const node of m.addedNodes) {
//                         if (node.nodeType === 1) {
//                             patchIframe(node);
//                             if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(patchIframe);
//                         }
//                     }
//                 }
//             });
//             obs.observe(document, { childList: true, subtree: true });

//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             if (document.documentElement) document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await Promise.race([
//             p.evaluate((t, s) => {
//                 if (window.self !== window.top) return;
//                 let el = document.getElementById('bot-loading-ui');
//                 if (!el) {
//                     el = document.createElement('div');
//                     el.id = 'bot-loading-ui';
//                     el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                     document.documentElement.appendChild(el);
//                 }
//                 el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//             }, title, subtitle),
//             new Promise(r => setTimeout(r, 1500))
//         ]);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await Promise.race([
//             p.evaluate(() => {
//                 const el = document.getElementById('bot-loading-ui');
//                 if (el) el.remove();
//             }),
//             new Promise(r => setTimeout(r, 1500))
//         ]);
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Script 2 Safe Lock + Script 1 403 Switcher)
// // =========================================================================================
// let currentPlayerTab = 0;

// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames + Instant Switch on "Protected Content" (403)
//         for (let attempt = 0; attempt < 10; attempt++) {
//             let hasProtectedError = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const errFound = await Promise.race([
//                         frame.evaluate(() => {
//                             const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                             return txt.includes('protected content') || txt.includes('232403') || txt.includes('cannot be played') || txt.includes('error code');
//                         }),
//                         new Promise(r => setTimeout(() => r(false), 1200))
//                     ]);
//                     if (errFound) { hasProtectedError = true; break; }
//                 } catch (e) {}
//             }

//             if (hasProtectedError) {
//                 console.log(`[⚡] Protected Content (403) Detected -> Skipping immediately to Next URL!`);
//                 return false; // Stop checking this page and trigger Next URL failover
//             }

//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await Promise.race([
//                         frame.evaluate((audioEnabled) => {
//                             let isPlaying = false;
//                             const videos = document.querySelectorAll('video');

//                             videos.forEach(v => {
//                                 v.muted = !audioEnabled;
//                                 v.volume = audioEnabled ? 1.0 : 0.0;
//                                 if (v.paused) {
//                                     v.play().catch(() => {});
//                                 }
//                                 if (!v.paused && v.readyState >= 2 && v.currentTime > 0) {
//                                     isPlaying = true;
//                                 }
//                             });

//                             if (!isPlaying) {
//                                 const playSelectors = '.jw-display-icon-display, button[data-plyr="play"], .vjs-big-play-button, .player-poster[class*="clickable"]';
//                                 document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });
//                             }

//                             if (audioEnabled) {
//                                 document.querySelectorAll('[class*="unmute"], .jw-icon-volume, .vjs-vol-muted').forEach(el => {
//                                     const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
//                                     if (txt.includes('unmute') || el.className.includes('unmute') || el.className.includes('jw-off') || el.className.includes('vjs-vol-muted')) {
//                                         try { el.click(); } catch(e){}
//                                     }
//                                 });
//                             }

//                             return isPlaying;
//                         }, ENABLE_STREAM_AUDIO),
//                         new Promise(r => setTimeout(() => r(false), 1200))
//                     ]);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // FIXED: Script 2's Clean Fullscreen Lock (No 'body *' display:none loop that breaks player internals)
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await Promise.race([
//                 frame.evaluate((audioEnabled) => {
//                     if (window.__frameLockActive) return;
//                     window.__frameLockActive = true;

//                     const style = document.createElement('style');
//                     style.innerHTML = `
//                         html, body { background-color: #000 !important; overflow: hidden !important; }
//                         .jw-controls, .jw-ui, .plyr__controls, .vjs-control-bar, [data-player] .controls, .chat, #chat, header, footer, .sidebar, .banner, .ads {
//                             display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;
//                         }
//                     `;
//                     if (document.head) document.head.appendChild(style);

//                     setInterval(() => {
//                         try {
//                             const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                             if (txt.includes('protected content') || txt.includes('232403')) return;

//                             const videos = Array.from(document.querySelectorAll('video'));
//                             let realVideo = videos.find(v => v.clientWidth > 100 && v.clientHeight > 100) || videos[0];

//                             if (realVideo && (realVideo.clientWidth > 50 || !realVideo.paused)) {
//                                 if (realVideo.paused) realVideo.play().catch(() => {});
//                                 document.querySelectorAll('video, audio').forEach(m => {
//                                     m.muted = !audioEnabled;
//                                     m.volume = audioEnabled ? 1.0 : 0.0;
//                                 });

//                                 const playerWrap = realVideo.closest('.jwplayer, #player, .plyr, .vjs-player, .shaka-video-container, [data-player], .player-poster') || realVideo;
//                                 playerWrap.style.setProperty('position', 'fixed', 'important');
//                                 playerWrap.style.setProperty('top', '0px', 'important');
//                                 playerWrap.style.setProperty('left', '0px', 'important');
//                                 playerWrap.style.setProperty('width', '100vw', 'important');
//                                 playerWrap.style.setProperty('height', '100vh', 'important');
//                                 playerWrap.style.setProperty('z-index', '2147483646', 'important');
//                                 playerWrap.style.setProperty('background-color', 'black', 'important');
//                                 playerWrap.style.setProperty('opacity', '1', 'important');
//                                 playerWrap.style.setProperty('visibility', 'visible', 'important');
//                                 playerWrap.style.setProperty('display', 'block', 'important');
//                                 if (playerWrap !== realVideo) {
//                                     realVideo.style.setProperty('width', '100%', 'important');
//                                     realVideo.style.setProperty('height', '100%', 'important');
//                                 }
//                                 realVideo.style.setProperty('object-fit', 'contain', 'important');
//                                 return;
//                             }

//                             const iframes = Array.from(document.querySelectorAll('iframe'));
//                             let mainIframe = null, maxScore = -1;
//                             iframes.forEach(ifr => {
//                                 const src = (ifr.src || '').toLowerCase();
//                                 if (/popads|exoclick|adsterra|doubleclick|bet365|1xbet|juicyads|clickadu|propeller/i.test(src)) {
//                                     ifr.remove();
//                                     return;
//                                 }
//                                 const w = ifr.clientWidth, h = ifr.clientHeight, area = w * h;
//                                 if (area < 5000 || h > w) return;
//                                 let score = area;
//                                 if (ifr.hasAttribute('allowfullscreen') || ifr.hasAttribute('webkitallowfullscreen')) score += 10000000;
//                                 if (score > maxScore) { maxScore = score; mainIframe = ifr; }
//                             });

//                             if (mainIframe) {
//                                 iframes.forEach(ifr => {
//                                     if (ifr !== mainIframe) {
//                                         ifr.style.setProperty('display', 'none', 'important');
//                                         ifr.style.setProperty('opacity', '0', 'important');
//                                     }
//                                 });
//                                 mainIframe.style.setProperty('position', 'fixed', 'important');
//                                 mainIframe.style.setProperty('top', '0px', 'important');
//                                 mainIframe.style.setProperty('left', '0px', 'important');
//                                 mainIframe.style.setProperty('width', '100vw', 'important');
//                                 mainIframe.style.setProperty('height', '100vh', 'important');
//                                 mainIframe.style.setProperty('z-index', '2147483645', 'important');
//                                 mainIframe.style.setProperty('background-color', 'black', 'important');
//                                 mainIframe.style.setProperty('border', 'none', 'important');
//                                 mainIframe.style.setProperty('opacity', '1', 'important');
//                                 mainIframe.style.setProperty('display', 'block', 'important');
//                                 mainIframe.style.setProperty('visibility', 'visible', 'important');
//                             }
//                         } catch (err) {}
//                     }, 500);
//                 }, ENABLE_STREAM_AUDIO),
//                 new Promise(r => setTimeout(r, 1500))
//             ]).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG (Fixed: Detects Screen-Only Freeze + Buffer Stall + Logs Every Hang)
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         if (txt.includes('protected content') || txt.includes('232403') || txt.includes('stream error') || txt.includes('stream unavailable')) {
//                             return { status: 'CRITICAL_ERROR' };
//                         }

//                         const videos = Array.from(document.querySelectorAll('video'));
//                         let targetV = null;
//                         for (const v of videos) {
//                             if (v.clientWidth > 0 && v.clientWidth < 100) continue;
//                             if ((v.src && v.src.startsWith('blob:')) || v.matches('.jw-video, .plyr__video, .vjs-tech')) {
//                                 targetV = v;
//                                 break;
//                             }
//                         }
//                         if (!targetV && videos.length > 0) {
//                             targetV = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
//                         }

//                         if (targetV && !targetV.ended && targetV.currentTime > 0) {
//                             let frames = 0;
//                             if (targetV.getVideoPlaybackQuality) frames = targetV.getVideoPlaybackQuality().totalVideoFrames || 0;
//                             else if (targetV.webkitDecodedFrameCount !== undefined) frames = targetV.webkitDecodedFrameCount || 0;
//                             return {
//                                 status: 'HEALTHY',
//                                 currentTime: Number(targetV.currentTime || 0),
//                                 frames: frames,
//                                 paused: !!targetV.paused,
//                                 readyState: targetV.readyState
//                             };
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);

//         if (results.some(r => r && r.status === 'CRITICAL_ERROR')) {
//             return { status: 'CRITICAL_ERROR' };
//         }

//         const healthyList = results.filter(r => r && r.status === 'HEALTHY');
//         if (healthyList.length > 0) {
//             healthyList.sort((a, b) => (b.frames || 0) - (a.frames || 0));
//             return healthyList[0];
//         }
//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     for (let urlAttempt = 0; urlAttempt < urlList.length; urlAttempt++) {
//         const targetUrl = urlList[currentUrlIndex];
//         console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//         try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//         let lockSuccess = true;
//         try {
//             await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
//             await page.bringToFront().catch(() => {});
//             keepChromeOnTopAndHideOBS();
//             await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//             await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
            
//             // --- WIDEVINE DRM CHECK ---
//             const widevineStatus = await page.evaluate(async () => {
//                 try {
//                     await navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
//                         initDataTypes: ['cenc'],
//                         videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }]
//                     }]);
//                     return 'OK';
//                 } catch (e) { return String(e); }
//             });
//             console.log(`[🔐] Widevine DRM Status: ${widevineStatus}`);
//             // --------------------------

//             await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//             lockSuccess = await lockAndPlayVideo(page);
//             if (lockSuccess !== false) {
//                 await hideLoadingOverlay(page);
//             }
//             keepChromeOnTopAndHideOBS();
//         } catch (e) {
//             console.log(`[⚠️] Page navigation warning: ${e.message}`);
//         }

//         // Agar 403 Protected Content aaye toh foran Next URL load karein
//         if (lockSuccess === false && urlList.length > 1) {
//             currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//             reason = '403 PROTECTED CONTENT -> NEXT URL';
//             continue;
//         }

//         try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
//         break;
//     }
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;

//             // FIXED: Use OR (||) instead of AND (&&) so Watchdog catches BOTH:
//             // 1. Audio + Video stopped (isTimeStuck)
//             // 2. Audio playing, but Video screen frozen (isFrameStuck)
//             const isTimeStuck = (lastTime !== -1 && Math.abs(health.currentTime - lastTime) < 0.02);
//             const isFrameStuck = (lastFrames > 0 && health.frames > 0 && health.frames === lastFrames);
//             const isStuck = isTimeStuck || isFrameStuck;

//             // Check if video is looping (DVR Trap)
//             let isLooping = false;
//             if (lastTime !== -1 && health.currentTime < lastTime && (lastTime - health.currentTime > 3)) {
//                 isLooping = true;
//                 console.log(`[⚠️] DVR/Loop Trap Detected! Time jumped backwards from ${lastTime.toFixed(1)}s to ${health.currentTime.toFixed(1)}s`);
//             }

//             if (isStuck || isLooping) {
//                 const stuckMs = Date.now() - freezeStart;
//                 const freezeType = isFrameStuck && !isTimeStuck ? 'SCREEN FROZEN (AUDIO RUNNING)' : 'AUDIO & VIDEO STUCK';
//                 console.log(`[⚠️] HANG DETECTED [${freezeType}] -> Frozen ${(stuckMs / 1000).toFixed(0)}s / 14s | Time: ${health.currentTime.toFixed(1)}s | Frames: ${health.frames}`);

//                 // Try a gentle play() nudge at 6s in case stream paused/stalled
//                 if (!isLooping && stuckMs >= 6000 && stuckMs < 8500) {
//                     for (const frame of page.frames()) {
//                         if (!frame.isDetached()) {
//                             await Promise.race([
//                                 frame.evaluate(() => {
//                                     document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                                 }),
//                                 new Promise(r => setTimeout(r, 800))
//                             ]).catch(() => {});
//                         }
//                     }
//                 }

//                 if (isLooping || stuckMs > 14000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl(isLooping ? 'VIDEO LOOPING (FAILOVER)' : `${freezeType} (14s)`);
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/10`);
//             for (const frame of page.frames()) {
//                 if (!frame.isDetached()) {
//                     await Promise.race([
//                         frame.evaluate(() => {
//                             document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                         }),
//                         new Promise(r => setTimeout(r, 800))
//                     ]).catch(() => {});
//                 }
//             }
//             if (deadStrikes >= 10 || health.status === 'CRITICAL_ERROR') {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl(`${health.status} -> FAILOVER NEXT URL`);
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 30 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     // Pre-seed Chrome Profile with Widevine CDM so Linux Chrome enables DRM on First Boot
//     const userDataDir = path.join(os.tmpdir(), 'chrome-drm-profile');
//     const widevineHintDir = path.join(userDataDir, 'WidevineCdm');
//     const defaultProfileDir = path.join(userDataDir, 'Default');
//     fs.mkdirSync(widevineHintDir, { recursive: true });
//     fs.mkdirSync(defaultProfileDir, { recursive: true });

//     const systemWidevinePaths = [
//         '/opt/google/chrome/WidevineCdm',
//         '/usr/lib/chromium/WidevineCdm',
//         '/usr/lib/chromium-browser/WidevineCdm'
//     ];
//     const activeWidevinePath = systemWidevinePaths.find(p => fs.existsSync(p)) || '/opt/google/chrome/WidevineCdm';

//     fs.writeFileSync(
//         path.join(widevineHintDir, 'latest-component-updated-widevine-cdm'),
//         JSON.stringify({ Path: activeWidevinePath })
//     );
//     fs.writeFileSync(
//         path.join(defaultProfileDir, 'Preferences'),
//         JSON.stringify({
//             profile: { content_settings: { exceptions: { protected_media_identifier: { '*': { setting: 1 } } } } },
//             webkit: { webprefs: { encrypted_media_enabled: true } }
//         })
//     );

//     // FIXED: Added Script 2's exact Xvfb/Linux video rendering & anti-occlusion flags alongside Script 1's Widevine flags
//    const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled',
//         '--disable-background-timer-throttling',
//         '--disable-backgrounding-occluded-windows',
//         '--disable-renderer-backgrounding',
//         '--enable-widevine',
//         '--enable-features=EncryptedMedia,Widevine',
//         '--disable-features=PermissionsPolicyHeader,WebRtcHideLocalIpsWithMdns,DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion',
//         '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
//         '--enforce-webrtc-ip-permission-check'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded (DRM-Safe Mode)!');
//     }

//     const chromePaths = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
//     const executablePath = chromePaths.find(p => fs.existsSync(p));
//     if (executablePath) console.log(`[🌐] Launching Official Chrome with Widevine DRM (${activeWidevinePath})`);

//     browser = await puppeteer.launch({
//         headless: false,
//         executablePath: executablePath || undefined,
//         userDataDir: userDataDir,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: [
//             '--enable-automation',
//             '--disable-extensions',
//             '--disable-component-update',
//             '--disable-component-extensions-with-background-pages',
//             '--disable-default-apps'
//         ],
//         args
//     });

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         const tType = target.type();
//         if (tType === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 150);
//             }
//         }
//     });

//     hideOBSAndFocusChromeOnce();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// // =========================================================================================
// // ⏱️ SMART DURATION & 6-HOUR HANDOVER TIMER (Supports 3h, 180m, 24/7)
// // =========================================================================================
// const rawDuration = (process.env.CUSTOM_DURATION || '24/7').trim().toLowerCase();
// const MAX_RUNNER_MS = 21000000; // 5 hours 50 minutes (350 mins)
// let totalDurationMs = Infinity;

// if (rawDuration !== '24/7' && rawDuration !== 'none' && rawDuration !== '') {
//     const hMatch = rawDuration.match(/(\d+(\.\d+)?)\s*h/);
//     const mMatch = rawDuration.match(/(\d+)\s*m/);
//     if (hMatch) {
//         totalDurationMs = Math.round(parseFloat(hMatch[1]) * 3600 * 1000);
//     } else if (mMatch) {
//         totalDurationMs = parseInt(mMatch[1], 10) * 60 * 1000;
//     } else if (!isNaN(rawDuration)) {
//         totalDurationMs = parseFloat(rawDuration) * 60 * 1000;
//     }
// }

// if (totalDurationMs <= MAX_RUNNER_MS) {
//     console.log(`[⏱️] Stream Duration Set: ${rawDuration} (${Math.round(totalDurationMs / 60000)} mins). Will auto-stop when finished.`);
//     setTimeout(async () => {
//         console.log(`\n[🛑] Scheduled Duration (${rawDuration}) Completed! Stopping stream cleanly...`);
//         await cleanup();
//         process.exit(0);
//     }, totalDurationMs);
// } else {
//     console.log(`[⏱️] Long/24x7 Stream Mode (${rawDuration}). Will handover after 5h 50m.`);
//     setTimeout(() => {
//         try {
//             let nextDuration = '24/7';
//             if (totalDurationMs !== Infinity) {
//                 const remMins = Math.max(1, Math.round((totalDurationMs - MAX_RUNNER_MS) / 60000));
//                 nextDuration = `${remMins}m`;
//             }
//             const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}" -f custom_duration="${nextDuration}"`;
//             execSync(cmd, { stdio: 'inherit' });
//             setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//         } catch (e) {}
//     }, MAX_RUNNER_MS);
// }

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();
































// iss me pehal url par bey 403 error ata hai and 2nd url par bey dlhd k 


// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (Fixed: Script 2 SimpleOutput + streamEncoder.json for Zero CPU Hang)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     const iniConfig = `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`;
//     // Write to BOTH global.ini and user.ini (Required for OBS 31/32+ to block Auto-Configuration Wizard)
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), iniConfig);
//     fs.writeFileSync(path.join(obsDir, 'user.ini'), iniConfig);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     // FIXED: Using Script 2's proven Mode=Simple with rc-lookahead=0 & threads=4 so OBS never overloads CPU
//     const basicIniContent = `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Simple\n[SimpleOutput]\nVBitrate=${BITRATE}\nStreamEncoder=x264\nx264Preset=ultrafast\nx264Settings=keyint=60 tune=zerolatency profile=main threads=4 rc-lookahead=0\n`;
//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), basicIniContent);

//     // Also write streamEncoder.json as a fallback in case OBS switches to Advanced
//     fs.writeFileSync(path.join(profilesDir, 'streamEncoder.json'), JSON.stringify({
//         bitrate: BITRATE,
//         keyint_sec: 2,
//         preset: "ultrafast",
//         profile: "main",
//         tune: "zerolatency",
//         x264opts: "threads=4 rc-lookahead=0"
//     }, null, 2));

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW ONCE (Removed destructive 2s xdotool windowsize loop)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }
// const hideOBSAndFocusChromeOnce = keepChromeOnTopAndHideOBS;
// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI (DRM-Safe CDP + Windows 11 Anti-Detect Spoof)
// // =========================================================================================
// const AD_BLOCK_PATTERNS = [
//     '*popads*', '*popcash*', '*exoclick*', '*adsterra*', '*onclickads*',
//     '*doubleclick*', '*googlesyndication*', '*adexchangerapid*', '*bet365*', '*1xbet*',
//     '*propellerads*', '*hilltopads*', '*trafficjunky*', '*juicyads*', '*clickadu*',
//     '*adcash*', '*galaksion*', '*bidvertiser*', '*revcontent*', '*mgid*',
//     '*taboola*', '*outbrain*', '*acscdn*', '*histats*', '*usrpubtrk*',
//     '*clarity.ms*', '*yandex.ru/metrika*', '*adsco.re*', '*a-ads.com*', '*bidgear*'
// ];

// async function attachCdpAdBlocker(target) {
//     try {
//         const client = await target.createCDPSession();
//         await client.send('Network.enable');
//         await client.send('Network.setBlockedURLs', { urls: AD_BLOCK_PATTERNS });
//     } catch (e) {}
// }

// async function setupPageProtections(p) {
//     try {
//         await attachCdpAdBlocker(p.target());

//         await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;

//             Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
//             Object.defineProperty(navigator, 'webdriver', { get: () => false });
//             Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
//             Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

//             const getParameter = WebGLRenderingContext.prototype.getParameter;
//             WebGLRenderingContext.prototype.getParameter = function(param) {
//                 if (param === 37445) return 'Google Inc. (NVIDIA)';
//                 if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                 return getParameter.apply(this, arguments);
//             };
//             if (typeof WebGL2RenderingContext !== 'undefined') {
//                 const getParameter2 = WebGL2RenderingContext.prototype.getParameter;
//                 WebGL2RenderingContext.prototype.getParameter = function(param) {
//                     if (param === 37445) return 'Google Inc. (NVIDIA)';
//                     if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                     return getParameter2.apply(this, arguments);
//                 };
//             }

//             const drmAllow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write';
//             const patchIframe = (el) => {
//                 if (el && el.tagName === 'IFRAME') {
//                     if (!el.allow || !el.allow.includes('encrypted-media')) {
//                         el.setAttribute('allow', drmAllow);
//                     }
//                 }
//             };
//             const obs = new MutationObserver((mutations) => {
//                 for (const m of mutations) {
//                     for (const node of m.addedNodes) {
//                         if (node.nodeType === 1) {
//                             patchIframe(node);
//                             if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(patchIframe);
//                         }
//                     }
//                 }
//             });
//             obs.observe(document, { childList: true, subtree: true });

//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             if (document.documentElement) document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await Promise.race([
//             p.evaluate((t, s) => {
//                 if (window.self !== window.top) return;
//                 let el = document.getElementById('bot-loading-ui');
//                 if (!el) {
//                     el = document.createElement('div');
//                     el.id = 'bot-loading-ui';
//                     el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                     document.documentElement.appendChild(el);
//                 }
//                 el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//             }, title, subtitle),
//             new Promise(r => setTimeout(r, 1500))
//         ]);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await Promise.race([
//             p.evaluate(() => {
//                 const el = document.getElementById('bot-loading-ui');
//                 if (el) el.remove();
//             }),
//             new Promise(r => setTimeout(r, 1500))
//         ]);
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Script 2 Safe Lock + Script 1 403 Switcher)
// // =========================================================================================
// let currentPlayerTab = 0;

// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames + Instant Switch on "Protected Content" (403)
//         for (let attempt = 0; attempt < 10; attempt++) {
//             let hasProtectedError = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const errFound = await Promise.race([
//                         frame.evaluate(() => {
//                             const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                             return txt.includes('protected content') || txt.includes('232403') || txt.includes('cannot be played') || txt.includes('error code');
//                         }),
//                         new Promise(r => setTimeout(() => r(false), 1200))
//                     ]);
//                     if (errFound) { hasProtectedError = true; break; }
//                 } catch (e) {}
//             }

//             if (hasProtectedError) {
//                 console.log(`[⚡] Protected Content (403) Detected -> Skipping immediately to Next URL!`);
//                 return false; // Stop checking this page and trigger Next URL failover
//             }

//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await Promise.race([
//                         frame.evaluate((audioEnabled) => {
//                             let isPlaying = false;
//                             const videos = document.querySelectorAll('video');

//                             videos.forEach(v => {
//                                 v.muted = !audioEnabled;
//                                 v.volume = audioEnabled ? 1.0 : 0.0;
//                                 if (v.paused) {
//                                     v.play().catch(() => {});
//                                 }
//                                 if (!v.paused && v.readyState >= 2 && v.currentTime > 0) {
//                                     isPlaying = true;
//                                 }
//                             });

//                             if (!isPlaying) {
//                                 const playSelectors = '.jw-display-icon-display, button[data-plyr="play"], .vjs-big-play-button, .player-poster[class*="clickable"]';
//                                 document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });
//                             }

//                             if (audioEnabled) {
//                                 document.querySelectorAll('[class*="unmute"], .jw-icon-volume, .vjs-vol-muted').forEach(el => {
//                                     const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
//                                     if (txt.includes('unmute') || el.className.includes('unmute') || el.className.includes('jw-off') || el.className.includes('vjs-vol-muted')) {
//                                         try { el.click(); } catch(e){}
//                                     }
//                                 });
//                             }

//                             return isPlaying;
//                         }, ENABLE_STREAM_AUDIO),
//                         new Promise(r => setTimeout(() => r(false), 1200))
//                     ]);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // FIXED: Script 2's Clean Fullscreen Lock (No 'body *' display:none loop that breaks player internals)
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await Promise.race([
//                 frame.evaluate((audioEnabled) => {
//                     if (window.__frameLockActive) return;
//                     window.__frameLockActive = true;

//                     const style = document.createElement('style');
//                     style.innerHTML = `
//                         html, body { background-color: #000 !important; overflow: hidden !important; }
//                         .jw-controls, .jw-ui, .plyr__controls, .vjs-control-bar, [data-player] .controls, .chat, #chat, header, footer, .sidebar, .banner, .ads {
//                             display: none !important; opacity: 0 !important; visibility: hidden !important; pointer-events: none !important;
//                         }
//                     `;
//                     if (document.head) document.head.appendChild(style);

//                     setInterval(() => {
//                         try {
//                             const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                             if (txt.includes('protected content') || txt.includes('232403')) return;

//                             const videos = Array.from(document.querySelectorAll('video'));
//                             let realVideo = videos.find(v => v.clientWidth > 100 && v.clientHeight > 100) || videos[0];

//                             if (realVideo && (realVideo.clientWidth > 50 || !realVideo.paused)) {
//                                 if (realVideo.paused) realVideo.play().catch(() => {});
//                                 document.querySelectorAll('video, audio').forEach(m => {
//                                     m.muted = !audioEnabled;
//                                     m.volume = audioEnabled ? 1.0 : 0.0;
//                                 });

//                                 const playerWrap = realVideo.closest('.jwplayer, #player, .plyr, .vjs-player, .shaka-video-container, [data-player], .player-poster') || realVideo;
//                                 playerWrap.style.setProperty('position', 'fixed', 'important');
//                                 playerWrap.style.setProperty('top', '0px', 'important');
//                                 playerWrap.style.setProperty('left', '0px', 'important');
//                                 playerWrap.style.setProperty('width', '100vw', 'important');
//                                 playerWrap.style.setProperty('height', '100vh', 'important');
//                                 playerWrap.style.setProperty('z-index', '2147483646', 'important');
//                                 playerWrap.style.setProperty('background-color', 'black', 'important');
//                                 playerWrap.style.setProperty('opacity', '1', 'important');
//                                 playerWrap.style.setProperty('visibility', 'visible', 'important');
//                                 playerWrap.style.setProperty('display', 'block', 'important');
//                                 if (playerWrap !== realVideo) {
//                                     realVideo.style.setProperty('width', '100%', 'important');
//                                     realVideo.style.setProperty('height', '100%', 'important');
//                                 }
//                                 realVideo.style.setProperty('object-fit', 'contain', 'important');
//                                 return;
//                             }

//                             const iframes = Array.from(document.querySelectorAll('iframe'));
//                             let mainIframe = null, maxScore = -1;
//                             iframes.forEach(ifr => {
//                                 const src = (ifr.src || '').toLowerCase();
//                                 if (/popads|exoclick|adsterra|doubleclick|bet365|1xbet|juicyads|clickadu|propeller/i.test(src)) {
//                                     ifr.remove();
//                                     return;
//                                 }
//                                 const w = ifr.clientWidth, h = ifr.clientHeight, area = w * h;
//                                 if (area < 5000 || h > w) return;
//                                 let score = area;
//                                 if (ifr.hasAttribute('allowfullscreen') || ifr.hasAttribute('webkitallowfullscreen')) score += 10000000;
//                                 if (score > maxScore) { maxScore = score; mainIframe = ifr; }
//                             });

//                             if (mainIframe) {
//                                 iframes.forEach(ifr => {
//                                     if (ifr !== mainIframe) {
//                                         ifr.style.setProperty('display', 'none', 'important');
//                                         ifr.style.setProperty('opacity', '0', 'important');
//                                     }
//                                 });
//                                 mainIframe.style.setProperty('position', 'fixed', 'important');
//                                 mainIframe.style.setProperty('top', '0px', 'important');
//                                 mainIframe.style.setProperty('left', '0px', 'important');
//                                 mainIframe.style.setProperty('width', '100vw', 'important');
//                                 mainIframe.style.setProperty('height', '100vh', 'important');
//                                 mainIframe.style.setProperty('z-index', '2147483645', 'important');
//                                 mainIframe.style.setProperty('background-color', 'black', 'important');
//                                 mainIframe.style.setProperty('border', 'none', 'important');
//                                 mainIframe.style.setProperty('opacity', '1', 'important');
//                                 mainIframe.style.setProperty('display', 'block', 'important');
//                                 mainIframe.style.setProperty('visibility', 'visible', 'important');
//                             }
//                         } catch (err) {}
//                     }, 500);
//                 }, ENABLE_STREAM_AUDIO),
//                 new Promise(r => setTimeout(r, 1500))
//             ]).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG (Fixed: Detects Screen-Only Freeze + Buffer Stall + Logs Every Hang)
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         if (txt.includes('protected content') || txt.includes('232403') || txt.includes('stream error') || txt.includes('stream unavailable')) {
//                             return { status: 'CRITICAL_ERROR' };
//                         }

//                         const videos = Array.from(document.querySelectorAll('video'));
//                         let targetV = null;
//                         for (const v of videos) {
//                             if (v.clientWidth > 0 && v.clientWidth < 100) continue;
//                             if ((v.src && v.src.startsWith('blob:')) || v.matches('.jw-video, .plyr__video, .vjs-tech')) {
//                                 targetV = v;
//                                 break;
//                             }
//                         }
//                         if (!targetV && videos.length > 0) {
//                             targetV = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
//                         }

//                         if (targetV && !targetV.ended && targetV.currentTime > 0) {
//                             let frames = 0;
//                             if (targetV.getVideoPlaybackQuality) frames = targetV.getVideoPlaybackQuality().totalVideoFrames || 0;
//                             else if (targetV.webkitDecodedFrameCount !== undefined) frames = targetV.webkitDecodedFrameCount || 0;
//                             return {
//                                 status: 'HEALTHY',
//                                 currentTime: Number(targetV.currentTime || 0),
//                                 frames: frames,
//                                 paused: !!targetV.paused,
//                                 readyState: targetV.readyState
//                             };
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);

//         if (results.some(r => r && r.status === 'CRITICAL_ERROR')) {
//             return { status: 'CRITICAL_ERROR' };
//         }

//         const healthyList = results.filter(r => r && r.status === 'HEALTHY');
//         if (healthyList.length > 0) {
//             healthyList.sort((a, b) => (b.frames || 0) - (a.frames || 0));
//             return healthyList[0];
//         }
//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     for (let urlAttempt = 0; urlAttempt < urlList.length; urlAttempt++) {
//         const targetUrl = urlList[currentUrlIndex];
//         console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//         try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//         let lockSuccess = true;
//         try {
//             await page.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(() => {});
//             await page.bringToFront().catch(() => {});
//             keepChromeOnTopAndHideOBS();
//             await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//             await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
//             await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//             lockSuccess = await lockAndPlayVideo(page);
//             if (lockSuccess !== false) {
//                 await hideLoadingOverlay(page);
//             }
//             keepChromeOnTopAndHideOBS();
//         } catch (e) {
//             console.log(`[⚠️] Page navigation warning: ${e.message}`);
//         }

//         // Agar 403 Protected Content aaye toh foran Next URL load karein
//         if (lockSuccess === false && urlList.length > 1) {
//             currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//             reason = '403 PROTECTED CONTENT -> NEXT URL';
//             continue;
//         }

//         try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
//         break;
//     }
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;

//             // FIXED: Use OR (||) instead of AND (&&) so Watchdog catches BOTH:
//             // 1. Audio + Video stopped (isTimeStuck)
//             // 2. Audio playing, but Video screen frozen (isFrameStuck)
//             const isTimeStuck = (lastTime !== -1 && Math.abs(health.currentTime - lastTime) < 0.02);
//             const isFrameStuck = (lastFrames > 0 && health.frames > 0 && health.frames === lastFrames);
//             const isStuck = isTimeStuck || isFrameStuck;

//             // Check if video is looping (DVR Trap)
//             let isLooping = false;
//             if (lastTime !== -1 && health.currentTime < lastTime && (lastTime - health.currentTime > 3)) {
//                 isLooping = true;
//                 console.log(`[⚠️] DVR/Loop Trap Detected! Time jumped backwards from ${lastTime.toFixed(1)}s to ${health.currentTime.toFixed(1)}s`);
//             }

//             if (isStuck || isLooping) {
//                 const stuckMs = Date.now() - freezeStart;
//                 const freezeType = isFrameStuck && !isTimeStuck ? 'SCREEN FROZEN (AUDIO RUNNING)' : 'AUDIO & VIDEO STUCK';
//                 console.log(`[⚠️] HANG DETECTED [${freezeType}] -> Frozen ${(stuckMs / 1000).toFixed(0)}s / 14s | Time: ${health.currentTime.toFixed(1)}s | Frames: ${health.frames}`);

//                 // Try a gentle play() nudge at 6s in case stream paused/stalled
//                 if (!isLooping && stuckMs >= 6000 && stuckMs < 8500) {
//                     for (const frame of page.frames()) {
//                         if (!frame.isDetached()) {
//                             await Promise.race([
//                                 frame.evaluate(() => {
//                                     document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                                 }),
//                                 new Promise(r => setTimeout(r, 800))
//                             ]).catch(() => {});
//                         }
//                     }
//                 }

//                 if (isLooping || stuckMs > 14000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl(isLooping ? 'VIDEO LOOPING (FAILOVER)' : `${freezeType} (14s)`);
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/10`);
//             for (const frame of page.frames()) {
//                 if (!frame.isDetached()) {
//                     await Promise.race([
//                         frame.evaluate(() => {
//                             document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                         }),
//                         new Promise(r => setTimeout(r, 800))
//                     ]).catch(() => {});
//                 }
//             }
//             if (deadStrikes >= 10 || health.status === 'CRITICAL_ERROR') {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl(`${health.status} -> FAILOVER NEXT URL`);
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1; lastFrames = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 30 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     // Pre-seed Chrome Profile with Widevine CDM so Linux Chrome enables DRM on First Boot
//     const userDataDir = path.join(os.tmpdir(), 'chrome-drm-profile');
//     const widevineHintDir = path.join(userDataDir, 'WidevineCdm');
//     const defaultProfileDir = path.join(userDataDir, 'Default');
//     fs.mkdirSync(widevineHintDir, { recursive: true });
//     fs.mkdirSync(defaultProfileDir, { recursive: true });

//     const systemWidevinePaths = [
//         '/opt/google/chrome/WidevineCdm',
//         '/usr/lib/chromium/WidevineCdm',
//         '/usr/lib/chromium-browser/WidevineCdm'
//     ];
//     const activeWidevinePath = systemWidevinePaths.find(p => fs.existsSync(p)) || '/opt/google/chrome/WidevineCdm';

//     fs.writeFileSync(
//         path.join(widevineHintDir, 'latest-component-updated-widevine-cdm'),
//         JSON.stringify({ Path: activeWidevinePath })
//     );
//     fs.writeFileSync(
//         path.join(defaultProfileDir, 'Preferences'),
//         JSON.stringify({
//             profile: { content_settings: { exceptions: { protected_media_identifier: { '*': { setting: 1 } } } } },
//             webkit: { webprefs: { encrypted_media_enabled: true } }
//         })
//     );

//     // FIXED: Added Script 2's exact Xvfb/Linux video rendering & anti-occlusion flags alongside Script 1's Widevine flags
//    const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled',
//         '--disable-background-timer-throttling',
//         '--disable-backgrounding-occluded-windows',
//         '--disable-renderer-backgrounding',
//         '--enable-widevine',
//         '--enable-features=EncryptedMedia,Widevine',
//         '--disable-features=PermissionsPolicyHeader,WebRtcHideLocalIpsWithMdns,DisableLoadExtensionCommandLineSwitch,CalculateNativeWinOcclusion',
//         '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
//         '--enforce-webrtc-ip-permission-check'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded (DRM-Safe Mode)!');
//     }

//     const chromePaths = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
//     const executablePath = chromePaths.find(p => fs.existsSync(p));
//     if (executablePath) console.log(`[🌐] Launching Official Chrome with Widevine DRM (${activeWidevinePath})`);

//     browser = await puppeteer.launch({
//         headless: false,
//         executablePath: executablePath || undefined,
//         userDataDir: userDataDir,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: [
//             '--enable-automation',
//             '--disable-extensions',
//             '--disable-component-update',
//             '--disable-component-extensions-with-background-pages',
//             '--disable-default-apps'
//         ],
//         args
//     });

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         const tType = target.type();
//         if (tType === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 150);
//             }
//         } else if (tType === 'other' || tType === 'iframe') {
//             await attachCdpAdBlocker(target);
//         }
//     });

//     hideOBSAndFocusChromeOnce();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// // =========================================================================================
// // ⏱️ SMART DURATION & 6-HOUR HANDOVER TIMER (Supports 3h, 180m, 24/7)
// // =========================================================================================
// const rawDuration = (process.env.CUSTOM_DURATION || '24/7').trim().toLowerCase();
// const MAX_RUNNER_MS = 21000000; // 5 hours 50 minutes (350 mins)
// let totalDurationMs = Infinity;

// if (rawDuration !== '24/7' && rawDuration !== 'none' && rawDuration !== '') {
//     const hMatch = rawDuration.match(/(\d+(\.\d+)?)\s*h/);
//     const mMatch = rawDuration.match(/(\d+)\s*m/);
//     if (hMatch) {
//         totalDurationMs = Math.round(parseFloat(hMatch[1]) * 3600 * 1000);
//     } else if (mMatch) {
//         totalDurationMs = parseInt(mMatch[1], 10) * 60 * 1000;
//     } else if (!isNaN(rawDuration)) {
//         totalDurationMs = parseFloat(rawDuration) * 60 * 1000;
//     }
// }

// if (totalDurationMs <= MAX_RUNNER_MS) {
//     console.log(`[⏱️] Stream Duration Set: ${rawDuration} (${Math.round(totalDurationMs / 60000)} mins). Will auto-stop when finished.`);
//     setTimeout(async () => {
//         console.log(`\n[🛑] Scheduled Duration (${rawDuration}) Completed! Stopping stream cleanly...`);
//         await cleanup();
//         process.exit(0);
//     }, totalDurationMs);
// } else {
//     console.log(`[⏱️] Long/24x7 Stream Mode (${rawDuration}). Will handover after 5h 50m.`);
//     setTimeout(() => {
//         try {
//             let nextDuration = '24/7';
//             if (totalDurationMs !== Infinity) {
//                 const remMins = Math.max(1, Math.round((totalDurationMs - MAX_RUNNER_MS) / 60000));
//                 nextDuration = `${remMins}m`;
//             }
//             const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}" -f custom_duration="${nextDuration}"`;
//             execSync(cmd, { stdio: 'inherit' });
//             setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//         } catch (e) {}
//     }, MAX_RUNNER_MS);
// }

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();






























// =================== issue daa osam werky yar ==============================
// =============================
// ==============================================





// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (With OBS 30+ WebSocket Plugin Fix)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     // Legacy + Modern OBS WebSocket Config
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Advanced\n[AdvOut]\nTrackIndex=1\nRecType=Standard\nEncoder=obs_x264\n[obs_x264]\nbitrate=${BITRATE}\nkeyint_sec=2\npreset=ultrafast\nprofile=main\ntune=zerolatency\n`);

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     // MainScene set as default so video + audio broadcast even if WebSocket is delayed
//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb Fix)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI
// // =========================================================================================
// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI (DRM-Safe CDP + Windows 11 Anti-Detect Spoof)
// // =========================================================================================
// const AD_BLOCK_PATTERNS = [
//     '*popads*', '*popcash*', '*exoclick*', '*adsterra*', '*onclickads*',
//     '*doubleclick*', '*googlesyndication*', '*adexchangerapid*', '*bet365*', '*1xbet*',
//     '*propellerads*', '*hilltopads*', '*trafficjunky*', '*juicyads*', '*clickadu*',
//     '*adcash*', '*galaksion*', '*bidvertiser*', '*revcontent*', '*mgid*',
//     '*taboola*', '*outbrain*', '*acscdn*', '*histats*', '*usrpubtrk*',
//     '*clarity.ms*', '*yandex.ru/metrika*', '*adsco.re*', '*a-ads.com*', '*bidgear*'
// ];

// async function attachCdpAdBlocker(target) {
//     try {
//         const client = await target.createCDPSession();
//         await client.send('Network.enable');
//         await client.send('Network.setBlockedURLs', { urls: AD_BLOCK_PATTERNS });
//     } catch (e) {}
// }

// async function setupPageProtections(p) {
//     try {
//         // 1. Native CDP Ad-Blocker (Does NOT touch or corrupt JW Player DRM/HLS token headers)
//         await attachCdpAdBlocker(p.target());

//         // 2. Spoof Windows 11 + NVIDIA GPU so Backend CDN doesn't block Linux GitHub Runner
//         await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;

//             // Hide Linux & Headless indicators from Player Anti-Bot scripts
//             Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
//             Object.defineProperty(navigator, 'webdriver', { get: () => false });
//             Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
//             Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

//             // Spoof WebGL Renderer (Hides Google SwiftShader / Virtual Xvfb GPU)
//             const getParameter = WebGLRenderingContext.prototype.getParameter;
//             WebGLRenderingContext.prototype.getParameter = function(param) {
//                 if (param === 37445) return 'Google Inc. (NVIDIA)';
//                 if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                 return getParameter.apply(this, arguments);
//             };

//             // Inject encrypted-media permission into every iframe BEFORE it loads
//             const drmAllow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write';
//             const patchIframe = (el) => {
//                 if (el && el.tagName === 'IFRAME') {
//                     if (!el.allow || !el.allow.includes('encrypted-media')) {
//                         el.setAttribute('allow', drmAllow);
//                     }
//                 }
//             };
//             const obs = new MutationObserver((mutations) => {
//                 for (const m of mutations) {
//                     for (const node of m.addedNodes) {
//                         if (node.nodeType === 1) {
//                             patchIframe(node);
//                             if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(patchIframe);
//                         }
//                     }
//                 }
//             });
//             obs.observe(document, { childList: true, subtree: true });

//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             if (document.documentElement) document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await p.evaluate((t, s) => {
//             if (window.self !== window.top) return;
//             let el = document.getElementById('bot-loading-ui');
//             if (!el) {
//                 el = document.createElement('div');
//                 el.id = 'bot-loading-ui';
//                 el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                 document.documentElement.appendChild(el);
//             }
//             el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//         }, title, subtitle);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await p.evaluate(() => {
//             const el = document.getElementById('bot-loading-ui');
//             if (el) el.remove();
//         });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Supports Nested Iframes like webcric)
// // =========================================================================================
// let currentPlayerTab = 0;

// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames + Instant Switch on "Protected Content" (403)
//         for (let attempt = 0; attempt < 10; attempt++) {
//             let hasProtectedError = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const errFound = await frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         return txt.includes('protected content') || txt.includes('232403') || txt.includes('cannot be played') || txt.includes('error code');
//                     });
//                     if (errFound) { hasProtectedError = true; break; }
//                 } catch (e) {}
//             }

//             if (hasProtectedError) {
//                 currentPlayerTab++;
//                 // Un-lock fullscreen iframe on main page FIRST so clicking the next Player button actually swaps the iframe!
//                 await p.evaluate((tabIdx) => {
//                     document.querySelectorAll('iframe').forEach(f => {
//                         f.style.cssText = 'width:100%;height:500px;position:relative;z-index:1;display:block;visibility:visible;';
//                     });
//                     // Find unique clickable Player / Server / Stream buttons or links
//                     const allEls = Array.from(document.querySelectorAll('a, button, .btn, [onclick], [data-stream], [data-server], li'));
//                     const playerBtns = allEls.filter(el => {
//                         if (el.children.length > 1) return false; // Avoid parent wrapper divs
//                         const t = (el.innerText || '').trim();
//                         return /^(Player|Server|Stream|Channel|Link|HD|Backup|Mirror)\s*\d*$/i.test(t) || /player|stream|embed|watch/i.test(el.getAttribute('href') || '') || el.hasAttribute('onclick');
//                     });
//                     if (playerBtns.length > 0) {
//                         const targetBtn = playerBtns[tabIdx % playerBtns.length];
//                         targetBtn.click();
//                     }
//                 }, currentPlayerTab).catch(() => {});
//                 console.log(`[⚡] Protected Content (403) -> Switched immediately to Player option #${currentPlayerTab + 1}`);
//                 await new Promise(r => setTimeout(r, 3500));
//             }

//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await frame.evaluate((audioEnabled) => {
//                         let isPlaying = false;
//                         const videos = document.querySelectorAll('video');

//                         videos.forEach(v => {
//                             // Unmute & set volume without clicking the video element
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;

//                             // ONLY call v.play() if it is actually paused! Never click <video> or .clappr-player
//                             if (v.paused) {
//                                 v.play().catch(() => {});
//                             }
//                             if (!v.paused && v.readyState >= 2) {
//                                 isPlaying = true;
//                             }
//                         });

//                         // ONLY click play overlays if NO video is playing yet
//                         if (!isPlaying) {
//                             const playSelectors = '.jw-display-icon-display, button[data-plyr="play"], .vjs-big-play-button, .player-poster[class*="clickable"]';
//                             document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });
//                         }

//                         // Click dedicated unmute buttons ONLY if they exist
//                         if (audioEnabled) {
//                             document.querySelectorAll('[class*="unmute"], .jw-icon-volume').forEach(el => {
//                                 const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
//                                 if (txt.includes('unmute') || el.className.includes('unmute')) {
//                                     try { el.click(); } catch(e){}
//                                 }
//                             });
//                         }

//                         return isPlaying;
//                     }, ENABLE_STREAM_AUDIO);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // Stretch largest iframe OR video ONLY when no "protected content" error is on screen
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await frame.evaluate((audioEnabled) => {
//                 if (window.__frameLockActive) return;
//                 window.__frameLockActive = true;
//                 setInterval(() => {
//                     const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                     if (txt.includes('protected content') || txt.includes('232403')) return; // Do NOT lock broken error frame!

//                     document.documentElement.style.setProperty('background', '#000', 'important');
//                     if (document.body) document.body.style.setProperty('background', '#000', 'important');

//                     const v = document.querySelector('video');
//                     if (v && (v.clientWidth > 50 || !v.paused)) {
//                         // Crucial Fix: If anything pauses the video, immediately resume it via JS API!
//                         if (v.paused) v.play().catch(() => {});
//                         v.muted = !audioEnabled;
//                         v.volume = audioEnabled ? 1.0 : 0.0;
//                         const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
//                         wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
//                         v.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483647 !important;background:#000 !important;object-fit:contain !important;pointer-events:none !important;';

//                         // Nuke every overlay ad, banner, iframe, or fake close button inside the video frame
//                         document.querySelectorAll('body *').forEach(el => {
//                             if (el === v || el.contains(v) || el.tagName === 'STYLE' || el.tagName === 'SCRIPT') return;
//                             el.style.setProperty('display', 'none', 'important');
//                             el.style.setProperty('visibility', 'hidden', 'important');
//                             el.style.setProperty('opacity', '0', 'important');
//                         });
//                         return;
//                     }

//                     // Maximize active player iframe & hide all surrounding page ads/banners
//                     const iframes = Array.from(document.querySelectorAll('iframe'));
//                     let best = null, maxArea = 5000;
//                     iframes.forEach(f => {
//                         const src = (f.src || '').toLowerCase();
//                         if (/popads|exoclick|adsterra|doubleclick|bet365|1xbet|juicyads|clickadu|propeller/i.test(src)) {
//                             f.remove();
//                             return;
//                         }
//                         const area = f.clientWidth * f.clientHeight;
//                         if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
//                     });
//                     if (best) {
//                         best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
//                         // Hide floating page ads/overlays while keeping player switcher buttons clickable in DOM
//                         document.querySelectorAll('body *').forEach(el => {
//                             if (el === best || el.contains(best) || el.id === 'bot-loading-ui' || el.tagName === 'STYLE' || el.tagName === 'SCRIPT') return;
//                             el.style.setProperty('opacity', '0', 'important');
//                             el.style.setProperty('pointer-events', 'none', 'important');
//                             el.style.setProperty('z-index', '-9999', 'important');
//                         });
//                     }
//                 }, 1000);
//             }, ENABLE_STREAM_AUDIO).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         if (txt.includes('protected content') || txt.includes('232403')) return null;

//                         const videos = Array.from(document.querySelectorAll('video'));
//                         for (const v of videos) {
//                             if (!v.paused && v.readyState >= 2 && v.currentTime > 0) {
//                                 const frames = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : (v.webkitDecodedFrameCount || 0);
//                                 return { status: 'HEALTHY', currentTime: v.currentTime, frames };
//                             }
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);
//         // Pick the video with the highest decoded frame count so dummy/ad videos never cause a false freeze!
//         const healthyList = results.filter(r => r && r.status === 'HEALTHY');
//         if (healthyList.length > 0) {
//             healthyList.sort((a, b) => (b.frames || 0) - (a.frames || 0));
//             return healthyList[0];
//         }
//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     const targetUrl = urlList[currentUrlIndex];
//     console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//     try {
//         await page.goto('about:blank');
//         await page.bringToFront();
//         keepChromeOnTopAndHideOBS();
//         await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//         await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
//         await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//         await lockAndPlayVideo(page);
//         await hideLoadingOverlay(page);
//         keepChromeOnTopAndHideOBS();
//     } catch (e) {
//         console.log(`[⚠️] Page navigation warning: ${e.message}`);
//     }
//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;
            
//             // 1. Check if video is perfectly frozen
//             const isStuck = (lastTime !== -1 && health.currentTime === lastTime && health.frames === lastFrames);

//             // 2. Check if video is looping (DVR Trap)
//             let isLooping = false;
//             if (lastTime !== -1 && health.currentTime < lastTime && (lastTime - health.currentTime > 3)) {
//                 isLooping = true;
//                 console.log(`[⚠️] DVR/Loop Trap Detected! Time jumped backwards from ${lastTime.toFixed(1)}s to ${health.currentTime.toFixed(1)}s`);
//             }

//             if (isStuck || isLooping) {
//                 if (isLooping || (Date.now() - freezeStart > 18000)) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl(isLooping ? 'VIDEO LOOPING (FAILOVER)' : 'VIDEO FROZEN (18s)');
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED 9-MIN REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/12`);
//             // Gently force video.play() across all frames without re-clicking the player UI
//             for (const frame of page.frames()) {
//                 if (!frame.isDetached()) {
//                     await frame.evaluate(() => {
//                         document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                     }).catch(() => {});
//                 }
//             }
//             if (deadStrikes >= 12) {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('12 STRIKES -> FAILOVER NEXT URL');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 90 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     // Restored OBS Console Logs so you can verify RTMP streaming in GitHub Actions
//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     // 1. Pre-seed Chrome Profile with Widevine CDM so Linux Chrome enables DRM on First Boot
//     const userDataDir = path.join(os.tmpdir(), 'chrome-drm-profile');
//     const widevineHintDir = path.join(userDataDir, 'WidevineCdm');
//     const defaultProfileDir = path.join(userDataDir, 'Default');
//     fs.mkdirSync(widevineHintDir, { recursive: true });
//     fs.mkdirSync(defaultProfileDir, { recursive: true });

//     const systemWidevinePaths = [
//         '/opt/google/chrome/WidevineCdm',
//         '/usr/lib/chromium/WidevineCdm',
//         '/usr/lib/chromium-browser/WidevineCdm'
//     ];
//     const activeWidevinePath = systemWidevinePaths.find(p => fs.existsSync(p)) || '/opt/google/chrome/WidevineCdm';

//     fs.writeFileSync(
//         path.join(widevineHintDir, 'latest-component-updated-widevine-cdm'),
//         JSON.stringify({ Path: activeWidevinePath })
//     );
//     fs.writeFileSync(
//         path.join(defaultProfileDir, 'Preferences'),
//         JSON.stringify({
//             profile: { content_settings: { exceptions: { protected_media_identifier: { '*': { setting: 1 } } } } },
//             webkit: { webprefs: { encrypted_media_enabled: true } }
//         })
//     );

//     const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled',
//         '--enable-widevine',
//         '--enable-features=EncryptedMedia,Widevine',
//         '--disable-features=PermissionsPolicyHeader,WebRtcHideLocalIpsWithMdns,DisableLoadExtensionCommandLineSwitch',
//         '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
//         '--enforce-webrtc-ip-permission-check'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     // Load uBlock WITHOUT --disable-extensions-except (which kills Chrome's internal Widevine component)
//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded (DRM-Safe Mode)!');
//     }

//     const chromePaths = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
//     const executablePath = chromePaths.find(p => fs.existsSync(p));
//     if (executablePath) console.log(`[🌐] Launching Official Chrome with Widevine DRM (${activeWidevinePath})`);

//     browser = await puppeteer.launch({
//         headless: false,
//         executablePath: executablePath || undefined,
//         userDataDir: userDataDir,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: [
//             '--enable-automation',
//             '--disable-extensions',
//             '--disable-component-update',
//             '--disable-component-extensions-with-background-pages',
//             '--disable-default-apps'
//         ],
//         args
//     });

//     page = (await browser.pages())[0];

//    browser.on('targetcreated', async (target) => {
//         const tType = target.type();
//         if (tType === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 150);
//             }
//         } else if (tType === 'other' || tType === 'iframe') {
//             // Apply CDP Ad-Blocker to every nested cross-origin player iframe!
//             await attachCdpAdBlocker(target);
//         }
//     });

//     keepChromeOnTopAndHideOBS();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// // =========================================================================================
// // ⏱️ SMART DURATION & 6-HOUR HANDOVER TIMER (Supports 3h, 180m, 24/7)
// // =========================================================================================
// const rawDuration = (process.env.CUSTOM_DURATION || '24/7').trim().toLowerCase();
// const MAX_RUNNER_MS = 21000000; // 5 hours 50 minutes (350 mins)
// let totalDurationMs = Infinity;

// if (rawDuration !== '24/7' && rawDuration !== 'none' && rawDuration !== '') {
//     const hMatch = rawDuration.match(/(\d+(\.\d+)?)\s*h/);
//     const mMatch = rawDuration.match(/(\d+)\s*m/);
//     if (hMatch) {
//         totalDurationMs = Math.round(parseFloat(hMatch[1]) * 3600 * 1000);
//     } else if (mMatch) {
//         totalDurationMs = parseInt(mMatch[1], 10) * 60 * 1000;
//     } else if (!isNaN(rawDuration)) {
//         totalDurationMs = parseFloat(rawDuration) * 60 * 1000;
//     }
// }

// if (totalDurationMs <= MAX_RUNNER_MS) {
//     console.log(`[⏱️] Stream Duration Set: ${rawDuration} (${Math.round(totalDurationMs / 60000)} mins). Will auto-stop when finished.`);
//     setTimeout(async () => {
//         console.log(`\n[🛑] Scheduled Duration (${rawDuration}) Completed! Stopping stream cleanly...`);
//         await cleanup();
//         process.exit(0);
//     }, totalDurationMs);
// } else {
//     console.log(`[⏱️] Long/24x7 Stream Mode (${rawDuration}). Will handover after 5h 50m.`);
//     setTimeout(() => {
//         try {
//             let nextDuration = '24/7';
//             if (totalDurationMs !== Infinity) {
//                 const remMins = Math.max(1, Math.round((totalDurationMs - MAX_RUNNER_MS) / 60000));
//                 nextDuration = `${remMins}m`;
//             }
//             const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}" -f custom_duration="${nextDuration}"`;
//             execSync(cmd, { stdio: 'inherit' });
//             setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//         } catch (e) {}
//     }, MAX_RUNNER_MS);
// }

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();


















































// ==================== alhamdullah the uefa nation league matches play well ========================
// ==========================================================================
// ==================== 1st prioty only =======================================================








// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (With OBS 30+ WebSocket Plugin Fix)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     // Legacy + Modern OBS WebSocket Config
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Advanced\n[AdvOut]\nTrackIndex=1\nRecType=Standard\nEncoder=obs_x264\n[obs_x264]\nbitrate=${BITRATE}\nkeyint_sec=2\npreset=ultrafast\nprofile=main\ntune=zerolatency\n`);

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     // MainScene set as default so video + audio broadcast even if WebSocket is delayed
//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb Fix)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI
// // =========================================================================================
// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI (DRM-Safe CDP + Windows 11 Anti-Detect Spoof)
// // =========================================================================================
// const AD_BLOCK_PATTERNS = [
//     '*popads*', '*popcash*', '*exoclick*', '*adsterra*', '*onclickads*',
//     '*doubleclick*', '*googlesyndication*', '*adexchangerapid*', '*bet365*', '*1xbet*',
//     '*propellerads*', '*hilltopads*', '*trafficjunky*', '*juicyads*', '*clickadu*',
//     '*adcash*', '*galaksion*', '*bidvertiser*', '*revcontent*', '*mgid*',
//     '*taboola*', '*outbrain*', '*acscdn*', '*histats*', '*usrpubtrk*',
//     '*clarity.ms*', '*yandex.ru/metrika*', '*adsco.re*', '*a-ads.com*', '*bidgear*'
// ];

// async function attachCdpAdBlocker(target) {
//     try {
//         const client = await target.createCDPSession();
//         await client.send('Network.enable');
//         await client.send('Network.setBlockedURLs', { urls: AD_BLOCK_PATTERNS });
//     } catch (e) {}
// }

// async function setupPageProtections(p) {
//     try {
//         // 1. Native CDP Ad-Blocker (Does NOT touch or corrupt JW Player DRM/HLS token headers)
//         await attachCdpAdBlocker(p.target());

//         // 2. Spoof Windows 11 + NVIDIA GPU so Backend CDN doesn't block Linux GitHub Runner
//         await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;

//             // Hide Linux & Headless indicators from Player Anti-Bot scripts
//             Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
//             Object.defineProperty(navigator, 'webdriver', { get: () => false });
//             Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
//             Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

//             // Spoof WebGL Renderer (Hides Google SwiftShader / Virtual Xvfb GPU)
//             const getParameter = WebGLRenderingContext.prototype.getParameter;
//             WebGLRenderingContext.prototype.getParameter = function(param) {
//                 if (param === 37445) return 'Google Inc. (NVIDIA)';
//                 if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                 return getParameter.apply(this, arguments);
//             };

//             // Inject encrypted-media permission into every iframe BEFORE it loads
//             const drmAllow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write';
//             const patchIframe = (el) => {
//                 if (el && el.tagName === 'IFRAME') {
//                     if (!el.allow || !el.allow.includes('encrypted-media')) {
//                         el.setAttribute('allow', drmAllow);
//                     }
//                 }
//             };
//             const obs = new MutationObserver((mutations) => {
//                 for (const m of mutations) {
//                     for (const node of m.addedNodes) {
//                         if (node.nodeType === 1) {
//                             patchIframe(node);
//                             if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(patchIframe);
//                         }
//                     }
//                 }
//             });
//             obs.observe(document, { childList: true, subtree: true });

//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             if (document.documentElement) document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await p.evaluate((t, s) => {
//             if (window.self !== window.top) return;
//             let el = document.getElementById('bot-loading-ui');
//             if (!el) {
//                 el = document.createElement('div');
//                 el.id = 'bot-loading-ui';
//                 el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                 document.documentElement.appendChild(el);
//             }
//             el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//         }, title, subtitle);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await p.evaluate(() => {
//             const el = document.getElementById('bot-loading-ui');
//             if (el) el.remove();
//         });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Supports Nested Iframes like webcric)
// // =========================================================================================
// let currentPlayerTab = 0;

// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames + Instant Switch on "Protected Content" (403)
//         for (let attempt = 0; attempt < 10; attempt++) {
//             let hasProtectedError = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const errFound = await frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         return txt.includes('protected content') || txt.includes('232403') || txt.includes('cannot be played') || txt.includes('error code');
//                     });
//                     if (errFound) { hasProtectedError = true; break; }
//                 } catch (e) {}
//             }

//             if (hasProtectedError) {
//                 currentPlayerTab++;
//                 // Un-lock fullscreen iframe on main page FIRST so clicking the next Player button actually swaps the iframe!
//                 await p.evaluate((tabIdx) => {
//                     document.querySelectorAll('iframe').forEach(f => {
//                         f.style.cssText = 'width:100%;height:500px;position:relative;z-index:1;display:block;visibility:visible;';
//                     });
//                     // Find unique clickable Player / Server / Stream buttons or links
//                     const allEls = Array.from(document.querySelectorAll('a, button, .btn, [onclick], [data-stream], [data-server], li'));
//                     const playerBtns = allEls.filter(el => {
//                         if (el.children.length > 1) return false; // Avoid parent wrapper divs
//                         const t = (el.innerText || '').trim();
//                         return /^(Player|Server|Stream|Channel|Link|HD|Backup|Mirror)\s*\d*$/i.test(t) || /player|stream|embed|watch/i.test(el.getAttribute('href') || '') || el.hasAttribute('onclick');
//                     });
//                     if (playerBtns.length > 0) {
//                         const targetBtn = playerBtns[tabIdx % playerBtns.length];
//                         targetBtn.click();
//                     }
//                 }, currentPlayerTab).catch(() => {});
//                 console.log(`[⚡] Protected Content (403) -> Switched immediately to Player option #${currentPlayerTab + 1}`);
//                 await new Promise(r => setTimeout(r, 3500));
//             }

//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await frame.evaluate((audioEnabled) => {
//                         let isPlaying = false;
//                         const videos = document.querySelectorAll('video');

//                         videos.forEach(v => {
//                             // Unmute & set volume without clicking the video element
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;

//                             // ONLY call v.play() if it is actually paused! Never click <video> or .clappr-player
//                             if (v.paused) {
//                                 v.play().catch(() => {});
//                             }
//                             if (!v.paused && v.readyState >= 2) {
//                                 isPlaying = true;
//                             }
//                         });

//                         // ONLY click play overlays if NO video is playing yet
//                         if (!isPlaying) {
//                             const playSelectors = '.jw-display-icon-display, button[data-plyr="play"], .vjs-big-play-button, .player-poster[class*="clickable"]';
//                             document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });
//                         }

//                         // Click dedicated unmute buttons ONLY if they exist
//                         if (audioEnabled) {
//                             document.querySelectorAll('[class*="unmute"], .jw-icon-volume').forEach(el => {
//                                 const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
//                                 if (txt.includes('unmute') || el.className.includes('unmute')) {
//                                     try { el.click(); } catch(e){}
//                                 }
//                             });
//                         }

//                         return isPlaying;
//                     }, ENABLE_STREAM_AUDIO);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // Stretch largest iframe OR video ONLY when no "protected content" error is on screen
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await frame.evaluate((audioEnabled) => {
//                 if (window.__frameLockActive) return;
//                 window.__frameLockActive = true;
//                 setInterval(() => {
//                     const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                     if (txt.includes('protected content') || txt.includes('232403')) return; // Do NOT lock broken error frame!

//                     document.documentElement.style.setProperty('background', '#000', 'important');
//                     if (document.body) document.body.style.setProperty('background', '#000', 'important');

//                     const v = document.querySelector('video');
//                     if (v && (v.clientWidth > 50 || !v.paused)) {
//                         // Crucial Fix: If anything pauses the video, immediately resume it via JS API!
//                         if (v.paused) v.play().catch(() => {});
//                         v.muted = !audioEnabled;
//                         v.volume = audioEnabled ? 1.0 : 0.0;
//                         const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
//                         wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
//                         v.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483647 !important;background:#000 !important;object-fit:contain !important;pointer-events:none !important;';

//                         // Nuke every overlay ad, banner, iframe, or fake close button inside the video frame
//                         document.querySelectorAll('body *').forEach(el => {
//                             if (el === v || el.contains(v) || el.tagName === 'STYLE' || el.tagName === 'SCRIPT') return;
//                             el.style.setProperty('display', 'none', 'important');
//                             el.style.setProperty('visibility', 'hidden', 'important');
//                             el.style.setProperty('opacity', '0', 'important');
//                         });
//                         return;
//                     }

//                     // Maximize active player iframe & hide all surrounding page ads/banners
//                     const iframes = Array.from(document.querySelectorAll('iframe'));
//                     let best = null, maxArea = 5000;
//                     iframes.forEach(f => {
//                         const src = (f.src || '').toLowerCase();
//                         if (/popads|exoclick|adsterra|doubleclick|bet365|1xbet|juicyads|clickadu|propeller/i.test(src)) {
//                             f.remove();
//                             return;
//                         }
//                         const area = f.clientWidth * f.clientHeight;
//                         if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
//                     });
//                     if (best) {
//                         best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
//                         // Hide floating page ads/overlays while keeping player switcher buttons clickable in DOM
//                         document.querySelectorAll('body *').forEach(el => {
//                             if (el === best || el.contains(best) || el.id === 'bot-loading-ui' || el.tagName === 'STYLE' || el.tagName === 'SCRIPT') return;
//                             el.style.setProperty('opacity', '0', 'important');
//                             el.style.setProperty('pointer-events', 'none', 'important');
//                             el.style.setProperty('z-index', '-9999', 'important');
//                         });
//                     }
//                 }, 1000);
//             }, ENABLE_STREAM_AUDIO).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         if (txt.includes('protected content') || txt.includes('232403')) return null;

//                         const videos = Array.from(document.querySelectorAll('video'));
//                         for (const v of videos) {
//                             if (!v.paused && v.readyState >= 2 && v.currentTime > 0) {
//                                 const frames = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : (v.webkitDecodedFrameCount || 0);
//                                 return { status: 'HEALTHY', currentTime: v.currentTime, frames };
//                             }
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);
//         // Pick the video with the highest decoded frame count so dummy/ad videos never cause a false freeze!
//         const healthyList = results.filter(r => r && r.status === 'HEALTHY');
//         if (healthyList.length > 0) {
//             healthyList.sort((a, b) => (b.frames || 0) - (a.frames || 0));
//             return healthyList[0];
//         }
//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     const targetUrl = urlList[currentUrlIndex];
//     console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//     try {
//         await page.goto('about:blank');
//         await page.bringToFront();
//         keepChromeOnTopAndHideOBS();
//         await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//         await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
//         await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//         await lockAndPlayVideo(page);
//         await hideLoadingOverlay(page);
//         keepChromeOnTopAndHideOBS();
//     } catch (e) {
//         console.log(`[⚠️] Page navigation warning: ${e.message}`);
//     }
//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;
//             const isStuck = (lastTime !== -1 && health.currentTime === lastTime && health.frames === lastFrames);

//             if (isStuck) {
//                 if (Date.now() - freezeStart > 18000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl('VIDEO FROZEN (18s)');
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED 9-MIN REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/12`);
//             // Gently force video.play() across all frames without re-clicking the player UI
//             for (const frame of page.frames()) {
//                 if (!frame.isDetached()) {
//                     await frame.evaluate(() => {
//                         document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                     }).catch(() => {});
//                 }
//             }
//             if (deadStrikes >= 12) {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('12 STRIKES -> FAILOVER NEXT URL');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 90 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     // Restored OBS Console Logs so you can verify RTMP streaming in GitHub Actions
//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     // 1. Pre-seed Chrome Profile with Widevine CDM so Linux Chrome enables DRM on First Boot
//     const userDataDir = path.join(os.tmpdir(), 'chrome-drm-profile');
//     const widevineHintDir = path.join(userDataDir, 'WidevineCdm');
//     const defaultProfileDir = path.join(userDataDir, 'Default');
//     fs.mkdirSync(widevineHintDir, { recursive: true });
//     fs.mkdirSync(defaultProfileDir, { recursive: true });

//     const systemWidevinePaths = [
//         '/opt/google/chrome/WidevineCdm',
//         '/usr/lib/chromium/WidevineCdm',
//         '/usr/lib/chromium-browser/WidevineCdm'
//     ];
//     const activeWidevinePath = systemWidevinePaths.find(p => fs.existsSync(p)) || '/opt/google/chrome/WidevineCdm';

//     fs.writeFileSync(
//         path.join(widevineHintDir, 'latest-component-updated-widevine-cdm'),
//         JSON.stringify({ Path: activeWidevinePath })
//     );
//     fs.writeFileSync(
//         path.join(defaultProfileDir, 'Preferences'),
//         JSON.stringify({
//             profile: { content_settings: { exceptions: { protected_media_identifier: { '*': { setting: 1 } } } } },
//             webkit: { webprefs: { encrypted_media_enabled: true } }
//         })
//     );

//     const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled',
//         '--enable-widevine',
//         '--enable-features=EncryptedMedia,Widevine',
//         '--disable-features=PermissionsPolicyHeader,WebRtcHideLocalIpsWithMdns,DisableLoadExtensionCommandLineSwitch',
//         '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
//         '--enforce-webrtc-ip-permission-check'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     // Load uBlock WITHOUT --disable-extensions-except (which kills Chrome's internal Widevine component)
//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded (DRM-Safe Mode)!');
//     }

//     const chromePaths = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
//     const executablePath = chromePaths.find(p => fs.existsSync(p));
//     if (executablePath) console.log(`[🌐] Launching Official Chrome with Widevine DRM (${activeWidevinePath})`);

//     browser = await puppeteer.launch({
//         headless: false,
//         executablePath: executablePath || undefined,
//         userDataDir: userDataDir,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: [
//             '--enable-automation',
//             '--disable-extensions',
//             '--disable-component-update',
//             '--disable-component-extensions-with-background-pages',
//             '--disable-default-apps'
//         ],
//         args
//     });

//     page = (await browser.pages())[0];

//    browser.on('targetcreated', async (target) => {
//         const tType = target.type();
//         if (tType === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 150);
//             }
//         } else if (tType === 'other' || tType === 'iframe') {
//             // Apply CDP Ad-Blocker to every nested cross-origin player iframe!
//             await attachCdpAdBlocker(target);
//         }
//     });

//     keepChromeOnTopAndHideOBS();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// // =========================================================================================
// // ⏱️ SMART DURATION & 6-HOUR HANDOVER TIMER (Supports 3h, 180m, 24/7)
// // =========================================================================================
// const rawDuration = (process.env.CUSTOM_DURATION || '24/7').trim().toLowerCase();
// const MAX_RUNNER_MS = 21000000; // 5 hours 50 minutes (350 mins)
// let totalDurationMs = Infinity;

// if (rawDuration !== '24/7' && rawDuration !== 'none' && rawDuration !== '') {
//     const hMatch = rawDuration.match(/(\d+(\.\d+)?)\s*h/);
//     const mMatch = rawDuration.match(/(\d+)\s*m/);
//     if (hMatch) {
//         totalDurationMs = Math.round(parseFloat(hMatch[1]) * 3600 * 1000);
//     } else if (mMatch) {
//         totalDurationMs = parseInt(mMatch[1], 10) * 60 * 1000;
//     } else if (!isNaN(rawDuration)) {
//         totalDurationMs = parseFloat(rawDuration) * 60 * 1000;
//     }
// }

// if (totalDurationMs <= MAX_RUNNER_MS) {
//     console.log(`[⏱️] Stream Duration Set: ${rawDuration} (${Math.round(totalDurationMs / 60000)} mins). Will auto-stop when finished.`);
//     setTimeout(async () => {
//         console.log(`\n[🛑] Scheduled Duration (${rawDuration}) Completed! Stopping stream cleanly...`);
//         await cleanup();
//         process.exit(0);
//     }, totalDurationMs);
// } else {
//     console.log(`[⏱️] Long/24x7 Stream Mode (${rawDuration}). Will handover after 5h 50m.`);
//     setTimeout(() => {
//         try {
//             let nextDuration = '24/7';
//             if (totalDurationMs !== Infinity) {
//                 const remMins = Math.max(1, Math.round((totalDurationMs - MAX_RUNNER_MS) / 60000));
//                 nextDuration = `${remMins}m`;
//             }
//             const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}" -f custom_duration="${nextDuration}"`;
//             execSync(cmd, { stdio: 'inherit' });
//             setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//         } catch (e) {}
//     }, MAX_RUNNER_MS);
// }

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();




























































// ================= yeh code hai yeh abey teek kaam kar raha hai dlhd me and bas abey ads arahy hai =================



// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (With OBS 30+ WebSocket Plugin Fix)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     // Legacy + Modern OBS WebSocket Config
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Advanced\n[AdvOut]\nTrackIndex=1\nRecType=Standard\nEncoder=obs_x264\n[obs_x264]\nbitrate=${BITRATE}\nkeyint_sec=2\npreset=ultrafast\nprofile=main\ntune=zerolatency\n`);

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     // MainScene set as default so video + audio broadcast even if WebSocket is delayed
//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb Fix)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI
// // =========================================================================================
// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI (DRM-Safe CDP + Windows 11 Anti-Detect Spoof)
// // =========================================================================================
// async function setupPageProtections(p) {
//     try {
//         // 1. Native CDP Ad-Blocker (Does NOT touch or corrupt JW Player DRM/HLS token headers)
//         const client = await p.target().createCDPSession();
//         await client.send('Network.enable');
//         await client.send('Network.setBlockedURLs', {
//             urls: [
//                 '*popads*', '*exoclick*', '*adsterra*', '*onclickads*',
//                 '*doubleclick*', '*adexchangerapid*', '*bet365*', '*1xbet*'
//             ]
//         });

//         // 2. Spoof Windows 11 + NVIDIA GPU so Backend CDN doesn't block Linux GitHub Runner
//         await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;

//             // Hide Linux & Headless indicators from Player Anti-Bot scripts
//             Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
//             Object.defineProperty(navigator, 'webdriver', { get: () => false });
//             Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
//             Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

//             // Spoof WebGL Renderer (Hides Google SwiftShader / Virtual Xvfb GPU)
//             const getParameter = WebGLRenderingContext.prototype.getParameter;
//             WebGLRenderingContext.prototype.getParameter = function(param) {
//                 if (param === 37445) return 'Google Inc. (NVIDIA)';
//                 if (param === 37446) return 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
//                 return getParameter.apply(this, arguments);
//             };

//             // Inject encrypted-media permission into every iframe BEFORE it loads
//             const drmAllow = 'autoplay; encrypted-media; fullscreen; picture-in-picture; clipboard-write';
//             const patchIframe = (el) => {
//                 if (el && el.tagName === 'IFRAME') {
//                     if (!el.allow || !el.allow.includes('encrypted-media')) {
//                         el.setAttribute('allow', drmAllow);
//                     }
//                 }
//             };
//             const obs = new MutationObserver((mutations) => {
//                 for (const m of mutations) {
//                     for (const node of m.addedNodes) {
//                         if (node.nodeType === 1) {
//                             patchIframe(node);
//                             if (node.querySelectorAll) node.querySelectorAll('iframe').forEach(patchIframe);
//                         }
//                     }
//                 }
//             });
//             obs.observe(document, { childList: true, subtree: true });

//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             if (document.documentElement) document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await p.evaluate((t, s) => {
//             if (window.self !== window.top) return;
//             let el = document.getElementById('bot-loading-ui');
//             if (!el) {
//                 el = document.createElement('div');
//                 el.id = 'bot-loading-ui';
//                 el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                 document.documentElement.appendChild(el);
//             }
//             el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//         }, title, subtitle);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await p.evaluate(() => {
//             const el = document.getElementById('bot-loading-ui');
//             if (el) el.remove();
//         });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Supports Nested Iframes like webcric)
// // =========================================================================================
// let currentPlayerTab = 0;

// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames + Instant Switch on "Protected Content" (403)
//         for (let attempt = 0; attempt < 10; attempt++) {
//             let hasProtectedError = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const errFound = await frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         return txt.includes('protected content') || txt.includes('232403') || txt.includes('cannot be played') || txt.includes('error code');
//                     });
//                     if (errFound) { hasProtectedError = true; break; }
//                 } catch (e) {}
//             }

//             if (hasProtectedError) {
//                 currentPlayerTab++;
//                 // Un-lock fullscreen iframe on main page FIRST so clicking the next Player button actually swaps the iframe!
//                 await p.evaluate((tabIdx) => {
//                     document.querySelectorAll('iframe').forEach(f => {
//                         f.style.cssText = 'width:100%;height:500px;position:relative;z-index:1;display:block;visibility:visible;';
//                     });
//                     // Find unique clickable Player / Server / Stream buttons or links
//                     const allEls = Array.from(document.querySelectorAll('a, button, .btn, [onclick], [data-stream], [data-server], li'));
//                     const playerBtns = allEls.filter(el => {
//                         if (el.children.length > 1) return false; // Avoid parent wrapper divs
//                         const t = (el.innerText || '').trim();
//                         return /^(Player|Server|Stream|Channel|Link|HD|Backup|Mirror)\s*\d*$/i.test(t) || /player|stream|embed|watch/i.test(el.getAttribute('href') || '') || el.hasAttribute('onclick');
//                     });
//                     if (playerBtns.length > 0) {
//                         const targetBtn = playerBtns[tabIdx % playerBtns.length];
//                         targetBtn.click();
//                     }
//                 }, currentPlayerTab).catch(() => {});
//                 console.log(`[⚡] Protected Content (403) -> Switched immediately to Player option #${currentPlayerTab + 1}`);
//                 await new Promise(r => setTimeout(r, 3500));
//             }

//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await frame.evaluate((audioEnabled) => {
//                         let isPlaying = false;
//                         const videos = document.querySelectorAll('video');

//                         videos.forEach(v => {
//                             // Unmute & set volume without clicking the video element
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;

//                             // ONLY call v.play() if it is actually paused! Never click <video> or .clappr-player
//                             if (v.paused) {
//                                 v.play().catch(() => {});
//                             }
//                             if (!v.paused && v.readyState >= 2) {
//                                 isPlaying = true;
//                             }
//                         });

//                         // ONLY click play overlays if NO video is playing yet
//                         if (!isPlaying) {
//                             const playSelectors = '.jw-display-icon-display, button[data-plyr="play"], .vjs-big-play-button, .player-poster[class*="clickable"]';
//                             document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });
//                         }

//                         // Click dedicated unmute buttons ONLY if they exist
//                         if (audioEnabled) {
//                             document.querySelectorAll('[class*="unmute"], .jw-icon-volume').forEach(el => {
//                                 const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
//                                 if (txt.includes('unmute') || el.className.includes('unmute')) {
//                                     try { el.click(); } catch(e){}
//                                 }
//                             });
//                         }

//                         return isPlaying;
//                     }, ENABLE_STREAM_AUDIO);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // Stretch largest iframe OR video ONLY when no "protected content" error is on screen
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await frame.evaluate((audioEnabled) => {
//                 if (window.__frameLockActive) return;
//                 window.__frameLockActive = true;
//                 setInterval(() => {
//                     const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                     if (txt.includes('protected content') || txt.includes('232403')) return; // Do NOT lock broken error frame!

//                     document.documentElement.style.setProperty('background', '#000', 'important');
//                     if (document.body) document.body.style.setProperty('background', '#000', 'important');

//                     const v = document.querySelector('video');
//                     if (v && (v.clientWidth > 50 || !v.paused)) {
//                         // Crucial Fix: If anything pauses the video, immediately resume it via JS API!
//                         if (v.paused) v.play().catch(() => {});
//                         v.muted = !audioEnabled;
//                         v.volume = audioEnabled ? 1.0 : 0.0;
//                         const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
//                         wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
//                         v.style.cssText = 'width:100% !important;height:100% !important;object-fit:contain !important;';
//                         document.querySelectorAll('.jw-controls, .plyr__controls, .vjs-control-bar, .media-control').forEach(c => c.style.setProperty('display', 'none', 'important'));
//                         return;
//                     }

//                     // Maximize active player iframe WITHOUT setting display:none on sibling iframes
//                     const iframes = Array.from(document.querySelectorAll('iframe'));
//                     let best = null, maxArea = 5000;
//                     iframes.forEach(f => {
//                         const area = f.clientWidth * f.clientHeight;
//                         if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
//                     });
//                     if (best) {
//                         best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483645 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
//                     }
//                 }, 1000);
//             }, ENABLE_STREAM_AUDIO).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         if (txt.includes('protected content') || txt.includes('232403')) return null;

//                         const videos = Array.from(document.querySelectorAll('video'));
//                         for (const v of videos) {
//                             if (!v.paused && v.readyState >= 2 && v.currentTime > 0) {
//                                 const frames = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : (v.webkitDecodedFrameCount || 0);
//                                 return { status: 'HEALTHY', currentTime: v.currentTime, frames };
//                             }
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);
//         // Pick the video with the highest decoded frame count so dummy/ad videos never cause a false freeze!
//         const healthyList = results.filter(r => r && r.status === 'HEALTHY');
//         if (healthyList.length > 0) {
//             healthyList.sort((a, b) => (b.frames || 0) - (a.frames || 0));
//             return healthyList[0];
//         }
//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     const targetUrl = urlList[currentUrlIndex];
//     console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//     try {
//         await page.goto('about:blank');
//         await page.bringToFront();
//         keepChromeOnTopAndHideOBS();
//         await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//         await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
//         await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//         await lockAndPlayVideo(page);
//         await hideLoadingOverlay(page);
//         keepChromeOnTopAndHideOBS();
//     } catch (e) {
//         console.log(`[⚠️] Page navigation warning: ${e.message}`);
//     }
//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;
//             const isStuck = (lastTime !== -1 && health.currentTime === lastTime && health.frames === lastFrames);

//             if (isStuck) {
//                 if (Date.now() - freezeStart > 18000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl('VIDEO FROZEN (18s)');
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED 9-MIN REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/12`);
//             // Gently force video.play() across all frames without re-clicking the player UI
//             for (const frame of page.frames()) {
//                 if (!frame.isDetached()) {
//                     await frame.evaluate(() => {
//                         document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                     }).catch(() => {});
//                 }
//             }
//             if (deadStrikes >= 12) {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('12 STRIKES -> FAILOVER NEXT URL');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 90 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     // Restored OBS Console Logs so you can verify RTMP streaming in GitHub Actions
//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     // 1. Pre-seed Chrome Profile with Widevine CDM so Linux Chrome enables DRM on First Boot
//     const userDataDir = path.join(os.tmpdir(), 'chrome-drm-profile');
//     const widevineHintDir = path.join(userDataDir, 'WidevineCdm');
//     const defaultProfileDir = path.join(userDataDir, 'Default');
//     fs.mkdirSync(widevineHintDir, { recursive: true });
//     fs.mkdirSync(defaultProfileDir, { recursive: true });

//     const systemWidevinePaths = [
//         '/opt/google/chrome/WidevineCdm',
//         '/usr/lib/chromium/WidevineCdm',
//         '/usr/lib/chromium-browser/WidevineCdm'
//     ];
//     const activeWidevinePath = systemWidevinePaths.find(p => fs.existsSync(p)) || '/opt/google/chrome/WidevineCdm';

//     fs.writeFileSync(
//         path.join(widevineHintDir, 'latest-component-updated-widevine-cdm'),
//         JSON.stringify({ Path: activeWidevinePath })
//     );
//     fs.writeFileSync(
//         path.join(defaultProfileDir, 'Preferences'),
//         JSON.stringify({
//             profile: { content_settings: { exceptions: { protected_media_identifier: { '*': { setting: 1 } } } } },
//             webkit: { webprefs: { encrypted_media_enabled: true } }
//         })
//     );

//     const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled',
//         '--enable-widevine',
//         '--enable-features=EncryptedMedia,Widevine',
//         '--disable-features=PermissionsPolicyHeader,WebRtcHideLocalIpsWithMdns',
//         '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
//         '--enforce-webrtc-ip-permission-check'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     // Load uBlock WITHOUT --disable-extensions-except (which kills Chrome's internal Widevine component)
//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded (DRM-Safe Mode)!');
//     }

//     const chromePaths = ['/usr/bin/google-chrome-stable', '/usr/bin/google-chrome'];
//     const executablePath = chromePaths.find(p => fs.existsSync(p));
//     if (executablePath) console.log(`[🌐] Launching Official Chrome with Widevine DRM (${activeWidevinePath})`);

//     browser = await puppeteer.launch({
//         headless: false,
//         executablePath: executablePath || undefined,
//         userDataDir: userDataDir,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: [
//             '--enable-automation',
//             '--disable-extensions',
//             '--disable-component-update',
//             '--disable-component-extensions-with-background-pages',
//             '--disable-default-apps'
//         ],
//         args
//     });

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         if (target.type() === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 300);
//             }
//         }
//     });

//     keepChromeOnTopAndHideOBS();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// setTimeout(() => {
//     try {
//         const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}"`;
//         execSync(cmd, { stdio: 'inherit' });
//         setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//     } catch (e) {}
// }, 21000000);

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();



















// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// // NEW: Browser diagnostics
// async function checkBrowserEnvironment(browserInstance) {
//     try {
//         console.log(
//             '[BROWSER VERSION]',
//             await browserInstance.version()
//         );

//         console.log(
//             '[BROWSER PATH]',
//             browserInstance.process()?.spawnfile || 'Unknown'
//         );
//     } catch (error) {
//         console.error('[BROWSER CHECK ERROR]', error.message);
//     }
// }

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (With OBS 30+ WebSocket Plugin Fix)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     // Legacy + Modern OBS WebSocket Config
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Advanced\n[AdvOut]\nTrackIndex=1\nRecType=Standard\nEncoder=obs_x264\n[obs_x264]\nbitrate=${BITRATE}\nkeyint_sec=2\npreset=ultrafast\nprofile=main\ntune=zerolatency\n`);

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     // MainScene set as default so video + audio broadcast even if WebSocket is delayed
//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb Fix)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI
// // =========================================================================================
// async function setupPageProtections(p) {
//     try {
//         // Clean User-Agent & Language headers so HLS CDN never throws 403 Protected Content error
//         await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
//         await p.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

//         // Block ad domains at CDP level WITHOUT intercepting/corrupting HLS .m3u8 & key requests
//         const client = await p.target().createCDPSession();
//         await client.send('Network.enable');
//         await client.send('Network.setBlockedURLs', {
//             urls: ['*popads*', '*exoclick*', '*adsterra*', '*onclickads*', '*doubleclick*', '*adexchangerapid*', '*bet365*', '*1xbet*']
//         });

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;
//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await p.evaluate((t, s) => {
//             if (window.self !== window.top) return;
//             let el = document.getElementById('bot-loading-ui');
//             if (!el) {
//                 el = document.createElement('div');
//                 el.id = 'bot-loading-ui';
//                 el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                 document.documentElement.appendChild(el);
//             }
//             el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//         }, title, subtitle);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await p.evaluate(() => {
//             const el = document.getElementById('bot-loading-ui');
//             if (el) el.remove();
//         });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Supports Nested Iframes like webcric)
// // =========================================================================================
// let currentPlayerTab = 0;

// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames + Instant Switch on "Protected Content" (403)
//         for (let attempt = 0; attempt < 10; attempt++) {
//             let hasProtectedError = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const errFound = await frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         return txt.includes('protected content') || txt.includes('232403') || txt.includes('cannot be played') || txt.includes('error code');
//                     });
//                     if (errFound) { hasProtectedError = true; break; }
//                 } catch (e) {}
//             }

//             if (hasProtectedError) {
//                 currentPlayerTab++;
//                 // Un-lock fullscreen iframe on main page FIRST so clicking the next Player button actually swaps the iframe!
//                 await p.evaluate((tabIdx) => {
//                     document.querySelectorAll('iframe').forEach(f => {
//                         f.style.cssText = 'width:100%;height:500px;position:relative;z-index:1;display:block;visibility:visible;';
//                     });
//                     // Find unique clickable Player / Server / Stream buttons or links
//                     const allEls = Array.from(document.querySelectorAll('a, button, .btn, [onclick], [data-stream], [data-server], li'));
//                     const playerBtns = allEls.filter(el => {
//                         if (el.children.length > 1) return false; // Avoid parent wrapper divs
//                         const t = (el.innerText || '').trim();
//                         return /^(Player|Server|Stream|Channel|Link|HD|Backup|Mirror)\s*\d*$/i.test(t) || /player|stream|embed|watch/i.test(el.getAttribute('href') || '') || el.hasAttribute('onclick');
//                     });
//                     if (playerBtns.length > 0) {
//                         const targetBtn = playerBtns[tabIdx % playerBtns.length];
//                         targetBtn.click();
//                     }
//                 }, currentPlayerTab).catch(() => {});
//                 console.log(`[⚡] Protected Content (403) -> Switched immediately to Player option #${currentPlayerTab + 1}`);
//                 await new Promise(r => setTimeout(r, 3500));
//             }

//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await frame.evaluate((audioEnabled) => {
//                         let isPlaying = false;
//                         const videos = document.querySelectorAll('video');

//                         videos.forEach(v => {
//                             // Unmute & set volume without clicking the video element
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;

//                             // ONLY call v.play() if it is actually paused! Never click <video> or .clappr-player
//                             if (v.paused) {
//                                 v.play().catch(() => {});
//                             }
//                             if (!v.paused && v.readyState >= 2) {
//                                 isPlaying = true;
//                             }
//                         });

//                         // ONLY click play overlays if NO video is playing yet
//                         if (!isPlaying) {
//                             const playSelectors = '.jw-display-icon-display, button[data-plyr="play"], .vjs-big-play-button, .player-poster[class*="clickable"]';
//                             document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });
//                         }

//                         // Click dedicated unmute buttons ONLY if they exist
//                         if (audioEnabled) {
//                             document.querySelectorAll('[class*="unmute"], .jw-icon-volume').forEach(el => {
//                                 const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
//                                 if (txt.includes('unmute') || el.className.includes('unmute')) {
//                                     try { el.click(); } catch(e){}
//                                 }
//                             });
//                         }

//                         return isPlaying;
//                     }, ENABLE_STREAM_AUDIO);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // Stretch largest iframe OR video ONLY when no "protected content" error is on screen
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await frame.evaluate((audioEnabled) => {
//                 if (window.__frameLockActive) return;
//                 window.__frameLockActive = true;
//                 setInterval(() => {
//                     const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                     if (txt.includes('protected content') || txt.includes('232403')) return; // Do NOT lock broken error frame!

//                     document.documentElement.style.setProperty('background', '#000', 'important');
//                     if (document.body) document.body.style.setProperty('background', '#000', 'important');

//                     const v = document.querySelector('video');
//                     if (v && (v.clientWidth > 50 || !v.paused)) {
//                         // Crucial Fix: If anything pauses the video, immediately resume it via JS API!
//                         if (v.paused) v.play().catch(() => {});
//                         v.muted = !audioEnabled;
//                         v.volume = audioEnabled ? 1.0 : 0.0;
//                         const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
//                         wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
//                         v.style.cssText = 'width:100% !important;height:100% !important;object-fit:contain !important;';
//                         document.querySelectorAll('.jw-controls, .plyr__controls, .vjs-control-bar, .media-control').forEach(c => c.style.setProperty('display', 'none', 'important'));
//                         return;
//                     }

//                     // Maximize active player iframe WITHOUT setting display:none on sibling iframes
//                     const iframes = Array.from(document.querySelectorAll('iframe'));
//                     let best = null, maxArea = 5000;
//                     iframes.forEach(f => {
//                         const area = f.clientWidth * f.clientHeight;
//                         if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
//                     });
//                     if (best) {
//                         best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483645 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
//                     }
//                 }, 1000);
//             }, ENABLE_STREAM_AUDIO).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         if (txt.includes('protected content') || txt.includes('232403')) return null;

//                         const videos = Array.from(document.querySelectorAll('video'));
//                         for (const v of videos) {
//                             if (!v.paused && v.readyState >= 2 && v.currentTime > 0) {
//                                 const frames = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : (v.webkitDecodedFrameCount || 0);
//                                 return { status: 'HEALTHY', currentTime: v.currentTime, frames };
//                             }
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);
//         // Pick the video with the highest decoded frame count so dummy/ad videos never cause a false freeze!
//         const healthyList = results.filter(r => r && r.status === 'HEALTHY');
//         if (healthyList.length > 0) {
//             healthyList.sort((a, b) => (b.frames || 0) - (a.frames || 0));
//             return healthyList[0];
//         }
//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     const targetUrl = urlList[currentUrlIndex];
//     console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//     try {
//         await page.goto('about:blank');
//         await page.bringToFront();
//         keepChromeOnTopAndHideOBS();
//         await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//         await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
//         await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//         await lockAndPlayVideo(page);
//         await hideLoadingOverlay(page);
//         keepChromeOnTopAndHideOBS();
//     } catch (e) {
//         console.log(`[⚠️] Page navigation warning: ${e.message}`);
//     }
//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;
//             const isStuck = (lastTime !== -1 && health.currentTime === lastTime && health.frames === lastFrames);

//             if (isStuck) {
//                 if (Date.now() - freezeStart > 18000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl('VIDEO FROZEN (18s)');
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED 9-MIN REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/12`);
//             // Gently force video.play() across all frames without re-clicking the player UI
//             for (const frame of page.frames()) {
//                 if (!frame.isDetached()) {
//                     await frame.evaluate(() => {
//                         document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                     }).catch(() => {});
//                 }
//             }
//             if (deadStrikes >= 12) {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('12 STRIKES -> FAILOVER NEXT URL');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 90 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     // Restored OBS Console Logs so you can verify RTMP streaming in GitHub Actions
//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled', '--use-gl=egl'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--disable-extensions-except=${ublockPath}`);
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded!');
//     }

//     browser = await puppeteer.launch({
//         headless: false,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: ['--enable-automation'],
//         args
//     });
//     await checkBrowserEnvironment(browser);

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         if (target.type() === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 300);
//             }
//         }
//     });

//     keepChromeOnTopAndHideOBS();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// setTimeout(() => {
//     try {
//         const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}"`;
//         execSync(cmd, { stdio: 'inherit' });
//         setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//     } catch (e) {}
// }, 21000000);

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();























/////////////////////////////////////




// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (With OBS 30+ WebSocket Plugin Fix)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     // Legacy + Modern OBS WebSocket Config
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Advanced\n[AdvOut]\nTrackIndex=1\nRecType=Standard\nEncoder=obs_x264\n[obs_x264]\nbitrate=${BITRATE}\nkeyint_sec=2\npreset=ultrafast\nprofile=main\ntune=zerolatency\n`);

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     // MainScene set as default so video + audio broadcast even if WebSocket is delayed
//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb Fix)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI
// // =========================================================================================
// async function setupPageProtections(p) {
//     try {
//         // Clean User-Agent & Language headers so HLS CDN never throws 403 Protected Content error
//         await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
//         await p.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

//         // Block ad domains at CDP level WITHOUT intercepting/corrupting HLS .m3u8 & key requests
//         const client = await p.target().createCDPSession();
//         await client.send('Network.enable');
//         await client.send('Network.setBlockedURLs', {
//             urls: ['*popads*', '*exoclick*', '*adsterra*', '*onclickads*', '*doubleclick*', '*adexchangerapid*', '*bet365*', '*1xbet*']
//         });

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;
//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await p.evaluate((t, s) => {
//             if (window.self !== window.top) return;
//             let el = document.getElementById('bot-loading-ui');
//             if (!el) {
//                 el = document.createElement('div');
//                 el.id = 'bot-loading-ui';
//                 el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                 document.documentElement.appendChild(el);
//             }
//             el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//         }, title, subtitle);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await p.evaluate(() => {
//             const el = document.getElementById('bot-loading-ui');
//             if (el) el.remove();
//         });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Supports Nested Iframes like webcric)
// // =========================================================================================
// let currentPlayerTab = 0;

// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames + Instant Switch on "Protected Content" (403)
//         for (let attempt = 0; attempt < 10; attempt++) {
//             let hasProtectedError = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const errFound = await frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         return txt.includes('protected content') || txt.includes('232403') || txt.includes('cannot be played') || txt.includes('error code');
//                     });
//                     if (errFound) { hasProtectedError = true; break; }
//                 } catch (e) {}
//             }

//             if (hasProtectedError) {
//                 currentPlayerTab++;
//                 // Un-lock fullscreen iframe on main page FIRST so clicking the next Player button actually swaps the iframe!
//                 await p.evaluate((tabIdx) => {
//                     document.querySelectorAll('iframe').forEach(f => {
//                         f.style.cssText = 'width:100%;height:500px;position:relative;z-index:1;display:block;visibility:visible;';
//                     });
//                     // Find unique clickable Player / Server / Stream buttons or links
//                     const allEls = Array.from(document.querySelectorAll('a, button, .btn, [onclick], [data-stream], [data-server], li'));
//                     const playerBtns = allEls.filter(el => {
//                         if (el.children.length > 1) return false; // Avoid parent wrapper divs
//                         const t = (el.innerText || '').trim();
//                         return /^(Player|Server|Stream|Channel|Link|HD|Backup|Mirror)\s*\d*$/i.test(t) || /player|stream|embed|watch/i.test(el.getAttribute('href') || '') || el.hasAttribute('onclick');
//                     });
//                     if (playerBtns.length > 0) {
//                         const targetBtn = playerBtns[tabIdx % playerBtns.length];
//                         targetBtn.click();
//                     }
//                 }, currentPlayerTab).catch(() => {});
//                 console.log(`[⚡] Protected Content (403) -> Switched immediately to Player option #${currentPlayerTab + 1}`);
//                 await new Promise(r => setTimeout(r, 3500));
//             }

//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await frame.evaluate((audioEnabled) => {
//                         let isPlaying = false;
//                         const videos = document.querySelectorAll('video');

//                         videos.forEach(v => {
//                             // Unmute & set volume without clicking the video element
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;

//                             // ONLY call v.play() if it is actually paused! Never click <video> or .clappr-player
//                             if (v.paused) {
//                                 v.play().catch(() => {});
//                             }
//                             if (!v.paused && v.readyState >= 2) {
//                                 isPlaying = true;
//                             }
//                         });

//                         // ONLY click play overlays if NO video is playing yet
//                         if (!isPlaying) {
//                             const playSelectors = '.jw-display-icon-display, button[data-plyr="play"], .vjs-big-play-button, .player-poster[class*="clickable"]';
//                             document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });
//                         }

//                         // Click dedicated unmute buttons ONLY if they exist
//                         if (audioEnabled) {
//                             document.querySelectorAll('[class*="unmute"], .jw-icon-volume').forEach(el => {
//                                 const txt = (el.innerText || el.getAttribute('aria-label') || '').toLowerCase();
//                                 if (txt.includes('unmute') || el.className.includes('unmute')) {
//                                     try { el.click(); } catch(e){}
//                                 }
//                             });
//                         }

//                         return isPlaying;
//                     }, ENABLE_STREAM_AUDIO);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // Stretch largest iframe OR video ONLY when no "protected content" error is on screen
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await frame.evaluate((audioEnabled) => {
//                 if (window.__frameLockActive) return;
//                 window.__frameLockActive = true;
//                 setInterval(() => {
//                     const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                     if (txt.includes('protected content') || txt.includes('232403')) return; // Do NOT lock broken error frame!

//                     document.documentElement.style.setProperty('background', '#000', 'important');
//                     if (document.body) document.body.style.setProperty('background', '#000', 'important');

//                     const v = document.querySelector('video');
//                     if (v && (v.clientWidth > 50 || !v.paused)) {
//                         // Crucial Fix: If anything pauses the video, immediately resume it via JS API!
//                         if (v.paused) v.play().catch(() => {});
//                         v.muted = !audioEnabled;
//                         v.volume = audioEnabled ? 1.0 : 0.0;
//                         const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
//                         wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
//                         v.style.cssText = 'width:100% !important;height:100% !important;object-fit:contain !important;';
//                         document.querySelectorAll('.jw-controls, .plyr__controls, .vjs-control-bar, .media-control').forEach(c => c.style.setProperty('display', 'none', 'important'));
//                         return;
//                     }

//                     // Maximize active player iframe WITHOUT setting display:none on sibling iframes
//                     const iframes = Array.from(document.querySelectorAll('iframe'));
//                     let best = null, maxArea = 5000;
//                     iframes.forEach(f => {
//                         const area = f.clientWidth * f.clientHeight;
//                         if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
//                     });
//                     if (best) {
//                         best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483645 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
//                     }
//                 }, 1000);
//             }, ENABLE_STREAM_AUDIO).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         if (txt.includes('protected content') || txt.includes('232403')) return null;

//                         const videos = Array.from(document.querySelectorAll('video'));
//                         for (const v of videos) {
//                             if (!v.paused && v.readyState >= 2 && v.currentTime > 0) {
//                                 const frames = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : (v.webkitDecodedFrameCount || 0);
//                                 return { status: 'HEALTHY', currentTime: v.currentTime, frames };
//                             }
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);
//         // Pick the video with the highest decoded frame count so dummy/ad videos never cause a false freeze!
//         const healthyList = results.filter(r => r && r.status === 'HEALTHY');
//         if (healthyList.length > 0) {
//             healthyList.sort((a, b) => (b.frames || 0) - (a.frames || 0));
//             return healthyList[0];
//         }
//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     const targetUrl = urlList[currentUrlIndex];
//     console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//     try {
//         await page.goto('about:blank');
//         await page.bringToFront();
//         keepChromeOnTopAndHideOBS();
//         await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//         await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
//         await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//         await lockAndPlayVideo(page);
//         await hideLoadingOverlay(page);
//         keepChromeOnTopAndHideOBS();
//     } catch (e) {
//         console.log(`[⚠️] Page navigation warning: ${e.message}`);
//     }
//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;
//             const isStuck = (lastTime !== -1 && health.currentTime === lastTime && health.frames === lastFrames);

//             if (isStuck) {
//                 if (Date.now() - freezeStart > 18000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl('VIDEO FROZEN (18s)');
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED 9-MIN REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/12`);
//             // Gently force video.play() across all frames without re-clicking the player UI
//             for (const frame of page.frames()) {
//                 if (!frame.isDetached()) {
//                     await frame.evaluate(() => {
//                         document.querySelectorAll('video').forEach(v => { if (v.paused) v.play().catch(() => {}); });
//                     }).catch(() => {});
//                 }
//             }
//             if (deadStrikes >= 12) {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('12 STRIKES -> FAILOVER NEXT URL');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 90 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     // Restored OBS Console Logs so you can verify RTMP streaming in GitHub Actions
//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled', '--use-gl=egl'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--disable-extensions-except=${ublockPath}`);
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded!');
//     }

//     browser = await puppeteer.launch({
//         headless: false,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: ['--enable-automation'],
//         args
//     });

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         if (target.type() === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 300);
//             }
//         }
//     });

//     keepChromeOnTopAndHideOBS();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// setTimeout(() => {
//     try {
//         const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}"`;
//         execSync(cmd, { stdio: 'inherit' });
//         setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//     } catch (e) {}
// }, 21000000);

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();



















// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (With OBS 30+ WebSocket Plugin Fix)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     // Legacy + Modern OBS WebSocket Config
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Advanced\n[AdvOut]\nTrackIndex=1\nRecType=Standard\nEncoder=obs_x264\n[obs_x264]\nbitrate=${BITRATE}\nkeyint_sec=2\npreset=ultrafast\nprofile=main\ntune=zerolatency\n`);

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     // MainScene set as default so video + audio broadcast even if WebSocket is delayed
//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb Fix)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI
// // =========================================================================================
// async function setupPageProtections(p) {
//     try {
//         // Clean User-Agent & Language headers so HLS CDN never throws 403 Protected Content error
//         await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
//         await p.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

//         // Block ad domains at CDP level WITHOUT intercepting/corrupting HLS .m3u8 & key requests
//         const client = await p.target().createCDPSession();
//         await client.send('Network.enable');
//         await client.send('Network.setBlockedURLs', {
//             urls: ['*popads*', '*exoclick*', '*adsterra*', '*onclickads*', '*doubleclick*', '*adexchangerapid*', '*bet365*', '*1xbet*']
//         });

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;
//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await p.evaluate((t, s) => {
//             if (window.self !== window.top) return;
//             let el = document.getElementById('bot-loading-ui');
//             if (!el) {
//                 el = document.createElement('div');
//                 el.id = 'bot-loading-ui';
//                 el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                 document.documentElement.appendChild(el);
//             }
//             el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//         }, title, subtitle);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await p.evaluate(() => {
//             const el = document.getElementById('bot-loading-ui');
//             if (el) el.remove();
//         });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Supports Nested Iframes like webcric)
// // =========================================================================================
// let currentPlayerTab = 0;

// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames + Instant Switch on "Protected Content" (403)
//         for (let attempt = 0; attempt < 10; attempt++) {
//             let hasProtectedError = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const errFound = await frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         return txt.includes('protected content') || txt.includes('232403') || txt.includes('cannot be played') || txt.includes('error code');
//                     });
//                     if (errFound) { hasProtectedError = true; break; }
//                 } catch (e) {}
//             }

//             if (hasProtectedError) {
//                 currentPlayerTab++;
//                 // Un-lock fullscreen iframe on main page FIRST so clicking the next Player button actually swaps the iframe!
//                 await p.evaluate((tabIdx) => {
//                     document.querySelectorAll('iframe').forEach(f => {
//                         f.style.cssText = 'width:100%;height:500px;position:relative;z-index:1;display:block;visibility:visible;';
//                     });
//                     // Find unique clickable Player / Server / Stream buttons or links
//                     const allEls = Array.from(document.querySelectorAll('a, button, .btn, [onclick], [data-stream], [data-server], li'));
//                     const playerBtns = allEls.filter(el => {
//                         if (el.children.length > 1) return false; // Avoid parent wrapper divs
//                         const t = (el.innerText || '').trim();
//                         return /^(Player|Server|Stream|Channel|Link|HD|Backup|Mirror)\s*\d*$/i.test(t) || /player|stream|embed|watch/i.test(el.getAttribute('href') || '') || el.hasAttribute('onclick');
//                     });
//                     if (playerBtns.length > 0) {
//                         const targetBtn = playerBtns[tabIdx % playerBtns.length];
//                         targetBtn.click();
//                     }
//                 }, currentPlayerTab).catch(() => {});
//                 console.log(`[⚡] Protected Content (403) -> Switched immediately to Player option #${currentPlayerTab + 1}`);
//                 await new Promise(r => setTimeout(r, 3500));
//             }

//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await frame.evaluate((audioEnabled) => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         if (txt.includes('protected content') || txt.includes('232403')) return false;

//                         const playSelectors = '.jw-icon-display, button[data-plyr="play"], .vjs-big-play-button, [class*="unmute"], .fp-play, .clappr-player, video';
//                         document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });

//                         let isPlaying = false;
//                         document.querySelectorAll('video').forEach(v => {
//                             if (v.paused) v.play().catch(() => {});
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;
//                             if (!v.paused && v.currentTime > 0.5 && v.readyState >= 2) isPlaying = true;
//                         });
//                         return isPlaying;
//                     }, ENABLE_STREAM_AUDIO);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // Stretch largest iframe OR video ONLY when no "protected content" error is on screen
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await frame.evaluate((audioEnabled) => {
//                 if (window.__frameLockActive) return;
//                 window.__frameLockActive = true;
//                 setInterval(() => {
//                     const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                     if (txt.includes('protected content') || txt.includes('232403')) return; // Do NOT lock broken error frame!

//                     document.documentElement.style.setProperty('background', '#000', 'important');
//                     if (document.body) document.body.style.setProperty('background', '#000', 'important');

//                     const v = document.querySelector('video');
//                     if (v && !v.paused && v.readyState >= 2) {
//                         v.muted = !audioEnabled;
//                         v.volume = audioEnabled ? 1.0 : 0.0;
//                         const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
//                         wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
//                         v.style.cssText = 'width:100% !important;height:100% !important;object-fit:contain !important;';
//                         document.querySelectorAll('.jw-controls, .plyr__controls, .vjs-control-bar').forEach(c => c.style.setProperty('display', 'none', 'important'));
//                         return;
//                     }

//                     // Maximize active player iframe WITHOUT setting display:none on sibling iframes
//                     const iframes = Array.from(document.querySelectorAll('iframe'));
//                     let best = null, maxArea = 5000;
//                     iframes.forEach(f => {
//                         const area = f.clientWidth * f.clientHeight;
//                         if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
//                     });
//                     if (best) {
//                         best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483645 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
//                     }
//                 }, 1000);
//             }, ENABLE_STREAM_AUDIO).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         if (txt.includes('protected content') || txt.includes('232403')) return null;

//                         const videos = Array.from(document.querySelectorAll('video'));
//                         for (const v of videos) {
//                             if (!v.paused && v.readyState >= 2 && v.currentTime > 0) {
//                                 const frames = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : (v.webkitDecodedFrameCount || 0);
//                                 return { status: 'HEALTHY', currentTime: v.currentTime, frames };
//                             }
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);
//         // Pick the video with the highest decoded frame count so dummy/ad videos never cause a false freeze!
//         const healthyList = results.filter(r => r && r.status === 'HEALTHY');
//         if (healthyList.length > 0) {
//             healthyList.sort((a, b) => (b.frames || 0) - (a.frames || 0));
//             return healthyList[0];
//         }
//         return { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     const targetUrl = urlList[currentUrlIndex];
//     console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//     try {
//         await page.goto('about:blank');
//         await page.bringToFront();
//         keepChromeOnTopAndHideOBS();
//         await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//         await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
//         await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//         await lockAndPlayVideo(page);
//         await hideLoadingOverlay(page);
//         keepChromeOnTopAndHideOBS();
//     } catch (e) {
//         console.log(`[⚠️] Page navigation warning: ${e.message}`);
//     }
//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;
//             const isStuck = (lastTime !== -1 && health.currentTime === lastTime && health.frames === lastFrames);

//             if (isStuck) {
//                 if (Date.now() - freezeStart > 18000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl('VIDEO FROZEN (18s)');
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED 9-MIN REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/5`);
//             // Re-run lockAndPlayVideo on Strike 2 & 3 so it can auto-switch Player 1 -> Player 2 -> Player 3 before giving up
//             if (deadStrikes === 2 || deadStrikes === 3) {
//                 await lockAndPlayVideo(page);
//             }
//             if (deadStrikes >= 5) {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('5 STRIKES -> FAILOVER NEXT URL');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 10 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     // Restored OBS Console Logs so you can verify RTMP streaming in GitHub Actions
//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled', '--use-gl=egl'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--disable-extensions-except=${ublockPath}`);
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded!');
//     }

//     browser = await puppeteer.launch({
//         headless: false,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: ['--enable-automation'],
//         args
//     });

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         if (target.type() === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 300);
//             }
//         }
//     });

//     keepChromeOnTopAndHideOBS();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// setTimeout(() => {
//     try {
//         const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}"`;
//         execSync(cmd, { stdio: 'inherit' });
//         setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//     } catch (e) {}
// }, 21000000);

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();
























// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (With OBS 30+ WebSocket Plugin Fix)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     // Legacy + Modern OBS WebSocket Config
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Advanced\n[AdvOut]\nTrackIndex=1\nRecType=Standard\nEncoder=obs_x264\n[obs_x264]\nbitrate=${BITRATE}\nkeyint_sec=2\npreset=ultrafast\nprofile=main\ntune=zerolatency\n`);

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     // MainScene set as default so video + audio broadcast even if WebSocket is delayed
//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb Fix)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI
// // =========================================================================================
// async function setupPageProtections(p) {
//     try {
//         // Clean User-Agent & Language headers so HLS CDN never throws 403 Protected Content error
//         await p.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36');
//         await p.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

//         // Block ad domains at CDP level WITHOUT intercepting/corrupting HLS .m3u8 & key requests
//         const client = await p.target().createCDPSession();
//         await client.send('Network.enable');
//         await client.send('Network.setBlockedURLs', {
//             urls: ['*popads*', '*exoclick*', '*adsterra*', '*onclickads*', '*doubleclick*', '*adexchangerapid*', '*bet365*', '*1xbet*']
//         });

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;
//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await p.evaluate((t, s) => {
//             if (window.self !== window.top) return;
//             let el = document.getElementById('bot-loading-ui');
//             if (!el) {
//                 el = document.createElement('div');
//                 el.id = 'bot-loading-ui';
//                 el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                 document.documentElement.appendChild(el);
//             }
//             el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//         }, title, subtitle);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await p.evaluate(() => {
//             const el = document.getElementById('bot-loading-ui');
//             if (el) el.remove();
//         });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Supports Nested Iframes like webcric)
// // =========================================================================================
// let currentPlayerTab = 0;

// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames + Detect "protected content" 403 error
//         for (let attempt = 0; attempt < 8; attempt++) {
//             let hasProtectedError = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const errFound = await frame.evaluate(() => {
//                         const txt = (document.body && document.body.innerText) ? document.body.innerText.toLowerCase() : '';
//                         return txt.includes('protected content') || txt.includes('232403') || txt.includes('cannot be played');
//                     });
//                     if (errFound) { hasProtectedError = true; break; }
//                 } catch (e) {}
//             }

//             // If Player 1 gives "problem providing access to protected content", click next Player button (Player 2, Player 3...)
//             if (hasProtectedError) {
//                 currentPlayerTab++;
//                 console.log(`[⚠️] Protected Content (403) Error detected! Switching to backup Player tab #${currentPlayerTab + 1}...`);
//                 await p.evaluate((tabIdx) => {
//                     const playerBtns = Array.from(document.querySelectorAll('a, button, li, span, div')).filter(el => {
//                         const t = (el.innerText || '').trim();
//                         return /^Player\s*\d+$/i.test(t) || /^Server\s*\d+$/i.test(t) || /^Stream\s*\d+$/i.test(t);
//                     });
//                     if (playerBtns.length > 0) {
//                         const targetBtn = playerBtns[tabIdx % playerBtns.length];
//                         targetBtn.click();
//                     }
//                 }, currentPlayerTab).catch(() => {});
//                 await new Promise(r => setTimeout(r, 3500));
//             }
//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await frame.evaluate((audioEnabled) => {
//                         const playSelectors = '.jw-icon-display, button[data-plyr="play"], .vjs-big-play-button, [class*="unmute"], .fp-play, .clappr-player, video';
//                         document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });

//                         let isPlaying = false;
//                         document.querySelectorAll('video').forEach(v => {
//                             if (v.paused) v.play().catch(() => {});
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;
//                             if (!v.paused && v.currentTime > 0) isPlaying = true;
//                         });
//                         return isPlaying;
//                     }, ENABLE_STREAM_AUDIO);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // Stretch largest iframe OR video inside EVERY frame (fixes nested iframes on webcric)
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await frame.evaluate((audioEnabled) => {
//                 if (window.__frameLockActive) return;
//                 window.__frameLockActive = true;
//                 setInterval(() => {
//                     document.documentElement.style.setProperty('background', '#000', 'important');
//                     if (document.body) document.body.style.setProperty('background', '#000', 'important');

//                     const v = document.querySelector('video');
//                     if (v && (v.clientWidth > 50 || !v.paused)) {
//                         v.muted = !audioEnabled;
//                         v.volume = audioEnabled ? 1.0 : 0.0;
//                         const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
//                         wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
//                         v.style.cssText = 'width:100% !important;height:100% !important;object-fit:contain !important;';
//                         document.querySelectorAll('.jw-controls, .plyr__controls, .vjs-control-bar').forEach(c => c.style.setProperty('display', 'none', 'important'));
//                         return;
//                     }

//                     // If this frame only hosts child iframes, maximize the main player iframe
//                     const iframes = Array.from(document.querySelectorAll('iframe'));
//                     let best = null, maxArea = 5000;
//                     iframes.forEach(f => {
//                         const area = f.clientWidth * f.clientHeight;
//                         if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
//                     });
//                     if (best) {
//                         iframes.forEach(f => { if (f !== best) f.style.setProperty('display', 'none', 'important'); });
//                         best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483645 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
//                     }
//                 }, 1000);
//             }, ENABLE_STREAM_AUDIO).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const v = document.querySelector('video');
//                         if (v && !v.paused && v.readyState >= 2) {
//                             const frames = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : (v.webkitDecodedFrameCount || 0);
//                             return { status: 'HEALTHY', currentTime: v.currentTime, frames };
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);
//         return results.find(r => r && r.status === 'HEALTHY') || { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     const targetUrl = urlList[currentUrlIndex];
//     console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//     try {
//         await page.goto('about:blank');
//         await page.bringToFront();
//         keepChromeOnTopAndHideOBS();
//         await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//         await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
//         await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//         await lockAndPlayVideo(page);
//         await hideLoadingOverlay(page);
//         keepChromeOnTopAndHideOBS();
//     } catch (e) {
//         console.log(`[⚠️] Page navigation warning: ${e.message}`);
//     }
//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;
//             const isStuck = (lastTime !== -1 && health.currentTime === lastTime && health.frames === lastFrames);

//             if (isStuck) {
//                 if (Date.now() - freezeStart > 18000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl('VIDEO FROZEN (18s)');
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED 9-MIN REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/5`);
//             // Re-run lockAndPlayVideo on Strike 2 & 3 so it can auto-switch Player 1 -> Player 2 -> Player 3 before giving up
//             if (deadStrikes === 2 || deadStrikes === 3) {
//                 await lockAndPlayVideo(page);
//             }
//             if (deadStrikes >= 5) {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('5 STRIKES -> FAILOVER NEXT URL');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 10 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     // Restored OBS Console Logs so you can verify RTMP streaming in GitHub Actions
//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled', '--use-gl=egl'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--disable-extensions-except=${ublockPath}`);
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded!');
//     }

//     browser = await puppeteer.launch({
//         headless: false,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: ['--enable-automation'],
//         args
//     });

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         if (target.type() === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 300);
//             }
//         }
//     });

//     keepChromeOnTopAndHideOBS();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// setTimeout(() => {
//     try {
//         const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}"`;
//         execSync(cmd, { stdio: 'inherit' });
//         setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//     } catch (e) {}
// }, 21000000);

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();

























































































































// ================== na poyeegaaam . this below code is 1st code for dlhd ====================================





// const puppeteer = require('puppeteer-extra');
// const StealthPlugin = require('puppeteer-extra-plugin-stealth');
// puppeteer.use(StealthPlugin());

// const fs = require('fs');
// const path = require('path');
// const os = require('os');
// const { spawn, execSync } = require('child_process');
// const { OBSWebSocket } = require('obs-websocket-js');

// // =========================================================================================
// // 🛡️ GLOBAL CRASH SHIELD
// // =========================================================================================
// process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
// process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

// const obs = new OBSWebSocket();

// // =========================================================================================
// // ⚙️ CONFIGURATION & ENV VARIABLES
// // =========================================================================================
// const selectedQuality = process.env.STREAM_QUALITY || '720p';
// const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
// const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
// const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
// const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

// // const FORCE_REFRESH_MS = 9 * 60 * 1000;
// const FORCE_REFRESH_MS = 900000000 * 60 * 1000;

// const NO_REFRESH_DOMAINS = [
//     'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
//     'sport4u.online', 'vercel.app', 'netlify.app'
// ];

// let RES_W = 1280, RES_H = 720, BITRATE = 3000;
// if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
// else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
// else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
// else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

// const STREAM_KEYS = {
//     '1'    : '15254238731883_15281627925099_najspfkgne',
//     '1.1'  : '15254260751979_15281671637611_2plrcfqzze',
//     '1.2'  : '15254285524587_15281717840491_7e6qdknzsu',
//     '1.3'  : '16983200374379_18360218880619_efmw4fchxm',
//     '1.4'  : '16983242579563_18360288741995_t2kh2jvcym',
//     '1.5'  : '16983247822443_18360297982571_3zs5ml7gua',
//     '1.6'  : '16983254834795_18360310237803_xrz3pf4uea',
//     '1.7'  : '16983259553387_18360317971051_6khoe5efge',
//     '1.8'  : '16983264468587_18360327342699_wsn7zgr7ee',
//     '1.9'  : '16983269514859_18360335075947_363qzjlbte',
//     '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
//     '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
//     '2'    : '15254299352683_15281743071851_7dvz3h5d7q',
//     '2.1'  : '15254308986475_15281761618539_3xca7oij3u',
//     '2.2'  : '15254328122987_15281795566187_zjqa6bqzoq',
//     '3'    : '15254341885547_15281821059691_hhlpb5vicy',
//     '3.1'  : '15254357089899_15281848322667_sxeexgvzl4',
//     '3.2'  : '15254367510123_15281868180075_pc4jrytfgm',
//     '3.3'  : '17485986405995_19233134873195_iw63xjblny',
//     '3.4'  : '17485996039787_19233150929515_d3yeoweuam',
//     '3.5'  : '17486002789995_19233161611883_mbg22slybe',
//     '3.6'  : '17486007770731_19233169934955_teme2zt4fm',
//     '4'    : '15255022345835_15283095800427_vwrupxzstm',
//     '4.1'  : '15255038074475_15283122080363_ai5qqp2we4',
//     '4.2'  : '15255045480043_15283135842923_tldl4bhmii',
//     '4.3'  : '15255208599147_15283449629291_abltofuc7m',
//     '4.4'  : '15255217708651_15283466603115_bojrrqtlmu',
//     '4.5'  : '15255227670123_15283486263915_jpntt54mve',
//     '5'    : '17135767461483_18625099401835_4gpytlxk4a',
//     '5.1'  : '15273713933931_15317494860395_avj47smmim',
//     '5.2'  : '15273722257003_15317510195819_6edjluvdqi',
//     '5.3'  : '15273739624043_15317541653099_ii4bxpvabe',
//     '5.4'  : '15273750175339_15317561707115_csel26ku5a',
//     '5.5'  : '15273760071275_15317579467371_cnewcj54me',
//     '5.6'  : '15273767935595_15317595851371_3q43tk7tvm',
//     '5.7'  : '15273778683499_15317616560747_4piekvs4wu',
//     's1.1' : '14204232736303_14846150314543_37jq4ryehq',
//     's1.2' : '14204288179759_14846247373359_tnsknmapva',
//     's1.3' : '14204319768111_14846302489135_sr4ht4ccwq',
//     's1.4' : '14204331957807_14846326147631_dji2acqcze',
//     's1.5' : '14204346572335_14846351641135_7gvns4o5ue',
//     's1.6' : '14204361252399_14846376479279_cjajhf4d3y',
//     's1.7' : '14204370492975_14846393649711_6fduhdqite',
//     's1.8' : '14204395527727_14846438017583_s2jlti7lsm',
//     's1.9' : '14204411387439_14846464887343_f5lxgcqj5y',
//     's1.10': '14204424691247_14846487562799_xmbvntt6wa',
//     's2.1' : '14204490948143_14846603495983_kzevn36tii',
//     's2.2' : '14204506742319_14846634494511_ta2rxyg2oy',
//     's2.3' : '14204523322927_14846661233199_foqb3q7zb4',
//     's2.4' : '14204540034607_14846689085999_gjejdie4uy',
//     's2.5' : '14204555304495_14846715497007_zdanghuxzu',
//     's2.6' : '14204565200431_14846734371375_ap3bqpabpu',
//     's2.7' : '14204577259055_14846756194863_3ecad2535u',
//     's2.8' : '14204592528943_14846785227311_4hjl46y62e',
//     's2.9' : '14204602621487_14846802594351_ilnp6lxekq',
//     's2.10': '14206184136239_14849618610735_ihnbx7hkoi'
// };

// const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// // =========================================================================================
// // 🔗 MULTI-URL PARSER
// // =========================================================================================
// const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
// const urlList = rawUrls
//     .split(/[,|]/)
//     .map(u => {
//         let clean = u.split('::')[0].trim().replace(/^!/, '');
//         if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
//         return clean;
//     })
//     .filter(u => u.length > 8);

// if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

// let currentUrlIndex = 0;
// let browser = null;
// let page = null;
// let obsProcess = null;

// console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
// console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// // =========================================================================================
// // 🎥 OBS CONFIGURATION (With OBS 30+ WebSocket Plugin Fix)
// // =========================================================================================
// function setupOBSConfig() {
//     const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
//     const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
//     const scenesDir = path.join(obsDir, 'basic', 'scenes');
//     const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

//     fs.mkdirSync(profilesDir, { recursive: true });
//     fs.mkdirSync(scenesDir, { recursive: true });
//     fs.mkdirSync(wsPluginDir, { recursive: true });

//     // Legacy + Modern OBS WebSocket Config
//     fs.writeFileSync(path.join(obsDir, 'global.ini'), `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`);

//     fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
//         alerts_enabled: false,
//         auth_required: true,
//         first_load: false,
//         server_enabled: true,
//         server_password: "secret",
//         server_port: 4455
//     }, null, 2));

//     fs.writeFileSync(path.join(profilesDir, 'basic.ini'), `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Advanced\n[AdvOut]\nTrackIndex=1\nRecType=Standard\nEncoder=obs_x264\n[obs_x264]\nbitrate=${BITRATE}\nkeyint_sec=2\npreset=ultrafast\nprofile=main\ntune=zerolatency\n`);

//     const serviceJson = {
//         settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
//         type: "rtmp_custom"
//     };
//     fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

//     // MainScene set as default so video + audio broadcast even if WebSocket is delayed
//     const sceneJson = {
//         current_scene: "MainScene",
//         current_program_scene: "MainScene",
//         name: "Untitled",
//         scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
//         sources: [
//             { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
//             { id: "pulse_output_capture", name: "Audio", settings: {} },
//             { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
//             { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
//         ]
//     };
//     fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
// }

// // =========================================================================================
// // 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb Fix)
// // =========================================================================================
// function keepChromeOnTopAndHideOBS() {
//     try {
//         // Move OBS window far off-screen and minimize it so it never appears on stream
//         execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
//         // Force Chrome window to 0,0 with full resolution and bring to front
//         execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
//         execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🛡️ POPUP & AD FIREWALL + LOADING UI
// // =========================================================================================
// async function setupPageProtections(p) {
//     try {
//         await p.setRequestInterception(true);
//         p.on('request', (req) => {
//             const url = req.url().toLowerCase();
//             const badWords = ['popads', 'exoclick', 'adsterra', 'onclickads', 'doubleclick', 'adexchangerapid', 'bet365', '1xbet'];
//             if (badWords.some(w => url.includes(w))) return req.abort().catch(() => {});
//             req.continue().catch(() => {});
//         });

//         await p.evaluateOnNewDocument(() => {
//             window.open = () => null;
//             window.alert = () => {};
//             window.confirm = () => true;
//             window.prompt = () => null;
//             const style = document.createElement('style');
//             style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
//             document.documentElement.appendChild(style);
//         });
//     } catch (e) {}
// }

// async function showLoadingOverlay(p, title, subtitle) {
//     try {
//         await p.evaluate((t, s) => {
//             if (window.self !== window.top) return;
//             let el = document.getElementById('bot-loading-ui');
//             if (!el) {
//                 el = document.createElement('div');
//                 el.id = 'bot-loading-ui';
//                 el.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;background:#000;z-index:2147483647;display:flex;flex-direction:column;justify-content:center;align-items:center;color:#fff;font-family:sans-serif;';
//                 document.documentElement.appendChild(el);
//             }
//             el.innerHTML = `<h1 style="font-size:38px;margin-bottom:10px;color:#e50914;">${t}</h1><p style="font-size:20px;color:#aaa;">${s}</p>`;
//         }, title, subtitle);
//     } catch (e) {}
// }

// async function hideLoadingOverlay(p) {
//     try {
//         await p.evaluate(() => {
//             const el = document.getElementById('bot-loading-ui');
//             if (el) el.remove();
//         });
//     } catch (e) {}
// }

// // =========================================================================================
// // 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Supports Nested Iframes like webcric)
// // =========================================================================================
// async function lockAndPlayVideo(p) {
//     if (!p) return;
//     try {
//         if (SERVER_SELECTION !== 'None') {
//             await p.evaluate((srv) => {
//                 const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
//                 if (btn) btn.click();
//             }, SERVER_SELECTION).catch(() => {});
//             await new Promise(r => setTimeout(r, 2000));
//         }

//         // Click Play / Unmute across all frames
//         for (let attempt = 0; attempt < 8; attempt++) {
//             let playing = false;
//             for (const frame of p.frames()) {
//                 if (frame.isDetached()) continue;
//                 try {
//                     const status = await frame.evaluate((audioEnabled) => {
//                         const playSelectors = '.jw-icon-display, button[data-plyr="play"], .vjs-big-play-button, [class*="unmute"], .fp-play, .clappr-player, video';
//                         document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });

//                         let isPlaying = false;
//                         document.querySelectorAll('video').forEach(v => {
//                             if (v.paused) v.play().catch(() => {});
//                             v.muted = !audioEnabled;
//                             v.volume = audioEnabled ? 1.0 : 0.0;
//                             if (!v.paused && v.currentTime > 0) isPlaying = true;
//                         });
//                         return isPlaying;
//                     }, ENABLE_STREAM_AUDIO);
//                     if (status) { playing = true; break; }
//                 } catch (e) {}
//             }
//             if (playing) break;
//             await new Promise(r => setTimeout(r, 1500));
//         }

//         // Stretch largest iframe OR video inside EVERY frame (fixes nested iframes on webcric)
//         for (const frame of p.frames()) {
//             if (frame.isDetached()) continue;
//             await frame.evaluate((audioEnabled) => {
//                 if (window.__frameLockActive) return;
//                 window.__frameLockActive = true;
//                 setInterval(() => {
//                     document.documentElement.style.setProperty('background', '#000', 'important');
//                     if (document.body) document.body.style.setProperty('background', '#000', 'important');

//                     const v = document.querySelector('video');
//                     if (v && (v.clientWidth > 50 || !v.paused)) {
//                         v.muted = !audioEnabled;
//                         v.volume = audioEnabled ? 1.0 : 0.0;
//                         const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
//                         wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
//                         v.style.cssText = 'width:100% !important;height:100% !important;object-fit:contain !important;';
//                         document.querySelectorAll('.jw-controls, .plyr__controls, .vjs-control-bar').forEach(c => c.style.setProperty('display', 'none', 'important'));
//                         return;
//                     }

//                     // If this frame only hosts child iframes, maximize the main player iframe
//                     const iframes = Array.from(document.querySelectorAll('iframe'));
//                     let best = null, maxArea = 5000;
//                     iframes.forEach(f => {
//                         const area = f.clientWidth * f.clientHeight;
//                         if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
//                     });
//                     if (best) {
//                         iframes.forEach(f => { if (f !== best) f.style.setProperty('display', 'none', 'important'); });
//                         best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483645 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
//                     }
//                 }, 1000);
//             }, ENABLE_STREAM_AUDIO).catch(() => {});
//         }
//     } catch (e) {}
// }

// // =========================================================================================
// // 💓 HEALTH CHECK & WATCHDOG
// // =========================================================================================
// async function checkStreamHealth(p) {
//     if (!p) return { status: 'DEAD' };
//     try {
//         const checks = p.frames().map(async (frame) => {
//             if (frame.isDetached()) return null;
//             try {
//                 return await Promise.race([
//                     frame.evaluate(() => {
//                         const v = document.querySelector('video');
//                         if (v && !v.paused && v.readyState >= 2) {
//                             const frames = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : (v.webkitDecodedFrameCount || 0);
//                             return { status: 'HEALTHY', currentTime: v.currentTime, frames };
//                         }
//                         return null;
//                     }),
//                     new Promise(r => setTimeout(() => r(null), 1500))
//                 ]);
//             } catch (e) { return null; }
//         });
//         const results = await Promise.all(checks);
//         return results.find(r => r && r.status === 'HEALTHY') || { status: 'LOADING_OR_DEAD' };
//     } catch (e) {
//         return { status: 'DEAD' };
//     }
// }

// async function loadCurrentUrl(reason) {
//     const targetUrl = urlList[currentUrlIndex];
//     console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
//     try {
//         await page.goto('about:blank');
//         await page.bringToFront();
//         keepChromeOnTopAndHideOBS();
//         await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
//         await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
//         await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
//         await lockAndPlayVideo(page);
//         await hideLoadingOverlay(page);
//         keepChromeOnTopAndHideOBS();
//     } catch (e) {
//         console.log(`[⚠️] Page navigation warning: ${e.message}`);
//     }
//     try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
// }

// async function startWatchdog() {
//     let lastTime = -1, lastFrames = -1;
//     let freezeStart = Date.now(), urlStart = Date.now();
//     let deadStrikes = 0, ticks = 0;

//     while (true) {
//         if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

//         keepChromeOnTopAndHideOBS();
//         const currentUrl = urlList[currentUrlIndex];
//         const health = await checkStreamHealth(page);

//         if (health.status === 'HEALTHY') {
//             deadStrikes = 0;
//             const isStuck = (lastTime !== -1 && health.currentTime === lastTime && health.frames === lastFrames);

//             if (isStuck) {
//                 if (Date.now() - freezeStart > 18000) {
//                     currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                     await loadCurrentUrl('VIDEO FROZEN (18s)');
//                     freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//                 }
//             } else {
//                 lastTime = health.currentTime;
//                 lastFrames = health.frames;
//                 freezeStart = Date.now();
//                 await hideLoadingOverlay(page);
//             }

//             const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
//             if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
//                 await loadCurrentUrl('SCHEDULED 9-MIN REFRESH');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         } else {
//             deadStrikes++;
//             console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/5`);
//             if (deadStrikes >= 5) {
//                 deadStrikes = 0;
//                 currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
//                 await loadCurrentUrl('5 STRIKES -> FAILOVER NEXT URL');
//                 freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
//             }
//         }

//         ticks++;
//         if (ticks === 1 || ticks % 10 === 0) {
//             console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
//         }

//         await new Promise(r => setTimeout(r, 2000));
//     }
// }

// // =========================================================================================
// // 🚀 ENGINE STARTUP & AUTO-RESTART
// // =========================================================================================
// async function startEngine() {
//     console.log('[*] Configuring & Starting OBS Studio...');
//     setupOBSConfig();

//     obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

//     // Restored OBS Console Logs so you can verify RTMP streaming in GitHub Actions
//     obsProcess.stdout.on('data', (data) => {
//         const line = data.toString().trim();
//         if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
//             console.log(`[OBS]: ${line}`);
//         }
//     });
//     obsProcess.stderr.on('data', (data) => {
//         const msg = data.toString().trim();
//         if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
//             console.log(`[OBS Error]: ${msg}`);
//         }
//     });

//     await new Promise(r => setTimeout(r, 6000));

//     let obsConnected = false;
//     for (let i = 0; i < 12; i++) {
//         try {
//             await obs.connect('ws://127.0.0.1:4455', 'secret');
//             obsConnected = true;
//             console.log('[+] OBS WebSocket Connected!');
//             break;
//         } catch (e) {
//             await new Promise(r => setTimeout(r, 2000));
//         }
//     }

//     if (obsConnected) {
//         try { await obs.call('StartStream'); } catch (e) {}
//     }

//     const args = [
//         '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
//         '--window-position=0,0', '--kiosk', '--start-fullscreen',
//         '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
//         '--disable-blink-features=AutomationControlled', '--use-gl=egl'
//     ];

//     if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

//     const ublockPath = path.join(process.cwd(), 'ublock-lite');
//     if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
//         args.push(`--disable-extensions-except=${ublockPath}`);
//         args.push(`--load-extension=${ublockPath}`);
//         console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded!');
//     }

//     browser = await puppeteer.launch({
//         headless: false,
//         defaultViewport: { width: RES_W, height: RES_H },
//         ignoreDefaultArgs: ['--enable-automation'],
//         args
//     });

//     page = (await browser.pages())[0];

//     browser.on('targetcreated', async (target) => {
//         if (target.type() === 'page') {
//             const newPage = await target.page().catch(() => null);
//             if (newPage && newPage !== page) {
//                 setTimeout(() => newPage.close().catch(() => {}), 300);
//             }
//         }
//     });

//     keepChromeOnTopAndHideOBS();
//     await setupPageProtections(page);
//     await loadCurrentUrl('INITIAL BOOT');
//     await startWatchdog();
// }

// async function cleanup() {
//     try { await obs.disconnect(); } catch (e) {}
//     if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
//     if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
//     try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
// }

// setTimeout(() => {
//     try {
//         const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}"`;
//         execSync(cmd, { stdio: 'inherit' });
//         setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
//     } catch (e) {}
// }, 21000000);

// (async () => {
//     while (true) {
//         try { await startEngine(); }
//         catch (err) {
//             console.error('[🚨] Engine Error, restarting in 3s:', err.message);
//             await cleanup();
//             await new Promise(r => setTimeout(r, 3000));
//         }
//     }
// })();
