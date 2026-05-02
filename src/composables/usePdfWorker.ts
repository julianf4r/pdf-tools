import { onUnmounted } from 'vue';
import type { WorkerMessage, WorkerResponse } from '../types/pdf';
import PdfWorker from '../workers/pdf.worker.ts?worker';

export function usePdfWorker() {
  const worker = new PdfWorker();
  const pendingRequests = new Map<string, { resolve: (data: Uint8Array) => void, reject: (err: unknown) => void }>();

  worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
    const { id, success, data, error } = e.data;
    const request = pendingRequests.get(id);
    
    if (request) {
      if (success && data) {
        request.resolve(data);
      } else {
        request.reject(new Error(error || 'Operation failed'));
      }
      pendingRequests.delete(id);
    }
  };

  worker.onerror = (e) => {
    console.error('Worker Error', e);
    pendingRequests.forEach((req) => req.reject(new Error('Worker error occurred')));
    pendingRequests.clear();
  };

  const postMessageToWorker = (message: WorkerMessage): Promise<Uint8Array> => {
    return new Promise((resolve, reject) => {
      pendingRequests.set(message.id, { resolve, reject });
      
      // Identify transferables to optimize performance
      // Note: Once transferred, the ArrayBuffer in the main thread becomes detached (unusable).
      // Ensure that the caller does not need the buffer anymore.
      const transfer: Transferable[] = [];
      if (message.action === 'MERGE_PDFS') {
         // Be careful: if the caller reuses these buffers, we shouldn't transfer.
         // But typically in this flow, we upload -> process -> done.
         // Let's transfer for performance as requested ("Performance & Threading").
        message.payload.pdfBuffers.forEach(b => transfer.push(b));
      } else if (message.action === 'SPLIT_PDF') {
        transfer.push(message.payload.pdfBuffer);
      } else if (message.action === 'IMAGES_TO_PDF') {
        message.payload.imageBuffers.forEach(b => transfer.push(b));
      }

      worker.postMessage(message, transfer);
    });
  };

  const mergePdfs = (pdfBuffers: ArrayBuffer[]) => postMessageToWorker({
    id: crypto.randomUUID(),
    action: 'MERGE_PDFS',
    payload: { pdfBuffers },
  });
  const splitPdf = (pdfBuffer: ArrayBuffer, pageIndices: number[]) => postMessageToWorker({
    id: crypto.randomUUID(),
    action: 'SPLIT_PDF',
    payload: { pdfBuffer, pageIndices },
  });
  const imagesToPdf = (
    imageBuffers: ArrayBuffer[],
    options?: {
      imageTypes?: string[];
      mode?: 'original' | 'max' | 'custom';
      customWidthPx?: number;
      customHeightPx?: number;
    }
  ) => postMessageToWorker({
    id: crypto.randomUUID(),
    action: 'IMAGES_TO_PDF',
    payload: { imageBuffers, ...(options || {}) },
  });

  const terminate = () => {
    worker.terminate();
    pendingRequests.clear();
  };

  onUnmounted(() => {
    terminate();
  });

  return {
    mergePdfs,
    splitPdf,
    imagesToPdf,
    terminate // expose if manual termination is needed
  };
}
