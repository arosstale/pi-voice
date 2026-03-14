# pi-voice

Voice input for Pi. Multi-provider STT with Deepgram streaming, Groq Whisper, and OpenAI Whisper. 56+ languages.

## Install

```bash
pi install npm:@artale/pi-voice
```

## Setup

Set at least one API key:

```bash
# Best quality — Deepgram Nova 3 with streaming ($200 free credit)
export DEEPGRAM_API_KEY="your-key"

# Fast and free — Groq Whisper
export GROQ_API_KEY="your-key"

# Reliable — OpenAI Whisper
export OPENAI_API_KEY="your-key"
```

Install an audio capture tool:
```bash
brew install sox        # macOS/Linux (recommended)
brew install ffmpeg     # alternative
# arecord is pre-installed on most Linux distros
```

Verify: `/voice test`

## Commands

```
/voice [seconds]        — record and transcribe (default 10s)
/voice dictate          — continuous dictation (30s)
/voice test             — check audio + provider setup
/voice config [prov]    — set provider (auto/deepgram/groq/openai)
/voice lang [code]      — set language (en, es, fr, de, ja, zh, ko, ...)
/voice history          — recent transcriptions
/voice stop             — stop active recording
```

## Provider fallback chain

1. **Deepgram** Nova 3 — streaming via WebSocket, best quality, 56+ languages
2. **Groq** Whisper Large v3 Turbo — fast, free tier
3. **OpenAI** Whisper-1 — reliable, paid

Auto-detection: uses the first available provider. Override with `/voice config deepgram`.

## 56+ Languages

```
/voice lang es          — Spanish
/voice lang ja          — Japanese
/voice lang zh          — Chinese (auto-switches to Nova 2)
/voice lang de          — German
/voice lang fr          — French
```

Full list: `/voice lang`

## What's new in v2.0

- **Deepgram streaming** via WebSocket + REST fallback
- **Multi-provider fallback** chain (Deepgram → Groq → OpenAI)
- **56+ languages** with auto model selection
- **Continuous dictation** mode (`/voice dictate`)
- **Provider diagnostics** (`/voice test`)
- **Better Windows support** (ffmpeg dshow)
- **History** with provider and language tracking

## License

MIT
