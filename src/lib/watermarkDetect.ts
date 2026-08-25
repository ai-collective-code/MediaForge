import { getCv } from './opencv'
import type { Rect } from './videoOps'

export interface DetectionProgress {
  message: string
  percent: number
}

/**
 * Extracts frames from the active video player element directly with robust seek timing.
 */
export async function extractFrames(
  videoElement: HTMLVideoElement,
  numFrames = 5,
  onProgress?: (progress: DetectionProgress) => void,
): Promise<HTMLCanvasElement[]> {
  const width = videoElement.videoWidth
  const height = videoElement.videoHeight
  const duration = videoElement.duration
  const canvases: HTMLCanvasElement[] = []

  const originalTime = videoElement.currentTime
  const times: number[] = []
  const interval = duration / (numFrames + 1)
  for (let i = 1; i <= numFrames; i++) {
    times.push(i * interval)
  }

  try {
    for (let i = 0; i < times.length; i++) {
      const time = times[i]
      if (onProgress) {
        onProgress({
          message: `Extracting video frame ${i + 1}/${numFrames}...`,
          percent: Math.round(((i + 0.5) / numFrames) * 50),
        })
      }
      
      await new Promise<void>((resolveSeek) => {
        const timeout = setTimeout(() => {
          videoElement.removeEventListener('seeked', onSeeked)
          
          // Draw frame anyway
          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const ctx = canvas.getContext('2d')
          if (ctx) {
            ctx.drawImage(videoElement, 0, 0, width, height)
            canvases.push(canvas)
          }
          resolveSeek()
        }, 800)

        const onSeeked = () => {
          clearTimeout(timeout)
          videoElement.removeEventListener('seeked', onSeeked)

          const canvas = document.createElement('canvas')
          canvas.width = width
          canvas.height = height
          const ctx = canvas.getContext('2d')
          if (ctx) {
            ctx.drawImage(videoElement, 0, 0, width, height)
            canvases.push(canvas)
          }
          resolveSeek()
        }

        videoElement.addEventListener('seeked', onSeeked)
        videoElement.currentTime = time
      })
    }
  } finally {
    // Restore video player back to the original time
    await new Promise<void>((resolveRestore) => {
      const onSeekedRestore = () => {
        videoElement.removeEventListener('seeked', onSeekedRestore)
        resolveRestore()
      }
      videoElement.addEventListener('seeked', onSeekedRestore)
      videoElement.currentTime = originalTime
      
      setTimeout(() => {
        videoElement.removeEventListener('seeked', onSeekedRestore)
        resolveRestore()
      }, 500)
    })
  }

  return canvases
}

/**
 * Automatically detects the watermark/logo region by intersecting edges across multiple frames.
 * Stationary watermark outlines will consistently overlap, while moving backgrounds will not.
 */
