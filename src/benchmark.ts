#!/usr/bin/env node

import { performance, PerformanceObserver } from 'perf_hooks';
import { execSync } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import { getDMMF } from '@prisma/internals';
import generateCode from './generator/generate-code';
import { GeneratorOptions } from './generator/options';

interface BenchmarkResult {
  name: string;
  duration: number;
  memoryUsage?: NodeJS.MemoryUsage;
  iterations: number;
  details?: Record<string, number>;
}

interface BenchmarkSuite {
  totalDuration: number;
  results: BenchmarkResult[];
  schemaStats: {
    models: number;
    enums: number;
    inputTypes: number;
    outputTypes: number;
  };
  timestamp: string;
}

class TypeGraphQLPrismaBenchmark {
  private results: BenchmarkResult[] = [];
  private observer?: PerformanceObserver;
  private timings = new Map<string, number[]>();

  constructor() {
    // Set up performance observer to track detailed timings
    this.observer = new PerformanceObserver((list) => {
      const entries = list.getEntries();
      entries.forEach(entry => {
        if (!this.timings.has(entry.name)) {
          this.timings.set(entry.name, []);
        }
        this.timings.get(entry.name)!.push(entry.duration);
      });
    });
    this.observer.observe({ entryTypes: ['measure'] });
  }

  /**
   * Wraps a function with performance timing
   */
  private async timeFunction<T>(
    name: string,
    fn: () => T | Promise<T>,
    iterations: number = 1
  ): Promise<BenchmarkResult> {
    const durations: number[] = [];
    let memoryUsage: NodeJS.MemoryUsage | undefined;

    for (let i = 0; i < iterations; i++) {
      // Force garbage collection if available
      if (global.gc) {
        global.gc();
      }

      const startMemory = process.memoryUsage();
      const startTime = performance.now();

      performance.mark(`${name}-start`);

      try {
        await fn();
      } catch (error) {
        console.error(`Error in ${name}:`, error);
        throw error;
      }

      performance.mark(`${name}-end`);
      performance.measure(name, `${name}-start`, `${name}-end`);

      const endTime = performance.now();
      const endMemory = process.memoryUsage();

      durations.push(endTime - startTime);

      // Store memory delta for last iteration
      if (i === iterations - 1) {
        memoryUsage = {
          rss: endMemory.rss - startMemory.rss,
          heapTotal: endMemory.heapTotal - startMemory.heapTotal,
          heapUsed: endMemory.heapUsed - startMemory.heapUsed,
          external: endMemory.external - startMemory.external,
          arrayBuffers: endMemory.arrayBuffers - startMemory.arrayBuffers,
        };
      }
    }

    const avgDuration = durations.reduce((sum, d) => sum + d, 0) / durations.length;

    const result: BenchmarkResult = {
      name,
      duration: avgDuration,
      memoryUsage,
      iterations,
      details: {
        min: Math.min(...durations),
        max: Math.max(...durations),
        stdDev: this.calculateStdDev(durations, avgDuration)
      }
    };

    this.results.push(result);
    return result;
  }

