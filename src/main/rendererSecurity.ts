// Compare complete document URLs after browser normalization; hash routing is allowed.
export function isTrustedRendererUrl(actual: string, expected: string): boolean {
  try {
    const actualUrl = new URL(actual)
    const expectedUrl = new URL(expected)
    if (!['http:', 'https:', 'file:'].includes(expectedUrl.protocol)) return false
    actualUrl.hash = ''
    expectedUrl.hash = ''
    return actualUrl.href === expectedUrl.href
  } catch {
    return false
  }
}
