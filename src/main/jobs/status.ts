/** Rolling average of the last 10 item durations → approximate time left. */
export class EtaTracker {
  private samples: number[] = []
  constructor(private window = 10) {}

  record(ms: number): void {
    this.samples.push(ms)
    if (this.samples.length > this.window) this.samples.shift()
  }

  etaSec(remaining: number): number | undefined {
    if (this.samples.length === 0) return undefined
    const mean = this.samples.reduce((a, b) => a + b, 0) / this.samples.length
    return Math.round((mean * remaining) / 1000)
  }
}
