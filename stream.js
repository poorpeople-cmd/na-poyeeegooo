
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, execSync, exec } = require('child_process');
const { OBSWebSocket } = require('obs-websocket-js'); 

// =========================================================================================
// 🛡️ GLOBAL CRASH PREVENTION SHIELD (DEBUGGING MODE)
// =========================================================================================
process.on('uncaughtException', (err) => {
    console.error('\n========================================');
    console.error('[💥] UNCAUGHT EXCEPTION');
    console.error(err);
    console.error(err.stack);
    console.error('========================================\n');
});

process.on('unhandledRejection', (reason) => {
    console.error('\n========================================');
    console.error('[💥] UNHANDLED REJECTION');
    console.error(reason);
    console.error('========================================\n');
});

const obs = new OBSWebSocket(); 

// =========================================================================================
// ⏱️ BIG VARIABLE: FORCE AUTO-REFRESH TIME (IN MINUTES)
// =========================================================================================
const FORCE_REFRESH_MINUTES = 40000; 
const FORCE_REFRESH_MS = FORCE_REFRESH_MINUTES * 60 * 1000;

// =========================================================================================
// 🛡️ NO-REFRESH WHITELIST (CONTINUOUS PLAY DOMAINS)
// =========================================================================================
const NO_REFRESH_DOMAINS = [
    'youtube.com',
    'facebook.com',
    'streamed.pk',
    'cricstreams.', 
    'sport4u.online',
    'website-vercel-helper-d-jaja-3-2.vercel.app',
    'websitestream.netlify.app/?ch=Channel%20HD%2071'
];

// 🚀 Multi-Stream Key Manager
const STREAM_KEYS = {
    '1'   : '15254238731883_15281627925099_najspfkgne', 
    '1.1' : '15254260751979_15281671637611_2plrcfqzze', 
    '1.2' : '15254285524587_15281717840491_7e6qdknzsu',
    
    '1.3' : '16983200374379_18360218880619_efmw4fchxm',
    '1.4' : '16983242579563_18360288741995_t2kh2jvcym',
    '1.5' : '16983247822443_18360297982571_3zs5ml7gua',
    '1.6' : '16983254834795_18360310237803_xrz3pf4uea',
    '1.7' : '16983259553387_18360317971051_6khoe5efge',
    '1.8' : '16983264468587_18360327342699_wsn7zgr7ee',
    '1.9' : '16983269514859_18360335075947_363qzjlbte',
    '1.10' : '16983277641323_18360347921003_rpf6hkqpdm',
    '1.11' : '16983286554219_18360360503915_lrqraxbz3y',
    
    
    
    '2'   : '15254299352683_15281743071851_7dvz3h5d7q',
    '2.1' : '15254308986475_15281761618539_3xca7oij3u',
    '2.2' : '15254328122987_15281795566187_zjqa6bqzoq', 

    '3'   : '15254341885547_15281821059691_hhlpb5vicy', 
    '3.1' : '15254357089899_15281848322667_sxeexgvzl4', 
    '3.2' : '15254367510123_15281868180075_pc4jrytfgm',
    '3.3' : '17485986405995_19233134873195_iw63xjblny',
    '3.4' : '17485996039787_19233150929515_d3yeoweuam',
    '3.5' : '17486002789995_19233161611883_mbg22slybe',
    '3.6' : '17486007770731_19233169934955_teme2zt4fm',

    '4'   : '15255022345835_15283095800427_vwrupxzstm', 
    '4.1' : '15255038074475_15283122080363_ai5qqp2we4', 
    '4.2' : '15255045480043_15283135842923_tldl4bhmii',
    '4.3' : '15255208599147_15283449629291_abltofuc7m', 
    '4.4' : '15255217708651_15283466603115_bojrrqtlmu', 
    '4.5' : '15255227670123_15283486263915_jpntt54mve',

    // '5'   : '15273689226859_15317451606635_d7zzy3c7qi',
    '5'   : '17135767461483_18625099401835_4gpytlxk4a',
    '5.1' : '15273713933931_15317494860395_avj47smmim', 
    '5.2' : '15273722257003_15317510195819_6edjluvdqi',
    '5.3' : '15273739624043_15317541653099_ii4bxpvabe',
    '5.4' : '15273750175339_15317561707115_csel26ku5a', 
    '5.5' : '15273760071275_15317579467371_cnewcj54me',
    '5.6' : '15273767935595_15317595851371_3q43tk7tvm', 
    '5.7' : '15273778683499_15317616560747_4piekvs4wu',
    
    's1.1'  : '14204232736303_14846150314543_37jq4ryehq',
    's1.2'  : '14204288179759_14846247373359_tnsknmapva',
    's1.3'  : '14204319768111_14846302489135_sr4ht4ccwq',
    's1.4'  : '14204331957807_14846326147631_dji2acqcze',
    's1.5'  : '14204346572335_14846351641135_7gvns4o5ue',
    's1.6'  : '14204361252399_14846376479279_cjajhf4d3y',
    's1.7'  : '14204370492975_14846393649711_6fduhdqite',
    's1.8'  : '14204395527727_14846438017583_s2jlti7lsm',
    's1.9'  : '14204411387439_14846464887343_f5lxgcqj5y',
    's1.10' : '14204424691247_14846487562799_xmbvntt6wa',

    's2.1'  : '14204490948143_14846603495983_kzevn36tii',
    's2.2'  : '14204506742319_14846634494511_ta2rxyg2oy',
    's2.3'  : '14204523322927_14846661233199_foqb3q7zb4',
    's2.4'  : '14204540034607_14846689085999_gjejdie4uy',
    's2.5'  : '14204555304495_14846715497007_zdanghuxzu',
    's2.6'  : '14204565200431_14846734371375_ap3bqpabpu',
    's2.7'  : '14204577259055_14846756194863_3ecad2535u',
    's2.8'  : '14204592528943_14846785227311_4hjl46y62e',
    's2.9'  : '14204602621487_14846802594351_ilnp6lxekq',
    's2.10' : '14206184136239_14849618610735_ihnbx7hkoi'
};

const selectedQuality = process.env.STREAM_QUALITY || 'Original (1080p Max)';
let RES_W = 1920, RES_H = 1080, BITRATE = 5000;

if (selectedQuality === '360p') { RES_W = 640; RES_H = 360; BITRATE = 800; }
else if (selectedQuality === '480p') { RES_W = 854; RES_H = 480; BITRATE = 1500; }
else if (selectedQuality === '720p') { RES_W = 1280; RES_H = 720; BITRATE = 3000; }
else if (selectedQuality === '1080p') { RES_W = 1920; RES_H = 1080; BITRATE = 4500; }
else { RES_W = 1920; RES_H = 1080; BITRATE = 6000; }

console.log(`[🚀] Smart Engine Locked to: ${RES_W}x${RES_H} @ ${BITRATE}kbps`);
console.log(`[⏱️] Auto-Refresh Time Set To: ${FORCE_REFRESH_MINUTES} Minutes`);

// =========================================================================================
// 🔄 DYNAMIC URL PARSER & METADATA EXTRACTOR
// =========================================================================================
let rawUrls = (process.env.TARGET_URLS || '').trim();
let urlList = [];

if (rawUrls !== '') {
    urlList = rawUrls.split(',').map(u => {
        let trimmed = u.trim();
        let hangThreshold = 8000; 
        if (trimmed.startsWith('!')) { hangThreshold = 20000; trimmed = trimmed.substring(1); }
        if (!trimmed.startsWith('http')) trimmed = 'https://' + trimmed;
        return { url: trimmed, hangTime: hangThreshold };
    });
} else {
    urlList = [
        { url: 'https://sport4u.online', hangTime: 8000 },
        { url: 'https://dadocric.st/player.php?id=starsp3&v=m', hangTime: 8000 }
    ];
}

function getSafeBackupIndex(activeIndex, currentIndex, list) {
    if (list.length <= 1) return 0; 
    let next = (currentIndex + 1) % list.length;
    let attempts = 0;
    while (next === activeIndex && attempts < list.length) {
        next = (next + 1) % list.length;
        attempts++;
    }
    return next;
}

let currentUrlIndex = 0;
let backupUrlIndex = getSafeBackupIndex(currentUrlIndex, currentUrlIndex, urlList);

const SELECTED_CHANNEL = process.env.OKRU_STREAM_ID || '1';
const SERVER_SELECTION = process.env.SERVER_SELECTION || 'None'; 
const PROXY_ENGINE = process.env.PROXY_ENGINE || 'Cloudflare WARP (Recommended)';

const ACTIVE_STREAM_KEY = STREAM_KEYS[SELECTED_CHANNEL] || STREAM_KEYS['1'];

let browserArgs = []; 
let activeBrowser = null;
let backupBrowser = null;
let activeBrowserName = "CHROME 1";
let backupBrowserName = "CHROME 2";
let obsProcess = null;
let activePage = null;
let backupPage = null;

// =========================================================================================
// 🧠 SMART URL ENGINE MEMORY (Remembers whether URL needs OLD or NEW/KING1 mode)
// =========================================================================================
const urlEngineMemory = {}; // e.g., { 'dlhd.pk': 'NEW', 'dadocric.st': 'OLD' }

