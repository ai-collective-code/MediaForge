import { useCallback, useEffect, useRef, useState } from 'react'
import type { FFmpeg } from '@ffmpeg/ffmpeg'
import { formatBytes } from '../../lib/imageOps'
import { getFFmpeg } from '../../lib/ffmpegClient'
import { compressVideo, removeVideoWatermark, type Rect } from '../../lib/videoOps'
import { autoDetectWatermark, type DetectionProgress } from '../../lib/watermarkDetect'

type CtrlTab = 'vcompress' | 'vwatermark'
type EngineStatus = 'loading' | 'ready' | 'error'

function getPoint(canvas: HTMLCanvasElement, clientX: number, clientY: number) {
  const rect = canvas.getBoundingClientRect()
  const scaleX = canvas.width / rect.width
  const scaleY = canvas.height / rect.height
  return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY }
}

function qualityLabel(crf: number) {
  if (crf <= 20) return 'High quality'
  if (crf <= 26) return 'Balanced'
  return 'Smaller file'
}

export default function VideoEditor() {
  const videoRef = useRef<HTMLVideoElement>(null)
  const overlayRef = useRef<HTMLCanvasElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const ffmpegRef = useRef<FFmpeg | null>(null)
  const progressCbRef = useRef<((pct: number) => void) | null>(null)

  const [hasVideo, setHasVideo] = useState(false)
  const [fileName, setFileName] = useState('')
  const [originalSize, setOriginalSize] = useState(0)
  const [isDragOver, setIsDragOver] = useState(false)
  const [videoUrl, setVideoUrl] = useState<string | null>(null)
  const [workingBlob, setWorkingBlob] = useState<Blob | null>(null)

  const [ctrlTab, setCtrlTab] = useState<CtrlTab>('vcompress')
  const [ffmpegStatus, setFfmpegStatus] = useState<EngineStatus>('loading')

  const [crf, setCrf] = useState(23)
  const [resScale, setResScale] = useState(1)
  const [compressedUrl, setCompressedUrl] = useState<string | null>(null)
  const [compressedSize, setCompressedSize] = useState(0)
  const [isCompressing, setIsCompressing] = useState(false)
  const [compressError, setCompressError] = useState<string | null>(null)

  const [videoDimensions, setVideoDimensions] = useState<{ width: number; height: number } | null>(null)
  const [selection, setSelection] = useState<Rect | null>(null)
  const dragStartRef = useRef<{ x: number; y: number } | null>(null)
  const [isRemoving, setIsRemoving] = useState(false)
  const [wmDownloadUrl, setWmDownloadUrl] = useState<string | null>(null)
  const [watermarkError, setWatermarkError] = useState<string | null>(null)

  const [isScanning, setIsScanning] = useState(false)
  const [scanProgress, setScanProgress] = useState<DetectionProgress | null>(null)
  const [scanError, setScanError] = useState<string | null>(null)
  const [detectedCorner, setDetectedCorner] = useState<string | null>(null)

  const [progress, setProgress] = useState(0)
  const [isProcessing, setIsProcessing] = useState(false)

  useEffect(() => {
    getFFmpeg()
      .then((instance) => {
        ffmpegRef.current = instance
        instance.on('progress', ({ progress: p }) => {
          progressCbRef.current?.(Math.min(100, Math.max(0, Math.round(p * 100))))
        })
        setFfmpegStatus('ready')
      })
      .catch(() => setFfmpegStatus('error'))
  }, [])

  const clearOverlay = () => {
    const canvas = overlayRef.current
    canvas?.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height)
  }

  const resetOutputs = () => {
    setCompressedUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setWmDownloadUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    setSelection(null)
    setCompressError(null)
    setWatermarkError(null)
    setScanError(null)
    setDetectedCorner(null)
    clearOverlay()
  }

  const handleFile = useCallback((file: File) => {
    if (!file.type.startsWith('video/')) return
    const url = URL.createObjectURL(file)
    setFileName(file.name)
    setOriginalSize(file.size)
    setWorkingBlob(file)
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return url
    })
    setHasVideo(true)
    resetOutputs()
  }, [])

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setIsDragOver(false)
    const file = e.dataTransfer.files?.[0]
    if (file) handleFile(file)
  }

  const onVideoLoadedMetadata = () => {
    const video = videoRef.current
    const overlay = overlayRef.current
    if (!video || !overlay) return
    overlay.width = video.videoWidth
    overlay.height = video.videoHeight
    setVideoDimensions({ width: video.videoWidth, height: video.videoHeight })
  }

  const drawSelectionBox = (x: number, y: number, w: number, h: number) => {
    const canvas = overlayRef.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    ctx.clearRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = 'rgba(239, 68, 68, 0.25)'
    ctx.strokeStyle = '#ef4444'
    ctx.lineWidth = Math.max(2, canvas.width / 400)
    ctx.fillRect(x, y, w, h)
    ctx.strokeRect(x, y, w, h)
  }

  const onOverlayPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (ctrlTab !== 'vwatermark') return
    const p = getPoint(e.currentTarget, e.clientX, e.clientY)
    dragStartRef.current = p
  }

  const onOverlayPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragStartRef.current) return
    const start = dragStartRef.current
    const p = getPoint(e.currentTarget, e.clientX, e.clientY)
    drawSelectionBox(Math.min(start.x, p.x), Math.min(start.y, p.y), Math.abs(p.x - start.x), Math.abs(p.y - start.y))
  }

  const onOverlayPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!dragStartRef.current) return
    const start = dragStartRef.current
    const p = getPoint(e.currentTarget, e.clientX, e.clientY)
    const rect: Rect = {
      x: Math.min(start.x, p.x),
      y: Math.min(start.y, p.y),
      w: Math.abs(p.x - start.x),
      h: Math.abs(p.y - start.y),
    }
    dragStartRef.current = null
    if (rect.w > 4 && rect.h > 4) setSelection(rect)
  }

  const clearSelection = () => {
    setSelection(null)
    clearOverlay()
  }

  const handleCompress = async () => {
    const ffmpeg = ffmpegRef.current
    if (!ffmpeg || !workingBlob) return
    setIsCompressing(true)
    setIsProcessing(true)
    setCompressError(null)
    setProgress(0)
    progressCbRef.current = setProgress
    try {
      const blob = await compressVideo(ffmpeg, workingBlob, crf, resScale)
      setCompressedUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(blob)
      })
      setCompressedSize(blob.size)
    } catch (err) {
      setCompressError(err instanceof Error ? err.message : 'Compression failed. Please try again.')
    } finally {
      setIsCompressing(false)
      setIsProcessing(false)
      progressCbRef.current = null
    }
  }

  const executeWatermarkRemoval = async (targetRect: Rect) => {
    const ffmpeg = ffmpegRef.current
    if (!ffmpeg || !workingBlob || !videoDimensions) return
    setIsRemoving(true)
    setIsProcessing(true)
    setWatermarkError(null)
    setProgress(0)
    progressCbRef.current = setProgress
    try {
      const blob = await removeVideoWatermark(
        ffmpeg,
        workingBlob,
        targetRect,
        videoDimensions.width,
        videoDimensions.height,
      )
      setWorkingBlob(blob)
      setVideoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(blob)
      })
      setWmDownloadUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev)
        return URL.createObjectURL(blob)
      })
      clearSelection()
    } catch (err: any) {
      setWatermarkError(err instanceof Error ? err.message : 'Watermark removal failed. Please try again.')
    } finally {
      setIsRemoving(false)
      setIsProcessing(false)
      progressCbRef.current = null
    }
  }

  const handleRemoveWatermark = async () => {
    if (!selection) return
    await executeWatermarkRemoval(selection)
  }

  const handleAutoDetectWatermark = async () => {
    if (!videoUrl || !videoRef.current || !ffmpegRef.current || !workingBlob || !videoDimensions) return
    setIsScanning(true)
    setScanError(null)
    setDetectedCorner(null)
    setScanProgress({ message: 'Initializing auto-detector...', percent: 0 })

    try {
      const result = await autoDetectWatermark(videoRef.current, (prog) => {
        setScanProgress(prog)
      })

      if (result) {
        setSelection(result.rect)
        setDetectedCorner(result.corner)
        drawSelectionBox(result.rect.x, result.rect.y, result.rect.w, result.rect.h)
        
        // Wait 1 second so the user visually sees the bounding box selection detected by the AI
        await new Promise((resolve) => setTimeout(resolve, 1000))
        
        setIsScanning(false)
        setScanProgress(null)
        
        // Automatically start the removal process
        await executeWatermarkRemoval(result.rect)
      } else {
        setScanError('AI could not locate a clear, static watermark in the video. Please select the region manually.')
        setIsScanning(false)
        setScanProgress(null)
      }
    } catch (err: any) {
      console.error('[AI Detector Error]', err)
      const msg = err && typeof err === 'object' && 'message' in err
        ? err.message
        : typeof err === 'string'
        ? err
        : 'AI Watermark detection failed.'
      setScanError(msg)
      setIsScanning(false)
      setScanProgress(null)
    }
  }

  const handleReset = () => {
    setHasVideo(false)
    setFileName('')
    setWorkingBlob(null)
    setVideoDimensions(null)
    setIsScanning(false)
    setScanProgress(null)
    setVideoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev)
      return null
    })
    resetOutputs()
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const savedPct =
    compressedSize && originalSize ? Math.max(0, Math.round((1 - compressedSize / originalSize) * 100)) : 0

  return (
    <>
      <div className="panel-intro">
        <h1>Video Editor</h1>
        <p>
          Compress video while preserving visual quality, or mark a logo/watermark region to remove it.
          Processing happens fully in your browser via WebAssembly.
        </p>
      </div>

      <div className="workspace">
        <div className="canvas-card">
          {!hasVideo && (
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
                accept="video/*"
                hidden
                onChange={(e) => e.target.files?.[0] && handleFile(e.target.files[0])}
              />
              <div className="dropzone-inner">
                <div className="dz-icon">⬆️</div>
                <p>
                  <strong>Click to upload</strong> or drag &amp; drop a video
                </p>
                <span className="dz-hint">MP4, WEBM, MOV supported</span>
              </div>
            </div>
          )}

          <div className="canvas-stage" hidden={!hasVideo}>
            <div className="video-wrap">
              {videoUrl && (
                <video ref={videoRef} src={videoUrl} controls muted onLoadedMetadata={onVideoLoadedMetadata} />
              )}
              <canvas
                ref={overlayRef}
                className="overlay-canvas"
                style={{ pointerEvents: ctrlTab === 'vwatermark' && !isScanning && !isRemoving && !isProcessing ? 'auto' : 'none' }}
                onPointerDown={onOverlayPointerDown}
                onPointerMove={onOverlayPointerMove}
                onPointerUp={onOverlayPointerUp}
                onPointerLeave={onOverlayPointerUp}
              />
              {isScanning && (
                <div className="video-scanner-overlay">
                  <div className="scanner-line" />
                  <div className="scanner-text">✨ AI Scanning Video...</div>
                </div>
              )}
            </div>
            {ctrlTab === 'vwatermark' && (
              <p className="hint-text" style={{ marginTop: 12 }}>
                Use the automatic AI detection button or drag a box over the watermark/logo region manually.
              </p>
            )}
          </div>

          {isProcessing && (
            <div className="progress-wrap">
              <div className="progress-bar">
                <div className="progress-fill" style={{ width: `${progress}%` }} />
              </div>
              <span>Processing… {progress}%</span>
            </div>
          )}
        </div>

        <aside className="controls-card">
          <div className="control-tabs">
            <button
              className={`ctrl-tab ${ctrlTab === 'vcompress' ? 'active' : ''}`}
              onClick={() => setCtrlTab('vcompress')}
            >
              Compress
            </button>
            <button
              className={`ctrl-tab ${ctrlTab === 'vwatermark' ? 'active' : ''}`}
              onClick={() => setCtrlTab('vwatermark')}
            >
              Remove Watermark
            </button>
          </div>

          {ctrlTab === 'vcompress' && (
            <div className="ctrl-panel">
              <div className="field">
                <label htmlFor="vidQuality">
                  Quality (CRF) <span>{qualityLabel(crf)}</span>
                </label>
                <input
                  id="vidQuality"
                  type="range"
                  min={18}
                  max={32}
                  value={crf}
                  onChange={(e) => setCrf(Number(e.target.value))}
                />
                <span className="dz-hint">Lower = higher quality &amp; larger file</span>
              </div>
              <div className="field">
                <label htmlFor="vidResScale">Resolution</label>
                <select id="vidResScale" value={resScale} onChange={(e) => setResScale(Number(e.target.value))}>
                  <option value={1}>Original</option>
                  <option value={0.75}>75%</option>
                  <option value={0.5}>50%</option>
                </select>
              </div>
              <button
                className="btn-primary"
                disabled={!hasVideo || isCompressing || ffmpegStatus !== 'ready'}
                onClick={handleCompress}
              >
                {isCompressing ? 'Compressing…' : 'Compress Video'}
              </button>
              {compressError && <p className="hint-text error-text">{compressError}</p>}

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
                    download={`${fileName.replace(/\.[^.]+$/, '') || 'video'}-compressed.mp4`}
                  >
                    ⬇ Download Compressed Video
                  </a>
                </>
              )}
            </div>
          )}

          {ctrlTab === 'vwatermark' && (
            <div className="ctrl-panel">
              <p className="hint-text">
                Drag a rectangle on the video frame to mark the watermark, or let the AI automatically identify it.
              </p>
              
              <button
                className="btn-ai"
                type="button"
                disabled={!hasVideo || isScanning || isRemoving}
                onClick={handleAutoDetectWatermark}
              >
                {isScanning ? '✨ Scanning Video...' : '✨ Auto-Detect Watermark (AI)'}
              </button>

              {isScanning && scanProgress && (
                <div className="scan-progress-box">
                  <p>
                    <span>{scanProgress.message}</span>
                    <span className="percentage">{scanProgress.percent}%</span>
                  </p>
                  <div className="progress-bar">
                    <div className="progress-fill" style={{ width: `${scanProgress.percent}%` }} />
                  </div>
                </div>
              )}

              {detectedCorner && selection && (
                <div style={{ marginTop: 4 }}>
                  <span className="ai-badge">
                    ✨ Watermark found: {detectedCorner}
                  </span>
                  <p className="dz-hint" style={{ marginTop: 6 }}>
                    Adjust the bounding box on the video frame if needed, then click Remove Watermark below.
                  </p>
                </div>
              )}

              {scanError && <p className="hint-text error-text">{scanError}</p>}

              {selection && !isRemoving && !isProcessing && (
                <button className="btn-ghost" type="button" onClick={clearSelection}>
                  Clear selection
                </button>
              )}

              <hr style={{ border: 'none', borderTop: '1px solid var(--border)', margin: '8px 0' }} />

              <button
                className="btn-primary"
                disabled={!hasVideo || !selection || !videoDimensions || isRemoving || ffmpegStatus !== 'ready' || isScanning}
                onClick={handleRemoveWatermark}
              >
                {isRemoving ? 'Removing…' : 'Remove Watermark'}
              </button>
              {watermarkError && <p className="hint-text error-text">{watermarkError}</p>}
              <p
                className={`engine-status ${
                  ffmpegStatus === 'ready' ? 'ready' : ffmpegStatus === 'error' ? 'error' : ''
                }`}
              >
                {ffmpegStatus === 'loading' && 'Loading video engine…'}
                {ffmpegStatus === 'ready' && 'Video engine ready'}
                {ffmpegStatus === 'error' && 'Failed to load video engine'}
              </p>
              {wmDownloadUrl && (
                <a
                  className="btn-download"
                  href={wmDownloadUrl}
                  download={`${fileName.replace(/\.[^.]+$/, '') || 'video'}-clean.mp4`}
                >
                  ⬇ Download Result
                </a>
              )}
            </div>
          )}

          {hasVideo && (
            <button className="btn-reset" type="button" onClick={handleReset}>
              ↺ Start Over
            </button>
          )}
        </aside>
      </div>
    </>
  )
}
