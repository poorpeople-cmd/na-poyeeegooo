const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync } = require('child_process');
const { OBSWebSocket } = require('obs-websocket-js');

// =========================================================================================
// 🛡️ GLOBAL CRASH SHIELD
// =========================================================================================
process.on('uncaughtException', (err) => console.error('[💥] UNCAUGHT EXCEPTION:', err.message));
process.on('unhandledRejection', (reason) => console.error('[💥] UNHANDLED REJECTION:', reason));

const obs = new OBSWebSocket();

// =========================================================================================
// ⚙️ CONFIGURATION & ENV VARIABLES
// =========================================================================================
const selectedQuality = process.env.STREAM_QUALITY || '720p';
const SERVER_SELECTION = (process.env.SERVER_SELECTION || 'None').trim();
const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';
const ENABLE_STREAM_AUDIO = process.env.ENABLE_STREAM_AUDIO !== 'OFF';
const SELECTED_CHANNEL = (process.env.OKRU_STREAM_ID || '1').trim();

const FORCE_REFRESH_MS = 9 * 60 * 1000;
const NO_REFRESH_DOMAINS = [
    'youtube.com', 'facebook.com', 'streamed.pk', 'cricstreams.',
    'sport4u.online', 'vercel.app', 'netlify.app'
];

let RES_W = 1280, RES_H = 720, BITRATE = 3000;
if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
else if (selectedQuality.includes('1080p')) { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }

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

const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

// =========================================================================================
// 🔗 MULTI-URL PARSER
// =========================================================================================
const rawUrls = (process.env.TARGET_URLS || 'https://dadocric.st/player.php?id=starsp3&v=m').trim();
const urlList = rawUrls
    .split(/[,|]/)
    .map(u => {
        let clean = u.split('::')[0].trim().replace(/^!/, '');
        if (clean && !clean.startsWith('http')) clean = 'https://' + clean;
        return clean;
    })
    .filter(u => u.length > 8);

if (urlList.length === 0) urlList.push('https://dadocric.st/player.php?id=starsp3&v=m');

let currentUrlIndex = 0;
let browser = null;
let page = null;
let obsProcess = null;

console.log(`[🚀] Engine Locked: ${RES_W}x${RES_H} @ ${BITRATE}kbps | Channel: ${SELECTED_CHANNEL}`);
console.log(`[📋] Loaded ${urlList.length} URLs for Failover:`, urlList);

// =========================================================================================
// 🎥 OBS CONFIGURATION (With OBS 30+ WebSocket Plugin Fix)
// =========================================================================================
function setupOBSConfig() {
    const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
    const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
    const scenesDir = path.join(obsDir, 'basic', 'scenes');
    const wsPluginDir = path.join(obsDir, 'plugin_config', 'obs-websocket');

    fs.mkdirSync(profilesDir, { recursive: true });
    fs.mkdirSync(scenesDir, { recursive: true });
    fs.mkdirSync(wsPluginDir, { recursive: true });

    // Legacy + Modern OBS WebSocket Config
    fs.writeFileSync(path.join(obsDir, 'global.ini'), `[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`);

    fs.writeFileSync(path.join(wsPluginDir, 'config.json'), JSON.stringify({
        alerts_enabled: false,
        auth_required: true,
        first_load: false,
        server_enabled: true,
        server_password: "secret",
        server_port: 4455
    }, null, 2));

    fs.writeFileSync(path.join(profilesDir, 'basic.ini'), `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Advanced\n[AdvOut]\nTrackIndex=1\nRecType=Standard\nEncoder=obs_x264\n[obs_x264]\nbitrate=${BITRATE}\nkeyint_sec=2\npreset=ultrafast\nprofile=main\ntune=zerolatency\n`);

    const serviceJson = {
        settings: { server: "rtmp://vsu.okcdn.ru/input/", key: ACTIVE_STREAM_KEY.trim() },
        type: "rtmp_custom"
    };
    fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

    // MainScene set as default so video + audio broadcast even if WebSocket is delayed
    const sceneJson = {
        current_scene: "MainScene",
        current_program_scene: "MainScene",
        name: "Untitled",
        scene_order: [{ name: "WaitingScene" }, { name: "MainScene" }],
        sources: [
            { id: "xshm_input", name: "Screen", settings: { show_cursor: false } },
            { id: "pulse_output_capture", name: "Audio", settings: {} },
            { id: "scene", name: "MainScene", settings: { items: [{ name: "Screen", id: 1, visible: true }, { name: "Audio", id: 2, visible: true }] } },
            { id: "scene", name: "WaitingScene", settings: { items: [{ name: "Screen", id: 1, visible: true }] } }
        ]
    };
    fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
}

