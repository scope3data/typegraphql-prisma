export interface MetricData {
  phase: string;
  duration?: number;
  count?: number;
  details?: Record<string, any>;
  timestamp: number;
}

export interface MetricsListener {
  emitMetric(
    phase: string,
    duration?: number,
    count?: number,
    details?: Record<string, any>,
  ): void;
  onComplete?(): void;
}

export class SimpleMetricsCollector implements MetricsListener {
  private metrics: MetricData[] = [];
  private phaseTimings: Map<string, number[]> = new Map();
  private startTime: number = Date.now();
  private verboseLogging: boolean;

  constructor(verboseLogging: boolean = false) {
    this.verboseLogging = verboseLogging;
  }

  emitMetric(
    phase: string,
    duration?: number,
    count?: number,
    details?: Record<string, any>,
  ): void {
    const metric: MetricData = {
      phase,
      duration,
      count,
      details,
      timestamp: Date.now() - this.startTime,
    };

    this.metrics.push(metric);

    // Track timing data for analysis
    if (duration !== undefined) {
      if (!this.phaseTimings.has(phase)) {
        this.phaseTimings.set(phase, []);
      }
      this.phaseTimings.get(phase)!.push(duration);
    }

    // Log the metric
    this.logMetric(metric);
  }

  private logMetric(metric: MetricData): void {
    const parts: string[] = [`[${metric.timestamp}ms] ${metric.phase}`];

    if (metric.duration !== undefined) {
      parts.push(`${metric.duration.toFixed(2)}ms`);
    }

    if (metric.count !== undefined) {
      parts.push(`(${metric.count} items)`);
    }

    if (this.verboseLogging) {
      console.log(`📊 ${parts.join(" - ")}`);
    }
  }

  onComplete(): void {
    if (!this.verboseLogging) {
      return;
    }

    console.log("\n📈 GENERATION METRICS SUMMARY");
    console.log("=".repeat(50));

    const totalTime = this.getTotalDuration();
    console.log(`🕐 Total Generation Time: ${totalTime.toFixed(2)}ms`);

    // Phase breakdown
    console.log("\n⏱️  Phase Breakdown:");
    const phaseStats = this.getPhaseStatistics();

    phaseStats
      .sort((a, b) => b.totalTime - a.totalTime)
      .forEach(stat => {
        const percentage = ((stat.totalTime / totalTime) * 100).toFixed(1);
        console.log(
          `  ${stat.phase.padEnd(25)} ${stat.totalTime.toFixed(2)}ms (${percentage}%)`,
        );

        if (stat.count > 1) {
          console.log(
            `    ${" ".repeat(25)} avg: ${stat.avgTime.toFixed(2)}ms, runs: ${stat.count}`,
          );
        }
      });

    // Performance insights
    console.log("\n💡 Performance Insights:");
    const slowPhases = phaseStats.filter(s => s.totalTime > 50);
    if (slowPhases.length > 0) {
      console.log("  🔥 Phases that took >50ms (consider optimization):");
      slowPhases.forEach(phase => {
        console.log(`    - ${phase.phase}: ${phase.totalTime.toFixed(2)}ms`);
      });
    } else {
      console.log("  ✅ All phases completed efficiently (<50ms each)");
    }

    // Count-based insights
    const countMetrics = this.metrics.filter(m => m.count !== undefined);
    if (countMetrics.length > 0) {
      console.log("\n📊 Item Processing:");
      countMetrics.forEach(metric => {
        const rate =
          metric.duration && metric.count
            ? (metric.count / metric.duration) * 1000
            : 0;
        console.log(
          `  ${metric.phase}: ${metric.count} items${rate > 0 ? ` (${rate.toFixed(0)}/sec)` : ""}`,
        );
      });
    }
  }

  private getTotalDuration(): number {
    return this.metrics
      .filter(m => m.duration !== undefined)
      .reduce((total, m) => total + m.duration!, 0);
  }

  private getPhaseStatistics() {
    return Array.from(this.phaseTimings.entries()).map(
      ([phase, durations]) => ({
        phase,
        totalTime: durations.reduce((sum, d) => sum + d, 0),
        avgTime: durations.reduce((sum, d) => sum + d, 0) / durations.length,
        count: durations.length,
        minTime: Math.min(...durations),
        maxTime: Math.max(...durations),
      }),
    );
  }

  getMetrics(): MetricData[] {
    return [...this.metrics];
  }

  reset(): void {
    this.metrics = [];
    this.phaseTimings.clear();
    this.startTime = Date.now();
  }
}
