export function loadImageToCanvas(file: File, canvas: HTMLCanvasElement): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) {
        reject(new Error('Canvas not supported'))
        return
      }
      ctx.drawImage(img, 0, 0)
      URL.revokeObjectURL(url)
      resolve()
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('Could not load image'))
    }
    img.src = url
  })
}

export function compressCanvas(
  source: HTMLCanvasElement,
  scalePct: number,
  mimeType: string,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const scale = scalePct / 100
    const targetW = Math.max(1, Math.round(source.width * scale))
    const targetH = Math.max(1, Math.round(source.height * scale))

    const out = document.createElement('canvas')
    out.width = targetW
    out.height = targetH
    const ctx = out.getContext('2d')
    if (!ctx) {
      reject(new Error('Canvas not supported'))
      return
    }
    // High quality downscale
    ctx.imageSmoothingEnabled = true
    ctx.imageSmoothingQuality = 'high'
    ctx.drawImage(source, 0, 0, targetW, targetH)

    out.toBlob(
      (blob) => {
        if (blob) resolve(blob)
        else reject(new Error('Compression failed'))
      },
      mimeType,
      mimeType === 'image/png' ? undefined : quality / 100,
    )
  })
}

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  const value = bytes / Math.pow(1024, i)
  return `${value.toFixed(i === 0 ? 0 : 2)} ${units[i]}`
}

export function canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob)
      else reject(new Error('Export failed'))
    }, 'image/png')
  })
}

/** Rasterizes a set of bounding boxes into a mask canvas suitable for `inpaintCanvas`. */
export function buildMaskFromBoxes(
  width: number,
  height: number,
  boxes: { x0: number; y0: number; x1: number; y1: number }[],
  padding = 3,
): HTMLCanvasElement {
  const mask = document.createElement('canvas')
  mask.width = width
  mask.height = height
  const ctx = mask.getContext('2d')
  if (!ctx) return mask

  ctx.fillStyle = 'rgba(239, 68, 68, 1)'
  for (const box of boxes) {
    const x = Math.max(0, box.x0 - padding)
    const y = Math.max(0, box.y0 - padding)
    const w = Math.min(width, box.x1 + padding) - x
    const h = Math.min(height, box.y1 + padding) - y
    ctx.fillRect(x, y, w, h)
  }
  return mask
}

/**
 * Removes a painted region from `imgCanvas` using OpenCV's Telea inpainting
 * algorithm, reconstructing the masked pixels from their surroundings.
 * `maskCanvas` must be the same size as `imgCanvas`; any pixel with alpha > 0
 * is treated as part of the region to remove.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function inpaintCanvas(
  cv: any,
  imgCanvas: HTMLCanvasElement,
  maskCanvas: HTMLCanvasElement,
  radius: number,
  algorithmType: 'telea' | 'ns' = 'ns',
) {
  const srcRgba = cv.imread(imgCanvas)
  const maskRgba = cv.imread(maskCanvas)

  // cv.inpaint only accepts 1- or 3-channel images; canvas reads come back as RGBA.
  // Convert to RGB (not BGR) since cv.imshow expects RGB order when writing the result back.
  const src = new cv.Mat()
  cv.cvtColor(srcRgba, src, cv.COLOR_RGBA2RGB)

  const maskGray = new cv.Mat()
  cv.cvtColor(maskRgba, maskGray, cv.COLOR_RGBA2GRAY)
  cv.threshold(maskGray, maskGray, 1, 255, cv.THRESH_BINARY)

  // Dilate with a larger 5x5 kernel to fully cover anti-aliased text boundaries
  const kernel = cv.Mat.ones(5, 5, cv.CV_8U)
  const anchor = new cv.Point(-1, -1)
  cv.dilate(maskGray, maskGray, kernel, anchor, 1, cv.BORDER_CONSTANT, cv.morphologyDefaultBorderValue())

  const dst = new cv.Mat()
  const algo = algorithmType === 'telea' ? cv.INPAINT_TELEA : cv.INPAINT_NS
  cv.inpaint(src, maskGray, dst, radius, algo)
  cv.imshow(imgCanvas, dst)

  srcRgba.delete()
  maskRgba.delete()
  src.delete()
  maskGray.delete()
  kernel.delete()
  dst.delete()
}
