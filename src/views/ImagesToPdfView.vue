<script setup lang="ts">
import { ref, computed, onUnmounted } from 'vue';
import { VueDraggable } from 'vue-draggable-plus';
import { Image as ImageIcon, X, Download } from 'lucide-vue-next';
import FileUploader from '@/components/FileUploader.vue';
import BaseSelect from '@/components/BaseSelect.vue';
import { usePdfWorker } from '@/composables/usePdfWorker';
import { useAppStore } from '@/stores/app';
import { messages } from '@/i18n';

interface ImageFile {
  id: string;
  file: File;
  url: string;
  name: string;
}

interface PreparedImage {
  buffer: ArrayBuffer;
  type: 'image/jpeg' | 'image/png';
}

const store = useAppStore();
const t = computed(() => messages[store.currentLanguage]);
const { imagesToPdf } = usePdfWorker();

const images = ref<ImageFile[]>([]);
const isProcessing = ref(false);
// Page sizing options
const sizeMode = ref<'original' | 'max' | 'custom'>('original');
const customWidthPx = ref<number>(2480); // default ~A4 width at 96 DPI (approx)
const customHeightPx = ref<number>(3508); // default ~A4 height at 96 DPI (approx)
const preset = ref<'none' | 'A4' | 'A3' | 'Letter'>('none');

// helpers for presets (convert mm -> px at 96 DPI)
const mmToPx = (mm: number) => Math.round((mm * 96) / 25.4);
const applyPreset = (p: string) => {
  if (p === 'A4') {
    customWidthPx.value = mmToPx(210);
    customHeightPx.value = mmToPx(297);
    sizeMode.value = 'custom';
  } else if (p === 'A3') {
    customWidthPx.value = mmToPx(297);
    customHeightPx.value = mmToPx(420);
    sizeMode.value = 'custom';
  } else if (p === 'Letter') {
    // Letter 8.5in x 11in -> mm
    const wMm = 8.5 * 25.4;
    const hMm = 11 * 25.4;
    customWidthPx.value = mmToPx(wMm);
    customHeightPx.value = mmToPx(hMm);
    sizeMode.value = 'custom';
  } else {
    // none
    preset.value = 'none';
  }
};

const handlePresetChange = (val: string | number) => {
  const p = val as 'none' | 'A4' | 'A3' | 'Letter';
  preset.value = p;
  applyPreset(p);
};

const handleFilesSelected = (selectedFiles: File[]) => {
  for (const file of selectedFiles) {
    if (canDecodeImage(file)) {
      const url = URL.createObjectURL(file);
      images.value.push({
        id: crypto.randomUUID(),
        file,
        url,
        name: file.name
      });
    } else {
      alert(t.value.imagesToPdf.skipError.replace('{{filename}}', file.name));
    }
  }
};

const canDecodeImage = (file: File) => {
  return file.type.startsWith('image/') && file.type !== 'image/heic' && file.type !== 'image/heif';
};

const removeImage = (id: string) => {
  const img = images.value.find(i => i.id === id);
  if (img) {
    URL.revokeObjectURL(img.url);
    images.value = images.value.filter(i => i.id !== id);
  }
};

const clearImages = () => {
  images.value.forEach((img) => URL.revokeObjectURL(img.url));
  images.value = [];
};

const loadImageElement = (file: File): Promise<HTMLImageElement> => {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };
    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error(`Could not decode image: ${file.name}`));
    };

    image.src = url;
  });
};

const convertImageToPng = async (file: File): Promise<PreparedImage> => {
  const image = await loadImageElement(file);
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;

  const context = canvas.getContext('2d');
  if (!context || canvas.width <= 0 || canvas.height <= 0) {
    throw new Error(`Invalid image dimensions: ${file.name}`);
  }

  context.drawImage(image, 0, 0);

  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((result) => {
      if (result) {
        resolve(result);
      } else {
        reject(new Error(`Could not convert image: ${file.name}`));
      }
    }, 'image/png');
  });

  return {
    buffer: await blob.arrayBuffer(),
    type: 'image/png',
  };
};

const prepareImageForPdf = async (file: File): Promise<PreparedImage> => {
  if (file.type === 'image/png') {
    return { buffer: await file.arrayBuffer(), type: 'image/png' };
  }

  if (file.type === 'image/jpeg') {
    return { buffer: await file.arrayBuffer(), type: 'image/jpeg' };
  }

  return await convertImageToPng(file);
};

