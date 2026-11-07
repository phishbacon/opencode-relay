import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import test from "node:test"

const root = fileURLToPath(new URL("..", import.meta.url))

test("workspace contains the plugin and front-door server packages", async () => {
  for (const name of ["plugin", "server"]) {
    const manifest = JSON.parse(
      await readFile(join(root, "packages", name, "package.json"), "utf8"),
    )
    assert.equal(manifest.name, `@opencode-relay/${name}`)
  }

  await assert.rejects(
    readFile(join(root, "packages", "pwa", "package.json"), "utf8"),
    (error) => error?.code === "ENOENT",
  )
})

test("workspace requires pnpm and the V2 plugin dependency", async () => {
  const rootManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
  const pluginManifest = JSON.parse(
    await readFile(join(root, "packages/plugin/package.json"), "utf8"),
  )

  assert.match(rootManifest.packageManager, /^pnpm@10\./)
  assert.ok(pluginManifest.dependencies["@opencode/plugin"])
  assert.equal(pluginManifest.dependencies["@opencode-ai/plugin"], undefined)
})
