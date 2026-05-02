<script setup lang="ts">
import { ref, computed } from 'vue';
import { FileText, Check, Download, RotateCw } from 'lucide-vue-next';
import FileUploader from '@/components/FileUploader.vue';
import { usePdfRenderer } from '@/composables/usePdfRenderer';
import { usePdfWorker } from '@/composables/usePdfWorker';
import { useAppStore } from '@/stores/app';
import { messages } from '@/i18n';

interface PdfPage {
  index: number;
  thumbnail: string;
  selected: boolean;
}

const store = useAppStore();
const t = computed(() => messages[store.currentLanguage]);
const { getDocumentProxy, renderPageFromProxy, renderPageFromProxyToBuffer } = usePdfRenderer();
const { splitPdf, imagesToPdf } = usePdfWorker();

const currentFile = ref<File | null>(null);
// Removed persistent currentBuffer to avoid detached buffer issues. We read from File blob on demand.
const pages = ref<PdfPage[]>([]);
const isProcessing = ref(false);
const useCompatibilityMode = ref(false);
const lastSelectedIndex = ref<number | null>(null);

const handleFileSelected = async (files: File[]) => {
  if (files.length === 0) return;
  
  const file = files[0];
  if (!file || file.type !== 'application/pdf') {
    alert(t.value.split.uploadPdfPrompt);
    return;
  }

  isProcessing.value = true;
  store.setLoading(true);
  currentFile.value = file;
  pages.value = []; // Clear previous
  lastSelectedIndex.value = null;

  try {
    const buffer = await file.arrayBuffer();
    
    const pdfDoc = await getDocumentProxy(buffer);
    const numPages = pdfDoc.numPages;

    // Render thumbnails
    const newPages: PdfPage[] = [];
    for (let i = 0; i < numPages; i++) {
      const thumb = await renderPageFromProxy(pdfDoc, i, 0.3); // low scale for thumbnail
      newPages.push({
        index: i,
        thumbnail: thumb,
        selected: false
      });
    }
    pages.value = newPages;

  } catch (error) {
    console.error('Error loading PDF', error);
    alert(t.value.split.uploadPdfError);
    currentFile.value = null;
  } finally {
    isProcessing.value = false;
    store.setLoading(false);
  }
};

const handlePageClick = (index: number, event: MouseEvent) => {
  // Prevent default browser selection behavior (blue overlay)
  event.preventDefault(); 
  
  const currentPage = pages.value.find(p => p.index === index);
  if (!currentPage) return;

  // Determine the selection state of the *clicked* item *before* this interaction
  // This state will define the target state for the range selection
  const initialClickedPageState = currentPage.selected;

  if (event.shiftKey && lastSelectedIndex.value !== null) {
    const start = Math.min(lastSelectedIndex.value, index);
    const end = Math.max(lastSelectedIndex.value, index);
    
    // The target state for the range is the inverse of the initial state of the *clicked* page.
    // If the clicked page was initially selected, we want to DESELECT the range.
    // If the clicked page was initially not selected, we want to SELECT the range.
    const targetSelectedState = !initialClickedPageState;

    for (let i = start; i <= end; i++) {
      const page = pages.value.find(p => p.index === i);
      if (page) {
        page.selected = targetSelectedState; 
      }
    }
    // Update last selected only on normal click or start of range
    lastSelectedIndex.value = index; 

  } else {
    // Normal Toggle
    currentPage.selected = !initialClickedPageState; // Toggle its state
    lastSelectedIndex.value = index; // Always update lastSelectedIndex to the last clicked page
  }
};

const selectAll = () => pages.value.forEach(p => p.selected = true);
const deselectAll = () => pages.value.forEach(p => p.selected = false);
const invertSelection = () => pages.value.forEach(p => p.selected = !p.selected);

const extractButtonText = computed(() => {
  const count = pages.value.filter(p => p.selected).length;
  return t.value.split.extractButton.replace('{{count}}', count.toString());
});

