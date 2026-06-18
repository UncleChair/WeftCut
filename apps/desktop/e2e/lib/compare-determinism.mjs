// Usage: node compare-determinism.mjs <dirA> <dirB> [<dirC>] --threshold 0.98
// Compares same-named PNGs across OS dirs. Positives (no NEG- prefix) must be
// >= threshold across ALL pairs; the NEG- control must be < threshold on >=1 pair.
import { readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { ssimOfPngFiles } from './image-ssim.mjs'

const args = process.argv.slice(2)
const ti = args.indexOf('--threshold')
const threshold = ti >= 0 ? parseFloat(args[ti + 1]) : 0.98
const dirs = args.filter((a, i) => !a.startsWith('--') && i !== ti + 1)
if (dirs.length < 2) { console.error('need >=2 OS dirs'); process.exit(2) }

// Build filename set from the UNION of all dirs so a PNG present in only one dir is surfaced.
const nameSet = new Set()
for (const d of dirs) {
  try { readdirSync(d).filter((f) => f.endsWith('.png')).forEach((f) => nameSet.add(f)) }
  catch (e) { console.error(`ERROR reading dir ${d}: ${e.message}`); process.exit(2) }
}
const names = [...nameSet].sort()
let failed = false, negBelow = false
for (const name of names) {
  for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
    let s
    try {
      s = ssimOfPngFiles(join(dirs[i], name), join(dirs[j], name))
    } catch (e) {
      console.error(`MISSING/ERROR ${name} ${basename(dirs[i])}/${basename(dirs[j])}: ${e.message}`)
      failed = true
      continue
    }
    const isNeg = basename(name).startsWith('NEG-')
    const tag = isNeg ? 'NEG' : 'POS'
    console.log(`${tag} ${name} ${basename(dirs[i])}/${basename(dirs[j])} ssim=${s.toFixed(4)}`)
    if (isNeg) { if (s < threshold) negBelow = true }
    else if (s < threshold) { failed = true; console.error(`  FAIL: ${name} < ${threshold}`) }
  }
}
if (!negBelow) { console.error('FAIL: negative control never fell below threshold — gate has no teeth'); failed = true }
process.exit(failed ? 1 : 0)
