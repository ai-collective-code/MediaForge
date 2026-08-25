import { FFmpeg } from '@ffmpeg/ffmpeg'
import { toBlobURL } from '@ffmpeg/util'

const CORE_BASE = 'https://unpkg.com/@ffmpeg/core@0.12.6/dist/esm'

let ffmpeg: FFmpeg | null = null
let loadPromise: Promise<FFmpeg> | null = null

export function getFFmpeg(): Promise<FFmpeg> {
  if (!loadPromise) {
    loadPromise = (async () => {
      const instance = new FFmpeg()
      await instance.load({
        coreURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
        wasmURL: await toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
      })
      ffmpeg = instance
      return instance
    })()
  }
  return loadPromise
}

export function getLoadedFFmpeg(): FFmpeg | null {
  return ffmpeg
}
