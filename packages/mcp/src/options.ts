/** A server setting: `--<name> <value>` on the command line, else GRAPHCODER_<NAME> in the environment. */
export function option(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  if (i !== -1) return process.argv[i + 1]
  return process.env[`GRAPHCODER_${name.toUpperCase().replace(/-/g, '_')}`]
}