const handleConvert = async () => {
  if (images.value.length === 0) return;

  if (sizeMode.value === 'custom' && (!Number.isFinite(customWidthPx.value) || !Number.isFinite(customHeightPx.value) || customWidthPx.value <= 0 || customHeightPx.value <= 0)) {
    alert(t.value.imagesToPdf.invalidSizeError);
    return;
  }

  isProcessing.value = true;
  store.setLoading(true);

  try {
    // Convert to buffers
    const buffers: ArrayBuffer[] = [];
    const imageTypes: string[] = [];
    for (const img of images.value) {
      const prepared = await prepareImageForPdf(img.file);
      buffers.push(prepared.buffer);
      imageTypes.push(prepared.type);
    }

    // Build options
    const options = { mode: sizeMode.value, imageTypes } as const;
    if (sizeMode.value === 'custom') {
      Object.assign(options, {
        customWidthPx: customWidthPx.value,
        customHeightPx: customHeightPx.value,
      });
    }

    // Call worker
    const resultPdf = await imagesToPdf(buffers, options);

    // Download
    const blob = new Blob([resultPdf as any], { type: 'application/pdf' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `images_converted_${new Date().toISOString().slice(0, 10)}.pdf`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

  } catch (error) {
    console.error('Conversion failed', error);
    alert(t.value.imagesToPdf.conversionError);
  } finally {
    isProcessing.value = false;
    store.setLoading(false);
  }
};

onUnmounted(() => {
  clearImages();
});
</script>

<template>
  <div class="space-y-8">
    <div class="text-center">
      <h2 class="text-3xl font-bold text-gray-900 dark:text-white">{{ t.imagesToPdf.title }}</h2>
      <p class="text-gray-500 dark:text-gray-400 mt-2">{{ t.imagesToPdf.description }}</p>
    </div>

    <FileUploader accept="image/*" :multiple="true" :label="t.imagesToPdf.uploadLabel"
      :description="t.imagesToPdf.uploadDescription" @files-selected="handleFilesSelected" />

    <div v-if="images.length > 0" class="space-y-4">
      <div class="flex justify-between items-center">
        <h3 class="text-lg font-semibold text-gray-800 dark:text-gray-200">{{ t.imagesToPdf.images }} ({{ images.length
          }})
        </h3>
        <button @click="clearImages" class="text-sm text-red-500 hover:text-red-600 dark:text-red-400">
          {{ t.common.clearAll }}
        </button>
      </div>

      <!-- Page size options -->
      <div class="bg-white dark:bg-gray-800 p-4 rounded-lg border border-gray-200 dark:border-gray-700">
        <div class="flex flex-wrap items-center gap-4">
          <div class="flex items-center gap-3">
            <label class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t.imagesToPdf.sizeModeLabel }}</label>
            <BaseSelect :model-value="sizeMode"
              @update:model-value="(val) => sizeMode = val as 'original' | 'max' | 'custom'" :options="[
                { label: t.imagesToPdf.sizeOriginal, value: 'original' },
                { label: t.imagesToPdf.sizeMax, value: 'max' },
                { label: t.imagesToPdf.sizeCustom, value: 'custom' }
              ]" />
          </div>

          <template v-if="sizeMode === 'custom'">
            <div class="flex flex-wrap items-center gap-6">
              <div class="flex items-center gap-3">
                <label class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t.imagesToPdf.sizePresetLabel
                  }}</label>
                <BaseSelect :model-value="preset" @update:model-value="handlePresetChange" :options="[
                  { label: t.imagesToPdf.presetNone || 'None', value: 'none' },
                  { label: 'A4', value: 'A4' },
                  { label: 'A3', value: 'A3' },
                  { label: 'Letter', value: 'Letter' }
                ]" />
              </div>

              <div class="flex items-center gap-4 border-l border-gray-200 dark:border-gray-700 pl-4">
                <div class="flex items-center gap-3">
                  <label class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t.imagesToPdf.customWidthLabel
                    }}</label>
                  <div class="relative">
                    <input type="number" v-model.number="customWidthPx" min="1" step="1"
                      class="w-24 pl-3 pr-6 py-2.5 rounded-lg border-0 ring-1 ring-inset ring-gray-300 dark:ring-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-sm transition-shadow dark:[color-scheme:dark]" />
                    <span
                      class="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">px</span>
                  </div>
                </div>
                <div class="flex items-center gap-3">
                  <label class="text-sm font-medium text-gray-700 dark:text-gray-300">{{ t.imagesToPdf.customHeightLabel
                    }}</label>
                  <div class="relative">
                    <input type="number" v-model.number="customHeightPx" min="1" step="1"
                      class="w-24 pl-3 pr-6 py-2.5 rounded-lg border-0 ring-1 ring-inset ring-gray-300 dark:ring-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500 shadow-sm transition-shadow dark:[color-scheme:dark]" />
                    <span
                      class="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-gray-400 pointer-events-none">px</span>
                  </div>
                </div>
              </div>
            </div>
          </template>
        </div>
      </div>

      <VueDraggable v-model="images" :animation="150" class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-4"
        handle=".drag-handle">
        <div v-for="(img, index) in images" :key="img.id"
          class="relative group aspect-[3/4] bg-gray-100 dark:bg-gray-800 rounded-xl overflow-hidden border border-gray-200 dark:border-gray-700 shadow-sm">
          <img :src="img.url" class="w-full h-full object-cover drag-handle cursor-move" />

          <div class="absolute inset-x-0 bottom-0 bg-black/60 text-white p-2 text-xs truncate">
            {{ index + 1 }}. {{ img.name }}
          </div>

          <button @click="removeImage(img.id)"
            class="absolute top-2 right-2 p-1.5 bg-white/90 text-gray-600 hover:text-red-500 rounded-full shadow-sm opacity-0 group-hover:opacity-100 transition-opacity">
            <X class="w-4 h-4" />
          </button>
        </div>
      </VueDraggable>

      <div class="pt-6 flex justify-center">
        <button @click="handleConvert" :disabled="images.length === 0 || isProcessing"
          class="flex items-center gap-2 px-8 py-3 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 disabled:cursor-not-allowed text-white rounded-xl font-semibold shadow-lg shadow-purple-600/30 transition-all hover:scale-105 active:scale-95">
          <Download v-if="!isProcessing" class="w-5 h-5" />
          <span v-if="isProcessing"
            class="animate-spin w-5 h-5 border-2 border-white/30 border-t-white rounded-full"></span>
          {{ isProcessing ? t.imagesToPdf.processing : t.imagesToPdf.convertButton }}
        </button>
      </div>
    </div>
  </div>
</template>