const handleSplit = async () => {
  const selectedIndices = pages.value.filter(p => p.selected).map(p => p.index);
  
  if (selectedIndices.length === 0 || !currentFile.value) return;

  isProcessing.value = true;
  store.setLoading(true);

  try {
    let resultPdf: Uint8Array;

    // Always read a FRESH buffer from the file blob. 
    // This ensures we own the buffer and it's not detached from previous ops.
    const buffer = await currentFile.value.arrayBuffer();

    if (useCompatibilityMode.value) {
      // Compatibility mode: Render pages to images -> PDF.
      // We load the document ONCE using a copy of the buffer (implicitly safe as getDocument usually clones/transfers)
      const pdfDoc = await getDocumentProxy(buffer);
      
      const imageBuffers: ArrayBuffer[] = [];
      const imageTypes: string[] = [];
      
      for (const pageIndex of selectedIndices) {
        // Render using the existing proxy. No need to pass buffer again.
        const imgBuffer = await renderPageFromProxyToBuffer(pdfDoc, pageIndex, 2.0);
        imageBuffers.push(imgBuffer);
        imageTypes.push('image/png');
      }
      
      // Note: We don't need to destroy pdfDoc explicitly as GC handles it, 
      // but pdfDoc.destroy() is good practice if available (pdf.js v2+ usually has it).
      if (pdfDoc.destroy) pdfDoc.destroy();

      resultPdf = await imagesToPdf(imageBuffers, { mode: 'original', imageTypes });

    } else {
      // STANDARD MODE: Binary copy
      // Pass the fresh buffer directly.
      resultPdf = await splitPdf(buffer, selectedIndices);
    }

    // Download
    const blob = new Blob([resultPdf as any], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${currentFile.value?.name.replace('.pdf', '')}_extracted${useCompatibilityMode.value ? '_compat' : ''}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

  } catch (error) {
    console.error('Split failed', error);
    if (!useCompatibilityMode.value) {
        alert(t.value.split.standardModeFailed);
        useCompatibilityMode.value = true;
    } else {
        alert(t.value.split.compatibilityModeAlsoFailed.replace('{{error}}', (error as any).message));
    }
  } finally {
    isProcessing.value = false;
    store.setLoading(false);
  }
};

const reset = () => {
  currentFile.value = null;
  pages.value = [];
};
</script>

<template>
  <div class="space-y-8">
    <div class="text-center">
      <h2 class="text-3xl font-bold text-gray-900 dark:text-white">{{ t.split.title }}</h2>
      <p class="text-gray-500 dark:text-gray-400 mt-2">{{ t.split.description }}</p>
    </div>

    <div v-if="!currentFile">
      <FileUploader 
        accept=".pdf" 
        :multiple="false"
        :label="t.split.uploadLabel"
        @files-selected="handleFileSelected"
      />
    </div>

    <div v-else class="space-y-6">
      <div class="flex flex-col sm:flex-row justify-between items-center gap-4 bg-white dark:bg-gray-800 p-4 rounded-xl border border-gray-200 dark:border-gray-700 shadow-sm">
        <div class="flex items-center gap-3">
          <div class="p-2 bg-red-100 dark:bg-red-900/30 rounded-lg text-red-500">
            <FileText class="w-6 h-6" />
          </div>
          <div>
            <h3 class="font-medium text-gray-900 dark:text-white">{{ currentFile.name }}</h3>
            <p class="text-xs text-gray-500">{{ pages.length }} {{ t.common.pages }} {{ t.common.detected }}</p>
          </div>
        </div>
        <div class="flex gap-2">
           <button @click="reset" class="px-4 py-2 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors">
            {{ t.common.changeFile }}
           </button>
        </div>
      </div>

      <!-- Controls -->
      <div class="flex flex-wrap items-center gap-4 justify-between">
        <div class="flex gap-2">
            <button @click="selectAll" class="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700 dark:text-gray-200">{{ t.common.selectAll }}</button>
            <button @click="deselectAll" class="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700 dark:text-gray-200">{{ t.common.deselectAll }}</button>
            <button @click="invertSelection" class="px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded hover:bg-gray-50 dark:hover:bg-gray-700 dark:text-gray-200">{{ t.common.invert }}</button>
        </div>
        
        <label class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none bg-yellow-50 dark:bg-yellow-900/20 px-3 py-1.5 rounded border border-yellow-200 dark:border-yellow-700/50">
            <input type="checkbox" v-model="useCompatibilityMode" class="rounded text-blue-600 focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600" />
            <span class="font-medium">{{ t.split.compatibilityMode }}</span>
            <span class="text-xs opacity-80 hidden sm:inline">{{ t.split.compatibilityModeHint }}</span>
        </label>
      </div>

      <!-- Grid -->
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        <div 
          v-for="page in pages" 
          :key="page.index"
          @click="handlePageClick(page.index, $event)"
          @mousedown.prevent
          class="relative group cursor-pointer select-none"
        >
          <div 
            class="relative rounded-lg overflow-hidden border-2 transition-all duration-200 shadow-sm aspect-[1/1.414]"
            :class="page.selected ? 'border-blue-500 ring-2 ring-blue-500/30' : 'border-gray-200 dark:border-gray-700 hover:border-blue-300'"
          >
            <img :src="page.thumbnail" class="w-full h-full object-contain bg-white" loading="lazy" />
            
            <!-- Overlay -->
            <div 
              class="absolute inset-0 bg-blue-500/10 transition-opacity duration-200"
              :class="page.selected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'"
            ></div>

            <!-- Checkmark -->
            <div 
              class="absolute top-2 right-2 w-6 h-6 rounded-full flex items-center justify-center transition-all duration-200"
              :class="page.selected ? 'bg-blue-500 text-white scale-100' : 'bg-gray-200 dark:bg-gray-700 text-gray-400 scale-90 opacity-0 group-hover:opacity-100 group-hover:scale-100'"
            >
              <Check class="w-4 h-4" />
            </div>

            <!-- Page Number -->
            <div class="absolute bottom-2 left-2 bg-black/60 text-white text-xs px-2 py-1 rounded">
              {{ t.common.pages }} {{ page.index + 1 }}
            </div>
          </div>
        </div>
      </div>

      <div class="pt-6 flex justify-center sticky bottom-6 pointer-events-none">
        <div class="pointer-events-auto shadow-xl rounded-xl">
            <button
            @click="handleSplit"
            :disabled="!pages.some(p => p.selected) || isProcessing"
            class="flex items-center gap-2 px-8 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white rounded-xl font-semibold shadow-lg shadow-blue-600/30 transition-all hover:scale-105 active:scale-95"
            >
            <Download v-if="!isProcessing" class="w-5 h-5" />
            <span v-if="isProcessing" class="animate-spin w-5 h-5 border-2 border-white/30 border-t-white rounded-full"></span>
            {{ isProcessing ? t.split.processing : extractButtonText }}
            </button>
        </div>
      </div>
    </div>
  </div>
</template>
