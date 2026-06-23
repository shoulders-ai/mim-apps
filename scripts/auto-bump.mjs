#!/usr/bin/env node
//
// Auto-bump patch version for packages whose source changed since their
// last version bump. Skips packages where the version was already manually
// changed in this push.
//
// Run: node scripts/auto-bump.mjs
//
import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs'
import { join, dirname } from 'path'
import { execSync } from 'child_process'
import { fileURLToPath } from 'url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkgDir = join(ROOT, 'packages')

function git(cmd) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8' }).trim()
}

function bumpPatch(version) {
  const [major, minor, patch] = version.split('.').map(Number)
  return `${major}.${minor}.${patch + 1}`
}

let bumped = 0

for (const name of readdirSync(pkgDir).sort()) {
  const pkgJsonPath = join(pkgDir, name, 'package.json')
  try { statSync(pkgJsonPath) } catch { continue }

  const raw = readFileSync(pkgJsonPath, 'utf8')
  const pkg = JSON.parse(raw)
  if (!pkg.mim?.id) continue

  const pkgPath = `packages/${name}`

  // Find the last commit that touched the version line (-G matches line content, not count)
  let lastVersionCommit
  try {
    lastVersionCommit = git(
      `git log -1 --format=%H -G '"version": "' -- "${pkgPath}/package.json"`
    )
  } catch { continue }

  if (!lastVersionCommit) continue

  // Check if source files changed since that version commit
  let changed
  try {
    changed = git(`git diff --name-only ${lastVersionCommit}..HEAD -- "${pkgPath}"`)
  } catch { continue }

  if (!changed) continue

  // Filter out package.json-only changes
  const changedFiles = changed.split('\n').filter(f => f && f !== `${pkgPath}/package.json`)
  if (changedFiles.length === 0) continue

  // Check if version was already manually bumped in HEAD vs that commit
  let oldPkg
  try {
    const oldContent = git(`git show ${lastVersionCommit}:"${pkgPath}/package.json"`)
    oldPkg = JSON.parse(oldContent)
  } catch { continue }

  if (pkg.version !== oldPkg.version) {
    console.log(`${name}: version already changed (${oldPkg.version} → ${pkg.version}), skipping`)
    continue
  }

  // Surgical replacement — only touch the version line, preserve formatting
  const newVersion = bumpPatch(pkg.version)
  const updated = raw.replace(
    `"version": "${pkg.version}"`,
    `"version": "${newVersion}"`
  )
  writeFileSync(pkgJsonPath, updated)
  console.log(`${name}: ${pkg.version} → ${newVersion}`)
  bumped++
}

console.log(`\n${bumped} package(s) bumped`)
