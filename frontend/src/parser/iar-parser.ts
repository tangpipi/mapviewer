export interface MapSymbol {
  name: string;
  address: number;
  size: number;
  type: string;
  object: string;
  module: string;
}

export interface MemoryNode {
  name: string;
  address: number;
  size: number;
  type: string;
  children: MemoryNode[];
  totalBytes?: number;
  usedBytes?: number;
  unusedBytes?: number;
  holeBytes?: number;
  utilization?: number;
}

interface ParsedRegion {
  name: string;
  start: number;
  size: number;
  type: 'ConfiguredRegion' | 'PlacementRegion';
}

interface AddressRange {
  start: number;
  end: number;
}

type ObjectRangeMap = Map<string, AddressRange[]>;

const SECTION_PLACEMENT_SUMMARY = '*** PLACEMENT SUMMARY';
const SECTION_MODULE_SUMMARY = '*** MODULE SUMMARY';
const SECTION_ENTRY_LIST = '*** ENTRY LIST';
const DEFAULT_SEGMENT_GAP_TOLERANCE_BYTES = 64;
const HEX_VALUE_RE = /^(?:0x)?[0-9a-fA-F']+$/;
const HEX_IN_LINE_RE = /0x[0-9a-fA-F']+/;

export interface ParseIarMapOptions {
  segmentGapToleranceBytes?: number;
}

function toModuleDisplayName(modulePath: string): string {
  const cleaned = modulePath.trim().replace(/^"|"$/g, '');
  const pieces = cleaned.split(/[\\/]/);
  return pieces[pieces.length - 1] || cleaned;
}

function parseHex(value: string): number {
  const normalized = value.replace(/'/g, '').trim();
  return parseInt(normalized.startsWith('0x') || normalized.startsWith('0X') ? normalized : `0x${normalized}`, 16);
}

function parseMemSize(sizeStr: string): number {
  if (!sizeStr) {
    return 0;
  }

  const normalized = sizeStr.trim().toUpperCase();
  if (normalized.endsWith('KB')) {
    return Math.round(parseFloat(normalized) * 1024);
  }
  if (normalized.endsWith('MB')) {
    return Math.round(parseFloat(normalized) * 1024 * 1024);
  }
  if (normalized.startsWith('0X')) {
    return parseInt(normalized, 16);
  }
  return parseInt(normalized, 10);
}

function toBaseObjectName(rawObject: string): string {
  const cleaned = rawObject.trim().replace(/^"|"$/g, '');
  const pieces = cleaned.split(/[\\/]/);
  return pieces[pieces.length - 1] || cleaned;
}

function extractSection(lines: string[], marker: string): string[] {
  const start = lines.findIndex((line) => line.includes(marker));
  if (start < 0) {
    return [];
  }

  const section: string[] = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('*** ') && !line.includes(marker)) {
      break;
    }
    section.push(line);
  }
  return section;
}

function parseModuleSummary(lines: string[]): Map<string, string> {
  const objectToModule = new Map<string, string>();
  let currentModule = 'Local Project';

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    if (trimmed.endsWith(':') || trimmed.includes(': [')) {
      const modulePath = trimmed.slice(0, trimmed.lastIndexOf(':')).trim();
      currentModule = toModuleDisplayName(modulePath);
      continue;
    }

    const objectMatch = trimmed.match(/([^\s"']+\.o)\b/i);
    if (!objectMatch) {
      continue;
    }

    const objectName = toBaseObjectName(objectMatch[1]);
    objectToModule.set(objectName, currentModule);
  }

  return objectToModule;
}

function parseModuleIndex(lines: string[]): Map<number, string> {
  const moduleById = new Map<number, string>();
  for (const rawLine of lines) {
    const match = rawLine.trim().match(/^\[(\d+)\]\s*=\s*(.+)$/);
    if (!match) {
      continue;
    }

    const moduleId = Number(match[1]);
    const modulePath = match[2].trim();
    if (Number.isFinite(moduleId) && modulePath) {
      moduleById.set(moduleId, modulePath);
    }
  }
  return moduleById;
}

function parsePlacementRegions(lines: string[]): ParsedRegion[] {
  const merged = new Map<string, ParsedRegion>();

  for (const rawLine of lines) {
    const match = rawLine.match(/^"([^"]+)":\s+place in\s+\[from\s+(0x[0-9a-fA-F']+)\s+to\s+(0x[0-9a-fA-F']+)\]/);
    if (!match) {
      continue;
    }

    const placementName = match[1].trim();
    const start = parseHex(match[2]);
    const end = parseHex(match[3]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
      continue;
    }

    const key = `${start}:${end}`;
    const size = end - start + 1;
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        name: placementName,
        start,
        size,
        type: 'PlacementRegion'
      });
      continue;
    }

    existing.name = `${existing.name}/${placementName}`;
  }

  return [...merged.values()].sort((a, b) => a.start - b.start || a.size - b.size);
}

