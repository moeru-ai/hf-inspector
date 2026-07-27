<script setup lang="ts">
import { Input, TransitionVertical } from '@proj-airi/ui'
import { useClipboard } from '@vueuse/core'
import { computed, ref } from 'vue'

// --- Component Interface & State ---

type ModelFormat = 'Sharded Safetensors' | 'ONNX' | 'Single File' | 'Unknown'
type ItemType = 'model' | 'dataset' | 'local' | 'unknown'
type InspectorMode = 'huggingface' | 'local'

interface LocalMetadata {
  label: string
  value: string
}

interface CacheItem {
  id: string
  type: ItemType
  name: string
  path: string
  size: number
  snapshot?: string
  architectures?: string[]
  modelFormat?: ModelFormat
  mainFile?: {
    path: string
    oid: string
  }
  category?: string
  fileFormat?: string
  folderPath?: string
  folderFileCount?: number
  folderSize?: number
  folderFormats?: string[]
  localMetadata?: LocalMetadata[]
  error?: string
}

const isLoading = ref(false)
const error = ref<string | null>(null)
const cacheItems = ref<CacheItem[]>([])
const selectedItemId = ref<string | null>(null)
const searchTerm = ref('')
const isDragging = ref(false)
const fileInputRef = ref<HTMLInputElement | null>(null)
const inspectorMode = ref<InspectorMode>('huggingface')

// --- VueUse Composables ---
const { copy, copied, text: copiedText, isSupported } = useClipboard({ legacy: true, source: '' })

// --- Request Queue for Rate Limiting ---
const requestQueue = ref<(() => Promise<void>)[]>([])
const activeRequests = ref(0)
const MAX_CONCURRENT_REQUESTS = 3 // Limit concurrent requests to be polite to the API

// --- Computed Properties ---

const filteredItems = computed(() => {
  if (!searchTerm.value) {
    return cacheItems.value
  }
  return cacheItems.value.filter(item =>
    item.name.toLowerCase().includes(searchTerm.value.toLowerCase()),
  )
})

const totalSize = computed(() => {
  return cacheItems.value.reduce((acc, item) => acc + item.size, 0)
})

const modeLabel = computed(() => inspectorMode.value === 'huggingface' ? 'Hugging Face cache' : 'Local model library')

// --- Event Handlers & Logic ---

function triggerFileSelect() {
  fileInputRef.value?.click()
}

function onFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  if (input.files && input.files.length > 0) {
    handleFileChange(Array.from(input.files))
  }
  if (input)
    input.value = ''
}

function onDrop(event: DragEvent) {
  isDragging.value = false
  if (event.dataTransfer?.files && event.dataTransfer.files.length > 0) {
    handleFileChange(Array.from(event.dataTransfer.files))
  }
}

