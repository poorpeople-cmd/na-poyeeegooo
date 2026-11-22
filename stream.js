

'use strict';

const { spawn, execFileSync } = require('node:child_process');
const { randomBytes } = require('node:crypto');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { OBSWebSocket } = require('obs-websocket-js/json');

const QUALITY = {
  '360p': [640, 360, 800],
  '480p': [854, 480, 1500],
  '720p': [1280, 720, 3000],
  '1080p': [1920, 1080, 4500],
  'Original (1080p Max)': [1920, 1080, 4500],
};
const POLL_MS = 2_000;
const STALL_MS = 18_000;
const STARTUP_MS = 45_000;
const AD_DOMAINS = ['popads.net', 'exoclick.com', 'adsterra.com', 'doubleclick.net'];

function parseDuration(value = '24/7') {
  const input = value.trim().toLowerCase();
  if (['', '24/7', 'none', '0', 'infinite', 'forever'].includes(input)) return Infinity;
  if (/^\d+(?:\.\d+)?$/.test(input)) return durationMs(Number(input) * 60_000);
  const units = { h: 3_600_000, m: 60_000, s: 1_000 };
  const tokens = /\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)/gy;
  let position = 0;
  let total = 0;
  while (position < input.length) {
    const token = tokens.exec(input);
    if (!token) throw new Error('Invalid CUSTOM_DURATION. Use 45m, 1h 20m, or 24/7.');
    total += Number(token[1]) * units[token[2][0]];
    position = tokens.lastIndex;
  }
  return durationMs(total);
}

function durationMs(value) {
  const rounded = Math.round(value);
  if (!Number.isSafeInteger(rounded) || rounded <= 0) throw new Error('Invalid CUSTOM_DURATION.');
  return rounded;
}

