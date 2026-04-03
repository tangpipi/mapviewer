<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import MemoryGraph from './components/MemoryGraph.vue'
import { parseIarMap, type MemoryNode } from './parser/iar-parser'

const mapData = ref<MemoryNode[] | null>(null)
const errorMessage = ref('')
const thresholdError = ref('')
const lastMapText = ref('')
const loadedFileName = ref('')
const linkerName = ref('')
const linkerTime = ref('')
const outputFilePath = ref('')
const searchQuery = ref('')
const searchByName = ref(true)
const searchByAddress = ref(true)
const searchBySize = ref(true)
const searchCaseSensitive = ref(false)
const searchWholeWord = ref(false)
const searchRegex = ref(false)
const mergeThresholdInput = ref('64B')

const formatHex = (value: number) => `0x${value.toString(16).toUpperCase()}`
const formatPercent = (value: number) => `${(value * 100).toFixed(2)}%`
const formatBytes = (value: number) => `${formatHex(value)} (${value} B)`

function parseByteSizeInput(value: string): number | null {
  const normalized = value.trim().replace(/\s+/g, '')
  if (!normalized) {
    return null
  }

  if (/^0x[0-9a-f]+$/i.test(normalized)) {
    return parseInt(normalized, 16)
  }

  const match = normalized.match(/^(\d+(?:\.\d+)?)(B|BYTES|KB|MB)?$/i)
  if (!match) {
    return null
  }

  const num = Number.parseFloat(match[1])
  if (!Number.isFinite(num) || num < 0) {
    return null
  }

  const unit = (match[2] ?? 'B').toUpperCase()
  switch (unit) {
    case 'B':
    case 'BYTES':
      return Math.round(num)
    case 'KB':
      return Math.round(num * 1024)
    case 'MB':
      return Math.round(num * 1024 * 1024)
    default:
      return null
  }
}

const mergeThresholdBytes = computed(() => parseByteSizeInput(mergeThresholdInput.value))

