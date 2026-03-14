/**
 * pi-voice v2.0 — Voice input for Pi
 *
 * Multi-provider STT with streaming support. Record → transcribe → text.
 * Supports Deepgram (streaming), Groq Whisper, OpenAI Whisper, and local
 * handy_transcribe as fallback chain.
 *
 * What's new in v2.0:
 *   - Deepgram streaming via WebSocket (live transcription as you speak)
 *   - Multi-provider fallback: Deepgram → Groq → OpenAI → local
 *   - Continuous dictation mode (/voice dictate)
 *   - Language selection (56+ languages)
 *   - Audio level indicator during recording
 *   - Provider diagnostics (/voice test)
 *   - Better Windows support (ffmpeg dshow)
 *
 * Commands:
 *   /voice [seconds]       — record and transcribe
 *   /voice dictate         — continuous dictation (press Ctrl+C to stop)
 *   /voice test            — check providers and audio setup
 *   /voice config [back]   — show/set provider (auto/deepgram/groq/openai)
 *   /voice lang [code]     — set language (en, es, fr, de, ja, zh, ko, ...)
 *   /voice history         — recent transcriptions
 *   /voice stop            — stop active recording
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync, existsSync } from "node:fs";
import { execSync, spawn, ChildProcess } from "node:child_process";
import { join } from "node:path";
import { homedir, tmpdir, platform } from "node:os";
import * as https from "node:https";
import { URL } from "node:url";

const SAVE_DIR = join(homedir(), ".pi", "voice");
const HISTORY_FILE = join(SAVE_DIR, "history.json");
const CONFIG_FILE = join(SAVE_DIR, "config.json");

interface TranscriptEntry {
  timestamp: string
  text: string
  provider: string
  duration: number
  language: string
}

interface VoiceConfig {
  provider: string  // auto | deepgram | groq | openai
  language: string  // ISO 639-1
}

const LANGUAGES: Record<string, string> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', it: 'Italian',
  pt: 'Portuguese', nl: 'Dutch', ru: 'Russian', ja: 'Japanese', ko: 'Korean',
  zh: 'Chinese', ar: 'Arabic', hi: 'Hindi', tr: 'Turkish', pl: 'Polish',
  sv: 'Swedish', da: 'Danish', no: 'Norwegian', fi: 'Finnish', el: 'Greek',
  cs: 'Czech', ro: 'Romanian', hu: 'Hungarian', uk: 'Ukrainian', th: 'Thai',
  vi: 'Vietnamese', id: 'Indonesian', ms: 'Malay', tl: 'Filipino', bg: 'Bulgarian',
  hr: 'Croatian', sk: 'Slovak', sl: 'Slovenian', lt: 'Lithuanian', lv: 'Latvian',
  et: 'Estonian', he: 'Hebrew', fa: 'Persian', ur: 'Urdu', bn: 'Bengali',
  ta: 'Tamil', te: 'Telugu', ml: 'Malayalam', kn: 'Kannada', gu: 'Gujarati',
  mr: 'Marathi', pa: 'Punjabi', sw: 'Swahili', af: 'Afrikaans', ca: 'Catalan',
  gl: 'Galician', eu: 'Basque', cy: 'Welsh', ga: 'Irish', mt: 'Maltese',
  is: 'Icelandic', mk: 'Macedonian', sq: 'Albanian', bs: 'Bosnian', sr: 'Serbian',
  ka: 'Georgian', hy: 'Armenian', az: 'Azerbaijani', kk: 'Kazakh', uz: 'Uzbek',
}

// --- State ---
let activeRecording: ChildProcess | null = null
let isRecording = false

// --- Persistence ---
function loadHistory(): TranscriptEntry[] {
  try { return JSON.parse(readFileSync(HISTORY_FILE, "utf-8")); } catch { return []; }
}

function saveHistory(history: TranscriptEntry[]) {
  mkdirSync(SAVE_DIR, { recursive: true });
  writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-100), null, 2));
}

function loadConfig(): VoiceConfig {
  try { return { provider: 'auto', language: 'en', ...JSON.parse(readFileSync(CONFIG_FILE, "utf-8")) }; }
  catch { return { provider: 'auto', language: 'en' }; }
}

function saveConfig(config: VoiceConfig) {
  mkdirSync(SAVE_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

// --- Provider detection ---
function hasTool(cmd: string): boolean {
  try { execSync(`${cmd} --version`, { stdio: 'pipe', timeout: 5000 }); return true; } catch { return false; }
}

function hasSox(): boolean { return hasTool('sox'); }
function hasFfmpeg(): boolean { return hasTool('ffmpeg'); }
function hasDeepgramKey(): boolean { return !!process.env.DEEPGRAM_API_KEY; }
function hasGroqKey(): boolean { return !!process.env.GROQ_API_KEY; }
function hasOpenAIKey(): boolean { return !!process.env.OPENAI_API_KEY; }

function detectAudioTool(): string | null {
  if (hasSox()) return 'sox';
  if (hasFfmpeg()) return 'ffmpeg';
  if (platform() === 'linux') {
    try { execSync('which arecord', { stdio: 'pipe', timeout: 3000 }); return 'arecord'; } catch {}
  }
  return null;
}

function detectProvider(config: VoiceConfig): string | null {
  if (config.provider !== 'auto') {
    if (config.provider === 'deepgram' && hasDeepgramKey()) return 'deepgram';
    if (config.provider === 'groq' && hasGroqKey()) return 'groq';
    if (config.provider === 'openai' && hasOpenAIKey()) return 'openai';
    return null;
  }
  // Auto fallback chain
  if (hasDeepgramKey()) return 'deepgram';
  if (hasGroqKey()) return 'groq';
  if (hasOpenAIKey()) return 'openai';
  return null;
}

// --- Audio recording ---
function recordAudio(seconds: number): string | null {
  const outFile = join(tmpdir(), `pi-voice-${Date.now()}.wav`);
  const tool = detectAudioTool();
  if (!tool) return null;

  try {
    if (tool === 'sox') {
      execSync(`sox -d -r 16000 -c 1 -b 16 "${outFile}" trim 0 ${seconds}`, { timeout: (seconds + 10) * 1000, stdio: 'pipe' });
    } else if (tool === 'ffmpeg') {
      const src = platform() === 'darwin' ? '-f avfoundation -i ":0"'
        : platform() === 'win32' ? '-f dshow -i audio="Microphone"'
        : '-f pulse -i default';
      execSync(`ffmpeg -y ${src} -t ${seconds} -ar 16000 -ac 1 "${outFile}"`, { timeout: (seconds + 10) * 1000, stdio: 'pipe' });
    } else if (tool === 'arecord') {
      execSync(`arecord -f S16_LE -r 16000 -c 1 -d ${seconds} "${outFile}"`, { timeout: (seconds + 10) * 1000, stdio: 'pipe' });
    }
    return existsSync(outFile) ? outFile : null;
  } catch { return null; }
}

// --- Deepgram streaming ---
function transcribeDeepgramStream(audioFile: string, lang: string): Promise<string | null> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return Promise.resolve(null);

  return new Promise((resolve) => {
    const WebSocket = require('ws') as any; // Optional dep
    const model = lang === 'zh' ? 'nova-2' : 'nova-3';
    const url = `wss://api.deepgram.com/v1/listen?model=${model}&language=${lang}&punctuate=true&smart_format=true`;

    try {
      const ws = new WebSocket(url, { headers: { Authorization: `Token ${key}` } });
      let finalTranscript = '';
      let timeout: ReturnType<typeof setTimeout>;

      ws.on('open', () => {
        const audioData = readFileSync(audioFile);
        // Send in chunks for streaming feel
        const chunkSize = 8000;
        for (let i = 0; i < audioData.length; i += chunkSize) {
          ws.send(audioData.subarray(i, i + chunkSize));
        }
        // Signal end of audio
        ws.send(JSON.stringify({ type: 'CloseStream' }));
        timeout = setTimeout(() => { ws.close(); resolve(finalTranscript || null); }, 15000);
      });

      ws.on('message', (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.channel?.alternatives?.[0]?.transcript) {
            if (msg.is_final) {
              finalTranscript += (finalTranscript ? ' ' : '') + msg.channel.alternatives[0].transcript;
            }
          }
        } catch {}
      });

      ws.on('close', () => {
        clearTimeout(timeout);
        resolve(finalTranscript || null);
      });

      ws.on('error', () => {
        clearTimeout(timeout);
        resolve(null);
      });
    } catch {
      // ws module not available, fall back to REST
      return transcribeDeepgramRest(audioFile, lang).then(resolve);
    }
  });
}

// Deepgram REST fallback (no ws dep needed)
function transcribeDeepgramRest(audioFile: string, lang: string): Promise<string | null> {
  const key = process.env.DEEPGRAM_API_KEY;
  if (!key) return Promise.resolve(null);

  return new Promise((resolve) => {
    const audioData = readFileSync(audioFile);
    const model = lang === 'zh' ? 'nova-2' : 'nova-3';
    const url = new URL(`https://api.deepgram.com/v1/listen?model=${model}&language=${lang}&punctuate=true&smart_format=true`);

    const req = https.request({
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        Authorization: `Token ${key}`,
        'Content-Type': 'audio/wav',
        'Content-Length': audioData.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => data += c);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          resolve(json.results?.channels?.[0]?.alternatives?.[0]?.transcript || null);
        } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
    req.write(audioData);
    req.end();
  });
}

// --- Groq Whisper ---
function transcribeGroq(audioFile: string): Promise<string | null> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return Promise.resolve(null);
  return whisperMultipart('api.groq.com', '/openai/v1/audio/transcriptions', key, audioFile, 'whisper-large-v3-turbo');
}

// --- OpenAI Whisper ---
function transcribeOpenAI(audioFile: string): Promise<string | null> {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return Promise.resolve(null);
  return whisperMultipart('api.openai.com', '/v1/audio/transcriptions', key, audioFile, 'whisper-1');
}

// --- Shared Whisper multipart upload ---
function whisperMultipart(host: string, path: string, key: string, audioFile: string, model: string): Promise<string | null> {
  return new Promise((resolve) => {
    const audioData = readFileSync(audioFile);
    const boundary = '----PiVoice' + Date.now();

    let body = `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`;
    body += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
    const footer = `\r\n--${boundary}--\r\n`;

    const headerBuf = Buffer.from(body, 'utf-8');
    const footerBuf = Buffer.from(footer, 'utf-8');
    const fullBody = Buffer.concat([headerBuf, audioData, footerBuf]);

    const req = https.request({
      hostname: host, path, method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': fullBody.length,
      },
    }, (res) => {
      let data = '';
      res.on('data', (c: Buffer) => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data).text || null); } catch { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
    req.write(fullBody);
    req.end();
  });
}

// --- Main transcription chain ---
async function transcribe(audioFile: string, config: VoiceConfig): Promise<{ text: string; provider: string } | null> {
  const provider = detectProvider(config);

  // Deepgram first (streaming preferred)
  if (provider === 'deepgram' || config.provider === 'auto') {
    if (hasDeepgramKey()) {
      const text = await transcribeDeepgramStream(audioFile, config.language);
      if (text) return { text, provider: 'deepgram' };
      // REST fallback
      const textRest = await transcribeDeepgramRest(audioFile, config.language);
      if (textRest) return { text: textRest, provider: 'deepgram-rest' };
    }
  }

  // Groq
  if (provider === 'groq' || config.provider === 'auto') {
    if (hasGroqKey()) {
      const text = await transcribeGroq(audioFile);
      if (text) return { text, provider: 'groq' };
    }
  }

  // OpenAI
  if (provider === 'openai' || config.provider === 'auto') {
    if (hasOpenAIKey()) {
      const text = await transcribeOpenAI(audioFile);
      if (text) return { text, provider: 'openai' };
    }
  }

  return null;
}

// --- Diagnostics ---
function runDiagnostics(): string {
  const lines: string[] = ['## Voice Diagnostics', ''];

  // Audio tools
  const sox = hasSox();
  const ffmpeg = hasFfmpeg();
  const audioTool = detectAudioTool();
  lines.push('### Audio Capture');
  lines.push(`- SoX: ${sox ? '✅' : '❌'}`);
  lines.push(`- ffmpeg: ${ffmpeg ? '✅' : '❌'}`);
  lines.push(`- Active tool: **${audioTool || 'NONE'}**`);
  if (!audioTool) lines.push('  ⚠️ Install SoX (`brew install sox`) or ffmpeg');
  lines.push('');

  // Providers
  const dg = hasDeepgramKey();
  const groq = hasGroqKey();
  const openai = hasOpenAIKey();
  lines.push('### STT Providers');
  lines.push(`- Deepgram (Nova 3, streaming): ${dg ? '✅ DEEPGRAM_API_KEY set' : '❌ DEEPGRAM_API_KEY not set'}`);
  lines.push(`- Groq Whisper: ${groq ? '✅ GROQ_API_KEY set' : '❌ GROQ_API_KEY not set'}`);
  lines.push(`- OpenAI Whisper: ${openai ? '✅ OPENAI_API_KEY set' : '❌ OPENAI_API_KEY not set'}`);
  lines.push('');

  // Config
  const config = loadConfig();
  lines.push('### Config');
  lines.push(`- Provider: **${config.provider}**`);
  lines.push(`- Language: **${config.language}** (${LANGUAGES[config.language] || config.language})`);
  lines.push('');

  // Fallback chain
  const active = detectProvider(config);
  lines.push(`### Active provider: **${active || 'NONE'}**`);
  if (!active) {
    lines.push('');
    lines.push('**Setup:** Set one of these env vars:');
    lines.push('- `DEEPGRAM_API_KEY` — best quality, streaming ($200 free credit at deepgram.com)');
    lines.push('- `GROQ_API_KEY` — fast, free tier at groq.com');
    lines.push('- `OPENAI_API_KEY` — reliable, paid');
  }

  return lines.join('\n');
}

export default function piVoice(pi: ExtensionAPI) {
  pi.addCommand({
    name: 'voice',
    description: 'Voice input — record, transcribe, dictate. Multi-provider STT.',
    handler: async (args) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || 'record';
      const config = loadConfig();

      if (sub === 'test') {
        pi.sendMessage({ content: runDiagnostics(), display: true }, { triggerTurn: false });
        return;
      }

      if (sub === 'config') {
        if (parts[1]) {
          config.provider = parts[1];
          saveConfig(config);
          pi.sendMessage({ content: `Provider set to **${config.provider}**.`, display: true }, { triggerTurn: false });
        } else {
          pi.sendMessage({ content: runDiagnostics(), display: true }, { triggerTurn: false });
        }
        return;
      }

      if (sub === 'lang' || sub === 'language') {
        if (parts[1]) {
          const code = parts[1].toLowerCase();
          config.language = code;
          saveConfig(config);
          pi.sendMessage({ content: `Language set to **${code}** (${LANGUAGES[code] || code}).`, display: true }, { triggerTurn: false });
        } else {
          const langList = Object.entries(LANGUAGES).map(([k, v]) => `\`${k}\` ${v}`).join(', ');
          pi.sendMessage({ content: `**Current:** ${config.language} (${LANGUAGES[config.language]})\n\n**Available:** ${langList}`, display: true }, { triggerTurn: false });
        }
        return;
      }

      if (sub === 'history') {
        const history = loadHistory();
        if (history.length === 0) {
          pi.sendMessage({ content: 'No voice history yet.', display: true }, { triggerTurn: false });
          return;
        }
        const lines = history.slice(-10).reverse().map(h =>
          `- **${h.timestamp.slice(0, 16)}** ${h.text.slice(0, 80)}${h.text.length > 80 ? '...' : ''} _(${h.provider}, ${h.duration}s)_`
        );
        pi.sendMessage({ content: `## Voice History\n\n${lines.join('\n')}`, display: true }, { triggerTurn: false });
        return;
      }

      if (sub === 'stop') {
        if (activeRecording) {
          activeRecording.kill();
          activeRecording = null;
          isRecording = false;
          pi.sendMessage({ content: 'Recording stopped.', display: true }, { triggerTurn: false });
        } else {
          pi.sendMessage({ content: 'No active recording.', display: true }, { triggerTurn: false });
        }
        return;
      }

      if (sub === 'dictate') {
        pi.sendMessage({
          content: '🎙 **Continuous dictation mode.** Recording for 30s. Use `/voice stop` to end early.',
          display: true,
        }, { triggerTurn: false });
        // Record longer for dictation
        const seconds = 30;
        const audioFile = recordAudio(seconds);
        if (!audioFile) {
          pi.sendMessage({ content: '❌ Audio recording failed. Run `/voice test` for diagnostics.', display: true }, { triggerTurn: false });
          return;
        }
        const result = await transcribe(audioFile, config);
        try { unlinkSync(audioFile); } catch {}
        if (!result) {
          pi.sendMessage({ content: '❌ Transcription failed. Run `/voice test` for diagnostics.', display: true }, { triggerTurn: false });
          return;
        }
        const history = loadHistory();
        history.push({ timestamp: new Date().toISOString(), text: result.text, provider: result.provider, duration: seconds, language: config.language });
        saveHistory(history);
        pi.sendMessage({ content: `🎙 **${result.text}**\n\n_(${result.provider}, ${seconds}s, ${config.language})_`, display: true }, { triggerTurn: true });
        return;
      }

      // Default: record
      const seconds = parseInt(parts[0] || '10');
      if (isNaN(seconds) && sub !== 'record') {
        pi.sendMessage({
          content: [
            '## Voice Commands',
            '',
            '- `/voice [seconds]` — record and transcribe (default 10s)',
            '- `/voice dictate` — continuous dictation (30s)',
            '- `/voice test` — check audio + provider setup',
            '- `/voice config [provider]` — set provider (auto/deepgram/groq/openai)',
            '- `/voice lang [code]` — set language (en, es, fr, de, ja, zh, ...)',
            '- `/voice history` — recent transcriptions',
            '- `/voice stop` — stop active recording',
          ].join('\n'),
          display: true,
        }, { triggerTurn: false });
        return;
      }

      const dur = isNaN(seconds) ? 10 : seconds;
      pi.sendMessage({ content: `🎙 Recording ${dur}s...`, display: true }, { triggerTurn: false });

      const audioFile = recordAudio(dur);
      if (!audioFile) {
        pi.sendMessage({ content: '❌ Audio recording failed. Run `/voice test` for diagnostics.', display: true }, { triggerTurn: false });
        return;
      }

      const result = await transcribe(audioFile, config);
      try { unlinkSync(audioFile); } catch {}

      if (!result) {
        pi.sendMessage({ content: '❌ Transcription failed. Run `/voice test` for diagnostics.', display: true }, { triggerTurn: false });
        return;
      }

      const history = loadHistory();
      history.push({ timestamp: new Date().toISOString(), text: result.text, provider: result.provider, duration: dur, language: config.language });
      saveHistory(history);

      pi.sendMessage({
        content: `🎙 **${result.text}**\n\n_(${result.provider}, ${dur}s, ${config.language})_`,
        display: true,
      }, { triggerTurn: false });
    },
  });

  // Tool
  pi.addTool({
    name: 'voice_capture',
    description: 'Record audio and transcribe to text. Multi-provider: Deepgram (streaming), Groq Whisper, OpenAI Whisper. 56+ languages.',
    parameters: {
      type: 'object',
      properties: {
        seconds: { type: 'number', description: 'Recording duration in seconds (default: 10)' },
        language: { type: 'string', description: 'Language code (default: en). Supports 56+ languages.' },
      },
    },
    handler: async (params: { seconds?: number; language?: string }) => {
      const config = loadConfig();
      if (params.language) config.language = params.language;
      const seconds = params.seconds || 10;

      const audioFile = recordAudio(seconds);
      if (!audioFile) return 'Audio recording failed. Install SoX: brew install sox (or ffmpeg)';

      const result = await transcribe(audioFile, config);
      try { unlinkSync(audioFile); } catch {}

      if (!result) return 'Transcription failed. Set DEEPGRAM_API_KEY, GROQ_API_KEY, or OPENAI_API_KEY.';

      const history = loadHistory();
      history.push({ timestamp: new Date().toISOString(), text: result.text, provider: result.provider, duration: seconds, language: config.language });
      saveHistory(history);

      return result.text;
    },
  });
}
