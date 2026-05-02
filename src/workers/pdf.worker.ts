import { PDFDocument, type PDFImage, type PDFPage } from 'pdf-lib';
import type { PageFitMode, PageSizeOptions, WorkerMessage, WorkerResponse, ImagesToPdfPayload } from '../types/pdf';

interface PdfWorkerScope {
  onmessage: ((event: MessageEvent<WorkerMessage>) => void) | null;
  postMessage: (message: WorkerResponse, transfer?: Transferable[]) => void;
}

const workerScope = self as unknown as PdfWorkerScope;

workerScope.onmessage = async (e: MessageEvent<WorkerMessage>) => {
  const { id, action, payload } = e.data;

  try {
    let resultBytes: Uint8Array;

    switch (action) {
      case 'MERGE_PDFS':
        resultBytes = await mergePdfs(payload.pdfBuffers, payload.pageSize);
        break;
      case 'SPLIT_PDF':
        resultBytes = await splitPdf(payload.pdfBuffer, payload.pageIndices);
        break;
      case 'IMAGES_TO_PDF':
        resultBytes = await imagesToPdf(payload.imageBuffers, payload);
        break;
      default:
        throw new Error(`Unknown action: ${action}`);
    }

    const response: WorkerResponse = {
      id,
      success: true,
      data: resultBytes
    };

    workerScope.postMessage(response, [resultBytes.buffer]);

  } catch (error: unknown) {
    const response: WorkerResponse = {
      id,
      success: false,
      error: error instanceof Error ? error.message : 'Unknown error in PDF worker'
    };
    workerScope.postMessage(response);
  }
};

const pxToPt = (px: number) => (px * 72) / 96;

async function mergePdfs(pdfBuffers: ArrayBuffer[], pageSize?: PageSizeOptions): Promise<Uint8Array> {
  const mergedPdf = await PDFDocument.create();

  if (pageSize?.mode && pageSize.mode !== 'original') {
    return await mergePdfsWithPageSize(mergedPdf, pdfBuffers, pageSize);
  }
  
  for (const buffer of pdfBuffers) {
    const uint8Buffer = new Uint8Array(buffer);
    const pdf = await PDFDocument.load(uint8Buffer, { ignoreEncryption: true });
    const copiedPages = await copyPagesWithScrubFallback(mergedPdf, pdf, pdf.getPageIndices());
    copiedPages.forEach((page) => mergedPdf.addPage(page));
  }

  return await mergedPdf.save();
}

async function mergePdfsWithPageSize(mergedPdf: PDFDocument, pdfBuffers: ArrayBuffer[], pageSize: PageSizeOptions): Promise<Uint8Array> {
  const sourcePages: PDFPage[] = [];

  for (const buffer of pdfBuffers) {
    const pdf = await PDFDocument.load(new Uint8Array(buffer), { ignoreEncryption: true });
    sourcePages.push(...pdf.getPages());
  }

  const targetSize = resolveTargetPageSize(sourcePages, pageSize);
  const fitMode = pageSize.fitMode || 'fit';

  for (const sourcePage of sourcePages) {
    const embeddedPage = await mergedPdf.embedPage(sourcePage);
    const targetPage = mergedPdf.addPage([targetSize.width, targetSize.height]);
    const placement = getPagePlacement(
      embeddedPage.width,
      embeddedPage.height,
      targetSize.width,
      targetSize.height,
      fitMode
    );

    targetPage.drawPage(embeddedPage, placement);
  }

  return await mergedPdf.save();
}

async function splitPdf(pdfBuffer: ArrayBuffer, pageIndices: number[]): Promise<Uint8Array> {
  const uint8Buffer = new Uint8Array(pdfBuffer);
  const srcPdf = await PDFDocument.load(uint8Buffer, { ignoreEncryption: true });
  const newPdf = await PDFDocument.create();
  
  const copiedPages = await copyPagesWithScrubFallback(newPdf, srcPdf, pageIndices);
  copiedPages.forEach((page) => newPdf.addPage(page));

  return await newPdf.save();
}

async function copyPagesWithScrubFallback(targetPdf: PDFDocument, sourcePdf: PDFDocument, pageIndices: number[]): Promise<PDFPage[]> {
  try {
    return await targetPdf.copyPages(sourcePdf, pageIndices);
  } catch {
    const scrubbedBytes = await sourcePdf.save();
    const scrubbedPdf = await PDFDocument.load(scrubbedBytes, { ignoreEncryption: true });
    return await targetPdf.copyPages(scrubbedPdf, pageIndices);
  }
}