async function handleFileChange(fileList: File[]) {
  if (fileList.length === 0)
    return

  isLoading.value = true
  error.value = null
  cacheItems.value = []
  requestQueue.value = [] // Clear any previous queue

  const isHubDir = fileList.some(f => getRelativePath(f).includes('/blobs/'))
  inspectorMode.value = isHubDir ? 'huggingface' : 'local'

  try {
    // Phase 1: Local processing. Fast and offline.
    const items = isHubDir ? await processCacheData(fileList) : await processLocalModelData(fileList)
    cacheItems.value = items

    // Phase 2: Enqueue remote resolution tasks for each model.
    items.forEach((item) => {
      if (item.type === 'model' && item.snapshot) {
        const task = async () => {
          try {
            const rootFiles = await fetchRepoTree(item.name, item.snapshot!)
            if (!rootFiles)
              throw new Error('Could not fetch repo tree')

            // Resolve config.json to get architectures
            const configEntry = rootFiles.find(f => f.path === 'config.json')
            if (configEntry) {
              const configOid = configEntry.lfs?.oid || configEntry.oid
              const configFile = fileList.find(f => f.webkitRelativePath.includes(`/blobs/${configOid}`))
              const configFileContent = await configFile.text()
              try {
                if (configFile && configFileContent) {
                  const configJson = JSON.parse(configFileContent)
                  item.architectures = configJson.architectures || ['Not specified']
                }
                else {
                  item.architectures = ['Config blob not in cache']
                }
              }
              catch (e) {
                console.error('Failed to parse config.json for', item.name, configFileContent, e)
                throw e
              }
            }
            else {
              item.architectures = ['No config.json in repo']
            }

            // --- Advanced Model File Discovery ---
            const allFiles = [...rootFiles]
            const onnxDir = rootFiles.find(f => f.path === 'onnx' && f.type === 'directory')
            if (onnxDir) {
              const onnxFiles = await fetchRepoTree(item.name, item.snapshot!, 'onnx')
              if (onnxFiles) {
                // Prepend the directory to the path for correct symlink generation
                allFiles.push(...onnxFiles.map(f => ({ ...f, path: `onnx/${f.path}` })))
              }
            }

            // Priority 1: Find sharded safetensors index
            let mainFileEntry = allFiles.find(f => f.path.endsWith('model.safetensors.index.json'))
            if (mainFileEntry) {
              item.modelFormat = 'Sharded Safetensors'
            }
            else {
              // Priority 2: Find a "base" ONNX model
              const onnxBlacklist = ['_quantized', '_fp16', '_int8', '_merged', '_bnb4', '_q4', '_uint8']
              mainFileEntry = allFiles.find(f => f.path.endsWith('.onnx') && !onnxBlacklist.some(suffix => f.path.includes(suffix)))
              if (mainFileEntry) {
                item.modelFormat = 'ONNX'
              }
              else {
                // Priority 3: Fallback to any model file
                const modelFileExtensions = ['.safetensors', '.onnx', '.bin']
                mainFileEntry = allFiles.find(f => modelFileExtensions.some(ext => f.path.endsWith(ext)))
                item.modelFormat = mainFileEntry ? 'Single File' : 'Unknown'
              }
            }

            if (mainFileEntry) {
              // CRITICAL: Use LFS oid if it exists, otherwise fallback to git oid
              const blobOid = mainFileEntry.lfs?.oid || mainFileEntry.oid
              item.mainFile = { path: mainFileEntry.path, oid: blobOid }
            }
          }
          catch (e) {
            item.error = (e as Error).message
            item.architectures = ['Resolution failed']
          }
        }
        requestQueue.value.push(task)
      }
    })
    processQueue() // Start processing the queue
  }
  catch (e: any) {
    error.value = `An error occurred while processing: ${e.message}`
  }
  finally {
    isLoading.value = false
  }
}

// --- Queue Processing Logic ---
async function processQueue() {
  while (activeRequests.value < MAX_CONCURRENT_REQUESTS && requestQueue.value.length > 0) {
    activeRequests.value++
    const task = requestQueue.value.shift()
    if (task) {
      try {
        await task()
      }
      catch (e) {
        console.error('A task in the queue failed:', e)
      }
      finally {
        activeRequests.value--
        // Add a small delay between requests to be polite to the API
        await new Promise(resolve => setTimeout(resolve, 200))
        processQueue() // Try to process the next item
      }
    }
  }
}

function toggleItem(id: string) {
  selectedItemId.value = selectedItemId.value === id ? null : id
}

// --- Data Processing & API ---

interface RepoFile {
  path: string
  oid: string
  type: 'file' | 'directory'
  size?: number
  lfs?: {
    oid: string
    size: number
    pointerSize: number
  }
}

async function fetchRepoTree(repoName: string, revision: string, subfolder?: string): Promise<RepoFile[] | null> {
  let url = `https://huggingface.co/api/models/${repoName}/tree/${revision}`
  if (subfolder) {
    url += `/${subfolder}`
  }
  try {
    const response = await fetch(url)
    if (!response.ok)
      return null
    return await response.json()
  }
  catch {
    return null
  }
}