function extractIarHeaderMetadata(text: string): { linkerName: string; linkerTime: string; outputFile: string } {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  let linker = ''
  let buildTime = ''
  let outputFile = ''

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]
    const trimmed = raw.trim()

    if (!linker && /^#\s*IAR ELF Linker/i.test(trimmed)) {
      const value = trimmed.replace(/^#\s*/, '').trim()
      const timeMatch = value.match(/(\d{1,2}\/[A-Za-z]{3}\/\d{4}\s+\d{2}:\d{2}:\d{2})$/)
      if (timeMatch) {
        linker = value.slice(0, timeMatch.index).trim()
        buildTime = timeMatch[1]
      } else {
        linker = value
      }
      continue
    }

    if (!outputFile && /^#\s*Output file\s*=\s*/i.test(trimmed)) {
      const sameLine = trimmed.replace(/^#\s*Output file\s*=\s*/i, '').trim()
      if (sameLine) {
        outputFile = sameLine
        continue
      }

      for (let j = i + 1; j < lines.length; j++) {
        const nextTrimmed = lines[j].trim()
        if (!nextTrimmed) {
          continue
        }
        if (nextTrimmed.startsWith('#')) {
          outputFile = nextTrimmed.replace(/^#\s*/, '').trim()
        }
        break
      }
    }

    if (linker && outputFile) {
      break
    }
  }

  return { linkerName: linker, linkerTime: buildTime, outputFile }
}

const regionLabel = (node: MemoryNode) => {
  const end = node.address + Math.max(node.size, 0)
  const total = node.totalBytes ?? node.size
  const used = node.usedBytes ?? 0
  const unused = node.unusedBytes ?? Math.max(total - used, 0)
  const hole = node.holeBytes ?? 0
  const ratio = node.utilization ?? (total > 0 ? used / total : 0)
  return `${node.name} | ${formatHex(node.address)} - ${formatHex(end)} | used ${formatBytes(used)} / ${formatBytes(total)} (${formatPercent(ratio)}) | unused ${formatBytes(unused)} | hole ${formatBytes(hole)}`
}

const parseAndSetMap = (text: string) => {
  lastMapText.value = text
  const meta = extractIarHeaderMetadata(text)
  linkerName.value = meta.linkerName
  linkerTime.value = meta.linkerTime
  outputFilePath.value = meta.outputFile
  const threshold = mergeThresholdBytes.value
  if (threshold === null) {
    mapData.value = null
    thresholdError.value = 'Invalid merge threshold. Use 0x.., B/bytes, KB, or MB.'
    return
  }

  thresholdError.value = ''
  try {
    const parsed = parseIarMap(text, undefined, { segmentGapToleranceBytes: threshold })
    mapData.value = parsed
    errorMessage.value = ''
  } catch (err) {
    mapData.value = null
    errorMessage.value = err instanceof Error ? err.message : 'Unknown parse error'
  }
}

onMounted(() => {
  // Check if injected map data exists from the backend
  if ((window as any).__INJECTED_MAP_DATA__) {
    const injectedGap = (window as any).__INJECTED_MERGE_GAP__
    if (typeof injectedGap === 'number' && Number.isFinite(injectedGap) && injectedGap >= 0) {
      mergeThresholdInput.value = `${Math.floor(injectedGap)}B`
    }
    loadedFileName.value = 'Injected map data'
    parseAndSetMap((window as any).__INJECTED_MAP_DATA__)
  }
})

function applyMergeThreshold() {
  const threshold = mergeThresholdBytes.value
  if (threshold === null) {
    thresholdError.value = 'Invalid merge threshold. Use 0x.., B/bytes, KB, or MB.'
    return
  }

  thresholdError.value = ''
  if (lastMapText.value) {
    parseAndSetMap(lastMapText.value)
  }
}

const handleFileUpload = (event: Event) => {
  const file = (event.target as HTMLInputElement).files?.[0]
  if (!file) return

  loadedFileName.value = file.name

  const reader = new FileReader()
  reader.onload = (e) => {
    const text = e.target?.result as string
    parseAndSetMap(text)
  }
  reader.readAsText(file)
}
</script>

<template>
  <div class="app-container">
    <header class="header">
      <div class="header-top">
        <div class="brand-block">
          <h1>Map Viewer</h1>
        </div>

        <div class="meta-panel">
          <span v-if="linkerName" class="meta-pill meta-pill-linker" :title="linkerName"><strong>Linker:</strong> {{ linkerName }}</span>
          <span v-if="linkerTime" class="meta-pill meta-pill-time" :title="linkerTime"><strong>Time:</strong> {{ linkerTime }}</span>
          <span v-if="outputFilePath" class="meta-pill meta-pill-output" :title="outputFilePath"><strong>Output:</strong> {{ outputFilePath }}</span>
        </div>

        <label class="upload-btn" for="fileInput" :title="loadedFileName || 'Upload .map'">{{ loadedFileName || 'Upload .map' }}</label>
      </div>

      <div class="search-panel">
        <div class="controls-shell">
          <div class="search-row">
            <div class="threshold-inline" title="连续段合并时允许的最大空洞，支持 0x40 / 64B / 1KB / 1MB">
              <span class="threshold-label">合并阈值</span>
              <input
                v-model="mergeThresholdInput"
                class="threshold-input"
                type="text"
                placeholder="eg. 64B / 0x40 / 1KB"
                @keydown.enter.prevent="applyMergeThreshold"
              />
              <button class="threshold-apply" @click="applyMergeThreshold">Apply</button>
            </div>

            <input
              v-model="searchQuery"
              class="search-input"
              type="text"
              placeholder="Search name / addr / size (hex: 0x1234 or A-F, dec: 1234)"
            />
            <label :class="['search-toggle', { active: searchByName }]">
              <input v-model="searchByName" type="checkbox" />
              Name
            </label>
            <label :class="['search-toggle', { active: searchByAddress }]">
              <input v-model="searchByAddress" type="checkbox" />
              Address
            </label>
            <label :class="['search-toggle', { active: searchBySize }]">
              <input v-model="searchBySize" type="checkbox" />
              Size
            </label>
            <label :class="['search-toggle', { active: searchCaseSensitive }]">
              <input v-model="searchCaseSensitive" type="checkbox" />
              Aa
            </label>
            <label :class="['search-toggle', { active: searchWholeWord }]">
              <input v-model="searchWholeWord" type="checkbox" />
              Word
            </label>
            <label :class="['search-toggle', { active: searchRegex }]">
              <input v-model="searchRegex" type="checkbox" />
              .*
            </label>
          </div>
        </div>
        <div v-if="thresholdError" class="threshold-error">{{ thresholdError }}</div>
      </div>
      <input
        type="file"
        accept=".map"
        @change="handleFileUpload"
        class="file-input"
        id="fileInput"
      />
    </header>

    <main class="main-content">
      <div v-if="errorMessage" class="error-state">
        <p>Map parse failed: {{ errorMessage }}</p>
      </div>
      <div v-if="mapData && mapData.length" class="chart-wrapper">
        <template v-for="(region, index) in mapData" :key="index">
          <div class="region-container">
            <h2>{{ regionLabel(region) }}</h2>
            <MemoryGraph
              :data="region"
              :search-query="searchQuery"
              :search-by-name="searchByName"
              :search-by-address="searchByAddress"
              :search-by-size="searchBySize"
              :search-case-sensitive="searchCaseSensitive"
              :search-whole-word="searchWholeWord"
              :search-regex="searchRegex"
            />
          </div>
        </template>

        <footer class="app-footer">
          <span>Made by tangpipi</span>
          <a href="https://github.com/tangpipi/mapviewer" target="_blank" rel="noopener noreferrer">github.com/tangpipi/mapviewer</a>
        </footer>
      </div>
      <div v-else class="empty-state">
        <p>Please upload a .map file to visualize memory usage.</p>
      </div>
    </main>
  </div>
</template>

<style scoped>
.app-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  width: 100vw;
}

