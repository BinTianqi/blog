/**
 * It seems that nested CSS selectors don't work on older browsers.
 * Lightning CSS not only minifies the codes ,but also adds compability
 */

import { transform } from "lightningcss"
import path from "node:path"

const cssDir = "build/css"

for (const entry of Deno.readDirSync(cssDir)) {
    const fullPath = path.join(cssDir, entry.name)
    const buf = Deno.readFileSync(fullPath)
    const result = transform({
        filename: entry.name,
        code: buf,
        targets: { chrome: 100 },
        minify: true
    })
    Deno.writeFileSync(fullPath, result.code)
    console.log(`Transformed ${entry.name}`)
}