async function processCacheData(fileList: File[]): Promise<CacheItem[]> {
  const fileTree: Record<string, File[]> = {}
  for (const file of fileList) {
    const pathParts = getRelativePath(file).split('/')
    if (pathParts.length < 2)
      continue
    const rootDir = pathParts[1]
    if (!fileTree[rootDir])
      fileTree[rootDir] = []
    fileTree[rootDir].push(file)
  }

  const processedItems: CacheItem[] = []
  for (const dirName in fileTree) {
    if (!dirName.startsWith('models--') && !dirName.startsWith('datasets--'))
      continue
    const itemFiles = fileTree[dirName]
    const { type, name } = parseName(dirName)
    let totalSize = 0
    let snapshot: string | undefined
    let itemError: string | undefined
    try {
      const blobFiles = itemFiles.filter(f => getRelativePath(f).includes('/blobs/'))
      totalSize = blobFiles.reduce((sum, f) => sum + f.size, 0)
      const refFile = itemFiles.find(f => getRelativePath(f).endsWith('/refs/main'))
      if (refFile)
        snapshot = (await refFile.text()).trim()
    }
    catch (e: any) { itemError = e.message }
    processedItems.push({ id: dirName, type, name, path: dirName, size: totalSize, snapshot, error: itemError })
  }
  return processedItems.sort((a, b) => b.size - a.size)
}

const modelExtensions = new Set(['safetensors', 'ckpt', 'bin', 'pt', 'pth', 'gguf', 'onnx'])
const comfyCategories = new Set(['checkpoints', 'loras', 'vae', 'unet', 'clip', 'clip_vision', 'controlnet', 'upscale_models', 'embeddings', 'diffusion_models', 'text_encoders'])

function getRelativePath(file: File) {
  return (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name
}

async function processLocalModelData(fileList: File[]): Promise<CacheItem[]> {
  const items: CacheItem[] = []
  const folders = new Map<string, { fileCount: number, size: number, formats: Set<string> }>()
  const configMetadata = new Map<string, LocalMetadata[]>()

  for (const file of fileList) {
    const relativePath = getRelativePath(file)
    if (!['config.json', 'configuration.json'].includes(file.name) || file.size > 1024 * 1024)
      continue

    try {
      configMetadata.set(getFolderPath(relativePath), getLocalMetadata(JSON.parse(await file.text())))
    }
    catch {
      // Configuration files are optional and may not be JSON.
    }
  }

  for (const file of fileList) {
    const relativePath = getRelativePath(file)
    const pathParts = relativePath.split('/')
    const extension = file.name.split('.').pop()?.toLowerCase() || 'unknown'
    const modelsIndex = pathParts.lastIndexOf('models')
    const category = modelsIndex >= 0 ? pathParts[modelsIndex + 1] : pathParts.length > 2 ? pathParts[1] : undefined
    const folderPath = getFolderPath(relativePath)

    if (!modelExtensions.has(extension))
      continue

    const folder = folders.get(folderPath) || { fileCount: 0, size: 0, formats: new Set<string>() }
    folder.fileCount++
    folder.size += file.size
    folder.formats.add(extension.toUpperCase())
    folders.set(folderPath, folder)

    items.push({
      id: relativePath,
      type: 'local',
      name: file.name,
      path: relativePath,
      size: file.size,
      category: category && comfyCategories.has(category) ? category : category || 'other',
      fileFormat: extension.toUpperCase(),
      folderPath,
    })
  }

  items.forEach((item) => {
    const folder = folders.get(item.folderPath!)
    if (!folder)
      return
    item.folderFileCount = folder.fileCount
    item.folderSize = folder.size
    item.folderFormats = [...folder.formats].sort()
    item.localMetadata = configMetadata.get(item.folderPath!)
  })

  return items.sort((a, b) => b.size - a.size)
}

function getFolderPath(path: string) {
  return path.split('/').slice(0, -1).join('/')
}

function getLocalMetadata(config: unknown): LocalMetadata[] {
  if (!config || typeof config !== 'object' || Array.isArray(config))
    return []

  const data = config as Record<string, unknown>
  const metadata: LocalMetadata[] = []
  const add = (label: string, value: unknown) => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean')
      metadata.push({ label, value: String(value) })
    else if (Array.isArray(value) && value.every(entry => typeof entry === 'string'))
      metadata.push({ label, value: value.join(', ') })
  }

  add('Architectures', data.architectures)
  add('Architecture', data.architecture || data.model_type)
  add('Version', data.version)
  add('Sample rate', data.sample_rate)
  add('Quantization', data.quantize_bits && `${data.quantize_bits}-bit`)
  return metadata
}

// --- Utility Functions ---