function readConfig(env) {
  const quality = env.STREAM_QUALITY || '720p';
  if (!Object.hasOwn(QUALITY, quality)) throw new Error('Invalid STREAM_QUALITY.');
  const [width, height, bitrate] = QUALITY[quality];
  const channel = (env.OKRU_STREAM_ID || '1').trim();
  if (!/^[a-z0-9]+(?:\.[a-z0-9]+)*$/i.test(channel)) throw new Error('Invalid OK.ru channel.');
  const urls = (env.TARGET_URLS || '').split(/[,|\n]/).map(value => value.trim()).filter(Boolean).map(value => {
    const address = value.replace(/^!/, '').split('::')[0].trim();
    let url;
    try {
      url = new URL(address.includes('://') ? address : `https://${address}`);
    } catch {
      throw new Error('TARGET_URLS contains an invalid URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
      throw new Error('TARGET_URLS requires HTTP(S) URLs without embedded credentials.');
    }
    return url.href;
  });
  if (!urls.length) throw new Error('Enter at least one URL in TARGET_URLS.');

  let keys;
  try {
    keys = JSON.parse(env.OKRU_STREAM_KEYS || '{}');
  } catch {
    throw new Error('OKRU_STREAM_KEYS must be a JSON object.');
  }
  if (!keys || Array.isArray(keys) || typeof keys !== 'object') throw new Error('OKRU_STREAM_KEYS must be a JSON object.');
  const key = (Object.hasOwn(keys, channel) && typeof keys[channel] === 'string' ? keys[channel] : '').trim();
  if (!key) throw new Error(`No OK.ru stream key configured for channel ${channel}.`);
  let server;
  try {
    server = new URL(env.OKRU_RTMP_SERVER || 'rtmp://vsu.okcdn.ru/input/');
  } catch {
    throw new Error('Invalid OKRU_RTMP_SERVER.');
  }
  if (!['rtmp:', 'rtmps:'].includes(server.protocol)) throw new Error('OKRU_RTMP_SERVER must use RTMP or RTMPS.');
  const relay = env.RELAY_AFTER_MS ? durationMs(Number(env.RELAY_AFTER_MS)) : Infinity;
  return {
    width, height, bitrate, channel, key, server: server.href, urls,
    selection: (env.SERVER_SELECTION || 'None').trim(),
    audio: (env.ENABLE_STREAM_AUDIO || 'ON').toUpperCase() === 'ON',
    warp: (env.PROXY_ENGINE || '').includes('Cloudflare'),
    duration: parseDuration(env.CUSTOM_DURATION),
    relay,
  };
}

async function bounded(promise, milliseconds, label) {
  const timer = new AbortController();
  try {
    return await Promise.race([
      promise,
      sleep(milliseconds, undefined, { signal: timer.signal }).then(() => {
        throw new Error(`${label} timed out`);
      }),
    ]);
  } finally {
    timer.abort();
  }
}

async function stopProcess(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  await bounded(exited, 3_000, 'OBS shutdown').catch(async () => {
    child.kill('SIGKILL');
    await bounded(exited, 1_000, 'OBS shutdown').catch(() => {});
  });
}

function captureEnvironment() {
  const env = { ...process.env };
  for (const name of ['OKRU_STREAM_KEYS', 'OKRU_RTMP_SERVER', 'GH_TOKEN', 'GITHUB_TOKEN']) delete env[name];
  return env;
}

async function openObs(config, runtime) {
  const obsRoot = path.join(runtime, 'obs-studio');
  const profile = path.join(obsRoot, 'basic', 'profiles', 'Stream');
  const plugin = path.join(obsRoot, 'plugin_config', 'obs-websocket');
  const password = randomBytes(24).toString('hex');
  const settings = {
    alerts_enabled: false, auth_required: true, first_load: false,
    server_enabled: true, server_password: password, server_port: 4455,
  };
  await Promise.all([fs.mkdir(profile, { recursive: true }), fs.mkdir(plugin, { recursive: true })]);
  const globalSettings = '[General]\nLicenseAccepted=true\nFirstRun=true\n[BasicWindow]\nShowAutoConfig=false\nWarned=true\n' +
    `[OBSWebSocket]\nFirstLoad=false\nServerEnabled=true\nServerPort=4455\nAlertsEnabled=false\nAuthRequired=true\nServerPassword=${password}\n`;
  await Promise.all([
    fs.writeFile(path.join(obsRoot, 'global.ini'), globalSettings),
    fs.writeFile(path.join(obsRoot, 'user.ini'), globalSettings),
    fs.writeFile(path.join(plugin, 'config.json'), JSON.stringify(settings)),
    fs.writeFile(path.join(profile, 'basic.ini'),
      `[General]\nName=Stream\n[Video]\nBaseCX=${config.width}\nBaseCY=${config.height}\nOutputCX=${config.width}\nOutputCY=${config.height}\nFPSCommon=30\n` +
      `[Audio]\nSampleRate=48000\nChannelSetup=Stereo\n[Output]\nMode=Advanced\nReconnect=true\nRetryDelay=2\nMaxRetries=15\n` +
      '[AdvOut]\nEncoder=obs_x264\nTrackIndex=1\nTrack1Bitrate=128\n'),
    fs.writeFile(path.join(profile, 'streamEncoder.json'), JSON.stringify({
      rate_control: 'CBR', bitrate: config.bitrate, keyint_sec: 2, preset: 'veryfast', profile: 'main',
    })),
  ]);

  const child = spawn('obs', [
    '--profile', 'Stream', '--disable-updater', '--websocket_ipv4_only',
  ], { env: { ...captureEnvironment(), XDG_CONFIG_HOME: runtime, QT_QPA_PLATFORM: 'xcb' }, stdio: 'ignore' });
  let launchError;
  child.on('error', error => { launchError = error.code; });
  const obs = new OBSWebSocket();
  const call = (request, data) => bounded(obs.call(request, data), 8_000, request);
  try {
    const waitUntil = Date.now() + 30_000;
    while (true) {
      if (launchError || child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`OBS process failed to start (${launchError || child.exitCode || child.signalCode}).`);
      }
      try {
        await bounded(obs.connect('ws://127.0.0.1:4455', password, { rpcVersion: 1 }), 2_000, 'OBS connection');
        break;
      } catch {
        await bounded(obs.disconnect(), 1_000, 'OBS disconnect').catch(() => {});
        if (Date.now() >= waitUntil) throw new Error('OBS WebSocket did not become ready.');
        await sleep(700);
      }
    }

    await call('SetStreamServiceSettings', {
      streamServiceType: 'rtmp_custom',
      streamServiceSettings: { server: config.server, key: config.key },
    });
    const specialInputs = await call('GetSpecialInputs');
    for (const inputName of Object.values(specialInputs)) {
      if (inputName) await call('SetInputMute', { inputName, inputMuted: true });
    }
    await call('CreateScene', { sceneName: 'Broadcast' });
    await call('CreateScene', { sceneName: 'Waiting' });
    await call('CreateInput', {
      sceneName: 'Broadcast', inputName: 'Browser Display', inputKind: 'xshm_input',
      inputSettings: { screen: 0, show_cursor: false }, sceneItemEnabled: true,
    });
    if (config.audio) {
      await call('CreateInput', {
        sceneName: 'Broadcast', inputName: 'Browser Audio', inputKind: 'pulse_output_capture',
        inputSettings: { device_id: process.env.PULSE_SOURCE || 'default' }, sceneItemEnabled: true,
      });
    }
    await call('SetCurrentProgramScene', { sceneName: 'Waiting' });
    return { obs, call, child };
  } catch (error) {
    await bounded(obs.disconnect(), 1_000, 'OBS disconnect').catch(() => {});
    await stopProcess(child);
    throw error;
  }
}