export async function autoDetectWatermark(
  videoElement: HTMLVideoElement,
  onProgress?: (progress: DetectionProgress) => void,
): Promise<{ rect: Rect; corner: string } | null> {
  const cv = await getCv()
  
  if (onProgress) {
    onProgress({ message: 'Extracting video frames...', percent: 5 })
  }
  const canvases = await extractFrames(videoElement, 5, onProgress)
  if (canvases.length === 0) {
    throw new Error('Failed to extract frames from video.')
  }

  if (onProgress) {
    onProgress({ message: 'Performing edge intersection analysis...', percent: 60 })
  }

  const width = canvases[0].width
  const height = canvases[0].height

  // Convert all frames to grayscale and perform Canny edge detection
  const grays: any[] = []
  const edgesList: any[] = []
  for (const canvas of canvases) {
    const mat = cv.imread(canvas)
    const gray = new cv.Mat()
    cv.cvtColor(mat, gray, cv.COLOR_RGBA2GRAY)
    
    const edge = new cv.Mat()
    // Lower thresholds (25, 80) to capture lighter or semi-transparent watermarks
    cv.Canny(gray, edge, 25, 80)
    
    grays.push(gray)
    edgesList.push(edge)
    mat.delete()
  }

  // Accumulate edge maps: count how many times an edge occurs at each coordinate
  // We use CV_32F (float) because cv.threshold strictly requires CV_8U or CV_32F.
  const edgeSum = cv.Mat.zeros(height, width, cv.CV_32F)

  for (const edge of edgesList) {
    const edgeBin = new cv.Mat()
    cv.threshold(edge, edgeBin, 1, 1, cv.THRESH_BINARY)
    
    const edgeBin32F = new cv.Mat()
    edgeBin.convertTo(edgeBin32F, cv.CV_32F)
    
    cv.add(edgeSum, edgeBin32F, edgeSum)
    
    edgeBin.delete()
    edgeBin32F.delete()
  }

  // Keep edges that appear in at least 3 out of 5 frames
  const staticEdges32 = new cv.Mat()
  cv.threshold(edgeSum, staticEdges32, 2.5, 255, cv.THRESH_BINARY)

  const staticEdges = new cv.Mat()
  staticEdges32.convertTo(staticEdges, cv.CV_8U)

  // Morphological dilation to bridge letters and outlines into unified groups
  const staticEdgesDilated = new cv.Mat()
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U)
  const anchor = new cv.Point(-1, -1)
  cv.dilate(staticEdges, staticEdgesDilated, kernel, anchor, 2)

  if (onProgress) {
    onProgress({ message: 'Locating stationary logo clusters...', percent: 80 })
  }

  // Find contours on the dilated edge map
  const contours = new cv.MatVector()
  const hierarchy = new cv.Mat()
  cv.findContours(staticEdgesDilated, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

  const rawRects: Rect[] = []

  for (let i = 0; i < contours.size(); ++i) {
    const contour = contours.get(i)
    const boundingRect = cv.boundingRect(contour)
    
    // Bounds for watermark dimensions
    const minW = Math.max(10, width * 0.015)
    const minH = Math.max(10, height * 0.015)
    const maxW = width * 0.50
    const maxH = height * 0.35

    const isBorderLine = boundingRect.width > width * 0.95 || boundingRect.height > height * 0.95

    if (
      boundingRect.width >= minW &&
      boundingRect.height >= minH &&
      boundingRect.width <= maxW &&
      boundingRect.height <= maxH &&
      !isBorderLine
    ) {
      rawRects.push({
        x: boundingRect.x,
        y: boundingRect.y,
        w: boundingRect.width,
        h: boundingRect.height,
      })
    }
  }

  // Merge rectangles that are close to each other
  const mergedRects = mergeCloseRects(rawRects, 25)

  // Rank candidate boxes by the density of underlying static edge pixels
  let bestRect: Rect | null = null
  let maxScore = -1

  for (const rect of mergedRects) {
    const rx = Math.max(0, Math.floor(rect.x))
    const ry = Math.max(0, Math.floor(rect.y))
    const rw = Math.min(width - rx, Math.floor(rect.w))
    const rh = Math.min(height - ry, Math.floor(rect.h))

    if (rw >= 10 && rh >= 10 && rw <= width * 0.55 && rh <= height * 0.40) {
      const cvRect = new cv.Rect(rx, ry, rw, rh)
      const roi = staticEdges.roi(cvRect)
      const edgePixelCount = cv.countNonZero(roi)
      roi.delete()

      const score = edgePixelCount

      if (score > maxScore && score > 8) { // Require at least 8 static edge pixels
        maxScore = score

        // Pad the bounding box slightly to ensure full coverage
        const pad = 6
        const padX = Math.max(0, rx - pad)
        const padY = Math.max(0, ry - pad)
        const padW = Math.min(width, rx + rw + pad) - padX
        const padH = Math.min(height, ry + rh + pad) - padY

        bestRect = { x: padX, y: padY, w: padW, h: padH }
      }
    }
  }

  // Clean up OpenCV memory
  for (const g of grays) g.delete()
  for (const e of edgesList) e.delete()
  edgeSum.delete()
  staticEdges32.delete()
  staticEdges.delete()
  staticEdgesDilated.delete()
  kernel.delete()
  contours.delete()
  hierarchy.delete()

  if (onProgress) {
    onProgress({ message: 'Watermark analysis complete.', percent: 100 })
  }

  if (!bestRect) return null

  // Classify position for visual UI feedback
  const cx = bestRect.x + bestRect.w / 2
  const cy = bestRect.y + bestRect.h / 2
  let positionName = 'Center'

  if (cx < width * 0.35 && cy < height * 0.35) positionName = 'Top-Left'
  else if (cx > width * 0.65 && cy < height * 0.35) positionName = 'Top-Right'
  else if (cx < width * 0.35 && cy > height * 0.65) positionName = 'Bottom-Left'
  else if (cx > width * 0.65 && cy > height * 0.65) positionName = 'Bottom-Right'
  else if (cy > height * 0.65) positionName = 'Bottom-Center'
  else if (cy < height * 0.35) positionName = 'Top-Center'

  return {
    rect: bestRect,
    corner: positionName,
  }
}

/**
 * Merges close or overlapping bounding boxes.
 */
function mergeCloseRects(rects: Rect[], maxDistance = 25): Rect[] {
  const merged: Rect[] = []
  const used = new Set<number>()

  for (let i = 0; i < rects.length; i++) {
    if (used.has(i)) continue
    let r1 = { ...rects[i] }
    used.add(i)

    let mergedAny = true
    while (mergedAny) {
      mergedAny = false
      for (let j = 0; j < rects.length; j++) {
        if (used.has(j)) continue
        const r2 = rects[j]

        // Check proximity horizontally and vertically
        const isClose = (r1.x + r1.w + maxDistance >= r2.x && r2.x + r2.w + maxDistance >= r1.x) &&
                        (r1.y + r1.h + maxDistance >= r2.y && r2.y + r2.h + maxDistance >= r1.y)

        if (isClose) {
          const minX = Math.min(r1.x, r2.x)
          const minY = Math.min(r1.y, r2.y)
          const maxX = Math.max(r1.x + r1.w, r2.x + r2.w)
          const maxY = Math.max(r1.y + r1.h, r2.y + r2.h)
          r1 = { x: minX, y: minY, w: maxX - minX, h: maxY - minY }
          used.add(j)
          mergedAny = true
        }
      }
    }
    merged.push(r1)
  }

  return merged
}