// 🟢 URL ke hisaab se Automatic Engine Builder (OLD vs NEW)
function getBrowserArgsForUrl(targetUrl) {
    let mode = 'OLD'; // By default OLD tareeqa
    const urlStr = typeof targetUrl === 'string' ? targetUrl : '';
    
    // Check if domain is in memory
    for (let domain in urlEngineMemory) {
        if (urlStr.includes(domain)) {
            mode = urlEngineMemory[domain];
            break;
        }
    }

    console.log(`[🧠 MEMORY ENGINE] URL: ${urlStr.substring(0, 30)}... | Assigned Mode: ${mode}`);

    let args = [
        '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`, '--window-position=0,0', '--kiosk', '--start-fullscreen',
        '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage', '--ignore-certificate-errors',
        '--ignore-gpu-blocklist', '--use-gl=egl', '--disable-accelerated-video-decode', '--disable-accelerated-video-encode',
        '--disable-smooth-scrolling', '--disable-blink-features=AutomationControlled',
        '--disable-features=Translate,BlinkGenPropertyTrees,CalculateNativeWinOcclusion,NetworkServiceInProcess2',
        '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        '--alsa-output-device=default'
    ];

    if (mode === 'OLD') {
        // 🔴 OLD MODE FLAGS (Web security disabled + Extensions/Firewall allowed)
        args.push('--disable-web-security');
        args.push('--allow-running-insecure-content');
        args.push(`--disable-extensions-except=${path.join(process.cwd(), 'ublock-lite')}`);
        args.push(`--load-extension=${path.join(process.cwd(), 'ublock-lite')}`);
    } else {
        // 🟢 NEW MODE FLAGS (King1 clean mode - No web security override, no ublock extension to prevent fake playback error)
    }

    if (PROXY_ENGINE.includes('Cloudflare')) args.push('--proxy-server=socks5://127.0.0.1:40000');
    return args;
}

async function createBrowserInstance(targetUrl) {
    const customArgs = getBrowserArgsForUrl(targetUrl);
    return await puppeteer.launch({
        headless: false, 
        defaultViewport: { width: RES_W, height: RES_H },
        ignoreDefaultArgs: ['--enable-automation'], 
        args: customArgs
    });
}

// 🟢 Error Detector & Memory Updater function
// 🟢 Error Detector & Memory Updater function (ADVANCED: Scans inside IFrames)
// 🟢 Error Detector & Memory Updater function (BULLETPROOF: IFrames + 3Sec Delay Check)
async function detectAndRememberError(page, currentUrl) {
    try {
        let hasError = false;
        
        // ⏱️ 3 Dafa check karega (Har 1 second baad) taakey delayed error miss na ho
        for (let attempt = 0; attempt < 5; attempt++) {
            for (const frame of page.frames()) {
                if (frame.isDetached()) continue;
                try {
                    const textFound = await frame.evaluate(() => {
                        const bodyText = document.body ? document.body.innerText.toLowerCase() : '';
                        return bodyText.includes('playback error') || 
                               bodyText.includes('protected content') || 
                               bodyText.includes('domain is blocked') ||
                               bodyText.includes('error loading media') ||
                               bodyText.includes('stream unavailable');
                    });
                    
                    if (textFound) {
                        hasError = true;
                        break; // Frame loop break
                    }
                } catch (err) {}
            }
            
            if (hasError) break; // Main attempt loop break
            
            // Agar error nahi mila toh 1 second wait karke dobara check karega
            await new Promise(r => setTimeout(r, 1000));
        }

        if (hasError) {
            const hostname = new URL(currentUrl).hostname;
            urlEngineMemory[hostname] = 'NEW';
            console.log(`[🚨 MEMORY ALERT] Fake Playback Error detected inside iFrame on ${hostname}! Switching engine to NEW (King1 Mode).`);
            return true;
        }
    } catch(e) {}
    return false;
}

// =========================================================================================
// 🛡️ SMART BROWSER RECOVERY & FIREWALL
// =========================================================================================
async function preparePage(page) {
    if (!page) return;
    await setupNetworkAdBlocker(page);
    attachAntiAdListeners(page);
    await applyPreloadFirewall(page);
}

async function createFreshBackupBrowser() {
    console.log('\n[🛠️] BACKUP RECOVERY: Creating fresh backup Chrome...');
    try { if (backupBrowser && backupBrowser.isConnected()) { const pages = await backupBrowser.pages(); for (const p of pages) { try { await p.close(); } catch (e) {} } } } catch (e) {}
    try { if (backupBrowser && !backupBrowser.isConnected()) backupBrowser = null; } catch (e) { backupBrowser = null; }

    const targetUrl = (urlList[backupUrlIndex] && urlList[backupUrlIndex].url) ? urlList[backupUrlIndex].url : '';
    backupBrowser = await createBrowserInstance(targetUrl);
    const pages = await backupBrowser.pages();
    backupPage = pages[0];
    await preparePage(backupPage);
    
    // 🛡️ STOP FOCUS STEALING: Backup Chrome ko foran active chrome ke peechay bhej do
    try { if (activePage) await activePage.bringToFront(); } catch(e) {}

    backupBrowser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
            try { const newPage = await target.page(); setTimeout(async () => { if (newPage && newPage !== backupPage) { try { await newPage.close(); } catch (e) {} } }, 500); } catch (e) {}
        }
    });
    console.log('[✅] BACKUP RECOVERY: Fresh backup Chrome created.');
    return true;
}

async function createFreshActiveBrowser() {
    console.log('\n[🛠️] ACTIVE RECOVERY: Creating fresh active Chrome...');
    try { if (activeBrowser && activeBrowser.isConnected()) { const pages = await activeBrowser.pages(); for (const p of pages) { try { await p.close(); } catch (e) {} } } } catch (e) {}
    try { if (activeBrowser && !activeBrowser.isConnected()) activeBrowser = null; } catch (e) { activeBrowser = null; }

    const targetUrl = (urlList[currentUrlIndex] && urlList[currentUrlIndex].url) ? urlList[currentUrlIndex].url : '';
    activeBrowser = await createBrowserInstance(targetUrl);
    const pages = await activeBrowser.pages();
    activePage = pages[0];
    await preparePage(activePage);

    activeBrowser.on('targetcreated', async (target) => {
        if (target.type() === 'page') {
            try { const newPage = await target.page(); setTimeout(async () => { if (newPage && newPage !== activePage) { try { await newPage.close(); } catch (e) {} } }, 500); } catch (e) {}
        }
    });
    console.log('[✅] ACTIVE RECOVERY: Fresh active Chrome created.');
    return true;
}

async function setupNetworkAdBlocker(page) {
    if (!page) return;
    try {
        await page.setRequestInterception(true);
        page.on('request', (request) => {
            const url = request.url().toLowerCase();
            const type = request.resourceType();

            if (request.isNavigationRequest() && request.frame() === page.mainFrame()) {
                const targetUrl = request.url().toLowerCase();
                const adKeywords = ['popads', 'exoclick', 'adsterra', 'onclickads', 'jerkmate', 'adrevenue', 'fanduel', 'bet', 'casino'];
                if (adKeywords.some(keyword => targetUrl.includes(keyword))) {
                    console.log(`[🛡️] NAVIGATION SHIELD: Blocked malicious ad redirection to -> ${targetUrl.substring(0, 70)}...`);
                    request.abort().catch(()=>{});
                    return;
                }
            }

            if (url.includes('popads') || url.includes('exoclick') || url.includes('adsterra') || url.includes('onclickads') || url.includes('jerkmate') || url.includes('adrevenue') || url.includes('fanduel') || url.includes('doubleclick') || (type === 'script' && (url.includes('analytics') || url.includes('tracking') || url.includes('ad-delivery') || url.includes('pop') || url.includes('zone')))) {
                request.abort().catch(()=>{});
            } else {
                request.continue().catch(()=>{});
            }
        });
    } catch (e) { console.log('[⚠️] Request interception setup failed.'); }
}

async function applyPreloadFirewall(page) {
    if (!page) return;
    try {
        await page.evaluateOnNewDocument(() => {
            const originalAttachShadow = Element.prototype.attachShadow;
            Element.prototype.attachShadow = function(init) {
                if (init && init.mode === 'closed') init.mode = 'open'; 
                const shadowRoot = originalAttachShadow.call(this, init);
                const observer = new MutationObserver(() => {
                    const adElements = shadowRoot.querySelectorAll('in-page-message, [id^="note-"], [id^="missclick-"], [id^="close-"], [src*="adexchangerapid"]');
                    if (adElements.length > 0) { console.log('[🛡️] SHIELD: Shadow DOM Ad Detected & Destroyed!'); this.remove(); }
                });
                observer.observe(shadowRoot, { childList: true, subtree: true });
                return shadowRoot;
            };
            Element.prototype.attachShadow.toString = function() { return "function attachShadow() { [native code] }"; };
            window.alert = function() {}; window.confirm = function() { return true; }; window.prompt = function() { return null; }; window.open = function() { return null; };
            Object.defineProperty(window, 'onbeforeunload', { configurable: true, get: function() { return null; }, set: function() { return null; } });
            document.addEventListener('click', (e) => {
                const target = e.target;
                if (target && (target.tagName === 'A' || target.closest('a'))) {
                    const link = target.tagName === 'A' ? target : target.closest('a');
                    if (link.href && !link.href.includes(window.location.hostname) && !link.href.includes('javascript')) {
                        console.log("[🛡️] RE-DIRECT SHIELD: Blocked external ad navigation.");
                        e.preventDefault(); e.stopPropagation(); return false;
                    }
                }
            }, true);

            const style = document.createElement('style');
            style.textContent = `html, body { background-color: #000000 !important; overflow: hidden !important; } in-page-message, [id^="note-"], [id^="missclick-"], [id^="close-"] { display: none !important; opacity: 0 !important; pointer-events: none !important; }`;
            document.documentElement.appendChild(style);
        });
    } catch (e) {}
}

