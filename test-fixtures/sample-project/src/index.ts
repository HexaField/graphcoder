import { processShape } from './api.js'

/**
 * Main entry point.
 */
export function main(): void {
  const result = processShape({ width: 10, height: 5 })
  console.log(result.area)
  console.log(result.perimeter)
}

main()
