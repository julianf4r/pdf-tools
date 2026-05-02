<script setup lang="ts">
import { ref, computed } from 'vue';
import { VueDraggable } from 'vue-draggable-plus';
import { FileText, X, GripVertical, Download } from 'lucide-vue-next';
import FileUploader from '@/components/FileUploader.vue';
import { usePdfWorker } from '@/composables/usePdfWorker';
import { usePdfRenderer } from '@/composables/usePdfRenderer';
import { useAppStore } from '@/stores/app';
import { messages } from '@/i18n';

interface PdfFile {
  id: string;
  file: File;
  name: string;
  size: number;
  buffer?: ArrayBuffer;
}

const store = useAppStore();
const t = computed(() => messages[store.currentLanguage]);
const { mergePdfs, imagesToPdf } = usePdfWorker();
const { getDocumentProxy, renderPageFromProxyToBuffer } = usePdfRenderer();

const files = ref<PdfFile[]>([]);
const isProcessing = ref(false);
const useSafeMode = ref(false);

const handleFilesSelected = async (selectedFiles: File[]) => {
  for (const file of selectedFiles) {
    if (file.type === 'application/pdf') {
      files.value.push({
        id: crypto.randomUUID(),
        file,
        name: file.name,
        size: file.size
      });
    } else {
      alert(t.value.merge.skipError.replace('{{filename}}', file.name));
    }
  }
};

const removeFile = (id: string) => {
  files.value = files.value.filter(f => f.id !== id);
};

const formatSize = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
};

const handleMerge = async () => {
  if (files.value.length < 2) return;
  
  isProcessing.value = true;
  store.setLoading(true);

  try {
    let resultPdf: Uint8Array;

    if (useSafeMode.value) {
      // Safe Mode: Render all pages to images -> PDF
      const allImageBuffers: ArrayBuffer[] = [];
      const imageTypes: string[] = [];

      for (const pdf of files.value) {
        const buffer = await pdf.file.arrayBuffer();
        const pdfDoc = await getDocumentProxy(buffer);
        const numPages = pdfDoc.numPages;

        for (let i = 0; i < numPages; i++) {
          // Render at good quality (scale 2.0)
          const imgBuffer = await renderPageFromProxyToBuffer(pdfDoc, i, 2.0);
          allImageBuffers.push(imgBuffer);
          imageTypes.push('image/png');
        }

        if (pdfDoc.destroy) pdfDoc.destroy();
      }

      resultPdf = await imagesToPdf(allImageBuffers, { mode: 'original', imageTypes });

    } else {
      // Standard Mode
      const buffers: ArrayBuffer[] = [];
      for (const pdf of files.value) {
        const buffer = await pdf.file.arrayBuffer();
        buffers.push(buffer);
      }
      resultPdf = await mergePdfs(buffers);
    }

    // Download
    const blob = new Blob([resultPdf as any], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `merged_${new Date().toISOString().slice(0,10)}${useSafeMode.value ? '_safe' : ''}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

  } catch (error) {
    console.error('Merge failed', error);
    if (!useSafeMode.value) {
        alert(t.value.merge.standardModeFailed);
        useSafeMode.value = true;
    } else {
        alert(t.value.merge.safeModeAlsoFailed.replace('{{error}}', (error as any).message));
    }
  } finally {
    isProcessing.value = false;
    store.setLoading(false);
  }
};
</script>

<template>
  <div class="space-y-8">
    <div class="text-center">
      <h2 class="text-3xl font-bold text-gray-900 dark:text-white">{{ t.merge.title }}</h2>
      <p class="text-gray-500 dark:text-gray-400 mt-2">{{ t.merge.description }}</p>
    </div>

    <FileUploader 
      accept=".pdf" 
      :multiple="true"
      :label="t.merge.uploadLabel"
      :description="t.merge.uploadDescription"
      @files-selected="handleFilesSelected"
    />

    <div v-if="files.length > 0" class="space-y-4">
      <div class="flex flex-col sm:flex-row justify-between items-center gap-4">
        <h3 class="text-lg font-semibold text-gray-800 dark:text-gray-200">{{ t.merge.title }} ({{ files.length }})</h3>
        
        <div class="flex items-center gap-4">
            <label class="flex items-center gap-2 text-sm text-gray-600 dark:text-gray-300 cursor-pointer select-none bg-yellow-50 dark:bg-yellow-900/20 px-3 py-1.5 rounded border border-yellow-200 dark:border-yellow-700/50">
                <input type="checkbox" v-model="useSafeMode" class="rounded text-blue-600 focus:ring-blue-500 dark:bg-gray-700 dark:border-gray-600" />
                <span class="font-medium">{{ t.merge.safeMode }}</span>
                <span class="text-xs opacity-80 hidden sm:inline">{{ t.merge.safeModeHint }}</span>
            </label>

            <button 
            @click="files = []" 
            class="text-sm text-red-500 hover:text-red-600 dark:text-red-400 dark:hover:text-red-300 px-2 py-1"
            >
            {{ t.common.clearAll }}
            </button>
        </div>
      </div>

      <VueDraggable
        v-model="files"
        :animation="150"
        handle=".drag-handle"
        class="space-y-3"
      >
        <div 
          v-for="item in files" 
          :key="item.id"
          class="flex items-center gap-4 p-4 bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 shadow-sm group"
        >
          <button class="drag-handle cursor-grab active:cursor-grabbing text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">
            <GripVertical class="w-5 h-5" />
          </button>
          
          <FileText class="w-8 h-8 text-red-500" />
          
          <div class="flex-1 min-w-0">
            <p class="text-sm font-medium text-gray-900 dark:text-white truncate">
              {{ item.name }}
            </p>
            <p class="text-xs text-gray-500 dark:text-gray-400">
              {{ formatSize(item.size) }}
            </p>
          </div>

          <button 
            @click="removeFile(item.id)" 
            class="p-2 text-gray-400 hover:text-red-500 dark:hover:text-red-400 transition-colors rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            <X class="w-5 h-5" />
          </button>
        </div>
      </VueDraggable>

      <div class="pt-6 flex justify-center">
        <button
          @click="handleMerge"
          :disabled="files.length < 2 || isProcessing"
          class="flex items-center gap-2 px-8 py-3 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed text-white rounded-xl font-semibold shadow-lg shadow-blue-600/30 transition-all hover:scale-105 active:scale-95"
        >
          <Download v-if="!isProcessing" class="w-5 h-5" />
          <span v-if="isProcessing" class="animate-spin w-5 h-5 border-2 border-white/30 border-t-white rounded-full"></span>
          {{ isProcessing ? t.merge.processing : t.merge.mergeButton }}
        </button>
      </div>
    </div>
  </div>
</template>