async function showLoadingUI(page, title, sub) {
    try {
        await page.evaluate((t, s) => {
            if (window.self !== window.top) return; 
            let overlay = document.getElementById('smart-stream-overlay');
            if (overlay) {
                const titleEl = overlay.querySelector('.stream-title');
                const subEl = overlay.querySelector('.stream-sub');
                if (titleEl) titleEl.innerHTML = t;
                if (subEl) subEl.innerHTML = s;
                overlay.style.setProperty('display', 'flex', 'important');
                overlay.style.setProperty('opacity', '1', 'important');
                overlay.style.setProperty('z-index', '2147483647', 'important');
            } else {
                overlay = document.createElement('div');
                overlay.id = 'smart-stream-overlay';
                overlay.innerHTML = `
                    <style>
                        #smart-stream-overlay { position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; width: 100vw !important; height: 100vh !important; background: #000000 !important; z-index: 2147483647 !important; display: flex !important; flex-direction: column !important; justify-content: center !important; align-items: center !important; color: #ffffff !important; font-family: -apple-system, BlinkMacSystemFont, sans-serif !important; pointer-events: all !important; }
                        .stream-spinner { width: 80px; height: 80px; border: 6px solid rgba(255, 255, 255, 0.1); border-top: 6px solid #e50914; border-radius: 50%; animation: spin-overlay 1s linear infinite; margin-bottom: 25px; box-shadow: 0 0 25px rgba(229, 9, 20, 0.4); }
                        .progress-container { width: 300px; height: 6px; background: rgba(255,255,255,0.1); border-radius: 10px; margin-bottom: 30px; overflow: hidden; position: relative; }
                        .progress-bar-fill { width: 100%; height: 100%; background: linear-gradient(90deg, #e50914, #ff4d4d); position: absolute; left: -100%; animation: shift-progress 2s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
                        @keyframes spin-overlay { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                        @keyframes shift-progress { 0% { left: -100%; } 50% { left: 0; } 100% { left: 100%; } }
                        .stream-title { font-size: 36px !important; font-weight: 800 !important; letter-spacing: 3px !important; margin-bottom: 15px !important; text-transform: uppercase !important; text-shadow: 0px 4px 10px rgba(0,0,0,0.8) !important; }
                        .stream-sub { font-size: 20px !important; color: #cccccc !important; text-align: center !important; line-height: 1.6 !important; }
                        .stream-blink { animation: blinker 1.5s linear infinite; color: #e50914; font-weight: bold; }
                        @keyframes blinker { 50% { opacity: 0.3; } }
                    </style>
                    <div class="stream-spinner"></div>
                    <div class="progress-container"><div class="progress-bar-fill"></div></div>
                    <div class="stream-title">${t}</div>
                    <div class="stream-sub">${s}</div>
                `;
                document.documentElement.appendChild(overlay);
            }
        }, title, sub);
    } catch (e) {}
}

async function hideLoadingUI(page) {
    try {
        await page.evaluate(() => {
            // Destroys any stuck loading overlays permanently
            const overlays = document.querySelectorAll('#smart-stream-overlay');
            overlays.forEach(overlay => overlay.remove());
        });
    } catch (e) {}
}

async function showRecoveryUI(page) {
    try {
        await page.evaluate(() => {
            if (window.self !== window.top) return; 
            let overlay = document.getElementById('stream-recovery-overlay');
            if (overlay) { overlay.style.setProperty('display', 'flex', 'important'); return; }
            overlay = document.createElement('div');
            overlay.id = 'stream-recovery-overlay';
            overlay.innerHTML = `
                <style>
                    #stream-recovery-overlay { position: fixed !important; top: 0 !important; left: 0 !important; right: 0 !important; bottom: 0 !important; width: 100vw !important; height: 100vh !important; background: rgba(0, 0, 0, 0.95) !important; z-index: 2147483647 !important; display: flex !important; flex-direction: column !important; justify-content: center !important; align-items: center !important; color: #ffffff !important; font-family: Arial, sans-serif !important; pointer-events: all !important; backdrop-filter: blur(8px); }
                    .recovery-radar { width: 100px; height: 100px; border-radius: 50%; border: 3px solid transparent; border-top-color: #ff9800; border-bottom-color: #ff9800; animation: radar-spin 1.5s cubic-bezier(0.68, -0.55, 0.265, 1.55) infinite; margin-bottom: 20px; box-shadow: 0 0 30px rgba(255, 152, 0, 0.3); }
                    .recovery-radar::before { content: ''; position: absolute; top: 10px; left: 10px; right: 10px; bottom: 10px; border-radius: 50%; border: 3px solid transparent; border-left-color: #f44336; border-right-color: #f44336; animation: radar-spin 2s linear infinite reverse; }
                    @keyframes radar-spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
                    .warn-title { font-size: 32px !important; font-weight: 800 !important; color: #ff9800 !important; letter-spacing: 2px !important; margin-bottom: 10px !important; text-transform: uppercase !important; }
                    .warn-sub { font-size: 18px !important; color: #dddddd !important; animation: pulse-text 1.5s infinite; }
                    @keyframes pulse-text { 0%, 100% { opacity: 1; } 50% { opacity: 0.5; } }
                </style>
                <div class="recovery-radar"></div>
                <div class="warn-title">SIGNAL LOST</div>
                <div class="warn-sub">Attempting Auto-Recovery...</div>
            `;
            document.documentElement.appendChild(overlay);
        });
    } catch (e) {}
}

async function hideRecoveryUI(page) {
    try { 
        await page.evaluate(() => { 
            const overlay = document.getElementById('stream-recovery-overlay'); 
            if (overlay) { 
                overlay.remove(); // Completely destroys the overlay element
            } 
        }); 
    } catch (e) {}
}

function setupOBSConfig() {
    const obsDir = path.join(os.homedir(), '.config', 'obs-studio');
    const profilesDir = path.join(obsDir, 'basic', 'profiles', 'Untitled');
    const scenesDir = path.join(obsDir, 'basic', 'scenes');

    fs.mkdirSync(profilesDir, { recursive: true });
    fs.mkdirSync(scenesDir, { recursive: true });

    const globalIniContent = `[General]\nLicenseAccepted=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n[OBSWebSocket]\nServerEnabled=true\nServerPort=4455\nServerPassword=secret\n`;
    fs.writeFileSync(path.join(obsDir, 'global.ini'), globalIniContent);
    
    const basicIniContent = `[General]\nName=Untitled\n[Video]\nBaseCX=${RES_W}\nBaseCY=${RES_H}\nOutputCX=${RES_W}\nOutputCY=${RES_H}\nFPSCommon=30\n[Output]\nMode=Simple\n[SimpleOutput]\nVBitrate=${BITRATE}\nStreamEncoder=x264\nx264Preset=ultrafast\nx264Settings=keyint=60 tune=zerolatency profile=main threads=4 rc-lookahead=0\n`;
    fs.writeFileSync(path.join(profilesDir, 'basic.ini'), basicIniContent);

    const serviceJson = { "settings": { "server": "rtmp://vsu.okcdn.ru/input/", "key": ACTIVE_STREAM_KEY }, "type": "rtmp_custom" };
    fs.writeFileSync(path.join(profilesDir, 'service.json'), JSON.stringify(serviceJson, null, 2));

    const sceneJson = {
        "current_scene": "WaitingScene", "current_program_scene": "WaitingScene", "name": "Untitled",
        "scene_order": [{"name": "WaitingScene"}, {"name": "MainScene"}],
        "sources": [
            { "id": "xshm_input", "name": "Screen", "settings": { "show_cursor": false } },
            { "id": "pulse_output_capture", "name": "Audio", "settings": {} },
            { "id": "scene", "name": "MainScene", "settings": { "items": [ {"name": "Screen", "id": 1, "visible": true}, {"name": "Audio", "id": 2, "visible": true} ] } },
            { "id": "scene", "name": "WaitingScene", "settings": { "items": [ {"name": "Screen", "id": 1, "visible": true} ] } }
        ]
    };
    fs.writeFileSync(path.join(scenesDir, 'Untitled.json'), JSON.stringify(sceneJson, null, 2));
}

function attachAntiAdListeners(page) {
    page.on('dialog', async dialog => { try { await dialog.dismiss(); } catch(e){} });
}

// 🛡️ Force Fullscreen instantly
async function forcePlayerFullscreen(page) {
    if (!page) return;
    try {
        await page.evaluate(() => {
            document.documentElement.style.setProperty('background-color', 'black', 'important');
            document.body.style.setProperty('background-color', 'black', 'important');
            document.body.style.setProperty('overflow', 'hidden', 'important');
            document.documentElement.style.setProperty('overflow', 'hidden', 'important');

            let iframes = Array.from(document.querySelectorAll('iframe'));
            let mainIframe = null; let maxScore = -1;

            iframes.forEach(ifr => {
                let w = ifr.clientWidth; let h = ifr.clientHeight;
                let area = w * h;
                if (area < 5000) return;
                let score = area;
                if (ifr.hasAttribute('allowfullscreen') || ifr.hasAttribute('webkitallowfullscreen')) score += 10000000;
                if (h > w) score = -1;
                if (score > maxScore) { maxScore = score; mainIframe = ifr; }
            });

            if (!mainIframe && iframes.length > 0) {
                mainIframe = iframes.find(ifr => ifr.getAttribute('allowfullscreen') !== null || (ifr.src && (ifr.src.includes('player') || ifr.src.includes('embed'))));
            }

            if (mainIframe) {
                iframes.forEach(ifr => {
                    if (ifr !== mainIframe) {
                        ifr.style.setProperty('display', 'none', 'important');
                        ifr.style.setProperty('opacity', '0', 'important');
                    }
                });
                mainIframe.style.setProperty('position', 'fixed', 'important');
                mainIframe.style.setProperty('top', '0px', 'important');
                mainIframe.style.setProperty('left', '0px', 'important');
                mainIframe.style.setProperty('width', '100vw', 'important');
                mainIframe.style.setProperty('height', '100vh', 'important');
                mainIframe.style.setProperty('z-index', '2147483645', 'important'); 
                mainIframe.style.setProperty('background-color', 'black', 'important');
                mainIframe.style.setProperty('border', 'none', 'important');
                mainIframe.style.setProperty('opacity', '1', 'important');
                mainIframe.style.setProperty('display', 'block', 'important');
                mainIframe.style.setProperty('visibility', 'visible', 'important');
            }

            const junkClasses = '.chat, #chat, header, footer, .sidebar, .banner, .ads, [class*="overlay"]:not(#smart-stream-overlay):not(#stream-recovery-overlay)';
            document.querySelectorAll(junkClasses).forEach(el => { try { el.remove(); } catch(e){ el.style.setProperty('display', 'none', 'important'); } });
        });
    } catch(e) {}
}

