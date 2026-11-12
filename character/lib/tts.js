// lib/tts.js — 爱丽丝的声音：调用本地 GPT-SoVITS 把文字合成语音。
//
// 依赖：GPT-SoVITS api_v2.py 跑在 http://127.0.0.1:9880
// 参考音色 + 参考文本由用户自备（不随插件分发）。
// 输出 wav 字节；streaming_mode=0 一次性返回完整音频。

import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { existsSync, unlinkSync, writeFileSync } from 'node:fs'

// 情绪档 → 语速系数（安静克制：低情绪慢一点、高情绪微快一点）
const SPEED = { 低: 0.95, 中: 1.0, 高: 1.05, 仅: 1.0 }

/**
 * 合成一段语音。
 * @param {string} text 要说的中文文本
 * @param {object} tts character.json 里的 tts 配置
 * @param {string} emotionLevel 情绪档：低/中/高/仅
 * @returns {Promise<Buffer|null>} wav 字节；未启用或失败返回 null
 */
export async function synthesize(text, tts, emotionLevel) {
  if (!tts?.enabled || !tts?.api || !tts?.refAudio) return null
  try {
    const base = String(tts.api).replace(/\/+$/, '')
    const url = new URL(base + '/tts')
    url.searchParams.set('text', text)
    url.searchParams.set('text_lang', tts.textLang ?? 'zh')
    url.searchParams.set('ref_audio_path', tts.refAudio)
    url.searchParams.set('prompt_text', tts.promptText ?? '')
    url.searchParams.set('prompt_lang', tts.promptLang ?? 'zh')
    url.searchParams.set('speed_factor', String(SPEED[emotionLevel] ?? 1.0))
    url.searchParams.set('media_type', 'wav')
    url.searchParams.set('streaming_mode', '0')

    const res = await fetch(url.toString(), { signal: AbortSignal.timeout(90000) })
    if (!res.ok) {
      console.error(`[tts] HTTP ${res.status}`)
      return null
    }
    const buf = Buffer.from(await res.arrayBuffer())
    if (buf.length < 44) {
      console.error(`[tts] 输出过短：${buf.length} 字节`)
      return null
    }
    return buf
  } catch (err) {
    console.error('[tts] 合成失败：', err?.message ?? err)
    return null
  }
}

/** 存到临时目录，返回文件路径（给 voice 端点用） */
export function saveAudio(buf) {
  const file = join(tmpdir(), `yuzu-tts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
  writeFileSync(file, buf)
  return file
}

// ── QQ 语音：wav → mp3（24000Hz 单声道 48k，体积小，NapCat 收）──
const FFMPEG_CANDIDATES = [
  'G:/DSH/rvc/RVC20260718Nvidia/ffmpeg.exe',
  'G:/DSH/gpt-sovits-v5/GPT-SoVITS-v5-20261006/runtime/ffmpeg.exe',
]

function findFfmpeg() {
  for (const c of FFMPEG_CANDIDATES) if (existsSync(c)) return c
  return 'ffmpeg' // 兜底走 PATH
}

/**
 * 把 wav 字节转成 mp3 文件，返回 mp3 路径；失败返回 null。
 * QQ 语音用 mp3 体积小（wav 203KB → mp3 28KB），NapCat 两种都收。
 */
export function wavToMp3(wavBuf) {
  try {
    const wavFile = join(tmpdir(), `yuzu-qq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.wav`)
    const mp3File = wavFile.replace(/\.wav$/, '.mp3')
    writeFileSync(wavFile, wavBuf)
    execFileSync(findFfmpeg(), ['-y', '-i', wavFile, '-ar', '24000', '-ac', '1', '-b:a', '48k', mp3File], { stdio: 'ignore', timeout: 30000 })
    try { unlinkSync(wavFile) } catch {}
    return mp3File
  } catch (err) {
    console.error('[tts] wav→mp3 失败：', err?.message ?? err)
    return null
  }
}