// =========================================================================================
// 🪟 HIDE OBS WINDOW & FORCE CHROME ON TOP (X11 / Xvfb Fix)
// =========================================================================================
function keepChromeOnTopAndHideOBS() {
    try {
        // Move OBS window far off-screen and minimize it so it never appears on stream
        execSync('xdotool search --name "OBS" windowmove 5000 5000 windowminimize || true', { stdio: 'ignore' });
        // Force Chrome window to 0,0 with full resolution and bring to front
        execSync(`xdotool search --onlyvisible --class "chrome" windowmove 0 0 windowsize ${RES_W} ${RES_H} windowactivate || true`, { stdio: 'ignore' });
        execSync('wmctrl -a "Chrome" || true', { stdio: 'ignore' });
    } catch (e) {}
}

// =========================================================================================
// 🛡️ POPUP & AD FIREWALL + LOADING UI
// =========================================================================================
async function setupPageProtections(p) {
    try {
        await p.setRequestInterception(true);
        p.on('request', (req) => {
            const url = req.url().toLowerCase();
            const badWords = ['popads', 'exoclick', 'adsterra', 'onclickads', 'doubleclick', 'adexchangerapid', 'bet365', '1xbet'];
            if (badWords.some(w => url.includes(w))) return req.abort().catch(() => {});
            req.continue().catch(() => {});
        });

        await p.evaluateOnNewDocument(() => {
            window.open = () => null;
            window.alert = () => {};
            window.confirm = () => true;
            window.prompt = () => null;
            const style = document.createElement('style');
            style.textContent = `html, body { background-color: #000 !important; overflow: hidden !important; margin: 0 !important; }`;
            document.documentElement.appendChild(style);
        });
    } catch (e) {}
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
                document.documentElement.appendChild(el);
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
// 🎬 VIDEO PLAYER AUTO-PLAY & FULLSCREEN LOCK (Supports Nested Iframes like webcric)
// =========================================================================================
async function lockAndPlayVideo(p) {
    if (!p) return;
    try {
        if (SERVER_SELECTION !== 'None') {
            await p.evaluate((srv) => {
                const btn = Array.from(document.querySelectorAll('button, a, div')).find(b => b.innerText && b.innerText.trim().includes(srv));
                if (btn) btn.click();
            }, SERVER_SELECTION).catch(() => {});
            await new Promise(r => setTimeout(r, 2000));
        }

        // Click Play / Unmute across all frames
        for (let attempt = 0; attempt < 8; attempt++) {
            let playing = false;
            for (const frame of p.frames()) {
                if (frame.isDetached()) continue;
                try {
                    const status = await frame.evaluate((audioEnabled) => {
                        const playSelectors = '.jw-icon-display, button[data-plyr="play"], .vjs-big-play-button, [class*="unmute"], .fp-play, .clappr-player, video';
                        document.querySelectorAll(playSelectors).forEach(el => { try { el.click(); } catch(e){} });

                        let isPlaying = false;
                        document.querySelectorAll('video').forEach(v => {
                            if (v.paused) v.play().catch(() => {});
                            v.muted = !audioEnabled;
                            v.volume = audioEnabled ? 1.0 : 0.0;
                            if (!v.paused && v.currentTime > 0) isPlaying = true;
                        });
                        return isPlaying;
                    }, ENABLE_STREAM_AUDIO);
                    if (status) { playing = true; break; }
                } catch (e) {}
            }
            if (playing) break;
            await new Promise(r => setTimeout(r, 1500));
        }

        // Stretch largest iframe OR video inside EVERY frame (fixes nested iframes on webcric)
        for (const frame of p.frames()) {
            if (frame.isDetached()) continue;
            await frame.evaluate((audioEnabled) => {
                if (window.__frameLockActive) return;
                window.__frameLockActive = true;
                setInterval(() => {
                    document.documentElement.style.setProperty('background', '#000', 'important');
                    if (document.body) document.body.style.setProperty('background', '#000', 'important');

                    const v = document.querySelector('video');
                    if (v && (v.clientWidth > 50 || !v.paused)) {
                        v.muted = !audioEnabled;
                        v.volume = audioEnabled ? 1.0 : 0.0;
                        const wrap = v.closest('.jwplayer, #player, .plyr, .vjs-player, [data-player], .player-poster') || v;
                        wrap.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483646 !important;background:#000 !important;';
                        v.style.cssText = 'width:100% !important;height:100% !important;object-fit:contain !important;';
                        document.querySelectorAll('.jw-controls, .plyr__controls, .vjs-control-bar').forEach(c => c.style.setProperty('display', 'none', 'important'));
                        return;
                    }

                    // If this frame only hosts child iframes, maximize the main player iframe
                    const iframes = Array.from(document.querySelectorAll('iframe'));
                    let best = null, maxArea = 5000;
                    iframes.forEach(f => {
                        const area = f.clientWidth * f.clientHeight;
                        if (area > maxArea && f.clientWidth >= f.clientHeight) { maxArea = area; best = f; }
                    });
                    if (best) {
                        iframes.forEach(f => { if (f !== best) f.style.setProperty('display', 'none', 'important'); });
                        best.style.cssText = 'position:fixed !important;top:0 !important;left:0 !important;width:100vw !important;height:100vh !important;z-index:2147483645 !important;border:none !important;background:#000 !important;display:block !important;visibility:visible !important;';
                    }
                }, 1000);
            }, ENABLE_STREAM_AUDIO).catch(() => {});
        }
    } catch (e) {}
}

// =========================================================================================
// 💓 HEALTH CHECK & WATCHDOG
// =========================================================================================
async function checkStreamHealth(p) {
    if (!p) return { status: 'DEAD' };
    try {
        const checks = p.frames().map(async (frame) => {
            if (frame.isDetached()) return null;
            try {
                return await Promise.race([
                    frame.evaluate(() => {
                        const v = document.querySelector('video');
                        if (v && !v.paused && v.readyState >= 2) {
                            const frames = v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality().totalVideoFrames : (v.webkitDecodedFrameCount || 0);
                            return { status: 'HEALTHY', currentTime: v.currentTime, frames };
                        }
                        return null;
                    }),
                    new Promise(r => setTimeout(() => r(null), 1500))
                ]);
            } catch (e) { return null; }
        });
        const results = await Promise.all(checks);
        return results.find(r => r && r.status === 'HEALTHY') || { status: 'LOADING_OR_DEAD' };
    } catch (e) {
        return { status: 'DEAD' };
    }
}

async function loadCurrentUrl(reason) {
    const targetUrl = urlList[currentUrlIndex];
    console.log(`\n[🔄] ${reason} -> Loading URL [${currentUrlIndex + 1}/${urlList.length}]: ${targetUrl}`);

    try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
    try {
        await page.goto('about:blank');
        await page.bringToFront();
        keepChromeOnTopAndHideOBS();
        await showLoadingOverlay(page, "CONNECTING STREAM", `Server ${currentUrlIndex + 1} of ${urlList.length}`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await showLoadingOverlay(page, "OPTIMIZING PLAYER", "Locking fullscreen video...");
        await lockAndPlayVideo(page);
        await hideLoadingOverlay(page);
        keepChromeOnTopAndHideOBS();
    } catch (e) {
        console.log(`[⚠️] Page navigation warning: ${e.message}`);
    }
    try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
}

async function startWatchdog() {
    let lastTime = -1, lastFrames = -1;
    let freezeStart = Date.now(), urlStart = Date.now();
    let deadStrikes = 0, ticks = 0;

    while (true) {
        if (!browser || !browser.isConnected()) throw new Error('Browser disconnected');

        keepChromeOnTopAndHideOBS();
        const currentUrl = urlList[currentUrlIndex];
        const health = await checkStreamHealth(page);

        if (health.status === 'HEALTHY') {
            deadStrikes = 0;
            const isStuck = (lastTime !== -1 && health.currentTime === lastTime && health.frames === lastFrames);

            if (isStuck) {
                if (Date.now() - freezeStart > 18000) {
                    currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
                    await loadCurrentUrl('VIDEO FROZEN (18s)');
                    freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
                }
            } else {
                lastTime = health.currentTime;
                lastFrames = health.frames;
                freezeStart = Date.now();
                await hideLoadingOverlay(page);
            }

            const isExempt = NO_REFRESH_DOMAINS.some(d => currentUrl.includes(d));
            if (!isExempt && (Date.now() - urlStart > FORCE_REFRESH_MS)) {
                await loadCurrentUrl('SCHEDULED 9-MIN REFRESH');
                freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
            }
        } else {
            deadStrikes++;
            console.log(`[⚠️] Stream Unhealthy (${health.status}) - Strike ${deadStrikes}/5`);
            if (deadStrikes >= 5) {
                deadStrikes = 0;
                currentUrlIndex = (currentUrlIndex + 1) % urlList.length;
                await loadCurrentUrl('5 STRIKES -> FAILOVER NEXT URL');
                freezeStart = Date.now(); urlStart = Date.now(); lastTime = -1;
            }
        }

        ticks++;
        if (ticks === 1 || ticks % 10 === 0) {
            console.log(`[💓] HEARTBEAT | Status: ${health.status} | Time: ${health.currentTime ? health.currentTime.toFixed(1) + 's' : 'N/A'} | Frames: ${health.frames ?? 'N/A'} | Active URL [${currentUrlIndex + 1}/${urlList.length}]`);
        }

        await new Promise(r => setTimeout(r, 2000));
    }
}

// =========================================================================================
// 🚀 ENGINE STARTUP & AUTO-RESTART
// =========================================================================================
async function startEngine() {
    console.log('[*] Configuring & Starting OBS Studio...');
    setupOBSConfig();

    obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray', '--disable-updater']);

    // Restored OBS Console Logs so you can verify RTMP streaming in GitHub Actions
    obsProcess.stdout.on('data', (data) => {
        const line = data.toString().trim();
        if (line.includes('rtmp') || line.includes('stream') || line.includes('Websocket') || line.includes('output')) {
            console.log(`[OBS]: ${line}`);
        }
    });
    obsProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim();
        if (msg.toLowerCase().includes('error') || msg.toLowerCase().includes('fail')) {
            console.log(`[OBS Error]: ${msg}`);
        }
    });

    await new Promise(r => setTimeout(r, 6000));

    let obsConnected = false;
    for (let i = 0; i < 12; i++) {
        try {
            await obs.connect('ws://127.0.0.1:4455', 'secret');
            obsConnected = true;
            console.log('[+] OBS WebSocket Connected!');
            break;
        } catch (e) {
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (obsConnected) {
        try { await obs.call('StartStream'); } catch (e) {}
    }

    const args = [
        '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`,
        '--window-position=0,0', '--kiosk', '--start-fullscreen',
        '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled', '--use-gl=egl'
    ];

    if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');

    const ublockPath = path.join(process.cwd(), 'ublock-lite');
    if (fs.existsSync(path.join(ublockPath, 'manifest.json'))) {
        args.push(`--disable-extensions-except=${ublockPath}`);
        args.push(`--load-extension=${ublockPath}`);
        console.log('[🛡️] uBlock Origin Lite MV3 Extension Loaded!');
    }

    browser = await puppeteer.launch({
        headless: false,
        defaultViewport: { width: RES_W, height: RES_H },
        ignoreDefaultArgs: ['--enable-automation'],
        args
    });

    page = (await browser.pages())[0];

    browser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
            const newPage = await target.page().catch(() => null);
            if (newPage && newPage !== page) {
                setTimeout(() => newPage.close().catch(() => {}), 300);
            }
        }
    });

    keepChromeOnTopAndHideOBS();
    await setupPageProtections(page);
    await loadCurrentUrl('INITIAL BOOT');
    await startWatchdog();
}

async function cleanup() {
    try { await obs.disconnect(); } catch (e) {}
    if (browser) { try { await browser.close(); } catch (e) {} browser = null; }
    if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch (e) {} obsProcess = null; }
    try { execSync('pkill -9 obs chrome ffplay || true', { stdio: 'ignore' }); } catch (e) {}
}

setTimeout(() => {
    try {
        const cmd = `gh workflow run main.yml -f target_urls="${process.env.TARGET_URLS || ''}" -f okru_stream_channel="${SELECTED_CHANNEL}" -f server_selection="${SERVER_SELECTION}" -f stream_quality="${selectedQuality}" -f proxy_engine="${PROXY_ENGINE}" -f enable_stream_audio="${process.env.ENABLE_STREAM_AUDIO || 'ON'}"`;
        execSync(cmd, { stdio: 'inherit' });
        setTimeout(async () => { await cleanup(); process.exit(0); }, 60000);
    } catch (e) {}
}, 21000000);

(async () => {
    while (true) {
        try { await startEngine(); }
        catch (err) {
            console.error('[🚨] Engine Error, restarting in 3s:', err.message);
            await cleanup();
            await new Promise(r => setTimeout(r, 3000));
        }
    }
})();