async function closeObs(engine) {
  if (!engine) return;
  await engine.call('StopStream').catch(() => {});
  await bounded(engine.obs.disconnect(), 2_000, 'OBS disconnect').catch(() => {});
  await stopProcess(engine.child);
}

async function openBrowser(config, puppeteer) {
  const env = captureEnvironment();
  const args = [
    '--kiosk', '--window-position=0,0', `--window-size=${config.width},${config.height}`,
    '--autoplay-policy=no-user-gesture-required', '--disable-dev-shm-usage', '--ozone-platform=x11',
  ];
  if (process.env.CHROME_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
  if (!config.audio) args.push('--mute-audio');
  if (config.warp) args.push('--proxy-server=socks5://127.0.0.1:40000');
  const extension = path.resolve('ublock-lite');
  const hasExtension = await fs.access(path.join(extension, 'manifest.json')).then(() => true, () => false);
  const browser = await puppeteer.launch({
    headless: false, defaultViewport: null, protocolTimeout: 5_000,
    enableExtensions: hasExtension ? [extension] : false,
    args, env, timeout: 30_000, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false,
  });
  try {
    const page = (await browser.pages())[0] || await browser.newPage();
    browser.on('targetcreated', target => {
      if (target.type() === 'page') {
        void target.page().then(popup => popup && popup !== page ? popup.close() : undefined).catch(() => {});
      }
    });
    page.on('dialog', dialog => void dialog.dismiss().catch(() => {}));
    await page.setRequestInterception(true);
    page.on('request', request => {
      const host = URL.canParse(request.url()) ? new URL(request.url()).hostname : '';
      const blocked = AD_DOMAINS.some(domain => host === domain || host.endsWith(`.${domain}`));
      void (blocked ? request.abort() : request.continue()).catch(() => {});
    });
    return { browser, page };
  } catch (error) {
    await closeBrowser(browser);
    throw error;
  }
}

async function closeBrowser(browser) {
  if (!browser) return;
  await bounded(browser.close(), 5_000, 'Chrome shutdown').catch(() => {
    browser.process()?.kill('SIGKILL');
  });
}

async function selectServer(page, label, signal) {
  if (!label || /^none$/i.test(label)) return;
  const deadline = Date.now() + 8_000;
  while (!signal.aborted && Date.now() < deadline) {
    for (const frame of page.frames()) {
      const clicked = await frame.evaluate(text => {
        const labelOf = element => (element.innerText || element.getAttribute('aria-label') || '').trim().toLowerCase();
        const controls = [...document.querySelectorAll('button, a, [role="button"], [onclick]')]
          .filter(element => element.getClientRects().length > 0);
        const control = controls.find(element => labelOf(element) === text) ||
          controls.find(element => labelOf(element).includes(text));
        if (!control) return false;
        control.click();
        return true;
      }, label.toLowerCase()).catch(() => false);
      if (clicked) return;
    }
    await sleep(700, undefined, { signal });
  }
  console.warn('Selected server button was unavailable. Checking the default player.');
}

async function sampleVideos(page, resume) {
  const results = await Promise.all(page.frames().map(async frame => {
    const videos = await frame.evaluate(tryResume => {
      const entries = [...document.querySelectorAll('video')];
      window.streamBotVideoIds ??= new WeakMap();
      window.streamBotNextVideoId ??= 0;
      return entries.flatMap(video => {
        const rect = video.getBoundingClientRect();
        if (rect.width < 80 || rect.height < 40 || video.ended) return [];
        if (!window.streamBotVideoIds.has(video)) window.streamBotVideoIds.set(video, ++window.streamBotNextVideoId);
        if (tryResume && video.paused && !video.error) void video.play().catch(() => {});
        return [{
          id: window.streamBotVideoIds.get(video), area: rect.width * rect.height,
          time: video.currentTime, ready: !video.paused && video.readyState >= 2,
          frames: video.getVideoPlaybackQuality?.().totalVideoFrames ?? video.webkitDecodedFrameCount ?? 0,
        }];
      });
    }, resume).catch(() => []);
    return videos.map(video => ({ ...video, frame }));
  }));
  return results.flat().sort((a, b) => b.area - a.area);
}

function progressed(video, previous) {
  const prior = previous.find(item => item.frame === video.frame && item.id === video.id);
  return Boolean(video.ready && prior && (video.frames > prior.frames || video.time > prior.time + 0.01));
}

async function focusVideo(video, audio) {
  const { frame, id } = video;
  await frame.evaluate((videoId, enableAudio) => {
    const videos = [...document.querySelectorAll('video')];
    const selected = videos.find(item => window.streamBotVideoIds?.get(item) === videoId);
    if (!selected) return;
    const css = { position: 'fixed', inset: '0', width: '100vw', height: '100vh', 'z-index': '2147483647',
      background: 'black', 'object-fit': 'contain', display: 'block' };
    for (const [name, value] of Object.entries(css)) selected.style.setProperty(name, value, 'important');
    for (const item of videos) item.muted = !enableAudio || item !== selected;
    if (enableAudio) selected.volume = 1;
  }, id, audio);

  let child = frame;
  while (child.parentFrame()) {
    const element = await child.frameElement();
    if (!element) break;
    try {
      await element.evaluate(iframe => {
        const css = { position: 'fixed', inset: '0', width: '100vw', height: '100vh',
          border: '0', 'z-index': '2147483647', display: 'block' };
        for (const [name, value] of Object.entries(css)) iframe.style.setProperty(name, value, 'important');
      });
    } finally {
      await element.dispose();
    }
    child = child.parentFrame();
  }
}

async function waitForProxy() {
  const connected = new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port: 40000 }, () => {
      socket.destroy();
      resolve();
    });
    socket.setTimeout(2000, () => socket.destroy(new Error('Proxy timeout')));
    socket.once('error', reject);
  });
  await connected.catch(() => { throw new Error('WARP selected but proxy 127.0.0.1:40000 is unavailable.'); });
}

