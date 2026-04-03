<template>
  <div class="memory-graph">
    <div class="graph-toolbar">
      <button class="tool-btn" @click="resetZoom" :disabled="!canReset">Reset View</button>
      <label class="toggle">
        <input v-model="showLabels" type="checkbox" />
        Labels
      </label>
      <label class="toggle">
        <input v-model="snapEnabled" type="checkbox" />
        Snap (Ctrl)
      </label>
    </div>

    <div
      class="canvas-container"
      :class="{ panning: isPanning }"
      ref="container"
      @mousedown="onBrushStart"
      @mousemove="onCanvasMove"
      @mouseup="onBrushEnd"
      @mouseleave="onCanvasLeave"
      @wheel="onCanvasWheel"
      @contextmenu.prevent
    >
      <div class="canvas" :style="{ height: canvasHeight + 'px' }">
        <div v-if="hoverCursorLeft !== null" class="cursor-line" :style="{ left: hoverCursorLeft + '%' }">
          <span class="cursor-label" :style="cursorLabelStyle">{{ hoverAddressLabel }}</span>
        </div>

        <div
          v-for="(node, i) in visibleBlocks"
          :key="`block-${i}`"
          :class="['block', { 'search-hit': isBlockMatched(node) }]"
          :style="getBlockStyle(node)"
          :title="getTooltip(node)"
          @click.stop="zoomTo(node)"
        >
          <span v-if="shouldRenderBlockLabel(node)" class="label">{{ node.name }}</span>
        </div>

        <div
          v-if="showLabels"
          v-for="(marker, idx) in renderLabelMarkers"
          :key="`marker-${idx}`"
          :class="['label-marker', { 'search-hit-label': isLabelMatched(marker) }]"
          :style="getMarkerStyle(marker)"
          :title="getMarkerTooltip(marker)"
          @click.stop="zoomToAddress(marker.address)"
        >
          <div class="label-pin">
            <span class="label-pin-count">{{ marker.count > 1 ? marker.count : '' }}</span>
          </div>
          <div class="label-line" />
          <div v-if="marker.showName" class="label-name">{{ marker.primaryName }}</div>
        </div>

        <div
          v-if="brushRect"
          class="brush-rect"
          :style="{ left: brushRect.left + 'px', width: brushRect.width + 'px' }"
        />
      </div>
    </div>

    <div class="range-panel">
      <div class="range-track" ref="rangeTrack" @mousedown="onTrackMouseDown">
        <div
          class="range-active"
          :class="{ dragging: draggingRange }"
          :style="rangeActiveStyle"
          @mousedown.stop.prevent="onRangeActiveMouseDown"
        />
        <button
          class="range-handle"
          :style="rangeLeftStyle"
          @mousedown.stop.prevent="onHandleMouseDown('left', $event)"
          aria-label="left handle"
        />
        <button
          class="range-handle"
          :style="rangeRightStyle"
          @mousedown.stop.prevent="onHandleMouseDown('right', $event)"
          aria-label="right handle"
        />
      </div>
      <div class="range-meta">
        <span>{{ toHex(viewMin) }} - {{ toHex(viewMin + viewSize) }}</span>
        <span>{{ viewSize }} B</span>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
