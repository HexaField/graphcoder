#!/usr/bin/env node
/**
 * GraphCoder CLI
 *
 * graphcoder check [path]                  Validate annotations against CodeGraph
 * graphcoder digest [path] [--json]        Render annotations as structured text
 * graphcoder import-prs [path] --base X --tip Y   Import a PR stack as annotations
 */
import chalk from 'chalk'
import { resolve } from 'node:path'
import process from 'node:process'
import { checkCommand } from './commands/check.js'
import { digestCommand } from './commands/digest.js'
import { importPrsCommand } from './commands/import-prs.js'

const args = process.argv.slice(2)
const command = args[0]

function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`)
  if (idx === -1 || idx + 1 >= args.length) return undefined
  return args[idx + 1]
}

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`)
}

/** First positional arg after the command that doesn't start with `--`. */
function positionalPath(): string {
  for (let i = 1; i < args.length; i++) {
    if (!args[i].startsWith('--')) return resolve(args[i])
    // Skip the value of a flag
    if (args[i].startsWith('--') && i + 1 < args.length && !args[i + 1].startsWith('--')) i++
  }
  return process.cwd()
}

if (!command || command === 'help' || command === '--help') {
  console.log(chalk.cyan('GraphCoder CLI\n'))
  console.log('Usage:')
  console.log('  graphcoder check [path]                       Validate annotations')
  console.log('  graphcoder digest [path] [--json]             Render annotations')
  console.log('  graphcoder import-prs [path] --base X --tip Y Import PR stack')
  console.log('  graphcoder help                               Show this help')
  process.exit(0)
}

const targetPath = positionalPath()

switch (command) {
  case 'check':
    checkCommand(targetPath).catch((err: unknown) => {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : err)
      process.exit(2)
    })
    break

  case 'digest':
    digestCommand(targetPath, { json: hasFlag('json') }).catch((err: unknown) => {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : err)
      process.exit(2)
    })
    break

  case 'import-prs': {
    const base = flag('base')
    const tip = flag('tip')
    if (!base || !tip) {
      console.error(chalk.red('Both --base and --tip are required'))
      console.log('  graphcoder import-prs [path] --base dev --tip feat/my-branch')
      process.exit(2)
    }
    importPrsCommand(targetPath, { base, tip }).catch((err: unknown) => {
      console.error(chalk.red('Error:'), err instanceof Error ? err.message : err)
      process.exit(2)
    })
    break
  }

  default:
    console.error(chalk.red(`Unknown command: ${command}`))
    console.log('Run `graphcoder help` for available commands.')
    process.exit(1)
}
