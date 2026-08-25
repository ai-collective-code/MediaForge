// Lazily loads and initializes @techstark/opencv-js (a WASM build of OpenCV)
// exactly once, and hands back the ready `cv` namespace.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type CvModule = any

let cvPromise: Promise<CvModule> | null = null

export function getCv(): Promise<CvModule> {
  if (!cvPromise) {
    cvPromise = (async () => {
      const cvModule = (await import('@techstark/opencv-js')).default as CvModule
      
      // If cvModule itself is wrapped in a Promise (e.g. from some module resolution), resolve it.
      let cvResolved = cvModule
      if (cvModule instanceof Promise) {
        cvResolved = await cvModule
      }
      
      // Wait for OpenCV's runtime initialization if not already loaded.
      if (!cvResolved.Mat) {
        await new Promise<void>((resolve) => {
          cvResolved.onRuntimeInitialized = () => resolve()
        })
      }
      
      // Emscripten modules (like OpenCV.js) define a custom `.then` method on the module object.
      // Modern JS engines/bundlers (like Vite in production) automatically treat objects with
      // a `.then` property as Promises (thenables) when returning them from async functions.
      // Since the Emscripten module is not a standard Promise, this results in:
      // "TypeError: Method Promise.prototype.then called on incompatible receiver".
      // Deleting `.then` prevents the JS engine from attempting to resolve it as a Promise.
      if (cvResolved && typeof cvResolved.then === 'function') {
        try {
          delete cvResolved.then
        } catch (e) {
          console.warn('[OpenCV] Could not delete then property, attempting override:', e)
          try {
            cvResolved.then = undefined
          } catch (e2) {
            console.error('[OpenCV] Failed to override then property:', e2)
          }
        }
      }
      
      return cvResolved
    })()
  }
  return cvPromise
}
