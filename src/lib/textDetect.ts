import { createWorker } from 'tesseract.js'
import type { Worker } from 'tesseract.js'

let workerPromise: Promise<Worker> | null = null

export function getOcrWorker(): Promise<Worker> {
  if (!workerPromise) {
    workerPromise = createWorker('eng')
  }
  return workerPromise
}

export interface TextBox {
  x0: number
  y0: number
  x1: number
  y1: number
  confidence: number
  text: string
}

/** Runs OCR on the canvas and returns bounding boxes for every word detected with reasonable confidence. */
export async function detectTextBoxes(canvas: HTMLCanvasElement, minConfidence = 40): Promise<TextBox[]> {
  const worker = await getOcrWorker()
  const { data } = await worker.recognize(canvas, {}, { blocks: true })

  const boxes: TextBox[] = []
  for (const block of data.blocks ?? []) {
    for (const paragraph of block.paragraphs) {
      for (const line of paragraph.lines) {
        for (const word of line.words) {
          if (word.confidence >= minConfidence) {
            boxes.push({ ...word.bbox, confidence: word.confidence, text: word.text })
          }
        }
      }
    }
  }
  return boxes
}
