import * as pdfjsLib from 'pdfjs-dist';

const PDFJS_BASE = `${import.meta.env.BASE_URL}pdfjs`;

pdfjsLib.GlobalWorkerOptions.workerSrc = `${PDFJS_BASE}/build/pdf.worker.min.mjs`;

export function usePdfRenderer() {
  
  const renderPageToCanvas = async (
    pdfData: ArrayBuffer, 
    pageIndex: number, 
    scale: number = 1.0
  ): Promise<string> => {
    // Load document
    const loadingTask = pdfjsLib.getDocument({ 
      data: pdfData,
      cMapUrl: `${PDFJS_BASE}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
      verbosity: pdfjsLib.VerbosityLevel.ERRORS
    });
    const pdf = await loadingTask.promise;

    // Get page (1-based index in pdf.js, but we usually use 0-based in logic. Adjust as needed.)
    // pdf-lib is 0-based for most things, but let's check pdf.js.
    // pdf.js getPage(num) is 1-based.
    const page = await pdf.getPage(pageIndex + 1);

    const viewport = page.getViewport({ scale });
    
    // Prepare canvas
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    if (!context) throw new Error('Could not get canvas context');

    const renderContext = {
      canvasContext: context,
      viewport: viewport,
      canvas: canvas // Required by strict types in newer pdfjs-dist
    };

    await page.render(renderContext).promise;
    
    // cleanup
    page.cleanup();
    // pdf.destroy(); // Do not destroy if we want to reuse. But here we are stateless per call.
    // Actually, keeping the document open is better for multiple pages. 
    // But for this simple "render one page" utility, we might reload.
    // Optimization: The caller should manage the `pdf` document object if rendering multiple pages.
    
    return canvas.toDataURL('image/jpeg', 0.8);
  };

  const getDocumentProxy = async (pdfData: ArrayBuffer) => {
    return await pdfjsLib.getDocument({ 
      data: pdfData,
      cMapUrl: `${PDFJS_BASE}/cmaps/`,
      cMapPacked: true,
      standardFontDataUrl: `${PDFJS_BASE}/standard_fonts/`,
      verbosity: pdfjsLib.VerbosityLevel.ERRORS
    }).promise;
  };

  const renderPageFromProxy = async (
    pdf: pdfjsLib.PDFDocumentProxy, 
    pageIndex: number, 
    scale: number = 0.5 // Thumbnail scale
  ): Promise<string> => {
    const page = await pdf.getPage(pageIndex + 1); // 1-based
    const viewport = page.getViewport({ scale });

    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;
    
    if (!context) throw new Error('Canvas context missing');
    
    await page.render({
      canvasContext: context,
      viewport: viewport,
      canvas: canvas
    }).promise;

    page.cleanup();
    return canvas.toDataURL('image/jpeg', 0.8);
  };

  const renderPageFromProxyToBuffer = async (
    pdf: pdfjsLib.PDFDocumentProxy,
    pageIndex: number,
    scale: number = 2.0 // Higher scale for print quality
  ): Promise<ArrayBuffer> => {
    const page = await pdf.getPage(pageIndex + 1);
    
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    canvas.height = viewport.height;
    canvas.width = viewport.width;

    if (!context) throw new Error('Canvas context missing');

    await page.render({
      canvasContext: context,
      viewport: viewport,
      canvas: canvas
    }).promise;

    page.cleanup();
    
    return new Promise<ArrayBuffer>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) {
          blob.arrayBuffer().then(resolve).catch(reject);
        } else {
          reject(new Error('Canvas to Blob failed'));
        }
      }, 'image/png');
    });
  };

  return {
    renderPageToCanvas,
    getDocumentProxy,
    renderPageFromProxy,
    renderPageFromProxyToBuffer
  };
}