function resolveTargetPageSize(pages: PDFPage[], options: PageSizeOptions): { width: number; height: number } {
  if (options.mode === 'max') {
    return pages.reduce(
      (maxSize, page) => {
        const { width, height } = page.getSize();
        return {
          width: Math.max(maxSize.width, width),
          height: Math.max(maxSize.height, height),
        };
      },
      { width: 0, height: 0 }
    );
  }

  if (options.mode === 'custom' && typeof options.customWidthPx === 'number' && typeof options.customHeightPx === 'number') {
    if (!Number.isFinite(options.customWidthPx) || !Number.isFinite(options.customHeightPx) || options.customWidthPx <= 0 || options.customHeightPx <= 0) {
      throw new Error('Custom page size must be greater than zero');
    }

    return {
      width: pxToPt(options.customWidthPx),
      height: pxToPt(options.customHeightPx),
    };
  }

  throw new Error('Invalid page size options');
}

function getPagePlacement(
  sourceWidth: number,
  sourceHeight: number,
  targetWidth: number,
  targetHeight: number,
  fitMode: PageFitMode
): { x: number; y: number; width: number; height: number } {
  if (fitMode === 'center') {
    return {
      x: (targetWidth - sourceWidth) / 2,
      y: (targetHeight - sourceHeight) / 2,
      width: sourceWidth,
      height: sourceHeight,
    };
  }

  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;

  return {
    x: (targetWidth - width) / 2,
    y: (targetHeight - height) / 2,
    width,
    height,
  };
}

async function imagesToPdf(imageBuffers: ArrayBuffer[], options?: ImagesToPdfPayload): Promise<Uint8Array> {
  const pdf = await PDFDocument.create();

  const embedded: { image: PDFImage; width: number; height: number }[] = [];
  for (let index = 0; index < imageBuffers.length; index++) {
    const buffer = imageBuffers[index];
    if (!buffer) {
      throw new Error(`Missing image data at index ${index}`);
    }

    const type = options?.imageTypes?.[index];
    const image = type === 'image/png'
      ? await pdf.embedPng(buffer)
      : await pdf.embedJpg(buffer);

    const size = image.scale(1);
    embedded.push({ image, width: size.width, height: size.height });
  }

  // Determine page size according to options
  let targetWidth: number | null = null;
  let targetHeight: number | null = null;

  const mode = options?.mode || 'original';
  if (mode === 'max') {
    // choose max width and max height among images
    targetWidth = Math.max(...embedded.map(e => e.width));
    targetHeight = Math.max(...embedded.map(e => e.height));
  } else if (mode === 'custom' && typeof options?.customWidthPx === 'number' && typeof options?.customHeightPx === 'number') {
    if (!Number.isFinite(options.customWidthPx) || !Number.isFinite(options.customHeightPx) || options.customWidthPx <= 0 || options.customHeightPx <= 0) {
      throw new Error('Custom page size must be greater than zero');
    }
    // custom width/height are provided in pixels — convert to points
    targetWidth = pxToPt(options.customWidthPx);
    targetHeight = pxToPt(options.customHeightPx);
  }

  for (const e of embedded) {
    const page = pdf.addPage();

    let pageWidth = e.width;
    let pageHeight = e.height;

    if (mode === 'original') {
      // keep per-image size (image intrinsic sizes are in PDF points because image.scale(1) returned points)
      pageWidth = e.width;
      pageHeight = e.height;
    } else if (mode === 'max' || mode === 'custom') {
      // targetWidth/Height (if set) are in PDF points; otherwise fallback to image size
      pageWidth = targetWidth || e.width;
      pageHeight = targetHeight || e.height;
    }

    page.setSize(pageWidth, pageHeight);

    // Fit image into page while preserving aspect ratio
    const scale = Math.min(pageWidth / e.width, pageHeight / e.height);
    const drawWidth = e.width * scale;
    const drawHeight = e.height * scale;

    page.drawImage(e.image, {
      x: (pageWidth - drawWidth) / 2,
      y: (pageHeight - drawHeight) / 2,
      width: drawWidth,
      height: drawHeight,
    });
  }

  return await pdf.save();
}