async function confirmOutput(engine, signal) {
  const deadline = Date.now() + 18_000;
  while (Date.now() < deadline) {
    const status = await engine.call('GetStreamStatus');
    if (status.outputActive && !status.outputReconnecting && status.outputBytes > 0) return;
    await sleep(800, undefined, { signal });
  }
  throw new Error('OBS failed to send stream data. Verify the OK.ru server and selected channel key.');
}

async function run(config, signal, controller) {
  const { default: puppeteer } = await import('puppeteer');
  if (config.warp) await waitForProxy();
  const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'okru-obs-'));
  let engine;
  let browserState;
  let timer;
  let relayTimer;
  let remaining;
  let onAir = false;
  let outputFailureSince;
  let deadline = Infinity;
  const startedAt = performance.now();

  if (Number.isFinite(config.relay)) {
    relayTimer = setTimeout(() => {
      if (onAir) {
        remaining = config.duration === Infinity ? '24/7' : `${Math.ceil((deadline - performance.now()) / 1000)}s`;
        if (remaining === '0s' || remaining.startsWith('-')) remaining = undefined;
      }
      controller.abort();
    }, config.relay);
  }

  try {
    try {
      engine = await openObs(config, runtime);
    } catch (error) {
      const safeMessage = /^OBS (process|WebSocket)/.test(error.message) ? error.message : 'OBS could not configure the broadcast scene or RTMP service.';
      throw new Error(safeMessage);
    }
    const useScene = name => engine.call('SetCurrentProgramScene', { sceneName: name });
    let nextUrl = 0;
    let failures = 0;
    while (!signal.aborted) {
      const index = nextUrl;
      nextUrl = (nextUrl + 1) % config.urls.length;
      let playbackStarted = false;
      try {
        if (!browserState?.browser.connected || browserState.page.isClosed()) {
          await closeBrowser(browserState?.browser);
          try {
            browserState = await openBrowser(config, puppeteer);
          } catch {
            throw new Error('Chrome startup failed. Verify the browser installation and X11 display.');
          }
        }
        const { page, browser } = browserState;
        console.log(`Loading source ${index + 1}/${config.urls.length}`);
        const response = await page.goto(config.urls[index], { waitUntil: 'domcontentloaded', timeout: 30_000 });
        if (response && response.status() >= 400) throw new Error('Source returned an HTTP error.');
        await page.bringToFront();
        await selectServer(page, config.selection, signal);
        let previous = [];
        let lastProgress = performance.now();
        let selected;
        while (!signal.aborted && browser.connected && !page.isClosed()) {
          const samples = await sampleVideos(page, true);
          const candidate = selected
            ? samples.find(video => video.frame === selected.frame && video.id === selected.id)
            : samples.find(video => progressed(video, previous));

          if (candidate && progressed(candidate, previous)) {
            lastProgress = performance.now();
            if (!selected) {
              await focusVideo(candidate, config.audio);
              selected = candidate;
              playbackStarted = true;
              failures = 0;
              await useScene('Broadcast');
              if (!onAir) {
                await engine.call('StartStream').catch(() => { throw new Error('OBS could not start the OK.ru stream.'); });
                await confirmOutput(engine, signal);
                onAir = true;
                deadline = performance.now() + config.duration;
                if (Number.isFinite(config.duration)) {
                  const checkDuration = () => {
                    const left = deadline - performance.now();
                    if (left <= 0) controller.abort();
                    else timer = setTimeout(checkDuration, Math.min(left, 2_147_483_647));
                  };
                  checkDuration();
                }
                console.log(`OBS live on channel ${config.channel} at ${config.width}x${config.height} / 30 FPS`);
              }
            }
          } else if (performance.now() - lastProgress >= (selected ? STALL_MS : STARTUP_MS)) {
            console.warn(selected ? 'Playback stalled. Trying the next source.' : 'No playback progress during startup. Trying the next source.');
            break;
          }
          if (onAir) {
            const status = await engine.call('GetStreamStatus');
            if (status.outputActive && !status.outputReconnecting) outputFailureSince = undefined;
            else {
              outputFailureSince ??= performance.now();
              if (performance.now() - outputFailureSince >= 40_000) {
                throw new Error('OBS disconnected from the streaming server.');
              }
              if (!status.outputActive) await engine.call('StartStream');
            }
          }
          previous = samples;
          await sleep(POLL_MS, undefined, { signal });
        }
      } catch (error) {
        if (signal.aborted) break;
        if (error.message.startsWith('Chrome startup failed')) throw error;
        const obsFailure = /^(OBS |SetCurrentProgramScene|GetStreamStatus|StartStream)/.test(error.message);
        if (obsFailure || (playbackStarted && !onAir)) {
          throw new Error('OBS broadcast failed. Check OBS availability and your OK.ru stream settings.');
        }
        console.warn(`Source ${index + 1} became unavailable. Trying the next source.`);
      }
      if (signal.aborted) break;
      await useScene('Waiting');
      if (!playbackStarted) failures++;
      if (failures >= config.urls.length * 3 && !onAir) throw new Error('No source produced playable video after three passes.');
      if (failures >= config.urls.length * 6) throw new Error('All sources remained unavailable during recovery.');
      await sleep(Math.min(1_000 + failures * 1_000, 10_000), undefined, { signal });
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  } finally {
    clearTimeout(timer);
    clearTimeout(relayTimer);
    await closeObs(engine);
    await closeBrowser(browserState?.browser);
    await fs.rm(runtime, { recursive: true, force: true });
  }

  if (!onAir && performance.now() - startedAt >= config.relay) throw new Error('Relay deadline reached before OBS could start.');
  if (remaining && process.env.GITHUB_OUTPUT) {
    await fs.appendFile(process.env.GITHUB_OUTPUT, `next_duration=${remaining}\n`);
    console.log(`Finished this runner. Remaining duration: ${remaining}`);
  }
}

async function main() {
  const config = readConfig(process.env);
  if (process.argv.includes('--check-config')) {
    console.log(`Configuration valid for channel ${config.channel} and ${config.urls.length} source(s).`);
    return;
  }
  if (!process.env.DISPLAY) throw new Error('An X11 display is required. Run the workflow or start under Xvfb.');
  const controller = new AbortController();
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => controller.abort(signal));
  try {
    execFileSync('xsetroot', ['-solid', 'black'], { stdio: 'ignore', env: captureEnvironment() });
  } catch {
    // The dedicated OBS waiting scene still provides a black output.
  }
  await run(config, controller.signal, controller);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`[ERROR] ${error.message}`);
    process.exitCode = 1;
  });
}
module.exports = { parseDuration, readConfig, progressed };



































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
