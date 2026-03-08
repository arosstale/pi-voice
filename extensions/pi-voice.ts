/**
 * pi-voice — Voice input for pi
 * Record audio → transcribe → return text.
 * Uses handy_transcribe (built-in) → Groq Whisper → OpenAI Whisper as fallbacks.
 *
 * /voice           → record and transcribe
 * /voice config    → show/set transcription backend
 * /voice history   → recent transcriptions
 */
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const SAVE_DIR = join(homedir(), ".pi", "voice");
const HISTORY_FILE = join(SAVE_DIR, "history.json");
const CONFIG_FILE = join(SAVE_DIR, "config.json");
const RST = "\x1b[0m", B = "\x1b[1m", D = "\x1b[2m";
const GREEN = "\x1b[32m", RED = "\x1b[31m", CYAN = "\x1b[36m";

interface TranscriptEntry { timestamp: string; text: string; backend: string; duration: number }

function loadHistory(): TranscriptEntry[] {
  try { return JSON.parse(readFileSync(HISTORY_FILE, "utf-8")); } catch { return []; }
}

function saveHistory(history: TranscriptEntry[]) {
  mkdirSync(SAVE_DIR, { recursive: true });
  writeFileSync(HISTORY_FILE, JSON.stringify(history.slice(-50), null, 2));
}

function loadConfig(): { backend: string } {
  try { return JSON.parse(readFileSync(CONFIG_FILE, "utf-8")); } catch { return { backend: "auto" }; }
}

