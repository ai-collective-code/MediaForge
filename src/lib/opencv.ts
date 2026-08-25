// Lazily loads and initializes @techstark/opencv-js (a WASM build of OpenCV)
// exactly once, and hands back the ready `cv` namespace.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CvModule = any

let cvPromise: Promise<CvModule> | null = null

export function getCv(): Promise<CvModule> {
  if (!cvPromise) {
    cvPromise = (async () => {
      const cvModule = (await import('@techstark/opencv-js')).default as CvModule
      if (cvModule instanceof Promise) {
        return cvModule
      }
      if (cvModule.Mat) {
        return cvModule
      }
      await new Promise<void>((resolve) => {
        cvModule.onRuntimeInitialized = () => resolve()
      })
      return cvModule
    })()
  }
  return cvPromise
}