.header {
  --ctrl-h: 34px;
  padding: 0.75rem 1rem;
  background: linear-gradient(180deg, #f8fafd 0%, #f2f5fb 100%);
  border-bottom: 1px solid #d6dce8;
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
}

.header-top {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 0.7rem;
}

.brand-block {
  min-width: 132px;
  display: flex;
  flex-direction: column;
  justify-content: center;
  padding: 0.2rem 0.35rem;
}

.header h1 {
  margin: 0;
  font-size: 19px;
  color: #172033;
  letter-spacing: 0.2px;
  flex-shrink: 0;
}

.meta-panel {
  flex: 1.7;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: nowrap;
  overflow: hidden;
  white-space: nowrap;
  padding: 0.38rem 0.6rem;
  background: #ecf1fb;
  border: 1px solid #d4dced;
  height: 40px;
  box-sizing: border-box;
}

.meta-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: #1f2937;
  background: rgba(255, 255, 255, 0.65);
  border: 1px solid rgba(203, 213, 225, 0.9);
  height: 28px;
  padding: 0 0.42rem;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  box-sizing: border-box;
}

.meta-pill-linker {
  flex: 1 1 32%;
}

.meta-pill-time {
  flex: 0 0 auto;
  max-width: 170px;
}

.meta-pill-output {
  flex: 2 1 52%;
}

.search-panel {
  width: 100%;
  display: flex;
  align-items: flex-start;
  gap: 0.3rem;
  flex-direction: column;
}

.controls-shell {
  width: 100%;
  border: 1px solid #d4dced;
  background: #f7f9fd;
  padding: 0.28rem 0.4rem;
  box-sizing: border-box;
}

.search-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
  width: 100%;
}

.threshold-inline {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  height: var(--ctrl-h);
  padding: 0 0.2rem 0 0;
  border: 0;
  background: transparent;
  box-sizing: border-box;
}

.threshold-label {
  font-size: 11px;
  font-weight: 800;
  color: #334155;
}

.search-input {
  flex: 1;
  min-width: 300px;
  height: var(--ctrl-h);
  border: 1px solid #cfd5e2;
  background: #ffffff;
  padding: 0 0.6rem;
  font-size: 12px;
  color: #1f2937;
  box-sizing: border-box;
}

.threshold-input {
  width: 170px;
  height: var(--ctrl-h);
  border: 1px solid #cfd5e2;
  background: #ffffff;
  padding: 0 0.5rem;
  font-size: 12px;
  color: #1f2937;
  box-sizing: border-box;
}

.threshold-apply {
  height: var(--ctrl-h);
  border: 1px solid #2f6de7;
  background: #2f6de7;
  color: #ffffff;
  font-size: 11px;
  font-weight: 700;
  padding: 0 0.7rem;
  cursor: pointer;
  line-height: calc(var(--ctrl-h) - 2px);
  box-sizing: border-box;
}

.threshold-error {
  font-size: 11px;
  color: #b91c1c;
}

.search-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.28rem;
  height: var(--ctrl-h);
  font-size: 11px;
  color: #303a4f;
  padding: 0 0.4rem;
  border: 1px solid #d3d9e6;
  background: #ffffff;
  white-space: nowrap;
  transition: all 0.15s ease;
  box-sizing: border-box;
}

.search-toggle input {
  margin: 0;
}

.search-toggle.active {
  color: #0f3f95;
  border-color: #7ea2ea;
  background: #eaf1ff;
  box-shadow: inset 0 0 0 1px rgba(61, 111, 217, 0.18);
}

.main-content {
  flex: 1;
  overflow: hidden;
  position: relative;
  display: flex;
}

.chart-wrapper {
  flex: 1;
  overflow: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.region-container {
  flex-shrink: 0;
  min-height: 260px;
  color: #3f495e;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.region-container h2 {
  margin: 0;
  font-size: 13px;
  line-height: 1.35;
  font-weight: 700;
  color: #1d2a42;
  word-break: break-word;
}

.file-input {
  display: none;
}

.upload-btn {
  max-width: 280px;
  height: 40px;
  padding: 0 0.85rem;
  border: 1px solid #2f6de7;
  background: #2f6de7;
  color: #fff;
  font-size: 13px;
  font-weight: 700;
  line-height: 38px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  user-select: none;
  flex-shrink: 0;
  align-self: center;
  box-sizing: border-box;
}

.error-state {
  margin: 1rem;
  padding: 0.75rem 1rem;
  border: 1px solid #fecaca;
  border-radius: 8px;
  color: #991b1b;
  background: #fef2f2;
}

.empty-state {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #4b5563;
  text-align: center;
  padding: 1rem;
}

.app-footer {
  height: 34px;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: #f8fafc;
  color: #475569;
  font-size: 12px;
}

.app-footer a {
  color: #1d4ed8;
  text-decoration: none;
}

.app-footer a:hover {
  text-decoration: underline;
}

@media (max-width: 1200px) {
  .threshold-input {
    width: 86px;
  }
}

@media (max-width: 860px) {
  .brand-block {
    min-width: 140px;
  }

  .search-input {
    min-width: 220px;
  }
}
</style>