// 🛡️ NEW: Advanced Visual Readiness Verification (Checks actual Video Element & Playback)
// 🛡️ FIXED: Advanced Visual Readiness Verification (Searches ALL frames)
async function waitForActiveVisualReady(page) {
    if (!page) return false;
    let readyCount = 0;
    for (let i = 0; i < 40; i++) { // Max 20 seconds wait (500ms intervals)
        try {
            let isReady = false;
            for (const frame of page.frames()) {
                try {
                    if (frame.isDetached()) continue;
                    const frameReady = await frame.evaluate(() => {
                        let v = document.querySelector('video');
                        // Video element exists, has size, and is actively playing
                        return (v && v.clientWidth > 50 && !v.paused && v.currentTime > 0);
                    });
                    if (frameReady) { isReady = true; break; }
                } catch(err) {}
            }

            if (isReady) readyCount++; else readyCount = 0;
            if (readyCount >= 3) return true; // 3 consecutive passes required!
        } catch(e) {}
        await new Promise(r => setTimeout(r, 500));
    }
    return false;
}

async function triggerSmartUnmute(page) {
    for (const frame of page.frames()) {
        try {
            if (frame.isDetached()) continue;
            await frame.evaluate(() => {
                const potentialElements = Array.from(document.querySelectorAll('button, div, span, a, i'));
                potentialElements.forEach(el => {
                    const text = (el.innerText || el.textContent || '').trim().toUpperCase();
                    const onClickStr = (el.getAttribute('onclick') || '').toLowerCase();
                    const matchesText = text.includes('UNMUTE') || text.includes('MUTE ME') || text.includes('STREAM UNMUTE') || text.includes('AUDIO');
                    const matchesJS = onClickStr.includes('unmute') || onClickStr.includes('volume') || onClickStr.includes('audio');
                    if (matchesText || matchesJS) {
                        const rect = el.getBoundingClientRect();
                        const isVisible = rect.width > 0 && rect.height > 0 && window.getComputedStyle(el).display !== 'none';
                        if (isVisible) { try { el.click(); } catch(e) {} try { el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true })); } catch(e) {} }
                    }
                });
                document.querySelectorAll('video, audio').forEach(media => { if (media.muted) { media.muted = false; media.volume = 1.0; } });
            }).catch(() => {});
        } catch (e) {}
    }
}

