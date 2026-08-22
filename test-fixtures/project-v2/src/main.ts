import { add } from './arithmetic.js'
import { minus, multiply } from './math.js'

export function run(): number {
  return multiply(add(1, 2), minus(5, 3))
}
