import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { inflateSync } from 'node:zlib'

import { MATRIX, ensureFixtures } from './generate-fixtures.mjs'
import {
  drawtextFontFile,
  generateFixture,
  outputName,
  runFfmpeg,
} from './generate.mjs'

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
  }
  return value >>> 0
})

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

function decodeRgbaPng(buffer) {
  assert.deepEqual([...buffer.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10])
  const imageData = []
  let width
  let height
  let offset = 8

  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    const dataStart = offset + 8
    const dataEnd = dataStart + length
    const checksum = buffer.readUInt32BE(dataEnd)
    assert.equal(checksum, crc32(buffer.subarray(offset + 4, dataEnd)), `${type} CRC`)

    if (type === 'IHDR') {
      width = buffer.readUInt32BE(dataStart)
      height = buffer.readUInt32BE(dataStart + 4)
      assert.equal(buffer[dataStart + 8], 8)
      assert.equal(buffer[dataStart + 9], 6)
    } else if (type === 'IDAT') {
      imageData.push(buffer.subarray(dataStart, dataEnd))
    } else if (type === 'IEND') {
      break
    }
    offset = dataEnd + 4
  }

  return { width, height, scanlines: inflateSync(Buffer.concat(imageData)) }
}

test('the fixture matrix has one unique output name per entry', () => {
  const names = MATRIX.map(outputName)

  assert.equal(new Set(names).size, names.length)
})

test('runFfmpeg preserves a spaced cwd and never invokes a shell', () => {
  const outputDir = path.join(tmpdir(), 'WeftCut fixtures with spaces')
  let invocation

  runFfmpeg(['-version'], {
    cwd: outputDir,
    spawn(command, args, options) {
      invocation = { command, args, options }
      return { status: 0 }
    },
  })

  assert.deepEqual(invocation, {
    command: 'ffmpeg',
    args: ['-version'],
    options: {
      cwd: outputDir,
      shell: false,
      stdio: 'inherit',
    },
  })
})

test('ensureFixtures calls the JavaScript generator in the target directory', async () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut-fixture-test-'))
  const outputDir = path.join(parent, 'media with spaces')
  const entry = { fps: 30, format: 'mp4' }
  const calls = []

  try {
    await ensureFixtures(outputDir, {
      matrix: [entry],
      generate(current, options) {
        calls.push({ current, options })
        writeFileSync(path.join(options.outputDir, outputName(current)), 'fixture')
      },
    })

    assert.deepEqual(calls, [{
      current: entry,
      options: { outputDir },
    }])
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('every matrix entry runs through the JavaScript generator in a spaced path', () => {
  const parent = mkdtempSync(path.join(tmpdir(), 'weftcut fixture matrix '))

  try {
    for (const [index, entry] of MATRIX.entries()) {
      const outputDir = path.join(parent, `entry ${index}`)
      const calls = []

      generateFixture(entry, {
        outputDir,
        run(args, options) {
          calls.push(args)
          assert.equal(options.cwd, outputDir)
          assert.ok(args.every((arg) => typeof arg === 'string'))
          assert.ok(args.every((arg) => !arg.includes(outputDir)))
          writeFileSync(path.join(options.cwd, args.at(-1)), 'fixture')
        },
      })

      assert.ok(calls.length > 0, `${outputName(entry)} did not invoke ffmpeg`)
      assert.ok(
        existsSync(path.join(outputDir, outputName(entry))),
        `${outputName(entry)} was not produced`,
      )
    }
  } finally {
    rmSync(parent, { recursive: true, force: true })
  }
})

test('Windows font paths use WINDIR and are escaped for drawtext', () => {
  const font = drawtextFontFile({
    platform: 'win32',
    env: { WINDIR: String.raw`D:\Windows` },
    fileExists: (candidate) => candidate === String.raw`D:\Windows\Fonts\consola.ttf`,
  })

  assert.equal(font, String.raw`D\:/Windows/Fonts/consola.ttf`)
})

test('the JavaScript generator writes a valid chart PNG and manifest itself', () => {
  const outputDir = mkdtempSync(path.join(tmpdir(), 'weftcut-chart-test-'))

  try {
    generateFixture({ color: '709ltd' }, {
      outputDir,
      run(args, options) {
        writeFileSync(path.join(options.cwd, args.at(-1)), 'fixture')
      },
    })

    const png = readFileSync(path.join(outputDir, 'color_chart.png'))
    const image = decodeRgbaPng(png)
    const manifest = JSON.parse(readFileSync(path.join(outputDir, 'color_manifest.json'), 'utf8'))
    const firstPixel = image.scanlines.subarray(1, 5)

    assert.equal(image.width, 1920)
    assert.equal(image.height, 1080)
    assert.equal(image.scanlines[0], 0)
    assert.deepEqual([...firstPixel], [255, 0, 0, 255])
    assert.equal(manifest.patches.length, 20)
    assert.deepEqual(manifest.patches[0], {
      id: 'red', x: 0, y: 0, w: 384, h: 270, rgb: [255, 0, 0],
    })
  } finally {
    rmSync(outputDir, { recursive: true, force: true })
  }
})