function parsePlacementObjectRanges(lines: string[], moduleById: Map<number, string>): ObjectRangeMap {
  const rangesByObject: ObjectRangeMap = new Map();

  for (const rawLine of lines) {
    const match = rawLine.match(/(0x[0-9a-fA-F']+)\s+\d+\s+(0x[0-9a-fA-F']+)\s+([^\s"']+\.o)\s+\[(\d+)\]\s*$/);
    if (!match) {
      continue;
    }

    const start = parseHex(match[1]);
    const size = parseHex(match[2]);
    if (!Number.isFinite(start) || !Number.isFinite(size) || size <= 0) {
      continue;
    }

    const object = toBaseObjectName(match[3]);
    const moduleId = Number(match[4]);
    const modulePath = moduleById.get(moduleId);
    const module = modulePath ? toModuleDisplayName(modulePath) : 'Unknown';
    const objectKey = `${module}::${object}`;
    const range: AddressRange = {
      start,
      end: start + size
    };

    const list = rangesByObject.get(objectKey);
    if (!list) {
      rangesByObject.set(objectKey, [range]);
      continue;
    }
    list.push(range);
  }

  for (const [key, list] of rangesByObject.entries()) {
    list.sort((a, b) => a.start - b.start || a.end - b.end);
    rangesByObject.set(key, mergeIntervals(list));
  }

  return rangesByObject;
}

function findRangeContainingAddress(rangesByObject: ObjectRangeMap, objectKey: string, address: number): AddressRange | null {
  const ranges = rangesByObject.get(objectKey);
  if (!ranges || ranges.length === 0) {
    return null;
  }

  for (const range of ranges) {
    if (address >= range.start && address < range.end) {
      return range;
    }
  }

  return null;
}

function parseUnusedRanges(lines: string[]): AddressRange[] {
  const ranges: AddressRange[] = [];
  const start = lines.findIndex((line) => line.trim().startsWith('Unused ranges:'));
  if (start < 0) {
    return ranges;
  }

  for (let i = start + 1; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (!trimmed) {
      continue;
    }
    if (trimmed.startsWith('***')) {
      break;
    }
    if (trimmed.startsWith('From') || trimmed.startsWith('----')) {
      continue;
    }

    const match = trimmed.match(/^(0x[0-9a-fA-F']+)\s+(0x[0-9a-fA-F']+)\s+(0x[0-9a-fA-F']+)$/);
    if (!match) {
      continue;
    }

    const from = parseHex(match[1]);
    const to = parseHex(match[2]);
    if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
      continue;
    }

    ranges.push({ start: from, end: to + 1 });
  }

  return ranges.sort((a, b) => a.start - b.start || a.end - b.end);
}

function parseEntryRow(
  name: string,
  tail: string,
  moduleById: Map<number, string>,
  objectToModule: Map<string, string>
): MapSymbol | null {
  const parts = tail.trim().split(/\s+/);
  if (parts.length < 4 || !HEX_VALUE_RE.test(parts[0])) {
    return null;
  }

  const address = parseHex(parts[0]);
  let cursor = 1;

  let size = 0;
  const hasExplicitSize = Boolean(parts[cursor] && HEX_VALUE_RE.test(parts[cursor]));
  if (hasExplicitSize) {
    size = parseHex(parts[cursor]);
    cursor++;
  }

  const primaryType = parts[cursor] ?? 'Symbol';
  const secondaryType = parts[cursor + 1] ?? '--';
  cursor += 2;

  const rest = parts.slice(cursor).join(' ');
  if (rest.includes('- Linker created -')) {
    return null;
  }

  const objectWithModuleMatch = rest.match(/([^\s"']+\.o)\s+\[(\d+)\]\b/i);
  const objectMatch = objectWithModuleMatch ?? rest.match(/([^\s"']+\.o)\b/i);
  if (!objectMatch) {
    return null;
  }

  const object = toBaseObjectName(objectMatch[1]);
  const moduleId = objectWithModuleMatch ? Number(objectWithModuleMatch[2]) : NaN;
  const modulePath = Number.isFinite(moduleId) ? moduleById.get(moduleId) : undefined;

  const resolvedType = primaryType === '--' ? secondaryType : primaryType;
  const type = hasExplicitSize ? resolvedType : 'Label';
  return {
    name,
    address,
    size,
    type,
    object,
    module: modulePath ? toModuleDisplayName(modulePath) : (objectToModule.get(object) ?? 'Unknown')
  };
}

function parseEntryList(lines: string[], moduleById: Map<number, string>, objectToModule: Map<string, string>): MapSymbol[] {
  const symbols: MapSymbol[] = [];
  let pendingName = '';

  for (const rawLine of lines) {
    const line = rawLine.replace(/\r/g, '');
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('Entry') || trimmed.startsWith('------')) {
      continue;
    }
    if (/^\[\d+\]\s*=/.test(trimmed)) {
      break;
    }
    if (trimmed.startsWith('Errors:') || trimmed.startsWith('Warnings:') || trimmed.includes('bytes of')) {
      continue;
    }

    const addressMatch = line.match(HEX_IN_LINE_RE);
    if (!addressMatch || addressMatch.index === undefined) {
      pendingName = trimmed;
      continue;
    }

    const nameInLine = line.slice(0, addressMatch.index).trim();
    const resolvedName = nameInLine || pendingName;
    if (!resolvedName) {
      pendingName = '';
      continue;
    }

    const tail = line.slice(addressMatch.index).trim();
    const row = parseEntryRow(resolvedName, tail, moduleById, objectToModule);
    pendingName = '';
    if (!row) {
      continue;
    }

    symbols.push(row);
  }

  symbols.sort((a, b) => a.address - b.address || b.size - a.size);
  return symbols;
}

function parseConfiguredRegions(memoryConfigStr?: string): ParsedRegion[] {
  if (!memoryConfigStr) {
    return [];
  }

  try {
    const config = JSON.parse(memoryConfigStr) as { regions?: Array<{ name: string; start: string; size: string }> };
    const regions = config.regions ?? [];
    return regions
      .map((region) => ({
        name: region.name,
        start: parseInt(region.start, 16),
        size: parseMemSize(region.size),
        type: 'ConfiguredRegion' as const
      }))
      .filter((region) => Number.isFinite(region.start) && Number.isFinite(region.size) && region.size > 0);
  } catch {
    return [];
  }
}

function pickRegion(symbol: MapSymbol, configured: ParsedRegion[], placement: ParsedRegion[]): ParsedRegion | null {
  const symbolEnd = symbol.address + symbol.size;

  for (const region of configured) {
    const regionEnd = region.start + region.size;
    if (symbol.address >= region.start && symbolEnd <= regionEnd) {
      return region;
    }
  }

  const placementCandidates = placement.filter((region) => {
    const regionEnd = region.start + region.size;
    return symbol.address >= region.start && symbol.address < regionEnd;
  });

  if (placementCandidates.length === 0) {
    return null;
  }

  placementCandidates.sort((a, b) => a.size - b.size || a.start - b.start);
  return placementCandidates[0];
}

function createNode(name: string, address: number, type: string): MemoryNode {
  return {
    name,
    address,
    size: 0,
    type,
    children: []
  };
}

function finalizeNodeSize(node: MemoryNode, keepOwnSize = false): number {
  if (node.children.length === 0) {
    node.size = Math.max(node.size, 0);
    return node.size;
  }

  let maxEnd = node.address;
  for (const child of node.children) {
    finalizeNodeSize(child);
    const childEnd = child.address + child.size;
    if (childEnd > maxEnd) {
      maxEnd = childEnd;
    }
  }

  const childSpan = Math.max(maxEnd - node.address, 0);
  const preserveOwn = keepOwnSize || node.type === 'Object';
  node.size = preserveOwn ? Math.max(node.size, childSpan) : childSpan;
  return node.size;
}

function nodeEnd(node: MemoryNode): number {
  return node.address + Math.max(node.size, 0);
}

function isAutoRangeName(name: string): boolean {
  return /^0x[0-9a-fA-F]+\s*-\s*0x[0-9a-fA-F]+$/.test(name.trim());
}

function mergeRootNames(currentName: string, nextName: string): string {
  const splitNames = (value: string) => value.split('/').map((item) => item.trim()).filter(Boolean);
  const merged = [...splitNames(currentName), ...splitNames(nextName)];
  const deduped: string[] = [];

  for (const item of merged) {
    if (!deduped.includes(item)) {
      deduped.push(item);
    }
  }

  const nonAuto = deduped.filter((item) => !isAutoRangeName(item));
  const picked = nonAuto.length > 0 ? nonAuto : deduped;
  return picked.join('/');
}

function mergeContiguousRoots(roots: MemoryNode[], segmentGapToleranceBytes: number): MemoryNode[] {
  if (roots.length < 2) {
    return roots;
  }

  const sortedRoots = [...roots].sort((a, b) => a.address - b.address || a.size - b.size);
  const merged: MemoryNode[] = [sortedRoots[0]];

  for (let i = 1; i < sortedRoots.length; i++) {
    const next = sortedRoots[i];
    const current = merged[merged.length - 1];

    const contiguousOrOverlap = next.address <= nodeEnd(current) + segmentGapToleranceBytes;
    if (!contiguousOrOverlap) {
      merged.push(next);
      continue;
    }

    current.children.push(...next.children);
    current.children.sort((a, b) => a.address - b.address || a.size - b.size);
    current.size = Math.max(nodeEnd(current), nodeEnd(next)) - current.address;
    current.name = mergeRootNames(current.name, next.name);
    if (current.type !== next.type) {
      current.type = 'Region';
    }
  }

  for (const root of merged) {
    const keepOwnSize = root.type === 'ConfiguredRegion' || root.type === 'PlacementRegion';
    finalizeNodeSize(root, keepOwnSize);
    if (root.type === 'Region' && isAutoRangeName(root.name)) {
      const end = root.address + root.size;
      root.name = `0x${root.address.toString(16).toUpperCase()} - 0x${end.toString(16).toUpperCase()}`;
    }
  }

  return merged;
}

function intersectRange(startA: number, endA: number, startB: number, endB: number): AddressRange | null {
  const start = Math.max(startA, startB);
  const end = Math.min(endA, endB);
  return end > start ? { start, end } : null;
}

function collectUsedIntervals(node: MemoryNode): AddressRange[] {
  const intervals: AddressRange[] = [];

  const visit = (current: MemoryNode) => {
    if (current.type === 'Unused') {
      return;
    }

    if (current.children.length === 0) {
      intervals.push({ start: current.address, end: current.address + Math.max(current.size, 1) });
      return;
    }

    for (const child of current.children) {
      visit(child);
    }
  };

  visit(node);
  return intervals;
}

function mergeIntervals(intervals: AddressRange[]): AddressRange[] {
  if (intervals.length === 0) {
    return [];
  }

  const sorted = [...intervals].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: AddressRange[] = [sorted[0]];

  for (let i = 1; i < sorted.length; i++) {
    const current = merged[merged.length - 1];
    const next = sorted[i];
    if (next.start <= current.end) {
      current.end = Math.max(current.end, next.end);
      continue;
    }
    merged.push({ ...next });
  }

  return merged;
}

function sumRangeSize(intervals: AddressRange[]): number {
  let total = 0;
  for (const range of intervals) {
    total += range.end - range.start;
  }
  return total;
}

function appendUnusedNodesAndStats(roots: MemoryNode[], unusedRanges: AddressRange[]): void {
  for (const root of roots) {
    const rootStart = root.address;
    const rootEnd = root.address + Math.max(root.size, 0);
    const unusedInRoot: AddressRange[] = [];

    for (const unused of unusedRanges) {
      const overlap = intersectRange(rootStart, rootEnd, unused.start, unused.end);
      if (!overlap) {
        continue;
      }
      unusedInRoot.push(overlap);
    }

    for (const range of unusedInRoot) {
      const startHex = `0x${range.start.toString(16).toUpperCase()}`;
      const endHex = `0x${range.end.toString(16).toUpperCase()}`;
      root.children.push({
        name: `Unused ${startHex} - ${endHex}`,
        address: range.start,
        size: range.end - range.start,
        type: 'Unused',
        children: []
      });
    }

    root.children.sort((a, b) => a.address - b.address || a.size - b.size);

    const mergedUsed = mergeIntervals(collectUsedIntervals(root));
    const usedBytes = sumRangeSize(mergedUsed);
    const explicitUnusedBytes = sumRangeSize(unusedInRoot);

    let holeBytes = 0;
    if (mergedUsed.length > 0) {
      const first = mergedUsed[0].start;
      const last = mergedUsed[mergedUsed.length - 1].end;
      holeBytes = Math.max((last - first) - usedBytes, 0);
    }

    const totalBytes = Math.max(root.size, 0);
    const inferredUnused = Math.max(totalBytes - usedBytes, 0);
    const unusedBytes = explicitUnusedBytes > 0 ? explicitUnusedBytes : inferredUnused;

    root.totalBytes = totalBytes;
    root.usedBytes = Math.min(usedBytes, totalBytes);
    root.unusedBytes = Math.min(unusedBytes, totalBytes);
    root.holeBytes = Math.min(holeBytes, totalBytes);
    root.utilization = totalBytes > 0 ? root.usedBytes / totalBytes : 0;
  }
}

function buildMemoryTree(
  symbols: MapSymbol[],
  configuredRegions: ParsedRegion[],
  placementRegions: ParsedRegion[],
  unusedRanges: AddressRange[],
  placementObjectRanges: ObjectRangeMap,
  segmentGapToleranceBytes: number
): MemoryNode[] {
  const roots: MemoryNode[] = [];
  let currentRegion: MemoryNode | null = null;
  let currentEnd = -1;
  let currentRegionKey = '';
  let currentObject: MemoryNode | null = null;
  let currentObjectKey = '';
  let currentObjectContinuityEnd = -1;
  let currentObjectAreaEnd = -1;

  for (const symbol of symbols) {
    const region = pickRegion(symbol, configuredRegions, placementRegions);
    const regionName = region?.name ?? 'Continuous Block';
    const regionType = region?.type ?? 'Region';
    const regionKey = region ? `${region.type}:${region.start}:${region.size}:${region.name}` : '';
    const newRegionRequired =
      !currentRegion ||
      (regionKey && regionKey !== currentRegionKey) ||
      (!regionKey && symbol.address > currentEnd + segmentGapToleranceBytes);

    if (newRegionRequired) {
      const regionStart = region ? region.start : symbol.address;
      currentRegion = createNode(regionName, regionStart, regionType);
      if (region) {
        currentRegion.size = region.size;
      }
      roots.push(currentRegion);
      currentRegionKey = regionKey;
      currentObject = null;
      currentObjectKey = '';
      currentObjectContinuityEnd = -1;
      currentObjectAreaEnd = -1;
    }

    const symbolEnd = symbol.address + Math.max(symbol.size, 0);
    const objectKey = `${symbol.module}::${symbol.object}`;
    const placementRange = findRangeContainingAddress(placementObjectRanges, objectKey, symbol.address);
    const effectiveEnd = Math.max(symbolEnd, placementRange?.end ?? symbolEnd);
    currentEnd = Math.max(currentEnd, symbolEnd);
    const isSameObjectSegment =
      currentObject !== null &&
      currentObjectKey === objectKey &&
      symbol.address <= currentObjectContinuityEnd + segmentGapToleranceBytes;

    if (!isSameObjectSegment) {
      const objectName = symbol.module !== 'Unknown' ? `${symbol.object} (${symbol.module})` : symbol.object;
      currentObject = createNode(objectName, symbol.address, 'Object');
      currentRegion!.children.push(currentObject);
      currentObjectKey = objectKey;
      currentObjectContinuityEnd = symbolEnd;
      currentObjectAreaEnd = effectiveEnd;
    } else {
      currentObjectContinuityEnd = Math.max(currentObjectContinuityEnd, symbolEnd);
      currentObjectAreaEnd = Math.max(currentObjectAreaEnd, effectiveEnd);
    }

    currentObject!.size = Math.max(currentObject!.size, currentObjectAreaEnd - currentObject!.address);

    currentObject!.children.push({
      name: symbol.name,
      address: symbol.address,
      size: symbol.size,
      type: symbol.type,
      children: []
    });
  }

  for (const root of roots) {
    const keepOwnSize = root.type === 'ConfiguredRegion' || root.type === 'PlacementRegion';
    finalizeNodeSize(root, keepOwnSize);
    if (root.type === 'Region' && root.name === 'Continuous Block') {
      const end = root.address + root.size;
      root.name = `0x${root.address.toString(16).toUpperCase()} - 0x${end.toString(16).toUpperCase()}`;
    }
  }

  const mergedRoots = mergeContiguousRoots(roots, segmentGapToleranceBytes);
  appendUnusedNodesAndStats(mergedRoots, unusedRanges);
  return mergedRoots;
}

export function parseIarMap(mapContent: string, memoryConfigStr?: string, options?: ParseIarMapOptions): MemoryNode[] {
  const tolerance = options?.segmentGapToleranceBytes;
  const segmentGapToleranceBytes = Number.isFinite(tolerance)
    ? Math.max(Math.floor(tolerance as number), 0)
    : DEFAULT_SEGMENT_GAP_TOLERANCE_BYTES;

  const normalized = mapContent.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = normalized.split('\n');

  const placementSummary = extractSection(lines, SECTION_PLACEMENT_SUMMARY);
  const moduleSummary = extractSection(lines, SECTION_MODULE_SUMMARY);
  const entryList = extractSection(lines, SECTION_ENTRY_LIST);

  const moduleById = parseModuleIndex(entryList);
  const placementRegions = parsePlacementRegions(placementSummary);
  const unusedRanges = parseUnusedRanges(placementSummary);
  const placementObjectRanges = parsePlacementObjectRanges(placementSummary, moduleById);
  const objectToModule = parseModuleSummary(moduleSummary);
  const symbols = parseEntryList(entryList, moduleById, objectToModule);
  const configuredRegions = parseConfiguredRegions(memoryConfigStr);

  return buildMemoryTree(
    symbols,
    configuredRegions,
    placementRegions,
    unusedRanges,
    placementObjectRanges,
    segmentGapToleranceBytes
  );
}
