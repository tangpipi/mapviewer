import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { parseIarMap, type MemoryNode } from '../src/parser/iar-parser';

function flatten(nodes: MemoryNode[]): MemoryNode[] {
  const out: MemoryNode[] = [];
  const stack = [...nodes];
  while (stack.length > 0) {
    const node = stack.shift()!;
    out.push(node);
    stack.unshift(...node.children);
  }
  return out;
}

function parseHex(value: string): number {
  return parseInt(value.replace(/'/g, ''), 16)
}

function toBaseObjectName(rawObject: string): string {
  const cleaned = rawObject.trim().replace(/^"|"$/g, '')
  const pieces = cleaned.split(/[\\/]/)
  return pieces[pieces.length - 1] || cleaned
}

function toModuleDisplayName(modulePath: string): string {
  const cleaned = modulePath.trim().replace(/^"|"$/g, '')
  const pieces = cleaned.split(/[\\/]/)
  return pieces[pieces.length - 1] || cleaned
}

function collectPlacementBackedObjectNames(mapText: string): Set<string> {
  const moduleById = new Map<number, string>()
  for (const line of mapText.split(/\r?\n/)) {
    const matched = line.trim().match(/^\[(\d+)\]\s*=\s*(.+)$/)
    if (matched) {
      moduleById.set(Number(matched[1]), matched[2])
    }
  }

  const names = new Set<string>()
  for (const line of mapText.split(/\r?\n/)) {
    const matched = line.match(/(0x[0-9a-fA-F']+)\s+\d+\s+(0x[0-9a-fA-F']+)\s+([^\s"']+\.o)\s+\[(\d+)\]\s*$/)
    if (!matched) {
      continue
    }

    const size = parseHex(matched[2])
    if (!Number.isFinite(size) || size <= 0) {
      continue
    }

    const objectName = toBaseObjectName(matched[3])
    const modulePath = moduleById.get(Number(matched[4])) ?? 'Unknown'
    const moduleName = toModuleDisplayName(modulePath)
    names.add(`${objectName} (${moduleName})`)
  }

  return names
}

describe('parseIarMap', () => {
  const root = resolve(__dirname, '..', '..');
  const map1 = resolve(root, 'examples', 'example1.map');
  const map2 = resolve(root, 'examples', 'example2.map');
  const configPath = resolve(root, 'memory_config.json');
  const hasMap1 = existsSync(map1)
  const hasMap2 = existsSync(map2)
  const hasExampleMaps = hasMap1 && hasMap2

  ;(hasMap1 ? it : it.skip)('builds non-empty region/object/symbol hierarchy from example1.map', () => {
    const mapText = readFileSync(map1, 'utf8');
    const regions = parseIarMap(mapText);

    expect(regions.length).toBeGreaterThan(0);
    expect(regions.every((region) => region.size > 0)).toBe(true);

    const allNodes = flatten(regions);
    expect(allNodes.some((node) => node.type === 'PlacementRegion')).toBe(true);
    expect(allNodes.some((node) => node.type === 'Object' && node.name.includes('.o'))).toBe(true);
    expect(allNodes.some((node) => node.children.length === 0 && (node.type === 'Code' || node.type === 'Data'))).toBe(true);
    expect(allNodes.some((node) => node.type === 'Unused')).toBe(true);
    expect(regions.some((region) => typeof region.utilization === 'number')).toBe(true);
  });

  ;(hasMap2 ? it : it.skip)('keeps ascending root address order in example2.map', () => {
    const mapText = readFileSync(map2, 'utf8');
    const regions = parseIarMap(mapText);

    expect(regions.length).toBeGreaterThan(0);

    for (let i = 1; i < regions.length; i++) {
      expect(regions[i - 1].address).toBeLessThanOrEqual(regions[i].address);
    }
  });

  ;(hasMap1 ? it : it.skip)('extracts multiline symbol entries from entry list', () => {
    const mapText = readFileSync(map1, 'utf8');
    const regions = parseIarMap(mapText);
    const allNodes = flatten(regions);

    expect(allNodes.some((node) => node.name === 'FreeRTOS_AddNetworkInterface')).toBe(true);
  });

  ;(hasMap1 ? it : it.skip)('resolves object module label from [id] map in entry list', () => {
    const mapText = readFileSync(map1, 'utf8');
    const regions = parseIarMap(mapText);
    const allNodes = flatten(regions);

    expect(allNodes.some((node) => node.type === 'Object' && node.name.includes('startup_core.o') && node.name.includes('fsp_'))).toBe(true);
  });

  ;(hasMap1 ? it : it.skip)('uses configured regions when memory config is provided', () => {
    const mapText = readFileSync(map1, 'utf8');
    const config = readFileSync(configPath, 'utf8');
    const configJson = JSON.parse(config) as { regions: Array<{ name: string }> };
    const configuredNames = new Set(configJson.regions.map((item) => item.name));

    const regions = parseIarMap(mapText, config);
    const configuredRegions = regions.filter((node) => node.type === 'ConfiguredRegion');

    expect(configuredRegions.length).toBeGreaterThan(0);
    expect(configuredRegions.every((node) => configuredNames.has(node.name))).toBe(true);
  });

  it('merges contiguous roots with same region key', () => {
    const mapText = `
*******************************************************************************
*** PLACEMENT SUMMARY
***
"P1": place in [from 0x100 to 0x1ff] { rw };

*******************************************************************************
*** MODULE SUMMARY
***

*******************************************************************************
*** ENTRY LIST
***
Entry                       Address    Size  Type      Object
-----                       -------    ----  ----      ------
sym_a                        0x100      0x10  Code  Gb  foo.o [1]
sym_b                        0x110      0x10  Code  Gb  foo.o [1]

[1] = demo.dir
`

    const regions = parseIarMap(mapText)
    const p1Regions = regions.filter((node) => node.type === 'PlacementRegion' && node.name === 'P1')

    expect(p1Regions.length).toBe(1)
  })

  it('merges contiguous roots by address even when placement region names differ', () => {
    const mapText = `
*******************************************************************************
*** PLACEMENT SUMMARY
***
"P1": place in [from 0x100 to 0x11f] { rw };
"P2": place in [from 0x120 to 0x13f] { rw };

*******************************************************************************
*** MODULE SUMMARY
***

*******************************************************************************
*** ENTRY LIST
***
Entry                       Address    Size  Type      Object
-----                       -------    ----  ----      ------
sym_a                        0x100      0x10  Code  Gb  foo.o [1]
sym_b                        0x120      0x10  Code  Gb  bar.o [1]

[1] = demo.dir
`

    const regions = parseIarMap(mapText)
    expect(regions.length).toBe(1)
    expect(regions[0].name).toContain('P1')
    expect(regions[0].name).toContain('P2')
  })

  it('merges roots when the hole is within 64 bytes', () => {
    const mapText = `
*******************************************************************************
*** PLACEMENT SUMMARY
***

*******************************************************************************
*** MODULE SUMMARY
***

*******************************************************************************
*** ENTRY LIST
***
Entry                       Address    Size  Type      Object
-----                       -------    ----  ----      ------
sym_a                        0x100      0x10  Code  Gb  foo.o [1]
sym_b                        0x150      0x10  Code  Gb  bar.o [1]

[1] = demo.dir
`

    const regions = parseIarMap(mapText)
    expect(regions.length).toBe(1)
  })

  it('splits roots when the hole is larger than 64 bytes', () => {
    const mapText = `
*******************************************************************************
*** PLACEMENT SUMMARY
***

*******************************************************************************
*** MODULE SUMMARY
***

*******************************************************************************
*** ENTRY LIST
***
Entry                       Address    Size  Type      Object
-----                       -------    ----  ----      ------
sym_a                        0x100      0x10  Code  Gb  foo.o [1]
sym_b                        0x151      0x10  Code  Gb  bar.o [1]

[1] = demo.dir
`

    const regions = parseIarMap(mapText)
    expect(regions.length).toBe(2)
  })

  it('applies custom segment merge threshold from parse options', () => {
    const mapText = `
*******************************************************************************
*** PLACEMENT SUMMARY
***

*******************************************************************************
*** MODULE SUMMARY
***

*******************************************************************************
*** ENTRY LIST
***
Entry                       Address    Size  Type      Object
-----                       -------    ----  ----      ------
sym_a                        0x100      0x10  Code  Gb  foo.o [1]
sym_b                        0x130      0x10  Code  Gb  bar.o [1]

[1] = demo.dir
`

    const defaultRegions = parseIarMap(mapText)
    const strictRegions = parseIarMap(mapText, undefined, { segmentGapToleranceBytes: 8 })

    expect(defaultRegions.length).toBe(1)
    expect(strictRegions.length).toBe(2)
  })

  it('injects unused nodes and computes utilization from placement unused ranges', () => {
    const mapText = `
*******************************************************************************
*** PLACEMENT SUMMARY
***
"P1": place in [from 0x100 to 0x1ff] { rw };
Unused ranges:

         From           To        Size
         ----           --        ----
       0x100        0x11f        0x20
       0x140        0x17f        0x40
       0x1a0        0x1ff        0x60

*******************************************************************************
*** MODULE SUMMARY
***

*******************************************************************************
*** ENTRY LIST
***
Entry                       Address    Size  Type      Object
-----                       -------    ----  ----      ------
sym_a                        0x120      0x20  Code  Gb  foo.o [1]
sym_b                        0x180      0x20  Code  Gb  bar.o [1]

[1] = demo.dir
`

    const regions = parseIarMap(mapText)
    const p1 = regions.find((node) => node.type === 'PlacementRegion' && node.name === 'P1')
    expect(p1).toBeDefined()
    expect(p1!.totalBytes).toBe(0x100)
    expect(p1!.usedBytes).toBe(0x40)
    expect(p1!.unusedBytes).toBe(0xc0)
    expect(p1!.utilization).toBeCloseTo(0.25, 5)
    expect(p1!.children.filter((node) => node.type === 'Unused').length).toBeGreaterThan(0)
  })

  it('treats no-size entries as labels instead of 1-byte areas', () => {
    const mapText = `
*******************************************************************************
*** PLACEMENT SUMMARY
***
"P1": place in [from 0x100 to 0x1ff] { rw };

*******************************************************************************
*** MODULE SUMMARY
***

*******************************************************************************
*** ENTRY LIST
***
Entry                       Address    Size  Type      Object
-----                       -------    ----  ----      ------
real_func                    0x120      0x20  Code  Gb  foo.o [1]
real_func_alias              0x120            Code  Gb  foo.o [1]

[1] = demo.dir
`

    const regions = parseIarMap(mapText)
    const allNodes = flatten(regions)
    const labelNode = allNodes.find((node) => node.name === 'real_func_alias')
    const p1 = regions.find((node) => node.name === 'P1')

    expect(labelNode).toBeDefined()
    expect(labelNode!.type).toBe('Label')
    expect(labelNode!.size).toBe(0)
    expect(p1!.usedBytes).toBe(0x20)
  })

  ;(hasMap1 ? it : it.skip)('keeps object area from placement summary for label-only symbols (I64DivMod)', () => {
    const mapText = readFileSync(map1, 'utf8')
    const regions = parseIarMap(mapText)
    const allNodes = flatten(regions)

    const objectNode = allNodes.find((node) => node.type === 'Object' && node.name.includes('I64DivMod.o'))
    const symbolNode = allNodes.find((node) => node.name === '__aeabi_uldivmod')

    expect(objectNode).toBeDefined()
    expect(objectNode!.size).toBeGreaterThan(0)
    expect(symbolNode).toBeDefined()
    expect(symbolNode!.type).toBe('Label')
    expect(symbolNode!.size).toBe(0)
  })

  ;(hasExampleMaps ? it : it.skip)('does not drop area for placement-backed objects in example maps', () => {
    for (const mapPath of [map1, map2]) {
      const mapText = readFileSync(mapPath, 'utf8')
      const placementBacked = collectPlacementBackedObjectNames(mapText)
      const nodes = flatten(parseIarMap(mapText))
      const objects = nodes.filter((node) => node.type === 'Object')
      const dropped = objects.filter((node) => placementBacked.has(node.name) && node.size <= 0)
      expect(dropped.length).toBe(0)
    }
  })
});
