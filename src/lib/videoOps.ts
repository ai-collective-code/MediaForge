import type { FFmpeg } from '@ffmpeg/ffmpeg'
import { fetchFile } from '@ffmpeg/util'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

async function runAndRead(ffmpeg: FFmpeg, inputBlob: Blob, args: string[]): Promise<Blob> {
  const inputName = 'input.mp4'
  const outputName = 'output.mp4'

  const recentLogs: string[] = []
  const onLog = ({ message }: { message: string }) => {
    recentLogs.push(message)
    if (recentLogs.length > 20) recentLogs.shift()
  }
  ffmpeg.on('log', onLog)

  try {
    await ffmpeg.writeFile(inputName, await fetchFile(inputBlob))
    const exitCode = await ffmpeg.exec(['-i', inputName, ...args, outputName])
    if (exitCode !== 0) {
      throw new Error(`ffmpeg exited with code ${exitCode}: ${recentLogs.join(' ')}`)
    }

    const data = await ffmpeg.readFile(outputName)
    const bytes = data as Uint8Array
    if (bytes.length === 0) {
      throw new Error(`ffmpeg produced an empty file: ${recentLogs.join(' ')}`)
    }

    await ffmpeg.deleteFile(inputName)
    await ffmpeg.deleteFile(outputName)

    return new Blob([bytes.buffer as ArrayBuffer], { type: 'video/mp4' })
  } finally {
    ffmpeg.off('log', onLog)
  }
}

// ffmpeg's delogo filter refuses a box that touches the frame edge at all (it samples
// pixels just outside the box to reconstruct it) - it needs a strict margin, so watermarks
// placed in a corner (the overwhelmingly common case) must be inset slightly to succeed.
const FRAME_MARGIN = 2

/** Clamps a selection rectangle so it always fits strictly inside the frame (required by the delogo filter). */
function clampRect(rect: Rect, frameWidth: number, frameHeight: number): Rect {
  const evenDown = (n: number) => Math.floor(n / 2) * 2
  const maxX = Math.max(FRAME_MARGIN, evenDown(frameWidth - FRAME_MARGIN - 2))
  const maxY = Math.max(FRAME_MARGIN, evenDown(frameHeight - FRAME_MARGIN - 2))
  const x = Math.min(Math.max(FRAME_MARGIN, evenDown(rect.x)), maxX)
  const y = Math.min(Math.max(FRAME_MARGIN, evenDown(rect.y)), maxY)
  const w = Math.min(Math.max(2, evenDown(rect.w)), evenDown(frameWidth - FRAME_MARGIN - x))
  const h = Math.min(Math.max(2, evenDown(rect.h)), evenDown(frameHeight - FRAME_MARGIN - y))
  return { x, y, w, h }
}

export async function compressVideo(
  ffmpeg: FFmpeg,
  inputBlob: Blob,
  crf: number,
  resScale: number,
): Promise<Blob> {
  const args =
    resScale < 1
      ? [
          '-vf',
          `scale=trunc(iw*${resScale}/2)*2:trunc(ih*${resScale}/2)*2`,
          '-c:v',
          'libx264',
          '-crf',
          String(crf),
          '-preset',
          'veryfast',
          '-c:a',
          'aac',
          '-b:a',
          '128k',
        ]
      : ['-c:v', 'libx264', '-crf', String(crf), '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '128k']

  return runAndRead(ffmpeg, inputBlob, args)
}

export async function removeVideoWatermark(
  ffmpeg: FFmpeg,
  inputBlob: Blob,
  rect: Rect,
  frameWidth: number,
  frameHeight: number,
): Promise<Blob> {
  const { x, y, w, h } = clampRect(rect, frameWidth, frameHeight)

  const args = [
    '-vf',
    `delogo=x=${x}:y=${y}:w=${w}:h=${h}:show=0`,
    '-c:v',
    'libx264',
    '-crf',
    '18',
    '-preset',
    'veryfast',
    '-c:a',
    'aac',
    '-b:a',
    '192k',
  ]

  return runAndRead(ffmpeg, inputBlob, args)
}