export default {
  name: 'MemoryGraph'
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { MemoryNode } from '../parser/iar-parser';

const props = withDefaults(defineProps<{
  data: MemoryNode;
  searchQuery?: string;
  searchByName?: boolean;
  searchByAddress?: boolean;
  searchBySize?: boolean;
  searchCaseSensitive?: boolean;
  searchWholeWord?: boolean;
  searchRegex?: boolean;
}>(), {
  searchQuery: '',
  searchByName: true,
  searchByAddress: true,
  searchBySize: true,
  searchCaseSensitive: false,
  searchWholeWord: false,
  searchRegex: false
});

type FlatNode = {
  node: MemoryNode;
  name: string;
  address: number;
  size: number;
  type: string;
  depth: number;
};

interface LabelMarker {
  address: number;
  count: number;
  names: string[];
}

interface RenderLabelMarker extends LabelMarker {
  leftPct: number;
  primaryName: string;
  showName: boolean;
}

const ROW_HEIGHT = 34;
const ROW_GAP = 6;
const MIN_VIEW_BYTES = 16;
const LABEL_LANE_HEIGHT = 24;
const MIN_HANDLE_GAP = 0;
const VIEW_SIDE_PADDING_PCT = 0.65;

const zoomNode = ref<MemoryNode | null>(null);
const viewMin = ref(0);
const viewSize = ref(1);
const showLabels = ref(true);
const snapEnabled = ref(false);
const ctrlPressed = ref(false);

const leftHandle = ref(0);
const rightHandle = ref(1000);
const draggingHandle = ref<'left' | 'right' | null>(null);
const draggingRange = ref(false);
const dragRangeStartX = ref(0);
const dragRangeStartLeft = ref(0);
const dragRangeStartRight = ref(1000);
const rangeTrack = ref<HTMLElement | null>(null);
let sliderFrame = 0;

const fullMin = computed(() => props.data.address);
const fullSize = computed(() => Math.max(props.data.size, 1));
const canReset = computed(() => viewMin.value !== fullMin.value || viewSize.value !== fullSize.value || zoomNode.value !== null);

const toHex = (value: number) => `0x${Math.max(value, 0).toString(16).toUpperCase()}`;

function syncHandlesFromView() {
  const left = ((viewMin.value - fullMin.value) / fullSize.value) * 1000;
  const right = (((viewMin.value + viewSize.value) - fullMin.value) / fullSize.value) * 1000;
  leftHandle.value = Math.min(Math.max(Math.round(left), 0), 1000);
  rightHandle.value = Math.min(Math.max(Math.round(right), 0), 1000);
}

watch(
  () => props.data,
  (newData) => {
    zoomNode.value = null;
    viewMin.value = newData.address;
    viewSize.value = Math.max(newData.size, 1);
    syncHandlesFromView();
  },
  { immediate: true }
);

const flatNodes = computed(() => {
  const nodes: FlatNode[] = [];
  const traverse = (node: MemoryNode, depth: number) => {
    nodes.push({
      node,
      name: node.name,
      address: node.address,
      size: Math.max(node.size, 0),
      type: node.type,
      depth
    });
    node.children.forEach((child) => traverse(child, depth + 1));
  };

  traverse(props.data, 0);
  return nodes;
});

const visibleNodes = computed(() => {
  const viewMax = viewMin.value + viewSize.value;
  return flatNodes.value.filter((node) => {
    if (node.type === 'Label') {
      return node.address >= viewMin.value && node.address <= viewMax;
    }
    const nodeEnd = node.address + Math.max(node.size, 0);
    return node.address < viewMax && nodeEnd > viewMin.value;
  });
});

const visibleBlocks = computed(() => visibleNodes.value.filter((node) => node.type !== 'Label' && node.size > 0 && node.depth > 0));

const maxBlockDepth = computed(() => {
  const allBlocks = flatNodes.value.filter((node) => node.type !== 'Label' && node.size > 0 && node.depth > 0);
  if (allBlocks.length === 0) {
    return 0;
  }
  return allBlocks.reduce((max, node) => Math.max(max, node.depth - 1), 0);
});

const canvasHeight = computed(() => {
  const rowsHeight = (maxBlockDepth.value + 1) * (ROW_HEIGHT + ROW_GAP);
  return Math.max(LABEL_LANE_HEIGHT + rowsHeight + 2, 90);
});

const blockRowsBottom = computed(() => {
  return LABEL_LANE_HEIGHT + (maxBlockDepth.value + 1) * ROW_HEIGHT + maxBlockDepth.value * ROW_GAP;
});

const rowTop = (depth: number) => {
  const displayDepth = Math.max(depth - 1, 0);
  const inverted = maxBlockDepth.value - displayDepth;
  return Math.max(LABEL_LANE_HEIGHT + inverted * (ROW_HEIGHT + ROW_GAP), 0);
};

const mergedLabelMarkers = computed<LabelMarker[]>(() => {
  const labels = visibleNodes.value.filter((node) => node.type === 'Label');
  const grouped = new Map<number, LabelMarker>();

  for (const label of labels) {
    const key = label.address;
    const current = grouped.get(key);
    if (!current) {
      grouped.set(key, {
        address: label.address,
        count: 1,
        names: [label.name]
      });
      continue;
    }

    current.count += 1;
    if (current.names.length < 8) {
      current.names.push(label.name);
    }
  }

  return [...grouped.values()].sort((a, b) => a.address - b.address);
});

const renderLabelMarkers = computed<RenderLabelMarker[]>(() => {
  const sorted = mergedLabelMarkers.value;
  return sorted.map((marker, index) => {
    const leftPct = ((marker.address - viewMin.value) / viewSize.value) * 100;
    const nextPct = index < sorted.length - 1
      ? ((sorted[index + 1].address - viewMin.value) / viewSize.value) * 100
      : 100;
    const availablePct = Math.max(nextPct - leftPct, 0);

    const primaryName = marker.names[0] ?? '';
    const estimatedPct = Math.min(34, Math.max(10, primaryName.length * 0.72));
    const showName = primaryName.length > 0 && availablePct >= estimatedPct;

    return {
      ...marker,
      leftPct,
      primaryName,
      showName
    };
  });
});

const effectiveSnap = computed(() => snapEnabled.value || ctrlPressed.value);

const normalizedSearchText = computed(() => (props.searchQuery ?? '').trim().toLowerCase());
const rawSearchText = computed(() => (props.searchQuery ?? '').trim());
const searchRegexObject = computed<RegExp | null>(() => {
  const query = rawSearchText.value;
  if (!query || !props.searchRegex) {
    return null;
  }

  try {
    return new RegExp(query, props.searchCaseSensitive ? '' : 'i');
  } catch {
    return null;
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function textMatches(value: string): boolean {
  const queryRaw = rawSearchText.value;
  if (!queryRaw) {
    return false;
  }

  if (props.searchRegex) {
    const rx = searchRegexObject.value;
    if (!rx) {
      return false;
    }
    return rx.test(value);
  }

  const source = props.searchCaseSensitive ? value : value.toLowerCase();
  const query = props.searchCaseSensitive ? queryRaw : queryRaw.toLowerCase();

  if (props.searchWholeWord) {
    const pattern = `(^|[^0-9A-Za-z_])${escapeRegExp(query)}($|[^0-9A-Za-z_])`;
    return new RegExp(pattern, props.searchCaseSensitive ? '' : 'i').test(source);
  }

  return source.includes(query);
}

const numericTokens = computed(() => {
  const raw = (props.searchQuery ?? '').trim();
  if (!raw) {
    return [] as number[];
  }

  const parts = raw.split(/[\s,;:+|/]+/).filter(Boolean);
  const parsed: number[] = [];

  for (const partRaw of parts) {
    const part = partRaw.trim();
    if (!part) {
      continue;
    }

    const isHex = /^0x[0-9a-f]+$/i.test(part) || /^[0-9a-f]+$/i.test(part) && /[a-f]/i.test(part);
    const value = Number.parseInt(part, isHex ? 16 : 10);
    if (!Number.isNaN(value)) {
      parsed.push(value);
    }
  }

  return parsed;
});

const hasActiveSearch = computed(() => {
  return normalizedSearchText.value.length > 0 && (props.searchByName || props.searchByAddress || props.searchBySize);
});

function isBlockMatched(node: FlatNode): boolean {
  if (!hasActiveSearch.value) {
    return false;
  }

  const numbers = numericTokens.value;

  if (props.searchByName && textMatches(node.name)) {
    return true;
  }

  if (props.searchByAddress && numbers.length > 0 && node.address === numbers[0]) {
    return true;
  }

  if (props.searchByAddress) {
    const addressText = `${node.address} ${toHex(node.address)}`;
    if (textMatches(addressText)) {
      return true;
    }
  }

  if (props.searchBySize && numbers.length > 0 && node.size === numbers[0]) {
    return true;
  }

  if (props.searchBySize) {
    const sizeText = `${node.size} ${toHex(node.size)}`;
    if (textMatches(sizeText)) {
      return true;
    }
  }

  if (props.searchByAddress && props.searchBySize && numbers.length >= 2) {
    if (node.address === numbers[0] && node.size === numbers[1]) {
      return true;
    }
  }

  return false;
}

function isLabelMatched(marker: RenderLabelMarker): boolean {
  if (!hasActiveSearch.value) {
    return false;
  }

  const numbers = numericTokens.value;

  if (props.searchByName) {
    for (const name of marker.names) {
      if (textMatches(name)) {
        return true;
      }
    }
  }

  if (props.searchByAddress && numbers.length > 0 && marker.address === numbers[0]) {
    return true;
  }

  if (props.searchByAddress) {
    const addressText = `${marker.address} ${toHex(marker.address)}`;
    if (textMatches(addressText)) {
      return true;
    }
  }

  return false;
}

const snapAddresses = computed(() => {
  const points = new Set<number>();
  for (const node of visibleBlocks.value) {
    points.add(node.address);
    points.add(node.address + node.size);
  }
  for (const marker of mergedLabelMarkers.value) {
    points.add(marker.address);
  }
  return [...points.values()].sort((a, b) => a - b);
});

function snapAddress(address: number): number {
  if (!effectiveSnap.value || snapAddresses.value.length === 0) {
    return address;
  }

  let nearest = snapAddresses.value[0];
  let best = Math.abs(nearest - address);
  for (let i = 1; i < snapAddresses.value.length; i++) {
    const d = Math.abs(snapAddresses.value[i] - address);
    if (d < best) {
      best = d;
      nearest = snapAddresses.value[i];
    }
  }
  return nearest;
}

const getBlockStyle = (node: FlatNode) => {
  const startRatio = (node.address - viewMin.value) / viewSize.value;
  const endRatio = (node.address + node.size - viewMin.value) / viewSize.value;
  const clampedStart = Math.min(Math.max(startRatio, 0), 1);
  const clampedEnd = Math.min(Math.max(endRatio, 0), 1);
  const usablePct = Math.max(100 - VIEW_SIDE_PADDING_PCT * 2, 1);

  let left = VIEW_SIDE_PADDING_PCT + clampedStart * usablePct;
  let width = Math.max((clampedEnd - clampedStart) * usablePct, 0);

  const containerWidth = container.value?.getBoundingClientRect().width ?? 0;
  let widthPx = containerWidth > 0 ? (width / 100) * containerWidth : 0;
  if (containerWidth > 0) {
    const rawLeftPx = (left / 100) * containerWidth;
    const rawRightPx = ((left + width) / 100) * containerWidth;
    const snappedLeftPx = Math.floor(rawLeftPx);
    const snappedRightPx = Math.ceil(rawRightPx);
    const snappedWidthPx = widthPx > 0 ? Math.max(snappedRightPx - snappedLeftPx, 1) : 0;

    left = (snappedLeftPx / containerWidth) * 100;
    width = (snappedWidthPx / containerWidth) * 100;
    widthPx = snappedWidthPx;
  }
  const tiny = widthPx > 0 && widthPx < 6;
  const ultraThin = widthPx > 0 && widthPx <= 1.2;

  let hue = 200;
  switch (node.type) {
    case 'Region':
      hue = 0;
      break;
    case 'ConfiguredRegion':
      hue = 20;
      break;
    case 'PlacementRegion':
      hue = 32;
      break;
    case 'Unused':
      hue = 0;
      break;
    case 'Object':
      hue = 40;
      break;
    case 'Code':
      hue = 132;
      break;
    case 'Data':
      hue = 265;
      break;
    default:
      hue = 210;
  }

  return {
    position: 'absolute' as const,
    left: `${left}%`,
    width: `${width}%`,
    top: `${rowTop(node.depth)}px`,
    height: `${ROW_HEIGHT}px`,
    minWidth: '0',
    padding: tiny ? '0' : '0 6px',
    borderWidth: '0',
    boxShadow: ultraThin
      ? 'inset 0 0 0 1px rgba(0, 0, 0, 0.45)'
      : 'inset 0 0 0 1px rgba(0, 0, 0, 0.28)',
    backgroundColor: node.type === 'Unused' ? 'rgba(107, 114, 128, 0.24)' : `hsl(${hue}, 66%, 48%)`
  };
};

function projectRatioToPercent(ratio: number): number {
  const clamped = Math.min(Math.max(ratio, 0), 1);
  const usablePct = Math.max(100 - VIEW_SIDE_PADDING_PCT * 2, 1);
  const projected = VIEW_SIDE_PADDING_PCT + clamped * usablePct;

  const containerWidth = container.value?.getBoundingClientRect().width ?? 0;
  if (containerWidth <= 0) {
    return projected;
  }

  const rawPx = (projected / 100) * containerWidth;
  const snappedPx = Math.floor(rawPx);
  return (snappedPx / containerWidth) * 100;
}

function shouldRenderBlockLabel(node: FlatNode): boolean {
  const startRatio = (node.address - viewMin.value) / viewSize.value;
  const endRatio = (node.address + node.size - viewMin.value) / viewSize.value;
  const clampedStart = Math.min(Math.max(startRatio, 0), 1);
  const clampedEnd = Math.min(Math.max(endRatio, 0), 1);
  const usablePct = Math.max(100 - VIEW_SIDE_PADDING_PCT * 2, 1);
  const widthPct = Math.max((clampedEnd - clampedStart) * usablePct, 0);
  if (widthPct <= 0) {
    return false;
  }

  const containerWidth = container.value?.getBoundingClientRect().width ?? 0;
  if (containerWidth <= 0) {
    return widthPct >= 2.2;
  }

  const widthPx = (widthPct / 100) * containerWidth;
  const requiredPx = Math.min(150, Math.max(14, node.name.length * 6.2 + 6));
  return widthPx >= requiredPx;
}

const getMarkerStyle = (marker: RenderLabelMarker) => {
  const ratio = (marker.address - viewMin.value) / viewSize.value;
  const left = projectRatioToPercent(ratio);
  return {
    left: `${left}%`,
    top: '0px',
    height: `${blockRowsBottom.value}px`
  };
};

const getMarkerTooltip = (marker: LabelMarker) => {
  const preview = marker.names.join('\n');
  const more = marker.count > marker.names.length ? `\n... +${marker.count - marker.names.length} more` : '';
  return `Labels @ ${toHex(marker.address)}\nCount: ${marker.count}\n${preview}${more}`;
};

const getTooltip = (node: FlatNode) => {
  const end = node.address + Math.max(node.size, 0);
  const stats = node.node.totalBytes !== undefined
    ? `\nUsed: ${node.node.usedBytes ?? 0}/${node.node.totalBytes} (${(((node.node.utilization ?? 0) * 100)).toFixed(2)}%)\nUnused: ${node.node.unusedBytes ?? 0}\nHole: ${node.node.holeBytes ?? 0}`
    : '';

  return `${node.name}\nType: ${node.type}\nStart: ${toHex(node.address)}\nEnd: ${toHex(end)}\nSize: ${node.size} B${stats}`;
};

function resetZoom() {
  zoomNode.value = null;
  viewMin.value = fullMin.value;
  viewSize.value = fullSize.value;
  syncHandlesFromView();
}

function zoomTo(node: FlatNode | MemoryNode) {
  if (isDraggingBrush.value) {
    return;
  }

  const target = 'depth' in node ? node.node : node;
  const start = Math.max(target.address, fullMin.value);
  const span = Math.max(target.size, MIN_VIEW_BYTES);
  const end = Math.min(start + span, fullMin.value + fullSize.value);

  zoomNode.value = target;
  viewMin.value = start;
  viewSize.value = Math.max(end - start, MIN_VIEW_BYTES);
  syncHandlesFromView();
}

function zoomToAddress(address: number) {
  const span = Math.max(Math.floor(viewSize.value * 0.08), 256);
  const snapped = snapAddress(address);
  const start = Math.max(snapped - Math.floor(span / 2), fullMin.value);
  const end = Math.min(start + span, fullMin.value + fullSize.value);

  zoomNode.value = null;
  viewMin.value = start;
  viewSize.value = Math.max(end - start, MIN_VIEW_BYTES);
  syncHandlesFromView();
}

function applyHandlesToView() {
  const leftRatio = Math.min(leftHandle.value, rightHandle.value) / 1000;
  const rightRatio = Math.max(leftHandle.value, rightHandle.value) / 1000;

  const start = fullMin.value + Math.floor(fullSize.value * leftRatio);
  const end = fullMin.value + Math.ceil(fullSize.value * rightRatio);

  zoomNode.value = null;
  viewMin.value = Math.max(start, fullMin.value);
  viewSize.value = Math.max(end - viewMin.value, MIN_VIEW_BYTES);
}

function scheduleApplyHandlesToView() {
  if (sliderFrame) {
    return;
  }
  sliderFrame = requestAnimationFrame(() => {
    sliderFrame = 0;
    applyHandlesToView();
  });
}

function clampHandles() {
  if (draggingHandle.value === 'left') {
    leftHandle.value = Math.min(leftHandle.value, rightHandle.value - MIN_HANDLE_GAP);
  } else if (draggingHandle.value === 'right') {
    rightHandle.value = Math.max(rightHandle.value, leftHandle.value + MIN_HANDLE_GAP);
  } else {
    if (leftHandle.value > rightHandle.value - MIN_HANDLE_GAP) {
      leftHandle.value = rightHandle.value - MIN_HANDLE_GAP;
    }
    if (rightHandle.value < leftHandle.value + MIN_HANDLE_GAP) {
      rightHandle.value = leftHandle.value + MIN_HANDLE_GAP;
    }
  }
  leftHandle.value = Math.min(Math.max(leftHandle.value, 0), 1000);
  rightHandle.value = Math.min(Math.max(rightHandle.value, 0), 1000);
}

function valueFromClientX(clientX: number): number {
  if (!rangeTrack.value) {
    return 0;
  }
  const rect = rangeTrack.value.getBoundingClientRect();
  if (rect.width <= 0) {
    return 0;
  }
  const ratio = (clientX - rect.left) / rect.width;
  return Math.round(Math.min(Math.max(ratio, 0), 1) * 1000);
}

const rangeActiveStyle = computed(() => {
  const left = Math.min(leftHandle.value, rightHandle.value) / 10;
  const right = Math.max(leftHandle.value, rightHandle.value) / 10;
  return {
    left: `${left}%`,
    width: `${Math.max(right - left, 0)}%`
  };
});

const rangeLeftStyle = computed(() => ({ left: `${leftHandle.value / 10}%` }));
const rangeRightStyle = computed(() => ({ left: `${rightHandle.value / 10}%` }));

function onHandleMouseDown(handle: 'left' | 'right', event: MouseEvent) {
  draggingHandle.value = handle;
  const value = valueFromClientX(event.clientX);
  if (handle === 'left') {
    leftHandle.value = value;
  } else {
    rightHandle.value = value;
  }
  clampHandles();
  scheduleApplyHandlesToView();
}

function onTrackMouseDown(event: MouseEvent) {
  const value = valueFromClientX(event.clientX);
  const distLeft = Math.abs(value - leftHandle.value);
  const distRight = Math.abs(value - rightHandle.value);
  draggingHandle.value = distLeft <= distRight ? 'left' : 'right';

  if (draggingHandle.value === 'left') {
    leftHandle.value = value;
  } else {
    rightHandle.value = value;
  }
  clampHandles();
  scheduleApplyHandlesToView();
}

function onRangeActiveMouseDown(event: MouseEvent) {
  if (event.button !== 0) {
    return;
  }
  draggingRange.value = true;
  dragRangeStartX.value = event.clientX;
  dragRangeStartLeft.value = leftHandle.value;
  dragRangeStartRight.value = rightHandle.value;
}

function onWindowMouseMove(event: MouseEvent) {
  if (draggingRange.value && rangeTrack.value) {
    const rect = rangeTrack.value.getBoundingClientRect();
    if (rect.width > 0) {
      const delta = Math.round(((event.clientX - dragRangeStartX.value) / rect.width) * 1000);
      let nextLeft = dragRangeStartLeft.value + delta;
      let nextRight = dragRangeStartRight.value + delta;

      if (nextLeft < 0) {
        nextRight -= nextLeft;
        nextLeft = 0;
      }
      if (nextRight > 1000) {
        const overflow = nextRight - 1000;
        nextLeft -= overflow;
        nextRight = 1000;
      }

      leftHandle.value = Math.max(nextLeft, 0);
      rightHandle.value = Math.min(nextRight, 1000);
      scheduleApplyHandlesToView();
    }
    return;
  }

  if (!draggingHandle.value) {
    return;
  }
  const value = valueFromClientX(event.clientX);
  if (draggingHandle.value === 'left') {
    leftHandle.value = value;
  } else {
    rightHandle.value = value;
  }
  clampHandles();
  scheduleApplyHandlesToView();
}

function onWindowMouseUp() {
  draggingHandle.value = null;
  draggingRange.value = false;
  isPanning.value = false;
}

watch([viewMin, viewSize], () => {
  if (!draggingHandle.value && !draggingRange.value) {
    syncHandlesFromView();
  }
});

onMounted(() => {
  window.addEventListener('mousemove', onWindowMouseMove);
  window.addEventListener('mouseup', onWindowMouseUp);
  syncHandlesFromView();
});

onBeforeUnmount(() => {
  if (sliderFrame) {
    cancelAnimationFrame(sliderFrame);
    sliderFrame = 0;
  }
  window.removeEventListener('mousemove', onWindowMouseMove);
  window.removeEventListener('mouseup', onWindowMouseUp);
});

const container = ref<HTMLElement | null>(null);
const brushStartX = ref(0);
const brushCurrentX = ref(0);
const isBrushing = ref(false);
const isDraggingBrush = ref(false);
const isPanning = ref(false);
const panStartX = ref(0);
const panStartViewMin = ref(0);
const hoverX = ref<number | null>(null);

const brushRect = computed(() => {
  if (!isBrushing.value || !container.value) {
    return null;
  }
  const left = Math.min(brushStartX.value, brushCurrentX.value);
  const width = Math.abs(brushCurrentX.value - brushStartX.value);
  if (width < 2) {
    return null;
  }
  return { left, width };
});

const hoverCursorLeft = computed(() => {
  if (hoverX.value === null || !container.value) {
    return null;
  }
  const width = container.value.getBoundingClientRect().width;
  if (width <= 0) {
    return null;
  }
  const pct = (hoverX.value / width) * 100;
  return Math.min(Math.max(pct, 0), 99.8);
});

const cursorLabelStyle = computed(() => {
  if (hoverCursorLeft.value === null) {
    return {};
  }
  return hoverCursorLeft.value > 88
    ? { right: '4px', left: 'auto' }
    : { left: '4px', right: 'auto' };
});

const hoverAddressLabel = computed(() => {
  if (hoverX.value === null || !container.value) {
    return '';
  }
  const width = container.value.getBoundingClientRect().width;
  if (width <= 0) {
    return '';
  }
  const ratio = hoverX.value / width;
  const rawAddress = Math.floor(viewMin.value + viewSize.value * ratio);
  const address = snapAddress(rawAddress);
  return `${toHex(address)} (${address})`;
});

function addressToLocalX(address: number): number {
  if (!container.value || viewSize.value <= 0) {
    return 0;
  }
  const rect = container.value.getBoundingClientRect();
  const ratio = (address - viewMin.value) / viewSize.value;
  return Math.min(Math.max(ratio * rect.width, 0), rect.width);
}

function localX(event: MouseEvent): number {
  if (!container.value) {
    return 0;
  }
  const rect = container.value.getBoundingClientRect();
  const rawX = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
  if (!(snapEnabled.value || event.ctrlKey) || viewSize.value <= 0) {
    return rawX;
  }
  const ratio = rawX / rect.width;
  const rawAddress = Math.floor(viewMin.value + viewSize.value * ratio);
  const snappedAddress = snapAddress(rawAddress);
  return addressToLocalX(snappedAddress);
}

function onBrushStart(event: MouseEvent) {
  if (!container.value) {
    return;
  }

  if (event.button === 2) {
    isPanning.value = true;
    panStartX.value = event.clientX;
    panStartViewMin.value = viewMin.value;
    return;
  }

  if (event.button !== 0) {
    return;
  }

  ctrlPressed.value = event.ctrlKey;
  isBrushing.value = true;
  isDraggingBrush.value = false;
  brushStartX.value = localX(event);
  brushCurrentX.value = brushStartX.value;
}

function onCanvasMove(event: MouseEvent) {
  if (isPanning.value && container.value) {
    const width = container.value.getBoundingClientRect().width;
    if (width > 0) {
      const deltaPx = event.clientX - panStartX.value;
      const deltaBytes = Math.round((deltaPx / width) * viewSize.value);
      const maxStart = Math.max(fullMin.value + fullSize.value - viewSize.value, fullMin.value);
      viewMin.value = Math.min(Math.max(panStartViewMin.value - deltaBytes, fullMin.value), maxStart);
      syncHandlesFromView();
    }
    return;
  }

  ctrlPressed.value = event.ctrlKey;
  hoverX.value = localX(event);
  if (!isBrushing.value) {
    return;
  }
  brushCurrentX.value = hoverX.value;
  if (Math.abs(brushCurrentX.value - brushStartX.value) > 4) {
    isDraggingBrush.value = true;
  }
}

function onBrushEnd() {
  if (isPanning.value) {
    isPanning.value = false;
    return;
  }

  if (!isBrushing.value || !container.value) {
    return;
  }

  const width = container.value.getBoundingClientRect().width;
  const left = Math.min(brushStartX.value, brushCurrentX.value);
  const right = Math.max(brushStartX.value, brushCurrentX.value);
  isBrushing.value = false;

  if (!isDraggingBrush.value || right - left < 4 || width <= 0) {
    isDraggingBrush.value = false;
    return;
  }

  const leftRatio = left / width;
  const rightRatio = right / width;
  const rawStart = viewMin.value + Math.floor(viewSize.value * leftRatio);
  const rawEnd = viewMin.value + Math.ceil(viewSize.value * rightRatio);
  const start = snapAddress(rawStart);
  const end = snapAddress(rawEnd);

  zoomNode.value = null;
  viewMin.value = Math.max(Math.min(start, end), fullMin.value);
  viewSize.value = Math.max(Math.abs(end - start), MIN_VIEW_BYTES);
  syncHandlesFromView();
  isDraggingBrush.value = false;
}

function onCanvasLeave() {
  if (isPanning.value) {
    isPanning.value = false;
  }
  ctrlPressed.value = false;
  hoverX.value = null;
  if (!isBrushing.value) {
    return;
  }
  isBrushing.value = false;
  isDraggingBrush.value = false;
}

function onCanvasWheel(event: WheelEvent) {
  if (!event.ctrlKey || !container.value || viewSize.value <= 0) {
    return;
  }

  event.preventDefault();

  const rect = container.value.getBoundingClientRect();
  if (rect.width <= 0) {
    return;
  }

  const local = Math.min(Math.max(event.clientX - rect.left, 0), rect.width);
  const anchorRatio = local / rect.width;
  const anchorAddress = viewMin.value + Math.floor(viewSize.value * anchorRatio);

  const zoomStep = event.deltaY > 0 ? 1.15 : 0.87;
  const targetSize = Math.round(viewSize.value * zoomStep);
  const nextSize = Math.min(Math.max(targetSize, MIN_VIEW_BYTES), fullSize.value);

  const maxStart = Math.max(fullMin.value + fullSize.value - nextSize, fullMin.value);
  const nextMin = Math.min(
    Math.max(anchorAddress - Math.floor(nextSize * anchorRatio), fullMin.value),
    maxStart
  );

  zoomNode.value = null;
  viewMin.value = nextMin;
  viewSize.value = nextSize;
  syncHandlesFromView();
}
</script>

<style scoped>
.memory-graph {
  display: flex;
  flex-direction: column;
  width: 100%;
  border: 1px solid #d6d7db;
  background: #ffffff;
  overflow: hidden;
}

.graph-toolbar {
  padding: 8px 12px;
  background: #f6f7fb;
  border-bottom: 1px solid #d7deea;
  display: flex;
  align-items: center;
  gap: 10px;
}

.tool-btn {
  border: 1px solid #2f6de7;
  background: #2f6de7;
  color: #ffffff;
  padding: 5px 10px;
  font-size: 12px;
  font-weight: 700;
  cursor: pointer;
}

.tool-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  font-weight: 700;
  color: #1f2937;
}

.canvas-container {
  overflow-x: hidden;
  overflow-y: auto;
  position: relative;
  background: #ffffff;
  user-select: none;
}

.canvas-container.panning {
  cursor: grabbing;
}

.canvas {
  position: relative;
  width: 100%;
  min-width: 100%;
  padding: 0 0 2px;
}

.cursor-line {
  position: absolute;
  top: 0;
  bottom: 0;
  width: 0;
  border-left: 1px dashed rgba(37, 99, 235, 0.95);
  pointer-events: none;
  z-index: 14;
}

.cursor-label {
  position: absolute;
  top: 2px;
  left: 4px;
  background: #1f2937;
  color: #ffffff;
  font-size: 10px;
  line-height: 1;
  padding: 3px 5px;
  white-space: nowrap;
}

.block {
  box-sizing: border-box;
  border: 0;
  cursor: pointer;
  overflow: hidden;
  display: flex;
  align-items: center;
  min-width: 0;
  padding: 0;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.28);
  z-index: 3;
}

.block.search-hit {
  outline: 2px solid #f59e0b;
  outline-offset: -1px;
  z-index: 13;
}

.block:hover {
  box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.45) !important;
  outline: 1px solid rgba(0, 0, 0, 0.22);
  outline-offset: -1px;
  filter: brightness(1.06);
  z-index: 10;
}

.block:active {
  box-shadow: inset 0 0 0 2px rgba(0, 0, 0, 0.55) !important;
}

.label {
  color: white;
  font-size: 12px;
  font-weight: 700;
  white-space: nowrap;
  text-overflow: ellipsis;
  overflow: hidden;
  text-shadow: 0 1px 2px rgba(0,0,0,0.45);
  pointer-events: none;
}

.label-marker {
  position: absolute;
  width: 0;
  cursor: pointer;
  z-index: 12;
}

.label-marker.search-hit-label .label-pin {
  background: #f97316;
  box-shadow: inset 0 0 0 2px rgba(124, 45, 18, 0.75);
}

.label-marker.search-hit-label .label-line {
  background: rgba(249, 115, 22, 0.9);
}

.label-pin {
  position: absolute;
  top: 2px;
  left: -7px;
  width: 14px;
  height: 14px;
  background: #e11d48;
  border: none;
  box-shadow: inset 0 0 0 2px rgba(121, 17, 42, 0.65);
  transform: rotate(45deg);
  border-radius: 7px 7px 0 7px;
}

.label-pin-count {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ffffff;
  font-size: 9px;
  font-weight: 700;
  line-height: 1;
  transform: rotate(-45deg);
}

.label-line {
  position: absolute;
  top: 18px;
  left: -1px;
  width: 2px;
  bottom: 0;
  background: rgba(225, 29, 72, 0.72);
}

.label-name {
  position: absolute;
  top: 0;
  left: 12px;
  max-width: 220px;
  padding: 1px 6px;
  border-radius: 0;
  background: rgba(255, 241, 242, 0.96);
  border: none;
  color: #9f1239;
  font-size: 11px;
  font-weight: 700;
  line-height: 1.2;
  white-space: nowrap;
  pointer-events: none;
}

.brush-rect {
  position: absolute;
  top: 0;
  bottom: 0;
  border: 1px solid rgba(35, 93, 212, 0.85);
  background: rgba(64, 115, 255, 0.18);
  pointer-events: none;
}

.range-panel {
  padding: 10px 12px 12px;
  border-top: 1px solid #d7deea;
  background: #f7f9fd;
}

.range-track {
  position: relative;
  height: 7px;
  border: 1px solid #d5dbea;
  background: #e8edf8;
  margin: 6px 0 10px;
}

.range-active {
  position: absolute;
  top: 0;
  bottom: 0;
  background: #2f6de7;
  cursor: grab;
}

.range-active.dragging {
  cursor: grabbing;
}

.range-handle {
  appearance: none;
  -webkit-appearance: none;
  padding: 0;
  box-sizing: border-box;
  aspect-ratio: 1 / 1;
  position: absolute;
  top: 50%;
  width: 15px;
  height: 15px;
  margin-left: -7.5px;
  transform: translateY(-50%);
  border-radius: 50%;
  border: 2px solid #2f6de7;
  background: #ffffff;
  box-shadow: 0 1px 2px rgba(15, 23, 42, 0.2);
  cursor: ew-resize;
  z-index: 4;
}

.range-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 6px;
  color: #5b6477;
  font-size: 11px;
  font-weight: 700;
}
</style>
