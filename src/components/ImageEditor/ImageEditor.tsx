import { useCallback, useEffect, useRef, useState } from 'react'
import {
  buildMaskFromBoxes,
  canvasToPngBlob,
  compressCanvas,
  formatBytes,
  inpaintCanvas,
  loadImageToCanvas,
} from '../../lib/imageOps'
import { getCv } from '../../lib/opencv'
import { detectTextBoxes, getOcrWorker, type TextBox } from '../../lib/textDetect'

type CtrlTab = 'compress' | 'watermark' | 'text'
type EngineStatus = 'loading' | 'ready' | 'error'
type TextPhase = 'idle' | 'scanning' | 'reviewing' | 'applying'
type DetectedBox = TextBox & { id: number }

// Confident-only threshold to filter out shapes in the artwork that merely look
// text-like (teeth, icons, etc.) before the user even sees them for review.
const TEXT_CONFIDENCE_THRESHOLD = 60
const BOX_HIT_PADDING = 4

function getCanvasPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / rect.width
  const scaleY = canvas.height / rect.height
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY }
}

export default function ImageEditor() {
  const imgCanvasRef = useRef<HTMLCanvasElement>(null)
  const maskCanvasRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const [hasImage, setHasImage] = useState(false)
  const [fileName, setFileName] = useState('')
  const [originalSize, setOriginalSize] = useState(0)
  const [isDragOver, setIsDragOver] = useState(false)

  const [ctrlTab, setCtrlTab] = useState<CtrlTab>('compress')

  // Compress controls
  const [format, setFormat] = useState('image/webp')
  const [quality, setQuality] = useState(90)
  const [scale, setScale] = useState(100)
  const [compressedUrl, setCompressedUrl] = useState<string | null>(null)
  const [compressedSize, setCompressedSize] = useState(0)
  const [isCompressing, setIsCompressing] = useState(false)

  // Watermark controls
  const [brushSize, setBrushSize] = useState(25)
  const [inpaintRadius, setInpaintRadius] = useState(5)
  const [cvStatus, setCvStatus] = useState<EngineStatus>('loading')
  const [isRemoving, setIsRemoving] = useState(false)
  const [wmDownloadUrl, setWmDownloadUrl] = useState<string | null>(null)
  const isDrawingRef = useRef(false)

  // Remove Text controls
  const [ocrStatus, setOcrStatus] = useState<EngineStatus>('loading')
  const [textPhase, setTextPhase] = useState<TextPhase>('idle')
  const [detectedBoxes, setDetectedBoxes] = useState<DetectedBox[]>([])
  const [excludedIds, setExcludedIds] = useState<Set<number>>(new Set())
  const [textDownloadUrl, setTextDownloadUrl] = useState<string | null>(null)
  const [textMessage, setTextMessage] = useState<string | null>(null)

  // AI Automated controls
  const [isRemovingText, setIsRemovingText] = useState(false)
  const [isRemovingWatermark, setIsRemovingWatermark] = useState(false)
  const [watermarkMessage, setWatermarkMessage] = useState<string | null>(null)
  const ocrStartedRef = useRef(false)

  useEffect(() => {
    getCv()
      .then(() => setCvStatus('ready'))
      .catch(() => setCvStatus('error'))
  }, [])

  useEffect(() => {
    if ((ctrlTab !== 'text' && ctrlTab !== 'watermark') || ocrStartedRef.current) return
    ocrStartedRef.current = true
    getOcrWorker()
      .then(() => setOcrStatus('ready'))
      .catch(() => setOcrStatus('error'))
  }, [ctrlTab])

  const resetOutputs = () => {
    setCompressedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setWmDownloadUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setTextDownloadUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setTextMessage(null)
    setWatermarkMessage(null)
    setTextPhase('idle')
    setDetectedBoxes([])
    setExcludedIds(new Set())
  }

  const handleFile = useCallback(async (file: File) => {
    if (!file.type.startsWith('image/')) return
    const canvas = imgCanvasRef.current
    const maskCanvas = maskCanvasRef.current
    if (!canvas || !maskCanvas) return

    await loadImageToCanvas(file, canvas)
    maskCanvas.width = canvas.width
    maskCanvas.height = canvas.height
    maskCanvas.getContext('2d')?.clearRect(0, 0, maskCanvas.width, maskCanvas.height)

    setFileName(file.name)
    setOriginalSize(file.size)
    setHasImage(true)
    resetOutputs()
  }, [])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  const clearMask = () => {
    const maskCanvas = maskCanvasRef.current
    maskCanvas?.getContext('2d')?.clearRect(0, 0, maskCanvas.width, maskCanvas.height)
  }

  const drawAt = (x: number, y: number) => {
    const ctx = maskCanvasRef.current?.getContext('2d')
    if (!ctx) return
    ctx.fillStyle = 'rgba(239, 68, 68, 0.55)'
    ctx.beginPath()
    ctx.arc(x, y, brushSize / 2, 0, Math.PI * 2)
    ctx.fill()
  }

  // Redraws the detected text boxes: included ones highlighted, excluded ones dimmed.
  useEffect(() => {
    if (ctrlTab !== 'text' || textPhase !== 'reviewing') return
    const canvas = maskCanvasRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    for (const box of detectedBoxes) {
      const excluded = excludedIds.has(box.id)
      ctx.fillStyle = excluded ? 'rgba(148, 152, 172, 0.15)' : 'rgba(34, 197, 94, 0.35)'
      ctx.strokeStyle = excluded ? 'rgba(148, 152, 172, 0.6)' : '#22c55e'
      ctx.lineWidth = 2
      ctx.setLineDash(excluded ? [4, 4] : [])
      const w = box.x1 - box.x0
      const h = box.y1 - box.y0
      ctx.fillRect(box.x0, box.y0, w, h)
      ctx.strokeRect(box.x0, box.y0, w, h)
    }
  }, [ctrlTab, textPhase, detectedBoxes, excludedIds])

  const findBoxAt = (x: number, y: number) =>
    [...detectedBoxes]
      .reverse()
      .find(
        (box) =>
          x >= box.x0 - BOX_HIT_PADDING &&
          x <= box.x1 + BOX_HIT_PADDING &&
          y >= box.y0 - BOX_HIT_PADDING &&
          y <= box.y1 + BOX_HIT_PADDING,
      )

  const toggleBoxAt = (x: number, y: number) => {
    const box = findBoxAt(x, y)
    if (!box) return
    setExcludedIds((prev) => {
      const next = new Set(prev)
      if (next.has(box.id)) next.delete(box.id)
      else next.add(box.id)
      return next
    })
  }

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const { x, y } = getCanvasPoint(e.currentTarget, e.clientX, e.clientY)
    if (ctrlTab === 'watermark') {
      isDrawingRef.current = true
      drawAt(x, y)
    } else if (ctrlTab === 'text' && textPhase === 'reviewing') {
      toggleBoxAt(x, y)
    }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current || ctrlTab !== 'watermark') return
    const { x, y } = getCanvasPoint(e.currentTarget, e.clientX, e.clientY)
    drawAt(x, y)
  }

  const stopDrawing = () => {
    isDrawingRef.current = false
  }

  const handleCompress = async () => {
    const canvas = imgCanvasRef.current
    if (!canvas) return
    setIsCompressing(true)
    try {
      const blob = await compressCanvas(canvas, scale, format, quality)
      setCompressedUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(blob)
      })
      setCompressedSize(blob.size)
    } finally {
      setIsCompressing(false)
    }
  }

  const invalidateCompressedOutput = () => {
    setCompressedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
  }

  const handleRemoveWatermark = async () => {
    const canvas = imgCanvasRef.current
    const maskCanvas = maskCanvasRef.current
    if (!canvas || !maskCanvas) return
    setIsRemoving(true)
    try {
      const cv = await getCv()
      inpaintCanvas(cv, canvas, maskCanvas, inpaintRadius)
      clearMask()
      invalidateCompressedOutput()
      const blob = await canvasToPngBlob(canvas)
      setWmDownloadUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(blob)
      })
    } finally {
      setIsRemoving(false)
    }
  }

  const handleScanText = async () => {
    const canvas = imgCanvasRef.current
    if (!canvas) return
    setTextPhase('scanning')
    setTextMessage(null)
    setTextDownloadUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    try {
      const boxes = await detectTextBoxes(canvas, TEXT_CONFIDENCE_THRESHOLD)
      if (boxes.length === 0) {
        setTextMessage('No text detected in this image.')
        setTextPhase('idle')
        return
      }
      setDetectedBoxes(boxes.map((box, id) => ({ ...box, id })))
      setExcludedIds(new Set())
      setTextPhase('reviewing')
    } catch {
      setTextMessage('Text scan failed. Please try again.')
      setTextPhase('idle')
    }
  }

  const handleCancelTextReview = () => {
    setDetectedBoxes([])
    setExcludedIds(new Set())
    setTextPhase('idle')
    clearMask()
  }

  const handleApplyTextRemoval = async () => {
    const canvas = imgCanvasRef.current
    const boxesToRemove = detectedBoxes.filter((box) => !excludedIds.has(box.id))
    if (!canvas || boxesToRemove.length === 0) return
    setTextPhase('applying')
    try {
      const mask = buildMaskFromBoxes(canvas.width, canvas.height, boxesToRemove)
      const cv = await getCv()
      inpaintCanvas(cv, canvas, mask, inpaintRadius)
      clearMask()
      invalidateCompressedOutput()
      const blob = await canvasToPngBlob(canvas)
      setTextDownloadUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(blob)
      })
      setTextMessage(`Removed ${boxesToRemove.length} text region${boxesToRemove.length === 1 ? '' : 's'}.`)
      setDetectedBoxes([])
      setExcludedIds(new Set())
      setTextPhase('idle')
    } catch {
      setTextMessage('Text removal failed. Please try again.')
      setTextPhase('reviewing')
    }
  }

  const handleAutoRemoveText = async () => {
    const canvas = imgCanvasRef.current
    if (!canvas) return
    setIsRemovingText(true)
    setTextMessage(null)
    setTextDownloadUrl(null)
    try {
      const cv = await getCv()
      
      // Perform OCR (min confidence 40)
      const boxes = await detectTextBoxes(canvas, 40)
      if (boxes.length === 0) {
        setTextMessage('AI did not find any text in this image.')
        return
      }

      // Automatically construct mask from all boxes with padding 6 for edge coverage
      const mask = buildMaskFromBoxes(canvas.width, canvas.height, boxes, 6)
      
      // Remove text using Navier-Stokes (ns) for clean visual quality
      inpaintCanvas(cv, canvas, mask, inpaintRadius, 'ns')
      
      clearMask()
      invalidateCompressedOutput()
      const blob = await canvasToPngBlob(canvas)
      setTextDownloadUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(blob)
      })
      
      setTextMessage(`✨ AI successfully removed ${boxes.length} text region${boxes.length === 1 ? '' : 's'}!`)
    } catch (err) {
      console.error('[AI Text Removal Error]', err)
      setTextMessage('AI Text removal failed. Please try manual brush.')
    } finally {
      setIsRemovingText(false)
    }
  }

  const handleAutoRemoveWatermark = async () => {
    const canvas = imgCanvasRef.current
    if (!canvas) return
    setIsRemovingWatermark(true)
    setWatermarkMessage(null)
    setWmDownloadUrl(null)
    try {
      const cv = await getCv()

      // Run OCR text detection to find watermark strings
      const boxes = await detectTextBoxes(canvas, 35)
      
      const watermarkKeywords = [
        'copyright', '©', 'watermark', 'stock', 'photo', 'shutterstock', 
        'getty', 'adobe', 'dreamstime', 'deposit', 'license', 'licence', 
        'preview', 'alamy', '123rf', 'istock', 'created', 'made', 'by'
      ]

      const w = canvas.width
      const h = canvas.height
      const marginX = w * 0.15
      const marginY = h * 0.15

      // Filter: contains keyword OR lies near image boundaries (corners/edges)
      const watermarkBoxes = boxes.filter(box => {
        const textLower = box.text.toLowerCase()
        const hasKeyword = watermarkKeywords.some(kw => textLower.includes(kw))
        
        const cx = (box.x0 + box.x1) / 2
        const cy = (box.y0 + box.y1) / 2
        const isNearBoundary = cx < marginX || cx > w - marginX || cy < marginY || cy > h - marginY

        return hasKeyword || isNearBoundary
      })

      if (watermarkBoxes.length === 0) {
        setWatermarkMessage('AI could not locate a clear watermark. Please use the manual brush to paint over it.')
        return
      }

      // Automatically construct mask from watermark boxes with padding 6
      const mask = buildMaskFromBoxes(w, h, watermarkBoxes, 6)

      // Remove watermark using Navier-Stokes (ns) for clean visual quality
      inpaintCanvas(cv, canvas, mask, inpaintRadius, 'ns')

      clearMask()
      invalidateCompressedOutput()
      const blob = await canvasToPngBlob(canvas)
      setWmDownloadUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(blob)
      })

      setWatermarkMessage('✨ AI successfully removed the detected watermark!')
    } catch (err) {
      console.error('[AI Watermark Removal Error]', err)
      setWatermarkMessage('AI Watermark removal failed. Please try manual brush.')
    } finally {
      setIsRemovingWatermark(false)
    }
  }

  const handleReset = () => {
    setHasImage(false)
    setFileName('')
    setIsRemovingText(false)
    setIsRemovingWatermark(false)
    setWatermarkMessage(null)
    resetOutputs()
    clearMask()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const compressExt = format === 'image/png' ? 'png' : format === 'image/webp' ? 'webp' : 'jpg'
  const savedPct = compressedSize && originalSize ? Math.max(0, Math.round((1 - compressedSize / originalSize) * 100)) : 0

  return (
    <>
      <div className="panel-intro">
        <h1>Image Editor</h1>
        <p>
          Compress images with minimal quality loss, paint over a watermark to remove it, or automatically strip
          out any text. Everything runs locally in your browser — nothing is uploaded anywhere.
        </p>
      </div>

      <div className="workspace">
        <div className="canvas-card">
          {!hasImage && (
            <div
              className={`dropzone ${isDragOver ? 'drag-over' : ''}`}
              onClick={() => fileInputRef.current?.click()}
              onDragOver={(e) => {
                e.preventDefault()
                setIsDragOver(true)
              }}
              onDragLeave={() => setIsDragOver(false)}
              onDrop={onDrop}
            >
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                hidden
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
              <div className="dropzone-inner">
                <div className="dz-icon">⬆️</div>
                <p>
                  <strong>Click to upload</strong> or drag &amp; drop an image
                </p>
                <span className="dz-hint">PNG, JPG, WEBP supported</span>
              </div>
            </div>
          )}

          <div className="canvas-stage" hidden={!hasImage}>
            <div className="canvas-toolbar">
              {ctrlTab === 'watermark' && (
                <div className="tool-group">
                  <span className="tool-label">Brush size</span>
                  <input
                    type="range"
                    min={5}
                    max={80}
                    value={brushSize}
                    disabled={isRemoving || isRemovingWatermark}
                    onChange={(e) => setBrushSize(Number(e.target.value))}
                  />
                  {!isRemoving && !isRemovingWatermark && (
                    <button className="btn-ghost" type="button" onClick={clearMask}>
                      Clear mask
                    </button>
                  )}
                </div>
              )}
              {ctrlTab === 'text' && textPhase === 'reviewing' && (
                <div className="tool-group">
                  <span className="tool-label">
                    {detectedBoxes.length - excludedIds.size} of {detectedBoxes.length} selected
                  </span>
                  <button className="btn-ghost" type="button" onClick={handleCancelTextReview}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
            <div className="canvas-wrap">
              <canvas ref={imgCanvasRef} />
              <canvas
                ref={maskCanvasRef}
                className="overlay-canvas"
                style={{
                  pointerEvents: (ctrlTab === 'watermark' && !isRemoving && !isRemovingWatermark) ||
                                 (ctrlTab === 'text' && textPhase === 'reviewing' && !isRemovingText) ? 'auto' : 'none',
                }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={stopDrawing}
                onPointerLeave={stopDrawing}
              />
            </div>
          </div>
        </div>

        <aside className="controls-card">
          <div className="control-tabs">
            <button
              className={`ctrl-tab ${ctrlTab === 'compress' ? 'active' : ''}`}
              onClick={() => setCtrlTab('compress')}
            >
              Compress
            </button>
            <button
              className={`ctrl-tab ${ctrlTab === 'watermark' ? 'active' : ''}`}
              onClick={() => setCtrlTab('watermark')}
            >
              AI Watermark Removal
            </button>
            <button className={`ctrl-tab ${ctrlTab === 'text' ? 'active' : ''}`} onClick={() => setCtrlTab('text')}>
              AI Text Removal
            </button>
          </div>

          {ctrlTab === 'compress' && (
            <div className="ctrl-panel">
              <div className="field">
                <label htmlFor="imgFormat">Output format</label>
                <select id="imgFormat" value={format} onChange={(e) => setFormat(e.target.value)}>
                  <option value="image/webp">WebP (best compression)</option>
                  <option value="image/jpeg">JPEG</option>
                  <option value="image/png">PNG (lossless)</option>
                </select>
              </div>
              <div className="field">
                <label htmlFor="imgQuality">
                  Quality <span>{quality}%</span>
                </label>
                <input
                  id="imgQuality"
                  type="range"
                  min={10}
                  max={100}
                  value={quality}
                  disabled={format === 'image/png'}
                  onChange={(e) => setQuality(Number(e.target.value))}
                />
              </div>
              <div className="field">
                <label htmlFor="imgScale">
                  Resize <span>{scale}%</span>
                </label>
                <input
                  id="imgScale"
                  type="range"
                  min={10}
                  max={100}
                  value={scale}
                  onChange={(e) => setScale(Number(e.target.value))}
                />
              </div>
              <button className="btn-primary" disabled={!hasImage || isCompressing} onClick={handleCompress}>
                {isCompressing ? 'Compressing…' : 'Compress Image'}
              </button>

              {compressedUrl && (
                <>
                  <div className="size-compare">
                    <div className="size-row">
                      <span>Original</span>
                      <strong>{formatBytes(originalSize)}</strong>
                    </div>
                    <div className="size-row">
                      <span>Compressed</span>
                      <strong>{formatBytes(compressedSize)}</strong>
                    </div>
                    <div className="size-row saved">
                      <span>Saved</span>
                      <strong>{savedPct}%</strong>
                    </div>
                  </div>
                  <a
                    className="btn-download"
                    href={compressedUrl}
                    download={`${fileName.replace(/\.[^.]+$/, '') || 'image'}-compressed.${compressExt}`}
                  >
                    ⬇ Download Compressed Image
                  </a>
                </>
              )}
            </div>
          )}

          {ctrlTab === 'watermark' && (
            <div className="ctrl-panel">
              <p className="hint-text">
                Automatically detect and remove watermarks using local AI, or use the brush to manually touch up.
              </p>
              
              <button
                className="btn-ai"
                type="button"
                disabled={!hasImage || isRemovingWatermark || cvStatus !== 'ready' || ocrStatus !== 'ready'}
                onClick={handleAutoRemoveWatermark}
              >
                {isRemovingWatermark ? '✨ Scanning & Removing...' : '✨ Remove Watermark (AI)'}
              </button>

              {watermarkMessage && <p className="hint-text" style={{ marginTop: 8 }}>{watermarkMessage}</p>}

              {wmDownloadUrl && (
                <a className="btn-download" href={wmDownloadUrl} download={`${fileName.replace(/\.[^.]+$/, '') || 'image'}-clean.png`}>
                  ⬇ Download Result
                </a>
              )}

              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '12px 0' }} />

              <p className="dz-hint"><strong>Manual Touch-Up:</strong> Paint over watermarks with the brush, then remove.</p>
              <div className="field" style={{ marginTop: 6 }}>
                <label htmlFor="inpaintRadius">
                  Repair strength <span>{inpaintRadius}</span>
                </label>
                <input
                  id="inpaintRadius"
                  type="range"
                  min={1}
                  max={20}
                  value={inpaintRadius}
                  onChange={(e) => setInpaintRadius(Number(e.target.value))}
                />
              </div>
              <button
                className="btn-primary"
                disabled={!hasImage || isRemoving || cvStatus !== 'ready' || isRemovingWatermark}
                onClick={handleRemoveWatermark}
              >
                {isRemoving ? 'Removing…' : 'Remove Watermark (Manual)'}
              </button>
              <p className={`engine-status ${cvStatus === 'ready' ? 'ready' : cvStatus === 'error' ? 'error' : ''}`}>
                {cvStatus === 'loading' && 'Loading image engine…'}
                {cvStatus === 'ready' && 'Image engine ready'}
                {cvStatus === 'error' && 'Failed to load image engine'}
              </p>
            </div>
          )}

          {ctrlTab === 'text' && (
            <div className="ctrl-panel">
              <p className="hint-text">
                Automatically detect and strip all text, or scan first to manually choose which regions to erase.
              </p>

              <button
                className="btn-ai"
                type="button"
                disabled={!hasImage || isRemovingText || ocrStatus !== 'ready' || cvStatus !== 'ready'}
                onClick={handleAutoRemoveText}
              >
                {isRemovingText ? '✨ Scanning & Removing...' : '✨ Remove Text (AI)'}
              </button>

              {textMessage && <p className="hint-text" style={{ marginTop: 8 }}>{textMessage}</p>}

              {textDownloadUrl && (
                <a
                  className="btn-download"
                  href={textDownloadUrl}
                  download={`${fileName.replace(/\.[^.]+$/, '') || 'image'}-no-text.png`}
                >
                  ⬇ Download Result
                </a>
              )}

              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '12px 0' }} />

              <p className="dz-hint"><strong>Manual Selection:</strong> Scan the image first to review and select regions.</p>
              
              {textPhase === 'idle' || textPhase === 'scanning' ? (
                <>
                  <div className="field" style={{ marginTop: 6 }}>
                    <label htmlFor="inpaintRadius2">
                      Repair strength <span>{inpaintRadius}</span>
                    </label>
                    <input
                      id="inpaintRadius2"
                      type="range"
                      min={1}
                      max={20}
                      value={inpaintRadius}
                      onChange={(e) => setInpaintRadius(Number(e.target.value))}
                    />
                  </div>
                  <button
                    className="btn-primary"
                    disabled={!hasImage || textPhase === 'scanning' || ocrStatus !== 'ready' || isRemovingText}
                    onClick={handleScanText}
                  >
                    {textPhase === 'scanning' ? 'Scanning…' : 'Scan for Text (Manual)'}
                  </button>
                  <p
                    className={`engine-status ${ocrStatus === 'ready' ? 'ready' : ocrStatus === 'error' ? 'error' : ''}`}
                  >
                    {ocrStatus === 'loading' && 'Loading text engine…'}
                    {ocrStatus === 'ready' && 'Text engine ready'}
                    {ocrStatus === 'error' && 'Failed to load text engine'}
                  </p>
                </>
              ) : (
                <>
                  <p className="hint-text">
                    Found {detectedBoxes.length} text region{detectedBoxes.length === 1 ? '' : 's'}. Click any
                    highlighted box on the image to exclude it, then remove the rest.
                  </p>
                  <button
                    className="btn-primary"
                    disabled={detectedBoxes.length - excludedIds.size === 0 || textPhase === 'applying'}
                    onClick={handleApplyTextRemoval}
                  >
                    {textPhase === 'applying' ? 'Removing…' : 'Remove Selected Text'}
                  </button>
                  <button
                    className="btn-ghost"
                    type="button"
                    disabled={textPhase === 'applying'}
                    onClick={handleCancelTextReview}
                  >
                    Cancel
                  </button>
                </>
              )}
            </div>
          )}

          {hasImage && (
            <button className="btn-reset" type="button" onClick={handleReset}>
              ↺ Start Over
            </button>
          )}
        </aside>
      </div>
    </>
  )
}
