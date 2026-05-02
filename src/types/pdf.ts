export type WorkerAction = 'MERGE_PDFS' | 'SPLIT_PDF' | 'IMAGES_TO_PDF';

export interface WorkerResponse {
  id: string;
  success: boolean;
  data?: Uint8Array; // serialized PDF
  error?: string;
}

export interface MergePayload {
  pdfBuffers: ArrayBuffer[];
}

export interface SplitPayload {
  pdfBuffer: ArrayBuffer;
  pageIndices: number[]; // 0-based
}

export interface ImagesToPdfPayload {
  imageBuffers: ArrayBuffer[];
  imageTypes?: string[];
  // page sizing mode: 'original' = each page uses the original image size,
  // 'max' = use the maximum width/height among all images for every page,
  // 'custom' = use provided customWidthPx/customHeightPx for all pages (in pixels)
  mode?: 'original' | 'max' | 'custom';
  // custom dimensions in pixels
  customWidthPx?: number;
  customHeightPx?: number;
}

export type WorkerMessage =
  | {
      id: string;
      action: 'MERGE_PDFS';
      payload: MergePayload;
    }
  | {
      id: string;
      action: 'SPLIT_PDF';
      payload: SplitPayload;
    }
  | {
      id: string;
      action: 'IMAGES_TO_PDF';
      payload: ImagesToPdfPayload;
    };