function getHuggingFaceUrl(item: CacheItem) {
  const base = 'https://huggingface.co'
  return item.type === 'dataset' ? `${base}/datasets/${item.name}` : `${base}/${item.name}`
}

// Implements your rule: ${models--...}${repo_id}/snapshots/${ref}/${main_file}
function getSymlinkPath(item: CacheItem) {
  if (!item.snapshot)
    return null
  let path = `${item.path}/snapshots/${item.snapshot}`
  if (item.mainFile)
    path += `/${item.mainFile.path}`

  return path
}

// Implements your rule: ${models--...}${repo_id}/blobs/${main_file_blob_hash}
function getActualPath(item: CacheItem) {
  if (!item.mainFile)
    return null
  return `${item.path}/blobs/${item.mainFile.oid}`
}

function parseName(dirName: string): { type: CacheItem['type'], name: string } {
  if (dirName.startsWith('models--'))
    return { type: 'model', name: dirName.substring('models--'.length).replace(/--/g, '/') }
  if (dirName.startsWith('datasets--'))
    return { type: 'dataset', name: dirName.substring('datasets--'.length).replace(/--/g, '/') }
  return { type: 'unknown', name: dirName }
}

function formatBytes(bytes: number, decimals = 2) {
  if (!+bytes)
    return '0 Bytes'
  const k = 1024
  const dm = decimals < 0 ? 0 : decimals
  const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${Number.parseFloat((bytes / k ** i).toFixed(dm))} ${sizes[i]}`
}
</script>

<template>
  <div class="h-full max-w-full w-full flex flex-col gap-6 p-4 lg:p-8 sm:p-6">
    <!-- Initial State: Directory Selector -->
    <div v-if="cacheItems.length === 0 && !isLoading" class="h-full flex flex-1 flex-col items-center justify-center gap-4">
      <p class="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        Drop a Hugging Face <code class="rounded bg-neutral-200 p-1 dark:bg-neutral-800">hub</code> cache or a local model folder (such as <code class="rounded bg-neutral-200 p-1 dark:bg-neutral-800">ComfyUI/models</code>) below to get started.
      </p>
      <label
        class="relative h-full max-w-4xl min-h-[200px] w-full flex flex-col cursor-pointer items-center justify-center border-2 rounded-xl border-dashed p-6 opacity-95 shadow-sm transition-all duration-300 hover:shadow-md"
        :class="[isDragging ? 'border-primary-400 bg-primary-50/5 dark:border-primary-600 dark:bg-primary-900/5' : 'border-neutral-100 bg-white/60 hover:border-primary-300 dark:border-neutral-700 dark:bg-black/30 dark:hover:border-primary-700']"
        @dragover.prevent="isDragging = true" @dragleave.prevent="isDragging = false" @drop.prevent="onDrop"
      >
        <input type="file" webkitdirectory class="absolute inset-0 h-full w-full opacity-0" @change="onFileSelect">
        <div class="pointer-events-none flex flex-col items-center" :class="[isDragging ? 'text-primary-500 dark:text-primary-400' : 'text-neutral-400 dark:text-neutral-500']">
          <div class="i-solar:upload-square-line-duotone mb-2 text-5xl" />
          <p class="text-center text-lg font-medium">Select or Drop Directory</p>
          <p class="text-center text-sm">{{ isDragging ? 'Release to inspect' : 'Click to select a cache or model folder' }}</p>
        </div>
      </label>
    </div>

    <!-- Loading State -->
    <div v-if="isLoading" class="flex flex-1 flex-col items-center justify-center p-8 text-center">
      <div class="i-solar:hourglass-line-duotone mx-auto animate-spin text-4xl text-primary-500" />
      <p class="mt-4 text-neutral-600 dark:text-neutral-400">
        Processing directory...
      </p>
    </div>

    <!-- Error State -->
    <div v-if="error" class="border-l-4 border-red-500 rounded bg-red-100 p-4 text-red-700" role="alert">
      <p class="font-bold">
        Error
      </p>
      <p>{{ error }}</p>
    </div>

    <!-- Results State -->
    <div v-if="cacheItems.length > 0" class="flex flex-col gap-4">
      <div class="flex flex-col items-center justify-between gap-4 sm:flex-row">
        <div max-w-full w-full>
          <label flex="~ col gap-1" w-full>
            <Input
              v-model="searchTerm"
              placeholder="Search..."
              class="w-full"
              :required="false"
            />
            <div class="w-full whitespace-nowrap text-right text-sm text-neutral-400 sm:w-auto dark:text-neutral-700">
              {{ modeLabel }}: <strong>{{ filteredItems.length }}</strong> items. Total size: <strong>{{ formatBytes(totalSize) }}</strong>
            </div>
          </label>
        </div>
      </div>

      <div v-auto-animate class="grid grid-cols-1 gap-2 2xl:grid-cols-4 lg:grid-cols-2 xl:grid-cols-3" max-h="80dvh" overflow-y-auto>
        <div
          v-for="item in filteredItems" :key="item.id"
          class="h-fit flex flex-col overflow-hidden border border-2 border-neutral-100 rounded-xl bg-neutral-200/50 shadow-sm transition-all duration-200 dark:border-neutral-800 hover:border-primary-300 dark:bg-neutral-800/50 hover:shadow-md dark:hover:border-primary-700"
        >
          <div class="flex-grow rounded-b-xl bg-white p-3 dark:bg-neutral-900" @click="toggleItem(item.id)">
            <div class="relative cursor-pointer gap-3">
              <div class="min-w-0 flex flex-1 flex-col gap-2">
                <!-- Line 1: Category Icon & Badge -->
                <div class="flex items-center gap-1">
                  <div class="flex-shrink-0">
                    <div v-if="item.type === 'model'" class="i-solar:box-minimalistic-bold-duotone text-xl text-blue-500" />
                    <div v-else-if="item.type === 'dataset'" class="i-solar:database-bold-duotone text-xl text-green-500" />
                    <div v-else-if="item.type === 'local'" class="i-solar:folder-with-files-bold-duotone text-xl text-purple-500" />
                  </div>
                  <span :class="{ 'bg-blue-100 text-blue-800 dark:bg-blue-900/50 dark:text-blue-300': item.type === 'model', 'bg-green-100 text-green-800 dark:bg-green-900/50 dark:text-green-300': item.type === 'dataset', 'bg-purple-100 text-purple-800 dark:bg-purple-900/50 dark:text-purple-300': item.type === 'local' }" class="rounded-full px-2.5 py-1 text-xs font-semibold capitalize">{{ item.type === 'local' ? `Folder: ${item.category || 'other'}` : item.type }}</span>
                </div>

                <!-- Line 2: Model ID & Actions -->
                <div class="grid grid-cols-[1fr_auto] min-w-0 gap-2 pl-7">
                  <p class="truncate text-sm text-neutral-800 font-mono dark:text-neutral-200" :title="item.name">
                    {{ item.name }}
                  </p>
                  <div class="flex flex-shrink-0 items-center gap-2">
                    <button v-if="isSupported" title="Copy ID" class="text-neutral-400 transition-colors hover:text-primary-500 dark:hover:text-primary-400" @click.stop="copy(item.name)">
                      <div v-if="copied && copiedText === item.name" class="i-solar:check-read-line-duotone text-green-500" />
                      <div v-else class="i-solar:copy-bold-duotone" />
                    </button>
                    <a v-if="item.type !== 'local'" :href="getHuggingFaceUrl(item)" target="_blank" rel="noopener noreferrer" title="Open on Hugging Face" class="text-neutral-400 transition-colors hover:text-primary-500 dark:hover:text-primary-400" @click.stop>
                      <div class="i-solar:square-arrow-right-up-line-duotone" />
                    </a>
                  </div>
                </div>

                <!-- Line 3: Metadata Chips -->
                <div class="flex flex-wrap items-center gap-2 pl-7 text-xs text-neutral-600 dark:text-neutral-400">
                  <div class="flex items-center gap-1.5">
                    <div class="i-solar:diskette-line-duotone" />
                    <span>{{ formatBytes(item.size) }}</span>
                  </div>
                  <div v-if="item.fileFormat" class="min-w-0 flex items-center gap-1.5 rounded-full bg-neutral-100 px-2 py-1 dark:bg-neutral-800">
                    <div class="i-solar:file-text-line-duotone" />
                    <span class="truncate">{{ item.fileFormat }}</span>
                  </div>
                  <!-- Chip for model format -->
                  <div v-if="item.modelFormat && item.modelFormat !== 'Unknown'" class="min-w-0 flex items-center gap-1.5 rounded-full bg-neutral-100 px-2 py-1 dark:bg-neutral-800" :title="item.modelFormat">
                    <div class="i-solar:structure-bold-duotone" />
                    <span class="truncate">{{ item.modelFormat }}</span>
                  </div>
                  <!-- Chip for successfully fetched architecture -->
                  <div v-if="item.type === 'model' && item.architectures && !['Not specified', 'No config.json in repo', 'Config blob not in cache', 'Resolution failed'].includes(item.architectures[0])" class="min-w-0 flex items-center gap-1.5 rounded-full bg-neutral-100 px-2 py-1 dark:bg-neutral-800" :title="item.architectures[0]">
                    <div class="i-solar:cpu-bolt-line-duotone" />
                    <span class="truncate">{{ item.architectures[0] }}</span>
                  </div>
                  <!-- Chip for loading state -->
                  <div v-else-if="item.type === 'model' && !item.architectures" class="min-w-0 flex animate-pulse items-center gap-1.5 rounded-full bg-neutral-100 px-2 py-1 dark:bg-neutral-800" title="Resolving metadata...">
                    <div class="i-solar:cpu-bolt-line-duotone" />
                    <span class="truncate">...</span>
                  </div>
                  <!-- Chip for internal processing error -->
                  <div v-if="item.error" class="flex items-center gap-1.5 rounded-full bg-red-100 px-2 py-1 text-red-600 font-medium dark:bg-red-900/50 dark:text-red-300">
                    <div class="i-solar:danger-triangle-line-duotone" />
                    <span>Error</span>
                  </div>
                  <div class="i-solar:alt-arrow-down-linear text-neutral-500 transition-transform duration-200" :class="{ 'rotate-180': selectedItemId === item.id }" />
                </div>
              </div>
            </div>
          </div>

          <TransitionVertical>
            <div v-if="selectedItemId === item.id" class="px-4 py-3 text-xs dark:border-neutral-800">
              <div class="grid grid-cols-1 gap-x-4 gap-y-2">
                <template v-if="item.type === 'local'">
                  <div class="grid grid-cols-[max-content_1fr_auto] items-center gap-x-2">
                    <strong class="text-neutral-600 dark:text-neutral-400">Relative Path:</strong>
                    <code class="truncate break-all font-mono" :title="item.path">{{ item.path }}</code>
                    <button v-if="isSupported" title="Copy Relative Path" class="text-neutral-400 transition-colors hover:text-primary-500 dark:hover:text-primary-400" @click.stop="copy(item.path)">
                      <div v-if="copied && copiedText === item.path" class="i-solar:check-read-line-duotone text-green-500" />
                      <div v-else class="i-solar:copy-bold-duotone" />
                    </button>
                  </div>
                  <div class="grid grid-cols-[max-content_1fr] items-center gap-x-2">
                    <strong class="text-neutral-600 dark:text-neutral-400">Path:</strong>
                    <code class="break-all font-mono">{{ item.folderPath || item.category || 'other' }}</code>
                  </div>
                  <div v-if="item.folderFileCount && item.folderSize !== undefined" class="grid grid-cols-[max-content_1fr] items-center gap-x-2">
                    <strong class="text-neutral-600 dark:text-neutral-400">Contents:</strong>
                    <span>{{ item.folderFileCount }} model {{ item.folderFileCount === 1 ? 'file' : 'files' }} · {{ formatBytes(item.folderSize) }} · {{ item.folderFormats?.join(', ') }}</span>
                  </div>
                  <template v-for="metadata in item.localMetadata" :key="metadata.label">
                    <div class="grid grid-cols-[max-content_1fr] items-center gap-x-2">
                      <strong class="text-neutral-600 dark:text-neutral-400">{{ metadata.label }}:</strong>
                      <span class="break-all font-mono">{{ metadata.value }}</span>
                    </div>
                  </template>
                </template>
                <template v-else>
                  <!-- Symlink Path -->
                  <div class="grid grid-cols-[max-content_1fr_auto] items-center gap-x-2">
                    <strong class="text-neutral-600 dark:text-neutral-400">Symlink Path:</strong>
                    <code v-if="getSymlinkPath(item)" class="truncate break-all font-mono" :title="getSymlinkPath(item) || ''">{{ getSymlinkPath(item) }}</code>
                    <span v-else class="text-neutral-500 font-mono">Resolving...</span>
                    <button v-if="isSupported && getSymlinkPath(item)" title="Copy Symlink Path" class="text-neutral-400 transition-colors hover:text-primary-500 dark:hover:text-primary-400" @click.stop="copy(getSymlinkPath(item) || '')">
                      <div v-if="copied && copiedText === getSymlinkPath(item)" class="i-solar:check-read-line-duotone text-green-500" />
                      <div v-else class="i-solar:copy-bold-duotone" />
                    </button>
                  </div>
                  <!-- Actual Path -->
                  <div class="grid grid-cols-[max-content_1fr_auto] items-center gap-x-2">
                    <strong class="text-neutral-600 dark:text-neutral-400">Actual Path:</strong>
                    <code v-if="getActualPath(item)" class="truncate break-all font-mono" :title="getActualPath(item) || ''">{{ getActualPath(item) }}</code>
                    <span v-else class="text-neutral-500 font-mono">Resolving...</span>
                    <button v-if="isSupported && getActualPath(item)" title="Copy Actual Path" class="text-neutral-400 transition-colors hover:text-primary-500 dark:hover:text-primary-400" @click.stop="copy(getActualPath(item) || '')">
                      <div v-if="copied && copiedText === getActualPath(item)" class="i-solar:check-read-line-duotone text-green-500" />
                      <div v-else class="i-solar:copy-bold-duotone" />
                    </button>
                  </div>
                  <!-- Snapshot -->
                  <div class="grid grid-cols-[max-content_1fr] items-center gap-x-2">
                    <strong class="text-neutral-600 dark:text-neutral-400">Snapshot:</strong>
                    <code v-if="item.snapshot" class="break-all font-mono">{{ item.snapshot }}</code>
                    <span v-else class="text-neutral-500">N/A</span>
                  </div>
                  <!-- Architectures -->
                  <template v-if="item.type === 'model'">
                    <div class="grid grid-cols-[max-content_1fr] items-start gap-x-2">
                      <strong class="text-neutral-600 dark:text-neutral-400">Architectures:</strong>
                      <div>
                        <ul v-if="item.architectures && !['Not specified', 'No config.json in repo', 'Config blob not in cache', 'Resolution failed'].includes(item.architectures[0])" class="list-disc list-inside">
                          <li v-for="arch in item.architectures" :key="arch" class="font-mono">
                            {{ arch }}
                          </li>
                        </ul>
                        <span v-else-if="item.architectures" class="text-neutral-500 font-mono">{{ item.architectures[0] }}</span>
                        <span v-else class="text-neutral-500">Resolving...</span>
                      </div>
                    </div>
                  </template>
                  <!-- Error -->
                  <template v-if="item.error">
                    <div class="grid grid-cols-[max-content_1fr] items-start gap-x-2">
                      <strong class="text-red-500">Error Details:</strong>
                      <p class="text-red-500 font-mono">
                        {{ item.error }}
                      </p>
                    </div>
                  </template>
                </template>
              </div>
            </div>
          </TransitionVertical>
        </div>
      </div>
    </div>

    <!-- Floating Action Button -->
    <button
      v-if="cacheItems.length > 0" class="fixed bottom-6 right-6 z-50 h-14 w-14 flex items-center justify-center border-2 border-neutral-100 rounded-xl border-solid bg-white/10 text-neutral-900 backdrop-blur-md transition-transform duration-200 hover:scale-105 dark:border-transparent dark:bg-neutral-900/80 hover:bg-primary-200/20 dark:text-white dark:shadow-lg focus:outline-none focus:ring-4 focus:ring-primary-300 dark:hover:bg-neutral-900/90 dark:focus:ring-primary-800"
      title="Select another directory"
      @click="triggerFileSelect"
    >
      <div class="i-solar:folder-with-files-line-duotone text-2xl" />
    </button>

    <input ref="fileInputRef" type="file" webkitdirectory class="hidden" @change="onFileSelect">
  </div>
</template>