function saveConfig(config: { backend: string }) {
  mkdirSync(SAVE_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
}

function hasSox(): boolean {
  try { execSync("sox --version", { encoding: "utf-8", timeout: 5000, stdio: "pipe" }); return true; } catch { return false; }
}

function hasGroqKey(): boolean {
  return !!process.env.GROQ_API_KEY;
}

function hasOpenAIKey(): boolean {
  return !!process.env.OPENAI_API_KEY;
}

function recordAudio(seconds: number): string | null {
  const outFile = join(tmpdir(), `pi-voice-${Date.now()}.wav`);

  // Try SoX first (cross-platform)
  if (hasSox()) {
    try {
      execSync(`sox -d -r 16000 -c 1 -b 16 "${outFile}" trim 0 ${seconds}`, { timeout: (seconds + 5) * 1000, stdio: "pipe" });
      return outFile;
    } catch {}
  }

  // macOS: try afrecord
  if (process.platform === "darwin") {
    try {
      execSync(`afrecord -d LEI16 -f WAVE -c 1 -r 16000 "${outFile}" &`, { timeout: 2000, stdio: "pipe" });
      execSync(`sleep ${seconds}`, { timeout: (seconds + 2) * 1000, stdio: "pipe" });
      execSync(`kill %1 2>/dev/null || true`, { timeout: 2000, stdio: "pipe" });
      return outFile;
    } catch {}
  }

  // Linux: try arecord (ALSA)
  if (process.platform === "linux") {
    try {
      execSync(`arecord -f S16_LE -r 16000 -c 1 -d ${seconds} "${outFile}"`, { timeout: (seconds + 5) * 1000, stdio: "pipe" });
      return outFile;
    } catch {}
  }

  // Windows: try PowerShell NAudio or ffmpeg
  if (process.platform === "win32") {
    try {
      execSync(`ffmpeg -y -f dshow -i audio="Microphone" -t ${seconds} -ar 16000 -ac 1 "${outFile}"`, { timeout: (seconds + 5) * 1000, stdio: "pipe" });
      return outFile;
    } catch {}
  }

  return null;
}

function multipartUpload(url: string, apiKey: string, audioFile: string, model: string): Promise<string | null> {
  const https = require("node:https");
  const { URL } = require("node:url");
  const audioData = readFileSync(audioFile);
  const boundary = "----PiVoice" + Date.now();
  
  let body = "";
  body += `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\n${model}\r\n`;
  body += `--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n`;
  body += `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.wav"\r\nContent-Type: audio/wav\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;
  
  const headerBuf = Buffer.from(body, "utf-8");
  const footerBuf = Buffer.from(footer, "utf-8");
  const fullBody = Buffer.concat([headerBuf, audioData, footerBuf]);

  const parsed = new URL(url);
  return new Promise((resolve) => {
    const req = https.request({
      hostname: parsed.hostname, path: parsed.pathname, method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
        "Content-Length": fullBody.length,
      }
    }, (res: any) => {
      let data = "";
      res.on("data", (c: Buffer) => data += c);
      res.on("end", () => { try { resolve(JSON.parse(data).text || null); } catch { resolve(null); } });
    });
    req.on("error", () => resolve(null));
    req.setTimeout(30000, () => { req.destroy(); resolve(null); });
    req.write(fullBody);
    req.end();
  });
}

function transcribeWithGroq(audioFile: string): string | null {
  const key = process.env.GROQ_API_KEY;
  if (!key) return null;
  // Use sync wrapper around async multipart upload
  try {
    const result = execSync(
      `node -e "const https=require('https');const fs=require('fs');const d=fs.readFileSync('${audioFile.replace(/\\/g, "\\\\")}');const b='----B'+Date.now();let body='--'+b+'\\r\\nContent-Disposition: form-data; name=\"model\"\\r\\n\\r\\nwhisper-large-v3-turbo\\r\\n--'+b+'\\r\\nContent-Disposition: form-data; name=\"response_format\"\\r\\n\\r\\njson\\r\\n--'+b+'\\r\\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\\r\\nContent-Type: audio/wav\\r\\n\\r\\n';const h=Buffer.from(body);const f=Buffer.from('\\r\\n--'+b+'--\\r\\n');const full=Buffer.concat([h,d,f]);const r=https.request({hostname:'api.groq.com',path:'/openai/v1/audio/transcriptions',method:'POST',headers:{'Authorization':'Bearer ${key}','Content-Type':'multipart/form-data; boundary='+b,'Content-Length':full.length}},res=>{let s='';res.on('data',c=>s+=c);res.on('end',()=>console.log(JSON.parse(s).text||''))});r.on('error',()=>{});r.write(full);r.end()"`,
      { encoding: "utf-8", timeout: 30000 }
    );
    return result.trim() || null;
  } catch { return null; }
}

function transcribeWithOpenAI(audioFile: string): string | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  try {
    const result = execSync(
      `node -e "const https=require('https');const fs=require('fs');const d=fs.readFileSync('${audioFile.replace(/\\/g, "\\\\")}');const b='----B'+Date.now();let body='--'+b+'\\r\\nContent-Disposition: form-data; name=\"model\"\\r\\n\\r\\nwhisper-1\\r\\n--'+b+'\\r\\nContent-Disposition: form-data; name=\"response_format\"\\r\\n\\r\\njson\\r\\n--'+b+'\\r\\nContent-Disposition: form-data; name=\"file\"; filename=\"a.wav\"\\r\\nContent-Type: audio/wav\\r\\n\\r\\n';const h=Buffer.from(body);const f=Buffer.from('\\r\\n--'+b+'--\\r\\n');const full=Buffer.concat([h,d,f]);const r=https.request({hostname:'api.openai.com',path:'/v1/audio/transcriptions',method:'POST',headers:{'Authorization':'Bearer ${key}','Content-Type':'multipart/form-data; boundary='+b,'Content-Length':full.length}},res=>{let s='';res.on('data',c=>s+=c);res.on('end',()=>console.log(JSON.parse(s).text||''))});r.on('error',()=>{});r.write(full);r.end()"`,
      { encoding: "utf-8", timeout: 30000 }
    );
    return result.trim() || null;
  } catch { return null; }
}

export default function piVoice(pi: ExtensionAPI) {
  pi.registerCommand("voice", {
    description: "Voice input. /voice [record|config|history]",
    handler: async (args, ctx) => {
      const parts = args.trim().split(/\s+/);
      const sub = parts[0]?.toLowerCase() || "record";

      switch (sub) {
        case "record": case "": {
          const config = loadConfig();

          // Check available backends
          const backends: string[] = [];
          if (hasSox()) backends.push("sox");
          if (hasGroqKey()) backends.push("groq");
          if (hasOpenAIKey()) backends.push("openai");

          if (backends.length === 0 && config.backend === "auto") {
            ctx.ui.notify([
              `${RED}No transcription backend available.${RST}`,
              "",
              `${B}Setup options:${RST}`,
              `  1. Install SoX: ${CYAN}winget install sox${RST} (for audio recording)`,
              `     Plus set ${CYAN}GROQ_API_KEY${RST} or ${CYAN}OPENAI_API_KEY${RST} for transcription`,
              `  2. Set ${CYAN}GROQ_API_KEY${RST} env var (free tier: groq.com)`,
              `  3. Set ${CYAN}OPENAI_API_KEY${RST} env var`,
              "",
              `${D}Pi also has handy_transcribe for local offline STT.${RST}`,
            ].join("\n"), "error");
            return;
          }

          const seconds = parseInt(parts[1] || "10");
          ctx.ui.notify(`${CYAN}🎙 Recording ${seconds}s of audio...${RST}`, "info");

          const audioFile = recordAudio(seconds);
          if (!audioFile) {
            ctx.ui.notify([
              `${YELLOW}⚠ Audio recording not available.${RST}`,
              `Install SoX: ${CYAN}winget install sox${RST}`,
              `Or use pi's built-in: type your message or use handy_transcribe`,
            ].join("\n"), "info");
            return;
          }

          let text: string | null = null;
          let backend = "unknown";

          if (config.backend === "groq" || (config.backend === "auto" && hasGroqKey())) {
            text = transcribeWithGroq(audioFile);
            backend = "groq";
          }
          if (!text && (config.backend === "openai" || config.backend === "auto")) {
            text = transcribeWithOpenAI(audioFile);
            backend = "openai";
          }

          // Cleanup
          try { unlinkSync(audioFile); } catch {}

          if (!text) { ctx.ui.notify(`${RED}Transcription failed.${RST}`, "error"); return; }

          const history = loadHistory();
          history.push({ timestamp: new Date().toISOString(), text, backend, duration: seconds });
          saveHistory(history);

          ctx.ui.notify(`${GREEN}🎙${RST} ${B}${text}${RST}\n${D}(${backend}, ${seconds}s)${RST}`, "info");
          break;
        }

        case "config": {
          const config = loadConfig();
          if (parts[1]) {
            config.backend = parts[1];
            saveConfig(config);
            ctx.ui.notify(`${GREEN}✓${RST} Backend set to: ${B}${config.backend}${RST}`, "info");
          } else {
            const sox = hasSox() ? `${GREEN}✓${RST}` : `${RED}✗${RST}`;
            const groq = hasGroqKey() ? `${GREEN}✓${RST}` : `${RED}✗${RST}`;
            const openai = hasOpenAIKey() ? `${GREEN}✓${RST}` : `${RED}✗${RST}`;
            ctx.ui.notify([
              `${B}${CYAN}Voice Config${RST}`,
              `  ${D}Backend:${RST} ${config.backend}`,
              "",
              `  ${D}Available:${RST}`,
              `    ${sox} SoX (audio recording)`,
              `    ${groq} Groq Whisper (GROQ_API_KEY)`,
              `    ${openai} OpenAI Whisper (OPENAI_API_KEY)`,
              "",
              `  Set backend: /voice config [auto|groq|openai]`,
            ].join("\n"), "info");
          }
          break;
        }

        case "history": {
          const history = loadHistory();
          if (history.length === 0) { ctx.ui.notify("No voice history yet.", "info"); return; }
          let out = `${B}${CYAN}Voice History${RST} (${history.length})\n\n`;
          for (const h of history.slice(-10).reverse()) {
            out += `  ${D}${h.timestamp.slice(0, 16)}${RST} ${h.text.slice(0, 60)}${h.text.length > 60 ? "..." : ""} ${D}(${h.backend})${RST}\n`;
          }
          ctx.ui.notify(out, "info");
          break;
        }

        default: {
          ctx.ui.notify([
            `${B}${CYAN}🎙 Voice${RST}`,
            "",
            `  /voice [seconds]      — record and transcribe (default 10s)`,
            `  /voice config [back]  — show/set backend (auto/groq/openai)`,
            `  /voice history        — recent transcriptions`,
          ].join("\n"), "info");
        }
      }
    },
  });

  pi.registerTool({ name: "voice_capture",
    description: "Record audio and transcribe to text. Requires SoX + GROQ_API_KEY or OPENAI_API_KEY.",
    parameters: Type.Object({
      seconds: Type.Optional(Type.Number({ description: "Recording duration in seconds (default: 10)" })),
    }),
    execute: async (params) => {
      const seconds = params.seconds || 10;
      const audioFile = recordAudio(seconds);
      if (!audioFile) return { error: "Audio recording not available. Install SoX: winget install sox" };

      let text = transcribeWithGroq(audioFile) || transcribeWithOpenAI(audioFile);
      try { unlinkSync(audioFile); } catch {}

      if (!text) return { error: "Transcription failed. Check GROQ_API_KEY or OPENAI_API_KEY." };

      const history = loadHistory();
      history.push({ timestamp: new Date().toISOString(), text, backend: "api", duration: seconds });
      saveHistory(history);

      return { text, duration: seconds };
    },
  });
}
