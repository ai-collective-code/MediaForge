// Lazily loads and initializes @techstark/opencv-js (a WASM build of OpenCV)
// exactly once, and hands back the ready `cv` namespace.
//
// This is loaded as a classic <script> tag (browser-global build) rather than
// an ES/CJS import. The package's UMD factory resolves to a native Promise
// (Emscripten's async MODULARIZE output), and bundling it through Rollup's
// CJS interop for the production build turns that into a broken thenable,
// crashing with "TypeError: Method Promise.prototype.then called on
// incompatible receiver #<Promise>" (only in the built app, since dev's
// esbuild pre-bundling tolerates it). Loading it as a plain script sets
// `window.cv` directly with no bundler involved, sidestepping the issue
// entirely - the same reason ffmpeg-core is fetched at runtime instead of
// statically imported in ffmpegClient.ts.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CvModule = any

const CV_SCRIPT_URL = 'https://unpkg.com/@techstark/opencv-js@5.0.0-release.1/dist/opencv.js'

let cvPromise: Promise<CvModule> | null = null

function loadScript(url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script')
    script.src = url
    script.onload = () => resolve()
    script.onerror = () => reject(new Error(`Failed to load OpenCV script: ${url}`))
    document.head.appendChild(script)
  })
}

export function getCv(): Promise<CvModule> {
  if (!cvPromise) {
    cvPromise = (async () => {
      const globalWindow = window as unknown as { cv?: CvModule }
      if (!globalWindow.cv) {
        await loadScript(CV_SCRIPT_URL)
      }

      let cvResolved = globalWindow.cv
      if (cvResolved instanceof Promise) {
        cvResolved = await cvResolved
      }

      // Wait for OpenCV's runtime initialization if not already loaded.
      if (!cvResolved.Mat) {
        await new Promise<void>((resolve) => {
          cvResolved.onRuntimeInitialized = () => resolve()
        })
      }

      return cvResolved
    })()
  }
  return cvPromise
}