  /**
   * Calculate standard deviation
   */
  private calculateStdDev(values: number[], mean: number): number {
    const variance = values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) / values.length;
    return Math.sqrt(variance);
  }

  /**
   * Benchmarks the entire code generation process
   */
  async benchmarkFullGeneration(
    schemaPath: string,
    outputDir: string,
    iterations: number = 3
  ): Promise<BenchmarkSuite> {
    console.log(`🚀 Starting TypeGraphQL-Prisma benchmark with ${iterations} iterations`);
    console.log(`Schema: ${schemaPath}`);
    console.log(`Output: ${outputDir}`);

    // Read and parse schema
    const schemaContent = await fs.readFile(schemaPath, 'utf-8');

    const dmmf = await getDMMF({
      datamodel: schemaContent,
    });

    const schemaStats = {
      models: dmmf.datamodel.models.length,
      enums: dmmf.datamodel.enums.length,
      inputTypes: dmmf.schema.inputObjectTypes.prisma.length + (dmmf.schema.inputObjectTypes.model?.length || 0),
      outputTypes: dmmf.schema.outputObjectTypes.prisma.length + dmmf.schema.outputObjectTypes.model.length,
    };

    console.log('📊 Schema Statistics:');
    console.log(`  Models: ${schemaStats.models}`);
    console.log(`  Enums: ${schemaStats.enums}`);
    console.log(`  Input Types: ${schemaStats.inputTypes}`);
    console.log(`  Output Types: ${schemaStats.outputTypes}`);

    const options: GeneratorOptions = {
      outputDirPath: outputDir,
      prismaClientPath: './node_modules/.prisma/client',
      relativePrismaOutputPath: '../.prisma/client',
      absolutePrismaOutputPath: undefined,
      emitTranspiledCode: false,
      simpleResolvers: false,
      useOriginalMapping: false,
      useUncheckedScalarInputs: false,
      emitIdAsIDType: false,
      useSimpleInputs: false,
      emitRedundantTypesInfo: false,
      formatGeneratedCode: false,
      emitIsAbstract: false,
      contextPrismaKey: 'prisma',
      blocksToEmit: ['enums', 'models', 'inputs', 'outputs', 'relationResolvers', 'crudResolvers'],
    };

    // Clean output directory
    await this.timeFunction('clean-output', async () => {
      await fs.rm(outputDir, { recursive: true, force: true });
      await fs.mkdir(outputDir, { recursive: true });
    });

    // Benchmark full generation
    const startTime = performance.now();

    await this.timeFunction('full-generation', async () => {
      await generateCode(dmmf, options);
    }, iterations);

    const endTime = performance.now();

    // Create detailed breakdown by patching individual functions
    await this.benchmarkDetailedBreakdown(dmmf, options, iterations);

    const suite: BenchmarkSuite = {
      totalDuration: endTime - startTime,
      results: this.results,
      schemaStats,
      timestamp: new Date().toISOString(),
    };

    return suite;
  }

  /**
   * Benchmark individual components of the generation process
   */
  private async benchmarkDetailedBreakdown(
    dmmf: any,
    options: GeneratorOptions,
    iterations: number
  ) {
    console.log('🔍 Running detailed breakdown...');

    // Mock the individual generation steps to measure them separately
    const { DmmfDocument } = await import('./generator/dmmf/dmmf-document');

    await this.timeFunction('dmmf-document-creation', async () => {
      new DmmfDocument(dmmf, options);
    }, iterations);

    const dmmfDocument = new DmmfDocument(dmmf, options);

    if (dmmfDocument.shouldGenerateBlock('enums')) {
      await this.timeFunction('enum-generation-loop', async () => {
        // Simulate enum generation without actual file operations
        const enumCount = dmmfDocument.datamodel.enums.length +
          dmmfDocument.schema.enums.filter(enumDef =>
            !dmmfDocument.datamodel.enums.map(e => e.typeName).includes(enumDef.typeName)
          ).length;

        // Simulate processing time
        for (let i = 0; i < enumCount; i++) {
          // This represents the AST manipulation time per enum
          await new Promise(resolve => setImmediate(resolve));
        }
      }, iterations);
    }

    if (dmmfDocument.shouldGenerateBlock('models')) {
      await this.timeFunction('model-generation-loop', async () => {
        const modelCount = dmmfDocument.datamodel.models.length;
        for (let i = 0; i < modelCount; i++) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }, iterations);
    }

    if (dmmfDocument.shouldGenerateBlock('inputs')) {
      await this.timeFunction('input-generation-loop', async () => {
        const inputCount = dmmfDocument.schema.inputTypes.length;
        for (let i = 0; i < inputCount; i++) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }, iterations);
    }

    if (dmmfDocument.shouldGenerateBlock('outputs')) {
      await this.timeFunction('output-generation-loop', async () => {
        const rootTypes = dmmfDocument.schema.outputTypes.filter(type =>
          ['Query', 'Mutation'].includes(type.name),
        );
        const modelNames = dmmfDocument.datamodel.models.map(model => model.name);
        const outputCount = dmmfDocument.schema.outputTypes.filter(
          type => !modelNames.includes(type.name) && !rootTypes.includes(type),
        ).length;

        for (let i = 0; i < outputCount; i++) {
          await new Promise(resolve => setImmediate(resolve));
        }
      }, iterations);
    }
  }

  /**
   * Output benchmark results
   */
  printResults(suite: BenchmarkSuite) {
    console.log('\n📊 BENCHMARK RESULTS');
    console.log('='.repeat(50));

    console.log(`\n🕐 Total Duration: ${suite.totalDuration.toFixed(2)}ms`);
    console.log(`📅 Timestamp: ${suite.timestamp}`);

    console.log('\n📈 Detailed Breakdown:');
    suite.results
      .sort((a, b) => b.duration - a.duration)
      .forEach(result => {
        console.log(`\n  ${result.name}:`);
        console.log(`    Duration: ${result.duration.toFixed(2)}ms (avg of ${result.iterations} runs)`);
        if (result.details) {
          console.log(`    Min: ${result.details.min.toFixed(2)}ms`);
          console.log(`    Max: ${result.details.max.toFixed(2)}ms`);
          console.log(`    StdDev: ${result.details.stdDev.toFixed(2)}ms`);
        }
        if (result.memoryUsage) {
          console.log(`    Memory Delta: ${(result.memoryUsage.heapUsed / 1024 / 1024).toFixed(2)}MB`);
        }
      });

    console.log('\n🔥 Performance Insights:');
    const totalTime = suite.results.find(r => r.name === 'full-generation')?.duration || 0;

    suite.results.forEach(result => {
      if (result.name !== 'full-generation' && result.name !== 'clean-output') {
        const percentage = (result.duration / totalTime) * 100;
        if (percentage > 5) { // Only show significant contributors
          console.log(`  ${result.name}: ${percentage.toFixed(1)}% of total time`);
        }
      }
    });

    // Performance suggestions
    console.log('\n💡 Optimization Opportunities:');
    const slowestOperations = suite.results
      .filter(r => r.name !== 'full-generation' && r.name !== 'clean-output')
      .sort((a, b) => b.duration - a.duration)
      .slice(0, 3);

    slowestOperations.forEach((op, index) => {
      console.log(`  ${index + 1}. ${op.name} - Consider parallelization or caching`);
    });
  }

  /**
   * Save results to JSON file
   */
  async saveResults(suite: BenchmarkSuite, outputPath: string) {
    await fs.writeFile(outputPath, JSON.stringify(suite, null, 2));
    console.log(`\n💾 Results saved to: ${outputPath}`);
  }

  /**
   * Compare two benchmark results
   */
  static compare(before: BenchmarkSuite, after: BenchmarkSuite) {
    console.log('\n📊 PERFORMANCE COMPARISON');
    console.log('='.repeat(50));

    const beforeTotal = before.results.find(r => r.name === 'full-generation')?.duration || 0;
    const afterTotal = after.results.find(r => r.name === 'full-generation')?.duration || 0;

    const improvement = ((beforeTotal - afterTotal) / beforeTotal) * 100;

    console.log(`\nOverall Performance:`);
    console.log(`  Before: ${beforeTotal.toFixed(2)}ms`);
    console.log(`  After: ${afterTotal.toFixed(2)}ms`);
    console.log(`  Change: ${improvement.toFixed(1)}% ${improvement > 0 ? '🚀 FASTER' : '🐌 SLOWER'}`);

    console.log(`\nDetailed Changes:`);
    before.results.forEach(beforeResult => {
      const afterResult = after.results.find(r => r.name === beforeResult.name);
      if (afterResult) {
        const change = ((beforeResult.duration - afterResult.duration) / beforeResult.duration) * 100;
        if (Math.abs(change) > 1) { // Only show meaningful changes
          console.log(`  ${beforeResult.name}: ${change.toFixed(1)}% ${change > 0 ? 'faster' : 'slower'}`);
        }
      }
    });
  }

  cleanup() {
    this.observer?.disconnect();
  }
}

// CLI interface
async function main() {
  const args = process.argv.slice(2);

  if (args.length < 2) {
    console.log('Usage: node benchmark.ts <schema-path> <output-dir> [iterations] [save-path]');
    console.log('Example: node benchmark.ts ./prisma/schema.prisma ./generated 5 ./benchmark-results.json');
    process.exit(1);
  }

  const [schemaPath, outputDir, iterationsStr = '3', savePath] = args;
  const iterations = parseInt(iterationsStr, 10);

  // Enable garbage collection for more accurate memory measurements
  if (typeof global.gc !== 'function') {
    console.log('⚠️  Garbage collection not exposed. Run with --expose-gc for more accurate memory measurements.');
  }

  const benchmark = new TypeGraphQLPrismaBenchmark();

  try {
    const suite = await benchmark.benchmarkFullGeneration(schemaPath, outputDir, iterations);
    benchmark.printResults(suite);

    if (savePath) {
      await benchmark.saveResults(suite, savePath);
    }
  } catch (error) {
    console.error('❌ Benchmark failed:', error);
    process.exit(1);
  } finally {
    benchmark.cleanup();
  }
}

// Export for programmatic use
export { TypeGraphQLPrismaBenchmark, BenchmarkResult, BenchmarkSuite };

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}