async function initializeVideo(page, startMuted, isActivePage) {
    if (!page) return;
    try {
        if (SERVER_SELECTION !== 'None') {
            console.log(`[*] Clicking specific Server: ${SERVER_SELECTION}`);
            let serverClicked = false; let serverAttempts = 0;
            while (!serverClicked && serverAttempts < 10) { 
                serverAttempts++;
                try {
                    const clickSuccess = await page.evaluate((serverName) => {
                        const buttons = Array.from(document.querySelectorAll('button'));
                        const targetBtn = buttons.find(b => b.innerText && b.innerText.trim().includes(serverName));
                        if (targetBtn) { targetBtn.click(); return true; }
                        return false;
                    }, SERVER_SELECTION);
                    if (clickSuccess) { serverClicked = true; await new Promise(r => setTimeout(r, 2000)); if (isActivePage) await page.bringToFront(); } 
                    else await new Promise(r => setTimeout(r, 2000));
                } catch (err) { await new Promise(r => setTimeout(r, 2000)); }
            }
        }

        console.log('[*] Checking if Video is Autoplaying or Needs a Play Button...');
        let isVideoPlaying = false; let attempts = 0;
        
        while (!isVideoPlaying && attempts < 15) {
            for (const frame of page.frames()) {
                try {
                    const autoPlayed = await frame.evaluate(() => {
                        let playing = false;
                        document.querySelectorAll('video').forEach(v => { if (v.clientWidth > 50 && !v.paused && v.currentTime > 0) { v.muted = false; v.volume = 1.0; playing = true; } });
                        return playing;
                    });
                    if (autoPlayed) { isVideoPlaying = true; break; }

                    const playBtn = await frame.$('.jw-icon-display[aria-label="Play"], button[data-plyr="play"], .vjs-big-play-button, [class*="unmute"], .fp-play');
                    if (playBtn) {
                        const isVisible = await frame.evaluate(el => { const style = window.getComputedStyle(el); return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'; }, playBtn);
                        if (isVisible) { await frame.evaluate(el => el.click(), playBtn); await new Promise(r => setTimeout(r, 3000)); isVideoPlaying = true; break; }
                    }

                    if (!isVideoPlaying && attempts > 5) {
                        const forced = await frame.evaluate(async () => {
                            let played = false; let vids = document.querySelectorAll('video');
                            for(let v of vids) { if (v.clientWidth > 50) { v.muted = false; v.volume = 1.0; try { v.click(); } catch(e){} try { let p = v.play(); if (p !== undefined) p.catch(()=>{}); played = true; } catch(e) {} } }
                            return played;
                        });
                        if (forced) { isVideoPlaying = true; break; }
                    }
                } catch (err) {}
            }
            if (!isVideoPlaying) await new Promise(r => setTimeout(r, 2000));
            attempts++;
        }

        console.log('[*] Scanning for Exact Real Video Player...');
        let targetFrame = null;
        for (const frame of page.frames()) {
            try { const isRealLiveStream = await frame.evaluate(() => { const vid = document.querySelector('video'); return vid && vid.clientWidth > 50 && vid.clientHeight > 50; }); if (isRealLiveStream) { targetFrame = frame; break; } } catch (e) { }
        }

        // Apply force fullscreen immediately once
        await forcePlayerFullscreen(page);

        // Keep maintaining it
        await page.evaluate(() => {
            setInterval(() => {
                try {
                    let iframes = Array.from(document.querySelectorAll('iframe'));
                    let mainIframe = iframes.find(ifr => ifr.style.width === '100vw' && ifr.style.height === '100vh');
                    if (mainIframe) {
                        iframes.forEach(ifr => { if (ifr !== mainIframe) { ifr.style.setProperty('display', 'none', 'important'); } });
                    }
                } catch (err) {}
            }, 500); 
        }).catch(() => {});

        await targetFrame.evaluate((muteVideo) => {
            window.isStreamMuted = muteVideo; 
            setInterval(() => {
                try {
                    const style = document.createElement('style');
                    style.innerHTML = `.jw-controls, .jw-ui, .plyr__controls, .vjs-control-bar, [data-player] .controls { display: none !important; opacity: 0 !important; visibility: hidden !important; }`;
                    document.head.appendChild(style);

                    const mediaElements = document.querySelectorAll('video, audio');
                    const videos = Array.from(document.querySelectorAll('video'));
                    let realVideo = null;

                    mediaElements.forEach(media => { media.muted = window.isStreamMuted; media.volume = window.isStreamMuted ? 0.0 : 1.0; });
                    if (!window.isStreamMuted) document.querySelectorAll('.jw-icon-volume.jw-off, .vjs-vol-muted, .plyr__control--pressed[data-plyr="mute"]').forEach(btn => { try { btn.click(); } catch(e){} });

                    for (const v of videos) { if (v.clientWidth > 100 && v.clientHeight > 100) { realVideo = v; break; } }
                    if (!realVideo && videos.length > 0) realVideo = videos[0];

                    if (realVideo) { 
                        let playerWrap = realVideo.closest('.jwplayer, #player, .plyr, .vjs-player, .shaka-video-container, [data-player]') || realVideo;
                        playerWrap.style.setProperty('position', 'fixed', 'important');
                        playerWrap.style.setProperty('top', '0px', 'important');
                        playerWrap.style.setProperty('left', '0px', 'important');
                        playerWrap.style.setProperty('width', '100vw', 'important');
                        playerWrap.style.setProperty('height', '100vh', 'important');
                        playerWrap.style.setProperty('z-index', '2147483646', 'important'); 
                        playerWrap.style.setProperty('background-color', 'black', 'important');
                        playerWrap.style.setProperty('opacity', '1', 'important');
                        playerWrap.style.setProperty('visibility', 'visible', 'important');
                        playerWrap.style.setProperty('display', 'block', 'important');
                        if (playerWrap !== realVideo) { realVideo.style.setProperty('width', '100%', 'important'); realVideo.style.setProperty('height', '100%', 'important'); }
                        realVideo.style.setProperty('object-fit', 'contain', 'important');
                    }
                } catch(err) {}
            }, 500); 
        }, startMuted).catch(() => {});

    } catch (e) { }

    if (!startMuted) { await triggerSmartUnmute(page); await new Promise(r => setTimeout(r, 1000)); }
}

// 🛡️ Active Tab Health Checker
async function checkPageStatus(page) {
    if (!page) return { status: 'DEAD' };
    try {
        for (const frame of page.frames()) {
            try {
                if (frame.isDetached()) continue;
                const result = await Promise.race([
                    frame.evaluate(() => {
                        const bodyText = document.body ? document.body.innerText.toLowerCase() : "";
                        if (bodyText.includes("stream error") || bodyText.includes("not found") || bodyText.includes("stream unavailable") || bodyText.includes("404") || bodyText.includes("domain is blocked") || bodyText.includes("error: forbidden") || bodyText.includes("does not have permission") || bodyText.includes("access denied") || (bodyText.includes("cloudflare") && bodyText.includes("blocked"))) {
                            return { status: 'CRITICAL_ERROR' };
                        }
                        const videos = Array.from(document.querySelectorAll('video'));
                        let targetV = null;
                        for (const v of videos) {
                            if (v.clientWidth > 0 && v.clientWidth < 100) continue;
                            if ((v.src && v.src.startsWith('blob:')) || v.matches('.jw-video, .plyr__video, .vjs-tech')) { targetV = v; break; }
                        }
                        if (!targetV && videos.length > 0) targetV = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
                        
                        if (targetV && !targetV.ended) {
                            let frames = 0;
                            if (targetV.getVideoPlaybackQuality) frames = targetV.getVideoPlaybackQuality().totalVideoFrames;
                            else if (targetV.webkitDecodedFrameCount !== undefined) frames = targetV.webkitDecodedFrameCount;
                            return { status: 'HEALTHY', currentTime: targetV.currentTime, decodedFrames: frames };
                        }
                        return { status: 'DEAD' };
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 4000))
                ]);
                if (result && result.status !== 'DEAD') return result;
            } catch (err) {}
        }
    } catch (e) { return { status: 'DEAD' }; }
    return { status: 'DEAD' };
}

// 🛡️ NEW: Dedicated Background Health Checker
async function checkBackgroundHealth(page) {
    if (!page) return { status: 'DEAD', currentTime: -1, decodedFrames: -1 };
    try {
        for (const frame of page.frames()) {
            try {
                if (frame.isDetached()) continue;
                const result = await Promise.race([
                    frame.evaluate(() => {
                        const bodyText = document.body ? document.body.innerText.toLowerCase() : "";
if (
    bodyText.includes('stream error') || bodyText.includes('not found') || bodyText.includes('stream unavailable') || bodyText.includes('404') || bodyText.includes('domain is blocked') ||
    bodyText.includes('error: forbidden') || bodyText.includes('does not have permission') || bodyText.includes('access denied') ||
    (bodyText.includes('cloudflare') && bodyText.includes('blocked'))
) {
    return { status: 'CRITICAL_ERROR', currentTime: -1, decodedFrames: -1 };
}
                        const videos = Array.from(document.querySelectorAll('video'));
                        let targetV = null;
                        for (const v of videos) {
                            if (v.clientWidth < 50 || v.clientHeight < 50) continue;
                            if ((v.src && v.src.startsWith('blob:')) || v.matches('.jw-video, .plyr__video, .vjs-tech')) { 
                                targetV = v; 
                                break; 
                            }
                        }
                        if (!targetV && videos.length > 0) {
                            targetV = videos.sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0];
                        }
                        if (!targetV) {
                            return { status: 'DEAD', currentTime: -1, decodedFrames: -1 };
                        }
                        let decodedFrames = 0;
                        if (targetV.getVideoPlaybackQuality) {
                            decodedFrames = targetV.getVideoPlaybackQuality().totalVideoFrames || 0;
                        } else if (targetV.webkitDecodedFrameCount !== undefined) {
                            decodedFrames = targetV.webkitDecodedFrameCount || 0;
                        }
                        return {
                            status: 'VIDEO_FOUND',
                            currentTime: Number(targetV.currentTime || 0),
                            decodedFrames,
                            paused: !!targetV.paused,
                            ended: !!targetV.ended,
                            width: targetV.clientWidth,
                            height: targetV.clientHeight
                        };
                    }),
                    new Promise((_, reject) => setTimeout(() => reject(new Error('Background health timeout')), 3000))
                ]);
                if (result && result.status !== 'DEAD') return result;
            } catch (err) {}
        }
    } catch (e) {
        return { status: 'DEAD', currentTime: -1, decodedFrames: -1 };
    }
    return { status: 'DEAD', currentTime: -1, decodedFrames: -1 };
}

async function startWatchdog() {
    let lastActiveTime = -1;
    let lastDecodedFrames = -1;
    let frozenCheckTimestamp = Date.now();

    let lastBackupTime = -1;
    let lastBackupDecodedFrames = -1;
    let backupFrozenCheckTimestamp = Date.now();

    let watchdogTicks = 0;
    let streamSetupTime = Date.now(); 
    let isWarmupPhase = true; 
    let backupWarmupTime = Date.now(); 
    const WARMUP_MAX_TIME = 15000; 

    // 🛡️ The Backup Rebuild Lock (Mutex)
    let isBackupRebuilding = false;

    let activeUrlStr = urlList[currentUrlIndex].url; 
    let backupUrlStr = urlList[backupUrlIndex].url;
    let currentStreamStartTime = Date.now(); 
    let isRecoveryUIShown = false;

    while (true) {
        const activeBrowserAlive = activeBrowser && activeBrowser.isConnected();
        const backupBrowserAlive = backupBrowser && backupBrowser.isConnected();

        if (!activeBrowserAlive && backupBrowserAlive) {
            console.log('\n==================================================');
            console.log('[🚨] ACTIVE CHROME DISCONNECTED');
            console.log('[🔄] BACKUP CHROME IS ALIVE');
            console.log('[⚡] PROMOTING BACKUP -> ACTIVE');
            console.log('==================================================\n');

            const oldActiveBrowser = activeBrowser; const oldActivePage = activePage;
            activeBrowser = backupBrowser; activePage = backupPage;
            backupBrowser = oldActiveBrowser; backupPage = oldActivePage;
            const oldActiveName = activeBrowserName; activeBrowserName = backupBrowserName; backupBrowserName = oldActiveName;

            const previousActiveIndex = currentUrlIndex; currentUrlIndex = backupUrlIndex; activeUrlStr = urlList[currentUrlIndex].url;
            backupUrlIndex = getSafeBackupIndex(currentUrlIndex, previousActiveIndex, urlList); backupUrlStr = urlList[backupUrlIndex].url;

            lastActiveTime = -1; lastDecodedFrames = -1; frozenCheckTimestamp = Date.now();
            streamSetupTime = Date.now(); currentStreamStartTime = Date.now();
            isWarmupPhase = true; backupWarmupTime = Date.now(); isRecoveryUIShown = false;
            isBackupRebuilding = false; 

            try { await activePage.bringToFront(); await hideLoadingUI(activePage); } catch (e) {}

            try {
                await createFreshBackupBrowser();
                await backupPage.goto(backupUrlStr, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
                await initializeVideo(backupPage, true, false);
            } catch (e) {}
            continue;
        }

        if (activeBrowserAlive && !backupBrowserAlive) {
            console.log('\n==================================================');
            console.log('[⚠️] BACKUP CHROME DISCONNECTED -> REBUILDING');
            console.log('==================================================\n');
            try {
                backupUrlIndex = getSafeBackupIndex(currentUrlIndex, backupUrlIndex, urlList); backupUrlStr = urlList[backupUrlIndex].url;
                await createFreshBackupBrowser();
                await backupPage.goto(backupUrlStr, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
                await initializeVideo(backupPage, true, false);
                backupWarmupTime = Date.now();
                isBackupRebuilding = false;
            } catch (e) {}
        }

        if (!activeBrowserAlive && !backupBrowserAlive) {
            console.log('\n==================================================');
            console.log('[🚨] BOTH CHROME INSTANCES DISCONNECTED -> RECOVERY');
            console.log('==================================================\n');
            try {
                currentUrlIndex = getSafeBackupIndex(currentUrlIndex, currentUrlIndex, urlList); activeUrlStr = urlList[currentUrlIndex].url;
                backupUrlIndex = getSafeBackupIndex(currentUrlIndex, currentUrlIndex, urlList); backupUrlStr = urlList[backupUrlIndex].url;

                await createFreshActiveBrowser();
                await activePage.goto(activeUrlStr, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
                await showLoadingUI(activePage, "SEARCHING SERVER", "Finding a stable stream connection...");
                await initializeVideo(activePage, false, true);
                
                const visualReady = await waitForActiveVisualReady(activePage); 
                if (visualReady) await hideLoadingUI(activePage);

                try {
                    await createFreshBackupBrowser();
                    await backupPage.goto(backupUrlStr, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
                    await initializeVideo(backupPage, true, false);
                } catch (backupError) {}

                try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}

                streamSetupTime = Date.now(); currentStreamStartTime = Date.now(); backupWarmupTime = Date.now();
                frozenCheckTimestamp = Date.now(); lastActiveTime = -1; lastDecodedFrames = -1;
                isWarmupPhase = true; isRecoveryUIShown = false;
                isBackupRebuilding = false;
            } catch (e) { await new Promise(r => setTimeout(r, 3000)); }
            continue;
        }

        let activeHangThresholdMs = urlList[currentUrlIndex].hangTime;
        let activeStatus = await checkPageStatus(activePage);

        // =========================================================================================
        // 🛡️ INDEPENDENT BACKGROUND SHIELD (Mutex Locked)
        // =========================================================================================
        let backgroundReady = false;
        if (!isBackupRebuilding && (Date.now() - backupWarmupTime > 30000)) { 
            let verifyStatus = await checkBackgroundHealth(backupPage);

            if (verifyStatus.status === 'VIDEO_FOUND') {
                for (let verify = 0; verify < 8; verify++) {
                    const checkState = await checkBackgroundHealth(backupPage);
                    if (checkState.status === 'VIDEO_FOUND' && checkState.currentTime > 0 && checkState.decodedFrames > 0) {
                        if (lastBackupTime !== checkState.currentTime || lastBackupDecodedFrames !== checkState.decodedFrames) {
                            backgroundReady = true;
                            lastBackupTime = checkState.currentTime;
                            lastBackupDecodedFrames = checkState.decodedFrames;
                            backupFrozenCheckTimestamp = Date.now();
                            break;
                        }
                    }
                    await new Promise(r => setTimeout(r, 1000));
                }
            }

            if (!backgroundReady) {
                console.log(`[🔴] BACKGROUND FAILED/FROZEN : Server [${backupUrlIndex}]`);
                console.log(`[🔎] BACKGROUND : MOVING TO NEXT SERVER`);
                
                backupUrlIndex = getSafeBackupIndex(currentUrlIndex, backupUrlIndex, urlList); 
                backupUrlStr = urlList[backupUrlIndex].url;
                isBackupRebuilding = true; // Lock ON

                (async () => {
                    try {
                        console.log(`[⏳] Starting background buffer rebuilding safely with MUTEX lock...`);
                        lastBackupTime = -1;
                        lastBackupDecodedFrames = -1;
                        backupFrozenCheckTimestamp = Date.now();

                        await backupPage.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(()=>{}); 
                        await applyPreloadFirewall(backupPage);
                        await backupPage.goto(backupUrlStr, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
                        await initializeVideo(backupPage, true, false);
                        
                        // 🟢 Check Backup Browser for Error during Watchdog Rebuild
                        const isBackupBlockedRebuild = await detectAndRememberError(backupPage, backupUrlStr);
                        if (isBackupBlockedRebuild) {
                            console.log(`[🔄 RESTARTING BACKUP] Relaunching Backup Browser in NEW Mode due to playback error...`);
                            try { await backupBrowser.close(); } catch(e){}
                            backupBrowser = await createBrowserInstance(backupUrlStr);
                            backupPage = (await backupBrowser.pages())[0];
                            await preparePage(backupPage);
                            await backupPage.goto(backupUrlStr, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
                            await initializeVideo(backupPage, true, false);
                        }
                        console.log(`[🖤] BACKGROUND REBUILD COMPLETE -> Server [${backupUrlIndex}]`);
                    } catch(e) {
                        console.log(`[🖤] BACKGROUND REBUILD ERROR: ${e.message}`);
                    } finally {
                        isBackupRebuilding = false; // Lock OFF
                        backupWarmupTime = Date.now();
                    }
                })();
            }
        }

        if (activeStatus.status === 'HEALTHY' && !isWarmupPhase) {
            let elapsedMs = Date.now() - currentStreamStartTime;
            let isExempted = NO_REFRESH_DOMAINS.some(domain => activeUrlStr.includes(domain));
            if (elapsedMs > FORCE_REFRESH_MS) { if (!isExempted) { activeStatus.status = 'FORCE_REFRESH'; } }
        }

if (activeStatus.status === 'HEALTHY') {
            let isTimeStuck = (lastActiveTime !== -1 && activeStatus.currentTime === lastActiveTime);

            if (isTimeStuck) {
                if (!isRecoveryUIShown) { await showRecoveryUI(activePage); isRecoveryUIShown = true; }
                if (Date.now() - frozenCheckTimestamp > activeHangThresholdMs) { activeStatus.status = 'FROZEN'; isRecoveryUIShown = false; }
            } else {
                lastActiveTime = activeStatus.currentTime; lastDecodedFrames = activeStatus.decodedFrames; frozenCheckTimestamp = Date.now();
                
                // Remove Recovery UI
                if (isRecoveryUIShown) { await hideRecoveryUI(activePage); isRecoveryUIShown = false; }
                
                // 🛡️ BULLETPROOF FALLBACK: Force remove Loading UI if stream is actually healthy
                await hideLoadingUI(activePage); 

                for (const frame of activePage.frames()) {
                    try {
                        if (!frame.isDetached()) {
                            frame.evaluate(() => { 
                                window.isStreamMuted = false;
                                document.querySelectorAll('video, audio').forEach(m => { m.muted = false; m.volume = 1.0; }); 
                                document.querySelectorAll('.jw-icon-volume.jw-off, .vjs-vol-muted, .plyr__control--pressed[data-plyr="mute"]').forEach(btn => { try { btn.click(); } catch(e){} });
                            }).catch(()=>{});
                        }
                    } catch(e) {}
                }
            }
        }

        if (backupPage) {
            for (const frame of backupPage.frames()) {
                try { if (!frame.isDetached()) frame.evaluate(() => { window.isStreamMuted = true; document.querySelectorAll('video, audio').forEach(m => { m.muted = true; m.volume = 0.0; }); }).catch(()=>{}); } catch(e) {}
            }
        }

        watchdogTicks++;
        if (watchdogTicks === 1 || watchdogTicks % 90 === 0) {
            let logBackupStatus = await checkBackgroundHealth(backupPage);
            console.log(`\n==================================================`);
            console.log(`[💓] ACTIVE HEARTBEAT (${activeBrowserName}): Status is ${activeStatus.status} | Video Time: ${activeStatus.currentTime ? activeStatus.currentTime.toFixed(1) + 's' : 'N/A'}`);
            console.log(`[▶️] CURRENTLY LIVE             : Server [${currentUrlIndex}] -> ${activeUrlStr}`);
            console.log(`--------------------------------------------------`);
            console.log(`[🖤] BACKUP HEARTBEAT (${backupBrowserName}): Status=${logBackupStatus.status} | Time=${logBackupStatus.currentTime !== undefined && logBackupStatus.currentTime !== -1 ? logBackupStatus.currentTime.toFixed(1) : 'N/A'} | Frames=${logBackupStatus.decodedFrames !== undefined && logBackupStatus.decodedFrames !== -1 ? logBackupStatus.decodedFrames : 'N/A'}`);
            if (!backgroundReady && !isBackupRebuilding && watchdogTicks > 1) {
                console.log(`[🖤] BACKGROUND BACKUP IS NOT HEALTHY (Waiting for repair...)`);
            }
            console.log(`[🔄] RUNNING IN BACKGROUND      : Server [${backupUrlIndex}] -> ${backupUrlStr}`);
            console.log(`==================================================\n`);
        }

        // =========================================================================================
        // 🔄 2. ACTIVE TAB HOT-SWAP SHIELD (SCENARIO A, B, C)
        // =========================================================================================
        if (activeStatus.status === 'FROZEN' || activeStatus.status === 'CRITICAL_ERROR' || activeStatus.status === 'DEAD' || activeStatus.status === 'FORCE_REFRESH') {
            
            if (isWarmupPhase && (Date.now() - streamSetupTime < WARMUP_MAX_TIME)) { 
                console.log(`[⏳] Watchdog detected '${activeStatus.status}', but stream is in WARM-UP phase. Waiting...`);
                await new Promise(r => setTimeout(r, 2000));
                continue; 
            }

            let isProactiveRefresh = (activeStatus.status === 'FORCE_REFRESH');
            if (isProactiveRefresh) console.log(`\n[!] 🔄 PROACTIVE REFRESH TRIGGERED`);
            else console.log(`\n[!] ❌ WATCHDOG DETECTED ISSUE: ${activeStatus.status}`);
            
            console.log(`[*] Checking Backup Tab status before switching...`);
            let backupStatusTest = await checkBackgroundHealth(backupPage);
            let isBackupHealthyForSwap = (backupStatusTest.status === 'VIDEO_FOUND' && backupStatusTest.currentTime > 0 && backupStatusTest.decodedFrames > 0);

            // --------------------------------------------------------------------
            // ⚡ SCENARIO A: INSTANT SEAMLESS HOT-SWAP
            // --------------------------------------------------------------------
            if (isBackupHealthyForSwap && !isProactiveRefresh) {
                console.log('\n[⚡] BACKUP STREAM ALREADY HEALTHY. PROMOTING INSTANTLY.');

                await showLoadingUI(backupPage, "RECONNECTING", "Establishing secure connection to backup server...");
                try { await backupPage.bringToFront(); } catch (e) {}

                let brokenPage = activePage; activePage = backupPage; backupPage = brokenPage;
                let brokenBrowser = activeBrowser; activeBrowser = backupBrowser; backupBrowser = brokenBrowser;
                let brokenName = activeBrowserName; activeBrowserName = backupBrowserName; backupBrowserName = brokenName;

                let previousActiveIndex = currentUrlIndex; currentUrlIndex = backupUrlIndex; activeUrlStr = urlList[currentUrlIndex].url; 
                backupUrlIndex = getSafeBackupIndex(currentUrlIndex, previousActiveIndex, urlList); backupUrlStr = urlList[backupUrlIndex].url;

                await forcePlayerFullscreen(activePage);

                for (const frame of activePage.frames()) {
                    try {
                        if (!frame.isDetached()) {
                            await frame.evaluate(() => { 
                                window.isStreamMuted = false;
                                document.querySelectorAll('video, audio').forEach(m => { m.muted = false; m.volume = 1.0; }); 
                                document.querySelectorAll('.jw-icon-volume.jw-off, .vjs-vol-muted, .plyr__control--pressed[data-plyr="mute"]').forEach(btn => { try { btn.click(); } catch(e){} });
                            });
                        }
                    } catch(e) {}
                }

                lastActiveTime = -1; lastDecodedFrames = -1; frozenCheckTimestamp = Date.now();
                isRecoveryUIShown = false; 

                streamSetupTime = Date.now(); currentStreamStartTime = Date.now();
                isWarmupPhase = true; 
                
                // 🛡️ 3. WAIT FOR VISUAL READINESS (No premature removal!)
                console.log(`[🛡️] SYSTEM SHIELD: Verifying stream layout before removing overlay...`);
                const activeVisualReady = await waitForActiveVisualReady(activePage);

                if (activeVisualReady) {
                    console.log(`[✅] Stream visually verified. Removing RECONNECTING shield.`);
                    await hideLoadingUI(activePage);
                } else {
                    console.log(`[🛡️] STREAM NOT VISUALLY READY. RECONNECTING SHIELD REMAINS ON.`);
                    await showLoadingUI(activePage, "RECONNECTING", "Waiting for live video signal...");
                }

                isWarmupPhase = false; 
                console.log(`[📺] NEW ACTIVE STREAM : Server [${currentUrlIndex}] -> ${activeUrlStr}`);

                // SAFE BACKGROUND REBUILD (IIFE)
                isBackupRebuilding = true;
                (async () => {
                    try {
                        console.log(`[⏳] Starting background buffer rebuilding safely...`);
                        lastBackupTime = -1;
                        lastBackupDecodedFrames = -1;
                        backupFrozenCheckTimestamp = Date.now();

                        await backupPage.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(()=>{}); 
                        await applyPreloadFirewall(backupPage);
                        await backupPage.goto(backupUrlStr, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
                        await initializeVideo(backupPage, true, false);
                        
                        // 🟢 Check Backup Browser for Error during Watchdog Rebuild
                        const isBackupBlockedRebuild = await detectAndRememberError(backupPage, backupUrlStr);
                        if (isBackupBlockedRebuild) {
                            console.log(`[🔄 RESTARTING BACKUP] Relaunching Backup Browser in NEW Mode due to playback error...`);
                            try { await backupBrowser.close(); } catch(e){}
                            backupBrowser = await createBrowserInstance(backupUrlStr);
                            backupPage = (await backupBrowser.pages())[0];
                            await preparePage(backupPage);
                            await backupPage.goto(backupUrlStr, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
                            await initializeVideo(backupPage, true, false);
                        }
                        
                    
                        console.log(`[🖤] BACKGROUND REBUILD COMPLETE -> Server [${backupUrlIndex}]`);
                    } catch (e) {
                        console.log(`[🖤] BACKGROUND REBUILD ERROR: ${e.message}`);
                    } finally {
                        isBackupRebuilding = false;
                        backupWarmupTime = Date.now();
                    }
                })();
            }

            // --------------------------------------------------------------------
            // 🔄 SCENARIO B: PROACTIVE REFRESH OR FORCED RECONNECTION
            // --------------------------------------------------------------------
            else if (isProactiveRefresh || (isBackupHealthyForSwap && isProactiveRefresh)) {
                for (const frame of activePage.frames()) { try { if (!frame.isDetached()) await frame.evaluate(() => { window.isStreamMuted = true; document.querySelectorAll('video, audio').forEach(m => { m.muted = true; m.volume = 0.0; }); }); } catch(e) {} }
                
                await showLoadingUI(backupPage, "REFRESHING CONNECTION", "Optimizing current server stream...");
                await backupPage.bringToFront();
                await new Promise(r => setTimeout(r, 1000)); 
                try { await backupPage.mouse.click(10, 10); } catch(e){} 

                await initializeVideo(backupPage, false, true); 
                
                let brokenPage = activePage; activePage = backupPage; backupPage = brokenPage;
                let brokenBrowser = activeBrowser; activeBrowser = backupBrowser; backupBrowser = brokenBrowser;
                let brokenName = activeBrowserName; activeBrowserName = backupBrowserName; backupBrowserName = brokenName;
                
                lastActiveTime = -1; frozenCheckTimestamp = Date.now(); isRecoveryUIShown = false; 
                let previousActiveIndex = currentUrlIndex; currentUrlIndex = backupUrlIndex; activeUrlStr = urlList[currentUrlIndex].url; 
                backupUrlIndex = getSafeBackupIndex(currentUrlIndex, previousActiveIndex, urlList); backupUrlStr = urlList[backupUrlIndex].url;

                const activeVisualReady = await waitForActiveVisualReady(activePage);
                if (activeVisualReady) {
                    await hideLoadingUI(activePage);
                } else {
                    await showLoadingUI(activePage, "RECONNECTING", "Waiting for live video signal...");
                }

                isBackupRebuilding = true;
                (async () => {
                    try {
                        console.log(`[⏳] Starting background buffer rebuilding safely...`);
                        lastBackupTime = -1;
                        lastBackupDecodedFrames = -1;
                        backupFrozenCheckTimestamp = Date.now();
                        await backupPage.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(()=>{}); 
                        await applyPreloadFirewall(backupPage);
                        await backupPage.goto(backupUrlStr, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
                        await initializeVideo(backupPage, true, false);
                        
                        // 🟢 Check Backup Browser for Error during Watchdog Rebuild
                        const isBackupBlockedRebuild = await detectAndRememberError(backupPage, backupUrlStr);
                        if (isBackupBlockedRebuild) {
                            console.log(`[🔄 RESTARTING BACKUP] Relaunching Backup Browser in NEW Mode due to playback error...`);
                            try { await backupBrowser.close(); } catch(e){}
                            backupBrowser = await createBrowserInstance(backupUrlStr);
                            backupPage = (await backupBrowser.pages())[0];
                            await preparePage(backupPage);
                            await backupPage.goto(backupUrlStr, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(()=>{});
                            await initializeVideo(backupPage, true, false);
                        }
                    } catch (e) {} finally {
                        isBackupRebuilding = false;
                        backupWarmupTime = Date.now();
                    }
                })();
                
                streamSetupTime = Date.now(); isWarmupPhase = true; currentStreamStartTime = Date.now(); 
            }

            // --------------------------------------------------------------------
            // ❌ SCENARIO C: BOTH TABS FAILED (Fresh Hunting Mode)
            // --------------------------------------------------------------------
            else {
                console.log(`\n[!] ❌ BOTH TABS FAILED. FRESH HUNTING MODE ACTIVATED.`);
                try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}

                currentUrlIndex = getSafeBackupIndex(currentUrlIndex, currentUrlIndex, urlList); activeUrlStr = urlList[currentUrlIndex].url;
                backupUrlIndex = getSafeBackupIndex(currentUrlIndex, currentUrlIndex, urlList); backupUrlStr = urlList[backupUrlIndex].url;

                try { await activePage.close(); } catch(e) {}
                try { await backupPage.close(); } catch(e) {}

                activePage = await activeBrowser.newPage(); backupPage = await backupBrowser.newPage();
                await setupNetworkAdBlocker(activePage); await setupNetworkAdBlocker(backupPage);
                attachAntiAdListeners(activePage); attachAntiAdListeners(backupPage);
                await applyPreloadFirewall(activePage); await applyPreloadFirewall(backupPage);

try {
                    await activePage.goto(activeUrlStr, { waitUntil: 'domcontentloaded', timeout: 60000 });
                    await showLoadingUI(activePage, "SEARCHING SERVER", "Hunting for a stable stream connection...");
                    await initializeVideo(activePage, false, true); 

                    // 🟢 Check if playback blocked in Hunting Mode
                    // 🟢 Check if playback blocked in Hunting Mode with STRICT SHIELD
                    // 🟢 Check if playback blocked in Hunting Mode with STRICT SHIELD
                    const isPlaybackBlockedWatchdog = await detectAndRememberError(activePage, activeUrlStr);
                    if (isPlaybackBlockedWatchdog) {
                        console.log(`[🔄 RESTARTING] Relaunching Active Browser in NEW Mode with Strict Fullscreen Shield...`);
                        try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
                        
                        // 🛡️ Use proper function to guarantee ALL popup blockers and firewalls are attached
                        await createFreshActiveBrowser();
                        await activePage.bringToFront();

                        try { await activePage.goto(activeUrlStr, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) {}
                        await showLoadingUI(activePage, "OPTIMIZING STREAM", "Applying Safe Mode...");
                        await initializeVideo(activePage, false, true);
                    }
                    
                    const activeVisualReady = await waitForActiveVisualReady(activePage);
                    if (activeVisualReady) {
                        await hideLoadingUI(activePage);
                    } else {
                        await showLoadingUI(activePage, "SEARCHING SERVER", "Hunting for a stable stream connection...");
                    }
                } catch(e) {}

                isBackupRebuilding = true;
                (async () => {
                    try {
                        await backupPage.goto('about:blank', { waitUntil: 'domcontentloaded', timeout: 10000 }).catch(()=>{}); 
                        await backupPage.goto(backupUrlStr, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
                        await initializeVideo(backupPage, true, false);
                        
                        // 🟢 Check Backup Browser for Error during Scenario C
                        // 🟢 Check Backup Browser for Error during Scenario C (With FOCUS STEAL FIX)
                        if (await detectAndRememberError(backupPage, backupUrlStr)) {
                            console.log(`[🔄 RESTARTING BACKUP] Relaunching Backup Browser in NEW Mode due to playback error...`);
                            await createFreshBackupBrowser();
                            try { if (activePage) await activePage.bringToFront(); } catch(e){} // 🛡️ Fix Focus Steal instantly
                            await backupPage.goto(backupUrlStr, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
                            await initializeVideo(backupPage, true, false);
                        }
                    } catch(e) {} finally {
                        isBackupRebuilding = false;
                        backupWarmupTime = Date.now();
                    }
                })();

                streamSetupTime = Date.now(); isWarmupPhase = true; currentStreamStartTime = Date.now(); 
                lastActiveTime = -1; frozenCheckTimestamp = Date.now(); isRecoveryUIShown = false;

                try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {}
            }
        } 
        await new Promise(r => setTimeout(r, 2000)); 
    }
}

async function startDirectStreaming() {
    activeBrowserName = "CHROME 1"; backupBrowserName = "CHROME 2";
    console.log(`[*] Starting OBS Studio FIRST...`); setupOBSConfig();

    obsProcess = spawn('obs', ['--startstreaming', '--minimize-to-tray']);
    obsProcess.stdout.on('data', (data) => console.log(`[OBS]: ${data.toString().trim()}`));
    obsProcess.stderr.on('data', (data) => {
        const msg = data.toString().trim(); if (msg.includes('error') || msg.includes('fail')) console.log(`[OBS Error]: ${msg}`);
    });

    console.log('[*] Waiting for OBS to initialize before launching browser...');
    await new Promise(r => setTimeout(r, 6000));

    let isObsConnected = false;
    for (let attempt = 1; attempt <= 15; attempt++) {
        try {
            await Promise.race([obs.connect('ws://127.0.0.1:4455', 'secret'), new Promise((_, reject) => setTimeout(() => reject(new Error('Timeout')), 3000))]);
            isObsConnected = true; console.log('[+] OBS WebSocket Connected Successfully!'); break;
        } catch (e) { await new Promise(r => setTimeout(r, 2000)); }
    }

    if (isObsConnected) { try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch(e){} }

    browserArgs = [
        '--no-sandbox', '--disable-setuid-sandbox', `--window-size=${RES_W},${RES_H}`, '--window-position=0,0', '--kiosk', '--start-fullscreen',
        '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage', '--ignore-certificate-errors', '--disable-web-security',
        '--ignore-gpu-blocklist', '--use-gl=egl', '--disable-accelerated-video-decode', '--disable-accelerated-video-encode',
        '--disable-smooth-scrolling', '--disable-blink-features=AutomationControlled',
        '--disable-features=Translate,BlinkGenPropertyTrees,CalculateNativeWinOcclusion,NetworkServiceInProcess2',
        '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding',
        `--disable-extensions-except=${path.join(process.cwd(), 'ublock-lite')}`, `--load-extension=${path.join(process.cwd(), 'ublock-lite')}`
    ];
    if (PROXY_ENGINE.includes('Cloudflare')) browserArgs.push('--proxy-server=socks5://127.0.0.1:40000');

activeBrowser = await createBrowserInstance(urlList[currentUrlIndex].url); activePage = (await activeBrowser.pages())[0];
    backupBrowser = await createBrowserInstance(urlList[backupUrlIndex].url); backupPage = (await backupBrowser.pages())[0];

    activeBrowser.on('targetcreated', async (target) => { if (target.type() === 'page') { const newPage = await target.page(); setTimeout(async () => { if (newPage && newPage !== activePage) { try { await newPage.close(); } catch(e) {} } }, 500); } });
    backupBrowser.on('targetcreated', async (target) => { if (target.type() === 'page') { const newPage = await target.page(); setTimeout(async () => { if (newPage && newPage !== backupPage) { try { await newPage.close(); } catch(e) {} } }, 500); } });

    await setupNetworkAdBlocker(activePage); await setupNetworkAdBlocker(backupPage);
    attachAntiAdListeners(activePage); attachAntiAdListeners(backupPage);
    await applyPreloadFirewall(activePage); await applyPreloadFirewall(backupPage);

    await activePage.bringToFront(); 

    try { await activePage.goto(urlList[currentUrlIndex].url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) {}
    await showLoadingUI(activePage, "STREAM LOADING", "Optimizing live video connection...");
    await initializeVideo(activePage, false, true); 

    // 🟢 Check if old mode gave a playback error, if so, switch to NEW mode instantly!
    // 🟢 Check if old mode gave a playback error, if so, switch to NEW mode with STRICT SHIELD
    // 🟢 Check if old mode gave a playback error, if so, switch to NEW mode with STRICT SHIELD
    const isPlaybackBlocked = await detectAndRememberError(activePage, urlList[currentUrlIndex].url);
    if (isPlaybackBlocked) {
        console.log(`[🔄 RESTARTING] Relaunching Active Browser in NEW Mode with Strict Fullscreen Shield...`);
        try { await obs.call('SetCurrentProgramScene', { sceneName: 'WaitingScene' }); } catch (e) {}
        
        // 🛡️ Use proper function to guarantee ALL popup blockers and firewalls are attached
        await createFreshActiveBrowser();
        await activePage.bringToFront();

        try { await activePage.goto(urlList[currentUrlIndex].url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) {}
        await showLoadingUI(activePage, "OPTIMIZING STREAM", "Applying Safe Mode...");
                await initializeVideo(activePage, false, true);
                await forcePlayerFullscreen(activePage); // EXPLICIT FORCE
            }
            
            // 🛡️ WAIT FOR VISUAL READINESS (Initial Load)
            
            // 🛡️ WAIT FOR VISUAL READINESS (Initial Load)
            const activeVisualReady = await waitForActiveVisualReady(activePage);
            
            // 🛡️ STRICT SETTLEMENT DELAY: Parda hatane se pehle 2.5 seconds wait karo taakey website CSS fully destroy ho jaye
            await new Promise(r => setTimeout(r, 2500));
            await forcePlayerFullscreen(activePage); 

            if (activeVisualReady) await hideLoadingUI(activePage); 

            if (isObsConnected) { try { await obs.call('SetCurrentProgramScene', { sceneName: 'MainScene' }); } catch (e) {} }

    try { await backupPage.goto(urlList[backupUrlIndex].url, { waitUntil: 'domcontentloaded', timeout: 60000 }); } catch (e) {}
    await initializeVideo(backupPage, true, false);
    
    // 🟢 Check Backup Browser for Error
    // 🟢 Check Backup Browser for Error
            const isBackupBlockedInit = await detectAndRememberError(backupPage, urlList[backupUrlIndex].url);
            if (isBackupBlockedInit) {
                console.log(`[🔄 RESTARTING BACKUP] Relaunching Backup Browser in NEW Mode due to playback error...`);
                await createFreshBackupBrowser();
                try { if (activePage) await activePage.bringToFront(); } catch(e){} // Push behind instantly
                await backupPage.goto(urlList[backupUrlIndex].url, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(()=>{});
                await initializeVideo(backupPage, true, false);
            }
            
            try { if (activePage) await activePage.bringToFront(); } catch(e){}
    try { await activePage.mouse.click(10, 10); } catch(e){} 

    console.log(`\n[🎥] INITIAL CAPTURE STATUS: Ready to Broadcast`);
    await startWatchdog();
}

async function mainLoop() {
    while (true) {
        try { await startDirectStreaming(); } 
        catch (error) {
            console.error('\n[🚨] FATAL ENGINE ERROR:', error.message);
            if (activeBrowser && activeBrowser.isConnected()) { await new Promise(r => setTimeout(r, 3000)); continue; }
            if (backupBrowser && backupBrowser.isConnected()) { await new Promise(r => setTimeout(r, 3000)); continue; }
            try { if (activeBrowser) await activeBrowser.close().catch(() => {}); } catch (e) {}
            try { if (backupBrowser) await backupBrowser.close().catch(() => {}); } catch (e) {}
            activeBrowser = null; backupBrowser = null; activePage = null; backupPage = null;
            await new Promise(r => setTimeout(r, 3000)); await cleanup();
        }
    }
}

async function cleanup() {
    try { await obs.disconnect(); } catch (e) { } 
    if (activeBrowser) { try { await activeBrowser.close(); } catch(e) { } activeBrowser = null; }
    if (backupBrowser) { try { await backupBrowser.close(); } catch(e) { } backupBrowser = null; }
    if (obsProcess) { try { obsProcess.kill('SIGKILL'); } catch(e) { } obsProcess = null; }
    try { execSync('pkill -9 obs || true', { stdio: 'ignore' }); execSync('pkill -9 chrome || true', { stdio: 'ignore' }); execSync('pkill -9 puppeteer || true', { stdio: 'ignore' }); } catch (e) { }
}

process.on('SIGINT', async () => { await cleanup(); process.exit(0); });

const customDurationStr = process.env.CUSTOM_DURATION || 'None';
function parseDurationToMs(str) {
    if (!str || str.toLowerCase() === 'none') return null;
    let ms = 0; const hMatch = str.match(/(\d+)\s*h/i); const mMatch = str.match(/(\d+)\s*m/i);
    if (hMatch) ms += parseInt(hMatch[1]) * 60 * 60 * 1000;
    if (mMatch) ms += parseInt(mMatch[1]) * 60 * 1000;
    return ms > 0 ? ms : null;
}

const exactDurationMs = parseDurationToMs(customDurationStr);
if (exactDurationMs) { setTimeout(async () => { await cleanup(); process.exit(0); }, exactDurationMs); } 
else {
    setTimeout(() => {
        try {
            const targetUrls = process.env.TARGET_URLS || 'https://sport4u.online'; const channel = process.env.OKRU_STREAM_ID || '1';
            const quality = process.env.STREAM_QUALITY || '110KBps (Balanced 480p)'; const server = process.env.SERVER_SELECTION || 'None';
            const cmd = `gh workflow run main.yml -f target_urls="${targetUrls}" -f okru_stream_channel="${channel}" -f stream_quality="${quality}" -f server_selection="${server}" -f proxy_engine="${PROXY_ENGINE}" -f custom_duration="None"`;
            execSync(cmd, { stdio: 'inherit' });
            setTimeout(async () => { await cleanup(); process.exit(0); }, 300000); 
        } catch (err) { }
    }, 21000000);
}

mainLoop();
