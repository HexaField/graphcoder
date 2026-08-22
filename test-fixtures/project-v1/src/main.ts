import { add, subtract, multiply } from './math.js'

export function run(): number {
  return multiply(add(1, 2), subtract(5, 3))
}
